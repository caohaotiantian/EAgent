/**
 * A BODY'S DELIBERATE REFUSAL WAS REPORTED AS THE CODE A BUG IN THE BODY PRODUCES.
 *
 * TODO A.42, measured on the shipped binary before this existed:
 *
 *     $ loom run graphs/triage-failures.json --input '{"pattern":"nope/*.txt"}'
 *       "error": { "class": "internal", "code": "E_INTERNAL",
 *         "message": "Error: no test-output files matched — check the --input pattern, …" }
 *
 * `examples/resources/function/triage-plan.js` refuses on purpose there — an empty match set is
 * an operator's typo, not a crash — and it had no way to say so. `isLoomError` is an `instanceof`
 * against the HOST class and a guest object can never satisfy it, so every throw out of the `vm`
 * normalizes to `internal`/`E_INTERNAL`. `internal` "always alerts", and `EdgeSpec.codes` and
 * `RetryPolicy.onlyIf` take codes and nothing else — so a graph could not route a refusal without
 * also routing every crash, and an operator could not tell the two apart in a journal.
 *
 * THE ANSWER IS THE SHAPE `retry` ALREADY USES: a RETURN, `{ refuse: { reason } }`, with the
 * engine raising a host `LoomError` on the body's behalf. What this suite has to hold is the PAIR
 * — the two verdicts must not collapse into one — so nearly every test here comes with its
 * `retry` twin asserted beside it:
 *
 *   {retry:  {reason}}  -> unavailable / E_FUNCTION_UNAVAILABLE, RETRYABLE
 *   {refuse: {reason}}  -> validation  / E_FUNCTION_REFUSED,     NEVER retried
 *
 * Asserting only the second would pass for an implementation that made both retryable, or
 * neither, which is why the negative controls are the point of the file rather than a courtesy.
 *
 * AND BOTH CALLERS, ALWAYS. `functions.require` has exactly two — `#runFunction` and
 * `#runEvaluator`'s `assertion` arm — and every previous change to this contract (the seed, the
 * clock, the outcome shape, `take`) landed at one of them a commit before the other. An assertion
 * made about one caller has never been evidence about the other in this file's history.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type FunctionOutcome } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;
const REF = "function/b@stable";
const ACTOR = { kind: "human", id: "u:test" } as const;

type Verdict = "retry" | "refuse";
type Kind = "function" | "evaluator";

/**
 * One node, one body ref, one `retry` policy — and the node type is a parameter, which is the
 * whole point. `retry` is declared on the node so that "not retried" is a MEASUREMENT and not
 * the absence of a policy: without it, `{refuse}` and `{retry}` would both fail once and the
 * suite would prove nothing about the distinction.
 */
function spec(kind: Kind, opts: { readonly retry: boolean; readonly rescue?: Verdict }): GraphSpec {
  const node =
    kind === "function"
      ? { id: "f", type: "function", writes: ["seen"], function: { ref: REF } }
      : { id: "f", type: "evaluator", writes: ["seen"], evaluator: { kind: "assertion", ref: REF, threshold: 0.5 } };
  const code = opts.rescue === "refuse" ? "E_FUNCTION_REFUSED" : "E_FUNCTION_UNAVAILABLE";
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "refusal", project: "t", version: 1 },
    policy: { posture: "out" },
    channels: {
      seen: { type: "array", reduce: "append_ordered" },
      rescued: { type: "array", reduce: "append_ordered" },
    },
    inputs: [],
    // THE RESCUE GRAPH'S OUTPUT IS THE RESCUE ARM'S CHANNEL. `#finish` fails a run that wrote
    // none of its declared outputs (`E_OUTPUT_MISSING`), so leaving this as `seen` would make
    // the routed run fail for a reason that has nothing to do with which edge fired — and the
    // assertion "the refusal took the edge" would be reading the wrong verdict.
    outputs: opts.rescue === undefined ? ["seen"] : ["rescued"],
    nodes: [
      { ...node, ...(opts.retry ? { retry: { maxAttempts: 3, backoff: "fixed", initialMs: 1 } } : {}) },
      ...(opts.rescue === undefined
        ? []
        : [{ id: "rescue", type: "function", writes: ["rescued"], function: { ref: "function/rescue@stable" }, unhandled: true }]),
    ],
    edges: opts.rescue === undefined ? [] : [{ id: "err", from: "f", to: "rescue", kind: "error", codes: [code] }],
  } as unknown as GraphSpec;
}

/**
 * A HAND-REGISTERED body — host code, no realm. The sandboxed path is driven separately at the
 * bottom of this file, because a verdict that works only for host code closes nothing: the row
 * was opened about `examples/resources/function/triage-plan.js`, which is a resource.
 */
async function run(body: unknown, kind: Kind, opts: { readonly retry: boolean; readonly rescue?: Verdict } = { retry: false }) {
  const functions = new FunctionRegistry();
  functions.register(REF, body as () => FunctionOutcome);
  functions.register("function/rescue@stable", (() => ({ writes: { rescued: ["caught"] } })) as never);
  // AN ADVANCING CLOCK. The fold turns `task.retry_scheduled` into `retryAfter: ts + afterMs` and
  // `eligible()` skips a task while `retryAfter > now`, so a frozen clock makes a 1 ms backoff
  // never elapse — and "the retry never ran" would then be indistinguishable from "the retry was
  // declined", which is precisely the distinction this file measures. Still no real time.
  const clock = { t: NOW };
  const store = new MemoryStateStore({ now: () => clock.t });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => clock.t,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: spec(kind, opts), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: {} });
  let p = await engine.advance(runId);
  for (let i = 0; i < 6 && p.status === "running"; i++) {
    clock.t += 1000;
    p = await engine.advance(runId);
  }
  const events = [];
  for await (const e of store.read(runId, 1)) events.push(e);
  return { p, scheduled: events.filter((e) => e.type === "task.retry_scheduled") };
}

// ── the verdict itself, and its twin ─────────────────────────────────────────

test("A BODY CAN REFUSE ON PURPOSE, and the refusal is NOT `internal`", async () => {
  const { p } = await run(() => ({ refuse: { reason: "no test-output files matched" } }), "function");
  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_FUNCTION_REFUSED", JSON.stringify(p.error ?? {}));
  assert.equal(p.error?.class, "validation", "a deliberate refusal is not a bug in Loom");
  assert.match(String(p.error?.message), /no test-output files matched/, "the body's reason must reach the operator");
  assert.match(String(p.error?.message), /refused/);
});

test("...WHERE A THROW IS STILL `internal`/`E_INTERNAL` — the half that has not changed", async () => {
  // The control that makes the test above mean something. If a throw ALSO produced a named
  // class, the return channel would be decoration rather than the mechanism. `isLoomError` is an
  // `instanceof` against the host class; nothing a body can throw satisfies it.
  const { p } = await run(() => {
    throw new Error("no test-output files matched");
  }, "function");
  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_INTERNAL", JSON.stringify(p.error ?? {}));
  assert.equal(p.error?.class, "internal");
});

test("REFUSE IS NEVER RETRIED, AND RETRY IS — on the SAME node, with the SAME policy", async () => {
  // THE PAIR, and it is the reason this file exists. Both verdicts are returns, both are raised
  // by the engine, and the ONLY thing separating them is the class: `RETRYABLE` holds
  // `exhausted`, `unavailable`, `timeout`, so `#retryDecision`'s `if (!error.retryable) return
  // undefined` declines a refusal however generous the policy is. Measured against a node that
  // declares `maxAttempts: 3` in both runs, so "not retried" is a decision and not an omission.
  let refusals = 0;
  const refused = await run(
    () => {
      refusals += 1;
      return { refuse: { reason: "the input is wrong and will stay wrong" } };
    },
    "function",
    { retry: true },
  );
  assert.deepEqual(refused.scheduled, [], "a refusal schedules NO retry, on a node that declares three attempts");
  assert.equal(refusals, 1, "and the body is entered exactly once");
  assert.equal(refused.p.error?.code, "E_FUNCTION_REFUSED", JSON.stringify(refused.p.error ?? {}));

  let attempts = 0;
  const retried = await run(
    () => {
      attempts += 1;
      return { retry: { reason: "upstream still warming up" } };
    },
    "function",
    { retry: true },
  );
  assert.equal(retried.scheduled.length, 2, "the twin: maxAttempts 3 means two retries");
  assert.equal(attempts, 3);
  assert.equal(retried.p.error?.code, "E_FUNCTION_UNAVAILABLE", JSON.stringify(retried.p.error ?? {}));
});

test("A GRAPH CAN ROUTE A REFUSAL AND NOT A CRASH — which is what a CODE buys", async () => {
  // The row's actual complaint. `EdgeSpec.codes` takes codes and nothing else, so while a
  // refusal and a bug shared `E_INTERNAL` an `error` edge could catch both or neither.
  const caught = await run(() => ({ refuse: { reason: "empty match set" } }), "function", { retry: false, rescue: "refuse" });
  assert.equal(caught.p.status, "succeeded", JSON.stringify(caught.p.error ?? {}));
  assert.deepEqual(caught.p.channels["rescued"], ["caught"], "the refusal took the edge keyed on its code");

  // ...and the same graph does NOT absorb a genuine bug, which is the half that makes the first
  // assertion worth having. `unhandled: true` on the rescue node keeps GRAPH011 quiet.
  const crashed = await run(
    () => {
      throw new Error("undefined is not a function");
    },
    "function",
    { retry: false, rescue: "refuse" },
  );
  assert.equal(crashed.p.status, "failed", "an E_INTERNAL crash must not take an E_FUNCTION_REFUSED edge");
  assert.equal(crashed.p.error?.code, "E_INTERNAL", JSON.stringify(crashed.p.error ?? {}));
  assert.equal(crashed.p.channels["rescued"], undefined);

  // AND NOT THE SIBLING VERDICT'S EDGE EITHER, which is the control that matters most: `retry`
  // and `refuse` are the two returns most likely to be conflated by a future edit, and an edge
  // keyed on `E_FUNCTION_UNAVAILABLE` catching a refusal would mean the two codes had quietly
  // become one. Same body, same graph shape, only the edge's `codes` different.
  const wrongEdge = await run(() => ({ refuse: { reason: "empty match set" } }), "function", {
    retry: false,
    rescue: "retry",
  });
  assert.equal(wrongEdge.p.status, "failed", "a refusal must not take an edge keyed on the RETRY code");
  assert.equal(wrongEdge.p.error?.code, "E_FUNCTION_REFUSED", JSON.stringify(wrongEdge.p.error ?? {}));
  assert.equal(wrongEdge.p.channels["rescued"], undefined);
});

// ── the second caller ────────────────────────────────────────────────────────

test("AND THE EVALUATOR ARM REFUSES TOO — the caller that has kept every previous defect", async () => {
  // `functions.require` has two callers and this is the one the seed, the clock, the outcome
  // shape and `take` each reached a commit late. A mutation deleting `refusalDeclared` from
  // `#runEvaluator` leaves every test above green.
  const { p } = await run(() => ({ refuse: { reason: "the rubric does not apply to this input" } }), "evaluator");
  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_FUNCTION_REFUSED", JSON.stringify(p.error ?? {}));
  assert.equal(p.error?.class, "validation");
  assert.match(String(p.error?.message), /the rubric does not apply/);

  // ...and it is not retried there either, on a node that declares a policy.
  const withPolicy = await run(() => ({ refuse: { reason: "no" } }), "evaluator", { retry: true });
  assert.deepEqual(withPolicy.scheduled, [], "the second caller's refusal is as final as the first's");
});

// ── the shape rules, which `requireOutcome` shares between the two verdicts ───

test("`refuse: true` IS REFUSED and the message names the shape that works", async () => {
  // The obvious thing to write, and not the contract — the argument `retry: true` already lost.
  const { p } = await run(() => ({ refuse: true }), "function");
  assert.equal(p.error?.code, "E_RESOURCE_INVALID", JSON.stringify(p.error ?? {}));
  assert.match(String(p.error?.message), /refuse is an object/);
  assert.match(String(p.error?.message), /reason/);
});

test("`refuse` IS EXCLUSIVE WITH `writes`, `take` AND `retry`", async () => {
  const withWrites = await run(() => ({ refuse: { reason: "x" }, writes: { seen: ["x"] } }), "function");
  assert.equal(withWrites.p.error?.code, "E_RESOURCE_INVALID", JSON.stringify(withWrites.p.error ?? {}));
  assert.match(String(withWrites.p.error?.message), /silently dropped/, "and the message says why, not just that");

  const withTake = await run(() => ({ refuse: { reason: "x" }, take: [] }), "function");
  assert.equal(withTake.p.error?.code, "E_RESOURCE_INVALID");

  // THE TWO VERDICTS TOGETHER, which is the arm a second copy of the retry checks would have
  // missed: "trying again might work" and "trying again will not" cannot both be true.
  const both = await run(() => ({ retry: { reason: "x" }, refuse: { reason: "y" } }), "function");
  assert.equal(both.p.error?.code, "E_RESOURCE_INVALID", JSON.stringify(both.p.error ?? {}));
  assert.match(String(both.p.error?.message), /retry alongside refuse/);
  // AND THE MESSAGE IS THE VERDICT-VS-VERDICT ONE, not either writes/take sentence. Neither body
  // asked to commit anything, so "would be proposed twice" / "would be silently dropped" would be
  // telling an author about writes they did not write — the exact harm the two-message split
  // exists to avoid, which the first version of this reproduced one case further along.
  assert.match(String(both.p.error?.message), /no order in which both are true/);
  assert.doesNotMatch(String(both.p.error?.message), /proposed twice|silently dropped/);
});

test("AN EXPLICIT `undefined` VERDICT IS ABSENT, not a clash — `refuse: cond ? {…} : undefined`", async () => {
  // `requireOutcome` SKIPS a verdict on `=== undefined` and used to detect a clash with `in`, so
  // the two halves of one predicate answered "is this key absent?" differently: this body — the
  // ordinary way to write a conditional verdict — was refused, while `{writes, refuse: undefined}`
  // was fine. An explicit `undefined` is absent everywhere else in this contract (`ctx.seed`,
  // `out.take`, `out.retry` are all read that way), so it is absent here.
  const { p } = await run(() => ({ retry: { reason: "x" }, refuse: undefined }), "function");
  assert.equal(p.error?.code, "E_FUNCTION_UNAVAILABLE", JSON.stringify(p.error ?? {}));
  assert.doesNotMatch(String(p.error?.message), /alongside/, "an absent verdict is not a clash");

  // The same, one field over, as the control: `{writes, retry: undefined}` commits.
  const w = (await run(() => ({ writes: { seen: ["ok"] }, retry: undefined }), "function")).p;
  assert.deepEqual(w.channels["seen"], ["ok"], JSON.stringify(w.error ?? {}));
});

test("A REFUSAL WITH NO REASON STILL SAYS SO, rather than printing `undefined`", async () => {
  const { p } = await run(() => ({ refuse: {} }), "function");
  assert.equal(p.error?.code, "E_FUNCTION_REFUSED", JSON.stringify(p.error ?? {}));
  assert.match(String(p.error?.message), /no reason given/);
});

test("`{}` IS STILL LEGAL — a body that writes nothing is ordinary, not a refusal", async () => {
  // The guard that stops `refuse` being read into an empty return. Without it, adding a verdict
  // key would be a way for a correct body to start failing.
  //
  // THE ASSERTION IS ABOUT THE VERDICT AND NOT THE RUN, deliberately. This graph declares `seen`
  // as its output, so a task that commits nothing still ends the RUN at `E_OUTPUT_MISSING` —
  // a `#finish` verdict about a stranded path, reached long after the body's return was
  // accepted. Asserting `succeeded` here would be asserting something this graph cannot do;
  // asserting the CODE is what says the empty return was not read as a verdict.
  const { p } = await run(() => ({}), "function");
  assert.equal(p.error?.code, "E_OUTPUT_MISSING", JSON.stringify(p.error ?? {}));
  assert.notEqual(p.error?.code, "E_FUNCTION_REFUSED", "an empty return is not a refusal");
  assert.notEqual(p.error?.code, "E_RESOURCE_INVALID", "and it is not an authoring mistake either");
});

// ── the OTHER named set the verdict joins, and it is joined by omission ──────

test("A REFUSED BRANCH IS ABSORBED BY `onBranchError: \"skip\"` — deliberately, and measured", async () => {
  // `NOT_ABSORBED_AS_SKIP` is a NAMED SET, and a new code joins its complement silently. Its
  // boundary paragraph now names `E_FUNCTION_REFUSED` as absorbable, and a claim in a kernel
  // docstring with no test behind it is what this repo punishes — so this is the test.
  //
  // WHY ABSORBABLE IS RIGHT. That set holds codes meaning "the run can no longer say anything
  // true" plus two about oversight. A refusal is neither: it is "this node's work did not work",
  // which the same paragraph names as exactly the population `skip` exists for. And a graph that
  // wrote `onBranchError: "skip"` has already said what to do with a failing branch — a branch
  // failing ON PURPOSE is the case that instruction fits best, not least.
  const fanSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "refusal-skip", project: "t", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      shard: { type: "string", reduce: "replace" },
      seen: { type: "array", reduce: "append_ordered" },
      done: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["items"],
    outputs: ["done"],
    nodes: [
      { id: "plan", type: "function", reads: ["items"], writes: ["seen"], function: { ref: "function/plan@stable" } },
      { id: "work", type: "function", reads: ["shard"], writes: ["done"], function: { ref: REF }, unhandled: true },
      { id: "collect", type: "join", writes: ["done"], join: { branches: ["work"], mode: "all", onBranchError: "skip" } },
    ],
    edges: [
      { id: "fan", from: "plan", to: "work", kind: "fanout", over: "items", as: "shard", maxWidth: 4 },
      { id: "j", from: "work", to: "collect", kind: "join" },
    ],
  } as unknown as GraphSpec;

  const functions = new FunctionRegistry();
  functions.register("function/plan@stable", (() => ({ writes: { seen: ["planned"] } })) as never);
  // ONE BRANCH REFUSES AND ONE SUCCEEDS, which is the shape that actually shows absorption: with
  // every branch refusing the join folds nothing, `done` is never written, and the run dies at
  // `#finish` with `E_OUTPUT_MISSING` — a verdict about a stranded path that would tell us
  // nothing about whether the refusal was absorbed.
  functions.register(REF, ((view: { get(c: string): unknown }) =>
    view.get("shard") === "a" ? { refuse: { reason: "this shard is not mine to read" } } : { writes: { done: ["b"] } }) as never);
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: fanSpec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { items: ["a", "b"] } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 6 && p.status === "running"; i++) p = await engine.advance(runId);

  const events = [];
  for await (const e of store.read(runId, 1)) events.push(e);
  const skipped = events.filter((e) => e.type === "task.skipped");
  assert.equal(skipped.length, 1, `the refused branch was absorbed, not left failed: ${JSON.stringify(p.error ?? {})}`);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(p.channels["done"], ["b"], "and the surviving branch's contribution is the run's answer");

  // AND WHAT WAS ABSORBED WAS THE REFUSAL, not some other failure that happened first. Without
  // this the test would pass for a graph whose branches died on a typo in the fixture, and the
  // claim in `NOT_ABSORBED_AS_SKIP`'s boundary paragraph would rest on a green run of the wrong
  // thing.
  const failed = events.filter((e) => e.type === "task.failed");
  assert.equal(failed.length, 1, "exactly one branch task failed before the join absorbed it");
  assert.equal(
    ((failed[0]!.payload as { error?: { code?: string } }).error ?? {}).code,
    "E_FUNCTION_REFUSED",
    `the absorbed failure must be the refusal: ${JSON.stringify(failed[0]!.payload)}`,
  );
});

// ── the sandboxed path, and replay ───────────────────────────────────────────

/** The same verdict, from a body that actually lives in a `vm` realm. */
function sandboxed(source: string) {
  const store = new MemoryStateStore({ now: () => NOW });
  const resources = new ResourceStore({ now: () => 1 });
  const published = resources.publish({ kind: "function", name: "b", content: source, actor: ACTOR });
  resources.promote(published, "canary", ACTOR);
  resources.promote(published, "stable", ACTOR);
  const loader = createFunctionLoader({ store: resources });
  const functions = new FunctionRegistry({ loader: (r) => loader.load(r) });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    resolver: resources,
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: spec("function", { retry: false }), resolver: resources, tools: {}, tenantCapabilities: [] });
  return { store, engine, graph, functions };
}

test("A SANDBOXED BODY REFUSES TOO — the path the row was actually opened about", async () => {
  // `examples/resources/function/triage-plan.js` is a RESOURCE. A verdict that worked only for a
  // hand-registered body would close nothing: the returned object has to survive `intoHostRealm`,
  // which rebuilds it structurally, and the nested `{reason}` has to survive with it.
  const h = sandboxed(`(view) => ({ refuse: { reason: "no test-output files matched" } })`);
  const p = await h.engine.advance(await h.engine.submit({ graph: h.graph, inputs: {} }));
  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_FUNCTION_REFUSED", JSON.stringify(p.error ?? {}));
  assert.equal(p.error?.class, "validation");
  assert.match(String(p.error?.message), /no test-output files matched/, "the nested reason crossed the realm boundary");
});

test("A REFUSAL REPLAYS AS A REFUSAL, under the same code", async () => {
  // A `function` body RE-EXECUTES on replay (B11) rather than being served, so the verdict has to
  // be a function of the inputs and nothing else — no clock, no draw, no journaled row of its
  // own. This is what says so: the refusal travels in the ordinary failure record, and folding
  // that journal a second time reproduces it exactly.
  const h = sandboxed(`(view) => ({ refuse: { reason: "empty match set" } })`);
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  const recorded = await h.engine.advance(runId);
  assert.equal(recorded.error?.code, "E_FUNCTION_REFUSED", JSON.stringify(recorded.error ?? {}));

  const report = await replayRun({
    store: h.store,
    runId,
    graph: h.graph,
    engine: { tools: new ToolRegistry(), functions: h.functions, models: new ModelRegistry() },
  });
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.equal(report.replayed.error?.code, "E_FUNCTION_REFUSED", "the replay must refuse for the same reason, not merely fail");
  assert.equal(report.replayed.error?.class, "validation");
});
