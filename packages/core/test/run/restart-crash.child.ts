/**
 * A child process that reaches a human gate and then dies without warning.
 *
 * Durable suspension across a restart is a shipped path — the multi-process decision
 * made it one — and every other "restart" test in this tree is `close()`-then-reopen
 * inside a single process. That is not the same event: a clean close checkpoints the
 * WAL into the database and removes `-wal`/`-shm`, which is precisely what a crash
 * does not do. Only a real `SIGKILL` leaves the file in the state a recovering
 * process actually finds.
 *
 * This half does the run. It opens the journal, advances the walking skeleton to its
 * gate, announces the run and gate ids over IPC, and then does nothing at all — the
 * parent kills it there. Nothing here closes the store, and nothing may: an orderly
 * shutdown is the condition under test being quietly removed.
 *
 * NOT CLOSING IT IS NOT ENOUGH — IT HAS TO STAY REACHABLE. See `HELD`.
 *
 * Not named `*.test.ts` on purpose: `npm test` globs test files by that suffix, and a
 * fixture that ran itself as a test would hang the suite waiting to be killed.
 */

import { existsSync } from "node:fs";

import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { compileSkeleton, DOCS, harness, type Harness } from "./skeleton.ts";

/**
 * Child -> parent. The parent kills on `gated`; `collected` answers a forced GC.
 * Anything else is a failure.
 */
export type FromChild =
  | { readonly kind: "gated"; readonly runId: string; readonly gateId: string }
  | { readonly kind: "collected" }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Parent -> child. `collect` runs a full GC and answers when its finalisers have run;
 * it is how the parent tests reachability without waiting on a clock.
 */
export type ToChild = { readonly kind: "collect" };

/**
 * The open journal, and the engine that owns it, pinned for the life of the process.
 *
 * REACHABILITY IS THE PROPERTY, not merely "we never called close()". Left as locals
 * of `main`, both become garbage the moment `main` returns — the IPC listener below
 * captures neither — and V8 then finalises the `DatabaseSync`. Its finaliser is
 * `sqlite3_close_v2()`, which checkpoints the write-ahead log into the database and
 * unlinks `-wal` and `-shm`: a *clean close*, carried out by a process the parent is
 * about to SIGKILL. The kill still happens, the signal is still SIGKILL, and the file
 * left behind is the tidy one — the exact event this fixture exists to not be.
 *
 * Measured on node v24.16.0 / darwin 25.6.0 with these two as locals: `-wal` and
 * `-shm` were gone 52ms after `gated` (3 of 3 runs), in a child that was still alive
 * and had not been signalled; pinning them here, both files were still on disk after
 * 6000ms (3 of 3). Under `--expose-gc` a single forced collection is enough. That is
 * how a suite-only flake was reaching the parent's `-wal` assertion: whether the test
 * passed came down to whether the parent's kill beat an idle-time GC by ~50ms, and
 * under full-suite load it sometimes did not.
 *
 * The listener reads this binding, so nothing can argue the reference away.
 */
let HELD: { readonly store: SqliteStateStore; readonly h: Harness } | undefined;

function send(msg: FromChild): void {
  process.send?.(msg);
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) {
    send({ kind: "failed", error: "no journal path given" });
    process.exit(2);
  }

  // FULL durability, which is what the assertion about `-wal` on disk is really
  // about: the gate must be on the platter before this process can be killed, not
  // in a buffer this process owns.
  const store = new SqliteStateStore({ path, synchronous: "full" });
  const h = harness({ store });
  HELD = { store, h };

  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);

  if (p.status !== "awaiting_gate") {
    send({ kind: "failed", error: `expected awaiting_gate, got ${p.status}` });
    process.exit(3);
  }
  const gate = Object.values(p.gates).find((g) => g.state === "open");
  if (gate === undefined) {
    send({ kind: "failed", error: "suspended with no open gate" });
    process.exit(4);
  }

  // The handoff is a fact this process has ESTABLISHED, not a hope the parent tests
  // after the kill. If the crash-shaped file is not on disk here, that is this half's
  // bug and it says so by name; the parent then never gets as far as killing anything.
  for (const suffix of ["-wal", "-shm"]) {
    if (!existsSync(`${path}${suffix}`)) {
      const error = `${path}${suffix} is not on disk, so this process is not modelling a crash yet`;
      send({ kind: "failed", error });
      process.exit(5);
    }
  }

  // Announced only after the append that raised the gate has returned, so the parent
  // never kills a process whose journal is still mid-write. The store is NOT closed.
  send({ kind: "gated", runId, gateId: gate.gateId });

  // Hold the process open with no timers and no work: an interval would be a
  // wall-clock dependence, and the live IPC channel already keeps the loop alive.
  process.on("message", (raw: unknown) => {
    if ((raw as ToChild | null)?.kind !== "collect") return;
    if (HELD === undefined) {
      send({ kind: "failed", error: "the journal handle was dropped before the parent could ask" });
      return;
    }
    const gc = (globalThis as unknown as { gc?: () => void }).gc;
    if (gc === undefined) {
      send({ kind: "failed", error: "child was not started with --expose-gc" });
      return;
    }
    // Twice, then once more after a turn: V8 may defer a weak callback to a task, so a
    // single mark-compact is not on its own proof that finalisers have run.
    gc();
    gc();
    setImmediate(() => {
      gc();
      send({ kind: "collected" });
    });
  });
}

main().catch((e: unknown) => {
  send({ kind: "failed", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  process.exit(1);
});
