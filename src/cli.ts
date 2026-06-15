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

import { readFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { Agent } from "./kernel/agent.js";
import { CapabilityManager } from "./kernel/capabilities.js";
import { CommandRegistry } from "./kernel/commands.js";
import { ExtensionHost } from "./kernel/extension.js";
import { FileBackend } from "./kernel/store.js";
import type { Logger, UI } from "./kernel/types.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { MockProvider } from "./providers/mock.js";
import coreTools from "./extensions/core-tools.js";
import skills from "./extensions/skills.js";
import mcp from "./extensions/mcp.js";
import codeact from "./extensions/codeact.js";
import subagents from "./extensions/subagents.js";
import memory from "./extensions/memory.js";
import planmode from "./extensions/planmode.js";
import session from "./extensions/session.js";
import packages from "./extensions/packages.js";
import trace from "./extensions/trace.js";
import contextFiles from "./extensions/context-files.js";
import limits from "./extensions/limits.js";
import self from "./extensions/self.js";

interface Args {
  model?: string;
  provider?: string;
  eval?: string;
  yolo: boolean;
  extensions: string[];
  help: boolean;
  version: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { yolo: false, extensions: [], help: false, version: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--model" || a === "-m") args.model = argv[++i];
    else if (a === "--provider" || a === "-p") args.provider = argv[++i];
    else if (a === "--eval" || a === "-e") args.eval = argv[++i];
    else if (a === "--yolo") args.yolo = true;
    else if (a === "--ext") args.extensions.push(argv[++i]!);
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--json") args.json = true;
  }
  return args;
}

const USAGE = `EAgent — a minimalist agent with a tiny core and Emacs-grade extensibility

Usage: eagent [options]

Options:
  -e, --eval <text>      Run one turn with <text> and exit (non-interactive)
  -m, --model <name>     Model to use (e.g. claude-fable-5, gpt-4o)
  -p, --provider <name>  Provider: anthropic | openai | mock
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
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : undefined;

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

  const anthropic = new AnthropicProvider();
  const openai = new OpenAIProvider();
  // Pick a default provider: an explicit --provider wins if usable; otherwise
  // prefer a configured live provider, falling back to the offline mock.
  const defaultProvider = selectProvider(args.provider, {
    anthropic: anthropic.configured,
    openai: openai.configured,
  });
  const live = defaultProvider !== "mock";
  const defaultModel =
    defaultProvider === "anthropic" ? "claude-fable-5" : defaultProvider === "openai" ? "gpt-4o" : "mock";

  const capabilities = new CapabilityManager({
    ui,
    grant: ["fs:read", "fs:write", "skill:read"],
    fallback: args.yolo ? "allow" : "ask",
  });

  const commands = new CommandRegistry();
  const agent = new Agent({
    ui,
    logger,
    capabilities,
    model: args.model ?? defaultModel,
    provider: defaultProvider,
  });

  agent.providers.register(new MockProvider(), { default: defaultProvider === "mock" });
  if (anthropic.configured) agent.providers.register(anthropic, { default: defaultProvider === "anthropic" });
  if (openai.configured) agent.providers.register(openai, { default: defaultProvider === "openai" });

  const host = new ExtensionHost({
    agent,
    commands,
    logger,
    store: new FileBackend(join(homedir(), ".eagent", "state")),
  });

  // Built-ins ride the same activation path as any other extension. Each is
  // inert until used (plan mode off, no MCP servers, capabilities gated), so
  // loading them all by default is safe and shows the whole system.
  await host.use("core-tools", coreTools);
  await host.use("skills", skills);
  await host.use("mcp", mcp);
  await host.use("codeact", codeact);
  await host.use("subagents", subagents);
  await host.use("memory", memory);
  await host.use("planmode", planmode);
  await host.use("session", session);
  await host.use("packages", packages);
  await host.use("trace", trace);
  await host.use("context-files", contextFiles);
  await host.use("limits", limits);
  await host.use("self", self);
  await host.discover([
    join(process.cwd(), ".eagent", "extensions"),
    join(homedir(), ".eagent", "extensions"),
  ]);
  for (const path of args.extensions) await host.loadFile(path);

  registerHostCommands(commands, host, agent);
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
  agent.hooks.on("text_delta", ({ text }) => {
    if (!streaming) {
      stdout.write(C.green("⏺ "));
      streaming = true;
    }
    stdout.write(text);
  });
  agent.hooks.on("message", ({ message }) => {
    if (message.role === "assistant" && streaming) {
      stdout.write("\n");
      streaming = false;
    }
  });
  agent.hooks.on("tool_start", ({ call }) => {
    const args = JSON.stringify(call.arguments);
    console.log(C.cyan(`→ ${call.name}`) + " " + C.dim(args.length > 80 ? args.slice(0, 79) + "…" : args));
  });
  agent.hooks.on("tool_end", ({ call, result }) => {
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
    description: "Get or set the active provider (mock|anthropic|openai).",
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

/** Resolve which provider to default to given the user's flag and what's configured. */
function selectProvider(
  requested: string | undefined,
  configured: { anthropic: boolean; openai: boolean },
): string {
  if (requested === "mock") return "mock";
  if (requested === "anthropic" && configured.anthropic) return "anthropic";
  if (requested === "openai" && configured.openai) return "openai";
  if (requested && requested !== "anthropic" && requested !== "openai") return requested;
  if (configured.anthropic) return "anthropic";
  if (configured.openai) return "openai";
  return "mock";
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
