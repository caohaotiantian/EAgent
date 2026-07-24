/**
 * Phase 1 — the attribution linchpin (AC1b / T1.9), end-to-end on the REAL bus.
 *
 * A reasoning-search-shaped harness runs 2 real `childScope()` forks under
 * `Promise.allSettled` (mirroring src/extensions/reasoning-search.ts:172-181,
 * 274-276), wired through `wireViewModel` using the REAL `currentActingAgent()`.
 * The resulting model must de-interleave by fork with no cross-fork mixing —
 * proving out-of-band ALS attribution separates concurrent streaming deltas.
 * RED if attribution were stubbed to the root id (both forks would merge).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "../src/kernel/agent.js";
import { ProviderRegistry } from "../src/kernel/registry.js";
import { defineTool, ok } from "../src/kernel/define.js";
import { MockProvider } from "../src/providers/mock.js";
import { wireViewModel } from "../src/attribution.js";
import type { Section, ToolSection, ViewModel } from "../src/view-model.js";
import { makeHarness } from "./helpers.js";

test("T1.9 real childScope forks de-interleave by acting agent with no cross-fork mixing", async () => {
  const { agent: parent, provider: rootProvider } = makeHarness();

  // A fork shares the parent's governed bus (childScope) but streams its OWN,
  // recognizable content; the mock chunks it so the two forks' deltas interleave.
  const mkChild = (tag: string): Agent =>
    new Agent({
      providers: (() => {
        const p = new ProviderRegistry();
        p.register(new MockProvider({ reasoning: tag.repeat(60), text: tag.repeat(20) }), { default: true });
        return p;
      })(),
      hooks: parent.hooks.childScope(),
      capabilities: parent.capabilities,
      model: "mock",
      provider: "mock",
    });

  const forkTool = defineTool({
    name: "best_of_n",
    description: "fork two children concurrently",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const a = mkChild("A");
      const b = mkChild("B");
      await Promise.allSettled([a.run("task"), b.run("task")]);
      return ok("forked");
    },
  });
  parent.tools.register(forkTool);
  rootProvider.script((_req, i) => (i === 0 ? { toolCalls: [{ name: "best_of_n" }] } : { text: "final answer" }));

  let model: ViewModel | undefined;
  let counter = 0;
  wireViewModel(parent, (m) => (model = m), { now: () => counter++ });

  await parent.run("start");

  assert.ok(model, "the wire produced a model");
  const card = model!.sections.find((s): s is ToolSection => s.kind === "tool" && s.name === "best_of_n");
  assert.ok(card, "the best_of_n card exists at top level");

  const textSecs = card!.children.filter(
    (c): c is Extract<Section, { text: string }> => c.kind === "reasoning" || c.kind === "answer",
  );
  assert.ok(textSecs.length >= 2, "each fork nested its own sub-section(s) under the card");

  // Two distinct fork identities are represented.
  const ids = new Set(card!.children.map((c) => c.actingId));
  assert.ok(ids.size >= 2, `two distinct fork identities nested (${ids.size})`);
  assert.ok(![...ids].includes(model!.rootId ?? "root"), "fork sub-sections are NOT attributed to the root");

  // The de-interleaving invariant: every sub-section is homogeneous (all A or all
  // B) — impossible if concurrent deltas had been merged into one root buffer.
  for (const s of textSecs) {
    assert.ok(/^A+$/.test(s.text) || /^B+$/.test(s.text), `sub-section is single-fork, not mixed: ${JSON.stringify(s.text.slice(0, 12))}`);
  }
  // Both forks are actually present.
  assert.ok(textSecs.some((s) => s.text.startsWith("A")), "forkA content present");
  assert.ok(textSecs.some((s) => s.text.startsWith("B")), "forkB content present");
});
