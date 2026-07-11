/**
 * The HTTP server front end, driven against a real (offline, mock-backed)
 * server on an ephemeral port.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import type { ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpServer, maxSessions, sendJson, type HttpServer } from "../src/server.js";
import { LayeredConfig } from "../src/config.js";
import { MemoryStore } from "../src/kernel/store.js";
import type { MockProvider } from "../src/providers/mock.js";
import { unwrapProvider } from "../src/extensions/lib/provider-wrap.js";
import type { Usage } from "../src/kernel/types.js";
import { silentLogger } from "./helpers.js";

async function withServer(
  fn: (base: string) => Promise<void>,
  opts: { token?: string; maxBodyBytes?: number; askTimeoutMs?: number } = {},
): Promise<void> {
  const { server } = await createHttpServer({ provider: "mock", logger: silentLogger, ...opts });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Like `withServer`, but hands the test the whole `HttpServer` (so it can reach
 * `http.agent` and script the mock provider) alongside the base URL. The
 * elicitation tests need the agent to drive `ask_user_question`.
 */
async function withServerHandle(
  fn: (base: string, http: HttpServer) => Promise<void>,
  opts: { token?: string; askTimeoutMs?: number } = {},
): Promise<void> {
  const http = await createHttpServer({ provider: "mock", logger: silentLogger, ...opts });
  await new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", resolve));
  const addr = http.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, http);
  } finally {
    await new Promise<void>((resolve) => http.server.close(() => resolve()));
    await http.close();
  }
}

/** Reach the server's scriptable mock provider so a test can drive tool calls.
 *  The default-on `watchdog` extension wraps the default provider under the same
 *  name, so unwrap it to reach the concrete `MockProvider`. */
function mockOf(http: HttpServer): MockProvider {
  return unwrapProvider(http.agent.providers.get("mock")!) as MockProvider;
}

/**
 * Read an open NDJSON response line by line, invoking `onLine` for each parsed
 * object. Resolves when the stream ends. `onLine` may fire side-effecting work
 * (e.g. `POST /answer`) while the stream is still open — exactly the out-of-band
 * answer pattern the elicitation channel needs.
 */
async function readNdjson(
  res: Response,
  onLine: (obj: Record<string, unknown>) => void,
): Promise<void> {
  assert.ok(res.body, "response has a readable body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(JSON.parse(line) as Record<string, unknown>);
    }
  }
  const tail = buf.trim();
  if (tail) onLine(JSON.parse(tail) as Record<string, unknown>);
}

test("GET /health reports model and extensions", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; model: string; extensions: string[] };
    assert.equal(body.ok, true);
    assert.ok(body.extensions.includes("core-tools"));
    assert.ok(body.extensions.includes("web"));
  });
});

test("POST /run streams lifecycle events as JSONL", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello server" }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const events = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string });
    const types = events.map((e) => e.type);
    assert.ok(types.includes("message"), "should stream a message event");
    assert.ok(types.includes("usage"), "should stream a usage event");
    assert.equal(events.at(-1)?.type, "done");
  });
});

test("a session id makes /run accumulate conversation history", async () => {
  await withServer(async (base) => {
    const run = async (input: string) => {
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, session: "s1" }),
      });
      return (await res.text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string; role?: string; content?: { type: string; text?: string }[] });
    };
    await run("first message");
    const second = await run("second message");
    // The replayed history means the provider saw more than one user turn;
    // health should report one tracked session.
    const done = second.at(-1) as { type: string; session?: string };
    assert.equal(done.session, "s1");

    const health = await (await fetch(`${base}/health`)).json();
    assert.equal((health as { sessions: number }).sessions, 1);

    // Deleting the session forgets it.
    const del = await fetch(`${base}/sessions/s1`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const health2 = await (await fetch(`${base}/health`)).json();
    assert.equal((health2 as { sessions: number }).sessions, 0);
  });
});

test("KR-1: an aborted first turn is not persisted with a dangling [user] transcript", async () => {
  await withServerHandle(async (base, http) => {
    // Abort mid-first-turn: a text_delta listener stops the agent, so the turn
    // ends reason:"stop" with the assistant message NOT appended (the post-
    // streamTurn abort check) → transcript = [user]. Same code path a client
    // disconnect hits (onClose → agent.stop()), but deterministic.
    http.agent.hooks.on("text_delta", () => http.agent.stop());
    mockOf(http).script({ text: "partial" });

    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", session: "s-abort" }),
    });
    const lines: Record<string, unknown>[] = [];
    await readNdjson(res, (o) => lines.push(o));
    const done = lines.at(-1) as { type?: string; reason?: string };
    assert.equal(done.type, "done", "the stream ends with a done event");
    assert.equal(done.reason, "stop", "the aborted first turn resolves reason:stop");

    // KR-1: the dangling [user] snapshot is NOT persisted → no tracked session.
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal((health as { sessions: number }).sessions, 0, "an aborted first turn is not persisted");
  });
});

test("per-session usage and model are isolated across sessions (AC-8)", async () => {
  // Routing's per-turn hooks (active even when its soft switch is off) would
  // reset the agent's model each turn and mask the bleed this test pins, so kill
  // it for the duration — the per-session isolation under test is orthogonal.
  const prevRouting = process.env.EAGENT_ROUTING;
  process.env.EAGENT_ROUTING = "off";
  try {
    await withServerHandle(async (base, http) => {
      const initialModel = http.model;
      const modelsSeen: string[] = [];
      let changed = false;
      // One-shot: mutate the shared agent's model DURING the first turn (session A).
      // If model bled across sessions, B's turn would inherit it.
      const sub = http.agent.hooks.on("turn_start", () => {
        if (!changed) {
          changed = true;
          http.agent.model = "model-from-A";
        }
      });
      // Record the model each provider turn actually saw, in call order.
      mockOf(http).script((req) => {
        modelsSeen.push(req.model);
        return { text: "ok" };
      });

      const run = async (session: string, input: string): Promise<{ type: string; usage: Usage }> => {
        const res = await fetch(`${base}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input, session }),
        });
        const lines = (await res.text())
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { type: string; usage?: Usage });
        return lines.at(-1) as { type: string; usage: Usage };
      };

      const a1 = await run("A", "alpha"); // session A, fresh
      const a2 = await run("A", "beta"); // session A again, accumulates within the session
      const b1 = await run("B", "alpha"); // session B, brand new

      // Within-session accumulation still works: A's 2nd done.usage exceeds its 1st.
      assert.ok(a2.usage.inputTokens > a1.usage.inputTokens, "session A accumulates across its own turns");

      // USAGE ISOLATION: B's done.usage is B's own tokens, NOT the process-lifetime
      // cumulative (A+B). The old shared-agent bug reported agent.usage = lifetime
      // total, so B would exceed A's accumulated total; per-session it is far less.
      assert.ok(b1.usage.inputTokens < a2.usage.inputTokens, "B's usage is its own, not A+B cumulative");

      // FRESH SESSION FROM THE INITIAL SNAPSHOT: B starts from an empty transcript
      // and zero usage, so its first-turn cost equals A's first-turn cost (same input).
      assert.deepEqual(b1.usage, a1.usage);

      // MODEL ISOLATION: the model change applied during A's turn did not bleed into B.
      assert.equal(modelsSeen[0], "model-from-A", "the model change took effect during A's turn");
      assert.equal(modelsSeen.at(-1), initialModel, "B's turn used the initial model (snapshot-isolated)");

      sub.dispose();
    });
  } finally {
    if (prevRouting === undefined) delete process.env.EAGENT_ROUTING;
    else process.env.EAGENT_ROUTING = prevRouting;
  }
});

test("POST /run rejects a missing input", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("a configured token gates mutating routes but not /health", async () => {
  await withServer(
    async (base) => {
      // /health is open.
      assert.equal((await fetch(`${base}/health`)).status, 200);
      // /run without a token is rejected.
      const noauth = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi" }),
      });
      assert.equal(noauth.status, 401);
      await noauth.text();
      // /run with the correct bearer token succeeds.
      const ok = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer secret" },
        body: JSON.stringify({ input: "hi" }),
      });
      assert.equal(ok.status, 200);
      await ok.text();
    },
    { token: "secret" },
  );
});

// -- D-W9.6a: fail-closed on a dangerous bind (non-loopback + no token) --------

/** Run `body` with EAGENT_TOKEN and EAGENT_HOST cleared, restoring both after. */
async function withClearBindEnv(body: () => Promise<void>): Promise<void> {
  const prevToken = process.env.EAGENT_TOKEN;
  const prevHost = process.env.EAGENT_HOST;
  delete process.env.EAGENT_TOKEN;
  delete process.env.EAGENT_HOST;
  try {
    await body();
  } finally {
    if (prevToken === undefined) delete process.env.EAGENT_TOKEN;
    else process.env.EAGENT_TOKEN = prevToken;
    if (prevHost === undefined) delete process.env.EAGENT_HOST;
    else process.env.EAGENT_HOST = prevHost;
  }
}

test("createHttpServer REFUSES a non-loopback bind with no token (fail-closed)", async () => {
  await withClearBindEnv(async () => {
    await assert.rejects(
      () => createHttpServer({ provider: "mock", logger: silentLogger, host: "0.0.0.0" }),
      /token/i,
      "a 0.0.0.0 bind with an empty token must throw before listening",
    );
  });
});

test("createHttpServer allows a non-loopback bind WHEN a token is set", async () => {
  await withClearBindEnv(async () => {
    const http = await createHttpServer({
      provider: "mock",
      logger: silentLogger,
      host: "0.0.0.0",
      token: "secret",
    });
    // It constructs (never listens); just tear the host down.
    await http.close();
  });
});

test("createHttpServer allows a loopback bind with no token (dev posture unaffected)", async () => {
  await withClearBindEnv(async () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      const http = await createHttpServer({ provider: "mock", logger: silentLogger, host });
      await http.close();
    }
  });
});

test("an oversized request body is rejected with 413", async () => {
  await withServer(
    async (base) => {
      const big = "x".repeat(200);
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: big }),
      });
      assert.equal(res.status, 413);
      await res.text();
    },
    { maxBodyBytes: 50 },
  );
});

test("unknown routes 404 with the route list", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { routes: string[] };
    assert.ok(Array.isArray(body.routes));
  });
});

// -- elicitation: durable server-side ask/resume (the `ask` extension over HTTP) --

test("a mid-turn ask emits action_required and POST /answer resumes the turn", async () => {
  await withServerHandle(async (base, http) => {
    // Turn 1 asks; turn 2 echoes whatever answer flowed back as the tool result,
    // proving the supplied answer actually influenced the run.
    mockOf(http).script((req, i) => {
      if (i === 0) {
        return {
          toolCalls: [
            { name: "ask_user_question", arguments: { question: "Which DB?", options: ["Postgres", "MySQL"] } },
          ],
        };
      }
      const toolMsg = req.messages.find((m) => m.role === "tool");
      const block = toolMsg?.content.find((b) => b.type === "tool_result");
      const echoed = block && block.type === "tool_result" ? block.content : "";
      return { text: `chosen: ${echoed}` };
    });

    const lines: Record<string, unknown>[] = [];
    let answered: { status: number; resolved: boolean } | undefined;
    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "set up the db" }),
    });
    assert.equal(res.status, 200);

    await readNdjson(res, (obj) => {
      lines.push(obj);
      if (obj.type === "action_required" && !answered) {
        // Answer out-of-band on a separate request while /run is still open.
        void fetch(`${base}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: obj.id, answer: "Postgres" }),
        }).then(async (r) => {
          answered = { status: r.status, resolved: ((await r.json()) as { resolved: boolean }).resolved };
        });
      }
    });

    const action = lines.find((l) => l.type === "action_required");
    assert.ok(action, "an action_required line was emitted mid-turn");
    assert.equal(action.question, "Which DB?");
    assert.deepEqual(action.options, ["Postgres", "MySQL"]);
    assert.equal(typeof action.id, "number");

    assert.ok(answered, "the /answer request completed");
    assert.equal(answered.status, 200);
    assert.equal(answered.resolved, true);

    // The answer reached the tool (tool_end echoes "Answer: Postgres") and the
    // model's final text reflects it — the turn resumed and completed.
    const toolEnd = lines.find((l) => l.type === "tool_end" && l.name === "ask_user_question");
    assert.ok(toolEnd, "the ask tool finished");
    assert.match(String(toolEnd.content), /Postgres/, "the ask tool returned the supplied answer");
    assert.equal(lines.at(-1)?.type, "done", "the turn completed");
    const finalText = lines.filter((l) => l.type === "text_delta").map((l) => String(l.text)).join("");
    assert.match(finalText, /chosen: .*Postgres/, "the model saw the answer and echoed it");
  });
});

test("an unanswered ask falls back on the askTimeoutMs and the turn still completes", async () => {
  await withServerHandle(
    async (base, http) => {
      mockOf(http).script((req, i) => {
        if (i === 0) {
          return { toolCalls: [{ name: "ask_user_question", arguments: { question: "Which env?" } }] };
        }
        const toolMsg = req.messages.find((m) => m.role === "tool");
        const block = toolMsg?.content.find((b) => b.type === "tool_result");
        const echoed = block && block.type === "tool_result" ? block.content : "";
        return { text: `fellback: ${echoed}` };
      });

      const lines: Record<string, unknown>[] = [];
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "deploy it" }),
      });
      // Never answer: the tiny timeout resolves the ask to the fallback.
      await readNdjson(res, (obj) => lines.push(obj));

      assert.ok(lines.find((l) => l.type === "action_required"), "the ask still surfaced");
      const toolEnd = lines.find((l) => l.type === "tool_end" && l.name === "ask_user_question");
      assert.ok(toolEnd, "the ask tool finished without an answer");
      assert.match(String(toolEnd.content), /proceed.*assumption/i, "it took the proceed-with-assumption fallback");
      assert.equal(lines.at(-1)?.type, "done", "the turn completed (no hang)");
    },
    { askTimeoutMs: 25 },
  );
});

test("a client disconnect mid-elicitation frees the lock (no hang)", async () => {
  await withServerHandle(async (base, http) => {
    mockOf(http).script((_req, i) =>
      i === 0
        ? { toolCalls: [{ name: "ask_user_question", arguments: { question: "Which region?" } }] }
        : { text: "resumed" },
    );

    // Start a run, read until the ask surfaces, then abort the request so the
    // client disconnects while the turn is parked on the elicitation.
    const ctrl = new AbortController();
    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "where to?" }),
      signal: ctrl.signal,
    });
    assert.ok(res.body, "the run stream is open");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sawAction = false;
    let buf = "";
    while (!sawAction) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("action_required")) sawAction = true;
    }
    assert.ok(sawAction, "the ask surfaced before the disconnect");
    ctrl.abort();
    await reader.cancel().catch(() => {});

    // The lock must free promptly: a fresh /run succeeds (200), not 409 (busy).
    let ok = false;
    for (let attempt = 0; attempt < 50 && !ok; attempt++) {
      const r = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "again" }),
      });
      if (r.status === 200) {
        ok = true;
        await r.text();
      } else {
        await r.text();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    assert.ok(ok, "a subsequent /run returns 200 (the single-flight lock was released)");
  });
});

test("a normal turn (no ask) emits no action_required line (back-compat)", async () => {
  await withServerHandle(async (base, http) => {
    mockOf(http).script({ text: "plain answer" });
    const lines: Record<string, unknown>[] = [];
    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });
    await readNdjson(res, (obj) => lines.push(obj));
    assert.equal(lines.find((l) => l.type === "action_required"), undefined, "no elicitation on a normal turn");
    assert.equal(lines.at(-1)?.type, "done");
  });
});

test("POST /answer without the token is rejected when a token is configured", async () => {
  await withServerHandle(
    async (base) => {
      const res = await fetch(`${base}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: 1, answer: "x" }),
      });
      assert.equal(res.status, 401);
      await res.text();
      // With the token, an unknown id is a clean 404 (not 401) — auth passed.
      const res2 = await fetch(`${base}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer secret" },
        body: JSON.stringify({ id: 999, answer: "x" }),
      });
      assert.equal(res2.status, 404);
      const body = (await res2.json()) as { resolved: boolean };
      assert.equal(body.resolved, false);
    },
    { token: "secret" },
  );
});

test("a guard's confirm prompt is DENIED on the server (fail-safe, not auto-approved)", async () => {
  // Regression: the server now supplies its own `ui` for the `ask` elicitation
  // channel; its `confirm` MUST stay fail-safe (deny) like the prior `defaultUI`,
  // NOT auto-approve. If it auto-approved, every ask-mode guard (write-guard,
  // secret-guard, flow-guard, risk-guard, bash-policy, …) would silently
  // fail-open on the server. Here write-guard's blind-overwrite prompt must BLOCK
  // the write, and the file on disk must be untouched.
  const dir = mkdtempSync(join(tmpdir(), "eagent-srv-guard-"));
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "ORIGINAL");
  const prev = process.env.EAGENT_WORKSPACE;
  process.env.EAGENT_WORKSPACE = dir; // set before the server builds (write-guard reads it)
  try {
    await withServerHandle(async (base, http) => {
      // Turn 0: blindly overwrite a file the session never read ⇒ write-guard asks.
      mockOf(http).script((_req, i) =>
        i === 0
          ? { toolCalls: [{ name: "write", arguments: { path: "victim.txt", content: "OVERWRITTEN" } }] }
          : { text: "done" },
      );
      const lines: Record<string, unknown>[] = [];
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "overwrite it" }),
      });
      await readNdjson(res, (obj) => lines.push(obj));
      const writeEnd = lines.find((l) => l.type === "tool_end" && l.name === "write") as
        | { isError?: boolean; content?: string }
        | undefined;
      assert.ok(writeEnd, "the write tool call ran");
      assert.equal(writeEnd?.isError, true, "write-guard blocked the blind overwrite (confirm must deny)");
    });
    // The strongest proof: the overwrite never reached disk.
    assert.equal(readFileSync(victim, "utf8"), "ORIGINAL", "blind overwrite must not reach disk");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_WORKSPACE;
    else process.env.EAGENT_WORKSPACE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- SRV-1 / SRV-2: request-lifecycle crash prevention -------------------------

/** Poll `GET /health` until it answers 200 (the host is still alive). */
async function healthyWithin(base: string, tries = 50): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.status === 200) {
        await r.text();
        return true;
      }
      await r.text();
    } catch {
      /* server not answering yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/** Poll `POST /run` until it returns 200 (the single-flight lock is free). */
async function runFreeWithin(base: string, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "again" }),
    });
    await r.text();
    if (r.status === 200) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test("SRV-1a/1b: an 'error' on a response is absorbed, never crashing the host", async () => {
  // The exact EventEmitter-error crash path SRV-1 guards: an unlistened 'error'
  // on a ServerResponse throws as an uncaught exception and takes the whole
  // process down. The class-wide res.on('error') registered at the top of the
  // createServer callback must absorb it. (This injects the event directly: a
  // raw-socket abort is handled by Node's http layer as res 'close', so it does
  // not surface a response 'error' to exercise this path — see the concern noted
  // by the dev.) Without the fix this test crashes the process.
  await withServerHandle(async (base, http) => {
    http.server.once("request", (_req, res) => {
      res.emit("error", new Error("simulated socket reset"));
    });
    await fetch(`${base}/health`).then((r) => r.text());
    assert.ok(await healthyWithin(base), "the host survived an 'error' emitted on a response");
  });
});

test("SRV-1b: a mid-stream client abort tears the turn down without crashing the host", async () => {
  await withServerHandle(async (base, http) => {
    // A large first-turn payload keeps the server writing continuously (the mock
    // chunks text into many text_delta events). A raw-socket abort mid-stream
    // must tear the turn down (single-flight lock freed) and leave the host up.
    // Later turns are small so the busy-release probe finishes fast.
    mockOf(http).script((_req, i) => (i === 0 ? { text: "x".repeat(2_000_000) } : { text: "ok" }));

    const url = new URL(base);
    const socket = net.connect(Number(url.port), url.hostname);
    socket.on("error", () => {}); // ignore the client-side reset we cause below
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });

    const reqBody = JSON.stringify({ input: "stream a lot" });
    socket.write(
      `POST /run HTTP/1.1\r\nHost: ${url.host}\r\ncontent-type: application/json\r\n` +
        `content-length: ${Buffer.byteLength(reqBody)}\r\nconnection: close\r\n\r\n${reqBody}`,
    );

    // Wait until the stream is flowing, then abort ungracefully (no drain) so the
    // server is left with pending writes that fail when the reset arrives.
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    socket.destroy();

    assert.ok(await healthyWithin(base), "the host survived the mid-stream socket error");
    assert.ok(await runFreeWithin(base), "the turn tore down and released the single-flight lock");
  });
});

test("SRV-1a: destroying the socket during a non-streaming response does not crash the host", async () => {
  // Best-effort, class-wide coverage: a small /health response may fully buffer
  // and emit no 'error', so this cannot fail-first on its own (design §6 caveat).
  // The deterministic no-crash proof is SRV-1b; this pins the class-wide listener
  // over a non-streaming route without asserting a false-green outcome.
  await withServerHandle(async (base) => {
    const url = new URL(base);
    const socket = net.connect(Number(url.port), url.hostname);
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.write(`GET /health HTTP/1.1\r\nHost: ${url.host}\r\nconnection: close\r\n\r\n`);
    socket.destroy();
    assert.ok(await healthyWithin(base), "the host survived a socket reset on a non-streaming response");
  });
});

test("SRV-2a: sendJson no-ops when headers are already sent (no throw, no second writeHead)", () => {
  let writeHeadCalls = 0;
  let endCalls = 0;
  const stub = {
    headersSent: true,
    writeHead: () => {
      writeHeadCalls++;
    },
    end: () => {
      endCalls++;
    },
  } as unknown as ServerResponse;
  assert.doesNotThrow(() => sendJson(stub, 500, { error: "boom" }));
  assert.equal(writeHeadCalls, 0, "writeHead must not be called once headers are sent");
  assert.equal(endCalls, 0, "no second body is written");
});

test("SRV-2b: a setup-window throw surfaces as an in-stream error line, not a silent 200", async () => {
  await withServerHandle(async (base, http) => {
    const original = http.agent.restore.bind(http.agent);
    http.agent.restore = () => {
      throw new Error("boom");
    };
    try {
      const lines: Record<string, unknown>[] = [];
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi" }),
      });
      assert.equal(res.status, 200, "headers were already committed before the setup throw");
      await readNdjson(res, (o) => lines.push(o)); // resolves only when the stream closes
      const err = lines.find((l) => l.type === "error");
      assert.ok(err, "the setup throw was written as a terminal {type:'error'} line");
      assert.match(String(err.message), /boom/, "the error line carries the thrown message");
    } finally {
      http.agent.restore = original;
    }
  });
});

// -- SRV-3 / SRV-5 / SRV-6: session cap + shutdown lifecycle -------------------

/** Set EAGENT_MAX_SESSIONS for the body, restoring the prior value after. */
async function withMaxSessions(value: string | undefined, body: () => Promise<void>): Promise<void> {
  const prev = process.env.EAGENT_MAX_SESSIONS;
  if (value === undefined) delete process.env.EAGENT_MAX_SESSIONS;
  else process.env.EAGENT_MAX_SESSIONS = value;
  try {
    await body();
  } finally {
    if (prev === undefined) delete process.env.EAGENT_MAX_SESSIONS;
    else process.env.EAGENT_MAX_SESSIONS = prev;
  }
}

test("SRV-3: maxSessions() parses EAGENT_MAX_SESSIONS with a safe 1000 default", () => {
  const prev = process.env.EAGENT_MAX_SESSIONS;
  // A real LayeredConfig honors the legacy EAGENT_MAX_SESSIONS alias and reads
  // process.env live, so mutating the env between calls is reflected.
  const cfg = new LayeredConfig({ overrideStore: new MemoryStore() });
  try {
    delete process.env.EAGENT_MAX_SESSIONS;
    assert.equal(maxSessions(cfg), 1000, "unset → 1000");
    // Empty / whitespace / non-numeric / negative / non-integer all fall back to
    // the safe default (never silently disabling the cap or hanging the evict loop).
    for (const bad of ["", "  ", "abc", "-1", "1.5"]) {
      process.env.EAGENT_MAX_SESSIONS = bad;
      assert.equal(maxSessions(cfg), 1000, `${JSON.stringify(bad)} → 1000`);
    }
    process.env.EAGENT_MAX_SESSIONS = "42";
    assert.equal(maxSessions(cfg), 42, "a non-negative integer overrides");
    process.env.EAGENT_MAX_SESSIONS = "0";
    assert.equal(maxSessions(cfg), 0, "an explicit 0 → unbounded");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_MAX_SESSIONS;
    else process.env.EAGENT_MAX_SESSIONS = prev;
  }
});

test("SRV-3: the sessions map is LRU-bounded — the least-recently-used session is evicted", async () => {
  await withMaxSessions("2", () =>
    withServer(async (base) => {
      const run = async (session: string): Promise<void> => {
        const r = await fetch(`${base}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "hi", session }),
        });
        await r.text();
      };
      await run("A");
      await run("B");
      await run("A"); // re-touch A → A is now newest, B is the least-recently-used
      await run("C"); // inserting C exceeds cap=2 → evicts B (the LRU)

      const health = (await (await fetch(`${base}/health`)).json()) as { sessions: number };
      assert.equal(health.sessions, 2, "the cap holds the map at 2");

      // Identity probe (size alone can't tell LRU from FIFO): DELETE returns 200
      // for a session that still exists, 404 for one that was evicted.
      const del = async (id: string): Promise<number> =>
        (await fetch(`${base}/sessions/${id}`, { method: "DELETE" })).status;
      assert.equal(await del("B"), 404, "B was the least-recently-used and got evicted");
      assert.equal(await del("A"), 200, "A was re-touched and survived");
      assert.equal(await del("C"), 200, "C is the newest and survived");
    }),
  );
});

test("SRV-3: EAGENT_MAX_SESSIONS=0 disables the cap (sessions unbounded)", async () => {
  await withMaxSessions("0", () =>
    withServer(async (base) => {
      for (const session of ["A", "B", "C"]) {
        const r = await fetch(`${base}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "hi", session }),
        });
        await r.text();
      }
      const health = (await (await fetch(`${base}/health`)).json()) as { sessions: number };
      assert.equal(health.sessions, 3, "cap=0 retains every session");
      for (const session of ["A", "B", "C"]) {
        assert.equal((await fetch(`${base}/sessions/${session}`, { method: "DELETE" })).status, 200);
      }
    }),
  );
});

test("SRV-6: HttpServer.close is idempotent — session_shutdown emits exactly once", async () => {
  const http = await createHttpServer({ provider: "mock", logger: silentLogger });
  let shutdowns = 0;
  http.agent.hooks.on("session_shutdown", () => {
    shutdowns++;
  });
  await http.close();
  await http.close(); // a second close must be a no-op, not a second dispose
  assert.equal(shutdowns, 1, "a repeated close() does not re-dispose / re-emit session_shutdown");
});
