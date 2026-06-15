import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before } from "node:test";

import skills from "../src/extensions/skills.js";
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
