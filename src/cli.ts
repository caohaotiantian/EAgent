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

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface, type Interface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import { isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Agent } from "./kernel/agent.js";
import type { CommandRegistry } from "./kernel/commands.js";
import type { ExtensionHost } from "./kernel/extension.js";
import type { Logger, UI } from "./kernel/types.js";
import { complete } from "./complete.js";
import { createAgentHost, loadEnvFile, PROVIDER_NAMES, thinkingFromEnv } from "./host.js";
import { eventToJsonl, wireJsonl } from "./jsonl.js";
import { EngineRenderer } from "./engine-render.js";
import { fromStdio, type RenderController, type Term } from "./tty.js";
import { wireViewModel } from "./attribution.js";

/** A mutable holder for the active renderer, so the display commands (registered
 *  before the renderer exists) can route to the renderer `main()` wires up. */
interface ActiveRenderer {
  current?: RenderController;
}

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
    ask: async (q, options) => {
      // Non-interactive → null, mirroring confirm's `if (!rl)` guard; the ask
      // tool's absence-fallback then keeps the run moving forward.
      if (!rl) return null;
      // Options are listed to stderr so stdout stays clean for --json mode
      // (matching notify); the human may answer with a 1-based index or free text.
      if (options?.length) {
        for (const [i, opt] of options.entries()) console.error(C.dim(`  ${i + 1}. ${opt}`));
      }
      const raw = (await rl.question(`${C.yellow("?")} ${q} `)).trim();
      if (!raw) return null; // empty → null; the tool reports it plainly
      if (options?.length) {
        const idx = Number(raw);
        if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) return options[idx - 1]!;
      }
      return raw; // free text, e.g. "none of these, do Z"
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

  // The display commands route here once the renderer is wired below; declared
  // now so registerHostCommands can close over it before the renderer exists.
  const active: ActiveRenderer = {};

  try {
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

    if (args.json) {
      wireJsonRendering(agent);
    } else {
      const term = fromStdio(stdout, stdin);
      active.current = wireRendering(agent, { term });
    }

    registerHostCommands(commands, host, agent, active);

    // Ctrl-C aborts the in-flight turn rather than killing the process; a second
    // press at an idle prompt exits.
    if (rl) {
      // Capture the narrowed handle: TS doesn't keep a captured `let`'s narrowing
      // inside a closure declared within this try, so bind it to a const first.
      const readline = rl;
      readline.on("SIGINT", () => {
        if (agent.running) {
          agent.stop();
          console.log(C.yellow("\n⏹ interrupted"));
        } else {
          console.log();
          readline.close();
        }
      });
    } else {
      // Non-interactive modes (--eval, piped batch) have no readline SIGINT
      // handler, so a bare Ctrl-C/SIGTERM would skip host.dispose() and orphan
      // extension resources (MCP child processes, temp dirs). Tear the host down
      // on signal before exiting; the shared shuttingDown guard makes
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
    }

    if (!args.json) banner(agent, host, live);

    if (args.eval !== undefined) {
      await runTurn(agent, args.eval, args.json);
    } else if (rl) {
      await repl(rl, agent, commands, host, args.json);
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
  rl?.close();
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
      await runTurn(agent, line, json);
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

/**
 * The interactive human renderer. Reasoning blocks, tool cards, and subagent work
 * fold through the pure view model and render as first-class, ordered, collapsible
 * units (preserving the reasoning-search de-interleaving and full tool params on
 * the non-Ink path). `opts` is optional so the pinned regression calls
 * `wireRendering(agent)` still compile. Returns the renderer so the host can route
 * `/details`/`/expand`/`/collapse` to it.
 */
export function wireRendering(agent: Agent, opts: { term?: Term } = {}): EngineRenderer {
  const term = opts.term ?? fromStdio(stdout, stdin);
  const renderer = new EngineRenderer({ term });
  wireViewModel(agent, (model) => renderer.onModel(model));

  // The error path stays first-class: a tool/loop error prints a red line
  // (dropping this would still pass the warning tests but silently regress it).
  agent.hooks.on("error", ({ error, where }) => {
    console.log(C.red(`✗ ${where}: ${error instanceof Error ? error.message : String(error)}`));
  });
  // The human REPL otherwise drops the terminal reason (only --json surfaces it),
  // so a truncated/blocked/refused answer ends silently. Warn on exactly the
  // abnormal-and-otherwise-silent reasons; the clean ends (end_turn/tool_use), an
  // interrupt (stop → the '⏹ interrupted' line), and error (the handler above +
  // runTurn's catch) already carry their own signals, so they stay quiet here.
  agent.hooks.on("agent_end", ({ reason }) => {
    if (reason === "max_tokens") {
      console.log(
        C.yellow("\n⚠ response truncated (max_tokens): the model hit its output-token cap.") +
          "\n" +
          C.dim("  raise the provider's *_MAX_TOKENS env var, or enable /autocontinue."),
      );
    } else if (reason === "content_filter") {
      console.log(C.yellow("\n⚠ response stopped (content_filter): blocked by the provider content filter."));
    } else if (reason === "refusal") {
      console.log(C.yellow("\n⚠ response stopped (refusal): the model declined to answer."));
    }
  });

  return renderer;
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

async function runTurn(agent: Agent, input: string, json: boolean): Promise<void> {
  try {
    await agent.run(input);
  } catch (err) {
    // In --json mode a run throw goes to stderr (the JSON renderer already emits an
    // `error` lifecycle event on stdout); human mode keeps the red line on stdout.
    const msg = C.red(`✗ ${err instanceof Error ? err.message : String(err)}`);
    if (json) console.error(msg);
    else console.log(msg);
  }
}

async function repl(
  rl: Interface,
  agent: Agent,
  commands: CommandRegistry,
  host: ExtensionHost,
  json: boolean,
): Promise<void> {
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
      await dispatchCommand(line, commands, agent, host, json);
      continue;
    }

    await runTurn(agent, line, json);
  }
}

/** Register the host's slash commands (help/reload/model/… plus the
 *  `/details`/`/expand`/`/collapse` display controls). Exported so a unit test can
 *  drive the display commands' branching against a fake `active` renderer without a
 *  live REPL — the same in-process test seam as `wireRendering`/`entryShouldRun`. */
export function registerHostCommands(
  commands: CommandRegistry,
  host: ExtensionHost,
  agent: Agent,
  active: ActiveRenderer,
): void {
  // /expand and /collapse share this section-number router.
  const routeSection = (ctx: { args: string; print(l: string): void }, kind: "expand" | "collapse"): void => {
    const r = active.current;
    if (!r) {
      ctx.print(C.dim("display control is unavailable in this mode."));
      return;
    }
    const n = Number(ctx.args.trim());
    if (!Number.isInteger(n) || n < 1) {
      ctx.print(C.red(`/${kind} needs a section number, e.g. /${kind} 2.`));
      return;
    }
    r.applyControl({ kind, n });
    ctx.print(C.dim(`${kind === "expand" ? "expanded" : "collapsed"} section ${n}.`));
  };

  commands.register({
    name: "details",
    description: "Set the display mode (full|collapsed|auto), or show it with no argument.",
    run: (ctx) => {
      const r = active.current;
      if (!r) {
        ctx.print(C.dim("display control is unavailable in this mode."));
        return;
      }
      const arg = ctx.args.trim();
      if (!arg) {
        ctx.print(`display mode = ${r.mode}`);
        return;
      }
      if (arg !== "full" && arg !== "collapsed" && arg !== "auto") {
        ctx.print(C.red(`unknown mode: ${arg} (use full | collapsed | auto).`));
        return;
      }
      r.applyControl({ kind: "mode", mode: arg });
      ctx.print(C.green(`display mode = ${arg}`));
    },
  });
  commands.register({
    name: "expand",
    description: "Expand section <n> to its full, untruncated content (e.g. /expand 2).",
    run: (ctx) => routeSection(ctx, "expand"),
  });
  commands.register({
    name: "collapse",
    description: "Collapse section <n> back to its header (e.g. /collapse 2).",
    run: (ctx) => routeSection(ctx, "collapse"),
  });

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

// Only run the CLI when this file is the process entry point (`npm run dev`, the
// installed bin, the subprocess cli tests, or a SEA binary). An `import` of this
// module — e.g. a test driving `wireRendering` in-process — must not launch the
// whole CLI. Pure and injected so every branch is unit-testable without a build:
// `isSea` short-circuits true inside a Single Executable Application (there
// argv[1] is not a script path, so the realpath compare cannot match); otherwise
// realpath argv[1] to match Node's already-realpathed import.meta.url, because npm
// installs the `eagent` bin as a symlink and a globally-installed `eagent` keeps
// the symlink path in argv[1]. An undefined or unresolvable argv[1] returns false.
export function entryShouldRun(
  argv1: string | undefined,
  importMetaUrl: string,
  isSea: boolean,
): boolean {
  if (isSea) return true;
  if (!argv1) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
if (entryShouldRun(process.argv[1], import.meta.url, isSea())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
