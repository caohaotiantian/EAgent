/**
 * THE TESTS THIS PROJECT CANNOT WRITE ANYWHERE ELSE: restart, scale, and a second plane.
 *
 * Every other suite here is in-process, single-run and small-N — 2,105 of them, excellent
 * inside that boundary and blind outside it. The audit's structural finding is that every
 * surviving defect class lives outside it: a value that only a RESTART re-derives, a window
 * that only shows itself past `limit` runs, a set two call sites compute differently.
 *
 * So this directory is the instrument, and it is built out of three moves:
 *
 *   - **A REAL WORKSPACE ON DISK.** `openWorkspace` on a temp dir — the same function
 *     `bin/loom` calls — so the journal is the SQLite one, the graph index is the real
 *     `graphs/` directory, and the compiled graph hash is the one the product computes.
 *   - **A RESTART** is `close()` plus a second `openWorkspace` over the same directory: a new
 *     `Engine`, a new `HumanGateBroker`, a new SQLite handle, folding the same journal.
 *     WHAT THAT DOES NOT COVER, stated rather than implied: it is one OS process, so it
 *     cannot catch anything that lives in module state shared between the two planes, in the
 *     SQLite connection's own cache, or in an exit path (`process.on("exit")`, an unflushed
 *     WAL). A defect of that shape needs a spawned `bin/loom`, and this harness does not
 *     claim to be one.
 *   - **SCALE WITHOUT PATIENCE.** `fillRuns` appends run heads straight to the store. A
 *     window bug is about how many rows a listing has to choose between, and 201 real runs
 *     would buy the same coverage for a hundred times the wall clock. Filler runs hold one
 *     `run.submitted` each and never gate, which is exactly the traffic that pushes a gated
 *     run out of an unfiltered window.
 *
 * OFFLINE AND DETERMINISTIC, per CLAUDE.md, and the two places that could have broken it:
 * no channel is configured (delivery would be a webhook, i.e. the network), and no assertion
 * reads the wall clock — the sweep is driven at an instant DERIVED from the journaled raise.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openWorkspace, parseArgs } from "../../src/cli.ts";
import { newGateId, newRunId, type NodeId, type RunId } from "../../src/ids.ts";
import type { StateStore } from "../../src/journal/store.ts";

export type Plane = ReturnType<typeof openWorkspace>;

export interface Deployment {
  readonly dir: string;
  /** Boot a plane over this directory. Call it twice and you have restarted. */
  open(): Plane;
  dispose(): void;
}

export function deployment(): Deployment {
  const dir = mkdtempSync(join(tmpdir(), "loom-deployment-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  return {
    dir,
    // `serve` is the command whose clocks this directory exists to test; `openWorkspace`
    // reads flags only, so the verb is documentation.
    open: () => openWorkspace(parseArgs(["serve", "--workspace", dir])),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Put a graph where `discoverGraphs` and `graphsByHash` will find it after a restart. */
export function publishGraph(d: Deployment, name: string, spec: unknown): string {
  const file = join(d.dir, "graphs", `${name}.json`);
  writeFileSync(file, JSON.stringify(spec, null, 2));
  return file;
}

/**
 * `count` run heads, newer than `sinceTs`, that never raise a gate.
 *
 * Run ids are ULIDs, so a later timestamp sorts ABOVE an earlier one — which is what
 * `ORDER BY run_id DESC` reads, and therefore what a run has to be pushed out of.
 */
export async function fillRuns(store: StateStore, count: number, sinceTs: number): Promise<readonly RunId[]> {
  const ids: RunId[] = [];
  for (let i = 0; i < count; i++) {
    const ts = sinceTs + 1 + i;
    const runId = newRunId(ts);
    await store.append({
      runId,
      expectedSeq: 0,
      now: ts,
      events: [
        {
          type: "run.submitted",
          payload: {
            workflow: "filler",
            graphHash: "sha256:filler",
            inputs: {},
            idempotencyKey: `filler-${i}`,
            configDigest: "sha256:filler",
          },
          actor: { kind: "system", component: "deployment-harness" },
        },
      ],
    });
    ids.push(runId);
  }
  return ids;
}

/** Every event type on a run's journal, in order. The evidence most of these tests assert on. */
export async function journalTypes(store: StateStore, runId: RunId): Promise<readonly string[]> {
  const types: string[] = [];
  for await (const e of store.read(runId, 1)) types.push(e.type);
  return types;
}

/**
 * Run something that writes to the terminal without writing to the terminal.
 *
 * `main` is the door these tests drive on purpose — it is the product — and it prints a
 * run summary. Captured rather than suppressed: a failing test wants the output, and the
 * returned lines are what a test asserts on when the CLI's own words are the claim.
 */
export async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  (process.stdout as { write: unknown }).write = (chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  };
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    err += String(chunk);
    return true;
  };
  try {
    return { value: await fn(), out, err };
  } finally {
    (process.stdout as { write: unknown }).write = realOut;
    (process.stderr as { write: unknown }).write = realErr;
  }
}

/**
 * `count` run heads that HAVE raised a gate, newer than `sinceTs` — the traffic that pushes
 * an older gate out of `{ raisedAGate: true }`.
 *
 * `fillRuns` cannot do this job. Its runs never gate, so they never compete for a slot in the
 * gated listing, and a test built on them measures the FILTER rather than the window behind
 * it. The gate clock's window is 500 GATED runs (`GATE_CLOCK_LIMIT`); the only way past it is
 * more than 500 gates.
 *
 * The gate is journaled, not raised: `listRuns(_, { raisedAGate: true })` orders by
 * `MAX(ts)` over the `gate.raised` rows and nothing here needs a broker, a graph, or a
 * `DeliverySpec`. Both events carry `ts` explicitly, so the ordering these runs establish is
 * derived from `sinceTs` and never from the wall clock.
 */
export async function fillGatedRuns(store: StateStore, count: number, sinceTs: number): Promise<readonly RunId[]> {
  const ids: RunId[] = [];
  for (let i = 0; i < count; i++) {
    const ts = sinceTs + 1 + i;
    const runId = newRunId(ts);
    await store.append({
      runId,
      expectedSeq: 0,
      now: ts,
      events: [
        {
          type: "run.submitted",
          payload: {
            workflow: "gated-filler",
            graphHash: "sha256:gated-filler",
            inputs: {},
            idempotencyKey: `gated-filler-${i}`,
            configDigest: "sha256:gated-filler",
          },
          actor: { kind: "system", component: "deployment-harness" },
        },
        {
          type: "gate.raised",
          payload: {
            gateId: newGateId(ts),
            nodeId: "approve" as NodeId,
            policyRef: "oversight/ship@stable",
            contentDigest: "sha256:gated-filler",
          },
          actor: { kind: "system", component: "deployment-harness" },
        },
      ],
    });
    ids.push(runId);
  }
  return ids;
}
