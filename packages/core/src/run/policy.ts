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
 * See design/loom/01-INTERFACES.md D3.13 and 03-RUNTIME.md D6.5.
 */

import { CODES, err, type LoomError } from "../errors.ts";
import type { NodeId, RunId, TaskId } from "../ids.ts";
import {
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
}

export interface BudgetLimits {
  /** Per run. `undefined` means unbounded, which the compiler warns about. */
  readonly runUsd?: number;
  readonly tenantUsd?: number;
}

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
   * `02-EXECUTION-GRAPH.md` specifies `capabilities: [string]  # allowlist; intersected with
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
 * The two classes a human may NOT de-escalate to `out`, and the two E8 guards.
 *
 * Named because the same pair drives the hard floor and the taint rule, and they were written
 * out longhand in both — which is how one of them could quietly become the identity without
 * the other noticing. Five more sites still spell it out (`graph/mutate.ts`, twice in
 * `graph/validate.ts`, `telemetry/spans.ts`, `run/engine.ts`); they are not converted because
 * `graph/` importing from `run/` inverts the layering, and that is the worse trade.
 */
export function isHardToUndo(c: IrreversibilityClass): boolean {
  return c === "irreversible" || c === "externally_visible";
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
  return { ...DEFAULT_WINDOWS, ...supplied };
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
    const holdMs = posture === "on" ? this.#windows[req.irreversibility] : 0;
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
    const clamped = isHardToUndo(req.irreversibility)
      ? maxPosture(ceiling, req.tainted === true ? "in" : "on")
      : ceiling;

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
  }): void {
    for (const [scope, to] of Object.entries(state.escalations)) {
      this.#escalations.set(scope, maxPosture(this.#escalations.get(scope) ?? "out", to));
    }
    for (const [scope, to] of Object.entries(state.ceilings)) this.#ceilings.set(scope, to);
    this.#spentUsd = round6(Math.max(this.#spentUsd, state.spentUsd));
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
  reserve(scope: string, estimateUsd: number): Reservation {
    const limit = this.#budget.runUsd;
    const committed = this.#spentUsd + this.#reservedUsd;
    if (limit !== undefined && committed + estimateUsd > limit + 1e-9) {
      throw err.exhausted(
        CODES.E_BUDGET_EXHAUSTED,
        `reserving $${estimateUsd.toFixed(4)} would exceed the $${limit.toFixed(2)} budget ` +
          `($${this.#spentUsd.toFixed(4)} spent, $${this.#reservedUsd.toFixed(4)} reserved)`,
        { details: { scope, limit, spent: this.#spentUsd, reserved: this.#reservedUsd, requested: estimateUsd } },
      );
    }
    const r: Reservation = { id: `res-${this.#reservationSeq++}`, scope, amountUsd: estimateUsd };
    this.#reservations.set(r.id, r);
    this.#reservedUsd = round6(this.#reservedUsd + estimateUsd);
    return r;
  }

  settle(reservation: Reservation, actualUsd: number): void {
    const held = this.#reservations.get(reservation.id);
    if (held === undefined) return; // already settled; settling twice is a no-op
    this.#reservations.delete(reservation.id);
    this.#reservedUsd = Math.max(0, round6(this.#reservedUsd - held.amountUsd));
    this.#spentUsd = round6(this.#spentUsd + actualUsd);
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }
  get reservedUsd(): number {
    return this.#reservedUsd;
  }
  /** What a new reservation could still take. Never negative. */
  get remainingUsd(): number {
    const limit = this.#budget.runUsd;
    if (limit === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, round6(limit - this.#spentUsd - this.#reservedUsd));
  }
  /** True once 80 % of the budget is committed — escalation rule E2. */
  get nearLimit(): boolean {
    const limit = this.#budget.runUsd;
    if (limit === undefined) return false;
    return this.#spentUsd + this.#reservedUsd >= limit * 0.8;
  }
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
