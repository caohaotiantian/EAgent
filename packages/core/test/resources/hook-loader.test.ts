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
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { createHookLoader } from "../../src/resources/hook-loader.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { HOOK_POINTS, type HookContext } from "../../src/run/hooks.ts";

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
  // THE COMPILER answers this one: an unpublished ref resolves to nothing, and GRAPH015 has
  // refused that since before the hook bus existed. It could not fire while the workspace
  // resolver fabricated a pin for any syntactically valid ref — which is the whole of D5.
  const w = workspace();
  try {
    const file = seed(w.dir);
    rmSync(join(w.dir, "resources", "hook", "memo.js"));
    for (const verb of ["compile", "run"]) {
      const errs: string[] = [];
      await assert.rejects(
        () => cli([verb, file, "--workspace", w.dir]).catch((e) => { errs.push(String(e)); throw e; }),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_GRAPH_INVALID,
        `\`loom ${verb}\` must refuse a graph whose hook has no body`,
      );
    }
  } finally {
    w.dispose();
  }
});

test("a hook that is PUBLISHED but does not evaluate is refused too — by the registry, not the compiler", async () => {
  // The two guards cover different failures and neither subsumes the other. A body that does
  // not parse IS published, so it resolves and GRAPH015 is satisfied; `registerHooks` then
  // fails to compile it, warns on stderr, and registers nothing — leaving exactly the
  // declared-and-silent hook this whole mechanism exists to prevent. `requireHookBodies`
  // reads the REGISTRY, so it is the one that sees this.
  const w = workspace();
  try {
    const file = seed(w.dir);
    writeFileSync(join(w.dir, "resources", "hook", "memo.js"), "function (input, ctx) { return {");
    await assert.rejects(
      () => cli(["compile", file, "--workspace", w.dir]),
      (e: unknown) =>
        isLoomError(e) && e.code === CODES.E_RESOURCE_NOT_FOUND && /preNode: hook\/memo@stable/.test(e.message),
      "a published hook body that does not evaluate must not compile `ok`",
    );
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
      (e: unknown) => isLoomError(e) && e.code === CODES.E_GRAPH_INVALID,
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

test("DELETING A HOOK BODY UNDER A LIVE GATE NAMES THE FILE, not just the run", async () => {
  // The approver's message is the thing under test, and it has been wrong twice.
  //
  // With the workspace resolver fabricating pins, a deleted hook body changed what the ref
  // resolved to, so `#assertBound` refused with E_GRAPH_MISMATCH{differs:"resources"} — true,
  // but it named no file, and its `details` printed the same spec hash twice.
  //
  // With the fabrication gone the ref resolves to NOTHING, GRAPH015 refuses the graph, and it
  // drops out of `graphsByHash` — which used to swallow every compile failure in silence and
  // tell the approver "no graph in graphs/ has that hash (N searched)". True, useless, and
  // pointing at the one directory that is fine.
  //
  // What must reach them is the ref. Any compile failure had this problem; the hook is how it
  // was found.
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

    // The extension is gone. The run is not.
    rmSync(join(w.dir, "resources", "hook", "noop.js"));

    await assert.rejects(
      () => cli(["approve", summary.runId, gateId, "--workspace", w.dir, "--as", "u:alice"]),
      (e: unknown) => {
        assert.ok(isLoomError(e), String(e));
        assert.match(e.message, /would not compile/, "the index must say what it could not build");
        assert.match(e.message, /gated\.json/, "and name the graph file");
        assert.deepEqual((e.details as { failed?: readonly string[] }).failed?.length, 1);
        return true;
      },
    );

    // And putting it back makes the gate answerable again — a refusal, not a dead end.
    writeFileSync(join(w.dir, "resources", "hook", "noop.js"), NOOP);
    const approved = await cli(["approve", summary.runId, gateId, "--workspace", w.dir, "--as", "u:alice"]);
    assert.equal(approved.code, 0, approved.err);
  } finally {
    w.dispose();
  }
});

// ── randomness: the other half of `HookContext`'s docstring ─────────────────
//
// `run/hooks.ts` says a hook body gets "No clock and no randomness: see invariant 4." The clock
// half was true — `safeGlobals` binds `Date` to `undefined`. The randomness half was not: `Math`
// is in the realm, `functions.ts` replaces its `random` with a seeded PRNG and `HOOK_BRIDGE` did
// not, so a hook reached the platform's. Measured through `main()` on the fixture below, before
// `DENY_RANDOM`: `n = 0.22702972986496206`, then `n = 0.5441905981534036`, same graph, same
// bytes, two runs.

test("A HOOK CANNOT REACH Math.random — INCLUDING ONE THAT CAPTURES IT AT LOAD TIME", () => {
  // The capture is why the stub is spliced ahead of the body instead of installed by
  // `HOOK_BRIDGE`: `compileRealm` evaluates the body FIRST and the bridge SECOND, so a stub
  // written in the bridge can be lifted out from under itself by exactly this resource.
  const store = storeWith(`(function () {
    var captured = Math.random;
    return function () {
      var reached = [];
      var probe = function (label, get) { try { get(); reached.push(label); } catch (e) {} };
      probe("captured", function () { return captured(); });
      probe("Math.random", function () { return Math.random(); });
      probe("globalThis.Math.random", function () { return globalThis.Math.random(); });
      return { reached: reached, floor: Math.floor(2.7) };
    };
  })()`);
  const body = createHookLoader({ store }).load("hook/memo@stable")!;
  // `floor: 2` is the CONTROL for this one: `Math` itself is still there, so a hook that buckets
  // a memo key or clamps a backoff is unaffected. Deleting `Math` outright would pass the first
  // half of this assertion and fail the second.
  assert.deepEqual(body({}, CTX), { reached: [], floor: 2 });
});

test("the refusal NAMES the capability, and points at a route that EXISTS", () => {
  // A THROWING STUB, NOT AN OMISSION — the treatment `functions.ts` settled on for `ctx.effects`.
  // An absent `Math` dies with "Cannot read properties of undefined (reading 'random')", which
  // sends an author hunting for a typo in their own code.
  //
  // AND IT MUST NOT NAME `ctx.seed`. The first version of this message said "Draw it in a
  // function node, where ctx.seed makes it reproducible". A hook body never sees that field —
  // `HOOK_BRIDGE` builds `{point, runId, taskId, signal}` — and neither does a FUNCTION body:
  // `functions.ts` sends `seed` in the payload expressly NOT on the ctx, because the bridge
  // consumes it to reseed `Math.random` and drops it. The advice named a field in neither realm,
  // which is worse than no advice: it reads as "you are one property away".
  const store = storeWith(`() => ({ r: Math.random() })`);
  const body = createHookLoader({ store }).load("hook/memo@stable")!;
  assert.throws(
    () => body({}, CTX),
    (e: unknown) => {
      const m = String(e);
      assert.ok(m.includes("E_EFFECT_UNAVAILABLE"), m);
      assert.ok(!m.includes("ctx.seed"), `the refusal must not send an author after a field that does not exist: ${m}`);
      assert.ok(m.includes("function node"), m);
      assert.ok(m.includes(`effectKey(taskId, "random", 0)`), m);
      assert.ok(m.includes("hook input"), m);
      assert.ok(!m.includes("Cannot read properties of undefined"), m);
      return true;
    },
  );
});

test("EVERY FIELD THE REFUSAL PROMISES IS REALLY THERE — `ctx` is exactly what it says", () => {
  // The control for the assertion above. Saying "ctx is {point, runId, taskId, signal} and
  // nothing more" is the same class of claim as the one it replaced, so it is checked against
  // the realm rather than against `HOOK_BRIDGE`'s source.
  const store = storeWith(`(input, ctx) => ({ keys: Object.keys(ctx).sort(), seed: typeof ctx.seed })`);
  const body = createHookLoader({ store }).load("hook/memo@stable")!;
  assert.deepEqual(body({}, { ...CTX, taskId: "task_1" as never }), {
    keys: ["point", "runId", "signal", "taskId"],
    seed: "undefined",
  });
});

test("THE REFUSAL IS IDENTICAL AT ALL EIGHT POINTS — including the one nobody hears", () => {
  // `onComplete` is the OBSERVER point, and a hook that draws there fails INVISIBLY: measured
  // through `main()` on a graph declaring `hooks: {onComplete: [...]}` whose body calls
  // `Math.random()`, the run exits 0, prints `"status": "succeeded"`, and writes nothing to
  // stderr. That silence is NOT this loader and NOT `runObservers`, which already returns the
  // refs that threw precisely "so the caller can surface them without failing the run". It is
  // `engine.ts`'s `onComplete` dispatch discarding that return value.
  //
  // So this test pins the half that IS the loader's, and it is the half the engine fix depends
  // on: the stub fires at `onComplete` exactly as at the other seven, with the same message. If
  // the guard were ever loosened at observer points — the alternative rejected in `DENY_RANDOM` —
  // this goes red rather than the defect landing under cover of a point nobody watches.
  const store = storeWith(`() => ({ r: Math.random() })`);
  const body = createHookLoader({ store }).load("hook/memo@stable")!;
  const messages = HOOK_POINTS.map((point) => {
    try {
      body({}, { ...CTX, point });
      return `NO REFUSAL AT ${point}`;
    } catch (e) {
      return String((e as Error).message);
    }
  });
  assert.equal(messages.length, 8, "if a ninth point is wired, it needs a decision here too");
  for (const [i, m] of messages.entries()) {
    assert.ok(m.includes("E_EFFECT_UNAVAILABLE"), `${HOOK_POINTS[i]}: ${m}`);
  }
  assert.equal(new Set(messages).size, 1, `all eight refusals must read the same: ${JSON.stringify(messages)}`);
});

test("a body that overwrites Math.random does not change what the NEXT call sees", () => {
  // Bodies are cached per DIGEST, so "the next call" is routinely another Run. `HOOK_BRIDGE`
  // re-installs the stub per call for the same reason `ARGUMENT_BRIDGE` reseeds per call.
  const store = storeWith(`function (input) {
    if (input.first) { Math.random = function () { return 0.5; }; return { r: Math.random() }; }
    try { return { r: Math.random() }; } catch (e) { return { refused: String(e).indexOf("E_EFFECT_UNAVAILABLE") >= 0 }; }
  }`);
  const body = createHookLoader({ store }).load("hook/memo@stable")!;
  assert.deepEqual(body({ first: true }, CTX), { r: 0.5 }, "a body may of course use its own arithmetic");
  assert.deepEqual(body({}, CTX), { refused: true }, "and it does not persist into the next call");
});

const RANDOM_MEMO = `function (input, ctx) { return { skip: true, reason: "memoised", overrideWrites: { n: Math.random() } }; }`;

test("TWO RUNS OF ONE GRAPH: a hook drawing randomness REFUSES BOTH TIMES, identically", async () => {
  const w = workspace();
  try {
    const file = seed(w.dir);
    writeFileSync(join(w.dir, "resources", "hook", "memo.js"), RANDOM_MEMO);
    const first = await cli(["run", file, "--workspace", w.dir]);
    const second = await cli(["run", file, "--workspace", w.dir]);
    const summaries = [first, second].map((r) => {
      assert.equal(r.code, 1, `a hook that cannot decide must fail its Task: ${r.out}${r.err}`);
      return JSON.parse(r.out) as { status: string; outputs: Record<string, unknown>; error: { message: string } };
    });
    for (const s of summaries) {
      assert.equal(s.status, "failed");
      assert.deepEqual(s.outputs, {}, "and it must not have written the draw it was refused");
      assert.ok(s.error.message.includes("E_EFFECT_UNAVAILABLE"), s.error.message);
      assert.ok(s.error.message.includes("hook/memo@stable"), s.error.message);
      assert.ok(s.error.message.includes("preNode"), s.error.message);
    }
    // The point of running it TWICE: before the fix these two differed, and differing is the
    // defect. Identical refusals are what "no randomness" looks like from outside.
    assert.equal(summaries[0]!.error.message, summaries[1]!.error.message);
  } finally {
    w.dispose();
  }
});

test("THE CONTROL: the same wiring, a hook that draws nothing, and it really does fire", async () => {
  // Without this, the test above cannot tell "the hook was refused randomness" from "the hook
  // never ran" — which is the failure this whole file exists to close, and which looks identical
  // from outside. Same graph, same point, same `overrideWrites` channel that carried the draw.
  const w = workspace();
  try {
    const file = seed(w.dir);
    for (const _ of [1, 2]) {
      const r = await cli(["run", file, "--workspace", w.dir]);
      assert.equal(r.code, 0, r.err);
      // 41 is the HOOK's answer; 1 is the node's own. The hook fires, and both runs agree.
      assert.equal((JSON.parse(r.out) as { outputs: { n: number } }).outputs.n, 41);
    }
  } finally {
    w.dispose();
  }
});

// ── the clock: the OTHER other half of `HookContext`'s docstring ────────────
//
// The comment above says "The clock half was true — `safeGlobals` binds `Date` to `undefined`."
// That was wrong, and it was wrong in this file. `Date` is one of two clocks in a `vm` context:
// `Intl.DateTimeFormat.prototype.format` called with NO ARGUMENT reads the wall clock, and `Intl`
// was ambient. Measured through `main()` on the fixture below, before `realm.ts` shadowed it:
// `n = "8/25/2026, 11:16:07 AM"`, then `n = "8/25/2026, 11:16:09 AM"`, same graph, same bytes.
// `test/resources/realm-has-no-clock.test.ts` covers the realm; this covers the product.

const CLOCK_MEMO = `function (input, ctx) {
  return { skip: true, reason: "memoised", overrideWrites: { n: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", timeStyle: "medium" }).format() } };
}`;

test("TWO RUNS OF ONE GRAPH: a hook reading the CLOCK refuses both times, identically", async () => {
  const w = workspace();
  try {
    const file = seed(w.dir);
    writeFileSync(join(w.dir, "resources", "hook", "memo.js"), CLOCK_MEMO);
    const runs = [await cli(["run", file, "--workspace", w.dir]), await cli(["run", file, "--workspace", w.dir])];
    const summaries = runs.map((r) => {
      assert.equal(r.code, 1, `a hook that cannot decide must fail its Task: ${r.out}${r.err}`);
      return JSON.parse(r.out) as { status: string; outputs: Record<string, unknown>; error: { message: string } };
    });
    for (const s of summaries) {
      assert.equal(s.status, "failed");
      assert.deepEqual(s.outputs, {}, "and it must not have written the timestamp it was refused");
      assert.ok(s.error.message.includes("hook/memo@stable"), s.error.message);
      assert.ok(s.error.message.includes("preNode"), s.error.message);
      // The shape of the refusal is `Intl` being `undefined`, the same treatment `Date` has had
      // since the first realm — so the author sees their OWN expression named, not the guard:
      // "Cannot read properties of undefined (reading 'DateTimeFormat')".
      //
      // A throwing stub would read better, and that is the argument `DENY_RANDOM` makes two
      // screens up for `Math.random`. It was REJECTED here for one concrete reason rather than a
      // taste one: `test/resources/functions.test.ts` asserts `typeof Date === "undefined"`
      // inside a body, so `Date`'s treatment is pinned by a test, and stubbing `Intl` alone would
      // leave the realm's two clocks refusing in two different shapes. Both or neither, and
      // "both" is a change to a pinned behaviour — recorded rather than half-done.
      assert.ok(/DateTimeFormat/.test(s.error.message), s.error.message);
      assert.ok(!/Intl is not defined/.test(s.error.message), "the namespace is shadowed, not deleted from scope");
    }
    // Before the fix these two differed. Differing IS the defect: it is a hook putting an
    // unjournaled, unreplayable value into a declared channel through `overrideWrites`.
    assert.equal(summaries[0]!.error.message, summaries[1]!.error.message);
  } finally {
    w.dispose();
  }
});


// ── `console` IS AMBIENT AND INERT, which is not what the rejection said ─────
//
// `DENY_RANDOM`'s docstring records a REJECTED relaxation — letting `Math.random` through at
// observer points — "so nobody re-proposes it", and one of the three counts it rested on was a
// measured claim nobody had measured: that `console` is ambient in the realm, so an `onComplete`
// body doing `console.log(Math.random())` "writes nondeterministic bytes onto the very stream
// `loom run` prints its JSON summary on."
//
// Half of that is true and the load-bearing half is false. `vm.createContext({})` DOES bind a
// `console` whose `log` is a function — but it reaches neither stdout nor stderr nor fd 1. A
// permanently-recorded rejection resting on a false premise is worse than no rejection, because
// the next reader who checks it discards the two counts that are sound along with the one that
// is not. This pins the corrected sentence so it cannot rot back.

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const execFileAsync = promisify(execFile);

test("A HOOK BODY CANNOT WRITE A BYTE — `console` is bound in the realm, and goes nowhere", async () => {
  // A REAL SUBPROCESS, deliberately. The `cli()` helper above replaces `process.stdout.write`,
  // which a raw fd-1 write would walk straight past — so an in-process test could not tell
  // "inert" from "intercepted", and inert is the claim. This is fd 1 and fd 2 as the OS sees them.
  const w = workspace();
  try {
    // `preNode`, not `onComplete`: a filter's answer is READ, so `n === 41` proves the body
    // actually ran. At `onComplete` the engine discards the result and a body that never fired
    // would produce the same empty streams — the test would pass while asserting nothing.
    writeFileSync(
      join(w.dir, "resources", "hook", "memo.js"),
      `function (input, ctx) {
         console.log("HOOK-BYTES-MARKER-STDOUT");
         console.error("HOOK-BYTES-MARKER-STDERR");
         return { skip: true, reason: "tapped", overrideWrites: { n: 41 } };
       }`,
    );
    writeFileSync(join(w.dir, "resources", "function", "bump.js"), BUMP);
    const file = join(w.dir, "g.json");
    writeFileSync(file, JSON.stringify(GRAPH));

    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, "run", file, "--workspace", w.dir]);

    assert.equal(
      (JSON.parse(stdout) as { outputs: { n: number } }).outputs.n,
      41,
      "the hook must have FIRED — 41 is its answer, 1 is the node's",
    );
    assert.equal(stdout.includes("HOOK-BYTES-MARKER"), false, "console.log in a hook must not reach fd 1");
    assert.equal(stderr.includes("HOOK-BYTES-MARKER"), false, "console.error in a hook must not reach fd 2");
    assert.equal(stderr, "", "and nothing else may appear there either");
  } finally {
    w.dispose();
  }
});

test("…and it is BOUND, not missing — the half of the rejection's premise that was true", () => {
  // The distinction the corrected docstring turns on. If `console` were absent, a body doing
  // `console.log(x)` would THROW, and at seven of eight points that fails the Task — which is a
  // different behaviour to document and a different thing for an author to hit.
  const store = storeWith(`(input, ctx) => ({
    typeofConsole: typeof console,
    typeofLog: typeof console.log,
    returned: console.log("nowhere") === undefined
  })`);
  const body = createHookLoader({ store }).load("hook/memo@stable")!;
  assert.deepEqual(body({}, CTX), { typeofConsole: "object", typeofLog: "function", returned: true });
});
