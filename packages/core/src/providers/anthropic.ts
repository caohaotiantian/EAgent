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
import { billableTokens, dearestRateFloor, estimateTokens, resolvePrice, toleratedFloor, wireCount, type PriceRow } from "./usage.ts";

export interface AnthropicOptions extends HttpOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly version?: string;
  /** USD per million tokens, per model. Pinned by config, never guessed at runtime. */
  readonly prices?: Readonly<Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>>;
  readonly defaultMaxTokens?: number;
  /**
   * What this row calls itself in the journal, defaulting to `"anthropic"`.
   *
   * D.7.6. `provider` used to be a hard-coded literal here while `OpenAIAdapter` already took
   * the option -- the asymmetry that hid the wider defect. Without it, two anthropic rows named
   * `claude-fast` and `claude-big` are indistinguishable in `model.called` even once the router
   * stops overwriting them, so the journal cannot say which of the operator's own configured
   * endpoints served a turn.
   */
  readonly provider?: string;
}

const DEFAULT_PRICES: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  "claude-opus-5": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

export class AnthropicAdapter implements ModelAdapter {
  readonly provider: string;
  readonly #opts: AnthropicOptions;

  constructor(opts: AnthropicOptions) {
    if (opts.apiKey === "") throw err.policy(CODES.E_PROVIDER_AUTH, "anthropic adapter requires an apiKey");
    this.provider = opts.provider ?? "anthropic";
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
    // "THE PROVIDER DID NOT SAY" AND "THE PROVIDER SAID ZERO" ARE DIFFERENT FACTS, and the
    // counter cannot tell them apart on its own because both start at 0. This one can.
    // See the floor below for what conflating them charged, and for why the INPUT side needs no
    // twin of this flag.
    let sawOutputUsage = false;
    // The provider's own statement that this message is over. See the docstring's third
    // point: without it, "the model stopped" and "the socket did" are the same bytes.
    let closed = false;
    // CHARACTERS THIS FUNCTION RECEIVED, counted from the RAW fragments rather than from the
    // parsed calls. `safeJson` turns a cut-off argument into `{}`, so the output floor priced a
    // turn that burned its whole `max_tokens` allowance on one call at 5 output tokens — see
    // `producedTokens`. Text is added at its delta; a tool block's id, name and raw argument text
    // are added at its stop, and any block the stream never closed is added at the end.
    let producedChars = 0;

    try {
      for await (const frame of modelFrames(res, signal)) {
        if (frame.data === "" || frame.data === "[DONE]") continue;
        const ev = JSON.parse(frame.data) as AnthropicEvent;

        switch (ev.type) {
          case "message_start": {
            const u = ev.message?.usage;
            if (u !== undefined) {
              // Three DISJOINT counts, which is why `priceOf` bills them as three terms: a full
              // cache hit reports `input_tokens: 0` next to a large `cache_read_input_tokens`,
              // and that turn's input really was zero at the UNCACHED rate.
              const inp = wireCount(u.input_tokens);
              if (inp !== undefined) inputTokens = inp;
              const cr = wireCount(u.cache_read_input_tokens);
              if (cr !== undefined) cacheReadTokens = cr;
              const cw = wireCount(u.cache_creation_input_tokens);
              if (cw !== undefined) cacheWriteTokens = cw;
            }
            break;
          }
          case "content_block_start": {
            const block = ev.content_block;
            if (block?.type === "tool_use" && ev.index !== undefined) {
              partial.set(ev.index, { id: block.id ?? "", name: block.name ?? "", json: "" });
            } else if (block?.type === "redacted_thinking") {
              // The other shape thinking arrives in: one block, no deltas, and still billed.
              producedChars += block.data?.length ?? 0;
            }
            break;
          }
          case "content_block_delta": {
            const d = ev.delta;
            if (d?.type === "text_delta" && d.text !== undefined) {
              text += d.text;
              producedChars += d.text.length;
              yield { type: "text_delta", text: d.text };
            } else if (d?.type === "thinking_delta" || d?.type === "signature_delta") {
              // THINKING IS BILLED AS OUTPUT AND WAS COUNTED NOWHERE. It never enters `text` —
              // it is not the answer — so a 60,000-character thinking turn with no usage frame
              // was charged `Math.max(1, 0)` = ONE output token, which is the original $0-priced
              // turn surviving whole in the shape an extended-thinking model always takes. It is
              // not yielded to the caller, because a `text_delta` is the answer; it is counted,
              // because the provider charges for it.
              producedChars += (d.thinking?.length ?? 0) + (d.signature?.length ?? 0);
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
            producedChars += acc.id.length + acc.name.length + acc.json.length;
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
            // A MAX, for the reason the three input fields below give: this wire reports usage
            // cumulatively, so a second `message_delta` naming a smaller number is not a
            // correction. Last-write-wins here handed that choice to whoever writes the bytes.
            const out = wireCount(ev.usage?.output_tokens);
            if (out !== undefined) {
              outputTokens = sawOutputUsage ? Math.max(outputTokens, out) : out;
              sawOutputUsage = true;
            }
            // THE UNION OF THE TWO POSITIONS, taken as a MAX per field. Anthropic's own wire
            // reports usage cumulatively on `message_delta`, so summing would double-count the
            // same tokens and a last-write-wins would believe whichever frame happened to come
            // last. A max is right for both a wire that repeats and a wire that only ever says it
            // here — and it cannot lower a count `message_start` already established.
            const dInp = wireCount(ev.usage?.input_tokens);
            if (dInp !== undefined) inputTokens = Math.max(inputTokens, dInp);
            const dCr = wireCount(ev.usage?.cache_read_input_tokens);
            if (dCr !== undefined) cacheReadTokens = Math.max(cacheReadTokens ?? 0, dCr);
            const dCw = wireCount(ev.usage?.cache_creation_input_tokens);
            if (dCw !== undefined) cacheWriteTokens = Math.max(cacheWriteTokens ?? 0, dCw);
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

    // FLOORED, BECAUSE "THE PROVIDER DID NOT SAY" IS NOT "IT COST NOTHING". Both counters start
    // at 0 and only a usage frame moves them, so a stream carrying none — an Anthropic-wire
    // gateway behind `baseUrl`, which is what that option is for — priced a real answer at $0.
    // Zero is the PASSING value for every budget guard downstream: `budget.runUsd`, the per-node
    // `budget.costUsd`, `budget.tokens` and the E2/E3 escalations all stop binding at once, which
    // is `AgentOptions.budgetUsd`'s "an agent loop with no ceiling is the classic incident".
    // An estimate that is roughly right refuses eventually; a zero never does.
    //
    // The same rules and the same estimators as `OpenAIAdapter` — which imports the tolerance and
    // the token estimate from `usage.ts` and the two request-side estimators from THIS file — so
    // the two adapters cannot answer a missing usage frame differently.
    //
    // NOT `text.length`, because on this turn `text` is usually "": see `producedTokens` for the
    // measurement of what the text-only floor charged for a tool call.
    //
    // A REPORTED ZERO IS BELIEVED ONLY WHERE THIS ADAPTER HOLDS NO EVIDENCE AGAINST IT, and the
    // two dimensions hold different evidence, so they are two rules rather than one flag.
    //
    // Both simpler rules were tried and both loosen. `=== 0` alone cannot see a reported zero at
    // all, so it re-charged a full cache hit — `{"input_tokens":0,"cache_read_input_tokens":
    // 20000}` is an honest zero, every one of those tokens having been billed at the cache-read
    // rate — as the whole prompt at the uncached rate: $0.006105 became $0.066111 on a
    // 20,000-token prompt priced $3/$15/$0.30 per million. Gating on "was a usage frame seen"
    // alone then handed the ceiling the other way, to whoever writes the bytes: a gateway sending
    // `output_tokens: 0` beside 5,000 characters of text was charged $0.000033 where the estimate
    // says $0.018783, and `input_tokens: 0` with NO cache field on an 80,000-character prompt was
    // charged $0.000105 against $0.060111. Under-charging is the loosening direction for
    // `budget.runUsd` and `budget.runTokens`.
    //
    // **THE ZERO RULES WERE DEFEATED BY ASSERTING 1, so there is a second, QUANTITATIVE rule.**
    // Each zero rule has exactly one disproof and a wire can simply assert past it: measured on
    // an 80,000-character prompt, `"cache_read_input_tokens": 1` priced the whole turn at
    // $0.000105 against $0.006105 honest, and `"input_tokens": 1` and `"output_tokens": 1` did
    // the same on their own dimensions — a ~570x under-charge, from adding one. What the zero
    // rules close is the ZERO, which is what a gateway with no usage accounting emits by default
    // and what every measured instance of the original defect looked like; they are kept for
    // exactly that and are unchanged. What closes the rest is comparing the REPORTED TOTAL
    // against evidence this adapter holds locally, with a tolerance, because both sides are
    // estimates. `USAGE_TOLERANCE` carries the measurement that chose the tolerance and
    // `toleratedFloor` the argument for charging the threshold rather than the estimate;
    // `TODO.md` §A0.13 has the reproduction.
    //
    // THE TWO ARE ORDERED AND THE ORDER MATTERS: the zero rules charge the WHOLE estimate and run
    // first, so nothing here lowers a charge that the zero rules already made. The quantitative
    // rule only ever raises a number a wire reported.
    //
    // OUTPUT — the adapter RECEIVED what it is pricing. A zero beside non-empty `text` or a
    // parsed tool call contradicts bytes this function is holding, so the estimate wins there;
    // a zero on a turn that really produced nothing is believed and charged 0, and the
    // quantitative rule is skipped for the same reason rather than floored to 1. A missing usage
    // frame is still the original case and still floors, which is why the flag survives on this
    // side: with no frame at all, an empty turn has to cost the estimate's `Math.max(1, …)`
    // rather than nothing.
    //
    // INPUT — the adapter SENT what it is pricing, and `roughTokens(req)` reads it locally. The
    // only honest zero here is one some OTHER count accounts for, and on this wire that is the
    // pair of cache fields, disjoint from `input_tokens` above. So: zero uncached input with no
    // cache tokens beside it is refused whatever produced it, and a flag distinguishing "did not
    // say" from "said zero" would answer the same question twice — with no usage frame at all,
    // `inputTokens` is 0 and both cache counts are absent, which is this condition already.
    //
    // A SHORTFALL IS CHARGED TO `inputTokens` AND NOT TO A CACHE COUNT, which is the fail-closed
    // choice of the three available: uncached input is the most expensive of the three rates, and
    // tokens a wire declined to account for are not tokens it may have billed at the cache rate.
    //
    // THAT SENTENCE WAS TRUE OF THE SHORTFALL AND FALSE OF THE REST: the check below it compared
    // the reported SUM against the floor, so a wire meeting the sum entirely out of the cheap
    // dimensions paid nothing extra — `cache_read_input_tokens` declared at exactly the floor,
    // `input_tokens: 0`, was believed whole. `dearestRateFloor` is the second, PER-RATE check:
    // whatever part of the estimate the wire's own cache claim does not cover is charged at the
    // input rate on top of whatever the sum floor already added. See its docstring in `usage.ts`
    // for the measured before/after and why it rounds down rather than up. `TODO.md` §A0.13.
    for (const acc of partial.values()) producedChars += acc.id.length + acc.name.length + acc.json.length;
    // `producedTokens` reads the PARSED calls and `producedChars` the RAW argument text. The raw
    // count is the larger whenever a call was cut off, and nothing on the wire guarantees the
    // ordering the other way round, so the floor takes both.
    const produced = Math.max(producedTokens(text, toolCalls), estimateTokens(producedChars));
    const producedAnything = text !== "" || toolCalls.length > 0 || producedChars > 0;
    if (!sawOutputUsage || (outputTokens === 0 && producedAnything)) {
      outputTokens = produced;
    } else if (producedAnything) {
      outputTokens = Math.max(outputTokens, toleratedFloor(produced));
    }

    const cacheCredit = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
    const reportedInput = inputTokens + cacheCredit;
    if (reportedInput === 0) {
      inputTokens = roughTokens(req);
    } else {
      const estimate = billableTokens(req);
      const floor = toleratedFloor(estimate);
      if (reportedInput < floor) inputTokens += floor - reportedInput;
      // PER-RATE FLOOR — §A0.13. The sum floor above lets a wire satisfy it entirely out of
      // `cacheCredit`; this charges whatever the wire's own cache claim does not cover, at the
      // input rate, regardless of how the wire split the rest. See `dearestRateFloor`.
      const perRateFloor = dearestRateFloor(estimate, cacheCredit);
      if (inputTokens < perRateFloor) inputTokens = perRateFloor;
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
    yield { type: "done", message, provider: this.provider, finishReason: truncated || toolCalls.length === 0 ? finishReason : "tool_use", usage };
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
   *
   * A DATED VARIANT IS NO LONGER FREE. `return 0` made the dollar floor moot for
   * `claude-sonnet-5-20260101` where `claude-sonnet-5` cost $0.135 on the same turn — tokens
   * floored, so `budget.runTokens` bound and `budget.runUsd` did not. `resolvePrice` matches it
   * onto its base row; the operator's own rows still win over the defaults, per model, exactly as
   * before. A model with no row and no priced prefix STILL prices 0, and `resolvePrice` says at
   * length why that zero cannot be closed from inside this file.
   */
  priceOf(model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number {
    const p = resolvePrice([this.#opts.prices ?? {}, DEFAULT_PRICES] as Record<string, PriceRow>[], model);
    if (p === undefined) return 0;
    const cost = round6(
      (usage.inputTokens / 1e6) * p.input +
        (usage.outputTokens / 1e6) * p.output +
        ((usage.cacheReadTokens ?? 0) / 1e6) * (p.cacheRead ?? p.input) +
        ((usage.cacheWriteTokens ?? 0) / 1e6) * (p.cacheWrite ?? p.input),
    );
    // A PRICE THIS FUNCTION CANNOT COMPUTE IS REFUSED, NOT RETURNED. `wireCount` bounds the
    // usage side; this bounds the OTHER input, the operator's own `prices` row, which is
    // ordinary JSON and can carry a NaN or a negative. Either one poisons `PolicyEngine`'s
    // running total for the life of the run — NaN by making every later comparison false, a
    // negative by crediting the budget — and neither is a number a ledger may hold. Returning
    // 0 here would be the same loosening in a quieter form.
    if (!Number.isFinite(cost) || cost < 0) {
      throw err.validation(CODES.E_CONFIG_INVALID, `price table for ${model} produced a cost that is not a non-negative number`);
    }
    return cost;
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
  return estimateTokens(chars);
}

/**
 * The OUTPUT floor's estimator: everything the turn produced, not only its prose.
 *
 * The floor was `Math.ceil(text.length / 4)`, and `text` is EMPTY on a `tool_use` turn — the
 * shape an agent loop mostly takes, because the model's whole answer is a tool call. So a
 * gateway that sends no usage frame was charged `Math.max(1, 0)` = ONE output token for a
 * complete tool call of any size, which is the same $0-priced turn the floor exists to stop,
 * surviving in the majority case. The estimate has to read the tool calls too.
 *
 * `name` and the SERIALISED arguments, and the id with them: all three came down the wire as
 * generated tokens.
 *
 * IT READS THE PARSED CALLS, AND `safeJson` HAS ALREADY REPLACED A CUT-OFF ARGUMENT WITH `{}` by
 * the time it runs. Measured on a `max_tokens` turn whose one `fs.write` call was cut after 9,030
 * characters of argument JSON, at $15 per million output tokens: the output side cost $0.000075
 * where the raw text says $0.033900 — 5 tokens against 2,262, a 452x under-charge on the turn
 * shape an agent loop mostly takes. The COMPLETE version of the same turn was already right and
 * is unchanged by this, 2,262 tokens either way. Both adapters therefore count the RAW argument
 * text alongside this, from the fragments as they arrive and including a block the stream never
 * closed — `producedChars` in each `stream`. This function stays the estimate for a caller
 * holding parsed calls and nothing else, and re-serialising with `JSON.stringify` is still not
 * the provider's own whitespace.
 */
export function producedTokens(text: string, toolCalls: readonly ModelToolCall[]): number {
  let chars = text.length;
  for (const c of toolCalls) chars += c.id.length + c.name.length + JSON.stringify(c.arguments).length;
  return estimateTokens(chars);
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------

interface AnthropicEvent {
  type: string;
  index?: number;
  // `unknown` AND NOT `number`: these are `JSON.parse` output, so the annotation would be a
  // claim about bytes a remote party wrote. `wireCount` is what actually decides.
  message?: { usage?: { input_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown } };
  content_block?: { type?: string; id?: string; name?: string; data?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string; thinking?: string; signature?: string };
  // INPUT COUNTS LIVE HERE TOO, and declaring them only under `message` above was a real
  // over-charge: a wire that reports its cache hit on `message_delta` had `cache_read` invisible,
  // so the input floor saw a bare zero and charged the whole prompt at the uncached rate —
  // `{"in":20002,"usd":0.060111}` against `{"in":0,"cr":20000,"usd":0.006105}` for the same
  // numbers on `message_start`. Not a loosening, and still wrong.
  usage?: {
    output_tokens?: unknown;
    input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  error?: { message?: string };
}
