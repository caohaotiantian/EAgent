/**
 * Browser HTTP client for eagent-serve (relative URLs, same-origin in prod).
 */

import { wireObjectToSourceEvent, type SourceEvent } from "@eagent/wire-events";

export type SessionRow = {
  id: string;
  running: boolean;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
};

export type RunResult =
  | { ok: true }
  | { ok: false; status: number; error: string; busy?: boolean };

export type AnswerResult =
  | { status: "resolved" }
  | { status: "gone" }
  | { status: "retry"; statusCode: number; error: string };

const TOKEN_KEY = "eagent.token";

export function loadToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function authHeaders(token: string): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function getHealth(token = ""): Promise<{ ok: boolean; auth: string; model?: string }> {
  const r = await fetch("/health", { headers: authHeaders(token) });
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json() as Promise<{ ok: boolean; auth: string; model?: string }>;
}

export async function listSessions(token: string): Promise<SessionRow[]> {
  const r = await fetch("/sessions", { headers: authHeaders(token) });
  if (!r.ok) throw new Error(`sessions ${r.status}`);
  return r.json() as Promise<SessionRow[]>;
}

export async function stopSession(token: string, id: string): Promise<void> {
  const r = await fetch(`/sessions/${encodeURIComponent(id)}/stop`, {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`stop ${r.status}`);
}

export async function deleteSession(token: string, id: string): Promise<void> {
  const r = await fetch(`/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!r.ok && r.status !== 404) throw new Error(`delete ${r.status}`);
}

export async function postAnswer(
  token: string,
  id: number,
  answer: string,
): Promise<AnswerResult> {
  let r: Response;
  try {
    r = await fetch("/answer", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ id, answer }),
    });
  } catch (e) {
    return { status: "retry", statusCode: 0, error: e instanceof Error ? e.message : String(e) };
  }
  if (r.status >= 200 && r.status < 300) return { status: "resolved" };
  if (r.status === 404) return { status: "gone" };
  const text = await r.text().catch(() => "");
  return { status: "retry", statusCode: r.status, error: text || `HTTP ${r.status}` };
}

/**
 * POST /run and yield mapped SourceEvents from the NDJSON body.
 * Caller must honour generation/session guards for Clear.
 */
export async function* runTurn(
  token: string,
  session: string,
  input: string,
  signal?: AbortSignal,
): AsyncGenerator<SourceEvent, RunResult, void> {
  let r: Response;
  try {
    r = await fetch("/run", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ input, session }),
      signal,
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (r.status === 409) {
    return { ok: false, status: 409, error: "session busy", busy: true };
  }
  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => "");
    return { ok: false, status: r.status, error: text || `HTTP ${r.status}` };
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const ev = wireObjectToSourceEvent(obj, { session, at: at++ });
      if (ev) yield ev;
    }
  }
  return { ok: true };
}

/** Fetch-stream SSE for monitor detail (Bearer on request). */
export async function* subscribeSessionEvents(
  token: string,
  session: string,
  signal?: AbortSignal,
): AsyncGenerator<SourceEvent, void, void> {
  const r = await fetch(`/sessions/${encodeURIComponent(session)}/events`, {
    headers: authHeaders(token),
    signal,
  });
  if (!r.ok || !r.body) throw new Error(`events ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let at = 0;
  let everConnected = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // Parse SSE frames separated by blank lines
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let eventName = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (eventName === "connected") {
        const kind = everConnected ? "reconnected" : "connected";
        everConnected = true;
        yield { kind, session };
        continue;
      }
      if (!data) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const sid = typeof obj.session === "string" ? obj.session : session;
      const ev = wireObjectToSourceEvent(obj, { session: sid, at: at++ });
      if (ev) yield ev;
    }
  }
}
