import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RecordingProvider, ReplayProvider } from "../src/providers/cassette.js";
import { MockProvider } from "../src/providers/mock.js";
import { Agent } from "../src/kernel/agent.js";
import { CapabilityManager } from "../src/kernel/capabilities.js";
import { defineTool } from "../src/kernel/define.js";
import type { CompletionRequest } from "../src/kernel/types.js";
import { silentLogger, lastText } from "./helpers.js";

function req(): CompletionRequest {
  return {
    systemPrompt: "",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    model: "mock",
    signal: new AbortController().signal,
  };
}

test("records a provider's stream to a JSONL cassette", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "eagent-cas-")), "tape.jsonl");
  const rec = new RecordingProvider(new MockProvider({ text: "hello there" }), path);
  for await (const _ of rec.stream(req())) {
    void _;
  }
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const events = JSON.parse(lines[0]!) as { type: string }[];
  assert.ok(events.some((e) => e.type === "text_delta"));
  assert.equal(events.at(-1)?.type, "done");
});

test("replays a cassette identically, offline", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "eagent-cas-")), "tape.jsonl");
  // Record two interactions from the mock.
  const rec = new RecordingProvider(new MockProvider([{ text: "first" }, { text: "second" }]), path);
  for await (const _ of rec.stream(req())) void _;
  for await (const _ of rec.stream(req())) void _;

  // Replay them in order.
  const replay = new ReplayProvider(path);
  assert.equal(replay.remaining, 2);
  const collect = async () => {
    let text = "";
    for await (const ev of replay.stream(req())) if (ev.type === "text_delta") text += ev.text;
    return text;
  };
  assert.equal(await collect(), "first");
  assert.equal(await collect(), "second");
  assert.equal(replay.remaining, 0);
});

test("a replayed cassette drives a full agent run with tools", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "eagent-cas-")), "tape.jsonl");
  // Record a tool-use turn then a final answer.
  const scripted = new MockProvider([
    { toolCalls: [{ name: "ping", arguments: {} }] },
    { text: "pong received" },
  ]);
  const rec = new RecordingProvider(scripted, path);
  for await (const _ of rec.stream(req())) void _;
  for await (const _ of rec.stream(req())) void _;

  // Now run an agent purely off the replay.
  const agent = new Agent({
    logger: silentLogger,
    capabilities: new CapabilityManager({ fallback: "allow" }),
    provider: "replay",
  });
  agent.providers.register(new ReplayProvider(path), { default: true });
  agent.tools.register(defineTool({ name: "ping", description: "", execute: () => ({ content: "pong" }) }));

  const { reason } = await agent.run("go");
  assert.equal(reason, "end_turn");
  assert.equal(lastText(agent), "pong received");
});

test("an exhausted cassette throws a clear error", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "eagent-cas-")), "tape.jsonl");
  const rec = new RecordingProvider(new MockProvider({ text: "only one" }), path);
  for await (const _ of rec.stream(req())) void _;
  const replay = new ReplayProvider(path);
  for await (const _ of replay.stream(req())) void _;
  await assert.rejects(async () => {
    for await (const _ of replay.stream(req())) void _;
  }, /cassette exhausted/);
});
