# Handoff — 2026-09-03, after the merge

Supersedes `handoff-2026-09-03.md`, which was written before any of this landed and whose §4
ranked list is now closed. Read that one only for the history of how the lanes were built.

**`loom` carries the three phase-2-4 lanes and two fix rounds. `npm run check` exits 0.**

---

## 1 · The state, in one table

| fact | value | command |
|---|---|---|
| the gate | **exit 0** | `npm run check` |
| tests | **3,040 pass / 0 fail** | `npm test` |
| pinned exports | 539 | `node scripts/check-surface.mjs` |
| kernel | 10 files, 11 declared seams | `node scripts/check-kernel.mjs` |

`phase1-taint` is the only unmerged branch and is still parked — RC-6 is a design change, not a
patch, and the design comes before the code. The old handoff's §5 is still the brief for it.

---

## 2 · What the old handoff asked for, and what happened

Its §4 ranked four things. All four are closed.

1. **The surface pin.** It did fail exactly as described. Worth knowing why it reported *green*
   before the build: `check-surface.mjs` reads `dist/`, so an unbuilt tree passes it. That is the
   stale-build mode its own header documents and `toolchain-gate.test.ts` pins.
2. **Lane C's skipped round-2 adversary.** Run. All three of its round-1 blockers hold up under
   attack — including `fs.grep` on a real 60,000-file workspace, 1,438 ms at head against a
   refusal before. It found two majors of its own, both fixed here.
3. **The cross-lane `engine.ts` change.** Landed, and it turned out to be half a fix — see §3.
4. **The three round-2 findings.** All three fixed, along with nine more the reviewers found.

---

## 3 · The one that was bigger than it looked

Lane C specified the `engine.ts` reclaim change as "one line, already justified". It was correct
and it was not sufficient: making `select` reachable let a **human** recover a crashed plane by
clicking `advance`, while `cli.ts`'s run clock still skipped stranded runs forever, because its
`due` predicate wanted a `ready` task. Measured on a real `kill -9`: 42 s, ~84 ticks, never
driven.

Closing it needed three changes together, and the middle one is the interesting one:

- `#advanceSerially` asks `select` before deciding a run is over (lane C's line);
- **it no longer FINISHES a run that still holds a `leased` task** — which removes a hazard worse
  than the one being fixed, a run declared `failed` while its worker is alive in another process;
- `runClockTick`'s `due` counts a `leased` task, which is only safe because of the middle one.

Driven end to end afterwards, through `loom serve` over a real SQLite journal:

    planeB pid=72463 spawned
    +   715ms seq= 8 task.leased [slow@root#0] {"attempt":2,"workerId":"…:72463:1"}
    +   716ms seq=23 run.completed {"outputs":{"done":"slept 0"},…}
    TERMINAL after 716 ms

At `dbe0528` and at `7eaa206` the same script reports `NO TERMINAL EVENT within 45000 ms`.

**The trade, stated because it is a contract change.** A lease nobody can adjudicate now leaves
the run `running` rather than `failed`. Verified not to spin: a stranded `subgraph` task over
60 s of 500 ms ticks left the journal at 14 rows and the WAL byte-identical, and `driveToRest`
returns on that shape rather than looping. **And it has a price** — §A0.12 of `TODO.md`, measured
at ~13× idle CPU on a 41-graph workspace, recorded rather than patched because both cheap fixes
are wrong.

---

## 4 · How the defects were actually found, which is the transferable part

Twelve confirmed findings across two rounds. What produced them:

- **The behavior check earned its keep twice.** It found the run clock (nothing in the suite could
  have), and it found that lane B's concurrency test does not reproduce through either shipped
  store — true, and lane B's own commit message says so. A test can pin a real defect against an
  injected store and pin nothing about the shipped one; both facts are worth writing down.
- **A reviewer caught a defect in the reviewer's own methodology.** Two assertions added in round
  one asserted that a no-op had changed nothing — the test's `drive` callback only recorded a run
  id and never advanced. They passed at the base sha. **Ask of every new assertion: what ran?**
- **Two corrections replaced a false claim with a differently-false one**, which CLAUDE.md warns
  is worse than the original. One said a `tool` node "carries no declared `timeoutMs`" — every
  `tool` node gets `DEFAULT_NODE_TIMEOUT_MS`, measured `600000`. One said base returned an empty
  array for `take: null` — base returns the whole array. Both were written while fixing a defect
  correctly, which is exactly when nobody re-measures the sentence.
- **The fix round is where over-correction lives.** Round one's usage floor fixed a real 11×
  over-charge and introduced a 570× under-charge, in the loosening direction, by replacing
  "reported zero" with "was anything reported". Both rounds were reviewed; only the second review
  caught it.
- **A control is what makes an arm mean anything.** The rewind finding was reproduced with a
  control that must refuse on both trees — without it, "the defect arm refuses" is consistent with
  any other guard firing anywhere on the path.

---

## 5 · What is open

- **`TODO.md` §A0** — twelve rows, each with a pasted reproduction and a named fix. Eleven are
  pre-existing and one (§A0.12) is this change's own cost. None blocks.
- **`phase1-taint`**, per the old handoff §5.
- **Phases 5–11 of `.agent/full-audit-2026-09-02/plan.md`** are still untouched. The highest-value
  one is unchanged and is the headline of `docs/audit-2026-09-02.md`: **property 3 is faked**
  because `extractSignals` reads S1 out of the candidate's own graph. Nothing in this merge
  touched it.
- **Two compile-time diagnostics belong in `graph/validate.ts`** and were left there deliberately:
  nothing checks `contextProjection`'s `take`, `overflow` or `maxTokens` at compile, so a graph
  with `take: "abc"` or `overflow: "TRUNCATE_TAIL"` compiles clean and refuses at run time. The
  runtime half is done; the diagnostic is the right shape and that file is pinned kernel.

---

## 6 · Facts you would otherwise rediscover

- **File-ownership lanes still work, at fix-round scale too.** Two rounds, three writers each,
  disjoint file lists, zero conflicts. The one cross-lane change nobody owned is the one that was
  half a fix for eight days.
- **`git archive <sha> | tar -x -C <dir>` is the cheap way to check a test fails at base.** It
  registers no worktree, takes no index lock, and works while the tree is mid-edit — which
  matters when several agents are running.
- **Point every agent at the read-only typecheck.** `npx tsc -p packages/core/tsconfig.test.json`;
  concurrent `tsc -b` races on emit, and `npm run check` runs one.
- **The three seam counts still disagree** — guard 11, `git log --grep` 12, git's trailer parser a
  third number. `check-kernel.mjs` used to recommend the grep and no longer does.
- Five pinned kernel files changed here under `fix:`, so the ledger recorded nothing — correctly by
  the rules, while `journal/events.ts` gained three new durable payload fields. New vocabulary
  arriving as maintenance is the guard's documented limit, and a reader is the only thing that
  catches it.
