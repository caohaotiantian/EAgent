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
import { currentActingAgent } from "../src/kernel/agent.js";
import { LayeredConfig } from "../src/config.js";
import { MemoryStore } from "../src/kernel/store.js";
import type { MockProvider } from "../src/providers/mock.js";
import { unwrapProvider } from "../src/extensions/lib/provider-wrap.js";
import { defineTool, ok } from "../src/kernel/define.js";
import type { CompletionRequest, ToolResult, Usage } from "../src/kernel/types.js";
import { silentLogger } from "./helpers.js";

/** The most recent user-role text in a request (stable within a session's turns,
 *  since the mock's turn counter is global — branch on this, not the index). */
function latestUserText(req: CompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    const t = m.content.find((b) => b.type === "text");
    if (t && t.type === "text") return t.text;
  }
  return "";
}

/** POST /run and return the open response (NDJSON), for the multi-turn tests. */
function post(base: string, session: string, input: string): Promise<Response> {
  return fetch(`${base}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, session }),
  });
}

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
    assert.equal(events.at(-1)?.type, "agent_end");
    assert.ok(types.includes("done"), "the legacy done line is still present (deprecation window)");
  });
});

test("AC3: a /run turn carries tool ids, reasoning_delta, and a canonical agent_end terminal", async () => {
  await withServerHandle(async (base, http) => {
    // Turn 0 reasons then reads a real file (so tool_start/tool_end fire); turn 1 wraps up.
    mockOf(http).script((_req, i) =>
      i === 0
        ? { reasoning: "let me check the manifest", toolCalls: [{ name: "read", arguments: { path: "package.json" } }] }
        : { text: "all set" },
    );
    const lines: Record<string, unknown>[] = [];
    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "read the manifest", session: "ac3" }),
    });
    await readNdjson(res, (o) => lines.push(o));

    const toolStart = lines.find((l) => l.type === "tool_start");
    const toolEnd = lines.find((l) => l.type === "tool_end");
    assert.ok(toolStart, "a tool_start line was emitted");
    assert.ok(toolEnd, "a tool_end line was emitted");
    assert.equal(typeof toolStart.id, "string", "tool_start now carries an id");
    assert.equal(typeof toolEnd.id, "string", "tool_end now carries an id");

    assert.ok(lines.some((l) => l.type === "reasoning_delta"), "the server now emits reasoning_delta");

    const terminal = lines.at(-1) as { type?: string; session?: string };
    assert.equal(terminal.type, "agent_end", "the last line is the canonical agent_end terminal");
    assert.equal(terminal.session, "ac3", "the canonical terminal carries the session");
    assert.ok(lines.some((l) => l.type === "done"), "the legacy done line is still present (deprecation window)");
  });
});

test("G1: a maxTurns-terminated /run turn emits the error line (CLI/HTTP parity)", async () => {
  // The kernel emits the `error` hook on maxTurns exhaustion but does NOT throw
  // (reason stays "stop"); the server used to drop it while the CLI emitted it.
  process.env.EAGENT_AGENT_MAX_TURNS = "1";
  try {
    await withServerHandle(async (base, http) => {
      // The model never stops calling a tool → the single turn exhausts maxTurns.
      mockOf(http).script(() => ({ toolCalls: [{ name: "read", arguments: { path: "package.json" } }] }));
      const lines: Record<string, unknown>[] = [];
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "loop", session: "mt" }),
      });
      await readNdjson(res, (o) => lines.push(o));

      const err = lines.find((l) => l.type === "error");
      assert.ok(err, "the maxTurns exhaustion now surfaces an error line (previously dropped)");
      assert.match(String(err.message), /maxTurns/, "the error names the maxTurns limit");
      assert.equal(String(err.where), "agent.run", "the error carries the kernel `where`");
      assert.equal(lines.filter((l) => l.type === "error").length, 1, "emitted exactly once (no double-emit)");
      assert.equal(lines.at(-1)?.type, "agent_end", "still ends with the canonical terminal");
      assert.ok(lines.some((l) => l.type === "done"), "the legacy done line is still present");
    });
  } finally {
    delete process.env.EAGENT_AGENT_MAX_TURNS;
  }
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
    // Abort mid-first-turn: a text_delta listener stops the ACTING (per-session)
    // agent, so the turn ends reason:"stop" with the assistant message NOT appended
    // (the post-streamTurn abort check) → transcript = [user]. Same code path a
    // client disconnect hits (onClose → agent.stop()), but deterministic.
    http.agent.hooks.on("text_delta", () => currentActingAgent()?.stop());
    mockOf(http).script({ text: "partial" });

    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", session: "s-abort" }),
    });
    const lines: Record<string, unknown>[] = [];
    await readNdjson(res, (o) => lines.push(o));
    const terminal = lines.at(-1) as { type?: string; reason?: string };
    assert.equal(terminal.type, "agent_end", "the stream ends with the canonical agent_end event");
    assert.equal(terminal.reason, "stop", "the aborted first turn resolves reason:stop");
    assert.ok(lines.some((l) => l.type === "done"), "the legacy done line is still present (deprecation window)");

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
      // One-shot: mutate the ACTING (per-session) agent's model DURING the first
      // turn (session A). If model bled across sessions, B's turn would inherit it;
      // under per-session Agents it cannot (B runs on a distinct Agent).
      const sub = http.agent.hooks.on("turn_start", () => {
        if (!changed) {
          changed = true;
          currentActingAgent()!.model = "model-from-A";
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
    assert.equal(lines.at(-1)?.type, "agent_end", "the turn completed");
    assert.ok(lines.some((l) => l.type === "done"), "the legacy done line is still present (deprecation window)");
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
      assert.equal(lines.at(-1)?.type, "agent_end", "the turn completed (no hang)");
      assert.ok(lines.some((l) => l.type === "done"), "the legacy done line is still present (deprecation window)");
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
    assert.equal(lines.at(-1)?.type, "agent_end");
    assert.ok(lines.some((l) => l.type === "done"), "the legacy done line is still present (deprecation window)");
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
    // Force a throw in the setup window (after writeHead, before the terminal): the
    // per-session Agent shares this hooks bus, so `wireJsonl`'s first `hooks.on` throws.
    const original = http.agent.hooks.on.bind(http.agent.hooks);
    http.agent.hooks.on = (() => {
      throw new Error("boom");
    }) as typeof http.agent.hooks.on;
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
      assert.ok(err.where, "the error line now carries a `where` field (canonical error shape)");
    } finally {
      http.agent.hooks.on = original;
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

// -- Phase A: root-detection + danglingUser rollback on the per-session Agent --

test("AC4: a session root can launch_job; a fork within the session is refused (currentActingAgent === currentRootAgent)", async () => {
  await withServerHandle(async (base, http) => {
    const launchJob = http.agent.tools.get("launch_job")!;

    // A cap-free probe (survives the spawn_agent child-registry strip) that invokes
    // launch_job.execute from within the FORK's acting-agent context.
    let forkResult: ToolResult | undefined;
    http.agent.tools.register(
      defineTool({
        name: "probe_fork",
        description: "invokes launch_job from the acting (fork) context",
        parameters: { type: "object", properties: {} },
        execute: async (_a, ctx) => {
          forkResult = await launchJob.execute({ prompt: "nested" }, ctx);
          return ok("probed");
        },
      }),
    );

    mockOf(http).script((req) => {
      const sys = req.systemPrompt;
      // The spawned fork: call probe_fork once (→ nested launch_job, refused), then finish.
      if (sys.includes("PROBE-CHILD")) {
        return req.messages.some((m) => m.role === "tool") ? { text: "fork-done" } : { toolCalls: [{ name: "probe_fork", arguments: {} }] };
      }
      // A launch_job background child (DEFAULT_JOB_SYSTEM): finish immediately.
      if (sys.includes("background sub-agent")) return { text: "job-done" };
      // The session ROOT: launch_job at the root (allowed), spawn a fork, then finish.
      const toolTurns = req.messages.filter((m) => m.role === "tool").length;
      if (toolTurns === 0) return { toolCalls: [{ name: "launch_job", arguments: { prompt: "root-task" } }] };
      if (toolTurns === 1) return { toolCalls: [{ name: "spawn_agent", arguments: { mode: "single", prompt: "go", system: "PROBE-CHILD" } }] };
      return { text: "root-done" };
    });

    const lines: Record<string, unknown>[] = [];
    await readNdjson(await post(base, "ac4", "start"), (o) => lines.push(o));

    // ROOT direction: the session root's own launch_job (dispatched by the loop) was
    // ALLOWED — a tool_end with isError falsy, not a refusal.
    const rootLaunch = lines.find((l) => l.type === "tool_end" && l.name === "launch_job");
    assert.ok(rootLaunch, "the session root's launch_job produced a tool_end");
    assert.notEqual(rootLaunch.isError, true, "the session root is allowed to launch_job");

    // FORK direction: the fork's launch_job was REFUSED by rootOnly (fork !== root).
    // (The identical predicate gates budget-cap's sessionUsd update — the fork's spend
    // cannot clobber the session budget; unit-covered in budget-cap.test.ts.)
    assert.ok(forkResult, "the fork invoked launch_job");
    assert.equal(forkResult!.isError, true, "a fork within the session is refused launch_job");
    assert.match(forkResult!.content, /sub-agent/, "the refusal names the sub-agent recursion guard");
  });
});

test("danglingUser rollback: an aborted turn on a persistent session Agent leaves no bare user for the next turn", async () => {
  await withServerHandle(async (base, http) => {
    const captured: string[][] = []; // provider-seen message roles, per turn
    let abortThisTurn = false;
    // Abort the ACTING (per-session) agent mid-stream when armed.
    const sub = http.agent.hooks.on("text_delta", () => {
      if (abortThisTurn) currentActingAgent()?.stop();
    });
    mockOf(http).script((req) => {
      captured.push(req.messages.map((m) => m.role));
      return { text: "ok" };
    });

    // Turn 1: normal → the session Agent is persisted with valid alternating state.
    await readNdjson(await post(base, "s", "one"), () => {});
    // Turn 2: abort mid-stream → a trailing bare [user] on the PERSISTENT Agent that
    // the rollback (pre-turn snapshot / restore on dangling) must discard.
    abortThisTurn = true;
    await readNdjson(await post(base, "s", "two"), () => {});
    // Turn 3: normal → must NOT append a second consecutive user message.
    abortThisTurn = false;
    const lines3: Record<string, unknown>[] = [];
    await readNdjson(await post(base, "s", "three"), (o) => lines3.push(o));

    const turn3Roles = captured.at(-1)!;
    assert.ok(
      !turn3Roles.some((r, i) => r === "user" && turn3Roles[i + 1] === "user"),
      `turn 3 request carries no two consecutive user messages; got roles: ${turn3Roles.join(",")}`,
    );
    assert.equal((lines3.at(-1) as { type?: string }).type, "agent_end", "turn 3 completed normally");
    assert.ok(turn3Roles.includes("user"), "turn 3 still carries its own user message");
    sub.dispose();
  });
});

// -- Phase B: security-guard state isolation across sessions (AC1 / AC1b) -------
// Each of the 7 security guards keys its session-scoped state on the SESSION ROOT
// (currentRootAgent). Under the still-serial server, a guard decision from
// session A must not leak into session B (its distinct pooled Agent). AC1b (the
// cross-agent exfil catch) is verified within one session: a parent's taint still
// gates a fork's egress via the shared root key (the S2 regression guard).

test("AC1 write-guard: session A's read-set does not let session B blind-overwrite the same path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-wg-iso-"));
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "ORIGINAL");
  const prev = process.env.EAGENT_WORKSPACE;
  process.env.EAGENT_WORKSPACE = dir; // set before the server builds (write-guard reads it)
  try {
    await withServerHandle(async (base, http) => {
      // A reads the file (so its read-set includes it) then blind-overwrites it
      // (ALLOWED — A saw it this session). B blind-overwrites the SAME path with an
      // empty read-set → write-guard must still prompt (server confirm denies) →
      // blocked. If `seen` commingled, B's overwrite would silently pass.
      mockOf(http).script((req) => {
        const user = latestUserText(req);
        const toolMsgs = req.messages.filter((m) => m.role === "tool").length;
        if (user.includes("A")) {
          if (toolMsgs === 0) return { toolCalls: [{ name: "read", arguments: { path: "victim.txt" } }] };
          if (toolMsgs === 1) return { toolCalls: [{ name: "write", arguments: { path: "victim.txt", content: "A-WROTE" } }] };
          return { text: "A-done" };
        }
        if (toolMsgs === 0) return { toolCalls: [{ name: "write", arguments: { path: "victim.txt", content: "B-WROTE" } }] };
        return { text: "B-done" };
      });

      const aLines: Record<string, unknown>[] = [];
      await readNdjson(await post(base, "A", "session A: read then overwrite"), (o) => aLines.push(o));
      const bLines: Record<string, unknown>[] = [];
      await readNdjson(await post(base, "B", "session B: overwrite the same path"), (o) => bLines.push(o));

      const aWrite = aLines.find((l) => l.type === "tool_end" && l.name === "write") as { isError?: boolean } | undefined;
      assert.ok(aWrite, "A's write ran");
      assert.notEqual(aWrite!.isError, true, "A overwrote its own read file (seen this session → allowed)");

      const bWrite = bLines.find((l) => l.type === "tool_end" && l.name === "write") as { isError?: boolean } | undefined;
      assert.ok(bWrite, "B's write ran");
      assert.equal(bWrite!.isError, true, "B was still prompted/blocked (its read-set is isolated from A's)");

      assert.equal(readFileSync(victim, "utf8"), "A-WROTE", "B's blind overwrite never reached disk");
    });
  } finally {
    if (prev === undefined) delete process.env.EAGENT_WORKSPACE;
    else process.env.EAGENT_WORKSPACE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Register benign, offline stand-ins for a shell:exec source and a net:fetch
 *  egress so flow-guard's capability taint is exercised without a real shell or
 *  network call. Both are visible to every session (the shared tools registry). */
function registerFlowGuardTools(http: HttpServer): void {
  http.agent.tools.register(
    defineTool({ name: "taint_src", description: "a shell:exec source", capabilities: ["shell:exec"], parameters: { type: "object", properties: {} }, execute: () => ok("ran") }),
  );
  http.agent.tools.register(
    defineTool({ name: "egress", description: "a net:fetch egress", capabilities: ["net:fetch"], parameters: { type: "object", properties: {} }, execute: () => ok("sent") }),
  );
}

test("AC1 flow-guard: session A's capability taint does not gate session B's egress", async () => {
  await withServerHandle(async (base, http) => {
    registerFlowGuardTools(http);
    mockOf(http).script((req) => {
      const user = latestUserText(req);
      const toolMsgs = req.messages.filter((m) => m.role === "tool").length;
      if (user.includes("A")) {
        if (toolMsgs === 0) return { toolCalls: [{ name: "taint_src", arguments: {} }] };
        if (toolMsgs === 1) return { toolCalls: [{ name: "egress", arguments: {} }] };
        return { text: "A-done" };
      }
      if (toolMsgs === 0) return { toolCalls: [{ name: "egress", arguments: {} }] };
      return { text: "B-done" };
    });

    const aLines: Record<string, unknown>[] = [];
    await readNdjson(await post(base, "A", "session A taints then egresses"), (o) => aLines.push(o));
    const bLines: Record<string, unknown>[] = [];
    await readNdjson(await post(base, "B", "session B egresses only"), (o) => bLines.push(o));

    // Within A the taint is live, so A's OWN egress is held by flow-guard — proving
    // the mechanism is armed so B's pass below is not vacuous.
    const aEgress = aLines.find((l) => l.type === "tool_end" && l.name === "egress") as { isError?: boolean; content?: string } | undefined;
    assert.ok(aEgress, "A's egress ran");
    assert.equal(aEgress!.isError, true, "A's egress is held while A is capability-tainted");
    assert.match(String(aEgress!.content), /flow-guard/, "flow-guard is the guard that held A's egress");

    // Session B is never tainted → flow-guard must NOT hold its egress. A commingled
    // `tainted` set would carry A's shell:exec taint into B and block this.
    const bEgress = bLines.find((l) => l.type === "tool_end" && l.name === "egress") as { isError?: boolean; content?: string } | undefined;
    assert.ok(bEgress, "B's egress ran");
    assert.ok(!/flow-guard/.test(String(bEgress!.content ?? "")), "flow-guard did not hold B's egress (taint is isolated)");
    assert.notEqual(bEgress!.isError, true, "B's egress passed (its taint set is isolated from A's)");
  });
});

test("AC1b flow-guard: a parent's capability taint STILL gates a fork's egress (cross-agent catch preserved)", async () => {
  await withServerHandle(async (base, http) => {
    registerFlowGuardTools(http);
    mockOf(http).script((req) => {
      if (req.systemPrompt.includes("FORK-CHILD")) {
        // The fork: attempt an egress once (must be HELD by the parent's taint), then finish.
        return req.messages.some((m) => m.role === "tool") ? { text: "fork-done" } : { toolCalls: [{ name: "egress", arguments: {} }] };
      }
      // The session root: taint (shell:exec), spawn a fork, then finish.
      const toolMsgs = req.messages.filter((m) => m.role === "tool").length;
      if (toolMsgs === 0) return { toolCalls: [{ name: "taint_src", arguments: {} }] };
      if (toolMsgs === 1) return { toolCalls: [{ name: "spawn_agent", arguments: { mode: "single", prompt: "go", system: "FORK-CHILD" } }] };
      return { text: "root-done" };
    });

    const lines: Record<string, unknown>[] = [];
    await readNdjson(await post(base, "flow-fork", "start"), (o) => lines.push(o));

    // The fork's egress is HELD by the parent's capability taint — `tainted` is
    // shared across the session's fork tree (root-keyed). Keying it on the ACTING
    // (child) agent would drop this confused-deputy exfil catch (the S2 regression).
    const forkEgress = lines.find((l) => l.type === "tool_end" && l.name === "egress") as { isError?: boolean; content?: string } | undefined;
    assert.ok(forkEgress, "the fork's egress ran");
    assert.equal(forkEgress!.isError, true, "the fork's egress is held by the parent's capability taint");
    assert.match(String(forkEgress!.content), /flow-guard/, "flow-guard held the fork's egress via the shared session-root taint");
  });
});

test("AC1 subagent-jobs: session B cannot job_status a job launched by session A", async () => {
  await withServerHandle(async (base, http) => {
    let jobId: string | undefined;
    http.agent.hooks.on("tool_end", ({ call, result }) => {
      if (call.name === "launch_job" && !result.isError) jobId = (result.details as { jobId?: string }).jobId;
    });

    mockOf(http).script((req) => {
      if (req.systemPrompt.includes("background sub-agent")) return { text: "bg" }; // A's job child finishes at once
      const user = latestUserText(req);
      const toolMsgs = req.messages.filter((m) => m.role === "tool").length;
      if (user.includes("launch")) {
        // Session A: launch a job, collect it (so the child settles inside A's turn), finish.
        if (toolMsgs === 0) return { toolCalls: [{ name: "launch_job", arguments: { prompt: "bg" } }] };
        if (toolMsgs === 1) return { toolCalls: [{ name: "collect_job", arguments: { jobId } }] };
        return { text: "A-done" };
      }
      // Session B: try to inspect A's job by its id.
      if (toolMsgs === 0) return { toolCalls: [{ name: "job_status", arguments: { jobId } }] };
      return { text: "B-done" };
    });

    const aLines: Record<string, unknown>[] = [];
    await readNdjson(await post(base, "A", "launch a job"), (o) => aLines.push(o));
    assert.ok(jobId, "session A launched a job");
    const aLaunch = aLines.find((l) => l.type === "tool_end" && l.name === "launch_job") as { isError?: boolean } | undefined;
    assert.notEqual(aLaunch?.isError, true, "A's launch_job succeeded (session root is allowed)");

    const bLines: Record<string, unknown>[] = [];
    await readNdjson(await post(base, "B", "inspect it"), (o) => bLines.push(o));
    const bStatus = bLines.find((l) => l.type === "tool_end" && l.name === "job_status") as { isError?: boolean; content?: string } | undefined;
    assert.ok(bStatus, "B ran job_status");
    assert.equal(bStatus!.isError, true, "B cannot see A's job (the registry is per-session-root)");
    assert.match(String(bStatus!.content), /unknown job/, "B's job_status reports A's id as unknown");
  });
});

// -- Phase C: correctness-state isolation (AC2) + observability (D8) -----------
// The correctness extensions (cost/goal/todo/drift-probe/handoff) key their
// session-scoped state on the SESSION ROOT (currentRootAgent). A session's state
// must not leak into another session's distinct pooled Agent. cost + goal are
// server-observable here; todo/drift-probe/handoff are covered in their own
// test files (their read seams are not exposed over HTTP).

test("D8: GET /sessions/:id returns the session's usage + cost summary; 404 for an unknown id", async () => {
  await withServerHandle(async (base, http) => {
    mockOf(http).script({ text: "ok" });

    // Run a session so it is pooled.
    await readNdjson(await post(base, "obs", "hello"), () => {});

    const res = await fetch(`${base}/sessions/obs`);
    assert.equal(res.status, 200, "a known session returns 200");
    const body = (await res.json()) as { session: string; usage: Usage; costUsd: number };
    assert.equal(body.session, "obs");
    assert.ok(body.usage && typeof body.usage.inputTokens === "number", "usage summary present");
    assert.ok(body.usage.inputTokens > 0, "the session accrued input tokens");
    assert.equal(typeof body.costUsd, "number", "a costUsd figure is present");

    // An unknown session id is a clean 404.
    const miss = await fetch(`${base}/sessions/does-not-exist`);
    assert.equal(miss.status, 404, "an unknown session id 404s");
    await miss.text();
  });
});

test("AC2 cost: GET /sessions/:id reports each session's OWN cost, not a commingled total", async () => {
  // Route each turn through a priced model (gpt-4o) so cost is non-zero and
  // per-session-distinct. Routing would reset the model each turn and mask the
  // switch, so kill it for the duration (orthogonal to the isolation under test).
  const prevRouting = process.env.EAGENT_ROUTING;
  process.env.EAGENT_ROUTING = "off";
  try {
    await withServerHandle(async (base, http) => {
      const sub = http.agent.hooks.on("turn_start", () => {
        currentActingAgent()!.model = "gpt-4o"; // a card-priced model (mock prices at $0)
      });
      mockOf(http).script({ text: "ok" });

      // Session A runs twice (accumulates); session B runs once.
      await readNdjson(await post(base, "costA", "alpha"), () => {});
      await readNdjson(await post(base, "costA", "beta"), () => {});
      await readNdjson(await post(base, "costB", "alpha"), () => {});

      const a = (await (await fetch(`${base}/sessions/costA`)).json()) as { usage: Usage; costUsd: number };
      const b = (await (await fetch(`${base}/sessions/costB`)).json()) as { usage: Usage; costUsd: number };

      assert.ok(a.costUsd > 0, "session A accrued a non-zero cost at the priced model");
      assert.ok(b.costUsd > 0, "session B accrued a non-zero cost");
      // ISOLATION: A ran twice, B once — A's cost strictly exceeds B's. A commingled
      // session total (shared closure, last-writer-wins) would report B's value for A.
      assert.ok(a.costUsd > b.costUsd, `A (2 runs) costUsd ${a.costUsd} must exceed B (1 run) ${b.costUsd}`);
      // And B's own cost equals A's per-run cost — B is a fresh session, not A+B.
      assert.ok(a.usage.inputTokens > b.usage.inputTokens, "A's usage exceeds B's (isolated)");

      sub.dispose();
    });
  } finally {
    if (prevRouting === undefined) delete process.env.EAGENT_ROUTING;
    else process.env.EAGENT_ROUTING = prevRouting;
  }
});

test("AC2 goal: session A's objective pin does not leak into session B's request context", async () => {
  await withServerHandle(async (base, http) => {
    const PIN = "ALPHA-OBJECTIVE-XYZ";
    mockOf(http).script((req) => {
      const user = latestUserText(req);
      const seesPin = req.messages.some(
        (m) => m.role === "system" && m.content.some((b) => b.type === "text" && b.text.includes(PIN)),
      );
      if (user.includes("session A")) {
        // Turn 0: set the objective; a later turn then carries the pin (armed).
        const toolMsgs = req.messages.filter((m) => m.role === "tool").length;
        if (toolMsgs === 0) return { toolCalls: [{ name: "setgoal", arguments: { objective: PIN } }] };
        return { text: seesPin ? "A-sees-pin" : "A-no-pin" };
      }
      // Session B: report whether A's pin leaked into B's context.
      return { text: seesPin ? "B-LEAKED-PIN" : "B-clean" };
    });

    const aLines: Record<string, unknown>[] = [];
    await readNdjson(await post(base, "goalA", "session A sets a goal"), (o) => aLines.push(o));
    const bLines: Record<string, unknown>[] = [];
    await readNdjson(await post(base, "goalB", "session B has no goal"), (o) => bLines.push(o));

    const aText = aLines.filter((l) => l.type === "text_delta").map((l) => String(l.text)).join("");
    const bText = bLines.filter((l) => l.type === "text_delta").map((l) => String(l.text)).join("");

    // Non-vacuous: A's own later turn sees its pin (the anti-drift mechanism is armed).
    assert.match(aText, /A-sees-pin/, "session A's own turn carries the objective pin");
    // ISOLATION: B never sees A's pin. A shared-closure objective would inject it into B.
    assert.match(bText, /B-clean/, "session B's context is free of A's objective pin");
    assert.doesNotMatch(bText, /LEAKED/, "A's objective did not leak into B");
  });
});
