# Closing the backlog — 2026-08-25 → 2026-09-02

A dated record, in the shape of `audit-2026-08-25.md` and `todo-recheck-2026-08-25.md`: what
moved, how each claim was settled, and what is still open. **Every number here has the command
that produced it beside it, and every one was run at `241e99f`.** A row you cannot re-run is a row
that should not be here.

The working state this was driven from (`.agent/finish-the-backlog/`) is gitignored and will not
survive. This file is what is meant to.

---

## Where the tree is

| fact | value | command |
|---|---|---|
| tests | 2,777 pass, 0 fail | `npm test` |
| pinned public exports | 538 | `node -e "console.log(require('./scripts/surface.json').length)"` |
| kernel | 10 files, 10 declared seams | `node scripts/check-kernel.mjs` |
| zero runtime deps | green, 62 source files | `node scripts/check-zero-dep.mjs` |
| commits since `2c36026` | 160 — 73 `fix`, 24 `docs`, 8 `feat`, 4 `refactor`, 3 `test`, 2 `chore` | `git log --oneline 2c36026..HEAD` |
| forks still required | 3, down from 5 | `README.md`, "Extending it, and where that stops" |

`DESIGN.md`'s live Sequence list is empty: items 9 through 14 have all landed. That is the
headline, and it is also the reason this file exists — an empty roadmap is the moment the open
work stops being self-describing and has to be written down.

## What was actually closed

**No count, deliberately** — `TODO.md`'s own rule is that a count nobody can enumerate is a count
nobody checked, and this one cannot be enumerated: `git grep -c '^- ~~\*\*' TODO.md` gives 20
struck rows, but §Z is written as prose paragraphs rather than as a list, and many fixes never had
a row at all. The enumerable statements are the 20 struck rows and the 73 `fix` commits; anything
between them would be a number nobody can re-derive. What follows is the shape of the work,
grouped by the property each defect threatened:

**Oversight failing open** — the dominant class, and the one the project's non-negotiables are
written against. A guard answering its undecidable case with the passing value: the oversight
floor reading `gateRaised=0` as CHARGED=1; four guards reading an allow-list in the loosening
direction; `hermetic`'s third conjunct being inert; an order-dependent capability ceiling
(`reachableToolNamesThrough` used a `Set` where it needed a depth `Map`, so the floor depended on
graph traversal order); `PolicyEngine.clearCeiling`, which would have violated "oversight only
tightens" on its first call and was deleted rather than fixed.

**Replay and the journal as sole authority** — a cancelled run still scheduling; divergence
terminating the task but not the run; pause/resume writing through `log.append` instead of
`RunLog.commit`, so a restart lost it. Invariant 2's sixth instance was found in a second file,
which is why `CLAUDE.md` now says the enumeration is split and treats that as the lesson.

**Escape hatches that were not** — a live prompt-injection path where unlabelled input read as
trusted; a host-realm escape through the global proxy's prototype (`vm.createContext({})` let
`globalThis.__proto__.constructor.constructor` reach the host realm and the wall clock).

**Bounds that did not bound** — `retry: {maxAttemptss}` typo'd its way to an unbounded retry;
nodes had no default timeout.

**Two kernel seams**, both spent deliberately after being argued: `quote` (item 10) and
`RunFilter.after` (item 13). The census went 8 → 10 and has not moved since.

## Three things that were believed and turned out false

These are the reason the file is worth reading. Each was stated confidently, in a document, on a
read — and each fell over when someone ran it.

**1. `git log --grep='^Kernel-seam:'` is not an audit of the seam census.** It was published in
four documents as an independent second opinion on the guard. It returns **11** against the
guard's **10**, because a `docs:` commit wrapped its body so that `Kernel-seam:` landed at the
start of a line: a grep for a trailer matches prose *about* the trailer, so the ledger inflates
precisely when somebody documents how the ledger works. Git's own trailer parser
(`%(trailers:key=Kernel-seam,valueonly)`) is not the fix either — it reads only the final
paragraph and sees **6** of 10, because four commits put the line mid-body. Three commands, three
answers. Only `check-kernel.mjs` reads the declarations themselves.

**2. A ratio of two timings is a *less* robust measurement than one timing.** `scale.test.ts`
asserted `t500/t100 < 25`. Measured on an idle machine, three runs per tree: HEAD 29.6× 42.9×
48.5× and the parent 27.9× / 35.6× plus one pass — and that one pass came from a *100-node sample
of 15.5 ms* against 4.5–5.0 ms everywhere else. The assertion was likeliest to pass when its own
baseline sample was worst. Both ratios are now counts of the compiler's spec reads; the layout one
got **stricter** as a side effect, because the timing bound was 60× and a quadratic sweep is 25×,
so the old assertion could not have caught what it was written to catch.

**3. §F.18's invariant was generalised from a grep over one member of the set it claimed.** It
said no line-numbered citation into `src/` remained, having measured only `engine.ts`. Widening
the pattern found sixteen more, five already stale. The correction then committed the same error
inside the entry warning about it — it replaced "`hooks.ts:89` is stale" with "`hooks.ts:89` names
a path with no file at it at all", and the file exists.

## What is still open, with the reason

Each of these was attempted and refused with a measurement, not skipped.

- **A.23's `policy.budget` half.** Implementing it would make the offline gate refuse everything.
- **`JoinNode.onBranchError: "compensate"`.** The planner scopes by seq *range* and branches
  interleave by construction, so the scope a compensation needs does not exist.
- **Six of C.1's seven span names.** They need journal events that do not exist yet.
- **The OTLP exporter is not wired to `cli.ts`.** `loom trace` still only prints, so a deployment
  wires the exporter as a library embedder today. This is the one straightforwardly buildable item
  on the list.

**Not on this list, and worth saying so:** the fork list has no debts left in it. It went 5 → 3
when `--extension-module`'s object widened from `{models, tools}` to
`{models, tools, channels, identity}`, deleting the two rows that were forks *from the CLI only* —
a non-webhook delivery transport and an identity source, both of which a library embedder always
reached through pinned types. The three that remain (a node type, a reducer, a ninth hook point)
are closed for a *reason* rather than a debt: replay, because a fold can only reproduce a decision
whose vocabulary the folding binary already knows. The honest next move on unlimited extensibility
is therefore a new capability, not another row off that list.

## The flake, named

`cli.ts` installed its SIGINT handler only *after* `announce`. A stop landing in that ~0.3 ms
window hit Node's default handler. Hypothesis (a), a truncated buffer never firing `close`, was
eliminated 0/30; (b) confirmed 10/10.

## Working rules this run earned

- **Verify a merge arrived, by sha.** One lane's agent renamed its branch; merge-by-expected-name
  took an earlier state and *reported success*, and two commits sat unmerged for three waves.
  `git merge-base --is-ancestor <sha> loom`, one per lane, every wave.
- **Mutate the line you think you are mutating.** Inserting comments shifted a file; the mutation
  landed on line 597 instead of 606, survived, and looked like a tautology in the test.
- **An empty array is assignable to every array type.** `const u: Unplaced[] = []` accepted a
  seventh effect kind silently. `[Unplaced] extends [never]` is the non-distributive form that
  actually checks.
- **A test can be a tautology in a way that reads correctly.** An order-independence test put the
  diamond across two parent nodes, but the descent runs per-node from one root ref, so it proved
  nothing. Rebuilt with the diamond *inside a child*, the mutation reported
  `deep-first 6 refusals, shallow-first 7`.
