/**
 * Anthropic Messages API adapter — `fetch` + SSE, no SDK.
 *
 * Two things here are load-bearing beyond "it talks to the API":
 *
 *   1. **A post-first-event failure is never retried.** Once deltas have reached the
 *      UI and usage has been counted, re-streaming would double-emit both. Retrying
 *      is only safe before the first event, which `postJson` already bounds.
 *
 *   2. **Prompt caching keys on the stable prefix** (system + tools). Because a
 *      node's context is rebuilt from declared projections rather than accumulated,
 *      that prefix really is stable across a run's turns, so the cache hit rate is a
 *      property of the architecture rather than of prompt discipline.
 */

import { CODES, err } from "../errors.ts";
import type { UsageRecord } from "../vocab.ts";
import type {
  FinishReason,
  Message,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  ModelToolCall,
  ToolSpec,
} from "../run/registry.ts";
import { normalizeTransport, postJson, sse, type HttpOptions } from "./http.ts";

export interface AnthropicOptions extends HttpOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly version?: string;
  /** USD per million tokens, per model. Pinned by config, never guessed at runtime. */
  readonly prices?: Readonly<Record<string, { input: number; output: number }>>;
  readonly defaultMaxTokens?: number;
}

const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
};

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = "anthropic";
  readonly #opts: AnthropicOptions;

  constructor(opts: AnthropicOptions) {
    if (opts.apiKey === "") throw err.policy(CODES.E_PROVIDER_AUTH, "anthropic adapter requires an apiKey");
    this.#opts = opts;
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const url = `${this.#opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
    const res = await postJson(
      url,
      {
        headers: {
          "x-api-key": this.#opts.apiKey,
          "anthropic-version": this.#opts.version ?? "2023-06-01",
        },
        body: this.#body(req),
        signal,
      },
      this.#opts,
    );

    let text = "";
    const toolCalls: ModelToolCall[] = [];
    // Tool arguments arrive as a JSON string in fragments, so they are accumulated
    // per content-block index and parsed once at the block's stop.
    const partial = new Map<number, { id: string; name: string; json: string }>();
    let finishReason: FinishReason = "stop";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    let committed = false;

    try {
      for await (const frame of sse(res, signal)) {
        if (frame.data === "" || frame.data === "[DONE]") continue;
        const ev = JSON.parse(frame.data) as AnthropicEvent;
        committed = true;

        switch (ev.type) {
          case "message_start": {
            const u = ev.message?.usage;
            if (u !== undefined) {
              inputTokens = u.input_tokens ?? 0;
              if (u.cache_read_input_tokens !== undefined) cacheReadTokens = u.cache_read_input_tokens;
              if (u.cache_creation_input_tokens !== undefined) cacheWriteTokens = u.cache_creation_input_tokens;
            }
            break;
          }
          case "content_block_start": {
            const block = ev.content_block;
            if (block?.type === "tool_use" && ev.index !== undefined) {
              partial.set(ev.index, { id: block.id ?? "", name: block.name ?? "", json: "" });
            }
            break;
          }
          case "content_block_delta": {
            const d = ev.delta;
            if (d?.type === "text_delta" && d.text !== undefined) {
              text += d.text;
              yield { type: "text_delta", text: d.text };
            } else if (d?.type === "input_json_delta" && ev.index !== undefined) {
              const acc = partial.get(ev.index);
              if (acc !== undefined) acc.json += d.partial_json ?? "";
            }
            break;
          }
          case "content_block_stop": {
            if (ev.index === undefined) break;
            const acc = partial.get(ev.index);
            if (acc === undefined) break;
            partial.delete(ev.index);
            toolCalls.push({ id: acc.id, name: acc.name, arguments: safeJson(acc.json) });
            break;
          }
          case "message_delta": {
            if (ev.delta?.stop_reason !== undefined) finishReason = mapStop(ev.delta.stop_reason);
            if (ev.usage?.output_tokens !== undefined) outputTokens = ev.usage.output_tokens;
            break;
          }
          case "error": {
            throw err.unavailable(CODES.E_PROVIDER_TRANSPORT, ev.error?.message ?? "provider stream error");
          }
          default:
            break;
        }
      }
    } catch (e) {
      // Past the first event, the caller has already seen deltas. Re-streaming would
      // double-emit, so this always propagates rather than retrying.
      throw committed ? normalizeTransport(e) : normalizeTransport(e);
    }

    const usage: UsageRecord = {
      inputTokens,
      outputTokens,
      costUsd: this.priceOf(req.model, { inputTokens, outputTokens }),
      wallMs: 0,
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    };
    const message: Message = {
      role: "assistant",
      content: text,
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
    };
    yield { type: "done", message, finishReason: toolCalls.length > 0 ? "tool_use" : finishReason, usage };
  }

  priceOf(model: string, usage: { inputTokens: number; outputTokens: number }): number {
    const p = this.#opts.prices?.[model] ?? DEFAULT_PRICES[model];
    if (p === undefined) return 0;
    return round6((usage.inputTokens / 1e6) * p.input + (usage.outputTokens / 1e6) * p.output);
  }

  estimateOf(req: ModelRequest): number {
    const maxOut = req.maxTokens ?? this.#opts.defaultMaxTokens ?? 4096;
    return this.priceOf(req.model, { inputTokens: roughTokens(req), outputTokens: maxOut });
  }

  #body(req: ModelRequest): unknown {
    const messages = req.messages.map((m) => toAnthropicMessage(m));
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? this.#opts.defaultMaxTokens ?? 4096,
      stream: true,
      // `cache_control` on the last system block marks the stable prefix. It is
      // stable here because context is rebuilt from declared projections, not
      // accumulated across turns.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages,
    };
    if (req.tools.length > 0) body["tools"] = req.tools.map(toAnthropicTool);
    return body;
  }
}

function toAnthropicTool(t: ToolSpec): unknown {
  return { name: t.name, description: t.description, input_schema: t.parameters };
}

function toAnthropicMessage(m: Message): unknown {
  if (m.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content }],
    };
  }
  const content: unknown[] = [];
  if (m.content !== "") content.push({ type: "text", text: m.content });
  for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
  return { role: m.role === "assistant" ? "assistant" : "user", content };
}

function mapStop(reason: string): FinishReason {
  switch (reason) {
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "refusal";
    default:
      return "stop";
  }
}

/** A malformed argument fragment must not crash the stream; the tool's schema catches it. */
function safeJson(text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function roughTokens(req: ModelRequest): number {
  let chars = req.system.length;
  for (const m of req.messages) chars += m.content.length;
  for (const t of req.tools) chars += t.name.length + t.description.length + JSON.stringify(t.parameters).length;
  return Math.max(1, Math.ceil(chars / 4));
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------

interface AnthropicEvent {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}
