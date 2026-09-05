/**
 * A `StateStore` that reads another store's journal through a per-event rewrite — the way to put
 * an OLD journal in front of `replayRun` without a time machine.
 *
 * Two replay tests need a recording the current engine cannot write: one without
 * `tool.called.argsDigest` (journals before 2026-08-27) and one without the `random` seed effect
 * (journals before 2026-08-24). Recording with the current engine and dropping the field or the
 * events on the way out is byte-for-byte what such a journal looks like to a reader, and it keeps
 * the test honest about what `replayRun` actually consults: `read`, and nothing else.
 *
 * Writes are passed through untouched so the recording can be made through the same object.
 */
import type { JournalEvent } from "../../src/journal/events.ts";
import type { AppendInput, AppendResult, RunFilter, RunSummary, StateStore } from "../../src/journal/store.ts";
import type { RunId, Seq } from "../../src/ids.ts";

export class RewritingStore implements StateStore {
  readonly #inner: StateStore;
  readonly #rewrite: (e: JournalEvent) => JournalEvent | undefined;

  /** `rewrite` returns the event to yield, or `undefined` to drop it. */
  constructor(inner: StateStore, rewrite: (e: JournalEvent) => JournalEvent | undefined) {
    this.#inner = inner;
    this.#rewrite = rewrite;
  }

  append(input: AppendInput): Promise<AppendResult> {
    return this.#inner.append(input);
  }

  async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
    for await (const e of this.#inner.read(runId, fromSeq, toSeq)) {
      const out = this.#rewrite(e);
      if (out !== undefined) yield out;
    }
  }

  head(runId: RunId): Promise<Seq> {
    return this.#inner.head(runId);
  }

  listRuns(limit?: number, filter?: RunFilter): Promise<readonly RunSummary[]> {
    return this.#inner.listRuns(limit, filter);
  }

  close(): void {
    this.#inner.close();
  }
}

/** The journal as a reader before `tool.called.argsDigest` existed would see it. */
export function withoutArgsDigest(inner: StateStore): StateStore {
  return new RewritingStore(inner, (e) => {
    if (e.type !== "tool.called") return e;
    const { argsDigest: _dropped, ...rest } = e.payload as Record<string, unknown>;
    return { ...e, payload: rest } as JournalEvent;
  });
}

/** The journal as a reader before the `random` seed effect existed would see it. */
export function withoutSeeds(inner: StateStore): StateStore {
  return new RewritingStore(inner, (e) => {
    if (e.type !== "effect.started" && e.type !== "effect.completed") return e;
    const key = String((e.payload as { key?: unknown }).key ?? "");
    return key.endsWith(":random:0") ? undefined : e;
  });
}
