#!/usr/bin/env node
/**
 * The EAgent CLI — a thin host around the kernel.
 *
 * It does only host things: pick a provider, install the built-in extensions,
 * discover user extensions, render the stream, and dispatch slash commands.
 * All behavior worth having lives in extensions; this file just wires them to
 * a terminal. Run with no API key and it drives the deterministic mock so you
 * can explore everything offline.
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface, type Interface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import type { Agent } from "./kernel/agent.js";
import type { CommandRegistry } from "./kernel/commands.js";
import type { ExtensionHost } from "./kernel/extension.js";
import type { Logger, UI } from "./kernel/types.js";
import { complete } from "./complete.js";
import { createAgentHost, loadEnvFile, PROVIDER_NAMES, thinkingFromEnv } from "./host.js";

interface Args {
  model?: string;
  provider?: string;
  think?: string;
  eval?: string;
  yolo: boolean;
  extensions: string[];
  help: boolean;
  version: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { yolo: false, extensions: [], help: false, version: false, json: false };
  // Read the value following a value-taking flag, erroring if it is missing.
  // `allowDash` lets free-form values (eval text) begin with '-'; for the rest a
  // dash-prefixed token means the next flag, not a value (so `--model --yolo`
  // errors instead of silently setting model to "--yolo").
  const takeValue = (flag: string, i: number, allowDash = false): string => {
    const v = argv[i + 1];
    if (v === undefined || (!allowDash && v.startsWith("-"))) {
      throw new Error(`option ${flag} requires a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--model" || a === "-m") args.model = takeValue(a, i++);
    else if (a === "--provider" || a === "-p") args.provider = takeValue(a, i++);
    else if (a === "--think") args.think = takeValue(a, i++);
    else if (a === "--eval" || a === "-e") args.eval = takeValue(a, i++, true);
    else if (a === "--yolo") args.yolo = true;
    else if (a === "--ext") args.extensions.push(takeValue(a, i++));
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--json") args.json = true;
    else throw new Error(`unknown option: ${a} (try --help)`);
  }
  return args;
}

const USAGE = `EAgent — a minimalist agent with a tiny core and Emacs-grade extensibility

Usage: eagent [options]

Options:
  -e, --eval <text>      Run one turn with <text> and exit (non-interactive)
  -m, --model <name>     Model to use (e.g. claude-fable-5, gpt-4o)
  -p, --provider <name>  Provider: anthropic | openai | gemini | mock
      --think <level>    Reasoning effort: off | low | medium | high
      --ext <path>       Load an extra extension file (repeatable)
      --yolo             Auto-grant capabilities (no approval prompts)
      --json             Emit lifecycle events as JSONL (programmatic mode)
  -h, --help             Show this help and exit
  -v, --version          Print the version and exit

With no API key, EAgent runs the deterministic offline mock provider.
Live providers are selected automatically from ANTHROPIC_API_KEY / OPENAI_API_KEY.
Interactive commands: type /help inside the session.`;

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

async function main(): Promise<void> {
  // Pick up a local .env (without overriding the real environment) so keys and
  // model selection configured there are honored before providers are built.
  loadEnvFile();

  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.version) {
    console.log(await readVersion());
    return;
  }

  const interactive = Boolean(stdin.isTTY) && args.eval === undefined;
  // The readline interface is created only after createAgentHost yields the
  // live command/extension registries the completer reads, so it is declared
  // here and assigned below; ui.confirm's `if (!rl)` guard late-binds it.
  let rl: Interface | undefined;

  const ui: UI = {
    confirm: async (q) => {
      // Without a TTY there is no one to ask; follow the --yolo policy.
      if (!rl) return args.yolo;
      const answer = (await rl.question(`${C.yellow("?")} ${q} ${C.dim("[y/N]")} `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
    notify: (m) => console.error(C.dim(`· ${m}`)),
  };

  // Diagnostics go to stderr so stdout stays clean (essential for --json mode).
  const logger: Logger = {
    debug: () => {},
    info: (...a) => console.error(C.dim(["·", ...a].join(" "))),
    warn: (...a) => console.error(C.yellow(["!", ...a].join(" "))),
    error: (...a) => console.error(C.red(["✗", ...a].join(" "))),
  };

  const { agent, host, commands, live } = await createAgentHost({
    ui,
    logger,
    yolo: args.yolo,
    provider: args.provider,
    model: args.model,
    thinking: args.think ? thinkingFromEnv(args.think) : undefined,
    extraExtensions: args.extensions,
  });

  registerHostCommands(commands, host, agent);

  // Tab completion reads the live registries at completion time, so the
  // interface is built now that commands and the host exist.
  const completer = (line: string): [string[], string] =>
    complete(line, {
      commandNames: () => commands.list().map((c) => c.name),
      extensionIds: () => host.list(),
      providerNames: PROVIDER_NAMES,
      readDir: (dir) => readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() })),
      homedir,
    });
  rl = interactive ? createInterface({ input: stdin, output: stdout, completer }) : undefined;

  await agent.hooks.emit("session_start", {});

  if (args.json) wireJsonRendering(agent);
  else wireRendering(agent);

  // Ctrl-C aborts the in-flight turn rather than killing the process; a second
  // press at an idle prompt exits.
  if (rl) {
    rl.on("SIGINT", () => {
      if (agent.running) {
        agent.stop();
        console.log(C.yellow("\n⏹ interrupted"));
      } else {
        console.log();
        rl.close();
      }
    });
  } else {
    // Non-interactive modes (--eval, piped batch) have no readline SIGINT
    // handler, so a bare Ctrl-C/SIGTERM would skip host.dispose() and orphan
    // extension resources (MCP child processes, temp dirs). Tear the host down
    // on signal before exiting; a second signal falls through to the default.
    const shutdown = (): void => {
      if (agent.running) agent.stop();
      void host.dispose().finally(() => process.exit(130));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  if (!args.json) banner(agent, host, live);

  if (args.eval !== undefined) {
    await runTurn(agent, args.eval);
  } else if (rl) {
    await repl(rl, agent, commands, host);
  } else {
    // Piped, non-interactive stdin: treat each line as a command or a turn.
    await batch(agent, commands, host);
  }

  await host.dispose();
  rl?.close();
}

/** Read all of stdin and process it line by line, then exit. */
async function batch(agent: Agent, commands: CommandRegistry, host: ExtensionHost): Promise<void> {
  const lines = (await readAll(stdin)).split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line === "/quit" || line === "/exit") continue;
    if (line.startsWith("/")) {
      await dispatchCommand(line, commands, agent, host);
    } else {
      console.log(C.bold(`\n› ${line}`));
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
): Promise<void> {
  const [name, ...rest] = line.slice(1).split(" ");
  const command = commands.get(name!);
  if (!command) {
    console.log(C.red(`Unknown command: /${name}. Try /help.`));
    return;
  }
  try {
    await command.run({ agent, args: rest.join(" "), print: (l) => console.log(l) });
  } catch (err) {
    console.log(C.red(`✗ /${name}: ${err instanceof Error ? err.message : String(err)}`));
  }
}

function wireRendering(agent: Agent): void {
  let streaming = false;
  let thinking = false;
  // Reasoning streams before the answer; render it dimmed and close the block
  // when the first answer text (or the completed message) arrives.
  agent.hooks.on("reasoning_delta", ({ text }) => {
    if (!thinking) {
      stdout.write(C.dim("🧠 "));
      thinking = true;
    }
    stdout.write(C.dim(text));
  });
  agent.hooks.on("text_delta", ({ text }) => {
    if (thinking) {
      stdout.write("\n");
      thinking = false;
    }
    if (!streaming) {
      stdout.write(C.green("⏺ "));
      streaming = true;
    }
    stdout.write(text);
  });
  agent.hooks.on("message", ({ message }) => {
    if (message.role === "assistant" && (streaming || thinking)) {
      stdout.write("\n");
      streaming = false;
      thinking = false;
    }
  });
  agent.hooks.on("tool_start", ({ call }) => {
    const args = JSON.stringify(call.arguments);
    console.log(C.cyan(`→ ${call.name}`) + " " + C.dim(args.length > 80 ? args.slice(0, 79) + "…" : args));
  });
  agent.hooks.on("tool_end", ({ result }) => {
    const head = result.content.split("\n")[0] ?? "";
    const mark = result.isError ? C.red("✗") : C.dim("✓");
    console.log(`  ${mark} ${C.dim(head.length > 100 ? head.slice(0, 99) + "…" : head)}`);
  });
  agent.hooks.on("error", ({ error, where }) => {
    console.log(C.red(`✗ ${where}: ${error instanceof Error ? error.message : String(error)}`));
  });
}

/** Programmatic mode: emit one JSON object per lifecycle event to stdout. */
function wireJsonRendering(agent: Agent): void {
  const emit = (obj: unknown): void => {
    process.stdout.write(JSON.stringify(obj) + "\n");
  };
  agent.hooks.on("text_delta", ({ text }) => emit({ type: "text_delta", text }));
  agent.hooks.on("reasoning_delta", ({ text }) => emit({ type: "reasoning_delta", text }));
  agent.hooks.on("message", ({ message }) => emit({ type: "message", role: message.role, content: message.content }));
  agent.hooks.on("tool_start", ({ call }) => emit({ type: "tool_start", id: call.id, name: call.name, arguments: call.arguments }));
  agent.hooks.on("tool_end", ({ call, result }) =>
    emit({ type: "tool_end", id: call.id, name: call.name, isError: result.isError ?? false, content: result.content }),
  );
  agent.hooks.on("usage", ({ usage, cumulative }) => emit({ type: "usage", usage, cumulative }));
  agent.hooks.on("agent_end", ({ reason }) => emit({ type: "agent_end", reason, usage: agent.usage }));
  agent.hooks.on("error", ({ error, where }) => emit({ type: "error", where, message: error instanceof Error ? error.message : String(error) }));
}

async function runTurn(agent: Agent, input: string): Promise<void> {
  try {
    await agent.run(input);
  } catch (err) {
    console.log(C.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
  }
}

async function repl(rl: Interface, agent: Agent, commands: CommandRegistry, host: ExtensionHost): Promise<void> {
  for (;;) {
    let line: string;
    try {
      line = (await rl.question(C.bold("\n› "))).trim();
    } catch {
      break; // Ctrl-D
    }
    if (line === "") continue;
    if (line === "/quit" || line === "/exit") break;

    if (line.startsWith("/")) {
      await dispatchCommand(line, commands, agent, host);
      continue;
    }

    await runTurn(agent, line);
  }
}

function registerHostCommands(commands: CommandRegistry, host: ExtensionHost, agent: Agent): void {
  commands.register({
    name: "help",
    description: "Show available commands.",
    run: (ctx) => {
      const lines = commands.list().map((c) => `  /${c.name.padEnd(12)} ${c.description}`);
      ctx.print([C.bold("Commands:"), ...lines, "", C.dim("Type anything else to talk to the agent.")].join("\n"));
    },
  });
  commands.register({
    name: "reload",
    description: "Hot-reload extensions (optionally one by id).",
    run: async (ctx) => {
      await host.reload(ctx.args.trim() || undefined);
      ctx.print(C.green(`Reloaded ${ctx.args.trim() || "all extensions"}.`));
    },
  });
  commands.register({
    name: "extensions",
    description: "List loaded extensions.",
    run: (ctx) => ctx.print(host.list().map((id) => `  ${id}`).join("\n") || "(none)"),
  });
  commands.register({
    name: "caps",
    description: "Show the capability audit log.",
    run: (ctx) => {
      const audit = agent.capabilities.audit();
      ctx.print(
        audit.length
          ? audit.map((a) => `  ${a.decision === "allow" ? "✓" : "✗"} ${a.capability.padEnd(14)} ${a.source}`).join("\n")
          : "(no capability checks yet)",
      );
    },
  });
  commands.register({
    name: "model",
    description: "Get or set the model (e.g. /model claude-fable-5).",
    run: (ctx) => {
      if (ctx.args.trim()) {
        agent.model = ctx.args.trim();
        ctx.print(C.green(`model = ${agent.model}`));
      } else ctx.print(`model = ${agent.model}`);
    },
  });
  commands.register({
    name: "provider",
    description: "Get or set the active provider (mock|anthropic|openai|gemini).",
    run: (ctx) => {
      const name = ctx.args.trim();
      if (name) {
        agent.providerName = name;
        agent.providers.setDefault(name);
        ctx.print(C.green(`provider = ${name}`));
      } else ctx.print(`provider = ${agent.providerName ?? "(default)"}`);
    },
  });
  commands.register({
    name: "clear",
    description: "Clear the conversation transcript.",
    run: (ctx) => {
      ctx.agent.clear();
      ctx.print(C.dim("Transcript cleared (start a new topic)."));
    },
  });
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

function banner(agent: Agent, host: ExtensionHost, live: boolean): void {
  console.log(C.bold("EAgent") + C.dim(" — a tiny core with Emacs-grade extensibility"));
  console.log(
    C.dim(
      `provider=${agent.providerName} model=${agent.model} ${live ? "(live)" : "(offline mock)"} · ` +
        `extensions: ${host.list().join(", ")}`,
    ),
  );
  console.log(C.dim("Type /help for commands, /quit to exit.\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
