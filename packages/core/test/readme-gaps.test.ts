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
import { readFileSync } from "node:fs";
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
    claims: "every throw out of the `vm` is classified `E_INTERNAL`, so the backoff never schedules",
    probe: () => {
      // Verified by running: a body with `retry: { maxAttempts: 3 }` is called ONCE, the task
      // fails `E_INTERNAL`, and no backoff is scheduled. The mechanism is the class table —
      // `E_INTERNAL` is `internal`, and only `exhausted`/`unavailable`/`timeout` are retryable.
      assert.match(SRC("errors.ts"), /RETRYABLE[^=]*=\s*new Set<ErrorClass>\(\["exhausted", "unavailable", "timeout"\]\)/);
      assert.match(SRC("run/engine.ts"), /if \(!error\.retryable\) return undefined;/, "the retry decision must still gate on retryability");
    },
  },
  {
    row: "`Math.random()` in a function body",
    claims: "`Date` is stripped from the `vm` globals and `Math` is not",
    probe: () => {
      const realm = SRC("resources/realm.ts");
      assert.match(realm, /^\s*"Math",$/m, "Math must still be in the safe globals");
      assert.match(realm, /Date: undefined/, "and Date must still be stripped");
      // "there is no effect key for it": the `random` KIND is declared in the event vocabulary
      // and nothing ever appends one. If that changes, the row is wrong.
      assert.doesNotMatch(SRC("run/engine.ts"), /kind: "random"/, "a random effect is journaled now — update the row");
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
