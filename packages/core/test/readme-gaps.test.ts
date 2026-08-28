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
import { spawnSync } from "node:child_process";
import {
  cpSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);

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
    row: "`JoinNode.timeoutMs`",
    claims: "nothing reads it, so a barrier whose branch never arrives waits forever",
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
    row: "Reading the clock in a body",
    claims: "`ctx.now()` is the task's journaled lease timestamp",
    // A ROW THAT FLIPPED, so the probe flipped with it. It used to assert the ABSENCE of a
    // random effect; asserting the same thing after the gap closed is how a gaps table starts
    // describing a system nobody has.
    probe: () => {
      const realm = SRC("resources/realm.ts");
      assert.match(realm, /^\s*"Math",$/m, "Math must still be in the safe globals — the PRNG replaces its `random`, not the object");
      assert.match(realm, /Date: undefined/, "and Date must still be absent from the realm");
      // THE ROW'S OWN CLAIM: the body clock is the fold's lease timestamp, not the engine's now.
      assert.match(SRC("run/engine.ts"), /#bodyClock\(/, "the engine must bind a body clock");
      assert.match(SRC("run/engine.ts"), /lease\?\.at \?\? p\.startedAt/, "bound to the journaled lease timestamp");
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
  // NINE, down from ten: "Compensation edges" moved to the works table on 2026-08-28 when the
  // rollback started running. The floor exists to catch a BROKEN SCAN — a heading rename, a
  // table reformat — not to freeze the table size, so it moves with the table and the reason
  // is written here rather than inferred from a number nobody can source.
  assert.ok(rows.length >= 9, `found ${rows.length} rows — the table scan broke, not the table`);

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
    row: "Compensation edges",
    claims: "a rollback that RUNS",
    probe: () => {
      // It moved from the gaps table on 2026-08-28. The probe that used to sit there asserted the
      // dead arm verbatim — `case "error": case "compensation": break;` — so the row could not
      // rot in either direction, and that same arm is what the fix deleted.
      assert.match(SRC("run/engine.ts"), /planCompensation\(/, "the engine must plan a rollback");
      assert.match(SRC("run/compensation.ts"), /export function planCompensation/);
      // Three journaled outcomes, not two: "failed to compensate" and "never attempted" are
      // different facts and the row claims both.
      for (const state of ["compensated", "failed", "notAttempted"]) {
        assert.match(SRC("run/compensation.ts") + SRC("run/engine.ts"), new RegExp(state), `the ${state} outcome is gone — update the row`);
      }
    },
  },
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
    claims: "An approval binds the graph it was shown",
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
      // The staleness half of that is no longer a hole this probe has to live with: the binary
      // now carries its own source digest and refuses when it has aged. See the freshness tests
      // at the bottom of this file.
      assert.match(SRC("server/http.ts"), /text\/html/, "the plane must still serve the console");
    },
  },
  {
    row: "Gates",
    claims: "2,300+ tests",
    probe: () => {
      // A FLOOR in the prose, so growth costs no doc edit. The number in the README must be at
      // or below what the suite actually holds — checked against the test files rather than a
      // second hard-coded figure, which would be the same drift one level over.
      //
      // ANCHORED TO THE GATES ROW, not to the whole README. The phrase used to end "across both
      // packages", which made it unique; `packages/eagent` was deleted on 2026-08-25 and the
      // shorter phrase would otherwise bind to the first `N+ tests` anywhere in the file.
      const gatesRow = README.split("\n").find((l) => /^\|\s*\*\*Gates\*\*\s*\|/.test(l)) ?? "";
      const m = /(\d[\d,]*)\+ tests/.exec(gatesRow);
      assert.ok(m, "the Gates row must state a floor like `1900+ tests`");
      const stated = Number(m[1]!.replace(/,/g, ""));
      const actual = globSync(fileURLToPath(new URL("../../*/test/**/*.test.ts", import.meta.url)))
        .map((f) => (readFileSync(f, "utf8").match(/^test\(/gm) ?? []).length)
        .reduce((a, b) => a + b, 0);
      assert.ok(actual >= stated, `the README claims ${stated}+ tests and the suite declares ${actual}`);
    },
  },
  {
    row: "One-line agents",
    claims: "compiling to a one-node graph",
    probe: () => {
      const a = SRC("agent.ts");
      assert.match(a, /compileOrThrow\(/, "agent() must compile a real graph rather than run a private loop");
      assert.match(a, /new Engine\(/, "…and run it on the engine");
      assert.match(a, /type: "agent"/, "…as an agent node");
    },
  },
  {
    row: "Declared effects",
    claims: "invokes only the tools its node declared, through one dispatch path",
    probe: () => {
      assert.match(SRC("graph/spec.ts"), /readonly effects\?: readonly string\[\]/, "FunctionNode must declare effects");
      assert.match(SRC("graph/spec.ts"), /node\.function\?\.effects/, "and reachableToolNames must see them");
      assert.match(SRC("run/engine.ts"), /#effectsFor\(/, "the engine must bind them");
      assert.match(SRC("run/engine.ts"), /this\.#invokeTool\(ctx, p, w\.task, tool, args, ordinal\+\+, true\)/, "…through the one dispatch path, claiming the node's own approval");
    },
  },
  {
    row: "Determinism",
    claims: "a clock bound to the task's journaled lease timestamp",
    probe: () => {
      assert.match(SRC("run/engine.ts"), /#bodyClock\(/, "the body clock seam");
      assert.match(SRC("run/engine.ts"), /lease\?\.at \?\? p\.startedAt/, "bound to the fold, not the wall clock");
      assert.match(SRC("resources/functions.ts"), /Math\.random = function \(\)/, "and the seeded PRNG is still installed");
    },
  },
];

test("EVERY CLAIM IN THE README'S \"WHAT WORKS TODAY\" TABLE IS STILL TRUE", () => {
  for (const { row, claims, probe } of WORKS) {
    assert.ok(README.includes(claims), `the "${row}" row no longer says ${JSON.stringify(claims)}`);
    probe();
  }
});

test("EVERY ROW OF THE WORKS TABLE IS PROBED — all of them, not most of them", () => {
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

/**
 * ── "Ships inside the binary" is a claim about a FILE NOBODY REBUILDS ─────────────────────────
 *
 * README:66 tells a reader to run `npm run build:binary` and then drive `bin/loom`. `bin/` is
 * gitignored, no hook rebuilds it, and CI never builds it — so from the second source edit
 * onward the file on disk is a photograph of an older tree. On 2026-08-25 that bit: an auditor
 * measured behaviour through a `bin/loom` 109 seconds behind `packages/core/src` and wrote down
 * the older code's answers (`docs/todo-recheck-2026-08-25.md`:1858). Re-measured on 2026-08-28
 * the same checked-out binary was three days and 40 source files behind and still printed
 * `--help` with exit 0.
 *
 * The Console row above says the source is the evidence "because `bin/loom` … may be absent or
 * stale". That is still the right call for a row about what goes INTO the binary — but it means
 * NOTHING here ever catches the staleness, and a gate would not have helped the auditor anyway:
 * they were running the binary directly, hours after the last `npm run check`.
 *
 * So the check rides in the binary. `scripts/build-binary.mjs` hashes the sources it compiled and
 * bakes the digest — and the checking code itself — into the SEA bundle's banner, which runs
 * before any application code. These tests drive that banner the way it actually runs: a real
 * child process, loading a real bundle, against a real source tree on disk.
 */
const freshness = require_(fileURLToPath(new URL("../../../scripts/binary-freshness.cjs", import.meta.url))) as {
  SOURCE_DIR: string;
  digestSources: (dir: string) => { digest: string; count: number };
  stampFor: (root: string) => { dir: string; digest: string; count: number; builtAt: string };
  distIsBehindSources: (root: string) => string | null;
  banner: (stamp: unknown) => string;
};

/** A throwaway repo: `<root>/packages/core/src/*.ts` plus `<root>/bin/loom.cjs`, the fake binary. */
function fakeRepo(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "loom-freshness-"));
  const src = join(root, freshness.SOURCE_DIR);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(src, rel)), { recursive: true });
    writeFileSync(join(src, rel), body);
  }
  mkdirSync(join(root, "bin"), { recursive: true });
  return root;
}

/**
 * Write the fake binary: the banner the real build injects, followed by one line of
 * "application" — so `APP RAN` on stdout means the guard let the program through.
 */
function buildFake(root: string): string {
  const bin = join(root, "bin", "loom.cjs");
  writeFileSync(bin, `${freshness.banner(freshness.stampFor(root))}\nconsole.log("APP RAN");\n`);
  return bin;
}

function runFake(bin: string, env: Readonly<Record<string, string>> = {}): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [bin], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const ONE_FILE = { "a.ts": "export const a = 1;\n", "run/b.ts": "export const b = 2;\n" };

test("a binary built from the sources beside it runs — the guard is not just a refusal generator", () => {
  const root = fakeRepo(ONE_FILE);
  const r = runFake(buildFake(root));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /APP RAN/);
  assert.equal(r.err, "", "a fresh binary says nothing");
});

test("THE DEFECT: a binary whose sources have since been edited refuses to run", () => {
  const root = fakeRepo(ONE_FILE);
  const bin = buildFake(root);
  writeFileSync(join(root, freshness.SOURCE_DIR, "run/b.ts"), "export const b = 3;\n");
  const r = runFake(bin);
  assert.equal(r.code, 1, "a stale binary must not run");
  assert.doesNotMatch(r.out, /APP RAN/, "…and must not reach the application");
  assert.match(r.err, /STALE/, `the refusal must say so: ${JSON.stringify(r.err)}`);
  assert.match(r.err, /npm run build:binary/, "…and must name the command that fixes it");
});

test("an ADDED source file is staleness too — the digest covers the file set, not just contents", () => {
  const root = fakeRepo(ONE_FILE);
  const bin = buildFake(root);
  writeFileSync(join(root, freshness.SOURCE_DIR, "c.ts"), "export const c = 3;\n");
  const r = runFake(bin);
  assert.equal(r.code, 1);
  assert.match(r.err, /STALE/);
});

test("a REMOVED source file is staleness too", () => {
  const root = fakeRepo(ONE_FILE);
  const bin = buildFake(root);
  rmSync(join(root, freshness.SOURCE_DIR, "a.ts"));
  const r = runFake(bin);
  assert.equal(r.code, 1);
  assert.match(r.err, /STALE/);
});

test("a RENAMED source file is staleness too — the path is inside the digest", () => {
  const root = fakeRepo(ONE_FILE);
  const bin = buildFake(root);
  const src = join(root, freshness.SOURCE_DIR);
  renameSync(join(src, "a.ts"), join(src, "renamed.ts"));
  const r = runFake(bin);
  assert.equal(r.code, 1);
  assert.match(r.err, /STALE/);
});

test("a source file touched but not changed is NOT staleness — content, never mtime", () => {
  const root = fakeRepo(ONE_FILE);
  const bin = buildFake(root);
  const f = join(root, freshness.SOURCE_DIR, "a.ts");
  const body = readFileSync(f, "utf8");
  writeFileSync(f, "tmp");
  writeFileSync(f, body);
  const r = runFake(bin);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /APP RAN/);
});

test("WHEN IT CANNOT DECIDE IT REFUSES: a source tree it cannot read is a refusal, not a pass", () => {
  const root = fakeRepo(ONE_FILE);
  const bin = buildFake(root);
  // A dangling symlink where a `.ts` file was. The file SET is unchanged — the walk still sees
  // `a.ts` — so this isolates the read failure from staleness, and it raises for every user
  // including root, unlike a chmod. (A directory named `a.ts` does not work: the walk descends
  // into it and the path leaves the set, which is a removal and is caught as staleness instead.)
  const f = join(root, freshness.SOURCE_DIR, "a.ts");
  rmSync(f);
  symlinkSync(join(root, freshness.SOURCE_DIR, "nowhere.ts"), f);
  const r = runFake(bin);
  assert.equal(r.code, 1, "an unreadable source tree must not be reported fresh");
  assert.doesNotMatch(r.out, /APP RAN/);
  assert.match(r.err, /could not be read/, r.err);
});

test("NO source tree beside it is silent — that is every copy a user installed", () => {
  // The shipped case, and it is decidable rather than undecidable: a binary with no sources next
  // to it cannot be behind them. If this refused, `bin/loom` would be undistributable.
  const root = fakeRepo(ONE_FILE);
  const bin = buildFake(root);
  rmSync(join(root, "packages"), { recursive: true });
  const r = runFake(bin);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /APP RAN/);
  assert.equal(r.err, "", "a shipped binary must not nag about sources it will never have");
});

test("the binary is located by ITSELF, not by the path it was built at — a moved repo still checks", () => {
  const root = fakeRepo(ONE_FILE);
  buildFake(root);
  const moved = mkdtempSync(join(tmpdir(), "loom-freshness-moved-"));
  cpSync(root, moved, { recursive: true });
  rmSync(root, { recursive: true });
  writeFileSync(join(moved, freshness.SOURCE_DIR, "a.ts"), "export const a = 99;\n");
  const r = runFake(join(moved, "bin", "loom.cjs"));
  assert.equal(r.code, 1, "the guard must anchor on its own location, not on a baked absolute path");
  assert.match(r.err, /STALE/);
});

test("LOOM_STALE_BINARY=allow lowers the refusal to a warning — and still tells you", () => {
  // The escape hatch is a human's, set per invocation. It never silences the message: the README
  // bar is that nobody drives a stale binary WITHOUT BEING TOLD, not that nobody drives one.
  const root = fakeRepo(ONE_FILE);
  const bin = buildFake(root);
  writeFileSync(join(root, freshness.SOURCE_DIR, "a.ts"), "export const a = 2;\n");
  const r = runFake(bin, { LOOM_STALE_BINARY: "allow" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /APP RAN/);
  assert.match(r.err, /STALE/, "the override must still print the whole refusal");
  assert.match(r.err, /LOOM_STALE_BINARY/);
});

test("any other value of LOOM_STALE_BINARY still refuses — an unrecognised posture is not permission", () => {
  const root = fakeRepo(ONE_FILE);
  const bin = buildFake(root);
  writeFileSync(join(root, freshness.SOURCE_DIR, "a.ts"), "export const a = 2;\n");
  for (const v of ["1", "true", "yes", "ALLOW", ""]) {
    const r = runFake(bin, { LOOM_STALE_BINARY: v });
    assert.equal(r.code, 1, `LOOM_STALE_BINARY=${JSON.stringify(v)} must not loosen anything`);
  }
});

test("the digest covers a NAMED set — every *.ts under packages/core/src, and nothing else", () => {
  assert.equal(freshness.SOURCE_DIR, "packages/core/src");
  const root = fakeRepo(ONE_FILE);
  const before = freshness.digestSources(join(root, freshness.SOURCE_DIR)).digest;
  // Not a `.ts` file, and not under src: neither may move the digest, or an unrelated edit would
  // strand the binary.
  writeFileSync(join(root, freshness.SOURCE_DIR, "notes.md"), "hello");
  writeFileSync(join(root, "package.json"), "{}");
  assert.equal(freshness.digestSources(join(root, freshness.SOURCE_DIR)).digest, before);
});

test("THE BUILD ACTUALLY BAKES IT IN — the guard is wired into the esbuild banner, not merely available", () => {
  // Without this the whole mechanism can be deleted from `build-binary.mjs` and every test above
  // keeps passing against a module nothing calls.
  const build = readFileSync(fileURLToPath(new URL("../../../scripts/build-binary.mjs", import.meta.url)), "utf8");
  assert.match(build, /binary-freshness\.cjs/, "the build must load the freshness module");
  assert.match(build, /\.banner\(/, "…and put its banner into the bundle");
  assert.match(build, /banner: \{/, "…in the banner esbuild injects, which is where it runs first");
});

/**
 * The stamp is a digest of `packages/core/src`, but what the bundler eats is `packages/core/dist`.
 * If those disagree the binary certifies sources it does not contain — a guard answering with the
 * passing value, which is the defect class this repo keeps rediscovering. So the BUILD refuses
 * first, and these are the cases where it must.
 */
function distTree(root: string, srcMtime: number, distMtime: number | null): void {
  const src = join(root, freshness.SOURCE_DIR);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "a.ts"), "export const a = 1;\n");
  utimesSync(join(src, "a.ts"), srcMtime / 1000, srcMtime / 1000);
  if (distMtime !== null) {
    const dist = join(root, "packages", "core", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "a.js"), "export const a = 1;\n");
    utimesSync(join(dist, "a.js"), distMtime / 1000, distMtime / 1000);
  }
}

test("the build refuses to stamp when dist is older than src — the stamp would be a lie", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-dist-"));
  distTree(root, 2_000_000, 1_000_000);
  assert.match(String(freshness.distIsBehindSources(root)), /a\.ts is newer than the compiled dist/);
});

test("the build refuses when there is no dist at all", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-dist-"));
  distTree(root, 2_000_000, null);
  assert.match(String(freshness.distIsBehindSources(root)), /nothing has been built/);
});

test("the build refuses when dist exists but holds no compiled .js", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-dist-"));
  distTree(root, 2_000_000, null);
  mkdirSync(join(root, "packages", "core", "dist"), { recursive: true });
  writeFileSync(join(root, "packages", "core", "dist", "README"), "");
  assert.match(String(freshness.distIsBehindSources(root)), /holds no compiled \.js/);
});

test("…and stamps when dist is newer than src, which is what `npm run build:binary` guarantees", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-dist-"));
  distTree(root, 1_000_000, 2_000_000);
  assert.equal(freshness.distIsBehindSources(root), null);
});
