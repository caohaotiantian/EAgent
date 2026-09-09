# examples

**This directory is a Loom workspace** — a directory with `graphs/` and `resources/` in it. Loom
reads nothing else; `bench-cases.json` at the root is not a workspace file, it is §5's input, and
`reports/` is not one either — it is §8's.

```bash
npm install && npm run build:binary   # → bin/loom
export PATH="$PWD/bin:$PATH"
cd examples
```

**Six graphs, and they do not all run the same way.** Without `--models-file` the only registered
adapter is the offline mock, and `loom run` says so on stderr before it starts.

| graph | § | needs a model? |
|---|---|---|
| `graphs/fan-out-join.json` | 1 | **no** — `function` nodes only |
| `graphs/guarded-write.json` | 3 | **no** — one `tool` node and a `preTool` hook |
| `graphs/two-person-approval.json` | — | **no**, and it does not run to completion: it parks on three human gates and waits for people. **Two-of-three approval lives in `join`, not in `approval`** — three `human_gate` nodes joined by `join{branches:[…], mode:"quorum", k:2}`; `approval.mode: "quorum"` was deleted and is now `GRAPH020_UNKNOWN_FIELD`. A short-circuiting join keeps its remaining branches running, so the third gate stays OPEN — a real gap, recorded in the graph's own `labels`. `packages/core/test/graph/two-person-approval.test.ts` drives it |
| `graphs/review-bench.json` | 5 | **runs offline, means nothing offline** — see §5 |
| `graphs/self-review.json` | 6 | **yes** — it is the workflow this project ported first |
| `graphs/triage-failures.json` | 8 | **no**, and it means something offline — the classification is read off an error signature, not inferred |

`packages/core/test/examples-run.test.ts` COMPILES every graph in `graphs/` — the set is the
directory, so a graph added later is covered without editing the test — and RUNS the three that
need no model, asserting §5's six verdict strings and its `3/6 assertions passed`. Only §6 is
compiled and not run there: it needs a real model, and there is nothing to gate on canned text.
§8 is compiled there and RUN by `packages/core/test/examples-triage.test.ts`, which is a separate
file because it needs `reports/` in the workspace copy and `examples-run.test.ts` deliberately
copies only `graphs/` and `resources/`.

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
`append_ordered`, and `replace` is refused as `GRAPH010_CONCURRENT_WRITE`.

## 2 · A `function` body — `resources/function/*.js`

A file in `resources/<kind>/` publishes `<kind>/<basename>@stable`, so `resources/function/count.js`
is what `"function": {"ref": "function/count@stable"}` resolves to; the extension is not part of the
ref. **The file is a bare function expression** — no `module.exports`, no `export default`, no
wrapper: the loader evaluates `(<the file>)` and keeps the value. `(view, ctx) => ({…})` is equally
valid; `module.exports = function (…) {…};` is not, and fails as in §4. A body that fails to load is
a **compile error** for the graph that names it, refused before a run id is minted.

The body gets `view.require(c)` / `view.get(c)` / `view.visible` for the channels the node declared,
plus `ctx.taskId`, `ctx.now()`, `ctx.signal` — not `Date`, `Intl`, `fetch`, `require` or `process`.
`Math.random()` works and is seeded from a journaled draw, so a replay draws the identical stream.
**`ctx.effects` is present but refuses inside a sandboxed body** (`E_EFFECT_UNAVAILABLE`): the body
runs synchronously inside a `vm` and cannot await a host round trip. Put the call on a `tool` node
(§3), or register the body with `FunctionRegistry.register`.

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
#   THE HINT IS ON STDOUT, AFTER THE JSON — `| jq` on this path fails on that line:
#   gate gate_01M… on node approve — loom approve 01M… gate_01M… --as YOUR_ID

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
  `classify` is `GRAPH021_FANOUT_WITHOUT_JOIN` on the fan-out's own target; adding `read` to
  `branches` without the edge is then `GRAPH008_BRANCH_NOT_CONNECTED`. Two compiles to find, and
  the second diagnostic is the one that says what to do.
- **A channel a fan-out node writes needs a multi-writer-safe reducer even when only its own
  branch reads it.** `raw` would be `{"type":"string","reduce":"replace"}` if `GRAPH010` could see
  that no other branch reads it; it cannot, so `raw` is `{"type":"array","reduce":"append_ordered"}`
  and `triage-classify.js` joins the one element back. Measured: a probe body printing `raw.length`
  prints `1` in every branch, each holding its own shard.
- **`loom gates <runId>` shows a `contentDigest`, not the report.** What the approver has to judge
  is on the control plane — `loom serve`, then `GET /runs/<runId>` → `channels.report`, which is
  also what the console renders. From the CLI alone, the report first appears in `loom approve`'s
  own output, after the decision.

`reports/` holds three shards of real-shaped `node --test` TAP output — 8 failing tests over 5
causes, one of them (`missing-dependency`) spanning two files, which is the case a per-file reading
of the log hides. A pattern that matches nothing FAILS the run rather than reporting a clean suite:
`triage-plan.js` throws, because "0 failures" and "you pointed me at the wrong directory" must not
look the same.
