/**
 * Context compaction and working memory — the `transformContext` seam.
 *
 * A long-horizon agent's hardest problem is not capability but context: the
 * transcript grows without bound while the model's window does not. Compaction
 * is the answer — fold the old, stable prefix of the conversation into a terse
 * summary and keep only the most recent turns verbatim. This is the heart of
 * long-horizon agents, and the kernel exposes exactly the right place to do it:
 * `transformContext`, a filter that reshapes the message list JUST before it is
 * sent to the model, without ever touching the persistent transcript.
 *
 * Keeping this as an extension (rather than baking it into the loop) is the
 * whole point: the *strategy* stays swappable. Summarize, truncate, embed and
 * retrieve, or hand off to a sub-agent — each is a different `transformContext`
 * handler, and the kernel stays neutral. This extension ships one reasonable
 * default (cached summarization) plus a manual `/compact` lever, an
 * introspection `/memory` command, and a `remember`/`recall` scratchpad — the
 * store-backed (persists across restart only under FileBackend) working-memory
 * pattern an agent uses to persist notes across the compaction boundary.
 */

import type { CommandContext } from "../kernel/commands.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { text, type Message } from "../kernel/types.js";

/** Defaults; each is overridable via `e.store`. */
const DEFAULT_THRESHOLD = 12;
const DEFAULT_KEEP_RECENT = 4;

/** The dedicated system prompt for the summarization sub-call. */
const SUMMARY_SYSTEM_PROMPT =
  "You are a summarizer. Produce a terse bullet summary of the conversation so " +
  "far, preserving decisions, facts, file paths, and open threads.";

/** Store key for the cached summary of the older prefix. */
const CACHE_KEY = "summaryCache";
/** Store-key prefix for the `remember`/`recall` scratchpad. */
const NOTE_PREFIX = "note:";

/** What we cache so an unchanged prefix is never re-summarized. */
interface SummaryCache {
  /** How many leading messages this summary covers. */
  coveredCount: number;
  summaryText: string;
  /** Content fingerprint of the covered prefix; guards against transcript swaps. */
  fingerprint: string;
}

/**
 * A cheap content fingerprint of a message prefix. Sampling characters keeps it
 * fast for large messages while staying sensitive to content, so a cached
 * summary is never reused for a different conversation after `/load`,
 * `/handoff`, or `clear()` replaces the transcript.
 */
function fingerprint(messages: Message[]): string {
  let h = 5381;
  for (const m of messages) {
    h = (Math.imul(h, 33) ^ m.role.charCodeAt(0)) | 0;
    const t = textOf(m);
    for (let i = 0; i < t.length; i += 17) h = (Math.imul(h, 33) ^ t.charCodeAt(i)) | 0;
  }
  return `${messages.length}:${(h >>> 0).toString(36)}`;
}

export default function activate(e: ExtensionAPI): void {
  const config = () => ({
    threshold: e.store.get<number>("threshold", DEFAULT_THRESHOLD) ?? DEFAULT_THRESHOLD,
    keepRecent: e.store.get<number>("keepRecent", DEFAULT_KEEP_RECENT) ?? DEFAULT_KEEP_RECENT,
  });

  /**
   * Summarize `older` by calling the configured provider DIRECTLY. Going
   * through the provider rather than `agent.run` bypasses the agent loop, so
   * this nested completion never re-enters `transformContext` — the recursion
   * guard. We pass no tools and a fresh abort signal: this is a pure, one-shot
   * read of the prefix.
   */
  async function summarize(older: Message[]): Promise<string> {
    const provider = e.agent.providers.get();
    if (!provider) return renderFallback(older);

    let finalText = "";
    for await (const ev of provider.stream({
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: older,
      tools: [],
      model: e.agent.model,
      signal: new AbortController().signal,
    })) {
      if (ev.type === "done") finalText = textOf(ev.message);
    }
    return finalText.trim() || renderFallback(older);
  }

  /**
   * Return the cached summary for `older` if it still covers a recent-enough
   * prefix, otherwise recompute and cache it. We re-summarize only when at
   * least `keepRecent` new messages have accumulated beyond what the cache
   * already covers — this is what keeps the hook cheap across turns.
   */
  async function summaryFor(older: Message[], keepRecent: number, force: boolean): Promise<string> {
    const cache = e.store.get<SummaryCache>(CACHE_KEY);
    // The cache is valid only if the prefix it covers still matches the current
    // transcript by content — not just by count — so a swapped-in conversation
    // of similar length can't be served the previous one's summary.
    const valid =
      !!cache &&
      cache.coveredCount <= older.length &&
      fingerprint(older.slice(0, cache.coveredCount)) === cache.fingerprint;
    const stale = !valid || older.length - cache!.coveredCount >= keepRecent;
    if (!force && valid && !stale) return cache!.summaryText;

    const summaryText = await summarize(older);
    e.store.set(CACHE_KEY, {
      coveredCount: older.length,
      summaryText,
      fingerprint: fingerprint(older),
    } satisfies SummaryCache);
    return summaryText;
  }

  /** Build the single `system` summary message that replaces `older`. */
  function summaryMessage(summaryText: string): Message {
    const msg = text("system", summaryText);
    msg.meta = { source: "memory", kind: "summary" };
    return msg;
  }

  // -- the compaction seam --------------------------------------------------

  e.hook("transformContext", async (messages) => {
    const { threshold, keepRecent } = config();
    if (messages.length <= threshold) return messages;

    const split = Math.max(0, messages.length - keepRecent);
    const older = messages.slice(0, split);
    const recent = messages.slice(split);
    if (older.length === 0) return messages;

    const summaryText = await summaryFor(older, keepRecent, false);
    // A NEW array; the persistent transcript (e.agent.messages) is untouched.
    return [summaryMessage(summaryText), ...recent];
  });

  // -- commands -------------------------------------------------------------

  e.registerCommand({
    name: "compact",
    description: "Force conversation compaction now, folding older messages into a summary.",
    run: async (ctx: CommandContext) => {
      const { threshold, keepRecent } = config();
      const messages = [...e.agent.messages];
      const split = Math.max(0, messages.length - keepRecent);
      const older = messages.slice(0, split);
      if (older.length === 0) {
        ctx.print(`Nothing to compact (${messages.length} messages, keeping ${keepRecent}).`);
        return;
      }
      // force:true recomputes and re-caches the summary unconditionally.
      await summaryFor(older, keepRecent, true);
      ctx.print(
        `Compacted ${older.length} message(s) into a summary; ` +
          `keeping the ${Math.min(keepRecent, messages.length - older.length)} most recent. ` +
          `(threshold ${threshold})`,
      );
    },
  });

  e.registerCommand({
    name: "memory",
    description: "Show compaction config and whether a summary is cached.",
    run: (ctx: CommandContext) => {
      const { threshold, keepRecent } = config();
      const cache = e.store.get<SummaryCache>(CACHE_KEY);
      const notes = e.store.keys().filter((k) => k.startsWith(NOTE_PREFIX)).length;
      ctx.print(`threshold=${threshold} keepRecent=${keepRecent}`);
      ctx.print(
        cache
          ? `cached summary: yes (covers ${cache.coveredCount} message(s))`
          : "cached summary: none",
      );
      ctx.print(`notes: ${notes}`);
    },
  });

  // -- working-memory scratchpad (remember / recall) ------------------------
  // No capability is required: this is the agent's own private notebook, not a
  // gateway to the filesystem or network.

  e.registerTool({
    spec: {
      name: "remember",
      description: "Persist a note to working memory under a key, surviving compaction.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The note's key." },
          value: { type: "string", description: "The note's value." },
        },
        required: ["key", "value"],
      },
    },
    execute: async (args) => {
      const key = String(args.key);
      const value = String(args.value);
      e.store.set(NOTE_PREFIX + key, value);
      return { content: `Remembered "${key}".` };
    },
  });

  e.registerTool({
    spec: {
      name: "recall",
      description: "Read a note from working memory by key, or list all notes when no key is given.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The note's key. Omit to return every note." },
        },
      },
    },
    execute: async (args) => {
      if (args.key !== undefined && args.key !== null && String(args.key) !== "") {
        const key = String(args.key);
        const value = e.store.get<string>(NOTE_PREFIX + key);
        return value === undefined
          ? { content: `No note for "${key}".`, isError: true }
          : { content: value };
      }
      const all: Record<string, string> = {};
      for (const k of e.store.keys()) {
        if (k.startsWith(NOTE_PREFIX)) all[k.slice(NOTE_PREFIX.length)] = e.store.get<string>(k) ?? "";
      }
      return { content: JSON.stringify(all), details: all };
    },
  });
}

/** Extract the concatenated text of an assistant message's text blocks. */
function textOf(message: Message): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * A deterministic, provider-free summary used when no provider is available
 * (or it returns nothing) — degrade to a rough transcript digest rather than
 * dropping the prefix entirely.
 */
function renderFallback(older: Message[]): string {
  const lines = older.map((m) => {
    const body = m.content
      .map((b) => (b.type === "text" ? b.text : b.type === "tool_call" ? `[call ${b.name}]` : "[result]"))
      .join(" ");
    return `- ${m.role}: ${body.slice(0, 120)}`;
  });
  return `Summary of ${older.length} earlier message(s):\n${lines.join("\n")}`;
}
