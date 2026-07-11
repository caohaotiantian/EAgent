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
  the transcript — confirming in `ask` mode or refusing in `block` mode.
- **Cross-session isolation in one process.** The HTTP server multiplexes many
  `session` ids over **one** set of in-process extensions. Per-session *transcript*
  and *usage* are isolated, but **extension** state is not — several guards and
  accumulators carry over between sessions. `write-guard`'s seen-file set,
  `flow-guard`'s capability taint, and goal/todo reset only at session
  start/shutdown — both fired **once**, at startup and teardown — so they never
  clear between sessions; cost's per-model breakdown and anomaly baseline, and
  drift-probe's turn counter, are module-lifetime accumulators with no per-session
  reset. (Figures mirrored from the per-session *usage* — cost/budget cumulative
  USD — do track the acting session; the leak is the guards and the accumulators,
  not the running totals.) The
  `session` id is a multiplexing key, **not** a trust boundary. Isolate tenants at
  the process boundary (below), not by the `session` id.

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
Extension state is shared across `session` ids within a process (see "Cross-session
isolation" above), so the process — not the session id — is the isolation boundary.
A single shared process is appropriate only when every session belongs to the same
trust domain (one user, one tenant, or an already-sandboxed workload).

## Reporting

**Report a vulnerability privately** — do not open a public issue for anything
exploitable. Use GitHub's private advisory form ("Report a vulnerability" under the
repository's **Security** tab: https://github.com/caohaotiantian/eagent/security/advisories/new),
which keeps the report confidential until a fix ships. Please include a description,
affected versions/commit, and reproduction steps. We aim to acknowledge within a few
days. Non-sensitive hardening suggestions can still go to the public issue tracker.
