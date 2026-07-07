/**
 * The host sources agent defaults from config end-to-end.
 *
 * Invariant: `createAgentHost` resolves `agent.maxTurns` (and its siblings)
 * through `e.config`, so setting `EAGENT_AGENT_MAX_TURNS` (the derived legacy env
 * name) changes the constructed agent's bound, and the code default holds when
 * unset. Offline: forces the mock provider so no API key is needed.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createAgentHost } from "../src/host.js";

const touched: string[] = [];
afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
});

test("agent.maxTurns defaults to 24 when unset", async () => {
  const { agent, host } = await createAgentHost({ provider: "mock" });
  assert.equal(agent.maxTurns, 24);
  await host.dispose();
});

test("EAGENT_AGENT_MAX_TURNS overrides the constructed agent's bound", async () => {
  touched.push("EAGENT_AGENT_MAX_TURNS");
  process.env.EAGENT_AGENT_MAX_TURNS = "5";
  const { agent, host } = await createAgentHost({ provider: "mock" });
  assert.equal(agent.maxTurns, 5);
  await host.dispose();
});
