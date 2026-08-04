# Loom

A multi-agent collaboration and orchestration framework where **the executable graph
is the runtime**, an agent loop is one node type inside it, and every durable fact
about a run is an append-only journal entry — so parallelism, human oversight,
replay, and observability are one mechanism seen from different angles.

> **Status: design, pre-implementation.** No implementation exists on this branch yet.
> The complete architecture is in [`design/loom/`](design/loom/). Read
> [`design/loom/README.md`](design/loom/README.md) first.

## Why this exists

The predecessor, **EAgent**, is a minimalist agent kernel with an excellent extension
surface — but it holds orchestration state *inside a single agent's transcript*.
Parallel work is a tool call that blocks a turn, background jobs die at process
restart, and the DAG scheduler had to hand-clone the kernel's policy guard. That is
survivable for one interactive session and painful in production with many concurrent
tasks.

Loom inverts the structure. See
[`design/loom/00-OVERVIEW.md § What EAgent taught us`](design/loom/00-OVERVIEW.md#what-eagent-taught-us)
for the evidence, line by line.

## The archive

EAgent v1 is frozen and remains fully readable:

```bash
git show eagent-v1                 # the annotated archive tag
git checkout init                  # the frozen branch
git worktree add ../eagent-ref init   # read it side-by-side while building Loom
```

`loom` is an **orphan branch** — it shares no history with `init` by design. Nothing
in Loom imports, vendors, or depends on EAgent code; EAgent is a reference text, not a
dependency.

## Layout (target)

```
design/loom/          the architecture — read this first
packages/core/        graph compiler, executor, scheduler, journal      (not yet built)
packages/server/      control plane: HTTP ingress, SSE, gate broker     (not yet built)
packages/ui/          React console: graph canvas, oversight queue      (not yet built)
workflows/            GraphSpec YAML, versioned as resources            (not yet built)
```
