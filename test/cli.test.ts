import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { entryShouldRun, registerHostCommands, wireRendering } from "../src/cli.js";
import { CommandRegistry, type CommandContext } from "../src/kernel/commands.js";
import type { Agent } from "../src/kernel/agent.js";
import type { ExtensionHost } from "../src/kernel/extension.js";
import { EngineRenderer } from "../src/engine-render.js";
import { SPINNER_FRAMES, type RenderController } from "../src/tty.js";
import type { ControlAction, DisplayMode } from "../src/view-model.js";
import { makeFakeTerm, makeHarness } from "./helpers.js";

/** Assert a non-interactive stream carries no alt-screen / cursor / spinner bytes. */
function assertPlainStream(stdout: string): void {
  assert.doesNotMatch(stdout, /\x1b\[\?1049/, "no alt-screen enter/exit");
  assert.doesNotMatch(stdout, /\x1b\[\d*A/, "no cursor-up rewrites");
  for (const frame of SPINNER_FRAMES) {
    assert.ok(!stdout.includes(frame), `no spinner frame ${frame} in a machine stream`);
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "src", "cli.ts");

/** Run the CLI as a real subprocess (offline, mock provider) with piped stdin. */
function runCli(
  args: string[],
  input: string,
  script: string = cliPath,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
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

// -- T1.10a: non-interactive parity (AC11) — the subprocess-runnable axes ----
// A piped subprocess has isTTY:false on both stdio, so `interactive`/`fancy` are
// false: the plain, cursor-free append path must carry no fancy control bytes.

test("T1.10a --eval emits a plain stream: no alt-screen, cursor, or spinner bytes", async () => {
  const { stdout } = await runCli(["-p", "mock", "-e", "hello there"], "");
  assertPlainStream(stdout);
});

test("T1.10a piped batch emits a plain stream: no alt-screen, cursor, or spinner bytes", async () => {
  const { stdout } = await runCli(["-p", "mock"], "hi\nwhat is up\n");
  assertPlainStream(stdout);
});

// -- T4.3b: the startup suggest-hint never leaks into a subprocess stream (D7) -
// The hint prints STARTUP-ONLY on an interactive, raw-capable-TTY, non-json terminal.
// A piped subprocess (isTTY:false) and --json/--eval are all non-suggesting axes,
// so no hint line may appear on stdout. The TTY-requiring positive case cannot be
// faked by a pipe; the former TUI suggest-hint path is gone (zero-dep AC8).

test("T4.3b --json prints no startup suggest-hint on stdout", async () => {
  const { stdout } = await runCli(["-p", "mock", "--json"], "hi\n");
  assert.doesNotMatch(stdout, /eagent-tui/, "no eagent-tui hint leaks into the machine stream");
  assert.doesNotMatch(stdout, /full-screen/i, "no suggest-hint phrasing on stdout");
});

test("T4.3b --eval prints no startup suggest-hint on stdout", async () => {
  const { stdout } = await runCli(["-p", "mock", "-e", "hello there"], "");
  assert.doesNotMatch(stdout, /eagent-tui/, "no eagent-tui hint in a non-interactive --eval run");
  assert.doesNotMatch(stdout, /full-screen/i, "no suggest-hint phrasing on stdout");
});

test("fires main() when launched through a symlinked bin (packaged `eagent` install)", { timeout: 30000 }, async () => {
  // npm installs the `eagent` bin (package.json) as a Unix symlink. Node realpaths
  // import.meta.url to the real cli file while argv[1] stays the symlink path, so a
  // guard comparing the two raw never matches and a globally-installed `eagent`
  // launches nothing. The entry-point guard must resolve argv[1]'s realpath.
  const dir = mkdtempSync(join(tmpdir(), "eagent-bin-"));
  const link = join(dir, "eagent-link.ts");
  symlinkSync(cliPath, link);
  try {
    const { stdout } = await runCli(["-p", "mock"], "hi\n", link);
    assert.ok(stdout.includes("› hi"), "the symlink-launched CLI ran main() (echoed input on stdout)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- entryShouldRun: the SEA-aware, unit-testable entry guard ----------------
// The call site feeds `process.argv[1]`, `import.meta.url`, and `isSea()` into this
// pure function so every branch (SEA true; realpath match; mismatch; throw) is
// covered offline with no binary build.

test("entryShouldRun fires when isSea, regardless of argv1", () => {
  assert.equal(entryShouldRun(undefined, "file:///x", true), true);
  assert.equal(entryShouldRun("/any/path", "file:///x", true), true);
});

test("entryShouldRun matches on argv1 realpath's file URL when not SEA", () => {
  const url = pathToFileURL(realpathSync(cliPath)).href;
  assert.equal(entryShouldRun(cliPath, url, false), true, "realpath match fires");
  assert.equal(entryShouldRun(cliPath, "file:///nope", false), false, "url mismatch does not fire");
});

test("entryShouldRun returns false for undefined or unresolvable argv1 when not SEA", () => {
  assert.equal(entryShouldRun(undefined, "file:///x", false), false, "undefined argv1 → false");
  const missing = join(repoRoot, "does-not-exist-dir", "ghost.ts");
  assert.equal(entryShouldRun(missing, "file:///x", false), false, "realpathSync throw is caught → false");
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

// -- T2.6: the /details, /expand, /collapse command-dispatch layer -----------
// registerHostCommands wires the display commands as pure closures over a mutable
// `active` renderer holder. `applyControl`'s SEMANTICS are covered elsewhere
// (render-modes/render-inline); these drive the registered command handlers
// against a real CommandRegistry + a fake RenderController so the COMMAND
// wrapper's own branching — integer/range validation, the mode allowlist, the
// unavailable-fallback, the no-arg readout, and every error message — is covered
// without an interactive REPL. A regression like accepting n=0 or off-by-one on
// n-1 that the model-level tests can't see would fail here.

/** Strip SGR color codes so assertions match the human-readable message text. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A recording RenderController: captures every applied control and tracks mode. */
class FakeController implements RenderController {
  mode: DisplayMode = "auto";
  readonly calls: ControlAction[] = [];
  applyControl(action: ControlAction): void {
    this.calls.push(action);
    if (action.kind === "mode") this.mode = action.mode;
  }
}

/** Register the host commands over `active`, returning a driver that invokes a
 *  display command by name and returns its printed (ANSI-stripped) output. The host
 *  and agent are unused by the display commands, so minimal fakes suffice. */
function displayCommands(active: { current?: RenderController }): (name: string, args: string) => Promise<string> {
  const commands = new CommandRegistry();
  registerHostCommands(commands, {} as unknown as ExtensionHost, {} as unknown as Agent, active);
  return async (name, args) => {
    const cmd = commands.get(name);
    assert.ok(cmd, `command /${name} is registered`);
    const out: string[] = [];
    const ctx: CommandContext = { agent: {} as unknown as Agent, args, print: (l) => out.push(l) };
    await cmd!.run(ctx);
    return stripAnsi(out.join("\n"));
  };
}

test("T2.6 display commands report unavailability when no renderer is wired (active.current absent)", async () => {
  const run = displayCommands({}); // no renderer wired yet (e.g. --json / non-fancy)
  for (const [name, args] of [["details", ""], ["expand", "2"], ["collapse", "2"]] as const) {
    assert.match(await run(name, args), /display control is unavailable in this mode\./, `/${name} guards on no renderer`);
  }
});

test("T2.6 /details reads the mode with no arg, sets it on the allowlist, rejects anything else", async () => {
  const r = new FakeController();
  const run = displayCommands({ current: r });

  // No-arg → a readout (not a control); reflects the renderer's current mode.
  assert.equal(await run("details", ""), "display mode = auto");
  assert.equal(r.calls.length, 0, "a bare /details is a readout, not a control");

  for (const mode of ["full", "collapsed", "auto"] as const) {
    assert.equal(await run("details", mode), `display mode = ${mode}`);
    assert.deepEqual(r.calls.at(-1), { kind: "mode", mode }, `/details ${mode} applies a mode control`);
    assert.equal(r.mode, mode, "the readout now reflects the new mode");
    assert.equal(await run("details", "  " + mode + " "), `display mode = ${mode}`, "the mode arg is trimmed");
  }

  const applied = r.calls.length;
  for (const bad of ["wide", "FULL", "expanded", "collapse", "1"]) {
    const out = await run("details", bad);
    assert.ok(out.includes(`unknown mode: ${bad}`), `the error echoes the rejected token: ${bad}`);
    assert.match(out, /full \| collapsed \| auto/, "the error lists the allowed modes");
  }
  assert.equal(r.calls.length, applied, "no invalid mode reached applyControl");
});

test("T2.6 /expand and /collapse route a valid section number and reject bad ones", async () => {
  const r = new FakeController();
  const run = displayCommands({ current: r });

  assert.match(await run("expand", "2"), /^expanded section 2\.$/);
  assert.deepEqual(r.calls.at(-1), { kind: "expand", n: 2 });

  assert.match(await run("collapse", "3"), /^collapsed section 3\.$/);
  assert.deepEqual(r.calls.at(-1), { kind: "collapse", n: 3 });

  // Surrounding whitespace is trimmed before Number(); n=1 (the lower bound) is valid.
  assert.match(await run("expand", "  1  "), /^expanded section 1\.$/);
  assert.deepEqual(r.calls.at(-1), { kind: "expand", n: 1 }, "n=1 is accepted (no off-by-one at the lower bound)");

  const applied = r.calls.length;
  // n<1, non-integers, and non-numbers are all rejected — notably 0 and negatives.
  for (const bad of ["", "0", "-1", "abc", "1.5", "2 3", "Infinity"]) {
    assert.match(
      await run("expand", bad),
      /^\/expand needs a section number, e\.g\. \/expand 2\.$/,
      `/expand rejects ${JSON.stringify(bad)}`,
    );
  }
  // The error names the invoked command, not a hardcoded /expand.
  assert.match(await run("collapse", "x"), /^\/collapse needs a section number, e\.g\. \/collapse 2\.$/);
  assert.equal(r.calls.length, applied, "no invalid section number reached applyControl");
});

test("T2.6 /details with no arg reads a real EngineRenderer's mode via its get mode() accessor", async () => {
  const renderer = new EngineRenderer({ term: makeFakeTerm({ columns: 80 }) });
  const run = displayCommands({ current: renderer });

  // The initial model's mode is auto; the no-arg readout exercises get mode().
  assert.equal(await run("details", ""), "display mode = auto");

  // /details full drives the REAL renderer; the getter then reports the new mode.
  assert.equal(await run("details", "full"), "display mode = full");
  assert.equal(renderer.mode, "full", "the command drove the real renderer's mode");
  assert.equal(await run("details", ""), "display mode = full", "the no-arg readout reflects the change via get mode()");
});
