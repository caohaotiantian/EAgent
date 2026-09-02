/**
 * A TRACE LEAVES THE MACHINE — `GET /runs/:id/trace`, over real HTTP.
 *
 * The half of TODO C.4 that is a pull. `spansFrom` folded a full span tree for several waves
 * and the only reader was `loom trace`, on the box holding the journal; these tests bind a
 * socket and fetch one, because "a trace can leave the process" is a protocol property and a
 * unit test of the fold cannot state it.
 *
 * The three things asserted are the three that would make the route useless in different
 * ways: it must be the SAME encoder the exporter uses (or a collector and a console disagree
 * about the same run), it must be scoped like every other run route (or it is an existence
 * oracle and a reconnaissance endpoint), and `?format=otlp` must be the collector's own bytes
 * rather than a lookalike.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BearerTokenIdentity, ControlPlane, type IdentitySource } from "../../src/server/http.ts";
import { otlpTraceRequest } from "../../src/telemetry/otlp.ts";
import { OTLP_RUN_ID_ATTR, OTLP_TRUNCATED_ATTR } from "../../src/telemetry/spans.ts";
import { spansFrom, type Span } from "../../src/telemetry/spans.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import { compileSkeleton, harness, skeletonSpec, DOCS } from "../run/skeleton.ts";

const NOW = 1_700_000_000_000;
const TOKEN = "t0ken";

interface Rig {
  base: string;
  h: ReturnType<typeof harness>;
  close: () => Promise<void>;
}

async function rig(identity?: IdentitySource): Promise<Rig> {
  const h = harness();
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "skeleton-summarize": compileSkeleton(skeletonSpec()) },
    now: () => NOW,
    ...(identity === undefined ? { token: TOKEN } : { identity }),
  });
  const { port } = await plane.listen(0);
  return { base: `http://127.0.0.1:${port}`, h, close: () => plane.close() };
}

const auth = { authorization: `Bearer ${TOKEN}` };

async function submit(r: Rig, headers: Record<string, string> = auth): Promise<RunId> {
  const res = await fetch(`${r.base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
  });
  assert.equal(res.status, 202);
  return ((await res.json()) as { runId: RunId }).runId;
}

/** The fold this process would compute for the same run — the thing the route must agree with. */
async function localFold(r: Rig, runId: RunId): Promise<readonly Span[]> {
  const events: JournalEvent[] = [];
  for await (const e of r.h.store.read(runId, 1 as Seq)) events.push(e);
  return spansFrom(events);
}

test("GET /runs/:id/trace answers the run's span tree, and it is the fold this process computes", async () => {
  const r = await rig();
  try {
    const runId = await submit(r);
    const res = await fetch(`${r.base}/runs/${runId}/trace`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runId: string; traceId: string; spans: Span[]; truncated: boolean };

    const local = await localFold(r, runId);
    assert.ok(local.length > 0, "the run journaled nothing, so this test is measuring nothing");
    // BYTE EQUALITY with the local fold, not a spot check. The route's whole value is that a
    // reader off this machine sees what `loom trace` sees; a route that folded differently —
    // a second fold, the defect `otlp.ts` is built to make impossible — would still answer
    // 200 with plausible spans.
    assert.deepEqual(body.spans, JSON.parse(JSON.stringify(local)));
    assert.equal(body.runId, runId);
    assert.equal(body.traceId, local[0]!.traceId);
    assert.match(body.traceId, /^[0-9a-f]{32}$/);
    assert.equal(body.truncated, false);
  } finally {
    await r.close();
  }
});

test("?format=otlp is the collector's own payload, from the same encoder the exporter POSTs", async () => {
  const r = await rig();
  try {
    const runId = await submit(r);
    const res = await fetch(`${r.base}/runs/${runId}/trace?format=otlp`, { headers: auth });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = (await res.json()) as { resourceSpans: { resource: { attributes: { key: string; value: unknown }[] }; scopeSpans: { spans: Record<string, unknown>[] }[] }[] };

    // The same bytes `otlpTraceRequest` produces for the same fold — so a collector fed by
    // the exporter and a console fed by this route cannot disagree about one run.
    const expected = otlpTraceRequest(await localFold(r, runId), {
      resourceAttributes: { "service.name": "loom", "loom.run_id": runId },
    });
    assert.deepEqual(body, JSON.parse(JSON.stringify(expected)));

    // And it is actually OTLP, checked here rather than trusted from the encoder's own suite:
    // hex ids at OTLP's two widths, nanosecond timestamps as strings, integer enums.
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    assert.ok(spans.length > 0);
    for (const s of spans) {
      assert.match(String(s["traceId"]), /^[0-9a-f]{32}$/);
      assert.match(String(s["spanId"]), /^[0-9a-f]{16}$/);
      assert.equal(typeof s["startTimeUnixNano"], "string");
      assert.equal(typeof s["kind"], "number");
    }
    const resource = new Map(body.resourceSpans[0]!.resource.attributes.map((a) => [a.key, a.value]));
    assert.deepEqual(resource.get("service.name"), { stringValue: "loom" });
    assert.deepEqual(resource.get("loom.run_id"), { stringValue: runId });
  } finally {
    await r.close();
  }
});

test("an unknown format is refused rather than silently answered as spans", async () => {
  const r = await rig();
  try {
    const runId = await submit(r);
    const res = await fetch(`${r.base}/runs/${runId}/trace?format=protobuf`, { headers: auth });
    // Refusing is always allowed. Quietly answering the DEFAULT shape to a caller who asked
    // for a different one is how a client ships a parser for a format it never receives.
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /\?format must be "spans" \(the default\) or "otlp"/);
  } finally {
    await r.close();
  }
});

test("a trace is scoped like every other run route: 404 means no such run, never 'not yours'", async () => {
  const r = await rig();
  try {
    // No credential at all — the plane answers 401 before any handler runs.
    const runId = await submit(r);
    assert.equal((await fetch(`${r.base}/runs/${runId}/trace`)).status, 401);

    // A run that does not exist and a run that is not yours must be indistinguishable, or the
    // route is an existence oracle — and a trace is a richer one than the sibling routes,
    // since it publishes a run's whole shape.
    assert.equal((await fetch(`${r.base}/runs/01JDOESNOTEXIST000000000000/trace`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${r.base}/runs/01JDOESNOTEXIST000000000000/trace?format=otlp`, { headers: auth })).status, 404);
  } finally {
    await r.close();
  }
});

test("SOMEBODY ELSE'S TRACE IS A 404, indistinguishable from a run that does not exist", async () => {
  // The assertion the unknown-id case above cannot make: a shared-token plane grants every
  // caller `operator`, so `ownsRun` is vacuously true there and a route that forgot the check
  // entirely would still pass it. Two named, non-operator subjects make the check load-bearing.
  //
  // A trace is the richest reconnaissance any read route publishes — every node the run
  // touched, every tool it called, how long each took — so this route earns no weaker a scope
  // than `GET /runs/:id`, and it must give the same ANSWER as an unknown id or the 404 itself
  // becomes the oracle.
  const people = new BearerTokenIdentity({
    subjects: [
      { token: "alice-t", subject: "u:alice" },
      { token: "mallory-t", subject: "u:mallory" },
    ],
  });
  const r = await rig(people);
  try {
    const runId = await submit(r, { authorization: "Bearer alice-t" });

    const mine = await fetch(`${r.base}/runs/${runId}/trace`, { headers: { authorization: "Bearer alice-t" } });
    assert.equal(mine.status, 200, "the submitter cannot read their own trace");

    const theirs = await fetch(`${r.base}/runs/${runId}/trace`, { headers: { authorization: "Bearer mallory-t" } });
    const absent = await fetch(`${r.base}/runs/01JDOESNOTEXIST000000000000/trace`, { headers: { authorization: "Bearer mallory-t" } });
    assert.equal(theirs.status, 404);
    assert.equal(absent.status, 404);
    // Same status and the SAME SENTENCE, differing only in the id the caller already typed.
    // A message that said "not yours" — or one that omitted the id only for the run that
    // exists — would put the oracle back in the body after the status line closed it.
    const said = async (res: Response, id: string): Promise<unknown> => {
      const b = (await res.json()) as { error: Record<string, unknown> };
      return { ...b.error, message: String(b.error["message"]).replace(id, "<id>") };
    };
    const forTheirs = await said(theirs, runId);
    assert.deepEqual(forTheirs, await said(absent, "01JDOESNOTEXIST000000000000"));
    assert.deepEqual(forTheirs, { class: "not_found", code: "E_RUN_NOT_FOUND", message: "run <id> not found", retryable: false });
  } finally {
    await r.close();
  }
});

test("truncation is a fact about the batch, and OTLP says it as a resource attribute", async () => {
  const r = await rig();
  try {
    const runId = await submit(r);
    // The `spans` branch has always carried `truncated`; the `otlp` branch dropped it, because
    // `ExportTraceServiceRequest` has no body field for it — so the route's own docstring
    // ("nobody reads a partial waterfall as a finished one") held on one of its two branches.
    // A resource attribute is where OTLP puts a fact about the batch.
    const otlp = (await (await fetch(`${r.base}/runs/${runId}/trace?format=otlp`, { headers: auth })).json()) as {
      resourceSpans: { resource: { attributes: { key: string }[] } }[];
    };
    const keys = otlp.resourceSpans[0]!.resource.attributes.map((a) => a.key);
    assert.ok(keys.includes(OTLP_RUN_ID_ATTR), "the run id attribute is still there");

    // ABSENT, not `false`, for a complete fold — the contract on the constant. This run is well
    // under `MAX_TRACE_EVENTS`, and the `spans` branch agrees:
    const plain = (await (await fetch(`${r.base}/runs/${runId}/trace`, { headers: auth })).json()) as { truncated: boolean };
    assert.equal(plain.truncated, false);
    assert.equal(keys.includes(OTLP_TRUNCATED_ATTR), false, "an absent attribute and false say the same thing");

    // The name is spelled once, in the file that owns the `loom.*` vocabulary, and this pins it
    // against a second spelling appearing at the route — the defect `registries.test.ts` caught
    // for `loom.run_id`.
    assert.equal(OTLP_TRUNCATED_ATTR, "loom.trace.truncated");
  } finally {
    await r.close();
  }
});
