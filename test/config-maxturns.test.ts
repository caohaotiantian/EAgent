/**
 * AC-10: a spawned sub-agent's turn bound is config-driven.
 *
 * The request's exact use case: set `EAGENT_SUBAGENTS_MAX_TURNS` (or
 * `/config set subagents.maxTurns`) and a child spawned WITHOUT an explicit
 * `maxTurns` arg is bounded by that value — proving the four hard-coded
 * `maxTurns` constants are now one settable knob. A child that calls a tool
 * every turn (and never stops) therefore halts at exactly that many provider
 * calls.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { CompletionRequest } from "../src/kernel/types.js";
import { defineTool, ok } from "../src/kernel/define.js";
import subagents from "../src/extensions/subagents.js";
import { makeHarness } from "./helpers.js";

const touched: string[] = [];
afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
});

/** Was this request issued by the child (its fresh transcript starts with the
 *  child system prompt)? The parent transcript never contains "CHILD-LOOP". */
function isChild(req: CompletionRequest): boolean {
  return req.systemPrompt.includes("CHILD-LOOP");
}

test("EAGENT_SUBAGENTS_MAX_TURNS bounds a spawned child (AC-10)", async () => {
  touched.push("EAGENT_SUBAGENTS_MAX_TURNS");
  process.env.EAGENT_SUBAGENTS_MAX_TURNS = "2";

  let childCalls = 0;
  const { agent, host } = makeHarness({
    fallback: "allow",
    responder: (req) => {
      if (isChild(req)) {
        childCalls++;
        // The child never stops on its own — always calls the noop tool.
        return { toolCalls: [{ name: "noop", arguments: {} }] };
      }
      // The parent spawns one looping child, then ends.
      if (req.messages.some((m) => m.role === "tool")) return { text: "done" };
      return {
        toolCalls: [
          { name: "spawn_agent", arguments: { mode: "single", prompt: "loop", system: "CHILD-LOOP" } },
        ],
      };
    },
  });

  agent.tools.register(
    defineTool({ name: "noop", description: "noop", parameters: { type: "object", properties: {} }, execute: async () => ok("ok") }),
  );
  await host.use("subagents", subagents);

  await agent.run("go");
  assert.equal(childCalls, 2, "the child is bounded by EAGENT_SUBAGENTS_MAX_TURNS=2");
});
