import assert from "node:assert/strict";
import { test } from "node:test";

import { OpenAIProvider } from "../src/providers/openai.js";
import type { CompletionRequest, StreamEvent } from "../src/kernel/types.js";

function sse(chunks: unknown[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function req(over: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    systemPrompt: "be helpful",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    model: "gpt-x",
    signal: new AbortController().signal,
    ...over,
  };
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const TEXT_CHUNKS = [
  { choices: [{ delta: { role: "assistant", content: "Hel" } }] },
  { choices: [{ delta: { content: "lo" } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } },
];

const TOOL_CHUNKS = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "add", arguments: '{"a":2,' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b":3}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 20, completion_tokens: 9 } },
];

test("parses a streaming text completion with usage", async () => {
  const provider = new OpenAIProvider({ apiKey: "test", fetch: async () => sse(TEXT_CHUNKS) });
  const events = await collect(provider.stream(req()));
  const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
  assert.equal(text, "Hello");
  const done = events.at(-1)!;
  assert.equal(done.type, "done");
  if (done.type === "done") {
    assert.equal(done.stopReason, "end_turn");
    assert.equal((done.message.content[0] as { text: string }).text, "Hello");
    assert.deepEqual(done.usage, { inputTokens: 11, outputTokens: 3 });
  }
});

test("assembles a tool call from streamed argument deltas", async () => {
  const provider = new OpenAIProvider({ apiKey: "test", fetch: async () => sse(TOOL_CHUNKS) });
  const events = await collect(provider.stream(req()));
  const toolCall = events.find((e) => e.type === "tool_call");
  assert.ok(toolCall && toolCall.type === "tool_call");
  assert.equal(toolCall.name, "add");
  assert.deepEqual(toolCall.arguments, { a: 2, b: 3 });
  assert.equal(events.at(-1)?.type === "done" && (events.at(-1) as { stopReason: string }).stopReason, "tool_use");
});

test("maps EAgent messages to the OpenAI wire format", async () => {
  let captured: any;
  const provider = new OpenAIProvider({
    apiKey: "test",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sse(TEXT_CHUNKS);
    },
  });
  await collect(
    provider.stream(
      req({
        tools: [{ name: "add", description: "sum", parameters: { type: "object", properties: {} } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "add" }] },
          { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "add", arguments: { a: 1 } }] },
          { role: "tool", content: [{ type: "tool_result", toolCallId: "t1", content: "2" }] },
        ],
      }),
    ),
  );
  assert.equal(captured.messages[0].role, "system");
  assert.equal(captured.tools[0].type, "function");
  assert.equal(captured.tools[0].function.name, "add");
  // assistant tool call -> tool_calls; tool result -> a `tool` message.
  const assistant = captured.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
  assert.equal(assistant.tool_calls[0].id, "t1");
  assert.equal(assistant.tool_calls[0].function.name, "add");
  const toolMsg = captured.messages.find((m: any) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "t1");
  assert.equal(toolMsg.content, "2");
});

test("maps image content blocks to OpenAI's image_url array form", async () => {
  let captured: any;
  const provider = new OpenAIProvider({
    apiKey: "test",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sse(TEXT_CHUNKS);
    },
  });
  await collect(
    provider.stream(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "caption" }, { type: "image", mimeType: "image/jpeg", data: "ZZZZ" }] },
        ],
      }),
    ),
  );
  const userMsg = captured.messages.find((m: any) => m.role === "user" && Array.isArray(m.content));
  assert.ok(userMsg, "user message should use array content when an image is present");
  assert.equal(userMsg.content[0].type, "text");
  assert.equal(userMsg.content[1].type, "image_url");
  assert.equal(userMsg.content[1].image_url.url, "data:image/jpeg;base64,ZZZZ");
});

test("retries on 429 then succeeds", async () => {
  let calls = 0;
  const provider = new OpenAIProvider({
    apiKey: "test",
    fetch: async () => {
      calls++;
      if (calls === 1) return new Response("slow", { status: 429, headers: { "retry-after": "0" } });
      return sse(TEXT_CHUNKS);
    },
  });
  const events = await collect(provider.stream(req()));
  assert.equal(calls, 2);
  assert.equal(events.at(-1)?.type, "done");
});

test("throws on a non-retryable error", async () => {
  const provider = new OpenAIProvider({ apiKey: "test", fetch: async () => new Response("bad", { status: 400 }) });
  await assert.rejects(() => collect(provider.stream(req())), /OpenAI API error 400/);
});

test("sends max_tokens by default and max_completion_tokens when configured", async () => {
  let byDefault: any;
  const p1 = new OpenAIProvider({
    apiKey: "t",
    fetch: async (_u, init) => {
      byDefault = JSON.parse(String(init?.body));
      return sse(TEXT_CHUNKS);
    },
  });
  await collect(p1.stream(req()));
  assert.equal(byDefault.max_tokens, 4096);
  assert.equal(byDefault.max_completion_tokens, undefined);

  let configured: any;
  const p2 = new OpenAIProvider({
    apiKey: "t",
    maxTokensParam: "max_completion_tokens",
    fetch: async (_u, init) => {
      configured = JSON.parse(String(init?.body));
      return sse(TEXT_CHUNKS);
    },
  });
  await collect(p2.stream(req()));
  assert.equal(configured.max_completion_tokens, 4096);
  assert.equal(configured.max_tokens, undefined);
});

test("synthesizes distinct ids for parallel same-name calls when the endpoint omits ids", async () => {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "f", arguments: "{}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: "f", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const provider = new OpenAIProvider({ apiKey: "t", fetch: async () => sse(chunks) });
  const ids = (await collect(provider.stream(req())))
    .filter((e) => e.type === "tool_call")
    .map((e) => (e as { id: string }).id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], "two parallel same-name calls must not collide on a synthesized id");
});
