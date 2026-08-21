/**
 * The transcript model — a pure reducer folding lifecycle events into an ordered
 * list of renderable items.
 *
 * No React, no Ink, no I/O, no clock of its own: time and identity arrive as
 * tagged data, so the whole model is offline-testable the way `src/complete.ts`
 * is. Keeping it pure is what lets the render layer be swapped or re-laid-out
 * without re-deriving *what happened* in a run.
 *
 * Items are append-mostly: a streaming item is mutated in place until it
 * finishes, then never changes again. That is what makes Ink's `<Static>` safe —
 * a finished item can be committed to scrollback and never re-rendered.
 */

export type ItemKind = "user" | "reasoning" | "answer" | "tool" | "notice";
export type ItemStatus = "streaming" | "done" | "error";

interface Base {
  id: string;
  kind: ItemKind;
  status: ItemStatus;
  /** The emitting agent's identity; a sub-agent differs from the root. */
  actingId: string;
  startedAt: number;
  updatedAt: number;
}

export interface TextItem extends Base {
  kind: "user" | "reasoning" | "answer" | "notice";
  text: string;
}

export interface ToolItem extends Base {
  kind: "tool";
  name: string;
  callId: string;
  /** The FULL arguments — the model never elides tool data. */
  arguments: Record<string, unknown>;
  /** Chunks from `tool_progress`, joined for display while the call runs. */
  progress: string;
  result?: { content: string; isError: boolean };
}

export type Item = TextItem | ToolItem;

export interface TranscriptState {
  items: Item[];
  /** True between `agent_start` and `agent_end` — drives the spinner. */
  running: boolean;
  /** Bumps on each `agent_start` so a renderer can detect a fresh run. */
  run: number;
  /** Monotonic id counter, kept in state so the reducer stays pure. */
  seq: number;
  /** Cumulative tokens reported by `usage`, for the status line. */
  tokens: number;
  /** How many leading items are finalised. Monotonic, advanced only at
   *  `agent_end`, so the CURRENT turn stays repaintable while it runs and a
   *  committed item can never return to the live tail. */
  committed: number;
}

export type TranscriptEvent =
  | { kind: "user"; text: string }
  | { kind: "agent_start" }
  | { kind: "reasoning_delta"; text: string }
  | { kind: "text_delta"; text: string }
  | { kind: "tool_start"; callId: string; name: string; arguments: Record<string, unknown> }
  | { kind: "tool_progress"; callId: string; chunk: string }
  | { kind: "tool_end"; callId: string; content: string; isError: boolean }
  | { kind: "notice"; text: string }
  | { kind: "usage"; total: number }
  | { kind: "agent_end"; reason: string };

/** Every event carries who emitted it and when — the reducer invents neither. */
export type Tagged = TranscriptEvent & { actingId: string; at: number };

export function initialState(): TranscriptState {
  return { items: [], running: false, run: 0, seq: 0, tokens: 0, committed: 0 };
}

const isText = (i: Item): i is TextItem => i.kind !== "tool";

/** The last still-streaming text item of `kind` owned by `actingId`. */
function openText(items: Item[], kind: ItemKind, actingId: string): TextItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.status !== "streaming") continue;
    if (it.actingId === actingId && isText(it) && it.kind === kind) return it;
    // A tool card between two text runs closes the earlier one.
    if (it.actingId === actingId) return undefined;
  }
  return undefined;
}

function closeOpenText(items: Item[], actingId: string): void {
  for (const it of items) {
    if (it.status === "streaming" && isText(it) && it.actingId === actingId) it.status = "done";
  }
}

function findTool(items: Item[], callId: string): ToolItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "tool" && it.callId === callId) return it;
  }
  return undefined;
}

/**
 * Fold one event into the state. Returns a NEW state object whose `items` array
 * is new, but whose unchanged items are the same references — so a renderer can
 * compare item identity to decide what needs repainting.
 */
export function reduce(prev: TranscriptState, ev: Tagged): TranscriptState {
  const next: TranscriptState = { ...prev, items: prev.items.slice() };
  const id = (): string => `i${next.seq++}`;

  const pushText = (kind: TextItem["kind"], text: string): void => {
    const open = openText(next.items, kind, ev.actingId);
    if (open) {
      // Mutating the open item in place is deliberate: it is the only item a
      // renderer repaints, and cloning it every delta would defeat the identity
      // comparison that keeps finished items out of the repaint set.
      open.text += text;
      open.updatedAt = ev.at;
      return;
    }
    closeOpenText(next.items, ev.actingId);
    next.items.push({
      id: id(), kind, status: "streaming", actingId: ev.actingId,
      startedAt: ev.at, updatedAt: ev.at, text,
    });
  };

  switch (ev.kind) {
    case "user":
      closeOpenText(next.items, ev.actingId);
      next.items.push({
        id: id(), kind: "user", status: "done", actingId: ev.actingId,
        startedAt: ev.at, updatedAt: ev.at, text: ev.text,
      });
      break;

    case "agent_start":
      next.running = true;
      next.run = prev.run + 1;
      // Everything that existed BEFORE this turn is final. Without this the
      // commit boundary would jump backwards to the previous turn's mark and
      // re-render the intervening items — the user's own prompt included.
      next.committed = next.items.length;
      break;

    case "reasoning_delta":
      pushText("reasoning", ev.text);
      break;

    case "text_delta":
      pushText("answer", ev.text);
      break;

    case "notice":
      closeOpenText(next.items, ev.actingId);
      next.items.push({
        id: id(), kind: "notice", status: "done", actingId: ev.actingId,
        startedAt: ev.at, updatedAt: ev.at, text: ev.text,
      });
      break;

    case "tool_start":
      closeOpenText(next.items, ev.actingId);
      next.items.push({
        id: id(), kind: "tool", status: "streaming", actingId: ev.actingId,
        startedAt: ev.at, updatedAt: ev.at,
        name: ev.name, callId: ev.callId, arguments: ev.arguments, progress: "",
      });
      break;

    case "tool_progress": {
      const card = findTool(next.items, ev.callId);
      if (card) {
        card.progress += ev.chunk;
        card.updatedAt = ev.at;
      }
      break;
    }

    case "tool_end": {
      const card = findTool(next.items, ev.callId);
      if (card) {
        card.status = ev.isError ? "error" : "done";
        card.result = { content: ev.content, isError: ev.isError };
        card.updatedAt = ev.at;
      }
      break;
    }

    case "usage":
      next.tokens = ev.total;
      break;

    case "agent_end":
      for (const it of next.items) if (it.status === "streaming") it.status = "done";
      next.running = false;
      // The turn is over: everything it produced is final and can be written to
      // scrollback once and never touched again.
      next.committed = next.items.length;
      break;
  }

  return next;
}

/**
 * Split the transcript at the boundary Ink's `<Static>` needs. Everything from a
 * COMPLETED turn is committed to scrollback and never repainted; the current turn
 * is the live tail.
 *
 * Committing per TURN rather than per item is deliberate. A card committed the
 * instant it finished could never be expanded again, so a display toggle like
 * Ctrl+O would be unable to affect the work being watched. Keeping the in-flight
 * turn live costs one bounded repaint region and buys that back.
 */
export function partition(state: TranscriptState): { committed: Item[]; live: Item[] } {
  // Idle between turns: everything is final, including a prompt typed but not yet
  // run, so nothing repaints and the session costs nothing to hold open.
  const upto = state.running ? state.committed : state.items.length;
  return { committed: state.items.slice(0, upto), live: state.items.slice(upto) };
}

/** Char-derived token estimate (~4 chars/token). Labelled an estimate on screen. */
export const estTokens = (text: string): number => Math.ceil(text.length / 4);

/** A bounded one-line rendering of a tool call's arguments for its card header. */
export function argSummary(args: Record<string, unknown>, width = 60): string {
  const joined = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : safeJson(v)}`)
    .join(" ")
    .replace(/\s+/g, " ");
  if (joined.length <= width) return joined;
  return Array.from(joined).slice(0, width - 1).join("") + "…";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return typeof v === "bigint" ? `${v}n` : "[unserializable]";
  }
}
