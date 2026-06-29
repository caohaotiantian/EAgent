/**
 * self-improve — the bounded, human-checkpointed propose→veto→evaluate→adopt
 * harness. All offline: the evaluator is injected via `setEvaluator` (the real
 * sandboxed subprocess is integration-only) and the human gate is driven by a
 * stub `ui.ask` exactly as `ask.test.ts` does. Tools are exercised through the
 * real registry (`host.use` + `agent.run` + a scripted MockProvider), so the
 * capability dispatch and `ui.ask` path are the production ones.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { UI } from "../src/kernel/types.js";
import { makeHarness, type Harness } from "./helpers.js";
import { BUILTIN_EXTENSIONS } from "../src/host.js";
import selfImprove, { setEvaluator, vetoCandidate } from "../src/extensions/self-improve.js";

const CLEAN_CANDIDATE = [
  "export default function activate(e) {",
  "  e.registerTool({",
  '    spec: { name: "candidate_tool", description: "candidate", parameters: { type: "object", properties: {} } },',
  '    execute: async () => ({ content: "candidate ok" }),',
  "  });",
  "}",
  "",
].join("\n");

const VETOED_SOURCE = 'export default function activate(e){ e.grantCapability("fs:write"); }';

async function makeSI(opts: { ui?: UI; enabled?: boolean } = {}): Promise<{
  h: Harness;
  store: ReturnType<Harness["host"]["storeFor"]>;
  candidatesDir: string;
  liveDir: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "eagent-si-"));
  const candidatesDir = join(root, "candidates");
  const liveDir = join(root, "extensions");
  mkdirSync(candidatesDir, { recursive: true });
  mkdirSync(liveDir, { recursive: true });
  const h = makeHarness({ ui: opts.ui });
  await h.host.use("self-improve", selfImprove);
  const store = h.host.storeFor("self-improve");
  store.set("candidatesDir", candidatesDir);
  store.set("extensionsDir", liveDir);
  if (opts.enabled !== false) store.set("enabled", true);
  return { h, store, candidatesDir, liveDir };
}

/** Drive one tool call through the real loop (the ask.test.ts pattern). */
async function runTool(h: Harness, name: string, args: Record<string, unknown>): Promise<void> {
  h.provider.script([{ toolCalls: [{ name, arguments: args }] }, { text: "done" }]);
  h.agent.clear();
  await h.agent.run("go");
}

// -- AC-3: static veto --------------------------------------------------------

test("vetoCandidate rejects forbidden source patterns and passes clean code (AC-3)", () => {
  assert.equal(vetoCandidate(CLEAN_CANDIDATE).ok, true, "a clean candidate is not vetoed");
  for (const bad of [
    'export default function activate(e){ const s = readFileSync("test/foo.eval.json"); }',
    'export default function activate(e){ const s = readFileSync("evals/foo.eval.json"); }',
    VETOED_SOURCE,
    'export default function activate(e){ e.loadExtension("/x"); }',
    'export default function activate(e){ process.exit(1); }',
    'export default function activate(e){ process.env.PATH = ""; }',
    'import { spawn } from "node:child_process";\nexport default function activate(e){}',
    "export function activate(e){}",
  ]) {
    const v = vetoCandidate(bad);
    assert.equal(v.ok, false, `should veto: ${bad}`);
    assert.ok(v.reasons.length > 0, "a veto records at least one reason");
  }
});

test("propose_improvement stages clean code and vetoes forbidden code (AC-3)", async () => {
  const { h, store, candidatesDir } = await makeSI();
  await runTool(h, "propose_improvement", { name: "good", code: CLEAN_CANDIDATE, rationale: "ship it" });
  await runTool(h, "propose_improvement", { name: "bad", code: VETOED_SOURCE, rationale: "nope" });

  const list = store.get<{ slug: string; status: string; reasons?: string[] }[]>("candidates") ?? [];
  const good = list.find((c) => c.slug === "good");
  const bad = list.find((c) => c.slug === "bad");
  assert.equal(good?.status, "staged", "clean candidate is staged");
  assert.equal(bad?.status, "vetoed", "forbidden candidate is vetoed");
  assert.ok((bad?.reasons?.length ?? 0) > 0, "vetoed candidate carries reasons");
  assert.ok(existsSync(join(candidatesDir, "good.ts")), "the staged candidate is written to disk");
  assert.ok(!existsSync(join(candidatesDir, "bad.ts")), "a vetoed candidate is never written");
});

// -- AC-4: no live load during eval -------------------------------------------

test("evaluate_candidate records a delta but never loads the candidate live (AC-4)", async () => {
  setEvaluator(async () => ({ baseline: 1, candidate: 2, delta: 1, improved: true, tamper: false }));
  const { h, store } = await makeSI();
  await runTool(h, "propose_improvement", { name: "cand", code: CLEAN_CANDIDATE, rationale: "x" });
  const before = [...h.host.list()];
  await runTool(h, "evaluate_candidate", { name: "cand" });

  const rec = (store.get<{ slug: string; status: string; delta?: number }[]>("candidates") ?? []).find(
    (c) => c.slug === "cand",
  );
  assert.equal(rec?.status, "evaluated", "the candidate is marked evaluated");
  assert.equal(rec?.delta, 1, "the advisory delta is recorded");
  assert.equal(h.agent.tools.get("candidate_tool"), undefined, "the candidate's tool is never loaded live during eval");
  assert.deepEqual([...h.host.list()], before, "the live extension set is unchanged by evaluation");
});

// -- AC-5: human gate via ui.ask, not yolo-able -------------------------------

test("adopt_improvement loads the candidate when ui.ask confirms (AC-5)", async () => {
  const ui: UI = { confirm: async () => true, notify: () => {}, ask: async () => "yes" };
  const { h, store } = await makeSI({ ui });
  await runTool(h, "propose_improvement", { name: "cand", code: CLEAN_CANDIDATE, rationale: "x" });
  await runTool(h, "adopt_improvement", { name: "cand" });

  assert.ok(h.agent.tools.get("candidate_tool"), "an approved candidate's tool appears live");
  const rec = (store.get<{ slug: string; status: string }[]>("candidates") ?? []).find((c) => c.slug === "cand");
  assert.equal(rec?.status, "adopted", "the candidate is marked adopted");
});

test("adopt_improvement fails closed when ui.ask returns null (AC-5)", async () => {
  const ui: UI = { confirm: async () => true, notify: () => {}, ask: async () => null };
  const { h } = await makeSI({ ui });
  await runTool(h, "propose_improvement", { name: "cand", code: CLEAN_CANDIDATE, rationale: "x" });
  await runTool(h, "adopt_improvement", { name: "cand" });

  assert.equal(h.agent.tools.get("candidate_tool"), undefined, "a null ask must not adopt");
});

test("adopt_improvement fails closed when the UI cannot ask (yolo/headless) (AC-5)", async () => {
  // confirm always true (a yolo-style auto-approve) but no `ask`: must NOT adopt.
  const ui: UI = { confirm: async () => true, notify: () => {} };
  const { h } = await makeSI({ ui });
  await runTool(h, "propose_improvement", { name: "cand", code: CLEAN_CANDIDATE, rationale: "x" });
  await runTool(h, "adopt_improvement", { name: "cand" });

  assert.equal(h.agent.tools.get("candidate_tool"), undefined, "no ask (and confirm is not a substitute) → not adopted");
});

// -- AC-6: tamper-detection ---------------------------------------------------

test("evaluate_candidate flags tamper and does not treat it as a valid improvement (AC-6)", async () => {
  setEvaluator(async () => ({ baseline: 1, candidate: 5, delta: 4, improved: true, tamper: true }));
  const { h, store } = await makeSI();
  await runTool(h, "propose_improvement", { name: "cand", code: CLEAN_CANDIDATE, rationale: "x" });
  await runTool(h, "evaluate_candidate", { name: "cand" });

  const rec = (store.get<{ slug: string; improved?: boolean; tamper?: boolean }[]>("candidates") ?? []).find(
    (c) => c.slug === "cand",
  );
  assert.equal(rec?.tamper, true, "a tampered eval is flagged");
  assert.notEqual(rec?.improved, true, "a tampered result is not treated as a valid improvement");
});

// -- AC-7: off-by-default inert + unload-removable + canonical-set green -------

test("off-by-default: the tools are inert until enabled, and self-improve is in the canonical set (AC-7)", async () => {
  assert.ok(
    BUILTIN_EXTENSIONS.some(([id]) => id === "self-improve"),
    "self-improve is registered in BUILTIN_EXTENSIONS",
  );
  const { h, store, candidatesDir } = await makeSI({ enabled: false });
  await runTool(h, "propose_improvement", { name: "cand", code: CLEAN_CANDIDATE, rationale: "x" });
  assert.deepEqual(store.get("candidates") ?? [], [], "a disabled propose stages nothing");
  assert.ok(!existsSync(join(candidatesDir, "cand.ts")), "a disabled propose writes no file");
});

test("an adopted candidate is unloadExtension-removable (AC-7)", async () => {
  const ui: UI = { confirm: async () => true, notify: () => {}, ask: async () => "y" };
  const { h } = await makeSI({ ui });
  await runTool(h, "propose_improvement", { name: "cand", code: CLEAN_CANDIDATE, rationale: "x" });
  await runTool(h, "adopt_improvement", { name: "cand" });
  assert.ok(h.agent.tools.get("candidate_tool"), "loaded after adopt");

  await h.host.unload("cand");
  assert.equal(h.agent.tools.get("candidate_tool"), undefined, "unload removes the adopted candidate's tool");
});
