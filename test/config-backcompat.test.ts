/**
 * Back-compat matrix (design AC 7): every legacy `EAGENT_*` env name a user may
 * already have in a `.env` or shell profile must keep working after the
 * migration — setting it changes the value/enablement the corresponding
 * `LayeredConfig` accessor returns, including the irregular names honored only
 * through `ENV_ALIASES` (e.g. `EAGENT_MAX_MCP_READ_BYTES`, `EAGENT_MAX_SESSIONS`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LayeredConfig } from "../src/config.js";
import { MemoryStore } from "../src/kernel/store.js";

/** A fresh env-reading config with an empty override + file layer. */
function freshConfig(): LayeredConfig {
  return new LayeredConfig({ overrideStore: new MemoryStore() });
}

interface Row {
  env: string;
  value: string;
  /** Read the migrated key back through the config; result must equal `expected`. */
  read: (c: LayeredConfig) => unknown;
  expected: unknown;
}

const ROWS: Row[] = [
  { env: "EAGENT_SUBAGENTS_MAX_TURNS", value: "3", read: (c) => c.int("subagents.maxTurns", 8), expected: 3 },
  { env: "EAGENT_TEAMS_DIR", value: "/x/teams", read: (c) => c.string("teams.dir"), expected: "/x/teams" },
  { env: "EAGENT_RISK_GUARD_TIMEOUT_MS", value: "50", read: (c) => c.int("risk-guard.timeoutMs", 10000), expected: 50 },
  { env: "EAGENT_MEMORY_PROMOTE_AT", value: "2", read: (c) => c.int("memory.promoteAt", 0), expected: 2 },
  // Irregular legacy names resolved through ENV_ALIASES (derived name differs).
  { env: "EAGENT_MAX_MCP_READ_BYTES", value: "1024", read: (c) => c.int("mcp.maxReadBytes", 16 * 1024 * 1024), expected: 1024 },
  { env: "EAGENT_MAX_SESSIONS", value: "42", read: (c) => c.int("server.maxSessions", 1000), expected: 42 },
  { env: "EAGENT_WORKSPACE", value: "/tmp/ws", read: (c) => c.string("workspace"), expected: "/tmp/ws" },
  // Kill switches: the legacy env "off" still vetoes the key (default:true proves the wiring).
  { env: "EAGENT_SANDBOX_TIERS", value: "off", read: (c) => c.enabled("sandbox-tiers", { default: true }), expected: false },
  { env: "EAGENT_COMPACT", value: "off", read: (c) => c.enabled("compact", { default: true }), expected: false },
];

for (const row of ROWS) {
  test(`legacy ${row.env} still drives its migrated config key`, () => {
    const prev = process.env[row.env];
    process.env[row.env] = row.value;
    try {
      assert.deepEqual(row.read(freshConfig()), row.expected);
    } finally {
      if (prev === undefined) delete process.env[row.env];
      else process.env[row.env] = prev;
    }
  });
}

test("with the legacy env unset, the accessor returns the code default", () => {
  const saved: Record<string, string | undefined> = {};
  for (const row of ROWS) {
    saved[row.env] = process.env[row.env];
    delete process.env[row.env];
  }
  try {
    const c = freshConfig();
    assert.equal(c.int("subagents.maxTurns", 8), 8);
    assert.equal(c.int("server.maxSessions", 1000), 1000);
    assert.equal(c.string("workspace"), undefined);
    assert.equal(c.enabled("sandbox-tiers", { default: true }), true, "default-on kill switch stays on when unset");
  } finally {
    for (const row of ROWS) {
      if (saved[row.env] === undefined) delete process.env[row.env];
      else process.env[row.env] = saved[row.env];
    }
  }
});
