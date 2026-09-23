/**
 * A node's reserved ERROR PROJECTION — `DESIGN.md` D8, phase one; `TODO.md` §A.90.
 *
 * An `error` arm used to be handed no reason: a failed node writes nothing, and `fs.read`
 * answered a missing file, an unreadable file and a path the jail refuses with ONE code. The
 * shipped `grant-access` could therefore not tell "no ledger yet" from "a ledger I cannot read",
 * and destroyed a prior grant with exit 0. What this file pins, each against the running engine
 * rather than against a docstring:
 *
 *  - the three `fs.read` outcomes wear three codes, and the arm READS which one (`"<id>:error"`);
 *  - the projection is a pure function of the fold — it survives losing the process between the
 *    failure and the read, and a replay serves the identical fact;
 *  - `ok: true` comes only from a task that SUCCEEDED, and an absent task is no projection at all,
 *    never success;
 *  - the envelope has exactly its six fields;
 *  - every misuse the compiler can see is refused.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { builtinTools } from "../../src/builtin/tools.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import { errorProjectionSource, type ErrorProjection, type GraphSpec, type RunGraph } from "../../src/graph/spec.ts";
import type { NodeId, RunId, TaskId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { viewFor, type RunProjection, type TaskRecord } from "../../src/run/projection.ts";
import { HookRegistry } from "../../src/run/hooks.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

// ── the envelope ─────────────────────────────────────────────────────────────

test("the envelope declares exactly its SIX fields — three of them reserved, with no producer yet", () => {
  // `Record<keyof ErrorProjection, true>` is the pin: a field removed is a missing key and a field
  // added is an excess one, and either is a TYPE ERROR in `npm run typecheck`, before any runtime.
  const fields: Record<keyof ErrorProjection, true> = {
    ok: true,
    code: true,
    message: true,
    truncated: true,
    bytes: true,
    classification: true,
  };
  assert.deepEqual(Object.keys(fields).sort(), ["bytes", "classification", "code", "message", "ok", "truncated"]);
  const plain: ErrorProjection["classification"][] = ["untrusted", "secret", "plain", undefined];
  assert.equal(plain.length, 4);
});

test("the reserved NAME is `<nodeId>:error`, and nothing a channel could be called", () => {
  assert.equal(errorProjectionSource("read-ledger:error"), "read-ledger");
  assert.equal(errorProjectionSource("a.b_c-1:error"), "a.b_c-1");
  // `.` is legal in a channel name, so `x.error` IS a channel and must never be read as this.
  assert.equal(errorProjectionSource("read-ledger.error"), undefined);
  assert.equal(errorProjectionSource(":error"), undefined);
  assert.equal(errorProjectionSource("a b:error"), undefined);
  assert.equal(errorProjectionSource("-x:error"), undefined);
  assert.equal(errorProjectionSource("x:errors"), undefined);
});

// ── the fold: what `viewFor` serves ──────────────────────────────────────────

function projectionWith(tasks: readonly Partial<TaskRecord>[]): RunProjection {
  const out: Record<string, TaskRecord> = {};
  for (const t of tasks) {
    const full = { branch: { segments: [] }, iteration: 0, attempt: 1, edgesIn: [], take: [], writes: {}, ...t } as TaskRecord;
    out[String(full.taskId)] = full;
  }
  return { channels: {}, bindings: {}, tasks: out } as unknown as RunProjection;
}

const READS = ["src:error"];
const at = (p: RunProjection): unknown => viewFor(p, {}, { segments: [] }, READS).get("src:error");

test("ok:true ONLY from `succeeded`; ok:false only from `failed`; every other state is NO projection", () => {
  const task = { taskId: "src@root#0" as TaskId, nodeId: "src" as NodeId };
  assert.equal(at(projectionWith([])), undefined, "a node that never ran has no projection");
  for (const state of ["pending", "ready", "leased", "awaiting_gate", "retrying", "skipped", "cancelled"] as const) {
    assert.equal(at(projectionWith([{ ...task, state }])), undefined, `${state} must not be read as anything`);
  }
  assert.deepEqual(at(projectionWith([{ ...task, state: "succeeded" }])), { ok: true });
  assert.deepEqual(
    at(projectionWith([{ ...task, state: "failed", error: { class: "not_found", code: "E_FS_NOT_FOUND", message: "gone", retryable: false } }])),
    { ok: false, code: "E_FS_NOT_FOUND", message: "gone" },
  );
  // A FAILED TASK WITH NO RECORD IS NOT A SUCCESS EITHER.
  assert.equal(at(projectionWith([{ ...task, state: "failed" }])), undefined);
});

test("a task that FAILED and then SUCCEEDED is ok:true and carries none of the old failure", () => {
  // `upsertTask` spreads the previous record, so a retried-then-succeeded task still holds its
  // `error`. The projection must read the STATE, never the leftover field.
  const p = projectionWith([
    {
      taskId: "src@root#0" as TaskId,
      nodeId: "src" as NodeId,
      state: "succeeded",
      error: { class: "unavailable", code: "E_TOOL_SOURCE_UNAVAILABLE", message: "blip", retryable: true },
    },
  ]);
  assert.deepEqual(at(p), { ok: true });
});

test("a name the node did not declare in `reads` is not served, and does not enter the view's hash", () => {
  const p = projectionWith([{ taskId: "src@root#0" as TaskId, nodeId: "src" as NodeId, state: "succeeded" }]);
  const without = viewFor(p, {}, { segments: [] }, []);
  assert.equal(without.get("src:error"), undefined);
  const withIt = viewFor(p, {}, { segments: [] }, READS);
  assert.notEqual(withIt.hash, without.hash, "a projection the node reads is part of what it read");
});

// ── the compiler ─────────────────────────────────────────────────────────────

function spec(nodes: readonly unknown[], edges: readonly unknown[], channels: Record<string, unknown> = {}): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "err-proj", project: "test", version: 1 },
    policy: { posture: "out", capabilities: ["fs:read"], expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 3 } },
    channels: {
      path: { type: "string", reduce: "replace" },
      doc: { type: "string", reduce: "replace" },
      out: { type: "object", reduce: "merge_object", onConflict: "last_by_branch" },
      ...channels,
    },
    inputs: ["path"],
    outputs: ["out"],
    nodes,
    edges,
  } as unknown as GraphSpec;
}

const READ = { id: "r", type: "tool", reads: ["path"], writes: ["doc"], tool: { name: "fs.read", version: "1.0", args: { path: "${path}" } } };
const ARM = (reads: readonly string[] = ["r:error"], type = "function"): Record<string, unknown> => ({
  id: "arm",
  type,
  reads,
  writes: ["out"],
  ...(type === "function" ? { function: { ref: "function/arm@stable" } } : {}),
  ...(type === "agent" ? { agent: { profile: "agent_profile/x@stable", prompt: "prompt/x@stable" } } : {}),
});
const OK = { id: "ok", type: "function", reads: ["r:error"], writes: ["out"], function: { ref: "function/ok@stable" } };
const EDGES = [
  { id: "then", from: "r", to: "ok", kind: "seq" },
  { id: "failed", from: "r", to: "arm", kind: "error" },
];

function codes(s: GraphSpec): string[] {
  const r = compile({ spec: s, resolver: resolver(), tools: FS_TOOLS, tenantCapabilities: ["fs:read"] });
  return r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

const FS_TOOLS = { "fs.read": builtinTools({ root: tmpdir(), deny: [] }).find((t) => t.name === "fs.read")! };
const FS_TOOLS_WITH_WRITE = Object.fromEntries(
  builtinTools({ root: tmpdir(), deny: [] }).filter((t) => ["fs.read", "fs.write", "fs.glob"].includes(t.name)).map((t) => [t.name, t]),
);

test("the ordinary shape compiles clean: an error arm and a seq arm each reading the source's projection", () => {
  assert.deepEqual(codes(spec([READ, OK, ARM()], EDGES)), []);
});

test("EVERY MISUSE THE COMPILER CAN SEE IS REFUSED, each under its own code", () => {
  const cases: readonly (readonly [string, GraphSpec, string])[] = [
    ["an agent reader", spec([READ, OK, ARM(["r:error"], "agent")], EDGES), "GRAPH005_ERROR_PROJECTION_READER"],
    [
      "a tool argument template",
      spec([READ, OK, { id: "arm", type: "tool", reads: [], writes: ["doc"], tool: { name: "fs.read", version: "1.0", args: { path: "${r:error}" } } }], EDGES),
      "GRAPH005_ERROR_PROJECTION_READER",
    ],
    ["a node that does not exist", spec([READ, OK, ARM(["nope:error"])], EDGES), "GRAPH005_ERROR_PROJECTION_UNKNOWN_NODE"],
    ["its own projection", spec([READ, OK, ARM(["arm:error"])], EDGES), "GRAPH005_ERROR_PROJECTION_UNORDERED"],
    [
      "a node that cannot run first",
      spec([READ, { ...OK, reads: ["arm:error"] }, ARM(["path"])], EDGES),
      "GRAPH005_ERROR_PROJECTION_UNORDERED",
    ],
    [
      "a WRITE to it",
      spec([READ, OK, { ...ARM(), writes: ["out", "r:error"] }], EDGES),
      "GRAPH005_ERROR_PROJECTION_WRITE",
    ],
    [
      "a source that observes a secret",
      spec([{ ...READ, reads: ["path", "key"] }, OK, ARM()], EDGES, { key: { type: "string", reduce: "replace", classification: "secret_ref" } }),
      "GRAPH005_ERROR_PROJECTION_CLASSIFIED",
    ],
  ];
  for (const [what, s, code] of cases) assert.ok(codes(s).includes(code), `${what}: expected ${code}, got ${JSON.stringify(codes(s))}`);
});

test("a source that observes a secret only THROUGH another projection is refused too", () => {
  // `mid` reads r's projection; `r` observes a secret_ref. Reading `mid:error` is two hops from it.
  const s = spec(
    [
      { ...READ, reads: ["path", "key"] },
      { id: "mid", type: "function", reads: ["r:error"], writes: ["doc"], function: { ref: "function/mid@stable" } },
      { id: "arm", type: "function", reads: ["mid:error"], writes: ["out"], function: { ref: "function/arm@stable" } },
    ],
    [
      { id: "failed", from: "r", to: "mid", kind: "error" },
      { id: "mid-failed", from: "mid", to: "arm", kind: "error" },
    ],
    { key: { type: "string", reduce: "replace", classification: "secret_ref" } },
  );
  // ON `arm` — `mid` is refused for its own one-hop read, and that diagnostic must not be what
  // satisfies this assertion.
  const onArm = compile({ spec: s, resolver: resolver(), tools: FS_TOOLS, tenantCapabilities: ["fs:read"] })
    .diagnostics.filter((d) => d.severity === "error" && d.at?.nodeId === "arm")
    .map((d) => d.code);
  assert.deepEqual(onArm, ["GRAPH005_ERROR_PROJECTION_CLASSIFIED"]);
});

test("a source hanging OFF a loop body runs once per pass too, and is refused like one inside it", () => {
  // A reviewer's graph: `S` is not ON the cycle A->B->A, it hangs off `B` by a `seq` edge — and
  // still runs once per pass, because the iteration travels along the edge. Served "highest
  // iteration", a reader downstream of pass 0's FAILURE was handed pass 2's `ok: true`. This
  // compiled clean until the refusal covered every node reachable from a cycle.
  const s = spec(
    [
      { id: "A", type: "function", reads: ["path"], writes: ["doc"], function: { ref: "function/a@stable" } },
      { id: "B", type: "function", reads: ["doc"], writes: ["path"], function: { ref: "function/b@stable" } },
      { id: "r", type: "tool", reads: ["path"], writes: ["doc"], tool: { name: "fs.read", version: "1.0", args: { path: "${path}" } } },
      ARM(),
    ],
    [
      { id: "ab", from: "A", to: "B", kind: "seq" },
      { id: "back", from: "B", to: "A", kind: "loop", until: "doc == \"x\"", maxIterations: 3 },
      { id: "off", from: "B", to: "r", kind: "seq" },
      { id: "failed", from: "r", to: "arm", kind: "error" },
    ],
  );
  assert.ok(codes(s).includes("GRAPH005_ERROR_PROJECTION_IN_LOOP"), JSON.stringify(codes(s)));
});

test("a SUBGRAPH handed a secret in `inputs` is a classified source, whatever it declares in `reads`", () => {
  // `E_SUBGRAPH_FAILED` carries the child's message verbatim, so a child quoting an input it was
  // handed puts that input into the projection. `observedChannels` does not see `subgraph.inputs`.
  const s = {
    ...spec(
      [
        { id: "sub", type: "subgraph", reads: [], writes: ["doc"], subgraph: { ref: "graph/child@stable", inputs: { k: "key" }, outputs: { doc: "r" } } },
        { id: "arm", type: "function", reads: ["sub:error"], writes: ["out"], function: { ref: "function/arm@stable" } },
      ],
      [{ id: "failed", from: "sub", to: "arm", kind: "error" }],
      { key: { type: "string", reduce: "replace", classification: "secret_ref" } },
    ),
    inputs: ["path", "key"],
  } as GraphSpec;
  const onArm = compile({ spec: s, resolver: resolver(), tools: FS_TOOLS, tenantCapabilities: ["fs:read"] })
    .diagnostics.filter((d) => d.severity === "error" && d.at?.nodeId === "arm")
    .map((d) => d.code);
  assert.deepEqual(onArm, ["GRAPH005_ERROR_PROJECTION_CLASSIFIED"]);
});

test("a `postTool` hook that redacts a failed read's CONTENT redacts the MESSAGE the arm reads too", async () => {
  // Before `fs.read` returned a typed error, the failure was built FROM `content`, so a redactor
  // covered it. A typed error carries its own copy of the text, which the hook never sees.
  const ws = workspace();
  try {
    const hooks = new HookRegistry();
    hooks.register("hook/redact@stable", (input) => ({ ...(input as object), content: "[redacted]" }));
    const tools = new ToolRegistry();
    for (const t of builtinTools({ root: ws.root, deny: [] })) if (t.name === "fs.read") tools.register(t);
    const functions = new FunctionRegistry();
    functions.register("function/arm@stable", ((view: { get: (c: string) => unknown }) => ({ writes: { out: { arm: view.get("r:error") ?? "ABSENT" } } })) as never);
    functions.register("function/ok@stable", (() => ({ writes: { out: { ok: true } } })) as never);
    const store = new MemoryStateStore({ now: () => NOW });
    const engine = new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools,
      functions,
      models: new ModelRegistry(),
      hooks,
      now: () => NOW,
      sleep: async () => {},
      policy: { granted: ["fs:read"], systemFloor: "out", budget: { runUsd: 1 } },
    });
    const s = { ...spec([READ, OK, ARM()], EDGES), hooks: { postTool: ["hook/redact@stable"] } } as unknown as GraphSpec;
    const graph = compileOrThrow({ spec: s, resolver: resolver(), tools: FS_TOOLS, tenantCapabilities: ["fs:read"] });
    const runId = await engine.submit({ graph, inputs: { path: "out/SECRET-NAME.json" } });
    let p = await engine.advance(runId);
    for (let i = 0; i < 8 && p.status === "running"; i++) p = await engine.advance(runId);
    assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
    assert.deepEqual(p.channels["out"], { arm: { ok: false, code: CODES.E_FS_NOT_FOUND, message: "[redacted]" } });
    // AND DURABLY: both journaled copies of the message are the hook's. (`details.path` and the run's
    // own input still name the path — the hook rewrote `content`, which is all it asked to.)
    const messages: string[] = [];
    for await (const e of store.read(runId, 1)) {
      if (e.type === "effect.completed" && String(e.payload.key).includes(":tool:")) messages.push(String((e.payload as unknown as { result: { error: { message: string } } }).result.error.message));
      if (e.type === "task.failed") messages.push(String((e.payload as unknown as { error: { message: string } }).error.message));
    }
    assert.deepEqual(messages, ["[redacted]", "[redacted]"]);
  } finally {
    ws.dispose();
  }
});

test("a source INSIDE A LOOP BODY, or inside a fan-out the reader is not in, is refused", () => {
  const loop = spec(
    [
      { id: "r", type: "tool", reads: ["path"], writes: ["doc"], tool: { name: "fs.read", version: "1.0", args: { path: "${path}" } } },
      { id: "again", type: "function", reads: ["doc"], writes: ["path"], function: { ref: "function/again@stable" } },
      ARM(),
    ],
    [
      { id: "next", from: "r", to: "again", kind: "seq" },
      { id: "back", from: "again", to: "r", kind: "loop", until: "doc == \"x\"", maxIterations: 3 },
      { id: "failed", from: "r", to: "arm", kind: "error" },
    ],
  );
  assert.ok(codes(loop).includes("GRAPH005_ERROR_PROJECTION_IN_LOOP"), JSON.stringify(codes(loop)));

  const fan = spec(
    [
      { id: "plan", type: "function", reads: ["path"], writes: ["items"], function: { ref: "function/plan@stable" } },
      { id: "r", type: "tool", reads: ["item"], writes: ["doc"], tool: { name: "fs.read", version: "1.0", args: { path: "${item}" } } },
      { id: "gather", type: "join", reads: ["doc"], writes: ["doc"], join: { branches: ["r"], mode: "all", onBranchError: "skip" } },
      { id: "arm", type: "function", reads: ["r:error"], writes: ["out"], function: { ref: "function/arm@stable" } },
    ],
    [
      { id: "fo", from: "plan", to: "r", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      { id: "in", from: "r", to: "gather", kind: "join", branches: ["r"] },
      { id: "after", from: "gather", to: "arm", kind: "seq" },
    ],
    { items: { type: "array", reduce: "replace" }, item: { type: "string", reduce: "replace" }, doc: { type: "array", reduce: "append_ordered" } },
  );
  assert.ok(codes(fan).includes("GRAPH005_ERROR_PROJECTION_BRANCH"), JSON.stringify(codes(fan)));
});

test("an AMBIGUOUS fan-out stack is refused, and the compile does not throw on it", () => {
  // A reviewer's graph. `br` is reached both through the fan-out and through `r`'s error edge, so
  // its enclosing fan-outs disagree and `fanoutEdgeStack` holds `undefined` for `arm`. Without the
  // `=== undefined` arms of the BRANCH check, `compile` THREW (`Cannot read properties of
  // undefined (reading 'length')`) instead of reporting anything.
  //
  // IT OVER-REFUSES HERE, and that is recorded rather than loosened: `r` runs at the root, so its
  // projection IS on `arm`'s branch chain. An ambiguous stack is a question the compiler cannot
  // answer, and refusing is the failing-closed answer to it.
  const s = spec(
    [
      READ,
      { id: "plan", type: "function", reads: ["doc"], writes: ["items"], function: { ref: "function/plan@stable" } },
      { id: "br", type: "function", reads: ["item"], writes: ["doc2"], function: { ref: "function/br@stable" } },
      { id: "J", type: "join", reads: ["doc2"], writes: ["doc2"], join: { branches: ["br"], mode: "all", onBranchError: "skip" } },
      ARM(),
    ],
    [
      { id: "rp", from: "r", to: "plan", kind: "seq" },
      { id: "fo", from: "plan", to: "br", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      { id: "in", from: "br", to: "J", kind: "join", branches: ["br"] },
      { id: "after", from: "J", to: "arm", kind: "seq" },
      { id: "brerr", from: "br", to: "arm", kind: "error" },
      { id: "rerr", from: "r", to: "arm", kind: "error" },
    ],
    { items: { type: "array", reduce: "replace" }, item: { type: "string", reduce: "replace" }, doc2: { type: "array", reduce: "append_ordered" } },
  );
  let diags: readonly { severity: string; code: string; at?: { nodeId?: string } }[] = [];
  assert.doesNotThrow(() => {
    diags = compile({ spec: s, resolver: resolver(), tools: FS_TOOLS, tenantCapabilities: ["fs:read"] }).diagnostics;
  });
  const onArm = diags.filter((d) => d.severity === "error" && d.at?.nodeId === "arm" && d.code.startsWith("GRAPH005_ERROR_PROJECTION"));
  assert.deepEqual(onArm.map((d) => d.code), ["GRAPH005_ERROR_PROJECTION_BRANCH"]);
});

test("an error edge still filtering fs.read on E_TOOL_SOURCE_UNAVAILABLE alone is WARNED about — the ab1654f7 grant-access", () => {
  // Before D8 a missing file was `E_TOOL_SOURCE_UNAVAILABLE`, and `grant-access` handled "no ledger
  // yet" with exactly this filter. After, the edge no longer matches a missing file and the run
  // fails where it routed — so a graph written the old way hears about it at compile time.
  //
  // The shipped graph with its `no-ledger` edge put back to its `ab1654f7` line 139,
  // `codes: ["E_TOOL_SOURCE_UNAVAILABLE"]` — the one line this rule reads. (The rest of that
  // revision differs by the deleted `look` node, which the rule does not look at; read out of git
  // history it would make this suite depend on a full clone.)
  const shipped = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../examples/graphs/grant-access.json", import.meta.url)), "utf8")) as GraphSpec;
  const old = {
    ...shipped,
    edges: shipped.edges.map((e) => (e.id === "no-ledger" ? { ...e, codes: ["E_TOOL_SOURCE_UNAVAILABLE"] } : e)),
  } as GraphSpec;
  const warned = (g: GraphSpec) =>
    compile({ spec: g, resolver: resolver(), tools: FS_TOOLS_WITH_WRITE, tenantCapabilities: ["fs:read", "fs:write"] })
      .diagnostics.filter((d) => d.code === "GRAPH003_STALE_FS_READ_CODE");
  assert.deepEqual(warned(shipped), [], "the shipped graph has no `codes` filter and is silent");
  const got = warned(old);
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.equal(got[0]!.severity, "warning");
  assert.equal(got[0]!.at?.edgeId, "no-ledger");
  for (const code of ["E_FS_NOT_FOUND", "E_FS_UNREADABLE", "E_CAP_DENIED"]) assert.match(String(got[0]!.fix), new RegExp(code));

  // Naming ANY of the three new codes beside it is an author who has seen the split: silent.
  const updated = {
    ...old,
    edges: old.edges.map((e) => (e.id === "no-ledger" ? { ...e, codes: ["E_TOOL_SOURCE_UNAVAILABLE", "E_FS_NOT_FOUND"] } : e)),
  } as GraphSpec;
  assert.deepEqual(warned(updated), []);
  // And a filter off a node that is NOT fs.read is none of this rule's business.
  const other = { ...old, nodes: old.nodes.map((n) => (n.id === "read-ledger" ? { ...n, tool: { ...n.tool!, name: "fs.glob" } } : n)) } as GraphSpec;
  assert.deepEqual(warned(other), []);
});

// ── the engine: fs.read's three codes, read by the arm ───────────────────────

interface Rig {
  readonly engine: Engine;
  readonly store: StateStore;
  readonly graph: RunGraph;
  readonly functions: FunctionRegistry;
  readonly tools: ToolRegistry;
}

/** The arm and the seq arm both record the projection they were handed, under their own key. */
function rig(root: string, store: StateStore = new MemoryStateStore({ now: () => NOW }), nodes?: readonly unknown[], edges?: readonly unknown[]): Rig {
  const tools = new ToolRegistry();
  for (const t of builtinTools({ root, deny: [] })) if (t.name === "fs.read") tools.register(t);
  const functions = new FunctionRegistry();
  functions.register("function/arm@stable", ((view: { get: (c: string) => unknown }) => ({ writes: { out: { arm: view.get("r:error") ?? "ABSENT" } } })) as never);
  functions.register("function/ok@stable", ((view: { get: (c: string) => unknown }) => ({ writes: { out: { ok: view.get("r:error") ?? "ABSENT" } } })) as never);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: ["fs:read"], systemFloor: "out", budget: { runUsd: 1 } },
  });
  const graph = compileOrThrow({ spec: spec(nodes ?? [READ, OK, ARM()], edges ?? EDGES), resolver: resolver(), tools: FS_TOOLS, tenantCapabilities: ["fs:read"] });
  return { engine, store, graph, functions, tools };
}

async function drive(r: Rig, runId: RunId): Promise<RunProjection> {
  let p = await r.engine.advance(runId);
  for (let i = 0; i < 8 && p.status === "running"; i++) p = await r.engine.advance(runId);
  return p;
}

function workspace(): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "loom-errproj-"));
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "out", "present.json"), "{}");
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("MISSING, UNREADABLE and PATH-REFUSED reach the arm as THREE DIFFERENT codes", async () => {
  const ws = workspace();
  const outside = mkdtempSync(join(tmpdir(), "loom-errproj-outside-"));
  try {
    writeFileSync(join(ws.root, "out", "locked.json"), "{}");
    chmodSync(join(ws.root, "out", "locked.json"), 0o000);
    writeFileSync(join(outside, "x.json"), "{}");
    symlinkSync(join(outside, "x.json"), join(ws.root, "out", "escape.json"));

    const seen: Record<string, unknown> = {};
    for (const [path, want] of [
      ["out/missing.json", CODES.E_FS_NOT_FOUND],
      ["out/nowhere/missing.json", CODES.E_FS_NOT_FOUND],
      ["out/locked.json", CODES.E_FS_UNREADABLE],
      ["out", CODES.E_FS_UNREADABLE],
      ["out/escape.json", CODES.E_CAP_DENIED],
      ["../../etc/passwd", CODES.E_CAP_DENIED],
    ] as const) {
      const r = rig(ws.root);
      const runId = await r.engine.submit({ graph: r.graph, inputs: { path } });
      const p = await drive(r, runId);
      assert.equal(p.status, "succeeded", `${path}: ${JSON.stringify(p.error ?? {})}`);
      const got = (p.channels["out"] as { arm?: ErrorProjection; ok?: unknown }) ?? {};
      assert.equal(got.ok, undefined, `${path}: the seq arm must not run`);
      assert.equal(got.arm?.ok, false, `${path}: ${JSON.stringify(got)}`);
      assert.equal(got.arm?.code, want, `${path}: ${JSON.stringify(got)}`);
      assert.match(String(got.arm?.message), /./, `${path}: the message travels with the code`);
      // THE RESERVED FIELDS HAVE NO PRODUCER YET, and are absent rather than defaulted.
      assert.deepEqual(Object.keys(got.arm ?? {}).sort(), ["code", "message", "ok"], path);
      seen[path] = got.arm?.code;
    }
    assert.equal(new Set(Object.values(seen)).size, 3, `three codes, not one: ${JSON.stringify(seen)}`);
  } finally {
    chmodSync(join(ws.root, "out", "locked.json"), 0o644);
    rmSync(outside, { recursive: true, force: true });
    ws.dispose();
  }
});

test("the SEQ arm reads ok:true, and the error arm does not run", async () => {
  const ws = workspace();
  try {
    const r = rig(ws.root);
    const p = await drive(r, await r.engine.submit({ graph: r.graph, inputs: { path: "out/present.json" } }));
    assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
    assert.deepEqual(p.channels["out"], { ok: { ok: true } });
  } finally {
    ws.dispose();
  }
});

test("A RESTART between the failure and the read hands the arm the same fact, and a replay serves it again", async () => {
  // THE JOURNAL IS THE ONLY AUTHORITATIVE STATE: `r` fails in process 1, a gate parks the run,
  // process 1 vanishes, and the arm runs in process 2 off nothing but the file. The projection
  // is not stored anywhere — it is folded out of `task.failed` — so this is the claim that the
  // fold, and not something process 1 remembered, is where it comes from.
  const ws = workspace();
  const dir = mkdtempSync(join(tmpdir(), "loom-errproj-db-"));
  const path = join(dir, "journal.db");
  try {
    const nodes = [
      READ,
      OK,
      { id: "hold", type: "human_gate", reads: [], writes: [], humanGate: { ref: "oversight/hold@stable" } },
      ARM(),
    ];
    const edges = [
      { id: "then", from: "r", to: "ok", kind: "seq" },
      { id: "failed", from: "r", to: "hold", kind: "error" },
      { id: "held", from: "hold", to: "arm", kind: "seq" },
    ];

    const storeA = new SqliteStateStore({ path });
    const a = rig(ws.root, storeA, nodes, edges);
    const runId = await a.engine.submit({ graph: a.graph, inputs: { path: "out/missing.json" } });
    const parked = await drive(a, runId);
    assert.equal(parked.status, "awaiting_gate", JSON.stringify(parked.error ?? {}));
    const failed = Object.values(parked.tasks).find((t) => t.nodeId === "r");
    assert.equal(failed?.state, "failed");
    const recordedMessage = failed?.error?.message;
    storeA.close();

    // ── process 2: a new engine and a new store handle; only the file is shared ──
    const storeB = new SqliteStateStore({ path });
    try {
      const b = rig(ws.root, storeB, nodes, edges);
      // The file now EXISTS. Anything that re-read the disk instead of the journal would say ok.
      writeFileSync(join(ws.root, "out", "missing.json"), "{}");
      b.engine.attach(runId, b.graph);
      const recovered = await b.engine.projection(runId);
      const gate = Object.values(recovered!.gates).find((g) => g.state === "open");
      assert.ok(gate);
      let done = await b.engine.resolveGate(runId, {
        gateId: gate.gateId,
        decision: { kind: "approve" },
        actor: { kind: "human", subject: "u:bob", via: "console" },
        idempotencyKey: "k1",
      });
      for (let i = 0; i < 8 && done.status === "running"; i++) done = await b.engine.advance(runId);
      assert.equal(done.status, "succeeded", JSON.stringify(done.error ?? {}));
      assert.deepEqual(done.channels["out"], {
        arm: { ok: false, code: CODES.E_FS_NOT_FOUND, message: recordedMessage },
      });

      // AND A REPLAY — every tool result served from the journal, into a throwaway store.
      const report = await replayRun({
        store: storeB,
        runId,
        graph: b.graph,
        engine: { tools: b.tools, functions: b.functions, models: new ModelRegistry() },
      });
      assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
      assert.deepEqual(report.replayed.channels["out"], done.channels["out"], "the replayed arm read the identical projection");
    } finally {
      storeB.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    ws.dispose();
  }
});

test("a tool's typed failure is JOURNALED with its message and retryAfterMs, and replay rebuilds it", async () => {
  // `canonicalize` keeps a class instance's ENUMERABLE fields, and a LoomError's `message` is not
  // one — so a typed failure used to reach the journal message-less, and a replay rebuilt a
  // different fact than the live run acted on.
  const tools = new ToolRegistry();
  tools.register({
    name: "flaky",
    version: "1.0",
    description: "fails with a typed, delayed error",
    capabilities: [],
    irreversibility: "read_only",
    idempotent: true,
    parameters: { type: "object" },
    execute: () => ({ content: "busy", isError: true, error: err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, "busy, come back", { retryAfterMs: 4321 }) }),
  } as ToolDefinition);
  const functions = new FunctionRegistry();
  functions.register("function/arm@stable", ((view: { get: (c: string) => unknown }) => ({ writes: { out: { arm: view.get("f:error") ?? "ABSENT" } } })) as never);
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 1 } },
  });
  const s = spec(
    [
      { id: "f", type: "tool", reads: [], writes: ["doc"], tool: { name: "flaky", version: "1.0" }, retry: { maxAttempts: 1 } },
      { id: "arm", type: "function", reads: ["f:error"], writes: ["out"], function: { ref: "function/arm@stable" } },
    ],
    [{ id: "failed", from: "f", to: "arm", kind: "error" }],
  );
  const graph = compileOrThrow({
    spec: s,
    resolver: resolver(),
    tools: { flaky: { name: "flaky", version: "1.0", capabilities: [], irreversibility: "read_only", idempotent: true } },
    tenantCapabilities: ["fs:read"],
  });
  const runId = await engine.submit({ graph, inputs: { path: "x" } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 8 && p.status === "running"; i++) p = await engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));

  const events = [];
  for await (const e of store.read(runId, 1)) events.push(e);
  const completed = events.find((e) => e.type === "effect.completed");
  const recorded = (completed?.payload as { result: { error: Record<string, unknown> } }).result.error;
  assert.equal(recorded["message"], "busy, come back");
  assert.equal(recorded["retryAfterMs"], 4321);
  assert.equal(recorded["code"], CODES.E_TOOL_SOURCE_UNAVAILABLE);

  const report = await replayRun({ store, runId, graph, engine: { tools, functions, models: new ModelRegistry() } });
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.deepEqual(report.replayed.channels["out"], p.channels["out"]);
  assert.deepEqual(p.channels["out"], { arm: { ok: false, code: CODES.E_TOOL_SOURCE_UNAVAILABLE, message: "busy, come back" } });
});

test("reading a projection TAINTS what the reader writes, even from a body declared `effects: []`", async () => {
  // Unlabelled means untrusted (D4), and the projection carries no label: its `message` is
  // whatever the failing node's tool said. `effects: []` is the declassification a pure body may
  // claim for its OWN output — it cannot launder an input it did not produce. Observed where it
  // matters: an irreversible tool reading what the arm wrote is decided with E8's reason. The
  // CONTROL is the same graph with the arm reading nothing, which must NOT carry that reason.
  const reasonsFor = async (armReads: readonly string[]): Promise<string[]> => {
    const ws = workspace();
    try {
      const tools = new ToolRegistry();
      for (const t of builtinTools({ root: ws.root, deny: [] })) if (t.name === "fs.read") tools.register(t);
      tools.register({
        name: "pay.charge",
        version: "1.0",
        description: "irreversible",
        capabilities: [],
        irreversibility: "irreversible",
        idempotent: false,
        parameters: { type: "object" },
        execute: () => ({ content: "charged" }),
      } as ToolDefinition);
      const functions = new FunctionRegistry();
      functions.register("function/arm@stable", (() => ({ writes: { note: "memo" } })) as never);
      const store = new MemoryStateStore({ now: () => NOW });
      const engine = new Engine({
        store,
        bus: new InProcessEventBus({ store }),
        tools,
        functions,
        models: new ModelRegistry(),
        now: () => NOW,
        sleep: async () => {},
        policy: { granted: ["fs:read"], systemFloor: "out", budget: { runUsd: 1 } },
      });
      const s = spec(
        [
          READ,
          { id: "arm", type: "function", reads: armReads, writes: ["note"], function: { ref: "function/arm@stable", effects: [] } },
          { id: "sink", type: "tool", reads: ["note"], writes: ["out"], tool: { name: "pay.charge", version: "1.0", args: { memo: "${note}" } } },
        ],
        [
          { id: "failed", from: "r", to: "arm", kind: "error" },
          { id: "pay", from: "arm", to: "sink", kind: "seq" },
        ],
        { note: { type: "string", reduce: "replace" } },
      );
      const graph = compileOrThrow({
        spec: s,
        resolver: resolver(),
        tools: { ...FS_TOOLS, "pay.charge": { name: "pay.charge", version: "1.0", capabilities: [], irreversibility: "irreversible", idempotent: false } },
        tenantCapabilities: ["fs:read"],
      });
      const runId = await engine.submit({ graph, inputs: { path: "out/missing.json" } });
      let p = await engine.advance(runId);
      for (let i = 0; i < 8 && p.status === "running"; i++) p = await engine.advance(runId);
      const events = [];
      for await (const e of store.read(runId, 1)) events.push(e);
      const decided = events.filter((e) => e.type === "policy.decided" && String(e.taskId).startsWith("sink@"));
      assert.equal(decided.length, 1, `the sink was decided once: ${JSON.stringify(p.error ?? p.status)}`);
      return (decided[0]!.payload as unknown as { reasons: string[] }).reasons;
    } finally {
      ws.dispose();
    }
  };
  const E8 = /tainted input feeding an irreversible action \(E8\)/;
  assert.ok((await reasonsFor(["r:error"])).some((r) => E8.test(r)), "reading the projection taints the arm's write");
  assert.ok(!(await reasonsFor([])).some((r) => E8.test(r)), "the control: the same arm reading nothing does not");
});
