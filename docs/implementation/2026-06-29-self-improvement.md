# Implementation — Self-improvement harness

```
Status: closed
Closing-commit: cee89f8
Closed-on: 2026-06-29
Deferred: RW8b-1, RW8b-2 — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-29-self-improvement` (matches design) · **Design:**
[`design/2026-06-29-self-improvement.md`](../design/2026-06-29-self-improvement.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Single-file accept:
`node --import tsx --test "<file>"`.

## 1. Task Index

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1-D6 the `self-improve` harness + host registration | design §2 D1-D6, KDD-1..6, AC-1..AC-7 |

One Phase: a single new off-by-default extension (no kernel change) composing self.ts + 7d + 6c, with the
state machine factored for dependency-injection so the propose→veto→evaluate→adopt flow is offline-testable.

## 2. Phase Breakdown

### Phase 1 — The `self-improve` extension

- **Entry condition:** on latest `feat/redesign-superpowers` (Waves 1-7 + 8a merged). Baseline `npm test` green.
- **Design refs:** §2 D1-D6; KDD-1 (subprocess+sandbox is the boundary, not an in-process wrapper),
  KDD-2 (tamper-detected advisory eval), KDD-3 (static veto + injectable evaluator), KDD-4 (bounded +
  human-checkpointed, not yolo-able), KDD-5 (NO restricted-API — dropped), KDD-6 (compose); AC-1..AC-7.
- **Files:** `src/extensions/self-improve.ts` (new), `src/self-improve-eval.ts` (new — the **bespoke
  candidate-loading eval runner**, per design D4; NOT `eval-runner.ts`, which sets `discoverDirs:[]` and
  would never load the candidate — SEVERE-1), `src/host.ts` (register), `test/self-improve.test.ts` (new).
- **Design for testability (dependency injection):** factor the state machine so the **evaluator** and the
  **human-ask** are injectable — tests pin the propose→veto→evaluate→adopt machine with stubs; the tools
  wire the real subprocess evaluator + `e.agent.ui.ask`.
  - `export function vetoCandidate(source: string): { ok: boolean; reasons: string[] }` — **pure**
    (parse-check + forbidden-pattern scan: `test/`/`evals/` refs, `grantCapability`/`loadExtension`/
    `unloadExtension`/`reload`/`process.exit`/`process.env=`, `node:child_process`, no `export default`).
    Unit-tested directly (AC-3). Documented as an evadable pre-filter, not a boundary.
  - A candidate record `interface Candidate { name; rationale; ts; status: "staged"|"vetoed"|"evaluated"|
    "adopted"; reasons?: string[]; delta?: number; tamper?: boolean }` in `e.store` (capped FIFO).
  - `type Evaluator = (candidatePath: string) => Promise<{ baseline: number; candidate: number; delta:
    number; improved: boolean; tamper: boolean }>`. The **real** evaluator (production) runs the sandboxed
    subprocess (below); tests inject a deterministic stub.
- **Task list (TDD order):**
  1. **(test)** `test/self-improve.test.ts` — **static veto** (AC-3): `vetoCandidate` (pure) rejects source
     that writes to `test/` / calls `grantCapability` / imports `node:child_process` / lacks `export
     default` (each → `{ok:false, reasons:[…]}`); a clean candidate → `{ok:true}`. Then via the tool:
     `propose_improvement` with a vetoed source records `status:"vetoed"` (not evaluable); a clean one
     `status:"staged"`.
  2. **(test)** **isolation — no live load during eval** (AC-4): with an **injected stub evaluator**,
     `evaluate_candidate` records the delta but the candidate's tool/command is **NOT** in
     `e.agent.tools`/`e.commands` afterward (it never loaded live); the live extension set is unchanged.
  3. **(test)** **human gate via `ui.ask`, not yolo-able** (AC-5): `adopt_improvement` with a stub
     `ui.ask` returning a confirming string → adopts (the candidate's tool now appears); returning **null**
     → does **not** adopt (fails closed); a UI with **no `ask`** (headless) → does not adopt; a yolo/no-TTY
     context (`ui.ask`→null) does **not** auto-adopt.
  4. **(test)** **tamper-detection** (AC-6): with a stub evaluator returning `tamper:true`, the result is
     flagged and not treated as a valid improvement; a candidate source referencing `test/` is vetoed
     (AC-3 overlap).
  5. **(test)** **off-by-default inert + no restricted-API** (AC-7): loaded-but-not-enabled → the tools are
     inert; an adopted candidate (via the enabled path) is `unloadExtension`-removable; host canonical-set
     green.
  6. **(impl)** `src/extensions/self-improve.ts`: default-export `activate(e)`;
     `EAGENT_SELF_IMPROVE === "off"` → no-op. Config: `enabled` (store, default false), `maxStaged`
     (default 16). Implement `vetoCandidate` (export), the candidate-store helpers, and:
     - a **bespoke eval runner** `src/self-improve-eval.ts` (NOT `eval-runner.ts` — SEVERE-1): it
       `createAgentHost({ discoverDirs: [<staging candidate dir>], provider: "mock" })` (so the candidate
       **is** discovered + loaded — `host.ts:163/262`), then `runEvalDir(<fixtures dir>, agent, () =>
       getTrajectory({ store: host.storeFor("evals") }))` (design D4), prints `eval: X/Y passed`, exits.
     - the **real evaluator** `realEvaluate(candidatePath)`: prepare a **staging workspace copy** (the
       candidate in a discoverable `.eagent/extensions` dir + the eval fixtures; `node_modules` **symlinked**
       so `tsx`/deps resolve — the integration wrinkle), hash the staged fixtures; `if
       (detectBackend(process.platform, binExists) === "none") refuse` (harness-chosen fail-closed, S2);
       spawn `node --import tsx src/self-improve-eval.ts <stagingFixturesDir>` **wrapped via
       `wrapCommand(backend, "no-network", cmd, { root: stagingDir })`** with `env` scrubbed (PATH only);
       parse `eval: X/Y passed`; re-hash the fixtures (`tamper = pre !== post`); compare to the
       candidate-free baseline. **Containment (the real boundary):** the candidate loads in this **separate
       spawned process** (never the live agent), sandboxed `no-network` + confined to the ephemeral staging
       copy — so even arbitrary candidate code can neither reach the live agent (different process) nor the
       network nor the real repo. **This real path is integration-only / untested** (complex: copy + symlink
       + real launcher); offline tests use the **injected stub** evaluator — KDD-3.
     - `propose_improvement` tool (`capabilities: ["self:extend"]`): `vetoCandidate(code)`; bespoke
       `writeFileSync(.eagent/candidates/<slug>.ts, code)` (slugify the name like `self.ts`); record
       staged/vetoed; FIFO-evict past `maxStaged`.
     - `evaluate_candidate` tool: for a non-vetoed staged candidate, call the evaluator (real or the
       injected one) → record `delta/improved/tamper`. Does NOT load the candidate live.
     - `adopt_improvement` tool (`capabilities: ["self:extend"]`): for a non-vetoed candidate, surface the
       source + advisory delta; `const ok = e.agent.ui.ask ? await e.agent.ui.ask(<approve?>) : null;` —
       **adopt only if `ok` is a non-null confirming response** (fails closed otherwise, NOT yolo-able);
       on approval move the staged file to the live extensions dir + `await e.loadExtension(path)`
       (host-tracked → `unloadExtension`-reversible). Record `status:"adopted"`. NO restricted-API wrapper.
     - `/self-improve [on|off|status|list]` command.
     - **Evaluator DI (G1, committed shape):** a **module-level `setEvaluator(fn)` test hook** (default =
       `realEvaluate`), well-precedented (`self.ts:35` `extensionsDir` store override; `sandbox-tiers.ts:82`
       `forceBackend`). The factory-deps alternative is rejected: AC-4/AC-5 must drive the **real registry**
       (`host.use` + `agent.run` + MockProvider scripting the tool calls, the `ask.test.ts` pattern), where
       `activate(e)` takes no deps arg (`ActivateFn`, `extension.ts:83`) — so the evaluator must come from
       module state, not a factory. (The **`ui.ask`** injection needs no hook: tests set/omit it via
       `makeHarness({ ui })` exactly as `ask.test.ts:29-43/55-64`.)
  7. **(impl)** `src/host.ts`: `import selfImprove from "./extensions/self-improve.js";` and append
     `["self-improve", selfImprove]` to `BUILTIN_EXTENSIONS`.
  8. **(verify)** `node --import tsx --test "test/self-improve.test.ts" "test/host.test.ts"`;
     `npm run typecheck`.
- **Accept:** `node --import tsx --test "test/self-improve.test.ts" "test/host.test.ts"`; `npm run typecheck`.
- **Exit:** AC-3..AC-7 pass; off-by-default inert; human gate via `ui.ask` (not yolo-able); host
  canonical-set green; `npm test` green; typecheck 0.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" + "Adding an extension" — ESM NodeNext `.js`
  specifiers; strict TS (`noUncheckedIndexedAccess`); zero deps but jiti (`node:fs`/`node:crypto` for
  hashing + `node:child_process` only inside the harness's own sandboxed-spawn — the candidate source is
  vetoed against it, but the harness itself may spawn the eval); offline tests (injected stub evaluator +
  stub `ui.ask` — the real subprocess path is integration-only); `EAGENT_SELF_IMPROVE=off` kill switch;
  declares `self:extend`; append to `BUILTIN_EXTENSIONS`; **no kernel change**. Import the sandbox helpers
  (`wrapCommand`/`detectBackend`/`binExists`) **from `./lib/sandbox.js` directly** — `binExists` is not
  re-exported by `sandbox-tiers.ts`. **Safety-criticals:** the
  boundary is the eval-time subprocess+sandbox (KDD-1), NOT an in-process wrapper (none — KDD-5); the eval
  is **advisory + tamper-detected** (KDD-2); the gate is **human source-review via non-null `ui.ask`**, NOT
  `ui.confirm` (fails open under `--yolo`) and NOT the eval delta; adopt via host-tracked `loadExtension`.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):`; no AI attribution.

## 4. Data and Fixture Dependencies

`MockProvider` + a host slice with the extension enabled. A **stub `Evaluator`** (deterministic
`{baseline, candidate, delta, improved, tamper}`) and a **stub `UI.ask`** (configurable return) drive the
state machine offline — the real subprocess evaluator is never spawned in tests (KDD-3). Reuse the
staging-dir override pattern (a temp dir) so tests don't touch the real workspace. Offline; no new fixtures
(reuses Wave 7d's `evals/`).

## 5. Regression Protection

- `npm test` (full suite) green at Phase end. Off-by-default keeps the extension inert in the shipped
  config — existing suites unaffected (the core net).
- The canonical-set host test covers the registration (+1 extension; no dup tool/command names).
- No kernel change → `kernel-surface.test.ts` unaffected (2187). The real eval-subprocess path is
  integration-only (documented); the offline tests pin the state machine + veto + gate via injection.

## L2 Review Log

- **Round 1** — five L2 questions all pass; 1 SEVERE (SEVERE-1: the real evaluator spawned `eval-runner.ts`
  which hardcodes `discoverDirs:[]` → never loads the candidate, reintroducing S1) + 1 general (evaluator
  DI left as an either/or). Fixed: a **bespoke `src/self-improve-eval.ts`** runner
  (`createAgentHost({discoverDirs:[staging]})` + `runEvalDir`) added to the Files list; containment =
  separate spawned process + `no-network` + ephemeral staging copy; integration-only gap honestly flagged.
  Committed the module-level `setEvaluator` DI hook + `ui.ask` via `makeHarness({ui})`.
- **Round 2 (confirming)** — **zero severe, zero general** (one non-blocking precedent-nit). Two-generation
  satisfied. **L2 closed.**
