/**
 * Async sub-agent jobs — a background job lifecycle on top of the child-agent
 * machinery `subagents.ts` already provides.
 *
 * `spawn_agent` (subagents.ts) and `run_team` (teams.ts) are strictly
 * synchronous: they `await child.run(...)` and only return when the child(ren)
 * finish. There is no way to fire a child off, keep working, and collect it
 * later. This extension adds exactly that missing half of the pattern — launch /
 * inspect / cancel / collect — as tools over an in-process job registry.
 *
 * A job owns a live Promise and a live child `Agent`; neither is serializable and
 * a "running job" has no meaning across a restart, so the registry is an
 * in-memory `Map` in the `activate` closure, never `e.store`. Jobs are
 * process-lifetime by design (§3 of the design doc).
 *
 * Two guards keep the lifecycle from growing deep agent trees: a runtime
 * root-only check (a job tool refuses when the acting agent is not the root) and
 * a capability-stripped child registry (`jobChildRegistry`) so a job-child can
 * reach no agent-spawning or workflow-running tool. Concurrency and retention are
 * capped; dispose cancels every still-running job so no child is orphaned.
 */

import { Agent, currentActingAgent, currentRootAgent } from "../kernel/agent.js";
import type { RunResult } from "../kernel/agent.js";
import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { ToolRegistry } from "../kernel/registry.js";
import type { Tool } from "../kernel/types.js";
import { finalText, resolveChildCapabilities, resolveChildProvider } from "./subagents.js";
import { SPAWN_CAPS } from "./teams.js";

/**
 * The store key under which this extension publishes a `hasLiveJob(agent):
 * boolean` accessor (true when the given session-root agent owns a still-running
 * job). A host front end (the HTTP server) resolves it from this extension's
 * namespaced store to decide whether a session is safe to evict — the same
 * cross-boundary read channel as `cost`'s `costOf`, so no new host/kernel API.
 */
export const JOBS_ACCESSOR_KEY = "hasLiveJob";

/** The default system prompt a background job's child runs under. */
const DEFAULT_JOB_SYSTEM =
  "You are a focused background sub-agent. You have a fresh context and a single task. " +
  "Work it to completion and report only the final answer concisely.";

/** Reused config default for a child's per-turn safety bound (shared with subagents). */
const DEFAULT_MAX_TURNS = 8;

/** A background job's lifecycle state. */
type JobStatus = "running" | "done" | "failed" | "cancelled" | "collected";

interface Job {
  id: string;
  status: JobStatus;
  prompt: string;
  startedAt: number;
  child: Agent;
  promise: Promise<unknown>;
  result?: string;
  error?: string;
}

/**
 * Build a job-child's tool registry: the parent's tools minus every tool whose
 * declared capabilities intersect `SPAWN_CAPS` (`agent:spawn`/`workflow:run`).
 * That strips `spawn_agent`, `run_team`, the workflow runner, AND the job tools
 * themselves — so a job-child can spawn or launch nothing. Mirrors
 * `teams.ts`'s `memberChildRegistry`; exported so the guard is unit-testable.
 */
export function jobChildRegistry(parentTools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  const spawnCaps = SPAWN_CAPS as readonly string[];
  for (const tool of parentTools) {
    if (tool.capabilities?.some((c) => spawnCaps.includes(c))) continue;
    registry.register(tool);
  }
  return registry;
}

export default function activate(e: ExtensionAPI): () => void {
  e.grantCapability("agent:spawn");

  // The job registry, keyed on the SESSION ROOT (`e.rootAgent`) so a session's
  // jobs are visible only within its own fork tree — session B cannot enumerate,
  // collect, or cancel session A's jobs. Process-lifetime, never persisted; the id
  // counter/base are per-root too (ids need only be unique within a registry).
  interface RootJobs {
    jobs: Map<string, Job>;
    idCounter: number;
    idBase: string;
  }
  const byRoot = new WeakMap<Agent, RootJobs>();
  const stateFor = (agent: Agent): RootJobs => {
    let s = byRoot.get(agent);
    if (!s) {
      // Per-activation monotonic id (zero-dep; no `crypto`), mirroring memory.ts.
      byRoot.set(agent, (s = { jobs: new Map(), idCounter: 0, idBase: Math.floor(Math.random() * 0xffffff).toString(36) }));
    }
    return s;
  };
  const newId = (s: RootJobs): string => `job-${s.idBase}-${(s.idCounter++).toString(36)}`;

  // A cross-session view of the currently-RUNNING jobs, held ONLY so dispose can
  // cancel every live child on unload/reload (the per-root WeakMap is not
  // enumerable). Pruned as each job settles/cancels, so it never pins a finished
  // child; never consulted by a tool, so it leaks no cross-session visibility.
  const running = new Set<Job>();

  // Publish a server-visible live-job signal keyed on the session root, so the
  // HTTP host can refuse to evict/forget a session that still owns a running
  // background job (its detached child would be stranded). A read-only channel:
  // it exposes only a boolean, never the registry, so no cross-session visibility.
  e.store.set(JOBS_ACCESSOR_KEY, (agent: Agent): boolean => {
    const s = byRoot.get(agent);
    return s !== undefined && [...s.jobs.values()].some((j) => j.status === "running");
  });

  const enabled = (): boolean => e.config.enabled("subagent-jobs", { default: true });
  const maxConcurrent = (): number => e.config.int("subagentJobs.maxConcurrent", 4);
  const retain = (): number => e.config.int("subagentJobs.retain", 32);

  const DISABLED_MSG = "subagent-jobs: disabled (EAGENT_SUBAGENT_JOBS=off).";

  /**
   * True at the run-tree root only: the acting agent IS the root (or both unset —
   * a direct call outside any run). Any sub-agent context (`spawn_agent` child,
   * team member, or job-child) has a distinct acting agent, so a job tool refuses
   * there — no nested jobs and no cross-extension inheritance path. Keyed on the
   * root (not `e.agent`) so it is correct under a per-session Agent and race-free.
   */
  const rootOnly = (): boolean => currentActingAgent() === currentRootAgent();

  /** FIFO-drop the oldest finished (non-running) records past the retention cap,
   *  within one session's registry. */
  const evictFinished = (jobs: Map<string, Job>): void => {
    const cap = retain();
    const finished = [...jobs.values()].filter((j) => j.status !== "running");
    let excess = finished.length - cap;
    if (excess <= 0) return;
    // Map iteration is insertion order; a stable sort by startedAt keeps that
    // order for ties, so the oldest launched is dropped first.
    finished.sort((a, b) => a.startedAt - b.startedAt);
    for (const j of finished) {
      if (excess <= 0) break;
      jobs.delete(j.id);
      excess--;
    }
  };

  /** Construct (but do not run) a background child for a job's args. */
  const makeJobChild = (args: Record<string, unknown>): Agent => {
    const parent = {
      capabilities: e.agent.capabilities,
      ui: e.agent.ui,
      providers: e.agent.providers,
      providerName: e.agent.providerName,
      model: e.agent.model,
      log: e.log,
    };
    const { provider, model } = resolveChildProvider(args, parent);
    const maxTurns =
      typeof args.maxTurns === "number" && args.maxTurns > 0
        ? Math.floor(args.maxTurns)
        : e.config.int("subagents.maxTurns", DEFAULT_MAX_TURNS);
    const system = typeof args.system === "string" ? args.system : undefined;
    return new Agent({
      providers: e.agent.providers,
      capabilities: resolveChildCapabilities(args, parent),
      ui: e.agent.ui,
      logger: e.agent.logger,
      model,
      provider,
      systemPrompt: system ?? DEFAULT_JOB_SYSTEM,
      maxTurns,
      tools: jobChildRegistry(e.agent.tools.list()),
      hooks: e.agent.hooks.childScope(),
    });
  };

  e.registerTool(
    defineTool({
      name: "launch_job",
      description:
        "Launch a background sub-agent job on `prompt` and return its jobId immediately, " +
        "without awaiting the child. Inspect it with job_status, retrieve its answer with " +
        "collect_job, or stop it with cancel_job. The child shares this agent's providers and " +
        "permissions but cannot itself spawn or launch. Accepts the same per-child controls as " +
        "spawn_agent (system, maxTurns, readOnly, capabilities, provider, model). Refused from a " +
        "sub-agent (no nested jobs) and while at the concurrency cap.",
      capabilities: ["agent:spawn"],
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Task for the background child." },
          system: { type: "string", description: "Optional system prompt for the child." },
          maxTurns: {
            type: "integer",
            description: "Safety bound on the child's loop iterations (default: subagents.maxTurns).",
          },
          readOnly: {
            type: "boolean",
            description: "Run the child in a strict read-only capability lane (fs:read only).",
          },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "Optional capability allowlist scoping the child.",
          },
          provider: { type: "string", description: "Optional registered provider to run the child on." },
          model: { type: "string", description: "Optional model override for the child." },
        },
        required: ["prompt"],
      },
      // Synchronous body: the running-count check, `jobs.set`, and `child.run`
      // start happen with no `await` between them, so the concurrency cap is
      // race-free on Node's single event loop.
      execute: (args) => {
        if (!enabled()) return fail(DISABLED_MSG);
        if (!rootOnly()) return fail("launch_job cannot be called from a sub-agent (no nested jobs).");
        const prompt = args.prompt;
        if (typeof prompt !== "string" || prompt.length === 0) {
          return fail("launch_job requires a non-empty string `prompt`.");
        }
        const st = stateFor(e.rootAgent);
        const runningCount = [...st.jobs.values()].filter((j) => j.status === "running").length;
        if (runningCount >= maxConcurrent()) {
          return fail(`launch_job at capacity (${runningCount} running); collect or cancel a job first.`);
        }

        const id = newId(st);
        const child = makeJobChild(args);
        const promise = child.run(prompt);
        const job: Job = { id, status: "running", prompt, startedAt: Date.now(), child, promise };
        st.jobs.set(id, job);
        running.add(job);

        // Status-aware settler, attached immediately (same tick), as a SINGLE
        // `.then(onFulfilled, onRejected)` — NOT `.then().catch()`. Both handlers
        // must react directly on `promise` so the settler (registered here, before
        // any later `collect_job` `await promise`) runs first on BOTH settle paths;
        // a chained `.catch` would run one microtask later than collect's await on
        // the reject path, so collect could read a not-yet-"failed" status.
        // The `status !== "running"` guard is load-bearing: an aborted run RESOLVES
        // (reason "stop"), so without it a cancelled/collected/disposed job would
        // be clobbered back to "done". Only running → done|failed transitions here.
        promise.then(
          (r) => {
            if (job.status !== "running") return;
            job.result = finalText((r as RunResult).messages);
            job.status = "done";
            running.delete(job);
            evictFinished(st.jobs);
          },
          (err: unknown) => {
            if (job.status !== "running") return;
            job.status = "failed";
            job.error = String(err);
            running.delete(job);
            evictFinished(st.jobs);
          },
        );

        evictFinished(st.jobs);
        return ok(`launched ${id}`, { jobId: id });
      },
    }),
  );

  e.registerTool(
    defineTool({
      name: "job_status",
      description:
        "Inspect background jobs without blocking. With a `jobId`, return that job's status, " +
        "start time, a short result preview, and any error. With no id, list every job's id and status.",
      capabilities: ["agent:spawn"],
      parameters: {
        type: "object",
        properties: { jobId: { type: "string", description: "The job to inspect; omit to list all jobs." } },
      },
      execute: (args) => {
        if (!enabled()) return fail(DISABLED_MSG);
        const jobs = stateFor(e.rootAgent).jobs;
        const id = typeof args.jobId === "string" && args.jobId.length > 0 ? args.jobId : undefined;
        if (id === undefined) {
          const list = [...jobs.values()].map((j) => ({ id: j.id, status: j.status }));
          return ok(`${list.length} job(s)`, { jobs: list });
        }
        const job = jobs.get(id);
        if (!job) return fail(`job_status: unknown job "${id}".`);
        return ok(`${id}: ${job.status}`, {
          status: job.status,
          startedAt: job.startedAt,
          resultPreview: job.result?.slice(0, 200),
          error: job.error,
        });
      },
    }),
  );

  e.registerTool(
    defineTool({
      name: "collect_job",
      description:
        "Await a background job and return its result. A completed job yields the child's final " +
        "answer (and transitions to collected); a cancelled job is reported as cancelled; a failed " +
        "job is reported as a failure. Blocks until the child settles — cancel_job unblocks a hung one.",
      capabilities: ["agent:spawn"],
      parameters: {
        type: "object",
        properties: { jobId: { type: "string", description: "The job to collect." } },
        required: ["jobId"],
      },
      execute: async (args) => {
        if (!enabled()) return fail(DISABLED_MSG);
        const id = typeof args.jobId === "string" ? args.jobId : "";
        const job = stateFor(e.rootAgent).jobs.get(id);
        if (!job) return fail(`collect_job: unknown job "${id}".`);
        // The launch-time settler runs before this continuation (promise-reaction
        // order), so `status`/`result` are already populated when we resume. A
        // genuinely-rejecting child rejects the original promise; the settler's
        // `.catch` already recorded status="failed"/error, so swallow the rejection
        // here and report via the status branch below — collect_job never throws.
        try {
          await job.promise;
        } catch {
          // handled by the settler; fall through to the status branch
        }
        if (job.status === "done") {
          job.status = "collected";
          return ok(job.result ?? "");
        }
        if (job.status === "cancelled") return ok(`job ${id} was cancelled`);
        if (job.status === "failed") return fail(`job ${id} failed: ${job.error ?? ""}`);
        // Already collected (or a defensive fallthrough): report the stored answer.
        return ok(job.result ?? "");
      },
    }),
  );

  e.registerTool(
    defineTool({
      name: "cancel_job",
      description:
        "Stop a running background job: abort its child and mark it cancelled. An unknown id errors; " +
        "an already-finished job is a no-op that reports its terminal status.",
      capabilities: ["agent:spawn"],
      parameters: {
        type: "object",
        properties: { jobId: { type: "string", description: "The job to cancel." } },
        required: ["jobId"],
      },
      execute: (args) => {
        if (!enabled()) return fail(DISABLED_MSG);
        const id = typeof args.jobId === "string" ? args.jobId : "";
        const st = stateFor(e.rootAgent);
        const job = st.jobs.get(id);
        if (!job) return fail(`cancel_job: unknown job "${id}".`);
        if (job.status === "running") {
          // Set the terminal status BEFORE stopping, so the settler (which fires
          // when the aborted run resolves) sees a non-running status and skips.
          job.status = "cancelled";
          running.delete(job);
          try {
            job.child.stop();
          } catch {
            // stop() aborts a controller and does not throw; belt-and-braces.
          }
          evictFinished(st.jobs);
          return ok(`cancelled ${id}`);
        }
        return ok(`${id} already ${job.status}`);
      },
    }),
  );

  e.registerCommand({
    name: "jobs",
    description: "List background sub-agent jobs and their status.",
    run: (ctx) => {
      if (!enabled()) {
        ctx.print("subagent-jobs: disabled (EAGENT_SUBAGENT_JOBS=off).");
        return;
      }
      const list = [...stateFor(e.rootAgent).jobs.values()];
      if (list.length === 0) {
        ctx.print("(no jobs)");
        return;
      }
      for (const j of list) ctx.print(`  ${j.id} [${j.status}] ${j.startedAt}`);
    },
  });

  // Dispose: cancel every still-running job across ALL sessions so no background
  // child is orphaned on unload/reload. The per-root registries are not enumerable,
  // so this sweeps the cross-session `running` set (which holds exactly the live
  // jobs). Sets each terminal synchronously then aborts its child; never throws.
  // The host tears down the tool/command registrations itself, so this does ONLY
  // the job cancellation.
  return () => {
    for (const job of running) {
      if (job.status === "running") {
        job.status = "cancelled";
        try {
          job.child.stop();
        } catch {
          // never throw on teardown
        }
      }
    }
  };
}
