/**
 * Working memory — a store-backed `remember`/`recall` scratchpad.
 *
 * A long-horizon agent needs a place to persist notes that outlive any single
 * turn — and, crucially, the conversation compaction boundary. This extension
 * is that notebook: a `remember`/`recall` tool pair plus a `/memory` command
 * for white-box inspection (`list | edit | forget | rollback | consolidate`),
 * each note stored as a provenance-tagged, one-step-reversible `Entry` under the
 * `note:` keyspace (persists across restart only under FileBackend).
 *
 * Conversation compaction itself is NOT memory's job — the `compact` extension
 * (`compact.ts`) owns the `transformContext` seam with a single token-aware
 * structured compactor. `memory` deliberately registers no `transformContext`
 * hook, so the two never fight over the seam.
 */

import type { CommandContext } from "../kernel/commands.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { Store } from "../kernel/store.js";
import { overlapScore } from "./lib/relevance.js";

/** Defaults; each is overridable via `e.store`. Surfaced by the `/memory` view. */
const DEFAULT_THRESHOLD = 12;
const DEFAULT_KEEP_RECENT = 4;

/** Tier caps and retrieval width; each overridable via `e.store`. */
const DEFAULT_CORE_CAP = 64;
const DEFAULT_ARCHIVE_CAP = 512;
const DEFAULT_RECALL_TOPK = 5;

/** Store-key prefix for the always-available `note:` core tier. */
const NOTE_PREFIX = "note:";
/** Store-key prefix for the searchable `archive:` overflow tier. */
const ARCHIVE_PREFIX = "archive:";

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
  /** RW7b-3: recall count while in the archive tier; dropped on promotion to core. */
  recalls?: number;
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

/** Read the entry stored at `archive:<key>`, or `undefined` (mirrors `readEntry`). */
function readArchive(store: Store, key: string): Entry | undefined {
  const v = store.get<unknown>(ARCHIVE_PREFIX + key);
  if (v === undefined) return undefined;
  if (typeof v === "string") return { id: key, text: v, source: LEGACY_SOURCE, ts: "" };
  return v as Entry;
}

/** Every archive key currently in the store, sans the `archive:` prefix. */
function archiveKeys(store: Store): string[] {
  return store
    .keys()
    .filter((k) => k.startsWith(ARCHIVE_PREFIX))
    .map((k) => k.slice(ARCHIVE_PREFIX.length));
}

// ---------------------------------------------------------------------------
// Optional semantic recall: an injectable embedder ranks by cosine similarity,
// off by default and fail-soft to the lexical path below.
// ---------------------------------------------------------------------------

/** Batch text → comparable vectors. Injected in tests; env-resolved in production. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** Default embedding model for the OpenAI-compatible endpoint. */
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

let injected: Embedder | undefined = undefined;

/** Test hook: swap in a deterministic embedder (or `undefined` to clear). */
export function setEmbedder(fn: Embedder | undefined): void {
  injected = fn;
}

/**
 * Parse an OpenAI-compatible `{ data: [{ embedding: number[] }, …] }` body into
 * `number[][]`, preserving order. Throws on a malformed body so the recall call
 * site fails soft to the lexical ranking.
 */
export function parseEmbeddings(body: unknown): number[][] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("embed response has no data[] array");
  return data.map((d) => {
    const embedding = (d as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding) || !embedding.every((n) => typeof n === "number")) {
      throw new Error("embed response entry has no numeric embedding[]");
    }
    return embedding as number[];
  });
}

/**
 * A `fetch`-based embedder resolved from env, or `undefined` when
 * `EAGENT_MEMORY_EMBED_ENDPOINT` is unset. POSTs `{ model, input }` to the
 * OpenAI-compatible endpoint under a bounded timeout; zero-dep (global `fetch`).
 */
export function resolveEmbedder(): Embedder | undefined {
  const endpoint = process.env.EAGENT_MEMORY_EMBED_ENDPOINT;
  if (!endpoint) return undefined;
  const model = process.env.EAGENT_MEMORY_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
  const apiKey = process.env.EAGENT_MEMORY_EMBED_API_KEY ?? process.env.OPENAI_API_KEY;
  return async (texts) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`embed endpoint returned ${res.status}`);
    return parseEmbeddings(await res.json());
  };
}

/**
 * The embedder to use for this recall, resolved at call time: `undefined` (⇒
 * lexical) under the `EAGENT_MEMORY_EMBED=off` kill switch, else the injected
 * mock or the env-resolved `fetch` embedder.
 */
function activeEmbedder(): Embedder | undefined {
  if (process.env.EAGENT_MEMORY_EMBED === "off") return undefined;
  return injected ?? resolveEmbedder();
}

/** Cosine similarity of two vectors; 0 when either has zero norm. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) na += (a[i] ?? 0) ** 2;
  for (let i = 0; i < b.length; i++) nb += (b[i] ?? 0) ** 2;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** A scored retrieval hit: which tier it came from, the note value, and its score. */
interface Match {
  key: string;
  tier: "core" | "archive";
  text: string;
  score: number;
}

/**
 * Rank both tiers by lexical overlap with `query`: score every core and archive
 * entry via `overlapScore(query, entry.text)`, keep score > 0, sort descending,
 * and return the top `topK`. A key present in BOTH tiers yields two distinct
 * hits (no map collapse) since each tier is scored independently.
 */
function lexicalRank(store: Store, query: string, topK: number): Match[] {
  const matches: Match[] = [];
  for (const key of noteKeys(store)) {
    const entry = readEntry(store, key);
    if (!entry) continue;
    const score = overlapScore(query, entry.text);
    if (score > 0) matches.push({ key, tier: "core", text: entry.text, score });
  }
  for (const key of archiveKeys(store)) {
    const entry = readArchive(store, key);
    if (!entry) continue;
    const score = overlapScore(query, entry.text);
    if (score > 0) matches.push({ key, tier: "archive", text: entry.text, score });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, topK);
}

/**
 * Rank both tiers for `query`, then (RW7b-3) auto-promote any archived note that
 * has now been recalled `EAGENT_MEMORY_PROMOTE_AT` times back to core. The ranking
 * itself is a pure read (`rankTiers`); the promotion is the recall path's only
 * write, gated off by default (`EAGENT_MEMORY_PROMOTE_AT` unset/0 ⇒ no-op).
 */
async function searchTiers(store: Store, query: string, topK: number): Promise<Match[]> {
  const matches = await rankTiers(store, query, topK);
  autoPromote(store, matches);
  return matches;
}

/**
 * Bump the recall count of every returned archive-tier note; at
 * `EAGENT_MEMORY_PROMOTE_AT` promote it to core (dropping the transient counter),
 * mirroring `/memory promote`. Off (no write) when the env is unset/≤0.
 */
function autoPromote(store: Store, matches: Match[]): void {
  const at = Number(process.env.EAGENT_MEMORY_PROMOTE_AT) || 0;
  if (at <= 0) return;
  for (const m of matches) {
    if (m.tier !== "archive") continue;
    const entry = readArchive(store, m.key);
    if (!entry) continue;
    const recalls = (entry.recalls ?? 0) + 1;
    if (recalls >= at) {
      const promoted: Entry = { ...entry };
      delete promoted.recalls;
      store.set(NOTE_PREFIX + m.key, promoted);
      store.delete(ARCHIVE_PREFIX + m.key);
    } else {
      store.set(ARCHIVE_PREFIX + m.key, { ...entry, recalls });
    }
  }
}

/**
 * The ranking (a pure read): cosine over embeddings when an embedder is active,
 * else — and on any embed failure — the lexical ranking.
 */
async function rankTiers(store: Store, query: string, topK: number): Promise<Match[]> {
  const embedder = activeEmbedder();
  if (embedder) {
    try {
      // Enumerate every candidate from the FULL tier iteration — not the lexical
      // score>0 filter — so a zero-overlap paraphrase can still rank.
      const candidates: { key: string; tier: "core" | "archive"; text: string }[] = [];
      for (const key of noteKeys(store)) {
        const entry = readEntry(store, key);
        if (entry) candidates.push({ key, tier: "core", text: entry.text });
      }
      for (const key of archiveKeys(store)) {
        const entry = readArchive(store, key);
        if (entry) candidates.push({ key, tier: "archive", text: entry.text });
      }
      const vecs = await embedder([query, ...candidates.map((c) => c.text)]);
      const queryVec = vecs[0];
      if (queryVec === undefined) throw new Error("embed response has no query vector");
      const matches: Match[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        const vec = vecs[i + 1];
        if (vec === undefined) throw new Error("embed response has no candidate vector");
        const score = cosine(queryVec, vec);
        if (score > 0) matches.push({ key: c.key, tier: c.tier, text: c.text, score });
      }
      matches.sort((a, b) => b.score - a.score);
      return matches.slice(0, topK);
    } catch {
      // fail-soft: any embed error degrades to the lexical ranking below.
    }
  }
  return lexicalRank(store, query, topK);
}

/** Render a ranked match as one human-readable line for tool/command output. */
function renderMatch(m: Match): string {
  return `[${m.tier}] ${m.key} (score ${m.score}): ${m.text}`;
}

/**
 * The `(key, entry)` pair with the lowest `ts` among `keys`, reading each via
 * `read` and skipping any that no longer resolve (the `undefined` guard required
 * by `noUncheckedIndexedAccess`). Legacy `ts:""` entries sort first.
 */
function lowestByTs(
  keys: string[],
  read: (key: string) => Entry | undefined,
): { key: string; entry: Entry } | undefined {
  let best: { key: string; entry: Entry } | undefined;
  for (const key of keys) {
    const entry = read(key);
    if (!entry) continue;
    if (best === undefined || entry.ts < best.entry.ts) best = { key, entry };
  }
  return best;
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
async function runScratchpad(
  store: Store,
  sub: string,
  rest: string[],
  print: (line: string) => void,
): Promise<void> {
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
      // Opt-in exact-text dedupe (D5): group keys by normalized text, then keep
      // the LOWEST-`ts` entry per group (the genuinely earliest copy; legacy
      // `ts:""` first) and drop the rest. `ts` is last-write time, so an overwrite
      // can bump it without changing key-iteration order — hence survivor-by-`ts`
      // rather than survivor-by-first-iterated.
      const groups = new Map<string, string[]>(); // normalized text → keys
      for (const key of noteKeys(store)) {
        const entry = readEntry(store, key)!;
        const norm = normalize(entry.text);
        let keys = groups.get(norm);
        if (!keys) groups.set(norm, (keys = []));
        keys.push(key);
      }
      let merged = 0;
      for (const keys of groups.values()) {
        if (keys.length < 2) continue;
        const survivor = lowestByTs(keys, (k) => readEntry(store, k));
        for (const key of keys) {
          if (survivor && key === survivor.key) continue;
          store.delete(NOTE_PREFIX + key);
          merged++;
        }
      }
      print(`Consolidated: merged ${merged} duplicate note(s).`);
      return;
    }
    case "recall": {
      const query = rest.join(" ").trim();
      if (query.length === 0) {
        print("usage: /memory recall <query>");
        return;
      }
      const topK = store.get<number>("recallTopK", DEFAULT_RECALL_TOPK) ?? DEFAULT_RECALL_TOPK;
      const top = await searchTiers(store, query, topK);
      if (top.length === 0) {
        print(`No notes match "${query}".`);
        return;
      }
      for (const m of top) print(renderMatch(m));
      return;
    }
    case "archive": {
      const keys = archiveKeys(store);
      print(`archive: ${keys.length} note(s)`);
      for (const key of keys) {
        const entry = readArchive(store, key);
        if (entry) print(`${key}: ${entry.text}`);
      }
      return;
    }
    case "promote": {
      const key = rest[0];
      if (key === undefined) {
        print("usage: /memory promote <key>");
        return;
      }
      const entry = readArchive(store, key);
      if (!entry) {
        print(`no archived note "${key}".`);
        return;
      }
      store.set(NOTE_PREFIX + key, entry);
      store.delete(ARCHIVE_PREFIX + key);
      print(`Promoted "${key}" to core.`);
      return;
    }
    case "forget-archive": {
      const key = rest[0];
      if (key === undefined) {
        print("usage: /memory forget-archive <key>");
        return;
      }
      if (!readArchive(store, key)) {
        print(`no archived note "${key}".`);
        return;
      }
      store.delete(ARCHIVE_PREFIX + key);
      print(`Forgot archived "${key}".`);
      return;
    }
    default:
      print(
        `unknown /memory sub-command "${sub}"; ` +
          "expected list | edit | forget | rollback | consolidate | recall | archive | promote | forget-archive.",
      );
      return;
  }
}

export default function activate(e: ExtensionAPI): () => void {
  const config = () => ({
    threshold: e.store.get<number>("threshold", DEFAULT_THRESHOLD) ?? DEFAULT_THRESHOLD,
    keepRecent: e.store.get<number>("keepRecent", DEFAULT_KEEP_RECENT) ?? DEFAULT_KEEP_RECENT,
    coreCap: e.store.get<number>("coreCap", DEFAULT_CORE_CAP) ?? DEFAULT_CORE_CAP,
    archiveCap: e.store.get<number>("archiveCap", DEFAULT_ARCHIVE_CAP) ?? DEFAULT_ARCHIVE_CAP,
    recallTopK: e.store.get<number>("recallTopK", DEFAULT_RECALL_TOPK) ?? DEFAULT_RECALL_TOPK,
  });

  /**
   * Keep the core tier at most `coreCap`: move oldest-by-`ts` notes to `archive:`
   * until core fits, then FIFO-drop the oldest archive entries past `archiveCap`.
   * No-op under the kill switch (legacy bare-string mode never evicts).
   */
  const evictIfOverCap = (): void => {
    if (entriesDisabled()) return;
    const { coreCap, archiveCap } = config();
    while (noteKeys(e.store).length > coreCap) {
      const oldest = lowestByTs(noteKeys(e.store), (k) => readEntry(e.store, k));
      if (!oldest) break;
      e.store.set(ARCHIVE_PREFIX + oldest.key, oldest.entry);
      e.store.delete(NOTE_PREFIX + oldest.key);
    }
    while (archiveKeys(e.store).length > archiveCap) {
      const oldest = lowestByTs(archiveKeys(e.store), (k) => readArchive(e.store, k));
      if (!oldest) break;
      e.store.delete(ARCHIVE_PREFIX + oldest.key);
    }
  };

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

  // -- commands -------------------------------------------------------------

  disposables.push(
    e.registerCommand({
      name: "memory",
      description:
        "Show memory config, or inspect the scratchpad: " +
        "list | edit <id> <text> | forget <id> | rollback <id> | consolidate | " +
        "recall <query> | archive | promote <key> | forget-archive <key>.",
      run: (ctx: CommandContext) => {
        const tokens = ctx.args.trim().split(/\s+/).filter((t) => t.length > 0);
        const sub = tokens[0];
        // No-arg: the config + note-count view.
        if (sub === undefined) {
          const { threshold, keepRecent } = config();
          const notes = noteKeys(e.store).length;
          ctx.print(`threshold=${threshold} keepRecent=${keepRecent}`);
          ctx.print(`notes: ${notes}`);
          return;
        }
        // Kill switch: the new sub-commands report disabled (the no-arg view
        // above is unaffected, matching the legacy runtime).
        if (entriesDisabled()) {
          ctx.print(`/memory ${sub}: scratchpad entries are disabled (EAGENT_MEMORY_ENTRIES=off).`);
          return;
        }
        return runScratchpad(e.store, sub, tokens.slice(1), ctx.print);
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
        evictIfOverCap();
        return { content: `Remembered "${key}".` };
      },
    }),
  );

  disposables.push(
    e.registerTool({
      spec: {
        name: "recall",
        description:
          "Read a note by key, search both tiers by query (ranked lexical matches), " +
          "or list all core notes when neither is given.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "The note's key. Omit to return every note." },
            query: {
              type: "string",
              description: "Lexical search across the core and archive tiers; returns ranked matches.",
            },
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
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (query.length > 0) {
          const top = await searchTiers(e.store, query, config().recallTopK);
          return top.length === 0
            ? { content: `No notes match "${query}".`, details: [] }
            : { content: top.map(renderMatch).join("\n"), details: top };
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
