# examples

**This directory is a Loom workspace** — a directory with `graphs/` and `resources/` in it. Loom
reads nothing else; `bench-cases.json` at the root is not a workspace file, it is §5's input, and
neither `reports/`, `manifests/` nor `access/` is one — they are §8's, §9's and §10's.

```bash
npm install && npm run build:binary   # → bin/loom
export PATH="$PWD/bin:$PATH"
cd examples
```

**Eight graphs, and they do not all run the same way.** Without `--models-file` the only registered
adapter is the offline mock, and `loom run` says so on stderr before it starts.

| graph | § | needs a model? |
|---|---|---|
| `graphs/fan-out-join.json` | 1 | **no** — `function` nodes only |
| `graphs/guarded-write.json` | 3 | **no** — one `tool` node and a `preTool` hook |
| `graphs/two-person-approval.json` | — | **no**, and it does not run to completion: it parks on three human gates and waits for people. **Two-of-three approval lives in `join`, not in `approval`** — three `human_gate` nodes joined by `join{branches:[…], mode:"quorum", k:2}`; `approval.mode: "quorum"` was deleted and is now `GRAPH020_UNKNOWN_FIELD`. **It is two-of-three WITH A VETO, not tolerance of a dissenter**: `onBranchError: "fail"` is read before `k`, so a rejection arriving before the second approval fails the run — the graph's own `description` and `labels.residue-veto` state the boundary, and `labels.residue-late-veto` the case where the write has already landed. A short-circuiting join keeps its remaining branches running, so the third gate stays OPEN — a real gap, recorded in the graph's own `labels`. `packages/core/test/graph/two-person-approval.test.ts` drives it |
| `graphs/review-bench.json` | 5 | **runs offline, means nothing offline** — see §5 |
| `graphs/self-review.json` | 6 | **yes** — it is the workflow this project ported first |
| `graphs/triage-failures.json` | 8 | **no**, and it means something offline — the classification is read off an error signature, not inferred |
| `graphs/harden-config.json` | 9 | **no**, and it means something offline — a policy violation is read off the manifest's structure. The only graph here with a `loop` edge in it. It printed **three warnings that were wrong about their cause and right about a hazard** on every command until §A.84 closed; it compiles SILENT now, and §9 keeps the paragraph because the hazards are still real |
| `graphs/grant-access.json` | 10 | **no**, and it means something offline — the ceremony is read off the resource's tier, the level and the hours. The only graph here with a `router` or a `kind: "error"` edge, and the only one using a reducer other than `replace`/`append_ordered`. It compiles with **no diagnostic at all**, and it reaches three different endings on three different inputs: see §10 |

`packages/core/test/examples-run.test.ts` COMPILES every graph in `graphs/` — the set is the
directory, so a graph added later is covered without editing the test — and RUNS the three it can
drive to COMPLETION without a model (§1, §3, §5), asserting §5's six verdict strings and its
`3/6 assertions passed`. §8, §9 and §10 need no model either and each has its own suite below;
`two-person-approval` parks and is never answered. Only §6 is
compiled and not run there: it needs a real model, and there is nothing to gate on canned text.
§8 is compiled there and RUN by `packages/core/test/examples-triage.test.ts`, which is a separate
file because it needs `reports/` in the workspace copy and `examples-run.test.ts` deliberately
copies only `graphs/` and `resources/`. §9 and §10 are the same arrangement one graph later each:
`packages/core/test/examples-harden.test.ts`, because it needs `manifests/`, and
`packages/core/test/examples-grant.test.ts`, because it needs `access/`. **§10 is the one that does
not always park** — its router sends a public-tier read straight to the write with no gate at all,
and sends a request outside policy to a refusal that exits 1.

---

## 1 · Fan-out → join

One node splits a document, a `fanout` edge spreads one branch per piece, a `join` folds them back
in **branch order**, a last node reduces the fold.

```
      plan ──fanout(over: chunks, as: chunk)──▶ count ──join──▶ gather ──seq──▶ summarise
```

```bash
loom compile graphs/fan-out-join.json                                          # ok, exit 0
loom run graphs/fan-out-join.json --input '{"document":"alpha beta\ngamma\n\ndelta epsilon zeta"}'
# → "status": "succeeded", report {lines: 3, words: 6,
#      order: ["alpha beta","gamma","delta epsilon zeta"]}                     # exit 0
loom replay <runId> --graph graphs/fan-out-join.json
# → {"match": true, "hermetic": true}                                         # exit 0
```

`order` is the order the fan-out laid the branches out in, not the order they finished; `report.at`
is recomputed rather than replayed, because `ctx.now()` is the task's journaled lease timestamp.

**The three parts that have to agree**, which is the step that costs people compiles: the fan-out
edge names the array and the per-branch channel
(`{"kind":"fanout","over":"chunks","as":"chunk","maxWidth":8}`, ceilinged by
`policy.expansion.maxFanout`); `join.branches` lists *node ids*, not edge ids; and **the edge from
an arm into the join must be `"kind": "join"`** — a `seq` edge leaves `gather` inside the fan-out
(`GRAPH008_HELD_JOIN_UNCOLLECTED`), no edge at all is `GRAPH008_BRANCH_NOT_CONNECTED`. A channel
written by parallel branches needs a reducer that survives concurrent writers: `counts` is
`append_ordered`, and `replace` is refused as `GRAPH010_CONCURRENT_WRITE`. A channel NOTHING
outside the branch touches is exempt and may be `replace` — §8's `raw` is one, and names the
exact conditions — but `counts` fails several of them at once, and `gather` is enough on its own:
a join that declares `"writes": ["counts"]` is a **second writer**, so deleting the post-join
reads in `summarise` changes nothing.

**A join not one of whose members succeeded fails the run**, and that is a run-time refusal rather
than a compile one. The barrier still releases; the fold then fails `E_QUORUM_UNREACHABLE` and the
run reports `failed`. It does so under `"onBranchError": "skip"` too — `skip` still absorbs every
loss short of the last one, but a run in which nothing succeeded is not a success.

**Not on THIS graph, though**, and the distinction is worth having before you go looking for it:
`gather` here declares `"onBranchError": "fail"`, so the older arm beside it fires as soon as ONE
branch is lost and you never reach the new one. The shape that reaches it is a `"skip"` join every
one of whose members died — most sharply, a `human_gate` inside each fanned-out branch with every
human rejecting, which used to run the node behind the join and report `succeeded`. Two shapes are
deliberately untouched: a fan-out over an **empty array** materialises no branch at all, so there
is nothing to have succeeded and the graph behind the barrier runs exactly as before; and a branch
that lost a node AFTER an earlier node in it wrote still folds, writes included.

## 2 · A `function` body — `resources/function/*.js`

A file in `resources/<kind>/` publishes `<kind>/<basename>@stable`, so `resources/function/count.js`
is what `"function": {"ref": "function/count@stable"}` resolves to; the extension is not part of the
ref. **The file is a bare function expression** — no `module.exports`, no `export default`, no
wrapper: the loader evaluates `(<the file>)` and keeps the value. `(view, ctx) => ({…})` is equally
valid; `module.exports = function (…) {…};` is not, and fails as in §4. A body that fails to load is
a **compile error** for the graph that names it, refused before a run id is minted.

The body gets `view.require(c)` / `view.get(c)` / `view.visible` for the channels the node declared,
plus `ctx.taskId`, `ctx.now()`, `ctx.signal`, `ctx.node` — not `Intl`, `fetch`, `require` or
`process`. `Math.random()` works and is seeded from a journaled draw, so a replay draws the identical
stream. **`ctx.effects` is present but refuses inside a sandboxed body** (`E_EFFECT_UNAVAILABLE`): the
body runs synchronously inside a `vm` and cannot await a host round trip. Put the call on a `tool` node
(§3), or register the body with `FunctionRegistry.register`.

**`Date` IS here, bound to `ctx.now()`** — `new Date()`, `Date()` and `Date.now()` all answer the
task's journaled lease timestamp, so a replay computes the same number and nothing new is written;
every explicit-argument form (`new Date(0)`, `Date.parse`, `Date.UTC`) is the real one, because none
of them reads a clock. `Intl` stays absent and that is not an oversight: `new
Intl.DateTimeFormat(…).format()` with no argument reads the WALL clock, which is the second door the
same rule has to close. A hook body (§3) gets neither — `HookContext` has no `now` to bind `Date` to.

**`ctx.node` is this node as its GRAPH declared it** — `{id, type, reads, writes, out}`, frozen, with
`out` reducing each outgoing edge to `{id, kind, over?, as?, maxWidth?, maxIterations?}`. It is there
so a bound the graph already states is not written a second time in the body: §8's `triage-plan.js`
reads the `fanout` edge's `maxWidth` off it. An absent field is an absent KEY on both paths, so test
with `typeof e.maxWidth === "number"` rather than against `undefined`. **Both engine callers supply
it** — a `function` node and an `assertion` evaluator, a hand-registered body and a resource-loaded
one, all get the same object off the same builder. It is nonetheless optional, because a caller who
invokes a `FunctionBody` DIRECTLY (the only other way to run one) passes no node, and an absent
graph is reported as an absent field rather than one holding `undefined`.

**A body fails on purpose by RETURNING a verdict, not by throwing.** `{retry: {reason}}` is
`unavailable`/`E_FUNCTION_UNAVAILABLE` and the node's `retry` policy may grant another attempt;
`{refuse: {reason}}` is `validation`/`E_FUNCTION_REFUSED` and is never retried, however generous
that policy is, because a second attempt on the same inputs refuses identically. Each is exclusive
with `writes`, with `take` and with the other — `{writes, take}` together is the ordinary shape, a
verdict beside either is refused as `E_RESOURCE_INVALID`. A `throw` is neither and is not the way to
decline work: it normalizes to `internal`/`E_INTERNAL`, the code a genuine bug in the body produces.

## 3 · A `hook` body — `resources/hook/no-secrets.js`

`graphs/guarded-write.json` is one `tool` node plus `"hooks": {"preTool": ["hook/no-secrets@stable"]}`.
The hook sees `{tool, args}` before every tool call and may block it or rewrite its arguments.

```bash
loom run graphs/guarded-write.json --input '{"note":"remember to water the plants"}'
# → "status": "succeeded", "written": {"bytes": 28, "path": "notes/note.txt"}   exit 0

loom run graphs/guarded-write.json --input '{"note":"token sk-live-42"}'
# → "status": "failed", nothing reaches the disk:                               exit 1
#   E_TOOL_SOURCE_UNAVAILABLE: "fs.write" was blocked before dispatch: the body looks like it
#   carries a credential, so it is not going to disk
```

Same file shape as a `function` body — a bare function expression — and the same realm. Differences:

- The signature is `(input, ctx)`; `input` depends on the point (`preTool` → `{tool, args}`,
  `preNode` → `{}`, so branch on `ctx.taskId`, `nodeId@branch#iteration`), and `ctx` is
  `{point, runId, taskId, signal}` and nothing more.
- **A filter may only narrow** — block a call, rewrite arguments, exclude an approver. There is no
  field for granting a capability or lowering a posture, so there is no way to ask.
- **`Math.random()` throws in a hook**: it fires at eight points, one run-scoped with no Task to key
  a journaled draw under. Do the draw in a `function` node.
- A declared hook the workspace does not publish is a **compile error**, not a silent skip.

## 4 · The mistake this directory exists to prevent

```bash
printf 'module.exports = function (input, ctx) { return {}; };\n' > resources/hook/no-secrets.js
loom compile graphs/guarded-write.json
# ! skipping hook/no-secrets@stable in …/resources/hook: … did not evaluate: Unexpected token ';'
#   — a code resource file is a BARE FUNCTION EXPRESSION and nothing else. …
# E_RESOURCE_NOT_FOUND: this graph declares 1 hook(s) this workspace does not publish …   exit 1
```

**A `function` file is refused the same way** — the same `printf` over `resources/function/count.js`
plus `loom compile graphs/fan-out-join.json` gives `! skipping function/count@stable` then
`E_RESOURCE_NOT_FOUND: … 1 function body(s) … could not load`, exit 1. It used to print `! skipping`
and then `ok` with exit 0 and fail later inside a run. `git checkout examples/resources/` puts
either back.

## 5 · `review-bench` — the benchmark whose answer is known

Six small diffs, three carrying a defect this codebase actually had and three clean;
`bench-cases.json` holds the ground truth, so the run is graded mechanically with no human and no
rubric — which is what makes it an `S1` signal. It fans one `agent` review per case, joins, and
hands each case to its own **`assertion` evaluator** —
`resources/function/bench-check-0.js` … `bench-check-5.js`, one per case.

```bash
loom run graphs/review-bench.json --input "$(cat bench-cases.json)"
# offline, against the mock: the reviewer flags nothing, so                    exit 0
#   verdict0 fail-open-fold: MISSED       verdict3 rename-local: correctly clean
#   verdict1 default-stop: MISSED         verdict4 widen-comment: correctly clean
#   verdict2 clear-all-actions: MISSED    verdict5 add-const: correctly clean
loom score <runId>
# → "signals": [{"id":"S1","value":0.5,"weight":1,"evidence":"3/6 assertions passed"}]
#   "outcome": 0.5                                                             exit 0
```

**This is the one graph that RUNS offline and MEANS nothing offline.** A reviewer that says nothing
about anything clears every clean diff and misses every defect, which scores 0.5 — so a passing exit
code is not the signal here, `verdict` is. Against a live GLM-5.2: three hits, no misses, one false
alarm. **Six evaluator nodes, not one, and that is the whole design:** `S1` is *(assertion nodes
that passed) / (assertion nodes)*, so the granularity is a property of the GRAPH, not of the
checker. Its `agent` node names `agent_profile/reviewer@stable`, which this workspace does not
publish and the graph still compiles — a profile is a ROUTING KEY the `routes` table maps to an
adapter, not a document.

**The loop, end to end.** Thirty runs assemble into one cohort — the input bucket is the input's
SHAPE — and a candidate is judged against a frozen exam drawn from them:

```bash
for i in $(seq 1 30); do loom run graphs/review-bench.json --input "$(cat bench-cases.json)"; done
loom score <lastRunId>     # → "cohort": {"n": 30, …}. OFFLINE, "golden" is false and
#   "goldenBlockers" names why — outcome 0.500 needs ≥ 0.8, and a cohort the ladder cannot
#   separate is UNRANKABLE. That is the mock scoring 0.5 on every run, not a defect.
loom cohort <lastRunId>    # → every run judged under the same key and weights
loom promote candidates/review-bench-v2.json --baseline graphs/review-bench.json --suite suite.json
```

`loom promote` replays the suite's recordings against both graphs: **it calls no model and runs no
tool**, which makes it cheap and also bounds it — a candidate whose only change is a PROMPT is
refused, because replay would serve the recorded answer to a question it never asked;
`--against-cohort` judges that kind by re-RUNNING it. Freeze the suite BEFORE writing the candidate:
`9-suite-predates-candidate` is that timestamp comparison. `demo/close-the-loop.sh` is the live half
(a script, not a test); `test/evolution/close-the-loop.test.ts` is the offline half.

## 6 · `self-review` — the one that needs a real model

§§1–4 need no adapter and §5 needs one to say anything; this one needs one to RUN — it ends in a
human gate and an irreversible write, and there is nothing to gate on canned text. One `agent` node
per changed file (fan-out), a `join`, a fold into a report, a **human gate**, then an irreversible
`fs.write`: every node type the README claims, in one graph.

```bash
export OPENAI_API_KEY=...            # the key stays in the environment, never in the file
cat > models.json <<'JSON'
{ "adapters": [ { "provider": "openai", "name": "m", "baseUrl": "https://api.openai.com/v1",
                  "apiKeyEnv": "OPENAI_API_KEY", "defaultMaxTokens": 16000 } ],
  "routes": { "agent_profile/reviewer@stable": { "adapter": "m", "model": "gpt-5",
    "fallback": [ { "adapter": "m", "model": "gpt-5-mini",
                    "when": ["E_PROVIDER_OVERLOADED", "E_PROVIDER_RATE_LIMIT"] } ] } } }
JSON
git diff HEAD~1 > subject.diff
loom run graphs/self-review.json --models-file models.json --as u:you \
     --input "$(node -e 'console.log(JSON.stringify({diff:require("fs").readFileSync("subject.diff","utf8")}))')"
#   → "awaiting_gate"; out/review.json does NOT exist yet
loom gates <runId>
loom approve <runId> <gateId> --as u:you --graph graphs/self-review.json   # → out/review.json exists
loom replay <runId> --graph graphs/self-review.json                        # match: true, 0 model calls
```

**`fallback` is STATELESS SUBSTITUTION, not a circuit breaker** — there is no breaker in this system
and there is not going to be one (`packages/core/src/journal/store.ts`'s header says why). A chain
enters tier 0 on every call, so a primary that is down costs the failed call on **every turn,
forever**: the runs succeed and the box is slower and poorer than it looks; `loom serve` says so on
stderr once when it starts and once when it stops. A `policy`-class code (`E_CONTENT_FILTERED`) in a
`when` list is refused at construction — retrying a content filter elsewhere is evasion.

**Set `defaultMaxTokens` generously.** Measured on GLM-5.2, roughly 17 reasoning tokens per content
token; at 4,096 it never reached content and every review came back empty (`TODO.md` §A0).

## 7 · An extension module — a wire the binary does not speak

`extensions/bedrock-converse.mjs` answers "my provider is not on the OpenAI wire". It imports
nothing from `@loom/core`: `loom` hands its default export a registrar —
`{models, tools, channels, identity, functions, hooks, resolver, store, payloads, jail}` — before
any configuration is read. `packages/core/test/cli/extension-module.test.ts` drives it.

```bash
# models.json: a routes row naming the module's adapter, and NO "adapters" block at all
loom run graphs/self-review.json --models-file models.json \
     --extension-module examples/extensions/bedrock-converse.mjs
```

The missing `"adapters"` block is the point: `provider` is a closed set of `anthropic` and `openai`,
and a module-registered adapter is a legal `routes` target without being one of them.

**A module named on argv is trusted like the binary itself** — unsandboxed, with your filesystem,
network and environment. That is why `--extension-module` is argv and *nothing else*: a path read
out of a file would let a file decide what code a process holding `fs:write` runs.

Everything can still refuse: a module that does not resolve, throws while loading, has no function
default export, throws while registering, or **registers nothing** stops the boot naming the path —
one that silently did nothing is a deployment you believe is extended and is not. So does a name
colliding with a `--models-file` adapter row, a built-in tool, or the reserved `mcp__` prefix.

## 8 · `triage-failures` — a chore, ported

A red CI run left you a dozen shards of test-runner output. This graph buckets every failing test
by ROOT CAUSE, ranks the buckets, and asks you before it writes the report.

```
  scan ──seq──▶ plan ──fanout(over: shards, as: shard)──▶ read ──seq──▶ classify ──join──▶ gather
                                                            └──────────join─────────────────┘
  gather ──seq──▶ collate ──seq──▶ approve (human gate) ──seq──▶ write
```

```bash
loom compile graphs/triage-failures.json                                  # ok, exit 0
loom run     graphs/triage-failures.json --input '{"pattern":"reports/*.txt"}'
# → "status": "awaiting_gate", and out/triage.md does NOT exist yet.      exit 0
#   STDOUT IS THE JSON OBJECT AND NOTHING ELSE, so `… 2>/dev/null | jq .status` works on this
#   path too. The line telling you how to answer the gate is on STDERR, beside the run-id hint:
#   gate gate_01M… on node approve — loom approve 01M… gate_01M… --as YOUR_ID

loom gates   <runId>       # the gate's coordinates AND `reads`: the report it is holding
loom approve <runId> <gateId> --as u:you                                  # exit 0
cat out/triage.md          # 8 failing tests, 5 buckets, ranked
loom replay <runId>        # {"match": true, "hermetic": true}
loom trace  <runId>        # three `read` branches side by side, then the gate
```

**Why this one is a `function` body and not an `agent` node.** A failing test's root cause is read
off its error signature: `ERR_MODULE_NOT_FOUND` is a missing dependency and nothing else,
`EADDRINUSE` is a port still held and nothing else. §5 runs offline and *means* nothing offline;
this one runs offline and means what it says, because there was never a model in it.

**Three things this section exists to save you.**

- **A fan-out branch may hold more than one node, and every node in it needs its own `join`
  edge.** `read` (a `tool`) hands `raw` to `classify` (a `function`) over a `seq` edge, so BOTH
  are in `join.branches` and BOTH have a `"kind": "join"` edge into `gather`. Collecting only
  `classify` is `GRAPH021_FANOUT_WITHOUT_JOIN` on the fan-out's own target, and **that one
  diagnostic now says the whole rule** — it names the nodes the branch holds and asks for both an
  entry in `branches` AND a `kind: join` edge for each one the join must wait on. Following it
  literally compiles clean. It used to take two compiles, the second (`GRAPH008_BRANCH_NOT_CONNECTED`)
  supplying the half the first omitted; that was F1 of the 2026-09-09 port and it closed at
  `51f4a5f`.
- **A channel a fan-out node writes may be `replace` when NOTHING outside its branch touches it.**
  `raw` is `{"type":"string","reduce":"replace"}` and compiles, because `GRAPH010` exempts a
  channel written by the fan-out's own target and read only by nodes behind it in the same branch
  — a branch really does see only its own contribution. The exemption is narrow and everything it
  cannot prove is refused: move `raw` into `collate`'s `reads` (past the join), name it in a
  `${…}` tool argument, let a second node write it, put a `router`, a `subgraph`, a nested
  fan-out, a `retry` or a loop in the branch, or give `gather` any `mode` but `"all"`, and the
  compiler goes back to `GRAPH010_CONCURRENT_WRITE`. `counts` in §1 is one of those: `gather` and
  `summarise` both read it after the join, so it needs `append_ordered`.
- **`loom gates <runId>` shows the report, beside the `contentDigest`.** Its `reads` field is the
  gate node's declared channels **that have a value** — `{"report": {…}}` here, since `approve`
  declares `"reads": ["report"]` — recomputed from the graph the journal's hash names. A declared
  channel nothing has written yet is simply not a key, exactly as `view.visible` does not carry it;
  read `reads` as "what the approver is being shown", not as the node's declaration. The digest
  stays and is a different thing: a BINDING to what the approver was shown, which `loom approve`
  re-derives and checks, not a summary anybody could read. A channel the graph classified
  (`secret_ref`) prints as `[secret]` rather than in the clear; nothing in §8 is classified, so its
  report prints whole. **Classification is not the only door, and this sentence used to claim it was.**
  A KEY NAME redacts too, whatever the channel declares — `security/redact.ts`'s `isSecretishKey`,
  "belt and braces for hand-built payloads" as its own comment puts it — and no graph opts into that.
  §9's report shows what it costs in both directions: its `hardened.env.DB_PASSWORD` prints `[secret]`
  although by then it holds a harmless `{"secretRef":…}`, and so does its `secrets` list, which holds
  only NAMES — while a field called `was` carried the live credential in the clear until §9's own
  bodies stopped putting it there. Read "prints whole" as "prints whole unless a key is NAMED like a
  secret"; F13 of `docs/workflow-port-2026-09-22.md` has the measurement.
  `reads` is best-effort and simply ABSENT, with a line on stderr naming the
  gates and the reason, wherever it cannot be recomputed: no compile on record, a graph search that
  fails or finds no graph carrying that hash, no such node or task (what a run MUTATED after it
  started produces), and a gate MIRRORING one in a delegated child run — where the question is
  about the child's channels, so printing the parent's would label the wrong values as the content.
  Absence is not "this gate reads nothing".
  **Two things beside absence, both answered on the ROW rather than by the value's shape.** A value
  over 64 KiB is cut and marked `{"$truncated":{bytes,shown,head}}`, and `readsTruncated` names
  exactly which channels this door cut (`--max-bytes` is the dial). And for a gate INSIDE a fan-out
  branch, `readsMayBeStale` names the channels an earlier node on the gate's own branch has already
  written: a fan-out holds a branch's writes until its join folds them, so what prints here is a
  pre-branch value — or nothing at all, where the held write was the channel's first — while the
  `contentDigest` beside it, and the approval itself, are over the OVERLAID value. `approve` in
  this graph sits after the join, so neither applies to it; both do to any gate you put in a
  branch. (`TODO.md` §A.58, §A.60.)
  `loom serve`, then `GET /runs/<runId>` → `channels.report`, is still the fuller view and is what
  the console renders.

`reports/` holds three shards of real-shaped `node --test` TAP output — 8 failing tests over 5
causes, one of them (`missing-dependency`) spanning two files, which is the case a per-file reading
of the log hides.

**It refuses FOUR times, and every one is the same defect wearing a different hat**: evidence going
missing from a document a person is about to approve, with nothing saying so.

- **Nothing matched** would fan out zero branches and report "0 failing tests" — indistinguishable
  from a green suite.
- **More shards than the fan-out's `maxWidth`** would silently CLAMP: 30 shards at a width of 24
  runs 24 branches and says nothing about the other six.
- **A truncated listing.** `fs.glob` caps at 100 paths and says so in a final `… ` line; triaging
  the 100 and dropping the marker is the clamp one layer up, and the width check cannot see it.
- **No readable fan-out width**, which is the fail-closed arm of the read below.

Each returns `{refuse: {reason}}`, so the run fails as `validation`/`E_FUNCTION_REFUSED` — the class
that says the graph declined, not the `E_INTERNAL` a crash in the body wears — and each names the
numbers it saw. **The cap is not written in the body**: it reads `ctx.node.out` (§2) for the `fanout`
edges over `shards`, takes the SMALLEST `maxWidth` of them and names that edge, so
`graphs/triage-failures.json` is the number's only home and raising it is one edit.
`packages/core/test/examples-triage.test.ts` drives all four arms, and pins the read by EDITING the
graph's width and requiring the refusal to name the new number.

**Split your shards on `/\r?\n/`, not on `"\n"`, in any body you write like this one.** Every
pattern in `triage-classify.js` is anchored, `.` excludes `\r`, and `$` without `/m` matches only
the true end of the string — so the first draft read a CRLF shard as completely clean and the run
SUCCEEDED. That is a triage tool telling you a red suite is green, and it is the single worst thing
this example could do.

## 9 · `harden-config` — a convergence loop, ported

A service manifest that has been in production for two years pulls `:latest`, runs as root, keeps a
database password in `env`, logs at `debug`, and has no healthcheck. This graph fixes ONE finding per
pass, **re-audits after every pass**, and asks you before it writes either the hardened manifest or
the report explaining it.

```
  load ──seq──▶ parse ──seq──▶ audit ──conditional(!settled && len(applied) < 12)──▶ fix
                                 ▲                                                   │
                                 └──────── loop(until: settled, maxIterations: 16) ───┘

  audit ──conditional(settled || len(applied) >= 12)──▶ collate ──seq──▶ review (human gate)
  review ──seq──▶ write-manifest ──seq──▶ write-report
```

```bash
loom compile graphs/harden-config.json                                    # ok, no diagnostics, exit 0 (3 warnings before §A.84)
loom run     graphs/harden-config.json --input '{"manifestPath":"manifests/orders-api.json"}'
# → "status": "awaiting_gate", and out/ does NOT exist yet.               exit 0
loom trace   <runId>       # nine `audit` and eight `fix`, alternating
loom gates   <runId>       # the gate's coordinates AND `reads.report`: the whole fix log
loom approve <runId> <gateId> --as u:you                                  # exit 0
cat out/harden-report.md   # 8 fixes over 8 passes, 3 of them cascades, 0 still open
cat out/service.hardened.json
loom replay  <runId>       # {"match": true, "hermetic": true}
```

**Why the loop is the workflow and not decoration.** Three of the eight fixes close a finding that
DID NOT EXIST when the run started, because an earlier fix created it: pinning the floating tag makes
`pullPolicy: "Always"` a pointless pull on every restart, dropping root makes a `/root/...` workdir
unreadable by the process living in it, and moving a password behind a `secretRef` obliges the
manifest to declare that secret or the deploy fails at admission. **A one-pass fixer ships a manifest
that does not deploy.** `applied` is `append_ordered` and accumulates one entry per pass, so the
person at the gate sees the whole chain in the order it was decided — which is the `replace`/`append`
pair this graph is built on: `current` is where the manifest got to, `applied` is how.

**Two things in that report are MEASURED and were not, which is the correction worth copying into any
workflow shaped like this.** `cascades` is counted against `baseline` — the FIRST audit's own finding
list, which `audit` writes once and `report.startedWith` states — and not against the rule table's
static `cascadeOf` field. The two differ exactly when a manifest's first audit already holds a
cascade-rule finding, and **the graph's own output is such a manifest** (a budget stop leaves
`secret-not-declared` open), so re-hardening it used to print "2 of those 2 fix(es) closed a finding
that DID NOT EXIST when the run started" about findings that were in the very first audit. And `open`
lists EVERY undeclared secret rather than the first: reporting one per pass is right for the FIXER,
which applies one finding per pass, and wrong for the REPORT, where it said "Still open — 1" on a
manifest with two — a person adds that secret, ships, and the deploy still fails at admission on the
other. Both are F14 of `docs/workflow-port-2026-09-22.md` — its **#1** and **#2** of six — both were
found by a reviewer after the suite was green, and both now have a test verified to fail without its
fix. **F14 is worth reading before you write a report of your own**: all six members are one sentence,
*the report asserted something the run had not established*, and two of them are corrections to the
paragraph that corrected the one before.

**`settled` means "no AUTO-FIXABLE finding remains", not "no finding remains".** `manifests/payments-worker.json`
declares no port, so a missing healthcheck has no probe target to invent; it is reported, it is
`autofixable: false`, and it does not stop the loop settling. The other definition spins to the pass
budget on every such manifest and then headlines the report with an exhausted budget instead of with
the one thing a person has to decide. When the budget IS what stopped it —
`manifests/legacy-gateway.json`, seven inline credentials and fourteen fixes against a budget of
twelve — `report.stoppedBy` is `"budget"` and the report says *"this manifest is better, not done"*,
because a budget stop parks on a gate and exits 0 exactly like a converged one.

**Six things this section exists to save you**, because nothing else in this workspace has a `loop`
edge in it and `docs/workflow-port-2026-09-22.md` is the fourteen things it cost to find them.

- **The loop's target needs a NON-loop inbound edge, or it is an entry node and runs at t=0.**
  `graph/spec.ts` states the rule — *"ENTRY NODES are nodes with no inbound non-`loop` edge"* — and
  nothing enforces it for a loop body: the graph compiles, and `fix` runs beside `parse` before
  anything has written what it reads, failing `E_CHANNEL_UNDECLARED` under class `internal`. That is
  why `fix` is entered by the `repair` **conditional** and the back-edge runs `fix → audit`.
- **`until` is evaluated on the scope of the node the loop edge LEAVES, with that node's own writes
  overlaid RAW.** So a channel the loop's source writes reads as its one-element CONTRIBUTION there,
  not as the accumulated channel: `until: "len(applied) >= 12"` on the `recheck` edge is a bound that
  can never fire, measured. The pass budget therefore lives on the two `conditional` edges out of
  `audit`, where `audit` does not write `applied`, and the `until` on `recheck` is a formality the
  compiler requires (`GRAPH006_NO_STOP_RULE`).
- **The stop rule has TWO homes that must agree, and nothing checks that they do.** `repair`'s
  `when` and `done`'s `when` are exact complements by construction. Narrow one alone and the graph
  still compiles; at run time `audit` reaches a state where neither is true, takes no edge, and the
  run fails `internal`/`E_OUTPUT_MISSING` — naming neither the loop nor the node that stopped. A body
  cannot read either expression: `ctx.node.out` (§2) carries an edge's `maxIterations` and not its
  `until`, and carries nothing at all for a `conditional`'s `when`.
- **A channel written BEFORE the loop and INSIDE it is `GRAPH010_CONCURRENT_WRITE`**, because the
  concurrency analysis drops `loop` edges and the loop body then has no ancestors. That is why
  `fix` writes only the log and `audit` FOLDS it over the seed to get `current`: one writer per
  channel, and the fix log is the state with the manifest as its projection. Changing the reducer
  instead — the first half of that diagnostic's own `fix:` line — compiles and then meets the
  entry-node bullet above.
- **The bound has a THIRD home and it is `maxIterations`.** `recheck` carries 16 while the budget is
  12, and the ordering is load-bearing: "tidy" it to 12 and the graph compiles at exit 0,
  `orders-api.json` (8 passes) still works, and `legacy-gateway.json` — which needs all twelve —
  strands with the same `E_OUTPUT_MISSING` that names neither bound. Two bounds on one thing,
  enforced by two layers, checked by nothing.
- **Three warnings on every command were wrong about the REASON and right about a HAZARD — they are
  GONE now, and the hazards are not.** `GRAPH002_DEAD_END` on `fix` (which has a `loop` edge out of
  it) and `GRAPH005_UNPRODUCED_READ` twice for `applied` (which `fix` writes, upstream over that
  same `loop` edge): one mechanism, the compiler dropping the back-edge, and **§A.84 closed it**, so
  `loom compile graphs/harden-config.json` now prints no diagnostic at all. That was measured here
  rather than assumed — this graph's three were the ONLY change across the seven graphs' compile
  output. **Do not read the silence as "there was nothing there", which is the mirror of the mistake
  this section's first draft made in the other direction**: `applied` really has no value on the
  first pass, `collate` really reads an unproduced `applied` on an already-compliant manifest (`fix`
  never runs), and `fix` really is a dead end whenever `maxIterations` binds before the budget. The
  `view.get(c) || []` in all four bodies is what defends against those, and it is still load-bearing
  with the warnings gone. Following either old `fix:` line would have made the graph worse —
  `add "applied" to inputs:` invites a caller to supply a fix log the graph is supposed to build.

`manifests/` holds **eleven** inputs and only one of them converges cleanly — the rest each pin one way
this workflow can be wrong:

| manifest | what it is for |
|---|---|
| `orders-api.json` | converges in eight passes, three of them cascades |
| `payments-worker.json` | settles with one UNREPAIRABLE finding open (no port, so no probe target) |
| `legacy-gateway.json` | exhausts the pass budget, and leaves TWO undeclared secrets open |
| `mixed-secrets.json` | a cascade whose RULE is already in the baseline for another secret |
| `unquoted-credentials.json` | `"DB_PASSWORD": 90210` — a credential the rule must still report |
| `floating-release.json` | `release: "latest"` — a pin target that is not a pin |
| `dotted-env-key.json` | an env key holding a `.`, which the `at` path language cannot address |
| `qualified-token.json` | `GITHUB.TOKEN` — a credential the RUNTIME's key-name redactor does not recognise |
| `unseparated-token.json` | `MYTOKEN: 987654321` — the same gap, with no separator and a non-string value |
| `no-image.json` | JSON that is not a service manifest |
| `not-a-manifest.txt` | not JSON at all |

**The last eight exist because a reviewer found the workflow wrong on each of them after the suite was
green.** That is the shape worth copying: **a fixture per way the report can lie**, not per feature. The
final two are the sharpest of the set — on them the report *said* "holds a credential in the clear" and
*printed* the credential three fields later, because this workflow's credential predicate is broader
than the platform's and the projection had been left to the platform. **A workflow that classifies its
own secrets must redact its own projection**; F13 has both regexes and the gap between them.

**All FOUR refusals in `harden-parse.js` are one defect wearing four hats, and it is §8's defect** —
the bytes are not JSON; the JSON parses but is not an OBJECT (`[1,2,3]`, or a manifest somebody wrapped
in an array); the object declares no `name`/`image`; and the read came back TRUNCATED (`fs.read` caps
at 200,000 characters unless the node says otherwise and marks the cut inside the content, so a big
manifest used to be reported as a syntax error; F12). The count was "three" in two places until the
members were enumerated — the not-an-object arm is the one that goes missing when you count from
memory.
Auditing is a search for ABSENCES — no pinned tag, no healthcheck, no declared secret — and a search
for absences run against a document nothing understood finds nothing and prints a clean bill of
health. Each returns `{refuse: {reason}}`, so the run fails as `validation`/`E_FUNCTION_REFUSED` —
the graph declined — rather than as the `internal`/`E_INTERNAL` a `JSON.parse` left to throw would
have worn. The third refusal, in `harden-fix.js`, is the one you should never reach: a repair that
leaves its own finding in place spins the loop to the budget, so it refuses where the rule that did
it can still be named.

**Hardening the hardened manifest applies ZERO fixes, and that is the check worth running on any
workflow shaped like this one.** It is the only end-to-end assertion that every detector in
`harden-audit.js` agrees with every repair in `harden-fix.js` — the rule table lives in two files,
because a code resource is a bare function expression and cannot import a sibling (§2) — and it
catches a disagreement without the test having to know which rule caused it.

**What comes back out of a channel is CANONICAL, and a document-rewriting workflow has to know
that.** `out/service.hardened.json` has its object keys in sorted order and the input's were not, so
`git diff` against the original is the whole file rather than the eight fixes. That is what makes a
state hash comparable across a replay and is not going to change; the consequence is that the fix
TABLE in the report is the diff, and the file is not.

## 10 · `grant-access` — a decision routed by how much human it needs, ported

Somebody asked for temporary access to a production resource. This graph decides the CEREMONY from
the resource's tier, the level asked for, the hours asked for and the requester's own history —
granted automatically, signed by a person first, or denied with the policy rule that said no — and
appends what it did to an access ledger.

```
  read-request ─seq─▶ read-policy ─seq─▶ look ─seq─▶ read-ledger ─seq──────▶ prior ─────┐
                                                          │                             ├─▶ weigh ─seq─▶ route
                                                          └─error(E_TOOL_SOURCE_UNAVAILABLE)─▶ first-grant ─┘
                                                                                                │
  route ─conditional(ceremony == "auto")───────────────────────────▶ record ─┬─seq─▶ write-grant
  route ─conditional(ceremony == "review")─▶ sign (human gate) ─seq─▶ ───────┘   └─seq─▶ write-ledger
  route ─fallbackEdge──────────────────────▶ deny (refuses)
```

```bash
rm -rf out .loom                                                          # the ledger lives in out/
loom compile graphs/grant-access.json                                     # ok, NO diagnostics, exit 0
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/orders-db-backfill.json"}'
# → "status": "awaiting_gate", and out/ does NOT exist yet.               exit 0
loom trace   <runId>       # read-ledger [error] inside a run that is [ok] — the error arm
loom gates   <runId>       # reads.decision: the rule, the tier, the cap, the owners, the reason
loom approve <runId> <gateId> --as u:you                                  # exit 0
cat out/grant.json && cat out/access-ledger.json
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/orders-db-backfill.json"}'
# → "status": "succeeded" with NO gate: the ledger now exists, so this is a RENEWAL   exit 0
loom replay  <runId>       # {"match": true, "hermetic": true}
```

**This is the only graph here with a `router` in it, and the only one with a `kind: "error"` edge.**
It is also the only one that uses a reducer other than `replace` and `append_ordered` — six of the
eight ship unexercised, and it uses `merge_object` because the compiler makes it, not by choice.

**The router has TWO `cases[]` and one `fallbackEdge`**, which is three destinations and not three
cases — a distinction that matters when you write one, because a case you forget falls through to
the fallback silently, and here the fallback is the arm that REFUSES.

**The three parts of a router that have to agree**, which is the step that costs people compiles:
`router.cases[].when` is an expression over the node's own `reads`; `cases[].take` and
`fallbackEdge` name **edge ids that leave this node** (`GRAPH005_ROUTE_NOT_OWN_EDGE` otherwise, and
it lists the ones that do); and a router **may not write** (`GRAPH005_ROUTER_WRITES` — move the
write into a `function` upstream). `mode` must be `"expression"`: `"model"` is declared in order to
be refused (`GRAPH005_ROUTER_MODE_UNSUPPORTED`). A router that matches no case takes its
`fallbackEdge` and never invents a target, which is why `deny` hangs off the fallback here rather
than off a third case — a ceremony nobody wrote an arm for must decline, not pick the nearest arm.

**A node reached by several exclusive arms runs ONCE, on whichever arm fired.** `record` sits behind
both `granted` (straight from the router) and `signed` (from the gate), and `weigh` sits behind both
`prior` and `first-grant`. Nothing in this workspace demonstrated that before, and it is the shape
every router tree needs.

**An `error` edge is selected by a FAILURE, not by a choice.** It cannot appear in a `take` — a
router naming one is `E_ROUTE_INVALID` — and `codes` narrows it to named normalized error codes.
Here `read-ledger` reads a file that need not exist: the ledger is read at the start of the run and
written at the end, so the two arms are the FIRST run of this command and every later one, and you
flip between them by running it twice. **`loom trace` shows `read-ledger [error]` inside a run whose
own status is `[ok]`**, which no other example can show you.

**A tool node whose failure you HANDLE does not need `unhandled: true`.** That flag suppresses
`GRAPH011_UNHANDLED_IRREVERSIBLE`, which fires only for a tool whose class is `irreversible` or
`externally_visible`; `fs.write` is `reversible_write`, so it is not one, and neither this graph nor
§8 nor §9 sets the flag. `/usr/bin/grep -al 'unhandled' graphs/*.json` matches exactly two files —
§3's `guarded-write.json` and `two-person-approval.json` — where it buys nothing today and is left
alone.

**Two things this graph measured that are worth knowing before you build one like it.**

- **`GRAPH010_CONCURRENT_WRITE` refuses the obvious error-handling shape.** `prior` and
  `first-grant` are the `seq` and `error` targets of one node and no run can take both — but the
  concurrency analysis does not know that an `error` edge and a `seq` edge out of the same node are
  exclusive, so `history` may not be `replace`. It is `merge_object` here, and that is a workaround
  rather than a design. F1 of `docs/workflow-port-2026-09-22b.md`.
- **A failed run's already-landed `fs.write` is rolled back automatically, with no `compensation`
  edge anywhere in the graph.** `fs.write` declares `compensation: {tool: "fs.restore"}`, so when
  `write-ledger` fails after `write-grant` succeeded the engine undoes the grant write and
  `loom trace` prints `loom.tool (compensate) [ok]` under it. Measured: `out/grant.json` came back
  byte-identical to before the failed run. A `compensation` edge is a DECLARATION the compiler
  proves (`GRAPH012`) and never a route — it is not what makes rollback happen.

**An error arm is handed NO REASON, and `look` is what this example pays to survive it.** The failed
node writes nothing, no channel carries the code or the message, and `codes` narrows by class where
a missing file, an unreadable file AND a path the sandbox refuses are all
`E_TOOL_SOURCE_UNAVAILABLE`. So `first-grant` cannot tell "there is no ledger yet" from "the ledger
is there and I could not read it" — and undefended, `chmod 222 out/access-ledger.json` made the run
report `succeeded` and REPLACE the ledger, destroying a prior grant.

**The defence is a second tool asking the same question, and it covers ONE of the four ways this
read can fail.** `fs.glob` lists a file `fs.read` cannot open, so the `look` node runs it over the
ledger's path and `weigh` refuses when the listing is non-empty and the history came from the error
arm. **Covered: a regular file that is listable but not readable.** Three cases are UNCOVERED BY THE
DEFENCE, each measured — an unlistable parent directory (`chmod 333 out`), an escaping symlink at
the path, and a directory at the path. All three make `fs.glob` answer `(no matches)`, which is its
answer for "there is nothing here" as well, so **the defence answers its own undecidable case with
the passing value exactly as the arm does**: a guard that fails open standing in for a guard that
fails open. **They do not end alike, and that distinction is the dangerous part: only the unlistable
parent destroys the ledger, and only it is silent** (the run succeeds, exit 0). The other two fail
the run CLOSED for an unrelated reason — the write meets the same obstruction the read did, so they
end `unavailable`/`E_TOOL_SOURCE_UNAVAILABLE` with the ledger intact. Four glob patterns were measured and none distinguishes
"empty" from "cannot enumerate", so no arrangement of read-only tools closes this — only the product
gap does. **It answers "does the file exist", not "why did the read fail".** Its one safe-by-
construction property is that its TOCTOU window loses in the failing-CLOSED direction.
F5 of `docs/workflow-port-2026-09-22b.md` has the four-pattern table;
`packages/core/test/examples-grant.test.ts` pins the defence in both directions — a defence that
also fired on the ordinary first run would make the command's first use impossible — **and pins the
`chmod 333` hole NEGATIVELY, as a test asserting today's loss, so it cannot stop existing quietly.**

**A renewal skips the person, so it is bounded three ways**, all in `grant-weigh.js`'s
`findRenewal`, and each has its own test with a control: only a `decidedByKind: "human"` grant
starts a window (an auto-renewal must not restart the clock, or one approval becomes indefinite
access); a renewal may widen neither the level nor the hours (a human who approved `write/4h` has
not approved `write/24h`, and 24h is inside the policy's cap so the cap does not catch it); and it
must be inside the window measured from the prior grant's own `grantedAt`.

**`policy.levels`' ARRAY ORDER is the privilege lattice and nothing validates it.** A level is
ranked by its index, so that array is what says `read < write < admin`. Reordering it to
`["admin","read","write"]` does not reorder a list — it makes a prior `read` outrank a requested
`admin`, and an auto-renewal could widen into admin. `access/policy.json`'s own `note` says so,
because it is a privilege decision that does not look like one.

**Why this is a `function` body and not an `agent` node**, the same argument §8 and §9 make: every
term is read off rather than inferred — the tier is a lookup, the cap is a lookup, the level is an
index into a declared list, and a renewal is a date comparison. The judgement worth a model is
whether the stated REASON justifies the access, and this graph deliberately does not pretend to do
it: it puts the reason in front of the person at the gate.

`access/policy.json` holds three resources at three tiers, and `access/requests/` holds thirteen
files — twelve JSON requests, one per arm of the decision and per refusal, and one that is not JSON
at all. **Three of the thirteen the graph REFUSES rather than denies**, because "we decided, and the
answer is no" and "we could not decide" are different sentences to a requester — and they are
different CLASSES too, which a script wrapping this needs: a denial and a refusal are both
`validation`/`E_FUNCTION_REFUSED` and differ only by the node named in the message (F7), while a
request file that is not there is `unavailable`/`E_TOOL_SOURCE_UNAVAILABLE` at the tool, because
only `read-ledger` has an error arm.
`packages/core/test/examples-grant.test.ts` drives all of them.
