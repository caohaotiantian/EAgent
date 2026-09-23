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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { builtinTools, fsRestore } from "../../src/builtin/tools.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import { errorProjectionSource, type ErrorProjection, type GraphSpec, type RunGraph } from "../../src/graph/spec.ts";
import type { NodeId, RunId, Seq, TaskId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { RunFolder, foldRun, viewFor, type RunProjection, type TaskRecord } from "../../src/run/projection.ts";
import { HookRegistry } from "../../src/run/hooks.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

// ── the envelope ─────────────────────────────────────────────────────────────

test("the envelope declares exactly its SIX fields — `classification` still reserved, with no producer yet", () => {
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
      // A FAILURE CARRIES NO COMPLETENESS: `truncated`/`bytes` ride `ok: true` only (§A.83), and
      // `classification` still has no producer — absent rather than defaulted.
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
    // §A.83: a successful read carries its completeness — the file is two bytes, all of them read.
    assert.deepEqual(p.channels["out"], { ok: { ok: true, truncated: false, bytes: 2 } });
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

// ── §A.96: a ROLLED-BACK task is not a success ──────────────────────────────

/**
 * `save` writes a file through the real `fs.write`, `boom` refuses, the run fails, and the
 * run-failed rollback undoes `save` through `fs.restore` — no compensation edge, the path every
 * failed run with a landed `fs.write` takes. The journal is handed back for the fold tests below.
 */
async function rolledBack(root: string): Promise<{ events: JournalEvent[]; p: RunProjection; replayMatch: boolean }> {
  const store = new MemoryStateStore({ now: () => NOW });
  const tools = new ToolRegistry();
  for (const t of builtinTools({ root, deny: [] })) if (t.name === "fs.write") tools.register(t);
  tools.register(fsRestore({ root, deny: [] }));
  const functions = new FunctionRegistry();
  functions.register("function/boom@stable", (() => ({ refuse: { reason: "no" } })) as never);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: ["fs:write"], systemFloor: "out" },
  });
  const base = spec(
    [
      { id: "save", type: "tool", reads: ["path"], writes: ["doc"], tool: { name: "fs.write", version: "1.0", args: { path: "${path}", body: "x" } } },
      { id: "boom", type: "function", reads: ["doc"], writes: ["out"], function: { ref: "function/boom@stable" } },
    ],
    [{ id: "then", from: "save", to: "boom", kind: "seq" }],
  );
  const s = { ...base, policy: { ...base.policy, capabilities: ["fs:write"] } } as GraphSpec;
  const graph = compileOrThrow({
    spec: s,
    resolver: resolver(),
    tools: Object.fromEntries(tools.list().map((t) => [t.name, t])),
    tenantCapabilities: ["fs:write"],
  });
  const runId = await engine.submit({ graph, inputs: { path: "out/saved.txt" } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 8 && p.status === "running"; i++) p = await engine.advance(runId);
  const events: JournalEvent[] = [];
  for await (const e of store.read(runId, 1 as Seq)) events.push(e);
  const report = await replayRun({ store, runId, graph, engine: { tools, functions, models: new ModelRegistry() } });
  return { events, p, replayMatch: report.match };
}

const SAVE = ["save:error"];
const saveAt = (p: RunProjection | undefined): unknown => viewFor(p!, {}, { segments: [] }, SAVE).get("save:error");

/**
 * The full fold, and the incremental one fed ONE EVENT AT A TIME — the way the engine feeds it,
 * restarting on each rewind marker it meets — asserted to agree on the rollback facts (§A.96 (h)).
 */
function folded(events: readonly JournalEvent[]): { full: RunProjection | undefined; incremental: RunProjection | undefined } {
  const f = new RunFolder();
  for (let i = 0; i < events.length; i++) {
    f.push([events[i]!]);
    while (f.stale) {
      f.restart();
      f.push(events.slice(0, i + 1));
    }
  }
  const full = foldRun(events);
  const incremental = f.projection();
  assert.deepEqual(incremental?.undoneCalls ?? {}, full?.undoneCalls ?? {}, "RunFolder one event at a time agrees with foldRun: undone calls");
  assert.deepEqual(incremental?.performedCalls ?? {}, full?.performedCalls ?? {}, "and made calls");
  return { full, incremental };
}

test("§A.96 — a task whose effect the run-failed rollback UNDID projects NO value, not ok:true", async () => {
  const ws = workspace();
  try {
    const { events, p, replayMatch } = await rolledBack(ws.root);
    assert.equal(p.status, "failed", JSON.stringify(p.error ?? {}));
    // The replay of a run whose rollback undid a call re-derives the same projection.
    assert.equal(replayMatch, true);
    const rows = events.filter((e) => e.type === "compensation.recorded");
    assert.deepEqual(rows.map((e) => (e.payload as { outcome: string }).outcome), ["compensated"]);
    assert.equal(p.tasks["save@root#0" as TaskId]?.state, "succeeded", "the STATE still says succeeded — which is why the mark exists");

    // Before the rollback row, the same journal says ok:true: the control.
    const before = events.filter((e) => e.seq < rows[0]!.seq);
    assert.equal((saveAt(foldRun(before)) as ErrorProjection | undefined)?.ok, true);
    // `not_attempted` says the effect STANDS, and `failed` that the undo ran and may have acted:
    // the first keeps ok:true, the second does not.
    const as = (outcome: string): JournalEvent[] =>
      events.map((e) => (e.seq === rows[0]!.seq ? ({ ...e, payload: { ...(e.payload as object), outcome } } as JournalEvent) : e));
    assert.equal((saveAt(foldRun(as("not_attempted"))) as ErrorProjection | undefined)?.ok, true);
    assert.equal(saveAt(foldRun(as("failed"))), undefined);
    // An UNDO's own call is not something the task performed: a `:compensate:` `tool.called` with
    // no row after it yet (a crash between the undo and its record) must not read as a redo.
    const undo = events.find((e) => e.type === "tool.called" && (e.payload as { key: string }).key.startsWith("save@root#0:compensate:"))!;
    const last = events[events.length - 1]!;
    assert.equal(saveAt(foldRun([...events, { ...undo, seq: (last.seq + 1) as Seq } as JournalEvent])), undefined);
    // After it, no projection — in the engine's own projection and in both folds.
    assert.equal(saveAt(p), undefined);
    const { full, incremental } = folded(events);
    assert.equal(saveAt(full), undefined);
    assert.equal(saveAt(incremental), undefined);
  } finally {
    ws.dispose();
  }
});

test("§A.96 — a REWIND that hides the rollback row does not hide the rollback; only a redo that RE-PERFORMS is ok:true again", async () => {
  // A run that failed and rolled `save` back, then rewound to a seq AFTER `save` committed: the
  // marker suppresses the rollback's own row — and `save`'s file is still gone. Folding the row
  // unsuppressed, as `run/compensation.ts` reads it, is what keeps `ok: true` from coming back.
  const ws = workspace();
  try {
    const { events } = await rolledBack(ws.root);
    const committed = events.find((e) => e.type === "task.committed" && e.taskId === ("save@root#0" as TaskId))!;
    const leased = events.find((e) => e.type === "task.leased" && e.taskId === ("save@root#0" as TaskId))!;
    const last = events[events.length - 1]!;
    const marker = {
      ...last,
      seq: (last.seq + 1) as Seq,
      type: "checkpoint.restored",
      payload: { checkpointId: "ck", mode: "rewind", atSeq: committed.seq, reason: "test" },
      taskId: undefined,
    } as unknown as JournalEvent;
    const rewound = [...events, marker];
    const { full, incremental } = folded(rewound);
    assert.equal(full?.tasks["save@root#0" as TaskId]?.state, "succeeded", "the rewind restored save's commit");
    assert.equal(saveAt(full), undefined, "and its rollback still stands");
    assert.equal(saveAt(incremental), undefined, "in the incremental fold too");

    // A REDO THAT IS SERVED: save leased and committed again after the marker, with no new
    // `tool.called` — the recorded call handed back, nothing re-performed. Re-leased is not
    // re-executed, so the rollback still covers it.
    const served = [
      { ...leased, seq: (marker.seq + 1) as Seq },
      { ...committed, seq: (marker.seq + 2) as Seq },
    ] as JournalEvent[];
    const stillUndone = folded([...rewound, ...served]);
    assert.equal(saveAt(stillUndone.full), undefined, "a served redo re-performed nothing");
    assert.equal(saveAt(stillUndone.incremental), undefined);

    // A REDO THAT RE-PERFORMS: the same, with the call really made again after the rollback.
    const call = events.find((e) => e.type === "tool.called" && (e.payload as { key: string }).key === "save@root#0:tool:0")!;
    const redone = [
      { ...leased, seq: (marker.seq + 1) as Seq },
      { ...call, seq: (marker.seq + 2) as Seq },
      { ...committed, seq: (marker.seq + 3) as Seq },
    ] as JournalEvent[];
    const again = folded([...rewound, ...redone]);
    assert.equal((saveAt(again.full) as ErrorProjection | undefined)?.ok, true);
    assert.equal((saveAt(again.incremental) as ErrorProjection | undefined)?.ok, true);
  } finally {
    ws.dispose();
  }
});

test("§A.96 — the rule is PER CALL — position + tool + argsDigest: undone iff some undone call of the task's was not MADE again after its undo", () => {
  const task = { taskId: "src@root#0" as TaskId, nodeId: "src" as NodeId };
  const K0 = "src@root#0:tool:0";
  const K1 = "src@root#0:tool:1";
  type Mark = { seq: number; name?: string; argsDigest?: string };
  const withCalls = (rec: Partial<TaskRecord>, undone: Record<string, Mark>, made: Record<string, Mark>): RunProjection =>
    ({ ...projectionWith([rec]), undoneCalls: undone, performedCalls: made }) as unknown as RunProjection;
  const W = { name: "fs.write", argsDigest: "sha256:w" };
  const R = { name: "fs.read", argsDigest: "sha256:r" };
  const ok = { ...task, state: "succeeded" as const };
  // No undo at all: ok. `not_attempted` adds no entry, so it is this case (g).
  assert.deepEqual(at(withCalls(ok, {}, { [K0]: { seq: 3, ...W } })), { ok: true });
  // K0 undone at 5, made at 3 and never again: undone.
  assert.equal(at(withCalls(ok, { [K0]: { seq: 5, ...W } }, { [K0]: { seq: 3, ...W } })), undefined);
  // K0 undone, and ANOTHER call made later (the two-calls mid shape): still undone.
  assert.equal(at(withCalls(ok, { [K0]: { seq: 5, ...W } }, { [K0]: { seq: 3, ...W }, [K1]: { seq: 9, ...R } })), undefined);
  // K0 undone and the SAME call made again after its undo (f): ok.
  assert.deepEqual(at(withCalls(ok, { [K0]: { seq: 5, ...W } }, { [K0]: { seq: 9, ...W }, [K1]: { seq: 2, ...R } })), { ok: true });
  // A DIFFERENT tool at the same position after the undo (shift): undone.
  assert.equal(at(withCalls(ok, { [K0]: { seq: 5, ...W } }, { [K0]: { seq: 9, ...R } })), undefined);
  // The same tool with DIFFERENT arguments at the same position: undone.
  assert.equal(at(withCalls(ok, { [K0]: { seq: 5, ...W } }, { [K0]: { seq: 9, name: "fs.write", argsDigest: "sha256:other" } })), undefined);
  // An undone call the fold could not identify: nothing clears it.
  assert.equal(at(withCalls(ok, { [K0]: { seq: 5 } }, { [K0]: { seq: 9, ...W } })), undefined);
  // No call made at all after an undo (e): undone — the effect is gone and nothing put it back.
  assert.equal(at(withCalls(ok, { [K0]: { seq: 5, ...W } }, {})), undefined);
  // Another task's undone call is not this task's.
  assert.deepEqual(at(withCalls(ok, { "other@root#0:tool:0": { seq: 5, ...W }, "src@root#01:tool:0": { seq: 5, ...W } }, {})), { ok: true });
  // A FAILED task keeps its ok:false.
  assert.deepEqual(
    at(withCalls({ ...task, state: "failed", error: { class: "unavailable", code: "E_X", message: "m", retryable: true } }, { [K0]: { seq: 5, ...W } }, {})),
    { ok: false, code: "E_X", message: "m" },
  );
});

test("§A.96 — a rollback row the fold cannot place FAILS CLOSED: a `compensates` that is not a string, or not the row's own task's call", async () => {
  const ws = workspace();
  try {
    const { events } = await rolledBack(ws.root);
    const row = events.find((e) => e.type === "compensation.recorded")!;
    const call = events.find((e) => e.type === "tool.called" && (e.payload as { key: string }).key === "save@root#0:tool:0")!;
    const last = events[events.length - 1]!;
    // The run re-makes the SAME call after the row — so the only thing left to refuse is the row itself.
    const remade = { ...call, seq: (last.seq + 1) as Seq } as JournalEvent;
    const forge = (compensates: unknown): JournalEvent[] => [
      ...events.map((e) => (e.seq === row.seq ? ({ ...e, payload: { ...(e.payload as object), compensates } } as JournalEvent) : e)),
      remade,
    ];
    // The control: the genuine row, then the same call made again — ok:true.
    assert.equal((saveAt(foldRun(forge("save@root#0:tool:0"))) as ErrorProjection | undefined)?.ok, true);
    for (const compensates of [7, null, "garbage", "other@root#0:tool:0", "save@root#01:tool:0"]) {
      const { full, incremental } = folded(forge(compensates));
      assert.equal(saveAt(full), undefined, `compensates=${JSON.stringify(compensates)}`);
      assert.equal(saveAt(incremental), undefined, `compensates=${JSON.stringify(compensates)}`);
    }
    // A row whose `compensatesSeq` names a call at ANOTHER key: its identity is not the undone
    // call's, so a later call carrying that identity at the undone key must not clear the mark.
    const undo = events.find((e) => e.type === "tool.called" && (e.payload as { key: string }).key.startsWith("save@root#0:compensate:"))!;
    const misplaced = [
      ...events.map((e) => (e.seq === row.seq ? ({ ...e, payload: { ...(e.payload as object), compensatesSeq: undo.seq } } as JournalEvent) : e)),
      { ...undo, seq: (last.seq + 1) as Seq, payload: { ...(undo.payload as object), key: "save@root#0:tool:0" } } as JournalEvent,
    ];
    assert.equal(saveAt(folded(misplaced).full), undefined, "compensatesSeq naming another key's call");
  } finally {
    ws.dispose();
  }
});

// ── §A.83: the truncation producer — `truncated`/`bytes` on `ok: true` ────────

test("§A.83 — a CAPPED read reaches the reader as {ok: true, truncated: true, bytes}, the channel holds a bare prefix, and a restart and a replay agree", async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, "out", "big.json"), `{}${" ".repeat(10)}`);
    const capped = { ...READ, tool: { name: "fs.read", version: "1.0", args: { path: "${path}", maxBytes: 4 } } };
    const r = rig(ws.root, undefined, [capped, OK, ARM()], EDGES);
    const runId = await r.engine.submit({ graph: r.graph, inputs: { path: "out/big.json" } });
    const p = await drive(r, runId);
    assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
    // The reader was handed the FACT, and the channel the content — with no marker in it.
    assert.deepEqual(p.channels["out"], { ok: { ok: true, truncated: true, bytes: 12 } });
    assert.equal(p.channels["doc"], "{}  ");

    // A RESTART: a fold of the journal alone serves the same projection.
    const events: JournalEvent[] = [];
    for await (const e of r.store.read(runId, 1 as Seq)) events.push(e);
    assert.deepEqual(viewFor(foldRun(events)!, {}, { segments: [] }, ["r:error"]).get("r:error"), { ok: true, truncated: true, bytes: 12 });
    // The fact came out of `effect.completed.result.details`, which is journaled INLINE.
    const done = events.find((e) => e.type === "effect.completed" && (e.payload as { key: string }).key === "r@root#0:tool:0");
    assert.deepEqual((done?.payload as { result: { details: unknown } }).result.details, { path: "out/big.json", bytes: 12, truncated: true });

    // A REPLAY serves the recorded tool result, so the reader is handed the identical fact.
    const report = await replayRun({ store: r.store, runId, graph: r.graph, engine: { tools: r.tools, functions: r.functions, models: new ModelRegistry() } });
    assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
    assert.deepEqual(report.replayed.channels["out"], p.channels["out"]);
  } finally {
    ws.dispose();
  }
});

test("§A.83 — completeness is folded from TOOL calls only, well-formed values only, and `bytes` only when one call gave it", async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, "out", "big.json"), `{}${" ".repeat(10)}`);
    const r = rig(ws.root);
    const runId = await r.engine.submit({ graph: r.graph, inputs: { path: "out/present.json" } });
    await drive(r, runId);
    const events: JournalEvent[] = [];
    for await (const e of r.store.read(runId, 1 as Seq)) events.push(e);
    const real = events.find((e) => e.type === "effect.completed" && (e.payload as { key: string }).key === "r@root#0:tool:0")!;
    const last = events[events.length - 1]!.seq;
    const extra = (n: number, key: string, details: unknown): JournalEvent =>
      ({ ...real, seq: (last + n) as Seq, payload: { key, result: { content: "", details }, resultDigest: "x" } }) as unknown as JournalEvent;
    const serve = (...more: JournalEvent[]): unknown => viewFor(foldRun([...events, ...more])!, {}, { segments: [] }, ["r:error"]).get("r:error");

    assert.deepEqual(serve(), { ok: true, truncated: false, bytes: 2 }, "the control: one complete read");
    // A second TOOL call that was cut: truncated, and no single size to report.
    assert.deepEqual(serve(extra(1, "r@root#0:tool:1", { truncated: true, bytes: 900 })), { ok: true, truncated: true });
    // An undo, a model turn, or ANOTHER task's call says nothing about this node's read.
    assert.deepEqual(serve(extra(1, "r@root#0:compensate:3", { truncated: true, bytes: 9 })), { ok: true, truncated: false, bytes: 2 });
    assert.deepEqual(serve(extra(1, "r@root#0:model:0", { truncated: true })), { ok: true, truncated: false, bytes: 2 });
    assert.deepEqual(serve({ ...extra(1, "ok@root#0:tool:0", { truncated: true }), taskId: "ok@root#0" } as JournalEvent), { ok: true, truncated: false, bytes: 2 });
    // Values a journal can hold but a fact cannot be: dropped, not coerced.
    assert.deepEqual(serve(extra(1, "r@root#0:tool:1", { truncated: "yes", bytes: -1 })), { ok: true, truncated: false, bytes: 2 });
    assert.deepEqual(serve(extra(1, "r@root#0:tool:1", { bytes: Number.NaN })), { ok: true, truncated: false, bytes: 2 });
    // A REDO of the same call REPLACES its fact rather than adding a second one.
    assert.deepEqual(serve(extra(1, "r@root#0:tool:0", { truncated: true, bytes: 40 })), { ok: true, truncated: true, bytes: 40 });
  } finally {
    ws.dispose();
  }
});

test("§A.96 — a RETRIED task whose served call is rolled back projects NO value: the mark is the row's seq, not the call's", async () => {
  // Attempt 1 of an agent calls fs.write, then its next turn is rate-limited; attempt 2 is SERVED
  // attempt 1's recorded call rather than writing again, and succeeds. So the call's seq is BEFORE
  // attempt 2's lease. The run then fails and the rollback undoes that call. Keyed on the undone
  // call's seq, the mark read as an older execution's and the projection said `ok: true` over a
  // file that was gone (review probe `zz-review-a96-retry`).
  const ws = workspace();
  try {
    let clock = NOW;
    const store = new MemoryStateStore({ now: () => clock });
    const tools = new ToolRegistry();
    for (const t of builtinTools({ root: ws.root, deny: [] })) if (t.name === "fs.write") tools.register(t);
    tools.register(fsRestore({ root: ws.root, deny: [] }));
    const functions = new FunctionRegistry();
    functions.register("function/boom@stable", (() => ({ refuse: { reason: "no" } })) as never);
    let limited = false;
    const models = new ModelRegistry();
    models.register(
      new MockModelAdapter({
        pricePerMTok: 1,
        script: (_req, turn) => {
          if (turn === 0) return { toolCalls: [{ id: "w", name: "fs.write", arguments: { path: "out/w.txt", body: "hello" } }], finishReason: "tool_use" };
          if (!limited) {
            limited = true;
            throw err.exhausted(CODES.E_PROVIDER_RATE_LIMIT, "429", { retryAfterMs: 10 });
          }
          return { text: "done", finishReason: "stop" };
        },
      }),
      true,
    );
    const engine = new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools,
      functions,
      models,
      now: () => clock,
      sleep: async () => {},
      resolver: resolver(),
      policy: { granted: ["fs:write"], systemFloor: "out", budget: { runUsd: 5 } },
    });
    const base = spec(
      [
        {
          id: "pay",
          type: "agent",
          writes: ["doc"],
          unhandled: true,
          retry: { maxAttempts: 3, backoff: "fixed", initialMs: 10 },
          agent: { profile: "agent_profile/a@stable", prompt: "prompt/p@v1", maxTurns: 4, tools: ["fs.write"] },
        },
        { id: "boom", type: "function", reads: ["doc"], writes: ["out"], function: { ref: "function/boom@stable" } },
      ],
      [{ id: "then", from: "pay", to: "boom", kind: "seq" }],
    );
    const s = { ...base, policy: { ...base.policy, capabilities: ["fs:write"], budget: { costUsd: 5 } } } as GraphSpec;
    const graph = compileOrThrow({ spec: s, resolver: resolver(), tools: Object.fromEntries(tools.list().map((t) => [t.name, t])), tenantCapabilities: ["fs:write"] });
    const runId = await engine.submit({ graph, inputs: { path: "unused" } });
    let p = await engine.advance(runId);
    for (let i = 0; i < 10 && p.status === "running"; i++) {
      clock += 60_000;
      p = await engine.advance(runId);
    }
    const events: JournalEvent[] = [];
    for await (const e of store.read(runId, 1 as Seq)) events.push(e);
    // The shape this test exists for, asserted rather than assumed.
    assert.equal(p.status, "failed", JSON.stringify(p.error ?? {}));
    assert.ok(events.some((e) => e.type === "task.retry_scheduled" && e.taskId === ("pay@root#0" as TaskId)), "pay was retried");
    const leases = events.filter((e) => e.type === "task.leased" && e.taskId === ("pay@root#0" as TaskId)).map((e) => e.seq);
    const calls = events
      .filter((e) => e.type === "tool.called" && (e.payload as { key: string }).key.startsWith("pay@root#0:tool:"))
      .map((e) => e.seq);
    assert.equal(calls.length, 1, "attempt 2 was SERVED the call, not handed a second one");
    assert.ok(calls[0]! < leases[leases.length - 1]!, `the served call ${String(calls)} predates the last lease ${String(leases)}`);
    const rows = events.filter((e) => e.type === "compensation.recorded");
    assert.deepEqual(rows.map((e) => (e.payload as { outcome: string }).outcome), ["compensated"]);
    assert.equal(existsSync(join(ws.root, "out", "w.txt")), false, "the write was rolled back");

    const at = (q: RunProjection | undefined): unknown => viewFor(q!, {}, { segments: [] }, ["pay:error"]).get("pay:error");
    assert.equal(at(p), undefined);
    const { full, incremental } = folded(events);
    assert.equal(at(full), undefined);
    assert.equal(at(incremental), undefined);
    // A REPLAY re-makes the served call (no serving under replay) and still folds the same answer:
    // the rollback row follows every call either way.
    const report = await replayRun({ store, runId, graph, engine: { tools, functions, models } });
    assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)).slice(0, 800));
  } finally {
    ws.dispose();
  }
});

test("§A.96 — a REWIND whose redo is SERVED the rolled-back call: the reader is told nothing, in the engine and both folds", async () => {
  // Review probe `rewind-served`: save -> check (reads save:error) -> boom (refuses once). The run
  // fails and its rollback removes save's file; the operator rewinds to save's `effect.completed`;
  // the redo re-leases save and is SERVED its recorded call, so nothing is written again. Keyed on
  // the lease, check was handed `{ok: true, bytes: 1}` about a file that is not there. The engine
  // serving a compensated call on redo is its own residue; the projection must not vouch for it.
  const ws = workspace();
  try {
    const store = new MemoryStateStore({ now: () => NOW });
    const tools = new ToolRegistry();
    for (const t of builtinTools({ root: ws.root, deny: [] })) if (t.name === "fs.write") tools.register(t);
    tools.register(fsRestore({ root: ws.root, deny: [] }));
    const functions = new FunctionRegistry();
    let booms = 0;
    functions.register("function/boom@stable", (() => (booms++ === 0 ? { refuse: { reason: "no" } } : { writes: { out: { done: true } } })) as never);
    functions.register("function/check@stable", ((v: { get: (c: string) => unknown }) => ({ writes: { chk: { saw: v.get("save:error") ?? null } } })) as never);
    const engine = new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools,
      functions,
      models: new ModelRegistry(),
      now: () => NOW,
      sleep: async () => {},
      policy: { granted: ["fs:write"], systemFloor: "out" },
    });
    const base = spec(
      [
        { id: "save", type: "tool", reads: ["path"], writes: ["doc"], tool: { name: "fs.write", version: "1.0", args: { path: "${path}", body: "x" } } },
        { id: "check", type: "function", reads: ["doc", "save:error"], writes: ["chk"], function: { ref: "function/check@stable" } },
        { id: "boom", type: "function", reads: ["chk"], writes: ["out"], function: { ref: "function/boom@stable" } },
      ],
      [
        { id: "e1", from: "save", to: "check", kind: "seq" },
        { id: "e2", from: "check", to: "boom", kind: "seq" },
      ],
      { chk: { type: "object", reduce: "replace" } },
    );
    const s = { ...base, policy: { ...base.policy, capabilities: ["fs:write"] } } as GraphSpec;
    const graph = compileOrThrow({ spec: s, resolver: resolver(), tools: Object.fromEntries(tools.list().map((t) => [t.name, t])), tenantCapabilities: ["fs:write"] });
    const runId = await engine.submit({ graph, inputs: { path: "out/saved.txt" } });
    let p = await engine.advance(runId);
    for (let i = 0; i < 8 && p.status === "running"; i++) p = await engine.advance(runId);
    assert.equal(p.status, "failed");
    assert.equal(existsSync(join(ws.root, "out", "saved.txt")), false, "the rollback removed save's file");
    const read = async (): Promise<JournalEvent[]> => {
      const out: JournalEvent[] = [];
      for await (const e of store.read(runId, 1 as Seq)) out.push(e);
      return out;
    };
    const first = await read();
    const completed = first.find((e) => e.type === "effect.completed" && (e.payload as { key: string }).key === "save@root#0:tool:0")!;
    const op = { kind: "human", subject: "u:op", via: "api" } as const;
    const plan = await engine.planRewind(runId, completed.seq, op);
    p = await engine.rewind(runId, completed.seq, "test", op, { planHash: plan.planHash });
    for (let i = 0; i < 8 && p.status !== "succeeded" && p.status !== "failed"; i++) p = await engine.advance(runId);
    const events = await read();
    const performed = events.filter((e) => e.type === "tool.called" && (e.payload as { key: string }).key.startsWith("save@root#0:tool:"));
    assert.equal(performed.length, 1, "the redo was SERVED — save's call was performed once, in the first pass");
    assert.ok(events.filter((e) => e.type === "task.leased" && e.taskId === ("save@root#0" as TaskId)).length >= 2, "and save WAS re-leased");
    assert.equal(existsSync(join(ws.root, "out", "saved.txt")), false, "so the file is still absent");
    assert.deepEqual(p.channels["chk"], { saw: null }, "check was handed no projection, not ok:true");
    assert.equal(saveAt(p), undefined);
    const { full, incremental } = folded(events);
    assert.equal(saveAt(full), undefined);
    assert.equal(saveAt(incremental), undefined);

    // THE GENUINE REDO: rewind to BEFORE save's call, so its recorded completion is hidden and the
    // redo must perform the write again. That is an effect after the undo: ok:true, file present.
    const lease = first.find((e) => e.type === "task.leased" && e.taskId === ("save@root#0" as TaskId))!;
    const plan2 = await engine.planRewind(runId, lease.seq, op);
    p = await engine.rewind(runId, lease.seq, "test", op, { planHash: plan2.planHash });
    for (let i = 0; i < 8 && p.status !== "succeeded" && p.status !== "failed"; i++) p = await engine.advance(runId);
    const after = await read();
    assert.equal(
      after.filter((e) => e.type === "tool.called" && (e.payload as { key: string }).key.startsWith("save@root#0:tool:")).length,
      2,
      "the second redo re-performed the write",
    );
    assert.equal(existsSync(join(ws.root, "out", "saved.txt")), true);
    assert.equal((saveAt(p) as ErrorProjection | undefined)?.ok, true);
    const again = folded(after);
    assert.equal((saveAt(again.full) as ErrorProjection | undefined)?.ok, true);
    assert.equal((saveAt(again.incremental) as ErrorProjection | undefined)?.ok, true);
  } finally {
    ws.dispose();
  }
});

/**
 * A FUNCTION task with TWO calls — `fs.write` (compensable) then `fs.read` — whose run fails and is
 * rolled back, then REWOUND. `mid` rewinds to the write's completion, so the redo is SERVED the
 * write and MAKES the read; `before` rewinds to before the task, so the redo makes both again;
 * `nocall` rewinds to before the task and the redo makes no call at all. Review probes
 * `a4p/two-calls.ts` and `a4p/nocall.ts`, rebuilt here.
 */
/** How the redo behaves. `mid*` rewinds to the write's completion; everything else to before the task. */
type Redo = "mid" | "before" | "nocall" | "read-only-before" | "read-only-mid" | "read-then-write-before";

async function twoCalls(mode: Redo): Promise<{
  p: RunProjection;
  events: JournalEvent[];
  fileExists: boolean;
  made: string[];
  replayMatch: boolean;
}> {
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, "other.txt"), "o");
    const store = new MemoryStateStore({ now: () => NOW });
    const tools = new ToolRegistry();
    for (const t of builtinTools({ root: ws.root, deny: [] })) if (t.name === "fs.write" || t.name === "fs.read") tools.register(t);
    tools.register(fsRestore({ root: ws.root, deny: [] }));
    const functions = new FunctionRegistry();
    let saves = 0;
    let booms = 0;
    type Effects = Record<string, (a: Record<string, unknown>) => Promise<{ content: string }>>;
    functions.register("function/save@stable", (async (_v: unknown, ctx: { effects: Effects }) => {
      saves += 1;
      if (saves > 1 && mode === "nocall") return { writes: { doc: "redo, nothing written" } };
      if (saves > 1 && mode.startsWith("read-")) {
        // The redo puts a READ at ordinal 0, where the undone write was — and, in
        // `read-then-write-before`, writes the same path again at ordinal 1.
        const r = await ctx.effects["fs.read"]!({ path: "other.txt" });
        if (mode === "read-then-write-before") await ctx.effects["fs.write"]!({ path: "out/saved.txt", body: "x" });
        return { writes: { doc: `r=${r.content}` } };
      }
      const w = await ctx.effects["fs.write"]!({ path: "out/saved.txt", body: "x" });
      const r = await ctx.effects["fs.read"]!({ path: "other.txt" });
      return { writes: { doc: `w=${w.content} r=${r.content}` } };
    }) as never);
    functions.register("function/boom@stable", (() => (booms++ === 0 ? { refuse: { reason: "no" } } : { writes: { out: { done: true } } })) as never);
    functions.register("function/check@stable", ((v: { get: (c: string) => unknown }) => ({ writes: { chk: { saw: v.get("save:error") ?? null } } })) as never);
    const engine = new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools,
      functions,
      models: new ModelRegistry(),
      now: () => NOW,
      sleep: async () => {},
      policy: { granted: ["fs:write", "fs:read"], systemFloor: "out" },
    });
    const base = spec(
      [
        { id: "save", type: "function", writes: ["doc"], function: { ref: "function/save@stable", effects: ["fs.write", "fs.read"] } },
        { id: "check", type: "function", reads: ["doc", "save:error"], writes: ["chk"], function: { ref: "function/check@stable" } },
        { id: "boom", type: "function", reads: ["chk"], writes: ["out"], function: { ref: "function/boom@stable" } },
      ],
      [
        { id: "e1", from: "save", to: "check", kind: "seq" },
        { id: "e2", from: "check", to: "boom", kind: "seq" },
      ],
      { chk: { type: "object", reduce: "replace" } },
    );
    const s = { ...base, inputs: [], policy: { ...base.policy, capabilities: ["fs:write", "fs:read"] } } as GraphSpec;
    const graph = compileOrThrow({ spec: s, resolver: resolver(), tools: Object.fromEntries(tools.list().map((t) => [t.name, t])), tenantCapabilities: ["fs:write", "fs:read"] });
    const runId = await engine.submit({ graph, inputs: {} });
    let p = await engine.advance(runId);
    for (let i = 0; i < 8 && p.status === "running"; i++) p = await engine.advance(runId);
    assert.equal(p.status, "failed");
    const read = async (): Promise<JournalEvent[]> => {
      const out: JournalEvent[] = [];
      for await (const e of store.read(runId, 1 as Seq)) out.push(e);
      return out;
    };
    const first = await read();
    const write = first.find((e) => e.type === "effect.completed" && (e.payload as { key: string }).key === "save@root#0:tool:0")!;
    const lease = first.find((e) => e.type === "task.leased" && e.taskId === ("save@root#0" as TaskId))!;
    const atSeq = mode.endsWith("mid") ? write.seq : ((lease.seq - 1) as Seq);
    const op = { kind: "human", subject: "u:op", via: "api" } as const;
    const plan = await engine.planRewind(runId, atSeq, op);
    p = await engine.rewind(runId, atSeq, "test", op, { planHash: plan.planHash });
    for (let i = 0; i < 8 && p.status !== "succeeded" && p.status !== "failed"; i++) p = await engine.advance(runId);
    const events = await read();
    const made = events
      .filter((e) => e.type === "tool.called" && (e.payload as { key: string }).key.startsWith("save@root#0:tool:"))
      .map((e) => `${String(e.seq)} ${(e.payload as { key: string }).key}`);
    const report = await replayRun({ store, runId, graph, engine: { tools, functions, models: new ModelRegistry() } });
    return { p, events, fileExists: existsSync(join(ws.root, "out", "saved.txt")), made, replayMatch: report.match };
  } finally {
    ws.dispose();
  }
}

test("§A.96 (c) — two calls, the redo SERVED the undone write and MAKES the read: still undone, everywhere", async () => {
  const r = await twoCalls("mid");
  assert.equal(r.fileExists, false, "the rolled-back file is still gone");
  assert.equal(r.made.length, 3, `pass 1 made the write and the read; the redo made only the read: ${r.made.join(", ")}`);
  assert.ok(r.made[2]!.endsWith(":tool:1"), r.made.join(", "));
  assert.deepEqual(r.p.channels["chk"], { saw: null });
  assert.equal(saveAt(r.p), undefined);
  const { full, incremental } = folded(r.events);
  assert.equal(saveAt(full), undefined);
  assert.equal(saveAt(incremental), undefined);
});

test("§A.96 (d)/(f) — two calls, BOTH made again after the rewind (only one was compensated): ok:true, file back", async () => {
  const r = await twoCalls("before");
  assert.equal(r.fileExists, true);
  assert.equal(r.made.length, 4, r.made.join(", "));
  assert.equal((saveAt(r.p) as ErrorProjection | undefined)?.ok, true);
  const { full, incremental } = folded(r.events);
  assert.equal((saveAt(full) as ErrorProjection | undefined)?.ok, true);
  assert.equal((saveAt(incremental) as ErrorProjection | undefined)?.ok, true);
});

test("§A.96 (e) — a redo that makes NO call: no value — its effect is gone and nothing put it back", async () => {
  const r = await twoCalls("nocall");
  assert.equal(r.fileExists, false);
  assert.equal(r.made.length, 2, "only pass 1's calls");
  assert.equal(saveAt(r.p), undefined);
  const { full, incremental } = folded(r.events);
  assert.equal(saveAt(full), undefined);
  assert.equal(saveAt(incremental), undefined);
});

test("§A.96 — the replay of a REWOUND run is match:false, and was before §A.96: a rewind's rollback is not re-driven", async () => {
  // Measured on this lane's base (2af9716a) with this same scenario: `effect.unserved
  // save@root#0:compensate:<n> (never requested)` and a `state.hash` frame — `replayRun` re-drives
  // the recorded run without its run-failed rollback or the rewind after it. §A.96 adds one frame
  // on top (`check`'s channel: the live run folded the undo, the replay has none to fold). Pinned
  // so that a replay that DOES learn rewinds turns this red and the claim gets re-read.
  const r = await twoCalls("mid");
  assert.equal(r.replayMatch, false);
});

test("§A.96 — a redo that puts a DIFFERENT call at the undone write's position does not clear the mark (position + tool + argsDigest)", async () => {
  // Review round 4, probe `shapes`: the effect key is POSITIONAL, and a redo whose ordinal 0 is an
  // `fs.read` where the undone `fs.write` had been cleared a position-only mark — `{ok: true,
  // bytes: 1}` with the file gone. `read-only-mid` is not served the write because the call at
  // that position changed (fs.write is idempotent, so `#servedToolEffect` declines, not throws).
  for (const mode of ["read-only-before", "read-only-mid"] as const) {
    const r = await twoCalls(mode);
    assert.equal(r.fileExists, false, mode);
    assert.ok(r.made.some((m) => m.endsWith(":tool:0")) && r.made.length >= 2, `${mode}: ${r.made.join(", ")}`);
    assert.equal(saveAt(r.p), undefined, mode);
    const { full, incremental } = folded(r.events);
    assert.equal(saveAt(full), undefined, mode);
    assert.equal(saveAt(incremental), undefined, mode);
  }
});

test("§A.96 — the write re-made at ANOTHER position stays undone while the file stands: fail closed (residue N1)", async () => {
  const r = await twoCalls("read-then-write-before");
  assert.equal(r.fileExists, true, "the redo wrote the file again, at ordinal 1");
  assert.equal(saveAt(r.p), undefined, "and the mark on ordinal 0 is not cleared by a call at ordinal 1");
});

test("§A.96 — an AGENT whose redo makes only a READ at the undone write's position: undone, like making no call", async () => {
  // Review probe `shapes` agent-read-before vs agent-nocall-before: same file state, and they used
  // to answer opposite ways.
  for (const readOnRedo of [true, false]) {
    const ws = workspace();
    try {
      writeFileSync(join(ws.root, "other.txt"), "o");
      const store = new MemoryStateStore({ now: () => NOW });
      const tools = new ToolRegistry();
      for (const t of builtinTools({ root: ws.root, deny: [] })) if (t.name === "fs.write" || t.name === "fs.read") tools.register(t);
      tools.register(fsRestore({ root: ws.root, deny: [] }));
      const functions = new FunctionRegistry();
      let booms = 0;
      functions.register("function/boom@stable", (() => (booms++ === 0 ? { refuse: { reason: "no" } } : { writes: { out: { done: true } } })) as never);
      let calls = 0;
      const models = new ModelRegistry();
      models.register(
        new MockModelAdapter({
          pricePerMTok: 1,
          script: (_req, turn) => {
            calls += 1;
            if (calls > 2) {
              if (readOnRedo && turn === 0) return { toolCalls: [{ id: "r", name: "fs.read", arguments: { path: "other.txt" } }], finishReason: "tool_use" };
              return { text: "nothing to write", finishReason: "stop" };
            }
            return turn === 0
              ? { toolCalls: [{ id: "w", name: "fs.write", arguments: { path: "out/saved.txt", body: "x" } }], finishReason: "tool_use" }
              : { text: "done", finishReason: "stop" };
          },
        }),
        true,
      );
      const engine = new Engine({
        store,
        bus: new InProcessEventBus({ store }),
        tools,
        functions,
        models,
        now: () => NOW,
        sleep: async () => {},
        resolver: resolver(),
        policy: { granted: ["fs:write", "fs:read"], systemFloor: "out", budget: { runUsd: 5 } },
      });
      const base = spec(
        [
          { id: "a", type: "agent", writes: ["doc"], agent: { profile: "agent_profile/a@stable", prompt: "prompt/p@v1", maxTurns: 4, tools: ["fs.write", "fs.read"] } },
          { id: "boom", type: "function", reads: ["doc"], writes: ["out"], function: { ref: "function/boom@stable" } },
        ],
        [{ id: "e1", from: "a", to: "boom", kind: "seq" }],
      );
      const s2 = { ...base, inputs: [], policy: { ...base.policy, capabilities: ["fs:write", "fs:read"], budget: { costUsd: 5 } } } as GraphSpec;
      const graph = compileOrThrow({ spec: s2, resolver: resolver(), tools: Object.fromEntries(tools.list().map((t) => [t.name, t])), tenantCapabilities: ["fs:write", "fs:read"] });
      const runId = await engine.submit({ graph, inputs: {} });
      let p = await engine.advance(runId);
      for (let i = 0; i < 8 && p.status === "running"; i++) p = await engine.advance(runId);
      assert.equal(p.status, "failed");
      const read = async (): Promise<JournalEvent[]> => {
        const out: JournalEvent[] = [];
        for await (const e of store.read(runId, 1 as Seq)) out.push(e);
        return out;
      };
      const lease = (await read()).find((e) => e.type === "task.leased" && e.taskId === ("a@root#0" as TaskId))!;
      const op = { kind: "human", subject: "u:op", via: "api" } as const;
      const plan = await engine.planRewind(runId, (lease.seq - 1) as Seq, op);
      p = await engine.rewind(runId, (lease.seq - 1) as Seq, "test", op, { planHash: plan.planHash });
      for (let i = 0; i < 8 && p.status !== "succeeded" && p.status !== "failed"; i++) p = await engine.advance(runId);
      const events = await read();
      const aAt = (q: RunProjection | undefined): unknown => viewFor(q!, {}, { segments: [] }, ["a:error"]).get("a:error");
      const what = readOnRedo ? "read on redo" : "no call on redo";
      assert.equal(existsSync(join(ws.root, "out", "saved.txt")), false, what);
      assert.equal(
        events.filter((e) => e.type === "tool.called" && (e.payload as { key: string }).key === "a@root#0:tool:0").length,
        readOnRedo ? 2 : 1,
        what,
      );
      assert.equal(aAt(p), undefined, what);
      const { full, incremental } = folded(events);
      assert.equal(aAt(full), undefined, what);
      assert.equal(aAt(incremental), undefined, what);
    } finally {
      ws.dispose();
    }
  }
});
