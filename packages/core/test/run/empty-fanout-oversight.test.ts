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
  readonly listFrom?: "fetched" | "input";
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
          {
        id: "plan",
        type: "function",
        reads: [o.listFrom === "input" ? "request" : "untrusted"],
        writes: ["items"],
        function: { ref: "function/split@stable", effects: [] },
      },
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
      { id: "e0", from: "fetch", to: "plan", kind: "seq" },
      { id: "fan", from: "plan", to: "hold", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      { id: "jj", from: "hold", to: "j", kind: "join", branches: ["hold"] },
      { id: "toWrite", from: "j", to: "write", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

function engineOver(store: MemoryStateStore, page: Options["page"]): { engine: Engine; wrote: () => number } {
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
  const request = o.listFrom === "input" && o.page === "NONE" ? "NONE flagged today" : "please";
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
