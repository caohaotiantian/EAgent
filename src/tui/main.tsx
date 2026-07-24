#!/usr/bin/env node
/**
 * `eagent-tui` entry — the rich full-screen Ink single-session client (design
 * D1, KDD6). A separate ESM front end run via Node (never the CJS SEA binary),
 * so Ink stays isolated to `src/tui/` (AC9).
 *
 * CRITICAL ordering (AC12): argv is parsed and `--help`/`--version` are answered
 * and the process returns BEFORE Ink or raw mode is touched. Ink throws "Raw mode
 * is not supported on process.stdin" in a non-TTY, and the size gate runs
 * `node dist/tui/bundle.mjs --help` headless — so help must not reach `render()`.
 * Ink, React, the components, and the host wiring are all imported DYNAMICALLY,
 * past that guard, so the no-TTY path never evaluates them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTuiArgs, TUI_USAGE } from "./args.js";

/** Best-effort version read; walks up from this module to the nearest package.json. */
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of [["..", "..", "package.json"], ["..", "package.json"]]) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, ...rel), "utf8")) as { version?: string };
      if (pkg.version) return `eagent-tui ${pkg.version}`;
    } catch {
      // try the next candidate
    }
  }
  return "eagent-tui unknown";
}

async function main(): Promise<void> {
  const args = parseTuiArgs(process.argv.slice(2));

  // Headless paths — must return before any Ink / raw-mode / host evaluation.
  if (args.help) {
    console.log(TUI_USAGE);
    return;
  }
  if (args.version) {
    console.log(readVersion());
    return;
  }

  if (!process.stdin.isTTY) {
    // The full-screen client needs a raw-mode-capable terminal; a pipe/redirect
    // cannot drive it. Fail with guidance rather than let Ink throw a raw-mode error.
    console.error("eagent-tui needs an interactive TTY. For pipes/scripts use `eagent --json` or `eagent -e`.");
    process.exitCode = 1;
    return;
  }

  // Past the guard: now it is safe to pull in React/Ink.
  const [{ render }, React] = await Promise.all([import("ink"), import("react")]);

  if (args.monitor) {
    // The monitor attaches to running hosts (no local agent). With no --instance,
    // default to a local `eagent-serve` (honoring EAGENT_TOKEN if the host is authed).
    const { Monitor } = await import("./monitor.js");
    const instances =
      args.instances.length > 0
        ? args.instances
        : [{ url: "http://127.0.0.1:8787", token: process.env.EAGENT_TOKEN || undefined }];
    const instance = render(React.createElement(Monitor, { instances, mode: args.mode }));
    await instance.waitUntilExit();
    return;
  }

  const [{ App }, { startSession }] = await Promise.all([import("./app.js"), import("./start.js")]);
  const { source, dispose } = await startSession(args);
  const instance = render(React.createElement(App, { source, mode: args.mode }));
  await instance.waitUntilExit();
  await dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
