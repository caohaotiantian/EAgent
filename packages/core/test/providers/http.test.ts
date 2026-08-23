/**
 * What a transport failure is allowed to SAY, and what it is allowed to RE-CLASSIFY.
 *
 * `normalizeTransport` builds the message that a failed provider call carries into the
 * journal, and it built it out of somebody else's `Error.message`. Two facts about that
 * string were wrong at once: a URL with `user:pass@host` in it — undici names the whole URL
 * when it refuses one — put a live credential in a durable record, and an error that had
 * ALREADY been classified came back out re-classified, so `cancelled` became a retryable
 * `unavailable`.
 *
 * AND THE FIX FOR THE SECOND BECAME THE HOLE IN THE FIRST, which is what the second half of
 * this file is about. `normalizeTransport` grew an `isLoomError` early return so an inner
 * layer's verdict would survive — and an early return is a road around everything after it,
 * including the masking one paragraph up. `normalizeError`'s `details.detail` was never swept
 * at all. Both write into a `LoomError`, `errorRecord` copies both into an APPEND-ONLY file,
 * and `server/http.ts`'s `summarise` hands a projection's `error` and each task's `error`
 * straight on without a sweep — so neither field had redaction on either side of it.
 *
 * These tests assert the BYTES OF THE JOURNAL RECORD rather than a boolean, because "does not
 * contain the password" is true of a record that lost the whole message too, and because the
 * thing being defended is exactly a sequence of bytes in a file nothing later edits.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, err, isLoomError } from "../../src/errors.ts";
import { errorRecord } from "../../src/journal/events.ts";
import { AnthropicAdapter } from "../../src/providers/anthropic.ts";
import { normalizeError, normalizeTransport, postJson } from "../../src/providers/http.ts";
import { redact } from "../../src/security/redact.ts";
import type { ModelRequest } from "../../src/run/registry.ts";

const ac = (): AbortSignal => new AbortController().signal;

/**
 * One string, used on every road below, and each half of it is load-bearing.
 *
 * The password contains an `@`, so a run that stops at the FIRST `@` leaves `ssw0rd-tail`
 * standing beside a `[redacted]` claiming otherwise; the host and path are ordinary, so a
 * redactor that shredded them would be one an operator turns off.
 */
const CRED = "https://svc:p@ssw0rd-tail@api.example.com/v1";
const MASKED = "https://[redacted]@api.example.com/v1";

// ── credentials in a URL are credentials ─────────────────────────────────────

test("URL CREDENTIALS DO NOT REACH THE JOURNALED MESSAGE", async () => {
  // undici's own words, verbatim, for a `fetch` whose URL carries userinfo. The message is
  // not ours and the credential is not ours either — it is the operator's, on its way into
  // an append-only file.
  const e = normalizeTransport(
    new TypeError(
      "Request cannot be constructed from a URL that includes credentials: https://svc:hunter2@api.example.com/v1/messages",
    ),
  );

  assert.ok(isLoomError(e));
  assert.equal(e.code, CODES.E_PROVIDER_TRANSPORT);
  assert.equal(e.message.includes("hunter2"), false, "the password must not survive into the message");
  assert.equal(e.message.includes("svc:"), false, "nor the user half of it");
  assert.match(e.message, /\[redacted\]@api\.example\.com/, "the host stays — it is the half that helps");
  // `toJSON` is the shape a journal payload and an HTTP body actually carry.
  assert.equal(String((e.toJSON() as Record<string, unknown>)["message"]).includes("hunter2"), false);
});

test("a userinfo with no password is a credential too", () => {
  const e = normalizeTransport(new Error("connect ECONNREFUSED https://ghp_liveTokenValue@github.example.com/api"));
  assert.equal(e.message.includes("ghp_liveTokenValue"), false);
  assert.match(e.message, /\[redacted\]@github\.example\.com/);
});

test("A PASSWORD CONTAINING `@` LOSES ITS TAIL, NOT ITS HEAD", () => {
  // `@` is legal inside a percent-decoded password and common in generated ones. A run that
  // stops at the FIRST `@` masks the part before it and leaves everything after it standing,
  // which is the worst of the three possible outcomes: the credential is in the journal AND
  // the `[redacted]` beside it says it is not. RFC 3986 ends the userinfo at the LAST `@`
  // before the authority terminator, so that is where the run has to stop.
  const e = normalizeTransport(
    new TypeError(
      "Request cannot be constructed from a URL that includes credentials: https://svc:p@ssw0rd-tail@api.example.com/v1/messages",
    ),
  );

  assert.equal(e.message.includes("ssw0rd-tail"), false, "the tail of the password must not survive either");
  assert.match(e.message, /credentials: https:\/\/\[redacted\]@api\.example\.com\/v1\/messages$/);
});

test("the WRITE boundary and the READ boundary mask a credential identically", () => {
  // Two copies of one rule drifted: `security/redact.ts` was widened and this file's private
  // copy was not, so the same string was masked one way on its way into the journal and
  // another way on its way out to a span. There is one mechanism now; this is what says so.
  for (const text of [
    "Request cannot be constructed from a URL that includes credentials: https://svc:p@ssw0rd-tail@api.example.com/v1",
    "connect ECONNREFUSED https://ghp_liveTokenValue@github.example.com/api",
    "socket hang up while POSTing https://api.example.com/v1/mail/a@b.example",
  ]) {
    assert.equal(normalizeTransport(new Error(text)).message, redact(text).value, text);
  }
});

test("an `@` that is not userinfo is left alone — a redactor nobody can read is one nobody keeps", () => {
  const kept = [
    "socket hang up while POSTing https://api.example.com/v1/mail/a@b.example",
    "no route to host for mailto:ops@example.com",
    "unexpected token @ in body",
  ];
  for (const text of kept) assert.equal(normalizeTransport(new Error(text)).message, text, text);
});

test("the redaction survives the retry loop it is thrown from", async () => {
  await assert.rejects(
    () =>
      postJson(
        "https://svc:hunter2@api.example.com/v1/messages",
        { headers: {}, body: {}, signal: ac() },
        {
          fetch: async () => {
            throw new TypeError(
              "Request cannot be constructed from a URL that includes credentials: https://svc:hunter2@api.example.com/v1/messages",
            );
          },
          maxAttempts: 1,
          sleep: async () => undefined,
        },
      ),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_PROVIDER_TRANSPORT && !e.message.includes("hunter2"),
  );
});

// ── an error that already has a class keeps it ───────────────────────────────

test("AN ALREADY-CLASSIFIED ERROR IS NOT RE-CLASSIFIED — a cancel stays cancelled", () => {
  // `sse` throws `err.cancelled()` when the run's signal is aborted. Re-wrapping it as
  // `E_PROVIDER_TRANSPORT` made a human's stop retryable, which is a licence to re-run the
  // work they stopped.
  const cancelled = normalizeTransport(err.cancelled());
  assert.equal(cancelled.class, "cancelled");
  assert.equal(cancelled.code, CODES.E_CANCELLED);
  assert.equal(cancelled.retryable, false);

  // The same holds for every other class an inner layer already decided.
  const refused = normalizeTransport(err.policy(CODES.E_CONTENT_FILTERED, "provider refused on content grounds"));
  assert.equal(refused.class, "policy");
  assert.equal(refused.code, CODES.E_CONTENT_FILTERED);
  assert.equal(refused.retryable, false);
});

test("a platform AbortError is still a cancel", () => {
  const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  const e = normalizeTransport(abort);
  assert.equal(e.class, "cancelled");
  assert.equal(e.code, CODES.E_CANCELLED);
});

test("an ordinary network failure is still a retryable transport error", () => {
  const e = normalizeTransport(new Error("socket hang up"));
  assert.equal(e.class, "unavailable");
  assert.equal(e.code, CODES.E_PROVIDER_TRANSPORT);
  assert.equal(e.retryable, true);
  assert.equal(e.message, "socket hang up");
});

// ── the two arms are one boundary ────────────────────────────────────────────

test("THE `isLoomError` ARM IS NOT A ROAD AROUND THE SWEEP — same string, two roads, one process", () => {
  // The arm above returns early so an inner layer's verdict survives. It returned early
  // before any redaction too, and it is the arm carrying the one string a REMOTE PARTY gets
  // to choose: `anthropic.ts` turns a provider's `error` SSE frame into
  // `err.unavailable(E_PROVIDER_TRANSPORT, ev.error.message)` and throws it into the catch
  // that calls this function. Measured before the fix, this second line read
  // `…credentials: https://svc:p@ssw0rd-tail@api.example.com/v1` — verbatim, into the journal.
  const msg = `Request cannot be constructed from a URL that includes credentials: ${CRED}`;
  const expected = `Request cannot be constructed from a URL that includes credentials: ${MASKED}`;

  assert.equal(normalizeTransport(new TypeError(msg)).message, expected, "the arm that always masked");
  assert.equal(
    normalizeTransport(err.unavailable(CODES.E_PROVIDER_TRANSPORT, msg)).message,
    expected,
    "the arm that did not",
  );

  // The bytes `errorRecord` writes, in full, because that is the artefact being defended.
  assert.deepEqual(errorRecord(normalizeTransport(err.unavailable(CODES.E_PROVIDER_TRANSPORT, msg))), {
    class: "unavailable",
    code: CODES.E_PROVIDER_TRANSPORT,
    message: expected,
    retryable: true,
  });
});

test("a `details` on an already-classified error is swept too — it is the other field errorRecord copies", () => {
  const dirty = err.exhausted(CODES.E_PROVIDER_RATE_LIMIT, `slow down ${CRED}`, {
    retryAfterMs: 30_000,
    details: { status: 429, detail: `key ${CRED}` },
  });
  assert.deepEqual(errorRecord(normalizeTransport(dirty)), {
    class: "exhausted",
    code: CODES.E_PROVIDER_RATE_LIMIT,
    message: `slow down ${MASKED}`,
    retryable: true,
    details: { status: 429, detail: `key ${MASKED}` },
  });
});

test("SWEEPING DOES NOT TOUCH THE TAXONOMY, and it does not rebuild an error it found nothing in", () => {
  // The `isLoomError` arm exists so a `cancelled` does not become a retryable `unavailable`.
  // Masking acts on `message` and `details` — the two fields `errorRecord` copies — and is
  // forbidden from `class` and `code`, which the retry ladder and the HTTP mapping branch on.
  const dirty = err.exhausted(CODES.E_PROVIDER_RATE_LIMIT, `slow down ${CRED}`, { retryAfterMs: 30_000 });
  const swept = normalizeTransport(dirty);
  assert.equal(swept.class, "exhausted");
  assert.equal(swept.code, CODES.E_PROVIDER_RATE_LIMIT);
  assert.equal(swept.retryable, true);
  assert.equal(swept.retryAfterMs, 30_000);
  assert.equal((swept as Error).cause, dirty, "the unmasked original stays reachable for a debugger");
  assert.equal(String(swept.stack ?? "").includes("ssw0rd-tail"), false, "and not through the stack either");

  // IDENTITY, for the ordinary case. Callers re-throw and compare `code`, and a rebuild costs
  // `stack`; an error with nothing to mask must come back as itself.
  const clean = err.cancelled();
  assert.equal(normalizeTransport(clean), clean);
  const counters = err.unavailable(CODES.E_PROVIDER_TRANSPORT, "cut", { details: { textChars: 3, toolCalls: 0 } });
  assert.equal(normalizeTransport(counters), counters);
});

// ── `details.detail` is 500 bytes of somebody else's response body ───────────

test("`details.detail` IS SWEPT — it was the one field with no redaction on either side of it", () => {
  // Measured before the fix:
  //   normalizeError(400, msg).toJSON().details
  //     ⇒ {"status":400,"detail":"…credentials: https://svc:p@ssw0rd-tail@api.example.com/v1"}
  const body = `Request cannot be constructed from a URL that includes credentials: ${CRED}`;
  for (const [status, klass, code] of [
    [400, "validation", CODES.E_PROVIDER_BAD_REQUEST],
    [429, "exhausted", CODES.E_PROVIDER_RATE_LIMIT],
    [500, "unavailable", CODES.E_PROVIDER_OVERLOADED],
    [502, "unavailable", CODES.E_PROVIDER_OVERLOADED],
    // 418 is a 4xx, so it now classifies with the rest of them rather than falling through.
    [418, "validation", CODES.E_PROVIDER_BAD_REQUEST],
    // ...and this row keeps the ACTUAL fallthrough covered, which after that change is
    // reachable only by a non-ok status that is neither 4xx nor 5xx. The row exists so the
    // sweep is still exercised on every branch, which is what this test is about.
    [302, "unavailable", CODES.E_PROVIDER_TRANSPORT],
  ] as const) {
    const record = errorRecord(normalizeError(status, body));
    assert.deepEqual(
      record.details,
      { status, detail: `Request cannot be constructed from a URL that includes credentials: ${MASKED}` },
      `status ${status}`,
    );
    assert.equal(record.class, klass, `status ${status}`);
    assert.equal(record.code, code, `status ${status}`);
  }
});

test("a 401 body still contributes NO detail at all — the sweep does not make mechanism 1 redundant", () => {
  // The body returned WITH an auth rejection is the one most likely to quote the credential
  // it rejected, in whatever shape that vendor invented. The sweep is a backstop with false
  // negatives; not writing the field is not.
  assert.deepEqual(errorRecord(normalizeError(401, `rejected key ${CRED} sk-liveAAAABBBBCCCCDDDD`)).details, {
    status: 401,
  });
});

test("MASK BEFORE BOUNDING — a credential straddling the 500-byte cut is masked, not severed", () => {
  // Cutting first severs `https://svc:hunter2secret@host` at `https://svc:hunt`, which no
  // longer matches `url-credentials` — so the cut would both hide the leak from the sweep and
  // leave most of the password in the journal row. The sweep runs over the window; the cut
  // happens to its output.
  const straddle = `${"x".repeat(480)} https://svc:hunter2secret@api.example.com/v1/messages tail`;
  const detail = (normalizeError(400, straddle).details as { readonly detail: string }).detail;

  assert.equal(detail.includes("svc:hunt"), false, "not even the head of it");
  assert.equal(detail.includes("hunter2secret"), false);
  assert.ok(detail.endsWith("https://[redacted]@"), `masked before the cut, then cut: ${JSON.stringify(detail)}`);
  assert.equal(detail.length, 500, "and still bounded at 500");
});

// ── the write boundary is BOUNDED WORK on model-controlled input ─────────────

test("THE SWEEP OVER A PROVIDER BODY IS BOUNDED, AND THE BOUND IS 8192 BYTES OF IT", () => {
  // `redact`'s `pem` detector is the one entry with an unanchored lazy tail, so a body full of
  // `-----BEGIN … PRIVATE KEY-----` with no `END` costs O(n·k). Measured through `redact`:
  // 64 KB → 20.8 ms, 128 KB → 80.2 ms, 256 KB → 306.4 ms, 512 KB → 1 157 ms, 1 MB → 4 682 ms,
  // 2 MB → 18 456 ms — four times the input, sixteen times the time, on a string a provider
  // picks. Routing a body through the sweep without a bound would have installed exactly the
  // defect a previous wave measured at 19 s.
  //
  // THE ASSERTION IS BYTE IDENTITY, NOT A CLOCK. A timing test on a shared machine is a flake;
  // "the answer is the same as for the first 8192 bytes" is a deterministic proof that no more
  // than 8192 bytes were examined.
  const unit = "-----BEGIN A PRIVATE KEY-----";
  const huge = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
  assert.ok(huge.length > 1024 * 1024);

  assert.deepEqual(normalizeError(500, huge).details, normalizeError(500, huge.slice(0, 8192)).details);
  assert.equal((normalizeError(500, huge).details as { readonly detail: string }).detail.length, 500);

  // The same bound on the message, on both arms. 8192 rather than 500: a `message` reads as a
  // whole sentence where `detail` announces itself as a prefix.
  const long = "z".repeat(20_000);
  assert.equal(normalizeTransport(new Error(long)).message.length, 8192);
  assert.equal(normalizeTransport(err.unavailable(CODES.E_PROVIDER_TRANSPORT, long)).message.length, 8192);
});

// ── the streamed chunk: a provider's own `error` frame ───────────────────────

/** One SSE body, delivered as a single chunk. Offline: no socket, no clock, no key. */
function sseResponse(body: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    }),
    { status: 200 },
  );
}

const REQ: ModelRequest = { model: "claude-opus-5", system: "s", messages: [], tools: [] };

test("A PROVIDER'S `error` FRAME REACHES THE JOURNAL MASKED — the road the early return left open", () => {
  // The end-to-end form of the first test in this section, and the reason it matters: this is
  // the only string in `anthropic.ts` the remote party writes, it is a LoomError by the time
  // `normalizeTransport` sees it, and before the fix it arrived at `errorRecord` verbatim.
  const frame = JSON.stringify({ type: "error", error: { message: `upstream refused ${CRED}` } });
  const adapter = new AnthropicAdapter({
    apiKey: "sk-not-a-real-key",
    fetch: async () => sseResponse(`event: error\ndata: ${frame}\n\n`),
  });

  return assert.rejects(
    async () => {
      for await (const _ of adapter.stream(REQ, ac())) void _;
    },
    (e: unknown) => {
      assert.ok(isLoomError(e));
      assert.deepEqual(errorRecord(e), {
        class: "unavailable",
        code: CODES.E_PROVIDER_TRANSPORT,
        message: `upstream refused ${MASKED}`,
        retryable: true,
      });
      return true;
    },
  );
});

test("a non-200 body reaches the journal masked through the same adapter", async () => {
  const adapter = new AnthropicAdapter({
    apiKey: "sk-not-a-real-key",
    maxAttempts: 1,
    sleep: async () => undefined,
    fetch: async () => new Response(`bad request against ${CRED}`, { status: 400 }),
  });

  await assert.rejects(
    async () => {
      for await (const _ of adapter.stream(REQ, ac())) void _;
    },
    (e: unknown) => {
      assert.ok(isLoomError(e));
      assert.deepEqual(errorRecord(e).details, { status: 400, detail: `bad request against ${MASKED}` });
      return true;
    },
  );
});

// ── a client error does not become true by retrying ──────────────────────────

test("A 4xx IS NOT RETRIED — the classification IS the mechanism, not a second guard", async () => {
  // `request()` retries on `last.retryable` alone, so this counts fetches rather than
  // asserting a flag: the flag is only interesting because of what the loop does with it.
  let calls = 0;
  await assert.rejects(
    () =>
      postJson(
        "https://api.example.com/chat/completions",
        { headers: {}, body: {}, signal: ac() },
        {
          fetch: async () => {
            calls++;
            return new Response("no such endpoint", { status: 404 });
          },
          maxAttempts: 3,
          sleep: async () => undefined,
        },
      ),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_PROVIDER_BAD_REQUEST && !e.retryable,
  );
  assert.equal(calls, 1, "a 404 was re-sent — before this branch existed it was sent three times");
});

test("404 NAMES THE LIKELY CAUSE, because the two adapters' baseUrl conventions differ", () => {
  // Reproduced through `bin/loom`: an `openai` adapter with `baseUrl` missing its `/v1`
  // 404s, and the message it used to give — "unexpected provider status 404" — named
  // nothing the operator could act on. The adapter appends its own path, and which path
  // differs by vendor, so the base that is right for one is wrong for the other.
  const e = normalizeError(404, "no such endpoint");
  assert.match(e.message, /baseUrl/);
  assert.match(e.message, /v1/);
  assert.equal(e.retryable, false);
});

test("408 and 425 keep the retryable class the rest of 4xx loses", () => {
  // The HTTP spec defines exactly these two as safe to repeat. Sweeping them up with the
  // rest would be the same error pointing the other way.
  for (const status of [408, 425]) {
    const e = normalizeError(status, "");
    assert.equal(e.retryable, true, `${status} must stay retryable`);
  }
  for (const status of [404, 405, 410, 413, 415, 451]) {
    const e = normalizeError(status, "");
    assert.equal(e.retryable, false, `${status} must not be retryable`);
    assert.equal(e.code, CODES.E_PROVIDER_BAD_REQUEST, `${status} should classify as a bad request`);
  }
  // And the branches that already existed are untouched.
  assert.equal(normalizeError(429, "").code, CODES.E_PROVIDER_RATE_LIMIT);
  assert.equal(normalizeError(503, "").code, CODES.E_PROVIDER_OVERLOADED);
  assert.equal(normalizeError(401, "").code, CODES.E_PROVIDER_AUTH);
  assert.equal(normalizeError(500, "").code, CODES.E_PROVIDER_OVERLOADED);
  assert.equal(normalizeError(400, "bad json").code, CODES.E_PROVIDER_BAD_REQUEST);
});
