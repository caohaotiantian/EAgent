/**
 * Resource guardrails as a pure hook consumer.
 *
 * A long-running or adversarial agent can blow up two budgets that the minimal
 * core deliberately holds no opinion about: the size of any single tool output
 * (a `bash cat bigfile` can dump megabytes straight into the context window) and
 * the number of tool calls a single run may make (a buggy or hostile model can
 * loop on a tool forever). This extension caps both — it truncates oversized
 * tool outputs via `afterToolCall` and enforces a per-run tool-call budget via
 * `agent_start` plus `beforeToolCall` — entirely through the public hook surface.
 *
 * This is exactly the kind of policy that belongs in an extension, not the
 * kernel: the loop stays small and unopinionated while the guardrails live,
 * observably and replaceably, out here. Limits read from `e.store`, so a host or
 * the `/limits` command can retune them at runtime. Every hook is defensive and
 * never throws, because a guardrail that crashes the run it guards is worse than
 * no guardrail at all.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ExtensionAPI } from "../kernel/extension.js";
import type { Config } from "../kernel/store.js";
import type { ToolResult } from "../kernel/types.js";
import { totalTokens } from "../kernel/types.js";
import type { ToolDecision } from "../kernel/events.js";

/** Cap on a single tool's output, in bytes, before it is truncated. */
const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 16384;
/** Cap on how many tool calls a single `agent.run` may make. */
const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 100;
/** Token budget per run; 0 means disabled (opt-in, unlike the others). */
const DEFAULT_MAX_TOKENS_PER_RUN = 0;
/** Whether oversized output is spilled to a file instead of discarded. */
const DEFAULT_SPILL_TOOL_OUTPUT = true;
/** Days before a stale spill file is eligible for the activation sweep. */
const DEFAULT_TOOL_OUTPUT_RETENTION_DAYS = 7;

interface LimitsConfig {
  maxToolOutputBytes: number;
  maxToolCallsPerRun: number;
  maxTokensPerRun: number;
  spillToolOutput: boolean;
  toolOutputDir: string | undefined;
  toolOutputRetentionDays: number;
}

/** The store keys the config is persisted under. */
const KEYS = {
  maxToolOutputBytes: "maxToolOutputBytes",
  maxToolCallsPerRun: "maxToolCallsPerRun",
  maxTokensPerRun: "maxTokensPerRun",
  spillToolOutput: "spillToolOutput",
  toolOutputDir: "toolOutputDir",
  toolOutputRetentionDays: "toolOutputRetentionDays",
} as const;

/** The workspace the `read` tool confines to: the `workspace` config key or cwd. */
function workspaceRoot(config: Config): string {
  const ws = config.string("workspace");
  return ws ? resolve(ws) : process.cwd();
}

/** True when `p` resolves inside `root` (same rule the `read` tool enforces). */
function isInsideRoot(root: string, p: string): boolean {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep()}`) && !isAbsolute(rel));
}

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

export default function activate(e: ExtensionAPI): () => void {
  /**
   * Per-run tool-call counter. In-memory and reset on `agent_start`, because it
   * is meaningful only within a single run — it must not survive across runs or
   * a reload (the budget is "this run", not "ever").
   */
  let toolCallsThisRun = 0;
  /** Tokens consumed in this run, summed from the `usage` event. */
  let tokensThisRun = 0;

  /**
   * Read a positive-integer config value from the store, falling back to its
   * default for anything missing, non-numeric, NaN, or non-positive. Limits are
   * a safety mechanism, so an odd value can never silently disable a cap.
   */
  const readPositiveInt = (key: string, fallback: number): number => {
    const raw = e.store.get<unknown>(key);
    const n =
      typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
    return fallback;
  };

  /** Like `readPositiveInt` but allows 0 (used to *disable* an opt-in cap). */
  const readNonNegativeInt = (key: string, fallback: number): number => {
    const raw = e.store.get<unknown>(key);
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) return Math.floor(n);
    return fallback;
  };

  /** Read a boolean flag, treating `0`/`"0"`/`"false"`/`"off"` as false. */
  const readBool = (key: string, fallback: boolean): boolean => {
    const raw = e.store.get<unknown>(key);
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "number") return raw !== 0;
    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (s === "0" || s === "false" || s === "off" || s === "no") return false;
      if (s === "1" || s === "true" || s === "on" || s === "yes") return true;
    }
    return fallback;
  };

  /** Read an optional non-empty string, else `undefined`. */
  const readString = (key: string): string | undefined => {
    const raw = e.store.get<unknown>(key);
    if (typeof raw === "string" && raw.trim().length > 0) return raw;
    return undefined;
  };

  const config = (): LimitsConfig => ({
    maxToolOutputBytes: readPositiveInt(KEYS.maxToolOutputBytes, DEFAULT_MAX_TOOL_OUTPUT_BYTES),
    maxToolCallsPerRun: readPositiveInt(KEYS.maxToolCallsPerRun, DEFAULT_MAX_TOOL_CALLS_PER_RUN),
    maxTokensPerRun: readNonNegativeInt(KEYS.maxTokensPerRun, DEFAULT_MAX_TOKENS_PER_RUN),
    spillToolOutput: e.config.enabled("tool-spill", {
      default: readBool(KEYS.spillToolOutput, DEFAULT_SPILL_TOOL_OUTPUT),
    }),
    toolOutputDir: readString(KEYS.toolOutputDir),
    toolOutputRetentionDays: readPositiveInt(
      KEYS.toolOutputRetentionDays,
      DEFAULT_TOOL_OUTPUT_RETENTION_DAYS,
    ),
  });

  /**
   * Monotonic spill-file counter, so two spills in the same millisecond still
   * land on distinct paths. Declared once per activation.
   */
  let nextSpillId = 0;

  // --- 1. Tool-output truncation ------------------------------------------
  //
  // Transform an oversized result's `content` down to the byte cap, appending a
  // clear marker so the model knows the output was clipped. `isError` and the
  // structured `details` are preserved — truncation is about the context window,
  // not about changing the meaning of the result.
  const offTruncate = e.hook("afterToolCall", (result: ToolResult): ToolResult => {
    try {
      const cfg = config();
      const limit = cfg.maxToolOutputBytes;
      const content = result.content ?? "";
      const total = Buffer.byteLength(content, "utf8");
      if (total <= limit) return result;
      const shown = truncateToBytes(content, limit);
      const shownBytes = Buffer.byteLength(shown, "utf8");

      // The clipped marker, used both when spill is off and as the fail-soft
      // fallback. No information about where the rest went — it was discarded.
      const clipped = `${shown}\n\n[output truncated: ${shownBytes} of ${total} bytes shown]`;

      if (!cfg.spillToolOutput) return { ...result, content: clipped };

      // Spill the FULL output to disk, then point the model at it. Any disk
      // failure degrades to the clipped marker rather than crashing the run.
      try {
        const root = workspaceRoot(e.config);
        const dir = cfg.toolOutputDir ?? join(root, ".eagent", "tool-output");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `tool-${Date.now()}-${nextSpillId++}`);
        writeFileSync(file, content, "utf8");
        const hint = isInsideRoot(root, file)
          ? `full output saved to ${relative(root, file)}. Retrieve more with the read tool (offset/limit) or grep it via bash`
          : `full output saved to ${file}. Retrieve it with bash (grep/cat)`;
        return {
          ...result,
          content: `${shown}\n\n[output truncated: ${shownBytes} of ${total} bytes shown; ${hint}.]`,
        };
      } catch (spillErr) {
        e.log.warn("limits: tool-output spill failed, falling back to in-context truncation:", spillErr);
        return { ...result, content: clipped };
      }
    } catch (err) {
      e.log.warn("limits: truncation hook error:", err);
      return result;
    }
  });

  // Best-effort cleanup of stale spill files, once per activation (idempotent,
  // so re-running on a hot reload is harmless). Not a hook and not part of the
  // teardown loop — both of those must stay off this path.
  sweepSpillDir(e, config());

  // --- 2. Per-run tool-call budget ----------------------------------------
  //
  // Reset the counter at the start of every run, then count and gate each call.
  const offReset = e.on("agent_start", () => {
    toolCallsThisRun = 0;
    tokensThisRun = 0;
  });

  // Track tokens consumed this run so the budget can stop a runaway agent.
  // `totalTokens` is cache-aware (input + cache read/write + output) and already
  // excludes reasoning tokens, so cached runs can't slip past the budget.
  const offUsage = e.on("usage", ({ usage }) => {
    tokensThisRun += totalTokens(usage);
  });

  const offBudget = e.hook("beforeToolCall", (decision: ToolDecision): ToolDecision => {
    try {
      if (decision.block) return decision; // already vetoed by another guard
      const cfg = config();
      if (cfg.maxTokensPerRun > 0 && tokensThisRun > cfg.maxTokensPerRun) {
        return {
          ...decision,
          block: true,
          reason: `token budget (${cfg.maxTokensPerRun}) exceeded for this run`,
        };
      }
      toolCallsThisRun += 1;
      if (toolCallsThisRun > cfg.maxToolCallsPerRun) {
        return {
          ...decision,
          block: true,
          reason: `tool-call budget (${cfg.maxToolCallsPerRun}) exceeded for this run`,
        };
      }
      return decision;
    } catch (err) {
      e.log.warn("limits: budget hook error:", err);
      return decision;
    }
  });

  // --- 3. /limits command --------------------------------------------------
  const offCommand = e.registerCommand({
    name: "limits",
    description:
      "Show or set resource guardrails (e.g. /limits maxToolOutputBytes=1024 maxToolCallsPerRun=50).",
    run: (ctx) => {
      const args = ctx.args.trim();
      if (args.length > 0) {
        // Parse simple key=value pairs, validate, and persist the recognized ones.
        for (const pair of args.split(/\s+/)) {
          const eq = pair.indexOf("=");
          if (eq <= 0) {
            ctx.print(`limits: ignoring "${pair}" (expected key=value)`);
            continue;
          }
          const key = pair.slice(0, eq);
          const value = pair.slice(eq + 1);
          if (key === KEYS.toolOutputDir) {
            // A free-form path; an empty value clears the override.
            if (value.length === 0) e.store.set(key, "");
            else e.store.set(key, value);
            continue;
          }
          if (key === KEYS.spillToolOutput) {
            const v = value.trim().toLowerCase();
            if (v === "1" || v === "true" || v === "on" || v === "yes") e.store.set(key, true);
            else if (v === "0" || v === "false" || v === "off" || v === "no") e.store.set(key, false);
            else ctx.print(`limits: "${key}" must be a boolean (got "${value}")`);
            continue;
          }
          if (
            key !== KEYS.maxToolOutputBytes &&
            key !== KEYS.maxToolCallsPerRun &&
            key !== KEYS.maxTokensPerRun &&
            key !== KEYS.toolOutputRetentionDays
          ) {
            ctx.print(`limits: unknown key "${key}"`);
            continue;
          }
          // maxTokensPerRun accepts 0 (disabled); the others require positive.
          const min = key === KEYS.maxTokensPerRun ? 0 : 1;
          const n = Number(value);
          if (!Number.isFinite(n) || n < min) {
            ctx.print(`limits: "${key}" must be a number >= ${min} (got "${value}")`);
            continue;
          }
          e.store.set(key, Math.floor(n));
        }
      }
      const cfg = config();
      ctx.print(`maxToolOutputBytes=${cfg.maxToolOutputBytes}`);
      ctx.print(`maxToolCallsPerRun=${cfg.maxToolCallsPerRun}`);
      ctx.print(`maxTokensPerRun=${cfg.maxTokensPerRun}${cfg.maxTokensPerRun === 0 ? " (disabled)" : ""}`);
      ctx.print(`spillToolOutput=${cfg.spillToolOutput}`);
      ctx.print(`toolOutputDir=${cfg.toolOutputDir ?? `(default: ${workspaceRoot(e.config)}/.eagent/tool-output)`}`);
      ctx.print(`toolOutputRetentionDays=${cfg.toolOutputRetentionDays}`);
      ctx.print(`toolCallsThisRun=${toolCallsThisRun}`);
      ctx.print(`tokensThisRun=${tokensThisRun}`);
    },
  });

  return () => {
    for (const d of [offCommand, offBudget, offUsage, offReset, offTruncate]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}

/**
 * Truncate a string so its UTF-8 byte length is at most `limit`, without
 * splitting a multi-byte character. We slice optimistically by code units, then
 * trim back one code point at a time until the byte budget is met.
 */
function truncateToBytes(s: string, limit: number): string {
  if (limit <= 0) return "";
  if (Buffer.byteLength(s, "utf8") <= limit) return s;
  // Each char is at most 4 UTF-8 bytes, so `limit` code units is a safe upper
  // bound to start from; then shrink until we fit.
  let end = Math.min(s.length, limit);
  let out = s.slice(0, end);
  while (end > 0 && Buffer.byteLength(out, "utf8") > limit) {
    end -= 1;
    out = s.slice(0, end);
  }
  return out;
}

/**
 * Delete spill files older than the retention window. Every disk op is isolated
 * so a missing directory or one undeletable file cannot abort the sweep or
 * throw out of activation.
 */
function sweepSpillDir(e: ExtensionAPI, cfg: LimitsConfig): void {
  if (!cfg.spillToolOutput) return;
  const dir = cfg.toolOutputDir ?? join(workspaceRoot(e.config), ".eagent", "tool-output");
  const cutoff = Date.now() - cfg.toolOutputRetentionDays * 86_400_000;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // missing directory: nothing to sweep
  }
  for (const name of entries) {
    const file = join(dir, name);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    } catch (err) {
      e.log.warn("limits: spill sweep skipped a file:", err);
    }
  }
}
