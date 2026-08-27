# Design

**One document.** Written 2026-08-25 after a survey of what the field settled during 2025–26.
Everything here is a decision with an alternative it was chosen over. When one turns out wrong,
change it here and say why in the commit — do not start a second document.

---

## The thesis, corrected

The old thesis was *"the executable graph is the runtime"*. **That is table stakes and should not
be the pitch.** LangGraph, Temporal's workflow/activity split and Obelisk's WIT components all get
there. Worse, the graph lost as an *authoring surface*: LangChain 1.0 deprecated
`AgentExecutor` and hand-built `StateGraph` entry points in favour of a one-line `createAgent`
with a middleware array, and OpenAI's visual Agent Builder went from launch to announced shutdown
in about eight months.

The real differentiator is **how determinism is enforced**. Obelisk enforces it structurally by
compiling workflows to WASM components with no IO capability — and then you must author WASM.
Temporal and Restate enforce it by convention plus a replay checker. The third position, and ours:

> **Enforce determinism by controlling the realm, so the workflow language stays ordinary
> TypeScript.** A PRNG seeded from a journaled draw. A clock bound to a journaled boundary. Every
> effect keyed and declared. No undeclared capability reachable from a node body.

Say it early and out loud, because a reader who knows Obelisk will otherwise ask why not WASM.

## What the field settled — adopt without re-arguing

- **Conversational multi-agent is dead.** Microsoft put AutoGen into maintenance and merged it
  into Agent Framework; the thing that survived is the typed graph, and free-form agent chatter
  survived nowhere.
- **Parallel writers do not work.** Cognition's follow-up names the three topologies that do:
  single-writer plus a **clean-context reviewer** (deliberately *not* sharing the writer's
  context), asymmetric escalation to a stronger model, and manager/child coordination.
- **Multi-agent's measured win is bought context, not specialization.** Anthropic's research
  system beat single-agent by 90% at ~15× the tokens — and in the same work token count alone
  explains ~80% of performance variance. So: cheap mechanically-parallel nodes with independent
  context windows, not role-play crews.
- **Interrupt/resume as a value** is universal (`interrupt()`, `suspend()`, awakeables). We have
  it; keep it.
- **Replay systems fail by STALLING, not crashing.** Temporal's nondeterminism error retries the
  workflow task forever without entering a failed state, so a run can be dead for hours unnoticed.
- **Unlabelled data must default to untrusted.** Microsoft shipped information-flow control
  (FIDES) in Agent Framework 1.3: two axes, integrity × confidentiality, combined
  most-restrictive, with unlabelled tool output defaulting to UNTRUSTED so a forgotten annotation
  fails closed.
- **Node type stripping is Stable** and the escape hatch is gone. It cannot do JSX. That is
  settled and shapes the UI answer.

## Decisions

### D1 · The default surface is one line; the graph is the escape hatch

*Alternatives:* (a) graph-only, today's shape; (b) one-line agent only; (c) both, with the
one-liner compiling to a graph.

**Choice: (c).** `agent({ model, tools, prompt })` returns something runnable that *is* a
one-node graph. Everything the graph runtime gives — journal, replay, gates, budgets — applies
unchanged, and a user who never learns the graph still gets them. Reaching for the graph is how
you add fan-out, joins and human gates, not how you start.

*Why not (a):* every competitor's default is one line, and a runtime whose hello-world is a graph
literal loses on the first five minutes regardless of what it is better at afterwards.

### D2 · Effects are DECLARED, not called

*Alternatives:* (a) a `ctx.step(fn)` durable-step primitive, which every competitor exposes;
(b) nothing, today's shape — a node body cannot journal its own side effect at all; (c) effects
declared in the node's manifest, invoked through a bound handle.

**Choice: (c),** and this is the most consequential decision here.

An anonymous `ctx.step(closure)` is Temporal's Side Effect trap: unretryable, unkinded,
unauditable, and documented as unable to fail or to modify state because it does not re-execute
on replay. (b) is worse — the need is real and today there is nowhere to put it.

So a node type declares what it does:

```ts
effects: {
  charge: { kind: "tool", irreversibility: "irreversible", idempotent: false },
  fetch:  { kind: "tool", irreversibility: "read_only",    idempotent: true  },
}
```

and the runtime hands the body a bound, keyed, retryable invoker per declared name. **Declaring a
capability and declaring a journaled effect become the same act.** That turns "every
nondeterministic call is journaled" from a rule people must remember into a structural property —
which matters because the memory-only-state class has been violated five times, every time by a
field somebody forgot to journal — the five are named in
`packages/core/test/run/oversight-survives-restart.test.ts`. A sixth has not been added, but
member #3 (accumulated spend) has since regressed one layer down: the restore arm works and the
projection it restores from does not fold `model.called`. See `TODO.md` §A0.

### D3 · The clock is bound to the journal, not recorded

*Alternatives:* (a) journal each clock read under an effect key; (b) leave `Date` undefined, as
today; (c) bind the clock to the timestamp of the last journaled task-boundary event.

**Choice: (c),** which dissolves the disagreement rather than splitting it. It is not a recorded
read, so nothing new is journaled and no lie is replayed; and it is not an unjournaled read, so
the hole closes. It needs no seed and no new event kind — the timestamp already exists on an event
we already write. Then `Date` comes *back* into the realm, bound to that clock. Temporal's
TypeScript sandbox does the same thing.

Bind `Temporal` too when it lands as a default global.

### D4 · Information flow — two axes, and NOT scoped to branch coordinates

*Alternatives:* (a) today's single taint bit; (b) adopt FIDES' two axes as-is; (c) FIDES' two
axes with scoping on the graph's branch coordinate.

**Choice: (b). (c) was tried and reverted, and the reason is worth more than the code was.**

Adopt the two axes — integrity × confidentiality, combined most-restrictively — and the
highest-value default in the domain: **unlabelled means untrusted**. Some of this already exists
here in another form: channel `classification` is the confidentiality axis, and the taint set is
the integrity one. What is missing is that they compose, and that an unlabelled value fails
closed rather than open.

**Why (c) is wrong FOR THIS GRAPH MODEL, having built it.** FIDES' own documented limitation is
that most-restrictive propagation is conservative: once untrusted content enters, the whole run
is untrusted, because its only scoping units are the message and the run. A graph looked like it
had a third unit — the branch coordinate — and it does. It just cannot be used, and the
demonstration is the useful part:

- Branch coordinates differ **only** under fan-out. `TaskId` is `nodeId@branchPath#iteration`, so
  loop iterations share a coordinate, and a subgraph child gets its own run and its own set.
- Every arm of a fan-out runs the **same node sequence**, so `isExternal` and the observed
  channels are identical in every arm. Sibling arms therefore taint identically, always.
- The one shape where siblings could diverge — two different writers of one channel on exclusive
  router arms — is refused by the compiler as `GRAPH010_CONCURRENT_WRITE`.

So sibling isolation is unreachable, and a `TaintSet` keyed by coordinate buys precision that
nothing can observe. It was implemented, passed the whole suite, and was reverted: complexity in
a security boundary with no demonstrable gain is a bad trade however elegant the model.

**What would reopen it:** a graph model where sibling branches can run different nodes — which
is what relaxing `GRAPH010` for provably-exclusive router arms would create. If that lands, this
decision is the first thing to revisit, and the `TaintSet` shape is in the history.

### D5 · The extension surface is versioned mechanically

*Alternatives:* (a) semver and discipline; (b) VS Code's proposed-API model; (c) both, plus
version-pinned defaults.

**Choice: (c).** A proposed API lives in its own declaration file, an extension opts in
explicitly, and **an extension using a proposed API cannot be published** — that is what stops an
ecosystem accreting dependence on an unfinished surface, and it is mechanical rather than
cultural. On top, Go's `GODEBUG` idea: when a default changes, a graph that declared an older
runtime version keeps the old behaviour automatically. In a journal-native runtime that pin is an
**event**, not a build flag, which is strictly more precise than anything Go can do.

### D6 · Self-improvement is text-space optimization behind a frozen gate

*Alternatives:* (a) trajectory capture and scoring only, today's shape; (b) automated candidate
generation with a promotion gate; (c) (b) with the eval set frozen before the candidate exists.

**Choice: (c).** Treat the prompt or skill document as the trainable parameter of a frozen model:
rollout batch → reflect → bounded edits under an edit budget → **accept only if strictly better on
a held-out set**. The one mechanical rule that makes this honest is that the suite must predate
the candidate, which turns "is this eval fair?" into a timestamp comparison.

### D7 · A prompt-only change is NOT a safe change

Temporal-ecosystem guidance says prompt edits need no version guard. **Restate is right and
Temporal's guidance does not transfer:** in an agent runtime the prompt *is an input to a recorded
effect*, so editing it silently corrupts a resumed run. Prompt text and tool-description text go
into the artifact hash and into the per-effect fingerprint.

## What we deliberately do not build

- **A visual graph canvas.** The highest-profile one in the industry lasted eight months.
- **Free-form agent-to-agent chat.** It makes termination unprovable, and it is the part of
  AutoGen that died.
- **Parallel writers.** Fan-out for independent reads; one writer.
- **A verifier that pronounces code safe.** eBPF is the best-resourced instance of that idea and
  is still producing soundness CVEs in 2026. A model may *narrow* what policy already permitted;
  it may never widen. Its verdict is a model call, so it gets journaled like any other — which
  makes it reproducible, and no vendor's classifier is today.
- **Keyed log compaction.** It deletes the history replay depends on. Bound the journal with
  payload externalisation above a byte threshold and bounded-iteration rollover instead.

## The three properties, mechanically

**Kernel stability** — the surface is pinned, proposed APIs cannot be depended on, and a default
change keeps old behaviour for graphs that declared an older version.

**Unlimited extensibility** — everything not the kernel is an extension against the same declared
surface. *As shipped that claim covers a named set and not everything:* eight things need no fork
and six do, enumerated with the binary's own refusal text in `README.md`'s "Extending it, and
where that stops". The tool-extensibility path is a typed API the model writes code against rather than
N schemas in the context window. That shape cut one vendor's example workflow from ~150k tokens to
~2k. It has a cost this project must state: if tools are reached through generated code, the
reachable-tool set becomes a static-analysis problem rather than a graph-edge one, so **an agent
node does not get a code-execution tool by default.**

**Endless self-improvement** — trajectories are a read model folded from the journal, not a log.
The agent's working notebook is a *file* it writes, and the write is a journaled effect: the
journal records that the file changed, the file itself is not in the journal. That keeps the
journal bounded and the notebook diffable, which is the shape both Anthropic's long-running-agent
harness and LangChain's Deep Agents converged on independently.

## Sequence

**Rewritten 2026-08-25**, after an audit and a re-check of every backlog item by running it.
The previous list had no done markers at all; the DONE that a measurement falsified was in
`TODO.md` §G, not here. And its item 5 named "labels on branch coordinates" — the option D4's
own heading rejects and which §G records as tried and reverted.

**Every item names a command that FAILS today and passes when the item is done.** An item that
cannot fail is a wish, not a roadmap entry. Evidence for each is in `TODO.md` §A0 and
`docs/audit-2026-08-25.md`; the ones marked `gated` are held by
`docs/audit-2026-08-25.md`, which also records the five gated cases that fired as each was
fixed, and why only executable ones survived.

**Landed.** D1, the one-line surface — the hello-world gets the journal, replay, gates and the
budget ceiling without the caller learning the graph. That one is wholly done.

**Landed in part**, and `TODO.md` §G carries the qualifiers this list must not drop: D2 declared
effects is done for `function` nodes and still open for `evaluator` bodies and for the sandbox;
replay divergence is terminal **for the recorded-effect path** only, which was item 4.

### 1 · Oversight correctness — this gates everything below it

Two defects break the property the product is pitched on and the invariant this document calls
non-negotiable ("refusing is always allowed; loosening never is"). Nothing else is worth
sequencing above them, and neither was in the backlog before today.

A declared posture is discarded when its VALUE is out of vocabulary — `posture: "strict"`
compiles `ok` and runs at `out` — and the unknown-FIELD check does not reach inside `policy` or
`budget`, so `posturr: "out"` also compiles `ok`. An author loses a declared `posture: "in"` by
misspelling either half. Separately, an approval binds the graph and the task but never the
args, so a concurrent write changes what the approved node executes.

*Fails today:* a test asserting `compile` REFUSES `policy: {posture: "strict"}` and
`policy: {posturr: "out"}` — both of which `compile` now refuses.


### 2 · The instrument for everything outside one process

The structural finding of the audit still stands: **every surviving defect class is restart,
scale, or a second machine.** Two of the sentences that followed it did not, and both were
falsified by driving them rather than reading them.

**"The project has no instrument that reaches any of them" was false.** Four already existed
and already ran in the gate: `test/cli/serve-host.test.ts` spawns real `loom serve` children
onto real non-loopback sockets (7 tests, 5.8 s); `test/run/restart-crash.test.ts` forks a child
and SIGKILLs it; `test/journal/store.test.ts` contends two workers on one SQLite file;
`test/deployment/` is an in-process restart-and-scale harness. What was missing was
COMPOSITION and a home — and, in the one place nothing composed, a live defect.

**All four named defects are fixed, and the `Fails today` scenario PASSES.** 220 runs past the
window, one open gate, `serve` booted and SIGINTed and booted again, `GET /gates` and
`POST /runs/:id/gates/:gateId` answered from this machine's non-loopback address, the run
`run.completed` and the tool behind the gate wrote its file — 333 ms end to end. It is
`test/deployment/restart-and-answer.test.ts` now, so it passes on purpose rather than by
nobody having looked.

So the deliverable was never "make the scenario pass". It was to give the gate a lane on this
axis and make the lane earn its place, which it did: **five defects nothing in the in-process suite
could see** — 2,288 tests when this lane started, 2,302 now.

- `HumanGateBroker.resolve` wrote its decision through `RunLog.append`, the door whose
  docstring says it RETRIES, while its three neighbours use `commit`, the door that never does.
  Two planes answering one gate in the same instant both landed.
- Every plane on every machine called itself `worker-0`, so `LeasedScheduler`'s
  "my own lease, take it back" check read a live foreign lease as its own.
- `auditRun` guarded a run's START (`run.submitted-is-first-and-once`) and left its END to
  nobody; it caught one of five contradictions in a two-writer journal and reported `ok`.
- Two of the excuses in `audit-coverage.test.ts` were false claims, not judgement calls.
- The run clock's rotation cursor was `const rot = { offset: 0 }` in a closure — a value a
  decision reads that no journal can reconstruct, so the 200-run starvation was fixed for a
  plane that stays up and unfixed for one that restarts.

The lane is `test/deployment/`: `harness.ts` (which now owns the spawned-plane machinery
`serve-host.test.ts` earned, plus `planes(d, n)` for concurrent writers), `two-planes.test.ts`,
`run-clock-survives-restart.test.ts`, `restart-and-answer.test.ts`, and the three window and
gate-clock files — 15 tests, of which two spawn a real `loom serve`.

*Fails today:* nothing on this axis, and that is the claim to attack next. The two open holes
are named where they live rather than here: `RUN_CLOCK_SCAN_CEILING`'s residual — a run past
10,000 is reached by no lap, and `truncated` is the only reason anyone knows — and the fact
that two planes now AGREE on a window rather than dividing it, which is correct and wasteful.
Both want the cursor `runClockTick`'s docstring names: `listRuns(after)` in `StateStore`, with
a conformance test behind it.


### 3 · Finish realm determinism (D3)

The thesis of this document is determinism by controlling the realm. It holds for `function`
bodies and does not hold at the edges: `ctx.now()` does not reproduce (two replays of one
run return different values, tracking the wall clock — the shadow run appends its own
`task.leased` stamped by the live clock), `loom replay`
builds its engine with no hooks so a hooked run replays a different program, and hook bodies get
the real unseeded `Math.random()` while `hooks.ts:89` claims they get no randomness.

*Fails today:* two replays of one run returning the same `ctx.now()`.

### 4 · Port one real workflow

The maintainer's decision, 2026-08-25, and now the ordering constraint for everything after it.
Nothing has yet used this system for something somebody actually needed; every clause of the bar
is verified by running, which is not the same evidence. This is also what produces the corpus
item 5 requires.

**DONE 2026-08-25.** A review workflow over this repo's own diff — fan-out to one `agent` node
per changed file, `join`, collate, `human_gate`, then an irreversible `fs.write` — run against a
live GLM-5.2. Measured: 3 model calls, 5,718 in / 28,944 out, $0.046, 456 s. The run stopped at
the gate with the file ABSENT, wrote it on approval, and then **replayed with no API key and no
base URL in the environment: `match: true, hermetic: true`, with the deleted output file NOT
re-created.** That is the whole thesis — a run that cost money replays for free, offline, without
a credential, and does not repeat its side effect.

**What it cost to learn what a test could not.** The first attempt produced a report of nothing:
the model spent its entire token budget reasoning and returned empty content under
`finish_reason: "max_tokens"`, and the runtime wrote `""` to the channel and called the run
`succeeded`. Two defects, both in `TODO.md` §A0, neither reachable from any offline test. This is
the item's real return: not that the mechanism works, but that one real workload found in eight
minutes what 2,215 tests could not.

### 5 · Close the self-improvement loop (D6)

Not deferred any longer — closed, per the maintainer's decision. (This is a different sense of
"frozen" from D6's: the eval set stays frozen before the candidate exists, unchanged.) The metric
came before the corpus, as a hard ordering inside this item, because every trajectory captured
under an inverted metric is a poisoned label. Then: a journal event that can carry a score, a verb
that reads one, and one cohort where a later run is measurably better because of an earlier one.

**MECHANISM DONE 2026-08-26.** Five live GLM-5.2 runs of one graph over five different diffs
($0.044, 510 s), each scored through `loom score`, each verdict journalled as `evolution.scored`
(event row 53, with an audit rule that refuses a score claiming a completion the journal denies),
each read back through `loom cohort`.

**THE COHORT HALF IS DONE AND NEEDED NO CODE CHANGE, 2026-08-27.** The paragraph that used to
sit here is struck: it said the input bucket "defaults to a digest of the whole input", that "the
`bucketInput` seam exists for exactly this and has no caller", that "promotion is unreachable for
any workflow whose inputs vary", and that the remaining work was "one seam, not a redesign". Four
claims; the first three were fixed at f0c3c11, forty minutes after the paragraph was written, and
the fourth was wrong about what was left. `trajectory.ts`'s `defaultBucket` is the input's SHAPE;
`loom score --bucket` calls the seam and `test/evolution/cohort-bucket.test.ts` drives all three
modes. Measured through the shipped CLI: thirty runs of one graph over thirty different inputs,
one cohort key, `"cohort": {"n": 30}`, `"golden": true`, `"goldenBlockers": []`, ceiling `stable`.

**What was actually left, and is now built.**

- The promotion bar was a percentile of peers folded with NO GRAPH. `loom score` folded the
  judged run with its authored spec and every peer without one, and `extractSignals` reads node
  types out of the spec — so every peer reported zero assertions and its outcome was 0 by
  construction. Measured: `p90Score 0.4` on a cohort whose members all score 1.0, and a FAILING
  run passing condition 2 by tying a bar its failing peers set. Fixed at `fix(cli)`.
- The gate FAILED OPEN on the candidate D6 aims at. `runEvalSuite` serves every model turn by
  `effectKey(taskId, "model", turn)`, which carries no prompt and no request, so a candidate whose
  only change was `agent.prompt` replayed byte-identically and `gateCandidate` answered
  `promote: true` having made zero model calls — the crippled one came out cheaper at an equal
  pass rate, so the gate preferred degradation. `model.called` now carries a `requestDigest` (the
  `tool.called.argsDigest` precedent), `reboundEffects` compares it, and a case that measured the
  recording instead of the candidate is refused. A recording that predates the field cannot
  certify a DIFFERENT graph at all: a guard that cannot decide fails closed.
- The gate had no door. `gateCandidate` and `runEvalSuite` had zero callers outside
  `src/evolution/` and tests. `loom promote <candidate> --baseline <g> --suite <f>` is that door.
  It MEASURES four of `PromotionInput`'s fields rather than accepting them, and journals the
  decision on the existing `operator.command` row — no kernel edit, no `Kernel-seam:` trailer.
- review-bench's S1 was one bit. One evaluator node demanding a clean sweep of six cases meant a
  review that found five of six planted defects scored what one that found none scored. Six
  evaluator nodes, one per case: S1 is k/6. A graph edit, no core change.

**What is still open, and is not this item's to close.** The suite is hand-authored: `loom suite
freeze --cohort <runId>`, which would select cases from a cohort by the runs' own journaled
verdicts, is the missing half of "promoted over them". A promotion's subject is a GRAPH and
`StateStore` is keyed by runId, so the decision borrows a run's coordinate. And an offline gate
still cannot judge a prompt candidate at all — it can now only REFUSE one, which is the correct
direction and not the same as a gate.

**THE LIVE HALF HAS NOW BEEN RUN, 2026-08-27, and it is half met.** 33 live GLM-5.2 runs of
`review-bench`, $0.78, one cohort key, `members 33 golden 4` read back through `loom cohort`.
The graded S1 works on a live model: `{"id":"S1","value":0.833,"evidence":"5/6 assertions
passed"}`, outcome 0.833, which is the first thing on this corpus ever to clear `MIN_OUTCOME`.
Two defects the script had never revealed because the script had never run: it died on its own
first step (`xargs` assembling a command longer than the platform allows, twice, for two
different reasons), and an absent channel crashed `loom promote` outright once the comparison
became canonical — `canonicalize` refuses `undefined` where `JSON.stringify` returned it.

**What is NOT met, and the reason is worth more than a green would have been.** The promotion
was REFUSED: `✗ 1-must-pass`, with baseline and candidate both at `16.7%` and `Δ 0.0pp`. That
is correct. `review-bench-v2`'s improvement is a parser — `bench-collate`'s greedy
`/\{[\s\S]*\}/` mis-reads a model answer wrapped in a reasoning preamble — and across the
corpus's **192 verdicts, zero were `unparsed`**: GLM-5.2 wrote clean JSON every time, so the
candidate repairs a failure this corpus does not contain. A gate that answered anything but
"no improvement" here would be lying.

Getting to a live promotion means a candidate that beats the baseline on runs that actually
happened — not a smaller exam chosen after seeing the scores, and not a candidate picked to
match the corpus. Both are the exam-written-for-the-student that D6's freeze rule exists to
stop, and this item is the last place that should be quietly conceded.

*Fails today:* a candidate promoted over that cohort **against a live provider** because it
measurably beat the baseline. Offline the whole loop closes —
`node --test packages/core/test/evolution/close-the-loop.test.ts`, 284 ms — and live,
`examples/demo/close-the-loop.sh` now runs end to end and refuses.

### 6 · Cut `packages/eagent` to its tag and delete it

The maintainer's decision, 2026-08-25. It was 43% of the test suite (1,547 of 3587 at the time), imported
nothing into core, and carried a divergent toolchain (Node 22 against 24, TS 5.7 against 5.9).
Its CLI instructs `npm i -g eagent`, which is a real published package owned by an unrelated
maintainer. Deleting it also frees the word **kernel** to mean `packages/core`, which is what
makes item 7 possible at all.

*Fails today:* `npm test` reporting a single package's count, and `git ls-files packages/eagent`
returning nothing.

### 7 · Give "the kernel" a referent, and gate it (P1)

Only possible after 6, because "the kernel" currently names the package being deleted.
`grep -rani kernel packages/core/src/` returns one hit, about the OS kernel. Meanwhile
`engine.ts` went 1,375 to 6,104 lines in 21 days, was touched by 28 of the 69 `feat` commits on
this branch, and has never been reduced by more than 32 lines in a single commit — while the one
running P1 gate measures name-set stability and reported green the day it crossed 6,100.

Pin a file list and fail when a `feat` diff touches it — the surface guard's shape, applied to
what P1 actually names. Note what the audit did NOT establish: whether `engine.ts` is
decomposable. Its header gives three structural arguments for co-location. **Making the boundary
observable is orderable; splitting the engine is not, yet.**

*Fails today:* a guard that fails when a `feat` commit touches a pinned kernel file list.

### 8 · The extension surface and its version pin (D5)

**THE SURFACE HALF IS DONE. THE VERSION PIN IS NOT, AND IS NOT THIS ITEM.** That split was not in
the original text and is the correction; what follows says which half discharged and why the other
one is not orderable yet.

**Discharged.** The required shape of a code body is now stated in `--help` and in the loader's own
refusal, not in one source comment: `compileRealm` appends the rule to both `E_RESOURCE_INVALID`
messages, gated on `(e as Error).name === "SyntaxError"` — measured, `instanceof` is false across
the vm realm boundary for both `module.exports` and `export default`, so the obvious form would
never have fired. The asymmetry the audit did not name is closed too: a malformed FUNCTION body
compiled `ok` with exit 0 and failed mid-run, while an identical malformed HOOK body exited 1;
`requireFunctionBodies` now sits beside `requireHookBodies`. And the closure is written where a
stranger reads it before forking — `README.md`, "Extending it, and where that stops" — with the
qualifier added at "The three properties, mechanically" above and in `CLAUDE.md` §2.

**The closure enumeration in the old text was wrong in one direction, and the correction is
recorded rather than silently applied.** It said an in-process tool requires a fork. That is true
of the CLI and false of a library embedder: `ToolRegistry` is on the pinned public surface
(`scripts/surface.json`), while `openWorkspace` and `compileRealm` are not, and `src/index.ts`
re-exports neither — so the bound differs by which door you came in. "A delivery channel requires
a fork" was also too strong: any HTTP endpoint is a config row, and it is a non-webhook TRANSPORT
that needs a fork. (Writing that down turned up a defect and it was fixed separately: `kind` on a
channel row was read by nothing, so `"carrier-pigeon"` configured a webhook.)

**Not discharged, and deliberately not built here: D5's version pin.** D5 specifies it as a
journal EVENT recording a version-pinned default, plus a refusal for an extension using a proposed
API. Neither is buildable today and the reason is measured, not aesthetic:

- There is nothing to pin. `GRAPH_API_VERSION` accepts exactly one value; `loom.dev/v2` and a
  missing field both fail `GRAPH000_API_VERSION`. No default has changed that an old graph would
  want preserved, so the event would be written by every run and read by nothing — the shape
  `run.cancelled.forced` is already DECIDED FOR DELETION in `journal/events.ts`: written
  once as the literal `false`, read by nothing, named by no document. (Its neighbour `clean`
  is the field that survives, because an operator does ask what it answers.)
- "An extension using a proposed API cannot be published" has no publish boundary to attach to.
  `@stable` here means a file landed in `resources/<kind>/` and `readResources` picked it up at
  boot. There is no registry and no publish step to refuse at.
- It costs two `Kernel-seam:` trailers (`graph/spec.ts` for the field, `journal/events.ts` for the
  event) against a ledger standing at two, to ship a compatibility table with no entries.

**A file-level `// loom:surface <version>` directive was proposed for this item and REJECTED on a
control.** Its justification was that such a directive on a hook body compiles `ok`, disarms the
`no-secrets` hook and writes a credential to disk. Three workspaces, one graph, one input: the
directive over a NO-OP body wrote the credential; NO directive over the same no-op body wrote the
credential; the directive over the REAL shipped body wrote nothing and the run failed. The
directive is inert — the no-op body was the whole effect — so the proposal was a new refusal with
no caller and no defect, which is the pattern this project has already paid for twice (the retry
requeue, `LeasedScheduler`).

*What would reopen the pin:* the first behavioural default this project wants to change without
breaking graphs written against the old one. That is the entry the table would have. Until then a
version pin binds nothing, and the rule it must carry when it arrives is written here now so it is
not decided under pressure: **a pin may preserve a behavioural DEFAULT and never a REFUSAL.** A
safety tightening applies to `loom.dev/v1` graphs too, or "oversight only tightens" stops holding
across versions.

*Fails today:* nothing in the surface half. The examples half was carried across by item 6 —
`examples/` is tracked at the repo root with four graphs and is green under
`packages/core/test/examples-run.test.ts`; the old ordering note pointing at
`packages/eagent/examples/` was stale and is gone.

### Deliberately not sequenced

**Distribution** — LICENSE, publishing, a stranger-facing install. It follows from the first-user
decision: the next user is the maintainer porting a workflow, not a stranger who found the repo.
`TODO.md` §A0 records the missing LICENSE as a defect; THIS paragraph is where the choice to
leave it unsequenced is recorded. Revisit when item 4 lands.

Open items and known defects live in `TODO.md`.
