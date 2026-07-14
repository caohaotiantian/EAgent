/**
 * Tests for the drift-probe extension: a canary reasoning-quality probe that
 * fires a recursion-safe tool-less sub-call every N turns, scores it against a
 * turn-0 baseline, warns on a `>= X%` regression, and arms a one-shot
 * `transformContext` note.
 *
 * The pure helpers (`scoreProbe`, `isRegression`, `pickProbe`) are exercised
 * directly. The live behavior is driven through the harness with a scripted,
 * call-counting `MockProvider` that serves the canary sub-call (identified by
 * `req.tools.length === 0` and the probe prompt) distinctly from the main turns.
 * The suite is offline: no network, no API key. The extension is loaded via
 * `host.use("drift-probe", activate)` and does NOT depend on BUILTIN_EXTENSIONS.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import driftProbe, {
  PROBE_POOL,
  pickProbe,
  scoreProbe,
  isRegression,
  type Probe,
} from "../src/extensions/drift-probe.js";
import type { ExtensionAPI } from "../src/kernel/extension.js";
import type { CompletionRequest, Logger, Message, UI } from "../src/kernel/types.js";
import { MockProvider } from "../src/providers/mock.js";
import { makeHarness, siblingAgent, silentLogger, type Harness } from "./helpers.js";

// -- fixtures ---------------------------------------------------------------

const PROBE0 = PROBE_POOL[0]!;

/** A strong reply to PROBE_POOL[0]: all key tokens + exact answer + verify cue. */
const STRONG_REPLY_0 =
  "17 multiplied by 4 is 68. Let me verify: 17 * 4 = 68. Double-check: 68.";

/** A degraded reply: none of any probe's key tokens, no verify cue. */
const WEAK_REPLY = "I am not certain about that question right now.";

/**
 * Build a strong, correct reply to ANY probe: every expected token, the exact
 * answer, and two verify cues. Because `scoreProbe` is normalized to `[0,1]`,
 * such a reply scores ~1.0 for whichever rotated probe is currently being asked,
 * so a single turn-0 baseline is comparable across the pool (Design 4.4/4.5).
 */
function strongFor(probe: (typeof PROBE_POOL)[number]): string {
  const ans = probe.exactAnswer ?? "";
  return `${probe.expectedTokens.join(" ")} ${ans}. Let me verify, double-check: ${ans}.`;
}

/** A spy logger that records `warn` calls. */
function spyLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => warns.push(args.map((a) => String(a)).join(" ")),
    error: () => {},
  };
  return { logger, warns };
}

/** A spy UI that records `notify` calls (confirm auto-allows). */
function spyUI(): { ui: UI; notifies: string[] } {
  const notifies: string[] = [];
  const ui: UI = { confirm: async () => true, notify: (m) => notifies.push(m) };
  return { ui, notifies };
}

interface StoreCfg {
  enabled?: boolean;
  n?: number;
  threshold?: number;
  noteOnRegression?: boolean;
}

/** Activate drift-probe, seeding its namespaced store before the hooks run. */
async function activate(h: Harness, cfg: StoreCfg = {}): Promise<ExtensionAPI> {
  let api!: ExtensionAPI;
  await h.host.use("drift-probe", (e) => {
    api = e;
    if (cfg.enabled !== undefined) e.store.set("enabled", cfg.enabled);
    if (cfg.n !== undefined) e.store.set("n", cfg.n);
    if (cfg.threshold !== undefined) e.store.set("threshold", cfg.threshold);
    if (cfg.noteOnRegression !== undefined) e.store.set("noteOnRegression", cfg.noteOnRegression);
    return driftProbe(e);
  });
  return api;
}

/** Concatenate the text of the request's single user message. */
function userText(req: CompletionRequest): string {
  return req.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content)
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Find the probe a canary request asked, by its prompt in the user message. */
function probeOf(req: CompletionRequest): Probe | undefined {
  const body = userText(req);
  return PROBE_POOL.find((p) => p.prompt === body);
}

/**
 * True when a request is the canary sub-call (tool-less, and its user message
 * carries one of the pinned probe prompts). The probe prompt now lives in the
 * user message — the system prompt is a fixed instruction (Design 4.3) — so the
 * discriminator keys on the user payload, not `systemPrompt`.
 */
function isProbeReq(req: CompletionRequest): boolean {
  return req.tools.length === 0 && probeOf(req) !== undefined;
}

/**
 * A MockProvider that counts canary sub-calls and serves each probe a scripted
 * reply (by probe index, in fire order), while main turns get a plain text turn
 * that ends the run (no tool call). `probeReplies[i]` is the reply for the i-th
 * fired probe; a missing entry falls back to a strong reply. The branching lives
 * in a constructor responder (so `super.stream` resolves it); the override only
 * counts before delegating to the parent.
 */
class ProbeProvider extends MockProvider {
  probeCalls = 0;
  #mainTurn = 0;
  #fired = 0;
  constructor(probeReplies: string[]) {
    super((req) => {
      const asked = probeOf(req);
      if (asked) {
        const reply = probeReplies[this.#fired] ?? strongFor(asked);
        this.#fired++;
        return { text: reply };
      }
      this.#mainTurn++;
      return { text: `main ${this.#mainTurn}` };
    });
  }
  override async *stream(req: CompletionRequest) {
    if (isProbeReq(req)) this.probeCalls++;
    yield* super.stream(req);
  }
}

/** A provider whose canary sub-call throws, to drive the fail-open path. */
class ThrowingProbeProvider extends MockProvider {
  probeCalls = 0;
  #mainTurn = 0;
  constructor() {
    super((req) => {
      if (isProbeReq(req)) return { text: "" }; // unreached: stream throws first
      this.#mainTurn++;
      return { text: `main ${this.#mainTurn}` };
    });
  }
  override async *stream(req: CompletionRequest) {
    if (isProbeReq(req)) {
      this.probeCalls++;
      throw new Error("probe provider unavailable");
    }
    yield* super.stream(req);
  }
}

/** Run `n` separate single-turn `agent.run` calls (each one main turn). */
async function runTurns(h: Harness, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await h.agent.run(`turn ${i}`);
}

/** Dispatch the `/drift-probe` command, collecting printed lines. */
function runCommand(h: Harness, args: string): string[] {
  const lines: string[] = [];
  const cmd = h.commands.get("drift-probe");
  assert.ok(cmd, "drift-probe command is registered");
  cmd.run({ agent: h.agent, args, print: (s) => lines.push(s) });
  return lines;
}

// ===========================================================================
// T1 — pure scorer (AC1)
// ===========================================================================

test("AC1: scoreProbe maps a strong reply high (>=0.9) and a degraded reply low (<=0.4)", () => {
  const strong = scoreProbe(STRONG_REPLY_0, PROBE0);
  const weak = scoreProbe(WEAK_REPLY, PROBE0);
  assert.ok(strong >= 0.9, `strong reply should score >= 0.9, got ${strong}`);
  assert.ok(weak <= 0.4, `degraded reply should score <= 0.4, got ${weak}`);
  assert.ok(strong >= 0 && strong <= 1 && weak >= 0 && weak <= 1, "scores are in [0,1]");
});

test("4.5: every probe in the pool is comparable — a correct prose answer scores ~1.0", () => {
  // Design 4.5 asserts a single turn-0 baseline is comparable across the pool:
  // a fully-correct, natural-language answer to ANY probe must score near 1.0,
  // not just the arithmetic one. The hexagon probe answered in prose ("six")
  // must score like its peers, or a correct answer trips a false regression.
  for (const probe of PROBE_POOL) {
    const tokens = probe.expectedTokens.join(" ");
    const ans = probe.exactAnswer ?? "";
    const prose = `The answer involves ${tokens}: ${ans}. Let me verify, double-check: ${ans}.`;
    const s = scoreProbe(prose, probe);
    assert.ok(
      s >= 0.9,
      `a correct prose answer to "${probe.exactAnswer}" should score >= 0.9, got ${s}`,
    );
  }
  // The cry-wolf scenario: a real strong arithmetic baseline (0.9) vs. a real,
  // fully-correct prose hexagon answer must NOT register as a regression.
  const hex = PROBE_POOL[2]!;
  const hexProse = "A hexagon has six sides. Let me verify: six.";
  assert.equal(
    isRegression(0.9, scoreProbe(hexProse, hex), 25),
    false,
    "a correct prose hexagon answer must not be flagged as drift against a 0.9 baseline",
  );
});

// ===========================================================================
// T3 — regression rule + rotation (AC2 + 4.5)
// ===========================================================================

test("AC2: isRegression has a hard boundary at the threshold", () => {
  assert.equal(isRegression(1.0, 0.7, 25), true, "0.7 is >25% below 1.0 → regression");
  assert.equal(isRegression(1.0, 0.8, 25), false, "0.8 is exactly 20% below 1.0 → no regression");
  // exact boundary: 0.75 == 1.0 * (1 - 25/100) → still a regression (<=)
  assert.equal(isRegression(1.0, 0.75, 25), true, "the boundary is inclusive (<=)");
});

test("4.5: pickProbe rotates over the pool", () => {
  assert.strictEqual(pickProbe(0), pickProbe(PROBE_POOL.length), "wraps around the pool length");
  if (PROBE_POOL.length > 1) {
    assert.notStrictEqual(pickProbe(0), pickProbe(1), "consecutive indices differ");
  }
});

// ===========================================================================
// T6 — off by default (AC8)
// ===========================================================================

test("AC8: off by default fires no probe and no warning", async () => {
  const { logger, warns } = spyLogger();
  const { ui, notifies } = spyUI();
  const h = makeHarness({ logger, ui });
  const provider = new ProbeProvider([]);
  h.agent.providers.register(provider, { default: true });
  await activate(h, { n: 2 }); // NOT enabled
  await runTurns(h, 6);
  assert.equal(provider.probeCalls, 0, "no canary sub-call when off by default");
  assert.equal(warns.length, 0, "no warning when off by default");
  assert.equal(notifies.length, 0, "no notify when off by default");
});

// ===========================================================================
// T8 — kill switch (AC9)
// ===========================================================================

test("AC9: EAGENT_DRIFT_PROBE=off hard-disables even when enabled", async () => {
  const saved = process.env.EAGENT_DRIFT_PROBE;
  process.env.EAGENT_DRIFT_PROBE = "off";
  try {
    const { logger, warns } = spyLogger();
    const h = makeHarness({ logger });
    const provider = new ProbeProvider([]);
    h.agent.providers.register(provider, { default: true });
    await activate(h, { enabled: true, n: 2 });
    await runTurns(h, 6);
    assert.equal(provider.probeCalls, 0, "kill switch wins over the enabled flag");
    assert.equal(warns.length, 0, "no warning under the kill switch");
  } finally {
    if (saved === undefined) delete process.env.EAGENT_DRIFT_PROBE;
    else process.env.EAGENT_DRIFT_PROBE = saved;
  }
});

// ===========================================================================
// T10 — cadence + no self-trigger (AC3 + AC11)
// ===========================================================================

test("AC3+AC11: probe fires exactly floor(turns/N) times, never more", async () => {
  const h = makeHarness();

  // Track the *accumulated* turn count at each probe fire. The probe sub-call
  // carries tools:[] and runs outside agent.run, so it emits no turn_start — the
  // spy only ever counts MAIN turns (the recursion proof). The provider's probe
  // counter is the firing instrument; fireTurns snapshots the live turn count.
  let accumulatedTurns = 0;
  const fireTurns: number[] = [];
  h.agent.hooks.on("turn_start", () => {
    accumulatedTurns += 1;
  });

  const provider = new (class extends ProbeProvider {
    override async *stream(req: CompletionRequest) {
      if (isProbeReq(req)) fireTurns.push(accumulatedTurns);
      yield* super.stream(req);
    }
  })([]);
  h.agent.providers.register(provider, { default: true });
  await activate(h, { enabled: true, n: 2 });

  await runTurns(h, 6); // 6 main turns, N=2 → exactly 3 probes
  assert.equal(provider.probeCalls, 3, "exactly floor(6/2) = 3 probes (no self-trigger)");
  assert.deepEqual(fireTurns, [2, 4, 6], "probes fire on accumulated turns 2, 4, 6");
  assert.equal(accumulatedTurns, 6, "only 6 turn_start events — the probe emits none (no recursion)");
});

// ===========================================================================
// T12 — warn on regression + fail open (AC4 + AC10)
// ===========================================================================

test("AC4: a regressed probe warns and names 'drift' (logger + ui.notify)", async () => {
  const { logger, warns } = spyLogger();
  const { ui, notifies } = spyUI();
  const h = makeHarness({ logger, ui });
  // First probe strong (baseline ~1.0), second degraded (well below threshold).
  const provider = new ProbeProvider([STRONG_REPLY_0, WEAK_REPLY]);
  h.agent.providers.register(provider, { default: true });
  await activate(h, { enabled: true, n: 2 });
  await runTurns(h, 4); // 2 probes
  const driftWarns = warns.filter((w) => /drift/i.test(w));
  assert.equal(driftWarns.length, 1, "exactly one drift warning after the regression");
  assert.equal(notifies.filter((m) => /drift/i.test(m)).length, 1, "one drift notify");
});

test("AC10: a probe whose sub-call throws fails open — run completes, no warn, log records it", async () => {
  const { logger, warns } = spyLogger();
  const { ui, notifies } = spyUI();
  const h = makeHarness({ logger, ui });
  const provider = new ThrowingProbeProvider();
  h.agent.providers.register(provider, { default: true });
  await activate(h, { enabled: true, n: 2 });
  await runTurns(h, 4); // 2 probes, both throw
  assert.ok(provider.probeCalls >= 1, "the probe sub-call was attempted");
  assert.equal(
    warns.filter((w) => /drift detected/i.test(w)).length,
    0,
    "no regression warning from a missing score",
  );
  assert.ok(
    warns.some((w) => /failed|no reply|no score/i.test(w)),
    "e.log.warn records the degraded probe",
  );
  assert.equal(notifies.length, 0, "no notify on a failed probe");
});

// ===========================================================================
// T14 — steady-good never warns (AC5)
// ===========================================================================

test("AC5: steady-good (a correct answer every probe) never warns", async () => {
  const { logger, warns } = spyLogger();
  const { ui, notifies } = spyUI();
  const h = makeHarness({ logger, ui });
  // Empty script → the responder serves strongFor(<the rotated probe>) every
  // time, so each fired probe (across the rotating pool) scores ~1.0. A single
  // turn-0 baseline stays comparable because scoreProbe is normalized to [0,1].
  const provider = new ProbeProvider([]);
  h.agent.providers.register(provider, { default: true });
  await activate(h, { enabled: true, n: 2 });
  await runTurns(h, 8); // 4 probes, all correct (3 distinct pool questions)
  assert.equal(provider.probeCalls, 4, "all 4 probes fired");
  assert.equal(warns.length, 0, "zero warnings on steady-good");
  assert.equal(notifies.length, 0, "zero notifies on steady-good");
});

// ===========================================================================
// T16 — one-shot note, disarm, no transcript mutation (AC6 + AC7)
// ===========================================================================

/**
 * A provider that records, for each MAIN turn, whether the messages it received
 * contained a drift-note system message, and serves strong/weak probe replies.
 */
class NoteSpyProvider extends MockProvider {
  /** Per main turn (in order): did the request carry a drift-note? */
  mainTurnHadNote: boolean[] = [];
  #fired = 0;
  constructor(probeReplies: string[]) {
    super((req) => {
      const asked = probeOf(req);
      if (asked) {
        const reply = probeReplies[this.#fired] ?? strongFor(asked);
        this.#fired++;
        return { text: reply };
      }
      return { text: "main" };
    });
  }
  override async *stream(req: CompletionRequest) {
    if (!isProbeReq(req)) {
      const hasNote = req.messages.some(
        (m: Message) => m.role === "system" && m.meta?.kind === "drift-note",
      );
      this.mainTurnHadNote.push(hasNote);
    }
    yield* super.stream(req);
  }
}

test("AC6+AC7: one-shot note injected next turn, then disarmed, never in the transcript", async () => {
  const h = makeHarness();
  // probe1 strong (baseline), probe2 weak (regression → arm note), probe3 strong
  // (a correct answer to the rotated 3rd probe, via the empty-slot fallback).
  const provider = new NoteSpyProvider([STRONG_REPLY_0, WEAK_REPLY]);
  h.agent.providers.register(provider, { default: true });
  await activate(h, { enabled: true, n: 2 });

  // Main turns 1..6: probes fire after turns 2, 4, 6. Regression registers when
  // probe2 fires (after main turn 4), so the note appears on main turn 5.
  await runTurns(h, 6);

  // The note is present on exactly one main turn (turn 5, the one after the
  // regression), and absent on the following turn (disarmed).
  const noteTurns = provider.mainTurnHadNote
    .map((had, i) => (had ? i + 1 : -1))
    .filter((t) => t > 0);
  assert.deepEqual(noteTurns, [5], "exactly one main turn (turn 5) saw the drift-note");

  // The durable transcript never contains a drift-note message.
  const inTranscript = h.agent.messages.some(
    (m) => m.role === "system" && m.meta?.kind === "drift-note",
  );
  assert.equal(inTranscript, false, "the note never enters the durable transcript");
});

test("4.6: a regression that arms while noteOnRegression=false, then flipped true, fires NO stale note", async () => {
  const { logger, warns } = spyLogger();
  const { ui, notifies } = spyUI();
  const h = makeHarness({ logger, ui });
  // The disarm-on-bail asymmetry, made reachable: a regression registers while
  // notes are DISABLED, then the config is flipped to enabled before the next
  // qualifying turn. With the gate at ARM time the flag never armed, so no stale
  // note can fire afterwards; the regression is still warned+notified (it IS
  // detected). The old code armed unconditionally and only bailed in the note
  // handler, so a later flip would strand a stale armed flag and inject a late
  // note — exactly the latent edge this pins shut.
  const provider = new NoteSpyProvider([STRONG_REPLY_0, WEAK_REPLY]);
  h.agent.providers.register(provider, { default: true });
  const api = await activate(h, { enabled: true, n: 2, noteOnRegression: false });

  await runTurns(h, 4); // probes fire after turns 2 (baseline) and 4 (regression)

  // The regression was detected even with notes off.
  assert.equal(
    warns.filter((w) => /drift detected/i.test(w)).length,
    1,
    "the regression is still detected and warned with notes disabled",
  );
  assert.equal(notifies.filter((m) => /drift/i.test(m)).length, 1, "and notified");

  // Now flip notes ON, then run more turns. No stale note may appear.
  api.store.set("noteOnRegression", true);
  await runTurns(h, 4);

  assert.equal(
    provider.mainTurnHadNote.filter((had) => had).length,
    0,
    "no main turn ever saw a drift-note — the flag never armed under disabled notes",
  );
});

// ===========================================================================
// AC2 — per-session-root isolation of the turn counter
// ===========================================================================

test("AC2: a second session's turns do not advance the first session's probe cadence", async () => {
  // The turn counter accumulates across runs and is NOT reset per turn — so on a
  // shared closure, session B's turns would push the shared count over N and fire
  // a probe that belongs to neither session. Keyed per session root, each session
  // counts its own turns. With N=2, one turn in A + one turn in a distinct pooled
  // Agent B must fire NO probe (each is at count 1); a commingled counter reaches
  // 2 on B's turn and fires one.
  const h = makeHarness();
  const provider = new ProbeProvider([]);
  h.agent.providers.register(provider, { default: true });
  await activate(h, { enabled: true, n: 2 });

  await h.agent.run("session A turn"); // session A: root count 1, no probe
  await siblingAgent(h).run("session B turn"); // session B (distinct root): count 1, no probe

  assert.equal(
    provider.probeCalls,
    0,
    "no probe fires — each session's turn counter is independent (commingled would fire on B)",
  );
});

// ===========================================================================
// T18 — the /drift-probe command (AC13)
// ===========================================================================

test("AC13: /drift-probe on|off|status toggles, reports, and gates firing", async () => {
  const h = makeHarness();
  const provider = new ProbeProvider([]);
  h.agent.providers.register(provider, { default: true });
  await activate(h, { n: 2 }); // off initially

  // status before on: prints cadence, threshold, baseline, last; does not throw.
  const status0 = runCommand(h, "status");
  assert.ok(status0.some((l) => /N=2/.test(l)), "status prints cadence N");
  assert.ok(status0.some((l) => /25%/.test(l)), "status prints threshold");
  assert.ok(status0.some((l) => /baseline/.test(l)), "status prints baseline");
  assert.ok(status0.some((l) => /last/.test(l)), "status prints last score");

  // off → no probe.
  await runTurns(h, 4);
  assert.equal(provider.probeCalls, 0, "no probe before /drift-probe on");

  // on → probe fires.
  runCommand(h, "on");
  await runTurns(h, 4);
  assert.ok(provider.probeCalls > 0, "probe fires after /drift-probe on");

  // status after a probe has run: the populated numeric branch is exercised —
  // baseline and last now print a real `toFixed(2)` value, not the "—" stub.
  const status1 = runCommand(h, "status");
  assert.ok(
    status1.some((l) => /^baseline \d+\.\d{2}$/.test(l)),
    "status prints a numeric baseline once a probe has scored",
  );
  assert.ok(
    status1.some((l) => /^last \d+\.\d{2}$/.test(l)),
    "status prints a numeric last score once a probe has scored",
  );

  // off again → no further probes.
  const before = provider.probeCalls;
  runCommand(h, "off");
  await runTurns(h, 4);
  assert.equal(provider.probeCalls, before, "no further probes after /drift-probe off");

  // status (bare) and an unknown arg must not throw.
  assert.doesNotThrow(() => runCommand(h, ""));
  assert.doesNotThrow(() => runCommand(h, "bogus"));
});

// ===========================================================================
// T20 — registration delta + clean teardown (AC12)
// ===========================================================================

test("AC12: registration adds +1 turn_start, +1 transformContext, +1 command, +0 tools", async () => {
  const h = makeHarness();
  const turnBefore = h.agent.hooks.listenerCount("turn_start");
  const ctxBefore = h.agent.hooks.listenerCount("transformContext");
  const cmdBefore = h.commands.list().length;
  const toolsBefore = h.agent.tools.list().length;

  await h.host.use("drift-probe", driftProbe);

  assert.equal(h.agent.hooks.listenerCount("turn_start"), turnBefore + 1, "+1 turn_start");
  assert.equal(
    h.agent.hooks.listenerCount("transformContext"),
    ctxBefore + 1,
    "+1 transformContext",
  );
  assert.equal(h.commands.list().length, cmdBefore + 1, "+1 command");
  assert.equal(h.agent.tools.list().length, toolsBefore, "+0 tools");

  await h.host.unload("drift-probe");
  assert.equal(h.agent.hooks.listenerCount("turn_start"), turnBefore, "turn_start removed");
  assert.equal(h.agent.hooks.listenerCount("transformContext"), ctxBefore, "transformContext removed");
  assert.equal(h.commands.list().length, cmdBefore, "command removed");
});

test("AC12: after unload, an enabled run fires no probe (no leak)", async () => {
  const h = makeHarness({ logger: silentLogger });
  const provider = new ProbeProvider([]);
  h.agent.providers.register(provider, { default: true });
  await activate(h, { enabled: true, n: 2 });
  await h.host.unload("drift-probe");
  await runTurns(h, 6);
  assert.equal(provider.probeCalls, 0, "no probe fires after teardown");
});
