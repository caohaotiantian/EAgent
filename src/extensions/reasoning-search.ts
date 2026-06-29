/**
 * reasoning-search — best-of-N over forked, governed child agents.
 *
 * A single off-by-default extension that composes existing public primitives
 * with NO kernel change. `best_of_n` forks N child agents from a `snapshot()` of
 * the current state, runs each on the same sub-task, scores their final answers
 * to a number, and returns the argmax candidate. It is the minimal slice of
 * "search over reasoning": N continuations of the same conversation, scored and
 * selected; tree/graph search (expand → evaluate → backtrack) is deferred.
 *
 * The fork machinery mirrors `subagents.ts`: a child is `new Agent({ providers,
 * capabilities, tools: childRegistry(), hooks: childScope() })`. Two divergences
 * from subagents are deliberate:
 *
 *   - Each child `restore()`s the parent snapshot, so every branch inherits the
 *     conversation (subagents start children fresh). Best-of-N means "N ways
 *     forward from here," which needs the shared prior context.
 *   - The recursion guard removes `best_of_n` (and `spawn_agent`) from each
 *     child's registry, so a child cannot re-fork. The N cap only bounds one
 *     level; this guard is what prevents depth blow-up.
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
import type { AgentState, Message, Tool, ToolContext } from "../kernel/types.js";
import { parseJudgeReply } from "./evals.js";

/** The tool name — also the registration a child must never inherit (recursion guard). */
const BEST_OF_N = "best_of_n";
/** subagents' spawn tool, likewise pruned so a fork cannot spawn either. */
const SPAWN_TOOL = "spawn_agent";

/** Default number of forks when `n` is omitted. */
const DEFAULT_N = 3;
/** Default upper bound on forks — the only fan-out bound. */
const DEFAULT_MAX_N = 5;

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

/**
 * Copy a parent's active tools into a fresh registry, omitting `best_of_n` and
 * `spawn_agent`. This is the recursion guard (a fork cannot re-fork), factored
 * out so tests can assert it directly — exactly `subagents`' `childRegistryFrom`,
 * extended to drop `best_of_n`. A fresh per-child registry also keeps a fork's
 * own registrations from leaking to the parent or its siblings.
 */
export function childRegistryFrom(parentTools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of parentTools) {
    if (tool.spec.name === BEST_OF_N || tool.spec.name === SPAWN_TOOL) continue;
    registry.register(tool);
  }
  return registry;
}

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

export default function activate(e: ExtensionAPI): () => void {
  // Hard kill switch: register nothing so the extension is wholly absent.
  if (process.env.EAGENT_REASONING_SEARCH === "off") return () => {};

  e.grantCapability("agent:spawn");

  /** Read per-call so `/reasoning-search on|off` toggles it mid-session. */
  const isEnabled = (): boolean => e.store.get<boolean>("enabled", false) ?? false;

  /** A fresh per-fork registry: every parent tool minus best_of_n/spawn_agent. */
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
        cmdCtx.print(`reasoning-search: ${isEnabled() ? "on" : "off"} (cap ${DEFAULT_MAX_N} forks)`);
      }
    },
  });

  return () => {
    for (const d of [offTool, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
