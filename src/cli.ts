#!/usr/bin/env node
/**
 * The EAgent headless CLI — a thin, non-interactive host around the kernel.
 *
 * It does only host things: pick a provider, install the built-in extensions,
 * discover user extensions, print the stream, and dispatch slash commands. This
 * entry owns the *machine* paths only — `--eval`, `--json`, and piped batch. The
 * interactive terminal experience is the `tui/` package; nothing here mounts a
 * display, so no cursor or alt-screen byte can reach a pipe by construction.
 *
 * Run with no API key and it drives the deterministic mock so you can explore
 * everything offline.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { stdin } from "node:process";
import { isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Agent } from "./kernel/agent.js";
import type { CommandRegistry } from "./kernel/commands.js";
import type { ExtensionHost } from "./kernel/extension.js";
import type { Logger, UI } from "./kernel/types.js";
import { OPTIONS_HELP, parseArgs } from "./args.js";
import { createAgentHost, loadEnvFile, thinkingFromEnv } from "./host.js";
import { registerHostCommands } from "./host-commands.js";
import { eventToJsonl, wireJsonl } from "./jsonl.js";
import { wirePlainPrinting } from "./print.js";

const USAGE = `EAgent — a minimalist agent with a tiny core and Emacs-grade extensibility

Usage: eagent-headless [options]

${OPTIONS_HELP}

This entry is non-interactive: it reads --eval or piped stdin and exits. The
interactive TUI lives in the \`tui/\` package and is not part of this build yet.
With no API key, EAgent runs the deterministic offline mock provider.`;

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

/** The headless run, exported so the TUI package can hand off to it in-process
 *  when an invocation turns out to be non-interactive. Returns the exit code. */
export async function runHeadless(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Pick up a local .env (without overriding the real environment) so keys and
  // model selection configured there are honored before providers are built.
  loadEnvFile();
  let exitCode = 0;

  const args = parseArgs(argv);

  if (args.help) {
    console.log(USAGE);
    return exitCode;
  }
  if (args.version) {
    console.log(await readVersion());
    return exitCode;
  }

  // Headless by definition: there is no one to prompt, so capability requests
  // follow the --yolo policy and elicitation reports absence. The `ask` tool's
  // absence-fallback then keeps the run moving forward.
  const ui: UI = {
    confirm: async () => args.yolo,
    ask: async () => null,
    notify: (m) => console.error(C.dim(`· ${m}`)),
  };

  // Diagnostics go to stderr so stdout stays clean (essential for --json mode).
  const logger: Logger = {
    debug: () => {},
    info: (...a) => console.error(C.dim(["·", ...a].join(" "))),
    warn: (...a) => console.error(C.yellow(["!", ...a].join(" "))),
    error: (...a) => console.error(C.red(["✗", ...a].join(" "))),
  };

  const { agent, host, commands } = await createAgentHost({
    ui,
    logger,
    yolo: args.yolo,
    provider: args.provider,
    model: args.model,
    thinking: args.think ? thinkingFromEnv(args.think) : undefined,
    extraExtensions: args.extensions,
  });

  try {
    await agent.hooks.emit("session_start", {});

    if (args.json) wireJsonRendering(agent);
    else wirePlainPrinting(agent);

    registerHostCommands(commands, host, agent);

    // No readline here, so a bare Ctrl-C/SIGTERM would skip host.dispose() and
    // orphan extension resources (MCP child processes, temp dirs). Tear the host
    // down on signal before exiting; the shared shuttingDown guard makes
    // SIGINT-then-SIGTERM dispose once instead of racing two disposes.
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (agent.running) agent.stop();
      void host.dispose().finally(() => process.exit(130));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    // A positional prompt is equivalent to --eval for this entry.
    const once = args.eval ?? args.prompt;
    if (once !== undefined) {
      await runTurn(agent, once);
    } else if (stdin.isTTY) {
      // A TTY never sends EOF on its own, so falling through to batch() would
      // block on a stream that will not close — a silent hang with no prompt.
      // This entry is machine-only; say so and exit rather than appear frozen.
      console.error(C.yellow("This entry is non-interactive: pass --eval <text> or pipe stdin."));
      console.error(C.dim("The interactive TUI (tui/ package) is not part of this build yet."));
      exitCode = 2;
    } else {
      // Piped, non-interactive stdin: treat each line as a command or a turn.
      await batch(agent, commands, host, args.json);
    }
  } catch (err) {
    // An error before the normal-path dispose must still tear the host down so
    // session_shutdown fires (symmetric with the signal path); rethrow to the
    // outer main().catch. The success-path dispose below stays outside this try
    // so a dispose throw can't re-enter here and double-dispose.
    await host.dispose();
    throw err;
  }

  await host.dispose();
  return exitCode;
}

/** Read all of stdin and process it line by line, then exit. */
async function batch(agent: Agent, commands: CommandRegistry, host: ExtensionHost, json: boolean): Promise<void> {
  // In --json mode stdout carries only the JSONL lifecycle events; the human echo
  // goes to stderr so a consumer's per-line JSON.parse never hits a non-JSON line.
  const echo = (s: string): void => (json ? console.error(s) : console.log(s));
  const lines = (await readAll(stdin)).split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line === "/quit" || line === "/exit") continue;
    if (line.startsWith("/")) {
      await dispatchCommand(line, commands, agent, host, json);
    } else {
      echo(C.bold(`\n› ${line}`));
      await runTurn(agent, line);
    }
  }
}

function readAll(stream: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => (data += c));
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

async function dispatchCommand(
  line: string,
  commands: CommandRegistry,
  agent: Agent,
  _host: ExtensionHost,
  json: boolean,
): Promise<void> {
  // Command output and errors are not JSONL lifecycle events; in --json mode they
  // go to stderr so stdout stays a clean machine-readable stream.
  const out = (s: string): void => (json ? console.error(s) : console.log(s));
  const [name, ...rest] = line.slice(1).split(" ");
  const command = commands.get(name!);
  if (!command) {
    out(C.red(`Unknown command: /${name}. Try /help.`));
    return;
  }
  try {
    await command.run({ agent, args: rest.join(" "), print: out });
  } catch (err) {
    out(C.red(`✗ /${name}: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** Programmatic mode: emit one JSON object per lifecycle event to stdout. */
function wireJsonRendering(agent: Agent): void {
  const emit = (obj: unknown): void => {
    process.stdout.write(JSON.stringify(obj) + "\n");
  };
  wireJsonl(emit, agent);
  agent.hooks.on("agent_end", ({ reason }) => emit(eventToJsonl("agent_end", { reason, usage: agent.usage })));
  agent.hooks.on("error", ({ error, where }) =>
    emit(eventToJsonl("error", { where, message: error instanceof Error ? error.message : String(error) })),
  );
}

async function runTurn(agent: Agent, input: string): Promise<void> {
  try {
    await agent.run(input);
  } catch (err) {
    // Always stderr: in --json mode stdout is reserved for JSONL, and in plain
    // mode stdout is reserved for the answer.
    console.error(C.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** Read this package's version from package.json (one level up from src or dist). */
async function readVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
    return `eagent ${pkg.version ?? "unknown"}`;
  } catch {
    return "eagent unknown";
  }
}

// Only run the CLI when this file is the process entry point (the installed bin,
// the subprocess cli tests, or a SEA binary). An `import` of this module — e.g. a
// test driving `registerHostCommands` in-process — must not launch the whole CLI.
// Pure and injected so every branch is unit-testable without a build: `isSea`
// short-circuits true inside a Single Executable Application (there argv[1] is not
// a script path, so the realpath compare cannot match); otherwise realpath argv[1]
// to match Node's already-realpathed import.meta.url, because npm installs bins as
// symlinks and a globally-installed bin keeps the symlink path in argv[1]. An
// undefined or unresolvable argv[1] returns false.
export function entryShouldRun(argv1: string | undefined, importMetaUrl: string, isSea: boolean): boolean {
  if (isSea) return true;
  if (!argv1) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
if (entryShouldRun(process.argv[1], import.meta.url, isSea())) {
  runHeadless()
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
