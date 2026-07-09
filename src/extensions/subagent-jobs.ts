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

import { Agent, currentActingAgent } from "../kernel/agent.js";
import type { RunResult } from "../kernel/agent.js";
import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { ToolRegistry } from "../kernel/registry.js";
import type { Tool } from "../kernel/types.js";
import { finalText, resolveChildCapabilities, resolveChildProvider } from "./subagents.js";
import { SPAWN_CAPS } from "./teams.js";

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

  /** The in-process job registry — process-lifetime, never persisted. */
  const jobs = new Map<string, Job>();

  // Per-activation monotonic id (zero-dep; no `crypto`), mirroring memory.ts.
  let idCounter = 0;
  const idBase = Math.floor(Math.random() * 0xffffff).toString(36);
  const newId = (): string => `job-${idBase}-${(idCounter++).toString(36)}`;

  const enabled = (): boolean => e.config.enabled("subagent-jobs", { default: true });
  const maxConcurrent = (): number => e.config.int("subagentJobs.maxConcurrent", 4);
  const retain = (): number => e.config.int("subagentJobs.retain", 32);

  const DISABLED_MSG = "subagent-jobs: disabled (EAGENT_SUBAGENT_JOBS=off).";

  /**
   * True at the root only: the acting agent is `e.agent` (or unset — a direct
   * call outside any run). Any sub-agent context (`spawn_agent` child, team
   * member, or job-child) makes this false, so a job tool refuses there — no
   * nested jobs and no cross-extension inheritance path.
   */
  const rootOnly = (): boolean => {
    const acting = currentActingAgent();
    return acting === undefined || acting === e.agent;
  };

  /** FIFO-drop the oldest finished (non-running) records past the retention cap. */
  const evictFinished = (): void => {
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
        const running = [...jobs.values()].filter((j) => j.status === "running").length;
        if (running >= maxConcurrent()) {
          return fail(`launch_job at capacity (${running} running); collect or cancel a job first.`);
        }

        const id = newId();
        const child = makeJobChild(args);
        const promise = child.run(prompt);
        const job: Job = { id, status: "running", prompt, startedAt: Date.now(), child, promise };
        jobs.set(id, job);

        // Status-aware settler, attached immediately (same tick). The
        // `status !== "running"` guard is load-bearing: an aborted run RESOLVES
        // (reason "stop"), so without it a cancelled/collected/disposed job would
        // be clobbered back to "done". Only running → done|failed transitions here.
        promise
          .then((r) => {
            if (job.status !== "running") return;
            job.result = finalText((r as RunResult).messages);
            job.status = "done";
            evictFinished();
          })
          .catch((err: unknown) => {
            if (job.status !== "running") return;
            job.status = "failed";
            job.error = String(err);
            evictFinished();
          });

        evictFinished();
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
        const job = jobs.get(id);
        if (!job) return fail(`collect_job: unknown job "${id}".`);
        // The launch-time settler runs before this continuation (promise-reaction
        // order), so `status`/`result` are already populated when we resume.
        await job.promise;
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
        const job = jobs.get(id);
        if (!job) return fail(`cancel_job: unknown job "${id}".`);
        if (job.status === "running") {
          // Set the terminal status BEFORE stopping, so the settler (which fires
          // when the aborted run resolves) sees a non-running status and skips.
          job.status = "cancelled";
          try {
            job.child.stop();
          } catch {
            // stop() aborts a controller and does not throw; belt-and-braces.
          }
          evictFinished();
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
      const list = [...jobs.values()];
      if (list.length === 0) {
        ctx.print("(no jobs)");
        return;
      }
      for (const j of list) ctx.print(`  ${j.id} [${j.status}] ${j.startedAt}`);
    },
  });

  // Dispose: cancel every still-running job so no background child is orphaned on
  // unload/reload. Sets each terminal synchronously (so none stays "running")
  // then aborts its child; never throws. The host tears down the tool/command
  // registrations itself, so this does ONLY the job cancellation.
  return () => {
    for (const job of jobs.values()) {
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
