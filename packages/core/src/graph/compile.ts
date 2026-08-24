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
 * See design/loom/01-INTERFACES.md D3.1.
 */

import { digest, type Digest } from "../canonical.ts";
import { CODES, err, type LoomError } from "../errors.ts";
import type { NodeId } from "../ids.ts";
import { CLASSIFICATION_POSTURE_FLOOR, CLASS_DEFAULT_POSTURE, maxPosture, type Posture } from "../vocab.ts";
import {
  DEFAULT_EXPANSION,
  reachableToolNames,
  type ExpansionBudget,
  type GraphSpec,
  type NodePlan,
  type ResolvedRef,
  type RunGraph,
  observedChannels,
} from "./spec.ts";
import { indexGraph, validateGraph, type Diagnostic, type ValidationContext } from "./validate.ts";

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

  // Resolve every ref exactly once, deduped, and sorted — the manifest is part of
  // the RunGraph, so a stable order keeps two compiles of one spec identical.
  const manifest = resolveManifest(input);

  const plans: Record<NodeId, NodePlan> = {};
  const layoutRanks = computeLayoutRanks(spec, idx);

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
            ...reachableToolNames(n).flatMap((name) => {
              const entry = input.tools[name];
              return entry === undefined ? [] : [CLASS_DEFAULT_POSTURE[entry.irreversibility]];
            }),
          );
    // OBSERVED, NOT DECLARED — the same correction as the engine's `dataClassification`, and
    // it has to be made in both places. This floor becomes `plans[n.id].posture`, which the
    // graph-binding check reads as "the compiled oversight FLOOR", so leaving it computed off
    // the declared set leaves a second, quieter answer to the question the engine just fixed.
    const dataFloor = maxPosture(
      ...[...observedChannels(n), ...(n.writes ?? [])].map((c) => {
        const cls = spec.channels[c]?.classification;
        return cls === undefined ? ("out" as Posture) : CLASSIFICATION_POSTURE_FLOOR[cls];
      }),
    );

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
    subgraphs: resolveSubgraphs(input, expansion),
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

function resolveManifest(input: CompileInput): readonly ResolvedRef[] {
  const seen = new Map<string, ResolvedRef>();
  const push = (ref: string | undefined): void => {
    if (ref === undefined || seen.has(ref)) return;
    const resolved = input.resolver.resolve(ref);
    if (resolved !== undefined) seen.set(ref, resolved);
  };

  for (const n of input.spec.nodes) {
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
  for (const refs of Object.values(input.spec.hooks ?? {})) {
    if (Array.isArray(refs)) for (const ref of refs) push(ref);
  }

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
