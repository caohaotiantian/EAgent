import assert from "node:assert/strict";
import { test } from "node:test";

import introspect from "../src/extensions/introspect.js";
import { defineTool } from "../src/kernel/define.js";
import { makeHarness } from "./helpers.js";

function withProbeTool() {
  const h = makeHarness({ fallback: "allow" });
  h.agent.tools.register(
    defineTool({
      name: "probe",
      description: "a probing tool for searching",
      capabilities: ["net:fetch"],
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      execute: () => ({ content: "" }),
    }),
  );
  return h;
}

test("describe_tool returns a tool's schema and capabilities", async () => {
  const h = withProbeTool();
  await h.host.use("introspect", introspect);
  const result = await h.agent.tools.get("describe_tool")!.execute({ name: "probe" }, fakeCtx());
  assert.match(result.content, /probe/);
  assert.match(result.content, /net:fetch/);
  assert.match(result.content, /parameters/);
});

test("/describe explains a tool and a command", async () => {
  const h = withProbeTool();
  await h.host.use("introspect", introspect);
  const out: string[] = [];
  await h.commands.get("describe")!.run({ agent: h.agent, args: "probe", print: (l) => out.push(l) });
  assert.match(out.join("\n"), /a probing tool/);

  out.length = 0;
  await h.commands.get("describe")!.run({ agent: h.agent, args: "apropos", print: (l) => out.push(l) });
  assert.match(out.join("\n"), /command \/apropos/);
});

test("/apropos finds tools and commands by keyword", async () => {
  const h = withProbeTool();
  await h.host.use("introspect", introspect);
  const out: string[] = [];
  await h.commands.get("apropos")!.run({ agent: h.agent, args: "probing", print: (l) => out.push(l) });
  assert.match(out.join("\n"), /probe/);
});

test("describe_tool fails clearly for an unknown tool", async () => {
  const h = withProbeTool();
  await h.host.use("introspect", introspect);
  const result = await h.agent.tools.get("describe_tool")!.execute({ name: "ghost" }, fakeCtx());
  assert.equal(result.isError, true);
});

function fakeCtx() {
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
