# RC-6 — the scope of the taint sink

**Its recommendation was taken.** `phase1-taint` merged to `loom` at `02a5e84` on 2026-09-08; the
conflict-resolving commit `fbbdac4` carries the `Kernel-seam:` trailer this document asked for.
Written 2026-09-05 against the branch head `7fd4537`, its base `a638e7d`, and `loom` at `294e713`;
slimmed 2026-09-09 to the decision in force, what the implementation corrected, and the residue.
The seven alternatives that lost and the rebase measurement are gone; `git log` has them.

Section numbers are load-bearing: `run/engine.ts` cites §3, §4 and §10, and three tests cite §4.
Do not renumber.

**The result in one paragraph.** RC-6 as written is **not a scope defect**. The set that
"saturates" is doing implicit-flow propagation — a channel whose WRITER an attacker selected is a
channel an attacker influenced — and that propagation is the mechanism two confirmed exploits
(`pickwriter`, `fanplanner`) require. The named fix, "a branch-scoped sink on the `taintedOn`
model", cannot be expressed: `BranchCoordinate` carries fan-out segments only, so every router arm
shares one coordinate.

---

## 1 · The three sets, who writes them, who reads them

All three live on `RunContext` and are **run-global and monotone**: written from seq 1 forward,
never cleared, rebuilt by `#restoreEvidence` folding `task.committed` in seq order.

| set | key | written by | read by |
|---|---|---|---|
| `tainted: Set<channel>` | channel name | `applyTaint` at every commit; `submit` seeds it from `run.submitted.taintedInputs` | `taintedOn` (the per-branch reader) → E8 in `#decide`, `taintedTurn`, `applyFanoutTaint`, `fanoutWidthEvidence`, `choiceTainted`; and `#runSubgraph`'s direct `ctx.tainted.has(parentCh)`, which ignores `taintedFans` |
| `taintedFans: Set<EdgeId>` | fanout edge | `applyFanoutTaint` when the commit that takes a fanout edge finds `over` tainted | `taintedOn`, which walks the asking task's `branch.segments` — the one per-branch answer in the file |
| `controlTainted: Map<NodeId, {decidedBy, channels}>` | node | `applyControlTaint` (region of a tainted choice), `applyFanoutWidthTaint` (fan body); first writer wins | E8 in `#decide`, `applyTaint`'s third arm, `fanoutWidthEvidence`, `choiceTainted`, `#fireEmptyJoin` |

`applyTaint`'s guard is the whole of RC-1 and RC-6 in three lines:

```ts
if (!isExternal(node) &&
    !ctx.controlTainted.has(node.id) &&           // RC-1's arm: control taint becomes data taint
    !observedChannels(node).some((c) => taintedOn(ctx, branch, c))) return;
for (const channel of Object.keys(writes)) ctx.tainted.add(channel);
```

**Where a node-scoped fact becomes run-global.** `applyControlTaint` marks a NODE set:
`controlRegion` computes the exclusive reach of each taken edge and the mark stops at the
reconvergence — `merge` in a two-arm router is not marked. When `armA` commits, the second line of
the guard fires and every channel `armA` wrote enters `tainted`, keyed by channel NAME. From that
commit on, `taintedOn(ctx, anyBranch, "note")` is true for every reader on every branch, `merge`
included.

**That is what RC-6 states, and the two answer different questions.** `controlRegion` answers *was
this node's EXECUTION chosen* — `merge` runs whichever arm fired, so no. `tainted` answers *was
this node's INPUT influenced* — `merge` reads `note`, and whether `note` holds `armA`'s value or is
unset was the choice, so yes. Implicit flow is the textbook name.

---

## 3 · What the saturation is

**The cascade is `pickwriter` with more hops.** In `cascade-actsOnOutput` the page decides whether
`opt0` runs; `opt0` is the only writer of `o0`; `st0` reads `o0` and writes `c0`; the charge reads
`c3`. The engine never sees a body, so it cannot know `st0` writes a constant. A body
`c0 = o0 ? 9999 : 1` is the same journal, and with it the page sets the amount. The root-cause
note's own over-gating example — "a router with reconverging arms whose merge reads what the arm
wrote" — is `pickwriter`'s graph with the charge renamed `merge`. **No fold over the journal
separates the two**; the only difference is whether the reader is hard-to-undo, and E8 already
fires for hard-to-undo readers only.

**The maximal scoping, built and measured.** The strongest form of any region- or branch-scoped
sink is "a control-selected node's writes never enter the global set" — every scoping proposal is a
subset of it. Built by deleting the middle line of the guard above, nothing else changed:

```
$ node --test packages/core/test/run/control-flow-taint.test.ts \
    packages/core/test/run/empty-fanout-oversight.test.ts packages/core/test/graph/mutation-dominator.test.ts
✖ A FAN PLANNER BELOW A RECONVERGENCE STILL FANS AT THE ATTACKER'S WIDTH
✖ A NODE THAT RAN ONLY BECAUSE A TAINTED CHOICE SELECTED IT WRITES THE ATTACKER'S BYTES
ℹ tests 57 · pass 55 · fail 2
```

Both reopened rows have their reader AT the reconvergence: `pickwriter`'s charge and
`fanplanner`'s `plan` are outside every region by construction. **Any sink that HIDES a region's
writes from readers outside the region hides them from exactly these two.**

**There is a second way to lose that hides nothing**, and the first draft did not see it: keep the
writes tainted for every reader, but do not let a control-derived channel count as EVIDENCE for a
later choice. Every pinned test passes, `pickwriter` and `fanplanner` stay closed, and two-router
laundering at one remove (`laund2`) reopens with `gates=0`. **So the sink has two obligations, not
one** — a region's writes must reach readers outside the region, AND must be able to make a later
choice tainted — and the pinned suite tested only the first.

**The named mechanism cannot express the named scope.** `BranchSegment = { edgeId, index }`, pushed
by `childBranch` from `#branchReady` alone — a segment IS a fan-out branch. `taintedOn` therefore
partitions readers by fan-out membership and by nothing else; keying control-derived writes the way
`taintedFans` is keyed distinguishes `armA` from `merge` in no graph without a fan-out.
`DESIGN.md` D4 records the earlier attempt to key the whole taint set by coordinate and its
reversion (`f74d863`): under fan-out, sibling arms taint identically, so the key buys precision
nothing observes.

**What is left of RC-6, and neither is a scope defect:**

- **The cost is real and is the price of implicit flow.** It is bounded by E8's consumer rule
  (hard-to-undo readers only) and paid exactly by graphs in which a hard-to-undo node reads a
  channel whose writer a fetched page selected. `DESIGN.md` D4 chose this: FIDES-style
  most-restrictive propagation, with "once untrusted content enters, the whole run is untrusted"
  named as the accepted cost.
- **The cost is illegible**, and that is the sink's real debt. An operator asked to approve `charge`
  in cascade4 sees `policy.escalated{reads:["c3"]}` and nothing that says `c3` is untrusted because
  a page four stages back chose whether `opt0` ran. **Not built.** The design: `tainted` becomes
  `Map<channel, Cause>` with the SAME membership, one arm per way a channel enters the set —
  `{via:"external"}`, `{via:"seed"}`, `{via:"read", writer, channels}`, `{via:"control", writer,
  decidedBy, channels}` — first writer wins, as membership does today. At a `taint` escalation
  `#decide` walks the map from each tainted read back to a root (bounded by the channel count,
  derived, nothing stored) and puts the chain in `policy.escalated.detail`. Nothing reads `detail`
  back, so an old journal folds unchanged. **The implementer must NOT write a second copy of the
  predicate**: `applyTaint` records the cause where it adds the member, `#decide` reads it. One hop
  is not enough — it does not reach the sentence above that is missing.

---

## 4 · The paths, all now closed

| path | rows at `7fd4537` | mechanism |
|---|---|---|
| **RC-2 unsound** — a node two taken edges both reach is in nobody's exclusive reach; `couldHaveNotFired`'s `untaken > 0` premise is false | five live injection paths (`twoarms`, `routertwo`, `twocond`, `routerall`, `ornone`), each `succeeded gates=0 charged=1` with the counterfactual `charged=0` | the subtraction side for a taken edge `e` must be `alternatives ∪ alsoRan` — the OTHER TAKEN edges are not alternatives to `e`; the choice took them too. The sound predicate is *some OTHER outcome of the same decision omits this edge*: for a router, any case or fallback whose `take` excludes it; for a producer-supplied take, always |
| **`errfan`** — a clean fan (width 2) whose body reads the page and THROWS iff it says PAY; join `mode:"all", onBranchError:"skip"`, arms on `!has(parts)` | dirty `succeeded gates=0 charged=1` · page-safe `awaiting_gate gates=1` · clean `charged=1` | a FAILED body writes nothing, so `parts` never enters `tainted`, and the join's `when` references a clean channel. "Suppressing every write is how you get an attacker-chosen value that is clean" — emptied by failure instead of by width; the branch had closed the width form only |
| **`errthrow`** — `decide` reads the page and throws iff PAY; one catch-all `error` edge → charge, one `seq` → skip | dirty `succeeded gates=0 charged=1` · page-safe `failed charged=0` · clean `charged=1` | `choiceOf` drops `error` edges from the space, so `unconditional=[seq]`, the space is empty and nothing is marked. **The "producer-supplied failure" bit cannot close this** — no producer exists here, so the bit is `false` and the row stays open |
| **`mutedge5`** — `fetch → route(page) → {agent \| skip} → done --conditional(never)--> charge`; the agent proposes `addNodes:[x], addEdges:[agent→x, x→charge]` | dirty `succeeded gates=0 charged=1` · page-safe `failed E_OUTPUT_MISSING charged=0` | `#applyMutation` consults neither `tainted` nor `controlTainted`; `controlRegion` ran once at `route`'s commit against the pre-mutation graph. **Already refused on `loom` by MUT003's dominator rule**, byte-identical on all three arms |
| **Member seven** (the journal's ninth violation) — `fanout_skipped_gate` raised once in `#fireEmptyJoin`, appended in a separate transaction, never re-derived | escalation append kept: second process `awaiting_gate gates=1 charged=0`; append LOST: second process `succeeded gates=0 charged=1` | fold the escalation from `fanout.planned` (durable; carries `width`, appended in the same batch AFTER the planner's `task.committed`) in `#restoreEvidence`. `fanout.planned.nodeId` is `e.to`, the fan body's head, NOT the planner. Safe to re-raise because `ctx.policy.restore` runs before `#restoreEvidence` and `PolicyEngine.escalate` is idempotent |

All are closed on `loom`: `test/run/taint-failed-commits.test.ts` (`errfan`, `errthrow`),
`test/run/control-flow-taint.test.ts` (RC-2, `mutedge5`) and `test/run/empty-fanout-oversight.test.ts`
(member seven) are the pins, and `TODO.md` §A0.16 records the closure. **`#runSubgraph`'s direct
`ctx.tainted.has` — a delegation seeded from a fan binding, which that set does not answer — was
also closed**: the seed asks `taintedOn` now (`engine.ts:8062`), pinned by "A DELEGATION SEEDED FROM
A FAN BINDING CARRIES THE TAINT TOO" in `empty-fanout-oversight.test.ts`.

**The residue is the fourth, latent one.** `#irreversibilityOf` folds `reachableToolNames`, which
does not descend into a subgraph, so a control-tainted `subgraph` node is `read_only` and E8 never
fires at it. It is judged "not currently a hole" on the POSTURE argument — the child run carries its
own class floor, so the call gates in the child. **It opens the moment a human de-escalates the
child run.**

---

## 6 · Recommendation (taken)

**Keep the run-global monotone sink. Close RC-6 as "measured; not a scope defect."** Three lines:
(1) the two sink scopes that change a measured answer each reopen an exploit the tree has already
paid to close — hiding writes reopens `pickwriter`/`fanplanner`, discounting them as evidence
reopens `laund2` — and both do so by construction; (2) the scope that does not cannot be
distinguished from the global one on any graph without a fan-out, and is the same thing inside one;
(3) the cost is confined to one shape — a hard-to-undo reader of a channel whose writer the page
selected — which is the exploit shape however ordinary the graph around it is.

---

## 7 · Files, and the kernel

The changes were all `fix` by subject, and `journal/events.ts` typed nothing new
(`policy.escalated.detail` is `Record<string, unknown>`, so a cause would be new keys in an existing
free-form field). **But new journal vocabulary is capability whatever the subject says**: the branch
gained `run.submitted.taintedInputs` and `task.committed.takeSuppliedByProducer` with specified
absent-readings, plus the `fanout_skipped_gate` escalation rule E12. The recommendation — taken —
was that **the merge commit carry a `Kernel-seam:` trailer naming all three**, so the ledger the
guard prints records them. The guard does not require it on a `fix`; the ledger is worth more than
the rule. `fbbdac4` is that commit.

Two docstrings the global sink makes false, corrected in the same change: `RunContext.tainted`
("Channels written by a tool" — it also holds channels written by control-selected `function`s and
by readers of tainted channels), and the E8 comment above `#decide`'s site, which described two
sources where there are four.

---

## 9 · Acceptance exam, and what is NOT ported

1. **The probes refuse.** Each of the audit's four, the two RC-1 rows (`pickwriter`, `fanplanner`),
   the five RC-2 rows, `laund2` and `cascade{2,3,4}-actsOnOutput`, and `errfan`/`mutedge5`/`errthrow`:
   dirty arm `awaiting_gate`, `gates ≥ 1`, `charged = 0`; the page-says-safe counterfactual
   `charged = 0`; the clean arm (`branchOn: "request"`) `charged = 1`.
2. **The ordinary graphs do not move.** **Read the examples for what they are:** no example graph
   has a `conditional`, `router` or `loop` edge, so they exercise the fan-width rule and nothing
   else here. The ordinary evidence with a branch in it is the 39-shape corpus's clean arms — every
   `branchOn: "request"` row in `control-flow-taint.test.ts` and `empty-fanout-oversight.test.ts`.
   `incident-triage` (11 nodes, a fan over tool output) is the largest ordinary graph in the tree
   and the one whose column moving would matter most.
3. **fold == live.** Every prefix of every corpus journal, rebuilt in a fresh Engine and driven to a
   stop, must agree with the single-process reference on status, gate count, gate nodes, escalation
   set and charge count. **NOT ported.** The sweep that measured 2,994 rebuilds with 0
   disagreements was a scratch file importing a worktree by absolute path; the branch's own restart
   pins are three tests in `control-flow-taint.test.ts`. A bounded version — every prefix of the
   39 × 2 corpus, or a sampled subset with the seed fixed — belongs in `test/run/`, offline, with
   no timing assertion. **This is the largest piece of unported evidence in the taint work.**
4. **A journal the previous binary wrote folds**, with `gates ≥` the original and never fewer.

---

## 10 · Non-goals

- Making `tainted.size` small. It is not consumed; a channel count is not a gate count.
- A declassification operator, flow-sensitive taint, or full provenance. Each costs more than it
  changes on the ordinary set.
- **Separating a content-caused throw from an always-throw.** No fold over the journal can, so
  `errordinary` (ordinary error handling) gates, and that is pinned as the price.
- Re-deriving the region computation. RC-2 was a change to one side of one subtraction.
