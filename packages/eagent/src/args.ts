/**
 * The shared command-line surface.
 *
 * Both front ends — the headless CLI here in the engine, and the `eagent` TUI in
 * its own package — parse the same flags. Keeping the parser in one exported
 * module is what stops them drifting: a flag added for one is available to the
 * other, and `test/cli-entry.test.ts` can assert parity against a single source.
 */

export interface Args {
  model?: string;
  provider?: string;
  think?: string;
  eval?: string;
  yolo: boolean;
  extensions: string[];
  help: boolean;
  version: boolean;
  json: boolean;
  /** Positional words joined — the prompt, when one is given on the command line. */
  prompt?: string;
}

/** Every flag the parser accepts, including short aliases. The TUI's own help
 *  and its parity test read this rather than re-listing them. */
export const FLAGS = [
  "--model", "-m",
  "--provider", "-p",
  "--think",
  "--eval", "-e",
  "--yolo",
  "--ext",
  "--help", "-h",
  "--version", "-v",
  "--json",
] as const;

export function parseArgs(argv: string[]): Args {
  const args: Args = { yolo: false, extensions: [], help: false, version: false, json: false };
  const positional: string[] = [];
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
    else if (a.startsWith("-")) throw new Error(`unknown option: ${a} (try --help)`);
    // A bare word is part of the prompt. Collecting it HERE rather than
    // filtering argv by a leading dash is what keeps a flag value like the
    // `mock` in `-p mock` from being mistaken for prompt text.
    else positional.push(a);
  }
  if (positional.length > 0) args.prompt = positional.join(" ");
  return args;
}

/** The option block both front ends print, minus the entry-specific header. */
export const OPTIONS_HELP = `Options:
  -e, --eval <text>      Run one turn with <text> and exit
  -m, --model <name>     Model to use (e.g. claude-fable-5, gpt-4o)
  -p, --provider <name>  Provider: anthropic | openai | gemini | mock
      --think <level>    Reasoning effort: off | low | medium | high
      --ext <path>       Load an extra extension file (repeatable)
      --yolo             Auto-grant capabilities (no approval prompts)
      --json             Emit lifecycle events as JSONL (programmatic mode)
  -h, --help             Show this help and exit
  -v, --version          Print the version and exit`;
