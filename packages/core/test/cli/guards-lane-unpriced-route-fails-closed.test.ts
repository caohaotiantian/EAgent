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

/**
 * A helper that writes BOTH tables, because the two defects below are about their interaction.
 * `adapterPrices` goes on the adapter row, `routeFree` on the `free` route row.
 */
function twoTables(
  adapterPrices: Record<string, { input: number; output: number }> | undefined,
  routePrices: Record<string, { input: number; output: number }> | undefined,
): string {
  const d = mkdtempSync(join(tmpdir(), "loom-unpriced-two-"));
  made.push(d);
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
          ...(adapterPrices === undefined ? {} : { prices: adapterPrices }),
        },
      ],
      routes: {
        priced: { adapter: "local", model: "gpt-5" },
        free: { adapter: "local", model: "nobody-prices-me", ...(routePrices === undefined ? {} : { prices: routePrices }) },
      },
    }),
  );
  return p;
}

/**
 * AN ADAPTER ROW THAT PRICES SOMETHING ELSE MUST NOT MASK THE ROUTE ROW.
 *
 * `pricedFor` was handed `declaredPrices.get(adapter) ?? routePrices.get(key)`, and `??` falls
 * through only when the adapter row has NO `prices` AT ALL. So an adapter row pricing model A
 * hid a route row declaring model B free, the route landed in `unpriced`, and the refusal told
 * the operator to add prices "to this ROUTE row" — the row they had already written. Measured
 * at ce14397: `cfg.unpriced === ["free → local/nobody-prices-me"]`.
 *
 * `resolvePrice` has always taken a LIST of tables in precedence order; passing it one was the
 * whole defect. Route first, because it is the more specific statement.
 */
test("AN ADAPTER `prices` ROW FOR ANOTHER MODEL DOES NOT MASK THE ROUTE'S OWN ROW", () => {
  const cfg = readModels(twoTables({ "some-other-model": { input: 1, output: 2 } }, { "nobody-prices-me": { input: 0, output: 0 } }), {});
  assert.deepEqual([...cfg.unpriced], [], "the route row says free and nothing may hide it");
  assert.equal(cfg.adapter.hasPrice?.("free"), true);
  assert.doesNotMatch(modelWarnings(cfg, "run").join(""), /NO PRICE FOR/);
  // The control that makes it mean something: with the SAME adapter row and no route row, the
  // route is still unpriced — so the assertion above is about the route row and not about the
  // adapter row having become total.
  const without = readModels(twoTables({ "some-other-model": { input: 1, output: 2 } }, undefined), {});
  assert.deepEqual([...without.unpriced], ["free → local/nobody-prices-me"]);
});

/**
 * A NON-ZERO ROUTE PRICE IS A ONE-LINE OFF SWITCH FOR THE GUARD IT ESCAPES, so it is refused.
 *
 * The route row is read by `pricedFor` and by nothing else: `RoutingAdapter.priceOf` delegates
 * to the adapter behind the route, and the cost a turn is billed comes off THAT adapter's own
 * `done` frame. Measured at ce14397 with `"prices": {"nobody-prices-me": {"input": 5, "output":
 * 15}}` on the route row:
 *
 *     cfg.unpriced                                              → []          (guard cleared)
 *     cfg.adapter.priceOf("free", {1e6, 1e6})                   → 0           (still free)
 *     cfg.adapter.estimateOf(REQ("free"))                       → 0           (still free)
 *
 * — the banner gone, the refusal gone, and every call still journaled as costing 0, which is
 * the exact hole this whole change exists to close. Zero is the one rate the row can state
 * truthfully; a real rate belongs on the adapter row or in the adapter's own `priceOf` behind
 * `hasPrice`, and the refusal names both.
 */
test("A NON-ZERO ROUTE PRICE IS REFUSED, because it would silence the guard and bill nothing", () => {
  assert.throws(
    () => readModels(twoTables(undefined, { "nobody-prices-me": { input: 5, output: 15 } }), {}),
    (e: unknown) =>
      isLoomError(e) &&
      e.code === "E_CONFIG_INVALID" &&
      /a ROUTE price row may only declare a FREE endpoint/.test(e.message) &&
      /A REAL RATE HAS TWO DOORS/.test(e.message),
  );
});

test("…including a row that is free in one direction only", () => {
  for (const row of [
    { input: 0, output: 15 },
    { input: 5, output: 0 },
  ]) {
    assert.throws(
      () => readModels(twoTables(undefined, { "nobody-prices-me": row }), {}),
      (e: unknown) => isLoomError(e) && /may only declare a FREE endpoint/.test(e.message),
    );
  }
});

test("THE ORDINARY HALF: the zero row this refusal is shaped around still boots and still clears the guard", () => {
  const cfg = readModels(twoTables(undefined, { "nobody-prices-me": { input: 0, output: 0 } }), {});
  assert.deepEqual([...cfg.unpriced], []);
  assert.equal(cfg.adapter.priceOf("free", { inputTokens: 1e6, outputTokens: 1e6 }), 0);
  // …and the adapter row's non-zero prices are untouched by any of this: only the ROUTE row is
  // restricted, because only the ROUTE row fails to reach the thing that bills.
  const priced = readModels(twoTables({ "nobody-prices-me": { input: 5, output: 15 } }, undefined), {});
  assert.deepEqual([...priced.unpriced], []);
  assert.ok(priced.adapter.priceOf("free", { inputTokens: 1e6, outputTokens: 1e6 }) > 0, "an ADAPTER row does reach the adapter");
});

/**
 * AN ADAPTER'S `false` IS NOT FINAL, because it made the operator's own escape hatch inert.
 *
 * `pricedFor` read `if (own !== undefined) return own`, so BOTH booleans short-circuited. An
 * extension adapter that honestly answers "I cannot price this model" therefore beat an
 * explicit `{"input": 0, "output": 0}` the operator had written on the route row — and the
 * refusal that followed instructed them to write exactly that row. Measured at 72510cd:
 *
 *     unpriced = [ 'local → freelocal/llama-local' ]
 *     estimateOf THREW: … which no price table prices … As the operator: add
 *       "prices": {"llama-local": {"input": 0, "output": 0}} to this ROUTE row …
 *
 * — a refusal whose only remedy was a third party editing their module. The two sources answer
 * different questions: the adapter says what its own table holds, the operator says what the
 * endpoint charges. `false` falls through to the tables now and is decisive only when nobody
 * wrote one — and it stays decisive over the PROBE, which is the fail-closed direction.
 */
const FREE_EXT = {
  provider: "freelocal",
  stream: (): AsyncIterable<never> => ({ [Symbol.asyncIterator]: async function* () {} }) as AsyncIterable<never>,
  priceOf: () => 0,
  estimateOf: () => 0,
  outputCeilingOf: () => 1024,
};

/** A `--models-file` with one route onto a PRE-REGISTERED extension adapter, as argv supplies it. */
function readExt(hasPrice: (() => boolean) | undefined, routePrices: Record<string, { input: number; output: number }> | undefined) {
  const d = mkdtempSync(join(tmpdir(), "loom-unpriced-extfalse-"));
  made.push(d);
  const p = join(d, "models.json");
  writeFileSync(
    p,
    JSON.stringify({
      routes: { local: { adapter: "freelocal", model: "llama-local", ...(routePrices === undefined ? {} : { prices: routePrices }) } },
    }),
  );
  const adapter = hasPrice === undefined ? FREE_EXT : { ...FREE_EXT, hasPrice };
  return readModels(p, {}, undefined, new Map([["freelocal", adapter as never]]));
}

test("AN ADAPTER'S `hasPrice` false DOES NOT OVERRIDE AN OPERATOR'S OWN ZERO ROW", () => {
  const cfg = readExt(() => false, { "llama-local": { input: 0, output: 0 } });
  assert.deepEqual([...cfg.unpriced], [], "the operator wrote the rate down; the adapter only said its table lacks one");
  assert.equal(cfg.adapter.estimateOf(REQ("local")), 0, "…and the route runs rather than refusing");
});

test("…but with NO row written, `hasPrice` false still refuses — it beats the probe, which is fail-closed", () => {
  // The probe alone would answer "priced" only for a non-zero price, and this adapter prices 0,
  // so the probe says unpriced too. The case that matters is that `false` is BELIEVED rather
  // than being softened into "ask the probe": it is the only source that knows the probe cannot
  // tell a free endpoint from a missing row.
  const cfg = readExt(() => false, undefined);
  assert.deepEqual([...cfg.unpriced], ["local → freelocal/llama-local"]);
  assert.throws(() => cfg.adapter.estimateOf(REQ("local")), (e: unknown) => isLoomError(e) && /no price table prices/.test(e.message));
});

test("…and `hasPrice` true is still final, with or without a row — the control", () => {
  assert.deepEqual([...readExt(() => true, undefined).unpriced], []);
  assert.deepEqual([...readExt(() => true, { "llama-local": { input: 0, output: 0 } }).unpriced], []);
});
