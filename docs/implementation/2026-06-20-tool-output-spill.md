# Implementation: lossless tool-output overflow — spill-to-file in `limits`

Status: closed
Closing-commit: 0fa3219
Closed-on: 2026-06-20
Deferred: none
Slug: `2026-06-20-tool-output-spill`
Design doc: `docs/design/2026-06-20-tool-output-spill.md`

Phase 1 closed: dev → review (clean first round) → accept (all pass) → main-agent
PhaseEnd re-run green (`npm test` 261 pass / 0 fail, `npm run typecheck` exit 0).
Behavior observed end-to-end: a ~112 KB tool output was capped to ~16.5 KB in the
transcript with a `full output saved to .eagent/tool-output/...` marker, and the
spill file's bytes equalled the full original output (lossless overflow).

## 1. Task Index

| Design Deliverable (§2) | Design Acceptance Criterion (§7) | Phase |
| --- | --- | --- |
| `src/extensions/limits.ts` — spill on overflow + hint + retention sweep + config + kill switch | 1–8 | P1 |
| `test/limits.test.ts` — spill/fallback/fail-soft/field-preservation/retention tests | 2–8 | P1 |
| `CLAUDE.md` — update the `limits` inventory line | (doc only) | P1 |

Design Key Design Decisions: D1 (single-hook), D2 (location `<root>/.eagent/tool-output`
+ confine invariant/degradation), D3 (retention sweep), D4 (hint format), D5
(fail-soft), D6 (default-on + `EAGENT_TOOL_SPILL=off`).

## 2. Phase Breakdown

One coherent enhancement of one existing extension (`limits.ts`) plus its test
file and a one-line doc edit; `npm test` stays green at the end. **One Phase**,
tasks in strict TDD order (each test task precedes the impl it pins).

### Phase 1 — spill-to-file in `limits`

**Entry condition:** baseline green — `npm test` 252/252 pass, `npm run typecheck`
exit 0 on a clean tree (the bash-policy task is already merged on this branch).

**Design references:** `docs/design/2026-06-20-tool-output-spill.md` §2, §4 D1–D6,
§7 AC 1–9, §8 R1–R3.

**Task list (TDD order — test tasks first):**

- **T1 (test): overflow spills + under-limit untouched.** In `test/limits.test.ts`,
  add tests that drive the `afterToolCall` hook through the harness with a tool
  whose result `content` exceeds `maxToolOutputBytes` (set a small cap via
  `/limits` or `e.store`). Use a `mkdtemp` dir and set
  `process.env.EAGENT_WORKSPACE` to it (restore in `finally`) so the workspace
  root is that dir (design §5/§7 preamble). Assert the invariant *oversized tool
  output is preserved losslessly out-of-window*:
  - the returned `content` matches `/full output saved to /` and is ≤
    `maxToolOutputBytes` + a bounded marker length (AC-2a/b);
  - the spill file named in the marker **exists** and its bytes **equal** the
    original full output (AC-2c);
  - the spill path resolves **inside** the workspace root — reuse a
    `confine(root, path)` check mirroring `core-tools.ts:30-37` (import the
    helper if exported, else inline the same `relative`-based assertion) — so the
    `read` tool would accept it (AC-3);
  - a result whose `content` is **≤** the cap is returned **byte-identical** and
    **no file** appears under `<root>/.eagent/tool-output` (AC-4).
  Watch these fail (spill not implemented yet → today's in-context marker).

- **T2 (impl): spill the full output on overflow.** In the `afterToolCall`
  truncation branch of `src/extensions/limits.ts` (currently lines 87-103):
  after computing `shown` (preview truncated to the byte cap, **unchanged
  order** — design D4/C1), when spill is enabled, resolve `root =
  $EAGENT_WORKSPACE ?? process.cwd()`, resolve `dir = toolOutputDir ??
  join(root, ".eagent", "tool-output")`, `mkdirSync(dir, {recursive:true})`,
  write the **full** `content` to `join(dir, <id>)` where `<id>` is unique via a
  **closure-scoped monotonic counter** combined with `Date.now()` (e.g.
  `tool-${Date.now()}-${nextId++}`, the counter declared once in `activate` so
  two spills in the same millisecond still differ), `writeFileSync` it, and build
  the marker per D4: if `dir` is inside `root`,
  embed the root-relative path and name the `read` tool (offset/limit) + bash
  grep; if outside `root` (override case), omit the relpath and suggest bash
  only. Spread `...result` so `isError`/`details`/`terminate` survive; only
  `content` changes. Make T1 green.

- **T3 (test): disable fallback, fail-soft, field preservation.** Add tests:
  - with `spillToolOutput=0` (store) **and** separately with
    `EAGENT_TOOL_SPILL=off` (env, restored in `finally`), oversized output returns
    the **current** in-context marker `/output truncated: \d+ of \d+ bytes shown/`
    and writes **no** file (AC-5);
  - with `toolOutputDir` set to a path whose parent is an existing **file** (so
    `mkdirSync` throws), oversized output still returns the in-context truncation
    marker, `isError` is unchanged, and the call does **not** throw (AC-6);
  - an oversized result carrying `isError:true` and a `details`/`terminate` value
    returns the **same** `isError`/`details`/`terminate` after spilling — only
    `content` changed (AC-7).
  Watch the fail-soft / disable cases fail (until config + try/catch exist).

- **T4 (impl): config, kill switch, fail-soft.** Add store-backed config:
  `spillToolOutput` (boolean, default `true`), `toolOutputDir` (string,
  optional), `toolOutputRetentionDays` (positive number, default `7`). Honor
  `EAGENT_TOOL_SPILL=off` (disables spill regardless of store). Wrap the spill
  write (`mkdirSync`/`writeFileSync`) in try/catch; on failure `e.log.warn` and
  fall back to the existing in-context marker (design D5). Make T3 green.

- **T5 (test): retention cleanup.** The sweep runs *inside* `activate`, so the
  config it reads must exist **before** `host.use("limits", …)`. To avoid the
  fact that `makeHarness` exposes no pre-activation store seeding, drive the
  sweep through the **default** dir derived from the workspace root (no store
  needed): set `process.env.EAGENT_WORKSPACE` to a fresh `mkdtemp` dir (restore
  in `finally`), pre-create `<root>/.eagent/tool-output/` and write a few files
  there, age some with `fs.utimesSync(path, atime, mtime)` to ~10 days old
  (older than the 7-day default `toolOutputRetentionDays`) and leave one fresh,
  then `await host.use("limits", limits)`. Assert the stale files are deleted and
  the fresh one remains (AC-8). Separately, with `EAGENT_WORKSPACE` set to a
  mkdtemp dir whose `.eagent/tool-output` subdir is **absent**, `host.use("limits",
  limits)` must **not** throw (missing-dir path). (If a later test needs a custom
  `toolOutputDir`/`toolOutputRetentionDays` before activation, build a local
  `MemoryBackend`, `backend.open("limits").set(key, value)`, and a hand-built
  `ExtensionHost({ agent, commands, logger, store: backend })` — but the
  default-dir approach above covers AC-8 without it.) Watch fail.

- **T6 (impl): retention sweep.** Add a best-effort `sweep()` function **called
  once inside `activate`** (not a hook, not in the teardown loop — design D3/G4):
  `readdirSync(dir)` (catch → return on missing dir), for each entry `statSync`
  and `rmSync` those whose `mtimeMs` is older than `retentionDays`; each file op
  in its own try/catch so one undeletable file cannot abort the sweep or throw.
  Make T5 green.

- **T7 (impl): surface config + docs.** Extend the `/limits` command to print and
  accept `spillToolOutput`, `toolOutputDir`, `toolOutputRetentionDays` (mirror
  the existing key=value parse/validate; `toolOutputDir` is a string, the others
  numeric/boolean). Update the one-line `limits` entry in `CLAUDE.md`'s extension
  inventory to mention spill-to-file overflow. Run the full suite.

**Per-task acceptance commands** (from repo root):

- T1–T6: `node --import tsx --test test/limits.test.ts` — all limits subtests
  pass (0 fail), including the new spill/fallback/fail-soft/retention tests.
- T7 + Phase exit: `npm run typecheck` exits 0 **and** `npm test` (literally
  `node --import tsx --test "test/**/*.test.ts"`) reports `# fail 0` with the
  suite total grown by the new subtests.

**Exit condition:** `npm run typecheck` exit 0; `npm test` `# fail 0` (≥ 252 prior
tests green plus new limits subtests); design AC 1–9 each map to a passing
assertion in `test/limits.test.ts`.

## 3. Engineering Constraints Index

- **Project engineering norms** — `CLAUDE.md` "House conventions": ESM + NodeNext
  (`.js` import specifiers even for `.ts`), strict TypeScript
  (`noUncheckedIndexedAccess`, no `any`), zero runtime deps except `jiti` (Node
  `fs`/`path` are stdlib, allowed), guardrails never throw (`limits.ts:16-17`).
  Mirror the existing `limits.ts` structure (config via `e.store`, `/limits`
  command, disposer teardown).
- **Four-corner subagent template** — `references/loop-3-development.md`.
- **Commit conventions** — `feat(phase1): …` opener; `fix(phase1-roundR):
  <keyword>` within-round fixes; `npm test`/typecheck results as trailers; no
  mention of AI/model/tooling.

## 4. Data and Fixture Dependencies

- **Reused:** `test/helpers.ts` `makeHarness`, `MockProvider` responder
  scripting, the existing `test/limits.test.ts` patterns (driving `afterToolCall`
  by registering a tool whose result overflows and running the agent). No new
  shared fixtures.
- **New:** spill files are created **by the tests** under `mkdtemp` dirs (and
  cleaned by the OS / test); no committed fixture files. `fs.utimesSync` ages
  files for the retention test. No network.

## 5. Regression Protection

- The full `npm test` suite (252 prior tests) stays `# fail 0`. In particular the
  **existing `limits` tests** — the byte-cap truncation behavior with spill
  **off** must remain byte-identical to today (the in-context marker path is
  unchanged), and the per-run call/token **budget** hooks and `/limits` command
  parsing are untouched (design §3 Scope Boundary). `npm run typecheck` stays
  clean.
- No other source file is modified except `src/extensions/limits.ts`,
  `test/limits.test.ts`, and the one-line `CLAUDE.md` inventory edit. No kernel
  primitive and no other extension changes; the `afterToolCall` contract
  (`ToolResult → ToolResult`) is preserved.
