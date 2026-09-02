/**
 * A TRACE LEAVES THE PROCESS — the wire format, and the two things it must not lose.
 *
 * Every journal here is hand-written with literal `ts` values and every `fetch` is injected,
 * so nothing in this file reads a clock or opens a socket. What it asserts on is BYTES: the
 * exact JSON an OTLP collector would receive, checked against the five encoding rules
 * `otlp.ts`'s header names, because a hand-rolled encoder's characteristic failure is a 200
 * followed by the trace being nowhere — a green test that asserts "we called fetch" would
 * reproduce that failure perfectly.
 *
 * The two things it must not lose are the two the lane brief names: the REDACTOR, which is
 * upstream of this file and therefore easy to route around, and the DERIVED ids, which are
 * what makes a replayed run's trace comparable with the original's.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { spansFrom, type Span } from "../../src/telemetry/spans.ts";
import { OtlpHttpExporter, otlpTraceRequest, type OtlpExportResult } from "../../src/telemetry/otlp.ts";
import { SYSTEM_ACTOR, type JournalEvent } from "../../src/journal/events.ts";
import type { RunId, TaskId } from "../../src/ids.ts";
import { fixtureJournal } from "./trace-fixture.ts";

const PARENT = "01JRUNPARENT000000000000000" as RunId;
const TASK = "delegate@#0" as TaskId;
const CHILD = `${PARENT}~${TASK}` as RunId;

function ev(runId: RunId, seq: number, type: string, payload: unknown, taskId: TaskId | null): JournalEvent {
  return {
    runId,
    seq,
    ts: 1_700_000_000_000 + seq * 10,
    type,
    payload,
    actor: SYSTEM_ACTOR("test"),
    ...(taskId === null ? {} : { taskId }),
    classification: "internal",
  } as unknown as JournalEvent;
}

/** The one `scopeSpans[0].spans` array a payload from this file ever has. */
function wireSpans(payload: unknown): readonly Record<string, unknown>[] {
  const rs = (payload as { resourceSpans: readonly { scopeSpans: readonly { spans: readonly Record<string, unknown>[] }[] }[] }).resourceSpans;
  return rs[0]!.scopeSpans[0]!.spans;
}

function kv(bag: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of bag as readonly { key: string; value: Record<string, unknown> }[]) out[e.key] = e.value;
  return out;
}

// ---------------------------------------------------------------------------
// The encoding
// ---------------------------------------------------------------------------

test("the payload is OTLP/JSON: hex ids, nanosecond STRINGS, integer enums, KeyValue attributes", () => {
  const spans = spansFrom(fixtureJournal());
  const payload = otlpTraceRequest(spans, { resourceAttributes: { "service.name": "loom-test", "deployment.environment": "ci" } });
  const wire = wireSpans(payload);

  assert.equal(wire.length, spans.length, "every folded span reached the wire");

  // Rule 2 — the one that produces a 200 and no data when it is wrong. Hex, not base64:
  // base64 of 16 bytes is 24 chars ending in `=`, so the length test alone separates them.
  for (const s of wire) {
    assert.match(String(s["traceId"]), /^[0-9a-f]{32}$/, "traceId must be 32 lowercase hex chars (16 bytes), never base64");
    assert.match(String(s["spanId"]), /^[0-9a-f]{16}$/, "spanId must be 16 lowercase hex chars (8 bytes), never base64");
  }

  const root = wire.find((s) => s["name"] === "loom.run")!;
  const task = wire.find((s) => s["name"] === "loom.task")!;

  // Rule 3 — 64-bit ints are strings. A number here would be a silently-truncated timestamp.
  assert.equal(typeof root["startTimeUnixNano"], "string");
  assert.equal(root["startTimeUnixNano"], "1010000000");
  assert.equal(root["endTimeUnixNano"], "1080000000");

  // Rule 4 — enums are integers, never the enum NAME. `loom.run` folds as `server` (2) and
  // `loom.task` as `internal` (1), so this also pins that the map is applied per span rather
  // than defaulted; `ok` is status 1.
  assert.equal(root["kind"], 2, "SPAN_KIND_SERVER");
  assert.equal(task["kind"], 1, "SPAN_KIND_INTERNAL");
  assert.deepEqual(root["status"], { code: 1 }, "STATUS_CODE_OK");

  // Tree shape survives: a root has NO `parentSpanId` key at all, and a child names the root.
  assert.equal("parentSpanId" in root, false, "a root span must omit parentSpanId, not send an empty one");
  assert.equal(task["parentSpanId"], root["spanId"]);

  // Attributes are `repeated KeyValue`, values are `AnyValue` — an int is `intValue` AS A
  // STRING and a fraction is `doubleValue` as a number, which is the split proto3 makes.
  const attrs = kv(root["attributes"]);
  assert.deepEqual(attrs["run.id"], { stringValue: "01JRUNFIXTURE00000000000000" });
  assert.deepEqual(attrs["usage.input_tokens"], { intValue: "1" });
  assert.deepEqual(attrs["cost.total_usd"], { doubleValue: 0.5 });

  // The resource is the deployment's own description, and `service.name` is overridable.
  const resource = kv((payload.resourceSpans[0] as { resource: { attributes: unknown } }).resource.attributes);
  assert.deepEqual(resource["service.name"], { stringValue: "loom-test" });
  assert.deepEqual(resource["deployment.environment"], { stringValue: "ci" });
});

test("the nanosecond field is EXACT past Number.MAX_SAFE_INTEGER — the reason it is a BigInt", () => {
  // MEASURED, AND NARROWER THAN THE OBVIOUS CLAIM. `String(ms * 1e6)` is accidentally right:
  // shortest-round-trip formatting prints the decimal that identifies the double rather than
  // the double's value, and over the millisecond range this engine runs in it prints the exact
  // answer. What is wrong is the VALUE, by up to 128 ns, and it becomes visible the moment
  // anything but `String` renders it or anything at all computes with it. Both are reproduced
  // here rather than asserted from the docstring.
  const ms = 1_756_000_000_123;
  const exact = (BigInt(ms) * 1_000_000n).toString();
  assert.equal(exact, "1756000000123000000");
  assert.notEqual(BigInt(ms * 1_000_000).toString(), exact, "if the float product IS the integer, this platform changed and the test measures nothing");
  assert.equal(BigInt(ms * 1_000_000) - BigInt(ms) * 1_000_000n, 64n, "the float product is 64 ns of fabrication");
  assert.equal((ms * 1_000_000).toFixed(0), "1756000000123000064", "toFixed ships the fabricated digits outright");
  // And a duration computed from two float products is wrong for a one-millisecond span.
  assert.equal(BigInt((ms + 1) * 1_000_000) - BigInt(ms * 1_000_000), 999_936n);

  const span: Span = {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    name: "loom.run",
    kind: "internal",
    startTime: ms,
    endTime: ms + 1,
    status: "ok",
    attributes: {},
    links: [],
    events: [],
  };
  const wire = wireSpans(otlpTraceRequest([span]));
  assert.equal(wire[0]!["startTimeUnixNano"], "1756000000123000000", "the collector must see the millisecond the journal recorded, times exactly 1e6");
  assert.equal(wire[0]!["endTimeUnixNano"], "1756000000124000000");
});

test("a non-finite number is a proto3 STRING, because JSON.stringify(NaN) is null", () => {
  // `null` on the wire reads as "this key has no value", which is a different fact from
  // "this measurement went wrong" — and it is the one a dashboard silently averages over.
  const span: Span = {
    traceId: "c".repeat(32),
    spanId: "d".repeat(16),
    name: "loom.model",
    kind: "client",
    startTime: 1,
    endTime: 2,
    status: "unset",
    attributes: { bad: Number.NaN, up: Number.POSITIVE_INFINITY, down: Number.NEGATIVE_INFINITY, big: 2 ** 60, frac: 1.5 },
    links: [],
    events: [],
  };
  const attrs = kv(wireSpans(otlpTraceRequest([span]))[0]!["attributes"]);
  assert.deepEqual(attrs["bad"], { doubleValue: "NaN" });
  assert.deepEqual(attrs["up"], { doubleValue: "Infinity" });
  assert.deepEqual(attrs["down"], { doubleValue: "-Infinity" });
  // `2 ** 60` is an integer JavaScript cannot represent exactly, so calling it an int64
  // would ship a precise-looking value built from an imprecise double.
  assert.deepEqual(attrs["big"], { doubleValue: 2 ** 60 });
  assert.deepEqual(attrs["frac"], { doubleValue: 1.5 });
  assert.equal(JSON.stringify(attrs["bad"]).includes("null"), false, "NaN reached the wire as a JSON null");
});

// ---------------------------------------------------------------------------
// What the exporter must not lose
// ---------------------------------------------------------------------------

test("THE REDACTOR IS IN THE PATH — a credential in the journal is not in the POST body", () => {
  // The end-to-end version of `spans.test.ts`'s URL-credentials test, taken over the bytes
  // that actually leave the machine rather than over the fold. It is a distinct assertion
  // because the defect it guards is a NEW file's, not the fold's: an exporter that folded its
  // own spans, or that reached back to a `JournalEvent` for an attribute the fold dropped,
  // would pass every test in `spans.test.ts` and re-open all of it.
  const URL_MSG = "Request cannot be constructed from a URL that includes credentials: https://svc:hunter2@api.example.com/v1/messages";
  const events: JournalEvent[] = [
    ev(PARENT, 1, "run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "k", configDigest: "c" }, null),
    ev(PARENT, 2, "run.suspended", { reason: `provider unavailable: ${URL_MSG}` }, null),
  ];
  const body = JSON.stringify(otlpTraceRequest(spansFrom(events)));

  assert.equal(body.includes("hunter2"), false, "a live credential was POSTed to the collector");
  assert.equal(body.includes("[redacted]"), true, "the masked form did not survive either — the attribute was lost, not redacted");
  // The host stays legible: it is what an operator debugs a dead provider with, and it is
  // not the secret. Asserting it keeps this test from passing on a span that dropped the bag.
  assert.equal(body.includes("api.example.com"), true);
  // And invariant 8's other direction: the journal still holds the credential, so the span is
  // strictly poorer than the journal and never richer.
  assert.equal(JSON.stringify(events).includes("hunter2"), true);
});

test("a pii attribute with no deployment key is ABSENT from the payload, not tokenised into it", () => {
  // `redactAttributes` OMITS a `pii` attribute when `LOOM_PII_TOKEN_KEY` is unset, rather
  // than emitting a token nobody can reproduce. This suite runs with no key configured, so
  // the assertion here is that the exporter did not resurrect the value from anywhere — the
  // only way `gate.approver` could reappear on the wire is a second read of the journal.
  const spans = spansFrom(fixtureJournal());
  const body = JSON.stringify(otlpTraceRequest(spans));
  assert.equal(body.includes("alice@example.com"), false, "the approver reached the collector in the clear");
  assert.equal(body.includes("oncall@example.com"), false, "the escalation recipients reached the collector in the clear");
});

test("A SUBGRAPH LINK CROSSES TRACES ON THE WIRE — the consumer SpanLink.traceId never had", () => {
  // TODO C.4's actual subject. A child run is a different trace (`traceId` is `digest(runId)`
  // and the child's run id is `${parent}~${taskId}`), so before this file the only thing that
  // ever read `SpanLink.traceId` was the in-process splice. As an OTLP `Link{traceId, spanId}`
  // the join moves to the collector: the parent's span points into the child's own waterfall.
  const parent = spansFrom([
    ev(PARENT, 1, "run.submitted", { workflow: "w", graphHash: "sha256:parent", inputs: {}, idempotencyKey: "k", configDigest: "c" }, null),
    ev(PARENT, 2, "task.ready", { nodeId: "delegate", branchPath: "", edgesIn: [] }, TASK),
    ev(PARENT, 3, "subgraph.started", { childRunId: CHILD, ref: "child-wf", graphHash: "sha256:child", budgetUsd: 2.5 }, TASK),
  ]);
  const sub = parent.find((s) => s.attributes["effect.kind"] === "subgraph")!;
  assert.ok(sub.links.length > 0, "the fold minted no link, so this test is measuring nothing");

  const wire = wireSpans(otlpTraceRequest(parent));
  const wired = wire.find((s) => s["spanId"] === sub.spanId)!;
  const links = wired["links"] as readonly Record<string, string>[];
  assert.equal(links.length, 1);

  // BOTH HALVES, and the trace half is the point: OTLP's SpanContext needs a traceId, and a
  // link carrying only a span id points at nothing a collector can resolve.
  assert.match(links[0]!["traceId"]!, /^[0-9a-f]{32}$/);
  assert.match(links[0]!["spanId"]!, /^[0-9a-f]{16}$/);
  assert.notEqual(links[0]!["traceId"], wired["traceId"], "the child must be a DIFFERENT trace — that is what the field exists for");

  // And it is the child run's own trace id, computed the same way the child's own fold would.
  const childTrace = spansFrom([
    ev(CHILD, 1, "run.submitted", { workflow: "child-wf", graphHash: "sha256:child", inputs: {}, idempotencyKey: "k2", configDigest: "c" }, null),
  ])[0]!.traceId;
  assert.equal(links[0]!["traceId"], childTrace, "the link does not resolve to the trace the child actually emits");
});

test("a same-trace link is filled in with the linking span's own trace, since OTLP needs both halves", () => {
  const span: Span = {
    traceId: "e".repeat(32),
    spanId: "f".repeat(16),
    name: "loom.task",
    kind: "internal",
    startTime: 1,
    endTime: 2,
    status: "ok",
    attributes: {},
    links: [{ spanId: "0123456789abcdef", attributes: { edge: "e1" } }],
    events: [],
  };
  const links = wireSpans(otlpTraceRequest([span]))[0]!["links"] as readonly Record<string, unknown>[];
  assert.equal(links[0]!["traceId"], "e".repeat(32), '"same trace" has to be written down for a collector, not implied');
  assert.deepEqual(kv(links[0]!["attributes"])["edge"], { stringValue: "e1" });
});

test("a malformed span is DROPPED and does not cost its siblings", () => {
  // The ids are the two fields a collector rejects a whole batch over, so one bad span from a
  // hand-built array must not take the run's good ones with it. Four bad shapes, one good.
  const good: Span = {
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    name: "loom.run",
    kind: "internal",
    startTime: 5,
    endTime: 6,
    status: "ok",
    attributes: {},
    links: [],
    events: [],
  };
  const bad = [
    { ...good, traceId: "too-short" },
    { ...good, spanId: "NOTHEX0123456789" },
    { ...good, traceId: "0".repeat(32) }, // all-zero is invalid per OTLP
    { ...good, spanId: "0".repeat(16) },
  ] as Span[];
  const wire = wireSpans(otlpTraceRequest([...bad, good]));
  assert.equal(wire.length, 1, "a malformed span was shipped, or a good one was dropped with it");
  assert.equal(wire[0]!["spanId"], good.spanId);
});

test("a throwing attribute costs ONE attribute, and a throwing bag costs ONE span's bag", () => {
  // Telemetry may drop data (invariant 8); it may not take the POST down. This test was
  // written expecting the finer behaviour and CAUGHT the coarser one: with `Object.entries`
  // the encoder read every value eagerly, so `boom`'s getter threw in the bag-level catch and
  // `fine` — a perfectly readable attribute beside it — was lost too. `Object.keys` plus one
  // guarded read per key is what makes the two assertions below different facts.
  const base = {
    traceId: "3".repeat(32),
    spanId: "4".repeat(16),
    name: "loom.tool",
    kind: "internal" as const,
    startTime: 1,
    endTime: 2,
    status: "ok" as const,
    links: [],
    events: [],
  };
  const throwingValue = {
    ...base,
    attributes: {
      fine: "kept",
      get boom(): unknown {
        throw new Error("getter");
      },
    },
  } as unknown as Span;
  const throwingBag = { ...base, spanId: "5".repeat(16), attributes: new Proxy({}, { ownKeys: () => { throw new Error("ownKeys"); } }) } as unknown as Span;

  const wire = wireSpans(otlpTraceRequest([throwingValue, throwingBag]));
  assert.equal(wire.length, 2, "a throwing attribute cost a whole span");
  assert.deepEqual(kv(wire[0]!["attributes"])["fine"], { stringValue: "kept" });
  assert.equal("boom" in kv(wire[0]!["attributes"]), false);
  assert.deepEqual(wire[1]!["attributes"], [], "an unreadable bag costs the bag, not the batch");
});

test("a container attribute deeper than the cap is dropped rather than walked forever", () => {
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic["self"] = cyclic;
  const span = {
    traceId: "6".repeat(32),
    spanId: "7".repeat(16),
    name: "loom.tool",
    kind: "internal",
    startTime: 1,
    endTime: 2,
    status: "ok",
    attributes: { cyclic, shallow: { a: [1, "two", true] } },
    links: [],
    events: [],
  } as unknown as Span;
  // The assertion is that this RETURNS. A cycle set would also do that; the depth cap is one
  // mechanism for two problems, which is why there is no separate cycle test.
  const attrs = kv(wireSpans(otlpTraceRequest([span]))[0]!["attributes"]);
  assert.deepEqual(attrs["shallow"], { kvlistValue: { values: [{ key: "a", value: { arrayValue: { values: [{ intValue: "1" }, { stringValue: "two" }, { boolValue: true }] } } }] } });
  assert.equal(JSON.stringify(attrs["cyclic"]).includes("loop"), true, "the walk gave up before it reached anything");
});

// ---------------------------------------------------------------------------
// The I/O half
// ---------------------------------------------------------------------------

function stubFetch(reply: () => Response): { fetch: typeof globalThis.fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return reply();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const ok = (): Response => new Response("{}", { status: 200 });

test("both endpoint spellings resolve to one /v1/traces, and the POST is application/json", async () => {
  // `OTEL_EXPORTER_OTLP_ENDPOINT` is the base and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is the
  // full path, so an operator will have one or the other in front of them and both are right.
  for (const endpoint of ["http://collector.example:4318", "http://collector.example:4318/", "http://collector.example:4318/v1/traces"]) {
    const stub = stubFetch(ok);
    const exp = new OtlpHttpExporter({ endpoint, fetch: stub.fetch, headers: { "x-api-key": "k" } });
    assert.equal(exp.url, "http://collector.example:4318/v1/traces", `${endpoint} did not resolve`);
    const res = await exp.export(spansFrom(fixtureJournal()));
    assert.equal(res.ok, true);
    assert.equal(stub.calls[0]!.url, "http://collector.example:4318/v1/traces");
    assert.equal(stub.calls[0]!.init.method, "POST");
    // A `Headers`, NOT A RECORD, since the exporter stopped handing `fetch` an object literal:
    // that conversion silently drops a header named `__proto__`, so the class builds the
    // `Headers` itself with `set`. `new Headers(…)` here accepts either shape, so this assertion
    // survives whichever the implementation hands over.
    const sent = new Headers(stub.calls[0]!.init.headers);
    assert.equal(sent.get("content-type"), "application/json");
    assert.equal(sent.get("x-api-key"), "k");
    // The body is the pure encoder's output verbatim — there is no second encoding path.
    assert.deepEqual(JSON.parse(String(stub.calls[0]!.init.body)), JSON.parse(JSON.stringify(otlpTraceRequest(spansFrom(fixtureJournal())))));
  }
});

test("an empty fold is not POSTed at all", async () => {
  const stub = stubFetch(ok);
  const res = await new OtlpHttpExporter({ endpoint: "http://c:4318", fetch: stub.fetch }).export([]);
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, "empty");
  assert.equal(stub.calls.length, 0, "a round trip was spent saying nothing");
});

test("a 400 is reported with the collector's own sentence, and the endpoint credential is NOT in it", async () => {
  // The endpoint is very often the credential — a vendor key in the userinfo or the path —
  // and `detail` is the field a caller journals. `run/delivery.ts` learned this the expensive
  // way; the same masking is why this exporter has `endpointSecrets`.
  const stub = stubFetch(() => new Response('invalid span: traceId "abc"', { status: 400 }));
  const res = await new OtlpHttpExporter({ endpoint: "https://ingest:S3CRETKEY@otlp.vendor.io/v1/traces", fetch: stub.fetch }).export(
    spansFrom(fixtureJournal()),
  );
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, "status");
  const detail = res.ok === false ? res.detail : "";
  assert.match(detail, /collector returned 400/);
  assert.match(detail, /invalid span/, "the collector's own sentence is the difference between a fixable export and a shrug");
  assert.equal(detail.includes("S3CRETKEY"), false, "the collector credential is in a string the caller will journal");
  assert.equal(detail.includes("ingest"), false);
});

test("a 200 carrying partialSuccess is NOT reported as a clean success", async () => {
  // A collector that took the request and threw half of it away answers 200. Calling that a
  // success is how a broken pipeline stays invisible for months.
  const stub = stubFetch(() => new Response(JSON.stringify({ partialSuccess: { rejectedSpans: 3, errorMessage: "attribute limit" } }), { status: 200 }));
  const res = await new OtlpHttpExporter({ endpoint: "http://c:4318", fetch: stub.fetch }).export(spansFrom(fixtureJournal()));
  assert.equal(res.ok, true);
  assert.equal(res.ok === true && res.rejected, 3);
  assert.equal(res.ok === true && res.message, "attribute limit");
  assert.equal(res.spans, 4, "the count on the wire, which is what `rejected` is a fraction of");

  // An empty body and a non-JSON body both mean "kept everything" — the status line said so,
  // and inventing a rejection from a malformed body is the worse lie.
  for (const body of ["", "not json"]) {
    const s2 = stubFetch(() => new Response(body, { status: 200 }));
    const r2 = await new OtlpHttpExporter({ endpoint: "http://c:4318", fetch: s2.fetch }).export(spansFrom(fixtureJournal()));
    assert.equal(r2.ok === true && r2.rejected, 0, `a ${body === "" ? "empty" : "non-JSON"} 200 body was read as a rejection`);
  }
});

test("EXPORTING NEVER THROWS — an unreachable collector, a hostile options bag, and a bad URL", async () => {
  // The rule this file's header rules a throw out under: an exporter that throws is an
  // exporter that takes a run down over telemetry. Three shapes, all of which a deployment
  // can produce and none of which is a bug in Loom.
  const results: OtlpExportResult[] = [];
  const spans = spansFrom(fixtureJournal());

  results.push(
    await new OtlpHttpExporter({
      endpoint: "https://svc:hunter2@collector.internal:4318",
      fetch: (() => {
        // The message REAL `fetch` produces — it quotes the URL it was handed, credential and
        // all. The stub used to throw a bare "fetch failed", which meant the credential
        // assertion below could not fail: replacing `mask`'s body with `return text` left this
        // whole suite green. A redactor nothing exercises is a redactor nobody can rely on.
        throw new TypeError("request to https://svc:hunter2@collector.internal:4318/v1/traces failed, reason: getaddrinfo ENOTFOUND collector.internal");
      }) as unknown as typeof globalThis.fetch,
    }).export(spans),
  );

  // A getter on the options bag — the shape `WebhookChannel`'s "NOTHING RUNS ABOVE THE TRY"
  // exists for. `timeoutMs` is read inside `export`, so a throwing one is a failed export.
  const hostile = {
    endpoint: "http://c:4318",
    fetch: (async () => ok()) as unknown as typeof globalThis.fetch,
    get timeoutMs(): number {
      throw new Error("config getter");
    },
  };
  results.push(await new OtlpHttpExporter(hostile).export(spans));

  results.push(await new OtlpHttpExporter({ endpoint: "not a url at all" }).export(spans));

  for (const r of results) assert.equal(typeof r.ok, "boolean", "export returned something that is not a result");
  assert.equal(results[0]!.ok, false);
  assert.equal(results[0]!.ok === false && results[0]!.reason, "transport");
  // And the credential in the endpoint is not in the message `fetch` quoted back at us.
  const d0 = results[0]!.ok === false ? results[0]!.detail : "";
  assert.equal(d0.includes("hunter2"), false, "a collector credential reached a string the caller journals");
  assert.equal(d0.includes("[redacted]"), true, "the URL was masked rather than the message being dropped");
  // The HOSTNAME survives, which is `endpointSecrets`'s stated intent and worth pinning: the
  // mask list holds `origin` and `href`, not the bare host, so `ENOTFOUND collector.internal`
  // stays readable. That is what an operator diagnoses a dead collector with, and a host is
  // not a secret.
  assert.equal(d0.includes("ENOTFOUND collector.internal"), true, "the mask ate the diagnosis along with the secret");
  // A throwing `timeoutMs` is caught, not propagated — the export fails, the process does not.
  assert.equal(results[1]!.ok, false);
});

test("a caller's AbortSignal stops the POST, and that is a result rather than a throw", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const stub = stubFetch(ok);
  const fetchThatHonoursAbort = (async (_u: unknown, init: RequestInit) => {
    (init.signal as AbortSignal).throwIfAborted();
    return ok();
  }) as unknown as typeof globalThis.fetch;
  void stub;
  const res = await new OtlpHttpExporter({ endpoint: "http://c:4318", fetch: fetchThatHonoursAbort }).export(spansFrom(fixtureJournal()), ctl.signal);
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, "timeout", "an abort and a timeout are the same fact to a caller: nothing was sent");
});

test("an Object.prototype key is not a span kind, and the fallback fires", () => {
  // `otlpTraceRequest`'s contract is TOTAL OVER ITS INPUT and names hand-built arrays as the
  // reason, so `kind` is a `SpanKind` only by declaration. `KIND_CODE["constructor"]` is a
  // function, not undefined, so the old `?? 0` never fired: `JSON.stringify` then dropped the
  // function-valued `kind` entirely, and `"__proto__"` shipped `kind: {}` — an object where OTLP
  // requires an integer enum. Both reach the wire as this file's opening failure mode, a 200
  // followed by nothing being visible.
  const base = { name: "n", startTime: 1, endTime: 2, attributes: {}, traceId: "a".repeat(32), spanId: "b".repeat(16) };
  const first = (kind: string, status: string): Record<string, unknown> => {
    const payload = otlpTraceRequest([{ ...base, kind, status }] as never, {});
    return JSON.parse(JSON.stringify(payload)).resourceSpans[0].scopeSpans[0].spans[0] as Record<string, unknown>;
  };
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    // Read AFTER the wire encoding, because that is where the inherited value did its damage:
    // a function-valued `kind` simply vanishes from the JSON rather than arriving wrong.
    const span = first(key, key);
    assert.equal(span["kind"], 0, `kind fell back for ${key}`);
    assert.deepEqual(span["status"], { code: 0 }, `status fell back for ${key}`);
  }
  // A real kind is untouched.
  const good = first("client", "error");
  assert.equal(good["kind"], 3);
  assert.deepEqual(good["status"], { code: 2 });
});
