/**
 * Web access as a capability-gated tool.
 *
 * Agents frequently need to reach the network — fetch a page, hit an API, pull
 * a document. But network egress is exactly where prompt injection turns into
 * exfiltration: a compromised transcript can ask the agent to POST secrets to
 * an attacker's host. So this tool is gated behind the `net:fetch` capability,
 * which is deliberately NOT auto-granted (the host policy must opt in), and the
 * response is bounded in size so a single fetch cannot exhaust memory.
 *
 * Note on SSRF: validating the scheme stops `file:`/`data:` reads, but it does
 * not stop a request to a link-local or internal address (e.g. cloud metadata
 * endpoints). That residual risk is intentionally left to the capability gate
 * and host network policy rather than re-implemented here — see the comment in
 * `validateUrl` below. Because we follow redirects, the final URL is not the one
 * validated, so any caller-side hostname allowlisting can be defeated by a 302:
 * treat granting `net:fetch` as full internal-network egress.
 */

import { defineTool, fail, ok } from "../kernel/define.ts";
import type { ExtensionAPI } from "../kernel/extension.ts";
import { getTraceparent, isTrustedHost, propagateAllowlist } from "./lib/otel-context.ts";
import { readCapped } from "./lib/read-capped.ts";

/** Default cap on the response body we will read into memory: 1 MiB. */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Marker appended to a body that was cut off at the byte cap. */
const TRUNCATION_MARKER = "\n…[truncated]";

/**
 * Validate that `raw` is a plain http(s) URL. We reject every other scheme
 * (`file:`, `data:`, `ftp:`, …) because those are not "web fetches" and open
 * local-resource reads. We deliberately do NOT block private/link-local hosts
 * here: doing it correctly requires DNS resolution and is racy, so SSRF defense
 * is left to the `net:fetch` capability and the host's network policy.
 */
function validateUrl(raw: string): URL {
  const url = new URL(raw); // throws on malformed input; caller catches.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme "${url.protocol}" (only http/https allowed)`);
  }
  return url;
}

/**
 * Build the actionable continuation hint appended to a truncated window in
 * place of the dead-end `TRUNCATION_MARKER`. `nextIndex` is the byte offset of
 * the next window — `startIndex + bytesShown` — so chained fetches walk the
 * body without gaps or overlap. Exported as the test seam (mirrors
 * `recovery.ts`); the load-bearing token is `start_index=<N>`.
 */
export function continuationHint(nextIndex: number): string {
  return `\nmore content available — continue with start_index=${nextIndex}`;
}

export default function activate(e: ExtensionAPI): void {
  // net:fetch is intentionally NOT granted here: web access must be an explicit
  // host-policy decision, not an ambient default.

  e.registerTool(
    defineTool({
      name: "fetch_url",
      description:
        "Fetch a URL over http/https and return the response body (capped in size). " +
        "Requires the net:fetch capability.",
      capabilities: ["net:fetch"],
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The http/https URL to fetch." },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE", "HEAD"],
            default: "GET",
            description: "HTTP method.",
          },
          headers: {
            type: "object",
            description: "Optional request headers as a flat string→string map.",
          },
          body: { type: "string", description: "Optional request body (for POST/PUT)." },
          maxBytes: {
            type: "integer",
            default: DEFAULT_MAX_BYTES,
            description: "Maximum number of response bytes to read before truncating.",
          },
          start_index: {
            type: "integer",
            default: 0,
            description:
              "Byte offset to start reading the response body from (default 0). Use the value from a " +
              "previous fetch's 'continue with start_index=N' hint to read the next window.",
          },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        let url: URL;
        try {
          url = validateUrl(String(args.url));
        } catch (err) {
          return fail(`Invalid URL: ${(err as Error).message}`);
        }

        const method = String(args.method ?? "GET");
        const maxBytes = Math.max(0, Number(args.maxBytes ?? DEFAULT_MAX_BYTES));
        // start_index is a byte offset into the response body. The integer
        // schema means the kernel validator has already rejected any non-numeric
        // value before execute runs, so args.start_index is omitted (→ 0) or a
        // finite integer here; a validly-passed negative integer clamps to 0 via
        // Math.max (mirrors the maxBytes guard above). The kill switch reverts to
        // today's behavior: ignore start_index and re-emit the legacy marker.
        const paginate = e.config.enabled("web.paginate", { default: true });
        const startIndex = paginate ? Math.max(0, Number(args.start_index ?? 0)) : 0;
        const baseHeaders =
          args.headers && typeof args.headers === "object"
            ? (args.headers as Record<string, string>)
            : undefined;
        // Propagate this tool call's OTel span as a `traceparent` — only for
        // an allowlisted host and only while otel traces are on (the map's writer);
        // otherwise `headers` is byte-identical to the caller's (undefined by default).
        const tp = getTraceparent(ctx.toolCallId);
        const headers =
          tp && isTrustedHost(url.href, propagateAllowlist(e.config.string("otel.propagateHosts") ?? ""))
            ? { ...(baseHeaders ?? {}), traceparent: tp }
            : baseHeaders;
        const body = method === "GET" || method === "HEAD" ? undefined : (args.body as string | undefined);

        let res: Response;
        try {
          res = await fetch(url, {
            method,
            headers,
            body,
            signal: ctx.signal,
            redirect: "follow",
          });
        } catch (err) {
          // Network failure, DNS error, or abort — never throw out of the tool.
          const reason = ctx.signal.aborted ? "request aborted" : (err as Error).message;
          return fail(`Fetch failed for ${url.href}: ${reason}`);
        }

        const contentType = res.headers.get("content-type") ?? "";
        let text = "";
        let bytes = 0;
        let truncated = false;
        if (res.body) {
          try {
            const read = await readCapped(res.body, maxBytes, startIndex);
            text = read.text;
            bytes = read.bytes;
            truncated = read.truncated;
          } catch (err) {
            const reason = ctx.signal.aborted ? "request aborted" : (err as Error).message;
            return fail(`Failed reading body from ${url.href}: ${reason}`);
          }
        }

        const summary = `${res.status} ${res.statusText} · ${contentType || "no content-type"} · ${bytes} bytes${
          truncated ? " (truncated)" : ""
        }`;
        // On a truncated window the model gets an actionable next offset
        // (N = startIndex + bytesShown) instead of the dead-end marker; under
        // the kill switch we re-emit the legacy marker byte-for-byte. A
        // non-truncated window (incl. the past-the-end empty window) gets neither.
        const tail = truncated ? (paginate ? continuationHint(startIndex + bytes) : TRUNCATION_MARKER) : "";
        const content = `${summary}\n${text}${tail}`;
        const details = { status: res.status, contentType, bytes, truncated };

        // A non-2xx status flags the result as an error but still surfaces the
        // body so the agent can read the server's explanation.
        return res.ok ? ok(content, details) : fail(content, details);
      },
    }),
  );

  e.registerCommand({
    name: "fetch",
    description: "Fetch a URL (GET) and print the start of the response. Requires net:fetch.",
    run: async (ctx) => {
      const target = ctx.args.trim();
      if (!target) {
        ctx.print("usage: /fetch <url>");
        return;
      }
      let url: URL;
      try {
        url = validateUrl(target);
      } catch (err) {
        ctx.print(`Invalid URL: ${(err as Error).message}`);
        return;
      }
      try {
        await ctx.agent.capabilities.require("net:fetch", "web");
      } catch {
        ctx.print(`Denied: the net:fetch capability is required to fetch ${url.href}.`);
        return;
      }
      try {
        const res = await fetch(url, { method: "GET", redirect: "follow" });
        // Use the same byte-capped reader as the tool so /fetch can't buffer a
        // multi-GB or unbounded stream into memory.
        const raw = res.body ? (await readCapped(res.body, DEFAULT_MAX_BYTES)).text : await res.text();
        const preview = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
        ctx.print(`${res.status} ${res.statusText}\n${preview}`);
      } catch (err) {
        ctx.print(`Fetch failed for ${url.href}: ${(err as Error).message}`);
      }
    },
  });
}
