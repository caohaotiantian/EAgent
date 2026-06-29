# Design — Self-improvement harness (bounded, sandboxed, human-checkpointed)

```
Status: closed
Closing-commit: cee89f8
Closed-on: 2026-06-29
Deferred: RW8b-1 (real-evaluator integration test), RW8b-2 (failed-adopt-load leaves the file live) — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-29-self-improvement` · **Wave:** 8 (subsystem 2 of 2) · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P4.2 · **Research:** scratchpad `RESEARCH-FINDINGS-waves-6-8.md` §B (Darwin Gödel Machine safety)

## 1. Background and the gap (code as truth)

P4.2 is the agent improving itself. The audit shows the *primitives* exist but the *safety harness* does
not — and the research (Darwin Gödel Machine, arXiv 2505.22954, ICLR 2026; SWE-bench 20→50%) makes the
safety harness non-negotiable, not optional:

- `self.ts` already grows the agent at runtime: `write_extension` (write a TS module + load it live,
  gated `self:extend`), `read_extension`/`list_extensions` (`self:read`), `reload_extension`
  (`self.ts:96-180`). It loads candidate code **in-process with full authority** — its own docstring warns
  this is "exactly the authority the capability layer exists to mediate."
- EAgent uniquely owns DGM's three ingredients: a **deterministic offline fitness function** (`npm run
  eval` + `npm test` — Wave 7d), **hot-reload** (`self.ts` loadExtension), and **fail-closed isolation**
  (Wave 6c codeact/sandbox-tier). What's missing is the **harness** that ties them into a *safe* loop.
- The DGM safety section is explicit: a self-improving loop needs (1) an **immutable evaluation kernel**
  (a candidate must never edit the tests/eval harness that judge it), (2) a **static-analysis veto** before
  any execution, (3) candidates **evaluated under isolation** (subprocess + sandbox, never loaded into the
  privileged process to be judged), and (4) the loop **bounded + human-checkpointed** (DGM's own run took
  ~2 weeks). Naively wiring `write_extension` → `loadExtension` in a loop has none of these.

This wave ships an off-by-default `self-improve` extension: a **scaffolded** propose→veto→evaluate→adopt
flow around the existing primitives, with the DGM safety controls (static veto, sandboxed advisory eval,
human-checkpointed adopt). It is **not** an autonomous
unbounded loop — propose/evaluate are safe (sandboxed); **adoption is human-checkpointed**. Composition of
self.ts + 7d (fitness) + 6c (isolation); **no kernel change** (composes existing public primitives; the
once-proposed in-process restricted-API guardrail is dropped as unimplementable + non-boundary — KDD-1/5).

## 2. Deliverables

- [ ] **D1** A new `self-improve` extension (`src/extensions/self-improve.ts`), **off by default**
  (`EAGENT_SELF_IMPROVE=off` kill switch + a store `enabled` flag default false), declaring `self:extend`
  (it stages/adopts code). **No kernel change.** Builds on `self.ts`'s write/load + 7d's eval + 6c's sandbox.
- [ ] **D2** `propose_improvement({ name, code, rationale })`: **bespoke `fs` write** of the candidate to a
  **staging** dir (`.eagent/candidates/<name>.ts`) — NOT via `self`'s `write_extension` (which always
  writes the **live** dir and loads in-process, `self.ts:193,205` — unusable for staging, C1); **not**
  loaded, **never executed**. Record `{name, rationale, ts, status:"staged"}`. Capped at N (FIFO).
- [ ] **D3** **Static-analysis veto** (`vetoCandidate(source): { ok, reasons }`) on every propose: reject
  source that (a) references `test/`/`evals/`/the eval harness; (b) calls `grantCapability`/`loadExtension`/
  `unloadExtension`/`reload`/`process.exit`/`process.env` mutation; (c) references `node:child_process` /
  raw `fs` writes outside the workspace; (d) isn't parseable / has no `export default`. **Honest framing
  (S3):** this is a **fast pre-filter, trivially evadable** in JS (computed strings, dynamic `import()`,
  `globalThis["pro"+"cess"]`) — it is NOT a security boundary and NOT a tamper-proof immutable-kernel
  guarantee. A vetoed candidate is `status:"vetoed"` and never evaluated/adopted.
- [ ] **D4** `evaluate_candidate({ name })` — an **advisory** fitness signal, NOT the adoption gate (the
  gate is D5 human review). Three corrections from the L1 review:
  - **Operative (S1):** `npm run eval` hardcodes `discoverDirs: []` (`eval-runner.ts:22`) so it would
    **never load a staged candidate** — the delta would always be 0. Instead the bespoke runner builds a
    host via **`createAgentHost({ discoverDirs: [<staging copy>], provider: "mock" })`** (`discoverDirs` is
    a `createAgentHost` option, `host.ts:161/260` — NOT a `runEvalDir` param, G-A) so the candidate **is**
    discovered + loaded, then (destructuring `const { agent, host } = await createAgentHost(...)`) calls
    **`runEvalDir(dir, agent, () => getTrajectory({ store: host.storeFor("evals") }))`** (Wave 7d;
    `getTrajectory` takes `Pick<ExtensionAPI,"store">`, and `storeFor` is a method on `.host` — `eval-runner.ts:24-25`)
    over the fixtures. (So this does NOT "reuse `npm run eval` verbatim" — it composes
    `createAgentHost` + `runEvalDir` with the candidate-discovering config; this whole host runs inside the
    sandboxed subprocess.)
  - **Confining + harness-chosen fail-closed (S2):** the eval is a **shell** subprocess, whose `6c`
    domain is `sandbox-tiers` — which defaults **fail-OPEN** (`tier:"off"`, `missingBackend:"pass"`,
    `sandbox-tiers.ts:77`). So the harness must **explicitly** wrap the spawn via `lib/sandbox.wrapCommand`
    at a confining tier (`no-network`) and **refuse to run** when `detectBackend()→"none"` (the harness
    chooses fail-closed — it does NOT inherit "fail-closed" from 6c, and 6c exposes no reusable
    subprocess-runner, only `lib/sandbox`'s pure wrappers). The subprocess uses `provider:"mock"` (offline,
    deterministic) and a **scrubbed env** (secrets/API keys removed from the child env; `no-network` is the
    backstop against exfiltration — G-D env hygiene).
  - **Tamper-detected, not immutable (S3):** the candidate runs in a workspace **copy**; the eval
    fixtures/`test/` it is scored against are **integrity-hashed pre/post** the run (and a tampered hash
    invalidates the result). The real repo tests are untouched (separate copy). Honest claim: the score is
    **advisory + tamper-detected**, not a tamper-proof kernel.
  Returns `{ baseline, candidate, delta, improved, tamper }`. Offline-testable via an **injectable** stub
  evaluator (tests pin the state machine); the real sandboxed subprocess is the production path (its full
  isolation is integration-only, documented — KDD-3).
- [ ] **D5** `adopt_improvement({ name })` — **the gate is human source-review**, not the eval delta. Only
  for a non-vetoed candidate; surfaces the candidate **source** + the advisory eval delta to the human and
  requires an explicit **interactive human** approval. **Hardened (G1/G-B), `--yolo`-proof:** approval is a
  **non-null `ui.ask`** (NOT `ui.confirm`) — `ui.confirm` cannot be made yolo-proof for this gate: its
  no-TTY branch `return args.yolo` auto-approves under `--yolo` (`cli.ts:120`), whereas `ui.ask` returns
  **null when non-interactive regardless of yolo** (`cli.ts:127`)
  and is absent on the headless/default UI; the harness **fails closed** (refuses adoption) when `ui.ask`
  is undefined or returns null/empty. On approval: move the staged file to the live extensions dir + load it
  via `self`'s `loadExtension` (host-tracked, so `unloadExtension` can reverse it — R3). Records
  `status:"adopted"`. **The adopted candidate runs with the FULL ExtensionAPI** (G2): there is **no**
  restricted-API guardrail — `e.loadExtension` always constructs the full `ExtensionAPI` (`extension.ts:231,250`)
  with no injection seam, and bypassing `loadExtension` to install a wrapper would forfeit host-tracked
  teardown; so adoption is **trust-on-human-review**, and the *isolation boundary* is the eval-time
  subprocess+sandbox (D4/KDD-1), not any in-process wrapper. (S-new: the earlier "restricted ExtensionAPI"
  was unimplementable via `loadExtension` and is dropped — it was never a boundary, KDD-1.)
- [ ] **D6** A `/self-improve [on|off|status|list]` command (list: staged/vetoed/evaluated/adopted
  candidates). Registered in `BUILTIN_EXTENSIONS`. Tests (offline, injectable evaluator + deterministic veto).
  (The former D6 "restricted ExtensionAPI" deliverable is **removed** — S-new; see D5.)

## 3. Scope Boundary (NOT in scope)

- **No** autonomous unbounded self-modification loop — propose/evaluate/adopt are discrete, human-driven
  steps; adoption requires explicit human approval (KDD-4). No background "improve forever" daemon (DGM's
  run took ~2 weeks; that cost/risk profile is out of scope).
- **No** kernel change — isolation rides 6c's `lib/sandbox`; fitness rides 7d's `runEvalDir`; load rides
  self.ts's `loadExtension`; staging is a bespoke `fs` write. All existing/public.
- **No** *claim* of a tamper-proof immutable eval kernel — the veto is evadable and the eval score is
  **advisory + tamper-detected**, not the gate (S3/KDD-2); the **gate is human source-review** (D5). The
  real tests/eval harness are protected by being a separate copy + integrity hashes, not by the veto.
- **No** in-process evaluation of unvetted candidate code — judging happens in the isolated subprocess only
  (KDD-1). The live process only loads a candidate **after** a human reviews the source + approves.
- **No** "reuse `npm run eval` verbatim" — that entrypoint sets `discoverDirs:[]` and would never load the
  candidate (S1); the harness uses a bespoke `runEvalDir(discoverDirs:[staging])` runner (D4).
- **No** reliance on 6c's *defaults* — the shell-path sandbox (`sandbox-tiers`) defaults fail-OPEN; the
  harness explicitly selects a confining tier + refuses on no-backend (S2/D4).
- **No** restricted-ExtensionAPI guardrail at adopt-load — it was unimplementable via `loadExtension` (no
  injection seam, `extension.ts:231/250`) and was never a boundary (KDD-1); **dropped** (S-new). An
  **adopted candidate runs with FULL in-process authority** (it can flip other extensions' kill switches,
  mutate capabilities, even evade teardown) — so adoption is **trust-on-human-review** (G2); host-tracked
  `loadExtension`/`unloadExtension` give an *operator* rollback against a non-adversarial candidate.
- **No** autonomous self-improvement: discrete, bounded, human-checkpointed steps (KDD-4); ships off.

## 4. Key Design Decisions

### KDD-1 — The isolation boundary is the subprocess+sandbox, not an in-process API wrapper
*Problem:* how is untrusted candidate code contained while judged? *Options:* (a) load the candidate
in-process with a restricted ExtensionAPI and trust the wrapper; (b) **evaluate the candidate in a
subprocess under the 6c fail-closed sandbox** (it can `import` anything, but the OS sandbox + no-network +
workspace-confinement contains it), and only ever load it in-process **after** it passes + a human
approves. *Choice:* **(b)** — an in-process wrapper is **not** a security boundary (the candidate can
`import` kernel modules directly, bypassing the wrapped `e`); the DGM research is explicit that real
isolation is OS/VM-level. (This is also *why* the once-proposed restricted-ExtensionAPI guardrail is
dropped — KDD-5: it was never a boundary AND was unimplementable via `loadExtension`.) The post-approval
load runs with the full API; adoption safety rests on the human source-review gate (D5), not a wrapper.
*Rejected:* (a) a false sense of security — in-process JS is not sandboxable by an API wrapper.

### KDD-2 — Eval kernel: tamper-DETECTED (advisory), not tamper-PROOF (S3 honesty)
*Problem:* a self-improver can "improve" its score by editing the eval fixtures it is scored against.
*Options:* (a) claim the static veto + sandbox make the eval kernel *immutable* (FALSE — the veto is
JS-evadable, and the `workspace-write` tier permits writes *inside* the workspace where `test/`/`evals/`
live, so a veto-evader can rewrite its own scored fixtures, `sandbox-tiers.ts:17-22`); (b) be honest: the
candidate runs against a **workspace copy**, the eval fixtures are **integrity-hashed pre/post** the run
(a changed hash invalidates the result → `tamper:true`), the **real** repo tests are a separate untouched
tree, and the **score is advisory** — the *gate* is human source-review (D5), not the delta. *Choice:*
**(b)** — over-claiming an immutable kernel is the dangerous failure (false confidence); tamper-detection
+ copy-isolation + human-review-as-gate is the honest, defensible posture. *Rejected:* (a) the review (S3)
showed it is gameable; asserting otherwise is security-theater.

### KDD-3 — Static-analysis veto before any execution; injectable evaluator for tests
*Problem:* cheaply reject obviously-dangerous candidates + keep the harness offline-testable. *Options:*
(a) execute-then-judge; (b) a cheap static pre-filter (parse + forbidden-pattern scan) before any
execution, then the sandboxed subprocess; the evaluator is injectable so tests use a deterministic stub
scorer (the real subprocess is the production path). *Choice:* **(b)** — the veto is a fast pre-filter
(rejects `grantCapability`/`loadExtension`/test-writes/`child_process` before the candidate ever runs), and
injecting the evaluator makes the propose→veto→evaluate→adopt state machine fully offline-testable without
spawning real `npm` in CI. *Rejected:* (a) wastes a sandbox run on trivially-bad candidates + untestable.

### KDD-4 — Bounded + human-checkpointed; adoption is NOT `--yolo`-able (G1)
*Problem:* DGM's loop is unbounded/expensive/risky, and a blanket `ui.confirm` is auto-approved under the
CLI `--yolo` path (`cli.ts:120` returns `args.yolo` for the no-TTY branch) — which would
auto-adopt self-modifying code with no human. *Options:* (a) autonomous loop / bare `ui.confirm`;
(b) discrete human-driven steps — propose/evaluate are side-effect-free w.r.t. the live agent (no live
load), staged-candidate count capped, and **adoption requires a genuine interactive human confirm**,
explicitly **refused under `--yolo`/non-interactive** (auto-adopting self-modification is strictly higher
stakes than auto-allowing a tool call). *Choice:* **(b)** — autonomy is the danger; the human source-review
checkpoint is the gate, and it must not be defeatable by yolo. *Rejected:* (a) unbounded/auto self-
modification is exactly the risk the research warns against.

### KDD-5 — No restricted-ExtensionAPI guardrail at adopt (dropped — S-new)
*Problem:* should the post-approval load deny the candidate the self-modification verbs via a restricted
`e`? *Options:* (a) wrap `e` and pass it to the candidate's `activate` — but `e.loadExtension(path)` →
`host.loadFile` → `activate(api)` **always** builds the full, unrestricted `ExtensionAPI`
(`extension.ts:231/250`) with **no injection seam**, so the wrapper can't be installed via `loadExtension`;
hand-rolling the load (import + `activate(wrapper)`) forfeits host-tracked teardown (so `unloadExtension`
rollback breaks); and a kernel "restricted-load" seam violates no-kernel-change. (b) **Drop it.** *Choice:*
**(b)** — it was unimplementable on every axis AND, per KDD-1, never a security boundary anyway (the
candidate can `import` around any wrapper). Adopt via plain host-tracked `loadExtension` (full API,
`unloadExtension`-reversible); the safety rests on the **eval-time subprocess+sandbox boundary** (KDD-1) +
**human source-review gate** (D5/KDD-4). *Rejected:* (a) unimplementable + false-boundary; the L1 review
(S-new) showed the contradiction.

### KDD-6 — Compose self.ts + 7d + 6c; build no new primitive
*Problem:* don't reinvent write/load/eval/sandbox. *Options:* (a) a self-contained harness; (b) compose
`self.ts` (write/load), 7d (`npm run eval` fitness), 6c (sandbox-tier subprocess isolation). *Choice:*
**(b)** — each is built, tested, and the right tool; the harness is orchestration + the safety controls
(static veto, sandboxed advisory eval, human source-review gate). *Rejected:* (a) duplicates subsystems.

## 5. Dependencies and Assumptions

Hard dependencies (all shipped): `self.ts`'s `loadExtension` (`self:extend`, reused only at adopt — NOT
`write_extension`, which writes the live dir; staging is a bespoke `fs` write, C1); Wave 7d's `evals`
`runEvalDir` (the harness calls it with `discoverDirs:[staging]` — NOT `npm run eval` verbatim, S1); Wave
6c's **`lib/sandbox` pure wrappers** (`wrapCommand`/`detectBackend` — 6c exposes no reusable
subprocess-runner, so the harness spawns + wraps the eval itself at a confining tier, fail-closed on
no-backend, S2); `e.agent.ui.ask` (human checkpoint — **NOT `ui.confirm`**, whose no-TTY branch
`return args.yolo` fails **OPEN** under `--yolo`, `cli.ts:120` — the G-B hole; `ui.ask` returns `null`
non-interactively regardless of yolo, `cli.ts:127`, and is `ask?`-optional/absent on default UIs,
`types.ts:294`, so the harness fails **closed** on null/undefined — G1/G-B/KDD-4). **Baseline integrity (C2):** the harness records the baseline
eval score in **its own store** at enable-time and re-derives it under the same sandboxed, candidate-free
config before each comparison (so a previously-adopted candidate can't silently lower the baseline to
manufacture apparent improvement); the comparison uses the integrity-hashed fixtures (KDD-2). `self:extend`
is the gating authority. No network, no deps.

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P4.2; research §B (DGM safety). Composes `self.ts` (`loadExtension`), Wave 7d
(`runEvalDir` as the advisory fitness), Wave 6c's `lib/sandbox` wrappers (the harness selects a confining
tier + fails closed itself — 6c's *shell* path defaults fail-open, so this is harness-chosen, not
inherited — S2), Wave 3 (governance if a candidate spawns), Wave 7a (a candidate run could be snapshotted).
Sibling to Wave 8a reasoning-search (independent). README extension table gains a `self-improve` row +
count **57→58** (after 8a's 56→57 — confirm 8a lands first, C3); reconciled at F. No kernel change.

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` 0. **AC-2** `npm test` 0 (existing + new).
- **AC-3 (static veto)** `propose_improvement` with source that writes to `test/` / calls
  `grantCapability` / imports `node:child_process` / has no `export default` is recorded `status:"vetoed"`
  with reasons and is **not** evaluable; a clean candidate is `status:"staged"`. (Pure `vetoCandidate`
  unit-tested per pattern.)
- **AC-4 (isolation — no live load during eval)** `evaluate_candidate` (with an **injected stub evaluator**)
  never loads the candidate into the live agent: assert the candidate's tools/commands are **not** in
  `e.agent.tools`/`e.commands` after evaluation (it ran only in the [stubbed] subprocess), and the live
  extension set is unchanged.
- **AC-5 (human source-review gate via `ui.ask`; NOT yolo-able)** `adopt_improvement` surfaces the
  candidate source + advisory delta and requires a **non-null `ui.ask`** response (NOT `ui.confirm`, which
  can't distinguish a human "yes" from a yolo auto-"yes" — G-B): with a stub `ui.ask` returning a
  confirming string it adopts (the candidate's tool/command appears); returning **null/empty** (or `ui.ask`
  **undefined**, the headless/default UI) it does **not** adopt — **fails closed**; assert a yolo/non-
  interactive context does **not** auto-adopt (`ui.ask` returns null regardless of yolo, `cli.ts:127`).
  (The advisory eval delta informs the human; it is not the gate.)
- **AC-6 (tamper-detection, not immutability)** A candidate whose source references `test/`/`evals/` is
  vetoed (AC-3, the offline-testable half). The eval runs against a **workspace copy** with fixtures
  **integrity-hashed pre/post**; assert (in the stub-evaluator harness) that a post-run fixture-hash change
  sets `tamper:true` and invalidates the result. (Honest: the score is advisory + tamper-detected, not a
  tamper-proof kernel — KDD-2; the gate is human review.)
- **AC-7 (off-by-default inert + no restricted-API)** Loaded-but-not-enabled → the tools are
  unavailable/inert; host canonical-set green (`BUILTIN_EXTENSIONS.length` +1, no dup tool/command names);
  no kernel change (`kernel-surface` 2187); adoption uses plain host-tracked `loadExtension` (no
  restricted-API guardrail — S-new/KDD-5) and an adopted candidate's tool is `unloadExtension`-removable.

*Quality budget:* propose/veto are cheap (parse + scan); evaluate spawns one bounded subprocess (production)
or a stub (tests); opt-in. Excluded.

## 8. Risks and Rollback

- **R1 — Candidate escapes isolation during eval.** *Mitigation:* eval runs in a subprocess the harness
  wraps at a confining tier (`no-network`) via `lib/sandbox.wrapCommand`, **refusing when no backend**
  (harness-chosen fail-closed — NOT 6c's fail-open shell default, S2), never in-process (KDD-1); static
  veto pre-filters. *Residual:* the OS sandbox is best-effort (6c's documented limit) + the veto is
  evadable — hence the eval is **advisory** and the **human source-review** is the real gate. *Rollback:*
  `/self-improve off` / kill switch.
- **R2 — Reward hacking (candidate edits its judge).** *Mitigation:* the eval kernel is **tamper-DETECTED,
  not immutable** (S3/KDD-2) — workspace copy + pre/post fixture integrity hashes (`tamper:true`
  invalidates); the **real** repo tests are a separate untouched tree. The score is advisory; the human
  reviews the source. *Rollback:* n/a.
- **R3 — A bad candidate gets adopted.** *Mitigation:* adoption requires **human source-review approval**
  (G-C: the eval delta only *informs* — it is NOT a hard precondition, per the advisory reframing,
  KDD-2/AC-5); `unloadExtension` (operator) reverses an adoption (host-tracked load). *Rollback:* unload
  the adopted extension; kill switch.
- **R4 — Adopted candidate has full authority (no in-process guardrail).** *Mitigation:* honestly scoped
  (G2/§3) — there is no restricted-API boundary (KDD-1/KDD-5, dropped); adoption is **trust-on-human-
  review** of the source, the *isolation* boundary is the eval-time subprocess+sandbox, and operator
  `unloadExtension` is the rollback against a non-adversarial candidate. *Rollback:* unload; kill switch.
- **R5 — Unbounded cost/looping.** *Mitigation:* discrete human-driven steps, staged-candidate cap, no
  autonomous daemon (KDD-4). *Rollback:* kill switch.
- **R6 — README table/count stale.** *Mitigation:* reconcile at F (→58).

A single off-by-default extension composing self.ts (`loadExtension`) + 7d (`runEvalDir` advisory fitness)
+ 6c (`lib/sandbox` confinement); reverting the registration removes it cleanly, and an adopted candidate
is reversible via host-tracked `unloadExtension`.

## L1 Review Log

- **Round 1** — 3 SEVERE in the eval/isolation core: S1 the eval never loaded the candidate
  (`npm run eval` has `discoverDirs:[]`) → delta always 0 → inoperative gate; S2 the shell-path sandbox
  (`sandbox-tiers`) defaults **fail-OPEN** (only `codeact` is fail-closed); S3 the "immutable eval kernel"
  is gameable (veto evadable + `workspace-write` lets a candidate rewrite its own fixtures). + G1 `--yolo`
  auto-adopts self-modifying code; G2/G3 honesty gaps. Reframed: eval = **operative + harness-chosen
  fail-closed + tamper-detected ADVISORY signal**; the gate is **human source-review**.
- **Round 2** — 1 SEVERE (S-new): the restricted-ExtensionAPI-at-adopt was unimplementable
  (`loadExtension` has no injection seam; bypassing it loses host-tracked `unloadExtension`). **Dropped**
  the guardrail (it was never a boundary — KDD-1); adopt via plain host-tracked `loadExtension`, full
  authority honestly documented (G2), gate = human review. + G-A/G-B/G-C/G-D fixes.
- **Round 3** — 1 SEVERE (residual): §5 still named `ui.confirm` (fails OPEN under `--yolo`) — the G-B
  `ui.ask` fix wasn't propagated there. Fixed (§5 → `ui.ask`, correct fail-closed semantics) + 3 generals.
- **Round 4 (confirming)** — **zero severe, zero general.** Reviewer confirmed convergence (the SEVERE
  was progressively localized + fully resolved, no recurrence). **L1 closed.**
