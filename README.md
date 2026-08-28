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
| **Gates** | `npm run check` — 2,300+ tests, offline, no API key; three guards: zero-dep, public surface (525 pinned names) and the kernel file list. One package, and it has no runtime dependencies to audit |
| **Compensation edges** | Compile-time rollback proof, and a rollback that RUNS — on run failure and on rewind, reverse order, with three journaled outcomes (compensated / failed / never attempted) |

## What does not work yet

Stated because a framework that overstates itself costs its user a day finding out.

| | |
|---|---|
| **`retry` on a function or evaluator node** | **Works**, through the RETURN rather than a throw: a body returns `{ retry: { reason } }` and the engine raises `E_FUNCTION_UNAVAILABLE` on its behalf, which is retryable by class. A *throw* still cannot carry retryability — `isLoomError` is an `instanceof` against the host class and a guest object can never satisfy it, so every throw out of the `vm` is still `E_INTERNAL` |
| **Reading the clock in a body** | **Reproducible.** `ctx.now()` is the task's journaled lease timestamp, so replay computes the same number with nothing new written. Time does not advance during a task — two reads return the same instant. `Date` is still absent from the sandbox: a frozen `Date` that silently never advances is more surprising than one that is not there, and restoring it means binding the whole constructor |
| **Hooks** | **Built.** Publish `resources/hook/<name>.js`, name it under `hooks:` in the graph, and it runs in the same hardened `vm` realm a `function` body does. A declared hook the workspace does not publish is a compile error, not a silent skip |
| **`JoinNode.timeoutMs`** | A node's `timeoutMs` is enforced; a JOIN's is not — nothing reads it, so a barrier whose branch never arrives waits forever. Declaring one is a compile WARNING rather than an error. The decision recorded in `DESIGN.md` is that a timeout FAILS the join; folding whatever arrived is a different feature wearing a timeout's name |
| **Crash mid-effect** | The journal survives, the run clock picks a backed-off run up again, and a restarted process re-arms the SLA clock of every gate it re-attaches — but a Task killed mid-effect stays leased with no automatic reclaim. The path back is `POST /runs/:id/commands {"kind":"rewind","atSeq":N}` on a `loom serve` plane, which re-arms the leases it undoes. **There is no `loom rewind` CLI verb** — `rewind` and `advance` are control-plane commands only, while `cancel` and `approve` are both |
| **Approval modes** | Only `single`. `quorum`, `all`, `tiered` and delegation are compile errors, deliberately, rather than silent downgrades |
| **Removing a run from the journal** | **There is no way to, and that is the decision rather than an omission.** Nothing in the tree deletes a journal row or a payload file — no `loom prune`, no `StateStore.delete`, no retention sweep — so a journal grows monotonically and `rm -rf .loom` is the only eraser. The reason is that a terminal run's journal is the corpus `loom score` and `loom cohort` measure over, and a prune's real question is "will anyone replay or score this run?", which no journaled fact answers. Measured cost: one real 8-node run is 62 events and 94,834 payload bytes in a 155,648-byte file, so tens of runs a day is single-digit MB/day. If that stops being acceptable, `TODO.md` §D.14 records what to build and what NOT to — in particular that a read-path fallback in `foldRun` has to land before anything is moved out from under it |

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
loom replay  <runId> --graph graphs/copy.json   # verifies; touches nothing
loom trace   <runId> --graph graphs/copy.json   # spans + graph conformance
loom serve                                       # console at http://127.0.0.1:8787
```

### …and the part that is the point

A gate is a row in the journal, not a promise in memory, so the process that asks is not the
process that answers.

```bash
mkdir -p resources/prompt
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
                        "approval":{"mode":"single","approvers":["u:alice"]}}},
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

## Examples that run

[`examples/`](examples/) is a workspace, not a snippet dump: copy the directory, `cd` into it, and
follow [`examples/README.md`](examples/README.md). Its §§1–4 work offline with no key; §§5–6 have
an `agent` node and want a real model, and that README's table says which is which — this
paragraph used to say "every command works offline with no key" and that was wrong for two of the
four graphs. `packages/core/test/examples-run.test.ts` compiles every graph in the directory on
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
honest version of that sentence names its set. **Ten things need no fork. Five do**, and the two
lists below were each driven through the shipped binary rather than read off a header.

**No fork. You are a workspace author or an operator, and every one of these is a file you write:**

| what | how | measured |
|---|---|---|
| a graph | `graphs/*.json`, `*.yaml`, `*.yml` | `loom compile graphs/…` |
| a prompt, an agent profile, a skill | `resources/{prompt,agent_profile,skill}/*.md`, `*.txt` | `loom --help` names all seven publishable kinds |
| a subgraph | `resources/subgraph/*.json` | ditto |
| a `function` node body | `resources/function/*.js`, `*.mjs` — a bare function expression | `examples/README.md` §2 |
| a `hook` body, at any of the eight points | `resources/hook/*.js` | §3 |
| a tool | `--mcp-file` — any MCP server, stdio | §"Try it" above |
| a provider on the OpenAI wire | `--models-file` — any OpenAI-wire endpoint at any `baseUrl` | `{"provider":"openai","baseUrl":"http://127.0.0.1:9/v1"}` → `ok`, exit 0 |
| a provider on ANY OTHER wire | `--extension-module` — a module whose default export is handed `{models, tools}` and registers a `ModelAdapter`; a `--models-file` `routes` row may then name it | `loom run … --extension-module ./bedrock.mjs` → `"draft": "[bedrock-converse] anthropic.claude-3-5-sonnet-…"`, and `loom replay` of that run → `{"match": true, "hermetic": true}` |
| an in-process tool | `--extension-module` — the same module's `tools.register(…)`; it is registered before the grant list is derived, so its capability is held | `test/cli/extension-module.test.ts` |
| a place a gate is delivered to, and answered from | `--channels-file` — any HTTP endpoint; `callbackSecret` makes it answerable | see the fork list's note on transports |

**Fork required.** Each of these is a CLOSED SET, and the binary names its members when you miss —
the compiler for the first three, the flag and config parsers for the rest. That is the point of
the list, and it is why every refusal below is quoted rather than described: a row nobody can
reproduce by running the thing does not belong on it.

- **a node type** — `GRAPH020_UNKNOWN_TYPE … fix: use one of function, agent, tool, router, join, evaluator, human_gate, subgraph`
- **a reducer** — `GRAPH003_UNKNOWN_REDUCER … fix: use one of replace, append_ordered, merge_object, sum, max, min, union_set, last_write_wins_by_ts`
- **a ninth hook point** — `GRAPH003_UNKNOWN_HOOK_POINT … fix: one of: preNode, preModel, postModel, preTool, postTool, onError, onGate, onComplete`
- **a delivery TRANSPORT that is not an HTTP webhook, from the CLI** — email, SMS, a Slack app
  rather than a Slack webhook URL. `--channels-file` builds `WebhookChannel` or
  `SignedWebhookChannel` and nothing else. A `{"transport":"smtp"}` entry is refused —
  `E_CONFIG_INVALID: --channels-file …: entry 0 ("ops-email") needs a non-empty string "url" to
  deliver to` — but say what that refusal covers, because it is narrower than the row: it checks
  the FIELD, not the scheme. `{"url":"mailto:ops@example.invalid"}` boots (`gates: ops-email
  (notify-only)`) and fails at delivery, not at config. The bound is that there is nothing but an
  HTTP POST behind the row, not that the parser knows what you meant. SPLIT, the same way the
  identity row below is: `DeliveryChannel` and `GateDispatcher` are both on `scripts/surface.json`,
  so a LIBRARY EMBEDDER hands a hand-written channel to `new GateDispatcher({channels: […]})` and
  forks nothing — measured with a stdout channel, which the dispatcher then reports as answerable
  because it defines `parseCallback`.
- **an identity source, from the CLI** — OIDC, mTLS, a proxy-set header. `--identity-file` is the
  only flag that establishes WHO a caller is (`--token` is one shared secret and names nobody),
  and it is `BearerTokenIdentity`'s options file: an OIDC-shaped one gets `E_CONFIG_INVALID:
  --identity-file …: must be {"subjects":[{"subject":"u:you","token":"…"}]} with at least one
  entry`, and there is no module flag to point at anything else — `E_CONFIG_INVALID: unknown flag:
  --identity-module (did you mean --identity-file?)`. SPLIT again, and the same shape: `IdentitySource`
  and `startControlPlane` are both on `scripts/surface.json`, so a LIBRARY EMBEDDER passes a
  header-trusting or OIDC source straight to `startControlPlane({identity})` and forks nothing —
  measured. This row is a DEBT, not a bound: a CLI seam for an identity source deletes it.

**Two of those five say "from the CLI", and the count keeps them.** A row that a library
embedder can walk around is still a fork for the person holding the binary, which is who this
list is written for; merging the two claims into one number is the compromise, and the split is
spelled out in each row rather than hidden in it.

**Each row's reason is its own, and the blanket one this section used to carry was measurably
false.** It read *"the reason is replay, not taste — every one of those closed sets is journaled
vocabulary"*, and it covered a wire protocol, which is not journaled vocabulary at all. So:

- **a node type, a reducer, a ninth hook point — replay.** Each is a word a journal records and a
  fold re-reads, and a fold can only reproduce a decision whose vocabulary the folding binary
  already knows. A node type that arrived from a config file would make a recorded run unreadable
  by anything but the process that wrote it. These three are BOUNDS, and the tell that each is
  honest is that its refusal names its members — all three above do.
- **a delivery transport, an identity source — nobody built the seam.** Replay does not require
  either: the library already accepts both, so a run using one folds fine. A flag parser cannot
  name the members of "an identity source", so these two refusals name the door that does exist
  instead of the one you asked for — the weaker version, which is why each row also says which
  pinned type a library embedder builds against. These two are DEBTS, and the honest direction for
  this list is two rows shorter.

**A wire protocol and an in-process tool used to be on this list under the replay reason, and it
did not apply to either.** An adapter produces no journal vocabulary: `replay.ts` never reaches an
adapter, journals `provider: "replay"`, and `reboundEffects` excludes the provider from
comparison — so a run served by a third-wire adapter replays `{"match": true, "hermetic": true}`
against an EMPTY `ModelRegistry`, in a binary that has never heard of it. Both were artefacts of
the CLI having no door onto `ModelRegistry` and `ToolRegistry`, which are pinned public types a
library embedder always reached. `--extension-module` is that door. It loads host-realm code from
ARGV and nowhere else — not from a config file, not from the workspace — because the whole trust
argument is that the operator who passes the path already chose which binary to run.

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
