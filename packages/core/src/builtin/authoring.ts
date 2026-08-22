/**
 * `graph-from-goal` — the authoring front door, which is itself a Loom graph.
 *
 * Nobody hand-writes a GraphSpec unprompted. That was the highest-rated adoption risk
 * in the register (R2), and the answer is to let someone describe the task and have a
 * model propose the graph — with the **real compiler** as the feedback signal rather
 * than a model's opinion of its own output.
 *
 * Three properties fall out of making the author a graph rather than a special mode:
 *
 *   1. **The compiler's 22 rules are the critic.** Each diagnostic already carries a
 *      `fix` string written for exactly this — `add "signal" to node "investigate".reads`.
 *      The model is not guessing at correctness; it is being told precisely what is
 *      wrong by the same rules that gate production.
 *   2. **The loop is bounded by construction** (`GRAPH006`), so a model that cannot
 *      converge fails after three attempts instead of spinning.
 *   3. **It dogfoods the runtime.** Authoring exercises an agent node, an evaluator, a
 *      bounded loop, and a human gate — so if authoring works, the runtime works.
 *
 * The model can propose a graph that is wrong. It cannot propose one that weakens
 * oversight (`GRAPH014`), overcommits budget (`GRAPH009`), or races on a channel
 * (`GRAPH010`) — those are not stylistic preferences, they are compile errors.
 */

import { compile } from "../graph/compile.ts";
import type { GraphSpec } from "../graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../graph/validate.ts";
import type { FunctionBody } from "../run/registry.ts";
import type { NodeId, EdgeId } from "../ids.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

/** The authoring workflow. Ships as a built-in graph. */
export function authoringGraph(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: {
      name: "graph-from-goal",
      project: "loom",
      version: 1,
      description: "Describe a task; get a compiled, reviewed GraphSpec.",
    },
    policy: {
      posture: "on",
      budget: { costUsd: 2.0, tokens: 400_000, wallMs: 300_000 },
      expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 2, maxLoopIterations: 3 },
      capabilities: [],
      // `gate` is a compile error: designed, not built. See graph/validate.ts.
      onBudgetExhausted: "fail",
    },
    channels: {
      goal: { type: "string", reduce: "replace" },
      /** The proposed GraphSpec. Replaced wholesale each attempt. */
      candidate: { type: "object", reduce: "replace" },
      /** Compiler output, rendered for the next prompt. Replaced, not appended: the
       *  model must see the CURRENT problems, not a growing archaeology of old ones. */
      diagnostics: { type: "array", reduce: "replace" },
      valid: { type: "boolean", reduce: "replace", initial: false },
      costUsd: { type: "number", reduce: "sum", initial: 0 },
    },
    inputs: ["goal"],
    outputs: ["candidate"],
    nodes: [
      {
        id: n("propose"),
        type: "agent",
        reads: ["goal", "diagnostics"],
        writes: ["candidate", "costUsd"],
        agent: {
          profile: "agent_profile/graph-author@stable",
          prompt: "prompt/propose-graphspec@stable",
          maxTurns: 2,
          tools: [],
          outputSchema: { type: "object" },
        },
        policy: { budget: { costUsd: 0.5 } },
        timeoutMs: 120_000,
      },
      {
        id: n("validate"),
        type: "evaluator",
        reads: ["candidate"],
        writes: ["valid", "diagnostics"],
        evaluator: { kind: "assertion", ref: "function/validate-graphspec@stable", threshold: 1 },
      },
      {
        id: n("accept"),
        type: "human_gate",
        reads: ["candidate", "diagnostics", "goal"],
        writes: ["candidate"],
        humanGate: { ref: "oversight/graph-accept@stable" },
        checkpoint: "before",
      },
    ],
    edges: [
      { id: e("e1"), from: n("propose"), to: n("validate"), kind: "seq" },
      // Bounded by construction: `validate` writes `valid`, so the cycle can progress,
      // and three attempts is the hard ceiling.
      { id: e("e2"), from: n("validate"), to: n("propose"), kind: "loop", until: "valid", maxIterations: 3 },
      { id: e("e3"), from: n("validate"), to: n("accept"), kind: "conditional", when: "valid" },
    ],
  };
}

export interface AuthoringDeps {
  readonly resolver: ResourceResolver;
  readonly tools: Readonly<Record<string, ToolManifestLite>>;
  readonly tenantCapabilities?: readonly string[];
  /** The baseline the candidate may not weaken. Absent for a brand-new graph. */
  readonly baselinePostures?: Readonly<Record<string, string>>;
}

/**
 * The critic: run the real compiler over the proposed spec.
 *
 * Deliberately NOT a rubric judge. A model asked "is this graph good?" will say yes;
 * the compiler will say `GRAPH009_BUDGET_OVERCOMMIT: worst-case declared spend is
 * $22.50 but the graph budget is $12.00`, which is both true and actionable.
 */
export function validateGraphSpecFunction(deps: AuthoringDeps): FunctionBody {
  return (view) => {
    const candidate = view.get<GraphSpec>("candidate");
    if (candidate === undefined || typeof candidate !== "object") {
      return {
        writes: {
          valid: false,
          diagnostics: [{ severity: "error", code: "AUTHOR001_NO_CANDIDATE", message: "no GraphSpec was proposed" }],
        },
      };
    }

    const result = compile({
      spec: candidate,
      resolver: deps.resolver,
      tools: deps.tools,
      ...(deps.tenantCapabilities === undefined ? {} : { tenantCapabilities: deps.tenantCapabilities }),
      ...(deps.baselinePostures === undefined ? {} : { baselinePostures: deps.baselinePostures as never }),
    });

    // Warnings are surfaced too, but they do not block: a graph that compiles with a
    // warning is a graph a human can accept.
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    return {
      writes: {
        valid: result.ok,
        diagnostics: result.diagnostics.map((d) => ({
          severity: d.severity,
          code: d.code,
          message: d.message,
          ...(d.fix === undefined ? {} : { fix: d.fix }),
          ...(d.at === undefined ? {} : { at: d.at }),
        })),
      },
      // No `take`: the executor evaluates `valid` on the outgoing edges itself, so the
      // loop-vs-accept decision stays in the graph rather than in this function.
      ...(errors.length === 0 ? {} : {}),
    };
  };
}

/**
 * The system prompt fragment that makes the loop work.
 *
 * Exported rather than inlined so it can be pinned as a Prompt resource and versioned
 * like anything else — and so the eval gate can measure a change to it.
 */
export const PROPOSE_INSTRUCTIONS = `You author Loom GraphSpec documents as JSON.

Return ONLY a JSON object conforming to GraphSpec: apiVersion "loom.dev/v1", kind
"GraphSpec", metadata, channels, inputs, outputs, nodes, edges.

Rules the compiler will enforce, so do not fight them:
  - every fanout edge needs maxWidth AND a downstream join
  - every loop edge needs maxIterations AND an 'until' a node inside the cycle can change
  - a router cannot write state; its whole output is which edges to take
  - a channel written by two concurrent branches needs a multi-writer-safe reducer
    (append_ordered, sum, merge_object, union_set, max, min) — never 'replace'
  - per-node budgets times fan-out width must not exceed the graph budget
  - a node may only reference channels it declares in reads (or writes, on an edge)

If a previous attempt produced diagnostics, they are in the 'diagnostics' field of your
input. Each carries a 'fix'. Apply the fixes; do not restate the same graph.`;
