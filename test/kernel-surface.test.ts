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
import type { ExtensionAPI } from "../src/kernel/extension.js";

/** The complete, intended public surface of the kernel. Keep it small. */
const EXPECTED_EXPORTS = [
  // The runtime classes — the seven primitives and their support types.
  "Agent",
  "currentActingAgent",
  "currentRootAgent",
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
  "imageMessage",
  "isMessage",
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
  // 2,265 -> 2,315 (+50, the same size as the 2,200 -> 2,250 Config raise) for the
  // TUI parity seams: `UI.decide?` — a structured permission request that
  // `confirm`'s single pre-formatted string cannot carry — the `setFallback` /
  // `forget` pair without which a permission-mode control cannot exist (the
  // fallback was constructor-only and an answer was remembered forever, so
  // cycling back to `ask` was a silent no-op), and `tool_progress` for live tool
  // output. Each is load-bearing for a named product feature; the alternative was
  // dropping those features. NOTE the metric is `split("\n").length`, which counts
  // one more per file than `wc -l` — 12 files, so it reads ~12 above a wc count.
  assert.ok(lines <= 2315, `kernel is ${lines} lines; keep the core minimal (ceiling 2315)`);
});

/** The stable member set of the object handed to every extension at activation. */
const EXPECTED_API_MEMBERS = [
  "id",
  "registerTool",
  "registerProvider",
  "registerCommand",
  "on",
  "hook",
  "grantCapability",
  "store",
  "config",
  "log",
  "agent",
  "rootAgent",
  "commands",
  "reload",
  "loadExtension",
  "unloadExtension",
].sort();

test("the ExtensionAPI exposes exactly its intended members (no surface creep)", async () => {
  const agent = new kernel.Agent();
  const host = new kernel.ExtensionHost({ agent });
  let captured: ExtensionAPI | undefined;
  await host.use("surface-pin", (e) => {
    captured = e;
  });
  assert.ok(captured, "the activation captured the ExtensionAPI");
  assert.deepEqual(
    Object.keys(captured).sort(),
    EXPECTED_API_MEMBERS,
    "The ExtensionAPI surface changed. Add a member deliberately or move the capability into an extension.",
  );
});
