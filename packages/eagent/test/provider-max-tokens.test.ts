/**
 * Protected invariant: the host wires a configurable per-provider output cap
 * into the REAL provider construction (defaulting to 8192), so a deployment can
 * lengthen outputs. A hardcoded cap would silently truncate long answers and
 * collide with high thinking budgets. `buildProviders` runs the exact
 * construction code the host uses, so testing it proves the host composes the
 * config key with the provider option.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildProviders } from "../src/host.ts";
import { LayeredConfig } from "../src/config.ts";
import { MemoryStore } from "../src/kernel/store.ts";
import type { CompletionRequest, StreamEvent } from "../src/kernel/types.ts";

/** A minimal Anthropic SSE Response — enough for `stream()` to run to completion. */
function sseResponse(events: { event: string; data: unknown }[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const CANNED = [
  { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
  { event: "message_stop", data: { type: "message_stop" } },
];

function req(): CompletionRequest {
  return {
    systemPrompt: "be helpful",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    model: "claude-fable-5",
    signal: new AbortController().signal,
  };
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const ev of it) void ev;
}

test("buildProviders wires a configurable Anthropic max_tokens, defaulting to 8192", async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test";
  try {
    let capturedBody: any;
    const capturingFetch: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseResponse(CANNED);
    };

    // A config override lengthens the output cap and reaches the real request.
    const withOverride = new LayeredConfig({ fileValues: {}, overrideStore: new MemoryStore() });
    withOverride.set("providers.anthropic.maxTokens", 8000);
    const built = buildProviders(withOverride, { fetch: capturingFetch });
    await drain(built.anthropic.stream(req()));
    assert.equal(capturedBody.max_tokens, 8000);

    // No override keeps the 8192 default.
    const noOverride = new LayeredConfig({ fileValues: {}, overrideStore: new MemoryStore() });
    const built2 = buildProviders(noOverride, { fetch: capturingFetch });
    await drain(built2.anthropic.stream(req()));
    assert.equal(capturedBody.max_tokens, 8192);
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

/** A minimal Gemini SSE frame — `alt=sse` data lines the parser can drain. */
const GEMINI_CANNED = [
  {
    event: "message",
    data: {
      candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    },
  },
];

test("buildProviders defaults the Gemini output cap to 8192 (nested under generationConfig)", async () => {
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test";
  try {
    let capturedBody: any;
    const capturingFetch: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseResponse(GEMINI_CANNED);
    };

    // No override: the Gemini cap lands in generationConfig.maxOutputTokens.
    const noOverride = new LayeredConfig({ fileValues: {}, overrideStore: new MemoryStore() });
    const built = buildProviders(noOverride, { fetch: capturingFetch });
    await drain(built.gemini.stream(req()));
    assert.equal(capturedBody.generationConfig.maxOutputTokens, 8192);
  } finally {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});
