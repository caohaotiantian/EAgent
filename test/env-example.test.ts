/**
 * `.env.example` documents the resource & safety knobs, and every env-var name it
 * lists actually resolves to its config key. A documented name that doesn't work
 * (a typo, or drift from the `EAGENT_ + UPPER(key)` derivation) is worse than no
 * documentation — this test pins the names to the code.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MemoryStore } from "../src/kernel/store.js";
import { LayeredConfig, configEnvName } from "../src/config.js";

const envExample = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", ".env.example"),
  "utf8",
);

function makeConfig() {
  return new LayeredConfig({ fileValues: {}, overrideStore: new MemoryStore() });
}

const touchedEnv: string[] = [];
function setEnv(name: string, value: string): void {
  touchedEnv.push(name);
  process.env[name] = value;
}
afterEach(() => {
  for (const k of touchedEnv.splice(0)) delete process.env[k];
});

/** Each documented safety knob: its config key, the env var `.env.example` lists,
 *  its kind, and whether the env var is the plain `EAGENT_ + UPPER(key)` derivation
 *  (`derived`) or an honored legacy alias. */
const KNOBS: { key: string; env: string; kind: "int" | "bool"; derived: boolean }[] = [
  { key: "hardened", env: "EAGENT_HARDENED", kind: "bool", derived: true },
  { key: "subagents.maxFanout", env: "EAGENT_SUBAGENTS_MAX_FANOUT", kind: "int", derived: true },
  { key: "watchdog.idleMs", env: "EAGENT_WATCHDOG_IDLE_MS", kind: "int", derived: true },
  { key: "mcp.requestTimeoutMs", env: "EAGENT_MCP_REQUEST_TIMEOUT_MS", kind: "int", derived: true },
  { key: "risk-guard.timeoutMs", env: "EAGENT_RISK_GUARD_TIMEOUT_MS", kind: "int", derived: true },
  { key: "server.maxSessions", env: "EAGENT_MAX_SESSIONS", kind: "int", derived: false }, // alias
  { key: "fs.maxReadBytes", env: "EAGENT_FS_MAX_READ_BYTES", kind: "int", derived: true },
  { key: "mcp.maxReadBytes", env: "EAGENT_MAX_MCP_READ_BYTES", kind: "int", derived: false }, // alias
  { key: "providers.anthropic.maxTokens", env: "EAGENT_PROVIDERS_ANTHROPIC_MAX_TOKENS", kind: "int", derived: true },
  { key: "providers.openai.maxTokens", env: "EAGENT_PROVIDERS_OPENAI_MAX_TOKENS", kind: "int", derived: true },
  { key: "providers.gemini.maxTokens", env: "EAGENT_PROVIDERS_GEMINI_MAX_TOKENS", kind: "int", derived: true },
  { key: "compact.subCallTimeoutMs", env: "EAGENT_COMPACT_SUB_CALL_TIMEOUT_MS", kind: "int", derived: true },
];

/** The eight extensions whose nested LLM call the `SUB_CALL_TIMEOUT_MS` pattern covers. */
const SUB_CALL_EXTS = ["compact", "drift-probe", "evals", "goal", "handoff", "reasoning-search", "routing", "session"];

test("every documented safety-knob env var resolves to its config key", () => {
  for (const { key, env, kind } of KNOBS) {
    if (kind === "bool") {
      setEnv(env, "true");
      assert.equal(makeConfig().bool(key, false), true, `${env} → ${key}`);
    } else {
      setEnv(env, "4242");
      assert.equal(makeConfig().int(key, -1), 4242, `${env} → ${key}`);
    }
  }
});

test("derived env-var names match the EAGENT_ + UPPER(key) derivation", () => {
  for (const { key, env, derived } of KNOBS) {
    if (derived) assert.equal(configEnvName(key), env, `${key} derives ${env}`);
  }
  // Every subCallTimeoutMs knob derives EAGENT_<EXT>_SUB_CALL_TIMEOUT_MS.
  for (const ext of SUB_CALL_EXTS) {
    const key = `${ext}.subCallTimeoutMs`;
    assert.match(configEnvName(key), /^EAGENT_[A-Z_]+_SUB_CALL_TIMEOUT_MS$/, `${key}`);
  }
});

test(".env.example documents each knob and the sub-call timeout pattern", () => {
  for (const { env } of KNOBS) {
    assert.ok(envExample.includes(env), `.env.example lists ${env}`);
  }
  assert.ok(envExample.includes("EAGENT_<EXT>_SUB_CALL_TIMEOUT_MS"), ".env.example documents the sub-call pattern");
  // Pin the exact documented list (a bare `includes(ext)` would be satisfied
  // incidentally, e.g. "session" by "per-session" elsewhere in the file).
  assert.ok(envExample.includes(SUB_CALL_EXTS.join(", ")), ".env.example lists all eight sub-call extensions");
});

test("the documented EAGENT_WATCHDOG kill switch vetoes the watchdog", () => {
  assert.ok(envExample.includes("EAGENT_WATCHDOG"), ".env.example lists the EAGENT_WATCHDOG kill switch");
  setEnv("EAGENT_WATCHDOG", "off");
  assert.equal(makeConfig().enabled("watchdog", { default: true }), false, "EAGENT_WATCHDOG=off is a hard veto");
});
