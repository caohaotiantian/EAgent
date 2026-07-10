/**
 * A provider for Google's Gemini (Generative Language API), over `fetch` and
 * SSE with no SDK. It is the third real provider, and the most different in
 * shape — Gemini uses `contents`/`parts`, `model` (not `assistant`) roles, and
 * correlates tool results by function *name* rather than a call id. Mapping all
 * of that onto EAgent's neutral message model (and back) is the real test of
 * whether the `Provider` abstraction holds; it does.
 *
 * Configuration by environment:
 *   GEMINI_API_KEY    (or GOOGLE_API_KEY)
 *   GEMINI_BASE_URL   (optional; defaults to the v1beta endpoint)
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

export interface GeminiOptions {
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

export class GeminiProvider implements Provider {
  readonly name = "gemini";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #maxTokens: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;

  constructor(opts: GeminiOptions = {}) {
    this.#apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
    this.#baseUrl = (opts.baseUrl ?? process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.#maxTokens = opts.maxTokens ?? 4096;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#fetch = opts.fetch ?? globalThis.fetch;
  }

  get configured(): boolean {
    return this.#apiKey.length > 0;
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (!this.#apiKey) throw new Error("GeminiProvider: GEMINI_API_KEY is not set");

    const generationConfig: Record<string, unknown> = { maxOutputTokens: this.#maxTokens };
    // Gemini 2.5 exposes a `thinkingBudget` (token allowance) and asks for the
    // thought summary via `includeThoughts`. Map the neutral level to a budget;
    // `off` sets 0, which disables thinking on models that allow it.
    if (req.thinking) {
      generationConfig.thinkingConfig = {
        thinkingBudget: thinkingBudget(req.thinking),
        includeThoughts: req.thinking !== "off",
      };
    }
    const body: Record<string, unknown> = {
      contents: toGeminiContents(req.messages),
      generationConfig,
    };
    // Fold in-transcript `role:"system"` messages into systemInstruction —
    // Gemini has no positional system role in `contents`. Synthesize
    // systemInstruction from notes even when `systemPrompt` is absent, and emit
    // no empty part (design KDD1/KDD2).
    const systemParts: { text: string }[] = [];
    if (req.systemPrompt) systemParts.push({ text: req.systemPrompt });
    for (const m of req.messages) {
      if (m.role !== "system") continue;
      const t = systemText(m);
      if (t) systemParts.push({ text: t });
    }
    if (systemParts.length > 0) body.systemInstruction = { parts: systemParts };
    if (req.tools.length) {
      body.tools = [{ functionDeclarations: req.tools.map(toGeminiTool) }];
      // Decode-time forcing: Gemini constrains tool use via `tool_config`'s
      // function-calling mode. `"auto"`/absent omits it (the default — Gemini
      // already defaults to AUTO), so a no-forcing request is byte-identical.
      // Only meaningful when tools are declared, so it lives in this block.
      const toolConfig = toGeminiToolConfig(req.toolChoice);
      if (toolConfig) body.tool_config = toolConfig;
    }

    const res = await fetchWithRetry({
      url: `${this.#baseUrl}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`,
      headers: { "x-goog-api-key": this.#apiKey },
      body,
      signal: req.signal,
      fetchImpl: this.#fetch,
      maxRetries: this.#maxRetries,
      describe: (status, detail) => `Gemini API error ${status}: ${detail}`,
    });

    let text = "";
    let reasoningBuffer = "";
    const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
    let stopReason: StopReason = "end_turn";
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of parseSSE(res.body!)) {
      if (!event.data) continue;
      let parsed: GeminiChunk;
      try {
        parsed = JSON.parse(event.data) as GeminiChunk;
      } catch {
        continue;
      }
      // A mid-stream API error frame carries a top-level `error` object. Throw
      // rather than let the loop end and fabricate a `done` with partial
      // content: the committed boundary (agent.ts) retries a pre-commit error
      // via onProviderError, or rethrows a post-commit one.
      if (parsed.error)
        throw new Error(`Gemini stream error: ${parsed.error.status ?? parsed.error.code}: ${parsed.error.message}`);
      if (parsed.usageMetadata) {
        const u = parsed.usageMetadata;
        // `cachedContentTokenCount` lies within `promptTokenCount`; subtract it out.
        const cached = u.cachedContentTokenCount;
        if (u.promptTokenCount !== undefined) usage.inputTokens = Math.max(0, u.promptTokenCount - (cached ?? 0));
        if (cached !== undefined) usage.cacheReadTokens = cached;
        // `thoughtsTokenCount` is DISJOINT from `candidatesTokenCount` and additive
        // to the billed total, so fold it into outputTokens (and surface as reasoning).
        const thoughts = u.thoughtsTokenCount;
        if (u.candidatesTokenCount !== undefined || thoughts !== undefined)
          usage.outputTokens = (u.candidatesTokenCount ?? 0) + (thoughts ?? 0);
        if (thoughts !== undefined) usage.reasoningTokens = thoughts;
      }
      const candidate = parsed.candidates?.[0];
      if (!candidate) continue;
      for (const part of candidate.content?.parts ?? []) {
        if (typeof part.text === "string" && part.thought === true) {
          // A thought summary part — surfaced as reasoning, kept out of the answer.
          reasoningBuffer += part.text;
          yield { type: "reasoning_delta", text: part.text };
        } else if (typeof part.text === "string") {
          text += part.text;
          yield { type: "text_delta", text: part.text };
        } else if (part.functionCall) {
          const id = `call_${part.functionCall.name}_${toolCalls.length}`;
          const args = (part.functionCall.args ?? {}) as Record<string, unknown>;
          toolCalls.push({ id, name: part.functionCall.name, arguments: args });
          yield { type: "tool_call", id, name: part.functionCall.name, arguments: args };
        }
      }
      if (candidate.finishReason) stopReason = mapFinishReason(candidate.finishReason);
    }

    // Tool calls mean the turn intends to call tools — but don't clobber a
    // genuine max_tokens truncation (a turn can be cut off mid-function-call);
    // preserve that signal so the loop can surface it.
    if (toolCalls.length > 0 && stopReason === "end_turn") stopReason = "tool_use";
    const content: ContentBlock[] = [];
    // Persist the chain of thought (unsigned) so snapshot/restore keeps it; every
    // request-builder ignores an unsigned thinking block, so replay is unaffected.
    if (reasoningBuffer) content.push({ type: "thinking", thinking: reasoningBuffer });
    if (text) content.push({ type: "text", text });
    for (const tc of toolCalls) content.push({ type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments });

    yield { type: "done", message: { role: "assistant", content }, stopReason, usage };
  }
}

// -- wire-format mapping ----------------------------------------------------

function toGeminiTool(spec: ToolSpec): unknown {
  return { name: spec.name, description: spec.description, parameters: spec.parameters };
}

/** Concatenate a message's `type:"text"` blocks (mirrors `openai.ts` `textOf`). */
function systemText(m: Message): string {
  return m.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Map the neutral `ToolChoice` to Gemini's `tool_config`, or `undefined` (omit)
 * for `"auto"`/absent — the no-forcing default. `"required"` sets mode `ANY`
 * (call SOME function); a named choice sets mode `ANY` with
 * `allowedFunctionNames: [name]` (call only that function).
 */
function toGeminiToolConfig(choice: ToolChoice | undefined): Record<string, unknown> | undefined {
  if (!choice || choice === "auto") return undefined;
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
}

function toGeminiContents(messages: Message[]): unknown[] {
  // Gemini correlates a function response by name, not id, so resolve each
  // tool_result's call name from the tool_call that produced it.
  const idToName = new Map<string, string>();
  for (const m of messages) {
    for (const b of m.content) if (b.type === "tool_call") idToName.set(b.id, b.name);
  }

  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // carried via systemInstruction
    if (m.role === "tool") {
      const parts = m.content
        .filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")
        .map((b) => ({
          functionResponse: {
            name: idToName.get(b.toolCallId) ?? b.toolCallId,
            // Gemini has no standard error field; surface failures under `error`
            // so the model can distinguish them from successful results.
            response: b.isError ? { error: b.content } : { result: b.content },
          },
        }));
      out.push({ role: "user", parts });
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    const parts: unknown[] = [];
    for (const b of m.content) {
      if (b.type === "text") parts.push({ text: b.text });
      else if (b.type === "tool_call") parts.push({ functionCall: { name: b.name, args: b.arguments } });
      else if (b.type === "image") {
        if (b.data) parts.push({ inlineData: { mimeType: b.mimeType, data: b.data } });
        else if (b.url) parts.push({ fileData: { mimeType: b.mimeType, fileUri: b.url } });
      }
    }
    // A turn whose only blocks are unmappable (e.g. a MAX_TOKENS-truncated
    // reasoning-only assistant turn — thinking is dropped on replay) maps to no
    // parts; sending `parts: []` makes generateContent 400, so skip it. Turns
    // with text/tool_call are non-empty, so tool_use/tool_result pairing holds.
    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      return "stop";
  }
}

/** Map the neutral effort level to a Gemini thinking-token budget. */
function thinkingBudget(level: "off" | "low" | "medium" | "high"): number {
  switch (level) {
    case "off":
      return 0;
    case "low":
      return 1024;
    case "medium":
      return 8192;
    case "high":
      return 24576;
  }
}

// -- minimal stream-chunk typings -------------------------------------------

interface GeminiChunk {
  /** A mid-stream API error frame (top-level `error` object). */
  error?: { code?: number; message?: string; status?: string };
  candidates?: {
    content?: {
      role?: string;
      parts?: { text?: string; thought?: boolean; functionCall?: { name: string; args?: Record<string, unknown> } }[];
    };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    /** Cached portion of `promptTokenCount` (subtracted out into cacheReadTokens). */
    cachedContentTokenCount?: number;
    /** Thinking tokens — disjoint from `candidatesTokenCount`, folded into outputTokens. */
    thoughtsTokenCount?: number;
  };
}
