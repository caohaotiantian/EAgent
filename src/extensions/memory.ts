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
import type { Store } from "../kernel/store.js";
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

// ---------------------------------------------------------------------------
// White-box scratchpad: provenance-tagged entries (edit / forget / rollback)
// ---------------------------------------------------------------------------

/**
 * A single remembered fact, made individually inspectable, attributable, and
 * reversible. The minimal shape that satisfies list/edit/forget/rollback:
 * `id` is identity, `text` is the value, `source` is provenance, `ts` is the
 * captured ISO-8601 time, and `prevText` is one step of undo (shifted in on each
 * overwrite, discarded older-than-one). Plain JSON so a FileBackend round-trips
 * it via `JSON.stringify`.
 */
interface Entry {
  id: string;
  text: string;
  source: string;
  ts: string;
  prevText?: string;
}

/** Sentinel source for a legacy bare-string note read through the new path. */
const LEGACY_SOURCE = "legacy";

/**
 * The kill switch: when set, `remember` writes the legacy bare string and the
 * new `/memory` sub-commands report disabled, so behavior is byte-identical to
 * the pre-upgrade `memory` extension (mirrors `EAGENT_RECOVERY`,
 * `EAGENT_WRITE_GUARD`, `EAGENT_MICROAGENTS`).
 */
function entriesDisabled(): boolean {
  return process.env.EAGENT_MEMORY_ENTRIES === "off";
}

/**
 * Read the entry stored at `note:<key>`, tolerating both shapes (Decision D4,
 * lazy coexistence): a bare string is wrapped as a `legacy`-sourced entry with
 * no `prevText`; an object is returned as-is. Returns `undefined` for a missing
 * key. No startup migration — the wrap happens only on read.
 */
function readEntry(store: Store, key: string): Entry | undefined {
  const v = store.get<unknown>(NOTE_PREFIX + key);
  if (v === undefined) return undefined;
  if (typeof v === "string") return { id: key, text: v, source: LEGACY_SOURCE, ts: "" };
  return v as Entry;
}

/** Every note key currently in the store, sans the `note:` prefix. */
function noteKeys(store: Store): string[] {
  return store
    .keys()
    .filter((k) => k.startsWith(NOTE_PREFIX))
    .map((k) => k.slice(NOTE_PREFIX.length));
}

/** Find the `(key, entry)` pair whose entry id matches `id`, or `undefined`. */
function findById(store: Store, id: string): { key: string; entry: Entry } | undefined {
  for (const key of noteKeys(store)) {
    const entry = readEntry(store, key);
    if (entry && entry.id === id) return { key, entry };
  }
  return undefined;
}

/** Normalize text for `consolidate`'s exact-duplicate grouping (D5). */
function normalize(t: string): string {
  return t.trim().toLowerCase();
}

/**
 * Dispatch a `/memory <sub> [...]` scratchpad sub-command over the store. Pure
 * over `(store, args)` → printed lines, so the command handler stays a thin
 * shell. Operates only on the `note:` keyspace; never touches the summary path.
 */
function runScratchpad(
  store: Store,
  sub: string,
  rest: string[],
  print: (line: string) => void,
): void {
  switch (sub) {
    case "list": {
      const keys = noteKeys(store);
      if (keys.length === 0) {
        print("(no notes)");
        return;
      }
      for (const key of keys) {
        const entry = readEntry(store, key)!;
        const ts = entry.ts || "(no ts)";
        print(`${entry.id}  ${key}: ${entry.text}  [${entry.source} @ ${ts}]`);
      }
      return;
    }
    case "edit": {
      const id = rest[0];
      const newText = rest.slice(1).join(" ");
      if (id === undefined || newText.length === 0) {
        print("usage: /memory edit <id> <text>");
        return;
      }
      const hit = findById(store, id);
      if (!hit) {
        print(`no note with id "${id}".`);
        return;
      }
      const updated: Entry = { ...hit.entry, prevText: hit.entry.text, text: newText };
      store.set(NOTE_PREFIX + hit.key, updated);
      print(`Edited "${hit.key}" (${id}).`);
      return;
    }
    case "forget": {
      const id = rest[0];
      if (id === undefined) {
        print("usage: /memory forget <id>");
        return;
      }
      const hit = findById(store, id);
      if (!hit) {
        print(`no note with id "${id}".`);
        return;
      }
      store.delete(NOTE_PREFIX + hit.key);
      print(`Forgot "${hit.key}" (${id}).`);
      return;
    }
    case "rollback": {
      const id = rest[0];
      if (id === undefined) {
        print("usage: /memory rollback <id>");
        return;
      }
      const hit = findById(store, id);
      if (!hit) {
        print(`no note with id "${id}".`);
        return;
      }
      // Bounded to one step (D3): restore prevText into text and CONSUME it, so
      // a second consecutive rollback has nothing before prevText and is a
      // no-op. Absent prevText is also a no-op (nothing to undo).
      if (hit.entry.prevText === undefined) {
        print(`nothing to roll back for "${hit.key}" (${id}).`);
        return;
      }
      const rolled: Entry = {
        id: hit.entry.id,
        text: hit.entry.prevText,
        source: hit.entry.source,
        ts: hit.entry.ts,
      };
      store.set(NOTE_PREFIX + hit.key, rolled);
      print(`Rolled back "${hit.key}" (${id}).`);
      return;
    }
    case "consolidate": {
      // Opt-in exact-text dedupe (D5): group by normalized text, keep the
      // earliest note per group, drop later exact duplicates.
      const seen = new Map<string, string>(); // normalized text → kept key
      let merged = 0;
      for (const key of noteKeys(store)) {
        const entry = readEntry(store, key)!;
        const norm = normalize(entry.text);
        if (seen.has(norm)) {
          store.delete(NOTE_PREFIX + key);
          merged++;
        } else {
          seen.set(norm, key);
        }
      }
      print(`Consolidated: merged ${merged} duplicate note(s).`);
      return;
    }
    default:
      print(
        `unknown /memory sub-command "${sub}"; ` +
          "expected list | edit | forget | rollback | consolidate.",
      );
      return;
  }
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

export default function activate(e: ExtensionAPI): () => void {
  const config = () => ({
    threshold: e.store.get<number>("threshold", DEFAULT_THRESHOLD) ?? DEFAULT_THRESHOLD,
    keepRecent: e.store.get<number>("keepRecent", DEFAULT_KEEP_RECENT) ?? DEFAULT_KEEP_RECENT,
  });

  /**
   * Monotonic entry-id generator. Pure Node (no `crypto`, zero-dep rule): a
   * per-activation random base plus a process-time + counter suffix. Distinct
   * across calls (the counter advances) and stable once written (the id lives in
   * the stored entry, never recomputed on read).
   */
  let idCounter = 0;
  const idBase = Math.floor(Math.random() * 0xffffff).toString(36);
  const newId = (): string => `e${idBase}-${(idCounter++).toString(36)}`;

  // Every registration is tracked so the returned dispose loop tears it down
  // cleanly (and never throws) on unload/reload.
  const disposables: { dispose(): void }[] = [];

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

  disposables.push(
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
    }),
  );

  // -- commands -------------------------------------------------------------

  disposables.push(
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
    }),
  );

  disposables.push(
    e.registerCommand({
      name: "memory",
      description:
        "Show compaction config, or inspect the scratchpad: " +
        "list | edit <id> <text> | forget <id> | rollback <id> | consolidate.",
      run: (ctx: CommandContext) => {
        const tokens = ctx.args.trim().split(/\s+/).filter((t) => t.length > 0);
        const sub = tokens[0];
        // No-arg: the config/cache view, preserved verbatim.
        if (sub === undefined) {
          const { threshold, keepRecent } = config();
          const cache = e.store.get<SummaryCache>(CACHE_KEY);
          const notes = noteKeys(e.store).length;
          ctx.print(`threshold=${threshold} keepRecent=${keepRecent}`);
          ctx.print(
            cache
              ? `cached summary: yes (covers ${cache.coveredCount} message(s))`
              : "cached summary: none",
          );
          ctx.print(`notes: ${notes}`);
          return;
        }
        // Kill switch: the new sub-commands report disabled (the no-arg view
        // above is unaffected, matching the legacy runtime).
        if (entriesDisabled()) {
          ctx.print(`/memory ${sub}: scratchpad entries are disabled (EAGENT_MEMORY_ENTRIES=off).`);
          return;
        }
        runScratchpad(e.store, sub, tokens.slice(1), ctx.print);
      },
    }),
  );

  // -- working-memory scratchpad (remember / recall) ------------------------
  // No capability is required: this is the agent's own private notebook, not a
  // gateway to the filesystem or network.

  disposables.push(
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
        if (entriesDisabled()) {
          // Kill switch: byte-identical to the pre-upgrade write path.
          e.store.set(NOTE_PREFIX + key, value);
          return { content: `Remembered "${key}".` };
        }
        // Overwrite is reversible one step: the current text (if any) becomes
        // prevText; the older prior is discarded (Decision D3). A first write
        // reuses any existing id so list/edit/forget/rollback stay stable.
        const existing = readEntry(e.store, key);
        const entry: Entry = {
          id: existing?.id ?? newId(),
          text: value,
          source: "tool:remember",
          ts: new Date().toISOString(),
        };
        if (existing) entry.prevText = existing.text;
        e.store.set(NOTE_PREFIX + key, entry);
        return { content: `Remembered "${key}".` };
      },
    }),
  );

  disposables.push(
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
          const entry = readEntry(e.store, key);
          // Unwrap `.text` — never surface the Entry envelope to the model.
          return entry === undefined
            ? { content: `No note for "${key}".`, isError: true }
            : { content: entry.text };
        }
        // No-key list keeps its `{ key → text }` contract (D4): unwrap `.text`
        // from entries, pass legacy bare strings through, never serialize an
        // Entry object.
        const all: Record<string, string> = {};
        for (const key of noteKeys(e.store)) all[key] = readEntry(e.store, key)?.text ?? "";
        return { content: JSON.stringify(all), details: all };
      },
    }),
  );

  return () => {
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
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
      .map((b) =>
        b.type === "text"
          ? b.text
          : b.type === "tool_call"
            ? `[call ${b.name}]`
            : b.type === "thinking"
              ? "[thinking]"
              : "[result]",
      )
      .join(" ");
    return `- ${m.role}: ${body.slice(0, 120)}`;
  });
  return `Summary of ${older.length} earlier message(s):\n${lines.join("\n")}`;
}
