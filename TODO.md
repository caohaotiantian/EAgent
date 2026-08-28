# TODO

**Re-checked 2026-08-25 by running, not by reading.** Every item in A–H below carries a
verdict and the command that produced it; the tables at the head of each section are the
index. 107 items were checked, 106 of them by executing something — 19 DONE, 52 still open,
30 partial, 2 wrong, 2 stale, 2 with no mechanical truth value.

**State at re-check (2026-08-25, before `packages/eagent` was deleted):** 58 source files in `packages/core`, 106 in `packages/eagent` (65
extensions); 3587 tests passing (core 2040, eagent 1,547); zero-dep and public-surface guards
green at 524 exports.

**State today (2026-08-28):** 61 source files in `packages/core`, which is the whole runtime;
2,442 tests passing; four guards green — zero-dep, public surface at 525 exports, and the
kernel file list at 10 files carrying 8 declared seams. The account of the 2026-08-27/28
session is the block below. (Was 62 / 2,468 / 540 before `journal/retention.ts` and its
26-test suite were deleted — §D.14.)

## State at 2026-08-28 — what the long session closed, and what it left

**116 commits on `loom` since `86b84c9`. Gate: 2,468 tests, 0 fail; zero-dep, surface at 540
pinned exports, kernel at 10 files. Live provider spend across the whole session: $1.59.**

**THE ROADMAP IS CLOSED.** All eight items in `DESIGN.md`'s Sequence now name a command that
passes. The last one — "a candidate promoted over that cohort because it measurably beat the
baseline" — was met against a live provider: 20 paired inputs, 20 wins, 0 losses, one-sided 95%
lower bound 0.1059, and the candidate 42% cheaper. It is a PROMPT candidate, which is what D6
defines self-improvement as and precisely what the replayed gate structurally cannot see. The
record is `docs/evolution-loop-2026-08-27.md`.

**THE KERNEL SEAM CENSUS WENT 2 -> 8**, four distinct seams declared twice each by their two
halves: an operator command the executor must consult, a payload that is a REFERENCE, running
the undo of an effect that already happened, and a durable fact gaining a discriminant. That
ledger exists so this cannot happen quietly; `git log --grep='^Kernel-seam:'` is the count.
Whether four new seams in one session is the right price is the maintainer's call, not the
implementer's.

**THE DEFECT CLASS THAT ACCOUNTED FOR NEARLY EVERY REAL FINDING**, stated once because it will
recur: *a guard answering its undecidable case with the passing value.* Members found this
session — `gateCandidate` certifying a candidate it never ran; 0% vs 0% satisfying
"non-inferior"; an empty suite reported valid; a new audit rule firing on healthy journals the
product itself writes; a cost ratio over a zero baseline reported as "1.00x"; a deferral budget
that bounded everything except the last deferral; `loom score` reporting outcome 0 for a run
whose graph it could not find. Three of those were introduced BY this session and caught by its
own reviewers.

### What is still open, by section

| section | open | the shape of it |
|---|---|---|
| §A0 | 17 bullets | audit findings; five are NEW measurements from this session |
| §A | 3 | defects and unguarded behaviour |
| §B | 10 (6 open, 4 partial) | declared and wired to nothing — down from 13 |
| §C | 11 | unbuilt observability; §C.4 closed by the subgraph span |
| §D | 13 | **decisions, and they are the maintainer's** — see below |
| §E | 7 | deferred on purpose; do not revive without reading the reason |
| §F/§G/§H | 19 | facts to carry forward, field-survey work, housekeeping |

### §D — the thirteen the implementer must not answer alone

`D.2` **the real numbers** (tenants, concurrent runs, runs/day, retention) is the one to answer
first: `D.13` (CPU pool) is the only item still resolving on it. **`D.14`, `D.19` and the
admission-control half of `D.4` all came off that list on 2026-08-28, by three different routes** —
`D.14` was answered by DELETION and turned out never to have depended on the numbers, and `D.19`
and `D.4`-admission were both REFUSED under `D.2` = one machine, one tenant, the maintainer's own
workflows. `TenantId`, `ProjectId` and `Budget.tenantUsd` were deleted in that change — three types
waiting on a question that has now been answered. Then `D.5` identity source of truth, `D.6` which approval callback
is mandatory, `D.7` providers at launch (half answered in code), `D.8` what a join timeout
does, `D.9` whether a function body's output becomes a journaled effect,
`D.15` quorum and delegation, `D.18` the mailbox. `D.10` the `preAuthorization` envelope came off
this list 2026-08-28, answered by permanent refusal rather than by a build.

`D.14` retention tiering was on that list and came OFF it 2026-08-28 without `D.2` being
answered — it turned out not to depend on the numbers at all. Its row below carries the
argument; the short form is that the run-rate figure was the LAST reason, not the first.

### Named residue from this session's lanes, so it is not rediscovered

- **Budgets** — a subgraph child inherits neither new ceiling (only the dollar slice); `wallMs`
  is settled-only so it cannot refuse the call that CROSSES the ceiling, only the next one; and
  node-level `wallMs` is implemented but demonstrated only at the run level.
- **Operator** — `kill` is NOT built, and the reason is measured rather than a shortfall: §D.4
  defines it as "cancel that does not wait" and `cancel` does not wait
  (`test/run/cancel-does-not-wait.test.ts`). `steer`'s refusal names ONE node type, the one
  that was demonstrated; it is not a proof about the other seven.
- **Compensation** — a rewind whose rollback FAILS still appends `checkpoint.restored`;
  `#compensateOne` invents the undo's arguments when the original recorded no `details`; the
  `nodeApproved: false` at the compensation dispatch is load-bearing and no test discriminates
  on it.
- **Externalisation** — `evolution/trajectory.ts` folds `task.committed.writes` and not the
  `external` map, so a step's externalised writes are invisible to the self-improvement
  evidence; several hardening branches in `run/externalise.ts` are green on arrival.
- **Rate limits** — one row of §A's failure table stays RED: a 429 arriving after a
  non-idempotent `effect.started` with no `effect.completed` refuses both a retry and a
  deferral, because the world may already have changed. A deferral still counts toward E4's
  consecutive-failure streak. **Admission control is DECIDED AND WILL NOT BE BUILT** (2026-08-28,
  §D.4): `POST /runs` admits everything it can authenticate and always will, because under one
  tenant the right answer to "too much work" is to make it wait, never to say no. What ships
  instead is a CEILING — `loom serve --max-runs-in-flight N` (default 4) bounds how many runs
  this process drives at once, the surplus waits, and `runClockTick`'s widened `due` predicate
  re-derives it from the journal. `E_ADMISSION_REJECTED` was DELETED rather than left unraised
  and stays deleted; so do a queue-depth field, a token-bucket config block and the
  `loom.schedule.admit` span.
- **Subgraph spans** — there is no OTLP exporter in the repo, so `SpanLink.traceId` has no
  consumer outside the splice; there is no HTTP trace endpoint; the span taxonomy was NOT grown
  (a subgraph still renders as `loom.tool`), because a ninth name is a D9.1 decision.
- **`suite freeze`** — its unresolved-gate exclusion is a guard over a state nobody has
  constructed. Mutating it away leaves the suite green. Dead code to delete with an argument, or
  a reachable state that needs a fixture; nobody knows which.

---

Nothing here is a plan. **An item surviving is a choice; an item being dropped is also a
choice.** The roadmap lives in `DESIGN.md`'s Sequence, not here.

Two files carry the rest: **`docs/audit-2026-08-25.md`** holds the complete set of 77 audit
findings, including the tail that changes nothing and the 3 that were refuted, so the set
can be named rather than asserted. It also records what became of the **gated tier**: five
findings were held by cases that asserted the defect still reproduced, so each failed loudly the
moment it was fixed. All five fired by 2026-08-26 and the file is gone.

---

## A0 · From the 2026-08-25 audit — what changes what you would do

20 agents over 9 dimensions, each dimension's findings then attacked by an independent
verifier that rewrote 42 of 74 claims and moved severity on 48. What follows is the subset
that changes an action. **`REPRO`** meant a case that EXECUTED the finding and failed when it was
fixed; all five such cases have now fired and been retired — see `docs/audit-2026-08-25.md`.
**`CITED`** means file:line at sha `86b84c9`, checked by reading. **`NEW`** means the backlog
re-check, or the first real workload, found it — not the audit.

### Two writers over one journal — what the deployment lane found `NEW`

The four defects DESIGN.md item 2 names are all FIXED, and its `Fails today` scenario PASSES —
driven end to end, 333 ms, and now pinned by `test/deployment/restart-and-answer.test.ts`.
**Whoever reads item 2 next must not re-fix four fixed bugs.** What was missing was an
instrument for two concurrent WRITERS, and building it found five things nothing in the
in-process suite could see. All five are fixed; they are recorded here because the CLASS is not
closed and the next member will look like one of these.

- ~~**A gate decision went out the door that RETRIES.**~~ **FIXED 2026-08-27.**
  `HumanGateBroker.resolve` checked the gate at `p.seq` and wrote through `RunLog.append`
  ("retries on seq conflict because the events are unconditional") while its three neighbours
  in the same file use `RunLog.commit` ("NEVER retries"). Two planes over one SQLite file
  produced `gate.decided 2 | run.resumed 2 | task.leased 3 | task.committed 2 | run.failed 2`,
  both calls fulfilled. `projection.ts` had carried the diagnosis in a comment for as long as
  the fold's defence against it had existed — the FOLD was hardened and the WRITE was left.
  **Residue:** the same check-then-unconditional-append shape may exist at other `log.append`
  call sites; `HumanGateBroker.claim` is one, and it re-reads afterwards, which is why it was
  left alone. `/usr/bin/grep -an 'log\.append' packages/core/src/run/*.ts` is the command that
  would enumerate the rest. Widening the fix would have turned it into an audit of every writer.
- ~~**Every plane on every machine called itself `worker-0`.**~~ **FIXED 2026-08-27.**
  `Engine` defaults `workerId` to `"worker-0"` and `cli.ts` never passed one, so
  `LeasedScheduler.select`'s `held.workerId === input.workerId` — "my own lease, take it back"
  — read a live FOREIGN lease as its own. `openWorkspace` now passes
  `${hostname()}:${pid}:${ordinal}`. **Residue, a real trade and not a bug:** a plane that
  RESTARTS gets a new name, so it can no longer reclaim its own pre-restart leases through the
  identity arm and waits for `reclaimable()` instead. That is arguably correct — after a
  restart they ARE foreign — but nobody has measured what it costs a fast redeploy.
- ~~**The auditor guarded a run's START and left its END to nobody.**~~ **FIXED 2026-08-27.**
  Three at-most-once rules added — `gate.decided-once`, `run.terminal-is-last-and-once`,
  `task.leased-once` — each the missing mirror of one that already existed. Measured against
  the two-writer journal: 1 of 5 contradictions caught before, 5 of 5 after.
- ~~**Two excuses in `audit-coverage.test.ts` were false claims.**~~ **FIXED 2026-08-27.**
  `run.failed` and `run.cancelled` were `{kind: "no-relation"}`; a journal with two `run.failed`
  rows falsifies that. The excuse list is the file's stated contract, and a false entry in it is
  worse than the missing rule.
- ~~**The run clock's rotation cursor was process memory.**~~ **FIXED 2026-08-27.**
  `startRunClock` built `const rot = { offset: 0 }` and nothing reconstructed it, so the 200-run
  starvation §E.2 records was fixed for a plane that stays up and unfixed for one that restarts.
  Measured with its control on one 250-run journal: long-lived rot reached the oldest run on
  tick 1; a rot rebuilt each boot never reached it in 20 boots. The window is now
  `(floor(now / lapMs) * limit) mod N` and remembers nothing. **This means §E.2's run-clock
  starvation was only HALF resolved, and the doc that recorded it never said so.**

**What is still open on this axis, and neither is a defect:**

- `RUN_CLOCK_SCAN_CEILING`'s residual: a run past 10,000 is reached by no lap, and
  `RunClockTick.truncated` is the only reason anyone knows. The fix `runClockTick`'s own
  docstring names is a CURSOR — `listRuns(after)` in `StateStore`, with a conformance test
  behind it — and when it lands the rotation is the thing to delete.
- Two planes now AGREE on a window rather than dividing it: correct, and wasteful, because they
  duplicate every fold. §E.2 defers "which runs a worker considers" as needing a coordinator and
  that is still true. Both of these want the same cursor.
- **WHAT ELSE IS PROCESS-LOCAL AND UNRECONSTRUCTABLE?** `startGateClock`'s `armed` map is memory
  too — a memo, so losing it costs a fold rather than correctness, which is why it was left. The
  generalisable lesson `oversight-survives-restart.test.ts` states is that the unit needing a
  restore arm is not the FIELD but the PRODUCER. A deliberate sweep of every long-lived
  `new Map()` and `{ … }` in `cli.ts` is what would close the class; nobody has done it.

### The oversight floor can be lost silently, three ways

- ~~**A declared posture is discarded when its VALUE is out of vocabulary.**~~ **FIXED
  2026-08-25.** `maxPosture`/`postureRank`/`isLoosening`/`maxClassification` now rank an
  unreadable member at the **strongest**, not at nothing, and `compile` refuses an
  out-of-vocabulary `policy.posture` with `GRAPH003_UNKNOWN_POSTURE` naming the legal values.
  No throw was introduced in the folds — a journaled event carrying a bad value still folds,
  which is why the fold tightens rather than refuses. **Residue, still open:**
  `ToolRegistry.register` validates no manifest field, so `irreversibility: "nuclear"` is still
  accepted — it now floors that node at `in` rather than `out`, which is fail-closed but is not
  validation. Original finding:
  `maxPosture` (`vocab.ts:29`) starts at `out` and replaces only when
  `POSTURE_RANK[p] > POSTURE_RANK[best]`; a miss is `undefined`, and `undefined > 0` is
  false. So `policy: {posture: "strict"}` compiles **`ok`** and runs at `out` — the weakest
  posture — and `isLoosening("in", "IN")` returns `false`, so the guard cannot see it.
  Nothing in the tree checks membership: there is no `isPosture`. The same shape holds for
  `Classification` and `IrreversibilityClass`.
- ~~**The unknown-FIELD check does not reach inside `policy` or `budget`.**~~ **FIXED
  2026-08-25** at both graph and node scope, for `policy`, `policy.budget` and
  `policy.expansion` — six scopes now, not four. **Residue, deliberately re-scoped rather than
  closed:** the same hole remains for `retry` and every other nested block, which `NODE_FIELDS`'
  own docstring already names. Original finding: §A.1 records
  this as DONE "at all four scopes" and it is DONE for the node block — `policyy` is caught
  with a suggested fix. But `policy: {posturr: "out"}` compiles `ok`, and
  `budget: {nonsense: 5}` compiles `ok`. Combined with the entry above, an author loses a
  declared `posture: "in"` by misspelling either the key or the value, and both compile
  clean. This is the family §A.1 was written to close.
- ~~**An approval binds the graph and the task, never the args.**~~ **FIXED 2026-08-25.** An
  approval now binds a digest of what it will execute — node spec, posture, irreversibility, the
  observed state, a `tool.args` fingerprint and (added after a verifier found the hole) a
  subgraph's delegated inputs. A payload that changed between approval and dispatch fails the
  task with `E_GATE_REQUIRED`, reporting both digests. Original finding: `engine.ts:2482`
  reads the settled gate and `:2501` dispatches, with no comparison of the payload between
  them; the three `contentDigest` mentions in `engine.ts` (`:1466`, `:1650`, `:4405`) are all
  **comments**, so nothing executable pins the payload at dispatch. A concurrent write to a
  channel the gated node reads changes what the approved node executes, while `openGates`
  keeps serving the raise-time payload under an unchanged digest.

### The journal is not authoritative for spend

- ~~**`foldRun` never folds `model.called`.**~~ **FIXED 2026-08-25**, and this was the dangerous
  half: `engine.ts` restores the policy's spend from the projection on resume, so the under-count
  refunded budget across a restart (measured 4.8x overrun). Original finding: Spend IS journaled
  (`events.ts:264-270`, appended at `engine.ts:3599`) but the projection folds only
  `task.committed.usage` (`projection.ts:734`), so the spend of any task that retried or
  threw is absent — and `Engine.attach` re-seeds `PolicyEngine` from that projection
  (`engine.ts:1237`), refunding it on restart. **This is not a sixth member of §F.1's
  class. It is member #3 (accumulated spend) failing at a different layer:** the restore
  arm exists and works; what it restores from is incomplete. Same defect with no restart
  at all — reported run cost under-reports what the provider billed.

### Replay is less hermetic than it reports

- ~~**`ctx.now()` does not reproduce.**~~ **FIXED 2026-08-25.** Original finding: Two replays of one run returned values
  apart — the delta is whatever pause sat between them (1161 ms, 1206 ms and 1208 ms in three
  separate runs), which is the point: the value tracks the wall clock, not the recording.
  `replayRun` fixes the shadow store's clock (`replay.ts:439`), but the
  shadow run appends its own `task.leased` stamped by the replay engine's wall clock
  (`engine.ts:2443`), so the shadow clock is never reached. **§G records the opposite as
  DONE**; that entry is corrected below.
- ~~**`loom replay` builds its engine with no `hooks`**~~ **FIXED 2026-08-25** — a replay now
  runs the same program it recorded. Original finding: builds its engine with no `hooks` (`cli.ts:2534`), so
  `#hooksFor` returns `[]` at all eight points and a replay of a hooked run executes a
  different program than the recording.
- ~~**Hook bodies get the real, unseeded `Math.random()`.**~~ **FIXED 2026-08-25**, and the
  embedder `globals` seam that beat every shadow was closed with it. Original finding: `HOOK_BRIDGE`
  (`hook-loader.ts:53-66`) omits the reseeding that `ARGUMENT_BRIDGE` gives `function`
  bodies, while `hooks.ts:89` claims "No clock and no randomness". The realm control for
  node bodies is real; the extension surface is exempt from it.

### Two things that are silently wrong at run time

- ~~**A static sibling-branch join at the ROOT coordinate double-counts every branch.**~~
  **FIXED 2026-08-25.** Original finding:
  `#immediateReduce` (`engine.ts:4902-4919`) already reduces each branch's writes, then
  `#foldJoin`'s root path (`engine.ts:3184-3205`) folds the same `t.writes` again. Measured:
  three branches produced **six** entries in an `append_ordered` channel; the join's own
  `task.committed` carries `writes:{}` while its `state.reduced` carries 6. Any non-idempotent
  reducer (`append_ordered`, `sum`) double-counts, and the graph compiles `ok`.
  **Scope matters and was checked twice:** a real fan-out → join does NOT double-count —
  `#immediateReduce` holds only at depth (`engine.ts:4911`) — so testing the obvious shape
  will suggest this finding is false. Found by driving a neighbouring shape of the fan-out
  claim in §A, which is §F.5 working exactly as written.
- ~~**Gate payloads are served verbatim.**~~ **FIXED 2026-08-25**, on all six `#summary` routes
  plus the SSE stream and `task.ready.binding.value` — three more leaks than the first fix found.
  Original finding: `http.ts:104` states they "are redacted
  per the GRAPH's declared classification". `redactPayload` is called at `3579`, `3608`,
  `3609` — journal events, channels, outputs — and at neither gate route (`2705`, `2886`).
  A `secret_ref` channel was returned in full over real HTTP.

### The self-improvement metric is inverted

- **PARTLY FIXED 2026-08-25 — a failed run no longer outscores a successful one**, because
  `readSignals` now reads `runStatus`. **The pathology moved rather than closing:** measured on
  the fixed tree, a no-op SUCCESS that delivers nothing scores **0.400** while a real success
  spending the cohort median with no ground-truth signal scores **0.100**. The dominant strategy
  went from "fail immediately" to "succeed immediately without doing anything", because the cost
  and latency terms credit cheapness rather than efficiency. A second fix is in flight.
  Original finding:
  `readSignals` (`score.ts:131`) never reads `t.outcome.runStatus` — the trajectory
  captures it (`trajectory.ts:96`) and nothing consumes it — so a run that fails fast pays
  no cost or latency penalty and still collects `humanEffortSaved = 1`. Separately,
  `trajectory.usage` triple-counts spend (folded at `model.called`, `task.committed` and
  `run.completed`): measured 0.001 on the projection against 0.003 on the trajectory.
  `isGolden` condition 2 is `score >= cohort.p90Score` over exactly these numbers.
  **This inverts §E.3's deferral reason**, which presupposes a correct scorer and a short
  sample. Until the metric is fixed, capture is harmful: every trajectory is a poisoned
  label.

### One window starves two mechanisms

- ~~**`armForeignGates` filters where its two siblings do not.**~~ **FIXED 2026-08-25**, and the
  `armed` map is pruned and pinned. Original finding: `cli.ts:2056` calls
  `listRuns(DEFAULT_RUN_CLOCK_LIMIT)` unfiltered; `gates.ts:2193` and `http.ts:2682` both
  pass `{raisedAGate: true}`. The fix landed twelve hours after the site that missed it.
  Past the window a restarted plane sees an old gate and cannot arm it, so the sweep
  expires it and `onTimeout: "escalate"` behaves as `fail` — a human question journaled as
  timed out with a false reason, no tier ever fired.
- ~~**The same 200-run window starves the oldest run.**~~ **FIXED 2026-08-25.** Original finding: With 201 live runs, `listRuns(200)`
  is `ORDER BY run_id DESC LIMIT ?` (`sqlite.ts:427`/`:432`), so the oldest is never projected,
  never rehydrated and never advanced — it waits for a hand-posted `{"kind":"advance"}`.
  §E.2 defers "deciding which runs a worker considers" as needing a coordinator; that
  decision has in fact already shipped, as a silent starvation policy.

### The service is single-machine

- ~~**`loom serve` binds loopback and there is no `--host`.**~~ **FIXED 2026-08-26** — `--host`
  exists, loopback stays the default, and binding a wider interface is announced at boot.
  Original finding: `http.ts:1696` is
  `listen(port, host = "127.0.0.1")`; `cli.ts:2320` passes no host; `--host 0.0.0.0` is
  refused with `E_CONFIG_INVALID: unknown flag`. So ~1,400 lines of inbound callback
  perimeter — `SignedWebhookChannel.parseCallback`, `timingSafeStringEqual`, the 10-member
  `CALLBACK_REJECTIONS` taxonomy, the unauthenticated `CALLBACK_PATH` — cannot be reached
  by the Slack button they exist for. README:64-68 "run it as a service" is a
  single-machine claim as written.

### Kernel stability has no referent, and nothing observes the growth

- ~~**P1's mechanical test names a set that does not exist in `packages/core`.**~~ **FIXED
  2026-08-25** — `scripts/kernel.json` pins 10 files with a stated criterion and its exclusions,
  and `scripts/check-kernel.mjs` runs in `npm run check`. Possible only because `packages/eagent`,
  which owned the word, was deleted the same day. Original finding:
  `grep -rani kernel packages/core/src/` returns one hit, about the OS kernel; the only
  referent repo-wide assigns "the agent kernel" to `packages/eagent`. By the charitable
  proxy: **28 of the 69 `feat` commits on this branch** touched `run/engine.ts` (25 of the
  most recent 60 — `docs/audit-2026-08-25.md` reports the narrower window), and it went
  1,375 → 6,104 lines in 21 days, never reduced by more than 32 lines in one commit.
  The one running P1 gate measures name-set stability and reported green the day
  `engine.ts` crossed 6,100 lines.

### A routing decision reads the prototype

- ~~**A router `when` expression reaches `Object.prototype`.**~~ **FIXED 2026-08-26**, and it was
  worse than reported: the same prototype read was in the VALIDATOR, where `channels["constructor"]`
  resolved to `Object` and `GRAPH004`'s unknown-channel check silently accepted `constructor`,
  `toString` and `valueOf` as declared channels — the compiler's teeth, bypassable by naming a
  prototype key. Original finding: `graph/expr.ts:481`
  resolves member access as a bare `o[e.prop]`, so `a.constructor`, `a.__proto__` and
  `a.hasOwnProperty` all resolve on any object. `checkExpr("a.constructor != null", …)` is
  `ok` and evaluates `true` for every object, including one with no such data key. A router
  testing field presence on untrusted JSON is reading the prototype, not the data — and a
  router chooses which edge runs.

### Found by the first real workload, 2026-08-25

- ~~**A truncated model turn is written as `""` and the run reports `succeeded`.**~~ **FIXED
  2026-08-26**, and a verifier found the fix reached only half the problem: both shipped adapters
  ended their finish-reason mapper with `default: return "stop"`, laundering every reason this
  build does not know into the one value meaning "finished answer" — so the engine's fail-closed
  arm was unreachable from either adapter. `FinishReason` now carries `` `unknown:${string}` ``
  so the provider's own word reaches the refusal message. Anthropic's documented set already
  contains `pause_turn`, which is not an answer. Original finding: Found by
  running a real review workflow against a live GLM-5.2, not by any test. The provider returned
  `finish_reason: "max_tokens"` with `content: ""`; the journal recorded
  `{"content":"","finishReason":"max_tokens","usage":{"outputTokens":16001}}`, and that empty
  string was written to the node's channel, folded through a `join`, collated, **shown to a human
  at a gate, approved, and written to disk** — with the run reporting `succeeded`. The report read
  `filesReviewed: 3, clean: 2`: one of three contributed nothing and nothing anywhere said so.
  Two of the three turns in the same run finished normally, so this is a per-turn truncation
  treated as a successful empty answer, not an outage. Fix in flight.
- ~~**Nothing warns that `defaultMaxTokens` is too small for the model.**~~ **PARTLY FIXED
  2026-08-27**, and the half that is NOT fixed is named below. The boot banner now says when an
  adapter row stated no `defaultMaxTokens` and therefore inherited
  `DEFAULT_MAX_OUTPUT_TOKENS` (4096) — a number written in four places across the two provider
  files and printed nowhere. It fires on SILENCE and never on a value: nothing in the binary
  knows a route's model or how that model splits output between reasoning and content, so a
  threshold on a ceiling the operator chose would be noise, and `defaultMaxTokens: 1` gets
  nothing. **STILL OPEN: an operator who states a number that is too small is told nothing**,
  before or after — the measured shape of the truncation (`finishReason "max_tokens"` with
  `contentChars 0`, which means the budget never reached content at all rather than that the
  answer was clipped) is available to `turnRefusal` in `run/engine.ts` and is not used to say so.
  Original finding: the operator had to read a SQLite journal to discover it. GLM-5.2 reasons at
  roughly 17:1 against content, so a 4,096 cap never reached content at all; 16,000 still
  truncated one of three.

### Found by driving the evolution loop on a real corpus, 2026-08-26

- ~~**`cohortKeyOf` includes the input digest, so every run on a different input is its own
  cohort of one.**~~ **FIXED 2026-08-26.** The default bucket is now `shape:<digest of
  shapeOf(inputs)>` — structure generalises, values do not, which is the same rule this fold
  already applies to arguments for privacy — and `loom score --bucket shape|exact|fields:a,b`
  makes the seam reachable. Verified on the five REAL GLM-5.2 runs: one cohort, `n = 5`, and the
  remaining blocker is now honest — `n = 5 (need ≥ 30)` is "run it 25 more times", not a
  structural impossibility.

- **`NEW` THE SCORE SATURATES WHEN THE HUMAN ALWAYS SAYS YES, and then it ranks cheapness.**
  Measured on five real runs sharing a cohort: **every one has `outcome: 1`**, so the only
  discrimination left is cost — and `costNormalized` clamps at the cohort median, so the two
  cheapest ranked (0.763, 0.669) and **the other three tied at exactly 0.600, unrankable**.
  `isGolden` condition 2 is "top decile of its cohort", so a saturated outcome makes that read
  "the cheapest decile": a run that does LESS work scores better.

  **The cause, corrected 2026-08-26 after reading the signal list instead of running it.** The
  first version of this entry said `outcomeOf` had only S5 — "the agent said it was done" — to
  read. That is false: `SIGNAL_WEIGHTS.S5` is **0.0**, so S5 contributes nothing, ever, and
  `outcomeOf` divides by present weight. What actually saturated it was **S2, the human gate
  decision** — `DECISION_VALUE.approve = 1` at weight 0.9, and I approved every gate.

  That is the more uncomfortable finding. CLAUDE.md calls a gate decision "the highest-quality
  label the system ever gets", and it is — but an operator approving a report-generating workflow
  approves nearly all of them, so the best label the system collects is also the one most likely
  to be constant. **A workflow whose only signal is human approval cannot rank its own runs.**

- **`NEW` A GROUND-TRUTH SIGNAL EXISTS AND DOMINATES — measured, not argued.** Built a benchmark
  whose answer is known: six small diffs, three carrying a defect this codebase actually had
  (`maxPosture` starting at `out`, `default: return "stop"`, `s.actions.length = 0`) and three
  clean, with a FUNCTION evaluator comparing the review against the planted truth. Run against a
  live GLM-5.2: found all three, missed none, cleared two of three clean diffs, one false alarm.
  The score then read `S1 · value 0 · weight 1.0 · "0/1 assertions passed"` with **S2 and S5
  dominated**, `outcome: 0`, `score: 0.1` — driven by correctness rather than by cheapness. That
  is the saturation broken. `examples/graphs/review-bench.json` ships it.

- ~~**`NEW` A fan-out branch is exactly ONE node deep, so a GRADED ground-truth signal is not
  expressible.**~~ **FALSIFIED 2026-08-27** — it is expressible, and `examples/graphs/review-bench.json`
  now ships the shape: SIX `evaluator` nodes hung off `collate` with `seq` edges, one per case,
  each writing its own channel, folding to `{"id":"S1","value":0.833,"evidence":"5/6 assertions
  passed"}` on a live model. The wall below is real and was correctly described — it is a wall
  around putting an evaluator INSIDE a fan-out branch, and the way past it is to grade AFTER the
  join instead of within it. Original finding: Trying to put a per-case evaluator between the fanned node and its join is
  refused four ways, and the refusals are individually right and jointly a wall:
  `GRAPH021_FANOUT_WITHOUT_JOIN` requires the join to name the FANNED node; `GRAPH008_BRANCH_NOT_CONNECTED`
  requires a direct edge from that node to the join. The only shape that compiles hangs the
  evaluator off the fanned node in parallel, where its output never reaches the join —
  `GRAPH008_JOIN_WRITES_UNPRODUCED` says exactly why: "a barrier folds what its branches produced
  and cannot make anything new."
  Consequence: one evaluator after the join yields ONE bit for the whole run, so a benchmark
  wanting `k/n` needs N evaluator nodes outside the fan-out — which the expansion ceiling then
  bounds. Same family as §A.2's "you cannot fan out from a graph's entry": not a correctness bug,
  a shape a user cannot write.

- **`NEW` An `assertion` evaluator is BINARY by design, and that is a real constraint on
  benchmarks.** The fold keeps only `pass`; a `score` on an assertion verdict is discarded
  (`trajectory.ts`, the `isRubric` branch). Correct for an invariant — a must-pass is not a
  grade — but it means one evaluator yields one bit. A benchmark wanting a GRADED ground-truth
  signal needs one assertion per case, so S1 reads `k/n`. The ladder offers binary ground truth
  (S1) or a graded model opinion (S4, a model judging a model at weight 0.3), and nothing in
  between. **THE WORKAROUND IS THE ANSWER, AND IT SHIPPED 2026-08-27.** The entry above reads as
  a wall and it is a graph edit: `readSignals` computes S1 as (assertion NODES that passed) /
  (assertion nodes), so six evaluator nodes hung off `collate` by `seq` edges give `k/6`. Driven
  on the six shipped cases under the mock: `"0/1 assertions passed"`, outcome 0 became
  `"3/6 assertions passed"`, outcome 0.5. The `score` discard is still real and still costs
  something — the single evaluator's own body had already computed `score: 0.5` and the fold
  threw it away — but it is not what made the benchmark a bit. The GRAPH was.

### Found by driving the promotion half, 2026-08-27

- ~~**A GRADED ground-truth signal is not expressible.**~~ Struck; see the amendment above. Six
  evaluator nodes after the join compile, run, and fold to `k/6`. `maxNodes` had to go 24 -> 32.

- **`NEW` FIXED — `loom score` FOLDED EVERY PEER WITHOUT ITS GRAPH, so the promotion bar was a
  fiction.** `cohortPeers` folded peers with no `graph`, defended by a comment saying "a peer
  contributes usage, policy and status to the medians, and none of those needs the spec".
  `p90Score` is not a median of usage: it is a percentile OF THE SCORES, and a score's largest
  term comes from `extractSignals`, which keys on `nodeTypes.get(step.nodeId)` — a map built from
  the spec. Measured on 30 runs whose members all score 1.000: `p90Score 0.4`. And it changed
  verdicts, which is the part worth keeping: on a cohort where half the runs fail, one of the
  FAILING runs passed `isGolden` condition 2 by tying a bar its failing peers set. Fixed; the
  `graphsByHash` index is now threaded into the peer fold. **The residue:** a peer whose authored
  graph is not published in `graphs/` still folds without one and still scores near 0.

- **`NEW` FIXED — THE PROMOTION GATE FAILED OPEN ON A PROMPT CANDIDATE, which is the only kind
  D6's generator would produce.** `runEvalSuite` serves every model turn by
  `effectKey(taskId, "model", turn)` — `nodeId@branch#iteration` plus a turn number, carrying no
  prompt, no request and no graph hash. Driven on the walking skeleton, all eleven checks, every
  input measured rather than asserted:

      baseline                  passRate 1  cost 0.001125
      metadata only (version 2) passRate 1  cost 0.001125  PROMOTE=true
      agent maxTurns 3 -> 1     passRate 1  cost 0.000435  PROMOTE=true
      agent prompt re-pointed   passRate 1  cost 0.001125  PROMOTE=true
      live model calls made during the whole evaluation: 0

  The crippled candidate was CHEAPER at an equal pass rate, so the gate preferred it.
  `model.called` now carries a `requestDigest` — the `tool.called.argsDigest` precedent, and the
  field `replay.ts`'s own `reboundEffects` docstring had already named as missing — and a case
  whose recorded answer was served to a different call is refused.

- **`NEW` STILL OPEN — TWO CANDIDATE SHAPES THE OFFLINE GATE STILL CANNOT SEE, and a request
  digest cannot answer either.** Lowering `agent.maxTurns` asks the SAME question on the turns it
  does take, so its turn-0 digest matches and the later recorded turns simply go unserved — it
  still promotes, one turn cheaper. Lowering a node's `policy.budget` is invisible for a
  different reason: replay has no adapter, so `estimateOf` returns 0 and the ceiling is never
  tested. Both are policy that replay does not exercise. Naming them because "the gate now sees
  prompt candidates" is easy to over-read.

  **`loom promote --against-cohort` sees both, and that is not the same as closing this.** The
  live mode RUNS the candidate, so a turn it does not take is a turn nobody pays for and a budget
  it lowers is a ceiling a real adapter tests. But it is a different door with a different cost —
  real money, a real provider, and a verdict that carries `checksNotRun: ["8-determinism"]` — so
  the OFFLINE gate is still blind to these two, which is what this entry says. It stays open.

- **`NEW` — JUDGING A CANDIDATE LIVE IS BUILT, AND ITS DECISION RULE IS WEAK AT SMALL n.**
  `loom promote <candidate> --against-cohort <runId> [--runs N]` reads the baseline cohort out of
  the journal, takes the inputs out of `run.submitted.inputs`, runs the candidate on them, and
  decides on a one-sided 95 % lower bound on the PAIRED score differences. `MIN_PAIRED_RUNS` is 6,
  argued from the exact sign test (n = 4 tops out at p = 0.0625, so no result at four pairs can
  clear 0.05). At six pairs the t bound assumes roughly symmetric differences and there is no way
  to check that from six observations. Two things that would strengthen it and are unowned:
  a Wilcoxon signed-rank bound (uses magnitudes AND is distribution-free; needs an exact
  null distribution table, which is a page of numerics under the zero-dependency rule), and
  repeated runs per input so within-input model variance is separable from between-graph
  difference. Both are real work and neither is required for the mechanism to be honest, because
  the verdict journals `n`, `sd` and `signTestP` and a reader can disagree with it.

- **`NEW` STILL OPEN — THE LIVE MODE'S COST CHECK DIVIDES TOTALS, like the replayed one.**
  `3-cost` is `Σcandidate / Σbaseline ≤ 1.1` in both modes, where D10.d says medians. Pairing now
  makes the median EXPRESSIBLE — the CLI computes and journals `medianCostRatio` — and it is
  reported rather than gated, because a pair whose baseline cost $0 makes the ratio undefined and
  a check that sometimes has no answer is worse than one clear rule. Deciding whether the median
  should gate, and what an undefined pair does to it, belongs to whoever owns D10.d.

- ~~**`NEW` `gateCandidate` PROMOTES A CANDIDATE THAT PASSES NOTHING.**~~ **FIXED 2026-08-27**
  by `2a-candidate-earned-it`, an ABSOLUTE floor: a candidate that passed zero cases is refused
  whatever the baseline managed, and `validateSuite` now refuses a suite with no cases at all.
  The question the entry deferred to "whoever owns D10.d" was answered on the merits — every
  other criterion is a ratio, and a tie satisfies all of them, so the relative test could never
  be the thing that catches this. Original finding: `2-non-inferior`
  is a non-inferiority test and returns `pass: true` at "0.0% vs 0.0%"; `validateSuite`'s
  `minMustPass` defaults to 0. Driven through the shipped `loom promote` on the real review-bench
  files under the mock, where both sides fail a ground-truth exam: `✓ 2-non-inferior pass rate
  0.0% vs baseline 0.0% (Δ 0.0pp)` and only `✗ 1-must-pass` refused it. The must-pass floor is
  doing the work a non-inferiority test cannot. Whether the gate should carry an absolute floor
  belongs to whoever owns D10.d — it is a change to a criterion, not to this door.

- ~~**`NEW` THE SUITE IS HAND-AUTHORED, so "promoted over them" is a claim a human makes by
  choosing runIds.**~~ **BUILT 2026-08-27** as `loom suite freeze --cohort <runId> --out
  <suite.json> [--cases N] [--bucket MODE]`. Cases are the cohort members carrying an
  `evolution.scored` row under this key and these weights; `mustPass` IS the journaled `golden`
  verdict; **no flag on the verb names a runId**, so a case that is not a run this workspace
  recorded AND judged cannot be put in the exam. `--cases` is a cap and never a selector — it
  spreads across the score order with both ends included, so neither the goldens-only exam nor
  the floorless one is reachable through it, and an all-golden selection is refused outright.
  `frozenAt` is the write time and the write is `wx`, so a re-frozen exam is refused;
  `generatedBy` is the constant `loom-suite-freeze`, which `--proposed-by` now REFUSES, closing
  the `10-separate-lineage` collision a demo script shipped this session. Driven on 30 recorded
  and scored runs of `close-the-loop.test.ts`'s workflow: 10 goldens, a 30-case suite, and the
  regressing candidate refused by `1-must-pass` over an exam no human wrote —
  `test/cli/suite-freeze.test.ts`.

- **`NEW` THE ENTRY ABOVE'S OWN SECOND HALF WAS WRONG, and that is this lane's finding.**
  "Non-golden becomes the room to win" is not reachable from a production journal.
  `EvalCase.expect` can name a status, a whole channel VALUE, a cost and
  `noIrreversibleWithoutGate` — every one of which describes what already happened — so an
  expectation derived from a recording can only say *keep doing this*. Pinning a non-golden run's
  output would bake the baseline's mistake into the exam and make a candidate that FIXES it score
  WORSE, which `2-non-inferior` would then refuse; `close-the-loop.test.ts` gets its room to win
  from PLANTED ground truth, and a real corpus has none. Measured through the shipped verb: the
  good candidate promotes over the frozen suite at **Δ 0.0pp**, so `2-non-inferior` is what passes
  it and not an improvement. **A suite frozen from a corpus is a REGRESSION FLOOR; the claim that
  a candidate is BETTER is what `promote --against-cohort` measures, live.** What would change
  that is a field in `EvalCase.expect` letting a case name the assertion node's `pass` rather
  than its whole verdict object — `extractSignals`' `firstVerdict` already knows which channel
  that is — and that is a change to the gate's vocabulary, not to this verb. **The residual cost,
  stated:** a golden case pins the channels the recording produced, so a subtly-wrong output that
  a deterministic verifier certified is now a must-pass regression, and a candidate that corrects
  it fails `1-must-pass`. Bounded by `isGolden` condition 1 (`outcome >= 0.8` with an S1/S2/S3
  signal), not eliminated.

- **`NEW` STILL OPEN — A PROMOTION'S SUBJECT IS A GRAPH AND THE STORE IS KEYED BY runId.** The
  decision rides on `operator.command {kind: "evolution.promote"}` appended to the FIRST case's
  run, with `caseRunIds` naming all of them. No kernel edit and no `Kernel-seam:` trailer — which
  was the right trade for a first demonstration and is not an answer to the question. Whether the
  kernel needs a graph-scoped durable fact, and whether that is one event type or a second
  keyspace, is unowned. **The live mode makes the same borrow and is now the SECOND caller**: it
  anchors on the first SELECTED baseline run and names every pair's `baselineRunId`. Never on a
  candidate run — those were produced by a graph no human approved, and hanging the record of a
  judgement inside the thing being judged is a different defect. Two callers borrowing one
  coordinate is the argument for deciding this rather than a reason to.

- **`NEW` STILL OPEN — `run.compiled` CARRIES NODE COUNTS, NOT THE SPEC.** `{graphHash, nodes,
  edges, resolutionManifest}` — so a trajectory's S1/S4/S5 depend on a file on disk, and
  `isGolden` reads a value the journal cannot reconstruct across a restart. That is the first
  non-negotiable, and both the peer-fold fix and `loom score` itself work around it by threading
  a filesystem index into the fold. Same family: `loom score` derives `promotedGraphHashes` from
  `<workspace>/graphs/`, so condition 5 also reads a value the journal does not hold.

### Recorded, and deliberately not sequenced yet

These are confirmed and carried in `docs/audit-2026-08-25.md`, and no roadmap item owns them.
Naming that here rather than letting them sit unowned:

- **`F36` PARTLY CLOSED 2026-08-25.** A node's declared `timeoutMs` now compiles into the realm's
  `vm` timeout, so a SYNCHRONOUS body is terminated at the declared number: a spin went
  2,332 ms/`succeeded` -> 206 ms/`failed`, and `while(true){}` went 30,005 ms/`E_INTERNAL` ->
  206 ms/`E_TASK_TIMEOUT`. `vm`'s timeout covers synchronous execution only, so an ASYNC body is
  now REFUSED rather than silently unbounded. Still open: actually bounding an async body, which
  needs a process boundary. Original finding: Node `timeoutMs` and the vm call timeout are both defeated by a single `await`.**
  Measured: a 36-second body on a 200 ms deadline reporting `succeeded`; with an `await`, still
  spinning at 70 s. Against CLAUDE.md's bar — "watch it, stop it" — this is the sharpest gap
  here, and it belongs in Sequence 2 once that item has a harness to run it in.
- ~~**`F19` A retry erases the human gate decision from the trajectory**~~ **CONFIRMED AND FIXED
  2026-08-26**, on a live engine rather than the hand-built journals that left it unverified.
  Under a `systemFloor: "in"` a `tool` node raises its own gate on its own Task, and a retryable
  tool failure on the attempt AFTER the approval appends `task.retry_scheduled` to that same
  Task: `9 gate.decided`, `15 task.retry_scheduled`, one taskId. The fold read back
  `humanDecisions: []` and a `draft` ceiling for a run a human had approved, while the identical
  non-flaky run read `approve` and `stable`. A retry now drops the failed attempt's model and
  tool calls and keeps the human's answer. Original finding: the highest-value
  label the system collects, deleted by the normalisation rule that claims to preserve strategy
  identity. Belongs to Sequence 5; its verifier could not drive the live engine into the state,
  so it is `unverified`, not confirmed.
- **`F17` PARTLY CLOSED 2026-08-25** — `evolution.scored` is a journal event (row 53, with an
  audit rule that refuses a score claiming a completion the journal denies) and a CLI verb reads
  one. Still open: nothing yet CHANGES a later run because of an earlier one, which needs the
  real runs of Sequence 4. Original finding: Sequence 5's "a verb that reads one" is the fix;
  recorded so the gap has a name.
- ~~**`F41` Gate payloads served verbatim**~~ **FIXED 2026-08-25** — see the entry above; it
  turned out to be four routes, not two.
- ~~**17 source comments cite design documents deleted at `f975f9f`**~~ **FIXED 2026-08-25** —
  every citation now reads `design/loom/NN-NAME.md (deleted at f975f9f)`, so it is self-describing
  rather than dangling. Original finding: 17 comments cited —
  `01-INTERFACES.md`, `02-EXECUTION-GRAPH.md`, `06-EVOLUTION.md` and five more, across
  `validate.ts`, `subprocess.ts`, `gate.ts`, `redact.ts`, `http.ts`, `hooks.ts`,
  `policy.ts`, `delivery.ts`, `resources/hook-loader.ts` and `scripts/check-surface.mjs` — ten
  files, seventeen occurrences.
- ~~**F36'S ASYNC REFUSAL IS IN ONE LOADER OF TWO, and the hole it closed is open one
  directory over.**~~ **FIXED 2026-08-27.** Driven both ways first, because if an async hook
  body merely WORKED then `functions.ts`'s refusal was the thing to question. It works —
  `runFilters` awaits, and the resolved value arrives — and it is harmful twice: at
  `callTimeoutMs: 100` a body spinning after `await 0` returned at 1,949 ms where the same body
  written synchronously was terminated at 103 ms, and the resolved object skips `intoHostRealm`
  (`getPrototypeOf(v) === Object.prototype` was `false` for async, `true` for sync), so a
  vm-context object reached the host. The rule is `realm.ts`'s `ASYNC_RULE` now, beside
  `SHAPE_RULE`, and `ARGUMENT_BRIDGE`'s copy is DELETED rather than joined by a second — both
  loaders emit one sentence, pinned byte-for-byte apart from the kind by
  `test/resources/async-body-refused-at-the-seam.test.ts`. Moving it host-side also widened it:
  the old in-context check read `.constructor.name` alone, which an own `constructor` property
  defeats. **The residual, unchanged:** a SYNCHRONOUS hook body that RETURNS a promise is still
  not refused — `functions.ts` catches that second shape when the body returns and the hook
  loader has no equivalent. Original finding: `resources/functions.ts:302-308` refuses an async
  body at LOAD with
  "an async function body cannot be bounded by any deadline". `resources/hook-loader.ts` has
  **zero** occurrences of the string `async` (`/usr/bin/grep -acn async` → 0). Driven, one
  source, both loaders:

      function: REFUSED -> function resource "function/p@stable" did not evaluate: an async
                function body cannot be bounded by any deadline. The vm …
      hook:     async body LOADED (no refusal)

  and the consequence reproduces exactly as F36 describes it. `async (a, b) => { await 0;
  while (true) {} }` at a hook point, `callTimeoutMs: 200`: the call RETURNS `Promise
  { <pending> }` — the vm timeout never engages, because the vm call itself finished — and the
  process spins until killed. `EXIT=137`.

  This is a drift receipt, not a new class: the rule is stated once per loader instead of once at
  the seam they share, which is the same argument that put the body-shape sentence in
  `resources/realm.ts`. **Its fix is a REFUSAL on config that loads today** — an async hook body
  someone wrote yesterday stops loading — so it wants its own `fix:` commit with this
  reproduction in the body, and it is not something a version pin may grandfather.
- ~~**No `LICENSE` at the repository root.**~~ **FIXED 2026-08-27.** `init`'s MIT file recovered
  verbatim — `git show init:LICENSE`, same sha256 — with its copyright line ("2026 EAgent
  contributors") deliberately left alone, and `"license": "MIT"` added to both manifests.
  DESIGN.md's "Deliberately not sequenced" paragraph had bundled the LICENSE with publishing and
  a stranger-facing install and cited this entry; it keeps its decision about those two and
  drops the LICENSE, which never depended on them.
- ~~**The `tui` removal is an unfinished transaction**~~ **MOOT 2026-08-25** — `packages/eagent`,
  which contained every one of those files, was deleted. Original finding:, all of it inside
  `packages/eagent/` — the ROOT README has no occurrence of "tui" and there is no root
  CHANGELOG, so check the right files. `packages/eagent/README.md:84` still says
  `npm --prefix tui install` (ENOENT), `packages/eagent/CHANGELOG.md:25-31` still calls `tui/`
  the installable product, and several `packages/eagent/src` docstrings still describe it as
  live. The guard misses all of it because it only forbids `src/tui/`.
- **`NEW` FIXED 2026-08-27 — `loom score` REPORTED OUTCOME 0 FOR A RUN WHOSE GRAPH IT COULD NOT
  RESOLVE**, which is indistinguishable from a run that failed every assertion. `extractSignals`
  reads the assertion evaluator nodes out of the SPEC, and `score` resolved a run's spec from the
  workspace's `graphs/`. A candidate graph lives in `candidates/`, so it did not resolve. Driven,
  same run and same command, twice: with the graph absent, `"signals": []`, outcome 0, score
  0.111; with the file copied into `graphs/`, `{"id":"S1","value":1,"evidence":"6/6 assertions
  passed"}`, outcome 1, score 0.700. Every candidate cohort therefore scored near zero until
  somebody noticed, and nothing said why. **The third folded-without-its-graph defect in one
  session** — the other two were `cohortPeers` folding peers without a spec (fixed, a9ee3f4) and
  this one's own cousin in `loom score`'s judged run. Evidence:
  `docs/evolution-loop-2026-08-27.md` §4.

  **THE FIX IS A REFUSAL AT THE VERB AND A MARKER IN THE LIBRARY**, because the two layers can
  say different things. `foldTrajectory` reports `specResolved`; `scoreTrajectory` zeroes outcome
  AND score on a false and carries `components.specResolved` so a reader can tell which of the
  now-three zeroes it is; `isGolden` gains condition 6, which names the graph hash rather than
  leaving condition 1 to say `outcome 0.000` and be read as "this run was bad". `loom score`
  refuses outright — exit 1, no verdict printed, **nothing appended**, since a verdict nobody
  measured must not reach the only authoritative state.

  `--graph <file>` is what makes that refusal actionable: publishing into `graphs/` is also what
  marks a graph promoted, so "copy it into graphs/" is advice that passes golden condition 5 on
  the way in. The flag supplies the spec alone, matched by HASH against `run.submitted`, and the
  peers of the judged run are looked up through it too — a cohort key pins one graphHash, so a
  candidate's peers are runs of those same unpublished bytes.

  **This also closes the residue recorded on the `cohortPeers` entry above**, which said "cohort
  `n` does not move either way". `n` not moving was the damage: `measureCohort` now drops a
  member it could not measure, and on that entry's own 30-member fixture, keeping them gave
  `n 30, p90Score 0.000` with `isGolden` condition 2 passing 30/30 — thirty runs nobody measured
  certifying "cohort large enough" against a bar of zero that all thirty tied. Dropping them
  gives `n 0` and condition 4 refuses. `promote --against-cohort` also excludes them from the
  PAIRING, where an unmeasured baseline scoring 0 handed the candidate that whole score as
  improvement it did not earn.

  **What is NOT covered:** the `! N run(s) folded without their graph` line in `score` is a
  backstop with no end-to-end test — with the judged run refusing and the peers sharing its
  lookup, the only route left to it is a peer that reached the same cohort key through
  `graph.mutated` while its spec is looked up by `run.submitted`'s hash. Stated at the branch.
- **`NEW` `L4-gated-at-least-as-much` HAS NO END-TO-END COVERAGE.** It is the live promotion
  door's enforcement of "oversight only tightens", and this lane's reviewer deleted the whole
  regression-collection block in `promoteAgainstCohort` — both `gatingRegressions.push` loops,
  replaced with `void candGates; void baseGates;` — and `promote-live.test.ts` stayed 8/8 green.
  The unit test exercises the failing branch by injecting a regression string rather than by
  folding two real journals, and the CLI fixture raises no gates, so both clauses pass
  vacuously. A guard nothing would notice the deletion of is not yet a guard.
- **`NEW` NO GRAPH THAT RAISES A BLOCKING GATE CAN BE PROMOTED LIVE, and the refusal blames the
  wrong thing.** `driveToRest` returns as soon as the projection is `running` with no
  `retryAfter`, so a candidate run parked on a human gate comes back NON-TERMINAL, becomes an
  `unmeasured` entry, and `L2-every-input-measured` refuses the promotion — reporting a missing
  measurement where the truth is "this run is waiting for a person". Fail-closed and therefore
  safe, but the operator is told the wrong cause and `review-bench` only avoids it by having no
  gates. Reported by this lane's reviewer FROM CODE, not driven: nobody has yet built the gated
  fixture that would confirm it.
- **`NEW` `suite freeze`'S UNRESOLVED-GATE EXCLUSION IS A GUARD OVER A STATE NOBODY HAS
  CONSTRUCTED.** `noIrreversibleWithoutGate` is now unconditional on every frozen case, and the
  recordings that could not carry it are excluded and counted. But the exclusion never fires in
  any fixture: a run must be `succeeded` AND `delivered` to reach that line, and
  `gateShapeOf` counts a gate as unresolved only when its folded state is neither `decided` nor
  `cancelled`. Measured — mutating the exclusion away leaves `suite-freeze.test.ts` at 9/9, so
  nothing covers it. Two possibilities and they want different answers: the state is unreachable
  for an eligible run, in which case this is dead code and the honest move is to delete it and
  say why; or it is reachable by a path nobody has found, in which case it needs the fixture. A
  `gate.timeout{fail}` leaves a gate `expired` and fails the run, and an `open` gate suspends
  it — both of which are already excluded upstream, which is the argument for "unreachable" and
  is NOT the same as having shown it.

---
## A · Defects and unguarded behaviour

**Re-checked 2026-08-25 — 22 findings, written as prose below.**
The command and its output for every finding are in
[`docs/todo-recheck-2026-08-25.md`](docs/todo-recheck-2026-08-25.md) — search it for the finding's
own text. The anchor that stood here was `#section-h`, which is §H's, and came with the copied
table below.

**§A's items are the bullets below, not a table.** The four-row table that stood here was a
verbatim copy of §H's — same rows `H.1`–`H.4`, same tally, same `#section-h` anchor — so this
section indexed somebody else's work and its header counted somebody else's items. Removed
rather than rebuilt: §A's re-check produced 22 findings and they are written as prose below,
where each carries its own reproduction. A table that restates them would be a second place to
keep in sync, which is how the copy got here.


**The whole product path has now been walked end to end**, on a real graph through `bin/loom`:
author → `compile` → `run` → gate → `gates` → `approve` → `replay` → `audit` → `trace`. What it
established, each checked rather than assumed:

- the gated irreversible write **had not happened** while the run sat at the gate, and did happen
  on approval — the property the whole oversight mechanism exists for;
- `replay` reports `match: true, hermetic: true`, and **does not re-perform the write** — deleting
  the output file and replaying left it absent, so the record is served rather than the effect
  re-run;
- `audit` reports `14 rule(s) checked, 6 skipped` and **names every skipped rule with its reason**,
  rather than counting an unrunnable rule as a pass;
- fan-out → join → serialise → write produces the right bytes, with `${reviews | json}` doing the
  serialising and no helper node.

Two defects came out of the last two steps, which is where they always are. They were fixed
directly and never written down — `9b1efd5` (`trace` printed neither `node.id` nor
`branch.path`) and `1d59621` (a millisecond cannot order Tasks). **The sentence that used to
point at "the `trace` entries below" was born dangling**: the commit that added this preamble
added no such entries. The join `timeoutMs` that used to be named here as the remaining gap is
gone: the field was DELETED (§D.8), so declaring one is `GRAPH020_UNKNOWN_FIELD` rather than a
warning about a field nothing reads.


Each was verified against the code, not remembered.

- ~~**Unknown-field check for a node's TOP-LEVEL fields and for `GraphSpec` itself.**~~ **DONE**,
  and it held the worst member of the declared-inert-and-permissive family: `policyy: {posture:
  "in"}` compiled clean and ran at `out`, so an author asking for the strongest oversight the
  system has got the weakest, silently. `retry`, `timeoutMs`, `checkpoint` were discarded the same
  way, and a misspelled edge `when` made a guarded branch UNCONDITIONAL. `NODE_FIELDS`,
  `SPEC_FIELDS`, `EDGE_FIELDS` now cover all three scopes through one `unknownKeys`; the test
  reads the interfaces out of `spec.ts` so they cannot drift. No fixture broke.

- **Authoring warts, found by writing a real graph through `bin/loom`.** **(2) AND (3) ARE DONE**,
  and (3) turned out not to be a wart at all — see below. **(1) remains:** you cannot fan out from
  a graph's entry — a fan-out edge needs a source node, so every fan-out graph opens with a no-op
  `function` node whose only job is to exist. Not a correctness bug; it costs a user a node.

  **(2) closed** by `${x | json}`. The whole-string form still yields the VALUE, which is what a
  tool taking a structured argument needs; the filter is opt-in. Sized honestly in the commit:
  argument validation already refused the object before `execute` with an accurate message, so
  this removed a required workaround rather than a wrong value reaching a tool.

  **(3) was misread, and the truth was a real defect.** The warning was not noise-but-correct: it
  keyed on `graphBudget !== undefined`, so it fired on graphs that DO declare a ceiling — where
  its message ("the run budget cannot be proven") was false, since `Engine.submit` enforces
  `minDefined(caller, graph, deployment)` — and stayed silent on graphs declaring no budget at
  all, which nothing bounds: `PolicyEngine.reserve` skips its check when `runUsd` is undefined,
  `remainingUsd` returns Infinity, and `loom run` has no default. So the cheapest way to silence
  it was `delete policy.budget`, moving a graph from the bounded shape to the unbounded one.
  Now `GRAPH009_NO_BUDGET` covers the silent case and the old message says what is actually
  unprovable (`GRAPH009_BUDGET_OVERCOMMIT`'s sum). **The lesson worth keeping: "correct but
  noisy" was a conclusion reached by reading the warning, not by testing when it fires.**

- ~~**Confidentiality does not propagate, and a human ceiling erases it entirely.**~~ **HALF DONE.**
  A secret now FLOWS: `applySecretFlow` marks every channel a node writes after observing one that
  is `secret_ref`/`pii` or already carries a secret, folded at commit and rebuilt in
  `#restoreEvidence`. A laundered secret raises the hard floor to `in` exactly as taint does, so a
  human ceiling of `on` no longer erases it. The DECLARED classification stays clampable on
  purpose — it is written in the graph the human de-escalated, so their judgement covered it, and
  a fix that refused that too would make de-escalation impossible for any graph touching a secret.
  **Still open:** the compiler neither refuses nor warns about a laundering hop, so an author gets
  no diagnostic at authoring time; and the `dataFloor` in `validate.ts` still disagrees with
  `compile.ts` (below). Original finding, for the record:
  One `function` node copying a `secret_ref` channel into an `internal` (or unclassified) one drops
  the downstream node's floor from `in` to `on`, no gate is raised, and the plaintext reaches the
  tool — the compiler neither refuses nor warns. Separately, `effectivePosture`'s hard floor is
  `max(ceiling, tainted ? "in" : "on")`, which has terms for irreversibility and taint and **none
  for classification**, so a human ceiling of `on` erases a `secret_ref` floor with no laundering
  needed. The integrity axis has `applyTaint` as a working template; the confidentiality axis has
  no analogue. It must land at BOTH sites — `compile.ts`'s `dataFloor` and the engine's runtime
  `dataClassification` — because that pair has drifted before.
- ~~**`validate.ts` has no unknown-field check.**~~ **DONE.** `GRAPH020_UNKNOWN_FIELD` refuses any
  key a node block does not declare, and suggests the nearest real field. `ALLOWED_FIELDS` sits
  beside `REQUIRED_FIELDS` and is cross-checked against the interfaces it enumerates, because an
  allow-list that falls behind refuses correct graphs — worse than the hole it closed. It caught an
  invalid `humanGate: {prompt}` in a test graph of mine on its first run.
  **Now closed at all four scopes** — see the entry above. **Qualified 2026-08-25:** "all four
  scopes" means the node's top-level fields, `GraphSpec`, node blocks and edges. It does NOT
  reach inside `policy` or `budget`: `policy: {posturr: "out"}` and `budget: {nonsense: 5}` both
  compile `ok`. See §A0 — that hole is the same family this entry closed one level up. The node's own fields turned out to hold
  the worst instance in the family, `policyy` losing a declared `posture: "in"` in silence.
- ~~**The journal amplifies a payload by `2N+2`.**~~ **FIXED for an eligible channel, and the
  eligible set is named.** `EngineOptions.payloads` takes a content-addressed store; a `replace`
  channel whose canonical value is STRICTLY above 64 KiB (`EXTERNALISE_ABOVE_BYTES`) is written to
  it and the journal carries `{digest, bytes}` on `task.committed.external` / `state.reduced.external`
  instead. `foldRun` STAYED PURE AND SYNCHRONOUS — it puts a `PayloadHandle` in the projection and
  records the fact in `RunProjection.external` — and `Engine.#resolveReads` fetches a node's
  `observedChannels` before the body runs, so `view.get()` is still synchronous and still returns a
  plain value. Measured through the binary on a three-node chain moving one 300 KB document:
  `.loom/journal.db` **1.5M → 340K**, plus a 296K `payloads/` holding ONE copy, and
  `loom replay` reports `match: true`. In-process, over the same chain at N = 2…5 nodes:
  3.01x / 5.01x / 7.01x / 9.02x of the payload inline, **flat 1.01–1.02x externalised** — what is
  left is `run.submitted`'s copy of the inputs.
  **What is NOT eligible, and why** (`run/externalise.ts`): any reducer but `replace`, because
  every other one seeds its fold from the channel's current value and would have to materialise the
  handle inside a synchronous reducer; a declared OUTPUT, because nothing resolves
  `run.completed.outputs`; a channel any `when`/`until`/router case names, because `#edgesToTake`
  evaluates against the raw scope and a handle would route the graph silently wrong; a fan-out's
  `over`/`as`; and a `subgraph` node's delegated inputs, which go to a child run with its own
  payload scope. A write HELD FOR A JOIN also stays inline — a join re-folds it synchronously.
  Original finding: Measured: `journal_bytes = payload × (2N + 2)`
  where N is the nodes a value flows through — `task.committed` and `state.reduced` each carry a
  full copy per hop, plus `run.submitted` and `run.completed`. One run, one 16 MiB value, four
  nodes = **160 MiB of SQLite**, fsynced. Nothing caps bytes anywhere: a 256 MiB single event is
  accepted by both stores. The one payload guard is `MAX_DEPTH` and it is byte-blind — 300-deep
  5 KB is refused, 2-deep 64 MiB is accepted. `foldRun` is NOT the problem (0.0 ms over 160 MiB;
  it copies references); the cost is in append and in replay, which re-materialises the whole
  journal at four sites and is strictly linear in bytes.
- **`run.submitted.inputs` is the last inline copy, and it is the largest one left.** Inputs arrive
  before any node has run, so there is nothing yet to point at — but a 300 KB input is still 300 KB
  of journal, and it is now the whole of the 1.01x above. Externalising it needs a store the
  SUBMIT path can reach, which `submit` does not have today.
- ~~**`validate.ts` and `compile.ts` compute `dataFloor` from different sets.**~~ **DONE.** One
  exported `dataFloorOf` now, read by both. The drift was visible in the direction that matters: an
  author declaring `posture: "on"` beside a templated `secret_ref` read ran at `in` and was told
  NOTHING, because the validator computed the floor from `reads` alone and concluded the
  declaration was meaningful.

- **`E_ADMISSION_REJECTED` was deleted, not left unraised.** `POST /runs` admits everything it can
  authenticate. There is no queue, no depth limit, no token bucket.
- ~~**A provider rate limit sleeps holding the worker slot — AND THAT SLEEP IS THE ONLY THING
  MAKING A 429 SURVIVABLE.**~~ **FIXED 2026-08-28, on the third attempt.** What changed is not
  the implementation but the MODEL QUESTION the two failures kept escalating and neither
  answered: *is a provider rate limit a node failure at all?* **No.** The node's work never ran.
  So a 429 is now a DEFERRAL — requeued without charging an attempt, without consulting
  `onlyIf`, and without needing a retry policy to exist — which is what makes the engine's
  requeue a UNIVERSAL rescue and therefore a lossless replacement for the in-slot sleep. The
  two earlier attempts swapped a universal rescue for a conditional one; this one made the
  requeue unconditional first. Everything below is the record of the failures, kept verbatim.

  **What it cost, said plainly.** `task.retry_scheduled` gained `deferred?: boolean` (kernel:
  `journal/events.ts`), the fold gained `TaskRecord.deferredMs`/`deferrals` (kernel:
  `projection.ts`), and `#retryDecision` split into two arms (kernel: `engine.ts`). All three
  are kernel files and this landed as a `fix`, so no seam was spent — the census stays at 8.

  **The bound, because "wait as long as the provider likes" is the same defect reversed.**
  `DEFERRAL_BUDGET_MS` is 900 s of TOTAL deferred time per Task, summed from the journal, after
  which a rate limit becomes an ordinary failure. Folded, not remembered: measured with a new
  `Engine` built on every lap, a process-local counter would have deferred forever.

  **The set is TWO, not one, and the second member was found by measurement rather than
  argued for.** `DEFERRABLE_CODES` = {`E_PROVIDER_RATE_LIMIT`, `E_SUBGRAPH_FAILED`}. With only
  the rate limit deferring, a 429 in a CHILD asking two minutes killed the PARENT — the parent
  burns `DEFAULT_SUBGRAPH_RETRY`'s twenty charged polls on a 250 ms→5 s curve in about 82 s,
  which is precisely the "> ~78 s" row of the table below, reproduced from the other side by
  moving the wait into the child. A parent asking whether its child is done did not fail
  either. Only the RETRYABLE arm of that code can reach the set; the `internal` arm — a child
  that ended failed — is refused one line earlier by `!error.retryable`.

  **What is NOT rescued, and it is the one row that stays red.** A 429 arriving after a
  non-idempotent tool `effect.started` with NO `effect.completed` still refuses both a retry
  and a deferral. The world may already have changed and the journal cannot say; refusing is
  always allowed. `f96a691`'s serve-by-key covers the far more common shape — a tool that
  COMPLETED, then a 429 on the next turn — which is why row 3 of the table below is green.

  **Residues, none of them fixed here.**
  - A deferral still counts toward E4's consecutive-failure streak (`#recordEvidence` runs
    before the retry decision), so a long rate-limit outage escalates a node's posture sooner
    than it used to. Left alone deliberately: not counting it would be LOOSENING oversight.
  - `trajectory.ts` folds `attempts` from `task.retry_scheduled.attempt`, so a deferral no
    longer inflates a trajectory's attempt count. That matches that fold's own stated rule —
    "two runs of one strategy, one of which hit a flaky network, must not look like two
    strategies" — but nobody has checked what it does to scoring.
  - `loom run`'s `MAX_BACKOFF_WAITS` is 64 and a deferral can be up to 60 s, so a wide
    fan-out of rate-limited tasks can still exhaust the CLI's patience. It reports rather than
    hangs, which is why it was left.
  - `E_ADMISSION_REJECTED` was DELETED rather than left unraised (`errors.ts`: "a code arrives with its raiser, in the same change"). This fixes the backpressure half of
    D.4. The admission half was DECIDED 2026-08-28 and will not be built — the code stays
    deleted permanently, and the bound that ships is `--max-runs-in-flight`, which withholds
    rather than refuses.

  Original entry, reframed 2026-08-26 after an attempt to fix the stated defect made
  the product worse, which is the useful outcome.

  The stated half is true: `postJson` loops `maxAttempts` and awaits the backoff INSIDE the call,
  so one rate-limited provider idles a worker slot. But removing that hold fails the run on the
  first 429, because **nothing declares a retry policy anywhere**: `grep -ac '"retry"'` over all
  four shipped example graphs returns 0, `agent()` — the documented one-line surface — compiles
  none, and `graph/compile.ts` supplies no default. `Engine.#retryDecision` returns early on
  `policy === undefined`, so the engine's requeue path — which is complete, journal-backed, and
  correct — has **never once been reached for a rate limit.** The hidden in-slot sleep was
  silently pre-empting it.

  So the fix is two-part and the order matters: **first give provider-calling nodes a retry
  policy that is visible in the compiled artifact, then remove the hidden sleep.** Doing the
  second alone turns a recoverable rate limit into a failed run on the project's headline path.

  **HALF ONE LANDED 2026-08-26.** `NodePlan.retry` carries the effective policy, `loom compile`
  prints it with its source, and an author's declaration is never touched. Measured on the
  shipped graphs: `retry review (default): maxAttempts=3 backoff=exponential initialMs=1000
  maxMs=30000 onlyIf=any-retryable`. A `subgraph` node gets one too, for a reason the engine
  already documented and nobody had wired: `#runSubgraph` returns retryable-`unavailable` for a
  child that is still working and names the parent's policy as what re-enters it — latent while
  no node had a default, and made ordinary by giving agent nodes one. Half two — releasing the
  slot — is next.

  **HALF TWO HAS NOW FAILED TWICE, and the two failures agree on the cause.** Both attempts
  removed the in-slot sleep; both were reverted. Measured before/after on the second, with an
  injected clock, a recoverable 429 in every case:

  | shape | before | after |
  |---|---|---|
  | agent node, no declared retry | succeeded | succeeded |
  | author declared `maxAttempts: 1`, or an `onlyIf` the error misses | succeeded | **failed** |
  | 429 after a NON-IDEMPOTENT tool already ran | succeeded | **failed**, after the side effect |
  | 429 inside a SUBGRAPH, provider asks > ~78 s | succeeded | **failed** |

  **The in-slot sleep is a UNIVERSAL rescue; the engine's requeue is a CONDITIONAL one.** The
  requeue needs a policy, respects `maxAttempts` and `onlyIf`, refuses when a non-idempotent tool
  has started, and composes multiplicatively through a subgraph. Swapping one for the other loses
  coverage everywhere those conditions do not hold — which is why adding defaults (half one) was
  necessary and is not sufficient.

  **The question underneath is a model decision, not an implementation one: is a provider rate
  limit a NODE FAILURE at all?** The node's work never ran. Charging a 429 against the node's
  retry budget, or refusing it because a tool the node already ran was non-idempotent, conflates
  "the provider is busy" with "the work failed". Every row in that table follows from that
  conflation. Escalated rather than answered. **ANSWERED 2026-08-28 — see the head of this
  entry.** Rows 1, 2 and 4 are now green, measured in
  `packages/core/test/run/rate-limit-defers.test.ts`; row 3's non-idempotent case is green when
  the tool COMPLETED and still red when it started and left no completion.

  Worth naming as a defect CLASS rather than an instance: *a complete mechanism with no caller,
  because a lower layer silently pre-empted it.* That is §B's shape hiding under an §A symptom,
  and it is the second time this programme has found one (the other was `LeasedScheduler`).

- ~~**A provider rate limit sleeps holding the worker slot.**~~ **FIXED 2026-08-28** — see the
  entry above for how, what it cost, and what stayed red. Original entry: A 429 is absorbed by a
  retry that waits *inside* the concurrency slot, so one rate-limited provider can idle the whole
  node. This is the most consequential live defect in the list.
- **A cancelled run can be left holding a queued task.** Measured 2026-08-26, and confirmed
  IDENTICAL with and without the change that surfaced it, so it is pre-existing rather than
  introduced: an abort landing between `stopped()` and `#commit` journals
  `8 operator.command | 9 task.cancelled | 10 run.cancelled | 11 effect.failed |
  12 task.retry_scheduled | 13 task.ready` — a Task left in state `ready` inside a run that is
  already terminal. §F.13 states the property this breaks: *a terminal operation is not final
  until every producer of the state it ends is stopped.*

- **No circuit breaker, and there will not be one** (DECIDED 2026-08-28, §D.19). Nothing
  measures a source's health and nothing withholds an unhealthy one; `SourceHealth` appears
  nowhere in the code and is now permanently out of the vocabulary, along with a
  `source.withheld` event, an `E_SOURCE_UNHEALTHY`-shaped code and a shipped `BreakerAdapter`.
  The reason is the first non-negotiable: a breaker's verdict is a per-source failure count
  SPANNING RUNS, and `StateStore.read(runId, fromSeq)` addresses the journal per run, so no fold
  can reconstruct it. What ships instead is the sightline — `providerNotice` in `cli.ts`, one
  latched stderr line on the way down and one on the way back — because the measured problem
  was never the retries, it was that a configured fallback chain degrades SILENTLY.
- ~~**A subgraph's cost ceiling binds nothing.**~~ **WRONG, re-checked 2026-08-25.** There is a
  point at which the cap refuses rather than reports: `engine.ts:3726` computes
  `slice = ctx.policy.remainingUsd * share`, journals it as `subgraph.started.budgetUsd`, and
  passes it to both `#contextFor` (:3764) and `submit({budgetUsd: slice})` (:3770) — so the CHILD
  gets its own `PolicyEngine` bounded by the slice and refuses mid-run. The original claim
  described settlement, which happens after, and concluded nothing bound before.
- **`reads` is not enforced as the read set.** The compile rule covers edge conditions and router
  cases but never tool arguments, so a template can name a channel the node did not declare.
  **Half of this was already false, checked by running:** the STATE VIEW is enforced —
  `viewFor` → `makeStateView` builds a slice from `reads` alone and `get`/`require` refuse anything
  outside it (`E_CHANNEL_UNDECLARED`). What is unenforced is the COMPILE rule, and the runtime
  effect of that is already contained: `observedChannels(node)` — `reads` ∪ every `${channel}` root
  in `tool.args` — is what the taint rule, `dataClassification`, `dataFloorOf`, the gate payload and
  now `#resolveReads` all read, so the templated channel is covered everywhere a decision is made.
  The one read that `observedChannels` still does NOT cover is a `subgraph` node's `inputs`, which
  `#gateBinding`'s `delegated` comment already names; `externalisableChannels` excludes those
  channels rather than relying on it.
- **`reachableToolNames` does not descend into a subgraph**, so a subgraph node is classified
  `read_only` however irreversible its child is.
- **A branch choice made from untrusted content raises nothing.** Bounded twice (a router is
  confined to edges the author declared, and every target re-decides at full strictness), so it is
  a boundary rather than a hole — but it is an unexamined one.
- **Partial reads of untrusted values remain in ~25 files.** A revoked `Proxy` throws on
  `Array.isArray`; three files were swept, the rest were not. There are now three private copies of
  the same guard under three different names.
- **A rare suite flake, four sightings, never reproduced.** The last one was captured: a child
  process's stderr was read as a prefix. The lead is that the test helper waits for a known-last
  line on stdout and for nothing on stderr.

## B · Declared and wired to nothing

**Re-checked 2026-08-25; tallied from the table 2026-08-28 — 11 items: 1 DONE · 4 partial · 6 open.**

| item | verdict | what running it showed |
|---|---|---|
| `B.1` **Compensation edges** — a compile-time rollback proof and | **done, partly** | Was accurate in all three halves; two of them are now closed. Rollback RUNS on run failure and on rewind (`run/compensation.ts` + `Engine.#compensate`), in three journaled states. `#edgesToTake` still skips `compensation` — deliberately, see the body entry — and four narrower gaps are named there. |
| `B.2` **`JoinNode.timeoutMs`** — a barrier waits forever however | **CLOSED 2026-08-28 by deletion** | The field is gone from `JoinNode` and from `ALLOWED_FIELDS.join`; declaring one is `GRAPH020_UNKNOWN_FIELD` and the graph is refused, so no author can write a deadline that binds nothing. `E_JOIN_TIMEOUT` and `GRAPH008_JOIN_TIMEOUT_INERT` went with it, and the unraised-code census reached ZERO — `registries.test.ts` now asserts the empty set instead of pinning a list. The stale comment naming `GRAPH008_JOIN_TIMEOUT_UNSUPPORTED` (a code that never existed) is corrected in both places it appeared. **What this does NOT close, and it is the honest residue:** a node declaring no `timeoutMs` still hangs its task forever, so a join over such a branch still waits forever. That is a default node deadline's job. See §D.8. |
| `B.3` **`Budget.tokens` and `Budget.wallMs`** — declared, never  | done | Both bind, at the run ceiling and the node ceiling (e93f874). `tokens` reserves before the call; `wallMs` is settled-only and stops the call AFTER the ceiling is reached, because a duration has no worst case to debit up front. One gap left, named below. |
| `B.4` **`preAuthorization`** — a whole risk envelope ... is not  | **CLOSED 2026-08-28 by refusal** | TRUE half stands: it is a schema field nowhere in the tree, and now permanently — see the docstring above `interface GraphPolicy`. FALSE half confirmed: "declaring one is silence" stopped holding at 78a8fcc. The re-check's own replacement claim was ALSO wrong: `metadata` stayed silent after those commits and closed only at bd6ef8b. All five authoring scopes are pinned by a test. §D.10. |
| `B.5` **Retention tiering** — proven by test, zero callers, so a | **CLOSED 2026-08-28** | Confirmed, and the enumeration is total: retention.ts exports exactly these 6 value symbols plus types, and none has a caller in src/ outside its own file. **Answered by DELETING the file, its test and its 15 pinned exports** (surface 540 → 525). The mechanism could not do the job its name promised — `archive` pruned nothing from hot, `DEFAULT_RETENTION.cold` was `Infinity`, and the only `TierStore` was an in-process `Map`. See §D.14. |
| `B.6` ~~**The evolution subsystem is now REACHABLE but not wired.**~~ **CLOSED 2026-08-27/28** — every member named below has callers on the `cli.ts` product path behind shipped verbs (`loom score`, `cohort`, `promote` in both modes, `suite freeze`), and the loop was driven end to end against a live provider. See `B.6` and `docs/evolution-loop-2026-08-27.md`. Original reading:~~ | **CLOSED 2026-08-27/28** | Every member the entry named as "still uncalled" now has a caller on the `cli.ts` product path, and the verbs that call them ship: `loom score`, `loom cohort`, `loom promote` (replayed AND `--against-cohort`), `loom suite freeze`. Counted in cli.ts: measureCohort 15, cohortKeyOf 8, isGolden 9, scoreTrajectory 9, promotionCeiling 3, gateCandidate 11, runEvalSuite 6, freezeSuite 3. `readSignals` and `outcomeOf` have ZERO direct callers there and are reached transitively — `score.ts:398` and `:408`, inside `scoreTrajectory` — which is reachability, not a second zombie. Driven end to end against a live provider: `docs/evolution-loop-2026-08-27.md`. |
| `B.7` **Quorum, delegation and trust-tier approvals** — delibera | open | Confirmed, all four shapes. "trust-tier" is ApprovalSpec `mode: "tiered"`. The refusals are at graph/validate.ts:1997-2002 (mode), :2003 (k), :2044-2046 (delegation), and each… |
| `B.8` **The operator intervention surface** — no pause, resume,  | partial | Four of the five named verbs are genuinely absent (pause, resume, steer, kill) and cancel does exist, so that half stands. "redirect" is wrong: a human answering a gate can re… |
| `B.9` **The agent-to-agent mailbox** — designed, unbuilt; the ed | open | Both halves confirmed. `mailbox` is a declared effect kind with no writer, which is the same defect class as B.12's event types but is not covered by either registry there. |
| `B.10` **A worker pool for CPU-bound function bodies** — declared | **CLOSED 2026-08-28 by deletion** | The pool is refused, not deferred, and `FunctionNode.cpuBound` is gone with `GRAPH019_CPUBOUND_NO_EFFECT` and `rule019InertDeclarations`; declaring it is `GRAPH020_UNKNOWN_FIELD`. The measurement stands and is now recorded on `FunctionNode` itself: 1.997x wall for two independent nodes, 5.989x for four on 16 cores — exactly serial. **A body that burns CPU still blocks the loop**, bounded only by the node's `timeoutMs` or `resources/functions.ts`'s `opts.callTimeoutMs ?? 30_000`. Work that genuinely needs a process goes out as a TOOL. See §D.13. |
| `B.11` **`run.cancelled.forced`** — written once as `false`, read | open | All three clauses hold exactly. Checking the word case-insensitively mattered here: the only near-hits in the docs are the substring inside "enforced". |
| `B.12` **Eleven error codes and six event types with no writer**, | partial | Seventeen facts expanded. The event-type half is exactly right — six, members as listed. The error-code half is stale by one: TEN, not eleven, since 069faf4. The bullet was tr… |
| `B.13` **Nine declared-and-unread schema fields** beyond the abov | partial | SECOND HALF EXACTLY RIGHT and enumerable: commit 3fa3d51 "fix(vocab): a docstring that names a consumer it does not have" names precisely these four as "the four core ones ...… |


Mechanism that exists in the schema or the types and executes nowhere. Each is a place a reader
believes a feature is present.

- **Compensation** — ~~a compile-time rollback proof and a rewind refusal exist; execution falls
  through and does nothing.~~ **Rollback now RUNS** (2026-08-28): `run/compensation.ts` plans it
  and `Engine.#compensate` performs it, in reverse-seq order, through `#invokeTool` with
  `nodeApproved: false`, journaled as `compensation.recorded` in three states —
  `compensated` / `failed` / `not_attempted` with a reason. Two triggers are wired: a run failing
  on a node with no handler, and a rewind (which now refuses a DETACHED run rather than hiding
  records of effects it cannot undo — `attach(runId, graph)` first). Idempotence is the journal,
  keyed by the seq of the call being undone.
  **What is still not built**, named rather than implied:
  - `#edgesToTake` still has `case "compensation": break;` and that is deliberate — rollback is
    journal-driven, because an effect needs undoing whether or not an author drew an edge to it,
    and an edge names a NODE while a rollback must name a CALL. A compensation edge remains a
    compile-time declaration. Whether an author should ALSO get a graph-level cleanup node on
    failure is an open design question, not a wiring gap.
  - The other three `run.failed` sites — an unmaterialised fan-out and `E_OUTPUT_MISSING`, which
    are Loom disagreeing with itself, and the budget/fatal floor at the top of `advance`, which
    can fail a run with tasks still leased.
  - Child runs. `#uncompensatedIrreversible` follows `subgraph.started` into them; the planner
    reads one journal.
  - `JoinNode.onBranchError: "compensate"` is still refused at compile
    (`GRAPH008_COMPENSATE_UNIMPLEMENTED`); a branch failing is neither trigger.
  - A DETACHED run whose steps are all blocked journals nothing, because appending the
    `not_attempted` rows goes through a `RunContext` that cannot be rebuilt without the graph.
- ~~**`JoinNode.timeoutMs`** — a barrier waits forever however small a number is written.~~
  **CLOSED 2026-08-28 by DELETING the field**, not by building the deadline. A barrier deadline's
  undecidable case — "is this branch stranded, or legitimately slow?" — has no journaled answer,
  and firing over whatever arrived commits a partial fold under `mode: "all"` that no reader can
  tell from a complete one. Every branch already has an enforced bound at its own locus. The
  "waits forever" hole itself is NOT closed and moved to its own item: a node with no declared
  `timeoutMs` hangs its task, because `#withNodeDeadline` returns straight through.
- ~~**`Budget.tokens` and `Budget.wallMs`** — declared, never read; only cost binds.~~ **Both
  bind** as of e93f874: run and node ceilings, `budget.exhausted` now says which dimension, and
  both fold out of `p.usage` so a restart cannot refund them
  (`test/run/budget-triple.test.ts`). **Two limits are deliberate and stated in the source, not
  oversights:** `wallMs` counts PROVIDER time — a run suspended on a human gate accrues none,
  and neither does an hour spent inside a tool — and it cannot refuse the turn that crosses it,
  only the next one. **One thing is genuinely not built:** a subgraph child inherits its
  parent's DOLLAR slice and neither of the other two ceilings; the child's tokens and provider
  time reach the parent only through `subgraph.completed`, after the child has finished.
- ~~**`preAuthorization`** — a whole risk envelope (cost ceiling, blast radius, tool scope, data
  classification, allowed side effects, audit completeness, demotion triggers) that is not a field
  of the graph schema at all.~~ **CLOSED 2026-08-28 BY REFUSAL, permanently**, in a docstring above
  `interface GraphPolicy` that maps each of the seven parts onto its existing home and says why the
  block is not coming. Two corrections to what stood here: the note "the check does not reach INSIDE
  `policy` or `budget`" was already false when written — it reaches both — and the replacement
  claim that the schema therefore refuses the envelope EVERYWHERE was also false: `metadata` was a
  silent authoring scope until `NESTED_FIELDS.metadata` closed it (bd6ef8b). All five scopes are
  now pinned by a test — root, node, `policy`, `policy.budget`, `metadata`. See §D.10.
- ~~**Retention tiering** — proven by test, zero callers, so a journal never leaves the hot tier and
  grows without bound.~~ **CLOSED 2026-08-28, by deleting the mechanism** (`journal/retention.ts`,
  its test, 15 pinned exports). The first clause was the whole finding: a mechanism proven by only
  its own test. The second is now the recorded position rather than a defect — the journal grows
  monotonically ON PURPOSE, because a terminal run's journal is the corpus `evolution/trajectory.ts`,
  `score` and `cohort` measure over. See §D.14 for the argument and for what would reopen it.
- ~~**The evolution subsystem is now REACHABLE but not wired.**~~ **CLOSED 2026-08-27/28** — every member named below has callers on the `cli.ts` product path behind shipped verbs (`loom score`, `cohort`, `promote` in both modes, `suite freeze`), and the loop was driven end to end against a live provider. See `B.6` and `docs/evolution-loop-2026-08-27.md`. Original reading: `agent().trajectory(runId)` folds a
  run into the shape the scorer reads, so capture has a caller for the first time. Still uncalled:
  cohort measurement, promotion ceilings and baselines — and the generator stays deferred, because
  under roughly thirty scored trajectories per cohort any candidate is fitted to noise.
- **Quorum, delegation and trust-tier approvals** — deliberate compile errors rather than silent
  downgrades. Implementing one means deleting its refusal in the same change.
- **The operator intervention surface** — ~~no pause, resume, steer or kill~~. **Corrected
  2026-08-25:** `cancel` exists, and so do two more that the bullet missed — a human answering a
  gate can **redirect** the run onto chosen outgoing edges, wired end to end, and `rewind` is
  built. **Built 2026-08-28**, at the engine, the CLI and `POST /runs/:id/commands` together:
  - **`pause` / `resume`** — journaled facts, not a flag in a process. `run.suspended{reason:
    "operator"}` and `run.resumed{by:"operator"}` were in the vocabulary with no appender. A
    pause stops the NEXT wave and lets the one in flight commit, survives a restart, and is a
    folded fact of its OWN (`RunProjection.paused`) rather than the `interrupted` status —
    because `gate.decided` ships an unconditional `run.resumed`, so a pause living in the status
    would be lifted by a human answering an unrelated question. `resume` refuses a run that is
    not paused; `pause` refuses one that has ended.
  - **`steer`** — per §D.4, confined to the compiled edge set. Refuses an edge that does not
    leave the named node (checked at the door AND where the edge would be taken), an empty
    route, a run this process holds no graph for, and **a non-human caller** — over HTTP the
    same request is 200 for a person and 403 for a shared bearer token, while that same
    anonymous caller may still `cancel`. Takes effect on the next node DISPATCHED, so the
    workflow is pause → steer → resume.
  - **`kill` was NOT built, and the reason is measured**, not asserted:
    `test/run/cancel-does-not-wait.test.ts`. §D.4 defines it as "`cancel` that does not wait for
    an in-flight effect to settle", and `cancel` does not wait — it returns while a tool body is
    still inside itself, declares the run cancelled at a lower seq than that effect's
    completion, and reports the effect in `unknownEffects` with `clean: false`. There is no
    drain for a second verb to skip, so shipping one would be a second name for `cancel`.
    **`run.cancelled.forced` is left standing for the maintainer**: its own docstring says
    "decided for deletion" and §D.4 assigns it to `kill`, and those cannot both be acted on by
    whoever last read one of them. What was corrected is that docstring's enumeration — it named
    three files carrying the literal and there are seven, nine sites.
- **The agent-to-agent mailbox** — designed, unbuilt; the edge kinds are seven with no eighth.
- **A worker pool for CPU-bound function bodies** — declared on the schema, warns at compile that
  it does nothing; a long body blocks the event loop and every task in the wave with it.
- **`run.cancelled.forced`** — written once as `false`, read by nobody, named by no document.
- ~~**Ten error codes and six event types with no writer**~~ **STALE 2026-08-28** — the excuse lists were cut and the sets shrank: ONE unraised code (`E_JOIN_TIMEOUT`) and FIVE unappended event types. `E_ADMISSION_REJECTED`, named here and three other places as "raised by nothing", no longer exists at all — `errors.ts` deleted it under the rule "a code arrives with its raiser, in the same change". Original reading: **with no writer**, each excused in a registry.
  **Recounted 2026-08-25:** the event-type half is exactly right; the error-code half was stale by
  one — `E_TOOL_SCHEMA_INVALID` gained a raiser in `069faf4` and the count was not updated. Both
  sets are pinned as exact sets with length-checked reasons in `registries.test.ts`.
- **Four constants whose docstrings claimed a consumer they did not have** (now corrected in
  place) — exactly right and enumerable; `3fa3d51` names them.
  ~~**Nine declared-and-unread schema fields** beyond the above~~ — **withdrawn 2026-08-25: the
  count matches no enumerable set.** The graph schema yields five; event payloads yield fifteen
  more. By §F.8's own rule this was a count nobody could check. Re-derive it against a named
  scope or drop it.

## C · Unbuilt observability, which several other items depend on

**Re-checked 2026-08-25; tallied from the table 2026-08-28 — 13 items: 1 DONE · 2 partial · 9 open · 1 stale.**

| item | verdict | what running it showed |
|---|---|---|
| `C.1` **Seven span names are designed and unbuilt** | open | THE COUNT WAS 8 AND IS NOW **7**: `loom.schedule.admit` was struck 2026-08-28 when §D.4 decided admission control will never be built — a count moving DOWN by a decision rather than by a build. The members are recoverable only from git history (design corpus deleted at f975f9f, an ancestor of HEAD; `git show f975f9f^:packages/core/test/docs… |
| `C.1.1` loom.request | open | Registry reason: no journal event covers ingress; first append is run.submitted. |
| `C.1.2` loom.compile | open | Its attributes did not vanish: run.compiled folds graph.nodes/graph.edges/resources.pinned onto loom.run (spans.ts:426). |
| `C.1.3` loom.schedule.admit | ~~open~~ **STRUCK** | §D.4 decided 2026-08-28 that admission control will never be built, so there is no decision for this span to name. It is out of the vocabulary permanently, and it is why the C.1 count is 7. |
| `C.1.4` loom.schedule.pick | open | This is the one the deleted 05 doc flagged as marked in two documents but absent from its own inventory table; it is nonetheless a genuine ninth-name gap and is correctly insi… |
| `C.1.5` loom.context.assemble | open | run/context.ts assembles but journals nothing, so the fold has no input. |
| `C.1.6` loom.effect | open | A naive `grep -c loom.effect` returns nonzero and would wrongly read as built. Every effect folds into loom.model or loom.tool at spans.ts:712 — including `kind: "subgraph"`, … |
| `C.1.7` loom.scheduler.tick | open | There is no tick loop to instrument, so this is a design gap, not a wiring gap. |
| `C.1.8` loom.replay | open | Distinct from `loom.replayed`, which the deleted registry classes as an attribute — see C.2. A replay run journals like any other, so a trace cannot tell a replayed run from a… |
| `C.2` roughly fifteen documented span attributes are never set b | partial | THE COUNT IS WRONG UNDER EVERY SCOPING, and the direction depends on scope. The 11 truly-never-set on built spans: budget.cost_usd, trigger.kind (loom.run); node.type (loom.ta… |
| `C.3` **Two documented reversal conditions are percentiles over  | stale | The two conditions are real and were identifiable — DL-1 at design/loom/08-PLAN.md:178 ("measure `loom.scheduler.tick` p99") and D12.8 at design/loom/07-CONFIG-DEPLOY.md:394 —… |
| `C.4` **A trace cannot follow a subgraph.** The journal records  | **DONE** | Both halves confirmed exactly as written. The journal side is real — journal/events.ts:620-631 declares `subgraph.started`/`subgraph.completed`, each with `readonly childRunId… **BUILT 2026-08-28.** `spansFrom` mints the link: `subgraph.started` opens the effect span (so it is the CHILD's width, not the zero-width batch `effect.started`/`effect.completed` are appended in) carrying `subgraph.child_run_id`, `.ref`, `.graph_hash`, `.budget_usd`, plus a `SpanLink` to `spanId(childRunId, "run")` with the child's `traceId` — all derivable, no I/O. `subgraph.completed` closes it with the child's own status, usage and output COUNT. The three child shapes render truthfully: succeeded (`ok`), failed (`error` + `subgraph.status: "unreported"`, closed at the parent's `task.committed` because every non-success exit of `#runSubgraph` returns before the completion batch), still running (`unset`). |
| `C.5` **No scheduler-tick telemetry**, so queue behaviour is unm | partial | FIRST HALF STILL-OPEN, SECOND HALF WRONG. No scheduler-tick telemetry: confirmed — `loom.scheduler.tick` is emitted nowhere and run/scheduler.ts contains no tick loop to instr… |


- ~~**Eight span names are designed and unbuilt**~~ → **SEVEN**, 2026-08-28: `loom.schedule.admit`
  was struck when §D.4 decided admission control will never be built, so the span has no
  decision left to name. A count moving DOWN by a decision rather than by a build.
  ~~roughly fifteen
  documented span attributes~~ → **eleven**, recounted 2026-08-25 and enumerated:
  `budget.cost_usd`, `trigger.kind`, `node.type`, `capability`, `gen_ai.request.max_tokens`,
  `loom.replayed` (two spans), `tool.attempt`, `tool.source`, `reducers`, `gate.posture`,
  `gate.batched`. Two the old count included (`state.hash.before`/`after`) ARE set — on
  `loom.state.reduce`, not on the span the source table blamed.
- ~~**Two documented reversal conditions are percentiles over spans nobody emits**, so each
  currently reads as a check that passed.~~ **STALE 2026-08-25.** Both conditions lived in
  `design/loom/08-PLAN.md` and `07-CONFIG-DEPLOY.md`, deleted at `f975f9f`. The underlying gap is
  real — `loom.scheduler.tick` is still emitted nowhere — but there is no longer a document in
  which either condition reads as a passing check.
- ~~**A trace cannot follow a subgraph.** The journal records the child run id; no span is built
  from it, so a parent trace offers no route to its child.~~ **BUILT 2026-08-28.** The fold links
  (`subgraph.child_run_id` + a `SpanLink` carrying the child's `traceId`) and `spliceSubgraph`
  joins two folds into one tree; `loom trace` follows it. See C.4 and D.12.
- **No scheduler-tick telemetry.** `loom.scheduler.tick` is emitted nowhere and `run/scheduler.ts`
  has no tick loop to instrument. ~~so queue behaviour is unmeasurable.~~ **Corrected 2026-08-25:**
  per-task queue wait already IS measurable — `task.ready` and `task.leased` are journaled for
  every task and `spans.ts:677` attaches `task.leased` as a span event, so the p99 is a fold over
  what is already emitted. What is missing is scheduler-level behaviour, not queue behaviour.

**This block gates the UI direction.** A richer operator surface over a plane that is not emitting
is a better view of nothing.

## D · Decisions that were blocked on the maintainer

**Four more answered 2026-08-26**, unblocking nine §B entries that were decisions in disguise:

4. **The operator intervention surface — build the FULL set: pause, resume, steer, kill.**
   Not the minimal pause/resume I recommended. Two sub-decisions fall out and are mine to make
   and record, because they were not asked:
   - **`steer`** means an operator redirects a running graph onto edges the author declared.
     It must NOT let an operator reach an edge the compiled graph does not contain — that is
     `graph:mutate`, which is a capability the tenant either holds or does not, and routing
     around it from the operator surface would be oversight loosening itself. So: steer is
     confined to the compiled edge set, exactly as a `router` is.
   - **`kill`** is `cancel` that does not wait for an in-flight effect to settle.
     `run.cancelled.forced` — written once as `false` and read by nobody — is the field that was
     left behind when somebody thought about this before, and it becomes its record.
5. **A compensation edge fires on run failure AND on rewind.** Not run failure alone. The sharp
   edge I flagged is now deliberate: **an operator inspecting history can trigger real-world
   undo**, so rewind-compensation must be loud, gated by the same oversight floor an irreversible
   action gets, and never silent.
6. **`Budget.tokens` and `Budget.wallMs` bind, like cost.** The ceiling machinery already exists;
   these fields simply never reached it. A token ceiling is the one an operator can reason about
   when prices are unknown — the case hit for real against a GLM endpoint, where placeholder
   prices had to be invented before the cost budget meant anything.
7. ~~**Payload externalisation gets built, as HANDLES IN THE PROJECTION**~~ — **BUILT 2026-08-28,
   in the decided shape.** `journal/payloads.ts` (the store and the threshold),
   `run/externalise.ts` (which channels are eligible, and why each exclusion exists),
   `RunProjection.external` (the fold's record of which channels are handles — a FIELD, never a
   shape sniff, or a node that writes `{$payload:…}` could name a payload it never produced), and
   `Engine.#resolveReads` / `#externalise`. `foldRun` is unchanged in kind: still pure, still
   synchronous. Evidence in `test/run/payload-externalisation.test.ts` and in the §A entry above.
   The prerequisite turned out to be half-true already — see the corrected §A bullet. Two things
   the decision assumed and the build did not do: `task.committed` and `state.reduced` did NOT each
   need a digest FIELD of their own, they needed a per-channel `external` MAP (a digest alone
   cannot say WHICH channel left); and `run.submitted.inputs` is still inline. Retention tiering
   was unblocked by this and then ANSWERED, 2026-08-28, by deleting it — see §D.14.
   Original text: decided 2026-08-26,
   and the fork was not about effort. Above a threshold a payload leaves the journal and leaves a
   `{ref, digest}`; **`foldRun` stays pure and synchronous**, and the engine resolves exactly the
   channels a node DECLARED it reads before invoking the body, so `view.get()` stays synchronous
   and a body still sees a plain value.

   **Why not an async fold**, which is the simpler mental model: `scripts/kernel.json` pins
   `run/projection.ts` *because* "it is pure and synchronous so the claim can be checked". An
   async `foldRun` trades away the stated reason it is kernel, and makes `engine`, `gates` and
   `replay` async at every projection read. The hook for the chosen shape already exists —
   `viewFor(p, channels, branch, node.reads ?? [])` is already how all three body-invoking sites
   build a view.

   **THIS REORDERS THE BACKLOG.** "`reads` is not enforced as the read set" (§A) stops being
   tidiness and becomes a **prerequisite**: under handles, a channel a node did not declare is
   one the engine cannot resolve, so an undeclared read goes from untidy to unresolvable. Build
   the enforcement first.

   `effect.completed` already carries a `resultDigest`, so an externalised effect keeps its
   identity for free; `task.committed` and `state.reduced` each need one.
   ~~**Retention tiering is downstream of this and stays deferred until it lands.**~~ It landed,
   and retention tiering was then ANSWERED BY DELETION rather than built — §D.14.


**Three were answered 2026-08-25**, and the roadmap in `DESIGN.md` is built on them:

1. **The first real workflow to port (D.1) — decided in principle: the next user is the
   maintainer, porting one real workflow.** Not a stranger who finds the repo. This is now the
   ordering constraint for everything after it, and it demotes distribution (LICENSE,
   publishing, stranger-facing examples) below the line for now. **Which workflow is still
   open** — that half of D.1 stands.
2. **The self-improvement subsystem — close the loop, do not freeze it.** With a hard ordering
   inside: fix the metric before accumulating any corpus, because the metric currently prefers
   failure and every trajectory captured under it is a poisoned label. See §A0.
3. **`packages/eagent` — cut to tag `eagent-v1` and delete.** Nothing in this file decided its
   fate before today, which the audit flagged. Deleting it also frees the word "kernel" to mean
   `packages/core`, which is what makes the P1 guard possible at all.

**Re-checked 2026-08-25 — 22 items: 3 DONE · 4 partial · 15 open.**

| item | verdict | what running it showed |
|---|---|---|
| `D.0` Twenty-one, escalated 2026-08-24. Two are now answered | **DONE** | THE COUNT IS RIGHT, which is worth saying because the section never enumerates it. Expanded members of the run-on, in order, become D.6–D.19 below; the two answered become D.2… |
| `D.1` **The first real workflow to port.** Nobody has yet used t | **DONE** | (i) DECISION: ANSWERED BY DEMONSTRATION 2026-08-27/28 — two workflows are ported, shipped in `examples/graphs/` and DRIVEN against a live GLM-5.2: `self-review` (the one that needs a real model) and `review-bench` (33 live runs, one cohort key, $1.59 all in). The whole record is `docs/evolution-loop-2026-08-27.md`. The observable below is what made the question worth asking and is now false. Original reading. (ii) OBSERVABLE: the only run that ever reached durable storage is a one-node graph named "g" with empty inputs that FAILED before running a body; no graph… |
| `D.2` **The real numbers** — tenants, concurrent runs, runs/day, | open | (i) DECISION: OPEN. (ii) OBSERVABLE: the word 'tenants' has no referent in the running system — `TenantId` is declared and used nowhere, and no tenant column reaches the sqlit… |
| `D.3` **When a compensation edge fires** — on task failure, on r | **DONE** | (i) DECISION: ANSWERED by the maintainer this session, then BUILT. The OPEN reading below is kept verbatim because it is what the code looked like when the question was put, and the answer only means something against it — today the answer is 'never, on any of the three'. (ii) OBSERVABLE: a live engine run whose tool node throws leaves the compensation target with no Task at… **ANSWERED + BUILT 2026-08-28.** The maintainer's answer was ON RUN FAILURE AND ON REWIND, and both now run: `planCompensation` walks the journal in descending seq and `#compensate` dispatches each undo through `#invokeTool` under the `compensate` effect kind, with three journaled states (compensated / failed / not attempted) rather than two. Two defects found on the way in and fixed: a rewind that hid the record while leaving the effect standing, and a resumed rollback that undid its own undos. |
| `D.4` **Rate-limit backpressure and admission control** — see A. | **DONE** | (i) DECISION: the BACKPRESSURE half is ANSWERED and BUILT 2026-08-28; ADMISSION CONTROL is ANSWERED 2026-08-28 as WILL NOT BUILD — `E_ADMISSION_REJECTED` stays deleted permanently, because under one tenant the right answer to "too much work" is to make it wait and never to say no. What was measured and closed instead: 60 submissions driven the way `POST /runs` drives them produced **60 concurrent provider calls**, and `openWorkspace` built its Engine with `policy: { granted }` and no budget, so the deployment half of `minDefined` was always undefined. Five flags now ship — `--max-runs-in-flight` (default 4), `--max-parallelism` (default 16), `--budget-usd`, `--budget-tokens`, `--budget-wall-ms` — each refusing to boot on a malformed value, with the arithmetic printed at boot. `--max-runs-in-flight` is a CEILING: the surplus waits and the run clock's widened `due` predicate re-derives it from the journal. (ii) OBSERVABLE — DOES A 429 SLEEP INSIDE THE WORKER SLOT? **No longer.** It did: measured through an engine at `e4e4f01`, six 8-second holds inside one leased Task while the journal read `… task.leased policy.decided effect.started` — leased, uncommitted, nothing to reschedule against. `postJson` now reports a 429 instead of holding it and the engine schedules a DEFERRAL that charges no attempt. See §A for the model decision, the bound, and the one row that stays red. |
| `D.5` **The identity and permission source of truth** for approv | open | (i) DECISION: OPEN. (ii) OBSERVABLE: an approvers list naming a group or a role compiles clean and can never be satisfied, because the runtime check is exact string equality —… |
| `D.6` which approval callback is mandatory | open | (i) DECISION: OPEN. (ii) OBSERVABLE: of the three DeliveryChannels that ship, exactly one can be answered. `channel.parseCallback !== undefined` IS the answerability test (del… |
| `D.7` providers required at launch | partial | (i) DECISION: half ANSWERED IN CODE, half OPEN. The launch set is closed and ENFORCED at boot — `PROVIDERS` (cli.ts:815) is exactly {anthropic, openai}, and OpenAIAdapter with… |
| `D.8` what a join timeout does | **ANSWERED 2026-08-28 — NOTHING, and the field is gone** | The runtime half is answered by refusing the question: `JoinNode.timeoutMs` deleted from `graph/spec.ts` (kernel #3) and from `ALLOWED_FIELDS.join`, `GRAPH008_JOIN_TIMEOUT_INERT` deleted from `validate.ts`, `E_JOIN_TIMEOUT` deleted from `errors.ts`, and `registries.test.ts`'s `NEVER_RAISED` list deleted with its one member — the declared-and-unraised census is zero and is now asserted as the empty set. Declaring a barrier deadline is `GRAPH020_UNKNOWN_FIELD`: strictly tighter than the warning it replaces. The false claim in README.md that `DESIGN.md` records a decision here went too — measured, `grep -aic timeout DESIGN.md` and `grep -aic deadline DESIGN.md` are both 0 across 575 lines. Residue, stated rather than implied: deleting the field does not stop a run waiting forever, because a node with no `timeoutMs` hangs its task. |
| `D.9` whether a function body's output becomes a journaled effec | open | (i) DECISION: OPEN — today it does NOT. (ii) OBSERVABLE, and it is the sharpest one in this section: a replay that reports `hermetic: true` re-executed the function body LIVE.… |
| `D.10` the `preAuthorization` envelope | **ANSWERED 2026-08-28 — REFUSED PERMANENTLY** | Not built, and not deferred: a docstring above `interface GraphPolicy` maps all seven parts onto their existing homes (`policy.budget` for the cost ceiling, `IrreversibilityClass` + `CLASS_DEFAULT_POSTURE` for blast radius, `policy.capabilities` for tool scope, `Classification` + `dataFloorOf` for data classification, `FunctionNode.effects` for side effects), marks "audit completeness" ABSENT and "demotion triggers" FORBIDDEN, and states the reason: a bundle is a SECOND spelling for facts one place already states — the `dataFloorOf` drift at one-fifth the scale — and `preAuthorization` is a loosening verb, a graph pre-approving its own out-of-the-loop execution. A demotion trigger is an automated posture LOWERING, which `PolicyEngine.escalate` (returns without firing when `maxPosture(from,to) === from`) and the audit rule `policy.deescalation-is-human` exist to make impossible. The mechanical half needed no new code: `NESTED_FIELDS.metadata` (bd6ef8b) had already closed the last silent scope. A test pins the refusal at all five — root, node, `policy`, `policy.budget`, `metadata` — plus the control that `labels` still accepts arbitrary keys. |
| `D.11` token and wall-clock budgets | **DONE** | (i) DECISION: ANSWERED by the maintainer this session, then BUILT. The OPEN reading below is kept verbatim because it is what the code looked like when the question was put, and the answer only means something against it. (ii) OBSERVABLE: the flagship shipped workflow declares a 400k-token and 5-minute ceiling and compiles with ZERO diagnostics — neither binds anything, and … **ANSWERED + BUILT 2026-08-28.** Both bind, at the run ceiling and the node ceiling, through the machinery `costUsd` already used. Two judgements are recorded at the code rather than here: `tokens` is `inputTokens + outputTokens` (a wider sum double-counts cache fields and reasoning tokens), and `wallMs` is PROVIDER time, not elapsed time — so a night suspended on a human gate accrues nothing, proven by a test that moves the clock a full day under a 10,000 ms ceiling. Known limit: `wallMs` is settled-only, so it cannot refuse the call that crosses the ceiling, only the next one. |
| `D.12` the subgraph span | **DONE** | (i) DECISION: OPEN. (ii) OBSERVABLE: `loom trace <runId>` can print a parent run's tree and has no route into the child's, because the span builder never mentions subgraphs — … **ANSWERED + BUILT 2026-08-28. The answer is TWO ON THE WIRE, ONE ON THE SCREEN.** `spansFrom` stays a pure fold over one journal and can therefore only LINK; `spliceSubgraph` (pure) joins two folds into one tree and `loom trace` does the journal reads between them, breadth-first, cycle-guarded, bounded at `MAX_TRACED_SUBGRAPHS`. Splicing in the fold was refused for two reasons: it needs a store, which falsifies this file's opening claim, and it rewrites the child's `traceId` and parents a span on another run's journal — right in a renderer, wrong in an exporter, where the two runs are two traces a collector joins by the link. `reconstructGraph` was a casualty and is fixed: `graphHash` was LAST-WRITE-WINS over `loom.run` spans, so a spliced trace certified against whichever run sorted last; it now answers `(multiple)` and `conformsToGraph` refuses. `loom trace` computes conformance over the parent's own fold. |
| `D.13` a CPU worker pool | **ANSWERED 2026-08-28 — NO POOL, and the field is gone** | `FunctionNode.cpuBound` deleted from `graph/spec.ts` (kernel #3) and from `ALLOWED_FIELDS.function`; `rule019InertDeclarations`, its 20-line docstring, its call site and `GRAPH019_CPUBOUND_NO_EFFECT` deleted from `validate.ts`. Declaring it is now `GRAPH020_UNKNOWN_FIELD`. **The reason the pool is refused rather than scheduled:** a `function` body is RE-EXECUTED on replay while a tool result is SERVED from the journal, so out-of-process work as a TOOL needs no second copy of the determinism vocabulary and a worker pool does — Date/Intl/Math.random/`ctx.now` would live in two places, permanently doubling the surface on which invariant 4 can silently break. **Reopen only on** a measured workflow where a body's compute, not model latency, is the run's cost centre AND the body cannot be a tool over `proc.exec` — and the reopening is then "design one determinism boundary with two hosts", a kernel seam, not "add a pool". Honest cost: the author loses a message that taught ("the body runs on the main thread and blocks it") and gets a list of two field names; the route out is in `FunctionNode`'s docstring. |
| `D.14` retention tiering | **DONE** | (i) DECISION: OPEN. (ii) OBSERVABLE: `TierManager`, `MemoryTierStore` and `tierFor` are exercised only by the test that proves them. Nothing in the engine, the CLI or the cont… **ANSWERED 2026-08-28, by deletion.** `journal/retention.ts` (500 lines), its test (433 lines, 26 tests) and its 15 pinned exports are gone; surface 540 → 525. **The argument is on property 3, not on storage:** a terminal run's journal IS the corpus `evolution/trajectory.ts`, `score` and `cohort` measure over, so it is the evidence "a later run is measurably better because of an earlier one" rests on. Any prune's undecidable case is "will anyone replay or score this run?", which no journaled fact answers — so the fail-closed answer is KEEP, and a `--before <t>` sweep answering the easier question "is the run terminal?" is not the same thing. Three supporting facts: the mechanism could not do the job its name promised (`archive` pruned nothing from hot, `DEFAULT_RETENTION.cold` was `Infinity`, the only `TierStore` was an in-process `Map`, so wiring it in would have DOUBLED a completed run's footprint into RAM and freed zero bytes); it was a second audit vocabulary beside the live `journal/audit.ts`, with no writer at all; and `TierStore` was not an extension seam, because an interface nothing calls cannot be extended by anybody — which is why it must NOT join README's list of six, that list naming capabilities the binary REFUSES. Only then the number, which is a fact and not the argument: one real 8-node run measures 62 events and 94,834 payload bytes, so tens of runs a day is single-digit MB/day. `E_AUDIT_IMMUTABLE` went in the same commit — the WORM `MemoryTierStore` was its only raiser, and `registries.test.ts` caught it. **Reopen on a MEASURED fact, not a calendar:** (1) the journal gets large enough that `loom trace` or `loom audit` is slow, or an operator reports a real cost; (2) `score`/`cohort` grow a durable summary that supersedes the raw journal, making the runs behind it deletable; (3) D.2 changes — a second tenant, a hosted plane, or an erasure mandate (GDPR-out-of-scope was a recorded operator statement, not a property of the software). If it reopens, **do not rebuild tiering as written**: `TierManager.restore` had zero callers, so archiving to cold while pruning hot would make a run UNFOLDABLE — the `foldRun` read-path fallback from hot to cold must land BEFORE any tiering. The narrower build to revisit first is `loom prune --run <id> --yes` for ONE named run, not `--before <date>` for a range: one run an operator points at is a decision the operator made, not one a sweep guessed. |
| `D.15` quorum and delegation | open | (i) DECISION: OPEN, and deliberately refused rather than silently downgraded. (ii) OBSERVABLE: a graph asking for two approvers fails to compile, so the decision has a price a… |
| `D.16` `run.cancelled.forced` | **DONE** | (i) DECISION: ANSWERED by the maintainer this session, then BUILT. The OPEN reading below is kept verbatim because it is what the code looked like when the question was put, and the answer only means something against it. (ii) OBSERVABLE: the field is written by exactly one site as a constant `false` and read by nothing — so `run.cancelled` carries a boolean that has never o… **ANSWERED 2026-08-28, by deletion.** The field is gone. Its own docstring said the removal cost three files; it was seven files and nine sites, which is why it kept being deferred. The operator lane separately established that §D.4's definition of `kill` — 'cancel that does not wait' — is FALSIFIED, because `cancel` does not wait: measured in `test/run/cancel-does-not-wait.test.ts`. So the field was not held open for a verb that cannot exist as specified. |
| `D.17` the operator surface | **DONE** | (i) DECISION: ANSWERED by the maintainer this session, then BUILT. The OPEN reading below is kept verbatim because it is what the code looked like when the question was put, and the answer only means something against it. (ii) OBSERVABLE: the whole operator vocabulary over HTTP is three verbs — cancel, rewind, advance (http.ts:2780-2797) — and five of the words §B names are … **ANSWERED + PARTLY BUILT 2026-08-28.** The maintainer's answer was the full set. `pause` and `resume` ship as journaled facts that survive a restart (`RunProjection.paused`, deliberately separate from `status` so a `gate.decided`'s unconditional `run.resumed` cannot undo an operator's stop), and `steer` ships confined to the compiled edge set. `kill` was NOT built and the reason is measured, not a shortfall: it was specified as 'cancel that does not wait' and `cancel` does not wait, so it would have been a synonym. A steer aimed at a `human_gate` is now REFUSED — it was accepted, journaled and never read, because a gate resumes through `resolveGate` and `#dispatchNode` never sees it. |
| `D.18` the mailbox | open | (i) DECISION: OPEN. (ii) OBSERVABLE: `mailbox` is a legal value of `effect.started.kind` that nothing can ever produce — so a reader of events.ts believes agent-to-agent messa… |
| `D.19` the circuit breaker | **DECIDED — REFUSED** | (i) DECISION: ANSWERED 2026-08-28. No breaker: no `SourceHealth`, no `source.withheld`, no `E_SOURCE_UNHEALTHY`, no `BreakerAdapter`. (ii) THE OLD OBSERVABLE WAS FALSE. "retried at full rate" is not what happens: a dead provider costs 3 engine attempts x 3 `postJson` attempts = **9 requests and ~2.25 s of held slot**, and then the run FAILS naming `E_PROVIDER_OVERLOADED`. (iii) WHAT IS TRUE, and it is the thing no row named: `FallbackAdapter` is stateless, so a configured chain with a dead primary pays **three wasted requests and ~750 ms of a worker slot on EVERY model turn, forever**, while every run succeeds — and `FallbackOptions.onFallback` was declared, tested and wired by nobody, so it happened in silence. (iv) BUILT: the callback is wired at the `new FallbackAdapter(…)` construction and `providerNotice` latches one stderr line down and one up. It DECIDES NOTHING — `test/cli/provider-notice.test.ts` asserts all eleven calls still reach the provider. (v) WHY REFUSED: a breaker reads a per-source count spanning runs and the journal is addressed per run, recorded in `journal/store.ts`'s header. Reopens only if an extension author names a hook they cannot write, if `StateStore` grows a cross-run read, if D.2 becomes more than one process, or if a provider bills for 5xx. |
| `D.20` Two are now answered — the UI is the web console | **DONE** | (i) DECISION: ANSWERED, and the answer is load-bearing rather than declarative. (ii) OBSERVABLE: an unauthenticated GET / on a live control plane serves 25 KB of console HTML … |
| `D.21` and the terminal client is deleted | **DONE** | (i) DECISION: ANSWERED, by deletion, with a commit that says why. (ii) OBSERVABLE: no TUI source, no ink dependency and no release script remain; the four TUI design documents… |


Twenty-one, escalated 2026-08-24. Two are now answered — the UI is the web console, and the
terminal client is deleted. The rest stand, and the redesign may dissolve several of them rather
than answering them. **The five that change what gets built:**

1. **The first real workflow to port.** Nobody has yet used this system for something they actually
   needed. Every clause of the stated bar is verified by running; that is not the same evidence.
2. **The real numbers** — tenants, concurrent runs, runs/day, fan-out width. Several deferrals rest
   on the assumption that single-node is enough.
3. **When a compensation edge fires** — on task failure, on run failure, or on rewind.
4. **Rate-limit backpressure and admission control** — see A. The first half is a live bug.
5. **The identity and permission source of truth** for approvers.

The rest: which approval callback is mandatory · providers required at launch ·
whether a function body's output becomes a journaled effect · token and wall-clock budgets ·
the subgraph span · quorum and delegation · `run.cancelled.forced` · the operator surface ·
the mailbox · the circuit breaker. (Retention tiering came off this list 2026-08-28 — §D.14; so
did what a join timeout does (§D.8, answered by deleting the field), a CPU worker pool (§D.13,
answered by deleting the field), and the `preAuthorization` envelope (§D.10, answered by refusing
it permanently).)

## E · Deferred on purpose, with the reason — do not silently revive

**FOUR OF THESE EIGHT ARE REVIVED, 2026-08-26, because their stated REASON is false.** That is
what this section is for. "Do not silently revive" is not "never revive" — the reason IS the
deferral, so a reason that stops being true takes the deferral with it. Reading the label instead
of testing the reason is how a deferral becomes a permanent exemption nobody re-examines.

- **E.1 · Distributed deployment — REVIVED, and it is a §B item hiding here.** "The interfaces
  are shaped for it; nothing is built" is false in its second half. `LeasedScheduler`
  (`run/scheduler.ts`) implements two of the three distributed behaviours its own docstring names
  — skip live leases, reclaim expired ones — with 13 contention tests exercising them against
  folded journals for two workers. It has **zero callers outside its own file**: `cli.ts` never
  names a Scheduler, so `loom serve` always runs `InProcessScheduler`. This is the exact
  "declared and wired to nothing" defect §B exists to name, sitting in the section that says not
  to look at it. Either plug it in or delete it; both are decisions, and neither is the current
  state.
- **E.2 · Partition assignment — REVIVED in its factual half.** "Deciding which runs a worker
  considers needs a coordinator" is still true and still unbuilt. But that decision had already
  shipped as a silent newest-200-first starvation policy, which was fixed on 2026-08-26. The
  normative half stands; the sentence needs to stop implying nothing decides it.
- **E.3 · Automated candidate generation — REVIVED.** The reason presupposed a correct scorer and
  a short sample: "under roughly thirty scored trajectories per cohort, any candidate is fitted
  to noise." The scorer was inverted (a failed run outscored a successful one) and is now fixed,
  and the cohort could not assemble at all until the bucket seam was wired. The sample argument
  survives; the premise it rested on did not, so the deferral has to be re-argued rather than
  inherited.
- **E.7 · seccomp / Landlock — REVIVED, and this one is a false safety claim.**
  "Platform-specific" holds. **"Subprocess isolation plus a filesystem jail plus an egress
  allowlist covered the stated threat model" does not.** Measured: one allow-listed binary read
  outside the jail and opened an arbitrary socket, bypassing two of the three mitigations. The
  tree already contradicts the claim twice in its own words — `sandbox/subprocess.ts` says the
  jail "is the CALLER'S to apply", and the proc-exec test header says that once a subprocess is
  reachable, "deny and the branch overlay are advisory". The deferral of seccomp may still be
  right; **the sentence claiming the threat model is covered is not, and that is the part that
  gets believed.**
- **E.8 · Vendor callback parsing — REVIVED, wrong in both directions.** Signature verification
  is built, wired and tested — `SignedWebhookChannel` implements Slack's exact scheme end to end.
  What is actually missing is per-vendor payload SHAPE parsing, and an email transport that does
  not exist at all (`email` is only an `Actor.via` label). The entry names the wrong blocker.

**Three still hold, verified rather than read:** E.4 subtractive mutation (the superset property
is real and removal is unrepresentable in the mutation type), E.5 custom reducers (the set is
closed at the type level with no registration seam anywhere) — though see the note below —
E.6 free-form chatter (its precondition holds; the reason itself names no measurable referent).

**E.5 is worth re-examining on the merits.** Its reason is "arbitrary code inside the determinism
boundary" — and that boundary now exists and is proven: a seeded PRNG from a journaled draw, a
clock bound to a journaled task boundary, `Date` and `Intl` absent, an embedder `globals` seam
that refuses a governed name. A user-authored reducer would run under exactly the machinery that
was not there when the deferral was written. Property 2 says extensibility should be unlimited;
a closed reducer set is one of the seven things the audit found still require a fork.

**Those seven now live in `README.md`, "Extending it, and where that stops"**, beside the eight
that need no fork, each quoted from the refusal the binary prints. Two of them moved while being
written down: an in-process tool needs a fork from the CLI and NOT from a library embedder
(`ToolRegistry` is pinned in `scripts/surface.json`; `openWorkspace` and `compileRealm` are not),
and it is a non-webhook delivery TRANSPORT that needs a fork rather than "a delivery channel" —
any HTTP endpoint is a config row. The count went SIX to SEVEN on 2026-08-28 by being measured
again: an identity source was on no list at all, while `--identity-file` is the binary's only
identity door and `IdentitySource`/`startControlPlane` are both pinned, so it carries the same
library-embedder split the tool row does. Do not re-enumerate the set here: one list, in the file
a stranger opens first.


**Re-checked 2026-08-25 — 8 items: 4 partial · 3 open · 1 n/a.**

| item | verdict | what running it showed |
|---|---|---|
| `E.1` **Distributed deployment.** A distributed v1 by a small te | partial | SECOND HALF IS FALSE AS WRITTEN. 'The interfaces are shaped for it' HOLDS: run/scheduler.ts is an explicit documented seam, and the journal conformance suite really does run a… |
| `E.2` **Partition assignment and cross-run fairness.** Deciding  | partial | THE NORMATIVE HALF HOLDS; THE IMPLIED FACTUAL HALF IS FALSE. 'Partition assignment across workers needs a coordinator' is still true and still unbuilt. But 'deciding which run… |
| `E.3` **Automated candidate generation, canaries and auto-promot | open | THE REASON'S PRESUPPOSITION IS FALSE. `OutcomeSignals.runStatus` is captured by the fold (trajectory.ts:96, set at :217/:223/:227) and then read by nothing: `readSignals` (sco… |
| `E.4` **Subtractive graph mutation.** Additive-only keeps the ex | open | REASON HOLDS, verified rather than read. The superset property is real: base node specs survive a mutation deepEqual-identical, and there is no expressible removal — an unknow… |
| `E.5` **Custom user-authored reducers.** Arbitrary code inside t | open | REASON HOLDS. The reducer set is closed at the type level, re-checked at compile time by name against REDUCER_NAMES, and there is no registration seam anywhere in either packa… |
| `E.6` **Free-form agent chatter.** Makes termination unprovable  | n/a | UNVERIFIABLE because the reason is a complexity claim about a mechanism that does not exist — there is no chatter to replay, so 'replay quadratic' has no measurable referent, … |
| `E.7` **seccomp / Landlock.** Platform-specific; subprocess isol | partial | 'PLATFORM-SPECIFIC' HOLDS (both seccomp and Landlock are Linux-only; this tree runs darwin) and the three mitigations are real and tested. 'COVERED THE STATED THREAT MODEL' IS… |
| `E.8` **Vendor callback parsing** (Slack, Teams, email). Deliver | partial | BOTH CLAUSES ARE OFF, IN OPPOSITE DIRECTIONS. 'Delivery outward is built' holds for the two HTTP-webhook vendors (Slack, Teams) via the generic WebhookChannel, but NOT for ema… |


Kept because re-deriving these costs more than reading them, and each was a real decision.

- **Distributed deployment.** A distributed v1 by a small team yields a distributed prototype, not a
  product. The interfaces are shaped for it; nothing is built.
- **Partition assignment and cross-run fairness.** Deciding which runs a worker considers needs a
  coordinator, and half a coordinator is worse than none.
- **Automated candidate generation, canaries and auto-promotion.** Under roughly thirty scored
  trajectories per cohort, any candidate is fitted to noise.
- **Subtractive graph mutation.** Additive-only keeps the executed graph a superset of the compiled
  one, which is what makes the compiled artifact meaningful.
- **Custom user-authored reducers.** Arbitrary code inside the determinism boundary.
- **Free-form agent chatter.** Makes termination unprovable and replay quadratic.
- **seccomp / Landlock.** Platform-specific. ~~subprocess isolation plus a filesystem jail plus
  an egress allowlist covered the stated threat model.~~ **Corrected 2026-08-26: all three
  mitigations are real, and the clause claiming they cover the threat model is false.** They bind
  this plane's OWN tools — `runSandboxed` confines a process, `assertWithin` is applied by
  `builtin/tools.ts` to its own path arguments, and `--egress` decides whether `net.fetch`
  registers at all. **A child process does its own `open()` and its own `connect()`,** so
  `proc.exec` is outside all three. `--help` has said exactly that at the flag for a long time
  ("allow-listing a shell dissolves the fs jail rather than narrowing it") and
  `sandbox/subprocess.ts` says it twice more. **The deferral of seccomp stands; the sentence did
  not.** What was missing was not a mitigation but a SENTENCE AT THE MOMENT IT HAPPENS: the boot
  banner names every guard that is off and did not name this one. It does now, and the decision
  is a pure function (`execWarnings`) so the interpreter list is testable without a socket.
- **Vendor callback parsing** (Slack, Teams, email). Delivery outward is built; the return trip
  needs per-vendor signature verification.

## F · Hard-won facts worth carrying forward

**Re-checked 2026-08-25; tallied from the table 2026-08-28 — 16 items: 7 DONE · 6 partial · 3 open.**

| item | verdict | what running it showed |
|---|---|---|
| `F.1` **Every durable fact must be rebuildable by folding the lo | **DONE** | THE COUNT IS ENUMERABLE AND IS ENUMERATED IN THE TREE — the task's premise is wrong. packages/core/test/run/oversight-survives-restart.test.ts:4-19 names all five: (1) PolicyE… |
| `F.2` **A vocabulary with two representations will drift**, and  | **DONE** | MEMBER LIST REFRESHED. packages/core/test/registries.test.ts:10-15 names four vocabularies; live sizes measured by importing the sources: CODES = 68, EVENT_TYPES = 52, ESCALAT… |
| `F.3` **A guard's permissive branch is where the surprise lives. | open | VIOLATED-AGAIN, 1 new instance: 086e13b (2026-08-25), promotion criteria 9 and 10 in packages/core/src/evolution/gate.ts. Sharpest fact available: the property was first WRITT… |
| `F.4` **Mutation-test every guard.** Several tests in this codeb | partial | THE HALF THAT HOLDS: the practice is real but narrow — 7 of 268 test files record having been mutation-tested (predicate-on-throws, workspace-documents, known-flags, spans, ov… |
| `F.5` **Driving beats sweeping.** Every wave that found real def | partial | COUNT REFRESHED and the asymmetry widened, not narrowed. In the f3c20ea..HEAD window the driving side kept producing: 069faf4 (2026-08-25) says in its own body "FOUND BY USING… |
| `F.6` **A test built from the same mental model as the fix certi | open | VIOLATED-AGAIN, 1 new instance: ab329be (2026-08-25), the declared-effects feature. The test was written from the same model as the feature ("a gate must stop the charge") and… |
| `F.7` **Reproduce by running, not by reading** — including when  | open | VIOLATED-AGAIN, live in the tree at HEAD. f975f9f's commit message asserts "51 source and test files had citations into it; those are stripped" — that claim was written rather… |
| `F.8` **Name the set a claim covers.** "This boundary is total"  | partial | HOLDS where it was written for, VIOLATED at the top of the very file that states it. The exemplar is in-tree and enumerable: spec.ts:807-810 names all four members and even re… |
| `F.9` **A self-describing claim has no fixed point.** State the  | partial | HELD exactly where the lesson was applied. The docstrings at spec.ts:791 and 821-823 state the PROPERTY ("every hit is a declaration, the surface pin, or prose; none is a read… |
| `F.10` **`node:vm` is not a sandbox** — it is scoping. Untrusted  | **DONE** | HELD, and the tree carries the property correctly at all five live sites: packages/core/src/resources/realm.ts:18-24 ("## This is NOT a security boundary, and says so… Untrust… |
| `F.11` **Absence is not zero, and an empty allow-list is the perm | **DONE** | HELD in both places I could reach it, and each keeps the two cases distinct rather than collapsing them. The `=== undefined \|\|` shape appears 56 times across 20 core source … |
| `F.12` **Approve means "go ahead", not "consider it done"** — on  | partial | HALF PINNED, and by the type system rather than by a count. packages/core/test/run/approve-means-go-ahead.test.ts drives one gated graph per node type off a `Record<NodeType, Case>`, so a ninth member is a COMPILE error here — verified by adding one: `TS2741: Property 'ninth' is missing … but required in type 'Record<NodeType, Case>'`. Each of the seven work types asserts journaled evidence its work ran AFTER the approval and not before; `human_gate` asserts no dispatch and no second raise. MUTATION RUN: flipping the branch to `if (true || node.type === "human_gate" || …)` turns 6 of the 10 tests red — `join` and `human_gate` stay green, and the header says why. STILL OPEN, the other half of A.3: `#compensateOne` dispatches every undo with `nodeApproved` FALSE (packages/core/src/run/engine.ts:1105-1110) and nothing in the suite fails if that flips. |
| `F.13` **A terminal operation is not final until every producer o | **DONE** | HELD with both arms and a negative control. NEWEST INSTANCE: 5b5c496 (2026-08-24, "a cancel stops the tasks too") — #commit returned early on a terminal run so an in-flight Ta… |
| `F.14` **Cross-realm values look identical and are not**; assert  | **DONE** | HELD, every clause verified independently. (a) cross-realm array: `instanceof Array` false and `getPrototypeOf !== Array.prototype`, so the prototype IS the discriminator; (b)… |
| `F.15` **macOS `grep` silently skips files containing non-ASCII b | partial | WRONG on both halves of the stated cause, though the prescription survives. (1) The trigger is a NUL byte, not non-ASCII: the five files are packages/core/src/evolution/trajec… |
| `F.16` **A fake credential in a doc must LOOK fake, or a scanner is right to stop you.** | **DONE** | GitHub push protection rejected 118 commits over `docs/audit-2026-08-25.md:447` — F42's evidence needed a `secret_ref`-classified value to show the SSE sweep passing one through unredacted, and the fixture was written to resemble a real Stripe key. EVERY OTHER secret-shaped literal in this tree already gets this right and none of them tripped: `AKIAIOSFODNN7EXAMPLE` is AWS's own documentation key, which scanners allowlist by design, and `ghp_abcdefghijklmnopqrstuvwxyz012345` is visibly sequential. F42's line was the sole outlier. Fixed to `sk_live_EXAMPLE_NOT_A_REAL_KEY`, and the history rewritten so no commit in the range carries the original. **AND THE LESSON THAT COST MORE:** the pre-push scan that declared the tree clean searched for `sk-` with a HYPHEN — the OpenAI/Anthropic shape — and the GLM key by value. Stripe uses `sk_` with an UNDERSCORE, so the pattern could not match and the claim was broader than the check. A secret scan that names one vendor's shape is not a secret scan. |


The archive is being deleted. These are the parts that cost real debugging time and would cost it
again. **They are stated as properties to preserve, not as history to honour.**

1. **Every durable fact must be rebuildable by folding the log.** Five separate in-memory fields
   held state a decision read, with no fold behind them; each one silently switched a guard off
   across a restart. The unit that needs a restore path is the *producer*, not the field.
   **The five are enumerated** — `packages/core/test/run/oversight-survives-restart.test.ts:1-20`
   names them: PolicyEngine escalations, human ceilings, accumulated spend, the taint set, and
   E4's failure streak. Cite that file rather than repeating the number; `CLAUDE.md:55` and
   `DESIGN.md:90` carry the same count and had no way to be checked against anything.
   **A sixth has NOT been added. Member #3 has regressed at a different layer:** the restore arm
   for accumulated spend exists and works, but the projection it restores from never folds
   `model.called` — so spend is missing before restore runs. See §A0.
2. **A vocabulary with two representations will drift**, and every gate walking the wrong one is
   silently switched off. Prefer a form the type checker can walk; where a test must do it, gate
   all representations as one set and read them from the source.
3. **A guard's permissive branch is where the surprise lives.** Refusals attract tests; the arm that
   lets something through does not.
4. **Mutation-test every guard.** Several tests in this codebase could not fail. A sweep only kills
   what it mutates, and a test whose expected value could also come from a fallback path is a
   tautology waiting to be discovered.
5. **Driving beats sweeping.** Every wave that found real defects found them by running a new shape
   of thing. Sweeps derived from the last finding mostly found nothing, because in a disciplined
   codebase most findings are exceptions rather than instances of a class.
6. **A test built from the same mental model as the fix certifies the model, not the mechanism.**
7. **Reproduce by running, not by reading** — including when correcting a document. A correction
   that replaces a false claim with a differently-false one is worse than the original, because it
   asserts verified accuracy and is believed harder.
8. **Name the set a claim covers.** "This boundary is total" cannot be checked; a claim that names
   its members can. A count nobody can enumerate is a count nobody checked.
9. **A self-describing claim has no fixed point.** State the invariant, not the measurement, when
   the claim is about the artifact containing it.
10. **`node:vm` is not a sandbox** — it is scoping. Untrusted code needs a process boundary.
11. **Absence is not zero, and an empty allow-list is the permissive case.** "Named nobody" and
    "could not read who it names" must never produce the same value.
12. **Approve means "go ahead", not "consider it done"** — on every node type except the gate
    itself, there is work behind the gate.
13. **A terminal operation is not final until every producer of the state it ends is stopped.**
14. **Cross-realm values look identical and are not**; assert on the prototype, and know that
    `Array.isArray` is realm-agnostic and throws on a revoked proxy.
15. **A plain `grep` can silently skip a file, and empty output is not evidence of absence.**
    Always `grep -a`. **The stated cause was wrong, corrected 2026-08-25:** the trigger is a NUL
    byte, not non-ASCII — `/usr/bin/grep` (BSD) matches accented text fine — and it affects 5
    tracked files. In this environment `grep` is also a shell-snapshot function rather than BSD
    grep, which is where the *silence* comes from. The prescription survives its explanation,
    which is why the error propagated for so long without breaking anything.

## G · From the 2026 field survey — new work the redesign creates

**Re-checked 2026-08-25; tallied from the table 2026-08-28 — 8 items: 1 DONE · 4 partial · 3 open.**

| item | verdict | what running it showed |
|---|---|---|
| `G.2` ~~**Clock bound to the journal (D3).**~~ **DONE for `ctx.n | **DONE 2026-08-28** | SUPERSEDED — the DONE holds now: `replay-clock.test.ts` is 3/3 green and `loom replay` builds its engine with hooks. When this row was written it did not, and what follows is that measurement: The mechanism is half-built: `#bodyClock` (engine.ts:3058-3061) does read `p.tasks[taskId].lease.at`, and projection.ts:720 does fold that from the jou… |
| `G.3` **The one-line agent surface (D1).** `agent({model, tools, | **DONE** | Verdict it DONE — the bullet is unmarked and should be struck. `packages/core/src/agent.ts` exists, is exported from the public surface (`packages/core/src/index.ts:10  export… |
| `G.1` ~~**Declared effects (D2).**~~ **DONE for `function` nodes | partial | The DONE holds on all five clauses it names, and BOTH "still open" riders check out. `reachableToolNames` does include function effects (spec.ts:850), which is the single rout… |
| `G.4` **Divergence must be terminal and loud.** The known failur | partial | TERMINAL AND LOUD: already true for the recorded-effect path, so that half of the bullet is stale as a work item. `E_REPLAY_DIVERGENCE` is in `RUN_FATAL_CODES` (engine.ts:265-… |
| `G.5` **Two-axis labels (D4).** Integrity × confidentiality, mos | partial | Four sub-claims, three verdicts. (a) "Integrity × confidentiality" — BOTH AXES NOW EXIST: `tainted`/`applyTaint` for integrity and `carriesSecret`/`applySecretFlow` for confid… |
| `G.6` **Prompt text into the artifact hash (D7).** A prompt edit | partial | FIRST HALF TRUE, SECOND HALF FALSE. Prompt text is genuinely not in the artifact hash — `graphHash: digest(spec)` (compile.ts:158) digests the spec, and a ref'd prompt's text … |
| `G.7` **Payload externalisation.** Above a byte threshold a payl | DONE 2026-08-28 | Reproduced exactly as written. `MAX_PAYLOAD_BYTES = 8 * 1024 * 1024` (journal/store.ts:179) and `boundedPayload` THROWS above it (store.ts:214-221); the code's own comment at … |
| `G.8` **Proposed-API mechanism and a version pin (D5).** | open | Both halves of D5 are unbuilt. There is no proposed-API declaration file, no opt-in, and no publish-time refusal for an extension that uses one; and there is no runtime versio… |
| `G.9` **One retry budget per run**, decremented across every lay | open | The work item stands: no run-scoped retry budget exists, so nothing decrements across layers. On the RATIONALE, which is a three-member aggregate — I confirmed two of the thre… |
| `G.ids` Each traces to a decision in `DESIGN.md`. | partial | Every id cited in G resolves, and every subject matches: D1 "The default surface is one line" ↔ the one-line agent surface; D2 "Effects are DECLARED, not called" ↔ declared ef… |


Each traces to a decision in `DESIGN.md`.

- ~~**Declared effects (D2).**~~ **DONE for `function` nodes.** `FunctionNode.effects` names the
  tools a body may invoke; `reachableToolNames` sees them, so the capability ceiling, the
  unknown-tool diagnostic and the oversight floor all apply by the route a tool node's name
  already travelled — an irreversible declared effect gates the node with nobody configuring
  oversight. The body gets one bound invoker per name through `ctx.effects`, each routed through
  the single dispatch path and keyed by position in the call sequence.
  **Still open:** the same for `evaluator` bodies, and the sandbox. A resource-loaded body runs
  synchronously inside `vm.runInContext` and cannot await, so `ctx.effects` is honestly absent
  there rather than broken — giving a sandboxed body effects means an async bridge, which is its
  own design.
- ~~**Clock bound to the journal (D3). NOT DONE — the strikethrough was removed 2026-08-25.**~~ **CORRECTED 2026-08-28 — it REPRODUCES.** `packages/core/test/run/replay-clock.test.ts` pins it with three paired controls, 3/3 green, and §A0 recorded the fix on 2026-08-25 while this entry went on asserting the opposite for three days. The original reading is kept below because the measurement in it is what made the defect findable; its verdict is not.
  A body's clock does read the task's journaled `task.leased` timestamp (`engine.ts:3058`,
  folded at `projection.ts:720`), and two reads in one body do return the same instant. But it
  **does not reproduce on replay**: the shadow run appends its OWN `task.leased`, stamped by the
  replay engine's wall clock (`engine.ts:2443`), so `replay.ts:439`'s shadow clock is never
  reached. Measured: two replays of one run return different values, differing by whatever pause
  separated them. The half that is built is the half
  inside a single run; the property that makes replay total is the one that is missing.
  **Still open: `Date` in the realm.** It stays absent, and the reason changed — not "no seed
  could make it reproducible" but "a frozen `Date` that silently never advances is more
  surprising than an absent one". Restoring it means binding the whole constructor to `ctx.now`.
  Bind `Temporal` in the same change when it becomes a default global.
- ~~**The one-line agent surface (D1).**~~ **DONE, re-checked 2026-08-25.** `agent({prompt,
  tools, adapter})` compiles to a one-node graph and is exported from the public surface
  (`index.ts:10`); `packages/core/test/agent.test.ts` proves each clause — one-node graph,
  journal + replay, gates, budget ceiling. (This once read "the bullet was never struck", three lines under a struck bullet. It is struck.)
- **Divergence must be terminal and loud.** The known failure mode of every replay-based runtime
  is a silent stall: the task retries forever without entering a failed state. A repeated
  divergence signature with no forward progress needs its own terminal state.
- **Two-axis labels (D4).** Integrity × confidentiality, most-restrictive, **unlabelled ⇒
  untrusted** — the last is the valuable half and the one this codebase does not have: a tool that
  is not `isExternal` writing data from anywhere is untainted today. Branch-coordinate scoping was
  built and reverted: sibling arms of a fan-out run the same node sequence so they taint
  identically, and the one divergent shape is refused by `GRAPH010_CONCURRENT_WRITE`. See
  `DESIGN.md` D4 for what would reopen it.
- **Prompt text into the artifact hash (D7).** A prompt edit currently changes what a resumed run
  does, silently.
- ~~**Payload externalisation.**~~ **DONE** — see §A. It unblocked retention tiering, which was
  then answered by deleting it (§D.14), so nothing is waiting on this one any more.
- **Proposed-API mechanism and a version pin (D5).**
- **One retry budget per run**, decremented across every layer. Engine retry × provider retry ×
  agent-loop retry currently multiply.

## H · Housekeeping carried into the sweep

**Re-checked 2026-08-25; tallied from the table 2026-08-28 — 4 items: 1 DONE · 2 partial · 1 open.**

| item | verdict | what running it showed |
|---|---|---|
| `H.1` `packages/eagent/tui` — **deleted** as part of this sweep. | **MOOT 2026-08-28** | The remaining work was a docs sweep inside `packages/eagent/`, which no longer exists. Original finding — COUNT WRONG: 'two tests that assert the directory exists' is ONE. At 3e5e4bb^ the only existence assertion on the directory is zero-dep.test.ts:140 `assert.ok(existsSync(tuiPk… |
| `H.2` The web frontend was already designed once and closed, and | partial | Accurate, and now sharper than written: the terminal client was dropped 2026-07-27, REBUILT two days later as e9b8701 'feat(phase2): the tui/ package -- Ink + React over the z… |
| `H.3` `bin/loom` is gitignored and goes stale on any source edit | open | Standing condition, correctly stated, and it bit during this audit — the checked-out binary is already 109s behind src at HEAD. packages/core/test/readme-gaps.test.ts:331-333 … |
| `H.4` Commits land under the human author's identity only. No as | **DONE** | NOT A BACKLOG ITEM — it is a standing project rule already stated at CLAUDE.md:76-77, so TODO.md:310-311 is a duplicate of a contract file and will drift from it (it already h… |


- `packages/eagent/tui` — **deleted** as part of this sweep. Its removal breaks two tests that
  assert the directory exists, and touches the package guide, the README, the architecture doc, a
  release script and a display-surface test. It is a transaction, not a delete.
- The web frontend was already designed once and closed, and the terminal client already dropped
  once, in July 2026. That history is being retired with the rest — noted only so the sweep does
  not treat the leftovers as live work.
- `bin/loom` is gitignored and goes stale on any source edit; nothing rebuilds it automatically.
- ~~Commits land under the human author's identity only.~~ **Moved out 2026-08-25** — this is a
  standing project rule, not backlog, and it already lives at `CLAUDE.md:76-77`. The two copies
  had drifted (this one carried an extra "in commit bodies or pull requests" clause). `CLAUDE.md`
  is the single copy; the extra clause was folded into it.
