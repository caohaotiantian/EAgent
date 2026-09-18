/**
 * §H.14 — A DIAGNOSTIC WRAPS FOR A TERMINAL AND NEVER FOR A PIPE.
 *
 * The measurement the change rests on, taken on the `eto` graph of
 * `docs/handoff-2026-09-15b.md` §Repros from a throwaway workspace:
 *
 *     $ node packages/core/src/cli.ts compile graphs/eto.json 2>&1 | awk '{print NR": "length($0)}'
 *     1: 206       # ✗ eto.json: GRAPH021_FANOUT_WITHOUT_JOIN: …
 *     2: 852       #    fix: …
 *     3: 67        # E_GRAPH_INVALID: graph has 1 error(s): …
 *
 * 852 is BYTES; the character count is 846 — three em dashes at three bytes each. Both numbers
 * are in `TODO.md` §H.14, which reads the second as "844 of `fix:` text plus the 8-character
 * prefix".
 *
 * WHAT A TERMINAL DOES WITH IT TODAY, measured by slicing at the column boundary:
 *
 *     cols   rows   breaks landing MID-TOKEN   continuation indent
 *      80     11              6                        0
 *     100      9              2                        0
 *     120      8              4                        0
 *
 *     |   fix: give join "gather" an entry in its `branches` for each of read, classify|
 *     |, and a `kind: join` edge from each of them into "gather" — every node inside a |
 *     |fan-out branch needs both. ADD to whatever "gather" already declares: one join c|
 *
 * So the soft wrap the row credits the terminal with splits the identifiers the author is being
 * told to copy, and starts every continuation at column 0 where it cannot be told from a new
 * diagnostic.
 *
 * AND THE COST THE ROW PRICED IS REAL: a wrapped line cannot be `grep`ed for as one string. That
 * is why the wrap is conditioned on the STREAM rather than turned on. On a TTY a human is reading
 * and there is no `grep`; in a pipe the bytes are what they were before. Both halves are pinned
 * below.
 *
 * AND A TEST IS NOT AUTOMATICALLY A PIPE. Half this tree's CLI tests call `main` in process with
 * `process.stderr.write` monkeypatched, inheriting the TEST process's stdio — under `node --test`
 * a pipe, because the runner spawns each file as a child, but not for a developer running one
 * file with stderr on their terminal. Forcing `stderr.isTTY` true in every child found 1 such
 * assertion in 3941 (`examples-triage.test.ts`, `/unquoted: 24, not "24"/`, split by the wrap),
 * and it now collapses whitespace first. The two `compileCapturing` tests below set `isTTY`
 * themselves for exactly this reason: neither may depend on where it is run.
 *
 * `COLUMNS` is not read, deliberately, and there is no test for it here because there is nothing
 * to test: the width comes from the stream. A test asserting the env var is ignored would pin an
 * absence that the pipe assertion below already covers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, wrapDiagnostic } from "../../src/cli.ts";
import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";

/** The `eto` graph of `docs/handoff-2026-09-15b.md` §Repros — the one §H.14 measured. */
const ETO = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "eto", project: "examples", version: 1 },
  policy: { posture: "out", expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 2 } },
  channels: {
    items: { type: "array", reduce: "replace" },
    shards: { type: "array", reduce: "replace" },
    shard: { type: "string", reduce: "replace" },
    raw: { type: "string", reduce: "append_ordered" },
    failures: { type: "array", reduce: "append_ordered" },
    report: { type: "object", reduce: "replace" },
  },
  inputs: ["items", "failures"],
  outputs: ["report"],
  nodes: [
    { id: "plan", type: "function", reads: ["items"], writes: ["shards"], function: { ref: "function/plan@stable" } },
    { id: "read", type: "function", reads: ["shard", "failures"], writes: ["raw", "failures"], function: { ref: "function/read@stable" } },
    { id: "classify", type: "function", reads: ["shard", "raw"], writes: ["failures"], function: { ref: "function/classify@stable" } },
    { id: "gather", type: "join", reads: ["failures"], writes: ["failures"], join: { branches: ["classify"], mode: "all", onBranchError: "fail" } },
    { id: "collate", type: "function", reads: ["failures"], writes: ["report"], function: { ref: "function/collate@stable" } },
    { id: "again", type: "join", reads: ["failures"], writes: ["failures"], join: { branches: ["read"], mode: "all", onBranchError: "fail" } },
  ],
  edges: [
    { id: "fan", from: "plan", to: "read", kind: "fanout", over: "shards", as: "shard", maxWidth: 4 },
    { id: "sort", from: "read", to: "classify", kind: "seq" },
    { id: "collect", from: "classify", to: "gather", kind: "join" },
    { id: "fold", from: "gather", to: "collate", kind: "seq" },
    { id: "back", from: "read", to: "again", kind: "loop", until: "len(failures) > 0", maxIterations: 2 },
    { id: "out", from: "again", to: "collate", kind: "seq" },
  ],
} as unknown as GraphSpec;

const RESOLVER: ResourceResolver = { resolve: (ref) => ({ ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" }) };

/** The real `fix:` line, read off the compiler rather than pasted — a reworded clause must not pass. */
function etoFixText(): string {
  const r = compile({ spec: ETO, resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  const d = r.diagnostics.find((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN");
  assert.ok(d?.fix !== undefined, "the eto graph must still produce GRAPH021 with a fix:");
  return d.fix;
}

// ── the pure function ────────────────────────────────────────────────────────

test("THE MEASUREMENT ITSELF — the eto fix: line is 852 bytes and 846 characters on one line", () => {
  const line = `   fix: ${etoFixText()}`;
  assert.equal(line.length, 846, "characters (UTF-16 units) — the display width a terminal must find room for");
  assert.equal(Buffer.byteLength(line, "utf8"), 852, "bytes — the number `awk '{print length($0)}'` prints, and the one TODO.md §H.14 carries");
});

test("WRAPPED, no line exceeds the width, and the continuation indent is the one it was given", () => {
  const line = `   fix: ${etoFixText()}`;
  for (const width of [60, 80, 100, 120]) {
    const rows = wrapDiagnostic(line, width, 8).split("\n");
    assert.ok(rows.length > 1, `width ${width} must wrap an 846-character line`);
    for (const row of rows) assert.ok(row.length <= width, `width ${width}: ${row.length} > ${width}: ${row}`);
    assert.ok(rows[0]!.startsWith("   fix: "), `the prefix survives: ${rows[0]}`);
    for (const row of rows.slice(1)) {
      assert.match(row, /^ {8}\S/, `every continuation hangs at exactly 8, so the block reads as one fix:: ${JSON.stringify(row)}`);
    }
  }
});

test("NOTHING IS LOST AND NOTHING IS REORDERED — unwrapping reproduces the line byte for byte", () => {
  const line = `   fix: ${etoFixText()}`;
  for (const width of [60, 80, 100, 120]) {
    const rows = wrapDiagnostic(line, width, 8).split("\n");
    const rejoined = [rows[0]!, ...rows.slice(1).map((r) => r.slice(8))].join(" ");
    assert.equal(rejoined, line, `width ${width}: a wrap that truncates or reorders is worse than no wrap`);
  }
});

test("A WRAP MAY REPLACE THE WHITESPACE AT A BREAK AND NO OTHER — `bad  name.json` is a path, not prose", () => {
  // THE FIRST CUT OF THIS FUNCTION FAILED HERE. It rebuilt each line by joining tokens with ONE
  // space, so every run of two spaces collapsed and trailing space vanished — silently, and even
  // when the line already fitted. `loadGraph` interpolates the file name UNQUOTED (`basename`),
  // so a file really called `bad  name.json` was rendered on a terminal as `bad name.json`: an
  // operator shown a path that does not exist, by the code that exists to help them.
  for (const [text, indent] of [
    ["   fix: alpha  beta gamma", 8],
    ["   fix: alpha beta ", 8],
    ["✗ bad  name.json: CODE: message here", 2],
    ["   fix: alpha\tbeta gamma", 8],
    ["  ", 2],
    ["", 2],
  ] as const) {
    assert.equal(wrapDiagnostic(text, 200, indent), text, `a line that fits must come back byte-identical: ${JSON.stringify(text)}`);
  }
  // And when it DOES wrap, the untouched gaps are still verbatim.
  const wide = `✗ bad  name.json: CODE: ${"word ".repeat(40)}end`;
  const rows = wrapDiagnostic(wide, 60, 2).split("\n");
  assert.ok(rows.length > 1, "this one must wrap");
  assert.ok(rows[0]!.startsWith("✗ bad  name.json: CODE:"), `the two spaces survive the wrap: ${rows[0]}`);
});

test("A NEWLINE ALREADY IN THE TEXT IS A FORCED BREAK, re-indented — not a row dropped to column 0", () => {
  // `GRAPH003_BAD_ID` echoes the id it refuses, and an id holding a newline is what it refuses.
  // Left alone that newline puts the rest of the line at column 0 — the exact failure this
  // function exists to remove, rebuilt inside the fix. A quoted span therefore may not swallow
  // one either: the span scan stops at the end of its own line.
  const line = '✗ x.json: GRAPH003_BAD_ID: channel name "a\nb" is not a usable id, and filler to force a wrap';
  const rows = wrapDiagnostic(line, 60, 2).split("\n");
  assert.ok(rows.length > 1);
  for (const row of rows.slice(1)) assert.match(row, /^ {2}\S/, `every row after the first hangs at 2: ${JSON.stringify(row)}`);
  assert.ok(rows.some((r) => r.includes('"a')), "the id's first half is still there");
  assert.ok(rows.some((r) => r.includes('b"')), "and its second half");
  assert.equal(wrapDiagnostic("a\nb", 200, 4), "a\n    b", "even when both halves fit");
});

test("NO BREAK LANDS INSIDE A QUOTED ID OR A BACKTICK SPAN — which breaking at spaces alone does not give you", () => {
  // The soft wrap this replaces splits `GRAPH008_JOIN_DEPTH` and `classify`; a naive
  // space-splitter instead splits `"kind: join"`-shaped spans, which contain spaces. Balanced
  // counts per row is the checkable form of "the span did not straddle the break".
  const line = `   fix: ${etoFixText()}`;
  assert.ok(line.includes("`kind: join`"), "the guard is only meaningful while a span with a space in it is in the text");
  for (const width of [60, 80, 100, 120]) {
    for (const row of wrapDiagnostic(line, width, 8).split("\n")) {
      assert.equal((row.match(/"/g) ?? []).length % 2, 0, `width ${width}: a quoted id straddles this break: ${row}`);
      assert.equal((row.match(/`/g) ?? []).length % 2, 0, `width ${width}: a backtick span straddles this break: ${row}`);
    }
  }
});

test("A LINE WITH NO SPACES COMES BACK UNCHANGED — it does not loop, split or truncate", () => {
  const solid = "x".repeat(500);
  assert.equal(wrapDiagnostic(solid, 80, 8), solid, "one token and nothing else: there is no break to take");
  // With a prefix there ARE two tokens, so the over-long one moves to its own row — whole, and
  // still 500 characters. Overflowing a row is the only honest answer; cutting it would delete
  // the identifier the author was told to copy.
  assert.deepEqual(wrapDiagnostic(`   fix: ${solid}`, 80, 8).split("\n"), ["   fix:", `        ${solid}`]);
  // And an over-long token among short ones overflows its OWN row rather than being cut.
  const rows = wrapDiagnostic(`   fix: a ${solid} b`, 80, 8).split("\n");
  assert.deepEqual(rows, ["   fix: a", `        ${solid}`, "        b"]);
  assert.ok(rows[1]!.includes(solid), "the token is whole, on a row that is simply too long");
});

test("AN UNBALANCED QUOTE IS AN ORDINARY CHARACTER — a malformed message cannot glue the rest into one token", () => {
  // Without the look-ahead for a closer, one stray `"` would open a span that never ends and the
  // whole remainder would become a single token, i.e. one unwrapped line — the defect, restored.
  const rows = wrapDiagnostic(`   fix: alpha "beta ${"gamma ".repeat(30)}delta`, 60, 8).split("\n");
  assert.ok(rows.length > 1, "the line must still wrap");
  for (const row of rows) assert.ok(row.length <= 60, row);
});

test("A WIDTH THE LINE ALREADY FITS IS A NO-OP", () => {
  const line = `   fix: ${etoFixText()}`;
  assert.equal(wrapDiagnostic(line, 10_000, 8), line);
  assert.equal(wrapDiagnostic("✗ g.json: CODE: short", 80, 2), "✗ g.json: CODE: short");
});

// ── the printer, through `main` ──────────────────────────────────────────────

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-h14-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  writeFileSync(join(dir, "graphs", "eto.json"), JSON.stringify(ETO));
  // Bare function expressions — a top-level statement is a load error, and a skipped resource
  // would add four more long lines to stderr and blur what is being measured.
  for (const [name, body] of [
    ["plan", "{ shards: [] }"],
    ["read", '{ raw: "" }'],
    ["classify", "{ failures: [] }"],
    ["collate", "{ report: {} }"],
  ] as const) {
    writeFileSync(join(dir, "resources", "function", `${name}.js`), `(view) => ({ writes: ${body} })\n`);
  }
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Run `loom compile` in process with stderr captured, pretending to be a terminal or not.
 *
 * In process rather than spawned, because a spawned child's stderr IS a pipe and there is no
 * portable way to hand it a pty — the TTY arm would be untestable and therefore untested.
 * `isTTY` and `columns` are defined and deleted around the call so nothing leaks into the
 * sibling tests in this file.
 */
async function compileCapturing(dir: string, tty: number | undefined): Promise<readonly string[]> {
  const realErr = process.stderr.write.bind(process.stderr);
  const realOut = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  const had = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const hadCols = Object.getOwnPropertyDescriptor(process.stderr, "columns");
  process.stderr.write = ((chunk: string) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  Object.defineProperty(process.stderr, "isTTY", { value: tty !== undefined, configurable: true, writable: true });
  Object.defineProperty(process.stderr, "columns", { value: tty, configurable: true, writable: true });
  // `compiled` rather than `assert.fail` inside the `try`: the AssertionError would be thrown INTO
  // the bare `catch` below and swallowed, leaving a guard that can never fire.
  let compiled = false;
  try {
    await main(["compile", join(dir, "graphs", "eto.json"), "--workspace", dir]);
    compiled = true;
  } catch {
    // E_GRAPH_INVALID — the diagnostics are the point, not the throw.
  } finally {
    process.stderr.write = realErr;
    process.stdout.write = realOut;
    if (had === undefined) delete (process.stderr as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stderr, "isTTY", had);
    if (hadCols === undefined) delete (process.stderr as { columns?: number }).columns;
    else Object.defineProperty(process.stderr, "columns", hadCols);
  }
  assert.equal(compiled, false, "the eto graph must not compile — if it does, there are no diagnostics to measure");
  return captured.join("").split("\n").filter((l) => l !== "");
}

test("IN A PIPE THE fix: LINE IS STILL ONE LINE — this is the cost §H.14 priced, and it is not paid", async () => {
  const w = workspace();
  try {
    const lines = await compileCapturing(w.dir, undefined);
    const fix = lines.filter((l) => l.startsWith("   fix: "));
    assert.equal(fix.length, 1, `exactly one fix: line, unwrapped:\n${lines.join("\n")}`);
    assert.equal(Buffer.byteLength(fix[0]!, "utf8"), 852, "the measured length, unchanged by this row");
    // The whole point of not wrapping here: an operator can still grep the clause as one string.
    assert.ok(fix[0]!.includes("ADD to whatever \"gather\" already declares: one join can be the barrier for more than one fan-out"));
    const message = lines.filter((l) => l.startsWith("✗ "));
    assert.equal(message.length, 1, "and the message line likewise");
    assert.equal(Buffer.byteLength(message[0]!, "utf8"), 206);
  } finally {
    w.dispose();
  }
});

test("ON A TERMINAL THE SAME TWO LINES WRAP — message at indent 2, fix: at indent 8, nothing over the width", async () => {
  const w = workspace();
  try {
    const lines = await compileCapturing(w.dir, 80);
    for (const l of lines) assert.ok(l.length <= 80, `${l.length} > 80: ${l}`);
    assert.equal(lines.filter((l) => l.startsWith("   fix: ")).length, 1, "one row still opens the fix:");
    assert.equal(lines.filter((l) => l.startsWith("✗ ")).length, 1, "one row still opens the message");

    // The message's continuations sit at 2 and the fix:'s at 8, so a wrapped message is never
    // mistaken for the fix: below it. Slice the block out by its opener.
    const start = lines.findIndex((l) => l.startsWith("✗ "));
    const fixAt = lines.findIndex((l) => l.startsWith("   fix: "));
    for (const l of lines.slice(start + 1, fixAt)) assert.match(l, /^ {2}\S/, `message continuation: ${JSON.stringify(l)}`);
    for (const l of lines.slice(fixAt + 1).filter((l) => l.startsWith(" "))) {
      assert.match(l, /^ {8}\S/, `fix: continuation: ${JSON.stringify(l)}`);
    }

    // And the text is all still there: unwrapping the fix: block gives back the 852 bytes.
    const fixBlock = [lines[fixAt]!, ...lines.slice(fixAt + 1).filter((l) => l.startsWith("        "))];
    assert.equal(Buffer.byteLength([fixBlock[0]!, ...fixBlock.slice(1).map((l) => l.slice(8))].join(" "), "utf8"), 852);
  } finally {
    w.dispose();
  }
});

test("A TERMINAL NARROWER THAN 60 OR WIDER THAN 120 IS CLAMPED — 60 fits this tree's own vocabulary, 120 keeps a paragraph one", async () => {
  const w = workspace();
  try {
    const narrow = await compileCapturing(w.dir, 20);
    for (const l of narrow) assert.ok(l.length <= 60, `floor 60: ${l.length}: ${l}`);
    assert.ok(narrow.some((l) => l.length > 20), "and it does NOT honour 20 — the longest token is 21 characters");

    const wide = await compileCapturing(w.dir, 400);
    for (const l of wide) assert.ok(l.length <= 120, `cap 120: ${l.length}: ${l}`);
    assert.ok(wide.filter((l) => l.startsWith("        ")).length > 0, "a 846-character line still wraps at 120");
  } finally {
    w.dispose();
  }
});
