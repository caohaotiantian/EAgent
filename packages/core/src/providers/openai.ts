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
import { producedTokens, round6, roughTokens } from "./anthropic.ts";
import { estimateTokens, resolvePrice, toleratedFloor, wireCount, type PriceRow } from "./usage.ts";

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
    // See `AnthropicAdapter.stream`: the counter starts at 0, so "the provider did not say" and
    // "the provider said zero" are the same bytes until something else remembers which.
    let sawOutputUsage = false;
    // CHARACTERS THIS FUNCTION RECEIVED, counted from the RAW argument fragments rather than from
    // the parsed calls — `safeJson` turns a cut-off argument into `{}`. See `producedTokens`.
    let producedChars = 0;

    try {
      for await (const frame of modelFrames(res, signal)) {
        if (frame.data === "" || frame.data === "[DONE]") continue;
        const chunk = JSON.parse(frame.data) as OpenAIChunk;

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content !== undefined && delta.content !== null && delta.content !== "") {
          text += delta.content;
          producedChars += delta.content.length;
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
          const inp = wireCount(chunk.usage.prompt_tokens);
          if (inp !== undefined) inputTokens = inp;
          const out = wireCount(chunk.usage.completion_tokens);
          if (out !== undefined) {
            outputTokens = out;
            sawOutputUsage = true;
          }
        }
      }
    } catch (e) {
      throw normalizeTransport(e);
    }

    const toolCalls: ModelToolCall[] = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => ({ id: acc.id, name: acc.name, arguments: safeJson(acc.args) }));

    // FLOORED on everything the turn produced, and the estimators are imported from
    // `anthropic.ts` rather than copied so the two adapters cannot answer a missing usage frame
    // differently — an OpenAI-wire gateway behind `baseUrl` is exactly as likely to send none.
    // `text` is EMPTY on a `tool_use` turn, so a text-only floor charged one output token for a
    // whole tool call; `producedTokens` reads the calls too.
    //
    // A REPORTED ZERO IS BELIEVED ONLY WHERE THIS ADAPTER HOLDS NO EVIDENCE AGAINST IT — see
    // `AnthropicAdapter.stream` for the measurement and the reasoning. The OUTPUT rule is the
    // same one and is meant to stay the same one: a zero beside text or a tool call contradicts
    // bytes this function received.
    //
    // THE INPUT RULE IS STRICTER HERE, AND THE WIRE IS WHY. `OpenAIChunk` declares
    // `prompt_tokens` and `completion_tokens` and nothing else, so no field on this wire can
    // account for a prompt the adapter demonstrably sent — there is no cache count to make a
    // zero honest, as there is on the Anthropic side. `prompt_tokens: 0` is therefore refused
    // outright, and an endpoint that wants its cache read believed has to report it as input.
    //
    // AND THE ZERO RULES ARE NOT THE WHOLE FLOOR, because a wire defeats each of them by
    // asserting 1. The quantitative rule that follows each of them is the same one the Anthropic
    // adapter runs, off the same constant: `USAGE_TOLERANCE` in `usage.ts` carries the
    // measurement that chose it.
    for (const acc of partial.values()) producedChars += acc.id.length + acc.name.length + acc.args.length;
    const produced = Math.max(producedTokens(text, toolCalls), estimateTokens(producedChars));
    const producedAnything = text !== "" || toolCalls.length > 0 || producedChars > 0;
    if (!sawOutputUsage || (outputTokens === 0 && producedAnything)) {
      outputTokens = produced;
    } else if (producedAnything) {
      outputTokens = Math.max(outputTokens, toleratedFloor(produced));
    }

    if (inputTokens === 0) inputTokens = roughTokens(req);
    else inputTokens = Math.max(inputTokens, toleratedFloor(roughTokens(req)));

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

  /** See `AnthropicAdapter.priceOf` and `resolvePrice`: a model with no table row is not free. */
  priceOf(model: string, usage: { inputTokens: number; outputTokens: number }): number {
    const p = resolvePrice({ ...DEFAULT_PRICES, ...(this.#opts.prices ?? {}) } as Record<string, PriceRow>, model);
    if (p === undefined) return 0;
    const cost = round6((usage.inputTokens / 1e6) * p.input + (usage.outputTokens / 1e6) * p.output);
    // See `AnthropicAdapter.priceOf`: a cost that is not a non-negative number is refused
    // rather than handed to a budget that would then stop binding.
    if (!Number.isFinite(cost) || cost < 0) {
      throw err.validation(CODES.E_CONFIG_INVALID, `price table for ${model} produced a cost that is not a non-negative number`);
    }
    return cost;
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
  // `unknown` AND NOT `number`: this is `JSON.parse` output, so the annotation would be a claim
  // about bytes a remote party wrote. `wireCount` is what actually decides.
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
}
