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
which matters because the memory-only-state class has been violated **six** times, every time by a
value somebody forgot to journal. **The enumeration is SPLIT and this paragraph was the first
casualty of that**: it used to end "a sixth has not been added", and one has — E8 in
`packages/core/test/run/escalation.test.ts:836`, marked `THE SIXTH MEMBER`, where payload
externalisation moved a channel value over 64 KiB out of `task.committed.writes` and
`#restoreEvidence` folded `writes` alone, so a restart rebuilt the taint set WITHOUT the
externalised channel and the charge ran under a human de-escalation with no gate. Five are named
in `packages/core/test/run/oversight-survives-restart.test.ts`; the sixth landed in a different
file, and the pointer here still said five. **A pointer to an enumeration is only as good as that
enumeration's own discipline about growing** — which is why both files are now cited, and why
`CLAUDE.md` and `TODO.md` §F.1 state the split rather than a single address. **The other stale
half of this paragraph is now FIXED and is recorded as such rather than left standing:** it said
member #3 (accumulated spend) had regressed one layer down because the projection the restore arm
reads did not fold `model.called`. It does — `run/projection.ts:1019` — and the fix is in
`TODO.md` §Z's list of defects whose measurement is no longer needed to read the residue.

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

**AS SHIPPED, ONE AXIS OF (b) IS DONE AND THE OTHER IS NOT, and they do not close the same way.**
Integrity landed 2026-09-01 (`5bff93b`): `isExternal` no longer defaults to trusted, and
"unlabelled means untrusted" is now a named set of pure types (`router`, `join`, `human_gate`)
plus two label reads — a `function` is untrusted unless it declares `effects: []`, and an
`evaluator` splits on `kind`; `agent` is unconditionally untrusted. **Confidentiality is still
default-trusted and the symmetric fix does not exist**: `applySecretFlow` reads the declared
classification, and there is no `effects: []` equivalent for a channel, while marking every
unclassified channel sensitive is the constant-gate failure that arm's own docstring refuses. So
the honest statement of this decision today is *one axis fails closed, one fails open*, and
`TODO.md` §G.4 carries the open half.

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
effect*, so editing it silently corrupts a resumed run.

**AS SHIPPED, THE MECHANISM IS NOT THE ONE THIS SECTION ORIGINALLY NAMED, and the difference is
load-bearing rather than pedantic.** This paragraph used to end "prompt text and tool-description
text go into the artifact hash"; they do not, and were never going to. `graphHash` is
`digest(spec)` (`compile.ts:351`) and a ref'd prompt's text is not in the spec. The binding is
`RunGraph.resolutionManifest`, which pins every ref to a CONTENT digest and is journaled on
`run.compiled`; three doors check it (`Engine.#assertBound` on gate decisions and on `advance`,
and `replayRun`'s `refsBound`), and `RunGraph.documents` freezes the bytes by value. Driven by
`test/run/graph-binding.test.ts`, whose "THE SAME SPEC WITH DIFFERENT RESOURCES IS REFUSED" case
asserts `rebound.graphHash === original.graphHash` while the manifest moves and `resolveGate`
throws `E_GRAPH_MISMATCH` — 5/5. That is an in-process rig. It WAS also driven through the
binary once, against a workspace built for the purpose — but that run named
`resources/prompt/writer.md`, which exists in no repo path, so an auditor re-running it found
nothing and was right to. The test is the artifact; a binary-level regression for this is
unwritten, and `examples/graphs/self-review.json` is where one would go, since it carries both
`prompt/review@stable` and a `human_gate`. **The hash is deliberately left out of it**,
because `cohortKeyOf` keys on `graphHash` — putting prompt text in the hash would make every
prompt edit its own cohort of one, and comparing two runs across a prompt edit is precisely the
candidate kind D6 defines self-improvement as producing. So the run is pinned and the cohort is
not, which is the whole design and is the opposite of what one hash would have given.

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
surface. *As shipped that claim covers a named set and not everything:* **ten** things need no fork
and **five** do, enumerated with the binary's own refusal text in `README.md`'s "Extending it, and
where that stops". Those numbers moved on 2026-08-28 and both directions are the point: the fork
list was re-counted at seven (an undercount corrected — a ledger that undercounts turns this
property's alarm into a false all-clear), and `--extension-module` then took it to five. Two of
the five that remain are DEBTS rather than bounds, and Sequence item 12 is what closes them. The
tool-extensibility path is a typed API the model writes code against rather than
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

*The roadmap `CLAUDE.md` points at. It runs across the next three sections: this preamble and the
rule the list is written under, then **The live list** (items 9–13, what to build), then **The
record** (items 1–8, closed) and **Deliberately not sequenced** (what is left out, and why).*

**Rewritten 2026-08-25**, after an audit and a re-check of every backlog item by running it.
The previous list had no done markers at all; the DONE that a measurement falsified was in
`TODO.md` §G, not here. And its item 5 named "labels on branch coordinates" — the option D4's
own heading rejects and which §G records as tried and reverted.

**ITEMS 1–8 ARE DONE, 2026-08-28.** Every one of their `Fails today` commands now passes; verified
by running all eight. **So that list is no longer a roadmap — it is a record of one**, and the rule
it was written under says so plainly: "every item names a command that FAILS today, and an item
that cannot fail is a wish, not a roadmap entry." By that test those eight are now eight wishes,
and the honest thing was to stop calling them a plan rather than to relax the rule. They are kept,
verbatim and still numbered 1–8, below the live list — a Sequence with its outcomes attached is
the only evidence anyone has about what this project's estimates are worth.

**THE RULE HOLDS FOR ITEMS 9–13 TOO, and it is the only thing that makes the list worth reading.**
Every one names a command that FAILS at this commit, each was RUN and its failure pasted in, and
an item whose command passes gets cut rather than reworded. **Applied to the list itself on
2026-09-01: item 11's command now passes, so item 11 is marked DONE and the live list is four —
9, 10, 12, 13, each re-run and each still red.** The status table at the head of the live list
carries the commands and their verdicts. Four candidates were cut that way
while this list was being written: `loom suite freeze --cohort` (already shipped — see item 5),
the trajectory fold's blindness to externalised writes (fixed at `7d627b4`), the D.7.6 provider
refusal that could not re-derive on replay (fixed at `633e265` — for journals carrying the new
`provider` field; one written between `e6d00f2` and that fix still replays the refused answer
onto the channel, and no fix can invent a field those journals do not have), and admission
control's successor, which is not a build at all — see "Deliberately not sequenced".

**THAT BLOCKER IS GONE, 2026-08-28, and the next Sequence is below as items 9–13.** This section
used to say the next list "cannot be written here yet" because it was blocked on thirteen `TODO.md`
§D decisions only the maintainer could make, with `D.2` — the real tenant, concurrency and
run-rate numbers — first. `D.2` was ANSWERED: **one machine, one tenant, the maintainer's own
workflows; tens of runs a day, retention in weeks, one `loom serve`, one operator.** The other
twelve were then decided on merit rather than left waiting, and each carries its argument and its
recorded dissent. Two things about those decisions belong here rather than in the backlog:

- **The answer was a DELETION more often than a build** — `TenantId`, `Budget.tenantUsd`,
  `ApprovalSpec.mode`/`.k`/`.delegation`, `JoinNode.timeoutMs`, `FunctionNode.cpuBound`,
  `journal/retention.ts`, `PolicyEngine.clearCeiling`, two `effect.started.kind` members. A
  vocabulary that declares more than it wires is the shape §B of the backlog had eleven entries
  of, and D.2 is what made most of them decidable.
- **Two were refused permanently, and the refusal is the deliverable.** `D.4` admission control:
  under one tenant the right answer to "too much work" is to make it wait, never to say no, so
  `E_ADMISSION_REJECTED` stays deleted and what shipped instead is a CEILING
  (`--max-runs-in-flight`, default 4). `D.19` the circuit breaker: its verdict is a per-source
  count spanning runs while the journal is addressed per run. `D.10`'s `preAuthorization`
  envelope makes three.

Evidence for each item below is in `TODO.md` §A and
`docs/audit-2026-08-25.md`; the ones marked `gated` are held by
`docs/audit-2026-08-25.md`, which also records the five gated cases that fired as each was
fixed, and why only executable ones survived.

**Landed.** D1, the one-line surface — the hello-world gets the journal, replay, gates and the
budget ceiling without the caller learning the graph. That one is wholly done.

**Landed in part**, and `TODO.md` §G carries the qualifiers this list must not drop: D2 declared
effects is done for `function` nodes and still open for `evaluator` bodies and for the sandbox;
replay divergence is terminal **for the recorded-effect path** only, which was item 4.

---

## The live list — items 9 to 13, written 2026-08-29

**STATUS AT 2026-09-01, arrived at by RUNNING all five commands rather than by reading the diffs
that landed between.** The rule this list is written under — *every item names a command that
fails today; an item that cannot fail is a wish and gets cut* — was applied to itself:

| item | command re-run | verdict |
|---|---|---|
| 9 · a rewind does not run the child's undo | the driver below, rebuilt and re-run | **still fails** — `charges [ 42 ]  refunds []` |
| 10 · three ceilings cannot be re-derived | `node --test packages/core/test/run/replay-fidelity.test.ts` | **still fails** — its `THE HOLE THIS DOES NOT CLOSE` pin is green, which is the item failing |
| 11 · `hermetic`'s third conjunct has no producer | `node --test packages/core/test/run/hermetic-names-the-live-bodies.test.ts` | **PASSES — 13/13. Item 11 is DONE** |
| 12 · the fork ledger's two DEBT rows | `node packages/core/src/cli.ts serve --identity-module ./oidc.mjs` and `--channels-module ./smtp.mjs` | **still fails** — both still `E_CONFIG_INVALID: unknown flag` |
| 13 · a run past the scan ceiling | `node --test packages/core/test/deployment/run-clock-window.test.ts` | **still fails** — 4/4 green *including* the case that pins the two unreachable runs |

**Two of those verdicts are worth stating as a method and not just a result.** Items 10 and 13
"fail" by way of a test that PASSES: each has a pinned residual whose green is the item's red, and
each pin's own body says it must be deleted when the item lands. That is the shape a roadmap item
should have — a claim that cannot quietly become true — and it is why neither could be marked done
by reading a changelog. **Item 11 is the counter-example that proves the list is honest:** it is
the only one whose command flipped, and it flipped because two named lines landed
(`Engine.#functionBody` calling `bodyEntered` at FETCH, and `resources/functions.ts` carrying the
realm brand onto the wrapper), exactly the pair the item said would be needed and neither of which
would have worked alone.

**THE SEAM COST DID NOT MOVE, and the estimate held.** `node scripts/check-kernel.mjs` reports
`10 files pinned, 8 declared seams` (the guard also prints a commit count, which moves with every commit including this one — the SEAM count is the number that must not move) — still **8**. Item 11 predicted it
would cost nothing because it is a `fix` of a guard that already exists, and it cost nothing. The
price of what remains is unchanged at two trailers, for items 10 and 13.

**THE ORDERING ARGUMENT, because "what the three properties need" has to be an argument and not a
preference.** Items 9, 10 and 11 are one defect class wearing three costumes, and it is the class
`TODO.md` names as accounting for nearly every real finding of the last session: **a guard
answering its undecidable case with the passing value.** In each, the runtime reaches a question
it cannot answer from the journal, and answers it `ok` — a rewind permitted on a promise nothing
keeps, a recorded refusal that does not reproduce, a `hermetic: true` over code the runtime cannot
vouch for. All three are SILENT: the operator's evidence says the run is fine. Items 12 and 13
are capability gaps, and both announce themselves — a refusal naming the flag that does not
exist, a `truncated: true` on every tick and a stderr banner at boot. **Silent-and-wrong outranks
loud-and-missing**, and that is the whole ordering.

**WHAT IT COSTS THE KERNEL, stated up front rather than discovered in review.** The seam census
was **8** when this was written and is **8** now — `git log --grep='^Kernel-seam:' --oneline | wc -l`
says 8, and `node scripts/check-kernel.mjs` prints `10 files pinned, a commit count that moves with every commit — the seam count, 8, is the one that must not,
8 declared seams` (it said 164 commits when this paragraph was written; the commit count moves
and the seam count is the number that must not) and then lists every one with its reason.
Items 10 and 13 are each a `feat` that must touch
a pinned kernel file — `journal/events.ts`
for a seventh `effect.started.kind`, `journal/store.ts` for a listing cursor — so each costs one
`Kernel-seam:` trailer and the census would end this list at **10**. Items 9 and 11 are `fix`es of
guards that already exist and do not hold; `fix` may touch the kernel freely, which is what a
kernel is for. Item 12 touches `cli.ts`, which is not kernel. **Two trailers is the price of this
list, it is not hidden in it, and a maintainer who thinks the census has grown fast enough should
cut 13 first** — its argument is the weakest, and §13 says so itself. *Item 11 has since landed
as a `fix` and cost nothing, which is the first evidence this paragraph's method produces a
number that survives contact.*

### 9 · A rewind is permitted BECAUSE a compensation exists, then does not run it

The sharpest of the three, because the refusal that guards it works. `Engine.rewind` descends into
child runs — `rewind-through-subgraph.test.ts` proves it, and refuses `E_RESTORE_ILLEGAL` when a
child made an irreversible call with no undo. Declare a `compensation` on that same call and the
rewind is ALLOWED — that is the second of that file's two tests, and it is correct: the rule is
about compensation, not about subgraphs. `planCompensation` then reads the PARENT's journal only,
finds no `tool.called` there to undo, and the rewind returns having run nothing.

So the permission and the promise are decided by two different pieces of code over two different
journals, and only the permission crosses the boundary. That is a LOOSENING reached through a
declaration — an author makes a rewind legal by naming an undo, and naming it is all that
happens. Driven, one `subgraph` node whose child charges `pay.refundable` (irreversible,
`compensation: {tool: "pay.refund"}`), then `engine.rewind(runId, 1)`:

    charges [ 42 ]  refunds []
    ✖ A REWIND ALLOWED BECAUSE A CHILD DECLARED A COMPENSATION ACTUALLY RUNS IT
      AssertionError: the rewind was permitted because an undo was declared — so run it
      + actual - expected
      + []
      - [ 42 ]

*Fails today:* that assertion — a rewind across a `subgraph` node runs the child's declared undo.

**RE-RUN 2026-09-01 AND IT STILL FAILS, but the cause has moved and the item is now narrower than
what it was written against.** The driver was rebuilt from `rewind-through-subgraph.test.ts`'s own
harness with a refund recorder added, and printed:

    status succeeded charges [ 42 ]
    rewind refused: no
    charges [ 42 ]  refunds []

**What changed underneath it is that both halves now exist and are not connected.**
`#uncompensatedIrreversible` descends into child runs, so the PERMISSION crosses the boundary —
that was already true. `#compensate` descends into child runs since `7c8b89c`, splicing each
child's plan into the parent's reverse walk at the seq of the parent's `subgraph.started`, so the
PROMISE can now be kept. What sits between them is one condition, `engine.ts:2980`:

    if (plan.steps.length > 0 && live !== undefined) {
      await this.#compensate(live, (await this.projection(runId))!, "rewind", atSeq);
    }

`plan` is `planCompensation` over the parent's own events. A parent that delegated has **zero**
steps of its own, so the descent that exists is never entered. **Widening that condition is necessary and NOT sufficient, measured rather than reasoned.** An
auditor applied a superset of the prescribed change — deleting the guard outright — and the
result was unchanged: `charges [ 42 ]  refunds []`. Probes show the descent does now run, so the
condition is correctly identified, and a second blocker sits behind it:

    CPROBE trigger= rewind sinceSeq= 1 depth= 0 plan.steps= 0 children= 1
    CPROBE trigger= rewind sinceSeq= 0 depth= 1 plan.steps= 1 children= 0
    OPROBE step= pay.refundable -> pay.refund outcome= {"outcome":"failed",
      "reason":"\"pay.refund\" did not undo \"pay.refundable\": \"pay.refund\" is
       reversible_write and requires human approval this turn cannot request"}

That refusal is the `nodeApproved: false` seventh argument at `engine.ts:1457` — **§A.8's own
untested guard**, which the same backlog records as load-bearing with nothing discriminating on
it. So closing this item also requires deciding what a compensating undo does when policy answers
`gate` inside a child, and the two items are entangled rather than adjacent. An earlier version of
this paragraph called it "a strictly smaller change than this section originally scoped"; that was
reached by reading the condition rather than by mutating it, and it was wrong.

**Both named siblings have CLOSED, and neither closed the item.** The three `run.failed` append
sites are now **one**: `Engine.#failRun` (`engine.ts:7412`, appending at 7417), which all three
exits of `#finish` call and which compensates first — so the unmaterialised fan-out and
`E_OUTPUT_MISSING` roll back for the same reason a failed task does (`7c8b89c`). And
`#compensateOne` no longer hands the undo `{}` when there is no recorded `effect.completed`; it
returns `not_attempted` with a reason naming the missing record. **One residue of that second
sibling survives and it is smaller than the original:** a record that EXISTS but carries no
`details` still yields `args = {}` at `engine.ts:1450`, because `effect.completed.result` is typed
`unknown`. That is `TODO.md` §A.30's, not this item's.

**Not in scope, and the reason is recorded so it is not re-litigated:** `#edgesToTake` still has
`case "compensation": break;`. A rollback names a CALL and an edge names a NODE; traversing the
edge would run a node, which is a different feature.

### 10 · ~~Three token and cost ceilings cannot be re-derived by a replay~~ — **DONE 2026-09-01**

**CLOSED by the `quote` effect — a seventh member of `effect.started.kind`, written at
`Engine.#quoteEffect` under `effectKey(taskId, "quote", turn)` and served by `ReplayEffects`
like every other recorded effect.** The section below is kept verbatim because its prediction
held in both directions and its numbers are the before column:

    LIVE   E_BUDGET_EXHAUSTED | node "ask" would exceed its 500-token budget
                                (0 spent by this task, 1041 estimated for this turn)
    REPLAY E_BUDGET_EXHAUSTED | node "ask" would exceed its 500-token budget
                                (0 spent by this task, 1041 estimated for this turn)
    MATCH  true

All three members are driven with a control each in `test/run/replay-fidelity.test.ts` — the
control strips the quote rows out of the same recording and shows the old answer coming back.
`THE HOLE THIS DOES NOT CLOSE` was NOT deleted, as its own body suggested: it is now `THE HOLE
THIS CLOSES` and asserts the refusal, which is the assertion this section said would fail.

**The `match: true` half was fixed too, and it had to be**: `compare()` weighed `status` alone,
so a replay that failed for an unrelated reason scored green. It now weighs the error code,
and the frame reads `expected failed:E_BUDGET_EXHAUSTED, got failed:E_REPLAY_DIVERGENCE`. The
MESSAGE is still not graded — that is TODO A.2, and it is untouched.

**What is left, and it is confined to old journals.** A recording written before the `quote`
effect has no row to serve. It falls back to `ceiling ?? 0`, which is a LOWER bound: such a
replay can fail to reproduce a refusal, and can never invent one. Both directions are pinned,
and the residual now announces itself through the error-code frame instead of scoring green.

---


CLAUDE.md's first non-negotiable is that a value a decision reads must be reconstructable by
folding the journal, "including across a restart". These three are not: the node `tokens` ceiling,
the node `costUsd` ceiling, and `ctx.policy.reserve`'s charge against the run's token budget. All
three fail for one reason — the quantity is an ADAPTER's answer (`outputCeilingOf`, `estimateOf`)
and no journal row carries it. `wallMs` is exempt only because it is settled-only.

The engine names the class in its own comment and the direction is sound but holed: `ceiling ?? 0`
is a LOWER bound, so a replay can never refuse a turn the live run allowed, and it CAN fail to
refuse one the live run refused. Driven, node `budget.tokens` 500:

    LIVE   E_BUDGET_EXHAUSTED | node "ask" would exceed its 500-token budget
                                (0 spent by this task, 1041 estimated for this turn)
    REPLAY E_REPLAY_DIVERGENCE | effect "ask@root#0:model:0" is not in the journal
    MATCH  true

`match: true` is the part that makes this worth an item rather than a comment. `compare()` grades
both runs `failed` and reports agreement, so a divergence in the one field `evolution/gate.ts`
reads to decide whether a candidate is promotable announces nothing at all.

*Fails today:* a test asserting `report.replayed.error.code === "E_BUDGET_EXHAUSTED"` for that
run. `test/run/replay-fidelity.test.ts`'s `THE HOLE THIS DOES NOT CLOSE` pins the current
behaviour and says in its own body that it should be DELETED when this lands.

**The seam this is asking for, and it is a vocabulary change rather than a repair.** An adapter's
ceiling is a nondeterministic call, so this repo's own rule applies: record it under a derived key
and let replay serve the record. That is a seventh member of `effect.started.kind` in
`journal/events.ts` plus an index for it in `ReplayEffects` — one `Kernel-seam:` trailer, and the
union's docstring is explicit that its membership is a MEASURED set rather than a place to add a
field: `test/registries.test.ts`'s `EVERY DECLARED EFFECT KIND HAS A WRITER` re-derives the
members from `run/engine.ts` on every run, so a seventh word cannot land without the code that
writes it. Two members have already been added and deleted for exactly that reason (`clock`,
`mailbox`), which is the history this seam has to survive.

**The alternative is cheaper and is the wrong answer**: skip the check in replay and say so. It
converts a refusal the live run really made into a refusal the record cannot show, and the whole
value of `hermetic`/`match` is that a recorded run reproduces including its refusals.

### 11 · ~~`hermetic`'s third conjunct has no producer, so `hermetic: true` still over-claims~~ — **DONE 2026-09-01**

**CLOSED by `dea4c09` (the forgeable brand), `9dce84d` and `686bc03` (the brand's own checks) and
`e500a2e` (the two lines below).** `node --test packages/core/test/run/hermetic-names-the-live-bodies.test.ts`
is **13/13**, and the two assertions this section pasted as its failures are now among the names
it prints: `A REPLAY THAT RE-EXECUTED AN UNVOUCHED-FOR BODY REPORTS 'hermetic: false' — driven,
not composed` and `AND THE PAIR: the same graph loaded from a ResourceStore replays
'hermetic: true'`. **The item's own prediction about the pair held exactly**, which is the reason
this section is kept verbatim below rather than deleted: it said the second line was not optional
because `isRealmBounded` was `true` on the realm call and `false` on the loader's wrapper, and the
work confirmed that landing only the first would have made `hermetic` permanently false — a term
false for everything distinguishes nothing. It also said the census test would go red on purpose
when the caller appeared; it did, and it is kept inverted, asserting exactly one caller at the
fetch site. Three existing assertions changed value, each true only while the term was inert —
including the flagship `incident-triage` workflow, which is how the tree learned that workflow
does not exercise the product's own function-loading path.

*The original item, kept verbatim:*

`ReplayReport.hermetic` is the field the replay thesis is quoted by, and its third term —
"no body ran that the runtime could not vouch for" — is inert. The brand exists
(`resources/realm.ts`'s `isRealmBounded`), the accumulator exists (`ReplayEffects.bodyEntered`),
and nothing in `src/` calls the accumulator, so `liveBodies` is `[]` on every run.

Why the term had to be its own kind is the part worth keeping: the other two terms are indexed by
EFFECT KEY, and a `function` or `evaluator{assertion}` body computes no effect key. So on a graph
of function nodes NO INPUT could make this field false while the bodies re-executed live — a
guard answering its undecidable case with the passing value, inside the field the product's whole
offline-replay claim rests on. Driven, one `function` node whose body is a hand-registered host
closure (`isRealmBounded` false), run then replayed:

    liveBodies = []  hermetic = true
    ✖ A REPLAY THAT RE-EXECUTED A HAND-REGISTERED HOST BODY REPORTS `hermetic: false`
      AssertionError: the body the replay could not vouch for must be named
      + [] - [ 'fn@root#0' ]

*Fails today:* that assertion. Two lines close it, both already named in `replay.ts`'s docstrings:
`Engine.#functionBody` calls `bodyEntered(taskId, isRealmBounded(body))` at FETCH time (so a body
that throws or is killed at its deadline still counts — the count may be too high, never too low),
and `resources/functions.ts` carries the brand onto the `FunctionBody` it wraps around
`compileRealm`'s `RealmCall`. **The second is not optional**: measured, `isRealmBounded` is `true`
on the realm call and `false` on the loader's wrapper, so landing only the first makes `hermetic`
permanently false — fail-closed, and useless.

The proving test is the PAIR, and the pair is what stops this being satisfied by a field that is
now always false: a hand-registered body giving `hermetic: false` with its taskId in `liveBodies`,
and the identical graph whose body came through `ResourceStore` giving `hermetic: true`. When it
lands, `test/run/hermetic-names-the-live-bodies.test.ts`'s source census goes red on purpose and
sends its author to two docstrings that currently promise the field is inert.

### 12 · The fork ledger's two DEBT rows — the only item property 2 asks for

Property 2's own text says shrinking `README.md`'s fork list is what the property MEANS in
practice, and that the list moving the other way is the alarm. It has moved both ways: six, then
SEVEN when an undercount was found and corrected, then **five** after `--extension-module`. Of
those five, three are BOUNDS with a replay argument — a node type, a reducer, a ninth hook point,
each a word a journal records and a fold re-reads. **Two are DEBTS: nobody built the seam.**

    $ loom serve --identity-module ./oidc.mjs                        -> exit 1
    E_CONFIG_INVALID: unknown flag: --identity-module (did you mean --identity-file?)…

    $ loom serve --channels-module ./smtp.mjs                        -> exit 1
    E_CONFIG_INVALID: unknown flag: --channels-module (did you mean --channels-file?)…

*Fails today:* both of those, run from source as `node packages/core/src/cli.ts …`. They are how
an operator would boot with a header-trusting identity source and a non-webhook gate transport,
and there is no flag onto either seam.

Both refusals are honest and both name the wrong door. `IdentitySource`, `startControlPlane`,
`DeliveryChannel` and `GateDispatcher` are all on `scripts/surface.json`, so a LIBRARY EMBEDDER
already passes an OIDC source to `startControlPlane({identity})` and a hand-written channel to
`new GateDispatcher({channels})` and forks nothing. **The bound is the CLI's, and under D.2 the
CLI is who the one user is** — which is why the split the README records in each row ("from the
CLI") is a reason to build the seam and not a reason to discount the row.

**One change, two rows.** `cli.ts`'s `ExtensionModules` docstring already prescribes it: it is
"SCOPED TO `{models, tools}` EXACTLY — the two entries this removes from the fork list, and no
more. A delivery transport sits in the same merely-recorded bucket and should EXTEND this object
when it is built, rather than invent a second flag." So the shape is `{models, tools, channels,
identity}` on the existing `--extension-module`, inheriting its five boot refusals and its
argv-only trust argument unchanged — **and that argument is the constraint, not a footnote**: the
day any of this becomes loadable from a config file, a resource ref or the data directory, a FILE
decides what code a process holding `fs:write` runs, and the seam has to move behind a process
boundary. Ledger 5 → 3, and the three that remain are bounds with reasons rather than debts.

### 13 · A run past the scan ceiling is reached by no lap

`startRunClock` is the only thing that comes back to a run nothing else is driving. It rotates a
window over `listRuns(limit)`, derived from the clock so a plane that restarts computes the same
window one that stayed up would — which is what makes the rotation reconstructable rather than a
counter in a closure, the defect that preceded it. Above `RUN_CLOCK_SCAN_CEILING` (10,000) the
listing is truncated and the rotation cannot reach past it. Driven with an injected ceiling of 10,
twelve runs, twenty laps:

    reached 10 of 12 — missing: [ '01HF7YAT01QJJ2TPQP9P9KK72A', '01HF7YAT02EKAYZM0J8A3KFSR4' ]
    ✖ EVERY RUN IN A JOURNAL LARGER THAN THE SCAN CEILING IS REACHED BY SOME LAP

*Fails today:* that assertion. `runClockTick`'s own docstring names the fix — "THE REAL FIX IS A
CURSOR — `listRuns(after)`, so a tick can page rather than re-scan — and it belongs in
`StateStore` with a conformance test behind it. When that lands, this rotation is the thing to
delete." `run-clock-window.test.ts`'s bounded-scan case pins the residual and goes with it.

The same cursor answers the second open hole on that axis: two planes over one store now AGREE on
a window rather than dividing it, which is correct (every write compare-and-swaps on its seq, so
the loser writes nothing) and wasteful (both pay the fold, and with the widened `due` predicate
both may pay the model call).

**WHY THIS IS LAST, and it is the D.2 answer doing work rather than a shrug.** Tens of runs a day
against a ceiling of 10,000 is a horizon of a year, the deployment is one plane, and the failure
is LOUD: `runClockTick` returns `truncated: true` on every tick that hits it, and `serve` writes a
three-line banner to stderr naming the ceiling and what to do about it. That banner is printed
ONCE and not per tick — deliberately, and its comment says why ("a line per tick is how an
operator learns to stop reading stderr") — so "loud" here means loud at boot, not loud forever.
This is the item on the list most likely to be right to defer again; what it must not be is
forgotten, which is why it is here with a command rather than in a comment.

---

## The record — items 1 to 8, all closed

Everything from here to "Deliberately not sequenced" is history, kept verbatim and still numbered
1–8 because `TODO.md` and the items themselves cite each other by number. It is not a plan and
nothing in it is outstanding; each item's own text says what it cost and, where the estimate was
wrong, what it got wrong. Two of them (2 and 5) have had one paragraph corrected since — each
correction is marked where it sits and says what it replaces.

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
could see** — 2,288 tests when this lane started, 2,468 now.

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
`run-clock-survives-restart.test.ts`, `restart-and-answer.test.ts`, and the window and
gate-clock files.

**CORRECTED 2026-08-29, and the correction is the item's own point made again.** This paragraph
said "15 tests, of which two spawn a real `loom serve`", and the lane has grown three files since
under later work — `admission-is-a-ceiling.test.ts`, `boot-banner.test.ts`, `oversight-door.test.ts`.
Measured (`node --test 'packages/core/test/deployment/*.test.ts'`): **9 files, 28 tests, 0 fail**;
three of them boot a real `loom serve` through `serving()` and two more spawn a real CLI that is
expected to refuse. **A count of a thing that grows is a claim with no fixed point** — the number
was true when written and stale within the week, which is exactly what "state the invariant, not
the measurement" is for. The invariant is the lane's, not the count's: everything here is
restart, scale, or a second machine, and nothing here can be checked in one process.

*Fails today:* nothing on this axis. The two open holes are **now Sequence item 13**, where they
carry a command that fails: `RUN_CLOCK_SCAN_CEILING`'s residual — a run past the ceiling is
reached by no lap, and `truncated` is the only reason anyone knows — and two planes AGREEING on a
window rather than dividing it, which is correct and wasteful. Both want the cursor
`runClockTick`'s docstring names: `listRuns(after)` in `StateStore`, with a conformance test
behind it.


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
`succeeded`. Two defects, both in `TODO.md` §A, neither reachable from any offline test. This is
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
claims; the first three were fixed at 899e22a, forty minutes after the paragraph was written, and
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

**~~What is still open, and is not this item's to close. The suite is hand-authored: `loom suite
freeze --cohort <runId>`, which would select cases from a cohort by the runs' own journaled
verdicts, is the missing half of "promoted over them".~~ STRUCK 2026-08-29 — it was true for four
and a half hours.** It was written at `b711247`, 2026-08-27 17:40; `loom suite freeze --cohort
<runId> --out <f>` shipped at `a508002` the same evening, 22:07, and stood unmentioned here for
two days. `loom help` documents it, and it refuses a cohort under 30 and refuses to overwrite an
existing path ("a re-frozen exam is not frozen"). **This is the third correction inside this one
item, and it is the same correction every time**: a claim about what is missing decays the moment
somebody builds it, so it has to be re-run against the binary rather than carried forward from the
last draft. What survives the strike is the second sentence, still true and a shape rather than a
gap: a promotion's subject is a GRAPH and `StateStore` is keyed by runId, so the decision borrows
a run's coordinate.

**AND THE SENTENCE THAT USED TO END THIS PARAGRAPH IS NOW FALSE, so it is struck rather than
edited.** It said "an offline gate still cannot judge a prompt candidate at all — it can now only
REFUSE one, which is the correct direction and not the same as a gate". The refusal is still
what the OFFLINE gate does and still correct; what changed is that refusing is no longer the only
thing the product can do with such a candidate. `loom promote <candidate> --against-cohort
<runId>` judges it by RUNNING it, on inputs read out of the cohort's own `run.submitted.inputs`,
and compares the PAIRED score differences — one difference per input, both sides scored against
one `CohortStats` measured from the baseline population alone. The decision rule is a one-sided
95 % lower confidence bound on the paired mean, which must be strictly above 0: "we detected an
improvement", not "we could not detect harm".

Three things about it belong here rather than in a commit message, because they are the shape of
the claim and not the implementation:

- **`8-determinism` cannot run in this mode and is not reported as passed.** Two live runs of a
  model do not match. The check carries `ran: false, pass: false`, the verdict carries
  `notRun`, and the journaled row carries `mode: "live-cohort"` and `checksNotRun` — so a live
  certificate cannot be read as the replayed gate's, and a consumer folding `checks.every(c =>
  c.pass)` reads it conservatively. This is the sharpest judgement in the lane and the argument
  is written out in `evolution/live.ts`.
- **The decision rule is weak at the n this corpus has.** Six pairs is the floor (`MIN_PAIRED_RUNS`,
  the smallest n at which the exact sign test can reach p < 0.05 at all), and at six the t bound
  assumes roughly symmetric differences with no way to check that from the data. It is a real
  bar — far stronger than the replayed gate's `2-non-inferior` point estimate — and it is not a
  substitute for a corpus large enough for McNemar's.
- **It has not been run against a real provider.** The mechanism is driven end to end in
  `test/cli/promote-live.test.ts` through `main()` with a stub adapter, offline; the live
  proof is the maintainer's and is the last unmet clause below.

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
stop, and this item is the last place that should be quietly conceded. **The live mode is built
so that the first of those two is not available to an operator at all**: `--against-cohort`
takes a cohort and never a set of inputs, `--runs` says how many and never which, and the
recordings used are the oldest by runId. Picking a candidate to match the corpus remains a thing
a human can do, and nothing mechanical stops it.

**DONE 2026-08-27. A CANDIDATE WAS PROMOTED OVER THE COHORT, LIVE.** The clause that had
stood since this list was rewritten is met, and `docs/evolution-loop-2026-08-27.md` carries the
whole record.

    loom promote candidates/review-bench-v3.json --against-cohort <runId> --runs 20 \
      --workspace <ws> --models-file <glm.json> --as caohaotiantian        -> exit 0

    ✓ L1-paired-improvement   paired mean Δscore 0.1356 (sd 0.0767, n 20), one-sided 95%
                              lower bound 0.1059 — needs > 0. Sign test 20W/0L/0T, p 0.0000
    ✓ 3-cost                  cost ratio 0.58× — $0.304869 vs $0.527962
    ✓ 5-prompt-size           growth 136.7%, bought by a paired mean above the bloat offset
    ⊘ 8-determinism           DID NOT RUN, and is not reported as passed

The candidate is a PROMPT — identical graph, identical functions, one changed ref — which is the
case D6 aims at and the replayed door structurally cannot see. It was committed at `9ce735b`
before it was ever run, on the argument that a diff's removed lines carry removed guarantees, and
not iterated afterwards. The journaled row carries `mode: "live-cohort"`, the cohort's
statistics, every pair, and `checksNotRun`, and holds no suite fields at all, so a live
certificate cannot be mistaken for a replayed one.

**What this cost and what it does not prove.** $1.29 for the corpora plus $0.30 for the
promotion. n=20 pairs at ONE input shape, each run once, so within-input model variance is folded
into the between-graph difference — the conservative direction, and the 20–0 sweep is well clear
of it, but a corpus of one input shape is not a corpus of many. The decision rule's weaknesses
are in `TODO.md` with the two things that would strengthen it.

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
`engine.ts` went 1,375 to 7,740 lines, was touched by 36 of the 92 `feat` commits on
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
  `run.cancelled.forced` had, which was written once as the literal `false`, read by nothing and
  named by no document. **That field is now GONE rather than merely decided-for-deletion**, and
  the correction matters because the example was doing the arguing: `run.cancelled`'s payload at
  `journal/events.ts:165` is `{clean, unknownEffects}` and nothing in that file spells `forced`.
  Its neighbour `clean` is the field that survived, because an operator does ask what it answers.
  A decision is not a diff, and this sentence describing the field as pending outlived the diff
  that executed it.
- "An extension using a proposed API cannot be published" has no publish boundary to attach to.
  `@stable` here means a file landed in `resources/<kind>/` and `readResources` picked it up at
  boot. There is no registry and no publish step to refuse at.
- It costs two `Kernel-seam:` trailers (`graph/spec.ts` for the field, `journal/events.ts` for the
  event) against a ledger standing at EIGHT, to ship a compatibility table with no entries. The
  arithmetic that made this cheap has inverted: two more trailers was a doubling when the ledger
  held two and is a 25% rise now, but the ledger is also no longer the small number the original
  argument leaned on. Re-argue it on the seam, not on the count.

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

---

## Deliberately not sequenced

Governs both lists. **Leaving something out is a choice and it is recorded here with its reason,
because an item that quietly stops being mentioned is indistinguishable from one nobody thought
of.** Each entry says what would put it back.

**Distribution** — publishing and a stranger-facing install. It follows from the first-user
decision: the next user is the maintainer porting a workflow, not a stranger who found the repo.
**Its old revisit condition has been MET and the answer did not change**: that paragraph said
"revisit when item 4 lands", item 4 landed 2026-08-25 (a real review workflow, against a live
provider, replayed offline for free), and the maintainer is still the only user. So the condition
was the wrong one — porting a workflow is evidence about the runtime, not about who else wants it.
*Restated:* revisit when somebody who is not the maintainer asks to run this, which is a fact
about the world and not a fact this repository can produce.

**Admission control's successor.** `D.4` refused the door permanently and built the operator's
levers instead — `--max-runs-in-flight` (default 4), `--max-parallelism`, and deployment
`--budget-usd`/`-tokens`/`-wall-ms` — on a measurement recorded with that decision (60 submissions
became 60 concurrent provider calls, and `loom serve` passed no deployment budget at all, so the
only money ceiling on the box was whatever each graph declared). All five flags are in `loom help`
at this commit; the concurrency figure is quoted from the decision record and has not been re-run
here. **Whether the dispatcher
also needs a queue is now an empirical question, and it is not a roadmap entry because it has no
failing command**: the levers exist, and nobody has yet driven the box hard enough to produce one.
That is a MEASUREMENT to take, not a mechanism to build, and inventing the entry ahead of the
measurement is how the last list got an item about labels on branch coordinates. *What would
sequence it:* a run rate at which the ceiling is reached often enough that "the surplus waits"
stops being an acceptable answer — which under D.2's tens-of-runs-a-day it is not.

**Splitting `engine.ts`.** Re-measured 2026-09-01: **8,454** lines, against **3,552** for the next
largest pinned file (`run/gates.ts`) and **18,724** for all ten together — **45.2%** of the kernel
by line count, in one file. **The previous reading, three days and three waves earlier, was
8,152 / 18,338 / 44%** — so the file grew 302 lines and its share of the kernel rose 1.2 points
while nothing on any roadmap touched it, entirely under `fix` traffic. Two readings are not a
trend and this file will not pretend they are; what they establish is that the SHARE is the
quantity worth re-measuring, because it can move without anyone deciding it should. Not
sequenced, and the reason is unchanged: `scripts/kernel.json`'s header carries three structural
arguments for co-location and none of them has moved. What the kernel gate establishes is that
the boundary is OBSERVABLE — a `feat` touching a pinned file costs a `Kernel-seam:` trailer — not
that the file is decomposable. *What would sequence it:* a seam somebody can name, rather than a
line count somebody dislikes.

**D5's version pin.** Item 8 says what would reopen it, and the condition is unmet: there is no
behavioural default this project wants to change while preserving the old one for graphs written
against it. `GRAPH_API_VERSION` still accepts exactly one value. The rule the pin must carry when
it arrives is already written down in item 8 so it is not decided under pressure — **a pin may
preserve a behavioural DEFAULT and never a REFUSAL.**

**A second input shape for the self-improvement corpus.** Item 5's live promotion is n=20 paired
runs at ONE input shape. "A corpus of one input shape is not a corpus of many" is stated there and
still holds, and the fix is more live spend on the maintainer's own key rather than a command that
fails — so it is a decision about money, not an engineering item. *What would sequence it:* a
second workflow ported, which produces the second shape as a by-product; that is the same argument
item 4 made and it is the reason porting workflows keeps outranking proving invariants.

**The LICENSE** was part of the distribution bundle and is no longer: it is at the repository
root, recovered byte-for-byte from `init` rather than chosen here, and declared in both manifests.
Being unsequenced was the argument for not designing a distribution story; it was never an
argument for a tree whose terms nobody can read, and the two had been bundled because the LICENSE
arrived in the same paragraph as the work it does not actually depend on.

Open items and known defects live in `TODO.md`.
