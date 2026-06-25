/**
 * Tests for the `teams` extension — multi-agent orchestration: a template-backed
 * lead agent supervising template-backed member agents over a shared board, with
 * a documented pattern playbook the lead selects from.
 *
 * The pure functions (`parseTeam`, `validateTeam`, `scanTeams`, `resolveTeam`,
 * `buildLeadPrompt`, `memberChildRegistry`, `makeBoard`, `PATTERN_PLAYBOOK`) are
 * exercised directly; the extension is driven through the harness for the
 * `run_team` end-to-end runs, the `/team` command, and the registration shape.
 * Team and template files are written to per-test temp dirs pointed at via
 * `EAGENT_TEAMS_DIR` / `EAGENT_TEMPLATES_DIR`; every `process.env` mutation is
 * restored in `finally`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import teams, {
  buildLeadPrompt,
  makeBoard,
  memberChildRegistry,
  parseTeam,
  PATTERN_PLAYBOOK,
  resolveTeam,
  scanTeams,
  validateTeam,
  DELEGATE_CAP,
  MAX_MEMBERS,
  MEMBER_MAX_TURNS,
  type ResolvedTeam,
  type Team,
} from "../src/extensions/teams.js";
import templates, { type ResolvedTemplate, type Template } from "../src/extensions/templates.js";
import type { CommandContext } from "../src/kernel/commands.js";
import { defineTool } from "../src/kernel/define.js";
import type { CompletionRequest, Message, Tool, ToolContext } from "../src/kernel/types.js";
import { lastText, makeHarness } from "./helpers.js";

/** A team/template file with single-line frontmatter and a markdown body. */
function fenced(front: Record<string, string>, body: string): string {
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/** A trivial named tool, for registry-membership assertions. */
function tool(name: string): Tool {
  return defineTool({ name, description: "x", execute: () => ({ content: "" }) });
}

/** A named tool declaring the given capabilities (for the recursion-guard path). */
function capTool(name: string, capabilities: string[]): Tool {
  return defineTool({ name, description: "x", capabilities, execute: () => ({ content: "" }) });
}

/** A resolved template, for catalog-free resolveTeam/buildLeadPrompt assertions. */
function tmpl(name: string, description: string): ResolvedTemplate {
  return { name, description, systemPrompt: `${name.toUpperCase()} PERSONA` };
}

/** A minimal ToolContext for driving a tool's `execute` directly. */
function fakeCtx(): ToolContext {
  return { toolCallId: "t", signal: new AbortController().signal } as unknown as ToolContext;
}

/** Run a registered command, capturing printed lines. */
async function runCommand(
  cmd: { run(ctx: CommandContext): void | Promise<void> },
  agent: CommandContext["agent"],
  args: string,
): Promise<string[]> {
  const lines: string[] = [];
  await cmd.run({ agent, args, print: (l) => lines.push(l) });
  return lines;
}

/** Collect every tool_result block from a transcript. */
function toolResults(messages: readonly Message[]): { content: string; isError?: boolean }[] {
  const out: { content: string; isError?: boolean }[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) if (b.type === "tool_result") out.push({ content: b.content, isError: b.isError });
  }
  return out;
}

/** True if a completion request is the team lead (its prompt carries the playbook). */
function isLead(req: CompletionRequest): boolean {
  return req.systemPrompt.includes("orchestrator") && req.systemPrompt.includes("blackboard");
}

/** Set EAGENT_TEAMS_DIR / EAGENT_TEMPLATES_DIR to fresh temp dirs around a body; restore env after. */
async function withDirs(fn: (env: { teamsDir: string; templatesDir: string }) => Promise<void>): Promise<void> {
  const savedTeams = process.env.EAGENT_TEAMS;
  const savedTeamsDir = process.env.EAGENT_TEAMS_DIR;
  const savedTemplatesDir = process.env.EAGENT_TEMPLATES_DIR;
  const teamsDir = mkdtempSync(join(tmpdir(), "teams-t-"));
  const templatesDir = mkdtempSync(join(tmpdir(), "teams-tmpl-"));
  process.env.EAGENT_TEAMS_DIR = teamsDir;
  process.env.EAGENT_TEMPLATES_DIR = templatesDir;
  try {
    await fn({ teamsDir, templatesDir });
  } finally {
    if (savedTeams === undefined) delete process.env.EAGENT_TEAMS;
    else process.env.EAGENT_TEAMS = savedTeams;
    if (savedTeamsDir === undefined) delete process.env.EAGENT_TEAMS_DIR;
    else process.env.EAGENT_TEAMS_DIR = savedTeamsDir;
    if (savedTemplatesDir === undefined) delete process.env.EAGENT_TEMPLATES_DIR;
    else process.env.EAGENT_TEMPLATES_DIR = savedTemplatesDir;
    rmSync(teamsDir, { recursive: true, force: true });
    rmSync(templatesDir, { recursive: true, force: true });
  }
}

const PATTERN_NAMES = ["orchestrator", "parallel", "sequential", "generator-verifier", "consensus", "blackboard"];

// ---------------------------------------------------------------------------
// T2.1 — parse + validate + scan (AC-1, AC-2)
// ---------------------------------------------------------------------------

test("T2.1 parseTeam: reads frontmatter, comma-splits members, body=mission, no-fence degrades (AC-1)", () => {
  const md = fenced(
    {
      name: "research-team",
      description: "A research team.",
      lead: "coordinator",
      members: "researcher, writer , critic",
      pattern: "orchestrator",
    },
    "Investigate the topic and produce a brief.",
  );
  const t = parseTeam(md, "fallback");
  assert.equal(t.name, "research-team");
  assert.equal(t.description, "A research team.");
  assert.equal(t.lead, "coordinator");
  assert.deepEqual(t.members, ["researcher", "writer", "critic"]);
  assert.equal(t.pattern, "orchestrator");
  assert.equal(t.mission, "Investigate the topic and produce a brief.");

  const noFence = parseTeam("just a prose mission, no fence", "fb");
  assert.equal(noFence.name, "fb");
  assert.equal(noFence.description, "");
  assert.deepEqual(noFence.members, []);
  assert.equal(noFence.mission, "just a prose mission, no fence");
});

test("T2.1 validateTeam: [] for a well-formed team", () => {
  const t: Team = {
    name: "research-team",
    description: "A research team.",
    members: ["researcher", "writer"],
    pattern: "orchestrator",
    mission: "Investigate.",
  };
  assert.deepEqual(validateTeam(t), []);
});

test("T2.1 validateTeam: rejects non-kebab name, angle brackets, unknown pattern, empty members, over-cap roster, unknown key (AC-2)", () => {
  const base: Team = { name: "ok-team", description: "d", members: ["a"], mission: "m" };
  assert.ok(validateTeam({ ...base, name: "Bad_Name" }).length > 0, "non-kebab name");
  assert.ok(validateTeam({ ...base, description: "has <tag>" }).length > 0, "angle bracket in description");
  assert.ok(validateTeam({ ...base, description: "d>" }).length > 0, "trailing > in description");
  assert.ok(validateTeam({ ...base, description: "" }).length > 0, "empty description");
  assert.ok(validateTeam({ ...base, pattern: "nope" }).length > 0, "unknown pattern");
  assert.ok(validateTeam({ ...base, members: [] }).length > 0, "empty members");
  assert.ok(
    validateTeam({ ...base, members: Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => `m${i}`) }).length > 0,
    "roster over MAX_MEMBERS",
  );
  assert.ok(validateTeam({ ...base, bogus: "x" } as Team).length > 0, "unknown key");
});

test("T2.1 scanTeams: valid sorted, invalid excluded, missing dir => [] (AC-2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "teams-scan-"));
  try {
    writeFileSync(join(dir, "b.md"), fenced({ name: "bravo", description: "B.", members: "x" }, "mission-b"));
    writeFileSync(join(dir, "a.md"), fenced({ name: "alpha", description: "A.", members: "y" }, "mission-a"));
    writeFileSync(join(dir, "evil.md"), fenced({ name: "evil", description: "<hidden>", members: "z" }, "mission-e"));
    writeFileSync(join(dir, "junk.md"), fenced({ name: "junk", description: "J.", members: "w", bogus: "x" }, "mission-j"));

    const found = scanTeams(dir);
    assert.deepEqual(
      found.map((t) => t.name),
      ["alpha", "bravo"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.deepEqual(scanTeams(join(tmpdir(), "teams-does-not-exist-xyz")), []);
});

// ---------------------------------------------------------------------------
// T2.2 — resolve (AC-3)
// ---------------------------------------------------------------------------

test("T2.2 resolveTeam: members + lead resolve against real templates; ResolvedTeam shape (AC-3)", () => {
  const templateCatalog: Template[] = [
    { name: "coordinator", description: "Coordinates.", systemPrompt: "COORD" },
    { name: "researcher", description: "Researches.", systemPrompt: "RES" },
    { name: "writer", description: "Writes.", systemPrompt: "WRITE" },
  ];
  const team: Team = {
    name: "research-team",
    description: "R.",
    lead: "coordinator",
    members: ["researcher", "writer"],
    pattern: "orchestrator",
    mission: "Investigate.",
  };
  const r = resolveTeam("research-team", [team], templateCatalog);
  assert.ok(r.ok);
  const rt: ResolvedTeam = r.team;
  assert.equal(rt.name, "research-team");
  assert.equal(rt.mission, "Investigate.");
  assert.equal(rt.pattern, "orchestrator");
  assert.equal(rt.lead.name, "coordinator");
  assert.deepEqual(
    rt.members.map((m) => m.name),
    ["researcher", "writer"],
  );
  assert.equal(rt.members[0]!.template.systemPrompt, "RES");
});

test("T2.2 resolveTeam: omitted lead falls back to a built-in default coordinator; pattern defaults to auto (AC-3)", () => {
  const templateCatalog: Template[] = [{ name: "researcher", description: "Researches.", systemPrompt: "RES" }];
  const team: Team = { name: "t", description: "R.", members: ["researcher"], mission: "Go." };
  const r = resolveTeam(team, [], templateCatalog);
  assert.ok(r.ok);
  assert.equal(r.team.pattern, "auto", "pattern defaults to auto");
  assert.ok(r.team.lead.systemPrompt.length > 0, "a default coordinator prompt is supplied");
});

test("T2.2 resolveTeam: unknown member, unknown lead, and over-cap roster each => typed error naming it (AC-3)", () => {
  const templateCatalog: Template[] = [{ name: "researcher", description: "R.", systemPrompt: "RES" }];

  const unknownMember = resolveTeam(
    { name: "t", description: "d", members: ["researcher", "ghost"], mission: "m" },
    [],
    templateCatalog,
  );
  assert.equal(unknownMember.ok, false);
  assert.ok(!unknownMember.ok && /ghost/.test(unknownMember.error));

  const unknownLead = resolveTeam(
    { name: "t", description: "d", lead: "nolead", members: ["researcher"], mission: "m" },
    [],
    templateCatalog,
  );
  assert.equal(unknownLead.ok, false);
  assert.ok(!unknownLead.ok && /nolead/.test(unknownLead.error));

  const overCap = resolveTeam(
    {
      name: "t",
      description: "d",
      members: Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => `m${i}`),
      mission: "m",
    },
    [],
    templateCatalog,
  );
  assert.equal(overCap.ok, false);
  assert.ok(!overCap.ok && /\d/.test(overCap.error), "error mentions the cap");
});

// ---------------------------------------------------------------------------
// T2.3 — lead prompt + playbook (AC-4, AC-5)
// ---------------------------------------------------------------------------

test("T2.3 PATTERN_PLAYBOOK: names all six patterns each with when-to-use + the selection heuristic (AC-5)", () => {
  for (const p of PATTERN_NAMES) assert.match(PATTERN_PLAYBOOK, new RegExp(p), `playbook names "${p}"`);
  assert.match(PATTERN_PLAYBOOK, /start with orchestrator/);
  assert.match(PATTERN_PLAYBOOK, /speed matters/);
  assert.match(PATTERN_PLAYBOOK, /build on each other/);
});

test("T2.3 buildLeadPrompt: contains mission, roster (name+description), full playbook, task; pinned vs auto directive (AC-4)", () => {
  const rt: ResolvedTeam = {
    name: "research-team",
    mission: "Investigate the topic.",
    pattern: "parallel",
    lead: tmpl("coordinator", "Coordinates."),
    members: [
      { name: "researcher", template: tmpl("researcher", "Finds sources.") },
      { name: "writer", template: tmpl("writer", "Drafts prose.") },
    ],
  };
  const prompt = buildLeadPrompt(rt, "Write a brief on widgets.");
  assert.match(prompt, /Investigate the topic\./, "mission");
  assert.match(prompt, /researcher/, "member name");
  assert.match(prompt, /Finds sources\./, "member description");
  assert.match(prompt, /writer/, "second member name");
  assert.match(prompt, /Drafts prose\./, "second member description");
  assert.match(prompt, /Write a brief on widgets\./, "task");
  for (const p of PATTERN_NAMES) assert.match(prompt, new RegExp(p), `playbook pattern "${p}" present`);
  assert.match(prompt, /Apply the parallel pattern\./, "pinned-pattern directive");

  const autoRt: ResolvedTeam = { ...rt, pattern: "auto" };
  const autoPrompt = buildLeadPrompt(autoRt, "task");
  assert.doesNotMatch(autoPrompt, /Apply the auto pattern\./, "auto does not emit an apply-auto directive");
  assert.match(autoPrompt, /start with orchestrator/, "auto surfaces the selection heuristic");
});

// ---------------------------------------------------------------------------
// T2.4 — memberChildRegistry capability guard (AC-6)
// ---------------------------------------------------------------------------

test("T2.4 memberChildRegistry: excludes every tool whose capabilities intersect SPAWN_CAPS; keeps plain tools + board (AC-6)", () => {
  const board = tool("board");
  const parent = [
    capTool("spawn_agent", ["agent:spawn"]),
    capTool("spawn_template", ["agent:spawn"]),
    capTool("sweep_edit", ["fs:write", "agent:spawn"]),
    capTool("run_workflow", ["workflow:run"]),
    tool("read"),
    capTool("write", ["fs:write"]),
  ];
  const reg = memberChildRegistry(parent, undefined, board);

  assert.equal(reg.has("read"), true, "a plain read survives");
  assert.equal(reg.has("write"), true, "an fs:write-only tool survives (intersection, not subset)");
  assert.equal(reg.has("board"), true, "the board is added");
  assert.equal(reg.has("spawn_agent"), false, "agent:spawn tool excluded");
  assert.equal(reg.has("spawn_template"), false, "agent:spawn tool excluded");
  assert.equal(reg.has("sweep_edit"), false, "a tool with agent:spawn among its caps excluded");
  assert.equal(
    reg.has("run_workflow"),
    false,
    "workflow:run excluded — proving the guard is not keyed on agent:spawn alone",
  );
});

test("T2.4 memberChildRegistry: an allowlist intersects the parent before the capability guard (AC-6)", () => {
  const board = tool("board");
  const parent = [tool("read"), tool("write"), tool("grep"), capTool("spawn_agent", ["agent:spawn"])];
  const reg = memberChildRegistry(parent, ["read", "grep"], board);
  assert.equal(reg.has("read"), true);
  assert.equal(reg.has("grep"), true);
  assert.equal(reg.has("write"), false, "write is off the allowlist");
  assert.equal(reg.has("board"), true, "board added even though not on the allowlist");
});

// ---------------------------------------------------------------------------
// T2.5 — board (AC-7)
// ---------------------------------------------------------------------------

test("T2.5 makeBoard: a post is visible in a later list; entries() reflects the same store (AC-7)", async () => {
  const board = makeBoard();
  const ctx = fakeCtx();

  const posted = await board.tool.execute({ action: "post", note: "first finding", by: "researcher" }, ctx);
  assert.equal(posted.isError, undefined);

  const listed = await board.tool.execute({ action: "list" }, ctx);
  assert.match(listed.content, /first finding/);

  const entries = board.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.note, "first finding");
  assert.equal(entries[0]!.by, "researcher");
});

test("T2.5 makeBoard: two concurrent posts via Promise.all get DISTINCT ids (AC-7)", async () => {
  const board = makeBoard();
  const ctx = fakeCtx();

  const [a, b] = await Promise.all([
    board.tool.execute({ action: "post", note: "A" }, ctx),
    board.tool.execute({ action: "post", note: "B" }, ctx),
  ]);
  assert.equal(a.isError, undefined);
  assert.equal(b.isError, undefined);
  const ids = board.entries().map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "all ids are distinct");
  assert.equal(ids.length, 2);
});

test("T2.5 makeBoard: the entry-count cap is enforced (AC-7)", async () => {
  const board = makeBoard();
  const ctx = fakeCtx();
  let rejected = false;
  for (let i = 0; i < 300; i++) {
    const r = await board.tool.execute({ action: "post", note: `n${i}` }, ctx);
    if (r.isError) {
      rejected = true;
      break;
    }
  }
  assert.equal(rejected, true, "the board rejects posts past its entry-count cap");
});

// ---------------------------------------------------------------------------
// T2.6 — delegate behavior, via run_team (AC-6)
// ---------------------------------------------------------------------------

test("T2.6 delegate: off-roster member errors with the roster; a MockProvider member runs; two delegates dispatch concurrently (AC-6)", async () => {
  await withDirs(async ({ teamsDir, templatesDir }) => {
    writeFileSync(join(templatesDir, "researcher.md"), fenced({ name: "researcher", description: "R." }, "RESEARCHER PERSONA"));
    writeFileSync(join(templatesDir, "writer.md"), fenced({ name: "writer", description: "W." }, "WRITER PERSONA"));
    writeFileSync(
      join(teamsDir, "duo.md"),
      fenced({ name: "duo", description: "S.", members: "researcher, writer", pattern: "orchestrator" }, "Do the task."),
    );

    const h = makeHarness({ fallback: "allow" });
    let leadTurn = 0;
    let parentSpawned = false;
    h.provider.script((req) => {
      if (req.systemPrompt.includes("RESEARCHER PERSONA")) return { text: "researcher-answer" };
      if (req.systemPrompt.includes("WRITER PERSONA")) return { text: "writer-answer" };
      if (isLead(req)) {
        if (leadTurn === 0) {
          leadTurn++;
          // Turn 1: an off-roster delegate (errors) + a valid one, in one batch.
          return {
            toolCalls: [
              { name: "delegate", arguments: { member: "ghost", task: "x" } },
              { name: "delegate", arguments: { member: "researcher", task: "find" } },
            ],
          };
        }
        if (leadTurn === 1) {
          leadTurn++;
          return { toolCalls: [{ name: "delegate", arguments: { member: "writer", task: "draft" } }] };
        }
        return { text: "lead-synthesis" };
      }
      if (!parentSpawned) {
        parentSpawned = true;
        return { toolCalls: [{ name: "run_team", arguments: { team: "duo", task: "investigate" } }] };
      }
      return { text: "parent-done" };
    });
    await h.host.use("templates", templates);
    await h.host.use("teams", teams);

    await h.agent.run("kick off");

    const results = toolResults(h.agent.messages);
    assert.ok(
      results.some((r) => /lead-synthesis/.test(r.content)),
      "run_team returns the lead synthesis",
    );
    assert.equal(lastText(h.agent), "parent-done");
  });
});

// ---------------------------------------------------------------------------
// T2.7 — run_team end-to-end, file + inline (AC-8)
// ---------------------------------------------------------------------------

test("T2.7 run_team file-based: two delegates fan out, both members ran, synthesis returned (AC-8)", async () => {
  await withDirs(async ({ teamsDir, templatesDir }) => {
    writeFileSync(join(templatesDir, "researcher.md"), fenced({ name: "researcher", description: "R." }, "RESEARCHER PERSONA"));
    writeFileSync(join(templatesDir, "writer.md"), fenced({ name: "writer", description: "W." }, "WRITER PERSONA"));
    writeFileSync(
      join(teamsDir, "brief.md"),
      fenced({ name: "brief", description: "Brief team.", members: "researcher, writer", pattern: "parallel" }, "Produce a brief."),
    );

    const ran = new Set<string>();
    const h = makeHarness({ fallback: "allow" });
    let leadDone = false;
    let parentSpawned = false;
    h.provider.script((req) => {
      if (req.systemPrompt.includes("RESEARCHER PERSONA")) {
        ran.add("researcher");
        return { text: "researcher-findings" };
      }
      if (req.systemPrompt.includes("WRITER PERSONA")) {
        ran.add("writer");
        return { text: "writer-draft" };
      }
      if (isLead(req)) {
        if (!leadDone) {
          leadDone = true;
          return {
            toolCalls: [
              { name: "delegate", arguments: { member: "researcher", task: "find" } },
              { name: "delegate", arguments: { member: "writer", task: "draft" } },
            ],
          };
        }
        return { text: "synthesized-brief" };
      }
      if (!parentSpawned) {
        parentSpawned = true;
        return { toolCalls: [{ name: "run_team", arguments: { team: "brief", task: "investigate widgets" } }] };
      }
      return { text: "parent-done" };
    });
    await h.host.use("templates", templates);
    await h.host.use("teams", teams);

    await h.agent.run("kick off");

    assert.deepEqual([...ran].sort(), ["researcher", "writer"], "both members ran");
    const results = toolResults(h.agent.messages);
    assert.ok(results.some((r) => /synthesized-brief/.test(r.content)), "run_team returns the synthesis");
  });
});

test("T2.7 run_team inline roster: { members, task } runs without a team file (AC-8)", async () => {
  await withDirs(async ({ templatesDir }) => {
    writeFileSync(join(templatesDir, "researcher.md"), fenced({ name: "researcher", description: "R." }, "RESEARCHER PERSONA"));

    const ran = new Set<string>();
    const h = makeHarness({ fallback: "allow" });
    let leadDone = false;
    let parentSpawned = false;
    h.provider.script((req) => {
      if (req.systemPrompt.includes("RESEARCHER PERSONA")) {
        ran.add("researcher");
        return { text: "researcher-findings" };
      }
      if (isLead(req)) {
        if (!leadDone) {
          leadDone = true;
          return { toolCalls: [{ name: "delegate", arguments: { member: "researcher", task: "find" } }] };
        }
        return { text: "inline-synthesis" };
      }
      if (!parentSpawned) {
        parentSpawned = true;
        return {
          toolCalls: [
            {
              name: "run_team",
              arguments: { roster: { members: ["researcher"], pattern: "orchestrator", mission: "Investigate." }, task: "go" },
            },
          ],
        };
      }
      return { text: "parent-done" };
    });
    await h.host.use("templates", templates);
    await h.host.use("teams", teams);

    await h.agent.run("kick off");

    assert.ok(ran.has("researcher"), "the inline-roster member ran");
    const results = toolResults(h.agent.messages);
    assert.ok(results.some((r) => /inline-synthesis/.test(r.content)), "inline run returns the synthesis");
  });
});

// ---------------------------------------------------------------------------
// T2.8 — bounds + kill switch (AC-9)
// ---------------------------------------------------------------------------

test("T2.8 delegate counter rejects the (cap+1)-th call (AC-9)", async () => {
  await withDirs(async ({ teamsDir, templatesDir }) => {
    writeFileSync(join(templatesDir, "worker.md"), fenced({ name: "worker", description: "W." }, "WORKER PERSONA"));
    writeFileSync(
      join(teamsDir, "swarm.md"),
      fenced({ name: "swarm", description: "S.", members: "worker", pattern: "parallel" }, "Work."),
    );

    // A delegation past the cap errors BEFORE the member child runs, so counting
    // member runs proves the cap: only DELEGATE_CAP of DELEGATE_CAP+5 spawn a member.
    let workerRuns = 0;
    const h = makeHarness({ fallback: "allow" });
    let leadTurn = 0;
    let parentSpawned = false;
    h.provider.script((req) => {
      if (req.systemPrompt.includes("WORKER PERSONA")) {
        workerRuns++;
        return { text: "worker-answer" };
      }
      if (isLead(req)) {
        // First turn: emit DELEGATE_CAP+5 delegate calls in ONE batch.
        if (leadTurn === 0) {
          leadTurn++;
          return {
            toolCalls: Array.from({ length: DELEGATE_CAP + 5 }, (_, i) => ({
              name: "delegate",
              arguments: { member: "worker", task: `t${i}` },
            })),
          };
        }
        return { text: "lead-synthesis" };
      }
      if (!parentSpawned) {
        parentSpawned = true;
        return { toolCalls: [{ name: "run_team", arguments: { team: "swarm", task: "go" } }] };
      }
      return { text: "parent-done" };
    });
    await h.host.use("templates", templates);
    await h.host.use("teams", teams);

    await h.agent.run("kick off");

    assert.equal(workerRuns, DELEGATE_CAP, "only DELEGATE_CAP delegations spawn a member; the rest are rejected");
  });
});

test("T2.8 a high-maxTurns member template is built capped to MEMBER_MAX_TURNS (AC-9)", async () => {
  await withDirs(async ({ templatesDir }) => {
    writeFileSync(
      join(templatesDir, "worker.md"),
      fenced({ name: "worker", description: "W.", maxTurns: "99" }, "WORKER PERSONA"),
    );

    // The member child runs as many turns as it requests, but is hard-capped at
    // MEMBER_MAX_TURNS. A member that calls a tool every turn (and never stops)
    // therefore halts at exactly MEMBER_MAX_TURNS provider calls.
    let workerCalls = 0;
    const h = makeHarness({ fallback: "allow" });
    let leadDone = false;
    let parentSpawned = false;
    h.provider.script((req) => {
      if (req.systemPrompt.includes("WORKER PERSONA")) {
        workerCalls++;
        // Always ask for a (nonexistent) tool so the child never ends its turn on
        // its own — it only stops when the maxTurns ceiling is hit.
        return { toolCalls: [{ name: "noop_tool", arguments: {} }] };
      }
      if (isLead(req)) {
        if (!leadDone) {
          leadDone = true;
          return { toolCalls: [{ name: "delegate", arguments: { member: "worker", task: "loop" } }] };
        }
        return { text: "lead-synthesis" };
      }
      if (!parentSpawned) {
        parentSpawned = true;
        return {
          toolCalls: [
            { name: "run_team", arguments: { roster: { members: ["worker"], mission: "Loop." }, task: "go" } },
          ],
        };
      }
      return { text: "parent-done" };
    });
    await h.host.use("templates", templates);
    await h.host.use("teams", teams);

    await h.agent.run("kick off");
    // The worker would loop forever absent the ceiling; it stops at MEMBER_MAX_TURNS.
    assert.equal(workerCalls, MEMBER_MAX_TURNS, "the member child is bounded by MEMBER_MAX_TURNS");
  });
});

test("T2.8 EAGENT_TEAMS=off: run_team fails and /team run refuses (AC-9)", async () => {
  await withDirs(async ({ teamsDir, templatesDir }) => {
    writeFileSync(join(templatesDir, "researcher.md"), fenced({ name: "researcher", description: "R." }, "RESEARCHER PERSONA"));
    writeFileSync(join(teamsDir, "solo.md"), fenced({ name: "solo", description: "S.", members: "researcher" }, "Go."));
    process.env.EAGENT_TEAMS = "off";

    const h = makeHarness({ fallback: "allow" });
    let parentSpawned = false;
    h.provider.script((req) => {
      if (!parentSpawned) {
        parentSpawned = true;
        return { toolCalls: [{ name: "run_team", arguments: { team: "solo", task: "go" } }] };
      }
      return { text: "parent-done" };
    });
    await h.host.use("templates", templates);
    await h.host.use("teams", teams);

    await h.agent.run("kick off");
    const result = toolResults(h.agent.messages)[0]!;
    assert.equal(result.isError, true);
    assert.match(result.content, /disabled/i);

    const cmd = h.commands.get("team")!;
    const lines = await runCommand(cmd, h.agent, "run solo go");
    assert.match(lines.join("\n"), /disabled/i);
  });
});

// ---------------------------------------------------------------------------
// T2.9 — registration + command surface (AC-10)
// ---------------------------------------------------------------------------

test("T2.9 registration: one tool (run_team), /team + /teams; list/show/run print (AC-10)", async () => {
  await withDirs(async ({ teamsDir, templatesDir }) => {
    writeFileSync(join(templatesDir, "researcher.md"), fenced({ name: "researcher", description: "R." }, "RESEARCHER PERSONA"));
    writeFileSync(join(templatesDir, "writer.md"), fenced({ name: "writer", description: "W." }, "WRITER PERSONA"));
    writeFileSync(
      join(teamsDir, "brief.md"),
      fenced({ name: "brief", description: "Brief team.", members: "researcher, writer", pattern: "parallel" }, "Produce a brief."),
    );

    const h = makeHarness({ fallback: "allow" });
    const toolsBefore = h.agent.tools.list().length;
    const commandsBefore = h.commands.list().length;

    await h.host.use("templates", templates);
    const afterTemplatesTools = h.agent.tools.list().length;
    const afterTemplatesCommands = h.commands.list().length;

    await h.host.use("teams", teams);

    assert.equal(h.agent.tools.list().length, afterTemplatesTools + 1, "teams adds exactly one tool");
    assert.ok(h.agent.tools.get("run_team"), "run_team is registered");
    assert.equal(h.commands.list().length, afterTemplatesCommands + 2, "/team + /teams alias");
    assert.ok(h.commands.get("team"));
    assert.ok(h.commands.get("teams"));
    void toolsBefore;
    void commandsBefore;

    // /team list prints the team names.
    const listed = (await runCommand(h.commands.get("teams")!, h.agent, "")).join("\n");
    assert.match(listed, /brief/);

    // /team show <name> prints the resolved roster + pattern.
    const shown = (await runCommand(h.commands.get("team")!, h.agent, "show brief")).join("\n");
    assert.match(shown, /researcher/);
    assert.match(shown, /writer/);
    assert.match(shown, /parallel/);

    // /team run <name> <task> runs and prints the result.
    let leadDone = false;
    h.provider.script((req) => {
      if (req.systemPrompt.includes("RESEARCHER PERSONA")) return { text: "researcher-findings" };
      if (req.systemPrompt.includes("WRITER PERSONA")) return { text: "writer-draft" };
      if (isLead(req)) {
        if (!leadDone) {
          leadDone = true;
          return {
            toolCalls: [
              { name: "delegate", arguments: { member: "researcher", task: "find" } },
              { name: "delegate", arguments: { member: "writer", task: "draft" } },
            ],
          };
        }
        return { text: "command-synthesis" };
      }
      return { text: "" };
    });
    const ranLines = (await runCommand(h.commands.get("team")!, h.agent, "run brief produce a brief")).join("\n");
    assert.match(ranLines, /command-synthesis/, "/team run prints the team's result");
  });
});
