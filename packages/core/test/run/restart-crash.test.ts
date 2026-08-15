/**
 * A gate that survives `kill -9`, asserted against a process that really was killed.
 *
 * `skeleton.test.ts` row 6 claims "a gate survives losing the process entirely" and
 * comments `// Simulate kill -9`, but what it does is `store.close()` and a second
 * Engine in the SAME process. Those are different events, and the difference is the
 * whole claim: a clean close checkpoints the write-ahead log into the database and
 * deletes `journal.db-wal` and `journal.db-shm`, so the second Engine reads a
 * tidied-up file that no crash would ever leave behind. Nothing in that test would
 * notice if durability depended on the shutdown path running.
 *
 * So: a real child process, a real `SIGKILL`, and — the assertion that separates this
 * from row 6 — `-wal` and `-shm` still on disk afterwards, proving the journal was
 * recovered from an unclean file rather than a checkpointed one.
 *
 * Deterministic by construction. The child announces `gated` only after the append
 * that raised the gate has returned, so the kill is ordered by a message rather than
 * by a timer, and the parent waits on `exit` rather than on a clock.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GateId, RunId } from "../../src/ids.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { compileSkeleton, harness } from "./skeleton.ts";
import type { FromChild } from "./restart-crash.child.ts";

const CHILD = join(import.meta.dirname, "restart-crash.child.ts");

/**
 * The child's first message, or a rejection if it dies before sending one.
 *
 * A child that crashes on startup would otherwise leave this test waiting forever,
 * which is the one way a durability test can be worse than no test at all.
 */
function firstMessage(child: ChildProcess): Promise<FromChild> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: unknown): void => {
      cleanup();
      resolve(raw as FromChild);
    };
    const onExit = (code: number | null, signal: string | null): void => {
      cleanup();
      reject(new Error(`child exited (code ${String(code)}, signal ${String(signal)}) before it reached the gate`));
    };
    const cleanup = (): void => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

/** Resolves with how the child died. */
function died(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

test("A GATE SURVIVES `kill -9` — asserted on a process that was actually killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-crash-"));
  const path = join(dir, "journal.db");
  // `execArgv: []` because this test runs under `node --test`; inheriting that flag
  // would make the child try to be a test runner instead of a run.
  const child = fork(CHILD, [path], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });

  try {
    const msg = await firstMessage(child);
    assert.equal(msg.kind, "gated", `the child failed before the gate: ${JSON.stringify(msg)}`);
    if (msg.kind !== "gated") return;

    // No shutdown hook, no flush, no chance to save anything — which is the point.
    const exit = died(child);
    child.kill("SIGKILL");
    const how = await exit;
    assert.equal(how.signal, "SIGKILL", "the process must have been killed, not asked to stop");

    // THE ASSERTION THAT DISTINGUISHES THIS FROM A CLEAN CLOSE. `close()` checkpoints
    // the write-ahead log and removes both of these; a killed process cannot. Their
    // presence is the proof that what follows recovers from a crashed file.
    assert.ok(existsSync(`${path}-wal`), "journal.db-wal is gone, so this was a tidy shutdown and not a crash");
    assert.ok(existsSync(`${path}-shm`), "journal.db-shm is gone, so this was a tidy shutdown and not a crash");

    // ── the recovering process ──
    const store = new SqliteStateStore({ path });
    try {
      const h = harness({ store });
      const graph = compileSkeleton();
      const runId = msg.runId as RunId;
      h.engine.attach(runId, graph);

      const recovered = await h.engine.projection(runId);
      assert.ok(recovered, "the run is readable at all");
      assert.equal(recovered.status, "awaiting_gate", "still suspended, with no recovery step of its own");
      assert.equal(
        recovered.gates[msg.gateId as GateId]?.state,
        "open",
        "and the SAME gate the dead process raised is still the open one",
      );
      assert.equal(h.writes.length, 0, "precondition: the deferred write has not happened in either process");

      const after = await h.engine.resolveGate(runId, {
        gateId: msg.gateId as GateId,
        decision: { kind: "approve" },
        actor: { kind: "human", subject: "u:bob", via: "console" },
        idempotencyKey: "k1",
      });

      assert.equal(after.status, "succeeded", JSON.stringify(after.error ?? {}));
      assert.equal(h.writes.length, 1, "the work behind the gate ran once, in the process that survived");
    } finally {
      store.close();
    }
  } finally {
    // Both in a `finally`: a regression here should cost a failed test, never a hung
    // suite and never a stray child holding a lock on a temp file.
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("…and a CLEAN close is the other outcome, which is why the -wal assertion is the point", async () => {
  // The control. Same store, same gate, closed properly: the write-ahead log is
  // checkpointed away. If `-wal` survived a clean close too, the assertion above
  // would be pinning nothing.
  const dir = mkdtempSync(join(tmpdir(), "loom-clean-"));
  const path = join(dir, "journal.db");
  try {
    const store = new SqliteStateStore({ path, synchronous: "full" });
    const h = harness({ store });
    const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: ["doc-0.md"] } });
    const p = await h.engine.advance(runId);
    assert.equal(p.status, "awaiting_gate", "precondition: the same suspension point");
    assert.ok(existsSync(`${path}-wal`), "precondition: the log exists while the connection is open");

    store.close();
    assert.equal(existsSync(`${path}-wal`), false, "a clean close checkpoints and removes the write-ahead log");
    assert.equal(existsSync(`${path}-shm`), false, "and its shared-memory index");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
