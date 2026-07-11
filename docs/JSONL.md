# JSONL event schema

The two machine-readable front ends emit the **same** line-delimited JSON stream:
the CLI `--json` mode (`src/cli.ts`) and the HTTP `POST /run` stream
(`src/server.ts`). Both serialize through one shared mapper, `src/jsonl.ts`
(`eventToJsonl`), which is the single source of truth for the wire format — so a
consumer can write one parser for both.

Each line is a complete JSON object terminated by `\n`. Every object carries a
`type` discriminator; parse per line (`JSON.parse` each non-empty line) and switch
on `type`. Key order within an object is stable but consumers should not depend on
it. In `--json` mode stdout carries **only** these events; all human/diagnostic
output goes to stderr.

## Which events each front end emits

| `type` | CLI `--json` | HTTP `/run` | notes |
| --- | :---: | :---: | --- |
| `text_delta` | yes | yes | streaming |
| `reasoning_delta` | yes | yes | streaming model reasoning |
| `message` | yes | yes | one per committed message |
| `tool_start` | yes | yes | |
| `tool_end` | yes | yes | |
| `usage` | yes | yes | per-request token accounting |
| `agent_end` | yes | yes | canonical terminal; `session` server-only |
| `error` | yes | yes | error terminal |
| `action_required` | — | yes | server-only elicitation |
| `done` | — | yes | **deprecated** legacy terminal (see below) |

The six streaming events (`text_delta`, `reasoning_delta`, `message`,
`tool_start`, `tool_end`, `usage`) plus `agent_end` and `error` are emitted by
**both** front ends. The `session` field on `agent_end` and the entire
`action_required` event are **server-only**: the CLI is single-session and has no
elicitation channel over the wire.

## Canonical event shapes

### `text_delta`

An incremental chunk of assistant text.

```json
{ "type": "text_delta", "text": "partial output text" }
```

### `reasoning_delta`

An incremental chunk of the model's reasoning ("thinking"), when the provider
exposes it. Over HTTP this streams model reasoning to the consumer.

```json
{ "type": "reasoning_delta", "text": "partial reasoning text" }
```

### `message`

A committed message in the transcript.

```json
{
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "..." }]
}
```

- `role` is one of `system`, `user`, `assistant`, `tool`.
- `content` is the message's array of content blocks (`text`, `tool_call`,
  `tool_result`, `thinking`, `image`).

### `tool_start`

A tool call about to run.

```json
{ "type": "tool_start", "id": "call_1", "name": "read", "arguments": { "path": "README.md" } }
```

- `id` is the tool-call id (correlate with the matching `tool_end`).
- `arguments` is the decoded argument object.

### `tool_end`

A tool call's result.

```json
{ "type": "tool_end", "id": "call_1", "name": "read", "isError": false, "content": "..." }
```

- `id` matches the `tool_start` `id`.
- `isError` defaults to `false` when the tool did not flag an error.
- `content` is the rendered, model-legible result text.

### `usage`

Token accounting for one request.

```json
{
  "type": "usage",
  "usage": { "inputTokens": 12, "outputTokens": 34 },
  "cumulative": { "inputTokens": 12, "outputTokens": 34 }
}
```

- `usage` is this request's delta; `cumulative` is the running total.
- Each `Usage` object always carries `inputTokens` and `outputTokens`; the
  optional `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens` appear only
  when the provider reports them.

### `agent_end`

The canonical terminal of a turn.

```json
{ "type": "agent_end", "reason": "end_turn", "usage": { "inputTokens": 12, "outputTokens": 34 } }
```

- `reason` is one of `end_turn`, `tool_use`, `max_tokens`, `stop`, `error`,
  `refusal`, `content_filter`.
- `usage` is the cumulative token total.
- `session` (server-only) is appended when the `/run` request carried a session
  id:

  ```json
  { "type": "agent_end", "reason": "end_turn", "usage": { "inputTokens": 12, "outputTokens": 34 }, "session": "abc" }
  ```

  The CLI never emits `session` (it is single-session).

On a successful turn `agent_end` is the last line — a consumer reading
"last line = terminal" gets `agent_end` on both front ends. On a failing turn the
front ends diverge; see [`error`](#error) below.

### `error`

An error terminal, emitted when a turn fails. The two front ends diverge on what
follows it. Over the HTTP `/run` stream `error` is emitted **instead of**
`agent_end`: `streamRun` writes `agent_end` explicitly, and that write is skipped
when the turn throws. On the CLI, by contrast, a failing turn emits the `error`
line **and then** a trailing `agent_end` (with `reason: "error"`) — the kernel
emits `agent_end` from a `finally` that runs on every path, and the CLI `--json`
renderer subscribes to that hook. So on a failing turn the CLI's last line is
`agent_end` while the server's is `error`.

```json
{ "type": "error", "where": "agent.run", "message": "..." }
```

- `where` labels the failure site. On the CLI it is the precise site forwarded
  from the error hook; over HTTP it is the coarse constant `"agent.run"` for the
  whole turn.
- `message` is the error text.

### `action_required` (server-only)

Emitted when a turn pauses for an elicitation; the consumer answers via
`POST /answer` with the matching `id`.

```json
{ "type": "action_required", "id": 1, "question": "Proceed?", "options": ["yes", "no"] }
```

- `options` is the list of choices, or `null` for a free-form answer.

## Deprecation: `done` → `agent_end`

The HTTP `/run` stream currently emits **both** terminal lines at the end of a
turn:

```json
{ "type": "done", "reason": "end_turn", "session": "abc", "usage": { "inputTokens": 12, "outputTokens": 34 } }
{ "type": "agent_end", "reason": "end_turn", "usage": { "inputTokens": 12, "outputTokens": 34 }, "session": "abc" }
```

`done` is **deprecated**. It is retained during a deprecation window and will be
removed in a future release. Consumers should migrate to `agent_end`, the
canonical terminal — it matches the kernel lifecycle event name and the CLI.

The two lines are emitted in order — `done` first, `agent_end` **last** — so a
consumer that reads "the last line is the terminal" already gets `agent_end`, and
one still scanning for `type: "done"` continues to find it until removal.
