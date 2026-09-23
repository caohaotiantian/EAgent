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
  // `loom` is not published yet — `packages/core` is `private: true` — so nothing puts it on PATH
  // for a reader: either the packed tarball's `npm install -g` or the binary's `export PATH=`
  // does, and the README has to show one of them before it uses the bare name.
  const ways = [README.indexOf("npm install -g ./out/"), README.indexOf("export PATH=")].filter((i) => i !== -1);
  // `cd "$(mktemp -d)" && loom --version` counts as a bare use — the quoted argument has a space.
  const firstBareLoom = README.search(/^(?:cd .* && )?loom /m);
  assert.ok(ways.length > 0, "the quickstart must show how `loom` gets onto PATH");
  assert.ok(Math.min(...ways) < firstBareLoom, "it must do so BEFORE the first bare `loom` invocation");
});

test("EVERY TARBALL PATH THE READMES HAND TO npm IS A PATH npm READS AS A FILE", () => {
  // `npm install -g out/x.tgz` is the GitHub shorthand `github:out/x.tgz` to npm — measured, npm
  // 12.0.2: `EALLOWGIT … Refusing to fetch "github:out/caohaotiantian-loom-0.1.0.tgz"`, and npm 10
  // tries `git ls-remote ssh://git@github.com/out/…`. The install line a stranger copies was that
  // command until the lane's second review. `smoke-install.mjs` resolves its argument to an
  // absolute path, so it never ran the README's literal text; this does, for every README and
  // every `npm install|publish … <something>.tgz`.
  const core = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
  const design = readFileSync(join(import.meta.dirname, "..", "..", "..", "DESIGN.md"), "utf8");
  const paths: string[] = [];
  for (const text of [README, core, design]) {
    for (const m of text.replace(/\n/g, " ").matchAll(/npm (?:install|i|publish)(?: -g| --global| --offline)* +(\S+\.tgz)/g)) paths.push(m[1]!);
  }
  assert.ok(paths.length >= 3, `found ${String(paths.length)} tarball commands — the scan broke`);
  for (const p of paths) assert.match(p, /^(?:\.\.?\/|\/|~\/)/, `\`${p}\` is not a file path to npm — prefix it with ./`);
});

test("WHAT `scripts/smoke-install.mjs` READS OUT OF THE README IS STILL THERE", () => {
  // The install smoke runs the README's own first two examples through an installed `loom`, and
  // reads both the graph and its `--input` from here — so a rename here is a smoke that cannot run.
  const names = graphBlocks().map((b) => b.name);
  for (const file of ["graphs/copy.json", "graphs/gated.json"]) {
    assert.ok(names.includes(file), `README no longer creates ${file}`);
    const input = new RegExp(`^loom run\\s+${file.replace(/[./]/g, "\\$&")} --input '([^']*)'`, "m").exec(README);
    assert.ok(input, `README no longer runs ${file} with --input '…'`);
    JSON.parse(input[1]!);
  }
  assert.match(README, /^echo hello > input\.txt$/m, "smoke-install.mjs writes input.txt as `hello\\n` because the README does");
  assert.match(README, /^cat shipped\.txt +# ship it$/m, "smoke-install.mjs expects `ship it` in shipped.txt because the README does");
});

test("packages/core/README.md's hello-world IS the README's, byte for byte", () => {
  // The package README is what npm shows a stranger, and it carries a copy of one graph because a
  // registry page cannot link into "Try it". A copy nobody checks is a copy that drifts.
  const core = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
  const block = (text: string): string | undefined => /cat > graphs\/copy\.json <<'EOF'\n([\s\S]*?)\nEOF/.exec(text)?.[1];
  assert.ok(block(core) !== undefined, "packages/core/README.md no longer shows the copy.json graph");
  assert.equal(block(core), block(README));
});
