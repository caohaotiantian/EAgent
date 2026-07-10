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
  ToolChoice,
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
    if (!this.#apiKey)
      throw new Error(
        "AnthropicProvider: no Anthropic API key/token configured (set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)",
      );

    // Prompt caching: the system prompt and tool definitions are the large,
    // stable prefix of every turn, so marking them `ephemeral` lets Anthropic
    // reuse a cached prefix and bill subsequent turns at a fraction of the
    // input cost. We mark the system block and the final tool (a cache
    // breakpoint covers everything before it).
    const tools = req.tools.map(toAnthropicTool);
    if (this.#cache && tools.length > 0) {
      (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };
    }
    // Fold any in-transcript `role:"system"` messages into the top-level system
    // channel — Anthropic has no positional system role inside `messages`, so
    // dropping them would leave the whole context-injection layer dark. Notes
    // are appended after the systemPrompt block, uncached, so the existing
    // systemPrompt cache breakpoint is preserved and the no-note path stays
    // byte-identical to before.
    const systemNotes = req.messages
      .filter((m) => m.role === "system")
      .map(systemText)
      .filter((t) => t.length > 0);
    let system: unknown;
    if (systemNotes.length > 0) {
      const blocks: unknown[] = [];
      if (req.systemPrompt) {
        blocks.push(
          this.#cache
            ? { type: "text", text: req.systemPrompt, cache_control: { type: "ephemeral" } }
            : { type: "text", text: req.systemPrompt },
        );
      }
      for (const note of systemNotes) blocks.push({ type: "text", text: note });
      system = blocks;
    } else {
      system =
        this.#cache && req.systemPrompt
          ? [{ type: "text", text: req.systemPrompt, cache_control: { type: "ephemeral" } }]
          : req.systemPrompt;
    }

    // A third breakpoint on the last content block of the last message caches
    // the growing conversation prefix, so each turn reads the prior transcript
    // from cache and writes only its own extension. Total breakpoints stay
    // within Anthropic's limit: system + last tool + last message = 3 of 4.
    const msgs = toAnthropicMessages(req.messages);
    if (this.#cache && msgs.length > 0) {
      const lastMsg = msgs[msgs.length - 1];
      const content = (lastMsg as { content?: unknown }).content;
      if (Array.isArray(content) && content.length > 0) {
        const lastBlock = content[content.length - 1];
        if (lastBlock !== undefined) {
          (lastBlock as Record<string, unknown>).cache_control = { type: "ephemeral" };
        }
      }
    }

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: this.#maxTokens,
      system,
      messages: msgs,
      tools,
      stream: true,
    };

    // Decode-time forcing: Anthropic's `tool_choice` accepts forcing a specific
    // tool by name or requiring *some* tool. `"auto"`/absent omits the key (the
    // default), so a request with no forcing is byte-identical to before.
    const toolChoice = toAnthropicToolChoice(req.toolChoice);
    if (toolChoice) body.tool_choice = toolChoice;

    // Reasoning: modern Claude models (Opus 4.6+, Fable 5) take adaptive
    // thinking plus an `output_config` effort dial — never the legacy
    // `budget_tokens`, which these models reject. `off` sends neither, leaving
    // the model's default (which on always-thinking models is still on).
    if (req.thinking && req.thinking !== "off") {
      body.thinking = { type: "adaptive", display: "summarized" };
      body.output_config = { effort: req.thinking };
    }

    const res = await this.fetchWithRetry(req.signal, body);

    // Assemble blocks as they stream in.
    const blocks = new Map<
      number,
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string; signature: string }
      | { type: "tool_use"; id: string; name: string; json: string }
    >();
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
          // Initial usage. inputTokens is the fresh (non-cached) input; cache
          // read/creation tokens are disjoint siblings, set only when reported.
          const u = parsed.message?.usage;
          if (u) {
            usage.inputTokens = u.input_tokens ?? 0;
            if (u.cache_read_input_tokens !== undefined) usage.cacheReadTokens = u.cache_read_input_tokens;
            if (u.cache_creation_input_tokens !== undefined) usage.cacheWriteTokens = u.cache_creation_input_tokens;
            usage.outputTokens = u.output_tokens ?? 0;
          }
          break;
        }
        case "content_block_start": {
          const cb = parsed.content_block;
          if (cb.type === "text") blocks.set(parsed.index, { type: "text", text: "" });
          else if (cb.type === "thinking")
            blocks.set(parsed.index, { type: "thinking", thinking: "", signature: "" });
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
          } else if (parsed.delta.type === "thinking_delta" && block.type === "thinking") {
            block.thinking += parsed.delta.thinking;
            yield { type: "reasoning_delta", text: parsed.delta.thinking };
          } else if (parsed.delta.type === "signature_delta" && block.type === "thinking") {
            // Opaque token; not surfaced to the user, but kept so the block can
            // be replayed verbatim on the next turn (required under tool use).
            block.signature += parsed.delta.signature;
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
        case "error":
          // A mid-stream API error (e.g. `overloaded_error`, a rate-limit after
          // start). Throw rather than let the loop end and fabricate a `done`
          // with partial content: the committed boundary (agent.ts) then retries
          // a pre-commit error via onProviderError, or rethrows a post-commit one.
          throw new Error(`Anthropic stream error: ${parsed.error?.type}: ${parsed.error?.message}`);
        default:
          break;
      }
    }

    const content: ContentBlock[] = [];
    for (const block of [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b)) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        content.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
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
   * Thin wrapper that POSTs to the Messages endpoint via `http.ts`'s
   * `fetchWithRetry`; see that function for the authoritative retry/backoff
   * and `retry-after` semantics.
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

/** Concatenate a message's `type:"text"` blocks (mirrors `openai.ts` `textOf`). */
function systemText(m: Message): string {
  return m.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Map the neutral `ToolChoice` to Anthropic's `tool_choice`, or `undefined`
 * (omit the key) for `"auto"`/absent — the no-forcing default. `"required"`
 * becomes `{ type: "any" }` (call SOME tool); a named choice becomes
 * `{ type: "tool", name }` (call exactly that tool).
 */
function toAnthropicToolChoice(choice: ToolChoice | undefined): Record<string, unknown> | undefined {
  if (!choice || choice === "auto") return undefined;
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
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
      content: m.content.flatMap((b): unknown[] => {
        if (b.type === "text") return [{ type: "text", text: b.text }];
        if (b.type === "tool_call") return [{ type: "tool_use", id: b.id, name: b.name, input: b.arguments }];
        // Replay a thinking block only with its signature — Anthropic rejects a
        // modified or unsigned one. Drop signatureless blocks (e.g. carried over
        // from another provider) rather than risk a 400.
        if (b.type === "thinking")
          return b.signature ? [{ type: "thinking", thinking: b.thinking, signature: b.signature }] : [];
        if (b.type === "image") {
          const source = b.url
            ? { type: "url", url: b.url }
            : { type: "base64", media_type: b.mimeType, data: b.data ?? "" };
          return [{ type: "image", source }];
        }
        return [{ type: "text", text: "" }];
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
    case "refusal":
      return "refusal";
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
  | {
      type: "content_block_start";
      index: number;
      content_block: { type: "text" } | { type: "thinking" } | { type: "tool_use"; id: string; name: string };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "message_delta"; delta: { stop_reason?: string }; usage?: AnthropicUsage }
  | { type: "error"; error?: { type?: string; message?: string } }
  | { type: "message_stop" | "content_block_stop" | "ping" };
