/**
 * What a transport failure is allowed to SAY, and what it is allowed to RE-CLASSIFY.
 *
 * `normalizeTransport` builds the message that a failed provider call carries into the
 * journal, and it built it out of somebody else's `Error.message`. Two facts about that
 * string were wrong at once: a URL with `user:pass@host` in it — undici names the whole URL
 * when it refuses one — put a live credential in a durable record, and an error that had
 * ALREADY been classified came back out re-classified, so `cancelled` became a retryable
 * `unavailable`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, err, isLoomError } from "../../src/errors.ts";
import { normalizeTransport, postJson } from "../../src/providers/http.ts";

const ac = (): AbortSignal => new AbortController().signal;

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
