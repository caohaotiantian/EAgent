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
  // `unknown` AND NOT `number`, deliberately: `ContextProjection` types `take?: number`, but a
  // projection is JSON a graph author wrote and nothing validates its VALUES. Annotating it
  // `number` here would be a claim about bytes; `readTake` is what actually decides.
  const take = (projection as { take?: unknown }).take;

  let out = value;
  // A PRESENT `take` NEVER MEANS "NO SLICE". `undefined` and `null` are the two ways to declare
  // no bound; every other value is an author asking for one, and the single answer this function
  // may not give such an author is the whole array.
  //
  // `take: 0` IS A SLICE OF ZERO, not the absence of one. Treating it as "no slice" made a
  // projection asking for nothing get everything, which is the wrong direction for a knob whose
  // whole job is to bound what a node sees.
  if (take !== undefined && take !== null) {
    const n = readTake(take);
    // Negative takes from the end — "the last N findings" is the common case. `>= 0` and not
    // `> 0`: `slice(0)` is the whole array, so zero has to fall on the first-N side to mean zero.
    if (Array.isArray(out)) out = n >= 0 ? out.slice(0, n) : out.slice(n);
  }
  if (fields !== undefined && fields.length > 0) {
    out = Array.isArray(out) ? out.map((item) => pickFields(item, fields)) : pickFields(out, fields);
  }
  return out;
}

/**
 * The item count a `take` declares, or a refusal — and NOT `Number()`, which is the bug.
 *
 * Nothing checks this value before it arrives. `compile` runs `unknownKeys` over a
 * `contextProjection` and validates the KEY NAMES only, so `{take: "abc"}` produces zero
 * diagnostics and reaches this function at run time; `graph/validate.ts` is where a compile-time
 * check would belong, and there is none today. So the reading has to happen here, and a
 * `typeof take === "number"` gate would answer the undecidable case with the passing value —
 * a string is "not a slice", so a node asking for three items would be shown all of them.
 *
 * `Number()` LOOKED LIKE THE READER AND IS A COERCION. It maps `""`, `" "`, `[]` and `false` to
 * 0, and 0 is a legitimate bound meaning "show nothing" — so four bounds nobody can read emptied
 * the channel SILENTLY, while `"abc"`, an unreadable bound of exactly the same kind, refused
 * loudly. That is `Number`'s semantics standing in for the author's intent, and it fails in the
 * direction that hides: a node shown an empty array cannot tell it from a channel with no rows.
 *
 * So the vocabulary is stated instead of coerced: a finite number, or a string that PARSES as
 * one — `take: "3"` is what hand-written YAML gives for a quoted number, and it is the one
 * non-number worth reading. Everything else refuses, `""` and `false` and `[]` among them.
 *
 * REFUSED WHATEVER THE VALUE IS, INCLUDING A NON-ARRAY. Whether a `take` is readable is a fact
 * about the DECLARATION, not about what the channel happens to hold on this run; deferring the
 * refusal to `Array.isArray` would make the same broken graph pass one run and fail the next,
 * and would report it at whichever node first read the channel while it held rows. The cost is
 * that a graph carrying an unreadable `take` on a channel that never holds an array now fails
 * where it used to run — that graph was already wrong, and this is the run that says so.
 */
function readTake(take: unknown): number {
  const n = readBound(take);
  if (n === undefined) {
    throw err.validation(CODES.E_GRAPH_INVALID, `contextProjection.take is not an item count: ${describeTake(take)}`);
  }
  return n;
}

/**
 * ONE READER FOR EVERY BOUND IN A PROJECTION, because there is one problem behind them.
 *
 * A projection is written by hand, usually in YAML, where `10` and `"10"` are a quoting accident
 * apart. `readTake` was taught to read the quoted form — "the one non-number worth reading" — and
 * `applyOverflow`, added in the same commit, refused it. Measured: `maxTokens: "10"` produced
 * BYTE-IDENTICAL output to `maxTokens: 10` before that refusal, because both the comparison and
 * the `keep` arithmetic coerce; the refusal turned a working graph into a failing one. Two
 * readers for one quoting problem in one file is the shape a fix round is supposed to close, not
 * open, so there is one.
 */
function readBound(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** The rejected value, rendered so the author can see WHICH one it was. */
function describeTake(take: unknown): string {
  // `JSON.stringify` renders NaN and Infinity as `null`, which is the one word this message must
  // not say, since `null` is the legal way to declare no slice. It also renders `""` and `" "` as
  // quoted strings, which is the whole point for those two.
  if (typeof take === "number") return String(take);
  try {
    return JSON.stringify(take) ?? typeof take;
  } catch {
    return typeof take;
  }
}

function pickFields(value: unknown, fields: readonly string[]): unknown {
  if (value === null || typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // OWN KEYS ON THE READ, `defineProperty` ON THE WRITE — the pair `resources/realm.ts`'s
  // `rebuild` documents and closes, and this is the unfixed copy of it. `f in src` was true for
  // `toString`/`constructor` on every object, so a declared projection copied a HOST FUNCTION
  // into a value that flows into the prompt and into `stateHash`'s canonicalization; and
  // `out["__proto__"] = …` goes through `Object.prototype`'s setter, so a value carrying an own
  // `__proto__` key (which is what `JSON.parse` produces) re-parented the projection instead of
  // being projected into it.
  for (const f of fields) {
    if (Object.hasOwn(src, f)) {
      Object.defineProperty(out, f, { value: src[f], writable: true, enumerable: true, configurable: true });
    }
  }
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

/**
 * THE SAME DEFECT `readTake` CLOSES, ONE FIELD OVER, AND IT IS WORSE HERE.
 *
 * `overflow` reached this `switch` unvalidated, and the switch had no `default`, so an unknown
 * value fell off the end and returned `undefined` — which `projectAll` then wrote OVER the
 * channel, so the node was shown no such channel at all. `maxTokens` was unvalidated too, and
 * `slice(0, NaN)` is `[]`. Measured at rung 2 before this:
 *
 *     {"maxTokens":10,"overflow":"truncate_tail"} -> {"c":["aaaa…    correct
 *     {"maxTokens":10,"overflow":"TRUNCATE_TAIL"} -> {}              the channel VANISHES
 *     {"maxTokens":10,"overflow":"nonsense"}      -> {}              same
 *     {"maxTokens":"abc","overflow":"truncate_tail"} -> {"c":[]}     emptied
 *
 * Nothing checks either field: `compile` runs `unknownKeys` over `contextProjection` and reads
 * the key NAMES only. A bound nobody can read is not a licence to widen, and it is not a licence
 * to silently narrow to nothing either — the node is told a different story than its author
 * wrote, with no diagnostic anywhere. Both refuse now, for the same reason and in the same
 * words as `readTake`.
 *
 * THE COMPILE-TIME HALF BELONGS IN `graph/validate.ts`, where the other projection checks live.
 * That is a pinned kernel file and this refusal is the runtime half; a diagnostic there would
 * make this arm unreachable for any compiled graph, which is the right shape.
 */
function applyOverflow(value: unknown, projection: ContextProjection): unknown {
  // EACH CHECK SITS WHERE ITS VALUE IS CONSUMED, and the first version of this guard put both at
  // the top instead. `projectAll` calls this for EVERY projected channel once the ladder reaches
  // rung 2, so validating eagerly made one typo'd `overflow` anywhere kill the whole assembly —
  // including on a channel that is under its own bound and never reaches the switch, where the
  // typo had been inert and the run correct. Worse, it fires the first time a run's context grows
  // enough to reach rung 2, which may be hours after the graph was published. `overflow` is read
  // by the switch, so the switch refuses it; `maxTokens` is read by the comparison one line down,
  // so the comparison does.
  const bound = readBound((projection as { maxTokens?: unknown }).maxTokens);
  if (bound === undefined || bound <= 0) {
    // `<= 0` and not just "unreadable": a negative bound passed the finite test and then silently
    // did not truncate at all — `rendered.slice(0, -20)` removes nothing — which is the same
    // unread-bound defect with a sign on it.
    throw err.validation(
      CODES.E_GRAPH_INVALID,
      `contextProjection.maxTokens is not a positive token bound: ${describeTake((projection as { maxTokens?: unknown }).maxTokens)}`,
    );
  }
  const rendered = JSON.stringify(value);
  if (estimateTokens(rendered) <= bound) return value;
  switch (projection.overflow) {
    case "error":
      throw err.validation(CODES.E_CONTEXT_OVERFLOW, `a channel projection exceeded ${String(bound)} tokens`);
    case "truncate_tail":
    case "summarize":
      // `summarize` degrades to truncation here; the real summarizer runs at rung 3,
      // where it is an Effect and therefore replayable.
      if (Array.isArray(value)) {
        const keep = Math.max(1, Math.floor(value.length * (bound / estimateTokens(rendered))));
        return value.slice(0, keep);
      }
      return `${rendered.slice(0, bound * 4)}…[truncated]`;
    default:
      // THE ARM THAT WAS MISSING. Without it an unknown rule fell off the end as `undefined` and
      // `projectAll` wrote that over the channel — a bare `TypeError` out of prompt assembly, not
      // a `LoomError`. `overflow: "TRUNCATE_TAIL"` is a plausible thing to write by hand and
      // `compile` reads only the KEY NAMES of `contextProjection`, so it gets this far.
      throw err.validation(
        CODES.E_GRAPH_INVALID,
        `contextProjection.overflow is not a rule this build knows: ${describeTake(projection.overflow)} ` +
          `(expected one of error, truncate_tail, summarize)`,
      );
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

// ---------------------------------------------------------------------------
// Bounding the turn transcript
// ---------------------------------------------------------------------------

/**
 * Tokens a message costs on the wire, including the tool calls it carries.
 *
 * `Message.content` is not the whole message: an assistant turn that calls three tools
 * carries their names and arguments in `toolCalls`, and those are sent. Counting only
 * `content` reports an assistant message that requested a 40 kB argument as costing
 * nothing, which is the shape of request this bound exists to catch.
 */
export function messageTokens(m: Message): number {
  const calls = m.toolCalls === undefined ? 0 : estimateTokens(JSON.stringify(m.toolCalls));
  return estimateTokens(m.content) + calls;
}

export interface BoundedTurns {
  readonly messages: readonly Message[];
  /** 0 when nothing was folded, 3 when the summarizer ran — the ladder's own numbering. */
  readonly rung: 0 | 3;
  /** How many of the original messages the summary replaced. 0 when `rung` is 0. */
  readonly folded: number;
  /** True when even the un-foldable tail exceeds the budget. Reported, never silent. */
  readonly overBudget: boolean;
}

/**
 * Keep an agent's own turn transcript inside the context budget.
 *
 * `assembleContext` bounds what a node is GIVEN. This bounds what it ACCUMULATES, and the
 * two were never connected: `#runAgent` assembled once, before its turn loop, then pushed
 * an assistant message and a tool result per turn into the same array it had already
 * measured. Reproduced on an eight-turn loop with 16 kB tool results against a 2,000-token
 * budget — the request that crossed the provider boundary was ~28,000 tokens, fourteen
 * times the bound, with no rung fired and no `E_CONTEXT_OVERFLOW`. The failure arrives from
 * the provider as a 400, after the spend.
 *
 * THE CUT IS ONLY EVER BEFORE AN ASSISTANT MESSAGE, and that is a correctness constraint
 * rather than a nicety. A tool result is only meaningful beside the call that produced it;
 * providers reject a `tool` message whose `tool_call_id` names a call no longer in the
 * transcript. So the fold point walks forward to the next assistant boundary rather than
 * cutting where the arithmetic happens to land — the same rule EAgent's `compact` reached
 * by a different route, and the one thing its implementation got right that Loom's ladder
 * did not have to think about while `turns` was always empty.
 *
 * `messages[0]` is the node's own instruction envelope and is never folded: it carries the
 * prompt and the channel state, so folding it would summarise away the task itself.
 *
 * The summariser is an EFFECT in the caller, keyed per turn, so replay serves the same
 * summary and this stays deterministic. A caller that passes no summariser gets the
 * transcript back untouched with `overBudget` set — the bound is then a report, not a fix,
 * which is the honest behaviour for a replay that has no provider.
 */
export async function boundTurns(
  messages: readonly Message[],
  maxTokens: number,
  summarize?: (text: string) => Promise<string>,
): Promise<BoundedTurns> {
  const cost = (ms: readonly Message[]): number => ms.reduce((a, m) => a + messageTokens(m), 0);
  if (cost(messages) <= maxTokens) return { messages, rung: 0, folded: 0, overBudget: false };
  if (summarize === undefined || messages.length < 3) {
    return { messages, rung: 0, folded: 0, overBudget: true };
  }

  // Candidate cut points, newest first: every assistant boundary after the envelope. The
  // first one whose tail fits is the least we can fold, which keeps the most detail.
  const boundaries: number[] = [];
  for (let i = 1; i < messages.length; i++) if (messages[i]!.role === "assistant") boundaries.push(i);
  if (boundaries.length === 0) return { messages, rung: 0, folded: 0, overBudget: true };

  const envelope = messages[0]!;
  let cut = boundaries[0]!;
  for (let b = boundaries.length - 1; b >= 0; b--) {
    const candidate = boundaries[b]!;
    // The summary itself costs tokens; it is bounded by the summariser's own prompt, so a
    // conservative reserve keeps the arithmetic honest rather than optimistic.
    if (messageTokens(envelope) + SUMMARY_RESERVE_TOKENS + cost(messages.slice(candidate)) <= maxTokens) {
      cut = candidate;
      break;
    }
    cut = candidate;
  }

  const folded = messages.slice(1, cut);
  if (folded.length === 0) return { messages, rung: 0, folded: 0, overBudget: true };

  const summary = await summarize(folded.map((m) => `${m.role}: ${m.content}`).join("\n"));
  const out: Message[] = [
    envelope,
    { role: "user", content: `[earlier turns, summarised]\n${summary}` },
    ...messages.slice(cut),
  ];
  return { messages: out, rung: 3, folded: folded.length, overBudget: cost(out) > maxTokens };
}

/**
 * Headroom left for the summary when choosing a cut point.
 *
 * The summariser is told "under 200 words"; 200 words is ~260 tokens, and the reserve is
 * rounded up from there rather than fitted to it, because a model that overshoots its word
 * limit must not be the thing that puts the request back over the budget.
 */
const SUMMARY_RESERVE_TOKENS = 400;
