/**
 * THE KEY CHECK ANCHORED THE SECRET WORD AT THE END AND MISSED MOST CREDENTIAL NAMES.
 *
 * `/^(?:.*_)?(?:password|passwd|secret|token|api[_-]?key|authorization|credential)s?$/i` caught
 * `db_password` and `totp_secret` and missed `x-api-key`, `private_key`, `accessToken`,
 * `clientSecret`, `cookie`, `passphrase` and twenty-five others. Measured at 95a3dde over the
 * table below with a 32-hex value no DETECTOR matches — the shape where this arm is the only
 * thing standing between the value and the reader — 32 of 43 keys leaked verbatim.
 *
 * `walk`'s own comment calls this arm "belt and braces for hand-built payloads", and it runs
 * before the `only` check, so it applies at every classification and on every sink: the operator
 * event stream (`server/http.ts`), the OTLP export (`telemetry/spans.ts`) and the webhook channel
 * (`run/delivery.ts`), which this module itself calls "outside the trust boundary".
 *
 * BOTH LISTS ARE ENUMERATED HERE, which is the point of the test. A later narrowing of
 * `SECRET_WORDS` shows up as a diff on the first table; a later widening that starts shredding
 * ordinary fields shows up on the second. "Ordinary prose is NOT redacted — false positives train
 * people to ignore this" is `redact.test.ts`'s own line, and the second table is that rule for
 * keys.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SecretValue, redact } from "../../src/security/redact.ts";

/** A value no DETECTOR recognises, so the KEY is the only thing that can redact it. */
const OPAQUE = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

const hidden = (key: string): unknown => (redact({ [key]: OPAQUE }, "internal").value as Record<string, unknown>)[key];

/** Every name that must redact. The 32 that leaked at 95a3dde are marked. */
const SECRET_KEYS: readonly string[] = [
  // already covered before this change
  "password",
  "passwd",
  "api_key",
  "apiKey",
  "api-key",
  "authorization",
  "auth_token",
  "client_secret",
  "refresh_token",
  "credentials",
  "db_password",
  "totp_secret",
  // leaked at 95a3dde
  "x-api-key",
  "X-Api-Key",
  "authToken",
  "clientSecret",
  "access-token",
  "accessToken",
  "privateKey",
  "private_key",
  "sessionToken",
  "refreshToken",
  "bearerToken",
  "cookie",
  "Set-Cookie",
  "signingKey",
  "signing_key",
  "secret_key",
  "secretKey",
  "ssh_key",
  "encryption_key",
  "passphrase",
  "pwd",
  "auth",
  "bearer",
  "session_id",
  "sessionId",
  "jwt",
  "otp_code",
  "shared_key",
  "master_key",
  "SECRETS",
  "cookies",
];

/** Every name that must NOT redact. Six of these contain the substring `key`. */
const ORDINARY_KEYS: readonly string[] = [
  "keyboard_layout",
  "key",
  "keys",
  "key_id",
  "keyword",
  "monkey",
  "turkey",
  "publicKey",
  "description",
  "nodeId",
  "runId",
  "path",
  "author",
  "count",
];

for (const key of SECRET_KEYS) {
  test(`a value under "${key}" is redacted whatever the classification says`, () => {
    assert.equal(hidden(key), "[secret]");
  });
}

for (const key of ORDINARY_KEYS) {
  test(`ORDINARY: a value under "${key}" is left alone`, () => {
    assert.equal(hidden(key), OPAQUE);
  });
}

test("the hit list still names the arm that fired, so an alert can count it", () => {
  const r = redact({ private_key: OPAQUE }, "internal");
  assert.ok(r.hits.includes("secretish-key"), JSON.stringify(r.hits));
  assert.deepEqual(redact({ keyword: OPAQUE }, "internal").hits, []);
});

test("a SecretValue under a secret-ish key is still its REF, not `[secret]`", () => {
  // The ref names WHICH secret without disclosing it, and an operator reads it. The narrow rule
  // never met this case because `auth` was not on its list.
  const r = redact({ headers: { auth: new SecretValue("v", "secret://env/K") } }, "internal");
  assert.deepEqual(r.value, { headers: { auth: "secret://env/K" } });
});

test("the rule reaches every depth and both container kinds", () => {
  const r = redact({ a: [{ nested: { "x-api-key": OPAQUE } }] }, "public");
  assert.deepEqual(r.value, { a: [{ nested: { "x-api-key": "[secret]" } }] });
});
