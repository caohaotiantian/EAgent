/**
 * WHY THE UNPINNED LOADERS ARE NOT A LIVE HOLE, stated as a set of sites rather than a belief.
 *
 * `FunctionLoaderOptions.pins` and `HookLoaderOptions.pins` are both accepted and neither is ever
 * supplied — `cli.ts` builds each loader with `{ store }` alone — so the manifest-digest branch in
 * each is unreachable through `bin/loom`. The consequence the docstrings name is real: a promotion
 * between compile and execute would swap a body under a live run, which is the defect A22 closed
 * for prompts and A24 still records for subgraph specs.
 *
 * WHAT MAKES IT UNREACHABLE IS NOT THE LOADER. It is that a `ResourceStore` in the shipped product
 * is SEALED AFTER BOOT: nothing can change what a ref resolves to while a process is running. That
 * is a claim about a SET of call sites, and this repository's standing rule is that such a claim is
 * worth nothing unless the set is named and checked — "this boundary is total" cannot be verified;
 * a claim that enumerates its members can.
 *
 * So this file is the enumeration, and it fails the moment any member joins:
 *
 *   1. no `.publish(` or `.promote(` on a store anywhere under `src/`;
 *   2. `readResources` — the filesystem scan — has exactly ONE call site, the boot seed;
 *   3. no HTTP route addresses a resource at all, so no request can publish one.
 *
 * IT DOES NOT SAY THE LOADERS ARE FINE. An embedder holding a `ResourceStore` can publish and
 * promote at will, and then the hole is real and the pins are the fix — `functions.test.ts` proves
 * both directions of that. What this says is narrower and is the reason the redesign is not urgent:
 * **the shipped binary and the shipped server have no way to reach it.** When a publish route or a
 * hot-reload path arrives, one of these three assertions goes red and sends its author here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../../src/", import.meta.url).pathname;

/** Every `.ts` under `src/`, recursively, as `[relativePath, text]`. */
function sources(): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else if (e.name.endsWith(".ts")) out.push([rel, readFileSync(join(dir, e.name), "utf8")]);
    }
  };
  walk(SRC, "");
  return out;
}

/** Strip block and line comments, so a docstring discussing `publish` is not a call site. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

test("NOTHING IN `src/` PUBLISHES OR PROMOTES A RESOURCE — the store is sealed after boot", () => {
  const hits: string[] = [];
  for (const [path, text] of sources()) {
    for (const m of code(text).matchAll(/(\w+)\.(publish|promote)\(/g)) {
      // `EventBus.publish` is a different method on a different object and is not a resource
      // write. Named explicitly rather than filtered by a loose pattern, so a NEW `x.publish`
      // shows up here instead of being swallowed.
      if (m[1] === "bus" || m[1] === "#bus") continue;
      hits.push(`${path}: ${m[0]}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    "a resource write appeared in src/. The unpinned function and hook loaders are only safe because " +
      "nothing can move a ref while a process runs — wire `pins` through before adding this",
  );
});

test("THE FILESYSTEM SCAN HAS EXACTLY ONE CALL SITE, and it is the boot seed", () => {
  const calls: string[] = [];
  for (const [path, text] of sources()) {
    for (const m of code(text).matchAll(/readResources\(/g)) {
      void m;
      calls.push(path);
    }
  }
  // Two occurrences in one file: the declaration `function readResources(` and the one call.
  assert.deepEqual(calls, ["cli.ts", "cli.ts"], "readResources must be declared once and called once");
  const cli = code(readFileSync(join(SRC, "cli.ts"), "utf8"));
  // THE PROPERTY IS "the single call is the boot seed", not the exact expression. The seed now
  // also carries a pin per `function`/`hook` ref an `--extension-module` registered a body for
  // — `rule015Resources` asks the RESOLVER, so without one such a graph fails
  // `GRAPH015_RESOURCE_NOT_FOUND` for a body that is registered and fine. Both halves are
  // pinned separately so neither can quietly become a rescan.
  assert.match(cli, /const published = readResources\(root\);/, "the single call must still be the boot seed");
  assert.match(
    cli,
    /new ResourceStore\(\{ seed: \[\.\.\.moduleRefs[^\n]*\.\.\.published\] \}\)/,
    "…and that seed must be what the store is constructed from — a rescan anywhere else reopens the swap",
  );
});

test("NO HTTP ROUTE ADDRESSES A RESOURCE — a request cannot move a ref", () => {
  const http = code(readFileSync(join(SRC, "server/http.ts"), "utf8"));
  const patterns = [...http.matchAll(/pattern:\s*(\/\^[^,\n]+)/g)].map((m) => m[1]!);
  assert.ok(patterns.length >= 10, `the pattern scan found only ${patterns.length} routes — the regex broke, not the routes`);
  const resourceish = patterns.filter((p) => /resource|prompt|function|hook|subgraph|publish|promote/i.test(p));
  assert.deepEqual(
    resourceish,
    [],
    "a route now addresses a resource. If it can write one, the sealed-after-boot claim is false and " +
      "`FunctionLoaderOptions.pins` / `HookLoaderOptions.pins` have to be wired before it ships",
  );
});
