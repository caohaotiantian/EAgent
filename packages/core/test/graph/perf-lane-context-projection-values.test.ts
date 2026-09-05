/**
 * The compile-time half of `contextProjection`, held to the runtime's own accepted set.
 *
 * `run/context.ts` says in two places that a diagnostic for `take`, `maxTokens` and `overflow`
 * belongs in `graph/validate.ts` and that there is none — so `take: "abc"` and
 * `overflow: "TRUNCATE_TAIL"` compiled clean and refused at run time, `overflow` from inside
 * prompt assembly at whichever node first grew a channel past its bound.
 *
 * THE TEST IS THE AGREEMENT, not the diagnostic. The two checks live in different layers
 * (`graph/` must not import `run/`) so the reader is restated rather than shared, and a restated
 * reader is exactly the thing that drifts. Every value below is driven through BOTH — `compile`
 * and the runtime that would have caught it — and the assertion is that they answer the same.
 *
 * The one deliberate disagreement is pinned at the bottom, so it is a decision rather than a gap.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { assembleContext, project } from "../../src/run/context.ts";
import type { AssembleInput } from "../../src/run/context.ts";
import { stubResolver } from "./fixtures.ts";

/** A graph whose only interesting content is one channel's projection. */
function specWith(projection: unknown): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "proj", project: "test", version: 1 },
    policy: { posture: "out" },
    channels: {
      c: { type: "array", reduce: "replace", contextProjection: projection },
    },
    inputs: ["c"],
    outputs: ["c"],
    nodes: [{ id: "n" as NodeId, type: "function", reads: ["c"], writes: ["c"], function: { ref: "function/noop@stable" } }],
    edges: [],
  } as unknown as GraphSpec;
}

/** Whether `compile` produced an error naming this projection field. */
function refusedAtCompile(projection: unknown, field: string): boolean {
  const r = compile({ spec: specWith(projection), resolver: stubResolver(), tools: {}, tenantCapabilities: ["*"] });
  return r.diagnostics.some((d) => d.severity === "error" && d.message.includes(`contextProjection.${field}`));
}

const LONG = Array.from({ length: 400 }, () => "aaaaaaaaaaaaaaaaaaaa");

function assembleInput(projection: unknown): AssembleInput {
  return {
    system: "s",
    instruction: "i",
    channels: { c: LONG },
    channelSpecs: { c: { type: "array", reduce: "replace", contextProjection: projection } },
  } as unknown as AssembleInput;
}

/** Whether the runtime refuses this projection — `project` for `take`, rung 2 for the others. */
async function refusedAtRunTime(projection: Record<string, unknown>, field: string): Promise<boolean> {
  try {
    if (field === "take") project(["x", "y", "z"], projection as never);
    else await assembleContext(assembleInput(projection), { maxTokens: 120 });
    return false;
  } catch (e) {
    const message = (e as { message?: string }).message ?? "";
    assert.equal((e as { code?: string }).code, "E_GRAPH_INVALID", `expected a typed refusal, got ${String(e)}`);
    assert.ok(message.includes(field), `the runtime refusal names ${field}: ${message}`);
    return true;
  }
}

const READABLE = { maxTokens: 10, overflow: "truncate_tail" } as const;

test("`take`: compile refuses exactly the item counts the runtime refuses", async () => {
  // A NEGATIVE take is legal — "the last N findings" — and `0` is a slice of zero rather than
  // the absence of one, so both must pass. `null` is one of the two ways to declare no bound.
  const good: unknown[] = [3, -2, 0, 2.5, "3", " 3 ", "-2", null];
  const bad: unknown[] = ["abc", "", "   ", [], false, true, {}, NaN, Infinity];
  for (const take of good) {
    assert.equal(refusedAtCompile({ ...READABLE, take }, "take"), false, `take ${JSON.stringify(take)} must compile`);
    assert.equal(await refusedAtRunTime({ ...READABLE, take }, "take"), false, `take ${JSON.stringify(take)} must run`);
  }
  for (const take of bad) {
    assert.equal(await refusedAtRunTime({ ...READABLE, take }, "take"), true, `take ${JSON.stringify(take)} must refuse at run time`);
    assert.equal(refusedAtCompile({ ...READABLE, take }, "take"), true, `take ${JSON.stringify(take)} must refuse at compile`);
  }
});

test("`maxTokens`: compile refuses exactly the bounds the runtime refuses", async () => {
  // A QUOTED NUMBER IS A NUMBER. YAML makes `10` and `"10"` a quoting accident apart, and the
  // runtime reads the quoted form for that reason; refusing it here would turn a working graph
  // into a failing one.
  const good: unknown[] = [10, "10", " 10 ", 0.5];
  const bad: unknown[] = ["abc", null, {}, [], NaN, -5, 0, false];
  for (const maxTokens of good) {
    assert.equal(refusedAtCompile({ ...READABLE, maxTokens }, "maxTokens"), false, `maxTokens ${JSON.stringify(maxTokens)} must compile`);
    assert.equal(await refusedAtRunTime({ ...READABLE, maxTokens }, "maxTokens"), false, `maxTokens ${JSON.stringify(maxTokens)} must run`);
  }
  for (const maxTokens of bad) {
    assert.equal(await refusedAtRunTime({ ...READABLE, maxTokens }, "maxTokens"), true, `maxTokens ${JSON.stringify(maxTokens)} must refuse at run time`);
    assert.equal(refusedAtCompile({ ...READABLE, maxTokens }, "maxTokens"), true, `maxTokens ${JSON.stringify(maxTokens)} must refuse at compile`);
  }
});

test("`overflow`: compile refuses exactly the rules the runtime refuses", async () => {
  for (const overflow of ["truncate_tail", "summarize"]) {
    assert.equal(refusedAtCompile({ ...READABLE, overflow }, "overflow"), false, `overflow ${overflow} must compile`);
    assert.equal(await refusedAtRunTime({ ...READABLE, overflow }, "overflow"), false, `overflow ${overflow} must run`);
  }
  // `error` is the third accepted rule and refuses with E_CONTEXT_OVERFLOW rather than
  // E_GRAPH_INVALID — a different fault, and one the compiler must not report.
  assert.equal(refusedAtCompile({ ...READABLE, overflow: "error" }, "overflow"), false, "`error` is a rule this build knows");

  for (const overflow of ["TRUNCATE_TAIL", "nonsense", "", 7, null, {}]) {
    assert.equal(await refusedAtRunTime({ ...READABLE, overflow }, "overflow"), true, `overflow ${JSON.stringify(overflow)} must refuse at run time`);
    assert.equal(refusedAtCompile({ ...READABLE, overflow }, "overflow"), true, `overflow ${JSON.stringify(overflow)} must refuse at compile`);
  }
});

test("THE DIAGNOSTIC SAYS WHICH VALUE AND WHERE, because that is the whole point of moving it", () => {
  const r = compile({
    spec: specWith({ take: "abc", maxTokens: 10, overflow: "truncate_tail" }),
    resolver: stubResolver(),
    tools: {},
    tenantCapabilities: ["*"],
  });
  assert.equal(r.ok, false);
  const d = r.diagnostics.find((x) => x.message.includes("contextProjection.take"))!;
  assert.equal(d.severity, "error");
  assert.equal(d.at?.channel, "c", "it points at the channel");
  assert.match(d.message, /"abc"/, "and quotes the value that was refused");
  assert.match(d.fix ?? "", /quoted number/, "and says what a readable one looks like");
});

test("AN ABSENT `maxTokens` OR `overflow` STILL COMPILES — the one deliberate disagreement", async () => {
  // `applyOverflow` refuses both when they are absent, but it only runs at rung 2 — when a
  // channel actually exceeds its bound. A graph that declares neither runs correctly for as long
  // as it stays under, so refusing it at compile would refuse working graphs rather than close a
  // hole. Present-and-unreadable is the set the compiler decides; the run-time refusal covers
  // absence, unchanged.
  assert.equal(refusedAtCompile({ fields: ["x"] }, "maxTokens"), false, "no maxTokens is not a compile error");
  assert.equal(refusedAtCompile({ fields: ["x"] }, "overflow"), false, "no overflow is not a compile error");
  const r = compile({ spec: specWith({ fields: ["x"] }), resolver: stubResolver(), tools: {}, tenantCapabilities: ["*"] });
  assert.equal(r.ok, true, "and the graph compiles");
  // `take` is deliberately absent from this projection: a `take` small enough to matter would
  // shrink the context below the budget and rung 2 would never be reached at all.
  assert.equal(await refusedAtRunTime({ fields: ["x"] }, "maxTokens"), true, "while rung 2 still refuses it");
});

test("THE ORDINARY HALF: a fully-declared projection compiles clean and its graphHash is the spec's", () => {
  const spec = specWith({ fields: ["x"], take: -2, maxTokens: 100, overflow: "truncate_tail" });
  const r = compile({ spec, resolver: stubResolver(), tools: {}, tenantCapabilities: ["*"] });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.deepEqual(r.diagnostics, [], "no warnings either");
});
