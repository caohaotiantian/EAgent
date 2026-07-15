import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { wireRendering } from "../src/cli.js";
import { makeHarness } from "./helpers.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "src", "cli.ts");

/** Run the CLI as a real subprocess (offline, mock provider) with piped stdin. */
function runCli(args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: repoRoot,
      // Strip provider keys so nothing tries to reach the network; the mock provider runs offline.
      env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "", EAGENT_MCP_SERVERS: "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

test("--json batch mode emits only valid JSONL on stdout", { timeout: 30000 }, async () => {
  // A normal turn line AND a slash command — both are non-JSONL human output that
  // used to leak to stdout (the `› hi` echo and the /help text), breaking JSON.parse.
  const { stdout } = await runCli(["-p", "mock", "--json"], "hi\n/help\n");

  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `stdout line is not JSON: ${JSON.stringify(line)}`);
  }
  // The events still flow (the turn produces at least an agent_end lifecycle event).
  assert.ok(lines.length > 0, "at least one JSONL event was emitted on stdout");
  assert.ok(
    lines.some((l) => typeof (JSON.parse(l) as { type?: unknown }).type === "string"),
    "emitted JSONL events carry a `type` field",
  );
  // In --json mode /help output goes to stderr, so the last stdout line is the
  // hi turn's canonical terminal.
  const last = JSON.parse(lines[lines.length - 1]!) as { type?: unknown };
  assert.equal(last.type, "agent_end", "the last stdout line is the canonical agent_end terminal");
});

test("human (non-json) batch mode still echoes input on stdout", async () => {
  const { stdout } = await runCli(["-p", "mock"], "hi\n");
  // The `› hi` echo remains on stdout in human mode (behavior unchanged).
  assert.ok(stdout.includes("› hi"), "human mode echoes the input line on stdout");
});

// -- D1: the human REPL surfaces abnormal terminal reasons ------------------
// The interactive renderer otherwise drops `agent_end.reason` (only --json mode
// surfaces it), so a truncated answer ends silently. These drive `wireRendering`
// in-process against a MockProvider scripted to a terminal reason and assert on
// captured stdout — the subprocess harness cannot script a `max_tokens` turn.

/** Capture everything written to process.stdout while `run` executes. */
async function stdoutOf(run: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

test("wireRendering warns on a max_tokens truncation, naming the cause and the recovery lever", async () => {
  const { agent, provider } = makeHarness();
  wireRendering(agent);
  provider.script({ text: "here is a partial ans", stopReason: "max_tokens" });

  const out = await stdoutOf(() => agent.run("go"));

  assert.match(out, /truncat/i, "the warning describes the answer as truncated");
  assert.match(out, /max_tokens/, "the warning names the terminal reason");
  assert.match(out, /MAX_TOKENS/, "the recovery hint names the *_MAX_TOKENS lever");
});

test("wireRendering warns on the rest of the abnormal-and-silent set (content_filter, refusal)", async () => {
  const { agent, provider } = makeHarness();
  wireRendering(agent);

  provider.script({ text: "x", stopReason: "content_filter" });
  const filtered = await stdoutOf(() => agent.run("go"));
  assert.match(filtered, /⚠ response/, "content_filter prints a warning line");
  assert.match(filtered, /content_filter/, "the content_filter warning names the reason");

  provider.script({ text: "x", stopReason: "refusal" });
  const refused = await stdoutOf(() => agent.run("go"));
  assert.match(refused, /⚠ response/, "refusal prints a warning line");
  assert.match(refused, /refusal/, "the refusal warning names the reason");
});

test("wireRendering stays quiet on clean or already-signalled terminal reasons", async () => {
  const { agent, provider } = makeHarness();
  wireRendering(agent);

  // (b) a clean end_turn prints no warning line.
  provider.script({ text: "all done" });
  const clean = await stdoutOf(() => agent.run("go"));
  assert.doesNotMatch(clean, /⚠ response/, "end_turn is a clean end — no warning");
  assert.doesNotMatch(clean, /truncat/i, "end_turn is not a truncation");

  // (c) a provider-done `stop` already has its own signals (Ctrl-C / terminate /
  // maxTurns), so D1 does not warn on it.
  provider.script({ text: "halted", stopReason: "stop" });
  const stopped = await stdoutOf(() => agent.run("go"));
  assert.doesNotMatch(stopped, /⚠ response/, "stop is deliberately excluded from the warn-set");

  // (c) an `error` run is already surfaced by the error handler + runTurn catch,
  // so the agent_end handler adds no truncation warning.
  provider.script(() => {
    throw new Error("provider boom");
  });
  const errored = await stdoutOf(() => assert.rejects(agent.run("go")));
  assert.doesNotMatch(errored, /⚠ response/, "error is already surfaced elsewhere — no truncation warning");
});
