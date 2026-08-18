/**
 * Retention tiering, and the audit record.
 *
 * Two rules do all the work here, and both are about what CANNOT happen:
 *
 * 1. **The journal is never pruned, only tiered.** Moving a run to cold storage changes
 *    where its events live and how fast they can be read; it never changes whether they
 *    exist. A retention policy that deletes journal events would make replay, the
 *    evaluation gate, and every trajectory a lie about the past. Cold is the resting
 *    place, not a cache: there is no tier beneath it, so a finite cold window is a delete
 *    however it is spelled — which is why the default is infinite and why a finite one
 *    will not construct without `pruneJournal`. A deployment under an erasure mandate can
 *    still have it; it just cannot arrive there by leaving a field alone.
 *
 * 2. **Audit records are DUPLICATED into their own store.** They are derived from the
 *    journal, but a copy lives under a separate policy, because otherwise a retention
 *    change made to cut telemetry cost silently shortens the record of who approved
 *    what. Those two decisions have different owners and different stakes, and a system
 *    where the cheap one can quietly override the expensive one is misdesigned.
 *
 * `@loom/core` stays zero-dependency, so the tier backends here are in-memory and
 * filesystem. Parquet, S3, and Glacier are `TierStore` implementations that live
 * outside the package — which is the same shape as `DeliveryChannel` and `StateStore`.
 *
 * See design/loom/05-RESOURCES-OBSERVABILITY.md D9.4 and 04-OVERSIGHT.md D7.8.
 */

import { digest, type Digest } from "../canonical.ts";
import { CODES, err } from "../errors.ts";
import type { GateId, NodeId, RunId, Seq, TaskId } from "../ids.ts";
import type { Posture } from "../vocab.ts";
import { isEvent, type Actor, type JournalEvent, type SubmittedBy } from "./events.ts";

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export type Tier = "hot" | "warm" | "cold" | "audit" | "artifacts";

export interface TierPolicy {
  /** How long this tier keeps what it holds. `Infinity` means forever. */
  readonly retentionMs: number;
}

export interface RetentionPolicy {
  readonly hot: TierPolicy;
  readonly warm: TierPolicy;
  readonly cold: TierPolicy;
  /**
   * The audit tier's own window.
   *
   * Deliberately NOT derived from `cold`. Coupling them is exactly the failure this
   * design prevents: someone cuts cold storage to save money and shortens the approval
   * record as a side effect.
   */
  readonly audit: TierPolicy;
  readonly artifacts: TierPolicy;
}

const DAY = 86_400_000;

/**
 * The defaults from D9.4.
 *
 * `audit` is `Infinity` because no external mandate applies (the operator confirmed GDPR
 * is out of scope), and because "keep the approval record forever unless someone
 * deliberately says otherwise" fails in the safe direction.
 *
 * `cold` IS INFINITE FOR A DIFFERENT AND STRONGER REASON, and this is a deliberate
 * divergence from D9.4's table, which still gives cold "1 y (configurable)". Cold is not
 * a cache of the journal, it is where the journal comes to rest: `archive` writes the
 * complete event array there and there is no tier below it, so applying a finite window is
 * deletion rather than tiering — rule 1 above, inverted, with the derived audit record
 * outliving the log it was derived from. A finite cold window remains available to a
 * deployment that genuinely must erase, but only together with `pruneJournal`, because a
 * policy that destroys the source of truth should not be reachable by leaving a field at
 * its default.
 *
 * `hot` and `warm` keep real numbers: they hold spans and metrics, which telemetry may
 * drop and which genuinely cost money.
 */
export const DEFAULT_RETENTION: RetentionPolicy = {
  hot: { retentionMs: 7 * DAY },
  warm: { retentionMs: 30 * DAY },
  cold: { retentionMs: Infinity },
  audit: { retentionMs: Infinity },
  artifacts: { retentionMs: 30 * DAY },
};

/**
 * Which tier an event belongs in, by age.
 *
 * Age drives the tier and nothing else does — an event does not become more or less
 * retainable because of what it says. Auditability is handled by DUPLICATION into the
 * audit tier, not by exempting some events from tiering.
 */
export function tierFor(ageMs: number, policy: RetentionPolicy = DEFAULT_RETENTION): Tier {
  if (ageMs <= policy.hot.retentionMs) return "hot";
  if (ageMs <= policy.warm.retentionMs) return "warm";
  return "cold";
}

// ---------------------------------------------------------------------------
// The audit record
// ---------------------------------------------------------------------------

export type AuditKind =
  | "gate_decision"
  | "operator_command"
  | "policy_change"
  | "resource_promotion"
  | "agent_action"
  | "run_submitted";

export interface AuditRecord {
  readonly runId: RunId;
  readonly seq: Seq;
  readonly ts: number;
  readonly kind: AuditKind;
  readonly actor: Actor;
  readonly subject: {
    readonly gateId?: GateId;
    readonly taskId?: TaskId;
    readonly nodeId?: NodeId;
    readonly scope?: string;
  };
  /**
   * The principal an action was taken ON BEHALF OF, where that differs from `actor`.
   *
   * `actor` answers "what appended this row", and for `run.submitted` the honest answer is
   * `system:control-plane` — the plane wrote it. Without a second field the audit projection
   * would answer "who started this run that spent money" with "the software did", which is
   * the one answer an audit trail exists to make impossible. Absent everywhere the two
   * coincide, which is every other kind: a gate decision's actor IS its decider.
   */
  readonly principal?: SubmittedBy;
  readonly decision?: string;
  /** Mandatory for reject, edit, redirect, and every de-escalation. */
  readonly justification?: string;
  readonly priorState?: { readonly posture: Posture };
  readonly newState?: { readonly posture: Posture };
  /** The exact rules that fired. An audit that cannot say WHY is not an audit. */
  readonly policyReasons: readonly string[];
  readonly latencyMs?: number;
  /**
   * The sha256 of the payload SHOWN to the human.
   *
   * The non-obvious field, and the reason gate payloads are rendered server-side: a
   * later "the approver was shown the wrong diff" dispute is otherwise unanswerable.
   */
  readonly contentDigest?: string;
}

/**
 * Extract the audit records from a run's journal.
 *
 * A pure fold, like every other derivation here, so the audit store can be rebuilt from
 * the journal at any time — and so a discrepancy between the two is detectable rather
 * than merely unlikely.
 */
export function extractAudit(events: Iterable<JournalEvent>): AuditRecord[] {
  const out: AuditRecord[] = [];
  const raised = new Map<GateId, { digest: string; reasons: string[] }>();
  const reasonsByTask = new Map<string, string[]>();
  let posture: Posture = "out";
  let submittedSeen = false;

  for (const e of events) {
    if (isEvent(e, "policy.decided")) {
      if (e.taskId !== undefined) reasonsByTask.set(e.taskId, [...e.payload.reasons]);
      continue;
    }
    if (isEvent(e, "gate.raised")) {
      raised.set(e.payload.gateId, {
        digest: e.payload.contentDigest,
        reasons: (e.taskId === undefined ? undefined : reasonsByTask.get(e.taskId)) ?? [],
      });
      continue;
    }
    if (isEvent(e, "gate.decided")) {
      const context = raised.get(e.payload.gateId);
      out.push({
        runId: e.runId,
        seq: e.seq,
        ts: e.ts,
        kind: "gate_decision",
        actor: e.actor,
        subject: { gateId: e.payload.gateId, ...(e.taskId === undefined ? {} : { taskId: e.taskId }) },
        decision: e.payload.decision,
        ...(e.payload.justification === undefined ? {} : { justification: e.payload.justification }),
        policyReasons: context?.reasons ?? [],
        latencyMs: e.payload.latencyMs,
        ...(context?.digest === undefined ? {} : { contentDigest: context.digest }),
      });
      continue;
    }
    if (isEvent(e, "policy.escalated") || isEvent(e, "policy.deescalated")) {
      const p = e.payload;
      out.push({
        runId: e.runId,
        seq: e.seq,
        ts: e.ts,
        kind: "policy_change",
        actor: e.actor,
        subject: { scope: p.scope },
        ...("justification" in p ? { justification: p.justification } : {}),
        priorState: { posture: p.from },
        newState: { posture: p.to },
        policyReasons: ["rule" in p ? p.rule : "deescalate"],
      });
      posture = p.to;
      continue;
    }
    if (isEvent(e, "run.submitted")) {
      // WHO STARTED THE RUN, which is the question A4 exists for.
      //
      // ONCE PER RUN, matching the fold. `Engine.submit` performs no existence check on a
      // caller-supplied `runId`, so an embedder can append a second `run.submitted`; the
      // projection folds the FIRST and so does this. Two "who started this run" rows naming
      // different principals is the one shape in which an audit record could claim a
      // principal for an act that principal did not perform.
      if (submittedSeen) continue;
      submittedSeen = true;
      out.push({
        runId: e.runId,
        seq: e.seq,
        ts: e.ts,
        kind: "run_submitted",
        actor: e.actor,
        subject: {},
        ...(e.payload.submittedBy === undefined ? {} : { principal: e.payload.submittedBy }),
        decision: e.payload.workflow,
        policyReasons: [],
      });
      continue;
    }
    if (isEvent(e, "checkpoint.restored")) {
      // A REWIND IS A STOP, AND IT REACHED THIS TIER THROUGH NOTHING.
      //
      // `Engine.cancel` appends `operator.command` and lands in the arm below; `rewind`
      // appends only this, and there was no arm for it — so the actor A4 threads into
      // `rewind` reached the journal and stopped there. That matters because the audit tier
      // is a separately stored, `Infinity`-retention duplicate, kept precisely so "who did
      // what" survives a journal retention change: with `pruneJournal` configured, "who
      // rewound this run" was the one A4 fact still destroyable.
      //
      // `operator_command` rather than a new kind, because that is what it is — an operator
      // acting on a run from outside it — and `auditViolations` already requires a
      // justification from nothing in this class, which is right: `reason` is mandatory on
      // `rewind`'s signature, so the record cannot lack one.
      out.push({
        runId: e.runId,
        seq: e.seq,
        ts: e.ts,
        kind: "operator_command",
        actor: e.actor,
        subject: {},
        decision: e.payload.mode,
        justification: e.payload.reason,
        policyReasons: [],
      });
      continue;
    }
    if (isEvent(e, "operator.command")) {
      out.push({
        runId: e.runId,
        seq: e.seq,
        ts: e.ts,
        kind: "operator_command",
        actor: e.actor,
        subject: e.taskId === undefined ? {} : { taskId: e.taskId },
        decision: e.payload.kind,
        policyReasons: [],
        newState: { posture },
      });
      continue;
    }
    if (isEvent(e, "tool.called") && e.payload.irreversibility !== "read_only") {
      // A hard-to-undo action is an audit event whether or not a human was involved.
      // "Who did what" includes what the machine did on its own.
      out.push({
        runId: e.runId,
        seq: e.seq,
        ts: e.ts,
        kind: "agent_action",
        actor: e.actor,
        subject: e.taskId === undefined ? {} : { taskId: e.taskId },
        decision: `${e.payload.name}@${e.payload.version}`,
        policyReasons: (e.taskId === undefined ? undefined : reasonsByTask.get(e.taskId)) ?? [],
        contentDigest: digest(e.payload.argsShape),
      });
    }
  }
  return out;
}

/** The justification rules that make an audit record meaningful rather than decorative. */
export function auditViolations(records: readonly AuditRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    const needsWhy =
      (r.kind === "gate_decision" && r.decision !== undefined && r.decision !== "approve") ||
      (r.kind === "policy_change" && r.policyReasons[0] === "deescalate");
    if (needsWhy && (r.justification ?? "").trim() === "") {
      out.push(`${r.runId}#${r.seq}: ${r.kind} "${r.decision ?? ""}" has no justification`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tier stores
// ---------------------------------------------------------------------------

export interface TierEntry {
  readonly key: string;
  readonly tier: Tier;
  readonly ts: number;
  readonly bytes: number;
  readonly digest: Digest;
}

export interface TierStore {
  readonly tier: Tier;
  put(key: string, value: unknown, ts: number): Promise<TierEntry>;
  get(key: string): Promise<unknown | undefined>;
  list(): Promise<readonly TierEntry[]>;
  /** Delete entries older than `retentionMs`. Returns what was removed. */
  expire(now: number, retentionMs: number): Promise<readonly string[]>;
}

/** In-memory tier, for tests and for the single-binary local mode. */
export class MemoryTierStore implements TierStore {
  readonly tier: Tier;
  readonly #data = new Map<string, { value: unknown; entry: TierEntry }>();
  readonly #append: boolean;

  constructor(tier: Tier, opts: { append?: boolean } = {}) {
    this.tier = tier;
    // WORM where available. The audit tier passes `append: true`, so a second write of
    // the same key is a conflict rather than an overwrite — an audit store you can
    // rewrite is a story, not a record.
    this.#append = opts.append ?? tier === "audit";
  }

  put(key: string, value: unknown, ts: number): Promise<TierEntry> {
    const existing = this.#data.get(key);
    const d = digest(value);
    if (existing !== undefined && this.#append) {
      // An identical re-put is idempotent — a retry must not be an error — but a
      // DIFFERENT value under the same key is someone editing history.
      if (existing.entry.digest !== d) {
        return Promise.reject(
          err.conflict(CODES.E_AUDIT_IMMUTABLE, `audit key "${key}" already exists with different content`, {
            details: { key, existing: existing.entry.digest, incoming: d },
          }),
        );
      }
      return Promise.resolve(existing.entry);
    }
    const json = JSON.stringify(value) ?? "";
    const entry: TierEntry = { key, tier: this.tier, ts, bytes: Buffer.byteLength(json), digest: d };
    this.#data.set(key, { value, entry });
    return Promise.resolve(entry);
  }

  get(key: string): Promise<unknown | undefined> {
    return Promise.resolve(this.#data.get(key)?.value);
  }

  list(): Promise<readonly TierEntry[]> {
    return Promise.resolve([...this.#data.values()].map((v) => v.entry).sort((a, b) => a.ts - b.ts));
  }

  expire(now: number, retentionMs: number): Promise<readonly string[]> {
    if (!Number.isFinite(retentionMs)) return Promise.resolve([]);
    const removed: string[] = [];
    for (const [key, v] of this.#data) {
      if (now - v.entry.ts > retentionMs) {
        this.#data.delete(key);
        removed.push(key);
      }
    }
    return Promise.resolve(removed);
  }
}

// ---------------------------------------------------------------------------
// The tiering operation
// ---------------------------------------------------------------------------

export interface TierManagerOptions {
  readonly policy?: RetentionPolicy;
  readonly cold: TierStore;
  readonly audit: TierStore;
  readonly now?: () => number;
  /**
   * Say YES to `sweep` deleting journals. Required whenever `policy.cold` is finite.
   *
   * Two fields have to agree before the source of truth can be destroyed, and they are
   * deliberately not one field: the window is a number an operator tunes for cost, the
   * consent is a claim about what this deployment is allowed to erase. Collapsing them
   * is how a cost decision quietly becomes a retention decision — the same failure the
   * separate `audit` window exists to prevent, one level up.
   */
  readonly pruneJournal?: boolean;
}

export interface ArchiveResult {
  readonly runId: RunId;
  readonly events: number;
  readonly auditRecords: number;
  readonly coldKey: string;
  readonly bytes: number;
}

/**
 * Moves a completed run out of the hot path.
 *
 * `archive` is the only operation that writes to cold and audit, and it writes to BOTH
 * or to neither: a run whose journal was archived but whose audit records were not would
 * be a run where the expensive record survived and the important one did not.
 */
export class TierManager {
  readonly #policy: RetentionPolicy;
  readonly #cold: TierStore;
  readonly #audit: TierStore;
  readonly #now: () => number;

  constructor(opts: TierManagerOptions) {
    this.#policy = opts.policy ?? DEFAULT_RETENTION;
    this.#cold = opts.cold;
    this.#audit = opts.audit;
    this.#now = opts.now ?? Date.now;
    if (this.#audit.tier !== "audit") {
      // A misconfigured audit store is the one thing here that must not start. Failing at
      // construction beats discovering it when someone asks who approved the outage.
      throw err.validation(CODES.E_CONFIG_INVALID, `the audit store must be tier "audit", not "${this.#audit.tier}"`);
    }
    if (Number.isFinite(this.#policy.cold.retentionMs) && opts.pruneJournal !== true) {
      // The second refusal, for the same reason and at the same moment. Cold holds the
      // journal itself, so a finite window here is a delete — and one that would land a
      // year after the misconfiguration, on the run somebody needs. Refusing at
      // construction is the only place the operator is still looking.
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `cold retention of ${this.#policy.cold.retentionMs}ms deletes archived journals; ` +
          "set cold.retentionMs to Infinity, or pass pruneJournal: true to say that is intended",
      );
    }
  }

  get policy(): RetentionPolicy {
    return this.#policy;
  }

  async archive(runId: RunId, events: readonly JournalEvent[]): Promise<ArchiveResult> {
    if (events.length === 0) {
      throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} has no journal to archive`);
    }
    const at = this.#now();

    // AUDIT FIRST. If the process dies between the two writes, the surviving artifact is
    // the one that matters, and the journal is still in its original store — nothing was pruned
    // to make room for this.
    const records = extractAudit(events);
    for (const r of records) {
      await this.#audit.put(`${r.runId}#${r.seq}`, r, r.ts);
    }

    const coldKey = `journal/${runId}`;
    const entry = await this.#cold.put(coldKey, events, at);

    return { runId, events: events.length, auditRecords: records.length, coldKey, bytes: entry.bytes };
  }

  /** Read an archived journal back. Replay and the eval gate both depend on this. */
  async restore(runId: RunId): Promise<readonly JournalEvent[] | undefined> {
    const value = await this.#cold.get(`journal/${runId}`);
    return value === undefined ? undefined : (value as readonly JournalEvent[]);
  }

  /**
   * Apply each tier's retention window.
   *
   * The audit tier is swept with ITS OWN window, never with cold's. That is the whole
   * point of the separate policy, and it is a one-line difference that a future
   * "simplification" would erase — hence the test that pins it.
   *
   * Cold's window reaches a `TierStore.expire` that DELETES, and cold holds the journal,
   * so this line can prune the source of truth. It is safe by construction rather than by
   * a check here: the constructor has already refused any finite cold window that was not
   * consented to, and an infinite one expires nothing.
   */
  async sweep(now = this.#now()): Promise<Readonly<Record<string, readonly string[]>>> {
    return {
      cold: await this.#cold.expire(now, this.#policy.cold.retentionMs),
      audit: await this.#audit.expire(now, this.#policy.audit.retentionMs),
    };
  }
}
