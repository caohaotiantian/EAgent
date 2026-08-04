# Loom

A multi-agent collaboration and orchestration framework where **the executable graph
is the runtime**, an agent loop is one node type inside it, and every durable fact
about a run is an append-only journal entry — so parallelism, human oversight, replay,
and observability are one mechanism seen from different angles.

```bash
npm install && npm run build:binary   # → bin/loom, one file, 0 third-party modules
./bin/loom serve                      # console + API on :8787, from an empty directory
```

## What works today

| | |
|---|---|
| **Graph compiler** | 21 validation rules, aggregated diagnostics with suggested fixes, resource pinning |
| **Executor** | Parallel fan-out, branch-ordered joins, bounded loops, retries, compensation edges |
| **Durability** | Append-only journal on `node:sqlite`; a run survives `kill -9` and resumes in another process |
| **Human oversight** | Three postures by configuration alone; gates are rows, so a suspended run holds zero worker slots |
| **Replay** | Re-executes with every effect served from the journal — zero model calls, zero side effects |
| **Providers** | Anthropic + OpenAI over `fetch`+SSE, normalized error taxonomy, declarative fallback chains |
| **Console** | Ships inside the binary. Graph canvas, live SSE, approve/reject queue |
| **Gates** | `npm run check` — 386 tests, offline, no API key; zero-dep and public-surface guards |

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

loom compile graphs/copy.json
loom run     graphs/copy.json --input '{"source":"input.txt"}'
loom replay  <runId> --graph graphs/copy.json   # verifies; touches nothing
loom trace   <runId> --graph graphs/copy.json   # spans + graph conformance
loom serve                                       # console at http://127.0.0.1:8787
```

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
packages/core/     the engine — zero runtime dependencies
  src/graph/         compiler, expression language, validation
  src/run/           executor, scheduler, policy, gates, replay
  src/journal/       append-only store (memory + SQLite)
  src/providers/     Anthropic, OpenAI, fallback chains, cassettes
  src/server/        control plane + embedded console
  src/security/      redaction, SecretValue
scripts/           CI guards and the binary build
../eagent-ref      EAgent v1, read-only reference worktree
```

## The archive

EAgent v1 is frozen and remains fully readable:

```bash
git show eagent-v1                    # the annotated archive tag
git worktree add ../eagent-ref init   # read it side-by-side
```

`loom` is an **orphan branch** — it shares no history with `init` by design. Nothing in
Loom imports, vendors, or depends on EAgent code; EAgent is a reference text.
