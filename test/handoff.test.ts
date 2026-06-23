/**
 * handoff — a session resume document written on agent_end / via /handoff.
 *
 * The pure pieces (slugify, renderFallback / the fixed schema) are unit-tested
 * directly; the command and the auto-trigger are exercised through the agent
 * loop with ONLY handoff loaded, writing into a temp EAGENT_WORKSPACE/.eagent
 * tree, so any written file is unambiguously handoff's. All offline against the
 * scriptable MockProvider.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeHarness } from "./helpers.js";
import type { CompletionRequest, Message } from "../src/kernel/types.js";
import handoff, {
  slugify,
  renderFallback,
  ensureSchema,
  HANDOFF_SYSTEM_PROMPT,
  __setNow,
  salientTokens,
  goalText,
  isRelevant,
  scanHandoffs,
  selectResume,
  capBody,
  resumeMessage,
  type ResumeCandidate,
  RESUME_FENCE_OPEN,
  DEFAULT_RESUME_MAX_AGE_HOURS,
} from "../src/extensions/handoff.js";

// The nine fixed schema sections + the reactivation paragraph (design D3).
const SECTIONS = [
  "## Goal",
  "## Completed",
  "## In progress",
  "## Pending",
  "## Files touched",
  "## Commands run",
  "## Open decisions",
  "## Do not touch",
  "## Next steps",
  "## Reactivation",
] as const;

// -- T1 unit: the fixed schema and the slug derivation -----------------------

test("renderFallback emits every required section header in order (fixed schema)", () => {
  // Business invariant D3: the handoff is a fixed schema, never free-form — a
  // resumer scans named sections instead of re-reading prose.
  const content = renderFallback(
    [
      { role: "user", content: [{ type: "text", text: "Fix the login bug" }] },
      { role: "assistant", content: [{ type: "text", text: "looking into it" }] },
    ],
    "Fix the login bug",
  );
  let cursor = 0;
  for (const header of SECTIONS) {
    const at = content.indexOf(header, cursor);
    assert.ok(at >= 0, `fallback digest must contain "${header}"`);
    assert.ok(at >= cursor, `"${header}" must appear in schema order`);
    cursor = at + header.length;
  }
});

test("renderFallback is non-empty even for an empty transcript", () => {
  // D2/AC-8: the fail-open digest guarantees a non-empty, schema-valid file.
  const content = renderFallback([], "");
  assert.ok(content.length > 0);
  for (const header of SECTIONS) assert.ok(content.includes(header));
});

test("ensureSchema back-fills a section header the model dropped (schema D3)", () => {
  // Invariant D3: a partial model summary missing a required section gets the
  // header appended so the artifact always satisfies the fixed schema. Drop a
  // middle section (## Do not touch) AND the trailing ## Reactivation to exercise
  // both the generic filler and the reactivation-specific filler branch.
  const partial =
    "## Goal\nFix the bug\n" +
    "## Completed\n- read code\n" +
    "## In progress\n- tracing\n" +
    "## Pending\n- the test\n" +
    "## Files touched\n- src/auth.ts\n" +
    "## Commands run\n- npm test\n" +
    "## Open decisions\n- token rotation\n" +
    "## Next steps\n1. add test\n2. ship";
  // Sanity: the input is genuinely missing the two dropped sections.
  assert.ok(!partial.includes("## Do not touch"), "fixture omits ## Do not touch");
  assert.ok(!partial.includes("## Reactivation"), "fixture omits ## Reactivation");

  const filled = ensureSchema(partial, "Fix the bug");

  // Every required section header is now present.
  for (const header of SECTIONS) {
    assert.ok(filled.includes(header), `ensureSchema back-fills "${header}"`);
  }
  // The already-present sections are preserved verbatim.
  assert.ok(filled.includes("## Goal\nFix the bug"), "existing sections preserved");
  // The reactivation filler is goal-aware (its dedicated branch, not "(not reported)").
  assert.match(filled, /## Reactivation\nResume the work toward: Fix the bug\./);
  // The middle drop got the generic filler.
  assert.match(filled, /## Do not touch\n\(not reported\)/);
});

test("ensureSchema returns a complete summary unchanged", () => {
  // A summary already carrying every header is returned byte-for-byte.
  const complete = SECTIONS.map((h) => `${h}\nbody`).join("\n");
  assert.equal(ensureSchema(complete, "any goal"), complete, "complete summary is untouched");
});

test("HANDOFF_SYSTEM_PROMPT names the nine sections + reactivation and a branch word", () => {
  for (const header of SECTIONS) {
    assert.ok(HANDOFF_SYSTEM_PROMPT.includes(header), `prompt must name "${header}"`);
  }
  // The test responder branches on this distinctive token (compact.ts:46-48
  // "recognizable token" convention).
  assert.match(HANDOFF_SYSTEM_PROMPT.toLowerCase(), /handoff/);
});

test("slugify kebab-cases and lowercases a goal", () => {
  assert.equal(slugify("Fix the login bug"), "fix-the-login-bug");
});

test("slugify maps an empty/whitespace goal to 'session'", () => {
  assert.equal(slugify("  "), "session");
  assert.equal(slugify(""), "session");
});

test("slugify caps length to <= 40 chars with no trailing dash", () => {
  const long = "Refactor the entire authentication and authorization subsystem end to end";
  const s = slugify(long);
  assert.ok(s.length <= 40, `slug "${s}" must be <= 40 chars`);
  assert.ok(!s.endsWith("-"), `slug "${s}" must not end with a dash`);
});

test("slugify collapses punctuation/non-ASCII to single dash runs", () => {
  const s = slugify("Refactor: auth & DB!!");
  assert.ok(!/[:&!]/.test(s), `slug "${s}" must drop punctuation`);
  assert.ok(!s.includes("--"), `slug "${s}" must not have doubled dashes`);
  assert.equal(s, "refactor-auth-db");
});

// -- live: harness + scratch workspace ---------------------------------------

/** A scratch workspace; EAGENT_WORKSPACE points handoff's writer here. */
function scratch(): { dir: string; handoffsDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "eagent-handoff-"));
  const prev = process.env.EAGENT_WORKSPACE;
  process.env.EAGENT_WORKSPACE = dir;
  return {
    dir,
    handoffsDir: join(dir, ".eagent", "handoffs"),
    cleanup: () => {
      if (prev === undefined) delete process.env.EAGENT_WORKSPACE;
      else process.env.EAGENT_WORKSPACE = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A unique marker the mock summary embeds, so we know the model drove the write. */
const SUMMARY_MARKER = "HANDOFF-SUMMARY-MARKER-42";

/** A schema-shaped summary body the mock returns for the handoff sub-call. */
const MOCK_SUMMARY =
  `## Goal\nFix the login bug — ${SUMMARY_MARKER}\n` +
  "## Completed\n- read the auth module\n" +
  "## In progress\n- tracing the token refresh\n" +
  "## Pending\n- write the regression test\n" +
  "## Files touched\n- src/auth.ts\n" +
  "## Commands run\n- npm test\n" +
  "## Open decisions\n- whether to rotate tokens\n" +
  "## Do not touch\n- the prod secrets file\n" +
  "## Next steps\n1. add the test\n2. ship it\n" +
  "## Reactivation\nResume by reopening src/auth.ts and running npm test.\n";

/**
 * A responder function that serves the handoff summary sub-call (branching on
 * the handoff system prompt's distinctive word) and a normal turn otherwise.
 */
function summarizingResponder() {
  return (req: { systemPrompt?: string }): { text: string } => {
    if ((req.systemPrompt ?? "").toLowerCase().includes("handoff")) {
      return { text: MOCK_SUMMARY };
    }
    return { text: "ok, done." };
  };
}

/** Run the /handoff command directly through the command registry. */
async function runHandoff(h: ReturnType<typeof makeHarness>, args = ""): Promise<string[]> {
  const cmd = h.commands.get("handoff-doc");
  assert.ok(cmd, "the /handoff-doc command must be registered");
  const out: string[] = [];
  await cmd.run({ agent: h.agent, args, print: (l: string) => out.push(l) });
  return out;
}

// -- T3 live: the /handoff command -------------------------------------------

test("AC-1/AC-2/AC-3: /handoff writes the model summary in the fixed schema with a reactivation paragraph", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    const h = makeHarness({ responder: summarizingResponder() });
    await h.host.use("handoff", handoff);
    await h.agent.run("Fix the login bug");

    await runHandoff(h);

    const files = readdirSync(s.handoffsDir);
    assert.equal(files.length, 1, "exactly one handoff file written");
    const content = readFileSync(join(s.handoffsDir, files[0]!), "utf8");

    // AC-1: the model's distilled summary is what got written.
    assert.ok(content.includes(SUMMARY_MARKER), "file contains the mock summary marker");
    // AC-2: every fixed-schema section present.
    for (const header of SECTIONS.slice(0, 9)) {
      assert.ok(new RegExp(header).test(content), `file contains "${header}"`);
    }
    // AC-3: a non-empty reactivation paragraph.
    assert.match(content, /## Reactivation/);
    const body = content.slice(content.indexOf("## Reactivation") + "## Reactivation".length).trim();
    assert.ok(body.length > 0, "reactivation body is non-empty");
  } finally {
    __setNow();
    s.cleanup();
  }
});

test("AC-4: /handoff works on demand with the auto-trigger off; filename matches <date>-<slug>.md", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    const h = makeHarness({ responder: summarizingResponder() });
    await h.host.use("handoff", handoff); // enabled flag unset (off by default)
    await h.agent.run("Fix the login bug");

    await runHandoff(h);

    const files = readdirSync(s.handoffsDir);
    assert.equal(files.length, 1, "exactly one file written on demand");
    assert.match(files[0]!, /^\d{4}-\d{2}-\d{2}-.+\.md$/, "filename is <date>-<slug>.md");
    assert.ok(files[0]!.includes("fix-the-login-bug"), "slug derives from the first user message");
  } finally {
    __setNow();
    s.cleanup();
  }
});

test("AC-8: fail-open — /handoff still writes a schema-valid file when the sub-call throws", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  let running = false;
  try {
    // The run's own turns serve normally, but the handoff sub-call throws — the
    // summarizer must fail open to the deterministic digest (design D2/R5).
    const h = makeHarness({
      responder: (req: { systemPrompt?: string }) => {
        if (running && (req.systemPrompt ?? "").toLowerCase().includes("handoff")) {
          throw new Error("provider exploded during summarization");
        }
        return { text: "ok, done." };
      },
    });
    await h.host.use("handoff", handoff);
    await h.agent.run("Fix the login bug");

    running = true;
    await runHandoff(h);

    const files = readdirSync(s.handoffsDir);
    assert.equal(files.length, 1, "a file is written even when the sub-call throws");
    const content = readFileSync(join(s.handoffsDir, files[0]!), "utf8");
    for (const header of SECTIONS.slice(0, 9)) {
      assert.ok(new RegExp(header).test(content), `fallback file contains "${header}"`);
    }
    assert.match(content, /## Reactivation/);
    // Positively pin that the deterministic fallback digest — not a stale model
    // write — produced the file: only renderFallback emits this distinctive text.
    assert.ok(
      content.includes("provider-free digest"),
      "the fail-open path wrote the provider-free digest, not a model summary",
    );
  } finally {
    __setNow();
    s.cleanup();
  }
});

test("AC-9: two /handoff invocations in the same day do not clobber (collision suffix)", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    const h = makeHarness({ responder: summarizingResponder() });
    await h.host.use("handoff", handoff);
    await h.agent.run("Fix the login bug");

    await runHandoff(h);
    await runHandoff(h);

    const files = readdirSync(s.handoffsDir).sort();
    assert.equal(files.length, 2, "two snapshots produce two files");
    assert.notEqual(files[0], files[1], "the two filenames differ");
    assert.ok(
      files.some((f) => /-2\.md$/.test(f)),
      "the second write gets a monotonic -2 suffix",
    );
  } finally {
    __setNow();
    s.cleanup();
  }
});

// -- T5 live: the auto-trigger posture ---------------------------------------

test("AC-5: the auto-trigger fires on agent_end when enabled", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    const h = makeHarness({ responder: summarizingResponder() });
    await h.host.use("handoff", handoff);
    // Enable the auto-trigger.
    await runHandoff(h, "on");

    await h.agent.run("Fix the login bug");

    assert.ok(existsSync(s.handoffsDir), "handoffs dir exists after an enabled run");
    assert.ok(readdirSync(s.handoffsDir).length >= 1, "the auto-trigger wrote a handoff");
  } finally {
    __setNow();
    s.cleanup();
  }
});

test("AC-6: off by default — an unconfigured session writes nothing", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    const h = makeHarness({ responder: summarizingResponder() });
    await h.host.use("handoff", handoff); // no enable

    await h.agent.run("Fix the login bug");

    assert.ok(
      !existsSync(s.handoffsDir) || readdirSync(s.handoffsDir).length === 0,
      "no handoff written when off by default",
    );
  } finally {
    __setNow();
    s.cleanup();
  }
});

test("AC-7: EAGENT_HANDOFF=off hard-disables the auto-trigger even when enabled", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  const prev = process.env.EAGENT_HANDOFF;
  process.env.EAGENT_HANDOFF = "off";
  try {
    const h = makeHarness({ responder: summarizingResponder() });
    await h.host.use("handoff", handoff);
    await runHandoff(h, "on"); // enable explicitly...

    await h.agent.run("Fix the login bug"); // ...but the kill switch wins

    assert.ok(
      !existsSync(s.handoffsDir) || readdirSync(s.handoffsDir).length === 0,
      "the kill switch suppresses the auto-trigger",
    );
  } finally {
    if (prev === undefined) delete process.env.EAGENT_HANDOFF;
    else process.env.EAGENT_HANDOFF = prev;
    __setNow();
    s.cleanup();
  }
});

test("recursion-safety: an enabled auto-run produces exactly one file", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    const h = makeHarness({ responder: summarizingResponder() });
    await h.host.use("handoff", handoff);
    await runHandoff(h, "on");

    await h.agent.run("Fix the login bug");

    // The summarization sub-call must not re-enter the agent_end observer.
    assert.equal(readdirSync(s.handoffsDir).length, 1, "exactly one file, no recursion");
  } finally {
    __setNow();
    s.cleanup();
  }
});

test("AC-10: clean dispose — after unload the auto-trigger writes nothing", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    const h = makeHarness({ responder: summarizingResponder() });
    await h.host.use("handoff", handoff);
    await runHandoff(h, "on");

    await h.host.unload("handoff"); // dispose must not throw

    const before = existsSync(s.handoffsDir) ? readdirSync(s.handoffsDir).length : 0;
    await h.agent.run("Fix the login bug");
    const after = existsSync(s.handoffsDir) ? readdirSync(s.handoffsDir).length : 0;

    assert.equal(after, before, "no new handoff after unload");
  } finally {
    __setNow();
    s.cleanup();
  }
});

// ===========================================================================
// B3: resume injection (the READ side) — gating + once-only + format
// ===========================================================================

// -- RB1 unit: the pure relevance + freshness + format helpers ---------------

test("salientTokens lowercases, splits on non-alphanumerics, drops short words + stopwords", () => {
  const toks = salientTokens("Fix the Login-bug in AUTH!!");
  // "the" is a stopword, "in" is < 3 chars — both dropped; the rest kept lowercased.
  assert.ok(toks.has("fix"));
  assert.ok(toks.has("login"));
  assert.ok(toks.has("bug"));
  assert.ok(toks.has("auth"));
  assert.ok(!toks.has("the"), "stopword dropped");
  assert.ok(!toks.has("in"), "short token dropped");
});

test("goalText extracts the ## Goal section body, else the first non-empty line", () => {
  const withGoal = "## Goal\nFix the login bug in auth\n## Completed\n- read code\n";
  assert.equal(goalText(withGoal), "Fix the login bug in auth");
  // No ## Goal header → first non-empty line.
  assert.equal(goalText("\n\nResume the payment refactor\nmore text"), "Resume the payment refactor");
  assert.equal(goalText(""), "");
});

test("isRelevant: slug-substring match fires (rule a)", () => {
  // The candidate slug is a substring of the user message's slug.
  assert.ok(isRelevant("Fix the login bug in auth now", "login-bug", "anything here"));
});

test("isRelevant: salient-token overlap >= 2 fires (rule b)", () => {
  // No slug containment, but two salient tokens overlap (login, auth).
  assert.ok(isRelevant("debug the auth login flow", "session", "## Goal login auth refactor"));
});

test("isRelevant: a single shared token is NOT enough (conservative)", () => {
  assert.ok(!isRelevant("write the database migration", "session", "## Goal login auth refactor"));
});

test("isRelevant: the fallback 'session' slug never matches everything via rule (a)", () => {
  // Both slugs degenerate to 'session'/empty — rule (a) must not fire on that;
  // and with no token overlap, rule (b) must not fire either.
  assert.ok(!isRelevant("   ", "session", ""));
});

test("capBody truncates an oversized body with a marker and leaves a small one intact", () => {
  const small = "tiny body";
  assert.deepEqual(capBody(small, 1000), { text: small, truncated: false });

  const big = "X".repeat(5000);
  const capped = capBody(big, 100);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.text.replace(/\n… \[resume-context truncated\]$/, ""), "utf8") <= 100);
  assert.match(capped.text, /\[resume-context truncated\]$/);
});

test("resumeMessage fences the body as a system message with the standing data-not-instructions note", () => {
  const cand: ResumeCandidate = {
    file: "2026-06-22-fix-login.md",
    path: "/x/2026-06-22-fix-login.md",
    when: Date.UTC(2026, 5, 22),
    body: "## Goal\nFix login\n## Next steps\n1. test",
  };
  const msg = resumeMessage(cand, 4096);
  assert.equal(msg.role, "system");
  const t = msg.content.find((b) => b.type === "text");
  assert.ok(t && t.type === "text");
  if (t && t.type === "text") {
    assert.ok(t.text.includes(RESUME_FENCE_OPEN), "carries the <resume-context fence");
    assert.ok(t.text.includes('source="handoff:2026-06-22-fix-login.md"'), "fence names the source file");
    assert.match(t.text, /NOT a fresh\s+instruction/i, "carries the standing note");
    assert.ok(t.text.includes("Fix login"), "carries the handoff body");
  }
  assert.equal((msg.meta as { source?: string }).source, "handoff");
});

// -- RB2 unit: scanHandoffs + selectResume gates -----------------------------

/** Write a handoff `.md` into the scratch handoffs dir; returns the filename. */
function writeCandidate(s: ReturnType<typeof scratch>, file: string, body: string): string {
  mkdirSync(s.handoffsDir, { recursive: true });
  writeFileSync(join(s.handoffsDir, file), body, "utf8");
  return file;
}

test("scanHandoffs enumerates *.md newest-first by filename date, skips non-md, never throws", () => {
  const s = scratch();
  try {
    writeCandidate(s, "2026-06-20-old.md", "## Goal\nold work");
    writeCandidate(s, "2026-06-22-new.md", "## Goal\nnew work");
    writeCandidate(s, "notes.txt", "ignored");
    const found = scanHandoffs(s.handoffsDir);
    assert.equal(found.length, 2, "only the two .md files");
    assert.equal(found[0]!.file, "2026-06-22-new.md", "newest (by date prefix) first");
    assert.equal(found[1]!.file, "2026-06-20-old.md");
    // A missing directory degrades to [] (never throws).
    assert.deepEqual(scanHandoffs(join(s.dir, "nope")), []);
  } finally {
    s.cleanup();
  }
});

test("selectResume: picks the newest FRESH + RELEVANT candidate", () => {
  const s = scratch();
  try {
    writeCandidate(s, "2026-06-22-fix-login-bug.md", "## Goal\nFix the login bug in auth");
    const nowMs = Date.UTC(2026, 5, 22, 10);
    const picked = selectResume(
      scanHandoffs(s.handoffsDir),
      "continue fixing the login bug",
      nowMs,
      DEFAULT_RESUME_MAX_AGE_HOURS,
    );
    assert.ok(picked, "a fresh relevant handoff is selected");
    assert.equal(picked!.file, "2026-06-22-fix-login-bug.md");
  } finally {
    s.cleanup();
  }
});

test("selectResume: a STALE candidate (older than the window) is rejected", () => {
  const s = scratch();
  try {
    writeCandidate(s, "2026-06-20-fix-login-bug.md", "## Goal\nFix the login bug in auth");
    // now is 2 days after the file's date; default window is 24h → stale.
    const nowMs = Date.UTC(2026, 5, 22, 10);
    const picked = selectResume(
      scanHandoffs(s.handoffsDir),
      "continue fixing the login bug",
      nowMs,
      DEFAULT_RESUME_MAX_AGE_HOURS,
    );
    assert.equal(picked, undefined, "a stale handoff is not selected");
  } finally {
    s.cleanup();
  }
});

test("selectResume: a fresh but UNRELATED candidate is rejected", () => {
  const s = scratch();
  try {
    writeCandidate(s, "2026-06-22-payment-refactor.md", "## Goal\nRefactor the payment ledger");
    const nowMs = Date.UTC(2026, 5, 22, 10);
    const picked = selectResume(
      scanHandoffs(s.handoffsDir),
      "fix the login bug in auth",
      nowMs,
      DEFAULT_RESUME_MAX_AGE_HOURS,
    );
    assert.equal(picked, undefined, "an unrelated handoff is not selected");
  } finally {
    s.cleanup();
  }
});

// -- RB3 live: the transformContext injection through the agent loop ----------

/**
 * A responder that captures every `req.messages` the provider saw (so a test can
 * inspect the post-transformContext context) and otherwise serves a normal turn.
 */
function capturingResponder(seen: Message[][]) {
  return (req: CompletionRequest): { text: string } => {
    seen.push(req.messages);
    return { text: "ok, done." };
  };
}

/** Did any captured context carry the fenced resume-context block? */
function sawResume(seen: Message[][]): boolean {
  return seen.some((msgs) =>
    msgs.some((m) =>
      m.content.some((b) => b.type === "text" && b.text.includes(RESUME_FENCE_OPEN)),
    ),
  );
}

test("RB-happy: resume ON + a fresh relevant handoff → the first turn carries <resume-context>", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    writeCandidate(s, "2026-06-22-fix-login-bug.md", "## Goal\nFix the login bug in auth\n## Next steps\n1. test");
    const seen: Message[][] = [];
    const h = makeHarness({ responder: capturingResponder(seen) });
    await h.host.use("handoff", handoff);
    await runHandoff(h, "resume on");

    await h.agent.run("continue fixing the login bug");

    assert.ok(sawResume(seen), "the first turn's context carried the resume-context block");
  } finally {
    __setNow();
    s.cleanup();
  }
});

test("RB-relevance: an UNRELATED fresh handoff is NOT injected", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    writeCandidate(s, "2026-06-22-payment-refactor.md", "## Goal\nRefactor the payment ledger");
    const seen: Message[][] = [];
    const h = makeHarness({ responder: capturingResponder(seen) });
    await h.host.use("handoff", handoff);
    await runHandoff(h, "resume on");

    await h.agent.run("fix the login bug in auth");

    assert.ok(!sawResume(seen), "an unrelated handoff is not injected");
  } finally {
    __setNow();
    s.cleanup();
  }
});

test("RB-freshness: a STALE handoff (older than the window) is NOT injected", async () => {
  const s = scratch();
  // The file is dated 2026-06-20; the clock is 2026-06-22 → 2 days > 24h window.
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    writeCandidate(s, "2026-06-20-fix-login-bug.md", "## Goal\nFix the login bug in auth");
    const seen: Message[][] = [];
    const h = makeHarness({ responder: capturingResponder(seen) });
    await h.host.use("handoff", handoff);
    await runHandoff(h, "resume on");

    await h.agent.run("continue fixing the login bug");

    assert.ok(!sawResume(seen), "a stale handoff is not injected");
  } finally {
    __setNow();
    s.cleanup();
  }
});

test("RB-once: injected on turn 1, NOT re-injected on a later run in the same session", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    writeCandidate(s, "2026-06-22-fix-login-bug.md", "## Goal\nFix the login bug in auth");
    const seen: Message[][] = [];
    const h = makeHarness({ responder: capturingResponder(seen) });
    await h.host.use("handoff", handoff);
    await runHandoff(h, "resume on");

    await h.agent.run("continue fixing the login bug"); // first run → inject
    assert.ok(sawResume(seen), "first run injected");

    // A second run in the SAME session must NOT re-inject. Clear the capture in
    // place (the responder closes over `seen`, so emptying it keeps the alias).
    seen.length = 0;
    await h.agent.run("still on the login bug"); // same session, second run
    assert.ok(!sawResume(seen), "no re-injection on a later run in the same session");
  } finally {
    __setNow();
    s.cleanup();
  }
});

test("RB-server-replay: a server-style clear()+load() of prior history does NOT re-inject", async () => {
  // The HTTP server does agent.clear() then agent.load(history) on EVERY /run
  // and emits agent_start per run. Pin that a second run over reloaded history
  // does NOT re-inject: the injected message never persisted into the snapshot,
  // and both the `injected` latch (session_start fires once per process) and the
  // assistant-already-present guard hold.
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    writeCandidate(s, "2026-06-22-fix-login-bug.md", "## Goal\nFix the login bug in auth");
    const seen: Message[][] = [];
    const h = makeHarness({ responder: capturingResponder(seen) });
    await h.host.use("handoff", handoff);
    await runHandoff(h, "resume on");

    await h.agent.run("continue fixing the login bug"); // first run → inject
    assert.ok(sawResume(seen), "first run injected");

    // Snapshot → clear → reload → run again, exactly as the server replays a session.
    const snapshot = h.agent.messages.map((m) => ({ ...m }));
    assert.ok(
      !snapshot.some((m) => m.content.some((b) => b.type === "text" && b.text.includes(RESUME_FENCE_OPEN))),
      "the injected resume-context never persisted into the saved transcript",
    );
    seen.length = 0;
    h.agent.clear();
    h.agent.load(snapshot);
    await h.agent.run("still on the login bug");
    assert.ok(!sawResume(seen), "no re-injection after a server-style clear()+load()");
  } finally {
    __setNow();
    s.cleanup();
  }
});

test("RB-default-off: resume OFF by default → never injected", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    writeCandidate(s, "2026-06-22-fix-login-bug.md", "## Goal\nFix the login bug in auth");
    const seen: Message[][] = [];
    const h = makeHarness({ responder: capturingResponder(seen) });
    await h.host.use("handoff", handoff); // no `resume on`

    await h.agent.run("continue fixing the login bug");

    assert.ok(!sawResume(seen), "off by default → no injection");
  } finally {
    __setNow();
    s.cleanup();
  }
});

test("RB-killswitch: EAGENT_HANDOFF_RESUME=off → never injected even when resume is on", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  const prev = process.env.EAGENT_HANDOFF_RESUME;
  process.env.EAGENT_HANDOFF_RESUME = "off";
  try {
    writeCandidate(s, "2026-06-22-fix-login-bug.md", "## Goal\nFix the login bug in auth");
    const seen: Message[][] = [];
    const h = makeHarness({ responder: capturingResponder(seen) });
    await h.host.use("handoff", handoff);
    await runHandoff(h, "resume on"); // explicitly enable...

    await h.agent.run("continue fixing the login bug"); // ...but the kill switch wins

    assert.ok(!sawResume(seen), "the kill switch suppresses injection");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_HANDOFF_RESUME;
    else process.env.EAGENT_HANDOFF_RESUME = prev;
    __setNow();
    s.cleanup();
  }
});

test("RB-bytecap: an oversized handoff body is truncated with a marker in the injected block", async () => {
  const s = scratch();
  __setNow(() => new Date("2026-06-22T10:00:00Z"));
  try {
    // A body well over the default 4 KB cap; padded with a salient token so it
    // passes the relevance gate, then far past the cap so truncation is certain.
    const huge = "## Goal\nFix the login bug in auth\n" + "login padding ".repeat(2000);
    assert.ok(Buffer.byteLength(huge, "utf8") > 4 * 1024, "fixture exceeds the default cap");
    writeCandidate(s, "2026-06-22-fix-login-bug.md", huge);
    const seen: Message[][] = [];
    const h = makeHarness({ responder: capturingResponder(seen) });
    await h.host.use("handoff", handoff);
    await runHandoff(h, "resume on");

    await h.agent.run("continue fixing the login bug");

    const block = seen
      .flat()
      .flatMap((m) => m.content)
      .find((b) => b.type === "text" && b.text.includes(RESUME_FENCE_OPEN));
    assert.ok(block && block.type === "text", "the resume block was injected");
    if (block && block.type === "text") {
      assert.match(block.text, /\[resume-context truncated\]/, "the oversized body is truncated");
    }
  } finally {
    __setNow();
    s.cleanup();
  }
});
