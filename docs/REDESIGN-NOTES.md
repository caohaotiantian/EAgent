# EAgent — Architectural Review & Redesign Notes

**Date:** 2026-06-16
**Inputs:** the whole-project code review (`CODE-REVIEW-2026-06-16.md`), a live end-to-end test
against a GLM-5.1 endpoint, and verified design research (`RESEARCH-agent-kernel-design.md`).
**Verdict:** keep the architecture. The seven-primitive core is sound and well-precedented; the work
is hardening and one principled extension, not a redesign.

---

## 1. The core thesis holds — with external evidence

EAgent bets on a *small, stable, mechanism-only core* with *unbounded extensibility*. The research
puts that bet on solid ground:

- **Mechanism, not policy** is the principle behind the most durable extensible systems. seL4's
  designer frames policy-freedom as a *consequence* of minimality — "build everything on top." EAgent
  says the same thing in `CLAUDE.md` and enforces it with the `kernel-surface` guard test.
- **VS Code is the closest production precedent**: a curated, strictly-controlled API; behavior in
  extensions; the core oblivious. EAgent's `ExtensionAPI` is the same discipline.
- **The seven primitives are expressively complete** for the paradigms that matter. ReAct = agent
  loop + tool registry. CodeAct = the `codeact` extension. Voyager's lifelong skill library =
  `skills` + `self` + `memory`. CoALA's memory/action/decision taxonomy maps cleanly onto the
  registries, the loop, and the hook bus. Nothing in scope required a new primitive.
- The verifiers **refuted** the two tempting over-simplifications — "a single loop is enough" (0-3)
  and "everything is just a tool" (0-3). That validates keeping the primitives *distinct*: memory,
  sub-agents, planning, and commands are not all "tools." EAgent already resists that collapse.

**Conclusion:** do not grow the core. The minimalism guard (`test/kernel-surface.test.ts`) is the
single most valuable test in the repo; keep it strict. The only kernel-surface change this pass was
`isMessage`, a guard for the core `Message` type — a conscious, justified addition.

## 2. The real frontier is security, not expressiveness

The most important research result: **per-tool capability gating is necessary but not sufficient.**
Demonstrated, reproducible exploits — tool-poisoning exfiltrating SSH keys, cross-server tool
*shadowing* redirecting email, the Supabase `service_role` confused-deputy — all defeat per-call
authorization, because each call *in isolation* is allowed. The gap is **capability chaining**:
`read a secret` + `reach the network` = exfiltration.

This is exactly the kind of new best practice EAgent is designed to absorb **as an extension, not a
core fork** — and that's what was built:

- **`flow-guard`** (new, shipped, tested) rides two primitives the core already exposes — the
  `tool_end` event (observe which authority has been used) and the `beforeToolCall` filter (intervene
  before egress). When a `shell:exec` tool has run, a later `net:fetch` call is held (confirm in
  `ask` mode, refuse in `block`). Zero kernel changes. This is the thesis demonstrated end to end: a
  2025/26-era threat class answered by a hot-reloadable module.

Several review fixes already moved EAgent toward the research's four-property defense model:

| Property (from the research) | EAgent today |
| --- | --- |
| **Privilege boundedness** | capability layer; narrow non-ambient grants; `shell:exec`/`net:fetch` not auto-granted; server now loopback + constant-time auth |
| **Tool integrity** | extension id-collision now tears the prior down (was a silent shadow leak); MCP `tools/list` is shape-validated |
| **Context isolation** | untrusted code routed out-of-process (MCP, codeact); codeact cwd/HOME scrubbed |
| **Data confinement** | *partial* — `flow-guard` taints the session on sensitive-path reads and credential-looking results, and gates egress on it; full information-flow tracking remains future work |

## 3. Anti-patterns avoided (and to keep avoiding)

- **Config bankruptcy** (the Emacs/Doom failure mode): keep behavior in scoped extensions with their
  own `store`, not a sprawling global config. EAgent's per-extension namespaced store is the explicit
  fix for Emacs's global mutable state.
- **Core creep**: resist folding new behavior into the kernel "for convenience." The guard test makes
  this a deliberate decision every time.
- **Silent shadowing**: "later wins" is right for reload, but a *different-origin* registration
  shadowing an existing name is a trust event. Fixed for extension ids; MCP duplicate-server-name
  shadowing is the remaining warn-worthy case (tracked, low severity).
- **Ambient authority**: never hand a tool more than it needs; the confused-deputy breach is what
  ambient over-authority looks like.

## 4. Forward agenda (not done; deliberately scoped out)

In rough priority:

1. **Chaining-aware policy, generalized.** `flow-guard` covers the high-signal `shell→net` chain.
   A fuller policy could track more source/egress pairs and longer sequences, ideally driven by the
   capability audit log rather than ad-hoc state.
2. **Data confinement / taint.** Track which messages carry sensitive data and gate egress on it —
   the only one of the four properties EAgent doesn't yet approximate.
3. **Shadow-as-event.** Consider a `tool_shadowed` signal (or an MCP-side warning) so collisions are
   observable, not silent.
4. **Extension-to-extension isolation.** In-process `jiti` gives none (same as VS Code's host). The
   honest boundary stays: trusted in-process, untrusted out-of-process. Revisit only if untrusted
   in-process extensions become a goal.
5. **Tool-poisoning awareness.** MCP tool *descriptions* are attacker-controlled text in the model's
   context; narrow capabilities limit blast radius, but surfacing/diffing description changes would
   help.

## 5. Bottom line

The review found localized robustness/security/ergonomics gaps — 35 of 40 fixed this pass, all
high/medium included, with the suite green (192 tests) and the live endpoint re-verified. The
research found no structural flaw and no missing primitive. The single most valuable architectural
move — a compositional capability policy — was added the way the architecture intends: **as an
extension.** EAgent should keep the core frozen, keep the guard test strict, and keep absorbing new
best practices the way `flow-guard` was absorbed.
