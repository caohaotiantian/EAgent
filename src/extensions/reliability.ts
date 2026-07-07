/**
 * reliability — same-provider bounded retry on a transient provider error.
 *
 * EAgent already has two reliability layers, but each owns a different axis and a
 * gap remains between them. `http.ts`'s `fetchWithRetry` retries 429/5xx at the
 * *fetch* level (before the stream opens) and, on exhaustion, throws a bare
 * `Error` whose message is the HTTP status body. `fallback-routing` fails over to
 * a *different* provider via a composite `Provider` (pre-first-event only). What
 * neither covers is a clean, composable in-loop retry of the **same** provider on
 * a post-connect / pre-first-event stream failure — a socket reset, a dropped
 * stream, a non-http provider (`mock`/`cassette`/custom) hiccup — optionally
 * downshifting to a smaller model.
 *
 * This extension rides the kernel's `onProviderError` filter seam (offered only
 * when the provider stream throws BEFORE emitting any event — a post-commit throw
 * is never offered, so there is no double-emit risk) and requests a bounded
 * re-stream with exponential backoff + jitter. It is a DIFFERENT axis from
 * `fallback-routing` (cross-provider) and `circuit-breaker` (tool-call loops): it
 * NEVER touches `agent.providerName` — the kernel re-streams the same provider,
 * only swapping `model` when a `downshiftModel` is configured.
 *
 * Conservative by construction: it retries ONLY errors it
 * positively recognizes as transient — connection codes (ECONNRESET, ETIMEDOUT,
 * ECONNREFUSED, EPIPE) or transient stream/network messages — and **excludes** the
 * http.ts-exhausted shape (` API error <code>:`), so it never stacks backoff on a
 * 429/5xx that `fetchWithRetry` already retried and exhausted. Everything else
 * default-denies. Off by default (a store `enabled` flag, toggled with
 * `/reliability on`); the handler is registered but returns the kernel's default
 * `{retry:false, fail:true}` until enabled, so a loaded-but-off extension is
 * inert. `EAGENT_RELIABILITY=off` is a hard kill switch. It declares no
 * capability — it only routes provider errors, touching no privileged authority.
 *
 * The backoff `sleep` is injectable (a `sleep(ms)` indirection set to a no-op in
 * the offline suite, so no real time passes).
 */

import type { ExtensionAPI } from "../kernel/extension.js";

/** Default number of retries (re-streams) before giving up. */
const DEFAULT_MAX_RETRIES = 3;
/** Base backoff in ms; the delay is `base * 2^(attempt-1)` with full jitter. */
const BACKOFF_BASE_MS = 100;

/**
 * Transient connection error codes worth a same-provider retry. Overridable per
 * deployment via the store key `codes` (a string array).
 */
export const DEFAULT_RETRY_CODES = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"] as const;

/** Transient stream/network failures recognizable by message text. */
const TRANSIENT_MESSAGE = /socket hang up|network|timed ?out|stream (closed|aborted)/i;

/**
 * The http.ts-exhausted shape (` API error <code>: <body>`). `fetchWithRetry`
 * already retried-and-exhausted 429/5xx before throwing this; recognizing it
 * keeps the two layers from stacking backoff — even when the 5xx body text
 * happens to contain "timed out".
 */
const HTTP_EXHAUSTED = / API error \d+:/;

/**
 * Whether `error` is a POSITIVELY-recognized transient, pre-first-event failure
 * worth a same-provider retry. Conservative default-deny: an opaque `Error`, a
 * non-object, or an http.ts-exhausted 429/5xx all return `false`. Pure and
 * exported so the classifier is directly unit-testable.
 */
export function isRetryable(error: unknown, codes: Set<string> = new Set(DEFAULT_RETRY_CODES)): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const rawMessage = (error as { message?: unknown }).message;
  const message = typeof rawMessage === "string" ? rawMessage : "";
  // http.ts owns and already exhausted this shape — never re-retry it.
  if (HTTP_EXHAUSTED.test(message)) return false;
  if (typeof code === "string" && codes.has(code)) return true;
  return TRANSIENT_MESSAGE.test(message);
}

export default function activate(
  e: ExtensionAPI,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): () => void {
  // Hard kill switch: wire nothing, return a no-op disposer.
  if (!e.config.enabled("reliability", { default: true })) return () => {};

  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

  /** Read a positive integer retry bound from the store, falling back safely. */
  const readMaxRetries = (): number => {
    const raw = e.store.get<unknown>("maxRetries");
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    return DEFAULT_MAX_RETRIES;
  };

  /** Read the (store-overridable) transient-code allowlist. */
  const readCodes = (): Set<string> => {
    const raw = e.store.get<unknown>("codes");
    if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) return new Set(raw as string[]);
    return new Set(DEFAULT_RETRY_CODES);
  };

  const cfg = (): { enabled: boolean; maxRetries: number; downshiftModel: string | undefined; codes: Set<string> } => ({
    enabled: e.store.get<boolean>("enabled", false) ?? false,
    maxRetries: readMaxRetries(),
    downshiftModel: e.store.get<string>("downshiftModel"),
    codes: readCodes(),
  });

  // The retry seam. Offered only on a pre-first-event throw, so a successful
  // re-stream cannot double-emit. With the extension disabled, or for
  // an unrecognized error, or once the bound is reached, we return the offered
  // default ({retry:false, fail:true}) unchanged — the kernel then rethrows.
  const off = e.hook("onProviderError", async (decision, ctx) => {
    try {
      const c = cfg();
      if (!c.enabled) return decision; // loaded-but-off ⇒ inert
      if (ctx.attempt > c.maxRetries) return decision; // bound reached ⇒ give up
      if (!isRetryable(ctx.error, c.codes)) return decision; // conservative default-deny

      // Exponential backoff with full jitter; the kernel re-streams the SAME
      // provider, so this never switches provider. The sleep is injectable (0 in
      // tests) — no real delay in the offline suite.
      const ceiling = BACKOFF_BASE_MS * 2 ** (ctx.attempt - 1);
      await sleep(Math.floor(Math.random() * ceiling));

      const retry: { retry: boolean; downshiftModel?: string; fail: boolean } = { retry: true, fail: false };
      if (c.downshiftModel) retry.downshiftModel = c.downshiftModel;
      return retry;
    } catch (err) {
      // Fail closed (don't retry on our own bug): return the offered default.
      e.log.warn("reliability: onProviderError hook error:", err);
      return decision;
    }
  });

  const offCmd = e.registerCommand({
    name: "reliability",
    description:
      "Same-provider bounded retry on transient provider errors. Usage: /reliability [on|off|status]",
    run: (c) => {
      const arg = c.args.trim();
      switch (arg) {
        case "on":
          e.store.set("enabled", true);
          c.print("reliability on");
          break;
        case "off":
          e.store.set("enabled", false);
          c.print("reliability off");
          break;
        case "":
        case "status":
        default: {
          const s = cfg();
          c.print(`enabled=${s.enabled}`);
          c.print(`maxRetries=${s.maxRetries}`);
          c.print(`downshiftModel=${s.downshiftModel ?? "(none)"}`);
          c.print(`codes=${[...s.codes].join(",")}`);
        }
      }
    },
  });

  return () => {
    for (const d of [off, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
