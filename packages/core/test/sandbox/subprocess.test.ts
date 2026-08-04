import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertWithin, buildEnv, isWithin, runSandboxed } from "../../src/sandbox/subprocess.ts";

const ac = (): AbortSignal => new AbortController().signal;
const NODE = process.execPath;

function jail(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-jail-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── path jail ────────────────────────────────────────────────────────────────

test("assertWithin resolves relative paths inside the root", () => {
  assert.equal(assertWithin("/jail", "a/b.txt"), "/jail/a/b.txt");
  assert.equal(assertWithin("/jail", "./x"), "/jail/x");
  assert.equal(assertWithin("/jail", "a/../b"), "/jail/b");
});

test("assertWithin rejects traversal and absolute escapes", () => {
  for (const bad of ["../secrets", "a/../../etc/passwd", "/etc/passwd"]) {
    assert.throws(() => assertWithin("/jail", bad), /escapes the sandbox root/, bad);
  }
});

test("the jail check is not a startsWith prefix test", () => {
  // `"/jail-evil".startsWith("/jail")` is true, which is why `path.relative` is used
  // instead. This is the classic sibling-directory escape.
  assert.equal(isWithin("/jail", "/jail-evil/x"), false);
  assert.equal(isWithin("/jail", "/jailX"), false);
  assert.equal(isWithin("/jail", "sub/ok"), true);
});

test("the root itself is inside the root", () => {
  assert.equal(isWithin("/jail", "."), true);
});

// ── environment ──────────────────────────────────────────────────────────────

test("env is an allowlist — nothing leaks by default", () => {
  process.env["LOOM_TEST_SECRET"] = "super-secret";
  try {
    const env = buildEnv(undefined);
    assert.equal(env["LOOM_TEST_SECRET"], undefined, "an unlisted variable is absent, not empty");
    assert.ok("PATH" in env, "only the minimum a child needs to run");
  } finally {
    delete process.env["LOOM_TEST_SECRET"];
  }
});

test("explicitly-passed values win and do not require an allowlist entry", () => {
  const env = buildEnv([], { TOKEN: "resolved-at-the-boundary" });
  assert.equal(env["TOKEN"], "resolved-at-the-boundary");
});

test("an allowlisted variable is passed through", () => {
  process.env["LOOM_TEST_OK"] = "yes";
  try {
    assert.equal(buildEnv(["LOOM_TEST_OK"])["LOOM_TEST_OK"], "yes");
  } finally {
    delete process.env["LOOM_TEST_OK"];
  }
});

// ── execution ────────────────────────────────────────────────────────────────

test("a command runs and its output is captured", async () => {
  const j = jail();
  try {
    const r = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdout.write('hi'); process.stderr.write('warn')"], cwd: j.dir, timeoutMs: 10_000 },
      ac(),
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "hi");
    assert.equal(r.stderr, "warn");
    assert.equal(r.truncated, false);
    assert.equal(r.timedOut, false);
  } finally {
    j.dispose();
  }
});

test("a non-zero exit is a RESULT, not an exception", async () => {
  const j = jail();
  try {
    const r = await runSandboxed({ command: NODE, args: ["-e", "process.exit(3)"], cwd: j.dir, timeoutMs: 10_000 }, ac());
    assert.equal(r.code, 3, "the tool failing is the tool's business; the sandbox worked");
  } finally {
    j.dispose();
  }
});

test("the child starts in the jail, not in the engine's cwd", async () => {
  const j = jail();
  try {
    const r = await runSandboxed({ command: NODE, args: ["-e", "process.stdout.write(process.cwd())"], cwd: j.dir, timeoutMs: 10_000 }, ac());
    // macOS reports /private/var for /var, so compare the resolved tail.
    assert.ok(r.stdout.endsWith(j.dir.replace(/^\/private/, "")) || r.stdout === j.dir, r.stdout);
  } finally {
    j.dispose();
  }
});

test("arguments are passed as an array — shell metacharacters are inert", async () => {
  const j = jail();
  writeFileSync(join(j.dir, "canary.txt"), "still here");
  try {
    // With `shell: true` this would delete the canary. As an argv element it is just
    // a weird string the program receives.
    const r = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdout.write(process.argv[1] ?? '')", "; rm -rf ."], cwd: j.dir, timeoutMs: 10_000 },
      ac(),
    );
    assert.equal(r.stdout, "; rm -rf .");
    assert.equal(readOr(join(j.dir, "canary.txt")), "still here");
  } finally {
    j.dispose();
  }
});

test("output beyond the cap is truncated and FLAGGED", async () => {
  const j = jail();
  try {
    const r = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdout.write('x'.repeat(50000))"], cwd: j.dir, timeoutMs: 10_000, maxOutputBytes: 100 },
      ac(),
    );
    assert.equal(r.stdout.length, 100);
    assert.equal(r.truncated, true, "a caller must be able to tell it is not seeing everything");
  } finally {
    j.dispose();
  }
});

test("a hung process is killed and reported as a timeout", async () => {
  const j = jail();
  try {
    await assert.rejects(
      () =>
        runSandboxed(
          { command: NODE, args: ["-e", "setInterval(() => {}, 1000)"], cwd: j.dir, timeoutMs: 150, gracePeriodMs: 50 },
          ac(),
        ),
      (e: unknown) => (e as { code: string }).code === "E_TOOL_TIMEOUT",
    );
  } finally {
    j.dispose();
  }
});

test("a process that IGNORES SIGTERM is still killed", async () => {
  const j = jail();
  try {
    const started = Date.now();
    await assert.rejects(
      () =>
        runSandboxed(
          {
            command: NODE,
            args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
            cwd: j.dir,
            timeoutMs: 150,
            gracePeriodMs: 100,
          },
          ac(),
        ),
      // `assert.rejects` matches the MESSAGE, not the code — check the code directly.
      (e: unknown) => (e as { code: string }).code === "E_TOOL_TIMEOUT",
    );
    // Grace expired, then SIGKILL. It must not hold the slot indefinitely.
    assert.ok(Date.now() - started < 5000, "SIGKILL followed the grace period");
  } finally {
    j.dispose();
  }
});

test("aborting cancels the child", async () => {
  const j = jail();
  const controller = new AbortController();
  try {
    const p = runSandboxed(
      { command: NODE, args: ["-e", "setInterval(() => {}, 1000)"], cwd: j.dir, timeoutMs: 30_000, gracePeriodMs: 50 },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(() => p, /E_CANCELLED|cancelled/);
  } finally {
    j.dispose();
  }
});

test("an already-aborted signal never spawns anything", async () => {
  const j = jail();
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      () => runSandboxed({ command: NODE, args: ["-e", "process.exit(0)"], cwd: j.dir, timeoutMs: 1000 }, controller.signal),
      /E_CANCELLED|aborted/,
    );
  } finally {
    j.dispose();
  }
});

test("a missing executable is a clean unavailable error, not a crash", async () => {
  const j = jail();
  try {
    await assert.rejects(
      () => runSandboxed({ command: "definitely-not-a-real-binary-xyz", args: [], cwd: j.dir, timeoutMs: 1000 }, ac()),
      /could not spawn/,
    );
  } finally {
    j.dispose();
  }
});

test("stdin is delivered and then closed", async () => {
  const j = jail();
  try {
    const r = await runSandboxed(
      {
        command: NODE,
        args: ["-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()))"],
        cwd: j.dir,
        timeoutMs: 10_000,
        stdin: "hello",
      },
      ac(),
    );
    assert.equal(r.stdout, "HELLO", "a child that reads stdin must see EOF, or it hangs");
  } finally {
    j.dispose();
  }
});

test("the child cannot see the engine's environment secrets", async () => {
  const j = jail();
  process.env["LOOM_LEAK_CHECK"] = "leaked";
  try {
    const r = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdout.write(String(process.env.LOOM_LEAK_CHECK))"], cwd: j.dir, timeoutMs: 10_000 },
      ac(),
    );
    assert.equal(r.stdout, "undefined", "secret injection must never reach a tool it was not given to");
  } finally {
    delete process.env["LOOM_LEAK_CHECK"];
    j.dispose();
  }
});

function readOr(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "(missing)";
  }
}
