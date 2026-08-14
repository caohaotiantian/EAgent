/**
 * A forked child that opens the SQLite journal, so the store's *startup* path can be
 * tested against real cross-process lock contention.
 *
 * The constructor is where a second worker process first touches a journal, and the
 * WAL conversion inside it needs a brief exclusive lock. Two `DatabaseSync` handles in
 * one process do contend at the SQLite layer, but they share one busy handler and one
 * event loop, so an in-process race is not the race a multi-process deployment runs.
 * Hence real processes.
 *
 * One file, two roles, because the roles have to agree on the message vocabulary:
 *   - `holder` pins a read lock on a rollback-mode database and releases only when
 *     told to, which makes anyone else's WAL conversion fail — deterministically, not
 *     by luck.
 *   - `opener` constructs the store on command and reports what happened. It announces
 *     `opening` on the same ordered IPC channel *before* it blocks, which is what lets
 *     the parent distinguish "failed instantly" from "waited".
 *
 * Not named *.test.ts on purpose: `npm test` globs `*.test.ts`, and this is a fixture.
 */

import { DatabaseSync } from "node:sqlite";

import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { SYSTEM_ACTOR } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";

/** Parent -> child. */
export type ToWorker =
  | { readonly kind: "hold"; readonly path: string }
  | { readonly kind: "release" }
  | { readonly kind: "open"; readonly id: number; readonly path: string }
  | { readonly kind: "stop" };

/** Child -> parent. */
export type FromWorker =
  | { readonly kind: "held" }
  | { readonly kind: "released" }
  | { readonly kind: "opening"; readonly id: number }
  | { readonly kind: "opened"; readonly id: number; readonly head: number }
  | { readonly kind: "failed"; readonly id: number; readonly error: string };

function send(msg: FromWorker): void {
  process.send?.(msg);
}

function holder(): void {
  let db: DatabaseSync | undefined;
  process.on("message", (raw: unknown) => {
    const msg = raw as ToWorker;
    if (msg.kind === "hold") {
      // A rollback-mode database with a row in it: the read transaction below takes a
      // SHARED lock, and SHARED is exactly what blocks another connection's upgrade to
      // the EXCLUSIVE lock that `journal_mode = WAL` needs.
      db = new DatabaseSync(msg.path);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("CREATE TABLE IF NOT EXISTS anchor (x INTEGER)");
      db.exec("INSERT INTO anchor (x) VALUES (1)");
      db.exec("BEGIN");
      db.prepare("SELECT x FROM anchor").all();
      send({ kind: "held" });
      return;
    }
    if (msg.kind === "release") {
      db?.exec("ROLLBACK");
      db?.close();
      db = undefined;
      send({ kind: "released" });
      return;
    }
    if (msg.kind === "stop") process.exit(0);
  });
}

function opener(): void {
  process.on("message", (raw: unknown) => {
    const msg = raw as ToWorker;
    if (msg.kind === "stop") process.exit(0);
    if (msg.kind !== "open") return;

    // Announced before the blocking call, on the same ordered channel as the result.
    // A store that dies instantly therefore has both messages in flight before the
    // parent can react to the first; a store that waits does not.
    send({ kind: "opening", id: msg.id });

    const run = "01JRUNWORKER00000000000000" as RunId;
    let store: SqliteStateStore | undefined;
    try {
      store = new SqliteStateStore({ path: msg.path });
      // Prove the handle is usable, not merely constructed: several workers appending
      // to one file is the whole point of the multi-process decision.
      store.append({
        runId: run,
        expectedSeq: 0,
        events: [{ type: "run.started", payload: { posture: "on" }, actor: SYSTEM_ACTOR("worker") }],
      }).then(
        () => {
          store?.close();
          send({ kind: "opened", id: msg.id, head: 1 });
        },
        (e: unknown) => {
          store?.close();
          // A losing CAS is a correct outcome here — several workers share one run id
          // in the fan-out case. Only a failure to *open* is the defect under test.
          const code = (e as { code?: string }).code ?? "";
          if (code === "E_SEQ_CONFLICT") send({ kind: "opened", id: msg.id, head: 0 });
          else send({ kind: "failed", id: msg.id, error: describe(e) });
        },
      );
    } catch (e) {
      store?.close();
      send({ kind: "failed", id: msg.id, error: describe(e) });
    }
  });
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

const role = process.argv[2];
if (role === "holder") holder();
else if (role === "opener") opener();
else {
  process.stderr.write(`open-worker: unknown role ${String(role)}\n`);
  process.exit(2);
}
