/**
 * The SSE stream's channel values, over real HTTP.
 *
 * `server/http.ts` promises that what crosses this process boundary is "redacted per the
 * GRAPH's declared classification". A previous fix made that true of the two gate routes and
 * left it false everywhere else, including on the one route the console actually watches.
 * `GET /runs/:id/events` emits exactly two frame kinds and BOTH carried channel values in the
 * clear:
 *
 *   - the `snapshot` frame, which is `summarise(p)` — a blanket `redactPayload(…, "internal")`
 *     over `p.channels` and `p.outputs`;
 *   - every `event` frame, which is `frame(e)` — `redactPayload(e.payload, e.classification)`,
 *     and `e.classification` is `internal` on every event this runtime has ever written,
 *     because `journal/store.ts` defaults it and NOTHING sets it.
 *
 * `internal` is the detector backstop alone. It knows a credential SHAPE and nothing about
 * what the graph declared, so every value here is DELIBERATELY not credential-shaped —
 * ordinary prose and an email address. Measured on the broken build, one run:
 *
 *     snapshot  "channels":{…,"owner":"ada@example.com","vaultHint":"the vault passphrase …"}
 *     event     run.submitted "inputs":{…,"owner":"ada@example.com","vaultHint":"the vault …"}
 *
 * A redactor that redacts everything is not a redactor and a stream that drops events is not
 * a stream, so every test asserts both halves: the classified values are gone AND the public
 * one, the unclassified one, and every piece of event METADATA arrive intact.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import type { RunProjection } from "../../src/run/projection.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { ControlPlane } from "../../src/server/http.ts";

const NOW = 1_700_000_000_000;

/**
 * The values, and why each one is the shape it is.
 *
 * NONE OF THE WITHHELD ONES IS CREDENTIAL-SHAPED. `sk-live-…` would have made every assertion
 * below pass on the broken build, because `DETECTORS` catches the prefix without consulting a
 * classification — the test would have been about `redact.ts` rather than about this route.
 * `PERSON` is the same argument from the other side: an email address is what the `internal`
 * sweep demonstrably does NOT catch, measured, so it is the sharpest `pii` probe available.
 */
const SECRET = "the vault passphrase is grandmothers pocket watch";
const PERSON = "ada@example.com";
const RECEIPT = "the courier will knock three times";
const PUBLIC = "quarterly refresh";
const NOTE = "ordinary note";

const resolver: ResourceResolver = {
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
};

/**
 * One function node, six channels, and a run that is driven to `succeeded`.
 *
 * It has to COMPLETE, because the five journal payload keys `CHANNEL_KEYED` names are spread
 * across the run's whole life: `run.submitted.inputs` at the start, `gate.decided.writes` when
 * a human answers, `task.committed.writes` when the node proposes, `state.reduced.values` when
 * the reducer folds them, and `run.completed.outputs` at the end. A run parked on a gate would
 * only ever exercise the first.
 */
function streamSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "streamed", project: "demo", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      topic: { type: "string", reduce: "replace", classification: "public" },
      vaultHint: { type: "string", reduce: "replace", classification: "secret_ref" },
      owner: { type: "string", reduce: "replace", classification: "pii" },
      note: { type: "string", reduce: "replace" },
      // WRITTEN BY THE NODE, not submitted — so it appears in `state.reduced.values` and in
      // `run.completed.outputs` and never in `run.submitted.inputs`. Without a written
      // classified channel, two of the three keys would go untested.
      receipt: { type: "string", reduce: "replace", classification: "secret_ref" },
      summary: { type: "string", reduce: "replace" },
    },
    inputs: ["topic", "vaultHint", "owner", "note"],
    outputs: ["receipt", "summary"],
    nodes: [{ id: "emit", type: "function", reads: ["topic"], writes: ["receipt", "summary"], function: { ref: "function/emit@stable" } }],
    edges: [],
  } as unknown as GraphSpec;
}

/**
 * Poll the projection until it reaches `want`, or fail loudly.
 *
 * POLLING, NOT A `setTimeout` OF SOME CHOSEN LENGTH: the engine is driven by an injected
 * clock that never advances, so there is no wall-clock duration this could wait for. The loop
 * bound is a hang guard, and reaching it is a test failure with the status it got stuck on
 * rather than a silent pass on an empty projection.
 */
async function settle(engine: Engine, runId: RunId, want: string): Promise<RunProjection> {
  for (let i = 0; i < 400; i++) {
    const p = await engine.projection(runId);
    if (p?.status === want) return p;
    await new Promise((res) => setTimeout(res, 5));
  }
  const p = await engine.projection(runId);
  assert.fail(`run never reached ${want}; it is ${String(p?.status)}`);
}

interface Rig {
  readonly base: string;
  readonly runId: string;
  /**
   * THE GATE-DECISION REPLY, kept rather than thrown away.
   *
   * It is one of the six routes `#summary` answers and the only one that cannot be re-fetched
   * afterwards: an approver sees this body once. `summarise` served the run's gates raw, so
   * this is the response in which an approver's own edit came back in the clear.
   */
  readonly decided: Record<string, unknown>;
  readonly close: () => Promise<void>;
}

/**
 * A plane over a completed run of `streamSpec`.
 *
 * `blind` gives back a SECOND plane that holds no graph; `graph` swaps in a doctored one.
 * Both are variations on the same fixture rather than a second copy of it, because the run
 * has to be driven through a gate to reach `state.reduced` and a second spelling of that
 * would be the first thing to drift.
 */
async function rig(opts: { readonly blind?: boolean; readonly graph?: (g: RunGraph) => RunGraph; readonly decision?: unknown } = {}): Promise<Rig> {
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const bus = new InProcessEventBus({ store });
  const functions = new FunctionRegistry();
  functions.register("function/emit@stable", () => ({ writes: { receipt: RECEIPT, summary: NOTE } }));
  const engine = new Engine({
    store,
    bus,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    sleep: async () => {},
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 1 } },
  });
  const clean = compileOrThrow({ spec: streamSpec(), resolver, tools: {}, tenantCapabilities: [] });
  const graph = opts.graph === undefined ? clean : opts.graph(clean);

  // THE SUBMITTING PLANE ALWAYS HOLDS THE GRAPH — `POST /runs` looks the workflow up in
  // `#graphs`, so a plane with none cannot start a run at all. The blind case is therefore a
  // SECOND plane over the same store and engine, which is also the honest shape: a run
  // submitted by another process, or a plane restarted with a different inventory.
  const submitter = new ControlPlane({ engine, store, bus, graphs: { streamed: graph }, now });
  const { port: sPort } = await submitter.listen(0);
  const accepted = (await (
    await fetch(`http://127.0.0.1:${sPort}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "streamed", inputs: { topic: PUBLIC, vaultHint: SECRET, owner: PERSON, note: NOTE } }),
    })
  ).json()) as { runId: string };

  // THE GATE IS NOT INCIDENTAL — IT IS THE CLASSIFICATION ITSELF. `emit` WRITES a `secret_ref`
  // channel, so `dataFloorOf` floors the node at posture `in` and the policy raises a gate on
  // it. That is the same declaration this suite is about, seen from the other side: the word
  // that stops the run is the word that must withhold the value. Approving it is what carries
  // the fixture through `state.reduced` and `run.completed`.
  const base = `http://127.0.0.1:${sPort}`;
  const open = await settle(engine, accepted.runId as RunId, "awaiting_gate");
  const gateId = Object.values(open.gates).find((g) => g.state === "open")?.gateId;
  assert.ok(gateId !== undefined, "the fixture never raised the gate the secret_ref write demands");
  const answered = await fetch(`${base}/runs/${accepted.runId}/gates/${gateId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: opts.decision ?? { kind: "approve" } }),
  });
  assert.equal(answered.status, 200, "the fixture could not answer its own gate");
  const decided = (await answered.json()) as Record<string, unknown>;
  const done = await settle(engine, accepted.runId as RunId, "succeeded");
  assert.equal(done.status, "succeeded", "the fixture run did not complete; every assertion below would be vacuous");

  if (opts.blind !== true) {
    return { base, runId: accepted.runId, decided, close: () => submitter.close() };
  }
  const blind = new ControlPlane({ engine, store, bus, graphs: {}, now });
  const { port } = await blind.listen(0);
  return {
    base: `http://127.0.0.1:${port}`,
    runId: accepted.runId,
    decided,
    close: async () => {
      await blind.close();
      await submitter.close();
    },
  };
}

interface Frame {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/**
 * Every SSE frame the route emits, parsed, up to a CONTENT condition.
 *
 * IT STOPS ON WHAT ARRIVED, NOT ON A TIMER. The handler's live loop breaks on `run.completed`,
 * but a run that finished BEFORE the connection opened is delivered entirely by the baseline
 * — replay or snapshot — after which the handler parks on a subscription that will never fire,
 * so the reader has to decide it is done. Waiting a fixed number of milliseconds instead would
 * make this suite wall-clock dependent, which the project forbids.
 *
 * AND THE CONDITION DIFFERS BY BRANCH, which is the point of taking it as an argument: the
 * replay branch ends with the run's terminal EVENT, while the snapshot branch emits ONE frame
 * — `summarise` — and then tails, so waiting for a `run.completed` event there waits forever.
 * The `AbortController` is only a backstop against a hang.
 */
async function frames(base: string, path: string, done: (fs: Frame[]) => boolean = sawCompletion): Promise<Frame[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5_000);
  try {
    const res = await fetch(`${base}${path}`, { signal: ctl.signal });
    assert.equal(res.status, 200, `${path} answered ${res.status}`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const out: Frame[] = [];
    const flush = (): boolean => {
      let cut = buf.indexOf("\n\n");
      while (cut !== -1) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let name = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) name = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (data !== "") out.push({ event: name, data: JSON.parse(data) as Record<string, unknown> });
        cut = buf.indexOf("\n\n");
      }
      return done(out);
    };
    while (!flush()) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return out;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

/** The replay branch is finished when the run's terminal event has arrived. */
const sawCompletion = (fs: Frame[]): boolean => fs.some((f) => f.event === "event" && f.data["type"] === "run.completed");
/** The snapshot branch emits one baseline frame and then tails a run that is already over. */
const sawSnapshot = (fs: Frame[]): boolean => fs.some((f) => f.event === "snapshot");

const payloadOf = (fs: Frame[], type: string): Record<string, unknown> => {
  const f = fs.find((x) => x.event === "event" && x.data["type"] === type);
  assert.ok(f !== undefined, `the stream never delivered a ${type} event`);
  return f.data["payload"] as Record<string, unknown>;
};

/** The replay branch. A fresh connection to a run under `hotWindow` events comes through here. */
const REPLAY = (id: string): string => `/runs/${id}/events`;
/** The snapshot branch. An id this run never issued is unresumable, so the baseline is `summarise`. */
const SNAPSHOT = (id: string): string => `/runs/${id}/events?lastEventId=999999`;

// ── the event frames ──────────────────────────────────────────────────────────────────────

test("EVERY CHANNEL-KEYED JOURNAL PAYLOAD IS REDACTED ON THE STREAM — and the other two classifications are not", async () => {
  // Measured on the broken build, `GET /runs/:id/events`:
  //
  //     event run.submitted "inputs":{…,"owner":"ada@example.com","vaultHint":"the vault …"}
  //
  // `CHANNEL_KEYED` names exactly three payload keys, so all three are asserted rather than
  // sampled: a claim that names its members can be checked.
  const r = await rig();
  try {
    const fs = await frames(r.base, REPLAY(r.runId));

    const inputs = payloadOf(fs, "run.submitted")["inputs"] as Record<string, unknown>;
    assert.equal(inputs["vaultHint"], "[secret]", "run.submitted.inputs served the secret_ref channel");
    assert.match(String(inputs["owner"]), /^pii:[0-9a-f]{12}:string$/, "run.submitted.inputs did not tokenise the pii channel");
    assert.equal(inputs["topic"], PUBLIC, "run.submitted.inputs redacted a public channel");
    assert.equal(inputs["note"], NOTE, "run.submitted.inputs redacted an unclassified channel");

    // THE PROPOSAL, ONE EVENT BEFORE THE FOLD. An earlier draft of `CHANNEL_KEYED` had
    // `state.reduced` and not `task.committed`, and the same secret went out at seq 14
    // instead of seq 15. This assertion is why that draft did not survive.
    const writes = payloadOf(fs, "task.committed")["writes"] as Record<string, unknown>;
    assert.equal(writes["receipt"], "[secret]", "task.committed.writes served the secret_ref channel a node proposed");
    assert.equal(writes["summary"], NOTE, "task.committed.writes redacted an unclassified channel");

    const reduced = payloadOf(fs, "state.reduced");
    const values = reduced["values"] as Record<string, unknown>;
    assert.equal(values["receipt"], "[secret]", "state.reduced.values served a secret_ref channel the NODE wrote");
    assert.equal(values["summary"], NOTE, "state.reduced.values redacted an unclassified channel");
    // The sibling `channels` field is the list of NAMES, which is metadata: a reader who
    // cannot see WHICH channels moved cannot follow the run at all.
    assert.deepEqual([...(reduced["channels"] as string[])].sort(), ["receipt", "summary"]);

    const outputs = payloadOf(fs, "run.completed")["outputs"] as Record<string, unknown>;
    assert.equal(outputs["receipt"], "[secret]", "run.completed.outputs served the secret_ref channel");
    assert.equal(outputs["summary"], NOTE, "run.completed.outputs redacted an unclassified channel");

    // AND NOWHERE ELSE ON THE STREAM. The three keys above are a claim about which payloads
    // carry channel data; this is the check that the claim is complete for this fixture.
    const whole = JSON.stringify(fs);
    assert.equal(whole.includes(SECRET), false, "the secret_ref input reached the stream somewhere else");
    assert.equal(whole.includes(RECEIPT), false, "the secret_ref output reached the stream somewhere else");
    assert.equal(whole.includes(PERSON), false, "the pii value reached the stream somewhere else");
  } finally {
    await r.close();
  }
});

test("THE STREAM IS STILL A STREAM — redaction touches values, never events or their metadata", async () => {
  // The failure mode on the other side: a route that answers a disclosure by withholding the
  // run. Every event still arrives, in order, with its seq, its type and its actor — which is
  // what a console needs to render anything at all.
  const r = await rig();
  try {
    const fs = await frames(r.base, REPLAY(r.runId));
    const events = fs.filter((f) => f.event === "event");
    assert.ok(events.length >= 4, `the stream delivered ${events.length} events`);

    const seqs = events.map((f) => f.data["seq"] as number);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "the stream delivered events out of order");
    assert.deepEqual(seqs, [...new Set(seqs)], "the stream delivered an event twice");
    assert.equal(seqs[0], 1, "the replay branch skipped the head of the journal");

    for (const f of events) {
      assert.equal(typeof f.data["type"], "string");
      assert.equal(typeof f.data["ts"], "number");
      assert.ok(f.data["actor"] !== undefined, `event ${String(f.data["type"])} lost its actor`);
    }
    // Metadata inside a channel-keyed payload survives too: `run.submitted` carries the
    // workflow name and the graph hash beside its `inputs`, and a console keys on both.
    const submitted = payloadOf(fs, "run.submitted");
    assert.equal(submitted["workflow"], "streamed");
    assert.match(String(submitted["graphHash"]), /^sha256:[0-9a-f]{64}$/);
    // A payload with no channel data at all is untouched.
    assert.equal(typeof payloadOf(fs, "run.compiled")["nodes"], "number");
  } finally {
    await r.close();
  }
});

// ── the snapshot frame ────────────────────────────────────────────────────────────────────

test("THE SNAPSHOT FRAME IS REDACTED TOO — it is `summarise`, and so are five other routes", async () => {
  // The snapshot is the SAME function `GET /runs/:id` answers with, which is why the fix is
  // at `summarise`'s definition and not at this call site: a fix per route is how `listRuns`
  // came to be filtered at two of three sites, in this same file.
  const r = await rig();
  try {
    const fs = await frames(r.base, SNAPSHOT(r.runId), sawSnapshot);
    const snap = fs.find((f) => f.event === "snapshot");
    assert.ok(snap !== undefined, "the unresumable id did not produce a snapshot");

    for (const [where, map] of [
      ["channels", snap.data["channels"] as Record<string, unknown>],
      ["outputs", snap.data["outputs"] as Record<string, unknown>],
    ] as const) {
      if (where === "channels") {
        assert.equal(map["vaultHint"], "[secret]", "the snapshot served the secret_ref channel");
        assert.match(String(map["owner"]), /^pii:[0-9a-f]{12}:string$/, "the snapshot did not tokenise the pii channel");
        assert.equal(map["topic"], PUBLIC, "the snapshot redacted a public channel");
      }
      assert.equal(map["receipt"], "[secret]", `the snapshot served the secret_ref value in ${where}`);
      assert.equal(map["summary"], NOTE, `the snapshot redacted an unclassified channel in ${where}`);
    }

    // AND THE SNAPSHOT IS STILL THE BASELINE A CLIENT RESUMES FROM.
    assert.equal(snap.data["status"], "succeeded");
    assert.equal(typeof snap.data["seq"], "number");
    assert.ok(Array.isArray(snap.data["tasks"]) && (snap.data["tasks"] as unknown[]).length >= 1, "the snapshot lost the run's tasks");

    // The same object, on the route that has always been the obvious one to check.
    const one = (await (await fetch(`${r.base}/runs/${r.runId}`)).json()) as { channels: Record<string, unknown> };
    assert.equal(one.channels["vaultHint"], "[secret]", "GET /runs/:id served the secret_ref channel");
    assert.equal(one.channels["topic"], PUBLIC, "GET /runs/:id redacted a public channel");
  } finally {
    await r.close();
  }
});

// ── the fail-closed half ──────────────────────────────────────────────────────────────────

test("A PLANE THAT DOES NOT HOLD THE GRAPH WITHHOLDS EVERY CHANNEL VALUE — and still delivers every event", async () => {
  // "Refusing is always allowed; loosening never is." A plane that cannot look the graph up
  // cannot know which of these names is a credential, and the alternative — falling back to
  // `internal` — IS the leak being fixed. What it costs is bounded and stated: the seq, the
  // type, the actor and the task of every event still arrive, so the run is still followable.
  const r = await rig({ blind: true });
  try {
    const fs = await frames(r.base, REPLAY(r.runId));
    const inputs = payloadOf(fs, "run.submitted")["inputs"] as Record<string, unknown>;
    assert.deepEqual(inputs, { topic: "[secret]", vaultHint: "[secret]", owner: "[secret]", note: "[secret]" });
    assert.deepEqual(payloadOf(fs, "run.completed")["outputs"], { receipt: "[secret]", summary: "[secret]" });

    // The events themselves are all still there.
    const types = fs.filter((f) => f.event === "event").map((f) => f.data["type"]);
    assert.ok(types.includes("run.submitted") && types.includes("run.completed"), `the blind plane delivered ${types.join(", ")}`);
    assert.equal(payloadOf(fs, "run.submitted")["workflow"], "streamed", "the blind plane withheld metadata, not just values");

    const snap = (await frames(r.base, SNAPSHOT(r.runId), sawSnapshot)).find((f) => f.event === "snapshot");
    assert.deepEqual(snap!.data["channels"], {
      topic: "[secret]",
      vaultHint: "[secret]",
      owner: "[secret]",
      note: "[secret]",
      receipt: "[secret]",
      summary: "[secret]",
    });
    assert.equal(snap!.data["status"], "succeeded", "the blind plane withheld the run's status");
  } finally {
    await r.close();
  }
});

// ── the unknown classification ────────────────────────────────────────────────────────────

/**
 * The same compiled graph, with ONE channel carrying a classification the vocabulary has
 * never heard.
 *
 * `graphHash` is deliberately left alone: it is the hash of the CLEAN spec, which is exactly
 * the story — computed by a build whose validator did not have the check yet. `#graphByHash`
 * scans by that hash and re-validates nothing on the way past.
 */
function fromAnOlderBuild(g: RunGraph): RunGraph {
  const channels = g.spec.channels as unknown as Record<string, Record<string, unknown>>;
  return {
    ...g,
    spec: { ...g.spec, channels: { ...channels, note: { ...channels["note"], classification: "confidential" } } } as unknown as GraphSpec,
  };
}

test("A CLASSIFICATION THE VOCABULARY HAS NEVER HEARD IS WITHHELD ON THE STREAM, not read as `internal`", async () => {
  // `validate.ts` gained `GRAPH003_UNKNOWN_CLASSIFICATION` and refuses the word at compile —
  // including in a resolved CHILD spec, measured. What it does not cover is the graph objects
  // `ControlPlane` is HANDED: `ControlPlaneOptions.graphs` takes already-compiled `RunGraph`s
  // and re-validates nothing, so a graph compiled by an older build still reaches the
  // redactor with an unreadable word. `===` against a non-member is false everywhere, which
  // is `redact.ts`'s own fail-open, so the value would go out in the clear.
  //
  // `note` is the channel doctored, and it is the UNCLASSIFIED one in every other test here —
  // so the assertion below is exactly the difference the unreadable word makes.
  const r = await rig({ graph: fromAnOlderBuild });
  try {
    const fs = await frames(r.base, REPLAY(r.runId));
    const inputs = payloadOf(fs, "run.submitted")["inputs"] as Record<string, unknown>;
    assert.equal(inputs["note"], "[secret]", "an unreadable classification was read as `internal` and served in the clear");
    // The control, in the same run: the four real classifications still decide, and two of
    // them are not redactions.
    assert.equal(inputs["topic"], PUBLIC, "the unknown-classification arm redacted a public channel too");
    assert.equal(inputs["vaultHint"], "[secret]");
    assert.match(String(inputs["owner"]), /^pii:[0-9a-f]{12}:string$/);
  } finally {
    await r.close();
  }
});

test("AN APPROVER'S EDIT IS REDACTED TOO — `gate.decided.writes` is channel values a HUMAN typed", async () => {
  // The fifth member of `CHANNEL_KEYED`, and the one most easily argued away: "the approver
  // already knows what they typed". They do — and everyone else watching the run's stream did
  // not. `allowEdit` names which channels a gate may rewrite, and on this graph both of them
  // are declared, one `secret_ref` and one not.
  const EDITED = "the second courier knocks twice";
  const r = await rig({ decision: { kind: "edit", writes: { receipt: EDITED, summary: NOTE } } });
  try {
    const fs = await frames(r.base, REPLAY(r.runId));
    const decided = payloadOf(fs, "gate.decided");
    assert.equal(decided["decision"], "edit", "the fixture did not record an edit");
    const writes = decided["writes"] as Record<string, unknown>;
    assert.equal(writes["receipt"], "[secret]", "gate.decided.writes served the secret_ref channel an approver typed");
    assert.equal(writes["summary"], NOTE, "gate.decided.writes redacted an unclassified channel");
    assert.equal(JSON.stringify(fs).includes(EDITED), false, "the edited secret reached the stream somewhere else");
  } finally {
    await r.close();
  }
});

// ── the gate RECORD, which is not the gate PAYLOAD ────────────────────────────────────────

/**
 * `summarise` sends `gates`, and a gate record carries channel data.
 *
 * `GateRecord.writes` is documented at `projection.ts:129` as "`edit` only: the channels the
 * human wrote" — the same map `gate.decided.writes` carries on the event stream, folded into
 * the projection. The event was redacted one wave ago and the FOLDED COPY four lines below
 * that edit was not: `gates: Object.values(p.gates)` had no redaction at all, not even the
 * blanket `internal` sweep the rest of `summarise` used to have. Measured over real HTTP on
 * one response body, before:
 *
 *     "gates":[{…,"writes":{"receipt":"the second courier knocks twice", …}}]
 *     "channels":{…,"receipt":"[secret]"},"outputs":{"receipt":"[secret]"}
 *
 * Two keys apart, one value, one redacted and one not.
 */
const EDIT = { kind: "edit", writes: { receipt: "the second courier knocks twice", summary: NOTE } } as const;

/** The one gate on the fixture run, off any body `summarise` produced. */
function gatesOf(body: Record<string, unknown>): Record<string, unknown> {
  const gates = body["gates"];
  assert.ok(Array.isArray(gates) && gates.length === 1, `the body carried ${JSON.stringify(gates)} instead of one gate`);
  return gates[0] as Record<string, unknown>;
}

test("AN APPROVER'S EDIT IS REDACTED IN THE `gates` SLICE — on every route that answers with a projection", async () => {
  const r = await rig({ decision: EDIT });
  try {
    // FOUR OF THE SIX `#summary` ROUTES, exercised as four different HTTP exchanges rather
    // than by calling `summarise` twice: the defect this covers was a fix applied at one call
    // site and missed at another, which is precisely what a unit test on the function cannot
    // catch. The remaining two are the other two command kinds, which reach `#summary` on the
    // same line as `advance`.
    const one = (await (await fetch(`${r.base}/runs/${r.runId}`)).json()) as Record<string, unknown>;
    const cmd = await fetch(`${r.base}/runs/${r.runId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "advance" }),
    });
    assert.equal(cmd.status, 200, "the command route did not answer with a projection");
    const commanded = (await cmd.json()) as Record<string, unknown>;
    const snap = (await frames(r.base, SNAPSHOT(r.runId), sawSnapshot)).find((f) => f.event === "snapshot");
    assert.ok(snap !== undefined, "the unresumable id did not produce a snapshot");

    for (const [route, body] of [
      ["GET /runs/:id", one],
      ["the gate-decision reply", r.decided],
      ["POST /runs/:id/commands", commanded],
      ["the SSE snapshot frame", snap.data],
    ] as const) {
      const writes = gatesOf(body)["writes"] as Record<string, unknown>;
      assert.equal(writes["receipt"], "[secret]", `${route} served the secret_ref channel an approver typed`);
      // THE CONTROL, IN THE SAME MAP: a redactor that redacts everything is not a redactor,
      // and `summary` is declared with no classification — the documented `internal` default.
      assert.equal(writes["summary"], NOTE, `${route} redacted an unclassified channel in a gate's writes`);
      assert.equal(JSON.stringify(body).includes(EDIT.writes.receipt), false, `${route} carried the edited secret somewhere else`);
    }
  } finally {
    await r.close();
  }
});

test("A GATE IS STILL A GATE — the record's metadata survives the sweep", async () => {
  // The failure on the other side. Every field but `writes` is metadata this process authored
  // — which node, which task, who may answer, what was decided — and an oversight queue that
  // withholds it is a queue nobody can act on. `contentDigest` is the sharpest probe here: it
  // is the one long opaque string on the record, and a sweep that mangled it would break the
  // only thing that tells two raisings of one question apart.
  const r = await rig({ decision: EDIT });
  try {
    const g = gatesOf((await (await fetch(`${r.base}/runs/${r.runId}`)).json()) as Record<string, unknown>);
    assert.match(String(g["gateId"]), /^gate_[0-9A-Z]+$/, "the gate lost its id");
    assert.equal(g["nodeId"], "emit");
    assert.equal(g["taskId"], "emit@root#0");
    assert.equal(g["state"], "decided");
    assert.equal(g["decision"], "edit");
    assert.equal(g["decidedBy"], "human", "a reader can no longer tell a human's decision from a component's");
    assert.deepEqual(g["allowEdit"], ["receipt", "summary"], "the record lost which channels the edit was allowed to write");
    assert.equal(g["tier"], 0);
    assert.match(String(g["contentDigest"]), /^sha256:[0-9a-f]{64}$/, "the internal sweep mangled the content digest");
    assert.equal(typeof g["raisedAtSeq"], "number");

    // AND THE TWO GATE ROUTES BUILD THE SAME RECORD, THROUGH THE SAME FUNCTION. `gateWire`
    // spread `{...g}` unredacted; that only ever escaped notice because both routes filter to
    // OPEN gates (`state === "open"`), where `writes` is absent by construction — a redaction
    // that holds because of a filter somewhere else is not a redaction. THIS ASSERTION IS A
    // TRIPWIRE AND NOT A PROOF, and it says so rather than reading like one: on this fixture
    // the queue is EMPTY, which is asserted first so the loop below cannot pass vacuously
    // without a reader noticing. The day the filter admits a decided gate, the loop is what
    // catches the spread coming back.
    const listed = (await (await fetch(`${r.base}/runs/${r.runId}/gates`)).json()) as { gates: Record<string, unknown>[] };
    assert.ok(Array.isArray(listed.gates), "GET /runs/:id/gates stopped answering with a list");
    assert.equal(listed.gates.length, 0, "the queue listed a decided gate; the loop below is now the live check");
    for (const gate of listed.gates) {
      assert.match(String(gate["gateId"]), /^gate_[0-9A-Z]+$/, "the gate route lost the gate's id");
      assert.equal(JSON.stringify(gate).includes(EDIT.writes.receipt), false, "the gate route served an approver's edited secret");
    }
  } finally {
    await r.close();
  }
});

// ── a fan-out's per-branch item ───────────────────────────────────────────────────────────

/**
 * `task.ready.binding` is a `{channel, value}` PAIR, and the derivation that produced
 * `CHANNEL_KEYED` could not see it.
 *
 * That set was found by grepping `journal/events.ts` for `Record<string, unknown>`, which is
 * complete for MAP-shaped payload fields and structurally blind to one channel and its value
 * declared as a pair (`events.ts:168`). So `frame` swept this at `e.classification` — a
 * blanket `internal`, the detector backstop — and the per-branch item of a fan-out over a
 * `secret_ref` channel went onto the SSE stream in full. Measured, before:
 *
 *     "type":"task.ready","payload":{"binding":{"channel":"item","value":"courier alpha knocks three times"},…}
 *
 * The fixture fans TWICE from one node — once over a `secret_ref` list into a `secret_ref`
 * item channel, once over a `public` list into a `public` one — so the withheld value and the
 * control are two branches of the same run, redacted by one lookup table.
 */
const FAN_SECRET = "courier alpha knocks three times";
const FAN_PUBLIC = "quarterly refresh";

function fanSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "fanned", project: "demo", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      secrets: { type: "array", reduce: "replace", classification: "secret_ref" },
      topics: { type: "array", reduce: "replace", classification: "public" },
      // THE ITEM CHANNELS. `graph/validate.ts` refuses `GRAPH007_UNKNOWN_ITEM` for a fanout
      // that binds items to an undeclared channel — "the per-branch item is a real channel" —
      // so each one carries its own classification and that is what the wire looks up.
      item: { type: "string", reduce: "replace", classification: "secret_ref" },
      topicItem: { type: "string", reduce: "replace", classification: "public" },
      findings: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["secrets", "topics"],
    outputs: ["findings"],
    nodes: [
      { id: "start", type: "function", reads: ["topics"], function: { ref: "function/seed@stable" } },
      // NEITHER BRANCH NODE READS THE SECRET, deliberately: a node that read `item` would be
      // floored at posture `in` and the run would park on a gate, which is a different test.
      // The binding is journaled on `task.ready` whatever the node reads.
      { id: "handle", type: "function", writes: ["findings"], function: { ref: "function/handle@stable" } },
      { id: "tag", type: "function", writes: ["findings"], function: { ref: "function/tag@stable" } },
      {
        id: "gatherS",
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        join: { branches: ["handle"], mode: "all", onBranchError: "skip", timeoutMs: 1000 },
      },
      {
        id: "gatherP",
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        join: { branches: ["tag"], mode: "all", onBranchError: "skip", timeoutMs: 1000 },
      },
    ],
    edges: [
      { id: "fs", from: "start", to: "handle", kind: "fanout", over: "secrets", as: "item", maxWidth: 2 },
      { id: "fp", from: "start", to: "tag", kind: "fanout", over: "topics", as: "topicItem", maxWidth: 2 },
      { id: "js", from: "handle", to: "gatherS", kind: "join", branches: ["handle"] },
      { id: "jp", from: "tag", to: "gatherP", kind: "join", branches: ["tag"] },
    ],
  } as unknown as GraphSpec;
}

/** A plane over a completed run of `fanSpec`. `blind` gives back a plane holding no graph. */
async function fanRig(opts: { readonly blind?: boolean } = {}): Promise<Rig> {
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const bus = new InProcessEventBus({ store });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/handle@stable", () => ({ writes: { findings: ["handled"] } }));
  functions.register("function/tag@stable", () => ({ writes: { findings: ["tagged"] } }));
  const engine = new Engine({
    store,
    bus,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    sleep: async () => {},
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 1 } },
  });
  const graph = compileOrThrow({ spec: fanSpec(), resolver, tools: {}, tenantCapabilities: [] });
  const submitter = new ControlPlane({ engine, store, bus, graphs: { fanned: graph }, now });
  const { port: sPort } = await submitter.listen(0);
  const accepted = (await (
    await fetch(`http://127.0.0.1:${sPort}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "fanned", inputs: { secrets: [FAN_SECRET], topics: [FAN_PUBLIC] } }),
    })
  ).json()) as { runId: string };
  const done = await settle(engine, accepted.runId as RunId, "succeeded");
  assert.equal(done.status, "succeeded", "the fan-out fixture did not complete; every assertion below would be vacuous");
  const decided = {};
  if (opts.blind !== true) {
    return { base: `http://127.0.0.1:${sPort}`, runId: accepted.runId, decided, close: () => submitter.close() };
  }
  const blind = new ControlPlane({ engine, store, bus, graphs: {}, now });
  const { port } = await blind.listen(0);
  return {
    base: `http://127.0.0.1:${port}`,
    runId: accepted.runId,
    decided,
    close: async () => {
      await blind.close();
      await submitter.close();
    },
  };
}

/** Every `task.ready` binding on the stream, by the channel it names. */
function bindings(fs: Frame[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const f of fs) {
    if (f.event !== "event" || f.data["type"] !== "task.ready") continue;
    const b = (f.data["payload"] as Record<string, unknown>)["binding"] as Record<string, unknown> | undefined;
    if (b !== undefined) out.set(String(b["channel"]), b);
  }
  return out;
}

test("A FAN-OUT'S PER-BRANCH ITEM IS REDACTED ON THE STREAM — and the `public` one is not", async () => {
  const r = await fanRig();
  try {
    const fs = await frames(r.base, REPLAY(r.runId));
    const bound = bindings(fs);
    assert.deepEqual([...bound.keys()].sort(), ["item", "topicItem"], "the fixture did not produce both fan-out bindings");
    assert.equal(bound.get("item")!["value"], "[secret]", "task.ready.binding served the item of a secret_ref fan-out");
    // THE CONTROL: the same shape, the same route, the same run — a `public` item channel.
    assert.equal(bound.get("topicItem")!["value"], FAN_PUBLIC, "task.ready.binding redacted a public fan-out item");
    // WHICH CHANNEL was bound is metadata a reader needs to follow a branch at all.
    assert.equal(bound.get("item")!["channel"], "item", "the binding lost the channel it names");
    assert.equal(JSON.stringify(fs).includes(FAN_SECRET), false, "the fanned secret reached the stream somewhere else");
  } finally {
    await r.close();
  }
});

test("THE FANNED RUN IS STILL FOLLOWABLE — branch coordinates and edges survive", async () => {
  const r = await fanRig();
  try {
    const fs = await frames(r.base, REPLAY(r.runId));
    const ready = fs.filter((f) => f.event === "event" && f.data["type"] === "task.ready");
    assert.ok(ready.length >= 5, `the stream delivered ${ready.length} task.ready events`);
    const branch = ready.find((f) => (f.data["payload"] as Record<string, unknown>)["branchPath"] === "root/fs[0]");
    assert.ok(branch !== undefined, "the secret branch's task.ready never arrived");
    const p = branch.data["payload"] as Record<string, unknown>;
    assert.equal(p["nodeId"], "handle");
    assert.deepEqual(p["edgesIn"], ["fs"], "the branch lost the edge that created it");
    // A `task.ready` with no binding at all is untouched — the root task's.
    const root = ready.find((f) => (f.data["payload"] as Record<string, unknown>)["nodeId"] === "start");
    assert.equal((root!.data["payload"] as Record<string, unknown>)["binding"], undefined);
  } finally {
    await r.close();
  }
});

test("A PLANE THAT DOES NOT HOLD THE GRAPH WITHHOLDS THE FANNED ITEM TOO — including the public one", async () => {
  // The same fail-closed rule `redactChannels` states for a channel map, reached through the
  // same function: a plane that cannot look the graph up cannot know which of these names is
  // a credential, so it withholds both and still delivers every event.
  const r = await fanRig({ blind: true });
  try {
    const fs = await frames(r.base, REPLAY(r.runId));
    const bound = bindings(fs);
    assert.deepEqual([...bound.keys()].sort(), ["item", "topicItem"], "the blind plane dropped a task.ready event");
    assert.equal(bound.get("item")!["value"], "[secret]");
    assert.equal(bound.get("topicItem")!["value"], "[secret]", "a blind plane served a value it could not classify");
  } finally {
    await r.close();
  }
});
