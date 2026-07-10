/**
 * Observability: tracing & metrics as a pure event-bus consumer.
 *
 * The kernel's lifecycle bus already narrates every interesting moment of a run
 * — when the agent starts, each turn opens and closes, every tool fires, and
 * what tokens were spent. Because that narration exists, observability needs no
 * change to the core: this extension simply *listens*. It folds the event
 * stream into a structured trace (an ordered list of spans) and a set of
 * lifetime aggregate metrics, then exposes commands to inspect them. Tracing,
 * metrics, and JSONL export are therefore pure consumers — the bus is what makes
 * the agent introspectable.
 *
 * This is the Emacs self-documenting-runtime value applied to an agent: the
 * running system can describe its own behaviour at any moment (`/trace`,
 * `/usage`) without instrumentation threaded through the call path. Add a new
 * consumer and you get a new view; remove it and the core is untouched.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "../kernel/extension.js";
import { totalTokens, type StopReason, type Usage } from "../kernel/types.js";

/** One timed region of a run. Spans nest agent -> turn -> tool by ordering. */
export interface Span {
  kind: "agent" | "turn" | "tool";
  name: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  /** For tool spans: whether the result was not an error. */
  ok?: boolean;
  meta?: Record<string, unknown>;
}

/** Lifetime aggregate counters, accumulated across every run in the session. */
export interface Metrics {
  runs: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  /** Per-tool invocation counts. */
  perTool: Record<string, number>;
  /** Total wall-clock across all completed agent spans, in milliseconds. */
  wallMs: number;
  /** Cumulative token usage as reported by the `usage` event. */
  usage: Usage;
}

/** A clock; `performance.now()` for monotonic durations. */
const now = (): number => performance.now();

export default function activate(e: ExtensionAPI): () => void {
  /** Spans for the most recent (or in-progress) run only, to bound memory. */
  let spans: Span[] = [];
  /** Lifetime aggregates; survive run boundaries. */
  const metrics: Metrics = {
    runs: 0,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    perTool: {},
    wallMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  /** Find the most recent still-open span of a kind (LIFO match for nesting). */
  const openSpan = (kind: Span["kind"]): Span | undefined => {
    for (let i = spans.length - 1; i >= 0; i--) {
      const s = spans[i]!;
      if (s.kind === kind && s.endedAt === undefined) return s;
    }
    return undefined;
  };

  /** Close a span: stamp end time and duration. Defensive against double-close. */
  const close = (span: Span | undefined): void => {
    if (!span || span.endedAt !== undefined) return;
    span.endedAt = now();
    span.durationMs = Math.max(0, span.endedAt - span.startedAt);
  };

  // Each handler is wrapped so a thrown error never escapes the bus. Events can
  // legitimately arrive in surprising orders (a tool_end with no matching
  // start, a turn_end before its turn_start); we record what we can and move on.
  const safe =
    <T>(fn: (payload: T) => void) =>
    (payload: T): void => {
      try {
        fn(payload);
      } catch (err) {
        e.log.warn("trace handler error:", err);
      }
    };

  const disposers = [
    e.on(
      "agent_start",
      safe(() => {
        // A new run rolls the previous run into the lifetime count and starts a
        // fresh span collection, so only the last run's detail is kept.
        metrics.runs += 1;
        spans = [];
        spans.push({ kind: "agent", name: "agent", startedAt: now() });
      }),
    ),

    e.on(
      "agent_end",
      safe((p: { reason: StopReason }) => {
        const agent = openSpan("agent");
        if (agent) {
          agent.meta = { ...agent.meta, reason: p.reason };
          close(agent);
          if (agent.durationMs !== undefined) metrics.wallMs += agent.durationMs;
        }
      }),
    ),

    e.on(
      "turn_start",
      safe((p: { turn: number }) => {
        metrics.turns += 1;
        spans.push({ kind: "turn", name: `turn ${p.turn}`, startedAt: now(), meta: { turn: p.turn } });
      }),
    ),

    e.on(
      "turn_end",
      safe(() => close(openSpan("turn"))),
    ),

    e.on(
      "tool_start",
      safe((p: { call: { id: string; name: string; arguments: Record<string, unknown> } }) => {
        metrics.toolCalls += 1;
        metrics.perTool[p.call.name] = (metrics.perTool[p.call.name] ?? 0) + 1;
        spans.push({
          kind: "tool",
          name: p.call.name,
          startedAt: now(),
          meta: { id: p.call.id },
        });
      }),
    ),

    e.on(
      "tool_end",
      safe((p: { call: { id: string; name: string }; result: { isError?: boolean } }) => {
        const ok = !p.result.isError;
        if (!ok) metrics.toolErrors += 1;
        // Match the open tool span for this call by its id (set at tool_start), so
        // concurrent same-name calls are not mis-attributed; fall back to any open
        // tool span so a mismatched/duplicate end still closes something sane.
        let span = spans.find((s) => s.kind === "tool" && s.meta?.id === p.call.id && s.endedAt === undefined);
        span ??= openSpan("tool");
        if (span) {
          span.ok = ok;
          close(span);
        }
      }),
    ),

    e.on(
      "usage",
      safe((p: { cumulative: Usage }) => {
        // The `cumulative` payload is the agent's running total, so we mirror it
        // rather than summing deltas (idempotent if the event repeats).
        metrics.usage = { ...p.cumulative };
      }),
    ),
  ];

  // --- inspection commands -------------------------------------------------

  const renderTrace = (): string[] => {
    const lines: string[] = [];
    if (spans.length === 0) {
      lines.push("(no run recorded yet)");
      return lines;
    }
    const dur = (s: Span): string =>
      s.durationMs !== undefined
        ? ` (${s.durationMs.toFixed(1)}ms)`
        : s.endedAt === undefined
          ? " (open)"
          : "";
    for (const s of spans) {
      if (s.kind === "agent") {
        const reason = typeof s.meta?.reason === "string" ? ` [${s.meta.reason}]` : "";
        lines.push(`agent${dur(s)}${reason}`);
      } else if (s.kind === "turn") {
        lines.push(`  ${s.name}${dur(s)}`);
      } else {
        const mark = s.ok === undefined ? "?" : s.ok ? "ok" : "err";
        lines.push(`    tool ${s.name} [${mark}]${dur(s)}`);
      }
    }
    return lines;
  };

  const renderUsage = (): string[] => {
    const u = metrics.usage;
    const lines: string[] = [];
    // `in=` is fresh input only while `total=` is cache-inclusive; surface the
    // cache tokens so the two never read as contradictory. Shown only when > 0,
    // so an uncached run's line stays byte-identical.
    const cache = (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    lines.push(
      `tokens: in=${u.inputTokens} ${cache > 0 ? `cache=${cache} ` : ""}out=${u.outputTokens} total=${totalTokens(u)}`,
    );
    lines.push(
      `runs=${metrics.runs} turns=${metrics.turns} toolCalls=${metrics.toolCalls} ` +
        `toolErrors=${metrics.toolErrors} wallMs=${metrics.wallMs.toFixed(1)}`,
    );
    const perTool = Object.entries(metrics.perTool);
    if (perTool.length > 0) {
      lines.push("per-tool: " + perTool.map(([name, n]) => `${name}=${n}`).join(" "));
    }
    return lines;
  };

  const disposeCommands = [
    e.registerCommand({
      name: "trace",
      description: "Show the most recent run's spans as an indented tree.",
      run: (ctx) => {
        for (const line of renderTrace()) ctx.print(line);
      },
    }),

    e.registerCommand({
      name: "usage",
      description: "Show cumulative token usage and a metrics summary.",
      run: (ctx) => {
        for (const line of renderUsage()) ctx.print(line);
      },
    }),

    e.registerCommand({
      name: "trace-save",
      description: "Write the last run's spans as JSONL to [path].",
      run: (ctx) => {
        const path = ctx.args.trim() || defaultTracePath();
        try {
          mkdirSync(dirOf(path), { recursive: true });
          const body = spans.map((s) => JSON.stringify(s)).join("\n") + (spans.length ? "\n" : "");
          writeFileSync(path, body, "utf8");
          ctx.print(`wrote ${spans.length} span(s) to ${path}`);
        } catch (err) {
          ctx.print(`trace-save failed: ${String(err)}`);
        }
      },
    }),
  ];

  return () => {
    for (const d of [...disposeCommands, ...disposers]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}

/** A timestamped default path under the user's trace dir (tmpdir fallback). */
function defaultTracePath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = safeJoin(homedir(), ".eagent", "traces") ?? join(tmpdir(), "eagent-traces");
  return join(base, `trace-${stamp}.jsonl`);
}

/** Join under home if home is resolvable; otherwise signal a fallback. */
function safeJoin(...parts: string[]): string | undefined {
  if (!parts[0]) return undefined;
  return join(...parts);
}

/** Parent directory of a path, without importing dirname semantics elsewhere. */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}
