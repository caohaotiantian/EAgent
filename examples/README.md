# examples

**This directory is a Loom workspace.** Copy it somewhere, or run in place — a workspace is a
directory with `graphs/` and `resources/` in it, and nothing else.

```bash
npm install && npm run build:binary   # → bin/loom
export PATH="$PWD/bin:$PATH"
cd examples
```

Everything here runs **offline**: no API key, no network, no model. Both graphs are built from
`function` and `tool` nodes, so nothing ever asks an adapter anything — measured, `loom run`
writes not one byte to stderr.

`packages/core/test/examples-run.test.ts` runs every example in this directory and asserts the
outputs below. An example nobody runs is documentation that is wrong within a month.

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

`plan.js`, `count.js`, `summarise.js`. A file in `resources/<kind>/` publishes
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
starting `module.exports = function (…) {…};` is **not**, and fails as `Unexpected token ';'`;
see §4, which is the same rule for hooks.

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
  did not evaluate: Unexpected token ';'
E_RESOURCE_NOT_FOUND: this graph declares 1 hook(s) this workspace does not publish
  (preTool: hook/no-secrets@stable). …
```

`git checkout examples/resources/hook/no-secrets.js` to put it back.

## 4 · `self-review` — the one that needs a real model

The other three examples run offline against a mock. This one does not, and it is here because it
is the workflow this project actually ported first, on 2026-08-25, against a live GLM-5.2.

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
