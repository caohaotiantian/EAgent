/**
 * A provider for the OpenAI Chat Completions API (and the many
 * OpenAI-compatible endpoints: Azure, Together, Groq, Ollama, vLLM, …).
 *
 * Its existence is the point: a second real provider proves the kernel's
 * `Provider` abstraction is genuinely neutral. Like the Anthropic provider it
 * is `fetch` + SSE with no SDK, shares the retry/backoff plumbing, and maps
 * EAgent's neutral message/tool shapes to and from the wire format.
 *
 * Configuration by environment:
 *   OPENAI_API_KEY    (required for live use)
 *   OPENAI_BASE_URL   (optional; defaults to https://api.openai.com/v1)
 */

import type {
  CompletionRequest,
  ContentBlock,
  Message,
  Provider,
  StopReason,
  StreamEvent,
  ToolChoice,
  ToolSpec,
  Usage,
} from "../kernel/types.js";
import { fetchWithRetry, parseSSE } from "./http.js";

export interface OpenAIOptions {
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  /**
   * Which JSON field carries the output-token limit. Newer official OpenAI
   * models require `max_completion_tokens`; most OpenAI-compatible proxies
   * (vLLM, Ollama, GLM gateways) expect `max_tokens`. Defaults to `max_tokens`,
   * overridable via `OPENAI_MAX_TOKENS_PARAM`.
   */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
}

export class OpenAIProvider implements Provider {
  readonly name = "openai";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #maxTokens: number;
  readonly #maxTokensParam: "max_tokens" | "max_completion_tokens";
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;

  constructor(opts: OpenAIOptions = {}) {
    this.#apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.#baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.#maxTokens = opts.maxTokens ?? 4096;
    this.#maxTokensParam =
      opts.maxTokensParam ??
      (process.env.OPENAI_MAX_TOKENS_PARAM === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens");
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#fetch = opts.fetch ?? globalThis.fetch;
  }

  get configured(): boolean {
    return this.#apiKey.length > 0;
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (!this.#apiKey) throw new Error("OpenAIProvider: OPENAI_API_KEY is not set");

    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.systemPrompt, req.messages),
      tools: req.tools.length ? req.tools.map(toOpenAITool) : undefined,
      stream: true,
      stream_options: { include_usage: true },
    };
    body[this.#maxTokensParam] = this.#maxTokens;
    // Reasoning models (o-series, GPT-5, and compatible gateways) take a
    // `reasoning_effort` dial. `off` omits it so non-reasoning models are
    // unaffected.
    if (req.thinking && req.thinking !== "off") body.reasoning_effort = req.thinking;
    // Decode-time forcing: OpenAI's `tool_choice` forces a named function or
    // requires some tool; `"auto"`/absent omits it (the default, byte-identical
    // to before).
    // Only emit tool_choice when tools are actually declared (mirrors gemini's
    // tools-present guard) — forcing a tool with no tools present is an API error.
    const toolChoice = toOpenAIToolChoice(req.toolChoice);
    if (toolChoice !== undefined && req.tools.length) body.tool_choice = toolChoice;

    const res = await fetchWithRetry({
      url: `${this.#baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.#apiKey}` },
      body,
      signal: req.signal,
      fetchImpl: this.#fetch,
      maxRetries: this.#maxRetries,
      describe: (status, detail) => `OpenAI API error ${status}: ${detail}`,
    });

    let textBuffer = "";
    // Tool calls arrive as deltas keyed by index; assemble name + arg JSON.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: StopReason = "end_turn";
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of parseSSE(res.body!)) {
      const data = event.data;
      if (!data || data === "[DONE]") continue;
      let parsed: OpenAIChunk;
      try {
        parsed = JSON.parse(data) as OpenAIChunk;
      } catch {
        continue;
      }

      if (parsed.usage) {
        usage.inputTokens = parsed.usage.prompt_tokens ?? usage.inputTokens;
        usage.outputTokens = parsed.usage.completion_tokens ?? usage.outputTokens;
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      if (choice.delta?.content) {
        textBuffer += choice.delta.content;
        yield { type: "text_delta", text: choice.delta.content };
      }
      // Some reasoning endpoints stream the chain of thought on a sibling
      // `reasoning_content` field. Surface it without folding it into the answer.
      if (choice.delta?.reasoning_content) {
        yield { type: "reasoning_delta", text: choice.delta.reasoning_content };
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const slot = toolCalls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        toolCalls.set(tc.index, slot);
      }
      if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason);
    }

    const content: ContentBlock[] = [];
    if (textBuffer) content.push({ type: "text", text: textBuffer });
    for (const [index, slot] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let args: Record<string, unknown> = {};
      try {
        args = slot.args ? (JSON.parse(slot.args) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      // Include the slot index in the synthesized id so two parallel calls to
      // the same tool (when a compat endpoint omits ids) don't collide.
      const id = slot.id || `call_${index}_${slot.name}`;
      content.push({ type: "tool_call", id, name: slot.name, arguments: args });
      yield { type: "tool_call", id, name: slot.name, arguments: args };
    }

    yield { type: "done", message: { role: "assistant", content }, stopReason, usage };
  }
}

// -- wire-format mapping ----------------------------------------------------

function toOpenAITool(spec: ToolSpec): unknown {
  return { type: "function", function: { name: spec.name, description: spec.description, parameters: spec.parameters } };
}

/**
 * Map the neutral `ToolChoice` to OpenAI's `tool_choice`, or `undefined` (omit)
 * for `"auto"`/absent — the no-forcing default. `"required"` is the string
 * `"required"` (call SOME tool); a named choice becomes
 * `{ type: "function", function: { name } }` (call exactly that function).
 */
function toOpenAIToolChoice(choice: ToolChoice | undefined): unknown {
  if (!choice || choice === "auto") return undefined;
  if (choice === "required") return "required";
  return { type: "function", function: { name: choice.name } };
}

function toOpenAIMessages(systemPrompt: string, messages: Message[]): unknown[] {
  const out: unknown[] = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: textOf(m) });
      continue;
    }
    if (m.role === "tool") {
      // Each tool_result becomes its own `tool` message referencing the call.
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.toolCallId, content: b.content });
        }
      }
      continue;
    }
    if (m.role === "assistant") {
      const text = textOf(m);
      const calls = m.content
        .filter((b): b is Extract<ContentBlock, { type: "tool_call" }> => b.type === "tool_call")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.arguments) } }));
      const msg: Record<string, unknown> = { role: "assistant", content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }
    // User messages with images use OpenAI's array content form.
    const images = m.content.filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image");
    if (images.length > 0) {
      const parts: unknown[] = [];
      const t = textOf(m);
      if (t) parts.push({ type: "text", text: t });
      for (const img of images) {
        const url = img.url ?? `data:${img.mimeType};base64,${img.data ?? ""}`;
        parts.push({ type: "image_url", image_url: { url } });
      }
      out.push({ role: "user", content: parts });
      continue;
    }
    out.push({ role: "user", content: textOf(m) });
  }
  return out;
}

function textOf(m: Message): string {
  return m.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "stop";
  }
}

// -- minimal stream-chunk typings -------------------------------------------

interface OpenAIChunk {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
