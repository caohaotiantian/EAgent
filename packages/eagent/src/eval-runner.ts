/**
 * Headless eval entrypoint — the CI gate.
 *
 * Drives the tested `/eval` runner (`runEvalDir`) over a fixtures dir without a
 * REPL, prints the same scorecard, and exits non-zero on any failure so a broken
 * scenario fails CI. Pins the mock provider and an ephemeral store so the gate is
 * deterministic regardless of the developer's env keys or persisted state, and
 * skips extension discovery so a local extension can't perturb the result.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentHost } from "./host.ts";
import { getTrajectory, runEvalDir } from "./extensions/evals.ts";

async function main(): Promise<void> {
  const { agent, host } = await createAgentHost({
    provider: "mock",
    storeRoot: mkdtempSync(join(tmpdir(), "eagent-eval-")),
    discoverDirs: [],
  });
  const { passed, total, failures } = await runEvalDir(process.argv[2] ?? "evals", agent, () =>
    getTrajectory({ store: host.storeFor("evals") }),
  );
  console.log(`eval: ${passed}/${total} passed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  await host.dispose();
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
