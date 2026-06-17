# Research — Minimalist, Extensible Agent Kernels

**Question:** How should one build an AI agent with a *minimalist, stable core*
plus *unbounded, Emacs-grade extensibility*, so emerging best practices are
absorbed as extensions rather than core forks — and where does EAgent's
seven-primitive kernel sit in that design space?

This is the standing design-rationale and threat-model reference behind EAgent's
architecture. The companion [`REDESIGN-NOTES.md`](REDESIGN-NOTES.md) records how
the current code embodies these conclusions.

---

## TL;DR

EAgent's minimalist-core bet is **well-founded and well-precedented**. A general
kernel that ships zero opinions and pushes behavior into extensions is the
*mechanism-not-policy* principle behind the most durable extensible systems (seL4,
VS Code). The seven primitives can express every agent paradigm in scope — CoALA,
ReAct, CodeAct, Voyager — as capability-gated extensions, several already shipped
(`codeact`, `skills`).

**The dominant risk is security, not expressiveness.** Demonstrated, reproducible
exploits prove that per-tool capability gating is *necessary but not sufficient*:
composing individually-safe tools (read-file + send-network) yields exfiltration
that no per-call check catches. The forward agenda is therefore *defense-in-depth*,
not more primitives.

---

## 1. Extensible-core architectures as precedent

- **Mechanism, not policy** is the validated foundation. seL4's designer (Heiser):
  policy-freedom is a *consequence* of minimality and generality — "focus on basic
  mechanisms and build everything on top." This is precisely EAgent's thesis.
  Caveat: not absolute — all L4 kernels still keep an in-kernel scheduler, and
  minimality gives no *strict mechanical rule* for what belongs in the kernel. The
  core/extension line is a judgment call, not a theorem.
- **VS Code is EAgent's closest production precedent.** Extensions run in a
  separate host so a misbehaving one can't break startup; no DOM access; a curated,
  strictly-controlled API surface. Important nuance: VS Code's extension host is
  single-threaded, so a blocking extension stalls *other* extensions — **there is
  no extension-to-extension isolation.** EAgent's in-process `jiti` host has the
  same property, and draws the same correct line: trusted code in-process,
  untrusted code behind a process/VM boundary.
- **Direction of travel:** Anthropic renamed "Claude Code SDK" → "Claude Agent
  SDK" as the harness generalized beyond coding — evidence that a stable, general
  harness plus pluggable behavior is where the industry is heading.

## 2. Foundational paradigms — all expressible as extensions

The kernel was stress-tested against the canonical agent papers. Each maps onto
existing primitives:

| Paradigm | What it needs | In EAgent |
| --- | --- | --- |
| **ReAct** (ICLR'23) | interleave reasoning + tool actions | agent loop + tool registry |
| **CodeAct** (ICML'24) | executable code as a unified action space — outperforms JSON/text by up to ~20% (best case; wins on ~12/17 LLMs) | `codeact` extension |
| **Voyager** (NeurIPS'23) | ever-growing executable-code **skill library**, refined by execution feedback + self-verification (most load-bearing component: ~73% drop in ablation) | `skills` + `self` + `memory` |
| **CoALA** (TMLR) | memory + structured action space + decision loop; actions = retrieval / reasoning / learning + grounding | tool registry + agent loop + hook bus + `memory` |

**Use CoALA as a coverage checklist** (memory / action / decision) and **Voyager
as the template for absorbing best practices** — accumulate verified skills, never
fork the core.

**Two over-simplifications to resist:**
- "A single minimal loop suffices to express agent behavior" — false.
- "Everything is a tool / a tool-registry-centric core" — false. *Keep the seven
  distinct primitives; do not collapse memory, sub-agents, planning, and commands
  into "just tools."*

## 3. Security & capability model — the real frontier

- **Per-tool gating is necessary but not sufficient.** Capability *chaining*:
  `read-file` + `send-email` are each safe, but composed they exfiltrate. The
  defense is a **composition policy that reasons over tool *sequences* within a
  session**, not just per call.
- **Tool poisoning is real and reproducible.** A trivial `add` tool with hidden
  instructions in its *description* exfiltrated an SSH key and `mcp.json`; a
  cross-server **shadowing** PoC redirected all emails to an attacker *even when
  the user named another recipient* (OWASP MCP03:2025, CVE-2025-54136). →
  **Registry "later wins" shadowing should be a trust-boundary event, not a silent
  override.**
- **Confused deputy is real.** The Supabase/Cursor PoC: an agent holding an
  over-privileged `service_role` credential followed an injected prompt to read a
  protected table and write it back publicly. → Validates EAgent's narrow,
  non-ambient capability grants.
- **Defense-in-depth.** No single MCP defense covered more than ~34% of threats; a
  layered architecture reached a *theoretical* 91%, targeting four properties:
  **tool integrity, data confinement, privilege boundedness, context isolation.**
  (The 34/91 figures come from an unrefereed preprint — treat as directional; the
  four-property framing is the durable takeaway.)

## 4. What this means for EAgent

**Keep doing (validated):** the minimalist mechanism-not-policy core;
everything-is-an-extension; capability-gated tools; trusted-in-process /
untrusted-out-of-process (MCP, codeact) boundary; CodeAct plus a verified skill
library as the path to absorb new behavior.

**The one substantive gap — and why the architecture already answers it:**
per-tool gating doesn't catch capability chaining. The principled fix is **a
policy *extension*, not a core change** — it rides the existing `beforeToolCall`
filter (intervene) and the `tool_end` event / capability audit (observe) to reason
about tool *sequences*. This is the thesis in action: a brand-new security best
practice absorbed as a hot-reloadable extension. EAgent ships it as **`flow-guard`**
(compositional egress gating) and **`integrity`** (tool-description poisoning and
rug-pull detection); see [`REDESIGN-NOTES.md`](REDESIGN-NOTES.md) for the current
posture against the four-property model.

**The frontier that remains:** chaining-aware policy over longer multi-step
sequences; taint that follows data through model-derived summary prose;
cryptographic tool attestation; and extension-to-extension isolation under
in-process hot-reload (the research-endorsed honest boundary, not a defect).

## Sources (primary, verified)

- seL4 design principles — https://microkerneldude.org/2020/03/11/sel4-design-principles/
- VS Code extension patterns & principles — https://vscode-docs1.readthedocs.io/en/latest/extensionAPI/patterns-and-principles/
- Building agents with the Claude Agent SDK — https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk
- CoALA (TMLR) — https://arxiv.org/abs/2309.02427
- ReAct (ICLR'23) — https://arxiv.org/abs/2210.03629
- CodeAct (ICML'24) — https://openreview.net/pdf/83841e7b4f455993deefb892159741a71a9c6482.pdf
- Voyager (NeurIPS'23) — https://arxiv.org/pdf/2305.16291
- SoK: MCP security (2025) — https://arxiv.org/pdf/2512.08290
- Tool-poisoning attacks (Invariant Labs) — https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks
- Formal MCP security framework (2026 preprint; numbers directional) — https://arxiv.org/pdf/2604.05969
- Capability-based security — https://en.wikipedia.org/wiki/Capability-based_security
- Confused deputy problem — https://en.wikipedia.org/wiki/Confused_deputy_problem

---
*Synthesized 2026-06-16 from a multi-source web sweep with adversarial
claim-verification; figures marked directional come from unrefereed preprints.*
