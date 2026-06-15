# Example extensions

Worked examples you can read, run, and copy. Each is a single TypeScript file
loaded with no build step. Load one ad hoc with `--ext`, or drop it into
`.eagent/extensions/` (project) or `~/.eagent/extensions/` (user) to have it
auto-discovered, then edit it and run `/reload` to see live redefinition.

```bash
eagent --ext examples/extensions/clock.ts
```

| File | Demonstrates |
| ---- | ------------ |
| `clock.ts` | a tool, a `transformContext` hook, a `beforeToolCall` safety guard, a command, and persistent `store` state — the whole `ExtensionAPI` in miniature |
| `echo-provider.ts` | registering a custom `Provider` (the LLM abstraction) — try `--provider shout` |
| `notes-rag.ts` | retrieval-augmented context: a `note` tool plus a `transformContext` hook that injects relevant notes (the RAG pattern, kernel-free) |

The full author's guide is in [`../docs/EXTENSIONS.md`](../docs/EXTENSIONS.md);
the design rationale is in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

These examples import the kernel by relative path (`../../src/kernel/...`)
because they live inside this repo. An installed extension would import from the
published package instead (`import { defineTool } from "eagent"`).
