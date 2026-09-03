> **SUPERSEDED 2026-09-03 by `handoff-2026-09-03.md`. Two claims below were falsified by the
> audit this file commissioned, and are corrected here rather than edited out, because the audit
> was run against the file as written:**
>
> 1. **§5's "`cli/cli.test.ts` still swallows both" is FALSE at HEAD.** All 243 test files were run
>    individually; none reports fewer tests than its static `test(` call sites, `cli.test.ts`
>    included (38 sites, 38 reported). 2,757 static + 108 loop-generated = 2,865 exactly.
> 2. **§2's "the highest-leverage single change in the tree" rests on a false premise.** It says
>    `RunProjection` does not carry a per-task ordering of served channel state. It does not *store*
>    it, but the fact is fully *reconstructible*:
>    `foldRun(store.read(runId, 1, seqOf(task.leased)))` then `viewFor(...)` returns byte-identically
>    what the body was handed, including fan-out bindings and channels a later task overwrote.
>    `StateStore.read` already takes an end bound. What is missing is that nothing ASKS — no
>    `--at-seq`, and none of `foldRun`'s five call sites answers the question. That is a read-model
>    affordance OUTSIDE the kernel, needing no new durable event, so A.29 and DESIGN item 20 are
>    cheaper than this file implies.
>
> Everything else here held up, including §1's central claim about adversarial review and §6's
> warning about the taint guard — which took five rounds and is still parked.

# Handoff — 2026-09-02, written for a thorough audit and refactor

The session that produced this ran from `c8bdf22` to HEAD: **31 commits**, 15 `fix`, 3 `feat`,
2 `test`, 2 `docs`, **1 `revert`**. Tests **2,777 → 2,865**. Surface **538, unchanged end to end**.
Kernel **10 files, 10 → 11 declared seams** (one spent, deliberately, by B.2).

This file is written for somebody about to audit and refactor the whole tree. It is not a summary
of what was built — `git log` is that, and the commit bodies carry the arguments. It is **what an
auditor should not have to rediscover**, and **where I would look first**.

---

## 1 · The one thing to read before anything else

**Eleven of eleven adversarial reviewers found something real, and it was never what the builder
had tested.** Three of them found BLOCKING defects. Two refuted a claim the builder had personally
*measured*. Every lane in every wave self-reported DONE or PARTIAL; not one self-reported the
defect a reviewer then found in it.

That is the strongest empirical result of the session and it should shape how the audit is run.
**"All green" is not evidence.** The pairing that produced these findings was: a builder in an
isolated worktree, then a fresh agent given the diff and told to attack it, with instructions to
default to "this is wrong" and to construct a SECOND input of the same shape.

## 2 · What was reverted, and why it is the most important row

`aabdc63` reverts A.29's third mechanism. **Do not re-attempt it structurally.**

A frozen golden eval case pins its work channel byte-for-byte. That produces a false negative: a
candidate the graph's OWN deterministic verifier certifies is refused as a 33.3pp regression.
Three mechanisms were built to let the verifier waive the byte pin. All three were defeated:

| attempt | pinned | defeated by |
|---|---|---|
| 1 | who the verifier is | rewriting the channel the verifier READS |
| 2 | + what it said | ground truth as a graph-PRODUCED channel — the candidate owns both sides |
| 3 | + what fed it, + 2 structural conditions | four games, two driven through the shipped verbs |

Attempt 3's four games are on the row with their `promote: true` measurements. One of them defeats
**the topology its own documentation recommended as the remedy**.

**The shape of the hole:** the pin reconstructs *what the grader saw* from the run's FINAL channel
value and the graph's STATIC edge ancestry. Neither is a statement about time, and the candidate
owns the graph — so it can make both agree with the recording while the grader consumed something
else.

**What would close it, named as a journal fact:** a per-task ordering of channel state — what each
task was SERVED, not what the run ended with. `RunProjection` does not carry it, and `task.started`
(the event that would mark when a body was handed its view) still has no appender. **DESIGN item 20
wants the same fact for B.2, so there are two customers for one durable event.** That is the
highest-leverage single change in the tree.

This matters beyond one row: property 3 ("endless self-improvement") is the weakest of the three
properties, and this is why.

## 3 · Where I would point a refactor

These are observations from working across the tree, with the evidence. They are not instructions.

**The prose is a liability at current volume.** ~20 false claims were found in one day, in
`TODO.md`, `DESIGN.md`, `README.md`, `engine.ts`, `compile.ts`, `realm.ts`, `delivery.ts`,
`otlp.ts`, `compensation.ts`, `cli.ts` and `gate.ts`. **Several were introduced by the very commits
correcting other false claims** — including three of mine. `engine.ts` is 9,962 lines and `cli.ts`
8,684, a large fraction of both being argument.

The pattern that HELD is different in kind: a claim bound to a probe that fails when the claim goes
false (`readme-gaps.test.ts`, `deadline-set-is-named-not-counted.test.ts`, `registries.test.ts`).
Everything bound only to prose drifted. **A rule worth adopting: a checkable claim in a docstring
either gets a probe or loses the claim.**

One caution learned the hard way — `readme-gaps.test.ts` pinned a *formatting token*
(`/task\.ready" as const/`) as its proxy for a behaviour, and fired on a change that strengthened
exactly what it protected. A probe must name the mechanism, not the spelling.

**Two files hold most of the mass.** `engine.ts` (9,962) and `cli.ts` (8,684) are 28% of `src/`.
`scripts/kernel.json`'s header carries three arguments against splitting `engine.ts` — read them
before deciding; they are good and they are not obviously still decisive at this size.

**Every wave found a defect of the same class in a different place:** a guard that answers its
undecidable case with the passing value. The taint guard shipped with four bypasses; the rewind
preview over-reported; `--__proto__` walked past two flag guards; a fold compared 0 to 0. If the
audit wants one lens, that is the one with the best hit rate here.

## 4 · What is open, and honestly categorised

`docs/backlog-survey-2026-09-02.md` has all 46 rows audited by running them. Since then:
**9 closed, 1 reverted, 1 reclassified.** `DESIGN.md`'s live list is items 15–28: **8 done, 6 open.**

Of the six open, **none is blocked on effort**:

| item | row | what it actually needs |
|---|---|---|
| 20 | B.2 | the remaining three declared-but-unwired event types — `task.started` is the one A.29 also needs |
| 24 | A.29 | the journal fact above. Not a fourth structural patch |
| 18 | G.5(a) | pinned by a test; unreachable from the binary today. Correct as-is |
| 22 | B.1 | reclassified — see below |
| 25 | D.1 | half done; the rest was a maintainer's decision and it was made |
| 28 | H.1 | closed this session |

**B.1 is a correction worth reading.** I recommended deleting `LeasedScheduler` and was wrong.
It is on the pinned public surface, `EngineOptions.scheduler` is the seam, four suites exercise it,
and an embedder constructs it today — driven. Deleting it would have removed two pinned exports and
a working capability. The project had already made this exact call twice (the fork ledger's 5 → 3).
The real item hiding under it: a plane that dies between `task.leased` and `task.committed` strands
that run permanently under `InProcessScheduler`, because reclaiming needs a lease deadline.

## 5 · Facts an auditor will otherwise rediscover

- **`/usr/bin/grep -a` always.** Five tracked files carry a NUL byte; grep silently skips them and
  *undercounts in a way that moves with the search term*. Census by reading every `git ls-files`
  path instead. Two agents nearly made it six by writing raw control bytes into a regex.
- **`node --test` needs a glob, not a directory.** A bare directory path silently runs one "test".
- **A capture that swallows `process.stdout` eats `node:test`'s own reporter.** One file ran 14
  tests and reported **2**, all green. Measured: swallowing stdout reports 1 of 5, forwarding
  reports 5 of 5, swallowing only stderr reports 5 of 5. `cli/cli.test.ts` still swallows both.
- **Never run a mutation sweep in the shared checkout while an agent runs the suite there.** It
  produced a spurious failure whose signature was exactly the mutation, and cost an agent a cycle.
- **Worktrees were mis-provisioned three times**, from an unrelated pre-`packages/` commit. Every
  builder brief should open with "check your base by sha".
- `npm run check` forces a build; `npx tsc -p packages/core/tsconfig.test.json` is the safe
  read-only typecheck under concurrency. `check-surface.mjs` reads `dist/` and lies against a
  stale one.

## 6 · The risk I would not leave unexamined

**The control-flow taint guard (A.18) is new, security-relevant, and shipped with four bypasses
that one reviewer found in a single pass.** All four are closed and I verified the closures by
re-running that reviewer's own probes. I would not assume that is all of them. The covered set is
named at `choiceOf` — four mechanisms in, five out with a reason each — and **that named set is the
obvious thing to attack**. It is the one guard in the tree where a miss is a prompt-injection path
to an irreversible action.

## 7 · Numbers, each with the command

| fact | value | command |
|---|---|---|
| tests | 2,865 pass, 0 fail | `npm test` |
| pinned exports | 538 | `node -e "console.log(require('./scripts/surface.json').length)"` |
| kernel | 10 files, 11 seams | `node scripts/check-kernel.mjs` |
| zero runtime deps | green, 62 files | `node scripts/check-zero-dep.mjs` |
| NUL census | 5 files, 0 invalid UTF-8 | read every `git ls-files` path; see §5 |
| backlog rows | §A 36/21 struck · §B 2 · §C 5/2 · §D 5/3 · §E 8 · §G 7 · §H 5/4 | the three greps in `TODO.md`'s "What is still open" |

**No number here is carried anywhere else.** `TODO.md` owns the row census and `DESIGN.md` owns the
live list; a third copy is the one that rots, which is this project's most-repeated finding about
its own documents.
