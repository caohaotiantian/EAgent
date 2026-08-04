/**
 * Shared HTTP + SSE plumbing for model adapters.
 *
 * No SDK. Providers talk to their APIs with the global `fetch` and a hand-rolled SSE
 * reader, which is what keeps `@loom/core` at zero runtime dependencies — and
 * therefore what keeps the single-binary deployment possible.
 *
 * The valuable part is not the transport; it is `normalizeError`. Every adapter maps
 * its native failures onto ONE taxonomy, which is what makes a fallback chain
 * declarative (`when: [E_PROVIDER_RATE_LIMIT]`) instead of provider-specific. Getting
 * a mapping wrong is how a content-policy refusal ends up being retried against
 * three providers in turn.
 *
 * See design/loom/01-INTERFACES.md D3.8.
 */

import { CODES, err, type LoomError } from "../errors.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  readonly fetch?: FetchLike;
  /** Bounded retries for transient failures BEFORE the first byte. Default 3. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Injected so tests and replay never depend on wall time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Map a provider's HTTP failure onto the normalized taxonomy.
 *
 * The distinctions that matter operationally:
 *   - 429 and 529/503 are retryable; 400 and 401 are not.
 *   - a CONTEXT OVERFLOW is a validation error, not a transient one: retrying the
 *     same prompt cannot help, and only a larger-window model can.
 *   - a CONTENT FILTER is `policy`. It must never trigger a fallback to another
 *     provider — trying a second vendor to evade a safety refusal is exactly the
 *     behaviour a fallback chain must not have.
 */
export function normalizeError(status: number, body: string, headers?: Headers): LoomError {
  const retryAfterMs = parseRetryAfter(headers?.get("retry-after"));
  const detail = body.slice(0, 500);
  const lower = body.toLowerCase();

  if (status === 429) {
    return err.exhausted(CODES.E_PROVIDER_RATE_LIMIT, `provider rate limit (${status})`, {
      details: { status, detail },
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (status === 529 || status === 503 || status === 502 || status === 504) {
    return err.unavailable(CODES.E_PROVIDER_OVERLOADED, `provider overloaded (${status})`, {
      details: { status, detail },
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (status === 401 || status === 403) {
    return err.policy(CODES.E_PROVIDER_AUTH, `provider rejected credentials (${status})`, { details: { status } });
  }
  if (status === 400 || status === 422) {
    if (lower.includes("context") && (lower.includes("length") || lower.includes("window") || lower.includes("token"))) {
      return err.validation(CODES.E_CONTEXT_OVERFLOW, "prompt exceeds the model's context window", {
        details: { status, detail },
      });
    }
    if (lower.includes("content") && (lower.includes("policy") || lower.includes("filter"))) {
      return err.policy(CODES.E_CONTENT_FILTERED, "provider refused on content grounds", { details: { status, detail } });
    }
    return err.validation(CODES.E_PROVIDER_BAD_REQUEST, `provider rejected the request (${status})`, {
      details: { status, detail },
    });
  }
  if (status >= 500) {
    return err.unavailable(CODES.E_PROVIDER_OVERLOADED, `provider error (${status})`, { details: { status, detail } });
  }
  return err.unavailable(CODES.E_PROVIDER_TRANSPORT, `unexpected provider status ${status}`, {
    details: { status, detail },
  });
}

/** A network-level failure, before any HTTP status existed. */
export function normalizeTransport(e: unknown): LoomError {
  if (e instanceof Error && e.name === "AbortError") return err.cancelled("model call aborted", { cause: e });
  return err.unavailable(CODES.E_PROVIDER_TRANSPORT, e instanceof Error ? e.message : String(e), { cause: e });
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * POST with bounded retries for pre-response failures.
 *
 * Only failures BEFORE the response is returned are retried here. Once a stream has
 * begun, a retry would double-emit deltas to the UI and double-count usage, so the
 * decision moves up to the node's `retry` policy — which knows about idempotency.
 */
export async function postJson(
  url: string,
  init: { headers: Record<string, string>; body: unknown; signal: AbortSignal },
  opts: HttpOptions = {},
): Promise<Response> {
  const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const maxAttempts = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 8_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let last: LoomError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (init.signal.aborted) throw err.cancelled();
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...init.headers },
        body: JSON.stringify(init.body),
        signal: init.signal,
      });
    } catch (e) {
      last = normalizeTransport(e);
      if (last.class === "cancelled" || attempt === maxAttempts) throw last;
      await sleep(Math.min(base * 2 ** (attempt - 1), max));
      continue;
    }

    if (res.ok) return res;

    const body = await res.text().catch(() => "");
    last = normalizeError(res.status, body, res.headers);
    if (!last.retryable || attempt === maxAttempts) throw last;
    // Honour the provider's own advice when it gives any; it knows better than a
    // fixed curve does.
    await sleep(last.retryAfterMs ?? Math.min(base * 2 ** (attempt - 1), max));
  }
  throw last ?? err.unavailable(CODES.E_PROVIDER_TRANSPORT, "request failed");
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export interface SseFrame {
  readonly event: string | undefined;
  readonly data: string;
}

/**
 * Parse an SSE body into frames.
 *
 * Buffers by `\n\n` rather than by chunk, because a network chunk boundary lands
 * mid-frame often enough that a naive per-chunk parser works in testing and drops
 * events in production.
 */
export async function* sse(res: Response, signal: AbortSignal): AsyncIterable<SseFrame> {
  const body = res.body;
  if (body === null) throw err.unavailable(CODES.E_PROVIDER_TRANSPORT, "provider returned no body");

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    for (;;) {
      if (signal.aborted) throw err.cancelled();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const frame = parseFrame(raw);
        if (frame !== undefined) yield frame;
        cut = buffer.indexOf("\n\n");
      }
    }
    const tail = parseFrame(buffer);
    if (tail !== undefined) yield tail;
  } finally {
    // Release the socket whether we finished, threw, or the consumer walked away.
    await reader.cancel().catch(() => undefined);
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 && event === undefined) return undefined;
  return { event, data: data.join("\n") };
}
