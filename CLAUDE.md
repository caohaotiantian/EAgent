# CLAUDE.md

Orientation for whoever works on this next. **The code is the source of truth.** Where this file
disagrees with the code, the code wins — fix this file.

Keep it short. Everything here is either the goal, a principle, or a fact you need in the first
five minutes. Work items live in `TODO.md`; the roadmap is `DESIGN.md`'s Sequence; decisions
live in the commit history and in `docs/`.

---

## The goal

**A multi-agent runtime someone can actually use.** Install it, describe what they want done, have
it run against a real provider, watch it, stop it, and trust what it did.

That is the bar and nothing substitutes for it. A correct mechanism nobody has used is not a
product, and this project has repeatedly mistaken the first for the second. **The next real
workflow somebody ports is worth more than the next invariant somebody proves.**

## The three properties, in priority order

These are first-class. Where a change trades one away for convenience, the change is wrong.

### 1 · Kernel stability

The core is small, and it stays small under pressure. Its surface is something you can hold in
your head and depend on for years.

Mechanically this means: **a change that adds capability should not touch the kernel.** If it must,
that is a signal the kernel is missing a seam, and the seam is the thing to design. A kernel that
grows a feature per use case is a kernel nobody can depend on.

**The kernel is a named list of ten files**, in `scripts/kernel.json`, each with a written reason
it is there — the criterion is *this file is the mechanism that makes one of the non-negotiables
below true, and an extension must depend on it and cannot replace it*. `scripts/check-kernel.mjs`
runs the test: a `feat` commit touching one of them fails the gate unless it carries a
`Kernel-seam:` trailer saying which seam was missing. `fix` may touch the kernel freely — fixing
it is what a kernel is for. That trailer is the escape hatch and also the ledger: the guard's own
output lists every seam declared in `since..HEAD`, with its reason.

**That ledger IS resettable, three ways, and this line used to claim it was not.** Measured
2026-09-02 by running the guard against synthetic commits: advancing `since` one commit prints
`0 declared seams` and exits 0; a `refactor:` rename of a pinned file (with the pin updated in the
same commit) drops that file's seams AND erases an outstanding unfixed violation against it,
because the matcher compares historical commits to the CURRENT path; and `Feat:`/`FEAT:`/`feature:`
are not classified as features at all. A one-character trailer value satisfies "a sentence of
design argument". Treat the count as a number a reviewer must watch in the diff, not as one the
tool defends.

Read it from the guard and nowhere else. `git log --grep='^Kernel-seam:'` inflates (it matches prose
ABOUT the trailer; guard 11, grep 12) and git's own trailer parser undercounts (it reads only the
final paragraph). Three commands, three answers. `check-kernel.mjs`'s own failure text still
recommends the grep — a correction it is owed.

The list says nothing about whether `engine.ts` should be split — see its header for three
arguments against. `check-surface.mjs` pins the exported NAME SET and nothing else, so it reports
green however large a pinned file grows; that is the gap `check-kernel.mjs` exists to cover.

### 2 · Unlimited extensibility

Everything that is not the kernel is an extension, and extensions can reach everywhere the kernel
can. No privileged built-ins: the things that ship in the box are written against the same surface
a stranger would use. If a built-in needs a back door, the surface is wrong.

The test of this property is not "can you add a tool". It is **"can somebody who does not have
commit access build the thing they need, and can they do it without forking?"**

**Today the answer is a named set, not "yes", and the set lives in `README.md`'s "Extending it,
and where that stops"** — the same escape-hatch-and-ledger shape as §1's kernel list: twelve things
need no fork (a graph, a prompt/profile/skill, a subgraph, a `function` body, a `hook` body, an
MCP tool, an OpenAI-wire provider, an ANY-wire provider, an in-process tool, an HTTP delivery
endpoint, a non-webhook delivery transport, an identity source) and **three** do: the schema sets
— a node type, a reducer, a ninth hook point. Every entry there is quoted from the refusal the
binary actually prints. All three are closed for ONE reason, replay: a fold can only reproduce a
decision whose vocabulary the folding binary already knows. **Shrinking that second list is what
this property means in practice; the list moving the other way is the alarm.** It went six → seven,
then to five when `--extension-module` gave the CLI the door onto `ModelRegistry` and `ToolRegistry`
a library embedder always had, then to **three** on 2026-09-01 when the same flag's object widened
to `{models, tools, channels, identity}` — deleting two rows that were forks *from the CLI only*
and were therefore never bounds, only debts. The trust argument that bounds the widening is stated
at `loadExtensionModules`: the module path comes from ARGV and nowhere else, because a path read
out of a file would let a FILE decide who may approve.

**"What is left has no debts in it" was the claim, and the 2026-09-02 audit falsified it by driving
all twelve rows through the shipped binary.** All twelve genuinely work — that half survived. But
`EngineOptions` takes five more members whose types are all already on `scripts/surface.json` and
which `openWorkspace` constructs unconditionally with no `extensions?.` fallback: `functions`
(`FunctionRegistry`), `hooks` (`HookRegistry`), `resolver` (`ResourceResolver`), `store`
(`StateStore`), `payloads` (`PayloadStore`). A library embedder reaches all five; argv reaches
none. **Those are debts of exactly the shape the 5 → 3 change paid off, so the published number is
an undercount — correct it before shrinking it.** Measured consequence: a host-realm async function
body with `Date` runs from a library embedder and cannot be supplied from the CLI at all.

The audit also found two privileged built-ins: `builtinTools(jail)` registers AFTER extension
modules and `ToolRegistry.register` shadows on collision, so an extension tool sharing a built-in's
name is silently never dispatched (the identical collision on an adapter or channel name refuses to
boot); and the extension registrar carries no jail, so an outsider's filesystem or network tool
cannot apply the operator's own guards even if it wants to. `README.md`'s section is the ledger and
is owed both corrections.

### 3 · Endless self-improvement

The system observes its own runs, and what it learns changes what it does next. Every run leaves
enough evidence to be judged, replayed, and improved on.

This is the property most easily faked. Capturing trajectories is not improvement; scoring them is
not improvement. **Improvement is when a later run is measurably better because of an earlier one**,
and the measurement has to be one that cannot be gamed by the thing being measured.

**It is currently faked, and this was driven end to end through the shipped verbs on 2026-09-02.**
A candidate that DELETES the work node and returns `{pass:true}` promotes through
`loom promote --against-cohort` at paired mean Δscore **+0.4000 over 30 pairs**, all eight checks
green. A candidate whose only change is swapping its own grader promotes through
`loom promote --suite` with **all thirteen** checks green. The reason is one sentence: the whole
ladder rests on S1, and `extractSignals` reads S1 out of the CANDIDATE'S OWN graph — any
`evaluator` step whose commit carries `{pass:true}` and made no model call. **A candidate owns its
graph, so it owns S1**, and with it the outcome, the promotion ceiling and the ground-truth
condition. `freezeSuite` compounds it by excluding grader-written channels from the pin by
construction, so the one node the exam cannot see is the one a candidate may freely rewrite.

Do not treat this as a bug list. **Until a measurement exists whose inputs the candidate provably
cannot write, this property is aspirational**, and the audit found none in the tree. The three
defeated attempts to pin a verifier are recorded at `aabdc63`; the shape that defeated all three is
that the candidate owns both sides of any channel the graph produces. `docs/audit-2026-09-02.md`
has the reproductions.

## What follows from those, and is not negotiable

- **The journal is the only authoritative state.** Everything else is a projection you can rebuild
  by folding it. If a decision reads a value, the journal must be able to reconstruct that value —
  including across a restart. This has been violated **eight** times and each violation silently
  switched off a guard. Five are named in
  `packages/core/test/run/oversight-survives-restart.test.ts`; the sixth is
  `packages/core/test/run/escalation.test.ts` — search either file for `MEMBER`. Seven and eight
  were found by the 2026-09-02 audit and are the same shape in the same blind spot, **a delegated
  child run**: `grantBound` (the capability allowlist a parent narrows for its child) and the
  child's dollar slice both lived only as arguments to `#contextFor`, recorded in no journal the
  CHILD's own fold can read.
  **Both are CLOSED.** Each run records its own bound on its own `run.submitted`, and
  `PolicyEngine.restore` folds them one way — budgets by MIN, the allowlist by intersection.
  Driven through the shipped binary across a real `kill -9` and a second `loom serve` over the
  same SQLite journal, three levels deep: a grandchild answering its OWN gate in a process that
  never held the parent refuses `E_CAP_DENIED` and writes no file, where at `a638e7d` the same
  door wrote 20 bytes to disk; a child on a `budgetShare` of 0.0005 refuses
  `E_BUDGET_EXHAUSTED`, where at `a638e7d` it ran against the deployment's whole $1
  (`remainingUsd: 0.998955` is the tell). `test/run/lane-a-child-bounds-survive-restart.test.ts`
  is the pin.
  **Seven had a second door, and finding it is the lesson.** `restore` was called from
  `#advanceSerially` alone, so a child ATTACHED AND REWOUND without being advanced compensated
  against its own graph's list — the bound held on one verb and not the other, which is not a
  bound. `#seedPolicy` is now what both verbs call;
  `test/run/rewind-applies-the-parents-bound.test.ts` is the pin, with the control that makes it
  mean something. **Ask of every new bound: which verbs reach the guard, and does it hold on all
  of them?**
  **The enumeration is split, and a pointer to an enumeration is only as good as that
  enumeration's discipline about growing** — the sixth member landed in a file the citation did not
  name, and the cited one still said five. Seven and eight are named in
  `oversight-survives-restart.test.ts`'s header, where a reader of the other six will find them.
  **The lens that finds these:** ask of every `Map`, `Set`, class field and closure in `run/`,
  `server/` and `resources/` — what decision reads this, and what does it do when a restart hands
  it back empty? Then look where the existing tests do not: at a CHILD run.
- **Every nondeterministic call is recorded under a derived key, and replay serves the record.**
  Derived, never random: an id you cannot recompute breaks replay.
- **Oversight only tightens.** Nothing raises its own permissions. A human may lower a posture; no
  automated path may.
- **Refusing is always allowed; loosening never is.** When a guard cannot decide, it fails closed.
- **The core takes no runtime dependencies.** It is the thing that must still build and run in five
  years. Other packages may take what they need.

## Working here

- **Build the thing, then show it works.** One honest test beats a guard plus a mutation sweep plus
  a registry entry. Reach for a gate when a defect class has actually recurred, not in advance.
- **Reproduce by running, not by reading** — including when correcting a comment. A correction that
  replaces a false claim with a differently-false one is worse than the original.
- **Name the set a claim covers.** "This is total" cannot be checked; a claim that names its members
  can.
- Every module says *why it exists* at the top, not what it does.
- **Tests are offline and deterministic — no network, no API key, and no test asserts on a RATIO
  OF TWO TIMINGS.** Assertions that READ a clock are fine, and several remain: every one is an
  ABSOLUTE bound with an order-of-magnitude margin (`ms < 100`, `elapsed < 3000`). There is
  deliberately no count here — this line carried one three times and it did not reproduce three
  times, and no single grep enumerates the set. **A ratio of two timings is not more robust than
  one timing, it is less** — the noise compounds asymmetrically, so `t_big / t_small < K` is
  likeliest to pass when its denominator sample is worst. `TODO.md` §F.17 has the measurements.
- **How defects are actually found here, measured over 207 of them (`docs/audit-2026-09-02.md`).**
  Two lenses account for most: *a guard answering its undecidable case with the passing value*,
  and *a decision reading state a restart empties*. Two methods make the difference: every finding
  carries a pasted reproduction, and every finding is re-run by a fresh agent told to REFUTE it and
  to default to refuted when unsure — that pass refuted 7 of 118 outright and downgraded 17,
  including one the lead had reached independently. **A builder's own green suite is not evidence:**
  five successive builders on one guard each passed their own tests and shipped a defect the next
  reviewer found, every time because they had measured the shapes they imagined. Ask for the
  ORDINARY half of every measurement, not just the defect half.
- `/usr/bin/grep -a` always, and the path matters: this shell's `grep` is a ugrep wrapper that
  passes `-I`. Empty output is not evidence of absence. **The trigger set is NUL ∪ invalid
  UTF-8**, not non-ASCII — valid non-ASCII matches fine. **Five** tracked files carry a NUL byte
  today and none is invalid UTF-8. Do not count them with grep: a skipped file is only reported
  when it also matches your pattern, so grep undercounts and the count moves with the search
  term. Census instead — read every `git ls-files` path and test for a zero byte.
- Commits land under the human author's identity only. No assistant attribution, no co-author
  trailers, no assistant links in commit bodies or pull requests.

## Layout

```
packages/core/     the runtime. Zero runtime dependencies. src/ + test/
                   Ten of its files are the kernel; scripts/kernel.json names them and says why.
scripts/           build and the three guards that are worth their cost:
                   zero-dep, surface (the exported name set), kernel (the pinned file list)
DESIGN.md          the decisions, and the Sequence they imply — the roadmap
TODO.md            everything unfinished, self-contained
docs/              dated records: audit findings and backlog re-checks, with reproductions
                   START HERE: `handoff-2026-09-03.md`, then `audit-2026-09-02.md`
.agent/<task>/     per-task working state (gitignored)
```

**The three phase-2-4 branches are MERGED into `loom`** — `phase2-4-engine`, `phase2-4-plane`
and `phase2-4-subsystems` went in with zero conflicts, as predicted. `phase1-taint` is still
unmerged and parked: RC-6 is a design change, not a patch, and the design comes before the code
(see the handoff §5).

## Commands

```bash
npm run check       # typecheck + tests + guards. The gate.
npm test            # tests only
npm run build:binary                            # a single-file binary
npx tsc -p packages/core/tsconfig.test.json     # read-only typecheck, safe under concurrency
node --test packages/core/test/<file>           # one suite
```

If several agents or shells are working at once, do not run `npm run check` or a bare `tsc -b` —
concurrent builds race on emit. Use the read-only typecheck.

## Toolchain facts that shape the code

- **Node 24 with native type stripping.** Tests run `.ts` directly; there is no build step for
  tests. It cannot strip `.tsx` — it does not parse JSX at all.
- **Import specifiers say `.ts`**, and are rewritten on emit. Do not write `.js` in source.
- **No `enum`, no `namespace`, no parameter properties** — `erasableSyntaxOnly` is on. Use `const`
  objects and union types.
- **`node:sqlite` is the durable store**, so the zero-dependency rule holds.
- **`node:vm` is not a sandbox.** It is scoping. Untrusted code needs a process boundary.
