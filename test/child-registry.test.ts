/**
 * Tests for the shared capability-based child-registry helper
 * (`src/extensions/lib/child-registry.ts`) — the single source of truth for the
 * recursion guard that four spawner extensions delegate to.
 *
 * T1.1 exercises the pure helper directly: it must strip EVERY tool declaring a
 * spawn-class capability (both `agent:spawn` AND `workflow:run`, so the guard is
 * not keyed on one name or one cap), keep no-cap tools, and honor the optional
 * `allowlist`. T1.6 pins the KDD3 invariant the strip relies on: every built-in
 * spawner tool declares a member of `SPAWN_CAPS`, so the capability strip covers
 * all of them by shape.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { childRegistryFrom, SPAWN_CAPS } from "../src/extensions/lib/child-registry.js";
import { defineTool } from "../src/kernel/define.js";
import type { Tool } from "../src/kernel/types.js";
import { createAgentHost } from "../src/host.js";
import { silentLogger } from "./helpers.js";

/** A trivial no-capability tool, for survivor assertions. */
function tool(name: string): Tool {
  return defineTool({ name, description: "x", execute: () => ({ content: "" }) });
}

/** A named tool declaring the given capabilities (for the recursion-guard path). */
function capTool(name: string, capabilities: string[]): Tool {
  return defineTool({ name, description: "x", capabilities, execute: () => ({ content: "" }) });
}

// ---------------------------------------------------------------------------
// T1.1 — capability strip (AC1)
// ---------------------------------------------------------------------------

test("T1.1 childRegistryFrom: strips every tool whose capabilities intersect SPAWN_CAPS (both caps), keeps no-cap tools", () => {
  const parent = [
    capTool("spawn_agent", ["agent:spawn"]),
    capTool("run_workflow", ["workflow:run"]),
    capTool("run_team", ["agent:spawn"]),
    tool("helper"),
  ];
  const reg = childRegistryFrom(parent);

  assert.equal(reg.has("helper"), true, "a no-cap tool survives");
  assert.equal(reg.has("spawn_agent"), false, "an agent:spawn tool is stripped");
  assert.equal(
    reg.has("run_workflow"),
    false,
    "a workflow:run tool is stripped — proving the guard is not keyed on agent:spawn alone",
  );
  assert.equal(reg.has("run_team"), false, "a second agent:spawn tool is stripped by capability, not name");
  assert.equal(reg.list().length, 1, "only the no-cap helper survives");
});

test("T1.1 childRegistryFrom: an fs:write-only tool survives (intersection, not any-cap)", () => {
  const reg = childRegistryFrom([capTool("write", ["fs:write"]), tool("read")]);
  assert.equal(reg.has("write"), true, "a non-spawn capability does not trigger the strip");
  assert.equal(reg.has("read"), true);
});

test("T1.1 childRegistryFrom: allowlist restricts survivors to allowlisted names", () => {
  const reg = childRegistryFrom(
    [tool("read"), tool("write"), capTool("spawn_agent", ["agent:spawn"])],
    { allowlist: ["read"] },
  );
  assert.equal(reg.has("read"), true, "an allowlisted no-cap tool survives");
  assert.equal(reg.has("write"), false, "a non-allowlisted tool is dropped");
  assert.equal(reg.has("spawn_agent"), false, "a spawn tool is dropped even if it were allowlisted");
  assert.equal(reg.list().length, 1);
});

// ---------------------------------------------------------------------------
// T1.6 — invariant pin (KDD3 / AC4): every built-in spawner declares a SPAWN_CAP
// ---------------------------------------------------------------------------

test("T1.6 invariant: every built-in spawner tool declares a SPAWN_CAP", async () => {
  const { agent } = await createAgentHost({
    provider: "mock",
    logger: silentLogger,
    discoverDirs: [],
    storeRoot: mkdtempSync(join(tmpdir(), "eagent-child-registry-")),
  });

  // The exhaustive inventory of child-spawning tools shipped in BUILTIN_EXTENSIONS.
  // The capability strip is only complete if EACH declares a spawn-class capability;
  // a future capless spawner would slip the guard and reopen the recursion hole.
  const spawners = [
    "spawn_agent",
    "spawn_template",
    "run_team",
    "run_workflow",
    "best_of_n",
    "tree_search",
    "graph_search",
    "sweep_edit",
    "launch_job",
  ];
  const spawnCaps = SPAWN_CAPS as readonly string[];
  for (const name of spawners) {
    const registered = agent.tools.get(name);
    assert.ok(registered, `spawner "${name}" is registered by the built-in extensions`);
    assert.ok(
      registered.capabilities?.some((c) => spawnCaps.includes(c)),
      `spawner "${name}" declares a SPAWN_CAP so the capability strip removes it from a child`,
    );
  }
});
