/**
 * WHAT TO UNDO, IN WHAT ORDER, AND WHAT MAY NOT BE UNDONE AT ALL.
 *
 * Compensation edges have been a compile-time feature with no run time since they were
 * designed. `graph/validate.ts` proves a rollback exists — GRAPH012 refuses an edge whose
 * target tool declares no `compensation`, refuses one naming an unregistered undo, and warns
 * when the undo is itself externally visible — and then `Engine.#edgesToTake` had
 * `case "compensation": break;`, so nothing ever traversed one. The single place compensation
 * reached the runtime was a REFUSAL: `Engine.rewind` declines to cross a committed irreversible
 * effect that declares no undo. "We refuse because you have no compensation" is not the feature;
 * "we ran your compensation" is.
 *
 * This file is the half that can be decided without touching the world: given the journal and
 * the tool registry, which recorded calls still need undoing, in which order, and which of them
 * cannot be attempted. The executor half lives in `run/engine.ts`, because running an undo is a
 * tool dispatch and there is exactly one of those.
 *
 * ── ORDER ────────────────────────────────────────────────────────────────────
 * DESCENDING `seq` of `tool.called`: the last thing done is the first undone.
 *
 * That is the only order the journal can justify. `seq` is a total order over the whole run —
 * every branch of every fan-out appends into the same log — so reverse-seq is the exact inverse
 * of the one ordering that was real. The tempting alternative, branch-major (undo branch 2
 * entirely, then branch 1), asserts a happens-before between two branches that by construction
 * never existed: they ran concurrently, and which of them wrote first is a fact only the journal
 * holds. So two branches that both need compensating are INTERLEAVED here, exactly as their
 * calls interleaved going forward. If an author needs branch-major rollback, that is a graph
 * that serialises the branches, not a planner that pretends they were.
 *
 * ── WHAT IS A CANDIDATE ──────────────────────────────────────────────────────
 * A `tool.called` whose `irreversibility` is not `read_only`. `tool.called` is appended AFTER
 * the body returned (a body that threw gets `effect.failed` and no `tool.called` at all), so it
 * is the record that an action really happened — the same reason `Engine.#uncompensatedIrreversible`
 * reads it rather than scanning what a node declared.
 *
 * `ok: false` IS STILL A CANDIDATE, and that is the fail-closed direction. A tool that returned
 * an error result ran its body to completion and may have acted partway; the journal cannot say.
 * Leaving a possible effect standing because the tool was pessimistic about it is the loosening.
 * A redundant undo shows up in the record as an attempt; an un-undone write shows up nowhere.
 *
 * `read_only` is excluded because there is nothing to undo and no honesty gap in saying nothing
 * about it — a plan that emitted a `not_attempted` row per `fs.read` would bury the rows that
 * matter under the rows that do not.
 *
 * ── IDEMPOTENCE ──────────────────────────────────────────────────────────────
 * The journal, not an in-memory flag, is what stops a compensation running twice — a rewind can
 * itself be retried, and a process can die between the undo and its record.
 *
 * `settled` is keyed by the SEQ of the `tool.called` being undone, never by its effect key.
 * The key is positional (`taskId:tool:<ordinal>`) and a rewind-then-redo appends a SECOND
 * `tool.called` at the same key: keying on it would mark the redo's fresh write as already
 * rolled back, which is the failure this whole file exists to prevent — a rollback that looks
 * done. A seq is unique per append and is what `checkpoint.restored.atSeq` is already denominated
 * in, so it survives a restart and a redo both.
 *
 * ── THREE STATES, NOT TWO ────────────────────────────────────────────────────
 * A step whose `undo` is absent carries `blocked` instead, and the executor journals it as
 * `not_attempted` rather than dropping it. "This effect stands and nobody tried to undo it" is a
 * fact an operator needs and is the one a two-state design silently deletes. The three blocking
 * reasons are all fail-closed reads of the registry: a tool the registry no longer carries
 * cannot be SHOWN to compensate, and an undo naming a tool that is not registered cannot run.
 */

import type { JournalEvent } from "../journal/events.ts";
import type { TaskId } from "../ids.ts";

/**
 * The registry, structurally — `ToolRegistry` satisfies it and this module does not import it.
 *
 * A manifest lookup is the whole dependency: the planner asks what undoes a tool, never how to
 * run one. Keeping it structural is what lets the plan be built in a test from a literal.
 */
export interface CompensationLookup {
  get(name: string): { readonly compensation?: { readonly tool: string } } | undefined;
}

/** Why a recorded effect will not be compensated. Every member is a fail-closed registry read. */
export type CompensationBlock =
  /** The tool that ran is no longer registered, so nothing can say what undoes it. */
  | "unknown_tool"
  /** The tool is registered and declares no `compensation`. This is the ordinary case. */
  | "no_compensation"
  /** It declares one, and that tool is not registered. GRAPH012 refuses this at compile;
   *  reaching it here means the registry changed under a run that already committed. */
  | "unknown_compensation";

export interface CompensationStep {
  /** The seq of the `tool.called` being undone. The step's identity — see IDEMPOTENCE above. */
  readonly seq: number;
  /** The effect key of the call being undone, carried for the operator, never for identity. */
  readonly compensates: string;
  /** The task that made the call. Absent only for a journal that recorded none. */
  readonly taskId?: TaskId;
  /** The tool that ran. */
  readonly tool: string;
  readonly irreversibility: string;
  /** Whether the original call reported success. A `false` here is still compensated. */
  readonly ok: boolean;
  /** The tool that undoes it. Absent iff `blocked` is present. */
  readonly undo?: string;
  /** Why nothing will be attempted. Absent iff `undo` is present. */
  readonly blocked?: CompensationBlock;
}

export interface CompensationPlan {
  /** Reverse-seq order: the last thing done is first. */
  readonly steps: readonly CompensationStep[];
  /** Seqs already carrying a compensation record, dropped from `steps` rather than repeated. */
  readonly settled: readonly number[];
}

export interface CompensationInput {
  /** The run's journal, in seq order. */
  readonly events: Iterable<JournalEvent>;
  readonly tools: CompensationLookup;
  /**
   * Only compensate calls that landed after this seq — the rewind boundary.
   *
   * Omitted means the whole run, which is what a run failure rolls back. Scoping matters for
   * the same reason it matters to `Engine.rewind`'s refusal: only effects the operation would
   * actually undo are its business.
   */
  readonly sinceSeq?: number;
}

/**
 * Fold a journal into the rollback it implies.
 *
 * Pure and synchronous, over one pass, appending nothing. That is deliberate: this is the
 * decision an operator has to be able to inspect BEFORE anything runs, and a function that can
 * only be observed by letting it act is not one anybody will trust with an undo.
 */
export function planCompensation(input: CompensationInput): CompensationPlan {
  const since = input.sinceSeq ?? 0;
  const candidates: CompensationStep[] = [];
  const settled = new Set<number>();

  for (const e of input.events) {
    if (e.type === "compensation.recorded") {
      settled.add(e.payload.compensatesSeq);
      continue;
    }
    if (e.type !== "tool.called") continue;
    const p = e.payload;
    if (e.seq <= since) continue;
    if (p.irreversibility === "read_only") continue;

    const manifest = input.tools.get(p.name);
    const undo = manifest?.compensation?.tool;
    const base = {
      seq: e.seq as number,
      compensates: p.key,
      ...(e.taskId === undefined ? {} : { taskId: e.taskId }),
      tool: p.name,
      irreversibility: p.irreversibility,
      ok: p.ok,
    };
    if (manifest === undefined) {
      candidates.push({ ...base, blocked: "unknown_tool" });
    } else if (undo === undefined) {
      candidates.push({ ...base, blocked: "no_compensation" });
    } else if (input.tools.get(undo) === undefined) {
      candidates.push({ ...base, blocked: "unknown_compensation" });
    } else {
      candidates.push({ ...base, undo });
    }
  }

  // Reverse the ORDER OF APPEND, which is `seq`. Sorted rather than reversed in place, because
  // `events` is only promised to be the journal and a caller that hands over a filtered or
  // re-merged iterable (a parent's log spliced with a child's) would otherwise silently get
  // rollback in the order two iterators happened to interleave.
  const steps = candidates.filter((s) => !settled.has(s.seq)).sort((a, b) => b.seq - a.seq);
  return { steps, settled: [...settled].sort((a, b) => a - b) };
}

/**
 * The steps that will actually dispatch a tool — `steps` minus the blocked ones.
 *
 * Named rather than inlined at the call site because the two counts are what a caller reports:
 * "4 effects, 3 rolled back, 1 that nothing can roll back" needs both, and a caller that filters
 * inline reliably reports the first number as the second.
 */
export function attemptable(plan: CompensationPlan): readonly CompensationStep[] {
  return plan.steps.filter((s) => s.undo !== undefined);
}

/**
 * What each block means, in a sentence an operator can act on.
 *
 * A table rather than three string literals at the throw site, because the whole argument for
 * three states is that `not_attempted` carries WHY: "no compensation is declared" is a graph the
 * author can fix, "the tool is gone from the registry" is a deployment that changed under a run
 * that already committed, and a reader who cannot tell them apart has two states again.
 */
export const BLOCK_REASON: Readonly<Record<CompensationBlock, (s: CompensationStep) => string>> = {
  unknown_tool: (s) => `"${s.tool}" is no longer a registered tool, so nothing can say what undoes it`,
  no_compensation: (s) => `"${s.tool}" declares no compensation, so this ${s.irreversibility} effect stands`,
  unknown_compensation: (s) => `"${s.tool}" names a compensation that is not a registered tool`,
};
