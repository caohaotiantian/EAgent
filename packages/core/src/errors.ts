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
  const got = probe(v, key);
  return got === THREW ? undefined : got;
}

/**
 * "Absent" and "threw" are DIFFERENT ANSWERS, and `toLoomError` is the one caller that has
 * to tell them apart.
 *
 * `readOwn` collapses them, which is right where the answer is only ever rendered — a field
 * that will not be read is `undefined` either way. It is wrong where the answer decides
 * whether the VALUE ITSELF may be passed on: a forged error whose `class`, `code` and
 * `message` all answer cleanly and whose `details` getter throws looked identical to one
 * that simply has no `details`, so it was returned BY IDENTITY with the trap intact — and
 * `errorRecord` in `journal/events.ts` reads `e.details` and `e.retryable` BARE on the way
 * into a journal payload. The boundary this function exists to be was still open one field
 * along.
 */
const THREW = Symbol("threw");

function probe(v: unknown, key: string): unknown {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return undefined;
  try {
    return (v as Record<string, unknown>)[key];
  } catch {
    return THREW;
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
    // EVERY FIELD A LATER READER WILL TOUCH, PROBED HERE, ONCE — and a read that THREW
    // disqualifies the value even when the field is one this function never uses itself.
    // `errorRecord` reads `details` and `retryable` bare into a journal payload, and
    // `toJSON` reads all five, so "it answered for me" is not the question; "will it answer
    // for them" is.
    const cls = probe(e, "class");
    const code = probe(e, "code");
    const message = probe(e, "message");
    const trapped = [cls, code, message, probe(e, "retryable"), probe(e, "retryAfterMs"), probe(e, "details")].includes(
      THREW,
    );

    if (!trapped && typeof cls === "string" && CLASSES.has(cls as ErrorClass) && typeof code === "string" && typeof message === "string") {
      return e;
    }
    // Rebuilt, carrying across whatever could be read. `code` survives even here, because
    // control flow branches on it; a class in no vocabulary does not, because generic
    // machinery branches on THAT and `internal` is the fail-closed reading.
    // A TRAP DISQUALIFIES THE VALUE, NOT EVERY FIELD ON IT. `class` decides the HTTP status
    // and the retry policy, so downgrading a `policy` (403) to `internal` (500) because an
    // unrelated `details` getter threw would lose a fact that answered perfectly well. The
    // trapped field is dropped; the ones that spoke are carried across. `cls` itself
    // throwing is the case that does force `internal`, and `THREW` is a symbol so it fails
    // the `typeof === "string"` test on its own.
    const keptClass = typeof cls === "string" && CLASSES.has(cls as ErrorClass) ? (cls as ErrorClass) : "internal";
    const retryAfterMs = readOwn(e, "retryAfterMs");
    const details = readOwn(e, "details");
    return new LoomError(keptClass, typeof code === "string" ? code : fallbackCode, safeString(message === THREW ? undefined : message), {
      cause: e,
      ...(typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
      ...(details === undefined ? {} : { details }),
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
 *
 * A CODE ARRIVES WITH ITS RAISER, IN THE SAME CHANGE. Nine were declared ahead of one and
 * every one of them was still waiting when it was deleted: `E_ADMISSION_REJECTED`,
 * `E_CHECKPOINT_NOT_FOUND`, `E_INSUFFICIENT_COHORT`, `E_LEASE_LOST`, `E_POLICY_UNAVAILABLE`,
 * `E_SECRET_UNAVAILABLE`, `E_STORAGE_FULL`, `E_TOOL_NOT_IDEMPOTENT`, `E_TOO_LATE`. Three of
 * them were not waiting on anything — the condition they name is already raised under
 * another code (`E_FENCING_STALE` for a lost lease, `E_GATE_ALREADY_RESOLVED` for too late)
 * or is deliberately not an error at all (a small cohort is a named `goldenBlocker`; a
 * non-idempotent tool is a `#retryDecision` of "no"). A second spelling of a live decision is
 * worse than no spelling: it invites the next author to raise the one nothing catches.
 *
 * A CODE ALSO LEAVES WITH ITS RAISER, and that is a different case from the nine. Those were
 * declared ahead of a raiser that never came. `E_AUDIT_IMMUTABLE` HAD one — the append-only
 * `MemoryTierStore` in `journal/retention.ts` refused an overwrite with different content —
 * and it went when that file did. A code whose only raiser is deleted is not a code that
 * "might come back"; it is a promise about a mechanism the tree no longer contains, and
 * keeping it would have made `registries.test.ts`'s unraised set grow by one silently.
 * That test is what caught it, and it is the reason the deletion was one commit and not two.
 *
 * Adding a code costs one line at the moment of first use, and this file is deliberately NOT
 * kernel (`scripts/kernel.json`: "Adding an error code IS adding capability") — so declaring
 * one early saves nothing and promises something. `registries.test.ts` pins the unraised set,
 * which is `E_JOIN_TIMEOUT` alone, and says there why that one is allowed to stand.
 */
export const CODES = {
  // validation
  E_GRAPH_INVALID: "E_GRAPH_INVALID",
  E_CHANNEL_UNDECLARED: "E_CHANNEL_UNDECLARED",
  E_CONTEXT_OVERFLOW: "E_CONTEXT_OVERFLOW",
  E_TOOL_SCHEMA_INVALID: "E_TOOL_SCHEMA_INVALID",
  E_PROVIDER_BAD_REQUEST: "E_PROVIDER_BAD_REQUEST",
  E_ROUTE_INVALID: "E_ROUTE_INVALID",
  E_EXPR_INVALID: "E_EXPR_INVALID",
  /** A resource's content is not what its kind requires. */
  E_RESOURCE_INVALID: "E_RESOURCE_INVALID",
  E_CONFIG_INVALID: "E_CONFIG_INVALID",
  /** A cohort measured under different score weights is a different metric. */
  E_COHORT_INVALIDATED: "E_COHORT_INVALIDATED",
  /**
   * A value nests deeper than `canonicalize` will walk.
   *
   * `validation`, so NEVER retried: the same bytes will be refused again, and the retry
   * would be a second attempt at the stack overflow this code replaces. Raised only from
   * `canonical.ts`, which is on the durable write path (`journal/store.ts` canonicalizes
   * every payload and every actor) — so the alternative was a bare `RangeError` out of the
   * one path invariant 2 says must not fail unrecognisably.
   */
  E_PAYLOAD_TOO_DEEP: "E_PAYLOAD_TOO_DEEP",
  /** An event payload exceeded the per-event byte bound. Refused, never truncated. */
  E_PAYLOAD_TOO_LARGE: "E_PAYLOAD_TOO_LARGE",

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
  /** A channel did not accept a gate. NEVER an approval — see run/delivery.ts. */
  E_GATE_DELIVERY_FAILED: "E_GATE_DELIVERY_FAILED",

  // not_found
  E_RESOURCE_NOT_FOUND: "E_RESOURCE_NOT_FOUND",
  E_RESOURCE_YANKED: "E_RESOURCE_YANKED",
  E_TOOL_NOT_FOUND: "E_TOOL_NOT_FOUND",
  E_GATE_NOT_FOUND: "E_GATE_NOT_FOUND",
  E_RUN_NOT_FOUND: "E_RUN_NOT_FOUND",
  /**
   * The control plane has no route for this method and path.
   *
   * NOT `E_RUN_NOT_FOUND`, which this used to answer. The two are different facts for the
   * only audience that reads a code: "no such run" invites the caller to try another id,
   * while "no such endpoint" means this deployment does not implement what was asked — the
   * shape of a version skew, and no id will help. Nothing is leaked by the distinction that
   * the message did not already print.
   */
  E_ROUTE_NOT_FOUND: "E_ROUTE_NOT_FOUND",

  // conflict
  E_SEQ_CONFLICT: "E_SEQ_CONFLICT",
  E_FENCING_STALE: "E_FENCING_STALE",
  E_IDEMPOTENCY_MISMATCH: "E_IDEMPOTENCY_MISMATCH",
  E_GATE_ALREADY_RESOLVED: "E_GATE_ALREADY_RESOLVED",
  E_ILLEGAL_TRANSITION: "E_ILLEGAL_TRANSITION",
  E_RESTORE_ILLEGAL: "E_RESTORE_ILLEGAL",
  /**
   * A nondeterminism seam with no journaled effect behind it — the run cannot say what it did.
   *
   * TWO SITES, and only one of them raises this as a CODE. The distinction matters because a
   * reader who trusts the first paragraph alone will look for the wrong thing:
   *
   *   - `run/engine.ts`'s `#servedToolEffect`, as `err.validation`. A re-execution's call
   *     sequence has MOVED — this ordinal's recorded call is not the call being made — and the
   *     recorded one is non-idempotent, so its new position has no record and performing it
   *     would act twice. This is the coded raise, and it is in `RUN_FATAL_CODES`: an ordinary
   *     `error` edge used to absorb it and report the run **succeeded**.
   *   - `resources/functions.ts`'s `DENY_UNSEEDED`, as MESSAGE TEXT ONLY. It is a guest-realm
   *     `throw` for `Math.random()` in a body invoked with no `ctx.seed`, and every throw out
   *     of a realm normalizes to `internal`/`E_INTERNAL` — so what crosses the boundary carries
   *     this name in its message and a different code. `test/resources/functions.test.ts` says
   *     so at the assertion, which matches the text for exactly that reason. Both engine callers
   *     of `functions.require` pass a seed, so that site is reachable only by invoking a
   *     `FunctionBody` by hand.
   *
   * NEVER RETRIED at either site, which is the property both need: a second attempt with the
   * same missing seed fails identically, and a second attempt at a moved ordinal is the double
   * call the refusal exists to stop.
   */
  E_EFFECT_UNRECORDED: "E_EFFECT_UNRECORDED",
  /** A sandboxed body reached for a declared effect. It cannot: it may not await a host call. */
  E_EFFECT_UNAVAILABLE: "E_EFFECT_UNAVAILABLE",

  // exhausted
  E_BUDGET_EXHAUSTED: "E_BUDGET_EXHAUSTED",
  E_PROVIDER_RATE_LIMIT: "E_PROVIDER_RATE_LIMIT",
  E_EXPANSION_EXHAUSTED: "E_EXPANSION_EXHAUSTED",
  E_QUORUM_UNREACHABLE: "E_QUORUM_UNREACHABLE",

  // unavailable
  /**
   * A `function` or `evaluator{assertion}` body reported a transient failure and asked to be
   * re-run, by returning `{ retry: { reason } }`.
   *
   * `unavailable` and therefore RETRYABLE, which is the entire point: it is the only way a
   * sandboxed body can reach `NodeSpec.retry`. Every throw out of the realm normalizes to
   * `internal`/`E_INTERNAL`, so before this existed a `function` node's `retry` policy was
   * declared and unreachable.
   *
   * It is raised by the ENGINE on the body's behalf, not by the body — a guest object cannot be
   * a host `LoomError`. A node with no `retry` policy fails on it immediately, which is correct:
   * the body asked and the graph declined.
   */
  E_FUNCTION_UNAVAILABLE: "E_FUNCTION_UNAVAILABLE",
  E_PROVIDER_OVERLOADED: "E_PROVIDER_OVERLOADED",
  E_PROVIDER_TRANSPORT: "E_PROVIDER_TRANSPORT",
  E_TOOL_SOURCE_UNAVAILABLE: "E_TOOL_SOURCE_UNAVAILABLE",

  // timeout
  E_TOOL_TIMEOUT: "E_TOOL_TIMEOUT",
  E_JOIN_TIMEOUT: "E_JOIN_TIMEOUT",
  E_GATE_EXPIRED: "E_GATE_EXPIRED",
  /**
   * The graph offered for a run is not the graph that run compiled.
   *
   * Three things can differ and the message says which: the SPEC (`graphHash`), the RESOURCES its
   * refs resolved to (the journaled `resolutionManifest` — a spec is full of pointers and the
   * hash covers none of the bytes behind them), or the compiled oversight FLOOR, which `plans`
   * carries and the hash also excludes.
   */
  E_GRAPH_MISMATCH: "E_GRAPH_MISMATCH",
  E_TASK_TIMEOUT: "E_TASK_TIMEOUT",
  /**
   * The control plane gave up on a request before the handler answered.
   *
   * The DEPLOYMENT ran out of time, not the caller and not any one node: `ControlPlane`
   * bounds every request with `requestTimeoutMs` and answers 504 when it elapses. Distinct
   * from `E_TASK_TIMEOUT` (a node outrunning `NodeSpec.timeoutMs`) and from `E_TOOL_TIMEOUT`,
   * both of which are facts about the run — this one says nothing about the run, which may
   * still be advancing after the socket is answered.
   */
  E_REQUEST_TIMEOUT: "E_REQUEST_TIMEOUT",

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
  /**
   * A channel holds an externalised payload and the bytes could not be produced — no payload
   * store is configured, the cell is gone, or what came back does not digest to what the
   * journal recorded.
   *
   * `internal` rather than `validation`, so it is not retried: the same missing file will be
   * missing again. And RAISED rather than fallen back from, which is the whole point. The
   * alternative is to hand the node its handle, and a body that receives `{$payload: ...}`
   * where a document belonged does not fail — it succeeds on the wrong value, and the journal
   * records that success as the run's answer. A guard that cannot decide fails closed.
   */
  E_PAYLOAD_UNRESOLVED: "E_PAYLOAD_UNRESOLVED",
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
