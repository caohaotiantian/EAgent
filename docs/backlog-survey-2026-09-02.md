# Backlog survey — 2026-09-02, every open row run rather than read

**46 rows audited at `9f81f77`, one verdict each, by seven agents working in parallel
and each required to paste a command it had actually run.** This is the companion to
`backlog-close-2026-09-02.md`: that file recorded what a working session closed, this one records
what is left and — for the first time — **which of it has a command that fails today**.

The four verdicts, and what each one commits to:

| verdict | count | what it means |
|---|---|---|
| **BUILDABLE** | **14** | a command FAILS at `9f81f77` and the fix is tractable now. The command is pasted. |
| OPEN-HARD | 13 | real, not stale, blocked on a NAMED thing — a journal event, a kernel schema change, a maintainer's decision |
| REFUSED | 16 | real, and should not be built. A measurement says so, not an opinion |
| STALE | 3 | the row's own claim is FALSE at `9f81f77`. These are corrections, and they are the ones worth reading first |

**The bar for BUILDABLE was set deliberately high, and the reason is a mistake made earlier the
same day.** A refusal from a flag that does not exist is not "a command that fails" — that
transcript is manufacturable for every unbuilt thing in the corpus, so admitting it would turn
`DESIGN.md`'s live-list rule into a counterexample generator. Every BUILDABLE row below names a
behaviour that is wrong or missing through the shipped binary or the library surface.

**What this changes about `DESIGN.md`.** That file's Sequence section said the live list was empty
because "no pass has produced an ITEM", and that was true of every pass that had looked. This one
produced 14. The list is repopulated there, ordered by the project's own rule —
silent-and-wrong outranks loud-and-missing.

---

## The 3 corrections, first

A row whose claim is false is worse than no row: it sends somebody to fix something that is not
broken, and it makes every other row less believable.

### A.15 — The row is closed at HEAD and its struck-through claim no longer reproduces: the ceiling, the truncation flag and the window are gone, the cursor exists with conformance behind it, and the non-terminating-store refusal …

`node --test packages/core/test/deployment/run-clock-window.test.ts` → 6 pass, 0 fail, including "THE RUNS THAT USED TO BE PAST THE CEILING ARE REACHED", "THE TRAVERSAL COSTS ONE LISTING PER PAGE, and does not re-walk" and "A STORE WHOSE CURSOR DOES NOT ADVANCE IS REFUSED — the walk must not be unbounded". The symbol is gone, not renamed: `/usr/bin/grep -rn 'export const RUN_CLOCK_SCAN_CEILING' packages/core/src` → 0 (the two surviving hits, journal/store.ts:112 and cli.ts:4123, are prose in docstrings about the deletion). The cursor is on the interface — `readonly after?: RunId;` at journal/store.ts:141 — with conformance cases over both backends parameterised in test/journal/conformance.ts ("after is EXCLUSIVE, and two pages abut exactly"; a cursor the filter does not admit → E_RUN_NOT_FOUND); `node --test packages/core/test/journal/store.test.ts` → 76 pass, 0 fail. The row's survivin…

### A.19 — The one runnable claim in the row is false at HEAD — there are TWO private array guards, not three — and the headline "~25 files" names no predicate, so it cannot be falsified or re-derived as written; the row's own "dr…

`/usr/bin/grep -arn "isList\b" packages/core/src` and `"isArrayValue\b"`: exactly two definitions exist — telemetry/spans.ts:1355 `function isList` and run/delivery.ts:3601 `function isArrayValue`. security/redact.ts defines neither (`grep -arn "isList|isArrayValue|isArrayLike" packages/core/src/security/redact.ts` → no output); its four `Array.isArray` sites are 439, 556 (inside a try), 1161 (a comment) and 1292. resources/realm.ts uses one `try` around the whole rebuild, not a predicate. So realm.ts:968's own sentence — "`redact.ts`, `run/delivery.ts` and `telemetry/spans.ts` each carry a private `isList`" — is stale in the same way the TODO row is, and is where the row's number came from.\nRe-derivation attempt for the count: `/usr/bin/grep -arl "Array\.isArray" packages/core/src | wc -l` → 31 files (250 occurrences, cli.ts 23 / http.ts 17 / validate.ts 16 / spans.ts 16 …). 31 is eve…

### E.5 — The reducer set is still a compiler refusal, but two of the row's own statements are false at HEAD — README names THREE fork-required things, not five, and the determinism boundary the deferral was written against now e…

Count falsified by reading the file the row cites: `README.md:225` — "**Twelve things need no fork. Three do**" and `:229` — "is now **three**". §E says "five" TWICE (preamble: "among the five things that need a fork"; the E.5 body: "one of the five things README says still needs a fork"), while §E's OWN closing paragraph says "**It went five → three on 2026-09-01**" — the section contradicts itself. All three refusals re-driven through the binary at HEAD (`node packages/core/src/cli.ts compile <mutated examples/graphs/fan-out-join.json>`): `GRAPH003_UNKNOWN_REDUCER: channel "counts" declares reduce "my_custom_reducer" … fix: use one of replace, append_ordered, merge_object, sum, max, min, union_set, last_write_wins_by_ts`; `GRAPH020_UNKNOWN_TYPE … fix: use one of function, agent, tool, router, join, evaluator, human_gate, subgraph`; `GRAPH003_UNKNOWN_HOOK_POINT: \`hooks.preFold\` names…

---

## BUILDABLE — 14 rows, each with the command that fails

Effort is the surveyor's estimate. "kernel" means the fix touches one of the ten files in
`scripts/kernel.json`; under a `feat` that costs a `Kernel-seam:` trailer, and a `fix` may touch
them freely — which is what a kernel is for.

| row | effort | kernel | what is wrong |
|---|---|---|---|
| **A.2** | medium | yes | `compare()` in run/replay.ts grades status, gates, channels and the error CODE, and nothing about the refusal's own record — so a faithfully recorded refusal replays with a different error … |
| **A.13** | small | no | `loom run` counts its own laps instead of the run's progress, so it abandons a run that is still journaling steady progress well inside the retry bound its own graph declared. |
| **A.18** | medium | yes | Control-flow taint is not tracked: a router that reads an injected channel can steer an irreversible action that reads only clean channels, and under a human ceiling of `on` that action run… |
| **A.23** | medium | no | The measurement the row asks for now exists and says the quote-effect catch is NOT enough — a ceiling lowered 15× replays clean with zero reasons — and the row's stated blocker (the spec is… |
| **A.29** | medium | no | A frozen golden case pins the whole work channel verbatim, so a candidate whose every run the graph's own deterministic verifier certifies as `pass` is refused by `1-must-pass` and reported… |
| **A.30** | small | yes | The named residue of `#compensateOne` is live and worse than the row states: an `effect.completed` that exists with no `details` dispatches the undo with `args = {}` and journals `outcome: … |
| **A.36** | small | no | A subgraph's child run is listed by `GET /runs` and is 404 on every by-id route, because the run-id captures never go through `safeDecode` and a child id always contains a `#`. |
| **B.1** | medium | no | LeasedScheduler has zero constructors in src/, so a task whose holder died stays `leased` forever — and the seam that would reclaim it already returns the right answer on the same folded pr… |
| **B.2** | medium | yes | Five declared event types still have no appender, and two of them are demonstrable defects today: an outstanding reservation is invisible to the fold that `GET /runs/:id` serves, and `task.… |
| **D.1** | medium | no | `readMcpServers` silently drops every key it does not know, so an operator's per-server `irreversibility` — and a typo'd `envAllow` — vanish without a word; the unknown-key refusal half nee… |
| **G.5** | medium | yes | Prompt text is bound by the manifest, not the hash — closed, except residue (a): after a MUTATION the successor carries no recorded manifest, so a gate decision on it never checks the resou… |
| **H.1** | small | no | The row understates itself: `bin/loom` at HEAD is 48 source files stale AND predates the freshness guard entirely, so it answers `--help` with exit 0 — the exact 2026-08-28 failure the guar… |
| **H.3** | small | no | Real at HEAD, and the row undercounts its own survivor set: TWO clauses in graph/compile.ts still say three where the code tests four, not the one the row names. |
| **H.4** | medium | no | Reproduced verbatim at HEAD: `loom trace` accepts `--port`, `--token` and `--suite` and silently ignores all three, while `--otlp` is the single verb-scoped exception; a verb→flag applicabi… |

And the reproductions, which are the part that matters:

**A.2** — `node --test /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/4861154c-1775-40c7-96f9-14469f7859a1/scratchpad/a2-fail.test.ts → ✖ A.2 · a refusal whose error record varies by path must not replay green\n AssertionError: the …`

**A.13** — `node --test /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/4861154c-1775-40c7-96f9-14469f7859a1/scratchpad/a13-fail.test.ts → ✖ A.13 · a run inside its declared maxAttempts must not be abandoned after 64 waits\n Assertion…`

**A.18** — `node --test /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/4861154c-1775-40c7-96f9-14469f7859a1/scratchpad/a18-assert.test.ts → ✖ 1 fail: AssertionError: the branch was chosen by injected content, so the irreversible char…`

**A.23** — `node --test /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/4861154c-1775-40c7-96f9-14469f7859a1/scratchpad/a23-assert.test.ts → ✖ 1 fail: AssertionError: the lowered ceiling was never exercised, so the certificate is unea…`

**A.29** — `node --test /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/4861154c-1775-40c7-96f9-14469f7859a1/scratchpad/a29.test.ts`

**A.30** — `node --test /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/4861154c-1775-40c7-96f9-14469f7859a1/scratchpad/a30b.test.ts`

**A.36** — `node --test /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/4861154c-1775-40c7-96f9-14469f7859a1/scratchpad/a36.test.ts`

**B.1** — `node --test /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/4861154c-1775-40c7-96f9-14469f7859a1/scratchpad/b1-strand.test.ts`

**B.2** — `node --test --test-timeout=10000 /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/4861154c-1775-40c7-96f9-14469f7859a1/scratchpad/b2-reserve.test.ts`

**D.1** — `node /Users/deepsky/Documents/projects/EAgent/packages/core/src/cli.ts run --mcp-file mcp-typo.json --graph nope.json # mcp-typo.json = {"servers":[{"name":"docs","command":"npx","args":["-y","@scope/server"],"envallow":["PATH","HOME"],"ir…`

**G.5** — `node --test /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/4861154c-1775-40c7-96f9-14469f7859a1/scratchpad/g5.test.ts → ✖ THE SAME, AS THE ASSERTION THAT SHOULD HOLD — a moved resource must be refused on EITHER graph / As…`

**H.1** — `./bin/loom --help # exit 0, prints usage, while 48 .ts files under packages/core/src are newer than the binary`

**H.3** — `/usr/bin/grep -anE 'THREE|three' packages/core/src/graph/compile.ts # returns line 150 'ONE NUMBER FOR ALL THREE TYPES' and line 165 'only these three can:' — both above/beside four bullets and a four-arm function`

**H.4** — `node /Users/deepsky/Documents/projects/EAgent/packages/core/src/cli.ts trace 01M1G8G8TF3SD8Q8K2MQBZJ93J --extension-module ./ext.mjs --port 9999 --token sekret --suite x # succeeds, printing the full trace; --port, --token and --suite are …`

---

## OPEN-HARD — 13 rows, each with its blocker named

These are not "hard" as a shrug. Each names the specific thing that has to exist first, and most
of them name the same two: a durable fact the journal has no vocabulary for, or a decision only
the maintainer can make.

| row | blocker |
|---|---|
| **A.10** | No process-boundary execution host for CODE RESOURCES exists. packages/core/src/sandbox/subprocess.ts confines child processes for tools and its header states the scope explicitly — "this confines *processes*. It does not sandbox arbitrary… |
| **A.11** | There is no durable fact that separates "the request reached the source" from "it may have". `#unfinishedToolEffect` reads `effect.started` minus `effect.completed`, and both are appended around a call whose outcome the host cannot observe… |
| **A.24** | No journal event carries the graph spec, and both routes the row names require editing `packages/core/src/journal/events.ts` — a kernel file, so a `feat` costs a `Kernel-seam:` trailer (the 11th declared seam). The maintainer decision that… |
| **A.25** | §D.5, unanswered: whether the kernel needs a graph-scoped durable fact, and whether that is one new event type (`packages/core/src/journal/events.ts`) or a second keyspace (`packages/core/src/journal/store.ts`, whose whole interface is run… |
| **A.26** | A maintainer decision the code cannot make for itself: whether repeats go on the CANDIDATE arm only or on both arms. Candidate-only repeats measure within-candidate variance while the baseline arm stays a single historical journaled score … |
| **A.32** | A maintainer decision that the graph entry IS a node — which the row itself names as the closing condition and gates on 'a second shape needing it', a bar the repo does not yet clear (3 no-op sources, all in one bench workflow and its two … |
| **C.1** | Each remaining name needs a new event or field in packages/core/src/journal/events.ts (kernel): `durationMs` on `run.compiled`; a `schedule.picked` carrying queue.depth/concurrency.used/concurrency.limit; a context-assembly event (run/cont… |
| **C.3** | Two things that do not exist and neither is telemetry. (1) A tick loop in packages/core/src/run/scheduler.ts — that file is pure selection, and building one is downstream of B.1's plug-it-in-or-delete decision, since a tick over `InProcess… |
| **D.3** | A maintainer's decision, plus a schema change to a closed set. The node-type union is closed at eight and refuses everything else: `node .../cli.ts compile graphs/cleanup.json` on a node with `"type":"cleanup"` prints `✗ GRAPH020_UNKNOWN_T… |
| **D.5** | A maintainer's kernel decision: one new event type in packages/core/src/journal/events.ts, or a second keyspace in packages/core/src/journal/store.ts. Both are pinned in scripts/kernel.json, so either is a `feat` costing a Kernel-seam: tra… |
| **G.1** | `evaluator` has no field to declare `effects` in. Opening it is a schema change to `packages/core/src/graph/spec.ts` (`EvaluatorNode.effects` + `ALLOWED_FIELDS.evaluator`) plus wiring in `packages/core/src/run/engine.ts` (`#effectsFor` key… |
| **G.3** | Two things at once. (a) That loop is only reachable through `LeasedScheduler`, which its own docstring says is "not wired into the v1 executor" — so there is no failing command through the shipped binary. (b) Giving it "its own terminal st… |
| **G.4** | There is no confidentiality analogue of `effects: []` — no way for a channel to declare "carries no secret" — so the integrity fix's shape does not transfer, and the obvious symmetric fix (treat every unclassified channel as sensitive) is … |

---

## REFUSED — 16 rows, with the measurement that refused them

**These are deliverables, not omissions.** §E's eight are deferred by design and were audited only
for whether their stated REASON has stopped being true; the rest were attempted and refused.

| row | why not |
|---|---|
| **A.6** | Member 2 reproduces exactly as written — a class instance with a two-faced `then` getter crosses the realm boundary and its continuation outruns the deadline — but the only local fix is one line whose whole measured cost is a test written … |
| **A.12** | A rate-limit deferral does bump E4's streak and does escalate at three — reproduced end to end — and the change the row warns against would delete a posture the journal currently raises. |
| **A.21** | The fixture cannot be built: for a run eligible for `suite freeze`, `gateShapeOf`'s unresolved set is empty by two independent constructions, so the exclusion is dead code and the row's other branch ("delete it and say why") is the only on… |
| **A.31** | An adapter yielding a `UsageRecord` with an absent `costUsd` really does escape `#commit` as a raw `CanonicalizationError`; the decision to build nothing holds because the row's reopening condition is measurably not met. |
| **C.2** | Three of the eleven span attributes are set, eight are not in the journal at all, and the row's own conclusion — that emitting them would be worse than their absence — is the measurement that refuses it. |
| **E.1** | Distributed deployment stays deferred; the measurable half (LeasedScheduler built and uncalled) is §B.1's, and both of §E's greps for it reproduce exactly. |
| **E.2** | Partition assignment still needs a coordinator, and the journal still has nowhere to hold a cross-run fact — the source says so in the file the row cites. |
| **E.3** | The sample argument survives and is enforced; the machinery the row defers (automated candidate generation, canaries, auto-promotion) still does not exist at HEAD. |
| **E.4** | Additive-only holds at HEAD: removal is unrepresentable in `GraphMutation`, and base node specs come through a mutation deepEqual-identical. |
| **E.6** | The row's own reading holds: there is still no inter-agent chatter anywhere at HEAD, so "replay quadratic" still names nothing checkable. |
| **E.7** | seccomp/Landlock are still Linux-only, this tree is still darwin, and the boot banner still names the guard among the ones that are off — reproduced verbatim. |
| **E.8** | Both facts the row states still reproduce — Slack's signing scheme is built and tested, and no vendor payload SHAPE parser and no email transport ship — but the missing half is now reachable from argv without a fork, which the row predates. |
| **G.2** | `Date` stays absent from the resource realm; restoring it means binding the constructor to `ctx.now`, and `Temporal` rides along when it becomes a default global. |
| **G.6** | Proposed-API mechanism and a runtime version pin (D5): a declaration file, an opt-in, a publish-time refusal, and a version-pinned default recorded as a journal event — all unbuilt. |
| **G.7** | One retry budget per run: the engine × transport multiplication is gone, and the run-scoped budget was deliberately not built. |
| **H.0** | A delegating chain raising one gate per level reproduces at HEAD, and the consistency argument the maintainer decided on is measurable rather than a matter of taste — a flat graph already floors every node that reaches the tool at `in`. |

---

## How to re-run this

Every verdict above came from a command. The survey itself is reproducible in shape but not in
detail — seven agents each chose their own probes — so what is durable here is the VERDICT plus
the command beside it, and a reader who doubts a cell should run that command rather than argue
with the table. A row whose command has stopped failing is a row to close; a row whose command
still fails is work.

**The counts in the table at the top are not carried anywhere else.** `TODO.md` keeps the row
census (rows present, struck, still open) and `DESIGN.md` keeps the live list; a third copy of
either number here would be the second copy that rots, which is this project's most-repeated
finding about its own documents.
