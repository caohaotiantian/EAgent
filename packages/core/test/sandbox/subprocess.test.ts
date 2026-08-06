import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CODES } from "../../src/errors.ts";
import { assertWithin, buildEnv, isWithin, runSandboxed } from "../../src/sandbox/subprocess.ts";

const ac = (): AbortSignal => new AbortController().signal;
const NODE = process.execPath;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function jail(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-jail-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── path jail ────────────────────────────────────────────────────────────────

test("assertWithin resolves relative paths inside the root", () => {
  assert.equal(assertWithin("/jail", "a/b.txt"), "/jail/a/b.txt");
  assert.equal(assertWithin("/jail", "./x"), "/jail/x");
  assert.equal(assertWithin("/jail", "a/../b"), "/jail/b");
});

test("assertWithin rejects traversal and absolute escapes", () => {
  for (const bad of ["../secrets", "a/../../etc/passwd", "/etc/passwd"]) {
    assert.throws(() => assertWithin("/jail", bad), /escapes the sandbox root/, bad);
  }
});

test("the jail check is not a startsWith prefix test", () => {
  // `"/jail-evil".startsWith("/jail")` is true, which is why `path.relative` is used
  // instead. This is the classic sibling-directory escape.
  assert.equal(isWithin("/jail", "/jail-evil/x"), false);
  assert.equal(isWithin("/jail", "/jailX"), false);
  assert.equal(isWithin("/jail", "sub/ok"), true);
});

test("the root itself is inside the root", () => {
  assert.equal(isWithin("/jail", "."), true);
});

// ── environment ──────────────────────────────────────────────────────────────

test("env is an allowlist — nothing leaks by default", () => {
  process.env["LOOM_TEST_SECRET"] = "super-secret";
  try {
    const env = buildEnv(undefined);
    assert.equal(env["LOOM_TEST_SECRET"], undefined, "an unlisted variable is absent, not empty");
    assert.ok("PATH" in env, "only the minimum a child needs to run");
  } finally {
    delete process.env["LOOM_TEST_SECRET"];
  }
});

test("explicitly-passed values win and do not require an allowlist entry", () => {
  const env = buildEnv([], { TOKEN: "resolved-at-the-boundary" });
  assert.equal(env["TOKEN"], "resolved-at-the-boundary");
});

test("an allowlisted variable is passed through", () => {
  process.env["LOOM_TEST_OK"] = "yes";
  try {
    assert.equal(buildEnv(["LOOM_TEST_OK"])["LOOM_TEST_OK"], "yes");
  } finally {
    delete process.env["LOOM_TEST_OK"];
  }
});

// ── execution ────────────────────────────────────────────────────────────────

test("a command runs and its output is captured", async () => {
  const j = jail();
  try {
    const r = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdout.write('hi'); process.stderr.write('warn')"], cwd: j.dir, timeoutMs: 10_000 },
      ac(),
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "hi");
    assert.equal(r.stderr, "warn");
    assert.equal(r.truncated, false);
    assert.equal(r.timedOut, false);
  } finally {
    j.dispose();
  }
});

test("a non-zero exit is a RESULT, not an exception", async () => {
  const j = jail();
  try {
    const r = await runSandboxed({ command: NODE, args: ["-e", "process.exit(3)"], cwd: j.dir, timeoutMs: 10_000 }, ac());
    assert.equal(r.code, 3, "the tool failing is the tool's business; the sandbox worked");
  } finally {
    j.dispose();
  }
});

test("the child starts in the jail, not in the engine's cwd", async () => {
  const j = jail();
  try {
    const r = await runSandboxed({ command: NODE, args: ["-e", "process.stdout.write(process.cwd())"], cwd: j.dir, timeoutMs: 10_000 }, ac());
    // macOS reports /private/var for /var, so compare the resolved tail.
    assert.ok(r.stdout.endsWith(j.dir.replace(/^\/private/, "")) || r.stdout === j.dir, r.stdout);
  } finally {
    j.dispose();
  }
});

test("arguments are passed as an array — shell metacharacters are inert", async () => {
  const j = jail();
  writeFileSync(join(j.dir, "canary.txt"), "still here");
  try {
    // With `shell: true` this would delete the canary. As an argv element it is just
    // a weird string the program receives.
    const r = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdout.write(process.argv[1] ?? '')", "; rm -rf ."], cwd: j.dir, timeoutMs: 10_000 },
      ac(),
    );
    assert.equal(r.stdout, "; rm -rf .");
    assert.equal(readOr(join(j.dir, "canary.txt")), "still here");
  } finally {
    j.dispose();
  }
});

test("output beyond the cap is truncated and FLAGGED", async () => {
  const j = jail();
  try {
    const r = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdout.write('x'.repeat(50000))"], cwd: j.dir, timeoutMs: 10_000, maxOutputBytes: 100 },
      ac(),
    );
    assert.equal(r.stdout.length, 100);
    assert.equal(r.truncated, true, "a caller must be able to tell it is not seeing everything");
  } finally {
    j.dispose();
  }
});

test("a hung process is killed and reported as a timeout", async () => {
  const j = jail();
  try {
    await assert.rejects(
      () =>
        runSandboxed(
          { command: NODE, args: ["-e", "setInterval(() => {}, 1000)"], cwd: j.dir, timeoutMs: 150, gracePeriodMs: 50 },
          ac(),
        ),
      (e: unknown) => (e as { code: string }).code === "E_TOOL_TIMEOUT",
    );
  } finally {
    j.dispose();
  }
});

test("a process that IGNORES SIGTERM is still killed", async () => {
  const j = jail();
  try {
    const started = Date.now();
    await assert.rejects(
      () =>
        runSandboxed(
          {
            command: NODE,
            args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
            cwd: j.dir,
            timeoutMs: 150,
            gracePeriodMs: 100,
          },
          ac(),
        ),
      // `assert.rejects` matches the MESSAGE, not the code — check the code directly.
      (e: unknown) => (e as { code: string }).code === "E_TOOL_TIMEOUT",
    );
    // Grace expired, then SIGKILL. It must not hold the slot indefinitely.
    assert.ok(Date.now() - started < 5000, "SIGKILL followed the grace period");
  } finally {
    j.dispose();
  }
});

test("aborting cancels the child", async () => {
  const j = jail();
  const controller = new AbortController();
  try {
    const p = runSandboxed(
      { command: NODE, args: ["-e", "setInterval(() => {}, 1000)"], cwd: j.dir, timeoutMs: 30_000, gracePeriodMs: 50 },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(() => p, /E_CANCELLED|cancelled/);
  } finally {
    j.dispose();
  }
});

test("an already-aborted signal never spawns anything", async () => {
  const j = jail();
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      () => runSandboxed({ command: NODE, args: ["-e", "process.exit(0)"], cwd: j.dir, timeoutMs: 1000 }, controller.signal),
      /E_CANCELLED|aborted/,
    );
  } finally {
    j.dispose();
  }
});

test("a missing executable is a clean unavailable error, not a crash", async () => {
  const j = jail();
  try {
    await assert.rejects(
      () => runSandboxed({ command: "definitely-not-a-real-binary-xyz", args: [], cwd: j.dir, timeoutMs: 1000 }, ac()),
      /could not spawn/,
    );
  } finally {
    j.dispose();
  }
});

test("THE KILL PATH'S OWN TIMERS ARE BOUNDED — an unbounded one disarms the kill it schedules", async () => {
  // `SandboxOptions.timeoutMs` and `.gracePeriodMs` are on the pinned public surface and
  // reached `setTimeout` with no bound. This is the KILL PATH — SIGTERM → grace → SIGKILL
  // on the process group — so above the ceiling both become their own opposite, and the
  // error is again its own counterexample. Reproduced before the refusal landed, against a
  // child that never exits (`setInterval(()=>{},1000)`):
  //
  //     timeoutMs: 2**31         → E_TOOL_TIMEOUT `… exceeded 2147483648ms`, thrown 3 ms
  //                                after the call. A tool given 24.8 days got 1 ms.
  //     timeoutMs: 86400000000   → the same, at 2 ms. This is the slip that really happens:
  //                                a day, written in microseconds.
  //     timeoutMs: 0             → `… exceeded 0ms` at 2 ms. `0` is how "no limit" gets
  //                                spelled, and it means "kill immediately".
  //     timeoutMs: NaN/Infinity  → `… exceeded NaNms` / `… exceeded Infinityms`, both at
  //                                2 ms. `Infinity` is the OTHER way "no limit" is spelled.
  //     gracePeriodMs: 2**31     → SIGKILL 1 ms after SIGTERM. A process asked to shut down
  //                                orderly over 24.8 days gets no grace at all.
  //
  // REFUSED BEFORE `spawn`, not after: a refusal that fires once the child exists has
  // already created the thing it cannot promise to kill.
  const j = jail();
  try {
    const bad: readonly [string, Record<string, unknown>][] = [
      ["timeoutMs above the ceiling", { timeoutMs: 2 ** 31 }],
      ["timeoutMs as a day in microseconds", { timeoutMs: 86_400_000_000 }],
      ["timeoutMs 0 — 'no limit', spelled as 'no time'", { timeoutMs: 0 }],
      ["timeoutMs Infinity — 'no limit', spelled the other way", { timeoutMs: Infinity }],
      ["timeoutMs NaN", { timeoutMs: NaN }],
      ["timeoutMs negative", { timeoutMs: -1 }],
      ["timeoutMs fractional", { timeoutMs: 1.5 }],
      ["gracePeriodMs above the ceiling", { timeoutMs: 1000, gracePeriodMs: 2 ** 31 }],
      ["gracePeriodMs negative", { timeoutMs: 1000, gracePeriodMs: -1 }],
      ["gracePeriodMs Infinity", { timeoutMs: 1000, gracePeriodMs: Infinity }],
    ];
    for (const [what, opts] of bad) {
      await assert.rejects(
        () => runSandboxed({ command: NODE, args: ["-e", "setInterval(()=>{},1000)"], cwd: j.dir, ...opts } as never, ac()),
        (e: unknown) => (e as { code: string }).code === CODES.E_CONFIG_INVALID,
        what,
      );
    }
    // NOTHING WAS SPAWNED — asserted by ORDERING rather than by counting processes, which
    // would be a wall-clock race. A command that cannot be spawned at all, plus a timeout
    // that cannot be held: whichever check runs first names the error. `E_CONFIG_INVALID`
    // proves the refusal precedes `spawn`; `could not spawn` would prove it does not, and
    // a refusal that fires after the child exists has already created the process it
    // cannot promise to kill.
    await assert.rejects(
      () => runSandboxed({ command: "definitely-not-a-real-binary-xyz", args: [], cwd: j.dir, timeoutMs: 2 ** 31 }, ac()),
      (e: unknown) => (e as { code: string }).code === CODES.E_CONFIG_INVALID,
      "the duration is refused BEFORE the spawn is attempted",
    );

    // The boundary values on both knobs stay legal, so this is a ceiling and not an
    // off-by-one that refuses a working configuration. `gracePeriodMs: 0` is a real
    // choice — "no grace, SIGKILL on the next tick" — which is why 0 is refused on
    // `timeoutMs` and allowed here: "run for no time" has no coherent reading and "give
    // no grace" does.
    const r = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdout.write('ok')"], cwd: j.dir, timeoutMs: 2 ** 31 - 1, gracePeriodMs: 0 },
      ac(),
    );
    assert.equal(r.stdout, "ok", "the largest delay a timer CAN hold, and a zero grace, are both legal");
  } finally {
    j.dispose();
  }
});

test("THE OUTPUT CAP IS BOUNDED TOO — an unbounded one turns the 'data' listener into an uncaught exception", async () => {
  // `maxOutputBytes` was the ONE caller-supplied number in `SandboxOptions` left unbounded
  // when the durations were fixed, and it is the worst place for one: the durations misfire
  // a timer, this is read inside a `'data'` listener, which is a call from Node's event
  // loop with no `try` above the frame. Reproduced against this file, node v24.16.0:
  //
  //   maxOutputBytes: 2 ** 31, child writes 600 MiB
  //       → RangeError: Invalid string length, UNCAUGHT — host dead. 2 GiB is an ordinary
  //         "plenty of headroom" number and it is ~4x V8's max string length (536 870 888).
  //   maxOutputBytes: {valueOf() { throw }}
  //       → Error: boom, UNCAUGHT on the FIRST CHUNK — host dead. `outBytes >= maxBytes`
  //         is a coercion, and a coercion is a call.
  //   maxOutputBytes: NaN / Infinity
  //       → cap DISABLED. 4 MiB captured against a 1 MiB default, `truncated` reported
  //         FALSE — the flag says "you are looking at all of it" while the bound on the
  //         host's heap is gone. These are how "no limit" gets spelled.
  //   maxOutputBytes: -1 / 0  → everything discarded, `truncated` true.
  //   maxOutputBytes: 1.5     → one byte kept.
  //
  // `typeof` is what makes the hostile row safe and it is load-bearing: `typeof` never
  // invokes `valueOf`, so the refusal never touches the value, and the primitive it returns
  // is what the listeners close over — one read, no second answer.
  const j = jail();
  try {
    const hostile = {
      valueOf(): number {
        throw new Error("a cap that runs code when compared");
      },
    };
    const bad: readonly [string, unknown][] = [
      ["2 GiB — above V8's max string length", 2 ** 31],
      ["Infinity — 'no cap', spelled one way", Infinity],
      ["NaN — 'no cap', spelled the other way", NaN],
      ["negative", -1],
      ["fractional", 1.5],
      ["a string", "4096"],
      ["an object whose valueOf throws", hostile],
      ["a symbol", Symbol("cap")],
    ];
    for (const [what, v] of bad) {
      await assert.rejects(
        () =>
          runSandboxed(
            { command: NODE, args: ["-e", "process.stdout.write('x')"], cwd: j.dir, timeoutMs: 10_000, maxOutputBytes: v } as never,
            ac(),
          ),
        (e: unknown) => (e as { code: string }).code === CODES.E_CONFIG_INVALID,
        what,
      );
    }

    // REFUSED BEFORE `spawn`, asserted by ordering exactly as the durations are: a command
    // that cannot spawn AND a cap that cannot be held, and whichever check runs first names
    // the error. After `spawn` the only place left to find a bad cap is the listener.
    await assert.rejects(
      () => runSandboxed({ command: "definitely-not-a-real-binary-xyz", args: [], cwd: j.dir, timeoutMs: 1000, maxOutputBytes: NaN }, ac()),
      (e: unknown) => (e as { code: string }).code === CODES.E_CONFIG_INVALID,
      "the cap is refused BEFORE the spawn is attempted",
    );

    // `0` stays legal — "capture nothing, tell me it was truncated" is a coherent ask for a
    // tool whose exit code is the whole answer, the same way `gracePeriodMs: 0` is. This is
    // a ceiling, not a narrowing.
    const zero = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdout.write('noise')"], cwd: j.dir, timeoutMs: 10_000, maxOutputBytes: 0 },
      ac(),
    );
    assert.equal(zero.stdout, "", "0 means capture nothing");
    assert.equal(zero.truncated, true, "and say so");
    assert.equal(zero.code, 0, "the tool still ran");
  } finally {
    j.dispose();
  }
});

test("THE COMMAND IS SNAPSHOTTED TOO — THREE listeners read it, and a listener is not a place to find a bad value", async () => {
  // The module docstring said "anything a listener touches is validated and SNAPSHOTTED
  // into a primitive before the child exists … so the listeners below hold only
  // primitives", and `opts.command` was a counterexample sitting in the same file. It is
  // read from THREE listeners — the child's `'error'` handler, the `'close'` handler's
  // cancelled arm, and `reportUncontained`, which runs from a `setTimeout` — and it was
  // never read into a `const`, so every one of those was a property access on a record
  // built outside this package, in a frame with no `try` above it.
  //
  // Reproduced against this file before the check existed, node v24.16.0, with a `command`
  // that answers `spawn` and throws on the next read — the same shape as `boundedBytes`'s
  // `{valueOf() { throw }}` row, one field over:
  //
  //   get command() { return reads++ ? THROW : "/nonexistent" }   spawn emits ENOENT
  //       → UNCAUGHT EXCEPTION "command read #2 from a listener" — host dead, from the
  //         `'error'` handler that exists to report a spawn failure cleanly.
  //   the same getter, a real binary, aborted mid-run
  //       → UNCAUGHT in the `'close'` handler's cancelled arm. Cancellation is the ordinary
  //         path, not an exotic one.
  //
  // A PLAIN wrong value was already loud and is now loud in this module's own vocabulary:
  // `spawn` threw `ERR_INVALID_ARG_TYPE`/`ERR_INVALID_ARG_VALUE` — a raw platform error
  // with no `E_CONFIG_INVALID`, no `details`, and none of this file's contract.
  const j = jail();
  try {
    const bad: readonly [string, unknown][] = [
      ["a number", 42],
      ["null", null],
      ["undefined", undefined],
      ["the empty string — `spawn` calls this ERR_INVALID_ARG_VALUE", ""],
      ["an object", {}],
      ["an object whose toString throws", { toString: () => { throw new Error("boom"); } }],
    ];
    for (const [what, v] of bad) {
      await assert.rejects(
        () => runSandboxed({ command: v as string, args: [], cwd: j.dir, timeoutMs: 10_000 }, ac()),
        (e: unknown) => (e as { code: string }).code === CODES.E_CONFIG_INVALID,
        what,
      );
    }

    // THE ASSERTION IS THAT THE HOST IS STILL HERE. An uncaught exception is not catchable
    // by `assert.rejects`; the runner attributes it to whichever test was running, which is
    // this one. Without the snapshot the second read happens inside the `'error'` listener
    // and nothing below this line runs.
    let reads = 0;
    const twoFaced = {
      get command(): string {
        reads++;
        if (reads > 1) throw new Error(`command read #${reads} — from a listener`);
        return "definitely-not-a-real-binary-xyz";
      },
      args: [] as readonly string[],
      cwd: j.dir,
      timeoutMs: 10_000,
    };
    await assert.rejects(
      () => runSandboxed(twoFaced, ac()),
      (e: unknown) => (e as { code: string }).code === CODES.E_TOOL_SOURCE_UNAVAILABLE,
      "a spawn failure is still reported as one",
    );
    assert.equal(reads, 1, "ONE read, before the child exists — the listeners hold the primitive it returned");

    const after = await runSandboxed({ command: NODE, args: ["-e", "process.stdout.write('alive')"], cwd: j.dir, timeoutMs: 10_000 }, ac());
    assert.equal(after.stdout, "alive", "the host survived a command that runs code when it is read");
  } finally {
    j.dispose();
  }
});

test("A THROW BETWEEN `spawn` AND THE PROMISE ORPHANS THE CHILD — so `stdin` is checked before there is one", async () => {
  // The other half of "checked before `spawn`", and it is about CONTAINMENT rather than
  // about the host. `child.stdin.end(opts.stdin)` ran AFTER the child existed and typed
  // nothing: a non-string `stdin` threw `ERR_INVALID_ARG_TYPE` out of `runSandboxed` from
  // between the `spawn` and the promise that owns the timers. So the child was started, no
  // `timeoutMs` timer was ever armed, no kill could ever fire, and nothing anywhere said a
  // process had been abandoned — in the one module whose job is that this cannot happen.
  //
  // Reproduced before the check existed, node v24.16.0, with a child that lives 1.5 s:
  //
  //   threw ERR_INVALID_ARG_TYPE ("chunk" must be string|Buffer|TypedArray|DataView)
  //   active handles after: PipeWrap,PipeWrap,PipeWrap,ProcessWrap
  //   still here at t+1800ms
  //
  // The caller was told loudly; the CHILD was not contained, which is the quiet half.
  const handles = (): number => process.getActiveResourcesInfo().filter((r) => r === "PipeWrap" || r === "ProcessWrap").length;
  const j = jail();
  try {
    const base = handles();
    for (const v of [12345, {}, Buffer.from("bytes"), null]) {
      await assert.rejects(
        () =>
          runSandboxed(
            { command: NODE, args: ["-e", "setTimeout(() => {}, 1500)"], cwd: j.dir, timeoutMs: 10_000, stdin: v as string },
            ac(),
          ),
        (e: unknown) => (e as { code: string }).code === CODES.E_CONFIG_INVALID,
        String(v),
      );
    }
    // NO CHILD WAS EVER STARTED. Before the check this was `base + 4` per refusal, and they
    // did not go away: nothing held a handle to the child, so nothing could kill it.
    assert.equal(handles(), base, "a refused `stdin` leaves no process and no pipes behind");

    // A string is still delivered, and so is the empty string, which is a value and not an
    // absence — `?? ` would collapse them and does not appear here.
    const r = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdin.on('data', (d) => process.stdout.write('got:' + d))"], cwd: j.dir, timeoutMs: 10_000, stdin: "hi" },
      ac(),
    );
    assert.equal(r.stdout, "got:hi");
  } finally {
    j.dispose();
  }
});

test("A CHILD THAT OUTLIVES SIGKILL IS REPORTED AS UNKNOWN — and the host lets go of its pipes", async () => {
  // The only path that reaches `reportUncontained`, and nothing drove it before: the child
  // spawns a DETACHED grandchild that inherits stdout. `process.kill(-pid)` reaches the
  // child's process group and the grandchild is in its own session, so it survives and
  // holds the write end of the pipe open — which means the `ChildProcess` `'close'` event,
  // which waits for stdio, NEVER ARRIVES. Without the reap deadline the promise never
  // settles and the worker is parked forever by exactly the tool `timeoutMs` exists to
  // contain.
  //
  // TWO THINGS ARE ASSERTED AND THEY PULL IN OPPOSITE DIRECTIONS.
  //
  //  1. The report stays UNKNOWN. `contained: false`, and the class is still the reason we
  //     were killing — never a spawn failure. An effect whose outcome we cannot determine,
  //     recorded as "did not happen", is the most expensive lie available here.
  //  2. The HOST stops paying. Settling freed the run; it did not free the handles. The
  //     pipes went on flowing into a capture nobody would read, on a process nothing can
  //     stop, holding the event loop open — measured before the fix, the promise rejected
  //     at 5253 ms and a live `PipeWrap` was still there afterwards, indefinitely.
  //
  // Releasing must not become a claim under (1): closing our read end may break the
  // child's next write, but that is a side effect and this test asserts nothing about it.
  //
  // COST: ~5.3 s, because `REAP_DEADLINE_MS` is 5 s and is deliberately not a knob. It is
  // the price of the only shape that reaches this path at all.
  const pipes = (): number => process.getActiveResourcesInfo().filter((r) => r === "PipeWrap").length;
  const grandchild =
    "setInterval(() => process.stdout.write('x'.repeat(4096)), 5); setTimeout(() => process.exit(0), 30000);";
  const body =
    `const { spawn } = require('node:child_process');` +
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });` +
    `setInterval(() => {}, 1000);`;

  const j = jail();
  const base = pipes();
  try {
    const p = runSandboxed({ command: NODE, args: ["-e", body], cwd: j.dir, timeoutMs: 200, gracePeriodMs: 50 }, ac());
    // THE INSTRUMENT PROVES ITSELF FIRST. `getActiveResourcesInfo` is experimental, and a
    // delta that is always zero because the API stopped saying `PipeWrap` would pass this
    // test while measuring nothing. The child's three pipes must be visible here or the
    // assertion below means nothing.
    await sleep(120);
    assert.ok(pipes() > base, `the child's pipes are visible to the instrument (base ${base}, during ${pipes()})`);

    await assert.rejects(
      () => p,
      (e: unknown) => {
        const le = e as { code: string; message: string; details?: { contained?: boolean; pid?: number } };
        assert.equal(le.code, CODES.E_TOOL_TIMEOUT, `the reason we were killing, not a spawn failure: ${le.message}`);
        assert.equal(le.details?.contained, false, "the one fact a caller cannot learn any other way");
        assert.match(le.message, /has not been reaped/, le.message);
        assert.match(le.message, /may still be running/, "UNKNOWN, not 'did not happen'");
        return true;
      },
    );

    // `destroy()` closes on the following ticks, so the handles are gone shortly after the
    // promise, not with it.
    await sleep(250);
    assert.equal(pipes(), base, "the host released the child's pipes; before the fix this stayed above the baseline forever");
  } finally {
    j.dispose();
  }
});

test("stdin is delivered and then closed", async () => {
  const j = jail();
  try {
    const r = await runSandboxed(
      {
        command: NODE,
        args: ["-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()))"],
        cwd: j.dir,
        timeoutMs: 10_000,
        stdin: "hello",
      },
      ac(),
    );
    assert.equal(r.stdout, "HELLO", "a child that reads stdin must see EOF, or it hangs");
  } finally {
    j.dispose();
  }
});

test("KILLING A RUNAWAY TOOL DOES NOT KILL THE HOST — a pending stdin write breaks as EPIPE", async () => {
  // THE CONFINEMENT PATH WAS THE PATH THAT TOOK THE ORCHESTRATOR DOWN. `child.stdin.end()`
  // had no `'error'` listener, and Node turns an `'error'` on an emitter with none into an
  // UNCAUGHT EXCEPTION. A tool that hangs is precisely what `timeoutMs` exists for, so
  // SIGTERM → grace → SIGKILL broke the pipe with the write still pending:
  //
  //     node:events:487  throw er; // Unhandled 'error' event
  //     Error: write EPIPE … { errno: -32, code: 'EPIPE', syscall: 'write' }
  //
  // — the host process, every in-flight run and every open gate's return path, gone. The
  // payload has to be big enough that the write is still in flight when the pipe breaks;
  // 8 MiB is two orders of magnitude past any pipe buffer, so the window is the whole kill.
  //
  // An uncaught exception is not catchable by `assert.rejects`. Reverting the one-line
  // listener turns this test and the next one red with that exact stack attributed to
  // them, which is the runner being kind: outside a test runner there is nothing above
  // this to attribute anything to, and the process simply ends — measured, the promise
  // never settles and nothing after the call runs.
  const j = jail();
  try {
    await assert.rejects(
      () =>
        runSandboxed(
          {
            command: NODE,
            args: ["-e", "setInterval(() => {}, 1000)"], // never reads stdin, never exits
            cwd: j.dir,
            timeoutMs: 150,
            gracePeriodMs: 0,
            stdin: "x".repeat(8 * 1024 * 1024),
          },
          ac(),
        ),
      (e: unknown) => (e as { code: string }).code === CODES.E_TOOL_TIMEOUT,
      "the tool is reported as timed out, not as a crash and not as a spawn failure",
    );
    // The host is still here, and still works. This line is the assertion.
    const after = await runSandboxed({ command: NODE, args: ["-e", "process.stdout.write('alive')"], cwd: j.dir, timeoutMs: 10_000 }, ac());
    assert.equal(after.stdout, "alive");
  } finally {
    j.dispose();
  }
});

test("A CHILD THAT EXITS WITHOUT READING ITS INPUT IS A RESULT, not an error — `cmd | head -1`", async () => {
  // The same broken pipe, reached without any kill at all: the child simply stops reading.
  // This is why the stdin listener SWALLOWS rather than fails — refusing here would break
  // a shape that is not an error in any shell — and it is also the limit that swallowing
  // leaves behind: the child exits 0 having read a fraction of its input, and 0 is what is
  // reported, because that is what the process did.
  const j = jail();
  try {
    const r = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdout.write('done')"], cwd: j.dir, timeoutMs: 10_000, stdin: "y".repeat(8 * 1024 * 1024) },
      ac(),
    );
    assert.equal(r.code, 0, "the child's own exit is the outcome");
    assert.equal(r.stdout, "done");
    assert.equal(r.timedOut, false);
  } finally {
    j.dispose();
  }
});

test("A KILL'S ERRNO IS NOT EVIDENCE — a clean `gracePeriodMs: 0` teardown answers EPERM on macOS", async () => {
  // This test exists because the first draft of the fix above got it wrong in the other
  // direction: it failed the promise on any errno but ESRCH, reasoning that ESRCH means
  // "already reaped" and everything else means the signal did not land.
  //
  // XNU's `killpg` answers **EPERM**, not ESRCH, when a process group has nothing
  // signalable left in it. With `gracePeriodMs: 0` the SIGKILL lands one tick after the
  // SIGTERM, when the child is a dying zombie, so EPERM is the answer on EVERY successful
  // teardown. Measured, node v24.16.0 / darwin 25.6.0, instrumenting `process.kill`:
  //
  //     process.kill( -34185 , SIGTERM ) -> ok
  //     process.kill( -34185 , SIGKILL ) -> EPERM
  //
  // and the child's `'close'` arrived immediately after, every one of five rounds. A rule
  // built on the errno is therefore an alarm that always fires. `'close'` is the evidence,
  // and a child that outlives SIGKILL is caught by the reap deadline instead.
  const j = jail();
  try {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        () =>
          runSandboxed(
            { command: NODE, args: ["-e", "setInterval(() => {}, 1000)"], cwd: j.dir, timeoutMs: 100, gracePeriodMs: 0 },
            ac(),
          ),
        (e: unknown) => {
          const le = e as { code: string; message: string; details?: { contained?: boolean } };
          assert.equal(le.code, CODES.E_TOOL_TIMEOUT, le.message);
          assert.equal(le.details?.contained, undefined, `a reaped child must not be reported uncontained: ${le.message}`);
          return true;
        },
        `round ${i}`,
      );
    }
  } finally {
    j.dispose();
  }
});

test("the child cannot see the engine's environment secrets", async () => {
  const j = jail();
  process.env["LOOM_LEAK_CHECK"] = "leaked";
  try {
    const r = await runSandboxed(
      { command: NODE, args: ["-e", "process.stdout.write(String(process.env.LOOM_LEAK_CHECK))"], cwd: j.dir, timeoutMs: 10_000 },
      ac(),
    );
    assert.equal(r.stdout, "undefined", "secret injection must never reach a tool it was not given to");
  } finally {
    delete process.env["LOOM_LEAK_CHECK"];
    j.dispose();
  }
});

function readOr(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "(missing)";
  }
}
