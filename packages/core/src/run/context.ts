/**
 * Deterministic context assembly, and the compaction ladder.
 *
 * Context here is a FUNCTION of declared inputs, not an accumulated transcript. That
 * is the difference between a context you can reason about and one that mysteriously
 * grows: there is no array to prune, because each Task rebuilds its context from the
 * channels its node declared.
 *
 * The consequence is that the ladder below fires only when a SINGLE node's declared
 * inputs are genuinely too large — which is a modelling problem the author can see and
 * fix, rather than an emergent one nobody owns.
 *
 * EAgent needed two extensions (`prune`, `compact`) reacting to a growing `#messages`
 * array. There is no equivalent here because there is no growing array.
 *
 * See design/loom/03-RUNTIME.md D6.7.
 */

import { digest, type Digest } from "../canonical.ts";
import { CODES, err } from "../errors.ts";
import type { ChannelSpec, ContextProjection } from "../state/channels.ts";
import type { Message } from "./registry.ts";

/**
 * Approximate token count.
 *
 * Four characters per token is wrong for every model and right enough for a budget
 * decision. The alternative — a real tokenizer — is a per-provider dependency, and the
 * ladder's job is to keep a prompt inside a window, not to predict a bill. Cost
 * accounting uses the provider's reported usage, which is exact.
 */
export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

export type SectionName =
  | "system"
  | "instruction"
  | "channels"
  | "retrieved"
  | "turns"
  | "tool_results";

export interface Section {
  readonly name: SectionName;
  /** Higher survives longer. Dropped in ascending order at rung 1. */
  readonly priority: number;
  readonly text: string;
  readonly tokens: number;
}

/** Which rung of the ladder was reached. `0` means no compaction was needed. */
export type CompactionRung = 0 | 1 | 2 | 3 | 4;

export interface AssembledContext {
  readonly messages: readonly Message[];
  /**
   * The channel map AFTER projection and compaction.
   *
   * Returned separately so a caller can keep its own prompt envelope while still
   * getting the ladder's bounding — the envelope is a contract with the model, the
   * ladder is a contract with the context window, and they are different concerns.
   */
  readonly channels: Readonly<Record<string, unknown>>;
  readonly sections: readonly { name: SectionName; tokens: number; kept: boolean }[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly rung: CompactionRung;
  readonly hash: Digest;
}

export interface AssembleInput {
  readonly system: string;
  readonly instruction: string;
  /** Channel values the node declared as reads, already branch-resolved. */
  readonly channels: Readonly<Record<string, unknown>>;
  readonly channelSpecs: Readonly<Record<string, ChannelSpec>>;
  /** Prior turns of THIS node's own loop. Bounded by `maxTurns` already. */
  readonly turns?: readonly Message[];
  readonly retrieved?: readonly string[];
}

export interface AssembleOptions {
  /** Total prompt budget in tokens, excluding the reserve for output. */
  readonly maxTokens: number;
  /** Sections at or below this priority are dropped first (rung 1). */
  readonly dropBelowPriority?: number;
  /**
   * Summarizer for rung 3. It is an EFFECT in the executor, so replay serves the same
   * summary and the ladder stays deterministic. Absent ⇒ rung 3 is skipped.
   */
  readonly summarize?: (text: string) => Promise<string>;
}

const DEFAULT_PRIORITY: Readonly<Record<SectionName, number>> = {
  system: 100,
  instruction: 90,
  channels: 70,
  turns: 50,
  tool_results: 40,
  retrieved: 30,
};

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * What a node actually sees of a channel.
 *
 * DEVIATION from D5.3's `select: "$[*].{...}"` JSONPath: projections are declarative
 * field lists and slices instead. A path language would need its own parser, its own
 * error taxonomy, and its own determinism argument — for a feature whose real use is
 * "show me these three fields of the last twenty items".
 */
export function project(value: unknown, projection: ContextProjection | undefined): unknown {
  if (projection === undefined) return value;
  const fields = (projection as { fields?: readonly string[] }).fields;
  const take = (projection as { take?: number }).take;

  let out = value;
  if (Array.isArray(out) && take !== undefined && take !== 0) {
    // Negative takes from the end — "the last N findings" is the common case.
    out = take > 0 ? out.slice(0, take) : out.slice(take);
  }
  if (fields !== undefined && fields.length > 0) {
    out = Array.isArray(out) ? out.map((item) => pickFields(item, fields)) : pickFields(out, fields);
  }
  return out;
}

function pickFields(value: unknown, fields: readonly string[]): unknown {
  if (value === null || typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in src) out[f] = src[f];
  return out;
}

// ---------------------------------------------------------------------------
// Assembly + the ladder
// ---------------------------------------------------------------------------

/**
 * Build a context, applying the compaction ladder in order until it fits.
 *
 * | Rung | Action | Deterministic |
 * |---|---|---|
 * | 0 | it already fits | yes |
 * | 1 | drop sections below the priority floor | yes |
 * | 2 | apply each channel projection's `truncate_tail` | yes |
 * | 3 | summarize the oldest turns via the injected summarizer | yes — it is a recorded Effect |
 * | 4 | hard-truncate with an explicit marker | yes |
 * | — | still over ⇒ `E_CONTEXT_OVERFLOW` | — |
 *
 * Rung 4 leaves a visible `[...truncated N tokens...]` marker rather than silently
 * dropping text: a model reasoning over a truncated prompt should be told it is.
 */
export async function assembleContext(
  input: AssembleInput,
  opts: AssembleOptions,
): Promise<AssembledContext> {
  let channels = projectAll(input, /* truncateTail */ false);
  let sections = buildSections(input, channels);
  const tokensBefore = total(sections);
  let rung: CompactionRung = 0;
  const dropped = new Set<SectionName>();

  // Rung 1 — drop by priority.
  if (total(sections) > opts.maxTokens && opts.dropBelowPriority !== undefined) {
    rung = 1;
    const floor = opts.dropBelowPriority;
    for (const s of [...sections].sort((a, b) => a.priority - b.priority)) {
      if (total(sections) <= opts.maxTokens) break;
      if (s.priority > floor) continue;
      dropped.add(s.name);
      sections = sections.filter((x) => x.name !== s.name);
    }
  }

  // Rung 2 — honour each channel projection's declared overflow.
  if (total(sections) > opts.maxTokens) {
    rung = 2;
    channels = projectAll(input, true);
    sections = buildSections(input, channels).filter((s) => !dropped.has(s.name));
  }

  // Rung 3 — summarize the oldest turns. A recorded Effect, so replay reproduces it.
  if (total(sections) > opts.maxTokens && opts.summarize !== undefined) {
    rung = 3;
    const turns = sections.find((s) => s.name === "turns");
    if (turns !== undefined && turns.tokens > 0) {
      const summary = await opts.summarize(turns.text);
      sections = sections.map((s) =>
        s.name === "turns" ? { ...s, text: summary, tokens: estimateTokens(summary) } : s,
      );
    }
  }

  // Rung 4 — hard truncate, visibly.
  if (total(sections) > opts.maxTokens) {
    rung = 4;
    sections = hardTruncate(sections, opts.maxTokens);
  }

  const tokensAfter = total(sections);
  if (tokensAfter > opts.maxTokens) {
    throw err.validation(
      CODES.E_CONTEXT_OVERFLOW,
      `context is ${tokensAfter} tokens after compaction, over the ${opts.maxTokens} budget`,
      { details: { tokensBefore, tokensAfter, budget: opts.maxTokens, rung } },
    );
  }

  const body = sections.filter((s) => s.name !== "system");
  const messages: Message[] = [{ role: "user", content: body.map((s) => s.text).join("\n\n") }];

  return {
    messages,
    channels,
    sections: buildSections(input, projectAll(input, false)).map((s) => ({
      name: s.name,
      tokens: s.tokens,
      kept: sections.some((k) => k.name === s.name),
    })),
    tokensBefore,
    tokensAfter,
    rung,
    // Hashes the ASSEMBLED result, so a cache keyed on it is correct across compaction.
    hash: digest({ system: input.system, sections: sections.map((s) => [s.name, s.text]) }),
  };
}

/** Apply each channel's declared projection (and, at rung 2, its overflow rule). */
function projectAll(input: AssembleInput, truncateTail: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Sorted, so two assemblies of the same state render byte-identically and therefore
  // hash the same.
  for (const name of Object.keys(input.channels).sort()) {
    const projection = input.channelSpecs[name]?.contextProjection;
    let value = project(input.channels[name], projection);
    if (truncateTail && projection !== undefined) value = applyOverflow(value, projection);
    out[name] = value;
  }
  return out;
}

function buildSections(input: AssembleInput, channels: Readonly<Record<string, unknown>>): Section[] {
  const out: Section[] = [];
  const add = (name: SectionName, text: string): void => {
    if (text === "") return;
    out.push({ name, priority: DEFAULT_PRIORITY[name], text, tokens: estimateTokens(text) });
  };

  add("system", input.system);
  add("instruction", input.instruction);

  const parts: string[] = [];
  for (const name of Object.keys(channels)) parts.push(`${name}: ${JSON.stringify(channels[name])}`);
  add("channels", parts.join("\n"));

  add("retrieved", (input.retrieved ?? []).join("\n\n"));
  add("turns", (input.turns ?? []).map((m) => `${m.role}: ${m.content}`).join("\n"));
  return out;
}

function applyOverflow(value: unknown, projection: ContextProjection): unknown {
  const rendered = JSON.stringify(value);
  if (estimateTokens(rendered) <= projection.maxTokens) return value;
  switch (projection.overflow) {
    case "error":
      throw err.validation(CODES.E_CONTEXT_OVERFLOW, `a channel projection exceeded ${projection.maxTokens} tokens`);
    case "truncate_tail":
    case "summarize":
      // `summarize` degrades to truncation here; the real summarizer runs at rung 3,
      // where it is an Effect and therefore replayable.
      if (Array.isArray(value)) {
        const keep = Math.max(1, Math.floor(value.length * (projection.maxTokens / estimateTokens(rendered))));
        return value.slice(0, keep);
      }
      return `${rendered.slice(0, projection.maxTokens * 4)}…[truncated]`;
  }
}

/** Sections that are a contract with the model, never padding to be cut. */
const INVIOLABLE: ReadonlySet<SectionName> = new Set<SectionName>(["system", "instruction"]);

function hardTruncate(sections: readonly Section[], budget: number): Section[] {
  // Truncate the LOWEST-priority sections first, and never the inviolable ones: a
  // system prompt cut to two tokens "fits" and is useless, which is a worse outcome
  // than failing loudly. If those alone exceed the budget the caller has a modelling
  // problem, and E_CONTEXT_OVERFLOW is the right answer.
  const ordered = [...sections].sort((a, b) => b.priority - a.priority);
  const out: Section[] = [];
  let used = 0;
  for (const s of ordered) {
    if (INVIOLABLE.has(s.name)) {
      out.push(s);
      used += s.tokens;
    }
  }
  for (const s of ordered) {
    if (INVIOLABLE.has(s.name)) continue;
    const room = budget - used;
    if (room <= 0) continue;
    if (s.tokens <= room) {
      out.push(s);
      used += s.tokens;
      continue;
    }
    // The MARKER COSTS TOKENS TOO. Cutting to `room` and then appending it overshoots
    // the budget by exactly the marker's length — which is how this first failed.
    const marker = `\n[...truncated ${s.tokens - room} tokens...]`;
    const markerTokens = estimateTokens(marker);
    const body = Math.max(0, room - markerTokens);
    const text = s.text.slice(0, body * 4) + marker;
    out.push({ ...s, text, tokens: estimateTokens(text) });
    used = budget;
  }
  // Restore declaration order for stable rendering.
  return out.sort((a, b) => b.priority - a.priority);
}

function total(sections: readonly Section[]): number {
  return sections.reduce((a, s) => a + s.tokens, 0);
}
