# Loom

A multi-agent runtime. You describe what you want done, it runs, and every durable fact about
the run is an append-only journal entry — so parallelism, human oversight, replay and
observability are one mechanism rather than four.

The graph is the substrate, not the thing you have to write. **Determinism is enforced by
controlling the realm** — a PRNG seeded from a journaled draw, a clock bound to a journaled task
boundary, every effect declared and keyed — which is what lets the workflow language stay ordinary
TypeScript instead of WASM components or a DSL.

## Thirty seconds

```ts
import { agent } from "@loom/core";

const summarise = agent({
  prompt: "Summarise the input in two sentences.",
  adapter: myAnthropicAdapter,
});

const result = await summarise.run("…text…");
console.log(result.status, result.output, result.usage.costUsd);
```

That is a one-node graph on the full engine. Which means, without writing another line:

```ts
await summarise.replay(result.runId);   // re-runs from the journal. zero model calls.
```

and if you give it a tool that changes the world, it **stops and asks** — the oversight floor
comes from what the tool *is*, not from configuration you remembered to add:

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

Reach for the graph. Fan-out and branch-ordered joins, routers, bounded loops, human-gate nodes,
subgraphs, and `function` nodes that declare their own effects:

```ts
function: { ref: "function/settle@stable", effects: ["pay.charge", "note.write"] }
```

A declared effect is reachable by the capability ceiling, the unknown-tool diagnostic and the
oversight floor by the same route a tool node's name travels — **declaring a capability and
declaring a journaled effect are one act**, which is what keeps "every nondeterministic call is
journaled" a property of the schema rather than a rule somebody has to remember.

## Or run it as a service

```bash
npm install && npm run build:binary   # → bin/loom, one file, 0 third-party modules
export PATH="$PWD/bin:$PATH"          # `loom` is not published; the binary IS the install
loom serve                            # console + API on :8787, from an empty directory
```

**`bin/loom` is a photograph of `packages/core/src`, and nothing rebuilds it for you.** That is a
decision, not an omission: one machine, one operator, so the rebuild is a command you run rather
than a daemon watching your tree. What stands in for the daemon is a refusal — the binary
re-hashes the sources beside it before any application code runs and exits non-zero once they have
moved, naming what changed. So the standing condition is: **after editing `packages/core/src`, run
`npm run build:binary` before trusting `bin/loom`.** `LOOM_STALE_BINARY=allow` runs a stale one
anyway and still prints the report — the bar is that nobody drives a stale binary without being
told, not that nobody drives one. A copy with no sources beside it, which is every copy anyone
installs, has nothing to be behind and says nothing.

That refusal ships *inside* the binary, which means a binary built before it existed cannot tell
you it is missing — that is how the `bin/loom` in this repo once answered `--help` with exit 0
while eight days and 48 source files behind. The check that lives outside the artifact is
`node scripts/verify-binary.mjs [path]`: it drives a built binary through all four cases (current,
stale, overridden, no-sources) and fails the two a guardless binary passes silently. CI builds the binary and runs
that check — on pushes to `loom` and on pull requests targeting it, which is every commit that
reaches the branch and not every commit anybody makes. On `ubuntu-latest`, so the macOS path this
repo is developed on is exercised by a maintainer running `npm run build:binary` and nothing else.

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
| **Gates** | `npm run check` — 2,300+ tests, offline, no API key; three guards: zero-dep, public surface (the exported NAME SET, enumerated in `scripts/surface.json`) and the kernel file list (`scripts/kernel.json`). One package, and it has no runtime dependencies to audit |
| **Compensation edges** | Compile-time rollback proof, and a rollback that RUNS — on run failure and on rewind, reverse order, with three journaled outcomes (compensated / failed / never attempted). A rewind's undos run APPROVED, because `rewind` takes a human actor and refuses a plan hash that no longer matches what it would dispatch; a run's own failure does not, because no automated path may approve itself |
| **Tracing out** | Three doors, one encoder. `loom trace <runId>` renders the span tree in a terminal; `loom trace <runId> --otlp <endpoint>` POSTs it to a collector; and `GET /runs/:id/trace` on a `loom serve` plane answers the same fold as JSON — or, with `?format=otlp`, as an OTLP/HTTP JSON `ExportTraceServiceRequest` a collector ingests directly. Hand-rolled, so the zero-dependency rule still holds. **The push takes its endpoint from argv and its credentials from `OTEL_EXPORTER_OTLP_HEADERS`**, never the reverse: no environment variable can make `loom trace` send, because a shell that happens to export one is not an operator asking for egress, and a key passed as a flag is readable out of `ps`. A run whose trace follows subgraphs sends **one request per run**, each under its own `traceId`, so the collector performs the join `loom trace` performs in process — which is what `SpanLink.traceId` is for |

## What does not work yet

Stated because a framework that overstates itself costs its user a day finding out.

| | |
|---|---|
| **`retry` on a function or evaluator node** | **Works**, through the RETURN rather than a throw: a body returns `{ retry: { reason } }` and the engine raises `E_FUNCTION_UNAVAILABLE` on its behalf, which is retryable by class. A *throw* still cannot carry retryability — `isLoomError` is an `instanceof` against the host class and a guest object can never satisfy it, so every throw out of the `vm` is still `E_INTERNAL` |
| **Reading the clock in a body** | **Reproducible.** `ctx.now()` is the task's journaled lease timestamp, so replay computes the same number with nothing new written. Time does not advance during a task — two reads return the same instant. `Date` is still absent from the sandbox: a frozen `Date` that silently never advances is more surprising than one that is not there, and restoring it means binding the whole constructor |
| **Hooks** | **Built.** Publish `resources/hook/<name>.js`, name it under `hooks:` in the graph, and it runs in the same hardened `vm` realm a `function` body does. A declared hook the workspace does not publish is a compile error, not a silent skip |
| **A barrier deadline** | **There is none, and declaring one is now a compile ERROR** — `JoinNode.timeoutMs` was deleted, so `timeoutMs` inside a `join:` block is `GRAPH020_UNKNOWN_FIELD`. It was read by no executor, and a barrier deadline's undecidable case has no journaled answer: a join sees only that a sibling has not committed, so it cannot tell a stranded branch from one correctly waiting on a human gate. Every branch already has an enforced bound at its own locus — `NodeSpec.timeoutMs` for a node, `slaMs` + `onTimeout` for a gate. What is still open, and is a different item: a node that declares NO `timeoutMs` hangs its task forever, so a join over such a branch still waits forever |
| **Crash mid-effect** | The journal survives, the run clock picks a backed-off run up again, and a restarted process re-arms the SLA clock of every gate it re-attaches — but a Task killed mid-effect stays leased with no automatic reclaim. The path back is TWO requests on a `loom serve` plane: `GET /runs/:id/rewind-plan?atSeq=N` returns what the rewind would undo plus a `planHash`, and `POST /runs/:id/commands {"kind":"rewind","atSeq":N,"planHash":"…"}` performs it and re-arms the leases it undoes. **Sending the second without a `planHash` is a 400**, and a hash that no longer matches what the rewind would dispatch is refused — an operator authorizes a LIST, not a verb. For a stuck lease that list is usually empty, and the handshake is unconditional anyway: the plan is computed after four refusals and a full journal read, so a caller cannot know theirs is empty until it has run. **Both routes require a HUMAN caller**, so the plane needs `--identity-file` (or an `--extension-module` identity source) and the request needs a person's credential. A default `--token` plane gets `403 E_HUMAN_APPROVAL_REQUIRED`: a rewind dispatches real-world undos and may suppress the `gate.decided` a person spent their judgement on, so no automated path may take one. **`cancel` is NOT the substitute here** — it stops the run without touching what it already did, which is the opposite of re-arming a lease. **There is no `loom rewind` CLI verb** — `rewind` and `advance` are control-plane commands only, while `cancel` and `approve` are both |
| **Approval modes** | **There are none, and `approval` declares two fields: `approvers` and `separationOfDuties`.** `mode`, `k` and `delegation` were deleted — writing any of them is `GRAPH020_UNKNOWN_FIELD`, which also catches `modee`, `quorumK` and `delegate`, where three exact strings were caught before. **k-of-n approval needs no new vocabulary:** N `human_gate` nodes joined by `join{branches:[…], mode:"quorum", k}` — see `examples/graphs/two-person-approval.json`. `tiered` was not implementable from its own declaration, because no field anywhere defines a tier; delegation presupposes a group vocabulary this system does not have. Residue: a short-circuiting quorum join leaves the unneeded gates OPEN, which is `JoinNode`'s documented straggler-cancellation gap |
| **Removing a run from the journal** | **There is no way to, and that is the decision rather than an omission.** Nothing in the tree deletes a journal row or a payload file — no `loom prune`, no `StateStore.delete`, no retention sweep — so a journal grows monotonically and `rm -rf .loom` is the only eraser. The reason is that a terminal run's journal is the corpus `loom score` and `loom cohort` measure over, and a prune's real question is "will anyone replay or score this run?", which no journaled fact answers. Measured cost: one real 8-node run is 62 events and 94,834 payload bytes in a 155,648-byte file, so tens of runs a day is single-digit MB/day. If that stops being acceptable, `TODO.md` §Z (D.14, answered by deletion) records what to build and what NOT to — in particular that a read-path fallback in `foldRun` has to land before anything is moved out from under it |

| **`onBudgetExhausted: "gate"` / `"degrade"`** | Compile errors, deliberately. `gate` used to compile and then fail exactly as `"fail"` does, having promised a human; building it needs a way to raise a budget mid-run, and there is none |
| **`loom compile` against a missing resource** | **Refuses**, naming the file to write (`GRAPH015`). Two kinds are exempt and say so: `agent_profile` is a routing key the `--models-file` table maps, and `oversight` is a policy label — neither is resolved to a document by anything |
| **Replay of a run a human de-escalated** | **Reproduces.** A de-escalation is a human input, served from the record like a gate decision and re-keyed onto the shadow run. Replay's verdict also weighs GATES now — it used to score `match: true` for a replay that asked a human a different number of times, or none |

## Try it

```bash
mkdir demo && cd demo && mkdir graphs
cat > graphs/copy.json <<'EOF'
{"apiVersion":"loom.dev/v1","kind":"GraphSpec",
 "metadata":{"name":"copy-file","project":"demo","version":1},
 "policy":{"posture":"out","capabilities":["fs:read","fs:write"]},
 "channels":{"source":{"type":"string","reduce":"replace"},
             "body":{"type":"string","reduce":"replace"},
             "written":{"type":"object","reduce":"replace"}},
 "inputs":["source"],"outputs":["written"],
 "nodes":[{"id":"read","type":"tool","reads":["source"],"writes":["body"],
           "tool":{"name":"fs.read","version":"1.0","args":{"path":"${source}"}}},
          {"id":"write","type":"tool","reads":["body"],"writes":["written"],"unhandled":true,
           "tool":{"name":"fs.write","version":"1.0","args":{"path":"out/copy.txt","body":"${body}"}}}],
 "edges":[{"id":"e1","from":"read","to":"write","kind":"seq"}]}
EOF
echo hello > input.txt

loom compile graphs/copy.json                    # `ok`
loom run     graphs/copy.json --input '{"source":"input.txt"}'
loom replay  <runId>                             # verifies; touches nothing
loom trace   <runId>                             # spans + graph conformance
loom trace   <runId> --otlp http://host:4318     # …and POST them to a collector
loom serve                                       # console at http://127.0.0.1:8787
```

### …and the part that is the point

A gate is a row in the journal, not a promise in memory, so the process that asks is not the
process that answers.

```bash
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

loom run graphs/gated.json --input '{"note":"ship it"}'
# → status awaiting_gate, and the command to answer it, printed verbatim:
#   gate gate_01… on node approve — loom approve 01… gate_01… --as YOUR_ID

loom approve <runId> <gateId> --as u:alice     # a DIFFERENT process; nothing was held open
cat shipped.txt                                # ship it
```

Three things that command does not do, and each was a real defect:

- it does not need `--graph` — the workspace is searched for the hash the journal recorded;
- it will not run a graph other than the one the approver was shown, down to the bytes behind
  its `prompt/` and `subgraph/` refs;
- `--as u:bob` is refused, because the gate names who may answer it.

**The first of those is why `replay` and `trace` above carry no `--graph` either.** A run's
journal records its graph's HASH, not its bytes, so a fresh process has to look — and `graphs/`
is where it looks, for all four verbs. What it resolved is printed on stderr, naming the file:

```
replay: graph copy-file v1 (sha256:04e9ea2c…) — the hash run 01M1EW… recorded, from graphs/copy.json
```

`--graph` still wins when given, and is how a candidate living outside `graphs/` is named without
publishing it (`loom score --graph` documents that use). It is checked against the journal either
way: a file whose hash is not the one the run compiled is `E_GRAPH_MISMATCH`, never a replay whose
`match: false` is really about the graph. And a workspace that publishes graphs, none of them this
run's, is told so — with the ones it does publish named — rather than being told it publishes
none.

## Examples that run

[`examples/`](examples/) is a workspace, not a snippet dump: copy the directory, `cd` into it, and
follow [`examples/README.md`](examples/README.md). Its §§1–4 work offline with no key; §§5–6 have
an `agent` node and want a real model, and that README's table says which is which — this
paragraph used to say "every command works offline with no key" and that was wrong for exactly the
graphs with an `agent` node, which is the set that moves when a graph is added and the count is
not. `packages/core/test/examples-run.test.ts` compiles every graph in the directory on
every `npm run check` and runs the two that need no model, so an example that stops working stops
the build.

- **`graphs/fan-out-join.json`** — the fan-out → branch-ordered join above, end to end:
  `loom compile`, `loom run`, and a `loom replay` that comes back `{"match": true}`.
- **`resources/function/*.js`** — a `function` node body: `(view, ctx) => ({writes})`, what the
  realm does and does not contain, and why `ctx.effects` refuses inside a sandboxed body.
- **`resources/hook/no-secrets.js`** — a `preTool` hook that blocks a credential before it
  reaches the disk.
- **`graphs/review-bench.json`** — a benchmark whose answer is known: six diffs, three with a
  planted defect, and SIX `assertion` evaluators, one per case, scoring the reviewer against the
  truth. Six rather than one on purpose: a single evaluator makes S1 one bit, so a review that
  found five of six planted defects scored exactly what one that found none scored.
- **`graphs/self-review.json`** — an agent fan-out, a human gate and an irreversible write; the
  first workflow this project ported against a live provider.

Two rules that fail a first attempt, stated here because both used to live only in a source
comment:

- **A `resources/function/*.js` or `resources/hook/*.js` file is a BARE FUNCTION EXPRESSION.**
  The loader evaluates `(<the file>)`, so `module.exports = function (…) {…};` is a syntax
  error — `Unexpected token ';'` — before your code runs. No `module.exports`, no
  `export default`, no wrapper.
- **The edge from a join's arm into the join must be `"kind": "join"`.** A `seq` edge leaves the
  join inside the fan-out and is refused with `GRAPH008_HELD_JOIN_UNCOLLECTED`; no edge at all
  is `GRAPH008_BRANCH_NOT_CONNECTED`.

## Extending it, and where that stops

Read this before you fork, not after. Loom's stated property is *unlimited extensibility*, and the
honest version of that sentence names its set. **Seventeen things need no fork. Three do**, and the
two lists below were each driven through the shipped binary rather than read off a header.

Both counts moved on 2026-09-01, in the same direction, from one change. The fork list has been six,
then seven when an undercount was found, then five, and is now **three** — every row that was there
because *nobody built the seam* is gone, and what is left is three rows that are there for a reason.

**THE FIRST NUMBER WAS AN UNDERCOUNT, AND ON 2026-09-06 IT WAS PAID RATHER THAN RESTATED.**
`EngineOptions` takes five more members — `functions` (`FunctionRegistry`), `hooks`
(`HookRegistry`), `resolver` (`ResourceResolver`), `store` (`StateStore`), `payloads`
(`PayloadStore`) — every one of their types is on `scripts/surface.json`, and `openWorkspace`
constructed all five unconditionally with no fallback. So a library embedder reached all five and
ARGV reached none: debts of exactly the shape the 5 → 3 change paid off, sitting under a section
that claimed to have none. The measured consequence was that a host-realm async `function` body
using `Date` ran from an embedder and could not be supplied from the CLI at all — at 294e713,
`--extension-module` on a module calling `functions.register` failed with `threw while registering:
Cannot read properties of undefined (reading 'register')`, because `functions` was not a key on the
object. All five are rows below now, so twelve became seventeen.

**AND TWO PRIVILEGED BUILT-INS ARE GONE.** This section's claim is "the things that ship in the box
are written against the same surface a stranger would use", and two things were not. `builtinTools`
registered AFTER the extension modules and `ToolRegistry.register` shadows on collision, so an
extension tool named `fs.read` was registered, held its capability, appeared in the grant list, and
was **never dispatched** — driven at 294e713 against a `tool` node calling `fs.read`, the run
succeeded with the built-in's answer and printed no warning, while the identical collision on an
adapter or channel name refused to boot. It refuses now, naming the module and the built-in names.
And the extension registrar carried no jail, so an outsider's filesystem or network tool could not
apply the operator's own guards; the module is handed the same frozen
`{root, deny, egressAllowlist, execAllowlist, execEnvAllow}` the built-ins get, from one derivation
(`jailFor`) both callers share.

**No fork. You are a workspace author or an operator, and every one of these is a file you write:**

| what | how | measured |
|---|---|---|
| a graph | `graphs/*.json`, `*.yaml`, `*.yml` | `loom compile graphs/…` |
| a prompt, an agent profile, a skill | `resources/{prompt,agent_profile,skill}/*.md`, `*.txt` | `loom --help` names all seven publishable kinds |
| a subgraph | `resources/subgraph/*.json` | ditto |
| a `function` node body | `resources/function/*.js`, `*.mjs` — a bare function expression | `examples/README.md` §2 |
| a `hook` body, at any of the eight points | `resources/hook/*.js` | §3 |
| a tool | `--mcp-file` — any MCP server, stdio | driven against a 30-line stdio server: `loom run --mcp-file …` reaches its tool as `mcp__demo__reverse`, holding capability `mcp:demo`, and it GATES before it runs, because an MCP tool is irreversible unless its own server row says otherwise. A row may declare `"irreversibility"` — the operator's judgement about that server, never the server's about itself — and on 2026-09-02 the two halves were driven one key apart on one graph: with no key, `awaiting_gate` and the server's `tools/call` reached 0 times; with `"irreversibility":"read_only"`, `succeeded`, reached once, and `! MCP OVERSIGHT LOWERED BY --mcp-file — demo: read_only (posture floor out)` on stderr. `test/mcp/client.test.ts` and `test/mcp/irreversibility.test.ts` are the shipped reproductions |
| a provider on the OpenAI wire | `--models-file` — any OpenAI-wire endpoint at any `baseUrl`. A keyless endpoint says so: `"apiKeyEnv": null` | the adapters row `{"provider":"openai","name":"local","baseUrl":"http://127.0.0.1:9/v1","apiKeyEnv":null}`, in a file that also carries `routes` → `ok`, exit 0; the same row *without* `apiKeyEnv` → `E_CONFIG_INVALID: … adapters[0] ("local") needs the environment variable OPENAI_API_KEY, which is not set` |
| a provider on ANY OTHER wire | `--extension-module` — a module whose default export is handed `{models, tools, channels, identity, functions, hooks, resolver, store, payloads, jail}` and registers a `ModelAdapter` (which must implement `provider`, `stream`, `priceOf`, `estimateOf` and `outputCeilingOf`, and yield `provider` on its `done` frame); a `--models-file` `routes` row may then name it, and that row is where an operator declares such an endpoint FREE — `"prices": {"<model>": {"input": 0, "output": 0}}` on the route — because a third-wire adapter has no adapter row to put that on and an unpriced route now refuses at the model call. Zero is the only rate a route row may state, and it is refused otherwise: the row is read when deciding whether the route is priced at all and never reaches the adapter, which is what bills, so a non-zero rate there would lift the refusal while every call was still journaled at `costUsd: 0`. A REAL rate has two doors, both of which reach the thing that bills: the ADAPTER row's `prices`, and — for any other wire — the adapter's own `priceOf` behind the optional `hasPrice(model)` | a 25-line module on an invented wire, driven offline: an `agent` node routed to it answers `"draft": "[echowire] echo-1 answered"`, and `loom replay` of that run *without* the module → `{"match": true, "hermetic": true}`. `test/cli/extension-module.test.ts` is the shipped reproduction. `examples/extensions/bedrock-converse.mjs` is the worked real-provider version and needs an AWS signer it deliberately does not ship, so it is a reference and not a reproduction |
| an in-process tool | `--extension-module` — the same module's `tools.register(…)`; it is registered before the grant list is derived, so its capability is held | `test/cli/extension-module.test.ts` |
| a place a gate is delivered to, and answered from | `--channels-file` — any HTTP endpoint; `callbackSecret` makes it answerable | a file with a signed `slack` row and an unsigned `pager` row boots to `gates:  slack (answerable), pager (notify-only)`, and the perimeter says so: `! CALLBACK ROUTE OPEN — POST /runs/:id/callbacks/:channel accepts decisions WITHOUT the bearer token, on: slack` |
| a delivery TRANSPORT that is not an HTTP webhook | `--extension-module` — the same module's `channels.register(…)`. A `DeliveryChannel` is `{name, deliver}`, plus `parseCallback` when a human can ANSWER through it. It needs no `--channels-file`, and merges with one when there is one | a module registering an SMTP channel called `ops-email`, with no channels file at all, boots to `ext:    …/smtp.mjs → no adapters, channel ops-email` and `gates:  ops-email (notify-only)` — and a gate raised on it reaches the module's own `deliver`, asserted in `test/cli/extension-module.test.ts` by the receipt the module writes beside itself. A name it shares with a file row refuses: `E_CONFIG_INVALID: --channels-file …: entry 0 repeats the channel name "ops-email", which an --extension-module already registered — a dispatcher keys channels by name, so one of them would never deliver` |
| an identity source | `--extension-module` — the same module's `identity.register(…)`. An `IdentitySource` is `{name, identify}`, where `undefined` establishes NOBODY and throwing REFUSES. One per deployment | a module registering a proxy-header source boots to `who:    proxy-header`, and a graph naming an approver it cannot enumerate is reported per gate rather than passed: `! CANNOT TELL — root/gate names u:alice: proxy-header cannot enumerate its subjects, so whether any of u:alice can hold a credential is unknown here`. Beside a `--identity-file` it refuses: `E_CONFIG_INVALID: --identity-file and the --extension-module …/oidc.mjs both establish who a caller is ("proxy-header"), and a deployment has ONE answer to that` |
| a `function` body the workspace seam cannot express | `--extension-module` — the same module's `functions.register(ref, body)`. A `resources/function/*.js` body is evaluated in a `node:vm` realm with `SAFE_GLOBALS` and refuses an async body at load; a module's body is host-realm code, so `Date`, `await` and anything else this process has are available | a module registering `function/stamp@stable` as an `async` body that awaits a timer and reads `new Date(0)`: `loom run` prints `"status": "succeeded"` and `"note": "stamped at epoch 0"`. `openWorkspace` also seeds a resolver pin for the ref, because `rule015Resources` asks the RESOLVER and would otherwise answer `GRAPH015_RESOURCE_NOT_FOUND` for a body that is registered and fine. A workspace file of the same ref still WINS — the file is the one an operator can open |
| a `hook` body, the same way | `--extension-module` — `hooks.register(ref, body)` | same seam, same seeding, same precedence |
| where refs resolve from | `--extension-module` — `resolver.register(r)`, a `ResourceResolver {resolve, document?, subgraph?}` — the REQUIRED member and only it, since demanding `document` refused a resolver implementing exactly the published interface. SUBSTITUTES rather than layers: a module supplying one owns ref resolution — `resolve`, `document`, `subgraph` — for the whole deployment, **`resources/` included**. The workspace scan still runs and still registers every `resources/function` and `resources/hook` body, but nothing can reach them: `rule015Resources` asks the RESOLVER, so a graph naming a workspace ref no longer compiles unless the module's resolver serves it. Driven: the same graph is `"status": "succeeded"` with no module and `GRAPH015_RESOURCE_NOT_FOUND` with a module resolver that answers `undefined`. Supplying one means taking on every ref the deployment's graphs name that `rule015Resources` checks — which is every kind but the two in `NAME_ONLY_KINDS` (`agent_profile`, `oversight`). Those two need no resolver at all and nothing reads their content, so a resolver that serves neither still COMPILES AND RUNS them: driven, an `agent` node on `agent_profile/writer@stable` beside a served `prompt/write@stable` is exit 0 and `"status": "succeeded"`, and a `human_gate` on `oversight/release@stable` under a resolver answering `undefined` for EVERY ref is exit 0 and `"status": "awaiting_gate"`. The ordinary half is the prompt beside them: unserved, `prompt/write@stable` refuses AT COMPILE — `✗ g.json: GRAPH015_RESOURCE_NOT_FOUND: resource "prompt/write@stable" does not resolve` then `E_GRAPH_INVALID: graph has 1 error(s): GRAPH015_RESOURCE_NOT_FOUND`, exit 1 | a second claim refuses: `registers a resolver, and <first module> already registered one` |
| where the journal is | `--extension-module` — `store.register(s)`, any `StateStore`. This is the sharpest row on the list: a module supplying a `MemoryStateStore` makes a deployment whose runs do not survive the process, and the substitution is announced on whichever verb you used. `loom serve` says it in the boot banner, on stdout: `ext:    <path> → no adapters, store SUBSTITUTED (this deployment's journal is the module's)`. EVERY OTHER VERB, `loom run` included, says it on stderr instead — `! JOURNAL SUBSTITUTED by --extension-module <paths> — this deployment's journal is the module's, not <data-dir>. If it does not persist, nothing written by this command survives the process: no loom trace, no loom gates, no replay, and no restart can fold what this run recorded.` (three lines as printed) — and `serve` prints only the banner, never both | driven, both verbs on one module: `loom run` is exit 0, `"status": "succeeded"`, the `! JOURNAL SUBSTITUTED` lines on stderr; `loom serve` boots to the `store SUBSTITUTED` banner and writes no `JOURNAL SUBSTITUTED` line. On both, no `.loom/journal.db` is created, because none is opened — the `.loom` directory is made and stays empty. A member the object lacks refuses AT THE CALL, naming it — `store.register was given an object with no head(), listRuns() — a StateStore {append, read, head, listRuns, close}`, which is all five and not the three it first asked for: a partial store used to boot and die mid-run with `TypeError: this[#store].head is not a function` |
| where externalised payloads go | `--extension-module` — `payloads.register(p)`, any `PayloadStore` | same single-slot rule, same refusal |

**Fork required.** Each of these is a CLOSED SET, and the COMPILER names its members when you miss —
all three are compiler refusals now, which is the shape the list converged on rather than a
coincidence. That is the point of the list, and it is why every refusal below is quoted rather than
described: a row nobody can reproduce by running the thing does not belong on it. All three were
re-driven on 2026-09-01 against the binary at `packages/core/src/cli.ts`.

- **a node type** — `GRAPH020_UNKNOWN_TYPE … fix: use one of function, agent, tool, router, join, evaluator, human_gate, subgraph`
- **a reducer** — `GRAPH003_UNKNOWN_REDUCER … fix: use one of replace, append_ordered, merge_object, sum, max, min, union_set, last_write_wins_by_ts`
- **a ninth hook point** — `GRAPH003_UNKNOWN_HOOK_POINT … fix: one of: preNode, preModel, postModel, preTool, postTool, onError, onGate, onComplete`

**All three are there for ONE reason, and it is replay.** A fold can only reproduce a decision
whose vocabulary the binary doing the folding already knows, so a node type that arrived from a
config file would make a recorded run unreadable by anything but the process that wrote it. These
three are BOUNDS, and the tell that each is honest is that its refusal NAMES ITS MEMBERS — all three
above do.

This paragraph used to say "each is a word a journal records and **a fold re-reads**", and the
second half of that is false of all three. Measured: the journal does record each — `task.started`
carries `nodeType`, `channel.written` carries `reducer`, `hook.applied` carries `point` — and
`grep -an` for those three fields across `run/projection.ts` and `run/replay.ts` returns nothing.
Even `evolution/trajectory.ts`, the one reader of a node's type, builds its map from
`opts.graph.spec.nodes` rather than from the event. The mechanism is one layer up: what a later
binary has to be able to do is COMPILE the graph the run was submitted against and dispatch its
nodes, which is `graph/validate.ts`'s `GRAPH020_UNKNOWN_TYPE` and the executor's own switch. The
bound is the same and its enforcement is not where this sentence said it was. There is no longer a second bullet under this
heading, and getting to one reason is most of what this section's history is about: it used to carry
the blanket claim *"the reason is replay, not taste — every one of those closed sets is journaled
vocabulary"*, which was measurably false of the rows it covered, and then a split between three
BOUNDS and two DEBTS.

**Four rows have left this list, in two changes, and neither was a door closing.** A wire protocol
and an in-process tool went first, under a replay reason that did not apply to either: an adapter
produces no journal vocabulary, `replay.ts` never reaches one, journals `provider: "replay"`, and
`reboundEffects` excludes the provider from comparison — so a run served by a third-wire adapter
replays `{"match": true, "hermetic": true}` against an EMPTY `ModelRegistry`, in a binary that has
never heard of it. A delivery transport and an identity source went second, under the honest reason
this section had already written down for them: *nobody built the seam*. Replay never required
either — the library accepted both all along, through `GateDispatcher({channels})` and
`startControlPlane({identity})`, which are pinned public types — and the refusals the binary printed
named THE WRONG DOOR:

    $ loom serve --identity-module ./oidc.mjs
    E_CONFIG_INVALID: unknown flag: --identity-module (did you mean --identity-file?). …

    $ loom serve --channels-module ./smtp.mjs
    E_CONFIG_INVALID: unknown flag: --channels-module (did you mean --channels-file?). …

(Each line continues "A flag this binary does not understand is IGNORED unless it is refused here
— and for --token, ignored means the control plane authenticates nobody. Run `loom help` for the
list." The `…` is there because a quote that silently stops mid-sentence is not the quote this
section's rule asks for — and the first version of THIS parenthetical, written to fix exactly that,
itself stopped one sentence early and unmarked. A correction that commits the defect it corrects is
the failure mode this file's rules name most often; it is cheap to avoid by pasting what the binary
printed and reading to the end of it.)

**There is still no such flag, and there is deliberately not going to be one.** All four rows came
off through the SAME door: `--extension-module`'s default export is now handed
`{models, tools, channels, identity}`. A second flag would have to re-earn the trust argument this
one is built on, and that argument is the constraint rather than a footnote: **the module is loaded
from ARGV and nowhere else — not from a config file, not from a `--*-file`, not from a resource ref,
not from the data directory** — because a path read out of a file would let a FILE decide what code
this process runs, in a process holding `fs:write`. With `{models, tools}` that bought a wrong
provider and a wrong tool. With `{channels, identity}` the same file would decide WHO MAY APPROVE
and WHERE A GATE IS SENT, which is oversight loosening itself along a path no human touched. If any
of it ever becomes loadable from anywhere but argv, that argument fails and the seam has to move
behind a process boundary first.

The refusals are the other half of the seam, and each is a case where two things claim one slot:
a second module claiming an adapter or channel name the first took, a second identity source (from
another module or from `--identity-file`), a module that does not resolve, throws, has no function
default export, or registers nothing. Every one REFUSES TO BOOT rather than pick a winner by load
order — chaining two identity sources would accept the UNION of two credential sets, which is a
widening no human asked for. `test/cli/extension-module.test.ts` drives all of them.

`TODO.md` carries the entries under active reconsideration; custom reducers are argued on the
merits there. This list is a bound with a reason, not an apology.

## Why this exists

The predecessor, **EAgent**, is a minimalist agent kernel with an excellent extension
surface — but it holds orchestration state *inside a single agent's transcript*.
Parallel work is a tool call that blocks a turn, background jobs die at process
restart, and its DAG scheduler had to hand-clone the kernel's policy guard. Survivable
for one interactive session; painful in production with many concurrent tasks.

Loom inverts the structure: orchestration state lives in an append-only journal that every
run folds, so parallelism, human gates, replay and observability are one mechanism instead of
four.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — the goal, the three properties, and the working rules. Short on
  purpose.
- [`TODO.md`](TODO.md) — everything unfinished, written to be self-contained.
- [`examples/README.md`](examples/README.md) — a runnable workspace: a fan-out → join graph, a
  `function` body, a `hook` body. Every command in it is executed by the test suite.
- The commit history is the record of why. There is no separate design corpus: the previous
  one (14 architecture documents, a defect register and a journal) was **deliberately deleted
  on 2026-08-25** because its accumulated history was steering the work more than the goal was.

## Layout

```
packages/core/     the Loom engine — zero runtime dependencies
  src/graph/         compiler, expression language, validation
  src/run/           executor, scheduler, policy, gates, replay
  src/journal/       append-only store (memory + SQLite)
  src/providers/     Anthropic, OpenAI, fallback chains, cassettes
  src/server/        control plane + embedded console
  src/security/      redaction, SecretValue
examples/          a runnable workspace — the graph, function and hook bodies, executed by
                   packages/core/test/examples-run.test.ts
scripts/           CI guards and the binary build
```

## EAgent, the predecessor — archived, not vendored

EAgent is the harness Loom grew out of: a minimalist agent kernel with an excellent
extension surface. It is **not in this branch.** It lived at `packages/eagent/` until it was
deleted, because `@loom/core` imported nothing from it while 43% of the test suite and the
repo's only runtime dependency (`jiti`) were spent defending it.

`loom` is an **orphan branch** that shares no history with `init` by design. `init`, tagged
`eagent-v1`, is where EAgent's history stayed — as a standalone repository, so its sources are
at `src/`, not under any `packages/` prefix:

```bash
git show eagent-v1                    # the annotated archive tag
git show eagent-v1:src/kernel/agent.ts
git worktree add ../eagent-ref eagent-v1   # read it side-by-side
```

Three of core's files are forks of EAgent originals — `globToRegExp`
(`builtin/search-match.ts`), the edit matcher (`builtin/edit-match.ts`), and the bounded MCP
line reader (`mcp/client.ts`). Each carries a `FORKED from` header naming its original, and
the original stays readable at the tag, so the two can still be diffed rather than trusted:

```bash
git diff eagent-v1:src/extensions/lib/edit-match.ts packages/core/src/builtin/edit-match.ts
```
