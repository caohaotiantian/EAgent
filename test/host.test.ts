/**
 * Host wiring: the bits that make "drop a key in .env and run" actually work —
 * the zero-dep .env loader, provider selection, model defaulting from *_MODEL
 * env vars, the ANTHROPIC_AUTH_TOKEN alias, and fail-fast on an unknown
 * provider. These are pure offline checks (no network, no live provider).
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAgentHost, loadEnvFile, selectProvider } from "../src/host.js";
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
