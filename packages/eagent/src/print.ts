/**
 * The headless plain printer.
 *
 * The only human-readable output the engine itself emits: `--eval`, piped batch,
 * and any non-TTY invocation. It is I/O, not UI — there is no section tree, no
 * collapse state, no display mode, and by construction no cursor, alt-screen, or
 * spinner byte can reach the stream. The rich terminal experience lives in the
 * `tui/` package and never runs on these paths.
 *
 * Only the ROOT agent's assistant text reaches stdout, so `eagent --eval … | tee`
 * yields the answer and nothing else. A sub-agent shares the parent's hook bus
 * (`childScope()` suppresses only the run-lifecycle events), so without the
 * acting-agent filter below every fork's tokens would interleave into the answer
 * — garbled character-block by character-block when forks run in parallel.
 * Sub-agent text, reasoning, tool calls, and errors are annotated on stderr, so a
 * consumer redirecting stdout gets a clean transcript.
 */

import { currentActingAgent, type Agent } from "./kernel/agent.ts";
import type { ToolCallBlock } from "./kernel/types.ts";

export interface PlainPrinterOptions {
  /** Answer text sink. Default `process.stdout.write`. */
  out?: (s: string) => void;
  /** Annotation sink (sub-agent text, tools, reasoning, errors). Default `process.stderr.write`. */
  err?: (s: string) => void;
}

/** A one-line, bounded summary of a call's arguments. Never elides the answer. */
const ARG_WIDTH = 80;

export function summarizeArgs(args: Record<string, unknown>): string {
  const joined = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : safeStringify(v)}`)
    .join(" ")
    // A `bash` command or `write` body carries newlines; the summary is one line.
    .replace(/\s+/g, " ");
  if (joined.length === 0) return "";
  if (joined.length <= ARG_WIDTH) return joined;
  // Slice by code point so a path containing an emoji cannot be cut mid-pair.
  return Array.from(joined).slice(0, ARG_WIDTH - 1).join("") + "…";
}

/** `JSON.stringify` throws on a BigInt and on a circular value; an annotation
 *  must never be the reason a run dies, so those degrade to a tag. */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return typeof v === "bigint" ? `${v}n` : "[unserializable]";
  }
}

/**
 * Wire the printer to an agent's lifecycle events. Returns nothing: the engine
 * has no display state to hand back, which is the whole point of this module.
 */
export function wirePlainPrinting(agent: Agent, opts: PlainPrinterOptions = {}): void {
  const out = opts.out ?? ((s: string): void => void process.stdout.write(s));
  const err = opts.err ?? ((s: string): void => void process.stderr.write(s));

  /** True while the emitting agent is the one we wired to. Compared against
   *  `agent` rather than `currentRootAgent()`, because a sub-agent driven outside
   *  a root `run()` has no root in scope and would otherwise read as the root
   *  itself. Outside any run the acting agent is undefined — a directly-emitted
   *  event in a test — which is the single-agent case and counts as the answer. */
  const isAnswer = (): boolean => {
    const acting = currentActingAgent();
    return acting === undefined || acting === agent;
  };

  let wroteAnswer = false;
  agent.hooks.on("text_delta", ({ text }) => {
    if (!isAnswer()) return err(text);
    wroteAnswer = true;
    out(text);
  });
  agent.hooks.on("reasoning_delta", ({ text }) => err(text));

  agent.hooks.on("tool_start", ({ call }: { call: ToolCallBlock }) => {
    const summary = summarizeArgs(call.arguments);
    err(`· ${call.name}${summary ? " " + summary : ""}\n`);
  });
  agent.hooks.on("tool_end", ({ call, result }) => {
    if (result.isError) err(`✗ ${call.name}: ${result.content.split("\n")[0] ?? ""}\n`);
  });

  agent.hooks.on("error", ({ error, where }) => {
    err(`✗ ${where}: ${error instanceof Error ? error.message : String(error)}\n`);
  });

  // A truncated/blocked/refused answer would otherwise end in silence — the clean
  // ends and interrupts carry their own signals, so only these three warn.
  agent.hooks.on("agent_end", ({ reason }) => {
    // Terminate the answer line only if there was an answer: a tool-only or
    // failed turn must not contribute a stray blank line to a piped stdout.
    if (wroteAnswer) {
      out("\n");
      wroteAnswer = false;
    }
    if (reason === "max_tokens") {
      err("⚠ response truncated (max_tokens): raise the provider's *_MAX_TOKENS, or enable /autocontinue.\n");
    } else if (reason === "content_filter") {
      err("⚠ response stopped (content_filter): blocked by the provider content filter.\n");
    } else if (reason === "refusal") {
      err("⚠ response stopped (refusal): the model declined to answer.\n");
    }
  });
}
