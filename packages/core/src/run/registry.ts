/**
 * Registries for the three things a node body can be: a tool, a function, or a model.
 *
 * The important structural rule lives in the executor, not here: there is exactly ONE
 * tool dispatch path. EAgent had two — the agent loop's guard and a hand-cloned copy
 * inside its workflow runner — and the clone was documented as needing manual
 * syncing. That duplication is a silent privilege bug waiting to happen, so these
 * registries expose only *definitions*; nothing here invokes anything.
 */

import type { Disposable as LoomDisposable } from "../vocab.ts";
import { CODES, err } from "../errors.ts";
import type { TaskId } from "../ids.ts";
import type { JSONSchema } from "../schema.ts";
import type { StateView } from "../state/channels.ts";
import type { ToolManifestLite } from "../graph/validate.ts";
import type { UsageRecord } from "../vocab.ts";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolContext {
  readonly taskId: TaskId;
  readonly signal: AbortSignal;
  /** Streams to the UI. NEVER enters the model's context. */
  progress(chunk: string): void;
}

export interface ToolResult {
  /** Model-legible text. */
  readonly content: string;
  readonly isError?: boolean;
  /** Structured payload for renderers and telemetry; never sent to the model. */
  readonly details?: unknown;
  /** Channel writes this tool proposes. Merged into the node's writes. */
  readonly writes?: Readonly<Record<string, unknown>>;
}

export interface ToolDefinition extends ToolManifestLite {
  readonly description: string;
  readonly parameters: JSONSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

export class ToolRegistry {
  /** Stack per name so `dispose` restores the shadowed definition exactly. */
  readonly #stacks = new Map<string, ToolDefinition[]>();

  register(tool: ToolDefinition): LoomDisposable {
    const stack = this.#stacks.get(tool.name) ?? [];
    stack.push(tool);
    this.#stacks.set(tool.name, stack);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const s = this.#stacks.get(tool.name);
        if (s === undefined) return;
        const i = s.lastIndexOf(tool);
        if (i >= 0) s.splice(i, 1);
        if (s.length === 0) this.#stacks.delete(tool.name);
      },
    };
  }

  get(name: string): ToolDefinition | undefined {
    const stack = this.#stacks.get(name);
    return stack === undefined ? undefined : stack[stack.length - 1];
  }

  require(name: string): ToolDefinition {
    const t = this.get(name);
    if (t === undefined) throw err.notFound(CODES.E_TOOL_NOT_FOUND, `no tool registered as "${name}"`);
    return t;
  }

  list(): readonly ToolDefinition[] {
    return [...this.#stacks.values()].map((s) => s[s.length - 1]!).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** The compiler needs manifests, not implementations. */
  manifests(): Record<string, ToolManifestLite> {
    const out: Record<string, ToolManifestLite> = {};
    for (const t of this.list()) out[t.name] = t;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Functions — deterministic node bodies
// ---------------------------------------------------------------------------

export interface FunctionContext {
  readonly taskId: TaskId;
  readonly signal: AbortSignal;
  /** Recorded clock. A function MUST NOT call Date.now() directly (R4). */
  now(): number;
}

export interface FunctionOutcome {
  readonly writes?: Readonly<Record<string, unknown>>;
  /** Router/conditional selection. Absent means "let the executor evaluate edges". */
  readonly take?: readonly string[];
}

export type FunctionBody = (view: StateView, ctx: FunctionContext) => Promise<FunctionOutcome> | FunctionOutcome;

export class FunctionRegistry {
  readonly #byRef = new Map<string, FunctionBody>();

  register(ref: string, body: FunctionBody): LoomDisposable {
    this.#byRef.set(ref, body);
    return { dispose: () => this.#byRef.delete(ref) };
  }

  get(ref: string): FunctionBody | undefined {
    return this.#byRef.get(ref);
  }

  require(ref: string): FunctionBody {
    const f = this.get(ref);
    if (f === undefined) throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `no function registered as "${ref}"`);
    return f;
  }

  has(ref: string): boolean {
    return this.#byRef.has(ref);
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface Message {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
}

export interface ModelRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly maxTokens?: number;
}

export type FinishReason = "stop" | "tool_use" | "max_tokens" | "content_filter" | "refusal";

export type ModelEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "done"; readonly message: Message; readonly finishReason: FinishReason; readonly usage: UsageRecord };

export interface ModelAdapter {
  readonly provider: string;
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  priceOf(model: string, usage: { inputTokens: number; outputTokens: number }): number;
  /** Worst-case cost of a request, for the budget reservation (D6.5). */
  estimateOf(req: ModelRequest): number;
}

export class ModelRegistry {
  readonly #byProvider = new Map<string, ModelAdapter>();
  #default: string | undefined;

  register(adapter: ModelAdapter, asDefault = false): LoomDisposable {
    this.#byProvider.set(adapter.provider, adapter);
    if (asDefault || this.#default === undefined) this.#default = adapter.provider;
    return { dispose: () => this.#byProvider.delete(adapter.provider) };
  }

  get(provider?: string): ModelAdapter | undefined {
    return this.#byProvider.get(provider ?? this.#default ?? "");
  }

  require(provider?: string): ModelAdapter {
    const a = this.get(provider);
    if (a === undefined) {
      throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `no model adapter registered for "${provider ?? "(default)"}"`);
    }
    return a;
  }
}

// ---------------------------------------------------------------------------
// MockModelAdapter — why the whole suite runs offline
// ---------------------------------------------------------------------------

export interface MockTurn {
  readonly text?: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly finishReason?: FinishReason;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * `turn` is the index of this call WITHIN ITS OWN CONVERSATION, derived from the
 * request rather than counted on the adapter.
 *
 * A shared counter cannot script concurrent agents: with five fan-out branches
 * calling the same adapter, a global counter interleaves arbitrarily and each branch
 * sees a turn number that has nothing to do with its own progress. Deriving it from
 * the message list makes the mock deterministic per branch, which is the whole point
 * of having one.
 */
export type MockScript = (req: ModelRequest, turn: number) => MockTurn;

/**
 * A scriptable, deterministic LLM.
 *
 * This is the reason the entire suite runs with no network and no API key, and the
 * reason an agent node can be exercised in a replay test at all. Carried over
 * verbatim in spirit from EAgent's `MockProvider`, which was the single best
 * testability decision in that codebase.
 */
export class MockModelAdapter implements ModelAdapter {
  readonly provider: string;
  readonly #script: MockScript;
  readonly #pricePerMTok: number;
  /** Every request seen, for assertions about context assembly. */
  readonly seen: ModelRequest[] = [];

  constructor(opts: { provider?: string; script: MockScript; pricePerMTok?: number }) {
    this.provider = opts.provider ?? "mock";
    this.#script = opts.script;
    this.#pricePerMTok = opts.pricePerMTok ?? 1;
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal.aborted) throw err.cancelled();
    this.seen.push(req);
    // Per-conversation, not per-adapter: one prior assistant message means turn 1.
    const turnIndex = req.messages.filter((m) => m.role === "assistant").length;
    const turn = this.#script(req, turnIndex);

    const text = turn.text ?? "";
    // Chunked so the streaming path is genuinely exercised rather than short-circuited.
    for (let i = 0; i < text.length; i += 16) {
      if (signal.aborted) throw err.cancelled();
      yield { type: "text_delta", text: text.slice(i, i + 16) };
    }

    const inputTokens = turn.inputTokens ?? estimateTokens(req);
    const outputTokens = turn.outputTokens ?? Math.max(1, Math.ceil(text.length / 4));
    const message: Message = {
      role: "assistant",
      content: text,
      ...(turn.toolCalls === undefined ? {} : { toolCalls: turn.toolCalls }),
    };
    yield {
      type: "done",
      message,
      finishReason: turn.finishReason ?? (turn.toolCalls !== undefined && turn.toolCalls.length > 0 ? "tool_use" : "stop"),
      usage: {
        inputTokens,
        outputTokens,
        costUsd: this.priceOf(req.model, { inputTokens, outputTokens }),
        wallMs: 0,
      },
    };
  }

  priceOf(_model: string, usage: { inputTokens: number; outputTokens: number }): number {
    return round6(((usage.inputTokens + usage.outputTokens) / 1_000_000) * this.#pricePerMTok);
  }

  estimateOf(req: ModelRequest): number {
    const maxOut = req.maxTokens ?? 1024;
    return this.priceOf(req.model, { inputTokens: estimateTokens(req), outputTokens: maxOut });
  }

  reset(): void {
    this.seen.length = 0;
  }
}

function estimateTokens(req: ModelRequest): number {
  let chars = req.system.length;
  for (const m of req.messages) chars += m.content.length;
  for (const t of req.tools) chars += t.name.length + t.description.length;
  return Math.max(1, Math.ceil(chars / 4));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
