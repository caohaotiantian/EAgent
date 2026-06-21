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

import type { ExtensionAPI } from "../kernel/extension.js";

export type Action = "allow" | "deny" | "ask";

export interface Rule {
  pattern: string;
  action: Action;
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

/** Compile a wildcard pattern: `*` → `.*`, every other regex metachar escaped, full-anchored. */
function toRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : `\\${c}`));
  return new RegExp(`^${escaped}$`);
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
): { action: Action; matched: string } {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    const re = toRegExp(rule.pattern);
    let matched: string | undefined;
    for (const command of commands) {
      if (re.test(command)) matched = command;
    }
    if (matched !== undefined) return { action: rule.action, matched };
  }
  return { action: fallthrough, matched: commands[0] ?? "" };
}

/** The action of the last rule whose pattern matches the full command line, else fallthrough. */
export function evaluate(command: string, rules: Rule[], fallthrough: Action): Action {
  return evaluateAny([command], rules, fallthrough).action;
}

export default function activate(e: ExtensionAPI): () => void {
  const cfg = () => ({
    enabled: process.env.EAGENT_BASH_POLICY !== "off",
    rules: e.store.get<Rule[]>("rules", []) ?? [],
    fallthrough: (e.store.get<Action>("fallthrough", "allow") ?? "allow") as Action,
    commandArgKey: e.store.get<string>("commandArgKey", "command") ?? "command",
  });

  /** Extracted prefixes the human approved this session (cleared on reset). */
  const approved = new Set<string>();

  const offHook = e.hook("beforeToolCall", async (decision, ctx) => {
    const { enabled, rules, fallthrough, commandArgKey } = cfg();
    if (!enabled || decision.block) return decision;

    const caps = e.agent.tools.get(ctx.call.name)?.capabilities;
    if (!caps?.includes("shell:exec")) return decision;

    const command = ctx.call.arguments[commandArgKey];
    if (typeof command !== "string") return decision;

    // Normalize so a path-qualified program (e.g. `/bin/rm`) is matched and
    // labeled as its bare name; additionally expose a wrapper's inner program
    // (e.g. the `rm` of `sudo rm`) so inner-program rules fire through it.
    const outer = normalizeProgram(command);
    const innerRaw = unwrap(outer);
    const inner = innerRaw != null ? normalizeProgram(innerRaw) : null;
    const candidates = inner != null ? [outer, inner] : [outer];
    const { action, matched } = evaluateAny(candidates, rules, fallthrough);
    if (action === "allow") return decision;

    const family = extractCommand(matched);
    const why = `${family || command} (policy ${action})`;
    if (action === "deny") {
      return { ...decision, block: true, reason: `bash-policy: blocked ${why}` };
    }

    if (approved.has(family)) return decision;
    const allow = await e.agent.ui.confirm(`bash-policy: allow ${family || command}?`);
    if (!allow) return { ...decision, block: true, reason: `bash-policy: denied ${why}` };
    approved.add(family);
    return decision;
  });

  const reset = () => approved.clear();
  const offStart = e.on("session_start", reset);
  const offDown = e.on("session_shutdown", reset);

  const offCmd = e.registerCommand({
    name: "bash-policy",
    description: "Command-granular shell policy. Usage: /bash-policy [on|off|status]",
    run: (c) => {
      const arg = c.args.trim();
      switch (arg) {
        case "on":
          delete process.env.EAGENT_BASH_POLICY;
          c.print("bash-policy on");
          break;
        case "off":
          process.env.EAGENT_BASH_POLICY = "off";
          c.print("bash-policy off");
          break;
        default: {
          const { enabled, rules, fallthrough } = cfg();
          const printed = rules.map((r) => `${r.pattern} -> ${r.action}`).join("; ") || "(none)";
          c.print(`bash-policy ${enabled ? "on" : "off"} (fallthrough=${fallthrough}); rules: ${printed}`);
        }
      }
    },
  });

  return () => {
    for (const d of [offHook, offStart, offDown, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
