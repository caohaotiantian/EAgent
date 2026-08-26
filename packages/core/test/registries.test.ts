/**
 * A VOCABULARY WITH TWO REPRESENTATIONS WILL DRIFT, and every gate walking the wrong one is
 * silently switched off.
 *
 * This file is what survived the design corpus. `docs-drift.test.ts` held both these checks and a
 * large machine for comparing prose to code — markers, confusable-character scanners, documented
 * interfaces. The prose is gone; the checks below never depended on it. **Each one compares two
 * representations that both live in `src/`**, which is why they outlived the documents.
 *
 * Four vocabularies, each declared in one place and used in another:
 *
 *   - error codes (`errors.ts` ↔ every `throw` site)
 *   - event types (`journal/events.ts` ↔ every append site)
 *   - escalation rules (`run/escalation.ts` ↔ every escalate site)
 *   - telemetry names (`telemetry/spans.ts` ↔ nowhere else, by rule)
 *
 * Both directions are checked for the first three, because the field has been burned by each:
 * a code the wire carried that nothing declared, and a code declared that nothing raises heading a
 * three-level design with nothing under it. **Ask of any registry: which of its two forms does
 * each gate walk, and what happens to the member that is only in the other?**
 *
 * The pinned lists are exact sets, not floors. Shrinking one is progress; growing one is a
 * deliberate decision to declare a name before its call site, which is allowed and must be seen.
 * Every entry carries a reason, and the reason is length-checked, because "TODO" is how a pin
 * becomes a graveyard.
 *
 * AND A REASON IS NOT ENOUGH, WHICH IS WHAT THE GRAVEYARD ACTUALLY LOOKED LIKE. These lists held
 * sixteen members — ten codes, six event types — every one of them with a sentence beside it that
 * no event could ever make false. A pin like that does its job in one direction only: it catches
 * the member that CHANGES, and protects the member that never does. Ten of the sixteen were
 * deleted for that reason and are named where they were declared; the six that stand carry a
 * CONDITION as well as a reason, and each condition is a claim about the tree that the work
 * landing will break:
 *
 *   - `E_JOIN_TIMEOUT` stands while no executor reads a join deadline.
 *   - each unappended event type stands while the files blocking its decision still name it.
 *
 * A blocked decision is not the same thing as an excuse. It says what should happen, who has to
 * do it, and what will make this test demand it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CODES } from "../src/errors.ts";
import { EVENT_TYPES } from "../src/journal/events.ts";
import { ESCALATION_RULES } from "../src/run/escalation.ts";

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const PKG_DIR = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(dir = SRC_DIR, out: string[] = []): readonly string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Comments are not call sites.
 *
 * They used to count, and that was a silent false negative in the check that exists to catch a
 * declared-but-never-raised code: one docstring naming a code was enough to keep it off the list
 * forever. About a fifth of this tree's `E_*` occurrences outside `errors.ts` are in comments.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "s" | "d" | "t" = "code";
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { state = "block"; i += 2; continue; }
      if (c === "'") state = "s";
      else if (c === '"') state = "d";
      else if (c === "`") state = "t";
      out += c; i += 1; continue;
    }
    if (state === "line") { if (c === "\n") { state = "code"; out += c; } i += 1; continue; }
    if (state === "block") { if (c === "*" && n === "/") { state = "code"; i += 2; continue; } i += 1; continue; }
    // inside a string literal: copy through, honouring escapes
    out += c;
    if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
    if ((state === "s" && c === "'") || (state === "d" && c === '"') || (state === "t" && c === "`")) state = "code";
    i += 1;
  }
  return out;
}

const CODE_RE = /(?<![A-Za-z0-9_])(E_[A-Z][A-Z0-9_]*)/g;
const matches = (text: string, re: RegExp): readonly string[] => [...text.matchAll(re)].map((m) => m[1]!);

const FILES = sourceFiles();
const CODE_TEXT = new Map(FILES.map((f) => [f, stripComments(readFileSync(f, "utf8"))] as const));
const declaredCodes = new Set(Object.keys(CODES));

const reasonsAreReal = (rows: readonly { readonly why: string }[], what: string): void => {
  const thin = rows.filter((r) => r.why.length < 40);
  assert.deepEqual(thin, [], `${what}: say what stands in for the member, or what would have to be built`);
};

// ── error codes ──────────────────────────────────────────────────────────────

/**
 * THE CODES NOTHING RAISES. There is one, and its excuse has a condition that can fail.
 *
 * There were TEN, each with a sentence beside it and no way for any of those sentences to
 * stop being true. Nine were deleted; `errors.ts`'s `CODES` docstring names them and says why
 * each was a promise rather than a plan — briefly: three named a condition the tree ALREADY
 * raises under another code or deliberately does not raise at all (`E_FENCING_STALE` for a
 * lost lease, `E_GATE_ALREADY_RESOLVED` for too late, a `goldenBlocker` for a thin cohort),
 * and the rest named a seam that does not exist (no secret resolver, no remote policy service,
 * no checkpoint addressed by id, no capacity mapping, no admission control).
 *
 * WHAT MAKES THE SURVIVOR DIFFERENT, and it is not that its subject is more important: a file
 * this list cannot edit NAMES it, in a recorded reversal — `graph/spec.ts`, on
 * `JoinNode.timeoutMs`: "when the deadline lands, this becomes required again,
 * `E_JOIN_TIMEOUT` leaves `NEVER_RAISED`". Deleting a code another module promises by name is
 * how a docstring becomes a lie. So it stands, and the test below states the condition it
 * stands ON — that no executor reads a join deadline — so the excuse expires by the work
 * landing rather than by somebody remembering.
 */
const NEVER_RAISED: readonly { readonly code: string; readonly why: string }[] = [
  {
    code: "E_JOIN_TIMEOUT",
    why:
      "`graph/spec.ts` names it in the recorded reversal for `JoinNode.timeoutMs`, which is declared and read by no executor; " +
      "`graph/validate.ts:1697` warns an author that the barrier has no deadline. The code goes when the deadline lands, " +
      "and the test below is that condition rather than a date",
  },
];

test("THE CODES NOTHING RAISES ARE EXACTLY THE ONES PINNED HERE", () => {
  const referenced = new Set<string>();
  for (const [file, text] of CODE_TEXT) {
    if (file.endsWith("/errors.ts")) continue; // the declaration is not a raise
    for (const code of matches(text, CODE_RE)) referenced.add(code);
  }
  const unraised = [...declaredCodes].filter((c) => !referenced.has(c)).sort();
  assert.deepEqual(
    unraised,
    NEVER_RAISED.map((e) => e.code).sort(),
    "a code became raisable (or stopped being raised) — reconcile what promised it, then update this list",
  );
});

test("every unraised code is one this file can name a reason for", () => {
  reasonsAreReal(NEVER_RAISED, "NEVER_RAISED");
  const unknown = NEVER_RAISED.map((e) => e.code).filter((c) => !declaredCodes.has(c));
  assert.deepEqual(unknown, [], "pinned as never-raised but not a declared error code at all");
});

/**
 * The condition `E_JOIN_TIMEOUT`'s excuse rests on, as a predicate over the tree.
 *
 * "No EXECUTOR reads a join deadline" and not "nothing reads it": `graph/validate.ts:1693`
 * reads `join.timeoutMs` today, to WARN that nobody enforces it, and `graph/spec.ts:699` lists
 * the field name. Both of those are the field being declared and refused, which is the state
 * the excuse describes; a read under `src/run/` is the field being USED, which is the state
 * that ends it.
 *
 * Passed the texts rather than reading files itself, so the self-test below can hand it a
 * synthetic tree and prove it is capable of answering `true`. A condition that cannot fail is
 * an indefinite pass wearing a function.
 */
function anExecutorReadsAJoinDeadline(texts: Iterable<readonly [string, string]>): boolean {
  for (const [file, text] of texts) {
    if (!file.includes("/run/")) continue;
    for (const line of text.split("\n")) {
      if (line.includes("timeoutMs") && line.includes("join")) return true;
    }
  }
  return false;
}

test("E_JOIN_TIMEOUT'S EXCUSE STILL HOLDS — no executor reads a join deadline", () => {
  assert.equal(
    anExecutorReadsAJoinDeadline(CODE_TEXT),
    false,
    "something under src/run/ now reads a join's timeoutMs — the deadline landed, so E_JOIN_TIMEOUT must be raised " +
      "where it fires and leave NEVER_RAISED, and graph/spec.ts's reversal note goes with it",
  );
});

test("and that condition is one that can fail", () => {
  // The real function, not a restatement of it: asserting a copy is how a gate that stopped
  // discriminating keeps reporting success.
  assert.equal(
    anExecutorReadsAJoinDeadline([["src/run/engine.ts", "const ms = join.timeoutMs ?? Infinity;"]]),
    true,
    "an executor reading a join deadline must be detected",
  );
  assert.equal(
    anExecutorReadsAJoinDeadline([["src/graph/validate.ts", "if (join.timeoutMs !== undefined) {"]]),
    false,
    "the validator's refusal of the field is not an executor reading it",
  );
  assert.equal(
    anExecutorReadsAJoinDeadline([["src/run/engine.ts", "if (w.node.timeoutMs !== undefined) {"]]),
    false,
    "a NODE timeout, which IS enforced, must not be mistaken for a join deadline",
  );
});

test("THE OTHER DIRECTION: EVERY CODE src/ USES IS A CODE errors.ts DECLARES", () => {
  // The reverse is the one that reaches a client. The control plane once wrote a refusal as a
  // bare literal — a code that was on the wire, asserted by two tests, and declared nowhere.
  // Being undeclared made it invisible to every gate that exists to stop exactly that.
  const used = new Set<string>();
  for (const [file, text] of CODE_TEXT) {
    if (file.endsWith("/errors.ts")) continue;
    for (const code of matches(text, CODE_RE)) used.add(code);
  }
  const undeclared = [...used].filter((c) => !declaredCodes.has(c)).sort();
  assert.deepEqual(undeclared, [], "src/ uses an error code errors.ts does not declare — declare it or stop sending it");
});

// ── event types ──────────────────────────────────────────────────────────────

/**
 * THE TYPES NOTHING APPENDS — each with a DECISION, and each decision with a condition that
 * ends the row.
 *
 * There were six, each excused indefinitely. `config.reloaded` is gone: nothing in the tree
 * referred to it, no reload path exists, and no work item plans one, so it was a row in a
 * closed vocabulary promising a fact nobody records. The five left cannot be settled from
 * this package's registry files alone — every one needs `run/projection.ts` (kernel),
 * `run/engine.ts`, `evolution/trajectory.ts`, `telemetry/spans.ts` or a suite owned
 * elsewhere — so each carries what it is waiting for, by path.
 *
 * `blockedOn` IS THE EXPIRY, and it works in the direction that actually decays. An excuse
 * dies when its own reason does: the moment the last file listed stops mentioning the type,
 * the decision below is no longer blocked and this test fails until somebody executes it.
 * That is the failure mode this list has already had once — `journal/audit.ts` carried two
 * rules over never-appended types, reported them `checked` on every terminal run, and nothing
 * connected the excuse to the rule.
 *
 * `type: "…"` spelling is load-bearing: `journal/audit-coverage.test.ts` parses this block for
 * it, so the two registries cannot drift into disagreeing about who is unappended.
 */
const NEVER_APPENDED: readonly {
  readonly type: string;
  readonly decision: "wire" | "delete";
  readonly why: string;
  /** Paths, relative to `packages/core/`, that must change before the decision can be executed. */
  readonly blockedOn: readonly string[];
}[] = [
  {
    type: "budget.reserved",
    decision: "wire",
    why:
      "CLAUDE.md's first non-negotiable, exactly: a decision reads a value the journal cannot reconstruct. `PolicyEngine.reserve` " +
      "holds the reservation in memory, so a crashed worker's reservation is unrecoverable by folding, and `projection.ts:1112` " +
      "already folds `reservedUsd` from this event — it folds zero. The appender belongs at the engine's `ctx.policy.reserve` call site",
    blockedOn: ["src/run/policy.ts", "src/run/engine.ts", "src/run/projection.ts"],
  },
  {
    type: "budget.settled",
    decision: "wire",
    why:
      "the other half of the same reservation, folded at `projection.ts:1116`, and the same restart hole: the balance moves in " +
      "memory with no durable record of the movement. One change with budget.reserved, or the fold releases what it never took",
    blockedOn: ["src/run/policy.ts", "src/run/engine.ts", "src/run/projection.ts"],
  },
  {
    type: "task.skipped",
    decision: "wire",
    why:
      "the skipped STATE is read three times — the join's branch-error accounting in `engine.ts`, `trajectory.ts` and `spans.ts` — " +
      "and cannot be set, so `onBranchError: \"fail\"` counts a population that cannot exist. The appender belongs where " +
      "`#absorbedByJoin` contains a failed branch: that is the moment a Task is skipped rather than failed",
    blockedOn: ["src/run/engine.ts", "src/run/projection.ts", "src/evolution/trajectory.ts", "src/telemetry/spans.ts"],
  },
  {
    type: "channel.written",
    decision: "delete",
    why:
      "its only reader is a fold arm whose whole body is `Nothing to fold` — the authoritative value rides on " +
      "`task.committed.writes`, and a per-channel audit row that nothing writes audits nothing. Deleting it means dropping that " +
      "arm and two `server/http.ts` docstring mentions in the same change",
    blockedOn: ["src/run/projection.ts", "src/server/http.ts"],
  },
  {
    type: "task.started",
    decision: "delete",
    why:
      "leasing IS the start and no code distinguishes them. It has already cost a silent false negative: " +
      "`test/run/advance-reentrancy.test.ts` filters the journal for this type, so its headline assertion — every Task starts " +
      "once — compares 0 to 0 on a run that leases 7 times. Fixing that test to read `task.leased` unblocks the deletion",
    blockedOn: ["test/run/advance-reentrancy.test.ts", "test/scale.test.ts"],
  },
];

test("EVERY DECLARED EVENT TYPE HAS AN APPENDER, except the ones pinned here", () => {
  // A declared-and-folded event with no appender is a designed transition that was never wired,
  // and it is invisible from any single file — the fold reads like proof that something writes it.
  const appended = new Set<string>();
  for (const [file, text] of CODE_TEXT) {
    if (file.endsWith("/journal/events.ts")) continue; // the declaration is not an append
    for (const m of text.matchAll(/type:\s*"([a-z_]+\.[a-z_]+)"/g)) appended.add(m[1]!);
  }
  const unappended = EVENT_TYPES.filter((t) => !appended.has(t)).sort();
  assert.deepEqual(
    unappended,
    NEVER_APPENDED.map((e) => e.type).sort(),
    "an event type gained (or lost) its only appender — wire it, or pin it here with a reason",
  );
});

test("every unappended event type is one this file can name a reason for", () => {
  reasonsAreReal(NEVER_APPENDED, "NEVER_APPENDED");
  const known = new Set<string>(EVENT_TYPES);
  const unknown = NEVER_APPENDED.map((e) => e.type).filter((t) => !known.has(t));
  assert.deepEqual(unknown, [], "pinned as never-appended but not a declared event type at all");
});

test("EVERY EXCUSE IS STILL BLOCKED — the moment it is not, the decision must be executed", () => {
  // The condition, not a date. Each row says what it is waiting for; when the last file
  // listed stops mentioning the type, nothing is holding the decision up any more and this
  // goes red. An excuse must not outlive its own reason — that is how six of these came to
  // stand for as long as they did.
  const stale: string[] = [];
  for (const row of NEVER_APPENDED) {
    assert.ok(row.blockedOn.length > 0, `${row.type}: a decision with nothing blocking it is a decision to execute now`);
    const holding = row.blockedOn.filter((rel) => {
      const full = join(PKG_DIR, rel);
      assert.ok(existsSync(full), `${row.type} is blocked on ${rel}, which is not in the tree`);
      return readFileSync(full, "utf8").includes(row.type);
    });
    if (holding.length === 0) {
      stale.push(`${row.type}: nothing in ${row.blockedOn.join(", ")} mentions it any more — ${row.decision} it`);
    }
  }
  assert.deepEqual(stale, [], "an excuse outlived its reason");
});

// ── escalation rules ─────────────────────────────────────────────────────────

const RULES_NEVER_RAISED: readonly { readonly id: string; readonly why: string }[] = [
  {
    id: "budget_exhausted",
    why: "its only trigger is a budget action that is now a compile error, because it escalated the ceiling for decisions a dead run would never make and then failed anyway — the word promised a human and delivered a failure",
  },
];

test("EVERY ESCALATION RULE IS RAISED SOMEWHERE, except the ones pinned here", () => {
  const raised = new Set<string>();
  for (const [file, text] of CODE_TEXT) {
    if (file.endsWith("/run/escalation.ts")) continue;
    for (const id of Object.keys(ESCALATION_RULES)) {
      if (text.includes(`"${id}"`)) raised.add(id);
    }
  }
  const unraised = Object.keys(ESCALATION_RULES).filter((id) => !raised.has(id)).sort();
  assert.deepEqual(
    unraised,
    RULES_NEVER_RAISED.map((e) => e.id).sort(),
    "an escalation rule gained (or lost) its only caller — wire it, or pin it here with a reason",
  );
});

test("every unraised escalation rule is one this file can name a reason for", () => {
  reasonsAreReal(RULES_NEVER_RAISED, "RULES_NEVER_RAISED");
  const known = new Set(Object.keys(ESCALATION_RULES));
  const unknown = RULES_NEVER_RAISED.map((e) => e.id).filter((id) => !known.has(id));
  assert.deepEqual(unknown, [], "pinned as never-raised but not a declared escalation rule at all");
});

// ── telemetry names ──────────────────────────────────────────────────────────

test("ONE FILE OWNS THE TELEMETRY VOCABULARY", () => {
  // A span name spelled in two files is a name that can be spelled two ways. The rule is not
  // that spans are special — it is that a vocabulary with one representation cannot drift, and
  // this is the cheapest way to hold a vocabulary to one representation.
  const NON_TELEMETRY = new Set(["loom.dev", "loom.yaml", "loom.token", "loom.internal"]);
  const offenders: string[] = [];
  for (const [file, text] of CODE_TEXT) {
    if (file.endsWith("/telemetry/spans.ts")) continue;
    for (const m of text.matchAll(/"(loom\.[a-zA-Z0-9_.]+)"/g)) {
      const name = m[1]!;
      if (!NON_TELEMETRY.has(name)) offenders.push(`${file.slice(SRC_DIR.length)}: ${name}`);
    }
  }
  assert.deepEqual(offenders, [], "a loom.* telemetry name is spelled outside telemetry/spans.ts");
});

// ── the ratchet ──────────────────────────────────────────────────────────────

test("NEITHER EXCUSE LIST MAY GROW — a well-argued zombie is still a zombie", () => {
  // THE HOLE THE REST OF THIS FILE DOES NOT CLOSE, and the one that produced sixteen members.
  // Every check above compares the set of unwritten members to a pinned list, so the way to
  // pass is to add the member to the list — with a fat reason, which `reasonsAreReal` will
  // happily accept, and which is exactly how each of the sixteen got in. A reason is an
  // argument that a name may be declared early; it is not a bound on how often that argument
  // may be made.
  //
  // A floor, not an equality, in the direction that matters: wiring or deleting a member and
  // shrinking these lists must not cost a test edit. Growing them must, and must be argued in
  // a commit message rather than a string. `audit-coverage.test.ts` holds the same ratchet
  // over its `todo` excuses for the same reason.
  assert.ok(
    NEVER_RAISED.length <= 1,
    `${NEVER_RAISED.length} error codes are declared with no raiser; it was TEN before the sweep and is ` +
      `ONE now — raise the new one where it belongs, or do not declare it until you do`,
  );
  assert.ok(
    NEVER_APPENDED.length <= 5,
    `${NEVER_APPENDED.length} event types are declared with no appender; it was SIX and is FIVE — ` +
      `journal/events.ts is kernel, and a closed vocabulary that only ever grows is not one`,
  );
});

test("the registries are non-empty, so none of the above can pass vacuously", () => {
  // Every check here is "the set of X with property P equals this pinned list". If the set of X
  // were empty, each would pass while asserting nothing — the shape this repo has shipped twice.
  assert.ok(declaredCodes.size >= 40, `errors.ts declares ${String(declaredCodes.size)} codes`);
  assert.ok(EVENT_TYPES.length >= 30, `EVENT_TYPES has ${String(EVENT_TYPES.length)} members`);
  assert.ok(Object.keys(ESCALATION_RULES).length >= 8, "ESCALATION_RULES is populated");
  assert.ok(FILES.length >= 40, `scanned ${String(FILES.length)} source files`);
});
