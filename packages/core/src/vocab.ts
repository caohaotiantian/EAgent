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
