# examples

**This directory is a Loom workspace.** Copy it somewhere, or run in place — a workspace is a
directory with `graphs/` and `resources/` in it. Loom reads nothing else; `bench-cases.json` at
the root here is not a workspace file, it is §5's input, and it sits beside them the way any data
file you feed a run would.

```bash
npm install && npm run build:binary   # → bin/loom
export PATH="$PWD/bin:$PATH"
cd examples
```

**Four graphs, and they do not all run the same way.** This paragraph used to say "everything here
runs offline" and "both graphs", and both halves were wrong — there are four, and two of them have
an `agent` node:

| graph | §  | needs a model? |
|---|---|---|
| `graphs/fan-out-join.json` | 1 | **no.** `function` nodes only; measured, `loom run` writes not one byte to stderr |
| `graphs/guarded-write.json` | 3 | **no.** one `tool` node and a `preTool` hook; same, zero bytes of stderr |
| `graphs/review-bench.json` | 5 | **runs offline, means nothing offline** — see below |
| `graphs/self-review.json` | 6 | **yes.** it is here because it is the workflow this project ported first |

Without `--models-file`, the only registered adapter is the offline mock and `loom run` says so
on stderr before it starts. §§1–4 need no key, no network and no adapter at all.

`packages/core/test/examples-run.test.ts` drives this directory through the real CLI. It COMPILES
every graph in `graphs/` — the set is the directory, so a graph added later is covered without
editing the test — and RUNS the two that need no model, asserting the outputs printed below.
§§5–6 are compiled and not run there, because a run of either against the mock asserts nothing
about a reviewer. An example nobody runs is documentation that is wrong within a month.

---

## 1 · Fan-out → join

`graphs/fan-out-join.json` — the shape the README leads with. One node splits a document, a
`fanout` edge spreads one branch per piece, a `join` folds them back in **branch order**, and a
last node reduces the fold.

```bash
loom compile graphs/fan-out-join.json
# ok

loom run graphs/fan-out-join.json --input '{"document":"alpha beta\ngamma\n\ndelta epsilon zeta"}'
```

```json
{
  "runId": "01M0WH0136ZXJ1WM40ARRNV58E",
  "status": "succeeded",
  "outputs": {
    "report": {
      "at": 1787663746157,
      "lines": 3,
      "order": ["alpha beta", "gamma", "delta epsilon zeta"],
      "words": 6
    }
  },
  "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0, "wallMs": 0 }
}
```

`runId` and `at` differ per run. `report.lines`, `report.words` and `report.order` are what the
test pins — `order` is the interesting one: it is the order the fan-out laid the branches out
in, not the order they finished.

```bash
loom replay <runId> --graph graphs/fan-out-join.json
# {"match": true, "hermetic": true}
```

`at` is recomputed, not replayed from a recording: `ctx.now()` is the task's journaled lease
timestamp, so folding the same journal gives the same number.

### The three parts that have to agree

```
      plan ──fanout(over: chunks, as: chunk)──▶ count ──join──▶ gather ──seq──▶ summarise
```

1. **The fan-out edge** names the array it spreads and the channel each branch reads its own
   element from: `{"kind":"fanout","over":"chunks","as":"chunk","maxWidth":8}`. `maxWidth` is a
   ceiling on branches, and `policy.expansion.maxFanout` is the ceiling on `maxWidth`.
2. **The join node** lists its arms in `join.branches`, which are *node ids*, not edge ids.
3. **The edge from an arm into the join must be `"kind": "join"`.** This is the step that costs
   people compiles. Measured: change `collect` to `"kind":"seq"` and the graph is refused with
   `GRAPH008_HELD_JOIN_UNCOLLECTED`, because a `seq` edge leaves `gather` *inside* the fan-out,
   where a join holds its fold for an enclosing join that does not exist. Drop the edge entirely
   and it is `GRAPH008_BRANCH_NOT_CONNECTED`, whose fix names the kind:
   `add an edge count -> gather with kind: join`.

A channel written by parallel branches needs a reducer that survives concurrent writers:
`counts` is `append_ordered`. Give it `replace` and the compiler refuses with
`GRAPH010_CONCURRENT_WRITE` rather than letting arrival order decide the answer.

## 2 · A `function` body — `resources/function/*.js`

`plan.js`, `count.js` and `summarise.js` are §1's; `review-plan.js` and `review-collate.js` are
§6's; `bench-fan.js`, `bench-collate.js` and `bench-check.js` are §5's. A file in
`resources/<kind>/` publishes
`<kind>/<basename>@stable`, so `resources/function/count.js` is what
`"function": {"ref": "function/count@stable"}` resolves to. The extension is not part of the
ref.

**The file is a bare function expression.** No `module.exports`, no `export default`, no
wrapper — the loader evaluates `(<the file>)` and keeps the value:

```js
function (view, ctx) {
  return { writes: { counts: [ /* … */ ] } };
}
```

`(view, ctx) => ({…})` is equally valid — measured, an arrow-form `count.js` runs. A file
starting `module.exports = function (…) {…};` is **not**: it fails as `Unexpected token ';'`, and
the loader then says the rule you broke rather than leaving you with the character. See §4, which
is that transcript, and which is the same rule for hooks. A body that fails to load is a
**compile error** for the graph that names it — refused before a run id is minted, not
discovered halfway through one.

What the body gets: `view.require(c)` / `view.get(c)` / `view.visible` for the channels the node
declared, and `ctx.taskId`, `ctx.now()`, `ctx.signal`. What it does not get: `Date`, `Intl`,
`fetch`, `require`, `process`. `Math.random()` works and is seeded from a journaled draw, so a
replay draws the identical stream.

**`ctx.effects` is present but refuses inside a sandboxed body.** A node declaring
`"effects": ["fs.write"]` puts a stub for each name on `ctx.effects`; calling it from a body
loaded out of `resources/function/` throws `E_EFFECT_UNAVAILABLE` — the body runs synchronously
inside a `vm` and cannot await a host round trip. Put the call on a `tool` node (example 3), or
register the body in-process with `FunctionRegistry.register`, which is the path that gets a
live `ctx.effects`.

## 3 · A `hook` body — `resources/hook/no-secrets.js`

`graphs/guarded-write.json` is one `tool` node and this in the spec:

```json
"hooks": { "preTool": ["hook/no-secrets@stable"] }
```

The hook sees `{tool, args}` before every tool call and may block it or rewrite its arguments.

```bash
loom run graphs/guarded-write.json --input '{"note":"remember to water the plants"}'
# → "status": "succeeded", "written": {"bytes": 28, "path": "notes/note.txt"}
cat notes/note.txt
# remember to water the plants

loom run graphs/guarded-write.json --input '{"note":"token sk-live-42"}'
# → "status": "failed", exit 1, and nothing reaches the disk:
#   E_TOOL_SOURCE_UNAVAILABLE: "fs.write" was blocked before dispatch: the body looks like it
#   carries a credential, so it is not going to disk
```

Same file shape as a `function` body — **a bare function expression** — and the same realm.
Differences worth knowing:

- The signature is `(input, ctx)`, and what `input` is depends on the point: `preTool` gets
  `{tool, args}`, `preNode` gets `{}` (branch on `ctx.taskId`, which is `nodeId@branch#iteration`).
  `ctx` is `{point, runId, taskId, signal}` and nothing more.
- **A filter may only narrow.** Block a call, rewrite arguments, exclude an approver. There is
  no field for granting a capability or lowering a posture, so there is no way to ask.
- **`Math.random()` throws in a hook.** A hook fires at eight points, one of them run-scoped
  with no Task to key a journaled draw under, so there is no seed to serve draws from on replay.
  Do the draw in a `function` node.
- A declared hook the workspace does not publish is a **compile error**, not a silent skip.

## 4 · The mistake this directory exists to prevent

```bash
printf 'module.exports = function (input, ctx) { return {}; };\n' > resources/hook/no-secrets.js
loom compile graphs/guarded-write.json
```

```
! skipping hook/no-secrets@stable in …/resources/hook: hook resource "hook/no-secrets@stable"
  did not evaluate: Unexpected token ';' — a code resource file is a BARE FUNCTION EXPRESSION
  and nothing else. The loader evaluates (<the whole file>), so its value IS the function:
  (view, ctx) => {…} for a function body, (input, ctx) => {…} for a hook body. module.exports,
  export default and any top-level statement are errors before the body ever runs — the file is
  EVALUATED, not imported
E_RESOURCE_NOT_FOUND: this graph declares 1 hook(s) this workspace does not publish
  (preTool: hook/no-secrets@stable). …
```

**The same mistake in a `function` file is refused the same way, and that is newer than it
looks.** Until recently it printed the `! skipping` line and then `ok` with exit 0, and only
failed later, inside a run:

```bash
printf 'module.exports = function (view, ctx) { return {}; };\n' > resources/function/count.js
loom compile graphs/fan-out-join.json
# ! skipping function/count@stable in …: … BARE FUNCTION EXPRESSION …
# E_RESOURCE_NOT_FOUND: this graph declares 1 function body(s) this workspace does not publish
#   or could not load (count: function/count@stable). …
# exit 1
```

`git checkout examples/resources/` to put either back.

## 5 · `review-bench` — a benchmark whose answer is known

`graphs/review-bench.json` with `bench-cases.json` as its input. Six small diffs, three carrying a
defect this codebase actually had and three clean. It fans one `agent` review per case, joins,
collates, and hands the fold to an **`assertion` evaluator** — `resources/function/bench-check.js`
— which compares what the reviewer said against the planted truth and answers with a number.

```bash
loom run graphs/review-bench.json --input "$(cat bench-cases.json)"
```

This is the one graph that RUNS offline and MEANS nothing offline. Driven just now with no
`--models-file`, so every `agent` node got canned text from the mock:

```json
{ "verdict": { "hit": 0, "miss": 3, "correctClean": 3, "falseAlarm": 0,
               "score": 0.5, "pass": false,
               "detail": ["fail-open-fold: MISSED", "default-stop: MISSED",
                          "clear-all-actions: MISSED", "rename-local: correctly clean",
                          "widen-comment: correctly clean", "add-const: correctly clean"] } }
```

Exit 0, `"status": "succeeded"`. A reviewer that says nothing about anything clears every clean
diff and misses every defect, which scores 0.5 — so **a passing exit code is not the signal here,
`verdict` is.** Point it at a real model the way §6 does and the number moves: measured against a
live GLM-5.2, three hits, no misses, one false alarm.

Why it ships: it is the only example whose signal is GROUND TRUTH rather than an operator's
approval. `TODO.md` records what that was worth — an approval-driven score saturated at the top
because an operator approves nearly every report-generating run, and this one did not.

Its `agent` node names `agent_profile/reviewer@stable`, which this workspace does not publish, and
the graph still compiles. That is not an oversight: a profile is a ROUTING KEY that the
`--models-file` `routes` table maps to an adapter and a model, not a document anything reads.

## 6 · `self-review` — the one that needs a real model

§§1–3 need no adapter at all and §5 needs one to say anything. This one needs one to run: it ends
in a human gate and an irreversible write, and there is nothing to gate on canned text. It is here
because it is the workflow this project actually ported first, on 2026-08-25, against a live
GLM-5.2.

It reviews a diff: one `agent` node per changed file (fan-out), a `join`, a fold into a report, a
**human gate**, and then an irreversible `fs.write`. That is every node type the README claims,
in one graph.

```bash
# A provider. The key stays in the environment — never in the file.
export OPENAI_API_KEY=...            # your key
cat > models.json <<'JSON'
{ "adapters": [ { "provider": "openai", "name": "m", "baseUrl": "https://api.openai.com/v1",
                  "apiKeyEnv": "OPENAI_API_KEY", "defaultMaxTokens": 16000 } ],
  "routes": { "agent_profile/reviewer@stable": { "adapter": "m", "model": "gpt-5" } } }
JSON

git diff HEAD~1 > subject.diff
loom run graphs/self-review.json --models-file models.json \
     --input "$(node -e 'console.log(JSON.stringify({diff:require("fs").readFileSync("subject.diff","utf8")}))')" \
     --as u:you
# → status "awaiting_gate", and out/review.json does NOT exist yet
loom gates <runId>
loom approve <runId> <gateId> --as u:you --graph graphs/self-review.json
# → out/review.json now exists
loom replay <runId> --graph graphs/self-review.json     # match: true, zero model calls
```

**Set `defaultMaxTokens` generously.** A reasoning model spends most of its budget before it
writes anything: measured on GLM-5.2, roughly 17 reasoning tokens per content token. At 4,096 it
never reached content at all and every review came back empty — which is how
`TODO.md` §A0's truncation finding was discovered.
