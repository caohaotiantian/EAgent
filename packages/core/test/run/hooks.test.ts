/**
 * THE HOOK BUS — the extension surface, which was declared everywhere and invoked nowhere.
 *
 * `GraphSpec.hooks` was in the schema and shape-validated; its refs were resolved and pinned
 * into the resolution manifest; `hook.applied{ref,point,changed}` was in `EVENT_TYPES`; and
 * `"hook"` was a `ResourceKind`. Every piece existed except the thing that calls a hook, so a
 * graph could declare an extension, have it compile, have its digest pinned — and nothing ever
 * ran it. That reads, from any single file, exactly like a working extension point.
 *
 * The point NAME was an unenumerated string too, so `hooks: {preTolo: […]}` compiled clean and
 * was silent for a second reason. Both are closed here.
 *
 * `preTool` is the point that also closes a recorded gap: `PolicyEngine.decide` authorises on a
 * tool's STATIC class and never sees an argv, which is why "this `git` invocation is read-only
 * but that one force-pushes" had no home. A hook that rewrites or blocks on arguments is that
 * home, and it runs BEFORE policy so the arguments policy judges are the ones that will execute.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { HookRegistry, type HookBody } from "../../src/run/hooks.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import type { RunId } from "../../src/ids.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

function spec(point = "preTool", refs: readonly string[] = ["hook/guard@stable"]): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "hooked", project: "hooks", version: 1 },
    policy: { posture: "out", capabilities: ["fs:write"], expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["note"],
    outputs: ["out"],
    hooks: { [point]: refs },
    nodes: [
      {
        id: "write",
        type: "tool",
        reads: ["note"],
        writes: ["out"],
        tool: { name: "demo.write", version: "1.0", args: { body: "${note}" } },
        unhandled: true,
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly saw: Record<string, unknown>[];
}

function rig(body?: HookBody, extra: Readonly<Record<string, HookBody>> = {}): Rig {
  const saw: Record<string, unknown>[] = [];
  const tools = new ToolRegistry();
  const write: ToolDefinition = {
    name: "demo.write",
    version: "1.0",
    description: "The guarded action.",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: false,
    parameters: { type: "object", properties: { body: { type: "string" } } },
    execute: (args) => {
      saw.push(args);
      return { content: "ok", writes: { out: { ran: true } } };
    },
  };
  tools.register(write);

  const hooks = new HookRegistry();
  if (body !== undefined) hooks.register("hook/guard@stable", body);
  for (const [ref, b] of Object.entries(extra)) hooks.register(ref, b);

  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    hooks,
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: ["fs:write"], systemFloor: "out", budget: { runUsd: 1 } },
  });
  return { engine, store, saw };
}

async function applied(store: MemoryStateStore, runId: RunId): Promise<{ ref: string; point: string; changed: boolean }[]> {
  const out: { ref: string; point: string; changed: boolean }[] = [];
  for await (const ev of store.read(runId, 1)) {
    if (ev.type === "hook.applied") out.push(ev.payload as { ref: string; point: string; changed: boolean });
  }
  return out;
}

test("A `preTool` HOOK REWRITES THE ARGUMENTS THE TOOL ACTUALLY RECEIVES", async () => {
  // Argument-level policy, which `PolicyEngine` cannot express: it authorises on the tool's
  // static irreversibility class and never sees an argv.
  const r = rig((input) => {
    void input;
    return { args: { body: "[redacted]" } };
  });
  const runId = await r.engine.submit({ graph: compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] }), inputs: { note: "sensitive" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(r.saw, [{ body: "[redacted]" }], "the tool must receive the REWRITTEN arguments");

  const rows = await applied(r.store, runId);
  assert.deepEqual(
    rows,
    [{ ref: "hook/guard@stable", point: "preTool", changed: true }],
    "the rewrite must be journaled, naming WHICH extension rewrote it",
  );
});

test("A `preTool` HOOK BLOCKS THE CALL, and the tool body never runs", async () => {
  const r = rig(() => ({ block: true, reason: "argv is not provably read-only" }));
  const runId = await r.engine.submit({ graph: compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] }), inputs: { note: "x" } });
  const p = await r.engine.advance(runId);

  assert.deepEqual(r.saw, [], "the guarded action must not have run");
  assert.notEqual(p.status, "succeeded", `a blocked unhandled tool node fails its run: ${p.status}`);
});

test("A SECOND HOOK CANNOT UN-BLOCK THE FIRST — narrowing composes, widening does not", async () => {
  // TWO hooks at one point, in declaration order. The first blocks; the second tries to reverse
  // it AND to hand back fields the bus does not read. `runFilters` stops at the terminal
  // decision so the second never runs, and `narrowToolDecision` keeps only block/reason/args —
  // a hook that invents `posture` is not refused, it is IGNORED, which is the safer failure when
  // the alternative is trusting a field nobody validated.
  let secondRan = false;
  const r = rig(
    () => ({ block: true, reason: "first says no" }),
    {
      "hook/permissive@stable": () => {
        secondRan = true;
        return { block: false, posture: "out", capabilities: ["*"] };
      },
    },
  );
  const g = compileOrThrow({
    spec: spec("preTool", ["hook/guard@stable", "hook/permissive@stable"]),
    resolver: resolver(),
    tools: {},
    tenantCapabilities: ["fs:write"],
  });
  const runId = await r.engine.submit({ graph: g, inputs: { note: "x" } });
  await r.engine.advance(runId);

  assert.deepEqual(r.saw, [], "blocked stays blocked");
  assert.equal(secondRan, false, "the chain must STOP at a terminal decision, not run on and be overridden");
});

test("BUT TWO HOOKS THAT BOTH NARROW BOTH APPLY, in declaration order", async () => {
  // The control for the test above: stopping early is about TERMINAL decisions, not about
  // refusing to run more than one extension. Two rewriters compose, and both are journaled.
  const r = rig(
    () => ({ args: { body: "one" } }),
    { "hook/second@stable": (input) => ({ args: { body: `${(input as { args?: { body?: string } }).args?.body ?? "?"}+two` } }) },
  );
  const g = compileOrThrow({
    spec: spec("preTool", ["hook/guard@stable", "hook/second@stable"]),
    resolver: resolver(),
    tools: {},
    tenantCapabilities: ["fs:write"],
  });
  const runId = await r.engine.submit({ graph: g, inputs: { note: "x" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(r.saw, [{ body: "one+two" }], "the second hook sees the first's rewrite");
  assert.deepEqual(
    (await applied(r.store, runId)).map((x) => x.ref),
    ["hook/guard@stable", "hook/second@stable"],
    "both rewrites are journaled, in declaration order",
  );
});

test("A HOOK DECIDES ON THE ARGV — the thing `PolicyEngine` structurally cannot do", async () => {
  // THE RECORDED GAP, closed. `PolicyEngine.decide` authorises on {capabilities,
  // irreversibility, dataClassification, tainted} and never sees an argument, and
  // `irreversibility` is STATIC per tool — so "this invocation is read-only but that one
  // force-pushes" had nowhere to live, and it is why EAgent's `bash-policy` could not be moved
  // into core. A `preTool` hook sees the tool name and the current arguments and may refuse one
  // call of a tool it allows in general.
  const guard: HookBody = (input) => {
    const s = input as { tool: string; args: Record<string, unknown> };
    assert.equal(s.tool, "demo.write", "the hook must be told WHICH tool it is judging");
    return /--force/.test(String(s.args["body"] ?? "")) ? { block: true, reason: "argv is not provably safe" } : undefined;
  };

  const safe = rig(guard);
  const okRun = await safe.engine.submit({ graph: compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] }), inputs: { note: "git status" } });
  assert.equal((await safe.engine.advance(okRun)).status, "succeeded");
  assert.deepEqual(safe.saw, [{ body: "git status" }], "the benign invocation runs");

  const danger = rig(guard);
  const badRun = await danger.engine.submit({ graph: compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] }), inputs: { note: "git push --force" } });
  await danger.engine.advance(badRun);
  assert.deepEqual(danger.saw, [], "the SAME tool, refused on its arguments alone");
});

test("A GRAPH NAMING A HOOK POINT THAT DOES NOT EXIST FAILS TO COMPILE", () => {
  // The second silence. `hooks` is a `Record<string, …>`, so a typo used to compile, resolve
  // its refs and pin their digests — and never fire.
  const r = compile({ spec: spec("preTolo"), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] });
  assert.equal(r.ok, false, "an unknown hook point must not compile");
  const codes = (r.diagnostics ?? []).map((x) => x.code);
  assert.ok(codes.includes("GRAPH003_UNKNOWN_HOOK_POINT"), codes.join(", "));
  const d = (r.diagnostics ?? []).find((x) => x.code === "GRAPH003_UNKNOWN_HOOK_POINT");
  assert.match(d?.fix ?? "", /preTool/, "the refusal must name the points that DO exist");
});

test("AND A REAL POINT STILL COMPILES — the refusal is about the name, not about hooks", () => {
  const r = compile({ spec: spec("postTool"), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] });
  assert.equal(r.ok, true, (r.diagnostics ?? []).map((x) => `${x.code}: ${x.message}`).join("; "));
});

test("A GRAPH WITH NO HOOKS REGISTERED RUNS UNCHANGED — the bus is optional", async () => {
  // A deployment that installs no extensions must behave exactly as it did before the bus
  // existed, or every existing graph is a regression.
  const r = rig();
  const runId = await r.engine.submit({ graph: compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] }), inputs: { note: "plain" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(r.saw, [{ body: "plain" }], "the tool receives its declared arguments");
  assert.deepEqual(await applied(r.store, runId), [], "and nothing is journaled");
});
