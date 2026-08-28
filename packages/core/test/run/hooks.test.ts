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
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { InProcessEventBus } from "../../src/bus.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { HOOK_POINTS, HookRegistry, narrowErrorDecision, narrowGateRequest, narrowNodeDecision, type HookBody } from "../../src/run/hooks.ts";
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

test("EVERY POINT THE COMPILER ACCEPTS IS A POINT THE ENGINE REALLY DISPATCHES", () => {
  // Read from the engine's SOURCE, not from a second hand-kept list. There WAS one —
  // `WIRED_POINTS` — while the design named nine points and the engine dispatched fewer, and the
  // compiler refused the difference so no intermediate state could lie. It is gone because the
  // difference is gone.
  //
  // A FLOOR, NOT A PROOF, and worth stating plainly: this asserts the point NAME appears in
  // `engine.ts`, which a mention in a comment would satisfy. Deleting `preNode`'s dispatch does
  // not turn it red — its behavioural test does that. What this catches is the case the floor is
  // for: a point added to `HOOK_POINTS` with no engine code at all, which is how the
  // declared-and-never-invoked defect comes back.
  const src = readFileSync(fileURLToPath(new URL("../../src/run/engine.ts", import.meta.url)), "utf8");
  const undispatched = HOOK_POINTS.filter((point) => !src.includes(`"${point}"`));
  assert.deepEqual(
    undispatched,
    [],
    "these points compile but the engine never dispatches them — wire them, or take them out of HOOK_POINTS",
  );

  // The other half: a point the engine dispatches but the compiler refuses would be just as dead.
  for (const point of HOOK_POINTS) {
    const r = compile({ spec: spec(point), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] });
    assert.equal(r.ok, true, `${point}: ${(r.diagnostics ?? []).map((d) => d.code).join(", ")}`);
  }
});

test("`prePlan` IS NOT A POINT — it is refuted, not pending", () => {
  // `submit` takes a COMPILED `RunGraph`, so the engine never holds a `GraphSpec` to filter. And
  // a hook that rewrote one would duplicate `compileMutation` with fewer guarantees: no
  // additive-only rule, no `graph.mutated` record a restart can rebuild from, and no
  // `mutation_introduced_irreversible` escalation. See 03-RUNTIME.md D6.9.
  assert.ok(!(HOOK_POINTS as readonly string[]).includes("prePlan"));
  const r = compile({ spec: spec("prePlan"), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] });
  assert.equal(r.ok, false, "a graph naming it must not compile");
  assert.ok((r.diagnostics ?? []).some((d) => d.code === "GRAPH003_UNKNOWN_HOOK_POINT"), "and it is UNKNOWN, not merely unwired");
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

// ── onError ──────────────────────────────────────────────────────────────────

/** A tool that always fails retryably, on a node whose policy allows 2 attempts. */
function flakyRig(hookBody?: HookBody): { engine: Engine; store: MemoryStateStore; calls: () => number; clock: { t: number } } {
  let n = 0;
  // A MOVABLE CLOCK. A retry sets `retryAfter = now + the policy's backoff curve` — there is no
  // `backoffMs` field, and this comment named one until `GRAPH020_UNKNOWN_FIELD` reached inside
  // `retry` and refused the spec below — and `advance` will not lease a
  // task that is still backing off — so a frozen clock plus any backoff spins forever. The first
  // draft of this test hung on exactly that.
  const clock = { t: NOW };
  const tools = new ToolRegistry();
  tools.register({
    name: "demo.write",
    version: "1.0",
    description: "d",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: true,
    parameters: { type: "object", properties: { body: { type: "string" } } },
    execute: () => {
      n += 1;
      throw Object.assign(new Error("blip"), { code: "E_PROVIDER_UNAVAILABLE", class: "unavailable", retryable: true });
    },
  } as ToolDefinition);
  const hooks = new HookRegistry();
  if (hookBody !== undefined) hooks.register("hook/guard@stable", hookBody);
  const store = new MemoryStateStore({ now: () => clock.t });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    hooks,
    now: () => clock.t,
    sleep: async () => {},
    policy: { granted: ["fs:write"], systemFloor: "out", budget: { runUsd: 1 } },
  });
  return { engine, store, calls: () => n, clock };
}

function retrySpec(): GraphSpec {
  const s = spec("onError") as unknown as { nodes: Record<string, unknown>[] };
  s.nodes[0]!["retry"] = { maxAttempts: 3, initialMs: 1 };
  return s as unknown as GraphSpec;
}

async function drain(r: { engine: Engine; clock: { t: number } }, runId: RunId): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const p = await r.engine.advance(runId);
    if (p.status === "succeeded" || p.status === "failed") return;
    r.clock.t += 60_000; // past any backoff, so the next advance can lease
  }
}

test("`onError` CAN SUPPRESS a retry the policy allowed", async () => {
  const withHook = flakyRig(() => ({ retry: false }));
  const g = compileOrThrow({ spec: retrySpec(), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] });
  const runId = await withHook.engine.submit({ graph: g, inputs: { note: "x" } });
  await drain(withHook, runId);

  const bare = flakyRig();
  const runId2 = await bare.engine.submit({
    graph: compileOrThrow({ spec: retrySpec(), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] }),
    inputs: { note: "x" },
  });
  await drain(bare, runId2);

  assert.ok(bare.calls() > 1, `the control must actually retry: ${String(bare.calls())} call(s)`);
  // NOT "a circuit breaker", which is what this message said. A green test whose message names
  // a breaker is the strongest possible false signal that one exists — and none does. The hook
  // is handed `{retry, afterMs}` and a context of `{point, runId, taskId, signal}`: no code, no
  // class, no source, and nowhere to hold state across calls. What it can express is a BLANKET
  // suppression keyed on the run and the node, which is what this hook does.
  assert.equal(withHook.calls(), 1, "a blanket suppressor stops the retry after the first failure");
});

test("`onError` IS NOT CONSULTED once the policy has refused — containment is structural", async () => {
  // The stronger of the two guarantees, and the one that does not depend on a merge function
  // being right: `#narrowRetry` is only reached when `#retryDecision` already said yes, so a
  // hook cannot resurrect a retry by any route. Re-running a non-idempotent tool that already
  // reached its sandbox is the case the policy refuses on purpose.
  //
  // The MERGE half — that `retry: true` is ignored even where the hook IS consulted — is
  // asserted directly against `narrowErrorDecision` below, because a run-level test cannot
  // distinguish "the merge refused it" from "the hook was never asked".
  const forced = flakyRig(() => ({ retry: true, afterMs: 0 }));
  const g = compileOrThrow({ spec: retrySpec(), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] });
  const runId = await forced.engine.submit({ graph: g, inputs: { note: "x" } });
  await drain(forced, runId);

  const bare = flakyRig();
  const runId2 = await bare.engine.submit({
    graph: compileOrThrow({ spec: retrySpec(), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] }),
    inputs: { note: "x" },
  });
  await drain(bare, runId2);

  assert.equal(forced.calls(), bare.calls(), "a hook asking for more retries gets exactly the policy's count");
});

test("narrowErrorDecision NARROWS ONLY — suppression composes, resurrection does not", () => {
  // The merge, asserted where it can actually be observed. `retry: true` from a hook must not
  // turn a suppression back on, whatever order the hooks ran in.
  assert.deepEqual(narrowErrorDecision({ retry: true, afterMs: 100 }, { retry: false }), { retry: false, afterMs: 100 });
  assert.deepEqual(
    narrowErrorDecision({ retry: false, afterMs: 100 }, { retry: true }),
    { retry: false, afterMs: 100 },
    "a later hook cannot un-suppress an earlier one",
  );

  // Backoff may only grow: a hook that wants to hammer a failing provider harder is ignored.
  assert.deepEqual(narrowErrorDecision({ retry: true, afterMs: 100 }, { afterMs: 5000 }), { retry: true, afterMs: 5000 });
  assert.deepEqual(
    narrowErrorDecision({ retry: true, afterMs: 5000 }, { afterMs: 1 }),
    { retry: true, afterMs: 5000 },
    "a SHORTER backoff is clamped to the policy's",
  );

  // Junk is ignored rather than trusted.
  assert.deepEqual(narrowErrorDecision({ retry: true, afterMs: 100 }, null), { retry: true, afterMs: 100 });
  assert.deepEqual(narrowErrorDecision({ retry: true, afterMs: 100 }, { afterMs: Number.NaN }), { retry: true, afterMs: 100 });
});

// ── onGate ───────────────────────────────────────────────────────────────────

test("narrowGateRequest — exclusions only GROW, editable channels only SHRINK", () => {
  // A gate carries authority. `approvers`, `defaultAction` and `onTimeout` are not reachable
  // from a hook at all, rather than reachable and validated — an extension that could add an
  // approver would be granting authority, which is invariant 5's asymmetry inverted.
  const base = { payload: { a: 1 }, excludedApprovers: ["u:alice"], allowEdit: ["notes", "plan"] };

  assert.deepEqual(
    narrowGateRequest(base, { excludedApprovers: ["u:bob"] }).excludedApprovers,
    ["u:alice", "u:bob"],
    "barring one more subject is a narrowing",
  );
  assert.deepEqual(
    narrowGateRequest(base, { excludedApprovers: [] }).excludedApprovers,
    ["u:alice"],
    "a hook cannot UN-bar someone by handing back a shorter list",
  );
  assert.deepEqual(
    narrowGateRequest(base, { allowEdit: ["notes"] }).allowEdit,
    ["notes"],
    "shrinking what an edit may write is a narrowing",
  );
  assert.deepEqual(
    narrowGateRequest(base, { allowEdit: ["notes", "plan", "secrets"] }).allowEdit,
    ["notes", "plan"],
    "and a channel the gate never allowed cannot be added",
  );

  // Authority fields are not in `GateView`, so a hook returning them changes nothing.
  const forged = narrowGateRequest(base, { approvers: ["u:attacker"], defaultAction: "approve", onTimeout: "default_action" });
  assert.deepEqual(forged.excludedApprovers, ["u:alice"]);
  assert.deepEqual(Object.keys(forged).sort(), ["allowEdit", "excludedApprovers", "payload"]);
});

test("`onGate` ENRICHES WHAT THE HUMAN SEES, and does NOT thereby move what is BOUND", async () => {
  // THE PROOF USED TO BE THE DIGEST, AND IT IS NOW THE PAYLOAD ITSELF, because the digest
  // stopped being a proxy for the display and became the binding.
  //
  // `contentDigest` is taken over `GateRequest.binding` — the re-derivable half of the question
  // — because `#approvalStillCovers` re-derives it at dispatch and refuses a payload that has
  // changed since the approval. A hook's output cannot be re-derived at dispatch (an extension
  // is not a pure function of the journal), so a digest that moved with the enrichment could not
  // be checked against anything, and the CRITICAL finding it exists to close would still be open.
  //
  // The property that actually matters is unchanged and is asserted DIRECTLY below, off
  // `openGates`, which is stronger than the digest ever was: the enrichment reaches the human.
  // The second assertion is the new half — an extension may widen or narrow the VIEW and may not
  // touch what the approval covers. An `onGate` hook that could move the binding would be an
  // extension deciding what an approval authorizes, which is the direction "oversight only
  // tightens" forbids.
  const gateSpec = (point: string) =>
    ({
      ...spec(point),
      policy: { posture: "on", expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
      nodes: [
        {
          id: "approve",
          type: "human_gate",
          reads: ["note"],
          writes: ["out"],
          humanGate: { ref: "oversight/g@stable", approval: { mode: "single", approvers: ["u:alice"] } },
        },
      ],
    }) as unknown as GraphSpec;

  const run = async (body?: HookBody): Promise<{ digest: string; applied: string[]; payload: unknown }> => {
    const hooks = new HookRegistry();
    if (body !== undefined) hooks.register("hook/guard@stable", body);
    const store = new MemoryStateStore({ now: () => NOW });
    const engine = new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools: new ToolRegistry(),
      functions: new FunctionRegistry(),
      models: new ModelRegistry(),
      hooks,
      now: () => NOW,
      sleep: async () => {},
      policy: { granted: [], systemFloor: "out", budget: { runUsd: 1 } },
    });
    const runId = await engine.submit({
      graph: compileOrThrow({ spec: gateSpec("onGate"), resolver: resolver(), tools: {}, tenantCapabilities: [] }),
      inputs: { note: "x" },
    });
    const p = await engine.advance(runId);
    assert.equal(p.status, "awaiting_gate", JSON.stringify(p.error ?? {}));
    const open = Object.values(p.gates).find((g) => g.state === "open");
    assert.ok(open, "a gate must be open");
    const applied: string[] = [];
    for await (const ev of store.read(runId, 1)) {
      if (ev.type === "hook.applied") applied.push((ev.payload as { point: string }).point);
    }
    const shown = (await engine.openGates(runId)).find((g) => g.gateId === open.gateId);
    assert.ok(shown, "the open gate must be listed with its rendered payload");
    return { digest: String(open.contentDigest), applied, payload: shown.payload };
  };

  const plain = await run();
  const enriched = await run((input) => ({
    payload: { ...((input as { payload: object }).payload as object), risk: "high" },
  }));

  assert.deepEqual(plain.applied, [], "no hook, nothing journaled");
  assert.deepEqual(enriched.applied, ["onGate"], "the enrichment is journaled as onGate");

  // THE HUMAN SEES IT — the whole point of the hook, asserted on the bytes rather than on a hash.
  assert.equal((plain.payload as Record<string, unknown>)["risk"], undefined, "nothing added it without the hook");
  assert.equal((enriched.payload as Record<string, unknown>)["risk"], "high", "the enrichment must reach the approver");

  // AND IT DOES NOT MOVE THE BINDING. Same node, same Task, same channel state, same arguments:
  // the same action is authorized whatever the console was told about it.
  assert.equal(enriched.digest, plain.digest, "an extension may change the VIEW and never what the approval binds");
});

// ── preNode ──────────────────────────────────────────────────────────────────

test("narrowNodeDecision — skipping composes, un-skipping does not", () => {
  assert.deepEqual(narrowNodeDecision({}, { skip: true, reason: "cached" }), { skip: true, reason: "cached" });
  assert.deepEqual(
    narrowNodeDecision({ skip: true }, { skip: false }),
    { skip: true },
    "a later hook cannot un-skip what an earlier one skipped",
  );
  assert.deepEqual(
    narrowNodeDecision({ skip: true, overrideWrites: { a: 1 } }, { overrideWrites: { b: 2 } }).overrideWrites,
    { a: 1, b: 2 },
    "writes merge across hooks",
  );
  assert.deepEqual(narrowNodeDecision({ skip: true }, "junk"), { skip: true }, "junk is ignored, not trusted");
});

test("`preNode` SKIPS a node and supplies its answer — and only its DECLARED channels", async () => {
  // The memoisation case. `out` is declared; `smuggled` is not, and a hook cannot write a channel
  // the node was never going to touch — route confinement's rule applied to state.
  let ran = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: "demo.write",
    version: "1.0",
    description: "d",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: false,
    parameters: { type: "object", properties: { body: { type: "string" } } },
    execute: () => {
      ran += 1;
      return { content: "ok", writes: { out: { ran: true } } };
    },
  } as ToolDefinition);
  const hooks = new HookRegistry();
  hooks.register("hook/guard@stable", () => ({
    skip: true,
    reason: "cached",
    overrideWrites: { out: { cached: true }, smuggled: "nope" },
  }));
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
  const runId = await engine.submit({
    graph: compileOrThrow({ spec: spec("preNode"), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] }),
    inputs: { note: "x" },
  });
  const p = await engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(ran, 0, "the node body must not have run");
  assert.deepEqual(p.channels["out"], { cached: true }, "the hook's answer stands in for it");
  assert.equal(p.channels["smuggled"], undefined, "an undeclared channel must NOT be writable by a hook");
});

test("A SKIPPING HOOK DOES NOT DEFEAT A GATE — policy stops the run before `preNode` is reached", async () => {
  // WHAT THIS PROVES, precisely: on the ordinary path a `human_gate` has posture `in`, so
  // `#executeTask`'s policy decision raises the gate and returns BEFORE `#dispatch` — and
  // `preNode` lives inside `#dispatch`. The containment here is structural, not the explicit
  // check, and deleting that check does not turn this test red. I found that by deleting it.
  //
  // The check is still load-bearing, on a path this test does not reach: a settled MIRROR gate
  // returns `this.#dispatch(...)` directly (`engine.ts`, `settled.mirrorOf !== undefined`), so
  // `#preNode` CAN see a `human_gate` in a subgraph delegation. Skipping the node whose entire
  // job is to be a human decision would be the bypass this repo already closed once from the
  // routing side, so it is refused before the hook's decision is even read.
  const hooks = new HookRegistry();
  hooks.register("hook/guard@stable", () => ({ skip: true, reason: "trust me" }));
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    hooks,
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 1 } },
  });
  const gateSpec = {
    ...spec("preNode"),
    policy: { posture: "on", expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    nodes: [
      {
        id: "approve",
        type: "human_gate",
        reads: ["note"],
        writes: ["out"],
        humanGate: { ref: "oversight/g@stable", approval: { mode: "single", approvers: ["u:alice"] } },
      },
    ],
  } as unknown as GraphSpec;
  const runId = await engine.submit({
    graph: compileOrThrow({ spec: gateSpec, resolver: resolver(), tools: {}, tenantCapabilities: [] }),
    inputs: { note: "x" },
  });
  const p = await engine.advance(runId);

  assert.equal(p.status, "awaiting_gate", `the gate must still stop the run: ${p.status}`);
  assert.ok(
    Object.values(p.gates).some((g) => g.state === "open"),
    "and a human must still be asked",
  );
});
