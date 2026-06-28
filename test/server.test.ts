/**
 * The HTTP server front end, driven against a real (offline, mock-backed)
 * server on an ephemeral port.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpServer, type HttpServer } from "../src/server.js";
import type { MockProvider } from "../src/providers/mock.js";
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

/** Reach the server's scriptable mock provider so a test can drive tool calls. */
function mockOf(http: HttpServer): MockProvider {
  return http.agent.providers.get("mock") as MockProvider;
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
