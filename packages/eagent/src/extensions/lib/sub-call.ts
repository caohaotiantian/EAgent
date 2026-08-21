// A bounded, abortable provider "sub-call": run a tool-less completion to its
// single `done` event under a deadline (and an optional caller abort), then
// return the final `Message`. It lives in `lib/` so any extension that makes an
// LLM sub-call outside the main agent loop (summarize/classify/judge) can share
// one cancellation path instead of each hand-rolling a timer. Kept pure —
// kernel types + Node only, no `ExtensionAPI`.

import type { CompletionRequest, Message, Provider, StreamEvent } from "../../kernel/types.ts";

/** Shared default deadline for a tool-less sub-call: generous, far below "forever". */
export const DEFAULT_SUB_CALL_TIMEOUT_MS = 30_000;

/**
 * Stream a tool-less completion to its `done` event and return that `Message`.
 *
 * A ref'd `setTimeout` deadline (not `AbortSignal.timeout`, whose timer is
 * unref'd) and the optional caller `signal` both drive one `AbortController`,
 * both cleaned up in `finally`. The deadline synthesizes its own error: the
 * timer sets `timedOut` and aborts, and the helper throws a fresh
 * `sub-call timed out after <ms>ms` (matching `/timed out/`) whenever `timedOut`
 * is set — regardless of what the aborted stream itself threw — so a timeout is
 * always distinguishable from a caller-abort or a provider error. On caller
 * abort (or any other stream error) the original error propagates.
 */
export async function runSubCall(
  provider: Provider,
  req: Omit<CompletionRequest, "signal">,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<Message> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    let message: Message | undefined;
    const stream: AsyncIterable<StreamEvent> = provider.stream({ ...req, signal: controller.signal });
    for await (const ev of stream) {
      if (ev.type === "done") message = ev.message;
    }
    if (timedOut) throw new Error(`sub-call timed out after ${opts.timeoutMs}ms`);
    if (!message) throw new Error("sub-call ended without a done event");
    return message;
  } catch (err) {
    if (timedOut) throw new Error(`sub-call timed out after ${opts.timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
