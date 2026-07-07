/**
 * routing — difficulty-aware per-turn model tiering.
 *
 * EAgent runs one configured model per provider per run, but `Agent.model` is a
 * public, mutable field the loop re-reads on EVERY turn — once for the
 * `transformContext` payload and again when building the provider request. So a
 * turn's model is whatever `this.model` holds at the top of that turn; nothing
 * pins it for the lifetime of a run. This extension rides that existing seam
 * (zero kernel change): on `turn_start` it classifies the next turn's difficulty
 * and assigns `e.agent.model` to the matching tier from a store-configurable tier
 * map, so a trivial turn ("rename this var", "what's 2+2") burns the cheap tier
 * while a hard turn ("design the migration", "debug this race") keeps the
 * flagship. The configured model is captured on `agent_start` and RESTORED on
 * `agent_end` and on disable, so the override is strictly per-turn — never a
 * permanent session downgrade.
 *
 * The default classifier is a free, deterministic heuristic over signals already
 * in hand (latest user-text length, difficulty keyword cues, recent tool-result
 * byte size); an opt-in `mode: "llm"` instead consults a recursion-safe tool-less
 * provider sub-call (the risk-guard shape), failing open to the heuristic, then to
 * flagship, never to a throw. It routes the MODEL only — it never reads, grants,
 * or gates a capability — so it declares none. When unsure it routes flagship
 * (over-spend, never under-serve).
 *
 * Off by default; disable or tune it with `/routing`, or set `EAGENT_ROUTING=off`.
 */

import { currentActingAgent, type Agent } from "../kernel/agent.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { Message } from "../kernel/types.js";

/** The two-tier classification the heuristic / sub-call returns. */
export type Tier = "cheap" | "flagship";

type Mode = "heuristic" | "llm";

/**
 * A turn whose latest user text is at least this many characters routes
 * flagship (≈ a long paragraph — the "design the migration"/"debug this race"
 * shape); a one-liner stays cheap. Store-overridable, but pinned as the default.
 */
export const HARD_CHAR_LEN = 280;

/**
 * A most-recent `tool_result` whose content exceeds this many bytes signals a
 * large, dense context worth the flagship. Store-overridable; pinned default.
 */
export const HARD_TOOL_RESULT_BYTES = 8192;

/**
 * The default difficulty cue set, matched whole-word and case-insensitively (the
 * `microagents` trigger-match shape). Operator-overridable via the store.
 */
export const HARD_KEYWORD_CUES = [
  "debug",
  "design",
  "architect",
  "refactor",
  "migrate",
  "optimize",
  "race",
  "deadlock",
  "security",
  "vulnerability",
  "proof",
  "prove",
  "algorithm",
  "concurrent",
  "concurrency",
] as const;

/**
 * Date-pinned default tier map. The default flagship is a flagship Claude id and
 * the default cheap is a cheap Claude id, chosen to match the families `cost.ts`
 * already prices so a routed run is priced coherently by the sibling extension.
 * Fully store-overridable for non-Claude deployments; the offline test suite
 * overrides this to registered mock ids so these never touch a network.
 *
 * // as of 2026-06-22
 */
export const DEFAULT_TIERS: Record<Tier, string> = {
  cheap: "claude-fable-5",
  flagship: "claude-opus-4-8",
};

/** The fixed instruction for the optional LLM-mode classification sub-call. */
const CLASSIFIER_SYSTEM_PROMPT =
  "You are a difficulty classifier for an autonomous agent. You are given the " +
  "conversation so far. Judge whether the NEXT turn is trivial (cheap to run) or " +
  "hard (worth the flagship model). Reply on ONE line that begins with CHEAP or " +
  "HARD. Output nothing else.";

/**
 * Whole-word, case-insensitive cue match (the `microagents.triggered` shape):
 * a cue fires only when the characters immediately before and after an
 * occurrence are non-alphanumeric or absent — so `race` fires at word edges but
 * `race` inside `embrace` does not.
 */
function hasCue(text: string, cues: readonly string[]): boolean {
  const lower = text.toLowerCase();
  const isWord = (c: string | undefined): boolean => c !== undefined && /[a-z0-9]/.test(c);
  return cues.some((cue) => {
    const needle = cue.toLowerCase();
    if (needle.length === 0) return false;
    let from = 0;
    for (;;) {
      const i = lower.indexOf(needle, from);
      if (i === -1) return false;
      if (!isWord(lower[i - 1]) && !isWord(lower[i + needle.length])) return true;
      from = i + 1;
    }
  });
}

/**
 * The space-joined text of the last `user` message, or `undefined` when there is
 * no `user` message. Non-text blocks are ignored.
 */
function latestUserText(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    return m.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ");
  }
  return undefined;
}

/** The byte size of the most recent `tool_result` content, or 0 when absent. */
function lastToolResultBytes(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j]!;
      if (b.type === "tool_result") return Buffer.byteLength(b.content, "utf8");
    }
  }
  return 0;
}

/**
 * The deterministic heuristic classifier. A turn is `flagship` if ANY of {latest
 * user text length ≥ `HARD_CHAR_LEN`, any cue present (whole-word,
 * case-insensitive), most recent `tool_result` content byte size >
 * `HARD_TOOL_RESULT_BYTES`}; otherwise `cheap`.
 *
 * Conservative-on-unsure: when no latest user text can be read (absent or
 * whitespace-only), no positive trivial signal can be established, so it returns
 * `flagship` — a wrong call over-spends, never under-serves. Pure, no I/O.
 */
export function classify(
  messages: readonly Message[],
  cues: readonly string[] = HARD_KEYWORD_CUES,
  hardCharLen: number = HARD_CHAR_LEN,
  hardToolResultBytes: number = HARD_TOOL_RESULT_BYTES,
): Tier {
  const userText = latestUserText(messages);
  // Indeterminate: nothing to judge → conservative flagship.
  if (userText === undefined || userText.trim().length === 0) return "flagship";

  if (userText.length >= hardCharLen) return "flagship";
  if (hasCue(userText, cues)) return "flagship";
  if (lastToolResultBytes(messages) > hardToolResultBytes) return "flagship";
  return "cheap";
}

/**
 * Parse an LLM-mode classifier reply into a tier, or `undefined` when
 * unrecognized (so the caller fails open). Reads the first non-empty line and
 * upper-cases its leading run of letters: `HARD` → flagship, `CHEAP` → cheap.
 */
export function parseTier(reply: string): Tier | undefined {
  const line = reply.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return undefined;
  const token = (/^[A-Za-z]+/.exec(line)?.[0] ?? "").toUpperCase();
  if (token === "HARD") return "flagship";
  if (token === "CHEAP") return "cheap";
  return undefined;
}

/** Concatenate an assistant message's text blocks. */
function textOf(message: Message): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export default function activate(e: ExtensionAPI): () => void {
  // Kill switch: the env var makes activation a total no-op — no listeners, no
  // command, `Agent.model` never touched (the cost.ts:150 / recovery.ts pattern).
  if (!e.config.enabled("routing", { default: true })) return () => {};

  // The configured model captured per ACTING agent — each agent's restore
  // baseline. Keyed per agent so a routed child restores to ITS OWN model, not
  // the parent's, and concurrent forks don't share one var (W9.1). The parent is
  // seeded eagerly so a unit-level command dispatch (`/routing off`) before any
  // run can still restore; a child seeds lazily on its first turn (it never fires
  // agent_start), capturing its model before routing first mutates it.
  const baselines = new WeakMap<Agent, string>();
  baselines.set(e.agent, e.agent.model);
  const baselineFor = (agent: Agent): string => {
    let b = baselines.get(agent);
    if (b === undefined) baselines.set(agent, (b = agent.model));
    return b;
  };

  const cfg = () => ({
    enabled: e.store.get<boolean>("enabled", false) ?? false,
    mode: (e.store.get<Mode>("mode", "heuristic") ?? "heuristic") as Mode,
    tiers: e.store.get<Record<string, string>>("tiers", DEFAULT_TIERS) ?? DEFAULT_TIERS,
    cues: e.store.get<string[]>("cues", [...HARD_KEYWORD_CUES]) ?? [...HARD_KEYWORD_CUES],
    hardCharLen: e.store.get<number>("hardCharLen", HARD_CHAR_LEN) ?? HARD_CHAR_LEN,
    hardToolResultBytes:
      e.store.get<number>("hardToolResultBytes", HARD_TOOL_RESULT_BYTES) ?? HARD_TOOL_RESULT_BYTES,
  });

  /** Merge the store tier map over the date-pinned defaults (re-read each turn). */
  const activeTiers = (raw: Record<string, string>): Record<string, string> => ({
    ...DEFAULT_TIERS,
    ...raw,
  });

  /**
   * The optional LLM-mode classifier: a recursion-safe tool-less provider
   * sub-call (the risk-guard shape). Passing `tools: []` runs outside the agent
   * loop so this completion cannot emit a tool call and re-enter any tool seam.
   * It runs on the CURRENTLY configured `e.agent.model` at call time — by design
   * the classifier sub-call is itself unrouted. (Note this is whatever model is
   * configured when the sub-call fires, which on turn N>=2 of a routing run is the
   * tier picked on the previous turn, not necessarily the captured baseline.) Any
   * failure (no provider, a throw, an empty/garbled reply) resolves to `undefined`
   * so the caller fails open.
   */
  async function classifyLlm(messages: readonly Message[]): Promise<Tier | undefined> {
    try {
      const agent = currentActingAgent() ?? e.agent;
      const provider = agent.providers.get();
      if (!provider) return undefined;
      let reply = "";
      for await (const ev of provider.stream({
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        messages: [...messages],
        tools: [],
        model: agent.model,
        signal: new AbortController().signal,
      })) {
        if (ev.type === "done") reply = textOf(ev.message);
      }
      return parseTier(reply);
    } catch {
      return undefined;
    }
  }

  const disposers = [
    // Capture the configured model as the restore baseline (the cost.ts:203 move).
    e.on("agent_start", () => {
      baselines.set(e.agent, e.agent.model);
    }),

    e.on("turn_start", async () => {
      const c = cfg();
      // Route the ACTING agent (a running child under the shared bus), not the
      // parent bound at activation. (W9.1.)
      const agent = currentActingAgent() ?? e.agent;
      // The acting agent's own baseline (seeded here on a child's first turn,
      // before any branch below mutates its model).
      const baseline = baselineFor(agent);
      // Disabled (soft switch): restore the baseline and assign no tier.
      if (!c.enabled) {
        agent.model = baseline;
        return;
      }

      // Classify. LLM mode fails open to the heuristic, then (via classify's own
      // conservative rule) to flagship — never a throw.
      let tier: Tier;
      if (c.mode === "llm") {
        const verdict = await classifyLlm(agent.messages);
        tier =
          verdict ??
          classify(agent.messages, c.cues, c.hardCharLen, c.hardToolResultBytes);
      } else {
        tier = classify(agent.messages, c.cues, c.hardCharLen, c.hardToolResultBytes);
      }

      // Resolve the tier name against the configured map (the SOLE resolution
      // surface; the registry keys by provider name, not model id). A missing or
      // non-empty-string entry falls back to the captured baseline with a warn —
      // never a throw, never an empty assignment.
      const model = activeTiers(c.tiers)[tier];
      if (typeof model !== "string" || model.length === 0) {
        e.log.warn(
          `routing: tier "${tier}" has no usable model id in the tier map; ` +
            `falling back to the configured model "${baseline}"`,
        );
        agent.model = baseline;
        return;
      }
      agent.model = model;
    }),

    // Restore the configured model when the run ends (fires in the loop's
    // `finally`, so it also restores after an errored/aborted run). agent_end is
    // suppressed for children, so this only fires for the parent — restore its
    // own baseline.
    e.on("agent_end", () => {
      e.agent.model = baselineFor(e.agent);
    }),
  ];

  const offCommand = e.registerCommand({
    name: "routing",
    description:
      "Difficulty-aware per-turn model tiering. Usage: /routing [on|off|status] " +
      "or /routing tier <name> <modelId>.",
    run: (ctx) => {
      const args = ctx.args.trim();
      const [head, ...rest] = args.split(/\s+/).filter((s) => s.length > 0);
      switch (head) {
        case "on":
          e.store.set("enabled", true);
          ctx.print("routing on");
          break;
        case "off":
          e.store.set("enabled", false);
          // Soft switch: immediately restore the configured baseline.
          e.agent.model = baselineFor(e.agent);
          ctx.print("routing off");
          break;
        case "tier": {
          const [name, modelId] = rest;
          if (!name || !modelId) {
            ctx.print("routing: usage — /routing tier <name> <modelId>");
            break;
          }
          const stored = e.store.get<Record<string, string>>("tiers", DEFAULT_TIERS) ?? DEFAULT_TIERS;
          const next = { ...stored, [name]: modelId };
          e.store.set("tiers", next);
          ctx.print(`routing: tier ${name} = ${modelId}`);
          break;
        }
        default: {
          const c = cfg();
          const tiers = activeTiers(c.tiers);
          ctx.print(
            `routing ${c.enabled ? "on" : "off"} (mode=${c.mode}); ` +
              `tiers cheap=${tiers["cheap"] ?? "(unset)"} flagship=${tiers["flagship"] ?? "(unset)"}`,
          );
        }
      }
    },
  });

  return () => {
    for (const d of [offCommand, ...disposers]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
