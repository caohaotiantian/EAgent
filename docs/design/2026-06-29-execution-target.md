# Design — ExecutionTarget tiers for `code:exec` (unify sandbox confinement)

**Slug:** `2026-06-29-execution-target` · **Wave:** 6 (subsystem 3 of 4) · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P2.3 · **Research:** scratchpad `RESEARCH-FINDINGS-waves-6-8.md` §B (DGM candidate isolation)

## 1. Background and Purpose

The blueprint's P2.3 asked for "tiered `ExecutionTarget` under bash/codeact, fail-**closed** when a
backend is missing (fixes sandbox-tiers' fail-open)." A code-as-truth audit shows **half of this already
exists and is well-built**, so the honest deliverable is narrow:

- `sandbox-tiers.ts` **already** confines every `shell:exec` command: it rides `beforeToolCall` and
  rewrites the command into the host's native launcher (`sandbox-exec`/`bwrap`/`firejail`) for the tier
  `off`/`readonly`/`workspace-write`/`no-network`. Pure `wrapCommand`/`detectBackend` core, 18 offline
  tests. **This is the shell ExecutionTarget — building a new one would duplicate it (KDD-1).**
- `codeact.ts` runs `code:exec` in a subprocess (`spawn(interpreter, [tempfile])`, per-call `mkdtemp`,
  scrubbed env, timeout) that its own docstring calls *"a weak boundary (process isolation, scrubbed env,
  timeout), **not** a full sandbox"* — the documented seam where a real sandbox plugs in. It does **not**
  route through `sandbox-tiers` (different capability `code:exec` ≠ `shell:exec`, and a file-path spawn,
  not a shell string). **So model-authored code gets no OS-sandbox tier — the genuine P2.3 gap.**

This wave closes exactly that gap: give `code:exec` the *same* OS-sandbox tiers as the shell, reusing the
already-tested launcher machinery (extracted to a shared lib), and make the code path **fail closed** by
default once a tier is selected (the blueprint's "fixes fail-open"). The chief beneficiary is **Wave 8**:
running a self-improvement candidate's code under a required, fail-closed tier is the isolation the
research (Darwin Gödel Machine safety §) says is non-negotiable.

## 2. Deliverables

- [ ] **D1** Extract `sandbox-tiers`' **extractable** launcher helpers into `src/extensions/lib/sandbox.ts`
  (`wrapCommand`, `detectBackend`, `shquote`, `isWrapped`, `workspaceRoot`, `binExists`, **`isBackend` +
  `BACKENDS`**, `TIERS`, `LAUNCHERS`, types `Tier`/`Backend`). Most are pure; `workspaceRoot` reads
  `process.env`/`cwd` and `binExists` does `existsSync` — none holds module state, so all relocate cleanly.
  The **stateful** machinery (`forcedBackend()`/`probeBackend()` memoization, the `session_start` reset,
  the `beforeToolCall` hook) stays in `sandbox-tiers.ts`'s `activate()` and does **not** move.
  `sandbox-tiers.ts` imports from the lib and re-exports the public names it already exported (so
  `test/sandbox-tiers.test.ts` keeps importing the same names). **Behavior-identical refactor** — the 18
  existing tests are the net. (`isBackend`/`BACKENDS` move so codeact can validate a forced backend
  without re-implementing it — see D3.)
- [ ] **D2** `codeact.ts` gains an **isolation tier**, off by default: config `tier`
  (`off`/`readonly`/`workspace-write`/`no-network`, default `off`, store key + `EAGENT_CODEACT_TIER`) and
  `missingBackend` (`block`/`pass`, **default `block`** — fail closed). When `tier !== "off"`, wrap the
  interpreter invocation through the active backend: spawn `/bin/sh -c <wrapCommand(backend, tier,
  "<interp> <shquote(file)>", { root: dir })>` instead of `spawn(interp, [file])`. The writable root is
  the **per-call temp `dir`**. (Note: this enforces the same *no-writes-to-home/project* guarantee as the
  shell write tiers; on macOS the `sandbox-exec` profile additionally allows the broad `/private/tmp` +
  `/private/var/folders` tree — where `dir` lives — so the residual write surface is the **temp tree**, not
  only `dir`; on `bwrap`/`firejail` it is `dir`-scoped. Documented honestly, not over-claimed as "tighter
  than the shell" — see R6.)
- [ ] **D3** Fail-closed semantics + forced-backend resolution: resolve the backend via the lib's
  `isBackend`-validated read of the **host-level** `EAGENT_SANDBOX_BACKEND` (shared with sandbox-tiers — it
  describes the host) falling back to `detectBackend(process.platform, binExists)`; an **unrecognized**
  override coerces to `none` (via `isBackend`), never falling through `wrapCommand`'s `switch` to
  `undefined`. When `tier !== "off"` and the resolved backend is `none`: with `missingBackend === "block"`
  (default) `code:exec` returns an **error** `RunOutcome` (refuses to run unsandboxed); with `pass` it runs
  unsandboxed and warns once. Never double-wrap (`isWrapped`).
- [ ] **D4** A `/codeact` subcommand surface for the tier (`/codeact tier <name>`, `/codeact missing
  <block|pass>`, `/codeact status`) — or extend its existing command if present. Mirrors
  `sandbox-tiers`' command grammar.
- [ ] **D5** Tests: `test/lib-sandbox.test.ts` (the extracted pure helpers — or fold into the existing
  sandbox-tiers test) + new `codeact` tests for tier-wraps-spawn, fail-closed-on-missing-backend (forced
  `none`), default-off byte-identity, no-double-wrap.

## 3. Scope Boundary (NOT in scope)

- **No** new `ExecutionTarget` registry abstraction / kernel change — `sandbox-tiers` (shell) + this
  (code) ARE the ExecutionTarget, realized as the shared `lib/sandbox.ts` applied at both call sites
  (KDD-1). No kernel growth (the kernel is at 2,182/2,200).
- **No** real container/microVM backend shipped — gVisor/Firecracker/E2B need deps + infra and aren't
  zero-dep/offline-testable. The shared lib's `detectBackend`/`wrapCommand` is the **plug-in point**; a
  deployment adds a backend there. Documented honestly (matches `codeact`'s + `sandbox-tiers`' existing
  "not a full sandbox" / "seam where a sandbox plugs in" stance).
- **No** change to `sandbox-tiers`' shell behavior or its **fail-open default** (operators rely on it; the
  fail-**closed** posture is the code path's default, and `sandbox-tiers` already offers `missing block`).
- **No** in-process JS sandbox (`node:vm`) — the research and `codeact`'s own docstring reject it (shared
  globals/prototype escape); OS/VM-level only.
- **No** auto-grant of `code:exec` (unchanged — it stays prompt/deny).

## 4. Key Design Decisions

### KDD-1 — Extend the existing tier mechanism, don't build a new registry (the audit's Simplicity call)
*Problem:* P2.3 says "ExecutionTarget registry under bash/codeact." *Options:* (a) a new registry
abstraction both bash and codeact resolve through; (b) recognize `sandbox-tiers` IS the shell target and
just bring `code:exec` up to parity via a shared lib. *Choice:* **(b)** — (a) would duplicate
`sandbox-tiers`' tested machinery and add an indirection layer with two consumers; (b) closes the actual
gap (unsandboxed `code:exec`) with the least new surface and reuses 18 tests' worth of hardened code. The
"registry" is realized as the shared `lib/sandbox.ts` applied at both call sites. *Rejected:* (a) is
over-engineering against an existing, working mechanism.

### KDD-2 — Pure helpers to `lib/sandbox.ts` (vs extension→extension import or duplication)
*Problem:* codeact needs `wrapCommand`/`detectBackend`. *Options:* (a) codeact imports them from
`sandbox-tiers.js` directly; (b) duplicate them in codeact; (c) extract to `src/extensions/lib/sandbox.ts`
and have both import. *Choice:* **(c)** — `lib/` is the established home for shared extension helpers
(`lib/decode.ts`); (a) couples two extensions (load-order/reload smell); (b) duplicates security-critical
code. The extract is behavior-preserving and fully covered by `test/sandbox-tiers.test.ts`. *Rejected:*
(a) coupling, (b) duplication.

### KDD-3 — Wrap the interpreter spawn via `/bin/sh -c wrapCommand(...)`, writable root = temp dir
*Problem:* codeact spawns `interp file`, not a shell string; how to apply the launcher? *Options:* (a)
re-implement per-backend arg arrays for the file-spawn; (b) reuse `wrapCommand` by composing the inner
command `"<interp> <shquote(file)>"` and spawning `/bin/sh -c <wrapped>`. *Choice:* **(b)** — reuses the
exact tested wrapper; the writable root is the per-call `mkdtemp` `dir` (where the snippet already lives).
On `bwrap`/`firejail` that is `dir`-scoped; on macOS `sandbox-exec` the profile also allows the broad temp
tree (R6) — either way the load-bearing guarantee (no writes to home/project) holds. *Rejected:* (a)
duplicates backend-specific logic the lib already encodes.

### KDD-4 — Fail **closed** by default for the code path (the blueprint's explicit fix)
*Problem:* `sandbox-tiers` defaults `missing pass` (fail-open). *Options:* (a) match it (fail-open);
(b) default `missing block` for codeact. *Choice:* **(b)** — running *model-authored* code unsandboxed
when you asked for a tier is the dangerous case the blueprint calls out; once a tier is selected, a
missing backend should **refuse**, not silently run unconfined. This is the Wave-8 requirement (never run
a candidate unsandboxed). `pass` remains available for degraded environments. The tier itself is **off by
default**, so the shipped default is still "run as today" (byte-identical) — fail-closed only bites once
you opt into a tier. *Rejected:* (a) reproduces the fail-open hole P2.3 exists to fix.

### KDD-5 — Off-by-default tier ⇒ byte-identical; signal/timeout best-effort (documented)
*Problem:* don't regress codeact's current behavior or its timeout/abort. *Options:* (a) always wrap;
(b) wrap only when `tier !== "off"` (default off → unchanged spawn). *Choice:* **(b)** — default off is
byte-identical to today's `spawn(interp, [file])`. When wrapped, the timeout `child.kill("SIGKILL")` and
the abort `signal` target the `/bin/sh`/launcher child; delivery to the sandboxed grandchild is
**best-effort** (the launcher forwards: `bwrap` forwards signals, `sandbox-exec` runs in the process
group) — the **same** caveat `sandbox-tiers` documents. Accepted and documented, not silently regressed.
*Rejected:* (a) changes the default path.

## 5. Dependencies and Assumptions

Independent of the other Wave-6 subsystems. Depends on `sandbox-tiers`' existing helpers (moved, not
rewritten). Assumes `/bin/sh` is present (already assumed by `bash`/`sandbox-tiers`). The forced backend
override `EAGENT_SANDBOX_BACKEND` is **host-level** (it describes which launcher the host has) and is
shared by both consumers, so codeact's fail-closed/wrap tests are deterministic offline (resolved via the
lib's `isBackend`-validated read). **Two independent knobs:** the **shell** tier (`/sandbox-tiers tier …`,
its namespaced store) and the **code** tier (`/codeact tier …`, codeact's namespaced store) are set
separately — setting one does **not** affect the other (intended: the code path is deliberately tighter +
fail-closed). They share only the host backend probe. The shell tier (`sandbox-tiers`) behavior is
unchanged.

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P2.3; research §B. Reuses/relocates `sandbox-tiers.ts`'s helpers (its
design predates this redesign; behavior preserved). Provides the fail-closed isolation tier that the
**Wave 8** self-improvement harness will require for candidate code (a hard dependency the research
elevated). No kernel change, no filter-count change. README/EXTENSIONS gain a note that codeact has a
sandbox tier; reconciled at F.

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` exits 0. **AC-2** `npm test` exits 0 (existing 1005 + new).
- **AC-3 (refactor parity)** After extracting to `lib/sandbox.ts`, `test/sandbox-tiers.test.ts` passes
  **unchanged** (same imported names; shell behavior byte-identical).
- **AC-4 (code tier wraps spawn)** With a **forced** backend (e.g. `sandbox-exec`/`bwrap` via the
  override) and `codeact tier=workspace-write`, assert the spawned command is the wrapped form
  (`isWrapped(spawnedCommand) === true`, contains the launcher + the temp-dir root) — pinned via a pure
  `wrapCommand` assertion and/or a spy on the spawn argument. The snippet still runs (mock interpreter) and
  its output is captured.
- **AC-5 (fail closed)** With `tier=workspace-write`, forced backend `none`, and `missingBackend=block`
  (default), `code:exec` returns an **error** `RunOutcome` (refuses; the snippet does NOT execute);
  with `missingBackend=pass` it runs unwrapped and warns. 
- **AC-6 (default-off byte-identity)** With `tier=off` (default), the spawn is the unchanged
  `spawn(interp, [file])` form (not wrapped) — codeact behaves exactly as before this wave.
- **AC-7 (no double-wrap)** An already-wrapped inner command is not nested (`isWrapped` guard), mirroring
  sandbox-tiers.
- **AC-8** `lib/sandbox.ts` pure-helper tests (wrapCommand per backend/tier, detectBackend per platform,
  shquote, isWrapped) pass — the security-critical core is unit-pinned where it now lives.

*Quality budget:* the wrap is a pure string transform per `code:exec` call (not a hot path); negligible.
Excluded.

## 8. Risks and Rollback

- **R1 — Refactor regresses sandbox-tiers.** *Mitigation:* AC-3 (its 18 tests pass unchanged) + the
  extract is move-not-rewrite. *Rollback:* re-inline the helpers.
- **R2 — Timeout/abort doesn't reach the sandboxed grandchild.** *Mitigation:* documented best-effort
  (KDD-5), same as sandbox-tiers; launchers forward signals / share the process group. *Rollback:*
  `tier=off` restores direct spawn.
- **R3 — Fail-closed surprises a user** (code refuses on a host with no backend). *Mitigation:* tier is
  **off by default** (no surprise unless opted in); `status`/warn message names the cause;
  `missing pass` escape hatch. *Rollback:* `/codeact tier off`.
- **R4 — Default-behavior drift in codeact.** *Mitigation:* AC-6 byte-identity (tier off → unchanged
  spawn). *Rollback:* the wrap is gated entirely behind `tier !== "off"`.
- **R5 — Docs imply codeact is now "fully sandboxed".** *Mitigation:* keep codeact's honest "not a full
  sandbox / best-effort" framing; the tier is OS-launcher confinement, not a microVM. Reconcile at F.
- **R6 — macOS `sandbox-exec` write surface is temp-tree-wide, not `dir`-scoped** (the profile allows
  `/private/tmp` + `/private/var/folders`, `sandbox-tiers.ts:136-137`, where `mkdtemp` lives). *Impact:* a
  candidate could write elsewhere in temp (ephemeral), though never to home/project. *Mitigation:* the
  load-bearing guarantee (no home/project writes; `no-network` denies subprocess net) holds; documented as
  a residual, not over-claimed. For **Wave 8** candidate isolation, use `tier=no-network` (the strongest)
  on a throwaway workspace; a `dir`-scoped sandbox-exec profile is a deferred refinement. *Rollback:* n/a.

A shared lib + an off-by-default tier branch in `codeact`; `tier=off` (default) is byte-identical, and
reverting the codeact branch + re-inlining the lib restores the prior state.

## L1 Review Log

- **Round 1** — zero severe + 2 general: G1 (forced-backend validation `isBackend` must move to the lib,
  else an unrecognized backend falls through `wrapCommand` to `undefined`); G2 ("tighter than shell" false
  on macOS/sandbox-exec — profile allows the whole temp tree). + clarifications. Fixed: extract
  `isBackend`/`BACKENDS`; D3 validated forced-backend read; R6 + softened wording for the macOS residual.
- **Round 2** — **zero severe, zero general** (3 L2-implementation notes: bwrap-tmpfs smoke, test env-var
  hygiene, drop the approximate test count — folded into L2, not the design).
- **Round 3 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L1 closed.**
