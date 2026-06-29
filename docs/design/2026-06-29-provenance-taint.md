# Design — Provenance / taint (CaMeL-lite structural injection defense)

**Slug:** `2026-06-29-provenance-taint` · **Wave:** 6 (subsystem 2 of 4) · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P2.1 · **Research:** scratchpad `RESEARCH-FINDINGS-waves-6-8.md` §A

## 1. Background and Purpose

Indirect prompt injection (OWASP LLM01, the #1 agent risk) is defended in EAgent only by heuristics:
`content-guard` (`afterToolCall`) **fences** foreign tool results (net/mcp) so the model treats them as
data; `flow-guard` taints on a few **sensitive-pattern** regexes (keys/paths) or `shell:exec` and gates
**egress** (`net:fetch`). What neither does is the structural CaMeL move: track that a *privileged
side-effecting* call's **arguments derive from untrusted content** and gate *that* call.

Research (CaMeL, *Defeating Prompt Injections by Design*, arXiv 2503.18813; NeuralTrust 10-months-after
analysis) is decisive: the **full** CaMeL design (privileged/quarantined LLM split + a custom data-flow
interpreter) is exactly why it has **not** been adopted — the interpreter is the tax, and it costs real
utility (77% vs 84% on AgentDojo). The adopted-in-practice subset ("CaMeL-lite") is: **tag tool results
with source provenance, propagate immediate dependency, and gate a privileged sink whose args derive
from untrusted content — escalating, not crashing.** That subset maps 1:1 onto EAgent's *existing*
`afterToolCall` + `beforeToolCall` + capability layer, needing **zero kernel change** (important: the
kernel is at 2,182/2,200 lines).

This wave ships a minimal, off-by-default `provenance` extension implementing that arg-derivation gate —
**complementary** to `content-guard` (ingress fencing) and `flow-guard` (sensitive-pattern egress).

## 2. Deliverables

- [ ] **D1** A new `provenance` extension (`src/extensions/provenance.ts`), off by default
  (`EAGENT_PROVENANCE=off` kill switch + a store `enabled` flag defaulting false), declaring **no**
  capability (it routes trust, touches no privileged authority). **No kernel change.**
- [ ] **D2** `afterToolCall` tagger: for a result from a **foreign-source** tool (cap ∈ the foreign set,
  default `["net:fetch","mcp:call","mcp:read"]` — same notion as `content-guard`), split the result
  content into normalized **segments** (lines / whitespace-bounded spans) of length ≥ `minLen` (default
  24) and add them to a bounded closure **untrusted-segment store** (a `Set`, FIFO-capped at N segments /
  total bytes). Load `provenance` **after** `content-guard` in `BUILTIN_EXTENSIONS` so it stores the
  fenced/stripped body the model actually sees (afterToolCall ordering).
- [ ] **D3** `beforeToolCall` gate (single pinned semantics): for a **privileged-sink** tool (cap ∈ the
  sink set, default `["shell:exec","net:fetch","mcp:call","fs:write"]`), flag the call if any string
  argument value **`.includes(segment)`** for any stored untrusted segment (i.e. the arg contains a
  verbatim ≥`minLen` untrusted segment). On a flag, **escalate** by calling `e.agent.ui.confirm(reason)`
  and returning `{…block:true}` on a false answer (default mode); `strict` mode blocks without prompting.
  The reason names the tool and a **redacted** marker of the overlap (length + a hash, never the value).
  Clean (non-derived) calls pass untouched.
- [ ] **D4** A `/provenance [on|off|strict|status]` command — `on` enables in **default** (prompt) mode
  (and reverts from strict), `strict` enables in strict (block-without-prompt) mode, `off` disables; the
  sink/foreign sets + min-length are
  store-overridable.
- [ ] **D5** Registered in `BUILTIN_EXTENSIONS` (`host.ts`). Tests; the Wave-1 canonical-set host test
  absorbs the +1 extension automatically.

## 3. Scope Boundary (NOT in scope)

- **No** full CaMeL interpreter / privileged-quarantined LLM split / data-flow graph (the research's
  explicit "don't build this" — interpreter tax + utility loss).
- **No** kernel change: no `ToolResult.provenance` field. Provenance lives in the extension's **closure
  state** (like `flow-guard.tainted`/`write-guard.seen`), read/written via the existing seams. (Keeps the
  kernel under 2,200 and the taint a pure extension convention, per the blueprint anti-recommendation.)
- **No** duplication of `content-guard` (it *fences/labels* foreign ingress; provenance *gates sinks* on
  arg-derivation) or `flow-guard` (it taints on *sensitive patterns* → *egress*; provenance taints by
  *source* → *any privileged sink*). Documented complementary (KDD-1).
- **No** transitive/multi-hop data-flow tracking — only **immediate** substring derivation (CaMeL-lite),
  not a full lineage graph.
- **On by default? No** — ships off (opt-in), like `fallback-routing`/`reliability` (NOT like
  `content-guard`/`flow-guard`/`secret-guard`, which default **on**), because an arg-derivation gate can
  have false positives and changes tool-call behavior; a deployment opts in knowingly.

## 4. Key Design Decisions

### KDD-1 — Complementary to content-guard / flow-guard (not a duplicate; the key Simplicity decision)
*Problem:* `content-guard` and `flow-guard` already touch "untrusted data." Does provenance duplicate
them? *Options:* (a) upgrade `flow-guard` to do arg-derivation; (b) a new `provenance` extension on a
distinct axis. *Choice:* **(b)** — the three occupy distinct axes: `content-guard` = *ingress labeling*
(fence foreign results), `flow-guard` = *sensitive-pattern → egress* gate, `provenance` = *source-taint +
arg-derivation → any privileged sink* gate. Provenance is the structural CaMeL-lite piece neither
provides (gate a `shell:exec`/`fs:write` whose args came from a fetched web page, even with no
sensitive-pattern match). The three are **independently toggleable** (content-guard/flow-guard default
on; provenance off); duplication is avoided by the **distinct axes**, not by on/off state. A future
consolidation of flow-guard's data-taint into provenance is a deferred follow-up. *Rejected:* (a) bloats
flow-guard and couples two distinct policies.

### KDD-2 — Immediate derivation via segment containment with a min-length floor
*Problem:* how to detect "arg derives from untrusted content" cheaply without a data-flow graph or false
positives? *Options:* (a) full lineage tracking; (b) longest-common-substring between arg and each
untrusted entry (expensive, needs rolling-hash/suffix structures); (c) **segment containment**: at tag
time split untrusted content into ≥`minLen` (default 24) normalized segments into a `Set`; at gate time
flag if any string arg `.includes(segment)`. *Choice:* **(c)** — the CaMeL-lite "track immediate
dependency" (NeuralTrust) realized as cheap `Set` membership / `String.includes` (O(args × segments),
both bounded), no interpreter; the `minLen` floor kills the one-word-overlap false-positive class.
**Known limitation:** catches only a verbatim ≥`minLen` *segment* copy — a paraphrase, a re-encoding, or
a run spanning segment boundaries below `minLen` is not caught (defense-in-depth, not provable security;
consistent with off-by-default and §3's no-lineage scope). *Rejected:* (a) is the interpreter tax the
research says kills adoption; (b) is needlessly expensive for marginal recall over (c).

### KDD-3 — Escalate via `ui.confirm`, fail closed (recover CaMeL's utility loss in interactive use)
*Problem:* CaMeL's hard blocks cost 7 pts of utility. *Options:* (a) always block tainted sink calls;
(b) prompt the human via `e.agent.ui.confirm` inside the gate (default mode) and block on a `false`
answer; `strict` mode blocks without prompting. *Choice:* **(b)** — summarizing an untrusted email stays
allowed; only *feeding it to a privileged sink* prompts. In **interactive** (CLI) use this recovers most
of the utility loss (the human approves legitimate flows); when **non-interactive** (`confirm`→`false`
default, `agent.ts:560`/`server.ts:103`) it **fails closed** (blocks) — the safe, sibling-consistent
posture (`flow-guard`/`secret-guard` do the same). *Rejected:* (a) over-blocks even when a human is
present to approve. (Note: provenance is **off by default**, so a headless deployment opts in knowingly.)

### KDD-4 — Closure state, no kernel field (ceiling-safe; works for children)
*Problem:* where does provenance live? *Options:* (a) add `ToolResult.provenance` to the kernel; (b) a
bounded closure store in the extension. *Choice:* **(b)** — no kernel growth (the kernel is at 2,182/2,200),
and because `beforeToolCall`/`afterToolCall` are in `SHARED_FILTER_POINTS` (Wave 3), the closure store
accumulates a **child's** untrusted results and gates a child's sink calls too — so provenance governs
sub-agents (unlike flow-guard's `e.agent.messages` read), partially addressing the deferred RW3-1. The
store is bounded (cap N entries / total bytes) to avoid unbounded growth. *Rejected:* (a) spends scarce
kernel lines on what an extension convention does fine (blueprint anti-recommendation).

### KDD-5 — Sink/foreign sets as store-overridable policy tables
*Problem:* which caps are "foreign sources" and "privileged sinks"? *Options:* (a) hardcode; (b)
store-overridable defaults (foreign = `net:fetch`/`mcp:call`/`mcp:read`; sink = `shell:exec`/`net:fetch`/
`mcp:call`/`fs:write`). *Choice:* **(b)** — mirrors `flow-guard`/`secret-guard`/`content-guard` config
posture; lets a deployment tune the policy table (CaMeL's "policy as a lookup table"). *Rejected:* (a)
inflexible.

## 5. Dependencies and Assumptions

Independent of the other Wave-6 subsystems. Rides the existing `beforeToolCall`/`afterToolCall` seams and
`capsOf(name) = e.agent.tools.get(name)?.capabilities` pattern (used by `content-guard.ts:114`,
`flow-guard`, `secret-guard`). **Escalation mechanism (corrected):** a `beforeToolCall` filter cannot
return "ask" (`ToolDecision` is `{ block, reason?, arguments }`, `events.ts:54`); it escalates by calling
`await e.agent.ui.confirm(reason)` **inside** the filter and returning `{ ...d, block: true, reason }` on
a `false` answer — exactly the `flow-guard.ts:178-179` / `secret-guard.ts:124-125` pattern. The kernel
and server default `confirm` to `false` (`agent.ts:560`, `server.ts:103`), so provenance **fails closed**
(blocks the tainted sink call) when non-interactive — matching the sibling guards, NOT "falling back to
allow." In interactive (CLI) use the human is prompted and may approve; in `strict` mode it blocks
without prompting. `capsOf` resolves through `e.agent.tools` (parent registry), so a child-only-registered
tool isn't classified — same limitation as the sibling guards, fine for the shared-tool case (AC-7).
Assumes string args are the injection vector (object/number args are not substring-matched). No deps.

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P2.1; research scratchpad §A. Complementary to
`2026-06-22-content-guard.md` (ingress fence), `2026-06-20`-era `flow-guard` (sensitive→egress),
`2026-06-22-secret-guard.md` (secret-leak). Partially addresses the Wave-3 deferred **RW3-1** (data-taint
for children) via shared-closure governance. No kernel change → no filter-count / kernel-surface impact.
README extension table gains a `provenance` row; reconciled at F.

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` exits 0. **AC-2** `npm test` exits 0 (existing + new).
- **AC-3 (gate on derived arg)** With `provenance` on: a foreign-cap tool returns content containing a
  distinctive ≥`minLen` segment S; a later `shell:exec`/`fs:write` call whose arg `.includes(S)` is
  **escalated** — in default mode `e.agent.ui.confirm` is consulted and the call is **blocked** when
  confirm returns false (test with a stub UI returning false → blocked; returning true → allowed); in
  `strict` mode it is blocked without consulting the UI.
- **AC-4 (clean arg passes)** A privileged-sink call whose args do **not** contain any untrusted substring
  is **not** escalated (no prompt/deny) — guards the false-positive boundary; and a short common-word
  overlap below the min length does **not** trigger.
- **AC-5 (non-sink untouched)** A non-privileged tool (cap not in the sink set) is never escalated even if
  its args derive from untrusted content (only *sinks* are gated).
- **AC-6 (off by default)** With the extension loaded but not enabled, a derived sink call is **not**
  escalated (inert).
- **AC-7 (governs children)** A `childScope` sub-agent whose foreign read taints the store and which then
  calls a sink with the derived arg is escalated (shared-closure governance) — pins the RW3-1 partial fix.
- **AC-8** Host canonical-set test green (`BUILTIN_EXTENSIONS.length` +1; no dup tool/command names).

*Quality budget:* per sink call, O(stringArgs × storedSegments) `String.includes` over the FIFO-capped
segment `Set` (both bounded by config); negligible, not a hot path beyond the existing per-call gate. Excluded.

## 8. Risks and Rollback

- **R1 — False positives** (a legitimate arg coincidentally contains untrusted text). *Mitigation:* the
  min-length floor (KDD-2) + escalate by **prompting** (default mode `ui.confirm`, not a hard deny — KDD-3)
  + off-by-default + tunable policy. *Rollback:* `/provenance off` or the kill switch.
- **R2 — Overlap/confusion with flow-guard/content-guard.** *Mitigation:* KDD-1 documents the distinct
  axes (the real separator — content-guard/flow-guard default on, provenance off, but it's the axes not
  the on/off that prevent duplication); the README row states the difference. *Rollback:* n/a.
- **R3 — Unbounded untrusted store.** *Mitigation:* hard cap (N entries / total bytes), FIFO eviction.
  *Rollback:* n/a.
- **R4 — Secret echoed in the escalation reason.** *Mitigation:* the reason names the tool + a redacted
  marker (the overlap **length** + a hash of the overlap — never any byte of the value), mirroring
  `secret-guard`'s redaction posture. *Rollback:* n/a.
- **R5 — README extension table stale.** *Mitigation:* reconcile at F.

A single off-by-default extension + host registration; reverting the registration removes it cleanly.

## L1 Review Log

- **Round 1** — **SEVERE**: the non-interactive fallback claim was factually wrong + self-contradictory
  (kernel/server default `confirm`→false; siblings fail CLOSED, not "fall back to allow"). + general
  ("all off-by-default" false — siblings default ON; three inconsistent matching semantics). Fixed:
  fail-closed escalation via `ui.confirm`; off-by-default corrected; single segment-`includes` semantics.
- **Round 2** — zero severe + 1 general (residual `ask` term in R1) + clarifications (D4 grammar, R4
  redaction). Fixed.
- **Round 3** — **zero severe, zero general** (independent re-verification of all citations).
- **Round 4 (corroborating)** — **zero severe, zero general.** Cap-convergence
  ([[three-loop-cap-convergence-policy]]) — two-generation satisfied. **L1 closed.**
