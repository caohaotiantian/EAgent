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

import { OPTIONS_HELP, parseArgs, type Args } from "@eagent/core/args";
import { createAgentHost, loadEnvFile, thinkingFromEnv } from "@eagent/core/host";
import { registerHostCommands } from "@eagent/core/host-commands";
import { text as textMessage, type DecisionChoice, type DecisionRequest, type Logger, type UI } from "@eagent/core";

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TODO_ACCESSOR_KEY } from "@eagent/core/extensions/todo";

import { subscribe } from "./bridge.js";
import { applyMode, type Mode } from "./modes.js";
import { editorCommand, shellCommand, shellTranscriptEntry, stripEditorComments } from "./input/shell.js";
import { initialHistory, record, type HistoryState } from "./input/history.js";
import { initialState, reduce, type TranscriptState } from "./model/transcript.js";
import { envFromProcess, refusalReason } from "./tty.js";
import { App, type PendingQuestion } from "./ui/App.js";
import type { Task } from "./ui/Status.js";
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
  const { runHeadless } = await import("@eagent/core/cli");
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

  // The dialog sink, late-bound: React installs it on mount. Declared here so
  // the UI object below can close over it BEFORE createAgentHost runs — the
  // `ask` extension grants `ui:ask` only if `ask` is a function at activation
  // time, so building the UI after Ink mounts would silently disable mid-turn
  // elicitation.
  let openDialog: ((q: PendingQuestion) => void) | null = null;

  /** Show a modal question and resolve with the chosen value. */
  const askDialog = (q: Omit<PendingQuestion, "answer">): Promise<string | null> =>
    new Promise((resolve) => {
      if (!openDialog) return resolve(null); // no display yet: fall back
      openDialog({ ...q, answer: (value) => resolve(value) });
    });

  const ui: UI = {
    // Kept for front ends and guards that still call it. Its `true` means
    // "always" to the capability layer, so the two-way answer maps onto the
    // three-way dialog's first and last options.
    confirm: async (question) => (await askDialog({
      question,
      choices: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    })) === "yes",

    decide: async (req: DecisionRequest): Promise<DecisionChoice> => {
      const answer = await askDialog({
        question: `Allow ${req.source} to use "${req.capability}"?`,
        detail: req.arguments ? JSON.stringify(req.arguments) : undefined,
        choices: [
          { value: "once", label: "Yes, once", hint: "this call only" },
          { value: "always", label: "Yes, and don't ask again", hint: "for this session" },
          { value: "reject", label: "No", hint: "deny and tell the model" },
        ],
      });
      // A dismissed dialog denies: the decision is a whitelist.
      return answer === "once" || answer === "always" ? answer : "reject";
    },

    ask: async (question, options) =>
      askDialog({
        question,
        choices: (options ?? []).map((o) => ({ value: o, label: o })),
        allowFreeText: true,
      }),

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

  // Permission modes drive the capability layer directly. `--yolo` starts in the
  // matching mode so the flag and the indicator cannot disagree.
  let modeGrants: { dispose: () => void }[] = [];
  const setMode = (m: Mode): void => {
    modeGrants = applyMode(
      m,
      {
        setFallback: (d) => agent.capabilities.setFallback(d),
        grant: (p) => agent.capabilities.grant(p),
        setPlanMode: (on) => host.storeFor("planmode").set("enabled", on),
      },
      modeGrants,
    );
  };

  /** The live checklist, read through the accessor rather than by parsing /todos. */
  const readTasks = (): Task[] => {
    const accessor = host.storeFor("todo").get<(a: typeof agent) => Task[]>(TODO_ACCESSOR_KEY);
    return typeof accessor === "function" ? accessor(agent) : [];
  };

  let state: TranscriptState = initialState();
  let repaint: (s: TranscriptState) => void = () => {};
  const unsubscribe = subscribe(agent, {
    emit: (ev) => {
      state = reduce(state, ev);
      repaint(state);
    },
  });

  /** Run a shell command and fold its output into the conversation. */
  async function runShell(command: string): Promise<void> {
    const started = Date.now();
    state = reduce(state, {
      kind: "tool_start",
      callId: `sh:${started}`,
      name: "shell",
      arguments: { command },
      actingId: "root",
      at: started,
    });
    repaint(state);

    const output = await new Promise<{ out: string; code: number }>((resolve) => {
      const child = spawn(command, { shell: true });
      let out = "";
      const take = (b: Buffer): void => {
        out += b.toString();
        state = reduce(state, {
          kind: "tool_progress",
          callId: `sh:${started}`,
          chunk: b.toString(),
          actingId: "root",
          at: Date.now(),
        });
        repaint(state);
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("close", (code) => resolve({ out, code: code ?? 0 }));
      child.on("error", (err) => resolve({ out: String(err), code: 1 }));
    });

    state = reduce(state, {
      kind: "tool_end",
      callId: `sh:${started}`,
      content: output.out,
      isError: output.code !== 0,
      actingId: "root",
      at: Date.now(),
    });
    repaint(state);

    // The output enters the conversation so the model can be asked about it on
    // the next turn without re-running anything.
    agent.load([textMessage("user", shellTranscriptEntry({ command, stdout: output.out, exitCode: output.code }))]);
  }

  /** Hand the buffer to $EDITOR and return what came back. */
  async function externalEdit(text: string): Promise<string | null> {
    const editor = editorCommand(process.env as { VISUAL?: string; EDITOR?: string });
    if (editor === null) return null;

    const dir = mkdtempSync(join(tmpdir(), "eagent-edit-"));
    const file = join(dir, "prompt.md");
    writeFileSync(file, text);
    try {
      instance.clear();
      await new Promise<void>((resolve) => {
        const child = spawn(editor, [file], { stdio: "inherit", shell: true });
        child.on("close", () => resolve());
        child.on("error", () => resolve());
      });
      return stripEditorComments(readFileSync(file, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Run one turn. A slash command is dispatched instead of sent to the model;
   *  a `!` line runs a shell command without involving the model at all. */
  async function submit(text: string): Promise<void> {
    const shell = shellCommand(text);
    if (shell !== null) {
      state = reduce(state, { kind: "user", text, actingId: "root", at: Date.now() });
      repaint(state);
      await runShell(shell);
      return;
    }

    state = reduce(state, { kind: "user", text, actingId: "root", at: Date.now() });
    repaint(state);

    if (text.startsWith("/")) {
      const [name, ...rest] = text.slice(1).split(" ");
      const command = commands.get(name ?? "");
      if (!command) {
        state = reduce(state, { kind: "notice", text: `unknown command: /${name}`, actingId: "root", at: Date.now() });
        repaint(state);
        return;
      }
      try {
        // `print` is synchronous and line-based, and its strings already carry
        // ANSI — they are folded in verbatim rather than re-styled.
        await command.run({
          agent,
          args: rest.join(" "),
          print: (line) => {
            state = reduce(state, { kind: "notice", text: line, actingId: "root", at: Date.now() });
            repaint(state);
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state = reduce(state, { kind: "notice", text: `/${name}: ${message}`, actingId: "root", at: Date.now() });
        repaint(state);
      }
      return;
    }

    // A run throw already reaches the transcript through the `error` hook.
    await agent.run(text).catch(() => {});
  }

  function Root(): React.ReactElement {
    const [s, setS] = React.useState(state);
    const [hist, setHist] = React.useState<HistoryState>(initialHistory());
    const [pending, setPending] = React.useState<PendingQuestion | null>(null);
    const [mode, setModeState] = React.useState<Mode>(args.yolo ? "yolo" : "manual");
    // Re-read on every repaint: the model replaces the whole list each turn, so
    // there is nothing to subscribe to and nothing to keep in sync.
    const tasks = readTasks();
    React.useEffect(() => {
      repaint = setS;
      openDialog = (q) =>
        setPending({
          ...q,
          answer: (value) => {
            setPending(null);
            q.answer(value);
          },
        });
      return () => {
        repaint = () => {};
        openDialog = null;
      };
    }, []);
    return (
      <ErrorBoundary>
        <App
          state={s}
          onInterrupt={() => agent.stop()}
          onExit={() => void teardown(0)}
          status={{ model, provider: agent.providerName ?? "default", live }}
          history={hist}
          onHistoryChange={setHist}
          onSubmit={(text) => {
            setHist((h) => record(h, text));
            void submit(text);
          }}
          pending={pending}
          mode={mode}
          onModeChange={(m) => {
            setMode(m);
            setModeState(m);
          }}
          tasks={tasks}
          externalEdit={externalEdit}
          suggestions={{
            commands: () => commands.list().map((x) => ({ name: x.name, description: x.description })),
            readDir: (dir) =>
              readdirSync(dir, { withFileTypes: true }).map((d) => ({
                name: d.name,
                isDirectory: d.isDirectory(),
              })),
          }}
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

  // A prompt on the command line runs immediately; the session then stays open
  // for follow-ups, the same as typing it into the box.
  const prompt = args.prompt ?? "";
  if (prompt) await submit(prompt);

  await instance.waitUntilExit();
  await teardown(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
