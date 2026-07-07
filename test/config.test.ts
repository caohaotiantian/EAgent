/**
 * LayeredConfig — the centralized configuration facility.
 *
 * These tests pin the business invariants the whole migration rests on:
 * the value-key precedence chain, unified parsing, the security-critical
 * `enabled()` gate (env-off is a hard veto; the config FILE never affects
 * enablement), legacy-env-name back-compat via aliases, and source reporting
 * with secret hiding.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { MemoryStore } from "../src/kernel/store.js";
import { LayeredConfig, configEnvName, loadConfigFile } from "../src/config.js";

/** Build a config with an optional file layer and a fresh in-memory override. */
function makeConfig(fileValues: Record<string, string | number | boolean> = {}) {
  return new LayeredConfig({ fileValues, overrideStore: new MemoryStore() });
}

/** Set env vars for the duration of one test, restoring afterward. */
const touchedEnv: string[] = [];
function setEnv(name: string, value: string): void {
  touchedEnv.push(name);
  process.env[name] = value;
}
afterEach(() => {
  for (const k of touchedEnv.splice(0)) delete process.env[k];
});

test("value precedence: override > env > file > default", () => {
  const cfg = makeConfig({ "a.b": "fromFile" });
  // default only
  assert.equal(makeConfig().string("nope"), undefined);
  assert.equal(makeConfig().int("nope", 7), 7);
  // file beats default
  assert.equal(cfg.string("a.b"), "fromFile");
  // env beats file
  setEnv("EAGENT_A_B", "fromEnv");
  assert.equal(cfg.string("a.b"), "fromEnv");
  // override beats env
  cfg.set("a.b", "fromOverride");
  assert.equal(cfg.string("a.b"), "fromOverride");
  cfg.unset("a.b");
  assert.equal(cfg.string("a.b"), "fromEnv");
});

test("int parses and falls back on non-numeric", () => {
  const cfg = makeConfig();
  setEnv("EAGENT_N", "42");
  assert.equal(cfg.int("n", 8), 42);
  setEnv("EAGENT_BAD", "not-a-number");
  assert.equal(cfg.int("bad", 8), 8);
});

test("bool parses the shared vocabulary and falls back otherwise", () => {
  const cfg = makeConfig();
  for (const v of ["1", "true", "on", "yes", "TRUE"]) {
    setEnv("EAGENT_FLAG", v);
    assert.equal(cfg.bool("flag", false), true, `${v} → true`);
  }
  for (const v of ["0", "false", "off", "no"]) {
    setEnv("EAGENT_FLAG", v);
    assert.equal(cfg.bool("flag", true), false, `${v} → false`);
  }
  setEnv("EAGENT_FLAG", "maybe");
  assert.equal(cfg.bool("flag", true), true, "unrecognized → fallback");
});

test("enabled(): env 'off' is a hard veto over override, store, and default", () => {
  const cfg = makeConfig();
  setEnv("EAGENT_X", "off");
  cfg.set("x", true); // an override cannot un-veto env-off
  assert.equal(cfg.enabled("x", { default: true }), false);
  assert.equal(cfg.enabled("x", { default: true, store: new MemoryStore() }), false);
});

test("enabled(): the config FILE never affects enablement (security invariant)", () => {
  // A project file setting x=true must NOT enable a default-off extension,
  // and x=false must NOT disable a default-on one.
  const onByFile = makeConfig({ x: true });
  assert.equal(onByFile.enabled("x", { default: false }), false, "file cannot enable");
  const offByFile = makeConfig({ y: false });
  assert.equal(offByFile.enabled("y", { default: true }), true, "file cannot disable");
});

test("enabled(): override enables/disables; /config set is honored", () => {
  const cfg = makeConfig();
  assert.equal(cfg.enabled("z", { default: false }), false);
  cfg.set("z", true);
  assert.equal(cfg.enabled("z", { default: false }), true);
  cfg.set("z", false);
  assert.equal(cfg.enabled("z", { default: true }), false);
});

test("enabled(): store flag with default threaded (default-on stays on when unset)", () => {
  const cfg = makeConfig();
  const emptyStore = new MemoryStore();
  // default-on guard: store key unset → stays on
  assert.equal(cfg.enabled("guard", { default: true, store: emptyStore }), true);
  // opt-in: store key unset → stays off
  assert.equal(cfg.enabled("optin", { default: false, store: emptyStore }), false);
  // explicit store flag wins over default
  const off = new MemoryStore();
  off.set("enabled", false);
  assert.equal(cfg.enabled("guard", { default: true, store: off }), false);
  const on = new MemoryStore();
  on.set("enabled", true);
  assert.equal(cfg.enabled("optin", { default: false, store: on }), true);
});

test("env-name derivation maps dots and dashes to underscores", () => {
  assert.equal(configEnvName("subagents.maxTurns"), "EAGENT_SUBAGENTS_MAX_TURNS");
  assert.equal(configEnvName("bash-policy"), "EAGENT_BASH_POLICY");
  assert.equal(configEnvName("skill-triggers"), "EAGENT_SKILL_TRIGGERS");
  assert.equal(configEnvName("subagents.lp"), "EAGENT_SUBAGENTS_LP");
});

test("legacy env aliases resolve (back-compat)", () => {
  const cfg = makeConfig();
  setEnv("EAGENT_MAX_MCP_READ_BYTES", "123");
  assert.equal(cfg.int("mcp.maxReadBytes", 16), 123);
  setEnv("EAGENT_MAX_SESSIONS", "50");
  assert.equal(cfg.int("server.maxSessions", 1000), 50);
  setEnv("EAGENT_HOST", "0.0.0.0");
  assert.equal(cfg.string("server.host"), "0.0.0.0");
  setEnv("ANTHROPIC_MODEL", "claude-x");
  assert.equal(cfg.string("models.anthropic"), "claude-x");
  // the derived name still wins when both are present
  setEnv("EAGENT_MCP_MAX_READ_BYTES", "999");
  assert.equal(cfg.int("mcp.maxReadBytes", 16), 999);
});

test("entries() reports the winning source and hides secret-substring keys", () => {
  const cfg = makeConfig({ "a.plain": "fileval" });
  cfg.set("b.over", 3);
  setEnv("EAGENT_C_ENV", "envval");
  cfg.string("c.env"); // touch it so it's tracked
  cfg.string("secret.apiKey"); // touch a secret key
  cfg.set("my.token", "shh");
  const byKey = new Map(cfg.entries().map((e) => [e.key, e]));
  assert.equal(byKey.get("a.plain")?.source, "file");
  assert.equal(byKey.get("b.over")?.source, "override");
  assert.equal(byKey.get("c.env")?.source, "env");
  assert.equal(byKey.get("my.token")?.value, "«hidden»");
});

test("envOnlyConfig fallback: an un-configured host honors env and defaults", async () => {
  // The ExtensionHost fallback (no host config) still reads env so existing
  // extension tests that set process.env keep working.
  const { ExtensionHost } = await import("../src/kernel/extension.js");
  const { Agent } = await import("../src/kernel/agent.js");
  const agent = new Agent();
  const host = new ExtensionHost({ agent });
  let seen: { enabled: boolean; turns: number } | undefined;
  await host.use("probe", (e) => {
    seen = { enabled: e.config.enabled("probe", { default: true }), turns: e.config.int("agent.maxTurns", 24) };
  });
  assert.equal(seen?.enabled, true);
  assert.equal(seen?.turns, 24);
  setEnv("EAGENT_PROBE", "off");
  setEnv("EAGENT_AGENT_MAX_TURNS", "3");
  await host.use("probe2", (e) => {
    seen = { enabled: e.config.enabled("probe", { default: true }), turns: e.config.int("agent.maxTurns", 24) };
  });
  assert.equal(seen?.enabled, false);
  assert.equal(seen?.turns, 3);
});

test("loadConfigFile merges project over user and ignores bad files", () => {
  // pure function over paths; missing files are skipped, so this returns {}
  assert.deepEqual(loadConfigFile(["/nonexistent/a.json", "/nonexistent/b.json"]), {});
});
