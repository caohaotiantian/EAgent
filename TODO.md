# TODO

Everything unfinished, self-contained. **Nothing here is a plan** — the roadmap is `DESIGN.md`'s
Sequence, the decisions live in the commit history, and this file is only the list of what is
still true and still open.

## How to read this — four rules

- Rule 1 — **Reproduce by RUNNING, not by reading.** Every row carries the command that settles it;
  a row you cannot run is a row you must not write.
- Rule 2 — **Name the set a claim covers.** A count nobody can enumerate is a count nobody checked.
- Rule 3 — **A self-describing claim has no fixed point.** State the invariant, not the
  measurement, when the claim is about the artifact containing it.
- Rule 4 — **Every row states what would close it.** A row with no closing condition is a row
  nobody owns; delete it with an argument instead of carrying it.

Convention: a row struck through (`- ~~**A.N …**~~`) is CLOSED and must not be re-fixed. Row ids
are stable — other files cite them — so a closed row keeps its id rather than being renumbered
away. `§Z` is the register of closures with the sha that carries each argument.

**Direction, 2026-09-22b — this file is the list, not the order.** What to do next is
`DESIGN.md`'s Sequence **items 29–31** (distribution; the one channel-shape question behind §A.82,
§A.83 and §A.90; the journal vocabulary §C is blocked on) plus the two items already open there —
**24** (§A.29) and **18** (§G.5's residue) — and the owed-decision list that follows them, with the
argument in `docs/handoff-2026-09-22b.md` §6. **Amended 2026-09-22: TWO of those decisions are now
TAKEN and item 30 is IMPLEMENTATION, not a question.** The channel shape is `DESIGN.md` **D8** (one
reserved error projection per node — §D.10 is struck with it) and the shipped approval example is
`DESIGN.md` **D9** (`skip`, with veto as a second file — §A.68's addendum); both are that file's
Decisions section, and `TODO.md` §D.8 / §D.9 are different rows one dot away. The decided ORDER is:
the projection and `grant-access`'s `error` arm branching by code, deleting `look` and the
`KNOWN HAZARD` test → then §A.68's word and the example split → then items 29, 18/24, 31. **The
first two steps have landed** (D8 phase one at `83f86bec`, D9 on 2026-09-23 — §A.90 and §A.68's
addendum), and item 29 is built short of its publish (`48de87f6`, §H.15) — so what is next is the
maintainer's publish, then 18/24, then 31 (`docs/handoff-2026-09-23.md` §6).

---

## State — one command each, re-run 2026-09-23 on `48de87f6`

| fact | value | command |
|---|---|---|
| the gate | **exit 0** | `npm run check` |
| tests on `loom` | **4,162 pass / 0 fail** (suites 0, cancelled 0, skipped 0, todo 0; 4,117 → 4,162) | `npm test` |
| pinned exports | **544** (542 → 544): `ErrorProjection` and `errorProjectionSource`, D8's envelope and its `"<nodeId>:error"` parser, added to `scripts/surface.json` by the D8 lane — the guard's list moved with the name set, which is what it is for. **LEDGER WATCH, carried**: `POLICY_FIELDS`, `NESTED_FIELDS` and `EDGE_FIELDS` changed SHAPE under unchanged names in earlier waves, and the guard pins names only (`TODO.md` §D.11) | `node scripts/check-surface.mjs` |
| kernel | 10 files pinned, **17 declared seams** (16 → 17): `6a03694d`, the D8 `feat:`, touched `graph/spec.ts`, `run/projection.ts` and `run/engine.ts` and carries a `Kernel-seam:` trailer — `there is none for "a fact about a node's outcome that a later node may read"`. The wave's other kernel edits: `c153566e` (`run/engine.ts`, `fix:`) and `2f1c19ff` (`graph/spec.ts`, `run/gates.ts`, `docs:` — the package rename in prose), owing none | `node scripts/check-kernel.mjs` |
| zero runtime deps | ok, **69 files** (67 → 69): `src/bin.ts` (the Node-floor entry with no static imports) and `src/version.ts`. Of the wave's ten new files, three are test suites, one a graph (`two-person-veto.json`), two scripts (`pack.mjs`, `smoke-install.mjs`), and `packages/core`'s README and LICENSE | `node scripts/check-zero-dep.mjs` |
| NUL census | **5** files carry a NUL byte, **0** are invalid UTF-8, unmoved. The denominator is deliberately not a cell (rule 3) | read every `git ls-files` path; see CLAUDE.md |
| journal vocabulary | 51 event types, unmoved — D8 folds its projection out of `task.failed` and added no event | `EVENT_TYPES.length`, asserted in `test/journal/store.test.ts` |
| error vocabulary | **62 codes** (60 → 62): `E_FS_NOT_FOUND` and `E_FS_UNREADABLE`; `fs.read`'s third code, `E_CAP_DENIED`, already existed. The `GRAPH005_ERROR_PROJECTION_*` refusals and `GRAPH003_STALE_FS_READ_CODE` are compile diagnostics, not `CODES` members | `Object.keys(CODES).length` |
| README's extensibility ledger | **18** and **3**, both unmoved | the two `sed … \| /usr/bin/grep -a -c` commands in `CLAUDE.md` §2 |
| README's test floor | **3,500+**, unchanged; the probe counts **3,899** `test(` declarations across **366** files (3,855 / 363 last wave) | the Gates row of `README.md`, and `readme-gaps.test.ts`'s own probe |

The kernel guard also prints a commits-judged count (904 at `48de87f6`; 879 one wave ago). It is
deliberately not a cell above: it moves with every commit, this file's own included — rule 3.

**Every wave lane is merged into `loom`.** `git merge-base --is-ancestor <sha> loom` is the check
per lane — a merge that REPORTS merged is not evidence the work arrived. The 2026-09-23 lanes are
`9288e678` (d8-error-projection), `d04d1bcb` (d9-quorum-veto) and `4ec84c11` (item-29-install),
merged `--no-ff` in that order (`83f86bec`, `e9f7fae4`, `48de87f6`) with zero conflicts — the NINTH
wave running. `docs/handoff-2026-09-23.md` is the current handoff; `docs/handoff-2026-09-22b.md` is
the one before it.

## Row census — three commands, run on this file

```bash
/usr/bin/grep -aoE '^- (~~)?\*\*[A-Z0-9]+\.[0-9]+ ' TODO.md   # every row
/usr/bin/grep -aoE '^- ~~\*\*[A-Z0-9]+\.[0-9]+ '    TODO.md   # the struck (closed) subset
/usr/bin/grep -acE '^[0-9]+\. \*\*' TODO.md                   # §F, a numbered list, counted its own way
```

**Do not carry those three numbers here** — they are counts of THIS file and move with every edit
to it, this sentence's own included (rule 3). Run the commands. What IS fixed enough to write down
is the settlement-to-settlement series, because each term is pinned to a commit: **46 → 51 → 56**
at `bde693e2`, `0a9483c0` and `279b5c73`, by the first two commands above — and **62** at
`48de87f6` (164 rows, 102 struck), the 2026-09-23 wave's merge, before its settlement opened §A.99 and §H.17–§H.20. The 2026-09-22b
assessment added §D.10, §D.11 and §H.15, and **none of the three is new WORK**, but they are not
new in the same way: **§D.10** collects one question that THREE rows — §A.82, §A.83 and §A.90 —
were each waiting on separately; **§D.11** is where a question already raised twice in prose gets a
row, by §A.62's own closing clause and by §State's two LEDGER WATCH cells; and **§H.15** names an
absence `README.md`:55 and :69–72 already documented at `369eb4f6` (that text is now README's
"Install it").

**And the open count moves for reasons that are not work, in BOTH directions — which is why the
series above is pinned to commits and not carried.** Two instances, one each way: the three rows the
assessment ADDED (§D.10, §D.11, §H.15) land in `369eb4f6`, after `279b5c73`, so the open count stood
three above the 56 pinned there — **59 at `369eb4f6`** — before this file was touched again, and
none of the three was new work; and §D.10 was then ANSWERED by the maintainer on 2026-09-22 (option
(a), `DESIGN.md` D8), which struck a row with nothing FIXED — §D's struck column moved 5 → 6 and its
open column 6 → 5 while its row count stayed 11. Re-run the commands rather than subtracting. The
three §A rows §D.10 unblocks (§A.82, §A.83, §A.90) stay OPEN, because what is left of them is the
implementation.

"Rows present" and "rows still open" are different facts; a table stating only their difference can
be wrong without being falsifiable, which is why there are three columns.

| section | rows | struck | still open | the shape of it |
|---|---|---|---|---|
| §A0 | 17 | 15 | 2 | the phase-2-4 merge's remainder, plus what the 2026-09 waves recorded rather than fixed |
| §A | 98 | 62 | 36 | **§A.90 CLOSED 2026-09-23 by `DESIGN.md` D8's phase one — struck on its row, with the binary repro; its review opened FOUR (§A.95–§A.98), two of them residue of the projection and two pre-existing.** **§A.99 opened by the 2026-09-23 settlement** — the veto example says nothing undoes a late reject, and over an existing file the run-failed compensation does. open defects, unguarded behaviour, two deliberate non-defects recorded so nobody "fixes" them, the FIRST stranger's port (all six closed, F1 with them), three still-open rows from the 2026-09-22 settlement (§A.77, §A.82, §A.83 — the last two now wait on a PRODUCER for a field that exists, §A.90's half having landed 2026-09-23) and ten opened by the 2026-09-22b one (§A.85–§A.94). The 2026-09-22b wave closed FIVE (§A.78, §A.79, §A.80, §A.81, §A.84) and opened TEN, so open went 27 → 32 — **a RISE for the SECOND settlement running, and again the largest in this file's history**, by the same mechanism: five of the ten (§A.90–§A.94) are the THIRD workflow port's friction log, met by a stranger driving the shipped binary, and five (§A.85–§A.89) are residue of the four compiler rows this wave closed, found by probing what the closures now compute. **The five that closed were all rows a stranger could RUN** — which is the argument for the repro discipline rather than for the count |
| §B | 2 | 2 | 0 | **empty** — declared and wired to nothing, down from 13, and now from 2 |
| §C | 5 | 2 | 3 | unbuilt observability |
| §D | 11 | 6 | 5 | decisions still owed; two narrow, whether `CODES` belongs on README's fork list, and whether a join's inbound edge must be `kind: join`. §D.9 was answered (a) by the wave orchestrator, not by the maintainer, and says so. **TWO OPENED 2026-09-22b by the settlement's assessment, and neither is new work — each collects a question existing rows were already waiting on separately, and each names those rows**: §D.10 (what a channel carries when a tool fails, truncates or holds a secret — collecting §A.82, §A.83 and §A.90; **ANSWERED 2026-09-22 by the maintainer, option (a), and struck — `DESIGN.md` D8**, which is why struck is 6 and open 5 here) and §D.11 (the shape-break policy for exported kernel constants — raised by §A.62's closing clause and by §State's two LEDGER WATCH cells, which is where §A.81(a)'s repeat of it is recorded) |
| §E | 8 | 0 | 8 | deferred on purpose, with the reason — do not silently revive |
| §F | 19 | — | — | properties to preserve; nothing here is "open" |
| §G | 7 | 1 | 6 | field-survey work the redesign creates |
| §H | 21 | 15 | 6 | housekeeping; §H.0 is a decision the maintainer already made rather than work outstanding, and **§H.15 — no stranger-facing install, `npm publish` exiting 0 doing nothing — is the second, opened 2026-09-22b and closing with `DESIGN.md` item 29: everything but the publish landed 2026-09-23, and it closes on the publish receipt**. §H.16 (the OTLP scope name still `@loom/core/telemetry`) is the third, opened by that lane. §H.14 closed on 2026-09-19 by wrapping for a terminal and never for a pipe, which left §H's last readability row closed and opened nothing here — its two residues (`2>&1 \| less`, and control-character stripping on the TTY path only) are recorded IN the row rather than carried as rows. **§H.17–§H.20 were opened by the 2026-09-23 settlement** out of the item-29 lane's open list — the tarball's contents, `@types/node`, two CLI doors answering 0, and a test's leaked temp dirs. **§H.20 CLOSED 2026-09-23 at `39c5e0b5`** — each leaking suite now removes its roots in a module-level `after` |

The 2026-09-02 audit's 207 findings are NOT copied into the rows below; the record is
`docs/audit-2026-09-02.md`.

---

## A0 · Reproduced and NOT fixed

- ~~**A0.5 · A channel named `toString` still compiles clean.**~~ CLOSED at `3cfd363`.
- ~~**A0.8 · `#edgesToTake`'s exhaustiveness claim is false.**~~ CLOSED at `6b3513b`.
- ~~**A0.14 · A model with no price row and no dated base still prices 0.**~~ CLOSED at `3656d69`.
- ~~**A0.16 · Three injection paths are live on `loom`, on no register row.**~~ CLOSED at `02a5e84`.
- ~~**A0.17 · `POST /runs` accepts the input the CLI refuses.**~~ CLOSED at `86193e3`.
- ~~**A0.18 · A flake in `test/server/plane-watch-and-stop.test.ts`.**~~ CLOSED at `4bc3ce1`.
- ~~**A0.19 · A NODE id may still be an `Object.prototype` name.**~~ CLOSED at `878001c`.
- ~~**A0.20 · The mirror-gate asymmetry.**~~ CLOSED at `6b3513b`. `GET /gates` still lists both
  rows; that listing is the disclosed residue and its decision is unmade.
- ~~**A0.21 · A router's `take` selects a `compensation` edge and walks past a human gate.**~~
  CLOSED at `ff8fdac`.
- ~~**A0.12 · A permanently-undriveable stranded run recompiles the whole workspace on every tick.**~~
  CLOSED at `b4a7835`: compile memoised per file.
- ~~**A0.23 · The seventh cross-run child touch is unwrapped, and still answers `E_INTERNAL`.**~~
  CLOSED at `05b495b`: seventh cross-run touch wrapped.
- ~~**A0.24 · `gates.ts` keeps its idempotency entry after a non-`E_SEQ_CONFLICT` throw.**~~
  CLOSED at `5f59559`: idempotency entry deleted on any throw.
- ~~**A0.25 · `E_SUBGRAPH_FAILED` carries six raises of two different meanings.**~~
  CLOSED at `0270d84`: E_CHILD_UNREACHABLE splits the code.
- ~~**A0.26 · The kernel guard's merge coverage is conflict-resolving merges only.**~~
  CLOSED at `c8aad7d`: census reads merges; trailers unified.
- ~~**A0.27 · The `mcp__` reservation holds at `register()`, and two things beside it do not.**~~
  CLOSED at `eee63b9`: overlap refused, fields frozen once.
- **A0.13 · The usage floor's dollar residual is ~10×, and no function of the two numbers a wire
  reports can close it.** Repro:
  `node --test packages/core/test/providers/usage-per-rate-floor.test.ts` → 9 pass / 0 fail, five
  named `ORDINARY`. The `=== 1` defeat closed at `49624c0` and the ~80× compounding at
  `dcf54c9` (`dearestRateFloor` in `providers/usage.ts`, a `Math.max` beside the sum floor). What
  remains is the raw cacheRead-to-input rate ratio, and it is structural: the adversary's optimum is
  `cacheCredit` close to `estimated`, and a wire claiming a full cache hit reports the identical two
  numbers as an honest one. **Closes with** a cap on credited cache tokens at the tools-plus-system
  prefix the request body actually marks `cache_control` on — which needs real cached-deployment
  measurement to parameterise without breaking the honest-hit pins — or with an explicit decision to
  accept ~10× as inherent. Two carriers ride with it: an operator price table pricing cacheWrite
  below input reopens the compounding on the write dimension (`dearestRateFloor` assumes
  `inputTokens` is the dearest rate); and a genuine partial hit with a small honest remainder is
  over-charged, ~5% on one fixture, pinned as `ORDINARY 5 (NOT unchanged)`.
- **A0.22 · The delegation door still permits the input the plane now refuses.** Repro:
  `/usr/bin/grep -anc 'Object.hasOwn(child.channels, childCh)' packages/core/src/graph/validate.ts`
  → 2. `rule016Subgraphs` tests a `subgraph` node's mapping against the child's `channels`, never its
  `inputs`, and `Engine.#runSubgraph` submits that map — so a parent may hand a child exactly the key
  `POST /runs` refuses at the wire (§A0.17) and `loom run --input` has refused since `8c734ce`.
  **Closes when** §D.6 is settled, and not before: keying `rule016Subgraphs` on the child's `inputs`
  tightens the delegation, while §D.6's option (f) keys all three doors on `channels` and relaxes the
  plane instead. They are opposite directions and the decision is §D.6's.

---

## A · Open defects and unguarded behaviour

### The replay-fidelity class

- ~~**A.1 · Three token/cost refusals cannot be re-derived by a replay.**~~ CLOSED — the `quote`
  member of `effect.started.kind`, seam trailer `a8d62fb`; `test/run/replay-fidelity.test.ts`.
- ~~**A.2 · A replay grades no MESSAGE, so a path-dependent refusal diverges in silence.**~~ CLOSED
  by `34a7f14`. `details` is deliberately not graded.
- ~~**A.3 · Three sites named the wrong set for "a journal with no `provider`".**~~ CLOSED — all
  three now name the window (journals written before `e6d00f2`); the behaviour cannot change.
- ~~**A.4 · `hermetic`'s third conjunct had no producer in `src/`.**~~ CLOSED — `bodyEntered` at
  FETCH plus `carryRealmBrand` in `resources/functions.ts`.
- ~~**A.5 · Two kernel files stated a set as total and were not.**~~ CLOSED — both now state the
  PROPERTY, and `sla.reminders[i]` is named `GateReminderSpec` so it sits inside the drift guard.
- **A.6 · A pass-through value with a two-faced `then` getter still crosses the realm boundary, and
  it is left open deliberately.** Repro:
  `/usr/bin/grep -anc 'WHAT IT STILL DOES NOT CATCH' packages/core/src/resources/realm.ts` → 1, and
  that heading names the two members. Member 1 (a `Map`) IS caught, by the canonicalizer refusing a
  `Map` at all; the survivor is member 2 — `rebuild` returns a value as-is whenever its prototype's
  constructor is not named `Object`, i.e. every class instance. Measured through the hook loader at
  `callTimeoutMs: 100`: `PASS-THROUGH CROSSED at 1 ms; host proto? false`, then `AWAIT resolved at
  1945 ms`. **No read closes it** — reading `.then` host-side runs the getter on the host thread,
  the hazard the gate exists to avoid. **Closes only by** refusing every non-plain return outright
  (deleting the canonicalizer message member 1 depends on) **or a process boundary** — the same limit
  A.10 ends on, and they should be paid for once.

### Oversight, and the places a floor is weaker than it reads

- ~~**A.34 · `Engine.rewind` had no floor.**~~ CLOSED — `by: HumanActor` with no default and
  `E_HUMAN_APPROVAL_REQUIRED` as the first check, unconditionally; the route is a 403 for a service
  token and for an open plane.
- ~~**A.35 · A rewind's authorization is blind.**~~ CLOSED (seam `52da0e8`) — `planRewind` +
  `GET /runs/:id/rewind-plan`, both halves needing a human, preview and dispatch sharing ONE
  `#planRollback` walk, and a per-run chain serialising concurrent rewinds. `rewind-plan.test.ts`.
- ~~**A.8 · The compensation dispatch's `nodeApproved: false` is load-bearing and nothing tests
  it.**~~ CLOSED at `552d999` — `nodeApproved: trigger === "rewind"`, with the fixture that goes red
  in both directions in `compensation-fires.test.ts`.
- **A.10 · An async body cannot be bounded by any deadline, so it is refused.** Repro:
  `/usr/bin/grep -anc 'ASYNC_RULE' packages/core/src/resources/realm.ts` → 7 — the refusal is stated
  once at the seam. `vm`'s timeout covers synchronous execution only, so the refusal is correct.
  **Closes when** there is a process boundary to run one in — the same prerequisite as §F.10, and it
  should be built once for both.
- **A.11 · A 429 arriving after a non-idempotent `effect.started` with NO `effect.completed` refuses
  both a retry and a deferral.** The world may already have changed and the journal cannot say. The
  one row of the rate-limit table that stays red, deliberately — *refusing is always allowed.*
  **Closes when** the journal can distinguish "the effect ran" from "the effect may have run", which
  is a different item and probably A.1's seam.
- **A.12 · A deferral counts toward E4's consecutive-failure streak.** `#recordEvidence` runs before
  the retry decision, so a long rate-limit outage escalates a node's posture sooner than it used to.
  **Left alone deliberately: not counting it would be LOOSENING oversight.** Recorded so the next
  reader does not "fix" it. **Closes only** if somebody argues that a provider being busy is evidence
  about the node — and that argument has to be made, not assumed.

### Bounds and backpressure

- ~~**A.13 · `loom run`'s `MAX_BACKOFF_WAITS` is 64 and a deferral can be up to 60 s.**~~ CLOSED by
  `96a03bf` — the CLI waits on a journal predicate (`seq` not moving) rather than a wait count.
- ~~**A.14 · `run.submitted.inputs` is the last inline copy of a payload.**~~ CLOSED (`6d830d7`,
  `eba2a63`) — `run.submitted.external` names which inputs left the journal and the trajectory fold
  puts them back as handles, so `defaultBucket` cannot split a cohort on a 64 KiB threshold.
- ~~**A.15 · `RUN_CLOCK_SCAN_CEILING`'s residual.**~~ CLOSED (seam `3762a0e`) — `RunFilter.after`
  and a paged `runClockTick`, which throws `E_CONFIG_INVALID` the first time a page boundary repeats.
  The constant has no declaration left in `src/` — its two mentions are comments. `run-clock-window.test.ts`.
- ~~**A.16 · Process-local and unreconstructable state.**~~ CLOSED — the set of ten is named in
  `cli.ts`; nine lose only work, the tenth is A.17.
- ~~**A.17 · A plane that RESTARTS cannot reclaim its own pre-restart leases.**~~ CLOSED — measured
  at exactly one `leaseMs` and accepted, because no identity does better under §D.2's single-machine
  answer. `test/deployment/two-planes.test.ts`.

### Boundaries that are unexamined rather than broken

- ~~**A.18 · A branch choice made from untrusted content raises nothing.**~~ CLOSED by `b2f4002` —
  control taint folded at the deciding commit, keyed on the CHOICE rather than on `node.type` after a
  reviewer drove four bypasses; the covered set is named at `choiceOf`.
- **A.19 · "Partial reads of untrusted values remain in ~25 files" names no predicate, so it cannot
  be re-derived.** Repro: `/usr/bin/grep -arl 'Array\.isArray' packages/core/src | wc -l` → 34 today
  — a different set measured a different way, evidence neither for nor against 25. The row's one
  runnable claim was corrected 2026-09-02: of the three files `resources/realm.ts`'s docstring names
  as each carrying a private array guard, only two do — `telemetry/spans.ts`'s `isList` and
  `run/delivery.ts`'s `isArrayValue`; `security/redact.ts` defines neither
  (`/usr/bin/grep -anc 'isList\|isArrayValue' packages/core/src/security/redact.ts` → 0), and its
  four `Array.isArray` sites are ordinary. **Closes by deletion with that argument, OR by naming the predicate** (which read
  counts as a partial read of an untrusted value?) and re-deriving the set from it. Until one of
  those happens it is a row nobody can check, which is the thing it warns about.
- ~~**A.20 · A rare suite flake: four sightings, never reproduced.**~~ CLOSED — a 0.28–0.32 ms
  window between `announce`'s last banner line and `serveUntilInterrupt` installing the SIGINT
  handler, in which `stop()` was a KILL. `harness.ts`'s `awaitStoppable` proves the handler exists by
  one answered `/health`; `stopVerdict` refuses a signal death by name.
  `test/deployment/boot-banner.test.ts`.
- **A.20 (superseded) · the four-sighting record.** No separate work: superseded by the struck A.20
  above, and kept only because the id is cited. Repro and closing condition are that row's.
- ~~**A.45 · The live SSE console says `failed` where `GET /runs/:id` says `skipped`.**~~ CLOSED by
  `7ba3b99`, `25cd252` and `88b3bad`. The row asked for two arms and the answer was to stop counting
  arms and census the SOURCE instead: `run/projection.ts` has **nine** `upsertTask` sites that set a
  `state` (`/usr/bin/grep -an 'upsertTask(' packages/core/src/run/projection.ts` → 11 hits, of which
  `:704` is the definition and `:802` sets `usage`), and every one now has a console counterpart —
  `task.skipped`, `task.cancelled` and `task.retry_scheduled` arms plus `gate.raised`, and
  `25cd252` for the ninth, which two builder reviews missed: `projection.ts`'s `gate.decided` arm
  returns the RAISING task to `ready`, and the console left it `awaiting_gate` until the next frame
  arrived. Repro now: `/usr/bin/grep -anc 'ev.type === .task\.' packages/core/src/server/console.ts`
  → **7** (`task.ready`, `leased`, `committed`, `failed`, `skipped`, `cancelled`,
  `retry_scheduled`), plus `gate.raised` and `gate.decided` — seven and two is the nine. `88b3bad` rode with it: `/health`'s
  promise chain had an unhandled rejection. Pinned in `test/server/console.test.ts` against the new
  shared harness `test/server/console-page.ts`.

### Guards over states nobody has constructed

- ~~**A.21 · `suite freeze`'s unresolved-gate exclusion is a guard over a state nobody has
  constructed.**~~ CLOSED at `25b906ee` — **settled BY CONSTRUCTION, and the exclusion is KEPT.**
  Unreachable through the Engine: twelve paths driven on a real `Engine` over SQLite (seven the
  builder's, five a reviewer's) each land somewhere other than `succeeded` + an unresolved gate.
  `any`/`firstSuccess`/`all` with an unanswered gate branch park `awaiting_gate` with the gate
  still OPEN, because `advance`'s drain re-suspends on `openGates` before `#finish`; the
  budget/fatal floor gives `succeeded` + `cancelled`, because `#finish` appends `cancelOpenGates`
  in the SAME append as `run.completed`; an SLA expiry gives `failed` + `expired`; and
  cancel-then-resume, edit-then-floor, three-gates-then-floor, a subgraph parent after the floor
  and a zero-width fan all miss too. The structural argument is the reviewer's and it is stronger
  than the sweep: exactly ONE writer of `run.completed` and it co-appends `cancelOpenGates`; both
  writers of `gate.timeout` co-append `run.failed` or `gate.decided`; and rewind suppression is a
  SUFFIX range, so it cannot drop the cancel without dropping the completion with it.
  **But it IS reachable through a JOURNAL, which is the verb's only input.** Delete the
  `cancelOpenGates` line from one and the fold gives `succeeded` + an OPEN gate — an ELIGIBLE run
  the exclusion is the only thing dropping. So: a fixture, not a deletion. A 30-run scored corpus
  holding one such journal freezes **29** cases, and mutating the exclusion away turns that one
  test red at 30 vs 29 and nothing else.
  `node --test packages/core/test/cli/suite-freeze.test.ts` → **10 pass / 0 fail** (9 before),
  re-run on `a9214611`.
- ~~**A.22 · `loom score`'s `! N run(s) folded without their graph` line has no end-to-end test.**~~
  CLOSED by `fabc360` — the branch is reachable (a prefix graph compiles to its successor's hash) and
  its message named the wrong hash; `Trajectory.authoredGraphHash` is the repair.

### The self-improvement loop — what it still cannot see

- ~~**A.23 · The `maxTurns` shape is refused; the `policy.budget` one is not.**~~ CLOSED by
  `276e05c` — `11-budget-exercised` refuses a candidate that MOVED a ceiling the replayed corpus
  never crossed. Residual: `GraphPolicy.expansion` is not compared — raising all four 100× promotes.
- **A.24 · `run.compiled` carries node counts, not the spec.** Repro:
  `/usr/bin/grep -anc 'resolutionManifest' packages/core/src/journal/events.ts` → 1, and the payload
  beside it is `{graphHash, nodes, edges, resolutionManifest}`. So a trajectory's S1/S4/S5 depend on a
  file on disk and `isGolden` reads a value the journal cannot reconstruct across a restart — the
  first non-negotiable. Both the peer-fold fix and `loom score` work around it by threading a
  filesystem index into the fold. **Closes when** `run.compiled` carries the spec, or a graph store
  the journal can address does.
- **A.25 · A promotion's subject is a graph and the store is keyed by runId.** Repro:
  `/usr/bin/grep -anc 'evolution.promote' packages/core/src/cli.ts` → 3. The decision rides on
  `operator.command {kind: "evolution.promote"}` appended to the FIRST case's run, with `caseRunIds`
  naming the rest; the live mode makes the same borrow, anchoring on the first selected baseline run.
  Never on a candidate run — hanging the record of a judgement inside the thing being judged is a
  different defect. **Closes when** §D.5 is answered: whether the kernel needs a graph-scoped durable
  fact, and whether that is one event type or a second keyspace.
- **A.26 · The Wilcoxon bound is built; the repeated-runs half is not.** Repro:
  `/usr/bin/grep -anc 'L1-paired-improvement' packages/core/src/evolution/live.ts` → 3.
  `L1-paired-improvement` now requires the t bound AND the Hodges–Lehmann bound to clear 0, and each
  binds where the other does not. What is left is the second strengthening — repeated runs per input,
  so within-input model variance separates from between-graph difference. No statistic computed from
  one run per input can see it, and neither bound removes the SYMMETRY assumption (the signed-rank
  null IS sign symmetry; what it removes is normality). **Closes when** the mode can run an input
  more than once.
- ~~**A.27 · The live cost check divides TOTALS where D10.d says medians.**~~ CLOSED by `50f7c03`,
  corrected by `160985c` — `pairedCostRatio` gates on the UPPER median, an undefined pair unbounded.
  `gateCandidate`'s `3-cost` still divides totals; `EvalReport` has no median to divide.
- ~~**A.28 · A saturated outcome ranks cheapness.**~~ CLOSED by `a0f0cec` — `outcomeSpread` measures
  the saturation and `isGolden` condition 2 refuses the rank on it. What cannot be fixed here stands:
  a workflow whose only signal is human approval cannot rank its own runs.
- **A.29 · A frozen golden case pins the whole work channel verbatim, so a candidate the graph's OWN
  verifier certifies is refused by `1-must-pass` and reported as a 33.3pp regression.** Repro:
  `/usr/bin/grep -anc 'task.started' packages/core/src/journal/events.ts` → 3 — but the three hits
  are now PROSE ABOUT THE DELETION (`fa25cc7`, §B.2), not a declaration. The name is gone from
  `EVENT_TYPES`; the count survived its own subject, which is why the repro is kept and re-read
  rather than kept and trusted.
  **THREE MECHANISMS HAVE BEEN REFUSED**, the third having shipped at `ec1047b`+`ce76bf3` and been
  REVERTED: a `VerifierPin` over WHO verified, WHAT IT SAID and WHAT FED IT, plus two topology
  conditions, was defeated by four games that each reached `promote: true` with the grader
  certifying garbage. The shape of the hole is that the pin reconstructs *what the grader saw* from
  the run's FINAL channel value and the graph's STATIC edge ancestry, **neither of which is a
  statement about time, and the candidate owns the graph**. A fourth structural patch is the wrong
  move. **Closes when** a fold can answer "what did channel C hold when task T read it" — a per-task
  ordering of channel state, which `RunProjection` does not carry.
  **THE OLD CLOSING CONDITION WAS WRONG AND IS CORRECTED HERE.** It read "the journal cannot supply
  [that ordering] while `task.started` has no appender". `task.leased` supplies exactly that seq and
  always did: `#runWaveInner` appends it immediately before the bodies run, carrying `attempt`, with
  its own seq as the fencing token — so what is missing is not a journal EVENT but a projection that
  keys channel state by it. DESIGN item 20 is the second customer for that fact.
  **Re-checked on `26985b2` and unmoved**: `git diff 2309d3a..26985b2 -- packages/core/src/journal/events.ts
  packages/core/src/run/projection.ts` is EMPTY, so the 2026-09-10 wave touched neither the
  vocabulary nor the fold, and the repro still reads 3 prose hits.

### Compensation — what runs, and the gaps that do not

Rollback RUNS: `run/compensation.ts` plans it, `Engine.#compensate` performs it in reverse-seq order
through `#invokeTool`, journaled `compensation.recorded` in three states. What is left:

- **A.30 · What is still uncovered, after the run-failure sites and child runs were wired.** Repro:
  `/usr/bin/grep -anc 'case "compensation": break' packages/core/src/run/engine.ts` → 1 — deliberate,
  because rollback is journal-driven, and the arm carries that argument where a reader reaches it.
  Four things remain open:
  - **`#compensateOne` with an `effect.completed` that carries no `details`** still yields `args = {}`
    (`detailsOf(result)` handed straight to `#invokeTool`, because `effect.completed.result` is typed
    `unknown`). An undo invoked with no arguments is not a refusal. **Closes when** that case is
    `not_attempted` too — one arm, the same fail-closed shape its three neighbours already use.
  - **`JoinNode.onBranchError: "compensate"`**, refused at compile
    (`/usr/bin/grep -anc 'GRAPH008_COMPENSATE_UNIMPLEMENTED' packages/core/src/graph/validate.ts` → 1).
    What it would take is recorded at `#absorbedByJoin`: a BRANCH-PATH scope the planner does not
    have, a trigger in the failing Task's commit rather than at the barrier, and a fourth answer from
    `#absorbedByJoin`, since `boolean` cannot say whether a branch's rollback actually cleaned up.
    **Closes when** those exist; the refusal deletes in the same change.
  - **A DETACHED PARENT whose steps are all blocked journals nothing**, because the `not_attempted`
    rows go through a `RunContext` that cannot be rebuilt without the graph. **Closes** by the move
    that closed the child-run case: `#logFor` writes the rows without a context.
  - **§F.13 at `#finish`** — a task LEASED BY ANOTHER WORKER is still producing while the rollback
    runs, and `ctx.abort` reaches only this process. **Closes when** there is a way to fence a lease
    this engine does not hold.

  Whether an author should ALSO get a graph-level cleanup node on failure is §D.3, not a wiring gap.
- ~~**A.36 · A subgraph's child run is unreachable by URL on the control plane.**~~ CLOSED by
  `d9a8173` — `runIdIn` decodes all NINE run-id captures in `server/http.ts` (the row said three),
  and `run/delivery.ts`'s `callbackFor` encodes, so emitter and route agree.
  `test/server/child-run-by-url.test.ts`.
- ~~**A.37 · The rewind refusal and the rollback plan read two different facts — FOUR shapes, and
  two of them are recoveries the obvious fix would wall off.**~~ CLOSED at `25ed5978`, `62335f93`,
  `c6f24b51`, `d6b23979`, `dee1bb7e`, `300bf222`. Three changes, built in the order the design in
  `docs/handoff-2026-09-15b.md` §Repros gave them, and each of the three moved under review.
  **(1) `retryable` is written where `run/compensation.ts:170` already promised it was written.**
  `#compensateOne` now returns `retryable: true` on its PROCESS- and TRIGGER-dependent arms
  (`unknown_tool`, `unknown_compensation`, "the task is not in the projection", "compensation tool
  X is not registered") and splits the `out.isError` arm, whose approval-floor half never ran the
  undo and is recorded `not_attempted, retryable: true`. **The discriminant is NOT the typed error
  the design specified.** A fresh reviewer proved the typed one forgeable — `#invokeTool` hands
  back whatever `tool.execute` produced after a `postTool` REPLACE filter, and `err`/`CODES` are
  public exports, so a compensation tool that RAN, moved the money and then answered
  `E_HUMAN_APPROVAL_REQUIRED` was re-planned and dispatched a SECOND time (`refunds` `[42]` then
  `[42, 42]`). It is `APPROVAL_FLOOR_REFUSALS`, a module-private `WeakSet` of the gate arm's own
  result objects: unforgeable (identity, and the arm's object never reaches a hook or a tool),
  trap-safe (`has` calls no proxy trap and answers `false` for a non-object, which is the settling
  direction), and holding no durable state, so a restart that hands it back empty switches no guard
  off. The typed `error` on the gate arm was DROPPED as dead. Pinned by `SHAPE 3's FORGERY`.
  **(2) `#uncompensatedIrreversible` is a buffered pass** refusing a settled, in-range,
  hard-to-undo row whose undo ARGUMENTS are not reconstructible, any-occurrence aggregation, so
  `planRewind` refuses too. **(3) A SECOND `if` in `#rewindSerially`**, firing regardless of
  `live`, keyed on `isHardToUndo(s.irreversibility) && s.argsDigest === undefined`.
  **THREE DIVERGENCES FROM THE DESIGN, each measured rather than argued.**
  (a) *"Change 1 needs ZERO existing tests updated" was WRONG* — it was derived by grepping four
  reason strings, which do not cover the SPLIT of arm f, and
  `compensation-fires.test.ts:441` asserts `failed` on exactly shape 3. It now asserts
  `not_attempted` + `retryable: true`; the claim that test is ABOUT (`world.purged` is `[]`) is
  untouched.
  (b) *Change 3 DROPS the design's `s.undo !== undefined` conjunct, which TIGHTENS beyond the
  design.* `planCompensation` strips `undo` from a step it marks `unknown_tool` or
  `unknown_compensation`, so a hard-to-undo effect whose undo tool is missing from THIS registry
  AND whose arguments were never recorded arrived with the identical `steps 1 / dispatch 0 /
  blocked 1` signature and was CROSSED — at the base and at `c6f24b51` both. It is now refused.
  The direction is the allowed one, and the refusal CLEARS: registering the undo accepts the same
  journal, `dispatch 1`, `refunds [42]`, `charges []`. Pinned as `SHAPE 2's SECOND DOOR` and its
  CONTROL.
  (c) *`#rewindSerially`'s message branches on `undo === undefined`*, which the design did not
  ask for and the second review required: `#rewindPlanOf` computes `argsDigest` as
  `step.undo === undefined ? undefined : detailsOf(...)`, so ONE sentence about missing `details`
  was false for the half with no `undo` at all — measured on a `pay.charge.kept` whose
  `effect.completed` is live and carries `details: {row: 42}`. Two clauses now, and the
  `undo === undefined` half names the registry tool to deploy.
  Plus a doc-line correction the design demanded and TWO docstrings it did not: `journal/events.ts`
  and `run/compensation.ts` both said what `retryable` means and neither matched the writers, and
  both now state the one rule — **set when the blocker is a fact about THIS PROCESS or THIS
  TRIGGER; absent when it is a fact about the JOURNAL or the MANIFEST.**
  ```
  $ node --test packages/core/test/run/compensation-refused-then-rewind.test.ts
  ℹ tests 10   ℹ pass 10   ℹ fail 0      # 7 on `a9214611`; the shape titles were renamed
  ```
  **The verb asymmetry is NOT closed** — change 2 sits in `#rewindRefusals` so `planRewind` refuses
  too, change 3 sits in `#rewindSerially`, which `planRewind` does not call, matching the
  pre-existing `unrunnable` arm. It is §A.74.

### Two things that are NOT defects, written down so nobody "fixes" them

- **A.31 · An adapter yielding a `UsageRecord` with an absent or non-finite `costUsd` crashes the run
  inside the journal commit.** Repro:
  `/usr/bin/grep -anc 'non-finite number' packages/core/src/canonical.ts` → 1; a `usage` record with
  no `costUsd` throws a raw `CanonicalizationError` out of `RunLog.commit` — not a `LoomError`, not a
  run failure. **Decided: build nothing.** A `ModelAdapter` is host-realm trusted code and
  `--extension-module` is named on ARGV by the operator, so the trust boundary does not move.
  Coercing a non-finite `costUsd` to 0 is explicitly REFUSED — a guard answering its undecidable case
  with the passing value, here a journaled cost of `0`. **Dissent, recorded:** an unhandled throw
  escaping `#commit` is a worse artifact than a `LoomError` even when equally safe. **Reopens if** an
  adapter is ever loaded from anywhere but argv, or if a real adapter produces this in a real run;
  validation then lands in `run/engine.ts` as a `feat` with a `Kernel-seam:` trailer.
- **A.32 · You cannot fan out from a graph's entry, and it costs a user one node.** A fan-out edge
  needs a source node, so every fan-out graph opens with a no-op `function` node whose only job is to
  exist (`examples/graphs/fan-out-join.json`). Not a correctness bug. **Closes when** somebody
  decides the entry is a node; worth a decision only if a second shape needs it.
- ~~**A.33 · `PolicyEngine.clearCeiling` existed in a kernel file with no caller but a test.**~~
  CLOSED — deleted. No event ever clears a human ceiling, so the method deleted an in-memory entry
  `PolicyEngine.restore` re-installed at the LOWERED posture; `deescalate(scope, "in", …)` is the
  same tightening, refused for a non-human, and folded.
- ~~**A.38 · `truncate`'s control-character sanitisation has no live call path against this plane's
  own listener.**~~ CLOSED at `ba5f8c4`: CONFIRMED, not built — the row's own closing condition was
  already met by a test that PREDATES the row. `packages/core/test/server/http.test.ts:4023`, *"today,
  none of truncate's own call sites can DELIVER those bytes — Node's parser refuses the request
  first"*, drives a raw socket carrying a control byte in a header value against the real
  `ControlPlane` listener and asserts the `400` with no application-level side effect; and
  `ControlPlane`'s one `createServer` call passes a bare callback with no options object, so
  `insecureHTTPParser` is never set. Repro of the provenance:
  `git log --oneline -S "can DELIVER those bytes" -- packages/core/test/server/http.test.ts` → one
  commit, `1b2afcf` (the C1 range was widened later at `36c07e2`), while
  `git log --oneline -S "A.38 · \`truncate\`'s control-character" -- TODO.md` → `12a141b`. The row was
  written by a pass that did not find the pin it was asking for. Both functions' doc comments now
  point at that test instead of restating the claim; the test and the plain `createServer` call were
  left untouched.
- ~~**A.39 · `truncate` (`server/http.ts`) and `clip` (`graph/declared-inputs.ts`) sanitise the same
  character range via two separate literals.**~~ CLOSED at `ba5f8c4`: one `stripControlChars` in
  `graph/declared-inputs.ts`, called by both. Repro, re-run on `bc926f8` —
  `/usr/bin/grep -an 'CONTROL = /\[' packages/core/src/server/http.ts` and
  `/usr/bin/grep -an 'replace(/\[' packages/core/src/graph/declared-inputs.ts` now return NOTHING,
  both exit 1; `/usr/bin/grep -an 'stripControlChars' packages/core/src/server/http.ts packages/core/src/graph/declared-inputs.ts`
  → 6 lines, of which one import + one call in `http.ts` and one definition + one call in
  `declared-inputs.ts`. Exactly one literal survives, at `declared-inputs.ts:122`. `server/http.ts`
  already imported from `graph/`, so the new edge runs the direction the file's dependencies already
  ran.
  **RESIDUE — the decision this row asked for is still OPEN, and is now the whole of what it carries.**
  `stripControlChars` is an INTERNAL export (`declared-inputs.ts` is not re-exported from `index.ts`),
  but `truncate` itself is still in `@caohaotiantian/loom`'s public surface, because `index.ts:64` is
  `export * from "./server/http.ts"` and a `export *` barrel has no narrower way to keep a name
  importable by its own test. `scripts/surface.json` is unchanged at 541 — the name did not move, the
  reason for it did. **Closes when** somebody decides whether `truncate` should be public at all;
  the answer costs either named exports for `server/http.ts`'s barrel entry or a test that reaches
  `truncate` without importing it.

### The product as a stranger meets it — from the 2026-09-09 workflow port

`examples/graphs/triage-failures.json` is one real chore ported against the public surface: a graph,
three `function` bodies and an input directory, no fork and no source change. Eight friction points
came out of it (`docs/workflow-port-2026-09-09.md` §3, F1–F8). **All eight are now closed** — F6 in
the port lane itself, then F2 (§A.40), F3 (§A.43), F4 (§A.41), F8 (§A.42), F5 (§H.6) and F7
(`2309d3a`, one README sentence) in the 2026-09-10 wave, and **F1 (§A.53, `51f4a5f`) in the
2026-09-10-b settlement**. That doc's §0 "Closed since" is the ledger and names a commit for each of
the seven that closed after it was written; its §3 intro says seven because F6 was fixed inside the
port lane and never had a "since". **What the count does not say is the thing worth carrying**:
running the workflow needed no source change, and making it natural needed eight. §A.44 below is on
no friction entry: it is the thing the port ASKED FOR rather than something it tripped over. Every repro here was run from `examples/`
with `bin/loom` on `PATH`.

- ~~**A.40 · `GRAPH010` refuses a channel that is provably branch-local, and the workaround leaks
  into the body.**~~ CLOSED at `77c245a` (the predicate), `468984b` (the example), `f94d812`,
  `bf59862`, `4e297f4` and `ac693d0` (four review rounds, one per entrance to the join barrier).
  `rule010ConcurrentWriters` exempts a channel that never leaves one fan-out branch, proved by
  `branchLocalChannel` — an unlabelled precondition plus **W1-W6**, documented at the function.
  `validate.ts` is `notKernel`, so no seam was owed.
  **THE ROW'S OWN REPRO NO LONGER REPRODUCES.** Re-run on `26985b2` from `examples/` against a
  freshly built binary: `loom compile graphs/triage-failures.json` → `ok`, six deadlines, exit 0,
  with `raw` declared the natural way as `{"type": "string", "reduce": "replace"}` and
  `triage-classify.js` reading a string. Precisely: the `join("\n")` that undid the array is gone and
  its comment was REWRITTEN IN PLACE to explain the new state (`:23-27`, *"It used to be
  `append_ordered` and this body carried a `join("\n")` to undo it"*); the file still contains three
  `join("` calls for unrelated reasons, so grepping for the string is not the check — reading the
  channel declaration is.
  **HOW IT WAS ACTUALLY GOT RIGHT, because the method is the transferable part.** Three builder-side
  review rounds each found one more entrance to the barrier and each patched it; a FRESH AGENT TOLD
  TO REFUTE broke `4e297f4` with a running repro the three had missed — a plain `seq` edge into the
  join node mints the join task through `#activate` with no quiescence test, and on the shipped
  example's own shape branch b read branch d's value. `ac693d0` then stopped enumerating engine
  methods and re-keyed W6 on the join's INBOUND EDGE LIST — exactly one `kind:"join"` edge per
  declared member and nothing else — which is a property of the GRAPH the validator can see, rather
  than a property of the ENGINE it cannot. A fifth reviewer then FAILED to break it — `dc73059`'s
  body: **2,188 driven perturbations across two sweeps, 660 of them exempted-and-run, 273 on the
  fall-through path every leak so far has used, and zero cross-branch reads**, plus a human-gate
  pause and a full restart against the same store with root state holding the pre-fan-out value
  throughout. What it DID find was three places where the prose claimed more than the code does, and
  `dc73059` is those three corrections. Tests: `test/graph/branch-local-channel.test.ts` (3 accepts,
  25 refusals, 2 controls) and `test/run/branch-local-replace.test.ts`.
  **What it does NOT cover is §A.48, and the `seq`-edge entrance it exposed is §A.47** — a real,
  pre-existing engine defect that W6 refuses to compile the `replace` subset of and leaves running
  everywhere else.
  THE ROW AS IT STOOD: *(F2 — the lane's judgement is that this is the one worth
  building.)* File:
  `packages/core/src/graph/validate.ts`, `rule010ConcurrentWriters`. Repro, with `raw` declared the
  natural way as `{"type": "string", "reduce": "replace"}`:
  ```
  $ loom compile graphs/triage-failures.json
  ✗ triage-failures.json: GRAPH010_CONCURRENT_WRITE: node "read" runs up to 24 times in parallel and writes "raw", whose reducer `replace` is not multi-writer safe
     fix: change channel "raw" to reduce: append_ordered (or another commutative reducer)
  ```
  (`24`, re-run on `bc926f8`. `docs/workflow-port-2026-09-09.md` §3 F2 pastes `8`, which was the
  `fan` edge's `maxWidth` before `77da881` raised it — the message tracks the graph, and the doc's
  paste is one edit stale.)
  The rule counts `read`'s parallel width and stops, but the runtime IS branch-scoped and a branch
  really does see only its own contribution — measured by swapping `triage-classify.js` for a probe
  reporting `raw.length`, which prints `raw is an array of 1` three times, one per branch. The cost
  is paid by every author of a multi-node fan-out branch: the shipped graph carries
  `{"type": "array", "reduce": "append_ordered"}` and `triage-classify.js` carries a `join("\n")`
  and a five-line comment explaining a one-element array. **Closes when** `rule010ConcurrentWriters`
  exempts a channel whose every reader is inside the same fan-out subtree as its writer. That is a
  real dataflow analysis and not a message, and *"refusing is always allowed; loosening never is"*
  means it needs its own adversarial review rather than a drive-by.
- ~~**A.41 · `loom run` prints the human gate hint on STDOUT, after the JSON, so `| jq` breaks on
  exactly the gate path.**~~ CLOSED at `175cdb3`: the gate hint goes to **stderr**, beside the run-id
  hint that already did, so `loom run … 2>/dev/null | jq .status` parses on the gate path too.
  `examples-triage.test.ts`'s `summary()` no longer slices stdout — it parses the whole of it, which
  makes the helper an assertion that nothing else is printed there;
  `test/cli/gate-hint-stream.test.ts` pins the stream.
  THE ROW AS IT STOOD: *(F4.)* File: `packages/core/src/cli.ts`. Repro:
  ```
  $ loom run graphs/triage-failures.json --input '{"pattern":"reports/*.txt"}' 2>/dev/null | tail -3
    }
  }
  gate gate_01M22PTJ06F361S41NGBJDEW2H on node approve — loom approve 01M22PTHZ83C28BY1HG6E7GWA1 gate_01M22PTJ06F361S41NGBJDEW2H --as YOUR_ID
  ```
  The product already knows the rule — the `run … — inspect it with:` hint goes to **stderr** — so
  this is one line on the wrong stream, and it makes `loom run … | jq .status` succeed for a run that
  completes and fail for one that parks on a gate, which is precisely the case a script needs to
  branch on. `packages/core/test/examples-triage.test.ts` carries a `summary()` helper whose only job
  is to cut that line off. **Closes when** the gate hint moves to stderr, with a test that pins stdout
  as parseable JSON on the `awaiting_gate` path.
- ~~**A.42 · A function body's DELIBERATE refusal is reported as `E_INTERNAL`, the same code a
  genuine bug in the body produces.**~~ CLOSED at `f7f74d5`, with a `Kernel-seam:` trailer. A body
  returns `{refuse: {reason}}` and the ENGINE raises `validation`/`E_FUNCTION_REFUSED` on its
  behalf — never retried, whatever the node's `retry` policy says, because `validation` is not in
  `RETRYABLE` and `#retryDecision` returns at `engine.ts:9982` before it reads a policy. A REFUSAL
  IS A RETURN AND NOT A THROW for the reason `{retry}` already was: `isLoomError` is an `instanceof`
  and a guest object can never satisfy it, so the raise has to happen host-side. A throw stays
  `E_INTERNAL`, which is now the code for a BUG rather than the code for both.
  `OUTCOME_KEYS = ["writes","take","retry","refuse"]` (`engine.ts:1195`) is the whole vocabulary,
  and both callers are covered — `#runFunction` and `#runEvaluator`'s assertion arm.
  `test/run/function-refusal.test.ts`.
  THE ROW AS IT STOOD: *(F8 — `packages/core/src/run/engine.ts`, KERNEL, so this one cannot be
  fixed from an extension at all, which is the point of recording it.)* Repro:
  ```
  $ loom run graphs/triage-failures.json --input '{"pattern":"nope/*.txt"}'
    "error": { "class": "internal", "code": "E_INTERNAL",
      "message": "Error: no test-output files matched — check the --input pattern, …" }
  ```
  `isLoomError` is an `instanceof` against the host class and a guest object can never satisfy it, so
  every throw out of the `vm` is `E_INTERNAL`. A body's `return` channel already carries one
  structured verdict (`{retry: {reason}}`); a REFUSAL has no equivalent, so an author who wants to
  fail on purpose can only throw. Related to README's *`retry` on a function or evaluator node* row
  but not the same one — that is about retryability, this is about a refusal. **Closes when** a body
  can return a structured refusal that reaches a caller as its own class, which is a kernel change
  and a `Kernel-seam:` trailer.
- ~~**A.43 · `loom gates` shows a `contentDigest`, not the thing being approved.**~~ CLOSED at
  `da86076`: `loom gates <runId>` carries a `reads` field — the gate node's declared channels THAT
  HAVE A VALUE (built from `view.visible`, so an unwritten one is not a key), recomputed from the
  graph the journal's hash names. **Swept by the graph's own classification, which a reviewer had to
  force:** the first version printed the channels in the clear on the argument that `loom run` and
  `loom approve` already print `p.outputs` — but `outputs` is an author-chosen PUBLISHED subset while
  this is `observedChannels`, which includes INPUTS, so it would have been the first CLI path to
  print a channel a graph declared `secret_ref`, in the one place a classification exists to prevent
  it. History was rebuilt, so no commit on `loom` ever printed one. The digest stays beside it as the
  BINDING `loom approve` checks the graph against. `test/cli/gates-show-content.test.ts`.
  THE ROW AS IT STOOD: *(F3.)* File: `packages/core/src/cli.ts`, the `gates` verb. Repro: `loom gates <runId>` prints
  `{gateId, nodeId, policyRef, contentDigest, approvers, …}` and no channel value, while the gate
  node declares `reads: ["report"]` and the run has computed it. `loom trace` shows the span tree
  without channel values and `loom approve` prints the report only AFTER the decision, so on the
  documented CLI path a human approves a hash. It is not missing from the PRODUCT — the control
  plane has it (`curl -s http://127.0.0.1:8791/runs/$RUN` → `channels` includes `report`) and the
  console renders it — but README's gate walkthrough never mentions `loom serve`. **And the digest is
  not a stand-in for the content**: three runs over byte-identical input produced three different
  `contentDigest` values, so it is a BINDING (what the approver was shown, which `loom approve` later
  checks the graph against) rather than a summary anybody could recognise. **Closes when** `loom
  gates` prints the channels the gate node reads.
- ~~**A.44 · A `function` body cannot read its own node's declared shape, so a bound is spelled
  twice.**~~ CLOSED at `c2360be` (the mechanism, with a `Kernel-seam:` trailer) and `b181b55` (the
  example consuming it). `ctx.node` is the node as the graph declared it, frozen:
  `{id, type, reads, writes, out: [{id, kind, over?, as?, maxWidth?, maxIterations?}]}`. **`timeoutMs`
  is deliberately NOT a member** — it is not the bound a body runs under, since `REBIND_DEADLINE`
  recompiles the realm at another number, so publishing it would have handed a body a figure it
  could not act on. Exported as `FunctionNodeShape` (surface 541 → 542). The duplication the row was
  named for is gone rather than pinned: `/usr/bin/grep -ac SHARD_CEILING
  examples/resources/function/triage-plan.js` → **0**, and the body takes the TIGHTEST `maxWidth`
  over all matching fan-outs on its node. `test/run/function-node-shape.test.ts`.
  THE ROW AS IT STOOD, repro: `SHARD_CEILING` in `examples/resources/function/triage-plan.js` and
  `maxWidth` on the `fan` edge in `examples/graphs/triage-failures.json` are the same number, and
  `packages/core/test/examples-triage.test.ts` pins them together by reading `maxWidth` out of the
  graph — a patch on a seam rather than the seam. A body is handed channel values and nothing about
  the node that called it: no `ctx.node`, no `ctx.graph`. It matters because a fan-out CLAMPS
  silently, so a body that wants to REFUSE above the width (rather than drop shards in silence, which
  is the defect the port shipped and fixed) has to hard-code the number the graph already declares.
  **Closes when** a body's `ctx` carries its node's declared shape — a kernel change, and one that has
  to decide what a body may see without letting it decide anything.

### Opened by the 2026-09-10 wave

Each row below was found while building or reviewing that wave and is NOT a regression it
introduced unless the row says so. Repros run from the repository root unless they say `examples/`.

- ~~**A.46 · A rewind reaches the live console as an ordinary event with no arm, so the console keeps
  showing the states the rewind suppressed.**~~ File: `packages/core/src/server/console.ts`. Repro:
  `/usr/bin/grep -anc checkpoint packages/core/src/server/console.ts` → **0**. A rewind never edits
  history — it appends `checkpoint.restored{mode:"rewind"}`, and that marker SUPPRESSES a range of
  already-folded events, so what earlier events mean changes retroactively (`run/projection.ts:483`).
  Server-side that is handled: `RunFolder` detects the marker, goes `stale`, and pays one full
  re-fold. The console's `applyEvent` is a second, independent incremental fold in the page, and it
  has arms for SEVEN `task.*` events, `gate.raised`, `gate.decided`, `state.reduced`,
  `run.suspended` and `run.resumed` — and none for `checkpoint.restored`. So the tasks a rewind undid keep whatever
  state they had, and the channel values it rolled back stay in `current.channels`, until something
  reloads the page. Nothing forces that reload: `console.ts:401` re-fetches only on `snapshot`,
  `gate.raised` and `gate.decided`, and `server/http.ts`'s live tail special-cases only
  `run.completed`, `run.failed` and `run.cancelled` (`:3063`, `:4782`). This is the SAME SHAPE as
  §A.45 one layer up — two folds of one journal, one of which does not know a word — and it is NOT
  fail-safe: a rewind exists to undo something, and the screen goes on showing it done.
  **Closes when** the console's fold answers `checkpoint.restored` the way the server's does — the
  honest answer is probably to discard the incremental state and re-request the snapshot, since the
  marker's whole meaning is "what you folded is wrong" — with a test that rewinds a run and compares
  the console's state to `GET /runs/:id`'s, the way §A.45's does for a skip.
  **CLOSED at `74c930c`.** `applyEvent` gained the arm the server already had: on
  `checkpoint.restored` with `mode: "rewind"` it does not try to un-fold anything — it discards the
  incremental state and calls `resync()`, a `GET /runs/:id` whose answer goes through
  `applySnapshot`, which is the same move `RunFolder` makes when it goes `stale`. Repro now:
  `/usr/bin/grep -anc checkpoint packages/core/src/server/console.ts` → **2** (`:510` is the arm,
  `:524` the paragraph saying what it does). `mode: "fork"` is DELIBERATELY not handled and `:517`
  says so: a fork suppresses nothing in the run being watched. **`server/http.ts` needed no change**
  — its live tail already forwards every event, so the special-casing the row named was never the
  gap. Pinned in `test/server/console.test.ts`.

- ~~**A.47 · A `seq` edge into a `join` node mints the barrier's task with no quiescence test, and the
  join then commits TWICE.**~~ File: `packages/core/src/run/engine.ts`, **KERNEL**. `#maybeFireJoin`
  is the only one of the three paths to a join task that tests anything: it refuses when
  `p.tasks[joinTaskId] !== undefined` and computes `quiescent = !handingOff && !stillLive`.
  `#activate`'s generic arm (`:10611-10620`) mints `task.ready` for `e.to` from the edge alone — no
  node type, no `p.tasks` lookup, no barrier state — and for a root-coordinate task the id it
  computes is byte-identical to `#maybeFireJoin`'s. `#fireEmptyJoin` (`:10789-10805`) checks
  membership and duplicates WITHIN ITS OWN event array, and nothing else.
  **Reproduced**, on a graph with only commutative channels, so `branchLocalChannel` and GRAPH010 are
  never consulted: `start --fanout(4)--> A --join--> J --seq--> done`, plus a `seq` chain
  `start → note0 → … → noteN → J`.
  ```
  bh=1 nh=0 par=16 status=succeeded hops=5 seenLen=4  seen=[a,b,c,d]
  bh=1 nh=3 par=16 status=succeeded hops=6 seenLen=8  seen=[a,b,c,d,a,b,c,d]
  ```
  (`bh` = nodes in the branch, `nh` = hops on the `seq` path into `J`.) The join Task ran two full
  `task.ready/leased/policy.decided/committed/state.reduced` cycles and `#foldJoin` folded the same
  four contributions each time — four branches, eight entries — and `done` ran twice. **The run
  reports `succeeded`.** The compile is clean in every row.
  **IT ALSO FIRES EARLY AND LOSES WORK, which is the worse half.** Same sweep, same graph shape:
  `bh=2 nh=1 par=16` → `seenLen=4` against a baseline of 8, so half the run's contributions were
  discarded; `bh=3 nh=1 par=16` → 4 against 12; `bh=1 nh=1 par=2` → 3 against 4. Every one reports
  `succeeded`. Which of double-fold, exact and truncated you get depends on `maxParallelism` and on
  the hop counts of the two paths. **The worst row is the shortest graph**: a DIRECT
  `start --seq--> J` beside the fan-out, at `par=16`, fires the barrier before any branch has
  committed and the channel is never written at all — and the run still reports `succeeded`. A
  second reviewer reproduced that row independently on the same harness.
  **THE ENGINE'S OWN VALIDATOR ALREADY WRITES THIS DOWN**, which is why the row is about the engine
  and not about the discovery: `graph/validate.ts:2600-2637` enumerates all seven paths to a join
  Task, labels `#activate`'s generic arm *"the fourth entrance, and the reason this clause is keyed
  where it is"*, and names `#maybeFireJoin` as *"the only one that tests quiescence"*. W6 exists
  because of this defect. What has no row until now is the defect itself.
  **PRE-EXISTING and independent of §A.40.** `git show 77c245a --stat` touches `validate.ts` and one
  test and no engine file, and the same harness run against `2309d3a` (extracted with `git archive`,
  no checkout) prints the identical `seenLen=8` row.
  **Closes when** the generic arm of `#activate` routes a non-`join` edge whose target is a `join`
  node through `#maybeFireJoin`. That half was patched in a scratch copy and every row of the sweep
  then equalled the no-`seq`-edge baseline at every parallelism and hop count. **`#fireEmptyJoin`
  must NOT be routed the same way and that is the trap**: patched, the empty fan-out strands
  (`fired=false`, `status=failed`, zero hops) because the planner's own `take` still holds the
  `fanout` edge whose `to` is a declared member, so `handingOff` is true and `quiescent` never
  becomes true. An empty fan needs `#maybeFireJoin` to be told the fan planned zero branches; it is
  not a call-site swap.
  **AND W6's inbound-edge clause does NOT become redundant** — the tempting corollary, and it is
  wrong. W6 uniquely covers two entrances (a non-`join` inbound edge, and a second fan-out's `join`
  edge from a non-member); the other two entrances it is credited with are closed by SEPARATE lines
  (`mode !== "all"` at `validate.ts:2681`, membership at `:2684-2686`). More to the point, deleting
  it because the engine now routes correctly would re-key a compile-time guard on WHICH ENGINE
  METHODS TEST QUIESCENCE — the enumeration shape that was tried and defeated three times, and that
  `ac693d0` deliberately replaced. Fix the engine; keep W6.
  **CLOSED at `84338b3`** (the fix — a `fix:` on a kernel file, which owes no seam trailer),
  `52d6c99` and `3d8dabb` (the prose), `5464801` and `cc964f7` (the pins). `#activate`'s generic arm
  now routes an edge whose target is a `join` node through `#maybeFireJoin` instead of minting
  `task.ready` from the edge alone, so every entrance to the barrier that is not a back-edge goes
  through the one method that tests quiescence. **`loop` is excluded on purpose** and
  `run/engine.ts:10668` says why, in its own words: `loop` "mints at `iteration + 1`, which is a
  Task the barrier never owns, so folding it into `#maybeFireJoin` would turn a back-edge into a
  SILENT NO-OP rather than closing a hole" — routing it would have deleted the loop's second pass
  outright. **The trap the row named held**: `#fireEmptyJoin` is
  NOT routed the same way (`:10679-10685`), for exactly the reason the row predicted — the planner's
  `take` still holds the `fanout` edge, so `handingOff` stays true and `quiescent` never becomes
  true. Repro now: `node --test packages/core/test/run/join-seq-entrance.test.ts` → **8 pass / 0
  fail**; six of the eight fail against `c98a108`. `pushJoin` (`:10587`) is the
  one-mint-per-barrier-per-wave dedupe and `cc964f7` pins it, correcting the shape its comment named.
  W6 was kept, as the row said it must be. Whether the COMPILER should also refuse a non-`join`
  inbound edge on a join node is now §D.8 — a tightening, not this defect.

- **A.48 · What §A.40's exemption does NOT cover, in one row so the next author does not rediscover
  it.** File: `packages/core/src/graph/validate.ts`, `branchLocalChannel`. The predicate is an
  unlabelled precondition plus **W1-W6** (there is no W0:
  `/usr/bin/grep -an 'W0' packages/core/src/graph/validate.ts` → no hits). Five separate residues,
  every one CONFIRMED by running the validator, and all of them REFUSALS — this row is about what is
  refused for want of an analysis, not about anything that is wrongly accepted:
  (a) **The exemption covers only the fan-out's OWN target.** `:2506`
  `if (fan === undefined || fan.kind !== "fanout" || fan.to !== writer) return false;`, and the code
  says why in its own words at `:2503-2505`: *"A writer partway down the branch is therefore refused
  for want of a DOMINANCE computation, not because such a graph is unsafe."* `idx.ancestors` answers
  "there EXISTS a path", not "EVERY path", and `fan.to === writer` is the stand-in that makes the two
  coincide. Widening it to real dominance is the row.
  (b) **A read-modify-write is refused**, by W5: the writer that also declares a read is not skipped
  at `:2714`, then fails `idx.ancestors.get(n.id)?.has(writer)` because a node is not its own
  ancestor. Driven: the accepted baseline plus `read.reads` gaining `"raw"` and nothing else →
  `GRAPH010_CONCURRENT_WRITE`.
  (c) **`namedElsewhere` re-serialises the spec per pair.** `:2434-2452` rebuilds the spec object,
  `JSON.stringify`s it and constructs a fresh `RegExp`, once per `(non-commutative channel, parallel
  writer)` pair. It is deliberately LAST (`:2719`), so only near-accepted pairs pay. Measured on ONE
  machine and MACHINE-DEPENDENT — carry the SHAPE, not the milliseconds — K exempt channels against
  PAD unrelated nodes: `K=100 PAD=200` 10.2 ms vs `K=1` 3.4 ms; `K=100 PAD=1600` 125.6 ms vs
  78.3 ms. The shape is what matters and it is stable across all three pairs: the added cost is
  **linear in spec bytes × exempted pairs**, at roughly 0.2 ms per pair per 100 KB here. `compileMutation` re-runs the whole rule set, so the mutation path pays it
  too.
  (d) **A runtime `graph:mutate` adding a node behind the writer refuses with advice the model
  cannot take.** Driven: a mutation adding one node `hop` behind `classify` — inside the branch,
  proposer-dominated, a legal shape — makes `subtree` three while `gather.branches` still declares
  two, so W6's membership clause `declared.size !== subtree.size` fails and the merged spec is
  refused `GRAPH010_CONCURRENT_WRITE … fix: change channel "raw" to reduce: append_ordered`. A
  mutation's whole surface is `addNodes`/`addEdges`/`reason` and `graph/mutate.ts` is **additive
  only** — *"It may not change or remove an existing node, edge, channel, or policy field"* — so the
  fix names the one edit the verb cannot perform. Amending the join's `branches` instead is refused
  by MUT001, which forbids redefining an existing node. Already recorded as residue in `dc73059`'s
  own body; this row is where it becomes something somebody works.
  (e) **`namedElsewhere` is fragile to a `description` mentioning the channel** — and that is
  DELIBERATE and already pinned, not latent: `test/graph/branch-local-channel.test.ts:164`, *"ACCEPT
  is fragile on purpose: the DESCRIPTION mentioning the channel refuses"*. Its docstring
  (`:2415-2418`) names the failure mode as over-reporting, which refuses, *"which is the direction a
  loosening guard is allowed to be wrong in"*. It costs an author an inexplicable refusal and can
  never buy a wrong accept.
  (f) **Any node in the branch that carries `retry`, or is an `agent` or an `evaluator`, refuses the
  whole exemption** — W4, `:2542` `if (n.retry !== undefined || n.type === "agent" || n.type ===
  "evaluator") return false;`, whose own comment says it is refused *"because this analysis does not
  track which attempt commits"*: refused for want of an analysis, the same category as (a). Driven,
  and it is how somebody will actually meet it: adding a `retry` policy to `classify` in the SHIPPED
  graph flips `loom compile` from `ok` to `GRAPH010_CONCURRENT_WRITE` on node `read` — a diagnostic
  about a different node, a different channel and a reducer, with nothing in it about `retry`. Pinned
  (`branch-local-channel.test.ts`, *"REFUSE: a `retry` on a node in the branch"*).
  **A correction to how this residue was first written down.** The shape
  `fan → a; a → x(writes); a → r; x → r` was offered as W2 over-refusing. W2 does refuse it — but
  the refusal is CORRECT there, because `r` has a second inbound edge from `a` that skips `x` and
  `#activate` emits one `task.ready` per inbound edge, so the read really can precede the write. The
  honest statement of the over-refusal is (a) alone: the safe DEEPER-WRITER shapes are refused along
  with the unsafe ones, because reachability cannot tell them apart.
  **Closes when** (a) is replaced by a dominance computation over the subtree — at which point (b)
  and the mutation half of (d) are worth re-asking, and (c)'s cost moves with whatever replaces the
  census. (e) closes never on purpose.

- ~~**A.49 · `retry.onlyIf: ["E_FUNCTION_REFUSED"]` compiles clean and can never fire.**~~ Files:
  `packages/core/src/graph/validate.ts` (`checkCodes`, `:1202`) and `packages/core/src/run/engine.ts`
  (`#retryDecision`). Repro, by reading the two in order:
  ```
  $ /usr/bin/grep -an 'if (!error.retryable) return undefined;' packages/core/src/run/engine.ts
  9982:    if (!error.retryable) return undefined;
  $ /usr/bin/grep -an 'policy.onlyIf' packages/core/src/run/engine.ts
  10023:    if (policy.onlyIf !== undefined && !policy.onlyIf.includes(error.code)) return undefined;
  $ /usr/bin/grep -an 'const RETRYABLE' packages/core/src/errors.ts
  38:const RETRYABLE: ReadonlySet<ErrorClass> = new Set<ErrorClass>(["exhausted", "unavailable", "timeout"]);
  ```
  `E_FUNCTION_REFUSED` is class `validation` (`engine.ts:1336`, `err.validation(...)`), so
  `error.retryable` is false and `#retryDecision` returns 41 lines before `onlyIf` is read.
  **And it is a RUN, not only a reading.** The shipped graph with
  `retry: {maxAttempts: 2, onlyIf: ["E_FUNCTION_REFUSED"]}` added to `collate` — a node OUTSIDE the
  fan-out branch, because putting it on `classify` trips §A.48's W4 instead, which is its own finding:
  ```
  $ loom compile out/zz-onlyif.json
  ok
    retry collate (declared): maxAttempts=2 backoff=exponential initialMs=500 maxMs=30000 onlyIf=E_FUNCTION_REFUSED
  exit 0
  ```
  The compiler ECHOES the dead filter back at the author, which is a sharper statement of the harm
  than the greps are. The control proves `checkCodes` is membership-only and nothing more:
  ```
  $ loom compile out/zz-onlyif-bad.json     # onlyIf: ["E_NOT_A_CODE"]
  ✗ GRAPH003_UNKNOWN_ERROR_CODE: node "collate".retry.onlyIf names error code "E_NOT_A_CODE",
    which no error in this system carries — it would never match
     fix: did you mean one of: E_NOT_AUTHORIZED
  exit 1
  ```
  `checkCodes` validates `retry.onlyIf` members against `CODES` and nothing else, so every
  non-retryable code is accepted into a filter that can never match. **NAMING THE SET**: `ErrorClass`
  has nine members (`errors.ts:21-36`) and `RETRYABLE` holds three (`exhausted`, `unavailable`,
  `timeout`), so the six that can never fire an `onlyIf` are `validation`, `policy`, `not_found`,
  `conflict`, `cancelled` and `internal`. **There is no `permission` class** — the one that means
  "denied by policy" is `policy`, and an earlier draft of this row invented the other name. It is FAIL-CLOSED (the effect is "no retry", which
  is what a refusal wants) and that is why it is a row and not a fix; what it costs is an author who
  writes it, sees it compile, and concludes the runtime honours it. It is the mirror of the trap
  `#errorEdges` already documents at `engine.ts:10530`, where `codes` was declared and unread.
  **Closes when** `checkCodes` refuses a `retry.onlyIf` member whose class is outside `RETRYABLE` —
  a compile-time check with the same closed set behind it, and one that must NOT be extended to
  `EdgeSpec.codes`, where a non-retryable code is exactly what an error edge is for.
  **CLOSED at `d9dc26c`, with three `RAISED_CLASS` entries corrected by `cbfdeb5`. THE ROW'S
  PREMISE WAS PARTLY FALSE and the fix is better for it.** The row assumed `class` is a function of
  `code`; it is not — class is chosen at the RAISE SITE, and a scan of every `err.<class>(CODE)`,
  `new LoomError("<class>", CODE)` and `{class, code}` record literal under `packages/core/src`
  finds codes raised under more than one class, and five whose `errors.ts` section comment
  disagrees with its raise sites about retryability itself. **The table now records NINE
  multi-class codes** — `E_CONFIG_INVALID`, `E_HUMAN_APPROVAL_REQUIRED`, `E_GATE_DELIVERY_FAILED`,
  `E_RESOURCE_NOT_FOUND`, `E_TOOL_NOT_FOUND`, `E_RESTORE_ILLEGAL`, `E_GRAPH_MISMATCH`,
  `E_INTERNAL`, `E_SUBGRAPH_FAILED` — counted off `RAISED_CLASS` itself; the test file's own header
  still says TEN, from the raise-site scan that produced the table, and the two have not been
  reconciled. Carry the table's number: it is the one the rule reads. So the refusal is keyed on
  `RAISED_CLASS` (`graph/validate.ts:1158`), a table of OBSERVED raise classes, not on the section
  headings: it fires only where a code's class set is non-empty and holds no retryable member, and
  an EMPTY set ACCEPTS — refusing on a class nothing pins would be the same false refusal the
  section-comment table is rejected for. The new diagnostic is `GRAPH003_UNRETRYABLE_ONLY_IF`
  (`:1397`). Its drift guard is `tsc`, not a grep: `RAISED_CLASS` is `Record<Code, readonly
  ErrorClass[]>`, so a code added to `errors.ts` is a type error until somebody classifies it.
  Census on the merged tree — compile one graph per declared code and count the refusals:
  **45 of the 60 declared codes are now refused, 15 accepted.** (The lane reported 43; `cbfdeb5`
  rewrote three entries after that measurement, which is why this file counts rather than copies.)
  Repro: `node --test packages/core/test/graph/retry-onlyif-retryable.test.ts` → **9 pass / 0
  fail**. `EdgeSpec.codes` is untouched, as the row required. Residue is §A.59.

- ~~**A.50 · A fan-out `maxWidth` that is a JSON STRING compiles clean, and a non-numeric one switches
  `GRAPH010` off and drops every branch in silence.**~~ File:
  `packages/core/src/graph/validate.ts`, `rule007Fanout`. Repro, from `examples/` with `bin/loom` on
  `PATH` (probe graphs written into the gitignored `out/`):
  ```
  $ sed 's/"maxWidth": 24/"maxWidth": "24"/'     graphs/triage-failures.json > out/zz-str.json
  $ sed 's/"maxWidth": 24/"maxWidth": "banana"/' graphs/triage-failures.json > out/zz-fan.json
  $ loom compile out/zz-str.json   → ok, exit 0
  $ loom compile out/zz-fan.json   → ok, exit 0
  ```
  `:1992` `if (e.maxWidth === undefined)` is a PRESENCE test, and `"banana"` is not `undefined`.
  `:2002` `if (e.maxWidth > expansion.maxFanout)` is a bare `>` on unvalidated data: `"24" > 24` is
  `false` by coercion and `"banana" > 24` is `false` by `NaN`. Neither refuses. `graph/spec.ts:929`'s
  `EDGE_FIELDS` is a NAME allowlist, so nothing type-checks the parse either.
  **The second half is the serious one.** `:521` `[...parent, e.maxWidth ?? 1]` and `:561`
  `parentWidth * (e.maxWidth ?? 1)` feed the concurrency analysis, so a `NaN` width turns GRAPH010
  OFF. On three graphs identical but for that field: `24` → `GRAPH010_CONCURRENT_WRITE` on node
  `read`; `"24"` → the same message, coerced; `"banana"` → **ok**. And at run time
  `run/engine.ts:10573` is `items.slice(0, e.maxWidth ?? 0)`: `slice(0, "24")` coerces to 24
  (accidentally right), `slice(0, "banana")` is `slice(0, NaN)` → **zero branches, no diagnostic** —
  a run that ends `E_OUTPUT_MISSING` having dropped every shard without a word. On the SHIPPED
  example the damage is masked by `examples/resources/function/triage-plan.js`, which refuses
  `E_FUNCTION_REFUSED: … 0 state a numeric maxWidth` — a guard in a userland body, not in the
  kernel, which is exactly the wrong place for it. **The examples lane already knew the first half
  and pinned the workaround** (`test/examples-triage.test.ts:495`, *"a fan-out width that is not a
  NUMBER is unreadable, not skipped"*, whose own comment says `GRAPH007` asks whether the field is
  there and not what type it is); what is new here is that a NaN width also turns GRAPH010 off and
  drops every branch on a graph with no such body in it.
  **Closes when** `rule007Fanout` refuses a `maxWidth` that is not a positive integer, in the same
  arm that refuses a missing one. `maxIterations` on a `loop` edge takes the same shape and should be
  checked with it.
  **CLOSED at `a58550d`** (the rule), `ab18b14` (hostile values) and `4864df9` (the other operand).
  `rule007Fanout` refuses a `maxWidth` that is not a positive integer with
  `GRAPH007_BAD_MAX_WIDTH` (`validate.ts:2288`), whose `fix:` names the spelling — *"a whole number
  between 1 and N (unquoted: 24, not \"24\")"*. The sibling was done with it, as the row asked:
  `maxIterations` on a `loop` edge is `GRAPH006_BAD_MAX_ITERATIONS` (`:2158`). **And a reviewer
  found the other operand**: `expansion.maxFanout` is the OTHER side of the very comparison being
  fixed, and `"maxFanout": "banana"` switched its own ceiling off — now typed too (`4864df9`,
  disclosed at `:635-642`). `ab18b14` is the hostile half: a bigint, a symbol, a circular object
  and a value whose `toJSON` throws are REFUSED rather than crashing the compiler, which is what
  they did before. Repro: `node --test packages/core/test/graph/fanout-width-type.test.ts` → **12
  pass / 0 fail**. One knock-on, recorded because it changed sides:
  `test/examples-triage.test.ts:495` was *"a fan-out width that is not a NUMBER is unreadable, not
  skipped"* and is now *"…is refused BY THE COMPILER, before any body runs"* — the case never
  reaches the userland body, which is where the row said the guard does not belong. **The test was
  RENAMED by the fix**, so the old string finds nothing. **Residue is §A.59**, and the load-bearing member of it is that the
  runtime path is still reachable: `Engine.submit`/`attach` take a `RunGraph` directly and
  `#assertBound` does not re-check widths, so an embedder who builds one without compiling keeps
  the old `slice(0, NaN)`.

- ~~**A.51 · `loom gates`'s new `reads` field shows a payload HANDLE where the console shows text, and
  bounds nothing.**~~ File: `packages/core/src/cli.ts`. Both halves are DISCLOSED in the source that
  shipped them (`da86076`), and are here because a disclosure in a docstring is not a row anybody
  works.
  (a) **Handle, not text.** `:5265` builds `reads` from `view.get(c)` over the raw `RunProjection`,
  where `run/projection.ts:1362`'s `withHandles()` has already substituted `payloadHandle(ref)`. The
  console's copy resolves first — `run/engine.ts:6048`, *"HERE, AND ONLY HERE, is where a handle
  becomes a value … the gate payload a human reads"*. `cli.ts:5136-5141` states the divergence
  itself: *"Over `EXTERNALISE_ABOVE_BYTES` the console operator sees text and this operator sees a
  handle."* `EXTERNALISE_ABOVE_BYTES = 64 * 1024` (`journal/payloads.ts:86`). Driven: a 108,000-byte
  `fs.read` into an eligible `replace` channel read by a `human_gate` prints
  `reads.big -> {'$payload': {'digest': 'sha256:03bd38dc…', 'bytes': 108002}}`. So the CLI door
  regains, in a different currency, exactly what §A.43 was opened to remove: an operator approving a
  hash.
  (b) **No size bound.** The same value declared as an OUTPUT — hence ineligible for externalisation,
  so it stays inline — prints all 108,000 characters. `cli.ts:5174-5180` names the worst case rather
  than capping it: *"`reads` repeats per gate, so a wide fan-out parked on a gate over a large
  channel prints that channel once per branch."*
  **Closes when** the CLI resolves a handle the way the gate payload does — which is the half that
  makes the two doors agree — and states a bound for the inline case that is not "whatever the
  channel holds". The two are separable; (a) is the one that costs an operator their judgement.
  **CLOSED at `5d2053b`, with `ccf2a32` and `b96d887` fixing seven reviewer findings on it — two of
  them defects the lane itself shipped.** (a) is resolved: `loom gates` resolves handles the way the
  gate payload does, so the two doors show an operator the same thing. (b) was a DECISION rather
  than a lookup, and it is recorded here because nobody was asked: **a per-value cap, defaulting to
  `EXTERNALISE_ABOVE_BYTES`** (`GATE_READ_MAX_BYTES`, `cli.ts:5433`) — deliberately the same 64 KiB
  the journal already uses rather than a second number nobody chose. Over the cap the value is
  replaced in place by `{"$truncated":{bytes,shown,head}}`, which states the full size so the
  omission is actionable, and `head` is a whole-UTF-8 prefix (`utf8Head`) so a marker is never
  itself corrupt. `--max-bytes N` raises it, `--max-bytes 0` lifts it entirely, and
  `GATE_READ_MAX_CAP = 1 GiB` (`:5477`) is the ceiling, because `Number.isInteger(1e30)` is `true`
  and a mistyped exponent would print everything while truncating nothing and so saying nothing.
  `gateReadBound` (`:5570`) refuses a bare `--max-bytes` (`Number(true)` is 1) and an empty one
  (`Number("")` is 0, which here would mean "no cap") — both are the flag disregarded in the
  direction that DISCLOSES. Repro: `node --test packages/core/test/cli/gates-reads-resolved.test.ts`
  → **7 pass / 0 fail**. **Residue is §A.58**, including the third layer this door still cannot
  apply.

- ~~**A.52 · `dominantState` ranks seven of the nine task states, and a fan-out with one branch still
  retrying renders green.**~~ File: `packages/core/src/server/layout.ts:85-99`.
  `STATE_PRIORITY` is `["failed","awaiting_gate","leased","ready","cancelled","skipped","succeeded"]`
  while `run/projection.ts:58-67`'s `TaskState` union has **nine** members — `pending` and `retrying`
  are on neither list. Repro:
  ```
  only retrying             -> "retrying"     (the states[0] ?? "" fallback catches it)
  23 succeeded + 1 retrying -> "succeeded"    ← the defect
  pending + succeeded       -> "succeeded"
  ```
  **The "returns empty string" reading is REFUTED** — `states[0] ?? ""` saves the homogeneous case.
  The bug is PRIORITY, not absence, and it is the exact lie the function's own docstring forbids:
  *"A fan-out where 24 branches succeeded and one is awaiting a gate is a fan-out waiting on a human,
  and rendering it green would be a lie of omission."* It is also order-dependent whenever every
  input is unlisted. **And the browser has its own copy** — `server/console.ts:640-645` carries the
  identical seven-element inline array, so a fix that lands in one and not the other is the live
  risk. Rendering: `console.ts:625` emits `class="node <state>"` and `:90-94` defines rules for the
  seven only, so a `retrying` or `pending` node falls through to the neutral fill and is
  indistinguishable from one that has not started; the label text does say `· retrying`.
  **Closes when** both copies rank all nine — `retrying` and `pending` above `succeeded`, since both
  mean "not finished" — with a test that asserts the priority list and the `TaskState` union have the
  same members, so a tenth state fails there rather than rendering as nothing.
  **CLOSED at `cabd61e`.** The ranking is now ONE table rather than a list — `STATE_RANK:
  Record<TaskState, number>` (`server/layout.ts:107`), so a tenth `TaskState` is a `tsc` error
  rather than a silent omission, and `STATE_PRIORITY` is derived from it by sorting on the rank
  value. All nine are ranked, `retrying` (2) and `pending` (5) both above `succeeded` (8), which is
  what the row asked for. **The browser copy is mirrored** (`server/console.ts:677`, the same nine
  names in the same order) and `console.test.ts`'s *"THE CONSOLE'S FAN-OUT PRIORITY ORDER
  AGREES…"* reads BOTH source texts, so a change to one that is not mirrored fails a test. The
  rendering half went with it: `console.ts:98` gives `retrying` its own rule (dashed error stroke);
  `pending` gets none on purpose, because it IS "not started". Repro:
  `node --test packages/core/test/server/dominant-state.test.ts` → **7 pass / 0 fail**; the census
  test sorts by rank value rather than asserting a literal list.

- ~~**A.53 · A fan-out branch may hold two nodes, and finding that out takes two compiles.**~~ *(F1, the
  one friction entry from the 2026-09-09 port still open.)* File:
  `packages/core/src/graph/validate.ts`, `rule021FanoutHasJoin` and `rule008`. Repro is in
  `docs/workflow-port-2026-09-09.md` §3 F1, pasted in full there: with `join.branches: ["classify"]`
  the compile says `GRAPH021_FANOUT_WITHOUT_JOIN … fix: add a join node downstream of "read" with
  branches: [read]`; following that `fix:` literally then says `GRAPH008_BRANCH_NOT_CONNECTED …
  fix: add an edge read -> gather with kind: join`. Both exit 1. The rule neither states is *every
  node in a fan-out branch needs its own entry in `join.branches` AND its own `"kind": "join"` edge
  into the join*; the answer is the union of two `fix:` lines. Each message is individually correct,
  which is why the port lane logged it rather than reworded one. It has since acquired a second
  reader: §A.48's W6 clause keys the branch-local exemption on exactly that inbound edge list, so the
  invariant a stranger cannot discover is now also the one a validator relies on.
  **Closes when** one diagnostic names the whole rule — most cheaply by `rule021` looking at what
  the branch actually contains before it suggests a `branches:` list, so the first message is the
  right one rather than the first of two.
  **CLOSED at `51f4a5f`, over four fix rounds (`d7e8ee5`, `cbfdeb5`, `2d40f5e`, `ebd8446`,
  `51f4a5f`) and one send-back — and HOW it closed is worth more than that it did.** GRAPH021 now
  states the whole rule in one diagnostic. Repro, the port's own, from `examples/` with
  `join.branches: ["classify"]`:
  ```
  GRAPH021_FANOUT_WITHOUT_JOIN: fanout edge "fan" expands "read" but no downstream join waits on it;
    the branch it opens holds 2 nodes (read, classify), and a join must wait on every one of them
     fix: give join "gather" an entry in its `branches` for each of read, classify, and a
          `kind: join` edge from each of them into "gather" — every node inside a fan-out branch
          needs both. ADD to whatever "gather" already declares: one join can be the barrier for
          more than one fan-out
  ```
  Following that line literally compiles clean — **one step, where it used to be two.**
  (The probe graph also prints `GRAPH010_CONCURRENT_WRITE` while `gather` is not waiting on
  `read`: the branch-local exemption is keyed on the join's inbound edges, so removing `read` from
  `branches` removes the exemption too. It goes away with the same fix. Your terminal will show
  both lines; the quoted block is the one this row is about.)
  **THE METHOD IS THE RECORD.** The first three rounds each reopened one edge over: a membership
  test that dictated graphs which then broke, a barrier picked by reachability so the message named
  a join it could not know, and a `fix:` that REPLACED a join's existing `branches` instead of
  adding to them. That accretion of special cases in one predicate is the "fix rounds reopening one
  edge over" tell, and the remedy was to stop narrowing: the final form is ADDITIVE — it names the
  joins it OFFERS, and the multi-candidate arm filters `waitsFor` to the ancestors of every
  candidate in BOTH arms rather than only one. Test assertions parse the name sets out of the
  message (`namesIn`, `offeredJoins`) and **THROW on a sentence they do not recognise**, so a
  reworded diagnostic fails loudly rather than passing vacuously. **Reviewer evidence, all of it
  differential against `c98a108`**: an 8,000-graph sweep loosened **0**; of 31,442 graphs that
  reproduce F1, 26,827 with a `seq`-wired inner join, all converge in ONE step over 65,126 choice
  combinations; and 29,748 reachable joins that are NOT offered were each checked to break the
  graph if dictated. Repro:
  `node --test packages/core/test/graph/fanout-branch-diagnostic.test.ts` → **20 pass / 0 fail**
  (14 when this row closed; the 2026-09-10-c wave added six).
  **This closes F1, the last of the 2026-09-09 port's eight friction entries.** Two residues, each
  its own row and **both since closed at `d770a07f`**: the sibling rule
  `GRAPH008_HELD_JOIN_UNCOLLECTED` took three compiles and now takes two (§A.56), and the count
  and the dictated list answer different questions and now say so (§A.57).

- ~~**A.54 · The CLI exits before stdout drains, so any output over 64 KiB is truncated on a pipe.**~~
  File: `packages/core/src/cli.ts:11134`, `.then((code) => process.exit(code))`. On a pipe stdout is
  ASYNCHRONOUS, so `process.exit` discards whatever is still buffered; to a file or a TTY the writes
  are synchronous and nothing is lost. Repro, from `examples/`, on a gate whose `reads` is large
  (360 synthetic failures under the gitignored `out/big/`):
  ```
  $ loom gates $RUN > out/gates-file.json ; wc -c < out/gates-file.json
    126967
  $ loom gates $RUN | wc -c
     65536
  $ loom gates $RUN | jq -r '.[0].gateId'
  jq: parse error: Unfinished JSON term at EOF at line 1141, column 5
  $ loom gates $RUN | cat > /dev/null ; echo ${pipestatus[1]}
  0
  ```
  Exactly one pipe buffer, and **exit 0** either way. It is not silent for `jq`, which fails to
  parse — but it is silent for anything that does not validate.
  **THE 64 KiB IS THE OS PIPE CAPACITY AND NOT `EXTERNALISE_ABOVE_BYTES`**, which happens to be the
  same number; nothing on this path reads that constant, and a bare Node script reproduces it with no
  Loom in it — `node -e 'process.stdout.write("x".repeat(200000)); process.exit(0)' | wc -c` → 65536,
  and the same at 40,000 → 40000. **The two interact the OPPOSITE way to the tempting reading**: a
  channel big enough to fill the pipe is normally ELIGIBLE for externalisation and prints as a
  ~116-byte handle (§A.51(a)), so it took an OUTPUT channel — the one case §A.51(b) exempts from
  externalisation — to get 108 KB onto stdout at all. The `126,967` above therefore depends on a
  synthetic input; **the reproducible parts are the 65,536 and the exit 0**, and any verb printing
  more than a pipe buffer will show them. Found while verifying §A.51 and NOT introduced by this
  wave — `process.exit` at the end of `main` predates it.
  **Closes when** the exit path waits for stdout to flush rather than calling
  `process.exit` with writes outstanding (set `process.exitCode` and let the loop drain, or await a
  `write` callback), with a test that pipes more than 64 KiB through a verb and compares the byte
  count to the same command redirected to a file.
  **CLOSED at `a31279b`.** The exit path drains stdout before `process.exit`. **`process.exitCode`
  alone was tried and REJECTED**, and the reason is the row's mirror image: a handle nobody tore
  down turns a clean exit into a hang, which is a worse failure than the one being fixed and a
  quieter one (`cli.ts:11432`). So `process.exit` stays and the write is awaited first — the
  process ends one `await` away from it, which is also why a late EPIPE cannot be lost silently
  (`:11455-11461`). Repro: `node --test packages/core/test/cli/stdout-drain.test.ts` → **5 pass / 0
  fail**; it spawns the CLI on a REAL pipe rather than mocking the stream, because a mock would not
  have the 64 KiB the defect is made of.

### Opened by the 2026-09-10-b settlement

Found while building or reviewing the second wave. None is a regression it introduced unless the
row says so; §A.55 and §A.56 are PRE-EXISTING and were surfaced by the work beside them.

- ~~**A.55 · A join releases a fold with ZERO contributions and the run reports `succeeded`.**~~
  File: `packages/core/src/run/engine.ts`, `#foldJoin`. **BOTH HALVES ARE NOW CLOSED, one per
  wave, and the split was the row.** The first closed at `3a27a98d` (§Z): a join in mode `any` or
  `firstSuccess` whose members all FAIL used to wait for an arrival that cannot come —
  `fire = succeeded >= 1` is permanently false once every member is terminal — and now releases,
  in **all four modes**, with and without a second entrance, at every parallelism, and across a
  restart. `#maybeFireJoin`'s shared `noMoreArrivals` clause is the mechanism; `all` and `quorum`
  already released and are unchanged.
  **CLOSED on its second half at `6b7ed2c7` and `ee316e88`.** `#foldJoin` refuses
  `succeededMembers === 0 && members.length > 0`, beside the `onBranchError === "fail" &&
  skipped > 0` arm it already held, reusing `E_QUORUM_UNREACHABLE` — no `CODES` and no
  `EVENT_TYPES` member moved. The gate-reject shape this row called its sharpest now reads, on a
  fresh `Engine` over the parked SQLite journal and identically in all four modes:
  ```
  before  status=succeeded  Jready=1 done=1 note=["done-ran"]  joinError=undefined
  after   status=failed     Jready=1 done=0 note=undefined     joinError=E_QUORUM_UNREACHABLE
  ```
  **THE UNIT IS MEMBER TASKS, and the first cut's predicate is why that sentence is in this row.**
  `branchCount === 0 && expected > 0` — the rule this row itself proposed — counts branch
  COORDINATES, and the `lost` subtraction empties that set whenever ANY member of a coordinate
  dies. Two families of run that were succeeding began failing with their data already in the
  channel: a STATIC sibling join (three arms at the root coordinate, one loser) read `failed
  found=["b","c"] total=2`, and a DEGRADED branch (`b0` writes and succeeds, `b1` throws) read
  `failed seen=undefined`. The reviewers' recommended `+ byChannel.size === 0` was built and RUN
  and fixes only the second: a member at the root coordinate never enters `byChannel` at all.
  **What would be false if the claim were false:** an empty fan would fail too. `members.length
  > 0` is what excludes it, and §A.47's `#fireEmptyJoin` control beside the sweep turns red the
  moment that clause is dropped — which is what holds it in place rather than a comment.
  **Closes when** was "§D.9 answered and the answer built, with the two `TODAY` assertions
  flipped". §D.9 is answered as (a) — **by the wave orchestrator, following this row's own written
  recommendation, and not by the maintainer** — both assertions are flipped (the word `TODAY`
  survives only as history in the file), the §A.47 empty-fan control is beside them, and the file
  that held three tests holds seven:
  `node --test packages/core/test/run/join-all-branches-fail.test.ts` → **7 pass / 0 fail**, re-run
  on `015f3547`. **This row's own "3 pass / 0 fail" was the count before those suites existed**, and
  so was §D.9's.

- ~~**A.56 · `GRAPH008_HELD_JOIN_UNCOLLECTED`'s `fix:` names the `branches` entry and omits the
  `kind: join` edge, so following it lands on a SECOND `GRAPH008` — the F1 defect, still open in
  the sibling rule.**~~ File: `packages/core/src/graph/validate.ts`. §A.53 fixed GRAPH021 and left
  its sibling alone. Repro, on a graph with an inner fan-out (`read --fanout--> sub`) whose inner
  join `subJoin` is held inside the outer fan-out branch:
  ```
  $ loom compile p4-held.json
  ✗ GRAPH008_HELD_JOIN_UNCOLLECTED: join "subJoin" is inside a fan-out, so it HOLDS its fold for an
    enclosing join to collect — but no join declares "subJoin" among its branches …
     fix: add "subJoin" to the enclosing join's `branches`, or move "subJoin" outside the fan-out
  ```
  Following that `fix:` literally — `gather.branches: ["classify","subJoin"]` — then says:
  ```
  ✗ GRAPH008_BRANCH_NOT_CONNECTED: join "gather" waits on "subJoin", but no edge runs from
    "subJoin" to "gather"
     fix: add an edge subJoin -> gather with kind: join
  ```
  The second message tells you the half the first omitted: **the exact shape §A.53 closed, in the
  rule next to it.**
  **THE ROW'S "FOUR COMPILES" WAS MEASURED ON A GRAPH WITH A SECOND FAULT IN IT, and the settlement
  re-measured both.** Against `27f7d56` (`git archive`, no checkout), following one `fix:` per
  compile: the PLAIN graph — `examples/graphs/triage-failures.json` in miniature, its outer join
  `gather` already correct, plus the inner `read --fanout(subs)--> sub --join--> subJoin` — takes
  **THREE**: (1) `GRAPH008_HELD_JOIN_UNCOLLECTED`, (2) `GRAPH008_BRANCH_NOT_CONNECTED`, (3) clean.
  **FOUR** needs the outer join broken as well (drop `read` from `gather.branches` and its join
  edge), which interleaves `GRAPH021` and gives (1) both codes, (2) both, (3) `GRAPH021` alone,
  (4) clean. Only step (1)→(2) was ever this row; the GRAPH021 steps are §A.53's rule, already
  closed, doing its job on a second fault.
  **CLOSED at `d770a07f`.** The line now names the entry AND the `kind: join` edge, in §A.53's
  words — ADDED to whatever the join already declares, never a replacement — and it says WHICH
  join it means: *the barrier of the INNERMOST fan-out the held join is inside, adding one if that
  fan-out has none*. Both graphs above drop by one compile, measured on the merged tree: plain
  **3 → 2**, outer-join-broken **4 → 3**.
  ```
  fix: give the enclosing join — the barrier of the INNERMOST fan-out "subJoin" is inside, adding
       one if that fan-out has none — an entry in its `branches` for "subJoin", and a `kind: join`
       edge from "subJoin" into that join: a held join needs both, and the entry is ADDED to
       whatever the join already declares. Or move "subJoin" outside the fan-out, so it applies
       its own fold
  ```
  **INNERMOST is load-bearing, not decoration:** under double nesting "the fan-out X is inside"
  names two fan-outs and only one works — a join two fan-outs deep collected by the OUTER barrier
  makes that barrier reachable at two depths and fails closed on `GRAPH008_JOIN_DEPTH`, while the
  inner one compiles. `heldFixEdits` parses the adjective, so dropping it breaks the test file
  rather than the next reader's compile. **What the line does NOT claim is that the author's
  choice is checked downstream** — it was not when this row closed, and §A.64 has since made it
  partly so: a node inside a fan-out may now be named by at most one join, and an arm whose
  fan-out identity is KNOWN and differs from the join's is refused. What is still unchecked is an
  ambiguous arm with one claimant, which is tolerated on purpose.
  Repro: `node --test packages/core/test/graph/fanout-branch-diagnostic.test.ts` → **20 pass / 0
  fail**. Nothing moved in what is REFUSED: over 183 graphs and 906 diagnostics the (file, code,
  at) key set and every severity are identical to `27f7d56`, and GRAPH021's `fix:` is byte-
  identical.

- ~~**A.57 · GRAPH021's node COUNT and its dictated LIST answer different questions, and the message
  does not say so.**~~ File: `packages/core/src/graph/validate.ts`, `rule021FanoutHasJoin`. On the
  §A.56 graph the one diagnostic said the branch *"holds 3 nodes (read, classify, subJoin)"* and
  then dictated entries for *"each of read, classify"*. Both are correct and they are not the same
  set: the count is every node the branch CONTAINS, the list is every node the join must WAIT ON,
  and a held inner join is in the first and not the second. A reader had no way to tell that the
  missing name was deliberate rather than a bug in the message. It was pinned as behaviour by the
  two-candidate case in `test/graph/fanout-branch-diagnostic.test.ts`, so the divergence was known
  and tested — it was the PROSE that did not disclose it.
  **CLOSED at `d770a07f`.** The message now names the difference when there is one, and is
  byte-identical when the two sets coincide:
  ```
  ✗ GRAPH021_FANOUT_WITHOUT_JOIN: fanout edge "fan" expands "read" but no downstream join waits on
    it; the branch it opens holds 3 nodes (read, classify, subJoin), and the `fix:` line dictates
    the ones that run into every join it offers — "subJoin" does not, so it is in this count and
    not in that list
  ```
  **"every join it OFFERS", not "a join it offers"**: with two candidates a node may run into one
  and not the other, and the dictated list has to be true whichever the author picks.
  **AND THE CLAUSE PROMISES NO REFUSAL.** Its first draft said a join *must* wait on every counted
  node "directly, or through another branch node that folds it"; nothing refuses a branch node
  left unfolded, so that would have been a guarantee the compiler does not make. It reports what
  the `fix:` line dictates and stops. It also may not say the difference is "already collected by
  something": on the graph that motivated it nothing collects `subJoin` — GRAPH008 is refusing it
  in the same run — so that wording would have swapped a silent omission for a false claim.
  Repro: `node --test packages/core/test/graph/fanout-branch-diagnostic.test.ts` → **20 pass / 0
  fail**; `countedIn` reads the count off the message and THROWS on a shape it does not recognise,
  the same contract as `namesIn`, so this cannot be reworded as a drive-by.

- ~~**A.58 · Residue on §A.51: four things `loom gates`'s bound does not do.**~~ File:
  `packages/core/src/cli.ts`. Each was disclosed in the source that shipped it, which is why they
  were one row and not four. **CLOSED at `f8bacd2d`, `fb59d63d`, `bb0e203e` — two fixed, one
  recorded as a decision, one SPLIT.** Where the citations in `cli.ts`, `README.md` and
  `test/cli/gates-branch-stale.test.ts` say **§A.58(4)**, the half still open is **§A.60**.
  (1) **The `$truncated` marker was recognised by SHAPE**, and `payloadHandle` explicitly refuses
  to be. **FIXED at `f8bacd2d`**: no key inside a value could have done it — JSON keys are
  arbitrary strings, so every name a marker might use is one a node can write — and what a channel
  value cannot do is add a key to the ROW that carries it. The gate row now carries
  `readsTruncated`, a map from channel name to `{bytes, shown}` naming exactly what this door cut;
  the `$truncated` wrapper stays in place, which is the same division `external` draws for
  handles. Present whenever `reads` is, `{}` when nothing was cut. Measured: a channel whose value
  IS a `$truncated` object renders as a value and is absent from `readsTruncated`, while the value
  that was cut is named there with its full size.
  (2) **The bound is per VALUE, not per output.** **DECISION: keep per-value**, argued at
  `gatesWithReads` in `cli.ts`. A per-output budget makes what an operator sees depend on how many
  OTHER gates are parked and in what order channels are visited — the first gate in a fan-out
  prints whole and the last prints nothing, and the same gate shows different content as its
  neighbours resolve. This door's subject is one human deciding on one gate. Accepted with it: a
  worst case bounded by `gates × channels × maxBytes`, every cut of which is named on stderr and
  in the row's own `readsTruncated`. The answer to "too many gates in one document" is selecting
  or paging gates — a different feature, not a budget that silently decides which approver reads.
  (3) **`gateReadBound` accepted `Number()`'s exotic literals** — `0x10`, `1e3`, `0b11`, `" 24 "`,
  all `Number.isInteger` and all accepted. **FIXED at `f8bacd2d`**: `/^\d+$/` is now the whole
  grammar, which is also what refuses `-5`, so the `n < 0` arm went with it. The refusal text was
  corrected in the same wave (`fb59d63d`) — it said "a whole number of bytes" while the rule is
  decimal digits only, so refusing `1e3` contradicted the message.
  (4) **`#withBranchWrites` is a third layer this door cannot apply.** **SPLIT.** The recorded
  argument was FALSE in both halves and had been promoted into `cli.ts`: it was not "a SIBLING's
  committed write" (`#withBranchWrites` folds at EXACTLY the branch path — branch `#0` never sees
  branch `#1`; what is missing is the gate's OWN branch's earlier nodes), and it did not "show
  less and never more" (`reduceState` REPLACES a `replace` channel, so what this door printed was
  a DIFFERENT, OLDER value). **The SILENCE half is closed** at `fb59d63d` and `bb0e203e`: whether
  a held write EXISTS on a printed channel is decidable from `p.tasks` alone and needs no engine
  seam, so every affected gate now carries `readsMayBeStale` and raises a `! MAY BE STALE` notice
  on stderr, in both forms — *"prints an OLDER value for `mid`"* and *"prints NOTHING for `mid`,
  whose only value is held"*, the second being the worse case the first round missed (the set is
  `observedChannels(node)`, what the gate READS, not `view.visible`, which holds only channels
  that already have a value). It over-reports on purpose: a held write whose value equals the base
  is still named, because deciding otherwise means running the reducer. **The VALUE half is
  §A.60.**
  Repro: `node --test packages/core/test/cli/gates-reads-resolved.test.ts` → **9 pass / 0 fail**;
  `node --test packages/core/test/cli/gates-branch-stale.test.ts` → **5 pass / 0 fail**.

- ~~**A.59 · Residue on §A.50: four things the width refusal does not reach.**~~ File:
  `packages/core/src/graph/validate.ts` and `packages/core/src/run/engine.ts`.
  (1) **The runtime path was still reachable.** `Engine.submit` and `Engine.attach` take a
  `RunGraph` directly and `#assertBound` re-checked no widths, so an embedder who builds one
  without going through `compile` kept `slice(0, NaN)` — zero branches, no diagnostic — and the
  `NaN` propagated through `parallelWidth` so GRAPH010's concurrent-writer refusal silently
  stopped firing. **CLOSED at `0dd0a524`**, and re-checked rather than declared out of scope
  because the method already made that decision once, three lines earlier and on the identical
  argument: an edge `kind` this build cannot read is closed at compile by
  `GRAPH003_UNKNOWN_EDGE_KIND` and closed again at the door "because `attach` is public and
  `RunGraph` is exported". Answering the other way would refuse a run for a mistyped `kind` and
  accept one for a mistyped `maxWidth`, three lines apart. `E_GRAPH_INVALID` / class `validation`,
  no new code and no new exported name. Repro:
  `node --test packages/core/test/run/engine-assert-bound-width.test.ts` → **2 pass / 0 fail**,
  thirteen unreadable values driven end to end through `submit` + `advance`.
  **DECISION, taken by the lane and recorded here: READABILITY AND NOT THE CEILING.**
  `rule007Fanout` also refuses a width over `expansion.maxFanout`; `#assertBound` does not, and
  the test pins an over-ceiling width as ACCEPTED so the gap is a decision rather than an
  oversight. The ceiling is a policy number the compiler produces by merging graph policy over
  defaults, so re-deriving it in the kernel would be a second implementation of a budget, and any
  drift would refuse graphs the compiler accepted — including runs already in flight, since
  `#assertBound` runs on every `advance`. An unreadable width is a correctness hole; a width over
  budget is the compiler's business.
  (2) **`EDGE_FIELDS` remains a NAME allowlist** — carried forward as **§A.62**, now with a third
  hand-written type test to point at.
  (3) and (4) **CLOSE WITH (1)**, because the row already answers them and neither is work. (3):
  three codes have an EMPTY `RAISED_CLASS` set — `E_ROUTE_NOT_FOUND`, `E_EFFECT_UNAVAILABLE`,
  `E_REQUEST_TIMEOUT` — so §A.49's refusal ACCEPTS them BY DESIGN, refusing on a class nothing
  pins being the same false refusal the comment table was rejected for. Repro:
  `/usr/bin/grep -acE '^  E_[A-Z0-9_]+: \[\],' packages/core/src/graph/validate.ts` → **3**.
  "Empty set" and "bare `{code, message}` record" are NOT the same set: at least five codes are
  emitted as bare records, `cbfdeb5` read the class off three of them, two of those flipped to
  refusals, and that is the whole of the 43 → 45 move. (4): an `--extension-module` raising a
  pinned code under a class `RAISED_CLASS` does not list is OVER-refused; the escape is to drop
  `onlyIf` entirely, which retries on every retryable error and loses nothing the filter could
  have expressed, and it is written down at the head of `test/graph/retry-onlyif-retryable.test.ts`.
  One residue of (1)'s own is **§A.63**.

- **A.60 · `loom gates` prints a pre-branch value for a gate inside a fan-out, and cannot print the
  right one without an engine read-surface seam.** *(The VALUE half of §A.58(4); the SILENCE half
  closed at `fb59d63d`/`bb0e203e`. Every `§A.58(4)` citation in `cli.ts`, `README.md` and
  `test/cli/gates-branch-stale.test.ts` means this row.)* File: `packages/core/src/cli.ts`,
  `gatesWithReads`. `#executeTask` composes `#withBranchWrites(ctx, await #resolveReads(…),
  branch)`; a fan-out HOLDS a branch's writes until its join folds them, so the stored projection
  a fresh `loom gates` reads does not carry them. `#withBranchWrites` is private to the engine and
  the overlay needs `reduceState`, which for a `replace` channel REPLACES — so what this door
  prints is not a subset of the truth, it is a DIFFERENT, OLDER value, or a blank where the
  channel's only value is held. Repro, on `seed --fanout--> bump --seq--> approve` where `bump`
  writes `mid` and the gate reads it:
  ```
  loom gates    ->  reads = {"mid":"BASE-VALUE-BEFORE-THE-BRANCH-WROTE"}
                    readsMayBeStale = ["mid"]   ! MAY BE STALE on stderr
  loom approve  ->  exit 0, succeeded, outputs = {"mid":"BUMPED-VALUE-THE-CONSOLE-SEES"}
  ```
  `#approvalStillCovers` does not fire, because nothing changed between raise and dispatch — the
  disagreement is between two RENDERINGS, not across time. **`contentDigest` on that same row
  binds the OVERLAID value** (`digest(#gateBinding)` over the projection composed in
  `#executeTask`), so the binding does not describe the `reads` beside it, and **`loom approve`
  executes on the overlaid value.** Pinned by
  `node --test packages/core/test/cli/gates-branch-stale.test.ts` → **5 pass / 0 fail**, whose
  first test asserts the printed value is still the STALE one — so the day the overlay closes,
  that assertion fails and points here.
  **Closes when** the engine exposes branch-held writes as a read surface a second door may use —
  a seam to design, not a field to add — and `loom gates` renders through it. Reimplementing
  `reduceState` in `cli.ts` is explicitly NOT the answer: that is a second copy of the engine's
  rule in a second file, the drift `gatesWithReads` already refuses by calling `observedChannels`
  and not `node.reads`. With a test asserting the printed value equals what `loom approve` then
  executes on, for a gate inside a fan-out branch.

- ~~**A.61 · A node-written `{"$payload":{digest,bytes}}` prints in `loom gates` exactly like a
  handle this door could not read back.**~~ File: `packages/core/src/cli.ts`, `resolveHandles`.
  **CLOSED at `48f80947`, with `a0dca498` and `c7fd74f0` correcting the claims around it.**
  **The MECHANISM is unchanged and that was the point**: `resolveHandles` still decides what is a
  handle from `p.external`, the fold's authoritative map, and nothing anywhere sniffs a value's
  shape — `payloadHandle`'s docstring forbids it, because sniffing would hand any node that can
  write a channel the ability to name a payload it never produced. What changed is that the READER
  is now told the door's own answer: the gate ROW carries **`readsResolved`** and
  **`readsUnresolved`** — the channels in `observedChannels(node) ∩ keys(p.external)` this door
  fetched, and the ones it could not. A `$payload`-shaped value on NEITHER list was never a handle.
  **BOTH LISTS, NOT ONLY THE FAILURES**, and the argument is what a `jq` reader can compute:
  `readsUnresolved` alone answers *"this LOOKS like a handle — is it one?"* and cannot answer
  *"this does NOT look like a handle — WAS it one?"*, because a fetched value carries nothing
  saying it came from outside the journal. An empty `readsUnresolved` is the same document for a
  gate that read every handle back as for a gate that had none; their UNION is the recoverable
  fact.
  **ON THE ROW, for §A.58(1)'s reason exactly**: JSON object keys are arbitrary strings, so every
  marker a value might carry is one a node can write; what a channel value cannot do is add a key
  to the row that carries it. Present whenever `reads` is, `[]` when the gate read no handle,
  absent on the same three rows that carry no `reads` at all.
  **Order is by NAME, not by position** — `makeStateView` slices over `[...allowed].sort()`, so
  `reads` prints its keys ALPHABETICALLY while these two lists are in `observedChannels` (declared)
  order. Pinned by a gate declaring `reads: ["zeta","alpha"]`.
  **What would be false if the claim were false:** the two wrong fixes would pass. Both are run as
  mutations and both go red — deciding `readsUnresolved` by SNIFFING the value for `$payload`
  (3 fail), and skipping a FETCHED value that happens to be `$payload`-shaped (1 fail, on
  *THE PAYLOAD WHOSE CONTENT IS ITSELF `$payload`-SHAPED*, the fixture that pins the invariant the
  row exists for). A reviewer also measured the hostile-store case — content whose digest does not
  match lands in `readsUnresolved` — and a classified channel still prints `[secret]`.
  New output vocabulary landed under a `fix:` subject, as `readsTruncated` and `readsMayBeStale`
  did; no exported name moved (`GateHandles` is module-private) and `cli.ts` is not kernel.
  **Closes when** was "the gate row carries the door's own answer the way `readsTruncated` does …
  with a test driving a node-written `{"$payload":…}` beside a genuinely unresolvable handle":
  satisfied, with the handle made unreadable by DELETING its cell from the store rather than by a
  stub. Re-run on `015f3547`:
  `node --test packages/core/test/cli/gates-payload-provenance.test.ts` → **7 pass / 0 fail**.

- ~~**A.62 · `EDGE_FIELDS` is a NAME allowlist, so the edge parse type-checks nothing — and three
  places now check a field of it by hand.**~~ *(Carried from §A.59(2).)* **CLOSED at `5f4fd61a`,
  `c9685caa`, `44221801` (+ pins `19b183c4`, `cdf8d60a`, `e890cc41`, `7d23ec2b`) — and it CLOSES AT
  TWO, by the row's own second arm.** File: `packages/core/src/graph/spec.ts:986` and
  `packages/core/src/graph/validate.ts`. `EDGE_FIELDS` is now
  `Readonly<Record<string, {type: "string" | "count" | "stringArray"; readBy?: EdgeKind}>>` — a type
  per field, plus `readBy`, which is the `/** <kind> only. */` comment above each field made
  readable — and `checkStructure`'s edge loop checks the tag ONCE, generically. `rule006Cycles`'
  and `rule007Fanout`'s hand-written type halves are gone; `edgeFieldRefusal` is the single producer
  of the width refusal and `rule007Fanout` calls it. The repro moved **6 → 4 / 4**:
  ```
  $ /usr/bin/grep -acE 'isPositiveInt|readableFanoutWidth' packages/core/src/graph/validate.ts packages/core/src/run/engine.ts
  packages/core/src/graph/validate.ts:4
  packages/core/src/run/engine.ts:4
  ```
  **and the four that remain in `validate.ts` are `policy.expansion`'s bounds, not an edge's** —
  `POLICY_FIELDS`/`NESTED_FIELDS` are still NAME-only, which is §A.81, one scope in. The function was
  deliberately NOT renamed, so this grep keeps saying something true.
  **WHY IT CLOSES AT TWO.** `readableFanoutWidth` in `engine.ts` stays hand-written, by the arm this
  row already carried: `Executor.attach()` is public and `RunGraph` is exported, so a graph reaches
  the executor without having passed this build's compiler, and *"the compiler is the earlier answer
  and the executor must not depend on having been the caller of it"*. Importing the compiler's
  predicate would also add an exported name to a pinned surface.
  **What it changed beyond the row's ask, each measured:** a wrong-typed field is refused on EVERY
  edge kind and not only where a rule reads it (D7 — a MISSPELLED field on a `seq` edge was already
  fatal, so a wrong-TYPED one compiling clean was the asymmetry); `codes: null` and `over`/`as`/
  `compensates` of the wrong type now refuse as `GRAPH003_MALFORMED` where nothing refused them
  before; and 60 census rows that made `compile()` **throw** `CanonicalizationError: non-finite
  number` instead of returning a diagnostic are closed as a side effect. `maxWidth` and
  `maxIterations` keep their own codes and messages, because the parse decides the TYPE and the rule
  keeps the RANGE — `maxWidth: 0` is still `GRAPH007_BAD_MAX_WIDTH` with `expansion.maxFanout` in its
  fix. Six fields are type-checked ELSEWHERE by a refusal proven total (`TYPE_CHECKED_ELSEWHERE`:
  `id`, `from`, `to`, `kind`, `when`, `until`), pinned in `test/graph/edge-field-types.test.ts`.
  **THE BYTE-IDENTITY CLAIM IS SCOPED to single-fault graphs**, and the scope was found by running:
  `loom compile` is byte-identical to `6fb2e618` on all seven shipped fixtures and on the
  wrong-typed fixture too, but on a MULTI-fault graph the new fatal drops unrelated ERRORS as well —
  a racy graph plus a bad `maxIterations` prints `GRAPH006` alone where the base also printed
  `GRAPH010`.
  **LEDGER WATCH, for whoever reads the next diff:** `graph/spec.ts` is one of the ten kernel files
  and it gained enforcement vocabulary under `fix:`, which `check-kernel.mjs` cannot see and
  `check-surface.mjs` calls unchanged. Related: `EDGE_FIELDS` went from an ARRAY to a RECORD, so any
  out-of-tree reader breaks at the same "unchanged" — **and NOT silently, which this clause had
  backwards until it was measured on 2026-09-22b**: `EDGE_FIELDS.includes(f)` THROWS
  (`v.includes is not a function`), while `EDGE_FIELDS.length` is `undefined`, so it is the
  LENGTH reader that fails silently and validates nothing. The owed list that this clause pointed
  at is now a row: **§D.11**, which carries the measurement and the options.
  **NOTE ADDED 2026-09-22b: "closes at TWO" is now "closes at TWO, TWICE."** §A.81(b) added
  `readableLoopBound` beside `readableFanoutWidth` in `run/engine.ts`, by this row's own argument —
  the executor must not depend on having been the compiler's caller — so there are two hand-written
  copies of one predicate, and the grep this row rests on reads **4 / 6** rather than 4 / 4:
  ```
  $ /usr/bin/grep -acE 'isPositiveInt|readableFanoutWidth' packages/core/src/graph/validate.ts packages/core/src/run/engine.ts
  packages/core/src/graph/validate.ts:4
  packages/core/src/run/engine.ts:6
  ```
  The two predicates are IDENTICAL today (`typeof === "number" && Number.isSafeInteger && >= 1`) and
  are deliberately not folded, because each refusal has to say what ITS reader does with the value
  and the two consequences differ: an unreadable width fans out zero branches, an unreadable bound
  stops the loop after one pass and reports `succeeded`. **The only thing keeping them in step is a
  paragraph** — `readableLoopBound`'s docstring, which says so and says *they must move together*.
  A drift RISK, recorded so nobody discovers it, and not a defect: no row, because there is nothing
  to fix until they disagree.
  **Residue, each its own row rather than carried here:** §A.78 (`when: [null]` OOMs the compiler),
  §A.79 (a `subgraph` block with no `inputs` crashes `rule016Subgraphs`), §A.80 (a subgraph child's
  edge `kind` is unchecked at compile, pinned negatively), §A.81 (`POLICY_FIELDS`/`NESTED_FIELDS`
  name-only, and no executor copy for `maxIterations`). Not rows, recorded here: a hostile element
  getter or a length-lying `Proxy` still throws out of the `stringArray` walk and `checkCodes` (48
  census rows, not reachable through `JSON.parse`), and `describeValue` has no length cap, so a
  100 kB value is echoed whole and now reaches more messages than before.

- ~~**A.63 · A refusal raised from `advance` leaves the run `running` with nothing journaled about
  why.**~~ File: `packages/core/src/run/engine.ts`, `#assertBound`. **CLOSED at `562bd7c5`,
  `ee316e88` (identity) and `b9bdb5f4` (residue).** `#failUnreadableGraph` wraps the ONE
  `#assertBound` call on the advance path and keys on the CODE — `E_GRAPH_INVALID` /
  `validation` — rather than on either arm, so the three-lines-apart asymmetry `0dd0a524` closed
  cannot come back through one check being answered and not the other. It reuses `#failRun` and
  `errorRecord`, so the `run.failed` row carries the refusal's own `details` (the edge ids, the
  unreadable width) and **no journal vocabulary was added**. Measured for BOTH checks, identically:
  ```
  before  threw E_GRAPH_INVALID / validation  status: running  run.failed rows: 0
          journal: run.submitted, run.compiled, run.started, task.ready
  after   threw E_GRAPH_INVALID / validation  status: failed   run.failed rows: 1
          journal: … , run.failed
  ```
  **IT FAILS THE RUN ONLY WHEN THE GRAPH IS THE RUN'S OWN, and that is the judgement in it.**
  `advance` refuses the graph IN HAND and the vocabulary checks sit ABOVE the compile-identity
  check, so a caller who `attach`es a forged graph to a healthy parked run reaches this refusal
  with a graph the run never compiled; failing there would let one bad caller destroy a live run.
  Identity is `#graphIdentityMismatch`, defined once and called by both `#assertBound` and this
  door: `graphHash` AND the resolution manifest. **The first cut compared the hash alone** and a
  foreign broken graph wearing it killed a parked run — `failed / 1 / ["cancelled"]` where the
  fixed door reads `awaiting_gate / 0 / ["open"]`. **Recomputing `graphHashOf(spec)` is NOT the
  fix, and that was measured too**: `run.compiled.graphHash` is the FIELD the submitter supplied,
  so recomputing declines every run whose submitter hand-built a `RunGraph` — which is precisely
  this row's own shape, and the only shape that can reach a vocabulary refusal at all.
  A failure to journal the failure warns on `process.emitWarning("LOOM_REFUSAL_NOT_JOURNALED")`
  and the original refusal still propagates — untested on purpose, because the property that
  matters there is structural.
  **What would be false if the claim were false:** a second `advance` would write a second
  terminal row, and a fresh process would refuse rather than answer. Both are pinned: the attached
  engine refuses twice and appends once, and a FRESH process takes `#advanceSerially`'s retired-run
  fallback and ANSWERS `failed` — an asymmetry put on the record rather than smoothed over.
  **Closes when** was "a refusal at this door either fails the run or is journaled as a refusal a
  fold can serve — and the decision covers BOTH checks": satisfied, by failing the run, for both,
  through one code-keyed wrapper. Re-run on `015f3547`:
  `node --test packages/core/test/run/advance-refusal-is-journaled.test.ts` → **2 pass / 0 fail**
  (each test sweeps both faults; the second also sweeps a foreign graph wearing the run's hash).
  **Deliberate non-goal, stated so nobody reads it as an oversight:** the gate doors
  (`resolveGate`, `decideGateBatch`) still throw `E_GRAPH_INVALID` unjournaled — a typo'd `--graph`
  on an approve is not a dead run. **The residue is §A.66**: the identity pair is journaled, so
  journal READ access is enough to synthesise it.
  **NARROWED ON 2026-09-19, and the subset it lost is named rather than implied.** §A.66's fix gave
  `#failUnreadableGraph` a second, journal-derived conjunct — the run must also have EXECUTED
  NOTHING, which is `#store.read` finding no unsuppressed `task.leased` or `gate.raised`. So the
  CROSS-BUILD case is no longer covered: a run that really did execute, under a build that could
  read its graph, and is presented now to a build that DROPPED an edge kind, is refused and left in
  the state it was already in with **nothing journaled about why** — which is this row's own opening
  sentence. Measured on `61b00d12` with `a66.mjs` (the parked, already-advanced shape):
  `threw: E_GRAPH_INVALID  status: awaiting_gate  run.failed rows: 0  gates: ["open"]`. Taken
  deliberately, and the trade is asymmetric: such a run is RECOVERABLE by rolling the binary back,
  where this row's own never-executed run could progress under no build at all. The conjunct can
  only ever move a case from the destructive answer to the conservative one, so it loosens nothing.
  Written at `#failUnreadableGraph`'s own site, not only here.

- ~~**A.64 · `GRAPH008_JOIN_DEPTH` compares `fanoutDepth` NUMBERS and never `fanoutEdgeStack`, so a
  held join collected by a SIBLING fan-out's barrier compiles clean.**~~ File:
  `packages/core/src/graph/validate.ts`. **CLOSED at `5c0f3214`, `76b57e08` and `472f521b` — and
  THIS ROW'S PREMISE WAS WRONG TWICE OVER, which is recorded rather than quietly dropped.**
  **(i) The literal repro above compiles, and it SHOULD.** With `a0` in `bJoin.branches` and a
  `kind: join` edge, `bJoin` IS fan A's only barrier; on a real `Engine` over an `append_ordered`
  channel that graph folds 8 contributions against 8 succeeded writer tasks, once each and in
  branch order. **(ii) The shape the row MEANT** — fan A keeping its own barrier while the held
  join `aJoin` goes to fan B's — also folds 8/8, differing only in ORDER. Two intermediate cuts of
  the fix refused it and the final one does not. So "a held join in a sibling fan's barrier"
  is not the defect; two earlier drafts of the comment at that site got this backwards in opposite
  directions, and the third says what was measured.
  **What the row DID find is that the rule read only depth NUMBERS**, and the fix is one rule in
  place of the three cases the first two cuts grew. The fact all three got wrong:
  `writesHeldForJoin(branch) = branch.segments.length > 0` (`run/engine.ts`) — holding is a
  property of the TASK'S OWN DEPTH and of nothing else — so **a node with `fanoutDepth >= 1` may
  be named in `branches` by AT MOST ONE join**, keyed on the node id, with no stacks and no depth
  arithmetic. The stack-identity arm check from `5c0f3214` stands beside it: an arm whose
  `fanoutEdgeStack` is KNOWN and differs from the join's is refused. Ambiguity (a router-steered
  body, `fanoutEdgeStack === undefined`) with ONE claimant stays legal — that is
  `test/run/empty-fanout-oversight.test.ts`'s shape and the whole licence the tolerance had.
  **The measurement that says it is the right rule:** eighteen shapes on a real `Engine`, each
  also run through the validator at `dbaa5671` and at both intermediate cuts. It refuses exactly
  the SEVEN that double-fold (one arm under two root joins 4/2; an ambiguous body under two joins
  8/4, through a router 4/2, at two depths 8/4; mixed known/ambiguous claimants 6/4; a join at the
  arm's own depth plus one above 4/2; GRAPH021's own dictated a53 convergence 6/4) and accepts all
  ELEVEN that fold once each. **What would be false if the claim were false:** a graph that folds
  correctly would be refused. A branch split across two DISJOINT joins folds every contribution
  once and only the order differs, so it compiles — `76b57e08` had refused it and that refusal was
  withdrawn rather than defended.
  **Differential** (the lane's harness, which lived in its gitignored `.agent/` and is gone with
  it — reported, not re-run by this settlement; what the settlement re-ran are the suites below):
  1752 specs, +14 diagnostic rows, **0 removed and 0 changed**, every one
  `GRAPH008_JOIN_DEPTH` keyed `{nodeId}`; the 9 committed `GraphSpec` files still carry zero
  diagnostics, and `fanout-branch-diagnostic.test.ts`'s `namesIn`, `offeredJoins`, `heldFixEdits`
  and `countedIn` parse an unchanged `fix:` string.
  **Closes when** was "the arm compares STACK IDENTITY and not only depth … with a test on the
  two-sibling-fan shape above and a two-sided control": satisfied by the arm check plus the
  one-join rule, and the two-sided controls are in `test/graph/join-depth.test.ts` — including the
  one this row did not expect, that the sibling-fan shape COMPILES. Re-run on `015f3547`:
  `node --test packages/core/test/graph/join-depth.test.ts` → **17 pass / 0 fail**;
  `node --test 'packages/core/test/graph/*.test.ts'` → **417 pass / 0 fail**.
  **`docs/handoff-2026-09-10-c.md` §3's paragraph on this row repeats the misreading.** It is left
  standing, by the convention that handoff itself uses for its predecessor: the record of what was
  believed is not edited, and `docs/handoff-2026-09-15.md` §2 says what replaced it.
  Two things this closure opened: §A.65 (GRAPH021's multi-candidate line now dictates a graph the
  compiler refuses) and the trade above, which is disclosed in the rule's own comment.

### Opened by the 2026-09-15 settlement

Found while building or reviewing the third wave, and each re-run on `015f3547` by the settlement
rather than taken from a lane report.

- ~~**A.65 · GRAPH021's multi-candidate `fix:` line dictates a graph the compiler now refuses.**~~
  CLOSED at `3dcaf728`, `e491162b`, `1f8adaf6`. `waitsFor` drops from the dictated list any branch
  member a join OTHER THAN THE ONE THE LINE NAMES already claims — in EVERY arm of the rule and
  not only the multi-candidate one, because the zero-candidate arm gives a brand-new join the same
  second folder — and `foldersOf` is `claimedBy`'s exact test: `branches` membership plus
  `fanoutDepth >= 1`, with NO reachability, because a `fix:` line has to predict the COMPILER and
  not the executor.
  **Both intermediate cuts were wrong in an instructive direction.** The first excluded EVERY
  candidate, so with two candidates a member one of them already folds was dictated to the other
  and the line compiled for one of the two names it offered and was refused for the other. The
  second required the claiming join to be DOWNSTREAM; measured on an `Engine` with both
  compile-time refusals neutralised, a disconnected `branches` entry folds nothing extra — **2
  contributions with it and 2 without** — which is true of the executor and answers the wrong
  question.
  **THE CLOSING CLAIM IS NOT THIS ROW'S LITERAL "converges in ONE compile", and the difference is
  the honest part.** What is asserted is that following the dictated line introduces **no
  diagnostic the first compile did not print**: `a53-pickone` also carries a `GRAPH008_JOIN_DEPTH`
  on `gather` from the FIRST compile (both candidates claim it), so the dictated edit alone still
  exits 1 and the one edit left is the one that compile's OTHER `fix:` line dictates. Claiming
  "one compile" would have been false, and buying it would have meant suppressing a line the
  author needs.
  §A.57's disclosure sentence now carries the reason PER NAME with the folding join named
  (`{reason: "folded", by: ["gather"]}`); the reason-1-only form is byte-identical, the F1 /
  `triage-failures.json` single-candidate string is byte-identical and asserted whole, a one-name
  list gets a singular sentence, and `countedIn` parses the whole clause and throws on a shape it
  does not know. `e.to` — the fan-out's own target — is dictated whatever folds it, by an explicit
  guard, because a list without it dictates an edit that does not clear the error it is attached
  to. Differential at each step: 861 → 867 → 869 specs, **0 diagnostic rows added, 0 removed**, 5
  / 7 / 9 GRAPH021 texts changed and zero other messages.
  Re-run on `a9214611`: `node --test packages/core/test/graph/fanout-branch-diagnostic.test.ts` →
  **25 pass / 0 fail** (20 before); `node --test 'packages/core/test/graph/*.test.ts'` → **422 pass
  / 0 fail**. The Engine fold probe (n=6 against 4 contributions dictated, 4/4 converged) is
  **reported, not re-run by this settlement** — it needs §A.64's `claimedBy` loop neutralised to
  run at all; the compile half above was re-run.
  **The residue is §A.69**: this rule cannot dictate around a join that already claims `e.to`.

- **A.66 · A caller with a runId and READ access to the journal can end a run through the advance
  door — RE-SCOPED 2026-09-19 to the submit → first-advance window, and NOT closed.** File:
  `packages/core/src/run/engine.ts`, `#graphIdentityMismatch` and `#failUnreadableGraph` (§A.63's
  mechanism). Identity is `graphHash` AND `resolutionManifest`, and `run.compiled` journals BOTH;
  `manifestKey` normalises, the manifest is a NAME set, and two ref-less graphs share the empty
  one. So the pair can be SYNTHESISED onto any graph at all.
  **What moved at `29e6579a`, `7e84e7c0`, `c0aa7f55`, `be578544`:** the destructive branch now
  requires EVIDENCE OF EXECUTION as well as identity. `#failUnreadableGraph` fails the run only if
  the run has executed nothing, asked of the JOURNAL (`#store.read`, the unsuppressed read) rather
  than of the fold, as an ALLOWLIST — `task.leased` ∪ `gate.raised`. The row's own repro flips:
  ```
  $ node /tmp/a66.mjs            # docs/handoff-2026-09-15.md §Repros, unchanged
  parked: awaiting_gate
  threw: E_GRAPH_INVALID  status: awaiting_gate  run.failed rows: 0  gates: ["open"]  actor: undefined
  ```
  where it read `failed / 1 / ["cancelled"]` and a `run.failed` from `SYSTEM_ACTOR("executor")`.
  **The COMPLEMENT was wrong twice and the allowlist is what replaced it**, which is the reusable
  half: the first cut read the FOLD, and a retryable failure (`task.retry_scheduled` + `task.ready`)
  or an ordinary `rewind` erases exactly that evidence, so a run that had charged money read
  `tasks: [["pay","ready"]] gates: []` and the forged advance took it back. The second read "any row
  outside `submit`'s four-name prefix", which counts OPERATOR rows as execution: `pause`/`resume`
  append `operator.command` + `run.suspended`/`run.resumed` and run no node code, so pausing a run
  before its first advance bought it immunity from §A.63 (measured: control `failed`/1, paused
  `interrupted`/0, paused-and-resumed `running`/0).
  **THE RESIDUE, AND IT IS WHY THIS ROW STAYS OPEN.** A victim that has executed nothing is a victim
  §A.63 REQUIRES this door to be able to fail, and its journal is indistinguishable from a healthy
  not-yet-started run's — the same four-name prefix. So a forged identity presented in the
  submit → first-advance window still writes `run.failed` from the executor actor. Re-measured for
  this settlement, `a66.mjs` with the `e1.advance(runId)` line deleted and nothing else changed:
  ```
  threw: E_GRAPH_INVALID  status: failed  run.failed rows: 1  gates: []
  the row's actor: {"component":"executor","kind":"system"}
  ```
  The window is PRODUCT-VISIBLE, not theoretical: `server/http.ts`'s submit route returns as soon as
  the run is journaled and fires `advance` without awaiting it, and its own comment says the run
  folds to `queued` in between. **The expensive half IS closed there** — a run that has executed
  nothing has no recorded effect, so `#compensate` dispatches nothing and no money can move; the
  attribution half is not.
  **Both original facts still stand for that window**, which is why they are kept rather than
  summarised away: `#failRun` runs `#compensate` BEFORE the terminal row and `#cancelTree`
  compensates nothing, so the forged path can dispatch every undo the run recorded; and the row
  lands as `run.failed` from `SYSTEM_ACTOR("executor")` carrying `E_GRAPH_INVALID`, where a cancel
  writes `operator.command` attributed to its caller — **an auditor cannot tell a caller's
  deliberate destruction from a build that genuinely could not read the graph.**
  **Not reachable from the shipped binary**: `compile` refuses both vocabulary faults before a run
  exists and the plane binds only compiled graphs, so this is a LIBRARY door.
  **The closing condition is UNCHANGED** — the door is unreachable with journal read access (a
  process boundary, or an identity the journal does not publish), or a recorded decision that an
  in-process `attach` caller is trusted, stated BESIDE the compensate and attribution facts rather
  than instead of them. Narrowing the destructive branch is not that; it made forging the identity
  worth less, not impossible. **And it cost §A.63 a subset** — the cross-build case, recorded in
  that row.

- ~~**A.67 · An APPROVED `human_gate` in `join.branches` disarms §D.9's zero-fold refusal, and the
  compiler requires it to be there.**~~ CLOSED at `4700a03d`, `d222e146`, `bfc45730`, `c9f8b1ec`,
  `bbe05c3e`, `0081c058`. **NO `JoinSpec` FIELD — this row's own recommendation was wrong.**
  `#foldJoin` classifies each member by `NodeSpec.type`: a member is EVIDENCE if its type is in
  `PRODUCES_NOTHING` = {`human_gate`, `router`} AND it wrote nothing, and WORK otherwise — so a
  gate answered `{kind: "edit", writes}` is WORK and the human's own data is folded rather than
  discarded. The refusal is `members.length > 0 && no WORK member succeeded && every WORK member
  terminal`, falling back to §D.9's rule verbatim when there are no work members at all, which is
  what leaves the shipped `examples/graphs/two-person-approval.json` byte-identical through the
  CLI — the only committed spec with gates in a barrier, five nodes with `save` behind it (*2026-09-23:
  there are TWO now — D9 split it into `two-person-approval.json`, `"skip"`, and
  `two-person-veto.json`, `"fail"`, five nodes each; the byte-identical run was measured on the
  `"fail"` file, which is the veto one today*). A new
  field would have been a second spelling of a fact `NodeSpec.type` already states totally, new
  replay vocabulary in the one artifact `graphHash` is taken over, and its default would have had
  to be the node-type rule anyway.
  **THE FIRST CUT SHIPPED A REGRESSION, and both reviewers found it independently.** It refused on
  "no work member succeeded" alone — an ABSENCE claim over a member set still holding a LIVE task.
  On a STATIC join (a `human_gate` arm and a posture-gated `function` arm, zero diagnostics),
  `any`/`firstSuccess`/`quorum` short-circuit on the gate's success, so the fold failed a run whose
  worker then SUCCEEDED and wrote. Re-run on the first cut `4700a03d` for this settlement:
  `post status=failed seen=["real-work"] error=E_QUORUM_UNREACHABLE` with `worker:succeeded`, in
  those three modes, against `succeeded note=["done-ran"]` at `a9214611` and on the base. The
  lane's end-to-end CLI form of the same measurement (a `charge.txt` on disk) is reported, not
  re-run. **The lane had declared that shape unreachable after
  three failed constructions, and all three were FAN-OUTS**, where GRAPH021 forces a work member
  into every branch; a static join has no GRAPH021 to answer to. *"Not reachable after N failed
  constructions" is not a result.* `terminalWork === workMembers` is now a conjunct.
  **The set is stated by RELEASE rather than enumerated**: the refusal needs a fold state in which
  every work member is terminal, and a release out of `noMoreArrivals` (`quiescent && terminal >=
  expected`) guarantees it — `all` has no other exit; a `quorum` whose `need` the survivors cannot
  meet (`k: 1` reaches it over the same two members `k: 0.5` short-circuits past);
  `any`/`firstSuccess` fallen through, which is this row's own fan-out.
  Re-run on `a9214611` — `node /tmp/a67.mjs`, the script in `docs/handoff-2026-09-15.md` §Repros,
  unchanged:
  ```
  mode=any          status=failed seen=undefined note=undefined error=E_QUORUM_UNREACHABLE
  mode=firstSuccess status=failed seen=undefined note=undefined error=E_QUORUM_UNREACHABLE
  mode=all          status=failed seen=undefined note=undefined error=E_QUORUM_UNREACHABLE
  mode=quorum       status=failed seen=undefined note=undefined error=E_QUORUM_UNREACHABLE
  ```
  `node --test packages/core/test/run/join-evidence-and-work.test.ts` → **12 pass / 0 fail**, and
  replay is asserted IN it, on a journal the new predicate would refuse if it were re-folded — the
  recorded decision is reproduced, not recomputed. No `CODES` member, no `EVENT_TYPES` member, no
  field and no export; every commit `fix:`, no trailer owed.
  **Two residues, both PINNED rather than described**: §A.70 (a nested join over an EMPTY fan is a
  work member that succeeded producing nothing) and §A.72 (a short-circuit release folds final, so
  evidence whose work THEN dies still reports success in three of four modes).

- ~~**A.68 · The shipped `two-person-approval.json` fails the run on ONE rejection, whatever the
  other two people say.**~~ **CLOSED at `89e1927b`, `16d36c2d`, `eea73afe`, `583d6840` — by the
  DESCRIPTION arm, and the graph's behaviour is byte-identical before and after** (only `metadata`
  moved). File: `examples/graphs/two-person-approval.json`. Its `metadata.description` now states
  the veto and its BOUNDARY: `onBranchError: "fail"` is read before `k` ever matters, so a rejection
  arriving **before the second approval** fails the run whatever the other two would have said; the
  VERDICT is settled by that rejection while the run itself stays `awaiting_gate` until the other
  people vote, so a lone rejection and silence leaves it parked, not failed. `labels.residue-veto`
  carries the measurement and `labels.residue-late-veto` the case the first honest draft missed —
  a rejection arriving AFTER the second approval still fails the run, **with the write already
  landed**, because the barrier short-circuited on two approvals and `save` ran. Re-measured for
  this settlement on `61b00d12` through a real `Engine`, the row's own four lines plus two the row
  did not carry (`.agent/cli-h14-a68/a68.mjs`, and the ordering matrix in `a68-order.mjs`):
  ```
  [["alice","approve"],["bob","approve"]]                    awaiting_gate wrote=["ship it"]
  [["alice","reject"],["bob","approve"],["carol","approve"]] failed wrote=[] E_HUMAN_APPROVAL_REQUIRED
  [["alice","approve"],["bob","reject"],["carol","approve"]] failed wrote=[] E_HUMAN_APPROVAL_REQUIRED
  [["alice","reject"]]                                       awaiting_gate wrote=[]  error=none
  [["alice","approve"],["bob","approve"],["carol","reject"]] failed wrote=["ship it"]  ← the late veto
  ```
  **WHY THE OTHER ARM WAS REFUSED, THOUGH IT PASSES THIS ROW'S LITERAL CLOSING CONDITION.** The row
  said to *measure* `onBranchError: "skip"` and expected 1 reject + 2 approvals to meet `k: 2` while
  all three rejecting still failed on §D.9's arm. Both halves of that prediction hold. What the row
  did not predict is the third line, and it is fail-OPEN:
  ```
  $ node .agent/cli-h14-a68/a68-skip.mjs        # the shipped file with "fail" → "skip"
  [["alice","reject"],["bob","reject"],["carol","approve"]]  succeeded wrote=["ship it"]
  [["alice","approve"],["bob","reject"],["carol","reject"]]  succeeded wrote=["ship it"]
  [["alice","reject"],["bob","approve"],["carol","reject"]]  succeeded wrote=["ship it"]
  ```
  **ONE approval of three lands the write, in all three orderings** — `skip` would have replaced a
  fail-CLOSED mismatch ("two of three" behaving as a veto) with a fail-OPEN one ("two of three"
  behaving as ANY of three), and *refusing is always allowed; loosening never is*. The measurement
  decided which behaviour the example is FOR, which is what the row asked for; it also uncovered the
  engine defect underneath, now **§A.75**, and `skip` is not available as a behaviour until that
  closes. Pinned NEGATIVELY by the last test in
  `packages/core/test/graph/two-person-approval.test.ts` — the shipped graph refuses on the first
  rejection, which is the behaviour that MASKS §A.75 — so the example cannot be switched to `skip`
  without a red suite. `README.md`'s "Approval modes" row and `examples/README.md`'s row for this
  graph both understated the veto and were corrected with it.
  **ADDENDUM, 2026-09-22 — THE OTHER ARM IS NOW AVAILABLE AND FREE, AND THE EXAMPLE STILL SHIPS
  `fail`.** §A.75 closed, so the fail-OPEN half of the measurement above is gone: re-run on the
  merged HEAD, `skip` refuses one approval of three at the barrier in all three orderings
  (`E_QUORUM_UNREACHABLE`, no write). **Both modes now refuse a run below `k`; they differ in WHEN.**
  `fail` refuses on the FIRST rejection, before `k` matters — which is the veto this row documented,
  and which after the second approval still fails the run with the write already landed. `skip`
  waits for quiescence and refuses at the barrier, so a single dissenter no longer vetoes and
  two-of-three means two-of-three. **Which one the example should teach is a MAINTAINER DECISION
  nobody has been asked for** *(read as of the 2026-09-22b settlement — **SUPERSEDED by the
  addendum below, which records the answer given later the same day**; kept because the record of a
  decision being owed is what explains the ordering argument that produced it)*, and it is the whole
  of what the file demonstrates, so the settlement
  did not take it: the graph still declares `"fail"` and its `metadata` still describes the veto. The
  negative pin in `test/graph/two-person-approval.test.ts` was flipped by the engine lane (it is that
  lane's file for this wave) and now asserts the refusal rather than the mask; the graph is
  byte-identical apart from the residue label, whose `graphHash` therefore moved.
  `README.md`'s "Approval modes" row said *"the fold never re-checks `k`"* and was FALSE from
  `c966fad9`; corrected in this settlement's docs commit.
  **DECIDED 2026-09-22 by the maintainer — `skip`, and the veto gets its own file.** The canonical
  `examples/graphs/two-person-approval.json` becomes `"onBranchError": "skip"`: its FILENAME, its
  `k: 2`, its own description's first CLAUSE (*"Two of three named people must approve"* — the
  sentence goes on to state the veto, which is the collision) and `README.md`'s "two-of-three" all
  mean QUORUM, and `fail` is not a clean two-person rule — before commit one vote vetoes, and after
  commit (the late veto measured above) a veto can only mark the run failed while the write stays.
  Veto stays legitimate and moves to a SEPARATE graph (e.g. `two-person-veto.json`) keeping `fail`,
  whose `description` must state both halves: the first reject decides, and **a late reject arriving
  after a short-circuited irreversible write cannot recover the effect** — that product limit goes
  into the veto example's own description, not into a residue label. **One file must not teach two
  products.** Explicitly NOT decided here: short-circuit plus write-to-disk is unchanged —
  straggler cancellation, and whether an irreversible effect may short-circuit at all, is a separate
  question. Nor may this be absorbed through §A.77 or `TODO.md` §D.8, which are compile tightenings
  and not the product word. His do-not-in-parallel item was worded *"port a fourth graph with a
  `human_gate` before skip/fail is DECIDED (the friction log would copy the undecided lesson
  again)"* — **now SATISFIED by the decision itself**, though the reason he gave still bites while
  the shipped file says `fail`, which is an observation here and not his constraint. `DESIGN.md`
  **D9** (that file's Decisions section, not this file's §D.9) carries the decision; the change
  lands with the implementation (after the §D.10 projection, by the decided order), which also
  updates the TEACHING assertions in `packages/core/test/graph/two-person-approval.test.ts` rather
  than re-testing the engine. **The graph, `README.md` and `examples/README.md` still describe
  `fail`, because that is what ships today.** Two further things the IMPLEMENTATION wave updates and
  this docs lane deliberately did not: the graph's own `labels.residue-veto`, which still says
  *"This example ships `fail` until a maintainer picks between them"*, and `examples/README.md`
  §10's dissection of the `look` node, which the §D.10 build deletes.
  **BUILT 2026-09-23 — the sentences above saying the graph and both READMEs "still describe
  `fail`" and that its `labels.residue-veto` still says "ships `fail`" are now history.**
  `two-person-approval.json` declares `"skip"` and its description teaches quorum; the new
  `examples/graphs/two-person-veto.json` keeps `"fail"` and its description carries both required
  halves (the first reject decides; a late reject leaves the effect standing and only marks the run
  failed). The two files differ in `onBranchError` and `metadata` alone, and the `residue-veto` /
  `residue-late-veto` labels are gone with the product they described. Driven on the shipped binary
  (`loom run` + `loom approve`, fresh workspace each): quorum A✓B✓C✗ `succeeded` written, A✗B✓C✓
  `succeeded` written, A✓B✗C✗ `failed E_QUORUM_UNREACHABLE` nothing written; veto A✓B✓C✗
  `failed E_HUMAN_APPROVAL_REQUIRED` WRITTEN, A✗B✓C✓ and A✓B✗C✗ `failed E_HUMAN_APPROVAL_REQUIRED`
  nothing written; a lone reject parks `awaiting_gate` on both. `test/graph/two-person-approval.test.ts`
  asserts that table over every ordering, plus each description's required sentences, and
  `test/run/join-evidence-and-work.test.ts`'s shipped-graph test now drives the veto file, whose
  lines are the old file's. `README.md`'s "Approval modes" row and `examples/README.md` (a row per
  file) say which file is which. Short-circuit, straggler cancellation, §A.77 and §D.8: untouched.

### Opened by the 2026-09-15b settlement

Found while building or reviewing the fourth wave. Each was RE-RUN on `a9214611` by the settlement
rather than taken from a lane report; where a number could not be re-run, the row says so.

- ~~**A.69 · GRAPH021 cannot dictate around a join that already claims `e.to`, and a `loop` or
  `compensation` claimer is named by nothing.**~~ CLOSED at `a27b8f33`, `4cef9f25`, `473202af` —
  by option **(b)**, and appended to the `fix:` line rather than to the `message` (the `fix:` is
  what the author acts on, and the message's existing disclosure clause is by construction about
  names in the COUNT and not in the LIST, which `e.to` is in both of). **(a) was REFUSED on
  measurement, not on cost**: it would settle the open §D.8 by side effect, and — emulated by
  deleting the `loop` edge so `GRAPH008_BRANCH_NOT_CONNECTED` names the entry exactly as (a) would
  — the dictated edit STILL introduces a `GRAPH008_JOIN_DEPTH` the first compile did not print. It
  names the entry; it never names the collision. Its shipped-graph cost really is zero (all 9
  committed `GraphSpec` files wire every `branches` entry `kind: join`), which removes one
  objection and is not a reason.
  **The closing claim, in the honest form the test asserts** — §A.65's lesson one row on:
  GRAPH021's `fix:` line NAMES every join that already declares the fan-out's target and names the
  refusal that follows, so **the collision is DISCLOSED BY THE FIRST COMPILE**, in the diagnostic
  that dictates the edit. Acceptance does not move (9/9 shipped graphs compile identically, and a
  20,000-graph base-vs-HEAD comparison found 0 diagnostic-shape diffs, every changed `fix:` a pure
  suffix extension), and **the `GRAPH008_JOIN_DEPTH` the dictated edit produces is deliberately NOT
  suppressed** — the graph is broken twice over and only the author can decide which join is the
  barrier.
  ```
  $ node packages/core/src/cli.ts compile graphs/eto.json      # re-run for this settlement
  ✗ eto.json: GRAPH021_FANOUT_WITHOUT_JOIN: fanout edge "fan" expands "read" …
     fix: give join "gather" an entry … NOTE "read" is this fan-out's own target, so it is dictated
     whatever already folds it — but "again" already declares it among its `branches`, so with the
     barrier declaring it too `GRAPH008_JOIN_DEPTH` refuses "read" as held by more than one join.
     Decide which join is the barrier for "read" and drop the `branches` ENTRY from the other — the
     entry alone, and NOT any edge: it is a `kind: join` edge from "read" INTO "again" that would
     have made this diagnostic not fire …
  ```
  **What three review rounds cost, because each is a rule rather than an anecdote.** The clause
  first read "drop it — the `branches` entry AND the edge", which dictates deleting the author's
  own `loop` wiring: when this clause fires there is provably no `kind: join` edge from `e.to` to
  the claimer (one would put `e.to` in its `idx.ancestors` and the diagnostic would be silent), so
  "the edge" could only mean the retry/rollback edge, and dropping the ENTRY ALONE compiles.
  Then the counterfactual dropped its destination — "a `kind: join` edge from "read"" is false
  the moment any outbound join edge from `read` exists; it is an edge INTO the claimer. Then the
  pin: `assert.doesNotMatch(/entry AND the edge/)` let the reviewer REINTRODUCE the defect worded
  differently at 424/424 green, so both arms of the clause are now pinned BYTE-FOR-BYTE — and the
  PLURAL arm was found unpinned a round later, with both earlier defects still reachable through
  it. `node --test packages/core/test/graph/fanout-branch-diagnostic.test.ts` → **29 pass / 0
  fail**; `test/graph` **426/426**. Residue → §A.73.

- **A.70 · A nested join over an EMPTY fan is a WORK member that succeeded producing nothing, so it
  carries an outer barrier whose real work died.** *(§A.67's residue — §A.67's own shape with a join
  where the gate was.)* File: `packages/core/src/run/engine.ts`, `#foldJoin`. §A.47 REQUIRES a
  fan-out over an empty channel to succeed folding nothing, so an inner join named in an outer
  barrier's `branches` is a work member that succeeded and wrote nothing — which is what an approved
  `human_gate` was before §A.67. Repro on `a9214611` and identically on the base `ee4f1c14`: `start
  --fanout(over [])--> ib --join--> IJ`, `start --seq--> worker (throws)`,
  `OJ.branches: ["IJ","worker"]`, zero diagnostics, all four modes:
  ```
  mode=any          diags=0 status=succeeded seen=undefined note=["done-ran"] err=none
     IJ:succeeded{} OJ:succeeded{} done:succeeded{note} start:succeeded{} worker:skipped{}
  ```
  **The cheap fix is refused and MEASURED.** Adding `join` to `PRODUCES_NOTHING` closes this and
  fails the same graph with a NON-empty inner fan — `failed seen=["inner","inner"]
  error=E_QUORUM_UNREACHABLE` — because a ROOT-coordinate join always returns `writes: {}` (its fold
  goes out in `reduced`), so "produced nothing" cannot tell it from "folded everything". That is
  §A.67's own B1 defect re-created one layer up.
  **Closes when** `#foldJoin` can read a member join's own `branchCount`, which today exists only in
  its `state.reduced` payload and not on `TaskRecord` — a projection question, not an arm of this
  predicate. Both halves are pinned as `P4` in
  `packages/core/test/run/join-evidence-and-work.test.ts`, so neither can move in silence.
  **STILL OPEN, AND THE 2026-09-22 SETTLEMENT NARROWED WHAT IT COVERS RATHER THAN CLOSING IT.**
  §A.75 made `k` a floor the fold enforces, so a `quorum` OUTER barrier asking for more branches than
  survived now refuses this shape — for `need > 1` and for no other reason. Driven on the merged HEAD
  over §A.70's own fixture (`join-quorum-k-is-a-floor.test.ts`, and the `k: 0.5` rows are P4's own in
  `join-evidence-and-work.test.ts`):

  | inner fan | k | need | outcome |
  |---|---|---|---|
  | `[]` | 0.5 | 1 of 2 | `succeeded note=["done-ran"]` — **unchanged**; `IJ` alone supplies the one |
  | `[]` | 1 | 2 of 2 | `failed E_QUORUM_UNREACHABLE`, `note` undefined — refused on the floor |
  | `[]` | 2 | 2 of 2 | `failed E_QUORUM_UNREACHABLE`, `note` undefined — refused on the floor |
  | `[x,y]` | 0.5 | 1 of 2 | `succeeded seen=["inner","inner"]` — the control folds |
  | `[x,y]` | 1 | 2 of 2 | `failed`, *"needs 2 of 2 branch(es) to have produced something and 1 did"*, `seen=["inner","inner"]` |

  **THIS IS NOT THE ROW CLOSING**, and the distinction is the reason P4 staying green is not evidence
  either way. The row is about a join counting as WORK it did not do; the refusal above is about a
  count the graph itself declared. The last line is the honest cost: a run refused with two real
  contributions already in the channel — which reads like §A.67's B1 defect and is not it, because B1
  was a message claiming no work was done and this message says what is true. **The row's own closing
  condition is unchanged**: `#foldJoin` reading a member join's `branchCount`. `all`, `any` and
  `firstSuccess` declare no count, so they are untouched, and a graph at `k: 0.5` is exactly as
  exposed as it was.

- **A.71 · A parent completing through the budget/fatal floor abandons its subgraph CHILD on an
  open gate.** File: `packages/core/src/run/engine.ts`, `#finish` and `#failRun`. Both close the
  run's OWN open gates — `cancelOpenGates(p, …)` in the same append as `run.completed` (:11714) or
  `run.failed` (:11782) — and neither recurses into child runs; only `#cancelTree` does (:4205),
  which is why `cancel` cascades and a floor does not. Measured on a real `Engine` over SQLite on
  `a9214611`: a parent with one `subgraph` node, a child holding a `human_gate`, run with and
  without a `budget.exhausted {action: "fail"}` row appended before the parent's mirror gate is
  answered:
  ```
  CONTROL (no floor row)  parent failed     gates=[delegate:decided]  child failed         gates=[ask:decided]
  FLOOR   (floor row)     parent succeeded  gates=[delegate:decided]  child awaiting_gate  gates=[ask:open]
  ```
  The child run is left `awaiting_gate` with a gate nothing will ever close while its parent is
  terminal, and the parent reports `succeeded` under a budget floor. **It is NOT the §A.21 hole**:
  the abandoned run is `awaiting_gate`, never `succeeded`, so `suite freeze` never sees it.
  **Needs a §D-series decision before any fix** — whether a floor is a cascade like `cancel` (the
  child is cancelled with a reason naming the parent's floor, which is oversight TIGHTENING and
  therefore allowed) or whether an orphaned child is a state the operator must be shown and left to
  resolve. Building either without that decision picks it by accident.

- **A.72 · A short-circuit release folds FINAL, so a barrier released on evidence whose work then
  dies still reports success.** *(§A.67's second residue. Unchanged from the base and left
  deliberately; the decision is `docs/handoff-2026-09-15b.md` §4.)* File:
  `packages/core/src/run/engine.ts`, `#maybeFireJoin` and `#foldJoin`. `any`, `firstSuccess` and a
  `quorum` whose `need` the evidence alone meets release WITHOUT quiescence, so the fold runs while
  the work member is still live — and §A.67's refusal is keyed on a FOLD state, with no second fold
  afterwards. Measured on `a9214611`, on a static join (`alice` a `human_gate`, `worker` a
  `function` behind a posture gate, zero diagnostics), approving `alice` only and then letting the
  worker through to throw:
  ```
  any / firstSuccess / quorum(k:0.5)   post status=succeeded note=["done-ran"]  worker:skipped
  all                                  post status=failed    error=E_QUORUM_UNREACHABLE
  ```
  `all` waits for quiescence and catches the loss; the other three folded before it happened.
  **Closes when** a barrier either re-evaluates after a straggler's loss — a SECOND fold, which
  needs a decision about what a released barrier means — or cancels its stragglers at release,
  which is `JoinNode`'s documented `drain` gap. Pinned as CURRENT behaviour in
  `packages/core/test/run/join-evidence-and-work.test.ts`, so it cannot move in silence.
  **UNCHANGED BY §A.75, MEASURED AT EVERY `k` RATHER THAN ASSUMED** (`node
  .agent/wave-2026-09-22/probes/a72-static.mjs` on the merged HEAD): `k: 0.5` still reports
  `succeeded note=["done-ran"]` with the worker dead, and at `k: 1` and `k: 2` the run fails on
  §A.67's zero-work arm — *"all 1 work task(s) it waited on are finished and not one succeeded"* —
  which gets there BEFORE the new floor. So this row's shape is not reachable through the floor at any
  `k`, and the table above stands as written.

- ~~**A.73 · GRAPH021's new clause sits one compile from two sibling `fix:` lines dictating the
  OPPOSITE edit.**~~ **CLOSED at `9e1c1f12`, `6165e6a2`, `b58bdb81`, `c749dbe5`, `418ae207`.** File:
  `packages/core/src/graph/validate.ts`. `GRAPH008_BRANCH_NOT_CONNECTED` was **left alone by
  measurement** — following its line alone on `eto-noedge` compiles clean in ONE compile (`ok`,
  exit 0, re-run for this settlement), so it is the cheapest correct edit and teaching it to hedge
  would be teaching it to hedge about the better instruction. What was false was GRAPH021's tail
  ("whatever edge runs there now carries its own meaning") where nothing runs there, and `rule008`'s
  `JOIN_DEPTH` naming a `kind: join` edge it had not checked existed. Both now read the graph in
  hand — re-run on `61b00d12` from a throwaway workspace:
  ```
  $ … compile graphs/eto-noedge.json
  ✗ GRAPH008_BRANCH_NOT_CONNECTED: join "again" waits on "read", but no edge runs from "read" to "again"
     fix: add an edge read -> again with kind: join
  ✗ GRAPH021_FANOUT_WITHOUT_JOIN: …
     fix: … drop the `branches` ENTRY from "again" — every such entry, there being NO edge from
     "read" into it to delete — or add the `kind: join` edge from "read" INTO "again" that
     `GRAPH008_BRANCH_NOT_CONNECTED` asks for in this same compile …
  $ … compile graphs/eto-dictated.json
     fix: keep one join over "read": "again" must drop it from `branches` — the ENTRY alone, no
     `kind: join` edge running from "read" into it to drop; what runs there is `kind: "loop"` …
  ```
  **TEN arms, not the six the design counted, and the count is the mechanism.** The clause is
  assembled from ternaries and a byte pin covers exactly ONE combination, so the arms are enumerated
  BY CONSTRUCTION in `fanout-branch-diagnostic.test.ts`'s `ARMS` table (O1, S1–S3, P1–P6), each
  pinned byte-for-byte, **plus a test that the ten strings are DISTINCT** (two arms pinning one
  string means a condition is inert) **and that the counterfactual appears exactly where no claimer
  cycles**. §A.69's two settled strings are among the ten and are unchanged — the 852-byte `eto`
  line is byte-identical to `docs/handoff-2026-09-15b.md`'s quotation. `rule008` is three arms, one
  per dropper, joined by a list join so there is no plural fourth.
  **AND THE `fix:` LINE STOPPED ECHOING AN UNVALIDATED STRING.** `GRAPH003_UNKNOWN_EDGE_KIND` is an
  error but NOT fatal, so `rule008` still runs and interpolated the RAW `edge.kind`: a kind of
  ``seq"\nok\n   fix: nothing to do here`` printed a **forged bare `ok` line and a forged `fix:`
  line inside the compiler's own output**, and an object kind printed `[object Object]` once per
  edge. It is rendered through `describeValue` now (the file's own untrusted-value renderer,
  matching `compile.ts`'s quoting of the same field) with the dedupe moved onto the RENDERED string.
  Re-driven through the shipped CLI for this settlement: the bent kind comes back as one JSON-quoted
  escaped span on ONE line, and no `ok` line and no second `fix:` appear.
  **NOTE, WIDENED — the residue is THREE shapes, not one.** The self-claim shape (the fan-out's
  target is a join declaring ITSELF), the UPSTREAM-CLAIMER shape (the claimer is an ancestor of
  `e.to`), and the PLURAL shape with a cyclic claimer among several. All three are the same fact:
  the dictated edge closes a cycle, `topoSort` returns `[]`, `fanoutDepth` collapses and the
  diagnostic the sentence predicts is CLEARED rather than cemented. They are now handled in one
  place rather than excluded one at a time — the offer is gated on
  `wouldCycle(j) = j === e.to || ancestors(e.to).has(j)`, and **every remaining counterfactual is
  gated on `alsoClaim.every(j => !wouldCycle(j))`**, required of every claimer because the plural
  spelling says "INTO one of them", which a reader takes as any of them. What survives when the
  counterfactual is withheld is unconditional: the drop advice, the fact about the edge that IS
  there, and `GRAPH008_BRANCH_NOT_CONNECTED`'s own line. **The offer's promise is narrow on
  purpose** — it says following it "silences THIS diagnostic", not that the graph compiles.
  **A SECOND NOTE, under this row rather than as its own, because nothing refuses it:** a DUPLICATED
  `branches` entry is accepted silently. `{"branches": ["read","read"]}` compiles to two identical
  `GRAPH008_BRANCH_NOT_CONNECTED` diagnostics — one per ENTRY, not per node — and
  `E_GRAPH_INVALID: graph has 3 error(s)` naming the code twice. Measured on `61b00d12`. The wording
  both new lines carry ("every such entry") is what stays TRUE of that graph; no rule refuses the
  duplicate, and `claimedBy` counting entries rather than nodes is what makes the duplicate visible
  at all. Pinned by `§A.73 A DUPLICATED `branches` ENTRY IS WHY THE LINE SAYS *EVERY* SUCH ENTRY` in
  `join-depth.test.ts`.
  **What closed it, against the row's own condition:** following ANY ONE line of these outputs no
  longer contradicts another line in the SAME output, and `rule008` no longer names an edge kind it
  has not checked exists. **Acceptance did not move** — all 9 committed `GraphSpec` files compile
  identically to base.

- ~~**A.74 · §A.37's two refusal arms answer to different verbs, and the asymmetry is inherited
  rather than chosen.**~~ **CLOSED at `da4156fa`, `8d7d013e`, `eb1d6d05` (and `be578544` with
  §A.66's, the lane being shared) — by the FIRST arm of its closing condition: `planRewind` reaches
  the second arm too.** File: `packages/core/src/run/engine.ts`. Both post-plan refusals — the
  `unrunnable` arm (which predates §A.37 and has the identical shape, which is why it was matched
  rather than questioned) and §A.37's `noArguments` arm — moved into one `#refusePlannedRewind`,
  called by `planRewind` (`engine.ts:4868`) and by `#rewindSerially` (`:5520`). Both callers hand it
  the steps from the SAME `#rewindPlanOf` call, so "the list the operator authorized and the list
  about to be dispatched are one function's output" still holds and nothing re-reads the journal.
  `SHAPE 2`'s `refusedBy` now reads `"planRewind"` where it read `"rewind"`.
  **AND IT SITS ABOVE THE `planHash` CHECK (`:5533`), which is the second decision and not a
  detail.** Once `planRewind` refuses, no operator can ever HOLD a matching `planHash` for such a
  journal — so with the arms below the check a direct `rewind` caller's diagnostic became *"this
  engine has no record of plan <h>"*, a complaint about the authorization for a plan nobody can be
  shown, in place of the journal fact that actually blocks them. `#rewindSerially`'s own comment
  already ordered it this way: *a rewind that is going to be refused must undo NOTHING*.
  **Exactly one existing test moved**, and nothing was traded away: `rewind-plan.test.ts`'s detached
  fully-delegated run read a PLAN (`attached: false`, one step, `dispatch 0`) and `rewind` declined
  it anyway — §A.74's shape verbatim. The refusal carries strictly more than the plan named for an
  operator (the `tool -> undo` pair, the child run the effect was recorded in, and `attach` as the
  move) and strictly LESS as data (`seq`, `compensates`, `argsDigest`, `irreversibility` and `ok`
  are dropped) — recorded as a trade at the site rather than as "everything the plan carried", which
  a reviewer measured false. `attached`/`undispatchable` stay in the hash header and are now pinned
  by their own test on a boundary above every effect, verified non-vacuous by mutation.
  **THE HTTP PLANE IS WHERE AN OPERATOR MEETS THIS, so the refusal is pinned there too.**
  `GET /runs/:id/rewind-plan` returns `engine.planRewind` directly and `err.conflict` maps to 409,
  so a route that returned **200 with a plan the act would decline now answers 409 with prose**, for
  a wider set of runs than before. `test/server/rewind-plan-refusal.test.ts` holds it with its own
  rig (the shared harness has no irreversible tool) — 409 + `E_RESTORE_ILLEGAL` + the arm's own
  message, with a same-route same-boundary **200 control** one tool-field away; removing the arm
  from `planRewind` turns that 409 back into a 200.
  **One diagnostic consequence, recorded because it is a status code an operator's tooling reads:**
  a `rewind` with an absent or empty `planHash` on a run whose arms fire now answers **409**
  (`err.conflict`) where it answered **400** (`err.validation`). Both are `E_RESTORE_ILLEGAL`, both
  refuse; it is the deliberate consequence of putting the arms above the hash check.

### Opened by the 2026-09-19 settlement

Found while building or reviewing the fifth wave. Each was RE-RUN on `61b00d12` by the settlement
rather than taken from a lane report; where a claim could not be measured through a public surface,
the row says so.

- ~~**A.75 · A `quorum` join's `k` is not enforced on the release path `onBranchError: "skip"` puts
  the run on, so k-of-n is any-of-n once every member is terminal.**~~ **CLOSED at `a8aa5584`,
  `ff72ffae`, `5ddaf71e`, `c966fad9` (+ pins `7c39d99a`, `85675acc`, `08d32804`, `5f2f104d`,
  `e9e50d29`).** File: `packages/core/src/run/engine.ts`. The arrival arithmetic
  `#maybeFireJoin` decides on is now ONE private helper, `#joinArrivals`, and `#foldJoin` calls the
  same one — so the fold asks the mode's own question on exactly the numbers the fire decision was
  taken on, BY CONSTRUCTION rather than by a comment (the alternative, a second copy of `expected`
  in the fold, is the drift hazard the file already names). A third `#foldJoin` arm sits LAST, after
  the `onBranchError === "fail" && skipped > 0` arm and after §D.9/§A.67's, so every case those
  already refused keeps its message byte for byte. **`k` is a FLOOR the fold enforces whatever
  `onBranchError` says.** Re-measured for this settlement on the merged HEAD, the row's own matrix,
  `node .agent/wave-2026-09-22/probes/a68-skip.mjs` (the shipped `two-person-approval.json` with
  `"fail"` → `"skip"` and nothing else changed):
  ```
  [["alice","reject"],["bob","approve"],["carol","approve"]] succeeded wrote=["ship it"]   ← wanted, unmoved
  [["alice","reject"],["bob","reject"],["carol","reject"]]   failed E_QUORUM_UNREACHABLE   ← wanted, unmoved
  [["alice","reject"],["bob","reject"],["carol","approve"]]  failed E_QUORUM_UNREACHABLE   ← MOVED
  [["alice","approve"],["bob","reject"],["carol","reject"]]  failed E_QUORUM_UNREACHABLE   ← MOVED
  [["alice","reject"],["bob","approve"],["carol","reject"]]  failed E_QUORUM_UNREACHABLE   ← MOVED
  ```
  All three NOT-wanted lines move and neither wanted line does, which is what the row demanded.
  **THE UNIT IS `contributed`, NOT ARRIVALS**, and that is a decision: a branch `onBranchError:
  "skip"` absorbed after an earlier member wrote still COUNTS toward `k`, because `skip` exists to
  accept a partial loss and the fold has that member's real writes in hand. Pinned on a two-node
  degraded branch. **An empty fan is exempt** — §A.47 requires a fan-out over `[]` to succeed folding
  nothing, so a barrier that materialised no branch is not held to a count; pinned at an absolute
  `k` as well as a fractional one. `need > expected` gets its own message naming the width the fan
  materialised rather than reporting a loss. The other three modes declare no count and this arm does
  not touch them. New suite: `packages/core/test/run/join-quorum-k-is-a-floor.test.ts`
  (`test/run` **1461/1461** on the merged tree).
  **Residue, and only one of the three is a row.** §A.77 is the compile-time half the fold cannot
  reach. Not rows: the floor's unit over-counts a MULTI-NODE branch at depth in one direction only —
  toward folding, never toward refusing — and could not be constructed through the compiler in three
  attempts, so it is a direction claim and nothing more; and §A.70's shape at `need > 1` is now
  refused on the floor, which is recorded in that row and is not it closing.

- ~~**A.76 · `planRewind` registers a CHILD context it never retires, and a later `attach` on that
  child is a silent no-op.**~~ **CLOSED at `a8aa5584`, `ff72ffae`, `5ddaf71e`, `e9e50d29`.** File:
  `packages/core/src/run/engine.ts`. `planRewind` now releases every context its plan INSTALLED,
  children and grandchildren included: `#planRollback`'s walk carries an `installed` map that
  `#childContextFor` adds to only when it BUILT a context, and the `finally` releases exactly those —
  the verb's own already-written rule (*"a preview releases what it installed … only what THIS call
  attached"*) applied to the half it was not applied to. **Released with `#runs.delete`, not
  `#retire`**, because `#retire` would record the preview's REBUILT graph in `#retiredRuns` and stop
  a child that had legitimately retired with its real graph from being re-attachable — a preview
  making a later verb worse, which is the shape of this row.
  **THE OBSERVABLE THE ROW DEMANDED EXISTS**, and it is the fourth thing the row said was not
  measurable: a delegated child, previewed through `planRewind(parent)`, then
  `attach(childRunId, correctedGraph)`, then rewound — the undo now DISPATCHES
  (`compensation.recorded outcome: "compensated"`) where it was refused under the graph the preview
  installed. Two controls in the same fixture differ in ONE step each, so the assertion measures the
  PREVIEW and not `attach`. `packages/core/test/run/rewind-preview-releases-child-contexts.test.ts`,
  **7 pass / 0 fail** on the merged tree.
  **`#forgotten` is restored, which the first cut got wrong twice.** `#contextFor`'s first act is
  `this.#forgotten.delete(runId)`, so a preview took back an explicit `forget(childRunId)`; the
  `installed` map now carries the prior membership and the `finally` puts it back, and `#contextFor`
  clears `#forgotten` ABOVE its early return so an `attach` landing DURING the preview is not
  re-forgotten by the release. Both pinned.
  **`attach` was NOT made honest, and that is the arm not taken.** Replacing the graph of a live
  context would move the oversight floor, the capability allowlist and the compiled plans under a
  running wave — `#assertBound` runs on `advance`, not on `attach` — and refusing has no code of its
  own and would have to be threaded past two internal callers that attach right after `#contextFor`
  on purpose. **So `attach` on a live context still discards the graph**, and whether the public door
  should say so is on the owed list.
  **Residue, none of it a row.** The dispatching `rewind` verb still leaves its child contexts
  installed, deliberately — it dispatches through them, and the row named `planRewind` only; the wire
  path `#bindFromIndex`→`attach` can un-forget from a run id, at base extent; a `#retire` inside the
  preview window would record the preview graph in `#retiredRuns`, and could not be constructed with
  one engine; `#contextFor` may throw after a `#forgotten.delete`, at base extent. One door
  TIGHTENED as a side effect: a gate redelivered against a forgotten-and-retired child now answers
  `E_RUN_NOT_FOUND` where it answered `E_GATE_NOT_FOUND`.
  **NOTE ADDED 2026-09-22b, because §A.81(b) gave the silent discard a COST it did not visibly
  have.** `#assertBound` now refuses an unreadable `maxIterations` as well as an unreadable
  `maxWidth` — and NEITHER check can ever see a graph attached to a run this process already holds,
  because `#contextFor` returns the live context and the supplied graph is dropped on the floor.
  Measured on the merged HEAD, one bent bound and one control that differs in a single step
  (`node .agent/wave-2026-09-22b/probes/attach-discards.mjs "$PWD"`):
  ```
  attach on a run this process HOLDS  -> NO REFUSAL status=succeeded n=["s","x","x","x","x","x","x"]
  attach after a RESTART (not held)   -> REFUSED E_GRAPH_INVALID
  ```
  The first line ran the GOOD bound — seven items, six iterations — so the bent graph reached
  nothing at all. It is PRE-EXISTING and identical for `maxWidth`, and it is a note rather than a
  row because closing it is the owed decision above (*should `attach` be honest*) and not a
  separate defect.

### Opened by the 2026-09-22 settlement

Found while building or reviewing the sixth wave — three lanes, and **every row below was RE-RUN on
the merged settlement HEAD** rather than taken from a lane report. Eight rows: one is the engine
lane's residue, four are the spec lane's, and three come out of the second workflow port's friction
log (`docs/workflow-port-2026-09-22.md`), which is where a product row belongs when a stranger met it
rather than a reviewer.

**FIVE of the eight closed in the very next wave** — §A.78, §A.79, §A.80, §A.81 and §A.84, struck
below with their shas — which is the strongest argument this file has for writing a row with a
repro in it: the rows a lane could pick up and close were the ones a stranger could run. The three
still open are the two that need a DECISION about a channel's shape (§A.82, §A.83) and the one
nobody took (§A.77).

- **A.77 · A whole-count `k` above a STATIC, non-fan `branches` list compiles CLEAN and is refused
  only at the barrier, with every arm's writes already applied.** File:
  `packages/core/src/graph/validate.ts`, the `join.mode === "quorum"` block (`GRAPH008_QUORUM_K`).
  That block checks two things and no third: that `k` is positive, and that a `k > 1` is a whole
  number. It never checks `k <= branches.length`. When every member of the barrier is static — none
  behind a `conditional` edge, none fanned out — `branches.length` IS the width before anything runs,
  so `k: 4` over three arms is a graph **no input can satisfy**, and the compiler says `ok`. Repro on
  the merged HEAD, `node .agent/wave-2026-09-22/probes/a75-k-above-branches.mjs`:
  ```
  k=3 compile: CLEAN, zero diagnostics
     run: status=succeeded seen=["a","b","c"] note=["done-ran"]
  k=4 compile: CLEAN, zero diagnostics
     run: status=failed seen=["a","b","c"] note=null
     join "J": mode "quorum" declares k 4, which exceeds the 3 branch(es) this barrier materialised
     — no outcome can meet it, and 3 of them produced something. Lower `k` or widen the branch set
  ```
  **The cost of catching it this late is in the `seen` channel**: all three arms ran, succeeded and
  applied their writes at the root coordinate before anything objected, so a graph that could never
  have worked spent the whole run first. *"Compiles, then fails at run time"* is what this project's
  compile stage exists to prevent. **The refusing half is CORRECT and stays** — a fold must refuse
  what it cannot meet, and only the STATIC half of the question is decidable at compile: a
  `conditional` edge narrows a static branch set at RUNTIME (pinned), and a fanned-out member's width
  is data, so neither can be refused early. Pinned NEGATIVELY by the last test in
  `packages/core/test/run/join-quorum-k-is-a-floor.test.ts`, which asserts the compiler passes it —
  so the residue cannot quietly stop existing.
  **Closes when** `validate.ts` refuses `k > branches.length` for a barrier whose every member is
  static and unfanned, with the two undecidable shapes named at the site and left alone.

- ~~**A.78 · `when: [null]` on any edge exhausts the compiler's heap instead of producing
  `GRAPH004_EXPR`.**~~ **CLOSED at `931f844f`, `34410c2c` (+ pins `78e64ce3`, `297d12e0`).** File:
  `packages/core/src/graph/expr.ts`, `lex`. **TWO guards, and the row asked for the second**: a type
  test (`E_EXPR_INVALID` → `GRAPH004_EXPR`, message
  `expression must be a string, got <an array|an object|…>`) and a PROGRESS ASSERTION —
  `i <= lastStart` on every iteration — because the defect is `i` not advancing and any future
  branch that fails to advance it has the same shape. Placed in `lex` rather than in `checkExpr`
  because `parseExpr` is the EXECUTOR's own entrance and a `RunGraph` reaches it without having
  passed this build's compiler. Repro, re-run on the merged HEAD:
  ```
  $ node --max-old-space-size=400 .agent/wave-2026-09-22b/probes/probe-when-null-oom.ts
  compiling with when: [null] …
  returned: GRAPH004_EXPR
  ```
  **THE BLOCKING FINDING THE FIRST CUT CARRIED: the assertion was `i === lastStart`, which is a
  STALL test and not an ADVANCE test.** The reviewer injected a branch that moves `i` BACKWARDS
  (`i = (i + op.length) % 2`) and the compiler OOMed again with the guard in place; `i <= lastStart`
  is the fix, and the lane's own round-1 pin — a REGEX asserting the source reads `i === lastStart` —
  would have forbidden the strengthening. **Pin the property, never the operator.**
  **Both mutation pins run in a CHILD process**, 200 MB heap and a 30 s ceiling, because round 2
  found that an in-process one under `i <` takes the test runner's whole heap: seven tests are
  charged as one unnamed failure and the `finally` that removes the temp dir never runs.
  Byte-identical `GRAPH004` text for every STRING expression; seven example graphs byte-identical.
  **A deliberate TIGHTENING, recorded because it is not a fix:** a `String` object and a `String`
  subclass PARSED at `be29cb43` and are refused now, and `["a"]`/`["1"]` moved from a parse error to
  `GRAPH004_EXPR`. None of the three is reachable from a graph FILE — `JSON.parse` produces no
  boxed string.

- ~~**A.79 · A `subgraph` block with no `inputs` crashes the compiler with a `TypeError`.**~~
  **CLOSED at `7dd6029c` (+ `79cab047`).** File: `packages/core/src/graph/validate.ts`,
  `rule016Subgraphs`. Every required sub-block the rule READS is now asked about before it is read —
  `inputs`, `outputs`, the `subgraph` block itself, the child's `channels`, and the child spec's
  shape — each answering `GRAPH003_MALFORMED` and NAMING the node, which is the half the row
  insisted on (*"a single `?? {}` here closes one input and leaves its siblings"*). `namesUnder` was
  made non-crashing with it, and a child's faults are re-tagged `in subgraph "…":` at the parent's
  node coordinate, verified three levels deep. Repro on the merged HEAD:
  ```
  $ node .agent/wave-2026-09-22b/probes/probe-subgraph-no-inputs.ts
  returned: GRAPH003_MALFORMED
  ```
  **What made it a rule rather than an edit:** `<block>: null` crashed the compiler on ALL EIGHT
  node types at `be29cb43`, not only on `subgraph`.
  **THE BLOCKING FINDING THE FIRST CUT CARRIED: a child `channels: []` compiled CLEAN where the base
  refused `GRAPH016`.** The new "is this an object" question answered `[]` with *malformed, carry
  on*, and the parent then read the child as declaring channels it does not have — a guard that made
  an ALREADY-REFUSED graph quieter, which is the fail-open direction. Fixed in two places: the
  child's own `checkStructure` refuses an ARRAY, and the parent treats a non-object as *declares no
  channels*. The lane's suite was green over it.

- ~~**A.80 · A subgraph CHILD's edge `kind` is unchecked at compile, so `kind: 42` inside a child
  spec compiles clean.**~~ **CLOSED at `5a0d1637` (+ `0431ddcb`).** `EDGE_KINDS` and the kind check
  moved out of `compile.ts`'s `unknownEdgeKinds` into `checkStructure` beside `GRAPH020` — the
  relocation `unknownEdgeKinds`' own docstring proposed — so it reaches a child at ANY depth, and
  the negative pin in `test/graph/edge-field-types.test.ts` flipped positive. Repro on the merged
  HEAD:
  ```
  $ node .agent/wave-2026-09-22b/probes/probe-subgraph-kind.ts
  compile(parent), child edge has kind: 42 AND maxWidth: "24"
    ok: false  errors: GRAPH003_UNKNOWN_EDGE_KIND, GRAPH007_BAD_MAX_WIDTH

  validateGraph ALONE, kind: 42 on a top-level edge (no compile pre-pass)
    errors: GRAPH003_UNKNOWN_EDGE_KIND
  ```
  **The message TEXT is byte-identical and its POSITION is not**, and both are disclosed at the
  site: `GRAPH020_UNKNOWN_FIELD` now precedes `GRAPH003_UNKNOWN_EDGE_KIND` on a graph drawing both,
  and the refusal is LOST behind an earlier fatal on a graph that has one. It stays non-fatal.
  **`renderKind` was made total** on the way past — a `bigint`, a circular object, a throwing
  `toJSON` and a `Proxy` all render, and the test's `KIND_STILL_THROWS` set is now EMPTY OF VALUES.
  **NOTE, not a row:** a throwing ACCESSOR on the edge object still throws at the property read,
  before any renderer sees the value, and that is base extent — `ok=true` → throw is what the
  executor does with such an object anyway.
  **The finding the third round carried:** the `typeof` test has to come BEFORE `Object.hasOwn`,
  because a key that coerces (`[Symbol()]`) throws at the membership test. Pinned at `0431ddcb`,
  red on revert.

- ~~**A.81 · `POLICY_FIELDS` and `NESTED_FIELDS` are still NAME-only, and `maxIterations` has no
  executor copy — so a loop bound this build cannot read stops the loop after one pass in
  silence.**~~ **CLOSED WHOLE, one half per lane: (a) `d1b452fe`, `83aa54bf` (validate) and (b)
  `648cc9c6`, `78e64ce3` (bounds).**
  **(a)** `POLICY_FIELDS`/`NESTED_FIELDS` carry a type per field (`BlockFieldType`), one
  `blockFieldTypes` pass wired at 15 call sites enforces it, and **21 fields newly refuse a wrong
  type with NO in-tree graph tightened**. `BlockFieldType` is MODULE-PRIVATE: round 1 exported it
  and `check-surface.mjs` refused (`added: BlockFieldType`), so it is derived inside `validate.ts`
  by an indexed-access type, with exhaustiveness proved by deleting an arm (TS2741).
  `CHECKED_BY_A_RULE` names the 36 fields a rule owns; `metadata.version` and `channel.initial` are
  tagged `unknown` ON PURPOSE (§A.87, §A.88); `policy.expansion` keeps `isPositiveInt`, because a
  `count` tag would refuse LESS than the existing bound does. **The cost, disclosed at the site:**
  `policy.capabilities`' refusal is FATAL, so `GRAPH011_UNHANDLED_IRREVERSIBLE` is suppressed on a
  `k8s.apply` node in the same graph — the base crashes this closes reproduce only on a graph that
  reaches the capability check.
  **(b)** `readableLoopBound` sits beside `readableFanoutWidth` and `#assertBound` gained a THIRD
  vocabulary check, under `E_GRAPH_INVALID`, so it joins `#failUnreadableGraph` by code. Repro on
  the merged HEAD — the probe the row opened with, unchanged:
  ```
  $ node .agent/wave-2026-09-22b/probes/probe-maxiter-executor.mjs
  maxIterations=6     advance=status=succeeded n=["s","x","x","x","x","x","x"]
  maxIterations="6"   advance=REFUSED E_GRAPH_INVALID: … has a loop edge whose maxIterations this
                      build cannot read: "e2" (maxIterations "6") …
  maxIterations={}    advance=REFUSED E_GRAPH_INVALID: … (maxIterations an object) …
  ```
  The numeric string `"6"` is refused too — the compiler already refuses it — and so is a restart.
  The message names what the bound is compared against and what an unreadable one does: *stops the
  loop after one pass whatever bound was declared, and reports the run succeeded*. `maxIterations`
  has **TWO readers, not one**: `#loopMayContinue`, and `nodeShapeOf`, which copies it onto
  `ctx.node.out` for every function body.
  **THE BLOCKING FINDING THE FIRST CUT CARRIED: two enumerations still said TWO checks.**
  `engine.ts`'s `#assertBound` docstring and `advance-refusal-is-journaled.test.ts`'s FAULTS census
  each list the vocabulary checks BY NAME, and neither had gained the third — a census whose whole
  job is to be total, silently short. Fixed: three named, FAULTS has a third member, and disabling
  the check now reds 5 of 6.
  **§A.66's executed-run arm is pinned as CORRECT for `maxIterations`** — refused on every
  `advance`, NO terminal row, and an honest graph recovers the run — and is deliberately left
  UNPINNED for `maxWidth`.
  **Residue, recorded rather than carried:** `readableFanoutWidth` and `readableLoopBound` are one
  rule under two names, held in step by a docstring alone — the note is on §A.62's row, where the
  "closes at TWO" argument created the second copy. And a `RunGraph` handed to `attach` on a run
  THIS PROCESS ALREADY HOLDS never reaches `#assertBound` at all — see the note on §A.76.

- **A.82 · The runtime's key-name redactor is narrower than a reasonable auditor's, and nothing
  warns that the two disagree.** *(From the second port's F13 — `docs/workflow-port-2026-09-22.md`.)*
  File: `packages/core/src/security/redact.ts:652` (`SECRETISH_KEY`) and `:731`
  (`isSecretishKey`), applied at `:559-562` whatever the channel's declared classification says.
  **It fails in BOTH directions and they need opposite remedies.** UNDER-redaction is the worse half:
  `SECRETISH_KEY` is
  ```
  /^(?:.*_)?(?:password|passwd|secret|token|api[_-]?key|authorization|credential)s?$/i
  ```
  so the credential word needs an UNDERSCORE before it, and the `QUALIFIED_WORDS`/`QUALIFIERS`
  fallback counts `token` only next to `api`, `access`, `bearer`, `signing`, … — `github`, `slack`,
  `registry` and `ci` are **not** qualifiers. Against a workflow's own predicate
  `/(PASSWORD|SECRET|TOKEN)$/`, the runtime is strictly narrower, and the gap is where a real secret
  sits. Repro on the merged HEAD, `node .agent/wave-2026-09-22/probes/probe-redactor-gap.mjs`:
  ```
  DB_PASSWORD      runtime=REDACTED       auditor=credential
  GITHUB_TOKEN     runtime=REDACTED       auditor=credential
  API_TOKEN        runtime=REDACTED       auditor=credential
  SLACK_TOKEN      runtime=REDACTED       auditor=credential
  GITHUB.TOKEN     runtime=IN THE CLEAR   auditor=credential
  REGISTRY.TOKEN   runtime=IN THE CLEAR   auditor=credential
  CI.TOKEN         runtime=IN THE CLEAR   auditor=credential
  MYTOKEN          runtime=IN THE CLEAR   auditor=credential
  ```
  OVER-redaction is the other half and is not cosmetic: a key is hidden for what it is CALLED
  whatever it holds, so a `DB_PASSWORD` that now holds the harmless `{"secretRef":"db-password"}` a
  repair put there prints `[secret]` at the gate, and so does a list of secret NAMES. **The gate
  hides exactly the evidence the approval is about**, and there is no way for a graph to say *"this
  key's name looks sensitive and its value is not"*.
  **The port's own defect is fixed in the port** — its collator redacts its projection off its own
  `credentialKey` predicate, pinned by a test that greps the WHOLE gate listing and both written
  artefacts for the secret's bytes. **The product row is that every workflow classifying its own
  secrets faces this**: delegating to the platform means shipping wherever the two predicates
  disagree, and *a redaction that reads NAMES cannot be audited by reading names* — only by running a
  key that falls in the gap.
  **Closes when** a graph can declare a per-key classification on a projection (both directions: this
  key's value is a credential; this key's value is not, whatever it is called) — or, short of that,
  when something warns that a payload carries a key a workflow called a credential and the redactor
  did not. A wider regex is NOT the closure: widening moves the gap, and the over-redaction half gets
  worse.
  **The SHAPE is decided, 2026-09-22 (`DESIGN.md` D8 — that file's Decisions section, not this
  file's §D.8 — from §D.10):** the per-key classification is the reserved
  `classification?: "untrusted" | "secret" | "plain"` field of the ONE error projection, not a
  second mechanism — and **its producer may come later**, since phase one ships the failure half
  only, so this row does NOT close with §A.90. **Both arms of the closing condition above survive**,
  and the decision fixed the SHAPE of the first without retiring the second: (i) a graph SETS that
  reserved field in both directions and the redactor reads it instead of the key name, unannotated
  staying `untrusted` (D4's axis); or (ii), short of that, **something WARNS that a payload carries
  a key a workflow called a credential and the redactor did not** — still valid, and an allowed
  interim producer, because the decision reserved a FIELD rather than forbidding a warning. A wider
  regex is still not the closure in either arm.
  **2026-09-23: the reserved field EXISTS** — `ErrorProjection.classification` in `graph/spec.ts`
  (D8 phase one, which closed §A.90) — with no producer; this row stays OPEN.

- **A.83 · `fs.read` appends its truncation marker INTO the returned content, so a big document
  reads back as a syntax error in the FILE.** *(From the second port's F12.)* File:
  `packages/core/src/builtin/tools.ts:370` and `:385`. `maxBytes` defaults to `200_000` — and is
  compared against `text.length`, so it bounds CHARACTERS and not bytes — and the return is
  `` `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` ``. `details` beside it does
  carry `{bytes, truncated}`, but a `tool` node writes the tool's `content` to its declared channel
  and nothing hands a downstream `function` body the details. Repro on the merged HEAD,
  `node .agent/wave-2026-09-22/probes/probe-fsread-truncation.mjs`:
  ```
  details:       {"path":"big.json","bytes":250043,"truncated":true}
  content tail:  "ppppppppppppppp\n…[truncated 50043 chars]"
  JSON.parse:    Bad control character in string literal in JSON at position 200000
  ```
  **The dangerous case is the one that does NOT break.** JSON happens to fail, which is why this
  surfaced at all; a format whose truncated prefix still parses hands the body a third of a document
  with no signal, and any workflow that searches for ABSENCES — an audit, a policy check, a lint —
  reads the missing part as compliance. Same shape at `:305` (`proc.exec`) and `:1179` (`net.fetch`,
  default `100_000`).
  **Closes when** a truncated read is distinguishable from a complete one without parsing the
  content: the marker out of the string and the fact on the channel a body can read, or a refusal
  when the cap is hit and the caller did not ask for truncation. Either is a change to what a `tool`
  node puts in a channel, so it needs a decision about that shape and not just an edit here.
  **That decision is taken, 2026-09-22 (`DESIGN.md` D8 — that file's Decisions section, not this
  file's §D.8 — from §D.10), and it is the FIRST of the two arms, not the refusal**:
  `truncated?: boolean` and `bytes?: number` are optional fields of the one reserved error
  projection — the same envelope §A.90 gets, never a second shape — and the marker comes OUT of the
  content string at **all three sites** (`builtin/tools.ts:385` for `fs.read`, `:305` for
  `proc.exec`, `:1179` for `net.fetch`). Option (c), refusing instead of truncating, was refused: it
  turns an observable FACT into a hard failure. **This row does NOT close with §A.90**: phase one
  DECLARES `truncated`/`bytes` on the envelope, and the producer that populates them at the three
  sites is this row's own work.
  **2026-09-23: the reserved fields EXIST** — `ErrorProjection.truncated` / `.bytes` in
  `graph/spec.ts` (D8 phase one, which closed §A.90) — with no producer; the marker is still in the
  content at all three sites and this row stays OPEN.

- ~~**A.84 · A `loop` edge is an edge to the scheduler and not to the compiler, so every DAG
  analysis is wrong about a graph with one in it.**~~ **CLOSED at `731eca44`, `79cab047`
  (+ `0431ddcb`).** The row demanded that the SET of analyses be named first, and it is, at the
  site: of `dagEdges`' readers, `topoOrder`, `rule006Cycles`, the fan-out stacks, the critical path,
  `ancestors` and `wouldCycle` are RIGHT to drop the back-edge; entry nodes, terminal nodes,
  `GRAPH005`, `GRAPH010` and `GRAPH002` were WRONG. What shipped:
  - `flowEdges` — every edge but `compensation`, the same predicate `graph/mutate.ts`'s
    `traversable` already uses.
  - `flowAncestors` — a Tarjan condensation, full closure — read through `canPrecede` by
    `GRAPH005_UNPRODUCED_READ` and by `GRAPH002_DEAD_END`.
  - `GRAPH010_CONCURRENT_WRITE` rests on **DOMINANCE** (`GraphIndex.dominators`, a
    Cooper–Harvey–Kennedy idom tree over `flowEdges` from a virtual root above the entry set):
    `ordered = ancestors either way ∨ dominates either way`.
  - `entryNodes`' loop exception is now CONDITIONAL: a node whose only inbound edge is a `loop` is
    an entry only if no ROOT reaches it over `flowEdges`, and the root test reads `spec.edges`, so a
    compensation target is still not an entry.
  - `terminalNodes` is UNCHANGED from base, and `ancestors`/`dagEdges`/`wouldCycle` are untouched,
    so §A.73's coupling survives BY CONSTRUCTION rather than by care.
  Repro on the merged HEAD, the row's own probe:
  ```
  $ node .agent/wave-2026-09-22b/probes/probe-loop-invisible.mjs
  compile: ok

  same graph, merge_object (the diagnostic's own first fix:) -> compile: ok
    run status=succeeded  node order=["parse","audit","fix","audit","fix","audit","fix","audit"]
    "fix" ran at t=0 beside "parse": false
  ```
  `examples/graphs/harden-config.json` compiles with **ZERO** warnings, three at base and all three
  this row — and that is **the ONLY change across the seven shipped graphs' `loom compile` output**.
  **THE BLOCKING FINDING THE FIRST CUT CARRIED, and it is this wave's sharpest.** The first cut gave
  `GRAPH010` a `flowOrder` relation — `flowEdges` with its cycles cut by a depth-first walk — which
  MANUFACTURES orderings that are true from pass two and false on pass one. On `siblings.json`
  (`start → summarize`, `start → scan → fix`, `fix -loop→ summarize`) it compiled CLEAN where base
  refused, while the UNCHANGED executor runs `summarize` and `fix` in one pass: a real race the
  compiler had stopped reporting. It was also declaration-order dependent — 495–527 of 8,000
  permutation seeds flipped, against 0 at base. **The docstring that shipped with it was the
  defect** — *"the cut can only withhold a refusal it was already free to withhold"* — and a
  permutation fuzz found it in one run. It is QUOTED at `computeDominators` rather than deleted.
  **A second blocking finding, same round:** moving `terminalNodes` emptied it on every looping
  graph, so `GRAPH002` went dead. Reverted to base; `rule002` now asks *dead iff no output writer in
  `flowAncestors(t) ∪ reach(t)`*.
  **What the final review measured**, from a `git archive` extract: a dominance ORACLE over 435,916
  pairs across 12,071 graphs (3,071 multi-entry) with **0 mismatches**; permutation flips
  **0 of 8,000**; **no graph that compiled at `be29cb43` is refused at HEAD**, over 12,000 random
  graphs; loop-free acyclic graphs bit-identical. The reviewer WITHDREW its own round-1 claim that
  an empty terminal set broke `loom exam attest` — `examShape` is the same at base and head, a
  grader being a leaf. Recording the withdrawal is the point: a reviewer's finding is a claim too.
  **The cost, measured and recorded at `computeDominators`:** the growth exponent is untouched at
  n^0.99, and the 500-node compile constant went 21 → 54 → 39 ms, the last after a
  `writersByChannel` precompute.
  Residue → **§A.86** (`rule002`'s `reach(t)` half is reachability the run may never realise) and
  **§A.89** (one relation, two implementations).

### Opened by the 2026-09-22b settlement

Found while building or reviewing the seventh wave — three lanes again — and **every row below was
RE-RUN on the merged settlement HEAD**, not taken from a lane report. Ten rows: five are residue of
the four compiler rows this wave closed, four come out of the THIRD workflow port's friction log
(`docs/workflow-port-2026-09-22b.md`), and one is a product row a port found that has a closed
ancestor. The probes are in `.agent/wave-2026-09-22b/probes/` (gitignored), copied out of the lane
worktrees and the reviewers' extracts and re-pointed at this checkout.

**§A.90 is the one to read first.** It is the only row in this file that ends in destroyed data with
exit code 0.

- **A.85 · A `RunGraph` whose `when`, `until` or router-case `when` is not a string is refused at
  RUN time, mid-`#commit`, and the run is left `running` with NO terminal row.** *(§A.78's residue —
  the refusal it created is correct and arrives in the wrong place.)* Files:
  `packages/core/src/graph/expr.ts` (`lex`, the new type test) and
  `packages/core/src/run/engine.ts` (`#assertBound`, which does not ask this question). `#expr` has
  THREE call sites — `router.cases[].when` on the NODE, `e.until` and `e.when` on an EDGE — and
  `graph/validate.ts` checks all three at compile, so this is only reachable through a `RunGraph`
  that did not come from this build's compiler, which is exactly what `attach` accepts. Repro on the
  merged HEAD, `node .agent/wave-2026-09-22b/probes/a85-expr-runtime.mjs "$PWD"`:
  ```
  conditional when: [null]
    1st advance: THREW E_EXPR_INVALID: expression must be a string, got an array
    2nd advance: status=running
    terminal rows: run.failed=0 run.succeeded=0 | last row: effect.completed
  loop until: [null]
    1st advance: THREW E_EXPR_INVALID: expression must be a string, got an array
    2nd advance: status=running
    terminal rows: run.failed=0 run.succeeded=0 | last row: effect.completed
  ```
  **PRE-EXISTING and now merely typed**: at `be29cb43` the array case OOMed (§A.78) and `null` threw
  a bare `TypeError`; it is a `LoomError` now, which is better and is not placement. The cost is the
  one `#assertBound` exists to prevent: work already committed, a run an operator cannot tell from a
  live one, and a second `advance` that answers `running` rather than naming the fault. The tree
  says this at `#failUnreadableGraph`.
  **Closes when** `#assertBound` gains a FOURTH vocabulary check over EDGES AND ROUTER CASES — an
  edge-only check would be partial, which is why the bounds lane declined to write one — and it
  joins the `FAULTS` census in `advance-refusal-is-journaled.test.ts` with the other three.

- **A.86 · `rule002`'s `reach(t)` half is reachability the run may never REALISE, so `GRAPH002` went
  silent on a graph the base warned about.** *(§A.84's residue, at WARNING level.)* File:
  `packages/core/src/graph/validate.ts`, `rule002DeadEnds` — dead iff no output writer in
  `flowAncestors(t) ∪ reach(t)`. `reach(t)` walks `flowEdges` and reads neither a loop's
  `maxIterations` nor a `conditional`'s `when`, so a writer behind a never-true condition after a
  back-edge that can only fire once is counted as reached. Repro on the merged HEAD, the same file
  against both compilers:
  ```
  $ node .agent/wave-2026-09-22b/probes/compile-file.mjs "$PWD" \
      .agent/wave-2026-09-22b/probes/R1_unreachable_pass_writer.json
  ok: true
    (no diagnostics)
  $ node .agent/wave-2026-09-22b/probes/compile-file.mjs <be29cb43 extract> \
      .agent/wave-2026-09-22b/probes/R1_unreachable_pass_writer.json
  ok: true
    warning GRAPH002_DEAD_END: terminal node "t" ends a path on which no declared output is ever written
  ```
  The graph is a loop with `maxIterations: 1` whose only output writer sits behind
  `when: "len(a) >= 500"` after the back-edge. **This is an over-approximation in the QUIET
  direction and it is deliberate**: §A.84 traded a rule that was wrong about every looping graph for
  one that is right about the reachable set and generous about the realisable one. It is a warning,
  not an error, and nothing this file knows of depends on it firing.
  **Closes when** *reachability the run can realise* is a thing the compiler computes — which needs
  the loop bound and the edge condition, i.e. exactly the two facts a static analysis cannot have in
  general — or when the row is closed with an ARGUMENT that a warning may over-approximate and the
  argument is written at `rule002DeadEnds`. **The second is probably the right answer**; it is a row
  so that somebody decides rather than discovers.

- **A.87 · `GraphMetadata.version` is declared `number` and an IN-TREE fixture writes `"1.0.0"` and
  runs.** File: `packages/core/src/graph/spec.ts:629` (the type) against `:1144` (the tag), and
  `packages/core/test/cli/guards-lane-extension-engine-seams.test.ts:90` (the fixture). §A.81(a)
  tagged the field `unknown` rather than `number`, and said why in place: tagging it `number`
  refuses a graph that compiles and RUNS today, and *"a guard that cries wolf on correct code is
  worse than no guard"*. Nothing reads it as a number — `cli.ts`'s only reader is
  `String(g.spec.metadata.version)` in a display line. Repro is the disagreement itself:
  ```
  $ /usr/bin/grep -an 'readonly version: number' packages/core/src/graph/spec.ts
  629:  readonly version: number;
  $ /usr/bin/grep -an 'version: "1.0.0"' packages/core/test/cli/guards-lane-extension-engine-seams.test.ts
  90:  metadata: { name: "stamp", version: "1.0.0" },
  ```
  **Closes when** somebody decides which it is — a number or a version STRING — and the loser
  changes. It is one edit to `GraphMetadata`, one to that fixture, and one tag; it is on the owed
  list because the decision is a product decision and not a typing one.

- **A.88 · `contextProjection.take: null` compiles clean, because the rule that owns the field reads
  `null` as ABSENT.** File: `packages/core/src/graph/validate.ts`, `checkProjectionValues` —
  `take !== undefined && take !== null && …`. `take` is on `CHECKED_BY_A_RULE`, so §A.81(a)'s pass
  defers to that rule, and the rule drops `null` silently where it refuses `"banana"`, `["x"]`,
  `{a:1}` and `true` with `GRAPH003_MALFORMED`. **Pinned POSITIVELY as `STILL_ACCEPTED`** in
  `packages/core/test/graph/block-field-types.test.ts:195`, a one-member set asserting today's
  acceptance, so it cannot stop existing in silence:
  ```
  $ /usr/bin/grep -an 'STILL_ACCEPTED' packages/core/test/graph/block-field-types.test.ts
  195:const STILL_ACCEPTED: ReadonlySet<string> = new Set(["contextProjection.take:null"]);
  ```
  Taking `take` off the opt-out list closes this one value and gives the other four TWO diagnostics
  for one mistake, which is the trade `CHECKED_BY_A_RULE` exists to refuse.
  **Closes when** `checkProjectionValues` refuses an explicit `null` where it refuses the other four
  — one line in that rule, and the pin above goes red when it lands, which is the signal to delete
  the row and the set member together.

- **A.89 · One dominance relation, two implementations, in two files.** Files:
  `packages/core/src/graph/validate.ts` (`computeDominators`, a Cooper–Harvey–Kennedy idom TREE,
  built on every `loom compile`) and `packages/core/src/graph/mutate.ts:327` (`dominators`, V bitset
  rows of V bits, built on a proposed mutation). Both are the same relation over the same edge set
  (`flowEdges` there, `traversable(spec)` here — the same predicate) and they are asked different
  questions, which is why each cost is right where it is: a quadratic is affordable on a mutation
  and not on every compile. **Named at the site rather than hidden**, which is the only reason this
  is a row and not a defect:
  ```
  $ /usr/bin/grep -an 'THE TWO ARE THE SAME RELATION AND ARE NOT SHARED' packages/core/src/graph/validate.ts
  607:   * per node and answers by walking the chain. THE TWO ARE THE SAME RELATION AND ARE NOT SHARED,
  ```
  **Closes when** one of them is the other's caller, or when a written argument says they must stay
  apart and what keeps them in agreement. It needs `mutate.ts`, which the lane that built the second
  one did not own.

- ~~**A.90 · An `error` arm is handed no reason, so a workflow rebuilds its own record from an empty
  history and exits 0 — SILENT DATA LOSS.**~~ **CLOSED 2026-09-23 — `DESIGN.md` D8, phase one;
  Sequence item 30.** Both halves of the closing condition below: (i) the ENVELOPE — `ErrorProjection`
  in `graph/spec.ts`, all six fields, named in `reads` as `"<nodeId>:error"`, folded out of
  `task.failed` by `viewFor` (no new journal event; `ok: true` only from `succeeded`, NO value in any
  other state), every misuse refused by `graph/validate.ts`'s `checkErrorProjectionRead`; (ii) the
  FAILURE PRODUCER — `fs.read` answers `E_FS_NOT_FOUND` (ENOENT), `E_FS_UNREADABLE` (EACCES, EPERM,
  EISDIR, ENOTDIR, ELOOP) and `E_CAP_DENIED` (the jail's refusal, now RETURNED rather than thrown so
  it is replayable), and `grant-access`'s arm reads `read-ledger:error` and proceeds on
  `E_FS_NOT_FOUND` alone. `look`, its `listing` channel, the `then-look` edge and `weigh`'s glob check
  are DELETED; `then-ledger` now runs `read-policy → read-ledger`; `no-ledger` is a catch-all error
  edge. `historySource` stays as a gate DISPLAY and is no longer read as a guard. The `KNOWN HAZARD`
  test went RED against the change — `first-grant refused: … it failed E_FS_UNREADABLE: cannot read
  out/access-ledger.json: EACCES`, `1 !== 0` at its `second.r.code` assertion — and was DELETED, not
  loosened; one test per ending replaces it, each asserting the ledger's bytes. Repro on the SHIPPED
  graph through `npm run build:binary`'s `bin/loom`, in a fresh copy of `examples/`:
  ```
  $ loom run graphs/grant-access.json --input '{"requestPath":"access/requests/docs-site-read.json"}' | jq -c '{status,historySource:.outputs.decision.historySource}'
  {"status":"succeeded","historySource":"none"}                        ← no ledger: first-grant, exit 0
  $ jq -c '[.grants[].who]' out/access-ledger.json
  ["u:sam"]
  $ chmod 000 out/access-ledger.json;                                    run ravi → exit 1
  {"status":"failed","code":"E_FUNCTION_REFUSED","why":"it failed E_FS_UNREADABLE"}   ledger bytes unchanged, ["u:sam"]
  $ chmod 222 out/access-ledger.json && chmod 333 out;                   run ravi → exit 1   ← THIS row's repro
  {"status":"failed","code":"E_FUNCTION_REFUSED","why":"it failed E_FS_UNREADABLE"}   ledger bytes unchanged, ["u:sam"]
  $ chmod 000 out;                                                       run ravi → exit 1
  {"status":"failed","code":"E_FUNCTION_REFUSED","why":"it failed E_CAP_DENIED"}      ledger bytes unchanged, ["u:sam"]
  $ chmod 333 out   (ledger READABLE);                                   run ravi → exit 0   ← the control
  {"status":"succeeded","historySource":"ledger"}                                     ["u:sam","u:ravi"]
  $ loom replay <the chmod-000 run>
  {"match": true, "hermetic": true}
  ```
  **What did NOT close with it, each named at D8's *Enforced* line:** `fs.write`, `fs.edit` and
  `fs.glob` still THROW their jail refusals (and `net.fetch` its egress refusal), which `#invokeTool`'s
  catch flattens to `E_TOOL_SOURCE_UNAVAILABLE` and replay refuses as a divergence, and `proc.exec`
  returns its allow-list refusal untyped; `fs.glob` and `fs.grep`
  still answer `(no matches)` for a directory their walk could not enumerate
  (`builtin/search-match.ts`'s bare `catch` around `readdirSync`) — an INCOMPLETE listing, which is
  §A.83's kind of fact, not this row's; a projection is REFUSED at compile, not served, for a source
  inside or downstream of a loop body or inside a fan-out the reader is not in; `E_CAP_DENIED` also
  names a capability the policy did not grant; and `grant-none.js` and `grant-weigh.js` were edited
  IN PLACE under `@stable`, so replaying a grant-access journal recorded BEFORE this change through a
  path that reached `first-grant` now refuses there (the old graph declares no `read-ledger:error`) —
  inherent to editing a stable ref in place, recorded here so it is not rediscovered.
  **MIGRATION** (fix round 2): a graph whose `error` edge off an `fs.read` node filters
  `codes: ["E_TOOL_SOURCE_UNAVAILABLE"]` — `grant-access` at `ab1654f7`, and the pattern
  `docs/workflow-port-2026-09-22b.md` teaches — now FAILS on a missing file (`E_FS_NOT_FOUND`) where
  it routed. Fail-closed, and no longer silent: `loom compile` warns, measured on the `ab1654f7`
  graph with the new binary —
  ```
  $ git archive ab1654f7 examples | tar -x -C /tmp/old && cd /tmp/old/examples
  $ loom compile graphs/grant-access.json
  ! grant-access.json: GRAPH003_STALE_FS_READ_CODE: edge "no-ledger" handles "read-ledger" (fs.read) only on E_TOOL_SOURCE_UNAVAILABLE, which fs.read no longer raises for a missing file, an unreadable file or a refused path — those three now fail the run
  ok
  ```
  Its `fix:` names `E_FS_NOT_FOUND`, `E_FS_UNREADABLE` and `E_CAP_DENIED` (asserted in
  `test/run/error-projection.test.ts`; `loom compile` prints a warning's `fix:` only on a failed
  compile). A warning and not an error, because `fs.read` still raises the old code for an errno
  outside the three. `examples/README.md` §10 carries the same note. The row as it stood before closing follows. *(From the third port's F5 —
  `docs/workflow-port-2026-09-22b.md`. **The priority row of this settlement.**)* Files:
  `packages/core/src/builtin/tools.ts` (one `try` around the open, returning
  `{content: "cannot read …", isError: true}`) and **`Engine.#runToolNode`** in
  `packages/core/src/run/engine.ts` — cite the SYMBOL, because the line moves: it was `:8462` when
  this row was written and is **`:8533` at `369eb4f6`** — which turns any `isError` without a typed
  error into
  `err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, result.content)`. **Three different outcomes —
  the file is absent, the file is there and unreadable, the path is one the sandbox refuses — are
  ONE code**, so `codes: ["E_TOOL_SOURCE_UNAVAILABLE"]` on the arm narrows none of them apart; and
  the `content` that WOULD distinguish them reaches no channel, because a failed task's writes are
  not applied and there is no `error` projection an arm may declare in `reads`. Repro on the merged
  HEAD, on the SHIPPED graph with its defence in place, `chmod 333` on the output directory:
  ```
  $ cd examples && rm -rf out .loom
  $ loom run graphs/grant-access.json --input '{"requestPath":"access/requests/docs-site-read.json"}' >/dev/null 2>&1
  $ jq -c '[.grants[].who]' out/access-ledger.json
  ["u:sam"]
  $ chmod 222 out/access-ledger.json && chmod 333 out
  $ loom run graphs/grant-access.json --input '{"requestPath":"access/requests/docs-site-read-ravi.json"}' 2>/dev/null \
      | jq -c '{status, historySource: .outputs.decision.historySource}'
  {"status":"succeeded","historySource":"none"}
  $ chmod 755 out; chmod 644 out/access-ledger.json; jq -c '[.grants[].who]' out/access-ledger.json
  ["u:ravi"]
  ```
  `u:sam`'s grant is gone, the run exited 0, and nothing said a word. **The general form is
  `CLAUDE.md`'s own lens one layer down:** an error arm's undecidable case is *why*, its passing
  value is *the benign reason it was written for*, and every error arm anybody writes is a body
  asserting the reason it was built to handle.
  **The port's defence is itself a fail-open guard, and that is the part that transfers.** An
  `fs.glob` `look` node upstream of the read covers EXACTLY ONE case — a regular file that is
  LISTABLE but not readable, where the run now fails closed and the ledger survives (measured) —
  and `fs.glob` answers `(no matches)` for *nothing here* AND for *cannot enumerate*, so the
  workaround for a guard that answers its undecidable case with the passing value does the same
  thing. Four glob patterns were tried against the unlistable directory and none yields a signal.
  The hole above is pinned NEGATIVELY in `packages/core/test/examples-grant.test.ts` as a KNOWN
  HAZARD asserting today's LOSS. Two of the other three uncovered cases (an escaping symlink, a
  directory at the path) fail the run CLOSED, for an unrelated reason: the WRITE meets the same
  obstruction the read did.
  **Closes when** the failure's code and message are a projection an `error` arm may declare in
  `reads`. That is a new CHANNEL SHAPE and not a new field, and it needs the answer to *what does an
  arm see when the failure is not a tool's* first — which is the same decision §A.83 is waiting on,
  one door over. When it lands, the KNOWN HAZARD test should fail and be DELETED along with the
  `look` node rather than loosened. **A structural alternative is on the owed list**: a per-run
  ledger file cannot lose an entry to a failed read, and converts a silent loss into a spurious
  gate.
  **The shape is decided, 2026-09-22 (`DESIGN.md` D8 — that file's Decisions section, not this
  file's §D.8 one dot away — from §D.10), and this row is PHASE ONE of it**: one reserved ERROR
  PROJECTION per node, `{ok, code?, message?, truncated?, bytes?, classification?}`, which an
  `error` arm and a `function` body may both declare in `reads`. Restated in D8's terms, this row
  closes when the envelope is DECLARED with all six fields and the **failure producer** has landed:
  **the three outcomes wear DISTINCT codes** — file absent, file present and unreadable, path
  refused by the sandbox; a projection that still answers only `E_TOOL_SOURCE_UNAVAILABLE` does NOT
  close it — and `grant-access`'s `error` arm branches on the code (no file → `first-grant`;
  unreadable or an unlistable parent → FAIL, no ledger write), **at which point the KNOWN HAZARD
  test at `packages/core/test/examples-grant.test.ts`:995 goes RED and is deleted together with the
  `look` node, which is a node in the SHIPPED `examples/graphs/grant-access.json`:54 with its two
  edges at :136–137 — two files, one change.** "No projection" is never read as "success". The
  per-run ledger is allowed later as product hardening and is **not** a closure of this row or of
  `DESIGN.md` item 30. **§A.83 and §A.82 do NOT close with this row**: their producers populate the
  reserved `truncated`/`bytes` and `classification` fields of the same envelope later. *That
  phasing is the ORCHESTRATOR'S READING of the maintainer's four-step order — his own sentence is
  "phase one lands only the failure projection, which is enough to close §A.90" — and it is flagged
  for him to confirm.*

- **A.91 · A by-hash graph lookup COMPILES every graph in `graphs/` and prints the others'
  diagnostics on stderr.** *(From the third port's F2.)* Files: the graph-by-hash resolution behind
  `loom replay`, `loom trace` and `loom approve`. These verbs find the graph by the hash the journal
  recorded and compile the candidates in `graphs/` to compare hashes; every candidate's diagnostics
  go to stderr on the way past. Repro on the merged HEAD, with a noisy graph the operator did not
  ask about dropped into the workspace:
  ```
  $ loom compile graphs/zz-noisy.json 2>&1 | head -1
  ! zz-noisy.json: GRAPH005_UNPRODUCED_READ: node "n" reads "a", which no upstream node writes and which is not a graph input
  $ loom replay "$RUN" 2>&1 >/dev/null | /usr/bin/grep -aE '^! ' | /usr/bin/grep -av 'grant-access' | sed 's/:.*//' | sort | uniq -c
     1 ! zz-noisy.json
  $ for v in audit replay trace; do printf '%-8s ' "$v"; loom $v "$RUN" 2>&1 >/dev/null | /usr/bin/grep -a -c 'zz-noisy'; done
  audit    0
  replay   1
  trace    1
  $ loom replay "$RUN" --graph graphs/grant-access.json 2>&1 >/dev/null | /usr/bin/grep -a -c 'zz-noisy'
  0
  ```
  **THREE verbs and not four, measured one at a time** — `loom audit` does NOT leak, because it
  never looks the graph up (*"no edgeSource supplied: the compiled graph is not in the journal, only
  its hash"*). `--graph` names the file directly and the noise vanishes, which is both the
  workaround and the confirmation. **It is not cosmetic in the direction that matters**: an operator
  approving a production change is shown warnings that name a file they did not run, and a script
  doing `2>&1` carries another graph's diagnostics into whatever reads it.
  **Closes when** a by-hash lookup is silent about candidates the operator did not name — a compile
  for hash comparison is an internal question and its diagnostics belong to nobody.

- **A.92 · A gate's approvers are STATIC, so a graph cannot ask the people its own data names.**
  *(From the third port's F3.)* File: `packages/core/src/graph/spec.ts`, `ApprovalSpec` — exactly
  two fields, `approvers` and `separationOfDuties`, and `approvers` is a list of literal subject
  strings in the graph FILE. `${…}` interpolation is a `tool.args` mechanism (`resolveArgs`) and
  reaches nothing in `humanGate`. Repro on the merged HEAD, one parked run of the shipped graph:
  ```
  $ loom gates "$RUN" | jq -c '.[0] | {approvers, owners: .reads.decision.owners}'
  {"approvers":["u:you"],"owners":["u:ravi","u:mina"]}
  $ loom approve "$RUN" "$GATE" --as u:ravi
  E_GATE_NOT_AUTHORIZED: gate "gate_…" does not name "u:ravi" as an approver
  ```
  **The gate shows the right owners and accepts the wrong signature.** `u:ravi` is one of the two
  people `access/policy.json` says owns the resource, read at RUN time into `decision.owners` and
  displayed at the gate. **This is the interesting half of "no k-of-n field"**: `examples/README.md`
  already states that k-of-n lives in `join` and not in `approval` — N gates plus a quorum join —
  which answers *how many* and cannot answer *which people*, because the N gates are static too.
  **Closes when** an approver list can be channel-valued, or when the compiler REFUSES to express it
  and says so. What there is now is a field that looks like it answers the question and answers a
  different one; the port ships an honesty convention (`labels.residue-static-approvers`) instead.

- **A.93 · A denial and a failure-to-decide wear ONE error code, so only prose tells them apart.**
  *(From the third port's F7.)* Files: `packages/core/src/run/engine.ts` (`requireOutcome`,
  `OUTCOME_KEYS`) and `packages/core/src/errors.ts` (`E_FUNCTION_REFUSED`). `{refuse: {reason}}` is
  the only verdict a `function` body has for declining, and both meanings arrive identically:
  ```
  $ loom run graphs/grant-access.json --input '{"requestPath":"access/requests/payments-kms-admin.json"}' 2>/dev/null | jq -c '{status, class: .error.class, code: .error.code}'
  {"status":"failed","class":"validation","code":"E_FUNCTION_REFUSED"}
  $ loom run graphs/grant-access.json --input '{"requestPath":"access/requests/not-a-request.txt"}' 2>/dev/null | jq -c '{status, class: .error.class, code: .error.code}'
  {"status":"failed","class":"validation","code":"E_FUNCTION_REFUSED"}
  ```
  The first is *policy says no*; the second is *we could not read your request*. Both exit 1, and
  the only difference is the node name inside the message, so a wrapping script must
  `capture("on node \"(?<n>[^\"]+)\"")` out of prose. **The distinction is load-bearing and the
  workflow already makes it deliberately** — the port's `grant-weigh.js` refuses only when it cannot
  DECIDE, and everything it decided against goes to a `deny` node through the router's fallback,
  precisely so a requester is never told their access was refused on the merits when nobody looked.
  **The graph draws the line and cannot publish it.**
  **What is NOT the answer, and was tried:** writing the outcome to a channel and letting the run
  succeed — then a denial exits 0 and a caller that ignores the body grants access. Refusing is the
  right shape.
  **Closes when** a refusal carries a graph-declared discriminator — `{refuse: {reason, code}}` —
  that the engine carries through. **This is the same closure `f7f74d5`'s own `Kernel-seam:` trailer
  names**: an extension-registrable verdict table cannot exist while `graph/validate.ts` checks
  `EdgeSpec.codes` and `retry.onlyIf` against a CLOSED `CODES`, so a *graph-declared* code is the
  narrower thing to design here.

- **A.94 · `GRAPH010_CONCURRENT_WRITE` calls the `seq` target and the `error` target of ONE node
  concurrent writers, and they are exclusive by construction.** *(From the third port's F1.)* File:
  `packages/core/src/graph/validate.ts`, `rule010ConcurrentWriters`. **This is NOT §A.84** — that
  was `loop` and `compensation` being DROPPED from the forward DAG; `error` is not on that exclusion
  list, so the edge IS visible and its EXCLUSIVITY is not. `#errorEdges` is reached only from
  `outcome.status === "failed"` and `#edgesToTake` only from a success, so control takes exactly
  one, and that is true of EVERY `seq`/`error` pair in every graph. Repro on the merged HEAD, on the
  shipped graph with its workaround reducer swapped back:
  ```
  $ cd examples && sed -i.bak 's/"history": { "type": "object", "reduce": "merge_object", "onConflict": "last_by_branch" }/"history": { "type": "object", "reduce": "replace" }/' graphs/grant-access.json
  $ loom compile graphs/grant-access.json; mv graphs/grant-access.json.bak graphs/grant-access.json
  ✗ grant-access.json: GRAPH010_CONCURRENT_WRITE: nodes "prior" and "first-grant" can run concurrently and both write "history", whose reducer `replace` is not multi-writer safe
     fix: change channel "history" to a multi-writer-safe reducer, or sequence "prior" and "first-grant"
  E_GRAPH_INVALID: graph has 1 error(s): GRAPH010_CONCURRENT_WRITE
  ```
  **Neither half of the `fix:` line is what the graph wants**, measured rather than reasoned about:
  *sequence them* asks for the recovery to run after the success, and *change the reducer* is what
  ships — `merge_object` with `onConflict: "last_by_branch"` — buying a conflict arm that can never
  fire, because the channel has held exactly one contribution on every run ever measured. The graph
  says so in `labels.residue-error-arm`, so a reader does not conclude the channel really has two
  writers.
  **The closest relative is §A.40 and it is CLOSED** — the same shape one edge kind over, where
  `rule010ConcurrentWriters` learned an exemption for a provably branch-local channel. §A.48 records
  what that exemption does NOT cover; this would be a second one and a NARROWER one, because a
  `seq`/`error` pair's exclusivity is STRUCTURAL rather than dataflow-dependent.
  **Closes when** `rule010ConcurrentWriters` treats two nodes as non-concurrent when every path to
  one is a success arm and every path to the other the matching failure arm of the same node —
  stated as a property of the GRAPH, which is what `ac693d0` re-keyed §A.40's W6 on when enumerating
  engine methods failed.

- **A.95 · `GRAPH005_ERROR_PROJECTION_IN_LOOP` refuses a node AFTER a loop's exit, which runs once.**
  *(D8 phase one review, F3; residue of Sequence item 30.)* File: `graph/validate.ts`,
  `checkErrorProjectionRead`. The refusal covers every node reachable from a cycle (`c153566e`, which
  closed the reverse hole — a node hanging off a loop body read pass 2's `ok: true`). A node behind
  a `conditional` loop EXIT runs once, yet is refused, so no post-loop node of a
  `harden-config`-shaped graph can have its projection read. Refusing is allowed; it is an
  over-refusal. Repro, a probe compiling audit→fix (`loop` back) with a `conditional` exit
  `audit → r` and `arm` reading `r:error`:
  ```
  post-loop exit source -> error:GRAPH005_ERROR_PROJECTION_IN_LOOP@arm
  ```
  **Closes when** the refusal is keyed on MULTIPLICITY (does this node run more than once per
  branch) rather than on reachability from a cycle — or when `viewFor` is handed the reader's
  iteration and serves that pass's task, which lifts the refusal for both shapes.

- **A.96 · A COMPENSATED task's error projection still says `ok: true`.** *(D8 phase one review,
  F4c; against item 30's own line, "no projection is never read as success".)* File:
  `run/projection.ts`, `errorProjectionOf`. Rollback is journal-driven and folds nothing onto the
  task — `/usr/bin/grep -an compensat packages/core/src/run/projection.ts` answers nothing — so a
  task whose effect was undone stays `succeeded`, and a later reader of its projection is told the
  node succeeded when its effect no longer stands. **No shipped path reaches it**: compensation runs
  as the run fails or rewinds, and nothing reads a projection after that on any graph in
  `examples/`. **Closes when** a compensated task projects as not-ok (or as no projection), or when a
  reader can be shown unable to run after its source's rollback.

- **A.97 · A FIFO at an `fs.read` path hangs the run indefinitely.** *(D8 phase one review, F4a;
  pre-existing, same on the `ab1654f7` binary.)* File: `builtin/tools.ts`, `openLeaf` — the open has
  no `O_NONBLOCK`, and the task has no bound below the node's `timeoutMs` (600000 by default).
  Repro, the shipped `grant-access` with `mkfifo out/access-ledger.json`, bounded by a 10s alarm:
  ```
  exit=142 after 10s (142 = killed by the 10s alarm)
  ```
  **Closes when** `fs.read` refuses a non-regular file before it blocks (an `fstat` after a
  non-blocking open) — and it should answer `E_FS_UNREADABLE`, never `E_FS_NOT_FOUND`.

- **A.98 · `subgraph.inputs` naming an undeclared parent channel compiles with no diagnostic about
  it.** *(D8 phase one review, F4b; pre-existing, same on the `ab1654f7` binary.)* File:
  `graph/validate.ts` — nothing checks the VALUES of `subgraph.inputs` against `spec.channels`, and
  the child is handed `undefined`. Repro, a probe compiling a `subgraph` node with
  `inputs: {k: "nope"}` and no channel `nope`:
  ```
  subgraph input undeclared -> warning:GRAPH009_NO_BUDGET@
  ```
  (the one diagnostic is about the budget, not the input.) **Closes when** an input naming no
  declared parent channel is refused, as `GRAPH005_UNDECLARED_READ` refuses the same mistake in
  `reads`.

- **A.99 · The veto example says a late reject's write stays and nothing undoes it. The runtime
  tries, and over an existing file it succeeds.** *(Opened 2026-09-23 by the settlement's
  reviewer.)* `examples/graphs/two-person-veto.json`'s description says *"the effect stays … nothing
  in this graph undoes it"*. `README.md`'s "Approval modes" row, `examples/README.md`'s veto row and
  D9's *Enforced* line all say the effect stays. In fact a failed run compensates from the journal,
  with no edge needed (`#failRun` → `#compensate(…, "run_failed")`), so a late veto runs
  `fs.restore` on `save`'s write. On the packed `dist/bin.js` at `48de87f6` (alice approve, bob
  approve, carol reject, each `loom approve` in its own process), the result depends on whether the
  file existed:
  - Fresh workspace: `status: failed`, the file written, and
    `compensation.recorded {"outcome":"failed","reason":"\"fs.restore\" did not undo \"fs.write\": no previous content recorded for approved/request.txt"}`.
    `fs.restore` cannot undo a create.
  - With `approved/request.txt` present beforehand: the file holds its OLD bytes, and
    `compensation.recorded {"outcome":"compensated"}`.

  So the shipped sentence is true of the first case only, and the journal records a FAILED
  compensation for the one the example teaches. **Closes when** `DESIGN.md` D9's second flag is
  answered. Either `fs.restore` learns to undo a create, and the late veto then rolls back in both
  cases. Or the description, both READMEs and D9's *Enforced* line name both cases. Whichever lands,
  `test/graph/two-person-approval.test.ts` asserts the pre-existing-file case.


---

## B · Declared and wired to nothing — both members closed this wave

- ~~**B.1 · `loom serve` cannot survive its own death mid-lease.**~~ CLOSED at `7952c6a`:
  `InProcessScheduler` takes an optional `strandedLeaseMs` and reclaims a lease on a node whose plan
  carries no `timeoutMs` once `task.lease.at + strandedLeaseMs` has passed; the node's own compiled
  deadline still wins where it has one. Measured on a real journal — a two-node graph whose ENTRY is
  a `router`, driven to `succeeded`, its journal truncated one event past `task.leased` (the prefix a
  `kill -9` leaves), folded by a fresh plane and driven by one clock tick: before
  `status=running pick@root#0=leased driven=true`, after `status=succeeded pick@root#0=succeeded`.
  `driven=true` in both columns is the load-bearing half — the clock always offered the run, so what
  changed is the scheduler's answer. Pinned by
  `test/deployment/lease-deadline-survives-restart.test.ts` and
  `test/run/inprocess-reclaims-a-dead-lease.test.ts`.
  The row's ORIGINAL framing — "`LeasedScheduler` has zero callers, so plug it in or delete it" — was
  answered 2026-09-02 and both options refused, and that answer stands: `LeasedScheduler` is a library
  capability an embedder reaches through `EngineOptions.scheduler`, deliberately unused by the
  single-tenant CLI per §D.2. Its repro is unchanged —
  `/usr/bin/grep -arn 'new LeasedScheduler' packages/core/src` → 1, `cli.ts:1084`, a docstring
  asserting the construction count is zero.
  **RESIDUE, three parts, none of them a new row.**
  (a) **The number lives in the DEPLOYMENT, not the graph.** `cli.ts:1193` `STRANDED_LEASE_MS =
  600_000`, passed at `cli.ts:1829` by `openWorkspace`, which is the one `new InProcessScheduler` in
  `src/` that supplies it (`/usr/bin/grep -arn 'new InProcessScheduler' packages/core/src` → 4, of
  which two are docstrings and one is `run/engine.ts:1721`'s bare `opts.scheduler ?? new
  InProcessScheduler()`). Unset stays exactly today's behaviour, so no embedder's live `subgraph`
  becomes reclaimable because of a constant chosen here. It could not go in `compile.ts`:
  `NodePlan.timeoutMs` is what `#withNodeDeadline` ENFORCES on a live body, and a recovery bound and
  an enforcement bound are two different questions.
  (b) **`run`, `resume` and `serve` get it; `replay` does NOT**, and that is a conjunction of three
  hand-built literals rather than one refusal — `replayRun` spreads its caller's `engine` options, so
  a `scheduler` in them would be inherited. The three that hand-build instead: `case "replay"` in
  `cli.ts`, `agent.ts`'s `engineOptions`, and `evolution/gate.ts`'s `replayRun` forwarding whatever
  its caller gave. A fourth call site that spread `ws.engine`'s options would hand a replay this
  scheduler. Written out at `cli.ts:1820-1829`.
  (c) **A `subgraph` lease legitimately spanning more than 600 s is the ACCEPTED trade**, recorded at
  the predicate (`run/scheduler.ts:231`) rather than dodged: reaching a LIVE peer's child needs the
  parent's lease past this bound AND the child's own task past its own compiled deadline, because the
  peer's scheduler applies the same rules one level down — two independent bounds lapsed is the shape
  where the holder is most likely dead. And the parent's fencing token does NOT cover the child: the
  store's compare-and-swap is per chain, so what it refuses is the loser's parent-side commit. The
  bound that would remove the case is the child's own journal progress, a cross-run question
  `SelectInput` cannot carry.
- ~~**B.2 · Three event types have no appender.**~~ CLOSED at `a5937fe` (wire `task.skipped`),
  `c816826` (delete `channel.written`) and `fa25cc7` (delete `task.started`). **Every declared event
  type now has an appender, and `registries.test.ts` asserts that as a RULE over the empty set** —
  the `NEVER_APPENDED` excuse list is gone, so a new declared-and-unappended type fails with nowhere
  to be excused. `EVENT_TYPES.length` is 51 (53 → 52 → 51), the ledger for the moves is in
  `test/journal/store.test.ts:465-479`, and `test/journal/deleted-event-types-still-fold.test.ts`
  measures that a journal already on somebody's disk carrying either deleted name still loads through
  `SqliteStateStore.append`/`store.read` and folds to the same answers.
  The row's own repro has INVERTED and is kept for that reason:
  `/usr/bin/grep -anc 'task.skipped' packages/core/test/registries.test.ts` → **7** (was 1). The pin
  row went and prose about the wiring arrived, so the row now reads MORE pinned than before while the
  pin it named is gone — rule 1 catching a count that survived its own subject.
  **ACCEPTED, AND LOUD: a pre-B.2 journal replayed on the new binary reports `match: false`.**
  `run/replay.ts`'s `compare` frames a task by `state`, so a journal recorded before `a5937fe` whose
  join absorbed a branch replays as `expected: "failed"` / `actual: "skipped"` — read by `loom
  replay`'s exit code and by `evolution/gate.ts`'s `identicalToRecording` cases, which re-freeze. The
  trade was taken deliberately: a divergence that NAMES both states is better than a silent wrong
  answer, and the alternative was leaving a run reporting **succeeded** whose absorbed branches were
  all recorded `failed`.
  `NOT_ABSORBED_AS_SKIP` is its own set, not a borrow of `RUN_FATAL_CODES`: it adds
  `E_HUMAN_APPROVAL_REQUIRED` (deliberately outside `RUN_FATAL_CODES` so a run continues and the ask
  can be made elsewhere — relabelling it would rename a branch a person actively REJECTED) and
  `E_OVERSIGHT_LOOSENED` (`compileMutation`'s GRAPH014 refusal, excluded fail-closed). The auditor
  cannot import the executor, so that set exists twice and `registries.test.ts` censuses the two
  copies against each other.

---

## C · Unbuilt observability, which several other items depend on

**This block gates the UI direction.** A richer operator surface over a plane that is not emitting is
a better view of nothing.

- **C.1 · Six designed span names are unbuilt.** Repro:
  `/usr/bin/grep -anc 'name: "loom\.' packages/core/src/telemetry/spans.ts` → 7, and the grep
  UNDERCOUNTS by two: `loom.model` and `loom.tool` are minted through one ternary, so nine names
  exist. The constraint is that `spansFrom` is a pure fold over one journal, so a name is buildable
  only if the journal already covers it — and each of the six names the event it would need:
  **`loom.request`** (nothing covers ingress; a request is accepted before a runId exists, so it
  needs a durable stream not keyed on a run); **`loom.compile`** (measured impossible —
  `run.submitted`/`run.compiled`/`run.started` and the entry `task.ready`s are ONE append with one
  `ts`, and `compileOrThrow` runs in the caller; needs a `durationMs` on `run.compiled`, a kernel
  change); **`loom.schedule.pick`** (three of its four attributes are scheduler state no event
  carries; needs a `schedule.picked` event); **`loom.context.assemble`** (`run/context.ts` journals
  nothing); **`loom.replay`** (the shadow run's journal carries no marker and its `MemoryStateStore`
  dies with the call; needs `replayOf: RunId` on `run.submitted` plus a durable shadow store);
  **`loom.scheduler.tick`** (C.3 — no tick loop to instrument). **Closes** name by name, each with
  the event it names. `loom.schedule.admit` is NOT among them and never will be: §D refused
  admission control permanently, so the name has no subject.
- **C.2 · Eight of eleven documented span attributes are NOT DERIVABLE, which falsifies this row's
  own premise rather than shrinking it.** Repro: count both spellings, since `spans.ts` writes
  `capability` as a bare identifier —
  `/usr/bin/grep -aoE '"(gate\.batched|tool\.attempt)"|(^|[^.\w"])capability\s*:' packages/core/src/telemetry/spans.ts`
  → 3, the three that were journaled fields this fold read and discarded and are now set. The other
  eight each have a stated reason, and TWO OF THEM MOVED at `bc926f8` (§B.2). `node.type` is now
  UNOBTAINABLE rather than merely unwritten: `task.started` was DELETED, and `task.leased` —
  which records the same MOMENT and is what §A.29 now points at — carries `attempt` and no node
  type, so this attribute needs a new field on an existing event or a new event, not a writer for
  an existing name;
  `budget.cost_usd` (`budget.reserved` carries `remainingUsd` only when a dollar ceiling exists, so
  the ceiling reconstructs on some runs and not others, worse than absent); `reducers`
  (`channel.written` was DELETED at `c816826`, and `state.reduced` carries channels, not reducers);
  `trigger.kind` (nothing journals a trigger); `gen_ai.request.max_tokens` (`model.called` journals a `requestDigest`, never
  the request); `tool.source` (the concept is not in the tree); `loom.replayed` on both its spans (a
  replay rewrites `model.called.provider` to the recorded leaf ON PURPOSE, so a replayed journal is
  designed to be indistinguishable); `gate.posture` (a constant reached by an inference). **Closes
  when** each of the eight gains the journal event it needs — a `journal/events.ts` change and
  therefore a seam, every one — or is struck from the set. **It does not close by emitting them.**
- **C.3 · No scheduler-tick telemetry, and there is no tick loop to instrument.** Repro:
  `/usr/bin/grep -anc 'tick' packages/core/src/run/scheduler.ts` → **0** (the row said 1; re-run
  2026-09-22b, and the word is gone from the file entirely, which makes the row MORE true rather
  than less). A design gap, not a wiring gap.
  Per-task queue wait is already measurable — `task.ready` and `task.leased` are journaled and
  `spans.ts` attaches the latter as a span event, so the p99 is a fold over what is already emitted.
  **Closes when** there is scheduler-level behaviour to instrument.
- ~~**C.4 · There is no OTLP exporter in the repo and no HTTP trace endpoint.**~~ CLOSED —
  `telemetry/otlp.ts` (`otlpTraceRequest` + `OtlpHttpExporter`), `GET /runs/:id/trace?format=otlp` as
  the pull half, and `loom trace <runId> --otlp <endpoint>` as the push half (`96a03bf`). Zero
  dependencies, so "it belongs outside the core" was answered rather than obeyed. Wiring it found
  five defects in the shipped exporter, all fixed and each pinned: `redirect: "follow"` let a
  "collector" re-address the credential and the whole trace; the mask covered the endpoint and not
  the API key; every transport failure said only `TypeError: fetch failed`; `__proto__` as a header
  name is undeliverable and now refuses; and a query string in the endpoint POSTed to a path nobody
  named. `test/telemetry/otlp.test.ts`, `test/cli/trace-otlp.test.ts`.
- ~~**C.5 · A subgraph renders as `loom.tool`.**~~ CLOSED by `aaa4a9a`, and NOT by adding a name
  (§D.2 answered "no ninth name") — the fold's two-arm partition became three:
  `model|summarize → loom.model`, `tool|compensate → loom.tool`, `subgraph|random → loom.effect`.

---

## D · Decisions still owed

Each row states what a decision would settle; none is the implementer's to answer alone. The framing
question was answered by the maintainer: **single machine, single tenant, the maintainer's own
workflows** — one `loom serve`, one operator. Answered rows stay struck rather than deleted, because
a decision's argument is the thing a future reader needs.

- ~~**D.1 · Per-server `irreversibility` on `--mcp-file`.**~~ ANSWERED: yes, an operator may, and the
  argument is at `MCP_SERVER_FIELDS` rather than here. The load-bearing part: that file is ALREADY
  the arbitrary-code door (a row names `command` and `args`, and `startMcp` spawns them with no
  allow-list), so `"irreversibility":"read_only"` is strictly weaker than the `"command":"/bin/sh"`
  the same row could always have said, and the path comes from argv. **The condition, not a caveat:**
  it assumes the writer of the mcp file and the runner of the binary are one person; at a second
  operator the field must be taken away. Inferring the class from the server's own advertised
  metadata is refused outright. `test/mcp/irreversibility.test.ts`.
- ~~**D.2 · A ninth span name for a subgraph.**~~ ANSWERED: no ninth name — the taxonomy is a closed
  vocabulary, and a subgraph is `loom.effect` told apart by `effect.kind` (`aaa4a9a`). The rejected
  alternative — a generic parent over all four effect kinds — would either double a span count
  `spans.ts`'s header budgets or delete the `gen_ai.*`/`tool.*` groupings those names exist for.
- ~~**D.4 · Whether the median gates, and what an undefined pair does to it.**~~ ANSWERED by
  `50f7c03`: the median gates, and an undefined pair is UNBOUNDED rather than dropped. See §A.27.
- ~~**D.6 · Whether `POST /runs` may refuse a graph that only WARNS at compile time.**~~ ANSWERED at
  `86193e3`: yes — the wire refuses, keyed on `spec.inputs`, 400 `E_PROVIDER_BAD_REQUEST` with zero
  `run.submitted` rows. A graph on which `GRAPH005_UNPRODUCED_READ` only WARNS is therefore refused
  at the wire when a caller supplies that channel. **This is the decision of that lane most likely to
  be overturned**, so the counter-argument is kept: `engine.submit` enforces NEITHER set, so this
  door invents an authority the engine does not have, and invents the STRICTER of the two available.
  The alternative, option (f), keys the shared rule on `spec.channels` at all three doors — it still
  closes §A0.17's whole complaint and refuses nothing that compiles. **If it is taken, the change is
  one line in `undeclaredInputs` plus the message's second clause, and the test that would flip is
  `A GRAPH THAT COMPILES AND READS THE CHANNEL IS REFUSED TOO` in
  `test/server/plane-declared-inputs.test.ts`.** Three options were rejected: a defaulted
  `strictInputs` body field, 202 plus a `Warning:` header, and doing nothing. It does NOT reach the
  delegation door — §A0.22, which cannot close until this is settled for all three doors at once.
- **D.3 · Whether an author gets a graph-level cleanup node on failure**, beside journal-driven
  rollback. Compensation edges are a compile-time declaration by design (§A.30); this asks whether
  there should also be a node an author can point at. **Closes when** the maintainer answers.
- **D.5 · Whether the kernel needs a graph-scoped durable fact.** See §A.25: two callers now borrow
  one coordinate — `operator.command` on the first case's run. The question is whether that is one new
  event type or a second keyspace, and either answer is a kernel change with a `Kernel-seam:` trailer.
  **Closes when** the maintainer answers.
- **D.7 · Whether `CODES` belongs on README's "Fork required" list, which names three closed sets and
  is the property-2 alarm.** Repro:
  ```
  $ sed -n '/^## Extending it, and where that stops$/,/^## Why this exists$/p' README.md \
      | /usr/bin/grep -a -c '^- \*\*'
  3
  $ node -e "import('./packages/core/src/errors.ts').then(m=>console.log(Object.keys(m.CODES).length))"
  60      # 59 at 2309d3a — `E_FUNCTION_REFUSED` (f7f74d5)
  ```
  The three listed are a node type, a reducer and a ninth hook point, and README's argument for all
  three is REPLAY: *"a fold can only reproduce a decision whose vocabulary the folding binary
  knows."* `CODES` is closed for that identical reason and says so in `f7f74d5`'s own seam trailer —
  `graph/validate.ts` must check `EdgeSpec.codes` and `retry.onlyIf` against a closed `CODES`, and
  `run/projection.ts` must fold the failure. So a stranger who needs a code of their own must fork,
  and README does not say it.
  **What makes it a DECISION rather than a defect**, and why the 2026-09-10 docs pass did not just
  add a fourth bullet: the list is written as *"each is a CLOSED SET whose refusal NAMES ITS
  MEMBERS — quoted, because a row nobody can reproduce by running the thing does not belong on this
  list"*, and `GRAPH003_UNKNOWN_ERROR_CODE` does NOT name its members — it prints
  `did you mean one of: E_NOT_AUTHORIZED`, a prefix-matched suggestion over 60 codes
  (`validate.ts`'s `nearest()`). So adding it either weakens the list's own quoting rule or needs the
  refusal changed first. And CLAUDE.md §2 says the list *"moving the other way is the alarm"*, so
  growing it from three to four is a claim about the product that a settlement pass may not make on
  its own. **The options are: (a)** add a fourth bullet and raise CLAUDE.md §2's expected count to 4,
  disclosing that the list grew by DISCOVERY and not by regression; **(b)** make
  `GRAPH003_UNKNOWN_ERROR_CODE` enumerate, then add it under the existing rule; **(c)** argue that a
  code differs from the other three because a graph can only NAME one, never define behaviour on it,
  and record that argument beside the list so the next reader does not re-ask.
  **Closes when** the maintainer picks one. Until then the ledger reads 3 and the reason it does is
  here rather than nowhere.

- **D.8 · Whether an inbound edge on a `join` node must be `kind: "join"` at compile time.**
  Recommended by the engine lane's reviewer once §A.47 landed, and it is a TIGHTENING DECISION, not
  a defect: the engine now handles such an edge correctly, so nothing is broken either way. The
  case for it is that the rule already exists in two places under another name — `GRAPH008` is
  keyed on a join's inbound edge list, and §A.48's W6 keys the branch-local exemption on exactly
  that list, so an ordinary edge into a barrier is already the thing two guards read around.
  Making it explicit at compile time would mean neither has to reason about an edge kind the
  author did not intend.
  **The measured cost is zero.** Scan every committed `GraphSpec` for an inbound non-`join` edge on
  a `join` node:
  ```bash
  node -e 'const{execSync}=require("child_process"),fs=require("fs");
    let n=0,h=0;for(const f of execSync("git ls-files \x27*.json\x27").toString().trim().split("\n")){
    let s;try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{continue}
    if(s?.kind!=="GraphSpec"||!Array.isArray(s.nodes)||!Array.isArray(s.edges))continue;n++;
    const j=new Set(s.nodes.filter(x=>x.type==="join").map(x=>x.id));
    for(const e of s.edges)if(j.has(e.to)&&e.kind!=="join")h++;}
    console.log(n,"GraphSpec files,",h,"such edges");'
  # → 9 GraphSpec files, 0 such edges
  ```
  **The case against** is the one §A.47's closing paragraph makes about W6: a compile-time guard
  must not be re-keyed on which engine methods test quiescence, and a reader could take this rule
  as saying the engine cannot handle the other case — which is no longer true. So the refusal, if
  it lands, has to be justified as authoring hygiene and say in its own message that the runtime is
  fine either way.
  **Closes when** the maintainer picks: refuse it (`GRAPH0nn`, a new code, with the message saying
  the runtime handles it and this is about intent), warn on it, or record the decision not to and
  say why beside W6.

- ~~**D.9 · Whether a join may release a fold with ZERO contributions and the run report
  `succeeded`.**~~ **ANSWERED as (a), and by the WAVE ORCHESTRATOR following this row's own
  written recommendation — NOT by the maintainer.** That is recorded here because §D is the
  section of decisions the maintainer owes, and this one was taken without them: it is reversible
  at the cost of one predicate and one test file, and the argument it rests on is the row's.
  Built at `6b7ed2c7`, corrected at `ee316e88`, disclosed at `b9bdb5f4`; §A.55 closes with it.
  **What (a) became.** Not `branchCount === 0 && expected > 0` as this row wrote it — that counts
  branch COORDINATES — but `succeededMembers === 0 && members.length > 0`, in `#foldJoin`, the
  place that already owns what a release MEANS. `members.length > 0` plays the part `expected > 0`
  was written for and does it without a second copy of `#maybeFireJoin`'s fan-out arithmetic,
  which is deleted from `#foldJoin` rather than commented.
  **The cost, precisely, and it is the one this row priced and accepted.** A run fails now where
  it succeeded before **iff no member of the barrier succeeded** out of a fan that planned at
  least one — under `onBranchError: "skip"` as much as `"fail"`, and in all four modes. Unchanged
  and pinned: a PARTIAL loss folds and succeeds; a degraded branch whose earlier member wrote
  folds; a fan whose branches all SUCCEED writing nothing folds; a fan-out over an EMPTY array
  folds and succeeds (§A.47's `#fireEmptyJoin`).
  **(b)** — a `join.minBranches` knob — was declined for the reason written here: it prices a
  correctness question as configuration and leaves the unsafe default standing. **(c)** —
  accepting the semantics — was declined because it leaves a gate-reject run looking exactly like
  success in the journal.
  **The repro this row carried, re-run on `015f3547`:**
  `node --test packages/core/test/run/join-all-branches-fail.test.ts` → **7 pass / 0 fail**. The
  row said 3, which was the count before the answer added the static-arms, degraded-branch and
  all-succeed-writing-nothing suites.
  `examples/README.md` gained the operator-facing paragraph, under a graph that can actually
  reach the new arm — `fan-out-join.json` declares `onBranchError: "fail"`, so the older arm fires
  there first.
  **THE RESIDUAL WAS §A.67, AND IT IS NOW CLOSED** (`4700a03d` … `0081c058`): an APPROVED
  `human_gate` named in `join.branches` was a member that succeeded, so it disarmed this refusal
  for its whole barrier — and GRAPH021 requires the gate to be named there. `#foldJoin` now asks
  the barrier's WORK members, with an evidence-only fallback that leaves this answer verbatim where
  a barrier has none. What that closure leaves is §A.70 (a nested join over an empty fan is a work
  member that produced nothing) and §A.72 (the fold is final at a short-circuit release).

- ~~**D.10 · What a channel carries when a tool fails, truncates, or holds a secret — ONE decision
  for §A.82, §A.83 and §A.90.**~~ **ANSWERED 2026-09-22 by the maintainer: option (a)** — ONE
  reserved ERROR PROJECTION per node, which an `error` arm and a `function` body may both declare in
  `reads`, shaped `{ok, code?, message?, truncated?, bytes?, classification?}`. **Phase one ships
  the FAILURE projection only**, which is enough to close §A.90; **truncation (§A.83) and
  classification (§A.82) are OPTIONAL FIELDS OF THE SAME ENVELOPE, never a second shape** — the
  reserved fields are what buys option (a)'s own named risk, *once the shape is written it is
  frozen*. Constraints: missing ≠ unreadable ≠ path-refused must be DISTINCT codes (a projection
  still saying only `E_TOOL_SOURCE_UNAVAILABLE` does not close `DESIGN.md` item 30); unannotated
  defaults to `untrusted` (D4's axis) and "no projection" is never read as "success"; the truncation
  marker never again goes into `content`. (b), (c) and (d) were refused with reasons — (d) a per-run
  ledger is allowed LATER as product hardening and **cannot close this row**. The shape and the
  three refusals are `DESIGN.md` **D8** — that file's Decisions section, not this file's §D.8 one
  dot away; the options as they were put to the maintainer are kept below, because a decision's
  argument is the thing a future reader needs. Three rows, one question, and answering it three
  times is how a channel shape becomes three shapes. **§A.90 is the one to answer first** — the
  project's own priority rule, *silent-and-wrong outranks loud-and-missing*: it is the only row in
  this file that ends in destroyed data with exit code 0. **Its repro lives on §A.90's own row and is not
  copied here** — a second copy is the copy that rots (`DESIGN.md`'s own rule above its Sequence
  tables). Re-run for this settlement on `29c8b9ec`, it still ends `exit=0`,
  `{"status":"succeeded","historySource":"none"}`, and the ledger holding `["u:ravi"]` where it held
  `["u:sam"]`.
  **What each row needs, so the shape is chosen against all three and not against the loudest.**
  §A.90: the failure's CODE and MESSAGE as a projection an `error` arm may declare in `reads` —
  three different outcomes (absent, unreadable, refused by the sandbox) currently wear
  `E_TOOL_SOURCE_UNAVAILABLE` alone and the `content` that would tell them apart reaches no channel.
  §A.83: *this read was truncated* OUT of the content string and onto the channel — `builtin/tools.ts:370`
  is where the cap is applied and `:385` is where the marker is appended INTO the returned text,
  while the `{bytes, truncated}` beside it reaches no `function` body — **and at all THREE sites,
  not just `fs.read`**: `:305` is `proc.exec` and `:1179` is `net.fetch` (default `100_000`), which
  is the reason to take this decision once rather than per tool. §A.82: a per-key classification in
  BOTH directions — *this key's value is a credential*, and *this key's value is not, whatever it is
  called* — because `security/redact.ts` reads NAMES and is both narrower and wider than a
  workflow's own predicate.
  **The options, and none of them is "widen the regex" or "raise `maxBytes`":** those move the gap
  rather than close it, and §A.82 says so in its own text.
  **(a)** One reserved ERROR PROJECTION per node, declarable in an arm's `reads` — closes §A.90
  directly, and §A.83's truncation becomes a non-fatal member of it. Cost: a new channel shape in
  `graph/spec.ts` and a `validate.ts` rule, and it is the kernel.
  **(b)** A per-channel DESCRIPTOR carrying classification and completeness beside the value — one
  mechanism for all three, and the largest change: every reducer and every projection learns it.
  **(c)** Refuse instead of truncating and instead of guessing: a read fails when the cap is hit and
  the caller did not ask for truncation, at all three sites, and a failed tool's typed error reaches
  the arm. Fails CLOSED, which is the allowed direction, and is the cheapest of the three.
  **(d)** The structural alternative for §A.90 alone — a per-run ledger file, which cannot lose an
  entry to a failed read and converts a silent loss into a spurious gate. It does not answer §A.82
  or §A.83 and is not a substitute for the decision.
  **Closed when** the maintainer picked one and it was written beside the shape it chose — (a), on
  2026-09-22, at `DESIGN.md` D8. **What remains is IMPLEMENTATION and it is not this row**: §A.90,
  §A.83 and §A.82 each keep their own half of the closing condition, and the `KNOWN HAZARD` test at
  `packages/core/test/examples-grant.test.ts`:995 — which asserts today's LOSS — must go RED and be
  DELETED along with the port's `look` node (`examples/graphs/grant-access.json`:54 and its edges at
  :136–137), rather than loosened. `DESIGN.md` Sequence item 30 is the roadmap entry and now says
  the shape is decided; **it closes on the ENVELOPE (all six fields declared) plus the FAILURE
  producer, and §A.83 and §A.82 stay open rows after it** — *that phasing is the orchestrator's
  reading of the maintainer's four-step order, whose own sentence is "phase one lands only the
  failure projection, which is enough to close §A.90", and it is flagged for him to confirm.*
  **The decided ORDER**: record the shape (done) → implement the projection and branch
  `grant-access`'s `error` arm by code → delete `look` and the hazard test → then §A.68's word.
  **Not in parallel**: splitting this back into three rows, or a per-run ledger alone declared to
  close item 30.

- **D.11 · The shape-break policy for exported kernel constants — `EDGE_FIELDS`, `POLICY_FIELDS`,
  `NESTED_FIELDS` — which `check-surface.mjs` cannot see.** *(Raised by §A.62's own closing clause —
  "whether that is a shape break the project owes a policy on is on the owed list" — and by the two
  LEDGER WATCH cells in §State, which is where §A.81(a)'s repeat of it is recorded. This row is
  where the owed list actually says it.)* `check-surface.mjs` pins the exported NAME SET, so a
  constant whose TYPE changes from an ARRAY to a RECORD is "unchanged" to it. It has now happened
  twice: `EDGE_FIELDS` in the 2026-09-22 wave and `POLICY_FIELDS`/`NESTED_FIELDS` in the 2026-09-22b
  one, both under `fix:`, both in `graph/spec.ts`, which IS on `scripts/kernel.json` — so
  `check-kernel.mjs` did not ask for a trailer either, `fix` being free to touch the kernel. Repro,
  the guard agreeing that nothing moved, and then what an out-of-tree reader gets:
  ```
  $ node scripts/check-surface.mjs
  surface guard ok: 542 public exports, unchanged
  $ node -e "import('./packages/core/src/index.ts').then(m=>{for(const n of ['EDGE_FIELDS','POLICY_FIELDS','NESTED_FIELDS']){
      const v=m[n];let inc;try{inc=String(v.includes('kind'))}catch(e){inc='THROWS: '+e.message}
      console.log(n,'array?',Array.isArray(v),'| .includes ->',inc,'| .length ->',String(v.length))}})"
  EDGE_FIELDS array? false | .includes -> THROWS: v.includes is not a function | .length -> undefined
  POLICY_FIELDS array? false | .includes -> THROWS: v.includes is not a function | .length -> undefined
  NESTED_FIELDS array? false | .includes -> THROWS: v.includes is not a function | .length -> undefined
  ```
  **The break is worse in one direction, and the measurement above is what makes it a decision
  rather than a style note**: a `.includes(…)` or spread reader THROWS, so it is discovered on the
  first run; a `.length` reader gets `undefined`, so `for (let i = 0; i < v.length; i++)` runs ZERO
  times and the reader validates nothing while reporting that it did. That is property 2's failure
  mode — an extension author outside this tree, with no way to learn.
  **The options. (a)** Teach `check-surface.mjs` to pin the SHAPE of an exported const (array vs
  record, and the key set) as well as the name; it is `scripts/`, not the kernel, and the cost is a
  second snapshot file that moves whenever a field is added. **(b)** Leave the guard alone and make
  it a COMMIT rule: a shape change to an exported const is `feat:` and owes a `Kernel-seam:`
  trailer, whatever else the commit does — which is the ledger-watch paragraph in `CLAUDE.md` §1
  turned into a requirement, and is unenforceable by any script. **(c)** Argue that these three
  constants are not part of the surface a stranger may read, and export a function instead of the
  data — which changes `graph/spec.ts` and is the only option that makes the question go away.
  **Closes when** the maintainer picks one and the argument is written where the next reader of
  `check-surface.mjs` reaches it. Until then the guard reads "unchanged" and the reason it does is
  here rather than nowhere. Cross-refs: §A.62's closing clause, §State's two LEDGER WATCH cells,
  `docs/handoff-2026-09-22b.md` §4, and `DESIGN.md`'s owed-decision list after item 31.
---

## E · Deferred on purpose, with the reason — do not silently revive

**"Do not silently revive" is not "never revive."** The reason IS the deferral, so a reason that
stops being true takes the deferral with it.

- **E.1 · Distributed deployment.** A distributed v1 by a small team yields a distributed prototype,
  not a product. The half of this that was false is now §B.1.
- **E.2 · Partition assignment and cross-run fairness.** Half a coordinator is worse than none: a
  cursor lets one plane traverse the listing and gives two no way to divide it, and dividing needs a
  fact that spans runs, which `journal/store.ts` says the journal has nowhere to hold.
- **E.3 · Automated candidate generation, canaries and auto-promotion.** "Under roughly thirty
  scored trajectories per cohort, any candidate is fitted to noise" (`MIN_COHORT_SIZE = 30`). The
  sample argument survives; **its premise did not**, so this must be re-argued rather than inherited.
- **E.4 · Subtractive graph mutation.** Additive-only keeps the executed graph a superset of the
  compiled one, which is what makes the compiled artifact meaningful. Verified: removal is
  unrepresentable in the mutation type.
- **E.5 · Custom user-authored reducers.** Reason: arbitrary code inside the determinism boundary.
  **Worth re-examining on the merits** — that boundary now exists and is proven, and a closed reducer
  set is one of the three things `README.md` says still needs a fork.
- **E.6 · Free-form agent chatter.** "Makes termination unprovable and replay quadratic." The
  precondition holds; the reason is **unverifiable** — there is no chatter to replay.
- **E.7 · seccomp / Landlock.** "Platform-specific" holds — both are Linux-only and this tree runs
  darwin. The clause claiming the threat model was covered was false (the three mitigations bind this
  plane's OWN tools, and `proc.exec` is outside all three); the boot banner now names it as off.
- **E.8 · Vendor callback parsing.** Signature verification IS built and tested
  (`SignedWebhookChannel` implements Slack's scheme end to end). Missing: per-vendor payload SHAPE
  parsing, and an email transport (`email` is only an `Actor.via` label).

**Do not re-enumerate the fork list here.** It lives in `README.md`, "Extending it, and where that
stops"; count it with
`sed -n '/^## Extending it, and where that stops$/,/^## Why this exists$/p' README.md | /usr/bin/grep -a -c '^- \*\*'`
→ 3 today. That list moving the wrong way is property 2's alarm; shrinking it is what property 2
means in practice.

---

## F · Properties to preserve, not history to honour

Each cost real debugging time and would cost it again.

1. **Every durable fact must be rebuildable by folding the log.** The unit needing a restore path is
   the *producer*, not the field. The enumeration is SPLIT across
   `packages/core/test/run/oversight-survives-restart.test.ts` and
   `packages/core/test/run/escalation.test.ts` — search either for `MEMBER`. **A pointer to an
   enumeration is only as good as that enumeration's own discipline about growing.**
2. **A vocabulary with two representations will drift**, and every gate walking the wrong one is
   silently switched off. Prefer a form the type checker can walk; where a test must do it, gate all
   representations as one set and read them from the source.
3. **A guard's permissive branch is where the surprise lives.** Refusals attract tests; the arm that
   lets something through does not.
4. **Mutation-test every guard.** A test whose expected value could also come from a fallback path is
   a tautology waiting to be discovered.
5. **Driving beats sweeping.** Sweeps derived from the last finding mostly find nothing, because in a
   disciplined codebase most findings are exceptions rather than instances of a class.
6. **A test built from the same mental model as the fix certifies the model, not the mechanism.**
7. **Reproduce by running, not by reading** — including when correcting a document. A correction that
   replaces a false claim with a differently-false one is worse than the original.
8. **Name the set a claim covers.** A count nobody can enumerate is a count nobody checked.
9. **A self-describing claim has no fixed point.** State the invariant, not the measurement, when the
   claim is about the artifact containing it.
10. **`node:vm` is not a sandbox** — it is scoping. Untrusted code needs a process boundary.
11. **Absence is not zero, and an empty allow-list is the permissive case.** "Named nobody" and
    "could not read who it names" must never produce the same value.
12. **Approve means "go ahead", not "consider it done"** — on every node type except the gate itself,
    there is work behind the gate. Checked by
    `node --test packages/core/test/run/approve-means-go-ahead.test.ts`, which drives one gated graph
    per node type off a `Record<NodeType, Case>`, so a ninth member is a COMPILE error there.
13. **A terminal operation is not final until every producer of the state it ends is stopped.**
14. **Cross-realm values look identical and are not**; assert on the prototype, and know that
    `Array.isArray` is realm-agnostic and throws on a revoked proxy.
15. **A plain `grep` can silently skip a file, and empty output is not evidence of absence.** Always
    `/usr/bin/grep -a`, and the path matters — this shell's `grep` is a ugrep wrapper passing `-I`.
    **The trigger set is NUL ∪ invalid UTF-8**, not non-ASCII. **Do not count the affected files with
    grep** — a skipped file is only reported when it also matches your pattern, so grep undercounts
    and the count moves with the search term. Census instead: read every `git ls-files` path and test
    for a zero byte (5 files today, 0 invalid UTF-8).
16. **A fake credential in a doc must LOOK fake, or a scanner is right to stop you.** And the lesson
    that cost more: **a secret scan that names one vendor's shape is not a secret scan** — a scan for
    `sk-` cannot match Stripe's `sk_`, so the claim was broader than the check.
17. **A ratio of two timings is not more robust than one timing.** The noise compounds
    asymmetrically, so a gate written as `t_big / t_small < K` is **likeliest to pass when its own
    denominator sample is worst.** THE MEASUREMENTS, which `CLAUDE.md` cites this entry for:
    `compile scales sub-quadratically` went green only on the run whose 100-node baseline was
    15.5 ms against 4.5–5.0 ms everywhere else, and the layout bound's 500-node sample twice came
    back FASTER than its 100-node one. The replacement in both cases was a deterministic counter (a
    `Proxy` counting the property reads the code makes), byte-identical run to run. Where a timing
    must stay, make it ONE absolute bound with an order-of-magnitude margin, never a ratio.
18. **Cite a source by SYMBOL, never by line number.** Checked by
    `/usr/bin/grep -aon '[a-zA-Z_/-]*\.ts:[0-9][0-9]*' TODO.md DESIGN.md` — every remaining match must
    be either a path under `test/` or a record of what a pointer USED TO BE. **Not one is a live
    pointer into `src/`, which is what makes this rule checkable rather than merely stated.** A symbol
    fails LOUDLY when renamed; a line number goes stale on the next commit and fails SILENTLY, by
    pointing at something plausible. **A claim about a SET checked by a grep over one MEMBER of it is
    the same defect as a stale line number**: it fails silently, by looking checked.
19. **The kernel guard's job is to force a question, and "relabel until it passes" is the failure it
    exists to catch.** The honest answers are a `Kernel-seam:` trailer or an argument for the label,
    written in the commit body where the ledger can be audited against it. `552d999` is the worked
    example: no mechanism added, no vocabulary added, and it RESTORES a property the code already
    claimed. **A `fix` label that cannot survive being spelled out in the commit body is a `feat`
    wearing a disguise**, and the guard cannot tell the two apart — only the argument can.

---

## G · Field-survey work the redesign creates

Each traces to a decision in `DESIGN.md`.

- **G.1 · Declared effects (D2) for `evaluator` bodies and the sandbox.** Repro:
  `/usr/bin/grep -anc 'GRAPH020_UNKNOWN_FIELD' packages/core/src/graph/validate.ts` → 1;
  `ALLOWED_FIELDS.evaluator` refuses `effects`, which is the correct fail-closed state and is pinned
  by `test/run/evaluator-body-contract.test.ts`. Done for `function` nodes. **The row's old reason
  was wrong twice** (driven 2026-09-02): a resource-loaded body's missing effects is the SANDBOX's
  limit and applies to `function` nodes identically — they get a throwing `E_EFFECT_UNAVAILABLE`
  stub, not an absence — and an in-process assertion body AWAITS fine, so `ctx.effects` is undefined
  there because nobody wired it. The real blocker is where the DECLARATION would live: opening it is
  a schema change to `graph/spec.ts` and a wiring change to `run/engine.ts`, **both kernel files,
  under a `feat`** — a `Kernel-seam:` trailer and a maintainer's call. **Closes with**
  `EvaluatorNode.effects` + `ALLOWED_FIELDS.evaluator` + `reachableToolNames` reading it
  unconditionally, `validate.ts`'s effects-shape check widened past `n.type === "function"`,
  `#effectsFor` keyed off the node, and — **in the same commit** — `isExternal` moved, because its
  docstring trusts an `assertion` evaluator on the ground that the arm binds no `ctx.effects`, which
  stops being true the moment this lands. `kind: "rubric"` gets nothing and should be REFUSED.
- ~~**G.2 · `Date` in the realm.**~~ CLOSED at `18bd9f4`: `Date` is bound to `ctx.now` in the
  `function` and `evaluator{assertion}` realm. The row's own reason held to the end — not "no seed
  could make it reproducible" but "a frozen `Date` that silently never advances is more surprising
  than an absent one" — and `ctx.now` is the seed that made the first half moot.
  `RealmOptions.bindDateToNow` builds a `Date` ENTIRELY IN-CONTEXT (never a host closure, which would
  carry the host `Function` on its prototype chain) whose zero-arg forms — `new Date()`, `Date()`,
  `Date.now()` — read a per-call cell and throw `E_EFFECT_UNRECORDED` until a call seeds it, closing
  the same definition-time-IIFE window `DENY_UNSEEDED` already closes for `Math.random`.
  Explicit-argument forms forward to the real `Date` through `Reflect.construct`, untouched.
  `resources/functions.ts`'s `ARGUMENT_BRIDGE` seeds the cell from `p.now` in the same place it
  reseeds `Math.random` from `p.seed`, and is the ONLY caller that opts in
  (`/usr/bin/grep -arn 'bindDateToNow' packages/core/src` → 16 lines, one of them
  `functions.ts:470`'s `bindDateToNow: true`). `shadowsHeld` gained a positive identity check against
  what `DATE_INSTALLER` actually installed, matching the strength the `Math.random` check already had.
  **RESIDUE, three parts, and none of them was created by this change.**
  (a) **`Intl` stays shadowed to `undefined`**, and its default-locale/timezone leak is a separate,
  narrower concern: shadowing the `Intl` binding does not reach the intrinsics behind it, and
  `Intl.DateTimeFormat.prototype.format` called with NO argument defaults to the wall clock. Written
  out at `resources/realm.ts:117-140`, where `Date` and `Intl` now differ ON PURPOSE.
  (b) **Hook bodies get nothing**, because `HookContext` has no `now` to bind to. `hook-loader.ts`
  is unchanged and a hook realm's `Date` is still `undefined`.
  (c) **`Temporal` could not be bound because it does not exist on this build.** Repro:
  `node -e 'console.log(typeof Temporal)'` → `undefined` on `node -v` → `v24.16.0`. The row's
  instruction to "bind `Temporal` in the same change when it becomes a default global" is therefore
  still owed, and reopens the day a Node this project builds on ships it.
- **G.3 · Divergence must be terminal and loud.** The known failure mode of every replay-based runtime
  is a silent stall: the task retries forever without entering a failed state. `E_REPLAY_DIVERGENCE`
  is fatal, so the recorded-effect path is covered. **Closes when** a repeated divergence signature
  with no forward progress gets its own terminal state.
- **G.4 · Two-axis labels (D4): unlabelled ⇒ untrusted. DONE on the integrity axis.** Repro:
  `/usr/bin/grep -anc 'applySecretFlow' packages/core/src/run/engine.ts` → 4. Both axes exist
  (`tainted`/`applyTaint`, `carriesSecret`/`applySecretFlow`) and `isExternal` no longer defaults to
  trusted (`test/run/unlabelled-is-untrusted.test.ts`). **What is left is the CONFIDENTIALITY axis:**
  `applySecretFlow` still reads the declared classification, so an unclassified channel carrying a
  secret is trusted by default — and the fix is not symmetric, because there is no `effects: []`
  equivalent and marking every unclassified channel sensitive is the constant-gate failure that arm's
  docstring already refuses. **Closes when** that asymmetry has an answer.
- **G.5 · Prompt text is bound by the MANIFEST, not by the hash (D7). Closed 2026-09-01 except one
  residue.** Repro: `node --test packages/core/test/run/graph-binding.test.ts` → 6 pass / 0 fail;
  "THE SAME SPEC WITH DIFFERENT RESOURCES IS REFUSED" asserts the graphHash is IDENTICAL while
  `resolutionManifest` moves and `resolveGate` throws. A subgraph's own
  refs were the half that was real and are now walked into the manifest (`graph/compile.ts`;
  `test/resources/store.test.ts`, "THE PINNING RULE REACHES INTO A SUBGRAPH"). **The residue, and the
  whole of what this row carries:** `#assertBound` checks the manifest only when the attached graph IS
  the compiled one, so a MUTATED run's successor carries no recorded manifest to compare — mutation
  is unreachable from the binary today. **Closes when** it records one.
- **G.6 · Proposed-API mechanism and a version pin (D5).** Repro:
  `/usr/bin/grep -arc 'proposed' packages/core/src/index.ts` → 0. Both halves unbuilt: no
  proposed-API declaration file, no opt-in, no publish-time refusal for an extension that uses one,
  and no runtime version pin. **Closes when** they exist.
- **G.7 · One retry budget per run. THE MULTIPLICATION IS GONE; THE BUDGET WAS NOT BUILT, and that is
  the decision rather than the omission.** Repro:
  `node --test packages/core/test/run/retry-does-not-multiply.test.ts` — `HttpOptions.maxAttempts`
  defaults to 1, so the engine's journaled curve is the only one: `{requests: 3, retriesScheduled: 2}`
  where engine × transport gave `{requests: 9, retriesScheduled: 2}`. A fourth `Budget` dimension
  would have touched three kernel files under a `feat` to buy what deleting the duplicate layer buys
  for nothing. **The cost, named:** an embedder driving an adapter with no engine above it loses two
  silent pre-response retries (`maxAttempts: 3` restores the old curve), and a `RunGraph` whose
  `plans` a caller assembled WITHOUT the compiler loses its only retry. **Reopen a run-scoped budget
  if fan-out width turns out to be the real multiplier** — 3 requests × a wide fan-out is the same
  arithmetic one level up.

---

## H · Housekeeping

- **H.0 · A delegating chain raises one gate per level, and that was the maintainer's call.** Repro:
  `node --test packages/core/test/run/approve-means-go-ahead.test.ts`. Closing A.7 means
  `top → mid → leaf` over an irreversible child asks a human three times where it asked once. Put to
  the maintainer with the alternatives (gate only the outermost; revert to a compile diagnostic) and
  **decided: keep it** — a non-subgraph graph already asks at every node that transitively reaches
  the tool, so the old behaviour was the subgraph route being LOOSER, and the human is asked BEFORE
  the child does reversible work. **Reopens if** an operator reports that nested delegation is
  unusable in practice; the mechanism then is one approval covering a chain, which needs a rule for
  what happens when the chain's shape changes mid-run.
- ~~**H.1 · `bin/loom` is gitignored and goes stale on any source edit.**~~ CLOSED — not by a
  watcher (under §D's single-operator framing a rebuild is a command a person runs) but by
  `scripts/verify-binary.mjs`, which drives the PRODUCED ARTIFACT through the freshness guard's four
  cases (CURRENT, STALE, OVERRIDE, SHIPPED) plus a `binary` CI job. The hole was that a source grep
  cannot check an artifact: a binary built before the guard existed does not carry it and cannot say
  so — measured 8 days and 48 files behind, exit 0, silent. Deliberately NOT in `npm run check`.
  **Reopens on** more than one operator, or a published binary.
  **2026-09-23: that reopening is now one act away** — `DESIGN.md` item 29 made the npm package
  publishable (`private: true` is all that stops it), so the maintainer's publish reopens this row.
  What it reopens ON is narrower than "a binary": an npm-installed `loom` is `dist/`, not the SEA,
  and has no sources beside it, so the freshness guard never applies to it; what goes stale there
  is a user's installed VERSION, which `loom --version` now answers. A SEA binary published to a
  release would reopen the row in its original sense.
- ~~**H.2 · The 2026-08-29 renumber broke FOURTEEN in-tree citations of this file.**~~ CLOSED —
  thirteen by `814e283` and a fourteenth its own command could not see (`cli.ts` wrote `TODO §D.19`
  with no `.md`, and the published grep hard-required `TODO\.md`). Two resolved after the renumber to
  a *plausible, unrelated, live* row instead of to nothing. **Run BEFORE the next renumber:**
  `/usr/bin/grep -arno 'TODO\(\.md\)\?[^"]\{0,4\}§\?[A-Z]0\?\.\?[0-9]*' packages/core/src packages/core/test scripts *.md`
- ~~**H.4 · `--otlp` is the only verb-scoped flag on this CLI.**~~ CLOSED by `96a03bf` on the
  condition this row set — a verb→flag applicability table now exists, so a flag on a verb that does
  not read it is REFUSED rather than ignored. The general form was built rather than the exception
  defended.
- ~~**H.3 · `effectiveTimeout`'s docstring names a set of three and then enumerates four.**~~ CLOSED
  by `e8c2fb5`, and the row UNDERCOUNTED its own survivor set — four count-claims in the region now
  name their members instead, pinned by `test/graph/deadline-set-is-named-not-counted.test.ts`, which
  parses the `NodeType` union out of `graph/spec.ts` so a ninth node type fails there.
- ~~**H.5 · `run/engine.ts`'s `driveToRest` comment names four node types this binary now
  adjudicates.**~~ CLOSED at `2b6bc06`, a `fix:` on kernel prose. The comment now splits the two
  questions the old one ran together: the four types are the ones where "the holder is dead" is not
  knowable FROM THE GRAPH, and whether it is knowable AT ALL is the DEPLOYMENT's answer — an embedder
  taking the default `new InProcessScheduler()` still parks such a run `running` for ever, while
  under this binary `openWorkspace` passes `STRANDED_LEASE_MS` and those four ARE adjudicable.
  Repro now: `/usr/bin/grep -an 'holder is dead' packages/core/src/run/engine.ts` → `3276`, and the
  paragraph around it names both cases.
  THE ROW AS IT STOOD: KERNEL PROSE, so a `fix:` docstring change is owed and it is a row rather
  than a drive-by. Repro:
  `/usr/bin/grep -an 'holder is dead' packages/core/src/run/engine.ts` → `3141`, inside a block
  (lines 3139-3143) reading *"the four node types with no enforced deadline (`join`, `router`,
  `human_gate`, `subgraph`) are the ones where 'the holder is dead' is not knowable"*. That was true
  until `7952c6a`: `openWorkspace` now passes `STRANDED_LEASE_MS`, so under this binary those four ARE
  adjudicable and `cli.ts:5967` already says so. The claim is still true for an embedder who supplies
  no `strandedLeaseMs`, which is what the corrected sentence has to say. The lane that made it false
  named it and left it, because `run/engine.ts` was another lane's file that wave. **Closes when** the
  comment distinguishes the default scheduler from the one the CLI builds.
- ~~**H.6 · `loom --help` describes a four-member extension registrar; `README.md` documents
  ten.**~~ CLOSED at `52d4b43`, and the count is DERIVED rather than typed: `EXTENSION_REGISTRAR_OPENS`
  (`cli.ts:133`, its docstring from `:119`) is one row per thing the flag opens, `USAGE` interpolates
  `Object.keys(EXTENSION_REGISTRAR_OPENS).length`, and
  `test/cli/extension-registrar-help.test.ts` loads a module that reports `Object.keys` of what its
  factory was actually handed and asserts `--help` names every one — so a member added to the call
  and not to the table fails a test instead of quietly making `--help` false again. **Ten are passed
  and nine are rows**: `jail` is the exception, because it is not something an operator registers
  against but the operator's own jail handed through. Repro now:
  `/usr/bin/grep -an 'FOUR things need no fork' packages/core/src/cli.ts` → no hits; `:364` reads
  `${Object.keys(EXTENSION_REGISTRAR_OPENS).length} things need no fork`.
  THE ROW AS IT STOOD: *(F5.)* File: `packages/core/src/cli.ts`, the `--extension-module` help
  text. Repro, at the source
  so it needs no built binary — `/usr/bin/grep -an 'models, tools, channels, identity' packages/core/src/cli.ts`
  → 4 hits, of which `:303` is the HELP TEXT naming four members while `:2839` is the call actually
  passing ten; and `/usr/bin/grep -an 'FOUR things need no fork' packages/core/src/cli.ts` → `:305`.
  `loom --help | /usr/bin/grep -a -A2 'extension-module P,P'` shows the same. Meanwhile README's "Extending
  it, and where that stops" documents `{channels, functions, hooks, identity, jail, models, payloads,
  resolver, store, tools}` and nine `--extension-module` rows, including `store.register`, which
  README calls "the sharpest row on the list". A stranger who reads `--help` — the thing in front of
  them — does not learn that `store`, `resolver`, `functions`, `hooks`, `payloads` or `jail` exist.
  **Closes when** the help text names the same set the registrar actually passes, with the count
  derived rather than written.

- ~~**H.7 · TWO stranded docstrings in `run/engine.ts`, and the second is why the first is hard to
  see.**~~ Repro:
  ```
  $ /usr/bin/grep -an 'A refused SoD gate\|A RETURN NOBODY READS' packages/core/src/run/engine.ts
  1110: * A refused SoD gate, as a failed OUTCOME rather than a throw.
  1121: * A RETURN NOBODY READS IS AN AUTHORING MISTAKE, NOT AN EMPTY RESULT.
  $ /usr/bin/grep -an '^function requireOutcome\|^function sodOn' packages/core/src/run/engine.ts
  1230:function requireOutcome(out: unknown, ref: string, nodeId: NodeId): FunctionOutcome {
  1379:function sodOn(node: NodeSpec, p: RunProjection): NodeOutcome | undefined {
  ```
  The SoD paragraph at `:1110` describes `sodOn`, **269 lines below it**, and the next declaration
  after it is not `requireOutcome` either: between `:1121` and `:1230` sit `seedFromKey` and its
  docstring, `REBIND_DEADLINE`, `Rebindable`, `OUTCOME_KEYS`, `VERDICT_KEYS`, `WHY_EXCLUSIVE` and
  `WHY_ONE_VERDICT`. The paragraph at `:1121` DOES belong to `requireOutcome` and is stranded a
  hundred lines above it. KERNEL PROSE, so a row rather than a drive-by, and the same class as §H.5
  and §H.3 — prose that was true where it was written and was left behind by insertions above it.
  It is PRE-EXISTING: at `2309d3a` the same three offsets are 1103 / 1190 / 1249.
  **Closes when** each paragraph is adjacent to the declaration it describes. "The function it names
  is the next declaration" is NOT the check — `:1121` names no function, and a file that interleaves
  constants between a docstring and its subject can satisfy it while still being wrong. The check is
  a reader's: open the file at each line and see what is under it.
  **CLOSED at `52d6c99`, a pure move — no prose rewritten.** Repro now:
  ```
  $ /usr/bin/grep -an 'A refused SoD gate\|A RETURN NOBODY READS' packages/core/src/run/engine.ts
  1197: * A RETURN NOBODY READS IS AN AUTHORING MISTAKE, NOT AN EMPTY RESULT.
  1369: * A refused SoD gate, as a failed OUTCOME rather than a throw.
  $ /usr/bin/grep -an '^function requireOutcome\|^function sodOn' packages/core/src/run/engine.ts
  1219:function requireOutcome(out: unknown, ref: string, nodeId: NodeId): FunctionOutcome {
  1379:function sodOn(node: NodeSpec, p: RunProjection): NodeOutcome | undefined {
  ```
  Each paragraph now ends at the declaration it describes — nothing but its own body between them
  (269 lines became 10; 109 became 22, all of it the docstring). The check the row specified is a
  reader's and was done by one.

- ~~**H.8 · `redactGateRead` in `cli.ts` is a second spelling of `server/http.ts`'s private
  `redactChannels`.**~~ Repro:
  ```
  $ /usr/bin/grep -an 'function redactGateRead' packages/core/src/cli.ts
  5298:function redactGateRead(
  $ /usr/bin/grep -anc 'redactChannels' packages/core/src/server/http.ts
  8
  ```
  It arrived with §A.43 (`da86076`) and its own docstring DISCLOSES the duplication rather than
  hiding it: *"IT IS A SECOND SPELLING AND THAT IS A SEAM, NOT A DECISION. `redactChannels` is
  private to `server/http.ts`; the honest fix is one shared function, and it belongs to whoever owns
  that file next."* It is recorded here so it is a known duplicate rather than a discovered one: the
  failure mode of two spellings of a redaction rule is that a future classification is handled by one
  and not the other, and this is the axis where the non-negotiable says loosening never is.
  **Closes when** one function serves both, with the shared one living where neither file has to
  import the other's private surface, and a test that adds a classification and asserts BOTH doors
  blank it.
  **CLOSED at `ac6a293`, a `refactor:`.** One rule, in `packages/core/src/security/redact-channels.ts`,
  serving both doors: `cli.ts:78` imports `redactChannelValue` and `server/http.ts:234` imports
  `redactChannelMap`, so neither file reaches into the other's private surface. Repro now:
  `/usr/bin/grep -anc 'function redactGateRead' packages/core/src/cli.ts` → **0**. **It is
  deliberately NOT re-exported from `index.ts`** — the surface guard still reports 542 exports,
  unchanged — because a redaction rule two in-tree callers share is not a thing a stranger needs to
  import, and exporting it would pin it. Repro:
  `node --test packages/core/test/cli/redaction-two-doors.test.ts` → **3 pass / 0 fail**; it adds a
  classification and asserts BOTH doors blank it, which is the test the row asked for.

- ~~**H.9 · README's test-count FLOOR cannot be raised without editing the guard that checks it.**~~
  Repro:
  ```
  $ /usr/bin/grep -an '2,300' packages/core/test/readme-gaps.test.ts
  477:    claims: "2,300+ tests",
  $ npm test   # suite total
  ℹ pass 3750
  ```
  `readme-gaps.test.ts`'s Gates probe is well designed in one direction: it parses `(\d[\d,]*)\+
  tests` out of the Gates ROW and asserts the stated floor is at or below what the suite actually
  holds, counted from the test files — *"A FLOOR in the prose, so growth costs no doc edit."* But the
  same entry ALSO carries `claims: "2,300+ tests"`, and the two table-wide tests assert that exact
  substring is present and that it appears in the Gates row. So raising the floor to `3,700+`, which
  the parse would accept and which is what the prose is for, fails the containment assertion. The
  README's floor is frozen at 2,300 while the suite is at 3,750 — still TRUE, and 38% below the
  truth, in the one row whose job is to tell a stranger how much is checked.
  It is the general shape of a claims-string pin: it binds the DOC to a spelling when what it meant
  to bind was a property. **Closes when** the Gates entry's `claims` is a spelling that survives the
  floor moving — anchoring on `+ tests` or on the row name rather than on the digits — after which
  the floor itself can be raised in the same commit. Costs one test edit and one README edit, which
  is why it is a row and not something a docs pass may do on its own.
  **CLOSED at `e345951`.** The Gates entry's `claims` is now `"+ tests, offline, no API key"` —
  anchored on the phrase that survives the digits moving, which is the property the pin meant to
  bind. Repro:
  ```
  $ /usr/bin/grep -an 'claims: "+ tests' packages/core/test/readme-gaps.test.ts
  477:    claims: "+ tests, offline, no API key",
  $ /usr/bin/grep -an '+ tests' README.md
  88:| **Gates** | `npm run check` — 3,500+ tests, offline, no API key; three guards: …
  ```
  **The floor is 3,500+ and the number it was chosen against is the PROBE's, not `npm test`'s** —
  the probe counts top-level `test(` calls in the test files (3,586 on the merged tree, across 342
  files), while `npm test` reports 3,817 because it counts subtests too. The floor is below both,
  and it is a floor, so growth costs no doc edit — which was the whole point of the row.

- ~~**H.10 · `npm test` writes a journal database into the repo tree, on every run.**~~ **CLOSED at
  `e7498c3f` and `b96e9c3c` — and it was TWO files, not the one this row named.** File:
  `packages/core/test/cli/known-flags.test.ts` and `packages/core/test/cli/serve-host.test.ts`; the
  product side is `openWorkspace` in `packages/core/src/cli.ts` (cited by FUNCTION, because the
  line number this row carried had already rotted twice and `resolve(pathFlag(args, "data-dir") …)`
  appears in `jailFor` as well, where it is not the defect).
  **(1)** `known-flags.test.ts` drove every member of `KNOWN_FLAGS` with the literal `"x"`, and
  `--data-dir x` resolves against `process.cwd()`, so `compile` created `<repo>/x/journal.db` on
  every run. The loop now drives ONE value for every flag — a path inside its own `mkdtempSync`
  workspace — with `--workspace`/`--data-dir` dropped from the base argv when they are the flag
  under test, so no name reaches `parseArgs` twice. **One value, not a table of which flags are
  paths**: a table is a second list to keep in step with `KNOWN_FLAGS`, and this file's whole
  subject is three lists drifting apart. Pinned as a DIFFERENCE — `existsSync(resolve(cwd, "x"))`
  before and after the loop — so a directory an earlier run left behind cannot hold the assertion
  hostage.
  **(2)** `serve-host.test.ts`'s `refusing(["nonsense"])` left `<repo>/.loom/journal.db`, because
  `main` opens the workspace BEFORE it decides the verb is unknown and `test/deployment/harness.ts`
  spawns with no `cwd`. Found by bisecting `npm test` after (1) left a `.loom/` in a worktree that
  had not been there before. It hid for the reason `x/` did, one `.gitignore` line up: `.loom/` is
  ignored, so `git status` said nothing.
  **Measured on `015f3547`, which is the repro this row asked for:**
  ```
  $ rm -rf x .loom && npm test && ls -d x .loom
  ls: .loom: No such file or directory
  ls: x: No such file or directory          # and `git status --porcelain` is empty
  ```
  **What would be false if the claim were false:** putting the value back to `"x"` turns
  `known-flags.test.ts` red with 1 failure naming the path it created — measured in the lane — and
  the `.loom` half is a straight before/after on one suite.
  **Closes when** was "the suite drives its flags in a temp directory … with the repro above
  finding no `x/` afterwards": satisfied, for both files. Adding `x/` to `.gitignore` was the wrong
  fix and was not taken. **The PRODUCT half became §H.11, and it is now closed too**
  (`57dcbcfa`, `cbc67bae`): the verb is decided before the workspace is opened.

- ~~**H.11 · `loom <unknown verb>` creates a workspace in the current directory before printing
  "unknown command".**~~ CLOSED at `57dcbcfa`, `cbc67bae` (with `11f70683` and `9b0bb527` for the
  prose and the harness). `main` decides the verb at the door — `Object.hasOwn(VERB_FLAGS,
  command)` through one helper, `dispatchesVerb`, shared with `refuseFlagsThisVerbDoesNotRead` so
  the two cannot disagree — before `openWorkspace` runs. The `default:` arm keeps the same refusal
  and is unreachable while `verb-flags.test.ts` pins `VERB_FLAGS`' key set equal to the switch's
  case labels. Prototype names came with it: `loom constructor --port 1` used to answer
  `E_INTERNAL: TypeError: applies.includes is not a function` and now answers `unknown command`.
  **A BONUS THE REVIEWER FOUND**: on the base, `loom nonsense --extension-module evil.mjs`
  IMPORTED AND RAN the module before refusing. It no longer does, and that is pinned.
  **THE SET, named rather than claimed** — the refusals decided from ARGV ALONE: no verb, `help`,
  `--help`; an unknown verb, prototype names and `--extension-module` included; an unknown flag; a
  known flag the verb does not read; a repeated `--extension-module`; and EVERY ONE of the fifteen
  names in `GLOBAL_FLAGS` given with no value. That last clause is a measurement and not a claim
  because the first cut asserted it and was wrong: **seven of the fifteen were clean and eight
  littered** — `allow-exec`, `egress`, `exec-env`, `grant`, `max-parallelism` and the three
  `budget-*` — because `openWorkspace` mkdir'd right after the two path flags. The four late
  readers (`jailFor`, `grantFlag`, `boundedCount`, `deploymentBudget`) are pure over `args` and
  were hoisted above the first `mkdirSync`, and `jailFor` now runs before `new SqliteStateStore`,
  so a bad `--egress` no longer opens a journal handle.
  **CORRECTION, 2026-09-18 — this row said "precedence unchanged (measured on six double-fault
  lines)" and that is now FALSE.** §H.12's door decides EVERY flag with an argv-only reader,
  globals included, so precedence between two bad flags in different readers is **argv order**.
  Three of the six lines moved. Re-measured for the 2026-09-18 settlement:
  ```
  compile --grant --egress                 --egress  ->  --grant       # argv order
  compile --egress --grant                 --egress  ->  --egress      # unchanged
  compile --budget-usd --max-parallelism   --max-parallelism -> --budget-usd
  compile --budget-wall-ms bad --budget-usd bad  --budget-usd -> --budget-usd  # ONE reader: unchanged
  ```
  The exception is two bad flags inside the SAME multi-flag reader — `jailFor` (5 flags) and
  `deploymentBudget` (3) — which still answer in that reader's own order. The full eight-class
  table is in `docs/handoff-2026-09-18.md` §2.
  Re-run on `a9214611`, and on the first cut `57dcbcfa` for the before:
  ```
  $ R=$PWD; D=$(mktemp -d); cd "$D"; node "$R/packages/core/src/cli.ts" nonsense 2>err; echo "exit $?"; ls -A
  exit 2
  err                                      # was: .loom  err  graphs  resources
  $ for f in <the fifteen names in GLOBAL_FLAGS>; do (cd "$(mktemp -d)"; node …/cli.ts gates --$f); done
  a9214611  15/15 leave [err] only         57dcbcfa  7 clean, 8 leave [.loom err graphs resources]
  ```
  `node --test packages/core/test/cli/refusals-leave-no-workspace.test.ts` → **19 pass / 0 fail**,
  every member driven in its own `mkdtempSync` cwd, with `GLOBAL_FLAGS.length` asserted `=== 15`.
  **NOT IN THE SET, and pinned as six litter cases rather than glossed over**: a VERB flag with no
  value (`run --input`, `serve --port`, `serve --token`) and a missing positional (`compile`,
  `score`, `gates`) still open a workspace — §H.12, with §H.13 for what those last three answer.

- ~~**H.12 · A verb flag with no value, and a missing positional, still open a workspace.**~~
  CLOSED at `db49005d`, `3b527003`, `ee93918f`, `aadc4b68` (merge `609b68ef`), together with
  §H.13. **The arity is DERIVED, which is what the row required.** `KNOWN_FLAGS` is now
  `Object.keys(FLAGS)`, and `FLAGS` is one table of 43 rows whose value is **the function that
  decides that flag's value from argv alone**, or `null`. The door calls the entry for every flag
  PRESENT in argv; the verb body calls the same function later. The arity is stated nowhere, so it
  cannot drift — there is one implementation of "does `--port` need a value" and it is `httpPort`,
  which is also why not one message was rewritten. `VERB_POSITIONALS` is the same shape one level
  up: one table the door and `requirePositional` both read, so the "what" string exists once.
  `flag-door.test.ts` RECOMPUTES the reader column from the source by the shipped rule (*the unique
  top-level `function name(args: Args)`, `main` excluded, that reads the flag; `null` when none or
  more than one does*), parses the keys a second way and asserts the two agree, and cross-checks
  both against the flags `main(["help"])` actually advertises — the one path of the three that goes
  through the module rather than over its text.
  ```
  [run --input]   exit=1 left=[] E_CONFIG_INVALID: --input was given with no value at all…
  [serve --port]  exit=1 left=[] E_CONFIG_INVALID: --port was given with no value at all…
  [serve --token] exit=1 left=[] E_CONFIG_INVALID: --token needs a non-empty value…
  [compile]       exit=1 left=[] E_CONFIG_INVALID: loom compile requires a graph file as argument 1…
  [score]         exit=1 left=[] E_CONFIG_INVALID: loom score requires a runId as argument 1…
  [gates]         exit=1 left=[] E_CONFIG_INVALID: loom gates requires a runId as argument 1…
  ```
  re-run for this settlement, each in a fresh `mktemp -d`; the three flag messages are byte-equal
  to `967128d8`'s. **THE OPEN SET IS NOW THREE, and it is derived rather than declared**: `--as`
  and `--cohort` have more readers than one, so the message depends on the verb and the door does
  not guess; `--scope` needs the runId, which is a positional. Each is driven in
  `refusals-leave-no-workspace.test.ts` (**24 pass / 0 fail**, was 19). `--help`, `--reason` and
  `--reject` are `null` and are NOT residue — `--help` is answered above the door, and a bare
  `--reason` is deliberately `"operator"` and a bare `--reject` deliberately "(no reason given)".
  Both defaults are now pinned against the JOURNAL in `operator-pause.test.ts`, because that
  paragraph is the whole argument for leaving them open and `String(true)` passed the entire suite
  without it. `test/cli` **335/335**.
  **THE GLOBALS' EXCLUSION DID NOT SURVIVE CONTACT**, and it is the decision this row really made:
  the first cut kept §H.11's globals inside `openWorkspace` and put the positional check at the
  door, which made the positional beat every global and turned §H.11's sweep red on 13 of 15. Only
  two orders exist — all flags then positionals, or positionals then all flags — and the second
  breaks `run --input`'s message, which this row requires. So every flag with an argv-only reader
  is decided at the door, globals included, and **precedence became argv order**: §H.11's row is
  corrected above, and the eight-class measurement is `docs/handoff-2026-09-18.md` §2. One message
  is a FIX rather than a move: `promote c.json --suite` bare used to answer *"--baseline needs a
  path"*. Readability residue → §H.14.

- ~~**H.13 · A missing positional answers `E_INTERNAL` and a plain `Error`.**~~ CLOSED with §H.12,
  same shas. `requirePositional(args, i)` raises
  `err.validation(CODES.E_CONFIG_INVALID, "loom <verb> requires <what> as argument <n>, and none
  was given. Run `loom help` for the usage line of every verb.")`, looking the "what" up in
  `VERB_POSITIONALS`, and the door runs it before `openWorkspace`. It covers **all 17 verbs with a
  positional, not the three the row named** — the row named the three that were reported, and the
  same throw shape was on every one. The SENTENCE is kept so an operator's grep still matches; only
  the class changes, which is a correction of a misclassification rather than a broken promise:
  `E_INTERNAL` is this tree's word for "a bug in Loom", and `server/http.ts`'s `safeDecode` already
  states the rule the old throw broke. `attestExam`'s positional stays late and explicit — it is
  CONDITIONAL on `positional[0] === "attest"`, so the door must not demand it before the
  subcommand is known.

- ~~**H.14 · A `fix:` line is 844 characters on one unwrapped line, and the CLI wraps nothing.**~~
  **CLOSED at `ff925a28`, `b3d059f4`, `e719b85b`, `396d961a`, `a42d1fc7`, `d2b63498`, `ea929446`,
  `e991cb13`, `2a8990aa` — by WRAPPING, and only on a TTY.** File:
  `packages/core/src/cli.ts`, `writeDiagnostic` / `wrapDiagnostic` / `diagnosticWidth`.
  **THE ROW'S OWN REPRO WAS WRONG AND IS CORRECTED HERE**, because it is the first thing anybody
  re-runs: diagnostics go to **stderr**, so the pipe needs `2>&1`, and the writer is
  `process.stderr.write`, not `console.error`. As written the row's command pipes stdout only, grep
  reads an empty stream and `awk` prints NOTHING — it cannot have produced 852. Corrected, and
  re-run on `61b00d12`:
  ```
  $ node packages/core/src/cli.ts compile graphs/eto.json 2>&1 | /usr/bin/grep -a '   fix:' | awk '{print length($0)}'
  852        # 844 of `fix:` text plus the 8-character "   fix: " prefix; 846 characters, 852 bytes
  ```
  **The PIPE is byte-identical to before, and that is the one claim the closure rests on.** The
  width source is `process.stderr.columns`, read only when `process.stderr.isTTY === true`, clamped
  to `[60, 120]`; a TTY with no `columns` does NOT wrap (conservative, and pinned). **`COLUMNS` is
  deliberately not read** — honouring it would make the bytes a diagnostic writes depend on the
  invoking shell's environment even in a pipe, which is the grep cost this row named, reintroduced
  through a side door. Continuation indents are 2 for the `message` line and 8 for the `fix:` line,
  2 < 3 so a wrapped message is never mistaken for the `fix:` below it. `wrapDiagnostic` is pure,
  breaks at whitespace only (the longest token in the clause is 21 characters, so no token is split
  at any width ≥ 60), treats a `"…"` or `` `…` `` span as one token, and preserves every gap it does
  not break at — the first cut joined with one space and turned `bad  name.json` into
  `bad name.json`, which is a path that does not exist.
  **THE PIPE CLAIM IS PINNED BY A SPAWNED CLI, not by an in-process stub, and that distinction was a
  blocking review finding.** The in-process capture set `isTTY` to the literal `false`; a real pipe
  has **no own `isTTY` property at all**, so the pipe arm was testing a state that never occurs and
  two mutations (always wrap; wrap at 80 when `isTTY === undefined`) were GREEN across the whole
  suite. `diagnostic-wrap.test.ts` now drives `execFile` on the real binary — the `fix:` line is one
  line of exactly 852 bytes and the clause matches exactly one line, `grep -c` == 1. Both mutations
  are RED.
  **TWO RESIDUES, both recorded rather than closed.** (1) `loom compile 2>&1 | less` is a PIPE and
  gets the 852-byte line unwrapped, while a pty-allocating CI runner is a TTY and gets a wrap; no
  rule distinguishes `less` from `grep` at the file descriptor, and wrapping always would pay this
  row's named cost for every piped consumer to buy the `less` case. (2) The TTY path strips
  `SPOOFING_BUT_WHITESPACE` (the class `legible()` already used, spelled ONCE and read by both)
  because `loadGraph` interpolates a FILE NAME here unquoted and a `\r`, an ESC or a U+202E each
  forges or hides a diagnostic — **so on a terminal the rendered file name is NOT the file name**
  (`a<CR>b.json` renders `a b.json`), which is the same defect whitespace-collapsing caused, paid
  deliberately because any faithful rendering of a CR on a terminal IS the attack. The PIPE is
  unchanged and the test asserts that residue, so nobody reads the TTY arm as having closed it.
  **`loom replay`'s `✗` frame writer is deliberately NOT routed through this printer**, with the
  reason at the site: over `ReplayFrame`'s ten kinds its payloads are values an operator DIFFS — a
  graph id or a `ref=digest` drift list, an effect key, `taskId hash`, a task state name, sorted
  `state:decision` pairs, `failed:CODE` — plus exactly ONE JSON document and ONE prose sentence.
  Re-flowing a digest list at spaces makes the one thing the line exists for harder.
  **The clause was NOT shortened**, per the row's instruction: it is 852 bytes on `eto` still, and
  byte-identical to `docs/handoff-2026-09-15b.md`'s quotation. §A.73's new arms made the OTHER arms
  longer — 889 bytes for the unwired offer (852 at base) and 292 for `GRAPH008_JOIN_DEPTH` (191 at
  base) — and `describeValue` has no cap, so three distinct 400-character edge kinds give a
  **1,512-byte** line and each `GRAPH003_UNKNOWN_EDGE_KIND` above it 601. All measured on
  `61b00d12`; the dedupe bounds the COUNT of distinct renderings, not the length.

- **H.15 · There is no stranger-facing install: `@loom/core` is unpublished, and `npm publish` exits
  0 doing nothing.** *(Opened 2026-09-22b by the settlement's assessment. The goal's FIRST VERB is
  "install it", and it is the one step only the maintainer can take.)* Repro on `29c8b9ec`:
  ```
  $ cd "$(mktemp -d)" && npx --yes @loom/core --version
  npm error code E404
  npm error 404 Not Found - GET https://registry.npmjs.org/@loom%2fcore - Not found
  ```
  ```
  $ cd <repo>/packages/core && npm publish --dry-run >/tmp/pub.txt 2>&1; echo "exit=$?"; tail -1 /tmp/pub.txt
  exit=0
  npm warn publish Skipping workspace @loom/core, marked as private
  ```
  **`README.md`:69–72 already states the second half and nothing in the tree acts on it** — *"`@loom/core`
  is `private: true`, and `npm publish` does not REFUSE — it exits 0 and quietly does nothing, which
  a CI step checking only the exit code would report as a successful release."* Line 55 states the
  first: *"`loom` is not published; the binary IS the install."* So today a stranger must clone this
  repository and run `npm install && npm run build:binary`, and `npm pack packages/core` plus a tgz
  install is the documented substitute (README:71–72). **This is housekeeping only in that nothing
  is broken**; what it blocks is the bar `CLAUDE.md` sets.
  **Closes with `DESIGN.md` Sequence item 29** — when a stranger who has not cloned this repository
  can install and run `loom`. **It is NOT closed by making `npm publish` refuse**: that is a guard
  over a silence which stops mattering the moment the package is publishable. Item 29 states the
  same closing condition in the same words, so the two cannot drift apart.
  **What it reopens by its own text**, named here so nobody rediscovers it: **§H.1**, which says
  verbatim *"Reopens on more than one operator, or a published binary"* — and it is the only row in
  this file naming a published artifact as a reopening condition. §D's single-operator framing is
  NOT disturbed by publishing as such: of what rests on that framing, the permanent admission
  refusal rests on the run RATE (§Z, and `DESIGN.md`'s "Deliberately not sequenced") and §E.1 on
  team size, and a registry entry moves neither. §H.0 does not rest on it at all — it is a
  delegation-gate decision the maintainer already took.
  **2026-09-23 — everything short of the publish landed, and the row stays OPEN.** The maintainer
  decided the name (`@caohaotiantian/loom` — the `@loom` scope belongs to someone else, so the
  `npx @loom/core` repro above can never pass) and that nothing goes outward from a lane. What
  exists now: `node scripts/pack.mjs --out DIR` packs `caohaotiantian-loom-0.1.0.tgz` from a fresh
  compile, and `node scripts/smoke-install.mjs <tgz|binary>` installs it outside the repository and
  runs README's first two examples through it (CI's `install` job, Linux and macOS); a real
  `loom --version`; and an installed `loom` that refuses below Node 24 in one sentence, exit 2.
  **`private: true` STAYS, so the silence above still holds** — `npm publish` in `packages/core`
  still exits 0 and publishes nothing — and it still matters until the maintainer removes that
  line and publishes, because until then a CI step checking only the exit code would report a
  release that did not happen. **Closes on a publish receipt from a machine with no clone**:
  ```
  docker run --rm node:24-slim sh -c 'npm i -g @caohaotiantian/loom@0.1.0 && loom --version'
  ```
  printing `loom 0.1.0`. Publish the packed TARBALL, never the directory — the procedure, and what
  `npm publish` in `packages/core` does instead, is in `DESIGN.md` item 29.

- **H.16 · The OTLP instrumentation scope still says `@loom/core/telemetry`.** *(Opened 2026-09-23
  by the item-29 lane, which renamed the package everywhere prose names it and deliberately left
  this.)* `telemetry/otlp.ts`'s `SCOPE_NAME` is written into every `ExportTraceServiceRequest` as
  `scopeSpans[].scope.name`, which is what a collector groups spans by — so renaming it is a WIRE
  change to a value an operator's dashboards may already filter on, not a doc edit. Repro:
  `/usr/bin/grep -an 'SCOPE_NAME = ' packages/core/src/telemetry/otlp.ts` →
  `const SCOPE_NAME = "@loom/core/telemetry";`. **Closes when** somebody decides whether it becomes
  `@caohaotiantian/loom/telemetry` (most naturally at the first publish, before anyone outside has
  a dashboard on it) or stays as an opaque name. The `Symbol.for("@loom/core:…")` keys are NOT this
  row: they never leave the process and must only agree with each other.

- **H.17 · The tarball carries what `pack.mjs` says it does not: map pointers with no maps, and
  sources git does not track.** *(Opened 2026-09-23 by the settlement, from the item-29 lane's open
  list.)* `scripts/pack.mjs`'s header says the tarball is *"a function of `src`"* and that no source
  map ships because maps *"point at a `src/` the tarball does not carry"* — true of the `.map`
  FILES, not of the pointers. Measured on `48de87f6`, `node scripts/pack.mjs --out <dir>` then
  `tar -xzf` and a walk of `package/`: **141 files, 0 `.map`, 138 still ending in
  `//# sourceMappingURL=…`**, so a stranger's `node --enable-source-maps` or bundler looks for maps
  that are not there. And "a function of `src`" means the DIRECTORY, not the tree:
  `echo 'export const untrackedProbe = 1;' > packages/core/src/zz-untracked-probe.ts`, pack, and
  `tar -tzf` lists `package/dist/zz-untracked-probe.js` and `.d.ts` — an untracked file in the
  maintainer's checkout rides into the publish. **Closes when** the packed `.js`/`.d.ts` carry no
  `sourceMappingURL` (or the maps and sources ship), and `pack.mjs` refuses a `dist` file whose
  source `git ls-files` does not list — both asserted against the tarball, the way step 4 already
  checks `files`.

- **H.18 · The shipped `.d.ts` need `@types/node`, and nothing says so.** *(Opened 2026-09-23 by the
  settlement, from the item-29 lane's open list.)* A TypeScript consumer of the packed tarball with
  `"types": []` and `skipLibCheck` off gets **2** errors, both in shipped declarations:
  `dist/mcp/client.d.ts` `TS2591: Cannot find name 'Buffer'` and `dist/sandbox/subprocess.d.ts`
  `TS2503: Cannot find namespace 'NodeJS'` (measured on `48de87f6`: the tarball copied into a scratch
  project's `node_modules/@caohaotiantian/loom`, `import * as loom from "@caohaotiantian/loom"`,
  this repo's `tsc -p .` under `module: nodenext`). The count depends on the consumer: with
  `target: es2022` a third appears, `dist/bus.d.ts` `TS2304: Cannot find name 'Disposable'`. The package has no dependencies by rule, so the
  answer is not a `dependency` on `@types/node`. **Closes when** either the two declarations stop
  naming Node's ambient types, or `packages/core/README.md` states the requirement — a decision
  about which, and neither is behaviour.

- **H.19 · Two CLI doors answer 0 to a flag they never read.** *(Opened 2026-09-23 by the
  settlement, from the item-29 lane's open list — the class §H.4 closed per verb, one door over.)* On the
  packed `dist/bin.js` at `48de87f6`: `loom --port 1` (a flag, no verb) prints the usage and exits
  **0**, where `loom --bogus` exits 1 — the item-29 lane refused an UNKNOWN flag with no verb and
  left a KNOWN one accepted and ignored; and `loom --version --tokne x` prints `loom 0.1.0` and
  exits **0**, the misspelt `--token` never reaching a refusal. **Closes when** both exit non-zero
  naming the flag, pinned beside `test/cli/version.test.ts` and `test/cli/flag-door.test.ts`.

- ~~**H.20 · `npm test` leaves 22 `loom-*` directories in `$TMPDIR` on every run.**~~ **CLOSED
  2026-09-23 at `39c5e0b5`.** *(Opened 2026-09-23 by the settlement. The item-29 lane reported the
  `loom-dist-*` quarter of it; the settlement's reviewer found the rest.)* Measured on this
  settlement's HEAD by running `npm test` with `TMPDIR` pointed at an empty directory. Afterwards
  the directory held, by prefix:
  - `readme-gaps.test.ts`: 4 `loom-dist-*`, from its four `distIsBehindSources` tests, pre-existing
    since `81b42586` (2026-08-28); 11 `loom-freshness-*` and 1 `loom-freshness-moved-*`.
  - `binary-freshness-absent-or-unreadable.test.ts`: 5 `loom-fresh-edge-*`.
  - `cli/promote-live-gates.test.ts`: 1 `loom-gated-template-*`.

  Each was a `mkdtempSync(join(tmpdir(), …))` with no removal; the last was a corpus TEMPLATE built
  once and copied per test, whose per-test copy WAS disposed but whose own root never was. The
  machine that settled this wave had **388** `loom-dist-*` alone.
  ```
  $ T=$(mktemp -d) && TMPDIR=$T npm test; ls $T | sed -E 's/-[^-]*$//' | sort | uniq -c    # before
     4 loom-dist
     5 loom-fresh-edge
    11 loom-freshness
     1 loom-freshness-moved
     1 loom-gated-template
     1 node-compile-cache                                    # Node's own, not this row's
  $ T=$(mktemp -d) && TMPDIR=$T npm test; ls $T | sed -E 's/-[^-]*$//' | sort | uniq -c    # after
     1 node-compile-cache                                    # zero loom-* entries
  ```
  Each of the three files now tracks the roots it mints and removes them all in a module-level
  `after`, so a directory a test never got to inspect is still gone at suite end — including on a
  failing run, which the `after` does not condition on. Closed at the array, not at each call site:
  a shared `tempRoots`/`after` pair per file, following the try/finally-per-`mkdtempSync` idiom
  already used elsewhere in `test/journal/store.test.ts`, rather than one `t.after` per test.

---

## Z · Closed 2026-08-25 → 2026-09-22b — do not re-fix these

The register: what closed, and the commit carrying the argument. `git show <sha>` is the citation.
An em dash means the row records no sha; the closure's evidence is the test or mechanism its row
names. Ids below the rule are lanes and decisions that closed with no row of their own.

| id | sha | what closed |
|---|---|---|
| A0.1 | `74b62d9` | canonical string arm, raw length |
| A0.2 | `60ff53d` | `flushHeaders()` after `writeHead` |
| A0.3 | `8c734ce`, `60ff53d` | child gate reachable without `--graph` |
| A0.4 | `49624c0` | truncated tool turn floored |
| A0.5 | `3cfd363` | reserved `Object.prototype` channel names |
| A0.6 | `60ff53d` | console fold shares terminal set |
| A0.7 | `60ff53d` | arming scan inside `listen()` |
| A0.8 | `6b3513b` | `e.kind satisfies never` exhaustiveness |
| A0.9 | `702f785` | `filePayloads` docstring corrected |
| A0.10 | `61e8185` | `GLOB_SCAN_BATCH` docstring counted |
| A0.11 | `49624c0` | `wireCount` shared, not barrelled |
| A0.14 | `3656d69` | unpriced route fails closed |
| A0.15 | `49624c0` | Anthropic input usage MAX |
| A0.16 | `02a5e84` | three control-flow injection paths |
| A0.17 | `86193e3` | plane refuses undeclared input |
| A0.18 | `4bc3ce1` | DOM mock clears children |
| A0.19 | `878001c` | reserved `Object.prototype` node ids |
| A0.20 | `6b3513b` | child gate forwards to mirror |
| A0.21 | `ff8fdac` | `TAKEABLE_EDGE_KINDS` shared predicate |
| A0.12 | `b4a7835` | compile memoised per file |
| A0.23 | `05b495b` | seventh cross-run touch wrapped |
| A0.24 | `5f59559` | idempotency entry deleted on any throw |
| A0.25 | `0270d84` | E_CHILD_UNREACHABLE splits the code |
| A0.26 | `c8aad7d` | census reads merges; trailers unified |
| A0.27 | `eee63b9` | overlap refused, fields frozen once |
| A.1 | `a8d62fb` | quote effect makes refusals replayable |
| A.2 | `34a7f14` | replay grades the terminal message |
| A.3 | — | the no-`provider` window named |
| A.4 | — | realm brand carried onto wrappers |
| A.5 | — | two false totals became properties |
| A.8 | `552d999` | `nodeApproved: trigger === "rewind"` |
| A.13 | `96a03bf` | CLI waits on journal predicate |
| A.14 | `6d830d7`, `eba2a63` | run inputs externalised, folded back |
| A.15 | `3762a0e` | keyset cursor replaces scan ceiling |
| A.16 | — | process-local producer sweep named |
| A.17 | — | restart lease wait measured, accepted |
| A.18 | `b2f4002` | taint keyed on the choice |
| A.20 | — | SIGINT window closed by `awaitStoppable` |
| A.22 | `fabc360` | `authoredGraphHash` fixes cohort note |
| A.23 | `276e05c` | `11-budget-exercised` refuses moved ceilings |
| A.27 | `50f7c03`, `160985c` | upper median gates pair cost |
| A.28 | `a0f0cec` | `outcomeSpread` refuses saturated rank |
| A.33 | — | `clearCeiling` deleted, ceiling durable |
| A.34 | — | rewind requires a human |
| A.35 | `52da0e8` | rewind plan previews what dispatches |
| A.36 | `d9a8173` | nine run-id captures now decoded |
| A.38 | `ba5f8c4` | pin confirmed; it predated the row |
| A.39 | `ba5f8c4` | one `stripControlChars`, two callers |
| A.40 | `77c245a`, `468984b`, `f94d812`, `bf59862`, `4e297f4`, `ac693d0` | `GRAPH010` exempts a provably branch-local channel — W1-W6, four review rounds and a refutation |
| A.41 | `175cdb3` | gate hint on stderr, so stdout is JSON on the gate path |
| A.42 | `f7f74d5` | `{refuse}` → `validation`/`E_FUNCTION_REFUSED`, never retried |
| A.43 | `da86076` | `loom gates` shows the reads, swept by declared classification |
| A.44 | `c2360be`, `b181b55` | `ctx.node` — a body reads its own declared shape |
| A.45 | `7ba3b99`, `25cd252`, `88b3bad` | nine projection state sites, nine console arms |
| B.1 | `7952c6a` | `strandedLeaseMs` reclaims all eight node types |
| B.2 | `a5937fe`, `c816826`, `fa25cc7` | `task.skipped` wired; `channel.written` and `task.started` deleted |
| C.4 | `96a03bf` | OTLP encoder, endpoint and push |
| C.5 | `aaa4a9a` | three-arm effect span partition |
| D.1 | — | per-server `irreversibility` allowed |
| D.2 | `aaa4a9a` | no ninth span name |
| D.4 | `50f7c03` | median gates, undefined pair unbounded |
| D.6 | `86193e3` | wire refuses on `spec.inputs` |
| D.14 | `d57c984` | retention tiering deleted — a run's journal is the corpus |
| G.2 | `18bd9f4` | `Date` bound to `ctx.now` in the function realm |
| H.1 | — | `verify-binary.mjs` drives the artifact |
| H.2 | `814e283` | fourteen broken citations repaired |
| H.3 | `e8c2fb5` | four count-claims name their members |
| H.4 | `96a03bf` | verb→flag applicability table |
| H.5 | `2b6bc06` | `driveToRest` splits the graph's half from the deployment's |
| H.6 | `52d4b43` | help text derived from the registrar object |
| A.46 | `74c930c` | a rewind's suppression reaches the live console, by resync |
| A.47 | `84338b3`, `52d6c99`, `3d8dabb`, `5464801`, `cc964f7` | an ordinary edge into a join node is the barrier's entrance, not a second mint |
| A.49 | `d9dc26c`, `cbfdeb5` | `GRAPH003_UNRETRYABLE_ONLY_IF`, from a table of OBSERVED raise classes |
| A.50 | `a58550d`, `ab18b14`, `4864df9` | a fan-out width that is not a positive integer is refused, and so is a hostile one |
| A.51 | `5d2053b`, `ccf2a32`, `b96d887` | `loom gates` resolves handles and caps each value, saying so in place |
| A.52 | `cabd61e` | `STATE_RANK` ranks all nine, and the browser copy is pinned to it |
| A.53 | `d7e8ee5`, `cbfdeb5`, `2d40f5e`, `ebd8446`, `51f4a5f` | GRAPH021 states the whole fan-out branch rule in one diagnostic — **F1, the last of the port's eight** |
| A.54 | `a31279b` | stdout drains before `process.exit`, so a pipe keeps everything |
| H.7 | `52d6c99` | two stranded paragraphs moved to their declarations |
| H.8 | `ac6a293` | one channel-redaction rule, `security/redact-channels.ts`, for both doors |
| H.9 | `e345951` | the Gates floor's claims string unpinned from its digits |
| A.56 | `d770a07f` | a held join's `fix:` names the `branches` entry AND the `kind: join` edge, and says which join — the INNERMOST fan-out's barrier |
| A.57 | `d770a07f` | GRAPH021 names which of the nodes it counts are not in the list it dictates |
| A.58 | `f8bacd2d`, `fb59d63d`, `bb0e203e` | `readsTruncated` on the gate ROW, `--max-bytes` in decimal digits, per-value cap kept by decision, and `readsMayBeStale` for a branch-held read — the VALUE half split out as §A.60 |
| A.59 | `0dd0a524` | `#assertBound` re-checks a fan-out width's READABILITY at the executor's door, and deliberately not the compiler's ceiling |
| A.61 | `48f80947`, `a0dca498`, `c7fd74f0` | the gate ROW names the payload handles this door read back and the ones it could not — `readsResolved` and `readsUnresolved`, both lists, because one cannot tell "read them all" from "had none" |
| A.63 | `562bd7c5`, `ee316e88`, `b9bdb5f4` | a refusal at the advance door FAILS the run, through one code-keyed wrapper covering both vocabulary checks — and only when the graph is provably the run's own (hash AND manifest) |
| A.64 | `5c0f3214`, `76b57e08`, `472f521b` | one arm, one join: a node with `fanoutDepth >= 1` may be named in `branches` by at most one join, keyed on the node id. The row's own repro compiles and SHOULD |
| A.55 | `3a27a98d`, `6b7ed2c7`, `ee316e88` | **both halves**: the barrier releases once no arrival can come, and a barrier not one of whose MEMBER TASKS succeeded fails `E_QUORUM_UNREACHABLE` instead of folding nothing |
| D.9 | `6b7ed2c7`, `ee316e88`, `b9bdb5f4` | ANSWERED (a) — **by the wave orchestrator following the row's own recommendation, not by the maintainer**. Residual: §A.67 |
| H.10 | `e7498c3f`, `b96e9c3c` | the flag suite and `serve-host.test.ts` write nothing into the repo; `npm test` leaves no `x/` and no `.loom/`. Product half → §H.11 |
| A.21 | `25b906ee` | the `suite freeze` unresolved-gate exclusion is KEPT and settled BY CONSTRUCTION — unreachable through the Engine, reachable through a journal, frozen as a 30-run fixture that yields 29 cases |
| A.65 | `3dcaf728`, `e491162b`, `1f8adaf6` | GRAPH021 stops dictating a member another join already claims, by `rule008`'s own test — following the line prints no diagnostic the first compile did not. Residue → §A.69 |
| A.67 | `4700a03d`, `d222e146`, `bfc45730`, `c9f8b1ec`, `bbe05c3e`, `0081c058` | a join asks its WORK members whether anything succeeded, needs quiescence before saying no, and reads a router as evidence — and NO `JoinSpec` field. Residues → §A.70, §A.72 |
| H.11 | `57dcbcfa`, `cbc67bae` | the verb is decided before the workspace opens, all fifteen global flags refuse with nothing on disk, and an unknown verb no longer imports `--extension-module`. Residue → §H.12, §H.13 |
| A.37 | `25ed5978`, `62335f93`, `c6f24b51`, `d6b23979`, `dee1bb7e`, `300bf222` | `retryable` is written where `run/compensation.ts` promised it was, a rewind refuses an effect whose undo ARGUMENTS were never recorded, and the approval-floor split keys on a module-private `WeakSet` — a tool cannot award itself `retryable`. Three divergences from the design are in the row. Residue → §A.74 |
| A.69 | `a27b8f33`, `4cef9f25`, `473202af` | GRAPH021's `fix:` names the join that already claims the fan-out's target, so the collision is disclosed by the FIRST compile; acceptance unmoved and the `JOIN_DEPTH` that follows deliberately not suppressed. Option (a) refused on measurement. Residue → §A.73 |
| H.12 | `db49005d`, `3b527003`, `ee93918f`, `aadc4b68` | one `FLAGS` table whose value is the flag's argv-only READER, `KNOWN_FLAGS` derived from its keys, `VERB_POSITIONALS` read by the door and by `requirePositional` — the arity is stated nowhere and cannot drift. Open set THREE. Residue → §H.14 |
| H.13 | `db49005d`, `3b527003`, `ee93918f`, `aadc4b68` | a missing positional on all 17 verbs that take one answers `E_CONFIG_INVALID` with the same sentence, and `E_INTERNAL` is reserved for a bug in Loom again |
| A.73 | `9e1c1f12`, `6165e6a2`, `b58bdb81`, `c749dbe5`, `418ae207` | the sibling `fix:` lines predict the COMPILER and no longer each other: GRAPH021's clause offers `GRAPH008_BRANCH_NOT_CONNECTED`'s own edge by name where no edge is wired, `rule008` names the kind that IS there, and an echoed `edge.kind` is RENDERED rather than injected (a forged `ok` line and a forged `fix:` line were reachable through `GRAPH003_UNKNOWN_EDGE_KIND`, which is not fatal). Ten arms enumerated by construction, byte-pinned, and asserted distinct. `GRAPH008_BRANCH_NOT_CONNECTED` left alone by measurement. Notes kept under the row: the three cycling shapes, and a duplicated `branches` entry nothing refuses |
| A.74 | `da4156fa`, `8d7d013e`, `eb1d6d05`, `be578544` | the preview refuses everything the act refuses — both post-plan arms in one `#refusePlannedRewind`, called by `planRewind` and by `#rewindSerially` ABOVE the `planHash` check, so the operator gets the journal fact and not a complaint about a plan nobody can be shown. Pinned at the HTTP plane too: `GET /runs/:id/rewind-plan` answers 409 with a 200 control one tool-field away |
| H.14 | `ff925a28`, `b3d059f4`, `e719b85b`, `396d961a`, `a42d1fc7`, `d2b63498`, `ea929446`, `e991cb13`, `2a8990aa` | a diagnostic wraps for a TERMINAL at `stderr.columns` clamped `[60,120]` and never for a pipe, which stays byte-identical — pinned by a SPAWNED CLI, because a real pipe has no own `isTTY` and the in-process stub that set it `false` could not fail. `COLUMNS` deliberately unread. Residues recorded: `2>&1 \| less`, and control-character stripping on the TTY path only. The row's own repro was missing `2>&1` and named the wrong writer; corrected in the row |
| A.68 | `89e1927b`, `16d36c2d`, `eea73afe`, `583d6840` | by the DESCRIPTION arm, behaviour byte-identical: the example states the veto and its boundary (before the second approval it fails the run; after it, the write has already landed). `onBranchError: "skip"` was MEASURED and refused although it passes the row's literal condition — under it 2 rejections + 1 approval land the write, which is fail-open, and loosening is never allowed. Residue → §A.75 |
| A.62 | `5f4fd61a`, `c9685caa`, `44221801`, `19b183c4`, `cdf8d60a`, `e890cc41`, `7d23ec2b` | `EDGE_FIELDS` carries a TYPE per field plus `readBy`, and `checkStructure`'s edge loop checks it once, generically, on EVERY edge kind — a wrong-typed field is a property of a value and not of the rule that will read it. `rule006Cycles`' and `rule007Fanout`'s hand-written type halves deleted; `edgeFieldRefusal` is the single producer of the width refusal; the parse decides the TYPE and the rules keep the RANGE, so `maxWidth: 0` keeps its code, message and `expansion.maxFanout` ceiling. Six fields deferred BY NAME to a refusal proven total (`TYPE_CHECKED_ELSEWHERE`), pinned. Side effect: 60 census rows that made `compile()` THROW `CanonicalizationError` now return a diagnostic. **Closed at TWO** — `readableFanoutWidth` stays hand-written in `engine.ts` because `attach()` is public and the executor must not depend on having been the compiler's caller. Byte-identity holds on single-fault graphs only; LEDGER WATCH: `graph/spec.ts` is kernel and gained enforcement under `fix:` |
| A.75 | `a8aa5584`, `ff72ffae`, `5ddaf71e`, `c966fad9`, `7c39d99a`, `85675acc`, `08d32804`, `5f2f104d`, `e9e50d29` | `k` is a FLOOR the fold enforces whatever `onBranchError` says. `#joinArrivals` is ONE helper that `#maybeFireJoin` and `#foldJoin` both call, so the fold asks the mode's own question on the numbers the fire decision was taken on by construction; a third `#foldJoin` arm sits LAST so every existing refusal keeps its message byte for byte. The unit is `contributed`, not arrivals — a branch `skip` absorbed after an earlier member wrote still counts, because that is what `skip` is for — and an empty fan is exempt by §A.47. All three NOT-wanted lines of §A.68's `skip` matrix move; neither wanted line does. Residue → §A.77 |
| A.76 | `a8aa5584`, `ff72ffae`, `5ddaf71e`, `e9e50d29` | `planRewind` releases every context its plan INSTALLED, children and grandchildren — the verb's own already-written rule applied to the half it was not applied to — with `#runs.delete` rather than `#retire`, so the preview's REBUILT graph is not recorded as the graph a child retired with. `#forgotten` membership is carried and restored, and `#contextFor` clears it ABOVE its early return so an `attach` landing mid-preview is not re-forgotten. The OBSERVABLE the row demanded exists: previewed child, re-attached with a good graph, rewound, undo dispatches. `attach` was NOT made honest — replacing a live context's graph moves the oversight floor under a running wave — so that arm is on the owed list |
| A.78 | `931f844f`, `34410c2c`, `78e64ce3`, `297d12e0` | `lex` type-tests its source (`E_EXPR_INVALID` → `GRAPH004_EXPR`) AND asserts progress (`i <= lastStart`), in `lex` rather than `checkExpr` because `parseExpr` is the executor's own entrance. The first cut's `i === lastStart` was a STALL test: a reviewer's backwards branch OOMed the compiler again with the guard in place, and the lane's own regex pin would have forbidden the fix — pin the property, never the operator. Both mutation pins run in a CHILD process at 200 MB, because an in-process one took the runner's whole heap and charged seven tests as one unnamed failure. Deliberate tightening: a `String` OBJECT is refused now, unreachable from JSON |
| A.79 | `7dd6029c`, `79cab047` | every required sub-block `rule016Subgraphs` READS is asked about before it is read — `inputs`, `outputs`, the `subgraph` block, child `channels`, child spec shape — each `GRAPH003_MALFORMED` and naming the node, with child faults re-tagged `in subgraph "…":` three levels deep. `<block>: null` crashed all EIGHT node types at base. First cut's blocking: a child `channels: []` compiled CLEAN where base refused `GRAPH016` — a guard that made an already-refused graph quieter |
| A.80 | `5a0d1637`, `0431ddcb` | `EDGE_KINDS` and the kind check relocated from `compile.ts` into `checkStructure` beside `GRAPH020`, so they reach a child at any depth; the negative pin flipped positive. Message TEXT byte-identical, POSITION not — and the refusal is lost behind an earlier fatal, both disclosed at the site. `renderKind` made total (`KIND_STILL_THROWS` now empty of values); a throwing ACCESSOR still throws at the property read, base extent. Third round: `typeof` before `Object.hasOwn`, because `[Symbol()]` throws at the membership test |
| A.81 | `d1b452fe`, `83aa54bf` (a) · `648cc9c6`, `78e64ce3` (b) | **both halves, so the row closes whole.** (a) `POLICY_FIELDS`/`NESTED_FIELDS` carry a type, one `blockFieldTypes` pass at 15 sites, 21 fields newly refusing a wrong type and no in-tree graph tightened; `BlockFieldType` stays MODULE-PRIVATE after `check-surface` refused the export. (b) `readableLoopBound` and a THIRD `#assertBound` check under `E_GRAPH_INVALID`; `"6"` and a restart refused too. First cut's blocking: two enumerations — a docstring and a FAULTS census — still said TWO checks. Residue → §A.85, and the drift note on §A.62 |
| A.84 | `731eca44`, `79cab047`, `0431ddcb` | the compiler reads a graph that HAS a back-edge: `flowEdges`, `flowAncestors` (Tarjan) through `canPrecede` for GRAPH005/GRAPH002, and **DOMINANCE** (`GraphIndex.dominators`, Cooper–Harvey–Kennedy over a virtual root) for GRAPH010; `entryNodes`' loop exception made conditional; `terminalNodes`, `ancestors`, `dagEdges` and `wouldCycle` untouched, so §A.73's coupling survives by construction. `harden-config.json` goes from 3 warnings to ZERO, the only change across the seven shipped graphs. First cut's blocking: a `flowOrder` DFS cut MANUFACTURED pass-2 orderings, so GRAPH010 went silent on a real race and its answer depended on declaration order (527/8,000 seeds) — **and its docstring was the defect**. Final review: dominance oracle 0 mismatches over 435,916 pairs, 0/8,000 permutation flips, no base-ok graph refused. Residue → §A.86, §A.89 |
| — | — | — |
| §A.55, first half | `3a27a98d` | `any` and `firstSuccess` release once no further arrival is possible, instead of waiting for one that cannot come. Kept as its own line because the row closed in TWO waves and the shas differ; the second half is the `A.55` row above |
| `engine-cross-run` | `5fe7614` | five cross-run touches answer closed |
| `mcp-seal` | `9cf88b5` | prefix reservation at every registration |
| `mcp-registrar` | `010510e` | three registrars refuse name collisions |
| `engine-child-journal` | `0de48c4` | mirror answer wrapped per mirror |
| `usage-floor` | `dcf54c9` | dollar residual narrowed 80× → 10× |
| `exam-reads` | `3b983f7`, `8c86559` | exam must read the answer |
| `seam-ledger` | `706b88a` | census counts non-`feat` trailers |
| A.7, A.9 | `f5a047e`, `02d3db0`, `ff4888d` | four node types get default deadlines |
| span attributes | `deafe43` | three journaled fields reach spans |
| compensation | `7c8b89c`, `160985c` | one `run.failed` site, children reached |
| unlabelled ⇒ untrusted | `5bff93b` | integrity axis defaults to untrusted |
| subgraph prompt binding | `0f605a9` | manifest walks frozen child specs |
| retry multiplication | `683d928` | transport retry folded into engine |
| malformed `effects` | `7e889a1` | purity label refused at compile |
| answered by DELETION | `21be5ce` `aaa8e3b` `d57c984` `583ecd9` `d078368` `065a9e1` | `JoinNode.timeoutMs`, `FunctionNode.cpuBound`, `journal/retention.ts`, `ApprovalSpec.mode`/`.k`, two `effect.started.kind` members, `TenantId`/`Budget.tenantUsd` |
| D.4's `kill` verb, and `run.cancelled.forced` with it | `e50a2e7` | the field is gone and `run.cancelled` carries `clean` and `unknownEffects` only. Its docstring said "decided for deletion" while §D assigned it to a `kill` verb, and those could not both be acted on; `test/run/cancel-does-not-wait.test.ts` then measured that `cancel` does NOT wait, so `kill` as specified is a second name for `cancel` and the field was being held for nothing. That test and `run/engine.ts`'s steer docstring cite this row. |
| answered by REFUSAL | `378e965` `e42c572` | circuit breaker (no fold spans runs), `preAuthorization`, admission control (a ceiling shipped instead) |
| operator levers | `cc64481` | `deescalate`, in-flight and budget caps |
| `--extension-module` | `cc320d1` | fork list moved the right way |
| `port-workflow` | `f24bcb7`, `77da881`, `422a730` | `triage-failures` — one real chore ported with no fork, and the eight-entry friction log it produced |
| `port-workflow-2` | `f43d5a0f` (lane `99be52f6`..`f43d5a0f`) | `harden-config` — a SECOND real workflow ported end to end against the shipped binary with no fork, no `--extension-module` and zero changes under `packages/core/src`: a bounded convergence loop (`loop` + `until` + `maxIterations`, a complementary `conditional` exit, `append_ordered` accumulating across ITERATIONS beside a `replace` projection, `len()` in a stop rule, 8 nodes, 4 function bodies, 11 manifests). `docs/workflow-port-2026-09-22.md` is the commands a stranger runs; **F1–F13 are the product friction and THREE of them are one mechanism** (§A.84), F12 → §A.83, F13 → §A.82. **F14 is the port's own eight defects over four reviews, none found by its author** — every one of them the report asserting something the run had not established, which is the defect class the workflow exists to prevent. Suite `test/examples-harden.test.ts`, 23 tests |
| `port-workflow-3` | `9ee826a5` (lane `7c203c5d`..`9ee826a5`, merged `86a35a0a`) | `grant-access` — a THIRD real workflow ported end to end against the shipped binary with no fork, no `--extension-module` and zero changes under `packages/core/src`: temporary access to a production resource, ROUTED BY CEREMONY. 13 nodes over four node types (6 `tool`, 5 `function`, 1 `router`, 1 `human_gate`), 14 edges over three kinds (10 `seq`, 3 `conditional`, 1 **`error`**), `merge_object` beside `replace`, 5 `function` bodies, 13 request fixtures. **Four mechanisms no other shipped graph holds**: a `router` with two cases and a `fallbackEdge`, a `kind: "error"` edge, a reducer that is neither `replace` nor `append_ordered`, and a node reached by two mutually exclusive paths that runs exactly once. It overlaps port 1 in `human_gate`/`function`/`tool`/`fs.*`/`seq`/`replace` and port 2 in `conditional` besides. `docs/workflow-port-2026-09-22b.md` is the commands a stranger runs; **SEVEN product friction entries, NONE closed** — F5 → §A.90 (silent data loss, the priority row), F2 → §A.91, F3 → §A.92, F7 → §A.93, F1 → §A.94, F4 a docs gap that `examples/README.md` §10 now fills, F6 the port-2 F9 canonical-form mechanism in a new manifestation (recorded in the log, no row, because port 2's F9 has none either). **§4 is NINE defects in the port's own workflow, and its own table attributes them to the author's mutation sweep (one) and TWO review rounds (six then two), SIX of the nine blocking** — counted from the table here rather than carried, because §5's prose says round one found seven where the table lists six, a disagreement left standing in that doc rather than edited there. A third re-drive then found a TENTH the table does not hold: a sentence in round two's own correction that the table four lines below it contradicted. The shape differs from port 2's F14: five are *a guard nothing distinguishes* (two renewal guards were deletable with the suite green, found by MUTATION and not by reading), and every round's own correction carried a defect of the class it was correcting. First shown by an example here: a failed run's landed `fs.write` is rolled back by `fs.restore` with NO compensation edge, journal-driven. Suite `test/examples-grant.test.ts`, 26 tests |
| `examples-consume` | `b181b55`, `0b3719a`, `f71cd1a`, `aaf4b65`, `76216df` | the ported workflow CONSUMES four of the things this wave built, rather than only no longer suffering them; `docs/workflow-port-2026-09-09.md` §0 is the "Closed since" head |

**The defect class that accounted for nearly every real finding, stated once because it will
recur:** *a guard answering its undecidable case with the passing value.* Members: `gateCandidate`
certifying a candidate it never ran; 0% vs 0% satisfying "non-inferior"; an empty suite reported
valid; an audit rule firing on healthy journals the product itself writes; a cost ratio over a zero
baseline reported as "1.00x"; a deferral budget bounding everything except the last deferral; `loom
score` reporting outcome 0 for a run whose graph it could not find; and a ratio-of-timings gate that
passed hardest when its baseline was worst.
