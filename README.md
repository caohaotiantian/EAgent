# Loom

A multi-agent runtime. You describe what you want done, it runs, and every durable fact about the
run is an append-only journal entry — so parallelism, human oversight, replay and observability are
one mechanism rather than four. The graph is the substrate, not the thing you have to write, and
**determinism is enforced by controlling the realm** — a PRNG seeded from a journaled draw, a clock
bound to a journaled task boundary, every effect declared and keyed — which is what lets the
workflow language stay ordinary TypeScript instead of WASM components or a DSL.

## Thirty seconds

```ts
import { agent } from "@loom/core";

const summarise = agent({ prompt: "Summarise the input in two sentences.", adapter: myAnthropicAdapter });

const result = await summarise.run("…text…");
console.log(result.status, result.output, result.usage.costUsd);

await summarise.replay(result.runId);   // re-runs from the journal. zero model calls.
```

That is a one-node graph on the full engine, which is where the replay comes from. And if you give
it a tool that changes the world, it **stops and asks** — the oversight floor comes from what the
tool *is*, not from configuration you remembered to add:

```ts
const pay = agent({
  prompt: "Charge the customer.",
  tools: ["pay.charge"],          // declared irreversible by its definition
  toolDefs: [charge],
  granted: ["pay:charge"],
  adapter: myAnthropicAdapter,
});

const r = await pay.run("take the payment");
r.status;      // "awaiting_gate"
r.openGates;   // one decision waiting — and the charge has NOT run
```

## When you outgrow one node

Reach for the graph: fan-out and branch-ordered joins, routers, bounded loops, human-gate nodes,
subgraphs, and `function` nodes that declare their own effects —
`function: { ref: "function/settle@stable", effects: ["pay.charge", "note.write"] }`. A declared
effect reaches the capability ceiling, the unknown-tool diagnostic and the oversight floor by the
same route a tool node's name travels: **declaring a capability and declaring a journaled effect
are one act**, which keeps "every nondeterministic call is journaled" a property of the schema
rather than a rule somebody has to remember.

## Or run it as a service

```bash
npm install && npm run build:binary   # → bin/loom, one file, 0 third-party modules
export PATH="$PWD/bin:$PATH"          # `loom` is not published; the binary IS the install
loom serve                            # console + API on :8787, from an empty directory
```

**`bin/loom` is a photograph of `packages/core/src`, and nothing rebuilds it for you** — one
machine, one operator, so the rebuild is a command you run. What stands in for a daemon is a
refusal: the binary re-hashes the sources beside it before any application code runs and exits
non-zero once they have moved, naming what changed (`LOOM_STALE_BINARY=allow` runs it anyway and
still prints the report; an installed copy with no sources beside it has nothing to be behind).
**So after editing `packages/core/src`, run `npm run build:binary` before trusting `bin/loom`.**
That refusal ships INSIDE the binary, so one built before it existed cannot report itself missing;
the check outside the artifact is `node scripts/verify-binary.mjs [path]`, driving a binary through
all four cases (current, stale, overridden, no-sources). CI runs it on `ubuntu-latest`.

**`@loom/core` is `private: true`, and `npm publish` does not REFUSE** — it exits 0 and quietly
does nothing, which a CI step checking only the exit code would report as a successful release. A
tarball installs and works: `npm pack packages/core`, install the tgz, and
`./node_modules/.bin/loom --help` runs in a fresh directory with no build.

## What works today

| | |
|---|---|
| **One-line agents** | `agent({prompt, tools})` compiling to a one-node graph, so the hello-world gets the journal, replay, gates and budget ceiling |
| **Graph compiler** | 22 validation rules, aggregated diagnostics with suggested fixes, resource pinning |
| **Executor** | Parallel fan-out, branch-ordered joins, bounded loops, retries. All eight node types run: tool, agent, router, join, human_gate, subgraph, function, evaluator |
| **Declared effects** | A `function` body invokes only the tools its node declared, through one dispatch path, each keyed by position in the call sequence |
| **Durability** | Append-only journal on `node:sqlite`. A run SUSPENDED on a human gate survives `kill -9` and resumes in another process |
| **Human oversight** | Three postures by configuration alone; gates are rows, so a suspended run holds zero worker slots. An approval binds the graph it was shown |
| **Replay** | Re-executes with every effect served from the journal — zero model calls, zero side effects |
| **Determinism** | Seeded `Math.random`, a clock bound to the task's journaled lease timestamp. Two reads of the time inside one body return the same instant |
| **Providers** | Anthropic + OpenAI over `fetch`+SSE, normalized error taxonomy, declarative fallback chains |
| **Console** | Ships inside the binary. Graph canvas, live SSE, approve/reject queue |
| **Gates** | `npm run check` — 2,300+ tests, offline, no API key; three guards: zero-dep, public surface (the exported NAME SET, in `scripts/surface.json`) and the kernel file list (`scripts/kernel.json`) |
| **Compensation edges** | Compile-time rollback proof, and a rollback that RUNS — on run failure and on rewind, reverse order, with three journaled outcomes (compensated / failed / never attempted). A rewind's undos run APPROVED, because `rewind` takes a human actor and refuses a plan hash that no longer matches what it would dispatch; a run's own failure does not, because no automated path may approve itself |
| **Tracing out** | Three doors, one encoder: `loom trace <runId>` renders the span tree, `--otlp <endpoint>` POSTs it to a collector, and `GET /runs/:id/trace` on a `loom serve` plane answers the same fold as JSON (or OTLP with `?format=otlp`). Hand-rolled, so the zero-dependency rule still holds. **The push takes its endpoint from argv and its credentials from `OTEL_EXPORTER_OTLP_HEADERS`**, never the reverse: no environment variable can make `loom trace` send, and a key passed as a flag is readable out of `ps`. A trace that follows subgraphs sends one request per run, each under its own `traceId`, which is what `SpanLink.traceId` is for |

## What does not work yet — stated because overstating costs its user a day

| | |
|---|---|
| **`retry` on a function or evaluator node** | **Works**, through the RETURN rather than a throw: a body returns `{ retry: { reason } }` and the engine raises `E_FUNCTION_UNAVAILABLE` on its behalf, which is retryable by class. A *throw* still cannot carry retryability — `isLoomError` is an `instanceof` against the host class and a guest object can never satisfy it, so every throw out of the `vm` is `E_INTERNAL` |
| **Reading the clock in a body** | **Reproducible.** `ctx.now()` is the task's journaled lease timestamp, so replay computes the same number with nothing new written, and time does not advance during a task. `Date` is still absent from the sandbox: a frozen `Date` that silently never advances is more surprising than one that is not there |
| **A barrier deadline** | **There is none, and declaring one is a compile ERROR** — `JoinNode.timeoutMs` was deleted, so `timeoutMs` inside a `join:` block is `GRAPH020_UNKNOWN_FIELD`. A barrier deadline's undecidable case has no journaled answer: a join sees only that a sibling has not committed, so it cannot tell a stranded branch from one correctly waiting on a human gate. Every branch already has a bound at its own locus — `NodeSpec.timeoutMs` for a node, `slaMs` + `onTimeout` for a gate. Still open: a node declaring NO `timeoutMs` hangs its task forever, so a join over such a branch waits forever |
| **Crash mid-effect** | The journal survives, the run clock picks a backed-off run up again, and a restarted process re-arms the SLA clock of every gate it re-attaches — but a Task killed mid-effect stays leased with no automatic reclaim. The path back is TWO requests on a `loom serve` plane: `GET /runs/:id/rewind-plan?atSeq=N` returns what the rewind would undo plus a `planHash`, and `POST /runs/:id/commands {"kind":"rewind","atSeq":N,"planHash":"…"}` performs it and re-arms the leases it undoes. **Sending the second without a `planHash` is a 400** — an operator authorizes a LIST, not a verb. **Both routes require a HUMAN caller**, so the plane needs `--identity-file` (or an `--extension-module` identity source): a rewind dispatches real-world undos and may suppress a `gate.decided` a person spent their judgement on. **`cancel` is NOT the substitute** — it stops the run without touching what it already did. **There is no `loom rewind` CLI verb**; `rewind` and `advance` are control-plane commands only, while `cancel` and `approve` are both |
| **Approval modes** | **There are none, and `approval` declares two fields: `approvers` and `separationOfDuties`.** `mode`, `k` and `delegation` were deleted — writing any of them is `GRAPH020_UNKNOWN_FIELD`. **k-of-n approval needs no new vocabulary:** N `human_gate` nodes joined by `join{branches:[…], mode:"quorum", k}` — see `examples/graphs/two-person-approval.json`. `tiered` was not implementable from its own declaration, because no field anywhere defines a tier; delegation presupposes a group vocabulary this system does not have. Residue: a short-circuiting quorum join leaves the unneeded gates OPEN |
| **Removing a run from the journal** | **There is no way to, and that is the decision rather than an omission.** Nothing in the tree deletes a journal row or a payload file — no `loom prune`, no `StateStore.delete`, no retention sweep — so `rm -rf .loom` is the only eraser. A terminal run's journal is the corpus `loom score` and `loom cohort` measure over, and a prune's real question is "will anyone replay or score this run?", which no journaled fact answers. Measured cost: one real 8-node run is 62 events and 94,834 payload bytes, so tens of runs a day is single-digit MB/day. `TODO.md` §Z (D.14) records what to build and what NOT to |
| **`onBudgetExhausted: "gate"` / `"degrade"`** | Compile errors, deliberately. `gate` used to compile and then fail exactly as `"fail"` does, having promised a human; building it needs a way to raise a budget mid-run, and there is none |
| **`loom compile` against a missing resource** | **Refuses**, naming the file to write (`GRAPH015`). Two kinds are exempt and say so: `agent_profile` is a routing key the `--models-file` table maps, and `oversight` is a policy label — neither is resolved to a document by anything |

## Try it — and the part that is the point

A gate is a row in the journal, not a promise in memory, so the process that asks is not the
process that answers.

```bash
mkdir demo && cd demo && mkdir graphs
cat > graphs/gated.json <<'EOF'
{"apiVersion":"loom.dev/v1","kind":"GraphSpec",
 "metadata":{"name":"gated","project":"demo","version":1},
 "policy":{"posture":"on","capabilities":["fs:write"],
           "expansion":{"maxNodes":8,"maxDepth":1,"maxFanout":2,"maxLoopIterations":1}},
 "channels":{"note":{"type":"string","reduce":"replace"},
             "written":{"type":"object","reduce":"replace"}},
 "inputs":["note"],"outputs":["written"],
 "nodes":[{"id":"approve","type":"human_gate","reads":["note"],"writes":[],
           "humanGate":{"ref":"oversight/ship@stable",
                        "approval":{"approvers":["u:alice"]}}},
          {"id":"write","type":"tool","reads":["note"],"writes":["written"],
           "tool":{"name":"fs.write","version":"1.0","args":{"path":"shipped.txt","body":"${note}"}}}],
 "edges":[{"id":"e1","from":"approve","to":"write","kind":"seq"}]}
EOF

loom compile graphs/gated.json                 # `ok`
loom run     graphs/gated.json --input '{"note":"ship it"}'
# → status awaiting_gate, and the command to answer it, printed verbatim:
#   gate gate_01… on node approve — loom approve 01… gate_01… --as YOUR_ID

loom approve <runId> <gateId> --as u:alice     # a DIFFERENT process; nothing was held open
cat shipped.txt                                # ship it

loom replay <runId>                            # verifies; touches nothing
loom trace  <runId>                            # spans + graph conformance
loom trace  <runId> --otlp http://host:4318    # …and POST them to a collector
loom serve                                     # console at http://127.0.0.1:8787
```

Three things that command does not do, and each was a real defect: it does not need `--graph`; it
will not run a graph other than the one the approver was shown, down to the bytes behind its
`prompt/` and `subgraph/` refs; and `--as u:bob` is refused, because the gate names who may answer
it. **The first is why `replay` and `trace` carry no `--graph` either** — a run's journal records
its graph's HASH, not its bytes, so a fresh process looks in `graphs/` for all four verbs and
prints what it resolved on stderr. `--graph` still wins when given, and is checked against the
journal either way: a file whose hash is not the one the run compiled is `E_GRAPH_MISMATCH`, never
a replay whose `match: false` is really about the graph.

## Examples that run

[`examples/`](examples/) is a workspace, not a snippet dump: copy the directory, `cd` into it, and
follow [`examples/README.md`](examples/README.md). Its §§1–4 work offline with no key; §§5–6 have
an `agent` node and want a real model, and that README's table says which is which.
`packages/core/test/examples-run.test.ts` compiles every graph there on every `npm run check` and
runs the two that need no model, so an example that stops working stops the build. Inside:
`graphs/fan-out-join.json` (fan-out → branch-ordered join, with a `loom replay` that comes back
`{"match": true}`), `resources/function/*.js`, `resources/hook/no-secrets.js` (a `preTool` hook
blocking a credential before it reaches the disk), `graphs/review-bench.json` (a benchmark whose
answer is known — six diffs, three with a planted defect, and SIX `assertion` evaluators, one per
case, because a single evaluator makes S1 one bit) and `graphs/self-review.json` (the first
workflow this project ported against a live provider).

Two rules that fail a first attempt. A `resources/function/*.js` or `resources/hook/*.js` file is a
BARE FUNCTION EXPRESSION — the loader evaluates `(<the file>)`, so `module.exports = function (…)
{…};` is a syntax error before your code runs; no `module.exports`, no `export default`. And the
edge from a join's arm into the join must be `"kind": "join"`: a `seq` edge leaves the join inside
the fan-out and is refused with `GRAPH008_HELD_JOIN_UNCOLLECTED`, while no edge at all is
`GRAPH008_BRANCH_NOT_CONNECTED`.

## Extending it, and where that stops

Read this before you fork, not after. Loom's stated property is *unlimited extensibility*, and the
honest version of that sentence names its set. **Seventeen things need no fork. Three do**, and
both lists were driven through the shipped binary rather than read off a header. `CLAUDE.md` §2
counts them straight out of this section, so the row shape below is a ledger: shrinking the fork
list is the goal, it growing is the alarm.

**Nothing in the box has a back door.** A name collision across all three registrars — built-ins,
`--mcp-file` servers, `--extension-module` modules — refuses at boot naming both claimants, rather
than registering the loser and never dispatching it; the `mcp__` prefix is reserved for the MCP
registrar whether a server is configured or not, because spelling one is impersonation and lowers
oversight (a real MCP tool is `irreversible` and carries `mcp:<server>`); and a module is handed
the same frozen jail object the built-ins get, from one derivation (`jailFor`) — `root` and `deny`
always, the three allowlists only where the operator passed the matching flag, so a module must not
assume a fixed shape (`test/cli/mcp-registrar-collision.test.ts`, eight cases). What reserving does
NOT buy is dispatch-time protection: it is a BOOT check, and `ToolRegistry` permits registration
after `seal()` unless the embedder opts out (`registerAfterSeal: "deny"`), so a module registering
from a timer is invisible to it and still shadows.

**No fork. You are a workspace author or an operator, and every one of these is a file you write:**

| what | how | measured |
|---|---|---|
| a graph | `graphs/*.json`, `*.yaml`, `*.yml` | `loom compile graphs/…` |
| a prompt, an agent profile, a skill | `resources/{prompt,agent_profile,skill}/*.md`, `*.txt` | `loom --help` names all seven publishable kinds |
| a subgraph | `resources/subgraph/*.json` | ditto |
| a `function` node body | `resources/function/*.js`, `*.mjs` — a bare function expression | `examples/README.md` §2 |
| a `hook` body, at any of the eight points | `resources/hook/*.js` | §3 |
| a tool | `--mcp-file` — any MCP server, stdio | driven against a 30-line stdio server: `loom run --mcp-file …` reaches its tool as `mcp__demo__reverse`, holding capability `mcp:demo`, and it GATES before it runs, because an MCP tool is irreversible unless its own server row says otherwise. A row may declare `"irreversibility"` — the operator's judgement about that server, never the server's about itself — and the two halves were driven one key apart on one graph: with no key, `awaiting_gate` and the server's `tools/call` reached 0 times; with `"irreversibility":"read_only"`, `succeeded`, reached once, and `! MCP OVERSIGHT LOWERED BY --mcp-file — demo: read_only (posture floor out)` on stderr. `test/mcp/client.test.ts` and `test/mcp/irreversibility.test.ts` are the shipped reproductions |
| a provider on the OpenAI wire | `--models-file` — any OpenAI-wire endpoint at any `baseUrl`. A keyless endpoint says so: `"apiKeyEnv": null` | the adapters row `{"provider":"openai","name":"local","baseUrl":"http://127.0.0.1:9/v1","apiKeyEnv":null}`, in a file that also carries `routes` → `ok`, exit 0; the same row *without* `apiKeyEnv` → `E_CONFIG_INVALID: … adapters[0] ("local") needs the environment variable OPENAI_API_KEY, which is not set` |
| a provider on ANY OTHER wire | `--extension-module` — a module whose default export is handed `{models, tools, channels, identity, functions, hooks, resolver, store, payloads, jail}` and registers a `ModelAdapter` (which must implement `provider`, `stream`, `priceOf`, `estimateOf` and `outputCeilingOf`, and yield `provider` on its `done` frame); a `--models-file` `routes` row may then name it, and that row is where an operator declares such an endpoint FREE — `"prices": {"<model>": {"input": 0, "output": 0}}` on the route — because a third-wire adapter has no adapter row to put that on and an unpriced route refuses at the model call. Zero is the only rate a route row may state: the row is read when deciding whether the route is priced at all and never reaches the thing that bills, so a non-zero rate there would lift the refusal while every call was still journaled at `costUsd: 0`. A REAL rate has two doors, both reaching the thing that bills: the ADAPTER row's `prices`, and — for any other wire — the adapter's own `priceOf` behind the optional `hasPrice(model)` | a 25-line module on an invented wire, driven offline: an `agent` node routed to it answers `"draft": "[echowire] echo-1 answered"`, and `loom replay` of that run *without* the module → `{"match": true, "hermetic": true}`. `test/cli/extension-module.test.ts` is the shipped reproduction. `examples/extensions/bedrock-converse.mjs` is the worked real-provider version and needs an AWS signer it deliberately does not ship, so it is a reference and not a reproduction |
| an in-process tool | `--extension-module` — the same module's `tools.register(…)`; it is registered before the grant list is derived, so its capability is held | `test/cli/extension-module.test.ts` |
| a place a gate is delivered to, and answered from | `--channels-file` — any HTTP endpoint; `callbackSecret` makes it answerable | a file with a signed `slack` row and an unsigned `pager` row boots to `gates:  slack (answerable), pager (notify-only)`, and the perimeter says so: `! CALLBACK ROUTE OPEN — POST /runs/:id/callbacks/:channel accepts decisions WITHOUT the bearer token, on: slack` |
| a delivery TRANSPORT that is not an HTTP webhook | `--extension-module` — the same module's `channels.register(…)`. A `DeliveryChannel` is `{name, deliver}`, plus `parseCallback` when a human can ANSWER through it. It needs no `--channels-file`, and merges with one when there is one | a module registering an SMTP channel called `ops-email`, with no channels file at all, boots to `ext:    …/smtp.mjs → no adapters, channel ops-email` and `gates:  ops-email (notify-only)` — and a gate raised on it reaches the module's own `deliver`, asserted in `test/cli/extension-module.test.ts` by the receipt the module writes beside itself. A name it shares with a file row refuses: `E_CONFIG_INVALID: --channels-file …: entry 0 repeats the channel name "ops-email", which an --extension-module already registered — a dispatcher keys channels by name, so one of them would never deliver` |
| an identity source | `--extension-module` — the same module's `identity.register(…)`. An `IdentitySource` is `{name, identify}`, where `undefined` establishes NOBODY and throwing REFUSES. One per deployment | a module registering a proxy-header source boots to `who:    proxy-header`, and a graph naming an approver it cannot enumerate is reported per gate rather than passed: `! CANNOT TELL — root/gate names u:alice: proxy-header cannot enumerate its subjects, so whether any of u:alice can hold a credential is unknown here`. Beside a `--identity-file` it refuses: `E_CONFIG_INVALID: --identity-file and the --extension-module …/oidc.mjs both establish who a caller is ("proxy-header"), and a deployment has ONE answer to that` |
| a `function` body the workspace seam cannot express | `--extension-module` — the same module's `functions.register(ref, body)`. A `resources/function/*.js` body is evaluated in a `node:vm` realm with `SAFE_GLOBALS` and refuses an async body at load; a module's body is host-realm code, so `Date`, `await` and anything else this process has are available | a module registering `function/stamp@stable` as an `async` body that awaits a timer and reads `new Date(0)`: `loom run` prints `"status": "succeeded"` and `"note": "stamped at epoch 0"`. `openWorkspace` also seeds a resolver pin for the ref, because `rule015Resources` asks the RESOLVER and would otherwise answer `GRAPH015_RESOURCE_NOT_FOUND` for a body that is registered and fine. A workspace file of the same ref still WINS — the file is the one an operator can open |
| a `hook` body, the same way | `--extension-module` — `hooks.register(ref, body)` | same seam, same seeding, same precedence |
| where refs resolve from | `--extension-module` — `resolver.register(r)`, a `ResourceResolver {resolve, document?, subgraph?}` — the REQUIRED member and only it, since demanding `document` refused a resolver implementing exactly the published interface. SUBSTITUTES rather than layers: a module supplying one owns ref resolution for the whole deployment, **`resources/` included**. The workspace scan still runs and still registers every `resources/function` and `resources/hook` body, but nothing can reach them: `rule015Resources` asks the RESOLVER, so a graph naming a workspace ref no longer compiles unless the module's resolver serves it | driven: the same graph is `"status": "succeeded"` with no module and `GRAPH015_RESOURCE_NOT_FOUND` with a module resolver answering `undefined`. The exceptions are the two kinds in `NAME_ONLY_KINDS` (`agent_profile`, `oversight`), which need no resolver and still COMPILE AND RUN under a resolver serving nothing — while an unserved `prompt/write@stable` beside them refuses AT COMPILE with `GRAPH015_RESOURCE_NOT_FOUND`, exit 1. A second claim refuses: `registers a resolver, and <first module> already registered one` |
| where the journal is | `--extension-module` — `store.register(s)`, any `StateStore`. This is the sharpest row on the list: a module supplying a `MemoryStateStore` makes a deployment whose runs do not survive the process, and the substitution is announced on whichever verb you used. `loom serve` says it in the boot banner, on stdout: `ext:    <path> → no adapters, store SUBSTITUTED (this deployment's journal is the module's)`. EVERY OTHER VERB, `loom run` included, says it on stderr instead — `! JOURNAL SUBSTITUTED by --extension-module <paths> — this deployment's journal is the module's, not <data-dir>. If it does not persist, nothing written by this command survives the process: no loom trace, no loom gates, no replay, and no restart can fold what this run recorded.` — and `serve` prints only the banner, never both | driven, both verbs on one module: `loom run` is exit 0, `"status": "succeeded"`, the `! JOURNAL SUBSTITUTED` lines on stderr; `loom serve` boots to the `store SUBSTITUTED` banner and writes no `JOURNAL SUBSTITUTED` line. On both, no `.loom/journal.db` is created, because none is opened. A member the object lacks refuses AT THE CALL, naming it — `store.register was given an object with no head(), listRuns() — a StateStore {append, read, head, listRuns, close}` |
| where externalised payloads go | `--extension-module` — `payloads.register(p)`, any `PayloadStore` | same single-slot rule, same refusal |

**An exam is a graph, and that is why property 3 needed no fork.** `loom exam attest <exam.json>`
takes an ordinary `apiVersion: loom.dev/v1` / `kind: GraphSpec` file, so it is the first row above
and not a row of its own; `loom compile examples/exams/review-bench-exam.json --workspace examples`
→ `ok`. What IS refused is a shape, not a format — an exam over the baseline's inputs alone:

```
E_CONFIG_INVALID: blind-exam.json cannot be attested for workflow "pick-bench" (graph sha256:57e8e86d…):
the exam reads no baseline OUTPUT (baseline outputs ["picked","verdict"]) — an exam over inputs alone
sees the question and never the run's answer, so it measures nothing about the run it grades   exit 1
```

**Fork required.** Each is a CLOSED SET whose refusal NAMES ITS MEMBERS — quoted, because a row
nobody can reproduce by running the thing does not belong on this list.

- **a node type** — `GRAPH020_UNKNOWN_TYPE … fix: use one of function, agent, tool, router, join, evaluator, human_gate, subgraph`
- **a reducer** — `GRAPH003_UNKNOWN_REDUCER … fix: use one of replace, append_ordered, merge_object, sum, max, min, union_set, last_write_wins_by_ts`
- **a ninth hook point** — `GRAPH003_UNKNOWN_HOOK_POINT … fix: one of: preNode, preModel, postModel, preTool, postTool, onError, onGate, onComplete`

**All three are there for ONE reason, and it is replay.** A fold can only reproduce a decision
whose vocabulary the folding binary already knows, so a node type from a config file would make a
recorded run unreadable by anything but the process that wrote it. The enforcement is not in the
fold — no reader in `run/projection.ts` or `run/replay.ts` reads the `nodeType`, `reducer` or
`point` the journal records — it is that a later binary must COMPILE the run's graph and dispatch
its nodes.

**There is no `--identity-module` or `--channels-module` flag, and deliberately not going to be
one.** Four rows left this list, all four through the same door, `--extension-module`. A second
flag would have to re-earn the trust argument this one is built on, which is the constraint rather
than a footnote: **the module is loaded from ARGV and nowhere else — not from a config file, not
from a `--*-file`, not from a resource ref, not from the data directory** — because a path read out
of a file would let a FILE decide what code this process runs while holding `fs:write`. With
`{models, tools}` that buys a wrong provider and a wrong tool; with `{channels, identity}` the same
file would decide WHO MAY APPROVE and WHERE A GATE IS SENT.

The refusals are the other half of the seam: two things claiming one slot — a second module taking
an adapter or channel name, a second identity source, a module that does not resolve, throws, has
no function default export, or registers nothing — REFUSE TO BOOT rather than pick a winner by load
order, because chaining two identity sources would accept the UNION of two credential sets.
`test/cli/extension-module.test.ts` drives all of them; `TODO.md` carries what is under active
reconsideration, custom reducers among it.

## Why this exists

The predecessor, **EAgent**, is a minimalist agent kernel with an excellent extension surface — but
it holds orchestration state *inside a single agent's transcript*. Parallel work is a tool call
that blocks a turn, background jobs die at process restart, and its DAG scheduler had to hand-clone
the kernel's policy guard. Loom inverts that: orchestration state lives in an append-only journal
every run folds.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — the goal, the three properties, and the working rules.
- [`TODO.md`](TODO.md) — everything unfinished, written to be self-contained.
- [`examples/README.md`](examples/README.md) — the runnable workspace; every command in it is
  executed by the test suite.
- The commit history is the record of why. There is no separate design corpus: the previous one
  was **deliberately deleted on 2026-08-25**, because its accumulated history was steering the work
  more than the goal was.

## Layout

```
packages/core/     the Loom engine — zero runtime dependencies. src/graph/ (compiler, expression
                   language, validation), src/run/ (executor, scheduler, policy, gates, replay),
                   src/journal/, src/providers/, src/server/ (control plane + console),
                   src/security/
examples/          a runnable workspace, executed by packages/core/test/examples-run.test.ts
scripts/           CI guards and the binary build
```

## EAgent, the predecessor — archived, not vendored

EAgent is the harness Loom grew out of, and it is **not in this branch.** It lived at
`packages/eagent/` until it was deleted, because `@loom/core` imported nothing from it while 43% of
the test suite and the repo's only runtime dependency (`jiti`) were spent defending it. `loom` is
an **orphan branch** sharing no history with `init` by design; `init`, tagged `eagent-v1`, is where
EAgent's history stayed — as a standalone repository, so its sources are at `src/`, not under any
`packages/` prefix. Three of core's files are forks of EAgent originals — `globToRegExp`
(`builtin/search-match.ts`), the edit matcher (`builtin/edit-match.ts`) and the bounded MCP line
reader (`mcp/client.ts`) — each carrying a `FORKED from` header, with the original still readable
at the tag:

```bash
git show eagent-v1                         # the annotated archive tag
git worktree add ../eagent-ref eagent-v1   # read it side-by-side
git diff eagent-v1:src/extensions/lib/edit-match.ts packages/core/src/builtin/edit-match.ts
```
