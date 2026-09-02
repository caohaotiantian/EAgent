/**
 * THE DEFAULT-DEADLINE DOCSTRING NAMES ITS MEMBERS, AND THE MEMBERS ARE THE ONES THE COMPILER USES.
 *
 * This exists because the same sentence was wrong three times. `effectiveTimeout` started with a
 * set of three, `function` was added to the code, and the prose was corrected TWICE — each time
 * where a reader looks first, at the headline and at the "why the other N do not" line — while
 * "only these three can", sitting mid-sentence directly above four bullets, survived both passes.
 * Backlog row H.3 was opened for the survivor, and the row itself then undercounted its own
 * survivors: it named one and `/usr/bin/grep -anE 'THREE|three' packages/core/src/graph/compile.ts`
 * returned two.
 *
 * SO THE RULE IS "NAME, NEVER COUNT", and this is the mechanism that keeps it. A count is a
 * second statement of a fact the enumeration beside it already carries, and nothing links the
 * two — so the count can rot while the bullets stay right, which is precisely how a docstring
 * ends up contradicting the four bullets underneath it. A name cannot drift that way: it is
 * either in the set the compiler applies or it is not, and this file checks exactly that.
 *
 * THREE THINGS ARE PINNED, and the third is the one that would have caught H.3:
 *
 *   1. The bullets under "THE SET IS" are the node types that really receive
 *      `DEFAULT_NODE_TIMEOUT_MS`, measured by compiling rather than by reading.
 *   2. The bullets under "GET NONE" are the ones that really receive nothing, and the two halves
 *      together cover every member of `NodeType` — read out of `graph/spec.ts` itself, so a ninth
 *      node type fails here instead of quietly landing on neither side.
 *   3. No sentence in the region refers to either set by a count. Quoted text is exempt, because
 *      the docstring quotes its own broken phrasing as the reason the rule exists.
 *
 * NOT A GENERAL PROSE GATE. It reads one region of one file — the `DEFAULT_NODE_TIMEOUT_MS` and
 * `effectiveTimeout` docstrings — and it was written after the defect recurred, not in advance.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, NodeType } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { TENANT_CAPABILITIES, TOOLS, incidentTriage, stubResolver } from "./fixtures.ts";

const SRC = new URL("../../src/graph/compile.ts", import.meta.url);
const SPEC_SRC = new URL("../../src/graph/spec.ts", import.meta.url);

/** Every member of `NodeType`, read from the union itself so a ninth one cannot slip past. */
function declaredNodeTypes(): readonly NodeType[] {
  const src = readFileSync(SPEC_SRC, "utf8");
  const union = /export type NodeType =([^;]*);/.exec(src);
  assert.ok(union !== null, "graph/spec.ts no longer declares `export type NodeType = …`");
  const types = [...union[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as NodeType);
  assert.ok(types.length >= 8, `only ${types.length} node types parsed out of the union`);
  return types;
}

/**
 * `incidentTriage()` carries seven of the eight types; only `subgraph` is missing, so one extra
 * two-node graph completes the census. Every author-declared `timeoutMs` is stripped first —
 * what is left on the plan is the DEFAULT and nothing else.
 */
function measuredDefaults(): ReadonlyMap<NodeType, number | undefined> {
  const child: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "child", project: "test", version: 1 },
    policy: { posture: "out", capabilities: [], expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 1, maxLoopIterations: 1 } },
    channels: { inp: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
    inputs: ["inp"],
    outputs: ["out"],
    nodes: [
      { id: "f" as NodeId, type: "function", reads: ["inp"], writes: ["out"], function: { ref: "function/id@stable" }, unhandled: true },
    ],
    edges: [],
  };
  const parent: GraphSpec = {
    ...child,
    metadata: { name: "parent", project: "test", version: 1 },
    nodes: [
      {
        id: "delegate" as NodeId,
        type: "subgraph",
        reads: ["inp"],
        writes: ["out"],
        subgraph: { ref: "subgraph/child@stable", inputs: { inp: "inp" }, outputs: { out: "out" } },
        unhandled: true,
      },
    ],
  };

  const out = new Map<NodeType, number | undefined>();
  const cases: readonly (readonly [GraphSpec, ReturnType<typeof stubResolver>])[] = [
    [incidentTriage(), stubResolver()],
    [parent, stubResolver({ subgraphs: { "subgraph/child@stable": child } })],
  ];
  for (const [spec, resolver] of cases) {
    const stripped: GraphSpec = {
      ...spec,
      nodes: spec.nodes.map((n) => {
        const copy: Record<string, unknown> = { ...n };
        delete copy["timeoutMs"];
        return copy as unknown as (typeof spec.nodes)[number];
      }),
    };
    const g = compileOrThrow({ spec: stripped, resolver, tools: TOOLS, tenantCapabilities: TENANT_CAPABILITIES });
    for (const n of stripped.nodes) if (!out.has(n.type)) out.set(n.type, g.plans[n.id]?.timeoutMs);
  }
  return out;
}

/** The two docstrings this rule covers, as one slice of source text. */
function region(): string {
  const src = readFileSync(SRC, "utf8");
  const start = src.indexOf(" * The deadline a node gets when its author declared none");
  const end = src.indexOf("export type CompileInput");
  assert.ok(start > 0 && end > start, "the DEFAULT_NODE_TIMEOUT_MS / effectiveTimeout region moved");
  return src.slice(start, end);
}

/** The node type each `- \`name\` —` bullet is about, in order. */
function bulletNames(text: string): readonly string[] {
  return [...text.matchAll(/^\s*\*\s+- `([a-z_]+)` —/gm)].map((m) => m[1]!);
}

test("THE DOCSTRING'S TWO ENUMERATIONS ARE THE SETS THE COMPILER ACTUALLY APPLIES", () => {
  const measured = measuredDefaults();
  const declared = declaredNodeTypes();
  for (const t of declared) {
    assert.ok(measured.has(t), `node type "${t}" was never compiled here, so its side is unmeasured`);
  }

  const withDefault = declared.filter((t) => measured.get(t) !== undefined).sort();
  const without = declared.filter((t) => measured.get(t) === undefined).sort();
  // Measured 2026-09-02 by compiling: agent, evaluator, function, tool get 600_000; the rest none.
  assert.deepEqual(withDefault, ["agent", "evaluator", "function", "tool"]);
  assert.deepEqual(without, ["human_gate", "join", "router", "subgraph"]);

  const text = region();
  const split = text.indexOf("GET NONE");
  assert.ok(split > 0, 'the "GET NONE" heading moved; the docstring has two halves and this finds them');

  assert.deepEqual(
    [...bulletNames(text.slice(0, split))].sort(),
    withDefault,
    "the bullets under `THE SET IS` must be exactly the types the compiler gives a default deadline",
  );
  assert.deepEqual(
    [...bulletNames(text.slice(split))].sort(),
    without,
    "the bullets under `GET NONE` must be exactly the types the compiler gives none",
  );
});

test("AND NEITHER SET IS REFERRED TO BY A COUNT — the failure mode H.3 was opened for", () => {
  // Quoted spans are exempt: the docstring quotes "only these three can" as the phrasing that
  // survived two corrections, and that quotation is the reason the rule is written down.
  const prose = region().replace(/"[^"]*"/g, '""');

  // `two`…`eight` is the range a claim about the eight node types can land in. A larger number
  // here is about something else — "the ten no-fork extension points", say — and is deliberately
  // not matched. `one` is out for a different reason, measured rather than assumed: it fired on
  // "IT IS AN OUTER BOUND, not the only one", where the word is a pronoun and not a count, and a
  // set of one is not a shape this docstring can take.
  const counted = [...prose.matchAll(/\b(all|these|those|the|other|only)\s+(two|three|four|five|six|seven|eight)\b/gi)];
  assert.deepEqual(
    counted.map((m) => m[0]),
    [],
    "name the members instead: a count is a second statement of what the bullets beside it already say, " +
      "and it is the half that rots — this exact sentence shipped wrong through two corrections",
  );

  // AND THE HEADLINE NAMES THEM, which is what its count used to stand in for. This is the
  // sentence that read "ONE NUMBER FOR ALL THREE TYPES" over a four-arm function.
  const headline = /ONE NUMBER FOR[\s\S]*?deliberately/.exec(region());
  assert.ok(headline !== null, "DEFAULT_NODE_TIMEOUT_MS's `ONE NUMBER FOR …, deliberately` headline moved");
  for (const t of ["agent", "tool", "evaluator", "function"]) {
    assert.ok(headline[0].includes("`" + t + "`"), `that headline must name \`${t}\`, not count it — got: ${headline[0]}`);
  }
});
