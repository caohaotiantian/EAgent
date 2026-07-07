/**
 * `/config` command — discovery and runtime override of the config surface.
 *
 * Invariant: the command reads and writes the *injected* `e.config`, so
 * `/config set` changes what every extension resolves, `/config get` reflects the
 * winning source, secrets are never printed, and `EAGENT_CONFIG=off` makes it
 * inert.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { Agent } from "../src/kernel/agent.js";
import { CommandRegistry } from "../src/kernel/commands.js";
import { ExtensionHost } from "../src/kernel/extension.js";
import { MemoryStore } from "../src/kernel/store.js";
import { LayeredConfig } from "../src/config.js";
import configCmd from "../src/extensions/config-cmd.js";

const touched: string[] = [];
afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
});

/** Activate config-cmd on a fresh host with an in-memory config, returning a
 *  runner that invokes `/config <args>` and captures printed lines. */
async function harness(config = new LayeredConfig({ overrideStore: new MemoryStore() })) {
  const agent = new Agent();
  const commands = new CommandRegistry();
  const host = new ExtensionHost({ agent, commands, config });
  await host.use("config", configCmd);
  const run = async (args: string): Promise<string[]> => {
    const out: string[] = [];
    await commands.get("config")!.run({ agent, args, print: (l) => out.push(l) });
    return out;
  };
  return { config, run };
}

test("/config set then get reflects the override and its source", async () => {
  const { run } = await harness();
  let out = await run("set subagents.maxTurns 3");
  assert.match(out.join("\n"), /set subagents\.maxTurns = 3/);
  out = await run("get subagents.maxTurns");
  assert.match(out.join("\n"), /subagents\.maxTurns = 3 \[override\]/);
});

test("/config set of an enablement key changes enabled()", async () => {
  const { config, run } = await harness();
  assert.equal(config.enabled("compact", { default: false }), false);
  await run("set compact true");
  assert.equal(config.enabled("compact", { default: false }), true);
});

test("/config list hides secret-substring keys", async () => {
  const { run } = await harness();
  await run("set my.apiKey sekret");
  const out = (await run("list")).join("\n");
  assert.match(out, /my\.apiKey/);
  assert.doesNotMatch(out, /sekret/);
  assert.match(out, /«hidden»/);
});

test("/config get hides a secret key on the env-only fallback path", async () => {
  // An env-only secret key is not in entries() yet, so `get` must still hide it
  // (regression: it previously fell through to the raw value → exfiltration).
  touched.push("EAGENT_TOKEN");
  process.env.EAGENT_TOKEN = "supersecret";
  const { run } = await harness();
  const out = (await run("get token")).join("\n");
  assert.doesNotMatch(out, /supersecret/);
  assert.match(out, /«hidden»/);
});

test("EAGENT_CONFIG=off makes /config inert", async () => {
  touched.push("EAGENT_CONFIG");
  process.env.EAGENT_CONFIG = "off";
  const { run } = await harness();
  const out = (await run("list")).join("\n");
  assert.match(out, /disabled \(EAGENT_CONFIG=off\)/);
});
