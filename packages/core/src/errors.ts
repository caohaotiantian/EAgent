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

  /**
   * Safe to put in a span or a journal payload: no `cause` chain, no stack.
   *
   * Every field is read through `readOwn` for one reason: `this` need not be an instance
   * this constructor built. `isLoomError` is an `instanceof`, so
   * `Object.create(LoomError.prototype, {details: {get() {throw}}})` is a `LoomError` to
   * every check in the codebase, and `toLoomError` used to hand such a value back UNCHANGED
   * — so a channel's booby-trapped error escaped with its traps intact and detonated one
   * layer out, inside this method, on the HTTP path. That is the Traps list's *`instanceof`
   * proves a prototype, not provenance*, and this is the boundary half of the fix;
   * `toLoomError` is the other half.
   */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      class: readOwn(this, "class"),
      code: readOwn(this, "code"),
      message: readOwn(this, "message"),
      retryable: readOwn(this, "retryable"),
    };
    const retryAfterMs = readOwn(this, "retryAfterMs");
    const details = readOwn(this, "details");
    if (retryAfterMs !== undefined) out["retryAfterMs"] = retryAfterMs;
    if (details !== undefined) out["details"] = details;
    return out;
  }
}

/** A property read that costs the property and never the caller. */
function readOwn(v: unknown, key: string): unknown {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return undefined;
  try {
    return (v as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * `String(v)`, for a value that may refuse to become one.
 *
 * `String(Object.create(null))` throws `TypeError: Cannot convert object to primitive
 * value`, and so does any value with a throwing `toString` or `Symbol.toPrimitive` — which
 * is exactly the shape an injected tool executor, model adapter or delivery channel can
 * throw. `toLoomError`'s whole job is to make a boundary total, and it was the one call in
 * it that was not.
 */
function safeString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return `[unstringifiable ${typeof v}]`;
  }
}

export function isLoomError(e: unknown): e is LoomError {
  return e instanceof LoomError;
}

/**
 * Normalize anything thrown into a LoomError. Used at every interface boundary so
 * callers can rely on the taxonomy without defensive `instanceof` chains.
 *
 * IT IS TOTAL, and that is a property of THIS FUNCTION rather than of the values its
 * callers happen to hand it. Every one of its reads used to be bare, on a path whose
 * arguments come from injected code — tool executors, model adapters, delivery channels,
 * `ControlPlane`'s own catch — so the function whose job is to make a boundary safe was
 * itself a way through it. `String(e)` throws on a value with no primitive conversion;
 * `e.name` and `e.message` are property reads on a caller's object.
 *
 * AND `isLoomError` DOES NOT MEAN "ONE OF OURS". It is an `instanceof`, which proves a
 * prototype and nothing about provenance, so a value built with `LoomError.prototype` and
 * throwing accessors passed the check and was returned UNCHANGED — traps intact — to
 * detonate one layer out in `toJSON` or `httpStatusFor`. Four waves running, the untyped
 * exit from `run/delivery.ts` was a read of an injected value on an error path, each fixed
 * one property before the next. The answer is one boundary, not a fifth local `try`.
 *
 * So a `LoomError` is returned unchanged only when every field it will later be read for
 * answers cleanly, ONCE, here. Identity is worth preserving for the ordinary case — callers
 * compare `code` after re-throwing, and a rebuilt error loses `cause` and `stack` — and it
 * is not worth preserving for a value that cannot say what its own class is.
 *
 * `code` survives every path, deliberately: `Engine.#runAgent` branches on
 * `le.code !== E_BUDGET_EXHAUSTED` and `#invokeTool` on `le.code === E_REPLAY_DIVERGENCE`,
 * so an error that loses its code changes control flow rather than merely its message.
 *
 * `run/delivery.ts`'s `ownError`/`ownMessage`/`describeFailure` are NOT superseded by this
 * and must not be deleted: they additionally BOUND and replace `details`, and validate
 * `class`/`code` against the vocabulary, which is a second job this does not do. This is
 * built to the standard their docstrings set.
 */
export function toLoomError(e: unknown, fallbackCode = CODES.E_INTERNAL): LoomError {
  if (isLoomError(e)) {
    const cls = readOwn(e, "class");
    const code = readOwn(e, "code");
    // Every read this value will face downstream, taken here, once. If they all answer and
    // the two deciding fields are in the vocabulary, it is safe to pass on as it is.
    if (typeof cls === "string" && CLASSES.has(cls as ErrorClass) && typeof code === "string") {
      const rest = [readOwn(e, "message"), readOwn(e, "retryable"), readOwn(e, "retryAfterMs"), readOwn(e, "details")];
      if (typeof rest[0] === "string") return e;
      return new LoomError(cls as ErrorClass, code, safeString(rest[0]), { cause: e });
    }
    return new LoomError("internal", typeof code === "string" ? code : fallbackCode, safeString(readOwn(e, "message")), {
      cause: e,
    });
  }
  if (e instanceof Error && readOwn(e, "name") === "AbortError") {
    return new LoomError("cancelled", CODES.E_CANCELLED, "aborted", { cause: e });
  }
  const message =
    e instanceof Error ? `${safeString(readOwn(e, "name"))}: ${safeString(readOwn(e, "message"))}` : safeString(e);
  return new LoomError("internal", fallbackCode, message, { cause: e });
}

/** The vocabulary `toLoomError` checks a claimed `class` against. */
const CLASSES: ReadonlySet<ErrorClass> = new Set<ErrorClass>([
  "validation",
  "policy",
  "not_found",
  "conflict",
  "exhausted",
  "unavailable",
  "timeout",
  "cancelled",
  "internal",
]);

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
  /** A resource's content is not what its kind requires. */
  E_RESOURCE_INVALID: "E_RESOURCE_INVALID",
  E_CONFIG_INVALID: "E_CONFIG_INVALID",
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
  /** A channel did not accept a gate. NEVER an approval — see run/delivery.ts. */
  E_GATE_DELIVERY_FAILED: "E_GATE_DELIVERY_FAILED",

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
  /** A WORM store was asked to overwrite a record with different content. */
  E_AUDIT_IMMUTABLE: "E_AUDIT_IMMUTABLE",
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
  /** A child graph ended in a non-success state. */
  E_SUBGRAPH_FAILED: "E_SUBGRAPH_FAILED",
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
  // `e.class` IS A READ OF A VALUE THAT MAY NOT BE ONE OF OURS, and this function's declared
  // `number` return was a lie without the `default` arm below. The switch is exhaustive over
  // `ErrorClass`, so TypeScript is satisfied — but `toLoomError` used to hand back any object
  // whose prototype is `LoomError.prototype` unchanged, and `instanceof` proves a prototype
  // and nothing about provenance. A forged `class` therefore fell out of the bottom as
  // `undefined`, which `#dispatch` writes into a response status.
  switch (readOwn(e, "class")) {
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
    default:
      return 500;
  }
}
