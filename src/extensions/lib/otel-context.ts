/**
 * otel-context — the publish/consume channel for W3C trace-context propagation
 * (RW7c-2). `otel-exporter` PUBLISHES the current tool-call span as a `traceparent`
 * keyed by the kernel `toolCallId`; `web` and `mcp` CONSUME it and inject the header
 * on outbound tool HTTP, so a downstream instrumented service becomes a child span
 * of the tool call.
 *
 * Pure library: no capability, no side effects beyond the module map, never throws.
 * Injection is doubly gated — a traceparent exists only while otel traces are on
 * (the sole writer), and a host is trusted only if it's in the operator's
 * `EAGENT_OTEL_PROPAGATE_HOSTS` allowlist (default empty ⇒ nothing is injected).
 */

/** callId → the W3C `traceparent` for that tool call's span (set while otel is on). */
const CONTEXT = new Map<string, string>();

/** Format a W3C `traceparent`: version 00, 32-hex trace-id, 16-hex span-id, sampled. */
export function traceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

/** Publish the traceparent for a tool call (otel-exporter, at tool_start). */
export function setTraceparent(callId: string, tp: string): void {
  CONTEXT.set(callId, tp);
}

/** The published traceparent for a tool call, or undefined (otel off / not a tool). */
export function getTraceparent(callId: string): string | undefined {
  return CONTEXT.get(callId);
}

/** Drop a tool call's traceparent (otel-exporter, at tool_end). */
export function clearTraceparent(callId: string): void {
  CONTEXT.delete(callId);
}

/** Parse an operator's outbound-propagation host allowlist from a raw
 *  comma-separated string (the `otel.propagateHosts` config value), trimming,
 *  lower-casing, and dropping blanks. The caller supplies the resolved value so
 *  this lib reads no env. */
export function propagateAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * True when `url`'s host is on `allowlist` — exact match, or a leading-dot suffix
 * (`.example.com` matches `api.example.com`). A malformed URL or empty allowlist is
 * false (fail-closed: never inject where the operator hasn't opted in).
 */
export function isTrustedHost(url: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowlist.some((raw) => {
    const entry = raw.toLowerCase(); // self-contained: don't assume the caller lowercased
    return entry.startsWith(".") ? host === entry.slice(1) || host.endsWith(entry) : host === entry;
  });
}
