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

/**
 * The tool set, and the policy on who may change it once a run is under way.
 *
 * THE HAZARD. Anything holding this registry can `register()` at any time, and a later
 * registration shadows an earlier one. That is not a privilege bug — whoever can call
 * `register()` already executes code in this process — it is an AUDIT bug: a human
 * approved a gate whose posture was computed from the manifest of definition A, and
 * definition B is what ran. Nothing in the journal shows the swap, because registration is
 * process-local and journal-invisible.
 *
 * THE KNOB (`registerAfterSeal`). `"allow"` is the default and the status quo: the agent
 * may register tools during its own lifecycle. `"deny"` refuses any registration made
 * after `seal()`.
 *
 * WHY A SEAL AND NOT A PLAIN BOOLEAN. The knob has to separate two registrations that look
 * identical from inside `register()`. The embedder's own wiring happens AFTER construction
 * — `cli.ts` builds the registry and then loops `builtinTools()` into it — so a boolean
 * fixed at construction time either forbids that loop or forbids nothing. What the
 * operator wants to deny is registration *during the agent's lifecycle*, and "the
 * lifecycle has started" is a moment, not a configuration value. `seal()` names the
 * moment; the option says what crossing it means. The two stay orthogonal on purpose: the
 * embedder decides WHEN wiring ends, the operator decides WHETHER that boundary bites, and
 * neither needs the other's answer.
 *
 * There is no `unseal()`. A seal the sealed party can lift is not a seal — the same
 * reasoning that lets nothing but an explicit human `deescalate` lower a posture (R5).
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER. `dispose()` still works after the seal. Removing
 * a shadow moves the registry back toward the manifest that was wired, and gating teardown
 * would break `combineDisposables` on shutdown. A caller that disposes a BASE registration
 * post-seal can still change what `get()` answers; closing that needs the registration to
 * become a journal fact, which is a much larger change than a constructor option.
 */
export class ToolRegistry {
  /** Stack per name so `dispose` restores the shadowed definition exactly. */
  readonly #stacks = new Map<string, ToolDefinition[]>();
  readonly #afterSeal: "allow" | "deny";
  #sealed = false;

  /**
   * The option type is inline rather than an exported `ToolRegistryOptions` because
   * `index.ts` re-exports this module with `export *`, so every exported name lands in the
   * pinned public surface. One optional field does not earn a pinned name.
   */
  constructor(opts: { readonly registerAfterSeal?: "allow" | "deny" } = {}) {
    this.#afterSeal = opts.registerAfterSeal ?? "allow";
  }

  /** Wiring is over. Idempotent, and one-way. */
  seal(): void {
    this.#sealed = true;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  register(tool: ToolDefinition): LoomDisposable {
    // THROW, never no-op. A silent refusal leaves the caller believing its definition is
    // the live one, and the discrepancy surfaces later as the WRONG tool running with no
    // trace of the decision that caused it — which is the audit failure this knob exists
    // to prevent, arrived at by another road.
    if (this.#sealed && this.#afterSeal === "deny") {
      throw err.policy(
        CODES.E_NOT_AUTHORIZED,
        `tool registration is closed: "${tool.name}" was NOT registered. This registry was ` +
          `constructed with { registerAfterSeal: "deny" } and seal() has been called, so tools may ` +
          `only be registered while the host is wiring up. Register it before seal(), or construct ` +
          `the registry with { registerAfterSeal: "allow" } (the default) to permit registration ` +
          `during a run.`,
      );
    }
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
  /**
   * The engine's INJECTED clock — `Engine`'s own `now`, which defaults to `Date.now`.
   *
   * It is NOT a recorded effect, whatever R4 says a nondeterminism seam ought to be.
   * Nothing appends `effect.started{kind:"clock"}` anywhere in the tree, and
   * `#runFunction` has no replay branch, so a body that reads this executes live on replay
   * and gets a different answer than the run being replayed. Still prefer it to calling
   * `Date.now()` yourself: a host that injects a fixed clock controls this one, and the day
   * the engine journals a clock read this is the seam that will serve the journaled value.
   * Until then, a body that must be replayable takes its timestamp from a channel it reads.
   */
  now(): number;
}

export interface FunctionOutcome {
  readonly writes?: Readonly<Record<string, unknown>>;
  /** Router/conditional selection. Absent means "let the executor evaluate edges". */
  readonly take?: readonly string[];
}

export type FunctionBody = (view: StateView, ctx: FunctionContext) => Promise<FunctionOutcome> | FunctionOutcome;

export interface FunctionRegistryOptions {
  /**
   * Loads a body a caller never registered by hand.
   *
   * The seam exists so `resources/functions.ts` can serve digest-addressed bodies without
   * the registry importing the resource layer — which would make the run layer depend on
   * the resource layer for a case most callers never use.
   */
  readonly loader?: (ref: string) => FunctionBody | undefined;
}

export class FunctionRegistry {
  /**
   * Stack per ref, for the same reason `ToolRegistry` has one: `Disposable`'s contract is
   * that disposing a registration restores what it shadowed. A plain `Map` cannot honour
   * that. It destroyed the shadowed body outright, and — because `delete(ref)` matches a
   * KEY rather than the body that was registered — a stale handle disposed after a
   * re-registration deleted the NEW body instead of nothing at all.
   */
  readonly #stacks = new Map<string, FunctionBody[]>();
  readonly #loader: FunctionRegistryOptions["loader"];

  constructor(opts: FunctionRegistryOptions = {}) {
    this.#loader = opts.loader;
  }

  register(ref: string, body: FunctionBody): LoomDisposable {
    const stack = this.#stacks.get(ref) ?? [];
    stack.push(body);
    this.#stacks.set(ref, stack);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const s = this.#stacks.get(ref);
        if (s === undefined) return;
        const i = s.lastIndexOf(body);
        if (i >= 0) s.splice(i, 1);
        if (s.length === 0) this.#stacks.delete(ref);
      },
    };
  }

  get(ref: string): FunctionBody | undefined {
    const stack = this.#stacks.get(ref);
    const hit = stack === undefined ? undefined : stack[stack.length - 1];
    if (hit !== undefined) return hit;
    // A hand-registered body WINS over a loaded one: a test or an embedder overriding a
    // resource is doing so deliberately, and silently preferring the stored version would
    // make that override look like it worked while doing nothing.
    //
    // The loaded body is cached at the BOTTOM of the stack — reachable only because the
    // stack is empty right now — so a later hand registration shadows it and disposing
    // that override falls back to the cached body without re-entering the loader.
    const loaded = this.#loader?.(ref);
    if (loaded !== undefined) this.#stacks.set(ref, [loaded]);
    return loaded;
  }

  require(ref: string): FunctionBody {
    const f = this.get(ref);
    if (f === undefined) throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `no function registered as "${ref}"`);
    return f;
  }

  has(ref: string): boolean {
    // Unchanged in meaning: true iff a body is resident, loader cache included. `has` has
    // never consulted the loader and still does not — it answers "is one here", not "could
    // one be found".
    const stack = this.#stacks.get(ref);
    return stack !== undefined && stack.length > 0;
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
  priceOf(model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number;
  /** Worst-case cost of a request, for the budget reservation (D6.5). */
  estimateOf(req: ModelRequest): number;
}

/**
 * Adapters by provider, with a default — under `ToolRegistry`'s disposal discipline.
 *
 * A single `Map<string, ModelAdapter>` plus a `#default: string` had three defects, and
 * the third one broke every agent node in the process: `#default` kept naming a provider
 * whose adapter had been disposed, so `require()` — called with no argument by `#runAgent`
 * and by the context summariser — threw `no model adapter registered for "(default)"`
 * forever, while a perfectly good replacement sat reachable by name in the same map.
 *
 * THE DEFAULT IS A STACK OF CLAIMS, not a field. Each registration that claims the default
 * (explicitly, or implicitly because there was none) pushes a claim token; disposing that
 * registration removes ITS token, not whichever token happens to name the same provider.
 * The effective default is the newest claim whose provider still has an adapter, so
 * disposing a temporary default restores the previous one exactly the way disposing a
 * shadowed tool restores the definition underneath.
 *
 * WHEN NO CLAIM SURVIVES THERE IS NO DEFAULT, even if other providers are registered. The
 * alternative — promoting an arbitrary survivor — would silently redirect every agent node
 * to a provider nobody nominated, with different weights, different prices and a different
 * data path. A shadowed tool has a stack that says what to restore; "some other provider"
 * is not a statement anyone made. Having no default fails loudly at `require()` AND lets
 * the next registration claim it, which is what the reported hot-swap needed.
 */
export class ModelRegistry {
  readonly #stacks = new Map<string, ModelAdapter[]>();
  /** Default claims, oldest first. Object identity is what a disposer removes. */
  readonly #claims: { readonly provider: string }[] = [];

  register(adapter: ModelAdapter, asDefault = false): LoomDisposable {
    const claim = asDefault || this.#defaultProvider() === undefined ? { provider: adapter.provider } : undefined;
    const stack = this.#stacks.get(adapter.provider) ?? [];
    stack.push(adapter);
    this.#stacks.set(adapter.provider, stack);
    if (claim !== undefined) this.#claims.push(claim);

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const s = this.#stacks.get(adapter.provider);
        if (s !== undefined) {
          // BY IDENTITY. Deleting by provider name would take out whatever holds the name
          // now — including a live replacement this handle never registered.
          const i = s.lastIndexOf(adapter);
          if (i >= 0) s.splice(i, 1);
          if (s.length === 0) this.#stacks.delete(adapter.provider);
        }
        if (claim !== undefined) {
          const j = this.#claims.indexOf(claim);
          if (j >= 0) this.#claims.splice(j, 1);
        }
      },
    };
  }

  #defaultProvider(): string | undefined {
    for (let i = this.#claims.length - 1; i >= 0; i--) {
      const p = this.#claims[i]!.provider;
      if (this.#stacks.has(p)) return p;
    }
    return undefined;
  }

  get(provider?: string): ModelAdapter | undefined {
    const key = provider ?? this.#defaultProvider();
    if (key === undefined) return undefined;
    const stack = this.#stacks.get(key);
    return stack === undefined ? undefined : stack[stack.length - 1];
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
  /**
   * Every request seen, for assertions about context assembly.
   *
   * SNAPSHOTTED, not aliased. `#runAgent` builds one `messages` array before its turn loop
   * and then MUTATES it in place — `messages.push(assistant)`, `messages.push(tool_result)`
   * — while `ModelRequest.messages` holds that same array by reference. Pushing `req` here
   * therefore recorded eight pointers to one array, and every assertion about "the request
   * at turn N" read the state at the LAST turn instead. Measured on an eight-turn loop:
   * first and last both reported 28,022 tokens, and a probe written to watch the transcript
   * grow saw it flat.
   *
   * The copy is one level deep, which is exactly what this needs: `Message` is treated as
   * immutable everywhere, and it is the ARRAY the loop mutates.
   */
  readonly seen: ModelRequest[] = [];

  constructor(opts: { provider?: string; script: MockScript; pricePerMTok?: number }) {
    this.provider = opts.provider ?? "mock";
    this.#script = opts.script;
    this.#pricePerMTok = opts.pricePerMTok ?? 1;
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal.aborted) throw err.cancelled();
    this.seen.push({ ...req, messages: [...req.messages] });
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
