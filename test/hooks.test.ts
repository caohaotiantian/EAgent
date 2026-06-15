import assert from "node:assert/strict";
import { test } from "node:test";

import { HookBus, setHandlerErrorReporter } from "../src/kernel/hooks.js";

type Events = { ping: { n: number } };
type Filters = { refine: { value: number; context: { base: number } } };

test("events fire in registration order and await handlers", async () => {
  const bus = new HookBus<Events, Filters>();
  const seen: number[] = [];
  bus.on("ping", async (p) => {
    await Promise.resolve();
    seen.push(p.n * 1);
  });
  bus.on("ping", (p) => {
    seen.push(p.n * 2);
  });
  await bus.emit("ping", { n: 10 });
  assert.deepEqual(seen, [10, 20]);
});

test("a throwing event handler does not abort the others", async () => {
  setHandlerErrorReporter(() => {});
  const bus = new HookBus<Events, Filters>();
  const seen: string[] = [];
  bus.on("ping", () => {
    throw new Error("boom");
  });
  bus.on("ping", () => {
    seen.push("survived");
  });
  await bus.emit("ping", { n: 1 });
  assert.deepEqual(seen, ["survived"]);
  setHandlerErrorReporter((event, err) => console.error(event, err));
});

test("filters thread the value through each handler", async () => {
  const bus = new HookBus<Events, Filters>();
  bus.filter("refine", (v, ctx) => v + ctx.base);
  bus.filter("refine", (v) => v * 2);
  const result = await bus.apply("refine", 1, { base: 4 });
  assert.equal(result, (1 + 4) * 2);
});

test("filters can short-circuit via shouldStop", async () => {
  const bus = new HookBus<Events, Filters>();
  let secondRan = false;
  bus.filter("refine", () => 99);
  bus.filter("refine", (v) => {
    secondRan = true;
    return v;
  });
  const result = await bus.apply("refine", 0, { base: 0 }, (v) => v === 99);
  assert.equal(result, 99);
  assert.equal(secondRan, false);
});

test("disposing a listener removes it", async () => {
  const bus = new HookBus<Events, Filters>();
  let count = 0;
  const d = bus.on("ping", () => {
    count++;
  });
  await bus.emit("ping", { n: 1 });
  d.dispose();
  await bus.emit("ping", { n: 1 });
  assert.equal(count, 1);
});
