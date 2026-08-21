/**
 * Shared HTTP/SSE plumbing for streaming LLM providers.
 *
 * The Anthropic, OpenAI, and Gemini providers all POST a JSON body and read
 * back a Server-Sent Events stream, and all want the same reliability behavior:
 * retry transient failures with backoff, honor `retry-after`, and abort
 * cleanly. Keeping that here means each provider file is just wire-format
 * mapping.
 */

export interface SSEMessage {
  event?: string;
  data: string;
}

/** OOM-safety cap on a single un-terminated SSE event (`EAGENT_MAX_SSE_EVENT_BYTES`,
 *  default 16 MiB — far above any legitimate event; invalid/≤0 falls back to the default). */
export function maxSseEventBytes(): number {
  const n = Number(process.env.EAGENT_MAX_SSE_EVENT_BYTES);
  return Number.isInteger(n) && n > 0 ? n : 16 * 1024 * 1024;
}

/**
 * Parse a `ReadableStream` of SSE bytes into `{ event?, data }` messages.
 * Tolerates both LF and CRLF line endings (the spec permits CRLF, and some
 * proxies emit it): events are split on a blank line and the `data:` field is
 * de-prefixed by a single optional space, per the SSE spec.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<SSEMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const maxEvent = maxSseEventBytes();
  let buffer = "";
  // try/finally so that if the consumer throws (e.g. on a provider error frame) or
  // breaks early, the generator's `.return()` cancels the underlying stream and the
  // socket is released rather than left dangling. Cancel is a no-op on a done stream,
  // so it is safe on the normal-completion path too.
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const raw = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        const msg: SSEMessage = { data: "" };
        const dataLines: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith("event:")) msg.event = line.slice(6).trim();
          // Per the SSE spec, strip only a single leading space after the colon
          // (not all whitespace), so payloads with significant edge whitespace
          // survive. Trailing \r is already gone from the CRLF-aware line split.
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        msg.data = dataLines.join("\n");
        yield msg;
      }
      // OOM guard: whatever remains is one not-yet-terminated event. A stream that
      // never sends `\n\n` would grow `buffer` without bound, so cap a single
      // incomplete event and abort the stream (surfaces as a provider error).
      // `buffer.length` is UTF-16 code units (≈ bytes; over-approximates memory —
      // the JS string, at ≤2 bytes/unit, is what can OOM), which is what we bound.
      if (buffer.length > maxEvent) {
        throw new Error(`parseSSE: an SSE event exceeded ${maxEvent} bytes with no terminator`);
      }
    }
    // Stream ended: flush the decoder and emit a final event that arrived without a
    // trailing blank line (a proxy closing early would otherwise drop the last
    // token). Only emit when a `data:` line is present, so a clean close (empty
    // buffer) or a stray fragment yields nothing.
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      const dataLines: string[] = [];
      const msg: SSEMessage = { data: "" };
      for (const line of tail.split(/\r?\n/)) {
        if (line.startsWith("event:")) msg.event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length > 0) {
        msg.data = dataLines.join("\n");
        yield msg;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export interface RetryRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  maxRetries: number;
  /** Builds the error thrown for a non-retryable / final response. */
  describe: (status: number, detail: string) => string;
}

/**
 * POST `body` as JSON, retrying 429/5xx and network errors with exponential
 * backoff (honoring `retry-after`). Returns a streaming `Response` (guaranteed
 * `ok` with a body) or throws after `maxRetries` or on a non-retryable status.
 */
export async function fetchWithRetry(req: RetryRequest): Promise<Response> {
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await req.fetchImpl(req.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...req.headers },
        body: JSON.stringify(req.body),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal.aborted || attempt >= req.maxRetries) throw err;
      await backoff(attempt++, null, req.signal);
      continue;
    }

    if (res.ok && res.body) return res;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= req.maxRetries) {
      throw new Error(req.describe(res.status, await safeText(res)));
    }
    // Drain the retryable response body before looping: an unconsumed body pins
    // the underlying socket (undici) until GC, leaking a connection per retry.
    await res.body?.cancel().catch(() => {});
    await backoff(attempt++, res.headers.get("retry-after"), req.signal);
  }
}

/** Wait `2^attempt` seconds (capped, jittered), or a server `retry-after`. */
export async function backoff(attempt: number, retryAfter: string | null, signal: AbortSignal): Promise<void> {
  let ms: number;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      ms = seconds * 1000;
    } else {
      // Retry-After may be an HTTP-date instead of delta-seconds (RFC 7231).
      const at = Date.parse(retryAfter);
      ms = Number.isFinite(at) ? Math.max(0, at - Date.now()) : 1000;
    }
  } else {
    ms = Math.min(2 ** attempt * 1000, 16000) + Math.floor(Math.random() * 250);
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText;
  }
}
