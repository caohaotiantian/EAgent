/**
 * The CLI entry guard and the headless argument surface.
 *
 * `entryShouldRun` decides whether importing `src/cli.ts` launches the whole
 * program. It has to be right for three different launch shapes — a direct
 * script path, an npm-installed bin (a SYMLINK, hence the `realpathSync`), and a
 * SEA binary where `argv[1]` is not a script path at all — and a regression means
 * a globally-installed `eagent` starts nothing. Its tests died with
 * `test/cli.test.ts`; this file restores them.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { entryShouldRun } from "../src/cli.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "src", "cli.ts");

test("entryShouldRun: a SEA binary always runs (argv[1] is not a script path there)", () => {
  assert.equal(entryShouldRun(undefined, "file:///anything", true), true);
  assert.equal(entryShouldRun("/not/a/script", "file:///anything", true), true);
});

test("entryShouldRun: a missing argv[1] does not launch", () => {
  assert.equal(entryShouldRun(undefined, import.meta.url, false), false);
});

test("entryShouldRun: the module launches when argv[1] resolves to it", () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(entryShouldRun(self, import.meta.url, false), true);
});

test("entryShouldRun: a different entry point does not launch it", () => {
  assert.equal(entryShouldRun(join(repoRoot, "src", "server.ts"), import.meta.url, false), false);
});

test("entryShouldRun: an unresolvable argv[1] returns false rather than throwing", () => {
  assert.equal(entryShouldRun(join(repoRoot, "does", "not", "exist.ts"), import.meta.url, false), false);
});

test("entryShouldRun: a SYMLINKED bin still launches (npm installs bins as symlinks)", () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-entry-"));
  try {
    const real = join(dir, "real.js");
    const link = join(dir, "linked.js");
    writeFileSync(real, "");
    symlinkSync(real, link);
    // argv[1] keeps the symlink path; import.meta.url is already realpathed by
    // Node. `real` itself needs realpathing too: on macOS tmpdir() is a symlink
    // (/var → /private/var), so the raw path would not match either.
    assert.equal(entryShouldRun(link, pathToFileURL(realpathSync(real)).href, false), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Run the CLI as a real subprocess and capture the streams separately. */
function runCli(args: string[], input = ""): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", cli, ...args], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, EAGENT_PROVIDER: "mock" },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("--eval stdout carries the answer and no escape sequence", () => {
  const { status, stdout } = runCli(["--eval", "hello", "--provider", "mock"]);

  assert.equal(status, 0);
  assert.match(stdout, /hello/, "the answer reached stdout");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(stdout, /\x1b\[/, "no ANSI or cursor byte on a machine stream");
});

test("--json emits only parseable JSONL on stdout, human echo diverted to stderr", () => {
  const { status, stdout } = runCli(["--json", "--provider", "mock"], "hi\n/help\n");

  assert.equal(status, 0);
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  assert.ok(lines.length > 0, "the JSONL stream is not empty");
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `stdout line is not JSON: ${line}`);
  }
});

test("an unknown flag fails; --help and --version succeed", () => {
  assert.equal(runCli(["--nope"]).status, 1, "unknown flag exits non-zero");
  assert.equal(runCli(["--help"]).status, 0);
  assert.match(runCli(["--version"]).stdout, /@eagent\/core \d/, "--version names the package it is");
});

test("a value-taking flag with no value fails instead of silently consuming the next flag", () => {
  const { status, stderr } = runCli(["--model", "--yolo"]);

  assert.equal(status, 1);
  assert.match(stderr, /requires a value/, "the failure names the cause");
});
