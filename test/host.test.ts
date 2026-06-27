/**
 * Host wiring: the bits that make "drop a key in .env and run" actually work —
 * the zero-dep .env loader, provider selection, model defaulting from *_MODEL
 * env vars, the ANTHROPIC_AUTH_TOKEN alias, and fail-fast on an unknown
 * provider. These are pure offline checks (no network, no live provider).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BUILTIN_EXTENSIONS, createAgentHost, loadEnvFile, selectProvider, thinkingFromEnv } from "../src/host.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { silentLogger } from "./helpers.js";

test("loadEnvFile parses KEY=VALUE but never overrides the real environment", () => {
  const file = join(mkdtempSync(join(tmpdir(), "eagent-env-")), ".env");
  writeFileSync(
    file,
    ["# a comment", "EAGENT_TEST_A=alpha", 'export EAGENT_TEST_B="quoted value"', "EAGENT_TEST_C=dotenv-loses", ""].join("\n"),
  );
  process.env.EAGENT_TEST_C = "real-env-wins";
  try {
    const keys = loadEnvFile(file);
    assert.equal(process.env.EAGENT_TEST_A, "alpha");
    assert.equal(process.env.EAGENT_TEST_B, "quoted value", "surrounding quotes are stripped");
    assert.equal(process.env.EAGENT_TEST_C, "real-env-wins", "an already-set var must not be overwritten");
    assert.ok(keys.includes("EAGENT_TEST_A"));
    assert.ok(!keys.includes("EAGENT_TEST_C"));
  } finally {
    for (const k of ["EAGENT_TEST_A", "EAGENT_TEST_B", "EAGENT_TEST_C"]) delete process.env[k];
  }
});

test("loadEnvFile is a silent no-op for a missing file", () => {
  assert.deepEqual(loadEnvFile(join(tmpdir(), "eagent-definitely-missing.env")), []);
});

test("AnthropicProvider accepts ANTHROPIC_AUTH_TOKEN as an API-key alias", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevTok = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = "tok-abc";
  try {
    assert.equal(new AnthropicProvider().configured, true, "auth-token form should configure the provider");
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevTok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = prevTok;
  }
});

test("selectProvider falls back through configured providers and honors mock", () => {
  assert.equal(selectProvider(undefined, { anthropic: false, openai: true, gemini: false }), "openai");
  assert.equal(selectProvider("mock", { anthropic: true, openai: false, gemini: false }), "mock");
  assert.equal(selectProvider(undefined, { anthropic: false, openai: false, gemini: false }), "mock");
});

test("createAgentHost uses *_MODEL env for the chosen provider", async () => {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevModel = process.env.OPENAI_MODEL;
  process.env.OPENAI_API_KEY = "test-key"; // configures openai; no turn is run, so no network
  process.env.OPENAI_MODEL = "GLM-5.1";
  try {
    const built = await createAgentHost({
      provider: "openai",
      logger: silentLogger,
      discoverDirs: [],
      storeRoot: mkdtempSync(join(tmpdir(), "eagent-store-")),
    });
    assert.equal(built.model, "GLM-5.1", "the configured OPENAI_MODEL should win over the hardcoded default");
    await built.host.dispose();
  } finally {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    if (prevModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = prevModel;
  }
});

test("createAgentHost gives a project-local extension precedence over a user-global one of the same id", async () => {
  // The discover() contract is "later wins"; host.ts must therefore list the
  // project dir LAST so a project extension shadows a same-id user one. This
  // pins that ordering against an accidental swap.
  const root = mkdtempSync(join(tmpdir(), "eagent-precedence-"));
  const projExtDir = join(root, "project", ".eagent", "extensions");
  const homeExtDir = join(root, "home", ".eagent", "extensions");
  mkdirSync(projExtDir, { recursive: true });
  mkdirSync(homeExtDir, { recursive: true });
  // Same filename in both dirs => same extension id ("dup") => a collision.
  // Each registers a tool named "dup_marker" whose description records its origin.
  const ext = (origin: string) =>
    `export default function activate(e) {\n` +
    `  e.registerTool({ spec: { name: "dup_marker", description: ${JSON.stringify(origin)}, ` +
    `parameters: { type: "object", properties: {} } }, execute: async () => ({ content: "ok" }) });\n` +
    `}\n`;
  writeFileSync(join(projExtDir, "dup.ts"), ext("project"));
  writeFileSync(join(homeExtDir, "dup.ts"), ext("user"));

  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  process.env.HOME = join(root, "home"); // homedir() reads $HOME on POSIX
  process.chdir(join(root, "project"));
  try {
    const built = await createAgentHost({ logger: silentLogger, storeRoot: join(root, "state") });
    assert.equal(
      built.agent.tools.get("dup_marker")?.spec.description,
      "project",
      "the project-local extension must win over the user-global one of the same id",
    );
    await built.host.dispose();
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test("createAgentHost fails fast on an unknown provider instead of on the first turn", async () => {
  await assert.rejects(
    () =>
      createAgentHost({
        provider: "claud",
        logger: silentLogger,
        discoverDirs: [],
        storeRoot: mkdtempSync(join(tmpdir(), "eagent-store-")),
      }),
    /not available/,
  );
});

test("thinkingFromEnv accepts known levels and falls back to off", () => {
  assert.equal(thinkingFromEnv("high"), "high");
  assert.equal(thinkingFromEnv(" Medium "), "medium");
  assert.equal(thinkingFromEnv("off"), "off");
  assert.equal(thinkingFromEnv("bogus"), "off");
  assert.equal(thinkingFromEnv(undefined), "off");
});

test("createAgentHost threads an explicit thinking level onto the agent", async () => {
  const { agent } = await createAgentHost({ provider: "mock", logger: silentLogger, thinking: "low" });
  assert.equal(agent.thinking, "low");
});

test("loads the full canonical extension set with no failures or duplicate names", async () => {
  const { agent, host, commands, failures } = await createAgentHost({
    provider: "mock",
    logger: silentLogger,
    discoverDirs: [],
    storeRoot: mkdtempSync(join(tmpdir(), "eagent-store-")),
  });
  try {
    assert.equal(host.list().length, BUILTIN_EXTENSIONS.length, "every built-in extension activates");
    assert.equal(failures.length, 0, "no built-in extension fails to activate");
    const toolNames = agent.tools.list().map((t) => t.spec.name);
    assert.equal(new Set(toolNames).size, toolNames.length, "no duplicate active tool names");
    const commandNames = commands.list().map((c) => c.name);
    assert.equal(new Set(commandNames).size, commandNames.length, "no duplicate active command names");
  } finally {
    await host.dispose();
  }
});
