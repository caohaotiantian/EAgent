/**
 * A route no price table prices used to cost 0. Now it refuses.
 *
 * `priceOf` answers a NUMBER, and its answer for a model it has no row for is `0`. A budget
 * compares against a number, so a run on an unpriced route spent without limit while journaling
 * `costUsd: 0` — `policy.budget.costUsd` bounded nothing, `--budget-usd` bounded nothing, and
 * `/health` reported a spend that did not happen. The binary printed `! NO PRICE FOR 1 ROUTE`
 * and then made the call anyway. Driven at 294e713 against a dead endpoint, which is the tell
 * that the request was actually issued:
 *
 *     $ loom run agent.json --workspace … --models-file …/models.json
 *     ! NO PRICE FOR 1 ROUTE — every call on it is journaled as costing 0,
 *     "code": "E_PROVIDER_TRANSPORT", "message": "fetch failed"
 *
 * At HEAD the same command never reaches the socket:
 *
 *     ! NO PRICE FOR 1 ROUTE — a model call on it now REFUSES
 *     "code": "E_CONFIG_INVALID",
 *     "message": "route \\"agent_profile/writer@stable\\" … points at local/nobody-prices-me,
 *       which no price table prices …"
 *
 * TWO THINGS THIS TEST IS ALSO ABOUT, because a fail-closed guard that cannot be cleared is a
 * guard operators route around. The escape is a ROW, not a flag: `{"input": 0, "output": 0}` is
 * legal, `priceTable` documents it ("a free local endpoint is a real thing"), and `pricedFor`
 * now distinguishes it from a missing row — which the old `priceOf(m, {1e6,1e6}) === 0` probe
 * could not do, so an operator who had written that row down still got the warning. And the
 * refusal is at the CALL, not at boot: `openWorkspace` runs for `gates`, `approve`, `trace` and
 * `replay` too, and a pricing row nobody has written yet must not stop a human answering a gate
 * on a run already in flight.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelWarnings, readModels } from "../../src/cli.ts";
import { isLoomError } from "../../src/errors.ts";
import type { ModelRequest } from "../../src/run/registry.ts";

const made: string[] = [];
test.after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function modelsFile(prices?: Record<string, { input: number; output: number }>): string {
  const d = mkdtempSync(join(tmpdir(), "loom-unpriced-"));
  made.push(d);
  mkdirSync(d, { recursive: true });
  const p = join(d, "models.json");
  writeFileSync(
    p,
    JSON.stringify({
      adapters: [
        {
          provider: "openai",
          name: "local",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: null,
          ...(prices === undefined ? {} : { prices }),
        },
      ],
      routes: {
        priced: { adapter: "local", model: "gpt-5" },
        free: { adapter: "local", model: "nobody-prices-me" },
      },
    }),
  );
  return p;
}

const REQ = (model: string): ModelRequest => ({ model, system: "s", messages: [{ role: "user", content: "hi" }], tools: [] });

test("AN UNPRICED ROUTE REFUSES AT THE RESERVATION, one line before the socket", () => {
  const cfg = readModels(modelsFile(), {});
  assert.deepEqual([...cfg.unpriced], ["free → local/nobody-prices-me"]);

  // `#runAgent` calls `estimateOf` to reserve budget, then `stream`. Both doors, because a
  // bound that holds on one verb and not the other is not a bound.
  for (const call of [
    () => cfg.adapter.estimateOf(REQ("free")),
    () => cfg.adapter.stream(REQ("free"), new AbortController().signal),
    () => cfg.adapter.priceOf("free", { inputTokens: 1, outputTokens: 1 }),
  ]) {
    assert.throws(call, (e: unknown) => isLoomError(e) && e.code === "E_CONFIG_INVALID" && /which no price table prices/.test(e.message));
  }
});

test("THE ORDINARY HALF: a priced route is untouched, and still prices", () => {
  const cfg = readModels(modelsFile(), {});
  // `gpt-5` is in the adapter's own default table, so nothing here had to be configured.
  assert.ok(cfg.adapter.priceOf("priced", { inputTokens: 1e6, outputTokens: 1e6 }) > 0);
  assert.ok(cfg.adapter.estimateOf(REQ("priced")) > 0);
  assert.equal(cfg.adapter.hasPrice?.("priced"), true);
  assert.equal(cfg.adapter.hasPrice?.("free"), false);
});

test("AN EXPLICIT ZERO ROW IS A RATE, NOT A MISSING ONE — the escape the old probe could not see", () => {
  const cfg = readModels(modelsFile({ "nobody-prices-me": { input: 0, output: 0 } }), {});
  assert.deepEqual([...cfg.unpriced], [], "the operator wrote the rate down, so nothing is unpriced");
  assert.equal(cfg.adapter.priceOf("free", { inputTokens: 1e6, outputTokens: 1e6 }), 0, "…and it really is free");
  assert.equal(cfg.adapter.hasPrice?.("free"), true);
  assert.doesNotMatch(modelWarnings(cfg, "run").join(""), /NO PRICE FOR/, "no price banner either — a rate is not a hole");
});

test("A ROW FOR THE DATED BASE COVERS ITS VARIANT, because `resolvePrice` is what decides", () => {
  // `pricedFor` reads the operator's table through the same `resolvePrice` the adapters use, so
  // it cannot disagree with them about which rows cover which model ids. A rule that re-derived
  // the match would be a second answer to one question.
  const d = mkdtempSync(join(tmpdir(), "loom-unpriced-dated-"));
  made.push(d);
  const p = join(d, "models.json");
  writeFileSync(
    p,
    JSON.stringify({
      adapters: [{ provider: "openai", name: "local", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: null, prices: { "m-pro": { input: 1, output: 2 } } }],
      routes: { dated: { adapter: "local", model: "m-pro-20260101" } },
    }),
  );
  const cfg = readModels(p, {});
  assert.deepEqual([...cfg.unpriced], []);
  assert.ok(cfg.adapter.priceOf("dated", { inputTokens: 1e6, outputTokens: 0 }) > 0);
});

test("A FALLBACK TIER THAT NOBODY PRICES IS A WARNING, NOT A REFUSAL, and the line says which", () => {
  // The primary tier is what `RoutingAdapter` resolves and prices; a chain's later tiers are
  // priced inside `FallbackAdapter`, which this class never sees. Refusing the whole route
  // because tier 2 is unpriced would refuse a configuration that is correct until it falls
  // through, so the honest split is: refuse what this file can decide, warn about the rest.
  const d = mkdtempSync(join(tmpdir(), "loom-unpriced-chain-"));
  made.push(d);
  const p = join(d, "models.json");
  writeFileSync(
    p,
    JSON.stringify({
      adapters: [{ provider: "openai", name: "local", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: null }],
      routes: { chain: { adapter: "local", model: "gpt-5", fallback: [{ adapter: "local", model: "nobody-prices-me" }] } },
    }),
  );
  const cfg = readModels(p, {});
  assert.deepEqual([...cfg.unpriced], ["chain → local/nobody-prices-me"], "the tier is named");
  assert.ok(cfg.adapter.estimateOf(REQ("chain")) > 0, "…and the priced primary still runs");
  assert.match(modelWarnings(cfg, "run").join(""), /A FALLBACK tier listed here refuses only if the chain falls through/);
});
