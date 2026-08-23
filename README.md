# Loom

A multi-agent collaboration and orchestration framework where **the executable graph
is the runtime**, an agent loop is one node type inside it, and every durable fact
about a run is an append-only journal entry — so parallelism, human oversight, replay,
and observability are one mechanism seen from different angles.

```bash
npm install && npm run build:binary   # → bin/loom, one file, 0 third-party modules
export PATH="$PWD/bin:$PATH"          # `loom` is not published; the binary IS the install
loom serve                            # console + API on :8787, from an empty directory
```

## What works today

| | |
|---|---|
| **Graph compiler** | 22 validation rules, aggregated diagnostics with suggested fixes, resource pinning |
| **Executor** | Parallel fan-out, branch-ordered joins, bounded loops, retries. All eight node types run: tool, agent, router, join, human_gate, subgraph, function, evaluator |
| **Durability** | Append-only journal on `node:sqlite`. A run SUSPENDED on a human gate survives `kill -9` and resumes in another process |
| **Human oversight** | Three postures by configuration alone; gates are rows, so a suspended run holds zero worker slots. An approval binds the graph it was shown — spec, resolved resources and oversight floor |
| **Replay** | Re-executes with every effect served from the journal — zero model calls, zero side effects |
| **Providers** | Anthropic + OpenAI over `fetch`+SSE, normalized error taxonomy, declarative fallback chains in `--models-file`. A provider that ignores `stream: true` fails loudly rather than reporting an empty success |
| **Console** | Ships inside the binary. Graph canvas, live SSE, approve/reject queue |
| **Gates** | `npm run check` — 3347 tests across both packages, offline, no API key; zero-dep and public-surface guards |

## What does not work yet

Stated because a framework that overstates itself costs its user a day finding out.

| | |
|---|---|
| **`retry` on a function or evaluator node** | Inert. A body cannot raise a RETRYABLE error — every throw out of the `vm` is classified `E_INTERNAL`, so the backoff never schedules |
| **`Math.random()` in a function body** | Unrecorded. `Date` is stripped from the `vm` globals and `Math` is not, and there is no effect key for it — a body that calls it replays as a divergence rather than being served |
| **Compensation edges** | Compile-time rollback proof and a rewind refusal; nothing traverses them at run time |
| **Hooks** | **Built.** Publish `resources/hook/<name>.js`, name it under `hooks:` in the graph, and it runs in the same hardened `vm` realm a `function` body does. A declared hook the workspace does not publish is a compile error, not a silent skip |
| **`JoinNode.timeoutMs`** | A node's `timeoutMs` is enforced; a JOIN's is not — nothing reads it, so a barrier waits forever. Declaring one is a compile WARNING rather than an error, because the design states the absence deliberately and what a barrier timeout should DO (fail the join, or fold what arrived) is an open decision |
| **Crash mid-effect** | The journal survives, the run clock picks a backed-off run up again, and a restarted process re-arms the SLA clock of every gate it re-attaches — but a Task killed mid-effect stays leased. The one path back is an operator `loom rewind`, which now re-arms the leases it undid; there is no automatic reclaim |
| **Approval modes** | Only `single`. `quorum`, `all`, `tiered` and delegation are compile errors, deliberately, rather than silent downgrades |

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

## Why this exists

The predecessor, **EAgent**, is a minimalist agent kernel with an excellent extension
surface — but it holds orchestration state *inside a single agent's transcript*.
Parallel work is a tool call that blocks a turn, background jobs die at process
restart, and its DAG scheduler had to hand-clone the kernel's policy guard. Survivable
for one interactive session; painful in production with many concurrent tasks.

Loom inverts the structure. See
[`design/loom/00-OVERVIEW.md § What EAgent taught us`](design/loom/00-OVERVIEW.md#what-eagent-taught-us)
for the evidence, line by line.

## Documentation

- [`design/loom/`](design/loom/) — the architecture (D1–D14). Start with the
  [index](design/loom/README.md).
- [`design/loom/JOURNAL.md`](design/loom/JOURNAL.md) — append-only implementation log:
  milestone status, decisions taken while building, and the bugs that changed the
  design.
- [`design/loom/99-DOD.md`](design/loom/99-DOD.md) — every requirement, and whether the
  **code proves it** or only the design describes it.
- [`CLAUDE.md`](CLAUDE.md) — invariants and working rules.

## Layout

```
design/loom/       the architecture + implementation journal
packages/core/     the Loom engine — zero runtime dependencies
  src/graph/         compiler, expression language, validation
  src/run/           executor, scheduler, policy, gates, replay
  src/journal/       append-only store (memory + SQLite)
  src/providers/     Anthropic, OpenAI, fallback chains, cassettes
  src/server/        control plane + embedded console
  src/security/      redaction, SecretValue
packages/eagent/   EAgent — the agent kernel and its 65 extensions
scripts/           CI guards and the binary build
```

## EAgent, the predecessor — now a package here

EAgent is the harness Loom grew out of: a minimalist agent kernel with an excellent extension
surface. It is **in this repository**, at `packages/eagent/`, and is developed here.

```bash
npm run eagent            # its CLI
npm run check             # one gate covers both packages
```

It was conformed to Loom's toolchain on the way in — `.ts` import specifiers, no parameter
properties, no `tsx` loader — so both suites run under the same `node --test`. It keeps its own
dependencies (`jiti`); only `@loom/core` is bound by the zero-dependency rule, and core does not
import it.

`loom` is an **orphan branch** that shares no history with `init` by design. `init`, tagged
`eagent-v1`, is where EAgent's own history stayed:

```bash
git show eagent-v1                    # the annotated archive tag
git worktree add ../eagent-ref init   # read it side-by-side
```

That worktree is historical reference only. EAgent is edited at `packages/eagent/`, not there.
