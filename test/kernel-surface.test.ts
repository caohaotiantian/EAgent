/**
 * The minimalism guard.
 *
 * EAgent's whole thesis is a small, stable core with unbounded extensibility.
 * This test pins the kernel's public surface so growth is a conscious decision:
 * adding a new export here fails the test and forces the author to ask "does
 * this primitive truly belong in the core, or is it an extension?" — the single
 * most important question in this codebase.
 *
 * If you are reading this because the test failed: either move your addition
 * into an extension, or, if it is genuinely a new primitive, add it to the list
 * below on purpose.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as kernel from "../src/kernel/index.js";

/** The complete, intended public surface of the kernel. Keep it small. */
const EXPECTED_EXPORTS = [
  // The runtime classes — the seven primitives and their support types.
  "Agent",
  "HookBus",
  "ToolRegistry",
  "ProviderRegistry",
  "CapabilityManager",
  "CapabilityError",
  "ExtensionHost",
  "CommandRegistry",
  "MemoryStore",
  "MemoryBackend",
  "FileBackend",
  // Small functional helpers.
  "defineTool",
  "validate",
  "combine",
  "text",
  "matchPattern",
  "setHandlerErrorReporter",
  // Usage accounting.
  "ZERO_USAGE",
  "addUsage",
  "totalTokens",
].sort();

test("the kernel exposes exactly its intended public surface (no scope creep)", () => {
  const actual = Object.keys(kernel).sort();
  assert.deepEqual(
    actual,
    EXPECTED_EXPORTS,
    "The kernel's public surface changed. If this is an extension's job, move it out; " +
      "if it is a real new primitive, update EXPECTED_EXPORTS deliberately.",
  );
});

test("the kernel source stays small", async () => {
  // A soft ceiling on the core. Extensions are unbounded; the kernel is not.
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(process.cwd(), "src", "kernel");
  let lines = 0;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".ts")) lines += readFileSync(join(dir, f), "utf8").split("\n").length;
  }
  assert.ok(lines < 2200, `kernel is ${lines} lines; keep the core minimal (ceiling 2200)`);
});
