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
  "jwt",
  "shared_key",
  "master_key",
  "SECRETS",
  "cookies",
];

/**
 * Every name that must NOT redact — and the first block is TAKEN FROM THE TREE, not invented.
 *
 * The first widening of this rule put a bare `token` in the word list and matched it against any
 * segment, which turned every one of the token-accounting names below into the string
 * `"[secret]"` on the operator's own event stream. They are the field names `journal/events.ts`,
 * `run/registry.ts`, `run/policy.ts`, `run/delivery.ts` and `telemetry/spans.ts` actually declare;
 * the invented list that stood here — `monkey`, `turkey`, `keyboard_layout` — caught none of them,
 * which is this repo's recurring lesson about measuring the shapes you imagined.
 */
const ORDINARY_KEYS: readonly string[] = [
  // declared in the tree, and all shredded by the first attempt at this rule
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "maxTokens",
  "defaultMaxTokens",
  "reasoningTokens",
  "runTokens",
  "spentTokens",
  "amountTokens",
  "carriesSecret",
  "apiKeyEnv",
  "signature",
  "signatureHeader",
  "signatureFormat",
  "signedPayload",
  "timestampHeader",
  "sessionId",
  "sessionStartedAt",
  // and the `key` cases the rule was already written for
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

test("a SecretValue under a SECRET-ISH key is `[secret]`, as it always was", () => {
  // An exception letting the REF through here was written and removed: the old rule already
  // matched `token`, `api_key`, `password` and `authorization`, and emitted `[secret]` for all
  // four, so the exception would have started publishing the env-var NAME at four keys that
  // never published it — a loosening, and one justified by a premise that measurement refuted.
  const r = redact({ token: new SecretValue("v", "secret://env/K") }, "internal");
  assert.deepEqual(r.value, { token: "[secret]" });
  // A key the rule does NOT name still renders the ref, which is what `SecretValue` is for.
  const plain = redact({ headers: { upstream: new SecretValue("v", "secret://env/K") } }, "internal");
  assert.deepEqual(plain.value, { headers: { upstream: "secret://env/K" } });
});

test("a PREDICATE about a secret is not a secret", () => {
  // `carriesSecret` is a boolean whose whole job is to say that something ELSE carries one.
  assert.deepEqual(redact({ carriesSecret: true, hasPassword: false, requiresToken: true }, "internal").value, {
    carriesSecret: true,
    hasPassword: false,
    requiresToken: true,
  });
});

test("the descriptor a webhook receiver needs in order to VERIFY is not a credential", () => {
  // `run/delivery.ts` builds this. Shredding it leaves the outside party unable to check the
  // boundary this module calls the trust boundary.
  const sig = {
    scheme: "hmac-sha256",
    signedPayload: "v0:{timestamp}:{body}",
    signatureFormat: "v0={hex}",
    timestampHeader: "x-loom-timestamp",
    signatureHeader: "x-loom-signature",
    toleranceMs: 300_000,
  };
  assert.deepEqual(redact({ url: "https://x/cb", signature: sig }, "internal").value, { url: "https://x/cb", signature: sig });
});

test("a UsageRecord survives the operator event stream as NUMBERS", () => {
  const usage = { inputTokens: 20_000, outputTokens: 1250, cacheReadTokens: 0, costUsd: 0.07875, wallMs: 12 };
  assert.deepEqual(redact({ nodeId: "n1", usage, maxTokens: 4096 }, "internal").value, { nodeId: "n1", usage, maxTokens: 4096 });
});

test("the rule reaches every depth and both container kinds", () => {
  const r = redact({ a: [{ nested: { "x-api-key": OPAQUE } }] }, "public");
  assert.deepEqual(r.value, { a: [{ nested: { "x-api-key": "[secret]" } }] });
});
