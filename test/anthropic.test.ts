import assert from "node:assert/strict";
import { test } from "node:test";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import type { CompletionRequest, StreamEvent } from "../src/kernel/types.js";

/** Build an Anthropic-style SSE Response from a list of events (one chunk each
 *  so the parser's cross-chunk buffering is exercised). */
function sseResponse(events: { event: string; data: unknown }[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
}

const TEXT_EVENTS = [
  { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } },
  { event: "message_stop", data: { type: "message_stop" } },
];

const TOOL_EVENTS = [
  { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 0 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "add" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":2,' } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"b":3}' } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } } },
];

function req(over: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    systemPrompt: "be helpful",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    model: "claude-fable-5",
    signal: new AbortController().signal,
    ...over,
  };
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

test("parses a streaming text completion with usage", async () => {
  const provider = new AnthropicProvider({ apiKey: "test", fetch: async () => sseResponse(TEXT_EVENTS) });
  const events = await collect(provider.stream(req()));
  const deltas = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text);
  assert.deepEqual(deltas, ["Hello", " world"]);
  const done = events.at(-1)!;
  assert.equal(done.type, "done");
  if (done.type === "done") {
    assert.equal(done.stopReason, "end_turn");
    assert.equal(done.message.content[0]?.type, "text");
    assert.equal((done.message.content[0] as { text: string }).text, "Hello world");
    assert.deepEqual(done.usage, { inputTokens: 10, outputTokens: 5 });
  }
});

test("assembles a tool call from streamed input_json deltas", async () => {
  const provider = new AnthropicProvider({ apiKey: "test", fetch: async () => sseResponse(TOOL_EVENTS) });
  const events = await collect(provider.stream(req()));
  const toolCall = events.find((e) => e.type === "tool_call");
  assert.ok(toolCall && toolCall.type === "tool_call");
  assert.equal(toolCall.name, "add");
  assert.deepEqual(toolCall.arguments, { a: 2, b: 3 });
  const done = events.at(-1)!;
  assert.equal(done.type === "done" && done.stopReason, "tool_use");
});

test("maps EAgent messages to the Anthropic wire format", async () => {
  let captured: any;
  const provider = new AnthropicProvider({
    apiKey: "test",
    cache: false,
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sseResponse(TEXT_EVENTS);
    },
  });
  await collect(
    provider.stream(
      req({
        tools: [{ name: "add", description: "sum", parameters: { type: "object", properties: { a: { type: "number" } } } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "add" }] },
          { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "add", arguments: { a: 1 } }] },
          { role: "tool", content: [{ type: "tool_result", toolCallId: "t1", content: "2" }] },
        ],
      }),
    ),
  );
  assert.equal(captured.system, "be helpful");
  assert.equal(captured.tools[0].name, "add");
  assert.ok(captured.tools[0].input_schema, "tool schema is passed as input_schema");
  // The tool message becomes a user message carrying a tool_result block.
  const toolMsg = captured.messages[2];
  assert.equal(toolMsg.role, "user");
  assert.equal(toolMsg.content[0].type, "tool_result");
  assert.equal(toolMsg.content[0].tool_use_id, "t1");
  // The assistant tool call becomes a tool_use block.
  assert.equal(captured.messages[1].content[0].type, "tool_use");
});

test("maps image content blocks to Anthropic's image source format", async () => {
  let captured: any;
  const provider = new AnthropicProvider({
    apiKey: "test",
    cache: false,
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sseResponse(TEXT_EVENTS);
    },
  });
  await collect(
    provider.stream(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", mimeType: "image/png", data: "AAAA" }] },
        ],
      }),
    ),
  );
  const content = captured.messages[0].content;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image");
  assert.deepEqual(content[1].source, { type: "base64", media_type: "image/png", data: "AAAA" });
});

test("marks the system prompt and tools as cacheable by default", async () => {
  let captured: any;
  const provider = new AnthropicProvider({
    apiKey: "test",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sseResponse(TEXT_EVENTS);
    },
  });
  await collect(
    provider.stream(
      req({ tools: [{ name: "a", description: "", parameters: { type: "object" } }, { name: "b", description: "", parameters: { type: "object" } }] }),
    ),
  );
  // System becomes a cacheable block array.
  assert.ok(Array.isArray(captured.system));
  assert.deepEqual(captured.system[0].cache_control, { type: "ephemeral" });
  // Only the last tool carries the cache breakpoint.
  assert.equal(captured.tools[0].cache_control, undefined);
  assert.deepEqual(captured.tools[1].cache_control, { type: "ephemeral" });
});

test("caching can be disabled", async () => {
  let captured: any;
  const provider = new AnthropicProvider({
    apiKey: "test",
    cache: false,
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sseResponse(TEXT_EVENTS);
    },
  });
  await collect(provider.stream(req()));
  assert.equal(typeof captured.system, "string", "system stays a plain string when caching is off");
});

const TWO_TOOLS = [
  { name: "a", description: "", parameters: { type: "object" } as Record<string, unknown> },
  { name: "b", description: "", parameters: { type: "object" } as Record<string, unknown> },
];

const HISTORY_MESSAGES: CompletionRequest["messages"] = [
  { role: "user", content: [{ type: "text", text: "add" }] },
  { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "a", arguments: { x: 1 } }] },
  { role: "tool", content: [{ type: "tool_result", toolCallId: "t1", content: "2" }] },
  { role: "user", content: [{ type: "text", text: "thanks" }] },
];

/** Count every cache_control occurrence across system, tools, and all message blocks. */
function countBreakpoints(captured: any): number {
  let n = 0;
  if (Array.isArray(captured.system)) {
    for (const block of captured.system) if (block?.cache_control) n++;
  }
  if (Array.isArray(captured.tools)) {
    for (const tool of captured.tools) if (tool?.cache_control) n++;
  }
  if (Array.isArray(captured.messages)) {
    for (const msg of captured.messages) {
      if (Array.isArray(msg?.content)) for (const block of msg.content) if (block?.cache_control) n++;
    }
  }
  return n;
}

test("caches the last message's last content block by default", async () => {
  let captured: any;
  const provider = new AnthropicProvider({
    apiKey: "test",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sseResponse(TEXT_EVENTS);
    },
  });
  await collect(provider.stream(req({ tools: TWO_TOOLS, messages: HISTORY_MESSAGES })));
  // The growing conversation tail carries the new breakpoint.
  assert.deepEqual(captured.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });
  // The static system + last-tool breakpoints are unaffected.
  assert.deepEqual(captured.system[0].cache_control, { type: "ephemeral" });
  assert.equal(captured.tools[0].cache_control, undefined);
  assert.deepEqual(captured.tools.at(-1).cache_control, { type: "ephemeral" });
});

test("does not cache any message block when caching is off", async () => {
  let captured: any;
  const provider = new AnthropicProvider({
    apiKey: "test",
    cache: false,
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sseResponse(TEXT_EVENTS);
    },
  });
  await collect(provider.stream(req({ tools: TWO_TOOLS, messages: HISTORY_MESSAGES })));
  for (const msg of captured.messages) {
    for (const block of msg.content) assert.equal(block.cache_control, undefined);
  }
  assert.equal(captured.system, "be helpful");
  for (const tool of captured.tools) assert.equal(tool.cache_control, undefined);
});

test("leaves no breakpoint when the last message filters to empty content", async () => {
  let captured: any;
  const provider = new AnthropicProvider({
    apiKey: "test",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sseResponse(TEXT_EVENTS);
    },
  });
  // A tool message with no tool_result block maps to content: [].
  const messages: CompletionRequest["messages"] = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "tool", content: [{ type: "text", text: "x" }] },
  ];
  await collect(provider.stream(req({ tools: TWO_TOOLS, messages })));
  assert.equal(captured.messages.at(-1).content.length, 0);
  // The static breakpoints still apply.
  assert.deepEqual(captured.system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(captured.tools.at(-1).cache_control, { type: "ephemeral" });
});

test("uses at most 4 cache_control breakpoints", async () => {
  let captured: any;
  const provider = new AnthropicProvider({
    apiKey: "test",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sseResponse(TEXT_EVENTS);
    },
  });
  await collect(provider.stream(req({ tools: TWO_TOOLS, messages: HISTORY_MESSAGES })));
  const count = countBreakpoints(captured);
  assert.ok(count <= 4, `expected <= 4 breakpoints, got ${count}`);
  assert.equal(count, 3);
});

test("handles an empty messages array without error", async () => {
  let captured: any;
  const provider = new AnthropicProvider({
    apiKey: "test",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sseResponse(TEXT_EVENTS);
    },
  });
  await collect(provider.stream(req({ tools: TWO_TOOLS, messages: [] })));
  assert.deepEqual(captured.messages, []);
  assert.deepEqual(captured.system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(captured.tools.at(-1).cache_control, { type: "ephemeral" });
});

const THINKING_EVENTS = [
  { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me " } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG==" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } } },
];

test("maps a thinking level to adaptive thinking + effort, omitting it when off", async () => {
  let captured: any;
  const provider = new AnthropicProvider({
    apiKey: "test",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sseResponse(TEXT_EVENTS);
    },
  });
  await collect(provider.stream(req({ thinking: "high" })));
  assert.deepEqual(captured.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(captured.output_config, { effort: "high" });
  // `off` (and the unset default) must send neither — Fable/Opus 4.7+ reject budget_tokens.
  await collect(provider.stream(req({ thinking: "off" })));
  assert.equal(captured.thinking, undefined);
  assert.equal(captured.output_config, undefined);
});

test("parses thinking blocks: emits reasoning deltas and keeps a signed thinking block", async () => {
  const provider = new AnthropicProvider({ apiKey: "test", fetch: async () => sseResponse(THINKING_EVENTS) });
  const events = await collect(provider.stream(req({ thinking: "low" })));
  const reasoning = events.filter((e) => e.type === "reasoning_delta").map((e) => (e as { text: string }).text);
  assert.deepEqual(reasoning, ["let me ", "think"]);
  const done = events.at(-1)!;
  assert.ok(done.type === "done");
  if (done.type === "done") {
    const thinking = done.message.content[0];
    assert.equal(thinking?.type, "thinking");
    assert.deepEqual(thinking, { type: "thinking", thinking: "let me think", signature: "SIG==" });
    assert.equal(done.message.content[1]?.type, "text");
  }
});

test("round-trips a signed thinking block back to the wire, dropping unsigned ones", async () => {
  let captured: any;
  const provider = new AnthropicProvider({
    apiKey: "test",
    cache: false,
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sseResponse(TEXT_EVENTS);
    },
  });
  await collect(
    provider.stream(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "kept", signature: "SIG==" },
              { type: "thinking", thinking: "dropped" },
              { type: "text", text: "ok" },
            ],
          },
        ],
      }),
    ),
  );
  const blocks = captured.messages[1].content;
  assert.deepEqual(blocks[0], { type: "thinking", thinking: "kept", signature: "SIG==" });
  // The signatureless block is dropped; only the kept thinking + text remain.
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].type, "text");
});

test("throws on a non-retryable error status", async () => {
  const provider = new AnthropicProvider({
    apiKey: "test",
    fetch: async () => new Response("bad request", { status: 400 }),
  });
  await assert.rejects(() => collect(provider.stream(req())), /Anthropic API error 400/);
});

test("retries on 429 then succeeds", async () => {
  let calls = 0;
  const provider = new AnthropicProvider({
    apiKey: "test",
    maxRetries: 3,
    fetch: async () => {
      calls++;
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return sseResponse(TEXT_EVENTS);
    },
  });
  const events = await collect(provider.stream(req()));
  assert.equal(calls, 2, "should retry once");
  assert.equal(events.at(-1)?.type, "done");
});

test("gives up after maxRetries on persistent 5xx", async () => {
  let calls = 0;
  const provider = new AnthropicProvider({
    apiKey: "test",
    maxRetries: 2,
    fetch: async () => {
      calls++;
      return new Response("server error", { status: 503, headers: { "retry-after": "0" } });
    },
  });
  await assert.rejects(() => collect(provider.stream(req())), /Anthropic API error 503/);
  assert.equal(calls, 3, "initial attempt + 2 retries");
});
