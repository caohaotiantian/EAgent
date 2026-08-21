import assert from "node:assert/strict";
import { test } from "node:test";

import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { OpenAIProvider } from "../src/providers/openai.ts";
import { GeminiProvider } from "../src/providers/gemini.ts";
import type { CompletionRequest, StreamEvent } from "../src/kernel/types.ts";

// Protected invariant: a `role:"system"` message present inside `req.messages`
// must reach the wire on EVERY provider, so that context-injecting extensions
// (context-files, skills, goal, ...) are not silently dark on Anthropic/Gemini.

/** Anthropic emits `event:` + `data:` SSE lines (its builder house style). */
function anthropicSSE(events: { event: string; data: unknown }[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** OpenAI/Gemini use bare `data:` frames. */
function dataSSE(chunks: unknown[]): Response {
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

const NOTE_MESSAGES: CompletionRequest["messages"] = [
  { role: "system", content: [{ type: "text", text: "PIN-A1" }] },
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

test("an in-transcript system message reaches the wire on every provider", async () => {
  let anthropicBody: any;
  await collect(
    new AnthropicProvider({
      apiKey: "test",
      fetch: async (_url, init) => {
        anthropicBody = JSON.parse(String(init?.body));
        return anthropicSSE([]);
      },
    }).stream(req({ messages: NOTE_MESSAGES })),
  );
  assert.ok(
    JSON.stringify(anthropicBody.system).includes("PIN-A1"),
    "Anthropic top-level system must carry the folded note",
  );

  let geminiBody: any;
  await collect(
    new GeminiProvider({
      apiKey: "k",
      fetch: async (_url, init) => {
        geminiBody = JSON.parse(String(init?.body));
        return dataSSE([]);
      },
    }).stream(req({ messages: NOTE_MESSAGES })),
  );
  assert.ok(
    JSON.stringify(geminiBody.systemInstruction).includes("PIN-A1"),
    "Gemini systemInstruction must carry the folded note",
  );

  // Regression pin: OpenAI already preserves an in-transcript system message.
  let openaiBody: any;
  await collect(
    new OpenAIProvider({
      apiKey: "test",
      fetch: async (_url, init) => {
        openaiBody = JSON.parse(String(init?.body));
        return dataSSE([]);
      },
    }).stream(req({ messages: NOTE_MESSAGES })),
  );
  assert.ok(
    JSON.stringify(openaiBody.messages).includes("PIN-A1"),
    "OpenAI messages must carry the in-transcript system note",
  );
});

test("Anthropic: an empty systemPrompt with a note emits no empty block and preserves the note", async () => {
  let captured: any;
  await collect(
    new AnthropicProvider({
      apiKey: "test",
      fetch: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicSSE([]);
      },
    }).stream(req({ systemPrompt: "", messages: NOTE_MESSAGES })),
  );
  assert.ok(Array.isArray(captured.system), "system folds to an array when a note is present");
  assert.ok(JSON.stringify(captured.system).includes("PIN-A1"), "the note survives");
  for (const block of captured.system) assert.notEqual(block.text, "", "no empty {text:''} block is emitted");
});

test("Gemini: an empty systemPrompt with a note synthesizes systemInstruction with no empty part", async () => {
  let captured: any;
  await collect(
    new GeminiProvider({
      apiKey: "k",
      fetch: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return dataSSE([]);
      },
    }).stream(req({ systemPrompt: "", messages: NOTE_MESSAGES })),
  );
  assert.ok(captured.systemInstruction, "systemInstruction is synthesized from the note");
  assert.ok(JSON.stringify(captured.systemInstruction).includes("PIN-A1"), "the note survives");
  for (const part of captured.systemInstruction.parts) assert.notEqual(part.text, "", "no empty {text:''} part is emitted");
});

test("Anthropic AC3: the no-note system payload is byte-identical to today's cached block array", async () => {
  let captured: any;
  // cache defaults ON.
  await collect(
    new AnthropicProvider({
      apiKey: "test",
      fetch: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicSSE([]);
      },
    }).stream(req({ systemPrompt: "SP" })),
  );
  assert.deepEqual(captured.system, [{ type: "text", text: "SP", cache_control: { type: "ephemeral" } }]);
});

test("Anthropic AC3: with a note the systemPrompt block keeps cache_control and note blocks carry none", async () => {
  let captured: any;
  await collect(
    new AnthropicProvider({
      apiKey: "test",
      fetch: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return anthropicSSE([]);
      },
    }).stream(req({ systemPrompt: "SP", messages: NOTE_MESSAGES })),
  );
  assert.ok(Array.isArray(captured.system));
  // First block is the systemPrompt block, byte-identical to the no-note shape.
  assert.deepEqual(captured.system[0], { type: "text", text: "SP", cache_control: { type: "ephemeral" } });
  const notes = captured.system.slice(1);
  assert.ok(notes.some((b: any) => b.text === "PIN-A1"), "the folded note block is present");
  for (const block of notes) assert.ok(!("cache_control" in block), "a folded note block carries no cache_control");
});
