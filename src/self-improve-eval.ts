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

import { createAgentHost } from "./host.js";
import { getTrajectory, runEvalDir } from "./extensions/evals.js";

async function main(): Promise<void> {
  const stagingCandidateDir = process.argv[2];
  const fixturesDir = process.argv[3];
  if (!stagingCandidateDir || !fixturesDir) {
    console.error("usage: self-improve-eval <candidateDir> <fixturesDir>");
    process.exit(1);
    return;
  }
  const { agent, host } = await createAgentHost({ discoverDirs: [stagingCandidateDir], provider: "mock" });
  const { passed, total } = await runEvalDir(fixturesDir, agent, () =>
    getTrajectory({ store: host.storeFor("evals") }),
  );
  console.log(`eval: ${passed}/${total} passed`);
  await host.dispose();
  process.exit(0);
}

main().catch(() => process.exit(1));
