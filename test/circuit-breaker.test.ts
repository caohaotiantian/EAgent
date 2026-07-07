/**
 * Offline tests for the `circuit-breaker` repetition / consecutive-failure guard.
 *
 * Everything runs against the deterministic MockProvider through the shared
 * harness — no network, no API key. We script identical / oscillating / failing
 * tool calls and assert on the transcript (`agent.messages`), the stub tool's
 * invocation count, and `/circuit-breaker` command output.
 *
 * Each test scripts ONE tool call per turn so the `beforeToolCall` /
 * `afterToolCall` ladder for a call fully completes (and any steer is drained)
 * before the next turn.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../src/kernel/define.js";
import type { Command } from "../src/kernel/commands.js";
import type { Message, ToolResultBlock } from "../src/kernel/types.js";
import { makeHarness, autoUI } from "./helpers.js";
import activateCircuitBreaker, { stableSignature } from "../src/extensions/circuit-breaker.js";

/** Collect every `role:"tool"` result block from the transcript. */
function toolResults(messages: readonly Message[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) if (b.type === "tool_result") out.push(b);
  }
  return out;
}

/** All text from `user`-role messages (where a steer lands when drained). */
function userTexts(messages: readonly Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) if (b.type === "text") out.push(b.text);
  }
  return out;
}

/** Run a command captured into a lines array; returns the printed lines. */
async function runCommand(
  cmd: Command,
  agent: ReturnType<typeof makeHarness>["agent"],
  args: string,
): Promise<string[]> {
  const lines: string[] = [];
  await cmd.run({ agent, args, print: (l) => lines.push(l) });
  return lines;
}

/** A stub tool that counts invocations and returns a fixed (optionally error) result. */
function stub(opts: { isError?: boolean } = {}): { tool: ReturnType<typeof defineTool>; calls: () => number } {
  let count = 0;
  const tool = defineTool({
    name: "probe",
    description: "test stub",
    parameters: { type: "object", properties: {} },
    execute: () => {
      count += 1;
      return opts.isError ? { content: "boom", isError: true } : { content: "ok" };
    },
  });
  return { tool, calls: () => count };
}

// --- T-1: unit — signature is key-order invariant and value-sensitive --------

test("T-1: stableSignature collapses key order but stays value-sensitive", () => {
  // Key-order invariance (D2/AC-9): {a,b} and {b,a} hash identically.
  assert.equal(
    stableSignature("read", { a: 1, b: 2 }),
    stableSignature("read", { b: 2, a: 1 }),
  );
  // Nested objects sort recursively.
  assert.equal(
    stableSignature("read", { a: { x: 1, y: 2 }, b: 3 }),
    stableSignature("read", { b: 3, a: { y: 2, x: 1 } }),
  );
  // Value sensitivity (AC-8): advancing offset never collides.
  assert.notEqual(
    stableSignature("read", { offset: 0 }),
    stableSignature("read", { offset: 1 }),
  );
  // Different tool name with the same args differs.
  assert.notEqual(
    stableSignature("read", { a: 1 }),
    stableSignature("write", { a: 1 }),
  );
  // Arrays keep their order (semantically meaningful).
  assert.notEqual(
    stableSignature("t", { xs: [1, 2] }),
    stableSignature("t", { xs: [2, 1] }),
  );
});

// --- T-2: live — 2nd identical call triggers a soft steer, not a block -------

test("T-2: a 2nd identical call triggers a soft steer, not a block", async () => {
  const { agent, host } = makeHarness({
    responder: (_req, i) =>
      i < 2 ? { toolCalls: [{ name: "probe", id: `c${i}` }] } : { text: "done" },
    fallback: "allow",
  });
  const s = stub();
  agent.tools.register(s.tool);
  await host.use("circuit-breaker", activateCircuitBreaker);

  await agent.run("go");

  // Both calls executed: the 2nd nudges but never blocks.
  assert.equal(s.calls(), 2, "both identical calls ran");
  const blocked = toolResults(agent.messages).filter((r) => r.content.includes("Tool call blocked"));
  assert.equal(blocked.length, 0, "no block at the 2nd occurrence");

  const steer = userTexts(agent.messages).find((t) => t.includes("circuit-breaker"));
  assert.ok(steer, "a circuit-breaker steer message is present");
  assert.ok(
    /identical|repeating/i.test(steer!),
    "steer mentions identical/repeating",
  );
});

// --- T-3: live — N-th identical call halted; block/oscillation/stringify/ask --

test("T-3 block: the 3rd identical call is halted in mode=block", async () => {
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) =>
      i < 3 ? { toolCalls: [{ name: "probe", id: `c${i}` }] } : { text: "done" },
    fallback: "allow",
  });
  const s = stub();
  agent.tools.register(s.tool);
  await host.use("circuit-breaker", activateCircuitBreaker);
  await runCommand(commands.get("circuit-breaker")!, agent, "block");

  await agent.run("go");

  assert.equal(s.calls(), 2, "the 3rd identical call never ran");
  const blocked = toolResults(agent.messages).find((r) => r.toolCallId === "c2");
  assert.ok(blocked, "the 3rd produced a tool_result");
  assert.equal(blocked!.isError, true);
  assert.ok(
    blocked!.content.includes("circuit-breaker:") &&
      blocked!.content.includes("called 3x with identical args"),
    `expected identical-args reason, got: ${blocked!.content}`,
  );
});

test("T-3 oscillation: A-B-A-B trips on A's 3rd total occurrence (threshold 2)", async () => {
  // A,B,A,B → A occurs at attempts 1 & 3, B at 2 & 4. With threshold 2, A's
  // 2nd occurrence (attempt 3) is the hard trip. Proves total-in-run (D3).
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) => {
      const name = i % 2 === 0 ? "a" : "b";
      return i < 4 ? { toolCalls: [{ name, id: `c${i}` }] } : { text: "done" };
    },
    fallback: "allow",
  });
  let aCalls = 0;
  let bCalls = 0;
  agent.tools.register(
    defineTool({ name: "a", description: "a", execute: () => { aCalls += 1; return { content: "ok" }; } }),
  );
  agent.tools.register(
    defineTool({ name: "b", description: "b", execute: () => { bCalls += 1; return { content: "ok" }; } }),
  );
  await host.use("circuit-breaker", activateCircuitBreaker);
  await runCommand(commands.get("circuit-breaker")!, agent, "block");
  await runCommand(commands.get("circuit-breaker")!, agent, "threshold=2");

  await agent.run("go");

  // A's 2nd occurrence (attempt index 2, id c2) is blocked; A ran once.
  assert.equal(aCalls, 1, "A only ran once before being tripped on its repeat");
  const aBlocked = toolResults(agent.messages).find((r) => r.toolCallId === "c2");
  assert.ok(aBlocked && aBlocked.isError, "A's repeat (c2) was blocked");
  assert.ok(aBlocked!.content.includes("circuit-breaker:"));
});

test("T-3 stable-stringify: key-order variants share one signature and trip", async () => {
  const variants = [{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1, b: 2 }];
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) =>
      i < 3
        ? { toolCalls: [{ name: "probe", id: `c${i}`, arguments: variants[i] }] }
        : { text: "done" },
    fallback: "allow",
  });
  const s = stub();
  agent.tools.register(s.tool);
  await host.use("circuit-breaker", activateCircuitBreaker);
  await runCommand(commands.get("circuit-breaker")!, agent, "block");

  await agent.run("go");

  assert.equal(s.calls(), 2, "the 3rd (same canonical signature) was tripped");
  const blocked = toolResults(agent.messages).find((r) => r.toolCallId === "c2");
  assert.ok(blocked && blocked.isError, "the 3rd was blocked despite key-order differences");
});

test("T-3 ask: ask-mode allows on confirm", async () => {
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) =>
      i < 3 ? { toolCalls: [{ name: "probe", id: `c${i}` }] } : { text: "done" },
    fallback: "allow",
    ui: autoUI(true),
  });
  const s = stub();
  agent.tools.register(s.tool);
  await host.use("circuit-breaker", activateCircuitBreaker);
  // default mode is ask; assert explicitly nonetheless.
  await runCommand(commands.get("circuit-breaker")!, agent, "ask");

  await agent.run("go");

  assert.equal(s.calls(), 3, "confirmed N-th call still ran");
  const blocked = toolResults(agent.messages).filter((r) => r.content.includes("Tool call blocked"));
  assert.equal(blocked.length, 0, "nothing blocked when confirmed");
});

test("T-3 ask: ask-mode blocks on deny", async () => {
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) =>
      i < 3 ? { toolCalls: [{ name: "probe", id: `c${i}` }] } : { text: "done" },
    fallback: "allow",
    ui: autoUI(false),
  });
  const s = stub();
  agent.tools.register(s.tool);
  await host.use("circuit-breaker", activateCircuitBreaker);
  await runCommand(commands.get("circuit-breaker")!, agent, "ask");

  await agent.run("go");

  assert.equal(s.calls(), 2, "denied N-th call did not run");
  const blocked = toolResults(agent.messages).find((r) => r.toolCallId === "c2");
  assert.ok(blocked && blocked.isError, "denied N-th call was blocked");
  assert.ok(blocked!.content.includes("circuit-breaker:"));
});

// --- T-4: live — N consecutive failures halt with a failure-framed reason ----

test("T-4: N consecutive failures halt with a failure-framed reason", async () => {
  // threshold 3: after 3 completed failures (cf=3), the next (4th) attempt is
  // halted with the failure-framed reason — distinct from the identical-args
  // branch (which the failure streak suppresses).
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) =>
      i < 4 ? { toolCalls: [{ name: "probe", id: `c${i}` }] } : { text: "done" },
    fallback: "allow",
  });
  const s = stub({ isError: true });
  agent.tools.register(s.tool);
  await host.use("circuit-breaker", activateCircuitBreaker);
  await runCommand(commands.get("circuit-breaker")!, agent, "block");

  await agent.run("go");

  // The first three fail (run); the 4th is halted on the failure streak.
  assert.equal(s.calls(), 3, "the 4th failing call never ran");
  const blocked = toolResults(agent.messages).find((r) => r.toolCallId === "c3");
  assert.ok(blocked && blocked.isError, "the 4th was blocked");
  assert.ok(
    blocked!.content.includes("circuit-breaker:") && /failed 3x/.test(blocked!.content),
    `expected failure-framed reason, got: ${blocked!.content}`,
  );
  // Distinct from the identical-args framing.
  assert.ok(!blocked!.content.includes("identical args"), "failure reason is not the identical-args string");
});

// --- T-4b: live — failure streak survives schema coercion of the args --------

test("T-4b: failure streak halts with failure framing even when args are coerced", async () => {
  // Regression: the two hooks must key the per-signature bucket on the SAME
  // argument shape. `beforeToolCall` sees the validate-coerced `decision.arguments`
  // ("3" -> 3); `afterToolCall` sees `ctx.call.arguments`. If they diverge, the
  // failure streak maintained in afterToolCall lands in a bucket the failure-trip
  // never reads — so the 4th call would halt via the identical-args COUNT branch
  // with the wrong framing instead of the failure-framed reason.
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) =>
      // Model emits the number as a STRING, which the schema coerces to a number.
      i < 4 ? { toolCalls: [{ name: "probe", id: `c${i}`, arguments: { n: "3" } }] } : { text: "done" },
    fallback: "allow",
  });
  let count = 0;
  agent.tools.register(
    defineTool({
      name: "probe",
      description: "coercing-schema stub that always fails",
      // A schema that triggers coercion: string "3" -> number 3.
      parameters: { type: "object", properties: { n: { type: "number" } } },
      execute: () => {
        count += 1;
        return { content: "boom", isError: true };
      },
    }),
  );
  await host.use("circuit-breaker", activateCircuitBreaker);
  await runCommand(commands.get("circuit-breaker")!, agent, "block");

  await agent.run("go");

  // The first three fail (run); the 4th is halted on the failure streak.
  assert.equal(count, 3, "the 4th failing call never ran");
  const blocked = toolResults(agent.messages).find((r) => r.toolCallId === "c3");
  assert.ok(blocked && blocked.isError, "the 4th was blocked");
  assert.ok(
    blocked!.content.includes("circuit-breaker:") && /failed 3x/.test(blocked!.content),
    `expected failure-framed reason, got: ${blocked!.content}`,
  );
  assert.ok(!blocked!.content.includes("identical args"), "failure reason is not the identical-args string");
});

// --- T-5: live — different-argument calls never trip -------------------------

test("T-5: different-argument calls never trip", async () => {
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) =>
      i < 4
        ? { toolCalls: [{ name: "probe", id: `c${i}`, arguments: { offset: i } }] }
        : { text: "done" },
    fallback: "allow",
  });
  const s = stub();
  agent.tools.register(s.tool);
  await host.use("circuit-breaker", activateCircuitBreaker);
  await runCommand(commands.get("circuit-breaker")!, agent, "block");

  await agent.run("go");

  assert.equal(s.calls(), 4, "all advancing-offset calls ran");
  const blocked = toolResults(agent.messages).filter((r) => r.content.includes("Tool call blocked"));
  assert.equal(blocked.length, 0, "no block on distinct signatures");
  const steer = userTexts(agent.messages).filter((t) => t.includes("circuit-breaker"));
  assert.equal(steer.length, 0, "no steer on distinct signatures");
});

// --- T-6: live — a success resets the consecutive-failure count --------------

test("T-6: a success resets the consecutive-failure streak", async () => {
  // fail, fail, succeed, fail, fail — never reaches 3 consecutive failures.
  const outcomes = [true, true, false, true, true]; // true = error
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) =>
      i < 5 ? { toolCalls: [{ name: "probe", id: `c${i}` }] } : { text: "done" },
    fallback: "allow",
  });
  let count = 0;
  agent.tools.register(
    defineTool({
      name: "probe",
      description: "alternating",
      execute: () => {
        const isError = outcomes[count] === true;
        count += 1;
        return isError ? { content: "boom", isError: true } : { content: "ok" };
      },
    }),
  );
  await host.use("circuit-breaker", activateCircuitBreaker);
  await runCommand(commands.get("circuit-breaker")!, agent, "block");

  await agent.run("go");

  const blocked = toolResults(agent.messages).filter(
    (r) => r.content.includes("circuit-breaker:") && /failed/.test(r.content),
  );
  assert.equal(blocked.length, 0, "the intervening success reset the failure streak");
});

// --- T-7: live — state resets on agent_start ---------------------------------

test("T-7: per-run state resets on agent_start (no cross-run carryover)", async () => {
  const { agent, host, commands, provider } = makeHarness({
    responder: (_req, i) =>
      i < 1 ? { toolCalls: [{ name: "probe", id: "r0" }] } : { text: "done" },
    fallback: "allow",
  });
  const s = stub();
  agent.tools.register(s.tool);
  await host.use("circuit-breaker", activateCircuitBreaker);
  await runCommand(commands.get("circuit-breaker")!, agent, "block");
  await runCommand(commands.get("circuit-breaker")!, agent, "threshold=2");

  // Run 1: one call (count reaches 1, below threshold 2).
  await agent.run("go");
  assert.equal(s.calls(), 1);

  // Run 2: re-script and issue the SAME call — must start fresh, not blocked.
  provider.script((_req, i) =>
    i < 1 ? { toolCalls: [{ name: "probe", id: "r2" }] } : { text: "done" },
  );
  await agent.run("go again");

  assert.equal(s.calls(), 2, "run 2's first call ran (count started fresh)");
  const blocked = toolResults(agent.messages).filter((r) => r.content.includes("Tool call blocked"));
  assert.equal(blocked.length, 0, "no cross-run carryover");
});

// --- T-9: live — kill switch and enabled=false both suppress interventions ---

test("T-9 kill switch: EAGENT_CIRCUIT_BREAKER=off is a clean no-op", async () => {
  const prev = process.env.EAGENT_CIRCUIT_BREAKER;
  process.env.EAGENT_CIRCUIT_BREAKER = "off";
  try {
    const { agent, host, commands } = makeHarness({
      responder: (_req, i) =>
        i < 5 ? { toolCalls: [{ name: "probe", id: `c${i}` }] } : { text: "done" },
      fallback: "allow",
    });
    const s = stub();
    agent.tools.register(s.tool);
    const disposer = activateCircuitBreaker({
      // Minimal: activation only needs to early-return (the kill switch resolves
      // through e.config now), so a config whose enabled() returns false suffices.
      // We route through host.use below for real, env-driven parity.
      config: { enabled: () => false },
    } as never);
    // The early-return disposer must not throw.
    assert.doesNotThrow(() => disposer());

    // Even wired through the host, the kill switch must suppress everything.
    await host.use("circuit-breaker", activateCircuitBreaker);
    // No command should exist (nothing was wired).
    assert.equal(commands.get("circuit-breaker"), undefined, "no command wired under kill switch");

    await agent.run("go");

    assert.equal(s.calls(), 5, "all 5 calls ran under the kill switch");
    const blocked = toolResults(agent.messages).filter((r) => r.content.includes("Tool call blocked"));
    assert.equal(blocked.length, 0, "no block under the kill switch");
    const steer = userTexts(agent.messages).filter((t) => t.includes("circuit-breaker"));
    assert.equal(steer.length, 0, "no steer under the kill switch");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_CIRCUIT_BREAKER;
    else process.env.EAGENT_CIRCUIT_BREAKER = prev;
  }
});

test("T-9 enabled=false: interventions suppressed but command still works", async () => {
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) =>
      i < 5 ? { toolCalls: [{ name: "probe", id: `c${i}` }] } : { text: "done" },
    fallback: "allow",
  });
  const s = stub();
  agent.tools.register(s.tool);
  await host.use("circuit-breaker", activateCircuitBreaker);
  await runCommand(commands.get("circuit-breaker")!, agent, "block");
  await runCommand(commands.get("circuit-breaker")!, agent, "off");

  await agent.run("go");

  assert.equal(s.calls(), 5, "all calls ran with enabled=false");
  const blocked = toolResults(agent.messages).filter((r) => r.content.includes("Tool call blocked"));
  assert.equal(blocked.length, 0, "no block when disabled via store");

  // The command is still responsive (extension stays loaded).
  const out = await runCommand(commands.get("circuit-breaker")!, agent, "status");
  assert.ok(out.some((l) => /enabled/i.test(l)), "status still prints while disabled");
});

// --- T-10: live — host.unload removes the hooks (no leak) ---------------------

test("T-10: host.unload removes the hooks; nothing trips afterward", async () => {
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) =>
      i < 4 ? { toolCalls: [{ name: "probe", id: `c${i}` }] } : { text: "done" },
    fallback: "allow",
  });
  const s = stub();
  agent.tools.register(s.tool);
  await host.use("circuit-breaker", activateCircuitBreaker);
  await runCommand(commands.get("circuit-breaker")!, agent, "block");

  await assert.doesNotReject(host.unload("circuit-breaker"));
  assert.equal(commands.get("circuit-breaker"), undefined, "command torn down");

  await agent.run("go");

  assert.equal(s.calls(), 4, "all calls ran after unload (hooks gone)");
  const blocked = toolResults(agent.messages).filter((r) => r.content.includes("Tool call blocked"));
  assert.equal(blocked.length, 0, "nothing blocked after unload");
  const steer = userTexts(agent.messages).filter((t) => t.includes("circuit-breaker"));
  assert.equal(steer.length, 0, "nothing steered after unload");
});

// --- T-11: live — command surface round-trips through the store --------------

test("T-11: /circuit-breaker status reports config and subcommands round-trip", async () => {
  const { agent, host, commands } = makeHarness({ fallback: "allow" });
  agent.tools.register(stub().tool);
  await host.use("circuit-breaker", activateCircuitBreaker);
  const cmd = commands.get("circuit-breaker")!;

  // status prints enabled, mode, threshold, and bucket count.
  const status = await runCommand(cmd, agent, "status");
  const blob = status.join("\n");
  assert.ok(/enabled/i.test(blob), "status reports enabled");
  assert.ok(/mode/i.test(blob), "status reports mode");
  assert.ok(/threshold/i.test(blob), "status reports threshold");
  assert.ok(/bucket/i.test(blob), "status reports bucket count");

  // off/on toggle enabled in the store.
  await runCommand(cmd, agent, "off");
  assert.ok(/off|disabled|false/i.test((await runCommand(cmd, agent, "status")).join("\n")));
  await runCommand(cmd, agent, "on");
  assert.ok(/on|enabled|true/i.test((await runCommand(cmd, agent, "status")).join("\n")));

  // ask/block set mode.
  await runCommand(cmd, agent, "block");
  assert.ok(/block/i.test((await runCommand(cmd, agent, "status")).join("\n")));
  await runCommand(cmd, agent, "ask");
  assert.ok(/ask/i.test((await runCommand(cmd, agent, "status")).join("\n")));

  // threshold=4 sets it; a non-positive value is rejected (stays 4).
  await runCommand(cmd, agent, "threshold=4");
  assert.ok(/threshold[^0-9]*4/i.test((await runCommand(cmd, agent, "status")).join("\n")));
  const reject = await runCommand(cmd, agent, "threshold=0");
  assert.ok(reject.join("\n").length > 0, "rejecting a bad threshold prints a message");
  assert.ok(
    /threshold[^0-9]*4/i.test((await runCommand(cmd, agent, "status")).join("\n")),
    "threshold unchanged after a rejected value",
  );

  // reset clears the live Map without throwing.
  await assert.doesNotReject(async () => { await runCommand(cmd, agent, "reset"); });
});
