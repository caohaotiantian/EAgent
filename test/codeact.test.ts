/**
 * Tests for the CodeAct extension. We drive the real agent loop with a scripted
 * MockProvider that emits a `run_code` tool call, then inspect the resulting
 * `role:"tool"` message to assert on the captured output and `isError` flag.
 *
 * JavaScript (node) is used for the deterministic cases since it is always
 * present; python is exercised only when `python3` exists on the box.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import type { Agent } from "../src/kernel/agent.js";
import type { ToolResultBlock } from "../src/kernel/types.js";
import codeact from "../src/extensions/codeact.js";
import { makeHarness } from "./helpers.js";

/** Restore an env var to its prior value (or remove it if it was unset). */
function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

/** Find the most recent tool_result block in the transcript. */
function lastToolResult(agent: Agent): ToolResultBlock {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i]!;
    if (m.role !== "tool") continue;
    const block = m.content[0];
    if (block && block.type === "tool_result") return block;
  }
  throw new Error("no tool_result found in transcript");
}

/** One tool-call turn followed by an empty turn so the loop terminates. */
function scriptRunCode(args: Record<string, unknown>) {
  return [
    { toolCalls: [{ name: "run_code", arguments: args, id: "call_1" }] },
    { text: "done" },
  ];
}

const pythonAvailable = (() => {
  try {
    return spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

test("run_code executes a javascript snippet and returns its output", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: scriptRunCode({ language: "javascript", code: "console.log(2+3)", timeout: 5000 }),
  });
  await h.host.use("codeact", codeact);

  await h.agent.run("compute 2+3");

  const result = lastToolResult(h.agent);
  assert.equal(result.isError ?? false, false);
  assert.match(result.content, /5/);
});

test("run_code is blocked when the code:exec capability is denied", async () => {
  const h = makeHarness({
    fallback: "deny",
    responder: scriptRunCode({ language: "javascript", code: "console.log('SHOULD_NOT_RUN')", timeout: 5000 }),
  });
  await h.host.use("codeact", codeact);

  await h.agent.run("try to run code");

  const result = lastToolResult(h.agent);
  assert.equal(result.isError, true);
  // The capability error message contains "denied"; the program never ran.
  assert.match(result.content, /denied/i);
  assert.doesNotMatch(result.content, /SHOULD_NOT_RUN/);
});

test("run_code reports a non-zero exit as an error result", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: scriptRunCode({
      language: "javascript",
      code: "console.error('boom'); process.exit(1)",
      timeout: 5000,
    }),
  });
  await h.host.use("codeact", codeact);

  await h.agent.run("run failing code");

  const result = lastToolResult(h.agent);
  assert.equal(result.isError, true);
  assert.match(result.content, /boom/);
});

test("run_code enforces the timeout and reports it", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: scriptRunCode({
      language: "javascript",
      code: "setTimeout(() => {}, 60000)",
      timeout: 200,
    }),
  });
  await h.host.use("codeact", codeact);

  await h.agent.run("run a hang");

  const result = lastToolResult(h.agent);
  assert.equal(result.isError, true);
  assert.match(result.content, /timeout/i);
});

test("python3 snippet runs when the interpreter is present", { skip: !pythonAvailable }, async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: scriptRunCode({ language: "python", code: "print(6*7)", timeout: 5000 }),
  });
  await h.host.use("codeact", codeact);

  await h.agent.run("compute 6*7");

  const result = lastToolResult(h.agent);
  assert.equal(result.isError ?? false, false);
  assert.match(result.content, /42/);
});

test("/code command runs a one-off snippet through the capability check", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("codeact", codeact);

  const cmd = h.commands.get("code");
  assert.ok(cmd, "code command registered");

  const lines: string[] = [];
  await cmd!.run({ agent: h.agent, args: "javascript console.log(7*8)", print: (l) => lines.push(l) });

  assert.match(lines.join("\n"), /56/);
});

test("/code command refuses when capability is denied", async () => {
  const h = makeHarness({ fallback: "deny" });
  await h.host.use("codeact", codeact);

  const cmd = h.commands.get("code");
  const lines: string[] = [];
  await cmd!.run({ agent: h.agent, args: "javascript console.log('NOPE')", print: (l) => lines.push(l) });

  const out = lines.join("\n");
  assert.match(out, /Denied/i);
  assert.doesNotMatch(out, /NOPE/);
});

// -- isolation tier (off-by-default, fail-closed) ---------------------------

/**
 * AC-4: with a tier selected and a backend forced, the interpreter must be
 * invoked THROUGH the launcher. Spying on `child_process.spawn` is not
 * realizable under `npm test`, so we drop a fake `bwrap` shim on PATH that just
 * prints a marker; seeing the marker in the captured output proves the spawn
 * was routed via the wrapped launcher.
 */
test("tier wraps the spawn through the active launcher (AC-4)", async () => {
  const prevPath = process.env.PATH;
  const prevBackend = process.env.EAGENT_SANDBOX_BACKEND;
  const prevTier = process.env.EAGENT_CODEACT_TIER;
  const shimDir = mkdtempSync(join(tmpdir(), "eagent-codeact-shim-"));
  try {
    const shim = join(shimDir, "bwrap");
    writeFileSync(shim, "#!/bin/sh\necho '[[WRAPPED]]'\nexit 0\n", "utf8");
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}${delimiter}${prevPath ?? ""}`;
    process.env.EAGENT_SANDBOX_BACKEND = "bwrap";
    process.env.EAGENT_CODEACT_TIER = "workspace-write";

    const h = makeHarness({
      fallback: "allow",
      responder: scriptRunCode({ language: "javascript", code: "console.log('INNER_RAN')", timeout: 5000 }),
    });
    await h.host.use("codeact", codeact);

    await h.agent.run("run wrapped");

    const result = lastToolResult(h.agent);
    assert.match(result.content, /\[\[WRAPPED\]\]/, "the interpreter was invoked through the wrapped launcher");
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    restoreEnv("PATH", prevPath);
    restoreEnv("EAGENT_SANDBOX_BACKEND", prevBackend);
    restoreEnv("EAGENT_CODEACT_TIER", prevTier);
  }
});

/**
 * AC-5: a tier is selected but no backend is available; with the default
 * missingBackend=block, code:exec must refuse rather than run unsandboxed — and
 * the snippet must never spawn (its marker is absent from the output).
 */
test("fail closed: tier set with no backend refuses to run (AC-5)", async () => {
  const prevBackend = process.env.EAGENT_SANDBOX_BACKEND;
  const prevTier = process.env.EAGENT_CODEACT_TIER;
  try {
    process.env.EAGENT_SANDBOX_BACKEND = "none";
    process.env.EAGENT_CODEACT_TIER = "workspace-write";

    const h = makeHarness({
      fallback: "allow",
      responder: scriptRunCode({ language: "javascript", code: "console.log('FAILCLOSED_MARKER')", timeout: 5000 }),
    });
    await h.host.use("codeact", codeact);

    await h.agent.run("run blocked");

    const result = lastToolResult(h.agent);
    assert.equal(result.isError, true);
    assert.match(result.content, /refusing/i);
    assert.doesNotMatch(result.content, /FAILCLOSED_MARKER/, "the interpreter never spawned");
  } finally {
    restoreEnv("EAGENT_SANDBOX_BACKEND", prevBackend);
    restoreEnv("EAGENT_CODEACT_TIER", prevTier);
  }
});

/**
 * AC-5 (escape hatch): with missingBackend=pass, a missing backend degrades to
 * running unwrapped instead of refusing — the snippet's marker is present.
 */
test("fail open with missing=pass: tier set with no backend runs unwrapped (AC-5)", async () => {
  const prevBackend = process.env.EAGENT_SANDBOX_BACKEND;
  const prevTier = process.env.EAGENT_CODEACT_TIER;
  try {
    process.env.EAGENT_SANDBOX_BACKEND = "none";
    process.env.EAGENT_CODEACT_TIER = "workspace-write";

    const h = makeHarness({
      fallback: "allow",
      responder: scriptRunCode({ language: "javascript", code: "console.log('PASS_MARKER')", timeout: 5000 }),
    });
    await h.host.use("codeact", (e) => {
      e.store.set("missingBackend", "pass");
      return codeact(e);
    });

    await h.agent.run("run unwrapped");

    const result = lastToolResult(h.agent);
    assert.equal(result.isError ?? false, false);
    assert.match(result.content, /PASS_MARKER/, "missing=pass runs the snippet unwrapped");
  } finally {
    restoreEnv("EAGENT_SANDBOX_BACKEND", prevBackend);
    restoreEnv("EAGENT_CODEACT_TIER", prevTier);
  }
});

/**
 * AC-6: with no tier set (default off) AND a fake launcher on PATH, the snippet
 * runs directly — its marker is present and the launcher's marker is absent,
 * proving the spawn is byte-identical to the pre-tier `spawn(interp,[file])`.
 */
test("default-off is byte-identical: the launcher is never invoked (AC-6)", async () => {
  const prevPath = process.env.PATH;
  const prevBackend = process.env.EAGENT_SANDBOX_BACKEND;
  const prevTier = process.env.EAGENT_CODEACT_TIER;
  const shimDir = mkdtempSync(join(tmpdir(), "eagent-codeact-shim-"));
  try {
    const shim = join(shimDir, "bwrap");
    writeFileSync(shim, "#!/bin/sh\necho '[[WRAPPED]]'\nexit 0\n", "utf8");
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}${delimiter}${prevPath ?? ""}`;
    process.env.EAGENT_SANDBOX_BACKEND = "bwrap";
    delete process.env.EAGENT_CODEACT_TIER; // tier defaults to off

    const h = makeHarness({
      fallback: "allow",
      responder: scriptRunCode({ language: "javascript", code: "console.log('DIRECT_MARKER')", timeout: 5000 }),
    });
    await h.host.use("codeact", codeact);

    await h.agent.run("run direct");

    const result = lastToolResult(h.agent);
    assert.match(result.content, /DIRECT_MARKER/, "the snippet ran");
    assert.doesNotMatch(result.content, /\[\[WRAPPED\]\]/, "tier=off never invokes the launcher");
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
    restoreEnv("PATH", prevPath);
    restoreEnv("EAGENT_SANDBOX_BACKEND", prevBackend);
    restoreEnv("EAGENT_CODEACT_TIER", prevTier);
  }
});

test("/codeact status, tier, and missing reflect the stored config", async () => {
  const prevBackend = process.env.EAGENT_SANDBOX_BACKEND;
  const prevTier = process.env.EAGENT_CODEACT_TIER;
  try {
    process.env.EAGENT_SANDBOX_BACKEND = "bwrap";
    delete process.env.EAGENT_CODEACT_TIER;

    const h = makeHarness({ fallback: "allow" });
    await h.host.use("codeact", codeact);

    const cmd = h.commands.get("codeact");
    assert.ok(cmd, "codeact command registered");

    const lines: string[] = [];
    const print = (l: string): void => {
      lines.push(l);
    };
    await cmd!.run({ agent: h.agent, args: "tier no-network", print });
    await cmd!.run({ agent: h.agent, args: "missing pass", print });
    await cmd!.run({ agent: h.agent, args: "status", print });

    const status = lines.at(-1)!;
    assert.match(status, /tier=no-network/, "status reflects the stored tier");
    assert.match(status, /backend=bwrap/, "status reflects the resolved backend");
    assert.match(status, /missing=pass/, "status reflects the stored missing policy");

    const bogus: string[] = [];
    await cmd!.run({ agent: h.agent, args: "tier bogus", print: (l) => bogus.push(l) });
    assert.match(bogus.at(-1)!, /unknown tier/);
  } finally {
    restoreEnv("EAGENT_SANDBOX_BACKEND", prevBackend);
    restoreEnv("EAGENT_CODEACT_TIER", prevTier);
  }
});
