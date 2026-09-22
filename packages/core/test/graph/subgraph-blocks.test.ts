/**
 * EVERY REQUIRED SUB-BLOCK `rule016Subgraphs` READS, one case each — §A.79.
 *
 * The row was one crash: `Object.entries(sub.inputs)` with nothing above it establishing that
 * `inputs` is present. Its closing condition is the reason this file enumerates rather than
 * pinning that one value — *"a single `?? {}` here closes one input and leaves its siblings"* —
 * so the question is asked of every block the rule reads, and each answer is measured rather
 * than assumed.
 *
 * WHAT THE RULE READS, and which reporter owns each. This list IS the claim, and a block added to
 * `rule016Subgraphs` that is not here is the way this suite goes stale:
 *
 *     n.subgraph      the node's type block          `checkStructure`, GRAPH003_MALFORMED
 *     sub.ref         REQUIRED_FIELDS                `checkStructure`, GRAPH020_MISSING_FIELD
 *     sub.inputs      the parent's own declaration   `requiredMapping`, GRAPH003_MALFORMED
 *     sub.outputs     the parent's own declaration   `requiredMapping`, GRAPH003_MALFORMED
 *     spec.channels   the parent's channels          `checkStructure`, fatal before this rule
 *     child.channels  the resolved child's           the CHILD's own `checkStructure`, through
 *                                                    the recursion, re-tagged `in subgraph "…"`
 *     child itself    the resolved child             the same, plus `namesUnder`'s skip
 *
 * THE LAST TWO ARE NOT REPORTED HERE ON PURPOSE. A child fault has a reporter already — the
 * recursion runs the whole of `validateGraph` on the child — and a second spelling of one refusal
 * is how two diagnostics come to disagree. What this rule owes is not to CRASH before that
 * reporter gets there, which is what the two cases below measure.
 *
 * NOT ONE `?? {}`. Every case here is a DIAGNOSTIC NAMING THE NODE, because the alternative that
 * closes the crash — defaulting an absent mapping to the empty object — is the quiet half of the
 * same defect: `inputs: 42` already compiled with ZERO diagnostics and the mapping silently
 * dropped, and `SubgraphNode.inputs` is not optional in the type. `run/engine.ts`'s `#contextFor`
 * walks `sub.inputs` with the same `Object.entries`, so an absent one is a crash at run time.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import type { Diagnostic } from "../../src/graph/validate.ts";
import type { GraphSpec, NodeSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { TOOLS, stubResolver } from "./fixtures.ts";

const graph = (name: string, nodes: readonly unknown[]): GraphSpec =>
  ({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name, project: "test", version: 1 },
    policy: {
      posture: "out",
      capabilities: ["k8s:write"],
      expansion: { maxNodes: 16, maxDepth: 3, maxFanout: 2, maxLoopIterations: 1 },
    },
    channels: { inp: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["inp"],
    outputs: ["out"],
    nodes,
    edges: [],
  }) as unknown as GraphSpec;

const toolNode = (id: string): NodeSpec =>
  ({
    id: id as NodeId,
    type: "tool",
    reads: ["inp"],
    writes: ["out"],
    tool: { name: "k8s.apply", version: "3.0", args: {} },
    unhandled: true,
  }) as NodeSpec;

const CHILD = graph("child", [toolNode("a")]);
const FULL = { ref: "subgraph/child@stable", inputs: { inp: "inp" }, outputs: { out: "out" } };

const parentWith = (sub: unknown): GraphSpec =>
  graph("parent", [
    { id: "delegate", type: "subgraph", reads: ["inp"], writes: ["out"], subgraph: sub, unhandled: true },
  ]);

/** `compile`, never `compileOrThrow`: what is under test is that a THROW became a DIAGNOSTIC. */
function diagnose(parent: GraphSpec, child: unknown = CHILD): { ok: boolean; errors: readonly Diagnostic[] } {
  const r = compile({
    spec: parent,
    resolver: stubResolver({ subgraphs: { "subgraph/child@stable": child as GraphSpec } }),
    tools: TOOLS,
    tenantCapabilities: ["k8s:write"],
  });
  return { ok: r.ok, errors: r.diagnostics.filter((x) => x.severity === "error") };
}

test("THE BASELINE COMPILES — so every case below differs by exactly one block", () => {
  const r = diagnose(parentWith(FULL));
  assert.equal(r.ok, true, r.errors.map((x) => `${x.code}: ${x.message}`).join("\n"));
});

test("`inputs` AND `outputs`: ABSENT, NULL, AND EVERY OTHER NON-OBJECT IS ONE DIAGNOSTIC NAMING THE NODE", () => {
  // Before §A.79 the first four THREW `TypeError: Cannot convert undefined or null to object` out
  // of `compile`, and the last three were worse than a crash: `42` compiled with zero diagnostics
  // and the mapping silently dropped, while `"inp"` produced SIX GRAPH016_BAD_MAPPINGs about
  // child channels "0", "1" and "2" — a diagnostic about the indices of the author's string.
  const values: readonly (readonly [string, unknown])[] = [
    ["absent", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "inp"],
    ["an array", ["inp"]],
    ["a boolean", true],
  ];
  for (const field of ["inputs", "outputs"] as const) {
    for (const [label, value] of values) {
      const sub: Record<string, unknown> = { ...FULL };
      if (value === undefined) delete sub[field];
      else sub[field] = value;
      const r = diagnose(parentWith(sub));
      assert.equal(r.ok, false, `${field} ${label} must not compile`);
      const hit = r.errors.find((x) => x.code === "GRAPH003_MALFORMED" && x.message.includes(`\`${field}\``));
      assert.ok(hit !== undefined, `${field} ${label}: got ${r.errors.map((x) => x.code).join(", ") || "(none)"}`);
      // NAMING THE NODE is the row's own words, and it is checked on the coordinate as well as in
      // the prose: a diagnostic an editor can place is what makes a graph of 40 nodes fixable.
      // ABSENT AND WRONG-SHAPED SAY DIFFERENT THINGS, because they are one mistake to fix and two
      // different things to report. `describeValue(undefined)` is the word "undefined", so the
      // absent case used to read `declares \`inputs\` as undefined` — telling an author they wrote
      // something they did not write.
      assert.match(
        hit.message,
        value === undefined
          ? /^subgraph "delegate" does not declare `(inputs|outputs)`/
          : /^subgraph "delegate" declares `(inputs|outputs)` as /,
        hit.message,
      );
      assert.deepEqual(hit.at, { nodeId: "delegate" as NodeId }, hit.message);
      // AND THE DIRECTION OF THE ARROW, because `inputs` and `outputs` run OPPOSITE ways and a
      // message that says only "must be an object" leaves an author to guess which key is which.
      assert.match(
        hit.message,
        field === "inputs" ? /maps child channel to parent channel/ : /maps parent channel to child channel/,
        hit.message,
      );
      assert.ok(hit.fix !== undefined && hit.fix.includes(`${field}: {}`), `${field} ${label}: ${String(hit.fix)}`);
    }
  }
});

test("EXACTLY ONE REFUSAL PER BAD MAPPING — the crash is not traded for a pile", () => {
  // `inputs: "inp"` used to produce six. A fix an author has to read six times to find once is
  // the failure mode this file's own `objectBlock` docstring names: an eighth spelling of one
  // idea is how diagnostics come to disagree about what they mean.
  const r = diagnose(parentWith({ ...FULL, inputs: "inp" }));
  assert.equal(r.errors.length, 1, r.errors.map((x) => `${x.code}: ${x.message}`).join("\n"));
  assert.equal(r.errors.filter((x) => x.code === "GRAPH016_BAD_MAPPING").length, 0);
});

test("A MAPPING THAT IS AN OBJECT IS STILL CHECKED MEMBER BY MEMBER", () => {
  // The guard must not have swallowed the rule it guards. Both halves of both directions.
  const r = diagnose(parentWith({ ref: FULL.ref, inputs: { nope: "gone" }, outputs: { gone: "nope" } }));
  const msgs = r.errors.filter((x) => x.code === "GRAPH016_BAD_MAPPING").map((x) => x.message);
  assert.equal(msgs.length, 4, msgs.join("\n"));
  assert.ok(msgs.some((m) => m.includes('maps input "nope" from undeclared parent channel "gone"')), msgs.join("\n"));
  assert.ok(msgs.some((m) => m.includes('maps to child channel "nope"')), msgs.join("\n"));
  assert.ok(msgs.some((m) => m.includes('maps output to undeclared parent channel "gone"')), msgs.join("\n"));
  assert.ok(msgs.some((m) => m.includes('maps output from child channel "nope"')), msgs.join("\n"));
});

test("THE `subgraph` BLOCK ITSELF, and every other node type's — `<block>: null` crashed all eight", () => {
  // `typeof null === "object"` is why: `checkStructure` guarded its unknown-key check with
  // exactly that test, so `Object.keys(null)` threw. Measured before, one graph per type:
  // seven THREW `Cannot convert undefined or null to object`, and `function: null` threw
  // `Cannot read properties of null (reading 'effects')` from the `effects` shape rule above it.
  const blocks: readonly (readonly [string, string])[] = [
    ["tool", "tool"],
    ["function", "function"],
    ["agent", "agent"],
    ["join", "join"],
    ["router", "router"],
    ["evaluator", "evaluator"],
    ["human_gate", "humanGate"],
    ["subgraph", "subgraph"],
  ];
  for (const [type, holder] of blocks) {
    for (const bad of [null, 42, "x", true] as unknown[]) {
      const r = diagnose(
        graph("parent", [{ id: "n", type, reads: ["inp"], writes: ["out"], [holder]: bad, unhandled: true }]),
      );
      assert.equal(r.ok, false, `${type} ${holder}: ${JSON.stringify(bad)} must not compile`);
      const hit = r.errors.find((x) => x.code === "GRAPH003_MALFORMED");
      assert.ok(hit !== undefined, `${type} ${JSON.stringify(bad)}: got ${r.errors.map((x) => x.code).join(", ")}`);
      assert.match(hit.message, new RegExp(`^node "n"'s \`${holder}\` block must be an object`), hit.message);
      // AND NOTHING ELSE, because the block-shape refusal GATES the two checks that read inside
      // it. `subgraph: 42` used to report `` `ref` is missing `` — the `ref` is not missing from a
      // block that does not exist, and a correction that replaces a false claim with a
      // differently-false one is worse than the original.
      assert.equal(
        r.errors.filter((x) => x.code === "GRAPH020_MISSING_FIELD").length,
        0,
        r.errors.map((x) => `${x.code}: ${x.message}`).join("\n"),
      );
    }
  }
});

test("AN EMPTY BLOCK IS STILL `REQUIRED_FIELDS`' TO REPORT — the gate is on shape, not on presence", () => {
  const r = diagnose(parentWith({}));
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((x) => x.code === "GRAPH020_MISSING_FIELD" && x.message.includes("`ref` is missing")),
    r.errors.map((x) => `${x.code}: ${x.message}`).join("\n"),
  );
});

test("`sub.ref` IS `REQUIRED_FIELDS`' — measured, not assumed, because this rule reads it first", () => {
  // `expanding.includes(sub.ref)` and `resolver.subgraph(sub.ref)` both run before any mapping
  // is read, so a non-string `ref` reaching them is this rule's problem even though the refusal
  // is somebody else's. It is fatal, so the rule never runs.
  const r = diagnose(parentWith({ ...FULL, ref: 42 }));
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((x) => x.code === "GRAPH020_MISSING_FIELD" && x.message.includes("`ref` is not a string")),
    r.errors.map((x) => `${x.code}: ${x.message}`).join("\n"),
  );
});

test("A CHILD WHOSE `channels` IS NOT AN OBJECT IS THE CHILD'S OWN DIAGNOSTIC, re-tagged", () => {
  // `Object.hasOwn(child.channels, …)` threw on both. The child is a resolved RESOURCE — a file —
  // so this is the same "a file decides" as §A.79's own value, one hop further out.
  // `[]` IS IN THIS CENSUS AND WAS THE HOLE. `typeof [] === "object"` let an array past the
  // child's own `channels` check, and this rule's guard then read "not a plain object" as a reason
  // to SKIP its half of the mapping test — so the one reporter it deferred to was silent too and
  // a child with `channels: []` compiled without either diagnostic base printed.
  for (const channels of [undefined, null, [], 42, "x"] as unknown[]) {
    const child = { ...CHILD, channels } as unknown as GraphSpec;
    const r = diagnose(parentWith(FULL), child);
    assert.equal(r.ok, false, `channels ${String(channels)} must not compile`);
    const hit = r.errors.find((x) => x.code === "GRAPH003_MALFORMED");
    assert.ok(hit !== undefined, r.errors.map((x) => x.code).join(", "));
    assert.equal(hit.message, 'in subgraph "subgraph/child@stable": `channels` must be an object');
    assert.deepEqual(hit.at, { nodeId: "delegate" as NodeId });
    // AND THE PARENT'S OWN HALF, which is the "refuse, never skip" direction. A child whose
    // `channels` is not a channel map declares no channel of any name, so every mapping into it
    // really does name something the child does not declare — and the rule says so instead of
    // deferring to a reporter that might be silent. Base printed these for `[]`; head did not.
    const mapping = r.errors.filter((x) => x.code === "GRAPH016_BAD_MAPPING").map((x) => x.message);
    assert.equal(mapping.length, 2, `channels ${String(channels)}: ${r.errors.map((x) => x.code).join(", ")}`);
    assert.ok(mapping.some((m) => m.includes('maps to child channel "inp"')), mapping.join(" | "));
    assert.ok(mapping.some((m) => m.includes('maps output from child channel "out"')), mapping.join(" | "));
  }
});

test("A CHILD THAT IS NOT A GRAPH AT ALL IS A DIAGNOSTIC — `namesUnder` used to get there first", () => {
  // The tool-reach walk runs in `rule014And019Oversight`, BEFORE this rule, and read `spec.nodes`
  // straight: `42`, `{}`, `"x"` and `[]` all threw `spec.nodes is not iterable` and `null` threw
  // `Cannot read properties of null (reading 'nodes')`. It now contributes nothing for such a
  // child, exactly as it already did for an unresolvable ref, and the refusal comes from the
  // child's own `checkStructure` through the recursion.
  for (const child of [42, null, {}, "x", []] as unknown[]) {
    const r = diagnose(parentWith(FULL), child);
    assert.equal(r.ok, false, `child ${JSON.stringify(child)} must not compile`);
    const hit = r.errors.find((x) => x.code === "GRAPH003_MALFORMED");
    assert.ok(hit !== undefined, `${JSON.stringify(child)}: got ${r.errors.map((x) => x.code).join(", ")}`);
    assert.match(hit.message, /^in subgraph "subgraph\/child@stable": /, hit.message);
    assert.deepEqual(hit.at, { nodeId: "delegate" as NodeId });
  }
});

test("THE PARENT'S OWN `channels` CANNOT REACH THIS RULE MALFORMED — `checkStructure` is fatal first", () => {
  // The sixth row of the table at the top of this file. `Object.hasOwn(spec.channels, …)` is read
  // unguarded here, and it is safe for a REASON rather than by luck, so the reason is pinned.
  const parent = parentWith(FULL) as unknown as Record<string, unknown>;
  const r = diagnose({ ...parent, channels: null } as unknown as GraphSpec);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((x) => x.code === "GRAPH003_MALFORMED" && x.message === "`channels` must be an object"),
    r.errors.map((x) => `${x.code}: ${x.message}`).join("\n"),
  );
  // Fatal means the subgraph rule never ran, so no GRAPH016 came out of a spec with no channels.
  assert.equal(r.errors.filter((x) => x.code.startsWith("GRAPH016")).length, 0);
});
