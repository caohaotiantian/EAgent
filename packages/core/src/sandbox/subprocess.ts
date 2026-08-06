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
 * v1 controls: argv array (never a shell string), a cwd the child is started in, env
 * allowlist, wall-clock timeout with SIGTERM → grace → SIGKILL, and an output byte cap.
 * `DEFERRED-v2`: seccomp/Landlock syscall filtering, cgroup memory limits, and the egress
 * proxy — each is platform-specific work with its own review.
 *
 * THE JAIL IS `assertWithin`, AND IT IS THE CALLER'S TO APPLY. `runSandboxed` resolves
 * `cwd` and starts the child there; it does not inspect `args`, because it cannot know
 * which of them are paths — `--out=x` and `x` and `@x` are all a path to some program and
 * none to another. The checking happens where the argument's meaning is known, which is
 * `builtin/tools.ts` (`grep -an assertWithin packages/core/src`). A previous version of
 * this paragraph said "cwd jail with escape detection" and `SandboxOptions.cwd` said
 * "every path argument is checked against it", which no code in this file did or could.
 *
 * NO LISTENER IN THIS FILE MAY THROW. A child process is four EventEmitters — the
 * `ChildProcess` and its three pipes — and each one is a call into this module from
 * Node's event loop, where there is no `try` above the frame: an exception ends the
 * process, and with it every in-flight run and every open gate's return path. *The
 * mechanism that contains a misbehaving tool becomes the mechanism that takes down the
 * orchestrator.* There are two ways to violate it and this file has had both:
 *
 *  1. **An `'error'` nobody listens for.** Node turns it into an uncaught exception, and
 *     teardown is precisely when pipes error. All four emitters are listened to below,
 *     and each listener says what it does with the error rather than swallowing by
 *     default.
 *  2. **A listener that throws on its own.** Weaker to spot and identical in effect. The
 *     `'data'` listeners took `maxOutputBytes` — the one *number* in `SandboxOptions` that
 *     was never bounded — straight into a comparison and a string concatenation, so
 *     `maxOutputBytes: 2 ** 31` against a child writing 600 MiB ended as
 *     `RangeError: Invalid string length` **as an uncaught exception**, and a
 *     `{valueOf() { throw }}` did the same on the first chunk.
 *
 * **THE RULE WAS RIGHT AND THE SWEEP THAT CLOSED IT WAS SCOPED TO NUMBERS, so this
 * paragraph asserted a property the file next to it did not have — twice, in successive
 * waves, each time narrowed rather than re-derived.** `opts.command` is read from THREE
 * listeners: the child's `'error'` handler, the `'close'` handler's cancelled arm, and
 * `reportUncontained`, which runs from a `setTimeout`. None of them read a snapshot;
 * every one was a property access on a record built outside this package. Measured,
 * node v24.16.0, with a `command` whose getter answers `spawn` and throws on the next
 * read — the same shape as `boundedBytes`'s hostile row, one field over:
 *
 *     get command() { … }, spawn emits ENOENT  → UNCAUGHT in the `'error'` listener
 *     the same getter, aborted mid-run         → UNCAUGHT in the `'close'` listener
 *
 * The check is `boundedCommand`, and the derivation the narrowings skipped is this:
 * **read every listener body and name every free variable it touches.** They are now
 * `maxBytes`, `command`, `timeoutMs`, `grace`, `killError`, `child` and the mutable
 * capture state — six locals, one Node handle, and nothing off `opts`.
 *
 * **A THIRD FAILURE IS NOT ABOUT THE HOST AT ALL, and it is the quiet one.** A throw
 * between `spawn` and the promise that owns the timers leaves a child running with no
 * kill armed and nothing holding a handle to it. `child.stdin.end(opts.stdin)` was that
 * throw: `stdin` was read after the child existed and typed nothing, so a non-string
 * raised `ERR_INVALID_ARG_TYPE` out of this function while a `ProcessWrap` and three
 * `PipeWrap`s stayed live and the child ran to its own end. The caller was told loudly
 * and the tool was not contained, in the module whose whole subject is containment.
 *
 * The rule is the durable part, and it now covers values as well as numbers: anything a
 * listener touches, and anything read after `spawn`, is validated and SNAPSHOTTED into a
 * primitive before the child exists. A listener is not a place to discover that a
 * caller's value was wrong, and neither is the gap between a child and its timer.
 */

import { constants as BUFFER } from "node:buffer";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

import { CODES, err } from "../errors.ts";

export interface SandboxOptions {
  /**
   * Executable path or name. Resolved by the OS; never interpreted by a shell.
   *
   * A non-empty string, READ EXACTLY ONCE, before the child exists — see
   * `boundedCommand`. It is the one field in this record that three listeners quote, so
   * a getter that answers twice is a call into caller code from Node's event loop.
   */
  readonly command: string;
  /**
   * Arguments as an ARRAY. There is deliberately no string form: a single
   * concatenated command line is how argument injection happens, and offering the
   * option at all means someone eventually takes it.
   */
  readonly args: readonly string[];
  /**
   * Where the child starts. Resolved, and nothing else — see the module docstring.
   *
   * It is the jail ROOT that `assertWithin` takes, but `runSandboxed` does not apply it
   * to `args`: only the caller knows which argument is a path. Passing an unchecked
   * `../..` through `args` reaches the child exactly as written.
   */
  readonly cwd: string;
  /** Environment variable NAMES to pass through. Everything else is dropped. */
  readonly envAllow?: readonly string[];
  /** Extra variables to set explicitly (already-resolved secrets go here, not in env). */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Wall-clock limit before SIGTERM. A whole number from 1 to `MAX_TIMER_MS`.
   *
   * There is no way to say "no limit", deliberately. Both spellings people reach for —
   * `0` and `Infinity` — are refused, because `setTimeout` turns each of them into ONE
   * MILLISECOND and a tool that was meant to run unbounded is killed on its first tick.
   */
  readonly timeoutMs: number;
  /**
   * SIGTERM, then this long, then SIGKILL. Default 2 s; a whole number from 0 to
   * `MAX_TIMER_MS`.
   *
   * `0` is legal and means "no grace" — SIGKILL on the next tick. That is a coherent
   * thing to ask for, which is the whole reason `timeoutMs` refuses the same value: "give
   * this no time to shut down" makes sense and "let this run for no time" does not.
   */
  readonly gracePeriodMs?: number;
  /**
   * Output beyond this is discarded and `truncated` is set. Default 1 MiB; a whole number
   * from 0 to `MAX_OUTPUT_BYTES`.
   *
   * `0` is legal and means "capture nothing, tell me it was truncated" — a coherent ask
   * for a tool whose exit code is the whole answer, in the same way `gracePeriodMs: 0`
   * is. There is deliberately no way to say "no limit": the two spellings people reach
   * for, `Infinity` and `NaN`, both DISABLED the cap silently, and the thing on the far
   * side of the cap is the host's own heap.
   */
  readonly maxOutputBytes?: number;
  /**
   * Written to the child's stdin, which is then closed so a reader sees EOF.
   *
   * A string, and REFUSED BEFORE `spawn` when it is not one — including a `Buffer`, which
   * `Writable.end` would accept and this type never promised. Encode bytes yourself; the
   * narrower contract is what lets the check run before there is a child to orphan.
   *
   * DELIVERY IS NOT GUARANTEED and cannot be: a child may exit or stop reading before the
   * write drains (`cmd | head -1` is the same shape and is not an error), and the kill
   * path breaks the pipe on purpose. What the child did with whatever arrived is reported
   * by its own exit code and output — see `runSandboxed`'s stdin listener for the limit.
   */
  readonly stdin?: string;
}

export interface SandboxResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * True when the result is not the whole story: output hit `maxOutputBytes`, **or** a
   * pipe failed mid-read and the rest of that stream is gone.
   *
   * The second half was added with the pipe `'error'` listeners. It belongs on this flag
   * rather than on a new one because a caller's question is the same either way — "am I
   * looking at all of it?" — and a lost read answers it identically to a cap.
   */
  readonly truncated: boolean;
  readonly ms: number;
  /** True when the process had to be killed rather than exiting. */
  readonly timedOut: boolean;
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024;
const DEFAULT_GRACE_MS = 2000;

/**
 * How long after SIGKILL a child may still be un-reaped before it is called uncontained.
 *
 * NOT a knob, and deliberately not one: it is not a policy an operator chooses but a
 * statement about the platform. SIGKILL cannot be caught or ignored, so the only honest
 * reasons a reap is slow are the kernel's (uninterruptible I/O) and Node's (`'close'` also
 * waits for the stdio pipes, which a grandchild that escaped the process group can hold
 * open indefinitely). Five seconds is far beyond the first and finite for the second.
 *
 * Erring late is the right direction here, and it is a different judgement from the
 * durations above: over-waiting delays a report, whereas under-waiting would tell an
 * operator a contained process is loose. `MAX_TIMER_MS` is not consulted because no caller
 * supplies this.
 */
const REAP_DEADLINE_MS = 5000;

/**
 * The largest delay a Node timer can hold — 2³¹−1 ms, about 24.8 days.
 *
 * `setTimeout` keeps its delay in a 32-bit signed integer and TRUNCATES anything larger to
 * ONE MILLISECOND. It does not saturate and it does not throw, and `NaN`, `Infinity` and
 * every negative land in the same place. Measured on node v24.16.0, against a child that
 * never exits: `timeoutMs: 2 ** 31` raised `E_TOOL_TIMEOUT "… exceeded 2147483648ms"`
 * **3 ms after the call**, and `gracePeriodMs: 2 ** 31` sent SIGKILL 1 ms after SIGTERM.
 *
 * **This is the kill path**, which is why it matters more here than anywhere else the
 * constant appears: every other copy governs how long something waits, and this one
 * governs whether a runaway process is stopped and whether it is given any chance to stop
 * itself. A copy lives in every module that BOUNDS a caller-supplied delay;
 * `grep -ran 'MAX_TIMER_MS' packages/core/src` finds those, and it is a list of the
 * modules that got it right rather than a list of the modules that hand a timer a number
 * — HANDOFF A12 names the ones still missing. A module that reaches `setTimeout` with a
 * caller's value and does not appear in that grep is a defect, not an exemption. They are
 * copies rather than one export because a platform fact does not belong on the pinned
 * public surface.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The largest output cap this process can actually hold — V8's maximum string length.
 *
 * READ FROM THE PLATFORM rather than written down, because unlike `MAX_TIMER_MS` it is
 * not the same number everywhere: 2³²−25 characters on 64-bit V8 (536 870 888, measured
 * on node v24.16.0 / darwin 25.6.0) and far smaller on 32-bit. Hard-coding it would make
 * the ceiling wrong on exactly the builds where it binds first.
 *
 * `capture` accumulates into a `string`, and `+=` past this limit throws
 * `RangeError: Invalid string length` — **inside a `'data'` listener**, where nothing
 * catches it. So this is not tidiness about memory; it is the second half of the module
 * docstring's rule. A byte is never more than one UTF-16 code unit once decoded (ASCII is
 * 1:1, a 4-byte astral sequence is 2 units, an invalid byte is one replacement char), so
 * capping the BYTE total at this value bounds both strings below the limit.
 *
 * The cap is shared across stdout and stderr, so the pair can never exceed it either.
 */
const MAX_OUTPUT_BYTES = BUFFER.MAX_STRING_LENGTH;

/**
 * A caller-supplied duration on the kill path, REFUSED rather than clamped.
 *
 * `SandboxOptions` is built by an embedder — `runSandboxed` has no caller inside `src`,
 * so every value it ever sees comes from outside this package — and both durations were
 * unbounded. Refused on `cli.ts`'s argument at `positive`: there is no one safe direction
 * to clamp a duration in, and a silent clamp is the defect being fixed. Nothing real is
 * refused; 24.8 days is not a tool timeout, it is a unit slip.
 *
 * `min` differs per knob on purpose — see the two fields' docstrings for why zero is
 * coherent for grace and incoherent for the timeout.
 */
function boundedMs(v: unknown, where: string, min: 0 | 1): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > MAX_TIMER_MS) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `SandboxOptions.${where} must be a whole number of milliseconds from ${min} to ${MAX_TIMER_MS} (~24.8 days), not ` +
        `${typeof v === "number" ? String(v) : typeof v}. Node keeps a timer delay in 32 bits and truncates anything larger — ` +
        `and \`NaN\`, \`Infinity\` and every negative — to ONE MILLISECOND, so this would ${
          where === "timeoutMs"
            ? "kill the tool on its first tick while reporting the limit you asked for"
            : "send SIGKILL a millisecond after SIGTERM, which is no grace period at all"
        }.`,
    );
  }
  return v;
}

/**
 * The output cap, REFUSED and SNAPSHOTTED before the child exists.
 *
 * The sibling of `boundedMs`, and the last caller-supplied number in `SandboxOptions`
 * that had no bound. It is a different kind of hazard from a duration, which is why it
 * gets its own function rather than a `min`/`max` parameter on that one: an out-of-range
 * DELAY misfires, an out-of-range CAP is executed inside a `'data'` listener, where a
 * throw is an uncaught exception and the host is gone. Reproduced against this file
 * before the check existed, node v24.16.0:
 *
 *     maxOutputBytes: 2 ** 31, child writes 600 MiB
 *         → RangeError: Invalid string length, UNCAUGHT, host dead
 *     maxOutputBytes: {valueOf() { throw }}, child writes "hello"
 *         → Error: boom, UNCAUGHT on the first chunk, host dead
 *     maxOutputBytes: NaN       → cap disabled: 4 MiB captured, `truncated` FALSE
 *     maxOutputBytes: Infinity  → cap disabled: 4 MiB captured, `truncated` FALSE
 *     maxOutputBytes: -1        → everything discarded, `truncated` true
 *     maxOutputBytes: 1.5       → 1 byte kept
 *
 * `typeof` is what makes the hostile row safe, and it is load-bearing: `typeof` never
 * invokes `valueOf`, so a value that refuses to become a number is refused here without
 * being touched, and the message prints `typeof v` rather than the value. The number the
 * `'data'` listeners then close over is this function's RETURN — a primitive read once —
 * so a `valueOf` that answers differently on each call has one answer and no listener to
 * answer it in.
 *
 * NaN and Infinity are refused rather than read as "no limit" for the reason `timeoutMs`
 * refuses them: they are how "no limit" gets spelled, and what they actually bought was
 * an unbounded string in the host's heap fed by a process this module exists to contain.
 */
function boundedBytes(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_OUTPUT_BYTES) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `SandboxOptions.maxOutputBytes must be a whole number of bytes from 0 to ${MAX_OUTPUT_BYTES} (this V8's maximum string ` +
        `length), not ${typeof v === "number" ? String(v) : typeof v}. Captured output accumulates into a string, so a cap above ` +
        `that limit — or \`NaN\`/\`Infinity\`, which disable the cap entirely — ends as an uncaught \`RangeError: Invalid string ` +
        `length\` inside the 'data' listener, taking the host down with the tool it was containing.`,
    );
  }
  return v;
}

/**
 * The command, REFUSED and SNAPSHOTTED — because it is what three listeners quote.
 *
 * The number checks above are about a value that MISBEHAVES; this one is about a value
 * that is READ AGAIN. `spawn` already refuses every plain wrong value, loudly and
 * synchronously (`ERR_INVALID_ARG_TYPE` for a non-string, `ERR_INVALID_ARG_VALUE` for
 * `""`), so on its own that is a diagnosis in a platform's vocabulary rather than a hole.
 * The hole is that `spawn`'s refusal says nothing about the SECOND read, and there are
 * three of them, each inside a listener:
 *
 *     child.on("error")   `could not spawn "${opts.command}"`
 *     child.on("close")   `tool "${opts.command}" was cancelled`
 *     reportUncontained   `details.command`, and the message — from a `setTimeout`
 *
 * Measured with a getter that answers `spawn` and throws afterwards: an UNCAUGHT
 * exception in the `'error'` listener, which is the listener whose whole job is to turn a
 * failed spawn into a clean rejection. A `Proxy` and a record mutated between calls reach
 * the same place without ever throwing — the message then names a command that never ran.
 *
 * `typeof` is load-bearing here for the reason it is in `boundedBytes`: it never invokes
 * a `toString`, so a value that runs code when it is read is refused without being read.
 * The RETURN is what everything below closes over, so there is exactly one answer.
 */
function boundedCommand(v: unknown): string {
  if (typeof v !== "string" || v === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `SandboxOptions.command must be a non-empty string, not ${typeof v === "string" ? "the empty string" : typeof v}. It is read ` +
        `once here and then quoted by three listeners — the spawn-failure handler, the cancellation handler and the reap report — ` +
        `each of which runs from Node's event loop with no \`try\` above it, so a value that answers differently on a second read ` +
        `(a getter, a Proxy, a mutated record) is an uncaught exception on the path that exists to report a failure cleanly.`,
    );
  }
  return v;
}

/**
 * The stdin payload, REFUSED and SNAPSHOTTED — because it is read after `spawn`.
 *
 * Not a listener hazard: a containment one. `child.stdin.end(opts.stdin)` sits between the
 * `spawn` and the promise that arms `timeoutMs`, so a throw there abandons a running child
 * with no kill scheduled and no handle held — reproduced with a non-string payload, which
 * `Writable.end` refuses with `ERR_INVALID_ARG_TYPE`:
 *
 *     threw ERR_INVALID_ARG_TYPE; active handles: PipeWrap ×3, ProcessWrap
 *     the child was still running 1.8 s later
 *
 * `undefined` means "no input" and stays distinct from `""`, which means "an empty input,
 * then EOF" — `??` would collapse them, which is why it does not appear here. A `Buffer`
 * is refused with everything else: the field is typed `string`, and widening the accepted
 * set to whatever `end` happens to take is how a check stops matching the contract above
 * it.
 */
function boundedStdin(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `SandboxOptions.stdin must be a string, not ${v === null ? "null" : typeof v}. It is written to the child's pipe after the ` +
        `child exists, so a value the pipe refuses throws from between the spawn and the timer that would have killed it — ` +
        `leaving a process running that nothing holds a handle to. Encode bytes to a string before passing them.`,
    );
  }
  return v;
}

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
 * only when the sandbox itself could not be established (a path escape, a duration no
 * timer can hold, a spawn failure) or when the caller aborted.
 *
 * EVERY CALLER-SUPPLIED VALUE IS CHECKED BEFORE `spawn`, AND READ EXACTLY ONCE, and the
 * order is the point. It used to say NUMBER, which is what a sweep organised by "which of
 * these could be `NaN`" leaves behind; the property that matters is *when* a value is
 * read, not what type it is. Three reasons, and they are different failures:
 *
 *  - a DURATION refused after the child existed would have created a process while
 *    declining to arm the timer that kills it — strictly worse than the unbounded value;
 *  - the BYTE CAP is executed inside a `'data'` listener, where discovering it is bad
 *    means an uncaught exception;
 *  - `command` and `stdin` are read AGAIN after `spawn` — the first from three listeners,
 *    the second from between the child and its timer. A second read of someone else's
 *    record is a call into their code; the locals below are what everything closes over,
 *    so there is one answer per value for the life of the child.
 */
export async function runSandboxed(opts: SandboxOptions, signal: AbortSignal): Promise<SandboxResult> {
  if (signal.aborted) throw err.cancelled();

  const command = boundedCommand(opts.command);
  const timeoutMs = boundedMs(opts.timeoutMs, "timeoutMs", 1);
  const grace = boundedMs(opts.gracePeriodMs ?? DEFAULT_GRACE_MS, "gracePeriodMs", 0);
  const cwd = resolve(opts.cwd);
  const maxBytes = boundedBytes(opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT);
  const stdinText = boundedStdin(opts.stdin);
  const started = Date.now();

  const child = spawn(command, [...opts.args], {
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

  // ── every handle claimed BEFORE anything can fail ────────────────────────────
  //
  // The three PIPES are claimed here rather than inside the promise below, because the
  // first thing this function does after `spawn` is write to stdin — and a listener
  // attached after the write is a listener attached after the window it is for. The
  // child's own `'error'` is claimed in the promise, where the settle functions live;
  // that one cannot fire earlier than the next tick, so there is no window to lose.

  // Named rather than inline, so `release` below can take them off again. A listener that
  // cannot be removed is a listener that runs for as long as the pipe does, and one of
  // these pipes can outlive the promise it feeds — see `release`.
  const onStdout = (c: Buffer): void => capture(c, "out");
  const onStderr = (c: Buffer): void => capture(c, "err");
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);

  // A BROKEN STDIN IS NOT AN OUTCOME, which is why this one is deliberately swallowed —
  // and why it is the only one that is. It fails because the child went away: either the
  // child chose to stop reading (`cmd | head -1` is this exact shape and is not an error)
  // or we killed it, in which case the timeout or the cancellation IS the outcome and the
  // broken pipe is its consequence. Swallowing launders nothing: the child's own exit
  // code, stdout and stderr still decide the result, and the kill path still throws.
  //
  // Reproduced before this listener existed, with an 8 MiB `stdin` and a child that never
  // reads it, `timeoutMs: 200`:
  //
  //     node:events:487  throw er; // Unhandled 'error' event
  //     Error: write EPIPE … { errno: -32, code: 'EPIPE', syscall: 'write' }
  //
  // — the host process gone, from the one mechanism whose job is to contain a runaway
  // tool. The larger the payload the wider the window, because the write has to still be
  // pending when SIGKILL breaks the pipe.
  //
  // THE LIMIT, stated rather than hidden: a child that exits 0 having read only PART of
  // its input is reported as exit 0. That is what happened — this function reports the
  // process, not the tool's semantics — so a tool contract that cares must make the tool
  // attest to what it read.
  child.stdin.on("error", () => undefined);

  // A PIPE THAT FAILS MID-READ IS LOST OUTPUT, and `truncated` already means exactly
  // "the result is not the whole story". Recording it there is the difference between a
  // caller that knows it is holding a fragment and one that does not.
  const onPipeError = (): void => {
    truncated = true;
  };
  child.stdout.on("error", onPipeError);
  child.stderr.on("error", onPipeError);

  /**
   * Let go of the child's handles — WITHOUT claiming the child stopped.
   *
   * Settling the promise ends this function's interest in the child. On every ordinary
   * path that is already true of the handles too: `'close'` fires precisely because the
   * three pipes closed. On ONE path it is not, and it is the path that matters most —
   * `reportUncontained`, where the child survived SIGKILL or a grandchild kept the pipe.
   * There the promise was settled and `stdout`/`stderr` went on flowing into a `capture`
   * whose result nobody would ever read, on a process nothing can stop. Measured before
   * this existed, with a detached grandchild holding the pipe: the promise rejected at
   * 5253 ms and `process.getActiveResourcesInfo()` still reported a live `PipeWrap`
   * afterwards, which is a host that can never exit and a `'data'` wakeup per chunk
   * forever. The run was freed; the process kept paying.
   *
   * IT IS NOT A SECOND KILL AND MUST NOT READ AS ONE. Whether the child is running is
   * unknown here and stays unknown: `reportUncontained` still reports `contained: false`
   * and still raises the reason it was killing for. Closing our read end may well break
   * the child's next write, and that is a side effect, not a claim — an effect whose
   * outcome is unknown recorded as "did not happen" is the most expensive lie this system
   * can tell (01-INTERFACES.md D3.20).
   *
   * THE `'error'` LISTENERS STAY ATTACHED, and that is the whole care in this function.
   * Destroying a pipe is one of the moments one fires; removing them here would re-open
   * the uncaught-exception hole this module's docstring is about, at the exact instant
   * teardown makes it likeliest. Only the `'data'` listeners come off.
   */
  const release = (): void => {
    child.stdout.removeListener("data", onStdout);
    child.stderr.removeListener("data", onStderr);
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
    // The `ChildProcess` handle holds the loop open on its own, independently of the
    // pipes, for as long as the OS has not reaped the child.
    child.unref();
  };

  // Node emits `'spawn'` ONLY when the process actually started, and emits `'error'`
  // instead when it did not. It is therefore the one reliable separator between "the tool
  // never ran" and "the tool ran and we could not stop it" — see the `'error'` handler.
  let spawned = false;
  child.once("spawn", () => {
    spawned = true;
  });

  // `stdinText` and not `opts.stdin`: the snapshot, so this cannot be a second read that
  // answers differently — and so the type check that makes it safe already happened, above
  // the `spawn`. `!== undefined` rather than a falsy test, because `""` is an input.
  if (stdinText !== undefined) child.stdin.end(stdinText);
  else child.stdin.end();

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

    /** Why the child was last asked to die, so a containment failure names the reason. */
    let killing: "timeout" | "cancel" | undefined;

    /**
     * The last error a kill produced — KEPT AS A DETAIL, NEVER ACTED ON.
     *
     * The first draft of this fix failed the promise on any errno but `ESRCH`, reasoning
     * that ESRCH means "already reaped, which is what we asked for" and anything else
     * means the signal did not land. **That is measurably wrong on macOS.** XNU's
     * `killpg` answers EPERM, not ESRCH, when a process group has nothing signalable left
     * in it, so `gracePeriodMs: 0` — SIGTERM, then SIGKILL on the next tick, when the
     * child is a dying zombie — produces EPERM on every successful teardown. Measured on
     * node v24.16.0 / darwin 25.6.0, five rounds: `SIGKILL -> EPERM` with the child's
     * `'close'` arriving immediately after, every time.
     *
     * So a kill's errno is evidence of nothing, and a rule built on it is an alarm that
     * always fires. **`'close'` is the evidence** — see `reaper`. The errno is still worth
     * carrying, as a detail on the error the reaper raises.
     */
    let killError: NodeJS.ErrnoException | undefined;

    const kill = (sig: NodeJS.Signals): void => {
      try {
        // Negative pid targets the process group, so a tool's own children die too.
        if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (e) {
        killError = e as NodeJS.ErrnoException;
      }
    };

    /**
     * THE CHILD OUTLIVED SIGKILL. Report the reason we were killing, and say it is loose.
     *
     * Two real shapes reach this: a signal the OS genuinely refused, and a grandchild that
     * called `setsid`, leaving the group we killed but keeping the stdout pipe open — the
     * child is dead, `'close'` never arrives, and without this the promise NEVER SETTLES
     * and the worker is parked forever by exactly the tool the timeout exists to contain.
     * Both were previously invisible: the errno went into a bare `catch {}` commented
     * "already gone; nothing to do", which is a confinement failure reporting itself as a
     * success.
     *
     * `contained: false` is the part a caller cannot learn any other way. The error CLASS
     * stays the reason we were killing, and is never a spawn failure: about a process that
     * has already run for `timeoutMs`, `E_TOOL_SOURCE_UNAVAILABLE "could not spawn"` reads
     * as **DID NOT HAPPEN**, and an effect whose outcome is unknown recorded as
     * never-started is the single most expensive lie this system can tell
     * (01-INTERFACES.md D3.20; 03-RUNTIME.md D4 deviation 1 records it as UNKNOWN).
     *
     * SETTLING IS HALF OF IT. `fail` frees the *run*; `cleanup`'s `release` frees the
     * *host*, which for a long time it did not — the pipes went on flowing into a capture
     * nobody would read, holding the event loop open on a process nothing can stop. Both
     * halves are needed and neither is a claim about the child: this path's whole content
     * is that we do not know what the child is doing. See `release`.
     */
    const reportUncontained = (): void => {
      const details = {
        command,
        pid: child.pid,
        contained: false,
        ...(killError === undefined ? {} : { killErrno: killError.code, killSyscall: killError.syscall }),
      };
      const tail =
        `SIGKILL was sent ${REAP_DEADLINE_MS}ms ago and pid ${String(child.pid)} has not been reaped` +
        `${killError === undefined ? "" : ` (the last signal answered ${String(killError.code)})`} — it may still be running.`;
      if (killing === "cancel") fail(err.cancelled(`tool "${command}" was cancelled, but ${tail}`, { details }));
      else fail(err.timeout(CODES.E_TOOL_TIMEOUT, `"${command}" exceeded ${timeoutMs}ms, but ${tail}`, { details }));
    };

    /**
     * Arm SIGKILL, and then the check that it worked — replacing anything already pending.
     *
     * The replacement is not tidiness. An abort arriving after the timeout used to
     * OVERWRITE the grace field without clearing the old timer, so `cleanup` cleared only
     * the second: the orphan kept the loop alive for `gracePeriodMs` past the settled
     * promise and then signalled a process-group id whose child had long since been reaped
     * — a stale pgid the OS is free to have recycled.
     */
    let graceTimer: NodeJS.Timeout | undefined;
    let reaper: NodeJS.Timeout | undefined;
    const armGrace = (): void => {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        kill("SIGKILL");
        if (reaper !== undefined) clearTimeout(reaper);
        reaper = setTimeout(reportUncontained, REAP_DEADLINE_MS);
      }, grace);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killing = "timeout";
      kill("SIGTERM");
      // Grace, then force. A process that ignores SIGTERM does not get to hold a slot.
      armGrace();
    }, timeoutMs);

    const onAbort = (): void => {
      timedOut = false;
      killing = "cancel";
      kill("SIGTERM");
      armGrace();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    // Timers, the abort listener AND the child's handles. `release` is here rather than
    // only in `reportUncontained` on purpose: the invariant is "the promise is settled, so
    // nothing this function holds is read again", which is a property of settling and not
    // of one settle path. On the ordinary paths it is a no-op over already-closed pipes;
    // the uncontained path is merely the one where the no-op is not one.
    const cleanup = (): void => {
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (reaper !== undefined) clearTimeout(reaper);
      signal.removeEventListener("abort", onAbort);
      release();
    };

    child.on("error", (e: NodeJS.ErrnoException) => {
      // PRE-SPAWN vs POST-SPAWN, and the distinction is the whole point of the `'spawn'`
      // listener above. Only the first is a spawn failure. The second is a kill Node chose
      // to EMIT rather than throw — `ChildProcess.kill` emits EPERM and throws EINVAL — so
      // it joins the thrown ones, is evidence of nothing on its own, and is left for
      // `reaper` to adjudicate. This branch used to answer "could not spawn" for BOTH.
      if (!spawned) {
        fail(err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, `could not spawn "${command}": ${e.message}`, { cause: e }));
        return;
      }
      killError = e;
    });
    child.on("close", (code, sig) => {
      if (signal.aborted) {
        fail(err.cancelled(`tool "${command}" was cancelled`));
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
    // `timeoutMs` and not `opts.timeoutMs`: the message must quote the limit that FIRED,
    // not the one that was asked for. They were the same number and different durations
    // for as long as the value was unbounded, and `"… exceeded 2147483648ms"` arriving
    // 3 ms after the call was the clearest statement of the bug anywhere in the process.
    throw err.timeout(CODES.E_TOOL_TIMEOUT, `"${command}" exceeded ${timeoutMs}ms`, {
      details: { command, stdout: result.stdout.slice(0, 500), stderr: result.stderr.slice(0, 500) },
    });
  }
  return result;
}
