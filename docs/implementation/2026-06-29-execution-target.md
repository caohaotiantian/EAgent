# Implementation — ExecutionTarget tiers for `code:exec`

**Slug:** `2026-06-29-execution-target` (matches design) · **Design:**
[`design/2026-06-29-execution-target.md`](../design/2026-06-29-execution-target.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Single-file accept:
`node --import tsx --test "<file>"`.

## 1. Task Index

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1 extract helpers → `lib/sandbox.ts` (behavior-identical refactor) | design §2 D1, KDD-2, AC-3, AC-8 |
| 2 | D2-D4 codeact isolation tier (off-by-default, fail-closed) | design §2 D2-D4, KDD-1/3/4/5, AC-4..AC-7 |

Two Phases: Phase 1 is a self-contained behavior-preserving refactor (gated by sandbox-tiers' existing
tests); Phase 2 builds the new codeact tier on top of the lib. Each independently committable; `npm test`
green at each Phase end.

## 2. Phase Breakdown

### Phase 1 — Extract launcher helpers to `src/extensions/lib/sandbox.ts`

- **Entry condition:** on latest `feat/redesign-superpowers` (Waves 1-5 + 6a + 6b merged). `npm test` green.
- **Design refs:** §2 D1; KDD-2; AC-3, AC-8.
- **Files:** `src/extensions/lib/sandbox.ts` (new), `src/extensions/sandbox-tiers.ts` (import + re-export),
  `test/sandbox-tiers.test.ts` (unchanged — the parity net), optional `test/lib-sandbox.test.ts`.
- **Task list:**
  1. **(impl)** Create `src/extensions/lib/sandbox.ts`; **move** verbatim from `sandbox-tiers.ts`:
     types `Backend`/`Tier`; consts `TIERS`, `LAUNCHERS`, `BACKENDS`; functions `workspaceRoot`,
     `shquote`, `detectBackend`, `isBackend`, `isWrapped`, `wrapCommand`, `binExists`. Imports there:
     `existsSync` from `node:fs`, `delimiter`/`join`/`resolve` from `node:path` (no `ExtensionAPI` — keeps
     the lib free of extension coupling, no circular import).
  2. **(impl)** `sandbox-tiers.ts`: delete the moved definitions **and their now-orphaned imports**
     (`existsSync` from `node:fs`; `delimiter`/`join`/`resolve` from `node:path` — they move with
     `binExists`/`workspaceRoot`; tsconfig has no `noUnusedLocals` so leftovers wouldn't fail typecheck,
     but a clean move drops them). `lib/sandbox.ts` must `export const LAUNCHERS` (currently private) since
     `activate`'s `probe` command uses it; `BACKENDS` may stay private to the lib (only `isBackend` reads
     it). Then add
     `import { wrapCommand, detectBackend, binExists, isBackend, shquote, isWrapped, workspaceRoot, TIERS,
     LAUNCHERS, type Backend, type Tier } from "./lib/sandbox.js";` and **re-export** the names its test
     imports today (`export { detectBackend, wrapCommand, shquote, isWrapped, workspaceRoot, TIERS } from
     "./lib/sandbox.js"; export type { Backend, Tier } from "./lib/sandbox.js";`). The stateful
     `forcedBackend`/`probeBackend`/`warned`/`session_start`/the `beforeToolCall` hook + the command stay
     in `activate()` unchanged.
  3. **(verify)** `node --import tsx --test "test/sandbox-tiers.test.ts"` passes **unchanged** (AC-3);
     `npm run typecheck` 0.
  4. **(test, optional)** `test/lib-sandbox.test.ts`: thin re-exercise of the pure core where it now lives
     (`wrapCommand` per backend×tier, `detectBackend` per platform, `shquote`, `isWrapped`, `isBackend`) —
     only if not already redundant with the sandbox-tiers test (AC-8).
- **Accept:** `node --import tsx --test "test/sandbox-tiers.test.ts"`; `npm run typecheck`.
- **Exit:** sandbox-tiers tests green unchanged; typecheck 0; `npm test` green.

### Phase 2 — codeact isolation tier (off-by-default, fail-closed)

- **Entry condition:** Phase 1 merged.
- **Design refs:** §2 D2-D4; KDD-1 (extend not duplicate), KDD-3 (wrap via `/bin/sh -c`), KDD-4 (fail
  closed by default), KDD-5 (off→byte-identical); AC-4..AC-7. R6 (macOS temp-wide residual — honest docs).
- **Files:** `src/extensions/codeact.ts`, `test/codeact.test.ts`.
- **Task list (TDD order):**
  1. **(test)** `test/codeact.test.ts` — **tier wraps spawn** (AC-4). NOTE: spying on `node:child_process`
     `spawn` is **not** realizable under `npm test` (`mock.method` throws on the non-configurable export;
     `mock.module` needs `--experimental-test-module-mocks`, which the suite does not pass). Use a **fake
     launcher on PATH** instead: in the test, `mkdtemp` a dir, write an executable shim named `bwrap`
     (`#!/bin/sh` that prints a unique marker like `echo "[[WRAPPED]]"` then exits 0 — it does **not** need
     to exec the inner), `chmod 0o755`; set `process.env.EAGENT_SANDBOX_BACKEND="bwrap"` and prepend the
     shim dir to `process.env.PATH` (codeact passes `PATH` through to the child, codeact.ts:77); set codeact
     `tier=workspace-write`. Run `run_code` with a JS snippet; assert the captured output **contains the
     marker** — proving the interpreter was invoked **through** the wrapped launcher. **Save/restore**
     `PATH`, `EAGENT_SANDBOX_BACKEND`, `EAGENT_CODEACT_TIER` around the test. (The exact wrapped string is
     additionally pinned at the pure level by AC-8's `wrapCommand` test.)
  2. **(test)** **fail closed** (AC-5) — realizable **without** any spy: `tier=workspace-write`, forced
     backend `none` (`EAGENT_SANDBOX_BACKEND="none"`), default `missingBackend=block` → `run_code` returns
     an **error** result whose text matches `/refusing/i`; assert a **sentinel side effect of the snippet
     did not happen** (e.g. the snippet would print a unique marker — assert the marker is **absent**),
     proving the interpreter was never spawned. With `missingBackend=pass`, the snippet runs unwrapped (its
     marker **is** present).
  3. **(test)** **default-off byte-identity** (AC-6): with no tier set (default `off`) AND the fake `bwrap`
     shim on PATH from task 1, run a snippet that prints a marker; assert the snippet's marker **is**
     present (it ran) and the shim's `[[WRAPPED]]` marker is **absent** (the launcher was never invoked →
     direct `spawn(interp,[file])`, byte-identical to today).
  4. **(test)** **no double-wrap** (AC-7): satisfied at the **pure** level by AC-8's `isWrapped` unit test
     (in codeact the inner is always `node|python3 <file>`, never launcher-prefixed, so the integration
     guard is dead-defensive — state this rather than writing a vacuous codeact-level test).
  5. **(impl)** `codeact.ts`: import `{ wrapCommand, detectBackend, binExists, isBackend, shquote,
     isWrapped, type Backend, type Tier }` from `./lib/sandbox.js`. In `activate(e)` add a
     `resolveSandbox()` helper closing over `e.store`/env:
     `tier` = `(e.store.get<Tier>("tier","off") ?? "off")` overridable by `EAGENT_CODEACT_TIER`;
     `missingBackend` = `e.store.get<"block"|"pass">("missingBackend","block") ?? "block"`;
     `backend` (three-way, per design D3 — a typo'd override must fail closed, not silently detect):
     ```
     const raw = process.env.EAGENT_SANDBOX_BACKEND;
     const backend: Backend = raw ? (isBackend(raw) ? raw : "none") : detectBackend(process.platform, binExists);
     ```
     (unset → detect; recognized → use it; **unrecognized → `none`** so it routes through the
     missing-backend policy, never falling through `wrapCommand`'s default-less switch). Return
     `{ tier, backend, missingBackend }`.
  6. **(impl)** Thread `sandbox` into `runCode(language, code, timeout, signal, sandbox)`: after
     `mkdtemp`/`writeFileSync`, compute the spawn target:
     - `tier === "off"` → `child = spawn(command, [file], opts)` (unchanged path, KDD-5).
     - `tier !== "off"` and `backend === "none"`: `missingBackend === "block"` → **return** a hand-built
       `RunOutcome` before spawning (there is no `fail()` helper for `RunOutcome` — `fail`/`ok` produce
       `ToolResult`; construct `{ output: "[codeact] refusing to run code:exec unsandboxed: no sandbox
       backend (tier=<tier>)", isError: true, details: { exitCode: null, signal: null, timedOut: false,
       language } }`); `=== "pass"` → run unwrapped (warn once) like the off path.
     - `tier !== "off"` and a real backend: `const inner = \`${command} ${shquote(file)}\`;` if
       `isWrapped(inner)` use it as-is, else `const wrapped = wrapCommand(backend, tier, inner,
       { root: dir });` then `child = spawn("/bin/sh", ["-c", wrapped], opts)`. **All downstream handling
       is unchanged** (stdout/stderr capture, the `setTimeout`→`child.kill("SIGKILL")`, the abort
       `signal`, `finish()`); only the spawn target differs. (Timeout/abort delivery to the sandboxed
       grandchild is best-effort — KDD-5; the launcher forwards.)
  7. **(impl)** Pass `resolveSandbox()` from both call sites (the `run_code` tool `execute` and the
     `/code` command) into `runCode`.
  8. **(impl)** Add a `/codeact [status|tier <name>|missing <block|pass>]` command (distinct from the
     existing one-off `/code`): `tier` validates against `TIERS`, `missing` against `block|pass`, `status`
     prints tier/backend/missing. No new capability. (`activate` currently returns `void` and relies on
     host registration tracking for reload — keep that; register the new command the same way.)
  9. **(verify)** `node --import tsx --test "test/codeact.test.ts" "test/sandbox-tiers.test.ts"`;
     `npm run typecheck`.
- **Accept:** `node --import tsx --test "test/codeact.test.ts"`; `npm run typecheck`.
- **Exit:** AC-4..AC-7 pass; default-off byte-identity; sandbox-tiers tests still green; `npm test` green.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM NodeNext `.js` specifiers (`./lib/sandbox.js`);
  strict TS (`noUncheckedIndexedAccess` — guard array/`split` access); zero deps but jiti (node builtins
  only; no `node:crypto`/external sandbox dep); offline tests. **No kernel change.** codeact's tier is
  **off by default** (byte-identical) + fail-closed once opted in. Keep codeact's honest "not a full
  sandbox / best-effort" framing (R5/R6); the real-launcher path is **not** exercised offline (forced
  backend + spawn spy, same as sandbox-tiers) — a real-host `bwrap`/`sandbox-exec` smoke is a pre-Wave-8
  follow-up (L1 round-2 note).
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):`/`feat(phase2):`; no AI attribution.

## 4. Data and Fixture Dependencies

`MockProvider` not needed for the unit-level tier tests (drive `run_code`/`runCode` directly via a host
slice or the tool's `execute`). Force the backend via `process.env.EAGENT_SANDBOX_BACKEND` — **save and
restore** it (and `EAGENT_CODEACT_TIER`) around each test to avoid cross-test leakage (the sandbox-tiers
tests force via the per-harness store for this reason). A JS snippet runs under the real `node` so output
is captured without a network or a real OS sandbox. Offline.

## 5. Regression Protection

- **Phase 1:** `test/sandbox-tiers.test.ts` is the behavior-preserving net — it must pass **unchanged**
  (same imported names via re-export, same shell behavior). `npm test` green.
- **Phase 2:** codeact `tier=off` (default) keeps the exact `spawn(interp,[file])` path → existing codeact
  tests stay green (the core regression net). `npm test` green at each Phase end.
- No kernel change → `kernel-surface.test.ts` unaffected (kernel stays 2182). No new extension → host
  canonical-set count unchanged.

## L2 Review Log

- **Round 1** — zero severe + 2 general: G1 (resolveSandbox must be three-way — bad override → `none` per
  D3); G2 (the "spawn spy" technique is **not** realizable under `npm test` — reviewer empirically
  verified). Fixed: three-way backend resolution; fake-launcher-on-PATH test technique (AC-4) +
  spy-free fail-closed/byte-identity (AC-5/6); hand-built fail `RunOutcome`; orphaned-import cleanup.
- **Round 2** — **zero severe, zero general** (fixes verified realizable offline).
- **Round 3 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L2 closed.**
