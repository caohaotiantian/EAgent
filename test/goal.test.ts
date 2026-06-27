/**
 * Tests for the goal extension: an anti-drift pin (`transformContext`) of the
 * run objective + acceptance criteria, plus an advisory end-of-run lexical
 * completion check, an optional offline-degrading model judge, a `setgoal`
 * tool (no capability), and a `/goal` command.
 *
 * The pure helpers (`checkCriteria`, `parseJudgeReply`, `render`, …) are
 * exercised directly. Live behavior is driven through the harness; the optional
 * judge sub-call is served by a scripted, call-counting provider. The suite is
 * fully offline: no network, no API key, no real provider. The extension is
 * loaded via `host.use("goal", goal)` and does NOT depend on BUILTIN_EXTENSIONS.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import goal, {
  checkCriteria,
  coverageOf,
  parseJudgeReply,
  render,
  renderPin,
  significantTokens,
  validateGoal,
  type CriterionResult,
} from "../src/extensions/goal.js";
import { defineTool } from "../src/kernel/define.js";
import type {
  CompletionRequest,
  Message,
  Provider,
  StreamEvent,
  Tool,
  ToolContext,
  ToolResult,
  UI,
} from "../src/kernel/types.js";
import { makeHarness, type Harness } from "./helpers.js";

// -- fixtures ---------------------------------------------------------------

/** A spy UI that records `notify` calls (confirm auto-allows). */
function spyUI(): { ui: UI; notifies: string[] } {
  const notifies: string[] = [];
  const ui: UI = { confirm: async () => true, notify: (m) => notifies.push(m) };
  return { ui, notifies };
}

/** A scripted, call-counting provider: one `done` event carrying `reply`. */
class ScriptProvider implements Provider {
  readonly name = "mock";
  calls = 0;
  constructor(private readonly reply: string) {}
  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    this.calls += 1;
    const message: Message = { role: "assistant", content: [{ type: "text", text: this.reply }] };
    yield { type: "done", message, stopReason: "end_turn" };
  }
}

function ctx(): ToolContext {
  return {
    toolCallId: "t",
    signal: new AbortController().signal,
    require: async () => {},
    progress: () => {},
    ui: { confirm: async () => true, notify: () => {} },
    agent: { model: "mock", messages: [], steer: () => {}, followUp: () => {} },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

function cmd(h: Harness, args: string): string[] {
  const out: string[] = [];
  h.commands.get("goal")!.run({ agent: h.agent, args, print: (l) => out.push(l) });
  return out;
}

function assistant(...blocks: string[]): Message {
  return { role: "assistant", content: blocks.map((text) => ({ type: "text", text })) };
}

function toolResults(h: Harness): ToolResult[] {
  return h.agent.messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result")
    .map((b) => ({ content: b.content, isError: b.isError }));
}

// -- pure helpers -----------------------------------------------------------

test("significantTokens drops stopwords and short tokens", () => {
  assert.deepEqual(significantTokens("handles empty input"), ["handles", "empty", "input"]);
  assert.deepEqual(significantTokens("returns the AST"), ["returns", "ast"]); // "the" dropped
  assert.deepEqual(significantTokens("a, an; or to"), []); // all short/stopwords
});

test("coverageOf is whole-word, case-insensitive, with empty-criterion = 1", () => {
  assert.equal(coverageOf("the parser returns an AST", "returns AST"), 1);
  assert.equal(coverageOf("it is fast", "returns AST"), 0); // 'ast' not in 'fast'
  assert.equal(coverageOf("", "and the to"), 1); // no significant tokens => covered
});

test("checkCriteria flags below the 0.5 threshold", () => {
  const r = checkCriteria("handles empty input", ["handles empty input", "returns AST"]);
  assert.equal(r[0]!.coverage, 1);
  assert.equal(r[0]!.addressed, true);
  assert.equal(r[1]!.coverage, 0);
  assert.equal(r[1]!.addressed, false);
});

test("parseJudgeReply: strict, complete, fail-open on garbage", () => {
  assert.deepEqual(parseJudgeReply("MET 1\nUNMET 2", 2), ["MET", "UNMET"]);
  assert.deepEqual(parseJudgeReply("  unmet 1 \n MET 2 ", 2), ["UNMET", "MET"]);
  assert.equal(parseJudgeReply("blah blah", 2), undefined); // unparseable
  assert.equal(parseJudgeReply("MET 1", 2), undefined); // criterion 2 unjudged
  assert.equal(parseJudgeReply("MET 1\nMET 1", 2), undefined); // duplicate / missing
  assert.equal(parseJudgeReply("MET 3", 2), undefined); // out of range
  assert.equal(parseJudgeReply("", 2), undefined); // empty
});

test("validateGoal rejects empty objective and non-string criteria", () => {
  assert.equal(validateGoal({}).ok, false);
  assert.equal(validateGoal({ objective: "   " }).ok, false);
  assert.equal(validateGoal({ objective: "x", criteria: ["a", 2] }).ok, false);
  const good = validateGoal({ objective: " ship it ", criteria: [" a ", "b"] });
  assert.equal(good.ok, true);
  assert.ok(good.ok && good.objective === "ship it" && good.criteria.length === 2);
});

// -- AC1: inert with no goal ------------------------------------------------

test("AC1: inert with no goal — transformContext returns same ref, no notify", async () => {
  const { ui, notifies } = spyUI();
  const h = makeHarness({ ui });
  await h.host.use("goal", goal);

  const input: Message[] = [{ role: "user", content: [{ type: "text", text: "do a thing" }] }];
  const out = await h.agent.hooks.apply("transformContext", input, { turn: 0, model: "mock" });
  assert.equal(out, input, "with no goal the input array is returned by reference");

  await h.agent.hooks.emit("agent_end", { reason: "end_turn" });
  assert.equal(notifies.length, 0, "no completion check fires without a goal");
});

// -- AC2: pin injection -----------------------------------------------------

test("AC2: a set goal injects a leading ephemeral system pin, input untouched", async () => {
  const h = makeHarness();
  await h.host.use("goal", goal);
  cmd(h, "set Ship the parser");
  cmd(h, "criteria handles empty input; returns AST");

  const input: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  const out = await h.agent.hooks.apply("transformContext", input, { turn: 1, model: "mock" });

  assert.notEqual(out, input, "a new array is returned");
  assert.equal(input.length, 1, "the input array is not mutated");
  const note = out[0]!;
  assert.equal(note.role, "system");
  assert.equal(note.meta?.source, "goal");
  assert.equal(note.meta?.ephemeral, true);
  const body = note.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  assert.match(body, /Ship the parser/);
  assert.match(body, /handles empty input/);
  assert.match(body, /returns AST/);
  assert.deepEqual(out.slice(1), input, "the original messages follow unmodified");
});

// -- AC3: lexical check flags / clears --------------------------------------

test("AC3: lexical check flags exactly the unaddressed criterion", async () => {
  const { ui, notifies } = spyUI();
  const h = makeHarness({ ui });
  await h.host.use("goal", goal);
  cmd(h, "set Ship the parser");
  cmd(h, "criteria handles empty input; returns AST");

  // Final answer mentions only criterion 1's tokens.
  h.agent.load([assistant("The parser handles empty input gracefully now.")]);
  await h.agent.hooks.emit("agent_end", { reason: "end_turn" });

  assert.equal(notifies.length, 1, "exactly one notify");
  assert.match(notifies[0]!, /1\/2/);
  assert.match(notifies[0]!, /returns AST/);
  assert.doesNotMatch(notifies[0]!, /handles empty input/);

  // Inspect lastCheck via /goal status coverage numbers.
  const status = cmd(h, "status").join("\n");
  assert.match(status, /\[x\] handles empty input \(coverage 1\.00\)/);
  assert.match(status, /\[ \] returns AST \(coverage 0\.00\)/);
});

test("AC3: an answer covering all criteria produces no notify", async () => {
  const { ui, notifies } = spyUI();
  const h = makeHarness({ ui });
  await h.host.use("goal", goal);
  cmd(h, "set Ship the parser");
  cmd(h, "criteria handles empty input; returns AST");

  h.agent.load([assistant("The parser handles empty input and returns an AST.")]);
  await h.agent.hooks.emit("agent_end", { reason: "end_turn" });
  assert.equal(notifies.length, 0, "all criteria covered => no warning");
});

// -- AC4: multi-block harvest -----------------------------------------------

test("AC4: multi-block final answer is concatenated before checking", async () => {
  const { ui, notifies } = spyUI();
  const h = makeHarness({ ui });
  await h.host.use("goal", goal);
  cmd(h, "set Build it");
  cmd(h, "criteria returns parsed AST node");

  // Split across two blocks; only the concatenation covers all four tokens.
  // A single-block harvest (block 0 alone) would flag it falsely.
  h.agent.load([assistant("It returns a ", "parsed AST node now.")]);
  await h.agent.hooks.emit("agent_end", { reason: "end_turn" });
  assert.equal(notifies.length, 0, "multi-block answer must not be flagged");
});

// -- AC5: setgoal validation + no-capability --------------------------------

test("AC5: setgoal validation leaves prior state intact", async () => {
  const h = makeHarness();
  await h.host.use("goal", goal);
  const tool = h.agent.tools.get("setgoal") as Tool | undefined;
  assert.ok(tool, "setgoal registered");

  const good = await tool!.execute({ objective: "keep", criteria: ["c"] }, ctx());
  assert.equal(good.isError, undefined);
  assert.match(good.content, /Goal: keep/);

  const badObj = await tool!.execute({ objective: "" }, ctx());
  assert.equal(badObj.isError, true);
  assert.match(badObj.content, /objective/);

  const badCrit = await tool!.execute({ objective: "x", criteria: [1] }, ctx());
  assert.equal(badCrit.isError, true);
  assert.match(badCrit.content, /criteria/);

  // The prior good state still stands.
  assert.match(cmd(h, "status").join("\n"), /Goal: keep/);
});

test("AC5: setgoal needs no capability and runs under fallback:deny", async () => {
  const h = makeHarness({
    fallback: "deny",
    responder: [
      { toolCalls: [{ name: "setgoal", arguments: { objective: "ship", criteria: ["a"] } }] },
      { text: "done" },
    ],
  });
  await h.host.use("goal", goal);

  await h.agent.run("track a goal");

  const results = toolResults(h);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.isError, undefined, "no capability => not denied");
  assert.match(results[0]!.content, /Goal: ship/);
});

test("AC5 control: a tool declaring shell:exec IS blocked under fallback:deny", async () => {
  const h = makeHarness({
    fallback: "deny",
    responder: [{ toolCalls: [{ name: "run_shell" }] }, { text: "done" }],
  });
  h.agent.tools.register(
    defineTool({
      name: "run_shell",
      description: "",
      capabilities: ["shell:exec"],
      execute: () => ({ content: "ran" }),
    }),
  );

  await h.agent.run("run something");

  const blocked = toolResults(h).some((r) => r.isError === true && /shell:exec/.test(r.content));
  assert.ok(blocked, "the capability-declaring tool must be denied (harness is not allow-all)");
});

// -- AC6: kill switch -------------------------------------------------------

test("AC6: EAGENT_GOAL=off registers nothing", async () => {
  const prev = process.env.EAGENT_GOAL;
  process.env.EAGENT_GOAL = "off";
  try {
    const h = makeHarness();
    await h.host.use("goal", goal);
    assert.equal(h.agent.tools.get("setgoal"), undefined, "no tool when off");
    assert.equal(h.commands.get("goal"), undefined, "no command when off");
    const input: Message[] = [{ role: "user", content: [{ type: "text", text: "x" }] }];
    const out = await h.agent.hooks.apply("transformContext", input, { turn: 0, model: "mock" });
    assert.equal(out, input, "transformContext unaffected when off");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_GOAL;
    else process.env.EAGENT_GOAL = prev;
  }
});

// -- AC7: model judge (off by default; offline-degrading) -------------------

test("AC7: judge off by default — zero provider.stream calls at agent_end", async () => {
  const { ui, notifies } = spyUI();
  const h = makeHarness({ ui });
  const provider = new ScriptProvider("MET 1\nUNMET 2");
  h.agent.providers.register(provider, { default: true });
  await h.host.use("goal", goal);
  cmd(h, "set Ship");
  cmd(h, "criteria alpha covered; beta covered");

  h.agent.load([assistant("alpha covered and beta covered fully.")]);
  await h.agent.hooks.emit("agent_end", { reason: "end_turn" });

  assert.equal(provider.calls, 0, "judge off => no sub-call");
  assert.equal(notifies.length, 0, "lexical check passes (both covered)");
});

test("AC7: judge on parses MET/UNMET; reflects the judged verdict", async () => {
  const { ui, notifies } = spyUI();
  const h = makeHarness({ ui });
  const provider = new ScriptProvider("MET 1\nUNMET 2");
  h.agent.providers.register(provider, { default: true });
  await h.host.use("goal", goal);
  cmd(h, "set Ship");
  cmd(h, "criteria alpha covered; beta covered");
  cmd(h, "judge on");

  // Lexically BOTH are covered, so a flag can only come from the judge.
  h.agent.load([assistant("alpha covered and beta covered fully.")]);
  await h.agent.hooks.emit("agent_end", { reason: "end_turn" });

  assert.equal(provider.calls, 1, "exactly one judge sub-call");
  assert.equal(notifies.length, 1, "judge UNMET 2 => one flag");
  assert.match(notifies[0]!, /beta covered/);
  assert.match(notifies[0]!, /1\/2/);
});

test("AC7: judge on with garbage reply falls back to the lexical check", async () => {
  const { ui, notifies } = spyUI();
  const h = makeHarness({ ui });
  const provider = new ScriptProvider("not a verdict at all");
  h.agent.providers.register(provider, { default: true });
  await h.host.use("goal", goal);
  cmd(h, "set Ship");
  cmd(h, "criteria alpha covered; beta covered");
  cmd(h, "judge on");

  h.agent.load([assistant("alpha covered and beta covered fully.")]);
  await h.agent.hooks.emit("agent_end", { reason: "end_turn" });

  assert.equal(provider.calls, 1, "the judge was attempted");
  assert.equal(notifies.length, 0, "garbage reply => fall back to lexical (both covered)");
});

// -- AC8: lifecycle reset ---------------------------------------------------

test("AC8: session_start clears the goal", async () => {
  const h = makeHarness();
  await h.host.use("goal", goal);
  cmd(h, "set Ship the parser");
  assert.match(cmd(h, "status").join("\n"), /Ship the parser/);

  await h.agent.hooks.emit("session_start", {});
  assert.deepEqual(cmd(h, "status"), ["(no goal set)"]);
});

// -- pure-render sanity -----------------------------------------------------

test("render omits the criteria block when empty", () => {
  assert.equal(render("just do it", []), "Goal: just do it");
  assert.match(render("o", ["a", "b"]), /Acceptance criteria:\n {2}1\. a\n {2}2\. b/);
});

test("renderPin frames the anti-drift note", () => {
  const pin = renderPin("ship", ["a"]);
  assert.match(pin, /keep this in view; do not drift/);
  assert.match(pin, /Acceptance criteria:\n- a/);
  const results: CriterionResult[] = checkCriteria("x", []);
  assert.deepEqual(results, []);
});
