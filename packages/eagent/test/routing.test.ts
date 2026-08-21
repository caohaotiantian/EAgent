/**
 * Tests for the routing extension: difficulty-aware per-turn model tiering.
 *
 * The pure `classify` heuristic is exercised directly (the difficulty-protocol
 * invariant), and the per-turn assignment is exercised through the agent loop
 * with a `turn_start` spy (reading `e.agent.model` AFTER the routing handler
 * runs) and a `MockProvider` responder that records `req.model` per turn — the
 * two-way AC-1/AC-2 assertion. All offline against `MockProvider`: no network,
 * no API key. Loaded via `host.use("routing", activate)`, never via
 * `BUILTIN_EXTENSIONS`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import routing, {
  classify,
  HARD_CHAR_LEN,
  HARD_TOOL_RESULT_BYTES,
  HARD_KEYWORD_CUES,
} from "../src/extensions/routing.ts";
import type { ExtensionAPI } from "../src/kernel/extension.ts";
import type { CompletionRequest, Logger, Message } from "../src/kernel/types.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { makeHarness, type Harness } from "./helpers.ts";

interface StoreCfg {
  enabled?: boolean;
  mode?: "heuristic" | "llm";
  tiers?: Record<string, string>;
  cues?: string[];
}

const MOCK_TIERS = { cheap: "mock-cheap", flagship: "mock-flagship" };

/**
 * Activate routing through the harness, seeding its (namespaced) store from
 * within `activate` so the per-test config is in place before any handler runs.
 * Returns the captured `ExtensionAPI` for command dispatch.
 */
async function activate(h: Harness, cfg: StoreCfg = {}): Promise<ExtensionAPI> {
  let api!: ExtensionAPI;
  await h.host.use("routing", (e) => {
    api = e;
    if (cfg.enabled !== undefined) e.store.set("enabled", cfg.enabled);
    if (cfg.mode !== undefined) e.store.set("mode", cfg.mode);
    // Default to the mock tier map so the date-pinned Claude ids never network.
    e.store.set("tiers", cfg.tiers ?? MOCK_TIERS);
    if (cfg.cues !== undefined) e.store.set("cues", cfg.cues);
    return routing(e);
  });
  return api;
}

/** Dispatch the `/routing` command and collect its printed lines. */
function runCommand(h: Harness, args: string): string[] {
  const lines: string[] = [];
  const cmd = h.commands.get("routing");
  assert.ok(cmd, "routing command is registered");
  cmd.run({ agent: h.agent, args, print: (s) => lines.push(s) });
  return lines;
}

/**
 * Register a `turn_start` spy that records `e.agent.model` AFTER the routing
 * handler runs (routing registers first inside `activate`, so this fires after
 * it in registration order). Returns the recording array.
 */
function spyTurnStart(h: Harness): string[] {
  const seen: string[] = [];
  h.agent.hooks.on("turn_start", () => {
    seen.push(h.agent.model);
  });
  return seen;
}

/**
 * A responder factory that records `req.model` per turn while replaying a
 * supplied script of plain-text turns (so the loop terminates).
 */
function recordingResponder(texts: string[]): {
  responder: (req: CompletionRequest, i: number) => { text: string };
  models: string[];
} {
  const models: string[] = [];
  return {
    models,
    responder: (req, i) => {
      models.push(req.model);
      return { text: texts[i] ?? "done" };
    },
  };
}

/** A logger that captures warn() arguments for AC-7. */
function capturingLogger(): { logger: Logger; warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => warnings.push(args),
    error: () => {},
  };
  return { logger, warnings };
}

/** A MockProvider that returns one scripted verdict line and records `req.tools`. */
class Classifier extends MockProvider {
  calls = 0;
  /** The `tools` array seen on each `stream` call, in order. */
  toolsSeen: unknown[][] = [];
  constructor(verdict: string) {
    super(() => ({ text: verdict }));
  }
  override async *stream(req: CompletionRequest) {
    this.calls++;
    this.toolsSeen.push(req.tools as unknown[]);
    yield* super.stream(req);
  }
}

// -- unit: the pure heuristic classifier ------------------------------------

test("classify: short trivial text routes cheap", () => {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "rename this var" }] }];
  assert.equal(classify(messages, HARD_KEYWORD_CUES), "cheap");
});

test("classify: long text (>= HARD_CHAR_LEN) routes flagship", () => {
  const long = "a".repeat(HARD_CHAR_LEN);
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: long }] }];
  assert.equal(classify(messages, HARD_KEYWORD_CUES), "flagship");
});

test("classify: a whole-word cue (case-insensitive) routes flagship", () => {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "please DEBUG this" }] }];
  assert.equal(classify(messages, HARD_KEYWORD_CUES), "flagship");
});

test("classify: a cue as a substring of a larger word does NOT route flagship", () => {
  // "design" is a cue; "designation" embeds it but is not a whole-word match.
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "the designation field" }] }];
  assert.equal(classify(messages, HARD_KEYWORD_CUES), "cheap");
});

test("classify: a large prior tool_result (> HARD_TOOL_RESULT_BYTES) routes flagship", () => {
  const big = "x".repeat(HARD_TOOL_RESULT_BYTES + 1);
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "ok" }] },
    { role: "tool", content: [{ type: "tool_result", toolCallId: "1", content: big }] },
  ];
  assert.equal(classify(messages, HARD_KEYWORD_CUES), "flagship");
});

test("classify: indeterminate (no latest user text) routes flagship (conservative)", () => {
  // No user message at all — none of the three signals can be evaluated.
  const messages: Message[] = [];
  assert.equal(classify(messages, HARD_KEYWORD_CUES), "flagship");
});

test("classify: empty latest user text routes flagship (conservative)", () => {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "   " }] }];
  assert.equal(classify(messages, HARD_KEYWORD_CUES), "flagship");
});

// -- AC-1: trivial turn → cheap tier; per-turn assignment, two-way -----------

test("AC-1: a trivial turn routes to the cheap tier (turn_start spy + req.model)", async () => {
  const { responder, models } = recordingResponder(["done"]);
  const h = makeHarness({ responder });
  await activate(h, { enabled: true });
  // Spy registered AFTER routing, so it observes the post-routing model.
  const seen = spyTurnStart(h);

  await h.agent.run("rename this variable");

  assert.equal(seen[0], "mock-cheap", "turn_start spy saw cheap after routing ran");
  assert.equal(models[0], "mock-cheap", "the provider request carried cheap");
});

// -- AC-2: hard turn → flagship; model changes between turns -----------------

test("AC-2: a hard turn routes to flagship; model changes between turns", async () => {
  // Turn 1: trivial. Turn 2: a follow-up containing a cue, so it is hard.
  const { responder, models } = recordingResponder(["ok", "done"]);
  const h = makeHarness({ responder });
  await activate(h, { enabled: true });
  const seen = spyTurnStart(h);

  // Drive two turns by steering a hard message before the loop would idle.
  h.agent.hooks.on("turn_start", (p) => {
    if ((p as { turn: number }).turn === 1) {
      h.agent.followUp({ role: "user", content: [{ type: "text", text: "please debug this race" }] });
    }
  });

  await h.agent.run("hi there");

  assert.equal(seen[0], "mock-cheap", "turn 1 trivial → cheap");
  assert.equal(seen[1], "mock-flagship", "turn 2 hard → flagship");
  assert.equal(models[0], "mock-cheap");
  assert.equal(models[1], "mock-flagship");
  assert.notEqual(seen[0], seen[1], "model was re-evaluated per turn, not pinned");
});

test("AC-2b: a long-text turn routes flagship via req.model", async () => {
  const { responder, models } = recordingResponder(["done"]);
  const h = makeHarness({ responder });
  await activate(h, { enabled: true });

  await h.agent.run("z".repeat(HARD_CHAR_LEN));
  assert.equal(models[0], "mock-flagship");
});

test("AC-2c: a turn after a large tool_result routes flagship", async () => {
  const big = "y".repeat(HARD_TOOL_RESULT_BYTES + 1);
  const h = makeHarness();
  // Seed a transcript ending in a large tool_result, then run a trivial turn.
  h.agent.load([
    { role: "user", content: [{ type: "text", text: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "looking" }] },
    { role: "tool", content: [{ type: "tool_result", toolCallId: "1", content: big }] },
  ]);
  const { responder, models } = recordingResponder(["done"]);
  h.provider.script(responder);
  await activate(h, { enabled: true });

  await h.agent.run("thanks");
  assert.equal(models[0], "mock-flagship", "the large prior tool result forces flagship");
});

// -- AC-3: restore on agent_end (no residue) ---------------------------------

test("AC-3: the configured model is restored on agent_end (no residue)", async () => {
  const { responder } = recordingResponder(["done"]);
  const h = makeHarness({ responder });
  await activate(h, { enabled: true });

  assert.equal(h.agent.model, "mock", "baseline before run");
  await h.agent.run("rename this variable");
  assert.equal(h.agent.model, "mock", "configured model restored after run resolves");
});

// -- AC-4: disable mid-session restores baseline and stops assigning ---------

test("AC-4: disabling mid-session restores the baseline and stops assigning", async () => {
  const { responder, models } = recordingResponder(["ok", "done"]);
  const h = makeHarness({ responder });
  const api = await activate(h, { enabled: true });
  const seen = spyTurnStart(h);

  // After turn 1 (cheap), disable routing; turn 2 must stay on the baseline.
  // This toggle handler registers AFTER the spy, but routing's own handler ran
  // first (registered in activate); the disable lands on the next turn.
  h.agent.hooks.on("turn_start", (p) => {
    if ((p as { turn: number }).turn === 1) {
      api.store.set("enabled", false);
      h.agent.followUp({ role: "user", content: [{ type: "text", text: "more" }] });
    }
  });

  await h.agent.run("rename this variable");

  assert.equal(seen[0], "mock-cheap", "turn 1 routed cheap while enabled");
  assert.equal(seen[1], "mock", "turn 2 is the baseline after disable");
  assert.equal(models[1], "mock", "the disabled turn's request carried the baseline");
  assert.equal(h.agent.model, "mock", "ends on the baseline");
});

// -- AC-5: EAGENT_ROUTING=off is a total no-op -------------------------------

test("AC-5: EAGENT_ROUTING=off never changes the model (no listeners)", async () => {
  const saved = process.env.EAGENT_ROUTING;
  process.env.EAGENT_ROUTING = "off";
  try {
    const { responder, models } = recordingResponder(["done"]);
    const h = makeHarness({ responder });
    const seen = spyTurnStart(h);
    const turnStartBefore = h.agent.hooks.listenerCount("turn_start");
    await activate(h, { enabled: true });

    // The kill switch registers no turn_start listener of its own.
    assert.equal(
      h.agent.hooks.listenerCount("turn_start"),
      turnStartBefore,
      "no routing turn_start listener registered under the kill switch",
    );

    await h.agent.run("rename this variable"); // would classify trivial
    assert.equal(seen[0], "mock", "model unchanged on the turn");
    assert.equal(models[0], "mock", "request carried the baseline");
    assert.equal(h.agent.model, "mock", "ends on the baseline");
  } finally {
    if (saved === undefined) delete process.env.EAGENT_ROUTING;
    else process.env.EAGENT_ROUTING = saved;
  }
});

// -- AC-6: conservative-on-unsure → flagship ---------------------------------

test("AC-6: an indeterminate turn routes flagship, never cheap", async () => {
  const { responder, models } = recordingResponder(["done"]);
  const h = makeHarness({ responder });
  await activate(h, { enabled: true });
  const seen = spyTurnStart(h);

  // An empty user message — no signal can be evaluated.
  await h.agent.run({ role: "user", content: [{ type: "text", text: "" }] });
  assert.equal(seen[0], "mock-flagship");
  assert.equal(models[0], "mock-flagship");
});

// -- AC-7: unresolvable tier entry → fall back to baseline + warn ------------

test("AC-7: an unresolvable tier entry falls back to the baseline and warns (no throw)", async () => {
  const { logger, warnings } = capturingLogger();
  const { responder, models } = recordingResponder(["done"]);
  const h = makeHarness({ responder, logger });
  // cheap entry is empty → trivial turn cannot resolve cheap, falls back.
  await activate(h, { enabled: true, tiers: { cheap: "", flagship: "mock-flagship" } });
  const seen = spyTurnStart(h);

  await h.agent.run("rename this variable"); // trivial → resolves "cheap" → ""
  assert.equal(seen[0], "mock", "fell back to the configured baseline, not the empty value");
  assert.equal(models[0], "mock");
  assert.ok(warnings.length >= 1, "a warning was emitted");
  assert.ok(
    warnings.some((args) => args.some((a) => typeof a === "string" && /routing/.test(a))),
    "the warning mentions routing",
  );
});

// -- AC-8: optional LLM mode via a tool-less sub-call ------------------------

test("AC-8: LLM mode HARD verdict routes flagship via a tool-less sub-call", async () => {
  const { responder, models } = recordingResponder(["done"]);
  const h = makeHarness({ responder });
  const classifier = new Classifier("HARD: needs the flagship");
  // Register the classifier as the default provider so the sub-call hits it; the
  // same provider also answers the turn. The FIRST stream call is the classify
  // sub-call and must be tool-less (recursion-safe).
  h.agent.providers.register(classifier, { default: true });
  await activate(h, { enabled: true, mode: "llm" });
  const seen = spyTurnStart(h);

  await h.agent.run("short prompt"); // heuristic would say cheap; LLM says HARD
  assert.equal(seen[0], "mock-flagship", "the HARD verdict routed flagship");
  assert.ok(classifier.calls >= 1, "the classifier was consulted");
  assert.deepEqual(classifier.toolsSeen[0], [], "the sub-call passed no tools (recursion-safe)");
});

test("AC-8b: LLM mode CHEAP verdict routes cheap", async () => {
  const h = makeHarness();
  const classifier = new Classifier("CHEAP");
  h.agent.providers.register(classifier, { default: true });
  await activate(h, { enabled: true, mode: "llm" });
  const seen = spyTurnStart(h);

  // A long prompt the heuristic would call flagship; the LLM says CHEAP.
  await h.agent.run("z".repeat(HARD_CHAR_LEN));
  assert.equal(seen[0], "mock-cheap", "the CHEAP verdict routed cheap");
});

test("AC-8c: LLM mode garbled verdict fails open to the heuristic (no throw)", async () => {
  const h = makeHarness();
  const classifier = new Classifier("hmm not sure");
  h.agent.providers.register(classifier, { default: true });
  await activate(h, { enabled: true, mode: "llm" });
  const seen = spyTurnStart(h);

  // Heuristic on a trivial prompt → cheap (the fail-open fallback target).
  await h.agent.run("rename this var");
  assert.equal(seen[0], "mock-cheap", "garbled verdict fell back to the heuristic (cheap here)");
});

// -- AC-9: registration deltas + unload reversibility ------------------------

test("AC-9: activation adds agent_start/turn_start/agent_end + one command, zero tools", async () => {
  const h = makeHarness();
  const toolsBefore = h.agent.tools.list().length;
  const commandsBefore = h.commands.list().length;
  const agentStartBefore = h.agent.hooks.listenerCount("agent_start");
  const turnStartBefore = h.agent.hooks.listenerCount("turn_start");
  const agentEndBefore = h.agent.hooks.listenerCount("agent_end");

  await h.host.use("routing", routing);

  assert.equal(h.agent.tools.list().length, toolsBefore, "zero tools");
  assert.equal(h.commands.list().length, commandsBefore + 1, "one command");
  assert.equal(h.agent.hooks.listenerCount("agent_start"), agentStartBefore + 1);
  assert.equal(h.agent.hooks.listenerCount("turn_start"), turnStartBefore + 1);
  assert.equal(h.agent.hooks.listenerCount("agent_end"), agentEndBefore + 1);

  await h.host.unload("routing");
  assert.equal(h.agent.hooks.listenerCount("agent_start"), agentStartBefore, "agent_start removed");
  assert.equal(h.agent.hooks.listenerCount("turn_start"), turnStartBefore, "turn_start removed");
  assert.equal(h.agent.hooks.listenerCount("agent_end"), agentEndBefore, "agent_end removed");
  assert.equal(h.commands.list().length, commandsBefore, "command removed");
});

test("AC-9b: after unload a subsequent run never changes the model", async () => {
  const { responder, models } = recordingResponder(["done"]);
  const h = makeHarness({ responder });
  await activate(h, { enabled: true });
  await h.host.unload("routing");

  const seen = spyTurnStart(h);
  await h.agent.run("rename this variable");
  assert.equal(seen[0], "mock", "model unchanged after unload");
  assert.equal(models[0], "mock");
  assert.equal(h.agent.model, "mock");
});

// -- command surface ---------------------------------------------------------

test("/routing on|off|status and tier setter", async () => {
  const h = makeHarness();
  await activate(h); // default: disabled

  assert.match(runCommand(h, "status").join("\n"), /off/, "status shows off by default");
  runCommand(h, "on");
  assert.match(runCommand(h, "status").join("\n"), /on/);
  runCommand(h, "off");
  assert.match(runCommand(h, "status").join("\n"), /off/);

  runCommand(h, "tier cheap mock-mini");
  assert.match(runCommand(h, "status").join("\n"), /mock-mini/, "the tier setter updated the map");
});

// -- AC-10: disable via command mid-session restores baseline ----------------

test("/routing off restores the configured baseline", async () => {
  const h = makeHarness();
  const api = await activate(h, { enabled: true });
  // Simulate the override having been applied; the off command must restore.
  h.agent.model = "mock-cheap";
  runCommand(h, "off");
  assert.equal(h.agent.model, "mock", "/routing off restored the configured baseline");
  void api;
});
