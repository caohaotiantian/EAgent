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
 * ## And the arm that MUST fire, which nothing here used to reach
 *
 * `driveToRest` keeps a second bound, `MAX_STALLED_ADVANCES`, for the opposite shape: a run that
 * is `running` with a retry pending and appends NOTHING when advanced. That is not a slow run,
 * it is a run this process cannot move, and looping on it forever is the hang the CLI must never
 * become. The test above drives only the arm that must not fire, so the backstop was pinned by
 * nothing at all: replacing `stalled = p.seq > before ? 0 : stalled + 1` with `stalled = 0` — so
 * the counter can never reach its ceiling and the give-up is dead code — left every test in the
 * repository green, 2825 of them.
 *
 * IT IS UNREACHABLE THROUGH THE CLI, which is why the second test below calls `driveToRest`
 * directly with a stub engine instead of building a graph. There is no `function` body, no
 * retry policy and no argv that makes a real `Engine.advance` return `running` with a pending
 * `retryAfter` and no journal write: the engine either appends something or stops handing back
 * that shape. Driving it needs an `advance` that lies, and that is a parameter rather than a
 * fork because `driveToRest` takes the workspace — the same coupling `serveUntilInterrupt`
 * documents for a `close()` that rejects.
 *
 * OFFLINE AND DETERMINISTIC: a `function` node, no model, no socket. It reads a clock only in the
 * sense that the backoff is real time — 69 × 30 ms — and asserts on no duration. The second test
 * reads one too, for a `retryAfter` two milliseconds out, and asserts on no duration either: what
 * it counts is ADVANCES.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { driveToRest, main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { isEvent, type JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";
import type { RunProjection } from "../../src/run/projection.ts";

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

// ── the other bound: a run this process cannot move ──────────────────────────

/**
 * `MAX_STALLED_ADVANCES`, read out of the source rather than restated here.
 *
 * The assertion below is "exactly this many advances", so a copy of the number would turn a
 * changed ceiling into a red test about the wrong thing — and, worse, a number nudged to match
 * a regression would read as a legitimate edit. `KNOWN_FLAGS` is held to the same rule two
 * directories over, for the same reason.
 */
const MAX_STALLED_ADVANCES = ((): number => {
  const src = readFileSync(fileURLToPath(new URL("../../src/cli.ts", import.meta.url)), "utf8");
  const m = /const MAX_STALLED_ADVANCES = (\d+);/.exec(src);
  assert.ok(m, "MAX_STALLED_ADVANCES moved or was renamed — this test reads it from the source on purpose");
  return Number(m[1]!);
})();

/**
 * A projection in the ONE shape that makes `driveToRest` wait: `running`, with a `ready` task
 * carrying a `retryAfter`.
 *
 * CAST RATHER THAN BUILT WHOLE, and the cast is the honest move here rather than a shortcut.
 * `driveToRest` reads exactly three things off a projection — `status`, `tasks` and `seq` — and
 * a full `RunProjection` literal would put thirty fields in this file that the function under
 * test never looks at, every one of them a thing to keep in step with a type for no reason. If
 * a fourth field is ever read, this stub stops satisfying the loop and the test says so by
 * hanging into its own runaway guard rather than by passing quietly.
 */
function stalledAt(seq: number, wake: number): RunProjection {
  return {
    status: "running",
    seq,
    tasks: { "a@root#0": { state: "ready", retryAfter: wake } },
  } as unknown as RunProjection;
}

test("A RUN THAT APPENDS NOTHING IS GIVEN UP ON AFTER MAX_STALLED_ADVANCES, not looped on forever", async () => {
  // TWO MILLISECONDS OUT, once. The loop sleeps `wake - Date.now()` each lap, so the first lap
  // waits ~2 ms and every lap after it waits zero — the wake instant is fixed and already past.
  // Nothing below asserts on how long that took; the measurement is the ADVANCE COUNT.
  const wake = Date.now() + 2;
  // `seq` NEVER MOVES, which is the whole premise: the engine keeps answering, and every answer
  // says the journal is where it was. That is the state `stalled` counts.
  const FROZEN_SEQ = 41;
  const RUN = "01HF7Q9K2M3N4P5R6S7T8V9W0X" as RunId;

  let advances = 0;
  const ws = {
    engine: {
      advance: (runId: RunId): Promise<RunProjection> => {
        assert.equal(runId, RUN, "the loop must keep advancing the run it was given");
        advances++;
        // A RUNAWAY GUARD, so the mutation this test exists to catch goes RED instead of
        // hanging. `stalled = 0` makes the `while` unbounded, and a test that hangs under its
        // own mutation is worse than one that passes — `known-flags.test.ts` says the same
        // thing about driving refusals through `compile` rather than `serve`.
        assert.ok(advances <= MAX_STALLED_ADVANCES * 4, `driveToRest did not stop: ${advances} advances and counting`);
        return Promise.resolve(stalledAt(FROZEN_SEQ, wake));
      },
    },
  } as unknown as Parameters<typeof driveToRest>[0];

  const err: string[] = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string) => (err.push(String(c)), true)) as typeof process.stderr.write;
  let p: RunProjection;
  try {
    p = await driveToRest(ws, RUN, stalledAt(FROZEN_SEQ, wake));
  } finally {
    process.stderr.write = realErr;
  }

  // 1 · IT RETURNED. Reaching this line at all is the assertion — the loop's exit condition is
  // the only thing that can produce it, and `stalled = 0` produces nothing but more advances.
  //
  // 2 · EXACTLY THE CEILING, neither more nor fewer. `stalled` starts at 0 and rises by one per
  // lap that appends nothing, so the ceiling is hit on the Nth advance and not the N+1th; an
  // off-by-one in either direction is a different number here.
  assert.equal(advances, MAX_STALLED_ADVANCES, `the backstop fired after ${advances} advances, not ${MAX_STALLED_ADVANCES}`);

  // 3 · AND IT SAID SO. Handing back a `running` run in silence is the outcome that made §A.13
  // a bug in the first place: the operator sees `"status": "running"` and no reason for it.
  assert.match(
    err.join(""),
    new RegExp(`^! run ${RUN} appended nothing to its journal across ${MAX_STALLED_ADVANCES} advances while a retry was pending`),
    `the give-up was silent: ${JSON.stringify(err.join(""))}`,
  );

  // 4 · The projection handed back is the last one the engine gave, unchanged — this loop
  // reports, it does not decide. `loom run`'s exit code is computed from the status downstream.
  assert.equal(p.status, "running");
  assert.equal(p.seq, FROZEN_SEQ);
});
