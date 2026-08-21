/**
 * Tests for plan mode — the human-in-the-loop approval gate.
 *
 * Strategy: register test tools (one mutating via `fs:write`, one read-only, plus
 * the literal `bash` name) that flip a flag when their body runs. We script the
 * MockProvider to emit a single tool call per run, then drive the loop with
 * `agent.run` and read the resulting `role:"tool"` message to see whether the
 * tool ran or was blocked. Plan-mode state is flipped through the `/plan` command
 * (never by poking the store directly). A confirm spy counts invocations so we
 * can assert read-only tools are never gated.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import activate from "../src/extensions/planmode.ts";
import { defineTool, ok } from "../src/kernel/define.ts";
import type { UI } from "../src/kernel/types.ts";
import { makeHarness, type Harness } from "./helpers.ts";

/** A UI whose confirm answer is configurable and whose calls are counted. */
interface ConfirmSpy extends UI {
  calls: number;
  answer: boolean;
}

function confirmSpy(answer: boolean): ConfirmSpy {
  const spy: ConfirmSpy = {
    calls: 0,
    answer,
    confirm: async () => {
      spy.calls++;
      return spy.answer;
    },
    notify: () => {},
  };
  return spy;
}

/** Tracks which tool bodies actually executed. */
interface Ran {
  mutate: boolean;
  readonly: boolean;
  bash: boolean;
}

function setup(ui: UI): { h: Harness; ran: Ran } {
  const ran: Ran = { mutate: false, readonly: false, bash: false };
  const h = makeHarness({ fallback: "allow", ui });

  h.agent.tools.register(
    defineTool({
      name: "mutate_thing",
      description: "A mutating tool (writes the filesystem).",
      capabilities: ["fs:write"],
      execute: () => {
        ran.mutate = true;
        return ok("mutated-ok");
      },
    }),
  );
  h.agent.tools.register(
    defineTool({
      name: "read_thing",
      description: "A read-only tool.",
      execute: () => {
        ran.readonly = true;
        return ok("read-ok");
      },
    }),
  );
  h.agent.tools.register(
    defineTool({
      name: "bash",
      description: "A tool that is mutating by name (denylist), no declared caps.",
      execute: () => {
        ran.bash = true;
        return ok("bash-ok");
      },
    }),
  );

  return { h, ran };
}

/** Script the provider to call `tool` once, then stop. */
function scriptOneCall(h: Harness, tool: string): void {
  h.provider.script([{ toolCalls: [{ name: tool, id: "c1", arguments: {} }] }, { text: "done" }]);
}

/** The text content of the single tool result in the transcript. */
function toolResultText(h: Harness): string {
  for (const m of h.agent.messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") return b.content;
    }
  }
  return "";
}

async function planCmd(h: Harness, args: string): Promise<void> {
  const cmd = h.commands.get("plan");
  assert.ok(cmd, "plan command should be registered");
  await cmd.run({ agent: h.agent, args, print: () => {} });
}

test("plan OFF (default): a mutating tool runs normally", async () => {
  const { h, ran } = setup(confirmSpy(false));
  await h.host.use("planmode", activate);

  scriptOneCall(h, "mutate_thing");
  await h.agent.run("go");

  assert.equal(ran.mutate, true, "tool body should have executed");
  assert.match(toolResultText(h), /mutated-ok/);
});

test("plan ON + confirm=false: a mutating tool is blocked and its body never runs", async () => {
  const spy = confirmSpy(false);
  const { h, ran } = setup(spy);
  await h.host.use("planmode", activate);
  await planCmd(h, "on");

  scriptOneCall(h, "mutate_thing");
  await h.agent.run("go");

  assert.equal(spy.calls, 1, "confirm should have been asked once");
  assert.equal(ran.mutate, false, "tool body must NOT run when rejected");
  assert.match(toolResultText(h), /rejected in plan mode/);
});

test("plan ON + confirm=true: the same mutating tool runs", async () => {
  const spy = confirmSpy(true);
  const { h, ran } = setup(spy);
  await h.host.use("planmode", activate);
  await planCmd(h, "on");

  scriptOneCall(h, "mutate_thing");
  await h.agent.run("go");

  assert.equal(spy.calls, 1, "confirm should have been asked once");
  assert.equal(ran.mutate, true, "tool body should run when approved");
  assert.match(toolResultText(h), /mutated-ok/);
});

test("plan ON: a read-only tool is not gated and no confirm is asked", async () => {
  const spy = confirmSpy(false);
  const { h, ran } = setup(spy);
  await h.host.use("planmode", activate);
  await planCmd(h, "on");

  scriptOneCall(h, "read_thing");
  await h.agent.run("go");

  assert.equal(spy.calls, 0, "read-only tool must not trigger a confirm");
  assert.equal(ran.readonly, true, "read-only tool body should run");
  assert.match(toolResultText(h), /read-ok/);
});

test("plan ON: the bash name denylist is gated even without declared capabilities", async () => {
  const spy = confirmSpy(false);
  const { h, ran } = setup(spy);
  await h.host.use("planmode", activate);
  await planCmd(h, "on");

  scriptOneCall(h, "bash");
  await h.agent.run("go");

  assert.equal(spy.calls, 1, "bash should trigger a confirm via the name denylist");
  assert.equal(ran.bash, false, "bash body must not run when rejected");
  assert.match(toolResultText(h), /rejected in plan mode/);
});

test("/plan toggles state: on -> gated, off -> runs", async () => {
  const spy = confirmSpy(false);
  const { h, ran } = setup(spy);
  await h.host.use("planmode", activate);

  // Toggle ON (no args) -> mutating call is gated and blocked.
  await planCmd(h, "");
  scriptOneCall(h, "mutate_thing");
  await h.agent.run("go");
  assert.equal(ran.mutate, false, "after toggle ON, mutating tool should be blocked");
  assert.equal(spy.calls, 1);

  // Toggle OFF (no args) -> mutating call runs untouched, no new confirm.
  await planCmd(h, "");
  h.agent.clear();
  scriptOneCall(h, "mutate_thing");
  await h.agent.run("go again");
  assert.equal(ran.mutate, true, "after toggle OFF, mutating tool should run");
  assert.equal(spy.calls, 1, "no additional confirm once plan mode is OFF");
});
