/**
 * The single authorization decision point.
 *
 * Two properties matter more than anything else here:
 *
 *   1. **Fail closed.** An unavailable policy store, an unknown capability, or an
 *      unrecognised irreversibility class all deny, and posture defaults to `in`.
 *      There is no code path that reaches "allow" by omission.
 *
 *   2. **Reservation, not check-then-act.** The obvious budget implementation —
 *      "is there room? then spend" — is wrong under fan-out: 25 branches each check
 *      against the same remaining balance and all 25 pass before the first
 *      settlement lands. `reserve` debits the worst case up front and `settle`
 *      returns the difference.
 *
 * Every decision records the rules that fired. An audit that cannot say *why* is not
 * an audit.
 *
 */

import { CODES, err, type LoomError } from "../errors.ts";
import type { NodeId, RunId, TaskId } from "../ids.ts";
import {
  type UsageRecord,
  CLASSIFICATION_POSTURE_FLOOR,
  CLASS_DEFAULT_POSTURE,
  isLoosening,
  maxClassification,
  maxPosture,
  postureRank,
  type Classification,
  type IrreversibilityClass,
  type Posture,
} from "../vocab.ts";

export interface PolicyRequest {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly taskId?: TaskId;
  readonly kind: "node" | "tool";
  readonly irreversibility: IrreversibilityClass;
  readonly capabilities: readonly string[];
  /** The compile-time effective posture for this node (already max-folded). */
  readonly declaredPosture: Posture;
  readonly dataClassification?: readonly Classification[];
  /** True when any channel this action reads was written from untrusted tool output. */
  readonly tainted?: boolean;
  /**
   * True when a channel this action reads carries secret data it was not DECLARED to hold.
   *
   * Separate from `dataClassification` on purpose, and the difference is what a human could see.
   * A declared `secret_ref` is written in the graph they de-escalated, so their judgement covered
   * it and the ceiling may lower it. A secret that arrived through an ordinary node — a
   * normalizer copying it into an `internal` channel — was not visible to them, so it raises the
   * hard floor exactly as taint does.
   */
  readonly carriesSecret?: boolean;
}

export type PolicyDecision =
  | {
      readonly effect: "allow";
      readonly posture: "out" | "on";
      readonly reasons: readonly string[];
      /**
       * How long to hold before the action runs, so an on-the-loop supervisor has a
       * bounded window to interrupt. Zero for everything except hard-to-undo actions
       * at posture `on`.
       */
      readonly holdMs: number;
    }
  | { readonly effect: "gate"; readonly posture: "in"; readonly reasons: readonly string[] }
  | { readonly effect: "deny"; readonly error: LoomError; readonly reasons: readonly string[] };

export interface Reservation {
  readonly id: string;
  readonly scope: string;
  readonly amountUsd: number;
  /**
   * OPTIONAL, because a hand-built `Reservation` is a shape callers already construct
   * (`test/run/budget.test.ts` settles one that was never reserved, to prove that is a
   * no-op). Absent reads as zero, so an old caller reserves no tokens and settles the
   * real ones — the direction that tightens.
   */
  readonly amountTokens?: number;
}

export interface BudgetLimits {
  /**
   * Per run. `undefined` means unbounded, which the compiler warns about.
   *
   * `loom serve --budget-usd` is the deployment's value for it, and `Engine.submit` folds it
   * by MIN against the graph's own `policy.budget.costUsd` and against `loom run --budget`, so
   * a graph may lower an operator's ceiling and can never raise it.
   */
  readonly runUsd?: number;
  // `tenantUsd` WAS HERE and is deleted. Nothing ever read it and nothing ever wrote it —
  // `reserve`, `settle`, `spentFor` and `#budget` are all keyed on the run — so it was a
  // ceiling the type advertised and no code enforced. It was waiting on the same question
  // `TenantId` was, and that question is answered: one machine, one tenant.
  /**
   * `inputTokens + outputTokens` per run, folded from the journal exactly as dollars are.
   * `cacheReadTokens`, `cacheWriteTokens` and `reasoningTokens` are deliberately NOT in the
   * sum: `UsageRecord` documents the first two as disjoint from `inputTokens` and the third
   * as a SUBSET of `outputTokens`, so adding them would either double-count or invent
   * tokens, and a ceiling that counts a token twice refuses work that fit.
   */
  readonly runTokens?: number;
  /**
   * PROVIDER TIME PER RUN, not elapsed time. See `settle` for what that costs and why the
   * other reading was refused.
   */
  readonly runWallMs?: number;
}

/** The units a ceiling can be expressed in — `graph/spec.ts`'s `POLICY_FIELDS.budget`. */
type BudgetDimension = "costUsd" | "tokens" | "wallMs";

export interface PolicyEngineOptions {
  /** Capability patterns the tenant holds. Trailing `*` is a prefix wildcard. */
  readonly granted: readonly string[];
  /** Deny beats allow, always. */
  readonly denied?: readonly string[];
  /**
   * Deny-lists the ENGINE holds, keyed by actor id.
   *
   * `PolicyActor.denied` is carried on the object being authorized, which makes it an
   * assertion the SUBJECT gets to make about itself. `deescalate` used to ask exactly
   * that field whether the caller was denied `oversight:loosen`, so an actor that simply
   * omitted `denied` was on no deny-list at all — on the one path invariant 5 permits a
   * posture to drop, the guard was answerable by the thing it guards.
   *
   * Entries here are UNIONED with `EVOLUTION_ACTOR`'s own list and with whatever the
   * actor object carries. Deny beats allow in every direction, so supplying this map can
   * only ever add denials; passing `{"evolution-engine": []}` does not un-deny it.
   */
  readonly deniedActors?: Readonly<Record<string, readonly string[]>>;
  /**
   * The system-wide posture floor. Defaults to `on`.
   *
   * `on` is very nearly free — the intervention window for `read_only` is 0 ms, so
   * pure reads pay nothing — and it buys the thing that is expensive to add later:
   * every action is in the supervisor's stream and carries an interruption window
   * before it commits. `out` is not unsafe (irreversibility classes do the real
   * work); it just leaves no lever between "fully automatic" and "blocking gate".
   */
  readonly systemFloor?: Posture;
  readonly budget?: BudgetLimits;
  /**
   * The interruption window per irreversibility class, applied only at posture `on`.
   *
   * DEVIATION from D7.10's table, deliberate: `reversible_write` defaults to 0, not
   * 2000 ms. A hold on an action Loom can undo is pure latency for no recoverable
   * benefit — and holds that fire constantly are holds operators learn to ignore,
   * which costs exactly the interruptions the mechanism exists to enable.
   */
  readonly interventionWindowMs?: Partial<Record<IrreversibilityClass, number>>;
  /** Escalation rules armed for this run. See D7.7 E1–E10 (E11 is declared there and not built). */
  /**
   * THE GRAPH'S OWN ALLOWLIST — a ceiling, not a request.
   *
   * `design/loom/02-EXECUTION-GRAPH.md (deleted at f975f9f)` specifies `capabilities: [string]  # allowlist; intersected with
   * system + tenant (never widened)`. The code checked it UPWARD against the tenant and
   * downward against nothing, so `policy: { capabilities: [] }` was not a restriction: measured,
   * a graph declaring the empty list ran `pay.charge` to completion because the TENANT held
   * `pay`. An author writing `[]` reads it as "this graph needs nothing" and got one that can
   * move money.
   *
   * A SECOND LIST rather than an intersection of patterns, because `granted` may be `["*"]` and
   * the allowlist `["pay"]`, and there is no single pattern list that means "matches both" for
   * every input. Requiring both is exactly the rule the design states and needs no arithmetic.
   *
   * `undefined` means the graph declared none, which is not the same as declaring `[]` — the
   * first is "no ceiling", the second is "nothing". `exactOptionalPropertyTypes` keeps them
   * distinguishable all the way down.
   */
  readonly allowlist?: readonly string[] | undefined;
  readonly onEscalate?: (
    rule: string,
    from: Posture,
    to: Posture,
    scope: string,
    detail?: Record<string, unknown>,
  ) => void;
}

/**
 * An authorization identity, distinct from the journal's `Actor` (which records who
 * caused a fact). `denied` is a hard deny-list, not merely an absent grant.
 */
export interface PolicyActor {
  readonly kind: "system" | "human" | "agent" | "evolution";
  readonly id: string;
  readonly denied?: readonly string[];
}

/**
 * The evolution engine's identity. Deny-listed rather than un-granted, because
 * "forgot to grant" and "must never have" are different facts and only the second
 * survives someone helpfully widening a grant later.
 */
export const EVOLUTION_ACTOR: PolicyActor = {
  kind: "evolution",
  id: "evolution-engine",
  denied: ["oversight:loosen", "resource:promote(stable)", "policy:write", "graph:mutate(policy)"],
};

/** The capability `deescalate` spends. Named once so the three deny-lists agree on it. */
const LOOSEN = "oversight:loosen";

/**
 * The deny-lists the engine keeps, seeded so the built-in one cannot be dropped.
 *
 * `EVOLUTION_ACTOR` is the identity the codebase already declares must never loosen, and
 * it is the source of truth for what it is denied — copying its list here rather than
 * restating it keeps one declaration. Supplied entries are appended, never substituted.
 */
function engineDenyLists(
  supplied: Readonly<Record<string, readonly string[]>> | undefined,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>([[EVOLUTION_ACTOR.id, EVOLUTION_ACTOR.denied ?? []]]);
  for (const [id, caps] of Object.entries(supplied ?? {})) out.set(id, [...(out.get(id) ?? []), ...caps]);
  return out;
}

const DEFAULT_WINDOWS: Readonly<Record<IrreversibilityClass, number>> = {
  read_only: 0,
  reversible_write: 0,
  irreversible: 5000,
  externally_visible: 5000,
};

/**
 * What `setTimeout` can actually hold. Duplicated from `run/delivery.ts` and `cli.ts` for
 * the reason their copies give: exporting it would put a platform fact on the pinned
 * public surface.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Which classes a human may NOT de-escalate to `out`, and the E8 guard — READ AS A DENY-LIST
 * OVER THE TWO UNDOABLE CLASSES, never as an allow-list over the hard ones.
 *
 * It was `c === "irreversible" || c === "externally_visible"`: an allow-list read in the
 * negative, so every word outside the union answered `false` and skipped the hard floor.
 * Measured, systemFloor `out`, one human de-escalation of the run scope to `out`:
 *
 *     irreversible        floor=in → on    (held)
 *     externally_visible  floor=in → on    (held)
 *     nuclear             floor=in → OUT   effect=allow
 *     IRREVERSIBLE        floor=in → OUT   effect=allow
 *
 * A sibling change floors an unreadable class at `in` through `maxPosture`, so the FLOOR was
 * right — and then the ceiling walked straight past it, because the guard that stops a human
 * lowering a dangerous action below `on` did not recognise the word. **A typo'd or hostile
 * class was strictly LESS protected than a correctly spelled one**, which inverts the rule:
 * refusing is always allowed, loosening never is, and a guard that cannot decide fails closed.
 *
 * The two members named here are exactly the two `CLASS_DEFAULT_POSTURE` puts below `in`, and
 * naming them costs an edit only when someone adds a new EASY-to-undo class — a deliberate,
 * visible loosening. A new hard one needs no edit at all. Rejecting the unknown class outright
 * was considered and refused for the reason `postureRank` gives: these values arrive from the
 * append-only journal, and one bad event that throws poisons every later fold of that run.
 *
 * Five more sites still spell the pair out longhand (`graph/mutate.ts`, twice in
 * `graph/validate.ts`, `telemetry/spans.ts`, `run/engine.ts`); they are not converted because
 * `graph/` importing from `run/` inverts the layering, and that is the worse trade. They carry
 * the same inversion and are worth the same fix in their own layer.
 */
export function isHardToUndo(c: IrreversibilityClass): boolean {
  return c !== "read_only" && c !== "reversible_write";
}

/**
 * The interruption window, refused rather than clamped — and refused in BOTH directions,
 * because the two wrong answers fail differently and both are silent.
 *
 * `decide` returns `holdMs` from this map, `Engine` awaits `#sleep(holdMs)` → `setTimeout`,
 * and the same number is journaled verbatim as `action.pending`'s `windowMs`. `setTimeout`
 * keeps its delay in a 32-bit signed integer and TRUNCATES anything larger — it does not
 * saturate and it does not throw. Measured on node v24.16.0:
 *
 *     new PolicyEngine({…, interventionWindowMs: {reversible_write: 2 ** 31}}).decide(…)
 *       → {effect: "allow", posture: "on", holdMs: 2147483648}
 *
 * — slept as ONE MILLISECOND and journaled as 24.8 days. **The interruption window an
 * operator was given to hit stop is a millisecond, while the audit trail records that they
 * had most of a month.** That is "looks supervised, is not" written into the journal, which
 * is the exact failure the oversight layer exists to prevent.
 *
 * The other direction is quieter and is why a clamp would not do: `NaN`, `Infinity` and
 * every negative make `holdMs > 0` FALSE, so no `action.pending` is written at all — a
 * config typo of `-1` turns the window off with nothing in the journal to show one was ever
 * declared. A clamp would silently pick a number the operator did not choose; a refusal
 * makes an unstartable process out of what would otherwise be an unsupervised one.
 *
 * At CONSTRUCTION, like every other member of this family. `Engine` validates the same
 * options where it stores `#policyOpts`, because `PolicyEngine` is built lazily per run —
 * otherwise this throw first surfaces from inside `submit`.
 */
function boundedWindows(
  supplied: Partial<Record<IrreversibilityClass, number>> | undefined,
): Readonly<Record<IrreversibilityClass, number>> {
  if (supplied === undefined) return DEFAULT_WINDOWS;
  for (const [cls, ms] of Object.entries(supplied)) {
    if (ms === undefined) continue;
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > MAX_TIMER_MS) {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `interventionWindowMs.${cls} is ${String(ms)}, which is not a whole number of milliseconds a timer can hold ` +
          `(0…${MAX_TIMER_MS}). It is both slept on and journaled as the window an operator had to intervene, ` +
          `so a value a timer truncates would record supervision that did not happen`,
        { details: { class: cls, windowMs: ms, max: MAX_TIMER_MS } },
      );
    }
  }
  // KEY BY KEY, NOT `{...DEFAULT_WINDOWS, ...supplied}`. Spread copies a key that is
  // PRESENT, whatever it holds, so `{irreversible: undefined}` DELETED the default it was
  // merged over and left a hole in the stored table. Nothing in this tree supplies this
  // option — it arrives from an embedder's `EngineOptions.policy`, i.e. the surface a
  // stranger writes against — and the ordinary way to build one, `{irreversible: cfg.window}`
  // with `cfg.window` unset, is exactly the shape that produces the hole. The loop above
  // waved it through, correctly: `if (ms === undefined) continue` says an UNSET key is not a
  // bad value, and it is not. It only has to stay unset. Every read below assumes this map is
  // total over the union; this is what makes that true.
  const out: Record<string, number> = { ...DEFAULT_WINDOWS };
  for (const [cls, ms] of Object.entries(supplied)) {
    if (typeof ms === "number" && Number.isFinite(ms)) out[cls] = ms;
  }
  return out as Record<IrreversibilityClass, number>;
}

/**
 * The window for a class, WITHOUT the table lookup's `undefined`.
 *
 * The same allow-list-in-the-negative shape `isHardToUndo` had, ten lines further down:
 * `#windows[req.irreversibility]` is a plain lookup and a class outside the union yields
 * `undefined`. It only became reachable once the hard floor started holding an unreadable
 * class at `on` — and `on` is the one posture that reads a window. Measured with the fix
 * above but not this one, `nuclear` de-escalated to `out`:
 *
 *     {effect: "allow", posture: "on", holdMs: undefined}
 *
 * `holdMs > 0` is false, and `Engine` writes `action.pending`, sleeps, and re-checks the abort
 * signal ONLY inside that test (`run/engine.ts:2563` and `:4248` — the sleep and the abort check
 * are both in the body of the `if`). So a window that is not a positive number does not hold, is
 * not journaled, and cannot be interrupted: the action starts immediately and the only place the
 * operator's declared window still exists is the config they wrote it in. That is the same
 * failure `boundedWindows` refuses a truncating timer for — supervision believed, not given —
 * arriving through the one class the vocabulary cannot read.
 *
 * An unreadable class is hard-to-undo everywhere else now, so it takes the STRICTEST window
 * any hard-to-undo class carries rather than a constant, which keeps an operator who widened
 * `irreversible` from being narrowed behind their back.
 *
 * AND THE FALLBACK IS FOLDED OVER NUMBERS ONLY, because `Math.max(0, ...hard)` is `NaN` if a
 * SINGLE element is `undefined` — one hole in the table poisoned the answer for every class
 * that fell back, not just for the class that was missing. Measured, systemFloor `out`, one
 * human de-escalation of the run scope to `out`, `interventionWindowMs: {irreversible: undefined}`:
 *
 *     irreversible        allow  on  holdMs='NaN'   holds=false
 *     externally_visible  allow  on  holdMs='5000'  holds=true
 *     nuclear             allow  on  holdMs='NaN'   holds=false
 *
 * `NaN > 0` is false — the same false that `undefined > 0` gives — so the fix for the
 * unreadable class handed back exactly the failure it was written to close, and took
 * `irreversible` itself down with it. `boundedWindows` now keeps the stored table total, so
 * that input cannot arise through the constructor; this filter is what makes the property
 * hold for a table reaching here any other way, and it is the read that must not fail open.
 *
 * WITH NOTHING FINITE LEFT, the strictest hard window in `DEFAULT_WINDOWS` — not
 * `Math.max(0)`. An empty fold answering `0` is a window that does not hold either; the
 * only difference from `NaN` is that it looks deliberate in the journal.
 */
function windowFor(windows: Readonly<Record<IrreversibilityClass, number>>, c: IrreversibilityClass): number {
  const declared = windows[c];
  if (Number.isFinite(declared)) return declared;
  const hard = (table: Readonly<Record<string, number>>): readonly number[] =>
    Object.entries(table)
      .filter(([cls, ms]) => isHardToUndo(cls as IrreversibilityClass) && Number.isFinite(ms))
      .map(([, ms]) => ms);
  const supplied = hard(windows);
  return Math.max(0, ...(supplied.length > 0 ? supplied : hard(DEFAULT_WINDOWS)));
}

export class PolicyEngine {
  readonly #granted: readonly string[];
  readonly #windows: Readonly<Record<IrreversibilityClass, number>>;
  readonly #denied: readonly string[];
  readonly #deniedActors: ReadonlyMap<string, readonly string[]>;
  readonly #systemFloor: Posture;
  readonly #budget: BudgetLimits;
  readonly #allowlist: readonly string[] | undefined;
  readonly #onEscalate: PolicyEngineOptions["onEscalate"];

  /** Runtime escalations, keyed by scope (`run:<id>` or `node:<runId>/<nodeId>`). */
  readonly #escalations = new Map<string, Posture>();
  /**
   * Human-set CEILINGS, the only thing that can lower a posture below its computed
   * floor. Separate from `#escalations` because they compose differently: escalations
   * fold in by `max` and anyone may add one; a ceiling is a clamp, and only a human
   * holding `oversight:loosen` may set it.
   */
  readonly #ceilings = new Map<string, Posture>();
  readonly #reservations = new Map<string, Reservation>();
  #spentUsd = 0;
  #reservedUsd = 0;
  /**
   * THE OTHER TWO THIRDS OF THE DECLARED TRIPLE. `graph/spec.ts` has listed
   * `["costUsd", "tokens", "wallMs"]` in `POLICY_FIELDS.budget` for the whole project and
   * only the first was ever read: `/usr/bin/grep -arn 'budget\.tokens|budget\.wallMs'`
   * over `src/run/` returned nothing, so an author writing `budget: {tokens: 200000}` got
   * a clean compile and no ceiling — the same silence `Engine.submit`'s own comment
   * already condemns for dollars ("compile clean, and spend without limit").
   *
   * `#reservedWallMs` DOES NOT EXIST, and that is the one place this departs from the
   * dollar pattern. A reservation is a worst-case debit taken BEFORE the call, and there
   * is no worst case for duration: nothing can say how long a provider will take until it
   * has taken it. Reserving a made-up number would refuse work that fits; reserving zero
   * is check-then-act, which this file's own header calls wrong under fan-out. So wallMs
   * is settle-only, and the overshoot is bounded by the calls already in flight when the
   * ceiling is crossed — one wave, not one run. Stated rather than hidden: a wallMs
   * ceiling stops the NEXT call, it does not abort the current ones.
   */
  #spentTokens = 0;
  #reservedTokens = 0;
  #spentWallMs = 0;
  #reservationSeq = 0;

  constructor(opts: PolicyEngineOptions) {
    this.#granted = opts.granted;
    this.#denied = opts.denied ?? [];
    this.#deniedActors = engineDenyLists(opts.deniedActors);
    this.#systemFloor = opts.systemFloor ?? "on";
    this.#budget = opts.budget ?? {};
    this.#windows = boundedWindows(opts.interventionWindowMs);
    this.#allowlist = opts.allowlist;
    this.#onEscalate = opts.onEscalate;
  }

  // ── authorization ─────────────────────────────────────────────────────────

  decide(req: PolicyRequest): PolicyDecision {
    const reasons: string[] = [];

    for (const cap of req.capabilities) {
      if (matches(this.#denied, cap)) {
        reasons.push(`capability "${cap}" is explicitly denied`);
        return {
          effect: "deny",
          reasons,
          error: err.policy(CODES.E_CAP_DENIED, `capability "${cap}" is denied`, {
            details: { capability: cap, nodeId: req.nodeId },
          }),
        };
      }
      if (!matches(this.#granted, cap)) {
        reasons.push(`capability "${cap}" is not granted`);
        return {
          effect: "deny",
          reasons,
          error: err.policy(CODES.E_CAP_DENIED, `capability "${cap}" is not granted`, {
            details: { capability: cap, nodeId: req.nodeId },
          }),
        };
      }
      // AND WITHIN THE GRAPH'S OWN ALLOWLIST. Checked after the tenant grant, so an operator
      // reading the reasons sees which of the two bounds refused.
      if (this.#allowlist !== undefined && !matches(this.#allowlist, cap)) {
        reasons.push(`capability "${cap}" is outside this graph's declared allowlist`);
        return {
          effect: "deny",
          reasons,
          error: err.policy(
            CODES.E_CAP_DENIED,
            `capability "${cap}" is outside the graph's declared \`policy.capabilities\``,
            { details: { capability: cap, nodeId: req.nodeId, allowlist: [...this.#allowlist] } },
          ),
        };
      }
      reasons.push(`capability "${cap}" granted`);
    }

    if (req.tainted === true && isHardToUndo(req.irreversibility)) {
      reasons.push(`tainted input feeding an ${req.irreversibility} action (E8)`);
    }
    const posture = this.effectivePosture(req);
    reasons.push(`effective posture ${posture}`);

    if (posture === "in") return { effect: "gate", posture, reasons };

    // The hold applies ONLY at `on`. At `in` a gate is strictly stronger; at `out`
    // there is no supervisor watching, so holding would delay nobody's decision.
    const holdMs = posture === "on" ? windowFor(this.#windows, req.irreversibility) : 0;
    if (holdMs > 0) reasons.push(`intervention window ${holdMs}ms`);
    return { effect: "allow", posture, reasons, holdMs };
  }

  /**
   * `max` over every contributing floor. Because every term enters through `max`,
   * no single declaration can weaken the result — the asymmetry rule as arithmetic.
   */
  effectivePosture(req: PolicyRequest): Posture {
    const dataFloor = maxPosture(
      ...(req.dataClassification ?? []).map((c) => CLASSIFICATION_POSTURE_FLOOR[c]),
    );
    // WHERE TAINT IS *NOT* READ. A bump on this floor is arithmetically dead: it can only
    // raise a hard-to-undo action, and `CLASS_DEFAULT_POSTURE` already puts exactly those
    // at `in` in this same `max`. It was written here, it was the identity for every input,
    // and E8 therefore did nothing for the whole life of the mechanism. Taint is read at
    // the ceiling instead — the one place it can change an answer. See below.
    const floor = maxPosture(
      this.#systemFloor,
      CLASS_DEFAULT_POSTURE[req.irreversibility],
      dataFloor,
      req.declaredPosture,
      this.#escalations.get(`run:${req.runId}`) ?? "out",
      this.#escalations.get(`node:${req.runId}/${req.nodeId}`) ?? "out",
    );

    // A human ceiling clamps the computed floor. Without this, de-escalation is inert
    // for exactly the cases it exists for: an irreversible action always computes to
    // `in`, so "let this run on-the-loop" could never be expressed and the
    // intervention window could never fire.
    const ceiling =
      this.#ceilings.get(`node:${req.runId}/${req.nodeId}`) ?? this.#ceilings.get(`run:${req.runId}`);
    if (ceiling === undefined) return floor;

    // THE HARD FLOOR. A human may lower a hard-to-undo action to `on` — someone is
    // still watching and can interrupt — but never to `out`, where nobody is.
    //
    // TAINT RAISES THAT FLOOR TO `in` (E8). A de-escalation is a judgement about what the
    // human could see when they made it; untrusted tool output arriving afterwards and
    // feeding a hard-to-undo action is new information they have NOT seen, so the earlier
    // "let this run on-the-loop" no longer covers this action and they are asked again.
    // That is what D7.7's "cleared by: human" means for this rule.
    // A LAUNDERED SECRET RAISES IT TOO, for the same reason and not for a similar one. Measured
    // before this existed: one `function` node copying a `secret_ref` channel into an `internal`
    // one dropped the sink from `in` to `on`, no gate was raised, and the tool received the
    // plaintext. The declared classification stays clampable — it is in the graph the human saw —
    // and only the flow they could not see holds the floor at `in`.
    const unseen = req.tainted === true || req.carriesSecret === true;
    const clamped = isHardToUndo(req.irreversibility) ? maxPosture(ceiling, unseen ? "in" : "on") : ceiling;

    return postureRank(clamped) < postureRank(floor) ? clamped : floor;
  }

  // ── the asymmetry rule ────────────────────────────────────────────────────

  /** Tightening. Automatic, callable by rules and by the system. */
  escalate(scope: string, to: Posture, rule: string, detail?: Record<string, unknown>): void {
    const from = this.#escalations.get(scope) ?? "out";
    const next = maxPosture(from, to);
    if (next === from) return;
    this.#escalations.set(scope, next);
    this.#onEscalate?.(rule, from, next, scope, detail);
  }

  /**
   * Loosening. A different method with a different parameter type on purpose: the
   * signature alone rejects an agent or the evolution engine, and the runtime
   * deny-list rejects it again if someone casts around the type.
   *
   * THREE deny-lists, checked in descending order of authority, because the first two
   * are the engine's and only the third belongs to the caller. Reading `actor.denied`
   * alone — which is all this did — let anything pass that named itself
   * `evolution-engine` and left the field off, since an absent list matches nothing.
   */
  deescalate(scope: string, to: Posture, justification: string, actor: PolicyActor): void {
    if (actor.kind !== "human") {
      throw err.policy(
        CODES.E_OVERSIGHT_LOOSEN_FORBIDDEN,
        `only a human may lower oversight; actor is ${actor.kind}`,
        { details: { actor: actor.id, scope } },
      );
    }
    if (matches(this.#deniedActors.get(actor.id) ?? [], LOOSEN)) {
      throw err.policy(
        CODES.E_OVERSIGHT_LOOSEN_FORBIDDEN,
        `identity "${actor.id}" is deny-listed for ${LOOSEN} by this engine`,
        { details: { actor: actor.id, scope, source: "engine.deniedActors" } },
      );
    }
    if (matches(this.#denied, LOOSEN)) {
      throw err.policy(CODES.E_OVERSIGHT_LOOSEN_FORBIDDEN, `${LOOSEN} is denied for this tenant`, {
        details: { actor: actor.id, scope, source: "engine.denied" },
      });
    }
    if (matches(actor.denied ?? [], LOOSEN)) {
      throw err.policy(CODES.E_OVERSIGHT_LOOSEN_FORBIDDEN, `actor "${actor.id}" is deny-listed for ${LOOSEN}`, {
        details: { actor: actor.id, scope, source: "actor.denied" },
      });
    }
    if (justification.trim() === "") {
      throw err.validation(CODES.E_HUMAN_APPROVAL_REQUIRED, "de-escalation requires a non-empty justification");
    }
    this.#escalations.delete(scope);
    this.#ceilings.set(scope, to);
  }

  /**
   * Re-seed from the journal, without journaling.
   *
   * Escalations, human ceilings and spend are all decisions the journal already records,
   * and all three lived only in this object — so a restart rebuilt an empty engine and
   * silently handed the run back its full budget at a lowered posture. `escalate` cannot
   * be reused for this: it would fire `onEscalate` and re-append the very events being
   * replayed, growing the journal on every attach.
   *
   * Called once per attach, from the first path that holds a projection. It only ever
   * RAISES a posture and only ever ADDS spend, so a double call cannot loosen anything.
   */
  restore(state: {
    readonly escalations: Readonly<Record<string, Posture>>;
    readonly ceilings: Readonly<Record<string, Posture>>;
    readonly spentUsd: number;
    /**
     * BOTH OPTIONAL, and absent means zero rather than "unknown". A caller that restores
     * dollars and not tokens hands the run its full token budget back, which is exactly the
     * refund this method exists to close — so the ceiling is only as sound as its caller.
     * There is one caller, `Engine.#advanceSerially`, and it passes all three from the same
     * `RunProjection.usage` it reads `spentUsd` from.
     */
    readonly spentTokens?: number;
    readonly spentWallMs?: number;
  }): void {
    for (const [scope, to] of Object.entries(state.escalations)) {
      this.#escalations.set(scope, maxPosture(this.#escalations.get(scope) ?? "out", to));
    }
    for (const [scope, to] of Object.entries(state.ceilings)) this.#ceilings.set(scope, to);
    this.#spentUsd = round6(Math.max(this.#spentUsd, state.spentUsd));
    // `max`, like the dollars above and for the same reason: arriving here twice must not
    // lower a running total, and a restore that ADDED would double-count on the second call.
    this.#spentTokens = Math.max(this.#spentTokens, state.spentTokens ?? 0);
    this.#spentWallMs = Math.max(this.#spentWallMs, state.spentWallMs ?? 0);
  }

  /** Restore the computed floor by removing a human ceiling. Always allowed: it tightens. */
  clearCeiling(scope: string): void {
    this.#ceilings.delete(scope);
  }

  ceilingFor(scope: string): Posture | undefined {
    return this.#ceilings.get(scope);
  }

  escalationsFor(scope: string): Posture | undefined {
    return this.#escalations.get(scope);
  }

  // ── budget ────────────────────────────────────────────────────────────────

  /**
   * Debit the WORST CASE before the call. The reservation is held until `settle`
   * returns the unused remainder, so 25 concurrent branches cannot each see the same
   * balance and collectively overspend.
   */
  reserve(scope: string, estimateUsd: number, estimateTokens = 0): Reservation {
    // ALL THREE CEILINGS ARE CHECKED BEFORE ANY OF THEM IS DEBITED. A throw between two
    // debits would leave a reservation nothing will ever settle, and `#reservedUsd` only
    // falls in `settle` — so the run would carry a permanent phantom charge and refuse work
    // it could afford. Every `throw` below therefore precedes every mutation.
    const limit = this.#budget.runUsd;
    const committed = this.#spentUsd + this.#reservedUsd;
    if (limit !== undefined && committed + estimateUsd > limit + 1e-9) {
      throw err.exhausted(
        CODES.E_BUDGET_EXHAUSTED,
        `reserving $${estimateUsd.toFixed(4)} would exceed the $${limit.toFixed(2)} budget ` +
          `($${this.#spentUsd.toFixed(4)} spent, $${this.#reservedUsd.toFixed(4)} reserved)`,
        {
          details: { dimension: "costUsd", scope, limit, spent: this.#spentUsd, reserved: this.#reservedUsd, requested: estimateUsd },
        },
      );
    }
    const tokenLimit = this.#budget.runTokens;
    const tokensCommitted = this.#spentTokens + this.#reservedTokens;
    if (tokenLimit !== undefined && tokensCommitted + estimateTokens > tokenLimit) {
      throw err.exhausted(
        CODES.E_BUDGET_EXHAUSTED,
        `reserving ${String(estimateTokens)} tokens would exceed the ${String(tokenLimit)}-token budget ` +
          `(${String(this.#spentTokens)} spent, ${String(this.#reservedTokens)} reserved)`,
        {
          details: {
            dimension: "tokens",
            scope,
            limit: tokenLimit,
            spent: this.#spentTokens,
            reserved: this.#reservedTokens,
            requested: estimateTokens,
          },
        },
      );
    }
    const msLimit = this.#budget.runWallMs;
    // SETTLED-ONLY, for the reason `#spentWallMs` gives: there is nothing to reserve. The
    // comparison is `>=`, not `>`, so a ceiling reached exactly stops the next call — with
    // no reservation making the check conservative, an off-by-one in the loosening
    // direction is the one this cannot afford.
    if (msLimit !== undefined && this.#spentWallMs >= msLimit) {
      throw err.exhausted(
        CODES.E_BUDGET_EXHAUSTED,
        `${String(this.#spentWallMs)} ms of provider time has reached the ${String(msLimit)} ms budget`,
        { details: { dimension: "wallMs", scope, limit: msLimit, spent: this.#spentWallMs, reserved: 0, requested: 0 } },
      );
    }
    const r: Reservation = { id: `res-${this.#reservationSeq++}`, scope, amountUsd: estimateUsd, amountTokens: estimateTokens };
    this.#reservations.set(r.id, r);
    this.#reservedUsd = round6(this.#reservedUsd + estimateUsd);
    this.#reservedTokens += estimateTokens;
    return r;
  }

  /**
   * Release the reservation and charge what the call really cost.
   *
   * A bare number still means DOLLARS ONLY — the shape every caller used before tokens and
   * wall time were counted, kept so that `settle(r, 0)` on a failed call still reads as
   * "this cost nothing". A `UsageRecord` charges all three.
   *
   * WHAT `wallMs` MEANS HERE, and it is a choice with a price. It is the PROVIDER's own
   * reported duration, summed — the same number `run/projection.ts`'s `chargeUsage` folds
   * and copies into `run.completed.usage`. It is NOT the run's elapsed time, deliberately:
   * a run suspended overnight on a human gate would accrue a night of "wall time" it did
   * not work, and a `wallMs` ceiling would then kill runs whose only fault was waiting for
   * a person — the exact behaviour oversight exists to permit. The price is the other
   * direction: a run that spends an hour in a tool loop accrues ZERO here, because
   * `tool.called` carries `ms` and is deliberately not an arm of `chargeUsage`. So this
   * ceiling bounds what the PROVIDER burned, and a deployment that needs to bound the wall
   * clock needs a different mechanism than a `UsageRecord`.
   */
  settle(reservation: Reservation, actual: number | UsageRecord): void {
    const held = this.#reservations.get(reservation.id);
    if (held === undefined) return; // already settled; settling twice is a no-op
    this.#reservations.delete(reservation.id);
    this.#reservedUsd = Math.max(0, round6(this.#reservedUsd - held.amountUsd));
    this.#reservedTokens = Math.max(0, this.#reservedTokens - (held.amountTokens ?? 0));
    if (typeof actual === "number") {
      this.#spentUsd = round6(this.#spentUsd + actual);
      return;
    }
    this.#spentUsd = round6(this.#spentUsd + actual.costUsd);
    this.#spentTokens += billedTokens(actual);
    this.#spentWallMs += actual.wallMs;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }
  get reservedUsd(): number {
    return this.#reservedUsd;
  }
  get spentTokens(): number {
    return this.#spentTokens;
  }
  get spentWallMs(): number {
    return this.#spentWallMs;
  }
  /** What a new reservation could still take. Never negative. */
  get remainingUsd(): number {
    const limit = this.#budget.runUsd;
    if (limit === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, round6(limit - this.#spentUsd - this.#reservedUsd));
  }
  /**
   * True once 80 % of ANY declared ceiling is committed — escalation rule E2.
   *
   * Widened from dollars alone when tokens and wall time became ceilings, and widening it
   * only tightens: E2 RAISES a posture, so a run near its token ceiling now escalates where
   * it previously did not. An `||` fold rather than a max, because a run about to be
   * refused for tokens is near its limit whatever its dollars say.
   */
  get nearLimit(): boolean {
    const near = (spent: number, limit: number | undefined): boolean => limit !== undefined && spent >= limit * 0.8;
    return (
      near(this.#spentUsd + this.#reservedUsd, this.#budget.runUsd) ||
      near(this.#spentTokens + this.#reservedTokens, this.#budget.runTokens) ||
      near(this.#spentWallMs, this.#budget.runWallMs)
    );
  }
}

/**
 * The BILLED token count of a `UsageRecord`: `inputTokens + outputTokens`, and nothing else.
 *
 * `UsageRecord` documents `cacheReadTokens` and `cacheWriteTokens` as DISJOINT from
 * `inputTokens`, and `reasoningTokens` as a SUBSET of `outputTokens` — so a sum over every
 * token-shaped field would double-count the third and add two the provider reports
 * separately. A ceiling that over-counts refuses work that fit, which is the one direction a
 * limit must not move on its own.
 *
 * NOT EXPORTED, and `run/engine.ts` spells the same sum out at its one node-ceiling site
 * rather than importing it: `src/index.ts` re-exports this module with `export *`, so every
 * exported name here lands on the pinned public surface, and a two-term sum is not worth a
 * permanent API promise.
 */
function billedTokens(u: UsageRecord): number {
  return u.inputTokens + u.outputTokens;
}

function matches(patterns: readonly string[], capability: string): boolean {
  return patterns.some((p) => (p.endsWith("*") ? capability.startsWith(p.slice(0, -1)) : p === capability));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Combine the classifications of every channel an action touches. */
export function classificationOf(
  channels: Readonly<Record<string, { classification?: Classification }>>,
  names: readonly string[],
): Classification {
  return maxClassification(...names.map((n) => channels[n]?.classification ?? "public"));
}
