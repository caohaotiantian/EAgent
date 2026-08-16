/**
 * `proc.exec` — the first caller of `runSandboxed`, and the only tool whose containment is
 * NOT `assertWithin`.
 *
 * Every other tool in `builtin/tools.ts` is confined by resolving a path against the jail,
 * which works because the argument's meaning is known at the call site. A subprocess breaks
 * that: the child does its own `open()`, so the moment a shell is reachable, `deny` and the
 * branch overlay are advisory. The allowlist is therefore not one check among several — it
 * is the entire boundary, and these tests are about the boundary rather than about running
 * programs.
 *
 * Deterministic and offline: every child is `process.execPath -e …`, the same idiom
 * `test/sandbox/subprocess.test.ts` uses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinTools } from "../../src/builtin/tools.ts";
import type { ToolDefinition } from "../../src/run/registry.ts";

const NODE = process.execPath;

const ctxOf = (taskId: string) => ({
  taskId: taskId as never,
  signal: new AbortController().signal,
  progress: () => {},
});

function sandbox(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "loom-exec-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const byName = (tools: readonly ToolDefinition[], name: string): ToolDefinition | undefined =>
  tools.find((t) => t.name === name);

// ── registration is opt-in, exactly like net.fetch ───────────────────────────

test("proc.exec IS NOT REGISTERED without an allowlist — an embedder who never thought about it cannot run programs", () => {
  const s = sandbox();
  assert.equal(byName(builtinTools({ root: s.root, deny: [] }), "proc.exec"), undefined);
  assert.equal(byName(builtinTools({ root: s.root, deny: [], execAllowlist: [] }), "proc.exec"), undefined);
  s.cleanup();
});

test("an allowlist registers it", () => {
  const s = sandbox();
  assert.notEqual(byName(builtinTools({ root: s.root, deny: [], execAllowlist: [NODE] }), "proc.exec"), undefined);
  s.cleanup();
});

// ── the class, which is what decides the posture ─────────────────────────────

test("proc.exec DECLARES ITSELF irreversible, so CLASS_DEFAULT_POSTURE gates it and it is never auto-retried", () => {
  const s = sandbox();
  const t = byName(builtinTools({ root: s.root, deny: [], execAllowlist: [NODE] }), "proc.exec")!;
  // Not padding: the engine cannot know whether the argv it re-runs appends to a file, and
  // there is no `fs.restore` equivalent for an arbitrary program.
  assert.equal(t.irreversibility, "irreversible");
  assert.equal(t.idempotent, false);
  assert.deepEqual(t.capabilities, ["proc:exec"]);
  s.cleanup();
});

// ── the boundary ─────────────────────────────────────────────────────────────

test("A COMMAND OFF THE ALLOWLIST IS REFUSED — the boundary is the name, checked before the spawn", async () => {
  const s = sandbox();
  const t = byName(builtinTools({ root: s.root, deny: [], execAllowlist: [NODE] }), "proc.exec")!;
  const r = await t.execute({ command: "/bin/sh", args: ["-c", "echo pwned"] }, ctxOf("t@root#0"));
  assert.equal(r.isError, true);
  assert.match(r.content, /not allow-listed/);
  s.cleanup();
});

test("THE MATCH IS EXACT, NOT A PREFIX — otherwise allow-listing `git` admits `gitk`", async () => {
  const s = sandbox();
  const t = byName(builtinTools({ root: s.root, deny: [], execAllowlist: ["git"] }), "proc.exec")!;
  const r = await t.execute({ command: "gitk", args: [] }, ctxOf("t@root#0"));
  assert.equal(r.isError, true);
  s.cleanup();
});

test("A PATH IS NOT A NAME — a binary the model just wrote with fs.write is not reachable by spelling it", async () => {
  const s = sandbox();
  // The exact shape that would turn the allowlist into a formality: write a file, then try
  // to run it by a path that ends in an allow-listed name.
  writeFileSync(join(s.root, "node"), "#!/bin/sh\necho pwned\n", { mode: 0o755 });
  const t = byName(builtinTools({ root: s.root, deny: [], execAllowlist: ["node"] }), "proc.exec")!;
  const r = await t.execute({ command: join(s.root, "node"), args: [] }, ctxOf("t@root#0"));
  assert.equal(r.isError, true, "a path that ends in an allow-listed name must not pass");
  s.cleanup();
});

test("`args` MUST BE AN ARRAY OF STRINGS — a shell string is not a way in", async () => {
  const s = sandbox();
  const t = byName(builtinTools({ root: s.root, deny: [], execAllowlist: [NODE] }), "proc.exec")!;
  const r = await t.execute({ command: NODE, args: "-e 'process.exit(0)'" }, ctxOf("t@root#0"));
  assert.equal(r.isError, true);
  assert.match(r.content, /array of strings/);
  s.cleanup();
});

// ── what it does when it is allowed to work ──────────────────────────────────

test("an allow-listed command runs and reports its exit code", async () => {
  const s = sandbox();
  const t = byName(builtinTools({ root: s.root, deny: [], execAllowlist: [NODE] }), "proc.exec")!;
  const r = await t.execute(
    { command: NODE, args: ["-e", "process.stdout.write('hello')"] },
    ctxOf("t@root#0"),
  );
  assert.equal(r.isError, undefined);
  assert.match(r.content, /exit=0/);
  assert.match(r.content, /hello/);
  s.cleanup();
});

test("A NON-ZERO EXIT IS A RESULT, NOT A TOOL FAILURE — the program ran; the model asked it to", async () => {
  const s = sandbox();
  const t = byName(builtinTools({ root: s.root, deny: [], execAllowlist: [NODE] }), "proc.exec")!;
  const r = await t.execute({ command: NODE, args: ["-e", "process.exit(3)"] }, ctxOf("t@root#0"));
  // `isError` is reserved for "the call could not be made". A failing build is an answer.
  assert.equal(r.isError, undefined);
  assert.match(r.content, /exit=3/);
  s.cleanup();
});

test("A TIMEOUT THROWS E_TOOL_TIMEOUT rather than returning — the answer does not exist, so there is no result to return", async () => {
  const s = sandbox();
  const t = byName(builtinTools({ root: s.root, deny: [], execAllowlist: [NODE] }), "proc.exec")!;
  await assert.rejects(
    async () =>
      t.execute({ command: NODE, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 150 }, ctxOf("t@root#0")),
    (e: unknown) => (e as { code: string }).code === "E_TOOL_TIMEOUT",
  );
  s.cleanup();
});

// ── the environment, which is where the API keys are ─────────────────────────

test("THE CHILD'S ENVIRONMENT IS EMPTY UNLESS NAMED — a provider key in this process does not reach it", async () => {
  const s = sandbox();
  const t = byName(builtinTools({ root: s.root, deny: [], execAllowlist: [NODE] }), "proc.exec")!;
  process.env["LOOM_TEST_SECRET"] = "sk-do-not-leak";
  try {
    const r = await t.execute(
      { command: NODE, args: ["-e", "process.stdout.write(process.env.LOOM_TEST_SECRET ?? '(absent)')"] },
      ctxOf("t@root#0"),
    );
    assert.match(r.content, /\(absent\)/);
    assert.doesNotMatch(r.content, /sk-do-not-leak/);
  } finally {
    delete process.env["LOOM_TEST_SECRET"];
  }
  s.cleanup();
});

test("execEnvAllow passes through the names it lists, and only those", async () => {
  const s = sandbox();
  const t = byName(
    builtinTools({ root: s.root, deny: [], execAllowlist: [NODE], execEnvAllow: ["LOOM_TEST_WANTED"] }),
    "proc.exec",
  )!;
  process.env["LOOM_TEST_WANTED"] = "yes";
  process.env["LOOM_TEST_SECRET"] = "sk-do-not-leak";
  try {
    const r = await t.execute(
      {
        command: NODE,
        args: ["-e", "process.stdout.write(`${process.env.LOOM_TEST_WANTED}|${process.env.LOOM_TEST_SECRET ?? '(absent)'}`)"],
      },
      ctxOf("t@root#0"),
    );
    assert.match(r.content, /yes\|\(absent\)/);
  } finally {
    delete process.env["LOOM_TEST_WANTED"];
    delete process.env["LOOM_TEST_SECRET"];
  }
  s.cleanup();
});

// ── branch isolation, for the same reason writes are isolated ────────────────

test("TWO BRANCHES RUNNING THE SAME COMMAND DO NOT SHARE A WORKING DIRECTORY", async () => {
  const s = sandbox();
  const t = byName(builtinTools({ root: s.root, deny: [], execAllowlist: [NODE] }), "proc.exec")!;
  const cwdOf = async (taskId: string): Promise<string> => {
    const r = await t.execute(
      { command: NODE, args: ["-e", "process.stdout.write(process.cwd())"] },
      ctxOf(taskId),
    );
    return r.content;
  };
  const a = await cwdOf("t@root/fo[0]#0");
  const b = await cwdOf("t@root/fo[1]#0");
  assert.notEqual(a, b, "a fan-out over N items must not have all N branches writing into one directory");
  s.cleanup();
});
