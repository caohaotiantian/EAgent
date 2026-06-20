/**
 * A deterministic, scriptable provider.
 *
 * This is what makes the kernel testable and demoable without a network or an
 * API key. You hand it a script of turns — text and/or tool calls — and it
 * replays them as a proper event stream. With no script it simply echoes the
 * last user message, which is enough to drive the CLI offline.
 */

import type {
  CompletionRequest,
  ContentBlock,
  Message,
  Provider,
  StopReason,
  StreamEvent,
  ThinkingLevel,
} from "../kernel/types.js";

export interface MockToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  id?: string;
}

export interface MockTurn {
  text?: string;
  /** Optional reasoning to replay as `reasoning_delta` events + a thinking block. */
  reasoning?: string;
  toolCalls?: MockToolCall[];
}

export type MockResponder =
  | MockTurn
  | MockTurn[]
  | ((req: CompletionRequest, turnIndex: number) => MockTurn | undefined);

export class MockProvider implements Provider {
  readonly name = "mock";
  /** The thinking level seen on the most recent `stream` call (for assertions). */
  lastThinking: ThinkingLevel | undefined;
  #turn = 0;
  #queue: MockTurn[] | undefined;
  #fn: ((req: CompletionRequest, i: number) => MockTurn | undefined) | undefined;

  constructor(responder?: MockResponder) {
    if (typeof responder === "function") this.#fn = responder;
    else if (Array.isArray(responder)) this.#queue = [...responder];
    else if (responder) this.#queue = [responder];
  }

  /** Replace the script and reset the turn counter (handy between tests). */
  script(responder: MockResponder): this {
    this.#turn = 0;
    this.#queue = undefined;
    this.#fn = undefined;
    if (typeof responder === "function") this.#fn = responder;
    else if (Array.isArray(responder)) this.#queue = [...responder];
    else this.#queue = [responder];
    return this;
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    this.lastThinking = req.thinking;
    const turn = this.nextTurn(req);
    const content: ContentBlock[] = [];

    if (turn.reasoning) {
      for (const chunk of chunkText(turn.reasoning)) {
        if (req.signal.aborted) break;
        yield { type: "reasoning_delta", text: chunk };
      }
      // A signed thinking block, so round-trip behavior can be exercised offline.
      content.push({ type: "thinking", thinking: turn.reasoning, signature: "mock-sig" });
    }

    if (turn.text) {
      for (const chunk of chunkText(turn.text)) {
        if (req.signal.aborted) break;
        yield { type: "text_delta", text: chunk };
      }
      content.push({ type: "text", text: turn.text });
    }

    for (const [i, call] of (turn.toolCalls ?? []).entries()) {
      const id = call.id ?? `mock_${this.#turn}_${i}`;
      const args = call.arguments ?? {};
      content.push({ type: "tool_call", id, name: call.name, arguments: args });
      yield { type: "tool_call", id, name: call.name, arguments: args };
    }

    const stopReason: StopReason = (turn.toolCalls?.length ?? 0) > 0 ? "tool_use" : "end_turn";
    const message: Message = { role: "assistant", content };
    // A deterministic, rough token estimate (~4 chars/token) so usage tracking
    // is exercised offline. Real providers report exact counts.
    const usage = {
      inputTokens: estimateTokens(req.systemPrompt) + req.messages.reduce((n, m) => n + estimateMessage(m), 0),
      outputTokens: estimateTokens(turn.text ?? ""),
    };
    yield { type: "done", message, stopReason, usage };
  }

  private nextTurn(req: CompletionRequest): MockTurn {
    const i = this.#turn++;
    if (this.#fn) return this.#fn(req, i) ?? { text: "" };
    if (this.#queue) return this.#queue[i] ?? { text: "" };
    return { text: echo(req.messages) };
  }
}

function echo(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const t = m.content.find((b) => b.type === "text");
    if (t && t.type === "text") return `(mock) you said: ${t.text}`;
  }
  return "(mock) hello";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessage(m: Message): number {
  let n = 0;
  for (const b of m.content) {
    if (b.type === "text") n += estimateTokens(b.text);
    else if (b.type === "tool_call") n += estimateTokens(JSON.stringify(b.arguments)) + 4;
    else if (b.type === "tool_result") n += estimateTokens(b.content);
    else if (b.type === "image") n += 768; // a flat, plausible per-image cost
  }
  return n;
}

function chunkText(text: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [text];
}
