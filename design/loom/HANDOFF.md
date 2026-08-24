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

Measured **2026-08-24**, tree clean, `npm run check` green end to end.

| | Measured | Command |
|---|---|---|
| Tests | **3556 total, 3555 pass, 0 fail, 1 skipped** (Loom 2013 + EAgent 1543, of which 1 skipped) | `npm run check` (its test arm) |
| Test files | 258 (127 Loom, 131 EAgent) | `node -e "console.log(require('node:fs').globSync('packages/*/test/**/*.test.ts').length)"` |
| Source files | 57 in `packages/core`, 106 in `packages/eagent` | `node scripts/check-zero-dep.mjs` (it prints core's count — it is scoped to core on purpose) |
| Runtime dependencies | **0 in `packages/core`**, which is the one that matters. `packages/eagent` carries `jiti` and is allowed to (invariant 1 is scoped to core) | same command — it fails on a bare import specifier that is not `node:`, on any non-`devDependencies` dependency field, on a `createRequire`/`require`/computed-`import()` load, and on a file under `src/` it cannot parse |
| Public exports, pinned | 515 | `node -e "console.log(require('./scripts/surface.json').length)"` |
| Escalation rules | 10, and **all 10 are raised** | `node --test packages/core/test/docs-drift.test.ts` — `RULES_NEVER_RAISED` is empty |
| Built-in tools | 6 default + 2 opt-in | `fs.read fs.write fs.edit fs.glob fs.grep fs.restore`, plus `net.fetch` (needs `--egress`) and `proc.exec` (needs `--allow-exec`) |
| Commits ahead of `origin/loom` | **some — always re-derive**, and there is always at least one, because committing this row changes it | `git log --oneline origin/loom..HEAD \| wc -l` |
| Typecheck | clean, both packages | `npx tsc -p packages/core/tsconfig.test.json && npx tsc -p packages/eagent/tsconfig.test.json` |

**AND THE MCP TOOL PATH**, which is the tool-extensibility story and had never been driven: a
minimal stdio server, `--mcp-file`, `mcp__demo__shout` named from a graph, compiled, gated
(every MCP tool is irreversible), approved, executed — `HELLO FROM A GRAPH`. What it cost to get
there is the finding: see the journal.

**AND SO WAS THE HTTP OVERSIGHT PATH**, through `loom serve --identity-file --token`: submit a
run over `POST /runs`, read the gate off `GET /gates` with its approvers and payload, and answer
it at `POST /runs/:id/gates/:id`. The operator's shared token is refused by name — "names
approvers, and this credential identifies no person" — and `u:alice`'s succeeds. Unauthenticated
and wrong-token calls are 401; `/health` is deliberately open. `loom audit` on the finished run:
14 rules checked, 5 skipped, each skip named.

**THE QUICKSTART WAS RUN END TO END THROUGH `bin/loom` on 2026-08-23**, verbatim as the README
prints it: compile → run → replay (`match: true, hermetic: true`) → trace (`conformance: ok`) →
serve (banner names every degradation, `/health` answers) → the gated half, where the hint the
binary prints was pasted back in as a second process and `shipped.txt` appeared. It works.
**Three rows of the README's own gaps table were stale in the safe-looking direction** — hooks,
`loom compile` against a missing resource, and replay of a de-escalated run were each described
as broken after being fixed. `readme-gaps.test.ts` probes each checkable row now, in both
directions: a row saying BUILT fails if it breaks, a row saying GAP fails if the gap closes.

**An eighth sweep — assertions that pass by construction — was mostly clean.** Zero tautological
equalities, zero tests with no assertion (1882 scanned), one commented `assert.ok(true)` marker.
What it did find: three "every member of X" claims iterating a table exported from `src/` with no
floor under it, so each would pass if the table emptied. `registries-are-populated.test.ts` floors
the nine such tables once, rather than a floor per test and per future test.

**A seventh sweep turned the method on the SUITE.** 11 of 347 `assert.throws`/`rejects` calls
had no second argument, so each accepted any error — including one from the code being broken
rather than refusing. All 11 guarded; `predicate-on-throws.test.ts` keeps the count at zero.
**"It threw" is not "it refused."**

**A sixth sweep — flag VALUES — found the same class one level in.** `--egress`, `--allow-exec`
and `--exec-env` read their value as `String(flags[name]).split(",")`, so a bare flag became the
allowlist `["true"]` *while still registering the tool*: `loom compile --allow-exec` granted
`proc:exec`. `listFlag` refuses the two empty spellings and a stray comma; the other six
value-flags already refused them.

**A fifth sweep — the CLI flag surface — found the sharpest one yet.** `parseArgs` accepted any
`--word` and nothing checked the set, so `loom serve --tokne s3cret` started a control plane that
authenticated nobody, with the secret in `ps` and no complaint. `KNOWN_FLAGS` + `assertKnownFlags`
refuse an unknown flag at the door and name the nearest real one; `test/cli/known-flags.test.ts`
gates KNOWN_FLAGS, USAGE and the code's readers as ONE set, so a flag cannot be added to any one
of the three alone.

**A fourth sweep — `EdgeSpec` and the tool manifest — found one defect and one known item.**
`EdgeSpec.codes` and `RetryPolicy.onlyIf` are lists of error codes read at run time and validated
nowhere, so a typo was a SILENCE: an error edge that never fires, or a retry policy that disables
retry. `GRAPH003_UNKNOWN_ERROR_CODE` refuses them now. `compensates` has five references, all in
`validate.ts` — that is B9 in §3 below, already recorded as needing a product decision, not a new
find.

**Three sweeps came back clean on 2026-08-23, and the commands are here so the next session
re-runs them rather than trusting this paragraph.** Every field of `GraphPolicy`/`NodePolicy`/
`NodeSpec` has a consumer outside its own declaration (`grep -arn '\.<field>\b' packages/core/src/`
— `unhandled` legitimately has one, a compile-only suppression; `concurrencyKey` has none and is
not declared in `src/` at all, only in the design under `DESIGNED-NOT-BUILT`). Every
`DESIGNED-NOT-BUILT`/`NOT-IN-CODE` marker is already gated by `docs-drift.test.ts`. And every
one of the 19 audit rules has a fixture that trips it — which is now a gate rather than a
measurement (`audit.test.ts`, last test).

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
| point it at a real provider | ✅ `--models-file`; Anthropic + OpenAI over `fetch`+SSE. A run served by the mock now says so. **Driven end to end through `bin/loom` against a local server speaking each vendor's wire format** — both the keyed Anthropic path and the documented keyless local `openai` one; the streamed text arrives as the run's output and the token counts are the ones the server sent |
| have it run | ✅ all eight node types execute; a run that finishes reports what it wrote |
| a human gate that works | ✅ raise → deliver → decide → resume, across a restart; an approval binds the graph the human was shown. **The FAILURE paths are driven too**, through `bin/loom` against a live plane: a rejection fails the run with its reason and the guarded write never happens; an SLA expires into `E_GATE_EXPIRED` under the `serve` clock; `onTimeout: "escalate"` with no chain is refused at compile; and with a chain it journals `gate.escalated` and delivers to the next tier |
| a replay that reproduces | ✅ including runs a human de-escalated — `replayRun` serves recorded `policy.deescalated` events like it serves gate decisions, rekeyed onto the shadow runId |
| `loom compile` diagnoses a missing resource | ✅ the workspace resolver no longer fabricates a pin for every well-formed ref |

**The bar is met.** Every row was verified by running, and the last four by running `bin/loom`
rather than `node` — the binary is the deployment, and a claim about `src/` is not a claim
about it.

**Read the last row of that table as a warning about the others.** Closing T4 took an afternoon;
the hour that mattered was discovering that `replayRun`'s own verdict never compared GATES, so a
replay which asked a human a different number of times — or nobody at all — scored `match: true`.
Two of the mutations written to verify the T4 fix were silently green against it. **Each ✅ above
is a statement about the checks that exist, and the checks are the thing to distrust first.**

---

## What is left

The sections below group by KIND — defect, unwired, deferred, blocked, small. **The table
immediately below orders the same items by what to do first**, which is a different question and
the one a fresh session actually has. Read the order here, then the detail in §1–§6.

### The order, and why it is this order

Ordering rule: **no decision needed before value**, then **dependency before dependent**, then
cost. An item that needs a human answer cannot be scheduled, so it is not competing with the
rest — it is waiting, and §C below says who is waiting on what.

| # | Do | Why here | Detail |
|---|---|---|---|
| ✅ | ~~The two `http.ts` auth refusals with no test~~ | done — `test(server): the two auth refusals that fail open…`. Both mutation-verified | REGISTER E8 |
| ✅ | ~~Six stale absence claims in the corpus~~ | done — `docs(loom): six sentences claimed an absence…` | REGISTER B5/B6/B9/C1; `02` D5.1; `07` D12.7; `08` A8; `05` D8.7 |
| ✅ | ~~The hung `parseCallback` on the unauthenticated route~~ | done — `fix(delivery): a promise nobody can cancel can still be stopped being awaited`. A5's last consequence; three mutations, one of which deleted a guard instead of testing it | REGISTER A5 |
| ✅ | ~~Let a `function`/`evaluator` body signal a RETRYABLE failure~~ | done — `fix(run): a body can ask to be retried, through the return`. Five mutations; the evaluator arm finally kills two of them | REGISTER B10 |
| ✅ | ~~Close the `Math.random` hole in the `vm` realm~~ | done — `fix(run): Math.random in a body is a journaled effect now`. Decided in favour of journaling rather than stripping. Five mutations; one deleted a redundant guard, one found the evaluator arm untested for the second wave running | REGISTER D11 |
| ⏸ | **The `pins` seam, all three content kinds** | **Deferred on evidence, not skipped.** The exposure is now measured and guarded rather than assumed: a ref cannot MOVE while a process runs — zero `.publish(`/`.promote(` in `src/`, one `readResources` (the boot seed), no resource-addressing HTTP route. `store-is-sealed-after-boot.test.ts` pins all three. Build it when a publish route arrives; that test goes red first | REGISTER A24 |
| ✅ | ~~`Engine.rewind`'s two scan defects~~ | **Neither was a defect any more.** A10's boundary refusal already covers three event types, and the code cites the entry at two of them; E5's stated obstacle was gone (`suppressedRanges` is exported and pinned) and its corner is unreachable — proved as a property, mutation-verified. Both entries corrected; A10's *prescription* stays open | REGISTER A10, E5 |
| **1** | **An open-gate read model** | The one architectural unlock in the backlog: three recorded items are consequences of one absence. Storage layout, so Deep | §6, REGISTER B7 + A3's stated reversal + `GET /gates`' cap |
| **2** | **`task.cancelled` and the leased-after-cancel Task** | E6 is untidy state; its fix is the appender C1 names. One change, not two | REGISTER E6, C1 |
| **3** | Partial reads swept but not finished — A21, A18, A13/A15, A14's unconfirmed half | Each is residue of a sweep that stopped at its first finding. Real, none urgent | REGISTER A21, A18, A13, A15, A14 |
| **4** | Unbounded and unobservable structures | `ResourceStore.#versions`/`#byDigest`/`#selectors` grow without bound; neither new cap emits a counter, so `MAX_CACHED_CHILD_GRAPHS`' own reversal condition is unmeasurable | REGISTER A8 |
| **5** | Declared-and-unread fields, in one pass | `NodePlan.inboundEdges`, `GraphMetadata.labels`, `ExpansionBudget.maxLoopIterations`, `DelegationSpec.mustStayInGroup`/`maxDepth`, `ToolNode.version`, `AssembleInput.turns`, `SectionName "tool_results"`. `GRAPH019` is the pattern to follow — warn at compile rather than delete | §6 |
| **6** | Docstrings claiming a consumer they do not have | `OBSERVER_POINTS` ("asked at every call site" — nothing reads it), `CAN_SUSPEND`, `CONTROL_TYPES`, `createGraphCompiler`. And in `packages/eagent`, `args.ts`'s exported `FLAGS`, which `parseArgs` shadows with string literals — **that one is a live drift hazard, not dead weight** | §6 |
| **7** | The rare suite flake, and E3's two transient failures | Two observations, 20 clean runs since, no identification. Chase with `--test-reporter=tap` **from the first run** | *Traps*, REGISTER E3 |

**Not in the order, and deliberately:** everything in §4 (`DEFERRED-v2` — each has a one-line
justification in `08-PLAN.md`), everything in §5 (blocked by a constraint we chose), and §C
below (blocked on a human).

### C · Blocked on a decision only a human can take

These are **not** scheduled above, because picking one unilaterally is the failure this
repository names most often. Each row's question is in §3 or in the source cited.

`HANDOFF.md` §3 has nine: compensation firing semantics · `JoinNode.timeoutMs` (**doubly
blocked** — the deadline needs lease reclaim, which needs G3, deferred) · `Budget.tokens` and
`Budget.wallMs` · a subgraph span and a parent→child trace route · a `cpuBound` worker pool ·
B11 function-body replay · retention tiering · quorum/delegation/trust tiers ·
`run.cancelled.forced`.

**Five more of comparable size that §3 does not list**, each stated in the corpus as designed
and unbuilt rather than deferred, so §4's justifications do not cover them either: **admission
control and rate-limit backpressure** (D6.3 levels 1 and 3 — `E_ADMISSION_REJECTED` is raised by
nothing, so `POST /runs` admits everything it can authenticate, and a provider rate limit is
absorbed by a retry that sleeps *holding the slot*) · **the operator intervention surface**
(D7.5 — no `pause`, `resume`, `steer`, `redirect`, `kill`) · **the `preAuthorization` envelope**
(D7.10 — not a field of `GraphSpec` at all, so a graph declaring it gets silence) · **the
bounded agent-to-agent mailbox** (D6.6, distinct from §4's deferred free-form blackboard) ·
**the circuit breaker** (D3.5 — `SourceHealth` appears nowhere in `src/`).

**And `08-PLAN.md` §D14.2 already holds six questions marked *"a human must answer before
implementation"*** that were never put to one: Q2 real performance numbers · Q4 which approval
*callback* is mandatory · Q6 which providers must work at GA · Q8 the identity/RBAC source of
truth · Q9 the first real workflow to port · Q10 the EAgent migration path.

### What a marker sweep of the whole corpus found, so it is not re-run blindly

**`design/loom/` carries 32 `DESIGNED-NOT-BUILT` occurrences over 16 distinct symbols, 18
`DEFERRED-v2`, and 2 `NOT-IN-CODE`** — `grep -arnE 'DESIGNED-NOT-BUILT|NOT-IN-CODE|DEFERRED-v2'
design/loom/` is the inventory command, and `docs-drift.test.ts` already gates every one.

**`packages/*/src/` carries none of the usual markers at all.** Zero `TODO`, `FIXME`, `XXX`,
`HACK`, `@ts-expect-error`, empty `catch`, or thrown stubs across both packages; every `() => {}`
is a kill-switch disposer, a deliberate stream-cancel swallow, or a silent-logger default.
**The unfinished work here is not marked** — it is inert fields, events with a fold and no
appender, and uncalled exports. That is why the register and the design corpus are the only
places it surfaces, and why a grep for markers is not a way to find it.

### 1 · Defects — something claims to work and does not

**Empty again, and that is a claim to check rather than a state to trust.** Every row this section
has carried was closed and each was verified against `src/` before its row was deleted, not
against a memory of having fixed it:

| was | closed by | the check that would fail if it regressed |
|---|---|---|
| **D1** a synchronous `function` body could not be stopped | `callTimeoutMs` reaches `vm.runInContext`'s per-call `timeout` (`resources/realm.ts`) | "A SYNCHRONOUS BODY THAT NEVER RETURNS IS TERMINATED" — in `functions.test.ts` AND `hook-loader.test.ts` |
| **D2** a rewind stranded the lease it undid | `rewind` appends `task.ready` for stranded leases | `run/rewind-rearms.test.ts`; audit rule `task.leased-is-resolved` |
| **D4** `onBudgetExhausted: "gate"` did not gate | `GRAPH003_BUDGET_ACTION_UNSUPPORTED` refuses the unbuilt actions at compile | `graph/validate.ts` rule; the engine's `#budget` comment names it |
| **D5** `loom compile` said `ok` for a resource that does not exist | the workspace resolver stopped fabricating pins; `GRAPH015` fires; `NAME_ONLY_KINDS` holds the two key kinds | `resources/unresolved-refs.test.ts`, 8 tests, 7 mutation-verified |
| **D6** fallback chains were declared and unwired | `route.fallback` builds a synthetic `chain(key)` adapter (`cli.ts`) | the `CHAIN` suite in `cli.test.ts` |
| **D7** error edges ignored their `codes` | `#errorEdges` filters by `e.codes` (`engine.ts`) | `run/error-edge-codes.test.ts` |
| **wire codes** the server sent `E_REQUEST_TIMEOUT`, which `errors.ts` never declared, and answered an unknown path with `E_RUN_NOT_FOUND` | both declared; `http.ts` sends `CODES.*` at all five sites, never a literal | "THE OTHER DIRECTION: EVERY CODE `src/` USES IS A CODE `errors.ts` DECLARES" in `docs-drift.test.ts`; "AN UNKNOWN PATH SAYS SO" in `server/http.test.ts` |
| **event vocabulary** a key added to `EventPayloads` and forgotten in `EVENT_TYPES` was appendable and exempt from four gates at once | a compiler-enforced `Exclude<…>` exhaustiveness check, which names the absent keys | "EVENT_TYPES matches the EventPayloads key set" in `journal/store.test.ts` — it fails the BUILD, not the run |
| **retried client errors** every 4xx except 429/401/403/400/422 was classed `unavailable`, so `request()` re-sent a permanent misconfiguration to the attempt cap | 4xx → `E_PROVIDER_BAD_REQUEST` (validation, not retryable), 408/425 excepted | "A 4xx IS NOT RETRIED" in `providers/http.test.ts` — it counts fetches, because the retry loop reads `retryable` and the count is what that field is FOR |
| **a node's `policy.budget.costUsd`** bound nothing at run time, while D2 promised it did and `GRAPH009` told authors to add it | `#runAgent` checks the node ceiling against task-local `usage` before reserving | the three tests under "the node's own ceiling" in `run/budget-declared.test.ts` |
| **`budget.exhausted` could not be written** when no `runUsd` was set — `limitUsd` was `spentUsd + remainingUsd`, and `remainingUsd` is `Infinity` | the row carries the ceiling actually exceeded, read off the error | "A NODE CEILING WITH NO RUN BUDGET JOURNALS A FINITE LIMIT" — same file |
| **`FunctionNode.cpuBound`** promised a worker thread in TWO design documents and was read by nothing; two such nodes ran exactly serially (1.997×) | `GRAPH019_CPUBOUND_NO_EFFECT` warns, and both documents now say inline | "GRAPH019: cpuBound is declared, read by nothing" in `graph/compile.test.ts` |
| **a gate raised by `loom run` never escalated** — the `serve` sweeper held no chain for it and expired it at the first deadline, so `onTimeout: "escalate"` behaved as `fail` | the gate clock arms foreign gates before sweeping, memoised on `headSeq` | "A GATE THIS PROCESS DID NOT RAISE STILL ESCALATES" in `cli/cli.test.ts` |
| **the trace called a child graph a tool** — every effect folds into `loom.model`/`loom.tool`, and the fold sent `subgraph` to `loom.tool` | `loom trace` prints the `effect.kind` the span already carried, suppressed when redundant | "a subgraph is not a tool" in `cli/cli.test.ts` |
| **a replay could page a human** — sweeping to re-derive an expired gate gave replay a caller of `sweepTimeouts`, which delivers, and `ReplayOptions["engine"]` let a caller pass their production broker | the shadow always gets its own broker: excluded in the type, deleted at construction | "A REPLAY MUST NOT PAGE ANYBODY" in `run/replay-expired-gate.test.ts` — which asserts the rig CAN page first, its first version having been vacuous |
| **arming a live gate erased its rendered payload** — `rehydrate` replaced the ephemeral entry wholesale, and the journal-built request carries `payload: undefined`, so one gate-clock tick after a raise the approver saw a digest and no body | `rehydrate` keeps an existing payload when the incoming one is absent | "REHYDRATING A LIVE GATE MUST NOT ERASE THE PAYLOAD IT ALREADY HAS" in `run/gate-rehydrate.test.ts`, plus its companion for the restart direction |
| **`loom trace` did not print a tree** — depth was `parentSpanId === undefined ? 0 : 1`, so a grandchild rendered as its parent's sibling; and once indentation meant something, start-time ordering printed a child ABOVE its own parent | the render builds the tree and walks it, leaving `spansFrom`'s waterfall order untouched | "TRACE PRINTS A TREE" in `cli/cli.test.ts` — it reads the indentation, where the old test read only the names |
| **`loom audit` explained a skipped rule with a false reason** — three rules share the `if (completed)` precondition and only the gate one had its reason written, so on a failed run `task.leased-is-resolved` claimed "no event this rule constrains appears in this journal" about a journal whose seq 5 was `task.leased` | the two siblings get true reasons, conditioned on the event actually being present so it cannot become a blanket excuse | "A SKIPPED RULE'S REASON MUST BE TRUE" and its companion in `journal/audit.test.ts` — mutation-tested in BOTH directions |
| **`UsageRecord.wallMs` had no producer** — both adapters hardcoded 0, so a carefully defined accumulator summed constants; `loom run` printed 0 for a run that took seconds and `evolution/score.ts`'s latency term was identically zero | the two real adapters measure their call, on an injected `HttpOptions.now`; the mock keeps 0 so usage assertions stay deterministic | "A CALL'S WALL TIME IS MEASURED" in `providers/anthropic.test.ts` |
| **a run whose gate EXPIRED could not be replayed** — the gate loop served a recorded decision and threw when there was none, but a gate the CLOCK resolved has `gate.timeout`, and `onTimeout: "fail"` is the default | the expiry is reproduced by SWEEPING the shadow gate, walking its clock forward until it resolves | `run/replay-expired-gate.test.ts`; mutation-tested against both the missing arm AND the ts-derived instant that silently expires nothing |

**Do not add a row here without a reproduction that RUNS.** Every defect in this table was found
by running a new shape of thing, and two of the six were described wrongly by the register until
somebody reproduced them — D2 was worse than recorded (a run that reported success having undone
its work), and D5's prescribed fix would have added a resource kind nothing reads.

### 2 · Open from the E8 taint hardening

Each reproduced or confirmed in source during that work and deliberately left out of it.
**The numbering has a hole and it stays**: T4 is closed (see the bar table), and renumbering the
rest would break every reference to them in the journal.

- **T1 — control flow can be influenced by untrusted content, and nothing escalates on it.**
  **The blocker this entry used to name was stale**: "needs the expression parser to report free
  variables" — `checkExpr` has always returned `refs`, and `GRAPH004_UNDECLARED_READ` has
  always used them. So the reachability half does not exist: every expression the engine
  evaluates (`router.cases[].when`, `edge.when`, `edge.until` — the list, read from the
  engine's source by `test/graph/expression-reads.test.ts`) is refused unless its channels are
  in the owning node's `reads ∪ writes`, which makes them visible to `observedChannels` and so
  to taint and to the classification floor.
  What is left is the real question and it is a **design boundary, not a hole**: a branch CHOICE
  made from untrusted data raises nothing. It is bounded twice — `GRAPH005_ROUTE_NOT_OWN_EDGE`
  plus its runtime half `E_ROUTE_INVALID` confine a router to edges the AUTHOR declared, and
  every target re-decides at full strictness on its own class. Both bounds are now asserted, so
  if either goes this stops being a boundary and the test says so.
- **T2 — `reads` is still not enforced as the read set, but nothing that DECIDES reads it any
  more.** `GRAPH004_UNDECLARED_READ` covers edge `when`/`until` and router cases, never
  `tool.args`, so a template still names a channel `reads` omits and the graph compiles clean.
  **The half that could change an answer is closed**: `observedChannels` moved to
  `graph/spec.ts` and now feeds the compiler's `dataFloor` and the engine's
  `dataClassification` as well as taint. Before that, a channel declared `secret_ref` — floor
  `in`, a gate — interpolated into a tool's arguments and left out of `reads` lost its floor
  entirely: measured, the gate vanished and the tool received the secret.
  What remains is HYGIENE: a compile rule refusing a template outside `reads`, which breaks
  every shipped graph that does this today and is an announced change, not a drive-by.
  **Check before doing it** whether any decision still reads the declared set —
  `grep -arn '\.reads\b' packages/core/src/` — the confinement sites (`viewFor(…, node.reads)`)
  are meant to stay narrow, because widening those would GRANT rather than restrain.
- **T3 — CLOSED.** Taint was added at commit, so a node decided in the SAME wave as its tainter
  saw none — reachable by DELETING an ordering edge, which the compiler only warns about
  (`GRAPH005_UNPRODUCED_READ`, and it stays a warning: reading a channel a concurrent branch
  writes is legal). Measured, same graph one edge apart, under a human ceiling of `on`:
  `awaiting_gate/gates=1/charged=0` wired, `succeeded/gates=0/charged=1` as siblings — E8's
  hard floor walked around. `RunContext.waveTaint` is a per-wave, TaskId-keyed overlay of what
  the wave's EXTERNAL members are about to write, derived and never durable so `ctx.tainted`
  keeps its fold-exactness. `test/run/wave-taint.test.ts`, 5 tests, 6 mutation-verified.
- **T5 — CLOSED.** `#escalate` packed the rule id and its evidence into one string, so E6
  arrived as `violation {"capability":{…}}` and `evolution/trajectory.ts`'s
  `e.payload.rule === "violation"` was dead. **Seven of the eight firing sites pass a detail**,
  so it was dead for seven of eight rules — the register only saw the one that had a consumer.
  `policy.escalated` now carries `rule` (the bare `EscalationRuleId`) and `detail` separately,
  through `PolicyEngine.escalate` and `onEscalate`. `test/evolution/escalation-rule-id.test.ts`
  pins it as a SET: every journaled rule must be an id in `ESCALATION_RULES` and must contain
  no space or brace.
- **T6 — `reachableToolNames` does not descend into a `subgraph`**, so a subgraph node is
  classified `read_only` however irreversible its child is, and invariant 5's "max over every
  tool it can REACH" is not what the code computes. **The POSTURE consumer is still not a
  hole**, for the reason this entry always gave: each run has its own `PolicyEngine`, so the
  child re-decides at full strictness with no inherited ceiling.
  **A second consumer of the same blindness WAS a hole, and is closed.** `rewind` refuses to
  undo past an irreversible call with no compensation, and it scanned `tool.called` in the run's
  own journal — where a child's calls are not. Measured: the same uncompensated `pay.charge`
  refused a rewind when the parent called it and ALLOWED one when a subgraph did, with the money
  already gone. `#uncompensatedIrreversible` now follows `subgraph.started.childRunId`,
  depth-bounded. `test/run/rewind-through-subgraph.test.ts`, 5 mutation-verified.
  **Read the surviving half of this entry accordingly**: "not currently a hole" had checked one
  consumer. `#irreversibilityOf` and `#capabilitiesOf` have since been audited: neither is a
  hole on its own — a child re-decides irreversibility at full strictness, and the child compile
  gets the same `tenantCapabilities` — but the audit found a THIRD thing next door, below.

- **A graph's `policy.capabilities` is now a CEILING, which is what D5's schema always said.**
  `capabilities: [string]  # allowlist; intersected with system + tenant (never widened)` — only
  the upward half was built, so `capabilities: []` permitted everything the tenant did.
  Measured: a graph declaring the empty list ran `pay.charge` to completion. Enforced now at
  compile (`GRAPH017_CAPABILITY_NOT_DECLARED`), at run (`PolicyEngineOptions.allowlist`), and
  ACROSS DELEGATION (`RunContext.grantBound`, narrowed into each child run — the parent's
  `subgraph` node reaches no tool, so the compile check cannot see that one).
  **Absent is not empty**: a graph that declares no list has no ceiling. Every graph in this repo
  that declares one already names what its tools need, checked by arming the rule and running
  the whole suite before writing it — zero failures.

### 3 · Mechanism that exists and is wired to nothing

These need a **product decision**, not a bug fix. Do not pick one unilaterally; each has a
question that the repository cannot answer.

| Item | The question that has to be answered first |
|---|---|
| **Compensation** (B9) | A compile-time proof and a rewind refusal exist; `case "compensation": break;` executes nothing. *When does a compensation edge fire* — on task failure, on run failure, on rewind? |
| **A span for a subgraph, and a route from a parent trace to its child** | D9.1's span taxonomy is eight names and deliberately fixed there — see its own table and the designed-not-built row beneath it — so every effect folds into the model or tool span, and a `subgraph` effect wears the tool's name. `loom trace` now prints the `effect.kind` the span already carried, which fixes the misnomer for a reader and not the other half: the parent's journal records the subgraph's start and completion WITH the child run id, `telemetry/spans.ts` builds no span from either, so a trace offers no route to the child's own trace. *Does a subgraph earn a ninth span name, or a link on the tool span, or should the effect span the design has registered as unbuilt finally be built and the fold retired?* Three defensible answers, three different designs — and the literal names are kept out of this row on purpose, because naming one here obliges the drift registry to carry it |
| **A function worker pool** | `cpuBound` now warns instead of lying, but the capability D2 and D3 described is still absent, and a long function body blocks the event loop — every other task in the wave, and any `loom serve` plane in the process. `node:worker_threads` is a builtin, so invariant 1 is not the obstacle; the sandbox is. `resources/realm.ts` builds a hardened `vm` context per body and bounds each call with `vm.runInContext`'s `timeout`. A worker has to re-establish that context on the other side, marshal the channel view across, and replace the per-call timeout with worker termination. *Does a `cpuBound` body keep the same isolation guarantees, and what bounds it when `vm`'s own timeout no longer applies?* |
| **`Budget.tokens` and `Budget.wallMs`** | `Budget` declares three dimensions and only `costUsd` binds — the other two are read by NOTHING in `src/` (`PolicyEngine.BudgetLimits` carries `runUsd` and `tenantUsd` alone), at graph level and node level alike, while fixtures cheerfully declare `tokens: 2_000_000, wallMs: 900_000`. Found immediately after `costUsd` was made to bind, which is the point: **read the closed row above as being about ONE of three fields.** The question each needs is different. `tokens`: `estimateOf` returns USD and there is no token estimator, so a token ceiling can only be checked against tokens already spent — it would bind from turn 2, not before turn 1, which is a different guarantee from the one `costUsd` gives and has to be chosen deliberately. `wallMs`: node `timeoutMs` is enforced and already does this job, so the question is whether `budget.wallMs` should exist at all rather than how to implement it |
| **`JoinNode.timeoutMs`** | In the schema, read by nothing — and now WARNED about at compile (`GRAPH008_JOIN_TIMEOUT_INERT`), so an author who never read D5 finds out from the compiler rather than from a barrier that waits forever. The decision itself is untouched: *what does a barrier timeout DO* — fail the join, or fold what arrived? Folding partial evidence for `mode: all` is a semantics change, not a timeout. **A warning and not an error on purpose**: the other four unbuilt mechanisms SUBSTITUTE semantics and are errors; this one does nothing and the design says so in three places, so refusing it would be taking this decision |
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

- **`rewind` and `advance` are control-plane commands with no CLI verb**, while `cancel` and
  `approve` have both. An operator on a `loom serve` plane can
  `POST /runs/:id/commands {"kind":"rewind","atSeq":N}`; one with only the binary cannot. Adding
  `loom rewind` is not just a verb: `atSeq` has to be discoverable, and no verb prints journal
  seqs today — `audit` prints violations, `trace` prints spans. That is the design question
  attached to it, and it is why this is recorded rather than built.

- **`run.cancelled.forced` is written once as `false`, read by nobody, and named by no design
  document.** Dead in both directions. Left alone deliberately: it sits in a durable event
  payload, so deleting it is a schema change to journals already on disk, for a field no decision
  reads. Either give it a meaning — what a forced cancel does that `cancel` does not — or remove
  it in a change that owns the migration; do not half-wire it.

- **The spec-field sweep has been run once; here is its whole answer, so it is not re-run blindly.**
  Every field of every `interface` in `graph/spec.ts` — 137 — was checked for a reader outside
  `graph/`. **11 had none.** Six are correct as they stand: `NodeSpec.unhandled` (a compile-time
  GRAPH011 suppression), `ExpansionBudget.maxFanout` (enforced statically, capping edge
  `maxWidth`), `GraphSpec.apiVersion` and `RunGraph.terminalNodes` (compile-time), and
  `RetryPolicy.jitter`, which `engine.ts` deliberately does not apply — "the delay must be a pure
  function of (policy, attempt) or replay diverges". Three were already reserved in §3
  (`EdgeSpec.compensates`, `ApprovalSpec.delegation`, `DelegationSpec.mustStayInGroup`).
  `FunctionNode.cpuBound` is fixed above. That leaves **`NodePlan.inboundEdges`**, computed by
  `compile.ts` and read by nobody — cost rather than a lie, and the only one still open.
  **`RetryPolicy.jitter` is the one worth a second look**: the reason it is unapplied is sound,
  but the field is still public, accepted, and inert, which is what `GRAPH019` now exists for.

- **A `subgraph` node's `policy.budget.costUsd` still binds nothing, and that is structural.**
  The agent loop now enforces its node ceiling, but a subgraph's cost is settled from
  `childP.usage.costUsd` AFTER the child run has finished, so there is no point at which a cap
  could refuse the spend rather than report it. Enforcing it means giving the child its own
  ceiling at submit time — a real design step, not a missing line. `GRAPH009` still counts these
  budgets in its static sum, which is correct arithmetic about a number nothing enforces.

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
- **Neither resource loader is ever handed its `pins`, so the shipped binary cannot enforce a
  pin.** `FunctionLoaderOptions.pins` and `HookLoaderOptions.pins` are both accepted and both
  unset — `cli.ts` constructs each loader with `{ store }` alone — which makes the
  manifest-digest enforcement branch in each one unreachable through `bin/loom`. The consequence
  is the one A22 closed for prompts: a promotion between compile and execute swaps a body under
  a live run. **`subgraph` is the third content kind with the same seam (REGISTER A24), and this
  is the entry that says so.** The first version of this claim was written about hooks alone and
  went stale as soon as the invocation landed, which is the argument for fixing all three
  together: `03-RUNTIME.md` D6.9 and both loader docstrings each concede their own half.

- **Fields declared and read by nothing, beyond the eleven the spec-field sweep recorded.** The
  sweep above covered `graph/spec.ts`'s interfaces; these came from a wider pass.
  `GraphMetadata.labels` has ONE occurrence in the entire tree. `ExpansionBudget.maxLoopIterations`
  is read by neither the engine nor `validate.ts`, while its three siblings all have readers —
  `engine.ts` argues `GRAPH006_UNBOUNDED_LOOP` covers the need, which is true and leaves the
  field inert. `DelegationSpec.mustStayInGroup` and `maxDepth` are unread (`allowed` is read only
  in order to be REFUSED). `ToolNode.version` is declared required by the type and enforced by
  nothing, because the engine looks a tool up by NAME. In `run/context.ts`: `AssembleInput.turns`
  is never supplied any more than `retrieved` is, `SectionName "tool_results"` is declared and
  prioritised and `buildSections` never constructs one, and the sole caller of `assembleContext`
  reads `assembled.channels` and discards the other five fields. **`GRAPH019` is the precedent
  for all of these** — warn at compile that the declaration does nothing, rather than delete a
  public field or silently keep accepting it.

- **Docstrings that name a consumer they do not have.** `OBSERVER_POINTS` says it is *"asked at
  every call site"*; nothing reads it. `CAN_SUSPEND` and `CONTROL_TYPES` are documented as
  invariants the scheduler enforces and `scheduler.ts` never consults either. `createGraphCompiler`
  wraps a `GraphCompiler` interface whose `analyze` is unused, while all six in-tree compile sites
  call the bare `compile()`. These are cheaper than a field to fix — the docstring is the defect.
  **One is different and is a live hazard**: `packages/eagent`'s `args.ts` exports `FLAGS` saying
  the help text and a parity test read it, and `parseArgs` re-lists every flag as string literals
  instead, so the list and the parser can disagree with nothing going red. That is the same shape
  as `KNOWN_FLAGS`/`USAGE`, which this repo already gates as ONE set in `known-flags.test.ts`.

- **The whole `evolution/` subsystem and all of `journal/retention.ts`'s tiering have no caller
  in `src/`** — `foldTrajectory`, `measureCohort`, `promotionCeiling`, `requirePromotable`,
  `InMemoryCohortBaseline`, `TierManager`, `MemoryTierStore`, `tierFor`. Both are consistent with
  §3 and §4 (capture and scoring ship, the generator does not; tiering needs a cold store), and
  are recorded here so the absence of callers is not re-discovered as a defect.

- **The evolution promotion gate is weaker than `06-EVOLUTION.md` D10.d documents, on six of its
  eight criteria** — `maxAgeDays` declared and unenforced, a bare point-estimate comparison where
  the design asks for McNemar plus a Wilson interval (*"arithmetic only, no dependency"*, so the
  zero-dep rule is not the obstacle), no `medianCostUsd` so one pathological case can carry the
  ratio, `promptGrowth` and `postureDiffNonNegative` both caller-supplied and trusted, and
  injection-resistance cases *"not checked, and cannot be expressed"*. The document says all six;
  nothing in this file did.

- **Half the telemetry plane is designed and unbuilt, and two reversal conditions depend on it.**
  Eight `loom.*` span names carry `DESIGNED-NOT-BUILT`, roughly fifteen documented span attributes
  are never set with no guard over the attribute set, and the task-selection span is marked in
  two documents while missing from `05`'s own inventory table. The consequence is in §5 already for
  the scheduler tick, and it generalises: DL-1's and D12.8's reversal metrics are p99s over spans
  emitted nowhere, so each **reads as a check that passed**.

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

**The gate and the install were both verified from a CLEAN CLONE**, which is the condition CI
runs in and the one `--force` exists for — no `dist/`, no `bin/loom`, no `node_modules`:

```bash
git clone -q --branch loom --single-branch . /tmp/cc && cd /tmp/cc
npm ci && npm run check          # 3505 pass, 0 fail, both guards ok
npm install && npm run build:binary   # the README's literal verb; bin/loom, 843 KB bundle
```

Three things this settles that the working tree cannot. **No gate input is gitignored** — only
tracked files exist in a clone, so a green `check` there is the proof, and it is why no test
needs to assert it. **`npm ci` and `npm install` both work**, though npm reports esbuild's
postinstall blocked under a scripts policy; that is harmless, because modern esbuild ships its
platform binary as an optional dependency (`@esbuild/darwin-arm64`) rather than fetching it.
And the README's three-line block runs verbatim into an EMPTY directory: `loom serve` answers
`200` with the console, and scaffolds `.loom/`, `graphs/` and `resources/`.

**Fan-out into a join is verified end to end, and invariant 7 holds through the product.** Driven
through `bin/loom`: `fanout.planned` width 3, three branches under derived ids
`work@root/e1[0..2]#0` each carrying its bound item, a join committing `branchCount: 3`, and an
`append_ordered` channel returning `["alpha","beta","gamma"]` — branch-coordinate order, not
arrival order. **ALL EIGHT NODE TYPES HAVE NOW BEEN DRIVEN through `bin/loom`**: a router takes
its case edge for `n > 10` and its fallback otherwise while writing no state of its own, and an
`assertion` evaluator runs its body and escalates below threshold. The bar's "all eight node types
execute" is now a statement about the binary rather than about the engine with an injected
resolver.

**The `function` authoring path had a real usability defect and it is fixed.** `FunctionOutcome`
is `{ writes?, take? }` and that is a TypeScript type a `function/*.js` author never sees: the
channel map returned directly was a SILENT no-op ending in `E_OUTPUT_MISSING` about a channel the
body believed it wrote, and no return at all surfaced a raw `TypeError`. Both now refuse with
`E_RESOURCE_INVALID` naming the shape and the author's own key. The evidence it was a real defect
rather than a nicety: **three function bodies were written while driving this and all three had
the shape wrong**, with nothing in the product saying so.

**The oversight guards were swept for untested PERMIT arms and are sound.** Each two-armed guard
pairs its refusal with its permission, usually in adjacent tests: the intervention window has both
"an interrupted window leaves a posture behind" (asserting the effect never started) and "a window
that elapses untouched escalates nothing"; the capability ceiling has "a graph that declares no
capabilities cannot use one" and "absent is not empty"; separation of duties opens with "THE
INITIATOR IS REFUSED AND A CO-APPROVER IS NOT — the rule, in one run". `nodeApproved` was the
exception, not an instance of a class.

**DRIVING BEATS SWEEPING HERE, and the record now says so with numbers.** Nine surfaces driven end
to end produced six defects; five sweeps derived from a previous finding produced about one and a
half. The reason is structural rather than luck: a sweep assumes the finding it was designed from
is an INSTANCE of a class, and in a codebase this disciplined most findings are EXCEPTIONS — the
class is already handled everywhere else, which is exactly why the one exception survived long
enough to be found. **Prefer driving something nobody has driven over generalising the last
defect**, and when a sweep is run, expect a negative and record it so it is not re-run.

**The USAGE text was audited claim by claim, and the fs jail holds.** Driven through the binary:
`fs.read`/`fs.write` on `.loom/journal.db` are both denied ("is inside … which this sandbox
denies"), a custom `--data-dir` inside the workspace is denied the same way — so "wherever it is
put" is true — and `../../../etc/hosts` is refused as escaping the sandbox root. `loom gates
<runId>` lists open gates as JSON. **One claim was false and is fixed**: `--allow-exec` said
"every call GATES … inside an agent turn it is refused outright", which describes a TOOL node and
generalises wrongly. An agent gates ONCE at the floor over every tool it can reach, and one
approval then covers every in-turn call — measured, one `gate.raised` and one `gate.decided`
against TWO `proc.exec` executions.

**`--allow-exec` is verified and holds exactly as documented**, driven through the binary: the
tool is unregistered without the flag, every call GATES because `proc.exec` is irreversible, and
the allowlist is matched by NAME — `echo` runs while `/bin/echo` and `echoes` are both refused,
which are the two attacks the implementation comment names (a path to a file the model just
wrote, and a prefix admitting `gitk`). **`--exec-env`'s line was false and is fixed**: it claimed
"Default is an empty environment" while `buildEnv` always passes `BASE_ENV_ALLOW`, so a child
receives PATH, LANG, LC_ALL and TZ. Measured with a secret exported into the parent — the child
saw exactly LANG, PATH, TZ and not the secret, so the boundary held and only its description was
wrong. Pinned now by a test reading the constant, so a name added there fails until the
operator-facing text admits it.

**The capability flags are verified and found sound**, and their usage text is accurate. Driven
through `bin/loom` against a local sink: without `--egress`, `net.fetch` is unregistered and a
graph naming it COMPILES with `GRAPH013_UNKNOWN_TOOL` (a warning) but fails to compile with
`GRAPH017_CAPABILITY_NOT_GRANTED` if it also declares `net:fetch` — both exactly as documented.
With `--egress 127.0.0.1` and the capability declared it fetches; with `--egress example.com` the
same run fails `E_TOOL_SOURCE_UNAVAILABLE: egress to "127.0.0.1" is not on the allowlist`, so the
allowlist binds. `--grant net:fetch` is refused outright, because a tool capability comes from
what is registered. The default registry is `fs.*` only.

**One tension surfaced and was NOT resolved, deliberately.** A node naming an unregistered tool
gates before it fails: a human is paged, approves, and only then does the run report
`E_TOOL_NOT_FOUND`. `oversight.test.ts` pins that on purpose — "the policy engine cannot know a
tool's class if the tool is not registered, and guessing harmless is the one guess that is never
safe" — while `cli.ts` refuses `--grant` for a capability with nothing behind it on the opposite
ground, that it "asks a human to authorize something nothing can run". Both sentences are right
about different things. **The deciding fact is recoverability**: a suspended run resumes after an
operator restarts with `--egress` and the gate rehydrates, and a failed run does not. Failing
fast would trade a recoverable state for a cleaner error. Changing it is a risk-tolerance
decision, so it stays as it is; the reasoning is here so the next person need not re-derive it.

**The SSE stream is verified and found sound** — the largest reporting surface that had never
been driven, checked because three of the four findings before it were in what a tool SAYS rather
than what the system does. `GET /runs/:id/events` replays history from seq 1, resumes gap-free
from `Last-Event-ID` (id 4 → next frame is seq 5), and pushes live: a connection held open across
an approval received all thirteen events from `gate.decided` to `run.completed`, in order. Every
malformed `Last-Event-ID` fails SAFE — a value past the end, a negative, and a non-number each
return a `snapshot` frame carrying the full projection rather than a silent gap, while an empty
header is treated as absent. Unauthenticated is 401 and an unknown run is 404, never 403, so the
refusal cannot be used to learn which ids are real. **No defect; recorded so it is not re-driven.**

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
**This paragraph existed and the trap still fired** — a later mutation sweep put `git checkout
--` in a shell `trap`, which restored the file to HEAD and silently deleted the fix under test.
The reliable habit is stronger than `cp`: **mutate only a COMMITTED tree.** Then restore is
total, and `git status` proves it happened. A `cp` restore also runs on the error path, where
nobody reads its output. The tell that it went wrong is a mutation that reports NOT MATCHED on
a second run — always assert the mutation matched, or a vanished fix reads as a passing guard.

**A VOCABULARY WITH TWO REPRESENTATIONS WILL DRIFT, and every gate iterating the wrong one is
silently switched off.** Two consecutive waves found this and neither was looking for it. Error
codes: three gates — "every declared code is named by a document", `NEVER_RAISED`, and the
boundary taxonomy — all iterate the DECLARED list, so a code that reached clients without being
declared was invisible to every one of them. Event types: four gates all iterate `EVENT_TYPES`,
so a type declared in `EventPayloads` and omitted from that array was appendable to the journal
while needing no audit rule, no written excuse, no appender and no doc row. The tell is a guard
whose comment names the direction it does not check — both said so in writing, and both were
believed for exactly as long as nobody added the key and ran it. **Ask of any registry: which of
its two forms does each gate walk, and what happens to the member that is only in the other?**
The fix to prefer is the type checker, which cannot be walked in the wrong direction at all.

**THERE IS A RARE FLAKE IN THE SUITE, observed twice and not identified.** Two runs reported
`fail 1` within one window; **20 consecutive runs since have been clean**, including three under
deliberate CPU and socket load. Ruled out by measurement, so the next session need not redo it:
no stray `loom serve` process (`pgrep -fl 'bin/loom serve'` empty at the time), no port collision
(every test that names `serve` calls `parseArgs`/`openWorkspace`/`controlPlaneOptions` and binds
no socket — the default 8787 is never taken by the suite), and it does not reproduce under load.

**What cost the identification is worth more than the flake.** `npm test` uses node's default
reporter, whose failure lines do not survive a grep for the name — by the time the reporter was
switched, it had stopped reproducing. **Chase a flake with `node --test --test-reporter=tap
"packages/*/test/**/*.test.ts"` from the first run**, where a failure prints `not ok <name>` and
one occurrence is enough.

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
