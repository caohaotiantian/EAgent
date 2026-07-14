/**
 * Session persistence and handoff — file-based memory for the agent loop.
 *
 * A running agent's transcript lives only in process memory; when the process
 * exits, the conversation is gone. This extension gives that transcript a home
 * on disk so a session can be saved, listed, and resumed across separate runs.
 * The format is deliberately plain: a versioned JSON envelope holding the model
 * and the raw `Message[]`, so a saved session is just data anyone can inspect.
 *
 * `/save` and `/load` are the literal round-trip — write the transcript, read it
 * back, restore it verbatim. `/sessions` is the index over the default sessions
 * directory. `/handoff` is the interesting one: rather than carry the entire
 * (possibly enormous) history forward, it asks the provider to distill the
 * conversation into a compact briefing, then clears the transcript and seeds a
 * fresh context with just that summary. This is the "carry the essence into a
 * fresh context" pattern — the agent starts clean but remembers why it is here.
 *
 * File writes and reads are gated through the capability layer (`fs:write` /
 * `fs:read`), so persistence honors the same authority model as every other
 * side effect. Keeping all of this as an extension keeps the kernel neutral
 * about where memory lives and how a handoff is phrased.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CapabilityError } from "../kernel/capabilities.js";
import type { CommandContext } from "../kernel/commands.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { isMessage, type Message } from "../kernel/types.js";
import { DEFAULT_SUB_CALL_TIMEOUT_MS, runSubCall } from "./lib/sub-call.js";

/** Current on-disk schema version. Bump when the envelope shape changes. */
const SESSION_VERSION = 1;

/** Store key overriding the default sessions directory (used by tests). */
const SESSIONS_DIR_KEY = "sessionsDir";

/** The system prompt that turns the provider into a handoff writer. */
const HANDOFF_SYSTEM_PROMPT =
  "You are writing a handoff briefing for a fresh instance of this agent that " +
  "has none of the current context. In a few tight bullets, capture the goal, " +
  "the decisions and facts established so far, relevant file paths, and the " +
  "open threads or next steps. Be specific and omit pleasantries.";

/** The versioned envelope a session file holds. */
interface SessionFile {
  version: number;
  savedAt: string;
  model: string;
  messages: Message[];
}

export default function activate(e: ExtensionAPI): void {
  e.grantCapability("fs:read");
  e.grantCapability("fs:write");

  /** The directory `/save`, `/load`, and `/sessions` default to. */
  const sessionsDir = (): string =>
    e.store.get<string>(SESSIONS_DIR_KEY) ?? join(homedir(), ".eagent", "sessions");

  /** Resolve an optional path argument against the default sessions dir. */
  const resolvePath = (arg: string, fallbackName: string): string => {
    const trimmed = arg.trim();
    return trimmed.length > 0 ? trimmed : join(sessionsDir(), fallbackName);
  };

  // -- /save ----------------------------------------------------------------

  e.registerCommand({
    name: "save",
    description: "Save the current transcript to a session file (default ~/.eagent/sessions/last.json).",
    run: async (ctx: CommandContext) => {
      try {
        await e.agent.capabilities.require("fs:write", "session");
      } catch (err) {
        if (err instanceof CapabilityError) {
          ctx.print(`Cannot save: ${err.message}`);
          return;
        }
        throw err;
      }

      const path = resolvePath(ctx.args, "last.json");
      const payload: SessionFile = {
        version: SESSION_VERSION,
        savedAt: new Date().toISOString(),
        model: e.agent.model,
        messages: [...e.agent.messages] as Message[],
      };

      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
      } catch (err) {
        ctx.print(`Failed to write session to ${path}: ${errMsg(err)}`);
        return;
      }
      ctx.print(`Saved ${payload.messages.length} message(s) to ${path}.`);
    },
  });

  // -- /load ----------------------------------------------------------------

  e.registerCommand({
    name: "load",
    description: "Load a session file, replacing the current transcript (default ~/.eagent/sessions/last.json).",
    run: async (ctx: CommandContext) => {
      try {
        await e.agent.capabilities.require("fs:read", "session");
      } catch (err) {
        if (err instanceof CapabilityError) {
          ctx.print(`Cannot load: ${err.message}`);
          return;
        }
        throw err;
      }

      const path = resolvePath(ctx.args, "last.json");
      const file = readSession(path);
      if ("error" in file) {
        ctx.print(`Failed to load session from ${path}: ${file.error}`);
        return;
      }

      e.agent.clear();
      e.agent.load(file.messages);
      if (file.model) e.agent.model = file.model;
      ctx.print(`Restored ${file.messages.length} message(s) from ${path}.`);
    },
  });

  // -- /sessions ------------------------------------------------------------

  e.registerCommand({
    name: "sessions",
    description: "List saved session files with their timestamps and message counts.",
    run: (ctx: CommandContext) => {
      const dir = sessionsDir();
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
      } catch {
        ctx.print(`No sessions found in ${dir}.`);
        return;
      }
      if (names.length === 0) {
        ctx.print(`No sessions found in ${dir}.`);
        return;
      }

      ctx.print(`Sessions in ${dir}:`);
      for (const name of names) {
        const file = readSession(join(dir, name));
        if ("error" in file) {
          ctx.print(`  ${name} (unreadable: ${file.error})`);
          continue;
        }
        ctx.print(`  ${name} — ${file.messages.length} message(s), saved ${file.savedAt}`);
      }
    },
  });

  // -- /handoff -------------------------------------------------------------

  e.registerCommand({
    name: "handoff",
    description: "Distill the conversation into a compact briefing and start a fresh context with it.",
    run: async (ctx: CommandContext) => {
      const history = [...e.agent.messages] as Message[];
      if (history.length === 0) {
        ctx.print("Nothing to hand off (transcript is empty).");
        return;
      }

      const summary = (await summarize(history)) || digest(history);

      e.agent.clear();
      e.agent.load([
        {
          role: "system",
          content: [{ type: "text", text: "Handoff from previous session:\n" + summary }],
        },
      ]);
      ctx.print(summary);
    },
  });

  /**
   * Ask the provider DIRECTLY for a handoff summary, bypassing the agent loop
   * (no tools, a fresh abort signal). Returns an empty string when there is no
   * provider or the model yields nothing, so the caller can fall back.
   */
  async function summarize(history: Message[]): Promise<string> {
    const provider = e.agent.providers.get();
    if (!provider) return "";

    try {
      const msg = await runSubCall(
        provider,
        {
          systemPrompt: HANDOFF_SYSTEM_PROMPT,
          messages: history,
          tools: [],
          model: e.agent.model,
        },
        { timeoutMs: e.config.int("session.subCallTimeoutMs", DEFAULT_SUB_CALL_TIMEOUT_MS) },
      );
      return textOf(msg).trim();
    } catch (err) {
      e.log.warn("handoff summarization failed:", errMsg(err));
      return "";
    }
  }
}

/**
 * Read and validate a session file. Returns the parsed envelope or an
 * `{ error }` object — callers handle the failure rather than throwing it out
 * of a command.
 */
function readSession(path: string): SessionFile | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { error: errMsg(err) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "not valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null) return { error: "not a session object" };
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.messages)) return { error: "missing messages array" };
  // Validate each entry's shape at the boundary so a corrupt-but-valid-JSON
  // file fails loudly here rather than crashing a later turn that assumes
  // `message.content` is an array.
  if (!obj.messages.every(isMessage)) return { error: "messages array contains a malformed entry" };
  // Reject a forward-incompatible envelope rather than loading it blindly. A file
  // with no version is a pre-versioning save and loads as current (back-compat);
  // a present-but-different version is from another/newer tool.
  if (typeof obj.version === "number" && obj.version !== SESSION_VERSION) {
    return { error: `unsupported session version ${obj.version} (expected ${SESSION_VERSION})` };
  }

  return {
    version: typeof obj.version === "number" ? obj.version : SESSION_VERSION,
    savedAt: typeof obj.savedAt === "string" ? obj.savedAt : "(unknown)",
    model: typeof obj.model === "string" ? obj.model : "",
    messages: obj.messages as Message[],
  };
}

/** Concatenate the text blocks of a message. */
function textOf(message: Message): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * A provider-free fallback briefing: how many messages there were and the last
 * thing the user said — enough to orient a fresh context when no model is
 * available.
 */
function digest(history: Message[]): string {
  let lastUser = "";
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== "user") continue;
    lastUser = textOf(m).trim();
    if (lastUser) break;
  }
  const tail = lastUser ? `\nMost recent user message: ${lastUser}` : "";
  return `Carried over ${history.length} message(s) from the previous session.${tail}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
