/**
 * reasoning-search — best-of-N, tree, and graph search over forked, governed
 * child agents.
 *
 * A single off-by-default extension that composes existing public primitives
 * with NO kernel change. `best_of_n` forks N child agents from a `snapshot()` of
 * the current state, runs each on the same sub-task, scores their final answers
 * to a number, and returns the argmax candidate — the minimal slice of "search
 * over reasoning". It also provides `tree_search` (multi-step beam search over the
 * fork spine — Tree-of-Thought) and `graph_search` (generate → aggregate → refine,
 * refine-to-convergence — Graph-of-Thought), all on the same governed fork spine.
 *
 * The fork machinery mirrors `subagents.ts`: a child is `new Agent({ providers,
 * capabilities, tools: childRegistry(), hooks: childScope() })`. Two divergences
 * from subagents are deliberate:
 *
 *   - Each child `restore()`s the parent snapshot, so every branch inherits the
 *     conversation (subagents start children fresh). Best-of-N means "N ways
 *     forward from here," which needs the shared prior context.
 *   - The recursion guard removes every spawn-class tool (any declaring
 *     `agent:spawn`/`workflow:run`, which covers `best_of_n`, the search tools,
 *     and `spawn_agent`) from each child's registry, so a child cannot re-fork or
 *     otherwise spawn. The N cap only bounds one level; this guard is what
 *     prevents depth blow-up.
 *
 * Governance rides `childScope()`: the parent's `beforeToolCall`/`afterToolCall`
 * gate filters govern every fork, and a child's `usage` events reach the parent
 * bus (so a cost/budget guard still sees them). The parent transcript is never
 * mutated by losing branches — only the winning text re-enters via the tool
 * result. Off by default: `EAGENT_REASONING_SEARCH=off` is a hard kill switch,
 * and a store `enabled` flag (default false) gates the tool until toggled on.
 */

import { Agent, type RunResult } from "../kernel/agent.js";
import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { ToolRegistry } from "../kernel/registry.js";
import type { AgentState, Message, ToolContext } from "../kernel/types.js";
import { childRegistryFrom } from "./lib/child-registry.js";
import { parseJudgeReply } from "./evals.js";

// Re-exported as a local delegator (not a bare `export … from`) because this
// module also calls `childRegistryFrom` internally, which needs a local binding;
// the search tests import the recursion guard from here.
export { childRegistryFrom };

/** The tool name — also the registration a child must never inherit (recursion guard). */
const BEST_OF_N = "best_of_n";
/** The tree-search tool name — also pruned from every child registry (recursion guard). */
const TREE_SEARCH = "tree_search";
/** The graph-search tool name — also pruned from every child registry (recursion guard). */
const GRAPH_SEARCH = "graph_search";

/** Default number of forks when `n` is omitted. */
const DEFAULT_N = 3;
/** Default upper bound on forks — the only fan-out bound. */
const DEFAULT_MAX_N = 5;

/** tree_search bounding: default + clamped cap for each search dimension, plus the
 *  hard ceiling on total child runs (the analog of best_of_n's N cap). */
const DEFAULT_BRANCH = 3;
const DEFAULT_MAX_BRANCH = 4;
const DEFAULT_BEAM = 2;
const DEFAULT_MAX_BEAM = 3;
const DEFAULT_DEPTH = 2;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_NODES = 16;
const HARD_MAX_NODES = 32;

/**
 * The grader's instruction for the `judge` scorer's tool-less sub-call. It pins
 * the one-line `SCORE <n>/10 <PASS|FAIL> <reason>` grammar that `parseJudgeReply`
 * reads. evals' equivalent prompt is module-private, so this keeps its own.
 */
const JUDGE_SYSTEM_PROMPT =
  "You are an impartial grader for an autonomous agent. You are given a task and " +
  "a candidate answer. Grade how well the candidate solves the task. Reply on ONE " +
  "line in exactly this form: `SCORE <n>/10 <PASS|FAIL> <reason>`, where <n> is an " +
  "integer 0-10, the verdict is the literal token PASS or FAIL, and the reason is " +
  "one short phrase. Example: `SCORE 8/10 PASS clear and correct`. Output nothing else.";

/** A candidate scorer: higher is better; the tool takes the argmax. */
type Scorer = (candidate: string) => number | Promise<number>;

/** The last assistant message's text, concatenating its text blocks (subagents' finalText). */
function finalText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    let text = "";
    for (const b of m.content) if (b.type === "text") text += b.text;
    if (text.length > 0) return text;
  }
  return "";
}

/** Concatenate a message's text blocks. */
function textOf(message: Message): string {
  let text = "";
  for (const b of message.content) if (b.type === "text") text += b.text;
  return text;
}

/** Index of the maximum score; 0 on an all-tie (strict `>`). */
function argmax(scores: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[best]!) best = i;
  return best;
}

/** Clamp `v` into the inclusive range [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

/** Read an integer argument, falling back to `dflt` when absent or non-finite. */
function intArg(value: unknown, dflt: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : dflt;
}

/**
 * Drop a trailing assistant message that carries a `tool_call` block. `best_of_n`
 * snapshots mid-dispatch: the kernel has already appended the parent assistant
 * message holding the in-flight `best_of_n` tool_use (agent.ts pushes it before
 * this execute runs) but appends its matching `tool_result` only after dispatch
 * returns — so the snapshot ends with that tool_use dangling. A fork that
 * `restore()`s it and then `run(task)`s would send `[…, assistant(tool_use), user(task)]`,
 * which a live Anthropic/OpenAI provider 400s on (an assistant tool_use must be
 * resolved by a following tool_result). Pruning it lets each fork continue from a
 * clean prior context. The check is on the last message only: the loop keeps every
 * earlier turn's tool_use/tool_result pairing intact, so this in-flight call is the
 * only one that can dangle.
 */
function withoutDanglingToolUse(messages: readonly Message[]): Message[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.content.some((b) => b.type === "tool_call")) {
    return messages.slice(0, -1);
  }
  return [...messages];
}

/** The synthesis prompt for an aggregate node: embeds the task + every candidate. */
function aggregatePrompt(task: string, thoughts: string[]): string {
  return (
    "Combine these candidate answers into one best answer.\n" +
    `Task: ${task}\n\n` +
    thoughts.map((t, i) => `Candidate ${i + 1}:\n${t}`).join("\n\n") +
    "\n\nReturn a single improved answer that combines their strengths."
  );
}

/** The improve prompt for a refine node: embeds the task + the answer to better. */
function refinePrompt(task: string, answer: string): string {
  return `Improve this answer.\nTask: ${task}\n\nCurrent answer:\n${answer}\n\nReturn a better version.`;
}

export default function activate(e: ExtensionAPI): () => void {
  // Hard kill switch: register nothing so the extension is wholly absent.
  if (!e.config.enabled("reasoning-search", { default: true })) return () => {};

  e.grantCapability("agent:spawn");

  /** Read per-call so `/reasoning-search on|off` toggles it mid-session. */
  const isEnabled = (): boolean => e.store.get<boolean>("enabled", false) ?? false;

  /** A fresh per-fork registry: every parent tool minus every spawn-class tool (capability strip). */
  const childRegistry = (): ToolRegistry => childRegistryFrom(e.agent.tools.list());

  /** Construct a fork: shares providers/capabilities, governed by childScope,
   *  restored from the parent snapshot so it continues from the current state. */
  const forkChild = (snapshot: AgentState): Agent => {
    const child = new Agent({
      providers: e.agent.providers,
      capabilities: e.agent.capabilities,
      tools: childRegistry(),
      hooks: e.agent.hooks.childScope(),
    });
    child.restore(snapshot);
    return child;
  };

  /** Fork from any node state (root or intermediate), pruning the in-flight
   *  tool_use the snapshot ends on so every fork starts from a provider-valid
   *  transcript. best_of_n keeps its own external prune; tree_search forks here. */
  const forkFrom = (state: AgentState): Agent =>
    forkChild({ ...state, messages: withoutDanglingToolUse(state.messages) });

  /** Grade one candidate via a recursion-safe, tool-less provider sub-call.
   *  Fail-soft: an absent provider, a stream throw, or an unparseable reply → 0. */
  const judgeScore = async (task: string, candidate: string, signal: AbortSignal): Promise<number> => {
    const provider = e.agent.providers.get();
    if (!provider) return 0;
    try {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: `Task:\n${task}\n\nCandidate:\n${candidate}` }] },
      ];
      let reply = "";
      for await (const ev of provider.stream({
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        messages,
        tools: [],
        model: e.agent.model,
        signal,
      })) {
        if (ev.type === "done") reply = textOf(ev.message);
      }
      return parseJudgeReply(reply)?.score ?? 0;
    } catch {
      return 0;
    }
  };

  /** Resolve a scorer by name; `judge` (the default) closes over the task + signal. */
  const pickScorer = (name: unknown, task: string, ctx: ToolContext): Scorer => {
    if (name === "longest") return (c) => c.length;
    if (name === "shortest") return (c) => -c.length;
    return (c) => judgeScore(task, c, ctx.signal);
  };

  const offTool = e.registerTool(
    defineTool<{ task?: string; n?: number; scorer?: string }>({
      name: BEST_OF_N,
      description:
        "Best-of-N: fork N child agents from the current state, run each on `task`, " +
        "score their answers, and return the best. scorer=judge (default) grades each " +
        "with an LLM sub-call; shortest/longest are deterministic heuristics. Forks " +
        "share this agent's providers and permissions but cannot themselves re-fork.",
      capabilities: ["agent:spawn"],
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "The sub-task each fork attempts." },
          n: { type: "integer", description: `Number of forks (default ${DEFAULT_N}; capped at ${DEFAULT_MAX_N}).` },
          scorer: {
            type: "string",
            enum: ["judge", "shortest", "longest"],
            description: "How to rank candidates; default judge.",
          },
        },
        required: ["task"],
      },
      execute: async (args, ctx) => {
        if (!isEnabled()) {
          return fail("reasoning-search: disabled — enable with `/reasoning-search on`.");
        }
        const task = typeof args.task === "string" ? args.task : "";
        if (task.length === 0) return fail(`${BEST_OF_N} requires a non-empty string \`task\`.`);

        const requested = typeof args.n === "number" && Number.isFinite(args.n) ? Math.floor(args.n) : DEFAULT_N;
        const k = Math.max(1, Math.min(requested, DEFAULT_MAX_N));

        // Snapshot once; every fork restores the same state. Prune the in-flight
        // best_of_n tool_use the snapshot ends on (its tool_result is not appended
        // until this dispatch returns) so each fork starts from a provider-valid
        // transcript rather than a dangling assistant tool_use.
        const snap = e.agent.snapshot();
        const forkState: AgentState = { ...snap, messages: withoutDanglingToolUse(snap.messages) };
        const children = Array.from({ length: k }, () => forkChild(forkState));

        // A parent abort (ctx.signal) must tear every in-flight fork down: Agent.run
        // takes no signal, so each child owns its own #abort — stop() them all on
        // abort and unhook in the finally. `c.run` sets up the child's #abort
        // synchronously, so an already-aborted signal is honored too.
        const stopAll = (): void => {
          for (const c of children) c.stop();
        };
        ctx.signal.addEventListener("abort", stopAll);
        let settled: PromiseSettledResult<RunResult>[];
        try {
          const runs = children.map((c) => c.run(task));
          if (ctx.signal.aborted) stopAll();
          settled = await Promise.allSettled(runs);
        } finally {
          ctx.signal.removeEventListener("abort", stopAll);
        }

        // A rejected fork is scored -Infinity DIRECTLY — never through the scorer,
        // since e.g. shortest("") is -0 and could win — so a failed fork can never
        // be the argmax. A fulfilled fork's final text is scored normally.
        const scorer = pickScorer(args.scorer, task, ctx);
        const candidates = await Promise.all(
          settled.map(async (r) => {
            if (r.status === "rejected") return { text: "", score: -Infinity };
            const text = finalText(r.value.messages);
            return { text, score: await scorer(text) };
          }),
        );

        // Every fork failed: there is no survivor to select — return a clean fail
        // (with the per-fork detail) rather than letting a reject escape.
        if (settled.every((r) => r.status === "rejected")) {
          return fail(`${BEST_OF_N}: all ${k} fork${k === 1 ? "" : "s"} failed.`, candidates);
        }

        const best = argmax(candidates.map((c) => c.score));
        return ok(candidates[best]?.text ?? "", candidates);
      },
    }),
  );

  const offTree = e.registerTool(
    defineTool<{ task?: string; branch?: number; beam?: number; depth?: number; scorer?: string; maxNodes?: number; goalScore?: number }>({
      name: TREE_SEARCH,
      description:
        "Tree-of-Thought beam search: fork child agents from the current state, run " +
        "each on `task` as a 'thought', score them, keep the top `beam`, then expand " +
        "those to `depth`, returning the best-scoring thought found. Bounded by " +
        "`maxNodes` total child runs; forks share this agent's providers and " +
        "permissions but cannot themselves re-search or re-fork.",
      capabilities: ["agent:spawn"],
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "The sub-task each thought node attempts." },
          branch: { type: "integer", description: `Children per node (default ${DEFAULT_BRANCH}; capped at ${DEFAULT_MAX_BRANCH}).` },
          beam: { type: "integer", description: `Nodes kept per depth (default ${DEFAULT_BEAM}; capped at ${DEFAULT_MAX_BEAM}).` },
          depth: { type: "integer", description: `Search depth (default ${DEFAULT_DEPTH}; capped at ${DEFAULT_MAX_DEPTH}).` },
          scorer: {
            type: "string",
            enum: ["judge", "shortest", "longest"],
            description: "How to rank thoughts; default judge.",
          },
          maxNodes: { type: "integer", description: `Hard cap on total child runs (default ${DEFAULT_MAX_NODES}; capped at ${HARD_MAX_NODES}).` },
          goalScore: { type: "number", description: "Stop early once a thought scores at or above this; default off (run to depth)." },
        },
        required: ["task"],
      },
      execute: async (args, ctx) => {
        if (!isEnabled()) {
          return fail("tree_search: disabled — enable with `/reasoning-search on`.");
        }
        const task = typeof args.task === "string" ? args.task : "";
        if (task.length === 0) return fail(`${TREE_SEARCH} requires a non-empty string \`task\`.`);

        const branch = clamp(intArg(args.branch, DEFAULT_BRANCH), 1, DEFAULT_MAX_BRANCH);
        const beam = clamp(intArg(args.beam, DEFAULT_BEAM), 1, DEFAULT_MAX_BEAM);
        const depth = clamp(intArg(args.depth, DEFAULT_DEPTH), 1, DEFAULT_MAX_DEPTH);
        // Lower-bound maxNodes by `branch` so the first depth always runs the root expansion.
        const maxNodes = clamp(intArg(args.maxNodes, DEFAULT_MAX_NODES), branch, HARD_MAX_NODES);
        const scorer = pickScorer(args.scorer, task, ctx);
        // Optional early-termination bar: when a thought scores at/above it, stop
        // before expanding the next depth. Off by default (run to `depth`).
        const goalScore = typeof args.goalScore === "number" ? args.goalScore : undefined;

        interface Node {
          state: AgentState;
          text: string;
          score: number;
        }
        const root: AgentState = e.agent.snapshot();
        let frontier: Node[] = [{ state: root, text: "", score: -Infinity }];
        let best: { text: string; score: number } | null = null;
        let used = 0;
        const details: { score: number; text: string }[][] = [];

        // The abort handler stops the CURRENT live wave: `live` is reassigned each
        // depth, so a parent abort at depth d tears down depth-d's children, not the
        // already-settled depth-(d-1) set.
        let live: Agent[] = [];
        const stopLive = (): void => {
          for (const c of live) c.stop();
        };
        ctx.signal.addEventListener("abort", stopLive);
        try {
          for (let d = 0; d < depth; d++) {
            if (ctx.signal.aborted) break;

            // Expand the frontier into children, clipped to the remaining node budget.
            const children: Agent[] = [];
            for (const node of frontier) {
              if (used >= maxNodes) break;
              for (let b = 0; b < branch; b++) {
                if (used >= maxNodes) break;
                children.push(forkFrom(node.state));
                used++;
              }
            }
            if (children.length === 0) break;
            live = children;

            const settled = await Promise.allSettled(
              children.map(async (c) => {
                await c.run(task);
                return { text: finalText(c.messages), state: c.snapshot() };
              }),
            );

            // A rejected child is dropped (never scored, never selected); a fulfilled
            // child's final text is scored to a number.
            const scored: Node[] = [];
            for (const r of settled) {
              if (r.status !== "fulfilled") continue;
              const score = await scorer(r.value.text);
              scored.push({ state: r.value.state, text: r.value.text, score });
            }

            // Track the global best leaf across ALL depths, so an early high-scoring
            // thought is never lost to a weaker-but-deeper one.
            for (const c of scored) if (!best || c.score > best.score) best = { text: c.text, score: c.score };
            details.push(scored.map((c) => ({ score: c.score, text: c.text.slice(0, 120) })));

            // Early goal-termination: a thought already meets the bar, so stop
            // before paying for another depth of forks.
            if (goalScore !== undefined && best && best.score >= goalScore) break;

            scored.sort((a, b) => b.score - a.score);
            frontier = scored.slice(0, beam);
            if (frontier.length === 0) break;
          }
        } finally {
          ctx.signal.removeEventListener("abort", stopLive);
        }

        if (!best) return fail("tree_search: every branch failed.");
        return ok(best.text, details);
      },
    }),
  );

  const offGraph = e.registerTool(
    defineTool<{ task?: string; branch?: number; scorer?: string; refine?: boolean; refineRounds?: number }>({
      name: GRAPH_SEARCH,
      description:
        "Graph-of-Thought: generate `branch` thoughts from the current state, " +
        "aggregate them into one combined answer, then (optionally) refine the best, " +
        "returning the global best across generate/aggregate/refine. scorer=judge " +
        "(default) grades each with an LLM sub-call; shortest/longest are deterministic. " +
        "Forks share this agent's providers and permissions but cannot themselves re-search or re-fork.",
      capabilities: ["agent:spawn"],
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "The sub-task each generated thought attempts." },
          branch: { type: "integer", description: `Thoughts to generate (default ${DEFAULT_BRANCH}; capped at ${DEFAULT_MAX_BRANCH}).` },
          scorer: {
            type: "string",
            enum: ["judge", "shortest", "longest"],
            description: "How to rank nodes; default judge.",
          },
          refine: { type: "boolean", description: "Run a refine pass on the best node (default true)." },
          refineRounds: { type: "integer", description: `Max refine rounds; stops early once a round doesn't improve the best (default 1; capped at ${DEFAULT_MAX_BRANCH}).` },
        },
        required: ["task"],
      },
      execute: async (args, ctx) => {
        if (!isEnabled()) {
          return fail("graph_search: disabled — enable with `/reasoning-search on`.");
        }
        const task = typeof args.task === "string" ? args.task : "";
        if (task.length === 0) return fail(`${GRAPH_SEARCH} requires a non-empty string \`task\`.`);

        const branch = clamp(intArg(args.branch, DEFAULT_BRANCH), 1, DEFAULT_MAX_BRANCH);
        const refine = args.refine !== false;
        const refineRounds = clamp(intArg(args.refineRounds, 1), 1, DEFAULT_MAX_BRANCH);
        const scorer = pickScorer(args.scorer, task, ctx);

        const root: AgentState = e.agent.snapshot();
        let best: { text: string; score: number } | null = null;
        const details: { op: string; score: number; text: string }[] = [];

        // Score a node's text and record it; the `best` update stays in the outer
        // flow so strict control-flow narrowing of `best` holds (mirrors tree_search).
        const record = async (op: string, text: string): Promise<{ text: string; score: number }> => {
          const score = await scorer(text);
          details.push({ op, score, text: text.slice(0, 120) });
          return { text, score };
        };

        // The abort handler stops the CURRENT live phase: `live` is reassigned across
        // the generate array → the aggregate fork → the refine fork.
        let live: Agent[] = [];
        const stopLive = (): void => {
          for (const c of live) c.stop();
        };
        ctx.signal.addEventListener("abort", stopLive);
        try {
          const gen = Array.from({ length: branch }, () => forkFrom(root));
          live = gen;
          const settled = await Promise.allSettled(
            gen.map(async (c) => {
              await c.run(task);
              return finalText(c.messages);
            }),
          );
          const thoughts: string[] = [];
          for (const r of settled) {
            if (r.status !== "fulfilled") continue;
            thoughts.push(r.value);
            const node = await record("generate", r.value);
            if (!best || node.score > best.score) best = node;
          }

          if (!ctx.signal.aborted) {
            try {
              const agg = forkFrom(root);
              live = [agg];
              await agg.run(aggregatePrompt(task, thoughts));
              const node = await record("aggregate", finalText(agg.messages));
              if (!best || node.score > best.score) best = node;
            } catch {
              // dropped — a failed op never fails the search
            }
          }

          // Refine to convergence: up to `refineRounds` passes, stopping early the
          // first round that doesn't improve the best (or on abort / a failed op).
          if (refine) {
            for (let r = 0; r < refineRounds; r++) {
              if (!best || ctx.signal.aborted) break;
              const before = best.score;
              const seed = best.text;
              try {
                const ref = forkFrom(root);
                live = [ref];
                await ref.run(refinePrompt(task, seed));
                const node = await record("refine", finalText(ref.messages));
                if (!best || node.score > best.score) best = node;
              } catch {
                break; // a failed refine ends the loop
              }
              if (!best || best.score <= before) break; // no improvement ⇒ converged
            }
          }
        } finally {
          ctx.signal.removeEventListener("abort", stopLive);
        }

        if (!best) return fail("graph_search: every operation failed.");
        return ok(best.text, details);
      },
    }),
  );

  const offCmd = e.registerCommand({
    name: "reasoning-search",
    description: "Toggle best-of-N reasoning search. Usage: /reasoning-search [on|off|status]",
    run: (cmdCtx) => {
      const arg = cmdCtx.args.trim().toLowerCase();
      if (arg === "on") {
        e.store.set("enabled", true);
        cmdCtx.print("reasoning-search: on");
      } else if (arg === "off") {
        e.store.set("enabled", false);
        cmdCtx.print("reasoning-search: off");
      } else {
        cmdCtx.print(
          `reasoning-search: ${isEnabled() ? "on" : "off"} (best_of_n + tree_search + graph_search; cap ${DEFAULT_MAX_N} forks / ${HARD_MAX_NODES} nodes)`,
        );
      }
    },
  });

  return () => {
    for (const d of [offTool, offTree, offGraph, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
