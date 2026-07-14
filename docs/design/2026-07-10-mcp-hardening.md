# Light-Mode brief — MCP stdio transport hardening (Batch C2)

Slug: `2026-07-10-mcp-hardening`
Tier: **Light** (single non-load-bearing file `src/extensions/mcp.ts` + its test; no schema/CLI/
storage/protocol/directory change. The env-allowlist decision is surfaced and resolved below; the
timeout reuses/unifies the existing `HTTP_REQUEST_TIMEOUT_MS` value as a config default — not a new
threshold.)

## What / why

Two source-verified robustness/security holes in the MCP **stdio** transport (`src/extensions/mcp.ts`):

1. **Full host env leaks to foreign subprocesses.** `StdioTransport` spawns the server with
   `env: { ...process.env, ...def.env }` (`mcp.ts:238`), handing the entire host environment —
   including `ANTHROPIC_API_KEY`, `EAGENT_TOKEN`, `*_API_KEY`, etc. — to third-party MCP server code.
2. **No timeout on the stdio request/handshake.** `StdioTransport.request()` (`mcp.ts:250-274`)
   correlates a JSON-RPC id→promise and waits indefinitely; it only rejects on child `error`/`exit`
   (`mcp.ts:241-242`) or caller abort. A server that is alive but silent (or slow to complete the
   `initialize` handshake in `load()`) hangs the pending request — and, during handshake, blocks host
   activation — forever. The **HTTP** transport already bounds every request
   (`mcp.ts:384-402`, `HTTP_REQUEST_TIMEOUT_MS = 60_000`); stdio does not.

Fix: (1) build the subprocess env from a minimal allowlist (default-deny) + the server's own `def.env`
+ an operator opt-in passthrough list; (2) add a ref'd-timer timeout to the stdio `request()`
mirroring the HTTP transport, sourced from a single `mcp.requestTimeoutMs` config (default 60_000)
that both transports read.

## Explicit non-goals

- **No** change to the HTTP transport's behavior (default stays 60_000; it just reads the config now).
- **No** change to tool proxying, the handshake protocol, `maxMcpReadBytes`, the bounded line reader,
  or traceparent propagation.
- **No** attempt to sandbox the subprocess beyond env restriction (OS sandboxing is `sandbox-tiers`).
- **Behavior-change note (intended):** a stdio MCP server that relied on inheriting an arbitrary host
  env var must now receive it via its `env` config or `mcp.envPassthrough`. This is the security fix,
  not a regression — the base set keeps normal servers runnable.

## >1-option decision surfaced

**How to restrict the subprocess env.** Options: (A) **allowlist** — a minimal base set (PATH/HOME/
locale/OS-essentials) + `def.env` + opt-in `mcp.envPassthrough` [chosen]; (B) **denylist** — pass all
of `process.env` except known secret patterns (`*_API_KEY`, `*_TOKEN`, `EAGENT_*`, …); (C) pass only
`def.env` (nothing inherited). **Choice (A):** default-deny is the correct security posture (a denylist
silently leaks any secret whose name doesn't match the patterns — the exact failure that recurs), and a
minimal base keeps servers runnable (they need PATH to find their interpreter, HOME/locale, and on
Windows SystemRoot/PATHEXT). Explicit `def.env` and an opt-in passthrough cover intentional vars.
**Reject (B):** a denylist is unbounded — a new secret env var (or a differently-named one) leaks by
default. **Reject (C):** too strict; most servers need PATH/HOME to run at all, forcing every operator
to re-specify OS basics.

Base allowlist (present-only, cross-platform): `PATH HOME LANG LC_ALL LC_CTYPE TZ TMPDIR TEMP TMP
SHELL USER LOGNAME SystemRoot COMSPEC PATHEXT WINDIR APPDATA LOCALAPPDATA`. Passthrough config
`mcp.envPassthrough` = comma-separated var names.

## Measurable acceptance command

`node --import tsx --test test/mcp.test.ts` — new cases (RED before fix, GREEN after):
- **env allowlist:** a `stdioEnv(def, config)` helper (exported, pure) returns an object that includes
  `PATH` (when set) and `def.env` entries but **excludes** a host secret (set `process.env.SECRET_LEAK`
  in the test, assert it is absent); with `mcp.envPassthrough="SECRET_LEAK"` it IS included (opt-in
  works); `def.env` overrides a base key.
- **stdio timeout:** a `StdioTransport.request()` (or a focused unit over the timeout wiring) against a
  spawned stub server that never replies rejects with a "timed out" error within a short configured
  `mcp.requestTimeoutMs` (e.g. set to 100 ms in the test), and a normally-replying server still
  resolves. (If spawning a real hung process is awkward offline, test the timeout by driving the
  ref'd-timer path with a small config value and asserting rejection.)
- **regression:** existing `test/mcp.test.ts` stdio + HTTP cases still pass (the base env keeps the
  test's stub server runnable; HTTP default timeout unchanged at 60_000).

Plus gates: `npm test` 0 fail; `npm run typecheck` 0.

## Closure note
Status: closed (Light Mode, clean first review). Closed-on 2026-07-10 on `chore/production-hardening`.
Implemented `stdioEnv` (default-deny base allowlist + `mcp.envPassthrough` + `def.env`), replacing the
full-`process.env` inheritance; unified both transports' timeout under `mcpRequestTimeoutMs`
(`mcp.requestTimeoutMs`, default 60_000) and added the missing ref'd-timer timeout to the stdio
`request()`. Exported `StdioTransport` for a real hung-process timeout test. Suite 1302 pass / 0 fail /
1 skip; typecheck 0. Deferred: none (a non-integer-config edge falls back to default, consistent with
the docstring — advisory only).
