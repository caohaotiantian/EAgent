/**
 * The `eagent-tui` argument parser + usage text (pure, dependency-free).
 *
 * Kept separate from `main.tsx` and free of any `ink`/`react`/host import so the
 * `--help`/`--version` path can run BEFORE Ink or raw mode is ever touched — Ink
 * throws "Raw mode is not supported" in a non-TTY, and the AC12 gate runs
 * `node dist/tui/bundle.mjs --help` headless, so help must work with no TTY.
 */

import type { DisplayMode } from "../view-model.js";
import type { MonitorInstance } from "./instance.js";

export interface TuiArgs {
  help: boolean;
  version: boolean;
  provider?: string;
  model?: string;
  yolo: boolean;
  mode: DisplayMode;
  /** `--monitor`: run the multi-session dashboard instead of a local session. */
  monitor: boolean;
  /** `--instance url[,token]` (repeatable): the hosts the monitor attaches to. */
  instances: MonitorInstance[];
}

export const TUI_USAGE = `eagent-tui — the rich full-screen Ink terminal client for EAgent

Usage: eagent-tui [options]

Options:
  -p, --provider <name>  Provider: anthropic | openai | gemini | mock
  -m, --model <name>     Model to use (e.g. claude-fable-5, gpt-4o)
      --details <mode>   Initial display mode: full | collapsed | auto (default auto)
      --yolo             Auto-grant capabilities (no approval prompts)
      --monitor          Multi-session monitor dashboard (attach to running hosts)
      --instance <u[,t]> Monitor target url[,token] (repeatable; default localhost)
  -h, --help             Show this help and exit
  -v, --version          Print the version and exit

Requires a Node runtime (not the standalone eagent binary). With no API key it
runs the deterministic offline mock provider. In-session: type /details, /expand
<n>, /collapse <n> to control the display; /quit to exit. In --monitor: [j/k]
move, [enter] open a session, [s] stop, [f] forget, [r] refresh, [q] quit.`;

/** Parse argv (already sliced past node + script). Throws on a malformed flag. */
export function parseTuiArgs(argv: string[]): TuiArgs {
  const args: TuiArgs = { help: false, version: false, yolo: false, mode: "auto", monitor: false, instances: [] };
  const takeValue = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) throw new Error(`option ${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--provider" || a === "-p") args.provider = takeValue(a, i++);
    else if (a === "--model" || a === "-m") args.model = takeValue(a, i++);
    else if (a === "--yolo") args.yolo = true;
    else if (a === "--monitor") args.monitor = true;
    else if (a === "--instance") {
      const v = takeValue(a, i++);
      // Split on the FIRST comma only, so a bearer token may itself contain commas.
      const comma = v.indexOf(",");
      const url = comma < 0 ? v : v.slice(0, comma);
      const token = comma < 0 ? undefined : v.slice(comma + 1);
      args.instances.push({ url, token });
    } else if (a === "--details") {
      const m = takeValue(a, i++);
      if (m !== "full" && m !== "collapsed" && m !== "auto") throw new Error(`--details expects full|collapsed|auto, got ${m}`);
      args.mode = m;
    } else throw new Error(`unknown option: ${a} (try --help)`);
  }
  return args;
}
