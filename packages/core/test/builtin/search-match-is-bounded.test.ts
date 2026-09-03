/**
 * A MODEL'S TOOL ARGUMENT COULD MAKE THE WHOLE RUNTIME UNRESPONSIVE, AND UNSTOPPABLE.
 *
 * `fs.grep` compiles `new RegExp(model_string)` and ran it line-by-line inside a SYNCHRONOUS
 * `execute`, and `fs.glob` runs a glob-derived regex per path. A catastrophically-backtracking
 * pattern — `(a+)+$` against a run of one character, or `**​/` repeated against a deep path —
 * stalls Node's single thread for time that grows exponentially with the input, and nothing can
 * interrupt it: the engine's node deadline is a `Promise.race` on the SAME thread, `AbortSignal`
 * callbacks are queued behind it, and the result caps bound how many lines are scanned rather
 * than how long one `test` takes. Under `loom serve` that is every run, the HTTP control plane,
 * the gate SLA clock and `loom cancel` all at once — the goal says "watch it, stop it".
 *
 * Measured at a638e7d on this machine, one file holding `"a" * n + "!"`, pattern `(a+)+$`:
 *
 *     n = 24 →     876 ms      n = 28 →  14,105 ms
 *     n = 26 →   3,506 ms      n = 30 →  56,354 ms
 *
 * ~4x per two characters, and a 200 ms `setTimeout` armed before the call had still not fired
 * when it returned — the loop was blocked, not merely busy.
 *
 * The fix is `node:vm`'s per-call `timeout`, which is the one mechanism in Node that TERMINATES
 * synchronous execution. This is not a use of `vm` as a sandbox — CLAUDE.md is right that it is
 * not one, and nothing here is being isolated. It is the interrupt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinTools } from "../../src/builtin/tools.ts";
import type { ToolDefinition, ToolResult } from "../../src/run/registry.ts";

const ctx = () => ({ taskId: "t@root#0" as never, signal: new AbortController().signal, progress: () => {} });
const toolOf = (root: string, name: string): ToolDefinition => builtinTools({ root, deny: [] }).find((t) => t.name === name)!;

function ws(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "loom-redos-"));
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body, "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** n = 34 is the finding's own input: 86 s of blocked event loop before the fix. */
const CATASTROPHIC_LINE = `${"a".repeat(34)}!\n`;

test("fs.grep returns promptly on a catastrophically-backtracking pattern, and REFUSES", async () => {
  const s = ws({ "redos.txt": CATASTROPHIC_LINE });
  try {
    const started = Date.now();
    const r = (await toolOf(s.root, "fs.grep").execute({ pattern: "(a+)+$" }, ctx())) as ToolResult;
    const elapsed = Date.now() - started;
    // An ABSOLUTE bound with an order-of-magnitude margin over the 2 s budget, not a ratio.
    assert.ok(elapsed < 20_000, `fs.grep must not block the event loop; took ${String(elapsed)} ms`);
    assert.equal(r.isError, true, "refusing is the answer — '(no matches)' would be a wrong result reported as right");
    assert.match(r.content, /too expensive|budget/i);
    assert.match(r.content, /\(a\+\)\+\$/, "the message names the pattern so the model can fix it");
  } finally {
    s.cleanup();
  }
});

test("the STALL is bounded by the budget, not by the pattern", async () => {
  // `execute` is synchronous, so the loop is blocked for as long as it runs — the question is
  // only for how long. This measures that directly: a timer armed for 50 ms cannot run until
  // the call returns, so how late it fires IS the blocked duration. Before the fix that was
  // 86 s for this input and grew ~4x per two characters; now it is the budget plus a tick.
  const s = ws({ "redos.txt": CATASTROPHIC_LINE });
  try {
    const armed = Date.now();
    let firedAt = 0;
    const timer = setTimeout(() => {
      firedAt = Date.now();
    }, 50);
    await toolOf(s.root, "fs.grep").execute({ pattern: "(a+)+$" }, ctx());
    await new Promise((r) => setTimeout(r, 0));
    clearTimeout(timer);
    assert.ok(firedAt > 0, "the timer must eventually run");
    assert.ok(firedAt - armed < 20_000, `the loop was blocked for ${String(firedAt - armed)} ms`);
  } finally {
    s.cleanup();
  }
});

test("fs.glob is bounded too — a `**\u200b/`-heavy glob is the same defect", async () => {
  // THE DEEP PATH IS CREATED, and that is the whole test. The `**/`-repeated regex backtracks on
  // the SEGMENTS of the path it is matched against, so against `a.txt` — one segment — it settles
  // in ~1.5 ms whether or not any bound exists. Building the 30-segment path and never writing it
  // measured the bound against a workspace that could not exercise it.
  const deep = Array.from({ length: 30 }, (_, i) => `seg${String(i)}`).join("/");
  const s = ws({ "a.txt": "x" });
  try {
    mkdirSync(join(s.root, deep), { recursive: true });
    writeFileSync(join(s.root, deep, "x.txt"), "x", "utf8");
    const started = Date.now();
    const r = (await toolOf(s.root, "fs.glob").execute({ pattern: `${"**/".repeat(14)}zz` }, ctx())) as ToolResult;
    const elapsed = Date.now() - started;
    // Absolute, with an order-of-magnitude margin over the 2 s budget — never a ratio of two
    // timings. Unbounded, this path takes 30,907 ms on the machine this was written on; one
    // reviewer watched it still running at 90 s.
    assert.ok(elapsed < 20_000, `fs.glob must not block the event loop; took ${String(elapsed)} ms`);
    assert.equal(r.isError, true, "an unmatchable `**/`-heavy glob over a deep path must be REFUSED, not answered late");
    assert.match(r.content, /too expensive|budget/i);
  } finally {
    s.cleanup();
  }
});

// ── the ordinary case, which the bound must not touch ────────────────────────

/**
 * THE BUDGET BECAME A FILE-COUNT LIMIT, AND REFUSED AN ORDINARY LITERAL PATTERN.
 *
 * `matchBudget` charges wall clock and `runInContext` with a `timeout` costs a fixed 43-48 µs
 * because it arms a watchdog. `fs.glob` was batched for exactly that reason and `fs.grep` was
 * left with TWO unbatched call sites — one `scan(include, [rel])` per file and one
 * `scan(re, lines)` per file — so a large workspace spent the whole 2,000 ms budget on watchdogs
 * before any matching happened, and answered a literal string with "the pattern is too expensive
 * to run". Measured on 60,000 two-line files: `fs.grep {pattern: "zzzzzzzz"}`, no `include` at
 * all, refused after 3,289 ms where the unbounded `a638e7d` answered `(no matches)` in 1,304 ms.
 *
 * 48,000 EMPTY FILES HERE, and both numbers are chosen rather than round. The defect is a cost
 * per CALL, so an empty file trips it exactly as a full one does — `"".split("\n")` is one line
 * and still buys a watchdog — and empty files cost ~2 s to create instead of ~8 s. 48,000 is
 * where BOTH call sites are over the budget on the machine this was written on: measured against
 * the unbatched tree, `{pattern}` alone refused at 3,206 ms and `{pattern, include}` at 2,624 ms,
 * while the batched one answers both in under 1,000 ms. The margin is the point — a count just
 * over the threshold would be a test about this laptop.
 *
 * BOTH HALVES, OVER ONE TREE, because measuring only the defect shape is what let this ship: the
 * workspace holds the catastrophic line too, and the pathological pattern must still be refused
 * over the very same files the literal one is now answered over.
 */
test("a large workspace does not exhaust the budget on fixed per-call cost", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-grep-scale-"));
  try {
    for (let d = 0; d < 48; d++) {
      const dir = join(root, `d${String(d)}`);
      mkdirSync(dir);
      for (let f = 0; f < 1000; f++) writeFileSync(join(dir, `f${String(f)}.ts`), "", "utf8");
      // One file per directory with real content, so the hit below crosses batch boundaries.
      writeFileSync(join(dir, "real.ts"), `export const a = 1;\nexport function g7() { return a; }\n`, "utf8");
    }
    writeFileSync(join(root, "redos.txt"), CATASTROPHIC_LINE, "utf8");
    const g = toolOf(root, "fs.grep");

    // 1 — the ordinary case, and the exact call the finding was reported against: a literal
    // pattern, no `include`, over 48,049 files. It must ANSWER.
    const miss = (await g.execute({ pattern: "zzzzzzzz" }, ctx())) as ToolResult;
    assert.notEqual(miss.isError, true, `a literal pattern must not be called too expensive: ${miss.content}`);
    assert.equal(miss.content, "(no matches)");

    // 2 — …and the second call site, which is one scan per PATH: `include` must answer too, and
    // the hits must still carry the right path and line number across the batch boundaries.
    const hit = (await g.execute({ pattern: "export function g7\\(", include: "**/*.ts" }, ctx())) as ToolResult;
    assert.notEqual(hit.isError, true, hit.content);
    assert.equal((hit.details as { count: number }).count, 48, "one per directory");
    assert.match(hit.content, /^d\d+\/real\.ts:2:export function g7\(\) \{ return a; \}$/m);

    // 3 — the defect case, over the SAME tree: still refused, and still promptly. Batching the
    // ordinary case must not have bought it by weakening the bound.
    const started = Date.now();
    const bad = (await g.execute({ pattern: "(a+)+$" }, ctx())) as ToolResult;
    const elapsed = Date.now() - started;
    assert.equal(bad.isError, true, "the catastrophic pattern must still be refused");
    assert.match(bad.content, /too expensive|budget/i);
    // Absolute, with an order-of-magnitude margin over the 2 s budget. The bound is on MATCHING;
    // walking and reading 48,049 files is outside it and is a cost the two searches above paid
    // too, so the worst block is the budget PLUS one traversal rather than the budget alone.
    assert.ok(elapsed < 30_000, `the refusal must arrive on the budget, not on the pattern; took ${String(elapsed)} ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an ORDINARY grep still finds every match, with line numbers", async () => {
  const s = ws({
    "a.ts": "const x = 1;\nconst y = 2;\nconst x = 3;\n",
    "b.md": "nothing here\n",
  });
  try {
    const r = (await toolOf(s.root, "fs.grep").execute({ pattern: "const x" }, ctx())) as ToolResult;
    assert.notEqual(r.isError, true, r.content);
    assert.deepEqual(r.content.split("\n").sort(), ["a.ts:1:const x = 1;", "a.ts:3:const x = 3;"]);
    assert.equal((r.details as { count: number }).count, 2);
  } finally {
    s.cleanup();
  }
});

test("...including ignoreCase, include, an invalid pattern, and no match at all", async () => {
  const s = ws({ "a.ts": "Const X = 1;\n", "b.md": "const x = 1;\n" });
  try {
    const g = toolOf(s.root, "fs.grep");
    assert.equal(((await g.execute({ pattern: "const x", ignoreCase: true }, ctx())) as ToolResult).content.split("\n").length, 2);
    assert.deepEqual(
      ((await g.execute({ pattern: "const", ignoreCase: true, include: "*.md" }, ctx())) as ToolResult).content,
      "b.md:1:const x = 1;",
    );
    const bad = (await g.execute({ pattern: "(unclosed" }, ctx())) as ToolResult;
    assert.equal(bad.isError, true);
    assert.match(bad.content, /invalid pattern/);
    assert.equal(((await g.execute({ pattern: "zzzz" }, ctx())) as ToolResult).content, "(no matches)");
  } finally {
    s.cleanup();
  }
});

test("an ORDINARY glob still matches, and a miss is still a miss", async () => {
  const s = ws({ "a.ts": "x", "b.md": "y" });
  try {
    const g = toolOf(s.root, "fs.glob");
    assert.equal(((await g.execute({ pattern: "*.ts" }, ctx())) as ToolResult).content, "a.ts");
    assert.equal(((await g.execute({ pattern: "**/*.md" }, ctx())) as ToolResult).content, "b.md");
    assert.equal(((await g.execute({ pattern: "*.rs" }, ctx())) as ToolResult).content, "(no matches)");
  } finally {
    s.cleanup();
  }
});
