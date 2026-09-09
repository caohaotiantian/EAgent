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
  // `task.leased`, NOT `task.started`, AND THAT WAS THIS TEST'S OWN SILENT FALSE NEGATIVE.
  //
  // `task.started` WAS declared in `journal/events.ts` and appended by nothing — pinned as such
  // in `test/registries.test.ts`, decision `delete`, with this file named as what BLOCKED it.
  // That decision has since been executed: the member is gone from the vocabulary and the pin went
  // with it — that registry emptied and was replaced by a rule over the empty set. The
  // measurements below stay because the lesson is about the ASSERTION, not about the event.
  // So the filter matched zero events and the headline assertion below compared 0 to 0 on a
  // run that leases seven times. Measured before this line changed:
  //
  //     task.started count  : 0 -> distinct 0   ASSERTION COMPARES 0 to 0
  //     task.leased count   : 7 -> distinct 7
  //
  // A guard that compares 0 to 0 reports green under every mutation, and the mutation this file
  // exists for was run to say exactly how much that cost. `Engine.advance` short-circuited to
  // `#advanceSerially`, the chain gone:
  //
  //   - with `task.started`, THE HEADLINE ASSERTION PASSED and the failure came from the
  //     side-effect assertion below it — `no file may be read twice for one Task:
  //     ["doc-1.md","doc-0.md","doc-2.md","doc-1.md","doc-2.md"], 5 !== 3`.
  //   - with `task.leased`, the headline assertion is the one that fires:
  //     `these started twice: start@root#0#1, summarize@root/e0[1]#0#1,
  //     summarize@root/e0[2]#0#1, 10 !== 7`.
  //
  // So the file was never green under the mutation — it was green ON ITS OWN HEADLINE, carried
  // by its backup, and the backup is the assertion that depends on the skeleton graph reading
  // files. Change the skeleton to a graph with no tool call and the whole test goes vacuous.
  //
  // THE KEY IS `taskId#attempt`, NOT `taskId`, and the difference is a false positive rather
  // than a false negative. `#runWaveInner` appends `task.leased` with
  // `attempt: w.task.attempt + 1`, so a RETRY legitimately leases the same TaskId a second
  // time; keying on the id alone would call a retried task a double-dispatch. The pair is what
  // "this task started once" actually means, and it is the pair `journal/audit.ts`'s
  // `task.leased-once` already keys on for the same reason.
  const started = log
    .filter((e) => e.type === "task.leased")
    .map((e) => `${String(e.taskId)}#${String((e.payload as { attempt: number }).attempt)}`);
  const distinct = new Set(started);

  assert.ok(started.length > 0, "no task was leased at all — this run drove nothing and the assertion below would be vacuous");
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
