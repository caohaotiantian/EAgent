/**
 * The data floor is computed once, and both readers get the same answer.
 *
 * It was computed twice — six identical lines a single word apart. `compile.ts` used
 * `observedChannels(n)`, which includes channels a node reaches through a `${template}`;
 * `validate.ts` used `n.reads`, which does not. So for a node whose only path to a classified
 * channel is a tool-argument template, the VALIDATOR reasoned about a lower floor than the
 * EXECUTOR enforces.
 *
 * The visible cost is a diagnostic that goes quiet exactly when it is most useful. An author who
 * writes `policy: { posture: "on" }` beside a templated `secret_ref` read is running at `in`
 * whatever they wrote, and `GRAPH019_POSTURE_NO_EFFECT` exists to tell them so. Measured against
 * the old copy: plan posture `in`, diagnostics empty. The declaration was overridden in silence.
 *
 * This is the bypass `observedChannels` was written for, arriving one function later — which is
 * the argument for a shared helper over two correct-looking copies. `reads` is not the read set,
 * and every place that treats it as one has to be found again.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import type { NodeId } from "../../src/ids.ts";
import { resolver } from "../run/skeleton.ts";

/** `n` declares `reads: ["plain"]`; its tool ARGUMENTS name `secret`. That is the whole case. */
const templated = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "data-floor", project: "test", version: 1 },
  policy: { posture: "out", budget: { costUsd: 1 }, capabilities: ["wire:send"] },
  channels: {
    plain: { type: "string", reduce: "replace" },
    secret: { type: "string", reduce: "replace", classification: "secret_ref" },
    out: { type: "object", reduce: "replace" },
  },
  inputs: ["plain", "secret"],
  outputs: ["out"],
  nodes: [
    {
      id: "n",
      type: "tool",
      reads: ["plain"],
      writes: ["out"],
      // The author believes this means something. It does not, and nothing told them.
      policy: { posture: "on" },
      tool: { name: "wire.send", version: "1.0", args: { body: "${secret}" } },
    },
  ],
  edges: [],
} as never;

// READ-ONLY on purpose. An irreversible tool floors the node at `in` through `classFloor`, which
// swamps the data floor and makes the drift invisible — the first version of this test proved
// nothing for exactly that reason.
const build = () =>
  compile({
    spec: templated,
    resolver: resolver(),
    tools: { "wire.send": { irreversibility: "read_only", capabilities: ["wire:send"] } } as never,
    tenantCapabilities: ["wire:send"],
  });

test("A TEMPLATED READ RAISES THE FLOOR, and the compiler enforces it", () => {
  const r = build();
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(
    r.ok && r.graph.plans["n" as NodeId]?.posture,
    "in",
    "a `secret_ref` reached through a template must still floor the node",
  );
});

test("AND THE AUTHOR IS TOLD their declaration cannot change it", () => {
  // The half that was broken. The executor already ran this node at `in`; the validator computed
  // its floor from `reads` alone, saw `out`, concluded that `posture: "on"` was meaningful, and
  // stayed silent. Both now read the same helper, so the warning fires.
  const r = build();
  const codes = r.diagnostics.map((d) => d.code);
  assert.ok(
    codes.includes("GRAPH019_POSTURE_NO_EFFECT"),
    `expected the inert declaration to be reported; got: ${codes.join(", ") || "(no diagnostics)"}`,
  );
});

test("a node with NO classified channel keeps its declaration — the warning is not universal", () => {
  // The control. A guard that fires on every node says nothing about any of them, and this one
  // reports "your declaration does nothing", which is a claim that has to be false somewhere.
  const plainOnly = JSON.parse(JSON.stringify(templated)) as {
    nodes: { policy: { posture: string }; tool: { args: { body: string } } }[];
  };
  plainOnly.nodes[0]!.tool.args.body = "${plain}";

  const r = compile({
    spec: plainOnly as never,
    resolver: resolver(),
    tools: { "wire.send": { irreversibility: "read_only", capabilities: ["wire:send"] } } as never,
    tenantCapabilities: ["wire:send"],
  });

  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.ok && r.graph.plans["n" as NodeId]?.posture, "on", "the declaration is what decides here");
  assert.deepEqual(
    r.diagnostics.map((d) => d.code).filter((c) => c === "GRAPH019_POSTURE_NO_EFFECT"),
    [],
    "a declaration that DOES change the result must not be reported as inert",
  );
});
