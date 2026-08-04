import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

import {
  SecretValue,
  envSecretProvider,
  isSecret,
  redact,
  redactAttributes,
} from "../../src/security/redact.ts";

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
  assert.match(a, /^pii:[0-9a-f]{12}:string:17$/);
  assert.ok(!a.includes("alice"));
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
  const out = redactAttributes(
    { "user.email": "alice@example.com", "tool.name": "fs.read", "auth.header": "Bearer abcdefghijklmnopqrstuvwxyz1234" },
    { "user.email": "pii" },
  );
  assert.match(String(out["user.email"]), /^pii:/);
  assert.equal(out["tool.name"], "fs.read", "a neighbour keeps its plain value");
  assert.match(String(out["auth.header"]), /\[redacted:bearer\]/);
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
