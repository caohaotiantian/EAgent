/**
 * The shared command-line surface.
 *
 * Both front ends — the headless CLI here in the engine (`src/cli.ts`) and the `eagent` TUI in
 * its own package (`tui/src/cli.tsx`) — import `parseArgs` and `OPTIONS_HELP` from here, so a
 * flag added for one is available to the other.
 *
 * **THAT IS WHERE THE SHARING STOPS, and this docstring used to claim more.** It said
 * `test/cli-entry.test.ts` "can assert parity against a single source"; that file does not
 * import this module at all, and there is no single source — the vocabulary is written out
 * three times below (`FLAGS`, `parseArgs`'s literals, `OPTIONS_HELP`). One exported module
 * stops the two FRONT ENDS drifting from each other. It does nothing about the three lists
 * inside it drifting from each other, which is the failure that can actually reach a user:
 * a flag the help advertises and the parser refuses.
 *
 * `test/args-vocabulary.test.ts` is the gate that does hold them together, and it reads all
 * three from this file's source so it cannot become a fourth copy.
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

/**
 * Every flag the parser accepts, including short aliases.
 *
 * THIS LIST HAS NO RUNTIME READER, and its docstring used to claim two. It said the TUI's own
 * help and a parity test read it "rather than re-listing them"; both PRODUCTION consumers of
 * this module — `src/cli.ts` here and `tui/src/cli.tsx` — import `OPTIONS_HELP` and `parseArgs`
 * and never this, and no parity test was ever written. (`test/args-vocabulary.test.ts` imports
 * it now, which is the gate described below and not a runtime reader.) So the
 * vocabulary exists three times over — here, as string literals in `parseArgs` below, and as
 * prose in `OPTIONS_HELP` — and a flag added to any one of them alone disagrees with the other
 * two silently. That is the failure mode this repository has already shipped twice at the Loom
 * end (error codes, event types): a registry with two representations drifts, and a gate walking
 * the wrong one is switched off without saying so.
 *
 * `test/args-vocabulary.test.ts` now gates all three AS ONE SET, reading each from this source
 * so none can be restated in the test and drift with it — the shape
 * `packages/core/test/cli/known-flags.test.ts` uses for `KNOWN_FLAGS`/`USAGE`/the code's readers.
 * Keep this list exported and keep it accurate: it is the declaration the other two are checked
 * against, which is a job even though it is not a call site.
 */
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
