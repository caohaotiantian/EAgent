/**
 * Tests for the `evals` extension — offline trajectory assertions, the headless
 * `/eval` runner, and the LLM-judge tool.
 *
 * Everything runs offline against the scriptable MockProvider via `makeHarness`,
 * loading the extension directly with `host.use("evals", evals)` (the established
 * pattern, e.g. `test/recovery.test.ts`). Nothing depends on `BUILTIN_EXTENSIONS`.
 *
 * The pure helpers (`checkExpect`, `parseJudgeReply`, `parseEvalScenario`) are
 * exercised directly; the consumer, `/expect`, `/eval`, and the `judge` tool are
 * exercised through the agent loop so the real bus/dispatch wiring is covered.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Agent } from "../src/kernel/agent.js";
import type { CommandContext } from "../src/kernel/commands.js";
import type { ExtensionAPI } from "../src/kernel/extension.js";
import { defineTool, ok, fail } from "../src/kernel/define.js";
import { makeHarness, type Harness } from "./helpers.js";
import evals, {
  checkExpect,
  parseJudgeReply,
  parseEvalScenario,
  getTrajectory,
  type Trajectory,
  type ExpectSpec,
} from "../src/extensions/evals.js";

// -- helpers -----------------------------------------------------------------

/** Register two trivial stub tools A and B (no capabilities, return ok). */
function registerAB(agent: Agent): void {
  agent.tools.register(
    defineTool({ name: "A", description: "stub A", execute: () => ok("a-result") }),
  );
  agent.tools.register(
    defineTool({ name: "B", description: "stub B", execute: () => ok("b-result") }),
  );
}

/** Activate `evals`, capturing the ExtensionAPI for trajectory/command access. */
async function activate(h: Harness): Promise<ExtensionAPI> {
  let api!: ExtensionAPI;
  await h.host.use("evals", (e) => {
    api = e;
    return evals(e);
  });
  return api;
}

/** Run a registered command, collecting its printed lines. */
async function runCommand(h: Harness, name: string, args = ""): Promise<string[]> {
  const out: string[] = [];
  const cmd = h.commands.get(name);
  assert.ok(cmd, `command ${name} should be registered`);
  const ctx: CommandContext = { agent: h.agent, args, print: (l) => out.push(l) };
  await cmd.run(ctx);
  return out;
}

/** A trajectory literal fixture, for the pure-helper table tests. */
function traj(over: Partial<Trajectory> = {}): Trajectory {
  return {
    tools: ["A", "B"],
    spans: [
      { name: "A", ok: true },
      { name: "B", ok: true },
    ],
    finishReason: "end_turn",
    totalTokens: 100,
    ...over,
  };
}

// -- T2: trajectory build (AC1) ----------------------------------------------

test("T2: trajectory records ordered tool names, tool-span count, and finish reason", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "A" }, { name: "B" }] }, { text: "done" }],
  });
  registerAB(h.agent);
  const api = await activate(h);

  const result = await h.agent.run("go");
  const t = getTrajectory(api);
  assert.ok(t, "a trajectory was recorded");

  assert.deepEqual(t.tools, ["A", "B"]);
  assert.equal(t.spans.length, 2); // tool spans only (D2)
  assert.equal(t.spans.length, t.tools.length);
  assert.equal(t.finishReason, result.reason); // RunResult.reason
});

test("T2: agent_start resets the trajectory to keep only the last run", async () => {
  const h = makeHarness({ fallback: "allow", responder: [{ toolCalls: [{ name: "A" }] }, { text: "done" }] });
  registerAB(h.agent);
  const api = await activate(h);

  await h.agent.run("first");
  h.provider.script([{ toolCalls: [{ name: "B" }] }, { text: "done" }]);
  await h.agent.run("second");

  const t = getTrajectory(api);
  assert.deepEqual(t?.tools, ["B"], "only the most recent run's tools are kept");
});

// -- T4: checkExpect — five predicates, each pass AND fail (AC2/AC3/AC4) ------

test("T4: checkExpect tools in_order passes on a subsequence and fails on a wrong order", () => {
  const t = traj();
  assert.deepEqual(checkExpect(t, { tools: ["A", "B"], order: "in_order" }), { pass: true, reasons: [] });
  // a subsequence (not necessarily contiguous) still passes
  assert.equal(checkExpect(t, { tools: ["A"], order: "in_order" }).pass, true);
  const bad = checkExpect(t, { tools: ["B", "A"], order: "in_order" });
  assert.equal(bad.pass, false);
  assert.equal(bad.reasons.length, 1);
  assert.match(bad.reasons[0]!, /order|in_order|subsequence/i);
});

test("T4: checkExpect tools exact passes on full equality and fails on a differing list", () => {
  const t = traj();
  assert.equal(checkExpect(t, { tools: ["A", "B"], order: "exact" }).pass, true);
  const bad = checkExpect(t, { tools: ["A"], order: "exact" });
  assert.equal(bad.pass, false);
  assert.match(bad.reasons[0]!, /exact|tools/i);
});

test("T4: checkExpect maxSpans passes at/above the tool count and fails one below", () => {
  const t = traj();
  assert.equal(checkExpect(t, { maxSpans: 2 }).pass, true);
  assert.equal(checkExpect(t, { maxSpans: 3 }).pass, true);
  const bad = checkExpect(t, { maxSpans: 1 });
  assert.equal(bad.pass, false);
  assert.match(bad.reasons[0]!, /span/i);
});

test("T4: checkExpect finishReason passes on equality and fails on a mismatch", () => {
  const t = traj();
  assert.equal(checkExpect(t, { finishReason: "end_turn" }).pass, true);
  const bad = checkExpect(t, { finishReason: "stop" });
  assert.equal(bad.pass, false);
  assert.match(bad.reasons[0]!, /finish|reason/i);
});

test("T4: checkExpect noToolErrors passes when all ok and fails on an error span", () => {
  assert.equal(checkExpect(traj(), { noToolErrors: true }).pass, true);
  const withErr = traj({ spans: [{ name: "A", ok: true }, { name: "B", ok: false }] });
  const bad = checkExpect(withErr, { noToolErrors: true });
  assert.equal(bad.pass, false);
  assert.match(bad.reasons[0]!, /error/i);
});

test("T4: checkExpect maxTokens passes at/above usage and fails one below", () => {
  const t = traj({ totalTokens: 100 });
  assert.equal(checkExpect(t, { maxTokens: 100 }).pass, true);
  assert.equal(checkExpect(t, { maxTokens: 200 }).pass, true);
  const bad = checkExpect(t, { maxTokens: 99 });
  assert.equal(bad.pass, false);
  assert.match(bad.reasons[0]!, /token/i);
});

test("T4: a passing multi-field spec yields {pass:true, reasons:[]}", () => {
  const t = traj();
  const r = checkExpect(t, {
    tools: ["A", "B"],
    order: "exact",
    maxSpans: 2,
    finishReason: "end_turn",
    noToolErrors: true,
    maxTokens: 100,
  });
  assert.deepEqual(r, { pass: true, reasons: [] });
});

test("T4: an absent spec field is not checked", () => {
  // an empty spec passes anything
  assert.deepEqual(checkExpect(traj(), {}), { pass: true, reasons: [] });
});

// -- T4 live: noToolErrors catches a real failed call (AC4) ------------------

test("T4 live: a genuinely-failed tool call yields an ok:false span and fails noToolErrors", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "boom" }] }, { text: "done" }],
  });
  h.agent.tools.register(
    defineTool({ name: "boom", description: "fails", execute: () => fail("boom") }),
  );
  const api = await activate(h);

  await h.agent.run("go");
  const t = getTrajectory(api);
  assert.ok(t);
  assert.equal(t.spans.length, 1);
  assert.equal(t.spans[0]!.ok, false, "the failed call is recorded as ok:false");
  assert.equal(checkExpect(t, { noToolErrors: true }).pass, false);
});

// -- T6: /expect command (AC2) -----------------------------------------------

test("T6: /expect prints a pass line for a satisfied spec", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "A" }, { name: "B" }] }, { text: "done" }],
  });
  registerAB(h.agent);
  await activate(h);
  await h.agent.run("go");

  const out = (await runCommand(h, "expect", '{"tools":["A","B"],"order":"in_order"}')).join("\n");
  assert.match(out, /pass/i);
  assert.doesNotMatch(out, /fail/i);
});

test("T6: /expect prints the failing reason for a violated spec", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "A" }, { name: "B" }] }, { text: "done" }],
  });
  registerAB(h.agent);
  await activate(h);
  await h.agent.run("go");

  const out = (await runCommand(h, "expect", '{"tools":["B","A"],"order":"in_order"}')).join("\n");
  assert.match(out, /fail/i);
  assert.match(out, /order|in_order|subsequence/i);
});

test("T6: /expect on a malformed spec prints an error and never throws", async () => {
  const h = makeHarness({ fallback: "allow", responder: [{ text: "hi" }] });
  await activate(h);
  await h.agent.run("go");

  let out: string[] = [];
  await assert.doesNotReject(async () => {
    out = await runCommand(h, "expect", "{not json");
  });
  assert.match(out.join("\n"), /error|invalid|bad/i);
});

// -- T8: parseJudgeReply — pure, total, pinned grammar + sentinel (AC5) ------

test("T8: parseJudgeReply parses the pinned grammar", () => {
  assert.deepEqual(parseJudgeReply("SCORE 8/10 PASS clear and correct"), {
    score: 8,
    verdict: "pass",
    reason: "clear and correct",
  });
});

test("T8: parseJudgeReply is case-insensitive on SCORE and the verdict", () => {
  assert.deepEqual(parseJudgeReply("score 3/10 fail wrong answer"), {
    score: 3,
    verdict: "fail",
    reason: "wrong answer",
  });
});

test("T8: parseJudgeReply reads the first non-empty line and trims the reason", () => {
  assert.deepEqual(parseJudgeReply("\n   \nSCORE 10/10 PASS   spot on   \ntrailing junk"), {
    score: 10,
    verdict: "pass",
    reason: "spot on",
  });
});

test("T8: parseJudgeReply allows an empty reason", () => {
  assert.deepEqual(parseJudgeReply("SCORE 5/10 FAIL"), { score: 5, verdict: "fail", reason: "" });
});

test("T8: parseJudgeReply clamps the score to 0..10", () => {
  assert.equal(parseJudgeReply("SCORE 99/10 PASS over")?.score, 10);
  assert.equal(parseJudgeReply("SCORE 0/10 FAIL under")?.score, 0);
});

test("T8: parseJudgeReply returns undefined on empty/garbled/missing-shape input", () => {
  assert.equal(parseJudgeReply(""), undefined);
  assert.equal(parseJudgeReply("   "), undefined);
  assert.equal(parseJudgeReply("hello world"), undefined);
  assert.equal(parseJudgeReply("SCORE 8 PASS no fraction"), undefined);
  assert.equal(parseJudgeReply("SCORE 8/10 MAYBE bad verdict"), undefined);
  assert.equal(parseJudgeReply("8/10 PASS no score token"), undefined);
});

// -- T10: judge tool against a scripted classifier (AC6/AC7) ------------------

/** Find the model-visible tool_result content for a tool call by name. */
function judgeResult(agent: Agent): { content: string; isError?: boolean } | undefined {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i]!;
    if (m.role !== "tool") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") return { content: b.content, isError: b.isError };
    }
  }
  return undefined;
}

test("T10: judge returns {score, verdict, reason} from a scripted classifier turn (AC6)", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      { toolCalls: [{ name: "judge", arguments: { rubric: "is it correct?", candidate: "yes" } }] },
      { text: "SCORE 8/10 PASS clear and correct" }, // consumed by the judge sub-call
      { text: "done" }, // outer loop's final turn
    ],
  });
  await activate(h);

  await h.agent.run("grade it");
  const res = judgeResult(h.agent);
  assert.ok(res, "the judge produced a tool result");
  assert.notEqual(res.isError, true, "a parsed verdict is not an error result");
  assert.match(res.content, /8/);
  assert.match(res.content, /pass/i);
  assert.match(res.content, /clear and correct/);
});

test("T10: judge fails closed (isError) on an unparseable classifier reply (AC7)", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      { toolCalls: [{ name: "judge", arguments: { rubric: "is it correct?", candidate: "yes" } }] },
      { text: "garbled" }, // parseJudgeReply -> undefined
      { text: "done" },
    ],
  });
  await activate(h);

  await h.agent.run("grade it");
  const res = judgeResult(h.agent);
  assert.ok(res);
  assert.equal(res.isError, true, "an unparseable verdict becomes an error result, never a silent pass");
});

test("T10: judge is registered with executionMode sequential", async () => {
  const h = makeHarness({ fallback: "allow", responder: [{ text: "hi" }] });
  await activate(h);
  const tool = h.agent.tools.get("judge");
  assert.ok(tool, "judge is registered");
  assert.equal(tool.executionMode, "sequential", "judge must be sequential for deterministic queue consumption");
});

// -- T12: parseEvalScenario validation (AC8) ---------------------------------

test("T12: parseEvalScenario accepts a well-formed object", () => {
  const s = parseEvalScenario({
    input: "go",
    mockScript: [{ toolCalls: [{ name: "A" }] }, { text: "done" }],
    expect: { tools: ["A"], order: "in_order" },
  });
  assert.ok(s, "a valid scenario parses");
  assert.equal(s.input, "go");
  assert.equal(s.mockScript.length, 2);
  assert.deepEqual(s.expect, { tools: ["A"], order: "in_order" });
});

test("T12: parseEvalScenario rejects malformed objects without throwing", () => {
  assert.equal(parseEvalScenario(null), undefined);
  assert.equal(parseEvalScenario(42), undefined);
  assert.equal(parseEvalScenario({}), undefined, "missing input");
  assert.equal(parseEvalScenario({ input: 1, mockScript: [], expect: {} }), undefined, "non-string input");
  assert.equal(parseEvalScenario({ input: "go", mockScript: "nope", expect: {} }), undefined, "non-array mockScript");
  assert.equal(parseEvalScenario({ input: "go", mockScript: [], expect: 7 }), undefined, "non-object expect");
});

// -- T14: /eval <dir> scorecard (AC8) ----------------------------------------

test("T14: /eval over inline fixtures prints a scorecard and names the failing scenario", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-evals-"));
  try {
    // scenario 1: expect matches the mockScript's trajectory -> passes
    writeFileSync(
      join(dir, "pass.eval.json"),
      JSON.stringify({
        input: "go",
        mockScript: [{ toolCalls: [{ name: "A" }] }, { text: "done" }],
        expect: { tools: ["A"], order: "exact" },
      }),
    );
    // scenario 2: expect is violated -> fails
    writeFileSync(
      join(dir, "fail.eval.json"),
      JSON.stringify({
        input: "go",
        mockScript: [{ toolCalls: [{ name: "A" }] }, { text: "done" }],
        expect: { tools: ["B"], order: "exact" },
      }),
    );

    const h = makeHarness({ fallback: "allow", responder: [{ text: "ignored" }] });
    registerAB(h.agent);
    await activate(h);

    const out = (await runCommand(h, "eval", dir)).join("\n");
    assert.match(out, /1\/2/, "one of two scenarios passed");
    assert.match(out, /fail\.eval\.json/, "the failing scenario is named");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T14: /eval with one matching fixture prints 1/1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-evals-"));
  try {
    writeFileSync(
      join(dir, "ok.eval.json"),
      JSON.stringify({
        input: "go",
        mockScript: [{ toolCalls: [{ name: "A" }, { name: "B" }] }, { text: "done" }],
        expect: { tools: ["A", "B"], order: "exact", noToolErrors: true },
      }),
    );
    const h = makeHarness({ fallback: "allow", responder: [{ text: "ignored" }] });
    registerAB(h.agent);
    await activate(h);

    const out = (await runCommand(h, "eval", dir)).join("\n");
    assert.match(out, /1\/1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T14: /eval counts a malformed file as a failed scenario, never throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-evals-"));
  try {
    writeFileSync(join(dir, "broken.eval.json"), "{not valid json");
    writeFileSync(
      join(dir, "good.eval.json"),
      JSON.stringify({
        input: "go",
        mockScript: [{ toolCalls: [{ name: "A" }] }, { text: "done" }],
        expect: { tools: ["A"], order: "exact" },
      }),
    );
    const h = makeHarness({ fallback: "allow", responder: [{ text: "ignored" }] });
    registerAB(h.agent);
    await activate(h);

    let out: string[] = [];
    await assert.doesNotReject(async () => {
      out = await runCommand(h, "eval", dir);
    });
    assert.match(out.join("\n"), /1\/2/);
    assert.match(out.join("\n"), /broken\.eval\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- T15: defensive branches — fail-closed/early-return paths (AC7/AC8) -------
//
// These are the no-action-needed-but-untested guards the second-round review
// flagged: the judge's no-provider fail-closed path and the /eval runner's
// missing-arg, unreadable-dir, empty-dir, and no-scriptable-provider returns.
// Each is a cheap assertion that the path is reached and degrades, not throws.

/** A minimal ToolContext sufficient for the judge tool (it reads only `signal`). */
function toolCtx(h: Harness): import("../src/kernel/types.js").ToolContext {
  return {
    toolCallId: "t1",
    signal: new AbortController().signal,
    require: async () => {},
    progress: () => {},
    ui: { confirm: async () => true, notify: () => {} },
    agent: h.agent.handle,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

test("T15: judge fails closed (isError) when no provider is registered (AC7)", async () => {
  const h = makeHarness({ fallback: "allow", responder: [{ text: "hi" }] });
  await activate(h);
  const judge = h.agent.tools.get("judge");
  assert.ok(judge, "judge is registered");

  // Deregister the default provider (same key as the harness's "mock").
  h.agent.providers.register(h.provider).dispose();
  assert.equal(h.agent.providers.get(), undefined, "no provider remains");

  const res = await judge.execute({ rubric: "r", candidate: "c" }, toolCtx(h));
  assert.equal(res.isError, true, "the no-provider path fails closed, never a silent pass");
  assert.match(res.content, /no provider/i);
});

test("T15: /eval with no dir argument prints usage, never throwing", async () => {
  const h = makeHarness({ fallback: "allow", responder: [{ text: "hi" }] });
  await activate(h);
  let out: string[] = [];
  await assert.doesNotReject(async () => {
    out = await runCommand(h, "eval", "   ");
  });
  assert.match(out.join("\n"), /usage/i);
});

test("T15: /eval on an unreadable/nonexistent dir reports the error, never throwing", async () => {
  const h = makeHarness({ fallback: "allow", responder: [{ text: "hi" }] });
  await activate(h);
  const missing = join(tmpdir(), `eagent-evals-nope-${process.pid}-${Date.now()}`);
  let out: string[] = [];
  await assert.doesNotReject(async () => {
    out = await runCommand(h, "eval", missing);
  });
  assert.match(out.join("\n"), /cannot read/i);
});

test("T15: /eval on an empty dir reports no scenarios, never throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-evals-"));
  try {
    const h = makeHarness({ fallback: "allow", responder: [{ text: "hi" }] });
    await activate(h);
    let out: string[] = [];
    await assert.doesNotReject(async () => {
      out = await runCommand(h, "eval", dir);
    });
    assert.match(out.join("\n"), /no .*scenarios/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T15: /eval names a scenario failed when the provider is not scriptable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-evals-"));
  try {
    writeFileSync(
      join(dir, "x.eval.json"),
      JSON.stringify({
        input: "go",
        mockScript: [{ toolCalls: [{ name: "A" }] }, { text: "done" }],
        expect: { tools: ["A"], order: "exact" },
      }),
    );
    const h = makeHarness({ fallback: "allow", responder: [{ text: "hi" }] });
    registerAB(h.agent);
    await activate(h);
    // Replace the scriptable mock with a non-scriptable provider (no `script`).
    h.agent.providers.register(h.provider).dispose();
    h.agent.providers.register(
      {
        name: "plain",
        // A bare Provider with no `script` method — the runner must skip it.
        async *stream() {
          // no turns; the scenario never runs
        },
      },
      { default: true },
    );

    const out = (await runCommand(h, "eval", dir)).join("\n");
    assert.match(out, /0\/1/, "the lone scenario could not run");
    assert.match(out, /no scriptable provider/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- T16: kill switch (AC9) --------------------------------------------------

test("T16: EAGENT_EVALS=off makes the consumer + commands + tool no-ops", async () => {
  const prev = process.env.EAGENT_EVALS;
  process.env.EAGENT_EVALS = "off";
  try {
    const h = makeHarness({
      fallback: "allow",
      responder: [{ toolCalls: [{ name: "A" }, { name: "B" }] }, { text: "done" }],
    });
    registerAB(h.agent);
    const api = await activate(h);

    await h.agent.run("go");
    const t = getTrajectory(api);
    assert.ok(!t || t.tools.length === 0, "with the kill switch set, the consumer records nothing");

    const expectOut = (await runCommand(h, "expect", '{"tools":["A","B"]}')).join("\n");
    assert.match(expectOut, /disabled|off/i, "/expect reports the disabled state");

    // The /eval command early-returns the disabled message before any dir work
    // (so the dir argument is never read — a literal path suffices here).
    const evalOut = (await runCommand(h, "eval", "/some/dir")).join("\n");
    assert.match(evalOut, /disabled|off/i, "/eval reports the disabled state");
    assert.doesNotMatch(evalOut, /passed|FAIL/i, "/eval runs no scenarios when disabled");

    // The judge tool fails closed with the disabled message — it never grades.
    const judge = h.agent.tools.get("judge");
    assert.ok(judge, "judge is registered");
    const judgeRes = await judge.execute({ rubric: "r", candidate: "c" }, toolCtx(h));
    assert.equal(judgeRes.isError, true, "judge fails closed when disabled");
    assert.match(judgeRes.content, /disabled|off/i, "judge reports the disabled state");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_EVALS;
    else process.env.EAGENT_EVALS = prev;
  }
});

// -- T18: clean dispose (AC10) -----------------------------------------------

test("T18: after host.unload no consumer is attached and the commands/tool are gone", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "A" }, { name: "B" }] }, { text: "done" }],
  });
  registerAB(h.agent);
  const api = await activate(h);
  await h.host.unload("evals");

  await h.agent.run("go");
  const t = getTrajectory(api);
  assert.ok(!t || t.tools.length === 0, "after teardown the consumer no longer records");
  assert.equal(h.commands.get("expect"), undefined, "/expect is unregistered");
  assert.equal(h.commands.get("eval"), undefined, "/eval is unregistered");
  assert.equal(h.agent.tools.get("judge"), undefined, "the judge tool is unregistered");
});
