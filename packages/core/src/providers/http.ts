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

import { CODES, err, isLoomError, toLoomError, type LoomError } from "../errors.ts";
import { redact } from "../security/redact.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  readonly fetch?: FetchLike;
  /**
   * Bounded retries for transient failures BEFORE the first byte. Default 3.
   *
   * A whole number of at least 1. `Infinity` is refused, and that is not defensive
   * typing: `for (let attempt = 1; attempt <= Infinity; …)` is a loop with no exit, on a
   * path whose whole purpose is to be bounded.
   */
  readonly maxAttempts?: number;
  /** First retry delay; doubles per attempt. Whole ms from 0 to `MAX_TIMER_MS`. Default 250. */
  readonly baseDelayMs?: number;
  /** The longest this will EVER hold between attempts, provider advice included. Default 8 s. */
  readonly maxDelayMs?: number;
  /** Injected so tests and replay never depend on wall time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The largest delay a Node timer can hold — 2³¹−1 ms, about 24.8 days.
 *
 * `setTimeout` keeps its delay in a 32-bit signed integer and TRUNCATES anything larger
 * to ONE MILLISECOND; it does not saturate and it does not throw. Measured on node
 * v24.16.0: `setTimeout(fn, 2 ** 31)` fired after 2 ms, and `NaN`, `Infinity` and any
 * negative do the same, each with a warning that names no call site.
 *
 * A copy of this constant lives in every module that hands a caller-supplied number to a
 * timer. `grep -ran 'MAX_TIMER_MS' packages/core/src` finds all of them — a command
 * rather than a list, because a list of file names is a count by another name and rots
 * the same way. They are copies rather than one export because a platform fact does not
 * belong on the pinned public surface.
 */
const MAX_TIMER_MS = 2_147_483_647;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 8_000;

/**
 * A caller-supplied delay, refused rather than clamped when no timer can hold it.
 *
 * `baseDelayMs` and `maxDelayMs` are pinned public knobs, so this is the OPERATOR half of
 * the same defect the `Retry-After` bound covers: an embedder asking for a patient
 * 24.8-day ceiling installs the most aggressive retry this file can emit. Refused on
 * `cli.ts`'s argument at `positive` — a silent clamp is the bug being fixed, and no
 * direction of clamp is right for every caller of a duration.
 *
 * **Zero is legal here and nowhere else in this file.** `baseDelayMs: 0` says "no
 * backoff", which is a coherent thing to want when `maxAttempts` is already the bound;
 * `timeoutMs: 0` in the sandbox says "run for no time", which is only ever a typo for
 * "no limit". Same number, opposite readings, so the rule is per-knob rather than global.
 */
function boundedDelay(v: unknown, fallback: number, where: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_TIMER_MS) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `${where} must be a whole number of milliseconds from 0 to ${MAX_TIMER_MS} (~24.8 days), not ${typeof v === "number" ? String(v) : typeof v}. ` +
        `Node keeps a timer delay in 32 bits and truncates a larger one to ONE MILLISECOND, so a value above the ceiling becomes ` +
        `the fastest retry loop this code can emit rather than the patient one it reads as.`,
    );
  }
  return v;
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

/**
 * A network-level failure, before any HTTP status existed.
 *
 * TWO THINGS IT DOES ARE NOT ABOUT THE NETWORK.
 *
 * **A value that already has a class is not re-classified.** `sse` throws `err.cancelled()`
 * the moment the run's signal is aborted, and this function used to hand it straight to
 * `err.unavailable` — so a human pressing stop arrived at the caller as a RETRYABLE
 * infrastructure failure, which is a licence for the retry ladder to re-run the work they
 * stopped. The same flattening cost a content refusal its `policy` class one layer down.
 * `toLoomError` rather than a bare `return e`, because `instanceof` proves a prototype and
 * not provenance, and the value is on its way to `errorRecord`.
 *
 * **The message is somebody else's string, and it can carry a credential.** undici names the
 * whole URL when it refuses one: `Request cannot be constructed from a URL that includes
 * credentials: https://svc:hunter2@api.example.com/…`. That message becomes
 * `LoomError.message`, and `toJSON` puts it in the journal, which is append-only — so the
 * redaction has to happen where the message is BUILT, not where it is read.
 *
 * `security/redact.ts`'s `maskLiterals` is the mechanism for masking a value THIS PROCESS
 * HOLDS out of text somebody else wrote, and it is deliberately not what runs here: it needs
 * the literal, this seam is handed an error and nothing else, and its `MIN_MASKABLE` floor of
 * 6 characters would pass a short password through untouched. The userinfo component of a URL
 * needs no literal to recognise — it is a grammatical position, not a pattern to guess at —
 * which keeps it mechanism 1 (a structural fact) even though it travels with the detector
 * sweep: `DETECTORS`' `url-credentials` entry is, in that file's words, mechanism 1 wearing
 * mechanism 2's clothes, and the sweep is the plumbing rather than the epistemology.
 *
 * **THE RULE IS NOT WRITTEN HERE, AND THAT IS THE POINT OF THIS PARAGRAPH.** It was: a private
 * `URL_USERINFO` regex sat below this function, and `security/redact.ts` grew its own copy for
 * the read boundaries. The copies then drifted in the direction copies always drift — the
 * shared one was widened to end the userinfo run at the LAST `@` before the authority, this
 * one was not, and a password containing `@` came out of this function with its tail intact
 * and a `[redacted]` beside it claiming otherwise. Measured, one string, two roads:
 *
 *     redact(msg).value      ⇒ "…credentials: https://[redacted]@api.example.com/v1"
 *     this file's own copy   ⇒ "…credentials: https://[redacted]@ssw0rd-tail@api.example.com/v1"
 *
 * — and the second is the one `errorRecord` writes, where no later fix removes it. So there is
 * one mechanism and this file CALLS it. `redact` is the exported way in; the `url-credentials`
 * detector is the entry that matters here, and running the rest of the sweep over a foreign
 * `Error.message` on its way into an append-only file is a gain, not a cost.
 */
export function normalizeTransport(e: unknown): LoomError {
  if (isLoomError(e)) return toLoomError(e);
  if (e instanceof Error && e.name === "AbortError") return err.cancelled("model call aborted", { cause: e });
  return err.unavailable(CODES.E_PROVIDER_TRANSPORT, redactCredentials(e instanceof Error ? e.message : String(e)), {
    cause: e,
  });
}

/**
 * The shared sweep, narrowed back to the `string → string` this seam needs.
 *
 * `RedactionResult.value` is `unknown` because `redact` walks any payload; for a string leaf
 * every arm of that walk returns a string, so the branch below is unreachable. It is written
 * fail-CLOSED anyway — `[redacted]` rather than the original — because the one thing this
 * function must never do is hand back an unmasked message on a path it did not expect.
 */
function redactCredentials(text: string): string {
  const out = redact(text).value;
  return typeof out === "string" ? out : "[redacted]";
}

/**
 * `Retry-After`, parsed as UNTRUSTED INPUT — because that is exactly what it is.
 *
 * Every other duration in this codebase is written by an operator in a config file or a
 * flag, and is bounded there. This one is chosen by the REMOTE PARTY: a compromised,
 * hostile, or merely buggy model provider picks the number, and it used to reach
 * `setTimeout` unbounded and unclamped. The two ends are separate attacks:
 *
 *   - **A large value parks a worker.** `Retry-After: 86400` is a legal, unremarkable
 *     header — it is what a provider says for "come back tomorrow" — and it held a worker
 *     for a day. No warning is printed, because 86 400 000 fits in 32 bits.
 *   - **A value the platform cannot hold becomes its own opposite.** `Retry-After:
 *     2147484` (24.85 days) truncates to ONE MILLISECOND, turning a polite backoff into a
 *     hot retry loop aimed at the provider that asked for it — which is also a way to
 *     burn a budget from the outside.
 *
 * So: **STRICT SYNTAX, then the platform range.** RFC 9110 says `Retry-After` is
 * `delay-seconds` (`1*DIGIT`) or an HTTP-date, and nothing else. `Number()` accepted far
 * more than that and coerced four separate malformed headers — `""`, `"   "`, `"-5"` and
 * a whitespace-only value — to **zero**, which the caller then read as "retry now". "This
 * header is not a duration" and "this header says zero" are different facts and must not
 * produce the same value.
 *
 * ANYTHING UNUSABLE RETURNS `undefined`, i.e. *no advice*, and the caller falls back to
 * its own curve.
 *
 * **THIS FUNCTION IS NOT A BOUND**, and this docstring used to say it was — that a value
 * is dropped rather than clamped "so that the absurd number never reaches
 * `LoomError.retryAfterMs` either". Only half of that holds, and it is the less
 * interesting half. Measured through `normalizeError(429, …).toJSON()`:
 *
 *     "2147484"  → dropped, absent from the error   (no timer can hold 24.85 days)
 *     "86400"    → retryAfterMs: 86400000           (a legal header; a worker parked a DAY)
 *
 * So what no platform can represent is dropped, and the value the first bullet above names
 * as an attack is passed through, journaled by `toJSON`, and handed to any caller that
 * reads it. That is the right behaviour and is now said out loud rather than denied:
 * **`retryAfterMs` is a faithful record of what the provider ASKED FOR.** A truncated
 * record would be its own lie — "come back tomorrow" is real advice and the journal should
 * say what was received, not what we were willing to do about it.
 *
 * THE BOUND LIVES AT `retryDelay`, the one place that knows `maxDelayMs` — how long this
 * deployment agreed to wait. `normalizeError` neither knows nor can: it is handed a status,
 * a body and headers, never `HttpOptions`. **A caller that reads `retryAfterMs` off an
 * error and hands it to a timer of its own therefore has no ceiling and must supply one.**
 * That is what the replaced sentence was reaching for before it lost its negation and
 * arrived at "a bound that only one caller applies is a bound".
 *
 * This still reads the wall clock for the HTTP-date form, so the same recorded response
 * parses differently at a different instant. That is pre-existing and out of this change:
 * provider calls are recorded at the `ctx.effect` boundary above, so replay serves the
 * turn rather than re-parsing the header.
 */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;
  // `delay-seconds = 1*DIGIT`. No sign, no exponent, no hex, no fraction — each of which
  // `Number()` accepted and none of which a conforming server sends.
  if (/^[0-9]+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return Number.isSafeInteger(ms) && ms <= MAX_TIMER_MS ? ms : undefined;
  }
  // `Date.parse` HAS THE SAME DEFECT `Number` HAD, and tightening one without the other
  // just moves it: V8 falls back to a lenient parser that INVENTS a date from almost
  // anything. Measured — `Date.parse("-5")` is **988646400000**, i.e. 2001-04-30, so the
  // rejected-by-the-digit-check `"-5"` came straight back as a date in the past and read
  // as "retry now". All three date forms RFC 9110 allows (IMF-fixdate, RFC 850, asctime)
  // begin with a three-letter weekday, and nothing else does.
  if (!/^(mon|tue|wed|thu|fri|sat|sun)/i.test(raw)) return undefined;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  const ms = at - Date.now();
  // A date already past is genuine advice — "you may retry now" — and is kept as 0. The
  // caller floors it against its own curve, so 0 never means "spin".
  if (ms <= 0) return 0;
  return ms <= MAX_TIMER_MS ? ms : undefined;
}

/**
 * How long to wait before the next attempt — the one place a remote number is bounded.
 *
 * The rule, in one line: **the provider's advice may move the delay within
 * `[our own curve, maxDelayMs]` and nowhere else.**
 *
 * That is a deliberate choice among three, and the other two are worse:
 *
 *  1. **Obey the header.** What the code did. A remote party then owns a worker's
 *     lifetime in both directions, which is the defect.
 *  2. **Ignore the header entirely.** Safe and rude: a 429 with `Retry-After: 60` means
 *     the provider is telling us the truth about its own capacity, and hammering it on a
 *     250 ms curve makes the outage longer for everyone.
 *  3. **Clamp into `[own, max]`** — this. The header can only ever ask for MORE patience
 *     than our curve and never more than the operator already agreed to wait. A hostile
 *     provider's best move becomes "make us wait `maxDelayMs`", which is a bound the
 *     deployment chose, times `maxAttempts`, which it also chose.
 *
 * The floor is what stops the *other* attack, and it is the half that is easy to miss:
 * `Retry-After: 0` is legal and means "retry now", so obeying it literally turns a polite
 * backoff into a hot loop aimed at the provider — a way to burn a budget that costs the
 * attacker one header.
 */
function retryDelay(advised: number | undefined, base: number, max: number, attempt: number): number {
  const own = Math.min(base * 2 ** (attempt - 1), max);
  if (advised === undefined) return own;
  return Math.min(Math.max(advised, own), max);
}

/**
 * Hold for `ms`, or until the caller aborts — whichever comes first.
 *
 * The run's cancellation is the only deadline visible at this seam (the budget is not:
 * `postJson` is handed a URL and a body, and knows nothing about the run that wants
 * them). Using it is what makes the bound above honest at the top end: `maxDelayMs` is
 * the longest a LIVE run waits, and a cancelled one stops waiting immediately rather than
 * sitting out a delay a provider chose.
 *
 * The listener is removed either way, so an injected `sleep` that resolves at once — the
 * whole suite — leaves nothing attached to the signal.
 *
 * WHAT THIS DOES NOT DO, said plainly: the losing `sleep` is not cancelled, because the
 * injected signature is `(ms) => Promise<void>` and there is nothing here to cancel it
 * with. The default one is a bare `setTimeout`, so after an abort its timer still runs to
 * completion — for at most `maxDelayMs`, which is bounded at the top of `postJson`. The
 * timer is deliberately NOT `unref`'d: during a backoff the retry is the only live handle,
 * and unref'ing it would let `loom run` exit in the middle of one.
 */
async function hold(ms: number, signal: AbortSignal, sleep: (ms: number) => Promise<void>): Promise<void> {
  // A zero delay still goes THROUGH `sleep`, so an injected one stays a faithful record of
  // every backoff the loop took. Short-circuiting it would make "no backoff" and "no
  // attempt" indistinguishable to a test.
  if (signal.aborted) return;
  let release = (): void => undefined;
  const aborted = new Promise<void>((resolve) => {
    release = (): void => resolve();
    signal.addEventListener("abort", release, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    signal.removeEventListener("abort", release);
  }
}

/**
 * POST with bounded retries for pre-response failures.
 *
 * Only failures BEFORE the response is returned are retried here. Once a stream has
 * begun, a retry would double-emit deltas to the UI and double-count usage, so the
 * decision moves up to the node's `retry` policy — which knows about idempotency.
 *
 * EVERY NUMBER THAT REACHES A TIMER FROM HERE IS BOUNDED FIRST, and they come from two
 * different places with two different threat models: `maxAttempts`, `baseDelayMs` and
 * `maxDelayMs` are an embedder's (refused at the top, before a single request is made),
 * and `retryAfterMs` is the PROVIDER'S (clamped per attempt — see `retryDelay`).
 */
export async function postJson(
  url: string,
  init: { headers: Record<string, string>; body: unknown; signal: AbortSignal },
  opts: HttpOptions = {},
): Promise<Response> {
  const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  // Not a delay, but the same class of defect one step over: this is the loop's only
  // exit, so a non-integer or an `Infinity` here is an unbounded retry storm rather than
  // a mistimed one.
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `HttpOptions.maxAttempts must be a whole number of at least 1, not ${typeof maxAttempts === "number" ? String(maxAttempts) : typeof maxAttempts}. ` +
        `It is the retry loop's only exit condition, so \`Infinity\` is a loop that never ends.`,
    );
  }
  const base = boundedDelay(opts.baseDelayMs, DEFAULT_BASE_DELAY_MS, "HttpOptions.baseDelayMs");
  const max = boundedDelay(opts.maxDelayMs, DEFAULT_MAX_DELAY_MS, "HttpOptions.maxDelayMs");
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
      await hold(retryDelay(undefined, base, max, attempt), init.signal, sleep);
      continue;
    }

    if (res.ok) return res;

    const body = await res.text().catch(() => "");
    last = normalizeError(res.status, body, res.headers);
    if (!last.retryable || attempt === maxAttempts) throw last;
    // Honour the provider's own advice AS FAR AS THE OPERATOR AGREED TO — it knows better
    // than a fixed curve does about its own capacity, and nothing about how long this
    // deployment is willing to wait.
    await hold(retryDelay(last.retryAfterMs, base, max, attempt), init.signal, sleep);
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
