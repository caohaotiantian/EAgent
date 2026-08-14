/**
 * `advance` is serialized per run.
 *
 * `#serialize` orders journal APPENDS. It is not an execution lock, and nothing else
 * guarded entry — so two concurrent `advance` calls on one run projected the same state,
 * saw the same ready Tasks, and dispatched every one of them twice. Both were appending
 * legal events in a legal order, so no conflict was ever raised; the run simply did its
 * work twice, paid model calls and irreversible tool bodies included.
 *
 * Both callers are reachable from shipped HTTP routes, so this needs no adversary and no
 * unusual graph.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";
import { compileSkeleton, DOCS, harness } from "./skeleton.ts";

async function events(store: { read(r: RunId, f: number): AsyncIterable<JournalEvent> }, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

test("TWO CONCURRENT ADVANCES DO NOT EXECUTE ANY TASK TWICE", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS.slice(0, 3) } });

  // The shape that ships: two callers driving the same run at once.
  await Promise.all([h.engine.advance(runId), h.engine.advance(runId)]);

  const log = await events(h.store, runId);
  const started = log.filter((e) => e.type === "task.started").map((e) => e.taskId);
  const distinct = new Set(started);

  assert.equal(
    started.length,
    distinct.size,
    `every Task must start once; these started twice: ${[...distinct]
      .filter((id) => started.filter((s) => s === id).length > 1)
      .join(", ")}`,
  );

  // The side effects are the point — a duplicated model call costs money and a
  // duplicated irreversible tool cannot be taken back.
  const reads = h.reads;
  assert.equal(
    reads.length,
    new Set(reads).size,
    `no file may be read twice for one Task: ${JSON.stringify(reads)}`,
  );
});

test("a second advance still drives the run forward rather than returning the first's answer", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS.slice(0, 2) } });

  // Serialized, not coalesced: the second caller wants the run advanced from wherever it
  // stands after the first, which is what makes chaining the right shape rather than
  // handing both callers one result.
  const first = await h.engine.advance(runId);
  const second = await h.engine.advance(runId);

  assert.ok(second.seq >= first.seq, "the later advance must not observe an older projection");
});
