/**
 * The GraphCompiler.
 *
 * Pure: same `(spec, resolved digests)` always produces an identical `RunGraph`,
 * including `graphHash`. No side effects and no durable writes, so the editor can
 * call it on every keystroke.
 *
 * Its two jobs are the ones that make the rest of the system's guarantees hold:
 *
 *   1. **Validate everything before anything runs.** An invalid model-emitted spec
 *      must have no side effects at all.
 *   2. **Pin every resource ref to an immutable digest.** The resulting resolution
 *      manifest is what makes the pinning rule real — a Run reads only what its
 *      manifest names, so a Resource published or promoted mid-run cannot affect it.
 *
 */

import { digest, type Digest } from "../canonical.ts";
import { CODES, err, type LoomError } from "../errors.ts";
import type { NodeId } from "../ids.ts";
import { CLASSIFICATION_POSTURE_FLOOR, CLASS_DEFAULT_POSTURE, maxPosture, type Posture } from "../vocab.ts";
import {
  DEFAULT_EXPANSION,
  dataFloorOf,
  type ExpansionBudget,
  type GraphSpec,
  type NodePlan,
  type NodeSpec,
  type ResolvedRef,
  type RetryPolicy,
  type RunGraph,
  observedChannels,
} from "./spec.ts";
import { indexGraph, reachableToolNamesThrough, validateGraph, type Diagnostic, type ValidationContext } from "./validate.ts";

/**
 * The retry policy a provider-calling node gets when its author declared none.
 *
 * NOT EXPORTED. `scripts/surface.json` pins the package's exported name set, and this is an
 * implementation of a default rather than a piece of vocabulary a caller needs — what a caller
 * needs is the effective policy, and that is on `NodePlan.retry` where it can be READ.
 *
 * `maxAttempts: 3` — one attempt and two retries. Two covers the case that actually happens (one
 * rate limit, one blip); more turns an unhealthy provider into a slow, expensive failure, and the
 * engine adds no jitter, so every client's curve is identical and a longer one means more clients
 * arriving together.
 *
 * `initialMs: 1000` rather than `#retryDecision`'s bare `?? 500`, because a provider's rate-limit
 * window is measured in seconds. It is only ever the floor: the engine takes
 * `max(curve, retry-after)`, so a provider that SAYS when it will serve us again always wins.
 *
 * NO `onlyIf`, which is the interesting half. Narrowing to `E_PROVIDER_RATE_LIMIT` would leave
 * `E_PROVIDER_OVERLOADED` (529/503/502/504) and `E_PROVIDER_TRANSPORT` (408/425) unretried, and
 * those are the transient failures that actually dominate. The retryable class is already
 * `{exhausted, unavailable, timeout}` and `#retryDecision` already subtracts three things from
 * it — a non-retryable class, `RUN_FATAL_CODES`, and a non-idempotent tool that already reached
 * its sandbox — so what is left reaching an agent node is transient-provider-shaped by
 * construction. `onlyIf` stays available to an author who wants the narrow policy; a default
 * never widens one.
 */
const DEFAULT_PROVIDER_RETRY: RetryPolicy = {
  maxAttempts: 3,
  backoff: "exponential",
  initialMs: 1_000,
  maxMs: 30_000,
};

/** See `reEntersAChild`: a parent polling a working child, not a call being repeated. */
const DEFAULT_SUBGRAPH_RETRY: RetryPolicy = {
  maxAttempts: 20,
  backoff: "exponential",
  initialMs: 250,
  maxMs: 5_000,
};

/**
 * Whether this node can reach a model provider, and therefore whether the default applies.
 *
 * ESTABLISHED BY READING THE EXECUTOR, not by assuming. `this.models` is consulted at exactly
 * three places in `run/engine.ts`: its constructor, `#runAgent`, and `#summarizeEffect` — and
 * `#summarizeEffect` is only reached from inside an agent task's context assembly. `#runEvaluator`
 * has two arms: `assertion` runs a `FunctionBody` and touches no provider, while `rubric`
 * delegates to `#runAgent`. So the set is an `agent` node and a `rubric` evaluator, which is also
 * the predicate `cli.ts` already uses to decide whether a graph "will actually reach a model".
 *
 * A `tool` NODE IS DELIBERATELY OUT, including one whose tool speaks HTTP. Its transport belongs
 * to whoever wrote the tool, the manifest describes irreversibility rather than retryability, and
 * the engine already treats a started non-idempotent tool effect as unretryable. Defaulting here
 * would be Loom deciding on an extension's behalf that its side effect is safe to repeat. A tool
 * node that wants retry declares one.
 *
 * A `function` node is out because a deterministic throw throws again: retrying it spends the
 * budget and hides the bug.
 */
function reachesProvider(n: NodeSpec): boolean {
  return n.type === "agent" || (n.type === "evaluator" && n.evaluator?.kind === "rubric");
}

/**
 * A `subgraph` node needs a retry policy for a DIFFERENT reason, and it is the engine's own.
 *
 * `#runSubgraph` returns `E_SUBGRAPH_FAILED` as retryable-`unavailable` when the child is not
 * terminal, and says why in as many words: "the parent's own retry policy re-enters this node,
 * which re-advances the child, which is precisely the 'come back later' this needs." A child in
 * retry backoff, or one starved by `maxParallelism`, comes back `running` — and with no policy
 * on the parent, `#retryDecision` returns early and the RUN FAILS on a child that was about to
 * continue.
 *
 * That was latent before provider nodes had a default: no node had one, so a child was rarely
 * mid-backoff. Giving `agent` nodes a default makes "the child is still working" the ordinary
 * case, so this stops being latent — the fix creates the exposure and must carry it.
 *
 * MORE ATTEMPTS THAN A PROVIDER GETS, and a shorter ceiling. Re-entry is cheap (it re-advances a
 * projection, it does not call anything) and a legitimate child can take far longer than three
 * exponential backoffs allow — three attempts topping out at 30 s would fail a child that is
 * merely slow, which is the opposite of the point.
 */
function reEntersAChild(n: NodeSpec): boolean {
  return n.type === "subgraph";
}

/**
 * The retry policy this node will actually run under.
 *
 * A FLOOR FOR NODES THAT DECLARED NOTHING, never an override and never a merge. A merge would
 * silently widen an author who wrote `maxAttempts: 1` — and "oversight only tightens" has a
 * sibling here: a default may add a policy where there was none, and may not touch one there is.
 */
function effectiveRetry(n: NodeSpec): RetryPolicy | undefined {
  if (n.retry !== undefined) return n.retry;
  if (reachesProvider(n)) return DEFAULT_PROVIDER_RETRY;
  return reEntersAChild(n) ? DEFAULT_SUBGRAPH_RETRY : undefined;
}

/**
 * The deadline a node gets when its author declared none, in ms.
 *
 * NOT EXPORTED, for `DEFAULT_PROVIDER_RETRY`'s reason: what a caller needs is the effective
 * number, and that is on `NodePlan.timeoutMs` where it can be READ and where `loom compile`
 * prints it.
 *
 * LOOKED UP, NOT GUESSED. Nothing in `providers/` sets a request deadline — `anthropic.ts`,
 * `openai.ts` and `fallback.ts` each take only the run's `AbortSignal`, and `http.ts` passes it
 * to `fetch` unmodified, so a provider that accepts a connection and never writes a byte is
 * bounded by nothing in this process. The number is therefore the vendor SDKs' own: both the
 * Anthropic and OpenAI clients default to a **10-minute** per-request timeout. Using theirs
 * makes this a BACKSTOP rather than a policy — it can only fire where a request has already
 * outlived the deadline its own SDK would have applied, which is exactly the case this tree has.
 *
 * ONE NUMBER FOR `agent`, `tool`, `evaluator` AND `function` ALIKE, deliberately. A per-type
 * figure would imply a precision nobody here has measured; this is the difference between "fails
 * eventually" and "never", not a tuning knob. An author who wants a real bound writes one, and
 * `NodeSpec.timeoutMs` always wins.
 *
 * IT IS AN OUTER BOUND, not the only one. A tool with its own clock still fires first
 * (`mcp/client.ts` at 30 s, `sandbox/subprocess.ts`'s required `timeoutMs`), and so does a
 * sandboxed `function` body's realm deadline. Nothing here loosens any of them.
 */
const DEFAULT_NODE_TIMEOUT_MS = 600_000;

/**
 * The node types that get a default deadline, and why `router`, `join`, `human_gate` and
 * `subgraph` do not.
 *
 * EVERY CLAIM BELOW NAMES ITS MEMBERS AND NONE OF THEM COUNTS. Not a style preference — it is
 * what this docstring was corrected for twice and stayed wrong through. `function` joined the set
 * and the prose saying "three" was fixed where a reader looks first, at the headline and at the
 * "why the other N do not" line, while "only these three can" — mid-sentence, directly above
 * bullets naming `agent`, `tool`, `evaluator` and `function` — survived both passes. A count is a
 * second, unlinked statement of a fact the enumeration beside it already carries, so it rots
 * alone and silently; a name cannot. `test/graph/deadline-set-is-named-not-counted.test.ts` holds
 * this region to that rule and to the set the compiler actually applies.
 *
 * THE SET IS `agent`, `tool`, `evaluator`, `function`. Read off `Engine.#dispatchBody`, which is
 * the only thing `#withNodeDeadline` wraps — so the question is not "can this node type take a
 * long time" but "can its BODY fail to settle", and only those can:
 *
 *   - `agent` — `#runAgent` awaits a provider stream that no clock in this tree bounds.
 *   - `tool` — `#runToolNode` awaits an extension's `execute`. The case `node-timeout.test.ts`
 *     was written for: "a hanging tool held its Task forever".
 *   - `evaluator` — its `rubric` arm delegates to `#runAgent`, so it inherits the first case
 *     whole. Given to the TYPE rather than to the arm because the `assertion` arm's other host,
 *     a hand-registered `FunctionBody`, is host code with no realm and no timeout either (A13).
 *   - `function` — and this one was EXCLUDED first, on an argument that turned out to be false.
 *     The argument was "a graph-reachable body cannot fail to settle", because `realm.ts` refuses
 *     an `async` body at load and a returned thenable when it returns, leaving something `vm`'s
 *     per-call timeout terminates. That is true of a body loaded THROUGH THE REALM and of nothing
 *     else: `FunctionRegistry.register` refuses nothing, and it is one of the ten no-fork
 *     extension points README names. Driven —
 *       functions.register("function/hang@stable", async () => new Promise(() => {}));
 *     on a `function` node declaring no `timeoutMs` — `STILL HANGING after 1500ms`, the identical
 *     reproduction that opened this item for `tool`. The exclusion's own stated residue covered
 *     only the SYNCHRONOUS half of a hand-registered body, where a deadline genuinely cannot help
 *     because that body owns the event loop and the timer could not fire; the async half is
 *     bounded by this default exactly as well as any other node's. Inert for realm-loaded bodies,
 *     by the 30 s argument above, which is the reason it costs them nothing.
 *
 * `router`, `join`, `human_gate` AND `subgraph` GET NONE, each for its own reason and none of
 * them "we forgot":
 *
 *   - `router` — `#runRouter` evaluates declared expressions against the scope and returns. No
 *     await, no I/O.
 *   - `join` — `#dispatchBody` returns `{status: "succeeded"}` synchronously; a join's waiting
 *     happens in the SCHEDULER, which is not what this deadline wraps, so a number here would be
 *     inert. It would also be `JoinNode.timeoutMs` under a new name — the field this schema
 *     deleted, for the reason its docstring still gives.
 *   - `human_gate` — same structural inertness (it returns `{status: "gate"}` synchronously),
 *     and it must not get one even if it were reachable: a gate's clock is `slaMs` plus
 *     `onTimeout`, an author's explicit choice about what happens when nobody answers. A gate
 *     that expires because nobody wrote a number is oversight failing OPEN.
 *   - `subgraph` — `#runSubgraph`'s body is `await this.advance(childRunId)`, so a constant here
 *     would bound a whole child RUN by a per-node figure. Every node in that child now carries
 *     its own default, which is the locus that can actually enforce one — the same argument the
 *     deleted barrier deadline lost.
 */
function effectiveTimeout(n: NodeSpec): number | undefined {
  if (n.timeoutMs !== undefined) return n.timeoutMs;
  return n.type === "agent" || n.type === "tool" || n.type === "evaluator" || n.type === "function"
    ? DEFAULT_NODE_TIMEOUT_MS
    : undefined;
}

export type CompileInput = Omit<ValidationContext, "depth" | "expanding">;

export type CompileResult =
  | { readonly ok: true; readonly graph: RunGraph; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly error: LoomError; readonly diagnostics: readonly Diagnostic[] };

export interface GraphCompiler {
  compile(input: CompileInput): CompileResult;
  /**
   * Diagnostics only — for the editor, which wants warnings without a RunGraph.
   *
   * **THERE IS NO EDITOR.** That host is the interface's whole reason for existing and it does
   * not exist, so nothing in `src/` calls this; the only in-tree caller of `analyze` is the test
   * named "analyze returns diagnostics without building a RunGraph" in `graph/compile.test.ts`.
   */
  analyze(input: CompileInput): readonly Diagnostic[];
}

/**
 * The `GraphCompiler` object form of `compile`.
 *
 * **NO PRODUCTION CALLER**, and the set is named rather than totalled, because "compile site" is
 * ambiguous in this tree: `resources/functions.ts` and `resources/hook-loader.ts` each have a
 * local `compile` of their own that has nothing to do with graphs.
 *
 * The bare `compile()` below has exactly **six** callers in `src/` — `cli.ts`, `graph/mutate.ts`,
 * `run/engine.ts`, `builtin/authoring.ts`, `compileOrThrow` further down this file, and this
 * function's own delegation. This wrapper is reached by none of them. Total REACH of the graph
 * compiler is one higher than six, because `engine.ts` also arrives through `compileOrThrow`;
 * that is why this counts callers of a named function instead of claiming a total. What the
 * wrapper adds over the function is `analyze` alone, which nothing in `src/` calls — one test
 * does, as the interface above says.
 *
 * Kept exported — it is pinned in `scripts/surface.json`, so removing it is a public-surface
 * change and a separate decision — and documented as unused rather than left looking
 * load-bearing. **Prefer the bare `compile()` inside this package**, which is what all six do.
 */
export function createGraphCompiler(): GraphCompiler {
  return {
    analyze: (input) => validateGraph({ ...input, depth: 0, expanding: [] }),
    compile: (input) => compile(input),
  };
}

export function compile(input: CompileInput): CompileResult {
  const diagnostics = validateGraph({ ...input, depth: 0, expanding: [] });
  const errors = diagnostics.filter((d) => d.severity === "error");

  if (errors.length > 0) {
    const loosened = errors.some((e) => e.code === "GRAPH014_OVERSIGHT_LOOSENED");
    return {
      ok: false,
      diagnostics,
      // Class matters more than code: generic machinery branches on class. A bad
      // graph is the caller's fault (validation); a loosened one is a policy refusal.
      error: (loosened ? err.policy : err.validation)(
        loosened ? CODES.E_OVERSIGHT_LOOSENED : CODES.E_GRAPH_INVALID,
        loosened
          ? `graph would weaken oversight at ${errors.filter((e) => e.code === "GRAPH014_OVERSIGHT_LOOSENED").length} node(s)`
          : `graph has ${errors.length} error(s): ${errors.slice(0, 3).map((e) => e.code).join(", ")}${errors.length > 3 ? ", …" : ""}`,
        { details: { diagnostics: errors } },
      ),
    };
  }

  const { spec } = input;
  const idx = indexGraph(spec);
  const expansion: ExpansionBudget = { ...DEFAULT_EXPANSION, ...(spec.policy?.expansion ?? {}) };

  const plans: Record<NodeId, NodePlan> = {};
  const layoutRanks = computeLayoutRanks(spec, idx);
  // HOISTED ABOVE THE PLAN LOOP, because the class floor now reads it. This is the same map the
  // `RunGraph` carries and `Engine.#runSubgraph` executes from, so the floor a `subgraph` node is
  // given at compile is computed from exactly the child bytes the run will use — not from a
  // second resolver call that could answer differently.
  //
  // AND ABOVE THE MANIFEST, which is the newer reason and the load-bearing one — see
  // `resolveManifest`. The manifest pins the refs of these child specs too, so it cannot be
  // built until they are collected.
  const subgraphs = resolveSubgraphs(input, expansion);

  // Resolve every ref exactly once, deduped, and sorted — the manifest is part of
  // the RunGraph, so a stable order keeps two compiles of one spec identical.
  const manifest = resolveManifest(input, subgraphs);
  const childSpec = (ref: string): GraphSpec | undefined => subgraphs[ref] ?? input.resolver.subgraph?.(ref);

  for (const n of spec.nodes) {
    // `max` over every tool the node can reach. An agent node names no tool, so keying
    // this on `n.tool` alone floored every agent at `out` no matter what its model could
    // call — the compile-time half of the same blind spot the engine had at dispatch.
    const classFloor: Posture =
      n.type === "human_gate"
        ? "in"
        : maxPosture(
            "out",
            // An unknown name contributes nothing, exactly as before: whether a tool the
            // compiler cannot see should floor the node is a separate question from which
            // tools the node can reach, and answering it here would gate every graph
            // compiled against a partial manifest map.
            // THROUGH A SUBGRAPH TOO. A `subgraph` node names no tool, so it was floored at `out`
            // however irreversible its child was — see `reachableToolNamesThrough` for the three
            // things folding the child in actually buys, and for what it does NOT claim.
            ...reachableToolNamesThrough(n, childSpec, expansion.maxDepth).flatMap((name) => {
              const entry = input.tools[name];
              return entry === undefined ? [] : [CLASS_DEFAULT_POSTURE[entry.irreversibility]];
            }),
          );
    // OBSERVED, NOT DECLARED — the same correction as the engine's `dataClassification`, and
    // it has to be made in both places. This floor becomes `plans[n.id].posture`, which the
    // graph-binding check reads as "the compiled oversight FLOOR", so leaving it computed off
    // the declared set leaves a second, quieter answer to the question the engine just fixed.
    const dataFloor = dataFloorOf(spec.channels, n);
    const retry = effectiveRetry(n);
    const timeoutMs = effectiveTimeout(n);

    plans[n.id] = {
      id: n.id,
      maxInstances: idx.multiplicity.get(n.id) ?? 1,
      criticalPathLength: idx.criticalPath.get(n.id) ?? 1,
      inboundEdges: (idx.inbound.get(n.id) ?? []).map((e) => e.id),
      outboundEdges: (idx.outbound.get(n.id) ?? []).map((e) => e.id),
      // Every level enters through `max`, so no single declaration can weaken it.
      posture: maxPosture(
        input.systemPostureFloor ?? "out",
        spec.policy?.posture ?? "out",
        classFloor,
        dataFloor,
        n.policy?.posture ?? "out",
      ),
      layoutRank: layoutRanks.get(n.id) ?? 0,
      ...(retry === undefined ? {} : { retry }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }

  const graph: RunGraph = {
    // The hash covers the SPEC ONLY — not the manifest, not the plans. Plans are
    // derived (recomputing them must not change identity), and the manifest is
    // recorded separately in `run.compiled` so a re-resolve is visible as its own
    // fact rather than as a different graph.
    graphHash: digest(spec),
    spec,
    plans,
    entryNodes: idx.entryNodes,
    terminalNodes: idx.terminalNodes,
    resolutionManifest: manifest,
    documents: resolveDocuments(input, manifest),
    subgraphs,
    expansion,
  };

  return { ok: true, graph, diagnostics };
}

/**
 * The text behind every pinned ref whose resolver has one, keyed by ref.
 *
 * Read through the DIGEST the manifest just froze, never through the ref: `document(pinned)`
 * is the run-time half of the resource contract and this is the last moment at which "the
 * pin" and "the bytes" are guaranteed to agree. A resolver with no `document` hook — every
 * pin-only resolver, which is most of them — contributes nothing and the map stays empty.
 */
function resolveDocuments(input: CompileInput, manifest: readonly ResolvedRef[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const pinned of manifest) {
    const text = input.resolver.document?.(pinned.digest);
    if (text !== undefined) out[pinned.ref] = text;
  }
  return out;
}

/**
 * Every child spec reachable from this graph, keyed by ref.
 *
 * WALKED RECURSIVELY, because the point is that nothing asks a resolver anything once a Task is
 * executing — and `Engine.#compileChild` compiles a child, which reads that child's own refs. A
 * top-level-only map would relocate the read rather than remove it.
 *
 * `reachedAt` is the cycle guard and the bound is the ROOT's `expansion.maxDepth`. That is not
 * the validator's rule: `validateGraph` recomputes the budget from each level's own
 * `policy.expansion`, so a root declaring `maxDepth: 1` over children declaring `9` accepts a
 * tree this collector stops walking. Collecting less than the validator accepted is safe —
 * `#compileChild` falls back to the live resolver for a ref that was not frozen — and it is
 * recorded rather than reconciled, because agreeing would mean a second implementation of a
 * rule whose diagnostics are the validator's job.
 */
function resolveSubgraphs(input: CompileInput, expansion: ExpansionBudget): Readonly<Record<string, GraphSpec>> {
  const out: Record<string, GraphSpec> = {};
  // THE DEPTH EACH REF WAS REACHED AT, not merely whether it was seen. Skipping an already-seen
  // ref is the cycle guard, and on its own it also skips DESCENDING — so a ref first reached at
  // the depth limit was recorded and never walked through, even when a shallower path to it
  // came later in the node list. Measured on `root→[B,X], B→X, X→Y` at `maxDepth: 2`: `Y` was
  // lost, and reversing the two nodes found it. Re-walking when a ref turns up shallower makes
  // the answer independent of node order, which is the only version a compiled artifact can be.
  const reachedAt = new Map<string, number>();
  const walk = (spec: GraphSpec, depth: number): void => {
    if (depth > expansion.maxDepth) return;
    for (const n of spec.nodes) {
      const ref = n.subgraph?.ref;
      if (ref === undefined) continue;
      const seen = reachedAt.get(ref);
      if (seen !== undefined && seen <= depth) continue;
      const child = input.resolver.subgraph?.(ref);
      if (child === undefined) continue;
      reachedAt.set(ref, depth);
      out[ref] = child;
      walk(child, depth + 1);
    }
  };
  walk(input.spec, 1);
  return out;
}

/**
 * Every ref this spec's own nodes name, in one place so the root and a frozen child are walked
 * identically. The seven sites are `validate.ts`'s `collectRefs` list; the two must agree, or a
 * ref the validator insisted exists is one the manifest never pinned.
 */
function pushRefsOf(spec: GraphSpec, push: (ref: string | undefined) => void): void {
  for (const n of spec.nodes) {
    push(n.function?.ref);
    push(n.agent?.profile);
    push(n.agent?.prompt);
    push(n.router?.profile);
    push(n.evaluator?.ref);
    push(n.humanGate?.ref);
    push(n.subgraph?.ref);
  }
  // Guarded like `collectRefs`'s copy: `hooks: {beforeNode: 42}` is caller data, and iterating it
  // returned `E_INTERNAL: TypeError: refs is not iterable` from the compiler. The VALIDATOR
  // refuses that shape, but this runs on the manifest path and must not crash on the way there.
  for (const refs of Object.values(spec.hooks ?? {})) {
    if (Array.isArray(refs)) for (const ref of refs) push(ref);
  }
}

/**
 * The pinning rule's own artifact: every ref this Run may read, frozen to a digest.
 *
 * **THE CHILD SPECS ARE WALKED TOO, and leaving them out was D7 one level down.** This used to
 * take `input.spec` alone while `resolveSubgraphs` walked children recursively, so the two
 * disagreed about what the Run could reach: a parent naming `subgraph/child@stable` pinned that
 * ref and nothing inside it. The child's own `prompt/…` and `function/…` refs were in neither
 * the manifest nor `documents`, and `Engine.#compileChild` — which runs during `advance`, while
 * the parent's Task is executing — falls through `frozenFirst` to the LIVE resolver for anything
 * the freeze does not hold. Reproduced end to end in ONE process with no restart: a parent
 * compiled against `prompt/inner@stable` = "INNER PROMPT v1", a `publish` + `promote` to v2
 * after `submit`, and the model received v2 on a run that reported `succeeded`. Nothing refused,
 * because nothing was bound — `run.compiled.resolutionManifest` named only the subgraph ref, so
 * `#assertBound` had no digest to find moved.
 *
 * Walking them makes `frozenFirst` serve those refs from the parent's own freeze, which closes
 * it in `compile.ts` alone. It does NOT touch `graphHash` — that is `digest(spec)` and stays
 * so — which is the point: the RUN is pinned and the cohort key is not. `evolution/score.ts`'s
 * `cohortKeyOf` keys on `graphHash`, so two runs of one workflow across a prompt edit stay
 * comparable, which is what lets the evolution loop measure a prompt candidate at all.
 *
 * BOUNDED BY WHAT `resolveSubgraphs` COLLECTED, deliberately, rather than by a second walk of
 * its own. That map is already the root's `expansion.maxDepth` truncation of the tree, and it is
 * the exact set of child specs the `RunGraph` carries — so the manifest pins the refs of the
 * children the Run will actually execute from, and a deeper child that `#compileChild` falls
 * back to the live resolver for is one this compile never froze either.
 */
function resolveManifest(input: CompileInput, subgraphs: Readonly<Record<string, GraphSpec>>): readonly ResolvedRef[] {
  const seen = new Map<string, ResolvedRef>();
  const push = (ref: string | undefined): void => {
    if (ref === undefined || seen.has(ref)) return;
    const resolved = input.resolver.resolve(ref);
    if (resolved !== undefined) seen.set(ref, resolved);
  };

  pushRefsOf(input.spec, push);
  for (const child of Object.values(subgraphs)) pushRefsOf(child, push);

  return [...seen.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/**
 * Layered ranks for the UI, computed here so the browser never runs graph layout.
 * A node sits one rank below its deepest forward predecessor.
 */
function computeLayoutRanks(spec: GraphSpec, idx: ReturnType<typeof indexGraph>): Map<NodeId, number> {
  const rank = new Map<NodeId, number>();
  for (const n of spec.nodes) rank.set(n.id, 0);
  for (const id of idx.topoOrder) {
    let best = 0;
    for (const e of idx.inbound.get(id) ?? []) {
      if (e.kind === "loop" || e.kind === "compensation") continue;
      best = Math.max(best, (rank.get(e.from) ?? 0) + 1);
    }
    rank.set(id, best);
  }
  return rank;
}

/** Convenience for tests and the CLI: throw instead of returning a result union. */
export function compileOrThrow(input: CompileInput): RunGraph {
  const r = compile(input);
  if (!r.ok) throw r.error;
  return r.graph;
}

/** Recompute the hash of a spec without compiling. Used by trace reconstruction. */
export function graphHashOf(spec: GraphSpec): Digest {
  return digest(spec);
}
