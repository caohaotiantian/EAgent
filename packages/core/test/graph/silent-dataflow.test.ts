/**
 * Two dataflows the RUN acts on and the COMPILE said nothing about.
 *
 * Both are the same shape as the unknown-field family one file over — the graph the author reads
 * and the graph that executes differ — except that here nothing was discarded. The runtime is
 * correct in both cases and the author is simply not told, which is why both diagnostics are
 * WARNINGS and neither fails a compile. Making either an error would refuse graphs that run
 * correctly today, including this repository's own regression tests for the two run-time fixes.
 *
 *   `tool.args`  — `#runToolNode` resolves arguments against `scopeFor(...)`, the whole channel
 *     scope, so `args: {body: "${secret}"}` reaches a channel `reads` never mentions.
 *     `observedChannels` folds those roots into the oversight floor, `dataClassification`, taint,
 *     the gate payload and its binding, so nothing escapes a guard — but `reads` under-reports
 *     what the node reads to every human and tool that believes it, and that under-reporting is
 *     what made the two bypasses `observedChannels` was written for possible.
 *     GRAPH004 already refuses exactly this for an EXPRESSION, on a node's `when`/`until`/router
 *     case. It had never looked at the other way a node names a channel.
 *
 *   laundering   — `applySecretFlow` marks every channel a node writes as carrying a secret once
 *     the node observes a `pii` or `secret_ref` one, and `PolicyEngine` then holds a hard-to-undo
 *     reader at `in` under a human's de-escalation instead of letting it fall to `on`. So a
 *     graph's real oversight depends on a fact that appears nowhere in the graph:
 *     `plans[].posture` is computed from DECLARED classifications and shows `out` for the very
 *     node that will gate. `test/run/secret-flow.test.ts` drives the run half — one `function`
 *     node copying a `secret_ref` channel into an `internal` one, the sink dropping from `in` to
 *     `on`, and the tool receiving the plaintext before the fix. This file is the compile half.
 *
 * The last test is the coupling. `launderedChannels` derives "sensitive" from
 * `CLASSIFICATION_POSTURE_FLOOR`; `applySecretFlow` spells the two names out in `run/engine.ts`.
 * Those are two copies of one vocabulary, which is the drift `dataFloorOf` exists because of — so
 * the engine's source is read here and the test fails if they ever name different classifications.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compile } from "../../src/graph/compile.ts";
import type { NodeId } from "../../src/ids.ts";
import { CLASSIFICATION_POSTURE_FLOOR } from "../../src/vocab.ts";
import { resolver } from "../run/skeleton.ts";

const TOOLS = { "wire.send": { irreversibility: "read_only", capabilities: ["wire:send"] } } as never;

/** `n` is a tool node; `over` replaces its `reads`, its `tool` block, or the channel table. */
const build = (over: {
  reads?: readonly string[];
  writes?: readonly string[];
  args?: Record<string, unknown>;
  channels?: Record<string, unknown>;
  type?: string;
}) =>
  compile({
    spec: {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "silent-dataflow", project: "test", version: 1 },
      policy: { posture: "out", capabilities: ["wire:send"] },
      channels: over.channels ?? {
        plain: { type: "string", reduce: "replace" },
        secret: { type: "string", reduce: "replace", classification: "secret_ref" },
        out: { type: "object", reduce: "replace" },
      },
      inputs: ["plain", "secret"],
      outputs: ["out"],
      nodes: [
        {
          id: "n",
          type: over.type ?? "tool",
          reads: over.reads ?? ["plain"],
          writes: over.writes ?? ["out"],
          ...(over.type === "function"
            ? { function: { ref: "function/f@stable" } }
            : { tool: { name: "wire.send", version: "1.0", args: over.args ?? {} } }),
        },
      ],
      edges: [],
    } as never,
    resolver: resolver(),
    tools: TOOLS,
    tenantCapabilities: ["wire:send"],
  });

const find = (r: ReturnType<typeof compile>, code: string) => r.diagnostics.filter((d) => d.code === code);

// ── tool.args is a read set ──────────────────────────────────────────────────

test("A TOOL ARGUMENT NAMING AN UNDECLARED CHANNEL IS REPORTED", () => {
  // The graph from `data-floor.test.ts`: `reads: ["plain"]`, arguments say `${secret}`. Before
  // this diagnostic, `compile` returned `ok` with the GRAPH019 warning about the node's posture
  // and NOTHING about the read that caused it.
  const r = build({ reads: ["plain"], args: { body: "${secret}" } });
  const [diag, ...rest] = find(r, "GRAPH004_UNDECLARED_ARG_READ");
  assert.ok(diag !== undefined, r.diagnostics.map((d) => d.code).join(", ") || "(no diagnostics)");
  assert.deepEqual(rest, [], "one channel, one diagnostic");
  assert.match(diag.message, /secret/, "the message must name the channel the arguments reach");
  assert.equal(diag.at?.nodeId, "n");
  assert.equal(diag.at?.channel, "secret");
  assert.match(diag.fix ?? "", /reads/);
});

test("...AND IT DOES NOT FAIL THE COMPILE, because the runtime already handles it", () => {
  // The whole argument for `warning`. Every decision computed from the read set reads
  // `observedChannels`, so the node is planned at `in` — the posture the secret demands — and the
  // graph is not wrong, only under-declared. An error here would refuse the regression test that
  // pins that fix.
  const r = build({ reads: ["plain"], args: { body: "${secret}" } });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.ok && r.graph.plans["n" as NodeId]?.posture, "in", "the floor still rises — nothing escaped");
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === "error"), []);
});

test("A DECLARED ARGUMENT READ IS SILENT — the control", () => {
  // A guard that fires on every tool node says nothing about any of them.
  const r = build({ reads: ["plain", "secret"], args: { body: "${secret}", path: "literal" } });
  assert.deepEqual(find(r, "GRAPH004_UNDECLARED_ARG_READ"), [], "a correctly declared read was reported");
});

test("A CHANNEL THE NODE WRITES COUNTS AS DECLARED, exactly as it does for an expression", () => {
  // `reads ∪ writes`, the same set GRAPH004 uses for an edge condition, and for the same reason:
  // a node may name a channel it produces.
  const r = build({ reads: [], writes: ["out"], args: { body: "${out}" } });
  assert.deepEqual(find(r, "GRAPH004_UNDECLARED_ARG_READ"), []);
});

test("A ROOT THAT IS NOT A CHANNEL AT ALL GETS A DIFFERENT FIX, because the repair is different", () => {
  // `${typo}` resolves to nothing and the tool receives `undefined`. Telling that author to add
  // it to `reads` would be advice that does not work.
  const r = build({ reads: ["plain"], args: { body: "${typo}" } });
  const diag = find(r, "GRAPH004_UNDECLARED_ARG_READ")[0]!;
  assert.ok(diag !== undefined);
  assert.match(diag.fix ?? "", /not a declared channel/);
});

test("EVERY ROOT IS FOUND — nested, dotted, and more than one in a string", () => {
  // `observedChannels` walks arrays and objects and takes the root segment of `${a.b}`. This
  // check is only as complete as that walk, so it is exercised through the diagnostic.
  const r = build({
    reads: [],
    writes: [],
    channels: {
      plain: { type: "string", reduce: "replace" },
      secret: { type: "string", reduce: "replace" },
      out: { type: "object", reduce: "replace" },
    },
    args: { a: "${plain.field}", b: { c: ["${secret}"] }, d: "${plain} and ${out}" },
  });
  assert.deepEqual(
    find(r, "GRAPH004_UNDECLARED_ARG_READ")
      .map((x) => x.at?.channel)
      .sort(),
    ["out", "plain", "secret"],
  );
});

// ── the laundering hop ───────────────────────────────────────────────────────

const launder = (channels: Record<string, unknown>) =>
  build({ type: "function", reads: ["secret"], writes: ["out"], channels });

test("A NODE THAT READS A SECRET AND WRITES AN UNCLASSIFIED CHANNEL IS REPORTED", () => {
  const r = launder({
    secret: { type: "string", reduce: "replace", classification: "secret_ref" },
    out: { type: "object", reduce: "replace", classification: "internal" },
    plain: { type: "string", reduce: "replace" },
  });
  const [diag, ...rest] = find(r, "GRAPH014_SECRET_LAUNDERED");
  assert.ok(diag !== undefined, r.diagnostics.map((d) => d.code).join(", ") || "(no diagnostics)");
  assert.deepEqual(rest, [], "one written channel, one diagnostic");
  assert.equal(diag.severity, "warning");
  assert.equal(diag.at?.nodeId, "n");
  assert.equal(diag.at?.channel, "out", "the diagnostic points at the channel that will carry it");
  assert.equal(r.ok, true, "a laundering hop is a legitimate graph; the run TIGHTENS, it does not loosen");
});

test("`pii` LAUNDERS TOO — the rule is every classification with a floor above `out`", () => {
  const r = launder({
    secret: { type: "string", reduce: "replace", classification: "pii" },
    out: { type: "object", reduce: "replace" },
    plain: { type: "string", reduce: "replace" },
  });
  assert.equal(find(r, "GRAPH014_SECRET_LAUNDERED").length, 1);
});

test("A WRITE THAT SAYS IT HOLDS A SECRET IS SILENT — the control", () => {
  // The declaration is already in the graph the human reads, so there is nothing new to say. A
  // warning here would fire on every correctly-labelled secret pipeline in the system.
  const r = launder({
    secret: { type: "string", reduce: "replace", classification: "secret_ref" },
    out: { type: "object", reduce: "replace", classification: "secret_ref" },
    plain: { type: "string", reduce: "replace" },
  });
  assert.deepEqual(find(r, "GRAPH014_SECRET_LAUNDERED"), []);
});

test("AND SO IS A NODE THAT OBSERVES NOTHING SENSITIVE — `internal` is not a secret", () => {
  // Treating `internal` as sensitive would mark almost every channel and turn the rule into a
  // constant warning, which is the approval-fatigue failure `applySecretFlow` names in its own
  // docstring.
  const r = launder({
    secret: { type: "string", reduce: "replace", classification: "internal" },
    out: { type: "object", reduce: "replace" },
    plain: { type: "string", reduce: "replace" },
  });
  assert.deepEqual(find(r, "GRAPH014_SECRET_LAUNDERED"), []);
});

test("A TEMPLATED READ LAUNDERS, because the rule reads `observedChannels` and not `reads`", () => {
  // The bypass this whole family exists for, arriving one function later: drop the channel from
  // `reads`, leave `${secret}` in the arguments, and the run still marks the write.
  const r = build({
    reads: [],
    writes: ["out"],
    args: { body: "${secret}" },
    channels: {
      secret: { type: "string", reduce: "replace", classification: "secret_ref" },
      out: { type: "object", reduce: "replace" },
      plain: { type: "string", reduce: "replace" },
    },
  });
  assert.equal(find(r, "GRAPH014_SECRET_LAUNDERED").length, 1, "a template must not hide the hop");
});

test("THE COMPILER AND THE ENGINE AGREE ON WHAT `sensitive` MEANS", () => {
  // Two copies of one vocabulary: `launderedChannels` derives it from the floor table,
  // `applySecretFlow` writes the names out. `dataFloorOf` exists because that pair drifted once
  // already, so this reads the engine's source rather than trusting the two to stay together.
  const ENGINE_SRC = readFileSync(fileURLToPath(new URL("../../src/run/engine.ts", import.meta.url)), "utf8");
  const fn = /function applySecretFlow\([\s\S]*?\n\}/.exec(ENGINE_SRC);
  assert.ok(fn, "applySecretFlow moved or was renamed — this test reads it from the source");
  const named = [...fn[0].matchAll(/declared === "([a-z_]+)"/g)].map((m) => m[1]!).sort();

  const derived = Object.entries(CLASSIFICATION_POSTURE_FLOOR)
    .filter(([, floor]) => floor !== "out")
    .map(([cls]) => cls)
    .sort();

  assert.deepEqual(named, derived, "the engine's secret set and the compiler's have diverged");
  // Non-vacuous: both sides must be non-empty, or a regex that stopped matching would pass.
  assert.equal(derived.length, 2, "pii and secret_ref");
});
