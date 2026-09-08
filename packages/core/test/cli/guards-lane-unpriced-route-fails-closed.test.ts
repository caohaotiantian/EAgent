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
  // THE BANNER USED TO CLAIM THE TIER REFUSES ON FALL-THROUGH. It does not — `FallbackAdapter`
  // prices it and this file never sees it — so the line said a guard existed where none does,
  // which is worse than the silence it replaced. It now says the line IS the guard for a tier.
  assert.match(modelWarnings(cfg, "run").join(""), /A FALLBACK tier listed here is NOT refused/);
  assert.doesNotMatch(modelWarnings(cfg, "run").join(""), /refuses only if the chain falls through/);
});

test("AN EXTENSION ADAPTER PRICES ITSELF ON THE ROUTE ROW — the fix the refusal names must exist", () => {
  // THE REFUSAL TOLD OPERATORS TO DO SOMETHING IMPOSSIBLE. Its fix was "add `prices` to that
  // adapter's row", and a third-wire `--extension-module` adapter HAS no adapter row: `provider`
  // accepts only `anthropic`/`openai`, and a row whose `name` matches a registered extension
  // adapter is refused so one of the two would never be reachable. So every extension adapter
  // that legitimately prices at 0 — the population README's "a provider on ANY OTHER wire" row
  // exists for — became unrunnable, in the same change that claims to WIDEN that seam.
  const free = {
    provider: "freelocal",
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    stream: (): AsyncIterable<never> => ({ [Symbol.asyncIterator]: async function* () {} }) as AsyncIterable<never>,
    priceOf: () => 0,
    estimateOf: () => 0,
    outputCeilingOf: () => 1024,
  };
  const d = mkdtempSync(join(tmpdir(), "loom-unpriced-ext-"));
  made.push(d);
  const p = join(d, "models.json");
  writeFileSync(
    p,
    JSON.stringify({
      routes: { local: { adapter: "freelocal", model: "llama-local", prices: { "llama-local": { input: 0, output: 0 } } } },
    }),
  );
  const cfg = readModels(p, {}, undefined, new Map([["freelocal", free as never]]));
  assert.deepEqual([...cfg.unpriced], [], "the operator wrote the rate on the row they actually have");
  assert.equal(cfg.adapter.estimateOf(REQ("local")), 0, "…and the call is not refused");
});

test("…and without that row it still refuses, naming BOTH doors", () => {
  const free = {
    provider: "freelocal",
    stream: (): AsyncIterable<never> => ({ [Symbol.asyncIterator]: async function* () {} }) as AsyncIterable<never>,
    priceOf: () => 0,
    estimateOf: () => 0,
    outputCeilingOf: () => 1024,
  };
  const d = mkdtempSync(join(tmpdir(), "loom-unpriced-ext2-"));
  made.push(d);
  const p = join(d, "models.json");
  writeFileSync(p, JSON.stringify({ routes: { local: { adapter: "freelocal", model: "llama-local" } } }));
  const cfg = readModels(p, {}, undefined, new Map([["freelocal", free as never]]));
  assert.deepEqual([...cfg.unpriced], ["local → freelocal/llama-local"]);
  assert.throws(
    () => cfg.adapter.estimateOf(REQ("local")),
    (e: unknown) => isLoomError(e) && /this ROUTE row/.test(e.message) && /ModelAdapter\.hasPrice/.test(e.message),
  );
});

test("AN ADAPTER THAT ANSWERS `hasPrice` IS BELIEVED, which is the module author's own door", () => {
  const free = {
    provider: "freelocal",
    stream: (): AsyncIterable<never> => ({ [Symbol.asyncIterator]: async function* () {} }) as AsyncIterable<never>,
    priceOf: () => 0,
    estimateOf: () => 0,
    outputCeilingOf: () => 1024,
    hasPrice: () => true,
  };
  const d = mkdtempSync(join(tmpdir(), "loom-unpriced-ext3-"));
  made.push(d);
  const p = join(d, "models.json");
  writeFileSync(p, JSON.stringify({ routes: { local: { adapter: "freelocal", model: "llama-local" } } }));
  const cfg = readModels(p, {}, undefined, new Map([["freelocal", free as never]]));
  assert.deepEqual([...cfg.unpriced], [], "the only answer that cannot be wrong is the adapter's own");
  assert.equal(cfg.adapter.estimateOf(REQ("local")), 0);
});
