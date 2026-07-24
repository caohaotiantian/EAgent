/**
 * The pure view model.
 *
 * A reducer that folds the (attribution-tagged) lifecycle event stream into an
 * ordered list of Sections, plus pure formatting helpers. No ANSI, no I/O, no
 * clock of its own — time and identity enter as tagged data, so the whole thing
 * is offline-testable the way `src/complete.ts` is. The engine plain renderer and
 * the Ink components both fold this same model, so they cannot diverge on
 * ordering, fork de-interleaving, or nesting.
 *
 * Sections discriminate on `kind` (never `type`) so they can never be mistaken
 * for a JSONL machine event — that stream is `src/jsonl.ts`'s alone.
 */

import type { ToolCallBlock, ToolResult, Role, StopReason } from "./kernel/types.js";

export type DisplayMode = "auto" | "full" | "collapsed";
export type SectionStatus = "streaming" | "success" | "error";
export type SectionKind = "reasoning" | "answer" | "tool";

interface SectionCommon {
  id: string;
  kind: SectionKind;
  /** The emitting (leaf) agent's identity — a fork/subagent differs from the root. */
  actingId: string;
  rootId: string;
  status: SectionStatus;
  startTs: number;
  lastTs: number;
  collapsed: boolean;
  /** Nested sub-sections: a spawn card's fork/subagent work lives here. */
  children: Section[];
}
export interface ReasoningSection extends SectionCommon {
  kind: "reasoning";
  text: string;
}
export interface AnswerSection extends SectionCommon {
  kind: "answer";
  text: string;
}
export interface ToolSection extends SectionCommon {
  kind: "tool";
  name: string;
  callId: string;
  /** The FULL, untruncated arguments — the model never elides tool data. */
  arguments: Record<string, unknown>;
  /** The FULL result once the call ends. */
  result?: { content: string; isError: boolean };
  /** True once this card is known to be a spawn parent (a child bound to it, or
   *  its name is a known spawn tool) — used only to disambiguate nesting. */
  spawn: boolean;
}
export type Section = ReasoningSection | AnswerSection | ToolSection;
type TextSection = ReasoningSection | AnswerSection;

export interface ViewModel {
  sections: Section[];
  mode: DisplayMode;
  rootId?: string;
  /** Set when the run's `agent_end` arrives; a renderer commits everything then. */
  done: boolean;
  /** Bumps on each `agent_start`; lets a renderer detect a fresh run and reset. */
  run: number;
  /** Bookkeeping: child actingId → the id of the parent tool card it nests under. */
  bindings: Record<string, string>;
  /** Bookkeeping: monotonic counter backing generated section ids (kept pure). */
  seq: number;
}

export type RenderEvent =
  | { kind: "agent_start" }
  | { kind: "reasoning_delta"; text: string }
  | { kind: "text_delta"; text: string }
  | { kind: "tool_start"; call: ToolCallBlock }
  | { kind: "tool_end"; call: ToolCallBlock; result: ToolResult }
  | { kind: "message"; role: Role; stopReason?: StopReason }
  | { kind: "agent_end"; reason: StopReason };

export type TaggedEvent = RenderEvent & { actingId: string; rootId: string; at: number };

/**
 * A user display control. `mode` re-derives every section's collapse state from
 * the new display mode; `expand`/`collapse` toggle a single top-level section by
 * its 1-based number `n` (matching the `/expand <n>` / `/collapse <n>` commands),
 * leaving the rest untouched. Applied through the pure `applyControl` below.
 */
export type ControlAction =
  | { kind: "mode"; mode: DisplayMode }
  | { kind: "expand"; n: number }
  | { kind: "collapse"; n: number };

/**
 * The spawn-class name fallback. The PRIMARY nesting signal is identity-driven
 * and needs no name (a child binds to the sole open tool card); this set is used
 * only to disambiguate the rare case of two cards open at once — one of them a
 * leaf tool like `bash` — which the pure ALS seams cannot otherwise resolve.
 * KDD10 sanctions a name allowlist strictly as that fallback.
 */
const SPAWN_TOOLS: ReadonlySet<string> = new Set([
  "best_of_n",
  "tree_search",
  "graph_search",
  "spawn_agent",
  "launch_job",
  "run_workflow",
  "sweep_edit",
  "spawn_template",
]);

const isSpawnName = (name: string): boolean => SPAWN_TOOLS.has(name);

export function initialModel(mode: DisplayMode = "auto"): ViewModel {
  return { sections: [], mode, rootId: undefined, done: false, run: 0, bindings: {}, seq: 0 };
}

export function reduce(prev: ViewModel, ev: TaggedEvent): ViewModel {
  if (ev.kind === "agent_start") {
    // Only the root emits agent_start (forks suppress it), so a run resets here.
    return { ...initialModel(prev.mode), rootId: ev.rootId, run: prev.run + 1 };
  }

  const m: ViewModel = structuredClone(prev);
  if (m.rootId === undefined) m.rootId = ev.rootId;
  const isChild = ev.actingId !== ev.rootId;

  switch (ev.kind) {
    case "reasoning_delta":
    case "text_delta": {
      const kind: SectionKind = ev.kind === "reasoning_delta" ? "reasoning" : "answer";
      const container = isChild ? childContainer(m, ev) : m.sections;
      appendText(m, container, kind, ev);
      break;
    }
    case "tool_start": {
      const container = isChild ? childContainer(m, ev) : m.sections;
      finalizeText(container, ev.actingId);
      container.push({
        id: nextId(m),
        kind: "tool",
        actingId: ev.actingId,
        rootId: ev.rootId,
        status: "streaming",
        startTs: ev.at,
        lastTs: ev.at,
        collapsed: false,
        children: [],
        name: ev.call.name,
        callId: ev.call.id,
        arguments: ev.call.arguments,
        spawn: isSpawnName(ev.call.name),
      });
      break;
    }
    case "tool_end": {
      const card = findCardByCallId(m.sections, ev.call.id);
      if (card) {
        card.status = ev.result.isError ? "error" : "success";
        card.result = { content: ev.result.content, isError: ev.result.isError ?? false };
        card.lastTs = ev.at;
        finalizeText(card.children, undefined);
      }
      break;
    }
    case "message": {
      if (ev.role === "assistant") {
        const container = isChild ? existingChildContainer(m, ev.actingId) ?? m.sections : m.sections;
        finalizeText(container, ev.actingId);
      }
      break;
    }
    case "agent_end": {
      finalizeAll(m.sections);
      m.done = true;
      break;
    }
  }

  return applyCollapse(m);
}

/**
 * Apply a user display control, returning a new model (pure — the input is never
 * mutated). `mode` re-derives collapse from the display mode; `expand`/`collapse`
 * flip exactly the addressed section's `collapsed` flag and leave the rest as they
 * are. An out-of-range section number is a no-op, never a throw.
 */
export function applyControl(prev: ViewModel, action: ControlAction): ViewModel {
  const m: ViewModel = structuredClone(prev);
  switch (action.kind) {
    case "mode":
      m.mode = action.mode;
      return applyCollapse(m);
    case "expand":
    case "collapse": {
      const s = m.sections[action.n - 1];
      if (s) s.collapsed = action.kind === "collapse";
      return m;
    }
  }
}

// -- reducer internals ------------------------------------------------------

function nextId(m: ViewModel): string {
  return "s" + m.seq++;
}

const isTextSection = (s: Section): s is TextSection => s.kind === "reasoning" || s.kind === "answer";

/** The last streaming reasoning/answer section owned by `actingId` in `container`. */
function ownStreamingText(container: Section[], actingId: string): TextSection | undefined {
  for (let i = container.length - 1; i >= 0; i--) {
    const s = container[i]!;
    if (s.actingId === actingId && s.status === "streaming" && isTextSection(s)) return s;
  }
  return undefined;
}

/** Commit `actingId`'s streaming text sections (or everyone's when undefined). */
function finalizeText(container: Section[], actingId: string | undefined): void {
  for (const s of container) {
    if ((actingId === undefined || s.actingId === actingId) && s.status === "streaming" && isTextSection(s)) {
      s.status = "success";
    }
  }
}

function appendText(m: ViewModel, container: Section[], kind: SectionKind, ev: TaggedEvent & { kind: "reasoning_delta" | "text_delta" }): void {
  const cur = ownStreamingText(container, ev.actingId);
  if (cur && cur.kind === kind) {
    cur.text += ev.text;
    cur.lastTs = ev.at;
    return;
  }
  // A different kind is starting — commit the prior one, open a fresh section.
  finalizeText(container, ev.actingId);
  container.push({
    id: nextId(m),
    kind: kind === "reasoning" ? "reasoning" : "answer",
    actingId: ev.actingId,
    rootId: ev.rootId,
    status: "streaming",
    startTs: ev.at,
    lastTs: ev.at,
    collapsed: false,
    children: [],
    text: ev.text,
  } as TextSection);
}

/** Resolve (and, on first sight, bind) the container a child's sections nest in. */
function childContainer(m: ViewModel, ev: TaggedEvent): Section[] {
  let cardId = m.bindings[ev.actingId];
  if (cardId === undefined) {
    const parent = pickParent(m);
    if (!parent) return m.sections; // no open card → graceful top-level fallback (R6)
    parent.spawn = true;
    cardId = parent.id;
    m.bindings[ev.actingId] = cardId;
  }
  const card = findCardById(m.sections, cardId);
  return card ? card.children : m.sections;
}

/** The child's already-bound container, or undefined if it was never bound. */
function existingChildContainer(m: ViewModel, actingId: string): Section[] | undefined {
  const cardId = m.bindings[actingId];
  if (cardId === undefined) return undefined;
  return findCardById(m.sections, cardId)?.children;
}

/**
 * KDD10 drift-proof classifier. Primary signal: the sole open (streaming)
 * top-level tool card — needs no name. Fallback for ≥2 open cards: narrow to
 * spawn-class names (so a child never binds to a concurrent leaf `bash`), then
 * take the most-recently-opened (deterministic; the rare ≥2-spawn case is the
 * documented cosmetic limitation).
 */
function pickParent(m: ViewModel): ToolSection | undefined {
  const open = m.sections.filter((s): s is ToolSection => s.kind === "tool" && s.status === "streaming");
  if (open.length === 0) return undefined;
  if (open.length === 1) return open[0];
  const spawnish = open.filter((c) => c.spawn || isSpawnName(c.name));
  const pool = spawnish.length > 0 ? spawnish : open;
  return pool[pool.length - 1];
}

function findCardById(sections: Section[], id: string): ToolSection | undefined {
  for (const s of sections) {
    if (s.kind === "tool" && s.id === id) return s;
    const nested = findCardById(s.children, id);
    if (nested) return nested;
  }
  return undefined;
}

function findCardByCallId(sections: Section[], callId: string): ToolSection | undefined {
  for (const s of sections) {
    if (s.kind === "tool" && s.callId === callId) return s;
    const nested = findCardByCallId(s.children, callId);
    if (nested) return nested;
  }
  return undefined;
}

function finalizeAll(sections: Section[]): void {
  for (const s of sections) {
    if (s.status === "streaming") s.status = "success";
    finalizeAll(s.children);
  }
}

/**
 * The auto-collapsed default: only the newest top-level section stays expanded;
 * a previous one collapses once the next begins. `full` expands all, `collapsed`
 * shows headers only.
 */
function applyCollapse(m: ViewModel): ViewModel {
  const n = m.sections.length;
  m.sections.forEach((s, i) => {
    s.collapsed = m.mode === "full" ? false : m.mode === "collapsed" ? true : i !== n - 1;
    setDescendantsCollapsed(s.children, m.mode === "collapsed");
  });
  return m;
}

function setDescendantsCollapsed(sections: Section[], collapsed: boolean): void {
  for (const s of sections) {
    s.collapsed = collapsed;
    setDescendantsCollapsed(s.children, collapsed);
  }
}

// -- pure formatting helpers ------------------------------------------------

/** Char-derived token estimate (~4 chars/token). Labelled an estimate in docs. */
export function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Width bound for the collapsed tool-card arg summary — the ONLY display elision. */
export const SUMMARY_WIDTH = 80;

function elapsed(s: Section): string {
  return ((s.lastTs - s.startTs) / 1000).toFixed(1);
}

function argSummary(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const joined = entries.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
  const clipped = joined.length > SUMMARY_WIDTH ? joined.slice(0, SUMMARY_WIDTH - 1) + "…" : joined;
  return " " + clipped;
}

/** A single header line for a section (collapsed representation). */
export function headerLine(s: Section): string {
  if (s.kind === "reasoning") return `◆ Reasoning · ${estTokens(s.text)} tok · ${elapsed(s)}s`;
  if (s.kind === "answer") return `◆ Answer · ${estTokens(s.text)} tok · ${elapsed(s)}s`;
  const mark = s.status === "error" ? "✗" : s.status === "success" ? "✓" : "…";
  return `→ ${s.name}${argSummary(s.arguments)} ${mark} ${elapsed(s)}s`;
}

/** The full, untruncated body of a section (for full mode / expand). */
export function bodyLines(s: Section): string[] {
  if (s.kind === "reasoning" || s.kind === "answer") return s.text.split("\n");
  const out = [`args: ${JSON.stringify(s.arguments)}`];
  if (s.result) out.push(...s.result.content.split("\n"));
  return out;
}
