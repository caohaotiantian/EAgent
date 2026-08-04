/**
 * The built-in tool set.
 *
 * Deliberately tiny — filesystem reads and writes inside a jail, and an HTTP fetch.
 * Everything else is a plugin. The point of shipping any at all is that a fresh
 * install can run a real graph without the user writing a tool first, which is what
 * makes the walking skeleton reproducible outside the test suite.
 *
 * Every one declares its irreversibility class honestly, because that class — not a
 * config file — decides the default oversight posture (D7.6).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CODES, err } from "../errors.ts";
import { assertWithin } from "../sandbox/subprocess.ts";
import type { ToolDefinition } from "../run/registry.ts";

export interface BuiltinOptions {
  /** The jail. Every path argument is resolved against it and may not escape. */
  readonly root: string;
  /** Domains `net.fetch` may reach. Empty means the tool is not registered at all. */
  readonly egressAllowlist?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
}

export function builtinTools(opts: BuiltinOptions): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [fsRead(opts), fsWrite(opts)];
  if ((opts.egressAllowlist ?? []).length > 0) tools.push(netFetch(opts));
  return tools;
}

function fsRead(opts: BuiltinOptions): ToolDefinition {
  return {
    name: "fs.read",
    version: "1.0",
    description: "Read a UTF-8 text file from the workspace.",
    capabilities: ["fs:read"],
    irreversibility: "read_only",
    idempotent: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        maxBytes: { type: "integer", default: 200_000 },
      },
      required: ["path"],
    },
    execute: (args) => {
      const path = assertWithin(opts.root, String(args["path"]));
      const max = Number(args["maxBytes"] ?? 200_000);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (e) {
        return { content: `cannot read ${String(args["path"])}: ${(e as Error).message}`, isError: true };
      }
      // Truncation is FLAGGED in the content, so a model reasoning over the result
      // is told it is not seeing everything.
      const truncated = text.length > max;
      return {
        content: truncated ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text,
        details: { path: String(args["path"]), bytes: text.length, truncated },
      };
    },
  };
}

function fsWrite(opts: BuiltinOptions): ToolDefinition {
  return {
    name: "fs.write",
    version: "1.0",
    description: "Write a UTF-8 text file into the workspace, creating directories as needed.",
    capabilities: ["fs:write"],
    // Reversible only because `fs.restore` exists to undo it; without a declared
    // compensation this would have to be `irreversible` and gate by default.
    irreversibility: "reversible_write",
    idempotent: true,
    compensation: { tool: "fs.restore" },
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, body: { type: "string" } },
      required: ["path", "body"],
    },
    execute: (args) => {
      const rel = String(args["path"]);
      const path = assertWithin(opts.root, rel);
      mkdirSync(dirname(path), { recursive: true });
      // Capture the prior content so `fs.restore` has something to restore to. A
      // declared compensation that cannot actually compensate is worse than none.
      let previous: string | undefined;
      try {
        previous = readFileSync(path, "utf8");
      } catch {
        previous = undefined;
      }
      writeFileSync(path, String(args["body"]), "utf8");
      return {
        content: `wrote ${rel}`,
        details: { path: rel, bytes: String(args["body"]).length, previous },
        writes: { written: { path: rel, bytes: String(args["body"]).length } },
      };
    },
  };
}

function netFetch(opts: BuiltinOptions): ToolDefinition {
  const allow = opts.egressAllowlist ?? [];
  const doFetch = opts.fetch ?? globalThis.fetch;
  return {
    name: "net.fetch",
    version: "1.0",
    description: "HTTP GET a URL on the egress allowlist.",
    capabilities: ["net:fetch"],
    irreversibility: "read_only",
    idempotent: true,
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, maxBytes: { type: "integer", default: 100_000 } },
      required: ["url"],
    },
    execute: async (args, ctx) => {
      const raw = String(args["url"]);
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return { content: `not a valid URL: ${raw}`, isError: true };
      }
      // Default deny. An allowlist entry matches the host exactly or as a suffix
      // after a dot, so "api.example.com" never matches "evil-api.example.com.attacker.net".
      const ok = allow.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
      if (!ok) {
        throw err.policy(CODES.E_CAP_DENIED, `egress to "${url.hostname}" is not on the allowlist`, {
          details: { host: url.hostname, allow },
        });
      }
      const res = await doFetch(url, { signal: ctx.signal });
      const text = await res.text();
      const max = Number(args["maxBytes"] ?? 100_000);
      return {
        content: text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text,
        details: { status: res.status, bytes: text.length },
        isError: !res.ok,
      };
    },
  };
}

/** The compensation for `fs.write`, registered alongside it by the CLI. */
export function fsRestore(opts: BuiltinOptions): ToolDefinition {
  return {
    name: "fs.restore",
    version: "1.0",
    description: "Restore a file to its previous content (the compensation for fs.write).",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: true,
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, previous: { type: "string" } },
      required: ["path"],
    },
    execute: (args) => {
      const path = assertWithin(opts.root, String(args["path"]));
      const previous = args["previous"];
      if (typeof previous !== "string") {
        return { content: `no previous content recorded for ${String(args["path"])}`, isError: true };
      }
      writeFileSync(path, previous, "utf8");
      return { content: `restored ${String(args["path"])}` };
    },
  };
}
