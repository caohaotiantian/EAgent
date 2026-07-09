# Implementation: `subagent-jobs` extension

```
Status: closed
Closing-commit: d0bcd95
Closed-on: 2026-07-09
Deferred: none
```

Task slug: `2026-07-09-subagent-jobs` (matches `docs/design/2026-07-09-subagent-jobs.md`).

## 1. Task Index

| Design artifact | Design doc location |
| --- | --- |
| Deliverables (extension, finalText export, host wiring, tests, docs) | `docs/design/2026-07-09-subagent-jobs.md` §2 |
| Scope Boundary (no persistence/DAG/streaming/typed-output; one additive export; no kernel edits) | §3 |
| Key Design Decisions 1–6 (new ext; Map registry; status-aware settler; dual recursion guard; caps; reuse resolvers) | §4 |
| Dependencies (reused exports; finalText not-exported; SPAWN_CAPS) | §5 |
| Acceptance Criteria 1–9 | §7 |
| Risks and Rollback | §8 |

## 2. Phase Breakdown

One Phase: the extension + the one-word `finalText` export + host wiring + doc rows — one contiguous Deliverable block that lands together and keeps `npm test` green.

### Phase 1 — the `subagent-jobs` extension, wired and tested

**Entry condition:** L1 design passed. No prior Phase.

**Design references:** `docs/design/2026-07-09-subagent-jobs.md` §2, §4 Decisions 1–6, §5, §7 AC 1–9.

**Design shape to implement (restated so a fresh agent needs no session context):**

- **One-word additive export in `subagents.ts`:** change `function finalText(` (`subagents.ts:487`) to `export function finalText(`. This is the ONLY edit to `subagents.ts`; no logic changes. (Fallback if disallowed: replicate its ~10 lines locally.)

- `src/extensions/subagent-jobs.ts`, default-export `activate(e): () => void`.
  - Imports: `Agent, currentActingAgent` from `../kernel/agent.js`; `defineTool, fail, ok` from `../kernel/define.js`; `resolveChildCapabilities, resolveChildProvider, finalText` from `./subagents.js`; `SPAWN_CAPS` from `./teams.js`; `ToolRegistry` from `../kernel/registry.js`; types (`Tool`, …) as needed. (Note: the job-child registry uses the new `jobChildRegistry` SPAWN_CAPS strip, NOT `childRegistryFrom` — the latter strips only `spawn_agent` by name and is insufficient here per Decision 4.2.)
  - **Job record:** `interface Job { id: string; status: "running"|"done"|"failed"|"cancelled"|"collected"; prompt: string; startedAt: number; child: Agent; promise: Promise<unknown>; result?: string; error?: string }`. Registry: `const jobs = new Map<string, Job>()` in the `activate` closure.
  - **Id gen:** copy `memory.ts:547-549` (per-activation `idBase = Math.floor(Math.random()*0xffffff).toString(36)` + `idCounter++`; no `crypto`). e.g. `job-<base>-<n>`.
  - **Config:** `enabled = () => e.config.enabled("subagent-jobs", { default: true })` (env veto `EAGENT_SUBAGENT_JOBS=off`); `maxConcurrent = () => e.config.int("subagentJobs.maxConcurrent", 4)`; `retain = () => e.config.int("subagentJobs.retain", 32)`.
  - **Root-only guard:** `const rootOnly = (): boolean => { const a = currentActingAgent(); return a === undefined || a === e.agent; }`. A job tool returns `fail(...)` when `!rootOnly()` (called from a sub-agent — no nested jobs).
  - **Job-child registry (SPAWN_CAPS strip) — an EXPORTED pure function** (mirroring the already-exported `childRegistryFrom` (subagents.ts:470) / `memberChildRegistry` (teams.ts:374) so AC 5 unit-tests it directly): `export function jobChildRegistry(parentTools: Tool[]): ToolRegistry { const r = new ToolRegistry(); for (const t of parentTools) { if (t.capabilities?.some(c => (SPAWN_CAPS as readonly string[]).includes(c))) continue; r.register(t); } return r; }`. Called at spawn time as `jobChildRegistry(e.agent.tools.list())`. (Strips `spawn_agent`, `run_team`, the workflow runner, AND the job tools — all declare a SPAWN_CAP.)
  - **makeJobChild(prompt, args):** resolve provider/model ONCE — `const { provider, model } = resolveChildProvider(args, parent);` (mirrors subagents.ts:213, not two calls) — then build `new Agent({ providers: e.agent.providers, capabilities: resolveChildCapabilities(args, parent), ui: e.agent.ui, logger: e.agent.logger, model, provider, systemPrompt: <args.system ?? default>, maxTurns: <args.maxTurns ?? config int subagents.maxTurns default 8>, tools: jobChildRegistry(e.agent.tools.list()), hooks: e.agent.hooks.childScope() })` — where `parent = { capabilities: e.agent.capabilities, ui: e.agent.ui, providers: e.agent.providers, providerName: e.agent.providerName, model: e.agent.model, log: e.log }` (same shape subagents.ts passes to the resolvers).
  - **`launch_job` (cap `agent:spawn`):** if `!enabled()` → `fail("subagent-jobs: disabled (EAGENT_SUBAGENT_JOBS=off).")`; if `!rootOnly()` → `fail("launch_job cannot be called from a sub-agent (no nested jobs).")`; validate `prompt` non-empty string. **Await-free check→insert (Decision 5):** count `running` jobs; if `>= maxConcurrent()` → `fail("at capacity (N running); collect or cancel a job first.")`. Else: `const id = newId(); const child = makeJobChild(prompt, args); const promise = child.run(prompt);` build `job = { id, status:"running", prompt, startedAt: Date.now(), child, promise }`; `jobs.set(id, job)`; **immediately** attach the status-aware settler:
    ```
    promise
      .then(r => { if (job.status !== "running") return; job.result = finalText(r.messages); job.status = "done"; })
      .catch(err => { if (job.status !== "running") return; job.status = "failed"; job.error = String(err); });
    ```
    then `evictFinished()` (FIFO-drop oldest finished record past `retain()`), return `ok(\`launched \${id}\`, { jobId: id })`. NOTE: `child.run(prompt)` is called synchronously in the same tick as the count-check and `jobs.set` (no `await` between) — preserve this.
  - **`job_status` (cap `agent:spawn`):** if `!enabled()` → fail; with `jobId` → return that job's `{ status, startedAt, resultPreview: result?.slice(0,200), error }` (or fail if unknown id); with no id → list all jobs `{ id, status }`. Does NOT await.
  - **`collect_job` (cap `agent:spawn`):** if `!enabled()` → fail; unknown id → fail. `await job.promise` (settled or not; the launch-time settler ran first by promise-reaction order, so `job.status/result` are populated). Then **status-aware**: if `job.status === "done"` → set `job.status = "collected"`, return `ok(job.result ?? "")`; if `cancelled` → return `ok("job <id> was cancelled")` (do NOT overwrite); if `failed` → return `fail("job <id> failed: " + job.error)`; if already `collected` → return `ok(job.result ?? "")`.
  - **`cancel_job` (cap `agent:spawn`):** if `!enabled()` → fail; unknown id → fail; if `job.status === "running"` → set `job.status = "cancelled"` (synchronously, BEFORE) then `job.child.stop()`; return `ok("cancelled <id>")`. If already terminal → no-op `ok("<id> already <status>")` (never throws).
  - **`/jobs` command:** if `!enabled()` → print disabled; else print each job `  <id> [<status>] <startedAt>`; empty → `(no jobs)`.
  - **`evictFinished()`:** while count of finished (`status !== "running"`) records `> retain()`, delete the oldest-by-`startedAt` finished record from `jobs`.
  - **Dispose:** return `() => { for (const job of jobs.values()) { if (job.status === "running") { job.status = "cancelled"; try { job.child.stop(); } catch {} } } }` — sets every running job terminal synchronously (so none remain `running`) and aborts its child; never throws. NOTE: the extension does **not** need to manually dispose its tool/command registrations — the ExtensionHost tracks every registration and combines it with this returned function into one `teardown` run on unload/reload (`extension.ts:90,238-258`). This returned dispose does ONLY the job-cancellation (the novel teardown); no `disposables` array is needed.
- **Host wiring:** append `["subagent-jobs", subagentJobs]` to `BUILTIN_EXTENSIONS` in `src/host.ts` after the `["subagents", subagents]` line, plus `import subagentJobs from "./extensions/subagent-jobs.js";`.
- **Docs:** one README extension-table row (command `/jobs`; capability `agent:spawn`; kill switch `EAGENT_SUBAGENT_JOBS=off`; note jobs are in-process, not persisted). One `### Added` CHANGELOG entry under `[Unreleased]`.

**Test harness (two provider behaviors — verified against `test/subagents.test.ts`):**
- **Completing child** (AC 1/2): `new MockProvider((req) => ...)` returning a final text answer for the child's run (branch on `req.systemPrompt`/prompt), so the child finishes promptly (`mock.ts:68` stream completes, checking `req.signal.aborted` between chunks).
- **Gated child** (AC 3/6/8): a tiny custom provider whose `async *stream(req)` sets a test-visible abort flag and blocks until aborted, then completes: `await new Promise<void>(res => { if (req.signal.aborted) { this.aborted = true; return res(); } req.signal.addEventListener("abort", () => { this.aborted = true; res(); }, { once: true }); }); yield { type:"done", message:{role:"assistant",content:[]}, stopReason:"end_turn", usage:{ inputTokens:0, outputTokens:0 } };` — the child blocks (job stays `running`) until `stop()` aborts it, at which point `run()` resolves `reason:"stop"`. The `aborted` flag is the AC-8 observable that `stop()` actually reached the child. This makes cancel/concurrency/dispose deterministic.
- Load via `await host.use("subagent-jobs", subagentJobs)`; also load `subagents` when a test needs the reused resolvers present. Resolve tools via `agent.tools.get("launch_job")` etc. and call `execute(args, { ...ctx })`.

**Task list, in TDD order** (write `test/subagent-jobs.test.ts` FIRST; each test names the invariant it protects):

1. **TEST** launch→collect round-trip (completing provider): `launch_job({prompt})` returns `{jobId}` quickly; `collect_job({jobId})` returns the child's final answer; then `job_status({jobId}).status === "collected"`. (AC 1)
2. **TEST** inspect without blocking: right after launch, `job_status({jobId})` returns a status without hanging; `job_status()` (no id) lists the job. (AC 2)
3. **TEST** cancel (gated provider): `launch_job` → `cancel_job({jobId})` → status `cancelled`; `collect_job({jobId})` reports cancelled (not an answer); `cancel_job` on unknown id → error; second `cancel_job` on the same job → no-op, no throw. (AC 3)
4. **TEST** recursion guard (runtime): register a probe tool ON THE ROOT agent — it must declare NO capability (so the SPAWN_CAPS strip in `jobChildRegistry` does not remove it, letting the reference survive into the child) — whose `execute` calls the extension's `launch_job`; script a child's mock to call that probe; run `child.run(...)` — inside the child, `currentActingAgent() !== e.agent`, so `launch_job` is refused (assert the child's tool result is the "cannot be called from a sub-agent" error and no new job was created). Then call `launch_job` from the root (acting === e.agent) → launches. (AC 4)
5. **TEST** recursion guard (registry): call the EXPORTED pure `jobChildRegistry([spawnStub, plainTool])` where `spawnStub = defineTool({name:"spawn_stub", capabilities:["agent:spawn"], ...})` and `plainTool` has no capabilities; assert the returned registry's `list()` EXCLUDES `spawn_stub` and INCLUDES the plain tool. Direct unit test (mirrors teams.test.ts's `memberChildRegistry` assertion), no host needed. (AC 5)
6. **TEST** caps: with `subagentJobs.maxConcurrent=1` (gated provider) one running job → a 2nd `launch_job` is refused with an at-capacity error; with `subagentJobs.retain=2`, launch+`await collect_job` three completing jobs **in sequence** (each finishing to `done`/`collected` before the next launch, so `evictFinished` runs on each launch), then assert `job_status()` (no id) lists exactly 2 records (the oldest finished dropped). (AC 6)
7. **TEST** kill switch: `EAGENT_SUBAGENT_JOBS=off` → `launch_job` reports disabled and creates no job; `/jobs` reports disabled. (AC 7)
8. **TEST** dispose cancels running (gated provider): `await host.use("subagent-jobs", subagentJobs)`, launch a gated (running) job, then `await assert.doesNotReject(host.unload("subagent-jobs"))` (the host-tracked dispose, the idiom in cost.test.ts:462 / budget-cap.test.ts:467). The observable is the gated provider's `aborted` flag becoming `true` — proving the running job's child received `stop()`. (Do NOT call `job_status`/`/jobs` after unload — the dispose unregisters them; the abort flag + `doesNotReject` are the post-unload observables.) (AC 8)
9. **IMPL** add the `export` to `subagents.ts` `finalText`; write `src/extensions/subagent-jobs.ts` to make tasks 1–8 pass.
10. **IMPL** wire `src/host.ts` (import + `BUILTIN_EXTENSIONS` row after `subagents`) and append the `README.md` row + `CHANGELOG.md` entry.

**Per-task acceptance commands** (from repo root):
- Jobs suite (tasks 1–8): `node --import tsx --test test/subagent-jobs.test.ts`
- Reused-helper non-perturbation: `node --import tsx --test test/subagents.test.ts test/teams.test.ts`
- Typecheck (AC 9): `npm run typecheck`
- Full offline suite incl. `test/kernel-surface.test.ts` (AC 9): `npm test`

**Exit condition:** `node --import tsx --test test/subagent-jobs.test.ts` passes (8 test tasks green), `test/subagents.test.ts` + `test/teams.test.ts` still green (the `finalText` export change did not perturb them), `npm run typecheck` exits 0, and `npm test` exits 0.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM + NodeNext `.js` specifiers; strict TS; zero runtime deps; single-file extension; `EAGENT_<NAME>=off` kill switch; append to `BUILTIN_EXTENSIONS`; offline `node:test`. Kernel untouched (`test/kernel-surface.test.ts` stays green). The only `subagents.ts` change is the additive `export` on `finalText` (behavior-neutral). Reads config only via `e.config`.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1): …` opener; `fix(phase1-roundR): <keyword>`; `<TEST-CMD>`/`<ACCEPT-CMD>` results as trailers; no AI/tooling mention.
- **Untypechecked test tree gotcha:** `test/` is not type-checked by either gate — ensure the test file's types are correct (no references to nonexistent harness fields; no unused imports; the custom gated provider must satisfy the `Provider` interface).

## 4. Data and Fixture Dependencies

- Reuse `test/helpers.ts` `makeHarness` and `MockProvider` (`src/providers/mock.js`). The gated provider is a small in-test class implementing `Provider` (`async *stream`). No filesystem fixtures. No new helpers in `test/helpers.ts` (avoid the Wave-1 shared-helper edit).

## 5. Regression Protection

- `npm test` stays fully green — especially `test/kernel-surface.test.ts` (surface + ceiling), and `test/subagents.test.ts` + `test/teams.test.ts` (the `finalText` export is additive and must not change their behavior; the reused resolvers are unmodified).
- The new `BUILTIN_EXTENSIONS` row loads an on-by-default extension whose tools are `agent:spawn`-gated and inert until called; default-install behavior of other extensions is unchanged (assert indirectly via the untouched `subagents`/`teams` suites staying green).
- Recursion invariant: the SPAWN_CAPS strip + the runtime root-only guard together ensure no job can be launched from a sub-agent and no job-child can spawn/launch — protected by AC 4/AC 5.
