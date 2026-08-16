import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";

import {
  SecretValue,
  envSecretProvider,
  isSecret,
  redact,
  redactAttributes,
} from "../../src/security/redact.ts";

// ── the deployment key ───────────────────────────────────────────────────────
//
// `redactAttributes` mints no `pii` token at all unless `LOOM_PII_TOKEN_KEY` is set, so
// every test below that wants one names a key. Two keys, because "the same key gives the
// same token" and "a different key gives a different one" are two claims.

const KEY_ENV = "LOOM_PII_TOKEN_KEY";
const KEY_A = "a3".repeat(32);
const KEY_B = "b7".repeat(32);

/** Run `fn` with `LOOM_PII_TOKEN_KEY` set (or unset), and put the environment back. */
function withKey<T>(hex: string | undefined, fn: () => T): T {
  const before = process.env[KEY_ENV];
  if (hex === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = hex;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = before;
  }
}

// ── SecretValue ──────────────────────────────────────────────────────────────

test("a SecretValue cannot be stringified by accident", () => {
  const s = new SecretValue("hunter2", "secret://env/PASSWORD");
  assert.equal(String(s), "[secret]");
  assert.equal(`${s}`, "[secret]");
  assert.equal(`Bearer ${s}`, "Bearer [secret]", "a broken request someone notices, not a leak nobody does");
  assert.equal(JSON.stringify({ token: s }), '{"token":"[secret]"}');
  assert.equal(JSON.stringify(s), '"[secret]"');
});

test("util.inspect shows the ref, never the value", () => {
  const s = new SecretValue("hunter2", "secret://env/PASSWORD");
  const shown = inspect({ creds: s });
  assert.match(shown, /secret:\/\/env\/PASSWORD/);
  assert.ok(!shown.includes("hunter2"));
});

test("reveal() is the only way out, and it is greppable", () => {
  const s = new SecretValue("hunter2", "r");
  assert.equal(s.reveal(), "hunter2");
  assert.equal(isSecret(s), true);
  assert.equal(isSecret("hunter2"), false);
});

test("a SecretValue nested anywhere in a payload redacts to its ref", () => {
  const r = redact({ headers: { auth: new SecretValue("abc", "secret://env/K") } });
  assert.deepEqual(r.value, { headers: { auth: "secret://env/K" } });
  assert.deepEqual(r.hits, ["secret-value"]);
});

// ── declared classification ──────────────────────────────────────────────────

test("pii becomes a STABLE token, so a trace still correlates", () => {
  const a = redact("alice@example.com", "pii").value as string;
  const b = redact("alice@example.com", "pii").value as string;
  const c = redact("bob@example.com", "pii").value as string;

  assert.equal(a, b, "the same value tokenises identically — correlation without disclosure");
  assert.notEqual(a, c);
  assert.match(a, /^pii:[0-9a-f]{12}:string$/);
  assert.ok(!a.includes("alice"));
});

test("THE TOKEN DOES NOT PUBLISH THE VALUE'S LENGTH", () => {
  // It read `pii:<12>:<type>:<len>`. The length was two things at once: a direct
  // disclosure about the value — 17 against 15 tells you which of two colleagues'
  // addresses this is, without inverting anything — and the first filter an attacker
  // applies before enumerating a domain. The type stays because the field NAME already
  // said it; the length said something the field name did not.
  //
  // ASSERT ON THE SEGMENTS, not on whether the digits appear: a random 12-hex digest
  // contains "6" about half the time, so `token.includes(String(len))` is a coin flip
  // dressed as a security property. It failed two runs in five before this was rewritten,
  // which is the honest reason the shape below is the assertion.
  const short = redact("a@b.co", "pii").value as string;
  const long = redact("alice@example.com", "pii").value as string;

  for (const token of [short, long]) {
    const segments = token.split(":");
    assert.equal(segments.length, 3, `${token} carries a fourth segment`);
    assert.deepEqual([segments[0], segments[2]], ["pii", "string"], `${token} says something other than its type`);
    assert.match(segments[1]!, /^[0-9a-f]{12}$/, `${token} is not a bare digest between the two`);
  }
  assert.equal(short.split(":")[2], long.split(":")[2], "…so two values of different length are indistinguishable by shape");
});

test("A CHANNEL HOLDING THE TOKEN CANNOT BRUTE-FORCE THE VALUE BACK OUT OF IT", () => {
  // `piiToken` was an UNSALTED, UNKEYED 48-bit sha256 prefix. For a high-entropy string
  // that is a reasonable tokenisation; for the leaves a graph-declared `redact` actually
  // covers — a number, a boolean, an epoch, an age, an amount, a postcode — the domain is
  // small enough to enumerate, and the construction was public, so the token handed to a
  // channel outside the trust boundary was the value in a thin disguise.
  //
  // The attack, run here exactly as a channel could run it: it knows the algorithm
  // (Kerckhoffs) and the plausible domain, and it does not know the key. Against the old
  // construction this recovered 40404 in 18 ms.
  const value = 40_404;
  const token = redact(value, "pii").value as string;
  const digest = token.split(":")[1]!;

  const attacks: ((n: number) => string)[] = [
    (n) => createHash("sha256").update(String(n), "utf8").digest("hex"),
    (n) => createHash("sha256").update(`number:${n}`, "utf8").digest("hex"),
    (n) => createHash("sha256").update(String(n), "utf8").digest("hex").slice(0, 12),
  ];
  for (let n = 0; n < 100_000; n++) {
    for (const attack of attacks) {
      assert.equal(attack(n).startsWith(digest), false, `the token was inverted: the value is ${n}`);
    }
  }

  // …and the token is still a HANDLE, which is the half that has to keep working: two
  // occurrences of one value correlate, two different values do not collide.
  assert.equal(redact(value, "pii").value, token, "an approver must still see one person, not two");
  assert.notEqual(redact(value + 1, "pii").value, token);
});

test("A TOKEN CORRELATES INSIDE ITS SCOPE AND NOWHERE ELSE", () => {
  // Keying the token defeated the offline brute force above and left a QUERY: `piiToken` is
  // reachable with attacker-chosen input, so one key for the whole process meant anyone who
  // could get their own values tokenised held the table for everybody else's. `scope` is the
  // fix, and the property is symmetric — it has to hold in BOTH directions or it is either
  // an oracle or a lie about who is who.
  const person = "alice@example.com";
  const mine = redact(person, "pii", { scope: "run_a" }).value;
  const theirs = redact(person, "pii", { scope: "run_b" }).value;

  assert.notEqual(mine, theirs, "one scope's token is a lookup entry for another's");
  assert.equal(redact(person, "pii", { scope: "run_a" }).value, mine, "…and inside one scope it is still a handle");
  assert.match(String(mine), /^pii:[0-9a-f]{12}:string$/, "the shape does not change with the scope");

  // The two labels cannot be made to collide by SPELLING one of them. Scopes are not
  // secret — the delivery path names the run id — so a caller that could spell the wider
  // domain could opt back into the shared key on purpose.
  assert.notEqual(redact(person, "pii", { scope: "process" }).value, redact(person, "pii").value);
});

test("an absent scope is the PROCESS, which is a decision about the audience and not a fallback", () => {
  // Pinned so it cannot drift silently in either direction. It is correct only while every
  // reader of an unscoped token is inside the trust boundary — today `http.ts`'s event
  // frame, read by an operator who can fetch the same values in the clear. The moment a
  // token under this default reaches a third party, the caller must name a scope; the
  // gate-delivery path already cannot forget, because `redactFields` requires one.
  const a = redact(1234, "pii").value;
  const b = redact(1234, "pii").value;
  assert.equal(a, b, "an operator reading two events must see one person, not two");
  assert.notEqual(a, redact(1234, "pii", { scope: "run_a" }).value);

  // A non-string scope is not thrown on — the derivation runs under
  // `GateDispatcher.deliver`'s prelude, which is outside every try in a file whose one rule
  // is that delivery has exactly one exit — but it is NOT treated as absent either. See the
  // test below for why that difference is the whole point.
  assert.notEqual(redact(1234, "pii", { scope: 7 as unknown as string }).value, a);
});

test("A SCOPE THAT IS PRESENT AND UNUSABLE DOES NOT FALL BACK TO THE PROCESS-WIDE KEY", () => {
  // The guard read `typeof opts.scope === "string" ? opts.scope : undefined`, and `undefined`
  // is the PROCESS domain — the shared-key oracle `scope` exists to close, reached through a
  // type hole rather than a design one and reached in silence. `redactPayload` mints SSE
  // tokens under that same key, so a caller whose run id arrived corrupt was tokenising a
  // third party's data into the operator stream's domain.
  const person = "alice@example.com";
  const processWide = redact(person, "pii").value;

  for (const bad of [7, {}, null, Symbol("s"), () => "run_a"] as unknown[]) {
    const r = redact(person, "pii", { scope: bad as string });
    assert.notEqual(r.value, processWide, `scope: ${String(typeof bad)} reached the process key`);
    assert.ok(r.hits.includes("unusable-scope"), "…and did so without saying anything");
  }

  // One domain for all of them, which is narrower than the process domain and is the
  // honest answer to "correlate this with what?" — and no string can spell it, because a
  // named scope is always `scope:<name>`.
  assert.equal(redact(person, "pii", { scope: 7 as unknown as string }).value, redact(person, "pii", { scope: {} as string }).value);
  assert.notEqual(redact(person, "pii", { scope: "unusable-scope" }).value, redact(person, "pii", { scope: 7 as unknown as string }).value);
});

test("A FIELD LIST THAT IS NOT A LIST HIDES EVERYTHING, NOT THE LETTERS IT SPELLS", () => {
  // `new Set("ssn")` is `{"s", "n"}`. So an untyped caller writing
  // `redactFields(payload, "ssn", "pii", runId)` hid two fields nobody named and shipped the
  // ssn itself to the channel in the clear — a leak, in the one mode whose reader is a third
  // party, arrived at by a guard that had no idea it had failed.
  const payload = { ssn: 123_456_789, s: "sss", n: "nnn" };
  const out = redact(payload, "pii", { only: "ssn" as unknown as string[], scope: "run_a" }).value as Record<string, unknown>;

  assert.match(String(out["ssn"]), /^pii:/, "the field the caller named is the one that must not survive");
  assert.match(String(out["s"]), /^pii:/, "present-but-unusable reads as `no field list`, which hides everything");
  assert.equal(redact(payload, "pii", { only: "ssn" as unknown as string[] }).hits.includes("unusable-only"), true);
});

test("a value the redactor cannot serialize does not survive it BY REFERENCE", () => {
  // `JSON.stringify` CALLS an own-enumerable `toJSON`. A function copied onto the
  // redacted tree is therefore a payload that rewrites itself after redaction has run —
  // see the delivery suite for the same hole reached through a real channel.
  const smuggled = "oncall@example.com";
  const payload = {
    command: "restart",
    toJSON: () => ({ email: smuggled }),
  };

  for (const as of ["public", "internal", "pii", "secret_ref"] as const) {
    const out = redact(payload, as).value;
    const rendered = JSON.stringify(out);
    assert.equal(rendered.includes(smuggled), false, `${as}: a function rewrote the payload after redaction`);
    if (as !== "secret_ref") {
      assert.equal((out as Record<string, unknown>)["toJSON"], "[function]", `${as}: the key stays, the code does not`);
    }
  }
  assert.deepEqual(redact(payload, "internal").hits, ["unserializable"]);
});

test("a field named `__proto__` survives the walk as a FIELD, not as a prototype", () => {
  // `out[k] = v` is a SETTER for that one key. `JSON.parse` makes `__proto__` an own data
  // property and `frozenClone` is a `JSON.parse`, so this is reachable from any journal
  // payload — and the field silently disappeared from the rendering a human is shown,
  // which is the failure D7.3's field list exists to prevent, arriving from the far side.
  const payload = JSON.parse('{"command":"restart","__proto__":{"email":"oncall@example.com"}}') as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload), ["command", "__proto__"], "the fixture itself has the own key");

  const out = redact(payload, "pii", { only: ["email"] }).value as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), ["command", "__proto__"], "the field vanished from what the approver is shown");
  assert.equal(Object.getPrototypeOf(out), Object.prototype, "the redacted copy wore a foreign prototype");
  assert.match(JSON.stringify(out), /"__proto__":\{"email":"pii:/, "…and the redacted value is on the wire");
});

test("a CYCLE is a marker, not a stack overflow and not 2³² nodes", () => {
  const payload: Record<string, unknown> = { command: "restart" };
  payload["self"] = payload;
  payload["also"] = payload;

  const r = redact(payload, "internal");
  assert.deepEqual(r.value, { command: "restart", self: "[cycle]", also: "[cycle]" });
  assert.deepEqual(r.hits, ["cycle"]);

  // Sibling SHARING is not a cycle and must not be reported as one: two fields pointing
  // at one object are two fields, and an approver reading `[cycle]` there would be misled.
  const shared = { name: "Ada" };
  assert.deepEqual(redact({ a: shared, b: shared }, "internal").value, { a: { name: "Ada" }, b: { name: "Ada" } });
});

test("secret_ref classification redacts wholesale", () => {
  assert.equal(redact({ any: "thing" }, "secret_ref").value, "[secret]");
});

test("public and internal values pass through, minus detector hits", () => {
  assert.equal(redact("ordinary text", "public").value, "ordinary text");
  assert.deepEqual(redact({ n: 1, ok: true }, "internal").value, { n: 1, ok: true });
});

// ── the detector backstop ────────────────────────────────────────────────────

test("known credential shapes are caught in free text", () => {
  const cases: [string, string][] = [
    ["here is sk-abcdefghijklmnopqrstuvwx", "provider-key"],
    ["AKIAIOSFODNN7EXAMPLE", "aws-key"],
    ["ghp_abcdefghijklmnopqrstuvwxyz012345", "github-token"],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456", "bearer"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt"],
  ];
  for (const [text, detector] of cases) {
    const r = redact(text);
    assert.ok(r.hits.includes(detector), `${detector} not caught in: ${text}`);
    assert.match(String(r.value), /\[redacted:/);
  }
});

test("a PEM block is redacted whole, not line by line", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\nAAAA\n-----END RSA PRIVATE KEY-----";
  const r = redact(`key follows:\n${pem}\ndone`);
  assert.equal(r.value, "key follows:\n[redacted:pem]\ndone");
});

test("ordinary prose is NOT redacted — false positives train people to ignore this", () => {
  const text = "The user asked about the sky and we answered. No secrets here at all.";
  const r = redact(text);
  assert.equal(r.value, text);
  assert.deepEqual(r.hits, []);
});

test("detectors are stateless across calls (no /g lastIndex carry-over)", () => {
  const text = "sk-abcdefghijklmnopqrstuvwx";
  for (let i = 0; i < 3; i++) {
    assert.ok(redact(text).hits.includes("provider-key"), `miss on call ${i}`);
  }
});

test("multiple secrets in one string are all redacted", () => {
  const r = redact("first sk-aaaaaaaaaaaaaaaaaaaa then ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.deepEqual([...r.hits].sort(), ["github-token", "provider-key"]);
  assert.ok(!String(r.value).includes("sk-aaaa"));
});

// ── URL userinfo, which is the one entry on that list that is not a guess ─────
//
// The shape a credential most often takes when it reaches free text, and the one the
// sweep did not know: `scheme://user:pass@host`. It got here by the road every entry
// above is for — a string SOMEBODY ELSE wrote, quoting a value this deployment
// configured — and `providers/http.ts` had its own private copy of this redaction for
// exactly that reason. A private copy is how `run/delivery.ts` came to carry a second
// walk that disagreed with this file's about depth and cycles; the answer then was to
// delegate, and it is the answer here.

const URL_MSG =
  "Request cannot be constructed from a URL that includes credentials: https://svc:hunter2@api.example.com/v1/messages";
const URL_MSG_MASKED =
  "Request cannot be constructed from a URL that includes credentials: https://[redacted]@api.example.com/v1/messages";

test("A URL'S USERINFO IS A CREDENTIAL, AND THE SWEEP TAKES IT — the exact bytes, not a boolean", () => {
  // Asserted as WHOLE-STRING EQUALITY rather than `!includes("hunter2")`, because the
  // second passes for a redactor that deleted the message, and half of what this
  // mechanism has to keep is the diagnosis around the credential.
  const r = redact(URL_MSG, "internal");
  assert.equal(r.value, URL_MSG_MASKED);
  assert.deepEqual(r.hits, ["url-credentials"]);
});

test("a userinfo with no password is a credential too", () => {
  const r = redact("connect ECONNREFUSED https://ghp_liveTokenValue@github.example.com/api");
  assert.equal(r.value, "connect ECONNREFUSED https://[redacted]@github.example.com/api");
  assert.deepEqual(r.hits, ["url-credentials"]);
});

test("AN `@` THAT IS NOT USERINFO IS LEFT ALONE — a redactor nobody can read is one nobody keeps", () => {
  // The userinfo run stops at the authority's first `/`, `?`, `#`, whitespace or second
  // `@`, so a path that merely contains an address and a bare `mailto:` are both prose.
  // These three strings are `test/providers/http.test.ts`'s, deliberately: the provider
  // file's private redaction is being replaced by this one, so the thing it promised not
  // to shred has to keep coming out identical here.
  const kept = [
    "socket hang up while POSTing https://api.example.com/v1/mail/a@b.example",
    "no route to host for mailto:ops@example.com",
    "unexpected token @ in body",
  ];
  for (const text of kept) {
    const r = redact(text);
    assert.equal(r.value, text, text);
    assert.deepEqual(r.hits, [], text);
  }
});

test("A CREDENTIAL IN USERINFO IS REPORTED TWICE WHEN IT IS ALSO A SHAPE — the hit list is the alert", () => {
  // ORDER IN `DETECTORS` IS LOAD-BEARING AND THE ONLY OBSERVABLE IT MOVES IS `hits`.
  // `url-credentials` runs LAST, so a provider key sitting in userinfo position is first
  // named by what it IS and only then masked by where it SAT. Running it first produces
  // byte-identical output and one hit instead of two — the same redaction, with the
  // "a live provider key was in this string" signal thrown away.
  const r = redact("POST https://sk-abcdefghijklmnopqrstuvwx@api.example.com/v1 failed");
  assert.equal(r.value, "POST https://[redacted]@api.example.com/v1 failed");
  assert.deepEqual(r.hits, ["provider-key", "url-credentials"]);
});

test("THE MASK REACHES A SPAN ATTRIBUTE AND A GATE DELIVERY, because it is in the one walk", () => {
  // The point of putting this in `DETECTORS` rather than beside a caller: every read
  // boundary in the codebase already runs the sweep, so all of them close at once.
  const attrs = withKey(KEY_A, () => redactAttributes({ "gate.reason": URL_MSG }, {}, "run_a"));
  assert.equal(attrs["gate.reason"], URL_MSG_MASKED);

  // …including the legible path of a field-list redaction, which is what a human approving
  // a gate reads. `only` names a different field, so this leaf takes the sweep.
  const delivered = redact({ requester: "u:alice", note: URL_MSG }, "pii", { only: ["requester"], scope: "run_a" });
  assert.equal((delivered.value as Record<string, unknown>)["note"], URL_MSG_MASKED);
  assert.ok(delivered.hits.includes("url-credentials"));
});

test("SWEEPING TWICE IS BYTE-IDENTICAL TO SWEEPING ONCE — which is what makes two boundaries a design", () => {
  // Redaction is applied at the READ boundary for a classified value and at the WRITE
  // boundary for foreign text (see the module docstring), so a `LoomError.message` masked
  // by `providers/http.ts` on its way into the journal is swept AGAIN on its way out to a
  // span, an SSE frame and a gate delivery. `url-credentials` replaces `scheme://userinfo@`
  // with `scheme://[redacted]@`, which is itself a match — so the property that keeps the
  // two boundaries from disagreeing about a value they both handled correctly is that the
  // replacement is a FIXED POINT. Asserted rather than assumed: a replacement that
  // re-matched to something else would make the second pass corrupt the first pass's work.
  for (const text of [
    URL_MSG,
    "connect ECONNREFUSED https://ghp_liveTokenValue@github.example.com/api",
    "POST https://sk-abcdefghijklmnopqrstuvwx@api.example.com/v1 failed",
    "two at once https://a:b@x.example/p and https://c:d@y.example/q",
  ]) {
    const once = redact(text).value;
    assert.equal(typeof once, "string", text);
    assert.equal(redact(once as string).value, once, `not a fixed point: ${text}`);
  }

  // AND THE SECOND PASS IS SILENT, which is a separate fact worth pinning because it is the
  // one an alert is built on. `sweep` records a hit only when the replacement CHANGED the
  // string, and on an already-masked string it does not — so `hits` keeps meaning "a
  // credential was in free text HERE", and the `url-credentials` alert fires at the boundary
  // that actually let it in rather than once more at every reader it travels past.
  assert.deepEqual(redact(URL_MSG).hits, ["url-credentials"], "the write boundary, where it got in");
  assert.deepEqual(redact(redact(URL_MSG).value as string).hits, [], "and not again at every reader downstream");
});

test("THE SWEEP DOES NOT BOUND ITS OWN INPUT, AND ONE DETECTOR IS QUADRATIC IN IT", () => {
  // THE LIMIT, MADE EXECUTABLE, in the manner of `A Proxy DEFEATS THE SHAPE TEST`: this is
  // not a defect being fixed here, it is a cost being pinned so a caller cannot inherit it
  // by accident. `pem` is the one entry with an unanchored lazy tail —
  // `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END …` — so `[\s\S]*?` scans to the end
  // of the string once per BEGIN that never gets an END. MEASURED through `redact`, with
  // `-----BEGIN A PRIVATE KEY-----` repeated to fill a buffer:
  //
  //     64 KB → 20.8 ms   128 KB → 80.2 ms   256 KB → 306.4 ms
  //    512 KB → 1 157 ms    1 MB → 4 682 ms     2 MB → 18 456 ms
  //
  // Four times the input, sixteen times the time. Every other entry has a literal prefix and
  // a delimiter-terminated or bounded run and is linear: 256 KB of `x://` markers is 0.9 ms,
  // and ONE 256 KB unterminated userinfo run — the worst case for `url-credentials`, the
  // entry a write boundary is usually reaching for — is 0.7 ms. Both asserted below, because
  // "the linear ones are linear" is the half that licenses the callers that do not bound.
  //
  // WHAT THIS MEANS FOR A CALLER: a string a REMOTE PARTY chose must be bounded BEFORE it
  // reaches here. The read-boundary callers sweep values that came out of this deployment's
  // own journal. `providers/http.ts` sweeps a provider's response body, and its `MAX_SWEEP`
  // is that bound — pinned from the other side by *THE SWEEP OVER A PROVIDER BODY IS
  // BOUNDED* in `test/providers/http.test.ts`.
  const n = 256 * 1024;

  // 1. THE FACT THAT MAKES A CALLER'S BOUND NECESSARY: this function truncates nothing.
  const linear = "x://".repeat(n / 4);
  const swept = redact(linear).value;
  assert.equal(typeof swept, "string");
  assert.equal((swept as string).length, linear.length, "the sweep returns what it was given, at any size");

  // 2. THE LINEAR ENTRIES STAY LINEAR. A generous ceiling, not a benchmark: measured at
  // 0.7–0.9 ms, so 4 s only fires if somebody makes `url-credentials` backtrack.
  const userinfo = `x://${"a".repeat(n)}`;
  for (const s of [linear, userinfo]) {
    const t0 = performance.now();
    redact(s);
    assert.ok(performance.now() - t0 < 4_000, "a linear detector went superlinear");
  }

  // 3. THE QUADRATIC ONE, at a size chosen so the test costs ~80 ms rather than seconds.
  // 128 KB measured at 80.2 ms; the ceiling catches a large regression without flaking on a
  // loaded machine, and the numbers above are the record of the actual curve.
  const unit = "-----BEGIN A PRIVATE KEY-----";
  const pem = unit.repeat(Math.floor((128 * 1024) / unit.length));
  const t0 = performance.now();
  const out = redact(pem);
  assert.ok(performance.now() - t0 < 8_000, "the pem detector got dramatically worse");
  // …and every one of those scans found nothing, because no BEGIN ever gets an END.
  assert.equal(out.value, pem);
  assert.deepEqual(out.hits, []);
});

// ── secret-ish keys ──────────────────────────────────────────────────────────

test("a key that NAMES a secret redacts its value regardless of classification", () => {
  const r = redact({ apiKey: "anything", api_key: "x", PASSWORD: "y", authorization: "z", ordinary: "kept" }, "public");
  assert.deepEqual(r.value, {
    apiKey: "[secret]",
    api_key: "[secret]",
    PASSWORD: "[secret]",
    authorization: "[secret]",
    ordinary: "kept",
  });
  assert.ok(r.hits.includes("secretish-key"));
});

test("a hit list is reported, so a leak through the DECLARED path is visible", () => {
  // Detector hits mean classification missed something — that is a signal worth
  // alerting on, not just a redaction.
  const clean = redact({ a: 1 });
  assert.deepEqual(clean.hits, []);
  const dirty = redact({ note: "token sk-abcdefghijklmnopqrstuvwx" });
  assert.deepEqual(dirty.hits, ["provider-key"]);
});

// ── structural safety ────────────────────────────────────────────────────────

test("deeply nested payloads do not blow the stack", () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 200; i++) deep = { nested: deep };
  assert.doesNotThrow(() => redact(deep));
});

test("arrays and mixed structures are walked", () => {
  const r = redact({ list: [{ token: "x" }, "sk-abcdefghijklmnopqrstuvwx"] });
  const value = r.value as { list: [{ token: string }, string] };
  assert.equal(value.list[0].token, "[secret]");
  assert.match(value.list[1], /\[redacted:provider-key\]/);
});

// ── span attributes ──────────────────────────────────────────────────────────

test("span attributes are redacted per-attribute, honouring each classification", () => {
  const out = withKey(KEY_A, () =>
    redactAttributes(
      { "user.email": "alice@example.com", "tool.name": "fs.read", "auth.header": "Bearer abcdefghijklmnopqrstuvwxyz1234" },
      { "user.email": "pii" },
      "run_a",
    ),
  );
  assert.match(String(out["user.email"]), /^pii:/);
  assert.equal(out["tool.name"], "fs.read", "a neighbour keeps its plain value");
  assert.match(String(out["auth.header"]), /\[redacted:bearer\]/);
});

test("span attributes take ONE scope for the whole bag, so two attributes are one person", () => {
  // A trace collector is outside the process the way a delivery channel is, so the scope is
  // a parameter here too. It cannot be per-attribute: two attributes of one span naming one
  // person must read as one person, which is the whole reason a span is a bag.
  const attrs = { "gate.approver": "u:alice", "gate.requester": "u:alice" };
  const scoped = withKey(KEY_A, () => redactAttributes(attrs, { "gate.approver": "pii", "gate.requester": "pii" }, "run_a"));
  assert.equal(scoped["gate.approver"], scoped["gate.requester"], "one span said two people were involved");

  const elsewhere = withKey(KEY_A, () => redactAttributes(attrs, { "gate.approver": "pii" }, "run_b"));
  assert.notEqual(elsewhere["gate.approver"], scoped["gate.approver"], "a whole deployment's traces under one key");
});

test("A pii SPAN ATTRIBUTE IS OMITTED WHEN NO DEPLOYMENT KEY IS SET — never minted under a key nobody can reproduce", () => {
  // The requirement `redactAttributes` has and its two siblings do not: its caller says a
  // trace is a PURE FUNCTION OF THE JOURNAL. A token under the per-process fallback keeps
  // the value secret and breaks that — two workers tracing one run emit attributes nothing
  // can join, and a re-fold years later disagrees with the run it describes. So there is no
  // third option to reach for: with no key there is no token, and the attribute goes.
  const attrs = { "gate.approver": "u:alice", "gate.id": "g_1" };
  const unkeyed = withKey(undefined, () => redactAttributes(attrs, { "gate.approver": "pii" }, "run_a"));

  assert.equal("gate.approver" in unkeyed, false, "a token nobody can reproduce is worse than no attribute");
  assert.equal(unkeyed["gate.id"], "g_1", "…and only the pii attribute goes; the span is still readable");

  // OMITTED AND NOT REPLACED BY A CONSTANT, which is the part a reviewer will want to argue
  // with. A sentinel would make `state.hash.before === state.hash.after` trivially true —
  // manufacturing the claim "this reduce changed nothing" out of "we could not tell you".
  const hashes = withKey(undefined, () =>
    redactAttributes(
      { "state.hash.before": "sha256:aaa", "state.hash.after": "sha256:bbb" },
      { "state.hash.before": "pii", "state.hash.after": "pii" },
      "run_a",
    ),
  );
  assert.deepEqual(hashes, {}, "two different hashes must never come out as one equal pair");
});

test("THE SAME JOURNAL AND THE SAME KEY GIVE THE SAME TOKEN; A ROTATED KEY GIVES A DIFFERENT ONE", () => {
  const attrs = { "gate.approver": "u:alice" };
  const classes = { "gate.approver": "pii" } as const;
  const first = withKey(KEY_A, () => redactAttributes(attrs, classes, "run_a"));
  const again = withKey(KEY_A, () => redactAttributes(attrs, classes, "run_a"));
  const rotated = withKey(KEY_B, () => redactAttributes(attrs, classes, "run_a"));

  assert.match(String(first["gate.approver"]), /^pii:[0-9a-f]{12}:string$/);
  assert.equal(again["gate.approver"], first["gate.approver"], "the token is a function of the key, not of the process");
  assert.notEqual(rotated["gate.approver"], first["gate.approver"], "rotating the key IS breaking correlation; that is what it means");

  // And the deployment key is a ROOT, not the token key: scopes still separate under it.
  assert.notEqual(
    withKey(KEY_A, () => redactAttributes(attrs, classes, "run_b"))["gate.approver"],
    first["gate.approver"],
  );
});

test("A SPAN BAG'S SCOPE CANNOT BE OMITTED, AND AN UNUSABLE ONE COSTS EVERY pii ATTRIBUTE", async () => {
  // `scope` USED TO BE OPTIONAL, and omitting it minted tokens under `tokenKey`'s process
  // label. That was survivable while the root was `randomBytes(32)` per process; the
  // deployment key made the same omission permanent and deployment-wide, so an unscoped
  // token became a cross-run, cross-tenant, forever-stable correlation domain — precisely
  // the oracle `scope` exists to close, reached by leaving an argument out. Reproduced with
  // one deployment key, in two separate processes:
  //
  //   scope=run_a    pii:4bf49099d342:string
  //   scope=run_b    pii:4bcfee10acf3:string
  //   scope omitted  pii:167f42d19528:string   ← the same bytes in both processes
  //
  // The argument for leaving it optional was `tokenKey`'s own docstring, which asserted
  // that `redactAttributes` "names one too" — true of its single caller, and never true of
  // the function. It is now a compile error, and the line below is what pins that: this
  // `@ts-expect-error` FAILS THE TYPECHECK the day the parameter goes back to optional.
  const attrs = { "gate.approver": "u:alice", "gate.id": "g_1" };
  const classes = { "gate.approver": "pii" } as const;
  await new Promise((resolve) => setImmediate(resolve));
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  const warned: string[] = [];
  const capture = (w: Error): void => void warned.push(w.message);
  process.on("warning", capture);
  try {
    // @ts-expect-error — the scope is REQUIRED; omitting it must not compile.
    const omitted = withKey(KEY_A, () => redactAttributes(attrs, classes));

    assert.equal("gate.approver" in omitted, false, "an omitted scope minted a deployment-wide token");
    assert.equal(omitted["gate.id"], "g_1", "…and only the pii attribute goes; the span is still readable");

    // Every shape a JS caller can reach the same way. `""` is in the list because it is a
    // string and would otherwise be a scope label of its own that no run can spell.
    for (const bad of [undefined, "", 7, {}, null, Symbol("s")] as unknown[]) {
      const out = withKey(KEY_A, () => redactAttributes(attrs, classes, bad as string));
      assert.equal("gate.approver" in out, false, `scope ${String(typeof bad)} minted a token anyway`);
      assert.equal(out["gate.id"], "g_1");
    }

    // OMITTED, NOT MINTED UNDER A NARROWER LABEL, which is where this differs from `redact`
    // and `redactFields`: those must still deliver a gate, so an unusable scope gets a
    // domain of its own. Nothing has to be delivered here — a trace losing an attribute is
    // invariant 8 working as designed, and the alternative is a token whose correlation
    // domain the caller did not choose.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warned.length, 1, "a caller bug that silently costs attributes must say so, once");
    assert.match(warned[0]!, /scope/i);
  } finally {
    process.off("warning", capture);
    for (const l of listeners) process.on("warning", l as (w: Error) => void);
  }
});

test("THE MALFORMED-KEY WARNING IS ONCE PER DISTINCT VALUE, which is what its docstring says", async () => {
  // The memo was a single LAST-SEEN SLOT, so two malformed values alternating re-warned
  // forever while the docstring claimed "once per distinct value". Measured before the fix:
  // 8 calls over 2 distinct values → 6 warnings. A warning that repeats is one an operator
  // filters out, which is how the signal this arm exists to send gets lost.
  const A = `nothexA${"0".repeat(57)}`;
  const B = `nothexB${"0".repeat(57)}`;
  await new Promise((resolve) => setImmediate(resolve));
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  const warned: string[] = [];
  const capture = (w: Error): void => void warned.push(w.message);
  process.on("warning", capture);
  try {
    for (const raw of [A, A, A, B, A, B, A, B]) {
      withKey(raw, () => redactAttributes({ "gate.approver": "u:alice" }, { "gate.approver": "pii" }, "run_a"));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warned.length, 2, "one warning per distinct malformed value, however often they alternate");
  } finally {
    process.off("warning", capture);
    for (const l of listeners) process.on("warning", l as (w: Error) => void);
  }
});

test("AN INHERITED NAME IS NOT A CLASSIFICATION, AND A VALUE THAT IS NOT ONE IS TREATED AS A SECRET", () => {
  // `classifications[k] ?? "internal"` answers `constructor` with a FUNCTION on an ordinary
  // object literal — the fail-open `gateIn` was written against — and it took any value at
  // all as a classification, which `walk`'s `=== "pii"` comparisons then quietly read as
  // `internal`. An own property that is not one of the four is a caller error, and the safe
  // reading of "somebody meant to protect this" is the most protective and most visible one.
  const out = withKey(KEY_A, () =>
    redactAttributes({ constructor: "sha256:abc", toString: "x", weird: "u:alice" }, { weird: "PII" as unknown as "pii" }, "run_a"),
  );
  assert.equal(out["constructor"], "sha256:abc", "an inherited name takes the documented default, `internal`");
  assert.equal(out["toString"], "x");
  assert.equal(out["weird"], "[secret]", "a classification that is not one must not read as `internal`");

  // Total in its first argument too: `SpanLink.attributes` and `SpanEvent.attributes` are
  // both optional, and `Object.entries(null)` throws.
  assert.deepEqual(redactAttributes(null as unknown as Record<string, unknown>, {}, "run_a"), {});

  // …and in its SECOND, by the same argument and in the same direction as the arm above:
  // a classification map that is not a map is a caller error, and the protective reading
  // of "somebody meant to classify these" is the visible one.
  const noMap = withKey(KEY_A, () =>
    redactAttributes({ "gate.id": "g_1" }, null as unknown as Record<string, "pii">, "run_a"),
  );
  assert.deepEqual(noMap, { "gate.id": "[secret]" }, "an unreadable classification map must not read as `internal`");
});

test("A MALFORMED DEPLOYMENT KEY IS REFUSED AND SAID SO, NOT QUIETLY USED", async () => {
  // The two failure modes are different mistakes. Absent is "I did not ask for this";
  // malformed is "I asked and mistyped", and answering it with silence is the fail-open
  // shape this wave exists to close. Throwing is not available — the first `pii` leaf is met
  // in `GateDispatcher.deliver`'s prelude, so a throw is a gate nobody hears about — so it
  // warns once and is then treated as absent, which the missing attribute makes visible.
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  const warned: string[] = [];
  const capture = (w: Error): void => void warned.push(w.message);
  process.on("warning", capture);
  try {
    const out = withKey(`nothex${"0".repeat(58)}`, () => redactAttributes({ "gate.approver": "u:alice" }, { "gate.approver": "pii" }, "run_a"));
    assert.equal("gate.approver" in out, false, "a key nobody can parse must not read as a key");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warned.length, 1, "…once, not once per attribute");
    assert.match(warned[0]!, /LOOM_PII_TOKEN_KEY.*64 hex/s);
  } finally {
    process.off("warning", capture);
    for (const l of listeners) process.on("warning", l as (w: Error) => void);
  }
});

test("AN ATTRIBUTE NAMED `__proto__` SURVIVES AS A FIELD — the fix this file already wrote, applied where it was not", () => {
  // `put` exists in this module BECAUSE `out[k] = v` is not a property write for that one
  // key: it invokes the accessor `Object.prototype` defines, which sets the object's
  // PROTOTYPE when `v` is an object and silently DISCARDS the write when it is not.
  // `walk` was taught that and `redactAttributes` — written later, in the same file — was
  // not, so a span attribute named `__proto__` left the process as a prototype or as
  // nothing at all. `JSON.parse` makes it an own data property, which is how any bag read
  // back from a collector or a file reaches here.
  const objectValued = JSON.parse('{"__proto__":{"email":"oncall@example.com"},"ok":"kept"}') as Record<string, unknown>;
  assert.deepEqual(Object.keys(objectValued), ["__proto__", "ok"], "the fixture itself has the own key");

  const out = withKey(KEY_A, () => redactAttributes(objectValued, {}, "run_a"));
  assert.deepEqual(Object.keys(out), ["__proto__", "ok"], "the attribute vanished from the bag that leaves the process");
  assert.equal(Object.getPrototypeOf(out), Object.prototype, "the redacted bag wore a foreign prototype");
  assert.deepEqual(out["__proto__"], { email: "oncall@example.com" });

  // The scalar half is the quieter one: the write is discarded outright, so the attribute
  // is simply gone and the prototype is untouched — no symptom at all.
  const stringValued = JSON.parse('{"__proto__":"note: sk-abcdefghijklmnopqrstuvwx"}') as Record<string, unknown>;
  const swept = withKey(KEY_A, () => redactAttributes(stringValued, {}, "run_a"));
  assert.match(String(swept["__proto__"]), /\[redacted:provider-key\]/, "…and it is still redacted on its way through");

  // A CLASSIFIED one too, because the classification is looked up by the same key: an
  // own `__proto__` entry in the map is not an inherited name.
  const classified = JSON.parse('{"__proto__":"u:alice"}') as Record<string, unknown>;
  const classes = JSON.parse('{"__proto__":"pii"}') as Record<string, "pii">;
  const tokenised = withKey(KEY_A, () => redactAttributes(classified, classes, "run_a"));
  assert.match(String(tokenised["__proto__"]), /^pii:[0-9a-f]{12}:string$/);
});

test("A CLASSIFICATION MAP THAT IS A `Map`, AN ARRAY OR A `Date` IS NOT A MAP — and `typeof x === \"object\"` cannot tell", () => {
  // `classifications === null || typeof classifications !== "object"` was written to make
  // an unreadable map read as `secret_ref` rather than as an empty one — the protective
  // direction, and the right one. It admits every exotic object JavaScript has:
  // `typeof new Map() === "object"`, and so are an array, a `Date` and a `RegExp`. None of
  // them answers `hasOwnProperty` for an attribute NAME — a `Map` keeps its entries in
  // internal slots — so every key fell through to the documented default `internal`, and
  // `internal` is the arm that RETURNS THE VALUE.
  //
  // Measured before the fix, one deployment key, scope `run_a`:
  //   redactAttributes({"gate.approver":"u:alice"}, new Map([["gate.approver","pii"]]), "run_a")
  //     ⇒ { "gate.approver": "u:alice" }        ← the person, in the clear, on a span
  // which is the exact disclosure `ATTRIBUTE_CLASSES` exists to prevent, reached by handing
  // the classification map over in the wrong container.
  const attrs = { "gate.approver": "u:alice" };
  for (const notAMap of [
    new Map([["gate.approver", "pii"]]),
    [["gate.approver", "pii"]],
    new Date(0),
    /pii/,
    new Set(["gate.approver"]),
  ] as unknown[]) {
    const out = withKey(KEY_A, () => redactAttributes(attrs, notAMap as Record<string, "pii">, "run_a"));
    assert.equal(out["gate.approver"], "[secret]", `a ${(notAMap as object).constructor.name} map read as "nothing here is sensitive"`);
  }

  // A CLASS INSTANCE IS REFUSED BY THE SAME RULE, and it is the fail-closed direction: its
  // own properties would have read fine, and the cost of refusing one is a loud `[secret]`
  // where the cost of admitting one is a person's id on a span.
  class Classes {
    "gate.approver" = "pii" as const;
  }
  assert.equal(
    withKey(KEY_A, () => redactAttributes(attrs, new Classes() as unknown as Record<string, "pii">, "run_a"))["gate.approver"],
    "[secret]",
  );

  // …AND A NULL-PROTOTYPE RECORD IS A MAP, which is not a corner: `ATTRIBUTE_CLASSES` in
  // `telemetry/spans.ts` is `Object.create(null)`-based on purpose, so a shape test written
  // as `getPrototypeOf(m) === Object.prototype` alone would turn every span attribute in
  // every trace into `[secret]`.
  const real = Object.assign(Object.create(null) as Record<string, "pii">, { "gate.approver": "pii" as const });
  assert.match(
    String(withKey(KEY_A, () => redactAttributes(attrs, real, "run_a"))["gate.approver"]),
    /^pii:[0-9a-f]{12}:string$/,
    "the one shape the real caller uses must still be a map",
  );
});

test("A `Proxy` DEFEATS THE SHAPE TEST AND THE DISCLOSURE IS REAL — the limit, made executable", () => {
  // THIS TEST PASSES TODAY AND IS HERE SO THE LIMIT CANNOT BE NARROWED SILENTLY, which is
  // the shape `EVERY VALID CREDENTIAL IS A FULL OPERATOR CREDENTIAL` uses one layer up.
  //
  // `isClassificationMap` is on its third spelling — `typeof m !== "object"`, then prototype
  // identity, then prototype identity plus `Array.isArray`, the last two chosen over
  // `Object.prototype.toString` because the tag form reads a caller-supplied
  // `Symbol.toStringTag` getter. Every step of that reasoning is correct and the result is
  // forged in one line, because `getPrototypeOf` is a `Proxy` trap too. Measured, one
  // deployment key, scope `run_a`:
  //
  //   const liar = new Proxy(new Map([["gate.approver","pii"]]),
  //                          { getPrototypeOf: () => Object.prototype });
  //   redactAttributes({"gate.approver":"u:alice"}, liar, "run_a")  ⇒  {"gate.approver":"u:alice"}
  //
  // — the person, in the clear, on a span bound for a third-party collector: verbatim the
  // disclosure the bare `Map` case above closes, one shape over.
  //
  // NO FOURTH ITERATION IS WORTH WRITING, and that is a theorem rather than fatigue. A
  // `Proxy` must tell the truth about exactly one thing an inspector can ask — the
  // extensibility of its target — and every ordinary object literal, including the one
  // real caller's, is extensible. So "is this a plain bag?" has no reliable answer here,
  // and a test that requires non-extensibility would turn every embedder's map into
  // `[secret]`. What closes the hole for the caller that matters is not this predicate: it
  // is that `telemetry/spans.ts` passes `ATTRIBUTE_CLASSES`, a module constant.
  const liar = <T extends object>(target: T): Record<string, "pii"> =>
    new Proxy(target, { getPrototypeOf: () => Object.prototype }) as unknown as Record<string, "pii">;

  const attrs = { "gate.approver": "u:alice" };
  for (const target of [new Map([["gate.approver", "pii"]]), new Date(0), /pii/, new Set(["gate.approver"])] as object[]) {
    assert.equal(
      withKey(KEY_A, () => redactAttributes(attrs, liar(target), "run_a"))["gate.approver"],
      "u:alice",
      `a Proxy over a ${target.constructor.name} is STILL admitted — if this line fails, the limit moved and this test is the place to say how`,
    );
  }

  // AND THE DIRECTION IT FAILS IN IS THE ONE THAT MATTERS FOR THE OTHER ARGUMENT: a forged
  // map can only ever make a value LESS protected, never more, and the bare-container cases
  // one test up are still refused. Both halves are the same rule — `classifications`' wrong
  // shapes disclose, so the predicate stays; `attrs`' wrong shapes remove, so it needs none.
  assert.equal(
    withKey(KEY_A, () => redactAttributes(attrs, new Map([["gate.approver", "pii"]]) as unknown as Record<string, "pii">, "run_a"))[
      "gate.approver"
    ],
    "[secret]",
    "the shapes the predicate CAN name are still refused",
  );
});

test("A CLASSIFICATION MAP THAT THROWS COSTS ONE ATTRIBUTE, NOT EVERY SPAN IN THE RUN", () => {
  // `isClassificationMap` is documented as "the totality half as well", on the grounds that
  // `hasOwnProperty.call(null, k)` throws. It is total in `null` and in nothing else: both
  // reads under it are property accesses on a caller's value, and a `Proxy` trap is a CALL.
  // Reproduced, one deployment key, scope `run_a` — each escaped `redactAttributes`, and its
  // one in-repo caller is `close` in `telemetry/spans.ts`, so the cost is EVERY span for the
  // run and, for `loom trace`, the process:
  //
  //   getOwnPropertyDescriptor trap throws  ⇒  Error: gopd trap
  //   get trap throws                       ⇒  Error: get trap
  //
  // A read that threw is not a key that is absent, so the answer is the protective one the
  // rest of this function already gives a map it cannot use — `secret_ref`, which is visible
  // — and not the documented default `internal`, which returns the value.
  const proto = { getPrototypeOf: () => Object.prototype };
  const gopd = new Proxy({}, { ...proto, getOwnPropertyDescriptor(): never { throw new Error("gopd trap"); } });
  const get = new Proxy({ "gate.approver": "pii" }, { ...proto, get(): never { throw new Error("get trap"); } });

  for (const [what, m] of [["a hasOwnProperty trap", gopd], ["a get trap", get]] as const) {
    const out = withKey(KEY_A, () => redactAttributes({ "gate.approver": "u:alice", other: "kept" }, m as unknown as Record<string, "pii">, "run_a"));
    assert.equal(out["gate.approver"], "[secret]", `${what}: the throw escaped instead of being a refusal`);
  }

  // PER KEY, and the two traps differ there in a way worth pinning rather than flattening.
  // The `hasOwnProperty` trap fires for every key, so every attribute is refused; the `get`
  // trap fires only for keys the TARGET has, so `other` is genuinely absent from the map and
  // takes the documented default `internal` — swept as free text, not tokenised, not hidden.
  // That is the arm behaving correctly, and the refusal is scoped to what actually broke.
  assert.equal(withKey(KEY_A, () => redactAttributes({ other: "kept" }, gopd as unknown as Record<string, "pii">, "run_a"))["other"], "[secret]");
  assert.equal(withKey(KEY_A, () => redactAttributes({ other: "kept" }, get as unknown as Record<string, "pii">, "run_a"))["other"], "kept");
});

test("AN ATTRIBUTE BAG THAT THROWS ON ENUMERATION REMOVES EVERYTHING, which is this argument's licence", () => {
  // The asymmetry this file states — `attrs`' wrong shapes only ever REMOVE, so it may be
  // guarded loosely — was true of every shape `Object.entries` can enumerate and false of
  // the ones it cannot. `attrs === null || typeof attrs !== "object"` admits a `Proxy`, and
  // `Object.entries` invokes `ownKeys`, `getOwnPropertyDescriptor` and `get`. Reproduced:
  //
  //   ownKeys trap throws  ⇒  Error: ownKeys trap        (out of `redactAttributes`)
  //   get trap throws      ⇒  Error: attrs get trap
  //
  // A throw is not "removes"; it is the whole trace, which is the one outcome the loose
  // guard was licensed by. `{}` restores the licence: nothing is emitted, nothing leaks, and
  // invariant 8 says telemetry may drop data.
  const ownKeys = new Proxy({ a: 1 }, { ownKeys(): never { throw new Error("ownKeys trap"); } });
  const get = new Proxy({ a: 1 }, { get(): never { throw new Error("attrs get trap"); } });
  for (const [what, bag] of [["an ownKeys trap", ownKeys], ["a get trap", get]] as const) {
    assert.deepEqual(
      withKey(KEY_A, () => redactAttributes(bag as Record<string, unknown>, {}, "run_a")),
      {},
      `${what}: the throw escaped instead of costing the bag`,
    );
  }

  // A `Proxy` THAT ANSWERS IS REDACTED LIKE ANY OTHER BAG, so this is a totality fix and not
  // a new refusal: nothing that can be enumerated stops being enumerated.
  const answering = new Proxy({ "gate.approver": "u:alice" }, {}) as Record<string, unknown>;
  assert.match(
    String(withKey(KEY_A, () => redactAttributes(answering, { "gate.approver": "pii" }, "run_a"))["gate.approver"]),
    /^pii:[0-9a-f]{12}:string$/,
  );
});

test("A CLASSIFICATION MAP WHOSE PROTOTYPE READ THROWS IS REFUSED, NOT PROPAGATED — the third call, outside the try", () => {
  // THE SIBLING THE TEST ABOVE HAD TO BUILD IN ORDER TO REACH ITS OWN SUBJECT. `A
  // CLASSIFICATION MAP THAT THROWS COSTS ONE ATTRIBUTE` pins `hasOwnProperty` and the index
  // read, and it constructs both of its proxies with `getPrototypeOf: () => Object.prototype`
  // — a well-behaved third trap, spelled out in its setup, because that is what it takes to
  // get PAST `isClassificationMap` and into the `try` those two reads live in. The trap it
  // had to neutralise was the one nothing guarded: the shape test sat one line ABOVE the
  // `try`, under a docstring whose own last paragraph says `getPrototypeOf` is a call on a
  // `Proxy`. Measured against that arrangement, one deployment key, scope `run_a`:
  //
  //   redactAttributes({"gate.approver":"u:alice"}, <getPrototypeOf trap>, "run_a")
  //     ⇒ Error: gpo trap, escaping redactAttributes and therefore spansFrom
  //
  // Cost: every span for the run, and for `loom trace` the process — the identical cost the
  // other two reads were fixed for, through the read that was checking whether they were
  // safe to make.
  const gpo = new Proxy({ "gate.approver": "pii" }, { getPrototypeOf(): never { throw new Error("gpo trap"); } });
  const out = withKey(KEY_A, () => redactAttributes({ "gate.approver": "u:alice", other: "kept" }, gpo as unknown as Record<string, "pii">, "run_a"));
  assert.equal(out["gate.approver"], "[secret]", "the prototype trap's throw escaped instead of being a refusal");
  assert.equal(out["other"], "[secret]", "a map that will not say what it is says nothing about any key");

  // `secret_ref` AND NOT `internal`, which is the direction half of the property: a read that
  // threw is not a key that is absent, and `internal` is the arm that returns the value. A
  // catch answering `internal` here would put `u:alice` on a span bound for a collector — the
  // same disclosure `isClassificationMap` was written for, reached from inside the guard.
  assert.notEqual(out["gate.approver"], "u:alice");

  // AND THE PREDICATE'S KNOWN LIMIT IS UNCHANGED BY THIS, because "cannot throw" and "can
  // decide" are two properties and only the first was reachable. A `Proxy` that answers the
  // prototype read honestly-looking still gets through — see *A `Proxy` DEFEATS THE SHAPE TEST
  // AND THE DISCLOSURE IS REAL*, which must keep passing after this change.
  const liar = new Proxy(new Map([["gate.approver", "pii"]]), { getPrototypeOf: () => Object.prototype });
  assert.equal(
    withKey(KEY_A, () => redactAttributes({ "gate.approver": "u:alice" }, liar as unknown as Record<string, "pii">, "run_a"))["gate.approver"],
    "u:alice",
    "the limit narrowed silently; the totality fix was supposed to leave it exactly where it was",
  );
});

test("A VALUE INSIDE THE BAG THAT THROWS COSTS ONE ATTRIBUTE — the same hazard as enumeration, one level down", () => {
  // `Object.entries(attrs)` was wrapped in a `try` and the `redact(v, …)` beneath it was not,
  // so the shape that guard exists for cost the whole bag at depth 0 and the whole RUN at
  // depth 1. `walk` runs `Object.entries` again on every nested container and `v.map` on every
  // nested array, and at depth 1 the counterexample needs no `Proxy` at all — an ordinary
  // object literal with a throwing getter is enough, which is what makes this the reachable
  // half. Measured, one deployment key, scope `run_a`, each escaping `redactAttributes`:
  //
  //   {payload: {get x() { throw new Error("nested getter") }}}   ⇒ Error: nested getter
  //   {payload: new Proxy({}, {ownKeys() { throw … }})}           ⇒ Error: nested ownKeys
  //   {payload: new Proxy([1], {get() { throw … }})}              ⇒ Error: nested array get
  //
  // BUILT WITHOUT A SPREAD, and that is not a stylistic choice: `{"run.id": "r1", ...hostile}`
  // invokes the getter at construction, so the first draft of this test threw in its own
  // setup and never reached the subject. Worth knowing before writing another one.
  const bags: readonly (readonly [string, unknown])[] = [
    ["a plain object with a throwing getter", { get bad(): never { throw new Error("nested getter"); } }],
    ["a nested ownKeys trap", new Proxy({}, { ownKeys(): never { throw new Error("nested ownKeys"); } })],
    ["a nested array behind a get trap", new Proxy([1], { get(): never { throw new Error("nested array get"); } })],
    ["a throwing getter two levels down", { deeper: { get boom(): never { throw new Error("depth 2"); } } }],
  ];
  for (const [what, bad] of bags) {
    const out = withKey(KEY_A, () => redactAttributes({ "run.id": "r1", bad }, {}, "run_a"));
    // ONE ATTRIBUTE, not the bag: the finer verdict the enumeration catch cannot give and
    // this one can. Its neighbour is still on the span, which is the whole difference between
    // "telemetry dropped data" and "the trace does not exist".
    assert.equal(out["run.id"], "r1", `${what}: the throw escaped and took every span in the run with it`);
    assert.equal(Object.hasOwn(out, "bad"), false, `${what}: an attribute that could not be walked must not be emitted`);
  }

  // THE LIMIT, STATED EXECUTABLY: this is a property of `redactAttributes` and NOT of
  // `redact`. `walk` is unchanged, so the same value still throws out of the exported
  // function — which is what `redactPayload` and `redactFields` call. Pinned so that a later
  // wave reading "both arguments are total" cannot take it for a claim about the module.
  assert.throws(
    () => redact({ deeper: { get boom(): never { throw new Error("depth 2"); } } }, "internal"),
    /depth 2/,
    "`redact` became total by accident; then this test is the wrong shape and the docstrings are stale",
  );
});

// ── provider ─────────────────────────────────────────────────────────────────

test("the env provider returns a SecretValue, never a string", () => {
  const p = envSecretProvider({ MY_TOKEN: "abc123" });
  const s = p.resolve("secret://env/MY_TOKEN");
  assert.ok(isSecret(s));
  assert.equal(s.reveal(), "abc123");
  assert.equal(String(s), "[secret]");
});

test("a missing secret fails loudly rather than yielding empty", () => {
  const p = envSecretProvider({});
  assert.throws(() => p.resolve("secret://env/NOPE"), /is not set/);
});
