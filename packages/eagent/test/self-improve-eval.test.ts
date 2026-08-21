/**
 * self-improve-eval — the candidate-loading eval entrypoint the self-improve
 * harness spawns inside its `no-network` sandbox. The harness confines the
 * subprocess's writes to the ephemeral staging dir, so the entrypoint MUST point
 * its file-backed store under that staging root — not the default `~/.eagent/state`,
 * which lies outside the sandbox-writable subpaths and so is denied at runtime
 * (the `evals` extension writes its trajectory unconditionally at activation).
 *
 * This test runs the entrypoint unsandboxed with an isolated `HOME`, and asserts
 * the store lands under the staging dir and never under `HOME` — reproducing the
 * confinement contract without requiring a real OS sandbox backend.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = join(PROJECT_ROOT, "src", "self-improve-eval.ts");

test("self-improve-eval confines its store to the staging root, never $HOME", () => {
  const staging = mkdtempSync(join(tmpdir(), "eagent-si-eval-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "eagent-si-home-"));
  const candidateDir = join(staging, ".eagent", "extensions");
  const fixturesDir = join(staging, "evals");
  mkdirSync(candidateDir, { recursive: true });
  mkdirSync(fixturesDir, { recursive: true });

  const out = execFileSync(
    process.execPath,
    [ENTRYPOINT, candidateDir, fixturesDir, staging],
    { cwd: PROJECT_ROOT, env: { ...process.env, HOME: fakeHome }, encoding: "utf8" },
  );

  assert.match(out, /eval:\s*0\/0\s*passed/, "the entrypoint scores an empty fixtures dir as 0/0");

  // The bug's footprint: the default store root is `$HOME/.eagent/state`, which
  // the sandbox would deny. Nothing must be written there.
  assert.ok(
    !existsSync(join(fakeHome, ".eagent", "state")),
    "the eval subprocess must not write its store under $HOME",
  );

  // And the store must actually have been written — under the staging root.
  const entries = readdirSync(staging, { recursive: true }) as string[];
  assert.ok(
    entries.some((p) => p.endsWith("evals.json")),
    "the eval subprocess writes its store inside the sandbox-writable staging root",
  );
});
