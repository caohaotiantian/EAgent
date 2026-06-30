# Light-Mode brief — RW8b-1 self-improve real-evaluator integration test

**Slug:** `2026-06-30-self-improve-real-eval-test` · **Tier:** Light (1 new test + a 1-word export + a CI
step; no breaking change, no new external contract, no migration). Source: `docs/DEFERRED-FOLLOWUPS.md` RW8b-1.

## What / why

`self-improve`'s **production** evaluator (`realEvaluate` in `src/extensions/self-improve.ts`) is the one
path that ships **untested offline** — every existing test injects a stub via `setEvaluator`. It does the
real, security-critical work: copy `evals/` + symlink `node_modules` into an ephemeral staging dir, spawn a
**sandboxed** `node --import tsx src/self-improve-eval.ts` subprocess (twice — baseline + candidate) that
`createAgentHost({discoverDirs:[stagingCandidateDir]})` + `runEvalDir`, integrity-hash the fixtures pre/post
(tamper), and return `{baseline, candidate, delta, improved, tamper}`. The bwrap CI job (added for
RW9.3-1/RW6c-3) now makes a real sandboxed-subprocess test runnable in CI.

**Change:**
1. **Export `realEvaluate`** from `self-improve.ts` (currently module-private; `runScored`/`hashFixtures`/
   `parseScorecard` are already exported). One-word change — needed so the test drives the full orchestration.
2. **New `test/self-improve-integration.test.ts`** — a backend-gated integration test that:
   - stages a **trivial valid candidate** (a temp `.ts` with `export default function activate(e){ return
     () => {}; }` — loadable, side-effect-free; passes `vetoCandidate`);
   - calls `await realEvaluate(candidatePath)`;
   - asserts it returns a **well-formed `EvalResult`**: `baseline`/`candidate`/`delta` are finite numbers,
     **`tamper === false`** (clean run — fixtures unchanged), no throw. (It does NOT assert a specific delta
     — the trivial candidate need not change the score; the point is the real spawn+sandbox+subprocess+
     `runEvalDir`+tamper path executes end-to-end and returns a structured result.)
3. **Extend the `sandbox-linux` CI job** (`.github/workflows/ci.yml`) to set the opt-in env + run this test
   file, so the real path is exercised in CI under bwrap.

## Explicit non-goals

- NOT testing a candidate that actually *improves* the score, NOT asserting a delta value, NOT exercising
  the `propose`→`adopt` flow (those are offline-pinned already). Just the real `realEvaluate` spawn path.
- NOT making `realEvaluate` part of the default `npm test` on every platform (it is heavy — two full agent
  runs in spawned sandboxed subprocesses; see the decision below).
- NOT a real-collector / network anything; NOT changing `realEvaluate`'s behavior — test-only + one export.

## >1-option decision surfaced

- **When does the heavy integration test run?** (a) **always-backend-gated** (`skip: detectBackend()==="none"`)
  — runs on macOS sandbox-exec by default, adding ~10-20 s (two full agent runs) to every local `npm test`;
  (b) **opt-in env + backend-gated** (`skip: noBackend || !process.env.EAGENT_SI_INTEGRATION`) — the default
  local suite stays fast; the **`sandbox-linux` CI job sets `EAGENT_SI_INTEGRATION=1`** and runs it (so CI
  exercises the real path under bwrap), and a dev can run it locally with the env set. **Chosen: (b)** — the
  RW8b-1 goal is *CI coverage of the real path* (now unblocked by bwrap), and (b) delivers that without a
  per-run tax on the offline suite. Documented so it is discoverable, not hidden.

## Acceptance command

Default: `npm run typecheck` 0 · `npm test` 0 (the integration test **skips** without the env — suite
unchanged in count) · kernel unchanged (no `src/kernel` edit), no new dep.
Real-path (locally on macOS or in the CI bwrap job): `EAGENT_SI_INTEGRATION=1 node --import tsx --test
"test/self-improve-integration.test.ts"` → the test **executes** and passes (returns a well-formed
`EvalResult`, `tamper:false`).

## Closure

**Closed** (commit 6066de2): `realEvaluate` exported; backend-gated + `EAGENT_SI_INTEGRATION`-opt-in integration test stages a trivial candidate and asserts a well-formed `EvalResult` (`tamper:false`) from the real spawn+sandbox+subprocess+runEvalDir path. Verified locally on macOS sandbox-exec: EXECUTES (1 pass, 0 skip, ~0.5s). Default `npm test` skips it (1105 tests, 1 skipped). CI: the `sandbox-linux` bwrap job runs it with the env set. typecheck 0, kernel 2186, no new dep.
