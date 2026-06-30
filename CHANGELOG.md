# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

Six new built-in extensions, each adapting a capability from the leading
terminal coding agents (Claude Code, OpenAI Codex CLI, OpenCode) onto EAgent's
existing seams — no kernel change, all capability-gated and offline-tested:

- **`sandbox-tiers`** — OS-level confinement tiers for `shell:exec`, the analog
  of Codex's `--sandbox` matrix. On `beforeToolCall` it rewrites the command to
  wrap it in the host sandbox (`sandbox-exec` on macOS, `bwrap`/`firejail` on
  Linux) enforcing `readonly` / `workspace-write` / `no-network`. Default tier
  `off` (no-op); degrades gracefully (pass or block) when no backend exists.
  `/sandbox-tiers`, `EAGENT_SANDBOX_TIERS=off`. This realizes the OS/VM boundary
  `SECURITY.md` names as the missing seam over the unconfined `bash` tool.
- **`config-hooks`** — declarative external hooks from `.eagent/hooks.json`, the
  shared `settings.json`-hooks model of all three tools. Binds matcher→action
  rules onto the kernel hook bus (`block`/`allow`/`inject`/`append`/`truncate`/
  `notify`, plus an external `command` action gated on `shell:exec`), so
  guardrails and formatters need no TypeScript. Ships off. `/config-hooks`,
  `EAGENT_CONFIG_HOOKS=off`.
- **`fallback-routing`** — model/provider fallback chains (Claude's
  `--fallback-model`). A composite `fallback` provider streams an ordered
  `{provider, model}` chain, failing over only *before* the first event is
  emitted (the no-double-emit invariant), with a per-run circuit breaker. Off by
  default. `/fallback-routing`, `EAGENT_FALLBACK_ROUTING=off`.
- **`budget-cap`** — a hard **USD spend ceiling that enforces**, joining `cost`
  (prices tokens, warn-only) and `limits` (caps tokens). Soft-warns then blocks
  paid tool calls or aborts the run at a per-run or cumulative-session cap; both
  caps default `0` = inert. `/budget-cap`, `EAGENT_BUDGET_CAP=off`.
- **`goal`** — pins the run's objective + acceptance criteria in front of the
  model every turn (anti-drift), and runs an advisory offline completion check
  on `agent_end`; adds a `setgoal` tool and an opt-in model-judge. Inert until a
  goal is set. `/goal`, `EAGENT_GOAL=off`.
- **`headless-flags`** — a CI safety net: when no TTY / a `CI` signal is
  detected, rewrites shell commands to their non-interactive form
  (`apt-get install -y`, `npm init -y`) and prepends env guards
  (`GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`) so a prompt or `$EDITOR` can't
  hang an unattended run. Inert in an interactive TTY. `/headless`,
  `EAGENT_HEADLESS_FLAGS=off`.

### Security

- **`self.read_extension` path traversal fixed.** It built file candidates from
  the raw, unsanitized name when it ended in a known suffix, so a name like
  `../../../../etc/hosts.js` escaped the extensions directory (arbitrary file
  read under the auto-granted `self:read`). Candidates are now built only from
  the sanitized slug, with a path-containment assertion.
- **HTTP server hardened.** `eagent-serve` now binds `127.0.0.1` by default
  (override with `EAGENT_HOST`), warns loudly when started without `EAGENT_TOKEN`
  (mutating routes are then unauthenticated and run tools with full
  capabilities), and the bearer-token check is constant-time
  (`crypto.timingSafeEqual` over fixed-length digests).
- **Extension id collisions no longer leak.** A second activation under the same
  id (the discover "later wins" path) now tears the previous version down first,
  so its tools/hooks are removed rather than left firing as orphans.
- **Package auto-reload tamper guard.** On `session_start`, a remotely-fetched
  package (`git:`/`npm:`) is only re-executed if its recorded `entryPath` still
  lives inside the packages directory, so a tampered registry can't redirect
  auto-load at arbitrary code; `path:` installs still reload from their recorded
  location. The packages dir is now overridable via `EAGENT_PACKAGES_DIR`.

### Added

- **`flow-guard` extension — compositional capability policy.** Per-tool gating
  authorizes each call in isolation, but composing individually-safe tools can
  exfiltrate (read a secret, then POST it out). `flow-guard` rides the existing
  `tool_end` + `beforeToolCall` hooks to hold a network-egress call (`net:fetch`)
  once a sensitive source (`shell:exec`) has run this session — `ask` by default,
  `block`-able, tunable via `/flow-guard` or `EAGENT_FLOW_GUARD=off`. A new
  security best practice absorbed as a hot-reloadable extension, no core change.
  (Motivated by the 2026-06-16 design research; see `docs/RESEARCH-agent-kernel-design.md`.)
  It also enforces **data confinement** with transcript-level **information-flow
  taint**: a tool result that reads a sensitive path (`.env`, `id_rsa`, `.pem`,
  `.ssh/`, `.aws/`, `credentials`, `secret`) or returns credential-looking content
  (PEM keys, `AKIA…`, `sk-…`, `ghp_…`) is tagged on its message (`meta.flowGuardTaint`),
  and egress is gated only while that tainted message is still in the live
  transcript — so `/clear` and `/handoff` un-gate. Capability-chain taint
  (`shell:exec`) stays session-sticky. `/flow-guard status` reports both counts;
  `/flow-guard reset` clears all taint.
- **MCP tool-integrity hardening.** Duplicate MCP server names are skipped (a
  later server can't silently shadow an earlier one's namespaced tools); a tool
  name that shadows an existing tool warns; and tool **descriptions are scanned
  for tool-poisoning / hidden-instruction patterns** at registration (the
  SSH-key-exfil attack class) — warned, never silently trusted.
- **`integrity` extension — tool-poisoning sweep across every tool source.**
  Generalizes the MCP description scan to *all* registered tools (packages,
  self-authored, MCP) with one sweep on `session_start` (warn) and on demand via
  `/integrity`. It also detects a **rug pull** — a tool whose description *changed*
  since the last session (the approved-benign-then-swapped-malicious vector) — by
  persisting a per-tool description fingerprint and reporting drift. A pure
  observer, no core change.
- **`.env` auto-loading.** The CLI and server load a local `.env` at startup via
  a tiny zero-dependency parser (`loadEnvFile` in `host.ts`); real environment
  variables always win. A documented `.env.example` ships with the repo, and
  `.env`/`.env.*` are gitignored.
- **Model from environment.** `ANTHROPIC_MODEL` / `OPENAI_MODEL` / `GEMINI_MODEL`
  now set the default model per provider, so `--model` isn't needed on every run.
- **`ANTHROPIC_AUTH_TOKEN`** is accepted as an alias for `ANTHROPIC_API_KEY`
  (the gateway/Claude-Code convention).
- **`OPENAI_MAX_TOKENS_PARAM`** (and the `maxTokensParam` option) selects
  `max_tokens` vs `max_completion_tokens`, so newer official OpenAI models and
  OpenAI-compatible proxies are both reachable.

### Changed / Fixed

- **`stop()` is now honored by the agent loop** directly, not just forwarded to
  the provider, so an abort reliably halts the run.
- **Cancelling a run mid-stream is now a clean stop, not an error.** When a
  `stop()`/abort lands while the provider stream is in flight (a real `fetch`
  provider rejects it), the run ends `reason:"stop"` with no `"error"` event and
  no thrown `run()` — matching a between-call cancel. A genuine provider failure
  (no abort) still surfaces as `reason:"error"`. Removes a spurious red error on
  CLI Ctrl-C and a false ERROR telemetry record.
- **`maxConcurrency <= 0` no longer crashes tool dispatch.** An invalid value is
  clamped to a floor of `1` at construction (the default `Infinity` and the
  parallel fast path are unchanged).
- **A corrupt store file is preserved, not silently overwritten.** `FileStore`
  now distinguishes an absent file (a silent first run) from unparseable JSON; a
  corrupt file is moved aside to `*.corrupt-<pid>-<ts>` before the store starts
  empty, so the next write can no longer destroy persisted keys.
- **Durable journal `/resume` recovers** from a single corrupt/truncated line
  instead of discarding the whole journal; session/journal loads validate each
  entry's shape at the boundary.
- **SSE parser tolerates CRLF** line endings (no more stall) and strips only a
  single leading space from `data:` per spec; `Retry-After` HTTP-date form is
  honored.
- **MCP HTTP transport** now has a request timeout and threads the agent's abort
  signal, so a hung server can't block activation or a turn.
- **Server aborts the agent on client disconnect** (frees the single-flight
  lock and stops wasting tokens).
- **Unknown `--provider` fails fast** at startup with a clear message instead of
  on the first turn.
- **`FileStore` writes are atomic** (temp file + rename) and a backend caches one
  store per namespace to avoid clobbering.
- Smaller fixes: OpenAI synthesizes unique ids for parallel same-name tool calls;
  Gemini preserves a `max_tokens` truncation signal and surfaces tool-result
  errors; `bash` defaults its cwd to the workspace; `/fetch` honors the size cap;
  `read` validates `offset`/`limit`; CLI rejects missing flag values and unknown
  options; non-interactive CLI (`--eval`/batch) now tears the host down on
  SIGINT/SIGTERM instead of orphaning MCP child processes. Docs (`CLAUDE.md`,
  `README.md`) corrected to the real provider/extension/route set.

## [0.2.0] - 2026-06-15

A large capability release: two more real providers, multimodality, four front
ends, self-authoring extensions, durability, and production hardening — all
while the kernel stayed minimal (a guard test enforces it).

### Added

- **Providers:** OpenAI and Google **Gemini** providers (`fetch`+SSE, no SDK),
  joining Anthropic and the mock; shared retry/backoff/SSE/usage plumbing in
  `providers/http.ts`. Anthropic prompt caching with cache-token accounting.
  Record/replay **cassettes** (`RecordingProvider`/`ReplayProvider`) for
  deterministic offline testing of real-model behavior.
- **Multimodality:** an `image` content block (base64 or URL) with an
  `imageMessage` helper, mapped to each provider's format.
- **Front ends:** an HTTP server (`eagent-serve`) with `/health`, streaming
  `POST /run`, multi-turn `session` continuity, `DELETE /sessions/:id`, a
  concurrency lock, graceful shutdown, optional bearer-token auth
  (`EAGENT_TOKEN`), and a request-body cap. CLI `--json`, `--help`, `--version`,
  and token streaming.
- **Extensions:** `mcp` HTTP transport; `subagents`, `memory`, `planmode`,
  `session`, `packages`, `trace`, `context-files`, `limits` (output truncation +
  tool-call & token budgets), `self` (the agent authors/hot-loads its own
  TypeScript), `web` (capability-gated HTTP), `checkpoint` (git rollback),
  `introspect` (self-documentation), `journal` (durable runs + `/resume`), and
  `prompts` (saved templates).
- **API:** `ExtensionAPI.loadExtension`/`unloadExtension` for first-class
  dynamic/self-authored extensions; `defineTool<TArgs>` typing.
- **Tooling & docs:** GitHub Actions CI, `Dockerfile`, `ARCHITECTURE.md`,
  `docs/EXTENSIONS.md`, `CONTRIBUTING.md`, `SECURITY.md`, worked examples, a
  kernel-minimalism guard test, and `npm run test:coverage`.

### Changed

- The shared `createAgentHost` wiring (`src/host.ts`) backs every front end, so
  the built-in extension list has one home.
- The agent emits a `message` event for the user's message too, so every
  transcript message is observed uniformly.
- Filesystem tools are confined to a workspace root; token usage is accounted
  and surfaced via a `usage` event.
- Hardening: failed activations roll back partial registrations, a failing
  built-in is skipped at startup, and resilience is covered by tests
  (provider errors mid-stream, no-`done` streams, activation cleanup, an
  end-to-end write→read→edit scenario, SSE split-chunk parsing).

## [0.1.0] - 2026-06-15

Initial release.

### Added

- **The kernel** — seven primitives and nothing more: a hook bus (lifecycle
  events and filter hooks), a tool registry (register/shadow/dispose), a
  provider abstraction (request → stream of events), the agent loop (turns,
  streaming, guarded and ordered tool dispatch, steering and follow-up, stop
  conditions), a capability layer (grant/deny/ask, wildcards, audit log), the
  extension host (discovery, activation, the `ExtensionAPI`, hot reload via
  `jiti`), and the command registry (user-facing slash commands).
- **Providers** — `MockProvider`, a scriptable deterministic LLM that keeps the
  whole suite offline; and two real `fetch` + SSE clients with no SDK,
  `AnthropicProvider` (Messages API) and `OpenAIProvider` (Chat Completions and
  compatible endpoints), sharing retry/backoff and token-usage plumbing
  (`providers/http.ts`); retries cover 429/5xx/network errors.
- **Built-in extensions**, each riding the `ExtensionAPI`, capability-gated, and
  shipped with offline tests:
  - `core-tools` — `read`, `write`, `edit` (confined to a workspace root), `bash`.
  - `skills` — LLM-authored skills via `SKILL.md` with progressive disclosure.
  - `mcp` — a Model Context Protocol client over stdio and Streamable HTTP.
  - `codeact` — code-as-action execution in a subprocess boundary.
  - `subagents` — isolated child agents (single / parallel / chain).
  - `memory` — context compaction plus a `remember`/`recall` scratchpad.
  - `planmode` — a human-in-the-loop approval gate for mutating tools.
  - `session` — save / load / handoff for transcripts.
  - `packages` — install extensions from `path:` / `git:` / `npm:` sources.
  - `trace` — observability over the lifecycle events.
  - `context-files` — project context files injected into the prompt.

[Unreleased]: https://github.com/caohaotiantian/eagent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/caohaotiantian/eagent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/caohaotiantian/eagent/releases/tag/v0.1.0
