# Terminal UI

EAgent has two terminal surfaces, split by audience:

1. **`eagent` — the interactive TUI** (`tui/`), an Ink 7 + React 19 application
   modelled on Claude Code's interactive mode. This is the human product.
2. **`eagent-headless` — the machine CLI** (`src/cli.ts`), non-interactive only:
   `--eval`, `--json`, and piped batch. It mounts no display, so no cursor,
   alt-screen, or spinner byte can reach a pipe by construction.

> **Status:** the excision has landed — the previous plain renderer, its view
> model, and the `web/` SPA are removed. The `tui/` package is being built in
> phases; until it lands, only the headless CLI and `eagent-serve` are usable.
> See `.agent/plan.md` on the working branch for the phase sequence.

## Why a package, not a directory

The engine under `src/` keeps **zero runtime dependencies** (`jiti` only), which
is what lets it be embedded as a library without dragging React into a consumer's
tree. Ink and React therefore live in `tui/`, a separate package that depends on
the engine rather than the other way round. `test/zero-dep.test.ts` enforces the
boundary: no `ink`/`react` import may appear under `src/` or `test/`.

## The headless CLI

```bash
eagent-headless --eval "summarise src/kernel/agent.ts"   # one turn, then exit
eagent-headless --json < prompts.txt                      # JSONL lifecycle events
cat prompts.txt | eagent-headless                         # batch, one line per turn
```

Assistant text streams to **stdout** verbatim, so `--eval … | tee` yields the
answer and nothing else. Tool calls, reasoning annotations, warnings, and errors
go to **stderr**, so redirecting stdout leaves a clean transcript. In `--json`
mode stdout carries only JSONL lifecycle events (see [`JSONL.md`](JSONL.md)) and
every human-facing line moves to stderr, so a consumer's per-line `JSON.parse`
never hits a non-JSON line.

Being headless is a semantic, not merely a missing display: there is no one to
prompt, so a capability request follows the `--yolo` policy and a mid-turn
elicitation resolves to "no answer", letting the `ask` tool's absence-fallback
carry the run forward.

## The HTTP host

`eagent-serve` exposes the same agent over HTTP, including read-mostly monitor
endpoints (`GET /sessions`, `GET /sessions/:id/events`, `GET /events`,
`POST /sessions/:id/stop`). The TUI's multi-session monitor is a client of those
endpoints. The server no longer serves static assets — a bare `GET /` returns a
plain-text liveness line.
