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
 * Not named `*.test.ts` on purpose: `npm test` globs test files by that suffix, and a
 * fixture that ran itself as a test would hang the suite waiting to be killed.
 */

import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { compileSkeleton, DOCS, harness } from "./skeleton.ts";

/** Child -> parent. The parent kills on `gated`; every other message is a failure. */
export type FromChild =
  | { readonly kind: "gated"; readonly runId: string; readonly gateId: string }
  | { readonly kind: "failed"; readonly error: string };

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

  // Announced only after the append that raised the gate has returned, so the parent
  // never kills a process whose journal is still mid-write. The store is NOT closed.
  send({ kind: "gated", runId, gateId: gate.gateId });

  // Hold the process open with no timers and no work: an interval would be a
  // wall-clock dependence, and the live IPC channel already keeps the loop alive.
  process.on("message", () => undefined);
}

main().catch((e: unknown) => {
  send({ kind: "failed", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  process.exit(1);
});
