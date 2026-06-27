/**
 * Offline tests for the `budget-cap` USD spend-ceiling enforcer.
 *
 * `budget-cap` is a pure hook+event consumer: it prices the tokens the provider
 * reports into USD (reusing `cost`'s pure helpers) and trips a two-tier ladder —
 * a soft steer at `softFraction`·cap, a hard trip at the cap that blocks paid
 * tool calls (`mode=block`) or aborts the run (`mode=stop`).
 *
 * Everything runs against the deterministic MockProvider through the shared
 * harness, so there is no network and no API key. Critically, MockProvider usage
 * is NOT scriptable: it is computed as `ceil(len/4)` over the system prompt, the
 * history, and the turn's output text. So these tests never hard-code a dollar
 * bill — they capture the actual `usage` events off the bus and DERIVE every
 * threshold from those real counts times an injected `mock` price-card row. Under
 * the default $0 fallback the cap provably cannot trip, so each enforcement test
 * first seeds a non-zero `mock` rate via the `/budget-cap pricecard` setter.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import activate, { assess, bindingCap, softBinding, type BudgetConfig } from "../src/extensions/budget-cap.js";
import { costOf, priceRow, DEFAULT_PRICE_CARD, type PriceCard } from "../src/extensions/cost.js";
import { defineTool } from "../src/kernel/define.js";
import type { Logger, Message, ToolResultBlock, Usage } from "../src/kernel/types.js";
import type { MockResponder } from "../src/providers/mock.js";
import { makeHarness } from "./helpers.js";

// ---------------------------------------------------------------------------
// shared test helpers
// ---------------------------------------------------------------------------

/** Run a command and capture its printed lines. */
async function runCommand(h: ReturnType<typeof makeHarness>, name: string, args = ""): Promise<string[]> {
  const out: string[] = [];
  const cmd = h.commands.get(name);
  assert.ok(cmd, `command ${name} should be registered`);
  await cmd.run({ agent: h.agent, args, print: (l) => out.push(l) });
  return out;
}

/** Capture `usage` events off the bus; attach BEFORE the run. */
function captureUsage(h: ReturnType<typeof makeHarness>): {
  events: { usage: Usage; cumulative: Usage }[];
} {
  const events: { usage: Usage; cumulative: Usage }[] = [];
  h.agent.hooks.on("usage", (p) => {
    events.push({ usage: { ...p.usage }, cumulative: { ...p.cumulative } });
  });
  return { events };
}

/** A logger whose `warn` calls are captured. */
function capturingLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    logger: { debug: () => {}, info: () => {}, warn: (...a: unknown[]) => warns.push(a.map(String).join(" ")), error: () => {} },
  };
}

/** Every `role:"tool"` result block in the transcript. */
function toolResults(messages: readonly Message[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) if (b.type === "tool_result") out.push(b);
  }
  return out;
}

/** All text from `user`-role messages (where a drained steer lands). */
function userTexts(messages: readonly Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) if (b.type === "text") out.push(b.text);
  }
  return out;
}

/** A stub tool that counts invocations. */
function stub(): { tool: ReturnType<typeof defineTool>; calls: () => number } {
  let count = 0;
  const tool = defineTool({
    name: "probe",
    description: "test stub",
    parameters: { type: "object", properties: {} },
    execute: () => {
      count += 1;
      return { content: "ok" };
    },
  });
  return { tool, calls: () => count };
}

/** A `mock`-priced card override at the given per-MTok rates. */
function mockCard(inRate: number, outRate: number): PriceCard {
  return { ...DEFAULT_PRICE_CARD, mock: { inputPerMTok: inRate, outputPerMTok: outRate } };
}

/** A responder that emits a `probe` tool call for the first `n` turns, then text. */
function toolResponder(n: number): MockResponder {
  return (_req, i) => (i < n ? { toolCalls: [{ name: "probe", id: `c${i}` }] } : { text: "done" });
}

/**
 * Probe a fresh harness for the cumulative per-run USD after each `usage` event,
 * priced at the given mock rates. `out[k]` is `runUsd` after event `k` — i.e. the
 * running sum of `costOf(event.usage, row)`, exactly how the extension accumulates
 * `runUsd` from per-event deltas. Returns thresholds the live tests derive caps
 * from, so nothing is magic-numbered.
 */
async function probeRunUsd(responder: MockResponder, inRate: number, outRate: number): Promise<number[]> {
  const h = makeHarness({ responder, fallback: "allow" });
  h.agent.tools.register(stub().tool);
  const cap = captureUsage(h);
  await h.agent.run("go");
  const row = priceRow("mock", mockCard(inRate, outRate));
  let acc = 0;
  return cap.events.map((ev) => (acc += costOf(ev.usage, row)));
}

/** Parse the `$` figure out of a `key=$X.YYYY` status line. */
function parseUsdField(lines: string[], key: string): number {
  const line = lines.find((l) => l.startsWith(`${key}=`));
  assert.ok(line, `expected a ${key}= line in:\n${lines.join("\n")}`);
  const m = line.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  assert.ok(m, `expected a $ figure in line: ${line}`);
  return Number(m[1]);
}

const CFG = (over: Partial<BudgetConfig> = {}): BudgetConfig => ({
  enabled: true,
  mode: "block",
  runMaxUsd: 0,
  sessionMaxUsd: 0,
  softFraction: 0.8,
  ...over,
});

// ---------------------------------------------------------------------------
// 1 — the pure ladder predicate `assess`
// ---------------------------------------------------------------------------

test("assess: disabled caps (0) never trip regardless of spend", () => {
  assert.equal(assess(1e9, 1e9, CFG({ runMaxUsd: 0, sessionMaxUsd: 0 })), "ok");
});

test("assess: an enabled run OR session cap trips independently; boundary = hard", () => {
  // run cap only
  assert.equal(assess(5, 0, CFG({ runMaxUsd: 10 })), "ok");
  assert.equal(assess(10, 0, CFG({ runMaxUsd: 10 })), "hard", "exactly at the cap is hard");
  assert.equal(assess(11, 0, CFG({ runMaxUsd: 10 })), "hard");
  // session cap only (independent)
  assert.equal(assess(0, 10, CFG({ sessionMaxUsd: 10 })), "hard");
  assert.equal(assess(0, 9.9999, CFG({ sessionMaxUsd: 10 })), "soft");
});

test("assess: the [softFraction*cap, cap) band returns soft; exactly at the fraction is soft", () => {
  const cfg = CFG({ runMaxUsd: 10, softFraction: 0.8 });
  assert.equal(assess(7.99, 0, cfg), "ok", "below the band");
  assert.equal(assess(8, 0, cfg), "soft", "exactly at softFraction*cap");
  assert.equal(assess(9.5, 0, cfg), "soft");
  assert.equal(assess(10, 0, cfg), "hard", "the cap itself is hard, not soft");
});

test("bindingCap: reports the hard-exceeded cap, preferring run, else undefined", () => {
  assert.equal(bindingCap(0, 0, CFG({ runMaxUsd: 10 })), undefined);
  assert.deepEqual(bindingCap(10, 0, CFG({ runMaxUsd: 10 })), { which: "run", spend: 10, cap: 10 });
  assert.deepEqual(bindingCap(0, 12, CFG({ sessionMaxUsd: 12 })), { which: "session", spend: 12, cap: 12 });
});

test("softBinding: frames the cap actually in its soft band, not unconditionally run", () => {
  // run cap enabled but far from its band; session cap IS in its soft band —
  // the soft-warn must report the session figures, the bug the review caught.
  const cfg = CFG({ runMaxUsd: 100, sessionMaxUsd: 10, softFraction: 0.8 });
  assert.deepEqual(softBinding(1, 9, cfg), { which: "session", spend: 9, cap: 10 });
  // run in its own band → run preferred.
  assert.deepEqual(softBinding(85, 1, cfg), { which: "run", spend: 85, cap: 100 });
  // neither in band → undefined.
  assert.equal(softBinding(1, 1, cfg), undefined);
});

// ---------------------------------------------------------------------------
// 2 — pricing reuse: USD is derived from the captured usage, never hard-coded
// ---------------------------------------------------------------------------

test("pricing reuse: costOf over the captured usage matches the manual formula", async () => {
  const h = makeHarness({ responder: [{ text: "Z".repeat(400) }] });
  const cap = captureUsage(h);
  await h.agent.run("hi");
  const ev = cap.events.at(-1);
  assert.ok(ev, "at least one usage event");
  const row = priceRow("mock", mockCard(2, 6));
  const expected = (ev.cumulative.inputTokens / 1e6) * 2 + (ev.cumulative.outputTokens / 1e6) * 6;
  assert.equal(costOf(ev.cumulative, row), expected);
  assert.ok(Number.isFinite(costOf(ev.cumulative, row)) && expected > 0);
});

// ---------------------------------------------------------------------------
// 2b — budget-cap budgets on a cache-aware USD cost, not raw tokens (P0.2 task 7)
// ---------------------------------------------------------------------------

test("budget-cap inherits cache-aware spend: caps are USD (costOf), so a cached turn costs less", () => {
  // budget-cap computes runUsd/sessionUsd via `costOf(p.usage|cumulative, row)`
  // (budget-cap.ts:260-261) and feeds those USD figures to `assess`. costOf is now
  // cache-aware, so the SAME tokens billed as cache-read cost strictly less — and
  // the ladder (which budgets on USD, never a token count) inherits that for free.
  const row = priceRow("claude-fable-5");
  const N = 2_000_000;
  const freshUsd = costOf({ inputTokens: N, outputTokens: 0 }, row);
  const cachedUsd = costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: N }, row);
  assert.ok(cachedUsd > 0, "cache-read tokens are priced (not ignored) in the USD figure budget-cap budgets on");
  assert.ok(cachedUsd < freshUsd, "the USD figure budget-cap budgets on is cache-aware");

  // A cap placed between the two: fresh-input spend trips hard, the cheaper
  // cache-read spend of the identical token count stays under the cap.
  const cfg = CFG({ runMaxUsd: (cachedUsd + freshUsd) / 2 });
  assert.equal(assess(freshUsd, 0, cfg), "hard", "fresh-input spend exceeds the cap");
  assert.equal(assess(cachedUsd, 0, cfg), "ok", "the same tokens as cache-read stay under the cap");
});

// ---------------------------------------------------------------------------
// 3 — live block: the post-cap tool call is vetoed; the pre-cap one ran
// ---------------------------------------------------------------------------

test("mode=block: the call after the cap crosses is blocked; the pre-cap call ran", async () => {
  const responder = toolResponder(3);
  // Probe the per-event runUsd at a non-zero mock rate, then place the cap
  // strictly between the first and second event so turn 1 runs and turn 2 trips.
  const r = await probeRunUsd(responder, 1000, 1000);
  assert.ok(r.length >= 2 && r[0]! < r[1]!, "probe yields two strictly-increasing thresholds");
  const cap = (r[0]! + r[1]!) / 2;

  const h = makeHarness({ responder, fallback: "allow" });
  const s = stub();
  h.agent.tools.register(s.tool);
  await h.host.use("budget-cap", activate);
  await runCommand(h, "budget-cap", "pricecard mock 1000 1000");
  await runCommand(h, "budget-cap", "mode=block");
  await runCommand(h, "budget-cap", `run=${cap}`);

  await h.agent.run("go");

  assert.equal(s.calls(), 1, "only the pre-cap (turn 1) call ran");
  const blocked = toolResults(h.agent.messages).find((rr) => rr.toolCallId === "c1");
  assert.ok(blocked, "the post-cap call produced a tool_result");
  assert.equal(blocked.isError, true, "the post-cap call is an error result");
  assert.ok(
    blocked.content.includes("budget-cap:") && blocked.content.includes("budget"),
    `expected a budget reason, got: ${blocked.content}`,
  );
});

// ---------------------------------------------------------------------------
// 4 — live stop: the run ends earlier than an uncapped baseline
// ---------------------------------------------------------------------------

test("mode=stop: e.agent.stop() ends the run with strictly fewer tool calls than uncapped", async () => {
  const responder = toolResponder(3);

  // Baseline: no budget-cap — every scripted tool call runs.
  const base = makeHarness({ responder, fallback: "allow" });
  const baseStub = stub();
  base.agent.tools.register(baseStub.tool);
  await base.agent.run("go");
  const baselineCalls = baseStub.calls();
  assert.ok(baselineCalls >= 2, "baseline runs several tool calls");

  // Capped: a cap below the first-turn spend trips stop() on event 0.
  const r = await probeRunUsd(responder, 1000, 1000);
  const cap = r[0]! / 2;

  const h = makeHarness({ responder, fallback: "allow" });
  const s = stub();
  h.agent.tools.register(s.tool);
  await h.host.use("budget-cap", activate);
  await runCommand(h, "budget-cap", "pricecard mock 1000 1000");
  await runCommand(h, "budget-cap", "mode=stop");
  await runCommand(h, "budget-cap", `run=${cap}`);

  const result = await h.agent.run("go");

  assert.ok(s.calls() < baselineCalls, `stop ran fewer calls (${s.calls()}) than baseline (${baselineCalls})`);
  assert.equal(result.reason, "stop", "the run aborted via stop()");
});

// ---------------------------------------------------------------------------
// 5 — soft warn: a steer + warn fire, nothing is blocked
// ---------------------------------------------------------------------------

test("soft band: a user-role steer mentioning the budget fires and nothing is blocked", async () => {
  const responder = toolResponder(1); // one tool turn, then text
  const r = await probeRunUsd(responder, 1000, 1000);
  // Place the cap so the first event's spend lands in [0.8*cap, cap): cap = r0/0.9.
  const cap = r[0]! / 0.9;

  const { logger, warns } = capturingLogger();
  const h = makeHarness({ responder, fallback: "allow", logger });
  const s = stub();
  h.agent.tools.register(s.tool);
  await h.host.use("budget-cap", activate);
  await runCommand(h, "budget-cap", "pricecard mock 1000 1000");
  await runCommand(h, "budget-cap", "mode=warn");
  await runCommand(h, "budget-cap", `run=${cap}`);

  await h.agent.run("go");

  const steer = userTexts(h.agent.messages).find((t) => t.includes("budget"));
  assert.ok(steer, "a budget steer message reached the transcript");
  assert.ok(warns.some((w) => /budget-cap.*soft|soft warning/i.test(w)), "a soft warn was logged");
  // Nothing was blocked: no budget error result.
  const blocked = toolResults(h.agent.messages).filter((rr) => rr.content.includes("budget-cap:"));
  assert.equal(blocked.length, 0, "soft band never blocks a tool call");
  assert.ok(s.calls() >= 1, "the tool still ran in the soft band");
});

// ---------------------------------------------------------------------------
// 6 — disabled / kill switch
// ---------------------------------------------------------------------------

test("disabled by default: both caps 0 → no block across a multi-turn run", async () => {
  const responder = toolResponder(4);
  const h = makeHarness({ responder, fallback: "allow" });
  const s = stub();
  h.agent.tools.register(s.tool);
  await h.host.use("budget-cap", activate);
  // Seed a non-zero rate but leave both caps at their 0 default.
  await runCommand(h, "budget-cap", "pricecard mock 1000 1000");

  await h.agent.run("go");

  assert.equal(s.calls(), 4, "every call ran with caps disabled");
  const blocked = toolResults(h.agent.messages).filter((rr) => rr.content.includes("budget-cap:"));
  assert.equal(blocked.length, 0, "nothing blocked while inert");
});

test("EAGENT_BUDGET_CAP=off makes activation a no-op: /budget-cap is not registered", async () => {
  const prev = process.env.EAGENT_BUDGET_CAP;
  process.env.EAGENT_BUDGET_CAP = "off";
  try {
    const h = makeHarness({ responder: toolResponder(3), fallback: "allow" });
    const s = stub();
    h.agent.tools.register(s.tool);
    await h.host.use("budget-cap", activate);

    assert.equal(h.commands.get("budget-cap"), undefined, "kill switch: /budget-cap must not be registered");

    await h.agent.run("go");
    assert.equal(s.calls(), 3, "all calls ran under the kill switch");
    const blocked = toolResults(h.agent.messages).filter((rr) => rr.content.includes("budget-cap:"));
    assert.equal(blocked.length, 0, "no block under the kill switch");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_BUDGET_CAP;
    else process.env.EAGENT_BUDGET_CAP = prev;
  }
});

// ---------------------------------------------------------------------------
// 7 — command round-trips and input validation
// ---------------------------------------------------------------------------

test("/budget-cap: setters persist; invalid inputs are rejected and leave the prior value intact", async () => {
  const h = makeHarness({ responder: [{ text: "hi" }] });
  await h.host.use("budget-cap", activate);

  await runCommand(h, "budget-cap", "run=2.5");
  assert.ok(
    (await runCommand(h, "budget-cap", "status")).some((l) => l === "runMaxUsd=2.5"),
    "run=2.5 persisted",
  );

  await runCommand(h, "budget-cap", "mode=stop");
  assert.ok((await runCommand(h, "budget-cap", "status")).some((l) => l === "mode=stop"), "mode=stop persisted");

  // Invalid inputs: each prints a message and leaves the value unchanged.
  const rejNeg = await runCommand(h, "budget-cap", "run=-1");
  assert.ok(rejNeg.join("\n").length > 0, "negative run prints a rejection");
  const rejNan = await runCommand(h, "budget-cap", "run=abc");
  assert.ok(rejNan.join("\n").length > 0, "non-numeric run prints a rejection");
  assert.ok(
    (await runCommand(h, "budget-cap", "status")).some((l) => l === "runMaxUsd=2.5"),
    "runMaxUsd unchanged after rejected values",
  );

  const rejSoft = await runCommand(h, "budget-cap", "soft=2");
  assert.ok(rejSoft.join("\n").length > 0, "out-of-range soft prints a rejection");
  assert.ok(
    (await runCommand(h, "budget-cap", "status")).some((l) => l === "softFraction=0.8"),
    "softFraction unchanged after a rejected value",
  );
});

// ---------------------------------------------------------------------------
// 8 — run-reset vs session-persist across two runs
// ---------------------------------------------------------------------------

test("runUsd resets each run while sessionUsd reflects the cumulative of both", async () => {
  // Two text-only runs of different lengths → different per-run spend.
  const responder: MockResponder = (_req, i) => ({ text: "A".repeat(i === 0 ? 200 : 600) });
  const h = makeHarness({ responder });
  const capUsage = captureUsage(h);
  await h.host.use("budget-cap", activate);
  await runCommand(h, "budget-cap", "pricecard mock 1000 1000");

  await h.agent.run("one");
  await h.agent.run("two");

  const row = priceRow("mock", mockCard(1000, 1000));
  const ev2 = capUsage.events.at(-1);
  assert.ok(ev2 && capUsage.events.length === 2, "two usage events, one per run");
  const expectedRunUsd = costOf(ev2.usage, row); // run 2's own delta
  const expectedSessionUsd = costOf(ev2.cumulative, row); // both runs

  const status = await runCommand(h, "budget-cap", "status");
  const runUsd = parseUsdField(status, "runUsd");
  const sessionUsd = parseUsdField(status, "sessionUsd");

  assert.ok(Math.abs(runUsd - expectedRunUsd) < 1e-6, `runUsd ${runUsd} != run-2 spend ${expectedRunUsd}`);
  assert.ok(
    Math.abs(sessionUsd - expectedSessionUsd) < 1e-6,
    `sessionUsd ${sessionUsd} != cumulative ${expectedSessionUsd}`,
  );
  assert.ok(runUsd < sessionUsd, "runUsd (run 2 only) is below the two-run cumulative");
});

// ---------------------------------------------------------------------------
// 9 — fails open on a malformed store value
// ---------------------------------------------------------------------------

test("a malformed priceCard store value does not throw and does not block", async () => {
  const responder = toolResponder(3);
  const { logger } = capturingLogger();
  const h = makeHarness({ responder, fallback: "allow", logger });
  const s = stub();
  h.agent.tools.register(s.tool);

  // Inject garbage into this extension's own store, then activate: a non-object
  // priceCard must fall back to the default card ($0 for mock), and a malformed
  // cap must fall back to disabled — so nothing trips, nothing throws.
  await h.host.use("budget-cap", (e) => {
    e.store.set("priceCard", "not-an-object");
    e.store.set("runMaxUsd", "abc");
    return activate(e);
  });

  await assert.doesNotReject(h.agent.run("go"));
  assert.equal(s.calls(), 3, "all calls ran (malformed config disabled the cap)");
  const blocked = toolResults(h.agent.messages).filter((rr) => rr.content.includes("budget-cap:"));
  assert.equal(blocked.length, 0, "no block on a malformed store value");
});

// ---------------------------------------------------------------------------
// dispose is clean and never throws
// ---------------------------------------------------------------------------

test("host.unload removes the command and hooks; nothing trips afterward", async () => {
  const h = makeHarness({ responder: toolResponder(3), fallback: "allow" });
  const s = stub();
  h.agent.tools.register(s.tool);
  await h.host.use("budget-cap", activate);
  await runCommand(h, "budget-cap", "pricecard mock 1000 1000");
  await runCommand(h, "budget-cap", "run=0.0000001");
  await runCommand(h, "budget-cap", "mode=block");

  await assert.doesNotReject(h.host.unload("budget-cap"));
  assert.equal(h.commands.get("budget-cap"), undefined, "command torn down");

  await h.agent.run("go");
  assert.equal(s.calls(), 3, "all calls ran after unload (hooks gone)");
});
