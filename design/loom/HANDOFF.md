# Handoff

**Read this first, then start working.** It is the re-entry point: where things stand, what is
known to be wrong, what to do next, and what will bite you.

| Want | Read |
|---|---|
| Why a decision was made | `JOURNAL.md` — append-only, newest last |
| A defect's reproduction | `REGISTER.md` — the archive. **Grep it, do not read it** |
| What the system is | `README.md` → `00-OVERVIEW.md` |
| How to work here | this file, *How to work here* + *Traps* |

> **Cite symbols, not line numbers, and never a git SHA.** Everything here points into code
> under active edit; `gates.ts:191` was stale within a week and `HumanGateBroker.raise` was
> not. Nothing in `design/` or `CLAUDE.md` cites a SHA — a corpus that does acquires a silent
> dependency on history never moving, which is what made one history rewrite expensive. Name a
> commit by a fragment of its subject: `git log --oneline --grep='<fragment>'`.
>
> **Every number below carries the command that produced it.** Re-derive rather than believe:
> this table has been wrong in four rows at once, twice, because a number that was true once
> looks exactly like a number that is true.

---

## Where things stand

Measured **2026-08-23**, tree clean, `npm run check` green end to end.

| | Measured | Command |
|---|---|---|
| Tests | **3439 pass, 0 fail, 1 skipped** (Loom 1896 + EAgent 1543, of which 1 skipped) | `npm run check` (its test arm) |
| Test files | 238 (107 Loom, 131 EAgent) | `node -e "console.log(require('node:fs').globSync('packages/*/test/**/*.test.ts').length)"` |
| Source files | 57 in `packages/core`, 106 in `packages/eagent` | `node scripts/check-zero-dep.mjs` (it prints core's count — it is scoped to core on purpose) |
| Runtime dependencies | **0 in `packages/core`**, which is the one that matters. `packages/eagent` carries `jiti` and is allowed to (invariant 1 is scoped to core) | same command — it fails on a bare import specifier that is not `node:`, on any non-`devDependencies` dependency field, on a `createRequire`/`require`/computed-`import()` load, and on a file under `src/` it cannot parse |
| Public exports, pinned | 514 | `node -e "console.log(require('./scripts/surface.json').length)"` |
| Escalation rules | 10, and **all 10 are raised** | `node --test packages/core/test/docs-drift.test.ts` — `RULES_NEVER_RAISED` is empty |
| Built-in tools | 6 default + 2 opt-in | `fs.read fs.write fs.edit fs.glob fs.grep fs.restore`, plus `net.fetch` (needs `--egress`) and `proc.exec` (needs `--allow-exec`) |
| Commits ahead of `origin/loom` | **some — always re-derive**, and there is always at least one, because committing this row changes it | `git log --oneline origin/loom..HEAD \| wc -l` |
| Typecheck | clean, both packages | `npx tsc -p packages/core/tsconfig.test.json && npx tsc -p packages/eagent/tsconfig.test.json` |

**The `Source files` row is the only one that cannot rot**, because its command is a guard that
runs in CI: if it disagrees with the tree, the build stops. That is the difference between a
command column and a gate, and it is worth more than the discipline of re-deriving the rest.

**`bin/loom` is gitignored and goes stale on the next `src/` edit.** Nothing rebuilds it for
you. Before repeating any claim about the binary, run `npm run build:binary` and grep it for a
symbol your change touched — two seconds, and it is the only thing between "the binary works"
and "a binary worked once".

---

## Does it meet the bar?

The bar, from `CLAUDE.md`: *someone can install it, write a graph, point it at a real provider,
and have it run, with a human gate that works and a replay that reproduces.*

| Clause | State |
|---|---|
| install it | ✅ `npm run build:binary` → a single `bin/loom`, 0 third-party modules |
| write a graph | ✅ `loom compile` diagnoses ordinary authoring mistakes instead of crashing |
| point it at a real provider | ✅ `--models-file`; Anthropic + OpenAI over `fetch`+SSE. A run served by the mock now says so |
| have it run | ✅ all eight node types execute; a run that finishes reports what it wrote |
| a human gate that works | ✅ raise → deliver → decide → resume, across a restart; an approval binds the graph the human was shown |
| a replay that reproduces | ⚠️ **yes, except for de-escalated runs** — see T4 |

The bar is met with one caveat, and T4 is that caveat. Nothing else on the list below blocks it.

---

## What is left

Ordered by what a fresh session should pick up first. Everything here was verified against
`src/` on 2026-08-21 — not recalled, and not taken on a reviewer's report.

### 1 · Defects — something claims to work and does not

**Empty, and that is a claim to check rather than a state to trust.** Every row this section
carried has been closed and each was verified against `src/` before its row was deleted, not
against a memory of having fixed it:

| was | closed by | the check that would fail if it regressed |
|---|---|---|
| **D1** a synchronous `function` body could not be stopped | `callTimeoutMs` reaches `vm.runInContext`'s per-call `timeout` (`resources/realm.ts`) | "A SYNCHRONOUS BODY THAT NEVER RETURNS IS TERMINATED" — in `functions.test.ts` AND `hook-loader.test.ts` |
| **D2** a rewind stranded the lease it undid | `rewind` appends `task.ready` for stranded leases | `run/rewind-rearms.test.ts`; audit rule `task.leased-is-resolved` |
| **D4** `onBudgetExhausted: "gate"` did not gate | `GRAPH003_BUDGET_ACTION_UNSUPPORTED` refuses the unbuilt actions at compile | `graph/validate.ts` rule; the engine's `#budget` comment names it |
| **D5** `loom compile` said `ok` for a resource that does not exist | the workspace resolver stopped fabricating pins; `GRAPH015` fires; `NAME_ONLY_KINDS` holds the two key kinds | `resources/unresolved-refs.test.ts`, 8 tests, 7 mutation-verified |
| **D6** fallback chains were declared and unwired | `route.fallback` builds a synthetic `chain(key)` adapter (`cli.ts`) | the `CHAIN` suite in `cli.test.ts` |
| **D7** error edges ignored their `codes` | `#errorEdges` filters by `e.codes` (`engine.ts`) | `run/error-edge-codes.test.ts` |

**Do not add a row here without a reproduction that RUNS.** Every defect in this table was found
by running a new shape of thing, and two of the six were described wrongly by the register until
somebody reproduced them — D2 was worse than recorded (a run that reported success having undone
its work), and D5's prescribed fix would have added a resource kind nothing reads.

### 2 · Open from the E8 taint hardening

Each reproduced or confirmed in source during that work and deliberately left out of it.

- **T1 — a `router`'s `when` reads the scope through the expression evaluator, not a `${}`
  template**, so `observedChannels` cannot see it. Control-flow taint, a different question
  from feeding an action, and the branch is bounded by `GRAPH005_ROUTE_NOT_OWN_EDGE`. Needs the
  expression parser to report free variables.
- **T2 — `reads` is still not enforced as the read set.** `GRAPH004_UNDECLARED_READ` covers edge
  `when`/`until` and router cases, never `tool.args`. Taint now derives the wider set; every
  OTHER consumer of `reads` still trusts a field nothing holds anyone to. The hygiene fix is a
  compile rule refusing a template outside `reads` — it breaks every shipped graph that does
  this today, so it is an announced change, not a drive-by.
- **T3 — same-wave ordering.** Taint is added at commit, so a node decided in the SAME wave as
  its tainter sees none. Needs an under-constrained graph and nothing refuses one.
- **T4 — replay cannot exercise any de-escalated run.** `replayRun` never re-applies
  `policy.deescalated`, so a replayed run has no ceiling and every hard-to-undo action computes
  to `in`. Reproduced with a graph containing NO taint: the replay raises a gate the recorded
  run never decided, and throws. **This is the one caveat on the bar** — pre-existing and
  taint-independent, but it means "a replay that reproduces" does not hold for de-escalated runs.
- **T5 — `evolution/trajectory.ts` matches escalation rules by exact string.**
  `e.payload.rule === "violation"` is dead: `#escalate` appends the detail, so the journaled
  value is `violation {"capability":…}`. E8's firing site uses the same pattern, so any future
  consumer inherits the bug. The journal should carry `rule` and `detail` as separate fields.
- **T6 — `reachableToolNames` does not descend into a `subgraph`**, so a subgraph node is
  classified `read_only` however irreversible its child is. Not currently a hole — each run has
  its own `PolicyEngine`, so the child re-decides at full strictness with no inherited ceiling —
  but invariant 5's "max over every tool it can REACH" is not what the code computes.

### 3 · Mechanism that exists and is wired to nothing

These need a **product decision**, not a bug fix. Do not pick one unilaterally; each has a
question that the repository cannot answer.

| Item | The question that has to be answered first |
|---|---|
| **Compensation** (B9) | A compile-time proof and a rewind refusal exist; `case "compensation": break;` executes nothing. *When does a compensation edge fire* — on task failure, on run failure, on rewind? |
| **`JoinNode.timeoutMs`** | In the schema, read by nothing. *What does a barrier timeout DO* — fail the join, or fold what arrived? Folding partial evidence for `mode: all` is a semantics change, not a timeout |
| **B11 — `function`/`evaluator{assertion}` bodies re-execute on replay** | A journal-schema decision: should a function body's output become a journaled effect? That makes replay total and makes every function body a recorded nondeterminism site |
| **Retention tiering** | `TierManager` is proven by test and has no caller; it needs a durable cold store first |
| **Quorum, delegation, trust tiers** (D7.9 rows 1, 3, 4) | Deliberate compile errors. **Implementing one means DELETING a check** — delete the refusal and add the enforcement in the same change, or you ship exactly the failure the refusal prevents |

### 4 · Deferred by explicit design decision — do not "fix" these casually

Each has a one-line justification in `08-PLAN.md`'s `DEFERRED-v2` register. They were closed
for reasons, not forgotten.

| Item | The reason, compressed |
|---|---|
| **G3 · partition assignment** | Selection is a seam; deciding *which runs a worker considers* needs a coordinator, and half a coordinator is worse than none. `LeasedScheduler`'s reclaim path is unreachable through `advance` as a result |
| **Cross-run / cross-tenant fairness** | Not expressible at the shipped seam: `Scheduler.select` receives ONE run's projection |
| **Evolution synthesis + canary + auto-promotion** | Under ~30 scored trajectories per cohort, any candidate is fitted to noise. Capture and scoring ship; the generator does not |
| **Subtractive graph mutation** | Additive-only keeps the executed graph a superset of the compiled one |
| **seccomp / Landlock** | Platform-specific; subprocess + fs jail + egress allowlist covers the v1 threat model |
| **Custom user-authored reducers** | Arbitrary code inside the determinism boundary |
| **Free-form agent chatter / blackboard** | Makes termination unprovable and replay quadratic |
| **Vendor callback PARSING** (Slack/Feishu/Teams/email) | Delivery *to* them is not deferred — one `WebhookChannel` covers it. The return trip needs per-vendor signature verification; `SignedWebhookChannel` is the worked example |
| **Distributed deployment** (K8s/Postgres/NATS/S3) | A distributed v1 by a small team yields a distributed prototype, not a product |
| **MCP resources, prompts, Streamable HTTP** | Tools-only and stdio-only today. When an HTTP-only server matters, add a second transport behind the same client, not a second client |

### 5 · Blocked by a constraint we chose

| Item | The constraint |
|---|---|
| **Browser paint at 500 nodes** | Timing the paint needs a headless browser, which the zero-dep rule keeps out of `@loom/core`. Measure it in a separate package — do not add the dependency here |
| **Scheduler-tick telemetry** | The span DL-1 named as its reversal metric is emitted nowhere. The runnable substitute the journal already carries is `task.leased.ts − task.ready.ts` per Task |
| **EAgent's guard stack cannot move into `packages/core` as-is** | `secret-guard` and `bash-policy` need **argument-level inspection before dispatch**, and `PolicyEngine.decide` never looks at args; `irreversibility` is static per tool, so "this `git` invocation is read-only but that one force-pushes" has no home. The shape that works is to **split the tool**: a `read_only`-declaring variant whose `execute` REFUSES any argv it cannot prove read-only. Refusing is always permitted; lowering never is |

### 6 · Smaller known gaps

- **`AssembleInput.retrieved` is never populated** — nothing retrieves. `turns` is partly
  addressed (`boundTurns` handles the transcript; `assembleContext` still never receives it).
- **The surface guard counts exported NAMES, not members.** A new public method on an
  already-exported class is invisible to it.
- **EAgent is now `packages/eagent/`, not a vendoring source.** What has NOT been moved into
  `packages/core` — and would have to satisfy the invariants first — is `library/` as data with
  ONE frontmatter parser instead of EAgent's four, `codeact`, `checkpoint` (git-stash based, a
  real delta over per-file `fs.restore`), `limits`' output spill, and `memory`'s retrieval half,
  which is the only thing that would populate `retrieved`. None of it is urgent now that the
  code is in the tree and readable.
- **EAgent's tsconfig relaxes three flags Loom sets** (`exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature`, `noImplicitReturns`). Turning them on is a migration
  somebody may choose; the gate does not require it.

---

## The one thing that needs a human

**Pushing.** `origin/loom` exists and the branch is published, but commits accumulate unpushed
and the assistant cannot push them. Run:

```bash
git push
```

**Why the push once failed, because it will matter again.** Two Slack webhook URLs in a test
file tripped GitHub's secret scanning. The detector matches URL *shape*, not entropy, so
placeholder values satisfy it. Fixing the tip was not enough — 45 commits still carried the old
bytes — and the fix was `git filter-repo --replace-text` scoped `--refs loom` so the published
`init` branch kept every SHA. Three things it cost more than expected:

1. The rewrite was **74 commits, not 25**: the boundary is the earliest tree carrying the
   string, so everything after it renumbers.
2. **The document describing the block reproduced it** — this file quoted both literals while
   explaining them, and would have failed the push after a perfect rewrite.
3. The corpus cited 15 commits the rewrite renumbered. Those citations were removed FIRST, in a
   commit of their own. Hence the no-SHA rule at the top of this file.

`--force` is never the answer: it overrides ref-update rules, and push protection rejects at the
content layer before the ref is considered. `loom-backup-pre-rewrite` and
`loom-pre-rewrite-20260819` tag the pre-rewrite tip.

---

## How to work here

```bash
npm run check                            # THE gate: typecheck + the whole suite + both guards
npm test                                 # tests only
npx tsc -p packages/core/tsconfig.test.json   # read-only typecheck, safe under concurrency
node --test packages/core/test/<file>    # one suite
node scripts/check-surface.mjs --write   # re-pin the public surface, then COMMIT surface.json
npm run build:binary                     # bin/loom; fails if any node_modules input appears
```

**If several agents or shells are working at once, do not run `npm run check`, `npm run build`
or a bare `tsc -b`** — concurrent `tsc -b` races on emit, and it races harder now that both are
`--force`. Use the read-only typecheck and a single `node --test` file instead.

**The method, in four rules this build learned the hard way.**

1. **Reproduce before fixing, and reproduce by running, not by reading.** Every wave that found
   real defects found them by running a *new shape* of thing.
2. **Name every site that touches the value, and write the list into the claim.** Four fixes in
   one wave were each correct and applied to too small a set; three were caught by a reviewer
   rather than the author. "This boundary is total" cannot be checked; a claim that names its
   set can.
3. **Mutation-test every new guard.** Revert the fix, watch the new test go red, restore. A test
   that passes with the fix removed is a test that cannot fail — this build has written several,
   including one in the same wave that ran the mutation sweep. **A sweep only kills what it
   mutates.**
4. **Write the derivation, never the total.** A number that sounds like evidence is exactly the
   kind nobody re-derives. This file has been wrong about its own counts three times.

**And the failure mode that outranks all four:** a test built from the same mental model as the
fix certifies the model, not the mechanism. The E8 taint rule was fixed, tested, and reviewed
green — and then two adversarial reviews reproduced five ways past it, because the test and the
fix shared an assumption about what a "read" was. When a fix and its test feel obviously
correct together, that is the moment to attack them from outside.

## Traps

Each of these cost real debugging time. They are recorded in `JOURNAL.md` in full; this is
the short list so you recognise the shape.

**A guard that is missed twice should be made unrepresentable, not re-added.** Gate
authorization was derived from the node in `#commit`, so a tool's posture gate and a
subgraph's mirror journaled no approvers and no allow-list — the same omission, twice, in the
two gates humans answer most. It is now a **required** `auth` field on `NodeOutcome.gate`
computed in one place, and the broker's in-memory map is typed `EphemeralGate` so that reading
an authorization decision out of process memory is a compile error. The question "did you
think about authorization here?" belongs to the compiler, not to a reviewer's memory.

**An audit label that becomes an authorization key needs its provenance re-examined.** The
control plane's `subject` started as something to write in the journal and silently became
the thing matched against approvers lists. Nobody revisited where it came from, so for three
waves it came from the **request body**: one shared token plus `{"actor":"u:security-lead"}`
decided a gate naming the security lead, while the honest console got 403. Forgery was the
only workflow that worked. When a field changes job from *describing* to *deciding*, re-ask
who supplies it.

**A declared-and-folded event with no appender is a designed transition that was never
wired.** `gate.cancelled` was in `EVENT_TYPES` and folded by `projection.ts` — which is what
made it so easy to believe in — and written by nothing, so cancelling a run left its gates
open and answering one walked the run back to `succeeded`. Nothing about that is visible from
any single file; only "who appends this?" finds it. `docs-drift.test.ts` now asks that
question mechanically and names eight more.

**A terminal operation is not final until every producer of the state it ends is also
stopped.** Closing the gates that exist at cancel time was one of four fixes. A Task already
in flight can `raise` a *new* gate on a dead run; `rewind` can suppress the terminal event and
reopen every gate at once; the success path reaches `#finish` without passing the check that
was supposed to make gate closure unnecessary there; and the fold's terminal guard covered one
event rather than the status. Ask what else can *create* the state, not only what can read it.

**An exemption justified by a claim about a different function survives exactly until that
function changes.** `#finish` skipped gate closure on `run.completed` because "`advance`
re-suspends rather than finishing while a gate is open" — true of `advance`, and irrelevant
to the budget and fatal floors that reach `#finish` directly.

**A read model can silently encode a deployment assumption, and so can its consumer.**
`task.leased` always carried a `workerId` and a fencing token; the fold threw both away
because with one worker there is nothing to ask. That was fixed — and then the *scheduler*
was found doing the same thing one layer up, filtering reclaim candidates out of a set that
by definition excluded them. If you add a second worker to anything, check what the
projection discards **and** what its readers assume about state.

**Absence is not zero.** `verdict.score < 0.7` is **false** when `verdict` is absent, in both
the expression language and `isLowConfidence`. The idiom is `has(v) && v.x < 1`. A system that
coerced absence to `0` would escalate every run whose evaluator returned a bare `{pass: true}`
— and an alarm that always fires is one people learn to ignore. The same asymmetry runs
through the gate layer: an empty approvers list is the **permissive** case, so "named nobody"
and "could not read who it names" must never produce the same value.

**Approve means "go ahead", not "consider it done".** On a `human_gate` node, approving
completes it — that node *is* the decision. On every other node type there is work behind the
gate. This was a real bug: the run reported success and the action never happened.

**`instanceof` proves a prototype, not provenance.** `toLoomError` returns the value unchanged
when `isLoomError(e)`, so a channel's booby-trapped error escaped *with* its traps intact and
detonated one layer out, inside `LoomError.toJSON` on the HTTP path. Four waves running, the
untyped exit from `run/delivery.ts` was a read of an injected value on an error path, each
fixed one property before the next. The answer was one boundary, not a fifth local `try`.

**"Is this value a plain bag?" has no answer, so stop asking it and make the READS total.**
One guard reached its *third* spelling — `typeof x !== "object"`, then prototype identity,
then prototype identity plus `Array.isArray` — and each was defeated one shape over, the last
by `new Proxy(target, {getPrototypeOf: () => Object.prototype})` and, more embarrassingly, by
`{}`. **A `Proxy` must tell the truth about exactly one observable an inspector can ask for:
the extensibility of its target.** Everything else — the prototype, `hasOwnProperty`, the
value, the key list — is a trap it can forge or make throw. So a container test can refuse
the shapes it *recognises* and can never decide the question, and the fix is the one
`run/delivery.ts` already made: read each value through one total accessor and judge what
came back. `reconstructGraph` deleted its predicate that way and gained `{}` and the
`Proxy` for free; `redactAttributes` could not (there, "declared nothing" and "declarations
unreachable" are the same observation), so it keeps a **named-shape refusal** whose docstring
says what it cannot decide, plus a test that holds the limit executable. When a guard reaches
its third iteration, the question is wrong.

**"Make the READS total" is a claim about a SET of reads, so the next wave's job is to
enumerate the set, not to re-argue the principle.** Both files that adopted it shipped with the
principle right and the set short, and in both cases the survivor was a sibling of a read that
had just been fixed — a few lines away, answering the same question, answering it differently.
`attributeClass` wrapped two `Proxy`-trappable reads in a `try` and left the shape test that
*decides whether they are safe to make* one line above it. `reconstructGraph` routed every claim
through `readProp` and then walked the claim's CONTENTS with `for (const id of list)`, which
`Array.isArray` does not protect — it is proxy-agnostic, and an ordinary array can carry an
accessor at index 0 — so a bag whose "only remaining move is to ANSWER" could answer and then
throw. The mechanical version of the habit: after fixing a read, grep the file for every other
expression that touches the same value, and write the list into the claim. A claim that names
its set can be checked; "both arguments are total" cannot.

**And the two that followed are the same shape a THIRD and FOURTH time, both inside
`telemetry/spans.ts`, and each one was the read the previous fix had been standing on.** The
warning above did not prevent either, which is the point of recording them: the habit has to be
*run*, not agreed with.

- **The fix for the inner list left the OUTER one.** `reconstructGraph`'s claim loop was made
  total by `length`-then-index through `readProp` — and the statement that hands it each span,
  `for (const [i, s] of spans.entries())`, is the identical construction over the identical
  kind of untrusted container, one level up in the same function. `.entries` is a property read
  on the argument and the iterator does a `[[Get]]` per element; `Array.isArray` answered
  `true` to a `Proxy` and to an array with an accessor at index 0 for both. Measured, node
  v24.16.0: `Error: outer element getter`, `Error: outer get trap`, `Error: outer entries
  trap`, each straight out of the verification function.
- **The new guard's own next read was bare.** `isList` was added so `Array.isArray` could not
  throw, and `conformsToGraph` then read `unreadableSpans.length` — one line below the guard
  that had just accepted the value. `IsArray` unwraps a `Proxy` to its TARGET, so a `Proxy`
  over `[]` whose every trap throws is *truthfully* a list and every read of it still throws.
  Found by a 252-combination sweep rather than by reading, and it was the sweep's only
  survivor. **A container test and the reads that follow it are two separate claims, and
  answering the first one `true` licenses nothing.**

**And `run/delivery.ts` is the third file, which makes the pattern the rule rather than a
coincidence — three siblings, all in one prelude, each a few lines from the fix that named
them.** `ownedRecipients` was given the total-read treatment under the sentence "the elements
now go through `readProp` like every other read of a value from outside"; `ownedList`, 45
lines up, kept `[...v]`, and a spread is a read of the elements — reproduced on a real array
with an accessor at index 1, `deliver` exited with the caller's own `Error`, no delivery, no
fallback, no journal row. `ownedWrites` was moved to shape-check its INPUT; `ownedBatch`,
written in the same change 170 lines above it, kept the result check, so a `Map` batch
rendered `{}` — the shape a gate in NO batch has — and `ownedDecision`'s `edit` arm, on the
callback path, kept it too: a `Map` of a human's edits was journaled as
`{"decision":"edit","writes":{}}` with the action behind the gate RUN.

**And the question the sibling table never asked is "WHO READS THIS HELPER'S OUTPUT, AND DO
THEY READ IT BARE?" — because a total producer feeding a bare consumer is still a bare
read.** `ownedRecipients` was fixed twice under that table and kept feeding
`formatRecipients`, which read the elements, `r.kind` and `r.id` bare and coerced both, four
lines outside every try in `ConsoleChannel` — **the fallback, the channel whose docstring
says it cannot fail so that "nobody was told" is never the outcome.** Reproduced end to end
through `GateDispatcher`, with `recipients: [{kind: {toString(){throw}}, id: "sre", self:
<cycle>}]` reaching it through `addressOnly`'s own unchecked copy: **`delivered: 0,
failed: 2, fellBack: false`** — because the built-in fallback IS a `ConsoleChannel`, so it
failed identically. The same function's OTHER caller is worse and no `owned*` helper stands
in front of it: `HumanGateBroker` builds `gate.escalated{to}` from the compiled graph's own
recipients array, and a throw there lands in `sweepTimeouts`' per-gate `catch` — measured,
four sweeps over 3 000 s, `fired: 0` each time, gate frozen at tier 0 on its original
deadline, **nothing on the journal saying why.** A silent permanent non-escalation, reached
from a graph that compiles. The mechanical version: for every helper that makes a value
total, list its READERS and ask what each one does to the value — `${x}` is a call,
`x.map` is a call, and a marker only helps a reader that does not then coerce it.

**And the third case of a taxonomy is a coin flip unless it is decided from the assertion.**
`ownedList` and `ownedRecipients` got per-index degrades in one wave and answered an
unreadable element two different ways — a marker and `{kind: undefined, id: undefined}`, an
address of nobody indistinguishable from a recipient that declares neither field (measured:
both came out of the dispatcher as `[{}]`). Neither answer is wrong in general; the split is
decided by the ELEMENT TYPE. `ownedList` serves lists of STRINGS, so a bare marker is in
shape. `recipients` is a list of RECORDS every reader indexes into, so the marker goes in the
FIELD and the record survives. The question to ask of a new case is never "which existing
function does this resemble?" but "what does this value ASSERT to its reader, and what must
be true for that assertion to hold?"

**The new platform fact, and it corrects the paragraph above: `Array.isArray` cannot be
forged and it is not TOTAL.** `IsArray` follows a proxy to its target, which is why this
codebase reaches for it — and on a REVOKED proxy it THROWS (`TypeError: Cannot perform
'IsArray' on a proxy that has been revoked`, node v24.16.0), because the revoked handler is
`null`. It was the last bare call in a prelude that sits outside every try, at four sites;
every other accessor there already caught (`JSON.stringify`, `getOwnPropertyNames`,
`getPrototypeOf`, a plain `[[Get]]` all throw on one too). Un-forgeable and safe-to-ask are
different properties, and a sweep organised by the first will keep missing the second.

**And the sweep that recorded it stopped at the file it was in.** `telemetry/spans.ts` named
`Array.isArray` in `readProp`'s docstring as one of the two ways it reads an untrusted trace
TOTALLY, while all three of its calls were bare — the argument guard in `reconstructGraph`,
the claim-container test, and the one that ends in the verdict a CI job reads,
`conformsToGraph`'s. Each threw on a revoked `Proxy` out of a function whose whole job is to
answer `ok` or `not ok`. All three now go through `isList` (the call in a `try`, `false` on a
throw, which is the fail-closed direction at each). **A platform fact written into one file's
Traps entry is not a fix in the other files that call the same API: when one lands here, grep
the tree for the API, not for the file.** The sweep is
`grep -ran 'Array\.isArray' packages/core/src`, which finds it in **twenty files** — and this
wave swept **three** of them, so what follows is a clearance for those three and an open
question for the rest, not a tree-wide all-clear:

- **`server/http.ts`** (twelve occurrences) and **`cli.ts`** (eight) — every one is over a
  `JSON.parse` result (a request body, a graph file, an identity file, `--input` argv) or over
  Node's own `req.headers` record. Neither source can produce a `Proxy`, so `Array.isArray`
  cannot throw there. **CLEARED, by enumeration.**
- **`server/console.ts`** — one, in `loadGates`, over a `fetch().json()` result. Same
  argument. **CLEARED.**
- **The other sixteen files are UNSWEPT** — `security/redact.ts`, `state/channels.ts`,
  `graph/expr.ts`, `run/context.ts`, `run/engine.ts`, `run/delivery.ts` and the rest. The
  question to ask of each is not "is this value a list" but **"can a caller outside this
  process's own code put a revoked `Proxy` here?"** — which is the same question `readProp`
  was written for, one API over.

**`node:vm` is not a sandbox.** `resources/functions.ts` uses it for *scoping* — so a trusted
`function` body cannot reach `process.env` by accident. Untrusted code goes through
`sandbox/subprocess.ts`. The docstring says this; do not let it drift.

**Cross-realm values look identical and are not.** Objects a `vm` body returns have a
different `Object.prototype`. Worse: `Array.prototype.map` goes through `ArraySpeciesCreate`
and uses the *array's own* constructor, so mapping a cross-realm array does nothing at all.
`intoHostRealm` uses `Array.from`. `Array.isArray` is realm-agnostic and will pass either way
— assert on the prototype.

**Under reserve-worst-case, "80% consumed" is ambiguous.** Committed exposure peaks at the
reservation and falls back when `settle` credits the real cost — a 40× swing with the mock
adapter. A check only at commit reads the trough and never fires. E2 checks at both.

**A tool cannot know a graph's channel names.** `mapToolWrites` routes a tool's own write
vocabulary onto the node's declared channels. Found by using the binary for four minutes;
every built-in tool had been unusable by any graph that had not guessed its internals.

---

**A queue carried across compactions decays, and checking an item is cheaper than fixing
it.** Four items on the 2026-08-17 remediation list were already done or were never true:
`resultDigest` "read by none" is read and raises `E_REPLAY_DIVERGENCE`; two "producerless"
events were already registered with reasons; `--models-file` "untested" was seven tests in a
file I had not grepped; and `usage` was not an escalation rule at all — the name came from a
different object literal in the same file. Each looked exactly like real work until it was
checked, and each check took under a minute.

**A capability nothing calls is indistinguishable from one that does not exist.**
`runSandboxed` sat in this tree — hardened, four listeners that may not throw, a
SIGTERM→grace→SIGKILL path measured against a child that never exits — with **zero callers**,
for the whole project. `proc.exec` was written to fix that, and one commit later `McpClient`
shipped with nothing constructing it. Wire the caller in the same commit as the capability,
or the capability is a plan.

**Reproducing a defect by reverting a file destroys uncommitted work in that file.** Proving
the fence fix mattered meant running the test against the pre-fix engine; `git checkout --
packages/core/src/run/engine.ts` did that and also deleted the fix, which was not yet
committed. `cp` the file aside and `cp` it back. The reproduction is worth doing — it is what
turns "this looks wrong" into `unfenced: task.retry_scheduled+task.ready` — so make it cheap
rather than skipping it.

**A green test can be green for a reason it does not claim.** The first subgraph test passed
because `skeleton.ts`'s resolver has no `subgraph()` method, so the child spec was never
found and the assertion was vacuous. TypeScript caught it, not the test run. Before believing
a new test, break the thing it tests and watch it fail — a test that has never been red has
never been shown to test anything.

**A guard that cries wolf on correct code is worse than no guard, and its first false
positive will be its own bug.** `docs-type-equiv` reported nine of `ToolDefinition`'s members
as missing from the code; they were on `ToolManifestLite`, and the guard did not follow
`extends`. The finding read exactly like drift in the code. Fix the guard before filing the
finding.

## The one habit worth keeping

Every wave of this build found defects by running a *new shape* of thing, not by adding tests
to an existing shape. A restart found the gate bug. A branch that recovers found the join bug.
A router found three compiler over-approximations. Two workers folding real journals found a
reclaim path that was structurally unreachable. Reverting one guard condition at a time and
counting the tests that go red found eight guards nothing was holding. Four minutes as a
*user* — copying the binary into an empty directory and hand-writing a graph — found the tool
channel bug that three test workflows structurally could not.

When something feels covered, it is covered *for the shapes that exist*. Build a new one.
