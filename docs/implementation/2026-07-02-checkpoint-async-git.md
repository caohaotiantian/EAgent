# Implementation — checkpoint async auto-snapshot git (item ①)

**Slug:** `2026-07-02-checkpoint-async-git` · Design: `docs/design/2026-07-02-checkpoint-async-git.md`.

## 1. Task Index

| Design Deliverable (§2) | Design AC (§7) | Phase |
|---|---|---|
| Async `git()` via `promisify(execFile)`; all callers await | AC1, AC4, AC5 | P1 |
| Hook `async`, awaits snapshot before returning decision (ordering) | AC3 | P1 |
| All snapshots (auto + manual) serialized through one per-`activate` queue | AC2 | P1 |
| `/checkpoint`,`/checkpoints`,`/rollback` command `run` become `async` | AC1, AC5 | P1 |
| Docstring + `README.md:230` corrected (drop "synchronous git") | AC1 | P1 |
| Concurrency + ordering + structural tests; existing green | AC1–AC6 | P1 |

Design decisions: D1 (§4 promisify(execFile)), D2 (§4 promise-chain queue), D3 (§4 single async
`git()`, both paths queued). Invariant + risks: §8.

## 2. Phase Breakdown

### Phase 1 — Async, serialized checkpoint auto-snapshot (single Phase)

The change lands atomically: the git helper cannot be half-converted while leaving the suite green, and
the queue + async are one coherent unit. One Phase, one commit.

**Entry condition:** none (first Phase). Baseline green (`npm test` 1195 pass / 0 fail / 1 skip).

**Design references:** `docs/design/2026-07-02-checkpoint-async-git.md` §2 (Deliverables), §4 (D1–D3),
§7 (AC1–AC6), §8 (invariant + risks).

**Files:** `src/extensions/checkpoint.ts` (impl), `test/checkpoint.test.ts` (tests), `README.md:230`
(doc row).

**Task list (TDD order — tests before implementation):**

> **Harness note for T1/T2.** Do **not** use the bare `harnessFor(workspace)` helper (`:63-78`) — it
> calls `makeHarness({})` with no scripted responder and exposes no captured `e`/store handle. Build
> T1/T2 inline like the existing auto-snapshot dispatch test (`:106-149`): `makeHarness({ responder })`,
> `await host.use("checkpoint", (e) => { e.store.set("workspaceDir", workspace); captured = e; return
> activate(e); })`, register the mutating tool via `h.agent.tools.register` (`:124-139`), then
> `await h.agent.run(...)`, reading `captured.store.get("checkpoints", [])` afterward (`:201` idiom).

1. **T1 (test, AC3 — ordering regression guard).** In `test/checkpoint.test.ts`, register a mutating
   tool (capability `fs:write`, via `h.agent.tools.register` as at `:124-139`) whose `execute`
   **captures** `captured.store.get("checkpoints", [])` into an **outer variable** (e.g. `seenAtExec`)
   and returns normally — it must **not** `assert` inside `execute` (the dispatcher wraps `execute` in a
   try/catch at `agent.ts:474-478`, so a thrown assert becomes a swallowed error result and the test
   would pass vacuously). Drive it with a single-tool responder (as `:111-115`); **after**
   `await h.agent.run(...)`, `assert` that `seenAtExec` already contained this tool's pre-snapshot
   (length ≥ 1, newest entry's `toolName` is the tool). *Invariant protected:* the async hook must
   `await` the snapshot so it is recorded **before** the triggering tool executes
   (snapshot-before-mutation). (Discriminating power: dropping the `await` before `enqueueSnapshot` in the
   hook — fire-and-forget — makes this test go RED, since `execute` would capture an empty list.)
   *Acceptance:* `node --import tsx --test test/checkpoint.test.ts` — this test passes.

2. **T2 (test, AC2 — concurrency).** Add a test that scripts a responder returning a **10-entry
   `toolCalls`** array (all the same `fs:write` mutating tool) on turn 1, then `{text:"done"}`
   (extending the `:111-115` pattern to 10 calls with distinct ids `w0…w9`). After `await h.agent.run(...)`,
   read `captured.store.get<Checkpoint[]>("checkpoints", [])` and assert: `cps.length === 10`;
   `new Set(cps.map(c => c.id)).size === 10` (10 distinct ids); and each `refs/eagent/checkpoints/<id>`
   resolves — verify with `execFileSync("git", ["rev-parse", "--verify", \`refs/eagent/checkpoints/${id}\`],
   {cwd: workspace, stdio:["ignore","pipe","ignore"]})` returning a sha for every id (no throw).
   *Invariant protected:* concurrent `beforeToolCall` snapshots must not collide on id/ref — the
   serialization queue. (The harness default `maxConcurrency` is `Infinity`, so the 10 hooks fire
   concurrently — do **not** set `executionMode:"sequential"` on the tool.)
   *Acceptance:* `node --import tsx --test test/checkpoint.test.ts` — this test passes.

3. **T3 (test, AC4 — structural, RED-against-current).** Add a test that reads the `checkpoint.ts`
   source directly via `readFileSync(new URL("../src/extensions/checkpoint.ts", import.meta.url), "utf8")`
   (a fresh grep of the source text — no existing suite test does this, so introduce it here) and asserts:
   it does **not** contain `execFileSync`, and it **does** contain `promisify(execFile)`. *Invariant
   protected:* the auto-snapshot must not block the event loop (no synchronous exec). This test is
   **RED against the current sync code** (which imports `execFileSync`) → GREEN after task 4.
   *Acceptance:* `node --import tsx --test test/checkpoint.test.ts` — this test passes (only after
   task 4).

4. **Implementation** in `src/extensions/checkpoint.ts`:
   - Replace `import { execFileSync } from "node:child_process"` with
     `import { execFile } from "node:child_process"` + `import { promisify } from "node:util"`; add a
     module-level `const execFileAsync = promisify(execFile)`.
   - Convert `git(args)` to `async (args): Promise<string | null>` — `await execFileAsync("git", args,
     {cwd: workspace(), encoding:"utf8"})` then `.stdout.trim()`, keeping the `try { … } catch { return
     null }` (never throws — §8 invariant). (Note: `stdio:["ignore","pipe","ignore"]` from the sync
     form is not an `execFile` option; use `{cwd, encoding:"utf8"}` and ignore `stderr` — `execFile`
     buffers it but we discard the result.)
   - Make `isRepo()`, `record()`, and `snapshot()` `async` and `await` the async `git()` (`record()`'s
     `update-ref -d`, `isRepo()`'s `rev-parse`, `snapshot()`'s `stash create`/`rev-parse`/`update-ref`).
     `nextId()` **stays synchronous** — it only reads the store, no git. `snapshot()` becomes
     `async (label, toolName?): Promise<Checkpoint | null>` and `await`s `record()`.
   - Add the **serialization queue** at `activate` scope: `let tail: Promise<unknown> = Promise.resolve();`
     and `const enqueueSnapshot = (label: string, toolName?: string): Promise<Checkpoint | null> => {
     const p = tail.then(() => snapshot(label, toolName)); tail = p.then(() => {}, () => {}); return p;
     };` (the tail is de-fanged so a rejection can't poison the chain — §8).
   - The `beforeToolCall` hook becomes `async`: on a mutating capability, `const cp = await
     enqueueSnapshot(\`auto: ${name}\`, name);` (keep the outer `try/catch` + `e.log.debug`), then
     `return decision`.
   - Route the **manual** `/checkpoint` command through the queue: `run: async (ctx) => { … const cp =
     await enqueueSnapshot(label); … }`. Make `/checkpoints` and `/rollback` `run` `async` (they `await`
     the async `git()` for `isRepo()`/`checkout`); their printed strings are unchanged.
   - Update the **docstring** (`:20-24`, `:56-58`) to say the auto-snapshot runs git **asynchronously**,
     serialized through a per-activation queue (remove "runs synchronous git"). Update **`README.md:230`**:
     replace "(the auto-snapshot runs synchronous git on every mutating call)" with an async-accurate
     parenthetical, e.g. "(the auto-snapshot runs async, serialized git on every mutating call)".

5. **RED-verification of T2 (mutation check — not a committed change).** Temporarily delete the queue
   (call `snapshot(...)` directly in the hook instead of `enqueueSnapshot`), run
   `node --import tsx --test test/checkpoint.test.ts`, and **confirm T2 FAILS**. The RED assertion must
   key on the **deterministically-collidable signal — duplicate ids** (`new Set(ids).size < 10`): with no
   queue, both concurrent snapshots read `nextId()` (synchronous store read) before either `record()`s,
   so they reliably compute the same id — this collision is timing-independent. (The ref-resolution
   assertion is a secondary witness; do not rely on it alone as the RED signal.) Then restore the queue
   and confirm T2 passes. Record the observed failure in the dev notes / commit body; do **not** commit
   the mutated variant.

6. **Full gates.** Run `npm test`, `npm run typecheck`, `npm run eval`, and
   `node --import tsx --test test/kernel-surface.test.ts` (to confirm `src/kernel/` is untouched — AC5/AC6).

**Exit condition:** AC1 (`test/checkpoint.test.ts` exit 0 with T1/T2/T3), AC2/AC3/AC4 tests pass, T2
RED-verified via task 5, AC5 (`src/kernel/` byte-identical), AC6 (no new dependency), and full-suite
`npm test` / `npm run typecheck` / `npm run eval` all exit 0.

## 3. Engineering Constraints Index

- **Engineering norms:** `CLAUDE.md` "House conventions" — ESM + NodeNext (`.js` import specifiers even
  for `.ts`), strict TypeScript (no `any`; model the async return types), zero runtime deps except
  `jiti` (`promisify`/`execFile` are stdlib — no new dep), capability-gated privileged tools unchanged,
  offline tests only. No Claude/AI attribution in commits.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md "Commit conventions" — `feat(phase1):` opener, `fix(phase1-roundR):
  <keyword>` within-round; `<TEST-CMD>`/`<ACCEPT-CMD>` result trailers; no AI attribution.

## 4. Data and Fixture Dependencies

Reuse the existing `test/checkpoint.test.ts` temp-git-repo harness (`makeRepo` `:46-60`, `harnessFor`
`:63-78`, the module-level `tempDirs`/`after` cleanup `:23-31`, and the env-restore `finally` pattern
`:202-205` if any test sets env). No new fixtures. The 10-tool responder is an extension of the
existing single-tool responder (`:111-115`).

## 5. Regression Protection

All current `test/checkpoint.test.ts` tests must stay green (command tests, the auto-snapshot dispatch
test `:106-149`, the `EAGENT_CHECKPOINT=off` kill-switch test `:161-206`). The full `npm test` suite
(1195 pass / 0 fail / 1 skip) must remain green — especially any test that dispatches a mutating tool
through the agent loop (the async hook must not change observable dispatch behavior beyond timing).
`node --import tsx --test test/kernel-surface.test.ts` confirms the kernel is untouched.
