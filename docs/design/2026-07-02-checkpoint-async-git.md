# Design — checkpoint async auto-snapshot git (item ①)

**Slug:** `2026-07-02-checkpoint-async-git` · **Tier:** Full (behavior change to a default-loaded
extension; a concurrency/ordering decision; a shared-helper conversion). Source: `docs/HANDOFF.md` §4
item ① ("The one item with real runtime cost"). Branch: `chore/finish-open-items`.

## 1. Background and Purpose

`checkpoint` (`src/extensions/checkpoint.ts`) is a **default-loaded** builtin. Its `beforeToolCall`
hook (`checkpoint.ts:128`) auto-snapshots the workspace before every tool that declares a mutating
capability (`fs:write`, `shell:exec`, `code:exec`). The snapshot runs several **synchronous**
`execFileSync("git", …)` calls through the shared `git()` helper (`checkpoint.ts:66-76`): `rev-parse`
(isRepo), `stash create`, `rev-parse HEAD`, `update-ref`, and — when the FIFO cap trims — `update-ref -d`.

`execFileSync` **blocks the Node event loop** for the full duration of each git subprocess. On the
multi-session HTTP host (`src/server.ts`), which loads `checkpoint` by default, this stalls *every*
session's request handling on *every* mutating tool call by *any* session. It is the one shipped
default-on behavior with a real, shared-host runtime cost. The `EAGENT_CHECKPOINT=off` kill switch
(`checkpoint.ts:59`) is the only mitigation shipped; the async-git follow-up was explicitly deferred
(`docs/design/2026-07-01-checkpoint-kill-switch.md` §"Explicit non-goals": *"Not making the git calls
asynchronous. … a separate, larger change … registered as a possible follow-up, not built here."*).

**If we do not fix it:** the shared host remains susceptible to event-loop stalls under concurrent load;
operators who care must disable checkpointing entirely (losing the undo safety net) rather than pay only
an async cost.

**Why it is not a one-line swap.** The kernel dispatcher runs `beforeToolCall` hooks **concurrently**
across a parallel tool-call wave (default `maxConcurrency === Infinity` → `Promise.all(calls.map(runOne))`,
`agent.ts:451-452`; each `runOne` → `executeGuarded` → `hooks.apply("beforeToolCall", …)`, awaited at
`agent.ts:496`). Today's **synchronous** git is what makes each snapshot atomic: `nextId()` (reads the
store list) → `stash create` → `update-ref` → `record()` (writes the store list) all run to completion
on the event loop with no interleaving. A naïve `execFileSync → execFile` swap would let two concurrent
snapshots both read the same `nextId()`, write the same `refs/eagent/checkpoints/<id>` (one clobbering
the other), and last-write-wins the store list — silent checkpoint loss / duplicate ids. So async
**requires** re-establishing that atomicity explicitly.

## 2. Deliverables

- [ ] The shared `git()` helper in `checkpoint.ts` runs `execFile` **asynchronously** (via
  `node:util` `promisify(execFile)`), returning `Promise<string | null>`; all callers `await` it.
- [ ] The auto-snapshot `beforeToolCall` hook is `async`, awaits the snapshot before returning the
  (unchanged) decision, so the **snapshot-before-mutation** ordering guarantee is preserved.
- [ ] **All** snapshots — the auto-hook path **and** the manual `/checkpoint` command — are
  **serialized** through one per-`activate` promise-chain queue so nothing can interleave
  `nextId()`/`update-ref`/`record()` — ids and refs stay atomic (a single uniform snapshot path).
- [ ] The `/checkpoint`, `/checkpoints`, `/rollback` command handlers become `async` (awaiting the
  async `git()`); their printed output and semantics are byte-identical.
- [ ] The extension docstring (`checkpoint.ts:1-25`) is updated to state the auto-snapshot git is
  asynchronous and serialized (removing the "runs synchronous git" wording at lines 21-24), and the
  `README.md:230` `checkpoint` row's stale parenthetical ("the auto-snapshot runs synchronous git on
  every mutating call") is corrected to reflect the async behavior.
- [ ] Tests: a concurrency test proving N concurrent auto-snapshots record N checkpoints with N
  distinct ids and N live refs (RED-verified against a non-serialized variant during L2); an
  ordering test proving the snapshot is recorded before the triggering tool's `execute` runs; all
  existing `test/checkpoint.test.ts` tests still pass.

## 3. Scope Boundary (NOT in scope)

- **Not** changing checkpoint's default-on status, the `EAGENT_CHECKPOINT=off` kill switch, the
  `REF_PREFIX` namespace, `MAX_CHECKPOINTS`, the store keys, the `Checkpoint` shape, or any command
  name / printed string.
- **Not** adding a git-subprocess **timeout** or cancellation. `execFileSync` had none; async keeps
  parity. A hung local git is out of scope (and strictly less harmful async than sync — it no longer
  blocks the loop). Noted as an accepted residual in §8.
- **Not** making checkpointing per-session or otherwise touching the server's process-shared extension
  model (that is RW4-2, a separate design).
- **Not** changing which capabilities trigger a snapshot (`MUTATING_CAPABILITIES`).
- **Not** touching `src/kernel/` — this is an extension-only change.
- **Not** parallelizing snapshots for throughput — serialization is a correctness requirement, and
  git snapshots are short; a concurrent-snapshot design is neither needed nor safe here.

## 4. Key Design Decisions

### D1 — Async mechanism: `promisify(execFile)`
**Problem:** replace blocking `execFileSync` with a non-blocking equivalent.
**Options:** (a) `node:util` `promisify(execFile)` — stdlib, returns `{stdout, stderr}`;
(b) manual `new Promise` around the callback `execFile`; (c) move `execFileSync` onto a worker thread.
**Choice:** (a). It is the canonical zero-dep Node idiom, keeps the helper a thin wrapper, and matches
the project's zero-runtime-dependency rule. It also mirrors the one existing async-subprocess precedent,
`core-tools.ts:10-19` (`import { promisify } from "node:util"; const execAsync = promisify(exec);`) —
adapted to `execFile` to keep the argv-array-no-shell safety the checkpoint git calls rely on
(`promisify(execFile)` does not yet exist in the tree, so this adds it). **Rejected:** (b) reimplements
what `promisify` gives for free (more code, no benefit); (c) a worker thread is massive overkill for
short local git calls and adds thread lifecycle/serialization complexity — a gross Simplicity-First
violation.

### D2 — Concurrency safety: a per-`activate` promise-chain queue
**Problem:** concurrent `beforeToolCall` hooks (default `Infinity` concurrency, `agent.ts:452`) would
interleave async snapshots and race on `nextId()`, `update-ref`, and the store list.
**Options:** (a) a promise-chain "tail" queue — each snapshot appends `tail = tail.then(runSnapshot)`,
so snapshots run one-at-a-time in enqueue order while the event loop stays free between them; (b) a
third-party mutex/semaphore library; (c) accept the race; (d) wrap the critical section in a synchronous
block (i.e. keep `execFileSync`).
**Choice:** (a). It is ~3 lines, needs no dependency, guarantees `nextId()`→…→`record()` runs without
another snapshot interleaving (the next queued snapshot starts only after the current promise fully
resolves, even across the current snapshot's internal `await`s), and keeps the loop non-blocking. The
codebase has no existing promise-chain-mutex idiom (the closest is `capabilities.ts:113`'s `#pending`
single-flight, which dedupes concurrent callers rather than serializing distinct work), so this is a
new but self-contained ~3-line construct. **Rejected:** (b) violates the zero-dep rule; (c) is a silent
correctness regression (duplicate ids, lost refs); (d) defeats the entire purpose (still blocks the
loop).

### D3 — Convert the single shared `git()` helper (vs. keep a sync helper for commands)
**Problem:** the `git()` helper is used by both the hot-path hook and the three user-initiated commands.
**Options:** (a) convert the one `git()` helper to async and `await` it everywhere (commands' `run`
become `async`); (b) keep `git()` sync for the commands and add a second async git helper for the hook.
**Choice:** (a). One helper, no duplication; command handlers already may be async (`mcp.ts` registers
`run: async (ctx) => …`), so making `run` async is free and the printed output is unchanged.
**Both** the auto-hook and the manual `/checkpoint` command route their snapshot through the **same
queue** (D2), so there is one uniform snapshot path and no manual-vs-auto race to reason about: manual
`snapshot()` shares `nextId()`/`update-ref`/`record()` and the store list with any in-flight auto
snapshot, so serializing them together is the only way to keep those atomic in every host (the CLI runs
commands between turns, but the queue makes correctness independent of that timing assumption). The
extra cost is nil (the command already awaits its snapshot). `/rollback` and `/checkpoints` also become
async (they `await` the async `git()`) but are **not** queued — they never touch the `nextId()`/
`update-ref`/`record()` allocation critical section, so they need no serialization. The atomicity
guarantee is scoped to a single `activate`/store pairing — which is exactly what every host has today
(one process-shared activation across CLI turns and across server sessions, §1); a hypothetical
per-session activation over one shared store is out of scope (§3, RW4-2). **Rejected:** (b) duplicates
the git-exec logic into two helpers — a DRY violation and more surface to keep in sync, for no benefit.

*(Best-effort git-never-throws is an invariant to preserve, not a design fork; its handling — including
the queue-tail safety — is covered in §8 Risks rather than smuggled in here as a one-option "decision".)*

## 5. Dependencies and Assumptions

- **Stdlib only:** `node:child_process` `execFile` + `node:util` `promisify` (zero new dependency;
  `promisify` is already used in `core-tools.ts:10-19`, here adapted from `exec` to `execFile`).
- **Assumption (verified):** `beforeToolCall` filter handlers may be async and are awaited —
  `agent.ts:496` `await this.hooks.apply("beforeToolCall", …)`; `hooks.ts:132-146` `apply` awaits each
  handler (`acc = await reg.fn(acc, context)`).
- **Assumption (verified):** command `run` may return a Promise — `mcp.ts:600` uses `run: async (ctx)`.
- **Assumption (verified):** the dispatcher may run `beforeToolCall` concurrently — `agent.ts:451-452`
  (`Infinity` fast path `Promise.all`) and the finite worker pool `agent.ts:458-467`.
- **Assumption:** git snapshot ops are short and local; serialization adds negligible latency versus the
  event-loop stall it removes.

## 6. Relationship with Existing Designs

- `docs/design/2026-07-01-checkpoint-kill-switch.md` — §"Explicit non-goals" deferred exactly this
  ("Not making the git calls asynchronous … a separate, larger change … not built here") and §"Closure"
  records it as "Deferred (out of scope)". **This design builds that deferred follow-up.** No conflict;
  it supersedes that single non-goal while keeping every other decision from that doc intact (kill
  switch, default-on, command surface).
- `docs/DEFERRED-FOLLOWUPS.md` — item ① is not a register ID; it is a HANDOFF §4 open item. The register
  is unaffected (no ID to strike). A closure note is added at F.
- No conflict with the kernel dispatch contract (`agent.ts`, `hooks.ts`) — this design relies on it
  unchanged.

## 7. Acceptance Criteria (measurable, automatable)

- **AC1** `node --import tsx --test test/checkpoint.test.ts` exits 0 (all existing tests plus the new
  ones).
- **AC2 (concurrency)** A new test, reusing the `harnessFor(workspace)` temp-git-repo harness
  (`test/checkpoint.test.ts:63-78`), drives a scripted responder that returns **N = 10** `toolCalls` for
  one mutating tool in a single turn (the existing single-tool responder at `checkpoint.test.ts:111-115`
  extended to a 10-entry `toolCalls` array), so the dispatcher fires 10 `beforeToolCall` hooks
  concurrently (default `Infinity`, `agent.ts:452`). It then reads `store.get("checkpoints", [])` (the
  same store read the kill-switch test uses at `checkpoint.test.ts:201`) and asserts: exactly 10
  checkpoints, **10 distinct ids** (`new Set(cps.map(c=>c.id)).size === 10`), and **10 live refs**
  (each `refs/eagent/checkpoints/<id>` resolves via `git rev-parse`). During L2 this test is RED-verified:
  removing the serialization queue makes it fail (duplicate ids / missing refs).
- **AC3 (ordering)** A new test registers a mutating tool (via `h.agent.tools.register`, as at
  `checkpoint.test.ts:124-139`) whose `execute` reads `store.get("checkpoints", [])` and asserts it sees
  its own pre-snapshot already recorded — proving the async hook `await`s the snapshot before the
  triggering tool runs.
- **AC4 (non-blocking)** A test asserts the auto-snapshot no longer uses `execFileSync`: `checkpoint.ts`
  source contains no `execFileSync` and the `git()` helper returns a Promise. (Structural assertion,
  deterministic; complements the behavioral AC2/AC3.)
- **AC5** `npm test` exits 0 (full suite, no regression); `npm run typecheck` exits 0; `npm run eval`
  exits 0 (5/5).
- **AC6** `src/kernel/` is byte-identical (`git diff --stat init -- src/kernel` empty for this change);
  no new entry in `package.json` dependencies.

*Note on manual-path coverage:* AC2 exercises the auto-hook wave. The manual `/checkpoint` path shares
the same queue (D3), so its atomicity is covered **by construction**, not by a dedicated test —
commands and `agent.run` are sequential in the harness, so a manual-concurrent-with-auto wave is not
naturally constructible there; the shared-tail proof (AC2) is the guarantee.

**Quality budget:** the change is on a hot path (every mutating tool call). The declared budget is
"the auto-snapshot must not block the event loop" — realized as AC4 (no `execFileSync`) plus AC3
(ordering preserved). A wall-clock latency threshold is intentionally **excluded** (git subprocess time
is environment-dependent and not the metric that matters; loop-non-blocking is).

## 8. Risks and Rollback

- **Risk — id/ref race under concurrency** (the core hazard). *Mitigation:* the D2 serialization queue;
  *guard:* AC2, RED-verified in L2.
- **Risk — ordering regression** (tool mutates before its snapshot completes). *Mitigation:* the hook
  `await`s its enqueued snapshot before returning the decision; *guard:* AC3.
- **Risk — a hung/slow local git delays the triggering tool call** (the awaiting hook waits for its
  snapshot). *Assessment:* strictly better than the sync status quo (which blocked the whole loop, not
  just one call); no timeout existed before. Accepted residual; a timeout is out of scope (§3).
- **Invariant — git must never throw out of a hook or command** (existing, `checkpoint.ts:18-19,73-75,
  136-138`). *Preservation:* the async `git()` keeps its `try/catch` returning `null` (never rejects), so
  `runSnapshot` itself never rejects; the hook keeps its outer `try/catch`; and the queue tail is
  additionally de-fanged (`tail = tail.then(runSnapshot).catch(() => {})`) so even a hypothetical
  rejection cannot poison the chain for the next snapshot. *(Alternatives considered: reset
  `tail = Promise.resolve()` on failure, or rely solely on `runSnapshot`'s internal catch and never guard
  the tail — the `.catch(()=>{})` is chosen as belt-and-suspenders that costs nothing and needs no failure
  bookkeeping.)*
- **Risk — behavioral delta: concurrent-wave snapshots become a progression, not a uniform pre-wave
  snapshot.** Today's synchronous `execFileSync` blocks the loop, so a whole wave's N snapshots all
  complete before any tool's `execute` runs — every snapshot captures the identical pre-wave workspace.
  Under async+serialized, tool *k* executes as soon as its own snapshot S*k* resolves, while S*(k+1)…n*
  are still queued — so a later snapshot may capture the workspace *after* an earlier tool in the same
  wave has begun mutating. More precisely: S*(k+1)* runs on the snapshot queue while tool *k*'s `execute`
  runs on a *different* execution path, so S*(k+1)*'s `git stash create` can execute **concurrently with**
  (not merely after) tool *k*'s in-flight write — an intermediate auto-checkpoint could therefore capture
  a mid-write tree. *Assessment:* the per-tool guarantee (S*k* is recorded before tool *k* mutates, AC3)
  is **preserved**; the change is that a wave's checkpoints reflect progressive states rather than one
  shared baseline — arguably more faithful ("checkpoint before tool *k*" genuinely means the state just
  before tool *k*). A possibly-torn *intermediate* snapshot is accepted as benign for a best-effort undo
  (low probability, small local writes, never the tool's-own pre-snapshot, and unavoidable in any
  non-blocking design). Accepted as an intended consequence of non-blocking async; not a correctness
  regression. Noted so a future reader is not surprised by non-identical intra-wave snapshots.
- **Rollback:** revert the single commit; `execFileSync` and the synchronous helper/commands are
  restored. The change is isolated to `src/extensions/checkpoint.ts` (+ its test); no kernel, no other
  extension, no dependency touched.
