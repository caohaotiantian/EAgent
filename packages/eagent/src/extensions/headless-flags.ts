/**
 * headless-flags — make shell commands non-blocking when no human is present.
 *
 * When EAgent runs with no human at the terminal — under CI, the HTTP host
 * (`src/server.ts`), or a piped / `--json` one-shot — a shell command that drops
 * into an interactive prompt or `$EDITOR` blocks **forever** on input that will
 * never arrive, hanging the whole run with no error and no token to bill:
 * `git commit` with no `-m` opens the editor, `git rebase -i` opens the sequence
 * editor, `apt-get install` prompts `[Y/n]`, `npm init` walks a wizard, `gh`/`ssh`
 * prompt for auth/host-key confirmation. This extension makes those runs
 * non-blocking.
 *
 * It is policy, not a kernel change: it rides the same `beforeToolCall` primitive
 * as `bash-policy`, reuses that file's `unwrap` wrapper-parser, and is a complete
 * **no-op in interactive runs** — the rewrite fires only when "headless" resolves
 * true. Headless is detected from a normalized, pure-env signal set
 * (explicit `EAGENT_HEADLESS` override → TTY state → CI vars → host `EAGENT_FRONTEND`).
 * On a matched shell call it **rewrites** the command to add the program's
 * documented non-interactive flag (`apt-get install -y`, `npm init -y`) and to
 * prepend the env guards that turn prompts/editors into no-ops
 * (`GIT_TERMINAL_PROMPT=0 GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true`,
 * `DEBIAN_FRONTEND=noninteractive`). It **never blocks** — a pure rewrite — and the
 * dispatcher still enforces `shell:exec` on the rewritten call afterward.
 *
 * Ships ON (a CI safety net you want active without remembering to enable it) but
 * inert in a normal TTY session. Disable entirely with `EAGENT_HEADLESS_FLAGS=off`
 * (or `/headless off`); force/relax detection with `EAGENT_HEADLESS=on|off|auto`
 * (or `/headless force …`). Tune the injection dictionary live with
 * `/headless add|remove`, and dry-run a rewrite offline with `/headless test "<cmd>"`.
 */

import type { ToolDecision } from "../kernel/events.ts";
import type { ExtensionAPI } from "../kernel/extension.ts";
import type { Config } from "../kernel/store.ts";
import { unwrap } from "./bash-policy.ts";

/**
 * One program's non-interactive recipe. `flag` is the documented CLI flag that
 * suppresses prompts (`-y`, `--yes`); `skip` lists flags whose presence already
 * makes the command non-interactive (so nothing is injected — idempotency);
 * `env` lists `VAR=val` guards to prepend at the program's simple-command
 * position. An entry with no `flag` (e.g. git) is **env-only**: the env guards
 * are the whole mechanism and are applied whenever they are not already present.
 */
export interface InjectEntry {
  flag?: string;
  skip?: string[];
  env?: string[];
}

/** A dictionary mapping a command family (`git`, `apt-get install`, `npm init`) to its recipe. */
export type InjectDict = Record<string, InjectEntry>;

/**
 * The built-in injection dictionary. Keys are command families: a bare program
 * (`git`, matched env-only against every git subcommand) or a `program subcommand`
 * pair when the flag is subcommand-specific (`apt-get install -y`, `npm init -y`).
 * Longest-family-prefix wins, so `npm install` matches nothing here (no `-y`) while
 * `npm init` does. For git the correct guard is **env, not a flag** — an empty `-m`
 * would be wrong — so `commit`/`rebase -i` editors become no-ops via env only.
 */
export const DEFAULT_DICT: InjectDict = {
  git: { env: ["GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true", "GIT_SEQUENCE_EDITOR=true"] },
  "apt-get install": { flag: "-y", skip: ["-y", "--yes", "--assume-yes"], env: ["DEBIAN_FRONTEND=noninteractive"] },
  "apt-get remove": { flag: "-y", skip: ["-y", "--yes", "--assume-yes"], env: ["DEBIAN_FRONTEND=noninteractive"] },
  "apt-get upgrade": { flag: "-y", skip: ["-y", "--yes", "--assume-yes"], env: ["DEBIAN_FRONTEND=noninteractive"] },
  "apt-get dist-upgrade": { flag: "-y", skip: ["-y", "--yes", "--assume-yes"], env: ["DEBIAN_FRONTEND=noninteractive"] },
  "apt-get purge": { flag: "-y", skip: ["-y", "--yes", "--assume-yes"], env: ["DEBIAN_FRONTEND=noninteractive"] },
  "apt install": { flag: "-y", skip: ["-y", "--yes", "--assume-yes"], env: ["DEBIAN_FRONTEND=noninteractive"] },
  "apt remove": { flag: "-y", skip: ["-y", "--yes", "--assume-yes"], env: ["DEBIAN_FRONTEND=noninteractive"] },
  "apt upgrade": { flag: "-y", skip: ["-y", "--yes", "--assume-yes"], env: ["DEBIAN_FRONTEND=noninteractive"] },
  "npm init": { flag: "-y", skip: ["-y", "--yes"] },
  "pnpm init": { flag: "-y", skip: ["-y", "--yes"] },
  "yarn init": { flag: "-y", skip: ["-y", "--yes"] },
};

// --- pure command-rewrite engine -----------------------------------------

/** Basename of a token, so a path-qualified program (`/usr/bin/git`) is recognized. */
function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash < 0 ? token : token.slice(slash + 1);
}

/** A `VAR=value` environment-assignment token (POSIX simple-command prefix). */
function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** The `VAR` name of a `VAR=value` assignment (everything before the first `=`). */
function envName(assignment: string): string {
  const eq = assignment.indexOf("=");
  return eq < 0 ? assignment : assignment.slice(0, eq);
}

/** Longest-prefix family lookup over the dict (up to three command words). */
function matchEntry(words: string[], dict: InjectDict): { key: string; entry: InjectEntry } | null {
  for (let len = Math.min(words.length, 3); len >= 1; len--) {
    const key = words.slice(0, len).join(" ");
    const entry = dict[key];
    if (entry) return { key, entry };
  }
  return null;
}

/**
 * Rewrite a single *simple* command (no control operators, wrappers already
 * stripped by the caller). Returns the string unchanged when the program is not
 * in the dictionary, is already non-interactive (its flag/skip is present), or
 * has all its env guards already set. Token offsets are taken on the original
 * string so spacing is preserved verbatim; the flag is inserted after the matched
 * family's last word and the env guards are prepended at the program position.
 */
function rewriteSimple(simple: string, dict: InjectDict, platform: string): string {
  const offsets = [...simple.matchAll(/\S+/g)];
  if (offsets.length === 0) return simple;
  const toks = offsets.map((m) => ({ text: m[0] ?? "", index: m.index ?? 0 }));

  // Skip any leading `VAR=value` assignments to reach argv[0].
  let p0 = 0;
  while (p0 < toks.length && isAssignment(toks[p0]!.text)) p0++;
  if (p0 >= toks.length) return simple;

  // The leading contiguous non-flag, non-assignment tokens are the command words.
  const wordIdx: number[] = [];
  for (let i = p0; i < toks.length; i++) {
    const t = toks[i]!.text;
    if (t.startsWith("-") || isAssignment(t)) break;
    wordIdx.push(i);
  }
  if (wordIdx.length === 0) return simple;

  const wordTexts = wordIdx.map((ti, k) => (k === 0 ? basename(toks[ti]!.text) : toks[ti]!.text));
  const match = matchEntry(wordTexts, dict);
  if (!match) return simple;

  const family = match.key.split(/\s+/).length;
  const entry = match.entry;
  const tokenTexts = toks.map((t) => t.text);

  let result = simple;

  // Flag injection (idempotent): if the flag or any equivalent is already
  // present, the command is already non-interactive — inject nothing at all.
  if (entry.flag) {
    const skipSet = [entry.flag, ...(entry.skip ?? [])];
    const alreadyFlagged = tokenTexts.some(
      (t) => skipSet.includes(t) || skipSet.some((s) => t.startsWith(`${s}=`)),
    );
    if (alreadyFlagged) return simple;
    const lastWord = toks[wordIdx[family - 1]!]!;
    const at = lastWord.index + lastWord.text.length;
    result = `${result.slice(0, at)} ${entry.flag}${result.slice(at)}`;
  }

  // Env guards: prepend only the ones not already set as a LEADING `VAR=val`
  // assignment. A shell treats only the contiguous leading assignment prefix as
  // environment for the command, so an assignment-looking word inside an operand
  // (e.g. `git commit -m "GIT_EDITOR=x"`) must not suppress a real guard. POSIX
  // `VAR=val cmd` prefix is skipped on win32 (invalid there); the bare CLI flag
  // above still applies.
  if (platform !== "win32" && entry.env && entry.env.length > 0) {
    const leading = new Set<string>();
    for (const t of tokenTexts) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t);
      if (!m) break; // first non-assignment token ends the leading prefix
      leading.add(m[1]!);
    }
    const missing = entry.env.filter((g) => !leading.has(envName(g)));
    if (missing.length > 0) result = `${missing.join(" ")} ${result}`;
  }

  return result;
}

/**
 * Rewrite one shell *segment* (one command between control operators). Unwraps a
 * recognized wrapper (`sudo`/`env`/`timeout`/…) so the inner program is matched,
 * and splices the rewritten inner back at the wrapper offset so the wrapper and
 * all spacing are preserved.
 */
function rewriteSegment(segment: string, dict: InjectDict, platform: string): string {
  const innerLine = unwrap(segment);
  const inner = innerLine ?? segment;
  const innerOffset = segment.length - inner.length;
  const rewrittenInner = rewriteSimple(inner, dict, platform);
  if (rewrittenInner === inner) return segment;
  return segment.slice(0, innerOffset) + rewrittenInner;
}

/** The byte span of one segment between control operators (boundaries untrimmed). */
interface Span {
  start: number;
  end: number;
}

/**
 * Split a command line into the byte spans a shell would run sequentially,
 * cutting on `|`, `||`, `&&`, `;`, and newline at quote/group depth zero (the
 * same grammar as bash-policy's `segments`, but tracking offsets so the
 * inter-segment operators can be reproduced verbatim on reassembly). A backslash
 * escapes the next character when unquoted or in double quotes; a lone `&` is not
 * a split operator.
 */
function segmentSpans(command: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  let single = false;
  let double = false;
  let backtick = false;
  let parenDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;

    if (c === "\\" && !single) {
      i++;
      continue;
    }
    if (single) {
      if (c === "'") single = false;
      continue;
    }
    if (double) {
      if (c === '"') double = false;
      continue;
    }
    if (backtick) {
      if (c === "`") backtick = false;
      continue;
    }
    if (c === "'") {
      single = true;
      continue;
    }
    if (c === '"') {
      double = true;
      continue;
    }
    if (c === "`") {
      backtick = true;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      parenDepth++;
      i++;
      continue;
    }
    if (c === "(") {
      parenDepth++;
      continue;
    }
    if (c === ")") {
      if (parenDepth > 0) parenDepth--;
      continue;
    }
    if (parenDepth > 0) continue;

    if (c === "\n" || c === ";") {
      out.push({ start, end: i });
      start = i + 1;
      continue;
    }
    if (c === "|") {
      out.push({ start, end: i });
      if (command[i + 1] === "|") i++;
      start = i + 1;
      continue;
    }
    if (c === "&" && command[i + 1] === "&") {
      out.push({ start, end: i });
      i++;
      start = i + 1;
      continue;
    }
  }
  out.push({ start, end: command.length });
  return out;
}

/**
 * Rewrite a (possibly compound) shell command for non-interactive execution: for
 * each segment, add the matched program's non-interactive flag and prepend its
 * env guards. Pure and idempotent — re-running over its own output is a no-op,
 * and a command with no recognized program (or already non-interactive) is
 * returned byte-identical. Inter-segment operators and all spacing are preserved.
 *
 * @param platform `process.platform`; on `win32` the POSIX `VAR=val` env prefix
 *   is skipped (bare CLI flags still apply). Defaults to the running platform.
 */
export function rewriteCommand(command: string, dict: InjectDict, platform: string = process.platform): string {
  let out = "";
  let cursor = 0;
  for (const span of segmentSpans(command)) {
    out += command.slice(cursor, span.start); // the operator/gap before this span
    const raw = command.slice(span.start, span.end);
    const lead = /^\s*/.exec(raw)?.[0] ?? "";
    const trail = /\s*$/.exec(raw)?.[0] ?? "";
    const content = raw.slice(lead.length, raw.length - trail.length);
    out += content === "" ? raw : lead + rewriteSegment(content, dict, platform) + trail;
    cursor = span.end;
  }
  out += command.slice(cursor);
  return out;
}

// --- pure headless detection ---------------------------------------------

/** Known CI marker variables whose mere presence implies a non-interactive run. */
const CI_VARS = ["GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "CIRCLECI", "JENKINS_URL", "TF_BUILD"] as const;

/** Host-set frontends that are inherently non-interactive. */
const HEADLESS_FRONTENDS = ["server", "batch", "json"];

/** A `CI`-style flag is truthy unless it is empty / `0` / `false`. */
function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Resolve headless from a pure, no-I/O signal set. Explicit `EAGENT_HEADLESS=on|off`
 * wins; otherwise headless is true if any of: a non-TTY stdin/stdout, a truthy
 * `CI`, a known CI var, or a non-interactive `EAGENT_FRONTEND`. TTY state is
 * injected (not read from `process`) so the detection is deterministic in tests.
 */
export function resolveHeadless(
  env: NodeJS.ProcessEnv,
  tty: { stdin: boolean; stdout: boolean },
): { headless: boolean; reason: string } {
  const override = (env.EAGENT_HEADLESS ?? "auto").toLowerCase();
  if (override === "on") return { headless: true, reason: "EAGENT_HEADLESS=on (forced)" };
  if (override === "off") return { headless: false, reason: "EAGENT_HEADLESS=off (forced interactive)" };

  const reasons: string[] = [];
  if (!tty.stdin) reasons.push("stdin not a TTY");
  if (!tty.stdout) reasons.push("stdout not a TTY");
  if (truthy(env.CI)) reasons.push(`CI=${env.CI}`);
  for (const v of CI_VARS) if (env[v]) reasons.push(`${v} set`);
  const frontend = env.EAGENT_FRONTEND;
  if (frontend && HEADLESS_FRONTENDS.includes(frontend)) reasons.push(`EAGENT_FRONTEND=${frontend}`);

  if (reasons.length > 0) return { headless: true, reason: reasons.join("; ") };
  return { headless: false, reason: "interactive TTY (stdin+stdout), no CI signal" };
}

// --- store-backed dictionary override ------------------------------------

const KEYS = { dict: "dict", commandArgKey: "commandArgKey" } as const;

/** A stored override value is a valid `InjectEntry` (or `null`, a removal tombstone). */
function validEntry(v: unknown): v is InjectEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.flag !== undefined && typeof o.flag !== "string") return false;
  if (o.env !== undefined && !(Array.isArray(o.env) && o.env.every((x) => typeof x === "string"))) return false;
  if (o.skip !== undefined && !(Array.isArray(o.skip) && o.skip.every((x) => typeof x === "string"))) return false;
  return true;
}

// --- activation ----------------------------------------------------------

export default function activate(e: ExtensionAPI): () => void {
  /** Cached resolution + reason for the current session (cleared on session/reload). */
  let cached: { headless: boolean; reason: string } | null = null;

  const ttyState = (): { stdin: boolean; stdout: boolean } => ({
    stdin: !!process.stdin.isTTY,
    stdout: !!process.stdout.isTTY,
  });

  // Overlay the config-resolved `headless`/`frontend` values onto the process
  // environment so the pure resolver sees an operator's `/headless force …`
  // override (config.string reads override > env > file) alongside the CI signals.
  const headlessEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    EAGENT_HEADLESS: e.config.string("headless"),
    EAGENT_FRONTEND: e.config.string("frontend"),
  });

  const resolve = (): { headless: boolean; reason: string } => {
    if (!cached) cached = resolveHeadless(headlessEnv(), ttyState());
    return cached;
  };

  /** `DEFAULT_DICT` merged with the validated store override; `null` removes a key. */
  const activeDict = (): InjectDict => {
    const raw = e.store.get<unknown>(KEYS.dict);
    if (typeof raw !== "object" || raw === null) return DEFAULT_DICT;
    const merged: InjectDict = { ...DEFAULT_DICT };
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null) delete merged[k];
      else if (validEntry(v)) merged[k] = v;
    }
    return merged;
  };

  const offHook = e.hook("beforeToolCall", (decision, ctx): ToolDecision => {
    const enabled = e.config.enabled("headless-flags", { default: true });
    // Never un-block another guard's veto, and stay inert when disabled or interactive.
    if (!enabled || decision.block) return decision;
    if (!resolve().headless) return decision;

    // Capability-scope by the declared capability, not the tool name (bash-policy idiom).
    const caps = e.agent.tools.get(ctx.call.name)?.capabilities;
    if (!caps?.includes("shell:exec")) return decision;

    const commandArgKey = e.store.get<string>(KEYS.commandArgKey, "command") ?? "command";
    const command = ctx.call.arguments[commandArgKey];
    if (typeof command !== "string") return decision;

    const rewritten = rewriteCommand(command, activeDict());
    if (rewritten === command) return decision;
    return { ...decision, arguments: { ...decision.arguments, [commandArgKey]: rewritten } };
  });

  const offAgentStart = e.on("agent_start", () => {
    const r = resolve();
    e.log.info(
      r.headless
        ? `headless=true (reason: ${r.reason}) — non-interactive flags active`
        : `headless=false (${r.reason})`,
    );
  });

  const clear = (): void => {
    cached = null;
  };
  const offStart = e.on("session_start", clear);
  const offDown = e.on("session_shutdown", clear);

  const offCmd = e.registerCommand({
    name: "headless",
    description:
      "Non-interactive shell flags. Usage: /headless [on|off|force on|off|auto|" +
      'test "<cmd>"|add <prog> <flag> [ENV=val ...]|remove <prog>]',
    run: (c) => {
      const args = c.args.trim();
      const [head, ...rest] = args.split(/\s+/);
      const tail = args.slice(head ? head.length : 0).trim();

      switch (head) {
        case "on":
          e.config.set("headless-flags", true);
          c.print("headless-flags on");
          return;
        case "off":
          e.config.set("headless-flags", false);
          c.print("headless-flags off");
          return;
        case "force": {
          const mode = (rest[0] ?? "").toLowerCase();
          if (mode === "on" || mode === "off") {
            e.config.set("headless", mode);
          } else if (mode === "auto") {
            e.config.unset("headless");
          } else {
            c.print("headless: usage — /headless force on|off|auto");
            return;
          }
          clear();
          c.print(`headless: detection override set to ${mode}`);
          return;
        }
        case "test": {
          // Dry-run: print the rewrite of the (optionally quoted) command.
          const command = tail.replace(/^["']|["']$/g, "");
          if (command === "") {
            c.print('headless: usage — /headless test "<command>"');
            return;
          }
          c.print(rewriteCommand(command, activeDict()));
          return;
        }
        case "add": {
          const parsed = parseAdd(tail);
          if (!parsed) {
            c.print("headless: usage — /headless add <program> <flag> [ENV=val ...]");
            return;
          }
          const stored = e.store.get<unknown>(KEYS.dict);
          const override: Record<string, unknown> =
            typeof stored === "object" && stored !== null ? { ...(stored as Record<string, unknown>) } : {};
          override[parsed.program] = parsed.entry;
          e.store.set(KEYS.dict, override);
          c.print(`headless: dictionary updated — ${parsed.program} -> ${describeEntry(parsed.entry)}`);
          return;
        }
        case "remove": {
          const program = (rest[0] ?? "").trim();
          if (program === "") {
            c.print("headless: usage — /headless remove <program>");
            return;
          }
          const stored = e.store.get<unknown>(KEYS.dict);
          const override: Record<string, unknown> =
            typeof stored === "object" && stored !== null ? { ...(stored as Record<string, unknown>) } : {};
          override[program] = null; // tombstone: removes a built-in too
          e.store.set(KEYS.dict, override);
          c.print(`headless: removed ${program} from the dictionary`);
          return;
        }
        default:
          renderStatus(c.print, resolve(), activeDict(), e.config);
      }
    },
  });

  return () => {
    for (const d of [offHook, offAgentStart, offStart, offDown, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}

/** Parse an `add` argument line into a program key and its recipe entry. */
export function parseAdd(rest: string): { program: string; entry: InjectEntry } | null {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const program = parts[0]!;
  const entry: InjectEntry = {};
  const env: string[] = [];
  for (const p of parts.slice(1)) {
    if (isAssignment(p)) env.push(p);
    else entry.flag = p;
  }
  if (entry.flag) entry.skip = [entry.flag];
  if (env.length > 0) entry.env = env;
  if (entry.flag === undefined && env.length === 0) return null;
  return { program, entry };
}

/** A one-line human description of an entry (flag + env), for command echoes. */
function describeEntry(entry: InjectEntry): string {
  const bits: string[] = [];
  if (entry.flag) bits.push(`flag ${entry.flag}`);
  if (entry.env && entry.env.length > 0) bits.push(`env ${entry.env.join(" ")}`);
  return bits.length > 0 ? bits.join(", ") : "(no-op)";
}

/** Print the status view: resolution + reason, on/off state, active dictionary. */
function renderStatus(
  print: (line: string) => void,
  resolution: { headless: boolean; reason: string },
  dict: InjectDict,
  config: Config,
): void {
  const enabled = config.enabled("headless-flags", { default: true });
  print(`headless-flags ${enabled ? "on" : "off"}`);
  print(`headless=${resolution.headless} (reason: ${resolution.reason})`);
  const override = (config.string("headless") ?? "auto").toLowerCase();
  print(`detection override: headless=${override}`);
  print("injection dictionary:");
  for (const [program, entry] of Object.entries(dict)) {
    print(`  ${program}: ${describeEntry(entry)}`);
  }
}
