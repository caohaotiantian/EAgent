/**
 * Playbook — an ACE-style delta-merged, auto-injected insight playbook.
 *
 * Lilian Weng's *Harness Engineering for Self-Improvement* and the Agentic
 * Context Engineering paper (ACE, arXiv 2510.04618) make one verified claim
 * worth absorbing: treat durable context as an evolving playbook of itemized
 * bullets that is (a) updated by DETERMINISTIC delta-merge — append a new
 * bullet, or merge an insight into an existing one — never by a monolithic LLM
 * rewrite (a rewrite collapses context), and (b) AUTO-INJECTED into context each
 * turn so accumulated know-how is always in front of the model.
 *
 * This extension is that pattern. Each bullet is a `{ id, text, ord, ts }` entry
 * under the `bullet:` keyspace, ordered by a monotonic `ord` counter (`seq`).
 * `merge` appends a delta as a new `MERGE_SEP`-delimited segment only when it is
 * not already an exact segment (segment-exact dedupe — structurally unable to
 * collapse context). The playbook is injected as one leading ephemeral `system`
 * message on the `transformContext` seam when enabled, byte-capped so the
 * always-on per-turn cost is bounded.
 *
 * No model call is ever made (all merges are pure string ops), and no capability
 * is required — like `memory`, this is the agent's own private notebook. Ships
 * OFF by default: enable via `/playbook on` (a stored flag), hard-kill via
 * `EAGENT_PLAYBOOK=off`. `memory` deliberately owns no `transformContext` hook,
 * so the two never fight over the seam; `compact` runs earlier in load order, so
 * the injected block is never folded into a summary.
 */

import type { ExtensionAPI } from "../kernel/extension.js";
import type { Config, Store } from "../kernel/store.js";
import type { Message } from "../kernel/types.js";

/**
 * Segment separator: an invisible ASCII control char (US, unit separator) that
 * is prose-unlikely, so a merged delta cannot forge a segment boundary. It is
 * rendered as a readable `"; "` only when building the injection text; a
 * command-supplied delta containing the raw char is stripped before storage.
 */
export const MERGE_SEP = "\x1f";

/** Readable rendering of `MERGE_SEP` in the injected note text. */
const RENDER_SEP = "; ";

/** Upper bound on the whole injected system message, in bytes (header + bodies +
 *  marker). Tighter than the 32 KB of `context-files`/`microagents` because this
 *  block injects unconditionally on EVERY turn. Overridable via `playbook.maxBytes`. */
export const MAX_INJECT_BYTES = 8 * 1024;

/** Store-growth backstop; matches `memory`'s core cap. The real limiter on
 *  injected size is the byte cap. Overridable via `playbook.maxBullets`. */
export const MAX_BULLETS = 64;

/** Store-key prefix for a single bullet entry. */
const BULLET_PREFIX = "bullet:";
/** Store key for the persisted monotonic ordinal counter. */
const SEQ_KEY = "seq";
/** Store key for the `/playbook on|off` injection flag. */
const ENABLED_KEY = "enabled";

const HEADER = "Playbook — durable insights (auto-injected):";
const marker = (n: number): string => `... (${n} more not shown)`;

/**
 * A single durable insight. `id` is identity, `text` is the (possibly
 * `MERGE_SEP`-segmented) body, `ord` is the monotonic insertion order used for
 * both display and FIFO eviction, and `ts` is the captured ISO-8601 time. Plain
 * JSON so a FileBackend round-trips it.
 */
export interface Bullet {
  id: string;
  text: string;
  ord: number;
  ts: string;
}

/** Replace any raw `MERGE_SEP` in incoming text with a space so it cannot forge
 *  a segment boundary. */
function stripSep(s: string): string {
  return s.split(MERGE_SEP).join(" ");
}

/** Render a bullet's stored text for display, turning segment separators into a
 *  readable `"; "`. */
function render(bulletText: string): string {
  return bulletText.split(MERGE_SEP).join(RENDER_SEP);
}

/**
 * Deterministic delta-merge (the core ACE lesson). Split `text` on `sep` into
 * segments; if `delta` exactly equals one of them, return `text` UNCHANGED (an
 * idempotent no-op). Otherwise append it as a new segment (`text + sep + delta`).
 * Segment-exact, not raw-substring: a `delta` that is a substring of but not
 * equal to a segment is still appended. Pure — no store, no model call.
 */
export function mergeSegments(text: string, delta: string, sep: string): string {
  if (text.split(sep).includes(delta)) return text;
  return text + sep + delta;
}

/**
 * Build the injected note text from `bullets` (rendered in ascending `ord`),
 * filling whole bullets until the next would push the WHOLE message (header +
 * bodies + marker) over `maxBytes`. Reserves the truncation-marker bytes inside
 * the budget, so the returned text's utf8 byte length is `<= maxBytes`. When any
 * bullet is dropped, a single `... (N more not shown)` marker line is appended.
 * Returns `undefined` when there is nothing to inject (`bullets` empty, or
 * `maxBytes` is too small to fit even the header + marker).
 */
export function buildInjection(bullets: Bullet[], maxBytes: number): string | undefined {
  if (bullets.length === 0) return undefined;
  const ordered = [...bullets].sort((a, b) => a.ord - b.ord);

  const lines: string[] = [];
  let used = Buffer.byteLength(HEADER, "utf8");
  let i = 0;
  for (; i < ordered.length; i++) {
    const line = "- " + render(ordered[i]!.text);
    const lineBytes = Buffer.byteLength("\n" + line, "utf8");
    // If we include this bullet and stop, this many remain to be marked.
    const remainingIfStop = ordered.length - (i + 1);
    const markerReserve =
      remainingIfStop > 0 ? Buffer.byteLength("\n" + marker(remainingIfStop), "utf8") : 0;
    if (used + lineBytes + markerReserve > maxBytes) break;
    used += lineBytes;
    lines.push(line);
  }

  const dropped = ordered.length - lines.length;
  let out = [HEADER, ...lines].join("\n");
  if (dropped > 0) out += "\n" + marker(dropped);
  // When not even the first bullet fits, `out` is just HEADER + marker with no
  // reserved budget, so it can exceed a very small `maxBytes`. Inject nothing
  // rather than break the `<= maxBytes` invariant (a content-free note is noise).
  if (Buffer.byteLength(out, "utf8") > maxBytes) return undefined;
  return out;
}

/**
 * Inject the playbook as one leading ephemeral `system` message. Returns
 * `messages` BY REFERENCE when `config` is supplied and reports the playbook
 * disabled (env veto `EAGENT_PLAYBOOK=off` or a default-off flag) or when there
 * is nothing to inject; otherwise returns a NEW `[note, ...messages]` array. The
 * gate is skipped when `config` is omitted — the `activate` closure does the
 * store-aware gate itself and then calls this with `config` unset. Pure over
 * `(messages, bullets, maxBytes)`; no store, no model call.
 */
export function injectPlaybook(
  messages: Message[],
  bullets: Bullet[],
  config?: Config,
  maxBytes: number = MAX_INJECT_BYTES,
): Message[] {
  if (config && !config.enabled("playbook", { default: false })) return messages;
  const noteText = buildInjection(bullets, maxBytes);
  if (noteText === undefined) return messages;
  const note: Message = {
    role: "system",
    content: [{ type: "text", text: noteText }],
    meta: { source: "playbook", ephemeral: true },
  };
  return [note, ...messages];
}

/** Every bullet currently in the store, sorted ascending by `ord`. */
function listBullets(store: Store): Bullet[] {
  return store
    .keys()
    .filter((k) => k.startsWith(BULLET_PREFIX))
    .map((k) => store.get<Bullet>(k))
    .filter((b): b is Bullet => b !== undefined)
    .sort((a, b) => a.ord - b.ord);
}

/** Read-increment-write the persisted ordinal counter, returning the next `ord`. */
function nextOrd(store: Store): number {
  const next = (store.get<number>(SEQ_KEY, 0) ?? 0) + 1;
  store.set(SEQ_KEY, next);
  return next;
}

export default function activate(e: ExtensionAPI): () => void {
  const store = e.store;

  /**
   * Monotonic bullet-id generator (mirrors `memory`): a per-activation random
   * base plus an advancing counter. Zero-dep (no `crypto`); the id lives in the
   * stored bullet and is never recomputed on read.
   */
  let idCounter = 0;
  const idBase = Math.floor(Math.random() * 0xffffff).toString(36);
  const newId = (): string => `p${idBase}-${(idCounter++).toString(36)}`;

  /** The HARD kill switch only (`EAGENT_PLAYBOOK=off` or an override set off) —
   *  NOT the injection flag, so bullets can still be curated while injection is
   *  off. `default: true` means only an explicit veto disables curation. */
  const killed = (): boolean => !e.config.enabled("playbook", { default: true });

  /** FIFO-drop lowest-`ord` bullets until the store holds at most the cap. */
  const enforceCap = (): void => {
    const cap = e.config.int("playbook.maxBullets", MAX_BULLETS);
    let bullets = listBullets(store);
    while (bullets.length > cap) {
      const oldest = bullets[0]!;
      store.delete(BULLET_PREFIX + oldest.id);
      bullets = bullets.slice(1);
    }
  };

  const add = (rawText: string): Bullet => {
    const bullet: Bullet = {
      id: newId(),
      text: stripSep(rawText),
      ord: nextOrd(store),
      ts: new Date().toISOString(),
    };
    store.set(BULLET_PREFIX + bullet.id, bullet);
    enforceCap();
    return bullet;
  };

  const merge = (id: string, rawDelta: string): boolean => {
    const key = BULLET_PREFIX + id;
    const bullet = store.get<Bullet>(key);
    if (!bullet) return false;
    const merged = mergeSegments(bullet.text, stripSep(rawDelta), MERGE_SEP);
    if (merged !== bullet.text) store.set(key, { ...bullet, text: merged });
    return true;
  };

  const forget = (id: string): boolean => {
    const key = BULLET_PREFIX + id;
    if (store.get(key) === undefined) return false;
    store.delete(key);
    return true;
  };

  const clear = (): number => {
    const keys = store.keys().filter((k) => k.startsWith(BULLET_PREFIX));
    for (const k of keys) store.delete(k);
    return keys.length;
  };

  const disposables: { dispose(): void }[] = [];

  // Auto-injection. The store-aware enable gate is done HERE (where the store is
  // in scope); `injectPlaybook` is called without a `config` so it does not
  // re-gate — but with the `playbook.maxBytes` override threaded through.
  disposables.push(
    e.hook("transformContext", (messages) => {
      if (!e.config.enabled("playbook", { default: false, store })) return messages;
      const maxBytes = e.config.int("playbook.maxBytes", MAX_INJECT_BYTES);
      return injectPlaybook(messages, listBullets(store), undefined, maxBytes);
    }),
  );

  disposables.push(
    e.registerCommand({
      name: "playbook",
      description:
        "Durable auto-injected insight playbook: " +
        "on | off | list | add <text> | merge <id> <text> | forget <id> | clear.",
      run: (ctx) => {
        const tokens = ctx.args.trim().split(/\s+/).filter((t) => t.length > 0);
        const sub = tokens[0];

        // list (also the no-arg default), on, off run regardless of the kill switch.
        if (sub === undefined || sub === "list") {
          const bullets = listBullets(store);
          if (bullets.length === 0) {
            ctx.print("(no bullets)");
            return;
          }
          for (const b of bullets) ctx.print(`${b.id}  [${b.ord}] ${render(b.text)}`);
          return;
        }
        if (sub === "on") {
          store.set(ENABLED_KEY, true);
          ctx.print("Playbook injection ON.");
          return;
        }
        if (sub === "off") {
          store.set(ENABLED_KEY, false);
          ctx.print("Playbook injection OFF.");
          return;
        }

        // Mutating sub-commands are vetoed by the hard kill switch (no store write).
        if (killed()) {
          ctx.print(`/playbook ${sub}: playbook is disabled (EAGENT_PLAYBOOK=off).`);
          return;
        }
        switch (sub) {
          case "add": {
            const t = tokens.slice(1).join(" ");
            if (t.length === 0) {
              ctx.print("usage: /playbook add <text>");
              return;
            }
            ctx.print(`Added ${add(t).id}.`);
            return;
          }
          case "merge": {
            const id = tokens[1];
            const delta = tokens.slice(2).join(" ");
            if (id === undefined || delta.length === 0) {
              ctx.print("usage: /playbook merge <id> <text>");
              return;
            }
            ctx.print(merge(id, delta) ? `Merged into ${id}.` : `no bullet with id "${id}".`);
            return;
          }
          case "forget": {
            const id = tokens[1];
            if (id === undefined) {
              ctx.print("usage: /playbook forget <id>");
              return;
            }
            ctx.print(forget(id) ? `Forgot ${id}.` : `no bullet with id "${id}".`);
            return;
          }
          case "clear": {
            ctx.print(`Cleared ${clear()} bullet(s).`);
            return;
          }
          default:
            ctx.print(
              `unknown /playbook sub-command "${sub}"; ` +
                "expected on | off | list | add | merge | forget | clear.",
            );
        }
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
