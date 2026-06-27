/**
 * goal — pin the run's objective + acceptance criteria, with an advisory
 * end-of-run completion check.
 *
 * Long agentic runs drift: as tool output piles up, the original user turn —
 * the *why* of the run — gets buried, and the model loses the thread. `todo`
 * externalizes the *plan* (the steps); `output-contract` validates *schema*-
 * shaped output; `goal` externalizes the *done-definition* — the natural-
 * language objective and the bullet criteria that say when it is satisfied.
 *
 * Its core mechanism is anti-drift. On every turn `transformContext` injects ONE
 * ephemeral system note that re-pins the objective and criteria nearest the live
 * turn, so the model keeps them in view even after the first user message is
 * megabytes back. The note is a NEW array element marked `meta.ephemeral` — it
 * never mutates or enters the durable transcript. With no objective set the
 * extension is fully inert: `transformContext` returns its input BY REFERENCE
 * and `agent_end` does nothing — byte-identical to absence — so "on by default"
 * costs nothing until `/goal set` or a `setgoal` call.
 *
 * On `agent_end` it runs a deterministic, offline, lexical *coverage* heuristic
 * over the final answer (all text blocks of the last assistant message, the
 * multi-block harvest) and only *warns* (`log.warn` + `ui.notify`) about criteria
 * that look unaddressed. It is honestly a heuristic advisory — it surfaces
 * *possibly* unaddressed criteria, it does not assert correctness. It never
 * blocks, never alters `reason`, never writes the transcript, and fails OPEN
 * (any throw is swallowed). An opt-in model-judged review (off by default, the
 * `drift-probe` tool-less sub-call shape) can upgrade the heuristic where a
 * provider is reachable and degrades cleanly to the lexical check offline.
 *
 * State is per-activation and session-scoped (mirrors `todo`); only the model-
 * judge toggle is persisted in `store`. The `setgoal` tool only records strings
 * in memory and echoes a render — no filesystem/shell/network/code side effect —
 * so it declares NO capability and runs even under `fallback:"deny"`. Ships ON;
 * hard-disabled by `EAGENT_GOAL=off`. The judge sub-feature ships OFF (an extra
 * paid call per run-end) and is enabled with `/goal judge on`.
 */

import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { Message, StopReason } from "../kernel/types.js";
import { text } from "../kernel/types.js";

// -- lexical-coverage constants (Design §7) ---------------------------------

/**
 * A criterion is flagged "unaddressed" when its significant-token coverage in
 * the final answer falls below this fraction. Conservative (0.5) like
 * `drift-probe`'s 25% regression bar — better to miss a borderline gap than to
 * cry wolf on a criterion the answer paraphrased.
 */
export const COVERAGE_THRESHOLD = 0.5;

/** Tokens shorter than this are dropped as non-significant (articles, ops). */
const MIN_TOKEN_LENGTH = 3;

/**
 * A small, fixed English stopword set (length >= MIN_TOKEN_LENGTH ones only —
 * shorter words are already dropped by the length filter). Kept tiny and
 * literal so the check is locale-free and identical on every platform.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "that",
  "this",
  "with",
  "when",
  "then",
  "into",
  "from",
  "has",
  "have",
  "but",
  "not",
  "all",
  "any",
  "its",
  "via",
  "per",
]);

/**
 * Whole-word, case-insensitive token presence — the `drift-probe.containsToken`
 * idiom (a private helper there; re-implemented locally rather than editing a
 * sibling). Accept `token` only when the characters immediately before and after
 * an occurrence are non-alphanumeric or absent, so `ast` matches `AST` but not
 * `fast`. Pure ASCII-class logic, identical on macOS/Linux/Windows.
 */
export function containsToken(haystack: string, token: string): boolean {
  if (token.length === 0) return false;
  const hay = haystack.toLowerCase();
  const t = token.toLowerCase();
  const isWord = (c: string | undefined): boolean => c !== undefined && /[a-z0-9]/.test(c);
  let from = 0;
  for (;;) {
    const i = hay.indexOf(t, from);
    if (i === -1) return false;
    if (!isWord(hay[i - 1]) && !isWord(hay[i + t.length])) return true;
    from = i + 1;
  }
}

/**
 * Tokenize a criterion into significant tokens: lowercase, split on runs of
 * non-alphanumerics, drop stopwords and tokens shorter than MIN_TOKEN_LENGTH.
 * Pure and deterministic — no locale, no ICU.
 */
export function significantTokens(criterion: string): string[] {
  return criterion
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(tok));
}

/**
 * Fraction of a criterion's significant tokens present (whole-word) in the
 * final answer, in `[0, 1]`. A criterion with NO significant tokens counts as
 * fully covered — there is nothing to miss (mirrors `scoreProbe`'s empty-
 * expected handling).
 */
export function coverageOf(finalAnswer: string, criterion: string): number {
  const tokens = significantTokens(criterion);
  if (tokens.length === 0) return 1;
  const hit = tokens.filter((tok) => containsToken(finalAnswer, tok)).length;
  return hit / tokens.length;
}

/** The per-criterion verdict of a completion check. */
export interface CriterionResult {
  criterion: string;
  coverage: number;
  addressed: boolean;
}

/**
 * Run the deterministic lexical coverage check over the final answer, one
 * `CriterionResult` per criterion. Pure and synchronous — no model call, no I/O
 * — so a scripted final answer yields known, asserted numbers.
 */
export function checkCriteria(
  finalAnswer: string,
  criteria: readonly string[],
  threshold: number = COVERAGE_THRESHOLD,
): CriterionResult[] {
  return criteria.map((criterion) => {
    const coverage = coverageOf(finalAnswer, criterion);
    return { criterion, coverage, addressed: coverage >= threshold };
  });
}

/** Concatenate an assistant message's text blocks (`risk-guard`/`lastText`). */
function textOf(message: Message): string {
  let out = "";
  for (const b of message.content) if (b.type === "text") out += b.text;
  return out;
}

/**
 * Harvest the final answer: the concatenation of ALL text blocks of the last
 * assistant message (the `lastText` idiom / the "concatenate all assistant text
 * blocks" fix). A single-block read would miss multi-block answers and produce
 * false "unaddressed" flags.
 */
export function harvestFinal(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const t = textOf(m);
    if (t.length > 0) return t;
  }
  return "";
}

// -- canonical renders ------------------------------------------------------

/** The authoritative render echoed by `setgoal`/`/goal set` and `/goal status`. */
export function render(objective: string, criteria: readonly string[]): string {
  const lines = [`Goal: ${objective}`];
  if (criteria.length > 0) {
    lines.push("Acceptance criteria:");
    criteria.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  }
  return lines.join("\n");
}

/** The anti-drift system note injected on every turn while a goal is set. */
export function renderPin(objective: string, criteria: readonly string[]): string {
  const parts = [`Run objective (keep this in view; do not drift):\n${objective}`];
  if (criteria.length > 0) {
    parts.push("Acceptance criteria:\n" + criteria.map((c) => `- ${c}`).join("\n"));
  }
  return parts.join("\n\n");
}

// -- model-judge parsing (Design §7) ----------------------------------------

/** A verdict per criterion as returned by the optional model judge. */
export type Verdict = "MET" | "UNMET";

/**
 * Parse a strict, line-oriented judge reply: exactly one `MET <n>` / `UNMET <n>`
 * line per criterion (1-based `n`), and every criterion covered exactly once.
 * Returns the verdicts indexed by criterion, or `undefined` on an empty reply,
 * any unparseable non-empty line, an out-of-range index, or a missing/duplicate
 * criterion — so the caller falls back to the lexical check (fail open).
 */
export function parseJudgeReply(reply: string, count: number): Verdict[] | undefined {
  if (count === 0) return [];
  const verdicts: (Verdict | undefined)[] = new Array<Verdict | undefined>(count).fill(undefined);
  let saw = false;
  for (const raw of reply.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    saw = true;
    const m = /^(MET|UNMET)\s+(\d+)$/i.exec(line);
    if (!m) return undefined;
    const verdict = m[1]!.toUpperCase() === "MET" ? "MET" : "UNMET";
    const n = Number(m[2]);
    if (!Number.isInteger(n) || n < 1 || n > count) return undefined;
    if (verdicts[n - 1] !== undefined) return undefined; // duplicate
    verdicts[n - 1] = verdict;
  }
  if (!saw) return undefined;
  const out: Verdict[] = [];
  for (const v of verdicts) {
    if (v === undefined) return undefined; // a criterion went unjudged
    out.push(v);
  }
  return out;
}

/** The fixed system prompt for the judge sub-call (the `drift-probe` shape). */
const JUDGE_SYSTEM_PROMPT =
  "You are reviewing whether a final answer satisfies a run's acceptance criteria. " +
  "For EACH numbered criterion, output exactly one line, either `MET <n>` or `UNMET <n>` " +
  "(n is the criterion number). Output nothing else.";

/** Build the judge sub-call user message: the numbered criteria + the answer. */
function judgePrompt(objective: string, criteria: readonly string[], finalAnswer: string): string {
  const numbered = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return (
    `Objective:\n${objective}\n\n` +
    `Acceptance criteria:\n${numbered}\n\n` +
    `Final answer:\n${finalAnswer}`
  );
}

// -- store keys -------------------------------------------------------------

const JUDGE_KEY = "judge";

// -- validation -------------------------------------------------------------

type ValidateResult =
  | { ok: true; objective: string; criteria: string[] }
  | { ok: false; message: string };

/**
 * Validate a `setgoal` payload for shape (todo-style): non-empty `objective`,
 * and an optional `criteria` array of non-empty strings. A bad write fails with
 * a correcting message and the caller does NOT mutate state.
 */
export function validateGoal(raw: unknown): ValidateResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, message: "setgoal expects an object with an `objective` string" };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.objective !== "string" || r.objective.trim().length === 0) {
    return { ok: false, message: "`objective` must be a non-empty string" };
  }
  const criteria: string[] = [];
  if (r.criteria !== undefined) {
    if (!Array.isArray(r.criteria)) {
      return { ok: false, message: "`criteria` must be an array of non-empty strings" };
    }
    for (let i = 0; i < r.criteria.length; i++) {
      const c = r.criteria[i];
      if (typeof c !== "string" || c.trim().length === 0) {
        return { ok: false, message: `criteria[${i}] must be a non-empty string` };
      }
      criteria.push(c.trim());
    }
  }
  return { ok: true, objective: r.objective.trim(), criteria };
}

/** Split a `;`-separated criteria line into trimmed, non-empty entries. */
export function parseCriteriaLine(line: string): string[] {
  return line
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

export default function activate(e: ExtensionAPI): () => void {
  if (process.env.EAGENT_GOAL === "off") return () => {};

  // Per-activation, session-scoped state (mirrors `todo`). No `store` persistence
  // for the goal itself — the objective is a property of THIS run/session, not
  // durable config. Only the judge toggle is persisted (in `store`).
  let objective: string | undefined;
  let criteria: string[] = [];
  let lastCheck: CriterionResult[] | undefined;

  const judgeEnabled = (): boolean =>
    process.env.EAGENT_GOAL !== "off" && (e.store.get<boolean>(JUDGE_KEY, false) ?? false);

  /**
   * The optional model-judge sub-call (the `drift-probe.ask` shape): a tool-less
   * provider completion that runs OUTSIDE the agent loop. Returns parsed per-
   * criterion verdicts, or `undefined` on a missing/erroring provider, an empty
   * reply, or an unparseable reply — so the caller falls back to the lexical
   * check (fail open). Never reaches the network when no provider is registered.
   */
  async function judge(
    obj: string,
    crit: readonly string[],
    finalAnswer: string,
  ): Promise<CriterionResult[] | undefined> {
    try {
      const provider = e.agent.providers.get();
      if (!provider) return undefined;
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: judgePrompt(obj, crit, finalAnswer) }] },
      ];
      let reply = "";
      for await (const ev of provider.stream({
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        messages,
        tools: [],
        model: e.agent.model,
        signal: new AbortController().signal,
      })) {
        if (ev.type === "done") reply = textOf(ev.message);
      }
      const verdicts = parseJudgeReply(reply, crit.length);
      if (verdicts === undefined) return undefined;
      return crit.map((c, i) => {
        const met = verdicts[i] === "MET";
        return { criterion: c, coverage: met ? 1 : 0, addressed: met };
      });
    } catch {
      return undefined;
    }
  }

  /** Format the per-criterion view for `/goal status` and `/goal check`. */
  const renderCheck = (results: CriterionResult[]): string =>
    results
      .map(
        (r) =>
          `  - [${r.addressed ? "x" : " "}] ${r.criterion} (coverage ${r.coverage.toFixed(2)})`,
      )
      .join("\n");

  // -- 1. transformContext: the anti-drift pin ------------------------------
  const offTransform = e.hook("transformContext", (messages: Message[]): Message[] => {
    // Inert until a goal is set: return BY REFERENCE, byte-identical to absence.
    if (objective === undefined) return messages;
    const note = text("system", renderPin(objective, criteria));
    note.meta = { source: "goal", ephemeral: true };
    // A NEW array; never mutate the live transcript (house rule).
    return [note, ...messages];
  });

  // -- 2. agent_end: advisory completion check ------------------------------
  const offEnd = e.on("agent_end", async (_payload: { reason: StopReason }) => {
    // Fail OPEN: a check that throws must never break the run.
    try {
      if (objective === undefined) return; // inert with no goal
      if (criteria.length === 0) {
        lastCheck = [];
        return; // nothing to check against
      }
      const finalAnswer = harvestFinal(e.agent.messages);
      let results: CriterionResult[] | undefined;
      if (judgeEnabled()) {
        results = await judge(objective, criteria, finalAnswer);
      }
      // Fall back to the deterministic lexical check when the judge is off or
      // yielded nothing.
      results ??= checkCriteria(finalAnswer, criteria);
      lastCheck = results;

      const unaddressed = results.filter((r) => !r.addressed);
      if (unaddressed.length > 0) {
        const names = unaddressed.map((r) => `"${r.criterion}"`).join(", ");
        const summary = `goal: ${unaddressed.length}/${results.length} acceptance criteria look unaddressed: ${names}.`;
        e.log.warn(summary);
        e.agent.ui.notify(summary);
      }
    } catch (err) {
      e.log.warn("goal: completion check error (failing open):", err);
    }
  });

  // -- 3. setgoal tool (no capability) --------------------------------------
  const offTool = e.registerTool(
    defineTool({
      name: "setgoal",
      description:
        "Set or refine the run's objective and (optional) acceptance criteria, and get the canonical " +
        "render back. Use it to restate the goal so it stays pinned in view on long runs. " +
        "Arguments: { objective: string (required), criteria?: string[] }.",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string" },
          criteria: { type: "array", items: { type: "string" } },
        },
        required: ["objective"],
      },
      execute: (args) => {
        const v = validateGoal(args);
        if (!v.ok) return fail(v.message);
        objective = v.objective;
        criteria = v.criteria;
        lastCheck = undefined;
        return ok(render(objective, criteria));
      },
    }),
  );

  // -- 4. /goal command -----------------------------------------------------
  const offCmd = e.registerCommand({
    name: "goal",
    description:
      "Pin the run objective + acceptance criteria. " +
      "Usage: /goal [set <text> | criteria <c1; c2> | check | judge on|off | clear | status]",
    run: (c) => {
      const trimmed = c.args.trim();
      const sp = trimmed.indexOf(" ");
      const sub = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
      const rest = sp === -1 ? "" : trimmed.slice(sp + 1).trim();

      switch (sub) {
        case "set": {
          if (rest.length === 0) {
            c.print("objective text is empty");
            return;
          }
          objective = rest;
          lastCheck = undefined;
          c.print(render(objective, criteria));
          return;
        }
        case "criteria": {
          if (objective === undefined) {
            c.print("set an objective first: /goal set <text>");
            return;
          }
          criteria = parseCriteriaLine(rest);
          lastCheck = undefined;
          c.print(render(objective, criteria));
          return;
        }
        case "check": {
          if (objective === undefined) {
            c.print("(no goal set)");
            return;
          }
          const finalAnswer = harvestFinal(e.agent.messages);
          lastCheck = checkCriteria(finalAnswer, criteria);
          c.print(render(objective, criteria));
          if (lastCheck.length > 0) c.print(renderCheck(lastCheck));
          return;
        }
        case "judge": {
          if (process.env.EAGENT_GOAL === "off") {
            c.print("goal: hard-disabled by EAGENT_GOAL=off");
            return;
          }
          if (rest === "on") {
            e.store.set(JUDGE_KEY, true);
            c.print("goal judge on");
          } else if (rest === "off") {
            e.store.set(JUDGE_KEY, false);
            c.print("goal judge off");
          } else {
            c.print(`goal judge ${judgeEnabled() ? "on" : "off"}`);
          }
          return;
        }
        case "clear": {
          objective = undefined;
          criteria = [];
          lastCheck = undefined;
          c.print("goal cleared");
          return;
        }
        case "":
        case "status": {
          if (objective === undefined) {
            c.print("(no goal set)");
            return;
          }
          c.print(render(objective, criteria));
          c.print(`judge: ${judgeEnabled() ? "on" : "off"}`);
          if (lastCheck !== undefined && lastCheck.length > 0) {
            c.print("last check:");
            c.print(renderCheck(lastCheck));
          }
          return;
        }
        default:
          c.print(
            "usage: /goal [set <text> | criteria <c1; c2> | check | judge on|off | clear | status]",
          );
      }
    },
  });

  // -- 5. session lifecycle reset (session-scoped, like `todo`) -------------
  const reset = (): void => {
    objective = undefined;
    criteria = [];
    lastCheck = undefined;
  };
  const offStart = e.on("session_start", reset);
  const offDown = e.on("session_shutdown", reset);

  return () => {
    for (const d of [offTransform, offEnd, offTool, offCmd, offStart, offDown]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
