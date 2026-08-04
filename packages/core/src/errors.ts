/**
 * One error taxonomy for every interface boundary.
 *
 * `class` answers "what should the caller do?" and is the only thing generic
 * machinery (retry policy, HTTP status mapping, circuit breakers) is allowed to
 * branch on. `code` answers "what exactly happened?" and is for humans, tests, and
 * declarative `retry.onlyIf` lists.
 *
 * Implementations wrap native errors here and never leak provider payloads into
 * `message` (they may contain secrets); structured context goes in `details`, which
 * is redacted before it reaches a span or the journal.
 *
 * See design/loom/01-INTERFACES.md D3.0.
 */

export type ErrorClass =
  /** Caller's fault. NEVER retry. */
  | "validation"
  /** Denied by policy. Retry only after a human changes something. */
  | "policy"
  | "not_found"
  /** Optimistic-concurrency or idempotency clash. Re-read, then decide. */
  | "conflict"
  /** Budget / quota / rate limit. Retry after `retryAfterMs`. */
  | "exhausted"
  /** Transient dependency failure. Retry with backoff. */
  | "unavailable"
  | "timeout"
  | "cancelled"
  /** A bug in Loom. Never retried automatically; always alerts. */
  | "internal";

const RETRYABLE: ReadonlySet<ErrorClass> = new Set<ErrorClass>(["exhausted", "unavailable", "timeout"]);

export interface LoomErrorInit {
  readonly retryAfterMs?: number;
  readonly details?: unknown;
  readonly cause?: unknown;
}

export class LoomError extends Error {
  override readonly name = "LoomError";
  readonly class: ErrorClass;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly details: unknown;

  constructor(errorClass: ErrorClass, code: string, message: string, init: LoomErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.class = errorClass;
    this.code = code;
    this.retryable = RETRYABLE.has(errorClass);
    this.retryAfterMs = init.retryAfterMs;
    this.details = init.details;
  }

  /** Safe to put in a span or a journal payload: no `cause` chain, no stack. */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      class: this.class,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.retryAfterMs !== undefined) out["retryAfterMs"] = this.retryAfterMs;
    if (this.details !== undefined) out["details"] = this.details;
    return out;
  }
}

export function isLoomError(e: unknown): e is LoomError {
  return e instanceof LoomError;
}

/**
 * Normalize anything thrown into a LoomError. Used at every interface boundary so
 * callers can rely on the taxonomy without defensive `instanceof` chains.
 */
export function toLoomError(e: unknown, fallbackCode = CODES.E_INTERNAL): LoomError {
  if (isLoomError(e)) return e;
  if (e instanceof Error && e.name === "AbortError") {
    return new LoomError("cancelled", CODES.E_CANCELLED, "aborted", { cause: e });
  }
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new LoomError("internal", fallbackCode, message, { cause: e });
}

// ---------------------------------------------------------------------------
// Canonical codes
// ---------------------------------------------------------------------------

/**
 * The stable machine codes that cross layer boundaries. Adding one is additive;
 * changing the class of an existing one is a breaking change, because
 * `retry.onlyIf` lists and HTTP status mappings depend on it.
 */
export const CODES = {
  // validation
  E_GRAPH_INVALID: "E_GRAPH_INVALID",
  E_CHANNEL_UNDECLARED: "E_CHANNEL_UNDECLARED",
  E_CONTEXT_OVERFLOW: "E_CONTEXT_OVERFLOW",
  E_TOOL_NOT_IDEMPOTENT: "E_TOOL_NOT_IDEMPOTENT",
  E_TOOL_SCHEMA_INVALID: "E_TOOL_SCHEMA_INVALID",
  E_PROVIDER_BAD_REQUEST: "E_PROVIDER_BAD_REQUEST",
  E_ROUTE_INVALID: "E_ROUTE_INVALID",
  E_EXPR_INVALID: "E_EXPR_INVALID",
  /** A cohort measured under different score weights is a different metric. */
  E_COHORT_INVALIDATED: "E_COHORT_INVALIDATED",

  // policy
  E_OVERSIGHT_LOOSENED: "E_OVERSIGHT_LOOSENED",
  E_OVERSIGHT_LOOSEN_FORBIDDEN: "E_OVERSIGHT_LOOSEN_FORBIDDEN",
  E_CAP_DENIED: "E_CAP_DENIED",
  E_GATE_REQUIRED: "E_GATE_REQUIRED",
  E_GATE_NOT_AUTHORIZED: "E_GATE_NOT_AUTHORIZED",
  E_CONTENT_FILTERED: "E_CONTENT_FILTERED",
  E_PROVIDER_AUTH: "E_PROVIDER_AUTH",
  E_NOT_AUTHORIZED: "E_NOT_AUTHORIZED",
  E_HUMAN_APPROVAL_REQUIRED: "E_HUMAN_APPROVAL_REQUIRED",
  E_EVAL_REGRESSION: "E_EVAL_REGRESSION",
  E_INSUFFICIENT_COHORT: "E_INSUFFICIENT_COHORT",
  E_POLICY_UNAVAILABLE: "E_POLICY_UNAVAILABLE",

  // not_found
  E_RESOURCE_NOT_FOUND: "E_RESOURCE_NOT_FOUND",
  E_RESOURCE_YANKED: "E_RESOURCE_YANKED",
  E_TOOL_NOT_FOUND: "E_TOOL_NOT_FOUND",
  E_GATE_NOT_FOUND: "E_GATE_NOT_FOUND",
  E_CHECKPOINT_NOT_FOUND: "E_CHECKPOINT_NOT_FOUND",
  E_RUN_NOT_FOUND: "E_RUN_NOT_FOUND",

  // conflict
  E_SEQ_CONFLICT: "E_SEQ_CONFLICT",
  E_FENCING_STALE: "E_FENCING_STALE",
  E_IDEMPOTENCY_MISMATCH: "E_IDEMPOTENCY_MISMATCH",
  E_LEASE_LOST: "E_LEASE_LOST",
  E_GATE_ALREADY_RESOLVED: "E_GATE_ALREADY_RESOLVED",
  E_ILLEGAL_TRANSITION: "E_ILLEGAL_TRANSITION",
  E_RESTORE_ILLEGAL: "E_RESTORE_ILLEGAL",
  E_TOO_LATE: "E_TOO_LATE",

  // exhausted
  E_BUDGET_EXHAUSTED: "E_BUDGET_EXHAUSTED",
  E_ADMISSION_REJECTED: "E_ADMISSION_REJECTED",
  E_PROVIDER_RATE_LIMIT: "E_PROVIDER_RATE_LIMIT",
  E_EXPANSION_EXHAUSTED: "E_EXPANSION_EXHAUSTED",
  E_QUORUM_UNREACHABLE: "E_QUORUM_UNREACHABLE",

  // unavailable
  E_SECRET_UNAVAILABLE: "E_SECRET_UNAVAILABLE",
  E_PROVIDER_OVERLOADED: "E_PROVIDER_OVERLOADED",
  E_PROVIDER_TRANSPORT: "E_PROVIDER_TRANSPORT",
  E_TOOL_SOURCE_UNAVAILABLE: "E_TOOL_SOURCE_UNAVAILABLE",
  E_STORAGE_FULL: "E_STORAGE_FULL",

  // timeout
  E_TOOL_TIMEOUT: "E_TOOL_TIMEOUT",
  E_JOIN_TIMEOUT: "E_JOIN_TIMEOUT",
  E_GATE_EXPIRED: "E_GATE_EXPIRED",
  E_TASK_TIMEOUT: "E_TASK_TIMEOUT",

  // cancelled
  E_CANCELLED: "E_CANCELLED",

  // internal
  E_INTERNAL: "E_INTERNAL",
  E_REPLAY_DIVERGENCE: "E_REPLAY_DIVERGENCE",
  E_FLOATING_REF_AT_RUNTIME: "E_FLOATING_REF_AT_RUNTIME",
  E_TRACE_INCONSISTENT: "E_TRACE_INCONSISTENT",
  /** A run finished without writing any declared output — a path was stranded. */
  E_OUTPUT_MISSING: "E_OUTPUT_MISSING",
} as const;

export type Code = (typeof CODES)[keyof typeof CODES];

// ---------------------------------------------------------------------------
// Constructors for the codes raised from more than one place
// ---------------------------------------------------------------------------

export const err = {
  validation: (code: Code, message: string, init?: LoomErrorInit): LoomError =>
    new LoomError("validation", code, message, init),
  policy: (code: Code, message: string, init?: LoomErrorInit): LoomError =>
    new LoomError("policy", code, message, init),
  notFound: (code: Code, message: string, init?: LoomErrorInit): LoomError =>
    new LoomError("not_found", code, message, init),
  conflict: (code: Code, message: string, init?: LoomErrorInit): LoomError =>
    new LoomError("conflict", code, message, init),
  exhausted: (code: Code, message: string, init?: LoomErrorInit): LoomError =>
    new LoomError("exhausted", code, message, init),
  unavailable: (code: Code, message: string, init?: LoomErrorInit): LoomError =>
    new LoomError("unavailable", code, message, init),
  timeout: (code: Code, message: string, init?: LoomErrorInit): LoomError =>
    new LoomError("timeout", code, message, init),
  cancelled: (message = "aborted", init?: LoomErrorInit): LoomError =>
    new LoomError("cancelled", CODES.E_CANCELLED, message, init),
  internal: (code: Code, message: string, init?: LoomErrorInit): LoomError =>
    new LoomError("internal", code, message, init),
};

/** HTTP mapping used by the control plane. Class-driven, never code-driven. */
export function httpStatusFor(e: LoomError): number {
  switch (e.class) {
    case "validation":
      return 400;
    case "policy":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "exhausted":
      return 429;
    case "unavailable":
      return 503;
    case "timeout":
      return 504;
    case "cancelled":
      return 499;
    case "internal":
      return 500;
  }
}
