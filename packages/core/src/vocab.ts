/**
 * Cross-cutting value types.
 *
 * These are shared by layers that must not import each other — the journal must not
 * depend on the policy engine, the channel model must not depend on the journal —
 * so the vocabulary they all speak lives in one leaf module with no imports of its
 * own. (`Classification` was briefly declared in two places; TS2308 caught it, which
 * is the argument for putting it here rather than re-exporting.)
 */

// ---------------------------------------------------------------------------
// Oversight
// ---------------------------------------------------------------------------

/**
 * Ordered `out < on < in`. Every level of configuration contributes a posture and
 * they compose by `max`, which is how the asymmetry rule becomes arithmetic instead
 * of a policy people must remember to enforce.
 */
export type Posture = "out" | "on" | "in";

const POSTURE_RANK: Readonly<Record<Posture, number>> = { out: 0, on: 1, in: 2 };

export function postureRank(p: Posture): number {
  return POSTURE_RANK[p];
}

/** Tightening. The ONLY sanctioned way to combine postures. */
export function maxPosture(...postures: readonly Posture[]): Posture {
  let best: Posture = "out";
  for (const p of postures) if (POSTURE_RANK[p] > POSTURE_RANK[best]) best = p;
  return best;
}

/** True when `candidate` is anywhere weaker than `baseline` — i.e. a loosening. */
export function isLoosening(baseline: Posture, candidate: Posture): boolean {
  return POSTURE_RANK[candidate] < POSTURE_RANK[baseline];
}

/**
 * How hard an action is to take back. Declared on a tool, inherited by any node that
 * calls it, and the primary input to the default posture.
 */
export type IrreversibilityClass =
  /** No state outside Loom changes. */
  | "read_only"
  /** Mutates state Loom can undo via a declared compensation. */
  | "reversible_write"
  /** Cannot be undone by any declared action. */
  | "irreversible"
  /** Third parties observe it, even if technically revocable. */
  | "externally_visible";

/** The default posture an irreversibility class asserts, before any other level. */
export const CLASS_DEFAULT_POSTURE: Readonly<Record<IrreversibilityClass, Posture>> = {
  read_only: "out",
  reversible_write: "on",
  irreversible: "in",
  externally_visible: "in",
};

/** Whether a class may ever be auto-retried without a human. */
export const CLASS_AUTO_RETRYABLE: Readonly<Record<IrreversibilityClass, boolean>> = {
  read_only: true,
  reversible_write: true, // …and only if the tool also declares `idempotent`
  irreversible: false,
  externally_visible: false,
};

/** The four things a human may answer a gate with. */
export type GateDecisionKind = "approve" | "reject" | "edit" | "redirect";

export type GateDecision =
  | { readonly kind: "approve" }
  | { readonly kind: "reject"; readonly reason: string }
  /** The highest-quality label the evolution loop ever gets (D10.b, signal S2). */
  | { readonly kind: "edit"; readonly writes: Readonly<Record<string, unknown>>; readonly reason?: string }
  | { readonly kind: "redirect"; readonly take: readonly string[]; readonly reason?: string };

/**
 * THE ONE STATEMENT OF WHAT A GATE DECISION MAY BE.
 *
 * `GateDecision` is a four-member union and everything downstream branches on
 * `kind === "reject"`, so every kind the union does NOT name fell through to the
 * permissive reading. Measured against `Engine.resolveGate`, one skeleton run each,
 * `writes` being whether the action behind the gate really ran:
 *
 *     {"kind":"REJECT"}  → run=succeeded writes=1   gate.decided decision="REJECT"
 *     {"kind":"nope"}    → run=succeeded writes=1   gate.decided decision="nope"
 *     {}                 → run=succeeded writes=1   gate.decided with NO decision field
 *
 * An operator's caps-lock was an approval, and the journal kept `decision: "REJECT"`
 * beside an action that happened — a word in no vocabulary, recorded as the thing a
 * human decided. That is the Traps list's *approve means "go ahead"* one layer up:
 * **the unreadable case took the permissive branch**, which is the one failure the whole
 * oversight layer exists to prevent.
 *
 * IT LIVES HERE, AND IT IS ONE FUNCTION, BECAUSE IT WAS ALREADY THREE. `checkedDecision`
 * in `server/http.ts`, `ownedDecision` in `run/delivery.ts`, and `run/replay.ts`'s switch
 * — whose `default:` arm returned `{kind: "approve"}`, the same fail-open one layer in —
 * each decided this question separately, and the broker every one of them feeds decided it
 * not at all. Three guard chains for one union is what invariant 6 forbids; they agreed
 * only because each was written from the last, which is exactly the arrangement that
 * drifts (they already had: one truncates `reason`, the others do not). `vocab.ts` is the
 * home because `run/gates.ts` imports `run/delivery.ts` at run time, so a guard exported
 * from either is a cycle for the other — and a value type spoken by layers that must not
 * import each other is what this module is for.
 *
 * WHAT IT DECIDES IS THE ACCEPTANCE SET: the kind is a member, and that member's required
 * field is the right SHAPE. What it deliberately does not decide is each door's own
 * policy — that a rejection's reason must be non-empty (an audit-trail rule, stated at the
 * point of use), that a remote `reason` is truncated, that an injected `writes` is copied
 * through a JSON round trip. Those differ because the inputs differ, and folding them in
 * here would make one door's bound another door's silent behaviour change.
 *
 * Every field is read through a TOTAL accessor, because one of the callers is the
 * unauthenticated callback route: a hostile getter must cost this decision and never the
 * process. `undefined` is the fail-CLOSED answer, and a caller that must throw chooses its
 * own code — this module raises no errors and imports nothing.
 */
export function gateDecisionOf(v: unknown): GateDecision | undefined {
  const rawReason = readField(v, "reason");
  const withReason = typeof rawReason === "string" ? { reason: rawReason } : {};

  switch (readField(v, "kind")) {
    case "approve":
      return { kind: "approve" };
    case "reject":
      // The SHAPE only. "A rejection requires a reason" is a policy each door states.
      return typeof rawReason === "string" ? { kind: "reject", reason: rawReason } : undefined;
    case "edit": {
      const writes = readField(v, "writes");
      if (writes === null || typeof writes !== "object" || isList(writes)) return undefined;
      return { kind: "edit", writes: writes as Readonly<Record<string, unknown>>, ...withReason };
    }
    case "redirect": {
      const take = readField(v, "take");
      if (!isList(take)) return undefined;
      // Reading an ELEMENT is a call — an ordinary array can carry an accessor at index 0
      // — so the walk is inside the try, not merely the container test. Each element is
      // read ONCE and the value that was checked is the value that is kept: a getter that
      // answers `"e1"` and then something else would otherwise pass the check and ship the
      // second answer.
      try {
        const edges: string[] = [];
        for (const t of take) {
          if (typeof t !== "string") return undefined;
          edges.push(t);
        }
        return { kind: "redirect", take: edges, ...withReason };
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

/**
 * A subject the PERIMETER minted to describe what it concluded, rather than one that
 * names anybody — `(unidentified)`, `(shared-token)`, and any marker added later.
 *
 * The parenthesised form is the convention `server/http.ts` already writes and documents;
 * this states it once so a second reader is not a second list to keep in step. It is a
 * rule about the SHAPE and not a membership test on purpose: a graph that names an
 * unmintable-looking subject as an approver is refused whether or not this build happens
 * to mint that particular marker, which is the direction that survives a new one.
 *
 * `GRAPH014_APPROVER_INVALID` accepted any non-empty string, so a graph could list
 * `(unidentified)` — and a gate reading "the security lead must approve" would then be
 * satisfied by whatever the perimeter could not identify. An approvers list that names a
 * marker is the "looks supervised, is not" failure written into the graph itself.
 */
export function isSyntheticSubject(subject: string): boolean {
  return subject.startsWith("(") && subject.endsWith(")") && subject.length > 2;
}

/** A property read that costs this value and never the caller. */
function readField(v: unknown, key: string): unknown {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return undefined;
  try {
    return (v as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** `Array.isArray` cannot be forged and is not total — it throws on a REVOKED proxy. */
function isList(v: unknown): v is readonly unknown[] {
  try {
    return Array.isArray(v);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Data handling
// ---------------------------------------------------------------------------

/** Drives redaction at emit time. Declared on channels and on tool schema fields. */
export type Classification = "public" | "internal" | "pii" | "secret_ref";

const CLASSIFICATION_RANK: Readonly<Record<Classification, number>> = {
  public: 0,
  internal: 1,
  pii: 2,
  secret_ref: 3,
};

/** Combining data always takes the most sensitive classification present. */
export function maxClassification(...cs: readonly Classification[]): Classification {
  let best: Classification = "public";
  for (const c of cs) if (CLASSIFICATION_RANK[c] > CLASSIFICATION_RANK[best]) best = c;
  return best;
}

/** The posture floor a data classification asserts on its own (D7.6). */
export const CLASSIFICATION_POSTURE_FLOOR: Readonly<Record<Classification, Posture>> = {
  public: "out",
  internal: "out",
  pii: "on",
  secret_ref: "in",
};

// ---------------------------------------------------------------------------
// Disposables
// ---------------------------------------------------------------------------

/**
 * Every registration returns one of these so a reload is a clean swap rather than a
 * process restart. Named `Disposable` deliberately, but declared here rather than
 * relying on the TC39 `Disposable` global so a consumer on an older lib target still
 * type-checks.
 */
export interface Disposable {
  dispose(): void;
}

export function combineDisposables(...ds: readonly Disposable[]): Disposable {
  return {
    dispose() {
      // Reverse order, and a failing teardown must not block the others.
      for (const d of [...ds].reverse()) {
        try {
          d.dispose();
        } catch {
          /* teardown must not throw */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

/**
 * Token and cost accounting for one effect.
 *
 * Optional fields are OMITTED when a provider does not report them, so a usage built
 * from a minimal provider stays deep-equal to a plain two-field object. That
 * omit-invariant matters because usage values are canonicalized into digests.
 */
export interface UsageRecord {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cache-read tokens, disjoint from `inputTokens`. */
  readonly cacheReadTokens?: number;
  /** Cache-write tokens, disjoint from `inputTokens` and from cache-read. */
  readonly cacheWriteTokens?: number;
  /** A subset of `outputTokens`, informational — never added to a total. */
  readonly reasoningTokens?: number;
  readonly costUsd: number;
  readonly wallMs: number;
}

export const ZERO_USAGE: UsageRecord = { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 };

export function addUsage(a: UsageRecord, b: UsageRecord): UsageRecord {
  const sum: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    wallMs: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  } = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    // Wall time of concurrent effects is not additive; callers that care about
    // makespan compute it from spans. This sum is "total work", not "elapsed".
    wallMs: a.wallMs + b.wallMs,
  };
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) {
    sum.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  }
  if (a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined) {
    sum.cacheWriteTokens = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  }
  if (a.reasoningTokens !== undefined || b.reasoningTokens !== undefined) {
    sum.reasoningTokens = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  }
  return sum;
}

/** Billable tokens. Cache read/write are disjoint input; reasoning is inside output. */
export function totalTokens(u: UsageRecord): number {
  return u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) + u.outputTokens;
}
