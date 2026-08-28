/**
 * OpenAI Chat Completions adapter — `fetch` + SSE, no SDK.
 *
 * Also reaches any OpenAI-compatible endpoint (Azure, Together, Groq, vLLM, Ollama)
 * via `baseUrl`, which is how self-hosted models are supported without a third
 * adapter. That matters for the fallback chain's `degrade: true` tier: the cheap
 * local model is the same code path as the expensive hosted one.
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
import { DEFAULT_MAX_OUTPUT_TOKENS, normalizeTransport, postJson, modelFrames, type HttpOptions } from "./http.ts";
import { round6, roughTokens } from "./anthropic.ts";

export interface OpenAIOptions extends HttpOptions {
  readonly apiKey: string;
  /** Any OpenAI-compatible endpoint. Default is OpenAI itself. */
  readonly baseUrl?: string;
  readonly prices?: Readonly<Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>>;
  readonly defaultMaxTokens?: number;
  readonly provider?: string;
}

const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-5": { input: 5, output: 15 },
  "gpt-5-mini": { input: 0.6, output: 2.4 },
};

export class OpenAIAdapter implements ModelAdapter {
  readonly provider: string;
  readonly #opts: OpenAIOptions;

  constructor(opts: OpenAIOptions) {
    // A local endpoint legitimately needs no key, so the check is on reachability
    // rather than on credentials.
    if (opts.apiKey === "" && opts.baseUrl === undefined) {
      throw err.policy(CODES.E_PROVIDER_AUTH, "openai adapter requires an apiKey or a baseUrl");
    }
    this.provider = opts.provider ?? "openai";
    this.#opts = opts;
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    // See `AnthropicAdapter.stream` — the same accumulator, the same missing producer.
    const clock = this.#opts.now ?? Date.now;
    const startedAt = clock();
    const url = `${this.#opts.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;
    const res = await postJson(
      url,
      {
        headers: this.#opts.apiKey === "" ? {} : { authorization: `Bearer ${this.#opts.apiKey}` },
        body: this.#body(req),
        signal,
      },
      this.#opts,
    );

    let text = "";
    // Tool calls stream as indexed fragments; accumulate then materialise in order.
    const partial = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: FinishReason = "stop";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const frame of modelFrames(res, signal)) {
        if (frame.data === "" || frame.data === "[DONE]") continue;
        const chunk = JSON.parse(frame.data) as OpenAIChunk;

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content !== undefined && delta.content !== null && delta.content !== "") {
          text += delta.content;
          yield { type: "text_delta", text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const index = tc.index ?? 0;
          const acc = partial.get(index) ?? { id: "", name: "", args: "" };
          if (tc.id !== undefined) acc.id = tc.id;
          if (tc.function?.name !== undefined) acc.name = tc.function.name;
          if (tc.function?.arguments !== undefined) acc.args += tc.function.arguments;
          partial.set(index, acc);
        }
        if (choice?.finish_reason != null) finishReason = mapFinish(choice.finish_reason);
        if (chunk.usage != null) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        }
      }
    } catch (e) {
      throw normalizeTransport(e);
    }

    const toolCalls: ModelToolCall[] = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => ({ id: acc.id, name: acc.name, arguments: safeJson(acc.args) }));

    if (outputTokens === 0) outputTokens = Math.max(1, Math.ceil(text.length / 4));
    if (inputTokens === 0) inputTokens = roughTokens(req);

    const usage: UsageRecord = {
      inputTokens,
      outputTokens,
      costUsd: this.priceOf(req.model, { inputTokens, outputTokens }),
      wallMs: Math.max(0, clock() - startedAt),
    };
    // A TRUNCATED TURN IS NOT A TOOL CALL. `finishReason` was overridden to `tool_use` whenever
    // any tool call was parsed, which erased `max_tokens` — and a tool call whose argument JSON
    // was cut mid-stream is debris, not a request: the parser turns unparseable arguments into
    // `{}`, so the engine dispatched the tool with EMPTY arguments and called it a clean
    // `tool_use`. `fs.write` with `{}` is not a smaller version of the intended write.
    //
    // So a truncated turn keeps `max_tokens` and drops its partial calls, and the engine refuses
    // it — `turnRefusal` in `run/engine.ts`. The claim this comment used to make, that "the node
    // then fails its schema check", was only true of a node that DECLARES an `outputSchema`: FX13
    // was a node with none, and `""` is valid free text. Reporting the reason faithfully is this
    // file's whole job; acting on it is the engine's.
    const truncated = finishReason === "max_tokens";
    const message: Message = {
      role: "assistant",
      content: text,
      ...(toolCalls.length === 0 || truncated ? {} : { toolCalls }),
    };
    yield { type: "done", message, provider: this.provider, finishReason: truncated || toolCalls.length === 0 ? finishReason : "tool_use", usage };
  }

  priceOf(model: string, usage: { inputTokens: number; outputTokens: number }): number {
    const p = this.#opts.prices?.[model] ?? DEFAULT_PRICES[model];
    if (p === undefined) return 0;
    return round6((usage.inputTokens / 1e6) * p.input + (usage.outputTokens / 1e6) * p.output);
  }

  /**
   * The number this adapter is about to put in `max_completion_tokens`, and nothing else.
   *
   * ONE EXPRESSION, THREE READERS. It used to be written out at `estimateOf` and again in
   * `#body`, and the engine's token reservation had a third copy with a DIFFERENT constant —
   * 1,024 against this file's 4,096 — so `budget.tokens` reserved a quarter of what the body
   * asked for. D.7.3. The resolution rule now lives here and the body reads it.
   */
  outputCeilingOf(req: ModelRequest): number {
    return req.maxTokens ?? this.#opts.defaultMaxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  estimateOf(req: ModelRequest): number {
    return this.priceOf(req.model, { inputTokens: roughTokens(req), outputTokens: this.outputCeilingOf(req) });
  }

  #body(req: ModelRequest): unknown {
    const messages: unknown[] = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      if (m.role === "tool") {
        messages.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content });
        continue;
      }
      if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: m.content === "" ? null : m.content,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        });
        continue;
      }
      messages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      // Without this many OpenAI-compatible servers omit usage entirely, and cost
      // accounting silently reports zero.
      stream_options: { include_usage: true },
      max_completion_tokens: this.outputCeilingOf(req),
      messages,
    };
    if (req.tools.length > 0) body["tools"] = req.tools.map(toOpenAITool);
    return body;
  }
}

function toOpenAITool(t: ToolSpec): unknown {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function mapFinish(reason: string): FinishReason {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "content_filter";
    // The legacy spelling of `tool_calls`, still returned by some OpenAI-compatible endpoints.
    case "function_call":
      return "tool_use";
    case "stop":
      return "stop";
    default:
      // NOT `"stop"`. See `FinishReason`: mapping an unknown reason to "stop" tells the engine
      // this turn is a finished answer, and the engine believes it.
      return `unknown:${reason}`;
  }
}

function safeJson(text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------

interface OpenAIChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}
