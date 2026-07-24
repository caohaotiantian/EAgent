/**
 * The pure view-model reducer + display controls.
 *
 * reduce:        fork de-interleaving & order; single-parent nesting +
 *                drift-proof classifier (KDD10); full-payload retention;
 *                auto-collapsed transitions.
 * applyControl:  /details full|collapsed|auto collapse semantics; per-section
 *                /expand n, /collapse n.
 * source-scan:   the anti-truncation guard — the only display elision is a named
 *                summary-width constant, used solely for collapsed headers.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  applyControl,
  initialModel,
  reduce,
  type RenderEvent,
  type ToolSection,
  type ViewModel,
} from "../src/view-model.js";
import type { ToolCallBlock, ToolResult } from "../src/kernel/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const call = (name: string, id: string, args: Record<string, unknown> = {}): ToolCallBlock => ({
  type: "tool_call",
  id,
  name,
  arguments: args,
});
const result = (content: string, isError = false): ToolResult => ({ content, isError });

/** Fold a scripted stream into the model, tagging each event with its acting id. */
function fold(events: Array<{ ev: RenderEvent; acting?: string }>, root = "root"): ViewModel {
  let m = initialModel();
  // agent_start resets and stamps the root id (as the real adapter does).
  m = reduce(m, { kind: "agent_start", actingId: root, rootId: root, at: 0 });
  let at = 1;
  for (const { ev, acting } of events) {
    m = reduce(m, { ...ev, actingId: acting ?? root, rootId: root, at: at++ });
  }
  return m;
}

/** A three-section run: reasoning → tool → answer, terminated cleanly. */
function threeSections(): ViewModel {
  return fold([
    { ev: { kind: "reasoning_delta", text: "thinking about it" } },
    { ev: { kind: "tool_start", call: call("read", "c1", { path: "notes.md" }) } },
    { ev: { kind: "tool_end", call: call("read", "c1", { path: "notes.md" }), result: result("file body") } },
    { ev: { kind: "text_delta", text: "the answer" } },
    { ev: { kind: "message", role: "assistant" } },
    { ev: { kind: "agent_end", reason: "end_turn" } },
  ]);
}

// -- reduce: de-interleaving, nesting, retention, auto-collapse --------------

test("concurrent forks de-interleave into their own sub-sections under one parent, in first-arrival order", () => {
  // best_of_n opens the parent card; two forks interleave their reasoning deltas.
  const m = fold([
    { ev: { kind: "tool_start", call: call("best_of_n", "c1") } },
    { ev: { kind: "reasoning_delta", text: "A1 " }, acting: "forkA" },
    { ev: { kind: "reasoning_delta", text: "B1 " }, acting: "forkB" },
    { ev: { kind: "reasoning_delta", text: "A2 " }, acting: "forkA" },
    { ev: { kind: "reasoning_delta", text: "B2 " }, acting: "forkB" },
    { ev: { kind: "reasoning_delta", text: "A3" }, acting: "forkA" },
  ]);

  // One top-level parent card, holding both fork sub-sections nested under it.
  assert.equal(m.sections.length, 1, "only the parent card is top-level");
  const parent = m.sections[0]!;
  assert.equal(parent.kind, "tool");
  assert.equal((parent as ToolSection).name, "best_of_n");
  assert.equal(parent.children.length, 2, "each fork got its OWN sub-section");

  // Ordered by first-delta arrival: forkA (A1) before forkB (B1).
  assert.equal(parent.children[0]!.actingId, "forkA");
  assert.equal(parent.children[1]!.actingId, "forkB");

  const a = parent.children[0] as { text: string };
  const b = parent.children[1] as { text: string };
  assert.equal(a.text, "A1 A2 A3", "forkA's section holds only forkA's text, in order");
  assert.equal(b.text, "B1 B2 ", "forkB's section holds only forkB's text, in order");

  // The de-interleaving invariant: no sub-section contains another fork's text.
  assert.doesNotMatch(a.text, /B/, "forkA sub-section is free of forkB text");
  assert.doesNotMatch(b.text, /A/, "forkB sub-section is free of forkA text");
});

test("a child's first delta nests under the unique open spawn-class card, even beside a non-spawn bash card", () => {
  // Two cards open concurrently: a leaf `bash` and a spawn-class `best_of_n`.
  // The child must bind to best_of_n regardless of which opened last (drift-proof).
  const m = fold([
    { ev: { kind: "tool_start", call: call("best_of_n", "c1") } },
    { ev: { kind: "tool_start", call: call("bash", "c2") } },
    { ev: { kind: "reasoning_delta", text: "child thinking" }, acting: "forkC" },
  ]);

  const bestOfN = m.sections.find((s) => s.kind === "tool" && (s as ToolSection).name === "best_of_n")!;
  const bash = m.sections.find((s) => s.kind === "tool" && (s as ToolSection).name === "bash")!;
  assert.equal(bestOfN.children.length, 1, "the child nested under best_of_n");
  assert.equal(bash.children.length, 0, "nothing nested under the leaf bash card");
  assert.equal(bestOfN.children[0]!.actingId, "forkC");
  assert.equal((bestOfN.children[0] as { text: string }).text, "child thinking");
  // The single-open case: with only one card, binding needs no name at all.
  const m2 = fold([
    { ev: { kind: "tool_start", call: call("spawn_agent", "x1") } },
    { ev: { kind: "text_delta", text: "sub answer" }, acting: "forkD" },
  ]);
  const parent = m2.sections[0]!;
  assert.equal(parent.children.length, 1);
  assert.equal(parent.children[0]!.actingId, "forkD");
});

test("a tool section retains the entire args object and every result line — the model never elides", () => {
  const bigArgs = {
    command: "x".repeat(300),
    files: Array.from({ length: 20 }, (_, i) => `file-${i}.ts`),
    nested: { deep: { value: "kept" } },
  };
  assert.ok(JSON.stringify(bigArgs).length > 200, "args exceed the 200-char summary trigger");
  const multiline = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");

  const m = fold([
    { ev: { kind: "tool_start", call: call("edit", "c1", bigArgs) } },
    { ev: { kind: "tool_end", call: call("edit", "c1", bigArgs), result: result(multiline) } },
  ]);

  const tool = m.sections[0] as ToolSection;
  assert.deepEqual(tool.arguments, bigArgs, "the ENTIRE args object is retained");
  assert.ok(tool.result, "the result is retained");
  for (const line of multiline.split("\n")) {
    assert.ok(tool.result!.content.includes(line), `result retains line: ${line}`);
  }
  assert.equal(tool.result!.content, multiline, "every result line is retained verbatim");
});

test("auto-collapsed keeps only the newest section open; the previous collapses when the next begins", () => {
  // While reasoning streams it is the only (newest) section → expanded.
  const streaming = fold([{ ev: { kind: "reasoning_delta", text: "thinking..." } }]);
  assert.equal(streaming.sections.length, 1);
  assert.equal(streaming.sections[0]!.collapsed, false, "the sole streaming section is expanded");

  // Once the answer begins, the reasoning collapses and the answer is expanded.
  const m = fold([
    { ev: { kind: "reasoning_delta", text: "thinking..." } },
    { ev: { kind: "text_delta", text: "the answer" } },
  ]);
  assert.equal(m.sections.length, 2);
  assert.equal(m.sections[0]!.kind, "reasoning");
  assert.equal(m.sections[0]!.collapsed, true, "the previous section collapsed when the next began");
  assert.equal(m.sections[1]!.kind, "answer");
  assert.equal(m.sections[1]!.collapsed, false, "the newest section stays expanded");
});

// -- applyControl: display modes + per-section controls ----------------------

test("/details full expands all sections; collapsed shows headers only; auto restores latest-expanded", () => {
  const base = threeSections();
  assert.equal(base.sections.length, 3, "three top-level sections: reasoning, tool, answer");
  assert.equal(base.mode, "auto", "the default mode is auto-collapsed");

  // full — every section expanded.
  const full = applyControl(base, { kind: "mode", mode: "full" });
  assert.equal(full.mode, "full");
  for (const s of full.sections) assert.equal(s.collapsed, false, "full expands every section");
  // Purity: the input model is untouched.
  assert.equal(base.mode, "auto", "applyControl does not mutate its input (pure)");

  // collapsed — headers only (every section collapsed).
  const collapsed = applyControl(base, { kind: "mode", mode: "collapsed" });
  assert.equal(collapsed.mode, "collapsed");
  for (const s of collapsed.sections) assert.equal(s.collapsed, true, "collapsed collapses every section");

  // auto — only the newest section stays expanded.
  const auto = applyControl(collapsed, { kind: "mode", mode: "auto" });
  assert.equal(auto.mode, "auto");
  const n = auto.sections.length;
  auto.sections.forEach((s, i) =>
    assert.equal(s.collapsed, i !== n - 1, `auto keeps only the newest section (index ${n - 1}) expanded`),
  );
});

test("/expand n opens exactly section n; /collapse n closes it; other sections unchanged", () => {
  const collapsedAll = applyControl(threeSections(), { kind: "mode", mode: "collapsed" });
  for (const s of collapsedAll.sections) assert.equal(s.collapsed, true, "start from all-collapsed");

  // /expand 2 opens ONLY the middle section.
  const expanded = applyControl(collapsedAll, { kind: "expand", n: 2 });
  assert.equal(expanded.sections[0]!.collapsed, true, "section 1 unchanged");
  assert.equal(expanded.sections[1]!.collapsed, false, "section 2 expanded");
  assert.equal(expanded.sections[2]!.collapsed, true, "section 3 unchanged");
  // Purity: the source model is untouched.
  assert.equal(collapsedAll.sections[1]!.collapsed, true, "expand does not mutate its input (pure)");

  // /collapse 2 closes it again, leaving the others as they were.
  const recollapsed = applyControl(expanded, { kind: "collapse", n: 2 });
  assert.equal(recollapsed.sections[0]!.collapsed, true, "section 1 unchanged");
  assert.equal(recollapsed.sections[1]!.collapsed, true, "section 2 collapsed");
  assert.equal(recollapsed.sections[2]!.collapsed, true, "section 3 unchanged");

  // An out-of-range section number is a no-op, never a crash.
  const before = collapsedAll.sections.map((s) => s.collapsed);
  const noop = applyControl(collapsedAll, { kind: "expand", n: 99 });
  assert.deepEqual(
    noop.sections.map((s) => s.collapsed),
    before,
    "an out-of-range /expand n leaves every section unchanged",
  );
});

// -- source scan: no over-truncation -----------------------------------------

test("no over-truncation: render sources carry no magic-number slice; the sole elision is the named SUMMARY_WIDTH used only for collapsed headers", () => {
  // Read the glyph-bearing sources via readFileSync (NOT shell grep, which
  // silently skips files containing ◆/⠙/→ — the CLAUDE.md macOS gotcha).
  const noTruncation = [
    join(repoRoot, "src", "view-model.ts"),
    join(repoRoot, "src", "engine-render.ts"),
    join(repoRoot, "src", "cli.ts"),
  ];
  for (const path of noTruncation) {
    const src = readFileSync(path, "utf8");
    // The two specific truncations removed must never reappear.
    assert.doesNotMatch(src, /slice\(\s*0\s*,\s*79\s*\)/, `${path}: no slice(0, 79) display truncation`);
    assert.doesNotMatch(src, /slice\(\s*0\s*,\s*99\s*\)/, `${path}: no slice(0, 99) display truncation`);
    // No magic-literal display truncation of any width — the only elision is a
    // NAMED constant (SUMMARY_WIDTH) or a live terminal width, never a bare number.
    assert.doesNotMatch(src, /slice\(\s*0\s*,\s*\d+\s*\)/, `${path}: no magic-number slice(0, N) truncation`);
  }

  const viewModelSrc = readFileSync(join(repoRoot, "src", "view-model.ts"), "utf8");
  // The elision width is a named, exported constant — not a scattered literal.
  assert.match(viewModelSrc, /export const SUMMARY_WIDTH\b/, "the summary width is a named constant");
  // It is used ONLY for the collapsed-header summary (in view-model), never in the
  // engine renderer's full-body path — so full mode / expand elides nothing.
  const engineSrc = readFileSync(join(repoRoot, "src", "engine-render.ts"), "utf8");
  assert.doesNotMatch(engineSrc, /SUMMARY_WIDTH/, "the full-body renderer applies no summary-width elision");
});
