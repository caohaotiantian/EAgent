/**
 * `truncated: false` OVER CORRUPTED BYTES — the passing value for a case the guard could not see.
 *
 * `capture` did `stdout += slice.toString("utf8")` per chunk, and a pipe hands over 64 KiB at a
 * time with no regard for character boundaries. Any multi-byte sequence straddling one decodes as
 * two U+FFFD, one per side. Nothing was DROPPED, so `truncated` stayed `false` and told the caller
 * the output was complete while it was silently wrong — and the corruption is position-dependent,
 * so the same tool over the same bytes reproduces intermittently, which is a replay hazard for a
 * store that content-addresses every write.
 *
 * `truncated`'s documented contract is "am I looking at all of it?". Answering yes over mangled
 * data is the shape this brief calls a fail-open guard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSandboxed } from "../../src/sandbox/subprocess.ts";

const ac = (): AbortSignal => new AbortController().signal;
const NODE = process.execPath;
const jail = (): { dir: string; dispose: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "loom-utf8-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Two 3-byte characters, so a boundary can land at either of two offsets inside one. */
const CHAR = "世";
const REPEATS = 100_000; // 300 000 bytes — far under the 1 MiB default cap

test("a multi-byte character straddling a pipe-chunk boundary survives intact", async () => {
  const j = jail();
  try {
    const r = await runSandboxed(
      {
        command: NODE,
        args: ["-e", `process.stdout.write(${JSON.stringify(CHAR)}.repeat(${String(REPEATS)}))`],
        cwd: j.dir,
        timeoutMs: 30_000,
      },
      ac(),
    );
    assert.equal(r.code, 0);
    assert.equal(r.truncated, false, "nothing was dropped, so this really is the whole output");
    const bad = [...r.stdout].filter((c) => c === "�").length;
    assert.equal(bad, 0, `${String(bad)} replacement characters — one per chunk boundary that split a character`);
    assert.equal(r.stdout.length, REPEATS, "every character is present exactly once");
    assert.equal(r.stdout, CHAR.repeat(REPEATS), "and the bytes are the bytes the child wrote");
  } finally {
    j.dispose();
  }
});

test("...on stderr as well as stdout, and the two decoders do not share state", async () => {
  const j = jail();
  try {
    const r = await runSandboxed(
      {
        command: NODE,
        args: [
          "-e",
          `process.stdout.write("あ".repeat(${String(REPEATS)})); process.stderr.write("é".repeat(${String(REPEATS)}))`,
        ],
        cwd: j.dir,
        timeoutMs: 30_000,
      },
      ac(),
    );
    assert.equal(r.truncated, false);
    assert.equal(r.stdout, "あ".repeat(REPEATS));
    assert.equal(r.stderr, "é".repeat(REPEATS));
  } finally {
    j.dispose();
  }
});

test("the BYTE CAP still means bytes, and a cut mid-character is still reported truncated", async () => {
  const j = jail();
  try {
    // 3001 is deliberately not a multiple of 3, so the cap lands inside a character.
    const r = await runSandboxed(
      {
        command: NODE,
        args: ["-e", `process.stdout.write(${JSON.stringify(CHAR)}.repeat(10000))`],
        cwd: j.dir,
        timeoutMs: 30_000,
        maxOutputBytes: 3001,
      },
      ac(),
    );
    assert.equal(r.truncated, true, "output WAS dropped, and the caller must be told");
    // 3001 bytes is 1000 whole characters plus one dangling byte, which is genuinely
    // unrepresentable — one replacement character, not a silent 999 or a throw.
    assert.equal(r.stdout.slice(0, 1000), CHAR.repeat(1000));
    assert.ok(r.stdout.length <= 1001, `kept ${String(r.stdout.length)} characters from 3001 bytes`);
  } finally {
    j.dispose();
  }
});

test("the ORDINARY cases are unchanged — ASCII, empty output, and a non-zero exit", async () => {
  const j = jail();
  try {
    const r = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdout.write('hi'); process.stderr.write('warn')"], cwd: j.dir, timeoutMs: 10_000 },
      ac(),
    );
    assert.deepEqual([r.code, r.stdout, r.stderr, r.truncated], [0, "hi", "warn", false]);

    const empty = await runSandboxed({ command: NODE, args: ["-e", "process.exit(3)"], cwd: j.dir, timeoutMs: 10_000 }, ac());
    assert.deepEqual([empty.code, empty.stdout, empty.stderr, empty.truncated], [3, "", "", false]);
  } finally {
    j.dispose();
  }
});
