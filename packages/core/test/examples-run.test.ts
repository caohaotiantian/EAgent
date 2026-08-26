/**
 * The examples RUN, or they are not examples.
 *
 * `examples/` is the only door a non-committer has: three file shapes — a graph, a `function`
 * body, a `hook` body — that somebody copies and edits. Before it existed, `git ls-files` held
 * zero of each, and the one requirement that fails a first attempt outright (a resource file is
 * a BARE FUNCTION EXPRESSION; `module.exports = …` is a syntax error) appeared exactly once, in
 * a source comment.
 *
 * So this suite drives every file in that directory through the REAL CLI — `main()` from
 * `src/cli.ts`, the same entry `bin/loom` calls — against a temp copy of the workspace, offline,
 * with no model adapter registered and no key. What it asserts is what `examples/README.md`
 * prints, so a change that breaks an example turns this red instead of leaving a reader to find
 * it.
 *
 * THE SET IS THE DIRECTORY, not a list written here: `every example graph compiles` reads
 * `examples/graphs/`, and `every published resource is reachable` reads `examples/resources/`.
 * A fourth example added later is covered without touching this file, and one that no graph
 * names is caught rather than quietly rotting.
 *
 * Three of the tests break an example ON PURPOSE — the `module.exports` mistake, the `seq`-for-
 * `join` edge, a `replace` reducer under a fan-out — because those are the sentences the README
 * spends the most words on, and a documented refusal that stopped refusing would otherwise be
 * invisible.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.ts";
import { isLoomError, toLoomError } from "../src/errors.ts";
import { createFunctionLoader } from "../src/resources/functions.ts";
import { ResourceStore } from "../src/resources/store.ts";
import { makeStateView, type ChannelSpec } from "../src/state/channels.ts";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));

/**
 * A throwaway copy of the example SOURCES, because running an example writes a journal and
 * (example 3) a file.
 *
 * COPIES ONLY `graphs/` AND `resources/`, deliberately — not the whole tree. `examples/README.md`
 * offers "copy it somewhere, or run in place", and running in place leaves `.loom/journal.db` and
 * `notes/note.txt` behind. A recursive copy of the whole directory carried that residue into the
 * fixture, and test 6 — which asserts the guarded write never reached the disk — then failed for a
 * file the PREVIOUS run had written. Following the documented happy path turned the gate red,
 * which is a gate testing the developer's shell history rather than the code.
 *
 * `.gitignore` is not the answer here: this reads the filesystem via `cpSync`, not git.
 */
function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-examples-"));
  for (const sub of ["graphs", "resources"]) {
    cpSync(join(EXAMPLES, sub), join(dir, sub), { recursive: true });
  }
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/**
 * `bin/loom <argv> --workspace <dir>`, in-process, with the streams captured.
 *
 * THE CATCH IS PART OF THE CLI, not a convenience. `main` REJECTS on a refusal — a graph that
 * does not compile, a hook the workspace does not publish — and the entry point at the bottom
 * of `cli.ts` is what turns that into `E_CODE: message` on stderr and exit 1. A harness that
 * only read the resolved code would be testing half the command, and every refusal below is a
 * rejection rather than a return.
 */
async function loom(dir: string, argv: readonly string[]): Promise<Result> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main([...argv, "--workspace", dir]);
    return { code, out: out.join(""), err: errOut.join("") };
  } catch (e) {
    const le = isLoomError(e) ? e : toLoomError(e);
    return { code: 1, out: out.join(""), err: `${errOut.join("")}${le.code}: ${le.message}\n` };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

const graphFile = (dir: string, name: string): string => join(dir, "graphs", name);

function graphNames(dir: string): readonly string[] {
  return readdirSync(join(dir, "graphs")).filter((f) => [".json", ".yaml", ".yml"].includes(extname(f)));
}

/** `loom run` prints one JSON object and nothing else. */
function summary(r: Result): Record<string, unknown> {
  return JSON.parse(r.out) as Record<string, unknown>;
}

// ── the graph example ────────────────────────────────────────────────────────

test("every example graph compiles", async () => {
  const ws = workspace();
  try {
    const graphs = graphNames(ws.dir);
    assert.ok(graphs.length >= 2, `expected the examples to hold graphs, found ${JSON.stringify(graphs)}`);
    for (const g of graphs) {
      const r = await loom(ws.dir, ["compile", graphFile(ws.dir, g)]);
      assert.equal(r.code, 0, `${g} did not compile:\n${r.out}${r.err}`);
      assert.match(r.out, /^ok/, `${g}: ${r.out}`);
    }
  } finally {
    ws.dispose();
  }
});

test("`loom compile` SAYS what retry policy each provider-calling node will run under", async () => {
  // The default a graph never declared is the one an operator most needs to see, and this is the
  // only place the product shows it. `self-review.json` declares no `retry` anywhere — `grep -a`
  // over every example returns nothing — so every line below is the compiler's own answer.
  const ws = workspace();
  try {
    const r = await loom(ws.dir, ["compile", graphFile(ws.dir, "self-review.json")]);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /^ok\n/, "the verdict stays on the first line");
    assert.match(r.out, /retry review \(default\): maxAttempts=3 backoff=exponential initialMs=1000 maxMs=30000 onlyIf=any-retryable/);
    // A node that cannot reach a provider is silent — this is a list of what WILL happen, not a
    // census. `write` is a tool node and `plan` a function node.
    assert.doesNotMatch(r.out, /retry write/);
    assert.doesNotMatch(r.out, /retry plan/);
  } finally {
    ws.dispose();
  }
});

test("fan-out → join produces the report examples/README.md prints", async () => {
  const ws = workspace();
  try {
    const r = await loom(ws.dir, [
      "run",
      graphFile(ws.dir, "fan-out-join.json"),
      "--input",
      JSON.stringify({ document: "alpha beta\ngamma\n\ndelta epsilon zeta" }),
    ]);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.equal(r.err, "", "these graphs have no agent node, so nothing warns about the mock");

    const s = summary(r);
    assert.equal(s["status"], "succeeded");
    const report = (s["outputs"] as Record<string, Record<string, unknown>>)["report"]!;
    assert.equal(report["lines"], 3, "one branch per non-blank line");
    assert.equal(report["words"], 6);
    // BRANCH ORDER, not arrival order. This is the property the fan-out → join shape exists
    // for, and the only assertion here that would survive `counts` being folded by whoever
    // finished first is this one.
    assert.deepEqual(report["order"], ["alpha beta", "gamma", "delta epsilon zeta"]);
    assert.equal(typeof report["at"], "number", "ctx.now() is the task's journaled lease timestamp");

    // …and the run replays with zero effects re-executed, which is what makes `at` safe to
    // put in an output at all.
    const replay = await loom(ws.dir, ["replay", String(s["runId"]), "--graph", graphFile(ws.dir, "fan-out-join.json")]);
    assert.equal(replay.code, 0, `${replay.out}${replay.err}`);
    assert.deepEqual(JSON.parse(replay.out), { match: true, hermetic: true });
  } finally {
    ws.dispose();
  }
});

test("the join edge kind is load-bearing — `seq` in its place is REFUSED", async () => {
  const ws = workspace();
  try {
    const file = graphFile(ws.dir, "fan-out-join.json");
    const spec = JSON.parse(readFileSync(file, "utf8")) as { edges: { id: string; kind: string }[] };
    const collect = spec.edges.find((e) => e.id === "collect")!;
    collect.kind = "seq";
    writeFileSync(file, JSON.stringify(spec));

    const r = await loom(ws.dir, ["compile", file]);
    assert.notEqual(r.code, 0, "a join arm reaching its join over a `seq` edge must not compile");
    assert.match(`${r.out}${r.err}`, /GRAPH008/);
  } finally {
    ws.dispose();
  }
});

test("a fan-out writing a `replace` channel is REFUSED", async () => {
  const ws = workspace();
  try {
    const file = graphFile(ws.dir, "fan-out-join.json");
    const spec = JSON.parse(readFileSync(file, "utf8")) as { channels: Record<string, { reduce: string }> };
    spec.channels["counts"]!.reduce = "replace";
    writeFileSync(file, JSON.stringify(spec));

    const r = await loom(ws.dir, ["compile", file]);
    assert.notEqual(r.code, 0);
    assert.match(`${r.out}${r.err}`, /GRAPH010_CONCURRENT_WRITE/);
  } finally {
    ws.dispose();
  }
});

// ── the hook example ─────────────────────────────────────────────────────────

test("the preTool hook lets an ordinary note through, and the file lands", async () => {
  const ws = workspace();
  try {
    const r = await loom(ws.dir, [
      "run",
      graphFile(ws.dir, "guarded-write.json"),
      "--input",
      JSON.stringify({ note: "remember to water the plants" }),
    ]);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    const s = summary(r);
    assert.equal(s["status"], "succeeded");
    assert.deepEqual((s["outputs"] as Record<string, unknown>)["written"], {
      bytes: 28,
      path: "notes/note.txt",
    });
    assert.equal(readFileSync(join(ws.dir, "notes", "note.txt"), "utf8"), "remember to water the plants");
  } finally {
    ws.dispose();
  }
});

test("the preTool hook BLOCKS a credential, and nothing reaches the disk", async () => {
  const ws = workspace();
  try {
    const r = await loom(ws.dir, [
      "run",
      graphFile(ws.dir, "guarded-write.json"),
      "--input",
      JSON.stringify({ note: "token sk-live-42" }),
    ]);
    assert.notEqual(r.code, 0);
    const s = summary(r);
    assert.equal(s["status"], "failed");
    const error = s["error"] as Record<string, unknown>;
    assert.match(String(error["message"]), /was blocked before dispatch: the body looks like it carries a credential/);
    assert.equal(existsSync(join(ws.dir, "notes", "note.txt")), false, "the block is before dispatch, so the tool never ran");
  } finally {
    ws.dispose();
  }
});

test("`module.exports` in a hook file is a SYNTAX ERROR, and the graph is refused", async () => {
  const ws = workspace();
  try {
    // The single most likely first attempt, and the reason this directory exists.
    writeFileSync(
      join(ws.dir, "resources", "hook", "no-secrets.js"),
      "module.exports = function (input, ctx) { return {}; };\n",
    );
    const r = await loom(ws.dir, ["compile", graphFile(ws.dir, "guarded-write.json")]);
    assert.notEqual(r.code, 0);
    const said = `${r.out}${r.err}`;
    assert.match(said, /did not evaluate: Unexpected token/, "the file is a bare function EXPRESSION");
    assert.match(said, /this graph declares 1 hook\(s\) this workspace does not publish/);
  } finally {
    ws.dispose();
  }
});

// ── the claims the example files make in their own comments ──────────────────

test("ctx.effects in a SANDBOXED body refuses, exactly as summarise.js says it does", () => {
  // `summarise.js` tells its reader that a declared effect is reachable as a stub that throws
  // `E_EFFECT_UNAVAILABLE`. That sentence is only worth having if it is the message.
  const store = new ResourceStore({ now: () => 1 });
  const actor = { kind: "human", id: "u:test" } as const;
  const ref = store.publish({
    kind: "function",
    name: "settle",
    content: `function (view, ctx) { return { writes: { out: ctx.effects.charge({}) } }; }`,
    actor,
  });
  store.promote(ref, "canary", actor);
  store.promote(ref, "stable", actor);

  const specs: Record<string, ChannelSpec> = { out: { type: "object", reduce: "replace" } };
  const body = createFunctionLoader({ store }).load("function/settle@stable")!;
  assert.throws(
    () =>
      body(makeStateView(specs, {}, ["out"]), {
        taskId: "settle@root#0" as never,
        signal: new AbortController().signal,
        now: () => 1,
        seed: 1,
        effects: { charge: () => Promise.reject(new Error("unreachable")) },
      }),
    /E_EFFECT_UNAVAILABLE/,
  );
});

test("every published resource is reachable from an example graph", () => {
  const ws = workspace();
  try {
    const specs = graphNames(ws.dir)
      .map((g) => readFileSync(graphFile(ws.dir, g), "utf8"))
      .join("\n");
    const kinds = readdirSync(join(ws.dir, "resources"), { withFileTypes: true }).filter((d) => d.isDirectory());
    let seen = 0;
    for (const kind of kinds) {
      for (const file of readdirSync(join(ws.dir, "resources", kind.name))) {
        const ref = `${kind.name}/${basename(file, extname(file))}@`;
        assert.ok(specs.includes(ref), `${kind.name}/${file} is published but no example graph names ${ref}`);
        seen += 1;
      }
    }
    assert.ok(seen >= 4, `expected the function and hook bodies to be published, counted ${String(seen)}`);
  } finally {
    ws.dispose();
  }
});
