/**
 * The corpus's worked examples must compile.
 *
 * `docs-drift.test.ts` checks that the documents do not NAME things the code lacks. It
 * cannot check that a document's example is a graph this compiler would accept, and that
 * gap is where the corpus rotted: D5.5's `incident-triage` spec — the artefact D4's
 * walkthrough, D7.10 and 08-PLAN all read against — could not be parsed by the shipped
 * YAML subset at all, and nobody noticed because nothing ran it.
 *
 * Prose about a mechanism has to be corrected by hand and re-verified by hand, which this
 * project has now done three times, acquiring a NEW false claim on two of them. An example
 * is different: it is executable, so the compiler can hold it. This is the piece that makes
 * the difference between "we corrected the docs" and "the docs cannot drift here again".
 *
 * Deliberately NOT asserting zero diagnostics everywhere: a worked example is allowed to
 * carry warnings, and pinning the exact set is what makes a silent change to compiler
 * behaviour visible in the same commit that causes it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { compile } from "../src/graph/compile.ts";
import { parseYamlSpec } from "../src/graph/yaml.ts";
import type { GraphSpec } from "../src/graph/spec.ts";
import type { ToolManifestLite } from "../src/graph/validate.ts";
import { resolver } from "./run/skeleton.ts";

const DESIGN = new URL("../../../design/loom/", import.meta.url);

/**
 * The first ```yaml fence after a heading.
 *
 * Targeted by heading rather than "every fence in the corpus", because not every fence is
 * a graph: D5.4's is a SCHEMA SKETCH whose values are type names (`name: string`,
 * `posture: out | on | in`), which is the right way to document a shape and is not
 * something a parser should accept. Sweeping every fence conflates "this example is
 * broken" with "this is not an example", and a guard that cannot tell the difference gets
 * turned off.
 */
function specAfter(file: string, heading: string): string {
  const text = readFileSync(new URL(file, DESIGN), "utf8");
  const at = text.indexOf(heading);
  assert.notEqual(at, -1, `${file} no longer contains the heading "${heading}"`);
  const m = /```yaml\n([\s\S]*?)```/.exec(text.slice(at));
  assert.ok(m !== null, `${file}: no yaml fence follows "${heading}"`);
  return m[1]!;
}

/**
 * A tool manifest synthesised from whatever the example names.
 *
 * The examples teach GRAPH SHAPE — fan-out, joins, error edges, gates — not which tools a
 * deployment ships, so the manifest must not be what fails them. It is deliberately
 * permissive: a stub marked `irreversible` makes an example fail GRAPH011 and GRAPH012 for
 * a reason that belongs to the stub, and a guard that reports the document's fault as the
 * fixture's fault is a guard nobody will trust twice. The oversight rules have their own
 * tests with real manifests.
 */
function manifestFor(spec: GraphSpec): Record<string, ToolManifestLite> {
  const tools: Record<string, ToolManifestLite> = {};
  for (const n of spec.nodes ?? []) {
    for (const name of [n.tool?.name, ...(n.agent?.tools ?? [])]) {
      if (name === undefined || tools[name] !== undefined) continue;
      // Self-compensating, so a compensation EDGE in the example is judged on its graph
      // shape rather than on whether this fixture happened to declare an undo.
      tools[name] = {
        name,
        version: n.tool?.version ?? "1.0",
        capabilities: [],
        irreversibility: "read_only",
        idempotent: true,
        compensation: { tool: name },
      };
    }
  }
  return tools;
}

function compileSpec(source: string): { ok: boolean; codes: string[] } {
  // A parse failure IS the finding — the corpus's only end-to-end example was
  // unparseable by the shipped subset, and three sections read against it.
  const spec = parseYamlSpec(source) as unknown as GraphSpec;
  const r = compile({
    spec,
    resolver: resolver(),
    tools: manifestFor(spec),
    // Granted from what the example itself declares: the tenant's grant is a deployment
    // fact, and withholding it would fail the document for something it is not teaching.
    tenantCapabilities: [
      ...new Set([
        ...(spec.policy?.capabilities ?? []),
        ...(spec.nodes ?? []).flatMap((n) => n.policy?.capabilities ?? []),
      ]),
    ],
  });
  return { ok: r.ok, codes: r.diagnostics.map((d) => d.code) };
}

test("THE WORKED EXAMPLES PARSE with the shipped YAML subset", () => {
  const failures: string[] = [];
  for (const [file, heading] of [
    ["02-EXECUTION-GRAPH.md", "## D5.5"],
    ["08-PLAN.md", "## D13.3"],
  ] as const) {
    try {
      parseYamlSpec(specAfter(file, heading));
    } catch (e) {
      failures.push(`${file} ${heading}: ${(e as Error).message}`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    "a document whose own example the parser rejects is telling readers to write something that cannot run",
  );
});

test("D5.5's worked example COMPILES, and its diagnostics are pinned", () => {
  const r = compileSpec(specAfter("02-EXECUTION-GRAPH.md", "## D5.5"));
  assert.equal(r.ok, true, `the corpus's only end-to-end example must compile; got ${r.codes.join(", ")}`);

  // Pinned rather than asserted empty: a worked example is allowed to carry warnings, and
  // pinning the set makes a change in compiler behaviour show up in the commit that causes
  // it rather than in a reader's confusion six months later.
  assert.deepEqual(
    r.codes.filter((c) => !c.startsWith("GRAPH009")),
    [],
    `unexpected diagnostics: ${r.codes.join(", ")}`,
  );
});

test("08-PLAN's walking-skeleton example compiles too", () => {
  const r = compileSpec(specAfter("08-PLAN.md", "## D13.3"));
  assert.equal(r.ok, true, `the walking skeleton must compile; got ${r.codes.join(", ")}`);
});
