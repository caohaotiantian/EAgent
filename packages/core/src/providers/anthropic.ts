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
 *
 *   3. **A message is finished only when the PROVIDER says so.** The frame is
 *      `message_start` … `message_delta` (which carries `stop_reason`) … `message_stop`,
 *      and a body that ends without a terminal frame was CUT. Nothing in the bytes of a
 *      severed connection distinguishes it from a model that stopped talking, so the
 *      terminal frame has to be tracked: reporting `finishReason: "stop"` for a cut
 *      journals half an answer as a whole one, and replay then serves the half forever.
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

export interface AnthropicOptions extends HttpOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly version?: string;
  /** USD per million tokens, per model. Pinned by config, never guessed at runtime. */
  readonly prices?: Readonly<Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>>;
  readonly defaultMaxTokens?: number;
}

const DEFAULT_PRICES: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  "claude-opus-5": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = "anthropic";
  readonly #opts: AnthropicOptions;

  constructor(opts: AnthropicOptions) {
    if (opts.apiKey === "") throw err.policy(CODES.E_PROVIDER_AUTH, "anthropic adapter requires an apiKey");
    this.#opts = opts;
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    // WHAT THIS CALL COSTS IN TIME, measured because nothing else can. `UsageRecord.wallMs` is
    // defined as total WORK — `addUsage` says so, and sums it deliberately while noting that
    // elapsed time of concurrent effects is not additive — and both adapters hardcoded 0, so the
    // accumulator had no producer. `loom run` printed `"wallMs": 0` for a run that took seconds.
    const clock = this.#opts.now ?? Date.now;
    const startedAt = clock();
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
    // The provider's own statement that this message is over. See the docstring's third
    // point: without it, "the model stopped" and "the socket did" are the same bytes.
    let closed = false;

    try {
      for await (const frame of modelFrames(res, signal)) {
        if (frame.data === "" || frame.data === "[DONE]") continue;
        const ev = JSON.parse(frame.data) as AnthropicEvent;

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
            // A stop reason is the model saying why it stopped, which closes the message on
            // its own: `message_stop` is a separate frame and a proxy that trims the tail
            // would otherwise turn every complete answer into a truncation.
            if (ev.delta?.stop_reason !== undefined) {
              finishReason = mapStop(ev.delta.stop_reason);
              closed = true;
            }
            if (ev.usage?.output_tokens !== undefined) outputTokens = ev.usage.output_tokens;
            break;
          }
          case "message_stop": {
            closed = true;
            break;
          }
          case "error": {
            // THE ONE STRING IN THIS FILE THE REMOTE PARTY WRITES, and it is on its way to an
            // append-only journal row via `errorRecord`. It is not masked HERE — the catch
            // below hands every exit of this loop to `normalizeTransport`, which sweeps and
            // bounds foreign text on both of its arms, and a second sweep here would be the
            // private copy `security/redact.ts` spent two waves consolidating.
            //
            // THAT IS A DEPENDENCE ON A CALLER, so it is named rather than assumed: this
            // `throw` is inside the `try`, the catch is unconditional, and the arm that
            // catches it was for a wave the arm that returned BEFORE any redaction — measured,
            // an `error` frame carrying `https://svc:p@ssw0rd-tail@api.example.com/v1` reached
            // `errorRecord` verbatim. `test/providers/http.test.ts` drives this adapter with
            // exactly that frame and asserts the journaled bytes, so the dependence is held by
            // a test rather than by this comment.
            throw err.unavailable(CODES.E_PROVIDER_TRANSPORT, ev.error?.message ?? "provider stream error");
          }
          default:
            break;
        }
      }
    } catch (e) {
      // The caller may already have seen deltas, so re-streaming would double-emit and
      // double-count: this propagates rather than retrying, whatever it caught.
      // `normalizeTransport` keeps a class the inner layer already decided — a cancel out of
      // `sse` stays `cancelled` rather than becoming a retryable transport failure.
      throw normalizeTransport(e);
    }

    if (!closed) {
      // Incomplete, and the two ways to be incomplete are not the same fact. A cancelled run
      // tears down its own socket, so the body reads as simply ended — calling that
      // `unavailable` hands the retry ladder a licence to re-run what a person stopped.
      if (signal.aborted) throw err.cancelled("model stream cancelled before the message ended");
      throw err.unavailable(CODES.E_PROVIDER_TRANSPORT, "provider stream ended without a terminal frame — the response was cut", {
        details: { textChars: text.length, toolCalls: toolCalls.length },
      });
    }

    const usage: UsageRecord = {
      inputTokens,
      outputTokens,
      costUsd: this.priceOf(req.model, {
        inputTokens,
        outputTokens,
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
      }),
      wallMs: Math.max(0, clock() - startedAt),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
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
    yield { type: "done", message, finishReason: truncated || toolCalls.length === 0 ? finishReason : "tool_use", usage };
  }

  /**
   * Cached tokens are priced when the table says so, and were captured and thrown away before.
   *
   * The adapter has always READ `cache_read_input_tokens`/`cache_creation_input_tokens` off the
   * wire and put them on the `UsageRecord`; `priceOf` could not see them, because its parameter
   * named two fields. So every cached turn settled at the full input rate — the ledger was
   * wrong in the SAFE direction for a read (cache read is ~10x cheaper) and the UNSAFE one for
   * a write (cache creation costs ~1.25x input), and a budget compares against that number.
   *
   * A table row without the cache rates falls back to the input rate, which is the old
   * behaviour exactly: an operator who has not priced their cache is not silently given one.
   */
  priceOf(model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number {
    const p = this.#opts.prices?.[model] ?? DEFAULT_PRICES[model];
    if (p === undefined) return 0;
    return round6(
      (usage.inputTokens / 1e6) * p.input +
        (usage.outputTokens / 1e6) * p.output +
        ((usage.cacheReadTokens ?? 0) / 1e6) * (p.cacheRead ?? p.input) +
        ((usage.cacheWriteTokens ?? 0) / 1e6) * (p.cacheWrite ?? p.input),
    );
  }

  /**
   * The number this adapter is about to put in `max_tokens`, and nothing else.
   *
   * ONE EXPRESSION, THREE READERS — see `OpenAIAdapter.outputCeilingOf` for the defect that
   * made having three copies of it expensive (D.7.3).
   */
  outputCeilingOf(req: ModelRequest): number {
    return req.maxTokens ?? this.#opts.defaultMaxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  estimateOf(req: ModelRequest): number {
    return this.priceOf(req.model, { inputTokens: roughTokens(req), outputTokens: this.outputCeilingOf(req) });
  }

  #body(req: ModelRequest): unknown {
    const messages = req.messages.map((m) => toAnthropicMessage(m));
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: this.outputCeilingOf(req),
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
    // THE TWO NORMAL ENDINGS, named rather than defaulted. `end_turn` is the ordinary one and
    // `stop_sequence` is a caller-supplied stop being hit; both are finished answers.
    case "end_turn":
    case "stop_sequence":
      return "stop";
    default:
      // NOT `"stop"`. Anything outside the documented set — `pause_turn` among them, which means
      // "the model paused and can be resumed" — is not an answer, and saying so is the engine's
      // job rather than this mapper's.
      return `unknown:${reason}`;
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
