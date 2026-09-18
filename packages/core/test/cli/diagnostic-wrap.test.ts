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
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * Run `loom compile` in a REAL CHILD PROCESS, so its stderr is a real pipe.
 *
 * THIS EXISTS BECAUSE THE IN-PROCESS PIPE ARM COULD NOT FAIL, and that hole shipped. The in-process
 * helper set `isTTY` to the literal `false`; a real pipe has `isTTY === undefined`, with no own
 * property at all, and `columns === undefined`. Two mutations proved the gap — deleting the stream
 * condition outright, and `if (process.stderr.isTTY === undefined) return 80` (wrap in exactly the
 * real-pipe case) — and the whole suite stayed GREEN under both. So `loom compile 2>&1 | grep`
 * returning nothing could have shipped under a green gate, and "a pipe sees byte-identical output"
 * — the entire justification for §H.14's TTY-only choice — rested on nothing.
 *
 * Spawned via `execFile` on the source entry point, the shape `product-lane-doors.test.ts` uses:
 * it is also the door an operator goes through, and the exit code comes from the process.
 */
async function compileSpawned(dir: string): Promise<{ code: number; out: string; err: string }> {
  const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, "compile", join(dir, "graphs", "eto.json"), "--workspace", dir],
      { cwd: dirname(cli), timeout: 60_000 },
      (err, stdout, stderr) => {
        resolve({ code: err === null ? 0 : ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1), out: stdout, err: stderr });
      },
    );
  });
}

/**
 * Run `loom compile` in process with stderr captured, pretending to be a terminal or not.
 *
 * In process for the TTY arm, because a spawned child's stderr IS a pipe and there is no portable
 * way to hand it a pty — that arm would otherwise be untestable and therefore untested. The pipe
 * arm here is a SECOND witness only; `compileSpawned` above is the one that can fail.
 *
 * Three modes, and the distinctions are the ones that were being missed:
 *   - `"pipe"` DELETES `isTTY` and gives `columns` a NUMBER. A real pipe has no own `isTTY` at
 *     all, so the old `isTTY = false` tested a state that never occurs and left
 *     `isTTY === undefined` unexamined; and with `columns` also undefined, the `columns` guard
 *     rather than the `isTTY` guard could have been what carried the arm. A number there leaves
 *     `isTTY` as the only thing that can decide it.
 *   - a NUMBER is a terminal of that width.
 *   - `"tty-without-columns"` is `isTTY` true with no `columns` — the conservative no-wrap case.
 *
 * `isTTY` and `columns` are restored in the `finally`, and defined INSIDE the `try` — outside it, a
 * throw from `defineProperty` would leave both streams monkeypatched for the rest of the file.
 */
async function compileCapturing(dir: string, tty: number | "pipe" | "tty-without-columns"): Promise<readonly string[]> {
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
  // `compiled` rather than `assert.fail` inside the `try`: the AssertionError would be thrown INTO
  // the bare `catch` below and swallowed, leaving a guard that can never fire.
  let compiled = false;
  try {
    if (tty === "pipe") delete (process.stderr as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true, writable: true });
    if (tty === "tty-without-columns") delete (process.stderr as { columns?: number }).columns;
    else Object.defineProperty(process.stderr, "columns", { value: tty === "pipe" ? 80 : tty, configurable: true, writable: true });
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

/** THE CLAUSE AN OPERATOR GREPS FOR — one string, spanning a wrap point at every width tried. */
const GREPPED = 'ADD to whatever "gather" already declares: one join can be the barrier for more than one fan-out';

test("IN A REAL PIPE THE fix: LINE IS ONE LINE OF 852 BYTES — spawned, because this is the claim the row rests on", async () => {
  // THE TEST THAT CAN FAIL. Its in-process sibling below is a second witness; this one runs the
  // binary in a child process whose stderr is a real pipe — `isTTY` absent, `columns` absent —
  // which is the state an operator's `2>&1 | grep` actually produces and the one an in-process
  // `isTTY = false` never reproduced. Two mutations were green before it existed: deleting the
  // stream condition, and `if (process.stderr.isTTY === undefined) return 80`.
  const w = workspace();
  try {
    const r = await compileSpawned(w.dir);
    assert.notEqual(r.code, 0, `the eto graph must not compile:\n${r.out}${r.err}`);
    const fix = r.err.split("\n").filter((l) => l.startsWith("   fix: "));
    assert.equal(fix.length, 1, `exactly one fix: line, unwrapped:\n${r.err}`);
    assert.equal(Buffer.byteLength(fix[0]!, "utf8"), 852, `the measured length, unchanged by this row:\n${fix[0]}`);
    // The whole point of not wrapping here: `grep` still finds the clause as ONE string.
    assert.equal(
      r.err.split("\n").filter((l) => l.includes(GREPPED)).length,
      1,
      `grep -c of the clause must be 1 — a wrapped line is not greppable, which is the cost §H.14 priced:\n${r.err}`,
    );
    const message = r.err.split("\n").filter((l) => l.startsWith("✗ "));
    assert.equal(message.length, 1, "and the message line likewise");
    assert.equal(Buffer.byteLength(message[0]!, "utf8"), 206);
  } finally {
    w.dispose();
  }
});

test("IN A PIPE THE fix: LINE IS STILL ONE LINE — the in-process witness, with `isTTY` absent and `columns` a number", async () => {
  const w = workspace();
  try {
    const lines = await compileCapturing(w.dir, "pipe");
    const fix = lines.filter((l) => l.startsWith("   fix: "));
    assert.equal(fix.length, 1, `exactly one fix: line, unwrapped:\n${lines.join("\n")}`);
    assert.equal(Buffer.byteLength(fix[0]!, "utf8"), 852, "the measured length, unchanged by this row");
    assert.ok(fix[0]!.includes(GREPPED));
    const message = lines.filter((l) => l.startsWith("✗ "));
    assert.equal(message.length, 1, "and the message line likewise");
    assert.equal(Buffer.byteLength(message[0]!, "utf8"), 206);
  } finally {
    w.dispose();
  }
});

test("A TERMINAL THAT CANNOT REPORT ITS WIDTH DOES NOT WRAP — the conservative arm, not an oversight", async () => {
  // `isTTY` true, `columns` absent. Guessing 80 would hard-wrap a paragraph at a width nobody
  // measured; not wrapping restores exactly what every release before §H.14 did.
  const w = workspace();
  try {
    const lines = await compileCapturing(w.dir, "tty-without-columns");
    const fix = lines.filter((l) => l.startsWith("   fix: "));
    assert.equal(fix.length, 1, lines.join("\n"));
    assert.equal(Buffer.byteLength(fix[0]!, "utf8"), 852, "unwrapped, exactly as in a pipe");
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

// ── the terminal is where a hostile string gets rendered ─────────────────────

/** A workspace whose graph file is named by the caller — the operator-visible string a stranger picks. */
function workspaceNamed(name: string): { dir: string; file: string; dispose: () => void } {
  const w = workspace();
  const file = join(w.dir, "graphs", name);
  writeFileSync(file, JSON.stringify(ETO));
  return { dir: w.dir, file, dispose: w.dispose };
}

/**
 * `compileCapturing` for a named file, returning the raw stderr rather than split rows.
 *
 * The `catch` is bare and does NOT re-assert that the compile failed, unlike its sibling: every
 * caller below asserts `GRAPH021_FANOUT_WITHOUT_JOIN` is in what came back, and that string can
 * only be there because the compile refused. A graph that started compiling would produce no
 * diagnostics and fail those assertions with the whole captured output in the message. The guard
 * is added anyway rather than argued for in a comment — the argument is one indirection long, and
 * the next person to add a caller here should not have to reconstruct it.
 */
async function compileNamed(dir: string, file: string, tty: number | "pipe"): Promise<string> {
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
  let compiled = false;
  try {
    if (tty === "pipe") delete (process.stderr as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true, writable: true });
    Object.defineProperty(process.stderr, "columns", { value: tty === "pipe" ? 80 : tty, configurable: true, writable: true });
    await main(["compile", file, "--workspace", dir]);
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
  return captured.join("");
}

/**
 * THE SAME CLASS `cli.ts` DECLARES, read off its source rather than re-typed.
 *
 * Two copies of a character class drift, and the drift is silent in the direction that matters —
 * a test that strips less than the code does passes while the code has stopped stripping. So the
 * string is compared against `cli.ts`'s own `SPOOFING_CLASS` in the test below, and this file
 * fails if the two ever part.
 *
 * Built by concatenation rather than written as a regex literal, because an escape written into
 * this file becomes the CHARACTER it denotes — which is how an unterminated string constant got
 * here once already.
 */
const SPOOFING_CLASS = "\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069";
const SPOOFING_ANY = new RegExp("[" + SPOOFING_CLASS + "]");
const SPOOFING_BUT_WHITESPACE = new RegExp("(?![\\t\\n])[" + SPOOFING_CLASS + "]");

const CR = String.fromCharCode(0x0d);
const ESC = String.fromCharCode(0x1b);
const RLO = String.fromCharCode(0x202e);

test("THE CLASS THIS FILE ASSERTS ON IS THE CLASS `cli.ts` DECLARES — two copies would drift silently", () => {
  // A test that strips less than the code does passes while the code has stopped stripping, so the
  // string above is checked against the source's own, read off disk rather than imported: the
  // constants are module-private, and making them public to test them would be the wrong trade.
  const src = readFileSync(fileURLToPath(new URL("../../src/cli.ts", import.meta.url)), "utf8");
  const declared = /const SPOOFING_CLASS = ("[^"]+");/.exec(src);
  assert.ok(declared !== null, "cli.ts must still declare SPOOFING_CLASS as a single string literal");
  // `JSON.parse` on the whole literal, not the capture: the file holds SOURCE text (`\\u0000`) and
  // this file's constant holds the RUNTIME value (a backslash then u0000). Comparing the two
  // directly compares different levels of escaping and fails on a pair that agrees.
  assert.equal(
    JSON.parse(declared[1]!) as string,
    SPOOFING_CLASS,
    "the two copies have parted — reconcile before trusting the assertions below",
  );

  // AND THE EXEMPTION LIST, which is the half that can go wrong QUIETLY. Pinning only the class
  // leaves `(?![\t\n])` free to become `(?![\t\n\r])` — or to disappear — with every assertion in
  // this file still green: the class test above would pass, the CR test below would pass on a
  // narrowed exemption, and a WIDENED one would simply stop stripping something. The exemption is
  // the security-relevant half, so it is pinned as text.
  const exempt = /const SPOOFING_BUT_WHITESPACE = new RegExp\(`\(\?!\[([^\]]*)\]\)\[\$\{SPOOFING_CLASS\}\]`, "g"\);/.exec(src);
  assert.ok(exempt !== null, "cli.ts must still build SPOOFING_BUT_WHITESPACE as a lookahead over SPOOFING_CLASS");
  assert.equal(exempt[1], "\\\\t\\\\n", "only TAB and NEWLINE are exempt — the wrapper owns those two and no others");
});

test("A CARRIAGE RETURN, AN ESCAPE OR A BIDI OVERRIDE IN A FILE NAME CANNOT FORGE A LINE ON THE TERMINAL", async () => {
  // `loadGraph` interpolates the file name UNQUOTED, and a file name is chosen by whoever can
  // write the directory. `legible()`'s docstring has named this threat for one caller since before
  // the diagnostic printer had a terminal to render into — control characters "let a broken — or
  // hostile — collector rewrite or hide that line with ANSI escapes". `writeDiagnostic` is now
  // that place too, so the TTY path strips the same set less TAB and NEWLINE.
  for (const [label, name] of [
    ["carriage return", `a${CR}b.json`],
    ["ANSI escape", `a${ESC}[2Kb.json`],
    ["right-to-left override", `a${RLO}b.json`],
  ] as const) {
    const w = workspaceNamed(name);
    try {
      const rendered = await compileNamed(w.dir, w.file, 100);
      assert.doesNotMatch(
        rendered,
        SPOOFING_BUT_WHITESPACE,
        `${label} survived to the terminal: ${JSON.stringify(rendered.slice(0, 240))}`,
      );
      assert.ok(rendered.includes("GRAPH021_FANOUT_WITHOUT_JOIN"), "and the diagnostic is still the diagnostic");
      // TAB AND NEWLINE ARE THE EXEMPTIONS, and they are exempt because the wrapper already owns
      // them: it breaks at a tab and re-indents after a newline, so neither can start a row at
      // column 0 and forge a `✗ `.
      for (const row of rendered.split("\n").slice(1)) {
        if (row !== "") assert.doesNotMatch(row, /^[✗!] /, `no continuation may look like a new diagnostic: ${JSON.stringify(row)}`);
      }

      // THE PIPE IS DELIBERATELY UNCHANGED — byte-identical to every release before §H.14, which
      // is the claim the whole row rests on. This asserts the residue, so nobody reads the TTY
      // arm above as having closed it.
      const piped = await compileNamed(w.dir, w.file, "pipe");
      assert.match(piped, SPOOFING_ANY, `the pipe keeps the bytes it always kept (${label})`);
    } finally {
      w.dispose();
    }
  }
});

test("ONE QUOTE IN A FILE NAME PAIRS WITH THE MESSAGE'S OWN NEXT QUOTE, and that OVERFLOWS rather than fails", async () => {
  // The docstring says "AN unbalanced quote is an ordinary character", not "any number of them",
  // and this is the measurement behind that word. Quotes PAIR: one `"` in a name closes against
  // the message's next `"`, gluing everything between into a single token, which the wrapper then
  // refuses to split. A row over the width is the DESIGNED answer — the alternative is cutting an
  // identifier the author has to copy — so this is pinned as an OVERFLOW, not as a defect.
  const w = workspaceNamed('a"b.json');
  try {
    const rows = (await compileNamed(w.dir, w.file, 60)).split("\n").filter((l) => l !== "");
    const over = rows.filter((r) => r.length > 60);
    assert.ok(over.length > 0, `the pairing must still produce an over-long row, or this stopped measuring anything:\n${rows.join("\n")}`);
    for (const r of over) assert.ok(r.includes('"'), `every over-long row is one glued quoted span: ${JSON.stringify(r)}`);
    // And nothing is lost: the diagnostic still says what it says, and the name is still whole.
    assert.ok(rows.join(" ").includes("GRAPH021_FANOUT_WITHOUT_JOIN"));
    assert.ok(rows.some((r) => r.includes('a"b.json')), `the file name is not split: ${rows.join("\n")}`);
  } finally {
    w.dispose();
  }
});
