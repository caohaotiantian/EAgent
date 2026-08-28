/**
 * Test doubles that REFUSE a request the engine built wrongly.
 *
 * `MockModelAdapter` is why this whole suite runs offline, and it is permissive by
 * construction: `stream` looks at `req.messages` and ignores `req.model` entirely, and
 * `priceOf` ignores it too. So every agent test in the repo is green while the engine sends
 * the graph's `agent.profile` — a *resource ref*, not a model id — as `model`, because the
 * only party that would have objected is the provider, and the provider is not there. That is the defect class these doubles exist for: **a test double certifying a
 * request nobody could actually serve.** The permissive double does not merely fail to
 * catch it; it is what makes the whole suite green over it.
 *
 * The rule for using these: when a strict double refuses, the refusal is the finding. It is
 * fixed by changing what the engine sends, never by widening the double — a double widened
 * to accept a bad request has been converted back into the thing it replaced.
 *
 * WHERE THE PREDICATE LIVES. `resourceRefsIn` and `RESOURCE_REF` are imported from
 * `src/cli.ts` rather than restated here, because the CLI applies the identical check at
 * the deployment boundary (`readModels`). One pattern, two callers: the offline detector
 * and the boundary that would otherwise pay a provider to run it.
 */

import { err, CODES } from "../../src/errors.ts";
import { RESOURCE_REF, resourceRefsIn } from "../../src/cli.ts";
import { encodeBranch, parseTaskId } from "../../src/ids.ts";
import {
  MockModelAdapter,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  type MockScript,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "../../src/run/registry.ts";

export interface StrictMockOptions {
  /**
   * The model ids this adapter will serve. REQUIRED, and there is no default.
   *
   * A default would be a set nobody chose, and "accepts anything" is precisely the
   * permissiveness being removed. The set is stated HERE because a real adapter has no such
   * set — it sends whatever it is given and lets the provider decide, which is the whole
   * reason this defect survived. What a real adapter does do locally with an id it does not
   * recognise is price it at **0** (`anthropic.ts`'s `priceOf` returns 0 when `prices` and
   * `DEFAULT_PRICES` both miss), so an unresolved ref silently disables the budget as well
   * as failing the call.
   */
  readonly models: readonly string[];
  readonly script: MockScript;
  readonly provider?: string;
  readonly pricePerMTok?: number;
}

/**
 * A `MockModelAdapter` that refuses a request a provider would refuse.
 *
 * THREE REFUSALS, and they are three different defects:
 *
 *  1. **`model` is an unresolved `kind/name@selector`.** This is H7. The graph names
 *     `agent.profile` as a `ResourceRef`; nothing between `graph/validate.ts` (whose
 *     `rule015Resources` only checks that it RESOLVES) and the provider's socket turns it
 *     into a model id, and `engine.ts`'s `#runAgent` assigns it verbatim. The message says
 *     so, because "no such model" alone would send a reader looking for a typo.
 *  2. **`model` is not one this adapter serves.** The ordinary unknown-model rejection,
 *     moved from the provider to here.
 *  3. **A `kind/name@selector` appears in the SYSTEM PROMPT or a MESSAGE.** A prompt ref
 *     that reached the model unexpanded is the same defect one field over, and it is worse
 *     than a 400 because a provider answers it happily: the model is asked to follow an
 *     instruction that is a filename, and the run succeeds having done something else.
 *
 * THE CHECKS RUN IN `stream`, NOT IN `estimateOf`, and that is deliberate rather than
 * incidental. `stream` is where a real adapter puts the bytes on the wire, so refusing there
 * puts the red test at exactly the point that would otherwise be a billed request. Checking
 * in `estimateOf` would fire one step earlier than production does and make the double's
 * failure shape stop matching the failure it stands in for.
 */
export class StrictMockModelAdapter implements ModelAdapter {
  readonly provider: string;
  readonly #models: ReadonlySet<string>;
  readonly #inner: MockModelAdapter;
  /** Every request seen, INCLUDING the refused ones — a refusal is the thing under test. */
  readonly seen: ModelRequest[] = [];

  constructor(opts: StrictMockOptions) {
    this.provider = opts.provider ?? "strict-mock";
    this.#models = new Set(opts.models);
    this.#inner = new MockModelAdapter({
      provider: this.provider,
      script: opts.script,
      ...(opts.pricePerMTok === undefined ? {} : { pricePerMTok: opts.pricePerMTok }),
    });
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.seen.push(req);
    this.#check(req);
    yield* this.#inner.stream(req, signal);
  }

  #check(req: ModelRequest): void {
    const known = [...this.#models].sort().join(", ");
    if (RESOURCE_REF.test(req.model)) {
      throw err.validation(
        CODES.E_PROVIDER_BAD_REQUEST,
        `ModelRequest.model is "${req.model}", which is a ResourceRef (kind/name@selector), not a model id. ` +
          `A provider would reject it as an unknown model, after the prompt had already been sent. ` +
          `Nothing resolves an agent's \`profile\` into a model id: ` +
          `the compiler only checks that the ref resolves, and the engine assigns it to \`model\` verbatim. ` +
          `This adapter serves: ${known}.`,
      );
    }
    if (req.model === "" || !this.#models.has(req.model)) {
      throw err.validation(
        CODES.E_PROVIDER_BAD_REQUEST,
        `no model "${req.model}" — this adapter serves: ${known}. An adapter that answered anyway would be ` +
          `pricing an unknown model at 0, which is what a real one does and why the budget stops biting.`,
      );
    }
    const inPrompt = [req.system, ...req.messages.map((m) => m.content)].flatMap((t) => resourceRefsIn(t));
    if (inPrompt.length > 0) {
      throw err.validation(
        CODES.E_PROVIDER_BAD_REQUEST,
        `an unresolved ResourceRef reached the prompt: ${[...new Set(inPrompt)].join(", ")}. A provider does not ` +
          `refuse this — it answers, having been handed a name where the content was meant to be — so nothing ` +
          `downstream would ever have reported it.`,
      );
    }
  }

  priceOf(model: string, usage: { inputTokens: number; outputTokens: number }): number {
    return this.#inner.priceOf(model, usage);
  }

  estimateOf(req: ModelRequest): number {
    return this.#inner.estimateOf(req);
  }
  outputCeilingOf(req: ModelRequest): number {
    return this.#inner.outputCeilingOf(req);
  }

  reset(): void {
    this.seen.length = 0;
  }
}

export interface StrictToolStubOptions {
  readonly name: string;
  readonly result?: ToolResult;
  /** Named one by one rather than as a `Partial<ToolDefinition>`: a spread of a Partial
   * makes every field it covers optional in the result, which would let `execute` itself
   * be overwritten with `undefined` and turn the stub into a tool that does nothing. */
  readonly capabilities?: readonly string[];
  readonly irreversibility?: ToolDefinition["irreversibility"];
}

/** One recorded invocation: the args, and the TaskId the dispatcher supplied. */
export interface StubCall {
  readonly args: Record<string, unknown>;
  readonly taskId: string;
  /** Parsed from `taskId`, so a test can assert about the branch a call came from. */
  readonly branch: string;
}

/**
 * A tool double that refuses a malformed `ToolContext` instead of ignoring it.
 *
 * The doubles in this repo take `ctx` and never look at it, which is how a `taskId` can
 * be wrong without any test noticing — and invariant 3 says that id is DERIVED, so a
 * caller that invents one has broken replay silently. `parseTaskId` throwing is the whole
 * check: it is the same parse the per-branch fs jail does, so a stub call and a real
 * `fs.write` agree about what a well-formed id is.
 *
 * It records `branch` because that is the field a caller most often wants and most rarely
 * has a way to see — a fan-out test asserting "each branch called the tool once" otherwise
 * has to re-derive the coordinate from a string it also wrote.
 */
export function strictToolStub(opts: StrictToolStubOptions): ToolDefinition & { readonly calls: StubCall[] } {
  const calls: StubCall[] = [];
  return {
    name: opts.name,
    version: "1.0",
    description: `strict stub for ${opts.name}`,
    capabilities: opts.capabilities ?? [],
    irreversibility: opts.irreversibility ?? "read_only",
    idempotent: true,
    parameters: { type: "object" },
    calls,
    execute: (args: Record<string, unknown>, ctx: ToolContext): ToolResult => {
      // THROWS, and does not return `isError`. A malformed TaskId is not a tool failure the
      // graph should be able to handle with an error edge; it is the dispatcher being wrong
      // about identity, and an error edge would absorb it into a normal-looking run.
      const parsed = parseTaskId(ctx.taskId);
      if (Number.isNaN(parsed.iteration)) {
        throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `ToolContext.taskId "${String(ctx.taskId)}" has no iteration`);
      }
      // `encodeBranch(parsed.branch)`, not a second slice of the same string: re-deriving
      // the coordinate here would be a second parser of the TaskId format, agreeing with
      // `ids.ts` on the day it was written.
      calls.push({ args, taskId: String(ctx.taskId), branch: encodeBranch(parsed.branch) });
      return opts.result ?? { content: `ok: ${opts.name}` };
    },
  };
}
