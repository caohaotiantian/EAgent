import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before } from "node:test";

import skills from "../src/extensions/skills.js";
import type { CommandContext } from "../src/kernel/commands.js";
import type { CompletionRequest } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";

const SKILLS_DIR = mkdtempSync(join(tmpdir(), "eagent-skills-"));

before(() => {
  process.env.EAGENT_SKILLS_DIR = SKILLS_DIR;
});

test("the agent can author a skill, which is then offered and readable", async () => {
  const { agent, host } = makeHarness({
    responder: [
      {
        toolCalls: [
          {
            name: "skill_create",
            arguments: {
              name: "Greet Politely",
              description: "Greet a new user warmly.",
              instructions: "Open with a warm hello and ask how you can help.",
            },
          },
        ],
      },
      { text: "Saved." },
    ],
    fallback: "allow",
  });
  await host.use("skills", skills);

  await agent.run("make a greeting skill");

  const file = join(SKILLS_DIR, "greet-politely", "SKILL.md");
  assert.ok(existsSync(file), "SKILL.md should be written with a slugified name");
  const body = readFileSync(file, "utf8");
  assert.match(body, /name: greet-politely/);
  assert.match(body, /description: Greet a new user warmly\./);
  assert.match(body, /warm hello/);
});

test("tier-1 disclosure injects the skill catalog into context", async () => {
  let catalogInjected = false;
  const { agent, host } = makeHarness({
    responder: (req: CompletionRequest) => {
      catalogInjected = req.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.some((b) => b.type === "text" && b.text.includes("greet-politely")),
      );
      return { text: "noted" };
    },
    fallback: "allow",
  });
  await host.use("skills", skills);

  await agent.run("hello");
  assert.ok(catalogInjected, "the previously-created skill should appear in the catalog note");
});

test("authoring is gated by the skill:write capability", async () => {
  const { agent, host } = makeHarness({
    responder: [
      {
        toolCalls: [
          {
            name: "skill_create",
            arguments: { name: "blocked", description: "x", instructions: "y" },
          },
        ],
      },
      { text: "ok" },
    ],
    fallback: "deny", // skill:write is not granted by the extension
  });
  await host.use("skills", skills);

  await agent.run("make a skill");
  assert.equal(existsSync(join(SKILLS_DIR, "blocked", "SKILL.md")), false, "denied capability must prevent the write");
  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.match((toolMsg.content[0] as { content: string }).content, /denied/i);
});

// ---------------------------------------------------------------------------
// Layered home+project resolution (D4; AC1-3, AC4, KDD1)
// ---------------------------------------------------------------------------
//
// Invariant: with no `skills.dir` override, skills resolve from BOTH
// `~/.eagent/skills` (home) and `<cwd>/.eagent/skills` (project), merged by the
// folder/frontmatter `name`, project-wins. An explicit `EAGENT_SKILLS_DIR`
// override reverts to single-source (KDD1). These tests isolate BOTH
// `process.env.HOME` (home tier) and cwd (project tier) to temp dirs so the
// dev's real `~/.eagent/skills` cannot bleed in. The `skill_create` write path
// is UNCHANGED — home is a read layer, so a home-written skill is still
// discovered without any write change.

/** Write a `<root>/<name>/SKILL.md` skill folder with a distinguishing description. */
function writeSkill(root: string, name: string, description: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody for ${name}\n`);
}

/** Run the `skills` command against a harness and return its printed lines joined. */
async function listSkills(h: ReturnType<typeof makeHarness>): Promise<string> {
  const cmd = h.commands.get("skills")!;
  const lines: string[] = [];
  const ctx: CommandContext = { agent: h.agent, args: "", print: (l) => lines.push(l) };
  await cmd.run(ctx);
  return lines.join("\n");
}

test("skills layered: home-only + project-only both list; same folder name => project wins (AC1-3)", async () => {
  const savedHome = process.env.HOME;
  const savedDir = process.env.EAGENT_SKILLS_DIR;
  const savedCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "skills-layered-"));
  const homeSkills = join(root, "home", ".eagent", "skills");
  const projSkills = join(root, "project", ".eagent", "skills");
  mkdirSync(homeSkills, { recursive: true });
  mkdirSync(projSkills, { recursive: true });
  process.env.HOME = join(root, "home"); // homedir() reads $HOME on POSIX
  delete process.env.EAGENT_SKILLS_DIR; // no override => layered default
  process.chdir(join(root, "project"));
  try {
    writeSkill(homeSkills, "home-only", "home-tier-desc");
    writeSkill(projSkills, "proj-only", "project-tier-desc");
    // Same folder `name` in both tiers — the project version must win.
    writeSkill(homeSkills, "shared", "shared-home-version");
    writeSkill(projSkills, "shared", "shared-project-version");

    const h = makeHarness({ fallback: "allow" });
    await h.host.use("skills", skills);
    const listed = await listSkills(h);

    assert.match(listed, /home-tier-desc/, "(a) a home-only skill is listed");
    assert.match(listed, /project-tier-desc/, "(b) a project-only skill is listed");
    assert.match(listed, /shared-project-version/, "(c) the project version wins on a name collision");
    assert.doesNotMatch(listed, /shared-home-version/, "(c) the home version is shadowed by the project one");
  } finally {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDir === undefined) delete process.env.EAGENT_SKILLS_DIR;
    else process.env.EAGENT_SKILLS_DIR = savedDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("skills override: EAGENT_SKILLS_DIR is single-source — home/project tiers are NOT read (AC4/KDD1)", async () => {
  const savedHome = process.env.HOME;
  const savedDir = process.env.EAGENT_SKILLS_DIR;
  const savedCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "skills-override-"));
  const homeSkills = join(root, "home", ".eagent", "skills");
  const projSkills = join(root, "project", ".eagent", "skills");
  const overrideDir = join(root, "override");
  mkdirSync(homeSkills, { recursive: true });
  mkdirSync(projSkills, { recursive: true });
  mkdirSync(overrideDir, { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.EAGENT_SKILLS_DIR = overrideDir; // override => single-source
  process.chdir(join(root, "project"));
  try {
    writeSkill(overrideDir, "only", "override-tier-desc");
    writeSkill(homeSkills, "home-only", "home-tier-desc");
    writeSkill(projSkills, "proj-only", "project-tier-desc");

    const h = makeHarness({ fallback: "allow" });
    await h.host.use("skills", skills);
    const listed = await listSkills(h);

    assert.match(listed, /override-tier-desc/, "the override dir is read");
    assert.doesNotMatch(listed, /home-tier-desc/, "the home tier is NOT read under an override");
    assert.doesNotMatch(listed, /project-tier-desc/, "the project tier is NOT read under an override");
  } finally {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDir === undefined) delete process.env.EAGENT_SKILLS_DIR;
    else process.env.EAGENT_SKILLS_DIR = savedDir;
    rmSync(root, { recursive: true, force: true });
  }
});
