/**
 * Compensation vocabulary must mean what it says, or not be offered.
 *
 * Loom has a compensation TYPE SYSTEM and no compensation RUNTIME: `compensation` is a
 * first-class `EdgeKind`, GRAPH012 gates on it, and `Engine.rewind` refuses to cross an
 * uncompensated irreversible effect. Nothing executes one. Two consequences were
 * reachable from a graph, and both are refused here:
 *
 *  - `onBranchError: "compensate"` was accepted and treated as an exact synonym for
 *    `"skip"`, so a graph could ask for a rollback and silently get a discard;
 *  - a declared compensation's only runtime effect is to REMOVE the rewind refusal, so
 *    naming a tool that does not exist bought a legal rewind that undoes nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { validateGraph } from "../../src/graph/validate.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { resolver } from "../run/skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

const TOOLS: Record<string, ToolManifestLite> = {
  "k8s.restart": {
    name: "k8s.restart",
    version: "1.0",
    capabilities: ["k8s:write"],
    irreversibility: "irreversible",
    idempotent: false,
    compensation: { tool: "k8s.rollback" },
  },
  "k8s.rollback": {
    name: "k8s.rollback",
    version: "1.0",
    capabilities: ["k8s:write"],
    irreversibility: "reversible_write",
    idempotent: true,
  },
  "pay.refund": {
    name: "pay.refund",
    version: "1.0",
    capabilities: ["pay:write"],
    irreversibility: "externally_visible",
    idempotent: false,
  },
};

function codes(spec: GraphSpec, tools: Record<string, ToolManifestLite> = TOOLS): string[] {
  return validateGraph({ spec, resolver: resolver(), tools, tenantCapabilities: ["k8s:write", "pay:write"] }).map(
    (d) => d.code,
  );
}

/** A fan-out into one worker, joined — the smallest graph with an `onBranchError`. */
function joinSpec(onBranchError: "fail" | "skip" | "compensate"): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "compensate-arm", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      item: { type: "object", reduce: "replace" },
      out: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["items"],
    outputs: ["out"],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: n("work"), type: "function", reads: ["item"], writes: ["out"], function: { ref: "function/work@stable" } },
      {
        id: n("gather"),
        type: "join",
        reads: ["out"],
        writes: ["out"],
        join: { branches: [n("work")], mode: "all", onBranchError, timeoutMs: 60_000 },
      },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("work"), kind: "fanout", over: "items", maxWidth: 4 },
      { id: e("jn"), from: n("work"), to: n("gather"), kind: "join" },
    ],
  } as unknown as GraphSpec;
}

test('onBranchError: "compensate" is refused, not silently treated as "skip"', () => {
  assert.ok(
    codes(joinSpec("compensate")).includes("GRAPH008_COMPENSATE_UNIMPLEMENTED"),
    "a graph asking for a rollback that cannot happen must not compile",
  );
});

test('"skip" and "fail" still compile — only the word with no runtime is refused', () => {
  for (const mode of ["skip", "fail"] as const) {
    assert.equal(
      codes(joinSpec(mode)).includes("GRAPH008_COMPENSATE_UNIMPLEMENTED"),
      false,
      `onBranchError: "${mode}" is implemented and must remain legal`,
    );
  }
});

/** A tool node with a compensation edge back to its rollback node. */
function compSpec(compensationTool: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "compensation-edge", project: "probe", version: 1 },
    policy: { capabilities: ["k8s:write", "pay:write"], expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { out: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["out"],
    nodes: [
      {
        id: n("restart"),
        type: "tool",
        writes: ["out"],
        tool: { name: "k8s.restart", args: {} },
        unhandled: true,
      },
      { id: n("rollback"), type: "tool", tool: { name: compensationTool, args: {} }, unhandled: true },
    ],
    edges: [{ id: e("comp"), from: n("restart"), to: n("rollback"), kind: "compensation", compensates: n("restart") }],
  } as unknown as GraphSpec;
}

test("a compensation naming a tool that does not exist is refused", () => {
  const tools: Record<string, ToolManifestLite> = {
    ...TOOLS,
    "k8s.restart": { ...TOOLS["k8s.restart"]!, compensation: { tool: "k8s.rollback.typo" } },
    "k8s.rollback.typo": {
      name: "k8s.rollback.typo",
      version: "1.0",
      capabilities: [],
      irreversibility: "read_only",
      idempotent: true,
    },
  };
  // The compensation names a REGISTERED tool here, so this must pass...
  assert.equal(
    codes(compSpec("k8s.rollback.typo"), tools).includes("GRAPH012_COMPENSATION_UNKNOWN"),
    false,
    "a registered compensation tool is legal",
  );

  // ...and an unregistered one must not. Presence of the field was the whole check
  // before, so `{tool: "noop"}` bought a legal rewind that undid nothing.
  const ghost: Record<string, ToolManifestLite> = {
    ...TOOLS,
    "k8s.restart": { ...TOOLS["k8s.restart"]!, compensation: { tool: "nobody.registered.this" } },
  };
  assert.ok(
    codes(compSpec("k8s.rollback"), ghost).includes("GRAPH012_COMPENSATION_UNKNOWN"),
    "a compensation naming an unregistered tool must be refused",
  );
});

test("a compensation that is itself externally visible warns rather than passing silently", () => {
  const visible: Record<string, ToolManifestLite> = {
    ...TOOLS,
    "k8s.restart": { ...TOOLS["k8s.restart"]!, compensation: { tool: "pay.refund" } },
  };
  assert.ok(
    codes(compSpec("pay.refund"), visible).includes("GRAPH012_COMPENSATION_VISIBLE"),
    "undoing with a visible action is a second visible action, and a human should know",
  );
});
