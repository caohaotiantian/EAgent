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
 * `compensation.recorded` IS READ WITHOUT SUPPRESSION, unlike every effect record. A rewind runs
 * its rollback BEFORE appending its marker — it has to, because the marker is what hides the
 * `effect.completed` rows the undo arguments come from — so the records land inside the range
 * `(atSeq, marker)` that the marker then suppresses. A suppression-aware read of them would
 * report a rollback that already happened as never having happened, and the next pass would run
 * every undo a second time. A record of an undo is not a thing to be undone.
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
/**
 * The `kind` segment of `${taskId}:${kind}:${ordinal}`, read from the RIGHT.
 *
 * The same shape `journal/audit.ts` reads, and for the same reason: a taskId cannot contain a
 * colon (`graph/validate.ts` raises GRAPH003_BAD_ID for one in a node id, and a branch path is
 * `root/e0[0]`), so the last two segments are the kind and the ordinal whatever the id does.
 */
function kindOfKey(key: string): string | undefined {
  const parts = key.split(":");
  return parts.length < 3 ? undefined : parts[parts.length - 2];
}

export function planCompensation(input: CompensationInput): CompensationPlan {
  const since = input.sinceSeq ?? 0;
  const candidates: CompensationStep[] = [];
  const settled = new Set<number>();

  for (const e of input.events) {
    if (e.type === "compensation.recorded") {
      // OUTCOME-AWARE, because `not_attempted` is not one thing. `compensated` and a
      // `not_attempted` whose reason is STRUCTURAL — no compensation declared, an unregistered
      // tool — will read the same on every future pass, so settling them is right and re-planning
      // them would loop. But `not_attempted` is also written when the block is TRANSIENT: a child
      // run whose graph could not be rebuilt in this process, whose own reason string tells the
      // operator to "attach it and rewind". Settling that seq made the advice impossible —
      // measured, planning over the child journal after such a row gave
      // `steps= 0  settled= [8]`, so the operator who did exactly what the row said got a
      // zero-step plan and an effect that still stands.
      //
      // `retryable` is the discriminant and it is written at the append rather than inferred
      // here, so this fold does not have to parse a reason string. Absent means NOT retryable,
      // which is the fail-closed reading for every row written before the field existed: those
      // settle exactly as they always did.
      if (e.payload.retryable !== true) settled.add(e.payload.compensatesSeq);
      continue;
    }
    if (e.type !== "tool.called") continue;
    const p = e.payload;
    if (e.seq <= since) continue;
    if (p.irreversibility === "read_only") continue;
    // AN UNDO IS NOT A CANDIDATE FOR BEING UNDONE. A compensation dispatch appends its own
    // `tool.called`, and the undo tool is irreversible about as often as the tool it reverses —
    // so a plan built over the whole journal listed the rollback's own steps as things to roll
    // back. It does not bite on the first pass, where the undo lands after the plan was built;
    // it bites on a RESUMED rollback, where a crash between two steps means the next
    // `planCompensation` reads a journal that already contains them. Reproduced by this lane's
    // reviewer with a store that throws right after the first `compensation.recorded` lands.
    //
    // Keyed on the EFFECT KIND, not the tool name: `effectKey(taskId, "compensate", n)` is what
    // `#invokeTool` writes for this path and nothing else writes it, whereas a tool name can
    // legitimately appear on both sides — the same `fs.delete` may be somebody's action and
    // somebody else's undo.
    if (kindOfKey(p.key) === "compensate") continue;

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

/**
 * ── THE PREVIEW AN OPERATOR AUTHORIZES ───────────────────────────────────────
 *
 * A `CompensationStep` is one journal's answer. A REWIND's answer spans a TREE of journals, and
 * that difference is the whole reason these types exist rather than `readonly CompensationStep[]`
 * being handed back as-is.
 *
 * `Engine.rewind` used to compute its preview as `planCompensation` over the rewound run's OWN
 * events, and the thing it dispatches is a walk that splices each child run's plan into the
 * parent's at the parent's `subgraph.started` seq. Those are two different computations, and the
 * gap is not theoretical: measured on `rewind-through-subgraph`'s delegated leg, the parent-only
 * plan had ZERO steps while the rewind dispatched a `pay.refund` in the child. A preview built on
 * the first would show "nothing to undo" over a charge that was about to be reversed — the
 * loudest possible version of the silence `b90b137`'s fifth decision forbids.
 *
 * So a step here carries `runId`: WHICH journal it will be recorded in is the one fact an
 * operator cannot guess, and it is the same fact `Engine.rewind`'s child-run refusal already
 * names in its message.
 *
 * These live in this file rather than `engine.ts` because this file is where the rollback is
 * DECIDED and `engine.ts` is where it is PERFORMED — the split this module's header states — and
 * because `run/compensation.ts` is not re-exported by `src/index.ts`, so naming them costs the
 * pinned public surface nothing.
 */
export interface RewindPlanStep {
  /** The journal this step's `compensation.recorded` will land in — the parent, or a child run. */
  readonly runId: string;
  /** `CompensationStep.seq`: the seq of the `tool.called` being undone. Its identity. */
  readonly seq: number;
  readonly compensates: string;
  readonly tool: string;
  readonly irreversibility: string;
  readonly ok: boolean;
  /** The tool that undoes it. Absent iff `blocked` is present. */
  readonly undo?: string;
  /** Why nothing will be attempted at all. Absent iff `undo` is present. */
  readonly blocked?: CompensationBlock;
  /**
   * A digest of the arguments the undo would be called with.
   *
   * WHY THE PLAN IS NOT BOUND WITHOUT IT. An undo's arguments are not in the step: they are the
   * compensated call's recorded `details`, read through a suppression-aware scan at dispatch
   * time. So two plans naming the same `tool -> undo` at the same seq can dispatch DIFFERENT
   * undos, and a hash over the tool names alone would call them equal. Absent when no live
   * `effect.completed` is recorded, which is exactly the case `#compensateOne` answers
   * `not_attempted`.
   */
  readonly argsDigest?: string;
  /**
   * Why THIS ENGINE cannot dispatch this step now. Absent iff it can.
   *
   * The third state, and the one a two-answer preview deletes. "Nothing to undo" and "an effect
   * stands and nobody will try" must not read the same, which is the rule the executor already
   * lives on for its records and the preview now lives on too.
   */
  readonly undispatchable?: string;
}

/** What a rewind would undo, in dispatch order, with the hash that binds it. */
export interface RewindPlan {
  readonly runId: string;
  readonly atSeq: number;
  /** Reverse order of what happened, across the whole run tree. The dispatch order. */
  readonly steps: readonly RewindPlanStep[];
  /**
   * Steps this engine will ATTEMPT an undo tool for — **not** steps whose undo is certain to run.
   *
   * THE DISTINCTION IS NOT PEDANTRY, and getting it wrong is how this preview over-promises in
   * exactly the direction it exists to prevent. `#compensateOne` dispatches through `#invokeTool`
   * with `nodeApproved: false`, always — a rollback is not a human's yes to anything, the human
   * approved the action being UNDONE — so `PolicyEngine.decide` can still answer `gate`, and that
   * answer is a refusal journaled `compensation.recorded{outcome: "failed"}`. Measured on both
   * legs of `rewind-plan.test.ts`'s own fixture: `dispatch=1`, `refunds=[]`, outcome `failed`,
   * *"pay.refund is reversible_write and requires human approval this turn cannot request"*.
   *
   * WHY THIS IS NOT PREDICTED HERE, which is a choice rather than an omission. The refusal
   * depends on `effectivePosture` — the run's ceiling and taint as well as the undo's class — so
   * a class-based guess would be wrong in both directions, and the fixture above is the proof: a
   * `reversible_write` undo gated. A preview that guessed would sometimes say "will not run"
   * about an undo that runs, which is worse than a number that names what it means.
   *
   * So an operator reads this as "this many will be tried", and the outcome of each is on the
   * journal afterwards as `compensated` / `failed` / `not_attempted`. Nothing is silent; the
   * count is simply upstream of the policy decision rather than downstream of it.
   */
  readonly dispatch: number;
  /** Steps nothing will attempt, for either reason — `blocked` or `undispatchable`. */
  readonly blocked: number;
  /** Whether this engine holds a context for the run at all. Part of what `planHash` covers. */
  readonly attached: boolean;
  /** `digest` of `{runId, atSeq, attached, steps}`. What `rewind` refuses a mismatch of. */
  readonly planHash: string;
}

/**
 * The operator's answer to a `RewindPlan`, and the reason it is an OBJECT.
 *
 * `Engine.rewind`'s arity moved once already this session (A.34 gave it a mandatory `by`). A
 * fifth positional would move it a second time and a sixth would move it a third; a named field
 * on one parameter costs the next addition nothing. It is required and has no default for the
 * same reason `by` has none: a default is how the last floor came to be checked nowhere.
 */
export interface RewindAuthorization {
  /** The `planHash` of the plan the operator was shown. */
  readonly planHash: string;
}
