/**
 * otel-context — unit tests for the trace-context propagation library (RW7c-2):
 * the `traceparent` format, the `isTrustedHost` allowlist gate (the load-bearing
 * safety check), `propagateAllowlist` parsing, and the set/get/clear channel.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  clearTraceparent,
  getTraceparent,
  isTrustedHost,
  propagateAllowlist,
  setTraceparent,
  traceparent,
} from "../src/extensions/lib/otel-context.js";

const PREV = process.env.EAGENT_OTEL_PROPAGATE_HOSTS;
afterEach(() => {
  if (PREV === undefined) delete process.env.EAGENT_OTEL_PROPAGATE_HOSTS;
  else process.env.EAGENT_OTEL_PROPAGATE_HOSTS = PREV;
});

test("traceparent formats a W3C header (version 00, 32-hex trace, 16-hex span, sampled)", () => {
  const tp = traceparent("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331");
  assert.equal(tp, "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  assert.match(tp, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test("isTrustedHost: empty allowlist never trusts (fail-closed default)", () => {
  assert.equal(isTrustedHost("https://api.example.com/x", []), false);
});

test("isTrustedHost: exact hostname match (case-insensitive), path/port ignored", () => {
  assert.equal(isTrustedHost("https://api.example.com/v1/spans", ["api.example.com"]), true);
  assert.equal(isTrustedHost("https://API.Example.com:8443/x", ["api.example.com"]), true);
  assert.equal(isTrustedHost("https://api.example.com/x", ["API.Example.com"]), true, "a mixed-case allowlist entry still matches");
  assert.equal(isTrustedHost("https://evil.example.com/x", ["api.example.com"]), false);
});

test("isTrustedHost: leading-dot entry matches the domain and its subdomains", () => {
  assert.equal(isTrustedHost("https://api.example.com/x", [".example.com"]), true);
  assert.equal(isTrustedHost("https://example.com/x", [".example.com"]), true);
  assert.equal(isTrustedHost("https://example.com.evil.net/x", [".example.com"]), false);
});

test("isTrustedHost: a malformed URL is never trusted (fail-closed)", () => {
  assert.equal(isTrustedHost("not a url", ["example.com"]), false);
});

test("propagateAllowlist parses the comma-separated value, trims, lowercases, drops blanks", () => {
  assert.deepEqual(propagateAllowlist(""), []);
  assert.deepEqual(propagateAllowlist(" API.Example.com , ,mcp.internal "), ["api.example.com", "mcp.internal"]);
});

test("set/get/clear is a per-callId channel", () => {
  assert.equal(getTraceparent("c1"), undefined);
  setTraceparent("c1", "00-aaaa-bbbb-01");
  setTraceparent("c2", "00-cccc-dddd-01");
  assert.equal(getTraceparent("c1"), "00-aaaa-bbbb-01");
  assert.equal(getTraceparent("c2"), "00-cccc-dddd-01");
  clearTraceparent("c1");
  assert.equal(getTraceparent("c1"), undefined);
  assert.equal(getTraceparent("c2"), "00-cccc-dddd-01");
  clearTraceparent("c2");
});
