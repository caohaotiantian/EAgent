/**
 * THE README'S GRAPHS COMPILE, and its test count is the one the gate prints.
 *
 * The quickstart is the first thing anybody runs, and it had drifted from the product in ways
 * that cost a reader their first hour: it called a bare `loom` that is on no PATH, claimed "21
 * validation rules" against a suite that asserts 22, claimed 386 tests against 1775, and claimed
 * "a run survives `kill -9` and resumes in another process" without the qualifier that makes it
 * true — only a run SUSPENDED ON A GATE does.
 *
 * A doc that overstates a framework costs its reader a day finding out. This pins the part a
 * machine can check: the graphs in the README are graphs this compiler accepts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { compile } from "../src/graph/compile.ts";
import type { GraphSpec } from "../src/graph/spec.ts";
import { resolver } from "./run/skeleton.ts";

const README = readFileSync(join(import.meta.dirname, "..", "..", "..", "README.md"), "utf8");

const TOOLS = {
  "fs.read": { name: "fs.read", version: "1.0", capabilities: ["fs:read"], irreversibility: "read_only" as const, idempotent: true },
  "fs.write": { name: "fs.write", version: "1.0", capabilities: ["fs:write"], irreversibility: "reversible_write" as const, idempotent: false },
};

/** Every `cat > …json <<'EOF' … EOF` block the README tells a reader to create. */
function graphBlocks(): { name: string; spec: unknown }[] {
  const out: { name: string; spec: unknown }[] = [];
  const re = /cat > (\S+\.json) <<'EOF'\n([\s\S]*?)\nEOF/g;
  for (let m = re.exec(README); m !== null; m = re.exec(README)) {
    out.push({ name: m[1]!, spec: JSON.parse(m[2]!) });
  }
  return out;
}

test("EVERY GRAPH THE README ASKS A READER TO WRITE COMPILES", () => {
  const blocks = graphBlocks();
  assert.ok(blocks.length >= 2, `expected the quickstart graphs; found ${blocks.length}`);
  for (const { name, spec } of blocks) {
    const r = compile({
      spec: spec as GraphSpec,
      resolver: resolver(),
      tools: TOOLS,
      tenantCapabilities: ["fs:read", "fs:write"],
    });
    const errors = (r.diagnostics ?? []).filter((x) => x.severity === "error");
    assert.equal(r.ok, true, `${name} must compile: ${errors.map((e) => `${e.code}: ${e.message}`).join("; ")}`);
    // AND NO WARNINGS ABOUT NAMES. `GRAPH013_UNKNOWN_TOOL` is deliberately a warning — a graph is
    // legitimately compiled against a partial tool map — so `ok` stays true through a tool typo,
    // measured. In the README a typo is still a defect: it is the one graph every reader runs.
    const unknown = (r.diagnostics ?? []).filter((x) => x.code === "GRAPH013_UNKNOWN_TOOL");
    assert.deepEqual(unknown.map((x) => x.message), [], `${name} names a tool that does not exist`);
  }
});

test("THE README DOES NOT TELL A READER TO RUN A COMMAND THAT IS ON NO PATH", () => {
  // `loom` is not published — `packages/core` is `private: true` with no `bin` — so the binary
  // IS the install, and the quickstart has to say so before it uses the bare name.
  const pathLine = README.indexOf("export PATH=");
  const firstBareLoom = README.search(/^loom /m);
  assert.notEqual(pathLine, -1, "the quickstart must show how `loom` gets onto PATH");
  assert.ok(pathLine < firstBareLoom, "it must do so BEFORE the first bare `loom` invocation");
});
