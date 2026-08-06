/**
 * The control plane, over real HTTP on an ephemeral port.
 *
 * No mocks: these bind a socket and speak the protocol, because the two contracts
 * being tested — what is durable at ACK, and gap-free reconnect — are protocol
 * properties, not function-call properties.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";

import {
  BearerTokenIdentity,
  ControlPlane,
  UNIDENTIFIED_SUBJECT,
  startControlPlane,
  unanswerableGraphs,
  type AuthContext,
  type ControlPlaneOptions,
  type IdentityRequest,
  type IdentitySource,
} from "../../src/server/http.ts";
import { CODES, LoomError, isLoomError } from "../../src/errors.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { CONSOLE_HTML } from "../../src/server/console.ts";
import { ConsoleChannel, GateDispatcher, SignedWebhookChannel, type DeliveryChannel } from "../../src/run/delivery.ts";
import type { Actor, HumanActor, JournalEvent } from "../../src/journal/events.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { GateId, RunId } from "../../src/ids.ts";
import { compileSkeleton, harness, skeletonSpec, DOCS } from "../run/skeleton.ts";

const CALLBACK_SECRET = "shhh";
/** The harness clock. The plane is given the same one, so replay windows are decidable. */
const NOW = 1_700_000_000_000;

interface Rig {
  base: string;
  plane: ControlPlane;
  h: ReturnType<typeof harness>;
  channel: SignedWebhookChannel;
  close: () => Promise<void>;
}

/** The skeleton, with the gate node declaring who may answer it. */
function specWithApprovers(approvers: readonly string[]): GraphSpec {
  const base = skeletonSpec();
  return {
    ...base,
    nodes: base.nodes.map((n) =>
      n.id !== "approve" ? n : { ...n, humanGate: { ref: n.humanGate!.ref, approval: { mode: "single" as const, approvers } } },
    ),
  };
}

interface RigOptions {
  token?: string;
  callbacks?: boolean;
  maxBodyBytes?: number;
  approvers?: readonly string[];
  identity?: IdentitySource;
  requestTimeoutMs?: number;
  /** An extra delivery channel, so a test can make the callback route misbehave. */
  channel?: DeliveryChannel;
}

async function rig(opts: RigOptions = {}): Promise<Rig> {
  const h = harness();
  const graph = compileSkeleton(opts.approvers === undefined ? skeletonSpec() : specWithApprovers(opts.approvers));
  const channel = new SignedWebhookChannel({
    name: "slack",
    url: "https://hooks.example.com/unused",
    callbackSecret: CALLBACK_SECRET,
  });
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "skeleton-summarize": graph },
    now: () => NOW,
    ...(opts.token === undefined ? {} : { token: opts.token }),
    ...(opts.identity === undefined ? {} : { identity: opts.identity }),
    ...(opts.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: opts.requestTimeoutMs }),
    ...(opts.maxBodyBytes === undefined ? {} : { maxBodyBytes: opts.maxBodyBytes }),
    ...(opts.callbacks === true
      ? {
          dispatcher: new GateDispatcher({
            channels: [channel, new ConsoleChannel(), ...(opts.channel === undefined ? [] : [opts.channel])],
          }),
        }
      : {}),
  });
  const { port } = await plane.listen(0);
  return { base: `http://127.0.0.1:${port}`, plane, h, channel, close: () => plane.close() };
}

const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

async function submit(r: Rig, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${r.base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
  });
  assert.equal(res.status, 202);
  return json(res);
}

// ── auth ─────────────────────────────────────────────────────────────────────

test("health needs no token; everything else does", async () => {
  const r = await rig({ token: "s3cret" });
  try {
    assert.equal((await fetch(`${r.base}/health`)).status, 200);
    assert.equal((await fetch(`${r.base}/runs`)).status, 401);
    const ok = await fetch(`${r.base}/runs`, { headers: { authorization: "Bearer s3cret" } });
    assert.equal(ok.status, 200);
  } finally {
    await r.close();
  }
});

test("a wrong token is rejected before routing, so routes cannot be probed", async () => {
  const r = await rig({ token: "s3cret" });
  try {
    const res = await fetch(`${r.base}/runs/does-not-exist`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(res.status, 401, "401, not 404 — an unauthenticated caller learns nothing");
  } finally {
    await r.close();
  }
});

test("health reports whether the plane is open", async () => {
  const open = await rig();
  try {
    assert.equal((await json(await fetch(`${open.base}/health`)))["auth"], "open");
  } finally {
    await open.close();
  }
});

test("AN EMPTY SHARED TOKEN IS REFUSED AT CONSTRUCTION — it authenticated EVERYONE, silently", async () => {
  // Observed on a live plane built with `token: ""`, before this was a refusal:
  //
  //     GET /runs   with NO Authorization header  -> 200 {"runs":[]}
  //     GET /whoami with NO Authorization header  -> 200 {"subject":"(shared-token)",…}
  //     GET /health                               -> "required"
  //     boot warnings                             -> []
  //
  // `#sharedToken` padded the presented string to the expected length and compared: with
  // an empty expectation, `presented.padEnd(0,"\0").slice(0,0)` is `""`, `timingSafeEqual`
  // of two zero-length buffers is TRUE, and `0 === 0` passed the length check. A request
  // carrying no credential at all authenticated as the plane's own service principal.
  //
  // What made it SEVERE rather than merely wrong is the four lines above: every other
  // surface kept saying the opposite. `/health` reported `auth: "required"`, `/whoami`
  // handed out a principal, and neither boot warning fired, because the empty string
  // counted as a configured token and as a distinct principal. D7.9's "looks supervised,
  // is not", applied to the entire perimeter.
  //
  // The trigger is one character of deployment slip — `--token "$LOOM_TOKEN"` with the
  // variable unset. `BearerTokenIdentity` already refused the identical configuration two
  // hundred lines above; the plane is now as strict as its own identity source.
  const h = harness();
  const base: ControlPlaneOptions = { engine: h.engine, store: h.store, graphs: {} };

  assert.throws(
    () => new ControlPlane({ ...base, token: "" }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /open plane/.test(e.message),
    "an empty token must fail to START, and the message must name the deliberate alternative",
  );
  // BEFORE a socket is bound. A plane that started and then refused everything would still
  // be in rotation, and a misconfigured deployment must not serve one request.
  await assert.rejects(startControlPlane({ ...base, token: "" }, 0), (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID);

  // The property the refusal exists to protect, on a plane with a real token: no
  // credential is not a credential.
  const good = await rig({ token: "s3cret" });
  try {
    assert.equal((await fetch(`${good.base}/runs`)).status, 401);
    assert.equal((await fetch(`${good.base}/whoami`)).status, 401);
    assert.equal((await fetch(`${good.base}/runs`, { headers: { authorization: "Bearer " } })).status, 401, "…nor is an empty one");
  } finally {
    await good.close();
  }
});

test("A PORT THAT CANNOT BE BOUND IS AN ERROR, NOT AN UNHANDLED 'error' EVENT", async () => {
  // Every refusal in this class happens before the socket. This is the failure ON the
  // socket, and it was the one the constructor's carefulness could not reach: `listen`
  // resolved a promise from the `listening` callback and attached no `'error'` handler at
  // all, so a legal-but-unbindable port emitted `'error'` on an EventEmitter with no
  // listener — which node turns into an uncaught exception. Reproduced end to end:
  //
  //     $ loom serve --workspace <dir> --port 1
  //     node:events:487
  //           throw er; // Unhandled 'error' event
  //     Error: listen EACCES: permission denied 127.0.0.1:1
  //         at Server.setupListenHandle [as _listen2] (node:net:1986:21)
  //       … { code: 'EACCES', errno: -13, syscall: 'listen', address: '127.0.0.1', port: 1 }
  //
  // That is the exact failure `httpPort`'s docstring in `cli.ts` cited as the reason for
  // its own existence — and `httpPort` could not remove it, because it only ever removed
  // the two ways a MISSING flag became a number. `--port 1` is a whole number in range;
  // so is `--port 80`; so is any port another process already holds. The check bounds the
  // value and the bind is a different failure.
  //
  // The promise never settling is the second half: an embedder awaiting `listen` on a
  // taken port had no error AND no resolution, so the only reason the process died was
  // the uncaught exception it would otherwise have hung on.
  const h = harness();
  const base: ControlPlaneOptions = { engine: h.engine, store: h.store, graphs: {} };

  // EADDRINUSE rather than EACCES, because a privileged port is a permission this test
  // must not depend on having or lacking: take a port, then ask for the same one.
  const first = await startControlPlane(base, 0);
  try {
    const second = new ControlPlane(base);
    // A FAILURE DEADLINE, not a timing assertion. Against the unfixed `listen` this whole
    // FILE hung — the promise never settled and the test runner has no per-test timeout —
    // and a red test that hangs is indistinguishable from a slow machine.
    const settled = second.listen(first.port).then(
      () => "bound the port twice",
      (e: unknown) => e,
    );
    const outcome = await Promise.race([
      settled,
      new Promise((resolve) => setTimeout(() => resolve("listen never settled: no error, no resolution"), 5_000).unref()),
    ]);
    assert.ok(
      isLoomError(outcome) &&
        outcome.code === CODES.E_CONFIG_INVALID &&
        /127\.0\.0\.1:/.test(outcome.message) &&
        (outcome.details as { syscall?: string } | undefined)?.syscall === "listen",
      `a port that cannot be bound must REJECT, naming the address — not kill the process from an event nobody listens to. Got: ${String(outcome)}`,
    );
    // …and the plane must be closable afterwards without throwing on a server that never
    // began listening, which is the tidy-up an embedder will reach for next.
    await second.close();
  } finally {
    await first.plane.close();
  }
});

test("A SECOND listen IS REFUSED — close() can only ever close the last", async () => {
  // `listen` overwrote `#server` without closing or refusing the previous one. `#server`
  // is PRIVATE, so the first `Server` became unreachable at that moment: nothing — not
  // `close()`, not the caller — could ever get a handle on it again, and it stayed bound
  // and serving for the life of the process while `close()` resolved successfully having
  // closed only the second. On a tokenless plane that is a control-plane socket nobody
  // knows is open.
  //
  // Reproduced by asking the leaked socket a question after `close()` said it was shut.
  const h = harness();
  const plane = new ControlPlane({ engine: h.engine, store: h.store, graphs: {} });
  const first = await plane.listen(0);
  try {
    await assert.rejects(
      () => plane.listen(0),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /already listening/.test(e.message),
      "a second listen while one is bound is refused, not silently accepted",
    );
    // The refusal did not disturb the socket that IS bound.
    assert.equal((await fetch(`http://127.0.0.1:${first.port}/health`)).status, 200);
  } finally {
    await plane.close();
  }
  // …and now it really is closed, which is the half that used to be false.
  await assert.rejects(
    () => fetch(`http://127.0.0.1:${first.port}/health`),
    () => true,
    "after close() the port answers nothing — before, the first socket outlived the plane",
  );
});

test("A RETRY AFTER A FAILED BIND IS NOT A SECOND listen", async () => {
  // The refusal above is "while one is BOUND", not "ever", and this is the case that
  // forces the distinction. `listen(taken)` → EADDRINUSE → `listen(0)` is the ordinary
  // fallback shape, and nothing is bound when it happens; a blanket refusal would have
  // made the legitimate retry unreachable in the name of closing the leak.
  const h = harness();
  const base: ControlPlaneOptions = { engine: h.engine, store: h.store, graphs: {} };
  const holder = await startControlPlane(base, 0);
  const plane = new ControlPlane(base);
  try {
    await assert.rejects(
      () => plane.listen(holder.port),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
      "the taken port fails to bind",
    );
    const second = await plane.listen(0);
    assert.equal((await fetch(`http://127.0.0.1:${second.port}/health`)).status, 200, "the retry binds");
  } finally {
    await plane.close();
    await holder.plane.close();
  }
});

test("A PORT NO SOCKET CAN HOLD REJECTS THROUGH THE SAME CONTRACT, not as a raw RangeError", async () => {
  // The bind-error contract covers failures ON the socket. An out-of-range port never
  // gets that far: `server.listen(port, host)` throws `ERR_SOCKET_BAD_PORT` SYNCHRONOUSLY
  // inside the promise executor, so the promise rejected with a bare `RangeError` that
  // passed the `'error'` mapping entirely — no `E_CONFIG_INVALID`, no `details`, none of
  // the text `listen`'s docstring promises. Measured against a raw `http.Server`:
  //
  //     -1      -> RangeError ERR_SOCKET_BAD_PORT  options.port should be >= 0 and < 65536
  //     65536   -> RangeError ERR_SOCKET_BAD_PORT
  //     1.5     -> RangeError ERR_SOCKET_BAD_PORT
  //     NaN     -> RangeError ERR_SOCKET_BAD_PORT
  //     2 ** 31 -> RangeError ERR_SOCKET_BAD_PORT
  //     "80"    -> Error EACCES  (a STRING reaches the OS and fails like any other
  //                privileged port — which is why the ceiling cannot be a type check)
  const h = harness();
  const base: ControlPlaneOptions = { engine: h.engine, store: h.store, graphs: {} };
  for (const bad of [-1, 65536, 1.5, NaN, 2 ** 31]) {
    const plane = new ControlPlane(base);
    await assert.rejects(
      () => plane.listen(bad),
      (e: unknown) =>
        isLoomError(e) &&
        e.code === CODES.E_CONFIG_INVALID &&
        (e.details as { code?: string } | undefined)?.code === "ERR_SOCKET_BAD_PORT",
      `port ${String(bad)}`,
    );
    // And the failure released the field, so the same instance can still be used.
    const ok = await plane.listen(0);
    assert.ok(ok.port > 0);
    await plane.close();
  }
});

test("close() RESOLVES WITH AN SSE STREAM ATTACHED — `server.close` alone never does", async () => {
  // `Server.close` stops accepting and then waits for every connection "sending a request
  // or waiting for a response" to finish. An SSE stream on `/runs/:id/events` is by
  // construction never finished, so `close()` hung forever against the ONE client this
  // plane exists to serve — the console — and `loom serve`'s SIGINT handler awaits exactly
  // this promise. Measured on a raw server holding one open `text/event-stream` response:
  // `close()` had still not called back after 1500 ms.
  //
  // Every SSE test in this file aborts its stream in a `finally` before closing, which is
  // why the suite never found this: they all avoid the shape rather than exercising it.
  const r = await rig();
  const ctrl = new AbortController();
  try {
    const { runId } = await submit(r);
    await settle(r, String(runId));
    const res = await fetch(`${r.base}/runs/${String(runId)}/events`, { signal: ctrl.signal });
    assert.equal(res.status, 200, "the stream is open and will never end on its own");

    const started = Date.now();
    const outcome = await Promise.race([
      r.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("close() never resolved"), 10_000).unref()),
    ]);
    assert.equal(outcome, "closed", `${String(outcome)} after ${Date.now() - started}ms`);
  } finally {
    ctrl.abort();
  }
});

test("close() DURING A BIND SETTLES THE listen IT INTERRUPTS — and does not strand the listen that follows", async () => {
  // `listen` had two settle paths, `'listening'` and `'error'`, for the two ways a bind
  // can end — and there is a third: someone takes the socket away. Node's
  // `emitListeningNT` is `if (self._handle) self.emit('listening')` and `Server.close`
  // nulls `_handle` synchronously, so a `close()` landing in the tick between
  // `server.listen()` and that callback silences BOTH. Reproduced against this class:
  //
  //     const p = plane.listen(0); plane.close();
  //     → close() resolved; p had STILL NOT SETTLED after 1500 ms
  //
  // Same cost as the missing `'error'` listener the test above pins, one event later: an
  // embedder awaits a bind that already stopped happening, forever.
  const h = harness();
  const plane = new ControlPlane({ engine: h.engine, store: h.store, graphs: {} });
  const pending = plane.listen(0);
  const closing = plane.close();
  // Admitted, because nothing is bound: `close()` clears `#server` first on purpose. This
  // is the shape that makes the SECOND half of the fix observable.
  const rebound = plane.listen(0);
  try {
    await assert.rejects(
      () =>
        Promise.race([
          pending,
          new Promise((_, reject) => setTimeout(() => reject(new Error("listen() NEVER SETTLED")), 3000).unref()),
        ]),
      (e: unknown) =>
        isLoomError(e) && e.code === CODES.E_CANCELLED && /ended by close\(\)/.test(e.message) && /nothing is bound/.test(e.message),
      "cancelled, not E_CONFIG_INVALID: nothing about the configuration is wrong",
    );
    await closing;
    const bound = await rebound;
    assert.equal((await fetch(`http://127.0.0.1:${bound.port}/health`)).status, 200, "the rebind really bound");

    // THE SECOND HALF. The interrupted `listen`'s error path releases `#server` so a retry
    // after a failed bind is admitted — and it used to do that unconditionally, from a
    // rejection the *later* listen's `Server` had already outlived. That erases a bound
    // socket from a private field: `close()` then takes the "nothing bound" branch and
    // resolves while the plane serves on, which is precisely the leak `A SECOND listen IS
    // REFUSED` exists to prevent, reached from the other side.
    await plane.close();
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${bound.port}/health`),
      () => true,
      "close() closed the socket the plane was actually holding",
    );
  } finally {
    // A FAILING ASSERTION MUST NOT LEAVE A BOUND SOCKET BEHIND. It is a private field, so
    // the only handle on it is this plane; without this the whole file hangs — `node
    // --test` waits for the loop to drain and a stranded listener never lets it, so the
    // run reports nothing at all instead of reporting one failure.
    //
    // AND NOTHING HERE MAY AWAIT `pending` OR `rebound`. The defect this test pins is a
    // `listen` that never settles; a cleanup that waits for one turns the red into the
    // same hang by a shorter route. Measured — an `allSettled` over all three took the
    // mutated run past two minutes with no output. A `catch` arm, not an `await`.
    void pending.catch(() => undefined);
    void rebound.catch(() => undefined);
    void closing.catch(() => undefined);
    await plane.close();
  }
});

test("A SECOND CONCURRENT close() WAITS FOR THE SOCKET — it does not resolve on the first one's behalf", async () => {
  // `#server` is cleared at the START of a close so a `listen` is admitted immediately, and
  // that made the `server === undefined` line — written for "nothing was ever bound" — also
  // answer "another close is halfway through". Reproduced with ONE mid-request connection
  // holding the grace window open:
  //
  //     second close resolved after 0 ms
  //     first  close resolved after 2001 ms
  //
  // The second caller was told the socket was released while it demonstrably was not, which
  // is the same lie `close()`'s own comment refuses to take from a `Promise.race`. A SIGINT
  // handler that fires twice — `process.on`, not `once` — is the shape that reaches it.
  const h = harness();
  const plane = new ControlPlane({ engine: h.engine, store: h.store, graphs: {} });
  const { port } = await plane.listen(0);
  // Bytes sent, no terminating blank line: the connection is mid-request, so it is neither
  // idle (`closeIdleConnections` will not take it) nor finished (`server.close` waits for
  // it). That is what forces the full `CLOSE_GRACE_MS`.
  const sock = connect(port, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });
    sock.write("GET /health HTTP/1.1\r\nHost: x\r\n");
    await new Promise<void>((r) => setTimeout(r, 100));

    const t = Date.now();
    const first = plane.close().then(() => Date.now() - t);
    const second = plane.close().then(() => Date.now() - t);
    const [a, b] = await Promise.all([first, second]);
    // Not "both are slow" — both learn the SAME fact, so neither can be told the socket is
    // gone before it is. The grace is 2 s; anything under a second is the early return.
    assert.ok(b >= 1000, `the second close waited for the socket, not for nothing (${b}ms; the first took ${a}ms)`);
    assert.ok(Math.abs(a - b) < 250, `both callers settled together (${a}ms vs ${b}ms)`);

    // …and a close() AFTER everything is released is still a resolving no-op, which is the
    // case the early return was written for and must keep working.
    await plane.close();
  } finally {
    sock.destroy();
    await plane.close();
  }
});

test("A CAP SET TO NaN IS NOT A LOOSE CAP, IT IS NO CAP — maxBodyBytes and hotWindow are refused too", async () => {
  // The residue of the unbounded-number sweep, found by asking what a knob is COMPARED
  // AGAINST instead of which platform API consumes it. That sweep's command was
  // `grep -ranE '(setTimeout|setInterval|AbortSignal\.timeout|\.listen)\(' src`, and it
  // therefore cleared both of these on the grounds that they "reach no platform API with a
  // range" — true, and irrelevant: `size > NaN` is false for every size.
  //
  // `maxBodyBytes` is the one member of the family a REMOTE party has leverage on. It is
  // what stands between an unauthenticated `POST /runs/:id/callbacks/:channel` and this
  // process's heap. Reproduced with 8 MiB of JSON at `POST /runs` against the 1 MiB
  // default:
  //
  //     (default)          → 400 E_PROVIDER_BAD_REQUEST "request body exceeds 1048576 bytes"
  //     maxBodyBytes: NaN  → the whole 8 MiB buffered, concatenated and JSON.parsed
  //     maxBodyBytes: ∞    → the same
  //
  // …while `/health` went on reporting a healthy plane, which is the shape this file keeps
  // finding: a guard that reports itself as present and is not.
  const h = harness();
  const base: ControlPlaneOptions = { engine: h.engine, store: h.store, graphs: {} };
  for (const where of ["maxBodyBytes", "hotWindow"] as const) {
    for (const bad of [NaN, Infinity, -1, 1.5, 2 ** 31 * 2, "1024" as unknown as number]) {
      assert.throws(
        () => new ControlPlane({ ...base, [where]: bad }),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && e.message.includes(where),
        `${where}: ${String(bad)}`,
      );
    }
  }

  // 0 STAYS LEGAL for both — "accept no request body" and "always snapshot" are coherent
  // asks, the same way `gracePeriodMs: 0` is — so this is a ceiling and not a narrowing.
  // A real cap still refuses a real body, which is the behaviour the range protects.
  const plane = new ControlPlane({ ...base, maxBodyBytes: 0, hotWindow: 0 });
  const { port } = await plane.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graph: "nope", inputs: {} }),
    });
    assert.equal(res.status, 400, "a cap of 0 refuses every non-empty body");
    assert.match((await res.text()).replace(/\\"/g, '"'), /request body exceeds 0 bytes/);
  } finally {
    await plane.close();
  }
});

test("A requestTimeoutMs NO TIMER CAN HOLD IS REFUSED AT CONSTRUCTION — it collapses to 1ms", async () => {
  // The same shape as the empty token above, in the one other number this class takes and
  // hands straight to a platform API. `#withDeadline` gives it to `setTimeout`, which keeps
  // its delay in a 32-bit signed integer and TRUNCATES anything larger to ONE MILLISECOND —
  // it does not saturate and it does not throw.
  //
  // Reproduced on a live plane whose identity source answers in 5ms, which is a fast SSO by
  // any standard. The only difference between these two lines is one increment:
  //
  //     requestTimeoutMs=2147483648 → 504 {"code":"E_REQUEST_TIMEOUT",
  //                                        "message":"no response for /runs within 2147483648ms"}
  //     requestTimeoutMs=2147483647 → 200 {"runs":[]}
  //
  // The 504 quotes 24.8 days back at the operator while the deadline that fired was a
  // millisecond, and it is INTERMITTENT rather than total — a handler that beats the tick
  // still answers — so the deployment sees flapping 504s on every route rather than an
  // obviously broken configuration. That is worse than a total outage, not better.
  //
  // Zero and a negative reach the same place by a shorter route: `??` defaults only on
  // `undefined`, so `requestTimeoutMs: 0` is a deadline that has already passed.
  const h = harness();
  const base: ControlPlaneOptions = { engine: h.engine, store: h.store, graphs: {} };
  const bad: readonly [string, number][] = [
    ["one above the ceiling", 2 ** 31],
    ["a day in microseconds", 86_400_000_000],
    ["zero — a deadline that has already passed", 0],
    ["negative", -1],
    ["not whole", 1.5],
    ["NaN, which compares false against every bound", Number.NaN],
  ];
  for (const [what, ms] of bad) {
    assert.throws(
      () => new ControlPlane({ ...base, requestTimeoutMs: ms }),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /requestTimeoutMs/.test(e.message),
      what,
    );
  }
  // BEFORE a socket is bound, like every other refusal in this constructor: a plane that
  // started and then 504'd everything would still be in rotation.
  await assert.rejects(
    startControlPlane({ ...base, requestTimeoutMs: 2 ** 31 }, 0),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
  );

  // The boundary is a legal configuration, so the refusal cannot quietly become an
  // off-by-one that rejects the longest deadline a timer can actually hold.
  const atTheCeiling = await startControlPlane({ ...base, requestTimeoutMs: 2 ** 31 - 1 }, 0);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${atTheCeiling.port}/health`)).status, 200);
  } finally {
    await atTheCeiling.plane.close();
  }
});

test("THE OPTIONS RECORD IS READ AT CONSTRUCTION AND NEVER AGAIN — a validated option cannot change under a live plane", async () => {
  // `#token` and `#identity` were captured because re-reading them per request means a
  // getter can pass the constructor's check and answer the request with something else.
  // `#maxBodyBytes` and `#hotWindow` followed, under a docstring calling them "the LAST
  // TWO options still read off `#opts` per request". There were more, and the worst of
  // them was `requestTimeoutMs` — the one option in the record whose refusal has a
  // reproduction written next to it.
  //
  // Reproduced against this class before the capture, with the plain-object record
  // MUTATED after construction (no getter needed) and an identity source answering in
  // 5 ms:
  //
  //     before mutation → 200 {"runs":[]}
  //     after  mutation → 504 {"code":"E_REQUEST_TIMEOUT",
  //                            "message":"no response for /runs within 2147483648ms"}
  //
  // — which is verbatim the failure "A requestTimeoutMs NO TIMER CAN HOLD IS REFUSED AT
  // CONSTRUCTION" exists to prevent, on a plane the constructor validated at 30 000. The
  // `TimeoutOverflowWarning` naming no call site is the platform's only comment.
  //
  // The assertion is the RULE and not the field, because a per-field test is what let a
  // count stand in for a derivation twice. A `Proxy` counts every property read of the
  // record; after `listen` resolves there must be none.
  //
  // AND THAT VERSION OF THIS TEST WAS A GUARD THAT WENT QUIET ON THE ONE CASE IT WAS
  // WRITTEN TO CATCH. It built the plane with no `dispatcher`, so `#callbacks` was
  // `undefined` and the constructor never created `logFor` — the factory
  // `GateCallbackRouter` calls PER REQUEST, which closed over `opts` and read
  // `opts.store`, `opts.bus` and `opts.now` on the one route reachable without a
  // credential. The test asserted zero reads of a closure that did not exist and reported
  // the property as structurally pinned. Measured against the source it was passing on,
  // with a dispatcher wired and a correctly-signed callback naming a different run:
  //
  //     reads after POST /runs                → []
  //     reads after the callback refusal      → ["store","bus","bus","now","now"]
  //
  // So: every option this record has, including the dispatcher, and every route including
  // the callback one — driven to a DURABLE refusal, because a callback that succeeds never
  // reaches `logFor` and a signature failure is counted rather than journaled.
  const h = harness();
  const graph = compileSkeleton(skeletonSpec());
  const slow: IdentitySource = {
    name: "slow-sso",
    principals: 1,
    identify: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { kind: "human", subject: "u:alice", method: "slow-sso" };
    },
  };
  const channel = new SignedWebhookChannel({ name: "slack", url: "https://hooks.example.com/unused", callbackSecret: CALLBACK_SECRET });
  const touched: string[] = [];
  const record: ControlPlaneOptions = {
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "skeleton-summarize": graph },
    identity: slow,
    requestTimeoutMs: 30_000,
    maxBodyBytes: 4096,
    hotWindow: 10,
    now: () => NOW,
    dispatcher: new GateDispatcher({ channels: [channel, new ConsoleChannel()] }),
  };
  const watched = new Proxy(record, {
    get(t, k, r): unknown {
      if (typeof k === "string") touched.push(k);
      return Reflect.get(t, k, r) as unknown;
    },
  });

  const plane = new ControlPlane(watched);
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: "Bearer anything" };
  try {
    const atBoot = touched.length;
    assert.ok(atBoot > 0, "the constructor did read the record");

    // Every route the plane has, including the three open ones and the two that used to
    // reach for `graphs` and `bus` mid-request.
    const submitted = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
    });
    assert.equal(submitted.status, 202);
    const runId = String((await json(submitted))["runId"]);
    for (const path of ["/health", "/", "/graphs", "/whoami", "/runs", `/runs/${runId}`, `/runs/${runId}/gates`]) {
      assert.equal((await fetch(`${base}${path}`, { headers: auth })).status, 200, path);
    }
    const ctrl = new AbortController();
    await fetch(`${base}/runs/${runId}/events`, { headers: auth, signal: ctrl.signal });
    ctrl.abort();

    // THE UNAUTHENTICATED ROUTE, driven to the arm that writes. The run has to be parked on
    // an open gate for the router to consider a refusal durable, and the callback has to
    // pass the signature check and then fail on something else — a valid signature over a
    // body naming a different run — or the refusal is counted in memory and `logFor` is
    // never called.
    for (let i = 0; i < 200; i++) {
      if ((await h.engine.projection(runId as RunId))?.status === "awaiting_gate") break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const gateId = (await h.engine.openGates(runId as RunId))[0]!.gateId;
    const body = JSON.stringify({ runId: "r_somewhere_else", gateId, actor: "u:alice", decision: { kind: "approve" } });
    const ts = String(Math.floor(NOW / 1000));
    const refused = await fetch(`${base}/runs/${runId}/callbacks/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-loom-timestamp": ts, "x-loom-signature": channel.sign(body, ts) },
      body,
    });
    assert.equal(refused.status, 400, "the callback is refused past the perimeter, so its refusal is journaled");

    assert.deepEqual(
      touched.slice(atBoot),
      [],
      `a request read the caller's record: ${touched.slice(atBoot).join(", ")}. Capture it in the constructor — a closure the ` +
        `constructor BUILDS is not a read at construction time.`,
    );

    // And the facts the count was standing in for. First the deadline: mutating the record
    // cannot move the one the plane enforces.
    (record as { requestTimeoutMs: number }).requestTimeoutMs = 2 ** 31;
    assert.equal((await fetch(`${base}/runs`, { headers: auth })).status, 200, "the deadline is the one the constructor validated");

    // Then the durable one, which is the reason this matters rather than being hygiene:
    // swap the STORE and the CLOCK under the live plane and drive the callback route
    // again. The refusal row must land in this run's own journal, on this plane's own
    // clock. Before the capture it went to `elsewhere`, stamped 2100-01-01, while the run's
    // own journal recorded nothing at all.
    const elsewhere = new MemoryStateStore({ now: () => NOW });
    (record as { store: unknown }).store = elsewhere;
    (record as { now: () => number }).now = () => 4_102_444_800_000;
    const body2 = JSON.stringify({ runId: "r_somewhere_else_again", gateId, actor: "u:alice", decision: { kind: "approve" } });
    const again = await fetch(`${base}/runs/${runId}/callbacks/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-loom-timestamp": ts, "x-loom-signature": channel.sign(body2, ts) },
      body: body2,
    });
    assert.equal(again.status, 400);

    const rejections: JournalEvent[] = [];
    for await (const e of h.store.read(runId as RunId, 1)) if (e.type === "gate.callback_rejected") rejections.push(e);
    assert.equal(rejections.length, 2, "both refusals are in the run's OWN journal, not in a store assigned after construction");
    for (const e of rejections) assert.equal(e.ts, NOW, "stamped by the clock the constructor captured, not the one assigned afterwards");
    let strays = 0;
    for await (const _e of elsewhere.read(runId as RunId, 1)) strays += 1;
    assert.equal(strays, 0, "nothing was written to the store the record was mutated to point at");
  } finally {
    await plane.close();
  }
});

test("A RUN ACCEPTED WITH 202 WHOSE FIRST advance() FAILS SAYS SO — the fire-and-forget catch is not a mute", async () => {
  // `void engine.advance(runId).catch(() => undefined)` dropped every rejection from the
  // one call that drives a freshly-accepted run. The 202 body says, in those words,
  // "accepted means this WILL run, not that it HAS run" — a promise about the future — and
  // the catch is what made that promise unfalsifiable: the run sits at `run.compiled` with
  // nothing after it, `GET /runs/:id` reports `queued`, and no surface anywhere carries the
  // reason. The response is already sent by then, so the client cannot be told; the
  // operator can, and `startControlPlane`'s boot warnings are the precedent for how.
  //
  // The alternative — awaiting `advance` before answering — is the thing the 202 exists to
  // avoid, so this stays fire-and-forget and gains a sink.
  const h = harness();
  const graph = compileSkeleton(skeletonSpec());
  // A Proxy over the real engine: methods are re-bound to the target so its private fields
  // still work, and `advance` alone rejects.
  const failing = new Proxy(h.engine, {
    get(t, k): unknown {
      if (k === "advance") return () => Promise.reject(new LoomError("unavailable", CODES.E_SEQ_CONFLICT, "the journal moved under us"));
      const v = Reflect.get(t, k, t) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const plane = new ControlPlane({ engine: failing, store: h.store, bus: h.bus, graphs: { "skeleton-summarize": graph } });
  const { port } = await plane.listen(0);
  const said: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]): void => void said.push(a.map(String).join(" "));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
    });
    // Still 202: the response is not made to wait on execution, and this is not a 500.
    assert.equal(res.status, 202);
    const runId = String((await json(res))["runId"]);
    for (let i = 0; i < 100 && said.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

    assert.equal(said.length, 1, "exactly one line: the failure is reported once, not per retry");
    assert.match(said[0]!, /E_SEQ_CONFLICT/, "the reason survives");
    assert.match(said[0]!, new RegExp(runId), "and names the run it is about");
    // A LATER advance is the recovery, so the line has to point at it.
    assert.match(said[0]!, /advance/);
  } finally {
    console.error = realError;
    await plane.close();
  }
});

test("A NON-ERROR REJECTION FROM advance() IS STILL REPORTED, and reporting it does not kill the process", async () => {
  // The reporter is the LAST frame — it runs inside a `.catch` on a promise nobody awaits,
  // so anything it throws is an unhandled rejection and the process. `toLoomError` is not
  // safe to call here: it does `String(e)`, which throws on a value with no primitive
  // conversion (HANDOFF A1), and that is precisely the value an injected engine can reject
  // with. So does a template over an `Error` whose `message` is a throwing getter — which
  // passes `instanceof Error` and every other test available. All four shapes go through
  // the one line, and each must still produce a report rather than only a survival.
  const h = harness();
  const graph = compileSkeleton(skeletonSpec());
  const trapped = new Error("looks ordinary");
  Object.defineProperty(trapped, "message", {
    get(): string {
      throw new Error("boom");
    },
  });
  const hostile: unknown[] = [
    Object.assign(Object.create(null), { nope: true }), // no `toString`: String(e) throws
    trapped, // an Error whose own fields detonate on read
    Symbol("nope"), // `${sym}` is a TypeError
    undefined,
  ];
  for (const value of hostile) {
    const failing = new Proxy(h.engine, {
      get(t, k): unknown {
        if (k === "advance") return () => Promise.reject(value);
        const v = Reflect.get(t, k, t) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const plane = new ControlPlane({ engine: failing, store: h.store, bus: h.bus, graphs: { "skeleton-summarize": graph } });
    const { port } = await plane.listen(0);
    const said: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]): void => void said.push(a.map(String).join(" "));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
      });
      assert.equal(res.status, 202);
      const runId = String((await json(res))["runId"]);
      for (let i = 0; i < 100 && said.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(said.length, 1, `a ${typeof value} rejection is still one line`);
      assert.match(said[0]!, new RegExp(runId), "which names the run");
    } finally {
      console.error = realError;
      await plane.close();
    }
  }
  // Reached at all ⇒ nothing above the reporter died.
  assert.ok(true);
});

test("A REJECTION WEARING `LoomError.prototype` IS STILL REPORTED — `describeFailure`'s TOTAL claim, tested on its first branch", async () => {
  // `describeFailure`'s docstring ends "TOTAL, then: every input leaves here as a string, so
  // the caller always has a line to print rather than sometimes falling through to its own
  // backstop and printing nothing." The counterexample is the FIRST branch of the same
  // function: `if (isLoomError(e)) return `${e.code}: ${e.message}`;` is outside the only
  // `try` in the body, and `isLoomError` is `e instanceof LoomError` — which proves a
  // PROTOTYPE, not provenance. That is HANDOFF's own trap note, and the docstring cites it
  // two sentences later to justify wrapping the `Error` branch while leaving this one bare.
  //
  // The rest of the docstring's reasoning is what makes the hole reachable: "`LoomError` is
  // ours and its fields are plain" is true of every `LoomError` this process constructs and
  // says nothing about a value that merely wears the prototype. `Object.create` is one line;
  // so is a `Proxy` whose `getPrototypeOf` trap makes `instanceof` itself throw.
  //
  // The consequence is the exact silence the surrounding comment says the reporting exists
  // to remove: the caller's `try` catches it, so the process survives and the operator is
  // told NOTHING about a run that was accepted 202 and never started.
  const h = harness();
  const graph = compileSkeleton(skeletonSpec());
  const wearingTheProto = Object.create(LoomError.prototype, {
    code: {
      get(): string {
        throw new Error("code getter");
      },
      enumerable: true,
    },
    message: { value: "looks like ours", enumerable: true },
  }) as unknown;
  const instanceofThrows = new Proxy(
    {},
    {
      getPrototypeOf(): never {
        throw new Error("getPrototypeOf trap");
      },
    },
  );
  for (const [what, value] of [
    ["a code getter that throws", wearingTheProto],
    ["a Proxy that makes `instanceof` itself throw", instanceofThrows],
  ] as const) {
    const failing = new Proxy(h.engine, {
      get(t, k): unknown {
        if (k === "advance") return () => Promise.reject(value);
        const v = Reflect.get(t, k, t) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const plane = new ControlPlane({ engine: failing, store: h.store, bus: h.bus, graphs: { "skeleton-summarize": graph } });
    const { port } = await plane.listen(0);
    const said: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]): void => void said.push(a.map(String).join(" "));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
      });
      assert.equal(res.status, 202);
      const runId = String((await json(res))["runId"]);
      for (let i = 0; i < 100 && said.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(said.length, 1, `${what}: the operator was told nothing at all`);
      assert.match(said[0]!, new RegExp(runId), `${what}: the line names the run`);
      assert.match(said[0]!, /POST \/runs\//, `${what}: …and the recovery`);
    } finally {
      console.error = realError;
      await plane.close();
    }
  }
});

test("A WORKFLOW NAME THAT NAMES AN INHERITED PROPERTY IS NOT A WORKFLOW — 404, never a 500", async () => {
  // `POST /runs` looked its graph up with `this.#graphs[name]`, a bracket read that walks
  // `Object.prototype`, and `if (graph === undefined) throw notFound` was the only thing
  // between a caller-chosen string and `engine.submit`. Every inherited name answers with
  // something that is not `undefined` — `constructor` is the `Object` function,
  // `__proto__` is `Object.prototype` — so the guard never fired. Measured, one request
  // per name, on an open plane:
  //
  //     constructor    → 500 E_INTERNAL "TypeError: Cannot read properties of undefined (reading 'nodes')"
  //     __proto__      → 500 (the same)
  //     toString       → 500 (the same)
  //     valueOf        → 500 (the same)
  //     hasOwnProperty → 500 (the same)
  //     isPrototypeOf  → 500 (the same)
  //     nope           → 404 E_RESOURCE_NOT_FOUND
  //
  // `E_INTERNAL` is this system's word for "a bug in Loom", produced here by a string a
  // stranger typed. This is the third time this repo has written the same lookup — after
  // `gateOf`/`gateIn` in `projection.ts` and `put` in `redact.ts` — so `graphIn` uses those
  // two conditions rather than inventing a third variant.
  const h = harness();
  const graph = compileSkeleton(skeletonSpec());
  const plane = new ControlPlane({ engine: h.engine, store: h.store, bus: h.bus, graphs: { "skeleton-summarize": graph } });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const workflow of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "nope", ""]) {
      const res = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow, inputs: { paths: DOCS } }),
      });
      assert.equal(res.status, 404, `workflow "${workflow}" must be 404, identically to a name nobody has ever used`);
      const body = (await json(res))["error"] as { code: string; message: string };
      assert.equal(body.code, CODES.E_RESOURCE_NOT_FOUND, `workflow "${workflow}"`);
      assert.match(body.message, /no compiled graph named/, `workflow "${workflow}"`);
    }
    // Nothing reached the journal on the way to any of those refusals.
    assert.equal((await h.store.listRuns(100)).length, 0, "a refused workflow name submits no run");
    // And the real one still works, so the refusal is about the prototype chain and not
    // about the lookup having been broken.
    const ok = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
    });
    assert.equal(ok.status, 202);
  } finally {
    await plane.close();
  }
});

test("A REQUEST BODY THAT PARSES AND IS NOT AN OBJECT IS A 400 — `null` was a 500 on every write route", async () => {
  // The class sweep behind the workflow-name fix above: same question — what does an
  // attacker-chosen input produce — asked of the body instead of the path. Every write
  // route does `(await body()) as {…}` and then reads a field, and `JSON.parse("null")` is
  // `null`, so `input.workflow`, `cmd.kind` and `input.decision` are each a TypeError on
  // four bytes. Measured:
  //
  //     POST /runs                      null → 500 E_INTERNAL "Cannot read properties of null (reading 'workflow')"
  //     POST /runs/:id/commands         null → 500 E_INTERNAL "… (reading 'kind')"
  //     POST /runs/:id/gates/:gateId    null → 500 E_INTERNAL "… (reading 'decision')"
  //     POST /runs                      "a string" / 42 / [1,2] / true → 404 `no compiled graph named ""`
  //     POST /runs/:id/commands         "a string" / 42 / [1,2] / true → 400 `unknown command "undefined"`
  //
  // The 500s are the defect; the 404 and the 400 below them are the same input answered
  // with a diagnosis of something else, which is the shape `?limit=abc → a silent 50` was
  // fixed for. `#readBody` is the one place all three go through, so the refusal lives
  // there rather than three times.
  const h = harness();
  const graph = compileSkeleton(skeletonSpec());
  const plane = new ControlPlane({ engine: h.engine, store: h.store, bus: h.bus, graphs: { "skeleton-summarize": graph } });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const sub = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
    });
    const runId = String((await json(sub))["runId"]);
    for (let i = 0; i < 200; i++) {
      if ((await h.engine.projection(runId as RunId))?.status === "awaiting_gate") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const gateId = (await h.engine.openGates(runId as RunId))[0]!.gateId;

    for (const path of ["/runs", `/runs/${runId}/commands`, `/runs/${runId}/gates/${gateId}`]) {
      for (const body of ["null", '"a string"', "42", "[1,2]", "true"]) {
        const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
        assert.equal(res.status, 400, `POST ${path} with body ${body}`);
        assert.equal(((await json(res))["error"] as { code: string }).code, CODES.E_PROVIDER_BAD_REQUEST, `POST ${path} body ${body}`);
      }
    }
    // An EMPTY body is not a malformed one — it means "no fields", which those routes then
    // diagnose themselves — and `{}` is an object.
    const empty = await fetch(`${base}/runs/${runId}/commands`, { method: "POST" });
    assert.equal(empty.status, 400);
    assert.match(((await json(empty))["error"] as { message: string }).message, /unknown command/, "an empty body still reaches the route");
  } finally {
    await plane.close();
  }
});

test("`inputs` THAT IS NOT A CHANNEL MAP IS REFUSED AT THE API TOO — the CLI door already refuses it", async () => {
  // `runInputs` in `cli.ts` says it in its own docstring: "An ARRAY and `null` parse
  // cleanly and are refused too: `inputs` is a channel map, the signature says
  // `Record<string, unknown>`, and a cast is not a check." The HTTP door had the cast and
  // not the check, which is the Traps list's "a rule that holds for the door that
  // remembered it", one door over. Measured before this:
  //
  //     POST /runs {"workflow":"skeleton-summarize","inputs":[1,2]}   → 202, run started
  //     …"inputs":"hello" / 42 / null / true                          → 202, run started
  //
  // 202 means `run.submitted` and `run.compiled` are DURABLE — so an array is journaled as
  // the run's channel map and every later reader of that journal has to cope with it.
  const h = harness();
  const graph = compileSkeleton(skeletonSpec());
  const plane = new ControlPlane({ engine: h.engine, store: h.store, bus: h.bus, graphs: { "skeleton-summarize": graph } });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const post = (body: unknown): Promise<Response> =>
    fetch(`${base}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    for (const inputs of [[1, 2], "hello", 42, null, true]) {
      const res = await post({ workflow: "skeleton-summarize", inputs });
      assert.equal(res.status, 400, `inputs: ${JSON.stringify(inputs)}`);
      assert.match(((await json(res))["error"] as { message: string }).message, /inputs/, `inputs: ${JSON.stringify(inputs)}`);
    }
    // A workflow name that is not a string is the same class on the sibling field, and it
    // is the one that could REACH the journal: an object whose `toString` names a real
    // graph passes `hasOwnProperty` and is then written to `run.submitted` as `workflow`.
    for (const workflow of [42, ["skeleton-summarize"], { nope: true }, null]) {
      const res = await post({ workflow, inputs: { paths: DOCS } });
      assert.equal(res.status, 400, `workflow: ${JSON.stringify(workflow)}`);
    }
    // Absent is still legal on both — the route diagnoses the missing graph itself — and
    // the real shape still runs.
    assert.equal((await post({ workflow: "skeleton-summarize" })).status, 202);
    assert.equal((await post({ inputs: { paths: DOCS } })).status, 404);
    assert.equal((await post({ workflow: "skeleton-summarize", inputs: { paths: DOCS } })).status, 202);
  } finally {
    await plane.close();
  }
});

test("A DECISION THIS ENDPOINT CANNOT READ IS NOT AN APPROVAL — `{\"kind\":\"REJECT\"}` ran the guarded action", async () => {
  // The worst thing the class sweep found, and it is the same one line: `(await body()) as
  // { decision?: GateDecision; actor?: string }`, with `if (input.decision === undefined)`
  // as the only check. `GateDecision` is a four-member union with required fields per
  // member; a cast checks none of it, and everything downstream reads `kind === "reject"`
  // and treats the rest as go-ahead. Measured end to end on the skeleton graph, one fresh
  // run each, `guardedWrites` being whether the action BEHIND the gate really ran:
  //
  //     {"kind":"approve"}            → 200 succeeded      writes=1  gate.decided decision="approve"
  //     {"kind":"reject","reason":…}  → 200 failed         writes=0  gate.decided decision="reject"
  //     {"kind":"REJECT"}             → 200 succeeded      writes=1  gate.decided decision="REJECT"
  //     "reject"                      → 200 succeeded      writes=1  gate.decided with NO decision field
  //     {}                            → 200 succeeded      writes=1  gate.decided with NO decision field
  //     42  /  [1]                    → 200 succeeded      writes=1  gate.decided with NO decision field
  //     {"kind":"nope"}               → 200 succeeded      writes=1  gate.decided decision="nope"
  //     {"kind":"redirect"}           → 200 succeeded      writes=1
  //     {"kind":"reject"}  (no reason)→ 500 E_INTERNAL      writes=0
  //     {"kind":"edit"}    (no writes)→ 500 E_INTERNAL      writes=0
  //
  // An operator's caps-lock is an APPROVAL, and the journal records `decision: "REJECT"`
  // next to an action that happened — a word in no vocabulary, written into the audit
  // trail as the thing a human decided. D7.9's "looks supervised, is not", reached by
  // typing.
  //
  // AND THE OTHER DOOR ALREADY DOES THIS RIGHT, which is the shape the Traps list names:
  // `ownedDecision` in `run/delivery.ts` validates the union member by member for the
  // UNAUTHENTICATED callback route. The strict door was the one a stranger reaches and the
  // lax one was behind the bearer token.
  const h = harness();
  const graph = compileSkeleton(skeletonSpec());
  const plane = new ControlPlane({ engine: h.engine, store: h.store, bus: h.bus, graphs: { "skeleton-summarize": graph } });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;

  const atGateWith = async (decision: unknown): Promise<{ status: number; run: string | undefined; writes: number }> => {
    const before = h.writes.length;
    const r = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
    });
    const runId = String((await json(r))["runId"]);
    for (let i = 0; i < 200; i++) {
      if ((await h.engine.projection(runId as RunId))?.status === "awaiting_gate") break;
      await new Promise((x) => setTimeout(x, 20));
    }
    const gateId = (await h.engine.openGates(runId as RunId))[0]!.gateId;
    const res = await fetch(`${base}/runs/${runId}/gates/${gateId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    return { status: res.status, run: (await h.engine.projection(runId as RunId))?.status, writes: h.writes.length - before };
  };

  try {
    // Every shape that used to approve, plus the two that used to be 500s. All 400, all
    // with the gate still open and the guarded action not run.
    for (const decision of [
      42,
      "reject",
      [1],
      {},
      { kind: "nope" },
      { kind: "REJECT" },
      { kind: 5 },
      null,
      { kind: "reject" },
      { kind: "reject", reason: "   " },
      { kind: "edit" },
      { kind: "edit", writes: "not-an-object" },
      { kind: "redirect" },
      { kind: "redirect", take: [1, 2] },
    ]) {
      const out = await atGateWith(decision);
      const label = JSON.stringify(decision);
      assert.equal(out.status, 400, `decision ${label} must be refused`);
      assert.equal(out.run, "awaiting_gate", `decision ${label} must leave the gate OPEN`);
      assert.equal(out.writes, 0, `decision ${label} must not run the action behind the gate`);
    }

    // And all four legal members still work, so this is a vocabulary check and not a wall.
    assert.deepEqual(await atGateWith({ kind: "approve" }), { status: 200, run: "succeeded", writes: 1 });
    assert.deepEqual(await atGateWith({ kind: "reject", reason: "not today" }), { status: 200, run: "failed", writes: 0 });
    assert.equal((await atGateWith({ kind: "redirect", take: ["e2"] })).status, 200);
  } finally {
    await plane.close();
  }
});

test("A cancel/rewind `reason` IS JOURNALED, so it has to be a string", async () => {
  // `engine.cancel(runId, cmd.reason ?? "operator")` writes `reason` into
  // `operator.command`'s payload and interpolates it into every gate cancellation the tree
  // produces. It came off the same cast as `decision`, so an object or an array went into
  // the journal as the reason a run was stopped.
  const h = harness();
  const graph = compileSkeleton(skeletonSpec());
  const plane = new ControlPlane({ engine: h.engine, store: h.store, bus: h.bus, graphs: { "skeleton-summarize": graph } });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
    });
    const runId = String((await json(r))["runId"]);
    for (const reason of [{ evil: true }, [1, 2], 42, true]) {
      for (const cmd of [{ kind: "cancel", reason }, { kind: "rewind", atSeq: 2, reason }]) {
        const res = await fetch(`${base}/runs/${runId}/commands`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(cmd),
        });
        assert.equal(res.status, 400, `${cmd.kind} reason ${JSON.stringify(reason)}`);
      }
    }
    // Absent is legal — it defaults to "operator" — and a real string still cancels.
    assert.equal((await fetch(`${base}/runs/${runId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "cancel", reason: "by hand" }),
    })).status, 200);
  } finally {
    await plane.close();
  }
});

test("A `limit` THE STORE CANNOT HONOUR IS A 400 — not a silent 50, not a 500, and not every run", async () => {
  // `Number(url.searchParams.get("limit") ?? "50")` then
  // `store.listRuns(Number.isFinite(limit) ? limit : 50)`. The guard checks FINITENESS,
  // which is the one property a `LIMIT` clause does not care about, so it rejected `abc`
  // by quietly substituting 50 and passed everything else straight through to SQL.
  //
  // Measured against both stores, six runs in each:
  //
  //     ?limit=abc  → SqliteStateStore 6   MemoryStateStore 6   (the guard's silent 50)
  //     ?limit=-1   → SqliteStateStore 6   MemoryStateStore 5
  //     ?limit=1.5  → SqliteStateStore THREW "datatype mismatch"   MemoryStateStore 1
  //     ?limit=1e21 → SqliteStateStore THREW "datatype mismatch"
  //
  // Three different defects on one line. `-1` is `LIMIT -1`, which SQLite reads as NO
  // LIMIT — the page size a caller asked for, removed by the caller — while the memory
  // store reads it as `slice(0, -1)` and silently drops the last run, so the same request
  // has two answers and neither is the one asked for. `1.5` reaches the real store as a
  // `datatype mismatch`, which `#dispatch` maps to a 500: "a bug in Loom" for a query
  // string. And `abc` becoming 50 is the shape this whole wave is about — a malformed
  // input answered with a plausible success.
  const h = harness();
  const graph = compileSkeleton(skeletonSpec());
  const plane = new ControlPlane({ engine: h.engine, store: h.store, bus: h.bus, graphs: { "skeleton-summarize": graph } });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 3; i++) await h.engine.submit({ graph, inputs: { paths: DOCS }, workflow: "skeleton-summarize" });

    for (const bad of ["abc", "-1", "1.5", "1e21", "", " ", "Infinity", "0x2"]) {
      const res = await fetch(`${base}/runs?limit=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `?limit=${bad} must be refused, not guessed at`);
      assert.equal(((await json(res))["error"] as { code: string }).code, CODES.E_PROVIDER_BAD_REQUEST, bad);
    }

    // The legal ones keep working, including the two boundaries a ceiling could break.
    for (const [q, n] of [["", 3], ["?limit=2", 2], ["?limit=0", 0], ["?limit=1000", 3]] as const) {
      const res = await fetch(`${base}/runs${q}`);
      assert.equal(res.status, 200, q);
      assert.equal(((await json(res))["runs"] as unknown[]).length, n, `${q || "(default)"} → ${n}`);
    }
  } finally {
    await plane.close();
  }
});

test("A `Last-Event-ID` THAT IS NOT A SEQ GETS A SNAPSHOT — the gap-free contract has no fractional case", async () => {
  // Contract 2 in this file's module docstring is "**Reconnect is gap-free** … 'did I miss
  // anything?' is always answerable. The client never has to guess." `!Number.isFinite`
  // was written for `abc` and sends it down the snapshot branch, which is the right
  // answer: a `snapshot` frame is a baseline the client can SEE it received. Every other
  // malformed id stayed on the replay branch and was handed to `store.read(runId,
  // lastSeq + 1)` as an offset.
  //
  // Measured on a run with 88 events:
  //
  //     Last-Event-ID: 1     → 87 event frames (seqs 2…88)
  //     Last-Event-ID: 1.5   → 86 event frames (seqs 3…88), 200, no marker of any kind
  //     Last-Event-ID: abc   → 1 snapshot frame
  //
  // Event 2 is gone and the stream says it is a continuation. On the SQLite store the same
  // offset returns nothing at all. The fix is to widen the guard the fractional case
  // slipped past, not to add a second one: an id that is not a whole seq is not an id.
  const h = harness();
  const graph = compileSkeleton(skeletonSpec());
  const plane = new ControlPlane({ engine: h.engine, store: h.store, graphs: { "skeleton-summarize": graph } });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const runId = await h.engine.submit({ graph, inputs: { paths: DOCS }, workflow: "skeleton-summarize" });
    await h.engine.advance(runId);
    const head = await h.store.head(runId);
    assert.ok(head > 3, `the run has events to miss (${head})`);

    // No bus, so the handler ends the response after the replay or the snapshot.
    const frames = async (id: string): Promise<string[]> => {
      const text = await (await fetch(`${base}/runs/${String(runId)}/events`, { headers: { "last-event-id": id } })).text();
      return [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]!);
    };

    const one = await frames("1");
    assert.deepEqual([...new Set(one)], ["event"], "a whole seq still replays");
    assert.equal(one.length, head - 1);

    for (const bad of ["1.5", "-3", "abc", "1e400", "0.5", "9007199254740993"]) {
      assert.deepEqual(await frames(bad), ["snapshot"], `Last-Event-ID: ${JSON.stringify(bad)} is not a seq`);
    }

    // AND THE WIDENED GUARD TESTED THE NUMBER `Number()` PRODUCED, NOT WHAT A SEQ IS — which
    // is the rule the docstring above `#streamEvents` states and the parse below it did not
    // implement. `Number` accepts hex, exponent, a leading sign, a trailing `.0` and
    // surrounding whitespace, and every one of those comes back a whole number in range, so
    // it sails through `Number.isSafeInteger(v) && v >= 0 && v <= head` and becomes an
    // OFFSET. Measured on this run: `0x58` → 88, `8e1` → 80, `+88` → 88, `88.0` → 88,
    // `" 88 "` → 88. None of them is an id this server ever issued: `write` emits
    // `id: ${seq}` for a number, so every id a client can legitimately echo back is decimal
    // digits and nothing else.
    for (const coerced of ["0x58", "8e1", "+88", "88.0", "Infinity", "1e2"]) {
      assert.deepEqual(
        await frames(coerced),
        ["snapshot"],
        `Last-Event-ID: ${JSON.stringify(coerced)} coerces to ${Number(coerced)} and was read as a seq`,
      );
    }
    // The whitespace pair goes through the QUERY parameter, because `node:http` strips
    // optional whitespace around a header value before this code ever sees it.
    const viaQuery = async (raw: string): Promise<string[]> => {
      const text = await (await fetch(`${base}/runs/${String(runId)}/events?lastEventId=${encodeURIComponent(raw)}`)).text();
      return [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]!);
    };
    assert.deepEqual(await viaQuery(" 88 "), ["snapshot"], "padding is not a seq either");
    assert.deepEqual(await viaQuery("\t3\n"), ["snapshot"]);
    assert.deepEqual([...new Set(await viaQuery("3"))], ["event"], "…and the same digits without it still replay");

    // 0 is a real id — "I have nothing, replay from the start" — and must not be swept up
    // by a guard aimed at the malformed ones. Neither may an EMPTY header, which a client
    // sends when it has no id yet and which means the same thing.
    assert.equal((await frames("0")).length, head, "0 replays everything");
    assert.equal((await frames("")).length, head, "an empty Last-Event-ID is 'from the beginning', not 'malformed'");
    assert.equal((await viaQuery("")).length, head, "…and so is an empty query parameter");
  } finally {
    await plane.close();
  }
});

test("A `Last-Event-ID` AHEAD OF HEAD GETS A SNAPSHOT **AND THEN THE TAIL** — the branch was half the defect", async () => {
  // The sibling above widened the guard from `!Number.isFinite` to "a whole number from 0
  // up", which is the right question about the SHAPE of an id and the whole question only
  // if every well-formed id was one this run issued. It was not. `head - lastSeq > hot` is
  // FALSE for a `lastSeq` above `head` — the difference is negative — so an id ahead of
  // head took the REPLAY branch, `store.read(runId, lastSeq + 1)` returned nothing, and the
  // live tail's `if (e.seq <= lastSeq) continue` then skipped every event the run went on
  // to produce. Measured on a run parked at a gate with head 88, two clients reconnecting
  // at the same instant, the gate then answered (head 88 → 102):
  //
  //     Last-Event-ID: 88        (caught up)      → 14 frames, 0 snapshot
  //     Last-Event-ID: 5000088   (ahead of head)  → 0 frames, 0 snapshot
  //
  // Same status, same headers, no snapshot, no error: byte-identical to the legitimately
  // caught-up reconnect, and the client silently missed the rest of the run. That is the
  // one outcome contract 2 rules out — "the client NEVER silently misses events".
  //
  // THE ENTRY NAMED TWO HALVES AND THE `resumable` GUARD CLOSED ONE, WHICH IS WHY THIS TEST
  // NOW ASSERTS ON THE FRAME COUNT AND NOT ONLY ON FRAME ZERO. The guard decides a BRANCH;
  // `if (e.seq <= lastSeq) continue` is a second use of the same number forty lines past the
  // branch, so the ahead-of-head client got its snapshot and then had every subsequent event
  // skipped for being `<= 5000088`. Re-measured on this rig against the guard-only fix:
  //
  //     Last-Event-ID: 88        (caught up)      → 14 frames, 0 snapshot
  //     Last-Event-ID: abc       (not a seq)      →  1 snapshot + 14 frames
  //     Last-Event-ID: 5000088   (ahead of head)  →  1 snapshot +  0 frames
  //
  // `abc` is the control and it is in this test for that reason: `NaN` loses `e.seq <=
  // lastSeq` exactly as it loses every other comparison, so the malformed id was tailing
  // correctly the whole time and only the well-formed-but-impossible one was not. A baseline
  // followed by an invisible gap is still the contract broken; it is merely a politer way of
  // breaking it.
  const h = harness();
  const graph = compileSkeleton(skeletonSpec());
  const plane = new ControlPlane({ engine: h.engine, store: h.store, bus: h.bus, graphs: { "skeleton-summarize": graph } });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;

  /**
   * One SSE connection, collected for a fixed window and then cut.
   *
   * Raw socket rather than `readSse` on purpose: the defect's signature is a stream that
   * delivers NOTHING, and a reader that blocks on the first frame turns the red case into
   * a hang instead of a failure.
   */
  const collect = (query: string, ms: number, runId: string): { done: Promise<string[]>; sock: ReturnType<typeof connect> } => {
    let text = "";
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(`GET /runs/${runId}/events${query} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    sock.on("data", (c) => (text += String(c)));
    sock.on("error", () => undefined);
    const done = new Promise<string[]>((resolve) =>
      setTimeout(() => {
        sock.destroy();
        resolve([...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]!));
      }, ms),
    );
    return { done, sock };
  };

  try {
    const runId = await h.engine.submit({ graph, inputs: { paths: DOCS }, workflow: "skeleton-summarize" });
    await h.engine.advance(runId);
    const head = await h.store.head(runId);
    assert.equal((await h.engine.projection(runId))?.status, "awaiting_gate", "the run is parked, so there is a tail to miss");

    // Three clients reconnect before anything else happens. The third asks with an id that is
    // not a seq at all, and it is the CONTROL: it takes the same snapshot branch through a
    // different door, so whatever it receives after the baseline is what the ahead-of-head
    // client must receive too.
    const caughtUp = collect(`?lastEventId=${head}`, 1200, String(runId));
    const ahead = collect(`?lastEventId=${head + 5_000_000}`, 1200, String(runId));
    const notASeq = collect(`?lastEventId=abc`, 1200, String(runId));
    await new Promise((r) => setTimeout(r, 250));

    const gateId = (await h.engine.openGates(runId))[0]!.gateId;
    await h.engine.resolveGate(runId, {
      gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:alice", via: "cli" },
      idempotencyKey: "ahead-of-head",
    });
    const [caught, missed, control] = await Promise.all([caughtUp.done, ahead.done, notASeq.done]);

    assert.ok(await h.store.head(runId) > head, "the run really did produce more events");
    assert.ok(caught.length > 0, `the caught-up client saw the tail (${caught.length} frames)`);
    // FIRST HALF. An id this run never issued must be answered with a BASELINE the
    // client can see it received, exactly as `abc` is — not with a continuation of nothing.
    assert.equal(missed[0], "snapshot", "an id ahead of head gets a snapshot, not a silent empty continuation");
    assert.notDeepEqual(missed, [], "and it is never byte-identical to a caught-up reconnect");
    // SECOND HALF, and it is the one the branch fix could not reach. The baseline is worth
    // nothing if the live tail then drops everything that follows it, and that is exactly
    // what a second read of the unvalidated id did. Compared against the control rather than
    // against a literal, so this asserts the PROPERTY — two clients on the snapshot branch see
    // the same run — and not a frame count that changes when the skeleton graph does.
    assert.equal(control[0], "snapshot", "the control took the snapshot branch too, or it is not a control");
    assert.deepEqual(missed, control, `an ahead-of-head client got its baseline and then missed the tail (${missed.length} vs ${control.length})`);
    assert.equal(missed.length, caught.length + 1, "snapshot plus every frame the caught-up client saw");
  } finally {
    await plane.close();
  }
});

test("THE GATE-PAYLOAD JOIN SWALLOWS ONE ERROR, NOT ALL OF THEM — a broken broker is not an empty queue", async () => {
  // `GET /runs/:id/gates` enriches the projection's gates with the payload the broker
  // still holds, under `engine.openGates(runId).catch(() => [])`. Exactly one error
  // belongs in that catch: `E_RUN_NOT_FOUND`, thrown when the run is not attached to this
  // engine, which is the ORDINARY state after a restart — the gates are durable and the
  // rendered payloads were only ever in memory. Every other error was taken by the same
  // line, so a broker read that FAILED produced the identical 200: a gate list with no
  // questions on it, which is what a healthy restarted process also serves.
  //
  // That is this wave's shape in its plainest form — a failure and a normal condition
  // rendered the same — and it is a place a reader has no way to tell them apart, because
  // the honest answer for one of them is a degraded success.
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);
    const healthy = await fetch(`${r.base}/runs/${String(runId)}/gates`);
    assert.equal(healthy.status, 200);
    const gates = (await json(healthy))["gates"] as { payload?: unknown }[];
    assert.equal(gates.length, 1, "one open gate");
    assert.notEqual(gates[0]?.payload, undefined, "with the question on it");

    // The broker's read fails for a reason that is NOT "this engine has never seen the
    // run". A `Proxy` rather than a stub engine, so every other method is the real one and
    // this test cannot pass by accident on a plane that never reached the broker at all.
    const broken = new Proxy(r.h.engine, {
      get(t, k, recv): unknown {
        if (k === "openGates") return () => Promise.reject(new LoomError("internal", CODES.E_INTERNAL, "the broker's log read failed"));
        const v = Reflect.get(t, k, recv) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const plane = new ControlPlane({ engine: broken, store: r.h.store, bus: r.h.bus, graphs: {} });
    const { port } = await plane.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/runs/${String(runId)}/gates`);
      assert.equal(res.status, 500, "a broken broker is a 500, not a queue with the questions missing");
      assert.equal(((await json(res))["error"] as { code: string }).code, CODES.E_INTERNAL);
    } finally {
      await plane.close();
    }
  } finally {
    await r.close();
  }
});

test("A `kind` A BEARER FILE MISTYPED IS NOT A PERSON — an unrecognized one is refused, never defaulted", async () => {
  // `BearerSubject.kind` defaults to `human`, which is right for an ABSENT field and wrong
  // for a mistyped one, because the two were indistinguishable: `kind ?? "human"`.
  // `checkedAuth` in this same file states the rule it broke — "fields that DECIDE —
  // `subject` and `kind` — are refused when wrong … picking one writes a name into an
  // audit record on the strength of a bug" — and `kind` decides exactly one thing: whether
  // this credential can satisfy a gate's approvers list.
  //
  // Reproduced through `readIdentities` (cli.ts), which drops an unrecognized `kind` the
  // way it drops an unrecognized `via`, leaving `undefined` for the `??` to answer:
  //
  //     kind "service" → service   (can satisfy an approvers list: false)
  //     kind "servce"  → human     (can satisfy an approvers list: TRUE)
  //     kind "SERVICE" → human     (can satisfy an approvers list: TRUE)
  //     kind 1 / null  → human     (can satisfy an approvers list: TRUE)
  //
  // One transposed letter turns a deployment's CI credential into a person who can approve
  // production actions, and every surface — `/whoami`, the journal, the console — reports
  // it as a human because by then it is one. Dropping `via` is safe because the value it
  // falls back to (`api`) is TRUE; dropping `kind` is not, because the value it falls back
  // to is a stronger claim than the one that was written.
  for (const bad of ["servce", "SERVICE", "machine", "", 1, null, {}]) {
    assert.throws(
      () => new BearerTokenIdentity({ subjects: [{ token: "t0ken", subject: "svc:ci", kind: bad as never }] }),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /kind/.test(e.message),
      `kind ${JSON.stringify(bad)}`,
    );
  }
  // ABSENT still means `human`, which is the documented default and the common case.
  const src = new BearerTokenIdentity({
    subjects: [
      { token: "human-token", subject: "u:alice" },
      { token: "service-token", subject: "svc:ci", kind: "service" },
    ],
  });
  const who = (t: string): AuthContext | undefined =>
    src.identify({ method: "GET", path: "/runs", headers: { authorization: `Bearer ${t}` } }) as AuthContext | undefined;
  assert.equal(who("human-token")?.kind, "human", "an absent kind is a person, as documented");
  assert.equal(who("service-token")?.kind, "service");
});

// ── submit: what is durable at ACK ───────────────────────────────────────────

test("202 states exactly what is durable, and it is not execution", async () => {
  const r = await rig();
  try {
    const body = await submit(r);
    assert.deepEqual(body["durable"], ["run.submitted", "run.compiled"]);
    assert.match(String(body["note"]), /WILL run, not that it HAS run/);
    assert.match(String(body["graphHash"]), /^sha256:/);
  } finally {
    await r.close();
  }
});

test("the journal really does contain those events at ACK", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    const p = await r.h.engine.projection(runId as never);
    assert.ok(p, "the run exists the moment the client is told 202");
    assert.equal(p.graphHash, compileSkeleton().graphHash);
  } finally {
    await r.close();
  }
});

test("a duplicate Idempotency-Key returns the ORIGINAL runId and creates nothing", async () => {
  const r = await rig();
  try {
    const first = await submit(r, { "idempotency-key": "abc" });
    const second = await submit(r, { "idempotency-key": "abc" });
    assert.equal(first["runId"], second["runId"]);
    const runs = (await json(await fetch(`${r.base}/runs`)))["runs"] as unknown[];
    assert.equal(runs.length, 1, "one run, not two");
  } finally {
    await r.close();
  }
});

test("TWO PRINCIPALS SHARING AN Idempotency-Key GET TWO RUNS, NOT ONE ANOTHER'S", async () => {
  // `Idempotency-Key` is chosen by the caller, and the map was keyed on it alone. That was
  // sound while the plane had exactly one principal, and became a cross-principal
  // collision the moment it had per-subject ones: whoever submitted second was handed the
  // first's `runId` — and with it the projection and the event stream of a run they did
  // not submit — while their own submission was silently dropped.
  //
  // "nightly" is not a contrived collision. It is what two teams independently call their
  // nightly job.
  const r = await rig({ identity: people() });
  const asAlice = { authorization: "Bearer alice-token" };
  const asCi = { authorization: "Bearer ci-token" };
  const listAs = async (headers: Record<string, string>): Promise<unknown[]> =>
    (await json(await fetch(`${r.base}/runs`, { headers })))["runs"] as unknown[];
  try {
    const hers = await submit(r, { ...asAlice, "idempotency-key": "nightly" });
    const theirs = await submit(r, { ...asCi, "idempotency-key": "nightly" });
    assert.notEqual(hers["runId"], theirs["runId"], "svc:ci must not be handed u:alice's run");
    assert.equal((await listAs(asAlice)).length, 2, "…and both submissions really happened");

    // The property the key exists for is untouched: the SAME principal retrying is one run.
    const retry = await submit(r, { ...asAlice, "idempotency-key": "nightly" });
    assert.equal(retry["runId"], hers["runId"]);
    assert.equal((await listAs(asAlice)).length, 2, "a retry still creates nothing");
  } finally {
    await r.close();
  }
});

test("an unknown workflow is a clean 404", async () => {
  const r = await rig();
  try {
    const res = await fetch(`${r.base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "nope", inputs: {} }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await json(res))["error"] as { code: string }).code, "E_RESOURCE_NOT_FOUND");
  } finally {
    await r.close();
  }
});

test("malformed JSON and oversized bodies are rejected with 400", async () => {
  const r = await rig();
  try {
    const bad = await fetch(`${r.base}/runs`, { method: "POST", body: "{not json" });
    assert.equal(bad.status, 400);
  } finally {
    await r.close();
  }
});

// ── reading a run ────────────────────────────────────────────────────────────

test("a run's projection is readable and reaches its gate", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);
    const p = await json(await fetch(`${r.base}/runs/${String(runId)}`));
    assert.equal(p["status"], "awaiting_gate");
    assert.equal((p["gates"] as unknown[]).length, 1);
    assert.equal((p["tasks"] as unknown[]).length > 5, true, "the fan-out is visible as separate tasks");
  } finally {
    await r.close();
  }
});

test("an unknown run is 404 with a typed error body", async () => {
  const r = await rig();
  try {
    const res = await fetch(`${r.base}/runs/01JNOPE`);
    assert.equal(res.status, 404);
    assert.equal(((await json(res))["error"] as { code: string }).code, "E_RUN_NOT_FOUND");
  } finally {
    await r.close();
  }
});

// ── gates over HTTP ──────────────────────────────────────────────────────────

test("a gate can be listed and resolved through the API", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);

    const gates = (await json(await fetch(`${r.base}/runs/${String(runId)}/gates`)))["gates"] as { gateId: string }[];
    assert.equal(gates.length, 1);

    const res = await fetch(`${r.base}/runs/${String(runId)}/gates/${gates[0]!.gateId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: { kind: "approve" } }),
    });
    assert.equal(res.status, 200);
    assert.equal((await json(res))["status"], "succeeded");
    assert.equal(r.h.writes.length, 1, "approving over HTTP really ran the write");
  } finally {
    await r.close();
  }
});

test("rejecting over HTTP fails the run and writes nothing", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);
    const gates = (await json(await fetch(`${r.base}/runs/${String(runId)}/gates`)))["gates"] as { gateId: string }[];

    const res = await fetch(`${r.base}/runs/${String(runId)}/gates/${gates[0]!.gateId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: { kind: "reject", reason: "not good enough" } }),
    });
    assert.equal((await json(res))["status"], "failed");
    assert.equal(r.h.writes.length, 0);
  } finally {
    await r.close();
  }
});

// ── who the control plane thinks you are ─────────────────────────────────────
//
// The subject an approvers list is matched against is an AUTHORIZATION KEY. It used to
// be read out of the request body, which made every gate that named an approver both
// unanswerable from the shipped console and trivially answerable by anyone who could
// reach the port. These pin the two halves apart: identity comes from the credential,
// and a credential that names no person can never satisfy an approvers list.

/** Drive a run to its gate and return the gate id. */
async function atGate(r: Rig, token?: string): Promise<{ runId: string; gateId: GateId }> {
  const { runId } = await submit(r, token === undefined ? {} : { authorization: `Bearer ${token}` });
  await settle(r, runId as string);
  const gateId = (await r.h.engine.openGates(runId as RunId))[0]!.gateId;
  return { runId: String(runId), gateId };
}

function decide(
  r: Rig,
  at: { runId: string; gateId: GateId },
  body: Record<string, unknown>,
  token?: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${r.base}/runs/${at.runId}/gates/${at.gateId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

async function decidedBy(r: Rig, runId: string): Promise<readonly Actor[]> {
  return (await journal(r, runId)).filter((e) => e.type === "gate.decided").map((e) => e.actor);
}

test("THE APPROVER'S IDENTITY CANNOT BE TYPED INTO THE REQUEST BODY", async () => {
  // The reproduction, verbatim: one shared service token, a gate that names the security
  // lead, and a body that claims to be them. The caller proved possession of a credential
  // every service in the deployment holds and nothing else.
  const r = await rig({ token: "shared-service-token", approvers: ["u:security-lead"] });
  try {
    const at = await atGate(r, "shared-service-token");
    const res = await decide(r, at, { decision: { kind: "approve" }, actor: "u:security-lead" }, "shared-service-token");

    assert.equal(res.status, 403);
    const p = await r.h.engine.projection(at.runId as RunId);
    assert.equal(p?.gates[at.gateId]?.state, "open", "the gate is still waiting for a human");
    assert.equal(r.h.writes.length, 0, "and the action behind it did not run");
    assert.deepEqual(await decidedBy(r, at.runId), [], "the journal does not name the security lead");
  } finally {
    await r.close();
  }
});

test("a body `actor` is refused even when the gate names nobody", async () => {
  // Not "ignored". A client that sends an identity is asserting something about who is
  // deciding, and the honest answer is that this endpoint cannot honour the assertion —
  // silently dropping it would leave the client believing its audit trail says a name.
  const r = await rig();
  try {
    const at = await atGate(r);
    const res = await decide(r, at, { decision: { kind: "approve" }, actor: "u:alice" });
    assert.equal(res.status, 403);
    assert.match(String(((await json(res))["error"] as { message: string }).message), /body/i);
    assert.equal(r.h.writes.length, 0);
  } finally {
    await r.close();
  }
});

test("A GATE THAT NAMES APPROVERS IS UNANSWERABLE WHEN NOTHING CAN ESTABLISH IDENTITY", async () => {
  // Fail closed, and say which knob is missing. The alternative — letting the shared
  // token stand in for a person — is D7.9's "looks supervised, is not".
  const r = await rig({ token: "shared-service-token", approvers: ["u:security-lead"] });
  try {
    const at = await atGate(r, "shared-service-token");
    const res = await decide(r, at, { decision: { kind: "approve" } }, "shared-service-token");

    assert.equal(res.status, 403);
    const error = (await json(res))["error"] as { code: string; message: string };
    assert.equal(error.code, "E_GATE_NOT_AUTHORIZED");
    assert.match(error.message, /identity source/, "the error names the misconfiguration");
    assert.match(error.message, /identity/i);
    assert.deepEqual(await decidedBy(r, at.runId), []);
  } finally {
    await r.close();
  }
});

test("A GATE THAT NAMES NOBODY STAYS ANSWERABLE, and is journaled honestly", async () => {
  // "A human at the API whose identity this deployment cannot establish" is a true
  // statement, and the only honest one available. It must not be dressed up as a name —
  // `unknown` reads like a subject id and would match an approvers list that contained it.
  const r = await rig();
  try {
    const at = await atGate(r);
    assert.equal((await decide(r, at, { decision: { kind: "approve" } })).status, 200);
    assert.deepEqual(await decidedBy(r, at.runId), [{ kind: "human", subject: "(unidentified)", via: "api" }]);
    assert.equal(r.h.writes.length, 1);
  } finally {
    await r.close();
  }
});

/** Per-subject tokens, which is what a deployment without an SSO actually has. */
const people = (): IdentitySource =>
  new BearerTokenIdentity({
    subjects: [
      { token: "lead-token", subject: "u:security-lead", via: "console" },
      { token: "alice-token", subject: "u:alice" },
      { token: "ci-token", subject: "svc:ci", kind: "service" },
    ],
  });

test("THE NAMED APPROVER, WITH THEIR OWN CREDENTIAL, DECIDES — and the journal says so", async () => {
  const r = await rig({ identity: people(), approvers: ["u:security-lead"] });
  try {
    const at = await atGate(r, "lead-token");
    assert.equal((await decide(r, at, { decision: { kind: "approve" } }, "lead-token")).status, 200);
    assert.deepEqual(await decidedBy(r, at.runId), [
      // `via` comes from the identity source, not from a guess about the caller: this
      // deployment says the lead's token is a console session, so that is what is recorded.
      { kind: "human", subject: "u:security-lead", via: "console" },
    ]);
    assert.equal(r.h.writes.length, 1);
  } finally {
    await r.close();
  }
});

test("an identified human the gate does NOT name is still refused", async () => {
  const r = await rig({ identity: people(), approvers: ["u:security-lead"] });
  try {
    const at = await atGate(r, "alice-token");
    const res = await decide(r, at, { decision: { kind: "approve" } }, "alice-token");
    assert.equal(res.status, 403);
    const error = (await json(res))["error"] as { code: string; message: string };
    assert.equal(error.code, "E_GATE_NOT_AUTHORIZED");
    assert.match(error.message, /u:alice/, "the broker refuses her by name, not as (unidentified)");
    assert.equal(r.h.writes.length, 0);
  } finally {
    await r.close();
  }
});

test("a SERVICE identity is not a person either, however well named", async () => {
  // `svc:ci` is a real subject with its own credential — and still not a human. A gate
  // that names approvers must not be answerable by a job.
  const r = await rig({ identity: people(), approvers: ["u:security-lead"] });
  try {
    const at = await atGate(r, "ci-token");
    const res = await decide(r, at, { decision: { kind: "approve" } }, "ci-token");
    assert.equal(res.status, 403);
    assert.match(String(((await json(res))["error"] as { message: string }).message), /identifies no person/);
  } finally {
    await r.close();
  }
});

test("a body `actor` that AGREES with the credential is not a lie, and is allowed", async () => {
  const r = await rig({ identity: people(), approvers: ["u:security-lead"] });
  try {
    const at = await atGate(r, "lead-token");
    const res = await decide(r, at, { decision: { kind: "approve" }, actor: "u:security-lead" }, "lead-token");
    assert.equal(res.status, 200);
  } finally {
    await r.close();
  }
});

test("ONE PERSON'S CREDENTIAL CANNOT BE SPENT UNDER ANOTHER'S NAME", async () => {
  const r = await rig({ identity: people(), approvers: ["u:security-lead", "u:alice"] });
  try {
    const at = await atGate(r, "alice-token");
    const res = await decide(r, at, { decision: { kind: "approve" }, actor: "u:security-lead" }, "alice-token");
    assert.equal(res.status, 403);
    assert.match(String(((await json(res))["error"] as { message: string }).message), /authenticates "u:alice"/);
    assert.deepEqual(await decidedBy(r, at.runId), [], "…even though her token WOULD have been accepted as herself");
  } finally {
    await r.close();
  }
});

test("THE IDEMPOTENCY KEY COMES FROM THE CREDENTIAL, so a second decider gets a conflict", async () => {
  // The fallback key used to interpolate the body's `actor`, so the same gate could be
  // decided twice under two invented names. Two real people now collide on the gate's
  // state instead, which is the answer a second approver should get.
  //
  // Both send the SAME `Idempotency-Key`, which is the cross-principal shape: the key is a
  // caller-chosen string, so if it were the whole key Alice's rejection would be swallowed
  // as "already handled" and answered 200 for a decision that was never hers. It is not —
  // `HumanGateBroker.resolve` prefixes the gate and the RESOLVED SUBJECT — and this is
  // where that stays true.
  const r = await rig({ identity: people(), approvers: ["u:security-lead", "u:alice"] });
  try {
    const at = await atGate(r, "lead-token");
    const shared = { "idempotency-key": "approve-the-thing" };
    assert.equal((await decide(r, at, { decision: { kind: "approve" } }, "lead-token", shared)).status, 200);
    const second = await decide(r, at, { decision: { kind: "reject", reason: "no" } }, "alice-token", shared);
    assert.equal(second.status, 409, "a conflict she can see, not a 200 for someone else's decision");
    assert.equal((await decidedBy(r, at.runId)).length, 1);
  } finally {
    await r.close();
  }
});

test("THE GATE'S IDEMPOTENCY KEY DOES NOT CHANGE BECAUSE THE BODY DID", async () => {
  // The property the derived key actually claims, and the one the old body-derived
  // `${gateId}:${body.actor}` breaks: the SAME person sending the SAME decision twice,
  // spelling the body differently, is one decision and one 200.
  //
  // The previously-claimed cover — "a second decider gets 409" — passes with the old key
  // restored, because two different people never shared a key under either scheme. This
  // one is one person, and it is red under the old key: the retry arrives under a second
  // key, is therefore not a retry, and the client is told its own approval conflicts.
  const r = await rig({ identity: people(), approvers: ["u:security-lead"] });
  try {
    const at = await atGate(r, "lead-token");
    assert.equal((await decide(r, at, { decision: { kind: "approve" } }, "lead-token")).status, 200);
    const retry = await decide(r, at, { decision: { kind: "approve" }, actor: "u:security-lead" }, "lead-token");
    assert.equal(retry.status, 200, "a retry, not a conflict with itself");
    assert.equal((await decidedBy(r, at.runId)).length, 1);
    assert.equal(r.h.writes.length, 1, "and the action behind the gate ran once");
  } finally {
    await r.close();
  }
});

test("/whoami answers who the credential is, and 401s without one", async () => {
  const r = await rig({ token: "shared-service-token", identity: people() });
  try {
    assert.equal((await fetch(`${r.base}/whoami`)).status, 401);

    const lead = await json(await fetch(`${r.base}/whoami`, { headers: { authorization: "Bearer lead-token" } }));
    assert.deepEqual(lead, { kind: "human", subject: "u:security-lead", method: "bearer-token", canApproveNamedGates: true, via: "console" });

    const service = await json(await fetch(`${r.base}/whoami`, { headers: { authorization: "Bearer shared-service-token" } }));
    assert.equal(service["kind"], "service");
    assert.equal(service["canApproveNamedGates"], false, "the console can tell the operator BEFORE they click approve");
  } finally {
    await r.close();
  }
});

test("/health says whether anyone can be identified at all", async () => {
  const withIdentity = await rig({ identity: people() });
  const without = await rig({ token: "shared-service-token" });
  try {
    assert.equal((await json(await fetch(`${withIdentity.base}/health`)))["identity"], "bearer-token");
    const bare = await json(await fetch(`${without.base}/health`));
    assert.equal(bare["identity"], null, "null, not absent: 'there is none' is the answer, not a missing field");
    assert.equal(bare["auth"], "required");
  } finally {
    await withIdentity.close();
    await without.close();
  }
});

test("/HEALTH IS LIVENESS: A DEAD IDENTITY PROVIDER DOES NOT PULL THE PROCESS FROM ROTATION", async () => {
  // A probe that fails when a DEPENDENCY fails is a readiness probe wearing the wrong
  // name. `/health` consulted the injected source so it could decide whether to disclose
  // `callbackRefusals`, which made an SSO outage into a load balancer draining every
  // healthy process — an outage caused by the health check rather than caught by it. It
  // also handed a stranger a way to make the deployment's identity code do network work,
  // which is the exact reasoning the callback route's carve-out is written from.
  let asked = 0;
  const broken: IdentitySource = {
    name: "flaky-sso",
    identify: () => {
      asked++;
      return Promise.reject(new LoomError("unavailable", CODES.E_PROVIDER_TRANSPORT, "sso unreachable"));
    },
  };
  const r = await rig({ identity: broken, token: "s3cret", callbacks: true });
  try {
    const probe = await fetch(`${r.base}/health`);
    assert.equal(probe.status, 200, "the process is up, and that is all this endpoint claims");
    assert.equal((await json(probe))["ok"], true);
    assert.equal(asked, 0, "the probe never reached the injected seam at all");

    // The diagnostics still reach an operator, gated on the SHARED TOKEN — a constant
    // compared in constant time, with no I/O behind it and therefore nothing to be down.
    const authed = await json(await fetch(`${r.base}/health`, { headers: { authorization: "Bearer s3cret" } }));
    assert.deepEqual(authed["callbackRefusals"], []);
    assert.equal(asked, 0, "…including for a caller who presented a credential");

    // And the outage is not hidden: every route that needs a principal still fails loudly.
    const guarded = await fetch(`${r.base}/runs`, { headers: { authorization: "Bearer s3cret" } });
    assert.equal(guarded.status, 503);
    assert.equal(asked, 1);
  } finally {
    await r.close();
  }
});

test("AN IDENTITY SOURCE WITH ONLY PER-SUBJECT TOKENS STILL CLOSES THE PERIMETER", async () => {
  // No shared token at all. The plane is not open — an unauthenticated caller gets 401
  // rather than the anonymous pass that `token === undefined` used to grant.
  const r = await rig({ identity: people() });
  try {
    assert.equal((await fetch(`${r.base}/runs`)).status, 401);
    assert.equal((await fetch(`${r.base}/runs`, { headers: { authorization: "Bearer nope" } })).status, 401);
    assert.equal((await fetch(`${r.base}/runs`, { headers: { authorization: "Bearer alice-token" } })).status, 200);
    // …and the refusal counters stay behind a credential, which they would not if
    // "no shared token" still meant "open".
    assert.equal("callbackRefusals" in (await json(await fetch(`${r.base}/health`))), false);
  } finally {
    await r.close();
  }
});

test("AN IDENTITY SOURCE THAT FAILS REFUSES THE REQUEST — it never degrades to anonymous", async () => {
  // The failure mode that would undo all of this: an SSO outage quietly turning every
  // caller into "nobody in particular", which is a caller that can still answer gates
  // naming no approvers. It must be an error, and a retryable-looking one.
  const broken: IdentitySource = {
    name: "flaky-sso",
    identify: () => Promise.reject(new LoomError("unavailable", CODES.E_PROVIDER_TRANSPORT, "sso unreachable")),
  };
  const r = await rig({ identity: broken });
  try {
    const res = await fetch(`${r.base}/runs`, { headers: { authorization: "Bearer anything" } });
    assert.equal(res.status, 503);
    assert.equal(((await json(res))["error"] as { code: string }).code, "E_PROVIDER_TRANSPORT");
  } finally {
    await r.close();
  }
});

test("AN IDENTITY SOURCE'S OUTPUT IS VALIDATED — it is injected code, not a trusted caller", async () => {
  // `IdentitySource` sits on the far side of the same boundary as `DeliveryChannel`, and
  // TypeScript stops applying at a seam. What comes back is an AUTHORIZATION KEY: it is
  // matched against approvers lists and written into the journal as the subject of a
  // decision. A non-string subject, an empty one, or a third `kind` has no safe reading,
  // so it is refused here rather than folded into an audit record.
  const returning = (who: unknown): IdentitySource => ({ name: "bad-sso", identify: () => who as AuthContext });
  const cases: readonly (readonly [string, unknown])[] = [
    ["a non-string subject", { kind: "human", subject: 42, method: "bad-sso" }],
    ["an empty subject", { kind: "human", subject: "", method: "bad-sso" }],
    ["no subject at all", { kind: "human", method: "bad-sso" }],
    ["a kind that is neither human nor service", { kind: "admin", subject: "u:alice", method: "bad-sso" }],
    ["something that is not an object", "u:alice"],
    // `typeof x !== "object"` ADMITS ALL FOUR OF THESE, which is the reflex this
    // programme keeps finding. None of them reaches anything: `checkedAuth` reads named
    // fields off whatever it was given and every one of these answers `undefined` for
    // `subject`, so they are refused by the field checks rather than by the shape check.
    // Written down because "it happens to be caught one line later" is a property worth
    // holding, not one worth re-deriving.
    ["an array", ["u:alice"]],
    ["a Map, whose entries are not properties", new Map([["subject", "u:alice"], ["kind", "human"]])],
    ["a Date", new Date(0)],
    ["a RegExp", /u:alice/],
    // The marker is the plane's own word for "nobody was identified". A source that hands
    // it back as a person turns the absence of identity into a name.
    ["the unidentified marker, claimed as a person", { kind: "human", subject: UNIDENTIFIED_SUBJECT, method: "bad-sso" }],
    // The plane's OTHER synthetic marker — and the one the first version of this check
    // forgot, because it named a single literal inline. A source returning `(shared-token)`
    // impersonates the deployment's own service principal: the subject that `#principal`
    // mints for a holder of the shared bearer token. Both markers are refused from one
    // list now, so a third cannot be forgotten either.
    ["the shared-token marker, claimed as a service", { kind: "service", subject: "(shared-token)", method: "shared-token" }],
    ["the shared-token marker, claimed as a person", { kind: "human", subject: "(shared-token)", method: "bad-sso" }],
    // A FIELD THAT DETONATES ON READ, and the three below are the reason `checkedAuth`'s
    // two DECIDING reads had to join its three DESCRIBING ones behind a total accessor.
    // The function's own comment says "a getter or a Proxy answers the two reads
    // differently … A property access at this seam is a CALL; treat it as one" — and then
    // read `raw["subject"]` and `raw["kind"]` bare. A source whose getter throws produced a
    // raw `TypeError` out of the frame instead of this contract's refusal, so the operator
    // was told `E_INTERNAL` and the getter's own words rather than "your identity source is
    // broken, and here is its name".
    [
      "a subject getter that throws",
      Object.defineProperty({ kind: "human", method: "bad-sso" }, "subject", {
        get(): string {
          throw new Error("subject getter");
        },
      }),
    ],
    [
      "a kind getter that throws",
      Object.defineProperty({ subject: "u:alice", method: "bad-sso" }, "kind", {
        get(): string {
          throw new Error("kind getter");
        },
      }),
    ],
    // …and the REFUSAL PATH is the third one, which is the quietest: `kind` is rendered into
    // the message with `JSON.stringify`, which calls a caller-supplied `toJSON`. So the
    // check fired correctly and then the sentence describing the failure detonated.
    [
      "a kind whose toJSON throws while the refusal is being written",
      {
        subject: "u:alice",
        method: "bad-sso",
        kind: {
          toJSON(): never {
            throw new Error("toJSON");
          },
        },
      },
    ],
  ];
  for (const [what, who] of cases) {
    const r = await rig({ identity: returning(who) });
    try {
      const res = await fetch(`${r.base}/whoami`, { headers: { authorization: "Bearer anything" } });
      assert.equal(res.status, 500, what);
      const error = (await json(res))["error"] as { code: string; message: string };
      assert.equal(error.code, CODES.E_CONFIG_INVALID, `${what}: the deployment's source is what is broken`);
      assert.match(error.message, /bad-sso/, `${what}: and the error names it`);
    } finally {
      await r.close();
    }
  }

  // AND THE ONE OF THE FOUR THAT IS ACCEPTED: an array carrying the right fields passes
  // every check, because every check is about the FIELDS. What must not happen is the
  // array reaching anything — `checkedAuth` builds a fresh object literal rather than
  // returning what it was handed, so the exotic prototype stops here, and that is the
  // property rather than the refusal.
  const wearingTheFields = Object.assign(["ignored"], { kind: "human", subject: "u:alice", method: "array-sso" });
  const r = await rig({ identity: { name: "array-sso", identify: () => wearingTheFields as unknown as AuthContext } });
  try {
    const res = await fetch(`${r.base}/whoami`, { headers: { authorization: "Bearer anything" } });
    assert.equal(res.status, 200);
    const who = await json(res);
    assert.equal(who["subject"], "u:alice");
    assert.equal(who["kind"], "human");
    assert.equal(who["0"], undefined, "nothing of the array survived the crossing");
  } finally {
    await r.close();
  }
});

test("a `via` outside the journal's closed vocabulary is DROPPED, not written", async () => {
  // `readIdentities` already says an unknown `via` is "dropped, not coerced" — a rule any
  // other source bypassed on its way into a `gate.decided` actor. `via` DESCRIBES rather
  // than decides, so the whole request is not refused for it: taking a deployment down
  // because its SSO invented a label is the wrong trade, and `api` is true either way.
  const inventive: IdentitySource = {
    name: "sso",
    identify: () => ({ kind: "human", subject: "u:alice", method: "sso", via: "telepathy" as HumanActor["via"] }),
  };
  const r = await rig({ identity: inventive, approvers: ["u:alice"] });
  try {
    const at = await atGate(r, "any-token");
    assert.equal((await decide(r, at, { decision: { kind: "approve" } }, "any-token")).status, 200);
    assert.deepEqual(await decidedBy(r, at.runId), [{ kind: "human", subject: "u:alice", via: "api" }]);
  } finally {
    await r.close();
  }
});

test("BearerTokenIdentity refuses a configuration that would make identity ambiguous", () => {
  assert.throws(
    () => new BearerTokenIdentity({ subjects: [{ token: "t", subject: "u:alice" }, { token: "t", subject: "u:mallory" }] }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
    "one token, two subjects — 'who approved this' would depend on insertion order",
  );
  assert.throws(
    () => new BearerTokenIdentity({ subjects: [{ token: "", subject: "u:alice" }] }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
  );
  // And the happy path really does identify.
  const source = new BearerTokenIdentity({ subjects: [{ token: "t", subject: "u:alice" }] });
  assert.equal(source.identify({ method: "POST", path: "/x", headers: { authorization: "Bearer t" } })?.subject, "u:alice");
  assert.equal(source.identify({ method: "POST", path: "/x", headers: { authorization: "Bearer t " } }), undefined);
  assert.equal(source.identify({ method: "POST", path: "/x", headers: {} }), undefined);
});

test("a deployment that cannot answer its own graphs is named at boot, by graph", () => {
  // The compile-time refusal this cannot be: whether identity exists is DEPLOYMENT
  // config, so the compiler never sees it. Boot is the first moment both halves are in
  // one process, and this is what `startControlPlane` shouts.
  const h = harness();
  const base = { engine: h.engine, store: h.store, graphs: { needs: compileSkeleton(specWithApprovers(["u:security-lead"])) } };
  assert.deepEqual(unanswerableGraphs(base), ["needs"]);
  assert.deepEqual(unanswerableGraphs({ ...base, identity: people() }), [], "with an identity source there is nothing to warn about");
  assert.deepEqual(unanswerableGraphs({ ...base, graphs: { plain: compileSkeleton() } }), [], "a graph naming nobody is answerable as ever");
});

// ── what a principal is ALLOWED to do ────────────────────────────────────────
//
// Authentication is settled: the credential decides who you are and a body cannot.
// AUTHORIZATION is a separate question and this control plane answers it with one word —
// everything. These pin that answer as a DELIBERATE, documented limit rather than an
// oversight, so that the day someone scopes runs to their submitter they have to come
// here and say so.

test("EVERY VALID CREDENTIAL IS A FULL OPERATOR CREDENTIAL — the limit, made executable", async () => {
  // `auth` is admission only. A run submitted by one principal is readable, streamable
  // and cancellable by every other principal the deployment configured, gate payloads
  // included — those are redacted per the GRAPH's declared classification, never per
  // viewer, so "everyone sees everything" is a statement about real data.
  //
  // This test PASSES today and is here to fail the moment that changes silently. Whoever
  // implements per-principal scoping rewrites it; whoever weakens it by accident does not
  // get to do so quietly. See the module docstring in `http.ts` and D3.17.
  const r = await rig({ identity: people() });
  try {
    const { runId } = await submit(r, { authorization: "Bearer alice-token" });
    await settle(r, String(runId));
    const asLead = { authorization: "Bearer lead-token" };

    assert.equal((await fetch(`${r.base}/runs/${String(runId)}`, { headers: asLead })).status, 200, "alice's run, read by the lead");
    const listed = await json(await fetch(`${r.base}/runs`, { headers: asLead }));
    assert.equal((listed["runs"] as unknown[]).length, 1, "and listed, unfiltered");

    // The gate queue, with the payload the graph declared — the thing the redaction
    // machinery exists for, and it is not scoped to the submitter either.
    const gates = await json(await fetch(`${r.base}/runs/${String(runId)}/gates`, { headers: asLead }));
    assert.equal((gates["gates"] as unknown[]).length, 1);

    // …and cancelled. A read-only sharing story would at least be arguable; this is not.
    const cancelled = await fetch(`${r.base}/runs/${String(runId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", ...asLead },
      body: JSON.stringify({ kind: "cancel", reason: "not my run" }),
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await json(cancelled))["status"], "cancelled");
  } finally {
    await r.close();
  }
});

/** Boot a plane with `console.error` captured, so what an operator is told is testable. */
async function boot(opts: ControlPlaneOptions): Promise<{ lines: string[]; plane: ControlPlane; base: string; close: () => Promise<void> }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...parts: unknown[]): void => void lines.push(parts.map(String).join(" "));
  try {
    const { plane, port } = await startControlPlane(opts, 0);
    return { lines, plane, base: `http://127.0.0.1:${port}`, close: () => plane.close() };
  } finally {
    console.error = original;
  }
}

const SHARED_RIGHTS = /FULL OPERATOR CREDENTIAL/;

test("A DEPLOYMENT WITH MORE THAN ONE PRINCIPAL IS TOLD AT BOOT THAT THEY ARE NOT ISOLATED", async () => {
  // Configuring per-subject identities IMPLIES isolation to anyone who does it, and an
  // implication that is false is worse than an absence. One principal implies nothing —
  // there is nobody to be isolated from — so the warning stays silent there rather than
  // becoming the line every operator learns to scroll past.
  const h = harness();
  const base: ControlPlaneOptions = { engine: h.engine, store: h.store, graphs: { plain: compileSkeleton() } };
  const one = (): IdentitySource => new BearerTokenIdentity({ subjects: [{ token: "solo", subject: "u:solo" }] });

  const cases: readonly (readonly [string, ControlPlaneOptions, number, boolean])[] = [
    ["a shared token alone is ONE principal", { ...base, token: "s3cret" }, 1, false],
    ["an open plane is one principal too", base, 1, false],
    ["one subject, no token", { ...base, identity: one() }, 1, false],
    ["one subject PLUS the shared token is two", { ...base, identity: one(), token: "s3cret" }, 2, true],
    ["three subjects", { ...base, identity: people() }, 3, true],
    ["three subjects and a shared token", { ...base, identity: people(), token: "s3cret" }, 4, true],
    // A source that will not say how many principals it has is assumed to have many: it
    // exists to tell people apart, and silence must fail loud rather than quiet.
    ["a source that does not declare a count", { ...base, identity: { name: "sso", identify: () => undefined } }, Infinity, true],
    // ZERO IS AN ANSWER, not a silence. A source that declares it can authenticate NOBODY
    // is not a deployment whose principals lack isolation; it is one with no principals at
    // all. `0` used to fall through to the "will not say" branch — `Infinity` — so
    // `BearerTokenIdentity({subjects: []})` fired the very warning this rule reserves for
    // the arrangement that IMPLIES isolation. A warning that fires on the empty case is
    // one operators learn to skip, which costs the cases it was written for.
    ["a source that can authenticate nobody", { ...base, identity: new BearerTokenIdentity({ subjects: [] }) }, 0, false],
    ["…plus the shared token: the token is the only way in, and it is one principal", { ...base, identity: new BearerTokenIdentity({ subjects: [] }), token: "s3cret" }, 1, false],
  ];

  for (const [what, opts, principals, warns] of cases) {
    const booted = await boot(opts);
    try {
      assert.equal(booted.plane.distinctPrincipals, principals, what);
      assert.equal(booted.lines.some((l) => SHARED_RIGHTS.test(l)), warns, `${what}: warned?`);
    } finally {
      await booted.close();
    }
  }
});

test("AN OPEN PLANE IS UNREACHABLE BY TYPO, and /health, /whoami and the boot log agree about it", async () => {
  // The other half of refusing `token: ""`. An open plane is still available on purpose —
  // it is how a laptop runs the console with no configuration — and the way to ask for it
  // is the ABSENCE of both options, never a value of one. That is what makes it
  // unreachable by an unset environment variable: no string, empty or otherwise, spells
  // it, so a deployment cannot arrive here by substitution.
  //
  // `/health`, `/whoami` and the boot log are three independent readings of one posture,
  // and the empty token was precisely the case where they disagreed with each other and
  // with the truth. They are all derived from `ControlPlane.openToEveryCaller` now,
  // decided once at construction.
  const h = harness();
  const open = await boot({ engine: h.engine, store: h.store, graphs: {} });
  try {
    assert.equal(open.plane.openToEveryCaller, true);
    assert.equal((await json(await fetch(`${open.base}/health`)))["auth"], "open");
    assert.deepEqual(await json(await fetch(`${open.base}/whoami`)), {
      kind: "service",
      subject: UNIDENTIFIED_SUBJECT,
      method: "open",
      canApproveNamedGates: false,
    });
    assert.ok(
      open.lines.some((l) => /NO TOKEN — every caller is authorized/.test(l)),
      "and the operator is told, loudly, at the only moment they are watching",
    );
  } finally {
    await open.close();
  }

  // The same three questions on a plane that has a real token. This is the shape the empty
  // token forged: `auth: "required"` and a principal for a caller who presented nothing.
  const closed = await boot({ engine: h.engine, store: h.store, graphs: {}, token: "s3cret" });
  try {
    assert.equal(closed.plane.openToEveryCaller, false);
    assert.equal((await json(await fetch(`${closed.base}/health`)))["auth"], "required");
    assert.equal((await fetch(`${closed.base}/whoami`)).status, 401, "…and NOTHING answers without the credential");
    assert.deepEqual(closed.lines, [], "one principal, closed: there is nothing to warn about");
  } finally {
    await closed.close();
  }
});

test("the boot warning says what is shared, not merely that something is", async () => {
  const h = harness();
  const booted = await boot({ engine: h.engine, store: h.store, graphs: {}, identity: people(), token: "s3cret" });
  try {
    const line = booted.lines.find((l) => SHARED_RIGHTS.test(l));
    assert.ok(line, "no warning at all");
    assert.match(line, /4 principals/, "an operator can tell whether this is their deployment");
    assert.match(line, /read, stream and cancel/, "the three verbs, so the risk is not left as an inference");
    assert.match(line, /D3\.17/, "and where the limit is written down");
  } finally {
    await booted.close();
  }
});

// ── two residuals in the identity plane ──────────────────────────────────────

test("AN INJECTED `via` IS READ ONCE — a getter cannot pass the check and then write something else", async () => {
  // `checkedAuth` read `raw["via"]` twice: once to test it against the closed vocabulary
  // and once to use it. Every other field in that function is read once into a `const`,
  // and `via` was the sole exception — so a source whose `via` is a getter (or a Proxy)
  // passed the check with `console` and wrote `telepathy` into the journal. The
  // vocabulary is closed because folds over `gate.decided` actors depend on it.
  let reads = 0;
  const shifty: IdentitySource = {
    name: "sso",
    identify: () => {
      let n = 0;
      return {
        kind: "human",
        subject: "u:alice",
        method: "sso",
        get via(): HumanActor["via"] {
          n++;
          reads++;
          return (n === 1 ? "console" : "telepathy") as HumanActor["via"];
        },
      };
    },
  };
  const r = await rig({ identity: shifty, approvers: ["u:alice"] });
  try {
    const at = await atGate(r, "any-token");
    assert.equal((await decide(r, at, { decision: { kind: "approve" } }, "any-token")).status, 200);
    assert.deepEqual(await decidedBy(r, at.runId), [{ kind: "human", subject: "u:alice", via: "console" }]);
    assert.equal(reads, 2, "one read per request — the submit and the decision, and no second read of either");
  } finally {
    await r.close();
  }
});

/** Two named machines, each with its own credential. Neither is a person. */
const services = (): IdentitySource =>
  new BearerTokenIdentity({
    name: "service-tokens",
    subjects: [
      { token: "deployer-token", subject: "svc:deployer", kind: "service" },
      { token: "pager-token", subject: "svc:pager", kind: "service" },
    ],
  });

test("TWO SERVICE PRINCIPALS DO NOT SHARE ONE GATE'S IDEMPOTENCY SLOT", async () => {
  // `#decider` collapses every principal that is not an identified human to
  // `(unidentified)`, so "resolve prefixes the resolved subject, therefore two principals
  // never share a slot" was true only for people. Two services answering the same gate
  // hashed to one key: the second one's decision was swallowed as "already handled" and
  // answered 200 — a rejection that never happened, reported as success.
  const r = await rig({ identity: services() });
  try {
    const at = await atGate(r, "deployer-token");
    assert.equal((await decide(r, at, { decision: { kind: "approve" } }, "deployer-token")).status, 200);

    const second = await decide(r, at, { decision: { kind: "reject", reason: "not ready" } }, "pager-token");
    assert.equal(second.status, 409, "a conflict the pager can see, not a 200 for someone else's approval");
    assert.equal(((await json(second))["error"] as { code: string }).code, CODES.E_GATE_ALREADY_RESOLVED);
    assert.equal((await decidedBy(r, at.runId)).length, 1);
  } finally {
    await r.close();
  }
});

test("/health ANSWERS FROM A LABEL CAPTURED AT CONSTRUCTION, so a probe reads no injected property", async () => {
  // `#requiresBearer` claims `/health` "answers from process-local state alone" and
  // `#healthDiagnostics` claims it "can answer without consulting anything that might be
  // down". Reading `identity.name` off the injected object on every probe made both
  // claims false: a getter there is injected code, on the one route a stranger can reach.
  let reads = 0;
  const shifty: IdentitySource = {
    get name(): string {
      reads++;
      return `sso-${reads}`;
    },
    identify: () => undefined,
  };
  const r = await rig({ identity: shifty });
  try {
    const atBoot = reads;
    assert.equal(atBoot, 1, "read exactly once, at construction");
    assert.equal((await json(await fetch(`${r.base}/health`)))["identity"], "sso-1");
    assert.equal((await json(await fetch(`${r.base}/health`)))["identity"], "sso-1", "and the same answer every probe");
    assert.equal(reads, atBoot, "the probe touched nothing on the injected object");
  } finally {
    await r.close();
  }
});

test("the identity label /health discloses is bounded and never empty", async () => {
  // `sourceLabel`'s rule, applied where it was skipped. An unbounded name is a
  // deployment-chosen string on an unauthenticated response.
  const long = await rig({ identity: { name: "n".repeat(400), identify: () => undefined } });
  const blank = await rig({ identity: { name: "", identify: () => undefined } });
  try {
    assert.equal(String((await json(await fetch(`${long.base}/health`)))["identity"]).length, 256);
    assert.equal((await json(await fetch(`${blank.base}/health`)))["identity"], "(unnamed)");
  } finally {
    await long.close();
    await blank.close();
  }
});

test("the intervention route accepts no identity claim, because it accepts no deescalate", async () => {
  // D7.7's asymmetry: `deescalate` is the only thing that can LOWER a posture, and it is
  // deliberately not reachable from the API. Pinned here so that adding it is a decision
  // rather than an accident — whoever adds it has to bind its actor to the credential
  // the way the gate route does, and this test is where they will be reminded.
  const r = await rig();
  try {
    const { runId } = await submit(r);
    const res = await fetch(`${r.base}/runs/${String(runId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "deescalate", scope: `run:${String(runId)}`, to: "out", justification: "trust me", actor: "u:security-lead" }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await json(res))["error"] as { code: string }).code, "E_PROVIDER_BAD_REQUEST");
  } finally {
    await r.close();
  }
});

test("a service token still submits, reads and streams — only DECISIONS need a person", async () => {
  const r = await rig({ token: "shared-service-token" });
  const auth = { authorization: "Bearer shared-service-token" };
  try {
    const { runId } = await submit(r, auth);
    await settle(r, runId as string);
    assert.equal((await fetch(`${r.base}/runs/${String(runId)}`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${r.base}/runs`, { headers: auth })).status, 200);
    // Aborted rather than read to the end: the stream is open-ended by design, and an
    // un-aborted one would keep `server.close()` waiting on it.
    const ctrl = new AbortController();
    const stream = await fetch(`${r.base}/runs/${String(runId)}/events`, { headers: auth, signal: ctrl.signal });
    assert.equal(stream.status, 200);
    ctrl.abort();
  } finally {
    await r.close();
  }
});

// ── inbound gate callbacks, and the auth hole they need ──────────────────────

/**
 * A gated run, its gate id, and a signed-callback poster.
 *
 * The route is the only unauthenticated write in the plane, so these tests always drive
 * it over a real socket with no `authorization` header at all — the carve-out is a
 * property of the wire, not of a function call.
 */
async function gated(opts: { token?: string; maxBodyBytes?: number; identity?: IdentitySource } = {}): Promise<
  Rig & { runId: string; gateId: string; post: (body: string, over?: { ts?: string; sig?: string; path?: string }) => Promise<Response> }
> {
  const r = await rig({ callbacks: true, ...opts });
  let runId: unknown;
  let gateId: string;
  try {
    // Submitting is NOT carved out, so this half of the fixture presents the token.
    ({ runId } = await submit(r, opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` }));
    await settle(r, runId as string);
    gateId = (await r.h.engine.openGates(runId as RunId))[0]!.gateId;
  } catch (e) {
    await r.close();
    throw e;
  }

  const post = (body: string, over: { ts?: string; sig?: string; path?: string } = {}): Promise<Response> => {
    const ts = over.ts ?? String(Math.floor(NOW / 1000));
    return fetch(`${r.base}${over.path ?? `/runs/${String(runId)}/callbacks/slack`}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-loom-timestamp": ts,
        "x-loom-signature": over.sig ?? r.channel.sign(body, ts),
      },
      body,
    });
  };
  return { ...r, runId: String(runId), gateId, post };
}

const approvalBody = (runId: string, gateId: string, actor = "u:alice"): string =>
  JSON.stringify({ runId, gateId, actor, decision: { kind: "approve" } });

async function journal(r: Rig, runId: string): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of r.h.store.read(runId as RunId, 1)) out.push(e);
  return out;
}

test("A SIGNED CALLBACK ANSWERS A GATE WITH NO BEARER TOKEN", async () => {
  // The whole point of the carve-out: Slack does not hold the control plane's token, so
  // handing it one would put a credential that can start runs into a vendor's logs.
  const r = await gated({ token: "s3cret" });
  try {
    const res = await r.post(approvalBody(r.runId, r.gateId));
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body["decision"], "approve");
    assert.deepEqual(body["actor"], { kind: "human", subject: "u:alice", via: "slack" });
    assert.equal(r.h.writes.length, 1, "the action behind the gate really ran");
  } finally {
    await r.close();
  }
});

test("NO BEARER + WRONG SIGNATURE ⇒ REFUSED, AND THE GATE STAYS OPEN", async () => {
  const r = await gated({ token: "s3cret" });
  try {
    const res = await r.post(approvalBody(r.runId, r.gateId), { sig: "v0=" + "0".repeat(64) });
    assert.equal(res.status, 403);
    assert.equal(((await json(res))["error"] as { code: string }).code, "E_GATE_NOT_AUTHORIZED");

    const p = await r.h.engine.projection(r.runId as RunId);
    assert.equal(p?.gates[r.gateId as never]?.state, "open");
    assert.equal(r.h.writes.length, 0);
    // And no durable trace: the route is unauthenticated, so a row per forged request
    // would be a journal any stranger with the URL could grow. See `GateCallbackRouter`.
    const rows = (await journal(r, r.runId)).filter((e) => e.type === "gate.callback_rejected");
    assert.deepEqual(rows, []);
  } finally {
    await r.close();
  }
});

test("no bearer + NO signature ⇒ refused; the carve-out is not a way in", async () => {
  const r = await gated({ token: "s3cret" });
  try {
    const res = await fetch(`${r.base}/runs/${r.runId}/callbacks/slack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: approvalBody(r.runId, r.gateId),
    });
    assert.equal(res.status, 403);
    assert.equal(r.h.writes.length, 0);
  } finally {
    await r.close();
  }
});

test("THE CARVE-OUT DOES NOT WIDEN — every neighbouring path still wants the token", async () => {
  const r = await gated({ token: "s3cret" });
  try {
    for (const path of [
      `/runs/${r.runId}`,
      `/runs/${r.runId}/gates`,
      `/runs/${r.runId}/commands`,
      `/runs/${r.runId}/gates/${r.gateId}`,
      `/runs/${r.runId}/callbacks`,
      `/runs/${r.runId}/callbacks/slack/extra`,
      `/runs/${r.runId}/callbacks/slack/`,
    ]) {
      const res = await fetch(`${r.base}${path}`, { method: "POST" });
      assert.equal(res.status, 401, `${path} must still be behind the bearer token`);
    }
    // Same path, different method: the hole is cut for POST only.
    assert.equal((await fetch(`${r.base}/runs/${r.runId}/callbacks/slack`)).status, 401);
  } finally {
    await r.close();
  }
});

/** An identity source that answers nobody and remembers every path it was asked about. */
class SpyIdentity implements IdentitySource {
  readonly name = "spy-sso";
  readonly seen: string[] = [];
  identify(req: IdentityRequest): undefined {
    this.seen.push(req.path);
    return undefined;
  }
}

test("NO OPEN ROUTE REACHES THE INJECTED IDENTITY SOURCE", async () => {
  // The carve-out was named in a comment and covered by nothing — and was already false
  // for `/health`. An `IdentitySource` is deployment code that may talk to a network, so
  // every route a stranger can reach without a credential is a way to make it do so on
  // demand: the callback route, the console shell, and the load balancer's probe.
  const spy = new SpyIdentity();
  const r = await gated({ token: "s3cret", identity: spy });
  try {
    // The fixture submitted a run through the guarded route, which legitimately asked.
    assert.deepEqual(spy.seen, ["/runs"]);
    spy.seen.length = 0;

    assert.equal((await fetch(`${r.base}/health`)).status, 200);
    assert.equal((await fetch(`${r.base}/`)).status, 200);
    assert.equal((await r.post(approvalBody(r.runId, r.gateId))).status, 200);
    assert.deepEqual(spy.seen, [], "not one open route asked the seam anything");

    // …and the guarded ones do ask, which is what makes the silence above a fact rather
    // than a source nobody ever consults.
    assert.equal((await fetch(`${r.base}/whoami`, { headers: { authorization: "Bearer s3cret" } })).status, 200);
    assert.deepEqual(spy.seen, ["/whoami"]);
  } finally {
    await r.close();
  }
});

test("THE CONSOLE SHELL IS THE ONLY OTHER OPEN GET, and it carries no data", async () => {
  // A browser cannot put a bearer token on a top-level navigation, so a shell behind the
  // token is a console that cannot load. What is served is a constant: no run, no graph,
  // no name of either — every one of those still needs the credential.
  const r = await rig({ token: "s3cret", approvers: ["u:security-lead"] });
  try {
    const shell = await fetch(`${r.base}/`);
    assert.equal(shell.status, 200);
    const html = await shell.text();
    // A CONSTANT, byte for byte: nothing about this deployment is interpolated into it,
    // which is the whole basis for serving it without a credential.
    assert.equal(html, CONSOLE_HTML);
    assert.equal(html.includes("skeleton-summarize"), false, "so it names no workflow of ours");

    for (const path of ["/runs", "/graphs", "/whoami", `/graphs/by-hash/${encodeURIComponent(compileSkeleton().graphHash)}`]) {
      assert.equal((await fetch(`${r.base}${path}`)).status, 401, `${path} must still be behind the token`);
    }
    assert.equal((await fetch(`${r.base}/`, { method: "POST" })).status, 401, "and the hole is cut for GET only");
  } finally {
    await r.close();
  }
});

test("with NO dispatcher configured the route does not exist, and neither does its hole", async () => {
  const r = await rig({ token: "s3cret" });
  try {
    const res = await fetch(`${r.base}/runs/01JNOPE/callbacks/slack`, { method: "POST", body: "{}" });
    assert.equal(res.status, 401, "a deployment with no inbound channel has no open endpoint at all");
  } finally {
    await r.close();
  }
});

test("a stale callback is refused over the wire too", async () => {
  const r = await gated();
  try {
    const body = approvalBody(r.runId, r.gateId);
    const ts = String(Math.floor((NOW - 86_400_000) / 1000));
    const res = await r.post(body, { ts, sig: r.channel.sign(body, ts) });
    assert.equal(res.status, 403);
    assert.equal(r.h.writes.length, 0);
    const rows = (await journal(r, r.runId)).filter((e) => e.type === "gate.callback_rejected");
    assert.deepEqual(rows, [], "a replay is a perimeter failure, and those are not durable");
  } finally {
    await r.close();
  }
});

test("AN UNSIGNED POST CANNOT TELL A REAL RUN FROM A FICTIONAL ONE, over the wire", async () => {
  // The unauthenticated existence oracle, as it was reproduced: a real gated run answered
  // 403 and a runId that never existed answered 404, so anyone holding one callback URL
  // could enumerate the rest. Both are 403 now — nothing has been looked up yet.
  const r = await gated({ token: "s3cret" });
  try {
    const unsigned = (runId: string): Promise<Response> =>
      fetch(`${r.base}/runs/${runId}/callbacks/slack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: approvalBody(r.runId, r.gateId),
      });
    const real = await unsigned(r.runId);
    const fake = await unsigned("01JNOSUCHRUN0000000000000");
    assert.equal(real.status, fake.status);
    assert.deepEqual(await json(real), await json(fake), "the same body, down to the message");
  } finally {
    await r.close();
  }
});

test("a callback replayed over HTTP decides once and answers 200 both times", async () => {
  const r = await gated();
  try {
    const body = approvalBody(r.runId, r.gateId);
    const ts = String(Math.floor(NOW / 1000));
    const sig = r.channel.sign(body, ts);
    assert.equal((await r.post(body, { ts, sig })).status, 200);
    assert.equal((await r.post(body, { ts, sig })).status, 200);
    assert.equal((await journal(r, r.runId)).filter((e) => e.type === "gate.decided").length, 1);
    assert.equal(r.h.writes.length, 1);
  } finally {
    await r.close();
  }
});

test("an already-resolved gate answers 409 and an unknown gate answers 404", async () => {
  const r = await gated();
  try {
    assert.equal((await r.post(approvalBody(r.runId, r.gateId))).status, 200);
    // A different actor, so it is a new decision rather than a retry.
    assert.equal((await r.post(approvalBody(r.runId, r.gateId, "u:bob"))).status, 409);
    assert.equal((await r.post(approvalBody(r.runId, "gate_NOPE"))).status, 404);
  } finally {
    await r.close();
  }
});

test("AN OVERSIZED CALLBACK IS REJECTED BY THE CAP, not by the signature check", async () => {
  // The route is unauthenticated, so an uncapped read here is a memory-exhaustion target
  // anyone on the network can pull. This pins WHICH check answers; that the cap is
  // enforced while STREAMING — the part that decides whether the target is real — is a
  // protocol fact and lives with the raw-socket tests below.
  const r = await gated({ maxBodyBytes: 4096 });
  try {
    const body = JSON.stringify({ runId: r.runId, gateId: r.gateId, actor: "u:alice", decision: { kind: "approve" }, pad: "x".repeat(20_000) });
    const res = await r.post(body);
    assert.equal(res.status, 400);
    assert.equal(((await json(res))["error"] as { code: string }).code, "E_PROVIDER_BAD_REQUEST");
    const p = await r.h.engine.projection(r.runId as RunId);
    assert.equal(p?.gates[r.gateId as never]?.state, "open");
    assert.equal(r.h.writes.length, 0);
  } finally {
    await r.close();
  }
});

test("an unknown callback channel is a 404 that does not echo the name back", async () => {
  const r = await gated();
  try {
    const res = await r.post(approvalBody(r.runId, r.gateId), { path: `/runs/${r.runId}/callbacks/%3Cscript%3E` });
    assert.equal(res.status, 404);
    assert.equal(/script/.test(JSON.stringify(await json(res))), false);
  } finally {
    await r.close();
  }
});

// ── the request deadline ─────────────────────────────────────────────────────

/**
 * A channel whose inbound path never returns.
 *
 * Not a contrived failure: a `parseCallback` that awaits a signature service, a
 * directory lookup, or any `fetch` without a timeout of its own is one dropped packet
 * away from this. The route it sits behind is the unauthenticated one.
 */
class HangingChannel implements DeliveryChannel {
  readonly name = "hangs";
  /** Resolved on close, so a hung handler cannot outlive the test that made it. */
  #release: (() => void) | undefined;
  async deliver(): Promise<string> {
    return "receipt";
  }
  async parseCallback(): Promise<never> {
    await new Promise<void>((resolve) => (this.#release = resolve));
    throw new Error("unreachable");
  }
  release(): void {
    this.#release?.();
  }
}

test("A HANDLER THAT HANGS IS ANSWERED, NOT HELD FOREVER", async () => {
  // Before: an unauthenticated POST held a socket open with nothing journaled, nothing
  // counted and no response — repeat until the process runs out of sockets. There was no
  // handler deadline anywhere in this file.
  const hangs = new HangingChannel();
  const r = await rig({ token: "s3cret", callbacks: true, channel: hangs, requestTimeoutMs: 150 });
  try {
    const { runId } = await submit(r, { authorization: "Bearer s3cret" });
    await settle(r, String(runId));

    const started = Date.now();
    const res = await fetch(`${r.base}/runs/${String(runId)}/callbacks/hangs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 504);
    assert.equal(((await json(res))["error"] as { code: string }).code, "E_REQUEST_TIMEOUT");
    assert.ok(Date.now() - started < 5000, "answered from the deadline, not from the handler");

    // The one that matters: the process is still serving, and so is the gate's own path.
    assert.equal((await fetch(`${r.base}/health`)).status, 200);
  } finally {
    hangs.release();
    await r.close();
  }
});

/**
 * An identity source that accepts the question and never answers it.
 *
 * The realistic shape of an SSO outage, and the one a `LoomError` does not cover: not a
 * refusal — the plane already turns that into a 503 — but a connection that was accepted
 * and will never be replied to. Every `IdentitySource` worth having talks to a network.
 */
class HangingIdentity implements IdentitySource {
  readonly name = "hangs";
  calls = 0;
  /** Resolved on close, so a hung resolution cannot outlive the test that made it. */
  #release: (() => void) | undefined;
  async identify(): Promise<AuthContext | undefined> {
    this.calls++;
    await new Promise<void>((resolve) => (this.#release = resolve));
    return undefined;
  }
  release(): void {
    this.#release?.();
  }
}

test("THE DEADLINE COVERS IDENTITY RESOLUTION, NOT JUST THE HANDLER", async () => {
  // The same hole the deadline was added to close, one line above where it started
  // applying: `#principal` was awaited BEFORE the timer, so a source that hangs parked a
  // socket per request with nothing journaled and no answer — on every route, and
  // reachable without a valid credential, since resolving one is what hangs.
  const hangs = new HangingIdentity();
  const r = await rig({ identity: hangs, requestTimeoutMs: 150 });
  try {
    // The abort is the test's own escape hatch: without the fix nothing ever answers, and
    // a suite that hangs reports nothing. A TimeoutError here IS the failure.
    const res = await fetch(`${r.base}/runs`, { headers: { authorization: "Bearer anything" }, signal: AbortSignal.timeout(4000) });
    assert.equal(res.status, 504);
    assert.equal(((await json(res))["error"] as { code: string }).code, "E_REQUEST_TIMEOUT");
    assert.equal(hangs.calls, 1);
    // The process is still serving, on the route that asks the seam nothing.
    assert.equal((await fetch(`${r.base}/health`)).status, 200);
  } finally {
    hangs.release();
    await r.close();
  }
});

test("the deadline is a TIME-TO-FIRST-BYTE bound, so a long stream is not cut off", async () => {
  // A stream that has begun is past the deadline's reach: an SSE connection open for an
  // hour is the normal case, and a handler-lifetime timeout would sever it.
  const r = await rig({ requestTimeoutMs: 120 });
  try {
    const { runId } = await submit(r);
    await settle(r, String(runId));
    const ctrl = new AbortController();
    const res = await fetch(`${r.base}/runs/${String(runId)}/events`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Still open, still ours, three deadlines later.
    assert.equal(res.body?.locked, false);
    ctrl.abort();
  } finally {
    await r.close();
  }
});

// ── the perimeter, made observable ───────────────────────────────────────────

test("A FORGED-SIGNATURE CAMPAIGN IS COUNTED WHERE THE JOURNAL MAY NOT RECORD IT", async () => {
  // Reproduced before this existed: 500 forged POSTs at a live gate moved the journal by
  // zero rows, produced zero spans — spans are derived FROM the journal — and printed
  // nothing. The refusal was correct and completely invisible to the people running the
  // service. It stays out of the journal, and it shows up here.
  const r = await gated({ token: "s3cret" });
  try {
    for (let i = 0; i < 25; i++) {
      const res = await r.post(approvalBody(r.runId, r.gateId), { sig: "v0=" + "b".repeat(64) });
      assert.equal(res.status, 403);
    }
    assert.deepEqual((await journal(r, r.runId)).filter((e) => e.type === "gate.callback_rejected"), []);

    const health = await json(await fetch(`${r.base}/health`, { headers: { authorization: "Bearer s3cret" } }));
    assert.deepEqual(health["callbackRefusals"], [{ channel: "slack", reason: "signature", count: 25 }]);
  } finally {
    await r.close();
  }
});

test("THE COUNTS ARE BEHIND THE TOKEN, though /health itself is not", async () => {
  // `/health` stays reachable without a credential because a load balancer probes it. The
  // counts do not come with it: an unauthenticated caller reading them could poll its own
  // forgeries and learn that its traffic reaches the process rather than dying in a WAF,
  // which is a feedback channel handed to exactly the party causing the count.
  const r = await gated({ token: "s3cret" });
  try {
    assert.equal((await r.post(approvalBody(r.runId, r.gateId), { sig: "v0=" + "c".repeat(64) })).status, 403);

    const anon = await fetch(`${r.base}/health`);
    assert.equal(anon.status, 200, "liveness is still free");
    const body = await json(anon);
    assert.equal(body["ok"], true);
    assert.equal("callbackRefusals" in body, false, "…and it says nothing about who is knocking");

    const authed = await json(await fetch(`${r.base}/health`, { headers: { authorization: "Bearer s3cret" } }));
    assert.equal((authed["callbackRefusals"] as unknown[]).length, 1);
  } finally {
    await r.close();
  }
});

test("with no dispatcher the field is absent, not an empty list", async () => {
  // The route does not exist, so neither does its counter. Reporting `[]` would claim a
  // measurement of a surface that is not there.
  const r = await rig({ token: "s3cret" });
  try {
    const body = await json(await fetch(`${r.base}/health`, { headers: { authorization: "Bearer s3cret" } }));
    assert.equal("callbackRefusals" in body, false);
  } finally {
    await r.close();
  }
});

test("an unknown channel name never becomes a key in the counter", async () => {
  // The counter is reachable by anyone who can POST at the callback route. A map keyed by
  // the name off the URL would be an unbounded allocation on an unauthenticated endpoint.
  const r = await gated({ token: "s3cret" });
  try {
    for (let i = 0; i < 30; i++) {
      const res = await r.post("{}", { path: `/runs/${r.runId}/callbacks/attacker-${i}` });
      assert.equal(res.status, 404);
    }
    const health = await json(await fetch(`${r.base}/health`, { headers: { authorization: "Bearer s3cret" } }));
    assert.deepEqual(health["callbackRefusals"], [{ channel: "(unknown)", reason: "unknown_channel", count: 30 }]);
    assert.equal(JSON.stringify(health).includes("attacker-"), false);
  } finally {
    await r.close();
  }
});

// ── the unauthenticated edge, spoken at the protocol level ───────────────────
//
// `fetch` will not send a malformed `Host`, a truncated body, or an invalid percent
// escape — it normalizes or refuses all three. The callback route is reachable by
// anything that can open a socket, so these speak HTTP by hand.

/**
 * One request, written straight onto a socket. Resolves with whatever came back.
 *
 * An empty string is a meaningful answer: it is what a server that died looks like
 * from the outside, which is precisely the failure being guarded against.
 */
function raw(base: string, request: string, budgetMs = 4000): Promise<string> {
  const port = Number(new URL(base).port);
  return new Promise((done) => {
    let out = "";
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    const finish = (): void => {
      clearTimeout(timer);
      socket.destroy();
      done(out);
    };
    const timer = setTimeout(finish, budgetMs);
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      out += d;
      if (out.includes("\r\n\r\n")) finish();
    });
    socket.on("close", finish);
    socket.on("error", finish);
  });
}

test("A MALFORMED Host HEADER IS A 400, NOT A DEAD PROCESS", async () => {
  // The severe one. `new URL(req.url, "http://a b")` throws `ERR_INVALID_URL`, llhttp
  // accepts `a b` as a header value, and the parse used to sit outside the handler's
  // try block — so one unauthenticated packet reached `Server.emit` with nobody to
  // catch it and took every in-flight run and every open gate's return path with it.
  // No token, no signature, and no valid runId are needed to send this.
  const r = await gated({ token: "s3cret" });
  try {
    for (const host of ["a b", "[", "%%", ":::", "x y"]) {
      const answer = await raw(
        r.base,
        `POST /runs/${r.runId}/callbacks/slack HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 0\r\n\r\n`,
      );
      assert.match(answer, /^HTTP\/1\.1 400 /, `Host: ${JSON.stringify(host)} must be answered, not fatal`);
    }
    // The assertion that actually matters: the process is still here to answer.
    assert.equal((await fetch(`${r.base}/health`)).status, 200, "…and the server is still serving");
    const ok = await r.post(approvalBody(r.runId, r.gateId));
    assert.equal(ok.status, 200, "…including the gate whose return path was in flight");
  } finally {
    await r.close();
  }
});

test("a malformed request TARGET is a 400 too, and says nothing about routes", async () => {
  const r = await gated({ token: "s3cret" });
  try {
    const answer = await raw(r.base, `GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    assert.match(answer, /^HTTP\/1\.1 400 /);
    assert.equal((await fetch(`${r.base}/health`)).status, 200);
  } finally {
    await r.close();
  }
});

test("THE BODY CAP IS ENFORCED WHILE STREAMING, so a huge upload costs one chunk", async () => {
  // The property, as a fact about the wire rather than a promise in a comment: the 400
  // comes back after 8 kB of a declared 5 MB upload, with the remaining 4.99 MB never
  // sent — and therefore never buffered, because it was never asked for.
  //
  // A cap checked after `Buffer.concat(chunks)` passes the sibling test above (that body
  // fully arrives) and hangs here forever, buffering every byte an attacker cares to
  // send. Which is exactly the shape of the attack the cap exists to stop.
  const r = await gated({ maxBodyBytes: 4096 });
  try {
    const answer = await raw(
      r.base,
      `POST /runs/${r.runId}/callbacks/slack HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `content-type: application/json\r\ncontent-length: 5000000\r\n\r\n` +
        "x".repeat(8192),
    );
    assert.match(answer, /^HTTP\/1\.1 400 /, "answered from the first chunks, 4.99 MB still unsent");
    assert.match(answer, /E_PROVIDER_BAD_REQUEST/);
    const p = await r.h.engine.projection(r.runId as RunId);
    assert.equal(p?.gates[r.gateId as never]?.state, "open");
    assert.equal(r.h.writes.length, 0);
  } finally {
    await r.close();
  }
});

test("AN INVALID PERCENT ESCAPE IN THE CHANNEL NAME IS A 404, not a 500", async () => {
  // `decodeURIComponent("%zz")` throws `URIError`, which the dispatcher maps to
  // E_INTERNAL — "a bug in Loom" — on the one route a stranger can reach. It is not a
  // bug in Loom; it is nonsense, and nonsense matches no channel. Sent raw because
  // `fetch` refuses to put an invalid escape on the wire at all.
  const r = await gated();
  try {
    for (const name of ["%zz", "%", "%e0%a4%a", "slack%"]) {
      const answer = await raw(
        r.base,
        `POST /runs/${r.runId}/callbacks/${name} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n`,
      );
      assert.match(answer, /^HTTP\/1\.1 404 /, `channel ${JSON.stringify(name)} is unknown, not an internal error`);
      assert.equal(/E_INTERNAL/.test(answer), false, "a stranger's typo is not our exception");
    }
  } finally {
    await r.close();
  }
});

// ── commands ─────────────────────────────────────────────────────────────────

test("cancel is reachable and reports cleanliness honestly", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);
    const res = await fetch(`${r.base}/runs/${String(runId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "cancel", reason: "operator stopped it" }),
    });
    const body = await json(res);
    assert.equal(body["status"], "cancelled");
    assert.deepEqual(body["unknownEffects"], []);
  } finally {
    await r.close();
  }
});

test("an unknown command is a 400, not a silent no-op", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    const res = await fetch(`${r.base}/runs/${String(runId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "explode" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await r.close();
  }
});

// ── SSE ──────────────────────────────────────────────────────────────────────

/** Read SSE frames until `until` matches or the budget runs out. */
async function readSse(url: string, until: (frames: SseFrame[]) => boolean, budgetMs = 4000): Promise<SseFrame[]> {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  const deadline = Date.now() + budgetMs;

  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        frames.push(parse(buffer.slice(0, cut)));
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");
      }
      if (until(frames)) break;
    }
  } finally {
    controller.abort();
  }
  return frames;
}

interface SseFrame {
  id?: number;
  event?: string;
  data?: unknown;
}

function parse(raw: string): SseFrame {
  const out: SseFrame = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) out.id = Number(line.slice(4));
    else if (line.startsWith("event: ")) out.event = line.slice(7);
    else if (line.startsWith("data: ")) out.data = JSON.parse(line.slice(6)) as unknown;
  }
  return out;
}

test("SSE replays the journal from the beginning by default", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);

    const frames = await readSse(`${r.base}/runs/${String(runId)}/events`, (f) =>
      f.some((x) => (x.data as { type?: string } | undefined)?.type === "gate.raised"),
    );
    const types = frames.map((f) => (f.data as { type?: string } | undefined)?.type);
    assert.ok(types.includes("run.submitted"));
    assert.ok(types.includes("gate.raised"));
    // Gap-free: ids are contiguous from 1.
    const ids = frames.filter((f) => f.event === "event").map((f) => f.id!);
    assert.deepEqual(ids, ids.map((_, i) => i + 1));
  } finally {
    await r.close();
  }
});

test("Last-Event-ID resumes without a gap and without repeating", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);

    const frames = await readSse(`${r.base}/runs/${String(runId)}/events?lastEventId=3`, (f) =>
      f.some((x) => (x.data as { type?: string } | undefined)?.type === "gate.raised"),
    );
    const ids = frames.filter((f) => f.event === "event").map((f) => f.id!);
    assert.equal(ids[0], 4, "resumes at seq+1");
    assert.deepEqual(ids, ids.map((_, i) => i + 4), "contiguous from there");
  } finally {
    await r.close();
  }
});

test("a Last-Event-ID outside the hot window gets a SNAPSHOT, not a silent gap", async () => {
  const h = harness();
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "skeleton-summarize": compileSkeleton() },
    hotWindow: 1, // force the snapshot path
  });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
    });
    const { runId } = (await res.json()) as { runId: string };
    await new Promise((r) => setTimeout(r, 150));

    const frames = await readSse(`${base}/runs/${runId}/events?lastEventId=1`, (f) => f.length > 0, 2000);
    assert.equal(frames[0]?.event, "snapshot", "the client is told it is looking at a fresh baseline");
    assert.ok((frames[0]?.data as { status?: string }).status);
  } finally {
    await plane.close();
  }
});

/** Give the engine's background advance a moment to reach the gate. */
async function settle(r: Rig, runId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const p = await r.h.engine.projection(runId as never);
    if (p !== undefined && (p.status === "awaiting_gate" || p.status === "succeeded" || p.status === "failed")) return;
    await new Promise((res) => setTimeout(res, 20));
  }
}

// ── the queue's order, and whether it reaches anybody ─────────────────────────

/**
 * Two `human_gate` nodes open AT ONCE, with different SLAs — the smallest graph in which
 * the queue's order and the journal's order differ.
 *
 * A fan-out over one gate node cannot produce it: every branch is raised in the same
 * `advance`, at the same instant, under the same SLA and the same batch, so every rank is
 * equal and `gateQueueOrder`'s tie-break is `raisedAtSeq` — journal order, exactly. Two
 * PARALLEL nodes with different `respondWithinMs` is the shape where "most urgent first"
 * says something, and it is the shape an operator has when two questions of different
 * urgency are waiting.
 */
function twoGateSpec(): GraphSpec {
  const gate = (id: string, respondWithinMs: number): unknown => ({
    id,
    type: "human_gate",
    reads: ["seed"],
    humanGate: { ref: "oversight/demo-write@stable", sla: { respondWithinMs, onTimeout: "fail" } },
  });
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "two-gates", project: "demo", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, done: { type: "array", reduce: "append_ordered" } },
    inputs: ["seed"],
    outputs: ["done"],
    nodes: [
      { id: "start", type: "function", reads: ["seed"], function: { ref: "function/passthrough@stable" } },
      // JOURNAL ORDER PUTS THE PATIENT ONE FIRST, which is what makes this discriminating:
      // `slow` is declared first, so it is raised first, so `Object.values(p.gates)` lists it
      // first — and the queue must put `urgent` there instead.
      gate("slow", 900_000),
      gate("urgent", 60_000),
      { id: "collect", type: "join", join: { branches: ["slow", "urgent"], mode: "all", onBranchError: "fail", timeoutMs: 60_000 } },
      { id: "finish", type: "function", reads: ["seed"], writes: ["done"], function: { ref: "function/two-gates-done@stable" } },
    ],
    edges: [
      { id: "a1", from: "start", to: "slow", kind: "seq" },
      { id: "a2", from: "start", to: "urgent", kind: "seq" },
      { id: "j1", from: "slow", to: "collect", kind: "join", branches: ["slow", "urgent"] },
      { id: "j2", from: "urgent", to: "collect", kind: "join", branches: ["slow", "urgent"] },
      { id: "s1", from: "collect", to: "finish", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

async function twoGateRig(): Promise<{ base: string; h: ReturnType<typeof harness>; runId: string; close: () => Promise<void> }> {
  const h = harness();
  h.functions.register("function/two-gates-done@stable", () => ({ writes: { done: ["ok"] } }));
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "two-gates": compileSkeleton(twoGateSpec()) },
    now: () => NOW,
  });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const accepted = (await json(
    await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "two-gates", inputs: { seed: "s" } }),
    }),
  )) as { runId: string };
  for (let i = 0; i < 50; i++) {
    const p = await h.engine.projection(accepted.runId as RunId);
    if (p?.status === "awaiting_gate" && Object.values(p.gates).filter((g) => g.state === "open").length === 2) break;
    await new Promise((res) => setTimeout(res, 20));
  }
  return { base, h, runId: accepted.runId, close: () => plane.close() };
}

test("THE QUEUE'S ORDER REACHES THE API — D7.9 row 5 stopped at `Engine.openGates`", async () => {
  // `HumanGateBroker.list` has ranked its answer since row 5 was built, and
  // `GET /runs/:id/gates` built its response from `Object.values(p.gates).filter(open)` —
  // JOURNAL order — while using the ranked list only as a lookup Map for `payload` and
  // `deadline`. So the ordering existed, was tested, and reached no caller: the register's
  // B-series shape, "mechanism that exists and is wired to nothing", on the endpoint that
  // is the whole point of the mechanism.
  //
  // Reproduced over real HTTP against this two-gate graph, before the fix:
  //
  //     engine.openGates(runId) → ["urgent", "slow"]          (ranked, 60 s before 900 s)
  //     GET /runs/:id/gates     → ["slow",   "urgent"]        (journal order)
  const r = await twoGateRig();
  try {
    const ranked = await r.h.engine.openGates(r.runId as RunId);
    assert.deepEqual(ranked.map((g) => g.nodeId), ["urgent", "slow"], "the broker ranks the sooner deadline first");

    const p = await r.h.engine.projection(r.runId as RunId);
    assert.deepEqual(
      Object.values(p!.gates)
        .filter((g) => g.state === "open")
        .map((g) => g.nodeId),
      ["slow", "urgent"],
      "…and the journal really does disagree, which is what makes this test able to fail",
    );

    const body = await json(await fetch(`${r.base}/runs/${r.runId}/gates`));
    const gates = body["gates"] as { nodeId: string; payload?: unknown }[];
    assert.deepEqual(gates.map((g) => g.nodeId), ["urgent", "slow"], "the API served journal order, not the queue's");
    // THE SET AND THE JOIN ARE UNCHANGED. Ordering must not become a filter, and the payload
    // join is the reason this endpoint asks the broker at all.
    assert.equal(gates.length, 2);
    for (const g of gates) assert.notEqual(g.payload, undefined, `${g.nodeId} lost the question it is asking`);
  } finally {
    await r.close();
  }
});

test("A GATE THE QUEUE DID NOT RANK IS STILL SERVED — the order is a presentation, never a filter", async () => {
  // The set comes from the PROJECTION and only the order comes from the broker, which is the
  // half a naive "just return `openGates`" would lose. Two ways the two lists can differ, and
  // both must end in the same set:
  //
  //   - the run is not attached to this engine — `openGates` throws `E_RUN_NOT_FOUND`, which
  //     is the ORDINARY state after a restart, and the whole queue is then unranked;
  //   - a gate raised between the projection read and the broker read, or dropped from the
  //     broker's answer for any other reason.
  //
  // A `Proxy` over the real engine, as the payload-join test uses, so every other method is
  // the real one and this cannot pass on a plane that never reached the broker.
  const r = await twoGateRig();
  try {
    const full = await r.h.engine.openGates(r.runId as RunId);
    for (const [what, answer] of [
      ["the broker ranks only one of them", [full[0]!]],
      ["the broker ranks none of them (a restarted process)", []],
    ] as const) {
      const partial = new Proxy(r.h.engine, {
        get(t, k, recv): unknown {
          if (k === "openGates") return () => Promise.resolve(answer);
          const v = Reflect.get(t, k, recv) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
      const plane = new ControlPlane({ engine: partial, store: r.h.store, bus: r.h.bus, graphs: {}, now: () => NOW });
      const { port } = await plane.listen(0);
      try {
        const gates = (await json(await fetch(`http://127.0.0.1:${port}/runs/${r.runId}/gates`)))["gates"] as { nodeId: string }[];
        assert.equal(gates.length, 2, `${what}: a gate vanished from the queue because nothing ranked it`);
        assert.deepEqual([...gates.map((g) => g.nodeId)].sort(), ["slow", "urgent"], what);
      } finally {
        await plane.close();
      }
    }
  } finally {
    await r.close();
  }
});

// ── geometry ships with structure ────────────────────────────────────────────

test("THE STRUCTURE PAYLOAD CARRIES GEOMETRY — the browser never lays out", async () => {
  // The content of D8's claim, as a fact about the wire rather than about code inside an
  // HTML string. Positions and edge control points are computed server-side and cached
  // by graphHash, so a run streaming a thousand task updates recomputes zero of them.
  const r = await rig();
  const graph = compileSkeleton();
  const res = await fetch(`${r.base}/graphs/by-hash/${encodeURIComponent(graph.graphHash)}`);
  assert.equal(res.status, 200);
  const body = (await json(res)) as unknown as {
    graphHash: string;
    width: number;
    height: number;
    nodes: { id: string; x: number; y: number; rank: number }[];
    edges: { id: string; x1: number; midY: number }[];
  };

  assert.equal(body.graphHash, graph.graphHash);
  assert.ok(body.width > 0 && body.height > 0, "a canvas the client sizes to, not one it computes");
  assert.equal(body.nodes.length, graph.spec.nodes.length);
  assert.equal(body.edges.length, graph.spec.edges.length);
  for (const node of body.nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `${node.id} has no position`);
  }
  for (const edge of body.edges) assert.ok(Number.isFinite(edge.midY), `${edge.id} has no control point`);
  r.close();
});

test("an unknown graph hash is a clean 404, not an empty canvas", async () => {
  const r = await rig();
  const res = await fetch(`${r.base}/graphs/by-hash/sha256%3Adeadbeef`);
  assert.equal(res.status, 404);
  r.close();
});

