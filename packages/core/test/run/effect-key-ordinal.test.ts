/**
 * Every tool call in a Task gets its own effect key.
 *
 * `#invokeTool`'s ordinal was the literal `0` at both call sites, so every tool call
 * inside an agent Task shared the key `<taskId>:tool:0`. `ReplayEffects` keys a `Map` by
 * that string, so `require()` served the LAST recorded result for all of them: a call
 * that recorded `effect.failed` replayed as a success, and `replayRun` reported `match`
 * while doing it. Invariant 3 says a derived id must be unique; a non-unique one breaks
 * replay exactly as a random one would.
 *
 * The ordinal is the call's index in the model's returned array, offset by earlier turns
 * — a function of the transcript rather than of dispatch order, so it survives intra-turn
 * calls being parallelised later.
 *
 * There is a second consequence beyond replay. D12.5 specifies the external idempotency
 * key as `${taskId}:call:${callOrdinal}`; at ordinal 0 two different tool calls present
 * one `Idempotency-Key` to an external system, and a payment provider would dedupe the
 * second charge against the first. That is not wired to `tool.execute` yet, and it is the
 * reason this had to be fixed before anything wires it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { ReplayEffects } from "../../src/run/replay.ts";
import { compileSkeleton, harness } from "./skeleton.ts";

async function events(store: { read(r: RunId, f: number): AsyncIterable<JournalEvent> }, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) out.push(e);
  return out;
}

async function runToCompletion(h: ReturnType<typeof harness>, runId: RunId): Promise<void> {
  let p = await h.engine.advance(runId);
  if (p.status === "awaiting_gate") {
    const gate = Object.values(p.gates).find((g) => g.state === "open")!;
    p = await h.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:alice", via: "console" },
      idempotencyKey: "k1",
    });
  }
}

function toolKeys(log: JournalEvent[]): string[] {
  return log
    .filter((e) => e.type === "effect.started" && (e.payload as { kind: string }).kind === "tool")
    .map((e) => (e.payload as { key: string }).key);
}

test("TWO TOOL CALLS IN ONE TURN GET TWO EFFECT KEYS", async () => {
  const h = harness({
    script: (req, turn) => {
      const path = (JSON.parse(req.messages[0]?.content ?? "{}") as { state?: { path?: string } }).state?.path ?? "?";
      if (turn === 0) {
        return {
          toolCalls: [
            { id: "c0", name: "fs.read", arguments: { path } },
            { id: "c1", name: "fs.read", arguments: { path: `OTHER-${path}` } },
          ],
          finishReason: "tool_use",
        };
      }
      return { text: JSON.stringify({ path, summary: `summary of ${path}` }), finishReason: "stop" };
    },
  });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: ["doc-0.md"] } });
  await runToCompletion(h, runId);

  const keys = toolKeys(await events(h.store, runId));
  assert.equal(new Set(keys).size, keys.length, `tool effect keys must be distinct: ${JSON.stringify(keys)}`);
});

test("...and so do two calls spread across two turns", async () => {
  const h = harness({
    script: (req, turn) => {
      const path = (JSON.parse(req.messages[0]?.content ?? "{}") as { state?: { path?: string } }).state?.path ?? "?";
      if (turn < 2) {
        return { toolCalls: [{ id: `c${String(turn)}`, name: "fs.read", arguments: { path: `t${String(turn)}-${path}` } }], finishReason: "tool_use" };
      }
      return { text: JSON.stringify({ path, summary: "s" }), finishReason: "stop" };
    },
  });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: ["doc-0.md"] } });
  await runToCompletion(h, runId);

  const keys = toolKeys(await events(h.store, runId));
  assert.equal(new Set(keys).size, keys.length, `keys must be distinct across turns: ${JSON.stringify(keys)}`);
});

test("replay serves each call its OWN recorded result", async () => {
  const h = harness({
    script: (req, turn) => {
      const path = (JSON.parse(req.messages[0]?.content ?? "{}") as { state?: { path?: string } }).state?.path ?? "?";
      if (turn === 0) {
        return {
          toolCalls: [
            { id: "c0", name: "fs.read", arguments: { path } },
            { id: "c1", name: "fs.read", arguments: { path: `OTHER-${path}` } },
          ],
          finishReason: "tool_use",
        };
      }
      return { text: JSON.stringify({ path, summary: `summary of ${path}` }), finishReason: "stop" };
    },
  });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: ["doc-0.md"] } });
  await runToCompletion(h, runId);

  const log = await events(h.store, runId);
  const eff = ReplayEffects.fromEvents(log);
  const keys = toolKeys(log).filter((k) => k.startsWith("summarize@"));
  assert.equal(keys.length, 2, "the agent made two tool calls");

  const served = keys.map((k) => JSON.stringify(eff.require(k).result));
  assert.equal(
    new Set(served).size,
    2,
    "each call must replay to its own result; one shared key served the last one to both",
  );
});
