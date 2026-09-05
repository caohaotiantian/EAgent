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
 * `examples/candidates/` IS A THIRD DIRECTORY AND IS NOT `graphs/`. `loom score` derives the set
 * of promoted graphs from `<workspace>/graphs/`, so a candidate published there would be marked
 * promoted before it was ever gated — its location IS its unpromoted status. The reachability
 * scan therefore reads candidate specs too, or a body named only by a candidate would have to be
 * published as a graph to keep this file green, which is the one place it must not be.
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
  // `candidates/` is copied but is NOT `graphs/`, and the difference is load-bearing rather
  // than tidy: `loom score` reads `<workspace>/graphs/` as the set of graphs a human approved,
  // so a candidate parked there would be marked promoted before it was ever gated. It is
  // published, named by no example graph, and reachable only through `loom promote`.
  for (const sub of ["graphs", "resources", "candidates"]) {
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
    // `loom run` announces the run id on stderr as soon as `submit` returns — the one durable
    // coordinate an interrupt would otherwise take with it. What this line is about is that
    // NOTHING ELSE is there: these graphs have no agent node, so nothing warns about the mock.
    assert.deepEqual(
      r.err.split("\n").filter((l) => l !== "" && !/^run \S+ — inspect it with: loom trace \S+$/.test(l)),
      [],
      "these graphs have no agent node, so nothing warns about the mock",
    );

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

test("`module.exports` in a FUNCTION file is refused at compile too, not left to the run", async () => {
  // THE ASYMMETRY THIS TEST EXISTS FOR. The identical mistake, one directory over, used to
  // print `! skipping …` and then `ok` with exit 0 — measured — and only failed later, inside
  // a run, as `E_RESOURCE_NOT_FOUND: no function registered as "function/count@stable"`. A
  // deleted body was already a compile error on BOTH paths; only a malformed one differed.
  const ws = workspace();
  try {
    writeFileSync(
      join(ws.dir, "resources", "function", "count.js"),
      "module.exports = function (view, ctx) { return {}; };\n",
    );
    const r = await loom(ws.dir, ["compile", graphFile(ws.dir, "fan-out-join.json")]);
    assert.notEqual(r.code, 0, `compile must refuse, got code ${r.code}:\n${r.out}${r.err}`);
    const said = `${r.out}${r.err}`;
    assert.match(said, /BARE FUNCTION EXPRESSION/, "the loader's warning names the rule that was broken");
    assert.match(said, /this graph declares 1 function body\(s\) this workspace does not publish/);
    assert.match(said, /function\/count@stable/);
    assert.doesNotMatch(r.out, /^ok/m, "a graph that cannot run must not print ok");
  } finally {
    ws.dispose();
  }
});

test("an assertion evaluator's ref is a function body, and a malformed one is refused as well", async () => {
  // `#functionBody` has two callers — `#runFunction` and `#runEvaluator`'s assertion arm — and
  // every previous change to this contract landed at one of them a commit before the other.
  // review-bench names `function/bench-check-0@stable` from an `evaluator`, so the second caller
  // has a shipped example to check it against. The ref must be one the GRAPH actually reaches:
  // an unreferenced resource is `! skipping`, exit 0, and this assertion would pass vacuously.
  const ws = workspace();
  try {
    writeFileSync(
      join(ws.dir, "resources", "function", "bench-check-0.js"),
      "module.exports = function (view, ctx) { return {}; };\n",
    );
    const r = await loom(ws.dir, ["compile", graphFile(ws.dir, "review-bench.json")]);
    assert.notEqual(r.code, 0, `compile must refuse, got code ${r.code}:\n${r.out}${r.err}`);
    assert.match(`${r.out}${r.err}`, /function\/bench-check-0@stable/);
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
    // BOTH DIRECTORIES. A resource named only by a candidate is still reachable — that is what
    // a candidate IS — and scanning `graphs/` alone would have forced `bench-collate-v2.js` to
    // be published as a graph to stay green, which is the one place it must not be.
    const specs = [
      ...graphNames(ws.dir).map((g) => readFileSync(graphFile(ws.dir, g), "utf8")),
      ...readdirSync(join(ws.dir, "candidates"))
        .filter((f) => [".json", ".yaml", ".yml"].includes(extname(f)))
        .map((f) => readFileSync(join(ws.dir, "candidates", f), "utf8")),
    ].join("\n");
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

// ── the benchmark example: a GRADED ground-truth signal ──────────────────────

test("review-bench scores k/6, not one bit — a review that got five of six right is not a zero", async () => {
  // MEASURED before the graph was regraded, on the same six shipped cases under the same mock:
  //
  //     signals  [{"id":"S1","value":0,"weight":1,"evidence":"0/1 assertions passed"}]
  //     outcome 0, score 0.2
  //
  // and the single evaluator's own body had already written `score: 0.5` into its verdict —
  // the fold reads `pass` for an assertion evaluator and discards `score` (trajectory.ts's
  // `extractSignals`), so a graded body behind one node collapses to a bit whatever it writes.
  // `readSignals` computes S1 as (assertion NODES that passed) / (assertion nodes), so the
  // granularity is a property of the GRAPH. Six nodes, one per case, is the whole fix.
  //
  // Under the mock the model flags nothing, so the three `defect: true` cases are MISSED and
  // the three `defect: false` cases are correctly clean: 3/6 is the honest offline number, and
  // pinning it is what would catch a regression to the one-bit shape.
  const ws = workspace();
  try {
    const cases = readFileSync(join(EXAMPLES, "bench-cases.json"), "utf8");
    const r = await loom(ws.dir, ["run", graphFile(ws.dir, "review-bench.json"), "--input", cases]);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    const s = summary(r);
    assert.equal(s["status"], "succeeded");

    const outputs = s["outputs"] as Record<string, { pass: boolean; detail: string }>;
    assert.deepEqual(Object.keys(outputs).sort(), ["verdict0", "verdict1", "verdict2", "verdict3", "verdict4", "verdict5"]);
    assert.deepEqual(
      Object.keys(outputs).sort().map((k) => outputs[k]!.detail),
      [
        "fail-open-fold: MISSED",
        "default-stop: MISSED",
        "clear-all-actions: MISSED",
        "rename-local: correctly clean",
        "widen-comment: correctly clean",
        "add-const: correctly clean",
      ],
      "each evaluator answers for ITS OWN case, and says which",
    );

    const scored = await loom(ws.dir, ["score", String(s["runId"])]);
    assert.equal(scored.code, 0, `${scored.out}${scored.err}`);
    const verdict = JSON.parse(scored.out) as { outcome: number; signals: { id: string; value: number; evidence: string }[] };
    const s1 = verdict.signals.find((x) => x.id === "S1");
    assert.equal(s1?.evidence, "3/6 assertions passed", "S1 is k/n over the six evaluator nodes");
    assert.equal(s1?.value, 0.5);
    assert.equal(verdict.outcome, 0.5, "…and the outcome moves with it, instead of sitting at 0");
  } finally {
    ws.dispose();
  }
});

test("the review-bench CANDIDATE compiles, is NOT published as a graph, and really does parse better", async () => {
  // A candidate has to be two things at once: runnable, and not promoted. `loom score` derives
  // the promoted set from `<workspace>/graphs/`, so this file's LOCATION is its unpromoted
  // status — there is no other flag for it, and `candidates/` is where it lives because of that.
  const ws = workspace();
  try {
    const r = await loom(ws.dir, ["compile", join(ws.dir, "candidates", "review-bench-v2.json")]);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.equal(
      graphNames(ws.dir).includes("review-bench-v2.json"),
      false,
      "a candidate published in graphs/ would be marked promoted before it was ever gated",
    );
  } finally {
    ws.dispose();
  }
});

test("…and its improvement is real: three shapes a reasoning model emits that the shipped parser drops", () => {
  // THE CANDIDATE'S WHOLE CLAIM, measured rather than described. `bench-collate.js` matches
  // first-brace-to-last-brace greedily and `JSON.parse`s the span, so ANY brace outside the
  // answer takes the whole thing down and the verdict becomes `unparsed` — which
  // `bench-check-<i>.js` reads as "not flagged", a MISS on every case that carries a defect.
  //
  // The three failing shapes are what a reasoning model actually emits: `examples/README.md`
  // records GLM-5.2 spending roughly 17 reasoning tokens per content token, so a preamble is
  // the ordinary case rather than the odd one.
  //
  // AND IT LIVES IN A DETERMINISTIC BODY, which is why it is a candidate an OFFLINE gate can
  // judge at all: `loom promote` replays recorded runs and serves every model turn from the
  // recording, so the same recorded text parsed correctly is a real delta, while a candidate
  // that changed the PROMPT would be refused for having asked nothing.
  const store = new ResourceStore({ now: () => 1 });
  const actor = { kind: "human", id: "u:test" } as const;
  const publish = (name: string, file: string): string => {
    const ref = store.publish({ kind: "function", name, content: readFileSync(join(EXAMPLES, "resources", "function", file), "utf8"), actor });
    store.promote(ref, "canary", actor);
    store.promote(ref, "stable", actor);
    return `function/${name}@stable`;
  };
  const shipped = publish("collate-shipped", "bench-collate.js");
  const candidate = publish("collate-candidate", "bench-collate-v2.js");

  const answer = '{"verdict":"concerns","findings":["fail-open"]}';
  const shapes: Record<string, string> = {
    clean: answer,
    fenced: `\`\`\`json\n${answer}\n\`\`\``,
    preamble: `Let me think. The guard \`if (x) { … }\` was removed.\nAnswer:\n${answer}`,
    trailing: `${answer}\nNote: the \`{}\` case is unaffected.`,
    scratch: `{"scratch":true}\n${answer}`,
    "no json": "I could not review this diff.",
  };

  const specs: Record<string, ChannelSpec> = {
    reviews: { type: "array", reduce: "replace" },
    verdicts: { type: "array", reduce: "replace" },
  };
  const verdictOf = (ref: string, text: string): string => {
    const body = createFunctionLoader({ store }).load(ref)!;
    const out = body(makeStateView(specs, { reviews: [text] }, ["reviews"]), {
      taskId: "collate@root#0" as never,
      signal: new AbortController().signal,
      now: () => 1,
      seed: 1,
    }) as { writes: { verdicts: { verdict?: string }[] } };
    return String(out.writes.verdicts[0]?.verdict);
  };

  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const [name, text] of Object.entries(shapes)) {
    before[name] = verdictOf(shipped, text);
    after[name] = verdictOf(candidate, text);
  }

  assert.deepEqual(before, {
    clean: "concerns",
    fenced: "concerns",
    preamble: "unparsed",
    trailing: "unparsed",
    scratch: "unparsed",
    "no json": "unparsed",
  });
  assert.deepEqual(after, {
    clean: "concerns",
    fenced: "concerns",
    preamble: "concerns",
    trailing: "concerns",
    scratch: "concerns",
    // THE ROW THAT MUST NOT MOVE. A text with no balanced object at all is still `unparsed`.
    // A candidate that invented a verdict for it would score better and be worse, which is the
    // shape of every optimiser that games its own metric.
    "no json": "unparsed",
  });
});
