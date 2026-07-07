/**
 * config-hooks — declarative, config-file-driven bridge to the kernel hook bus.
 *
 * EAgent already exposes its filter points (`transformContext`, `transformRequest`,
 * `beforeToolCall`, `afterToolCall`, `onProviderError`) and a dozen lifecycle
 * events, but wiring them requires authoring a TypeScript extension. This extension ports Claude
 * Code's `settings.json`-hooks model onto EAgent's primitives: it reads a small
 * JSON config that binds *matcher -> action* rules onto a named event/filter
 * point, validates it (a hand-written, zero-dep validator that never throws),
 * and installs each binding into the live bus at activation.
 *
 * Users get observers and guards without writing code: block a tool call by
 * name/argument, inject a system note, annotate/truncate a result, run a shell
 * validator, fire a notification. The pure-data actions (`block`, `allow`,
 * `inject`, `append`, `truncate`, `notify`) need no process and run fully
 * offline; the one privileged action (`command`) runs a shell command and is
 * gated on `shell:exec` through the same `CapabilityManager` as core-tools'
 * bash — so the CLI front end *asks* and the HTTP/yolo front end *allows*.
 *
 * It registers NO tool (hence no `capabilities:[...]` on a `defineTool` and no
 * `grantCapability` — auto-granting `shell:exec` would defeat the gate). Before
 * spawning, the `command` handler calls `e.agent.capabilities.require`. On a
 * `CapabilityError` the action is skipped and the decision is left unchanged
 * (fail-open: config-hooks never fabricates a block it could not compute). Pair
 * a `command` guard with a static `block` fallback binding for fail-closed
 * semantics.
 *
 * It ships **off** (opt-in) because a config file can live in an untrusted repo
 * and the `command` action executes shell from disk. Enablement is
 * `EAGENT_CONFIG_HOOKS !== "off"` AND a store `enabled` flag — set via
 * `/config-hooks on`. `EAGENT_CONFIG_HOOKS=off` force-disables regardless.
 *
 * Config shape (in `<cwd>/.eagent/hooks.json` or `~/.eagent/hooks.json`):
 *
 *     { "hooks": [ { "on": <point>, "match": { "tool": <glob?>,
 *                    "args": { "<arg>": <glob> }? }?, "action": <action> } ] }
 */

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";

import type { ToolDecision } from "../kernel/events.js";
import type { KernelEvents } from "../kernel/events.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { Message, ToolCallBlock, ToolResult } from "../kernel/types.js";

// ---------------------------------------------------------------------------
// Config model
// ---------------------------------------------------------------------------

/** A point a binding may wire: a filter point or a supported lifecycle event. */
export type Point =
  | "transformContext"
  | "beforeToolCall"
  | "afterToolCall"
  | "tool_start"
  | "tool_end"
  | "agent_start"
  | "agent_end"
  | "session_start"
  | "session_shutdown"
  | "error";

/** An anchored `*`-glob matcher on the tool call name and stringified args. */
export interface Match {
  tool?: string;
  args?: Record<string, string>;
}

/** The action a matching binding performs. Pure-data except `command`. */
export type Action =
  | { type: "block"; reason?: string }
  | { type: "allow" }
  | { type: "inject"; text: string }
  | { type: "append"; text: string }
  | { type: "truncate"; limit: number }
  | { type: "notify"; text: string }
  | { type: "command"; command: string; timeoutMs?: number; sandbox?: true | "required" };

/** One declarative hook binding: a point, an optional matcher, and an action. */
export interface Binding {
  on: Point;
  match?: Match;
  action: Action;
}

/** The result of resolving and validating config: bindings plus dropped-entry errors. */
export interface LoadedConfig {
  bindings: Binding[];
  errors: string[];
  source: string;
}

/** Which action types are valid on which point — a type/point mismatch is dropped. */
const POINT_ACTIONS: Record<Point, ReadonlySet<Action["type"]>> = {
  transformContext: new Set(["inject", "command"]),
  beforeToolCall: new Set(["block", "allow", "command"]),
  afterToolCall: new Set(["append", "truncate", "notify", "command"]),
  tool_start: new Set(["notify", "command"]),
  tool_end: new Set(["notify", "command"]),
  agent_start: new Set(["notify", "command"]),
  agent_end: new Set(["notify", "command"]),
  session_start: new Set(["notify", "command"]),
  session_shutdown: new Set(["notify", "command"]),
  error: new Set(["notify", "command"]),
};

/** The lifecycle events config-hooks observes (the non-filter points). */
const EVENT_POINTS: readonly (keyof KernelEvents)[] = [
  "tool_start",
  "tool_end",
  "agent_start",
  "agent_end",
  "session_start",
  "session_shutdown",
  "error",
];

const DEFAULT_TIMEOUT_MS = 10_000;
const STDERR_HEAD = 200;
const TRUNCATE_MARKER = "...[truncated]";

// ---------------------------------------------------------------------------
// Glob matcher (anchored, `*`-only, fail-safe-literal, never throws)
// ---------------------------------------------------------------------------

/** Regex-escape one literal character (the metacharacter set the matcher recognizes). */
function escapeChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * Compile an anchored `*`-only glob to a `RegExp`. `*` becomes `.*`; every other
 * character is a literal. No user regex is ever injected, so it never throws.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (const c of pattern) out += c === "*" ? ".*" : escapeChar(c);
  return new RegExp(`^${out}$`);
}

/**
 * Does a binding's matcher select this call? An absent matcher matches all;
 * `match.tool` is an anchored glob on the call name; each `match.args[k]` is an
 * anchored glob on `String(call.arguments[k])`.
 */
export function matchesCall(
  match: Match | undefined,
  call: { name: string; arguments: Record<string, unknown> },
): boolean {
  if (!match) return true;
  if (match.tool !== undefined && !globToRegExp(match.tool).test(call.name)) return false;
  if (match.args) {
    for (const [k, pat] of Object.entries(match.args)) {
      if (!globToRegExp(pat).test(String(call.arguments[k]))) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Validation (hand-written, zero-dep, never throws)
// ---------------------------------------------------------------------------

/** Extract the raw `hooks` array from either `{hooks:[...]}` or a bare array. */
function extractHooks(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const h = (raw as { hooks?: unknown }).hooks;
    if (Array.isArray(h)) return h;
  }
  return null;
}

/** Validate one action object; return the typed `Action` or an error string. */
function validateAction(raw: unknown, i: number): Action | string {
  if (!raw || typeof raw !== "object") return `hook[${i}]: \`action\` must be an object`;
  const a = raw as { type?: unknown; reason?: unknown; text?: unknown; limit?: unknown; command?: unknown; timeoutMs?: unknown; sandbox?: unknown };
  switch (a.type) {
    case "allow":
      return { type: "allow" };
    case "block": {
      if (a.reason !== undefined && typeof a.reason !== "string") return `hook[${i}]: \`action.reason\` must be a string`;
      return a.reason === undefined ? { type: "block" } : { type: "block", reason: a.reason };
    }
    case "inject":
    case "append":
    case "notify": {
      if (typeof a.text !== "string") return `hook[${i}]: \`${a.type}\` requires a string \`text\``;
      return { type: a.type, text: a.text };
    }
    case "truncate": {
      if (typeof a.limit !== "number" || !Number.isFinite(a.limit) || a.limit < 0) {
        return `hook[${i}]: \`truncate\` requires a non-negative number \`limit\``;
      }
      return { type: "truncate", limit: a.limit };
    }
    case "command": {
      if (typeof a.command !== "string" || a.command.length === 0) {
        return `hook[${i}]: \`command\` requires a non-empty string \`command\``;
      }
      const action: Extract<Action, { type: "command" }> = { type: "command", command: a.command };
      if (a.timeoutMs !== undefined) {
        if (typeof a.timeoutMs !== "number" || !Number.isFinite(a.timeoutMs) || a.timeoutMs <= 0) {
          return `hook[${i}]: \`command.timeoutMs\` must be a positive number`;
        }
        action.timeoutMs = a.timeoutMs;
      }
      if (a.sandbox !== undefined) {
        if (a.sandbox !== true && a.sandbox !== "required") return `hook[${i}]: \`command.sandbox\` must be true or "required"`;
        action.sandbox = a.sandbox;
      }
      return action;
    }
    default:
      return `hook[${i}]: unknown \`action.type\`: ${String(a.type)}`;
  }
}

/** Validate one match object; return the typed `Match` (or undefined) or an error string. */
function validateMatch(raw: unknown, i: number): Match | undefined | string {
  if (raw == null) return undefined;
  if (typeof raw !== "object") return `hook[${i}]: \`match\` must be an object`;
  const m = raw as { tool?: unknown; args?: unknown };
  const match: Match = {};
  if (m.tool !== undefined) {
    if (typeof m.tool !== "string") return `hook[${i}]: \`match.tool\` must be a string`;
    match.tool = m.tool;
  }
  if (m.args !== undefined) {
    if (!m.args || typeof m.args !== "object") return `hook[${i}]: \`match.args\` must be an object`;
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.args as Record<string, unknown>)) {
      if (typeof v !== "string") return `hook[${i}]: \`match.args.${k}\` must be a string`;
      args[k] = v;
    }
    match.args = args;
  }
  return match;
}

/** Validate one binding; return the typed `Binding` or an error string. */
function validateBinding(entry: unknown, i: number): Binding | string {
  if (!entry || typeof entry !== "object") return `hook[${i}]: must be an object`;
  const b = entry as { on?: unknown; match?: unknown; action?: unknown };
  if (typeof b.on !== "string" || !(b.on in POINT_ACTIONS)) return `hook[${i}]: unknown \`on\`: ${String(b.on)}`;
  const on = b.on as Point;
  const action = validateAction(b.action, i);
  if (typeof action === "string") return action;
  if (!POINT_ACTIONS[on].has(action.type)) return `hook[${i}]: action \`${action.type}\` is not valid on \`${on}\``;
  const match = validateMatch(b.match, i);
  if (typeof match === "string") return match;
  return match === undefined ? { on, action } : { on, match, action };
}

/**
 * Validate a parsed config (a `{hooks:[...]}` object or a bare bindings array)
 * into a list of well-formed bindings plus a per-entry `errors` list. A bad
 * entry is dropped individually with a recorded message; this never throws.
 */
export function validateConfig(raw: unknown): { bindings: Binding[]; errors: string[] } {
  const bindings: Binding[] = [];
  const errors: string[] = [];
  const hooks = extractHooks(raw);
  if (hooks === null) {
    if (raw != null) errors.push("`hooks` must be an array");
    return { bindings, errors };
  }
  for (let i = 0; i < hooks.length; i++) {
    const r = validateBinding(hooks[i], i);
    if (typeof r === "string") errors.push(r);
    else bindings.push(r);
  }
  return { bindings, errors };
}

// ---------------------------------------------------------------------------
// Result helpers (pure)
// ---------------------------------------------------------------------------

/** Cap `content` at `limit` bytes, appending an ellipsis marker when truncated. */
export function truncateBytes(content: string, limit: number): string {
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= limit) return content;
  return buf.subarray(0, Math.max(0, limit)).toString("utf8") + TRUNCATE_MARKER;
}

/** Parse a `command` validator's stdout as a `{block?,reason?,arguments?}` directive, or null. */
export function parseDirective(
  stdout: string,
): { block?: boolean; reason?: string; arguments?: Record<string, unknown> } | null {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as { block?: boolean; reason?: string; arguments?: Record<string, unknown> };
    }
  } catch {
    // not a directive
  }
  return null;
}

/** A short human description of a matcher, for `/config-hooks list`. */
function describeMatch(match: Match | undefined): string {
  if (!match) return "*";
  const parts: string[] = [];
  if (match.tool !== undefined) parts.push(`tool=${match.tool}`);
  if (match.args) for (const [k, v] of Object.entries(match.args)) parts.push(`${k}=${v}`);
  return parts.length ? parts.join(",") : "*";
}

// ---------------------------------------------------------------------------
// Shell + sandbox (the one privileged path)
// ---------------------------------------------------------------------------

interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The shell invocation for the current platform (no login shell). */
function shellInvocation(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    return { shell: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] };
  }
  return { shell: "/bin/sh", args: ["-c"] };
}

/** Captured stream output is capped so a flooding hook can't buffer unbounded. */
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Run a shell command to completion, capturing stdout/stderr under a timeout.
 * Each stream is decoded with a `StringDecoder` (so a multibyte UTF-8 sequence
 * split across chunk boundaries is not corrupted into U+FFFD — which could
 * garble a legitimate JSON directive) and capped at `MAX_OUTPUT_BYTES`; on
 * overflow the child is killed rather than buffering without bound.
 */
function runShell(command: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve, reject) => {
    const { shell, args } = shellInvocation();
    const child = spawn(shell, [...args, command], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsVerbatimArguments: process.platform === "win32",
    });
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let errBytes = 0;
    child.stdout?.on("data", (d: Buffer) => {
      if (outBytes >= MAX_OUTPUT_BYTES) return;
      outBytes += d.length;
      stdout += outDec.write(d);
      if (outBytes >= MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (errBytes >= MAX_OUTPUT_BYTES) return;
      errBytes += d.length;
      stderr += errDec.write(d);
      if (errBytes >= MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      stdout += outDec.end();
      stderr += errDec.end();
      resolve({ code: code ?? (signal ? 137 : 1), stdout, stderr });
    });
  });
}

/** POSIX single-quote a string so it survives one round of `/bin/sh -c`. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Is `bin` resolvable on `PATH`? A lazy, never-throws probe over the PATH dirs. */
function onPath(bin: string): boolean {
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(sep)) {
    if (!dir) continue;
    try {
      if (statSync(join(dir, bin)).isFile()) return true;
    } catch {
      // not here
    }
  }
  return false;
}

let sandboxCache: ((cmd: string) => string) | null | undefined;

/** A lazily-probed, cached sandbox wrapper for this platform, or null if none. */
function sandboxWrapper(): ((cmd: string) => string) | null {
  if (sandboxCache !== undefined) return sandboxCache;
  try {
    if (process.platform === "darwin" && onPath("sandbox-exec")) {
      sandboxCache = (cmd) =>
        `sandbox-exec -p '(version 1)(deny default)(allow process-exec)(allow process-fork)' /bin/sh -c ${shQuote(cmd)}`;
    } else if (process.platform === "linux" && onPath("bwrap")) {
      sandboxCache = (cmd) => `bwrap --ro-bind / / --dev /dev --proc /proc /bin/sh -c ${shQuote(cmd)}`;
    } else if (process.platform === "linux" && onPath("firejail")) {
      sandboxCache = (cmd) => `firejail --quiet /bin/sh -c ${shQuote(cmd)}`;
    } else {
      sandboxCache = null;
    }
  } catch {
    sandboxCache = null;
  }
  return sandboxCache;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export default function activate(e: ExtensionAPI): () => void {
  /** File-config cache; invalidated by `/config-hooks reload`. */
  let cache: LoadedConfig | undefined;

  const enabled = (): boolean => e.config.enabled("config-hooks", { default: false, store: e.store });

  /** Read a config file; null = missing (silent skip), else parsed/validated. */
  const readConfigFile = (path: string): { bindings: Binding[]; errors: string[] } | null => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return null; // missing file is a silent skip
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { bindings: [], errors: [`invalid JSON: ${(err as Error).message}`] };
    }
    return validateConfig(parsed);
  };

  /**
   * Resolve the live config, re-read on every hook invocation so reload and the
   * test store-seam take effect. The store override (`hooks`) wins; otherwise the
   * user file then the project file are concatenated (project last -> last-match
   * -wins) and cached until reload.
   */
  const loadConfig = (): LoadedConfig => {
    const stored = e.store.get<Binding[]>("hooks");
    if (stored !== undefined) {
      const { bindings, errors } = validateConfig(stored);
      return { bindings, errors, source: "store" };
    }
    if (cache) return cache;
    const bindings: Binding[] = [];
    const errors: string[] = [];
    const used: string[] = [];
    for (const path of [join(homedir(), ".eagent", "hooks.json"), join(process.cwd(), ".eagent", "hooks.json")]) {
      const r = readConfigFile(path);
      if (r === null) continue;
      used.push(path);
      for (const err of r.errors) errors.push(`${path}: ${err}`);
      for (const b of r.bindings) bindings.push(b);
    }
    cache = { bindings, errors, source: used.length ? used.join(", ") : "(no config file)" };
    return cache;
  };

  /**
   * Run a `command` action and resolve a decision contribution. Returns "skip"
   * when the action could not run (capability denied, required-sandbox missing,
   * or a spawn error) so the caller leaves the decision unchanged (fail-open).
   */
  const runCommandDecision = async (
    action: Extract<Action, { type: "command" }>,
  ): Promise<"skip" | { block: boolean; reason?: string; arguments?: Record<string, unknown> }> => {
    try {
      await e.agent.capabilities.require("shell:exec", "config-hooks");
    } catch {
      e.log.warn(`command action skipped: shell:exec denied for \`${action.command}\``);
      return "skip";
    }
    const command = resolveCommand(action);
    if (command === null) return "skip";
    let res: ShellResult;
    try {
      res = await runShell(command, action.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    } catch (err) {
      e.log.warn(`command action errored (decision unchanged): ${(err as Error).message}`);
      return "skip";
    }
    if (res.code !== 0) {
      const head = res.stderr.trim().slice(0, STDERR_HEAD);
      return { block: true, reason: `config-hooks: ${action.command} exited ${res.code}${head ? `: ${head}` : ""}` };
    }
    const directive = parseDirective(res.stdout);
    if (directive?.block) {
      return { block: true, reason: `config-hooks: ${directive.reason ?? `${action.command} requested block`}` };
    }
    if (directive?.arguments && typeof directive.arguments === "object") {
      return { block: false, arguments: directive.arguments };
    }
    return { block: false };
  };

  /** Resolve a command through the optional sandbox; null = skip (required + unavailable). */
  const resolveCommand = (action: Extract<Action, { type: "command" }>): string | null => {
    if (!action.sandbox) return action.command;
    const wrap = sandboxWrapper();
    if (wrap) return wrap(action.command);
    if (action.sandbox === "required") {
      e.log.warn(`command action skipped: sandbox required but unavailable for \`${action.command}\``);
      return null;
    }
    e.log.warn(`sandbox unavailable; running \`${action.command}\` unsandboxed`);
    return action.command;
  };

  /** Fire-and-forget a `command` action (observers / context notes), errors swallowed. */
  const runCommandFireForget = async (action: Extract<Action, { type: "command" }>): Promise<void> => {
    try {
      await e.agent.capabilities.require("shell:exec", "config-hooks");
    } catch {
      e.log.warn(`command action skipped: shell:exec denied for \`${action.command}\``);
      return;
    }
    const command = resolveCommand(action);
    if (command === null) return;
    try {
      await runShell(command, action.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    } catch (err) {
      e.log.warn(`command action errored: ${(err as Error).message}`);
    }
  };

  // -- transformContext: prepend `inject` system notes (fresh array) ---------
  const offTransform = e.hook("transformContext", async (messages) => {
    if (!enabled()) return messages;
    const notes: Message[] = [];
    for (const b of loadConfig().bindings) {
      if (b.on !== "transformContext") continue;
      if (b.action.type === "inject") {
        notes.push({
          role: "system",
          content: [{ type: "text", text: b.action.text }],
          meta: { source: "config-hooks", ephemeral: true },
        });
      } else if (b.action.type === "command") {
        void runCommandFireForget(b.action);
      }
    }
    return notes.length === 0 ? messages : [...notes, ...messages];
  });

  // -- beforeToolCall: block / allow / command guards (last-match-wins) -------
  const offBefore = e.hook("beforeToolCall", async (decision, ctx) => {
    // Never un-block another guard's veto.
    if (decision.block || !enabled()) return decision;
    let acc: ToolDecision = decision;
    for (const b of loadConfig().bindings) {
      if (b.on !== "beforeToolCall") continue;
      if (!matchesCall(b.match, ctx.call)) continue;
      const action = b.action;
      if (action.type === "block") {
        acc = { ...acc, block: true, reason: `config-hooks: ${action.reason ?? "blocked by config-hooks"}` };
      } else if (action.type === "allow") {
        // Explicit pass: re-permit (only ever clears config-hooks' own block);
        // spread `acc` so any unrelated field threaded on the decision survives.
        acc = { ...acc, block: false };
      } else if (action.type === "command") {
        const outcome = await runCommandDecision(action);
        if (outcome === "skip") continue;
        if (outcome.block) acc = { ...acc, block: true, reason: outcome.reason };
        else if (outcome.arguments) acc = { ...acc, block: false, arguments: outcome.arguments };
      }
    }
    return acc;
  });

  // -- afterToolCall: append / truncate / notify / command ------------------
  const offAfter = e.hook("afterToolCall", async (result, ctx) => {
    if (!enabled()) return result;
    let acc: ToolResult = result;
    for (const b of loadConfig().bindings) {
      if (b.on !== "afterToolCall") continue;
      if (!matchesCall(b.match, ctx.call)) continue;
      const action = b.action;
      if (action.type === "append") {
        acc = { ...acc, content: `${acc.content}\n${action.text}` };
      } else if (action.type === "truncate") {
        acc = { ...acc, content: truncateBytes(acc.content, action.limit) };
      } else if (action.type === "notify") {
        try {
          e.agent.ui.notify(action.text);
        } catch {
          // a notifier must never break the chain
        }
      } else if (action.type === "command") {
        void runCommandFireForget(action);
      }
    }
    return acc;
  });

  // -- lifecycle events: notify / command observers -------------------------
  const offEvents = EVENT_POINTS.map((pt) =>
    e.on(pt, async (payload) => {
      if (!enabled()) return;
      const call = (payload as { call?: ToolCallBlock }).call;
      for (const b of loadConfig().bindings) {
        if (b.on !== pt) continue;
        // An event without a call can't satisfy a tool/args matcher.
        if (!call) {
          if (b.match && (b.match.tool !== undefined || b.match.args)) continue;
        } else if (!matchesCall(b.match, call)) {
          continue;
        }
        if (b.action.type === "notify") {
          try {
            e.agent.ui.notify(b.action.text);
          } catch {
            // observers must never throw
          }
        } else if (b.action.type === "command") {
          void runCommandFireForget(b.action);
        }
      }
    }),
  );

  const offCmd = e.registerCommand({
    name: "config-hooks",
    description: "Declarative hooks from .eagent/hooks.json. Usage: /config-hooks [on|off|status|reload|list]",
    run: (c) => {
      const arg = c.args.trim();
      switch (arg) {
        case "on":
          e.store.set("enabled", true);
          c.print("config-hooks on");
          break;
        case "off":
          e.store.set("enabled", false);
          c.print("config-hooks off");
          break;
        case "reload": {
          cache = undefined;
          const { bindings, errors } = loadConfig();
          c.print(`config-hooks: loaded ${bindings.length} binding(s), ${errors.length} error(s)`);
          break;
        }
        case "list": {
          const { bindings } = loadConfig();
          if (bindings.length === 0) {
            c.print("(no bindings)");
            break;
          }
          for (const b of bindings) c.print(`${b.on}  ${describeMatch(b.match)}  -> ${b.action.type}`);
          break;
        }
        default: {
          const { bindings, errors, source } = loadConfig();
          const counts = new Map<string, number>();
          for (const b of bindings) counts.set(b.on, (counts.get(b.on) ?? 0) + 1);
          const summary = [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "(none)";
          c.print(`config-hooks ${enabled() ? "on" : "off"} (source: ${source}); bindings: ${summary}`);
          if (errors.length) c.print(`errors: ${errors.join("; ")}`);
        }
      }
    },
  });

  return () => {
    for (const d of [offTransform, offBefore, offAfter, offCmd, ...offEvents]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
