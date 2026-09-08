/**
 * `POST /runs` REFUSES AN INPUT CHANNEL THE GRAPH DOES NOT DECLARE — `TODO.md` §A0.17.
 *
 * The CLI has refused this since `8c734ce`; the plane did not, and it is the plane that carries
 * the traffic. Measured on the binary built at `c54b0c2`, against
 * `examples/graphs/fan-out-join.json` (`"inputs": ["document"]`):
 *
 *     {"workflow":"fan-out-join","inputs":{"documnet":"a b"}}
 *       → 202, a durable run, then "status":"failed",
 *         E_INTERNAL: E_CHANNEL_UNDECLARED: channel "document" is not in this node's declared reads
 *     {"workflow":"fan-out-join","inputs":{"document":"a b","notes":"extra"}}
 *       → 202, "status":"succeeded", `notes` a run channel nothing reads, durable forever
 *
 * The first costs a provider call for a caller's typo and misfiles it as a bug in Loom. The second
 * is THE BREAK this change takes knowingly, so it is pinned here on purpose rather than left as a
 * side effect: a body that succeeded now gets a 400 that names the key.
 *
 * Over real HTTP on an ephemeral port, following `http.test.ts`: the contract under test is what
 * the WIRE answers and what is durable at that answer, and neither is a function-call property.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../../src/server/http.ts";
import { CODES } from "../../src/errors.ts";
import { undeclaredInputsMessage } from "../../src/graph/declared-inputs.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { compileSkeleton, harness, skeletonSpec, DOCS, type Harness } from "../run/skeleton.ts";

const NOW = 1_700_000_000_000;

interface Rig {
  base: string;
  h: Harness;
  close: () => Promise<void>;
}

/** `skeleton-summarize` declares exactly one input, `paths` — see `skeleton.ts`'s `skeletonSpec`. */
async function rig(over: Partial<GraphSpec> = {}): Promise<Rig> {
  const h = harness();
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "skeleton-summarize": compileSkeleton(skeletonSpec(over)) },
    now: () => NOW,
    // No `drive`: an accepted run is advanced by the handler itself, which is what lets the
    // ordinary half below observe a run that actually ran.
  });
  const { port } = await plane.listen(0);
  return { base: `http://127.0.0.1:${port}`, h, close: () => plane.close() };
}

async function post(r: Rig, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${r.base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const errorOf = (b: Record<string, unknown>): { code?: string; message?: string } => (b["error"] ?? {}) as { code?: string; message?: string };

/** How many runs the journal holds, whatever their state. The refusal's real assertion. */
async function runCount(r: Rig): Promise<number> {
  return (await r.h.store.listRuns(1000)).length;
}

test("a misspelled input channel is refused 400, naming the key and the declared set — and no run exists", async () => {
  const r = await rig();
  try {
    assert.equal(await runCount(r), 0, "precondition: the journal starts empty");

    const res = await post(r, { workflow: "skeleton-summarize", inputs: { pahts: DOCS } });

    assert.equal(res.status, 400, "an undeclared input channel must be a bad request, not a 202");
    assert.equal(errorOf(res.body).code, CODES.E_PROVIDER_BAD_REQUEST);
    const message = errorOf(res.body).message ?? "";
    // THE KEY THE CALLER TYPED, not the one the engine would have gone looking for. Naming
    // `paths` alone is the `E_CHANNEL_UNDECLARED` failure this refusal replaces.
    assert.match(message, /"pahts"/, `the refusal must name the key the caller sent: ${message}`);
    // AND THE DECLARED SET, because the near-miss guess is a two-letter heuristic and a caller
    // whose typo is not a transposition needs the list rather than a shrug.
    assert.match(message, /"paths"/, `the refusal must name the declared inputs: ${message}`);

    // THE POINT OF REFUSING AT THIS DOOR. 202 means `run.submitted` is durable; a 400 must mean
    // nothing was written at all, because against a real provider the next thing after
    // `run.submitted` is a model call that spends.
    assert.equal(await runCount(r), 0, "a refused submission must leave ZERO runs in the journal");
    const listed = (await (await fetch(`${r.base}/runs`)).json()) as { runs?: unknown[] };
    assert.deepEqual(listed.runs ?? [], [], "GET /runs must list nothing after a refused submission");
  } finally {
    await r.close();
  }
});

test("THE BREAK: an EXTRA key beside the declared ones is refused, where at c54b0c2 it ran and succeeded", async () => {
  const r = await rig();
  try {
    // Measured at `c54b0c2` on `fan-out-join`: `{"document":"a b","notes":"extra"}` → 202 and
    // `"status":"succeeded"`, with `notes` seeded as a run channel, durable on `run.submitted`,
    // read by nothing and rendered `[secret]` in every projection. This is the caller the change
    // breaks, and the break is deliberate: unread durable state and a body nobody validated is
    // not a contract worth keeping.
    const res = await post(r, { workflow: "skeleton-summarize", inputs: { paths: DOCS, notes: "extra" } });
    assert.equal(res.status, 400);
    const message = errorOf(res.body).message ?? "";
    assert.match(message, /"notes"/, `the extra key must be named: ${message}`);
    assert.doesNotMatch(message, /"paths"[^)]*\(did you mean/, "the DECLARED key must not be reported as undeclared");
    assert.equal(await runCount(r), 0);
  } finally {
    await r.close();
  }
});

test("THE ORDINARY HALF: a body naming only declared inputs still runs, and one naming none still runs", async () => {
  const r = await rig();
  try {
    const ok = await post(r, { workflow: "skeleton-summarize", inputs: { paths: DOCS } });
    assert.equal(ok.status, 202, "the correct body must be unaffected");
    assert.equal(typeof ok.body["runId"], "string");

    // `inputs` OMITTED and `inputs: {}` are both legal and were before: no key is undeclared when
    // there is no key. A rule that refused an empty submission would be a new refusal nobody asked
    // for, on the path a graph with defaulted channels takes.
    assert.equal((await post(r, { workflow: "skeleton-summarize" })).status, 202, "omitting `inputs` must stay legal");
    assert.equal((await post(r, { workflow: "skeleton-summarize", inputs: {} })).status, 202, "an empty `inputs` must stay legal");

    assert.equal(await runCount(r), 3, "all three accepted submissions are durable");
  } finally {
    await r.close();
  }
});

test("a graph declaring no inputs at all refuses every key, and says so in those words", async () => {
  const r = await rig({ inputs: [] });
  try {
    const res = await post(r, { workflow: "skeleton-summarize", inputs: { paths: DOCS } });
    assert.equal(res.status, 400);
    assert.match(errorOf(res.body).message ?? "", /declares no inputs at all/);
    assert.equal(await runCount(r), 0);
  } finally {
    await r.close();
  }
});

test("a prototype key is compared as the string it is — refused, not a crash and not accepted", async () => {
  const r = await rig();
  try {
    // `Object.keys` is own-enumerable only, so `__proto__` arriving from `JSON.parse` is an
    // ordinary own key here. The failure this rules out is the filter reaching the prototype and
    // finding `constructor` "declared".
    for (const key of ["__proto__", "constructor", "toString", ""]) {
      const res = await post(r, { workflow: "skeleton-summarize", inputs: { paths: DOCS, [key]: 1 } });
      assert.equal(res.status, 400, `an undeclared key ${JSON.stringify(key)} must be refused`);
      assert.equal(errorOf(res.body).code, CODES.E_PROVIDER_BAD_REQUEST);
    }
    assert.equal(await runCount(r), 0);
  } finally {
    await r.close();
  }
});

test("the message is bounded in BOTH dimensions — key count and key length", async () => {
  const r = await rig();
  try {
    // COUNT. Eight named, the rest counted. Without the cap this string carries all 500 names,
    // which is an amplification the request paid nothing for.
    const many: Record<string, unknown> = { paths: DOCS };
    for (let i = 0; i < 500; i++) many[`k${i}`] = i;
    const counted = await post(r, { workflow: "skeleton-summarize", inputs: many });
    assert.equal(counted.status, 400);
    const message = errorOf(counted.body).message ?? "";
    assert.match(message, /and 492 more/, message.slice(0, 400));
    assert.ok(message.length < 1000, `the refusal must not grow with the key COUNT: ${message.length} chars`);

    // LENGTH, which capping the count does NOT give. Measured on the function with and without
    // the clip, one 900,000-character key: 900560 chars → 681 chars. `http.ts`'s own `truncate` —
    // "a caller-supplied string on its way into a message. Bounded, because a header is not" —
    // is the rule that was being broken, one file over.
    const huge = await post(r, { workflow: "skeleton-summarize", inputs: { [`x`.repeat(50_000)]: 1 } });
    assert.equal(huge.status, 400);
    const long = errorOf(huge.body).message ?? "";
    assert.ok(long.length < 1000, `the refusal must not grow with the key LENGTH: ${long.length} chars`);
    assert.match(long, /x{120}…/, "the key is shown, clipped at 120 characters with an ellipsis");

    assert.equal(await runCount(r), 0);
  } finally {
    await r.close();
  }
});

test("A GRAPH THAT COMPILES AND READS THE CHANNEL IS REFUSED TOO — the break's sharpest edge, named", async () => {
  // The option this change did NOT take was to key the rule on `spec.channels`, which would
  // refuse the typo and admit this. Measured on the base tree, a skeleton graph whose `hint`
  // channel is DECLARED, written by nobody, and READ by its first node:
  //
  //     compile ok = true   diagnostics = ["warning:GRAPH005_UNPRODUCED_READ"]
  //     submit {paths, hint} → status = awaiting_gate | hint channel = "read me"
  //
  // It compiles, the key is genuinely read, and it seeded fine through `engine.submit`. This
  // rule refuses it, and that is deliberate: `GRAPH005_UNPRODUCED_READ`'s own `fix` string is
  // `add "<channel>" to inputs:, or have an upstream node write it`, so the compiler has been
  // telling this author the same thing all along. The refusal is that warning enforced rather
  // than printed. The message therefore has to name the fix — a tail reading "a channel nothing
  // reads is dropped in silence" would be a false diagnosis of this graph.
  const base = skeletonSpec();
  const r = await rig({
    channels: { ...base.channels, hint: { type: "string", reduce: "replace" } },
    nodes: base.nodes.map((n, i) => (i === 0 ? { ...n, reads: [...(n.reads ?? []), "hint"] } : n)),
  });
  try {
    const res = await post(r, { workflow: "skeleton-summarize", inputs: { paths: DOCS, hint: "read me" } });
    assert.equal(res.status, 400);
    const message = errorOf(res.body).message ?? "";
    assert.match(message, /"hint"/);
    assert.match(message, /add it to the graph's "inputs" list/, `the refusal must name the fix, not a false diagnosis: ${message}`);
    // AND SAY THE DIAGNOSTIC IS A WARNING. `loom compile` on such a graph prints the line and then
    // `ok`, exit 0 — a message that reads "which is what GRAPH005 already says at compile time"
    // beside a hard 400 tells the operator the compiler stopped them when it did not.
    assert.match(message, /GRAPH005_UNPRODUCED_READ warns about at compile time without refusing/, message);
    assert.match(message, /Nothing was submitted/, "and not claim a run was made — a 400 makes none");
    // AND NOT ASSERT A FAILURE THAT DID NOT HAPPEN. The extra-key body succeeded at `c54b0c2` at
    // $0, so "the run fails … after it has spent" cannot be unconditional; it is introduced by
    // "where", scoped to the caller who meant a channel the graph needs.
    assert.match(message, /where the name you meant was one the graph needs, the run\s+fails/, message);
    assert.equal(await runCount(r), 0);
  } finally {
    await r.close();
  }
});

test("a refusal does not poison an idempotency slot — the same key, corrected, is accepted", async () => {
  const r = await rig();
  try {
    const key = { "idempotency-key": "retry-me" };
    const bad = await post(r, { workflow: "skeleton-summarize", inputs: { pahts: DOCS } }, key);
    assert.equal(bad.status, 400);

    // The claim is freed in the handler's `catch` and the in-flight slot deleted in its `finally`.
    // Were it not, a caller that fixed its typo and retried under the same key would be answered
    // with the stale refusal forever — a fail-closed that never reopens is not a guard, it is a
    // wedge.
    const good = await post(r, { workflow: "skeleton-summarize", inputs: { paths: DOCS } }, key);
    assert.equal(good.status, 202, "the corrected retry must be accepted under the same key");
    assert.equal(await runCount(r), 1);

    // And the ordinary idempotency contract still holds: a third identical send returns the SAME
    // run rather than a second one.
    const again = await post(r, { workflow: "skeleton-summarize", inputs: { paths: DOCS } }, key);
    assert.equal(again.status, 202);
    assert.equal(again.body["runId"], good.body["runId"]);
    assert.equal(await runCount(r), 1);
  } finally {
    await r.close();
  }
});

/** The tail both doors share, written once so the two assertions below cannot drift apart. */
const TAIL =
  `Nothing was submitted. A channel the graph does not declare is seeded and then read by nothing, so ` +
  `the value would have done nothing; and where the name you meant was one the graph needs, the run ` +
  `fails four layers below the mistake — against a real provider, after it has spent. Correct the ` +
  `spelling, or — if a node is meant to read this channel — add it to the graph's "inputs" list, which ` +
  `is what GRAPH005_UNPRODUCED_READ warns about at compile time without refusing.`;

test("ONE RULE, TWO DOORS: the CLI and the wire render the same sentence under different nouns", () => {
  // `cli.ts`'s `assertDeclaredInputs` is now three lines over this function, so the pin on what an
  // operator reads has to live somewhere. This is it, byte-exact — and the CLI door's end-to-end
  // behaviour (exit 1, `E_CONFIG_INVALID`, zero `run.submitted` rows) is pinned separately and
  // unchanged by *AN UNDECLARED `--input` CHANNEL IS REFUSED BEFORE THE RUN* in
  // `test/cli/product-lane-doors.test.ts`.
  const spec = skeletonSpec();
  assert.equal(
    undeclaredInputsMessage("--input", spec, { documnet: "a b" }),
    `--input names a channel this graph does not declare as an input: "documnet". It declares "paths". ${TAIL}`,
  );
  // The near-miss guess, and the plural, both still render — and the SUBJECT is the only thing the
  // wire changes.
  assert.equal(
    undeclaredInputsMessage(`"inputs"`, spec, { pa: 1, zz: 2 }),
    `"inputs" names channels this graph does not declare as an input: "pa" (did you mean "paths"?), "zz". ` +
      `It declares "paths". ${TAIL}`,
  );
  // And nothing to say is `undefined`, never the empty string: a caller that forgot to throw reads
  // a value it cannot mistake for a message.
  assert.equal(undeclaredInputsMessage("--input", spec, { paths: DOCS }), undefined);
  assert.equal(undeclaredInputsMessage("--input", spec, {}), undefined);
});

test("THE CAP APPLIES AT THE CLI DOOR TOO, which is the one way this extraction changed it", () => {
  // Said out loud rather than left for someone to discover: the pre-extraction `cli.ts` named
  // EVERY undeclared key, and this rule names eight and counts the rest. Nine or more mistyped
  // keys in one `--input` is reachable, so it is a real difference and it is pinned here rather
  // than asserted away. It is kept because one rule at two doors is the whole point of the file,
  // and the plane's key set is caller-controlled where argv's is not — a rule that is stricter on
  // one door only is two rules again.
  const spec = skeletonSpec();
  const ten: Record<string, unknown> = {};
  for (const k of ["a1", "b1", "c1", "d1", "e1", "f1", "g1", "h1", "i1", "j1"]) ten[k] = 1;
  const message = undeclaredInputsMessage("--input", spec, ten) ?? "";
  assert.match(message, /"a1", "b1", "c1", "d1", "e1", "f1", "g1", "h1" and 2 more\./, message);
  // Eight is the boundary and it is exclusive of the counter: exactly eight names eight and counts
  // nothing.
  const eight: Record<string, unknown> = {};
  for (const k of ["a1", "b1", "c1", "d1", "e1", "f1", "g1", "h1"]) eight[k] = 1;
  assert.doesNotMatch(undeclaredInputsMessage("--input", spec, eight) ?? "", /more\./);
});
