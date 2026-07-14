/**
 * watchdog — bound a hung main provider stream with an idle deadline.
 *
 * The agent loop's main `provider.stream(finalReq)` carries only the run-level
 * abort signal: a provider that yields nothing and never throws wedges the
 * `for await` forever (the run breaks only on an external `stop()`). Extension
 * sub-calls are bounded (`lib/sub-call.ts`) but the main stream is not. This
 * extension closes that gap at zero kernel cost.
 *
 * At activation it captures the DEFAULT provider (`e.agent.providers.get()`) and
 * re-registers, under the same name, a thin wrapper whose `stream` imposes an
 * IDLE deadline: it drives the inner stream via its async iterator and, for each
 * step, races `iterator.next()` against a timeout that rejects after `idleMs` and
 * is RE-ARMED on every event. The race — not abort alone — is what guarantees
 * unblocking even a stream that ignores its signal; the composed `AbortController`
 * (any-combined with `req.signal`) is complementary cleanup that frees the
 * underlying fetch (`http.ts` honors the signal). Because the agent resolves the
 * provider by name each turn and the registry overwrites by name, the wrapper is
 * picked up automatically with no kernel change.
 *
 * A pre-commit idle (zero events) surfaces to the loop's `onProviderError`/retry
 * seam; a mid-stream idle (>=1 event, committed) is rethrown as a fatal turn error
 * (retrying a partial stream would double-emit).
 *
 * Lifecycle: it registers via the RAW registry (`e.agent.providers.register`, NOT
 * the tracked `e.registerProvider` — a tracked dispose would DELETE the provider
 * on unload, not restore it) and its dispose re-registers the captured original by
 * overwrite. Idempotence: a module-local `WeakSet` of wrapper providers makes a
 * same-module double-activation a no-op; a reload disposes-then-reactivates
 * (`extension.ts`), restoring the original before re-wrap, so no double-wrap
 * arises. Ships ON (a safety net), inert unless a stream stalls past `idleMs`
 * (default 120s). `watchdog.idleMs` tunes the deadline; `EAGENT_WATCHDOG=off`
 * disables it. Declares no capability (providers are not capability-gated).
 */

import type { ExtensionAPI } from "../kernel/extension.js";
import type { CompletionRequest, Provider, StreamEvent } from "../kernel/types.js";
import type { WrappedProvider } from "./lib/provider-wrap.js";

/** Providers this module has produced as wrappers — the reload-stable idempotence
 *  brand (identity, not a per-activation symbol). A captured inner that is already
 *  one of ours means activation would double-wrap, so it skips. */
const WRAPPED = new WeakSet<Provider>();

/**
 * Drive `inner`'s stream, racing each `next()` against a per-step idle timeout.
 * On timeout OR an inner error, abort the composed controller (to free the
 * underlying fetch) and swallow the abandoned `next()` so a late abort-rejection
 * from a signal-honoring inner does not surface as an unhandledRejection; the
 * per-iteration `clearTimeout` prevents the idle timer from leaking either way.
 */
async function* idleGuard(
  inner: Provider,
  req: CompletionRequest,
  idleMs: number,
): AsyncGenerator<StreamEvent> {
  const ctrl = new AbortController();
  const upstream = req.signal;
  const it = inner.stream({ ...req, signal: AbortSignal.any([req.signal, ctrl.signal]) })[Symbol.asyncIterator]();
  for (;;) {
    // Honor the caller's own deadline (e.g. runSubCall's timeout on `upstream`)
    // promptly: a provider that ignores its AbortSignal must still be bounded by
    // the caller, not left running to our idle limit. React to `upstream` both
    // synchronously (already aborted) and via the race (aborts mid-step).
    if (upstream?.aborted) {
      ctrl.abort();
      throw upstream.reason ?? new Error("aborted");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const idle = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`provider idle for ${idleMs}ms`)), idleMs);
    });
    const aborted = new Promise<never>((_, rej) => {
      onAbort = () => rej(upstream?.reason ?? new Error("aborted"));
      upstream?.addEventListener("abort", onAbort, { once: true });
    });
    const step = it.next();
    let r: IteratorResult<StreamEvent>;
    try {
      r = await Promise.race([step, idle, aborted]);
    } catch (err) {
      ctrl.abort();
      step.catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
      if (onAbort) upstream?.removeEventListener("abort", onAbort);
    }
    if (r.done) return;
    yield r.value;
  }
}

export default function activate(e: ExtensionAPI): () => void {
  // Kill switch: EAGENT_WATCHDOG=off makes activation a total no-op.
  if (!e.config.enabled("watchdog", { default: true })) return () => {};

  const idleMs = e.config.int("watchdog.idleMs", 120000);

  // Capture the default provider. Nothing to wrap (undefined) → no-op.
  const inner = e.agent.providers.get();
  if (!inner) return () => {};

  // Already one of our wrappers (a same-module double-activation) → skip with an
  // inert dispose, so it can't clobber the registry with a stale restore.
  if (WRAPPED.has(inner)) return () => {};

  const wrapped: WrappedProvider = {
    name: inner.name,
    stream: (req) => idleGuard(inner, req, idleMs),
    wrappedInner: inner,
  };
  WRAPPED.add(wrapped);

  // Register via the RAW registry (untracked): overwrite-by-name installs the
  // wrapper under the same name; dispose restores the captured original manually.
  e.agent.providers.register(wrapped);

  return () => {
    e.agent.providers.register(inner);
    WRAPPED.delete(wrapped);
  };
}
