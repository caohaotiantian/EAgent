/**
 * Example extension: a custom LLM provider.
 *
 * The kernel knows nothing about specific models — a provider is just an object
 * that turns a request into a stream of events. This example registers a
 * trivial "shout" provider (it upper-cases the last user message) to show the
 * shape; a real one would call an API over `fetch`, like the built-in Anthropic,
 * OpenAI, and Gemini providers do.
 *
 *   eagent --ext examples/extensions/echo-provider.ts --provider shout
 */

import type { ExtensionAPI } from "../../src/kernel/extension.js";
import type { CompletionRequest, Provider, StreamEvent } from "../../src/kernel/types.js";

const shoutProvider: Provider = {
  name: "shout",
  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content.find((b) => b.type === "text");
    const out = (text && text.type === "text" ? text.text : "hello").toUpperCase() + "!";
    // Stream it in a couple of chunks, then finish with a `done` event.
    yield { type: "text_delta", text: out.slice(0, out.length >> 1) };
    yield { type: "text_delta", text: out.slice(out.length >> 1) };
    yield {
      type: "done",
      message: { role: "assistant", content: [{ type: "text", text: out }] },
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: out.length },
    };
  },
};

export default function activate(e: ExtensionAPI) {
  e.registerProvider(shoutProvider);
  e.log.info('registered the "shout" provider — try /provider shout');
}
