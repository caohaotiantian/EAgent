/**
 * THE GRANT ADVICE MUST KEY ON A STRUCTURED CODE, NOT A SUBSTRING — TODO.md §A.91, the reviewer's
 * fifth fix round.
 *
 * `resolveRecordedGraph`'s `capabilityIssue` used to be `failed.some((f) => f.includes("GRAPH017"))`
 * over `f`, a pre-joined DISPLAY STRING that (since the fourth fix round) also carries a failing
 * candidate's own diagnostic MESSAGE. That produces:
 *
 *   - A FALSE POSITIVE: a `GRAPH015_RESOURCE_NOT_FOUND` whose quoted ref happens to be named
 *     `function/GRAPH017-fix@stable` makes the substring test true for a missing-resource error no
 *     grant could ever fix.
 *   - A FALSE POSITIVE, DIFFERENTLY: `GRAPH017_CAPABILITY_NOT_DECLARED` also contains the substring
 *     "GRAPH017" and needs no grant either — the capability is UNDECLARED in the graph's own
 *     `policy.capabilities`, not denied by the tenant, and no CLI flag writes that field.
 *   - A FALSE NEGATIVE: `compile()`'s thrown message joins only the first THREE error codes
 *     (`errors.slice(0, 3)`) for display, so a `GRAPH017_CAPABILITY_NOT_GRANTED` fourth or later in
 *     one candidate's error list never appears in the display text the old substring test read.
 *
 * The fix carries every failing candidate's FULL, UNSLICED diagnostics array (`FailedCandidate.
 * codes`, from `compile()`'s own `{ details: { diagnostics: errors } }`) and keys the advice on
 * `codes.includes("GRAPH017_CAPABILITY_NOT_GRANTED")` exactly — closing all three at once, because
 * all three are the same mechanism: a code compared as a STRUCTURED VALUE cannot be fooled by text
 * that merely CONTAINS it, in either direction.
 *
 * Each fixture below records a WORKING run first (so the run exists to resolve against), then edits
 * the SAME path into the shape under test — the same "the graph compiled once, to be recorded; it
 * does not compile now" pattern the rest of this row uses — and drives `trace`, which needs nothing
 * beyond a single recorded run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";

interface Cap {
  code: number;
  out: string;
  err: string;
}

/** Folds a throw into the same shape as a returned code. */
async function run(argv: string[]): Promise<Cap> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: errOut.join("") };
  } catch (e) {
    return { code: 1, out: out.join(""), err: `${errOut.join("")}${(e as Error).message}\n` };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-cap-key-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

const GRANT_ADVICE = /--allow-exec|--egress|grants the RUN had/;

// ── false positive: a ref containing the substring "GRAPH017" ────────────────

test("A GRAPH015 WHOSE REF IS NAMED function/GRAPH017-fix@stable DOES NOT OFFER THE GRANT ADVICE", async () => {
  const w = workspace();
  try {
    mkdirSync(join(w.dir, "resources", "function"), { recursive: true });
    writeFileSync(join(w.dir, "resources", "function", "prep.js"), `(view) => ({ writes: { out: String(view.get("seed") ?? "") } })`);
    const graph = (ref: string, version: number): unknown => ({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "g", project: "lane-d", version },
      policy: { posture: "out", capabilities: [] },
      channels: { seed: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [{ id: "f", type: "function", reads: ["seed"], writes: ["out"], function: { ref } }],
      edges: [],
    });
    writeFileSync(join(w.dir, "graphs", "g.json"), JSON.stringify(graph("function/prep@stable", 1)));
    const started = await run(["run", join(w.dir, "graphs", "g.json"), "--workspace", w.dir, "--input", '{"seed":"hi"}']);
    assert.equal(started.code, 0, started.err);
    const { runId } = JSON.parse(started.out) as { runId: string };

    // EDITED: the ref itself contains "GRAPH017" and is missing — a GRAPH015, not a capability.
    writeFileSync(join(w.dir, "graphs", "g.json"), JSON.stringify(graph("function/GRAPH017-fix@stable", 2)));

    const traced = await run(["trace", runId, "--workspace", w.dir]);
    const text = traced.out + traced.err;
    assert.match(text, /GRAPH015_RESOURCE_NOT_FOUND/, `must name the true reason:\n${text}`);
    assert.match(text, /GRAPH017-fix@stable/, `must still quote the ref, substring and all:\n${text}`);
    assert.doesNotMatch(text, GRANT_ADVICE, `must not offer a flag that fixes nothing, despite the substring:\n${text}`);
  } finally {
    w.dispose();
  }
});

// ── false positive: GRAPH017_CAPABILITY_NOT_DECLARED, not _NOT_GRANTED ───────

test("GRAPH017_CAPABILITY_NOT_DECLARED DOES NOT OFFER THE GRANT ADVICE EITHER — no flag writes policy.capabilities", async () => {
  const w = workspace();
  try {
    const graph = (capabilities: readonly string[], version: number): unknown => ({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "sole", project: "lane-d", version },
      policy: { posture: "out", capabilities, expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
      channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [{ id: "x", type: "tool", reads: ["seed"], writes: ["out"], unhandled: true, tool: { name: "proc.exec", version: "1.0", args: { command: "echo", args: ["hi"] } } }],
      edges: [],
    });
    // Recorded with the capability both DECLARED (graph's own ceiling) and GRANTED (tenant), so it
    // runs and gates cleanly — the fixture's baseline is unremarkable.
    writeFileSync(join(w.dir, "graphs", "sole.json"), JSON.stringify(graph(["proc:exec"], 1)));
    const started = await run(["run", join(w.dir, "graphs", "sole.json"), "--workspace", w.dir, "--input", '{"seed":"hi"}', "--allow-exec", "echo"]);
    assert.equal(started.code, 0, started.err);
    const { runId } = JSON.parse(started.out) as { runId: string };

    // EDITED: capabilities now EMPTY — undeclared, not ungranted. Resolved WITH --allow-exec, so
    // GRAPH017_CAPABILITY_NOT_GRANTED cannot fire; only _NOT_DECLARED can.
    writeFileSync(join(w.dir, "graphs", "sole.json"), JSON.stringify(graph([], 2)));

    const traced = await run(["trace", runId, "--workspace", w.dir, "--allow-exec", "echo"]);
    const text = traced.out + traced.err;
    assert.match(text, /GRAPH017_CAPABILITY_NOT_DECLARED/, `must name the true reason:\n${text}`);
    assert.doesNotMatch(text, /GRAPH017_CAPABILITY_NOT_GRANTED/, `must not ALSO be the granted case:\n${text}`);
    assert.doesNotMatch(text, GRANT_ADVICE, `must not offer a flag — nothing on this command line writes policy.capabilities:\n${text}`);
  } finally {
    w.dispose();
  }
});

// ── false negative: GRAPH017 as the candidate's later error, not among the first three ───

test("A GRAPH017_CAPABILITY_NOT_GRANTED LISTED AFTER THREE OTHER ERRORS STILL OFFERS THE GRANT ADVICE", async () => {
  const w = workspace();
  try {
    const good = {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "sole", project: "lane-d", version: 1 },
      policy: { posture: "out", capabilities: ["proc:exec"], expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
      channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [{ id: "x", type: "tool", reads: ["seed"], writes: ["out"], unhandled: true, tool: { name: "proc.exec", version: "1.0", args: { command: "echo", args: ["hi"] } } }],
      edges: [],
    };
    writeFileSync(join(w.dir, "graphs", "sole.json"), JSON.stringify(good));
    const started = await run(["run", join(w.dir, "graphs", "sole.json"), "--workspace", w.dir, "--input", '{"seed":"hi"}', "--allow-exec", "echo"]);
    assert.equal(started.code, 0, started.err);
    const { runId } = JSON.parse(started.out) as { runId: string };

    // EDITED: three self-referencing `compensation` edges naming no `compensates` (GRAPH012_NO_
    // COMPENSATES, error, rule 12) make "x" gain an inbound edge with nothing else in the graph, so
    // GRAPH001_NO_ENTRY (rule 1) fires too — FIVE errors, in rule order, with the capability error
    // (rule 17, still the same denied grant as the baseline) last. `compile()`'s own display message
    // joins only the first three: this candidate's summary names GRAPH001_NO_ENTRY and
    // GRAPH012_NO_COMPENSATES twice, then "…", and never spells "GRAPH017" anywhere in the printed
    // text.
    const broken = {
      ...good,
      metadata: { ...good.metadata, version: 2 },
      edges: [
        { id: "c1", from: "x", to: "x", kind: "compensation" },
        { id: "c2", from: "x", to: "x", kind: "compensation" },
        { id: "c3", from: "x", to: "x", kind: "compensation" },
      ],
    };
    writeFileSync(join(w.dir, "graphs", "sole.json"), JSON.stringify(broken));

    // Resolved WITHOUT --allow-exec, so the capability this candidate's rule-17 error names is
    // truly denied — GRAPH017_CAPABILITY_NOT_GRANTED, a real fourth error, not a fabricated one.
    const traced = await run(["trace", runId, "--workspace", w.dir]);
    const text = traced.out + traced.err;
    assert.match(text, /graph has 5 error\(s\)/, `the fixture must actually carry five errors, GRAPH017 not among the first three:\n${text}`);
    assert.doesNotMatch(text, /GRAPH017/, `the display text must NOT spell the code at all — that is the whole bug:\n${text}`);
    assert.match(text, GRANT_ADVICE, `the advice must still appear, read off the FULL diagnostics array:\n${text}`);
  } finally {
    w.dispose();
  }
});

// ── the missing full stop ─────────────────────────────────────────────────────

test("THE GRANT ADVICE STARTS WITH A FULL STOP, NOT A BARE SPACE, AFTER THE FAILED-CANDIDATES CLAUSE", async () => {
  const w = workspace();
  try {
    const graph = {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "sole", project: "lane-d", version: 1 },
      policy: { posture: "out", capabilities: ["proc:exec"], expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
      channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [{ id: "x", type: "tool", reads: ["seed"], writes: ["out"], unhandled: true, tool: { name: "proc.exec", version: "1.0", args: { command: "echo", args: ["hi"] } } }],
      edges: [],
    };
    writeFileSync(join(w.dir, "graphs", "sole.json"), JSON.stringify(graph));
    const started = await run(["run", join(w.dir, "graphs", "sole.json"), "--workspace", w.dir, "--input", '{"seed":"hi"}', "--allow-exec", "echo"]);
    assert.equal(started.code, 0, started.err);
    const { runId } = JSON.parse(started.out) as { runId: string };

    const traced = await run(["trace", runId, "--workspace", w.dir]);
    const text = traced.out + traced.err;
    // BEFORE this round: "...does not hold) A candidate..." — one sentence bleeding into the next
    // with no punctuation between the closing paren and the capital letter.
    assert.doesNotMatch(text, /does not hold\) A candidate/, `a full stop must separate the two sentences:\n${text}`);
    assert.match(text, /does not hold\)\. A candidate/, `the closing paren must be followed by ". ", not " ":\n${text}`);
  } finally {
    w.dispose();
  }
});

// ── control characters, stripped ──────────────────────────────────────────────

test("A REF CONTAINING \\n AND \\u001b YIELDS NEITHER IN THE REFUSAL", async () => {
  const w = workspace();
  try {
    mkdirSync(join(w.dir, "resources", "function"), { recursive: true });
    writeFileSync(join(w.dir, "resources", "function", "prep.js"), `(view) => ({ writes: { out: String(view.get("seed") ?? "") } })`);
    // The ref is graph-author-controlled text that lands verbatim in a Diagnostic.message
    // (`rule015Resources`'s `resource "${ref}" does not resolve`) once it fails to resolve — a
    // newline forges an extra line in this process's own stderr, and an ESC (`\u001b`) is the lead
    // byte of an ANSI escape sequence a terminal would act on. `function/…@stable` is a
    // structurally valid ref (any string after the kind prefix passes the schema); it simply does
    // not resolve to a published resource, which is exactly the GRAPH015 shape this whole file
    // drives everything else through.
    const injected = "function/evil\nname\u001b[31m@stable";
    const graph = (ref: string, version: number): unknown => ({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "g", project: "lane-d", version },
      policy: { posture: "out", capabilities: [] },
      channels: { seed: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [{ id: "f", type: "function", reads: ["seed"], writes: ["out"], function: { ref } }],
      edges: [],
    });
    writeFileSync(join(w.dir, "graphs", "g.json"), JSON.stringify(graph("function/prep@stable", 1)));
    const started = await run(["run", join(w.dir, "graphs", "g.json"), "--workspace", w.dir, "--input", '{"seed":"hi"}']);
    assert.equal(started.code, 0, started.err);
    const { runId } = JSON.parse(started.out) as { runId: string };

    writeFileSync(join(w.dir, "graphs", "g.json"), JSON.stringify(graph(injected, 2)));

    const traced = await run(["trace", runId, "--workspace", w.dir]);
    const text = traced.out + traced.err;
    assert.match(text, /GRAPH015_RESOURCE_NOT_FOUND/, `the true reason must still reach the operator:\n${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /\n[^\s]*evil/, `a literal newline must not split the ref across lines:\n${JSON.stringify(text)}`);
    assert.equal(text.includes("\u001b"), false, `an ESC byte must not reach the terminal:\n${JSON.stringify(text)}`);
    // The rest of the ref (the harmless part) should still be recognisable, so this is not merely
    // dropping the whole message — only the control bytes are gone.
    assert.match(text, /evilname/, `the sanitized message must still be legible:\n${JSON.stringify(text)}`);
  } finally {
    w.dispose();
  }
});
