/**
 * Token-gated, structured conversation compaction with a pinned block — the
 * `transformContext` seam.
 *
 * Two extensions already bound context size on this seam, and neither does what
 * production agents (codex `compact`, gemini `chatCompressionService`) do.
 * `prune` (`prune.ts`) truncates the *bytes* of old, oversized `tool_result`
 * blocks — a provider-free size defense that never folds dialogue. `memory`
 * (`memory.ts`) folds the older prefix into a summary, but triggers on message
 * *count* and summarizes into a *single free-form bullet* that can silently drop
 * an active plan, a decision, or a load-bearing fact.
 *
 * This extension is the token-aware, structured-slot successor to `memory`'s
 * count-based compaction path. When the estimated transcript token count exceeds
 * a configurable budget, it splits at a **user-turn boundary** (never severing an
 * in-flight `tool_call`/`tool_result` pair), summarizes the older slice via a
 * **recursion-safe tool-less provider sub-call** into the structured handoff
 * `## Decisions` / `## Files` / `## Open threads`, keeps the last K user turns
 * verbatim, carries forward prior summary slots on re-summarization, and
 * **always re-injects a small byte-capped PINNED block** so designated evidence
 * survives compaction by construction. It produces the `meta.kind:"summary"`
 * marker that `prune` already recognizes and stops at (`prune.ts:61`).
 *
 * Because it makes a paid, latency-adding model sub-call and rewrites the context
 * the model sees, it ships OFF and must be enabled explicitly (`/compact on` or
 * `e.store.set("enabled", true)`); `EAGENT_COMPACT=off` is the hard env kill,
 * read inside the hook. The summarization fails OPEN: no provider / a throw /
 * an empty reply degrades to a deterministic provider-free digest so the prefix
 * is never silently dropped.
 */

import type { CommandContext } from "../kernel/commands.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { text, type Message } from "../kernel/types.js";

/** Estimated-token budget above which the older prefix is folded. (§4 D4.) */
const DEFAULT_BUDGET = 60_000;
/** Protect the last K user turns verbatim. (§4 D4.) */
const DEFAULT_KEEP_TURNS = 3;
/** Byte cap on the always-surviving pinned block. (§4 D6, R4.) */
export const PIN_MAX_BYTES = 2_000;
/** Store-key prefix for pinned notes (mirrors memory's `NOTE_PREFIX`). */
const PIN_PREFIX = "pin:";

/**
 * The fixed instruction for the summarization sub-call. It must (a) contain the
 * word "summar" so an offline test responder can branch on it, (b) ask for
 * exactly the three structured sections, and (c) instruct merge/preserve of any
 * prior such sections in the input (the D8 carry-forward).
 */
const COMPACT_SYSTEM_PROMPT =
  "You are a conversation summarizer for a long-running agent. Summarize the " +
  "conversation so far into EXACTLY these three markdown sections, in this " +
  "order: `## Decisions`, `## Files`, `## Open threads`. Under each, list the " +
  "durable items (decisions made, files touched/created, and unresolved threads " +
  "or next steps). If the input already contains such sections from an earlier " +
  "summary, MERGE and PRESERVE their items into yours — never drop earlier " +
  "decisions, files, or threads. Output only the three sections, nothing else.";

/** A tokenizer-free per-string estimate, identical to prune's `est`. */
function est(s: string): number {
  return Math.max(0, Math.round(s.length / 4));
}

/**
 * Estimate the transcript's token size, summing BOTH `text`-block `.text` AND
 * `tool_result`-block `.content` across the whole transcript. This is the
 * deliberate divergence from `prune` (which sums only `tool_result` content,
 * `prune.ts:64-69`): `compact` is a *conversation*-size gate, so it must also
 * count dialogue text — else a text-heavy conversation under-counts and never
 * fires. (§4 D1.)
 */
export function tokenEstimate(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === "text") total += est(block.text);
      else if (block.type === "tool_result") total += est(block.content);
    }
  }
  return total;
}

/**
 * The index at which to split: `[0, idx)` is the foldable older slice, `[idx,
 * end)` is the protected recent window of the last `keepTurns` user turns.
 *
 * Walks backward counting `role === "user"` messages as user-turn boundaries;
 * the split point is the index of the `keepTurns`-th user message from the end —
 * a user-turn boundary — so an in-flight `tool_call`/`tool_result` pair (which
 * follows a user turn) is never severed. Returns `0` (no fold) when there are
 * fewer than `keepTurns` user turns or no foldable boundary older than the recent
 * window (the one-giant-turn case). (§4 D1/D4, R3, AC-4.)
 *
 * `budget` is accepted for signature symmetry with the design contract; the
 * decision to split *at all* is the hook's budget gate, so this function only
 * decides *where*.
 */
export function splitIndex(messages: Message[], _budget: number, keepTurns: number): number {
  if (keepTurns <= 0) return messages.length;
  let userTurns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      userTurns++;
      if (userTurns === keepTurns) {
        // The split is at this user message; an older boundary must exist for
        // there to be anything to fold.
        return i > 0 ? i : 0;
      }
    }
  }
  // Fewer than `keepTurns` user turns: nothing older to fold.
  return 0;
}

/** Concatenate a message's text blocks. */
function textOf(message: Message): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * A deterministic, provider-free digest of the older slice, used when no
 * provider is available or it returns nothing. Non-empty by construction, so the
 * prefix is never silently dropped. (Mirrors `memory.ts:252-268`.) (§4 D5, AC-12.)
 */
function renderFallback(older: Message[]): string {
  const lines = older.map((m) => {
    const body = m.content
      .map((b) =>
        b.type === "text"
          ? b.text
          : b.type === "tool_call"
            ? `[call ${b.name}]`
            : b.type === "tool_result"
              ? "[result]"
              : b.type === "thinking"
                ? "[thinking]"
                : "[image]",
      )
      .join(" ");
    return `- ${m.role}: ${body.slice(0, 120)}`;
  });
  return (
    "## Decisions\n## Files\n## Open threads\n" +
    `(provider-free digest of ${older.length} earlier message(s))\n${lines.join("\n")}`
  );
}

/** Byte-cap a string to at most `max` UTF-8 bytes without splitting a code point. */
function byteCap(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  // Slice on a byte basis, then trim any trailing partial multi-byte sequence by
  // decoding with replacement and stripping a trailing U+FFFD.
  let buf = Buffer.from(s, "utf8").subarray(0, max);
  let out = buf.toString("utf8");
  while (out.endsWith("�") && buf.length > 0) {
    buf = buf.subarray(0, buf.length - 1);
    out = buf.toString("utf8");
  }
  return out;
}

export default function activate(e: ExtensionAPI): () => void {
  const cfg = () => ({
    enabled:
      process.env.EAGENT_COMPACT === "off" ? false : e.store.get<boolean>("enabled", false) ?? false,
    budget: e.store.get<number>("budget", DEFAULT_BUDGET) ?? DEFAULT_BUDGET,
    keepTurns: e.store.get<number>("keepTurns", DEFAULT_KEEP_TURNS) ?? DEFAULT_KEEP_TURNS,
  });

  /** Recursion guard: true while a summarization sub-call is in flight. */
  let summarizing = false;

  /**
   * Summarize `older` via the configured provider DIRECTLY. Passing `tools: []`
   * runs outside the agent loop, so this completion cannot emit a tool call and
   * re-enter `transformContext`. Fails OPEN: no provider / a throw / an empty
   * reply degrades to a deterministic digest. (Mirrors `risk-guard.ts:95-121`,
   * `memory.ts:78-93`.) (§4 D5, AC-11/AC-12.)
   */
  async function summarize(older: Message[]): Promise<string> {
    try {
      const provider = e.agent.providers.get();
      if (!provider) return renderFallback(older);
      let finalText = "";
      for await (const ev of provider.stream({
        systemPrompt: COMPACT_SYSTEM_PROMPT,
        messages: older,
        tools: [],
        model: e.agent.model,
        signal: new AbortController().signal,
      })) {
        if (ev.type === "done") finalText = textOf(ev.message);
      }
      return finalText.trim() || renderFallback(older);
    } catch {
      return renderFallback(older);
    }
  }

  /** All pinned keys in the store, sorted for a stable rendering order. */
  function pinKeys(): string[] {
    return e.store
      .keys()
      .filter((k) => k.startsWith(PIN_PREFIX))
      .sort();
  }

  /**
   * The always-surviving pinned block: every `pin:`-prefixed store entry,
   * rendered and byte-capped to `PIN_MAX_BYTES` so it can never itself blow the
   * budget it protects. Returns `""` when there are no pins. (§4 D6, R4, AC-5.)
   */
  function pinnedBlock(): string {
    const keys = pinKeys();
    if (keys.length === 0) return "";
    const body = keys
      .map((k) => `- ${k.slice(PIN_PREFIX.length)}: ${e.store.get<string>(k) ?? ""}`)
      .join("\n");
    return byteCap(`Pinned context (always retained):\n${body}`, PIN_MAX_BYTES);
  }

  /** Build the single `system` summary message that replaces `older`. */
  function summaryMessage(summaryText: string): Message {
    const msg = text("system", summaryText);
    msg.meta = { source: "compact", kind: "summary" };
    return msg;
  }

  /** The pinned-block message (one), or none when there are no pins. */
  function pinnedMessages(): Message[] {
    const block = pinnedBlock();
    if (!block) return [];
    const msg = text("system", block);
    msg.meta = { source: "compact", kind: "pinned" };
    return [msg];
  }

  // -- the compaction seam --------------------------------------------------

  const offHook = e.hook("transformContext", async (messages) => {
    if (summarizing) return messages; // re-entrancy guard (AC-11)
    const { enabled, budget, keepTurns } = cfg();
    if (!enabled) return messages; // off by default / kill switch (AC-8/AC-9)
    if (tokenEstimate(messages) <= budget) return messages; // under budget (AC-1)

    const idx = splitIndex(messages, budget, keepTurns);
    if (idx <= 0) return messages; // no foldable boundary (§5)

    // We split on (not exclude) any prior summary marker, so if a summary ever
    // sits at the head of `older` it flows into the sub-call and the merge prompt
    // (D2) preserves its slots (D8 carry-forward). In the live agent loop this is
    // a defensive belt-and-suspenders: `transformContext` runs over a fresh
    // `[...this.#messages]` copy each turn and the folded result is never written
    // back (agent.ts:247-251), so the hook re-receives the RAW older messages and
    // re-folds them from scratch — no decisions are lost across folds either way.
    const older = messages.slice(0, idx);
    const recent = messages.slice(idx);

    summarizing = true;
    let summaryText: string;
    try {
      summaryText = await summarize(older);
    } finally {
      summarizing = false;
    }

    // A NEW array; the persistent transcript is untouched. The pinned block sits
    // after the summary, immediately before the recent window (AC-5).
    return [summaryMessage(summaryText), ...pinnedMessages(), ...recent];
  });

  // -- pin / unpin tools (a private store notebook; no capability) ----------

  const offPin = e.registerTool({
    spec: {
      name: "pin",
      description: "Pin a note under a key so it always survives conversation compaction.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The pin's key." },
          value: { type: "string", description: "The pinned text." },
        },
        required: ["key", "value"],
      },
    },
    execute: async (args) => {
      const key = String(args.key);
      e.store.set(PIN_PREFIX + key, String(args.value));
      return { content: `Pinned "${key}".` };
    },
  });

  const offUnpin = e.registerTool({
    spec: {
      name: "unpin",
      description: "Remove a pinned note by key so it no longer survives compaction.",
      parameters: {
        type: "object",
        properties: { key: { type: "string", description: "The pin's key." } },
        required: ["key"],
      },
    },
    execute: async (args) => {
      const key = String(args.key);
      e.store.delete(PIN_PREFIX + key);
      return { content: `Unpinned "${key}".` };
    },
  });

  // -- the /compact command (shadows memory's; last-wins) -------------------

  const offCmd = e.registerCommand({
    name: "compact",
    description:
      "Token-gated structured compaction. Usage: /compact [status|on|off|force|pin <k> <v>|unpin <k>]",
    run: async (ctx: CommandContext) => {
      const arg = ctx.args.trim();
      const [verb, ...rest] = arg.split(/\s+/);
      switch (verb) {
        case "on":
          e.store.set("enabled", true);
          ctx.print("compact on");
          return;
        case "off":
          e.store.set("enabled", false);
          ctx.print("compact off");
          return;
        case "pin": {
          const key = rest[0];
          if (!key) {
            ctx.print("usage: /compact pin <key> <value>");
            return;
          }
          e.store.set(PIN_PREFIX + key, rest.slice(1).join(" "));
          ctx.print(`Pinned "${key}". (${pinKeys().length} pin(s))`);
          return;
        }
        case "unpin": {
          const key = rest[0];
          if (!key) {
            ctx.print("usage: /compact unpin <key>");
            return;
          }
          e.store.delete(PIN_PREFIX + key);
          ctx.print(`Unpinned "${key}". (${pinKeys().length} pin(s))`);
          return;
        }
        case "force": {
          // Report what the next over-budget turn WOULD fold, computed from the
          // pure `splitIndex` over the live transcript. We deliberately do NOT
          // run `summarize(older)` here: unlike `memory`'s force (which populates
          // a cache its hook later consumes, `memory.ts:160`), `compact` keeps no
          // cache, so a sub-call's result would be computed and discarded — a paid
          // model call with no effect on the transcript. The actual fold happens
          // in the `transformContext` hook when the budget gate fires.
          const { budget, keepTurns } = cfg();
          const messages = [...e.agent.messages];
          const idx = splitIndex(messages, budget, keepTurns);
          if (idx <= 0) {
            ctx.print(
              `Nothing to compact (${messages.length} message(s), no foldable boundary before the last ${keepTurns} turn(s)).`,
            );
            return;
          }
          // `splitIndex` ignores the budget, so a foldable boundary can exist on
          // an under-budget transcript that would never fold on its own. Phrase
          // the preview by whether the live transcript is actually over budget:
          // "the next over-budget turn" is only guaranteed when we already are.
          const when =
            tokenEstimate(messages) > budget
              ? "on the next over-budget turn"
              : "once the transcript next goes over budget";
          ctx.print(
            `Would compact ${idx} message(s) into a structured summary ${when}; ` +
              `keeping the last ${keepTurns} user turn(s) ` +
              `(${messages.length - idx} message(s)). (${pinKeys().length} pin(s) retained)`,
          );
          return;
        }
        default: {
          // status (default)
          const { enabled, budget, keepTurns } = cfg();
          ctx.print(
            `compact ${enabled ? "on" : "off"} budget=${budget} keepTurns=${keepTurns} pins=${pinKeys().length}`,
          );
        }
      }
    },
  });

  return () => {
    for (const d of [offHook, offPin, offUnpin, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
