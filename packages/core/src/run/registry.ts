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
import { CLASS_DEFAULT_POSTURE, type IrreversibilityClass } from "../vocab.ts";
import { CODES, err, type LoomError } from "../errors.ts";
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
  /**
   * The TYPED reason, when the failure has one. Carries class and code; the string does not.
   *
   * Every `isError` result used to collapse into `E_TOOL_SOURCE_UNAVAILABLE` at the tool-node
   * boundary — class `unavailable`, therefore RETRYABLE. So a permanently invalid argument was
   * re-sent to the attempt cap: measured, two retries for `${obj}` against a tool requiring a
   * string, with the tool never executing once. That is the same defect the provider layer
   * already fixed, where every 4xx was classed `unavailable` and a permanent misconfiguration
   * was re-sent until the attempts ran out.
   *
   * OPTIONAL, and its absence still means "unavailable, retryable" — a tool author reporting a
   * transient failure with `isError` alone keeps exactly the behaviour they had. What changes is
   * that the engine's OWN refusals — an argument that does not fit the schema, a tool nobody
   * registered, a policy denial — now say so in a vocabulary the retry loop reads.
   */
  readonly error?: LoomError;
}

export interface ToolDefinition extends ToolManifestLite {
  readonly description: string;
  readonly parameters: JSONSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

/**
 * THE VOCABULARY, READ OFF THE ONE TABLE THAT DEFINES IT — never a second list here.
 *
 * `CLASS_DEFAULT_POSTURE` is keyed by `IrreversibilityClass`, so its key set IS the union and
 * a member added there is accepted here with no edit. A literal copy in this file would be a
 * second representation of a vocabulary, which is the drift `registries.test.ts` exists to
 * catch.
 *
 * `Object.hasOwn` and not `in`: `"toString"` and `"constructor"` sit on the prototype of every
 * object literal, and `in` would call them members.
 */
function isIrreversibilityClass(v: unknown): v is IrreversibilityClass {
  return typeof v === "string" && Object.hasOwn(CLASS_DEFAULT_POSTURE, v);
}

const CLASS_NAMES = Object.keys(CLASS_DEFAULT_POSTURE).sort().join(", ");

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** What to call a tool in a message when its own `name` is the thing that is wrong. */
function label(v: unknown): string {
  return isNonEmptyString(v) ? `"${v}"` : `a tool whose name is ${show(v)}`;
}

/** `JSON.stringify` returns `undefined` for `undefined` and for a function; never interpolate it raw. */
function show(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return "(unserialisable)";
  }
}

/**
 * The manifest check at the door, and WHAT IT DOES WHEN IT CANNOT DECIDE: it REFUSES, by
 * throwing, with nothing registered.
 *
 * WHY HERE AND NOT ONLY IN THE TYPE. `ToolManifestLite.irreversibility` is typed
 * `IrreversibilityClass` and tsc rejects an uncast `"nuclear"`, so the direct path is closed —
 * but a type is not present at run time and the untyped seams are real: a manifest parsed from
 * JSON, an `as` cast, an extension crossing a boundary that erased the type. Measured on the
 * tree before this function existed, one `register` each, ALL FOUR ACCEPTED:
 * `irreversibility: "nuclear"`, `irreversibility: "reversible-write"` (hyphen typo),
 * `name: 42`, `idempotent: "sure"`.
 *
 * WHY IT MATTERS THAT THE WORD IS CAUGHT AT ALL. The reads downstream do not agree about the
 * unreadable case. `maxPosture` and `isLoosening` floor it at the STRONGEST and `isHardToUndo`
 * is written in the negative, so those fail closed. Five other sites still spell the pair out
 * in the POSITIVE — `run/engine.ts`'s rewind scan, `graph/mutate.ts`'s `requiresGate`, twice in
 * `graph/validate.ts`, `telemetry/spans.ts` — so a word outside the union answers `false` there
 * and walks straight past the guard. Measured, `irreversibility: "nuclear"`: `requiresGate=false`
 * and a rewind that was ALLOWED, i.e. the system believing it can undo a call it cannot
 * classify. Those five belong to other layers and are fixed there; this is defence in depth at
 * the one place the value enters.
 *
 * THE MESSAGE NAMES THE TOOL because registration is the ONE moment the typo is attributable to
 * a person. After this the value is a string in a payload and its author is gone.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK: `description`, `parameters`, `execute`. Those are
 * `ToolDefinition`'s half, not the manifest's, and each already has an owner — the arg validator
 * refuses a `parameters` that is not a schema, and a non-callable `execute` fails at the single
 * dispatch path with the call in hand. What is checked is exactly `ToolManifestLite`: the fields
 * the COMPILER and the GATES read without ever seeing the implementation.
 */
function checkManifest(t: ToolDefinition): void {
  const refuse = (why: string): never => {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `tool manifest for ${label(t.name)} is invalid and was NOT registered: ${why}`,
    );
  };
  if (!isNonEmptyString(t.name)) refuse(`name must be a non-empty string, got ${show(t.name)}`);
  if (!isNonEmptyString(t.version)) refuse(`version must be a non-empty string, got ${show(t.version)}`);
  if (!Array.isArray(t.capabilities) || t.capabilities.some((c) => typeof c !== "string")) {
    refuse(`capabilities must be an array of strings, got ${show(t.capabilities)}`);
  }
  if (!isIrreversibilityClass(t.irreversibility)) {
    refuse(
      `irreversibility must be one of ${CLASS_NAMES}, got ${show(t.irreversibility)}. A class outside ` +
        `that set is not a stricter one: the guards that decide whether a human is asked and whether ` +
        `an operator may roll back do not recognise it`,
    );
  }
  if (t.idempotent !== true && t.idempotent !== false) {
    refuse(`idempotent must be a boolean, got ${show(t.idempotent)}`);
  }
  if (t.compensation !== undefined) {
    const c: unknown = t.compensation;
    if (typeof c !== "object" || c === null || !isNonEmptyString((c as { tool?: unknown }).tool)) {
      refuse(`compensation must be { tool: <non-empty string> }, got ${show(c)}`);
    }
  }
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
    // THE MANIFEST IS CHECKED BEFORE THE SEAL IS, because the two refusals answer different
    // questions and the author fixing one should not be told about the other first: "this
    // manifest is malformed" is true whatever the seal says, and it is the one they can act
    // on. Both throw, and neither mutates the stack — a refused registration leaves whatever
    // was already there as the live definition.
    checkManifest(tool);
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
   * The TASK'S clock — its journaled lease timestamp, not the wall clock.
   *
   * Reproducible without being recorded: `task.leased.ts` is already in the journal, so a replay
   * folds the same event and computes the same number. That closes what was invariant 4's last
   * admitted gap, where this field was the engine's injected clock passed straight through and a
   * body reading it diverged on replay with nothing noting the difference.
   *
   * **TIME DOES NOT ADVANCE DURING A TASK.** Two reads in one body return the same instant. That
   * is correct for a deterministic step and it is what makes replay total. A body that needs
   * elapsed real time is describing an effect, and effects are declared rather than read.
   */
  now(): number;
  /**
   * The seed for the body's `Math.random`, drawn ONCE per task and journaled as an effect.
   *
   * NOT VISIBLE TO THE BODY. The loader's bridge consumes this to reseed `Math.random`
   * inside the realm before `__loomBody` is entered; the `ctx` a body receives still has
   * exactly `{taskId, signal, now}` and nothing else, which is what invariant 4 states.
   *
   * WHY A SEED AND NOT A RECORDED VALUE PER CALL. A body runs synchronously inside
   * `vm.runInContext` under a per-call timeout, so it cannot await a journal append between
   * two `Math.random()` calls. Recording the seed makes the whole SEQUENCE reproducible with
   * one effect: `Engine.#randomSeedEffect` draws it live under
   * `effectKey(taskId, "random", 0)` and replay serves the recorded one, so the body draws
   * the identical stream. The ordinal is `0` and not a counter because a body runs once per
   * task, and the key is deliberately stable across RETRIES — a retried body re-draws the
   * same stream, which is what "stable across retries" means everywhere else in this file.
   *
   * OPTIONAL IN THE TYPE, REQUIRED IN PRACTICE, and the bridge does not paper over the
   * difference: a `function` or `evaluator{assertion}` body invoked without one gets a
   * `Math.random` that THROWS. Both engine callers supply it. An embedder calling a
   * `FunctionBody` by hand is the only way to reach the throw, and being told is better than
   * silently running a body whose output no replay can reproduce.
   */
  readonly seed?: number;
  /**
   * The tools this node DECLARED, one bound function each. Absent when it declared none.
   *
   * `ctx.effects.charge({...})` runs the tool through the engine's single dispatch path, so it
   * is validated, policy-checked, gated when its class warrants one, journaled under a derived
   * effect key, and served from the record on replay. A body cannot reach a tool it did not
   * declare — there is no name for it to say, which is a stronger statement than a check.
   *
   * ORDER IS THE KEY. Each call takes the next ordinal for this task, so a body that makes the
   * same calls in the same order replays onto the same keys. A body whose call ORDER depends on
   * something unrecorded is a body whose replay diverges, and that is the one rule an author
   * has to hold: **the sequence of effects must be a function of the inputs.**
   *
   * ABSENT INSIDE THE SANDBOX, and honestly so. A resource-loaded body runs synchronously inside
   * `vm.runInContext` under a per-call timeout, so it cannot await anything — the same constraint
   * that made `seed` a seed rather than a recorded value per call. Bodies registered in-process
   * get this; sandboxed ones do not, and calling it there is a `TypeError` rather than a silent
   * no-op.
   */
  readonly effects?: Readonly<Record<string, (args: unknown) => Promise<ToolResult>>>;
}

export interface FunctionOutcome {
  readonly writes?: Readonly<Record<string, unknown>>;
  /** Router/conditional selection. Absent means "let the executor evaluate edges". */
  readonly take?: readonly string[];
  /**
   * "This did not work, and trying again might." The only way a body can reach `NodeSpec.retry`.
   *
   * WHY A RETURN AND NOT A THROW. Every throw out of the realm is normalized to
   * `internal`/`E_INTERNAL` with `retryable: false`, and it cannot be otherwise: `isLoomError`
   * is an `instanceof` against the HOST class, which a guest object can never satisfy, and
   * `toLoomError` deliberately refuses to read a `class` off injected code — that read is the
   * hazard four register entries are about. A returned object crosses through `intoHostRealm`,
   * which rebuilds it structurally, so no getter of the body's survives to be consulted.
   *
   * EXCLUSIVE WITH `writes` AND `take`, and `requireOutcome` refuses the combination rather
   * than picking one. "Retry me, and also commit this" has no coherent reading — the retry
   * re-runs the body, so the writes would be proposed twice.
   *
   * NO DELAY FIELD, deliberately. `#retryDecision` computes the backoff from `(policy, attempt)`
   * alone because it must be a pure function of those or replay diverges — a `function` body
   * RE-EXECUTES on replay (B11), so a delay it chose would be re-chosen against a different
   * clock. The graph owns the schedule; the body owns the verdict. `reason` is journaled on
   * the failure and reaches the operator.
   */
  readonly retry?: { readonly reason?: string };
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

/**
 * Why a model turn ended.
 *
 * `unknown:${string}` CARRIES THE PROVIDER'S OWN WORD, and it exists because both shipped
 * adapters used to end their mapper with `default: return "stop"`. That laundered every reason
 * this build does not know into the one value that means "this is a finished answer" — so
 * `turnRefusal`'s fail-closed `default:` arm in the engine was unreachable from either adapter,
 * and a truncated or paused turn with empty content was written to a channel as `""` with the
 * run reporting `succeeded`. Anthropic's documented set already includes `pause_turn` ("the model
 * paused and can be resumed"), which is precisely a non-answer.
 *
 * Keeping the raw word rather than collapsing to a bare `"unknown"` is what lets the refusal say
 * WHICH reason it did not recognise, which is the difference between a diagnosable deployment and
 * a mystery.
 */
export type FinishReason = "stop" | "tool_use" | "max_tokens" | "content_filter" | "refusal" | `unknown:${string}`;

export type ModelEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | {
      readonly type: "done";
      readonly message: Message;
      readonly finishReason: FinishReason;
      readonly usage: UsageRecord;
      /**
       * WHO ACTUALLY SERVED THIS TURN — the leaf's own identity, not the wrapper's.
       *
       * D.7.6. `model.called.provider` is the journal's only record of which provider answered,
       * and in every real deployment it read the constant `"routed"`: `openWorkspace` registers
       * a `RoutingAdapter` as the sole default, the engine journalled `adapter.provider`, and
       * the leaf that served was never asked. A `FallbackAdapter` call that failed over to
       * tier 2 was journalled identically to one that did not, so the journal could not say a
       * fallback had ever fired — the exact evidence a journal-derived circuit breaker would
       * need. It was already leaking into a shipped surface: `telemetry/spans.ts` emits
       * `gen_ai.system` from this field, so every OTLP export named the router.
       *
       * REQUIRED, and it lives on the `done` frame because the adapter that made the call is
       * the only thing that knows, and it knows at exactly the moment it reports the outcome.
       * The composites — `RoutingAdapter`, `FallbackAdapter`, `RecordingAdapter`,
       * `OneModelAdapter` — forward the leaf's frame unchanged, which they already do
       * structurally, so the answer arrives without anybody interrogating anybody.
       *
       * NO SCHEMA CHANGE PAID FOR IT: `model.called.provider` already existed and was already
       * `string`. The vocabulary was right; the writer was wrong.
       */
      readonly provider: string;
    };

export interface ModelAdapter {
  readonly provider: string;
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  priceOf(model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number;
  /**
   * Whether this adapter can price `model` AT ALL — which `priceOf` cannot answer.
   *
   * `priceOf` returns a number, and its answer for a model it has no row for is `0`. Zero is
   * also the honest price of a genuinely free endpoint, so the two are indistinguishable at
   * the one call site that has to tell them apart: a budget compares against a number, so a
   * run on an UNPRICED model spends without limit while journaling `costUsd: 0`, and
   * `policy.budget.costUsd` stops bounding anything. The CLI's only probe for this was
   * `priceOf(m, {inputTokens: 1e6, outputTokens: 1e6}) === 0`, which cannot see the
   * difference either — so an operator with a deliberate `{"input": 0, "output": 0}` row had
   * no way to say so.
   *
   * OPTIONAL, and the absence is not a loophole: a caller that gets `undefined` here falls
   * back to that same probe, which is exactly what it did before. It is optional because
   * `ModelAdapter` is on the pinned public surface and every external implementation of it
   * predates this member; making it required would break them to close a hole they may not
   * have. An adapter that CAN answer should — see `RoutingAdapter.hasPrice` in `cli.ts`,
   * which is the answer the shipped binary reads.
   *
   * `true` means "I have a rate for this model", including a rate of zero. It is not a claim
   * that the rate is right.
   */
  hasPrice?(model: string): boolean;
  /** Worst-case cost of a request, for the budget reservation (D6.5). */
  estimateOf(req: ModelRequest): number;
  /**
   * The worst-case OUTPUT tokens this request may bill — the number this adapter is about to
   * put in the request body, and nothing else.
   *
   * FOR THE RESERVATION ONLY. It caps nothing: the provider is not asked to respect it and
   * this method does not change what is sent.
   *
   * IT IS A METHOD TAKING THE REQUEST, not a field, and `RoutingAdapter` is why — the only
   * adapter the CLI ever registers resolves a different leaf per `req.model`, so a field
   * cannot answer for it at all. `estimateOf` is a method for the same reason and this
   * mirrors it deliberately.
   *
   * REQUIRED, not optional. An optional member returns the engine to a constant of its own,
   * and that constant WAS the defect (D.7.3): the engine reserved against a hard-coded 1,024
   * while both HTTP adapters sent `defaultMaxTokens ?? 4096`, so a `budget.tokens` the
   * operator set did not bind what it said it bound. An adapter that cannot know its ceiling
   * must return the LARGEST number it might permit — over-reserving refuses work that would
   * have fit, which is visible and arguable; under-reserving lets work through, and only the
   * second is a broken guard.
   */
  outputCeilingOf(req: ModelRequest): number;
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

  readonly #defaultMaxTokens: number;

  constructor(opts: { provider?: string; script: MockScript; pricePerMTok?: number; defaultMaxTokens?: number }) {
    this.provider = opts.provider ?? "mock";
    this.#script = opts.script;
    this.#pricePerMTok = opts.pricePerMTok ?? 1;
    // 1,024 keeps every existing test's arithmetic; the option exists so a test can stand an
    // adapter up with a ceiling the engine cannot guess, which is the real deployment's shape.
    this.#defaultMaxTokens = opts.defaultMaxTokens ?? 1024;
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
      provider: this.provider,
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

  /**
   * ALWAYS, for every model id, and that is the whole point of the mock.
   *
   * It fabricates a cost from one rate per million tokens with no table to miss, so there is
   * no model it cannot price. Answering `false` when `pricePerMTok` happens to be 0 would be
   * wrong in the direction that matters: a caller that fails closed on "unpriced" would refuse
   * the offline default, which is the configuration `loom run` uses on a fresh machine.
   */
  hasPrice(_model: string): boolean {
    return true;
  }

  outputCeilingOf(req: ModelRequest): number {
    return req.maxTokens ?? this.#defaultMaxTokens;
  }

  estimateOf(req: ModelRequest): number {
    return this.priceOf(req.model, { inputTokens: estimateTokens(req), outputTokens: this.outputCeilingOf(req) });
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
