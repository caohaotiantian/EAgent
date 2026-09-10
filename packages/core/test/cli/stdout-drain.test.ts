/**
 * THE PROCESS DOES NOT GO BEFORE ITS OUTPUT DOES.
 *
 * `main(...).then((code) => process.exit(code))` was correct for two of the three things stdout
 * can be and wrong for the third. To a TTY and to a file `process.stdout` is SYNCHRONOUS, so
 * every write has landed by the time the promise resolves. To a PIPE it is asynchronous: a
 * write larger than one pipe buffer hands back what it could not take, `process.exit` throws
 * the remainder away, and the process exits **0**. Measured on the CLI itself, before the fix,
 * on a run whose output channel holds 200,000 bytes:
 *
 *     loom run … > f ; wc -c < f    →   200201
 *     loom run … | wc -c            →    65536      ← exactly one pipe buffer
 *     loom run … | jq .status       →   parse error: Unfinished JSON term at EOF
 *
 * `jq` is the loud reader. `cat`, `tee`, `wc`, a shell `$(...)` capture and every log collector
 * are the quiet ones: they get a truncated document, the exit code says the command worked, and
 * nothing anywhere says otherwise.
 *
 * WHY THIS FILE SPAWNS A CHILD AND THE OTHER CLI SUITES DO NOT. Every other test in this
 * directory calls `main` in-process, which cannot see this defect at all — the entry-point
 * block at the bottom of `cli.ts` is the subject, and it only runs when the module IS the
 * program. So each case here is a real `node cli.ts …` with a real pipe on fd 1.
 *
 * AND THE SECOND HALF IS THAT IT STILL EXITS. The obvious fix — `process.exitCode = code`, let
 * the loop drain — makes exit conditional on every handle being torn down, and `loom serve`
 * holds four. The last two tests are the ones that would catch that: a command still exits, and
 * a failing command still exits NON-ZERO, both inside an absolute time bound.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_SRC = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/**
 * The value has to clear ONE PIPE BUFFER, which is 64 KiB on both macOS and Linux, and it has
 * to be big enough that a partial write is unmistakable rather than a rounding difference.
 * 200,000 bytes is three buffers and change.
 */
const BIG = "x".repeat(200_000);

/** One `fs.read` into an OUTPUT channel, so `loom run` prints the whole value on stdout. */
const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "big-output", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read"] },
  channels: {
    source: { type: "string", reduce: "replace" },
    body: { type: "string", reduce: "replace" },
  },
  inputs: ["source"],
  outputs: ["body"],
  nodes: [
    {
      id: "read",
      type: "tool",
      reads: ["source"],
      writes: ["body"],
      tool: { name: "fs.read", version: "1.0", args: { path: "${source}" } },
    },
  ],
  edges: [],
};

function workspace(): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-stdout-drain-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  const graphFile = join(dir, "graphs", "big.json");
  writeFileSync(graphFile, JSON.stringify(GRAPH));
  writeFileSync(join(dir, "input.txt"), BIG);
  return { dir, graphFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Piped {
  code: number;
  bytes: number;
  out: string;
  err: string;
  ms: number;
}

/**
 * `spawn` with `stdio: "pipe"` and NOT `execFile`, so fd 1 is a real pipe and the parent reads
 * it as one. `execFile` would do as well; `spawn` is used because the file-redirect case below
 * needs the same launcher with fd 1 swapped for an open file, and one launcher with one
 * argument is what keeps the two comparable.
 */
async function piped(argv: string[], stdout: "pipe" | number): Promise<Piped> {
  const began = Date.now();
  return await new Promise<Piped>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_SRC, ...argv], {
      cwd: dirname(CLI_SRC),
      stdio: ["ignore", stdout, "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const joined = Buffer.concat(out);
      resolve({
        code: code ?? 1,
        bytes: joined.byteLength,
        out: joined.toString("utf8"),
        err: Buffer.concat(err).toString("utf8"),
        ms: Date.now() - began,
      });
    });
  });
}

test("a stdout larger than one pipe buffer arrives WHOLE, and parses", async () => {
  const w = workspace();
  try {
    const argv = ["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })];
    const p = await piped(argv, "pipe");
    assert.equal(p.code, 0, p.err);

    // THE PRECONDITION, ASSERTED. A fixture that stopped producing more than 64 KiB would make
    // every assertion below pass on a defect that is still there.
    assert.ok(p.bytes > 64 * 1024, `the fixture must clear one pipe buffer, got ${String(p.bytes)} bytes`);

    // THE DEFECT'S SIGNATURE, named so a regression reads as itself rather than as "JSON broke".
    assert.notEqual(p.bytes, 65_536, "exactly one pipe buffer is what truncation looks like");

    const parsed = JSON.parse(p.out) as { status: string; outputs: Record<string, unknown> };
    assert.equal(parsed.status, "succeeded", p.out);
    assert.equal(parsed.outputs["body"], BIG, "the whole channel, not a prefix of it");
  } finally {
    w.dispose();
  }
});

test("the pipe and a file redirect produce the SAME byte count", async () => {
  // The row's own acceptance test, and it is the one that does not depend on the fixture's
  // size: whatever the command has to say, a pipe must not be a shorter version of it.
  const w = workspace();
  try {
    const argv = ["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })];
    const target = join(w.dir, "captured.json");
    const fd = openSync(target, "w");
    let toFile: Piped;
    try {
      toFile = await piped(argv, fd);
    } finally {
      closeSync(fd);
    }
    assert.equal(toFile.code, 0, toFile.err);

    const toPipe = await piped(argv, "pipe");
    assert.equal(toPipe.code, 0, toPipe.err);

    assert.equal(
      toPipe.bytes,
      statSync(target).size,
      "a pipe must deliver every byte a file redirect does — this is the whole row",
    );
  } finally {
    w.dispose();
  }
});

test("a command still EXITS, and a failing one still exits non-zero", async () => {
  // The guard on the fix rather than on the defect. Draining before `process.exit` keeps the
  // exit unconditional; the alternative — `process.exitCode` and let the loop empty — makes it
  // depend on every handle being closed, and this file's subject is a CLI that holds a SQLite
  // store open on nearly every verb.
  const w = workspace();
  try {
    // An absolute bound with an order-of-magnitude margin, not a ratio: a hung process is the
    // failure being excluded, and it fails this by never finishing rather than by being slow.
    const ok = await piped(["compile", w.graphFile, "--workspace", w.dir], "pipe");
    assert.equal(ok.code, 0, ok.err);
    assert.ok(ok.ms < 30_000, `compile took ${String(ok.ms)}ms — the process did not exit promptly`);

    const missing = await piped(["compile", join(w.dir, "graphs", "nope.json"), "--workspace", w.dir], "pipe");
    assert.notEqual(missing.code, 0, `a missing graph must not exit 0: ${missing.out}`);
    assert.ok(missing.ms < 30_000, `the refusal took ${String(missing.ms)}ms`);
    assert.match(missing.err, /\S/, "and it says why on stderr");
  } finally {
    w.dispose();
  }
});

test("A READER THAT STOPS READING IS STILL EXIT 0 AND STILL SILENT — the drain must not turn EPIPE into a crash", async () => {
  // THE REGRESSION THE FIRST DRAFT OF THE DRAIN SHIPPED, and the reason this file grew a
  // fourth case. Waiting for the write callback also waits for the tick in which a `Writable`
  // emits `'error'` for the same failed write, and nothing on `process.stdout` listens — so
  // `loom … | head` went from exit 0 with an empty stderr to a Node stack trace and exit 1.
  // `process.exit` used to pre-empt that tick; adding the drain added it.
  //
  // A CRASHING PIPE IS A WORSE DEFECT THAN A TRUNCATED ONE: it changes the status a shell
  // pipeline reads and it writes an unhandled-error dump into an operator's log, on the
  // ordinary shape `| head`, `| grep -q`, or a pager the reader quit.
  const w = workspace();
  try {
    const argv = ["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })];
    const result = await new Promise<{ code: number; err: string; ms: number }>((resolve, reject) => {
      const began = Date.now();
      const child = spawn(process.execPath, [CLI_SRC, ...argv], { cwd: dirname(CLI_SRC), stdio: ["ignore", "pipe", "pipe"] });
      const err: Buffer[] = [];
      child.stderr?.on("data", (c: Buffer) => err.push(c));
      // CLOSE THE READ END AFTER THE FIRST CHUNK, which is what `head -c 10` does. Destroying
      // it before any data would race the child's first write; after one chunk the child is
      // certainly mid-write, which is the case that fails.
      child.stdout?.once("data", () => child.stdout?.destroy());
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, err: Buffer.concat(err).toString("utf8"), ms: Date.now() - began }));
    });

    assert.equal(result.code, 0, `a reader that quit early must not change the exit status: ${result.err}`);
    assert.ok(!/Unhandled 'error' event/.test(result.err), `an unhandled error reached the operator:\n${result.err}`);
    assert.ok(!/EPIPE/.test(result.err), `EPIPE reached the operator:\n${result.err}`);
    assert.ok(result.ms < 30_000, `it took ${String(result.ms)}ms — the flush hung on a dead pipe`);
  } finally {
    w.dispose();
  }
});

test("the entry point is the subject — `main` in-process is untouched by this", async () => {
  // A note kept as a test so the next reader does not go looking for the drain inside `main`:
  // `--help` is the shortest path through the entry-point block, and it exits 0 with output.
  const helped = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, [CLI_SRC, "--help"], { cwd: dirname(CLI_SRC), timeout: 30_000 }, (e, stdout) => {
      resolve({ code: e === null ? 0 : ((e as NodeJS.ErrnoException & { code?: number }).code ?? 1), out: stdout });
    });
  });
  assert.equal(helped.code, 0);
  assert.match(helped.out, /loom/, helped.out);
});
