/**
 * The headless plain printer.
 *
 * The only human-readable output the engine itself emits: `--eval`, piped batch,
 * and any non-TTY invocation. It is I/O, not UI — there is no section tree, no
 * collapse state, no display mode, and by construction no cursor, alt-screen, or
 * spinner byte can reach the stream. The rich terminal experience lives in the
 * `tui/` package and never runs on these paths.
 *
 * Assistant text streams through verbatim so `eagent --eval … | tee` yields the
 * answer and nothing else. Tool calls and reasoning are annotated on stderr, so a
 * consumer redirecting stdout gets a clean transcript.
 */

import type { Agent } from "./kernel/agent.js";
import type { ToolCallBlock } from "./kernel/types.js";

export interface PlainPrinterOptions {
  /** Answer text sink. Default `process.stdout.write`. */
  out?: (s: string) => void;
  /** Annotation sink (tools, reasoning, errors). Default `process.stderr.write`. */
  err?: (s: string) => void;
  /** Annotate tool calls and reasoning. Default true; `--json` callers pass false. */
  annotate?: boolean;
}

/** A one-line, bounded summary of a call's arguments. Never elides the answer. */
const ARG_WIDTH = 80;

export function summarizeArgs(args: Record<string, unknown>): string {
  const joined = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  if (joined.length === 0) return "";
  return joined.length > ARG_WIDTH ? joined.slice(0, ARG_WIDTH - 1) + "…" : joined;
}

/**
 * Wire the printer to an agent's lifecycle events. Returns nothing: the engine
 * has no display state to hand back, which is the whole point of this module.
 */
export function wirePlainPrinting(agent: Agent, opts: PlainPrinterOptions = {}): void {
  const out = opts.out ?? ((s: string): void => void process.stdout.write(s));
  const err = opts.err ?? ((s: string): void => void process.stderr.write(s));
  const annotate = opts.annotate ?? true;

  agent.hooks.on("text_delta", ({ text }) => out(text));

  if (annotate) {
    agent.hooks.on("tool_start", ({ call }: { call: ToolCallBlock }) => {
      const summary = summarizeArgs(call.arguments);
      err(`· ${call.name}${summary ? " " + summary : ""}\n`);
    });
    agent.hooks.on("tool_end", ({ call, result }) => {
      if (result.isError) err(`✗ ${call.name}: ${result.content.split("\n")[0] ?? ""}\n`);
    });
  }

  agent.hooks.on("error", ({ error, where }) => {
    err(`✗ ${where}: ${error instanceof Error ? error.message : String(error)}\n`);
  });

  // A truncated/blocked/refused answer would otherwise end in silence — the clean
  // ends and interrupts carry their own signals, so only these three warn.
  agent.hooks.on("agent_end", ({ reason }) => {
    out("\n");
    if (reason === "max_tokens") {
      err("⚠ response truncated (max_tokens): raise the provider's *_MAX_TOKENS, or enable /autocontinue.\n");
    } else if (reason === "content_filter") {
      err("⚠ response stopped (content_filter): blocked by the provider content filter.\n");
    } else if (reason === "refusal") {
      err("⚠ response stopped (refusal): the model declined to answer.\n");
    }
  });
}
