/**
 * Single-session host wiring for `eagent-tui` (design D1/D2, KDD3).
 *
 * Builds a fully-wired local agent via the shared `createAgentHost` and wraps it
 * in an `InProcessSource` — the same agent the plain CLI runs, so the Ink client
 * is a rich front end over identical behavior, not a reduced one. Imported
 * DYNAMICALLY by `main.tsx` (only after the headless `--help`/`--version` path
 * has returned) so the engine + extension host are never touched in the no-TTY
 * gate. Imports the host but no `ink`/`react` (AC9) — the source is neutral.
 */

import { createAgentHost, loadEnvFile } from "../host.js";
import type { Logger, UI } from "../kernel/types.js";
import { InProcessSource, type SessionSource } from "../session-source.js";
import type { TuiArgs } from "./args.js";

/** A running single session: the source the UI consumes + a teardown. */
export interface Session {
  source: SessionSource;
  dispose: () => Promise<void>;
}

export async function startSession(args: TuiArgs): Promise<Session> {
  // Honor a local .env (keys/model) exactly like the plain CLI does.
  loadEnvFile();

  // Ink owns the screen, so host diagnostics must not print into the frame; they
  // are swallowed this cycle (a future TUI could surface them in a log pane).
  const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  // The agent's UI.ask must reach the InProcessSource so mid-turn elicitations
  // surface in the transcript — but the source needs the agent. Resolve the cycle
  // with a late-bound holder the ui forwards to once the source exists.
  let source: InProcessSource | undefined;
  const ui: UI = {
    // Capability prompts have no in-frame dialog this cycle: follow the --yolo
    // policy (allow when set, deny otherwise), mirroring the CLI's non-interactive path.
    confirm: () => Promise.resolve(args.yolo),
    ask: (question, options) => (source ? source.ask(question, options) : Promise.resolve(null)),
    notify: () => {},
  };

  const { agent, host } = await createAgentHost({
    ui,
    logger,
    yolo: args.yolo,
    provider: args.provider,
    model: args.model,
  });

  await agent.hooks.emit("session_start", {});
  source = new InProcessSource(agent);

  return {
    source,
    dispose: async () => {
      source?.close();
      await host.dispose();
    },
  };
}
