# Handoff — 2026-09-08 evening, nine branches merged in two rounds

Supersedes the 2026-09-08 morning handoff in full (deleted 2026-09-09). It was written at `8d43127`, when four
wave-2 branches were stopped mid-review and `phase1-taint` was parked; all of that is closed.
Its §§1, 4, 5, 6, 8 and 10 were snapshots this document replaced; its §9 is carried into §7 below.

**`loom` is at `af95630`. `npm run check` exits 0. There are no wave worktrees left and no unmerged
lane branches.** Every number in §1 is a command I ran on `af95630` today. Every number in §2 is
quoted from a lane's own report under `.agent/wave-2026-09-05/lanes/<lane>/` (gitignored, this
checkout only) or from a merge commit body; §3 is quoted from
`.agent/wave2-review-2026-09-08/plan.md` (likewise gitignored).

---

## 1 · The state, in one table

| fact | value | command |
|---|---|---|
| the gate | **exit 0** | `npm run check` |
| tests | **3,564 pass / 0 fail** (suites 0, cancelled 0, skipped 0, todo 0) | `npm test` (inside the gate) |
| pinned exports | **540**, unchanged | `node scripts/check-surface.mjs` |
| kernel | 10 files pinned, **539 commits judged since `86b84c9`, 11 declared seams over the full history**; notice: 36 pre-`since` feat commits grandfathered | `node scripts/check-kernel.mjs` |
| zero runtime deps | ok, **65 files scanned** | `node scripts/check-zero-dep.mjs` |
| NUL census | **5** tracked files carry a NUL byte, **0** invalid UTF-8, of **455** tracked | read every `git ls-files` path, `Buffer.includes(0)` and a `new TextDecoder("utf-8",{fatal:true})` decode |
| worktrees | **2**: `EAgent` (`loom`, `af95630`) and `eagent-ref` (`init`, `086e47d`) | `git worktree list` |
| working tree | **clean**, no untracked files | `git status --short` |

The five NUL files are the same five `TODO.md` §F names: `src/evolution/trajectory.ts`,
`src/journal/payloads.ts`, `test/builtin/fs-search.test.ts`, `test/run/delivery.test.ts`,
`test/server/http.test.ts`.

**The kernel guard prints 11 seams and `fbbdac4`'s trailer is NOT among them.** The eleven it lists
are `b28c343 3762a0e a8d62fb 97a53a1 d0ca421 52da0e8 f0aa81e e93f874 dcdb3f1 f96a691 9a90883`.
`fbbdac4` is a merge commit and the guard does not judge merge commits, so the taint branch's
`Kernel-seam:` trailer — naming `run.submitted.taintedInputs`,
`task.committed.takeSuppliedByProducer` and the `fanout_skipped_gate` escalation rule, E12 — is in
`git log -1 --format=%B fbbdac4` and nowhere in the ledger's count. §5 keeps that open.

The guard's commit count moved 325 → 539 partly because `wave2-guards` made it judge the FULL
history rather than `since..HEAD`; do not compare it to the old handoff's number as if it were the
same measurement.

---

## 2 · What was asked, and what happened

The user asked for the four stopped wave-2 reviews to be finished, then (round 2) for "those
opening tasks" to continue. 132 commits landed on `df6294f..af95630`, ten of them merges — nine
lane branches plus `fbbdac4`, which is the `phase1-taint` merge made INSIDE the taint lane.

**Round 1** — the four stopped branches, reviewed to zero confirmed blocking and merged in the
handoff's order: `wave2-graph` `3cfd363`, `wave2-engine` `6b3513b`, `wave2-guards` `3656d69`,
`wave2-exam` `ec2ad88`, then the docs/TODO settlement and `ff8fdac` (`a0-21-take-kind`, the one
blocking finding round 1 merged knowingly).

**Round 2** — four new lanes from `3d05cff`, merged after all four closed: `02a5e84` (`taint`,
carrying `fbbdac4`), `0de48c4` (`engine-child-journal`), `010510e` (`mcp-registrar`), `3b983f7`
(`exam-reads`), then `8c86559` and `af95630`.

Per lane, from its own report:

**`wave2-graph`** (`lanes/wave2-graph/wave2-graph/report.md`) — 4 rounds; reported 9/13/13/10 →
4 blocking confirmed and fixed over rounds 1–3, round 4 confirmed 2 more with the cap spent.
Gate at round 4: `tests 3302 · pass 3302 · fail 0 … EXIT=0`, 11 seams. Behaviour: five checks by a
fresh agent that never saw the diff, partly through a 115.9 MB `./bin/loom` — *"all five checks
PASS through the shipped binary and the library … `graphHash` byte-identical over the 7 spec files
base vs head, and `scale.test.ts`'s 18.9x against a 4x tripwire."* Final status in the report:
**DEADLOCK — "Do not merge this branch as 'reviewed and clean.'"** See §3.

**`wave2-engine`** (`lanes/wave2-engine/wave2-engine/report.md`, `review-2026-09-08.md`) — 4 fix
rounds plus a closing review, 6 reviewers, 2 behaviour agents. *"40 findings reported → 10 confirmed
blocking → 10 fixed"*, plus 7 non-blocking. Round 1 ran two parallel reviewers whose 6 reported
blocking union to 4 distinct. Gate at `946a8c8`: 3,302 pass / 0 fail, exit 0, 11 seams unchanged.
Behaviour: *"driven twice through the shipped binary by fresh agents that never saw the diff; all
paths MATCH, and the mirror race the branch exists to close was observed end to end on a real `loom
serve` (mirror raised 929 ms after the child finished, self-answered in 2 ms)"*. CLOSED at 0.

**`wave2-guards`** (`lanes/wave2-guards/wave2-guards/report.md`) — 4 rounds (5B/3B/4B/2B reported;
5, 3, 4 confirmed and fixed, round 4's 2 fired the cap), then a fifth docs round by a fresh writer
that closed them; that round's reviewer returned `{"blocking": [], "blocking_count": 0,
"nonblocking_count": 2}`. Gate: `ℹ tests 3330 / pass 3330 / fail 0`, surface 539, 404 commits
judged, 11 seams. Behaviour: three fresh agents on rebuilt binaries — *"All five items driven
through the shipped binary. 5/5 PASS."*, then 7/7, then the remedy sweep whose own sentence was
*"No remedy this pricing guard prints is refused by the binary."* CLOSED.

**`wave2-exam`** (`lanes/wave2-exam/wave2-exam/report.md`, `check-tail.txt`) — 3 fix rounds, a
closure round at 0 blocking, then a round 4 on a raised cap. Reported 5B/3B/1B/0B/1B → 6 distinct
confirmed, all fixed; round 4's single blocking was *"AND THE BLOCKING ONE WAS MINE"*, a false test
comment. Gate at `b55f6b1`: 3,331 pass / 0 fail, exit 0, 539 exports, 11 seams. Behaviour driven end
to end three times by three fresh agents, plus a fourth re-drive at `b8fc664`. CLOSED, with the
caveat the report states in bold: *"Do not merge this and then write 'property 3 holds' in
CLAUDE.md §3 without the assumptions."* §4.

**`a0-21-take-kind`** (`lanes/a0-21-take-kind/report.md`) — 4 rounds, 1/2/2/1 blocking reported, all
confirmed and all fixed. Gate at `c0a45e1`: *"3485 pass / 0 fail / 0 skipped / 0 todo; zero-dep ok
(65 files); surface ok (539 exports, unchanged); kernel ok (10 pinned, 478 commits judged, 11
declared seams, unchanged — every commit is a `fix`, so no seam is owed."* Behaviour, round 2:
*"all four PASS, including the new one — the same graph plus a catch-all `error` edge, human
REJECTS, no receipt file, and `loom trace` shows `pay` never got a task."*

**`taint`** (`lanes/taint/taint/report.md`) — the `phase1-taint` merge plus 3 review rounds (round 1
with two parallel reviewers) and 2 behaviour agents; 4/1/1 blocking reported → *"five confirmed
blocking findings, all five fixed and each pinned by a test that is red at its predecessor by
ASSERTION"*. Last verbatim gate block is round 2's: `ℹ tests 3538 / pass 3538 / fail 0`, surface
540, 11 seams, exit 0. **The report's STATUS line and `plan.md` both claim 3,539 and no transcript
in the lane's files shows it** — treat 3539 as prose. Behaviour: *"errfan CLOSED, errthrow CLOSED,
mutedge5 already closed at base and byte-identical at HEAD"*, re-confirmed in round 2, and *"No test
that passes at base fails at HEAD."*

**`engine-child-journal`** (`lanes/engine-child-journal/engine-child-journal/report.md`) — 4 rounds
plus a closing review; 3/3/2/1 blocking reported → 2/3/2/1 confirmed, all fixed (the last on a
raised cap, `9bb3050`); closing review `blocking_count: 0`, 9 non-blocking. Gate at `9bb3050`,
exit 0: `ℹ tests 3490 / pass 3490 / fail 0`, surface 539, 492 commits judged, 11 seams. Behaviour:
*"BOTH HALVES MATCH"* — and, worth keeping, *"Defect half — NOT drivable through the binary, and the
agent said so rather than substituting: it needs a `StateStore` double whose `read` generator throws
while the CHILD's journal is iterated, and there is no CLI or HTTP door that injects a store."*

**`mcp-registrar`** (`lanes/mcp-registrar/report.md`) — 5 rounds, 4 behaviour checks. Reported
8/9/11/9/6 → confirmed 4/8/6/1/0; round 5's machine line was `{blocking: [], blocking_count: 0,
nonblocking_count: 6}`. Gate: `ℹ tests 3493 / pass 3493 / fail 0 … duration_ms 21903.410708`,
zero-dep 65 files, surface 539, 11 seams, exit 0. Behaviour: four independent agents, 6+5+6+7 cases
through `bin/loom` — *"All seven MATCH"*, with a control the checker added itself (compiling a graph
calling `mcp__a__b__x` under the same `--mcp-file` and getting `ok`, proving the name really
registered rather than merely not being refused).

**`exam-reads`** (`lanes/exam-reads/report.md`) — **8 rounds, 9 reviewers.** Rounds 1–4 reported
7/8/10/9 → 2/4/5/7 confirmed, rounds 1–3 fixed and round 4's cap spent; rounds 5–8 returned
2/1/2/1 blocking against a gate of 0, every one of them in PROSE. Gate at `5caee87`: `ℹ tests 3496 /
pass 3496 / fail 0`, 65 files, 539 exports, 494 commits judged, 11 seams. Behaviour: *"Two fresh
agents that had not seen the diff, each building a 30-recording `pick-bench` workspace from scratch
and driving `./bin/loom` built in this worktree. Both report every leg MATCHES."* The discriminating
case: two exams differing in one word (an edge `kind`) get opposite answers. Merged with residue —
see §3.

---

## 3 · The decisions the orchestrator made without the user

All from `.agent/wave2-review-2026-09-08/plan.md`, dated 2026-09-08. They are recorded here because
the plan file is gitignored and this is the tracked half.

- **Lane shape.** Orchestrator-only; one lane agent per branch, spawning fresh reviewers
  synchronously, report written to file BEFORE the final message. Depth Standard, except
  `wave2-engine` (a kernel file, behaviour changes) and `wave2-exam` (a new CLI verb, a contract)
  which got two reviewers on round one.
- **Three caps raised 3 → 4 in round 1.** `wave2-engine`, for a regression the branch itself
  introduced (the live drive-loop call site rethrowing the PARENT's store failure as the answer to
  `resolveGate` on the CHILD) — *"a merge that ships a known regression into loom is the thing the
  review exists to prevent."* `wave2-guards`, for two false sentences in README's property-2 ledger,
  fixed by a fresh writer who verified by DRIVING the binary — *"merging a false ledger sentence is
  the defect class the whole lane exists to close, and the verification is a run, not a read."*
  `wave2-exam`, for `attestationProblems` permitting an exam that reads no baseline OUTPUT —
  *"CLAUDE.md's first defect lens verbatim (a guard answering its undecidable case with the passing
  value) on the very guard property 3 rests on."*
- **`wave2-graph` was merged knowingly at 1 confirmed blocking.** Options were (a) fix it in
  `engine.ts` on the graph branch, (b) merge and record it as a TODO row, (c) hold the branch. Chose
  (b): `git blame` dates the `take` filter to `e5453ec` (2026-08-19), so the hole existed on `loom`
  for AUTHORED graphs already; the branch narrows six bypasses and adds none; `engine.ts` was under
  concurrent edit by `wave2-engine`. The plan records *"User not reachable; this reading was not
  confirmed."* The tracked half was `TODO.md` §A0.21, and it was closed the same day at `ff8fdac`.
- **`exam-reads` round 5, option (b).** The lane deadlocked at `5b46f86` because route 4 (a
  conditional edge's `when`) counts an expression the executor skips whenever a body returns `take`.
  Decision: **a read counts ONLY where the executor unconditionally evaluates it — node-level reads;
  edge conditions never count**, on CLAUDE.md's "when a guard cannot decide, it fails closed". Stated
  cost: an exam whose only read is in a `when` is refused and the operator must add a real read.
- **`exam-reads` merged with residue after round 8.** Caps went 3 → 4 → 5 and on to a round-7
  deletion and a round-8 rewrite, and round 8's reviewer still returned 1 blocking. The plan's
  reason: *"behaviour has been stable and driven since `6898a8d`; a docstring cannot block a
  guard."* Three residue items carried into `3b983f7` and were then fixed at `8c86559`.
- **The one wrong premise the orchestrator supplied, and a reviewer refuted it.** Round 6 of
  `exam-reads` was instructed on the premise *"for a join source the spec does settle it"*. It is
  FALSE — `#foldJoin` can fail into `#errorEdges`, so the condition is skipped — and the round-6
  reviewer found it. Round 7 was scoped to DELETE that paragraph and its two echoes, with the rule
  that no claim about executor evaluation sites may remain. The lane's own note: *"`6898a8d`'s
  original sentence was closer to true than the one written to replace it."*

Two smaller notes the plan records: an unattributed `M package.json` in the main checkout during
the guards lane (surfaced, left in place); it turned out to be npm-induced by the exam lane's
install and was reverted, and the checkout is clean now.

---

## 4 · Property 3, stated carefully

**CLAUDE.md §3 no longer says the property is faked.** It now says *"It WAS faked, and the
mechanism was one sentence"*, names the answer as an operator-attested exam merged at `ec2ad88`,
and pastes a verification driven on `loom` at `ce9e7b4` by a fresh agent that had not read the
implementing lane's report — `noop.json` ✗ L1 Δ −0.2000 0W/10L/20T, `rigged.json` ✗ L1 Δ 0.0000
0W/0L/30T, the honest `fixed.json` ✓ Δ +0.4000 20W/0L/10T. Both audit reproductions refuse at the
`--against-cohort` door.

**It holds under five stated assumptions**, which §3 calls "the claim, not a footnote": one
operator; an exam that reads the run's answer, enforced by NAME only; the exam-gated doors are
`promote --against-cohort` and `suite freeze` (`promote --suite` still decides on the frozen suite
and check 12); no `subgraph` child grader; and the 60/40 split accepted.

**What today closed, and what it did not.** `exam-reads` added the fifth `examShape` rule: every
declared exam input other than `subject` must be NAMED in a node's own `reads`, in a `${…}` template
root in a node's tool args, or in a fanout edge's `over`. Driven on the binary built at `8c86559`
over a six-recording `pick-bench` workspace, an exam declaring `picked` and reading only `items` is
refused `E_CONFIG_INVALID` naming the channel, the same exam with `picked` in its grader's `reads`
attests exit 0, and `examples/exams/review-bench-exam.json` attests exit 0 against a real cohort.

**The gap that remains is the whole of what "by NAME" concedes**, and it was driven rather than
inferred. From `af95630`'s own commit body:

> The remaining gap is stated and driven rather than inferred: the rule checks NAMES, so
> an exam that names the channel in `reads` and ignores it still attests — an always-pass
> body attested exit 0 and replaced the honest ruler in the same workspace.

The fixture is `exams/names-only.json` — `pick-exam` with `picked` still in `grade`'s `reads` and a
body `() => ({writes:{verdict:{pass:true,…,detail:"never looked"}}})` — attested exit 0 at
`sha256:8404a420…`. Closing it is a dataflow analysis from each declared input to the terminal node,
not a sixth rule.

---

## 5 · What is open

Residue, one bullet per lane, each with the report that enumerates it:

- **`wave2-graph`** — `lanes/wave2-graph/wave2-graph/report.md`: a vacuous compensation test arm, a
  compensation-only inbound seeding an entry, a dead `conditional` shrinking `before`, the rule not
  being retroactive through `#rehydrateGraph`, `MUT003_NOT_DOMINATED` now carrying six unrelated
  refusals, and two new narrowings.
- **`wave2-engine`** — `lanes/wave2-engine/wave2-engine/report.md`: nine items, headed by a repeat
  redelivery answering 200 warm and 409 cold, `RETAINED_GRAPHS = 128` bounding the redelivery door,
  an unbounded `#forgotten`, every poll of a finished run re-folding its journal, and the summariser
  charging 0 on a RETRIED agent task.
- **`wave2-guards`** — `lanes/wave2-guards/wave2-guards/report.md`: ten N-rows, mostly untested
  banner text plus `check-kernel.mjs`'s "THE LAST THREE" no longer indexing its own list and the
  "35 feat commits" figure moving with the next `feat` commit.
- **`wave2-exam`** — `lanes/wave2-exam/wave2-exam/report.md`: `examShape` not checking
  `policy.posture`, `evolution.scored.weights` and `weightsDigest` disagreeing under an exam (which
  makes a docstring in the KERNEL file `journal/events.ts` false), nothing caching on the scoring
  path, `promote --suite` still having no `metadata.name` check, and `freezeSuite`'s `truncated:
  false` being a hardcoded constant.
- **`a0-21-take-kind`** — `lanes/a0-21-take-kind/report.md`: `E_ROUTE_INVALID` is now run-fatal, so
  it dispatches real compensation on paths that previously succeeded, an old journal replays as
  divergent, and the compiler stays silent (the refusal is per-task at run time).
- **`taint`** — `lanes/taint/taint/report.md`: RC-2's five exclusive-reach rows, `taintedOn` short
  on the REWIND verb, E12's `detail.skipped` unbounded and E12 blind to a fan one `seq` hop from the
  head, `#rehydrateGraph` throwing `E_OVERSIGHT_LOOSEN_FORBIDDEN` forever on a run whose recorded
  mutation this binary refuses, and the attach-time fold's cost unmeasured.
- **`engine-child-journal`** — `lanes/engine-child-journal/engine-child-journal/report.md`: **the
  four unwrapped cross-run child reads of the same shape** (`#planRollbackChild`, `#runSubgraph`,
  `#forwardGateDecision`, `#endChildRun`) plus the cross-run WRITE `#resolveGateAsSystem` — the
  report names this as the actual next lane.
- **`mcp-registrar`** — `lanes/mcp-registrar/report.md`: the `mcp__` reservation is a BOOT check a
  post-`seal()` registration walks around, it refuses read-only verbs too, and the prefix message
  hardcodes `--extension-module` on the two embedder paths.
- **`exam-reads`** — `lanes/exam-reads/report.md`: the rule checks NAMING not reachability (six known
  blind shapes), the expression-site list is kept by hand in three places (`exam.ts`,
  `run/externalise.ts`, `engine.ts`), and there is a migration effect — an exam attested before this
  rule makes `loom score`, `promote --against-cohort` and `suite freeze` throw rather than fall back
  to in-graph S1. Its three carried items were fixed at `8c86559`.

**`TODO.md` §A0 rows still open: A0.12, A0.13, A0.17, A0.18, A0.19.** A0.12 is the stranded run
recompiling the workspace every tick (needs a cache-invalidation design); A0.13 is the usage floor's
~80× dollar residual on the Anthropic cache-read dimension; A0.17 is `POST /runs` accepting the
input the CLI refuses; A0.18 is the `plane-watch-and-stop.test.ts` flake; A0.19 is a NODE id being
an `Object.prototype` name. A0.5, A0.8, A0.14, A0.16, A0.20 and A0.21 closed today and are struck
in place with their merge shas.

**`fbbdac4`'s `Kernel-seam:` trailer is outside the guard's count** (§1). It is real design argument
recorded in `git log` that no ledger reader will see. Either the guard learns to judge merge
commits, or a `fix:`-classified commit on `loom` restates the seam where the guard can count it.

**Correction to a premise this handoff was asked to record:** there is no stale CHECKED-IN binary.
`bin/` is gitignored (`git check-ignore -v bin/loom` → `.gitignore:5:bin/`), `git log -- bin/loom`
is empty, and the local `bin/loom` is a 116 MB build made at 21:32 today that answers `--version`
with exit 0. What exists is the *freshness* mechanism, not a tracked artifact — see §6.

---

## 6 · The transferable lessons, each with the lane it came from

- **A comment that restates another module is a second copy of it.** `exam-reads`, 8 rounds and 9
  reviewers: *"A prose contract that must stay true of a 10,000-line executor is a second copy of
  that executor, and it drifts exactly as fast."* The predicate did not change after `6898a8d`;
  every round after it moved prose. And the last finding's shape: *"shortening prose is not a safe
  operation — it changes claims. Where a comment was load-bearing, the replacement is a TEST, not a
  shorter comment."*
- **When accommodations accrete in one predicate, the next round should DELETE.** `mcp-registrar`:
  *"Rounds 2, 3 and 4 each found that the PREVIOUS round's accommodation was wrong, always one edge
  over, always in the same predicate: `claimed`. … That is not an incomplete fix three times, it is
  a mis-scoped one — the accretion of special cases in one predicate is the tell."* Round 5 deleted,
  and the stop condition (all eight tests staying green through the deletion) *"did not fire."*
- **Mutation is the test of a load-bearing branch.** Two lanes reached it independently: mutate or
  delete the suspect term in a private `git archive HEAD` extraction and re-run; if nothing goes
  red, it is inert. `mcp-registrar` proved both round-3 additions dead that way; `exam-reads` proved
  route 4's router-case term dead (*"Deleting the term leaves all 29 predicate tests green"*).
- **"What ran?" — and a test that would hang at base is not a test that fails at base.**
  `wave2-engine`: *"A defect whose failure mode is a hang belongs out of the suite"* — the livelock
  pin HUNG at base; the double now throws past a lie budget, 174 ms with a named failure instead of
  a 20,000 ms SIGKILL. `wave2-exam` re-proved its round-4 tests red *"by assertion in 5.7 s rather
  than by hanging"*. `mcp-registrar` found the harness half: the in-process CLI idiom (swap
  `process.stdout.write`, `await main(...)`) is unusable for a test whose body awaits `main` —
  measured, the file reported `ℹ tests 1` with the first test neither passed nor failed, invisible.
- **A premise relayed from a reviewer is not a fact until it is driven.** `exam-reads` round 6: the
  orchestrator passed on round 5's reviewer's join-source premise as given; it was false, and the
  fix written from it was worse than the sentence it replaced. Same shape in `taint`, where a
  round-2 behaviour agent's `mutedge5` clean-arm claim was refuted by re-running — *"the line
  appears to have been copied from `errthrow`'s block in the same report."*
- **Most rounds after the first fix a CLAIM, not a mechanism.** Reported independently by five
  lanes. `engine-child-journal`: *"Every round after the first fixed a CLAIM, not a mechanism: a
  title, a comment, a line number, a fallback string. … The fifth was caught inside the commit
  written to end the pattern."* `wave2-guards` round 3: *"Three of the four blocking findings were
  defects in rounds 1 and 2's own fixes."* `wave2-exam`: *"Three of the five were reopenings of the
  previous fix, one edge over."* What catches them is a fresh reviewer told to RUN every claim the
  fix commits make.
- **A failed reproduction is evidence about the probe first.** `taint`, on E12: the first probe did
  not reproduce, and the window was narrower than the finding said — the escalation missing *while
  the join is scheduled and NOT YET DECIDED*.
- **An enumeration of another module's semantics has now been wrong five times out of five.**
  `wave2-graph`, on `graph/mutate.ts` enumerating `run/engine.ts` behaviour; the fix is to make the
  engine answer, and `ff8fdac`'s `TAKEABLE_EDGE_KINDS`, shared by four doors, is the first instalment.
- **Say "not drivable" rather than substitute.** `engine-child-journal`'s behaviour agent refused to
  fake the defect half because no door injects a `StateStore`. Report that; do not work around it.

---

## 7 · Facts you would otherwise rediscover

Carried from the deleted 2026-09-08 morning handoff §9, each re-checked that day unless marked:

- **`check-surface.mjs` reads `dist/`.** `scripts/check-surface.mjs:44-47` exits 1 naming
  `npm run build` when `packages/core/dist/index.d.ts` is absent; a STALE `dist/` passes. Verified
  by reading the code at `af95630` — the source of the old handoff's "an unbuilt tree passes".
- **`npm test`'s count is not the number of tests that ran.** Still true: `node --test
  packages/core/test/cli/cli.test.ts` reports `tests 38 / pass 38` on `af95630`, and a file whose
  bodies hijack `process.stdout.write` can report `ℹ tests 1`. `mcp-registrar` measured the sharper
  version this round (above).
- **macOS zsh has no `timeout`.** `which timeout gtimeout` → not found, exit 1. `timeout 60 …`
  produces empty output that reads as a hang.
- **`git merge` run from inside a worktree merges into THAT worktree's branch.** Carried, NOT
  re-verifiable today — there are no wave worktrees left. Round 1's plan makes it a standing rule:
  *"merges run from the main checkout by a merge agent, never from inside a worktree."*
- **`git archive <sha> | tar -x -C <dir>` is the cheap base proof, one extraction per lane.** Both
  round-2 mutation lessons above depend on it.
- **Point every agent at `npx tsc -p packages/core/tsconfig.test.json`;** `npm run check` runs a
  `tsc -b --force` that races on emit under concurrency.

New today:

- **The binary refuses after source edits, and `npm run check` does not test that.** The guard lives
  inside the artifact and prints `THIS BINARY IS STALE`; `scripts/verify-binary.mjs` drives the real
  artifact through four cases (CURRENT / STALE / OVERRIDE with `LOOM_STALE_BINARY=allow` / SHIPPED
  with no source tree). It is a CI `binary` job step after `npm run build:binary` — the `check`
  script is `typecheck && test && zero-dep && surface && kernel` and includes neither. Its own
  header records the bootstrap hole that made it necessary: a binary built before the guard existed
  is silently stale forever, and a source grep is structurally unable to see it.
- **`ort` auto-merged what a design predicted as conflicts, and also produced more than predicted.**
  `ec2ad88`'s body: *"No conflict arose with the guards lane: cli.ts auto-merged, keeping both the
  extension-module widening and the exam verb"* — the round-1 plan had expected `cli.ts` conflicts
  between guards and exam and resolved for them in advance. In the other direction, the taint design
  predicted three conflict hunks against `294e713`; `loom` had moved and `fbbdac4` resolved **six,
  in three files**. Predicted conflicts are a hypothesis about a base that moves.
- **`git branch --merged` and `git branch -a` mark a branch checked out in another worktree with
  `+`.** Verified: `git branch -a` on `af95630` prints `+ init`, which is `eagent-ref`'s checkout,
  not a merge state. Do not read `+` as anything about merged-ness.
- **The kernel guard now judges the full history.** `wave2-guards` closed the `since` reset, so
  `check-kernel.mjs` prints "N commits judged since `86b84c9`" over the whole history plus a
  grandfathering notice for 36 pre-`since` feat commits. The commit count is not comparable to
  pre-`3656d69` handoffs.
- **All wave worktrees are gone and the prunable `/private/tmp` entries are cleared.**
  `git worktree list` returns two rows. The lane branches still exist as refs (`git branch` lists
  them); `git branch -d` on each is a separate optional step. Every lane's `.agent/` was copied to
  `.agent/wave-2026-09-05/lanes/<lane>/` before removal, because `git worktree remove` deletes it.
