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
import { HOOK_POINTS, HookRegistry, WIRED_POINTS, type HookBody } from "../../src/run/hooks.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
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

// ── the other wired points ───────────────────────────────────────────────────

test("EVERY POINT THE COMPILER ACCEPTS IS A POINT THE ENGINE DISPATCHES", () => {
  // `HOOK_POINTS` is the design's nine; `WIRED_POINTS` is what is built. Narrowing the compiler
  // from "any string" to "one of nine" did not close the declared-and-never-invoked defect — it
  // just spelled the silence better. The compiler refuses an unwired point, so the two lists can
  // never quietly disagree.
  for (const point of HOOK_POINTS) {
    const r = compile({ spec: spec(point), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] });
    const wired = WIRED_POINTS.has(point);
    assert.equal(r.ok, wired, `${point}: wired=${String(wired)} but compile ok=${String(r.ok)}`);
    if (!wired) {
      assert.ok(
        (r.diagnostics ?? []).some((d) => d.code === "GRAPH003_UNWIRED_HOOK_POINT"),
        `${point} must be refused as UNWIRED, not as unknown`,
      );
    }
  }
});

test("`preModel` rewrites the request that is ESTIMATED and SENT", async () => {
  const seen: string[] = [];
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      script: (req) => {
        seen.push(req.system);
        return { text: JSON.stringify({ ok: true }), finishReason: "stop" };
      },
    }),
    true,
  );
  const hooks = new HookRegistry();
  hooks.register("hook/guard@stable", (input) => ({ ...(input as object), system: "REWRITTEN" }));
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    hooks,
    now: () => NOW,
    sleep: async () => {},
    resolver: resolver(),
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  const agentSpec = {
    ...spec("preModel"),
    nodes: [
      {
        id: "ask",
        type: "agent",
        reads: ["note"],
        writes: ["out"],
        agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable", maxTurns: 2, outputSchema: { type: "object" } },
      },
    ],
  } as unknown as GraphSpec;
  const runId = await engine.submit({
    graph: compileOrThrow({ spec: agentSpec, resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] }),
    inputs: { note: "x" },
  });
  const p = await engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(seen, ["REWRITTEN"], "the provider must receive the FILTERED request");

  // And the journal must record the model that was actually called, not the pre-filter one.
  const applied = [];
  for await (const ev of store.read(runId, 1)) if (ev.type === "hook.applied") applied.push(ev.payload);
  assert.deepEqual(applied, [{ ref: "hook/guard@stable", point: "preModel", changed: true }]);
});

test("`postTool` rewrites the result before it becomes durable", async () => {
  const r = rig();
  const hooks = new HookRegistry();
  hooks.register("hook/redact@stable", (input) => ({ ...(input as object), content: "[redacted]" }));
  const store = new MemoryStateStore({ now: () => NOW });
  const tools = new ToolRegistry();
  tools.register({
    name: "demo.write",
    version: "1.0",
    description: "d",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: false,
    parameters: { type: "object", properties: { body: { type: "string" } } },
    execute: () => ({ content: "SECRET", writes: { out: { ran: true } } }),
  } as ToolDefinition);
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
  const s = { ...spec("postTool"), hooks: { postTool: ["hook/redact@stable"] } } as unknown as GraphSpec;
  const runId = await engine.submit({
    graph: compileOrThrow({ spec: s, resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] }),
    inputs: { note: "x" },
  });
  await engine.advance(runId);

  let journalled = "";
  for await (const ev of store.read(runId, 1)) {
    if (ev.type === "effect.completed") journalled = JSON.stringify(ev.payload);
  }
  assert.ok(!journalled.includes("SECRET"), `the unredacted result must never become durable: ${journalled}`);
  assert.ok(journalled.includes("[redacted]"), journalled);
  void r;
});
