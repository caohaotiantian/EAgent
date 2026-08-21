/**
 * self-improve-integration — the one production path the offline suite stubs out.
 *
 * Every offline self-improve test injects a fake via `setEvaluator`; this drives
 * the REAL `realEvaluate` end-to-end: it copies `evals/` + symlinks node_modules
 * into an ephemeral staging dir, spawns a sandboxed `self-improve-eval` subprocess
 * twice (baseline + candidate), integrity-hashes the fixtures, and returns a
 * structured `EvalResult`. Heavy (two full agent runs in spawned sandboxes), so it
 * is double-gated: it runs only when an OS sandbox backend exists AND the opt-in
 * `EAGENT_SI_INTEGRATION` env is set. The default `npm test` therefore SKIPS it
 * (suite stays fast/offline); the `sandbox-linux` CI job sets the env and runs it
 * under real bwrap, and a dev can run it locally with the env set.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { binExists, detectBackend } from "../src/extensions/lib/sandbox.ts";
import { realEvaluate } from "../src/extensions/self-improve.ts";

const noBackend = detectBackend(process.platform, binExists) === "none";

test(
  "real evaluator: spawns sandboxed subprocesses and returns a well-formed EvalResult",
  { skip: noBackend || !process.env.EAGENT_SI_INTEGRATION },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "si-int-"));
    const candidate = join(dir, "candidate.ts");
    // Loadable, side-effect-free, and passes vetoCandidate.
    writeFileSync(candidate, "export default function activate(e) { return () => {}; }\n");
    try {
      const r = await realEvaluate(candidate);
      assert.ok(r && typeof r === "object", "returns an EvalResult object");
      assert.ok(Number.isFinite(r.baseline), "baseline is a finite number");
      assert.ok(Number.isFinite(r.candidate), "candidate is a finite number");
      assert.ok(Number.isFinite(r.delta), "delta is a finite number");
      assert.equal(r.tamper, false, "a clean run leaves the fixtures unchanged");
      assert.equal(typeof r.improved, "boolean", "improved is a boolean verdict");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
