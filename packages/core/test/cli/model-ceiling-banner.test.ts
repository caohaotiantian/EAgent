/**
 * THE OUTPUT CEILING NOBODY CHOSE, AND WHAT IT COST.
 *
 * A run against a live GLM-5.2 died with `E_PROVIDER_BAD_REQUEST … finishReason "max_tokens",
 * outputTokens 32001, contentChars 0`: the model spent its ENTIRE output budget on reasoning and
 * returned nothing. The operator reached that number empirically — 4,096 first, which never
 * reached content at all, then 16,000, which still truncated one turn of three. Nothing anywhere
 * said what the ceiling was, and `--models-file` never had to state one: both adapters end
 * `req.maxTokens ?? opts.defaultMaxTokens ?? 4096`, so a file that omits the field runs every
 * route at a number this repo picked and never printed.
 *
 * WHY THE WARNING FIRES ON SILENCE AND NOT ON A NUMBER. A threshold applied to a ceiling the
 * operator CHOSE is noise — it second-guesses a decision on evidence it does not have, and a
 * banner line that fires on a correct configuration is a line operators learn to skip. The one
 * thing this file can say without inventing a threshold is that a ceiling was never chosen at
 * all. So: an adapter row that states `defaultMaxTokens` gets nothing, at any value; an adapter
 * row that omits it is told which number it inherited.
 *
 * `execWarnings` is the pattern — the DECISION is a pure exported function so it can be checked
 * without a socket and without spawning `serve`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelWarnings, readModels } from "../../src/cli.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../../src/providers/http.ts";

const ENV = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" };

function config(doc: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "loom-ceiling-"));
  const file = join(dir, "models.json");
  writeFileSync(file, JSON.stringify(doc));
  try {
    return readModels(file, ENV);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PRICED = { "claude-sonnet-5": { input: 3, output: 15 } };

test("an adapter row that states no defaultMaxTokens is named, with the number it inherited", () => {
  const models = config({
    adapters: [{ provider: "anthropic", prices: PRICED }],
    routes: { "agent_profile/reviewer@stable": { adapter: "anthropic", model: "claude-sonnet-5" } },
  });
  assert.deepEqual(models.unsetCeilings, ["anthropic"], "the adapter stated no ceiling, so it must be reported");

  const lines = modelWarnings(models, "run").join("");
  assert.match(lines, /NO OUTPUT-TOKEN CEILING/, `the banner must name the unset ceiling: ${JSON.stringify(lines)}`);
  assert.match(lines, new RegExp(String(DEFAULT_MAX_OUTPUT_TOKENS)), "it must say WHICH number was inherited");
  assert.match(lines, /anthropic/, "it must name the adapter row to edit");
  assert.match(lines, /defaultMaxTokens/, "it must name the field that fixes it");
});

test("an adapter row that STATES a ceiling is never second-guessed, at any value", () => {
  // 1 is absurdly small and 999999 is absurdly large. Both are the operator's decision, and a
  // warning that fires on either is the cry-wolf failure this line exists to avoid.
  for (const chosen of [1, DEFAULT_MAX_OUTPUT_TOKENS, 999999]) {
    const models = config({
      adapters: [{ provider: "anthropic", prices: PRICED, defaultMaxTokens: chosen }],
      routes: { "agent_profile/reviewer@stable": { adapter: "anthropic", model: "claude-sonnet-5" } },
    });
    assert.deepEqual(models.unsetCeilings, [], `defaultMaxTokens: ${String(chosen)} is a choice, not a gap`);
    assert.doesNotMatch(modelWarnings(models, "run").join(""), /OUTPUT-TOKEN CEILING/, `warned about a stated ${String(chosen)}`);
  }
});

test("one adapter of two may be unset, and only that one is named", () => {
  const models = config({
    adapters: [
      { provider: "anthropic", name: "big", prices: PRICED, defaultMaxTokens: 32000 },
      { provider: "anthropic", name: "small", prices: PRICED },
    ],
    routes: {
      "agent_profile/reviewer@stable": { adapter: "big", model: "claude-sonnet-5" },
      mock: { adapter: "small", model: "claude-sonnet-5" },
    },
  });
  assert.deepEqual(models.unsetCeilings, ["small"]);
  const lines = modelWarnings(models, "run").join("");
  assert.match(lines, /small/);
  assert.doesNotMatch(lines, /\bbig\b/, `the adapter that stated 32000 must not appear: ${JSON.stringify(lines)}`);
});

test("modelWarnings still carries the two lines the banner already had", () => {
  // The refactor moved a decision that was written straight to stderr and never asserted on.
  assert.match(modelWarnings(undefined, "run").join(""), /NO MODEL ADAPTER/);
  // `glm-5.2` is in no adapter's price table, which is what makes the route unpriced.
  const unpriced = config({
    adapters: [{ provider: "anthropic", defaultMaxTokens: 32000 }],
    routes: { "agent_profile/reviewer@stable": { adapter: "anthropic", model: "glm-5.2" } },
  });
  assert.match(modelWarnings(unpriced, "run").join(""), /NO PRICE FOR 1 ROUTE/);
});

test("the number the banner prints is the number the request body carries", () => {
  // The banner used to be able to drift from the adapters: `4096` was written in four places
  // across two provider files and would have been a fifth here. One constant, or the warning
  // eventually names a ceiling the request does not use.
  assert.equal(typeof DEFAULT_MAX_OUTPUT_TOKENS, "number");
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 4096);
});
