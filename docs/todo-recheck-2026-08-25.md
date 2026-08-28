# TODO.md re-check — 2026-08-25

> **Commit hashes in this file predate a history rewrite and no longer resolve.** On
> 2026-08-28 the branch was filtered to remove a Stripe-shaped fixture string from
> `docs/audit-2026-08-25.md` (GitHub push protection rejected it; the string was fake, and the
> reasoning is `TODO.md` §F.16). Filtering rewrote every commit in `86b84c9..HEAD`, so every
> short hash below points at an object that is gone. **The subjects are unchanged**, so a
> reference resolves with `git log --grep='<the subject or a phrase from it>'`. The hashes are
> left as written rather than renumbered: this is a dated record, and a record edited to agree
> with a later state is no longer a record of anything.

**Full record. 107 items, 106 verified by executing something.** `TODO.md`’s per-section
tables are an index into this file; nothing here is truncated. Verdict tallies:
{"DONE":19,"PARTIAL":30,"STALE":2,"STILL-OPEN":52,"WRONG":2,"UNVERIFIABLE":2}. Tiers: {"REPRO":106,"CITED":1}.
7 verdicts were overturned by an adversarial pass over every DONE and WRONG,
and 1 was marked WEAK (evidence did not establish the verdict).

Counts are as of sha `86b84c9`.

---

## Section A

### `A.p1` — DONE

> the gated irreversible write **had not happened** while the run sat at the gate, and did happen

**Tier.** REPRO

**Command.**

```
cd $WS && node packages/core/src/cli.ts run .agent/graph-provenance/gate.json --workspace $WS --input '{"note":"hello world"}' --as u:alice; ls -la $WS; node .../cli.ts approve 01M0W3NTEGGQ426QT0DX4SDAYX gate_01M0W3NTEJTBFSH8PSZRFJD2EA --as u:alice --graph $WS/gate.json --workspace $WS; cat $WS/after-gate.txt
```

**Observed.** run → status "awaiting_gate", `ls` shows NO after-gate.txt; approve → status "succeeded", outputs.written={bytes:11,path:"after-gate.txt"}, and `cat after-gate.txt` prints "hello world".

**Finding.** Reproduced verbatim on .agent/graph-provenance/gate.json (fs.write behind a human_gate). The gated write is genuinely withheld at the gate and performed on approval.

### `A.p2` — DONE

> `replay` reports `match: true, hermetic: true`, and **does not re-perform the write**

**Tier.** REPRO

**Command.**

```
node packages/core/src/cli.ts replay 01M0W3NTEGGQ426QT0DX4SDAYX --graph $WS/gate.json --workspace $WS; rm -f $WS/after-gate.txt; node .../cli.ts replay <same>; ls -la $WS/after-gate.txt
```

**Observed.** Both replays print {"match": true, "hermetic": true}. After deleting the file the second replay leaves it absent: `ls: after-gate.txt: No such file or directory`.

**Finding.** Exact claim, exactly reproduced — the effect record is served rather than the effect re-run.

### `A.p3` — DONE

> `audit` reports `14 rule(s) checked, 6 skipped` and **names every skipped rule with its reason**

**Tier.** REPRO

**Command.**

```
node packages/core/src/cli.ts audit 01M0W3NTEGGQ426QT0DX4SDAYX --graph $WS/gate.json --workspace $WS
```

**Observed.** "ok — 14 rule(s) checked, 6 skipped", preceded by six `· not checked — <rule>: <why>` lines (policy.deescalation-is-human, task.cancelled-not-after-commit, subgraph.start-and-completion-pair, subgraph.child-id-is-derived, policy.escalation-only-raises, hook.applied-ref-is-declared).

**Finding.** Count verified against the aggregate: AUDIT_RULES in packages/core/src/journal/audit.ts:41-62 has exactly 20 members, and 14+6=20. Every skipped rule carries its reason; none is counted as a pass.

### `A.p4` — PARTIAL

> fan-out → join → serialise → write produces the right bytes, with `${reviews | json}` doing the

**Tier.** REPRO

**Command.**

```
node packages/core/src/cli.ts run $WS3/fanout.json --workspace $WS3 --input '{"items":["ann","bob","cid"]}'; cat $WS3/reviews.json   # and the seq-edge variant: node .../cli.ts run $WS2/fanout.json --workspace $WS2 --input '{"topic":"kernel"}'; cat $WS2/reviews.json
```

**Observed.** Canonical shape (kind:"fanout" edge + kind:"join" edge): 3 reviews, correct bytes, `${reviews | json}` serialised, no helper node — claim holds. But with the branches wired to the join by plain `seq` edges at the ROOT coordinate, the same graph compiles `ok` and writes SIX entries for three branches — every contribution duplicated.

**Finding.** NEW DEFECT found while verifying this claim, reproduced twice. Root cause read out of the journal: at root coordinate `#immediateReduce` (engine.ts:4902-4919, holds only when `w.task.branch.segments.length > 0`) already reduces each branch's writes, and then `#foldJoin`'s root path (engine.ts:3184-3205) folds those same `t.writes` onto `stateAtPrefix` AGAIN. Journal seq 26/29/32 are the per-branch `state.reduced` (reviews grows 1→2→3); seq 37 is the join's own `state.reduced` with `reviews` at 6, while its `task.committed` (seq 36) has `writes:{}`. Any non-idempotent reducer (`append_ordered`, `sum`) double-counts. The claim's own shape is safe; the neighbouring shape is silently wrong and the compiler says `ok`.

### `A.ptr` — STALE

> Two defects came out of the last two steps... See the `trace` entries below.

**Tier.** REPRO

**Command.**

```
grep -ain 'trace' TODO.md; awk 'NR>=18 && NR<=140' TODO.md | grep -ain trace; git show 86b84c9 -- TODO.md; git show --stat 9b1efd5
```

**Observed.** `trace` occurs in TODO.md only at lines 21, 34, 176 and 262. Line 176 is in section C (`## C` starts at line 170), not below line 34 within section A (18-140). Inside section A the only two hits are lines 21 and 34 themselves — the pointer points at nothing.

**Control.** Control on the same file: `grep -ain 'GRAPH009' TODO.md`-style cross-checks — the same grep DOES find the section-C trace entry at 176, so the pattern is not typo'd; there is simply no trace entry in section A.

**Finding.** The pointer was born dangling: `git show 86b84c9 -- TODO.md` shows the whole preamble INCLUDING this sentence was added in one commit that touched only TODO.md and added no trace entries. The two defects it refers to were instead fixed directly and never written down — 9b1efd5 (`trace` printed neither `node.id` nor `branch.path`) and 1d59621 (a millisecond cannot order Tasks). Both are fixed at HEAD: my `loom trace` run prints `loom.task rev1 root [ok]` etc., with node id and branch path. Delete the pointer or write the two entries.

### `A.1` — DONE

> ~~**Unknown-field check for a node's TOP-LEVEL fields and for `GraphSpec` itself.**~~ **DONE**

**Tier.** REPRO

**Command.**

```
node packages/core/src/cli.ts compile $SP/uf/{node-policyy,node-misc,edge-when,spec-unknown,clean}.json; node --test packages/core/test/graph/allowed-fields.test.ts
```

**Observed.** `policyy:{posture:"in"}` → ✗ GRAPH020_UNKNOWN_FIELD, fix: did you mean `policy`?; `retryy`/`timeoutMss`/`checkpointt` → three GRAPH020s naming `retry`,`timeoutMs`,`checkpoint`; edge `whenn` → GRAPH020 naming `when`; spec-level `polcy` → "the graph has an unknown field `polcy`". Control (unmodified graph) → `ok`. allowed-fields.test.ts: 9 tests, 9 pass.

**Finding.** The DONE holds at all four scopes, with a clean control. The drift guard is real: allowed-fields.test.ts:29 reads spec.ts source and regex-extracts each interface's fields (`readFileSync(new URL("../../src/graph/spec.ts"))`), so NODE_FIELDS/SPEC_FIELDS/EDGE_FIELDS/ALLOWED_FIELDS cannot fall behind the interfaces.

### `A.2.1` — STILL-OPEN

> **(1) remains:** you cannot fan out from a graph's entry — a fan-out edge needs a source node

**Tier.** REPRO

**Command.**

```
node packages/core/src/cli.ts compile $WS3/no-entry.json --workspace $WS3   # fanout edge with its source node deleted
```

**Observed.** ✗ GRAPH003_DANGLING_EDGE: edge "fan" starts at unknown node "start" — E_GRAPH_INVALID. With the fanout edge removed and `rev` made the entry, the graph compiles (with GRAPH005_UNPRODUCED_READ on `item`) and `rev` runs ONCE over the whole array instead of per item.

**Control.** Control: the same graph WITH the no-op `start` node compiles `ok` and fans to three branches — so the refusal is about the missing source node, not about the fixture.

**Finding.** Confirmed, and it is exactly as costed: `EdgeSpec.from` is a required NodeId (spec.ts:492), entry nodes are defined as nodes with no inbound non-loop edge, so the fanned node can never be the entry. Every fan-out graph pays one no-op node. Not a correctness bug.

### `A.2.2` — DONE

> **(2) closed** by `${x | json}`. The whole-string form still yields the VALUE

**Tier.** REPRO

**Command.**

```
node .../cli.ts run $WS3/fanout.json ... (body: "${reviews | json}") ; then sed 's/${reviews | json}/${reviews}/' and run again
```

**Observed.** With `| json`: reviews.json holds pretty-printed JSON, 3 objects, correct. Without the filter: run FAILS with E_TOOL_SCHEMA_INVALID — "invalid arguments for fs.write:\n- value.body must be a string".

**Finding.** Both halves hold, including the honest sizing: the whole-string form still delivers the ARRAY VALUE and argument validation refuses it before `execute` with an accurate message, so `| json` removed a workaround rather than a wrong value reaching a tool. Implementation at engine.ts:5742-5766 (`TEMPLATE_JSON = /\s*\|\s*json$/`).

### `A.2.3` — DONE

> **(3) was misread, and the truth was a real defect.**

**Tier.** REPRO

**Command.**

```
node packages/core/src/cli.ts compile $SP/b/nobudget.json --workspace $SP/b; node .../compile $SP/b/withbudget.json --workspace $SP/b
```

**Observed.** No graph budget (an agent node) → ! GRAPH009_NO_BUDGET: "node(s) ag can spend and nothing in this graph bounds them…". With `budget:{costUsd:1}` → ! GRAPH009_UNBOUNDED_NODE: "…the $1.00 graph budget still caps the run while GRAPH009_BUDGET_OVERCOMMIT cannot see what these nodes contribute to it".

**Finding.** The inversion is fixed and the new messages say what is actually unprovable. Source: validate.ts:1509-1590 branches on `graphBudget === undefined`, so `delete policy.budget` no longer silences anything — it now trades a weaker warning for a stronger one.

### `A.3` — PARTIAL

> ~~**Confidentiality does not propagate, and a human ceiling erases it entirely.**~~ **HALF DONE.**

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/run/secret-flow.test.ts; node packages/core/src/cli.ts compile $SP/laund/launder.json --workspace $SP/laund; node .../compile $SP/laund/direct.json --workspace $SP/laund
```

**Observed.** secret-flow.test.ts: 3/3 pass — "A LAUNDERED SECRET STILL GATES, even under a human ceiling", "A DECLARED secret under the same ceiling still runs", "THE FLOW SET SURVIVES A RESTART". Laundering graph (function copies secret_ref → internal, tool writes `${plain}`) compiles `ok` with NO diagnostic; control (same tool reading `${secret}` directly) fires ! GRAPH019_POSTURE_NO_EFFECT.

**Finding.** Three of four sub-claims hold; one is now FALSE. HOLDS: `applySecretFlow` exists (engine.ts:5695, called at 987 in #restoreEvidence and at 4834 at commit); the hard floor reads it (`const unseen = req.tainted === true || req.carriesSecret === true` — policy.ts:402-403); the compiler still gives no laundering diagnostic (reproduced above with a control). FALSE at HEAD: "the `dataFloor` in `validate.ts` still disagrees with `compile.ts` (below)" — that is the very item marked DONE two bullets down (A.6). Both files now call one exported `dataFloorOf` (spec.ts:870, imported at compile.ts:24 and validate.ts:37). Section A contradicts itself; strike that clause.

### `A.4` — DONE

> ~~**`validate.ts` has no unknown-field check.**~~ **DONE.** `GRAPH020_UNKNOWN_FIELD` refuses any

**Tier.** REPRO

**Command.**

```
node packages/core/src/cli.ts compile $SP/uf/humangate-prompt.json; grep -an 'ALLOWED_FIELDS\|REQUIRED_FIELDS' packages/core/src/graph/spec.ts; node --test packages/core/test/graph/allowed-fields.test.ts
```

**Observed.** `humanGate: {ref, prompt, approval}` → ✗ GRAPH020_UNKNOWN_FIELD: node "approve"'s `humanGate` block has an unknown field `prompt`, fix listing the six legal fields. ALLOWED_FIELDS is at spec.ts:694, REQUIRED_FIELDS at spec.ts:640 — 54 lines apart, in the same table block, with the docstring at 687 saying "Beside `REQUIRED_FIELDS`". The cross-check against the interfaces passes (9/9).

**Finding.** Every clause verified including the anecdote's mechanism: the invalid `humanGate: {prompt}` shape is refused, with a nearest-field suggestion. The "now closed at all four scopes" addendum is A.1, also DONE.

### `A.5` — PARTIAL (overturned from DONE)

> **The journal amplifies a payload by `2N+2`.** **BOUNDED, NOT FIXED.**

**Tier.** REPRO

**Command.**

```
run a 2-node pass-through graph with a 262144-byte value, then: node -e 'db.prepare("select sum(length(payload)) from journal")' ; and node --test $SP/bigpay.test.ts (prepare() with 1 MiB vs 9 MiB)
```

**Observed.** journal payload bytes 1575122 for a 262144-byte value across N=2 nodes → ratio 6.01, i.e. exactly 2N+2. The 9 MiB payload throws E_PAYLOAD_TOO_LARGE; the 1 MiB control does not.

**Finding.** Both halves of the status hold and the formula is exact, not approximate. Bound is `MAX_PAYLOAD_BYTES = 8 * 1024 * 1024` (store.ts:179) enforced by `boundedPayload` inside `prepare` (store.ts:212-241), so it is the shared funnel both stores call. `foldRun` is still synchronous (`export function foldRun(events: Iterable<JournalEvent>): RunProjection | undefined`, projection.ts:527), so the read-half difficulty the item describes is unchanged. Only the item's ORIGINAL-finding sentence "a 256 MiB single event is accepted by both stores" is now false, and it is explicitly labelled as the original finding.

**Adversarial ruling: OVERTURNED.** The EVIDENCE is all correct and I reproduced every number, but the DONE label is wrong for an item whose own status line says "BOUNDED, NOT FIXED" — calling it DONE retires work that is still open. Amplification half, STILL-OPEN: an in-process 2-node pass-through run (compileOrThrow + MemoryStateStore + Engine.submit/advance, 262144-byte value) gives total journal payload 1575120 bytes, ratio 6.0086 for N=2, split run.submitted 262401 / task.committed 524548 / state.reduced 524816 / run.completed 262230 — i.e. 2N+2 copies, exactly the shape the item describes, still present at HEAD. Note the formula is approximate, not "exact" as the prior note claimed: 6.0086, not 6. Bound half, DONE: a scratch test on `prepare` shows a 9 MiB payload throws E_PAYLOAD_TOO_LARGE ("…is 9.0 MiB, over the 8 MiB per-event bound") while a 1 MiB control passes; MAX_PAYLOAD_BYTES = 8*1024*1024 at store.ts:179, `boundedPayload` called from `prepare` at store.ts:241, and `prepare` is the shared funnel — memory.ts:60 and sqlite.ts:297 are its only two callers. `foldRun` is still synchronous (projection.ts:527), so the read-half difficulty stands. Correct verdict: PARTIAL — bound landed, amplification reproduces.

### `A.6` — DONE

> ~~**`validate.ts` and `compile.ts` compute `dataFloor` from different sets.**~~ **DONE.** One

**Tier.** REPRO

**Command.**

```
grep -rn 'dataFloorOf' --include='*.ts' packages/core/src; node packages/core/src/cli.ts compile $SP/df/templated-secret.json; node --test packages/core/test/graph/data-floor.test.ts packages/core/test/run/observed-reads.test.ts
```

**Observed.** `dataFloorOf` is defined once (spec.ts:870) and called from exactly two places: compile.ts:133 and validate.ts:1928. A node declaring `posture:"on"` with a `secret_ref` reached only through `${apiKey}` in tool.args now draws ! GRAPH019_POSTURE_NO_EFFECT: "declares posture \"on\" but \"in\" applies from a higher level". 9/9 tests pass, including "...and the COMPILED floor agrees, because two answers to one question is how they drift".

**Finding.** Exactly as claimed — one exported helper, both readers, and the drift is demonstrated closed in the direction the item names.

### `A.7` — STILL-OPEN

> **`E_ADMISSION_REJECTED` is raised by nothing.** `POST /runs` admits everything it can

**Tier.** REPRO

**Command.**

```
grep -ran 'E_ADMISSION_REJECTED' packages/core/src packages/eagent/src; grep -rani 'maxInFlight|inFlight|semaphore|backpressure|429' packages/core/src/server/http.ts
```

**Observed.** E_ADMISSION_REJECTED: 1 hit, and it is the declaration itself (errors.ts:323). No throw site, no import. In http.ts the queue/limiter greps return only one unrelated docstring line (3204, about SSE backpressure) — no token bucket, no queue depth, no 429.

**Control.** Control on the same files: `grep -ran 'E_TOOL_NOT_FOUND' packages/core/src` → 7 hits; `grep -anc '401\|403' packages/core/src/server/http.ts` → 17 lines. The greps find codes that exist.

**Finding.** Three facts, all confirmed: no queue, no depth limit, no token bucket. The only inbound bound is a request BODY size cap (http.ts:970, 8 MiB), which is not admission control.

### `A.8` — STILL-OPEN

> **A provider rate limit sleeps holding the worker slot.** A 429 is absorbed by a retry that

**Tier.** REPRO

**Command.**

```
node --test $SP/rl.test.ts  # postJson with a fetch returning 429 twice and an injected sleep recorder
```

**Observed.** A single `postJson` call returns only after two in-call sleeps: slept === [8000, 8000], calls === 3, res.status === 200. The waits happen inside the one call the engine is awaiting.

**Finding.** Confirmed at the provider adapter: `postJson` (providers/http.ts:540-591) loops `maxAttempts` (default 3) and `await hold(retryDelay(last.retryAfterMs, base, max, attempt), ...)` INSIDE the call, so a 429 parks the caller for up to 2 × maxDelayMs (default 8_000) = 16s per node execution while its Task is leased. Worth recording as nuance the item does not: the ENGINE's own task-level retry does NOT hold the slot — engine.ts:4492-4514 appends task.retry_scheduled + task.ready and then `ctx.leases.delete(w.task.taskId)`, with the comment at 4470 "The slot is released during the backoff", and both `eligible` (scheduler.ts:98) and the advance loop (engine.ts:1283) skip a task until `retryAfter`. So the defect is now confined to the in-call provider retry, and is bounded rather than unbounded.

### `A.9` — STILL-OPEN

> **No circuit breaker.** Nothing measures a source's health and nothing withholds an unhealthy

**Tier.** REPRO

**Command.**

```
grep -rani 'sourcehealth|source_health|source health' --include='*.ts' --include='*.md' packages | grep -av node_modules
```

**Observed.** Zero hits, case-insensitively, across both packages' .ts and .md.

**Control.** Control, same scope and flags: `grep -rani 'reachableToolNames' --include='*.ts' packages | grep -av node_modules` → 32 hits. The pattern machinery works.

**Finding.** The symbol claim is exactly right. One qualification the item's flat first sentence misses: `packages/eagent/src/extensions/circuit-breaker.ts` exists and is registered (host.ts:118). It is a DIFFERENT breaker — keyed on tool-call signature (`name + canonical(args)`) for repetition and consecutive failures inside an agent loop — and measures no source's health, so the substance survives; only the unqualified words "No circuit breaker" are false at repo scope.

### `A.10` — WRONG

> **A subgraph's cost ceiling binds nothing.** A child run's spend is settled *after* it finishes

**Tier.** REPRO

**Command.**

```
node --test $SP/subbudget.test.ts (a PolicyEngine built the way a child's is); node --test packages/core/test/run/subgraph.test.ts
```

**Observed.** A PolicyEngine with `budget.runUsd = 2` REFUSES `reserve("node:b", 1.0)` after $1.50 is spent — E_BUDGET_EXHAUSTED, thrown before the call — while an unbudgeted control accepts reserve(1e9). subgraph.test.ts: 28/28 pass, including "a subgraph's slice is carved from what the parent still has" (asserts the journaled `subgraph.started.budgetUsd === 2`, being budgetShare 0.5 of $4 remaining).

**Finding.** There IS a point at which the cap refuses rather than reports. engine.ts:3724-3725 computes `slice = ctx.policy.remainingUsd * share`, journals it as `subgraph.started.budgetUsd`, passes it to `#contextFor(childRunId, childGraph, slice, ...)` (3765) and to `submit({budgetUsd: slice})` (3770); `#contextFor` turns it into the CHILD PolicyEngine's `budget.runUsd` (engine.ts:2267), which `reserve` enforces mid-child (policy.ts:505-515). The post-hoc `settle` at engine.ts:3905 is the parent's ACCOUNTING, not the child's ceiling. One residual hole worth rewriting the item as: when the PARENT declares no budget, `remainingUsd` is Infinity, `Number.isFinite` fails, `slice` is undefined and the child is unbounded — the same unbudgeted-graph shape GRAPH009_NO_BUDGET now warns about.

### `A.11` — STILL-OPEN

> **`reads` is not enforced as the read set.** The compile rule covers edge conditions and router

**Tier.** REPRO

**Command.**

```
node packages/core/src/cli.ts compile $SP/reads/args.json; node .../compile $SP/reads/when.json; node .../cli.ts run $SP/reads/args.json --workspace $SP/reads/ws --input '{"note":"n","secretish":"LEAKED-VALUE"}'; cat $SP/reads/ws/o.txt
```

**Observed.** Tool node with `reads:["note"]` and args body `${secretish}` compiles `ok`, runs `succeeded`, and o.txt contains LEAKED-VALUE.

**Control.** Control, same channel, same node, moved into an edge condition: `when: "len(secretish) > 0"` → ✗ GRAPH004_UNDECLARED_READ: "reads channel \"secretish\", which node \"a\" does not declare in `reads`" — E_GRAPH_INVALID. The compile rule fires for expressions and is silent for tool args, exactly as the item says.

**Finding.** Confirmed end to end: the template names an undeclared channel, the graph compiles, and the value reaches the tool. Mitigated but not closed: `observedChannels`/`dataFloorOf` (spec.ts:870-882) now make such a channel count toward the OVERSIGHT FLOOR, so the classification/taint consequence is covered even though the read set itself is not enforced.

### `A.12` — STILL-OPEN

> **`reachableToolNames` does not descend into a subgraph**, so a subgraph node is classified

**Tier.** REPRO

**Command.**

```
node --test $SP/reach.test.ts
```

**Observed.** reachableToolNames on a `subgraph` node returns []. Controls on the same function in the same test: a `tool` node → ["fs.write"], an `agent` node → ["proc.exec"], a `function` node with `effects` → ["fs.write"].

**Finding.** Confirmed, and the consequence is live: compile.ts:110-127 computes `classFloor` as `maxPosture("out", ...reachableToolNames(n).flatMap(...))`, so a subgraph node contributes nothing and floors at `out` however irreversible its child is. Implementation is spec.ts:841-852 — three arms (node.tool, node.agent?.tools, node.function?.effects), no `node.subgraph` arm.

### `A.13` — STILL-OPEN

> **A branch choice made from untrusted content raises nothing.** Bounded twice

**Tier.** REPRO

**Command.**

```
sed -n '3085,3098p' packages/core/src/run/engine.ts; grep -an 'ctx.policy.escalate(' packages/core/src/run/engine.ts
```

**Observed.** `#runRouter` is 13 lines: it evaluates `c.when` against `scopeFor(...)` and returns `take`. It touches neither `ctx.tainted`, `taintedFor`, nor `ctx.policy` — no escalation, no gate, no decision recorded.

**Control.** Control on the same file: `ctx.policy.escalate(` has 2 call sites (engine.ts:884 and 4796), so the absence in the router is not a grep artifact.

**Finding.** Confirmed, and the code says so itself: engine.ts:1383-1384 documents that the ceiling's hard floor "does NOT cover a `router` choosing a branch from tainted data, which is control-flow taint and a different question." Both stated bounds also hold — the router returns only `c.take` / `router.fallbackEdge`, edge ids the author declared, and each target re-enters `#decide` at full strictness.

### `A.14` — PARTIAL

> **Partial reads of untrusted values remain in ~25 files.** A revoked `Proxy` throws on

**Tier.** REPRO

**Command.**

```
grep -rln 'Array.isArray' --include='*.ts' packages/core/src | wc -l  (=28); grep -rn 'function isList|function isArrayValue' --include='*.ts' packages/core/src; sed -n '226,234p' packages/core/src/vocab.ts; sed -n '1003,1011p' packages/core/src/telemetry/spans.ts; sed -n '3573,3581p' packages/core/src/run/delivery.ts
```

**Observed.** 28 source files reference `Array.isArray`. Exactly THREE carry the try/catch-total guard, and their bodies are byte-identical (`try { return Array.isArray(v) } catch { return false }`): vocab.ts:228 `isList`, telemetry/spans.ts:1005 `isList`, run/delivery.ts:3575 `isArrayValue`. 28 − 3 = 25 files unswept.

**Finding.** The count and the sweep status hold — the "~25 files" is 25 on the nose, and "three files were swept, the rest were not" is exact. ONE detail is wrong: the three copies live under TWO names, not three — `isList` appears twice (vocab.ts and spans.ts) and `isArrayValue` once. The aggregate expanded: three copies, two names, 25 remaining files.

### `A.15` — UNVERIFIABLE

> **A rare suite flake, four sightings, never reproduced.** The last one was captured

**Tier.** CITED

**Observed.** packages/core/test/cli/cli.test.ts:1495-1535: the `serving` helper accumulates stderr into `err` via `child.stderr.on("data", ...)` and then awaits `until(() => out.includes("  clock:"), ...)` — a known-last line on STDOUT only. `err` is read solely to decorate the failure message; nothing ever waits on it.

**Finding.** UNVERIFIABLE because "four sightings, never reproduced" is a history of observations with no mechanical truth value at a sha — by its own terms it does not reproduce on demand. The one verifiable clause, the LEAD, is CONFIRMED at cli.test.ts:1497-1530: the helper waits for `"  clock:"` on stdout and for nothing on stderr, exactly as the item states.

---

## Section B

### `B.1` — STILL-OPEN

> **Compensation edges** — a compile-time rollback proof and a rewind refusal exist; execution falls through

**Tier.** REPRO

**Command.**

```
grep -ran '"compensation"' packages/core/src --include='*.ts'
```

**Observed.** packages/core/src/run/engine.ts:4972: `case "compensation": break;` inside #edgesToTake. Compile-time proof: packages/core/src/graph/validate.ts:1793-1837 (GRAPH012 — names the compensated node, requires a tool node, requires the manifest to declare a compensation). Rewind refusal: engine.ts:2020-2043 ("cannot rewind to N: <tool> ran at seq N, is irreversible ... with no compensation").

**Finding.** Accurate in all three halves. The only edge kinds skipped in #edgesToTake are `error` and `compensation`; `loop`, `conditional` and the default arm all push edges, so the fall-through is specific to compensation, not a generic skip.

### `B.2` — STILL-OPEN

> **`JoinNode.timeoutMs`** — a barrier waits forever however small a number is written.

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/graph/join-timeout-inert.test.ts   # then grep -ran 'timeoutMs' packages/core/src/graph/validate.ts packages/core/src/run/engine.ts
```

**Observed.** Both tests pass: "A DECLARED JOIN TIMEOUT WARNS THAT IT DOES NOTHING" and "...and it is a WARNING — the graph still compiles". validate.ts:1429-1435 emits the warning ("which no executor reads — this barrier has no deadline"); the only enforced deadline is NodeSpec.timeoutMs, read at engine.ts:2667 in #withNodeDeadline. No engine site reads join.timeoutMs.

**Finding.** Claim holds. Two omissions: (a) it is now a compile WARNING, so an author is told; (b) a stale comment contradicts this — packages/core/test/run/skeleton.ts:81-82 says a join timeoutMs "is a compile error now (`GRAPH008_JOIN_TIMEOUT_UNSUPPORTED`)", which is false: the diagnostic is a warning and that code string exists nowhere in src/.

### `B.3` — STILL-OPEN

> **`Budget.tokens` and `Budget.wallMs`** — declared, never read; only cost binds.

**Tier.** REPRO

**Command.**

```
grep -ran 'budget?\.tokens\|budget\.tokens\|budget?\.wallMs\|budget\.wallMs' packages/core/src packages/eagent/src --include='*.ts'
```

**Observed.** 0 hits. spec.ts:39-43 declares costUsd, tokens, wallMs.

**Control.** the same pattern shape for `budget?.costUsd` returns graph/validate.ts:1517, :1526 and run/engine.ts:1134, :1137

**Finding.** Confirmed. `.wallMs` occurs 10 times in core/src but every one is UsageRecord.wallMs (vocab.ts:335, evolution/score.ts:212, run/escalation.ts:212, …), never Budget.wallMs.

### `B.4` — PARTIAL

> **`preAuthorization`** — a whole risk envelope ... is not a field of the graph schema at all, so declaring one is silence.

**Tier.** REPRO

**Command.**

```
grep -rani 'preauthoriz' packages README.md DESIGN.md TODO.md | grep -v /dist/   # then compiled a graph declaring it, at spec level and at node level, via packages/core/src/graph/compile.ts
```

**Observed.** grep: the string occurs ONLY at TODO.md:150 and TODO.md:198 — nowhere in any source file, so the first half holds. But compiling a graph with the field now FAILS: spec level → ok=false ["GRAPH020_UNKNOWN_FIELD: the graph has an unknown field `preAuthorization`"]; node level → ok=false ["GRAPH020_UNKNOWN_FIELD: node \"n\" has an unknown field `preAuthorization`"].

**Control.** the identical compile() call with the field removed returns ok=true and zero error diagnostics

**Finding.** TRUE half: preAuthorization is not a schema field anywhere in the tree. FALSE half: "declaring one is silence" no longer holds. Commits 78a8fcc ("a node block may not carry a field the compiler cannot interpret") and 94f71e9 ("the unknown-field check now covers all four scopes") made an undeclared key a hard compile error that names the field. This bullet's operative complaint is stale.

### `B.5` — STILL-OPEN

> **Retention tiering** — proven by test, zero callers, so a journal never leaves the hot tier

**Tier.** REPRO

**Command.**

```
for s in TierManager tierFor extractAudit auditViolations MemoryTierStore DEFAULT_RETENTION; do grep -ran "\b$s\b" packages/core/src packages/eagent/src --include='*.ts' | grep -v journal/retention.ts; done
```

**Observed.** Zero hits for all six exported value symbols. The only reference to retention.ts in src/ is the blanket `export * from "./journal/retention.ts"` at index.ts:17; the only real importer in the tree is test/journal/retention.test.ts:23.

**Control.** the same search shape for `compileOrThrow`, another re-exported core symbol, returns agent.ts:274 and engine.ts:4029

**Finding.** Confirmed, and the enumeration is total: retention.ts exports exactly these 6 value symbols plus types, and none has a caller in src/ outside its own file.

### `B.6` — STILL-OPEN

> **The evolution subsystem is now REACHABLE but not wired.** `agent().trajectory(runId)` folds a run

**Tier.** REPRO

**Command.**

```
for s in foldTrajectory measureCohort promotionCeiling gateCandidate requirePromotable isGolden scoreTrajectory validateSuite cohortKeyOf readSignals outcomeOf; do grep -ran "\b$s\b" packages/core/src packages/eagent/src --include='*.ts' | grep -v /evolution/; done
```

**Observed.** foldTrajectory → exactly one caller, packages/core/src/agent.ts:334 `return foldTrajectory(events, { graph })`, exposed as `trajectory(runId)` at agent.ts:331. All ten others → zero callers outside packages/core/src/evolution/. MIN_COHORT_SIZE = 30 at evolution/score.ts:243, used only at score.ts:282.

**Finding.** Every clause checks out. Members of "still uncalled" — cohort measurement: measureCohort, cohortKeyOf, isGolden, scoreTrajectory, readSignals, outcomeOf; promotion ceilings and baselines: promotionCeiling, gateCandidate, requirePromotable, validateSuite. "Roughly thirty" is exactly MIN_COHORT_SIZE=30. "The generator stays deferred" matches gate.ts:19 ("the generator is not useful until a corpus exists") — no generator symbol exists.

### `B.7` — STILL-OPEN

> **Quorum, delegation and trust-tier approvals** — deliberate compile errors rather than silent downgrades.

**Tier.** REPRO

**Command.**

```
compiled one human_gate graph per approval shape via packages/core/src/graph/compile.ts with packages/core/test/run/skeleton.ts's resolver
```

**Observed.** mode:quorum → ok=false [GRAPH014_APPROVAL_UNSUPPORTED "declares approval mode \"quorum\", which the runtime does not implement" + a second for `k`]; mode:all → ok=false [same code]; mode:tiered → ok=false [same code]; delegation.allowed:true → ok=false [GRAPH014_APPROVAL_UNSUPPORTED "declares delegation, which is not enforced"].

**Control.** the identical graph with mode:single returns ok=true and zero error diagnostics

**Finding.** Confirmed, all four shapes. "trust-tier" is ApprovalSpec `mode: "tiered"`. The refusals are at graph/validate.ts:1997-2002 (mode), :2003 (k), :2044-2046 (delegation), and each is written to be deleted by whoever implements it — matching the bullet's second sentence.

### `B.8` — PARTIAL

> **The operator intervention surface** — no pause, resume, steer, redirect or kill; cancel exists.

**Tier.** REPRO

**Command.**

```
grep -an '^  async \|^  [a-z][A-Za-z]*(' packages/core/src/run/engine.ts   # then grep -rani '"pause"\|"resume"\|"steer"\|"redirect"\|"kill"' packages/core/src --include='*.ts'
```

**Observed.** Engine's public methods: submit, advance, sweepGates, deescalate, openGates, resolveGate, openGateBatches, resolveGateBatch, projection, forget, compiledGraphHash, attach, rehydrateGates, cancel, rewind. No pause/resume/steer/kill anywhere. cancel is at engine.ts:1693 and appends {type:"operator.command", payload:{kind:"cancel"}} at engine.ts:1751. BUT redirect IS built: GateDecisionKind includes "redirect" (vocab.ts:79), parsed at vocab.ts:144-176, accepted by the HTTP gate-decision route (server/http.ts:1170, 1199, 1212), applied in Engine.#applyGateDecision (engine.ts:2850+), which rejects a `take` naming any edge outside the node's declared outbound set.

**Finding.** Four of the five named verbs are genuinely absent (pause, resume, steer, kill) and cancel does exist, so that half stands. "redirect" is wrong: a human answering a gate can redirect the run onto chosen outgoing edges, wired end to end. The bullet also omits `rewind` (engine.ts:1830), a second fully-built operator intervention.

### `B.9` — STILL-OPEN

> **The agent-to-agent mailbox** — designed, unbuilt; the edge kinds are seven with no eighth.

**Tier.** REPRO

**Command.**

```
grep -a '^export type EdgeKind' packages/core/src/graph/spec.ts | tr '|' '\n' | grep -ac '"'   # then grep -ran '"mailbox"' packages/core/src packages/eagent/src --include='*.ts'
```

**Observed.** EdgeKind count = 7; spec.ts:488 declares exactly seq, conditional, fanout, join, error, compensation, loop. `"mailbox"` has exactly one occurrence in all of src/: journal/events.ts:259, inside the effect-kind union — a declaration, not a writer.

**Control.** grep -ran 'kind: "subgraph"' packages/core/src → engine.ts:3884, a real appender for a sibling member of the same effect-kind union

**Finding.** Both halves confirmed. `mailbox` is a declared effect kind with no writer, which is the same defect class as B.12's event types but is not covered by either registry there.

### `B.10` — STILL-OPEN

> **A worker pool for CPU-bound function bodies** — declared on the schema, warns at compile that it does nothing

**Tier.** REPRO

**Command.**

```
grep -ran 'node:worker_threads' packages/core/src packages/eagent/src --include='*.ts'   # then grep -ran 'cpuBound' packages/core/src --include='*.ts'
```

**Observed.** Zero `node:worker_threads` imports. FunctionNode.cpuBound is read at exactly one site, graph/validate.ts:1466, which pushes GRAPH019_CPUBOUND_NO_EFFECT, severity warning: "declares cpuBound, which nothing reads — the body runs on the main thread and blocks it".

**Control.** grep -rao 'node:[a-z_]*' packages/core/src | sort -u returns ask, buffer, child_process, crypto, events, fs, http, path, sqlite, vm — ten distinct builtins, so the zero for worker_threads is a real absence

**Finding.** Confirmed, including "blocks the event loop and every task in the wave", which validate.ts:1451-1455 records as measured (1.997x wall for two independent cpuBound nodes).

### `B.11` — STILL-OPEN

> **`run.cancelled.forced`** — written once as `false`, read by nobody, named by no document.

**Tier.** REPRO

**Command.**

```
grep -ran 'forced:' packages/core/src packages/eagent/src --include='*.ts' ; grep -ran '\.forced\b' packages/core/src packages/eagent/src --include='*.ts' ; grep -ani 'forced' README.md DESIGN.md
```

**Observed.** Writers: exactly one, run/engine.ts:1807 `forced: false`, plus the declaration at journal/events.ts:154. Readers: zero hits for `.forced`. Docs: README.md and DESIGN.md never say "forced" — case-insensitive grep matches only "enforced" (README.md:7, DESIGN.md:18).

**Control.** its two sibling fields in the same payload ARE read: telemetry/spans.ts:458 `"cancel.clean": e.payload.clean` and spans.ts:460 `e.payload.unknownEffects.length`

**Finding.** All three clauses hold exactly. Checking the word case-insensitively mattered here: the only near-hits in the docs are the substring inside "enforced".

### `B.12` — PARTIAL

> **Eleven error codes and six event types with no writer**, each excused in a registry.

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/registries.test.ts   (8/8 pass; both pinned lists are asserted as EXACT sets, not floors)   +   git log -p -3 -- packages/core/test/registries.test.ts
```

**Observed.** NEVER_RAISED holds TEN codes, not eleven — E_ADMISSION_REJECTED, E_CHECKPOINT_NOT_FOUND, E_INSUFFICIENT_COHORT, E_JOIN_TIMEOUT, E_LEASE_LOST, E_POLICY_UNAVAILABLE, E_SECRET_UNAVAILABLE, E_STORAGE_FULL, E_TOOL_NOT_IDEMPOTENT, E_TOO_LATE (registries.test.ts:96-108). NEVER_APPENDED holds SIX — budget.reserved, budget.settled, channel.written, config.reloaded, task.skipped, task.started (registries.test.ts:138-160). git log shows the eleventh, E_TOOL_SCHEMA_INVALID, was REMOVED from the pin by commit 069faf4 "fix(run): a tool refusal that will never succeed is not retried", which gave it a raiser at run/engine.ts:4140.

**Control.** independent greps confirm both sets. Each of the ten codes has 0 non-comment occurrences outside errors.ts (E_JOIN_TIMEOUT and E_LEASE_LOST have 2 hits each, all four in comments), while `grep -rah -o 'E_[A-Z0-9_]*' packages/core/src | sort | uniq -c` shows raised codes at 11-72 occurrences. Each of the six event types appears outside journal/events.ts only in `isEvent(e, ...)` fold arms (projection.ts:741,755,971,975; spans.ts:803; trajectory.ts:318), never as `type: "..."`; control types task.leased/task.committed/run.started appear 6/10/5 times as appends.

**Finding.** Seventeen facts expanded. The event-type half is exactly right — six, members as listed. The error-code half is stale by one: TEN, not eleven, since 069faf4. The bullet was true when written (3e5e4bb) and was not updated when the eleventh code gained a raiser. "Each excused in a registry" holds: registries.test.ts pins both as exact sets with length-checked reasons, and test/journal/audit-coverage.test.ts:54-59 cross-pins the same six event types and asserts the two registries agree.

### `B.13` — PARTIAL

> **Nine declared-and-unread schema fields** beyond the above, and four constants whose docstrings

**Tier.** REPRO

**Command.**

```
node /private/tmp/spec_all.mjs — extracts every `readonly <name>:` in packages/core/src/graph/spec.ts (comments stripped) and greps `.name` / ["name"] across all of packages/core/src + packages/eagent/src excluding spec.ts;  then for each constant: grep -ran '\bSYMBOL\b' packages/core/src packages/eagent/src scripts
```

**Observed.** FIELDS: only FIVE graph-schema field names have no property read anywhere in src/ — ExpansionBudget.maxLoopIterations, RetryPolicy.jitter, DelegationSpec.mustStayInGroup, GraphMetadata.labels, NodePlan.inboundEdges. (maxLoopIterations appears only in two comments, engine.ts:4930 and :4948, both stating it has no runtime reader.) Widening "schema" to journal/events.ts payload fields adds 15 more unread names beyond `forced` — actualUsd, addedEdges, budgetConsumed, changed, checkpointId, chunk, fellBack, limitUsd, manifestDigest, newRunId, nodeType, ofGateId, parentHash, reducer, valueDigest — so no reading of "schema" lands on nine.  CONSTANTS: all four confirmed — OBSERVER_POINTS (run/hooks.ts:83), CAN_SUSPEND (graph/spec.ts:816), CONTROL_TYPES (graph/spec.ts:830), createGraphCompiler (graph/compile.ts:72). Every hit for each outside its own file is scripts/surface.json (lines 217, 38, 44, 389) — a public-surface pin, not a consumer — and each docstring now states the absence in place.

**Control.** the same scan resolves readers for 114 of the 119 authoring-schema fields in spec.ts (e.g. ExpansionBudget.maxDepth → compile.ts:154 + validate.ts:2310; NodePlan.outboundEdges → engine.ts:2499,3790; RetryPolicy.maxMs → engine.ts:3776), so a zero is a real absence

**Finding.** SECOND HALF EXACTLY RIGHT and enumerable: commit 3fa3d51 "fix(vocab): a docstring that names a consumer it does not have" names precisely these four as "the four core ones ... fixed as documentation"; a fifth, packages/eagent's FLAGS, was fixed with a test (test/args-vocabulary.test.ts) rather than in place, which is why it is not in the count. FIRST HALF NOT REPRODUCIBLE: no registry names the nine and no defensible member set has nine elements — the graph schema yields 5, event payloads 15 more. By TODO §F.8's own rule this is a count nobody can enumerate. Note too that three fields "the above" excludes (JoinNode.timeoutMs, FunctionNode.cpuBound, EdgeSpec.compensates) are not strictly unread: each has exactly one reader, the compile-time diagnostic that warns it does nothing.

---

## Section C

### `C.1` — STILL-OPEN

> **Eight span names are designed and unbuilt**

**Tier.** REPRO

**Command.**

```
for n in loom.request loom.compile loom.schedule.admit loom.schedule.pick loom.context.assemble loom.effect loom.scheduler.tick loom.replay; do echo "$n $(grep -rao -i -F "$n" packages/core/src packages/eagent/src | wc -l)"; done; echo "CONTROL loom.task $(grep -rao -F 'loom.task' packages/core/src | wc -l)"
```

**Observed.** loom.request 0 / loom.compile 0 / loom.schedule.admit 0 / loom.schedule.pick 0 / loom.context.assemble 0 / loom.effect 2 (both the ATTRIBUTE key `loom.effect.key` at spans.ts:716 and a comment at cli.ts:2592 — zero as a span name) / loom.scheduler.tick 0 / loom.replay 0. CONTROL loom.task = 18. Independent fold (`node /private/tmp/spanaudit/full.ts`, a 19-event synthetic journal through `spansFrom`) emits exactly: loom.checkpoint loom.gate loom.model loom.policy loom.run loom.state.reduce loom.task loom.tool — 8 names, none of the 8 above.

**Control.** grep -rao -F 'loom.task' packages/core/src | wc -l → 18

**Finding.** COUNT IS EXACTLY RIGHT: 8. The members are recoverable only from git history (design corpus deleted at f975f9f, an ancestor of HEAD; `git show f975f9f^:packages/core/test/docs-drift.test.ts` rows 51-99): loom.request, loom.compile, loom.schedule.admit, loom.schedule.pick, loom.context.assemble, loom.effect, loom.scheduler.tick, loom.replay. NINE loom.* symbols sit in that registry; the ninth, `loom.replayed`, is explicitly labelled "an ATTRIBUTE, not a span", which is what makes the span count eight. Correction to a repo note: .agent/backlog/plan.md:221-223 enumerates a WRONG eight — it lists loom.replayed and omits loom.replay. Caveat on the word "designed": the 14 documents that designed these are deleted; the only surviving in-tree design statement is two code comments (spans.ts:707, cli.ts:2592) saying "D9.1 fixes the taxonomy at eight names", which refer to the eight BUILT names, not these.

### `C.1.1` — STILL-OPEN

> loom.request

**Tier.** REPRO

**Command.**

```
grep -rao -i -F 'loom.request' packages/core/src packages/eagent/src | wc -l
```

**Observed.** 0 (control loom.task = 18)

**Control.** grep -rao -F 'loom.task' packages/core/src | wc -l → 18

**Finding.** Registry reason: no journal event covers ingress; first append is run.submitted.

### `C.1.2` — STILL-OPEN

> loom.compile

**Tier.** REPRO

**Command.**

```
grep -rao -i -F 'loom.compile' packages/core/src packages/eagent/src | wc -l
```

**Observed.** 0 (control loom.task = 18)

**Control.** grep -rao -F 'loom.task' packages/core/src | wc -l → 18

**Finding.** Its attributes did not vanish: run.compiled folds graph.nodes/graph.edges/resources.pinned onto loom.run (spans.ts:426).

### `C.1.3` — STILL-OPEN

> loom.schedule.admit

**Tier.** REPRO

**Command.**

```
grep -rao -i -F 'loom.schedule.admit' packages/core/src packages/eagent/src | wc -l
```

**Observed.** 0 (control loom.task = 18)

**Control.** grep -rao -F 'loom.task' packages/core/src | wc -l → 18

**Finding.** Consistent with section A: admission control is itself unbuilt, so there is no event to fold.

### `C.1.4` — STILL-OPEN

> loom.schedule.pick

**Tier.** REPRO

**Command.**

```
grep -rao -i -F 'loom.schedule.pick' packages/core/src packages/eagent/src | wc -l
```

**Observed.** 0 (control loom.task = 18)

**Control.** grep -rao -F 'loom.task' packages/core/src | wc -l → 18

**Finding.** This is the one the deleted 05 doc flagged as marked in two documents but absent from its own inventory table; it is nonetheless a genuine ninth-name gap and is correctly inside the eight.

### `C.1.5` — STILL-OPEN

> loom.context.assemble

**Tier.** REPRO

**Command.**

```
grep -rao -i -F 'loom.context.assemble' packages/core/src packages/eagent/src | wc -l
```

**Observed.** 0 (control loom.task = 18)

**Control.** grep -rao -F 'loom.task' packages/core/src | wc -l → 18

**Finding.** run/context.ts assembles but journals nothing, so the fold has no input.

### `C.1.6` — STILL-OPEN

> loom.effect

**Tier.** REPRO

**Command.**

```
grep -ran -F 'loom.effect' packages/core/src packages/eagent/src; grep -an -E '^\s+name: "loom\.' packages/core/src/telemetry/spans.ts
```

**Observed.** Two hits, neither a span name: spans.ts:716 `"loom.effect.key": e.payload.key` (an attribute) and cli.ts:2592 (a comment). The `name: "loom.*"` sites are 410 run, 485 gate, 650 task, 687 policy, 712 model|tool, 759 state.reduce, 810 checkpoint.

**Control.** same grep matched 2 lines (nonzero) — the pattern is live; it is the SPAN-NAME use that is absent

**Finding.** A naive `grep -c loom.effect` returns nonzero and would wrongly read as built. Every effect folds into loom.model or loom.tool at spans.ts:712 — including `kind: "subgraph"`, which becomes loom.tool.

### `C.1.7` — STILL-OPEN

> loom.scheduler.tick

**Tier.** REPRO

**Command.**

```
grep -rao -i -F 'loom.scheduler.tick' packages/core/src packages/eagent/src | wc -l; grep -ran -i 'tick' packages/core/src/run/scheduler.ts
```

**Observed.** 0 occurrences of the name; 0 lines matching /tick/i anywhere in run/scheduler.ts (control: 'select' matches 6 lines in the same file). The only ticks in core src are the gate/run clocks in cli.ts:1986-2027, which emit no telemetry.

**Control.** grep -ac select packages/core/src/run/scheduler.ts → 6

**Finding.** There is no tick loop to instrument, so this is a design gap, not a wiring gap.

### `C.1.8` — STILL-OPEN

> loom.replay

**Tier.** REPRO

**Command.**

```
grep -rao -i -F 'loom.replay' packages/core/src packages/eagent/src | wc -l
```

**Observed.** 0 (control loom.task = 18)

**Control.** grep -rao -F 'loom.task' packages/core/src | wc -l → 18

**Finding.** Distinct from `loom.replayed`, which the deleted registry classes as an attribute — see C.2. A replay run journals like any other, so a trace cannot tell a replayed run from a live one.

### `C.2` — PARTIAL

> roughly fifteen documented span attributes are never set by anything

**Tier.** REPRO

**Command.**

```
LOOM_PII_TOKEN_KEY=$(openssl rand -hex 32) node /private/tmp/spanaudit/attrs.ts   # folds a 19-event journal through spansFrom and diffs Object.keys(span.attributes) against the D9.1 taxonomy recovered from `git show f975f9f^:design/loom/05-RESOURCES-OBSERVABILITY.md`
```

**Observed.** EMITTED = 54 distinct attribute keys. DOCUMENTED-NEVER-SET on the 8 BUILT spans = 11 (the tool printed 13; `edges.taken` and `gate.escalations` are artefacts of that journal ending in task.cancelled with no gate.escalated — both appear in the fuller fold, so they are set). DOCUMENTED-NEVER-SET belonging only to the 8 unbuilt spans = 22.

**Control.** the same fold emits 54 keys, so the diff is discriminating, not a typo'd pattern

**Finding.** THE COUNT IS WRONG UNDER EVERY SCOPING, and the direction depends on scope. The 11 truly-never-set on built spans: budget.cost_usd, trigger.kind (loom.run); node.type (loom.task); capability (loom.policy); gen_ai.request.max_tokens (loom.model); loom.replayed (loom.model + loom.tool); tool.attempt, tool.source (loom.tool); reducers (loom.state.reduce); gate.posture, gate.batched (loom.gate); loom.checkpoint is clean. TWO MORE were counted as never-set by the source table and ARE set: `state.hash.before` and `state.hash.after` are written at spans.ts:781-782 onto loom.state.reduce — the design claimed them on loom.task, so the defect was a wrong-span claim, not an absence. That gives 13 table cells → "roughly fifteen" is an overcount of the built-span set by ~36%. Widen the scope to the whole 14-row taxonomy and it is a large UNDERCOUNT: 22 more (http.route, tenant.id, project.id, auth.subject, graph.max_width, diagnostics.errors, diagnostics.warnings, queue.depth, concurrency.used, concurrency.limit, admit.decision, wait_ms, ctx.sections, ctx.tokens.before, ctx.tokens.after, ctx.compaction.rung, ctx.hash, effect.key, ready, leased, suspended, tick_ms) = 33 total. Separately, "documented" no longer refers to anything in the tree: the only file that documented these is deleted at f975f9f.

### `C.3` — STALE

> **Two documented reversal conditions are percentiles over spans nobody emits**, so each currently

**Tier.** REPRO

**Command.**

```
grep -rani 'reversal|p99|scheduler.tick|DL-1|DL-7' --include='*.md' README.md DESIGN.md CLAUDE.md TODO.md packages/core packages/eagent | grep -av node_modules
```

**Observed.** Three hits total, and none is a reversal condition: TODO.md:174 and TODO.md:178 (the items themselves) and packages/eagent/CHANGELOG.md:614 (an unrelated latency-histogram entry). No `design/` directory exists.

**Control.** the same pattern matches 3 lines (nonzero) and matches DESIGN.md/README.md content when broadened, so it is not a typo'd pattern

**Finding.** The two conditions are real and were identifiable — DL-1 at design/loom/08-PLAN.md:178 ("measure `loom.scheduler.tick` p99") and D12.8 at design/loom/07-CONFIG-DEPLOY.md:394 — but both documents were deleted at f975f9f, an ancestor of HEAD, so at HEAD there is no document in which either condition "currently reads as a check that passed". The count of two is right about SPANS: DL-7's condition (08-PLAN.md:32, "journal append p99 > 20 ms") is also uninstrumented but is not a percentile over a span, so it correctly stays outside the two. The underlying gap survives (loom.scheduler.tick emitted nowhere — see C.1.7); only the "documented" half is stale.

### `C.4` — STILL-OPEN

> **A trace cannot follow a subgraph.** The journal records the child run id; no span is built

**Tier.** REPRO

**Command.**

```
LOOM_PII_TOKEN_KEY=$(openssl rand -hex 32) node /private/tmp/spanaudit/sub.ts   # a parent journal with subgraph.started/completed carrying childRunId, folded through spansFrom
```

**Observed.** Trace = loom.run, loom.task, loom.tool. The subgraph effect is named `loom.tool` with `effect.kind: "subgraph"`. links = [] on every span, events = [] on every span. `JSON.stringify(spans).includes(CHILD_RUN_ID)` → false. Corroborating: grep -ac subgraph packages/core/src/telemetry/spans.ts → 0, and grep -ac childRunId → 0, against control grep -ac 'checkpoint.created' → 1.

**Control.** grep -ac 'checkpoint.created' packages/core/src/telemetry/spans.ts → 1 (nonzero on the same file)

**Finding.** Both halves confirmed exactly as written. The journal side is real — journal/events.ts:620-631 declares `subgraph.started`/`subgraph.completed`, each with `readonly childRunId: RunId` — and spansFrom names the word "subgraph" zero times, so the child run id reaches no span, no link and no span event. The parent trace's only trace of the child is the string "subgraph" in `effect.kind` on a span called loom.tool.

### `C.5` — PARTIAL

> **No scheduler-tick telemetry**, so queue behaviour is unmeasurable.

**Tier.** REPRO

**Command.**

```
LOOM_PII_TOKEN_KEY=$(openssl rand -hex 32) node /private/tmp/spanaudit/queue.ts   # five tasks with task.ready/task.leased, folded through spansFrom, queue wait read off the TRACE
```

**Observed.** per-task queue wait ms from the trace: [37, 74, 111, 148, 185]; max 185. Computed purely as (loom.task span event named "task.leased").time − span.startTime — no new span, no journal read beyond the fold.

**Control.** same fold; grep -ac select packages/core/src/run/scheduler.ts → 6 while grep -ani tick on that file → 0 lines

**Finding.** FIRST HALF STILL-OPEN, SECOND HALF WRONG. No scheduler-tick telemetry: confirmed — `loom.scheduler.tick` is emitted nowhere and run/scheduler.ts contains no tick loop to instrument (0 lines matching /tick/i, against 6 matching 'select'). But "queue behaviour is unmeasurable" is false as stated: `task.ready` and `task.leased` are journaled for every task and spans.ts:677 already attaches `task.leased` as a span EVENT on the loom.task span, so per-task queue wait and its p99 are a fold over what is already emitted — demonstrated above. The deleted design said this too (07-CONFIG-DEPLOY.md:401, "task.leased.ts − task.ready.ts per Task — queue wait, journaled for every Task, so a p99 over a real run is a fold"), so the TODO overstates its own source. What is genuinely unmeasurable is only the CPU half — event-loop share of CPU-bound function nodes — which needs instrumentation that does not exist.

---

## Section D

### `D.0` — DONE

> Twenty-one, escalated 2026-08-24. Two are now answered

**Tier.** REPRO

**Command.**

```
sed -n '197,201p' TODO.md | tr -d '\n' | sed 's/·/\n/g' | nl   # → 14 items; plus 5 numbered at 189-195 = 19 open, +2 answered = 21
```

**Observed.** 14 run-on items enumerated (13 middots); 5 numbered; 2 answered. 14+5+2 = 21.

**Finding.** THE COUNT IS RIGHT, which is worth saying because the section never enumerates it. Expanded members of the run-on, in order, become D.6–D.19 below; the two answered become D.20–D.21.

### `D.1` — STILL-OPEN

> **The first real workflow to port.** Nobody has yet used this system for something they

**Tier.** REPRO

**Command.**

```
node /private/tmp/dchk/d1c.mjs   (reads .loom/journal.db) ; git ls-files | grep -aiE '\.(json|ya?ml)$' | grep -av package | grep -av tsconfig ; grep -ran 'incidentTriageSpec' packages --include='*.ts' | grep -av /dist/
```

**Observed.** The durable journal holds ONE run, 9 events: run.submitted workflow="g" inputs={}, run.compiled nodes=1 edges=0, then task.failed / run.failed E_RESOURCE_NOT_FOUND 'no function registered as "function/bump@stable"'. Tracked .json/.yaml graph files: 0 (control: the pattern does match ci.yml and surface.json). incidentTriageSpec is called only from packages/core/test/**.

**Finding.** (i) DECISION: OPEN. (ii) OBSERVABLE: the only run that ever reached durable storage is a one-node graph named "g" with empty inputs that FAILED before running a body; no graph file is checked into the repo, and the shipped 'second real workflow' (packages/core/src/workflows/incident-triage.ts) has zero callers outside its own test. §A's claim that the product path was walked end to end is about a graph that is not in the tree, so it is unre-runnable — which is exactly the evidence gap the item names.

### `D.2` — STILL-OPEN

> **The real numbers** — tenants, concurrent runs, runs/day, fan-out width.

**Tier.** REPRO

**Command.**

```
grep -ran 'TenantId' packages/core/src packages/core/test packages/eagent/src --include='*.ts' | grep -av /dist/ ; grep -ra 'RunId' packages/core/src --include='*.ts' | wc -l ; grep -ac -i tenant packages/core/src/journal/sqlite.ts ; grep -ac run_id packages/core/src/journal/sqlite.ts
```

**Observed.** TenantId: exactly 1 hit, its own declaration at packages/core/src/ids.ts:20. Control RunId: 177 hits. sqlite schema: 'tenant' 0, control 'run_id' 31. Engine default maxParallelism = 16 (engine.ts:778).

**Finding.** (i) DECISION: OPEN. (ii) OBSERVABLE: the word 'tenants' has no referent in the running system — `TenantId` is declared and used nowhere, and no tenant column reaches the sqlite journal, so two tenants' runs are indistinguishable in the only authoritative state. `tenantCapabilities` (agent.ts:278, validate.ts:92) is a process-global grant list, not a tenant boundary. The number that IS decided is concurrency: maxParallelism defaults to 16 per process.

### `D.3` — STILL-OPEN

> **When a compensation edge fires** — on task failure, on run failure, or on rewind.

**Tier.** REPRO

**Command.**

```
node --experimental-strip-types /private/tmp/dchk/d3.ts   # start→act(fs.write, throws) --compensation(compensates:act)--> undo ; node --test packages/core/test/workflows/incident-triage.test.ts
```

**Observed.** compiled ok; edge kinds: e1:seq, e2:compensation / run status: failed / tasks: start=succeeded, act=failed / did `undo` ever get a task? false. incident-triage: 17 tests pass, none asserts a compensation node ran ('a compensation target is not an entry node' is compile-only).

**Finding.** (i) DECISION: OPEN — today the answer is 'never, on any of the three'. (ii) OBSERVABLE: a live engine run whose tool node throws leaves the compensation target with no Task at all. The mechanism is engine.ts:4971-4972, `case "error": case "compensation": break;` — compensation is dropped from the take set on success, and `#errorEdges` (engine.ts:5006) filters `e.kind === "error"` only, so it is dropped on failure too. Rewind refuses instead (engine.ts:2020-2044).

### `D.4` — STILL-OPEN

> **Rate-limit backpressure and admission control** — see A. The first half is a live bug.

**Tier.** REPRO

**Command.**

```
node --experimental-strip-types /private/tmp/dchk/d4.ts   # postJson, stub fetch → 429 + Retry-After: 5 ; grep -ran E_ADMISSION_REJECTED packages/core/src --include='*.ts'
```

**Observed.** FIRST HALF: 'sleeps INSIDE the single postJson await: [5000,5000]' — two 5-second holds inside ONE `await postJson(...)`, then E_PROVIDER_RATE_LIMIT retryAfterMs:5000. SECOND HALF: E_ADMISSION_REJECTED has exactly 1 hit in src, its declaration at errors.ts:323 (control E_RUN_NOT_FOUND: 29); POST /runs answered 202 with no admission check (see D.17 probe).

**Control.** grep -ran E_RUN_NOT_FOUND packages/core/src --include='*.ts' | wc -l → 29

**Finding.** (i) DECISION: OPEN, and the first half is confirmed a live bug. (ii) OBSERVABLE — DOES A 429 SLEEP INSIDE THE WORKER SLOT? YES. `hold()` (http.ts:512) awaits inline in postJson's retry loop; postJson is awaited by AnthropicAdapter.stream (anthropic.ts:68) / OpenAIAdapter (openai.ts:57), which the engine awaits at engine.ts:3565 and 4067 inside `#executeTask`; the Task stays `leased` throughout and `leased` is exactly what counts against `#maxParallelism` (engine.ts:5180-5183). The engine's OWN retry does release the slot (task.retry_scheduled, engine.ts:4469-4471) — so the two layers disagree, and the provider layer is the one that holds. Default maxDelayMs × maxAttempts bounds it, but a legal `Retry-After: 86400` is passed through to `LoomError.retryAfterMs` (http.ts:418, measured in its own docstring).

### `D.5` — STILL-OPEN

> **The identity and permission source of truth** for approvers.

**Tier.** REPRO

**Command.**

```
node --experimental-strip-types /private/tmp/dchk/d5.ts   # human_gate with approvers: ["group:sre-oncall", "role:manager"]
```

**Observed.** ok: true diagnostics: 0 — a gate naming a group and a role compiles with nothing said.

**Finding.** (i) DECISION: OPEN. (ii) OBSERVABLE: an approvers list naming a group or a role compiles clean and can never be satisfied, because the runtime check is exact string equality — `approvers.includes(actor.subject)` at gates.ts:1196 and gates.ts:3361. The only shipped source of truth is `readIdentities` (cli.ts:580) parsing `{"subjects":[{"subject","token"}]}` into `BearerTokenIdentity` (http.ts:364); anything else is an injected `IdentitySource` the deployment writes. spec.ts:251-254 states the gap in prose ('roles and groups need an identity resolver Loom does not have'), so the code agrees the decision is unmade — but nothing refuses the graph that assumes otherwise.

### `D.6` — STILL-OPEN

> which approval callback is mandatory

**Tier.** REPRO

**Command.**

```
grep -an '^  async parseCallback\|^  parseCallback' packages/core/src/run/delivery.ts ; grep -an 'class .*Channel' packages/core/src/run/delivery.ts
```

**Observed.** delivery.ts:155 = the optional interface member; delivery.ts:1664 = the ONLY implementation, inside SignedWebhookChannel.

**Control.** 3 channel classes are defined (ConsoleChannel:849, WebhookChannel:945, SignedWebhookChannel:1550); only 1 parseCallback implementation exists

**Finding.** (i) DECISION: OPEN. (ii) OBSERVABLE: of the three DeliveryChannels that ship, exactly one can be answered. `channel.parseCallback !== undefined` IS the answerability test (delivery.ts:142, 1092, 1541), so a gate delivered over ConsoleChannel or WebhookChannel notifies a human who then has no route back — the unauthenticated POST /runs/:id/callbacks/:channel is only mounted when a router exists (http.ts:2972-2981) and refuses channels without a parser. So 'which callback is mandatory' has a de-facto answer today — signed webhook or nothing — that nobody chose.

### `D.7` — PARTIAL

> providers required at launch

**Tier.** REPRO

**Command.**

```
node --experimental-strip-types /private/tmp/dchk/d7.ts   # a --models-file naming provider "gemini", then "bedrock"
```

**Observed.** E_CONFIG_INVALID | adapters[0] has provider "gemini", which must be one of: anthropic, openai. An unknown provider is refused rather than skipped… (same for "bedrock").

**Finding.** (i) DECISION: half ANSWERED IN CODE, half OPEN. The launch set is closed and ENFORCED at boot — `PROVIDERS` (cli.ts:815) is exactly {anthropic, openai}, and OpenAIAdapter with a `baseUrl` is the escape hatch for an OpenAI-compatible gateway (cli.ts:906-913, 946). What is unmade is whether two is sufficient to launch. (ii) OBSERVABLE: naming a third provider does not degrade, it refuses to start, so 'add a provider' is a code change and not a config change — which is what makes the decision cost something.

### `D.8` — PARTIAL

> what a join timeout does

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/graph/join-timeout-inert.test.ts ; grep -ran E_JOIN_TIMEOUT packages/core/src --include='*.ts'
```

**Observed.** 2/2 pass: 'A DECLARED JOIN TIMEOUT WARNS THAT IT DOES NOTHING' and '…and it is a WARNING — the graph still compiles'. E_JOIN_TIMEOUT: 1 hit, its declaration at errors.ts:351, plus 2 docstring mentions in spec.ts. Zero raisers.

**Control.** grep -ran E_TASK_TIMEOUT packages/core/src --include='*.ts' | wc -l → 4 (a sibling code that IS raised, at engine.ts:2701)

**Finding.** (i) DECISION: the SILENT half is closed, the RUNTIME half is OPEN. GRAPH008_JOIN_TIMEOUT_INERT (validate.ts:1429-1435) now warns 'which no executor reads — this barrier has no deadline' and points at node timeoutMs, which IS enforced. (ii) OBSERVABLE: `E_JOIN_TIMEOUT` is declared and raised by nothing, so a barrier still waits forever — the graph just gets told. The shipped incident-triage workflow removed its join timeout for this reason (incident-triage.ts:142-143).

### `D.9` — STILL-OPEN

> whether a function body's output becomes a journaled effect

**Tier.** REPRO

**Command.**

```
node --experimental-strip-types /private/tmp/dchk/d9.ts   # run a 1-node function graph, then replayRun with a SHADOW FunctionRegistry that counts invocations
```

**Observed.** live run: succeeded, body invocations 1 → replay: match= true hermetic= true → SHADOW body invocations during replay: 1.

**Finding.** (i) DECISION: OPEN — today it does NOT. (ii) OBSERVABLE, and it is the sharpest one in this section: a replay that reports `hermetic: true` re-executed the function body LIVE. `#runFunction` (engine.ts:3063) calls the body and returns `out.writes` straight through with no `ctx.effect` boundary, so no effect key is computed and the body never appears in `unknownOutcomes` — which is the only thing `hermetic` is computed from (replay.ts:599). Only the body's nondeterministic INPUTS are journaled (a random seed per task, a lease-derived clock at engine.ts:3058); its OUTPUT is recomputed. The code says so in replay.ts:9-16 and 284-289; the run above shows it. An embedder registering a body that writes a file gets that write again on every replay.

### `D.10` — PARTIAL

> the `preAuthorization` envelope

**Tier.** REPRO

**Command.**

```
node --experimental-strip-types /private/tmp/dchk/d10.ts ; node --experimental-strip-types /private/tmp/dchk/d10b.ts
```

**Observed.** graph scope: ok=false, GRAPH020_UNKNOWN_FIELD `preAuthorization`. node scope: ok=false, same. POLICY scope: ok=true n=0. And then: graph policy `zzz_nonsense` → ok=true n=0; graph policy `posturr: "out"` → ok=true n=0; graph budget `costUsdd: 99` → ok=true n=0; node policy `zzz_nonsense` → ok=true n=0.

**Control.** a bogus key at the graph root → GRAPH020_UNKNOWN_FIELD: the graph has an unknown field `zzz_root` (nonzero, so the probe discriminates)

**Finding.** (i) DECISION: OPEN — no envelope exists. (ii) OBSERVABLE: declaring one is no longer uniformly silent. GRAPH020 now REFUSES `preAuthorization` at the graph root and on a node, so §B's 'declaring one is silence' is stale at two of three scopes. BUT: inside the `policy` block — the one place a risk envelope would naturally be written — it compiles clean. THIS ALSO FALSIFIES §A's 'Now closed at all four scopes': the `policy` and `budget` blocks accept any unknown key, so `posturr: "out"` beside a real `posture` compiles with ZERO diagnostics. That is the same defect class as the `policyy` case §A celebrates closing, one level deeper, and it is still open.

### `D.11` — STILL-OPEN

> token and wall-clock budgets

**Tier.** REPRO

**Command.**

```
node --experimental-strip-types /private/tmp/dchk/d11b.ts   # compile the shipped incident-triage workflow ; grep -rain 'budget\.tokens\|budget\.wallMs' packages/core/src --include='*.ts'
```

**Observed.** declared budget: {"costUsd":2,"tokens":400000,"wallMs":300000} / ok: true diagnostics: 0 / mention tokens/wallMs: 0. `budget.tokens` and `budget.wallMs`: zero readers anywhere in src; validate.ts contains neither word.

**Control.** grep -rain 'budget\.costUsd\|budget?.costUsd' packages/core/src → hits at validate.ts:1517, 1526, 1548 and cli.ts:1039, 1227, 1710

**Finding.** (i) DECISION: OPEN. (ii) OBSERVABLE: the flagship shipped workflow declares a 400k-token and 5-minute ceiling and compiles with ZERO diagnostics — neither binds anything, and unlike `JoinNode.timeoutMs` (GRAPH008_JOIN_TIMEOUT_INERT) and `cpuBound` (GRAPH019) there is no inert-declaration warning for them. The test harness does the same (skeleton.ts:40). So the one family of declared-and-inert fields that got a diagnostic skipped the two that appear in every graph in the tree.

### `D.12` — STILL-OPEN

> the subgraph span

**Tier.** REPRO

**Command.**

```
grep -ac 'loom.subgraph' packages/core/src/telemetry/spans.ts ; grep -an 'subgraph' packages/core/src/telemetry/spans.ts
```

**Observed.** 'loom.subgraph': 0. The word 'subgraph' does not appear in spans.ts at all. The eight span names actually built are loom.run, loom.gate, loom.task, loom.policy, loom.model, loom.tool, loom.state.reduce, loom.checkpoint (spans.ts:410, 485, 650, 687, 712, 759, 810).

**Control.** grep -ac 'loom.task' packages/core/src/telemetry/spans.ts → 12, on the same file

**Finding.** (i) DECISION: OPEN. (ii) OBSERVABLE: `loom trace <runId>` can print a parent run's tree and has no route into the child's, because the span builder never mentions subgraphs — while the engine DOES journal the child run id and writes an `effect.started {kind: "subgraph"}` (engine.ts:3884). The evidence exists in the journal and the projection of it drops the link.

### `D.13` — PARTIAL

> a CPU worker pool

**Tier.** REPRO

**Command.**

```
node --experimental-strip-types /private/tmp/dchk/probe.ts   # a function node with cpuBound: true ; grep -rain worker_threads packages/core/src packages/eagent/src
```

**Observed.** [warning] GRAPH019_CPUBOUND_NO_EFFECT: function node "heavy" declares cpuBound, which nothing reads — the body runs on the main thread and blocks it  FIX: remove cpuBound, or keep the body short enough to run inline — there is no worker pool. worker_threads: exactly 1 occurrence tree-wide, and it is a COMMENT (validate.ts:1451) saying there is no import.

**Finding.** (i) DECISION: OPEN; the silent half is closed. (ii) OBSERVABLE: `FunctionNode.cpuBound` (spec.ts:88) is read only by the diagnostic that refuses to let an author believe in it (validate.ts:1467-1473). validate.ts:1455 records the measurement — two cpuBound function nodes took 2646 ms against 1325 ms for one, i.e. exactly serial. A long body still blocks the event loop and every task in the wave.

### `D.14` — STILL-OPEN

> retention tiering

**Tier.** REPRO

**Command.**

```
grep -rain 'TierManager\|MemoryTierStore\|tierFor(' packages/core packages/eagent --include='*.ts' | grep -av /dist/ | grep -av journal/retention.ts
```

**Observed.** Zero hits outside retention.ts and its own test. `export * from "./journal/retention.ts"` (index.ts:17) is the only thing that touches it in src.

**Control.** the same grep DOES return 20+ hits — every one of them inside packages/core/test/journal/retention.test.ts

**Finding.** (i) DECISION: OPEN. (ii) OBSERVABLE: `TierManager`, `MemoryTierStore` and `tierFor` are exercised only by the test that proves them. Nothing in the engine, the CLI or the control plane ever moves an event out of the hot tier, so a long-lived deployment's journal.db grows monotonically — and §A already measured the amplification at payload × (2N+2), which is what makes the absent caller expensive rather than merely untidy.

### `D.15` — STILL-OPEN

> quorum and delegation

**Tier.** REPRO

**Command.**

```
node --experimental-strip-types /private/tmp/dchk/probe.ts   # human_gate approval: {mode: "quorum", k: 2, delegation: {allowed: true}}
```

**Observed.** 3 errors: GRAPH014_APPROVAL_UNSUPPORTED 'declares approval mode "quorum", which the runtime does not implement' (FIX: use mode: single…); '…declares a quorum k, which only mode: quorum would use'; '…declares delegation, which is not enforced' (FIX: a delegated approval would be recorded as the delegate's own).

**Finding.** (i) DECISION: OPEN, and deliberately refused rather than silently downgraded. (ii) OBSERVABLE: a graph asking for two approvers fails to compile, so the decision has a price a user pays today. Note the sibling of this item HAS landed and the TODO does not say so: validate.ts:2004 reads 'SEPARATION OF DUTIES IS ENFORCED NOW, so the refusal is gone' — so §B's grouped 'Quorum, delegation and trust-tier approvals' is now two of three, with `mode: "tiered"` still refused alongside quorum and all.

### `D.16` — STILL-OPEN

> `run.cancelled.forced`

**Tier.** REPRO

**Command.**

```
grep -ran '\.forced\b\|forced:' packages/core/src packages/core/test --include='*.ts' | grep -av /dist/
```

**Observed.** 1 type declaration (events.ts:154), 1 WRITER (engine.ts:1807, hard-coded `forced: false`), and 6 test fixtures repeating `forced: false`. No read anywhere.

**Control.** the same pattern returns 8 hits, so it is not a typo'd pattern

**Finding.** (i) DECISION: OPEN. (ii) OBSERVABLE: the field is written by exactly one site as a constant `false` and read by nothing — so `run.cancelled` carries a boolean that has never once been true, and an operator reading the journal cannot distinguish 'cancelled cleanly' from 'forced' because the distinction has no producer. It sits beside `clean` and `unknownEffects`, which ARE meaningful, which is what makes it a trap rather than dead weight.

### `D.17` — STILL-OPEN

> the operator surface

**Tier.** REPRO

**Command.**

```
node --experimental-strip-types /private/tmp/dchk/d17.ts   # POST /runs, then POST /runs/:id/commands with eight kinds
```

**Observed.** POST /runs -> 202. kind=pause/resume/steer/redirect/kill -> 400 E_PROVIDER_BAD_REQUEST 'unknown command "…"'. kind=cancel -> 200 status:cancelled. kind=rewind -> 409 E_RESTORE_ILLEGAL (the run was already cancelled). kind=advance -> 200.

**Finding.** (i) DECISION: OPEN. (ii) OBSERVABLE: the whole operator vocabulary over HTTP is three verbs — cancel, rewind, advance (http.ts:2780-2797) — and five of the words §B names are 400s. §B's own phrasing 'cancel exists' UNDERSELLS it: rewind and advance exist too, and rewind is the powerful one. The gate route separately accepts approve/reject/edit/redirect (http.ts:1213), but that is per-gate, not per-run, so an operator watching a live run mid-flight can only stop it or wind it back.

### `D.18` — STILL-OPEN

> the mailbox

**Tier.** REPRO

**Command.**

```
grep -ran '"mailbox"' packages/core/src packages/core/test --include='*.ts' | grep -av /dist/ ; grep -an 'export type EdgeKind' packages/core/src/graph/spec.ts
```

**Observed.** 'mailbox' appears once as a member of the effect-kind union (events.ts:259) and in two docstrings; ZERO writers. EdgeKind = "seq" | "conditional" | "fanout" | "join" | "error" | "compensation" | "loop" — seven, no eighth.

**Control.** grep -ran 'kind: "subgraph"' packages/core/src → engine.ts:3884 writes it, so the effect-kind union does get written

**Finding.** (i) DECISION: OPEN. (ii) OBSERVABLE: `mailbox` is a legal value of `effect.started.kind` that nothing can ever produce — so a reader of events.ts believes agent-to-agent messaging is a recorded effect kind, and `grep` finds no producer. §B's 'the edge kinds are seven with no eighth' is exactly right (spec.ts:488). The declared-but-unwritable enum member is the more dangerous half, because it survives a search for 'is this built?'.

### `D.19` — STILL-OPEN

> the circuit breaker

**Tier.** REPRO

**Command.**

```
grep -ra 'SourceHealth' packages/core/src packages/eagent/src | wc -l ; grep -rai breaker packages/core/src
```

**Observed.** SourceHealth: 0. 'breaker': 2 hits, both docstrings — errors.ts:5 ('machinery (retry policy, HTTP status mapping, circuit breakers) is allowed to…') and hooks.ts:144 ('`retry: false` suppresses a retry the policy would have taken (a circuit breaker, a cost…)').

**Control.** grep -rai health packages/core/src --include='*.ts' | wc -l → 48, on the same tree

**Finding.** (i) DECISION: OPEN. (ii) OBSERVABLE: nothing measures a provider's health and nothing withholds an unhealthy one, so a source that is failing every call is retried at full rate by every task — which compounds D.4: each of those retries also sleeps holding its slot. The only breaker-shaped seam that exists is the `onError` hook (hooks.ts:144), which can SUPPRESS a retry but has no health signal to decide on. §A's wording 'SourceHealth appears nowhere in the code' is exact.

### `D.20` — DONE

> Two are now answered — the UI is the web console

**Tier.** REPRO

**Command.**

```
node --experimental-strip-types /private/tmp/dchk/d20.ts   # boot a ControlPlane on port 0 and GET /
```

**Observed.** GET / -> 200 text/html; charset=utf-8 bytes: 24997 / first line: <!doctype html> / <title>Loom</title>

**Finding.** (i) DECISION: ANSWERED, and the answer is load-bearing rather than declarative. (ii) OBSERVABLE: an unauthenticated GET / on a live control plane serves 25 KB of console HTML — `CONSOLE_HTML` (console.ts:44) imported at http.ts:155, exempted from the auth gate at http.ts:2021, and covered by packages/core/test/server/console.test.ts. The console reads graph names from the credentialed route, not from /health (console.ts:563).

### `D.21` — DONE

> and the terminal client is deleted

**Tier.** REPRO

**Command.**

```
git ls-files | grep -ac 'eagent/tui' ; git show --stat 3e5e4bb | head -5
```

**Observed.** eagent/tui at HEAD: 0 files. Commit 3e5e4bb, 2026-08-25, 'chore(eagent): delete the terminal client; the operator surface is the browser' — removed packages/eagent/tui/** and scripts/release-tui.mjs.

**Control.** git ls-files | grep -ac 'eagent/src' → 106, so the pattern machinery works

**Finding.** (i) DECISION: ANSWERED, by deletion, with a commit that says why. (ii) OBSERVABLE: no TUI source, no ink dependency and no release script remain; the four TUI design documents went with the corpus in f975f9f. There is no second operator client to keep in step with the console, which is what makes D.20 cheap to hold.

---

## Section E

### `E.1` — PARTIAL

> **Distributed deployment.** A distributed v1 by a small team yields a distributed prototype, not a product. The interfaces are shaped for it; nothing is built.

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/journal/store.test.ts ; node --test packages/core/test/run/contention.test.ts ; grep -an '^export class' packages/core/src/run/scheduler.ts ; grep -arn 'implements StateStore' packages/core/src packages/eagent/src ; grep -an 'Scheduler' packages/core/src/cli.ts
```

**Observed.** store.test.ts: 68 pass (conformance run against BOTH MemoryStateStore and SqliteStateStore). contention.test.ts: 13 pass, incl. 'a reclaimed lease's fencing token is STRICTLY greater', 'the DEAD worker's late commit is REFUSED', 'over 20 Tasks neither worker starves and nothing runs twice'. scheduler.ts exports InProcessScheduler (147) AND LeasedScheduler (177). Only two StateStore impls, both local (memory.ts:37, sqlite.ts:174). grep 'Scheduler' over cli.ts: NO MATCHES.

**Control.** grep -an 'Scheduler' packages/core/src/cli.ts returns 0 lines; control grep -an 'listen(' packages/core/src/cli.ts returns 1 (line 2320), so the file and pattern engine are live.

**Finding.** SECOND HALF IS FALSE AS WRITTEN. 'The interfaces are shaped for it' HOLDS: run/scheduler.ts is an explicit documented seam, and the journal conformance suite really does run against two implementations. But 'nothing is built' is not true — scheduler.ts:177 `LeasedScheduler` implements two of the three distributed behaviours its own docstring names (skip live leases, reclaim expired ones) and 13 contention tests exercise them against folded journals for two workers. What is genuinely absent is (a) partition assignment — which is item E.2, not this one — and (b) any multi-HOST path: both StateStore impls are local files/memory, and `loom serve` binds 127.0.0.1 (see E.8). Also worth recording: LeasedScheduler has zero callers outside its own file; cli.ts never names a Scheduler, so `loom serve` always runs InProcessScheduler. So the accurate statement is 'the seam and the leasing half are built and tested but unreachable from the product path; the coordinator and the transport are not'.

### `E.2` — PARTIAL

> **Partition assignment and cross-run fairness.** Deciding which runs a worker considers needs a coordinator, and half a coordinator is worse than none.

**Tier.** REPRO

**Command.**

```
node --test /private/tmp/claude-501/e-audit/e2.test.ts  (builds a SqliteStateStore with 201 run heads via newRunId(), then calls listRuns(200) — the exact call startRunClock makes)
```

**Observed.** runs in store: 201 returned by listRuns(200): 200 / oldest run 01HF7YAT00BY95XFVVRYA9KHZG in the swept window? false / newest run 01HF7YGXA0CD4JAE8Z8VBMFFCF in the swept window? true. Source: cli.ts:1981 `const DEFAULT_RUN_CLOCK_LIMIT = 200`, cli.ts:1990 `await ws.store.listRuns(limit)`, cli.ts:2322 `startRunClock(ws, everyMs, DEFAULT_RUN_CLOCK_LIMIT)`; sqlite.ts:437 `ORDER BY run_id DESC LIMIT ?`, and ids.ts:96 makes RunId a ULID, i.e. lexicographically time-ordered.

**Control.** The same assertion on the NEWEST run passes (`seen.has(ids[200]) === true`), so the 'false' on the oldest is a real exclusion and not an empty/typo'd lookup.

**Finding.** THE NORMATIVE HALF HOLDS; THE IMPLIED FACTUAL HALF IS FALSE. 'Partition assignment across workers needs a coordinator' is still true and still unbuilt. But 'deciding which runs a worker considers' has NOT been left undecided — `loom serve` already decides it, with a newest-200-first window and nothing else. With 201 live runs the oldest is never projected, never rehydrated and never advanced by the run clock; it sits until someone POSTs {"kind":"advance"} by hand. That is precisely the 'half a coordinator' the reason says is worse than none, and it shipped silently inside the product path rather than being deferred. The deferral is defensible; the reason as written hides an existing starvation policy.

### `E.3` — STILL-OPEN (overturned from WRONG)

> **Automated candidate generation, canaries and auto-promotion.** Under roughly thirty scored trajectories per cohort, any candidate is fitted to noise.

**Tier.** REPRO

**Command.**

```
node --test /private/tmp/claude-501/e-audit/e3.test.ts ; grep -aic 'runstatus' packages/core/src/evolution/score.ts ; grep -arn 'isGolden\|scoreTrajectory\|measureCohort' packages/core/src packages/eagent/src | grep -av 'evolution/score.ts:'
```

**Observed.** readSignals output is BYTE-IDENTICAL for runStatus succeeded / failed / cancelled: [{"id":"S1","value":1,"weight":1,"evidence":"1/1 assertions passed"}]. With a 30-member cohort: runStatus: failed, outcome: 1, score: 0.7, conditions 1:true 2:true 3:true 4:true 5:true, GOLDEN = true, promotionCeiling = {"channel":"stable","requiresHumanSignOff":false}. grep -aic runstatus in score.ts = 0. scoreTrajectory / isGolden / measureCohort / promotionCeiling have ZERO callers anywhere in src.

**Control.** grep -ac 'outcome' packages/core/src/evolution/score.ts = 15 (the file is read and the pattern engine works, so the 0 for runStatus is a real absence). For the caller absence: grep -arn compileMutation over src minus its own file = 2 callers, so the same query shape does find callers when they exist.

**Finding.** THE REASON'S PRESUPPOSITION IS FALSE. `OutcomeSignals.runStatus` is captured by the fold (trajectory.ts:96, set at :217/:223/:227) and then read by nothing: `readSignals` (score.ts:131-173) branches only on assertions, humanDecisions, the caller-supplied downstream outcome, rubrics and selfReported, and `isGolden`'s five conditions never mention it either. A run that emitted `run.failed` scores identically to one that emitted `run.completed`, clears all five golden conditions, and gets promotionCeiling stable / requiresHumanSignOff false. So the blocker is not a short sample — it is that the scorer cannot tell a failed run from a successful one, and no sample size fixes that. Compounding it: nothing in the product ever calls the scorer, so 'thirty scored trajectories per cohort' describes a quantity no shipped path produces (only foldTrajectory is wired, at agent.ts:334); the whole of evolution/score.ts and evolution/gate.ts is library surface re-exported from index.ts:58-60 with no internal consumer.

**Adversarial ruling: OVERTURNED.** The prior agent's facts reproduce, but they do not support WRONG. I re-ran them at REPRO tier and stronger — folding a REAL engine event stream (not a hand-built trajectory) and swapping run.completed for run.failed leaves readSignals byte-identical ([S2 approve w=0.9, S5 w=0]), outcome 1, all five golden conditions true, promotionCeiling {"channel":"stable","requiresHumanSignOff":false}; grep -aic 'runstatus' score.ts = 0 with control grep -aic 'assertions' score.ts = 4; and scoreTrajectory/isGolden/measureCohort/promotionCeiling/gateCandidate/requirePromotable/readSignals have zero callers in packages/core/src or packages/eagent/src, with foldTrajectory -> agent.ts:334 as the control proving the pattern discriminates. But that finding is an ADDITIONAL defect, not a falsification. The item's stated reason is encoded and mechanically enforced: MIN_COHORT_SIZE = 30 (score.ts:243), isGolden's header comment says '4 blocks fitting to noise', and my test shows n=30 -> GOLDEN true while n=29 -> cond4 false, GOLDEN false — the discriminator the prior agent never ran before calling the reason a 'false presupposition'. The item's subject is genuinely deferred and the code says so in its own words: gate.ts:18 'synthesis and canary rollout are DEFERRED-v2 ... the generator is not useful until a corpus exists'. The prior agent's strongest evidence — 'nothing in the product calls the scorer' — is section E's premise, not a refutation of it; under that reasoning every section-E entry would be WRONG since none of them is built. And an entry reading 'we deferred X for reason R' is not made false by discovering a further blocker S; 'no sample size fixes that' ranks blockers, which is a judgement, not a truth value of the text. Correct verdict STILL-OPEN. The runStatus blindness deserves a NEW section-A item ('readSignals ignores OutcomeSignals.runStatus; a failed run scores golden and ceilings at stable'), not the deletion of E.3. Command: node --test /private/tmp/e3-audit/e3.test.ts ; grep -aic 'runstatus' packages/core/src/evolution/score.ts ; grep -aic 'assertions' packages/core/src/evolution/score.ts ; for s in scoreTrajectory isGolden measureCohort promotionCeiling gateCandidate requirePromotable readSignals foldTrajectory; do grep -arn "\b$s\b" packages/core/src packages/eagent/src | grep -av 'evolution/score.ts:' | grep -av 'evolution/gate.ts:'; done ; grep -arn 'DEFERRED-v2' packages/core/src packages/eagent/src. Tree left clean (git status --porcelain empty at 86b84c9).

### `E.4` — STILL-OPEN

> **Subtractive graph mutation.** Additive-only keeps the executed graph a superset of the compiled one, which is what makes the compiled artifact meaningful.

**Tier.** REPRO

**Command.**

```
node --test /private/tmp/claude-501/e-audit/e4.test.ts ; node --test packages/core/test/graph/mutate.test.ts
```

**Observed.** Probe: base nodes 'plan' -> after 'plan,detail'; every base node's spec deepEqual after mutation; added = detail. A mutation object carrying `removeNodes: ["plan"]` compiles ok and 'plan' is STILL PRESENT — the field is simply not part of GraphMutation (addNodes/addEdges/proposedBy/proposedByNode/reason, mutate.ts:27-34) and is ignored. mutate.test.ts: 22 pass, incl. 'a mutation may not rewire two nodes that already exist', 'A MUTATION INHERITS WHAT THE RUN ALREADY FROZE, and only ADDS to it', 'a run that restarts mid-flight rebuilds its mutated graph FROM THE JOURNAL'.

**Finding.** REASON HOLDS, verified rather than read. The superset property is real: base node specs survive a mutation deepEqual-identical, and there is no expressible removal — an unknown `removeNodes` key is inert, so subtractive mutation is not merely unimplemented but unrepresentable in the mutation type. Nothing to revive; nothing wrong with the stated reason.

### `E.5` — STILL-OPEN

> **Custom user-authored reducers.** Arbitrary code inside the determinism boundary.

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/graph/authoring-mistakes.test.ts ; grep -arn 'registerReducer\|customReducer\|reducerRegistry' packages/core/src packages/eagent/src
```

**Observed.** 'A REDUCER THE STATE LAYER DOES NOT KNOW IS REFUSED' passes (7/7 in that file); validate.ts:676 `if (!REDUCER_NAMES.includes(reduce as never))` -> GRAPH003_UNKNOWN_REDUCER. ReducerName is a closed union of exactly 8 members (channels.ts:28-37: replace, append_ordered, merge_object, sum, max, min, union_set, last_write_wins_by_ts). registerReducer/customReducer/reducerRegistry: 0 hits across BOTH packages' src.

**Control.** grep -arn 'registerTool\|register(' packages/core/src/run/registry.ts = 6 hits, so a registration API is exactly the shape this tree does have where it wants one — and it has none for reducers.

**Finding.** REASON HOLDS. The reducer set is closed at the type level, re-checked at compile time by name against REDUCER_NAMES, and there is no registration seam anywhere in either package for a caller to hand in reducer code. The 8 members are enumerated above so the 'closed set' claim is checkable rather than asserted. This is the one item where the deferral and the mechanism agree completely.

### `E.6` — UNVERIFIABLE

> **Free-form agent chatter.** Makes termination unprovable and replay quadratic.

**Tier.** REPRO

**Command.**

```
grep -an 'EdgeKind =' -A1 packages/core/src/graph/spec.ts ; grep -arn '"mailbox"' packages/core/src packages/eagent/src ; node --test packages/core/test/run/loop-bound.test.ts packages/core/test/graph/budget-bound.test.ts
```

**Observed.** EdgeKind has exactly 7 members and no message kind (spec.ts:488: seq, conditional, fanout, join, error, compensation, loop). `"mailbox"` occurs exactly ONCE in all of src — inside the effect-kind union at journal/events.ts:259 — with no writer. Termination bounds pass: 7/7 across loop-bound + budget-bound, incl. 'A ROUTER CANNOT RE-ENTER A LOOP ITS OWN EDGE HAS FINISHED' and 'THE COMPILER ALREADY REFUSED WHAT THE EXECUTOR THEN IGNORED'.

**Control.** grep -arn '"subgraph"' packages/core/src packages/eagent/src = 17 hits, so the quoted-literal search does find a live effect kind; the single hit for "mailbox" is a real absence of writers, not a bad pattern.

**Finding.** UNVERIFIABLE because the reason is a complexity claim about a mechanism that does not exist — there is no chatter to replay, so 'replay quadratic' has no measurable referent, and it names no count and no symbol. What IS verifiable and does check out: the factual precondition. No agent-to-agent messaging ships (7 edge kinds, no eighth; the reserved `mailbox` effect kind at events.ts:259 has zero writers, matching TODO.md:162's 'designed, unbuilt'), and termination-by-construction is currently enforced rather than hoped — loop re-entry and the expansion budget are both compile- and executor-checked. Recording this so a future reader is not tempted to treat the reason as having been tested; it has not been, and it cannot be until something is built to test.

### `E.7` — PARTIAL

> **seccomp / Landlock.** Platform-specific; subprocess isolation plus a filesystem jail plus an egress allowlist covered the stated threat model.

**Tier.** REPRO

**Command.**

```
node --test /private/tmp/claude-501/e-audit/e7.test.ts ; node --test /private/tmp/claude-501/e-audit/e7b.test.ts ; node --test packages/core/test/sandbox/subprocess.test.ts ; node --test packages/core/test/builtin/tools.test.ts ; git grep -ain 'threat model'
```

**Observed.** e7: fs.read /etc/hosts -> 'refused: path "/etc/hosts" escapes the sandbox root'; proc.exec (allow-list = process.execPath) reading the SAME file -> 'exit=0\n213'. e7b: with NO egressAllowlist at all (net.fetch confirmed unregistered), proc.exec opened its own TCP socket to a local listener -> 'exit=0\nCONNECTED'. The three named mitigations do exist and pass: subprocess.test.ts 35/35; tools.test.ts 29/29 incl. 'fs.read CANNOT EXFILTRATE THROUGH A SYMLINK OUT OF THE JAIL', 'net.fetch is not even REGISTERED without an egress allowlist', 'NET.FETCH DOES NOT FOLLOW A REDIRECT OFF THE ALLOWLIST'. The stated threat model is packages/eagent/SECURITY.md:6.

**Control.** For each escape the SAME probe runs the in-process control first and it refuses (fs.read on /etc/hosts throws; net.fetch is absent from the tool list), so the subprocess result is a real difference in confinement, not an unconfigured jail. git grep 'threat model' returns 6 hits across the tree, so the pattern is live.

**Finding.** 'PLATFORM-SPECIFIC' HOLDS (both seccomp and Landlock are Linux-only; this tree runs darwin) and the three mitigations are real and tested. 'COVERED THE STATED THREAT MODEL' IS FALSE, and the tree says so twice in its own words. The stated model (packages/eagent/SECURITY.md:6) puts prompt-injection-driven exfiltration explicitly in scope, then its own 'What the kernel does NOT defend' section says 'A subprocess is not a sandbox... generated code still runs as the local user'; core/src/sandbox/subprocess.ts:19 says the jail 'is the CALLER'S to apply' and runSandboxed never inspects argv; and test/builtin/proc-exec.test.ts's header states outright that once a subprocess is reachable, 'deny and the branch overlay are advisory'. Measured, that is exactly what happens: one allow-listed binary reads outside the jail and opens an arbitrary socket, bypassing both of the other two mitigations. The three do not compose — the jail and the egress allowlist bound only in-process tools, and proc.exec's command-name allowlist is the entire boundary. Deferring seccomp/Landlock may still be right; the claim that the remaining three cover the model is not.

### `E.8` — PARTIAL

> **Vendor callback parsing** (Slack, Teams, email). Delivery outward is built; the return trip needs per-vendor signature verification.

**Tier.** REPRO

**Command.**

```
node packages/core/src/cli.ts serve --port 8791 & lsof -nP -iTCP:8791 -sTCP:LISTEN ; node packages/core/src/cli.ts serve --host 0.0.0.0 --port 8792 ; node --test packages/core/test/server/http.test.ts ; node --test packages/core/test/run/callback.test.ts ; grep -arni 'smtp\|sendmail\|nodemailer' packages/core/src packages/eagent/src
```

**Observed.** serve prints 'loom listening on http://127.0.0.1:8791' and lsof shows 'TCP 127.0.0.1:8791 (LISTEN)' — loopback only, never 0.0.0.0. `--host 0.0.0.0` is refused: 'E_CONFIG_INVALID: unknown flag: --host'. http.ts:1696 `async listen(port: number, host = "127.0.0.1")`; cli.ts:2320 `await plane.listen(wanted)` passes no host. Return trip: http.test.ts 127/127 incl. 'A SIGNED CALLBACK ANSWERS A GATE WITH NO BEARER TOKEN', 'NO BEARER + WRONG SIGNATURE => REFUSED, AND THE GATE STAYS OPEN', 'a stale callback is refused over the wire too'; callback.test.ts 85/85. SMTP/mail sender: 0 hits in either src (one unrelated `mailto:` regex comment in security/redact.ts:341).

**Control.** The same CLI accepted `--port` in the same invocation that refused `--host` (the server bound and announced), so the refusal is flag-specific, not a broken command. For the email absence: grep -aci 'webhook' packages/core/src/run/delivery.ts = 37, so the delivery file is being read.

**Finding.** BOTH CLAUSES ARE OFF, IN OPPOSITE DIRECTIONS. 'Delivery outward is built' holds for the two HTTP-webhook vendors (Slack, Teams) via the generic WebhookChannel, but NOT for email: there is no SMTP or mail transport anywhere: `email` exists only as an Actor.via label in the VIA map at delivery.ts:1517. 'The return trip needs per-vendor signature verification' is FALSE — signature verification is done and shipped: SignedWebhookChannel (delivery.ts:1550) implements Slack's exact scheme, HMAC-SHA256 over v0:{ts}:{body}, timing-safe compare, timestamp bound INTO the signed material, bounded replay window; it is wired through --channels-file to an unauthenticated POST /runs/:id/callbacks/:channel (http.ts:1071, 1608) and answers a real gate over real HTTP in the tests. What is actually missing is per-vendor payload SHAPE parsing — `subjectOf`/`decisionOf` are injectable hooks with no Slack/Teams/email implementation — plus the reachability gap the reason never mentions: `loom serve` binds 127.0.0.1 and has no --host flag, so no vendor can reach the callback route without an out-of-band proxy or tunnel.

---

## Section F

### `F.1` — DONE

> **Every durable fact must be rebuildable by folding the log.** Five separate in-memory fields

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/run/oversight-survives-restart.test.ts packages/core/test/run/secret-flow.test.ts
```

**Observed.** tests 12, pass 12, fail 0 — incl. "E4's STREAK SURVIVES A RESTART", "A HUMAN CEILING SURVIVES A RESTART", "spend survives a restart", "THE FLOW SET SURVIVES A RESTART", each with a same-process CONTROL.

**Finding.** THE COUNT IS ENUMERABLE AND IS ENUMERATED IN THE TREE — the task's premise is wrong. packages/core/test/run/oversight-survives-restart.test.ts:4-19 names all five: (1) PolicyEngine escalations, (2) human ceilings, (3) accumulated spend, (4) the taint set, (5) E4's failure streak. Independently enumerated in the commit record: `git log -1 3139bc7` reads "Fifth member of invariant 2's class, after escalations, ceilings, spend and taint." The three sites TODO.md:227 / CLAUDE.md:55 / DESIGN.md:90 are consistent with that list. NEWEST INSTANCE: no new violation. The newest field of the same shape, `ctx.carriesSecret` (85214a5, 2026-08-25), was born WITH its restore arm — packages/core/src/run/engine.ts:987 calls applySecretFlow inside #restoreEvidence beside applyTaint, and its restart test passes. ONE RESIDUAL, reported as not-a-violation: `ctx.warnedBudget` (engine.ts:694, initialised false at 2293 in #contextFor, read/written at 4870-4871) is memory-only with no fold, so a restart re-fires E2 — but escalations compose by `max`, so it fails toward tightening rather than switching a guard off. Verdict HELD.

### `F.2` — DONE

> **A vocabulary with two representations will drift**, and every gate walking the wrong one is

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/registries.test.ts packages/core/test/registries-are-populated.test.ts && node --test packages/core/test/graph/allowed-fields.test.ts
```

**Observed.** registries: tests 10, pass 10 (both directions for codes, event types, escalation rules; one-file rule for telemetry). allowed-fields: tests 9, pass 9, incl. "A MISSPELLED `policy` IS REFUSED" and a compiling control.

**Finding.** MEMBER LIST REFRESHED. packages/core/test/registries.test.ts:10-15 names four vocabularies; live sizes measured by importing the sources: CODES = 68, EVENT_TYPES = 52, ESCALATION_RULES = 10, telemetry names (declared in telemetry/spans.ts only, by rule). NEWEST VIOLATION: 93b3420, 2026-08-25 — the set of legal field names had two representations (the TS interfaces vs what the compiler actually read), and `policyy: {posture:"in"}` on a tool node compiled to plan posture `out` with ZERO diagnostics while `policy:` gave `in`. Closed across all four scopes (node block, node, graph, edge) at packages/core/src/graph/spec.ts:694 ALLOWED_FIELDS and 708ff. HELD at HEAD, violated 1 day before HEAD.

### `F.3` — STILL-OPEN

> **A guard's permissive branch is where the surprise lives.** Refusals attract tests; the arm that

**Tier.** REPRO

**Command.**

```
git log -1 --format='%s%n%b' 086e13b; grep -an 'proposedAt' packages/core/src/evolution/gate.ts
```

**Observed.** 086e13b 2026-08-25 "fix(evolution): a promotion check reached by omission is not a check" — "`proposedAt === undefined || …` handed the criterion to anyone who did not answer it… That is the permissive-default shape refused everywhere else here, sitting in the gate that decides whether an optimizer may promote its own work." Live code at gate.ts:464-505.

**Finding.** VIOLATED-AGAIN, 1 new instance: 086e13b (2026-08-25), promotion criteria 9 and 10 in packages/core/src/evolution/gate.ts. Sharpest fact available: the property was first WRITTEN DOWN at 3ddfa03 (2026-08-24, "a guard's dangerous-looking branch attracts the tests; the permissive one is where the surprise lives") and was violated again the NEXT day. Two other instances in the same window: c08cf16 (2026-08-24, "the two auth refusals that fail open were the two nobody tested") and 47b11d2 (2026-08-24, "the mutation sweep found the arm no test was holding"). Fixed at HEAD; the property is not stale, it is recurring.

### `F.4` — PARTIAL

> **Mutation-test every guard.** Several tests in this codebase could not fail. A sweep only kills

**Tier.** REPRO

**Command.**

```
grep -an 'test-timeout|timeout-minutes' package.json packages/*/package.json .github/workflows/ci.yml scripts/*.mjs  # then: node watchdog spawning `node --test hang.test.mjs` with and without --test-timeout
```

**Observed.** Absence grep rc=1 (nothing), control `grep -acn test` on the same two files → package.json:5, ci.yml:2 (nonzero, so the pattern is not typo'd). Watchdog: bare `node --test` on a test awaiting a never-resolving promise was STILL RUNNING after 8000 ms and had to be SIGKILLed; the same file with `--test-timeout=2000` exited code 1 after 2082 ms.

**Finding.** THE HALF THAT HOLDS: the practice is real but narrow — 7 of 268 test files record having been mutation-tested (predicate-on-throws, workspace-documents, known-flags, spans, oversight-survives-restart, replay, gate-guards), and packages/core/test/registries-are-populated.test.ts exists precisely to stop an "every X" loop passing vacuously (10/10 pass). THE HALF THAT DOES NOT: the method is defeatable exactly as the question suspected. `npm test` is `node --test "packages/*/test/**/*.test.ts"` with NO --test-timeout (package.json:18), and .github/workflows/ci.yml sets no timeout-minutes on the `check` job. Node's default per-test timeout is Infinity — measured above. So a mutation that HANGS is never killed by the runner; CI falls through to GitHub Actions' 360-minute job default, i.e. six hours burnt and a red build that names no test. A one-word fix (`--test-timeout=60000`) turns a hang into an ordinary kill. Second claim, "Several tests in this codebase could not fail": UNVERIFIABLE as stated for today's tree — I scanned all 3486 `test(` call sites for assertion-free bodies and every one of the 44 hits was a false positive (helper-based assertions such as `expectCode(...)` at compile.test.ts:112).

### `F.5` — PARTIAL (overturned from DONE)

> **Driving beats sweeping.** Every wave that found real defects found them by running a new shape

**Tier.** REPRO

**Command.**

```
git log -1 --format='%s%n%b' f3c20ea; git log --format='%h %ad %s' --date=short f3c20ea..HEAD | wc -l; git show 86b84c9 -- TODO.md
```

**Observed.** f3c20ea records the original numbers: "Five sweeps derived from a previous finding produced about one and a half defects between them; nine surfaces driven end to end produced six." 55 commits since. HEAD's own TODO diff: "The whole product path has now been walked end to end… Two defects came out of the last two steps, which is where they always are."

**Finding.** COUNT REFRESHED and the asymmetry widened, not narrowed. In the f3c20ea..HEAD window the driving side kept producing: 069faf4 (2026-08-25) says in its own body "FOUND BY USING THE THING. Authoring a report-to-file graph through bin/loom…"; f74d863 is "D4 was wrong for this graph model, and building it is how I know"; HEAD's product-path walk yielded two more (9b1efd5, 1d59621, both trace-surface). I found no sweep-derived defect in that window. No new instance of the property being violated.

**Adversarial ruling: OVERTURNED.** Two failures, one of them the exact class I was told to attack. (1) THE COUNT IS WRONG. `git log --format=... f3c20ea..HEAD | wc -l` gives 53, not 55; so do `git rev-list --count f3c20ea..HEAD`, `--no-merges`, and `git log --oneline | wc -l` (all 53). No variant produces 55. (2) THE ABSENCE CLAIM IS FALSE. "I found no sweep-derived defect in that window" had no command behind it and is contradicted by the window's own subject lines: commit 37 of 53 is 47b11d2 (2026-08-24) "test(run): the mutation sweep found the arm no test was holding" — its body: "Four mutations of `#restoreEvidence` died and one lived: a fold that records every `task.committed` as a FAILURE … passed all three streak tests", i.e. a sweep found a test that could not fail (a real defect by §F.4's own standard). Commit 49 is c08cf16 "the two auth refusals that fail open were the two nobody tested", whose body demonstrates `token: [] as unknown as string` → plane constructs, `/health` says auth required, `GET /runs` with no Authorization returns 200 — found by sweeping the permit arms, not by driving. So the item's universal clause ("EVERY wave that found real defects found them by running a new shape of thing") is falsified inside the very window offered as evidence; the hedged clause ("sweeps … MOSTLY found nothing") survives, and the driving-side commits cited (069faf4 "FOUND BY USING THE THING", f74d863, 9b1efd5, 1d59621) all exist as described. PARTIAL, not DONE. To establish a DONE you would have to enumerate the waves in the window and classify each — a named set, per §F.8 — not assert an absence.

### `F.6` — STILL-OPEN

> **A test built from the same mental model as the fix certifies the model, not the mechanism.**

**Tier.** REPRO

**Command.**

```
git log -1 --format='%s%n%b' ab329be; node --test packages/core/test/run/declared-effects.test.ts
```

**Observed.** ab329be 2026-08-25: "The suite could not see it because the test asserted awaiting_gate and charged === 0 and stopped there, never resuming." The repaired test now resumes — declared-effects.test.ts:184-196 — and passes 6/6.

**Finding.** VIOLATED-AGAIN, 1 new instance: ab329be (2026-08-25), the declared-effects feature. The test was written from the same model as the feature ("a gate must stop the charge") and therefore stopped at the gate, so it could not see that approving the gate produced a refusal string in a channel, a `succeeded` run, and no charge. Fixed at HEAD, and the fix is the right shape: the regression test resolves the gate and re-advances rather than asserting the pre-gate state. Earlier instances in the same week: 4d3eb05 (2026-08-24, "a wrong function body is invisible to any test that does not read what it wrote") and 124b6d4.

### `F.7` — STILL-OPEN

> **Reproduce by running, not by reading** — including when correcting a document. A correction

**Tier.** REPRO

**Command.**

```
grep -arn '00-OVERVIEW|01-INTERFACES|02-EXECUTION-GRAPH|03-RUNTIME|04-OVERSIGHT|05-RESOURCES|06-EVOLUTION|07-CONFIG-DEPLOY|08-PLAN|99-DOD|HANDOFF\.md|JOURNAL\.md|REGISTER\.md|design/loom' --include='*.ts' --include='*.mjs' packages scripts | grep -v '/dist/' | wc -l
```

**Observed.** 31 citation lines across 23 non-dist files. Control on the same corpus: `git ls-files | grep -ac 'design/'` → 0 of 521 tracked files, and `ls design` → No such file or directory, so the targets really are gone; second control, `grep -ral 'TODO\.md'` on the same file set → 3 (pattern is not typo'd).

**Finding.** VIOLATED-AGAIN, live in the tree at HEAD. f975f9f's commit message asserts "51 source and test files had citations into it; those are stripped" — that claim was written rather than run, and 23 files with 31 lines still point at documents that no longer exist. Sample: packages/core/src/graph/validate.ts:2668 (`02-EXECUTION-GRAPH.md` says…), validate.ts:1376, 1448, 2497; packages/core/src/run/policy.ts:129; packages/core/src/graph/spec.ts:201 (`design/HANDOFF.md`); packages/core/src/sandbox/subprocess.ts:661,755 (`01-INTERFACES.md D3.20`, `03-RUNTIME.md`); packages/core/src/run/delivery.ts:1996; packages/core/src/security/redact.ts:808; packages/core/src/telemetry/spans.ts:160; packages/core/src/cli.ts:487; scripts/check-surface.mjs:21. Also of note, packages/core/src/journal/audit.ts:32 cites `test/docs-drift.test.ts`, which does not exist under packages/core/test (only packages/eagent/test/docs-drift.test.ts does) — control: `find packages -name '*registries*'` returns two real files.

### `F.8` — PARTIAL

> **Name the set a claim covers.** "This boundary is total" cannot be checked; a claim that names

**Tier.** REPRO

**Command.**

```
sed -n '805,816p' packages/core/src/graph/spec.ts; sed -n '13p' TODO.md; find packages -name '*.test.ts' -not -path '*/node_modules/*' | wc -l; find packages/core/src -name '*.ts' | wc -l
```

**Observed.** spec.ts:807-810 names its members: "**all four** types absent from this set — `function`, `evaluator`, `router`, `join` — reach `awaiting_gate` at posture `in`… An earlier version of this sentence said three of four and did not say which; a verifier ran the fourth." Against that: TODO.md:13 "State at capture: 259 test files, 57 source files in `packages/core`, 106 in `packages/eagent`" vs actual 268 / 58 / 106.

**Finding.** HOLDS where it was written for, VIOLATED at the top of the very file that states it. The exemplar is in-tree and enumerable: spec.ts:807-810 names all four members and even records the history of a three-of-four claim that named none. NodeType itself has 8 members (spec.ts:76-84), and the CAN_SUSPEND/CONTROL_TYPES split is 4+3+1 with `evaluator` in neither, which is what the docstring's warning is about. The live violation is TODO.md:13 — three counts, two of them wrong at HEAD, written 3e5e4bb the SAME DAY. F.8's own closing sentence ("A count nobody can enumerate is a count nobody checked") is quoted verbatim at spec.ts:810.

### `F.9` — PARTIAL

> **A self-describing claim has no fixed point.** State the invariant, not the measurement, when

**Tier.** REPRO

**Command.**

```
grep -arn 'CAN_SUSPEND' packages/core/src scripts/ ; grep -arn 'CONTROL_TYPES' packages/core/src scripts/ ; grep -acn 'node.type|NodeType' packages/core/src/run/scheduler.ts
```

**Observed.** CAN_SUSPEND: 6 hits — 5 in graph/spec.ts (681 prose, 791 the claim itself, 816 the declaration, 821/826 prose) + scripts/surface.json:38. CONTROL_TYPES: 3 hits — spec.ts:823 prose, spec.ts:830 declaration, surface.json:44. scheduler.ts NodeType/node.type: 0, rc=1; control `grep -acn export packages/core/src/run/scheduler.ts` → 8 on a 209-line file.

**Finding.** HELD exactly where the lesson was applied. The docstrings at spec.ts:791 and 821-823 state the PROPERTY ("every hit is a declaration, the surface pin, or prose; none is a reader") rather than a number, and I ran both greps they prescribe: the property is true and survived being written into the sentence it describes. Origin: c72a1fd (2026-08-24) — "saying 'five' in CAN_SUSPEND's docstring made it six, and mentioning CONTROL_TYPES there took its two to four." VIOLATED-AGAIN elsewhere, 1 new instance: TODO.md:13's "259 test files, 57 source files" is a measurement of the artifact written into the artifact, was authored at 3e5e4bb on 2026-08-25, and is already wrong at HEAD the same day (268 / 58). Precedent for exactly this: 089a477 (2026-08-24) — "the count this file warns about rotting, rotted inside one session… a window of about twenty minutes."

### `F.10` — DONE

> **`node:vm` is not a sandbox** — it is scoping. Untrusted code needs a process boundary.

**Tier.** REPRO

**Command.**

```
node -e "const vm=require('node:vm');const ctx=vm.createContext({});const e=vm.runInContext('this.constructor.constructor(\"return process\")()',ctx);console.log(e.pid===process.pid, typeof e.env.PATH)"
```

**Observed.** true string — the escaped object is the HOST process (same pid 90829) and its env is readable from inside a freshly created context with an empty sandbox object.

**Finding.** HELD, and the tree carries the property correctly at all five live sites: packages/core/src/resources/realm.ts:18-24 ("## This is NOT a security boundary, and says so… Untrusted code belongs in `sandbox/subprocess.ts`"), resources/functions.ts:11, security/redact.ts:1286, and the two test-side honesty notes at test/resources/functions.test.ts:15,193. packages/eagent/src/extensions/codeact.ts:10 states the enforcement: untrusted code runs via `child_process.spawn`, NOT node:vm. realm.ts:8-13 records that its own predecessor shipped this exact escape via `view.constructor.constructor(...)` and that the fix was rebuilding the ARGUMENTS inside the context. No new instance found.

### `F.11` — DONE

> **Absence is not zero, and an empty allow-list is the permissive case.** "Named nobody" and

**Tier.** REPRO

**Command.**

```
sed -n '2664,2682p' packages/core/src/graph/validate.ts; sed -n '1014,1030p;1976,1982p' packages/core/src/server/http.ts
```

**Observed.** validate.ts:2672-2675: "`policy: { capabilities: [] }` permitted everything the tenant did. Measured — a graph declaring the empty list ran `pay.charge` to completion. ABSENT IS NOT EMPTY." The live predicate at 2679-2681 treats `allow === undefined` as no ceiling and `[]` as naming nothing. http.ts:1027 REFUSES an empty allowedHosts at construction ("which would refuse EVERY request — including /health"), so the `allowed.size === 0` permissive branch at 1981 is reachable only from the explicit `["*"]`.

**Finding.** HELD in both places I could reach it, and each keeps the two cases distinct rather than collapsing them. The `=== undefined ||` shape appears 56 times across 20 core source files; the two that guard an allow-list are the two above and both are correct. Third site carrying the same rule: packages/core/src/security/redact.ts:808 explicitly distinguishes "named nobody" from "could not read who it names". No new instance found.

**Adversarial ruling: WEAK.** The verdict is right but the tier is not: the stated command is two `sed -n` prints, which cannot fail and cannot discriminate — that is CITED, not REPRO, and it is exactly the "file:line offered where a command was claimed" case. What establishes it (I ran it): `node --test packages/core/test/run/graph-capability-ceiling.test.ts` → tests 6, pass 6, carrying both arms — "A GRAPH THAT DECLARES NO CAPABILITIES CANNOT USE ONE" plus the run-time arm at line 114-118 where `capabilities: []` gives `status failed` and `charged.length === 0`, against "ABSENT IS NOT EMPTY — a graph with no list has no ceiling" asserting `errorsOf(undefined)` deepEqual `[]`. With that, DONE holds. The `=== undefined ||` shape at validate.ts:2679 and the empty-list refusal at http.ts:1024-1031 read as claimed, and the `allowed.size === 0` branch at http.ts:1981 is indeed reachable only via `["*"]` because allowedHosts() throws on `[]` first — but note that half is still only read, not run; `node --test packages/core/test/server/http.test.ts` (which has the case at line 3836/3867) would close it.

### `F.12` — STILL-OPEN

> **Approve means "go ahead", not "consider it done"** — on every node type except the gate

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/run/declared-effects.test.ts; sed -n '2998,3010p' packages/core/src/run/engine.ts; git log -1 --format='%s%n%b' ab329be
```

**Observed.** engine.ts:2998-3004: "`nodeApproved` IS CLAIMED, and getting this wrong shipped a feature that reported success while doing nothing… the run reports `succeeded` with that sentence sitting in a channel and the action never taken." Test "AN IRREVERSIBLE DECLARED EFFECT GATES THE NODE" now resolves the gate and re-advances; 6/6 pass.

**Finding.** COUNT REFRESHED: NodeType has 8 members (packages/core/src/graph/spec.ts:76-84 — function, agent, tool, router, join, evaluator, human_gate, subgraph), so "every node type except the gate itself" names 7. VIOLATED-AGAIN, 1 new instance: ab329be (2026-08-25) on the `function` node type — #effectsFor passed `nodeApproved: false`, so a node floored at `in`, suspended, and approved by a human then had its in-body call re-decided and refused. Fixed at engine.ts:3345/4207 and the mirror-gate arm at engine.ts:6046-6072 refuses `edit` outright for the same reason. This is the newest instance in the whole section and it is the same day as HEAD.

### `F.13` — DONE

> **A terminal operation is not final until every producer of the state it ends is stopped.**

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/run/cancellation.test.ts
```

**Observed.** tests 10, pass 10 — incl. "AND THE TASKS GO WITH IT — a cancelled run does not leave a Task reading as still running", the negative control "A TASK THAT ALREADY FINISHED IS NOT RE-ENDED BY A CANCEL", "A RUN THAT FAILS CLOSES ITS OPEN GATES TOO", and "A CANCELLED RUN CANNOT BE RESURRECTED BY ANSWERING ITS LEFTOVER GATE".

**Finding.** HELD with both arms and a negative control. NEWEST INSTANCE: 5b5c496 (2026-08-24, "a cancel stops the tasks too") — #commit returned early on a terminal run so an in-flight Task kept reading `leased` while the run read `cancelled`; #cancelTree now appends task.cancelled for every non-terminal Task in the same append as run.cancelled (tasks, then gates, then the run). Second, one layer out: d0e6ae7 (2026-08-24) — "a promise nobody can cancel can still be stopped being awaited", where a never-settling parseCallback held one buffered POST body per request for the life of the process; raceDeadline unwinds the frames core owns and the commit is honest that it does NOT cancel the channel's promise. No instance newer than 2026-08-24.

### `F.14` — DONE

> **Cross-realm values look identical and are not**; assert on the prototype, and know that

**Tier.** REPRO

**Command.**

```
node -e "const vm=require('node:vm');const a=vm.runInNewContext('[1,2,3]');console.log(a instanceof Array, Array.isArray(a), Object.getPrototypeOf(a)===Array.prototype);const{proxy,revoke}=Proxy.revocable([],{});console.log(Array.isArray(proxy));revoke();try{Array.isArray(proxy)}catch(e){console.log('THREW',e.constructor.name,e.message)}"
```

**Observed.** false true false / true / THREW TypeError "Cannot perform 'IsArray' on a proxy that has been revoked" — all three sub-claims confirmed in one run.

**Finding.** HELD, every clause verified independently. (a) cross-realm array: `instanceof Array` false and `getPrototypeOf !== Array.prototype`, so the prototype IS the discriminator; (b) `Array.isArray` returns true on the same value, i.e. realm-agnostic; (c) on a revoked proxy `Array.isArray` throws TypeError rather than returning false. The consequence is live in the tree at packages/core/src/security/redact.ts:1286 — "A map built inside a `node:vm` context carries THAT [realm's prototypes]" — and the total-accessor discipline in vocab.ts:126-129 exists because "a hostile getter must cost this decision and never the process", which is the same hazard as (c). No new instance found.

### `F.15` — PARTIAL (overturned from WRONG)

> **macOS `grep` silently skips files containing non-ASCII bytes.** Always `grep -a`; empty

**Tier.** REPRO

**Command.**

```
git ls-files -z | xargs -0 /usr/bin/grep -rn 'the' | /usr/bin/grep -c '^Binary file'  # then python3 byte-census on the 5 hits, then: grep -c 'the' packages/core/src/evolution/trajectory.ts  vs  grep -ac 'the' <same>
```

**Observed.** BSD grep 2.6.0-FreeBSD on Darwin 25.6: 5 of 521 tracked files read as binary out of 29309 matching lines, and it prints "Binary file <path> matches" with rc 0 — not silent. Byte census on all five: NUL counts 3/1/1/2/1, and all five are VALID UTF-8. Separately, 477 tracked files contain non-ASCII bytes and grep reads every one of them (control: `LC_ALL=C /usr/bin/grep 'Mutation-test' TODO.md` prints the line). Constructed files confirm the trigger: ASCII → match, valid UTF-8 → match, invalid UTF-8 (0xff 0xfe) → match, NUL → "Binary file … matches".

**Finding.** WRONG on both halves of the stated cause, though the prescription survives. (1) The trigger is a NUL byte, not non-ASCII: the five files are packages/core/src/evolution/trajectory.ts, packages/core/test/builtin/fs-search.test.ts, packages/core/test/run/delivery.test.ts, packages/eagent/src/extensions/cost.ts, packages/eagent/src/kernel/capabilities.ts, every one of them valid UTF-8 and every one of them containing NUL. Not even INVALID UTF-8 triggers it. (2) BSD grep is not silent — it announces the file and exits 0, so "empty output" is not what you get from it. THE HAZARD IS NONETHELESS REAL, from a different tool: this environment's `grep` is a ugrep 7.8.4 wrapper that always passes `-I`, and it genuinely returns NOTHING with rc=1 on those files — `grep -c "the" packages/core/src/evolution/trajectory.ts packages/eagent/src/kernel/capabilities.ts` → rc=1, no output, while `grep -ac` on the identical arguments → 40 and 26. So `grep -a` is still exactly the right rule and CLAUDE.md's instruction should stay; the SENTENCE explaining why should say "files containing NUL bytes" and drop "macOS grep", because on macOS's own grep the skip is announced and on this session's grep the cause is `-I`, not the locale.

**Adversarial ruling: OVERTURNED.** The verifier's core correction is right and I reproduced it — but WRONG is the wrong label (it retires a rule whose operative half I confirmed true HERE), and two of its supporting claims fail. Reproduced with four constructed probes under both LANG=en_US.UTF-8 and LC_ALL=C: /usr/bin/grep (BSD 2.6.0-FreeBSD) matches ASCII, valid-UTF-8 non-ASCII AND invalid-UTF-8 (0xff 0xfe), and on a NUL file prints "Binary file … matches" with rc 0 — so "macOS grep" and "non-ASCII" are both misattributions, as claimed. ERROR 1: "Not even INVALID UTF-8 triggers it" is false for the grep that actually matters. `command -v grep` here resolves to a zsh function (snapshot line 2767) that execs ugrep with `-G --ignore-files --hidden -I`; on my invalid-UTF-8 probe that grep returns rc=1 with NO output while /usr/bin/grep prints the line. So this session's trigger set is NUL ∪ invalid-UTF-8 — a subset of non-ASCII, nearer the entry's wording than the correction allows. ERROR 2: the count is 6, not 5. A byte census of all 521 tracked files finds SIX with NUL; BSD grep flags only five because packages/core/test/server/http.test.ts has its NUL at byte 184187, past its binary-sniff window. Driving it: `while read f; do /usr/bin/grep -aq the "$f" && ! grep -q the "$f" && echo MISS; done < <(git ls-files)` → exactly 6 silent misses, http.test.ts among them (908 real matches, wrapper rc=1, empty). Also note xargs bypasses the shell function, so a pipeline test measures /usr/bin/grep and hides this. NET: the cause sentence is false (fix it to say NUL bytes, and name the tool), the prescription `grep -a` and "empty output is not evidence of absence" are TRUE and reproduced in this very environment. PARTIAL — do not delete the entry.

---

## Section G

### `G.2` — WRONG

> ~~**Clock bound to the journal (D3).**~~ **DONE for `ctx.now`** — a body's clock is the task's

**Tier.** REPRO

**Command.**

```
node --test /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/82928e7e-13b4-47d5-845c-c499ef316e75/scratchpad/clock.test.ts   (self-contained: one `function` node whose body writes String(ctx.now()); live run, then two replayRun calls 1.2 s apart)
```

**Observed.** LIVE 1787649741444 / REPLAY 1 1787649742650 match:false / REPLAY 2 1787649743853 match:false — DELTA replay1-live 1206 ms, replay2-replay1 1203 ms (exactly the sleep between them). Control run with `engine.now: () => 777000` printed `777000` — the replay clock is the REPLAY ENGINE'S wall clock, caller-controlled, not the journal.

**Control.** Same harness with a body that reads no clock (`Object.keys(ctx)`) replays match:true — so match:false above is attributable to ctx.now and not to a broken rig. Second control: `grep -c -a "replayRun" packages/core/test/agent.test.ts` → 0 while `grep -c -a "replay" …` → 7.

**Finding.** The DONE does not hold. The mechanism is half-built: `#bodyClock` (engine.ts:3058-3061) does read `p.tasks[taskId].lease.at`, and projection.ts:720 does fold that from the journaled `task.leased.ts` — but on replay the SHADOW RUN APPENDS ITS OWN `task.leased`, stamped by the live wall clock. Chain: engine.ts:2443 appends `task.leased` with NO explicit `ts` → log.ts:66 passes `now: this.#now()` → store.ts:236 `const ts = input.now ?? now` takes it → the fresh ts becomes lease.at. And engine `#now` is `opts.now ?? Date.now` (engine.ts:775), which replay.ts:448 inherits via `{...opts.engine}`. So the answer to "does the replay clock reach an appended event": NO. replay.ts:439 (`new MemoryStateStore({ now: opts.engine.now ?? (() => original.startedAt) })`) is the intended fix and it is DEAD for event timestamps — RunLog always supplies `input.now`, so the store's own clock is never consulted. The 1653 ms audit finding is real and reproduces at whatever interval separates the replays. Why it survived: the test named "A BODY'S CLOCK IS JOURNALED — the same run replays to the same instant" (agent.test.ts:147) NEVER REPLAYS — the whole file has zero replayRun/`.replay(` calls on that path; it asserts only that two reads agree and equal lease.at. And `replay.test.ts:193 "replaying twice gives byte-identical results"` passes because its graph never reads a clock. Both green, property false. The two RIDERS are TRUE: two reads in one body do return the same instant (`1787649794933|1787649794933`), and `typeof Date` / `typeof Temporal` are both `undefined` in the realm.

### `G.3` — DONE

> **The one-line agent surface (D1).** `agent({model, tools, prompt})` compiling to a one-node

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/agent.test.ts
```

**Observed.** 8/8 pass, including "ONE LINE RUNS — a prompt, an adapter, an answer", "THE GRAPH IS THE AGENT — one node, and its hash is stable across builds", "IT REPLAYS — the same journal, zero model calls", "AN IRREVERSIBLE TOOL GATES, and the caller never said the word", "A RUN CAN BE SCORED".

**Finding.** Verdict it DONE — the bullet is unmarked and should be struck. `packages/core/src/agent.ts` exists, is exported from the public surface (`packages/core/src/index.ts:10  export * from "./agent.ts";`), and its own suite proves each clause of the bullet: one-node graph ("THE GRAPH IS THE AGENT"), journal + replay ("IT REPLAYS"), gates ("AN IRREVERSIBLE TOOL GATES"), budget (the default policy carries one). One caveat that belongs in the rewritten bullet rather than in this verdict: `a.replay()` forwards `engineOptions` (agent.ts:329), so a caller who did not pass `now` inherits the G.2 clock defect on any function body — but `agent()` compiles an AGENT node, which has no body clock, so the one-liner path itself is unaffected.

### `G.1` — PARTIAL (overturned from DONE)

> ~~**Declared effects (D2).**~~ **DONE for `function` nodes.** `FunctionNode.effects` names the

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/run/declared-effects.test.ts  ;  node --test <scratch>/keys.test.ts (a resource-loaded body writing Object.keys(ctx))
```

**Observed.** declared-effects 5/5 pass: "A BODY CALLS ITS DECLARED EFFECTS, in order, each on its own key", "A BODY CANNOT REACH WHAT IT DID NOT DECLARE", "AN IRREVERSIBLE DECLARED EFFECT GATES THE NODE — nobody configured oversight", "DECLARED EFFECTS REPLAY — served from the record", "A BODY WITH EFFECTS PRODUCES UNTRUSTED OUTPUT — no laundering path". Sandboxed body prints `taskId,now,signal ;effects=undefined`.

**Control.** The same sandbox harness prints a nonempty key list, so `effects=undefined` is a real absence and not an unreachable body.

**Finding.** The DONE holds on all five clauses it names, and BOTH "still open" riders check out. `reachableToolNames` does include function effects (spec.ts:850), which is the single route the ceiling/diagnostic/floor all travel. Evaluator bodies: still open, and now refused rather than silently inert — `ALLOWED_FIELDS` (spec.ts:694-703) lists `evaluator: ["kind", "ref", "threshold"]` with no `effects`, and engine.ts:3259-3265 hands an evaluator body only `{taskId, signal, now, seed}`. Sandbox: still open and honestly absent, exactly as written — the vm ctx is `{taskId, now, signal}` (resources/functions.ts:295-298 omits effects deliberately).

**Adversarial ruling: OVERTURNED.** The five test clauses pass (`node --test packages/core/test/run/declared-effects.test.ts` → 5/5), and the CEILING clause reproduces with a control: `<scratch>/ceiling.test.ts` compiles a `function` node with `effects: ["pay.charge"]` — ungranted → REFUSED E_GRAPH_INVALID / GRAPH017_CAPABILITY_NOT_GRANTED; granted `pay:charge` → COMPILED. But the bullet's prose is a TRIPLE — "the capability ceiling, the unknown-tool diagnostic and the oversight floor all apply by the route a tool node's name already travelled" — and one third of it is FALSE. `<scratch>/diag.test.ts` compiles three graphs against a manifest holding only `fs.read` and counts GRAPH013_UNKNOWN_TOOL: a TOOL node naming `no.such.tool` → count 1 (the control that proves the probe discriminates); a FUNCTION node declaring `effects: ["no.such.tool"]` → count 0, zero diagnostics of any code; a function node declaring the known `fs.read` → 0. Cause, on read: `checkToolNames` (graph/validate.ts:1742-1764) reads `n.tool?.name` only and never calls `reachableToolNames`; `grep -rn -a reachableToolNames packages/core/src/` shows its consumers are capability checks (validate.ts:2685, 2703; compile.ts:124), the error-path rules, mutate.ts and the engine — no unknown-tool check among them. The source comment at spec.ts:850 asserting the diagnostic is one of the three consumers is itself false, and the TODO bullet inherits it. The prior verdict's evidence for that third was a CITED read of that comment, not a run. Second defect, in the sandbox rider: `ctx.effects` is NOT "honestly absent" there. `<scratch>/sandboxfx.test.ts` runs a resource-loaded body twice — with no `effects` declared: `typeof=undefined` (which is all the prior probe tested, so it could not discriminate); with `effects: ["echo"]` declared: `typeof=object keys=echo`, and calling it throws `E_EFFECT_UNAVAILABLE: this node declares the effect echo, but a SANDBOXED body cannot invoke one...` — resources/functions.ts:242-256 builds a throwing stub per declared name and assigns `ctx.effects`. The SUBSTANCE of the rider (a sandboxed body cannot invoke an effect; it needs an async bridge) is true and the refusal is loud; the description "absent" is wrong. The evaluator rider is correct as written: ALLOWED_FIELDS (spec.ts:694-703) gives `evaluator: ["kind","ref","threshold"]`, and engine.ts:3259-3265 hands an evaluator body only `{taskId, signal, now, seed}`. So: ceiling + floor + ctx.effects mechanics DONE; unknown-tool diagnostic NOT DONE and never was; sandbox rider misdescribed.

### `G.4` — PARTIAL

> **Divergence must be terminal and loud.** The known failure mode of every replay-based runtime

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/run/replay.test.ts
```

**Observed.** 38/38 pass, including "a missing effect is E_REPLAY_DIVERGENCE, never a silent live call" which asserts `p.status === "failed"` (replay.test.ts:170).

**Finding.** TERMINAL AND LOUD: already true for the recorded-effect path, so that half of the bullet is stale as a work item. `E_REPLAY_DIVERGENCE` is in `RUN_FATAL_CODES` (engine.ts:265-267) and engine.ts:4688 (`if (RUN_FATAL_CODES.has(error.code)) return undefined;`) refuses to schedule a retry for it — so the described silent-stall ("retries forever without entering a failed state") cannot happen for that class; the run enters `failed`. STILL OPEN: the specific ask, "a repeated divergence signature ... needs its own terminal state". `RunStatus` has exactly seven members and none is divergence-specific — queued, running, awaiting_gate, interrupted, succeeded, failed, cancelled (projection.ts:48-55). Divergence lands in the same `failed` bucket as a tool crash. Note also a second, quieter divergence class the bullet does not cover, surfaced by G.2: a replay that produces different VALUES exits `succeeded` with `report.match:false` — loud only if the caller reads the report.

### `G.5` — PARTIAL

> **Two-axis labels (D4).** Integrity × confidentiality, most-restrictive, **unlabelled ⇒

**Tier.** REPRO

**Command.**

```
node --test packages/core/test/run/secret-flow.test.ts packages/core/test/run/wave-taint.test.ts  ;  node --test packages/core/test/graph/compile.test.ts
```

**Observed.** secret-flow + wave-taint 8/8 pass, including "A LAUNDERED SECRET STILL GATES, even under a human ceiling", "THE FLOW SET SURVIVES A RESTART — it is rebuilt from the journal", and "ONLY EXTERNAL MEMBERS OF A WAVE TAINT — a function's output is not untrusted". compile.test.ts 63/63 pass, including "GRAPH010: a fanned-out node is concurrent WITH ITSELF" and "GRAPH010: two unrelated nodes writing one non-safe channel".

**Finding.** Four sub-claims, three verdicts. (a) "Integrity × confidentiality" — BOTH AXES NOW EXIST: `tainted`/`applyTaint` for integrity and `carriesSecret`/`applySecretFlow` for confidentiality (engine.ts:5676-5706, "THE CONFIDENTIALITY FLOW RULE, and the only place it is written"), each propagating through observed channels and each rebuilt from the journal. The bullet reads as if neither existed. (b) "unlabelled ⇒ untrusted" — STILL ABSENT, and it is correctly identified as the missing valuable half: confidentiality keys off DECLARED `secret_ref`/`pii` plus propagation, and integrity taints only `isExternal` writers, so an unlabelled channel is trusted by default; proven by the passing test "ONLY EXTERNAL MEMBERS OF A WAVE TAINT — a function's output is not untrusted". (c) the illustrative clause "a tool that is not `isExternal`" NAMES AN EMPTY SET — `isExternal` returns true for `node.type === "tool"` unconditionally (engine.ts:5646-5659), so no tool node is ever not-external; the fact it means is about a non-external node (engine.ts:5737). (d) `GRAPH010_CONCURRENT_WRITE` exists and fires (validate.ts:1623, 1652), so that clause stands.

### `G.6` — PARTIAL

> **Prompt text into the artifact hash (D7).** A prompt edit currently changes what a resumed run

**Tier.** REPRO

**Command.**

```
node --test /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/82928e7e-13b4-47d5-845c-c499ef316e75/scratchpad/prompt.test.ts  (compiles one agent-node spec against two ResourceStores whose prompt/p@stable differ, then attaches the second graph to the first run and advances)
```

**Observed.** graphHash A == graphHash B == sha256:8efaf4e9…f67d640 (`same hash? true`) while the manifests differ on prompt/p@stable (…458f0108 vs …bea79c0f). RESUME WITH EDITED PROMPT -> E_GRAPH_MISMATCH :: "the graph supplied for advancing run … matches run …'s spec, but the resources behind its refs have changed since it was compiled".

**Finding.** FIRST HALF TRUE, SECOND HALF FALSE. Prompt text is genuinely not in the artifact hash — `graphHash: digest(spec)` (compile.ts:158) digests the spec, and a ref'd prompt's text lives only in `resolutionManifest`, so editing it leaves the hash byte-identical. But "changes what a resumed run does, SILENTLY" is wrong at HEAD: `advance` calls `#assertBound` (engine.ts:1220), which compares the journaled `run.compiled.resolutionManifest` against the attached graph's and throws `E_GRAPH_MISMATCH` naming `differs: "resources"` (engine.ts:2195-2219). The run refuses to resume rather than resuming with new instructions. What remains open is D7's actual ask — prompt text in the hash and in the per-effect fingerprint — plus the honest gap the code itself flags at engine.ts:2192-2194: a MUTATED graph's successor carries no recorded manifest, so the resources check cannot run on that path.

### `G.7` — STILL-OPEN

> **Payload externalisation.** Above a byte threshold a payload moves out of the journal and

**Tier.** REPRO

**Command.**

```
node --test /private/tmp/claude-501/-Users-deepsky-Documents-projects-EAgent/82928e7e-13b4-47d5-845c-c499ef316e75/scratchpad/payload.test.ts  (appends a 9 MiB payload, then a 1 KiB one, to a MemoryStateStore)
```

**Observed.** REFUSED: E_PAYLOAD_TOO_LARGE :: 'a "run.submitted" payload is 9.0 MiB, over the 8 MiB per-event bound…' — no reference emitted, nothing externalised.

**Control.** CONTROL small payload: appended fine — so the refusal is the size rule, not a broken append call.

**Finding.** Reproduced exactly as written. `MAX_PAYLOAD_BYTES = 8 * 1024 * 1024` (journal/store.ts:179) and `boundedPayload` THROWS above it (store.ts:214-221); the code's own comment at store.ts:176 names the missing work in the item's words — "which needs payload externalisation — a reference above a threshold, resolved on read". `grep -rn -ai "externali[sz]" packages/core/src` hits only that comment: no implementation anywhere.

### `G.8` — STILL-OPEN

> **Proposed-API mechanism and a version pin (D5).**

**Tier.** REPRO

**Command.**

```
grep -rn -ai "runtimeVersion|proposed api|proposedApi" packages/core/src packages/eagent --include="*.ts"
```

**Observed.** zero matches for all three patterns.

**Control.** `grep -rn -ai "proposed" packages/core/src --include="*.ts"` returns 10+ hits (graph/mutate.ts:31 `proposedBy`, journal/events.ts:609, validate.ts:495 …) and `grep -rc -a "apiVersion" packages/core/src/graph/spec.ts` → 2, so the files are being read and the patterns are not typo'd — the absence is real.

**Finding.** Both halves of D5 are unbuilt. There is no proposed-API declaration file, no opt-in, and no publish-time refusal for an extension that uses one; and there is no runtime version pin in any form — D5 specifies the pin as a journal EVENT, and no such event type exists in `journal/events.ts`. The word `proposed` in the tree refers to model-proposed graph MUTATIONS (`GraphMutation.proposedBy`), an unrelated mechanism — worth knowing before someone greps for it and thinks the item is done.

### `G.9` — STILL-OPEN

> **One retry budget per run**, decremented across every layer. Engine retry × provider retry ×

**Tier.** REPRO

**Command.**

```
grep -rn -a "maxAttempts" packages/core/src --include="*.ts"  ;  grep -n -a -A12 "export interface Budget" packages/core/src/graph/spec.ts
```

**Observed.** `Budget` is `{ costUsd?, tokens?, wallMs? }` (spec.ts:39-43) — no retry field. Two independent, non-communicating attempt counters: `RetryPolicy.maxAttempts` per node (spec.ts:65-66, enforced at engine.ts:4686 `if (attempt >= policy.maxAttempts) return undefined;`) and `HttpOptions.maxAttempts` per provider request (providers/http.ts:30, loop at http.ts:562-583).

**Control.** The same grep returns nonzero in both files, and `packages/core/src/workflows/incident-triage.ts:123` shows a live `retry: { maxAttempts: 2 }` declaration — the knobs are real and in use, not dead types.

**Finding.** The work item stands: no run-scoped retry budget exists, so nothing decrements across layers. On the RATIONALE, which is a three-member aggregate — I confirmed two of the three named layers (engine node retry, provider retry) and they do multiply: 2 node attempts × 3 default provider attempts = 6 provider calls for one node. The third, "agent-loop retry", I could NOT find as a distinct counter: the agent loop is bounded by `AgentNode.maxTurns`, which is a loop bound, not a retry, and a body-requested `{ retry: { reason } }` (engine.ts:453-465) routes back through the SAME `#retryDecision`/`policy.maxAttempts` counter rather than adding a layer. So the multiplication is 2 layers deep at HEAD, not 3 — fix the rationale when the item is rewritten.

### `G.ids` — PARTIAL (overturned from DONE)

> Each traces to a decision in `DESIGN.md`.

**Tier.** REPRO

**Command.**

```
sed -n '260,300p' TODO.md | grep -o -a "D[0-9]" | sort | uniq -c  ;  grep -n -a "^### D" DESIGN.md
```

**Observed.** Section G cites D1×1, D2×1, D3×1, D4×2, D5×1, D7×1. DESIGN.md carries ### D1..D7 at lines 53, 66, 93, 106, 140, 152, 162.

**Control.** The same grep over the section returns 9 for `^- ` (the bullet count), confirming the range and the pattern both bite.

**Finding.** Every id cited in G resolves, and every subject matches: D1 "The default surface is one line" ↔ the one-line agent surface; D2 "Effects are DECLARED, not called" ↔ declared effects; D3 "The clock is bound to the journal, not recorded" ↔ the clock bullet; D4 "Information flow — two axes, and NOT scoped to branch coordinates" ↔ two-axis labels (and D4's own title carries the branch-coordinate revert the bullet describes); D5 "The extension surface is versioned mechanically" ↔ proposed-API + version pin; D7 "A prompt-only change is NOT a safe change" ↔ prompt text into the artifact hash. D6 is the only decision G does not cite, correctly — it is the self-improvement gate, which lives in section F. No dangling id. The section is 9 bullets as stated.

**Adversarial ruling: OVERTURNED.** The verifier's numbers reproduce exactly, on a corrected extraction: `awk '/^## G · /{f=1} /^## H · /{f=0} f' TODO.md` gives a 41-line section with `grep -c -a '^- '` = 9 bullets, and `grep -o -a -E '\bD[0-9]+\b' | sort | uniq -c` = D1x1 D2x1 D3x1 D4x2 D5x1 D7x1 (identical case-insensitively; the word-bounded pattern also rules out a D10 being miscounted as D1). `grep -n -a -E '^#+ D[0-9]+' DESIGN.md` → D1:53 D2:66 D3:93 D4:106 D5:140 D6:152 D7:162, with `grep -c -a -E '^#+ D[89]' DESIGN.md` = 0 as the control. Every cited id resolves and every subject matches. But that is only the FORWARD direction, and the item's claim is the REVERSE one: "EACH traces to a decision in DESIGN.md" — each of the 9 bullets. Three bullets cite no id. Two of the three still trace: "Divergence must be terminal and loud" ↔ DESIGN.md:205 "Divergence is terminal and loud", and "Payload externalisation" ↔ DESIGN.md:180 "bound the journal with payload externalisation above a byte threshold". The ninth, "One retry budget per run, decremented across every layer", traces to NOTHING: `grep -n -a -i budget DESIGN.md` returns exactly two lines (59, about the one-line surface inheriting budgets; 158, an edit budget in the self-improvement loop), and `grep -n -a -i retry DESIGN.md` returns three (74 unretryable ctx.step, 87 a retryable invoker, 205 divergence not retrying forever) — none is a decision about retry budgets multiplying across engine x provider x agent-loop. So 8 of 9 trace, 1 does not. Under the narrow reading the verifier took (every cited id resolves) the DONE is right and I reproduced it; under the sentence as written it is PARTIAL. Also note the offered command's range was a fencepost short — section G runs 41 lines from line 261, so `sed -n '260,300p'` drops the last line; that line carries no D id, so the counts were unaffected, but the range was not the section.

---

## Section H

### `H.1` — PARTIAL

> `packages/eagent/tui` — **deleted** as part of this sweep. Its removal breaks two tests that assert the directory exists

**Tier.** REPRO

**Command.**

```
git ls-tree -d HEAD packages/eagent/ (no tui; control: packages/eagent/src listed) && ls -d packages/eagent/tui -> No such file or directory && git show --stat 3e5e4bb && node --test packages/eagent/test/zero-dep.test.ts && node --test packages/eagent/test/docs-display-surface.test.ts && npm --prefix packages/eagent/tui install --dry-run && grep -an 'tui' packages/eagent/README.md packages/eagent/ARCHITECTURE.md packages/eagent/CLAUDE.md (control: grep -ac 'eagent' README.md = 22) && grep -an 'tui/' packages/eagent/src/*.ts (control: grep -ac 'src/' args.ts = 3) && git grep -an 'existsSync' 3e5e4bb^ -- 'packages/eagent/test/'
```

**Observed.** DELETE HELD: packages/eagent/tui absent at HEAD (removed in 3e5e4bb, 45 files, -6544 lines, 2026-08-25), docs/TUI.md and scripts/release-tui.mjs gone (packages/eagent/scripts/ now holds only build-binary.mjs), and both touched guards pass and are now INVERTED: zero-dep 8/8 pass incl. 'AC2: no eagent-tui bin, build:tui/test:tui scripts, tsx globs, or tui dirs' and 'AC5: THERE IS NO TERMINAL CLIENT'; docs-display-surface 5/5 pass. TRANSACTION INCOMPLETE: (a) packages/eagent/README.md:84-85 Quickstart still says `npm --prefix tui install` / `npm --prefix tui run dev    # the interactive WEB` — running it errors ENOENT on packages/eagent/tui/package.json; the guard that claims to cover it (docs-display-surface.test.ts:46-53) only asserts doesNotMatch(/src\/tui\//), so `tui/` sails through. (b) README.md:419-421 leaves a dangling 'It depends on the engine rather than the reverse' after the sentence saying the client was deleted. (c) CHANGELOG.md:25-31, in the **[Unreleased]** section (present tense, not shipped history), still states 'the installable product is **`eagent`** from `tui/`' and '`scripts/release-tui.mjs` rewrites the development `file:..` dependency' — both false at HEAD. (d) four src docstrings still describe the deleted package as live: args.ts:5, args.ts:39, cli.ts:8, print.ts:8 (plus host-commands.ts:7 'TUI both call registerHostCommands'). ARCHITECTURE.md and packages/eagent/CLAUDE.md are clean (0 hits).

**Finding.** COUNT WRONG: 'two tests that assert the directory exists' is ONE. At 3e5e4bb^ the only existence assertion on the directory is zero-dep.test.ts:140 `assert.ok(existsSync(tuiPkgPath), "tui/package.json exists")` inside test 'AC5: tui/ is the ONLY place ink and react may appear'. The second thing that broke is docs-display-surface.test.ts:55-58 'AC16: docs/TUI.md describes the headless CLI and the Ink TUI package', which reads docs/TUI.md — and the item then lists that same test AGAIN as 'a display-surface test', double-counting it. Remaining work is a docs/comment sweep for `tui/` (README:84-85 + 419-421, CHANGELOG [Unreleased]:25-31, args.ts:5/39, cli.ts:8, print.ts:8, host-commands.ts:7) and widening the README guard's regex from /src\/tui\// to /(^|[^/])tui\//.

### `H.2` — PARTIAL (overturned from DONE)

> The web frontend was already designed once and closed, and the terminal client already dropped once, in July 2026.

**Tier.** REPRO

**Command.**

```
git log --all --since=2026-06-25 --until=2026-08-02 --format='%h %ad %s' --date=short | grep -ai 'web\|tui\|terminal\|frontend\|spa'
```

**Observed.** Both halves confirmed, both 2026-07-27: web frontend — 925bd55 'feat(phase3-4): web SPA chat + monitor served by eagent-serve' then 7e42d0e 'docs(closeout): mark web-frontend design closed after SPA land'; terminal client — f3f3197 'feat(phase2): drop Ink eagent-tui; restore zero-dep engine pin' and 6d67f90 'docs(closeout): close Cycle A drop-ink-tui design/impl', with 2d03dfd 'feat(phase3): reconcile docs after dropping Ink TUI'. Then ef5354f (2026-07-29) 'feat(phase0): excise the web SPA and the terminal render layer'.

**Finding.** Accurate, and now sharper than written: the terminal client was dropped 2026-07-27, REBUILT two days later as e9b8701 'feat(phase2): the tui/ package -- Ink + React over the zero-dep engine' (2026-07-29), and dropped a second time in 3e5e4bb (2026-08-25). That is the drop-rebuild-drop cycle the note exists to warn about; worth saying 'dropped twice' rather than 'once'. Informational only — no work item here.

**Adversarial ruling: OVERTURNED.** The evidence reproduces but does not support DONE — it contradicts half the item. Command (re-run verbatim, plus a widened control): `git log --all --format='%h %ad %s' --date=short | grep -aiE '\bweb\b|spa|frontend|browser|tui|terminal'` and `for c in f3f3197 ef5354f e9b8701 3e5e4bb; do git show --stat --format='%h %ad %s' --date=iso $c; done`. WEB HALF HOLDS: one design cycle, landed 925bd55 and closed 7e42d0e, both 2026-07-27; no second closeout exists. TERMINAL HALF IS FALSE ON THE COUNT: 'dropped once, in July 2026' does not survive the log. July 2026 contains TWO removal commits — f3f3197 (2026-07-27 10:05, deletes src/tui/* and test/tui/*, -2399 lines) and ef5354f (2026-07-29 12:03, 'excise the web SPA and the terminal render layer', also strips test/tty.test.ts) — and then a REBUILD 87 minutes later, e9b8701 (2026-07-29 13:30, tui/ package, +2658 lines), before the third drop 3e5e4bb (2026-08-25, deletes packages/eagent/tui). So even confining to July the count is two, and the July drop was undone inside July. The verifier's own note states the drop-rebuild-drop cycle and recommends 'dropped twice', then returned DONE anyway — the note and the verdict disagree, and the note is the one backed by the log. The item's operative purpose (no leftovers should be mistaken for live work) does check out: `git ls-tree -r --name-only HEAD | grep -acE '^(web/|packages/[^/]+/web/)'` = 0 and `git ls-tree -r --name-only HEAD | grep -ac 'packages/eagent/tui'` = 0. Correct verdict is PARTIAL: purpose and web half hold, terminal-client count is wrong; fix the line to 'dropped, rebuilt two days later, and dropped again' rather than retiring it as DONE.

### `H.3` — STILL-OPEN

> `bin/loom` is gitignored and goes stale on any source edit; nothing rebuilds it automatically.

**Tier.** REPRO

**Command.**

```
git check-ignore -v bin/loom; stat -f '%Sm %N' -t '%Y-%m-%d %H:%M:%S' bin/loom; find packages/core/src -type f -newer bin/loom | wc -l; find packages -type d \( -name node_modules -o -name dist \) -prune -o -type f -newer bin/loom -print; ls -la .git/hooks/ | grep -av '\.sample'; grep -an -B4 'build:binary' .github/workflows/ci.yml
```

**Observed.** Gitignored: `git check-ignore -v bin/loom` -> `.gitignore:5:bin/  bin/loom`, and `git ls-files bin/` is empty. STALE RIGHT NOW: bin/loom mtime 2026-08-25 13:52:23; packages/core/src/telemetry/spans.ts is 2026-08-25 13:54:12 — 109 seconds newer, and it is exactly 1 file under packages/core/src newer than the binary (3 files tree-wide: spans.ts plus test/telemetry/span-order.test.ts and spans.test.ts). Nothing rebuilds it: .git/hooks/ contains no non-.sample hook; the only producer is `build:binary` -> scripts/build-binary.mjs (package.json:20), and .github/workflows/ci.yml:25-29 explicitly says "`build:binary`'s esbuild metafile backstop is NOT run here — it needs the SEA toolchain and ~115 MB of output", running only typecheck, test, and check-zero-dep.mjs.

**Control.** Control for the absence half: `find packages/core/src -type f -newer bin/loom | wc -l` returns 1 (nonzero), so the mtime comparison discriminates; `git grep -an 'bin/loom'` returns 35 hits, so the pattern is not typo'd.

**Finding.** Standing condition, correctly stated, and it bit during this audit — the checked-out binary is already 109s behind src at HEAD. packages/core/test/readme-gaps.test.ts:331-333 already encodes the consequence ("`bin/loom` is gitignored and may be absent or stale, which is why this checks what goes INTO it rather than the file"). Keep the item; the only fix that closes it is a staleness check in `npm run check` or a mtime guard, not a note.

### `H.4` — DONE

> Commits land under the human author's identity only. No assistant attribution, no co-author trailers

**Tier.** REPRO

**Command.**

```
diff <(sed -n '75,77p' CLAUDE.md) <(sed -n '310,311p' TODO.md); git log --all --format='%an <%ae>' | sort | uniq -c | sort -rn; git log --all --format='%H%n%B' | grep -ain 'co-authored-by\|Generated with\|noreply@anthropic\|claude.ai/code'
```

**Observed.** DUPLICATE CONFIRMED: CLAUDE.md:76-77 carries the same sentence verbatim; the diff's only content delta is TODO's trailing clause "in commit bodies or pull requests" vs CLAUDE.md's bare "no assistant links." RULE HOLDS: across all 969 commits on all refs the authors are 906 caohaotiantian <caohaotiantian@gmail.com>, 45 caohaotiantian <caohaotiantian@qq.com>, 18 EAgent <caohaotiantian@gmail.com> — all the human, no assistant identity. Zero matches for co-authored-by / 'Generated with' / noreply@anthropic / claude.ai/code.

**Control.** `git log --all --format='%B' | grep -aci 'the'` returns 6646, so the trailer search reads real commit bodies; the -i flag covers 'Co-Authored-By' capitalisation.

**Finding.** NOT A BACKLOG ITEM — it is a standing project rule already stated at CLAUDE.md:76-77, so TODO.md:310-311 is a duplicate of a contract file and will drift from it (it already has: TODO carries an extra 'in commit bodies or pull requests' clause CLAUDE.md lacks). Delete lines 310-311 from TODO.md and, if the extra clause is worth keeping, fold it into CLAUDE.md:77. CLAUDE.md itself says work items live in TODO.md and principles live in CLAUDE.md; this line is on the wrong side of that split.
