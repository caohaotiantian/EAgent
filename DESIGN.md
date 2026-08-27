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
surface, and the tool-extensibility path is a typed API the model writes code against rather than
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

The structural finding of the audit: **every surviving defect class is restart, scale, or a
second machine**, and the project has no instrument that reaches any of them. 2,288 tests run
offline, in-process, in ten seconds, with no restart and no second host — excellent inside that
boundary and blind outside it. Four confirmed defects live there: the gate clock arming an
unfiltered run set, the 200-run window starving the oldest run, the loopback bind, and the
budget refunded across a restart because `foldRun` never folds `model.called`.

One scenario reaches all four at once.

*Fails today:* a script that starts `serve` over a journal holding more than 200 runs and one
open gate, restarts the process, and answers that gate from a second host.

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
"frozen" from D6's: the eval set stays frozen before the candidate exists, unchanged.) **Metric before corpus, as a hard ordering
inside this item:** the score currently prefers failure 0.400 to 0.100 because `readSignals`
never reads `runStatus`, and `trajectory.usage` triple-counts spend. Every trajectory captured
under an inverted metric is a poisoned label, so accumulating a corpus first is harmful rather
than merely premature — which corrects `TODO.md` §E's stated deferral reason, whose whole
premise was a correct scorer and a short sample.

Then: a journal event that can carry a score, a verb that reads one, and one cohort where a
later run is measurably better because of an earlier one.

**MECHANISM DONE 2026-08-26; THE DEMONSTRATION IS BLOCKED, and by something worth knowing.**
Built and driven on a real corpus: five live GLM-5.2 runs of one graph over five different diffs
($0.044, 510 s), each scored through `loom score`, each verdict journalled as `evolution.scored`
(event row 53, with an audit rule that refuses a score claiming a completion the journal denies),
each read back through `loom cohort`. Every run scored 0.6 with `delivered: true`.

**What it cannot yet do, measured rather than assumed.** All five landed in DIFFERENT cohorts of
one, because `cohortKeyOf` includes an input bucket that defaults to a digest of the whole input.
`isGolden` needs thirty. So promotion is unreachable for any workflow whose inputs vary — which is
every real workflow. The `bucketInput` seam exists for exactly this and has no caller. See
`TODO.md` §A0. **This is the item's remaining work, and it is one seam, not a redesign.**

*Fails today:* thirty runs of one workflow sharing a cohort key, and a candidate promoted over
them because it measurably beat the baseline.

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

Unchanged in intent. One thing the audit sharpened: the closure is real and undocumented. A
non-committer can add graphs, prompts, profiles, subgraphs, sandboxed functions, sandboxed
hooks, MCP tools and OpenAI-wire providers without forking; an in-process tool, a new wire
protocol, a delivery channel, a node type, a reducer or a ninth hook point all require a fork.
That is a defensible trade — replay depends on closed vocabularies — but it is stated as a bound
only in `TODO.md`, and "unlimited extensibility" appears unqualified above.

*Fails today:* an example hook file and an example function body in the tree, with the required
shape named in `--help` and in the loader's error text rather than in one source comment.
**Ordering note:** the tree's only `examples/` directory is `packages/eagent/examples/`, which
item 6 deletes. Either this item lands first, or item 6 carries the examples across.

### Deliberately not sequenced

**Distribution** — LICENSE, publishing, a stranger-facing install. It follows from the first-user
decision: the next user is the maintainer porting a workflow, not a stranger who found the repo.
`TODO.md` §A0 records the missing LICENSE as a defect; THIS paragraph is where the choice to
leave it unsequenced is recorded. Revisit when item 4 lands.

Open items and known defects live in `TODO.md`.
