/**
 * A real provider for the Anthropic Messages API, over `fetch` and SSE — no
 * SDK, no extra dependency. It maps EAgent's neutral message/tool shapes to
 * Anthropic's wire format and parses the streaming response back into the
 * kernel's `StreamEvent`s.
 *
 * Configuration is by environment, so the CLI can pick it up automatically:
 *   ANTHROPIC_API_KEY   (required for live use)
 *   ANTHROPIC_BASE_URL  (optional; defaults to https://api.anthropic.com)
 */

import type {
  CompletionRequest,
  ContentBlock,
  Message,
  Provider,
  StopReason,
  StreamEvent,
  ToolSpec,
  Usage,
} from "../kernel/types.js";
import { fetchWithRetry, parseSSE } from "./http.js";

export interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  version?: string;
  maxTokens?: number;
  /** Max retry attempts on 429/5xx/network errors. Default 3. */
  maxRetries?: number;
  /** Injectable `fetch` for testing and proxies. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Mark the system prompt and tools as cacheable. Default true. */
  cache?: boolean;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #version: string;
  readonly #maxTokens: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;
  readonly #cache: boolean;

  constructor(opts: AnthropicOptions = {}) {
    // Accept ANTHROPIC_AUTH_TOKEN as an alias for ANTHROPIC_API_KEY (the
    // Claude-Code / gateway convention). Both are sent as the `x-api-key`
    // header, which Anthropic requires and OpenAI-compatible proxies accept.
    this.#apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "";
    this.#baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.#version = opts.version ?? "2023-06-01";
    this.#maxTokens = opts.maxTokens ?? 4096;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#cache = opts.cache ?? true;
  }

  get configured(): boolean {
    return this.#apiKey.length > 0;
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (!this.#apiKey) throw new Error("AnthropicProvider: ANTHROPIC_API_KEY is not set");

    // Prompt caching: the system prompt and tool definitions are the large,
    // stable prefix of every turn, so marking them `ephemeral` lets Anthropic
    // reuse a cached prefix and bill subsequent turns at a fraction of the
    // input cost. We mark the system block and the final tool (a cache
    // breakpoint covers everything before it).
    const tools = req.tools.map(toAnthropicTool);
    if (this.#cache && tools.length > 0) {
      (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };
    }
    const system =
      this.#cache && req.systemPrompt
        ? [{ type: "text", text: req.systemPrompt, cache_control: { type: "ephemeral" } }]
        : req.systemPrompt;

    const body = {
      model: req.model,
      max_tokens: this.#maxTokens,
      system,
      messages: toAnthropicMessages(req.messages),
      tools,
      stream: true,
    };

    const res = await this.fetchWithRetry(req.signal, body);

    // Assemble blocks as they stream in.
    const blocks = new Map<number, { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; json: string }>();
    let stopReason: StopReason = "end_turn";
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of parseSSE(res.body!)) {
      const data = event.data;
      if (!data || data === "[DONE]") continue;
      let parsed: AnthropicStreamEvent;
      try {
        parsed = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        continue;
      }

      switch (parsed.type) {
        case "message_start": {
          // Initial usage. Cached and freshly-created prefix tokens are still
          // input tokens for accounting; fold them in.
          const u = parsed.message?.usage;
          if (u) {
            usage.inputTokens =
              (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            usage.outputTokens = u.output_tokens ?? 0;
          }
          break;
        }
        case "content_block_start": {
          const cb = parsed.content_block;
          if (cb.type === "text") blocks.set(parsed.index, { type: "text", text: "" });
          else if (cb.type === "tool_use")
            blocks.set(parsed.index, { type: "tool_use", id: cb.id, name: cb.name, json: "" });
          break;
        }
        case "content_block_delta": {
          const block = blocks.get(parsed.index);
          if (!block) break;
          if (parsed.delta.type === "text_delta" && block.type === "text") {
            block.text += parsed.delta.text;
            yield { type: "text_delta", text: parsed.delta.text };
          } else if (parsed.delta.type === "input_json_delta" && block.type === "tool_use") {
            block.json += parsed.delta.partial_json;
          }
          break;
        }
        case "message_delta": {
          if (parsed.delta.stop_reason) stopReason = mapStopReason(parsed.delta.stop_reason);
          if (parsed.usage?.output_tokens !== undefined) usage.outputTokens = parsed.usage.output_tokens;
          break;
        }
        default:
          break;
      }
    }

    const content: ContentBlock[] = [];
    for (const block of [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b)) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else {
        let args: Record<string, unknown> = {};
        try {
          args = block.json ? (JSON.parse(block.json) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        content.push({ type: "tool_call", id: block.id, name: block.name, arguments: args });
        yield { type: "tool_call", id: block.id, name: block.name, arguments: args };
      }
    }

    yield { type: "done", message: { role: "assistant", content }, stopReason, usage };
  }

  /**
   * POST the request, retrying transient failures (429 and 5xx, plus network
   * errors) with exponential backoff. Honors a `retry-after` header when the
   * server provides one, and gives up after `maxRetries` attempts or if the
   * caller aborts. 4xx other than 429 are non-retryable and surface immediately.
   */
  private fetchWithRetry(signal: AbortSignal, body: unknown): Promise<Response> {
    return fetchWithRetry({
      url: `${this.#baseUrl}/v1/messages`,
      headers: { "x-api-key": this.#apiKey, "anthropic-version": this.#version },
      body,
      signal,
      fetchImpl: this.#fetch,
      maxRetries: this.#maxRetries,
      describe: (status, detail) => `Anthropic API error ${status}: ${detail}`,
    });
  }
}

// -- wire-format mapping ----------------------------------------------------

function toAnthropicTool(spec: ToolSpec): unknown {
  return { name: spec.name, description: spec.description, input_schema: spec.parameters };
}

function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // carried via top-level `system`
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: m.content
          .filter((b) => b.type === "tool_result")
          .map((b) => {
            const r = b as Extract<ContentBlock, { type: "tool_result" }>;
            return { type: "tool_result", tool_use_id: r.toolCallId, content: r.content, is_error: r.isError ?? false };
          }),
      });
      continue;
    }
    out.push({
      role: m.role,
      content: m.content.map((b) => {
        if (b.type === "text") return { type: "text", text: b.text };
        if (b.type === "tool_call") return { type: "tool_use", id: b.id, name: b.name, input: b.arguments };
        if (b.type === "image") {
          const source = b.url
            ? { type: "url", url: b.url }
            : { type: "base64", media_type: b.mimeType, data: b.data ?? "" };
          return { type: "image", source };
        }
        return { type: "text", text: "" };
      }),
    });
  }
  return out;
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "stop";
  }
}

// -- minimal stream-event typings -------------------------------------------

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

type AnthropicStreamEvent =
  | { type: "message_start"; message?: { usage?: AnthropicUsage } }
  | { type: "content_block_start"; index: number; content_block: { type: "text" } | { type: "tool_use"; id: string; name: string } }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string } }
  | { type: "message_delta"; delta: { stop_reason?: string }; usage?: AnthropicUsage }
  | { type: "message_stop" | "content_block_stop" | "ping" };
