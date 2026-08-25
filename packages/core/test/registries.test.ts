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
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CODES } from "../src/errors.ts";
import { EVENT_TYPES } from "../src/journal/events.ts";
import { ESCALATION_RULES } from "../src/run/escalation.ts";

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

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

const NEVER_RAISED: readonly string[] = [
  "E_ADMISSION_REJECTED", // nothing admits, so nothing rejects — see TODO.md §A
  "E_CHECKPOINT_NOT_FOUND",
  "E_INSUFFICIENT_COHORT",
  "E_JOIN_TIMEOUT", // the join timeout field is accepted and enforced by nothing
  "E_LEASE_LOST", // the STORE raises this; nothing in src/ raises it directly
  "E_POLICY_UNAVAILABLE",
  "E_SECRET_UNAVAILABLE",
  "E_STORAGE_FULL",
  "E_TOOL_NOT_IDEMPOTENT",
  "E_TOO_LATE",
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
    [...NEVER_RAISED].sort(),
    "a code became raisable (or stopped being raised) — reconcile what promised it, then update this list",
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

const NEVER_APPENDED: readonly { readonly type: string; readonly why: string }[] = [
  {
    type: "budget.reserved",
    why: "the policy engine holds a reservation in memory and journals nothing, so a crashed worker's reservation cannot be recovered by folding",
  },
  { type: "budget.settled", why: "same as budget.reserved: the balance moves in memory only, with no durable record of the movement" },
  {
    type: "channel.written",
    why: "a reduction is journaled whole as state.reduced; there is no per-channel event, so the fold for this type is unreachable",
  },
  {
    type: "config.reloaded",
    why: "there is no reload path in src/ at all — no signal handler, no admin endpoint — so nothing can announce one",
  },
  {
    type: "task.skipped",
    why: "nothing marks a Task skipped, so the skipped task state is unreachable, which also makes a join's branch-error accounting count a population that cannot exist",
  },
  {
    type: "task.started",
    why: "leasing is the start and no code distinguishes the two; delete it, or make leasing and starting different facts",
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

test("the registries are non-empty, so none of the above can pass vacuously", () => {
  // Every check here is "the set of X with property P equals this pinned list". If the set of X
  // were empty, each would pass while asserting nothing — the shape this repo has shipped twice.
  assert.ok(declaredCodes.size >= 40, `errors.ts declares ${String(declaredCodes.size)} codes`);
  assert.ok(EVENT_TYPES.length >= 30, `EVENT_TYPES has ${String(EVENT_TYPES.length)} members`);
  assert.ok(Object.keys(ESCALATION_RULES).length >= 8, "ESCALATION_RULES is populated");
  assert.ok(FILES.length >= 40, `scanned ${String(FILES.length)} source files`);
});
