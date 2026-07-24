/**
 * Phase 4 — the Ink single-session client (design D1/D3/D4, AC2/AC3/AC4).
 *
 * Offline component/frame tests via `ink-testing-library` (KDD8): `render()` +
 * `lastFrame()` over a fake TTY, no raw mode, no network. The transcript is fed a
 * `ViewModel` folded from a scripted attribution-tagged event sequence (the same
 * pure reducer the engine plain renderer uses), so these assertions pin the rich
 * client's rendering, not a re-implementation of the model.
 *
 *   - AC2: the section tree renders — a reasoning header, an expanded tool card
 *     with FULL untruncated args, and a nested subagent card.
 *   - AC3: the coalescing adapter batches K deltas within one frame interval into
 *     ≤1 state update (the KDD4 throughput budget).
 *   - AC4: a transcript far exceeding a fixed `rows` is windowed — the frame
 *     height stays bounded by the terminal rows, independent of transcript length.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";

import { Transcript, parseControl } from "../../src/tui/app.js";
import { Coalescer } from "../../src/tui/coalesce.js";
import { initialModel, reduce, type TaggedEvent, type ViewModel } from "../../src/view-model.js";
import type { ToolCallBlock, ToolResult } from "../../src/kernel/types.js";

/** Fold a scripted tagged-event sequence through the real reducer into a model. */
function fold(events: TaggedEvent[], mode: "auto" | "full" | "collapsed" = "auto"): ViewModel {
  let m = initialModel(mode);
  for (const ev of events) m = reduce(m, ev);
  return m;
}

/** Strip every whitespace run so a substring assertion survives Ink's line wrap
 *  (a wrapped spaceless token is rejoined) — the frame content, not its layout. */
const norm = (s: string): string => s.replace(/\s+/g, "");

const call = (id: string, name: string, args: Record<string, unknown>): ToolCallBlock => ({
  type: "tool_call",
  id,
  name,
  arguments: args,
});
const okResult = (content: string): ToolResult => ({ content, isError: false });

// -- AC2: the section tree renders (reasoning header + expanded tool card with
//         full args + a nested subagent card) --------------------------------

test("AC2: the transcript renders the section tree with full untruncated args and a nested subagent card", () => {
  // `strategy` is long enough that the collapsed one-line header (SUMMARY_WIDTH 80)
  // clips before `tail`, so OMEGATAILMARKER can only appear once the card's full
  // args are rendered — a real RED against a header-only / truncating renderer.
  const strategy = "exhaustively-compare-every-candidate-across-the-full-search-frontier";
  const model = fold(
    [
      { kind: "agent_start", actingId: "r", rootId: "r", at: 0 },
      { kind: "reasoning_delta", text: "planning the search", actingId: "r", rootId: "r", at: 1 },
      { kind: "tool_start", call: call("c1", "best_of_n", { strategy, n: 5, tail: "OMEGATAILMARKER" }), actingId: "r", rootId: "r", at: 2 },
      // A forked child's own tool call, streamed while the spawn card is open, nests
      // under it as a subagent card (attributed to a non-root acting agent).
      { kind: "tool_start", call: call("c2", "read", { path: "/etc/hosts" }), actingId: "child", rootId: "r", at: 3 },
      { kind: "tool_end", call: call("c2", "read", {}), result: okResult("127.0.0.1 localhost"), actingId: "child", rootId: "r", at: 4 },
      { kind: "tool_end", call: call("c1", "best_of_n", {}), result: okResult("chose candidate 3"), actingId: "r", rootId: "r", at: 5 },
      { kind: "agent_end", reason: "end_turn", actingId: "r", rootId: "r", at: 6 },
    ],
    "full",
  );

  const { lastFrame } = render(<Transcript model={model} />);
  const frame = lastFrame() ?? "";
  const flat = norm(frame);

  assert.match(frame, /Reasoning/, "the reasoning section renders a header");
  assert.match(frame, /best_of_n/, "the spawn tool card renders by name");
  assert.ok(flat.includes("OMEGATAILMARKER"), "the expanded tool card shows the FULL untruncated args (past the collapsed summary width)");
  assert.match(frame, /read/, "the nested subagent card renders by name");
  assert.ok(flat.includes("/etc/hosts"), "the nested subagent card shows its own args");
});

// -- AC3: the coalescing adapter batches deltas to ≤1 state update per frame ----

test("AC3: K reasoning_delta events within one frame interval commit as a single state update", () => {
  const flushes: Array<() => void> = [];
  const emits: ViewModel[] = [];
  const coalescer = new Coalescer((m) => emits.push(m), {
    schedule: (cb) => {
      flushes.push(cb);
      return flushes.length - 1;
    },
    cancel: () => {},
  });

  const K = 50;
  for (let i = 0; i < K; i++) {
    coalescer.push({ kind: "reasoning_delta", text: `tok${i} `, actingId: "r", rootId: "r", at: i });
  }

  assert.equal(flushes.length, 1, "K deltas within one interval arm exactly one pending flush (not one per delta)");
  assert.equal(emits.length, 0, "no state update commits before the frame boundary");

  flushes[0]!(); // the frame boundary fires
  assert.equal(emits.length, 1, `the whole batch of ${K} deltas commits as a single state update`);

  // The one committed model folded every delta (nothing was dropped by coalescing).
  const committed = emits[0]!;
  const text = committed.sections.map((s) => ("text" in s ? s.text : "")).join("");
  assert.ok(text.includes("tok0 ") && text.includes(`tok${K - 1} `), "the coalesced model retains every batched delta");

  // A fresh delta after the flush arms the next frame's flush (a new batch begins).
  coalescer.push({ kind: "reasoning_delta", text: "next", actingId: "r", rootId: "r", at: K });
  assert.equal(flushes.length, 2, "a delta after a flush arms the next frame's single flush");
});

// -- AC4: the viewport is windowed to the terminal rows ------------------------

test("AC4: a transcript far exceeding the terminal rows is windowed to a bounded frame height", () => {
  const rows = 8;
  // One expanded reasoning section whose body is hundreds of lines — the whole
  // transcript dwarfs `rows`, yet the windowed frame must stay bounded by it.
  const big = Array.from({ length: 300 }, (_, i) => `reasoning line ${i}`).join("\n");
  const model = fold([
    { kind: "agent_start", actingId: "r", rootId: "r", at: 0 },
    { kind: "reasoning_delta", text: big, actingId: "r", rootId: "r", at: 1 },
  ]);

  const { lastFrame } = render(<Transcript model={model} rows={rows} />);
  const height = (lastFrame() ?? "").split("\n").length;
  assert.ok(height <= rows, `frame height ${height} is bounded by rows=${rows} (windowed), not the ~300-line transcript`);
  assert.ok(height > 0, "the window still renders the visible tail");
});

// -- parseControl: the /details|/expand|/collapse input dispatcher --------------
// The pure map from a typed slash-line to a Coalescer control (or null). Drives
// App's `useInput` branch; unit-tested here since App itself needs a raw-mode TTY.

test("parseControl: /details maps a valid mode and rejects an invalid one", () => {
  assert.deepEqual(parseControl("/details full"), { kind: "mode", mode: "full" });
  assert.deepEqual(parseControl("/details collapsed"), { kind: "mode", mode: "collapsed" });
  assert.deepEqual(parseControl("/details auto"), { kind: "mode", mode: "auto" });
  assert.equal(parseControl("/details bogus"), null, "an unrecognised mode is not a control");
  assert.equal(parseControl("/details"), null, "a bare /details (no mode) is not a control");
});

test("parseControl: /expand and /collapse take an integer index >= 1", () => {
  assert.deepEqual(parseControl("/expand 3"), { kind: "expand", n: 3 });
  assert.deepEqual(parseControl("/collapse 2"), { kind: "collapse", n: 2 });
});

test("parseControl: /expand|/collapse reject non-positive, non-integer, and missing indices", () => {
  assert.equal(parseControl("/expand 0"), null, "0 is below the >= 1 gate");
  assert.equal(parseControl("/expand -1"), null, "a negative index is rejected");
  assert.equal(parseControl("/expand 1.5"), null, "a non-integer index is rejected");
  assert.equal(parseControl("/collapse abc"), null, "a non-numeric index (NaN) is rejected");
  assert.equal(parseControl("/expand"), null, "a missing index (NaN) is rejected");
});

test("parseControl: an unknown command is not a control", () => {
  assert.equal(parseControl("/frobnicate 1"), null);
});
