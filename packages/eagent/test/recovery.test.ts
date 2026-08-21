/**
 * recovery — corrective nudges appended to failed tool results.
 *
 * The pure helpers (recoveryHint, annotate, RECOVERY_RULES) are unit-tested
 * directly; the guard is exercised through the agent loop with only core-tools
 * and recovery loaded, against a real temp-file workspace, so any annotation is
 * unambiguously recovery's. All offline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Agent } from "../src/kernel/agent.ts";
import type { ToolResult } from "../src/kernel/types.ts";
import { makeHarness } from "./helpers.ts";
import coreTools from "../src/extensions/core-tools.ts";
import recovery, { recoveryHint, RECOVERY_RULES, annotate } from "../src/extensions/recovery.ts";

// -- unit: the pure matcher --------------------------------------------------

test("recoveryHint fires on each default rule's real EAgent error string", () => {
  // crit 2 — one representative trigger per rule, asserting a rule-distinctive keyword.
  assert.match(recoveryHint("Text not found in /tmp/x.ts.") ?? "", /re-read/);
  assert.match(recoveryHint("Text appears 3 times in /tmp/x.ts; pass replaceAll or make it unique.") ?? "", /replaceAll/);
  // rule 2's second alternation branch (the resilient-edit ambiguous path).
  assert.match(
    recoveryHint("Text matches multiple places after whitespace-insensitive search in /tmp/x.ts; add surrounding context to make it unique.") ?? "",
    /replaceAll/,
  );
  assert.match(recoveryHint("The matched span is much larger than the text to replace in /tmp/x.ts; re-read the file.") ?? "", /exact/);
  assert.match(recoveryHint("Invalid arguments for edit:\n- foo is required") ?? "", /schema/);
  assert.match(recoveryHint('path "../etc" is outside the workspace root (/home/u/p)') ?? "", /workspace/);
  assert.match(recoveryHint("Unknown tool: frobnicate") ?? "", /tool name/);
});

test("recoveryHint returns null for benign (non-error-shaped) output", () => {
  // crit 3
  assert.equal(recoveryHint("Wrote 12 bytes to /tmp/x.ts"), null);
  assert.equal(recoveryHint("   5  const x = 1;"), null);
});

test("recoveryHint is first-match-wins on a string matching two rules", () => {
  // crit 4 — synthetic string hitting both rule 1 (Text not found in) and rule 6
  // (Unknown tool:); the six default patterns are mutually exclusive on real
  // EAgent strings, so the overlap is deliberately constructed. Rule 1 is earlier.
  const synthetic = "Unknown tool: x — also Text not found in /tmp/x.ts.";
  const rule1 = RECOVERY_RULES[0]!;
  const rule6 = RECOVERY_RULES[5]!;
  assert.ok(rule1.match.test(synthetic) && rule6.match.test(synthetic), "synthetic must hit both patterns");
  assert.equal(recoveryHint(synthetic), rule1.hint);
});

// -- unit: the guard transform (idempotency + isError gating) ----------------

test("annotate appends one hint to a failed result and is idempotent", () => {
  // crit 5
  const failed: ToolResult = { content: "Text not found in /tmp/x.ts.", isError: true };
  const once = annotate(failed);
  assert.match(once.content, /Recovery hint: /, "a failed, matching result gains one hint block");
  // Feeding already-marked content back through the guard adds no second block.
  // (This fails if the includes("Recovery hint:") short-circuit is removed: the
  // surviving "Text not found in " substring would re-match and append again.)
  const twice = annotate(once);
  assert.equal(twice.content, once.content, "annotate is idempotent on already-marked content");
});

test("annotate never touches a successful result", () => {
  // crit 5 (isError gating) + design D2
  const success: ToolResult = { content: "Text not found in /tmp/x.ts.", isError: false };
  assert.equal(annotate(success).content, success.content, "isError:false output is never annotated");
});

test("annotate leaves a failed result with no matching rule unchanged", () => {
  const failedNoMatch: ToolResult = { content: "the disk is on fire", isError: true };
  assert.equal(annotate(failedNoMatch).content, failedNoMatch.content);
});

// -- live: through the agent loop --------------------------------------------

/** A scratch workspace with one known file; EAGENT_WORKSPACE points core-tools here. */
function scratch(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "eagent-recovery-"));
  const file = join(dir, "x.ts");
  writeFileSync(file, "const greeting = 'hello world';\n");
  const prev = process.env.EAGENT_WORKSPACE;
  process.env.EAGENT_WORKSPACE = dir;
  return {
    dir,
    file,
    cleanup: () => {
      if (prev === undefined) delete process.env.EAGENT_WORKSPACE;
      else process.env.EAGENT_WORKSPACE = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Did any tool_result the model saw carry a recovery hint? */
function sawHint(agent: Agent): boolean {
  return agent.messages
    .filter((m) => m.role === "tool")
    .some((m) => m.content.some((b) => b.type === "tool_result" && /Recovery hint: /.test(b.content)));
}

test("live: a genuinely-failed edit reaches the model with the rule-1 hint", async () => {
  // crit 6
  const s = scratch();
  try {
    const h = makeHarness({
      responder: [
        { toolCalls: [{ name: "edit", arguments: { path: "x.ts", old: "this text is absent", new: "y" } }] },
        { text: "done" },
      ],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("recovery", recovery);

    await h.agent.run("fix it");
    assert.equal(sawHint(h.agent), true, "the failed edit result carries a recovery hint");
    const toolMsg = h.agent.messages.find((m) => m.role === "tool");
    const block = toolMsg?.content.find((b) => b.type === "tool_result");
    assert.ok(block && block.type === "tool_result");
    assert.match(block.content, /re-read/, "the rule-1 hint is the one appended");
  } finally {
    s.cleanup();
  }
});

test("live: a successful read is never annotated", async () => {
  // crit 7
  const s = scratch();
  try {
    const h = makeHarness({
      responder: [{ toolCalls: [{ name: "read", arguments: { path: "x.ts" } }] }, { text: "done" }],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("recovery", recovery);

    await h.agent.run("read it");
    assert.equal(sawHint(h.agent), false, "successful output gets no hint");
  } finally {
    s.cleanup();
  }
});

test("live: EAGENT_RECOVERY=off disables annotation", async () => {
  // crit 8
  const s = scratch();
  const prev = process.env.EAGENT_RECOVERY;
  process.env.EAGENT_RECOVERY = "off";
  try {
    const h = makeHarness({
      responder: [
        { toolCalls: [{ name: "edit", arguments: { path: "x.ts", old: "this text is absent", new: "y" } }] },
        { text: "done" },
      ],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("recovery", recovery);

    await h.agent.run("fix it");
    assert.equal(sawHint(h.agent), false, "kill switch suppresses annotation");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_RECOVERY;
    else process.env.EAGENT_RECOVERY = prev;
    s.cleanup();
  }
});

test("live: disposing recovery unregisters the afterToolCall hook (no leak)", async () => {
  // crit 9
  const s = scratch();
  try {
    const h = makeHarness({
      responder: [
        { toolCalls: [{ name: "edit", arguments: { path: "x.ts", old: "this text is absent", new: "y" } }] },
        { text: "done" },
      ],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("recovery", recovery);
    await h.host.unload("recovery");

    await h.agent.run("fix it");
    assert.equal(sawHint(h.agent), false, "after teardown the hook no longer annotates");
  } finally {
    s.cleanup();
  }
});
