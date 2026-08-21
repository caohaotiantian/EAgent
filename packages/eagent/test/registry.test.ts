import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../src/kernel/define.ts";
import { ProviderRegistry, ToolRegistry } from "../src/kernel/registry.ts";
import { MockProvider } from "../src/providers/mock.ts";

test("a later tool registration shadows the earlier; disposing restores it", () => {
  const reg = new ToolRegistry();
  const v1 = defineTool({ name: "t", description: "v1", execute: () => ({ content: "v1" }) });
  const v2 = defineTool({ name: "t", description: "v2", execute: () => ({ content: "v2" }) });
  const d1 = reg.register(v1);
  assert.equal(reg.get("t")?.spec.description, "v1");
  const d2 = reg.register(v2);
  assert.equal(reg.get("t")?.spec.description, "v2");
  d2.dispose();
  assert.equal(reg.get("t")?.spec.description, "v1", "disposing the top restores the previous definition");
  d1.dispose();
  assert.equal(reg.has("t"), false);
});

test("tools are listed sorted by name", () => {
  const reg = new ToolRegistry();
  reg.register(defineTool({ name: "b", description: "", execute: () => ({ content: "" }) }));
  reg.register(defineTool({ name: "a", description: "", execute: () => ({ content: "" }) }));
  assert.deepEqual(reg.list().map((t) => t.spec.name), ["a", "b"]);
});

test("provider registry tracks a default and recovers when it is removed", () => {
  const reg = new ProviderRegistry();
  const a = new MockProvider();
  const b = new MockProvider();
  Object.defineProperty(b, "name", { value: "mock2" });
  const da = reg.register(a, { default: true });
  reg.register(b);
  assert.equal(reg.get()?.name, "mock");
  da.dispose();
  assert.equal(reg.get()?.name, "mock2", "removing the default falls back to a remaining provider");
});
