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
 *
 * THESE ARE THE ONLY TOOLS IN THE SYSTEM THAT TOUCH A DISK OR A NETWORK, so whatever
 * they will not do IS the boundary — and all three of the things they will not do were
 * one line short of holding. The checks, each made where the argument's meaning is known
 * rather than deeper down where it is just a string:
 *
 *  - `opts.root` — where a path may land, compared as a REAL path, so a symlink is not a
 *    way out (`assertWithin`);
 *  - `opts.deny` — what inside the root is still off limits, because the root contains
 *    the journal;
 *  - `opts.egressAllowlist` — which hosts may be reached, re-checked on EVERY redirect,
 *    because the host that answers is not the host the model named.
 */

import { closeSync, constants, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CODES, err } from "../errors.ts";
import { assertWithin } from "../sandbox/subprocess.ts";
import type { ToolDefinition } from "../run/registry.ts";

export interface BuiltinOptions {
  /** The jail. Every path argument is resolved against it and may not escape. */
  readonly root: string;
  /**
   * Subtrees inside the root that are STILL out of reach. Required, and deliberately
   * without a default.
   *
   * The jail root is a workspace, and a workspace holds more than the model's working
   * files: `openWorkspace` puts `.loom/journal.db` in it, and the journal is the only
   * authoritative durable state there is (invariant 2). Containment alone therefore said
   * yes to the one write that destroys the run's own history — measured through the real
   * CLI, a `tool` node with `fs.write {path: ".loom/journal.db"}` reported
   * **`status: "succeeded"`** having truncated the database to nine bytes, and `fs.read`
   * of the same path returns everything ever journaled, past every redaction the event
   * path applies.
   *
   * It has no default BECAUSE a default would be inherited silently. An embedder calling
   * `builtinTools({ root })` with no second thought is the case that produced the hole;
   * `deny: []` is a sentence someone had to write, and `[dataDir]` is what `cli.ts`
   * writes. Entries may be absolute or relative to `root`, and are compared as REAL
   * paths — see `assertWithin`.
   */
  readonly deny: readonly string[];
  /** Domains `net.fetch` may reach. Empty means the tool is not registered at all. */
  readonly egressAllowlist?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
}

/** Absent on platforms without the flag, where this is an ordinary open. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Open the leaf WITHOUT following a symlink, and read or write through the descriptor.
 *
 * `assertWithin` has already resolved every link and proved the result is inside the
 * jail, so by the time this runs the path names a real location. What it cannot promise
 * is that the location is still the same one a syscall later: a check and an `open` are
 * two operations, and between them a name can be replaced by a link. `O_NOFOLLOW` makes
 * that swap fail (ELOOP) rather than succeed somewhere else. It costs nothing in the
 * ordinary case — a path with no links left in it has no link for the flag to refuse —
 * and it narrows the race to the directory components, which no flag Node exposes can
 * close. Where the platform does not define the flag, the jail is exactly as strong as
 * `assertWithin` alone.
 */
function openLeaf(path: string, flags: number): number {
  return openSync(path, flags | NOFOLLOW, 0o666);
}

/** Create-or-truncate and write, through a descriptor the OS opened without following. */
function writeLeaf(path: string, body: string): void {
  const fd = openLeaf(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);
  try {
    writeFileSync(fd, body, "utf8");
  } finally {
    closeSync(fd);
  }
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
      const path = assertWithin(opts.root, String(args["path"]), opts.deny);
      const max = Number(args["maxBytes"] ?? 200_000);
      let text: string;
      let fd: number | undefined;
      try {
        fd = openLeaf(path, constants.O_RDONLY);
        text = readFileSync(fd, "utf8");
      } catch (e) {
        return { content: `cannot read ${String(args["path"])}: ${(e as Error).message}`, isError: true };
      } finally {
        if (fd !== undefined) closeSync(fd);
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
      const path = assertWithin(opts.root, rel, opts.deny);
      mkdirSync(dirname(path), { recursive: true });
      // Capture the prior content so `fs.restore` has something to restore to. A
      // declared compensation that cannot actually compensate is worse than none.
      let previous: string | undefined;
      let readFd: number | undefined;
      try {
        readFd = openLeaf(path, constants.O_RDONLY);
        previous = readFileSync(readFd, "utf8");
      } catch {
        previous = undefined;
      } finally {
        if (readFd !== undefined) closeSync(readFd);
      }
      writeLeaf(path, String(args["body"]));
      return {
        content: `wrote ${rel}`,
        details: { path: rel, bytes: String(args["body"]).length, previous },
        writes: { written: { path: rel, bytes: String(args["body"]).length } },
      };
    },
  };
}

/**
 * How many `Location` hops `net.fetch` will follow before giving up.
 *
 * Not a knob: it is the number of hops a legitimate GET needs (canonicalisation, then
 * a scheme or trailing-slash normalisation, with room to spare), and every hop past it
 * is a loop or a chain nobody should be walking on a model's say-so.
 */
const MAX_REDIRECTS = 5;

/**
 * The egress boundary, applied to ONE url.
 *
 * Scheme first, by name. `file:///etc/passwd` and `data:text/plain,…` have an EMPTY
 * hostname, so they were refused only because `""` happens to match no allowlist entry —
 * a coincidence, and a coincidence is not a boundary. The allowlist is about which hosts
 * may be reached; a URL with no host is a different question and gets a different answer.
 *
 * Then the host: default deny, matching exactly or as a suffix after a dot, so
 * "api.example.com" never matches "evil-api.example.com.attacker.net".
 *
 * A REFUSAL THROWS rather than returning an error result, on every hop for the same
 * reason it does on the first: an egress refusal is a capability denial, and the
 * dispatcher turns it into `effect.failed` + E6. A soft error would read as a fetch that
 * merely did not work.
 *
 * WHAT THIS DOES NOT CHECK IS THE ADDRESS. An allowlisted NAME that resolves to a
 * loopback or link-local address is reached, because the name is what the operator
 * granted and the resolution happens inside `fetch`, below anything this file can reach
 * without a dispatcher of its own. Literal private addresses are likewise allowed when
 * they are on the list — `--egress 127.0.0.1` is a coherent thing for an operator to ask
 * for, and refusing it would be this file overruling a decision it was handed. The
 * property being defended is narrower and worth stating exactly: **every host contacted
 * is one the operator named**, which is what the redirect chain took away.
 */
function assertEgressAllowed(url: URL, allow: readonly string[], hop: number): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw err.policy(CODES.E_CAP_DENIED, `net.fetch speaks http and https only, not the "${url.protocol}" scheme`, {
      details: { url: url.href, protocol: url.protocol, hop },
    });
  }
  const ok = allow.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
  if (!ok) {
    throw err.policy(
      CODES.E_CAP_DENIED,
      hop === 0
        ? `egress to "${url.hostname}" is not on the allowlist`
        : `a redirect tried to send this request to "${url.hostname}", which is not on the allowlist`,
      { details: { host: url.hostname, allow, hop } },
    );
  }
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
    /**
     * EVERY HOP IS CHECKED, because the allowlist governs which hosts are reached and not
     * which host the model typed.
     *
     * `fetch` defaults to `redirect: "follow"`, so one check before the call meant an
     * allowlisted host could hand the request to anywhere: reproduced offline, an
     * allowlisted server answering `302 Location: http://<host not on the list>/…` put
     * that host's body straight into the tool's `content` — the shape of the cloud
     * metadata endpoint, and of any loopback service on the box. `read_only` means
     * posture `out` and no gate, so nothing else stood in the way.
     *
     * `redirect: "manual"` hands the 3xx back instead, and the loop below re-runs the
     * whole boundary — scheme and host — on each `Location` before following it.
     */
    execute: async (args, ctx) => {
      const raw = String(args["url"]);
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return { content: `not a valid URL: ${raw}`, isError: true };
      }
      assertEgressAllowed(url, allow, 0);

      let res = await doFetch(url, { signal: ctx.signal, redirect: "manual" });
      let hops = 0;
      while (res.status >= 300 && res.status < 400 && res.headers.get("location") !== null) {
        const location = res.headers.get("location")!;
        // FIRST, and before anything below can return or throw: a 3xx body is nobody's
        // answer, and an unread one holds its socket. The refusal path is the one that
        // would leak it, and the refusal path is the one that runs under attack.
        await res.body?.cancel().catch(() => undefined);
        if (hops >= MAX_REDIRECTS) {
          return { content: `too many redirects (${MAX_REDIRECTS}) starting from ${raw}`, isError: true };
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { content: `redirected to something that is not a URL: ${location}`, isError: true };
        }
        assertEgressAllowed(next, allow, ++hops);
        url = next;
        res = await doFetch(url, { signal: ctx.signal, redirect: "manual" });
      }

      const text = await res.text();
      const max = Number(args["maxBytes"] ?? 100_000);
      return {
        content: text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text,
        // `url` is where the bytes CAME FROM, which after a redirect is not what was
        // asked for. The journal records the host that answered, not the one that was named.
        details: { status: res.status, bytes: text.length, url: url.href, hops },
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
      const path = assertWithin(opts.root, String(args["path"]), opts.deny);
      const previous = args["previous"];
      if (typeof previous !== "string") {
        return { content: `no previous content recorded for ${String(args["path"])}`, isError: true };
      }
      writeLeaf(path, previous);
      return { content: `restored ${String(args["path"])}` };
    },
  };
}
