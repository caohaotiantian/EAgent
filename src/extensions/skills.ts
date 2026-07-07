/**
 * Skills — the LLM-authored capability layer (Voyager's skill library meets
 * Anthropic's SKILL.md standard).
 *
 * A skill is a folder with a `SKILL.md`: YAML frontmatter (`name`,
 * `description`) plus markdown instructions, optionally referencing scripts the
 * agent runs through the ordinary `bash` tool. Disclosure is progressive:
 *
 *   tier 1  discovery  — only name+description, injected each turn (cheap)
 *   tier 2  activation — full SKILL.md, loaded on demand via `skill_read`
 *   tier 3  execution  — referenced scripts, run via existing tools
 *
 * Authoring (`skill_create`) is gated behind the `skill:write` capability,
 * because this is the agent extending itself — exactly where ambient authority
 * would be dangerous.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { Config } from "../kernel/store.js";
import type { Message } from "../kernel/types.js";

interface SkillMeta {
  name: string;
  description: string;
  dir: string;
}

export function skillsRoot(config: Config): string {
  return config.string("skills.dir") ?? join(homedir(), ".eagent", "skills");
}

export default function activate(e: ExtensionAPI): void {
  e.grantCapability("skill:read");
  // skill:write is deliberately left to ask/grant by the host policy.

  const catalog = (): SkillMeta[] => scanSkills(skillsRoot(e.config));

  // Tier 1: inject the catalog (name + description only) before each LLM call.
  e.hook("transformContext", (messages) => {
    const skills = catalog();
    if (skills.length === 0) return messages;
    const lines = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    const note: Message = {
      role: "system",
      content: [
        {
          type: "text",
          text:
            `Available skills (call \`skill_read\` to load full instructions before using one):\n${lines}`,
        },
      ],
      meta: { ephemeral: true, source: "skills" },
    };
    return [note, ...messages];
  });

  // Tier 2: load a skill's full instructions on demand.
  e.registerTool(
    defineTool({
      name: "skill_read",
      description: "Load the full instructions for a named skill before using it.",
      capabilities: ["skill:read"],
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name." } },
        required: ["name"],
      },
      execute: (args) => {
        const name = String(args.name);
        const match = catalog().find((s) => s.name === name);
        if (!match) return fail(`No skill named "${name}". Use the skills command to list them.`);
        try {
          return ok(readFileSync(join(match.dir, "SKILL.md"), "utf8"), { skill: name });
        } catch (err) {
          return fail(`Cannot read skill "${name}": ${(err as Error).message}`);
        }
      },
    }),
  );

  // Self-extension: the agent authors a new skill. Gated by skill:write.
  e.registerTool(
    defineTool({
      name: "skill_create",
      description:
        "Create or update a reusable skill (a SKILL.md folder). Use for procedures worth remembering across sessions.",
      capabilities: ["skill:write"],
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short kebab-case skill name." },
          description: { type: "string", description: "One sentence: when to use this skill." },
          instructions: { type: "string", description: "Markdown instructions the future agent will follow." },
        },
        required: ["name", "description", "instructions"],
      },
      execute: (args) => {
        const name = slug(String(args.name));
        if (!name) return fail("Invalid skill name.");
        const description = String(args.description);
        // Reject invalid frontmatter at the authoring boundary, before any write.
        // Removing this one call restores the old accept-anything path.
        const errors = validateFrontmatter({ name, description });
        if (errors.length > 0) return fail(`Invalid skill frontmatter: ${errors.join("; ")}.`);
        const dir = join(skillsRoot(e.config), name);
        const body = renderSkill(name, description, String(args.instructions));
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "SKILL.md"), body);
        } catch (err) {
          return fail(`Cannot write skill: ${(err as Error).message}`);
        }
        e.log.info(`skill "${name}" saved to ${dir}`);
        return ok(`Saved skill "${name}". It will be offered in future turns.`, { dir });
      },
    }),
  );

  e.registerCommand({
    name: "skills",
    description: "List installed skills.",
    run: (ctx) => {
      const skills = catalog();
      ctx.print(
        skills.length
          ? skills.map((s) => `  ${s.name.padEnd(20)} ${s.description}`).join("\n")
          : `(no skills in ${skillsRoot(e.config)})`,
      );
    },
  });
}

// -- SKILL.md helpers -------------------------------------------------------

export function scanSkills(root: string): SkillMeta[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: SkillMeta[] = [];
  for (const name of entries.sort()) {
    const dir = join(root, name);
    try {
      const md = readFileSync(join(dir, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(md);
      out.push({ name: fm.name ?? name, description: fm.description ?? "", dir });
    } catch {
      // not a skill folder; skip
    }
  }
  return out;
}

export function parseFrontmatter(md: string): Record<string, string> {
  if (!md.startsWith("---")) return {};
  const end = md.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = md.slice(3, end);
  const result: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (m) result[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return result;
}

/** The only frontmatter keys EAgent reads; any other key is a smuggle/typo. */
const ALLOWED_FRONTMATTER_KEYS = new Set(["name", "description", "allowed-tools", "triggers"]);

/**
 * Validate a parsed frontmatter record against EAgent's skill rules and return a
 * list of human-readable errors (empty = valid). Pure, dependency-free: a
 * hand-rolled charset/length check, not a YAML schema (house rule: zero deps).
 *
 * - `name`: required, kebab-case `^[a-z0-9]+(-[a-z0-9]+)*$`, length ≤ 64.
 * - `description`: required, non-empty, length ≤ 1024, no `<` or `>` (the
 *   `hidden-tag` injection vector before it ever reaches tier-1).
 * - allowed keys: `name`, `description`, `allowed-tools`, `triggers` — any other
 *   key is reported as unknown.
 */
export function validateFrontmatter(fm: Record<string, string>): string[] {
  const errors: string[] = [];

  const name = fm.name;
  if (name === undefined || name.length === 0) {
    errors.push("name: required");
  } else {
    if (name.length > 64) errors.push("name: too long (max 64 characters)");
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) errors.push("name: must be kebab-case (lowercase a-z, 0-9, hyphens)");
  }

  const description = fm.description;
  if (description === undefined || description.length === 0) {
    errors.push("description: required and non-empty");
  } else {
    if (description.length > 1024) errors.push("description: too long (max 1024 characters)");
    if (/[<>]/.test(description)) errors.push("description: must not contain angle brackets (< or >)");
  }

  for (const key of Object.keys(fm)) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) errors.push(`unknown key: "${key}"`);
  }

  return errors;
}

function renderSkill(name: string, description: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions.trim()}\n`;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
