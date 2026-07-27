/**
 * On-disk persistence for the HTTP server's multi-session pool.
 *
 * In-memory Agents are the runtime truth during a process; this module is the
 * durable mirror so `POST /run` conversations survive restarts. Envelope is
 * intentionally close to the CLI `session` extension's SessionFile so files are
 * inspectable JSON. Filenames are URL-encoded session ids under a dedicated dir
 * (default `~/.eagent/http-sessions`, overridable via EAGENT_SESSIONS_DIR).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isMessage, type Message, type Usage } from "./kernel/types.js";

export const HTTP_SESSION_VERSION = 1;

export interface HttpSessionFile {
  version: number;
  savedAt: string;
  session: string;
  model: string;
  messages: Message[];
  usage: Usage;
  costUsd: number;
}

const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 });

/** Resolve the sessions directory: non-empty explicit path → ~/.eagent/http-sessions.
 *  Callers that honor `EAGENT_SESSIONS_DIR` pass `process.env.EAGENT_SESSIONS_DIR` in
 *  (so the env allowlist stays on `server.ts` only). */
export function resolveSessionsDir(explicit?: string): string {
  const raw = explicit?.trim();
  if (raw) return raw;
  return join(homedir(), ".eagent", "http-sessions");
}

function filePath(dir: string, sessionId: string): string {
  return join(dir, `${encodeURIComponent(sessionId)}.json`);
}

/** Atomic-ish write: write tmp then rename. */
export function writeSessionFile(dir: string, payload: HttpSessionFile): void {
  mkdirSync(dir, { recursive: true });
  const target = filePath(dir, payload.session);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmp, target);
}

export function deleteSessionFile(dir: string, sessionId: string): boolean {
  const p = filePath(dir, sessionId);
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readSessionFile(dir: string, sessionId: string): HttpSessionFile | undefined {
  const p = filePath(dir, sessionId);
  if (!existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return parseSessionFile(raw, sessionId);
  } catch {
    return undefined;
  }
}

export function parseSessionFile(raw: unknown, expectId?: string): HttpSessionFile | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.version !== HTTP_SESSION_VERSION && o.version !== undefined && o.version !== 1) {
    return undefined;
  }
  const session = typeof o.session === "string" ? o.session : expectId;
  if (!session || (expectId && session !== expectId)) return undefined;
  if (!Array.isArray(o.messages) || !o.messages.every(isMessage)) return undefined;
  const usage =
    o.usage && typeof o.usage === "object"
      ? {
          inputTokens: Number((o.usage as Usage).inputTokens) || 0,
          outputTokens: Number((o.usage as Usage).outputTokens) || 0,
        }
      : emptyUsage();
  return {
    version: HTTP_SESSION_VERSION,
    savedAt: typeof o.savedAt === "string" ? o.savedAt : new Date().toISOString(),
    session,
    model: typeof o.model === "string" ? o.model : "",
    messages: o.messages as Message[],
    usage,
    costUsd: typeof o.costUsd === "number" && Number.isFinite(o.costUsd) ? o.costUsd : 0,
  };
}

/** List session ids that have a readable on-disk file (best-effort). */
export function listDiskSessionIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const id = decodeURIComponent(name.slice(0, -".json".length));
      if (id) out.push(id);
    } catch {
      /* skip bad names */
    }
  }
  return out;
}

export function listDiskSessionSummaries(dir: string): Array<{
  id: string;
  running: false;
  usage: Usage;
  costUsd: number;
  savedAt: string;
  messageCount: number;
}> {
  return listDiskSessionIds(dir).flatMap((id) => {
    const file = readSessionFile(dir, id);
    if (!file) return [];
    return [
      {
        id,
        running: false as const,
        usage: file.usage,
        costUsd: file.costUsd,
        savedAt: file.savedAt,
        messageCount: file.messages.length,
      },
    ];
  });
}
