/**
 * self-improve — the bounded, human-checkpointed propose→veto→evaluate→adopt
 * harness. All offline: the evaluator is injected via `setEvaluator` (the real
 * sandboxed subprocess is integration-only) and the human gate is driven by a
 * stub `ui.ask` exactly as `ask.test.ts` does. Tools are exercised through the
 * real registry (`host.use` + `agent.run` + a scripted MockProvider), so the
 * capability dispatch and `ui.ask` path are the production ones.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";

import type { Agent } from "../src/kernel/agent.js";
import type { ToolResultBlock, UI } from "../src/kernel/types.js";
import { makeHarness, type Harness } from "./helpers.js";
import { BUILTIN_EXTENSIONS } from "../src/host.js";
import selfImprove, {
  EVAL_RUNNER_PATH,
  hashFixtures,
  parseScorecard,
  runScored,
  setEvaluator,
  setSpawn,
  vetoCandidate,
} from "../src/extensions/self-improve.js";

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

async function makeSI(opts: { ui?: UI; enabled?: boolean; fallback?: "allow" | "deny" | "ask" } = {}): Promise<{
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
  const h = makeHarness({ ui: opts.ui, fallback: opts.fallback });
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

/** The most recent tool_result block in the transcript (capability/deny assertions). */
function lastToolResult(agent: Agent): ToolResultBlock {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i]!;
    if (m.role !== "tool") continue;
    const block = m.content[0];
    if (block && block.type === "tool_result") return block;
  }
  throw new Error("no tool_result found in transcript");
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

// -- AC-B1: the human-review gate actually shows the reviewer the source -------

test("adopt_improvement folds the candidate source + advisory into the ui.ask prompt (AC-B1)", async () => {
  let captured = "";
  const ui: UI = {
    confirm: async () => true,
    notify: () => {},
    ask: async (q) => {
      captured = q;
      return "yes";
    },
  };
  setEvaluator(async () => ({ baseline: 1, candidate: 2, delta: 1, improved: true, tamper: false }));
  const { h } = await makeSI({ ui });
  await runTool(h, "propose_improvement", { name: "cand", code: CLEAN_CANDIDATE, rationale: "x" });
  await runTool(h, "evaluate_candidate", { name: "cand" });
  await runTool(h, "adopt_improvement", { name: "cand" });

  assert.ok(captured.includes(CLEAN_CANDIDATE), "the consent prompt the human answers contains the full candidate source");
  assert.match(captured, /delta=1/, "the consent prompt carries the advisory eval delta");
  assert.ok(h.agent.tools.get("candidate_tool"), "a 'yes' to the source-bearing prompt adopts the candidate");
});

// -- AC-D2: the evaluator is async and honors an aborted signal promptly -------

test("runScored rejects promptly on an already-aborted signal, never spawning an unwired child (AC-D2)", async () => {
  // Mirror node's real `spawn`: handed an already-aborted signal it emits an
  // async 'error' (AbortError) on the child. The crash this guards against was
  // runScored returning before attaching an 'error' listener, leaving that
  // AbortError unhandled — an EventEmitter 'error' with no listener throws as an
  // uncaughtException and kills the host. The fix is to not spawn under an
  // already-aborted signal at all, so this faithful fake's child is never made.
  let spawned = false;
  setSpawn((_cmd, opts) => {
    spawned = true;
    const child = Object.assign(new EventEmitter(), { stdout: null, kill: () => {} });
    if ((opts.signal as AbortSignal | undefined)?.aborted) {
      queueMicrotask(() => child.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
    }
    return child as never;
  });
  const ac = new AbortController();
  ac.abort();
  const start = Date.now();
  await assert.rejects(() => runScored("none", "/cand", "/fix", "/root", "/cwd", ac.signal), /abort/i);
  // Drain the microtask/timer queue: on the buggy path the queued AbortError
  // would fire here with no listener and crash the process.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!spawned, "no child is spawned under an already-aborted signal (its async AbortError would be unhandled)");
  assert.ok(Date.now() - start < 1000, "it rejects at once, not after the 120s timeout");
});

// -- AC-D3: the runner path comes from import.meta.url, not the process cwd -----

test("EVAL_RUNNER_PATH derives from import.meta.url and is cwd-independent (AC-D3)", () => {
  assert.ok(isAbsolute(EVAL_RUNNER_PATH), "the runner path is absolute (resolved from import.meta.url, not cwd)");
  assert.ok(EVAL_RUNNER_PATH.endsWith("self-improve-eval.ts"), "resolves to the sibling self-improve-eval.ts module");
});

// -- AC-D4: a failed adopt-load is reverted to staging, leaving no live orphan --

const THROWING_CANDIDATE = ['export default function activate(e) {', '  throw new Error("activation boom");', "}", ""].join(
  "\n",
);

test("adopt_improvement reverts a failed load back to staging, leaving no live orphan (AC-D4)", async () => {
  const ui: UI = { confirm: async () => true, notify: () => {}, ask: async () => "yes" };
  const { h, store, candidatesDir, liveDir } = await makeSI({ ui });
  await runTool(h, "propose_improvement", { name: "boom", code: THROWING_CANDIDATE, rationale: "x" });
  await runTool(h, "adopt_improvement", { name: "boom" });

  const stagedPath = join(candidatesDir, "boom.ts");
  const livePath = join(liveDir, "boom.ts");
  assert.ok(existsSync(stagedPath), "the reviewed source is moved back to staging after the load fails");
  assert.ok(!existsSync(livePath), "no orphan is left in the live (host auto-discovered) dir");
  const rec = (store.get<{ slug: string; status: string }[]>("candidates") ?? []).find((c) => c.slug === "boom");
  assert.notEqual(rec?.status, "adopted", "a failed load does not mark the candidate adopted");

  // A second attempt still finds the staged file (it never fails at the read step).
  await runTool(h, "adopt_improvement", { name: "boom" });
  assert.ok(existsSync(stagedPath), "the staged file remains available for a retry");
});

// -- AC-D5: evaluate runs candidate code, so it is gated on code:exec ----------

test("evaluate_candidate is gated on code:exec and a deny policy blocks it (AC-D5)", async () => {
  setEvaluator(async () => {
    throw new Error("evaluator must not run when code:exec is denied");
  });
  const { h, store } = await makeSI({ fallback: "deny" });
  h.agent.capabilities.grant("self:extend"); // allow staging; the fallback denies only code:exec

  const tool = h.agent.tools.get("evaluate_candidate");
  assert.ok(tool?.capabilities?.includes("code:exec"), "evaluate_candidate declares the code:exec capability");

  await runTool(h, "propose_improvement", { name: "cand", code: CLEAN_CANDIDATE, rationale: "x" });
  await runTool(h, "evaluate_candidate", { name: "cand" });

  const result = lastToolResult(h.agent);
  assert.equal(result.isError, true, "a denied code:exec blocks evaluate_candidate");
  assert.match(result.content, /denied|capability/i, "the block is a capability denial, not the evaluator running");
  const rec = (store.get<{ slug: string; status: string }[]>("candidates") ?? []).find((c) => c.slug === "cand");
  assert.notEqual(rec?.status, "evaluated", "a blocked evaluate records no result");
});

// -- AC-D6: the previously-untested production glue is pinned offline ----------

test("parseScorecard reads the `eval: X/Y passed` scorecard line (AC-D6)", () => {
  assert.deepEqual(parseScorecard("noise\neval: 3/5 passed\ntrailing"), { passed: 3, total: 5 });
  assert.deepEqual(parseScorecard("eval: 0/0 passed"), { passed: 0, total: 0 });
  assert.deepEqual(parseScorecard("no scorecard here"), { passed: 0, total: 0 });
});

test("hashFixtures is deterministic and detects a content change (AC-D6)", () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-hashfix-"));
  writeFileSync(join(dir, "a.txt"), "alpha");
  writeFileSync(join(dir, "b.txt"), "beta");
  const h1 = hashFixtures(dir);
  assert.equal(hashFixtures(dir), h1, "hashing the same fixtures twice is stable");
  writeFileSync(join(dir, "b.txt"), "BETA");
  assert.notEqual(hashFixtures(dir), h1, "a content change flips the hash (this is the tamper signal)");
  rmSync(dir, { recursive: true, force: true });
});

test("runScored assembles the import.meta.url runner command and parses the scorecard (AC-D6)", async () => {
  let captured = "";
  setSpawn((command) => {
    captured = command;
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout, kill: () => {} });
    queueMicrotask(() => {
      stdout.emit("data", Buffer.from("eval: 4/9 passed\n"));
      child.emit("close", 0);
    });
    return child as never;
  });
  const passed = await runScored("none", "/cand/dir", "/fix/dir", "/staging/root", "/work/dir");
  assert.equal(passed, 4, "runScored returns the parsed passed count");
  assert.match(captured, /node --import tsx/, "the command spawns the tsx runner");
  assert.ok(captured.includes(EVAL_RUNNER_PATH), "the command uses the import.meta.url-resolved runner path");
  assert.ok(
    captured.includes("/cand/dir") && captured.includes("/fix/dir") && captured.includes("/staging/root"),
    "the command passes candidateDir, fixturesDir, and the staging root",
  );
});
