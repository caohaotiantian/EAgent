/**
 * Doc/code drift guard for the built-in extension set. `BUILTIN_EXTENSIONS`
 * (src/host.ts) is the authoritative list; several docs restate its count and
 * order. This test keys those docs on the code, so adding/removing/reordering an
 * extension fails until the docs are updated — the drift a whole-branch audit
 * found (CLAUDE.md "62", ARCHITECTURE "59" + an out-of-date load-order list).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_EXTENSIONS } from "../src/host.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const names = BUILTIN_EXTENSIONS.map((e) => e[0]);
const count = names.length;

test(`CLAUDE.md states the built-in extension count (${count})`, () => {
  const md = read("CLAUDE.md");
  assert.ok(md.includes(`${count} built-in extensions`), `CLAUDE.md must say "${count} built-in extensions"`);
  assert.ok(md.includes(`${count} ship in`), `CLAUDE.md must say "${count} ship in BUILTIN_EXTENSIONS"`);
});

test(`ARCHITECTURE.md lists all ${count} extensions in BUILTIN_EXTENSIONS order`, () => {
  const md = read("ARCHITECTURE.md");
  assert.ok(md.includes(`${count} extensions`), `ARCHITECTURE.md must say "${count} extensions"`);
  // Extract the backticked ids from the load-order enumeration paragraph and
  // compare to the authoritative order (robust to line wrapping / whitespace).
  const start = md.indexOf("the order listed in `BUILTIN_EXTENSIONS`");
  assert.ok(start >= 0, "ARCHITECTURE.md must enumerate the load order");
  const end = md.indexOf("The README has a one-line description", start);
  assert.ok(end > start, "the load-order enumeration must end with the README pointer");
  const enumerated = [...md.slice(start, end).matchAll(/`([a-z0-9-]+)`/g)]
    .map((m) => m[1])
    .filter((n) => n !== "BUILTIN_EXTENSIONS" && n !== "src/host.ts");
  assert.deepEqual(enumerated, names, "the ARCHITECTURE.md load-order list must match BUILTIN_EXTENSIONS exactly");
});

test("README.md documents every built-in extension and states the count", () => {
  const md = read("README.md");
  const missing = names.filter((n) => !md.includes(`\`${n}\``));
  assert.deepEqual(missing, [], `README.md must document every built-in extension; missing: ${missing.join(", ")}`);
  // Pin the count string too — names-only checks miss a stale "62 built-in extensions".
  assert.ok(md.includes(`${count} built-in extensions`), `README.md must say "${count} built-in extensions"`);
});
