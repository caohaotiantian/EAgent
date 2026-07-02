# EAgent — Architecture & Security Posture

These notes record *why* EAgent is shaped the way it is and where its security
frontier sits. They are design rationale, not a changelog — release history lives
in `CHANGELOG.md` and git. The conclusions here were checked against the design
research in [`RESEARCH-agent-kernel-design.md`](RESEARCH-agent-kernel-design.md).

**Verdict:** keep the architecture. The seven-primitive core is sound and
well-precedented; ongoing work is hardening and principled extensions, not a
redesign.

## 1. The core thesis holds

EAgent bets on a *small, stable, mechanism-only core* with *unbounded
extensibility*. The research puts that bet on solid ground:

- **Mechanism, not policy** is the principle behind the most durable extensible
  systems. seL4's designer frames policy-freedom as a *consequence* of minimality
  — "build everything on top." EAgent says the same in `CLAUDE.md` and enforces it
  with the `kernel-surface` guard test.
- **VS Code is the closest production precedent**: a curated, strictly-controlled
  API; behavior in extensions; the core oblivious. EAgent's `ExtensionAPI` is the
  same discipline.
- **The seven primitives are expressively complete** for the paradigms that
  matter. ReAct = agent loop + tool registry. CodeAct = the `codeact` extension.
  Voyager's lifelong skill library = `skills` + `self` + `memory`. CoALA's
  memory/action/decision taxonomy maps cleanly onto the registries, the loop, and
  the hook bus. Nothing in scope required a new primitive.
- The research **refuted** the two tempting over-simplifications — "a single loop
  is enough" and "everything is just a tool." That validates keeping the
  primitives *distinct*: memory, sub-agents, planning, and commands are not all
  "tools," and EAgent resists that collapse.

**Conclusion:** do not grow the core. The minimalism guard
(`test/kernel-surface.test.ts`) is the single most valuable test in the repo —
keep it strict.

## 2. The real frontier is security, not expressiveness

The most important research result: **per-tool capability gating is necessary but
not sufficient.** Demonstrated, reproducible exploits — tool-poisoning
exfiltrating SSH keys, cross-server tool *shadowing* redirecting email, the
Supabase `service_role` confused-deputy — all defeat per-call authorization,
because each call *in isolation* is allowed. The gap is **capability chaining**:
`read a secret` + `reach the network` = exfiltration.

EAgent answers this the way the architecture intends — **as extensions, not a core
fork**:

- **`flow-guard`** rides the hook bus at three points: the `tool_end` event
  (observe which authority has been used), the `message` event (tag the
  data-bearing tool-result message), and the `beforeToolCall` filter (intervene
  before egress). Once a session is tainted — by a source capability
  (default `shell:exec`) or by sensitive data in the transcript — a later egress
  call (default `net:fetch` / `mcp:call`) is held: confirmed in `ask` mode, refused in `block`
  mode. The data taint is genuine *information-flow*: it is pinned to the
  tool-result message (`meta.flowGuardTaint`) and egress is gated only while that
  message is in the live transcript, so `/clear` and `/handoff` un-gate. Taint
  through model-derived prose (summaries) and longer multi-hop chains are out of
  scope (see §4).
- **`integrity`** sweeps every registered tool's description for poisoning and
  hidden instructions, and fingerprints descriptions to flag silent changes across
  sessions (the rug-pull / version-swap vector). It observes and warns; it never
  blocks.

Both are zero-kernel-change extensions — a 2025/26-era threat class answered with
hot-reloadable modules. EAgent's posture against the research's four-property
defense model:

| Property | EAgent today |
| --- | --- |
| **Privilege boundedness** | capability layer; narrow non-ambient grants; `shell:exec` / `net:fetch` / `code:exec` are not auto-granted; the server binds loopback with constant-time bearer auth |
| **Tool integrity** | an extension id-collision tears the prior version down (no silent shadow leak); MCP `tools/list` is shape-validated and duplicate server names are skipped; `integrity` scans all tool descriptions and detects cross-session changes |
| **Context isolation** | untrusted code is routed out-of-process (MCP, `codeact`); `codeact` runs with a scrubbed environment (only `PATH` plus a throwaway `HOME`, not the parent's `process.env` wholesale) |
| **Data confinement** | `flow-guard` taints on a source capability or sensitive data and gates egress; the data taint is transcript-level information-flow (message-pinned, un-gates on `/clear` and `/handoff`); taint through summary prose is out of scope |

## 3. Anti-patterns avoided (and to keep avoiding)

- **Config bankruptcy** (the Emacs/Doom failure mode): keep behavior in scoped
  extensions with their own `store`, not a sprawling global config. EAgent's
  per-extension namespaced store is the explicit fix for Emacs's global mutable
  state.
- **Core creep**: resist folding new behavior into the kernel "for convenience."
  The guard test makes this a deliberate decision every time.
- **Silent shadowing**: "later wins" is right for reload, but a *different-origin*
  registration shadowing an existing name is a trust event. Handled for extension
  ids and MCP duplicate-server names.
- **Ambient authority**: never hand a tool more than it needs; the confused-deputy
  breach is what ambient over-authority looks like.

## 4. Deliberate non-goals

These are scoped *out* on purpose — not pending work. Each would either grow the
kernel (against the thesis) or chase a threat the honest boundary already handles:

- **A generic `tool_shadowed` kernel signal** and **richer in-kernel token
  accounting** would each grow the core; deferred until a concrete need justifies
  the surface.
- **Taint through model-derived summary prose** was accepted out of scope by the
  information-flow design — `flow-guard` tracks data, not paraphrase.
- **Extension-to-extension in-process isolation.** In-process `jiti` gives none
  (the same as VS Code's host). The honest boundary stays: trusted in-process,
  untrusted out-of-process. Revisit only if untrusted in-process extensions become
  a goal.

## 5. Bottom line

The research found no structural flaw and no missing primitive. The most valuable
architectural move — a compositional capability policy — was added the way the
architecture intends: **as an extension.** Keep the core frozen, keep the guard
test strict, and keep absorbing new best practices the way `flow-guard` and
`integrity` were. For current status run `npm test`; for history see
`CHANGELOG.md`.
