/**
 * Record/replay "cassettes" for any provider.
 *
 * Because a provider is just `request -> stream of events`, you can wrap one to
 * tee its event stream to disk (`RecordingProvider`), then replay that exact
 * stream later with no network (`ReplayProvider`). This is the standard
 * record/replay testing pattern (VCR/Polly) applied to LLMs: capture a real
 * model's behavior once, then run it deterministically in CI or while debugging.
 *
 * The cassette is JSONL — one line per `stream()` call, holding that call's
 * array of `StreamEvent`s. Replay is order-based: the Nth call returns the Nth
 * recorded interaction, which matches how scripted, deterministic sessions run.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { CompletionRequest, Provider, StreamEvent } from "../kernel/types.js";

/** Wrap a provider so every `stream()` is appended to a JSONL cassette. */
export class RecordingProvider implements Provider {
  constructor(
    private readonly inner: Provider,
    private readonly path: string,
    /** Truncate the cassette on construction (default true). */
    fresh = true,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    if (fresh) writeFileSync(path, "");
  }

  get name(): string {
    return this.inner.name;
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const events: StreamEvent[] = [];
    for await (const ev of this.inner.stream(req)) {
      events.push(ev);
      yield ev;
    }
    appendFileSync(this.path, JSON.stringify(events) + "\n");
  }
}

/** Replay a cassette recorded by `RecordingProvider`, with no network. */
export class ReplayProvider implements Provider {
  readonly name = "replay";
  readonly #interactions: StreamEvent[][];
  #index = 0;

  constructor(path: string) {
    this.#interactions = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as StreamEvent[]);
  }

  /** How many interactions remain to be replayed. */
  get remaining(): number {
    return this.#interactions.length - this.#index;
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    const events = this.#interactions[this.#index++];
    if (!events) {
      throw new Error(`ReplayProvider: cassette exhausted after ${this.#index - 1} interactions`);
    }
    for (const ev of events) yield ev;
  }
}
