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
  `flow-guard` extension holds later egress (default `net:fetch`) once a session
  is tainted by a source capability (default `shell:exec`) or sensitive data in
  the transcript — confirming in `ask` mode or refusing in `block` mode.

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

## Reporting

Open an issue at https://github.com/caohaotiantian/eagent/issues. Please do not
include exploit details that could harm other users in a public issue; request a
private channel first.
