/**
 * Tests for the compact extension: token-gated, user-turn-boundary, structured
 * conversation compaction with an always-surviving byte-capped pinned block.
 *
 * Two exported pure helpers (`tokenEstimate`, `splitIndex`) are exercised
 * directly; the hook/tool/command behaviors run through the harness via
 * `host.use("compact", activate)` (the recovery.test.ts:118-119 pattern). The
 * extension is activated through a wrapper that captures its `ExtensionAPI` and
 * seeds its namespaced store from within `activate` (the risk-guard.test.ts:32-42
 * pattern). The scriptable MockProvider serves both the real turns and the
 * compaction sub-call, branching on the summarization system prompt (the
 * memory.test.ts:35-44 instrument).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import compact, { tokenEstimate, splitIndex, PIN_MAX_BYTES } from "../src/extensions/compact.js";
import memory from "../src/extensions/memory.js";
import type { ExtensionAPI } from "../src/kernel/extension.js";
import type { CompletionRequest, Message, ToolContext } from "../src/kernel/types.js";
import { text } from "../src/kernel/types.js";
import { makeHarness, type Harness } from "./helpers.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Detect our summarization sub-call by its dedicated system prompt. */
function isSummarizeReq(req: CompletionRequest): boolean {
  return /summar/i.test(req.systemPrompt);
}

function userMsg(s: string): Message {
  return text("user", s);
}
function assistantMsg(s: string): Message {
  return text("assistant", s);
}
/** An assistant message issuing one tool_call. */
function callMsg(id: string, name: string): Message {
  return { role: "assistant", content: [{ type: "tool_call", id, name, arguments: {} }] };
}
/** A tool message carrying one tool_result of `n` chars. */
function resultMsg(id: string, n: number): Message {
  return { role: "tool", content: [{ type: "tool_result", toolCallId: id, content: "x".repeat(n) }] };
}

/** Concatenated text of every text block in a message. */
function textOf(m: Message): string {
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** The summary messages in a transformed array. */
function summaries(out: Message[]): Message[] {
  return out.filter((m) => m.meta?.kind === "summary");
}

const STRUCTURED = "## Decisions\n- chose X\n## Files\n- a.ts\n## Open threads\n- none";

/**
 * A function responder that returns structured summary text on the sub-call
 * (the `/summar/i` turn) and a plain reply on real turns.
 */
function makeResponder(
  opts: { subText?: string; count?: { sub: number; real: number } } = {},
) {
  return (req: CompletionRequest): { text: string } => {
    if (isSummarizeReq(req)) {
      if (opts.count) opts.count.sub++;
      return { text: opts.subText ?? STRUCTURED };
    }
    if (opts.count) opts.count.real++;
    return { text: "ok" };
  };
}

/**
 * Activate compact through the harness, seeding its namespaced store from within
 * `activate` (risk-guard.test.ts:32-42). Returns the captured `ExtensionAPI`.
 */
async function activate(h: Harness, cfg: { enabled?: boolean } = {}): Promise<ExtensionAPI> {
  let api!: ExtensionAPI;
  await h.host.use("compact", (e) => {
    api = e;
    if (cfg.enabled !== undefined) e.store.set("enabled", cfg.enabled);
    return compact(e);
  });
  return api;
}

/** Drive the transformContext seam directly. */
async function applyHook(h: Harness, msgs: Message[]): Promise<Message[]> {
  return h.agent.hooks.apply("transformContext", msgs, { turn: 0, model: "mock" });
}

/** Minimal ToolContext for direct tool execution in tests. */
function toolCtx(): ToolContext {
  return {
    toolCallId: "t",
    signal: new AbortController().signal,
    require: async () => {},
    progress: () => {},
    ui: { confirm: async () => true, notify: () => {} },
    agent: { model: "mock", messages: [], steer: () => {}, followUp: () => {} },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

/**
 * A transcript that exceeds the 60k token budget (≈250k chars of text) with
 * several user-turn boundaries older than `keepTurns`, followed by 3 recent
 * turns kept verbatim.
 */
function overBudget(): Message[] {
  const big = "y".repeat(50_000); // ≈12.5k tokens each
  return [
    userMsg("q0 " + big),
    assistantMsg("a0 " + big),
    userMsg("q1 " + big),
    assistantMsg("a1 " + big),
    userMsg("q2 " + big),
    assistantMsg("a2"),
    // recent window (last 3 user turns):
    userMsg("recent-A"),
    assistantMsg("ra"),
    userMsg("recent-B"),
    assistantMsg("rb"),
    userMsg("recent-C"),
    assistantMsg("rc"),
  ];
}

// ---------------------------------------------------------------------------
// Task 1 — tokenEstimate
// ---------------------------------------------------------------------------

test("tokenEstimate counts BOTH text and tool_result, never undercounts dialogue", () => {
  // A text-only transcript: prune would sum 0 (it skips non-tool_result); compact must not.
  const textOnly: Message[] = [userMsg("a".repeat(400)), assistantMsg("b".repeat(800))];
  assert.ok(tokenEstimate(textOnly) > 0, "text-only transcript estimated > 0");
  assert.equal(tokenEstimate(textOnly), Math.round(400 / 4) + Math.round(800 / 4));

  // Mixed text + tool_result sums both.
  const mixed: Message[] = [userMsg("x".repeat(400)), resultMsg("A", 800)];
  assert.equal(tokenEstimate(mixed), Math.round(400 / 4) + Math.round(800 / 4));

  // Per-string parity with prune's est.
  const known = "z".repeat(123);
  assert.equal(tokenEstimate([userMsg(known)]), Math.max(0, Math.round(123 / 4)));
});

// ---------------------------------------------------------------------------
// Task 2 — splitIndex
// ---------------------------------------------------------------------------

test("splitIndex returns a user-turn boundary, never severing a tool_call/tool_result pair", () => {
  // 5 user turns, each: user -> assistant tool_call -> tool tool_result.
  const msgs: Message[] = [];
  for (let i = 0; i < 5; i++) {
    msgs.push(userMsg(`q${i}`), callMsg(`c${i}`, "read"), resultMsg(`c${i}`, 10));
  }
  const keepTurns = 3;
  const idx = splitIndex(msgs, 60_000, keepTurns);

  // The split point is a user message.
  assert.equal(msgs[idx]!.role, "user", "split is at a user-turn boundary");

  // The recent window holds exactly the last keepTurns user turns, whole.
  const recent = msgs.slice(idx);
  assert.equal(recent.filter((m) => m.role === "user").length, keepTurns);

  // The message at idx-1 is never an assistant tool_call whose paired
  // tool_result is at idx (no severed pair).
  const prev = msgs[idx - 1]!;
  const hasDanglingCall = prev.content.some((b) => b.type === "tool_call");
  assert.equal(hasDanglingCall, false, "idx-1 is not an unpaired tool_call");
});

test("splitIndex returns 0 when fewer than keepTurns user turns (one-giant-turn no-fold)", () => {
  const msgs: Message[] = [userMsg("only one turn"), assistantMsg("a")];
  assert.equal(splitIndex(msgs, 60_000, 3), 0);
});

// ---------------------------------------------------------------------------
// Task 3 / AC-1 — no-op below budget
// ---------------------------------------------------------------------------

test("AC-1: below budget the context is untouched, no sub-call, no summary", async () => {
  const count = { sub: 0, real: 0 };
  const h = makeHarness({ responder: makeResponder({ count }) });
  await activate(h, { enabled: true });

  const input: Message[] = [userMsg("short"), assistantMsg("reply"), userMsg("again"), assistantMsg("ok")];
  const out = await applyHook(h, input);

  assert.equal(out.length, input.length, "same length");
  assert.equal(summaries(out).length, 0, "no summary inserted");
  assert.equal(count.sub, 0, "no compaction sub-call");
});

// ---------------------------------------------------------------------------
// Task 4 / AC-2 — fires over budget → exactly one summary, recent window verbatim
// ---------------------------------------------------------------------------

test("AC-2: over budget folds into exactly one system summary; recent turns survive verbatim", async () => {
  const h = makeHarness({ responder: makeResponder() });
  await activate(h, { enabled: true });

  const input = overBudget();
  const out = await applyHook(h, input);

  const s = summaries(out);
  assert.equal(s.length, 1, "exactly one summary");
  assert.equal(s[0]!.role, "system", "summary is a system message");
  // The summary precedes the recent window.
  assert.equal(out.indexOf(s[0]!), 0, "summary at head, before recent window");

  // Last keepTurns (3) user turns survive verbatim by content.
  const joined = out.map(textOf).join("\n");
  for (const tag of ["recent-A", "recent-B", "recent-C"]) {
    assert.ok(joined.includes(tag), `recent turn ${tag} survives verbatim`);
  }
});

// ---------------------------------------------------------------------------
// Task 5 / AC-3 — structured slots present
// ---------------------------------------------------------------------------

test("AC-3: the summary carries the structured ## Decisions / ## Files / ## Open threads slots", async () => {
  const h = makeHarness({ responder: makeResponder() });
  await activate(h, { enabled: true });

  const out = await applyHook(h, overBudget());
  const sText = textOf(summaries(out)[0]!);
  for (const heading of ["## Decisions", "## Files", "## Open threads"]) {
    assert.ok(sText.includes(heading), `summary contains ${heading}`);
  }
});

// ---------------------------------------------------------------------------
// Task 6 / AC-4 — split only at a user-turn boundary (no severed pair)
// ---------------------------------------------------------------------------

test("AC-4: an in-flight tool_call/tool_result pair is never split by a summary marker", async () => {
  const h = makeHarness({ responder: makeResponder() });
  await activate(h, { enabled: true });

  const big = "y".repeat(50_000);
  // Older slice (over budget), then a recent window ending in tool_call/tool_result pairs.
  const input: Message[] = [
    userMsg("q0 " + big),
    assistantMsg("a0 " + big),
    userMsg("q1 " + big),
    assistantMsg("a1 " + big),
    userMsg("q2 " + big),
    assistantMsg("a2 " + big),
    userMsg("recent-A"),
    callMsg("p1", "read"),
    resultMsg("p1", 10),
    userMsg("recent-B"),
    callMsg("p2", "read"),
    resultMsg("p2", 10),
    userMsg("recent-C"),
    callMsg("p3", "read"),
    resultMsg("p3", 10),
  ];
  const out = await applyHook(h, input);

  // Walk the output: a tool_call must be immediately followed by its tool_result,
  // never by a summary marker.
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    const call = m.content.find((b) => b.type === "tool_call");
    if (!call || call.type !== "tool_call") continue;
    const next = out[i + 1];
    assert.ok(next, "a tool_call is followed by something");
    assert.notEqual(next!.meta?.kind, "summary", "no summary marker between a call and its result");
    const res = next!.content.find((b) => b.type === "tool_result");
    assert.ok(res && res.type === "tool_result" && res.toolCallId === call.id, "pair kept whole");
  }
});

// ---------------------------------------------------------------------------
// Task 7 / AC-5 — pinned block always survives + byte cap
// ---------------------------------------------------------------------------

test("AC-5: a pinned note survives compaction, positioned before the recent window; byte-capped", async () => {
  const h = makeHarness({ responder: makeResponder() });
  await activate(h, { enabled: true });

  // Pin via the registered tool.
  const pin = h.agent.tools.get("pin");
  assert.ok(pin, "pin tool registered");
  await pin!.execute({ key: "k1", value: "PINNED-EVIDENCE" }, toolCtx());

  const out = await applyHook(h, overBudget());
  const joined = out.map(textOf).join("\n");
  assert.ok(joined.includes("PINNED-EVIDENCE"), "pinned value survives compaction");

  // The pinned block sits before the first recent message.
  const pinIdx = out.findIndex((m) => textOf(m).includes("PINNED-EVIDENCE"));
  const firstRecentIdx = out.findIndex((m) => textOf(m).includes("recent-A"));
  assert.ok(pinIdx >= 0 && firstRecentIdx >= 0);
  assert.ok(pinIdx < firstRecentIdx, "pinned block precedes the recent window");

  // Byte cap: pin content larger than PIN_MAX_BYTES is clipped.
  await pin!.execute({ key: "big", value: "Z".repeat(PIN_MAX_BYTES * 3) }, toolCtx());
  const out2 = await applyHook(h, overBudget());
  const pinMsg = out2.find((m) => textOf(m).includes("Z"));
  assert.ok(pinMsg, "the oversized pin still appears (clipped)");
  assert.ok(
    Buffer.byteLength(textOf(pinMsg!)) <= PIN_MAX_BYTES,
    `pinned block byte length ${Buffer.byteLength(textOf(pinMsg!))} <= ${PIN_MAX_BYTES}`,
  );
});

// ---------------------------------------------------------------------------
// Task 8 / AC-6 — unpin removes it
// ---------------------------------------------------------------------------

test("AC-6: unpin removes the note so it no longer survives compaction", async () => {
  const h = makeHarness({ responder: makeResponder() });
  await activate(h, { enabled: true });

  const pin = h.agent.tools.get("pin");
  const unpin = h.agent.tools.get("unpin");
  assert.ok(pin && unpin, "pin/unpin tools registered");
  await pin!.execute({ key: "k1", value: "PINNED-EVIDENCE" }, toolCtx());
  await unpin!.execute({ key: "k1" }, toolCtx());

  const out = await applyHook(h, overBudget());
  const joined = out.map(textOf).join("\n");
  assert.ok(!joined.includes("PINNED-EVIDENCE"), "unpinned value is gone");
});

// ---------------------------------------------------------------------------
// Task 9 / AC-7 — re-summarization carries prior slots forward (D8)
// ---------------------------------------------------------------------------

test("AC-7: a second fold carries the prior summary forward into the sub-call", async () => {
  let subCount = 0;
  let secondSubSawPrior = false;
  const responder = (req: CompletionRequest): { text: string } => {
    if (isSummarizeReq(req)) {
      subCount++;
      if (subCount === 1) return { text: "## Decisions\n- DECISION-ONE\n## Files\n## Open threads" };
      // Second sub-call: did the prior summary flow into req.messages?
      secondSubSawPrior = req.messages.some((m) => textOf(m).includes("DECISION-ONE"));
      return { text: "## Decisions\n- DECISION-ONE\n- DECISION-TWO\n## Files\n## Open threads" };
    }
    return { text: "ok" };
  };
  const h = makeHarness({ responder });
  await activate(h, { enabled: true });

  // First fold.
  const out1 = await applyHook(h, overBudget());
  assert.ok(textOf(summaries(out1)[0]!).includes("DECISION-ONE"), "first summary has DECISION-ONE");

  // Grow the transcript past budget again, with the prior summary at the head.
  const big = "y".repeat(50_000);
  const grown: Message[] = [
    summaries(out1)[0]!, // prior summary at head of older slice
    userMsg("q3 " + big),
    assistantMsg("a3 " + big),
    userMsg("q4 " + big),
    assistantMsg("a4 " + big),
    userMsg("q5 " + big),
    assistantMsg("a5"),
    userMsg("recent-A"),
    assistantMsg("ra"),
    userMsg("recent-B"),
    assistantMsg("rb"),
    userMsg("recent-C"),
    assistantMsg("rc"),
  ];
  const out2 = await applyHook(h, grown);

  assert.equal(subCount, 2, "a second sub-call ran");
  assert.ok(secondSubSawPrior, "prior summary fed into the second sub-call's older slice");
  assert.ok(
    textOf(summaries(out2)[0]!).includes("DECISION-ONE"),
    "earlier decision carried forward across the second fold",
  );
});

// ---------------------------------------------------------------------------
// Task 10 / AC-8 + AC-9 — off by default + EAGENT_COMPACT=off kill switch
// ---------------------------------------------------------------------------

test("AC-8: off by default; enabling via store flips it on", async () => {
  const count = { sub: 0, real: 0 };
  const h = makeHarness({ responder: makeResponder({ count }) });
  const e = await activate(h); // no enabled set

  const saved = process.env.EAGENT_COMPACT;
  delete process.env.EAGENT_COMPACT;
  try {
    const off = await applyHook(h, overBudget());
    assert.equal(summaries(off).length, 0, "off by default: no summary");
    assert.equal(count.sub, 0, "off by default: no sub-call");

    e.store.set("enabled", true);
    const on = await applyHook(h, overBudget());
    assert.equal(summaries(on).length, 1, "enabling flips it on");
  } finally {
    if (saved === undefined) delete process.env.EAGENT_COMPACT;
    else process.env.EAGENT_COMPACT = saved;
  }
});

test("AC-9: EAGENT_COMPACT=off is a hard kill even when enabled", async () => {
  const count = { sub: 0, real: 0 };
  const h = makeHarness({ responder: makeResponder({ count }) });
  await activate(h, { enabled: true });

  const saved = process.env.EAGENT_COMPACT;
  process.env.EAGENT_COMPACT = "off";
  try {
    const out = await applyHook(h, overBudget());
    assert.equal(summaries(out).length, 0, "kill switch: no summary");
    assert.equal(count.sub, 0, "kill switch: no sub-call");
  } finally {
    if (saved === undefined) delete process.env.EAGENT_COMPACT;
    else process.env.EAGENT_COMPACT = saved;
  }
});

// ---------------------------------------------------------------------------
// Task 11 / AC-10 — /compact supersedes memory's; dispose restores it
// ---------------------------------------------------------------------------

test("AC-10: /compact supersedes memory's command; disposing compact restores memory's", async () => {
  const h = makeHarness({
    responder: (req: CompletionRequest) => (isSummarizeReq(req) ? { text: STRUCTURED } : { text: "ok" }),
  });
  await h.host.use("memory", memory);
  const memoryDesc = h.commands.get("compact")?.description;
  assert.ok(memoryDesc, "memory registered /compact");

  await h.host.use("compact", compact);
  const compactDesc = h.commands.get("compact")?.description;
  assert.ok(compactDesc, "compact registered /compact");
  assert.notEqual(compactDesc, memoryDesc, "compact's /compact shadows memory's (distinct description)");

  await h.host.unload("compact");
  assert.equal(h.commands.get("compact")?.description, memoryDesc, "memory's /compact restored on dispose");
});

// ---------------------------------------------------------------------------
// Task 12 / AC-11 + AC-12 + AC-13 — recursion safety, fails open, clean dispose
// ---------------------------------------------------------------------------

test("AC-11: the sub-call is tool-less and the hook never re-enters", async () => {
  let subToolCount = -1;
  let hookEntries = 0;
  const responder = (req: CompletionRequest): { text: string } => {
    if (isSummarizeReq(req)) {
      subToolCount = req.tools.length;
      return { text: STRUCTURED };
    }
    return { text: "ok" };
  };
  const h = makeHarness({ responder });
  await activate(h, { enabled: true });

  // A sentinel filter that runs after compact, counting hook entries.
  h.agent.hooks.filter("transformContext", (m) => {
    hookEntries++;
    return m;
  });

  await applyHook(h, overBudget());
  assert.equal(subToolCount, 0, "sub-call ran with tools: []");
  assert.ok(hookEntries <= 1, "the compaction sub-call did not re-enter the hook");
});

test("AC-12: an empty sub-call reply still yields a non-empty fallback summary", async () => {
  const h = makeHarness({
    responder: (req: CompletionRequest) => (isSummarizeReq(req) ? { text: "" } : { text: "ok" }),
  });
  await activate(h, { enabled: true });

  const out = await applyHook(h, overBudget());
  const s = summaries(out);
  assert.equal(s.length, 1, "a summary message exists despite the empty reply");
  assert.ok(textOf(s[0]!).trim().length > 0, "fallback summary is non-empty");
});

test("AC-13: dispose removes the hook, the command, and both tools, and never throws", async () => {
  const h = makeHarness({ responder: makeResponder() });
  const hooksBefore = h.agent.hooks.listenerCount("transformContext");
  const cmdBefore = h.commands.get("compact");

  await h.host.use("compact", compact);
  assert.equal(h.agent.hooks.listenerCount("transformContext"), hooksBefore + 1, "one hook added");
  assert.ok(h.commands.get("compact"), "command added");
  assert.ok(h.agent.tools.get("pin"), "pin added");
  assert.ok(h.agent.tools.get("unpin"), "unpin added");

  await assert.doesNotReject(h.host.unload("compact"), "unload never throws");

  assert.equal(h.agent.hooks.listenerCount("transformContext"), hooksBefore, "hook removed");
  assert.equal(h.commands.get("compact"), cmdBefore, "command removed (back to baseline)");
  assert.equal(h.agent.tools.get("pin"), undefined, "pin removed");
  assert.equal(h.agent.tools.get("unpin"), undefined, "unpin removed");
});

// ---------------------------------------------------------------------------
// /compact command surface (force + status + on/off + pin)
// ---------------------------------------------------------------------------

test("/compact status reports config; /compact on enables; /compact force folds", async () => {
  const h = makeHarness({ responder: makeResponder() });
  await activate(h, { enabled: true });

  const run = async (args: string): Promise<string[]> => {
    const out: string[] = [];
    await h.commands.get("compact")!.run({ agent: h.agent, args, print: (l) => out.push(l) });
    return out;
  };

  // status (default)
  assert.match((await run("")).join("\n"), /enabled|budget|keepTurns|pins?/i);

  // pin via the command verb, then status shows a pin
  await run("pin note hello-world");
  assert.match((await run("status")).join("\n"), /1/);

  // force a fold over a seeded over-budget transcript
  h.agent.load(overBudget());
  const forced = (await run("force")).join("\n");
  assert.match(forced, /fold|compact|summar/i);
});
