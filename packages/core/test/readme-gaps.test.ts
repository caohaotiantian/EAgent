/**
 * THE README'S KNOWN-GAPS TABLE IS A SET OF CLAIMS, AND CLAIMS ROT IN BOTH DIRECTIONS.
 *
 * `readme-quickstart.test.ts` pins the part a machine could already check — the graphs in the
 * README compile. The table above them was gated by nothing, and three of its rows were false by
 * the time anybody looked:
 *
 *   - "Hooks — declared, validated, pinned into the manifest, never invoked". Measured through
 *     `bin/loom`: a `preNode` hook memoised the answer as 41 and the run printed 41.
 *   - "`loom compile` against a missing resource — reports `ok`". It refuses, naming the file.
 *   - "Replay of a run a human de-escalated — diverges". It reproduces.
 *
 * Each had been fixed and each still read as a warning to a first-time reader. **A doc that
 * understates is not safer than one that overstates** — it sends somebody to build a workaround
 * for a thing that works, and it makes the rest of the table less believable.
 *
 * So each row that makes a checkable claim gets a probe. A row saying something is BUILT fails
 * if it stops working; a row saying something is a GAP fails if the gap closes and nobody
 * updated the row. The probes are deliberately cheap — the expensive end-to-end evidence lives
 * in the suites named beside each one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compile } from "../src/graph/compile.ts";
import type { GraphSpec } from "../src/graph/spec.ts";
import type { ResourceResolver } from "../src/graph/validate.ts";

const README = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
const SRC = (rel: string): string => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

/** Nothing published — so a ref that names a document resolves to nothing. */
const EMPTY_RESOLVER: ResourceResolver = { resolve: () => undefined };

function diagnostics(spec: GraphSpec): readonly string[] {
  const r = compile({ spec, resolver: EMPTY_RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  return r.diagnostics.map((d) => d.code);
}

const BASE = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "probe", project: "p", version: 1 },
  policy: { posture: "out" },
  channels: { n: { type: "object", reduce: "replace" } },
  inputs: [],
  outputs: ["n"],
} as const;

/**
 * One row, one probe. `claims` is the substring that must be present in the README, so a row
 * cannot be reworded into a different claim without this failing too.
 */
const ROWS: readonly { readonly row: string; readonly claims: string; readonly probe: () => void }[] = [
  {
    row: "Hooks",
    claims: "**Built.** Publish `resources/hook/<name>.js`",
    probe: () => {
      // The mechanism exists and is wired: a registry is constructed and handed to the Engine.
      assert.match(SRC("cli.ts"), /new HookRegistry\(\)/, "the CLI must construct a hook registry");
      assert.match(SRC("cli.ts"), /registerHooks\(documents, hooks, root\)/, "and populate it from the workspace");
      assert.match(SRC("run/engine.ts"), /hooks\b/, "and the engine must take it");
      // End-to-end evidence: test/resources/hook-loader.test.ts.
    },
  },
  {
    row: "loom compile against a missing resource",
    claims: "**Refuses**, naming the file to write (`GRAPH015`)",
    probe: () => {
      const spec = {
        ...BASE,
        nodes: [{ id: "a" as never, type: "agent", writes: ["n"], agent: { profile: "agent_profile/x@stable", prompt: "prompt/absent@stable" } }],
        edges: [],
      } as unknown as GraphSpec;
      assert.ok(diagnostics(spec).includes("GRAPH015_RESOURCE_NOT_FOUND"), "a missing prompt must be refused");
    },
  },
  {
    row: "loom compile — the two exempt kinds",
    claims: "`agent_profile` is a routing key",
    probe: () => {
      // The exemption the row promises, stated where the compiler reads it.
      assert.match(SRC("graph/validate.ts"), /NAME_ONLY_KINDS[\s\S]{0,200}"agent_profile"[\s\S]{0,40}"oversight"/);
    },
  },
  {
    row: "Replay of a de-escalated run",
    claims: "**Reproduces.**",
    probe: () => {
      assert.match(SRC("run/replay.ts"), /recordedCeilings/, "replay must serve recorded de-escalations");
      assert.match(SRC("run/replay.ts"), /kind: "gate\.decided"/, "and its verdict must weigh gates");
    },
  },
  {
    row: "JoinNode.timeoutMs",
    claims: "nothing reads it, so a barrier waits forever",
    probe: () => {
      // STILL A GAP. If a reader ever wires it, this fails and the row has to change.
      assert.doesNotMatch(SRC("run/engine.ts"), /join[?.]*\.timeoutMs/, "a join timeout is read now — update the row");
      const spec = {
        ...BASE,
        channels: { n: { type: "object", reduce: "replace" }, items: { type: "array", reduce: "replace" }, item: { type: "string", reduce: "replace" } },
        inputs: ["items"],
        nodes: [
          { id: "s" as never, type: "function", reads: ["items"], function: { ref: "function/f@stable" } },
          { id: "w" as never, type: "function", reads: ["item"], writes: ["n"], function: { ref: "function/f@stable" } },
          { id: "j" as never, type: "join", join: { branches: ["w" as never], mode: "all", onBranchError: "fail", timeoutMs: 5 } },
          { id: "d" as never, type: "function", reads: ["n"], writes: ["n"], function: { ref: "function/f@stable" } },
        ],
        edges: [
          { id: "e0" as never, from: "s" as never, to: "w" as never, kind: "fanout", over: "items", as: "item", maxWidth: 2 },
          { id: "e1" as never, from: "w" as never, to: "j" as never, kind: "join", branches: ["w" as never] },
          { id: "e2" as never, from: "j" as never, to: "d" as never, kind: "seq" },
        ],
      } as unknown as GraphSpec;
      assert.ok(diagnostics(spec).includes("GRAPH008_JOIN_TIMEOUT_INERT"), "and declaring one must warn");
    },
  },
  {
    row: "Crash mid-effect — rewind is a control-plane command, not a CLI verb",
    claims: "**There is no `loom rewind` CLI verb**",
    probe: () => {
      // Written after getting this row WRONG. The previous wording said "the one path back is an
      // operator `loom rewind`" — a verb that does not exist, introduced in the same commit that
      // fixed three other false rows. Both halves are pinned now: the verb must stay absent, and
      // the command must stay present.
      assert.doesNotMatch(SRC("cli.ts"), /case "rewind"/, "a `loom rewind` verb exists now — update the row");
      assert.match(SRC("server/http.ts"), /case "rewind": \{/, "the control-plane command is gone — update the row");
      assert.match(SRC("run/engine.ts"), /task\.ready" as const/, "and rewind must still re-arm the leases it undoes");
    },
  },
  {
    row: "`retry` on a function or evaluator node",
    claims: "a body returns `{ retry: { reason } }` and the engine raises `E_FUNCTION_UNAVAILABLE` on its behalf",
    // A ROW THAT FLIPPED. Both halves are probed, because the row now makes two claims and they
    // pull in opposite directions: the RETURN path works, and the THROW path still does not.
    probe: () => {
      assert.match(SRC("errors.ts"), /RETRYABLE[^=]*=\s*new Set<ErrorClass>\(\["exhausted", "unavailable", "timeout"\]\)/);
      assert.match(SRC("run/engine.ts"), /if \(!error\.retryable\) return undefined;/, "the retry decision must still gate on retryability");
      // The route that works: one helper, and `err.unavailable` is what makes it retryable.
      const engine = SRC("run/engine.ts");
      assert.match(engine, /function retryRequested\(/, "the helper must exist");
      assert.match(engine, /err\.unavailable\(CODES\.E_FUNCTION_UNAVAILABLE/, "and must raise a class the RETRYABLE set contains");
      assert.equal((engine.match(/retryRequested\(out,/g) ?? []).length, 2, "both callers of functions.require must reach it");
      // The half that still does not: a guest throw cannot be a host LoomError.
      assert.match(SRC("errors.ts"), /export function isLoomError/, "the instanceof check the row's second half is about");
    },
  },
  {
    row: "`Math.random()` in a function body",
    claims: "the realm's `Math.random` is a deterministic PRNG built from it",
    // A ROW THAT FLIPPED, so the probe flipped with it. It used to assert the ABSENCE of a
    // random effect; asserting the same thing after the gap closed is how a gaps table starts
    // describing a system nobody has.
    probe: () => {
      const realm = SRC("resources/realm.ts");
      assert.match(realm, /^\s*"Math",$/m, "Math must still be in the safe globals — the PRNG replaces its `random`, not the object");
      assert.match(realm, /Date: undefined/, "and Date must still be stripped: a clock read has no seed that would make it reproducible");
      // The three halves of the claim, each where it lives: the engine draws and journals a
      // seed, the bridge consumes it, and replay serves the recorded one instead of drawing.
      const engine = SRC("run/engine.ts");
      assert.match(engine, /kind: "random"/, "the engine must journal a random effect");
      assert.match(engine, /effectKey\(w\.task\.taskId, "random", 0\)/, "under a derived key");
      assert.match(engine, /Number\(this\.#replay\.require\(key\)\.result\)/, "and replay must SERVE the recorded seed rather than draw a new one");
      assert.match(SRC("resources/functions.ts"), /Math\.random = function \(\)/, "the bridge must install the seeded PRNG");
    },
  },
  {
    row: "Compensation edges",
    claims: "nothing traverses them at run time",
    probe: () => {
      // The arm that does nothing, verbatim: `case "compensation": break;` beside `case "error"`.
      assert.match(SRC("run/engine.ts"), /case "error":\s*\n\s*case "compensation":\s*\n\s*break;/);
    },
  },
  {
    row: "`onBudgetExhausted: \"gate\" / \"degrade\"`",
    claims: "Compile errors, deliberately",
    probe: () => {
      assert.match(SRC("graph/validate.ts"), /GRAPH003_BUDGET_ACTION_UNSUPPORTED/, "the refusal is gone — update the row");
    },
  },
  {
    row: "Approval modes",
    claims: "Only `single`",
    probe: () => {
      assert.match(SRC("graph/validate.ts"), /GRAPH014_APPROVER_INVALID|mode.*quorum/, "the unsupported modes must still be refused");
    },
  },
];

test("EVERY CHECKABLE CLAIM IN THE README'S GAPS TABLE IS STILL TRUE", () => {
  for (const { row, claims, probe } of ROWS) {
    assert.ok(README.includes(claims), `the README row "${row}" no longer says ${JSON.stringify(claims)} — reword the probe with it`);
    probe();
  }
});

test("the probe table covers the rows that make checkable claims", () => {
  // A gate whose table emptied would pass forever. Floor, not a count: rows may be added.
  assert.ok(ROWS.length >= 7, `${ROWS.length} rows probed — the table shrank`);
  // And the README still HAS a gaps table to probe, rather than having lost it in an edit.
  assert.match(README, /^## What does not work yet$/m, "the gaps section is gone — this gate now checks nothing");
});

/**
 * Rows that make no claim a machine can reach, and why. **The list must not grow.**
 *
 * This file was written with six probes over a ten-row table, and the row it did NOT probe is
 * the one that then went wrong — "the one path back is an operator `loom rewind`", a verb that
 * does not exist, written into the same commit that fixed three other false rows. That is not a
 * coincidence: the rows a gate skips are the rows where the writing was loosest, which is where
 * a wrong claim comes from.
 *
 * So every row is now accounted for exactly once — probed, or excused here in writing. An
 * excuse that says "prose" is a claim somebody can argue with; a row nobody listed is not.
 */
const EXCUSED: Readonly<Record<string, string>> = {};

test("EVERY ROW OF THE GAPS TABLE IS PROBED OR EXCUSED — and nothing is both", () => {
  const start = README.indexOf("## What does not work yet");
  const end = README.indexOf("## Try it");
  assert.ok(start >= 0 && end > start, "the gaps section moved — this gate reads it by heading");
  const rows = [...README.slice(start, end).matchAll(/^\|\s*\*\*(.+?)\*\*\s*\|/gm)].map((m) => m[1]!);
  assert.ok(rows.length >= 10, `found ${rows.length} rows — the table scan broke, not the table`);

  // A row is covered when some probe's `claims` string appears in that row's own text.
  const rowText = new Map<string, string>();
  for (const line of README.slice(start, end).split("\n")) {
    const m = /^\|\s*\*\*(.+?)\*\*\s*\|/.exec(line);
    if (m) rowText.set(m[1]!, line);
  }
  const uncovered = rows.filter((r) => {
    if (EXCUSED[r] !== undefined) return false;
    const text = rowText.get(r) ?? "";
    return !ROWS.some((probe) => text.includes(probe.claims));
  });
  assert.deepEqual(
    uncovered,
    [],
    "these rows claim something no probe checks — add one, or excuse the row in writing with why " +
      "no machine can reach it",
  );

  const both = rows.filter((r) => EXCUSED[r] !== undefined && ROWS.some((p) => (rowText.get(r) ?? "").includes(p.claims)));
  assert.deepEqual(both, [], "these are excused AND probed — delete the excuse");

  const stale = Object.keys(EXCUSED).filter((r) => !rows.includes(r));
  assert.deepEqual(stale, [], "these excuse a row that no longer exists");

  for (const [row, why] of Object.entries(EXCUSED)) {
    assert.ok(why.length > 30, `${row}: an excuse under 30 characters is a shrug, not a reason`);
  }
});

// ── the OTHER table: "What works today" ─────────────────────────────────────
//
// The gaps table is the half a cautious reader checks. This is the half a reader ACTS on, and
// it was gated by nothing at all — its test count said 3347 against a suite of 3498, drift of
// 151, in a repo whose `readme-quickstart.test.ts` exists BECAUSE that number was wrong once
// before ("claimed 386 tests against 1775"). The fix that lasts is a floor, not a count:
// growth must never cost a doc edit, and collapse must fail.

const WORKS: readonly { readonly row: string; readonly claims: string; readonly probe: () => void }[] = [
  {
    row: "Graph compiler",
    claims: "22 validation rules",
    probe: () => {
      // The RULES are the GRAPH0xx families, not the individual codes — 73 of those today.
      const families = new Set([...SRC("graph/validate.ts").matchAll(/GRAPH(\d{3})/g)].map((m) => m[1]!));
      assert.equal(families.size, 22, `the compiler has ${families.size} rule families, and the README says 22`);
    },
  },
  {
    row: "Executor",
    claims: "All eight node types run",
    probe: () => {
      // Eight is the count the schema declares; a ninth would make the sentence wrong.
      const types = [...SRC("graph/spec.ts").matchAll(/^\s*\| "(function|agent|tool|router|join|evaluator|human_gate|subgraph)"/gm)];
      assert.ok(types.length >= 8, `found ${types.length} node types in the union`);
      for (const t of ["function", "agent", "tool", "router", "join", "evaluator", "human_gate", "subgraph"]) {
        assert.match(SRC("run/engine.ts"), new RegExp(`case "${t}"`), `the executor has no arm for ${t}`);
      }
    },
  },
  {
    row: "Durability",
    claims: "A run SUSPENDED on a human gate survives `kill -9`",
    probe: () => {
      // The qualifier is the load-bearing word — `readme-quickstart.test.ts` records that this
      // row once claimed it without one. Pinned so it cannot be dropped again.
      assert.match(README, /A run SUSPENDED on a human gate survives `kill -9`/);
      assert.match(SRC("journal/sqlite.ts"), /node:sqlite/, "the durable store must still be node:sqlite");
    },
  },
  {
    row: "Human oversight",
    claims: "An approval binds the graph it was shown — spec, resolved resources and oversight floor",
    probe: () => {
      // Three conjuncts, three checks. `#assertBound` is where all three live.
      const eng = SRC("run/engine.ts");
      assert.match(eng, /differs: mismatch/, "the binding check must still report WHICH conjunct moved");
      assert.match(eng, /recorded\.manifest !== manifestKey/, "resources");
      assert.match(eng, /recorded\.graphHash === ctx\.graph\.graphHash/, "spec");
    },
  },
  {
    row: "Replay",
    claims: "zero model calls, zero side effects",
    probe: () => {
      assert.match(SRC("run/replay.ts"), /replay: effects/, "the shadow engine must still be handed the recorded effects");
    },
  },
  {
    row: "Providers",
    claims: "Anthropic + OpenAI over `fetch`+SSE",
    probe: () => {
      assert.ok(SRC("providers/anthropic.ts").length > 0);
      assert.ok(SRC("providers/openai.ts").length > 0);
      assert.match(SRC("cli.ts"), /chain\(/, "declarative fallback chains must still be built");
    },
  },
  {
    row: "Console",
    claims: "Ships inside the binary",
    probe: () => {
      // Claimed of the BINARY, so the source is not the evidence — `bin/loom` is gitignored and
      // may be absent or stale, which is why this checks what goes INTO it rather than the file.
      assert.match(SRC("server/http.ts"), /text\/html/, "the plane must still serve the console");
    },
  },
  {
    row: "Gates",
    claims: "3400+ tests across both packages",
    probe: () => {
      // A FLOOR in the prose, so growth costs no doc edit. The number in the README must be at
      // or below what the suite actually holds — checked against the test files rather than a
      // second hard-coded figure, which would be the same drift one level over.
      const m = /(\d[\d,]*)\+ tests across both packages/.exec(README);
      assert.ok(m, "the Gates row must state a floor like `3400+ tests`");
      const stated = Number(m[1]!.replace(/,/g, ""));
      const actual = globSync(fileURLToPath(new URL("../../*/test/**/*.test.ts", import.meta.url)))
        .map((f) => (readFileSync(f, "utf8").match(/^test\(/gm) ?? []).length)
        .reduce((a, b) => a + b, 0);
      assert.ok(actual >= stated, `the README claims ${stated}+ tests and the suite declares ${actual}`);
    },
  },
];

test("EVERY CLAIM IN THE README'S \"WHAT WORKS TODAY\" TABLE IS STILL TRUE", () => {
  for (const { row, claims, probe } of WORKS) {
    assert.ok(README.includes(claims), `the "${row}" row no longer says ${JSON.stringify(claims)}`);
    probe();
  }
});

test("EVERY ROW OF THE WORKS TABLE IS PROBED — all eight, not most of them", () => {
  const start = README.indexOf("## What works today");
  const end = README.indexOf("## What does not work yet");
  assert.ok(start >= 0 && end > start, "the works section moved");
  const block = README.slice(start, end);
  const rows = [...block.matchAll(/^\|\s*\*\*(.+?)\*\*\s*\|/gm)].map((m) => m[1]!);
  assert.ok(rows.length >= 8, `found ${rows.length} rows — the scan broke, not the table`);

  const rowText = new Map<string, string>();
  for (const line of block.split("\n")) {
    const m = /^\|\s*\*\*(.+?)\*\*\s*\|/.exec(line);
    if (m) rowText.set(m[1]!, line);
  }
  const uncovered = rows.filter((r) => !WORKS.some((w) => (rowText.get(r) ?? "").includes(w.claims)));
  assert.deepEqual(uncovered, [], "these rows claim something no probe checks");
});
