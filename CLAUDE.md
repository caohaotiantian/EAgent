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

**That ledger WAS resettable three ways — measured 2026-09-02 — and `wave2-guards` (`3656d69`)
closed all three.** Re-measured on `loom` rather than carried. **The `since` block below is from an
earlier HEAD** — reproducing it means editing `scripts/kernel.json`, so it is not re-driven on every
correction; what `node scripts/check-kernel.mjs` prints at `dcf54c9` is
`10 files pinned, 575 commits judged since 86b84c9, 12 declared seams over the full history`,
followed by the same grandfathering notice, now against `86b84c9` and still `36`:

- **Advancing `since` no longer erases the census.** It printed `0 declared seams` and exited 0 in
  September's measurement. Driven again, moving `since` forward one commit and re-running:

  ```
  since 86b84c9 → kernel guard ok: 10 files pinned, 478 commits judged since 86b84c9, 11 declared seams over the full history
  since b79e2d0 → kernel guard ok: 10 files pinned, 477 commits judged since b79e2d0, 11 declared seams over the full history
                  notice: 36 feat commit(s) touched the kernel before `since` (b79e2d0) and declared
                  no seam. Grandfathered, not paid — advancing `since` grows this number.
  ```
- **`Feat:`/`FEAT:`/`feature:` are classified as features.** The classifier is
  `const FEAT = /^[ \t]*feat(?:ure)?(\([^)]*\))?!?:/i`; run against seven subjects, all of
  `feat(run):`, `Feat:`, `FEAT:`, `feature:`, `feat!:` are true and `fix(run):` / `refactor:` are
  false.
- **A `refactor:` rename no longer drops a file's seams**, because the path set is the union of
  every name `git log --follow --full-history` gives each pinned file, and the PIN's own history is
  followed the same way. Read from `check-kernel.mjs`, not driven here — the other two are.
- **A one-character trailer is now a violation**, under `MIN_SEAM_CHARS`.

**Watch the number in the diff anyway**, for the reason the guard's own header gives rather than
the one this line used to give: it cannot catch a capability landed under `fix:` or `refactor:`, a
squash-merge that collapses a `feat` into another subject type, capability added OUTSIDE the pinned
list, or a rename git cannot detect. The convention IS the signal.

Read it from the guard and nowhere else, and know what the guard leaves out. **The requirement
and the census are two different rules and the split is the thing to hold on to.** The REQUIREMENT
is `feat:`-only and unchanged. The CENSUS counts two kinds of row on a commit touching a pinned
path: a `feat:` subject's trailer, found by the same loose body regex the requirement uses; and —
since `706b88a` — a trailer that `git interpret-trailers --parse` recognises in the FINAL
PARAGRAPH of any OTHER subject, merges included. `judge()` in `check-kernel.mjs` is those two arms
and nothing else. Counted today on `dcf54c9`, three commands and three answers:

```
node scripts/check-kernel.mjs | head -1                    → 12 declared seams over the full history
git log --grep='^Kernel-seam:' --oneline | wc -l           → 13
git log --format='%h@@%s@@%(trailers:key=Kernel-seam,valueonly)' | awk -F'@@' '$3!=""' | wc -l → 7
```

The differences are not noise and each names a real limit. **The grep's one extra row over the
guard is `2a9eda8`**, a `docs:` commit whose PROSE quotes the trailer, declares nothing, and
touches only `TODO.md` — it is excluded because it touches no pinned path, not because of the
final-paragraph rule. **`fbbdac4` — the `merge: phase1-taint` commit, naming three journal words
— IS counted now**, and it is the ledger's first row; it reached `loom` inside `02a5e84`, which is
why the two shas name one arrival. **The five the guard counts and git's own parser does not are
`b28c343 3762a0e 97a53a1 d0ca421 dcdb3f1`** — all `feat:` subjects whose trailer sits mid-body, so
the requirement path's loose regex (`const FEAT = …`, `check-kernel.mjs:462`) sees them and
`interpret-trailers` does not. The two paths disagree about what a declaration is, which is
`TODO.md` §A0.26 along with the sharper gap: **a CLEAN merge carrying a trailer is still
invisible**, because the guard filters on touched paths and git prints none for one — driven,
`git show --name-only --format='' 878001c` prints nothing where the same command on `fbbdac4`
prints seven files. So "the census counts merges" is true only of conflict-resolving ones.
No number here is wrong; the ledger a reviewer watches in the diff is the one that has to know
which of the three it is reading. `check-kernel.mjs`'s failure text used to recommend the grep and
no longer does — that correction is paid.

**The limit that fires most often is `fix:`, and the phase-2-4 merge is the worked example.** Five
pinned files changed on it and the ledger recorded nothing, correctly by the rules: every commit
was a `fix`. But `journal/events.ts` gained three new durable payload fields —
`run.submitted.limits`, `run.submitted.capabilities`, `run.compiled.postures` — and new journal
vocabulary is capability, whatever the subject line says. The seams were genuinely fixes (they
close journal violations seven and eight) and the vocabulary was genuinely new. Both are true, and
only a reader comparing the two notices.

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
and where that stops"** — the same escape-hatch-and-ledger shape as §1's kernel list. **Counted on
`loom` today rather than carried:**

```bash
sed -n '/^## Extending it, and where that stops$/,/^## Why this exists$/p' README.md \
  | /usr/bin/grep -a -c '^| '     # → 18: a header row and SEVENTEEN things that need no fork
sed -n '/^## Extending it, and where that stops$/,/^## Why this exists$/p' README.md \
  | /usr/bin/grep -a -c '^- \*\*' # → 3: the schema sets that DO need one
```

The three are a node type, a reducer, a ninth hook point, and each of THOSE three is quoted from
the refusal the binary actually prints — that is README's own promise and it is scoped to the fork
list. It does not hold of the other list: 8 of the 17 no-fork rows quote a binary refusal and the
other 9 cite a test, a section of `examples/README.md`, or the row above them. All three are closed for ONE reason, replay: a fold
can only reproduce a decision whose vocabulary the folding binary already knows. **Shrinking that
second list is what this property means in practice; the list moving the other way is the alarm.**
It went six → seven, then to five when `--extension-module` gave the CLI the door onto
`ModelRegistry` and `ToolRegistry` a library embedder always had, then to **three** on 2026-09-01
when the same flag's object widened to `{models, tools, channels, identity}` — deleting two rows
that were forks *from the CLI only* and were therefore never bounds, only debts. The trust argument
that bounds the widening is stated at `loadExtensionModules`: the module path comes from ARGV and
nowhere else, because a path read out of a file would let a FILE decide who may approve. That
argument is what a future widening has to re-earn; if the module path ever becomes loadable from
anywhere but argv, the seam has to move behind a process boundary first.

**The FIRST number moved too, twelve → seventeen, and that is a debt paid rather than a bound
moving.** The 2026-09-02 audit found five more `EngineOptions` members — `functions`
(`FunctionRegistry`), `hooks` (`HookRegistry`), `resolver` (`ResourceResolver`), `store`
(`StateStore`), `payloads` (`PayloadStore`) — whose types were all already on `scripts/surface.json`
and which a library embedder reached while argv reached none. All five are argv rows now. Driven
today through `./bin/loom` on the sharpest of them, the one the audit named as the measured
consequence: a module calling `functions.register("function/stamp@stable", async () => …)` with a
host-realm `new Date(0)` and an `await` runs from the CLI —

```
loom run g.json --workspace WS --extension-module ext.mjs
→ "status": "succeeded",  "outputs": { "note": "stamped at epoch 0" }     exit 0
```

and the registrar the module is handed prints its own key set:
`channels,functions,hooks,identity,jail,models,payloads,resolver,store,tools`.

**Both privileged built-ins are gone, and the collision one was driven today.** `builtinTools`
still registers AFTER the extension modules and `ToolRegistry.register` still shadows on collision
— so instead of letting the extension's tool be registered and never dispatched, the boot refuses:

```
loom run graphs/g.json --workspace WS --extension-module shadow.mjs   # shadow.mjs registers "fs.read"
E_CONFIG_INVALID: --extension-module …/shadow.mjs registers the tool name "fs.read", which is a
built-in of this binary. The built-ins are registered after the modules and ToolRegistry shadows
on collision, so the extension's definition would be registered, would hold its capability, and
would never be dispatched. Rename it — the built-in names are: fs.edit, fs.glob, fs.grep, fs.read,
fs.restore, fs.write.                                                                     exit 1
```

The second was the registrar carrying no jail, so an outsider's filesystem or network tool could
not apply the operator's own guards. It carries one now: the `jail` key above is present, and it
holds whichever of `root`, `deny`, `egressAllowlist`, `execAllowlist`, `execEnvAllow` the operator
set — `["deny","egressAllowlist","execAllowlist","root"]` under `--egress example.com --allow-exec
echo`, `["deny","execAllowlist","execEnvAllow","root"]` under `--allow-exec echo --exec-env FOO`.

**And the reservation an outsider cannot take is now held at the door rather than by a scan.**
`ToolRegistry.reservePrefix(prefix, reservedFor)` (`run/registry.ts`) returns a capability object
whose `register` is the only one exempt, and `#doRegister` checks every reserved prefix on every
call — so the `mcp__` namespace holds against a registration made from a timer, from a library
embedder, or after `seal()`, where the boot scan it replaced caught only what existed the instant
it ran. It is a capability and not a flag for the reason the property itself demands: anything
holding the registry already executes code in this process, so a `{reserved:true}` argument or a
public "register as MCP" method would be exactly as reachable by an impostor as by the CLI. Driven
today through `./bin/loom` on an extension module that registers `mcp__docs__search`:

```
loom run graphs/g.json --workspace . --extension-module ./squat.mjs
E_CONFIG_INVALID: --extension-module …/squat.mjs: threw while registering: tool name
"mcp__docs__search" uses the "mcp__" prefix, which is reserved for the --mcp-file registrar:
every id of the form mcp__<server>__<tool> is registered by this binary from a server an
operator named, carries the capability mcp:<server>, and is irreversible unless that server's
row says otherwise. … Rename it.                                                          exit 1
```

and the ordinary half, the same module with the name `house.ping`, registers and the boot walks on
past the registrar to the graph. What this does NOT yet cover is `TODO.md` §A0.27: an overlapping
prefix, and every `ToolDefinition` field except `name` still being read live off the caller.

### 3 · Endless self-improvement

The system observes its own runs, and what it learns changes what it does next. Every run leaves
enough evidence to be judged, replayed, and improved on.

This is the property most easily faked. Capturing trajectories is not improvement; scoring them is
not improvement. **Improvement is when a later run is measurably better because of an earlier one**,
and the measurement has to be one that cannot be gamed by the thing being measured.

**It WAS faked, and the mechanism was one sentence.** The whole ladder rested on S1, and
`extractSignals` read S1 out of the CANDIDATE'S OWN graph — any `evaluator` step whose commit
carried `{pass:true}` and made no model call. **A candidate owns its graph, so it owned S1**, and
with it the outcome, the promotion ceiling and the ground-truth condition. Driven end to end
through the shipped verbs on 2026-09-02: a candidate that DELETES the work node and returns
`{pass:true}` promoted through `loom promote --against-cohort` at paired mean Δscore **+0.4000 over
30 pairs**; a candidate whose only change was swapping its own grader promoted through
`loom promote --suite` with **all thirteen** checks green — thirteen was that day's count, and the
binary's help says fifteen now. `docs/audit-2026-09-02.md` has the reproductions. Three earlier attempts to pin a verifier are recorded at `aabdc63`, and the shape
that defeated all three is that the candidate owns both sides of any channel the graph produces.

**The answer is an operator-attested exam — a grader outside every candidate graph, run by the
runtime** — designed in `docs/design-property3-2026-09-05.md` and merged at `ec2ad88`. **Verified on
`loom` at `ce9e7b4` on 2026-09-08 by a fresh agent that had not read the implementing lane's
report**, given only design §6 and a binary built from this tree. **The fixture is not in the tree
and the block below is not copy-pasteable**: `pick-bench` is built by hand in a scratch workspace
from the shapes design §6 lists, which is what §6 asks for. The shipped workspace exam is
`examples/exams/review-bench-exam.json` — `loom compile examples/exams/review-bench-exam.json
--workspace examples` → `ok` — and it grades `review-bench`, not this. On the §6 fixture (30
recordings; `pick` is wrong on even-length inputs), after `loom exam attest exams/pick-exam.json
--cohort <last> --as haotian --workspace WS` → exit 0:

```
promote candidates/noop.json   --against-cohort   ✗ L1-paired-improvement Δ -0.2000 (sd 0.2877, n 30) 0W/10L/20T
   (deletes the work node, returns {pass:true})   ✗ L5-candidate-earned-it "scored 0 on every input"   exit 1
promote candidates/rigged.json --against-cohort   ✗ L1-paired-improvement Δ  0.0000 (sd 0.0000, n 30) 0W/0L/30T
   (swaps its own grader for {pass:true})         ✓ L5 "scored above 0 on 10 of 30 input(s)"           exit 1
promote candidates/fixed.json  --against-cohort   ✓ L1-paired-improvement Δ +0.4000 (sd 0.2877, n 30) 20W/0L/10T
   (the HONEST candidate — the ordinary half)     t 0.3108, Wilcoxon 0.3000, ✓ L5 30/30, promote true  exit 0

exam attest exams/blind-exam.json   (inputs [subject, items] only, always-pass body)
  E_CONFIG_INVALID: … the exam reads no baseline OUTPUT (baseline outputs ["picked","verdict"]) —
  an exam over inputs alone sees the question and never the run's answer, so it measures nothing
  about the run it grades                                                                        exit 1
exam attest exams/pick-exam.json   (the honest exam, same workspace, straight after — the control) exit 0
```

Both audit reproductions refuse AT THE `--against-cohort` DOOR, which is the one driven above, and
the honest candidate promotes at the same Δ that used to certify the fake. Reproduction 2's own
door, `promote --suite`, refuses the grader swap by `12-grader-unchanged` rather than by the exam —
that is the lane's measurement and was NOT re-driven here. The one line that says the property is working: `rigged.json`'s grader returns
`{pass:true}` on all thirty and the candidate still scored above 0 on ten — the exam's answer, not
the graph's.

**That is not "property 3 holds". It holds under five assumptions, and they are the claim, not a
footnote:**

- **One operator.** `loom exam attest` is a verb; `--as` is an argv string written into a row with
  `actor.kind: "human"` by construction. Whoever can run the binary owns the exam, and also writes
  `graphs/` and `resources/`.
- **An exam that reads the run's answer — enforced by NAME only.** An exam declaring no baseline
  output is refused (above), and since the `exam-reads` merge a fifth `examShape` rule refuses one
  that DECLARES the answer and names it nowhere. Driven on the binary built at `8c86559`, a
  `pick-bench` workspace of six recordings:

  ```
  exam attest exams/unread-exam.json  (inputs [subject, items, picked]; `grade` reads ["items"])
    E_CONFIG_INVALID: unread-exam.json is not an exam: exam input(s) "picked" are declared as
    inputs and named in no node's `reads`, no `${…}` in a node's tool args, and no fanout edge's
    `over` — the three places this rule counts — add the channel to the `reads` of the node that
    grades it, or stop declaring it.                                                        exit 1
  exam attest exams/pick-exam.json           (the same exam, `picked` in `grade`'s reads) exit 0
  exam attest examples/exams/review-bench-exam.json                                        exit 0
    (the shipped exam, against three review-bench recordings taken from a local stub adapter —
     attested sha256:83de18ae…, corpusThrough the third run)
  ```

  **The gap that remains, and it is the whole of what "by NAME" concedes: the rule checks NAMES,
  so an exam that names the channel in `reads` and ignores it still attests.** Driven in the same
  workspace: `exams/names-only.json` is `pick-exam` with `picked` still in `grade`'s `reads` and a
  body `() => ({writes:{verdict:{pass:true,…,detail:"never looked"}}})` — attested exit 0,
  `sha256:8404a420…`, replacing the honest ruler. Closing it is a dataflow analysis from each
  declared input to the terminal node, not a fifth rule.
- **The exam-gated doors are `promote --against-cohort` and `suite freeze`.** `promote --suite`
  still decides on the frozen suite and `12-grader-unchanged`, not on the exam.
- **No `subgraph` child grader.** `evaluatorsOf` walks the parent spec's nodes, so an evaluator
  frozen into `RunGraph.subgraphs` is invisible to check 12.
- **The 60/40 split accepted.** The exam owns the 60% outcome term only, so a cheaper worse
  candidate can still win on the other 40%. Not driven above — the fixture's runs are $0 and 0 ms,
  which is also why every pair count there is exact.

**And the exam's quality is the operator's**, which no mechanism can supply. The corrections the
implementation forced on the design, and the residue it left, are dated at the top of
`docs/design-property3-2026-09-05.md`.

## What follows from those, and is not negotiable

- **The journal is the only authoritative state.** Everything else is a projection you can rebuild
  by folding it. If a decision reads a value, the journal must be able to reconstruct that value —
  including across a restart. This has been violated **nine** times and each violation silently
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
  **MEMBER NINE arrived on `loom` with the taint lane (`02a5e84`), and it is the first whose state
  IS journaled** — which is why "which verbs reach this guard" is the question and "is this value
  journaled" is not. The state is the E12 `fanout_skipped_gate` escalation, raised by
  `Engine.#fireEmptyJoin` when a fan-out of width zero passes over a `human_gate` on its branch;
  the decision that reads it is the join's gate. `policy.escalated` is durable, so an ordinary
  restart folds it — but `#escalate` appends in its OWN transaction, pushing onto
  `ctx.escalationWrites` drained after `#runWave`, while the join's `task.ready` commits INSIDE the
  wave. A crash in that window is what the restart empties: the join comes back scheduled and
  undecided with no escalation anywhere, and the second process wrote where the first would have
  gated. `#escalateSkippedGate` is now called from `#restoreEvidence` off `fanout.planned`
  (durable, carries the width, appended after the planner's own `task.committed`), and
  `PolicyEngine.escalate` is idempotent so a run whose append survived appends nothing.
  `test/run/empty-fanout-oversight.test.ts`'s "THE SKIPPED GATE IS RE-DERIVED WHEN THE ESCALATION
  APPEND WAS LOST" is the pin, with the clean-width control beside it; `d3d9670` is the fix.
  **The enumeration is split, and a pointer to an enumeration is only as good as that
  enumeration's discipline about growing** — the sixth member landed in a file the citation did not
  name, and the cited one still said five. Seven, eight and nine are named in
  `oversight-survives-restart.test.ts`'s header, where a reader of the other six will find them.
  **The four 2026-09-08 wave-2 merges added no member, and that was checked rather than assumed;
  the ninth came later, on the taint merge.** `git diff 8d43127..ce9e7b4 --
  packages/core/src/journal/events.ts` prints NOTHING: no new event kind and no new durable payload
  field across all four, which is why property 3's attestation rides on the
  `operator.command{kind, args}` vocabulary that already existed. `git diff ce9e7b4..dcf54c9` over
  the same file is where the taint merge's three new words are.
  **The seven-lane 2026-09-08-night wave added no member either, checked the same way.**
  `git diff c54b0c2..dcf54c9 -- packages/core/src/journal/events.ts` prints NOTHING across all
  thirty-five commits — and the lens still has to be applied by hand, because that diff would also
  be empty for a defect like `TODO.md` §A0.24, where `gates.ts` keeps an in-memory idempotency
  entry after a failed commit. That one is not a member for the reason the next paragraph gives
  about the broker: it fails CLOSED and a restart clears it. The
  nearest candidate short of a member is recorded and is deliberately NOT one — `wave2-engine`'s
  residue 1:
  `#resolveOnce`'s seen-key map and the broker's idempotency map are in memory, so a repeat
  redelivery of an identical decision answers 200 in the deciding process and 409 after a restart.
  Right shape, wrong outcome for this list — it fails CLOSED, nothing runs twice, and the journal
  is identical either way, so no guard was silently switched off. Closing it means journaling
  idempotency keys, which is new vocabulary, a kernel `feat`, and a seam argument.
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
                   START HERE: `handoff-2026-09-09.md`, then `audit-2026-09-02.md`
.agent/<task>/     per-task working state (gitignored)
```

**The three phase-2-4 branches are MERGED into `loom`** — `phase2-4-engine`, `phase2-4-plane`
and `phase2-4-subsystems` went in with zero conflicts, as predicted — **and so are the five
wave-1 lanes (`294e713`) and now ALL SIX wave-2 lanes**: `wave2-taint` (`9b45c7c`), `wave2-gates`
(`8d43127`), and on 2026-09-08 `wave2-graph` (`3cfd363`), `wave2-engine` (`6b3513b`),
`wave2-guards` (`3656d69`) and `wave2-exam` (`ec2ad88`), each after its stopped review round was
finished — the decisions, including the three caps raised 3 → 4 and the one blocking finding merged
knowingly as `TODO.md` §A0.21, are in `.agent/wave2-review-2026-09-08/plan.md` (this checkout only
— `.agent/` is gitignored; `TODO.md` §A0.21 is the tracked half). `phase1-taint`
**is MERGED too — it arrived on `loom` at `02a5e84` on 2026-09-08**, on the recommendation of
`docs/design-taint-rc6-2026-09-05.md` — which measured that RC-6 is not a scope defect and asked
for the merge to carry a `Kernel-seam:` trailer. The design predicted three conflict hunks; `loom`
had moved and there were **six**, in three files. The merge commit that resolved them is
`fbbdac4`, one commit inside the lane rather than `02a5e84` itself, and it is `fbbdac4` that carries
the `Kernel-seam:` trailer — `git log -1 --format=%B fbbdac4`. That trailer names the three journal words the branch added: `run.submitted.taintedInputs` — "the
journal could not say which inputs a delegation handed over already untrusted";
`task.committed.takeSuppliedByProducer` — "It could not say WHO chose a `take`"; and "the
`fanout_skipped_gate` escalation rule, E12" — "it had no word for the oversight a fan-out of width
zero passes over".

**Seven more lanes merged on 2026-09-09** — the 2026-09-08-night wave, `c54b0c2..dcf54c9`, 35
commits and zero conflicts: `engine-cross-run` (`5fe7614`), `plane-inputs` (`86193e3`), `node-id`
(`878001c`), `flake` (`4bc3ce1`), `seam-ledger` (`706b88a`), `mcp-seal` (`9cf88b5`) and
`usage-floor` (`dcf54c9`). Every commit is `fix:` or `test:`, and no seam was declared.
`docs/handoff-2026-09-09.md` is what each did, what it left open, and the decisions the
orchestrator took without the user.

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
