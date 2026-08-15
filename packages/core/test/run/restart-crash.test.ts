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
 * that raised the gate has returned AND after it has confirmed the crash-shaped file
 * is on disk, so the kill is ordered by a message rather than by a timer, and the
 * parent waits on `exit` rather than on a clock.
 *
 * ── the flake this file used to be, and why it mattered ──────────────────────
 *
 * This test failed roughly one full-suite run in three while passing 40 of 40 in
 * isolation. The cause was not scheduling, contention, a colliding temp path, or a
 * readiness race — it was that THE FIXTURE STOPPED MODELLING A CRASH ~52ms IN. The
 * child's `SqliteStateStore` became unreachable the moment its `main` returned, V8
 * finalised the `DatabaseSync`, and `sqlite3_close_v2()` checkpointed the log away and
 * unlinked `-wal`/`-shm` — while the child was still alive and unsignalled. Whether
 * this test passed came down to whether the parent's kill beat an idle-time GC, which
 * under full-suite load it sometimes did not.
 *
 * That makes the `-wal` assertion the opposite of the fragile part: it is the only
 * thing that noticed. Had it been demoted to a diagnostic, the file would have gone
 * green while quietly re-testing row 6 — a clean close, reopened — which is the one
 * claim this file exists to distinguish itself from. It is kept, and the mechanism it
 * caught now has a test of its own (the first one below) that pins reachability
 * directly instead of waiting to see whether a GC happens to fire.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GateId, RunId } from "../../src/ids.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { compileSkeleton, harness } from "./skeleton.ts";
import type { FromChild, ToChild } from "./restart-crash.child.ts";

const CHILD = join(import.meta.dirname, "restart-crash.child.ts");

/**
 * The child's next message, or a rejection if it dies before sending one.
 *
 * A child that crashes on startup would otherwise leave this test waiting forever,
 * which is the one way a durability test can be worse than no test at all.
 */
function nextMessage(child: ChildProcess): Promise<FromChild> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: unknown): void => {
      cleanup();
      resolve(raw as FromChild);
    };
    const onExit = (code: number | null, signal: string | null): void => {
      cleanup();
      reject(new Error(`child exited (code ${String(code)}, signal ${String(signal)}) with nothing left to say`));
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

test("A CRASHING PROCESS STILL HOLDS ITS JOURNAL OPEN — a GC may not close it on our behalf", async () => {
  // The fixture only models a crash for as long as its SQLite handle stays OPEN. Let
  // the handle become unreachable and V8 finalises it, `sqlite3_close_v2()` runs, the
  // write-ahead log is checkpointed into the database and `-wal`/`-shm` are unlinked —
  // a *clean close*, performed by a process we are about to SIGKILL. The kill then
  // proves nothing, because the file it leaves behind is the tidy one.
  //
  // So this pins reachability directly rather than waiting to see whether a GC happens
  // to fire: the child is given `--expose-gc` and told to collect, and it answers only
  // once a full GC and its finalisers have run. Message-ordered, no timers.
  const dir = mkdtempSync(join(tmpdir(), "loom-crash-gc-"));
  const path = join(dir, "journal.db");
  const child = fork(CHILD, [path], { execArgv: ["--expose-gc"], stdio: ["ignore", "ignore", "inherit", "ipc"] });

  try {
    const msg = await nextMessage(child);
    assert.equal(msg.kind, "gated", `the child failed before the gate: ${JSON.stringify(msg)}`);
    assert.ok(existsSync(`${path}-wal`), "precondition: a live writer has an uncheckpointed log on disk");

    child.send({ kind: "collect" } satisfies ToChild);
    const collected = await nextMessage(child);
    assert.equal(collected.kind, "collected", `the forced GC did not report back: ${JSON.stringify(collected)}`);

    assert.ok(
      existsSync(`${path}-wal`),
      `a GC closed the journal (dir holds: ${readdirSync(dir).join(", ")}), so this process has stopped modelling a ` +
        `crash — a SIGKILL now would leave the tidied file behind and the kill test would be asserting nothing`,
    );
    assert.ok(existsSync(`${path}-shm`), "same, via the shared-memory index");
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A GATE SURVIVES `kill -9` — asserted on a process that was actually killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-crash-"));
  const path = join(dir, "journal.db");
  // `execArgv: []` because this test runs under `node --test`; inheriting that flag
  // would make the child try to be a test runner instead of a run.
  const child = fork(CHILD, [path], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });

  try {
    const msg = await nextMessage(child);
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
    //
    // `readdirSync` is in the message because the one time this fired, the listing was
    // the whole diagnosis: `["journal.db"]` alone says the log was checkpointed away,
    // where a missing directory would have said something entirely different.
    const listing = (): string => readdirSync(dir).join(", ");
    assert.ok(
      existsSync(`${path}-wal`),
      `journal.db-wal is gone (dir holds: ${listing()}) — a tidy shutdown, not a crash`,
    );
    assert.ok(
      existsSync(`${path}-shm`),
      `journal.db-shm is gone (dir holds: ${listing()}) — a tidy shutdown, not a crash`,
    );

    // And the log still holds frames. A zero-length `-wal` would mean a checkpoint had
    // run and left the file behind, which existence alone cannot rule out. Measured
    // here, node v24.16.0 / darwin 25.6.0: `journal.db` 4096 bytes — the header page,
    // nothing else — against `journal.db-wal` at 1,297,832. The entire run is in the
    // log and none of it has reached the database, which is what a crash looks like.
    assert.ok(
      statSync(`${path}-wal`).size > 0,
      "the write-ahead log is empty, so it was checkpointed rather than crashed",
    );

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
