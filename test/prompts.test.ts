import assert from "node:assert/strict";
import { test } from "node:test";

import prompts, { expand } from "../src/extensions/prompts.js";
import type { Command } from "../src/kernel/commands.js";
import { makeHarness } from "./helpers.js";

async function run(cmd: Command, agent: ReturnType<typeof makeHarness>["agent"], args: string): Promise<string[]> {
  const out: string[] = [];
  await cmd.run({ agent, args, print: (l) => out.push(l) });
  return out;
}

function lastUserText(agent: ReturnType<typeof makeHarness>["agent"]): string {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i]!;
    if (m.role !== "user") continue;
    const t = m.content.find((b) => b.type === "text");
    if (t && t.type === "text") return t.text;
  }
  return "";
}

test("expand substitutes positional and splat placeholders", () => {
  assert.equal(expand("Hello $1, you are $2", ["Ada", "great"]), "Hello Ada, you are great");
  assert.equal(expand("all: $*", ["a", "b", "c"]), "all: a b c");
  assert.equal(expand("missing $3", ["only"]), "missing ");
});

test("save, list, run, and remove a prompt template", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("prompts", prompts);

  await run(h.commands.get("prompt-save")!, h.agent, "greet Hello $1, welcome!");
  const list = await run(h.commands.get("prompts")!, h.agent, "");
  assert.match(list.join("\n"), /greet/);

  // Running the prompt expands it and drives a real turn.
  await run(h.commands.get("prompt")!, h.agent, "greet World");
  assert.equal(lastUserText(h.agent), "Hello World, welcome!");

  // Remove it.
  await run(h.commands.get("prompt-remove")!, h.agent, "greet");
  const after = await run(h.commands.get("prompts")!, h.agent, "");
  assert.match(after.join("\n"), /no saved prompts/);
});

test("running an unknown prompt prints a helpful message and does not run", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("prompts", prompts);
  const out = await run(h.commands.get("prompt")!, h.agent, "ghost arg");
  assert.match(out.join("\n"), /no prompt named "ghost"/);
  assert.equal(h.agent.messages.length, 0, "no turn should have run");
});
