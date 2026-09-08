/**
 * A FAN-OUT OF WIDTH ZERO DELETED AN AUTHORED HUMAN GATE.
 *
 * `#activate`'s `list.length === 0` arm calls `#fireEmptyJoin`, which appends `task.ready` for
 * the join node DIRECTLY. That is right about the barrier — a barrier over zero branches is
 * satisfied — and wrong about everything on the branch: every node between the fan-out edge and
 * the join is skipped, including a `human_gate` the author drew there. And the width is a
 * function of a channel a tool fetched, so an attacker who makes the list empty deletes the gate
 * from the run. Statically every path from an entry to the tool runs through the gate; at
 * runtime nobody was asked. Measured on ONE graph driven twice, the only difference being what
 * the fetched page said:
 *
 *     the page yields two items -> awaiting_gate, gates=1, wrote=0
 *     the page yields none      -> succeeded,     gates=0, wrote=1
 *
 * `reversible_write` and not `irreversible` on purpose, for the reason
 * `test/graph/mutation-dominator.test.ts` states at length: `CLASS_DEFAULT_POSTURE` pins
 * `irreversible` at `in`, so for that class the node raises its own gate and the authored one is
 * the second of two layers. For `read_only` and `reversible_write` the authored gate is the only
 * oversight there is.
 *
 * IT ALSO FALSIFIES A CLAIM IN `graph/mutate.ts`. The dominator-preservation rule there rests on
 * "`gate` protects `pay` exactly while every path from an entry to `pay` passes through `gate`",
 * and this is a graph where that is statically true and the gate does not run. The claim is now
 * qualified where it is made; this file is the reproduction it points at.
 *
 * ## AND THE HALF THAT MUST NOT MOVE
 *
 * An empty fan with NOTHING unskippable on its branch still fires its join and still runs the
 * graph out. `#fireEmptyJoin`'s own docstring is about that case — an alert with no pods must
 * not strand the downstream — and a fix that gated every empty fan would be a constant gate on
 * the shape the method exists for.
 *
 * ## FOUR MORE, AND TWO OF THEM ARE THE SAME QUESTION ANSWERED TWICE
 *
 * `#fireEmptyJoin` and `applyFanoutWidthTaint` both ask "whose width was this", and both
 * docstrings said they computed one predicate while they computed two. And the set of things a
 * skipped branch may not silently contain was a literal string.
 *
 *   - A WIDTH AN ATTACKER STEERED, OVER A CLEAN LIST. `applyTaint` never turns control taint into
 *     data taint, so injected text that picks between two clean list-builders produces an
 *     attacker-chosen width over a channel `ctx.tainted` has never held. One predicate now, in
 *     `fanoutWidthEvidence`.
 *   - A `subgraph` ON THE SKIPPED BRANCH. The unskippable set was `"human_gate"` scanned over the
 *     PARENT's nodes, and a delegated graph's own gate is not there.
 *
 * And two where `fanBody` — which both consumers walk — answered an unknown with the passing
 * value:
 *
 *   - AN AMBIGUOUS FAN-OUT DEPTH, which stopped the walk. One extra inbound edge is enough, and
 *     everything below went invisible to both consumers at once.
 *   - A RETRY `loop` BACK-EDGE OUT OF THE BODY, which admitted a node ABOVE the fan. When that
 *     node is the run's already-approved gate, an empty fan asks a second human.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import { resolver } from "./skeleton.ts";

const NOW = () => 1_700_000_000_000;

const MANIFESTS = {
  "net.fetch": { irreversibility: "read_only", capabilities: ["net:fetch"], idempotent: true },
  // REVERSIBLE, so the authored gate is the only oversight in front of it.
  "notes.write": { irreversibility: "reversible_write", capabilities: ["notes:write"], idempotent: false },
} as never;

interface Options {
  /** What the fetched page says, which is what decides the fan's width. */
  readonly page: "TWO" | "NONE";
  /** With `false` the fan branch is a plain function and there is nothing unskippable on it. */
  readonly gateOnBranch: boolean;
  /**
   * WHOSE TEXT BUILT THE LIST the fan is taken over. `fetched` is the exploit: an attacker who
   * empties the page deletes the gate. `input` is the ordinary workflow — "for each flagged item,
   * ask a person" over a list the run's own input produced — and on the days nothing is flagged
   * the fan is empty for a reason nobody attacked.
   *
   * One read of difference and nothing else: `fetch` still runs and `untrusted` is still tainted
   * in both halves, so this is a claim about the LIST rather than about the graph.
   */
  readonly listFrom?: "fetched" | "input" | "steered" | "steered-clean";
}

/**
 * `fetch -> plan -{fanout}-> (hold | work) -{join}-> j -> write`.
 *
 * `plan` turns the fetched page into the list. The join's only branch is the fan body, and the
 * tool sits BELOW the join, so every path from the entry to the tool runs through the fan body.
 */
function spec(o: Options): GraphSpec {
  const branch = o.gateOnBranch
    ? { id: "hold", type: "human_gate", reads: ["item"], humanGate: { ref: "oversight/hold@stable" } }
    : { id: "hold", type: "function", reads: ["item"], writes: ["parts"], function: { ref: "function/echo@stable", effects: [] } };
  // THE STEERED SHAPE. `plan` is replaced by TWO list-builders, each of which reads only the
  // run's own input — so whichever one runs, `items` is a channel nothing untrusted ever wrote
  // and `ctx.tainted` never holds it. What the injected page decides is WHICH ONE RUNS, and
  // therefore how wide the fan is. `steered-clean` is the same graph with the router reading the
  // run's own input, which is the half that must not gate.
  const steered = o.listFrom === "steered" || o.listFrom === "steered-clean";
  const steerOn = o.listFrom === "steered" ? "untrusted" : "request";
  const steerNodes = steered
    ? [
        {
          id: "route",
          type: "router",
          reads: [steerOn],
          router: { mode: "expression", cases: [{ when: `contains(${steerOn}, "NONE")`, take: ["toEmpty"] }], fallbackEdge: "toFull" },
        },
        { id: "planEmpty", type: "function", reads: ["request"], writes: ["items"], function: { ref: "function/none@stable", effects: [] } },
        { id: "planFull", type: "function", reads: ["request"], writes: ["items"], function: { ref: "function/two@stable", effects: [] } },
      ]
    : [
        {
          id: "plan",
          type: "function",
          reads: [o.listFrom === "input" ? "request" : "untrusted"],
          writes: ["items"],
          function: { ref: "function/split@stable", effects: [] },
        },
      ];
  const steerEdges = steered
    ? [
        { id: "e0", from: "fetch", to: "route", kind: "seq" },
        { id: "toEmpty", from: "route", to: "planEmpty", kind: "seq" },
        { id: "toFull", from: "route", to: "planFull", kind: "seq" },
        { id: "fanE", from: "planEmpty", to: "hold", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
        { id: "fanF", from: "planFull", to: "hold", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      ]
    : [
        { id: "e0", from: "fetch", to: "plan", kind: "seq" },
        { id: "fan", from: "plan", to: "hold", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      ];
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: `empty-fan-${o.page}-${String(o.gateOnBranch)}-${o.listFrom ?? "fetched"}`, project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, capabilities: ["net:fetch", "notes:write"] },
    channels: {
      request: { type: "string", reduce: "replace" },
      untrusted: { type: "string", reduce: "replace" },
      items: { type: "array", reduce: "replace" },
      item: { type: "string", reduce: "replace" },
      parts: { type: "array", reduce: "append_ordered" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["request"],
    outputs: ["receipt"],
    nodes: [
      {
        id: "fetch",
        type: "tool",
        reads: ["request"],
        writes: ["untrusted"],
        tool: { name: "net.fetch", version: "1.0", args: {} },
      },
          ...steerNodes,
      branch,
      { id: "j", type: "join", reads: ["parts"], writes: ["parts"], join: { branches: ["hold"], mode: "all", onBranchError: "skip" } },
      {
        id: "write",
        type: "tool",
        reads: ["request"],
        writes: ["receipt"],
        tool: { name: "notes.write", version: "1.0", args: {} },
        unhandled: true,
      },
    ],
    edges: [
      ...steerEdges,
      { id: "jj", from: "hold", to: "j", kind: "join", branches: ["hold"] },
      { id: "toWrite", from: "j", to: "write", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

function engineOver(store: MemoryStateStore, page: Options["page"], res?: ResourceResolver): { engine: Engine; wrote: () => number } {
  let wrote = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: "net.fetch",
    version: "1.0",
    description: "Fetch a page.",
    parameters: { type: "object" },
    irreversibility: "read_only",
    idempotent: true,
    capabilities: ["net:fetch"],
    execute: () => ({ content: page, writes: { untrusted: page } }),
  });
  tools.register({
    name: "notes.write",
    version: "1.0",
    description: "Write a note.",
    parameters: { type: "object" },
    irreversibility: "reversible_write",
    idempotent: false,
    capabilities: ["notes:write"],
    execute: () => {
      wrote += 1;
      return { content: "written", writes: { receipt: { ok: true } } };
    },
  });
  const functions = new FunctionRegistry();
  // THE WIDTH IS THE FETCHED PAGE'S. One word in the page is the whole difference between the
  // two halves below.
  functions.register("function/split@stable", (view) => {
    const text = view.visible.map((c) => String(view.get(c) ?? "")).join(" ");
    return { writes: { items: text.includes("NONE") ? [] : ["one", "two"] } };
  });
  functions.register("function/echo@stable", () => ({ writes: { parts: ["p"] } }));
  // THE TWO CLEAN LIST-BUILDERS the steered shape routes between. Neither reads anything a tool
  // fetched, so whichever one runs writes `items` with `ctx.tainted` silent.
  functions.register("function/none@stable", () => ({ writes: { items: [] } }));
  functions.register("function/two@stable", () => ({ writes: { items: ["one", "two"] } }));
  // The delegated graph's own body, which runs in the CHILD run behind the child's own gate.
  functions.register("function/leaf@stable", () => ({ writes: { out: ["p"] } }));
  // THE FAN-BINDING SHAPE'S list producer: ONE element, and the element IS whatever the node
  // read — so the fan's `as` binding, and nothing else, carries the fetched bytes into the
  // delegation below it.
  functions.register("function/wrap@stable", (view) => {
    const text = view.visible.map((c) => String(view.get(c) ?? "")).join(" ");
    return { writes: { pitems: [text] } };
  });
  // The TRIPLE-nested shape's list producer. Only the OUTERMOST list empties on the word, so the
  // two inner fans are populated in both halves and the bound is being asked about depth rather
  // than about width.
  functions.register("function/nest3@stable", (view) => {
    const text = view.visible.map((c) => String(view.get(c) ?? "")).join(" ");
    return { writes: { s1: text.includes("NONE") ? [] : ["a", "b"], s2: ["p"], s3: ["q"] } };
  });
  // The nested shape's list producer: one seed per depth, both empty on the same word.
  functions.register("function/nest@stable", (view) => {
    const text = view.visible.map((c) => String(view.get(c) ?? "")).join(" ");
    const items = text.includes("NONE") ? [] : ["one", "two"];
    return { writes: { outerSeed: items, innerSeed: ["a"] } };
  });

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models: new ModelRegistry(),
    now: NOW,
    sleep: async () => {},
    maxParallelism: 1,
    ...(res === undefined ? {} : { resolver: res }),
    policy: { granted: ["net:fetch", "notes:write"], budget: { runUsd: 1 } },
  });
  return { engine, wrote: () => wrote };
}

function graphFor(o: Options) {
  return compileOrThrow({
    spec: spec(o),
    resolver: resolver(),
    tools: MANIFESTS,
    tenantCapabilities: ["net:fetch", "notes:write"],
  });
}

async function drive(o: Options): Promise<{ status: string; gates: number; wrote: number }> {
  const store = new MemoryStateStore({ now: NOW });
  // The fetched page is still what `fetch` returns in BOTH halves; when the list comes from the
  // input instead, the same word decides the width from the run's own text.
  const { engine, wrote } = engineOver(store, o.page);
  const cleanSteer = o.listFrom === "input" || o.listFrom === "steered-clean";
  const request = cleanSteer && o.page === "NONE" ? "NONE flagged today" : "please";
  const runId = await engine.submit({ graph: graphFor(o), inputs: { request } });
  const p = await engine.advance(runId as RunId);
  return { status: p.status, gates: Object.keys(p.gates).length, wrote: wrote() };
}

test("A ZERO-WIDTH FAN-OUT MAY NOT DELETE THE HUMAN GATE ON ITS BRANCH", async () => {
  // The control: the fetched page yields two items, the fan expands, and the authored gate stops
  // the run before anything is written.
  const two = await drive({ page: "TWO", gateOnBranch: true });
  assert.equal(two.status, "awaiting_gate", `precondition: the authored gate stops the run: ${two.status}`);
  assert.equal(two.wrote, 0, "precondition: nothing is written while a human is deciding");

  // THE EXPLOIT: the same graph, the same gate, a page that yields no items. `#fireEmptyJoin`
  // scheduled the join at the parent branch and the tool ran with nobody asked.
  const none = await drive({ page: "NONE", gateOnBranch: true });
  assert.equal(none.wrote, 0, "an empty fan deleted the authored gate and the tool ran unwatched");
  assert.equal(none.status, "awaiting_gate", `expected the skipped gate to be raised, got ${none.status}`);
  assert.equal(none.gates, 1, "and exactly one gate — the skipped oversight, not a gate per node");
});

test("AN EMPTY FAN WITH NOTHING UNSKIPPABLE ON IT STILL RUNS — the alert with no pods", async () => {
  // `#fireEmptyJoin` exists for this shape and the fix must not touch it: the fan body is an
  // ordinary function, nobody authored a gate there, and a barrier over zero branches is
  // satisfied. A guard that fired here would gate every empty fan in every graph.
  const none = await drive({ page: "NONE", gateOnBranch: false });
  assert.equal(none.status, "succeeded", `an empty fan with no gate on its branch must run out: ${none.status}`);
  assert.equal(none.gates, 0, "no gate: there was no oversight on the branch to skip");
  assert.equal(none.wrote, 1, "and the downstream the join releases runs");

  // The paired half, so the row above is a claim about the branch and not about the width.
  const two = await drive({ page: "TWO", gateOnBranch: false });
  assert.equal(two.status, "succeeded", `a populated fan with no gate on its branch must run out: ${two.status}`);
  assert.equal(two.gates, 0, "still no gate");
  assert.equal(two.wrote, 1, "and the tool runs once, below the join");
});

test("THE SKIPPED GATE SURVIVES A RESTART, AND APPROVING IT RELEASES THE RUN", async () => {
  // The escalation is durable — `onEscalate` appends `policy.escalated` and `projection.ts` folds
  // it back by `max` — so a second process reaches the same answer with no memory of the first.
  // Named here rather than assumed: every previous member of this class was a guard a restart
  // switched off in silence.
  const store = new MemoryStateStore({ now: NOW });
  const graph = graphFor({ page: "NONE", gateOnBranch: true });
  const first = engineOver(store, "NONE");
  const runId = await first.engine.submit({ graph, inputs: { request: "please" } });
  const held = await first.engine.advance(runId as RunId);
  assert.equal(held.status, "awaiting_gate", "precondition: the skipped gate raises one");
  const gate = Object.values(held.gates).find((g) => g.nodeId === "j");
  assert.ok(gate !== undefined, "precondition: the gate is on the join that releases the downstream");

  const second = engineOver(store, "NONE");
  await second.engine.attach(runId as RunId, graph);
  const still = await second.engine.advance(runId as RunId);
  assert.equal(still.status, "awaiting_gate", `a restart forgot the skipped gate: ${still.status}`);
  assert.equal(second.wrote(), 0, "and wrote nothing while it was still open");

  // AND IT IS A GATE, NOT A REFUSAL: an empty fan is a legitimate shape, so a human who looks
  // and approves gets the run they asked for.
  await second.engine.resolveGate(runId as RunId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });
  const after = await second.engine.advance(runId as RunId);
  assert.equal(after.status, "succeeded", `approving the skipped gate must release the run: ${after.status}`);
  assert.equal(second.wrote(), 1, "and the downstream the join was holding runs");
});

test("AN EMPTY FAN OVER A CLEAN LIST STILL RUNS — E12 is on the ATTACKER's width, not on width 0", async () => {
  // THE ORDINARY WORKFLOW E12 WAS COSTING: "for each flagged item, ask a person", over a list the
  // run's own input produced. On the days nothing is flagged the fan is empty for a reason nobody
  // attacked, and the graph has no attacker in it at all — but `#fireEmptyJoin` escalated on
  // "width 0 and a `human_gate` on the branch" with no predicate on WHOSE width it was.
  //
  //     the list is built from the run's input, nothing flagged -> awaiting_gate, gates=1  (before)
  //     the list is built from the run's input, nothing flagged -> succeeded,     gates=0  (now)
  //
  // ONE READ OF DIFFERENCE from the exploit above and nothing else: `fetch` still runs, and
  // `untrusted` is still tainted. The only thing that changed is which channel `plan` read.
  const none = await drive({ page: "NONE", gateOnBranch: true, listFrom: "input" });
  assert.equal(none.status, "succeeded", `an empty fan over a clean list must run out: ${none.status}`);
  assert.equal(none.gates, 0, "nobody attacked this width; asking a human for it is a gate on an ordinary workflow");
  assert.equal(none.wrote, 1, "and the downstream the join releases runs");

  // The paired half, so the row above is a claim about the LIST and not about the branch: the
  // same graph on a day something IS flagged runs the fan, and the authored gate stops it.
  const two = await drive({ page: "TWO", gateOnBranch: true, listFrom: "input" });
  assert.equal(two.status, "awaiting_gate", `the authored gate must still stop a populated fan: ${two.status}`);
  assert.equal(two.wrote, 0, "nothing is written while a human is deciding");
});

/**
 * The nested shape, which the flat one above cannot distinguish.
 *
 *     fetch -> plan -fanout(fo, over outerSeed)-> outer -fanout(fi, over innerSeed)-> inner
 *     inner -join(ji)-> innerJoin -seq-> hold        <-- the authored gate, at the OUTER depth
 *     outer -join(jo1)-> outerJoin ; innerJoin -join(jo2)-> ; hold -join(jo3)-> outerJoin -> write
 *
 * `hold` sits on the OUTER branch, one node past the INNER join. A `fanBody` that stops at the
 * first node of type `join` never reaches it, so an outer fan of width zero skipped it and E12
 * saw nothing to escalate — round 1's exploit reproduced verbatim one nesting level down.
 */
function nestedSpec(listFrom: "fetched" | "input"): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: `nested-empty-fan-${listFrom}`, project: "test", version: 1 },
    policy: {
      posture: "out",
      budget: { costUsd: 1 },
      capabilities: ["net:fetch", "notes:write"],
      expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 8, maxLoopIterations: 1 },
    },
    channels: {
      request: { type: "string", reduce: "replace" },
      untrusted: { type: "string", reduce: "replace" },
      outerSeed: { type: "array", reduce: "replace" },
      innerSeed: { type: "array", reduce: "replace" },
      outerItem: { type: "string", reduce: "replace" },
      innerItem: { type: "string", reduce: "replace" },
      parts: { type: "array", reduce: "append_ordered" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["request"],
    outputs: ["receipt"],
    nodes: [
      { id: "fetch", type: "tool", reads: ["request"], writes: ["untrusted"], tool: { name: "net.fetch", version: "1.0", args: {} } },
      {
        id: "plan",
        type: "function",
        reads: [listFrom === "input" ? "request" : "untrusted"],
        writes: ["outerSeed", "innerSeed"],
        function: { ref: "function/nest@stable", effects: [] },
      },
      { id: "outer", type: "function", reads: ["outerItem"], writes: ["parts"], function: { ref: "function/echo@stable", effects: [] } },
      { id: "inner", type: "function", reads: ["innerItem"], writes: ["parts"], function: { ref: "function/echo@stable", effects: [] } },
      { id: "innerJoin", type: "join", reads: ["parts"], writes: ["parts"], join: { branches: ["inner"], mode: "all", onBranchError: "skip" } },
      { id: "hold", type: "human_gate", reads: ["parts"], humanGate: { ref: "oversight/hold@stable" } },
      { id: "outerJoin", type: "join", reads: ["parts"], writes: ["parts"], join: { branches: ["outer", "innerJoin", "hold"], mode: "all", onBranchError: "skip" } },
      {
        id: "write",
        type: "tool",
        reads: ["request"],
        writes: ["receipt"],
        tool: { name: "notes.write", version: "1.0", args: {} },
        unhandled: true,
      },
    ],
    edges: [
      { id: "e0", from: "fetch", to: "plan", kind: "seq" },
      { id: "fo", from: "plan", to: "outer", kind: "fanout", over: "outerSeed", as: "outerItem", maxWidth: 4 },
      { id: "fi", from: "outer", to: "inner", kind: "fanout", over: "innerSeed", as: "innerItem", maxWidth: 4 },
      { id: "ji", from: "inner", to: "innerJoin", kind: "join", branches: ["inner"] },
      { id: "jo1", from: "outer", to: "outerJoin", kind: "join", branches: ["outer"] },
      { id: "jo2", from: "innerJoin", to: "outerJoin", kind: "join", branches: ["innerJoin"] },
      { id: "jo3", from: "hold", to: "outerJoin", kind: "join", branches: ["hold"] },
      { id: "toHold", from: "innerJoin", to: "hold", kind: "seq" },
      { id: "toWrite", from: "outerJoin", to: "write", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

async function driveNested(page: Options["page"], listFrom: "fetched" | "input"): Promise<{ status: string; gates: number; wrote: number }> {
  const store = new MemoryStateStore({ now: NOW });
  const { engine, wrote } = engineOver(store, page);
  const graph = compileOrThrow({
    spec: nestedSpec(listFrom),
    resolver: resolver(),
    tools: MANIFESTS,
    tenantCapabilities: ["net:fetch", "notes:write"],
  });
  const request = listFrom === "input" && page === "NONE" ? "NONE flagged today" : "please";
  const runId = await engine.submit({ graph, inputs: { request } });
  const p = await engine.advance(runId as RunId);
  return { status: p.status, gates: Object.keys(p.gates).length, wrote: wrote() };
}

test("A ZERO-WIDTH *OUTER* FAN MAY NOT DELETE A GATE PAST THE INNER JOIN", async () => {
  // The control: the page yields two outer items, the outer fan expands, and the authored gate
  // stops the run before the tool below the outer join can write.
  const two = await driveNested("TWO", "fetched");
  assert.equal(two.status, "awaiting_gate", `precondition: the authored gate stops the run: ${two.status}`);
  assert.equal(two.wrote, 0, "precondition: nothing is written while a human is deciding");

  // THE EXPLOIT, and it is round 1's verbatim: `fanBody` stopped at the first node of type
  // `join`, which in a nested fan is the INNER one — so `hold`, on the outer branch one node
  // past it, was outside the scan. Measured before the bound became the compiled fan-out depth:
  //
  //     page NONE -> succeeded, gates=0, wrote=1
  const none = await driveNested("NONE", "fetched");
  assert.equal(none.wrote, 0, "an empty OUTER fan deleted a gate past the inner join and the tool ran unwatched");
  assert.equal(none.status, "awaiting_gate", `expected the skipped gate to be raised, got ${none.status}`);
  assert.equal(none.gates, 1, "and exactly one gate");
});

test("THE NESTED SHAPE OVER A CLEAN LIST STILL RUNS — both halves, at both depths", async () => {
  // The half that must not move, in the shape that found the bug: nothing untrusted built either
  // seed list, so an empty outer fan is the run's own arithmetic and nobody is asked.
  const none = await driveNested("NONE", "input");
  assert.equal(none.status, "succeeded", `a nested empty fan over a clean list must run out: ${none.status}`);
  assert.equal(none.gates, 0, "no attacker chose this width");
  assert.equal(none.wrote, 1, "and the downstream the outer join releases runs");

  const two = await driveNested("TWO", "input");
  assert.equal(two.status, "awaiting_gate", `the authored gate must still stop a populated nested fan: ${two.status}`);
  assert.equal(two.wrote, 0, "nothing is written while a human is deciding");
});

// ---------------------------------------------------------------------------
// A `subgraph` ON THE SKIPPED BRANCH, whose CHILD holds the gate
// ---------------------------------------------------------------------------

const LEAF_REF = "graph/leaf@stable";

/** The delegated graph: a human gate, then the work. The parent cannot see either node. */
function leafSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "leaf-gate", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      payload: { type: "string", reduce: "replace" },
      out: { type: "array", reduce: "replace" },
    },
    inputs: ["payload"],
    outputs: ["out"],
    nodes: [
      { id: "hold", type: "human_gate", reads: ["payload"], humanGate: { ref: "oversight/hold@stable" } },
      { id: "leaf", type: "function", reads: ["payload"], writes: ["out"], function: { ref: "function/leaf@stable", effects: [] } },
    ],
    edges: [{ id: "toLeaf", from: "hold", to: "leaf", kind: "seq" }],
  } as unknown as GraphSpec;
}

/** `fetch -> plan -{fanout}-> delegate -{join}-> j -> write`, with `delegate` a `subgraph`. */
function subgraphSpec(listFrom: "fetched" | "input"): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: `sub-empty-fan-${listFrom}`, project: "test", version: 1 },
    policy: {
      posture: "out",
      budget: { costUsd: 1 },
      capabilities: ["net:fetch", "notes:write"],
      expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 },
    },
    channels: {
      request: { type: "string", reduce: "replace" },
      untrusted: { type: "string", reduce: "replace" },
      items: { type: "array", reduce: "replace" },
      item: { type: "string", reduce: "replace" },
      parts: { type: "array", reduce: "append_ordered" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["request"],
    outputs: ["receipt"],
    nodes: [
      { id: "fetch", type: "tool", reads: ["request"], writes: ["untrusted"], tool: { name: "net.fetch", version: "1.0", args: {} } },
      {
        id: "plan",
        type: "function",
        reads: [listFrom === "input" ? "request" : "untrusted"],
        writes: ["items"],
        function: { ref: "function/split@stable", effects: [] },
      },
      {
        id: "delegate",
        type: "subgraph",
        reads: ["item"],
        writes: ["parts"],
        subgraph: { ref: LEAF_REF, inputs: { payload: "item" }, outputs: { parts: "out" }, budgetShare: 0.4 },
      },
      { id: "j", type: "join", reads: ["parts"], writes: ["parts"], join: { branches: ["delegate"], mode: "all", onBranchError: "skip" } },
      {
        id: "write",
        type: "tool",
        reads: ["request"],
        writes: ["receipt"],
        tool: { name: "notes.write", version: "1.0", args: {} },
        unhandled: true,
      },
    ],
    edges: [
      { id: "e0", from: "fetch", to: "plan", kind: "seq" },
      { id: "fan", from: "plan", to: "delegate", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      { id: "jj", from: "delegate", to: "j", kind: "join", branches: ["delegate"] },
      { id: "toWrite", from: "j", to: "write", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

function subResolver(): ResourceResolver {
  const base = resolver();
  return { ...base, subgraph: (ref) => (ref === LEAF_REF ? leafSpec() : undefined) };
}

async function driveSubgraph(page: Options["page"], listFrom: "fetched" | "input"): Promise<{ status: string; gates: number; wrote: number }> {
  const store = new MemoryStateStore({ now: NOW });
  const { engine, wrote } = engineOver(store, page, subResolver());
  const graph = compileOrThrow({
    spec: subgraphSpec(listFrom),
    resolver: subResolver(),
    tools: MANIFESTS,
    tenantCapabilities: ["net:fetch", "notes:write"],
  });
  const request = listFrom === "input" && page === "NONE" ? "NONE flagged today" : "please";
  const runId = await engine.submit({ graph, inputs: { request } });
  const p = await engine.advance(runId as RunId);
  return { status: p.status, gates: Object.keys(p.gates).length, wrote: wrote() };
}

// ---------------------------------------------------------------------------
// AN AMBIGUOUS DEPTH ON THE FAN BRANCH
// ---------------------------------------------------------------------------

/**
 * `fetch -> plan -{fanout}-> mid -> amb -> hold`, with ONE extra edge into `amb`.
 *
 * `amb` is reachable at fan-out depth 1 (through the fan) and at depth 0 (through the
 * `conditional` from `plan`, whose `when` never matches), so `computeFanoutStacks` gives it no
 * stack at all and `index.fanoutDepth` has no entry. GRAPH008_JOIN_DEPTH refuses an ambiguous
 * depth for a join and its named arms; `amb` is neither, so the graph compiles.
 *
 * The join's arm is `mid`, whose depth IS defined — so the ambiguity is confined to the side
 * branch that carries the gate, which is exactly the shape a mutation or a never-taken
 * conditional produces.
 */
function ambiguousSpec(listFrom: "fetched" | "input"): GraphSpec {
  const planReads = listFrom === "input" ? ["request"] : ["untrusted", "request"];
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: `amb-empty-fan-${listFrom}`, project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, capabilities: ["net:fetch", "notes:write"] },
    channels: {
      request: { type: "string", reduce: "replace" },
      untrusted: { type: "string", reduce: "replace" },
      items: { type: "array", reduce: "replace" },
      item: { type: "string", reduce: "replace" },
      parts: { type: "array", reduce: "append_ordered" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["request"],
    outputs: ["receipt"],
    nodes: [
      { id: "fetch", type: "tool", reads: ["request"], writes: ["untrusted"], tool: { name: "net.fetch", version: "1.0", args: {} } },
      { id: "plan", type: "function", reads: planReads, writes: ["items"], function: { ref: "function/split@stable", effects: [] } },
      { id: "mid", type: "function", reads: ["item"], writes: ["parts"], function: { ref: "function/echo@stable", effects: [] } },
      { id: "amb", type: "function", reads: ["request"], writes: ["parts"], function: { ref: "function/echo@stable", effects: [] } },
      { id: "hold", type: "human_gate", reads: ["request"], humanGate: { ref: "oversight/hold@stable" } },
      { id: "j", type: "join", reads: ["parts"], writes: ["parts"], join: { branches: ["mid"], mode: "all", onBranchError: "skip" } },
      {
        id: "write",
        type: "tool",
        reads: ["request"],
        writes: ["receipt"],
        tool: { name: "notes.write", version: "1.0", args: {} },
        unhandled: true,
      },
    ],
    edges: [
      { id: "e0", from: "fetch", to: "plan", kind: "seq" },
      { id: "fan", from: "plan", to: "mid", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      { id: "toAmb", from: "mid", to: "amb", kind: "seq" },
      // THE ONE EXTRA INBOUND EDGE. Its `when` never matches, so it changes nothing the run does
      // — it changes only what `computeFanoutStacks` can say about `amb`.
      { id: "never", from: "plan", to: "amb", kind: "conditional", when: 'contains(request, "ZZZQQQ")' },
      { id: "toHold", from: "amb", to: "hold", kind: "seq" },
      { id: "jj", from: "mid", to: "j", kind: "join", branches: ["mid"] },
      { id: "toWrite", from: "j", to: "write", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

async function driveAmbiguous(page: Options["page"], listFrom: "fetched" | "input"): Promise<{ status: string; gates: number; wrote: number }> {
  const store = new MemoryStateStore({ now: NOW });
  const { engine, wrote } = engineOver(store, page);
  const graph = compileOrThrow({
    spec: ambiguousSpec(listFrom),
    resolver: resolver(),
    tools: MANIFESTS,
    tenantCapabilities: ["net:fetch", "notes:write"],
  });
  const request = listFrom === "input" && page === "NONE" ? "NONE flagged today" : "please";
  const runId = await engine.submit({ graph, inputs: { request } });
  const p = await engine.advance(runId as RunId);
  return { status: p.status, gates: Object.keys(p.gates).length, wrote: wrote() };
}

// ---------------------------------------------------------------------------
// A RETRY BACK-EDGE OUT OF A FAN BODY
// ---------------------------------------------------------------------------

/**
 * `fetch -> hold -> plan -{fanout}-> work -{join}-> j -> write`, with `work -{loop}-> hold`.
 *
 * The authored gate is ABOVE the fan, so on every run a person has already been asked before the
 * fan is planned at all. The retry edge is the ordinary "if the batch came back short, go round
 * again" shape, and it is a BACKWARD edge out of the fan body into a node at depth 0.
 */
function retrySpec(listFrom: "fetched" | "input"): GraphSpec {
  const planReads = listFrom === "input" ? ["request"] : ["untrusted"];
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: `retry-empty-fan-${listFrom}`, project: "test", version: 1 },
    policy: {
      posture: "out",
      budget: { costUsd: 1 },
      capabilities: ["net:fetch", "notes:write"],
      expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 8, maxLoopIterations: 2 },
    },
    channels: {
      request: { type: "string", reduce: "replace" },
      untrusted: { type: "string", reduce: "replace" },
      items: { type: "array", reduce: "replace" },
      item: { type: "string", reduce: "replace" },
      parts: { type: "array", reduce: "append_ordered" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["request"],
    outputs: ["receipt"],
    nodes: [
      { id: "fetch", type: "tool", reads: ["request"], writes: ["untrusted"], tool: { name: "net.fetch", version: "1.0", args: {} } },
      { id: "hold", type: "human_gate", reads: ["request"], humanGate: { ref: "oversight/hold@stable" } },
      { id: "plan", type: "function", reads: planReads, writes: ["items"], function: { ref: "function/split@stable", effects: [] } },
      { id: "work", type: "function", reads: ["item", "items"], writes: ["parts"], function: { ref: "function/echo@stable", effects: [] } },
      { id: "j", type: "join", reads: ["parts"], writes: ["parts"], join: { branches: ["work"], mode: "all", onBranchError: "skip" } },
      {
        id: "write",
        type: "tool",
        reads: ["request"],
        writes: ["receipt"],
        tool: { name: "notes.write", version: "1.0", args: {} },
        unhandled: true,
      },
    ],
    edges: [
      { id: "e0", from: "fetch", to: "hold", kind: "seq" },
      { id: "toPlan", from: "hold", to: "plan", kind: "seq" },
      { id: "fan", from: "plan", to: "work", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      { id: "jj", from: "work", to: "j", kind: "join", branches: ["work"] },
      { id: "retry", from: "work", to: "hold", kind: "loop", maxIterations: 2, until: "len(items) > 0" },
      { id: "toWrite", from: "j", to: "write", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/** Drive to the first stop, approve every open gate in turn, and count how many were asked. */
async function driveRetry(page: Options["page"], listFrom: "fetched" | "input"): Promise<{ status: string; gates: number; wrote: number }> {
  const store = new MemoryStateStore({ now: NOW });
  const { engine, wrote } = engineOver(store, page);
  const graph = compileOrThrow({
    spec: retrySpec(listFrom),
    resolver: resolver(),
    tools: MANIFESTS,
    tenantCapabilities: ["net:fetch", "notes:write"],
  });
  const request = listFrom === "input" && page === "NONE" ? "NONE flagged today" : "please";
  const runId = await engine.submit({ graph, inputs: { request } });
  let p = await engine.advance(runId as RunId);
  for (let i = 0; i < 8; i++) {
    const open = Object.values(p.gates).find((g) => g.state === "open");
    if (open === undefined) break;
    await engine.resolveGate(runId as RunId, {
      gateId: open.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:alice", via: "console" },
      idempotencyKey: `k${String(i)}`,
    });
    p = await engine.advance(runId as RunId);
  }
  return { status: p.status, gates: Object.keys(p.gates).length, wrote: wrote() };
}

test("A WIDTH AN ATTACKER STEERED IS THE ATTACKER'S, EVEN WHEN THE LIST IS CLEAN", async () => {
  // E12's predicate and `applyFanoutWidthTaint`'s were two copies of one question and they
  // drifted. `#fireEmptyJoin` asked only "is `fanout.over` tainted"; the other reads an INHERITED
  // control taint as evidence too. `applyTaint` never turns control taint into data taint, so
  // injected text that steers the run between two CLEAN list-builders produces an attacker-chosen
  // width over a channel `ctx.tainted` has never heard of. Both list-builders read `request` and
  // nothing else; what the page decides is which one runs.
  //
  //     the page steers into the empty builder -> succeeded,     gates=0, wrote=1   (before)
  //     the page steers into the empty builder -> awaiting_gate, gates=1, wrote=0   (now)
  const none = await drive({ page: "NONE", gateOnBranch: true, listFrom: "steered" });
  assert.equal(none.wrote, 0, "a steered clean list deleted the authored gate and the tool ran unwatched");
  assert.equal(none.status, "awaiting_gate", `expected the skipped gate to be raised, got ${none.status}`);
  assert.equal(none.gates, 1, "and exactly one gate");

  // The control: the same steer the other way expands the fan and the authored gate stops the run.
  const two = await drive({ page: "TWO", gateOnBranch: true, listFrom: "steered" });
  assert.equal(two.status, "awaiting_gate", `precondition: the authored gate stops a populated fan: ${two.status}`);
  assert.equal(two.wrote, 0, "precondition: nothing is written while a human is deciding");

  // THE HALF THAT MUST NOT MOVE, and it is one read of difference: the SAME graph with the router
  // branching on the run's own input. `fetch` still runs and `untrusted` is still tainted; the
  // steer is simply the run's own, so an empty fan is the run's own arithmetic.
  const cleanNone = await drive({ page: "NONE", gateOnBranch: true, listFrom: "steered-clean" });
  assert.equal(cleanNone.status, "succeeded", `a cleanly-steered empty fan must run out: ${cleanNone.status}`);
  assert.equal(cleanNone.gates, 0, "nobody attacked this width");
  assert.equal(cleanNone.wrote, 1, "and the downstream the join releases runs");
});

test("A `subgraph` ON THE SKIPPED BRANCH IS UNSKIPPABLE — the gate it hides is in its CHILD", async () => {
  // The unskippable set was the literal string "human_gate", scanned over the PARENT's nodes. A
  // `subgraph` node in the fan body delegates to a graph that holds the only gate there is, and
  // an empty fan passed over the delegation and the gate with it. Here `over` IS tainted, so this
  // is the SET being wrong rather than the predicate.
  //
  //     the page yields none -> succeeded,     gates=0, wrote=1   (before)
  //     the page yields none -> awaiting_gate, gates=1, wrote=0   (now)
  const none = await driveSubgraph("NONE", "fetched");
  assert.equal(none.wrote, 0, "an empty fan passed over a delegation whose child holds the gate");
  assert.equal(none.status, "awaiting_gate", `expected the skipped delegation to be raised, got ${none.status}`);
  assert.equal(none.gates, 1, "and exactly one gate");

  // The control: at width two the delegation runs and the CHILD's gate stops the parent.
  const two = await driveSubgraph("TWO", "fetched");
  assert.equal(two.status, "awaiting_gate", `precondition: the child's gate stops the run: ${two.status}`);
  assert.equal(two.wrote, 0, "precondition: nothing is written while a human is deciding");

  // The half that must not move: the same delegation over a list the run's own input produced.
  const clean = await driveSubgraph("NONE", "input");
  assert.equal(clean.status, "succeeded", `an empty fan over a clean list must run out: ${clean.status}`);
  assert.equal(clean.gates, 0, "no attacker chose this width");
  assert.equal(clean.wrote, 1, "and the downstream the join releases runs");
});

test("AN AMBIGUOUS DEPTH MEANS THE NODE MIGHT BE ON THE BRANCH — the walk descends through it", async () => {
  // `fanBody` admitted a successor and then refused to DESCEND whenever `index.fanoutDepth` had
  // no entry for it. A depth is absent whenever a node is reachable at two different fan-out
  // depths, and GRAPH008_JOIN_DEPTH refuses that only for joins and their named arms — so ONE
  // extra inbound edge, here a `conditional` whose `when` never matches, truncated the walk and
  // everything below it went invisible to BOTH consumers at once.
  //
  //     one extra inbound edge, page NONE -> succeeded,     gates=0, wrote=1   (before)
  //     one extra inbound edge, page NONE -> awaiting_gate, gates=1, wrote=0   (now)
  //
  // An unknown depth means the node MIGHT be on the branch, and the code answered "it is not".
  // Over-approximating the body is the direction `fanBody`'s last paragraph already picks for
  // `loop` edges.
  const none = await driveAmbiguous("NONE", "fetched");
  assert.equal(none.status, "awaiting_gate", `an ambiguous depth truncated the fan body: ${none.status}`);
  assert.equal(none.gates, 1, "the gate below the ambiguous node is on the branch and was skipped");
  assert.equal(none.wrote, 0, "and nothing is written while the escalation is open");

  // The control: at width two the gate on the side branch actually runs.
  const two = await driveAmbiguous("TWO", "fetched");
  assert.equal(two.status, "awaiting_gate", `precondition: the authored gate stops the run: ${two.status}`);
  assert.equal(two.gates, 1, "precondition: exactly the authored gate");

  // The half that must not move: the same ambiguity over a list the run's own input produced.
  const clean = await driveAmbiguous("NONE", "input");
  assert.equal(clean.status, "succeeded", `an empty fan over a clean list must run out: ${clean.status}`);
  assert.equal(clean.gates, 0, "no attacker chose this width");
  assert.equal(clean.wrote, 1, "and the downstream runs");
});

test("A RETRY BACK-EDGE OUT OF A FAN BODY DOES NOT PUT THE NODE ABOVE THE FAN IN IT", async () => {
  // `fanBody` did `seen.add(e.to)` BEFORE the depth test, so a `loop` edge out of the body
  // admitted its target whatever depth it was at. Here that target is the run's authored gate,
  // which sits ABOVE the fan and has already been asked and approved — so an empty fan escalated
  // on a gate that ran, and a second human was asked for it.
  //
  //     page NONE, list from the page -> succeeded, gates=2, wrote=1   (before)
  //     page NONE, list from the page -> succeeded, gates=1, wrote=1   (now)
  //
  // Only a `join` edge pops a fan-out level, so a node shallower than the body reached by
  // anything else is not this fan's exit.
  const none = await driveRetry("NONE", "fetched");
  assert.equal(none.gates, 1, "an empty fan asked a second human for the gate it had already passed");
  assert.equal(none.status, "succeeded", `the run must finish on the one authored gate: ${none.status}`);
  assert.equal(none.wrote, 1, "and the downstream runs");

  // The three rows that must not move: the same graph populated, and both halves over a list the
  // run's own input produced.
  assert.deepEqual(await driveRetry("TWO", "fetched"), { status: "succeeded", gates: 1, wrote: 1 }, "populated, page-built list");
  assert.deepEqual(await driveRetry("NONE", "input"), { status: "succeeded", gates: 1, wrote: 1 }, "empty, input-built list");
  assert.deepEqual(await driveRetry("TWO", "input"), { status: "succeeded", gates: 1, wrote: 1 }, "populated, input-built list");
});

// ---------------------------------------------------------------------------
// THE OTHER DIRECTION: parent-fetched bytes arriving in a CHILD as a run input
// ---------------------------------------------------------------------------

const FAN_LEAF_REF = "graph/fanleaf@stable";

/** The delegated graph, with its OWN fan, its OWN gate on the branch, and its OWN join. */
function fanChildSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "child-fan-gate", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      seed: { type: "string", reduce: "replace" },
      items: { type: "array", reduce: "replace" },
      item: { type: "string", reduce: "replace" },
      out: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      { id: "plan", type: "function", reads: ["seed"], writes: ["items"], function: { ref: "function/split@stable", effects: [] } },
      { id: "hold", type: "human_gate", reads: ["item"], humanGate: { ref: "oversight/hold@stable" } },
      { id: "j", type: "join", reads: ["out"], writes: ["out"], join: { branches: ["hold"], mode: "all", onBranchError: "skip" } },
      { id: "leaf", type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/leaf@stable", effects: [] } },
    ],
    edges: [
      { id: "fan", from: "plan", to: "hold", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      { id: "jj", from: "hold", to: "j", kind: "join", branches: ["hold"] },
      { id: "toLeaf", from: "j", to: "leaf", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/**
 * ONE WORKFLOW, TWO SHAPES. `flat` draws the fan, the gate and the join in the parent; `delegated`
 * hands the same channel to a child that draws them itself. `-clean` feeds both from the run's own
 * input instead of the fetched page, which is the half that must not gate.
 */
type Shape = "flat" | "delegated" | "flat-clean" | "delegated-clean";

function delegatingSpec(mode: Shape): GraphSpec {
  const src = mode.endsWith("-clean") ? "request" : "untrusted";
  const nodes: unknown[] = [
    { id: "fetch", type: "tool", reads: ["request"], writes: ["untrusted"], tool: { name: "net.fetch", version: "1.0", args: {} } },
    { id: "write", type: "tool", reads: ["request"], writes: ["receipt"], tool: { name: "notes.write", version: "1.0", args: {} }, unhandled: true },
  ];
  const edges: unknown[] = [];
  if (mode.startsWith("delegated")) {
    nodes.push({
      id: "delegate",
      type: "subgraph",
      reads: [src],
      writes: ["parts"],
      subgraph: { ref: FAN_LEAF_REF, inputs: { seed: src }, outputs: { parts: "out" }, budgetShare: 0.4 },
    });
    edges.push({ id: "e0", from: "fetch", to: "delegate", kind: "seq" });
    edges.push({ id: "toWrite", from: "delegate", to: "write", kind: "seq" });
  } else {
    nodes.push({ id: "plan", type: "function", reads: [src], writes: ["items"], function: { ref: "function/split@stable", effects: [] } });
    nodes.push({ id: "hold", type: "human_gate", reads: ["item"], humanGate: { ref: "oversight/hold@stable" } });
    nodes.push({ id: "j", type: "join", reads: ["parts"], writes: ["parts"], join: { branches: ["hold"], mode: "all", onBranchError: "skip" } });
    edges.push({ id: "e0", from: "fetch", to: "plan", kind: "seq" });
    edges.push({ id: "fan", from: "plan", to: "hold", kind: "fanout", over: "items", as: "item", maxWidth: 4 });
    edges.push({ id: "jj", from: "hold", to: "j", kind: "join", branches: ["hold"] });
    edges.push({ id: "toWrite", from: "j", to: "write", kind: "seq" });
  }
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: `parent-${mode}`, project: "test", version: 1 },
    policy: {
      posture: "out",
      budget: { costUsd: 1 },
      capabilities: ["net:fetch", "notes:write"],
      expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 },
    },
    channels: {
      request: { type: "string", reduce: "replace" },
      untrusted: { type: "string", reduce: "replace" },
      items: { type: "array", reduce: "replace" },
      item: { type: "string", reduce: "replace" },
      parts: { type: "array", reduce: "append_ordered" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["request"],
    outputs: ["receipt"],
    nodes,
    edges,
  } as unknown as GraphSpec;
}

function fanChildResolver(): ResourceResolver {
  const base = resolver();
  return { ...base, subgraph: (ref) => (ref === FAN_LEAF_REF ? fanChildSpec() : undefined) };
}

async function driveDelegating(mode: Shape, page: Options["page"], restart: boolean): Promise<{ status: string; gates: number; wrote: number }> {
  const store = new MemoryStateStore({ now: NOW });
  const graph = compileOrThrow({
    spec: delegatingSpec(mode),
    resolver: fanChildResolver(),
    tools: MANIFESTS,
    tenantCapabilities: ["net:fetch", "notes:write"],
  });
  const request = mode.endsWith("-clean") && page === "NONE" ? "NONE flagged today" : "please";
  const first = engineOver(store, page, fanChildResolver());
  const runId = (await first.engine.submit({ graph, inputs: { request } })) as RunId;
  let p = await first.engine.advance(runId);
  let wrote = first.wrote();
  if (restart) {
    // A SECOND PROCESS with no memory of the first, including no memory of the child's seed.
    const second = engineOver(store, page, fanChildResolver());
    await second.engine.attach(runId, graph);
    p = await second.engine.advance(runId);
    wrote += second.wrote();
  }
  return { status: p.status, gates: Object.keys(p.gates).length, wrote };
}

/**
 * A DELEGATION IS THE OTHER DIRECTION OF THE SAME MISTAKE, and this one is DOWNWARD.
 *
 * `#runSubgraph` resolves `sub.inputs` against the parent scope and `#contextFor` hands the child
 * a fresh empty `ctx.tainted`, so bytes a parent tool fetched arrive in the child as an ordinary
 * RUN INPUT — indistinguishable from a value a person typed. The child's own `#fireEmptyJoin`
 * then finds no evidence that the width was an attacker's and deletes the child's authored gate.
 * The SAME workflow flattened into the parent gates:
 *
 *     flat,      the page yields none -> awaiting_gate, gates=1, wrote=0   (both)
 *     delegated, the page yields none -> succeeded,     gates=0, wrote=1   (before)
 *     delegated, the page yields none -> awaiting_gate, gates=1, wrote=0   (now)
 *
 * The seed is journaled on the CHILD's own `run.submitted`, so the child's own fold rebuilds it —
 * the parent's `subgraph.started` is in the parent's journal and no child restart can reach it.
 */
test("A DELEGATION CARRIES TAINT DOWNWARD — a child input is not clean because it crossed a boundary", async () => {
  const flat = await driveDelegating("flat", "NONE", false);
  assert.equal(flat.status, "awaiting_gate", `precondition: flattened, the empty fan raises the skipped gate: ${flat.status}`);
  assert.equal(flat.wrote, 0, "precondition: flattened, nothing is written");

  const delegated = await driveDelegating("delegated", "NONE", false);
  assert.equal(delegated.wrote, 0, "the child saw parent-fetched bytes as a clean run input and deleted its own gate");
  assert.equal(delegated.status, "awaiting_gate", `expected the delegated workflow to gate like the flattened one, got ${delegated.status}`);
  assert.equal(delegated.gates, 1, "and exactly one gate");

  // IT SURVIVES A RESTART, which is what makes the seed a journaled fact rather than a field on a
  // context. Every previous member of this class was a guard a restart switched off in silence.
  const resumed = await driveDelegating("delegated", "NONE", true);
  assert.equal(resumed.status, "awaiting_gate", `a restart forgot the seed the delegation carried: ${resumed.status}`);
  assert.equal(resumed.wrote, 0, "and wrote nothing across the restart");
});

test("A DELEGATION OVER A CLEAN INPUT STILL RUNS — the seed is the parent's taint, not the boundary", async () => {
  // The half that must not move, and it is the one a seed keyed on "it crossed a boundary" would
  // break: the same delegation, the same empty fan, fed from the run's OWN input. Nothing
  // untrusted decided this width, so nothing gates — and the flattened shape agrees.
  const flat = await driveDelegating("flat-clean", "NONE", false);
  assert.equal(flat.status, "succeeded", `flattened over a clean list must run out: ${flat.status}`);
  assert.equal(flat.wrote, 1, "and the downstream the join releases runs");

  const delegated = await driveDelegating("delegated-clean", "NONE", false);
  assert.equal(delegated.status, "succeeded", `delegated over a clean list must run out: ${delegated.status}`);
  assert.equal(delegated.gates, 0, "nobody attacked this width");
  assert.equal(delegated.wrote, 1, "and the downstream the join releases runs");
});

// ---------------------------------------------------------------------------
// `fanBody`'s BOUND UNDER TRIPLE NESTING
// ---------------------------------------------------------------------------

/**
 * Three fans deep. `hold` sits on the OUTERMOST branch, past TWO inner joins; `after` sits BELOW
 * the outermost join. The compiled-depth bound has to put the first IN and the second OUT, and a
 * two-level fixture cannot tell a bound that stops at the first join from one that stops at the
 * fan's own.
 *
 *     plan -fo1-> L1 -fo2-> L2 -fo3-> L3 -j3-> J3 -j2b-> J2 -toHold-> hold -j1c-> J1 -> after
 *
 * Depths: L1 1, L2 2, L3 3, J3 2, J2 1, hold 1, J1 0, after 0. So the walk from `L1` admits
 * everything down to and including `J1` — the first node SHALLOWER than the body, reached by a
 * `join` edge — and stops there.
 */
type GateWhere = "branch" | "none" | "below";

function tripleSpec(where: GateWhere): GraphSpec {
  const hold =
    where === "branch"
      ? { id: "hold", type: "human_gate", reads: ["parts"], humanGate: { ref: "oversight/hold@stable" } }
      : { id: "hold", type: "function", reads: ["parts"], writes: ["parts"], function: { ref: "function/echo@stable", effects: [] } };
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: `triple-${where}`, project: "test", version: 1 },
    policy: {
      posture: "out",
      budget: { costUsd: 1 },
      capabilities: ["net:fetch", "notes:write"],
      expansion: { maxNodes: 64, maxDepth: 3, maxFanout: 8, maxLoopIterations: 1 },
    },
    channels: {
      request: { type: "string", reduce: "replace" },
      untrusted: { type: "string", reduce: "replace" },
      s1: { type: "array", reduce: "replace" },
      s2: { type: "array", reduce: "replace" },
      s3: { type: "array", reduce: "replace" },
      i1: { type: "string", reduce: "replace" },
      i2: { type: "string", reduce: "replace" },
      i3: { type: "string", reduce: "replace" },
      parts: { type: "array", reduce: "append_ordered" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["request"],
    outputs: ["receipt"],
    nodes: [
      { id: "fetch", type: "tool", reads: ["request"], writes: ["untrusted"], tool: { name: "net.fetch", version: "1.0", args: {} } },
      { id: "plan", type: "function", reads: ["untrusted"], writes: ["s1", "s2", "s3"], function: { ref: "function/nest3@stable", effects: [] } },
      { id: "L1", type: "function", reads: ["i1"], writes: ["parts"], function: { ref: "function/echo@stable", effects: [] } },
      { id: "L2", type: "function", reads: ["i2"], writes: ["parts"], function: { ref: "function/echo@stable", effects: [] } },
      { id: "L3", type: "function", reads: ["i3"], writes: ["parts"], function: { ref: "function/echo@stable", effects: [] } },
      { id: "J3", type: "join", reads: ["parts"], writes: ["parts"], join: { branches: ["L3"], mode: "all", onBranchError: "skip" } },
      { id: "J2", type: "join", reads: ["parts"], writes: ["parts"], join: { branches: ["L2", "J3"], mode: "all", onBranchError: "skip" } },
      hold,
      { id: "J1", type: "join", reads: ["parts"], writes: ["parts"], join: { branches: ["L1", "J2", "hold"], mode: "all", onBranchError: "skip" } },
      { id: "write", type: "tool", reads: ["request"], writes: ["receipt"], tool: { name: "notes.write", version: "1.0", args: {} }, unhandled: true },
      ...(where === "below" ? [{ id: "after", type: "human_gate", reads: ["parts"], humanGate: { ref: "oversight/hold@stable" } }] : []),
    ],
    edges: [
      { id: "e0", from: "fetch", to: "plan", kind: "seq" },
      { id: "fo1", from: "plan", to: "L1", kind: "fanout", over: "s1", as: "i1", maxWidth: 4 },
      { id: "fo2", from: "L1", to: "L2", kind: "fanout", over: "s2", as: "i2", maxWidth: 4 },
      { id: "fo3", from: "L2", to: "L3", kind: "fanout", over: "s3", as: "i3", maxWidth: 4 },
      { id: "j3", from: "L3", to: "J3", kind: "join", branches: ["L3"] },
      { id: "j2a", from: "L2", to: "J2", kind: "join", branches: ["L2"] },
      { id: "j2b", from: "J3", to: "J2", kind: "join", branches: ["J3"] },
      { id: "toHold", from: "J2", to: "hold", kind: "seq" },
      { id: "j1a", from: "L1", to: "J1", kind: "join", branches: ["L1"] },
      { id: "j1b", from: "J2", to: "J1", kind: "join", branches: ["J2"] },
      { id: "j1c", from: "hold", to: "J1", kind: "join", branches: ["hold"] },
      ...(where === "below"
        ? [
            { id: "toAfter", from: "J1", to: "after", kind: "seq" },
            { id: "toWrite", from: "after", to: "write", kind: "seq" },
          ]
        : [{ id: "toWrite", from: "J1", to: "write", kind: "seq" }]),
    ],
  } as unknown as GraphSpec;
}

async function driveTriple(page: Options["page"], where: GateWhere): Promise<{ status: string; gateNodes: string; escalated: string; wrote: number }> {
  const store = new MemoryStateStore({ now: NOW });
  const { engine, wrote } = engineOver(store, page);
  const graph = compileOrThrow({
    spec: tripleSpec(where),
    resolver: resolver(),
    tools: MANIFESTS,
    tenantCapabilities: ["net:fetch", "notes:write"],
  });
  const runId = await engine.submit({ graph, inputs: { request: "please" } });
  const p = await engine.advance(runId as RunId);
  return {
    status: p.status,
    gateNodes: Object.values(p.gates).map((g) => g.nodeId).sort().join(","),
    // The escalation key is `node:<runId>/<nodeId>`; only the node part is stable across runs.
    escalated: Object.keys(p.escalations).map((k) => k.split("/").pop() ?? "").sort().join(","),
    wrote: wrote(),
  };
}

test("THE FAN BODY'S BOUND HOLDS THREE FANS DEEP — past two inner joins, and stopping at its own", async () => {
  // IN. The outermost fan is empty, and the only `human_gate` sits on its branch past TWO inner
  // joins. A walk that stopped at the first `join` node, or at the first one it reached, would
  // never see it — E12 escalates on the outermost join, which is what says `fanBody` reached it.
  const inBody = await driveTriple("NONE", "branch");
  assert.equal(inBody.status, "awaiting_gate", `a gate two joins down the outer branch was skipped: ${inBody.status}`);
  assert.equal(inBody.escalated, "J1", "E12 escalates on the join that releases the downstream");
  assert.equal(inBody.wrote, 0, "and nothing is written while it is open");

  // OUT. The identical graph with the gate moved BELOW the outermost join. That node runs once at
  // every width including zero, so the width did not select it and E12 must say nothing — the
  // gate that stops the run here is the authored one doing its own job.
  const below = await driveTriple("NONE", "below");
  assert.equal(below.escalated, "", `the bound reached past the fan's own join: ${below.escalated}`);
  assert.equal(below.gateNodes, "after", "the only gate is the authored one, raised by itself");

  // AND NOT A CONSTANT ESCALATION. Nothing unskippable anywhere on the branch, same empty fan.
  const none = await driveTriple("NONE", "none");
  assert.equal(none.status, "succeeded", `an empty triple fan with nothing on its branch must run out: ${none.status}`);
  assert.equal(none.wrote, 1, "and the downstream the joins release runs");

  // The control at width two, so every row above is a claim about the BOUND and not the width.
  const two = await driveTriple("TWO", "branch");
  assert.equal(two.status, "awaiting_gate", `precondition: the authored gate stops a populated fan: ${two.status}`);
  assert.equal(two.escalated, "", "…on its own, with nothing escalated");
  assert.equal(two.wrote, 0, "and nothing written while it is open");
});

/**
 * `fetch -> wrap -{fanout over pitems as pitem}-> delegate{seed: "pitem"} -{join}-> j -> write`,
 * the delegation reading the fan's BINDING rather than a channel.
 */
function bindingSpec(clean: boolean): GraphSpec {
  const src = clean ? "request" : "untrusted";
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: `parent-binding-${clean ? "clean" : "dirty"}`, project: "test", version: 1 },
    policy: {
      posture: "out",
      budget: { costUsd: 1 },
      capabilities: ["net:fetch", "notes:write"],
      expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 },
    },
    channels: {
      request: { type: "string", reduce: "replace" },
      untrusted: { type: "string", reduce: "replace" },
      pitems: { type: "array", reduce: "replace" },
      pitem: { type: "string", reduce: "replace" },
      parts: { type: "array", reduce: "append_ordered" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["request"],
    outputs: ["receipt"],
    nodes: [
      { id: "fetch", type: "tool", reads: ["request"], writes: ["untrusted"], tool: { name: "net.fetch", version: "1.0", args: {} } },
      { id: "wrap", type: "function", reads: [src], writes: ["pitems"], function: { ref: "function/wrap@stable", effects: [] } },
      {
        id: "delegate",
        type: "subgraph",
        reads: ["pitem"],
        writes: ["parts"],
        subgraph: { ref: FAN_LEAF_REF, inputs: { seed: "pitem" }, outputs: { parts: "out" }, budgetShare: 0.4 },
      },
      { id: "j", type: "join", reads: ["parts"], writes: ["parts"], join: { branches: ["delegate"], mode: "all", onBranchError: "skip" } },
      { id: "write", type: "tool", reads: ["request"], writes: ["receipt"], tool: { name: "notes.write", version: "1.0", args: {} }, unhandled: true },
    ],
    edges: [
      { id: "e0", from: "fetch", to: "wrap", kind: "seq" },
      { id: "fan", from: "wrap", to: "delegate", kind: "fanout", over: "pitems", as: "pitem", maxWidth: 4 },
      { id: "jj", from: "delegate", to: "j", kind: "join", branches: ["delegate"] },
      { id: "toWrite", from: "j", to: "write", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

async function driveBinding(clean: boolean): Promise<{ status: string; gates: number; wrote: number }> {
  const store = new MemoryStateStore({ now: NOW });
  const graph = compileOrThrow({
    spec: bindingSpec(clean),
    resolver: fanChildResolver(),
    tools: MANIFESTS,
    tenantCapabilities: ["net:fetch", "notes:write"],
  });
  const { engine, wrote } = engineOver(store, "NONE", fanChildResolver());
  const runId = (await engine.submit({ graph, inputs: { request: "NONE flagged today" } })) as RunId;
  const p = await engine.advance(runId);
  return { status: p.status, gates: Object.keys(p.gates).length, wrote: wrote() };
}

/**
 * AND THE SEED HAS TO ASK THE PER-BRANCH READER, WHICH IS A ONE-HOP BYPASS OF THE ROW ABOVE.
 *
 * `#runSubgraph` computed the seed with `ctx.tainted.has(parentCh)` — the run-global set. A fan's
 * `as` binding is not in it: `applyFanoutTaint` records the fanout EDGE in `ctx.taintedFans`,
 * because a binding is not a channel any node writes and putting its NAME in the global set made
 * every fan sharing that name one taint fact (`RunContext.taintedFans` carries that measurement).
 * `taintedOn` is the only reader that consults both, and every other consumer was moved to it.
 *
 * `graph/validate.ts` requires `as` to be a declared channel and requires `sub.inputs`' parent
 * side to be a declared channel, so `inputs: { seed: "pitem" }` inside a fan body compiles — and
 * `scopeFor` merges the branch binding, so the child gets the fetched bytes. Same bytes, same two
 * graphs, one word of `sub.inputs` different:
 *
 *     inputs { seed: "untrusted" }  -> awaiting_gate, gates=1, wrote=0   (the row above)
 *     inputs { seed: "pitem" }      -> succeeded,     gates=0, wrote=1   (before)
 *     inputs { seed: "pitem" }      -> awaiting_gate, gates=1, wrote=0   (now)
 *
 * `docs/design-taint-rc6-2026-09-05.md` §4 named this as "also to reproduce" and `facts-owed.md`
 * carried it as a read-only finding. Two reviewers reproduced it independently on the merged
 * tree; this is the pin.
 */
test("A DELEGATION SEEDED FROM A FAN BINDING CARRIES THE TAINT TOO — the seed asks `taintedOn`", async () => {
  const dirty = await driveBinding(false);
  assert.equal(dirty.wrote, 0, "the child was seeded clean off a fan binding and deleted its own gate");
  assert.equal(dirty.status, "awaiting_gate", `expected the delegation inside the fan to gate, got ${dirty.status}`);
  assert.equal(dirty.gates, 1, "and exactly one gate");

  // THE HALF THAT MUST NOT MOVE. The identical graph with `wrap` reading the run's own input:
  // the same one-element list, the same empty child fan, the same delegation — and nothing
  // untrusted anywhere, so the child's gate is skipped for the reason the graph asked for.
  const clean = await driveBinding(true);
  assert.equal(clean.status, "succeeded", `a clean binding must not gate: ${clean.status}`);
  assert.equal(clean.gates, 0, "no gate on a fan nobody untrusted touched");
  assert.equal(clean.wrote, 1, "and the write runs");
});
