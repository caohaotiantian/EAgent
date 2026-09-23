/**
 * An AGENT is told when a tool handed it a cut-short result — in its transcript, and only there.
 *
 * `TODO.md` §A.83 took the truncation marker out of `ToolResult.content` (`DESIGN.md` D8), because
 * `content` is what a `tool` node writes to a channel and a marker there read as a corrupt file.
 * But `content` is also the whole of what an agent's model was shown of a tool result, so the
 * review measured the cost: the model read `"AAAAAAAAAAAAAAAAAAAA"` with no sign it was a prefix,
 * where the base build had shown `…[truncated 48 chars]`. `modelToolContent` (`run/engine.ts`)
 * adds the note to the TOOL MESSAGE, from the result's `details`; this file asserts on the message
 * the adapter actually receives, that the journaled result stays marker-free, and that a replay —
 * which rebuilds the transcript from the journal — still matches.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinTools } from "../../src/builtin/tools.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

/** One agent node that makes ONE tool call, then answers; returns what the model saw of it. */
async function agentCalls(
  root: string,
  tool: string,
  args: Record<string, unknown>,
  extra: { egressAllowlist?: readonly string[]; fetch?: typeof fetch } = {},
): Promise<{ toolMessage: string; events: JournalEvent[]; replayMatch: boolean }> {
  const store = new MemoryStateStore({ now: () => NOW });
  const tools = new ToolRegistry();
  for (const t of builtinTools({ root, deny: [], ...extra })) if (t.name === tool) tools.register(t);
  const model = new MockModelAdapter({
    pricePerMTok: 1,
    script: (_req, turn) =>
      turn === 0 ? { toolCalls: [{ id: "c0", name: tool, arguments: args }], finishReason: "tool_use" } : { text: "done", finishReason: "stop" },
  });
  const models = new ModelRegistry();
  models.register(model, true);
  const functions = new FunctionRegistry();
  const capability = tool === "net.fetch" ? "net:fetch" : "fs:read";
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models,
    now: () => NOW,
    sleep: async () => {},
    resolver: resolver(),
    policy: { granted: [capability], systemFloor: "out", budget: { runUsd: 5 } },
  });
  const spec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "agent-trunc", project: "t", version: 1 },
    policy: { posture: "out", capabilities: [capability], budget: { costUsd: 5 } },
    channels: { result: { type: "string", reduce: "replace" } },
    inputs: [],
    outputs: ["result"],
    nodes: [{ id: "a", type: "agent", writes: ["result"], agent: { profile: "agent_profile/a@stable", prompt: "prompt/p@v1", maxTurns: 3, tools: [tool] } }],
    edges: [],
  } as unknown as GraphSpec;
  const graph = compileOrThrow({ spec, resolver: resolver(), tools: Object.fromEntries(tools.list().map((t) => [t.name, t])), tenantCapabilities: [capability] });
  const runId = await engine.submit({ graph, inputs: {} });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  const last = model.seen.at(-1)!;
  const toolMessage = String(last.messages.find((m) => m.role === "tool")?.content);
  const events: JournalEvent[] = [];
  for await (const e of store.read(runId, 1 as Seq)) events.push(e);
  const report = await replayRun({ store, runId, graph, engine: { tools, functions, models } });
  return { toolMessage, events, replayMatch: report.match };
}

const recordedContent = (events: readonly JournalEvent[]): string => {
  const done = events.find((e) => e.type === "effect.completed" && (e.payload as { key: string }).key === "a@root#0:tool:0");
  return String((done?.payload as { result: { content: string } }).result.content);
};

test("an agent reading an over-cap file is TOLD it got a prefix — shown and total bytes — and the journal holds none of it", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-agent-trunc-"));
  try {
    writeFileSync(join(root, "big.txt"), `${"A".repeat(50)}SECRET-TAIL-CLAUSE`);
    const r = await agentCalls(root, "fs.read", { path: "big.txt", maxBytes: 20 });
    assert.equal(r.toolMessage, `${"A".repeat(20)}\n[truncated by the tool: 20 of 68 bytes shown; the rest was not returned]`);
    // The RESULT is marker-free: the note is the transcript's, derived from `details`.
    assert.equal(recordedContent(r.events), "A".repeat(20));
    // And a replay, which rebuilds the transcript from the journal, derives the same message.
    assert.equal(r.replayMatch, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a COMPLETE read gets no note — the message is exactly the content", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-agent-trunc-"));
  try {
    writeFileSync(join(root, "small.txt"), "whole");
    const r = await agentCalls(root, "fs.read", { path: "small.txt" });
    assert.equal(r.toolMessage, "whole");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("net.fetch past maxBytes: the agent is told too", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-agent-trunc-"));
  try {
    const r = await agentCalls(
      root,
      "net.fetch",
      { url: "https://example.com/x", maxBytes: 4 },
      { egressAllowlist: ["example.com"], fetch: (async () => new Response("abcdefgh", { status: 200 })) as unknown as typeof fetch },
    );
    assert.equal(r.toolMessage, "abcd\n[truncated by the tool: 4 of 8 bytes shown; the rest was not returned]");
    assert.equal(recordedContent(r.events), "abcd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
