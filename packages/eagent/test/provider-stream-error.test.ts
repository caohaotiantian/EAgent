import assert from "node:assert/strict";
import { test } from "node:test";

import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { OpenAIProvider } from "../src/providers/openai.ts";
import { GeminiProvider } from "../src/providers/gemini.ts";
import type { CompletionRequest, StreamEvent } from "../src/kernel/types.ts";

/**
 * Protected invariant: a mid-stream API error frame must surface as a THROWN
 * error, never as a fabricated `done` with truncated content. Only then can the
 * agent loop retry (pre-commit) or fail honestly (post-commit) instead of
 * presenting an outage as a successful short answer (design KDD3, AC2).
 */

function req(over: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    systemPrompt: "be helpful",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    model: "m",
    signal: new AbortController().signal,
    ...over,
  };
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

// -- Anthropic: SSE builder emits `event:` lines (test/anthropic.test.ts style) --
function anthropicSSE(events: { event: string; data: unknown }[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const ANTHROPIC_ERROR = { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } };

test("anthropic: an error frame after a content delta rejects (post-commit)", async () => {
  const events = [
    { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "par" } } },
    ANTHROPIC_ERROR,
  ];
  const provider = new AnthropicProvider({ apiKey: "test", fetch: async () => anthropicSSE(events) });
  await assert.rejects(
    () => collect(provider.stream(req({ model: "claude-fable-5" }))),
    /Anthropic stream error: overloaded_error: Overloaded/,
  );
});

test("anthropic: an error frame before any content rejects (pre-commit)", async () => {
  const provider = new AnthropicProvider({ apiKey: "test", fetch: async () => anthropicSSE([ANTHROPIC_ERROR]) });
  await assert.rejects(
    () => collect(provider.stream(req({ model: "claude-fable-5" }))),
    /Anthropic stream error: overloaded_error: Overloaded/,
  );
});

// -- OpenAI: bare `data:` frames, terminated by [DONE] (test/openai.test.ts style) --
function openaiSSE(chunks: unknown[]): Response {
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

const OPENAI_ERROR = { error: { message: "Overloaded", type: "server_error", code: null } };

test("openai: an error frame after a content delta rejects (post-commit)", async () => {
  const chunks = [{ choices: [{ delta: { content: "par" } }] }, OPENAI_ERROR];
  const provider = new OpenAIProvider({ apiKey: "test", fetch: async () => openaiSSE(chunks) });
  await assert.rejects(
    () => collect(provider.stream(req({ model: "gpt-x" }))),
    /OpenAI stream error: server_error: Overloaded/,
  );
});

test("openai: an error frame before any content rejects (pre-commit)", async () => {
  const provider = new OpenAIProvider({ apiKey: "test", fetch: async () => openaiSSE([OPENAI_ERROR]) });
  await assert.rejects(
    () => collect(provider.stream(req({ model: "gpt-x" }))),
    /OpenAI stream error: server_error: Overloaded/,
  );
});

// -- Gemini: bare `data:` frames, no [DONE] (test/gemini.test.ts style) --
function geminiSSE(chunks: unknown[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const GEMINI_ERROR = { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } };

test("gemini: an error frame after a content delta rejects (post-commit)", async () => {
  const chunks = [{ candidates: [{ content: { role: "model", parts: [{ text: "par" }] } }] }, GEMINI_ERROR];
  const provider = new GeminiProvider({ apiKey: "k", fetch: async () => geminiSSE(chunks) });
  await assert.rejects(
    () => collect(provider.stream(req({ model: "gemini-2.0" }))),
    /Gemini stream error: RESOURCE_EXHAUSTED: Resource exhausted/,
  );
});

test("gemini: an error frame before any content rejects (pre-commit)", async () => {
  const provider = new GeminiProvider({ apiKey: "k", fetch: async () => geminiSSE([GEMINI_ERROR]) });
  await assert.rejects(
    () => collect(provider.stream(req({ model: "gemini-2.0" }))),
    /Gemini stream error: RESOURCE_EXHAUSTED: Resource exhausted/,
  );
});
