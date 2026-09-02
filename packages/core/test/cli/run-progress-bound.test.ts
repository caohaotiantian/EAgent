/**
 * `loom run` FINISHES A RUN THAT IS STILL MAKING PROGRESS, however many laps that takes.
 *
 * `driveToRest` used to stop after `MAX_BACKOFF_WAITS = 64` waits — a count of the CLI's own
 * laps, not of anything the run did. A node declaring `retry.maxAttempts: 70` is inside a bound
 * its AUTHOR wrote and the engine was honouring, and the CLI abandoned it on the 65th lap with
 * `! run … was still retrying after 64 waits`, printed `"status": "running"` and exited 1. The
 * same ceiling is reachable without any failure at all: a rate-limit deferral can be up to 60 s,
 * so 64 of them is a run given up on after an hour of waiting exactly as it was told to.
 * `TODO.md` §A.13 states the close condition as "the CLI waits on a journal predicate rather than
 * a wait count", and the predicate is `RunProjection.seq`: an advance that did not move it
 * appended nothing.
 *
 * ## What makes this test red rather than slow
 *
 * The graph below declares 70 attempts against a `function` body that returns `{ retry }` every
 * time, with a FIXED 30 ms backoff — so the run needs 69 waits, five more than the old ceiling,
 * and finishes in about two and a half seconds. The assertions are three, and the third is the
 * one that would survive a lazy fix:
 *
 *   1. stderr does not carry the "still retrying after N waits" line,
 *   2. the run reached a TERMINAL state rather than being handed back `running`,
 *   3. the journal contains more than 64 `task.retry_scheduled` events — so the run really did
 *      need more laps than the old bound allowed, and a fix that merely raised the constant to
 *      65 would leave this test measuring nothing.
 *
 * Measured on this workspace: 69 `task.retry_scheduled` events and 288 journal events for the
 * one run, in about 2.4 s.
 *
 * OFFLINE AND DETERMINISTIC: a `function` node, no model, no socket. It reads a clock only in the
 * sense that the backoff is real time — 69 × 30 ms — and asserts on no duration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { isEvent, type JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";

/** More than `MAX_BACKOFF_WAITS` was, so the old bound is genuinely crossed. */
const ATTEMPTS = 70;

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-a13-"));
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  // A BODY THAT ALWAYS ASKS TO BE RETRIED. `{ retry: … }` is the retryable outcome a provider
  // being busy produces, reached here with no provider.
  writeFileSync(join(dir, "resources", "function", "flaky.js"), `function (view) { return { retry: { reason: "provider busy" } }; }`);
  writeFileSync(
    join(dir, "g.json"),
    JSON.stringify({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "g", project: "a13", version: 1 },
      channels: { n: { reduce: "replace" } },
      inputs: [],
      outputs: ["n"],
      nodes: [
        {
          id: "a",
          type: "function",
          function: { ref: "function/flaky@stable" },
          reads: ["n"],
          writes: ["n"],
          retry: { maxAttempts: ATTEMPTS, backoff: "fixed", initialMs: 30, maxMs: 30 },
        },
      ],
      edges: [],
    }),
  );
  return dir;
}

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (err.push(String(c)), true)) as typeof process.stderr.write;
  try {
    return { code: await main(argv), out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/** How many times the engine scheduled a retry for this run, read back off the journal. */
async function retriesScheduled(dir: string, runId: RunId): Promise<number> {
  const ws = openWorkspace(parseArgs(["gates", "--workspace", dir]));
  try {
    let n = 0;
    for await (const e of ws.store.read(runId, 1) as AsyncIterable<JournalEvent>) {
      if (isEvent(e, "task.retry_scheduled")) n++;
    }
    return n;
  } finally {
    ws.close();
  }
}

test("A RUN INSIDE ITS DECLARED maxAttempts IS NOT ABANDONED FOR TAKING MORE THAN 64 LAPS", async () => {
  const dir = workspace();
  try {
    const r = await cli(["run", join(dir, "g.json"), "--workspace", dir]);

    // 1 · the CLI did not give up on its own count.
    assert.doesNotMatch(r.err, /still retrying after \d+ waits/, "the CLI counted its own laps instead of the run's progress");

    // 2 · and the run it hands back is finished. `failed` is the right end here: the body never
    // succeeds, so the node exhausts the 70 attempts its author allowed and the run fails for
    // the node's own reason — which is a verdict, where `running` was an abandonment.
    // MATCHED OUT OF THE CAPTURED STREAM RATHER THAN PARSED. Under `node --test` the runner
    // itself writes to `process.stdout` in a serialized frame format, and this capture sees those
    // bytes too — `JSON.parse` on the buffer got "Unexpected token" from the runner's own
    // traffic, not from the CLI's output. The two fields this test needs are unambiguous.
    const printed = /\{\n  "runId": "([0-9A-Z]+)",\n  "status": "([a-z_]+)"/.exec(r.out);
    assert.ok(printed, `\`loom run\` printed no run summary:\n${r.out}\n${r.err}`);
    assert.equal(printed[2], "failed", `\`loom run\` returned a non-terminal run: ${printed[2]!}\n${r.err}`);
    assert.equal(r.code, 1, "a failed run is exit 1 — the run really did fail, it was not merely dropped");

    // 3 · THE CONTROL. Without this the test passes under a fix that only raised the constant:
    // the run must actually have needed more waits than the old ceiling of 64 allowed.
    const scheduled = await retriesScheduled(dir, printed[1]! as RunId);
    assert.ok(scheduled > 64, `the run only needed ${scheduled} retries, so it never crossed the old bound of 64`);
    assert.ok(scheduled < ATTEMPTS + 5, `${scheduled} retries for a node allowed ${ATTEMPTS} attempts — the policy stopped bounding it`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
