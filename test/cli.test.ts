import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
