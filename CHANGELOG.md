# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

**All shipped human UI surfaces.** The `web/` browser SPA (and its `EAGENT_WEB_ROOT`
/ static-serving path in `eagent-serve`, `build:web` / `dev:web` / `test:web`
scripts, and `docs/WEB.md`) is deleted, as is the terminal render layer:
`src/engine-render.ts`, `src/view-model.ts`, `src/attribution.ts`, `src/tty.ts`,
`src/wire-events.ts`, and `src/session-source.ts`. The `/details`, `/expand`, and
`/collapse` display commands and the interactive readline REPL go with them. A
bare `GET /` on the HTTP host now returns a plain-text liveness line instead of
the SPA; every path the static branch used to serve auth-exempt is now gated.

### Added

**`src/print.ts` — the headless plain printer.** The only human-readable output
the engine emits: assistant text to stdout, sub-agent text / reasoning / tool
calls / errors to stderr, and no cursor, alt-screen, or spinner byte by
construction. Only the root agent's text reaches stdout, so concurrent sub-agent
forks can no longer interleave into a piped answer. `src/cli.ts` is now
non-interactive by definition (`--eval`, `--json`, piped batch) and is also
installed as `eagent-headless`; on a TTY with no input it explains itself and
exits 2 rather than blocking on a stream that never closes.

The rich interactive experience is being rebuilt as an Ink + React `eagent` TUI
in a separate `tui/` package, which depends on the engine rather than the
reverse. The engine keeps its zero-runtime-dependency charter (`jiti` only).


### Added

**Web UI (browser SPA, TUI feature parity for single-host).** Vite + React app under
`web/`, served same-origin by `eagent-serve` (`EAGENT_WEB_ROOT` / `web/dist`). Chat
uses `POST /run` JSONL (including mid-turn elicitation); Monitor lists sessions and
attaches to per-session SSE with stop/forget. Shared pure `src/wire-events.ts` mapper
and `src/view-model.ts` section tree. Auth-exempt static GET so the UI can boot when
`EAGENT_TOKEN` is set. Scripts: `build:web`, `dev:web`, `test:web`. See `docs/WEB.md`.

### Removed

**Ink `eagent-tui` rich terminal client.** The separate ESM Ink/React front end
(`src/tui/`, `eagent-tui` bin, `build:tui` / `test:tui`, `ink` + `react` runtime
deps) is dropped. The engine plain renderer (`src/engine-render.ts` over the
shared view-model / attribution / tty cores) remains the only shipped human
terminal surface. HTTP/SSE monitor endpoints and host-level `SessionSource`
(`src/session-source.ts`) are retained as substrate for a planned **web** rich
UI. Zero-runtime-dep charter is restored to **only `jiti`**
(`test/zero-dep.test.ts`).

### Added

**TUI rebuild — a decoupled Ink (React) terminal client + a multi-session monitor,
over a shared neutral view model (zero kernel change, host code only).** The
hand-rolled `src/render/` renderer (the earlier progressive-disclosure work) is
removed and replaced by two consumers of one shared, pure, offline-testable view
model (`src/view-model.ts` + `src/attribution.ts` + `src/tty.ts`):

- **The engine keeps a minimal, zero-dep plain renderer** (`src/engine-render.ts`)
  wired into the CLI for every non-Ink path — pipes, `--eval`, batch, dumb
  terminals, and the standalone `bin/eagent` binary. It **preserves both**
  long-standing pain-point fixes: concurrent `reasoning-search` forks are attributed
  per acting agent and **de-interleaved** into ordered sections (no more
  non-chronological flood), and full tool arguments/results are retained
  **untruncated** and reachable via the `/details [full|collapsed|auto]`,
  `/expand <n>`, and `/collapse <n>` commands (the old 79/99-char truncation stays
  gone). Append-only — every line is written exactly once, so the machine paths
  carry no cursor bytes and `--json` stays byte-identical (unchanged).
- **A new rich `eagent-tui` Ink client** (`src/tui/`) renders the same section tree
  live: streaming text, collapsible reasoning, structured tool cards, nested
  sub-agents, a persistent input + status bar, a ≥ 100-column side panel, plus delta
  coalescing + viewport windowing to keep the reasoning-search flood smooth. It is a
  separate **ESM front end run via Node** (a new `eagent-tui` bin), **not** bundled
  into the CJS SEA engine binary.

A new **multi-session monitor** (`eagent-tui --monitor`) attaches to one or more
running EAgent hosts (a `{ url, token }[]` list via repeatable `--instance
url[,token]` flags), lists their live sessions with status/usage/cost, drills into a
session's live SSE feed, and can stop a running turn or forget a session. It rides
four additive, read-mostly server endpoints (zero-dep, Ink-free, reusing the
existing bearer auth + session pool): `GET /sessions`, a per-session SSE feed
`GET /sessions/:id/events` (tenant-isolated by run-tree root agent), a global
`GET /events` (each frame tagged with its `session` id), and `POST /sessions/:id/stop`.

The old opt-in **alt-screen surface is removed**: the `--tui` flag, the `/tui`
command, and the raw-mode/alt-screen renderer (`createTuiHost`, `attachRawKeys`,
`resumeLineInput`) are gone — the rich full-screen UI now lives entirely in the
separate `eagent-tui` client.

**Charter amendment (`CLAUDE.md`).** The zero-runtime-dependency rule is amended:
the kernel, providers, extensions, server, and CLI-engine stay zero-dep (except
`jiti`), but the `src/tui/` front end MAY use vetted, pinned, import-isolated
dependencies — `ink` (6.8.0) + `react` (19.2.8), added as runtime `dependencies`
(with `@types/react` + `ink-testing-library` as dev deps). `test/tui-isolation.test.ts`
enforces the isolation: nothing outside `src/tui/` imports `ink`/`react`, and the SEA
`bin/eagent` binary stays Ink-free. New scripts `build:tui` (esbuild →
`dist/tui/bundle.mjs`) and `test:tui`. The controls, keys, architecture, and the
out-of-CI real-TTY smoke procedure are documented in [`docs/TUI.md`](docs/TUI.md).

**Surface, tune, and recover from silent turn truncation.** A turn cut off at the
output-token cap is no longer invisible in the interactive CLI:

- The human REPL now prints a warning on the abnormal terminal reasons it previously
  dropped — `max_tokens` (with a recovery hint), `content_filter`, and `refusal` —
  via a new `agent_end` handler in the renderer. (`--json` mode and the HTTP server
  already surfaced the run's reason; this closes the interactive gap.)
- The per-provider output-token cap default is raised **4096 → 8192** across all
  three providers (override with `ANTHROPIC_MAX_TOKENS` / `OPENAI_MAX_TOKENS` /
  `GEMINI_MAX_TOKENS`), so realistic answers stop truncating.
- A new **opt-in** `autocontinue` extension (ships off; `/autocontinue on`,
  hard-disabled by `EAGENT_AUTOCONTINUE=off`) auto-resumes a truncated answer by
  injecting a "continue" follow-up, capped at 3 continuations per top-level run and
  keyed on the acting agent.
- One additive kernel seam: the `message` lifecycle event now optionally carries the
  turn's `stopReason`, letting an extension observe a truncated turn before the loop
  decides to stop. The kernel holds at 2260 lines (ceiling 2265).

**Concurrent in-process multi-tenant isolation for the HTTP server (one kernel
seam).** The server now hosts many `session` ids **concurrently**, each on its own
Agent, with no cross-session state bleed. A single new kernel accessor —
`currentRootAgent()`, a second `AsyncLocalStorage` set at the top-level `run()` and
inherited by sub-agent forks — lets every extension key its per-session state on the
session's run-tree **root** via `WeakMap<Agent>` (shared across a session's fork
tree, distinct between sessions, GC'd on eviction). All 7 security guards
(`write-guard`, `flow-guard`, `provenance`, `bash-policy`, `skills-hardening`,
`subagent-jobs`, `budget-cap`) and the correctness accumulators (`cost`, `goal`,
`todo`, `drift-probe`, `handoff`, `limits`, `fallback-routing`, `compact`,
`citations`) are isolated per session; the cross-agent exfil catches (a parent's
taint still gates a fork's egress) are preserved. The `/run` streams and mid-turn
elicitation route by root, so each response carries only its own session's events; a
concurrent **same-session** `/run` returns **409** while different sessions overlap.
New `GET /sessions/:id` returns a session's usage + cost summary. The `session` id
remains a multiplexing key authenticated by one shared token, **not** a per-tenant
authorization boundary — for that, run one process per tenant (see `SECURITY.md`).

**Unified JSONL event schema across the CLI `--json` and HTTP `/run` streams
(zero kernel change).** Both front ends now serialize through one shared
`src/jsonl.ts` mapper, so a single parser reads either stream. The HTTP `/run`
stream gains the fields the CLI already emitted: `tool_start`/`tool_end` now
carry the tool-call `id`, and `reasoning_delta` is now streamed over HTTP. Each
`/run` turn now ends with a canonical **`agent_end`** terminal (matching the
kernel lifecycle event name and the CLI); the legacy `done` line is still emitted
first during a deprecation window and is **deprecated** — consumers should migrate
to `agent_end` (`done` is removed in a future release). The CLI `--json` output is
unchanged (byte-identical). The canonical shapes are documented in
[`docs/JSONL.md`](docs/JSONL.md).

**Guard telemetry + a documented `beforeToolCall` precedence contract (zero
kernel change).** Guard blocks are now observable as *blocks*, not generic
errors, and the load-order precedence of the guards is documented and
drift-guarded.

A shared `src/extensions/lib/guard-block.ts` helper (`isGuardBlock` /
`blockReason`) recognizes the kernel dispatcher's `"Tool call blocked: "` result
on `tool_end` in one place. `otel-exporter` breaks guard blocks out into a new
**additive `eagent.guard.blocks`** counter and tags the tool **span** with
`eagent.guard.blocked=true` + `eagent.guard.reason` — while leaving the existing
`eagent.tool.calls` `error` bucketing **unchanged** (a block still counts as an
error there, so no dashboard/test keyed on `error` is disturbed). `trace` counts
a block as a separate **`toolBlocked`** (surfaced in `/usage`) and marks it
`[blk]` in the `/trace` tree, distinct from `errors`.

SECURITY.md gains a **"Guard precedence"** subsection documenting the full
17-extension `beforeToolCall` order (= `BUILTIN_EXTENSIONS` load order),
first-block-wins, rewrite-chains-onward, and that there is no priority mechanism
(reorder to change it); `docs/EXTENSIONS.md` cross-links it. A drift test
(`test/guard-precedence.test.ts`) re-derives the live order and fails if the doc
drifts. No kernel change; the telemetry rides `otel-exporter` / `trace` (their
`EAGENT_<NAME>=off` kill switches apply).

**Per-event cost model + provider watchdog (turn-loop hardening).** Two
turn-loop correctness/availability fixes.

The `usage` lifecycle event now carries the **model the request actually used**
(`{ usage, cumulative, model }`) — an additive field on the event payload, filled
from the agent loop's turn-local model. `cost` prices each `usage` event at that
model (`p.model ?? activeModel`) and keys its `perModel` map by it, so a mid-run
**routing switch** (`routing` re-tiering on `turn_start`) and an
`onProviderError` **retry downshift** are both attributed to the model that was
actually billed, not the one stamped on `agent_start`. The field is additive, so
every other `usage` consumer (`trace`, `budget-cap`, `limits`, `otel-exporter`,
`evals`) is unaffected. Kernel delta: a single event-type field plus the emit
argument (no ceiling bump).

A new **`watchdog`** extension bounds a hung main provider stream at zero kernel
cost. It captures the default provider at activation and re-registers, under the
same name, a thin wrapper whose `stream` imposes an **idle deadline**: it drives
the inner stream via its async iterator and races each `iterator.next()` against a
timeout that rejects after `watchdog.idleMs` and is **re-armed on every event**.
The race — not abort alone — guarantees unblocking even a stream that ignores its
signal; a composed `AbortController` (any-combined with `req.signal`) also aborts
to free the underlying fetch, and a per-iteration `clearTimeout` keeps the idle
timer from leaking into an `unhandledRejection` when the inner stream throws a
real error first. A pre-commit idle (zero events) surfaces to the loop's
`onProviderError`/retry seam; a mid-stream idle (committed) is rethrown as a fatal
turn error, since retrying a partial stream would double-emit. It registers via
the **raw** provider registry (not the tracked `registerProvider`, whose dispose
would delete rather than restore the provider) and its dispose restores the
captured original by overwrite; a module-local `WeakSet` brand makes activation
idempotent, and a reload disposes-then-reactivates so no double-wrap arises. Ships
**on** (a safety net), inert unless a stream actually stalls; it wraps the
**default-provider path only** (not arbitrary named or composite providers). The
default `watchdog.idleMs` is 120000 — comfortably above normal inter-event gaps;
an operator running very large thinking budgets (where time-to-first-token can
exceed the deadline before the first token) should raise it. `EAGENT_WATCHDOG=off`
disables it; declares no capability (providers are not capability-gated). No
kernel change for the watchdog.

**Async sub-agent jobs (`subagent-jobs`).** A new extension adding a background
job lifecycle on top of the existing child-agent machinery: `launch_job` starts
a child on a prompt **without awaiting** and returns a `jobId` immediately;
`job_status` inspects one job or lists all without blocking; `collect_job` awaits
and returns the child's final answer (status-aware — a cancelled/failed job is
reported as such, never overwritten to collected); `cancel_job` stops a running
child; and `/jobs` lists every job. Jobs live in an in-process `Map` (a live
Promise + child `Agent` are not serializable and a running job has no meaning
across a restart) — **never persisted**. A dual recursion guard (a runtime
root-only check plus a `SPAWN_CAPS`-stripped child registry) prevents nested
jobs and job-child spawning; running jobs are concurrency-capped
(`subagentJobs.maxConcurrent`, default 4) and finished records retention-capped
(`subagentJobs.retain`, default 32, FIFO); dispose cancels every still-running
job so no background child is orphaned on unload/reload. `EAGENT_SUBAGENT_JOBS=off`
kill switch; tools declare `agent:spawn`. The only change to `subagents.ts` is an
additive `export` on `finalText` (behavior-neutral); no kernel edits.

**Model-capability floor for self-extension (`self-extend-floor`).** A new
`beforeToolCall` guard extension that blocks any `self:extend`-gated tool call
(across `self` and `self-improve`, and any future `self:extend` tool) when the
acting model (`e.agent.model`) matches none of a configured allowlist of model
substrings — embodying the STOP lesson (arXiv 2310.02304) that scaffold-level
self-improvement should assume a capable base and refuse rather than loop on a
weak one. Inert by default (empty allowlist ⇒ zero gating, byte-identical to
today); activated by configuring `selfExtendFloor.models` (comma-separated,
case-insensitive **substrings** — matching is by `contains`, so write the most
specific ids that still match, e.g. `opus-4`/`gpt-5`, since a weaker variant
whose id contains an allowlisted substring is admitted). Capability-scoped via
the tool registry (no hardcoded tool list); no command, no capability; hard kill
switch `EAGENT_SELF_EXTEND_FLOOR=off`; emits one `warn` line on a block. The
acting model is resolved as `currentActingAgent() ?? e.agent` so a self-extending
sub-agent is judged on ITS model, not the root's (the capability lookup stays on
the root registry); matching is substring by default, with an opt-in
`selfExtendFloor.match=exact` for strict full-id equality (any other value ⇒
substring).

**Playbook extension (`playbook`) — an evolving, delta-merged, auto-injected
insight playbook.** A new opt-in extension that maintains a durable, ordered list
of bulleted insights and injects them into context every turn, so accumulated
know-how is always in front of the model (the "context as an evolving playbook"
pattern from agentic context-engineering work). Updates are **deterministic
delta-merges** — `add` a new bullet or `merge` an insight into an existing bullet
by id (segment-exact dedupe, no LLM call) — never a monolithic rewrite, which
structurally avoids "context collapse".

- Stored one bullet per `bullet:<id>` key with a monotonic `ord`; capped at 64
  bullets (FIFO-drop oldest).
- Injected as one leading ephemeral `system` note on `transformContext`, placed
  after `compact` so it is never folded into a summary; byte-capped at 8 KB
  (whole message, with a truncation marker) to bound the always-on per-turn cost.
- Ships **off** (`/playbook on`; `EAGENT_PLAYBOOK=off` hard kill switch); no
  capability required. Command: `/playbook on|off|list|add|merge|forget|clear`.

**Centralized configuration (`e.config`).** Configuration used to be read at ~200
isolated sites — direct `process.env.EAGENT_*` reads, private hard-coded
constants, and per-extension store flags, each with its own precedence and
parsing. It is now one layered facility injected into every extension as
`e.config` (peer to `e.store`/`e.log`):

- **One deterministic precedence chain.** Value keys resolve `override > env >
  file > default`; enablement resolves `env-veto("off") > override > store >
  default`, deliberately excluding the config *file* so an untrusted project
  `.eagent/config.json` can never enable/disable an extension.
- **A `Config` interface + `envOnlyConfig` fallback** live in the kernel
  (`store.ts`); the full `LayeredConfig` (file layer, legacy-name aliases,
  source reporting, secret hiding) lives in `src/config.ts`. Adding the facility
  raised the kernel line ceiling from 2,200 to 2,250 — a deliberate, documented
  decision (the `Config` public export is type-only, so the runtime surface is
  unchanged).
- **`/config`** — a new built-in command to `list`/`get`/`set`/`unset`/`reload`
  the whole surface, making every knob discoverable and tunable at runtime
  (`EAGENT_CONFIG=off`).
- **Every `EAGENT_*` env var except the two secrets** (`EAGENT_TOKEN`,
  `EAGENT_MEMORY_EMBED_API_KEY`) now flows through `e.config`, and the four
  duplicated hard-coded `maxTurns` constants (`subagents`/`teams`/`sweep-edit`/
  `dynamic-workflow`) are one settable knob each (`EAGENT_SUBAGENTS_MAX_TURNS`,
  `/config set subagents.maxTurns 12`, or a `config.json` entry) — no source edit
  required. Every legacy env-var name still works via an alias map; a config file
  lives at `~/.eagent/config.json` then `./.eagent/config.json` (project wins).
- **Behavior change (intentional):** the five `/x on|off` toggles that used to
  mutate `process.env` now write the persisted override, so `/x off` survives a
  restart and `/x on` no longer clears a shell `EAGENT_X=off` (env-off is now a
  firm operator kill).

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

- **Closed two shell/local-file information-flow guard gaps.** (1) `flow-guard` now holds a
  **network-reaching shell command** (`curl`/`wget`/`nc`/`ssh`/… — classified by reusing `bash-policy`'s
  command parser, so `sudo curl` and `FOO=bar curl` are caught but `echo curl` is not) as egress once the
  session carries **data taint** (a scannable secret entered the transcript). It keys on data taint, not
  the sticky shell-capability taint, so normal multi-command bash never self-gates; `shell:exec` is
  **not** added to the egress-cap set. Closes the `read secret → bash curl evil.com` exfiltration path
  the network-only egress gate missed; the network-command set is store-overridable (`networkCommands`).
  Narrow documented residual: a shell-read secret matching none of the four credential shapes is not
  caught (it sets only capability taint). (2) `content-guard` can now **fence local shell/file-read
  output** (nonce-wrap it as untrusted-for-the-model), closing the local-injection gap where a malicious
  read file or bash output reached the model unfenced. It is **opt-in** — off by default (the lean
  net/mcp fence scope is byte-unchanged), on under the hardened profile or `/config set
  contentGuard.fenceLocal true`. No kernel change.
- **Hardened server profile (`EAGENT_HARDENED=1`).** One host-level switch turns the yolo server into a
  defense-in-depth posture: it enables the enforcing guards that otherwise ship inert — `risk-guard`
  (classify + block dangerous shell commands), `provenance` (injection defense), and `sandbox-tiers` at
  the `workspace-write` tier (confine shell writes to the workspace). It is **orthogonal to `yolo:false`**
  (it does *not* change the capability fallback — capability lockdown is the separate `yolo:false` knob;
  flipping it would deny `shell:exec` and moot the very guards). Applied as a **fail-secure runtime
  `LayeredConfig` preset** — below the env layer, above the override-store — so a stale persisted
  `/config set` cannot weaken it while the env var stays the single escape hatch
  (`EAGENT_RISK_GUARD=off`, `EAGENT_PROVENANCE=off`, `EAGENT_SANDBOX_TIER=<tier>`); **nothing is written
  to disk**, so unsetting the flag reverts cleanly. Host-level (the CLI honors it too — opt-in). No
  kernel change; the non-hardened path is behaviorally unchanged. `hardened: true` also works on
  `createAgentHost`/`createHttpServer`.
- **Capability grants are now revoked on unload/reload.** `grantCapability` was the
  one extension registration not tracked as a `Disposable`, and `CapabilityManager`
  had no revoke — so a granted authority persisted after its extension was unloaded
  or hot-reloaded, and a later/re-registered tool could run without the
  ask-prompt a fresh session requires. `grant` now returns a `Disposable` (with
  reference counting: `#grant` is a multiset, so a shared pattern like `agent:spawn`
  survives until its *last* granter disposes) and the host tracks it like every
  other registration. +2 kernel lines (2246/2250 — no ceiling change).
- **Documented the HTTP server's cross-session isolation posture.** The server
  multiplexes many `session` ids over one set of in-process extensions: per-session
  transcript and usage are isolated, but extension state is not — security guards
  (`write-guard`'s seen-file set, `flow-guard`'s capability taint) and accumulators
  (cost's per-model breakdown and anomaly baseline, drift's turn counter) carry over
  between sessions, so the `session` id is a multiplexing key, **not** a trust
  boundary. `SECURITY.md` now states this and prescribes **one process per tenant**
  for multi-tenant use; the server prints the posture at startup and `README` points
  to it. In-process per-session isolation was scoped and deliberately **not** built:
  a design review found it a ~15-extension, all-or-nothing change (partial isolation
  would look isolated while leaking security decisions across tenants), and process
  isolation is the production-standard boundary the server already supports. The
  twice-reviewed design is retained as a follow-up
  (`docs/design/2026-07-10-session-isolation.md`).
- **Built-in `read`/`edit`/`grep` are now memory-bounded.** They previously
  `readFileSync`'d whole files, so one hostile multi-GB file could OOM the process
  — and because the HTTP server runs one turn at a time in one process, that took
  down every session. A new `lib/read-capped.ts` `readFileCapped` (a `statSync`
  guard + a single bounded read) caps each read at `fs.maxReadBytes` (default 16
  MiB): `read` returns a truncation-marked window, `grep` scans a bounded window,
  and `edit` **refuses** an over-cap file rather than bounded-reading and writing
  back a silently-truncated version.
- **MCP stdio subprocesses no longer inherit the full host environment.** The
  stdio transport spawned servers with `{ ...process.env, ...def.env }`, handing
  every host env var — API keys, `EAGENT_TOKEN` — to third-party MCP server code.
  The subprocess env is now built default-deny: a minimal base set (PATH, HOME,
  locale, OS essentials) so the server can run, plus the server's own `env` config,
  plus an operator opt-in `mcp.envPassthrough` (comma-separated var names). The
  stdio `request()`/`initialize` handshake also gained the timeout it lacked (a
  ref'd timer, unified with the HTTP transport under `mcp.requestTimeoutMs`,
  default 60s) so a silent server can no longer hang activation or a turn.
- **content-guard fence is now non-forgeable (prompt-injection hardening).** The
  ingress provenance envelope was defeatable two ways: foreign content that began
  with the public standing note skipped fencing (prefix-spoof), and content
  containing the literal `</untrusted-content>` closed the fence early so its tail
  read as trusted (break-out). The envelope tag now carries a per-activation random
  nonce (`<untrusted-content-{nonce}>`), so foreign content can forge neither the
  opening tag (idempotency now keys on it) nor the closing tag; the body's own
  fence sentinels are additionally escaped. No behavior change for legitimate results.
- **Sub-agent recursion guard is now capability-based, not name-based.** Four
  spawners (`subagents`, `templates`, `reasoning-search`, `dynamic-workflow`) built
  a child's tool registry by stripping spawn tools **by name**, so a child kept
  every *other* spawn tool (`run_workflow`, `run_team`, `spawn_template`, …) and
  could spawn grandchildren — the "runaway tree is impossible" guarantee was false.
  All four now delegate to one shared helper (`lib/child-registry.ts`) that strips
  every tool whose capabilities intersect `SPAWN_CAPS = {agent:spawn, workflow:run}`
  (the single source of truth, hoisted out of `teams.ts`), matching the already-
  correct `teams`/`subagent-jobs` pattern. A child now holds no spawn tool at all,
  so depth is bounded to one nesting level by construction. Additionally,
  `spawn_agent`'s `parallel`/`chain` fan-out is capped at `subagents.maxFanout`
  (default 16) to prevent a single call spawning unbounded children. No kernel change.
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

- **Packaging & ops hardening.** `package.json` now declares top-level `main`/
  `types` (fallback for non-`exports`-aware tooling) and a `prepublishOnly` build
  hook so a publish never ships stale/absent `dist/`. The Docker HTTP quickstart is
  corrected (a container server must `EAGENT_HOST=0.0.0.0` to be reachable via `-p`,
  which fail-closed requires `EAGENT_TOKEN`). `SECURITY.md` now points to GitHub's
  private vulnerability-advisory channel instead of public issues. CI runs the build
  job on a Node 22 **and** 24 matrix (they differ in timer/AbortSignal semantics).
  A new **tag-triggered release workflow** (`.github/workflows/release.yml`) runs the
  full gate (typecheck/test/eval/build) and then `npm publish --provenance` — binding
  each published tarball to its workflow run + commit via OIDC (`id-token: write`) so
  consumers can verify the build's origin. Fires only on a `vX.Y.Z` tag that matches
  the `package.json` version (a mismatch fails the run); needs an `NPM_TOKEN` repo
  secret. Provenance is a CI-only `--provenance` flag, not `publishConfig`, so a local
  `npm publish` is not forced into the OIDC-only path.
  The **`test/` tree is now type-checked** — a large body of code (112 `.ts` files) that had no static
  guarantee (the build `tsconfig.json` excludes `test/`; `npm test` runs via transpile-only `tsx`). A new
  `tsconfig.test.json` (a `noEmit` config inheriting every strict flag) + `npm run typecheck:test` hold
  tests to the same bar as `src`, wired as a CI gate. Fixed the 8 latent type errors it surfaced across 5
  files (handler expression-bodies returning a value where `void` is required, an unguarded
  `noUncheckedIndexedAccess`, a too-narrow test-helper param, and one `.ts` import specifier → `.js`) —
  all behavior-neutral. The build/publish path is untouched (`test/` stays excluded from the emit config).
- **`trace` closes tool spans by call id, not name.** Two concurrent same-named
  tool calls (e.g. two `bash`) were mis-attributed because the span was matched by
  tool name; it now matches the call `id` stamped at `tool_start`, so overlapping
  same-name calls get their own durations/ok status.
- **`--json` mode now emits clean JSONL on stdout.** In `--json` (programmatic)
  mode the batch input echo (`› …`), slash-command output, and dispatch/run error
  lines were written to stdout un-gated on the mode, so `echo … | eagent --json`
  interleaved non-JSON lines that broke a consumer's per-line `JSON.parse`. Those
  human/diagnostic writes now route to stderr in `--json` mode (human-mode output
  is unchanged). Adds the first `test/cli.test.ts` (a subprocess integration test
  asserting stdout is pure JSONL).
- **Every extension provider sub-call now has a deadline.** Eight extensions
  (`compact`, `routing`, `drift-probe`, `goal`, `handoff`, `session`, `evals`,
  `reasoning-search`) made an LLM sub-call (`provider.stream` outside the main
  loop) with a fresh, never-aborted `AbortSignal` (six) or no timeout at all
  (two), so a hung provider could wedge a whole turn indefinitely with no
  cancellation path. All eight now run through a shared `lib/sub-call.ts` helper
  that bounds the call with a ref'd-timer deadline (`<ext>.subCallTimeoutMs`,
  default 30s) plus — at the two tool-execute sites — the caller's abort signal;
  on timeout it throws, and each site's existing fail-open/fail-closed `catch`
  converts it to the established fallback. Mirrors the `risk-guard` timeout
  pattern; no kernel change.
- **Provider honesty & resilience.** Three source-level provider fixes so the
  default (Anthropic) stack behaves correctly: (1) an in-transcript `role:"system"`
  message is now **folded into the top-level system channel** on Anthropic and
  Gemini instead of being silently dropped — so the context-injecting extensions
  (`context-files`, `skills`, `goal`, `drift-probe`, `playbook`, …) are no longer
  dark on the default provider (OpenAI already preserved them). The systemPrompt
  cache breakpoint is preserved and the no-note path is byte-identical. (2) A
  **mid-stream API error frame now surfaces as a thrown error** on all three
  providers (Anthropic `error` event, OpenAI/Gemini top-level `error`) instead of
  ending the stream with a fabricated `done` and truncated content — so an outage
  is retried (`onProviderError`/`reliability`) or fails honestly, never presented
  as a successful short answer. (3) **Output `max_tokens` is now configurable**
  per provider (`providers.<name>.maxTokens`, env `ANTHROPIC_MAX_TOKENS` /
  `OPENAI_MAX_TOKENS` / `GEMINI_MAX_TOKENS`), defaulting to 4096, via an exported
  `buildProviders(config)` host helper. `isSecretKey` no longer masks token-count
  keys in `/config`. No kernel change.
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
- **`checkpoint` auto-snapshot now runs git asynchronously, serialized, plus an
  `EAGENT_CHECKPOINT=off` kill switch.** The per-mutating-call snapshot no longer
  blocks the event loop (`promisify(execFile)` instead of `execFileSync`), and every
  snapshot — the auto-hook and the manual `/checkpoint` — is serialized through one
  per-activation queue so concurrent tool-call waves can't race on checkpoint ids or
  refs; snapshot-before-mutation ordering is preserved. The (default-on) extension
  also honors the house opt-out convention via the kill switch.
- **`otel-exporter` emits a third metric: `gen_ai.client.operation.duration`** — the
  OTel GenAI semconv Histogram of per-call inference latency (seconds, advisory
  buckets), giving an SLO/alerting consumer the latency *distribution* (p50/p90/p99)
  that the existing Sum counters cannot. Additive; inert without a metrics endpoint.
- **The HTTP server no longer persists a session on a turn aborted before any
  response.** A `/run` cancelled mid-first-turn left a bare `[user]` transcript that,
  once persisted, would form two consecutive user messages on the next `/run` (which
  strict providers reject); the server now skips persisting a transcript that ends on
  a user turn, keeping the session's last valid state.
- **`memory` recall gained an optional semantic (embedding) tier.** When
  `EAGENT_MEMORY_EMBED_ENDPOINT` is set, `recall(query)` ranks notes by embedding
  cosine similarity (a zero-dep `fetch` embedder, like the chat providers) instead of
  lexical token overlap — finding paraphrases lexical misses. Off by default (lexical
  unchanged), **fail-soft** (any embed error falls back to lexical), `EAGENT_MEMORY_EMBED=off`
  kill switch.
- **`risk-guard` now decodes obfuscated payloads hidden in individual arg values.**
  Its pre-inspection decode previously scanned only the whole args blob, so a rot13'd
  command tucked in one argument value slipped past; it now also decode-normalizes each
  string-leaf value (base64/hex/rot13), surfacing the real command to the judge.
- **`memory` can auto-promote a hot archived note back to core.** Set
  `EAGENT_MEMORY_PROMOTE_AT=<n>` and a note returned by `recall` `n` times moves from
  the archive tier back to core. Off by default (recall stays read-only).
- **`graph_search` can refine to convergence.** A new optional `refineRounds` runs the
  refine pass up to N times, stopping early the first round that doesn't improve the
  best node. Default 1 (a single pass, unchanged).
- **OTel trace-context propagation into tool HTTP.** When traces are on, `otel-exporter`
  publishes each tool-call span as a W3C `traceparent`; `web` (the fetch tool) and `mcp`
  inject it onto outbound requests to hosts in `EAGENT_OTEL_PROPAGATE_HOSTS`, so a
  downstream instrumented service becomes a child span of the tool call. Allowlist is
  empty by default (nothing injected; headers byte-identical).
- **HTTP server request-lifecycle hardening.** A client socket reset no longer crashes the
  host (a response `'error'` is absorbed); the 500 fallback can't throw `ERR_HTTP_HEADERS_SENT`;
  the per-session state map is now **LRU-bounded** at `EAGENT_MAX_SESSIONS` (default 1000;
  `0` disables); the server and CLI dispose the host on an error exit; and shutdown is idempotent.
- **Provider SSE reads are bounded.** The shared `parseSSE` reader (openai/anthropic/gemini) caps a
  single un-terminated event at `EAGENT_MAX_SSE_EVENT_BYTES` (default 16 MiB) instead of buffering a
  no-terminator stream without bound — an OOM/DoS guard.
- **MCP transport reads are bounded (SRV-4b).** A hostile or broken MCP server can no longer OOM the
  host: both MCP transports cap a single read at `EAGENT_MAX_MCP_READ_BYTES` (default 16 MiB). The HTTP
  transport bounds its SSE/JSON response read and throws on overflow; the stdio transport replaces the
  unbounded readline with a byte-bounded line reader (discard-to-newline, whole-line UTF-8 decode). The
  shared byte-window reader `readCapped` moved to `src/extensions/lib/read-capped.ts` so both `web` and
  `mcp` reuse it — mirroring the SSE cap above.
- **Security-guard hardening.** `secret-guard`/`flow-guard` arg scans are depth-bounded (a deeply-nested
  payload can't overflow the stack past a scannable secret / nest a sensitive path out of reach), and
  `risk-guard`'s classifier sub-call is bounded by a timeout (a hung provider fails open instead of
  blocking the tool gate forever).
- **Concurrent capability prompts are de-duplicated.** Under a parallel tool wave, two calls needing the
  same not-yet-granted `ask`-fallback capability now share **one** confirm instead of prompting the human
  twice (an in-flight memo in the kernel `CapabilityManager`).
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
