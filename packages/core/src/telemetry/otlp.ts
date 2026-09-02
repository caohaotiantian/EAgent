/**
 * The wire, for the spans `telemetry/spans.ts` folds — so a trace can leave the process.
 *
 * `spansFrom` has produced a complete span tree with `gen_ai.*` attributes, subgraph links
 * and a keyed redactor over every attribute for several waves, and NOTHING COULD READ IT.
 * `loom trace` printed it to a terminal and `SpanLink.traceId` had exactly one consumer, the
 * in-process splice. That is a telemetry system that cannot be observed, which is the same
 * kind of not-a-product this repo keeps catching itself building.
 *
 * BOTH HALVES OF THAT NOW HAVE A CALLER IN THE BINARY, and the second one took a wave longer
 * than the first. `GET /runs/:id/trace?format=otlp` was the pull; `loom trace --otlp <endpoint>`
 * is the push, and until it landed this file's exporter had no caller at all outside a library
 * embedder's own wiring. `SpanLink.traceId`'s second consumer arrived with it: the CLI exports
 * ONE REQUEST PER RUN rather than the spliced tree it renders, so a parent's link crosses to
 * the child's own trace and the COLLECTOR performs the join.
 *
 * WHAT THIS TARGETS, NAMED SO A READER CAN CHECK IT AGAINST THE SPEC RATHER THAN AGAINST MY
 * MEMORY: **OTLP/HTTP with the JSON encoding**, `ExportTraceServiceRequest` from
 * `opentelemetry/proto/collector/trace/v1/trace_service.proto` — the stable `v1` shape
 * (opentelemetry-proto v1.x; every field emitted here has been in `v1` since v1.0.0, and no
 * field added after it is emitted). `POST {endpoint}/v1/traces`,
 * `Content-Type: application/json`. The five encoding rules the payload actually depends on,
 * each one a place a hand-rolled encoder normally gets it wrong:
 *
 *   1. **proto3 standard JSON mapping**, so field names are lowerCamelCase:
 *      `resourceSpans`, `scopeSpans`, `startTimeUnixNano`, `droppedAttributesCount`.
 *   2. **`traceId` and `spanId` are lowercase HEX strings, not base64.** This is OTLP's one
 *      documented departure from the proto3 mapping, which would otherwise base64 a `bytes`
 *      field, and it is the single most common reason a hand-written payload is accepted
 *      with a 200 and then shows up nowhere.
 *   3. **64-bit integers are JSON STRINGS** (proto3 mapping for `fixed64`/`int64`/`uint64`),
 *      which is not merely a convention here: see `nanos`.
 *   4. **Enums are integers.** `kind: 1` (INTERNAL), `2` (SERVER), `3` (CLIENT);
 *      `status.code: 0` (UNSET), `1` (OK), `2` (ERROR). OTLP/JSON permits the enum NAME in
 *      some encoders; integers are accepted by all of them.
 *   5. **A non-finite double is a STRING** — `"NaN"`, `"Infinity"`, `"-Infinity"` — because
 *      JSON has no literal for one and `JSON.stringify(NaN)` silently emits `null`, which
 *      the collector would read as an absent value rather than a broken measurement.
 *
 * THE IDS NEED NO CONVERSION, WHICH IS NOT A COINCIDENCE. `spans.ts` mints `traceId` as the
 * first 32 hex chars of `sha256(runId)` and `spanId` as the first 16 of a `sha256` over the
 * thing's coordinates — 128 and 64 bits, exactly OTLP's two widths, already lowercase hex.
 * So the conversion is a VALIDATION and not a transform, and it therefore cannot make a
 * replayed run's trace differ from the original's: same journal plus same deployment key
 * still gives byte-identical ids on the wire.
 *
 * CAN IT COLLIDE? Say so with the arithmetic rather than with a reassurance. A span id is 64
 * bits of a `sha256` prefix, so within one trace of `n` spans the birthday bound is
 * `n²/2^65`: at n = 10,000 spans in a single run that is 1e8/3.7e19 ≈ **2.7e-12**, and at
 * n = 1,000,000 — a run three orders of magnitude past anything this engine schedules — it is
 * 2.7e-8. Trace ids are 128 bits over runs and are not in a birthday race at all, because
 * `runId` is a ULID and two distinct run ids collide only on a genuine `sha256` prefix
 * collision. Both are below the rate at which a collector drops spans for its own reasons.
 * What is NOT a collision and is worth not confusing with one: two spans of the SAME
 * coordinates in the same run are the same span by construction, which is `spanId`'s design.
 *
 * THE REDACTOR IS NOT OPTIONAL AND THIS FILE IS WHY THE BOUNDARY IS WHERE IT IS. The input is
 * `readonly Span[]` — the output of `spansFrom`, which has already run every attribute, span
 * event and link through `redactAttributes` under a run-scoped key. This file NEVER reads a
 * `JournalEvent`, and it must not learn how to: an exporter that folded its own spans would
 * be a second fold, and the second fold is the one that forgets the redactor. `spans.ts`'s
 * header lists what that costs — a recovered approver in 0.011 ms, a five-digit `employeeId`
 * out of a content digest in 50 ms — and every one of those readings was taken against a
 * payload shaped like this one, headed for a third-party SaaS. So: **the only way an
 * attribute reaches this file is through `spansFrom`'s `close`, and the only way it reaches
 * the wire is through this file.**
 *
 * AND THE FOLD STAYS PURE. `spansFrom` learns nothing about a collector; the I/O lives in
 * `OtlpHttpExporter` and nowhere else. `otlpTraceRequest` is a pure function you can snapshot
 * in a test, write to a file, or hand to a transport this file has never heard of.
 *
 * FAILING DOES NOT THROW, and that is invariant 8 read in the direction `spans.ts`'s
 * `shouldExport` already argues for: telemetry may drop data, and an exporter that throws is
 * an exporter that takes a run down over a collector being briefly unreachable. `export`
 * returns an `OtlpExportResult` saying what happened. A caller who wants a failure to be loud
 * has the result and can raise its own; a caller who does not gets the correct default.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: batching, retry, a background queue, gzip, and the
 * protobuf encoding. Each is a real thing a production collector pipeline wants and each is a
 * policy the deployment owns, not a mechanism the core can pick for it — and none of them can
 * be added later by anyone who cannot already call `otlpTraceRequest`. Sampling is likewise
 * absent by construction: `shouldExport(events, policy)` reads the JOURNAL, which this file
 * cannot see, so the sampling decision belongs at the call site that has both.
 */

import type { Span, SpanKind, SpanLink, SpanStatus } from "./spans.ts";

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * `AnyValue`, `KeyValue` and the rest, as JSON.
 *
 * Typed as an open record rather than a faithful mirror of the proto. The proto's own
 * `AnyValue` is a `oneof` of seven arms, and modelling that in TypeScript buys a reader
 * nothing here — what a reader needs is the SHAPE THAT GOES ON THE WIRE, which the encoder
 * below spells out arm by arm and which the tests assert on literally.
 */
export type OtlpJson = string | number | boolean | null | readonly OtlpJson[] | { readonly [k: string]: OtlpJson };

/**
 * An `ExportTraceServiceRequest`, ready for `JSON.stringify`.
 *
 * One `ResourceSpans` per call — every span in a fold belongs to one run and therefore to
 * one resource. A caller merging several runs into one POST concatenates the `resourceSpans`
 * arrays, which is exactly what the field is for.
 */
export interface OtlpTracePayload {
  readonly resourceSpans: readonly OtlpJson[];
}

/** The instrumentation scope every span in this payload is attributed to. */
const SCOPE_NAME = "@loom/core/telemetry";

/**
 * OTLP's own enum, and the reason the mapping is only three arms wide.
 *
 * `SpanKind` in `spans.ts` is `internal | server | client` and OTLP has five more
 * (`PRODUCER`, `CONSUMER`, `UNSPECIFIED`). The map is total over the union that exists; a
 * value outside it — a hand-built `Span` from an embedder — falls to `UNSPECIFIED` rather
 * than to `INTERNAL`, because `0` says "this producer did not tell you" and `1` would be a
 * claim nobody made.
 */
const KIND_CODE: Readonly<Record<SpanKind, number>> = { internal: 1, server: 2, client: 3 };
const STATUS_CODE: Readonly<Record<SpanStatus, number>> = { unset: 0, ok: 1, error: 2 };

/**
 * `map[key] ?? fallback`, for a key this file does not get to assume the type of.
 *
 * The plain form is wrong here and the type system cannot say so. `otlpTraceRequest`'s
 * contract is TOTAL OVER ITS INPUT and it names hand-built arrays as the reason, so `s.kind`
 * is a `SpanKind` only by declaration. On an `Object.prototype` key it is not even undefined:
 * `KIND_CODE["constructor"]` is a FUNCTION, `??` therefore does not fire, and the fallback
 * that exists for precisely this case is skipped. Measured on the three shapes that reach the
 * wire: `kind: "constructor"` serialized to a span with NO `kind` field, because
 * `JSON.stringify` drops a function-valued key; `kind: "__proto__"` serialized to `kind: {}`,
 * an object where OTLP requires an integer enum, which is the worse one because it survives
 * JSON and a collector rejects the batch over it. Both are this file's own opening failure
 * mode — a 200 followed by nothing being visible — reached through the guard meant to stop it.
 *
 * `hasOwn` is the whole fix: consult the map only where the map actually spoke, and otherwise
 * take the fallback. Failing to the fallback is the closed direction here — an unknown kind is
 * `internal`(0)/`unset`(0), which is what the enum's own default means.
 */
function codeOf(map: Readonly<Record<string, number>>, key: unknown, fallback: number): number {
  const own = typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined;
  return own ?? fallback;
}

/** Lowercase hex of exactly `n` chars, and not all zeroes — OTLP calls an all-zero id invalid. */
function isId(v: unknown, n: number): v is string {
  if (typeof v !== "string" || v.length !== n) return false;
  let nonZero = false;
  for (let i = 0; i < n; i++) {
    const c = v.charCodeAt(i);
    const hex = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66);
    if (!hex) return false;
    if (c !== 0x30) nonZero = true;
  }
  return nonZero;
}

/**
 * Milliseconds to a `fixed64` of nanoseconds, AS A STRING, and the string is load-bearing
 * twice over.
 *
 * The proto3 JSON mapping requires a 64-bit integer to be a string, and the obvious way to
 * produce one — `String(ms * 1e6)` — is wrong in a way that is worth stating EXACTLY, because
 * the first version of this comment overstated it and a false correction is worse than the
 * original claim. Measured for `ms = 1756000000123`:
 *
 *     ms * 1e6                     the double, which is NOT the integer
 *     BigInt(ms * 1e6)             1756000000123000064   ← 64 ns of fabrication
 *     (ms * 1e6).toFixed(0)        1756000000123000064
 *     String(ms * 1e6)             1756000000123000000   ← accidentally right
 *     (BigInt(ms) * 1000000n)      1756000000123000000   ← right on purpose
 *
 * `1.77e18` is 200 times `Number.MAX_SAFE_INTEGER`, so the product is a double whose
 * neighbours are 256 apart and it cannot be the integer. What hides that is `String`'s
 * shortest-round-trip formatting, which prints the decimal that identifies the double rather
 * than the double's value — and over the 10,000 consecutive millisecond values from
 * 1700000000000 it happens to print the exact answer every time. So the honest statement is
 * NOT "the digits are wrong on the wire"; it is that the VALUE is wrong by up to 128 ns and
 * only one of the three ways to render it hides that. `toFixed(0)` — the spelling an author
 * reaches for precisely because it avoids exponential notation on a large number — ships the
 * fabricated digits outright, and a duration computed from two float products is wrong:
 * `BigInt(b*1e6) - BigInt(a*1e6)` is **999936 ns** for two timestamps one millisecond apart.
 *
 * `BigInt` multiplication is exact, so none of that is a thing anyone has to know: the
 * nanosecond field is the millisecond the journal recorded times a thousand thousand, under
 * every formatting, forever.
 *
 * A NEGATIVE OR NON-FINITE `ts` CLAMPS TO ZERO rather than throwing. `spansFrom` already
 * guarantees a finite number here (see its `lastTs` note), so this is the belt for a
 * hand-built `Span`; `fixed64` is unsigned and a negative would be rejected by the collector
 * for the whole batch, which would cost every OTHER span in the payload — the one outcome
 * invariant 8 does not license, since dropping is per-datum and this would not be.
 */
function nanos(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "0";
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

/**
 * How deep a container attribute is walked before it is dropped.
 *
 * A bound rather than a cycle set, and the bound subsumes the set: a cyclic value cannot
 * survive a depth cap, so one mechanism covers both the deep-nesting cost and the
 * infinite-recursion crash. Eight is well past anything `spansFrom` puts on a span — its
 * deepest attribute is a task's `writes` map, two levels — so the cap fires only for a value
 * an embedder built, which is exactly when a total function is worth more than a faithful one.
 */
const MAX_DEPTH = 8;

/**
 * A JavaScript value as an OTLP `AnyValue`, or `undefined` for "this is not representable".
 *
 * `undefined` propagates to OMITTING THE ATTRIBUTE, which is deliberate and is the reading of
 * invariant 8 that this whole file runs on: a span may be poorer than the journal and may
 * never be richer. OTLP does have an empty `AnyValue` that stands for null, and emitting one
 * would be *richer* in the only sense that matters — it would tell a reader "this key exists
 * and its value is nothing", a fact the journal does not hold.
 *
 * The number arm splits on `Number.isSafeInteger` rather than `Number.isInteger`: `2^60` is an
 * integer JavaScript cannot represent exactly, so calling it an `intValue` would ship a
 * precise-looking int64 built from an imprecise double. It goes out as a double, which is what
 * it actually is.
 */
function anyValue(v: unknown, depth: number): OtlpJson | undefined {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    if (Number.isSafeInteger(v)) return { intValue: String(v) };
    // Rule 5. `JSON.stringify(NaN)` is `null`, which a collector reads as an absent value
    // rather than as a measurement that went wrong — so the three non-finite doubles go out
    // under the proto3 JSON mapping's own spelling for them.
    if (!Number.isFinite(v)) return { doubleValue: Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity" };
    return { doubleValue: v };
  }
  if (typeof v === "bigint") {
    // int64's actual range, tested against the value rather than against its digit count.
    if (v >= -(2n ** 63n) && v < 2n ** 63n) return { intValue: v.toString() };
    return { stringValue: v.toString() };
  }
  if (depth >= MAX_DEPTH || v === null || typeof v !== "object") return undefined;
  if (Array.isArray(v)) {
    const values: OtlpJson[] = [];
    for (const el of v) {
      const enc = anyValue(el, depth + 1);
      // An unrepresentable ELEMENT is dropped, which shortens the array. The alternative —
      // dropping the whole array for one bad member — costs more of the journal than the
      // defect does, and OTLP has no hole to put in an `ArrayValue`.
      if (enc !== undefined) values.push(enc);
    }
    return { arrayValue: { values } };
  }
  const kv = keyValues(v as Record<string, unknown>, depth + 1);
  return { kvlistValue: { values: kv } };
}

/**
 * A bag as a `repeated KeyValue`.
 *
 * `Object.entries` is inside the `try` for `redactAttributes`' reason, one file over: it
 * invokes `ownKeys`, `getOwnPropertyDescriptor` and `get`, each a trap a `Proxy` can throw
 * from, and a throw here would cost the whole POST — every span for every run in the batch —
 * rather than one attribute. Costing the bag is the removing direction; costing the batch is
 * not.
 */
function keyValues(bag: unknown, depth: number): readonly OtlpJson[] {
  if (bag === null || typeof bag !== "object") return [];
  // `Object.keys`, NOT `Object.entries`, and the difference is measurable rather than
  // stylistic: `entries` reads every VALUE eagerly, so one throwing getter anywhere in the bag
  // lands in this outer catch and costs the whole bag. Measured — a span with
  // `{fine: "kept", get boom() { throw }}` emitted ZERO attributes, losing `fine` to a defect
  // in a key beside it. Keys first, then one guarded read per key, makes the loss exactly as
  // wide as the defect. `keys` still invokes `ownKeys` and `getOwnPropertyDescriptor`, which
  // are traps a `Proxy` can throw from, so it stays inside the try — and THAT case does cost
  // the bag, because a bag that will not say what is in it has nothing readable in it.
  let keys: readonly string[];
  try {
    keys = Object.keys(bag);
  } catch {
    return [];
  }
  const out: OtlpJson[] = [];
  for (const k of keys) {
    let enc: OtlpJson | undefined;
    try {
      enc = anyValue((bag as Record<string, unknown>)[k], depth);
    } catch {
      // This key's getter, or a getter inside its value. One attribute wide.
      continue;
    }
    if (enc !== undefined) out.push({ key: k, value: enc });
  }
  return out;
}

/**
 * A `SpanLink`, given the trace it was found in.
 *
 * **THIS IS THE FUNCTION TODO C.4 IS ABOUT.** `SpanLink.traceId` exists because a subgraph's
 * child run is a DIFFERENT trace (`traceId` is `digest(runId)` and a child's run id is
 * `${parent}~${taskId}`), and until this file existed the only thing that ever read it was
 * `spliceSubgraph` — an in-process join. On the wire it becomes an OTLP `Link{traceId,
 * spanId}`, which is the join performed by the COLLECTOR instead: the parent's `loom.effect`
 * span points at the child run's own trace, and a UI walks from one waterfall to the other
 * without either process having to hold both journals.
 *
 * `traceId` is optional on the interface because a same-trace link (D9.1's producer-Task
 * links) resolves from a span id alone. OTLP's `SpanContext` requires both halves, so an
 * absent one is filled in with the trace the linking span is in — which is what "same trace"
 * means, written down.
 */
function link(l: SpanLink, fallbackTraceId: string): OtlpJson | undefined {
  const spanId = l?.spanId;
  if (!isId(spanId, 16)) return undefined;
  const traceId = isId(l.traceId, 32) ? l.traceId : fallbackTraceId;
  const attributes = keyValues(l.attributes, 1);
  return attributes.length === 0 ? { traceId, spanId } : { traceId, spanId, attributes };
}

/**
 * Resource attributes for the payload.
 *
 * `service.name` is the one attribute every backend groups by and the one whose absence makes
 * a trace land in a bucket called `unknown_service`, so it is defaulted rather than left to
 * the caller to remember. Everything else the caller supplies rides along untouched —
 * `deployment.environment`, `service.version`, a k8s pod name.
 *
 * THESE ARE NOT REDACTED, which is worth stating because it is the one place in this file
 * where an attribute does not come through `spansFrom`. Mostly they are the DEPLOYMENT's own
 * description of itself, written in a config file by the same person configuring the
 * collector. **THE EXCEPTION IS NAMED RATHER THAN GLOSSED, because this docstring used to say
 * "nothing here is derived from a run" and both of the callers in this tree pass something
 * that is:** `server/http.ts` and `cli.ts` each put `OTLP_RUN_ID_ATTR` in this bag. It needs
 * no redaction because a run id is a ULID — it identifies a run and not a person, and it is
 * already on every span as `loom.run_id` — and the same holds for `OTLP_TRUNCATED_ATTR`, a
 * boolean about the fold. What must NOT arrive here is anything read out of a journal
 * payload: that road goes through `spansFrom`'s redactor or it does not go.
 */
function resource(attrs: Readonly<Record<string, unknown>> | undefined): OtlpJson {
  const bag: Record<string, unknown> = { "service.name": "loom", ...(attrs ?? {}) };
  return { attributes: keyValues(bag, 1) };
}

/** What `otlpTraceRequest` will accept alongside the spans. */
export interface OtlpTraceRequestOptions {
  /**
   * Resource attributes. `service.name` defaults to `"loom"` and any key here overrides it.
   */
  readonly resourceAttributes?: Readonly<Record<string, unknown>>;
}

/**
 * Spans to an `ExportTraceServiceRequest` — the pure half, and the whole of the wire format.
 *
 * TOTAL OVER ITS INPUT. Every span is validated and a span that fails is DROPPED, not
 * throwing and not repaired: the ids are the two fields a collector rejects a whole batch
 * over, so one malformed span from a hand-built array must not cost the run's other 400.
 * `spansFrom`'s own output never fails these tests — its ids are `sha256` prefixes by
 * construction — so in the path that matters this validation is a no-op that proves itself.
 *
 * SPANS ARE NOT REORDERED. `spansFrom` sorts by `startTime` with a `spanId` tie-break and
 * that ordering is already right for a waterfall; OTLP itself imposes none, and a re-sort here
 * would be a second opinion about an order the fold already argued for.
 */
export function otlpTraceRequest(spans: readonly Span[], options: OtlpTraceRequestOptions = {}): OtlpTracePayload {
  const out: OtlpJson[] = [];
  for (const s of spans ?? []) {
    if (s === null || typeof s !== "object") continue;
    const traceId = s.traceId;
    const spanId = s.spanId;
    // Rule 2, enforced rather than assumed. A `traceId` that is not 32 lowercase hex chars is
    // not a trace id, and shipping it produces a 200 followed by nothing being visible — the
    // failure mode this whole file's header opens with.
    // A NAMELESS SPAN TAKES THE SAME EXIT AS A BAD ID, and it used to acquire a fallback name
    // instead. That fallback was `"loom.span"` — a NINTH span name, minted in this file, when the
    // taxonomy is nine names owned by `telemetry/spans.ts` and §D.2 answered "no ninth name".
    // `registries.test.ts`'s "ONE FILE OWNS THE TELEMETRY VOCABULARY" caught it, which is what
    // that guard is for: a vocabulary with two representations drifts, and the second
    // representation here would have been invisible to everyone reading `spans.ts`.
    //
    // Dropping is also the honest answer on its own terms. This encoder's contract is that it
    // emits what the fold produced; a span whose name it had to invent is one the fold did not
    // produce, and shipping it under a name no collector query will match is worse than omitting
    // it. Same reasoning as the id check on this line, which is why it is this line.
    if (!isId(traceId, 32) || !isId(spanId, 16) || typeof s.name !== "string") continue;
    const links: OtlpJson[] = [];
    for (const l of s.links ?? []) {
      const enc = link(l, traceId);
      if (enc !== undefined) links.push(enc);
    }
    const events: OtlpJson[] = [];
    for (const e of s.events ?? []) {
      if (e === null || typeof e !== "object" || typeof e.name !== "string") continue;
      const attributes = keyValues(e.attributes, 1);
      events.push(
        attributes.length === 0
          ? { timeUnixNano: nanos(e.time), name: e.name }
          : { timeUnixNano: nanos(e.time), name: e.name, attributes },
      );
    }
    const span: Record<string, OtlpJson> = {
      traceId,
      spanId,
      name: s.name,
      kind: codeOf(KIND_CODE, s.kind, 0),
      startTimeUnixNano: nanos(s.startTime),
      endTimeUnixNano: nanos(s.endTime),
      attributes: keyValues(s.attributes, 1),
      // Every one of these is zero because this exporter drops nothing for a LIMIT — it drops
      // for representability, which is a different fact and has no OTLP field. Saying zero is
      // honest about the limits; the omissions are documented in `anyValue`.
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
      status: { code: codeOf(STATUS_CODE, s.status, 0) },
    };
    // ABSENT, NOT EMPTY, for a root span. `parentSpanId: ""` is what the proto's default
    // encodes to and several collectors read a present-but-empty parent as a broken reference
    // rather than as a root — so a root says nothing at all, which is the same thing the
    // binary encoding says.
    if (isId(s.parentSpanId, 16)) span["parentSpanId"] = s.parentSpanId;
    if (events.length > 0) span["events"] = events;
    if (links.length > 0) span["links"] = links;
    out.push(span);
  }
  return {
    resourceSpans: [
      {
        resource: resource(options.resourceAttributes),
        scopeSpans: [{ scope: { name: SCOPE_NAME }, spans: out }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The I/O half
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

export interface OtlpExporterOptions {
  /**
   * The collector's base URL. `/v1/traces` is appended unless the URL already ends in it, so
   * both `http://localhost:4318` and `http://localhost:4318/v1/traces` — the two spellings an
   * operator will actually have in front of them, since `OTEL_EXPORTER_OTLP_ENDPOINT` is the
   * base and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is the full path — reach the same place.
   */
  readonly endpoint: string;
  /**
   * Sent on every POST. This is where a vendor's API key goes.
   *
   * AND BECAUSE IT IS, THE VALUES JOIN `endpointSecrets`' MASK LIST — see `export`. The
   * endpoint used to be the whole of what this class refused to quote back, while the field
   * documented right here as holding the API key was quoted verbatim by two reachable paths.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Resource attributes for every payload this exporter sends. */
  readonly resourceAttributes?: Readonly<Record<string, unknown>>;
  /**
   * Injected for tests; defaults to the global.
   *
   * DECLARED AS THE SHAPE THIS CLASS CALLS, not as `typeof globalThis.fetch`. The wider
   * spelling is the one a reader reaches for and it excludes the injection seam this repo
   * already has: `HttpOptions["fetch"]` — what `main(argv, fetchImpl)` threads through
   * `cli.ts` — takes a `string` URL, and a function taking `string` is NOT assignable to one
   * declared to take `RequestInfo | URL`. Narrowing to the one call below is strictly more
   * permissive (everything assignable to the global's type is still assignable here) and it
   * is the honest description: this class calls `fetch` with a string and a full init, once.
   */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * What happened, instead of what was thrown.
 *
 * `spans` is the count that actually went on the wire, which is not `input.length` whenever
 * `otlpTraceRequest` dropped one — so a caller can alert on the difference rather than
 * discovering it as missing data months later. `rejected` is the OTLP `partialSuccess`
 * count: a 200 with a non-zero `rejectedSpans` is the collector saying it took the request
 * and threw some of it away, and treating that as a plain success is how a broken pipeline
 * stays invisible.
 */
export type OtlpExportResult =
  | { readonly ok: true; readonly spans: number; readonly rejected: number; readonly message?: string }
  | { readonly ok: false; readonly spans: number; readonly reason: "empty" | "status" | "transport" | "timeout"; readonly detail: string };

/**
 * The parts of the endpoint that must never appear in an error this exporter produces.
 *
 * `run/delivery.ts`'s `urlSecrets` in miniature, and for the identical reason — a collector
 * URL is very often the credential (`https://<key>@…`, or a vendor path segment that is one),
 * and `fetch` quotes the URL it was handed into its own `TypeError`. That message goes into
 * `detail`, and a caller that journals a failed export would then have put a secret in an
 * append-only log. The HOSTNAME is deliberately left legible: `ENOTFOUND collector.internal`
 * is what an operator diagnoses this with, and a host is not a secret.
 */
function endpointSecrets(url: string): readonly string[] {
  const out = [url];
  try {
    const u = new URL(url);
    out.push(u.href, u.origin);
    if (u.pathname !== "" && u.pathname !== "/") out.push(`${u.origin}${u.pathname}`, u.pathname);
    if (u.username !== "") out.push(u.username);
    if (u.password !== "") out.push(u.password);
    if (u.search !== "") out.push(u.search);
  } catch {
    // Not a URL. `fetch` refuses it and quotes the string, which is already the first entry.
  }
  return out;
}

function mask(text: string, secrets: readonly string[]): string {
  let out = text;
  // Longest first, so masking the userinfo does not leave the full href half-masked and
  // therefore still readable.
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s.length > 0) out = out.split(s).join("[redacted]");
  }
  return out;
}

/**
 * POST a fold to an OTLP collector.
 *
 * THE ONLY I/O IN THE TELEMETRY DIRECTORY, which is the boundary `spansFrom` is pure in order
 * to have. Nothing in the fold knows this class exists, and this class reads no journal.
 *
 * `fetch` is injected the way `WebhookChannel`'s is — the established seam in this repo for
 * "egress that a test must be able to observe without a socket". Tests here hand it a
 * function and assert on the bytes.
 */
export class OtlpHttpExporter {
  readonly #opts: OtlpExporterOptions;
  readonly #url: string;
  readonly #secrets: readonly string[];

  constructor(opts: OtlpExporterOptions) {
    this.#opts = opts;
    const base = typeof opts.endpoint === "string" ? opts.endpoint : "";
    const trimmed = base.replace(/\/+$/, "");
    this.#url = /\/v1\/traces$/.test(trimmed) ? trimmed : `${trimmed}/v1/traces`;
    this.#secrets = endpointSecrets(base);
  }

  /** Where a POST actually goes, after `/v1/traces` is resolved. Read by tests and by operators. */
  get url(): string {
    return this.#url;
  }

  /**
   * Encode and send. Never throws.
   *
   * NOTHING RUNS ABOVE THE TRY, `WebhookChannel.deliver`'s rule and for its reason: the
   * options bag is supplied by the deployment, so `opts.timeoutMs` is a property read that a
   * getter can throw from, and `AbortSignal.timeout(-1)` is a `RangeError`. A telemetry
   * exporter that throws out of an unexpected place is the exact failure this file's header
   * rules out, so the encoding, the timeout and the header spread are all inside.
   *
   * AN EMPTY FOLD IS NOT SENT. A POST with zero spans costs a round trip and tells the
   * collector nothing; `{ok: false, reason: "empty"}` distinguishes "nothing to say" from
   * "said it", which is the distinction a caller polling for pipeline health needs.
   */
  async export(spans: readonly Span[], signal?: AbortSignal): Promise<OtlpExportResult> {
    let count = 0;
    // THE HEADER VALUES ARE SECRETS TOO, and until this line they were not treated as any.
    // `#secrets` was `endpointSecrets(base)` alone while `OtlpExporterOptions.headers` says in
    // its own docstring that it is where the API key goes. Two paths quoted it back verbatim,
    // both driven with a loopback collector: a gateway that echoes the auth header in its 4xx
    // body reaches `detail` through the `!res.ok` branch, and a value Node refuses — a key read
    // with `$(cat key)` keeps its newline — makes `Headers.append` throw a `TypeError` QUOTING
    // THE WHOLE VALUE, which the catch below then masked against the endpoint only.
    //
    // COLLECTED HERE AND NOT IN THE CONSTRUCTOR, for the reason stated above this method:
    // `opts.headers` is the deployment's bag, so reading it is a property read a getter can
    // throw from, and nothing may run above the try. First statement inside it, so every later
    // line — including the catch, through `secrets` — has the full list.
    let secrets = this.#secrets;
    try {
      const bag = this.#opts.headers;
      if (bag !== undefined) {
        // THE VALUE *AND ITS WORDS*, because the whole value alone does not cover the commonest
        // shape there is. `mask` replaces exact substrings, so with
        // `authorization: "Bearer sk-live-abc123"` in the list, a gateway answering
        // `401 invalid api key: sk-live-abc123` — echoing the TOKEN rather than the whole header,
        // which is the ordinary thing a gateway does — matched nothing and printed the key. Each
        // whitespace-separated word of 8 or more characters joins the list, which covers
        // `Bearer <key>`, `Basic <b64>` and `Token <key>`; `mask` already sorts longest-first, so
        // the whole value still wins where both appear. The 8 is a floor on the WORDS only —
        // every value is masked whole whatever its length, so nothing that was covered before is
        // uncovered now, and a word short enough to collide with ordinary prose would redact the
        // sentence the mask exists to keep readable.
        const values = Object.values(bag).filter((v) => typeof v === "string" && v !== "");
        secrets = [...secrets, ...values, ...values.flatMap((v) => v.split(/\s+/).filter((w) => w.length >= 8))];
      }
      const attrs = this.#opts.resourceAttributes;
      const payload = otlpTraceRequest(spans, attrs === undefined ? {} : { resourceAttributes: attrs });
      const scopeSpans = (payload.resourceSpans[0] as { scopeSpans: readonly { spans: readonly unknown[] }[] }).scopeSpans;
      count = scopeSpans[0]!.spans.length;
      if (count === 0) return { ok: false, spans: 0, reason: "empty", detail: "no exportable spans in this fold" };
      // A `Headers` BUILT WITH `set`, NOT A RECORD SPREAD — and the honest reason is narrower
      // than the one first written here, which was that it makes a header named `__proto__`
      // reach the wire. IT DOES NOT, AND NOTHING DOES. Driven on loopback against a server
      // printing `rawHeaders`:
      //
      //     Headers via set, iterator shows [["__proto__","S"],["constructor","also"],…]
      //     wire:  host, connection, content-type, constructor, accept, …   ← no __proto__
      //     entries-array form                                              ← no __proto__
      //     node:http with the same name                                    ← __proto__ PRESENT
      //
      // So `undici` drops that one name on the way to the socket however the `Headers` is built,
      // while `node:http` carries it. `cli.ts` therefore REFUSES the name rather than pretending
      // to send it — send-or-refuse, with sending measured impossible.
      //
      // What this form is actually worth: it removes the plain-object intermediate entirely, so
      // no inherited-key surprise can happen in the conversion at all — the class this tree has
      // already been bitten by twice (`KIND_CODE["constructor"]` here, `out["__proto__"]` in the
      // CLI's parser). And `set` rather than the array form because the array APPENDS: a caller
      // passing their own `content-type` would get `application/json, theirs` instead of theirs,
      // where the record spread was last-wins.
      const headers = new Headers({ "content-type": "application/json" });
      for (const [k, v] of Object.entries(this.#opts.headers ?? {})) headers.set(k, v);
      const raw: unknown = this.#opts.timeoutMs;
      // Bounded rather than defaulted, `WebhookChannel.#timeout`'s lesson: `AbortSignal.timeout`
      // keeps its delay in a 32-bit signed int and TRUNCATES, so `2 ** 31` is one millisecond
      // and every export would fail instantly under a message quoting a two-billion timeout.
      const timeoutMs = typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 2_147_483_647 ? raw : DEFAULT_TIMEOUT_MS;
      const timeout = AbortSignal.timeout(timeoutMs);
      const doFetch = this.#opts.fetch ?? globalThis.fetch;
      const res = await doFetch(this.#url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        // A REDIRECT IS REFUSED, AND THIS IS THE ONE LINE IN THIS FILE THAT IS ABOUT AN
        // ATTACKER RATHER THAN ABOUT A MISTAKE. `fetch` defaults to `redirect: "follow"`, and a
        // POST this class makes carries two things a deployment cannot afford to have
        // re-addressed: the API key in `headers`, and a whole run's trace. Driven on loopback —
        // a "collector" answering `307 Location: http://127.0.0.1:4399/v1/traces` and a second
        // server on that port printed
        //
        //     ATTACKER RECEIVED: POST /v1/traces auth= sk-SUPER-SECRET bodyBytes= 438
        //
        // and `export` returned `{ok: true, spans: 1, rejected: 0}`. The caller is then told the
        // spans reached the host it named, and they reached a different one. Following a 3xx to
        // a host the operator did not name is a decision no telemetry exporter is entitled to
        // make on their behalf, so it is `"error"` — the redirect surfaces as
        // `reason: "transport"`, and an operator whose collector genuinely redirects names the
        // final URL on `--otlp` themselves, which is the same act stated once instead of twice.
        redirect: "error",
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      if (!res.ok) {
        // The BODY, not just the status: an OTLP collector's 400 says which field it could not
        // read, and that sentence is the whole difference between a fixable export and a
        // shrug. Bounded, because a proxy can answer a 502 with a whole HTML page.
        const body = await res.text().catch(() => "");
        return {
          ok: false,
          spans: count,
          reason: "status",
          detail: mask(`collector returned ${res.status}${body.trim() === "" ? "" : `: ${body.trim().slice(0, 512)}`}`, secrets),
        };
      }
      // OTLP's partial success: a 200 whose body carries `partialSuccess.rejectedSpans > 0`
      // means the collector kept some and dropped the rest, and an empty body / `{}` means it
      // kept everything. Unparseable is treated as "kept everything", because the status line
      // already said so and inventing a rejection from a malformed body would be a worse lie
      // than trusting the 200.
      const text = await res.text().catch(() => "");
      let rejected = 0;
      let message: string | undefined;
      try {
        const ps: unknown = (JSON.parse(text === "" ? "{}" : text) as { partialSuccess?: unknown }).partialSuccess;
        if (ps !== null && typeof ps === "object") {
          const n = Number((ps as { rejectedSpans?: unknown }).rejectedSpans ?? 0);
          rejected = Number.isFinite(n) && n > 0 ? n : 0;
          const m: unknown = (ps as { errorMessage?: unknown }).errorMessage;
          // MASKED LIKE `detail`, and it was not. Both fields carry text the COLLECTOR chose,
          // both end up in front of an operator, and a collector that echoes the request URL
          // into `errorMessage` re-prints the credential-bearing endpoint that the sibling
          // field one branch up redacts. One rule for third-party text, not two.
          if (typeof m === "string" && m !== "") message = mask(m.slice(0, 512), secrets);
        }
      } catch {
        // Not JSON. The 200 stands.
      }
      return message === undefined ? { ok: true, spans: count, rejected } : { ok: true, spans: count, rejected, message };
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      // THE CAUSE, BECAUSE WITHOUT IT THIS FILE'S OWN DIAGNOSTIC CLAIM WAS FALSE. `endpointSecrets`
      // says the hostname is left legible so that `ENOTFOUND collector.internal` survives — and it
      // never did: Node's `fetch` throws a bare `TypeError: fetch failed` and puts the real reason
      // on `.cause`. Measured against `http://no-such-host.invalid:4318`, `detail` was
      // `"TypeError: fetch failed"` and nothing else, while the raw `fetch` rejection carried
      // `cause.message === "getaddrinfo ENOTFOUND no-such-host.invalid"`. So every transport
      // failure of this exporter — DNS, connection refused, TLS, a refused redirect — reported the
      // same four words. The cause goes through the SAME mask, because it is the field that
      // quotes the URL.
      const detail =
        e instanceof Error
          ? `${e.name}: ${e.message}${e.cause instanceof Error && e.cause.message !== "" ? ` (${e.cause.message})` : ""}`
          : String(e);
      return { ok: false, spans: count, reason: timedOut ? "timeout" : "transport", detail: mask(detail, secrets) };
    }
  }
}
