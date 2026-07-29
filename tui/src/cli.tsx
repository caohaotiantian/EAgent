#!/usr/bin/env node
/**
 * The `eagent` entry.
 *
 * Routes: a non-interactive invocation (`--eval`, `--json`, a pipe, CI, a dumb
 * terminal) hands off to the engine's headless runner, which mounts no display;
 * anything else mounts Ink. That branch is the whole reason `refusalReason`
 * exists — Ink painting into a redirected stdout is the regression the engine's
 * machine paths are built to avoid.
 *
 * Teardown is belt-and-braces. Ink restores the cursor on a normal unmount, but
 * not when the process dies to an uncaught throw or a signal, so those paths
 * unmount explicitly and dispose the extension host — otherwise MCP child
 * processes and temp dirs leak, and the terminal is left without a cursor.
 */

import { render } from "ink";
import React from "react";

import { OPTIONS_HELP, parseArgs, type Args } from "eagent/args";
import { createAgentHost, loadEnvFile, thinkingFromEnv } from "eagent/host";
import { registerHostCommands } from "eagent/host-commands";
import type { Logger, UI } from "eagent";

import { subscribe } from "./bridge.js";
import { initialState, reduce, type TranscriptState } from "./model/transcript.js";
import { envFromProcess, refusalReason } from "./tty.js";
import { App } from "./ui/App.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";

const USAGE = `EAgent — a minimalist agent with a tiny core and Emacs-grade extensibility

Usage: eagent [options] [prompt]

${OPTIONS_HELP}

With no API key, EAgent runs the deterministic offline mock provider.
Piped or redirected invocations fall through to the headless runner.`;

/**
 * Hand off to the engine's non-interactive entry, which owns the machine paths.
 * It re-reads argv through the same shared parser, so a positional prompt and
 * every flag value survive the handoff unchanged.
 */
async function headless(): Promise<never> {
  const { runHeadless } = await import("eagent/cli");
  return process.exit(await runHeadless());
}

async function main(): Promise<void> {
  loadEnvFile();

  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }

  // A machine invocation never mounts a display, whatever the terminal says.
  const refusal = args.eval !== undefined || args.json ? "non-interactive flags" : refusalReason(envFromProcess());
  if (refusal !== null) {
    await headless();
  }

  const ui: UI = {
    // Built BEFORE createAgentHost and late-binding through these closures: the
    // `ask` extension grants `ui:ask` only if `ask` is a function at activation
    // time, so constructing the UI after Ink mounts would silently disable
    // mid-turn elicitation.
    confirm: async () => false,
    ask: async () => null,
    notify: () => {},
  };
  const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  const { agent, host, commands, live, model } = await createAgentHost({
    ui,
    logger,
    yolo: args.yolo,
    provider: args.provider,
    model: args.model,
    thinking: args.think ? thinkingFromEnv(args.think) : undefined,
    extraExtensions: args.extensions,
  });
  registerHostCommands(commands, host, agent);
  await agent.hooks.emit("session_start", {});

  let state: TranscriptState = initialState();
  let repaint: (s: TranscriptState) => void = () => {};
  const unsubscribe = subscribe(agent, {
    emit: (ev) => {
      state = reduce(state, ev);
      repaint(state);
    },
  });

  function Root(): React.ReactElement {
    const [s, setS] = React.useState(state);
    React.useEffect(() => {
      repaint = setS;
      return () => {
        repaint = () => {};
      };
    }, []);
    return (
      <ErrorBoundary>
        <App
          state={s}
          onInterrupt={() => agent.stop()}
          onExit={() => void teardown(0)}
          status={{ model, provider: agent.providerName ?? "default", live }}
        />
      </ErrorBoundary>
    );
  }

  const instance = render(<Root />, {
    // Ink's own handler would exit the process on the first Ctrl+C; the app
    // needs it to interrupt a running turn instead.
    exitOnCtrlC: false,
  });

  let tearing = false;
  async function teardown(code: number): Promise<void> {
    if (tearing) return;
    tearing = true;
    unsubscribe();
    instance.unmount();
    await host.dispose().catch(() => {});
    process.exit(code);
  }

  // Ink's signal-exit covers a clean unmount, not a throw or a kill.
  process.on("uncaughtException", (err) => {
    instance.unmount();
    console.error(err);
    void teardown(1);
  });
  process.on("unhandledRejection", (err) => {
    instance.unmount();
    console.error(err);
    void teardown(1);
  });
  process.once("SIGTERM", () => void teardown(143));
  process.once("SIGHUP", () => void teardown(129));

  const prompt = args.prompt ?? "";
  if (prompt) {
    state = reduce(state, { kind: "user", text: prompt, actingId: "root", at: Date.now() });
    repaint(state);
    await agent.run(prompt).catch(() => {});
  }

  await instance.waitUntilExit();
  await teardown(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
