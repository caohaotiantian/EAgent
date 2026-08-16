/**
 * `fs.edit` — and specifically the three refusals, which are the point of it.
 *
 * A fuzzy-matching edit tool that guesses is how a change lands in the wrong function, in a
 * file a human asked it to be careful with. So `locateEdit` relaxes whitespace and escaping
 * and NOTHING else, and reports `ambiguous` / `disproportionate` / `not-found` rather than
 * picking a best candidate. These tests pin the refusals first and the happy path second,
 * because the refusals are what makes the tool safe to hand a model.
 *
 * Offline and deterministic: every case is a string in a temp directory.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { builtinTools } from "../../src/builtin/tools.ts";
import type { ToolDefinition } from "../../src/run/registry.ts";

const ctxOf = (taskId: string) => ({
  taskId: taskId as never,
  signal: new AbortController().signal,
  progress: () => {},
});

function sandbox(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "loom-edit-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const editOf = (root: string): ToolDefinition =>
  builtinTools({ root, deny: [] }).find((t) => t.name === "fs.edit")!;

function seed(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
}

// ── the contract that decides the posture ────────────────────────────────────

test("fs.edit is a reversible_write with a real compensation, and is NOT idempotent", () => {
  const s = sandbox();
  const t = editOf(s.root);
  assert.equal(t.irreversibility, "reversible_write");
  assert.deepEqual(t.compensation, { tool: "fs.restore" });
  // A second identical edit finds `find` already replaced and REFUSES. That is not a
  // no-op, so claiming idempotence would license a retry that reports failure.
  assert.equal(t.idempotent, false);
  assert.deepEqual([...t.capabilities].sort(), ["fs:read", "fs:write"]);
  s.cleanup();
});

// ── the three refusals ───────────────────────────────────────────────────────

test("AN AMBIGUOUS SPAN IS REFUSED, not resolved by picking the first", async () => {
  const s = sandbox();
  seed(s.root, "a.ts", "const x = 1;\nconst y = 2;\nconst x = 1;\n");
  const r = await editOf(s.root).execute({ path: "a.ts", find: "const x = 1;", replace: "const x = 9;" }, ctxOf("t@root#0"));
  assert.equal(r.isError, true);
  // Two wordings, one meaning: `locateEdit` reports a repeated EXACT span as
  // `{kind:"exact", count}` and only its relaxed rungs report `ambiguous`. Both are
  // ambiguity refusals and the test accepts either rather than pinning which rung fired.
  assert.match(r.content, /occurs \d+ times|more than one place/);
  // The refusal must be total: nothing on disk moved.
  assert.equal(readFileSync(join(s.root, "a.ts"), "utf8"), "const x = 1;\nconst y = 2;\nconst x = 1;\n");
  s.cleanup();
});

test("...but replaceAll is the explicit way to say you meant all of them", async () => {
  const s = sandbox();
  seed(s.root, "a.ts", "const x = 1;\nconst y = 2;\nconst x = 1;\n");
  const r = await editOf(s.root).execute(
    { path: "a.ts", find: "const x = 1;", replace: "const x = 9;", replaceAll: true },
    ctxOf("t@root#0"),
  );
  assert.equal(r.isError, undefined);
  assert.equal(readFileSync(join(s.root, "a.ts"), "utf8"), "const x = 9;\nconst y = 2;\nconst x = 9;\n");
  assert.equal((r.details as { occurrences: number }).occurrences, 2);
  s.cleanup();
});

test("A MISSING SPAN IS REFUSED and changes nothing", async () => {
  const s = sandbox();
  seed(s.root, "a.ts", "hello world\n");
  const r = await editOf(s.root).execute({ path: "a.ts", find: "goodbye", replace: "x" }, ctxOf("t@root#0"));
  assert.equal(r.isError, true);
  assert.match(r.content, /no match/);
  assert.equal(readFileSync(join(s.root, "a.ts"), "utf8"), "hello world\n");
  s.cleanup();
});

// ── the reason the ladder exists ─────────────────────────────────────────────

test("WHITESPACE THE MODEL GOT WRONG STILL MATCHES — the whole reason for the ladder", async () => {
  const s = sandbox();
  // Real shape of the failure: the model reconstructs the body from memory and indents
  // with the wrong width. Nothing non-whitespace differs.
  seed(s.root, "a.ts", "function f() {\n\t\treturn 1;\n}\n");
  const r = await editOf(s.root).execute(
    { path: "a.ts", find: "function f() {\n  return 1;\n}", replace: "function f() {\n  return 2;\n}" },
    ctxOf("t@root#0"),
  );
  assert.equal(r.isError, undefined, `expected a relaxed match, got: ${r.content}`);
  assert.match(readFileSync(join(s.root, "a.ts"), "utf8"), /return 2;/);
  assert.equal((r.details as { match: string }).match, "relaxed");
  s.cleanup();
});

test("NON-WHITESPACE CONTENT IS NEVER RELAXED — a near-miss identifier is not a match", async () => {
  const s = sandbox();
  seed(s.root, "a.ts", "const userName = 1;\n");
  // One character different, and it is not whitespace. Matching this would be the bug the
  // ladder's whole design exists to avoid.
  const r = await editOf(s.root).execute({ path: "a.ts", find: "const userNme = 1;", replace: "const z = 2;" }, ctxOf("t@root#0"));
  assert.equal(r.isError, true, "a differing identifier must not be treated as a whitespace variant");
  assert.equal(readFileSync(join(s.root, "a.ts"), "utf8"), "const userName = 1;\n");
  s.cleanup();
});

// ── compensation actually works ──────────────────────────────────────────────

test("THE PRIOR CONTENT IS CAPTURED, so the declared compensation can actually compensate", async () => {
  const s = sandbox();
  seed(s.root, "a.ts", "before\n");
  const r = await editOf(s.root).execute({ path: "a.ts", find: "before", replace: "after" }, ctxOf("t@root#0"));
  assert.equal(r.isError, undefined);
  // `previous` is what `fs.restore` restores to. A compensation declared without it would
  // be a promise the tool cannot keep.
  assert.equal((r.details as { previous?: string }).previous, "before\n");
  s.cleanup();
});

// ── the branch overlay, which is where the subtle bug would be ───────────────

test("AN EDIT IN A BRANCH DOES NOT TOUCH THE SHARED WORKSPACE FILE", async () => {
  const s = sandbox();
  seed(s.root, "shared.ts", "original\n");
  const r = await editOf(s.root).execute({ path: "shared.ts", find: "original", replace: "branch-edit" }, ctxOf("t@root/fo[0]#0"));
  assert.equal(r.isError, undefined, r.content);
  // Read found the shared file; the write went to the branch. Both halves matter.
  assert.equal(readFileSync(join(s.root, "shared.ts"), "utf8"), "original\n", "the shared file must be untouched");
  assert.match(String((r.details as { at: string }).at), /\.branches/);
  s.cleanup();
});

test("`previous` COMES FROM THE WRITE PATH, not the file that was read", async () => {
  const s = sandbox();
  seed(s.root, "shared.ts", "original\n");
  const r = await editOf(s.root).execute({ path: "shared.ts", find: "original", replace: "v1" }, ctxOf("t@root/fo[0]#0"));
  // The branch had no copy yet, so there is nothing to restore TO. Recording the shared
  // file's content here would tell `fs.restore` to create a branch file that never existed.
  assert.equal((r.details as { previous?: string }).previous, undefined);
  s.cleanup();
});

test("two branches editing the same relative path do not collide", async () => {
  const s = sandbox();
  seed(s.root, "shared.ts", "original\n");
  const t = editOf(s.root);
  const a = await t.execute({ path: "shared.ts", find: "original", replace: "from-a" }, ctxOf("t@root/fo[0]#0"));
  const b = await t.execute({ path: "shared.ts", find: "original", replace: "from-b" }, ctxOf("t@root/fo[1]#0"));
  const atA = String((a.details as { at: string }).at);
  const atB = String((b.details as { at: string }).at);
  assert.notEqual(atA, atB);
  assert.match(readFileSync(atA, "utf8"), /from-a/);
  assert.match(readFileSync(atB, "utf8"), /from-b/);
  s.cleanup();
});

// ── containment is inherited, not reimplemented ──────────────────────────────

test("fs.edit CANNOT ESCAPE THE ROOT", async () => {
  const s = sandbox();
  await assert.rejects(
    async () => editOf(s.root).execute({ path: "../../etc/hosts", find: "a", replace: "b" }, ctxOf("t@root#0")),
    (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
  );
  s.cleanup();
});

test("fs.edit respects the deny-list, so the journal stays out of reach", async () => {
  const s = sandbox();
  seed(s.root, ".loom/journal.db", "pretend-sqlite\n");
  const t = builtinTools({ root: s.root, deny: [".loom"] }).find((x) => x.name === "fs.edit")!;
  await assert.rejects(
    async () => t.execute({ path: ".loom/journal.db", find: "pretend", replace: "x" }, ctxOf("t@root#0")),
    (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
  );
  s.cleanup();
});
