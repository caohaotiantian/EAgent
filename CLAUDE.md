# CLAUDE.md

Orientation for whoever works on this next. **The code is the source of truth**: where this file
disagrees with it, fix this file.

Keep it short. Everything here is either the goal, a principle, or a fact you need in the first five
minutes. Work items live in `TODO.md`; the roadmap is `DESIGN.md`'s Sequence; decisions live in the
commit history and in `docs/`.

## The goal

**A multi-agent runtime someone can actually use.** Install it, describe what they want done, have
it run against a real provider, watch it, stop it, and trust what it did.

That is the bar. A correct mechanism nobody has used is not a product, and this project has
repeatedly mistaken the first for the second. **The next real workflow somebody ports is worth more
than the next invariant somebody proves.** One is ported:
`examples/graphs/triage-failures.json` — eight nodes over four node types, three `function` bodies
and an input directory, run end to end against the shipped binary with no fork, no
`--extension-module` and **zero changes under `packages/core/src`** (`f24bcb7`, `77da881`,
`422a730`); `docs/workflow-port-2026-09-09.md` is the commands a stranger runs and the eight things
the product cost them.

**Running it needed no source change; making it NATURAL needed seven, and THAT is the number worth
carrying.** The port logged eight friction entries and seven are now closed — F6 in the port lane
itself, then F2, F3, F4, F5, F7 and F8 in the 2026-09-10 wave. **F1 is the one still open.** More
than the count: the workflow now CONSUMES what those closures built rather than merely no longer
suffering it — `triage-classify.js` reads `raw` as a plain `replace` string (F2, `77c245a`),
`triage-plan.js` reads its fan-out width off `ctx.node` and refuses on purpose through `{refuse}`
(`c2360be`, `f7f74d5`, `b181b55`), and its suite parses the whole of stdout and reads the approver's
report out of `loom gates` (F4, F3). **The port is what pulled on them**, which is the argument for
porting one at all: an invariant nobody exercises names no seam.

## The three properties, in priority order — where a change trades one away, it is wrong

### 1 · Kernel stability

The core is small and stays small under pressure — a surface you can hold in your head for years.
**A change that adds capability should not touch the kernel.** If it must, the kernel is missing a
seam and the seam is the thing to design; a kernel with a feature per use case is undependable.

**The kernel is a named list of ten files**, in `scripts/kernel.json`, each with a written reason —
the criterion is *this file is the mechanism that makes one of the non-negotiables below true, and
an extension must depend on it and cannot replace it*. `scripts/check-kernel.mjs` runs the test: a
`feat` commit touching one fails unless it carries a `Kernel-seam:` trailer naming the missing seam.
`fix` may touch the kernel freely — fixing it is what a kernel is for. That trailer is the escape
hatch and also the ledger; **read the ledger from `node scripts/check-kernel.mjs`, nowhere else.**

**The REQUIREMENT and the CENSUS are two rules, and they differ in two places.** The requirement is
`feat:`-only; the census counts every subject, merges included. They share ONE definition of a
trailer — `seamTrailer()`: a `Kernel-seam:` line in the message's own FINAL PARAGRAPH, with
flush-left continuation lines allowed, which git's `interpret-trailers --parse` rejects and which
five of the sixteen declared seams are written as. Where they still differ is what "touched the
kernel" means for a MERGE: the requirement reads the commit's own diff (`git show --name-only` —
empty for a clean merge, the resolution's own changes for an evil one), the census reads its
effective diff (`-m`, one per parent). So a clean merge cannot violate, its branch having been read
already, while a trailer it carries still reaches the ledger. `git log --grep='^Kernel-seam:'` and
git's own trailer parser each give a different number from the guard's, and none of the three is
wrong.

**Watch the ledger in the diff anyway — the guard cannot see** capability landed under `fix:` or
`refactor:`, a squash-merge collapsing a `feat` into another subject, capability added outside the
pinned list, or a rename git cannot detect. `fix:` fires most often, because new journal vocabulary
is capability whatever the subject says — and `check-surface.mjs` pins the exported NAME SET only,
which is the gap `check-kernel.mjs` covers.

### 2 · Unlimited extensibility

Everything that is not the kernel is an extension, and extensions can reach everywhere the kernel
can. No privileged built-ins: the things that ship in the box are written against the same surface a
stranger would use. If a built-in needs a back door, the surface is wrong.

The test is not "can you add a tool". It is **"can somebody who does not have commit access build
the thing they need, and can they do it without forking?"** The answer is a named set, living in
`README.md`'s "Extending it, and where that stops" — counted from README, never carried:

```bash
sed -n '/^## Extending it, and where that stops$/,/^## Why this exists$/p' README.md \
  | /usr/bin/grep -a -c '^| '     # → 18: a header row and SEVENTEEN things that need no fork
sed -n '/^## Extending it, and where that stops$/,/^## Why this exists$/p' README.md \
  | /usr/bin/grep -a -c '^- \*\*' # → 3: the schema sets that DO need one
```

The three needing a fork are a node type, a reducer and a ninth hook point, each quoted from the
binary's refusal and closed for ONE reason — replay: a fold can only reproduce a decision whose
vocabulary the folding binary knows. **Shrinking that list is what this property means; it moving
the other way is the alarm.**

**The trust argument bounding `--extension-module` is the constraint, not a footnote:** the module
path comes from ARGV and nowhere else (`loadExtensionModules`), because a path read out of a file
would let a FILE decide who may approve, in a process holding `fs:write`. If it ever loads from
anywhere but argv, the seam has to move behind a process boundary first.

**No privileged built-ins remain.** A module is handed `{channels, functions, hooks, identity, jail,
models, payloads, resolver, store, tools}` carrying the operator's own jail; registering a built-in
tool name refuses at boot rather than shadowing silently; and `ToolRegistry.reservePrefix` holds
`mcp__` at the door as a capability, refusing a prefix that overlaps one already reserved and
freezing every `ToolDefinition` field at registration (`eee63b9`, §A0.27). Residue, on no row:
`reservePrefix("")` as the FIRST call on a fresh registry still claims the whole namespace, and
`parameters` is shallow-frozen only.

### 3 · Endless self-improvement

The system observes its own runs, and what it learns changes what it does next. Every run leaves
enough evidence to be judged, replayed, and improved on. This is the property most easily faked:
capturing trajectories is not improvement, and neither is scoring them. **Improvement is when a
later run is measurably better because of an earlier one**, measured in a way the thing being
measured cannot game.

**It WAS faked, and the mechanism was one sentence:** `extractSignals` read S1, which the whole
ladder rested on, out of the CANDIDATE'S OWN graph, so a candidate owned its own outcome, promotion
ceiling and ground-truth condition (`docs/audit-2026-09-02.md`). Three earlier attempts to pin a
verifier are at `aabdc63`; each fell to the same shape — a candidate owns both sides of any channel
its graph produces.

**The answer is an operator-attested exam — a grader outside every candidate graph, run by the
runtime** — designed in `docs/design-property3-2026-09-05.md`, merged at `ec2ad88`. An exam is an
ordinary `GraphSpec` that `loom exam attest <exam.json> --cohort <id> --as <who>` attests;
`examples/exams/review-bench-exam.json` is the one this workspace ships.

**That is not "property 3 holds". It holds under five assumptions, and they are the claim:**

- **One operator.** `--as` is an argv string written into a row with `actor.kind: "human"` by
  construction. Whoever runs the binary owns the exam, and also writes `graphs/` and `resources/`.
- **An exam that reads the run's answer — enforced by NAME only.** `attestationProblems` refuses an
  exam reading no baseline output, and `examShape`'s fifth rule one that declares an input and
  names it nowhere; both check NAMES, so an exam naming the channel in `reads` and ignoring it
  still attests. Closing that is a dataflow analysis from each declared input to the terminal node.
- **The exam-gated doors are `promote --against-cohort` and `suite freeze`.** `promote --suite`
  still decides on the frozen suite and `12-grader-unchanged`, not on the exam.
- **No `subgraph` child grader.** `evaluatorsOf` walks the parent spec's nodes, so an evaluator
  frozen into `RunGraph.subgraphs` is invisible to check 12.
- **The 60/40 split accepted.** The exam owns the 60% outcome term only, so a cheaper worse
  candidate can still win on the other 40%.

**And the exam's quality is the operator's**, which no mechanism supplies; what the implementation
forced on the design, and the residue it left, are dated at that doc's top.

## What follows from those, and is not negotiable

- **The journal is the only authoritative state.** Everything else is a projection you rebuild by
  folding it. If a decision reads a value, the journal must reconstruct that value across a restart.
  Violated nine times, each silently switching off a guard. **All nine are enumerated in the header
  of `packages/core/test/run/oversight-survives-restart.test.ts`** — five are pinned by tests there,
  member six is `packages/core/test/run/escalation.test.ts`, seven to nine name their own pins. Add
  the next to that header. **Two lessons they paid for.** (a) Journaling the value is not enough —
  nine's state IS durable and the hole was a crash window between transactions, and seven held on
  `advance` but not `rewind` until `#seedPolicy` became what both call: **ask which verbs reach the
  guard, and whether it holds on all of them.** (b) A guard failing CLOSED on an empty restart is
  not a member. **The lens that finds these:** of every `Map`, `Set`, class field and closure in
  `run/`, `server/` and `resources/`, ask what reads it and what that does on a restart that hands
  it back empty — then look where the existing tests do not, at a CHILD run.
- **Every nondeterministic call is recorded under a derived key, and replay serves the record.**
  Derived, never random: an id you cannot recompute breaks replay.
- **Oversight only tightens.** Nothing raises its own permissions. A human may lower a posture; no
  automated path may.
- **Refusing is always allowed; loosening never is.** When a guard cannot decide, it fails closed.
- **The core takes no runtime dependencies.** It is the thing that must still build and run in five
  years. Other packages may take what they need.

## Working here

- **Build the thing, then show it works.** One honest test beats a guard plus a mutation sweep plus
  a registry entry. Reach for a gate when a defect class has recurred, not in advance.
- **Reproduce by running, not by reading**, including when correcting a comment: a correction that
  replaces a false claim with a differently-false one is worse than the original.
- **Name the set a claim covers.** "This is total" cannot be checked; a claim naming its members
  can.
- Every module says *why it exists* at the top, not what it does.
- **Tests are offline and deterministic — no network, no API key, and no test asserts on a RATIO OF
  TWO TIMINGS.** Assertions that READ a clock are fine; every one is an ABSOLUTE bound with an
  order-of-magnitude margin (`ms < 100`, `elapsed < 3000`). A ratio is less robust than one timing,
  not more: the noise compounds asymmetrically, so `t_big / t_small < K` is likeliest to pass when
  its denominator sample is worst (`TODO.md` §F.17).
- **How defects are actually found here** (`docs/audit-2026-09-02.md`, over 207 of them). Two lenses
  account for most: *a guard answering its undecidable case with the passing value*, and *a decision
  reading state a restart empties*. Two methods make the difference: every finding carries a pasted
  reproduction, and each is re-run by a fresh agent told to REFUTE it and default to refuted when
  unsure. **A builder's own green suite is not evidence** — five builders on one guard each passed
  their own tests and shipped a defect the next reviewer found. Ask for the ORDINARY half.
- `/usr/bin/grep -a` always — this shell's `grep` is a ugrep wrapper that passes `-I`, so empty
  output is not evidence of absence. **The trigger set is NUL ∪ invalid UTF-8**, not non-ASCII, and
  grep cannot count the affected files (a skipped file is reported only when it also matches your
  pattern). Census instead: read every `git ls-files` path and test for a zero byte.
- Commits land under the human author's identity only. No assistant attribution, no co-author
  trailers, no assistant links in commit bodies or pull requests.

## Layout

```
packages/core/     the runtime. Zero runtime dependencies. src/ + test/. Ten files are the kernel.
scripts/           build, and the three guards: zero-dep, surface (the exported name set),
                   kernel (the pinned file list, scripts/kernel.json)
DESIGN.md          the decisions, and the Sequence they imply — the roadmap
TODO.md            everything unfinished, self-contained
docs/              dated records w/ repros. START: handoff-2026-09-10.md, audit-2026-09-02.md
.agent/<task>/     per-task working state (gitignored)
```

Every branch through the 2026-09-10 wave is merged into `loom`; the handoff says what each lane
did and left open.

## Commands

```bash
npm run check       # typecheck + tests + guards. The gate.
npm test            # tests only
npm run build:binary                            # a single-file binary
npx tsc -p packages/core/tsconfig.test.json     # read-only typecheck, safe under concurrency
node --test packages/core/test/<file>           # one suite
```

With several agents or shells at once, do not run `npm run check` or a bare `tsc -b`: concurrent
builds race on emit. Use the read-only typecheck.

## Toolchain facts that shape the code

- **Node 24 with native type stripping.** Tests run `.ts` directly, with no build step. It cannot
  strip `.tsx` — it does not parse JSX at all.
- **Import specifiers say `.ts`**, and are rewritten on emit. Do not write `.js` in source.
- **No `enum`, no `namespace`, no parameter properties** — `erasableSyntaxOnly` is on. Use `const`
  objects and union types.
- **`node:sqlite` is the durable store**, so the zero-dependency rule holds.
- **`node:vm` is not a sandbox.** It is scoping. Untrusted code needs a process boundary.
