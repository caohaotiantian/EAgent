/**
 * handoff — a session resume document written on `agent_end` / via `/handoff`.
 *
 * EAgent already persists what happened (`memory`'s lossy k/v bag, `journal`'s
 * raw JSONL replay), but neither yields something you can *resume from* without
 * re-paying the whole transcript. The convergent production pattern (Claude
 * Code's handoff, Cursor's session summaries) is different: on session end,
 * *distill* the transcript into a FIXED schema — goal; completed / in-progress /
 * pending; files touched; commands run; open decisions; do-not-touch; next 3–7
 * steps — plus a paste-ready reactivation paragraph, written to a gitignored
 * file. Resuming then costs a summary, not the raw log.
 *
 * This extension is an `agent_end` observer + a `/handoff` command. Both
 * summarize the live transcript via a recursion-safe, tool-less provider
 * sub-call (the `risk-guard`/`compact` pattern: `tools: []` cannot emit a tool
 * call, so the completion cannot re-enter any hook seam) into the fixed schema,
 * and write it to `.eagent/handoffs/<date>-<slug>.md` under the workspace root
 * (the `limits` gitignored-spill convention). It NEVER mutates the transcript —
 * it only reads `e.agent.messages` and writes a file.
 *
 * Because the auto-trigger makes a paid, latency-adding model call on every
 * session end, it ships OFF and must be enabled (`/handoff on` or
 * `e.store.set("enabled", true)`); `EAGENT_HANDOFF=off` is the hard env kill,
 * read inside the trigger. The manual `/handoff` command always works. The
 * summarization fails OPEN: no provider / a throw / an empty reply degrades to a
 * deterministic provider-free digest, so a resume artifact is never lost.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { CommandContext } from "../kernel/commands.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { Message } from "../kernel/types.js";

/**
 * The nine fixed schema section headers, in order, followed by the reactivation
 * paragraph header. A fixed schema *is the point* (design D3): a resumer scans
 * named sections instead of re-reading prose. Both the system prompt and the
 * fallback digest emit exactly these, in this order.
 */
const SCHEMA_SECTIONS = [
  "## Goal",
  "## Completed",
  "## In progress",
  "## Pending",
  "## Files touched",
  "## Commands run",
  "## Open decisions",
  "## Do not touch",
  "## Next steps",
  "## Reactivation",
] as const;

/**
 * The fixed instruction for the summarization sub-call (design D3). It (a) names
 * every schema section in order, (b) instructs 3–7 `## Next steps` items, (c)
 * asks for a paste-ready reactivation paragraph, and (d) contains the
 * distinctive branch word "handoff" so an offline test responder can detect the
 * sub-call (the `compact.ts:46-48` "recognizable token" convention).
 */
export const HANDOFF_SYSTEM_PROMPT =
  "You are writing a session HANDOFF document so a fresh agent can resume this " +
  "work without re-reading the whole transcript. Distill the conversation into " +
  "EXACTLY these markdown sections, in THIS order, each present even if its body " +
  "is a single line: " +
  SCHEMA_SECTIONS.slice(0, 9)
    .map((h) => `\`${h}\``)
    .join(", ") +
  ". Under `## Next steps`, list 3 to 7 concrete next actions. Finish with a " +
  "`## Reactivation` section containing ONE short, paste-ready paragraph that a " +
  "person can hand to a fresh agent to pick the work back up. Output only these " +
  "sections, nothing else.";

/**
 * Injected clock, default `new Date()`. The date in the filename derives from a
 * single read of this, so offline tests can pin it (design D4) and assertions
 * don't race the wall clock. `__setNow()` with no arg restores the default.
 */
let now: () => Date = () => new Date();

/** Test seam: pin the clock (design D4). Call with no arg to restore the default. */
export function __setNow(fn?: () => Date): void {
  now = fn ?? (() => new Date());
}

/** Concatenate a message's text blocks. */
function textOf(message: Message): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** The first user message's text — the run's goal (design D4). */
function firstUserText(messages: readonly Message[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const t = textOf(m).trim();
    if (t) return t;
  }
  return "";
}

/**
 * Kebab-case, lowercase, ASCII-only, length-capped (≤ 40) slug derived from the
 * run's goal so a handoff is identifiable without opening it (design D4).
 * Non-`[a-z0-9]` runs collapse to a single `-`; empty/whitespace → `session`.
 */
export function slugify(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "session";
}

/** `YYYY-MM-DD` from the injected clock. */
function dateStamp(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * A deterministic, provider-free digest of the transcript, used when no provider
 * is available, the sub-call throws, or it returns nothing (design D2 fail-open,
 * AC-8). Non-empty by construction and emits every schema header, so a resume
 * artifact is never lost. `goal` is surfaced under `## Goal`.
 */
export function renderFallback(messages: readonly Message[], goal: string): string {
  const lines = messages.map((m) => {
    const body = m.content
      .map((b) =>
        b.type === "text"
          ? b.text
          : b.type === "tool_call"
            ? `[call ${b.name}]`
            : b.type === "tool_result"
              ? "[result]"
              : b.type === "thinking"
                ? "[thinking]"
                : "[image]",
      )
      .join(" ");
    return `- ${m.role}: ${body.slice(0, 120)}`;
  });
  const transcript = lines.length > 0 ? lines.join("\n") : "(empty transcript)";
  return [
    `## Goal`,
    goal.trim().length > 0 ? goal.trim() : "(no recorded goal)",
    `## Completed`,
    `(provider-free digest of ${messages.length} message(s); no model summary available)`,
    `## In progress`,
    `(unknown — see transcript below)`,
    `## Pending`,
    `(unknown — see transcript below)`,
    `## Files touched`,
    `(unknown)`,
    `## Commands run`,
    `(unknown)`,
    `## Open decisions`,
    `(unknown)`,
    `## Do not touch`,
    `(unknown)`,
    `## Next steps`,
    `1. Re-read the transcript digest below.\n2. Re-establish the goal.\n3. Continue the work.`,
    `## Reactivation`,
    `Resume the work toward: ${goal.trim() || "the recorded goal"}. ` +
      `A model summary was unavailable, so review the transcript digest:\n${transcript}`,
  ].join("\n");
}

/**
 * Ensure the rendered summary is schema-valid: if the model dropped any required
 * section header, append the missing ones so the artifact always satisfies the
 * fixed schema (design D3). Returns the summary unchanged when it is already
 * complete.
 */
function ensureSchema(summary: string, goal: string): string {
  const missing = SCHEMA_SECTIONS.filter((h) => !summary.includes(h));
  if (missing.length === 0) return summary;
  const filler = missing
    .map((h) =>
      h === "## Reactivation"
        ? `${h}\nResume the work toward: ${goal.trim() || "the recorded goal"}.`
        : `${h}\n(not reported)`,
    )
    .join("\n");
  return `${summary.trimEnd()}\n${filler}`;
}

/** The workspace root: `$EAGENT_WORKSPACE` resolved, else `process.cwd()`. */
function workspaceRoot(): string {
  return process.env.EAGENT_WORKSPACE ? resolve(process.env.EAGENT_WORKSPACE) : process.cwd();
}

export default function activate(e: ExtensionAPI): () => void {
  /** Off by default; the env kill switch hard-disables the auto-trigger (design D6). */
  const cfg = () => ({
    // `store.get(key, false)` already returns the `false` fallback when unset, so
    // the read is a clean `boolean`; `=== true` only pins the static type.
    enabled:
      process.env.EAGENT_HANDOFF === "off" ? false : e.store.get<boolean>("enabled", false) === true,
  });

  /** Recursion guard: true while a summarization sub-call is in flight (compact.ts:175). */
  let summarizing = false;

  /**
   * Summarize the transcript via the configured provider DIRECTLY. Passing
   * `tools: []` runs outside the agent loop, so this completion cannot emit a
   * tool call and re-enter any seam — the structural recursion guard (design
   * D2). Fails OPEN: no provider / a throw / an empty reply degrades to the
   * deterministic digest, so a handoff is always written (AC-8).
   */
  async function summarize(messages: readonly Message[], goal: string): Promise<string> {
    try {
      const provider = e.agent.providers.get();
      if (!provider) return renderFallback(messages, goal);
      let finalText = "";
      for await (const ev of provider.stream({
        systemPrompt: HANDOFF_SYSTEM_PROMPT,
        messages: [...messages],
        tools: [],
        model: e.agent.model,
        signal: new AbortController().signal,
      })) {
        if (ev.type === "done") finalText = textOf(ev.message);
      }
      const trimmed = finalText.trim();
      return trimmed.length > 0 ? ensureSchema(trimmed, goal) : renderFallback(messages, goal);
    } catch {
      return renderFallback(messages, goal);
    }
  }

  /**
   * Write `content` to `.eagent/handoffs/<date>-<slug>.md` under the workspace
   * root (design D4, copying `limits.ts:169-181`). On a same-date/slug collision,
   * append an `existsSync`-guarded monotonic suffix (`-2`, `-3`, …) so two
   * snapshots in the same session/day never clobber (AC-9). All disk ops are
   * wrapped so a failure logs a warning and never crashes the run (R3). Returns
   * the written path, or `undefined` on failure.
   */
  function writeHandoff(content: string, slug: string): string | undefined {
    try {
      const dir = join(workspaceRoot(), ".eagent", "handoffs");
      mkdirSync(dir, { recursive: true });
      const date = dateStamp(now());
      let file = join(dir, `${date}-${slug}.md`);
      for (let n = 2; existsSync(file); n++) {
        file = join(dir, `${date}-${slug}-${n}.md`);
      }
      writeFileSync(file, content, "utf8");
      return file;
    } catch (err) {
      e.log.warn("handoff: failed to write resume document:", err);
      return undefined;
    }
  }

  /** Distill the live transcript and write the handoff file. Returns the path. */
  async function produce(): Promise<string | undefined> {
    const messages = e.agent.messages;
    const goal = firstUserText(messages);
    summarizing = true;
    let content: string;
    try {
      content = await summarize(messages, goal);
    } finally {
      summarizing = false;
    }
    return writeHandoff(content, slugify(goal));
  }

  // -- the auto-trigger: an agent_end observer (read-only) ------------------
  const offEnd = e.on("agent_end", async () => {
    if (summarizing) return; // re-entrancy guard (design D2)
    if (!cfg().enabled) return; // off by default / kill switch (AC-6/AC-7)
    await produce();
  });

  // -- the /handoff command (manual, always available) ----------------------
  const offCmd = e.registerCommand({
    name: "handoff",
    description: "Write a session resume document. Usage: /handoff [on|off|status]",
    run: async (ctx: CommandContext) => {
      const arg = ctx.args.trim();
      switch (arg) {
        case "on":
          e.store.set("enabled", true);
          ctx.print("handoff on");
          return;
        case "off":
          e.store.set("enabled", false);
          ctx.print("handoff off");
          return;
        case "status": {
          const { enabled } = cfg();
          ctx.print(
            `handoff ${enabled ? "on" : "off"}${process.env.EAGENT_HANDOFF === "off" ? " (EAGENT_HANDOFF=off)" : ""}`,
          );
          return;
        }
        default: {
          // Bare /handoff: write now, regardless of the enabled flag.
          const path = await produce();
          ctx.print(path ? `handoff written to ${path}` : "handoff: failed to write (see warnings)");
        }
      }
    },
  });

  return () => {
    for (const d of [offEnd, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
