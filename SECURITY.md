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
  (`fs:read`, `fs:write`, `shell:exec`, `code:exec`, `net:fetch`, `skill:write`,
  `mcp:call`, `agent:spawn`, `pkg:install`). The dispatcher enforces the
  declaration before the tool body runs. The default policy is *ask*: anything
  not explicitly granted prompts the human. A full audit log is available via
  `/caps`.
- **Approval gates.** The `planmode` extension interposes a human approval step
  before any mutating tool runs (`beforeToolCall` advice), independent of the
  capability grant.
- **Filesystem confinement.** The `read`/`write`/`edit` tools are scoped to a
  workspace root (`$EAGENT_WORKSPACE` or the cwd) and reject `../` traversal and
  absolute paths that point outside it.
- **Scrubbed code execution.** `codeact`'s `run_code` runs in a separate OS
  process with a timeout and a minimal environment (no inherited `process.env`),
  so secrets in the parent environment are not handed to generated code.
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
  in a network-restricted environment when handling sensitive data.

## Recommended deployment

Run EAgent inside a container or VM with: a non-root user, a restricted
filesystem mount as the workspace root, a network policy scoped to the providers
and MCP servers you actually use, and no real secrets in the process environment
(pass credentials out-of-band to the specific tools that need them). Keep the
default *ask* capability policy unless the environment is already isolated, in
which case `--yolo` (fallback *allow*) is reasonable.

## Reporting

Open an issue at https://github.com/caohaotiantian/eagent/issues. Please do not
include exploit details that could harm other users in a public issue; request a
private channel first.
