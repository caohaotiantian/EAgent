/**
 * The vocabulary of the kernel.
 *
 * These types are the stable contract between the core and every extension.
 * The guiding rule (borrowed from VS Code's `vscode.d.ts` discipline): this
 * surface changes rarely and never breaks. Policy lives in extensions; only
 * primitives live here.
 */

// ---------------------------------------------------------------------------
// Conversation model
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  /** Rendered, model-legible result text. */
  content: string;
  isError?: boolean;
}

/**
 * A reasoning ("thinking") block emitted by a model that exposes its chain of
 * thought. `signature` is an opaque provider token (Anthropic) that must be
 * echoed back verbatim when the block is replayed in a later turn — preserving
 * it is what keeps multi-turn tool use valid under extended thinking. The kernel
 * treats both fields opaquely; providers that don't reason simply never produce
 * one.
 */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

/**
 * An image, supplied either inline (base64 in `data`) or by reference (`url`).
 * Providers map it to their own multimodal format; text-only providers and the
 * mock simply account for it. The kernel treats it opaquely.
 */
export interface ImageBlock {
  type: "image";
  /** MIME type, e.g. "image/png" (required for base64 data). */
  mimeType: string;
  /** Base64-encoded bytes (no `data:` prefix). Use this or `url`. */
  data?: string;
  /** A URL to the image, as an alternative to inline `data`. */
  url?: string;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock | ThinkingBlock | ImageBlock;

/** Build a user message carrying an image (plus optional caption text). */
export function imageMessage(image: Omit<ImageBlock, "type">, caption?: string): Message {
  const content: ContentBlock[] = [{ type: "image", ...image }];
  if (caption) content.unshift({ type: "text", text: caption });
  return { role: "user", content };
}

/**
 * A message in the running transcript.
 *
 * `meta` is an escape hatch for extensions to stash app-specific data on a
 * message without the kernel needing to know about it (Emacs text-property
 * spirit). The kernel ignores it; `Provider.stream` never sees it.
 */
export interface Message {
  role: Role;
  content: ContentBlock[];
  meta?: Record<string, unknown>;
}

export function text(role: Role, body: string): Message {
  return { role, content: [{ type: "text", text: body }] };
}

const ROLES: readonly Role[] = ["system", "user", "assistant", "tool"];

/**
 * Runtime guard that a parsed value is a structurally valid `Message`. Used when
 * loading transcripts from disk (sessions, journals): a corrupt-but-valid-JSON
 * entry must be rejected at the boundary rather than crash a later turn that
 * assumes `message.content` is an array.
 */
export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const m = value as { role?: unknown; content?: unknown };
  return typeof m.role === "string" && (ROLES as readonly string[]).includes(m.role) && Array.isArray(m.content) &&
    m.content.every((b) => typeof b === "object" && b !== null && typeof (b as { type?: unknown }).type === "string");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** A minimal JSON-Schema subset — enough to describe and validate tool inputs. */
export interface JSONSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  default?: unknown;
  [extra: string]: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** A JSON-Schema object describing the tool's arguments. */
  parameters: JSONSchema;
}

export interface ToolResult {
  /** Model-legible result text. */
  content: string;
  isError?: boolean;
  /** Structured payload for renderers/telemetry; never sent to the model. */
  details?: unknown;
  /**
   * If true, the loop will not make an automatic follow-up LLM call after this
   * tool. In a parallel batch it is honored only if every tool requests it.
   */
  terminate?: boolean;
}

export interface Tool {
  spec: ToolSpec;
  /**
   * `parallel` (default) tools may run concurrently within a turn. A single
   * `sequential` tool in a batch forces the whole batch to run in order.
   */
  executionMode?: "parallel" | "sequential";
  /** Capabilities this tool needs; enforced via `ctx.require` at call time. */
  capabilities?: string[];
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** The environment handed to a tool at call time. */
export interface ToolContext {
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  /** Request a capability; rejects with `CapabilityError` if denied. */
  require(capability: string): Promise<void>;
  /** Stream incremental progress to renderers (optional). */
  progress(chunk: string): void;
  readonly ui: UI;
  readonly agent: AgentHandle;
  readonly log: Logger;
}

// ---------------------------------------------------------------------------
// Providers (LLM abstraction)
// ---------------------------------------------------------------------------

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop"
  | "error"
  | "refusal"
  | "content_filter";

/**
 * How a turn's decoding should treat tool use. The kernel speaks one neutral
 * vocabulary; each provider maps it to its native forcing control (Anthropic
 * `tool_choice`, OpenAI `tool_choice`, Gemini `tool_config`) and gracefully
 * omits it when unsupported.
 *
 * - `"auto"` (the default, and the meaning of an absent field) — the model
 *   decides whether and which tool to call; identical to never setting it.
 * - `"required"` — the model MUST call some tool, but may pick which one.
 * - `{ type: "tool"; name }` — the model MUST call exactly the named tool. This
 *   is the shape `output-contract` uses on its corrective turn to compel a
 *   `respond` call.
 */
export type ToolChoice = "auto" | "required" | { type: "tool"; name: string };

/**
 * A normalized reasoning-effort dial. The kernel speaks one neutral vocabulary;
 * each provider maps it to its own native control — Anthropic's `output_config`
 * effort + adaptive thinking, OpenAI's `reasoning_effort`, Gemini's thinking
 * budget. `off` means "don't ask the model to reason"; providers whose models
 * always reason (e.g. Claude Fable) simply fall back to their default.
 */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

/**
 * Token accounting for a completion. Providers report it; the agent sums it.
 *
 * `inputTokens` is the **fresh, non-cached** prompt input. The cache and reasoning
 * fields are optional and **omitted when the provider does not report them** — a
 * value built from a provider that has none stays deep-equal to a plain
 * `{inputTokens, outputTokens}` object (the omit-invariant the provider tests pin).
 * `cacheReadTokens`/`cacheWriteTokens` are disjoint from `inputTokens` (and from
 * each other); `reasoningTokens` is an informational subset already counted inside
 * `outputTokens` (`reasoningTokens <= outputTokens`).
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Cached-prompt (cache-read) tokens, disjoint from `inputTokens`. */
  cacheReadTokens?: number;
  /** Cache-creation (cache-write) tokens, disjoint from `inputTokens`. */
  cacheWriteTokens?: number;
  /** Reasoning ("thinking") tokens — a subset of `outputTokens`, never added to a total. */
  reasoningTokens?: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  const sum: Usage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
  // Sum each optional field only when present in either operand, so adding two
  // plain 2-field usages yields a 2-field object (the omit-invariant).
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined)
    sum.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  if (a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined)
    sum.cacheWriteTokens = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  if (a.reasoningTokens !== undefined || b.reasoningTokens !== undefined)
    sum.reasoningTokens = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  return sum;
}

export function totalTokens(u: Usage): number {
  // Cache read/write are disjoint billable input; reasoning is already inside
  // outputTokens, so it is not added again.
  return u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) + u.outputTokens;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "done"; message: Message; stopReason: StopReason; usage?: Usage };

export interface CompletionRequest {
  systemPrompt: string;
  messages: Message[];
  tools: ToolSpec[];
  model: string;
  signal: AbortSignal;
  /** Requested reasoning effort; a provider maps it to its native control. */
  thinking?: ThinkingLevel;
  /**
   * How decoding should treat tool use this turn. Absent (or `"auto"`) is the
   * default and is byte-identical to today's behavior; a provider maps a
   * stronger choice to its native forcing control and gracefully omits it when
   * the underlying API can't express it. Set by the agent loop from
   * `Agent.forceTool` (see `agent.ts`).
   */
  toolChoice?: ToolChoice;
}

/**
 * The only thing the kernel knows about an LLM: it turns a request into a
 * stream of events ending in exactly one `done`. Anthropic, OpenAI, a local
 * model, or a deterministic mock all satisfy this same shape.
 */
export interface Provider {
  readonly name: string;
  stream(req: CompletionRequest): AsyncIterable<StreamEvent>;
}

// ---------------------------------------------------------------------------
// Ambient services exposed to tools/extensions
// ---------------------------------------------------------------------------

/** A permission request as DATA: `confirm` gets one pre-formatted sentence, so a
 *  front end cannot render the diff or shell command without parsing prose. */
export interface DecisionRequest {
  capability: string;
  /** The requesting tool name or extension id. */
  source: string;
  /** The call's arguments, when the request came from a tool dispatch. */
  arguments?: Record<string, unknown>;
}

/** `once` grants this call only; `always` is remembered for the session. */
export type DecisionChoice = "once" | "always" | "reject";

export interface UI {
  /** Ask the human a yes/no question. Resolves to the decision. */
  confirm(question: string): Promise<boolean>;
  /**
   * Resolve a permission request with a three-way answer. Optional: a UI that
   * cannot offer "allow once" simply omits it and the capability layer falls
   * back to `confirm`, whose `true` means `always` (its historical meaning).
   */
  decide?(request: DecisionRequest): Promise<DecisionChoice>;
  notify(message: string): void;
  /**
   * Ask the human a free-form or multiple-choice question and resolve with the
   * answer (or null if none / non-interactive). Optional: a UI that cannot
   * elicit simply omits it, and callers fall back. (agent→host elicitation;
   * mirror of confirm's host channel.)
   */
  ask?(question: string, options?: string[]): Promise<string | null>;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** The slice of the running agent that tools/extensions are allowed to touch. */
export interface AgentHandle {
  readonly model: string;
  readonly messages: readonly Message[];
  /** Inject a message before the next LLM call (interruption/correction). */
  steer(message: Message): void;
  /** Queue a message to be processed once the loop would otherwise idle. */
  followUp(message: Message): void;
}

/**
 * A self-contained, copyable snapshot of where a conversation is and what it has
 * cost: the transcript, accounting, and the per-turn config that shapes a turn.
 * `messages` and `usage` are deep copies, so mutating an `AgentState` cannot
 * touch the live agent. Transient/config fields (`maxTurns`, `forceTool`,
 * `outputSchema`) are deliberately excluded — this is conversational state, not
 * configuration. Produced by `Agent.snapshot()` and consumed by `Agent.restore()`.
 */
export interface AgentState {
  messages: Message[];
  usage: Usage;
  model: string;
  providerName: string | undefined;
  systemPrompt: string;
  thinking: ThinkingLevel;
  step: number;
}

// ---------------------------------------------------------------------------
// Disposables
// ---------------------------------------------------------------------------

/** Every registration returns one of these so a reload can cleanly undo it. */
export interface Disposable {
  dispose(): void;
}

export function combine(...disposables: Disposable[]): Disposable {
  return {
    dispose() {
      // COPY before reversing: `reverse()` is in-place, so a second `dispose()` would tear
      // down in the ORIGINAL order. Disposal is supposed to be idempotent, not order-flipping.
      for (const d of [...disposables].reverse()) {
        try {
          d.dispose();
        } catch {
          // a failing teardown must not block the others
        }
      }
    },
  };
}
