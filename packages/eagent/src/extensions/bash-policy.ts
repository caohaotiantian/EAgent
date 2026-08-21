/**
 * bash-policy — command-granular shell authority.
 *
 * The capability layer authorizes the shell as a single coarse capability,
 * `shell:exec`: all-or-nothing. There is no vocabulary for "run git and npm,
 * but ask before curl and deny rm -rf". This extension adds that middle ground
 * as policy, not as a kernel change. It rides the `beforeToolCall` filter (the
 * same primitive flow-guard uses), reduces a full command line to its
 * human-meaningful command family via an arity dictionary, evaluates a
 * configurable allow/deny/ask ruleset, and allows / blocks / prompts.
 *
 * The two-key model: rules match the *full command line* (wildcard `*` is the
 * only metacharacter), while the *extracted prefix* is the display label and
 * the session-remember key — approving one `git commit` covers the session's
 * `git commit`s without blanket-approving `git push`.
 *
 * It ships no-op by default (empty ruleset, fallthrough allow). Tune it with
 * `/bash-policy`, or disable it entirely with `EAGENT_BASH_POLICY=off`.
 */

import type { Agent } from "../kernel/agent.ts";
import type { ExtensionAPI } from "../kernel/extension.ts";
import { normalizeForInspection } from "./lib/decode.ts";

export type Action = "allow" | "deny" | "ask";

export interface Rule {
  pattern: string;
  action: Action;
  justification?: string;
}

/**
 * Command-prefix arities: how many tokens define the human-meaningful command.
 * Adapted from opencode's `permission/arity.ts` (MIT). A longest-prefix lookup
 * over this table extracts e.g. `git checkout` from `git checkout -b feature`.
 */
const ARITY: Record<string, number> = {
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  which: 1,
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  "bun run": 3,
  "bun x": 3,
  cargo: 2,
  "cargo add": 3,
  "cargo run": 3,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  "consul kv": 3,
  crictl: 2,
  deno: 2,
  "deno task": 3,
  doctl: 3,
  docker: 2,
  "docker builder": 3,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  "docker network": 3,
  "docker volume": 3,
  eksctl: 2,
  "eksctl create": 3,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  go: 2,
  gradle: 2,
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  "ip addr": 3,
  "ip link": 3,
  "ip netns": 3,
  "ip route": 3,
  kind: 2,
  "kind create": 3,
  kubectl: 2,
  "kubectl kustomize": 3,
  "kubectl rollout": 3,
  kustomize: 2,
  make: 2,
  mc: 2,
  "mc admin": 3,
  minikube: 2,
  mongosh: 2,
  mysql: 2,
  mvn: 2,
  ng: 2,
  npm: 2,
  "npm exec": 3,
  "npm init": 3,
  "npm run": 3,
  "npm view": 3,
  nvm: 2,
  nx: 2,
  openssl: 2,
  "openssl req": 3,
  "openssl x509": 3,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  poetry: 2,
  podman: 2,
  "podman container": 3,
  "podman image": 3,
  psql: 2,
  pulumi: 2,
  "pulumi stack": 3,
  pyenv: 2,
  python: 2,
  rake: 2,
  rbenv: 2,
  "redis-cli": 2,
  rustup: 2,
  serverless: 2,
  sfdx: 3,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  "terraform workspace": 3,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  "vault auth": 3,
  "vault kv": 3,
  vercel: 2,
  volta: 2,
  wp: 2,
  yarn: 2,
  "yarn dlx": 3,
  "yarn run": 3,
};

/** Longest-prefix arity lookup; falls back to the first token, or [] when empty. */
function prefix(tokens: string[]): string[] {
  for (let len = tokens.length; len > 0; len--) {
    const key = tokens.slice(0, len).join(" ");
    const arity = ARITY[key];
    if (arity !== undefined) return tokens.slice(0, arity);
  }
  if (tokens.length === 0) return [];
  return tokens.slice(0, 1);
}

/** Drop leading `VAR=value` assignments and `-flag`/`--flag` tokens; the rest are command tokens. */
function commandTokens(commandLine: string): string[] {
  const tokens = commandLine.trim().split(/\s+/).filter(Boolean);
  return tokens.filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && !t.startsWith("-"));
}

/**
 * Strip the directory from the program token so a path-qualified invocation is
 * governed by the same rules as the bare name: `/bin/rm`, `./rm`, `../sbin/rm`,
 * and `bin/rm` all reduce to `rm`. Without this, a `rm` deny rule is bypassed by
 * spelling the program with a path. Only argv[0] — the first non-`VAR=value`
 * token, after any leading environment assignments — is rewritten; operands
 * (e.g. the `/etc/passwd` in `cat /etc/passwd`) are left untouched, and all other
 * spacing and tokens are preserved verbatim.
 */
export function normalizeProgram(commandLine: string): string {
  const match = commandLine.match(/^(\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)(\S+)/);
  if (!match) return commandLine;
  const [, lead, program] = match as unknown as [string, string, string];
  const slash = program.lastIndexOf("/");
  if (slash < 0) return commandLine;
  const base = program.slice(slash + 1);
  if (base === "") return commandLine;
  return commandLine.slice(0, lead.length) + base + commandLine.slice(lead.length + program.length);
}

/** Reduce a command line to its human-meaningful command family (or "" if empty). */
export function extractCommand(commandLine: string): string {
  return prefix(commandTokens(commandLine)).join(" ");
}

/**
 * Per-wrapper prefix grammar: how to skip a wrapper's own options so the inner
 * program is exposed. `argFlags` are flags that consume a following value
 * (`sudo -u root`) or carry it attached (`-uroot`, `--user=root`); `positionals`
 * is the count of leading bare operands the wrapper takes (`timeout 5 cmd`);
 * `assignments` is whether leading `VAR=value` tokens precede the command
 * (`env FOO=bar cmd`).
 */
interface Wrapper {
  argFlags: Set<string>;
  positionals: number;
  assignments: boolean;
}

const WRAPPERS: Record<string, Wrapper> = {
  sudo: { argFlags: new Set(["-u", "--user", "-g", "--group", "-C", "-p", "-U", "-h", "-r", "-t"]), positionals: 0, assignments: false },
  doas: { argFlags: new Set(["-u", "-C"]), positionals: 0, assignments: false },
  env: { argFlags: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]), positionals: 0, assignments: true },
  nice: { argFlags: new Set(["-n", "--adjustment"]), positionals: 0, assignments: false },
  ionice: { argFlags: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"]), positionals: 0, assignments: false },
  timeout: { argFlags: new Set(["-s", "--signal", "-k", "--kill-after"]), positionals: 1, assignments: false },
  nohup: { argFlags: new Set(), positionals: 0, assignments: false },
  setsid: { argFlags: new Set(), positionals: 0, assignments: false },
  xargs: {
    argFlags: new Set([
      "-n", "--max-args", "-P", "--max-procs", "-I", "--replace",
      "-d", "--delimiter", "-a", "--arg-file", "-E", "-L", "--max-lines",
      "-s", "--max-chars",
    ]),
    positionals: 0,
    assignments: false,
  },
};

/** Basename of a token, so a path-qualified wrapper (`/usr/bin/sudo`) is recognized. */
function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash < 0 ? token : token.slice(slash + 1);
}

/**
 * When the command's head program (by basename) is a recognized wrapper, consume
 * its option/argument prefix and return the remaining inner command line, with
 * verbatim spacing preserved by slicing the original at the inner program's
 * offset. Recurses for stacked wrappers (`sudo env rm`), terminating because at
 * least argv[0] is removed each step. Returns `null` when the head is not a
 * recognized wrapper or no inner program remains.
 */
export function unwrap(commandLine: string): string | null {
  const offsets = [...commandLine.matchAll(/\S+/g)];
  if (offsets.length === 0) return null;
  const tokens = offsets.map((m) => m[0]);

  const wrapper = WRAPPERS[basename(tokens[0]!)];
  if (!wrapper) return null;

  let i = 1;
  let positionalsLeft = wrapper.positionals;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (wrapper.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i++;
      continue;
    }
    if (token.startsWith("-")) {
      const hasAttachedValue = token.includes("=");
      if (wrapper.argFlags.has(token) && !hasAttachedValue) i += 2;
      else i++;
      continue;
    }
    if (positionalsLeft > 0) {
      positionalsLeft--;
      i++;
      continue;
    }
    break;
  }

  if (i >= tokens.length) return null;
  const inner = commandLine.slice(offsets[i]!.index);
  return unwrap(inner) ?? inner;
}

/**
 * Split a command line into the command segments a shell would run sequentially,
 * cutting on the control operators `|`, `||`, `&&`, `;`, and newline — but only
 * when they occur at quote/group depth zero and are not backslash-escaped. The
 * scanner tracks single-quote, double-quote, and backtick state plus `$(`/`(`
 * paren depth so an operator inside a quoted string or a substitution does not
 * split (which would tear a legitimate command into a spurious dangerous-looking
 * segment and false-block it). A backslash escapes the next character when the
 * scanner is unquoted or inside double quotes, and is literal inside single
 * quotes (bash semantics). A lone `&` is not a split operator; only `&&` splits.
 * Segments are trimmed and empties dropped.
 */
export function segments(commandLine: string): string[] {
  const out: string[] = [];
  let start = 0;
  let single = false;
  let double = false;
  let backtick = false;
  let parenDepth = 0;

  const push = (end: number): void => {
    const seg = commandLine.slice(start, end).trim();
    if (seg !== "") out.push(seg);
  };

  for (let i = 0; i < commandLine.length; i++) {
    const c = commandLine[i]!;

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

    if (c === "$" && commandLine[i + 1] === "(") {
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
      push(i);
      start = i + 1;
      continue;
    }
    if (c === "|") {
      push(i);
      if (commandLine[i + 1] === "|") i++;
      start = i + 1;
      continue;
    }
    if (c === "&" && commandLine[i + 1] === "&") {
      push(i);
      i++;
      start = i + 1;
      continue;
    }
  }

  push(commandLine.length);
  return out;
}

const EXEC_PRIMARIES = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const EXEC_TERMINATORS = new Set([";", "\\;", "+", "';'", '";"']);

/**
 * When a segment's program (by basename) is `find`, extract each command `find`
 * itself runs: the tokens between an `-exec`/`-execdir`/`-ok`/`-okdir` primary
 * and its terminator token (`;`, `\;`, `+`, or a quoted form), excluding the
 * terminator and keeping placeholders like `{}`. Returns `[]` for a non-`find`
 * segment. The terminator is matched as a whole token wherever it appears, so a
 * `g++` operand is never mistaken for a `+` terminator. A clause with no
 * terminator runs to the end of the segment; scanning continues past each
 * terminator for further clauses. The original string is sliced so the inner
 * command's spacing is preserved verbatim.
 */
export function findExecCommands(segment: string): string[] {
  const program = commandTokens(normalizeProgram(segment))[0];
  if (program === undefined || basename(program) !== "find") return [];

  const offsets = [...segment.matchAll(/\S+/g)];
  const tokens = offsets.map((m) => m[0]);
  const out: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    if (!EXEC_PRIMARIES.has(tokens[i]!)) {
      i++;
      continue;
    }
    const cmdStart = i + 1;
    let j = cmdStart;
    while (j < tokens.length && !EXEC_TERMINATORS.has(tokens[j]!)) j++;
    if (j > cmdStart) {
      const from = offsets[cmdStart]!.index;
      const to = offsets[j - 1]!.index + tokens[j - 1]!.length;
      const command = segment.slice(from, to).trim();
      if (command !== "") out.push(command);
    }
    i = j + 1;
  }

  return out;
}

/**
 * Expand a command line into the full candidate set the guard evaluates: the
 * normalized whole line first, then for each segment its normalized form, its
 * `unwrap` inner, and each `find -exec` command (also normalized + unwrapped).
 * The list is first-wins deduped with order otherwise preserved, so
 * `expandCommands("sudo rm -rf build")` collapses to exactly
 * `["sudo rm -rf build", "rm -rf build"]` (parity with prior behavior) while the
 * inner/sub-command candidates stay last, keeping the last-match labeling on the
 * offending sub-command.
 */
export function expandCommands(commandLine: string): string[] {
  const out: string[] = [];
  const add = (line: string): void => {
    const normalized = normalizeProgram(line);
    if (normalized !== "" && !out.includes(normalized)) out.push(normalized);
    const innerRaw = unwrap(normalized);
    if (innerRaw != null) {
      const inner = normalizeProgram(innerRaw);
      if (inner !== "" && !out.includes(inner)) out.push(inner);
    }
  };

  add(commandLine);
  for (const segment of segments(commandLine)) {
    add(segment);
    for (const inner of findExecCommands(segment)) add(inner);
  }
  return out;
}

/** Regex-escape a single literal character (the metacharacter set the matcher recognizes). */
function escapeChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * Compile a pattern body to anchored regex source. `*` → `.*`; `\` + one of
 * `[ ] | \` → that literal; `\` + any other char (or trailing `\`) → a literal
 * backslash; `[`…`]` → a non-capturing alternation `(?:…|…)` over its
 * (unescaped-`|`-split) interior — when `allowGroups` is false (inside a group)
 * a `[` is a literal, so groups stay flat; an unterminated `[` is a fail-safe
 * literal. Every other char is escaped literal. Never throws.
 */
function compile(pattern: string, allowGroups: boolean): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next === "[" || next === "]" || next === "|" || next === "\\") {
        out += escapeChar(next);
        i += 2;
        continue;
      }
      out += "\\\\";
      i += 1;
      continue;
    }
    if (c === "*") {
      out += ".*";
      i += 1;
      continue;
    }
    if (c === "[" && allowGroups) {
      let close = -1;
      for (let j = i + 1; j < pattern.length; j++) {
        if (pattern[j] === "\\") {
          j++;
          continue;
        }
        if (pattern[j] === "]") {
          close = j;
          break;
        }
      }
      if (close < 0) {
        out += "\\[";
        i += 1;
        continue;
      }
      const interior = pattern.slice(i + 1, close);
      const alternatives: string[] = [];
      let start = 0;
      for (let j = 0; j < interior.length; j++) {
        if (interior[j] === "\\") {
          j++;
          continue;
        }
        if (interior[j] === "|") {
          alternatives.push(interior.slice(start, j));
          start = j + 1;
        }
      }
      alternatives.push(interior.slice(start));
      out += `(?:${alternatives.map((a) => compile(a, false)).join("|")})`;
      i = close + 1;
      continue;
    }
    out += escapeChar(c);
    i += 1;
  }
  return out;
}

/**
 * Compile a pattern to an anchored matcher. `*` is the wildcard (`.*`), `[a|b]`
 * is a bounded alternation group, the `\` escape yields literal `[ ] | \`, and
 * every other character is literal. Degenerate forms compile fail-safe-literal
 * and never throw.
 */
export function toRegExp(pattern: string): RegExp {
  return new RegExp(`^${compile(pattern, true)}$`);
}

/**
 * Resolve a ruleset over several candidate command lines under last-match-wins:
 * iterate rules from last to first; the first rule whose pattern matches some
 * candidate wins, with `matched` set to the last candidate (in the given order)
 * that rule matches. No rule matches → `{ action: fallthrough, matched: commands[0] }`.
 */
export function evaluateAny(
  commands: string[],
  rules: Rule[],
  fallthrough: Action,
): { action: Action; matched: string; rule?: Rule } {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    const re = toRegExp(rule.pattern);
    let matched: string | undefined;
    for (const command of commands) {
      if (re.test(command)) matched = command;
    }
    if (matched !== undefined) return { action: rule.action, matched, rule };
  }
  return { action: fallthrough, matched: commands[0] ?? "", rule: undefined };
}

/** The action of the last rule whose pattern matches the full command line, else fallthrough. */
export function evaluate(command: string, rules: Rule[], fallthrough: Action): Action {
  return evaluateAny([command], rules, fallthrough).action;
}

export default function activate(e: ExtensionAPI): () => void {
  const cfg = () => ({
    enabled: e.config.enabled("bash-policy", { default: true }),
    rules: e.store.get<Rule[]>("rules", []) ?? [],
    fallthrough: (e.store.get<Action>("fallthrough", "allow") ?? "allow") as Action,
    commandArgKey: e.store.get<string>("commandArgKey", "command") ?? "command",
  });

  // Extracted prefixes the human approved this session, keyed on the SESSION ROOT
  // (`e.rootAgent`) so an approval is shared across a session's fork tree yet
  // isolated BETWEEN sessions (each on its own Agent). No reset closure is needed:
  // eviction drops the root Agent and GCs the entry. (Note: unreachable on today's
  // HTTP server — `serverUI.confirm` is fail-safe-deny, so `approved` never grows
  // there; converted defensively for a future interactive server.)
  const approvedByRoot = new WeakMap<Agent, Set<string>>();
  const approvedFor = (agent: Agent): Set<string> => {
    let s = approvedByRoot.get(agent);
    if (!s) approvedByRoot.set(agent, (s = new Set<string>()));
    return s;
  };

  const offHook = e.hook("beforeToolCall", async (decision, ctx) => {
    const { enabled, rules, fallthrough, commandArgKey } = cfg();
    if (!enabled || decision.block) return decision;

    const caps = e.agent.tools.get(ctx.call.name)?.capabilities;
    if (!caps?.includes("shell:exec")) return decision;

    const command = ctx.call.arguments[commandArgKey];
    if (typeof command !== "string") return decision;

    // Expand the line into the whole line plus every effective sub-command
    // (segments, wrapper unwraps, and `find -exec` commands), each normalized so
    // a path-qualified or wrapped inner program (e.g. the `rm` of `sudo rm` or of
    // `... && rm`) is matched and labeled by its bare name. Inner candidates come
    // last so a sub-command rule labels the offending sub-command, not the head.
    const candidates = expandCommands(command);

    // Pre-inspection decode (decode-normalize): union the best-effort decoded
    // candidates (base64/hex/rot13 and the `echo <b64>|base64 -d|sh` / `printf
    // '\xNN'` idioms), each itself run through `expandCommands` so a decoded
    // `rm -rf /` is segmented/normalized like any command line. The decode layer
    // never blocks — it only widens the set this same ruleset already judges.
    // `EAGENT_DECODE_NORMALIZE=off` restores literal-only matching.
    if (e.config.enabled("decode.normalize", { default: true })) {
      for (const decoded of normalizeForInspection(command)) {
        for (const expanded of expandCommands(decoded)) {
          if (!candidates.includes(expanded)) candidates.push(expanded);
        }
      }
    }

    const { action, matched, rule } = evaluateAny(candidates, rules, fallthrough);
    if (action === "allow") return decision;

    const family = extractCommand(matched);
    const why = `${family || command} (policy ${action})`;
    const j = rule?.justification?.trim();
    const suffix = j ? `: ${j}` : "";
    if (action === "deny") {
      return { ...decision, block: true, reason: `bash-policy: blocked ${why}${suffix}` };
    }

    const approved = approvedFor(e.rootAgent);
    if (approved.has(family)) return decision;
    const allow = await e.agent.ui.confirm(`bash-policy: allow ${family || command}${j ? ` (${j})` : ""}?`);
    if (!allow) return { ...decision, block: true, reason: `bash-policy: denied ${why}${suffix}` };
    approved.add(family);
    return decision;
  });

  const offCmd = e.registerCommand({
    name: "bash-policy",
    description: "Command-granular shell policy. Usage: /bash-policy [on|off|status]",
    run: (c) => {
      const arg = c.args.trim();
      switch (arg) {
        case "on":
          e.config.set("bash-policy", true);
          c.print("bash-policy on");
          break;
        case "off":
          e.config.set("bash-policy", false);
          c.print("bash-policy off");
          break;
        default: {
          const { enabled, rules, fallthrough } = cfg();
          const printed =
            rules
              .map((r) => `${r.pattern} -> ${r.action}${r.justification ? ` (${r.justification})` : ""}`)
              .join("; ") || "(none)";
          c.print(`bash-policy ${enabled ? "on" : "off"} (fallthrough=${fallthrough}); rules: ${printed}`);
        }
      }
    },
  });

  return () => {
    for (const d of [offHook, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
