/**
 * E2E concurrent-isolation smoke against the REAL server process.
 *
 * Unlike `test/server.test.ts` (which drives `createHttpServer` in-process), this
 * spawns `src/server.ts` as an actual child process (offline: API keys stripped
 * so the mock provider is selected, MCP disabled) and fires two INTERLEAVED /run
 * requests for two different sessions. Each wire stream must carry ONLY its own
 * session's events plus its own terminal frame — the end-to-end proof that the
 * per-session lock + ALS streaming guard hold across the whole real request path.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(repoRoot, "src", "server.ts");

/** Grab an ephemeral free port on loopback (closed again before we hand it over). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll GET /health until the spawned server answers 200 (or time out). */
async function waitHealthy(base: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      await r.text();
      if (r.status === 200) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Read a whole NDJSON response into parsed line objects. */
async function readAll(res: Response): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  assert.ok(res.body, "response has a body");
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
      if (line) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  const tail = buf.trim();
  if (tail) lines.push(JSON.parse(tail) as Record<string, unknown>);
  return lines;
}

const textOf = (lines: Record<string, unknown>[]): string =>
  lines.filter((l) => l.type === "text_delta").map((l) => String(l.text)).join("");

test("E2E: two interleaved /runs on the real server carry only their own session's events", { timeout: 60_000 }, async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [serverPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        // Offline: no provider keys → the mock provider (which echoes the input
        // and yields across microtasks, forcing a real interleave); no MCP children;
        // no token so loopback stays open (dev posture).
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        GEMINI_API_KEY: "",
        EAGENT_MCP_SERVERS: "",
        EAGENT_TOKEN: "",
      },
      stdio: ["ignore", "ignore", "inherit"],
    });

    assert.ok(await waitHealthy(base), "the spawned server became healthy");

    // Fire BOTH without awaiting the first — a genuine cross-session interleave on
    // the real socket path. The default mock echoes the input, so each stream's
    // text is uniquely tagged with its own marker.
    const [aLines, bLines] = await Promise.all([
      fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "ALPHA-MARKER respond please", session: "eA" }),
      }).then(readAll),
      fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "BRAVO-MARKER respond please", session: "eB" }),
      }).then(readAll),
    ]);

    const aText = textOf(aLines);
    const bText = textOf(bLines);

    assert.match(aText, /ALPHA-MARKER/, "session A's stream echoes A's own input");
    assert.doesNotMatch(aText, /BRAVO-MARKER/, "session B's text did not leak into A's stream");
    assert.match(bText, /BRAVO-MARKER/, "session B's stream echoes B's own input");
    assert.doesNotMatch(bText, /ALPHA-MARKER/, "session A's text did not leak into B's stream");

    // Each stream ends with its OWN canonical terminal carrying its OWN session id.
    const aTerm = aLines.at(-1) as { type?: string; session?: string };
    const bTerm = bLines.at(-1) as { type?: string; session?: string };
    assert.equal(aTerm.type, "agent_end", "A ends with the canonical terminal");
    assert.equal(aTerm.session, "eA", "A's terminal carries A's session");
    assert.equal(bTerm.type, "agent_end", "B ends with the canonical terminal");
    assert.equal(bTerm.session, "eB", "B's terminal carries B's session");
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
});
