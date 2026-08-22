/**
 * THE EXTENSION SURFACE WAS UNREACHABLE THROUGH THE PRODUCT, and every single-file reading of
 * it looked correct.
 *
 * `run/hooks.ts` builds a bus over eight points, narrows every decision, and opens by promising
 * a hook "is loaded by the same digest-pinned, vm-sandboxed loader that `function` nodes use."
 * `graph/validate.ts` refuses an unknown point name. `graph/compile.ts` pins every hook ref into
 * the resolution manifest. `journal/events.ts` carries `hook.applied`. `resources/store.ts` has
 * `"hook"` in `ResourceKind`. Twelve months of scaffolding, and:
 *
 *     grep -an 'HookRegistry' packages/core/src/ | grep -av run/hooks.ts
 *     → engine.ts: one import, one option field, one assignment. No constructor anywhere.
 *
 * So `Engine.#hooks` was `undefined` in every path the CLI builds, `#hooksFor` answered `[]` at
 * all eight points, and a graph declaring `hooks: {preNode: ["hook/memo@stable"]}` compiled,
 * validated, pinned its ref, ran, and did nothing. Measured before the fix, through the CLI, on
 * the fixture below: `n: 1` — the node's own answer — where the hook says 41.
 *
 * The tests here cover the three pieces that were missing: workspaces publish `hook/*.js`,
 * bodies compile in the same hardened realm `function` bodies use, and a declared hook the
 * workspace does NOT publish is refused rather than skipped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { createHookLoader } from "../../src/resources/hook-loader.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import type { HookContext } from "../../src/run/hooks.ts";

const ACTOR = { kind: "human", id: "u:test" } as const;

function storeWith(source: unknown, name = "memo", kind: "hook" | "function" = "hook") {
  const store = new ResourceStore({ now: () => 1 });
  const ref = store.publish({ kind, name, content: source, actor: ACTOR });
  store.promote(ref, "canary", ACTOR);
  store.promote(ref, "stable", ACTOR);
  return store;
}

const CTX: HookContext = {
  point: "preNode",
  runId: "run_1",
  signal: new AbortController().signal,
};

// ── the loader ──────────────────────────────────────────────────────────────

test("a published hook body compiles and is invoked with (input, ctx)", () => {
  const store = storeWith(`(input, ctx) => ({ seen: input.tool, at: ctx.point, run: ctx.runId })`);
  const body = createHookLoader({ store }).load("hook/memo@stable");
  assert.ok(body !== undefined, "a published hook must load");
  assert.deepEqual(body({ tool: "fs.read" }, CTX), { seen: "fs.read", at: "preNode", run: "run_1" });
});

test("A HOOK BODY CANNOT WALK BACK OUT TO THE HOST — through its arguments or its globals", () => {
  // The escape this repo already found once, in the function loader, one resource kind over:
  // `view.constructor.constructor("return globalThis")().process` reached the real `process`
  // because the globals had been rebuilt from the context's intrinsics and the ARGUMENTS had
  // not. `HOOK_BRIDGE` exists so that no version of that is reachable from a hook, and this
  // asserts every door the function loader had to close.
  const store = storeWith(`(input, ctx) => {
    var reached = [];
    var probe = function (label, get) { try { if (get()) reached.push(label); } catch (e) {} };
    probe("input", function () { return input.constructor.constructor("return globalThis")().process; });
    probe("ctx", function () { return ctx.constructor.constructor("return globalThis")().process; });
    probe("signal", function () { return ctx.signal.constructor.constructor("return globalThis")().process; });
    probe("literal", function () { return ({}).constructor.constructor("return globalThis")().process; });
    probe("global", function () { return globalThis.process; });
    probe("require", function () { return globalThis.require; });
    return { reached: reached };
  }`);
  const body = createHookLoader({ store }).load("hook/memo@stable");
  assert.deepEqual(body!({ any: "thing" }, CTX), { reached: [] });
});

test("only JSON crosses — a hook cannot hold, or mutate, the caller's object", () => {
  const store = storeWith(`(input) => { input.mutated = true; return { echoed: input.n }; }`);
  const body = createHookLoader({ store }).load("hook/memo@stable");
  const input: Record<string, unknown> = { n: 7 };
  assert.deepEqual(body!(input, CTX), { echoed: 7 });
  assert.deepEqual(input, { n: 7 }, "the host's object must be untouched: the body saw a copy");
});

test("the answer comes back in the HOST realm, so it compares equal to ordinary data", () => {
  const store = storeWith(`() => ({ writes: { n: 41 }, list: [1, 2] })`);
  const out = createHookLoader({ store }).load("hook/memo@stable")!({}, CTX);
  // `deepStrictEqual` compares prototypes: a cross-realm object literal fails this even
  // though every key and value matches.
  assert.deepStrictEqual(out, { writes: { n: 41 }, list: [1, 2] });
});

test("a body that is not a function refuses AT LOAD, where an operator is watching", () => {
  const store = storeWith(`({ notAFunction: true })`);
  assert.throws(() => createHookLoader({ store }).load("hook/memo@stable"), /evaluated to object, not a function/);
});

test("a body that does not parse refuses at load, and says it is a hook", () => {
  const store = storeWith(`(input => {`);
  assert.throws(() => createHookLoader({ store }).load("hook/memo@stable"), /hook resource "hook\/memo@stable" did not evaluate/);
});

test("a ref naming a resource that is not a hook loads NOTHING rather than the wrong thing", () => {
  const store = storeWith(`() => ({})`, "memo", "function");
  assert.equal(createHookLoader({ store }).load("function/memo@stable"), undefined);
  assert.equal(createHookLoader({ store }).load("hook/absent@stable"), undefined);
});

test("A SYNCHRONOUS BODY THAT NEVER RETURNS IS TERMINATED, not left to hang", () => {
  const store = storeWith(`() => { while (true) {} }`);
  const body = createHookLoader({ store, callTimeoutMs: 50 }).load("hook/memo@stable");
  assert.throws(() => body!({}, CTX), /timed out|Script execution/);
});

test("bodies are cached per DIGEST — two SELECTORS on one version compile once", () => {
  // Not "two refs with the same bytes": `resourceDigest` hashes {kind, name, content}, so two
  // NAMES holding identical source are two digests and two compiled bodies. `functions.ts`
  // claimed the wider version for a year and this test found it — the guarantee is per version,
  // which is what a selector moving (@stable → @v3, same version) actually needs.
  const store = new ResourceStore({ now: () => 1 });
  const ref = store.publish({ kind: "hook", name: "memo", content: `() => ({ ok: true })`, actor: ACTOR });
  store.promote(ref, "canary", ACTOR);
  store.promote(ref, "stable", ACTOR);
  const loader = createHookLoader({ store });
  loader.load("hook/memo@stable");
  loader.load("hook/memo@canary");
  loader.load("hook/memo@stable");
  assert.equal(loader.compiled, 1);
});

// ── the workspace, and the wiring that was missing ──────────────────────────
//
// Through `main()`, not through an internal helper: the defect was that the PRODUCT never
// built a registry, and a test that constructs one itself cannot see that.

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-hooks-"));
  mkdirSync(join(dir, "resources", "hook"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    return { code: await main(argv), out: out.join(""), err: errOut.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

const MEMO = `function (input, ctx) { return { skip: true, reason: "memoised", overrideWrites: { n: 41 } }; }`;
const BUMP = `function (view) { return { writes: { n: (view.get("n") ?? 0) + 1 } }; }`;

const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "g", project: "p", version: 1 },
  channels: { n: { reduce: "replace" } },
  inputs: [],
  outputs: ["n"],
  hooks: { preNode: ["hook/memo@stable"] },
  nodes: [{ id: "a", type: "function", function: { ref: "function/bump@stable" }, reads: ["n"], writes: ["n"] }],
  edges: [],
};

function seed(dir: string, spec: unknown = GRAPH): string {
  writeFileSync(join(dir, "resources", "hook", "memo.js"), MEMO);
  writeFileSync(join(dir, "resources", "function", "bump.js"), BUMP);
  const file = join(dir, "g.json");
  writeFileSync(file, JSON.stringify(spec));
  return file;
}

test("A WORKSPACE PUBLISHES resources/hook/*.js, and the SHIPPED ENGINE DISPATCHES it", async () => {
  const w = workspace();
  try {
    const file = seed(w.dir);
    const ws = openWorkspace(parseArgs(["compile", file, "--workspace", w.dir]));
    try {
      assert.ok(ws.hooks.get("hook/memo@stable") !== undefined, "the workspace must publish the hook");
    } finally {
      ws.close();
    }
    const r = await cli(["run", file, "--workspace", w.dir]);
    assert.equal(r.code, 0, r.err);
    // 41 is the HOOK's answer. 1 is the node's — and 1 is what this printed before a
    // `HookRegistry` was constructed anywhere and handed to the Engine.
    assert.equal((JSON.parse(r.out) as { outputs: { n: number } }).outputs.n, 41);
  } finally {
    w.dispose();
  }
});

test("a hook the workspace does NOT publish is REFUSED at compile, not skipped at run", async () => {
  const w = workspace();
  try {
    const file = seed(w.dir);
    rmSync(join(w.dir, "resources", "hook", "memo.js"));
    for (const verb of ["compile", "run"]) {
      await assert.rejects(
        () => cli([verb, file, "--workspace", w.dir]),
        (e: unknown) =>
          isLoomError(e) && e.code === CODES.E_RESOURCE_NOT_FOUND && /preNode: hook\/memo@stable/.test(e.message),
        `\`loom ${verb}\` must refuse a graph whose hook has no body`,
      );
    }
  } finally {
    w.dispose();
  }
});

test("a hook published as PROSE is not published at all — .md is not a filter", async () => {
  const w = workspace();
  try {
    const file = seed(w.dir);
    rmSync(join(w.dir, "resources", "hook", "memo.js"));
    writeFileSync(join(w.dir, "resources", "hook", "memo.md"), MEMO);
    await assert.rejects(
      () => cli(["compile", file, "--workspace", w.dir]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_RESOURCE_NOT_FOUND,
      "a .md under resources/hook/ must not become a hook body",
    );
  } finally {
    w.dispose();
  }
});

test("a graph declaring NO hooks is unaffected by any of this", async () => {
  const w = workspace();
  try {
    const { hooks: _dropped, ...noHooks } = GRAPH;
    const file = seed(w.dir, noHooks);
    const r = await cli(["run", file, "--workspace", w.dir]);
    assert.equal(r.code, 0, r.err);
    assert.equal((JSON.parse(r.out) as { outputs: { n: number } }).outputs.n, 1, "the node's own answer");
  } finally {
    w.dispose();
  }
});

const NOOP = `function () { return {}; }`;

const GATED = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "gated", project: "p", version: 1 },
  policy: { posture: "out" },
  channels: { plan: { type: "string", reduce: "replace" }, n: { reduce: "replace" } },
  inputs: ["plan"],
  outputs: ["n"],
  hooks: { preNode: ["hook/noop@stable"] },
  nodes: [
    { id: "g", type: "human_gate", reads: ["plan"], humanGate: { ref: "oversight/deploy@stable" } },
    { id: "f", type: "function", function: { ref: "function/bump@stable" }, reads: ["n"], writes: ["n"] },
  ],
  edges: [{ id: "e1", from: "g", to: "f", kind: "seq" }],
};

test("DELETING A HOOK BODY UNDER A LIVE GATE SAYS WHAT HAPPENED", async () => {
  // The refusal above is right when a graph is being INTRODUCED and wrong when one is being
  // matched back to a run that already exists — so `graphsByHash` does not run it.
  //
  // What SHOULD stop the approval is the graph-binding rule, and it does: a deleted hook body
  // changes what the ref resolves to, so the resolution manifest no longer matches the one
  // `run.compiled` recorded, and `#assertBound` refuses. That is the designed behaviour — the
  // approver approved those bytes — and restoring the file restores the gate.
  //
  // The difference this test pins is WHICH refusal the operator gets. With the check running in
  // `graphsByHash`, the graph is swallowed out of the index and the message is E_RUN_NOT_FOUND:
  // "no graph in graphs/ has that hash … restore them to answer the gate" — about bytes nobody
  // changed, pointing at the one file that is fine.
  const w = workspace();
  try {
    mkdirSync(join(w.dir, "graphs"), { recursive: true });
    writeFileSync(join(w.dir, "resources", "hook", "noop.js"), NOOP);
    writeFileSync(join(w.dir, "resources", "function", "bump.js"), BUMP);
    const file = join(w.dir, "graphs", "gated.json");
    writeFileSync(file, JSON.stringify(GATED));

    const started = await cli(["run", file, "--workspace", w.dir, "--input", JSON.stringify({ plan: "ship" })]);
    assert.equal(started.code, 0, started.err);
    const summary = JSON.parse(started.out.split("\ngate ")[0]!) as { runId: string; status: string };
    assert.equal(summary.status, "awaiting_gate");

    const listed = await cli(["gates", summary.runId, "--workspace", w.dir]);
    const gateId = (JSON.parse(listed.out) as { gateId: string }[])[0]!.gateId;

    // The gate is answerable while the extension is there.
    rmSync(join(w.dir, "resources", "hook", "noop.js"));

    await assert.rejects(
      () => cli(["approve", summary.runId, gateId, "--workspace", w.dir, "--as", "u:alice"]),
      (e: unknown) => {
        assert.ok(isLoomError(e), String(e));
        assert.equal(e.code, CODES.E_GRAPH_MISMATCH, "not E_RUN_NOT_FOUND: the run and the graph are both there");
        const d = e.details as { differs: string; expected: string; actual: string };
        assert.equal(d.differs, "resources");
        // The pair reported must be the pair that differs. This used to print the two SPEC
        // hashes, which are EQUAL on this branch by construction — the same string twice, under
        // a message saying they had changed.
        assert.notEqual(d.expected, d.actual, "an error about a difference must report values that differ");
        return true;
      },
    );

    // And putting it back makes the gate answerable again — the binding rule, not a dead end.
    writeFileSync(join(w.dir, "resources", "hook", "noop.js"), NOOP);
    const approved = await cli(["approve", summary.runId, gateId, "--workspace", w.dir, "--as", "u:alice"]);
    assert.equal(approved.code, 0, approved.err);
  } finally {
    w.dispose();
  }
});
