# Design

**One document: the decisions, and the Sequence they imply.** Written 2026-08-25, slimmed
2026-09-09. Each decision is stated once, with a one-line why and a pointer to where the code
enforces it. When one turns out wrong, change it here and say why in the commit — do not start a
second document. Open items live in `TODO.md`; the goal and the working rules live in `CLAUDE.md`.

---

## The thesis

The differentiator is not "the executable graph is the runtime" — LangGraph, Temporal and Obelisk
all get there, and the graph lost as an *authoring surface*. It is **how determinism is enforced**:

> **Control the realm, so the workflow language stays ordinary TypeScript.** A PRNG seeded from a
> journaled draw. A clock bound to a journaled boundary. Every effect keyed and declared. No
> undeclared capability reachable from a node body.

Obelisk enforces determinism structurally by compiling to WASM components — and then you must
author WASM. Temporal and Restate enforce it by convention plus a replay checker. This is the
third position, and it is worth saying out loud early: a reader who knows Obelisk will otherwise
ask why not WASM.

## What the field settled — adopt without re-arguing

- **Conversational multi-agent is dead.** AutoGen went to maintenance; the typed graph survived,
  free-form agent chatter survived nowhere.
- **Parallel writers do not work.** The topologies that do: single-writer plus a clean-context
  reviewer, asymmetric escalation to a stronger model, manager/child coordination.
- **Multi-agent's measured win is bought context, not specialization.** Token count alone explains
  ~80% of performance variance. So: cheap mechanically-parallel nodes with independent context
  windows, not role-play crews.
- **Interrupt/resume as a value** is universal. We have it; keep it.
- **Replay systems fail by STALLING, not crashing.** Temporal's nondeterminism error retries
  forever without entering a failed state, so a run can be dead for hours unnoticed.
- **Unlabelled data must default to untrusted** (Microsoft's FIDES: integrity × confidentiality,
  combined most-restrictive, unlabelled tool output UNTRUSTED so a forgotten annotation fails
  closed).
- **Node type stripping is Stable** and cannot do JSX. That shapes the UI answer.

---

## Decisions

### D1 · The default surface is one line; the graph is the escape hatch

`agent({model, tools, prompt})` returns something runnable that *is* a one-node graph, so journal,
replay, gates and budgets apply to a caller who never learns the graph. **Why:** every
competitor's default is one line, and a runtime whose hello-world is a graph literal loses the
first five minutes regardless of what it is better at afterwards.
*Enforced:* `export function agent` in `packages/core/src/agent.ts`.

### D2 · Effects are DECLARED, not called

A node type declares `effects: {charge: {kind, irreversibility, idempotent}}` and the runtime hands
the body a bound, keyed, retryable invoker per declared name. **Why:** an anonymous
`ctx.step(closure)` is Temporal's Side Effect trap — unretryable, unkinded, unauditable — and
declaring a capability and declaring a journaled effect become the same act, which turns "every
nondeterministic call is journaled" from a rule people must remember into a structural property.
That matters because the memory-only-state class has been violated **nine** times (the count and
its members are `CLAUDE.md`'s first non-negotiable; the enumeration is the header of
`packages/core/test/run/oversight-survives-restart.test.ts`, which names all nine and says which
file pins each).
*Enforced:* `packages/core/src/resources/functions.ts` — a sandboxed body invoking a declared
effect throws `E_EFFECT_UNAVAILABLE`. **Still open for `evaluator` bodies and for the sandbox
(`TODO.md` §G).**

### D3 · The clock is bound to the journal, not recorded

`ctx.now()` is the timestamp of the last journaled task-boundary event, so `Date` comes back into
the realm bound to that clock. **Why:** it is neither a recorded read (nothing new is journaled,
no lie is replayed) nor an unjournaled one (the hole closes); the timestamp already exists on an
event we already write, so it needs no seed and no new event kind. Bind `Temporal` the same way
when it lands as a default global.
*Enforced:* `Engine`'s lease timestamp in `packages/core/src/run/engine.ts`; a hook body's
`Math.random` throws (`DENY_RANDOM` in `resources/hook-loader.ts`) because a run-scoped hook has no Task to key
a draw under.

### D4 · Information flow — two axes, and NOT scoped to branch coordinates

Adopt FIDES' integrity × confidentiality, combined most-restrictively, with **unlabelled means
untrusted**. Channel `classification` is the confidentiality axis and the taint set is the
integrity one; what was missing is that they compose and that an unlabelled value fails closed.

**Branch-coordinate scoping was built, passed the whole suite, and was REVERTED.** Sibling
isolation is unreachable in this graph model: every arm of a fan-out runs the same node sequence so
siblings taint identically, and the one shape where they could diverge — two writers of one channel
on exclusive router arms — is refused as `GRAPH010_CONCURRENT_WRITE`. Complexity in a security
boundary with no observable gain is a bad trade. *What would reopen it:* relaxing `GRAPH010` for
provably-exclusive router arms.

**THE TRIGGER ABOVE HAS ALREADY FIRED, and nobody acted on it — say that rather than leave a
reader looking for it.** *"Relaxing `GRAPH010` for provably-exclusive router arms"* is
`routerExclusive` (`graph/validate.ts:2774`, live inside `rule010ConcurrentWriters` at `:2389`),
which landed at `ce025c1` on 2026-08-05, three weeks BEFORE this note was written at `f74d863`. So
the condition was true the day it was set. It was not acted on, and the reason is worth stating:
`routerExclusive` proves exclusivity for a NAMED PAIR of writers on one channel; it does not give
the run a per-branch coordinate, which is what the reverted work was. **A trigger nothing checks is
not a trigger.** Whoever next owns this note should either restate it as a condition that has not
happened, or delete it and record that the reopening was declined on the evidence.

**And `GRAPH010` now has a SECOND relaxation, which does not bear on this at all.**
`branchLocalChannel` (`graph/validate.ts:2484`, `77c245a`, §A.40) exempts a channel every reader of
which is inside the same fan-out branch as its writer, because there is one writer per branch and no
fold across them. It is the OPPOSITE argument to the router one: `routerExclusive` says two DIFFERENT
nodes never both run, which is the shape where siblings could diverge; `branchLocalChannel` says ONE
node's parallel instances never observe each other, so the siblings stay identical and there is still
nothing for a branch coordinate to isolate. See §A.48 for what it refuses for want of a dominance
computation.

**One axis fails closed, one fails open.** Integrity landed 2026-09-01 (`5bff93b`): `isExternal` no
longer defaults to trusted. Confidentiality is still default-trusted — `applySecretFlow` reads the
declared classification and there is no `effects: []` equivalent for a channel, while marking every
unclassified channel sensitive is the constant gate that arm's own docstring refuses.
*Enforced:* `applyControlTaint` / `applySecretFlow` in `run/engine.ts`; tests
`test/run/control-flow-taint.test.ts`, `wave-taint.test.ts`. *Open half:* `TODO.md` §G.4.

### D5 · The extension surface is versioned mechanically

Semver plus VS Code's proposed-API model plus version-pinned defaults: a proposed API lives in its
own declaration file, an extension opts in explicitly, and **an extension using a proposed API
cannot be published**. When a default changes, a graph declaring an older runtime version keeps the
old behaviour — and in a journal-native runtime that pin is an EVENT, not a build flag.
**Why mechanical:** it is what stops an ecosystem accreting dependence on an unfinished surface.

**The surface half shipped; the version pin is NOT built and is deliberately unsequenced** — see
Sequence item 8 and "Deliberately not sequenced". The rule the pin must carry when it arrives,
written now so it is not decided under pressure: **a pin may preserve a behavioural DEFAULT and
never a REFUSAL.** A safety tightening applies to `loom.dev/v1` graphs too, or "oversight only
tightens" stops holding across versions.
*Enforced today:* `GRAPH_API_VERSION` (`graph/spec.ts`) accepts exactly one value and anything
else is `GRAPH000_API_VERSION` (`graph/validate.ts`) — which is also why there is nothing to
pin yet.

### D6 · Self-improvement is text-space optimization behind a frozen gate

Treat the prompt or skill document as the trainable parameter of a frozen model: rollout batch →
reflect → bounded edits under an edit budget → **accept only if strictly better on a held-out
set**. **Why the freeze:** the suite must predate the candidate, which turns "is this eval fair?"
into a timestamp comparison rather than a judgement.
*Enforced:* `9-suite-predates-candidate` in `src/cli.ts`; `loom suite freeze` refuses a cohort
under 30 and refuses to overwrite an existing path.

**The gate D6 describes is not sufficient on its own, and that is the correction that outranks the
decision.** A candidate owns its graph, so it owned S1 and with it the outcome, the promotion
ceiling and the ground-truth condition. The answer is an operator-attested exam — a grader outside
every candidate graph, run by the runtime — designed in `docs/design-property3-2026-09-05.md`,
merged at `ec2ad88`. The five assumptions it holds under are `CLAUDE.md` §3's, not restated here.
*Enforced:* `examShape` in `src/evolution/exam.ts`; `test/evolution/exam-lane-*.test.ts`;
`examples/exams/review-bench-exam.json` is the shipped workspace exam.

### D7 · A prompt-only change is NOT a safe change

In an agent runtime the prompt *is an input to a recorded effect*, so editing it silently corrupts
a resumed run. Temporal-ecosystem guidance says prompt edits need no version guard; **Restate is
right and Temporal's guidance does not transfer.**

**The binding is the MANIFEST, not the hash.** `graphHash` is `digest(spec)` and a ref'd prompt's
text is not in the spec. `RunGraph.resolutionManifest` pins every ref to a CONTENT digest, is
journaled on `run.compiled`, and three doors check it (`Engine.#assertBound` on gate decisions and
on `advance`, `replayRun`'s `refsBound`); `RunGraph.documents` freezes the bytes by value. **The
hash is deliberately left out of it**, because `cohortKeyOf` keys on `graphHash` — putting prompt
text in it would make every prompt edit its own cohort of one, and comparing two runs across a
prompt edit is exactly the candidate kind D6 defines self-improvement as producing.
*Enforced:* `RunGraph.resolutionManifest` in `graph/compile.ts`; `test/run/graph-binding.test.ts`'s "THE SAME SPEC WITH
DIFFERENT RESOURCES IS REFUSED" (5/5). *Residue:* a MUTATED run's successor carries no recorded
manifest — `TODO.md` §G.5(a).

---

## What we deliberately do not build

- **A visual graph canvas.** The highest-profile one in the industry lasted eight months.
- **Free-form agent-to-agent chat.** It makes termination unprovable.
- **Parallel writers.** Fan-out for independent reads; one writer.
- **A verifier that pronounces code safe.** eBPF is the best-resourced instance of that idea and is
  still producing soundness CVEs in 2026. A model may *narrow* what policy already permitted; it
  may never widen. Its verdict is a model call, so it is journaled like any other.
- **A code-execution tool on an `agent` node by default.** Reaching tools through generated code is
  the shape that cut one vendor's example workflow from ~150k context tokens to ~2k, and it has a
  cost this project must state: the reachable-tool set becomes a static-analysis problem rather than
  a graph-edge one.
- **Keyed log compaction.** It deletes the history replay depends on. Payload externalisation above
  a byte threshold (`journal/payloads.ts`) and bounded-iteration rollover instead.
- **Removing a run from the journal.** Nothing in the tree deletes a journal row or a payload file;
  `rm -rf .loom` is the only eraser. A prune's real question is "will anyone replay or score this
  run?", which no journaled fact answers.

---

## Sequence

**The rule this list is written under: every item names a command that FAILS today. An item that
cannot fail is a wish, not a roadmap entry, and gets cut rather than reworded.** A Sequence with
its outcomes attached is the only evidence anyone has about what this project's estimates are
worth, so closed items keep their numbers — `TODO.md` and the items cite each other by number.

**A summary table that names a command but is not re-run is a second copy of a fact, and the second
copy is the one that rots.** This table's `status` column is re-derived from the TODO row or the
sha, not carried forward.

### Items 1–8 — the first list, closed 2026-08-28 (item 8 in half)

| # | item | status |
|---|---|---|
| 1 | Oversight correctness: a posture whose VALUE or FIELD is out of vocabulary was discarded silently; an approval bound the graph and task but not the args | **done** — `compile` refuses `policy:{posture:"strict"}` and `policy:{posturr:"out"}` |
| 2 | An instrument for everything outside one process — restart, scale, a second machine | **done** — the lane is `packages/core/test/deployment/`; `restart-and-answer.test.ts` is the scenario. Five defects nothing in the in-process suite could see |
| 3 | Finish realm determinism (D3): `ctx.now()`, hooks on replay, unseeded `Math.random` in hook bodies | **done** — two replays of one run return the same `ctx.now()` |
| 4 | Port one real workflow | **done 2026-08-25** — a review workflow over this repo's own diff against a live GLM-5.2: 3 calls, $0.046, 456 s, stopped at the gate, wrote on approval, then replayed with no key: `match: true, hermetic: true`, side effect not repeated. **One real workload found in eight minutes what 2,215 tests could not** |
| 5 | Close the self-improvement loop (D6) | **done 2026-08-27** — a PROMPT candidate promoted over a live cohort, `loom promote --against-cohort --runs 20`, exit 0 — the case D6 aims at and the replayed door structurally cannot see. n=20 pairs at ONE input shape; the offline driver is `test/cli/promote-live.test.ts`. **`8-determinism` cannot run in this mode and is not reported as passed** — the row carries `ran: false, pass: false` and the verdict carries `notRun`, so a live certificate cannot be read as the replayed gate's (`evolution/live.ts`) |
| 6 | Cut `packages/eagent` and delete it | **done** — `git ls-files packages/eagent` returns nothing. It also freed the word *kernel* to mean `packages/core` |
| 7 | Give "the kernel" a referent and gate it | **done** — `scripts/kernel.json` pins ten files, `scripts/check-kernel.mjs` fails a `feat` diff touching one without a `Kernel-seam:` trailer |
| 8 | The extension surface and its version pin (D5) | **surface half done** (`compileRealm` states the bare-function-expression rule in both refusals; `requireFunctionBodies` sits beside `requireHookBodies`). **Version pin NOT built** — see "Deliberately not sequenced" |

Two things learned here that outlive the items: **a count of a thing that grows is a claim with no
fixed point** (item 2's test count was stale within the week — state the invariant, not the
measurement), and **a number written beside a command is evidence only if somebody ran the
command** — item 13 carried two counts one line apart, one of them run and one of them not, and the
unrun one looked exactly as authoritative.

### Items 9–14 — closed 2026-09-02

| # | item | status |
|---|---|---|
| 9 | A rewind is permitted BECAUSE a compensation exists, then does not run it | **done `552d999`** — by a DECISION, not a build: `#compensateOne` passes `nodeApproved: trigger === "rewind"`. Pin: `test/run/rewind-through-subgraph.test.ts` (3/3), `rewind-plan.test.ts`. Residue `TODO.md` §A.8. Not in scope, so it is not re-litigated: `#edgesToTake` still has `case "compensation": break;` — a rollback names a CALL and an edge names a NODE |
| 10 | Three token and cost ceilings cannot be re-derived by a replay | **done `a8d62fb`** — a seventh `effect.started.kind`, `quote`, one `Kernel-seam:`. Pin: `test/run/replay-fidelity.test.ts`'s `THE HOLE THIS CLOSES`. *Residual, confined to old journals:* a recording written before `quote` falls back to `ceiling ?? 0`, a LOWER bound — such a replay can fail to reproduce a refusal and can never invent one |
| 11 | `hermetic`'s third conjunct has no producer, so `hermetic: true` over-claims | **done `e500a2e`** — `bodyEntered` at FETCH plus the realm brand on the loader's wrapper; **neither line works alone**. Pin: `test/run/hermetic-names-the-live-bodies.test.ts` |
| 12 | The fork ledger's two DEBT rows | **done 2026-09-01, ledger 5 → 3** — `--extension-module` widened to `{models, tools, channels, identity}`. `--channels-module` / `--identity-module` are still `unknown flag` ON PURPOSE: a second flag would have to re-earn the argv-only trust argument. Pin: `test/cli/extension-module.test.ts` |
| 13 | A run past the scan ceiling is reached by no lap | **first half done `3762a0e`** — `RunFilter.after`, a keyset cursor on `StateStore.listRuns`, one `Kernel-seam:`; `RUN_CLOCK_SCAN_CEILING` is gone. Pin: `test/deployment/run-clock-window.test.ts`. **Second half is NOT this seam**: two planes dividing one listing needs a fact spanning runs — `TODO.md` §E.2's coordinator |
| 14 | `loom replay` / `loom trace` refuse a run whose graph the workspace already holds | **done `0a8aa6d`** — there are THREE answers, not two: resolved (named on stderr), a workspace publishing other graphs (told so, with them listed), a workspace publishing nothing compilable. `--graph` still wins and is now CHECKED against the journal (`E_GRAPH_MISMATCH`). Pin: `test/cli/cli.test.ts` |

**The ordering argument, and it is the whole reason the list is an argument rather than a
preference: SILENT-AND-WRONG OUTRANKS LOUD-AND-MISSING.** Items 9–11 are one defect class in three
costumes — *a guard answering its undecidable case with the passing value* — and the operator's
evidence says the run is fine. 12 and 13 announce themselves.

**The method that produced these verdicts:** items 10 and 13 "failed" by way of a test that
PASSED — a pinned residual whose green was the item's red, with the pin's own body saying it must
be turned over when the item landed. That is what a roadmap item should look like: a claim that
cannot quietly become true.

### Items 15–28 — opened 2026-09-02 by a parallel survey of all 46 open backlog rows

**The list was empty five passes running, and what was empty was the SEARCH, not the roadmap.**
Seven agents audited every open row in parallel, each required to paste a command it had actually
run. **The bar: an item names a behaviour that is WRONG or
MISSING through the shipped binary or the library surface, never a flag table's opinion about a
spelling** — `unknown flag: --otlp` is manufacturable for every unbuilt thing in this corpus, so
admitting it turns the rule into a counterexample generator.

| # | row | status |
|---|---|---|
| 15 | A.18 | **done `b2f4002`+** — control-flow taint. It shipped keyed on `node.type === "router"` when a router is not the only way this engine chooses a branch; a reviewer drove the identical attack with the router deleted, three ways. Now keyed on the CHOICE, naming its covered set |
| 16 | A.30 | **done `e639d2b`** — an `effect.completed` with no `details` dispatched its undo with `args = {}` and journaled `compensated` while the effect stood |
| 17 | A.2 | **done `34a7f14`** — `compare()` graded `status` alone, so a refusal whose error RECORD varied by path scored `match: true` |
| 18 | G.5(a) | **open** — after a MUTATION the successor carries no recorded manifest, so a gate decision on it never checks the resources behind its refs. `TODO.md` §G.5 residue (a) |
| 19 | A.23 | **done `276e05c`** — a ceiling lowered 15× replayed clean with zero reasons |
| 20 | B.2 | **done** — every declared event type now has an appender, asserted as a rule over the EMPTY SET (`registries.test.ts`), so a new unappended member fails with nowhere to be excused. `budget.reserved`/`budget.settled` and `task.skipped` were wired (the last at `Engine.#skippedByJoin`, from both of `#commit`'s terminal-failure exits); `channel.written` and `task.started` were deleted from the vocabulary, 53 → 51 |
| 21 | A.36 | **done `d9a8173`** — a child run was LISTED by `GET /runs` and 404'd on every by-id route; a child id always contains a `#` |
| 22 | B.1 | **reclassified, not work** — `TODO.md` §B.1: `LeasedScheduler` is a pinned public type a library embedder already reaches, so "wire it or delete it" is a false dichotomy |
| 23 | A.13 | **done `96a03bf`** — `loom run` counted its own laps instead of the run's progress |
| 24 | A.29 | **open, and three mechanisms have been REFUSED** — a frozen golden case pins the whole work channel verbatim. Each refusal is the same shape: the candidate owns both sides of any channel its graph produces. `TODO.md` §A.29. **RE-SEQUENCED 2026-09-22b, keeping its number rather than being reopened as a new item.** The FACT that moved: "a second input shape for the self-improvement corpus" was deferred below on the cost of a second port, and ports 2 and 3 have since happened, so the shapes exist and what is left is live spend against them. The 2026-09-22b assessment's judgement — not a measurement — is that this makes the money decision smaller. **What closes it is the behaviour §A.29's title names** — a candidate the graph's OWN verifier certifies, refused by `1-must-pass` and reported as a 33.3pp regression, must stop being refused. **That behaviour is NOT currently reproduced by a command:** §A.29 carries only a grep the row itself disowns (it counts prose about a deletion), so producing a repro for the refusal is the item's own first task. Closing it needs a fold that can answer *"what did channel C hold when task T read it"*, a per-task ordering `RunProjection` does not carry — **or** property 3's claim re-scoped to what the exam actually establishes, with `CLAUDE.md` §3's five assumptions rewritten to match. This item and item 18 are the only OPEN items in 1–28; 8 and 13 are HALF, and their remainders are real — D5's version pin, and `TODO.md` §E.2's coordinator |
| 25 | D.1 | **done** — `readMcpServers` silently dropped every key it did not know, so a per-server `irreversibility` vanished. `TODO.md` §D.1 |
| 26 | H.4 | **done `96a03bf`** — three flags accepted and ignored on a verb reading none of them |
| 27 | H.3 | **done `e8c2fb5`** |
| 28 | H.1 | **closed** — not the way the row asked. under the one-machine/one-operator framing in `TODO.md` §D's header, a manual rebuild is a documented operating condition, not open work. `TODO.md` §H.1 |

**What the waves added rather than took off.** `TODO.md` §A.39 and the delivery half of A.36, both
found by a verifier rather than a builder, and both the same shape — a fix that is right in itself
leaving a second half nobody had looked at. **A wave that closes N items and opens zero is a wave
nobody looked hard at.** One lane was refused outright: item 24's answer to A.29 was measured
strictly weaker than what it replaced, and a self-improvement loop gameable by the thing it
measures is the failure `CLAUDE.md` §3 names.

### What is left over, and is not roadmap-shaped

Thirteen survey rows are blocked on a named thing and sixteen are refused with a measurement.
**The two blockers that recur are design questions rather than work:** a durable fact the journal
has no vocabulary for (A.11, C.1, C.3, E.2), and a decision only the maintainer can make (D.3,
D.5, G.1). **Neither becomes an item by being wanted.** *PART of one of the two has since become an
item, and by the rule rather than around it:* item 31 below is the journal vocabulary **§C** is
blocked on, and it is an item because §C.2's own repro FAILS — eight of eleven documented span
attributes are not derivable. It does NOT cover A.11 or E.2, which are the same KIND of blocker and
have no failing command of their own; they stay here. The maintainer's decisions are still not
items at all, and the list of them after item 31 says so in its own heading.

### Items 29–31 — opened 2026-09-22b by the settlement's assessment

**Standing, and the set is NAMED because a count of it was wrong once already.** Of items 1–28:
**two are still OPEN — 18** (G.5(a): after a MUTATION the successor carries no recorded manifest,
so a gate decision on it never checks the resources behind its refs) **and 24** (A.29) — **two are
half**, 8's version pin and 13's second half, **22 was reclassified**, and the other **twenty-three
are done**. Re-derive it from the three tables above, never from this sentence. No item had been
opened since 2026-09-02, when items 15–28 were.

**What that leaves is not code.** Three workflows are ported with zero changes under
`packages/core/src`; `npm run check` is green (the handoff's §1 carries the wave's counts, which
move with every commit and are deliberately not repeated here); and the surface guard was seen
refusing a real commit this wave — `check-surface.mjs` printed `added: BlockFieldType`, and the
union was made module-private. The open-row count ROSE across three settlements — **46 → 51 → 56**,
counted with `TODO.md`'s own census command at `bde693e2`, `0a9483c0` and `279b5c73` — because
strangers drove the binary, not because anything decayed. **What is not started is the product.**
These three items are what a maintainer does next, and **the owed-decision list after item 31 is
what the THREE wait on** — items 18 and 24 wait on none of it; each closes on the terms written in
its own row and cell.

**29 · Distribution — a published binary and a stranger-facing install.** *Moved here out of
"Deliberately not sequenced", and TWO conditions are being retired, which is not the same act.* The
SUPERSEDED one ("revisit when item 4 lands") was met and the answer did not change, and this file
already called it the wrong condition: porting a workflow is evidence about the runtime, not about
who else wants it. The STANDING one — *"somebody who is not the maintainer asking to run this"* —
was never called wrong and is **ABANDONED here rather than met**, because it cannot be met: nobody
who is not the maintainer can ask to run a thing they cannot obtain, so a condition waiting on a
stranger is waiting on the very step it gates. **What replaces it is the goal's own first verb.**
`CLAUDE.md` opens *"Install it, describe what they want done, have it run against a real provider,
watch it, stop it, and trust what it did"* — **six verbs, and the receipts are not evenly spread.**
Item 4 is the receipt for four of them in one run: a real workflow DESCRIBED as a graph, RUN
against a live GLM-5.2, STOPPED at the gate, and TRUSTED by a replay with no key
(`match: true, hermetic: true`, the side effect not repeated). **WATCH has the weakest** — the
console and `GET /runs` exist, and `TODO.md` §C's header says *"a richer operator surface over a
plane that is not emitting is a better view of nothing"*, which item 31 below is about. **INSTALL has none at all**, and it is the only one of the
six no item has ever been written for. Two commands fail today, the second more quietly than the
first:

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

`README.md`:69–72 already states the second in full — *"`@loom/core` is `private: true`, and
`npm publish` does not REFUSE — it exits 0 and quietly does nothing, which a CI step checking only
the exit code would report as a successful release."* **Closes when** somebody who has not cloned
this repository can install and run `loom`. **Making `npm publish` refuse is NOT part of that** —
it is a guard over a silence that stops mattering the moment the package is publishable, and
`TODO.md` §H.15 says so on its own row. **What this reopens by its own text**, named here so it is
not discovered later: `TODO.md` §H.1 says verbatim *"Reopens on more than one operator, or a
published binary"*. §D's single-operator framing is not disturbed by publishing as such — of the
things that rest on it, the one that names a published artifact is §H.1, and the permanent
admission refusal rests on the run RATE rather than on who can obtain the binary.

**30 · The channel-shape decision: what a channel carries when a tool fails, truncates, or holds a
secret.** §A.82, §A.83 and §A.90 are **one unanswered question**, which is the whole reason this is
an item rather than three. §A.90 is the one to answer first — it is the only row in `TODO.md` that
ends in destroyed data with exit code 0, and the command that shows it is **pasted once, on §A.90's
own row**, re-run for this settlement on `29c8b9ec` against the shipped `grant-access.json` with
its defence in place: `chmod 333` the output directory and the run exits **0**, reports
`succeeded`, rebuilds its ledger from `historySource: "none"`, and `u:sam`'s grant is gone. Read it
there; a second copy is the copy that rots.

**Closes when** a tool failure, a truncation and a classification are FACTS on a channel an `error`
arm may declare in `reads` — answered ONCE for all three rows, not three times. The shape is the
decision: §A.90 needs the failure's code and message projected; §A.83 needs *this read was
truncated* out of the content string and onto the channel, at all three of its sites (`fs.read`,
`proc.exec`, `net.fetch`); §A.82 needs a per-key classification in both directions. A wider regex is
not §A.82's closure and a bigger `maxBytes` is not §A.83's — each of those moves the gap. The
`KNOWN HAZARD` test in `packages/core/test/examples-grant.test.ts` asserts today's LOSS, so when
this lands that test FAILS and is deleted along with the `look` node rather than loosened.
`TODO.md` §D.10 carries the options.

**31 · The journal vocabulary §C is blocked on.** §C gates the UI direction, and it is blocked on
facts the journal has no words for, not on a view. Eight of eleven documented span attributes are
NOT DERIVABLE, and the repro counts the three that are:

```
$ /usr/bin/grep -aoE '"(gate\.batched|tool\.attempt)"|(^|[^.\w"])capability\s*:' packages/core/src/telemetry/spans.ts | /usr/bin/grep -ac .
3
$ /usr/bin/grep -anc 'name: "loom\.' packages/core/src/telemetry/spans.ts
7        # and it UNDERCOUNTS by two: `loom.model` and `loom.tool` are one ternary, so nine exist
```

Six designed span names have no producer and each names the event it would need (`TODO.md` §C.1);
the eight underivable attributes each state theirs (§C.2). **This item covers §C and only §C** —
A.11 and E.2 are the same kind of blocker with no failing command, and stay in "What is left over"
above. **Closes name by name, two or three events at a time** — every one is a
`journal/events.ts` change and therefore a `Kernel-seam:` trailer, which is exactly what the kernel gate exists to make visible. **It does not close by
emitting them**: §C.2's own text says so. Do not start the UI ahead of it — a richer operator
surface over a plane that is not emitting is a better view of nothing.

**The owed decisions are NOT an item, and that is the rule working rather than an omission.** A
decision cannot name a command that fails, so it gets cut rather than reworded — but the SITTING is
the highest-value unit of work in this project right now, and the list is here so it is not carried
in a chat. Four of these are owed for the FIFTH wave running. Enumerated:

- **§A.68 — `skip` vs `fail` on the shipped `two-person-approval.json`.** *Still the decision the
  settlement most wants answered*, and it is one word in a shipped example. Both modes now refuse a
  run below `k` (§A.75 closed); they differ in WHEN. The row is struck — the graph's behaviour is
  documented and correct — and the decision lives in its 2026-09-22 addendum.
- **§A.77** — whether `validate.ts` should refuse `k > branches.length` for a barrier whose every
  member is static and unfanned. No lane has taken it.
- **The exported-constant shape-break policy** — `EDGE_FIELDS`, and now `POLICY_FIELDS` and
  `NESTED_FIELDS`, changed from ARRAYS to RECORDS and kept their names, so `check-surface.mjs` reads
  "unchanged". Whether that guard should pin SHAPE, and whether such a change may land under `fix:`.
  `TODO.md` §D.11.
- **Whether `attach` should be honest** (§A.76's residue), now with a measured cost: it is the
  reason neither `#assertBound` vocabulary check can see a graph attached to a run this process
  already holds.
- **§A.71** (does a budget/fatal floor cascade to a subgraph child), **§D.8** (must a join's inbound
  edge be `kind: "join"`), **§A.70** and **§A.72** — four owed into a fifth wave.
- **§A.87** — `metadata.version`: a number or a semver STRING.
- **§A.86** — whether `GRAPH002`'s reachability should be *realisable* rather than *reachable*, or
  whether a warning may over-approximate and say so at the rule.
- **The per-run-ledger alternative to port 3's F5** — a per-run ledger file cannot lose an entry to
  a failed read, and converts a silent loss into a spurious gate, which is the direction a guard is
  allowed to fail in. It is a structural alternative to item 30, not a substitute for it.

**And the ordering argument, which is the only thing that makes this a list rather than a
preference: A DECISION AND AN INSTALL PATH OUTRANK A NINTH WAVE OF INVARIANTS.** Item 30 first,
with the sitting above riding on it; then 29; then the two that were already open — **24** (A.29,
re-sequenced on its own row above) and **18** (G.5(a)) — which are the two open items on property
3's own path: 24 is the promotion half, and 18 is the MUTATION half, a mutated run's successor
carrying no recorded manifest for `#assertBound` to compare, on the same verb self-improvement
would have to use. Then 31. A FOURTH workflow port is worth
as much as the first three — that claim is unchanged — and comes after 29 and 30, because a port's
value is the friction it logs, and friction met by a stranger who could not install this is
friction nobody logs.

---

## Deliberately not sequenced

Governs the whole Sequence. **Leaving something out is a choice, and an item that quietly stops
being mentioned is indistinguishable from one nobody thought of.** Each entry says what would put
it back.

**Distribution left this list on 2026-09-22b and is now item 29** — named here rather than quietly
dropped, because that is this section's own rule. **Its entry carried two conditions and they were
retired differently.** The superseded one ("revisit when item 4 lands") was met and the answer did
not change, and the entry itself called it the wrong condition. The standing one — *"somebody who
is not the maintainer asking to run this"* — was **never called wrong; it is ABANDONED**, because
it cannot be met: nobody who is not the maintainer can ask to run a thing they cannot obtain, so
the condition waits on the step it gates. What sequences it instead is the goal's FIRST VERB. Item
29 states both retirements.

**Admission control's successor.** The door was refused PERMANENTLY — under one tenant the right
answer to "too much work" is to make it wait, never to say no — and ceilings were built instead:
`--max-runs-in-flight` (default 4), `--max-parallelism`, deployment `--budget-usd`/`-tokens`/
`-wall-ms`. `TODO.md` §Z carries the refusal. *What would sequence it:* a run rate at which "the
surplus waits" stops being an acceptable answer, which under the framing answer in `TODO.md` §D's
header — one machine, one tenant, the maintainer's own workflows, tens of runs a day, one operator
— it is not. That is a MEASUREMENT to take, not a mechanism to build.

**Splitting `engine.ts`.** Measured 2026-09-09: `wc -l packages/core/src/run/engine.ts` → **13,160**
lines, against 3,755 for the next largest pinned file (`run/gates.ts`) and 24,773 for all ten —
**53% of the kernel by line count, in one file, and the share moves under `fix` traffic without
anyone deciding it should.** Re-measure the SHARE, not the count. Not sequenced: `scripts/kernel.json`'s
header carries three structural arguments for co-location. What the kernel gate establishes is that
the boundary is OBSERVABLE, not that the file is decomposable. *What would sequence it:* a seam
somebody can name, rather than a line count somebody dislikes.

**D5's version pin.** Unmet: there is no behavioural default this project wants to change while
preserving the old one, `GRAPH_API_VERSION` accepts exactly one value, and there is no publish
boundary for "an extension using a proposed API cannot be published" to attach to — `@stable` here
means a file landed in `resources/<kind>/`. A pin costs two `Kernel-seam:` trailers to ship a
compatibility table with no entries. *Re-argue it on the seam, not on the count.*

**A second input shape for the self-improvement corpus.** Item 5's live promotion is n=20 paired
runs at ONE input shape, and a corpus of one input shape is not a corpus of many. The fix is more
live spend, so it is a decision about money. *What would sequence it:* a second workflow ported,
which produces the second shape as a by-product — the same argument item 4 made, and the reason
porting workflows keeps outranking proving invariants. **THE PORT CONDITION IS MET, 2026-09-22b, and the
2026-09-22b settlement's assessment is that the money decision is now SMALLER than when this was
written** — the sizing is the assessment's, not a measurement: two more workflows have been ported
since, `examples/graphs/harden-config.json` and `examples/graphs/grant-access.json`, overlapping
the first in `seq` alone and in six mechanisms respectively, so the shapes exist. What is left is
the live spend against them, which is still a decision about money and still only the maintainer's.
It stays here rather than becoming an item because no command fails: nothing in the tree refuses a
second shape, there simply is no run at one. **Item 24's amended cell is where this now bears.**

**A file-level `// loom:surface <version>` directive** was proposed under item 8 and REJECTED on a
control: its justification was that such a directive on a hook body disarms the `no-secrets` hook,
but the no-op body was the whole effect — the directive is inert. A new refusal with no caller and
no defect is a pattern this project has already paid for twice.

Open items and known defects live in `TODO.md`.
