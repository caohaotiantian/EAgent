import assert from "node:assert/strict";
import { test } from "node:test";

import { GeminiProvider } from "../src/providers/gemini.ts";
import type { CompletionRequest, StreamEvent } from "../src/kernel/types.ts";

function sse(chunks: unknown[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
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
    model: "gemini-2.0",
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
  { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] },
  { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } },
];

const TOOL_CHUNKS = [
  { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "add", args: { a: 2, b: 3 } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 } },
];

test("parses streaming text and usage", async () => {
  const provider = new GeminiProvider({ apiKey: "k", fetch: async () => sse(TEXT_CHUNKS) });
  const events = await collect(provider.stream(req()));
  const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
  assert.equal(text, "Hello");
  const done = events.at(-1)!;
  if (done.type === "done") {
    assert.equal(done.stopReason, "end_turn");
    assert.deepEqual(done.usage, { inputTokens: 9, outputTokens: 2 });
  }
});

const CACHE_CHUNKS = [
  {
    candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 30, candidatesTokenCount: 20, thoughtsTokenCount: 6 },
  },
];

test("subtracts cached content out of prompt and folds thoughts into output tokens", async () => {
  const provider = new GeminiProvider({ apiKey: "k", fetch: async () => sse(CACHE_CHUNKS) });
  const events = await collect(provider.stream(req()));
  const done = events.at(-1)!;
  assert.equal(done.type, "done");
  if (done.type === "done") {
    // input = prompt - cached = 70; output = candidates + thoughts = 26 (thoughts
    // are disjoint and additive in Gemini); reasoning = thoughts = 6 (⊆ output).
    assert.deepEqual(done.usage, { inputTokens: 70, cacheReadTokens: 30, outputTokens: 26, reasoningTokens: 6 });
  }
});

test("emits a tool call from a functionCall part", async () => {
  const provider = new GeminiProvider({ apiKey: "k", fetch: async () => sse(TOOL_CHUNKS) });
  const events = await collect(provider.stream(req()));
  const call = events.find((e) => e.type === "tool_call");
  assert.ok(call && call.type === "tool_call");
  assert.equal(call.name, "add");
  assert.deepEqual(call.arguments, { a: 2, b: 3 });
  assert.equal(events.at(-1)?.type === "done" && (events.at(-1) as { stopReason: string }).stopReason, "tool_use");
});

test("maps messages to Gemini contents, system instruction, and named function responses", async () => {
  let captured: any;
  const provider = new GeminiProvider({
    apiKey: "k",
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
  assert.equal(captured.systemInstruction.parts[0].text, "be helpful");
  assert.equal(captured.tools[0].functionDeclarations[0].name, "add");
  // assistant -> role "model" with a functionCall part.
  const model = captured.contents.find((c: any) => c.role === "model");
  assert.equal(model.parts[0].functionCall.name, "add");
  // tool result -> functionResponse correlated by NAME ("add"), not id ("t1").
  const fnResp = captured.contents.flatMap((c: any) => c.parts).find((p: any) => p.functionResponse);
  assert.equal(fnResp.functionResponse.name, "add");
  assert.equal(fnResp.functionResponse.response.result, "2");
});

test("maps an image part to inlineData", async () => {
  let captured: any;
  const provider = new GeminiProvider({
    apiKey: "k",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sse(TEXT_CHUNKS);
    },
  });
  await collect(
    provider.stream(req({ messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] }] })),
  );
  const part = captured.contents[0].parts[0];
  assert.deepEqual(part.inlineData, { mimeType: "image/png", data: "AAAA" });
});

test("throws on a non-retryable error", async () => {
  const provider = new GeminiProvider({ apiKey: "k", fetch: async () => new Response("bad", { status: 400 }) });
  await assert.rejects(() => collect(provider.stream(req())), /Gemini API error 400/);
});

test("maps thinking level to a thinkingConfig budget, and 0 when off", async () => {
  let captured: any;
  const provider = new GeminiProvider({
    apiKey: "k",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sse(TEXT_CHUNKS);
    },
  });
  await collect(provider.stream(req({ thinking: "high" })));
  assert.deepEqual(captured.generationConfig.thinkingConfig, { thinkingBudget: 24576, includeThoughts: true });
  await collect(provider.stream(req({ thinking: "off" })));
  assert.deepEqual(captured.generationConfig.thinkingConfig, { thinkingBudget: 0, includeThoughts: false });
});

test("maps toolChoice to Gemini tool_config, omitting it for auto/absent", async () => {
  let captured: any;
  const provider = new GeminiProvider({
    apiKey: "k",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sse(TEXT_CHUNKS);
    },
  });
  const withTool = { tools: [{ name: "respond", description: "", parameters: { type: "object" as const } }] };
  // A named tool ⇒ mode ANY restricted to that function.
  await collect(provider.stream(req({ ...withTool, toolChoice: { type: "tool", name: "respond" } })));
  assert.deepEqual(captured.tool_config, {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["respond"] },
  });
  // "required" ⇒ mode ANY (call SOME function).
  await collect(provider.stream(req({ ...withTool, toolChoice: "required" })));
  assert.deepEqual(captured.tool_config, { functionCallingConfig: { mode: "ANY" } });
  // "auto" and absent ⇒ omit the key entirely (graceful default — Gemini defaults to AUTO).
  await collect(provider.stream(req({ ...withTool, toolChoice: "auto" })));
  assert.equal(captured.tool_config, undefined);
  await collect(provider.stream(req(withTool)));
  assert.equal(captured.tool_config, undefined);
  // No tools declared ⇒ no tool_config even with a choice (forcing is meaningless).
  await collect(provider.stream(req({ toolChoice: { type: "tool", name: "respond" } })));
  assert.equal(captured.tool_config, undefined);
});

test("maps SAFETY and RECITATION finishReason to content_filter, preserving prior mappings (AC-7)", async () => {
  async function stopReasonFor(finish: string): Promise<string> {
    const chunks = [
      {
        candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: finish }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      },
    ];
    const provider = new GeminiProvider({ apiKey: "k", fetch: async () => sse(chunks) });
    const done = (await collect(provider.stream(req()))).at(-1)!;
    assert.equal(done.type, "done");
    return done.type === "done" ? done.stopReason : "";
  }
  // Both safety and recitation blocks collapse to the neutral content_filter.
  assert.equal(await stopReasonFor("SAFETY"), "content_filter");
  assert.equal(await stopReasonFor("RECITATION"), "content_filter");
  // Pre-existing mappings are unchanged.
  assert.equal(await stopReasonFor("STOP"), "end_turn");
  assert.equal(await stopReasonFor("MAX_TOKENS"), "max_tokens");
});

test("surfaces thought parts as reasoning, keeping them out of the answer", async () => {
  const chunks = [
    { candidates: [{ content: { role: "model", parts: [{ text: "planning", thought: true }, { text: "Hi" }] }, finishReason: "STOP" }] },
  ];
  const provider = new GeminiProvider({ apiKey: "k", fetch: async () => sse(chunks) });
  const events = await collect(provider.stream(req({ thinking: "low" })));
  assert.deepEqual(
    events.filter((e) => e.type === "reasoning_delta").map((e) => (e as { text: string }).text),
    ["planning"],
  );
  const done = events.at(-1)!;
  assert.equal(done.type, "done");
  if (done.type === "done") {
    // Thought stays out of the answer text…
    const textBlock = done.message.content.find((b) => b.type === "text");
    assert.equal((textBlock as { text: string }).text, "Hi");
    // …but is persisted as a thinking block for snapshot/restore fidelity.
    const thinkingBlock = done.message.content.find((b) => b.type === "thinking");
    assert.equal((thinkingBlock as { thinking: string }).thinking, "planning");
  }
});

test("AC-4: persists thought parts as a thinking block (first) plus the text block", async () => {
  const chunks = [
    {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "plan", thought: true }, { text: "ning", thought: true }, { text: "Hi" }] },
          finishReason: "STOP",
        },
      ],
    },
  ];
  const provider = new GeminiProvider({ apiKey: "k", fetch: async () => sse(chunks) });
  const events = await collect(provider.stream(req({ thinking: "low" })));
  // Streaming is unchanged: reasoning_delta events still fire per thought part.
  assert.deepEqual(
    events.filter((e) => e.type === "reasoning_delta").map((e) => (e as { text: string }).text),
    ["plan", "ning"],
  );
  const done = events.at(-1)!;
  assert.equal(done.type, "done");
  if (done.type === "done") {
    const content = done.message.content;
    assert.equal(content[0]?.type, "thinking");
    assert.equal((content[0] as { thinking: string }).thinking, "planning");
    const textBlock = content.find((b) => b.type === "text");
    assert.equal((textBlock as { text: string }).text, "Hi");
  }
});

test("AC-6: a stream with no thought parts has no thinking block (byte-identity)", async () => {
  const provider = new GeminiProvider({ apiKey: "k", fetch: async () => sse(TEXT_CHUNKS) });
  const done = (await collect(provider.stream(req()))).at(-1)!;
  assert.equal(done.type, "done");
  if (done.type === "done") {
    assert.ok(!done.message.content.some((b) => b.type === "thinking"));
    assert.deepEqual(done.message.content, [{ type: "text", text: "Hello" }]);
  }
});

test("AC-5: a persisted thinking block is dropped on replay (no thought on the wire)", async () => {
  let captured: any;
  const provider = new GeminiProvider({
    apiKey: "k",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sse(TEXT_CHUNKS);
    },
  });
  await collect(
    provider.stream(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "secret reasoning" },
              { type: "text", text: "Hi" },
            ],
          },
        ],
      }),
    ),
  );
  // The thinking block is in no model-role parts (nor anywhere on the wire).
  assert.ok(!JSON.stringify(captured.contents).includes("secret reasoning"));
  const model = captured.contents.find((c: any) => c.role === "model");
  assert.deepEqual(model.parts, [{ text: "Hi" }]);
});

test("W9.5b: a thinking-only assistant turn is omitted, never sent as empty parts", async () => {
  let captured: any;
  const provider = new GeminiProvider({
    apiKey: "k",
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return sse(TEXT_CHUNKS);
    },
  });
  await collect(
    provider.stream(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          // A MAX_TOKENS-truncated turn: reasoning only, no text/tool_call. Its
          // thinking block maps to no part, so the builder must skip it rather
          // than push `parts: []` (which generateContent rejects with a 400).
          { role: "assistant", content: [{ type: "thinking", thinking: "only reasoning here" }] },
          { role: "user", content: [{ type: "text", text: "follow up" }] },
        ],
      }),
    ),
  );
  const contents = captured.contents as { role: string; parts: unknown[] }[];
  assert.ok(
    contents.every((c) => c.parts.length > 0),
    "no content entry is sent with empty parts",
  );
  assert.ok(!contents.some((c) => c.role === "model"), "the reasoning-only model turn is omitted entirely");
  assert.equal(contents.length, 2, "only the two user turns remain on the wire");
});
