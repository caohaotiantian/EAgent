# Design: `subagent-jobs` — an async sub-agent job lifecycle (launch / inspect / cancel / collect)

Task slug: `2026-07-09-subagent-jobs`
Wave 3 of "absorb harness-engineering lessons into EAgent".

## 1. Background and Purpose

The harness-engineering analysis (`analysis/harness-engineering-for-self-improvement.md`
§3) names "sub-agents & backend jobs" as a core design pattern: the parent
manages a job lifecycle — **launch, inspect, cancel, merge** — with parallelism
made *explicit and inspectable*, so an agent can fire off hypotheses and check
back on them rather than blocking.

EAgent's current sub-agent surface is **strictly synchronous**. `spawn_agent`
(`subagents.ts`) and `run_team` (`teams.ts`) both `await child.run(...)` and
return only when the child(ren) finish; the merge is text concatenation or lead
synthesis. There is no way to start a child, keep working, and collect it later —
no job handle, no `inspect`/`cancel` by id, no background execution. The parent
cannot overlap its own reasoning with a long child task.

This wave adds that missing lifecycle: a small **background job registry** on top
of the existing child-agent machinery, exposing launch / inspect (status) /
cancel / collect (merge) as tools, with a bounded number of concurrent jobs. If
we do not, the "backend jobs" half of the pattern stays unavailable and the
agent's only concurrency remains the all-or-nothing `mode=parallel` fan-out that
blocks until every child is done.

## 2. Deliverables

- [ ] `src/extensions/subagent-jobs.ts` — a single-file extension, default-export `activate(e): () => void`, that:
  - [ ] maintains an in-process **job registry** (a `Map<string, Job>` in the `activate` closure) — jobs hold live Promises and are process-lifetime, never persisted;
  - [ ] `launch_job` — construct a child agent (reusing `subagents.ts`'s exported child helpers), start `child.run(prompt)` **without awaiting**, immediately attach `.then/.catch` to record the outcome, and return a `jobId` while the child runs in the background;
  - [ ] `job_status` — inspect one job by id, or list all jobs (status + a result preview), without blocking;
  - [ ] `collect_job` — **merge**: `await` the job's settled result (or return it if already settled), returning the child's final answer. Status-aware, mirroring the settler: only a `done` job transitions to `collected`; a terminal `cancelled`/`failed` job is *reported as such*, never overwritten to `collected` (AC 1 vs AC 3);
  - [ ] `cancel_job` — `stop()` the child (aborts its run) and mark the job `cancelled`;
  - [ ] a `/jobs` command listing every job and its status (white-box inspection);
  - [ ] a **recursion guard** (§4 Decision 4) so a sub-agent cannot launch jobs and a job-child cannot spawn/launch anything;
  - [ ] a **concurrency cap** on running jobs (config `subagentJobs.maxConcurrent`, default 4) and a **retention cap** on finished job records (config `subagentJobs.retain`, default 32, FIFO-drop);
  - [ ] a kill switch `EAGENT_SUBAGENT_JOBS=off`; the tools declare `capabilities: ["agent:spawn"]`;
  - [ ] a dispose loop that **cancels every still-running job** on unload/reload (no orphaned children) and never throws.
- [ ] a single behavior-neutral additive `export` on `subagents.ts`'s `finalText` (the only change to `subagents.ts`; §3, §5) — or a local ~10-line replica.
- [ ] `src/extensions/subagent-jobs.ts` appended to `BUILTIN_EXTENSIONS` in `src/host.ts` after `subagents`.
- [ ] `test/subagent-jobs.test.ts` — offline `node:test` coverage for every Acceptance Criterion in §7.
- [ ] One extension-table row in `README.md`; one `### Added` CHANGELOG entry.

## 3. Scope Boundary (NOT in scope)

- **No cross-restart persistence.** A job owns a live in-process Promise and a live child `Agent`; it cannot survive a process restart. The registry is an in-memory `Map`, not `e.store`. (A durable job queue is a different, larger design — explicitly out.)
- **No job dependencies / DAG / scheduling.** Jobs are independent; no "job B after job A", no priorities.
- **No streaming of child progress.** `collect_job` returns the child's *final* answer; intermediate child output is not surfaced (the child runs under `childScope()`, which suppresses its run-lifecycle events by design).
- **No typed-output (`outputSchema`) contract for jobs.** `spawn_agent`'s typed-return path (`runTypedChild`) does two sequential runs and does not compose cleanly with a single background run; jobs return free-text final answers. Deferred.
- **No *behavioral* edits to `subagents.ts` or `teams.ts`.** This extension *reuses* their helpers. The **only** change to either is a single behavior-neutral additive `export` on `subagents.ts`'s `finalText` (currently unexported, `subagents.ts:487`) so this extension can share it (§5); no logic in `subagents.ts`/`teams.ts` changes. (Alternative, if even that is unwanted at L2: replicate `finalText`'s ~10 lines locally.)
- **No new capability.** Reuses `agent:spawn` (like `subagents`/`teams`).
- **No kernel edits.** `src/kernel/*` untouched.

## 4. Key Design Decisions

### Decision 1 — New extension vs. extending `subagents.ts`
- **Problem:** where does the job lifecycle live?
- **Options:** (a) add async modes to `spawn_agent`; (b) a new `subagent-jobs` extension reusing `subagents.ts`'s exported child helpers.
- **Choice: (b).** `spawn_agent`'s contract is synchronous ("returns the child's final answer"); bolting an async mode onto it muddies that contract and edits a load-bearing extension. A separate extension keeps the synchronous path untouched and composes the existing exported helpers (`scopedCapabilities`, `resolveChildCapabilities`, `resolveChildProvider`, `childRegistryFrom`, `finalText` — all already `export`ed from `subagents.ts`). Matches "new behavior is an extension".
- **Why (a) rejected:** breaks `spawn_agent`'s synchronous return contract; larger blast radius on a load-bearing extension.

### Decision 2 — In-process `Map` registry, not `e.store`
- **Problem:** where do job records live?
- **Choice:** an in-memory `Map<string, Job>` in the `activate` closure. A `Job` holds `{ id, status, promise, child (Agent, for stop()), prompt, startedAt, result?, error? }`. A live Promise and a live `Agent` are not serializable, so `e.store` (which JSON-round-trips) cannot hold them; and a "running job" has no meaning across a restart (the child's event-loop work is gone). Persisting would be a lie.
- **Why store rejected:** jobs are inherently process-lifetime; the analysis's "persistent storage makes parallelism inspectable" is satisfied here by the in-process registry + `/jobs` + `job_status`, not by disk.

### Decision 3 — Background execution: launch-without-await + eager `.then/.catch`
- **Problem:** how does a job run in the background without blocking the parent turn, and without crashing on an unhandled rejection?
- **Evidence (verbatim):** `subagents.ts:106-108` runs a child as `const child = makeChild(...); const { messages } = await child.run(prompt); return ok(finalText(messages))`. `child.run` returns a `RunResult` Promise (`agent.ts:220`). **Critically, an aborted run RESOLVES (fulfills), it does not reject:** `stop()` aborts (`agent.ts:171-172`), the loop breaks with `reason="stop"` and the catch sets `reason="stop"` *without rethrowing* (`agent.ts:333-334`), then `return { reason:"stop", messages }` (`agent.ts:346`). A `maxTurns` exhaustion *also* resolves `reason:"stop"` (`agent.ts:325-326`).
- **Choice:** `launch_job` builds the child, calls `const promise = child.run(prompt)` **without `await`**, and **immediately** (same tick, before returning) attaches a **status-aware** settler:
  ```
  promise
    .then(r => { if (job.status !== "running") return;   // cancel/dispose already set a terminal state — never clobber it
                 job.result = finalText(r.messages); job.status = "done"; })
    .catch(err => { if (job.status !== "running") return; job.status = "failed"; job.error = String(err); });
  ```
  The `if (job.status !== "running") return` guard is **load-bearing**: because an aborted run *resolves* (not rejects), a naive unconditional `.then` would set `done` and overwrite the `cancelled` that `cancel_job`/dispose set synchronously a moment earlier. The transition must be **job-status-based, not `reason`-based** — `reason:"stop"` cannot be read as "cancelled" because a legitimate `maxTurns` completion resolves the same way. So: only `running → done|failed` ever transitions here; a terminal status (`cancelled`/`collected`) is never overwritten. The child's async work interleaves with the parent's subsequent turn on Node's single event loop; `AsyncLocalStorage` (`agent.ts:75`, bound in `run()` at `agent.ts:221`) keeps each run's acting-agent context separate, so concurrent jobs and the parent do not cross wires. The eager `.catch` guarantees no unhandled-rejection crash.
- **Why alternatives rejected:** a worker thread/process is heavyweight and breaks the shared-provider/capability wiring; a synchronous `await` is exactly what already exists. Keying the settler off `reason:"stop"` (instead of job status) is rejected — it cannot distinguish a cancel from a `maxTurns` completion.

### Decision 4 — Recursion guard: runtime acting-agent check + capability stripping
- **Problem:** a background job must not spawn deep trees. Two escape paths exist: (i) a job-child inheriting spawn/job tools and spawning its own grandchildren; (ii) a `spawn_agent` child (from `subagents.ts`, which strips only `spawn_agent` **by name**, `subagents.ts:473`) inheriting `launch_job` and launching nested jobs.
- **Choice — two guards:**
  1. **Runtime root-only check** in every job tool's `execute`: `const acting = currentActingAgent(); if (acting && acting !== e.agent) return fail(...)`. `currentActingAgent()` (`agent.ts:76`) returns the agent whose `run()` is on the stack; it equals `e.agent` only at the root, so a job tool invoked from *any* sub-agent (a `spawn_agent` child, a team member, or a job-child) is refused. This closes path (ii) without editing `subagents.ts`.
  2. **Capability-stripped child registry** for jobs' own children, mirroring `teams.ts`'s `memberChildRegistry` (`teams.ts:367-381`): build the job-child's tools by excluding every tool whose declared `capabilities` intersect `SPAWN_CAPS = {agent:spawn, workflow:run}`. Since the job tools declare `agent:spawn`, this strips `spawn_agent`, `run_team`, the workflow runner, **and** the job tools from a job-child — so a job-child can spawn/launch nothing. This closes path (i).
- **Why one guard alone is insufficient:** the runtime check alone would let a job-child call `spawn_agent` (a different tool) to make a grandchild; the capability strip alone would not stop a `subagents.ts` child (name-stripped) from inheriting `launch_job`. Both are needed.

### Decision 5 — Concurrency cap (refuse, don't queue) + retention cap
- **Problem:** unbounded concurrent children exhaust providers/tokens; unbounded finished records leak memory.
- **Choice:** `launch_job` refuses (returns an error telling the caller to collect/cancel first) when the count of `running` jobs is at `subagentJobs.maxConcurrent` (default **4**). Finished (`done`/`failed`/`cancelled`/`collected`) records are retained up to `subagentJobs.retain` (default **32**), FIFO-dropping the oldest finished record past the cap. Refuse-not-queue is Simplicity-First: a queue needs its own scheduling/fairness policy that nothing here requires.
- **Atomicity:** the running-count check and the Map insert in `launch_job` must be **`await`-free between them** (the count read, the cap comparison, and `registry.set(id, job)` happen in one synchronous run of the execute body before `child.run()` is started). On Node's single event loop this makes the cap race-free; the child-option resolvers (`resolveChild*`) and `new Agent(...)` are synchronous, so this holds. L2 must preserve the no-`await`-in-between property.
- **Rationale for defaults:** 4 concurrent children bounds fan-out cost while allowing real overlap; 32 retained records is generous for inspection without growth. Both are config-overridable and test-measured (AC 6).

### Decision 6 — Child options: reuse `subagents.ts`'s resolvers, minus typed output
- **Problem:** which per-job child controls to support.
- **Choice:** `launch_job` accepts `prompt`, `system`, `maxTurns`, `readOnly`, `capabilities`, `provider`, `model`, resolved via the already-exported, already-tested `resolveChildCapabilities` / `resolveChildProvider` from `subagents.ts` (zero new resolution logic). `outputSchema`/typed-return is **not** supported (Scope Boundary — the two-run `runTypedChild` path does not compose with a single background run).
- **Why:** reusing the resolvers gives parity with `spawn_agent`'s safety controls (esp. `readOnly` for background explorers) at near-zero new code; typed-return is the one piece that genuinely does not fit the async model.

## 5. Dependencies and Assumptions

- **Reused exports from `subagents.ts`:** `scopedCapabilities` (`:291`), `readOnlyCapabilities` (`:301`), `resolveChildCapabilities` (`:319`), `resolveChildProvider` (`:344`), `childRegistryFrom` (`:470`) — all `export`ed today (verified). **`finalText` (`subagents.ts:487`) is NOT exported today** (`function finalText`, no `export`); L2 must add a one-word additive `export` to it — the minimal, behavior-neutral change §3 explicitly permits — or replicate its ~10 lines locally. **Default: add the additive `export`** (DRY; no behavior change), the single edit to `subagents.ts` this wave makes.
- **Capability-stripped child registry (`SPAWN_CAPS` exclusion):** `SPAWN_CAPS` is exported from `teams.ts` (`:105`) = `{agent:spawn, workflow:run}`. `memberChildRegistry` (`teams.ts:374`) **is** exported but is unusable directly here — it takes and registers a team `board` Tool that jobs have no analog of. So L2 imports `SPAWN_CAPS` and writes the ~5-line filter locally (exclude any parent tool whose `capabilities` intersect `SPAWN_CAPS`), mirroring `teams.ts:374-385`. No cross-extension helper export beyond `SPAWN_CAPS` (already exported) is needed.
- **Kernel surface used:** `new Agent({...})` construction (mirrors `subagents.ts:73-84`), `child.run(prompt)` → `RunResult` (`agent.ts:220`), `child.stop()` (`agent.ts:171`), `currentActingAgent()` (`agent.ts:76`), `e.agent.hooks.childScope()` (`agent.ts`/`hooks.ts`), `e.agent.tools.list()`, `e.agent.providers`, `e.agent.capabilities`, `e.config`, `e.registerTool`/`registerCommand`.
- **Config / kill mapping:** `e.config.enabled("subagent-jobs", { default: true })` → `EAGENT_SUBAGENT_JOBS=off`; `e.config.int("subagentJobs.maxConcurrent", 4)`; `e.config.int("subagentJobs.retain", 32)`.
- **Assumption:** `child.run()` rejects (not throws synchronously) on failure and honors `stop()` by ending with `reason:"stop"` (`agent.ts:334`); the eager `.catch` captures rejections. A `cancel_job` on a child that already finished is a no-op.
- **Id generation:** the zero-dep monotonic pattern from `memory.ts:547-549` (per-activation random base + counter; no `crypto`).

## 6. Relationship with Existing Designs

- Prior designs: `docs/design/2026-07-09-playbook-extension.md` (Wave 1) and `2026-07-09-self-extend-floor.md` (Wave 2) — siblings, no interaction. `docs/design/2026-07-07-centralized-config.md` — consumed for config.
- Terminology/behaviour anchors: `subagents.ts` (child construction, the exported helpers, the by-name recursion guard) and `teams.ts` (the `SPAWN_CAPS` capability-strip recursion guard). This design is a **peer** of those two, adding the async-lifecycle mode neither provides.
- **Warning — cross-extension interaction (documented, not a conflict):** `subagents.ts`'s `childRegistryFrom` strips only `spawn_agent` by name, so absent Decision 4's runtime guard, a `spawn_agent` child would inherit `launch_job`. Decision 4.1 (the `currentActingAgent()` root-only check) is precisely the mitigation; it is why that guard is mandatory, not optional.

## 7. Acceptance Criteria (measurable, automatable — offline `node:test`)

Test harness: `makeHarness()` + a scripted `MockProvider` responder so a child's `run` completes deterministically (mirrors `subagents`/`teams` tests). Load via `host.use`. Drive tools by resolving them from `agent.tools.get(name)` and calling `execute(args, ctx)`; the recursion guard is exercised by calling a job tool from within a child's `run` context (or by asserting the `currentActingAgent` branch directly).

1. **Launch → collect round-trip:** `launch_job({prompt})` returns a `jobId` and does not block; a subsequent `collect_job({jobId})` returns the child's final answer (the scripted mock's output). After collect, `job_status({jobId})` shows `collected`.
2. **Inspect without blocking:** immediately after `launch_job`, `job_status({jobId})` returns a status (`running` or `done`) without awaiting the child; `job_status()` with no id lists all jobs.
3. **Cancel:** `cancel_job({jobId})` on a running job marks it `cancelled`; a later `collect_job` reports it cancelled (not a child answer). `cancel_job` on an unknown id returns a clear error; on an already-finished job is a no-op that does not throw.
4. **Recursion guard (runtime):** `launch_job` invoked from a sub-agent context returns an error and launches nothing; from the root it launches normally. Because `actingAgentStore` is private (`agent.ts:75`) and only the `currentActingAgent()` getter is exported (`agent.ts:76`), the test exercises the guard by invoking `launch_job` from *inside a real nested `child.run()`* (a child whose registry still contains a `launch_job`-like probe), asserting the nested invocation is refused while the root invocation succeeds — no private-seam injection is assumed.
5. **Recursion guard (registry):** the child registry a job builds **excludes** every tool whose capabilities intersect `SPAWN_CAPS` — assert that a parent tool declaring `capabilities:["agent:spawn"]` (e.g. a stub, or `launch_job` itself) is absent from the job-child's tool list, while a plain tool is present.
6. **Concurrency + retention caps:** with `subagentJobs.maxConcurrent=1` and one still-running job, a second `launch_job` is refused with an at-capacity error; with `subagentJobs.retain=2`, after ≥3 finished jobs the registry retains exactly 2 finished records (oldest dropped).
7. **Kill switch:** with `EAGENT_SUBAGENT_JOBS=off`, `launch_job` reports disabled and creates no job; `/jobs` reports disabled.
8. **Dispose cancels running jobs:** after `launch_job` starts a (slow/never-settling scripted) job, calling the extension's dispose function marks/aborts the running job (its child received `stop()`), leaving no job in `running`; dispose never throws.
9. **Suite gates green:** `npm run typecheck` exits 0; `npm test` exits 0 (includes `test/kernel-surface.test.ts` — no kernel-line growth; and `test/subagents.test.ts`/`test/teams.test.ts` — the reused-helper providers are unperturbed). Test-file types verified separately (the `test/` tree is untypechecked by both gates).

Quality budget: `launch_job` returns promptly (it does not await the child) — AC 1/2 assert non-blocking by collecting/inspecting as separate calls. No latency threshold beyond "launch does not await" applies.

## 8. Risks and Rollback

- **Risk: unhandled promise rejection crashes the host.** Mitigated by the eager `.catch` attached at launch (Decision 3), asserted indirectly by AC 1/3 (a failing/cancelled child is captured as job state, not a throw).
- **Risk: the settler clobbers a cancelled/disposed status (an aborted run RESOLVES `done`).** This is the S1 defect surfaced at L1 design review. Mitigated by the status-aware settler in Decision 3 (`if (job.status !== "running") return`), so a terminal `cancelled`/`collected` is never overwritten; asserted by AC 3 and AC 8.
- **Risk: `collect_job` hangs on a non-settling child** (a hung provider that never resolves and is never cancelled). Not mitigated by a timeout (out of scope, §3) — `collect_job` awaits indefinitely, exactly as an `await child.run()` would today; the operator's recourse is `cancel_job` (which resolves the child via `stop()`, unblocking the awaiting `collect_job`). Acknowledged, not silently ignored.
- **Risk: orphaned background children on unload/reload or shutdown.** Mitigated by the dispose loop cancelling every running job (`child.stop()`), AC 8.
- **Risk: recursion / deep trees.** Mitigated by the two guards (Decision 4), AC 4/5; the cross-extension inheritance path is explicitly closed by the runtime check.
- **Risk: resource exhaustion (many concurrent children).** Mitigated by the concurrency cap (Decision 5), AC 6.
- **Risk: memory growth from finished records.** Mitigated by the retention cap (Decision 5), AC 6.
- **Risk: `AsyncLocalStorage` context bleed across concurrent jobs.** Mitigated by the kernel design (`run()` binds the store per-run, `agent.ts:221`); the guard reads the store, it does not write it. Not introduced by this extension.
- **Risk: kernel-ceiling regression.** Mitigated: no `src/kernel/*` edits; AC 9 runs `test/kernel-surface.test.ts`.
- **Rollback:** runtime — `EAGENT_SUBAGENT_JOBS=off` (no jobs can launch; existing ones are process-lifetime and end with the process). Permanent — remove the `BUILTIN_EXTENSIONS` line + delete the extension/test + README/CHANGELOG rows; no persisted state to migrate.
