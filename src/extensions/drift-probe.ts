/**
 * drift-probe — a canary reasoning-quality probe as a *leading* degradation
 * indicator.
 *
 * Long agent sessions silently degrade as context accumulates: the model
 * forgets a turn-0 rule, stops self-verifying, or loses a load-bearing fact
 * buried under a megabyte of tool output. The only signal EAgent surfaces today
 * is the *final answer* — a *lagging* indicator, since by the time a wrong
 * answer lands the reasoning was already degraded for some unknown number of
 * prior turns. `prune`/`compact`/`limits` manage context *size* (the cause);
 * none of them measure reasoning *quality* (the consequence).
 *
 * This extension is that missing instrument. It counts turns and, every N
 * turns, fires a recursion-safe *tool-less* provider sub-call (the `risk-guard`
 * shape) on a pinned "canary" question with a known-good answer, scores the
 * reply against a turn-0 baseline, and on a `>= X%` regression warns
 * (`e.log.warn` + `e.agent.ui.notify`) and arms a one-shot `transformContext`
 * note pointing at `/compact` or `/handoff`. It never blocks, never rewrites the
 * durable transcript, and fails OPEN: a probe that throws or returns nothing
 * simply does not warn.
 *
 * Because each probe is an extra paid model call, it ships OFF (enable with
 * `/drift-probe on`) and is hard-disabled by `EAGENT_DRIFT_PROBE=off`. It
 * declares no capability — it performs no filesystem/network side effect of its
 * own (it reads the model read-only and notifies/logs).
 */

import type { ExtensionAPI } from "../kernel/extension.js";
import type { Message } from "../kernel/types.js";
import { text } from "../kernel/types.js";

// -- scoring constants (tuned; Design 4.2 / 4.4) ----------------------------

/**
 * The `scoreProbe` blend weights (Design 4.2). Lean hardest on key-token
 * presence (the most robust correctness proxy), use exact-match as a clean
 * bonus, and fold in self-verification cues as the reasoning-rigor tie-breaker,
 * capped so a chatty answer cannot game it. They sum to 1, so a perfect reply
 * scores exactly 1. Retuning is a conscious edit here, not behavioral branching.
 */
const W_KEY_TOKEN = 0.5;
const W_EXACT = 0.3;
const W_VERIFY = 0.2;

/** Cap on counted verify-cues, so verbosity cannot inflate the rigor term. */
const VERIFY_CUE_CAP = 2;

/**
 * The shared self-verification cue list (a proxy for retained reasoning rigor).
 * Lowercased, substring-matched against the lowercased reply (these are phrases,
 * not single words, so the whole-word rule does not apply).
 */
const VERIFY_CUES: readonly string[] = [
  "let me verify",
  "let me check",
  "double-check",
  "double check",
  "to be sure",
  "verifying",
  "checking",
];

/** A pinned canary: a fixed question with a known-good expected answer. */
export interface Probe {
  /** The question posed to the model — sent as the user message of the sub-call. */
  prompt: string;
  /** Key tokens a correct reply should contain (whole-word, case-insensitive). */
  expectedTokens: string[];
  /** The exact answer string, when the probe has a single canonical one. */
  exactAnswer?: string;
}

/**
 * The fixed probe pool. A handful of pinned questions, each carrying its own
 * known-good expected set so a scripted reply maps to a known score. Rotated by
 * `pickProbe` so no single canary repeats often enough to be parroted (4.5).
 * The questions are short (cost) and self-contained (asked with no transcript).
 * Each `prompt` is JUST the bare question: the "show your reasoning, then verify"
 * instruction lives once in `PROBE_SYSTEM_PROMPT`, so it is not duplicated into
 * the user message (keeping the canary call as cheap as the design intends).
 */
export const PROBE_POOL: readonly Probe[] = [
  {
    prompt: "What is 17 multiplied by 4?",
    expectedTokens: ["17", "4", "68"],
    exactAnswer: "68",
  },
  {
    prompt: "What is the capital of France?",
    expectedTokens: ["capital", "France", "Paris"],
    exactAnswer: "Paris",
  },
  {
    prompt: "How many sides does a hexagon have?",
    expectedTokens: ["hexagon", "sides", "six"],
    // The word "six", not the digit "6": exact-match is whole-word, so a digit
    // would never match a correct prose answer ("...has six sides"), forfeiting
    // the exact-match weight and capping a correct reply at ~0.6 — below its
    // peers' ~1.0, which would trip a false regression against the shared
    // turn-0 baseline (Design 4.5: the pool must be comparable at full score).
    exactAnswer: "six",
  },
];

/**
 * Whole-word, case-insensitive token presence (the `microagents.ts` idiom):
 * accept `token` only when the characters immediately before and after an
 * occurrence are non-alphanumeric or absent, so `4` matches `4` but not `45`.
 */
function containsToken(haystack: string, token: string): boolean {
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
 * Score a canary reply against its probe's expected set, into `[0, 1]`:
 * `0.5 * keyTokenFraction + 0.3 * exactMatch + 0.2 * min(verifyCues, cap)/cap`
 * (Design 4.2). Pure and synchronous — no model call, no I/O — so a scripted
 * reply yields a known, asserted number. An empty `expectedTokens` contributes a
 * full key-token fraction (nothing to miss); a probe with no `exactAnswer`
 * contributes a zero exact-match term.
 */
export function scoreProbe(reply: string, expected: Probe): number {
  const tokens = expected.expectedTokens;
  const keyTokenFraction =
    tokens.length === 0 ? 1 : tokens.filter((t) => containsToken(reply, t)).length / tokens.length;

  const exactMatch =
    expected.exactAnswer !== undefined && containsToken(reply, expected.exactAnswer) ? 1 : 0;

  const lower = reply.toLowerCase();
  const verifyCueCount = VERIFY_CUES.filter((cue) => lower.includes(cue)).length;
  const verifyTerm = Math.min(verifyCueCount, VERIFY_CUE_CAP) / VERIFY_CUE_CAP;

  return W_KEY_TOKEN * keyTokenFraction + W_EXACT * exactMatch + W_VERIFY * verifyTerm;
}

/**
 * The regression rule (Design 4.4): `true` iff the current score has fallen at
 * least `thresholdPct` percent below the turn-0 baseline, i.e.
 * `current <= baseline * (1 - thresholdPct/100)`. A conservative default
 * threshold (25%) keeps ordinary phrasing variance from crying wolf.
 */
export function isRegression(baseline: number, current: number, thresholdPct: number): boolean {
  return current <= baseline * (1 - thresholdPct / 100);
}

/** Rotate the probe pool deterministically by probe index (Design 4.5). */
export function pickProbe(index: number): Probe {
  const probe = PROBE_POOL[((index % PROBE_POOL.length) + PROBE_POOL.length) % PROBE_POOL.length];
  // PROBE_POOL is a non-empty constant, so the modulo index is always in range;
  // the assertion narrows `Probe | undefined` under noUncheckedIndexedAccess.
  return probe!;
}

// -- store keys -------------------------------------------------------------

const KEYS = {
  enabled: "enabled",
  n: "n",
  threshold: "threshold",
  noteOnRegression: "noteOnRegression",
  baseline: "baseline",
  last: "last",
} as const;

/** Defaults (Design 4.1 / 4.4 / 4.6). */
const DEFAULT_N = 8;
const DEFAULT_THRESHOLD_PCT = 25;

/** Concatenate an assistant message's text blocks (`risk-guard.ts:70-76`). */
function textOf(message: Message): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** The single advisory note injected after a regression (Design 4.6). */
const DRIFT_NOTE_TEXT =
  "reasoning-quality drift detected; consider /compact or /handoff to refresh the session.";

/**
 * The fixed system prompt for the canary sub-call (the `risk-guard` shape,
 * Design 4.3): a distinct instruction in `systemPrompt`, with the probe question
 * carried as the single user message — so the canary is sent ONCE, not duplicated
 * across both slots.
 */
const PROBE_SYSTEM_PROMPT =
  "Answer the following question concisely, showing your reasoning, then verify it.";

export default function activate(e: ExtensionAPI): () => void {
  // Module-scoped (per-activation) lifecycle state. The turn counter accumulates
  // ACROSS `agent.run` calls — a long session is many runs, and drift is a
  // session-level property — so it is NOT reset on `agent_start` (Design 4.1).
  // Reset only on dispose/reload, so a reload starts clean.
  let turnCounter = 0;
  let probeCount = 0;
  /**
   * The turn at which a regression armed the one-shot note, or `-1` when
   * unarmed. The note injects on the *next* turn (Design 4.6): the probe fires
   * and arms during turn N's `turn_start` (which `emit` awaits), so turn N's own
   * `transformContext` must NOT inject — only a later turn's does, then disarms.
   */
  let armedAtTurn = -1;

  const num = (key: string, fallback: number): number => {
    const raw = e.store.get<unknown>(key);
    const v = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  };

  const cfg = () => ({
    enabled:
      process.env.EAGENT_DRIFT_PROBE === "off"
        ? false
        : (e.store.get<boolean>(KEYS.enabled, false) ?? false),
    n: num(KEYS.n, DEFAULT_N),
    thresholdPct: num(KEYS.threshold, DEFAULT_THRESHOLD_PCT),
    noteOnRegression: e.store.get<boolean>(KEYS.noteOnRegression, true) ?? true,
  });

  /**
   * Fire one canary probe via the provider DIRECTLY (the `risk-guard.ts:96-137`
   * shape): `tools: []` runs the completion OUTSIDE the agent loop, so it emits
   * no tool call (no `beforeToolCall` re-entry) and no `turn_start` (it cannot
   * increment its own turn counter and self-trigger). Returns the reply text, or
   * `undefined` on any failure / empty reply so the caller fails OPEN.
   */
  async function ask(probe: Probe): Promise<string | undefined> {
    try {
      const provider = e.agent.providers.get();
      if (!provider) return undefined;
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: probe.prompt }] },
      ];
      let reply = "";
      for await (const ev of provider.stream({
        systemPrompt: PROBE_SYSTEM_PROMPT,
        messages,
        tools: [],
        model: e.agent.model,
        signal: new AbortController().signal,
      })) {
        if (ev.type === "done") reply = textOf(ev.message);
      }
      return reply.trim().length > 0 ? reply : undefined;
    } catch {
      return undefined;
    }
  }

  /** Run one probe, score it, capture/compare against the turn-0 baseline. */
  async function fireProbe(): Promise<void> {
    const probe = pickProbe(probeCount);
    probeCount += 1;

    const reply = await ask(probe);
    if (reply === undefined) {
      // Fail open: no score, no baseline established → no regression warning.
      e.log.warn("drift-probe: probe sub-call failed or returned no reply; skipping (no score)");
      return;
    }

    const score = scoreProbe(reply, probe);
    e.store.set(KEYS.last, score);

    const baseline = e.store.get<number>(KEYS.baseline);
    if (baseline === undefined) {
      // First scored probe of the session is the turn-0 baseline (4.4).
      e.store.set(KEYS.baseline, score);
      return;
    }

    if (isRegression(baseline, score, cfg().thresholdPct)) {
      const msg =
        `drift-probe: reasoning-quality drift detected — canary score ${score.toFixed(2)} ` +
        `is >= ${cfg().thresholdPct}% below the turn-0 baseline ${baseline.toFixed(2)}; ` +
        `consider /compact or /handoff.`;
      e.log.warn(msg);
      e.agent.ui.notify(msg);
      // Arm the one-shot note for the NEXT turn (4.6) ONLY when notes are
      // enabled, so the one-shot invariant cannot be stranded by a later config
      // flip: a flag is never armed while `noteOnRegression` is false, so the
      // note handler need not re-check config to disarm. The warn/notify above
      // still fire (the regression IS detected); only the note is suppressed.
      if (cfg().noteOnRegression) armedAtTurn = turnCounter;
    }
  }

  // -- 1. turn counter + every-N canary sub-call ----------------------------
  // The handler is async and `emit` awaits it (hooks.ts:54-58), so the probe
  // completes — and any regression is armed — before this turn's `streamTurn`
  // applies `transformContext`. Deterministic, with no fire-and-forget race.
  const offTurn = e.on("turn_start", async () => {
    // Increment on EVERY turn_start, accumulating across runs (4.1).
    turnCounter += 1;
    const { enabled, n } = cfg(); // read live so the kill switch is honored
    if (!enabled) return;
    if (turnCounter % n !== 0) return;
    // fireProbe never throws (internally try/catch'd); guard defensively anyway
    // so a lifecycle observer can never break the run (fail open).
    try {
      await fireProbe();
    } catch (err) {
      e.log.warn("drift-probe: probe handler error (failing open):", err);
    }
  });

  // -- 2. one-shot regression note on transformContext ----------------------
  const offNote = e.hook("transformContext", (messages: Message[]): Message[] => {
    if (armedAtTurn < 0) return messages; // unarmed: by reference, nothing to do
    // No `noteOnRegression` re-check here: the flag is gated at ARM time (see
    // `fireProbe`), so an armed flag already implies notes were enabled. This
    // keeps the one-shot invariant config-order-independent — there is no path
    // that bails out of this handler while leaving a stale flag armed.
    // Inject only on a turn LATER than the one the note was armed at, so the
    // note lands on the *next* model call (4.6), not the probe's own turn.
    if (turnCounter <= armedAtTurn) return messages;
    armedAtTurn = -1; // disarm: at most one note per regression (4.6)
    const note = text("system", DRIFT_NOTE_TEXT);
    note.meta = { source: "drift-probe", kind: "drift-note" };
    // A NEW array; never mutate the input, never enter the durable transcript.
    return [note, ...messages];
  });

  // -- 3. /drift-probe command ----------------------------------------------
  const offCmd = e.registerCommand({
    name: "drift-probe",
    description: "Reasoning-quality canary probe. Usage: /drift-probe [on|off|status]",
    run: (c) => {
      const arg = c.args.trim();
      switch (arg) {
        case "on":
          e.store.set(KEYS.enabled, true);
          c.print("drift-probe on");
          break;
        case "off":
          e.store.set(KEYS.enabled, false);
          c.print("drift-probe off");
          break;
        default: {
          const { enabled, n, thresholdPct } = cfg();
          const baseline = e.store.get<number>(KEYS.baseline);
          const last = e.store.get<number>(KEYS.last);
          c.print(`drift-probe ${enabled ? "on" : "off"}`);
          c.print(`cadence N=${n}`);
          c.print(`threshold ${thresholdPct}%`);
          c.print(`baseline ${baseline === undefined ? "—" : baseline.toFixed(2)}`);
          c.print(`last ${last === undefined ? "—" : last.toFixed(2)}`);
        }
      }
    },
  });

  return () => {
    // Reset module-scoped lifecycle state so a reload starts clean (4.1).
    turnCounter = 0;
    probeCount = 0;
    armedAtTurn = -1;
    for (const d of [offTurn, offNote, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
