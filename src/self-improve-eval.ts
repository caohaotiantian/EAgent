/**
 * self-improve-eval — the candidate-loading eval runner spawned by the
 * self-improve harness's sandboxed evaluator.
 *
 * Unlike `eval-runner.ts` (which hardcodes `discoverDirs: []` and so would never
 * load a staged candidate), this entrypoint discovers the candidate from the
 * staging dir, runs the fixtures through it, and prints the `eval: X/Y passed`
 * scorecard the harness parses. It runs inside the harness's `no-network` sandbox
 * subprocess — never the live agent — and is the production-only path (offline
 * tests inject a stub evaluator instead).
 */

import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import { createAgentHost } from "./host.js";
import { getTrajectory, runEvalDir } from "./extensions/evals.js";

async function main(): Promise<void> {
  const stagingCandidateDir = process.argv[2];
  const fixturesDir = process.argv[3];
  // The staging root is the only path the harness's `no-network` sandbox makes
  // writable, so the file-backed store must live under it — the default
  // `~/.eagent/state` is denied, and the `evals` extension writes at activation.
  const stagingRoot = process.argv[4];
  if (!stagingCandidateDir || !fixturesDir || !stagingRoot) {
    console.error("usage: self-improve-eval <candidateDir> <fixturesDir> <stagingRoot>");
    process.exit(1);
  }
  const { agent, host } = await createAgentHost({
    discoverDirs: [stagingCandidateDir],
    provider: "mock",
    storeRoot: mkdtempSync(join(stagingRoot, "eval-store-")),
  });
  const { passed, total } = await runEvalDir(fixturesDir, agent, () =>
    getTrajectory({ store: host.storeFor("evals") }),
  );
  console.log(`eval: ${passed}/${total} passed`);
  await host.dispose();
  process.exit(0);
}

main().catch(() => process.exit(1));
