import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Agent } from "../src/kernel/agent.js";
import { defineTool, ok } from "../src/kernel/define.js";
import type { ExtensionAPI } from "../src/kernel/extension.js";
import { ProviderRegistry, ToolRegistry } from "../src/kernel/registry.js";
import { MockProvider } from "../src/providers/mock.js";
import { makeHarness } from "./helpers.js";

test("an inline extension registers tools, commands, and hooks", async () => {
  const { agent, host, commands } = makeHarness();
  await host.use("demo", (e: ExtensionAPI) => {
    e.registerTool(defineTool({ name: "demo_tool", description: "", execute: () => ({ content: "ok" }) }));
    e.registerCommand({ name: "demo_cmd", description: "", run: (ctx) => ctx.print("hi") });
    e.on("turn_end", () => {});
  });
  assert.ok(agent.tools.has("demo_tool"));
  assert.ok(commands.get("demo_cmd"));
  assert.ok(host.has("demo"));
});

test("unloading an extension disposes every registration", async () => {
  const { agent, host, commands } = makeHarness();
  await host.use("demo", (e: ExtensionAPI) => {
    e.registerTool(defineTool({ name: "demo_tool", description: "", execute: () => ({ content: "ok" }) }));
    e.registerCommand({ name: "demo_cmd", description: "", run: () => {} });
  });
  await host.unload("demo");
  assert.equal(agent.tools.has("demo_tool"), false);
  assert.equal(commands.get("demo_cmd"), undefined);
  assert.equal(host.has("demo"), false);
});

test("a granted capability is torn down on unload like every other registration", async () => {
  // fallback:"deny" so isGranted reports false for an ungranted cap — the default
  // allow harness would report true even after a correct revoke.
  const { agent, host } = makeHarness({ fallback: "deny" });
  await host.use("granter", (e: ExtensionAPI) => {
    e.grantCapability("ext:cap");
  });
  assert.equal(agent.capabilities.isGranted("ext:cap"), true);
  await host.unload("granter");
  assert.equal(agent.capabilities.isGranted("ext:cap"), false, "the grant must be revoked on unload");
});

test("a granted capability is re-granted (not leaked) across a reload", async () => {
  const { agent, host } = makeHarness({ fallback: "deny" });
  await host.use("granter", (e: ExtensionAPI) => {
    e.grantCapability("ext:cap");
  });
  await host.reload("granter");
  // The reload re-invokes the inline factory, so the grant is present again —
  // and, crucially, not doubly-held: a single unload fully revokes it.
  assert.equal(agent.capabilities.isGranted("ext:cap"), true);
  await host.unload("granter");
  assert.equal(agent.capabilities.isGranted("ext:cap"), false, "reload must not leak a second grant");
});

test("a failed activation leaves no half-wired registrations", async () => {
  const { agent, host, commands } = makeHarness();
  await assert.rejects(() =>
    host.use("boom", (e: ExtensionAPI) => {
      e.registerTool(defineTool({ name: "ghost_tool", description: "", execute: () => ({ content: "" }) }));
      e.registerCommand({ name: "ghost_cmd", description: "", run: () => {} });
      throw new Error("activation failed");
    }),
  );
  assert.equal(agent.tools.has("ghost_tool"), false, "partial tool registration must be undone");
  assert.equal(commands.get("ghost_cmd"), undefined, "partial command registration must be undone");
  assert.equal(host.has("boom"), false);
});

test("reload tears down the old version and brings up a fresh one", async () => {
  const { host, agent } = makeHarness();
  let activations = 0;
  const factory = (e: ExtensionAPI) => {
    const generation = ++activations;
    e.registerTool(
      defineTool({ name: "gen", description: "", execute: () => ({ content: String(generation) }) }),
    );
  };
  await host.use("gen-ext", factory);

  // Note: host.use stores the inline factory, so reload re-invokes it.
  await host.reload("gen-ext");

  // Exactly one "gen" tool should exist (old disposed), reporting generation 2.
  assert.equal(agent.tools.list().filter((t) => t.spec.name === "gen").length, 1);
  const result = await agent.tools.get("gen")!.execute({}, fakeCtx());
  assert.equal(result.content, "2");
  assert.equal(activations, 2);
});

test("a later same-id activation tears down the earlier one (later wins, no leak)", async () => {
  const { host, agent } = makeHarness();
  const fired: string[] = [];
  await host.use("dup", (e: ExtensionAPI) => {
    e.registerTool(defineTool({ name: "dup_v1", description: "", execute: () => ({ content: "v1" }) }));
    e.on("turn_start", () => {
      fired.push("v1");
    });
  });
  // Re-activate under the same id (the discover() "later wins" collision path).
  await host.use("dup", (e: ExtensionAPI) => {
    e.registerTool(defineTool({ name: "dup_v2", description: "", execute: () => ({ content: "v2" }) }));
    e.on("turn_start", () => {
      fired.push("v2");
    });
  });
  assert.equal(agent.tools.has("dup_v1"), false, "the earlier tool must be removed, not just shadowed");
  assert.ok(agent.tools.has("dup_v2"));
  await agent.hooks.emit("turn_start", { turn: 1 });
  assert.deepEqual(fired, ["v2"], "the earlier extension's hook must not still fire");
});

test("session lifecycle events fire around a reload", async () => {
  const { host, agent } = makeHarness();
  const events: string[] = [];
  agent.hooks.on("session_shutdown", () => {
    events.push("down");
  });
  agent.hooks.on("session_start", () => {
    events.push("up");
  });
  agent.hooks.on("reload", () => {
    events.push("reload");
  });
  await host.use("x", () => {});
  await host.reload();
  assert.deepEqual(events, ["down", "reload", "up"]);
});

test("loadFile loads a TypeScript extension via jiti and reload re-evaluates it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-ext-"));
  const file = join(dir, "live.ts");
  writeFileSync(file, extSource("first"));

  const { host, agent } = makeHarness();
  const id = await host.loadFile(file);
  assert.equal(id, "live");
  let result = await agent.tools.get("live_tool")!.execute({}, fakeCtx());
  assert.equal(result.content, "first");

  // Live redefinition: edit the source on disk, hot-reload, observe new behavior.
  writeFileSync(file, extSource("second"));
  await host.reload("live");
  result = await agent.tools.get("live_tool")!.execute({}, fakeCtx());
  assert.equal(result.content, "second", "reload should pick up the edited source");
});

function extSource(value: string): string {
  return `
import { defineTool } from ${JSON.stringify(srcPath("kernel/define.ts"))};
export default function activate(e) {
  e.registerTool(defineTool({ name: "live_tool", description: "", execute: () => ({ content: ${JSON.stringify(value)} }) }));
}
`;
}

function srcPath(rel: string): string {
  return join(process.cwd(), "src", rel);
}

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

test("e.agent resolves to the acting agent during a run and to host.agent at activation; e.rootAgent is the run-tree root", async () => {
  const { agent: parent, host } = makeHarness({ fallback: "allow" });

  let atActivation: unknown;
  let actingAtLeaf: unknown;
  let rootAtLeaf: unknown;
  await host.use("probe", (e: ExtensionAPI) => {
    atActivation = e.agent;
    e.on("tool_start", ({ call }) => {
      // Record only when the CHILD's leaf tool starts, so the acting agent is the
      // fork (not the parent) and the root is the parent.
      if (call.name === "leaf") {
        actingAtLeaf = e.agent;
        rootAtLeaf = e.rootAgent;
      }
    });
  });
  assert.equal(atActivation, parent, "at activation e.agent resolves to host.agent");

  const leaf = defineTool({ name: "leaf", description: "x", parameters: { type: "object", properties: {} }, execute: () => ok("ok") });
  const childTools = new ToolRegistry();
  childTools.register(leaf);
  const childProviders = new ProviderRegistry();
  childProviders.register(
    new MockProvider((req) => (req.messages.some((m) => m.role === "tool") ? { text: "child-done" } : { toolCalls: [{ name: "leaf", arguments: {} }] })),
    { default: true },
  );

  const fork = defineTool({
    name: "fork",
    description: "x",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const child = new Agent({
        providers: childProviders,
        tools: childTools,
        hooks: parent.hooks.childScope(),
        capabilities: parent.capabilities,
        model: "mock",
        provider: "mock",
      });
      await child.run("go");
      return ok("forked");
    },
  });
  parent.tools.register(fork);
  parent.providers.register(
    new MockProvider((req) => (req.messages.some((m) => m.role === "tool") ? { text: "parent-done" } : { toolCalls: [{ name: "fork", arguments: {} }] })),
    { default: true },
  );

  await parent.run("start");

  assert.ok(actingAtLeaf, "the leaf tool_start observer fired inside the fork");
  assert.notEqual(actingAtLeaf, parent, "during the fork e.agent resolves to the acting (child) agent, not host.agent");
  assert.equal(rootAtLeaf, parent, "during the fork e.rootAgent resolves to the run-tree root (the parent)");
});
