/**
 * Shared HTTP/SSE plumbing for streaming LLM providers.
 *
 * Both the Anthropic and OpenAI providers POST a JSON body and read back a
 * Server-Sent Events stream, and both want the same reliability behavior:
 * retry transient failures with backoff, honor `retry-after`, and abort
 * cleanly. Keeping that here means each provider file is just wire-format
 * mapping.
 */

export interface SSEMessage {
  event?: string;
  data: string;
}

/** Parse a `ReadableStream` of SSE bytes into `{ event?, data }` messages. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<SSEMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const msg: SSEMessage = { data: "" };
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) msg.event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      msg.data = dataLines.join("\n");
      yield msg;
    }
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
    await backoff(attempt++, res.headers.get("retry-after"), req.signal);
  }
}

/** Wait `2^attempt` seconds (capped, jittered), or a server `retry-after`. */
export async function backoff(attempt: number, retryAfter: string | null, signal: AbortSignal): Promise<void> {
  let ms: number;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    ms = Number.isFinite(seconds) ? seconds * 1000 : 1000;
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
