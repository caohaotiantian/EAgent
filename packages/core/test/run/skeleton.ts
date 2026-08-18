/**
 * The walking skeleton, as a reusable harness.
 *
 * The graph is from design/loom/08-PLAN.md D13.3: fan out over N documents, summarize
 * each in parallel, join in branch order, merge, gate on a human, then write. It is
 * the smallest slice that exercises every architectural claim at once, which is why
 * the acceptance test drives this and not a simpler graph.
 */

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type MockScript,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

export const SKELETON_TENANT_CAPS = ["fs:read", "fs:write"];

export function skeletonSpec(over: Partial<GraphSpec> = {}): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "skeleton-summarize", project: "demo", version: 1 },
    policy: {
      posture: "on",
      budget: { costUsd: 1.0, tokens: 200_000, wallMs: 120_000 },
      expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 5, maxLoopIterations: 1 },
      capabilities: ["fs:read", "fs:write"],
    },
    channels: {
      paths: { type: "array", reduce: "replace" },
      path: { type: "string", reduce: "replace" },
      digests: { type: "array", reduce: "append_ordered" },
      merged: { type: "object", reduce: "replace" },
      written: { type: "object", reduce: "replace" },
      costUsd: { type: "number", reduce: "sum", initial: 0 },
    },
    inputs: ["paths"],
    outputs: ["written"],
    nodes: [
      { id: n("start"), type: "function", reads: ["paths"], function: { ref: "function/passthrough@stable" } },
      {
        id: n("summarize"),
        type: "agent",
        reads: ["path"],
        writes: ["digests", "costUsd"],
        agent: {
          profile: "agent_profile/summarizer@stable",
          prompt: "prompt/summarize-file@stable",
          maxTurns: 3,
          tools: ["fs.read"],
          outputSchema: {
            type: "object",
            properties: { path: { type: "string" }, summary: { type: "string" } },
            required: ["path", "summary"],
          },
        },
        policy: { budget: { costUsd: 0.15 } },
        timeoutMs: 60_000,
      },
      {
        id: n("collect"),
        type: "join",
        reads: ["digests"],
        writes: ["digests"],
        join: { branches: [n("summarize")], mode: "all", onBranchError: "skip", timeoutMs: 90_000 },
      },
      {
        id: n("merge"),
        type: "function",
        reads: ["digests"],
        writes: ["merged"],
        function: { ref: "function/merge-digests@stable" },
      },
      {
        id: n("approve"),
        type: "human_gate",
        reads: ["merged"],
        writes: ["merged"],
        humanGate: { ref: "oversight/demo-write@stable" },
        checkpoint: "before",
      },
      {
        id: n("write"),
        type: "tool",
        reads: ["merged"],
        writes: ["written"],
        tool: { name: "fs.write", version: "1.0", args: { path: "out/summary.md", body: "${merged.markdown}" } },
        retry: { maxAttempts: 1 },
        checkpoint: "both",
      },
    ],
    edges: [
      { id: e("e0"), from: n("start"), to: n("summarize"), kind: "fanout", over: "paths", as: "path", maxWidth: 5 },
      { id: e("e1"), from: n("summarize"), to: n("collect"), kind: "join", branches: [n("summarize")] },
      { id: e("e2"), from: n("collect"), to: n("merge"), kind: "seq" },
      { id: e("e3"), from: n("merge"), to: n("approve"), kind: "seq" },
      { id: e("e4"), from: n("approve"), to: n("write"), kind: "seq" },
    ],
    ...over,
  };
}

export const SKELETON_TOOLS: Record<string, ToolManifestLite> = {
  "fs.read": {
    name: "fs.read",
    version: "1.0",
    capabilities: ["fs:read"],
    irreversibility: "read_only",
    idempotent: true,
  },
  "fs.write": {
    name: "fs.write",
    version: "1.0",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: true,
    compensation: { tool: "fs.restore" },
  },
};

export function resolver(): ResourceResolver {
  return {
    resolve(ref) {
      if (!/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)) return undefined;
      return { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" };
    },
    // ONE DOCUMENT FOR EVERY PIN, because the digest above is constant and a fixture does not
    // need per-ref fidelity — it needs an agent node to receive WORDS rather than a pointer,
    // which is the property `#documentFor` refuses without. Only prompt and rubric refs ever
    // reach here; `function` and `subgraph` pins go through their own hooks.
    document: () => "Test instructions.",
  };
}

export function compileSkeleton(spec: GraphSpec = skeletonSpec()): RunGraph {
  return compileOrThrow({
    spec,
    resolver: resolver(),
    tools: SKELETON_TOOLS,
    tenantCapabilities: SKELETON_TENANT_CAPS,
  });
}

// ---------------------------------------------------------------------------
// A wired engine
// ---------------------------------------------------------------------------

export interface Harness {
  readonly engine: Engine;
  readonly store: StateStore;
  readonly bus: InProcessEventBus;
  readonly model: MockModelAdapter;
  /** Exposed so a replay can be given the same registries the live run had. */
  readonly tools: ToolRegistry;
  readonly functions: FunctionRegistry;
  readonly writes: { path: string; body: string }[];
  readonly reads: string[];
  /** Advance the injected clock; nothing in the engine reads the wall clock. */
  tick(ms: number): void;
}

export interface HarnessOptions {
  readonly store?: StateStore;
  readonly script?: MockScript;
  /** Make one branch fail, by index, to exercise partial fan-out failure. */
  readonly failBranch?: number;
  readonly writeThrows?: boolean;
  readonly systemFloor?: "out" | "on" | "in";
  readonly budgetUsd?: number;
  readonly maxParallelism?: number;
}

/** Default script: read the file, then answer with a JSON digest. */
export function defaultScript(opts: { failBranch?: number } = {}): MockScript {
  return (req, turn) => {
    const user = req.messages[0]?.content ?? "{}";
    const parsed = JSON.parse(user) as { state?: { path?: string } };
    const path = parsed.state?.path ?? "unknown";

    if (opts.failBranch !== undefined && path === `doc-${opts.failBranch}.md`) {
      // Malformed output: fails the node's outputSchema rather than throwing, which
      // is the realistic failure shape for a model.
      return { text: "I could not read that file.", finishReason: "stop" };
    }
    if (turn % 2 === 0) {
      return { toolCalls: [{ id: `c${turn}`, name: "fs.read", arguments: { path } }], finishReason: "tool_use" };
    }
    return { text: JSON.stringify({ path, summary: `summary of ${path}` }), finishReason: "stop" };
  };
}

export function harness(opts: HarnessOptions = {}): Harness {
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;

  const store = opts.store ?? new MemoryStateStore({ now });
  const bus = new InProcessEventBus({ store });
  const tools = new ToolRegistry();
  const functions = new FunctionRegistry();
  const models = new ModelRegistry();

  const reads: string[] = [];
  const writes: { path: string; body: string }[] = [];

  const fsRead: ToolDefinition = {
    ...SKELETON_TOOLS["fs.read"]!,
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: (args) => {
      reads.push(String(args["path"]));
      return { content: `contents of ${String(args["path"])}` };
    },
  };
  const fsWrite: ToolDefinition = {
    ...SKELETON_TOOLS["fs.write"]!,
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, body: { type: "string" } },
      required: ["path", "body"],
    },
    execute: (args) => {
      if (opts.writeThrows === true) throw new Error("disk on fire");
      const rec = { path: String(args["path"]), body: String(args["body"]) };
      writes.push(rec);
      return { content: `wrote ${rec.path}`, writes: { written: rec } };
    },
  };
  tools.register(fsRead);
  tools.register(fsWrite);

  functions.register("function/passthrough@stable", () => ({}));
  functions.register("function/merge-digests@stable", (view) => {
    const digests = (view.get<{ path: string; summary: string }[]>("digests") ?? []).slice();
    return {
      writes: {
        merged: {
          count: digests.length,
          markdown: digests.map((d) => `## ${d.path}\n${d.summary}`).join("\n\n"),
        },
      },
    };
  });

  const model = new MockModelAdapter({
    script: opts.script ?? defaultScript(opts.failBranch === undefined ? {} : { failBranch: opts.failBranch }),
    pricePerMTok: 1,
  });
  models.register(model, true);

  const engine = new Engine({
    store,
    bus,
    tools,
    functions,
    models,
    now,
    maxParallelism: opts.maxParallelism ?? 16,
    policy: {
      granted: ["fs:read", "fs:write"],
      ...(opts.systemFloor === undefined ? {} : { systemFloor: opts.systemFloor }),
      budget: { runUsd: opts.budgetUsd ?? 1.0 },
    },
  });

  return {
    engine,
    store,
    bus,
    model,
    tools,
    functions,
    writes,
    reads,
    tick: (ms) => {
      clock.t += ms;
    },
  };
}

export const DOCS = ["doc-0.md", "doc-1.md", "doc-2.md", "doc-3.md", "doc-4.md"];
