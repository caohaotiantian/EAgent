# Design: `secret-guard` — keep secret VALUES out of tool args (and the transcript)

Slug: `2026-06-22-secret-guard`
Status: draft

## 1. Background and Purpose

EAgent has a rich security vocabulary around *capabilities* (authorize a tool by
type) and three `beforeToolCall` policy guards — `flow-guard` (compositional
egress), `risk-guard` (semantic risk), `bash-policy` (command-granular shell) —
plus `content-guard` on `afterToolCall` (ingress trust labeling). What it has no
notion of at all is a **secret VALUE that must never materialize into a tool
argument**.

Concretely: when the model emits `bash` with
`curl -H "Authorization: Bearer sk-live-abc123…"` or calls a `net:fetch` tool
with a header argument carrying an `AKIA…` key, the plaintext secret lands in the
tool-call block — which means it is permanently in the transcript, the journal,
any trace/checkpoint, and every subsequent model context window. Once it is
there, no downstream guard can un-leak it.

The existing guards are all adjacent but none of them close this seam:

- **`flow-guard`** (`src/extensions/flow-guard.ts:161`) only *taints* a session
  when sensitive content is already *present* — it observes `tool_end` results
  and the transcript, then gates a later *egress* call. It never inspects the
  *outgoing* arguments of the call it is about to run, so it never prevents the
  value entering the args in the first place.
- **`content-guard`** (`src/extensions/content-guard.ts:118`) sanitizes
  *incoming* tool-result content on `afterToolCall`. It is the ingress
  complement; outgoing args are out of its scope.
- **`risk-guard`** (`src/extensions/risk-guard.ts:123`) judges the *semantic*
  riskiness of a call via an LLM sub-call. It is not specifically a
  secret-leakage detector and (being a paid model round-trip) ships OFF.

`secret-guard` fills the prevention seam: a new `beforeToolCall` filter that
scans the about-to-run arguments for secret-looking *values* and, for a tool
whose capability could *leak* the value (the egress/exec set), holds the call —
asking the human in `ask` mode or blocking in `block` mode — **without echoing
the matched value** anywhere. If we do nothing, every credential the model ever
types into a shell command or a fetch header is exfiltrated into the permanent
record by construction.

## 2. Deliverables

- [x] `src/extensions/secret-guard.ts` — a new built-in extension whose
      `activate(e)` registers one `beforeToolCall` filter and one
      `/secret-guard` command, and returns a dispose loop that never throws.
- [x] A pure, exported, zero-dependency `scanSecrets(value: string): string[]`
      helper that returns the **kinds** of secret matched (e.g.
      `["pem-private-key"]`, `["aws-access-key-id"]`) — never the matched
      substring — so the reason string can name *what* matched without leaking
      *the value*. Exported for direct unit testing.
- [x] A pure, exported `scanArgs(args: Record<string, unknown>): string[]`
      helper that walks the argument values (strings, and strings nested in
      arrays/objects) and returns the de-duplicated union of secret kinds found.
- [x] The known-credential pattern set, **copied with attribution** from
      `flow-guard`'s `DEFAULT_SENSITIVE_CONTENT`
      (`src/extensions/flow-guard.ts:55-60`): PEM private keys, `AKIA…` AWS
      access-key ids, `sk-…` keys, `ghp_…` GitHub tokens. No entropy heuristic in
      v1 (see D4).
- [x] A `beforeToolCall` filter that runs only for *leak-capable* tools (default
      `net:fetch`, `shell:exec`; store-overridable `leakCaps`), scans the
      decision arguments, and on a hit asks (`ask` mode, default) via
      `e.agent.ui.confirm` or blocks (`block` mode) with a reason that names the
      matched kind(s) only.
- [x] A `/secret-guard` command: `[on|off|ask|block|status]` (mirroring
      `/flow-guard` and `/risk-guard`).
- [x] Kill switch: `EAGENT_SECRET_GUARD=off` short-circuits the guard to a no-op
      (checked in `cfg()`, mirroring `flow-guard`/`risk-guard`).
- [x] Offline tests in `test/secret-guard.test.ts` — pure-helper unit tests plus
      live `beforeToolCall`-application tests with inline stub tools declaring
      `net:fetch` / `shell:exec` / a benign cap, loaded via
      `host.use(id, activate)` (the `test/recovery.test.ts` /
      `test/risk-guard.test.ts` offline pattern). MUST NOT depend on the
      extension being in `BUILTIN_EXTENSIONS`.
- [ ] `src/host.ts` `BUILTIN_EXTENSIONS` registration — **(deferred to batch
      integration)**; not touched by this task.
- [ ] `CLAUDE.md` / `README.md` extension-inventory line — **(deferred to batch
      integration)**; not touched by this task, and the README extension count is
      **not** bumped here.
- [x] Implementation log at `docs/implementation/2026-06-22-secret-guard.md`,
      reconciled at closeout.

## 3. Scope Boundary (NOT in scope) — Simplicity First

- **Silent argument rewriting / `$ENV` reference substitution.** secret-guard
  DETECTS and HOLDS; it does not rewrite `sk-…` to `$OPENAI_API_KEY`. Rewriting
  requires the env var to actually exist and round-trip through the tool, and a
  wrong guess breaks the call. The `ToolDecision.arguments` rewrite seam exists
  (`src/kernel/events.ts:45`, re-validated at `src/kernel/agent.ts:338`), but
  using it for redaction is deferred — detect+hold is the safe v1.
- **The asterisk-placeholder `transformContext` pass** (detecting a run of
  asterisks — a user-redacted secret — in the latest user message and rebinding
  it). This is explicitly **deferred** (see D6). It would add a second hook, a
  second state shape, and a rebinding policy with no concrete consumer in v1; it
  is omitted to keep v1 a single-seam guard.
- **Entropy / generic high-randomness detection.** No Shannon-entropy gate in v1
  (see D4); we rely on the known-credential patterns to keep false positives
  near zero.
- **Gating non-leak-capable tools** (e.g. a secret passed to `edit`/`write`).
  Lower risk and a false-positive magnet; out of scope (see D2).
- **Scrubbing secrets already in the transcript / journal / logs.** secret-guard
  is *prevention at the args boundary*, not retroactive cleanup. Existing taint
  (`flow-guard`) and a future redaction pass own that.
- **New capability declaration.** secret-guard has no side effects of its own
  (it only reads args and calls `ui.confirm`), so it declares no capability —
  matching `flow-guard`/`risk-guard`/`content-guard`.

## 4. Key Design Decisions

### D1 — Detection: reuse flow-guard's regexes vs a new pattern set

- **Problem.** What counts as a "secret value" in an argument string?
- **Options.** (a) Author a fresh pattern set for secret-guard. (b) Reuse
  `flow-guard`'s `DEFAULT_SENSITIVE_CONTENT`
  (`src/extensions/flow-guard.ts:55-60`). (c) Reuse those plus a generic
  high-entropy heuristic.
- **Choice.** (b) — copy flow-guard's four credential regexes verbatim into
  secret-guard with an attribution comment, exposing them as an exported
  constant. (The optional entropy gate of (c) is itself decided in D4 and
  rejected for v1.)
- **Rationale.** flow-guard and secret-guard must agree on "what a secret looks
  like" — flow-guard taints when one *appears in a result*, secret-guard holds
  when the *same shape appears in an arg*. Divergent pattern sets would mean a
  value flow-guard treats as a secret could pass secret-guard, and vice versa,
  which is a confusing and exploitable gap. Copying with attribution (rather than
  importing flow-guard's non-exported `const`) keeps the modules decoupled — no
  load-order or circular-import coupling between two independent guards — while
  the comment makes the single-source-of-truth intent explicit and greppable for
  the eventual extract-to-shared-module refactor.
- **Why (a) rejected.** A parallel, drifting pattern set is the exact divergence
  hazard above, with no upside.
- **Why (c) rejected here.** Deferred to D4 (false-positive cost).

### D2 — Scope: gate all tools vs only leak-capable tools

- **Problem.** Should a secret in *any* tool's args trip the guard, or only
  tools that can move the value off the machine?
- **Options.** (a) Gate every tool call. (b) Gate only tools declaring a
  *leak-capable* capability — default `net:fetch`, `shell:exec` (the egress/exec
  set), store-overridable.
- **Choice.** (b). Resolve a tool's capabilities via
  `e.agent.tools.get(name)?.capabilities ?? []` (the `capsOf` pattern at
  `src/extensions/flow-guard.ts:114` and `risk-guard.ts:86`), and only engage
  when they intersect `leakCaps`.
- **Rationale.** A secret in the args of a non-leaking tool (say `edit` writing a
  config file the user *intends* to contain the key) is materially lower risk and
  a prolific false-positive source. Scoping to `net:fetch`/`shell:exec`/(opt-in)
  `mcp:call` concentrates the guard exactly where a value would actually *leave*,
  matching how `flow-guard` defines egress (`net:fetch`,
  `src/extensions/flow-guard.ts:36`) and `risk-guard` scopes analysis
  (`shell:exec`, `risk-guard.ts:32`).
- **Why (a) rejected.** Gating everything turns every legitimate
  secret-bearing operation into a prompt, training the user to reflexively
  approve — which destroys the signal for the calls that matter.

### D3 — Action: block vs ask vs silently-redact-the-arg

- **Problem.** On a hit, what does the guard *do*?
- **Options.** (a) Always block. (b) `ask` (confirm) in ask mode, `block` in
  block mode — selectable, default `ask`. (c) Silently rewrite the arg to a
  redaction or `$ENV` reference and let the call proceed.
- **Choice.** (b) — the `flow-guard`/`risk-guard` dual-mode shape: in `block`
  mode return `{ ...decision, block: true, reason }`; in `ask` mode call
  `await e.agent.ui.confirm(...)` and block only on denial.
- **Rationale.** ask-default is non-destructive and reversible — a human sees
  "a `sk-…`-style key is about to be sent via `curl`; allow?" and decides. block
  mode is available for unattended/strict deployments. This is exactly the proven
  posture of the two sibling `beforeToolCall` guards, so it adds zero new
  interaction concept.
- **Why (a) rejected.** Hard-block with no ask path breaks the legitimate
  "yes, send my key to my own API" case with no escape hatch.
- **Why (c) rejected.** Silent rewrite is a correctness landmine: rewriting
  `sk-…` to `$OPENAI_API_KEY` only works if that env var exists *and* the tool
  expands it; guessing wrong silently breaks the call, and silently mutating what
  the model asked for is itself surprising. The arguments-rewrite seam exists
  (`ToolDecision.arguments`, `src/kernel/events.ts:45`) but using it for
  redaction is deferred to Scope Boundary, not done in v1.

### D4 — Entropy heuristic: include a Shannon-entropy gate, or omit it

- **Problem.** Known patterns miss novel/opaque tokens (a fresh vendor's
  `xyzkey_…`); an entropy gate on long base64-ish tokens would catch more.
- **Options.** (a) Add an entropy gate — e.g. flag any token of length ≥ 20 over
  a high-charset alphabet whose normalized Shannon entropy exceeds a threshold.
  (b) Omit entropy in v1; rely solely on the four known-credential patterns.
- **Choice.** (b) — **no entropy in v1.**
- **Rationale (the threshold decision).** A length-/entropy-based gate is a
  notorious false-positive engine: git SHAs, UUIDs, base64-encoded image data,
  minified JS, content hashes, and nonces all clear "length ≥ 20, high entropy"
  while being non-secret — and many legitimately appear in `bash`/`fetch` args.
  Picking *any* single threshold trades one error class for a worse one, and the
  cost of a false positive here is a spurious confirm prompt on a benign call
  (precisely the noise D2 set out to avoid). The known-credential patterns are
  *structurally anchored* (`AKIA` + 16 chars, `ghp_` + 36, `sk-` + 16+, the PEM
  header), so they have near-zero false-positive rate. We therefore keep the
  exported helper shaped so an entropy gate is a one-function addition later, but
  ship v1 on the anchored patterns only.
- **Why (a) rejected for v1.** No defensible threshold exists that does not
  regress the false-positive rate the rest of the design is engineered to keep
  low; the catch-more benefit is speculative.

### D5 — Posture: on-by-default ask vs off-by-default

- **Problem.** Does secret-guard ship on or off?
- **Options.** (a) Off by default (like `risk-guard`,
  `src/extensions/risk-guard.ts:80`). (b) On by default in `ask` mode (like
  `flow-guard`, `src/extensions/flow-guard.ts:79`), with `EAGENT_SECRET_GUARD=off`.
- **Choice.** (b) — **on-by-default `ask`**, kill switch `EAGENT_SECRET_GUARD=off`.
- **Rationale.** Unlike `risk-guard`, secret-guard does **no model call** — it is
  a pure-regex scan, so it is free and adds no latency, removing the only reason
  `risk-guard` ships off. Preventing a permanent secret leak is an unambiguous
  safety win, and `ask` is non-destructive (the user can always approve), so the
  default-cost of a false positive is bounded to one prompt. This matches
  `flow-guard`'s reasoning for shipping on in `ask`, and the kill switch +
  `/secret-guard off` give a clean opt-out.
- **Why (a) rejected.** Off-by-default means the leak the guard exists to stop
  happens silently for everyone who never flips it on — wrong default for a free,
  non-destructive safety check.

### D6 — The asterisk-placeholder `transformContext` feature

- **Problem.** The spec floats an optional `transformContext` pass that detects a
  run of asterisks (a user-redacted secret) in the latest user message and
  rebinds it.
- **Options.** (a) Include a minimal no-op placeholder hook in v1. (b) Defer it
  entirely via Scope Boundary.
- **Choice.** (b) — **defer.** secret-guard v1 is a single `beforeToolCall` seam.
- **Rationale.** A no-op `transformContext` hook would still add a second
  registered hook, a second teardown entry, and an empty branch with no test that
  can assert behavior — pure dead weight that violates Simplicity First. There is
  no concrete consumer for asterisk-rebinding in v1 (no upstream feature emits
  asterisk placeholders), so adding even the scaffold is speculative. Deferring
  keeps v1 honest: one seam, one job.
- **Why (a) rejected.** A placeholder that does nothing is untestable and
  un-Simplicity-First; if/when a real rebinding consumer exists, the hook is
  added then, with its own design.

## 5. Dependencies and Assumptions

- **Kernel hook surface.** Relies on the `beforeToolCall` filter contract:
  `ToolDecision { block, reason?, arguments }` (`src/kernel/events.ts:41-46`),
  the `{ call }` context (`events.ts:56-58`), and the loop applying it at
  `src/kernel/agent.ts:317-326` (a `block:true` decision becomes a
  `"Tool call blocked: …"` error result and the tool never runs).
- **ExtensionAPI surface.** `e.hook` / `e.on`, `e.store` (get/set),
  `e.registerCommand`, `e.log`, and `e.agent` (the full `Agent`:
  `src/kernel/extension.ts:60-61`), through which the guard reaches
  `e.agent.ui.confirm` (`Agent.ui`, `src/kernel/agent.ts:67`) and
  `e.agent.tools.get(name)?.capabilities` for `capsOf`.
- **Argument source.** The guard scans `decision.arguments` (the validated args
  the loop threads in, `src/kernel/agent.ts:315-317`); `ctx.call.arguments` is
  the equivalent pre-validation copy and either is acceptable since the secret
  shapes survive validation.
- **House rules.** ESM with `.js` import specifiers even for `.ts` sources;
  strict TS (`noUncheckedIndexedAccess`, no `any`); zero runtime deps except
  `jiti` (pure Node — regex only, no SDK); offline `node:test` against
  `MockProvider`; kill-switch env var; dispose loop that never throws.
- **Assumption.** Tools declare accurate `capabilities` — a leak-capable tool
  that omits `net:fetch`/`shell:exec` is invisible to the scope filter (the same
  assumption every cap-scoped guard makes). Documented as a known limitation.
- **Assumption.** Secrets appear as plaintext substrings of string-typed
  argument values (possibly nested in arrays/objects). A secret split across
  fields, base64-wrapped, or otherwise encoded is not caught (see Risks).

## 6. Relationship with Existing Designs

This is **not** a first-of-kind design; it sits in a well-populated guard family.

- **Closest sibling — `flow-guard`** (`src/extensions/flow-guard.ts`). Source of
  the credential regexes (`DEFAULT_SENSITIVE_CONTENT`, `flow-guard.ts:55-60`,
  copied with attribution per D1), the `ask`/`block` dual-mode command shape, the
  `capsOf` pattern (`flow-guard.ts:114`), and the on-by-default-`ask` posture with
  a kill switch. **Dedup / no conflict:** flow-guard taints and gates *egress* on
  the *presence* of sensitive content but never stops the value entering args;
  secret-guard stops the value entering an *outgoing arg* in the first place. The
  two are complementary layers, not overlapping — a secret blocked by
  secret-guard never reaches the transcript flow-guard would later taint on.
- **Sibling — `content-guard`** (`src/extensions/content-guard.ts`). The *ingress*
  guard: it sanitizes *incoming* tool-result content on `afterToolCall`.
  secret-guard is its *outgoing-args* complement on `beforeToolCall`. Disjoint
  seams, no conflict.
- **Sibling — `risk-guard`** (`src/extensions/risk-guard.ts`). Same
  `beforeToolCall` seam and same dual-mode shape, but judges *semantic* risk via
  an LLM sub-call. secret-guard is provider-free and leakage-specific. Both can
  run concurrently on the seam; the hook bus composes them and order is
  immaterial (each only adds a `block`, never un-blocks). No conflict.
- **Conflict check:** none. No existing extension scans *outgoing arguments* for
  secret values; this is a distinct prevention seam.

## 7. Acceptance Criteria

All assertions are runnable in `test/secret-guard.test.ts` via `makeHarness`
(`test/helpers.ts`) with a scripted `MockProvider` and inline stub tools, loaded
through `host.use(id, activate)`. "Apply the hook" means
`h.agent.hooks.apply("beforeToolCall", { block:false, arguments }, { call })`
(the `test/risk-guard.test.ts:96-99` pattern).

- **AC-1 (helper: each pattern matches its kind).** `scanSecrets` returns the
  expected kind for one representative of each pattern: a `-----BEGIN RSA PRIVATE
  KEY-----` blob → includes `pem-private-key`; `AKIA` + 16 uppercase
  alphanumerics → `aws-access-key-id`; `sk-` + ≥16 chars → an `sk-`/openai kind;
  `ghp_` + 36 chars → a github-token kind. Assert via `assert.ok(kinds.includes(…))`.
- **AC-2 (helper: no false positive on benign).** `scanSecrets("hello world")`,
  `scanSecrets("/tmp/x.ts")`, and a 40-char lowercase git SHA all return `[]`.
- **AC-3 (helper: value never echoed).** For a matching input, the returned
  array contains only kind labels and **no** substring of the secret value:
  `assert.ok(!scanSecrets(secret).join(" ").includes(secret.slice(0, 12)))`.
- **AC-4 (scope: benign-cap tool is never gated).** With a stub tool declaring a
  benign capability (e.g. `fs:read`) and a secret in its args, applying the hook
  returns `{ block:false }` and `ui.confirm` is **not** called (assert a confirm
  counter stays 0).
- **AC-5 (block mode blocks a leaky secret call).** With a `shell:exec` stub and
  `mode:"block"`, applying the hook for args `{ cmd: 'curl -H "Authorization:
  Bearer sk-…"' }` returns `block:true`, and `reason` matches the kind label
  (e.g. `/sk-|openai/`) but does **not** contain the literal `sk-…` value.
- **AC-6 (ask mode: deny blocks, allow passes).** With a `net:fetch` stub and
  `mode:"ask"`: a denying `UI` (`confirm: async () => false`) yields `block:true`
  and `confirms === 1`; an allowing `UI` (`confirm: async () => true`) yields
  `block:false` and `confirms === 1`.
- **AC-7 (no secret → no prompt, no block).** A leak-capable stud tool with
  clean args (`{ cmd: "ls -la" }`) returns `block:false` and `ui.confirm` is not
  called.
- **AC-8 (kill switch).** With `EAGENT_SECRET_GUARD=off`, applying the hook for a
  `shell:exec` call carrying a `sk-…` value returns `block:false` and never calls
  `ui.confirm` (assert, then restore the env var in `finally`).
- **AC-9 (command toggles).** `/secret-guard off` then re-applying the hook on a
  matching call returns `block:false`; `/secret-guard block` sets block mode (a
  subsequent matching call returns `block:true`); `/secret-guard status` prints a
  line containing `on`/`off`, the mode, and the `leakCaps`.
- **AC-10 (clean teardown).** After `host.unload("secret-guard")`, applying the
  hook on a matching `shell:exec` call returns `block:false` — the
  `beforeToolCall` filter is gone — and unload does not throw.
- **AC-11 (nested args).** `scanArgs({ headers: ["Authorization: Bearer sk-…"] })`
  and `scanArgs({ a: { b: "AKIA…" } })` both return a non-empty kind array (the
  walker descends arrays/objects).

## 8. Risks and Rollback

- **False positives** — a legitimate value that matches a credential regex (e.g.
  a deliberately-`sk-`-prefixed test fixture). *Mitigations:* scope to
  leak-capable tools (D2), `ask` mode default so the user can approve (D3/D5),
  structurally-anchored patterns with no entropy gate (D4), and the kill switch.
  Residual cost is one spurious confirm prompt — bounded and non-destructive.
- **Determined leak via unrecognized encoding** — a secret base64-wrapped, split
  across argument fields, or in a novel vendor format slips through. This is
  **defense-in-depth, not a guarantee**; documented as a known limitation. The
  anchored patterns catch the common, high-impact credential shapes; broader
  detection (entropy, decoders) is explicitly deferred (D4 / Scope Boundary).
- **Mis-declared capabilities** — a leak-capable tool that omits its capability
  is invisible to the scope filter. Shared with every cap-scoped guard;
  documented.
- **Secret echo in logs/reasons** — the single most important safety property:
  the matched value is **never** included in any `reason`, `ui.confirm` prompt,
  or `e.log` call. Only kind labels are surfaced. Enforced by AC-3 and AC-5 and
  by the `scanSecrets` contract (returns kinds, not matches).
- **Hook-ordering with other `beforeToolCall` guards** — `risk-guard`,
  `flow-guard`, `bash-policy`, `write-guard` also ride the seam. Each only ever
  *adds* a `block` and never clears one, so composition is order-independent and
  safe; no coordination needed.

**Rollback / kill switch.** Three independent off-ramps, in increasing scope:
`/secret-guard off` (runtime, this session) → `EAGENT_SECRET_GUARD=off`
(process-wide, restart) → `host.unload("secret-guard")` / remove from
`BUILTIN_EXTENSIONS` at batch integration (gone entirely). The dispose loop tears
down the hook and command and never throws, so unload is always clean.
