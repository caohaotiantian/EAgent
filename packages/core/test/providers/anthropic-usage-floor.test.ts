/**
 * "THE PROVIDER DID NOT SAY WHAT THIS COST" WAS ANSWERED WITH "IT COST NOTHING".
 *
 * `inputTokens` and `outputTokens` are initialised to 0 and only a usage frame moves them, so a
 * stream that carries none — an Anthropic-wire-compatible gateway behind `baseUrl`, which is the
 * documented use for that option — produced a real answer with `usage: {0, 0, costUsd: 0}`.
 * That is the PASSING value for every budget guard downstream: `budget.runUsd`, the per-node
 * `budget.costUsd`, `budget.tokens` and the E2/E3 escalations all became unreachable, and an
 * agent loop ran to `maxTurns` with no ceiling.
 *
 * `OpenAIAdapter` floors both, twenty lines away in the sibling file, and imports `roughTokens`
 * from this one. The sweep covered one adapter of two.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AnthropicAdapter } from "../../src/providers/anthropic.ts";
import { OpenAIAdapter } from "../../src/providers/openai.ts";
import type { ModelEvent, ModelRequest } from "../../src/run/registry.ts";

const REQ: ModelRequest = {
  model: "claude-sonnet-5",
  system: "be brief",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

const ac = (): AbortSignal => new AbortController().signal;

function sseFetch(frames: readonly string[]) {
  return async (): Promise<Response> =>
    new Response(frames.map((f) => `${f}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
}

async function done(it: AsyncIterable<ModelEvent>): Promise<Extract<ModelEvent, { type: "done" }>> {
  let last: ModelEvent | undefined;
  for await (const ev of it) last = ev;
  assert.equal(last?.type, "done");
  return last as Extract<ModelEvent, { type: "done" }>;
}

const ANSWER = "The answer is forty-two, because the question was badly posed.";

// A well-formed, complete stream that simply never mentions usage: `message_start` with no
// `usage`, text deltas, a `message_delta` carrying only `stop_reason`, and `message_stop`.
const NO_USAGE = [
  `event: message_start\ndata: {"type":"message_start","message":{}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(ANSWER)}}}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
];

test("a completed turn whose stream carried no usage is never journaled as free", async () => {
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(NO_USAGE), prices: { "claude-sonnet-5": { input: 3, output: 15 } } });
  const d = await done(a.stream(REQ, ac()));
  assert.equal(d.finishReason, "stop", "the turn really did complete — this is not an error path");
  assert.ok(d.usage.outputTokens > 0, `output must be floored from the text actually produced, got ${d.usage.outputTokens}`);
  assert.ok(d.usage.inputTokens > 0, `input must be floored from the request, got ${d.usage.inputTokens}`);
  assert.ok(d.usage.costUsd > 0, `a turn that produced ${ANSWER.length} characters must not cost 0, got ${d.usage.costUsd}`);
});

test("...and it estimates the same way OpenAIAdapter does, which is where the floor already was", async () => {
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(NO_USAGE) });
  const d = await done(a.stream(REQ, ac()));
  assert.equal(d.usage.outputTokens, Math.max(1, Math.ceil(ANSWER.length / 4)), "ceil(chars/4), as openai.ts floors it");
  // The input floor is `roughTokens(req)`, the same function openai.ts imports FROM this file.
  const o = new OpenAIAdapter({
    apiKey: "k",
    fetch: async () =>
      new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(ANSWER)}},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  const od = await done(o.stream({ ...REQ, model: "gpt-5" }, ac()));
  assert.equal(d.usage.inputTokens, od.usage.inputTokens, "both adapters floor input from the same request");
  assert.equal(d.usage.outputTokens, od.usage.outputTokens, "and output from the same text");
});

test("a REPORTED usage still wins — the floor must never overwrite what the provider said", async () => {
  const reported = [
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(ANSWER)}}}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ];
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(reported) });
  const d = await done(a.stream(REQ, ac()));
  assert.equal(d.usage.inputTokens, 9, "9 reported, not the ~20 the estimate would produce");
  assert.equal(d.usage.outputTokens, 4, "4 reported, not the ~16 the estimate would produce");
});

test("an EMPTY completed turn is charged for its input, and one output token", async () => {
  // No text at all — a tool-only turn from a gateway that reports nothing. `Math.max(1, …)` is
  // the difference between "cheap" and "free", and only the second one unbinds a ceiling.
  const empty = [
    `event: message_start\ndata: {"type":"message_start","message":{}}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ];
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(empty) });
  const d = await done(a.stream(REQ, ac()));
  assert.equal(d.usage.outputTokens, 1);
  assert.ok(d.usage.inputTokens > 0);
});
