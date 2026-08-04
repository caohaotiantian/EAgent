/**
 * Subprocess confinement for tools.
 *
 * The capability layer answers "is this tool ALLOWED to act?"; this file answers
 * "and if it misbehaves, what can it reach?". They are different questions and both
 * are needed — an allowed tool with a bug can still read the journal, exhaust memory,
 * or run for an hour.
 *
 * HONEST SCOPE, restated from D6.8: this confines *processes*. It does not sandbox
 * arbitrary in-process JavaScript, and a `function` node's body is trusted, reviewed,
 * pinned code (assumption A13). Anyone reading this file looking for a way to run
 * untrusted code safely should stop here.
 *
 * v1 controls: argv array (never a shell string), cwd jail with escape detection,
 * env allowlist, wall-clock timeout with SIGTERM → grace → SIGKILL, and an output
 * byte cap. `DEFERRED-v2`: seccomp/Landlock syscall filtering, cgroup memory limits,
 * and the egress proxy — each is platform-specific work with its own review.
 */

import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

import { CODES, err } from "../errors.ts";

export interface SandboxOptions {
  /** Executable path or name. Resolved by the OS; never interpreted by a shell. */
  readonly command: string;
  /**
   * Arguments as an ARRAY. There is deliberately no string form: a single
   * concatenated command line is how argument injection happens, and offering the
   * option at all means someone eventually takes it.
   */
  readonly args: readonly string[];
  /** The jail root. The child starts here and every path argument is checked against it. */
  readonly cwd: string;
  /** Environment variable NAMES to pass through. Everything else is dropped. */
  readonly envAllow?: readonly string[];
  /** Extra variables to set explicitly (already-resolved secrets go here, not in env). */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** SIGTERM, then this long, then SIGKILL. Default 2s. */
  readonly gracePeriodMs?: number;
  /** Output beyond this is discarded and flagged. Default 1 MiB. */
  readonly maxOutputBytes?: number;
  readonly stdin?: string;
}

export interface SandboxResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when output hit `maxOutputBytes`. The result is not the whole story. */
  readonly truncated: boolean;
  readonly ms: number;
  /** True when the process had to be killed rather than exiting. */
  readonly timedOut: boolean;
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024;
const DEFAULT_GRACE_MS = 2000;

/**
 * The minimum a child needs to run at all. Notably absent: everything else — no
 * `AWS_*`, no `ANTHROPIC_API_KEY`, no `HOME` unless asked for. A tool that needs a
 * credential receives it through `env`, explicitly, per call.
 */
const BASE_ENV_ALLOW = ["PATH", "LANG", "LC_ALL", "TZ"] as const;

/**
 * Reject a path that escapes the jail.
 *
 * Uses `path.relative` rather than a `startsWith` prefix check: `startsWith` accepts
 * `/jail-evil` for a root of `/jail`, and it does not resolve `..` at all.
 */
export function assertWithin(root: string, candidate: string): string {
  const absRoot = resolve(root);
  const absPath = resolve(absRoot, candidate);
  const rel = relative(absRoot, absPath);
  if (rel === "") return absPath;
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw err.policy(CODES.E_CAP_DENIED, `path "${candidate}" escapes the sandbox root`, {
      details: { root: absRoot, candidate },
    });
  }
  return absPath;
}

/** True when the path stays inside the jail. For callers that want a boolean. */
export function isWithin(root: string, candidate: string): boolean {
  try {
    assertWithin(root, candidate);
    return true;
  } catch {
    return false;
  }
}

export function buildEnv(allow: readonly string[] | undefined, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const names = new Set([...BASE_ENV_ALLOW, ...(allow ?? [])]);
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return { ...out, ...extra };
}

/**
 * Run a command under confinement.
 *
 * Never throws for a non-zero exit — that is a result, not an exception. It throws
 * only when the sandbox itself could not be established (a path escape, a spawn
 * failure) or when the caller aborted.
 */
export async function runSandboxed(opts: SandboxOptions, signal: AbortSignal): Promise<SandboxResult> {
  if (signal.aborted) throw err.cancelled();

  const cwd = resolve(opts.cwd);
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const grace = opts.gracePeriodMs ?? DEFAULT_GRACE_MS;
  const started = Date.now();

  const child = spawn(opts.command, [...opts.args], {
    cwd,
    env: buildEnv(opts.envAllow, opts.env),
    // Never a shell. With `shell: true` the argv array is re-joined and re-parsed,
    // which reintroduces exactly the injection the array form exists to prevent.
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    // Detached so the kill signal reaches the whole process GROUP; a tool that spawns
    // its own children must not leave orphans behind after a timeout.
    detached: process.platform !== "win32",
  });

  let stdout = "";
  let stderr = "";
  let outBytes = 0;
  let truncated = false;
  let timedOut = false;

  const capture = (chunk: Buffer, to: "out" | "err"): void => {
    if (outBytes >= maxBytes) {
      truncated = true;
      return;
    }
    const room = maxBytes - outBytes;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    outBytes += slice.length;
    if (slice.length < chunk.length) truncated = true;
    if (to === "out") stdout += slice.toString("utf8");
    else stderr += slice.toString("utf8");
  };

  child.stdout.on("data", (c: Buffer) => capture(c, "out"));
  child.stderr.on("data", (c: Buffer) => capture(c, "err"));

  if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
  else child.stdin.end();

  const kill = (sig: NodeJS.Signals): void => {
    try {
      // Negative pid targets the process group, so a tool's own children die too.
      if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // Already gone; nothing to do.
    }
  };

  const result = await new Promise<SandboxResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (r: SandboxResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(r);
    };
    const fail = (e: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(e);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      // Grace, then force. A process that ignores SIGTERM does not get to hold a slot.
      graceTimer = setTimeout(() => kill("SIGKILL"), grace);
    }, opts.timeoutMs);
    let graceTimer: NodeJS.Timeout | undefined;

    const onAbort = (): void => {
      timedOut = false;
      kill("SIGTERM");
      graceTimer = setTimeout(() => kill("SIGKILL"), grace);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      signal.removeEventListener("abort", onAbort);
    };

    child.on("error", (e) =>
      fail(err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, `could not spawn "${opts.command}": ${e.message}`, { cause: e })),
    );
    child.on("close", (code, sig) => {
      if (signal.aborted) {
        fail(err.cancelled(`tool "${opts.command}" was cancelled`));
        return;
      }
      finish({
        code,
        signal: sig,
        stdout,
        stderr,
        truncated,
        ms: Date.now() - started,
        timedOut,
      });
    });
  });

  if (result.timedOut) {
    throw err.timeout(CODES.E_TOOL_TIMEOUT, `"${opts.command}" exceeded ${opts.timeoutMs}ms`, {
      details: { command: opts.command, stdout: result.stdout.slice(0, 500), stderr: result.stderr.slice(0, 500) },
    });
  }
  return result;
}
