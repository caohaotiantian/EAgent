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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeHarness } from "./helpers.js";
import handoff, {
  slugify,
  renderFallback,
  ensureSchema,
  HANDOFF_SYSTEM_PROMPT,
  __setNow,
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
