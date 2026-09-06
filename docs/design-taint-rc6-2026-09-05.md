# RC-6 — the scope of the taint sink

**Status: design only. Nothing here is built, and no source file changed for it.** Written
2026-09-05 for the implementer who resumes `phase1-taint`, against three trees: the branch head
`7fd4537` (16 commits on `a638e7d`), its base `a638e7d`, and `loom` at `294e713`. Every number
below is the output of a command that was run on one of those trees; the commands are given.
Two reviewers read the first draft with instructions to refute it (§11).

The one-paragraph result, so the rest can be checked against it: **RC-6 as written is not a scope
defect.** The set that "saturates" is doing implicit-flow propagation — a channel whose WRITER an
attacker selected is a channel an attacker influenced — and that propagation is the mechanism
two confirmed exploits (`pickwriter`, `fanplanner`) require. The named fix, "a branch-scoped
sink on the `taintedOn` model", cannot be expressed: `BranchCoordinate` carries fan-out segments
only, so every router arm shares one coordinate. The maximal scoping (control-derived writes
never reach the global set) was built in a scratch tree and measured: it restores the base
numbers and reopens exactly those two exploits. A second, subtler scoping — keep the writes
tainted but let them seed no new choice — was built by a reviewer: it passes every pinned test
and reopens two-router laundering (§5G). The recommendation is therefore to keep the run-global
sink, make its cost legible, and spend the branch's remaining effort on the items that ARE
defects — RC-2 (five live injection paths at head), member seven, and three injection paths the
reviewers found that are live at `loom` today (§4) — then merge the branch, which trial-merges
onto `loom` with three adjacent-addition conflicts and a 3,315/3,315 suite.

---

## 1 · The problem as a data-flow statement

### 1.1 The three sets, who writes them, who reads them

All three live on `RunContext` (`engine.ts` at the branch head, lines 953–1016) and are
**run-global and monotone**: written from seq 1 forward, never cleared, rebuilt by
`#restoreEvidence` folding `task.committed` in seq order.

| set | key | written by | read by |
|---|---|---|---|
| `tainted: Set<channel>` | channel name | `applyTaint` at every commit (`#recordEvidence` live, `#restoreEvidence` fold); `submit` seeds it from `run.submitted.taintedInputs` | `taintedOn` (the per-branch reader), via `taintedFor` → E8 in `#decide` (4469), `taintedTurn` (function 9149, call site 7097), `applyTaint`'s own guard (9259), `applyFanoutTaint` (9296), `fanoutWidthEvidence` (9391), `choiceTainted` (9748, 9768); and two DIRECT reads that bypass `taintedOn`: `choiceTainted`'s `.size` short-circuit (9745, harmless — it also tests `taintedFans.size`) and `#runSubgraph`'s `ctx.tainted.has(parentCh)` (6426), which ignores `taintedFans`, so a child input mapped from a fan's `as` binding inside a tainted fan is NOT seeded on the child's `run.submitted.taintedInputs`. That is a fail-open candidate the implementer must reproduce (§4) |
| `taintedFans: Set<EdgeId>` | fanout edge | `applyFanoutTaint` when the commit that takes a fanout edge finds `over` tainted | `taintedOn`, which walks the asking task's `branch.segments` — the one per-branch answer in the file |
| `controlTainted: Map<NodeId, {decidedBy, channels}>` | node | `applyControlTaint` (region of a tainted choice, 9484), `applyFanoutWidthTaint` (fan body, 9349); first writer wins | E8 in `#decide` (4470), `applyTaint`'s third arm (9258), `fanoutWidthEvidence` (9389), `choiceTainted`'s inherited source (9740), `#fireEmptyJoin` through `fanoutWidthEvidence` |

`applyTaint`'s guard is the whole of RC-1 and RC-6 in three lines (9256–9262):

```ts
if (!isExternal(node) &&
    !ctx.controlTainted.has(node.id) &&           // RC-1's arm: control taint becomes data taint
    !observedChannels(node).some((c) => taintedOn(ctx, branch, c))) return;
for (const channel of Object.keys(writes)) ctx.tainted.add(channel);
```

### 1.2 Where a node-scoped fact becomes run-global

`applyControlTaint` marks a NODE set: `controlRegion` computes the exclusive reach of each
taken edge and the mark stops at the reconvergence — `merge` in a router with two arms is not
marked. When `armA` commits, the second line of the guard fires and every channel `armA` wrote
enters `tainted`, keyed by channel NAME. From that commit on, `taintedOn(ctx, anyBranch, "note")`
is true for every reader on every branch, including `merge`, which `controlRegion` excluded.

That is the sentence RC-6 states. What it does not state is that the exclusion and the taint
answer two different questions. `controlRegion` answers *was this node's EXECUTION chosen* —
`merge` runs whichever arm fired, so no. `tainted` answers *was this node's INPUT influenced* —
`merge` reads `note`, and whether `note` holds `armA`'s value or is unset was the choice, so yes.
Implicit flow is the textbook name. Base did not track it; RC-1 added it because the exploit that
needed it was confirmed blocking (§3.2).

### 1.3 The feedback loop, and what it is made of

`choiceTainted` reads `tainted` through `taintedOn` for every `when`/`until` in the space, so a
condition reading a channel a region wrote is a tainted choice, which marks a region, whose writes
enter `tainted`, and so on. Each step is a node reading a value whose writer the previous step's
choice selected. Nothing in the loop reads a channel the attacker did not influence under
implicit-flow semantics; §3.1 shows the graph that measured it.

---

## 2 · The saturation, reproduced

The round-5 attacker's probe (`attack5c.ts`: N stages of "always continue, and also do the
optional step if the previous stage says so", the first `when` reading the fetched page, every
later one reading the previous stage's output; the charge reads `request` or, in the
`-actsOnOutput` arm, the last stage's output) was copied unmodified into a `git archive` of each
tree, with a one-line hook exposing `RunContext` (the attacker's method; no source of any tree
was otherwise changed):

```
$ for t in a638 phase1 loom; do (cd trees/$t && node packages/core/test/run/attack5c.ts); done
```

| graph | channels | a638e7d | phase1 head 7fd4537 | loom 294e713 |
|---|---|---|---|---|
| cascade1 | 5 | tainted 2 · gates 0 · charged 1 | tainted **4** · ctrl 1 · gates 0 · charged 1 | tainted 2 · gates 0 · charged 1 |
| cascade2 | 7 | 2 · 0 · 1 | **6** · 2 · 0 · 1 | 2 · 0 · 1 |
| cascade3 | 9 | 2 · 0 · 1 | **8** · 3 · 0 · 1 | 2 · 0 · 1 |
| cascade4 | 11 | 2 · 0 · 1 | **10** · 4 · 0 · 1 | 2 · 0 · 1 |
| cascade1-actsOnOutput | 5 | 2 · 0 · 1 | 3 · 1 · **gates 1 · charged 0** | 2 · 0 · 1 |
| cascade4-actsOnOutput | 11 | 2 · 0 · 1 | 9 · 4 · **gates 1 · charged 0** | 2 · 0 · 1 |

Head's set at cascade4: `c0..c3, o0..o3, receipt, untrusted` — every stage output. Base and loom:
`receipt, untrusted` at every length. The handoff's "base 2, head 10 of 11" reproduces exactly.
`loom` is identical to `a638e7d` here: wave 1 did not touch the taint code.

The seven-shape probe (`attack5.ts`, same trees) shows the same growth: `alsocontinue`,
`pollloop`, `fan`, `nestedfan` each carry one or two more channels at head than at base;
`routerconverge` carries `note` at head and not at base. Its gate column says nothing: the
probe's sink is `notes.write`, `irreversibility: "reversible_write"`, and E8 fires only for
`isHardToUndo` (`vocab.ts:158`), so that column cannot move in any tree by construction. The
maintainer reviewer rebuilt two of its shapes with `pay.charge` as the sink and a page with no
injection in it (`probes/maint-review/maint-overgate.ts`):

| graph (no attacker; the router reads the fetched page) | a638e7d | 7fd4537 | 294e713 |
|---|---|---|---|
| `router-merge-reads-arm` — arms write constants, `merge` reads the arm's channel, then charges | succeeded · 0 · charged 1 | **awaiting_gate · 1 · 0** | succeeded · 0 · 1 |
| `optional-step-then-act` — the conditional variant | succeeded · 0 · 1 | **awaiting_gate · 1 · 0** | succeeded · 0 · 1 |
| `router-merge-reads-arm-clean` — the router reads `request` | identical in all three | | |
| `triage-shape` — the charge is inside the arm | awaiting_gate · 1 in all three (control taint is not new) | | |

**Two ordinary graphs move at head.** Both are `pickwriter`'s shape with the reader renamed
(§3.1); they are the cost of A, and §9 lists them as rows that gate and are accepted, not as
rows that must not move. The first draft of this document said "zero gate moves on the ordinary
set" and that sentence was false — it was a property of the suites it named, none of which puts
a hard-to-undo reader downstream of a page-selected writer.

---

## 3 · What the saturation is

### 3.1 The cascade is `pickwriter` with more hops

In `cascade-actsOnOutput` the page decides whether `opt0` runs; `opt0` is the only writer of `o0`;
`st0` reads `o0` and writes `c0`; the charge reads `c3`. The engine never sees a body, so it cannot
know `st0` writes a constant. A body `c0 = o0 ? 9999 : 1` is the same journal, and with it the
page sets the amount. That is the confirmed-blocking `pickwriter` finding — "the attacker picks
WHICH of two CLEAN nodes writes a channel the charge reads" — with the chain lengthened. The
root-cause note's own over-gating example, "a router with reconverging arms whose merge reads
what the arm wrote", is `pickwriter`'s graph with the charge renamed `merge`. No fold over the
journal separates the two; the only difference is whether the reader is hard-to-undo, and E8
already fires for hard-to-undo readers only.

### 3.2 The maximal scoping, built and measured

The strongest form of any region- or branch-scoped sink is "a control-selected node's writes
never enter the global set" — every scoping proposal is a subset of it. Built in a scratch copy of
the branch head by deleting the middle line of the guard in §1.1, nothing else changed:

```
$ cd trees/noarm && node --test packages/core/test/run/control-flow-taint.test.ts \
    packages/core/test/run/empty-fanout-oversight.test.ts packages/core/test/graph/mutation-dominator.test.ts
✖ A FAN PLANNER BELOW A RECONVERGENCE STILL FANS AT THE ATTACKER'S WIDTH
✖ A NODE THAT RAN ONLY BECAUSE A TAINTED CHOICE SELECTED IT WRITES THE ATTACKER'S BYTES
ℹ tests 57 · pass 55 · fail 2
$ node packages/core/test/run/attack5c.ts      # cascade4: tainted 2/11, gates 0, charged 1 — base's numbers
```

Both reopened rows have their reader AT the reconvergence: `pickwriter`'s charge and
`fanplanner`'s `plan` are outside every region by construction. Any sink that HIDES a region's
writes from readers outside the region hides them from exactly these two.

There is a second way to lose that hides nothing, and the first draft of this document did not
see it: keep the writes tainted for every reader, but do not let a control-derived channel count
as EVIDENCE for a later choice (`choiceTainted` ignores it). §5G has the numbers: every pinned
test passes, `pickwriter` and `fanplanner` stay closed, and two-router laundering at one remove
(`laund2`: the router at the reconvergence reads the arm's write) reopens with `gates=0`, as does
the cascade from two stages up. So the sink has two obligations, not one — a region's writes
must reach readers outside the region, AND must be able to make a later choice tainted — and the
pinned suite tests only the first. §9.1 adds rows for the second.

### 3.3 The named mechanism cannot express the named scope

`ids.ts:112`: `BranchSegment = { edgeId, index }`, pushed by `childBranch` from `#branchReady`
alone — a segment IS a fan-out branch. `encodeBranch` of the cascade's every task is `root`.
`taintedOn(ctx, branch, ch)` therefore partitions readers by fan-out membership and by nothing
else; keying control-derived writes the way `taintedFans` is keyed distinguishes `armA` from
`merge` in no graph without a fan-out, which is every graph in §2. DESIGN.md D4 records the
earlier attempt to key the whole taint set by coordinate and its reversion (`f74d863`): under
fan-out, sibling arms taint identically, so the key buys precision nothing observes.

### 3.4 What is left of RC-6

Two things, neither a scope defect:

- **The cost is real and is the price of implicit flow.** It is bounded by E8's consumer rule
  (hard-to-undo readers only) and it is paid exactly by graphs in which a hard-to-undo node reads
  a channel whose writer a fetched page selected — §2's second table names two, and the
  suites the tree already has contain none (§9.2). DESIGN.md D4 chose this: FIDES-style
  most-restrictive propagation, with "once untrusted content enters, the whole run is
  untrusted" named as the accepted cost. A is D4 applied to control flow.
- **The cost is illegible.** An operator asked to approve `charge` in cascade4 sees
  `policy.escalated{reads:["c3"]}` and nothing that says `c3` is untrusted because a page four
  stages back chose whether `opt0` ran. That is fixable without touching the sink (§6).

---

## 4 · The three open items, measured at the branch head

| item (phase1-root-cause.md) | status at 7fd4537 | measurement |
|---|---|---|
| **RC-6** — region bounds the mark, not the taint | **reproduces as described; reclassified by this document** (§3) | §2 table; §3.2 |
| **RC-2 unsound** — a node two taken edges both reach is in nobody's exclusive reach; `couldHaveNotFired`'s `untaken > 0` premise false | **OPEN — five live injection paths, `gates=0`, charge made** | `node --test attack5-exclusive-reach/{twoarms,twocond,couldhave}.test.ts` against the head worktree: `twoarms` and `routertwo` (producer / router naming two of three edges, both reaching the charge): dirty `succeeded gates=0 charged=1`, page-says-safe `charged=0`, clean `charged=1`. `twocond` (two taken conditionals, no producer): same three rows. `couldhave`: `routerall` (one case taking both declared edges, fallback takes one) and `ornone` (a body whose take is its single `seq` edge or nothing) both `succeeded gates=0 charged=1` with the counterfactual `charged=0`. Five of five reproduce. |
| **Member seven** — `fanout_skipped_gate` raised once in `#fireEmptyJoin`, appended in a separate transaction, never re-derived | **OPEN** | `node attack5-restart-and-boundary/p5-crash-before-escalation.ts`: `escalation append kept: … second process: awaiting_gate gates=1 charged=0` · `escalation append LOST: first process: ADVANCE THREW … second process: succeeded gates=0 charged=1`. |

The attacker reviewer of this document found three more, each driven the standard three ways
(dirty / page-says-safe / clean) at the branch head and at `a638e7d`, so **all three are live at
`loom` today** and none is a regression of the branch (probes under
`scratchpad/probes/rc6/`, re-run by the author):

| path | rows at 7fd4537 | mechanism |
|---|---|---|
| **`errfan`** — a clean fan (width 2 from `request`) whose body reads the page and THROWS iff it says PAY; join `mode:"all", onBranchError:"skip"`; join arms `when: !has(parts)` → charge, `has(parts)` → skip | dirty `succeeded gates=0 charged=1` · page-safe `awaiting_gate gates=1` · clean `charged=1` | `fanoutWidthEvidence` is undefined (planner clean, list clean) so the join is not marked; a FAILED body writes nothing, so `parts` never enters `tainted`; the join's `when` references a clean channel. RC-1's R2 row ("suppressing every write is how you get an attacker-chosen value that is clean") emptied by failure instead of by width — the branch closed the width form only. |
| **`mutedge5`** — `fetch → route(page) → {agent \| skip} → done --conditional(never)--> charge`; the agent (in `route`'s region) proposes `addNodes:[x], addEdges:[agent→x, x→charge]` | dirty `succeeded gates=0 charged=1` · page-safe `failed E_OUTPUT_MISSING charged=0` · clean `charged=1` | MUT003 admits it (an added node is an endpoint, `charge` has no oversight-bearing dominator); `#applyMutation` consults neither `tainted` nor `controlTainted`; `controlRegion` ran once at `route`'s commit against the pre-mutation graph, where `charge` was in both arms' reach. `choiceTainted`'s third source covers the agent's writes and not its mutation. |
| **`errthrow`** — `decide` reads the page and throws iff PAY; one catch-all `error` edge → charge, one `seq` → skip | dirty `succeeded gates=0 charged=1` · page-safe `failed charged=0` · clean `charged=1` | `choiceOf` drops `error` edges from the space; `unconditional=[seq]` so the space is empty and nothing is marked. The branch's `failing` row (`control-flow-taint.test.ts:1712`) is the same journal with an always-throwing body, so the pinned counterfactual cannot see the difference. §10's first draft said this hole needs a "producer-supplied failure" bit; no producer exists here, so that bit is `false` and leaves the row open. |

Fixes, each fold-derivable from `task.committed` / `graph.mutated` and each with an over-gating
price to pin: (`errfan`) a FAILED commit by a node that read a tainted channel or is
control-tainted taints its DECLARED `writes` (the fold has `status:"failed"` and `node.writes`),
or the join is control-marked when any skipped branch read tainted; (`mutedge5`) in
`#applyMutation`, when the proposer is control-tainted or read tainted, every added node and
every node newly reachable through an added edge takes the proposer's `ControlTaint`, folded from
`graph.mutated` — or the mutation is refused with a `taint` escalation; (`errthrow`) a failed node
that read tainted content or is control-tainted makes its error take a tainted choice over
`{error edges} ∪ {normal edges}`, and `errordinary` (`:1673`'s ordinary error-handling row) is
the price to measure and pin. A fourth, latent: `#irreversibilityOf` uses `reachableToolNames`
(`spec.ts:1084`, no descent into a subgraph), so a control-tainted `subgraph` node is `read_only`
and E8 never fires at it, and `#runSubgraph:6426` seeds the child from `ctx.tainted` alone, so the
child's fold cannot learn it was attacker-selected. Closed today by the child's own class floor
(`subctl3`: `gates=1` dirty and clean); it opens the moment a human de-escalates the child run.

The handoff's "three items" are therefore one reclassification, two defects, and — after
review — three more live paths plus one latent. The two named defects have fixes in
`phase1-root-cause.md` and none of the five depends on the sink's scope:

- RC-2: the subtraction side for taken edge `e` must be `alternatives ∪ alsoRan` — the OTHER
  TAKEN edges are not alternatives to `e`; the choice took them too. `couldHaveNotFired`'s second
  clause asks the wrong question. The sound predicate is *some OTHER outcome of the same decision
  omits this edge*: for a router, any case or the fallback whose `take` excludes it (`routerall`
  at `control-flow-taint.test.ts:1834` is a ROUTER whose fallback takes a strict subset — the
  router chose, `untaken === 0` notwithstanding); for a producer-supplied take, always (the
  producer could have named fewer, including none — `ornone`). The test at `:1834` that blesses
  the exemption is the one to invert. The handoff measured that the naive form reopens one over-gating row; the
  implementer should expect that row and pin it.
- Member seven: fold the escalation from `fanout.planned` (durable; `edgeId`, `parentBranch`,
  `nodeId`, `width`) in `#restoreEvidence` — `width === 0` plus `fanoutWidthEvidence` plus
  `fanBody ∩ carriesOversight` is the same predicate `#fireEmptyJoin` evaluates. Three facts the
  implementer needs: `fanout.planned.nodeId` is `e.to`, the fan body's head, NOT the planner
  (`engine.ts:8203`), so the planner is `edgeById.get(edgeId).from` or
  `parseTaskId(ev.taskId).nodeId`; the event carries the planner's `taskId` and is appended in the
  same batch AFTER that task's `task.committed` (7613 → 7669), so the fold has `controlTainted`
  and `tainted` as of the planning commit — the new arm goes before the
  `if (!isEvent(ev, "task.committed")) continue` line, which today skips it; and re-raising from
  the fold is safe because `ctx.policy.restore` (2168) runs before `#restoreEvidence` (2188) and
  `PolicyEngine.escalate` is idempotent (`policy.ts:654`), so a fold re-raise appends only when
  the original append was lost. Also to reproduce: `#runSubgraph:6426`'s direct
  `ctx.tainted.has` (§1.1) — a fan binding is not in that set.

---

## 5 · Alternatives for the sink's scope

Judged against: the four injection probes of the audit (`control-region-empty-alternatives`,
`narrowed-proof-defeated-by-one-seq-edge`, `fanout-width-chooses-whether-and-how-often`,
`loop-until-multiplies-charges`; `mutation-grafts-around-a-human-gate` is `graph/mutate.ts` and
touches no taint set) plus the two RC-1 exploits the sink's scope actually decides (`pickwriter`,
`fanplanner`); the ordinary half (39-shape corpus clean arms, `examples/graphs`,
`workflows/incident-triage`); the fold; replay; cost.

### A · Run-global monotone set with the control→data arm (the branch head)

- **Closes:** all four probes (closed by `controlRegion`/`choiceOf`/`applyFanoutWidthTaint`,
  not by the sink) and both RC-1 exploits.
- **Over-gates:** a hard-to-undo node reading a channel whose writer a fetched page selected, at
  any distance — §2's `-actsOnOutput` column and the two `maint-overgate` graphs. Measured: 0
  moves in `examples/`, `incident-triage` (whose sinks are posture `in` by tool class and gate in
  every tree regardless) and the corpus's clean arms; 2 moves in the shape those suites do not
  contain. The saturation itself is a channel COUNT, not a gate count; nothing consumes
  `tainted.size`.
- **Fold:** `#restoreEvidence` replays `applyTaint` then `applyControlTaint` per
  `task.committed`, same order as live. Journal fields: `task.committed.{writes, external,
  take, takeSuppliedByProducer}`, `run.submitted.taintedInputs`. Absent
  `takeSuppliedByProducer` folds `true` (fail closed); absent `taintedInputs` folds empty
  (exact for this binary's journals; measured 43 tests fail under the other reading — the field's
  own docstring). Verified fold == live over 2,994 prefix rebuilds (round 5, scratch harness).
- **Replay:** derived from the journal; nothing recorded.
- **Cost:** one `Set` lookup per read; already paid.

### B · Branch-scoped per `taintedOn` — the handoff's named fix

Control-derived writes recorded as `(fanout-edge-of-the-writing-branch, channel)` and consulted
by walking the reader's `branch.segments`, as `taintedFans` is.

- **Closes:** nothing A does not. **Reopens:** nothing in the corpus — because it changes no
  answer in it. Every task of every §2 graph is at `root`; a segment exists only inside a fan-out
  (§3.3). Inside a fan-out, sibling branches run the same nodes, so a write control-tainted in
  branch 3 is control-tainted in branch 5 — `controlTainted` is node-keyed and applies to all.
  The only reader B distinguishes is a node OUTSIDE the fan reading a branch-held write, and no
  such reader exists: held writes reach the outside only through the join's fold, which the join
  (in `fanBody`, marked) performs.
- **Over-gates:** as A.
- **Fold / replay:** as A, keyed on `BranchCoordinate`, which `task.committed.taskId` carries.
- **Cost:** a second map and a second walk per read, for no change in any measured answer.
  DESIGN D4 reverted this exact key once for this exact reason.

### C · Region-scoped: a region's writes are untrusted for readers inside the region only

The mark's node set becomes the taint's audience: `tainted` becomes `Map<channel, Set<NodeId> |
ALL>`, control-derived entries carry the region, `taintedOn` gains the reader's node id.

- **Closes:** the four probes (untouched). **Reopens `pickwriter` and `fanplanner`** — §3.2 is
  the upper bound on what any C can do, and both readers sit at the reconvergence. Also reopens
  the two-router laundering shape at one remove: a router at the reconvergence reading `note`
  is a clean choice under C.
- **Over-gates:** returns to base's numbers.
- **Fold:** derivable (the region is `controlTainted`'s `decidedBy` groups). **Replay:** as A.
- **Cost:** a reader parameter threaded through every `taintedOn` call; the escalation detail
  loses the ability to say why a channel is hot for THIS reader.
- **Verdict:** unsound against two confirmed findings. Not a candidate.

### D · Flow-sensitive: a channel's taint is its LAST VISIBLE writer's taint (per-(branch, iteration))

Instead of monotone membership, the fold records for each channel the provenance of the write
currently visible in the reader's scope. A trusted overwrite clears; a loop's iteration k+1
rewriting `status` from a clean read is clean again.

- **Closes:** four probes and both RC-1 exploits (the visible writer is still the selected node).
- **Over-gates less than A** in exactly one shape: tainted-then-overwritten channels. Not in the
  cascade (every write there is influenced). Only `replace` channels have a single visible writer;
  `append`/fold reducers accumulate every contributor, so D degrades to A there — and every fan
  body channel is one of those (`GRAPH010_CONCURRENT_WRITE`).
- **Fold:** derivable from `task.committed` in seq order plus `scopeFor`'s visibility rule
  (branch-held writes; wave 1's `#withBranchWrites` at `294e713:8399` is the live half of the same
  rule). **Replay:** as A. The `waveTaint` overlay stays derived.
- **Cost:** the fold must track per-channel last-writer per branch; a decision that today asks a
  `Set` asks the projection. It is also declassification by overwrite, which `RunContext.tainted`'s
  docstring refuses in writing ("deliberately no declassification operator") and which a
  `function` body that copies a tainted value into a fresh write does not trigger anyway
  (`applyTaint` taints the copy). Gain not observable on any measured shape.

### E · Per-task provenance with explicit propagation edges

Each committed task records `provenance = ⋃ provenance(read channels' visible writers) ∪
{self if external or control-selected}`; a channel's taint at a read is the provenance of its
visible write. The full information-flow graph, per TaskId.

- **Closes:** everything A does; adds nothing at the gate — E8 fires on the same set of
  hard-to-undo readers, because "influenced by something untrusted" is a monotone property of the
  chain and E is A with the chain remembered.
- **Over-gates:** identical to A (same predicate), less by D's overwrite case if visibility is
  flow-sensitive.
- **Fold:** derivable — but the provenance per task is the thing worth recording as a
  `policy.escalated{detail}` chain, and there it becomes new journal vocabulary. **Replay:** as A.
- **Cost:** a map of TaskId → Set<TaskId> that grows with the run; the `nestedfan` and
  `fan-out 3200` shapes make it quadratic in branch count unless bounded to the escalation's
  chain. `projection.ts`, `events.ts`, `engine.ts` all pinned.
- **Where E earns its cost:** legibility (§3.4). The chain — `decidedBy: route ← untrusted ←
  fetch` — is what an approver needs and what A cannot say. It can be obtained without E's
  full map: `ControlTaint.channels` already names the evidence at the deciding node, and
  `tainted` can carry `{channel → decidedBy | external writer}` for one hop.

### F · Author declassification

A node declares a read it trusts (`trusts: ["o0"]`), or an output it vouches for, as
`effects: []` vouches for origination.

- **Closes:** the probes (untouched). **Reopens:** whatever the author declassifies; a `canMutate`
  agent's mutation adding a declassifying node is a route around every guard unless
  `compileMutation` refuses the field on added nodes.
- **Over-gates:** exactly as much as the author wants — which is the point and the danger.
- **Fold / replay:** graph-derived. **Cost:** a spec field (`graph/spec.ts` pinned), a compile
  rule, a mutation rule. DESIGN D4 and `RunContext.tainted` both refuse this direction; the
  argument for it is that the author already makes this decision for origination.

### G · Run-global membership, but control-derived channels are not choice evidence

Built by a reviewer of this document (`probes/variant-tree`): `applyTaint` adds a region's
writes to `tainted` as A does, and additionally to a `ctrlDerived` set; `choiceTainted` skips
channels in `ctrlDerived`; a later external or data-tainted write to the channel removes it from
`ctrlDerived`. The intent is to cut §1.3's loop at the control→control step while keeping every
reader's data taint.

- **Closes:** the four probes and both RC-1 exploits — `pickwriter`'s and `fanplanner`'s readers
  are data readers, not choices. `control-flow-taint` + `empty-fanout-oversight` +
  `mutation-dominator`: **57/57**.
- **Reopens:** two-router laundering at one remove. `laund2` (`fetch → route(page) → {a | b} →
  route2` where `route2` reads `note`, which only `a` writes, and picks the arm with the charge):
  head `awaiting_gate gates=1`; G `succeeded gates=0 charged=1`. And the cascade from stage 2 up:
  `cascade{2,3,4}-actsOnOutput` head `awaiting_gate`, G `succeeded charged=1`, `tainted 4/11` at
  every length. The value `route2` branches on exists or not because the page chose; G calls that
  a clean choice.
- **Over-gates:** less than A by exactly the reopened rows.
- **Fold / replay:** derivable; the extra set folds from the same events.
- **Verdict:** unsound, and the more dangerous of the two unsound scopes because the tree's
  pinned suite cannot see it. It is the reason §9.1 gains `laund2` and the cascade rows.

---

## 6 · Recommendation

**Keep A. Close RC-6 as "measured; not a scope defect", with §2 and §3.2 as the record.**
Rationale in three lines: (1) the two sink scopes that change a measured answer each reopen an
exploit the tree has already paid to close — C reopens `pickwriter`/`fanplanner` by hiding
writes, G reopens `laund2` by discounting them as evidence — and both do so by construction; (2) the scope that does not (B)
cannot be distinguished from A on any graph without a fan-out and is A inside one; (3) the
cost of A is confined to one shape — a hard-to-undo reader of a channel whose writer the page
selected — which is the exploit shape however ordinary the graph around it is, and every suite
the tree has today measures 0 moves because none contains it (§2, §9.2).

Then, in order, on the branch:

1. **RC-2.** `controlRegion`'s subtraction side excludes the other TAKEN edges; `couldHaveNotFired`
   becomes "some other outcome of this decision omits the edge" — for a router, a case or the
   fallback whose take excludes it; for a producer, always (§4) — and
   `control-flow-taint.test.ts:1834` is inverted. Pin the five §4 probes as tests that FAIL at
   `7fd4537`. Expect and pin the one over-gating row the handoff measured.
2. **Member seven.** Fold `fanout_skipped_gate` from `fanout.planned` in `#restoreEvidence`; pin
   with a store that drops the `policy.escalated` append (the p5 probe's shape). Add it to the
   enumeration in `oversight-survives-restart.test.ts`'s header as the ninth member — CLAUDE.md
   counts eight and this is the same class.
2b. **The three reviewer-found paths** (`errfan`, `mutedge5`, `errthrow`, §4) — each a
   propagation gap, not a scope question, and each live at `loom` today. Fix in the order given
   there; pin each with its three rows and its over-gating row. They are prerequisites for
   calling the branch's security half closed, which the handoff did.
3. **Legibility (A's real debt).** `tainted` becomes `Map<channel, Cause>` with the SAME
   membership, where `Cause` has one arm per way a channel enters the set — the four arms of
   `applyTaint`'s guard plus the seed: `{via:"external", writer}`, `{via:"seed"}` (a child's
   `taintedInputs`), `{via:"read", writer, channels}` (the writer read tainted channels — the
   common case, and how `c0..c3` enter in the cascade), `{via:"control", writer, decidedBy,
   channels}` (the writer was in a region). First writer wins, as membership does today. At a
   `taint` escalation `#decide` walks the map from each tainted read back to a root
   (`external`/`seed`/`control`) — bounded by the channel count, derived, nothing stored — and
   puts the chain in `policy.escalated.detail`: for cascade4, `c3 ← st3 read o3 ← opt3 selected
   by st2's choice on c2 ← … ← opt0 selected by fetch's page`. Nothing reads `detail` back
   (`#onEscalate` only writes it), so an old journal folds unchanged and the fold rebuilds the
   map from the same events. The implementer must NOT write a second copy of the predicate:
   `applyTaint` records the cause where it adds the member; `#decide` reads it. One hop was the
   first draft's proposal and the maintainer reviewer showed it does not reach the sentence §3.4
   says is missing.
4. **The prefix-rebuild sweep becomes a test.** It is not on the branch: round 5's 2,994
   rebuilds are `attack5-restart-and-boundary/p3-prefix-sweep.ts`, a scratch file importing the
   worktree by absolute path. The branch's own restart pins are three tests
   (`control-flow-taint.test.ts:1152, 1323, 1516`). A bounded version — every prefix of the
   39 × 2 corpus, or a sampled subset with the seed fixed — belongs in
   `test/run/`, offline, no timing assertion.

## 7 · Files, and the kernel

| file | pinned | change |
|---|---|---|
| `packages/core/src/run/engine.ts` | yes | RC-2 in `controlRegion`/`couldHaveNotFired`; member seven in `#restoreEvidence`; cause on `applyTaint`, read in `#decide` |
| `packages/core/src/journal/events.ts` | yes | nothing typed: `policy.escalated.detail` is `Record<string, unknown>` (`events.ts:883` at `294e713`; `:858` at the branch head), so the cause is new keys in an existing free-form field. It is still new journal vocabulary in CLAUDE.md §1's sense — the commit body must name the keys and their absent-field reading, as the phase-2-4 paragraph asks |
| `packages/core/test/run/control-flow-taint.test.ts` | — | five RC-2 pins; invert :1834; cause assertions |
| `packages/core/test/run/empty-fanout-oversight.test.ts` | — | member-seven pin |
| `packages/core/test/run/oversight-survives-restart.test.ts` | — | header enumeration |
| `scripts/kernel.json`, `scripts/surface.json` | — | no change beyond the branch's existing `carriesOversight` export |

Every change above is a `fix` by subject, and CLAUDE.md §1's phase-2-4 paragraph is about
exactly this: the branch's 16 commits carry zero `Kernel-seam:` trailers
(`git log a638e7d..7fd4537 --format='%(trailers:key=Kernel-seam)'`) while `events.ts` gained two
durable fields with specified absent-readings — `run.submitted.taintedInputs` and
`task.committed.takeSuppliedByProducer` — and item 3 adds a third piece of vocabulary. New
journal vocabulary is capability whatever the subject says. **Recommendation: the commit that
merges the branch to `loom` carries a `Kernel-seam:` trailer naming all three** ("the journal
could not say who chose a `take`, which inputs a delegation handed over untrusted, or why a
channel is untrusted; E8's evidence was a set with no edges"), so the ledger the guard prints
records them. The guard does not require it on a `fix`; the ledger is worth more than the rule.
If the implementer instead chooses E (full provenance), that is a larger seam — a per-task map in
`projection.ts` — with the same trailer.

Two docstrings A makes false, to correct in the same change: `RunContext.tainted` (953,
"Channels written by a tool") — at head it also holds channels written by control-selected
`function`s and by readers of tainted channels; and the E8 comment above `#decide`'s site
(~4452), which describes two sources where there are four.

## 8 · Rebase onto `loom`, or re-implement

**Rebase (as a merge). Measured, not estimated.** In a scratch clone:

```
$ git merge-tree --write-tree --name-only origin/loom origin/phase1-taint
packages/core/src/journal/events.ts      CONFLICT (content)  — 1 hunk
packages/core/src/run/engine.ts          CONFLICT (content)  — 2 hunks
escalation.ts, policy.ts, scripts/surface.json — auto-merged
```

All three hunks are two sides ADDING adjacent lines:

1. `events.ts` `run.submitted`: wave 1 added `limits`/`capabilities`; the branch added
   `taintedInputs`. Keep both; the shared `/**` opener above the hunk must be restored on the
   second block (the one line a naive concatenation loses).
2. `engine.ts` `submit`: same two payload additions, same resolution.
3. `engine.ts` `#commit`: wave 1 routes on `this.#withBranchWrites(ctx, p, w.task.branch)`; the
   branch adds `takeSuppliedByProducer` after the `take` line. Keep wave 1's `routing` view and
   pass it to `#edgesToTake`; keep the branch's line after it.

With those three resolutions: `tsc -p packages/core/tsconfig.test.json` clean; the branch's four
suites plus `examples-run` and `incident-triage` 127/127; **full suite 3,315 / 3,315**. Wave 1's
`replay.ts` and `projection.ts` changes do not touch the branch (the branch changed neither).

Why not re-implement: the branch is 1,253 insertions across six source files and 3,279 lines of
tests in four, and the tests are the asset — 39 shapes × 2 arms, each row a measured before/after
the audit's skeptics accepted. The round history is an argument about the region computation, not
about the diff; RC-2's fix is a subtraction-side change inside `controlRegion` and does not
justify discarding the region machinery around it. Re-implementing would re-run rounds 1–4's
learning with no test corpus to catch it.

One consequence of the merge worth stating: at head, an edge `when` cannot read a sibling
branch's held write (it sees `undefined`); after the merge it routes on `#withBranchWrites`'s
view and can. `choiceTainted` still answers correctly because it asks `taintedOn` by channel
NAME, which `applyTaint` filled at the writer's commit whether or not the write was held — a
point for the run-global set that a branch-keyed one would have to re-earn.

Order: merge `loom` into `phase1-taint` first (so the branch's suite runs against wave 1's
engine), then §6 items 1–4 on the branch, then merge to `loom`. Two merges is deliberate:
the RC-2 change must be measured against `#withBranchWrites`' routing view, which did not exist
when the branch's rows were recorded.

## 9 · Acceptance exam

1. **The probes refuse.** Each of the audit's four (`p1-single-conditional`, `p6-narrowed`,
   `p2-fanout`, `p7-loop` under `scratch-audit/`), the two RC-1 rows (`pickwriter`, `fanplanner`),
   and the five RC-2 rows (`twoarms`, `routertwo`, `twocond`, `routerall`, `ornone`): dirty arm
   `awaiting_gate`, `gates ≥ 1`, `charged = 0`; the page-says-safe counterfactual `charged = 0`;
   the clean arm (`branchOn: "request"`) `charged = 1`. Plus the rows that separate A from G:
   `laund2` and `cascade{2,3,4}-actsOnOutput` (dirty `awaiting_gate`). Plus, once §6 item 2b is
   built, `errfan`, `mutedge5`, `errthrow`. Nineteen graphs, three rows each.
2. **The ordinary graphs do not move.** `examples-run.test.ts` + `incident-triage.test.ts`
   = 32/32 at `a638e7d`, `7fd4537` and `294e713` alike; the three runnable examples
   (`fan-out-join`, `guarded-write`, `review-bench`) driven through `main()` exit 0 with
   `status: "succeeded"` in all three trees (a run that stopped on a gate reports
   `awaiting_gate`; the summary carries no `gates` key). After the merge: the same 32, the same
   three summaries. **Read the examples for what they are:** no example graph has a
   `conditional`, `router` or `loop` edge (`fan-out-join`, `review-bench`, `self-review`:
   `fanout/join/seq`; `two-person-approval`: `join/seq`; `guarded-write`: one node), so they
   exercise the fan-width rule and nothing else in this design. The ordinary evidence with a
   branch in it is the 39-shape corpus's clean arms — every `branchOn: "request"` row in
   `control-flow-taint.test.ts` and `empty-fanout-oversight.test.ts` — and `attack5.ts`'s seven
   shapes rebuilt with `pay.charge` as the sink (the shipped probe's `reversible_write` sink
   cannot gate — §2), whose two moving rows are the accepted cost and whose other rows must not
   move. `incident-triage` (11 nodes, a fan over tool output, 17 tests) is the
   largest ordinary graph in the tree and the one whose column moving would matter most.
3. **fold == live.** Every prefix of every corpus journal, rebuilt in a fresh Engine and driven to
   a stop, agrees with the single-process reference on status, gate count, gate nodes, escalation
   set and charge count — the p3 sweep's predicate. Round 5 measured 2,994 rebuilds with 0
   disagreements; the exam is the same sweep on the merged tree, plus the member-seven store.
4. **A journal the previous binary wrote folds.** The `a638e7d` corpus journals
   (`attack5-restart-and-boundary/journals`) resume on the new binary with `gates ≥` the original
   and never fewer (round 5 measured 1,444 cross-binary resumes).
5. `npm run check` exits 0; surface unchanged beyond `carriesOversight`.

**None of rows 1, 3 and 4 is runnable by a fresh agent as written.** The `scratch-audit/`
probes import the MAIN checkout by absolute path (they test `loom`, not the branch or the
merge); `attack5-exclusive-reach/*.test.ts` import the gitignored `wt-phase1` worktree;
`attack5-restart-and-boundary/{p3,p5,corpus}.ts` import `../wt-phase1/`. Every one of them ran
for this document and reproduces, and none is in the repository. The exam is real only when each
is ported under `packages/core/test/run/` (`taint-` prefix), importing `../../src/`, and run on
the merged tree: the four audit probes and the five RC-2 rows as `control-flow-taint` rows, the
p5 store as an `empty-fanout-oversight` row, the p3 sweep as §6 item 4. Row 2's two moving
graphs (`maint-overgate.ts`) port the same way, asserting `awaiting_gate` — they are pins on the
accepted cost, and a later change that makes them pass silently is the loosening direction.

## 10 · Non-goals

- Making `tainted.size` small. It is not consumed; a channel count is not a gate count.
- A declassification operator (F), flow-sensitive taint (D), or full provenance (E). Each is
  recorded with its cost; none changes a measured gate on the ordinary set.
- The error-arm hole is NOT a non-goal any more: §4's `errthrow` shows the "producer-supplied
  failure" bit cannot close it (no producer exists), and the fail-closed rule is named there. What
  stays out of scope is separating a content-caused throw from an always-throw — no fold over the
  journal can, so `errordinary` gates and is pinned as the price.
- `mutation-grafts-around-a-human-gate` (MUT003's dominator rule) is closed on the branch
  (`mutation-dominator.test.ts`). `mutedge5` — a control-tainted proposer's mutation — is a
  different path and is in §4.
- Re-deriving the region computation. RC-2 is a change to one side of one subtraction.

## 11 · Review

Two reviewers read the first draft with instructions to refute it and to default to refuted:
an attacker routing the probes around each alternative (3 blocking, 3 major, all confirmed by
re-running), and a maintainer over-gating the examples under each (1 blocking, 4 major, 3
minor, all confirmed). Every confirmed finding is folded in place above; the ones that changed
the document are §5G and §3.2's second paragraph (the discounting scope), §2's second table (the
"zero gate moves" sentence was false), §4's three live paths, §6 item 3's cause vocabulary, and
§7's kernel-ledger recommendation. The reviewers' probes live under
`scratchpad/probes/{rc6,maint-review,variant-tree}` for this session only; §9 says what must be
ported.
