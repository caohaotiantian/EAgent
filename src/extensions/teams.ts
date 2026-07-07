/**
 * Agent teams — multi-agent orchestration. A **team** composes several
 * template-backed roles into a collaboration on one complex task: an LLM **lead**
 * agent (from a `lead` template, or a built-in default coordinator) supervises
 * template-backed **member** agents it spawns turn-by-turn via a per-run
 * `delegate` tool, and the lead and members share a run-scoped **board** for
 * intermediate task state. The lead selects and applies one of six documented
 * coordination patterns (the `PATTERN_PLAYBOOK`) — orchestrator, parallel,
 * sequential, generator-verifier, consensus, blackboard — optionally pinned via a
 * team's `pattern` field. Patterns are a playbook the lead enacts via the two
 * primitives (`delegate` + `board`) and the loop's native concurrent tool batch,
 * not N coded schedulers.
 *
 * A team is a flat `<name>.md` under the teams directory
 * (`EAGENT_TEAMS_DIR ?? ~/.eagent/teams`) with single-line frontmatter (`name`,
 * `description`, optional `lead`, comma-list `members`, optional `pattern`) and
 * the markdown body as the mission. `run_team` ALSO accepts an inline roster
 * `{ lead?, members, pattern?, mission? }`. Team files are validated at scan time
 * (no authoring boundary): a non-kebab `name`, a `<`/`>` in `description`, an
 * unknown `pattern`, empty/over-cap `members`, or an unknown key is skipped with a
 * warning. The inline roster is model-originated (inside the trust boundary), so
 * its `mission` is not angle-bracket-validated, but its `members` must resolve to
 * known templates and its `pattern` must be a playbook key.
 *
 * Bounds (Decision 4.8): the recursion guard strips every tool whose declared
 * capabilities intersect `SPAWN_CAPS` ({agent:spawn, workflow:run}) from BOTH the
 * member (`memberChildRegistry`) and the lead (`excludeCapabilities: SPAWN_CAPS`),
 * so neither can reach a nested-team / workflow tool — the worst case stays finite
 * "with no grandchildren"; the lead is capped at `LEAD_MAX_TURNS`; a per-run
 * delegate counter (incremented synchronously before any await) rejects past
 * `DELEGATE_CAP`; each member is built with a `MEMBER_MAX_TURNS` ceiling; the
 * roster is capped at `MAX_MEMBERS`; the board has entry- and byte-caps. Kill
 * switch: `EAGENT_TEAMS=off`. Reuses `agent:spawn`; adds no new capability.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Agent } from "../kernel/agent.js";
import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { Config } from "../kernel/store.js";
import { ToolRegistry } from "../kernel/registry.js";
import type { Message, Tool, ToolResult } from "../kernel/types.js";

import {
  buildTemplateChild,
  resolveTemplate,
  scanTemplates,
  templatesRoot,
  type ResolvedTemplate,
  type Template,
} from "./templates.js";

/** A parsed-but-unresolved team. The body is the mission. */
export interface Team {
  name: string;
  description: string;
  lead?: string;
  members: string[];
  pattern?: string;
  mission: string;
}

/** A team with every role mapped to a resolved template. */
export interface ResolvedTeam {
  name: string;
  mission: string;
  pattern: string;
  lead: ResolvedTemplate;
  members: { name: string; template: ResolvedTemplate }[];
}

/** Resolution either succeeds or fails with a human-readable reason (never throws). */
export type ResolveTeamResult = { ok: true; team: ResolvedTeam } | { ok: false; error: string };

/** The valid `pattern` tokens: the six playbook patterns plus `auto`. */
export const PATTERN_KEYS = [
  "auto",
  "orchestrator",
  "parallel",
  "sequential",
  "generator-verifier",
  "consensus",
  "blackboard",
] as const;

/**
 * The fixed coordination-pattern playbook embedded in every lead prompt: each of
 * the six patterns with a one-line when-to-use, plus the selection heuristic the
 * lead applies when no `pattern` is pinned (`auto`).
 */
export const PATTERN_PLAYBOOK = `Coordination patterns (select and apply the one that fits the task):
- orchestrator: you decompose the task, delegate the subtasks, and synthesize the results. The default starting point for most tasks.
- parallel: delegate several independent subtasks at once (one assistant turn, several delegate calls) and merge the results. Use when subtasks are independent and speed matters.
- sequential: run members in order, each consuming the prior member's output and the board. Use when the subtasks must build in order (a pipeline).
- generator-verifier: one member produces a candidate, another critiques it; iterate to a quality bar. Use when quality is critical and an answer benefits from review.
- consensus: several members answer the same question; you take the majority or quorum. Use when quality is critical and independent agreement raises confidence.
- blackboard: members read and write the shared board across rounds until a termination condition. Use when agents must build on each other's findings continuously.

Selection heuristic: start with orchestrator; if subtasks are independent and speed matters, parallel; if they must build in order, sequential; if quality is critical, generator-verifier or consensus; if agents must build on each other's findings continuously, blackboard.`;

/** The spawn-class capability set; a member tool intersecting it is the recursion-guard escape. */
export const SPAWN_CAPS = ["agent:spawn", "workflow:run"] as const;

/** The roster member-count cap (Decision 4.8). */
export const MAX_MEMBERS = 16;
/** The lead agent's `maxTurns` cap. */
export const LEAD_MAX_TURNS = 16;
/** The per-run delegate-call cap. */
export const DELEGATE_CAP = 32;
/** The member child's `maxTurns` ceiling. */
export const MEMBER_MAX_TURNS = 8;

/** The board's entry-count cap. */
const BOARD_MAX_ENTRIES = 200;
/** The per-note byte cap. */
const BOARD_MAX_NOTE_BYTES = 4096;

/** The frontmatter keys a team file may declare; any other key is a smuggle/typo. */
const ALLOWED_KEYS = new Set(["name", "description", "lead", "members", "pattern"]);

/** The teams directory: an env override, else `~/.eagent/teams`. */
export function teamsRoot(config: Config): string {
  return config.string("teams.dir") ?? join(homedir(), ".eagent", "teams");
}

/** Kill switch: the extension is inert when `teams` resolves off (env `EAGENT_TEAMS=off`). */
export function enabled(config: Config): boolean {
  return config.enabled("teams", { default: true });
}

/**
 * Parse a team from markdown using the single-line frontmatter idiom of
 * `templates.parseTemplate` (NOT templates' validator). `members` is comma-split
 * and trimmed; the body after the closing `---` is the mission. A file with no
 * fence degrades to empty frontmatter + the whole string as mission — never
 * throws.
 */
export function parseTeam(md: string, fallbackName: string): Team {
  let front: Record<string, string> = {};
  let body = md;
  if (md.startsWith("---")) {
    const end = md.indexOf("\n---", 3);
    if (end !== -1) {
      front = {};
      for (const line of md.slice(3, end).split("\n")) {
        const m = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line.trim());
        if (m) front[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
      }
      const fenceEnd = md.indexOf("\n", end + 1);
      body = fenceEnd === -1 ? "" : md.slice(fenceEnd + 1);
    }
  }

  const members = (front.members ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const t: Team = {
    name: front.name ?? fallbackName,
    description: front.description ?? "",
    members,
    mission: body,
  };
  if (front.lead !== undefined) t.lead = front.lead;
  if (front.pattern !== undefined) t.pattern = front.pattern;
  // Carry through any unrecognized key verbatim so `validateTeam` can flag it.
  const extras = t as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(front)) {
    if (!ALLOWED_KEYS.has(key)) extras[key] = value;
  }
  return t;
}

/**
 * Validate a parsed team and return a list of human-readable errors (empty =
 * valid). A hand-rolled charset/length check (house rule: zero deps). Rejects a
 * non-kebab `name`, an empty/over-long `description` or one carrying `<`/`>` (the
 * injection vector before it reaches the catalog/lead prompt), a `pattern` not in
 * `PATTERN_KEYS`, an empty roster, a roster over `MAX_MEMBERS`, and any unknown
 * frontmatter key.
 */
export function validateTeam(t: Team): string[] {
  const errors: string[] = [];

  const name = t.name;
  if (name === undefined || name.length === 0) {
    errors.push("name: required");
  } else {
    if (name.length > 64) errors.push("name: too long (max 64 characters)");
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      errors.push("name: must be kebab-case (lowercase a-z, 0-9, hyphens)");
    }
  }

  const description = t.description;
  if (description === undefined || description.length === 0) {
    errors.push("description: required and non-empty");
  } else {
    if (description.length > 1024) errors.push("description: too long (max 1024 characters)");
    if (/[<>]/.test(description)) errors.push("description: must not contain angle brackets (< or >)");
  }

  if (t.pattern !== undefined && !(PATTERN_KEYS as readonly string[]).includes(t.pattern)) {
    errors.push(`pattern: must be one of ${PATTERN_KEYS.join(", ")}`);
  }

  if (t.members.length === 0) {
    errors.push("members: required and non-empty");
  } else if (t.members.length > MAX_MEMBERS) {
    errors.push(`members: too many (max ${MAX_MEMBERS})`);
  }

  for (const key of Object.keys(t)) {
    // `mission` is the synthesized body, not a frontmatter key — always allowed.
    if (key === "mission") continue;
    if (!ALLOWED_KEYS.has(key)) errors.push(`unknown key: "${key}"`);
  }

  return errors;
}

/**
 * Scan a directory for team `*.md` files, parsed, validated, and sorted by name.
 * A file failing `validateTeam` is skipped with a logged warning; a
 * missing/unreadable directory returns `[]`. Never throws.
 */
export function scanTeams(root: string, warn: (msg: string) => void = console.warn): Team[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: Team[] = [];
  for (const file of entries.sort()) {
    if (!file.endsWith(".md")) continue;
    let t: Team;
    try {
      const md = readFileSync(join(root, file), "utf8");
      t = parseTeam(md, file.slice(0, -3));
    } catch {
      continue; // unreadable file; skip
    }
    const errors = validateTeam(t);
    if (errors.length > 0) {
      warn(`teams: skipping invalid team "${file}": ${errors.join("; ")}`);
      continue;
    }
    out.push(t);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A built-in default lead when a team omits `lead`: a generic coordinator persona. */
function defaultCoordinator(): ResolvedTemplate {
  return {
    name: "coordinator",
    description: "Generic team coordinator: decomposes the mission, delegates to members, and synthesizes their results.",
    systemPrompt:
      "You are a team coordinator. Decompose the mission into subtasks, delegate each to the most " +
      "appropriate member via `delegate`, track shared state on the `board`, and synthesize the members' " +
      "results into a single final answer.",
  };
}

/**
 * Resolve a team (by name from `teamCatalog`, or an inline `Team`) into a
 * `ResolvedTeam`: each member name and the `lead` (or a default coordinator) is
 * resolved against `templateCatalog` via `resolveTemplate`. An unknown
 * member/lead, a roster over `MAX_MEMBERS`, or a `pattern` outside `PATTERN_KEYS`
 * returns a typed error naming it. This `pattern` check covers the inline-roster
 * path, which (unlike a file team) is not scan-validated. `pattern` defaults to
 * `auto`.
 */
export function resolveTeam(
  nameOrTeam: string | Team,
  teamCatalog: Team[],
  templateCatalog: Template[],
): ResolveTeamResult {
  let team: Team | undefined;
  if (typeof nameOrTeam === "string") {
    team = teamCatalog.find((t) => t.name === nameOrTeam);
    if (!team) {
      const available = teamCatalog.map((t) => t.name).join(", ") || "(none)";
      return { ok: false, error: `unknown team "${nameOrTeam}". Available teams: ${available}` };
    }
  } else {
    team = nameOrTeam;
  }

  if (team.members.length > MAX_MEMBERS) {
    return { ok: false, error: `team "${team.name}" has too many members (${team.members.length}, max ${MAX_MEMBERS})` };
  }

  if (team.pattern !== undefined && !(PATTERN_KEYS as readonly string[]).includes(team.pattern)) {
    return { ok: false, error: `team "${team.name}": pattern must be one of ${PATTERN_KEYS.join(", ")}` };
  }

  const members: { name: string; template: ResolvedTemplate }[] = [];
  for (const memberName of team.members) {
    const resolved = resolveTemplate(memberName, templateCatalog);
    if (!resolved.ok) {
      return { ok: false, error: `member "${memberName}": ${resolved.error}` };
    }
    members.push({ name: memberName, template: resolved.template });
  }

  let lead: ResolvedTemplate;
  if (team.lead !== undefined) {
    const resolved = resolveTemplate(team.lead, templateCatalog);
    if (!resolved.ok) {
      return { ok: false, error: `lead "${team.lead}": ${resolved.error}` };
    }
    lead = resolved.template;
  } else {
    lead = defaultCoordinator();
  }

  return {
    ok: true,
    team: {
      name: team.name,
      mission: team.mission,
      pattern: team.pattern ?? "auto",
      lead,
      members,
    },
  };
}

/**
 * Build the lead agent's system prompt: the mission, a roster section (each
 * member name + its template description), the full `PATTERN_PLAYBOOK`, the task,
 * and — when `pattern` is concrete — a directive to apply it, else the auto path
 * (the playbook's own selection heuristic guidance).
 */
export function buildLeadPrompt(rt: ResolvedTeam, task: string): string {
  const roster = rt.members.map((m) => `- ${m.name}: ${m.template.description}`).join("\n");
  const directive =
    rt.pattern === "auto"
      ? "No pattern is pinned. Use the selection heuristic above to choose the most appropriate pattern for this task."
      : `Apply the ${rt.pattern} pattern.`;
  return [
    "You are the lead agent of a team. Coordinate the members to accomplish the mission.",
    "",
    `Mission: ${rt.mission}`,
    "",
    "Team roster (delegate to a member by name via `delegate`):",
    roster,
    "",
    "Use the shared `board` tool to record and read intermediate task state.",
    "",
    PATTERN_PLAYBOOK,
    "",
    directive,
    "",
    `Task: ${task}`,
  ].join("\n");
}

/**
 * Build a member child's tool registry (the recursion guard): start from the
 * parent tools intersected with `allowlist` (or all parent tools when no
 * allowlist), EXCLUDE every tool whose declared `capabilities` (the `Tool` field)
 * intersects `SPAWN_CAPS` — so a member can reach no agent-spawning or
 * workflow-running tool — then register the shared `board` tool. Capability-driven
 * (set intersection, not subset, not a name list): a tool is excluded iff ANY of
 * its declared capabilities is in `SPAWN_CAPS`.
 */
export function memberChildRegistry(parentTools: Tool[], allowlist: string[] | undefined, board: Tool): ToolRegistry {
  const registry = new ToolRegistry();
  const spawnCaps = SPAWN_CAPS as readonly string[];
  for (const tool of parentTools) {
    const name = tool.spec.name;
    if (allowlist && !allowlist.includes(name)) continue;
    if (tool.capabilities?.some((c) => spawnCaps.includes(c))) continue;
    registry.register(tool);
  }
  registry.register(board);
  return registry;
}

/** One board entry: a monotonic id, the note text, an optional author and status. */
interface BoardEntry {
  id: number;
  note: string;
  by?: string;
  status?: string;
}

/**
 * Build a run-scoped, in-memory shared board: a `board` tool (actions `post
 * {note, by?}` → a new id, `list`, `update {id, status?, note?}`) plus an
 * `entries()` accessor over the same store. Ops are SYNCHRONOUS — the id counter
 * is read-and-incremented and the entry appended in one non-yielding step (no
 * `await` between), so concurrent posts from a parallel delegate batch cannot
 * interleave and each gets a distinct id. Entry-count and per-note byte caps
 * bound the board. Default (parallel) execution mode.
 */
export function makeBoard(): { tool: Tool; entries(): BoardEntry[] } {
  const store: BoardEntry[] = [];
  let counter = 0;

  const render = (e: BoardEntry): string =>
    `#${e.id}${e.by ? ` [${e.by}]` : ""}${e.status ? ` (${e.status})` : ""}: ${e.note}`;

  const tool = defineTool<{ action?: unknown; note?: unknown; by?: unknown; id?: unknown; status?: unknown }>({
    name: "board",
    description:
      "The team's shared task board. action=post {note, by?} appends a note and returns its id; " +
      "action=list returns all entries; action=update {id, status?, note?} amends an entry. " +
      "Both the lead and every member share this board.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["post", "list", "update"], description: "post | list | update" },
        note: { type: "string", description: "The note text (post/update)." },
        by: { type: "string", description: "Optional author (post)." },
        id: { type: "integer", description: "The entry id to amend (update)." },
        status: { type: "string", description: "Optional status to set (update)." },
      },
      required: ["action"],
    },
    execute: (args): ToolResult => {
      const action = typeof args.action === "string" ? args.action : "";

      if (action === "list") {
        if (store.length === 0) return ok("(board empty)");
        return ok(store.map(render).join("\n"));
      }

      if (action === "post") {
        const note = typeof args.note === "string" ? args.note : "";
        if (note.length === 0) return fail("board post requires a non-empty string `note`.");
        if (Buffer.byteLength(note, "utf8") > BOARD_MAX_NOTE_BYTES) {
          return fail(`board note too large (max ${BOARD_MAX_NOTE_BYTES} bytes).`);
        }
        if (store.length >= BOARD_MAX_ENTRIES) {
          return fail(`board is full (max ${BOARD_MAX_ENTRIES} entries).`);
        }
        // Race-free under a parallel delegate batch: the id is assigned and the
        // entry appended in one non-yielding (no-await) step, so concurrent posts
        // get distinct ids.
        const entry: BoardEntry = { id: ++counter, note };
        if (typeof args.by === "string" && args.by.length > 0) entry.by = args.by;
        store.push(entry);
        return ok(`posted #${entry.id}`, { id: entry.id });
      }

      if (action === "update") {
        const id = typeof args.id === "number" ? args.id : NaN;
        const entry = store.find((e) => e.id === id);
        if (!entry) return fail(`board has no entry #${args.id}.`);
        if (typeof args.note === "string") {
          if (Buffer.byteLength(args.note, "utf8") > BOARD_MAX_NOTE_BYTES) {
            return fail(`board note too large (max ${BOARD_MAX_NOTE_BYTES} bytes).`);
          }
          entry.note = args.note;
        }
        if (typeof args.status === "string") entry.status = args.status;
        return ok(`updated #${entry.id}`);
      }

      return fail(`unknown board action "${action}". Use post | list | update.`);
    },
  });

  return { tool, entries: () => store.slice() };
}

/**
 * Build a run-scoped `delegate` tool: the per-run primitive the lead calls to run
 * a roster member on a subtask. Off-roster names error with the roster listed; a
 * per-run counter (incremented synchronously before any `await`, so it is
 * race-free under a concurrent delegate batch) rejects past `DELEGATE_CAP`. The
 * actual member spawn is delegated to `runMember` (the host wires
 * `buildTemplateChild` + `memberChildRegistry`), keeping this factory free of
 * host plumbing and directly inspectable. Built via `defineTool` with NO
 * `executionMode`, so it is the loop's default (`parallel`) — several delegate
 * calls in one lead turn fan out concurrently (never serialized).
 */
export function makeDelegate(
  members: { name: string }[],
  runMember: (memberName: string, subtask: string) => Promise<string>,
): Tool {
  let delegateCount = 0;
  return defineTool<{ member?: unknown; task?: unknown }>({
    name: "delegate",
    description:
      "Delegate a subtask to a named team member (a roster role). The member runs as a fresh " +
      "isolated child agent on `task` and returns its final answer. Several delegate calls in one " +
      "turn run concurrently. Members cannot themselves spawn or run workflows.",
    parameters: {
      type: "object",
      properties: {
        member: { type: "string", description: "The roster member name to delegate to." },
        task: { type: "string", description: "The subtask for the member." },
      },
      required: ["member", "task"],
    },
    execute: async (args): Promise<ToolResult> => {
      // Synchronous cap check+increment at the top, BEFORE any await, so the
      // counter is race-free under a concurrent delegate batch.
      if (delegateCount >= DELEGATE_CAP) {
        return fail(`delegate cap reached (max ${DELEGATE_CAP} delegations per team run).`);
      }
      delegateCount++;

      const memberName = typeof args.member === "string" ? args.member : "";
      const subtask = typeof args.task === "string" ? args.task : "";
      const member = members.find((m) => m.name === memberName);
      if (!member) {
        const roster = members.map((m) => m.name).join(", ") || "(none)";
        return fail(`unknown member "${memberName}". Team roster: ${roster}.`);
      }

      const text = await runMember(memberName, subtask);
      return ok(text, { member: memberName });
    },
  });
}

/** The last assistant message's text, concatenating all of its text blocks. */
function finalText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    // Concatenate every text block: a model may split its answer across blocks
    // (or emit an empty leading text block before a thinking block), so taking
    // only the first text block can drop the real answer.
    let text = "";
    for (const b of m.content) if (b.type === "text") text += b.text;
    if (text.length > 0) return text;
  }
  return "";
}

export default function activate(e: ExtensionAPI): void {
  e.grantCapability("agent:spawn");

  // The parent fields every child (lead or member) is constructed against.
  const parentFields = (): {
    providers: Agent["providers"];
    ui: Agent["ui"];
    logger: Agent["logger"];
    capabilities: Agent["capabilities"];
    model: string;
    providerName: string | undefined;
    tools: Tool[];
    hooks: Agent["hooks"];
  } => ({
    providers: e.agent.providers,
    ui: e.agent.ui,
    logger: e.agent.logger,
    capabilities: e.agent.capabilities,
    model: e.agent.model,
    providerName: e.agent.providerName,
    tools: e.agent.tools.list(),
    hooks: e.agent.hooks,
  });

  /** Run a resolved team on a task: build the board, the delegate tool, and the lead; run the lead. */
  const runTeam = async (rt: ResolvedTeam, task: string): Promise<ToolResult> => {
    const board = makeBoard();

    // The actual member spawn: a fresh isolated child built via the templates
    // child-builder, capped by `MEMBER_MAX_TURNS`, its registry stripped of every
    // spawn-class tool by `memberChildRegistry` (the recursion guard) and given
    // the shared board. The cap/roster/race logic lives in `makeDelegate`.
    const runMember = async (memberName: string, subtask: string): Promise<string> => {
      const member = rt.members.find((m) => m.name === memberName)!;
      const child = buildTemplateChild(member.template, parentFields(), {
        baseRegistry: memberChildRegistry(e.agent.tools.list(), member.template.tools, board.tool),
        maxTurnsCeiling: e.config.int("teams.member.maxTurns", MEMBER_MAX_TURNS),
      });
      const { messages } = await child.run(subtask);
      return finalText(messages);
    };
    const delegateTool = makeDelegate(rt.members, runMember);

    // The lead reuses `buildTemplateChild` but with its own prompt: clone the
    // resolved lead template, swapping in the team-aware system prompt (the
    // helper wires `resolved.systemPrompt` into the child). `excludeCapabilities:
    // SPAWN_CAPS` strips every inherited spawn-class tool (`run_team`,
    // `run_workflow`, `spawn_*`, …) so a lead turn cannot spawn a nested team or
    // workflow — the recursion guard that keeps §4.8's worst case finite ("no
    // grandchildren"). `delegate`/`board` are then re-added via `extraTools`
    // AFTER the exclude filter, so the lead keeps exactly those two primitives.
    const leadTemplate: ResolvedTemplate = { ...rt.lead, systemPrompt: buildLeadPrompt(rt, task) };
    const lead = buildTemplateChild(leadTemplate, parentFields(), {
      excludeCapabilities: [...SPAWN_CAPS],
      extraTools: [board.tool, delegateTool],
      maxTurnsCeiling: e.config.int("teams.lead.maxTurns", LEAD_MAX_TURNS),
    });
    const { messages } = await lead.run(task);
    return ok(finalText(messages), { team: rt.name, pattern: rt.pattern });
  };

  /** Resolve `team` (a name) or `roster` (inline) into a ResolvedTeam, against the live catalogs. */
  const resolve = (teamName: string | undefined, roster: InlineRoster | undefined): ResolveTeamResult => {
    const templateCatalog = scanTemplates(templatesRoot(e.config), (m) => e.log.warn(m));
    if (teamName !== undefined && teamName.length > 0) {
      const teamCatalog = scanTeams(teamsRoot(e.config), (m) => e.log.warn(m));
      return resolveTeam(teamName, teamCatalog, templateCatalog);
    }
    if (roster) {
      const inline: Team = {
        name: "inline",
        description: "inline roster",
        members: roster.members,
        mission: roster.mission ?? "",
      };
      if (roster.lead !== undefined) inline.lead = roster.lead;
      if (roster.pattern !== undefined) inline.pattern = roster.pattern;
      return resolveTeam(inline, [], templateCatalog);
    }
    return { ok: false, error: "run_team requires either a `team` name or an inline `roster`." };
  };

  e.registerTool(
    defineTool<{ team?: unknown; roster?: unknown; task?: unknown }>({
      name: "run_team",
      description:
        "Run a multi-agent team on a task. Pass `team` (a saved team name) OR an inline `roster` " +
        "({ lead?, members, pattern?, mission? }), plus a `task`. An LLM lead agent coordinates " +
        "template-backed member agents over a shared board, selecting a coordination pattern " +
        "(orchestrator, parallel, sequential, generator-verifier, consensus, blackboard). Returns " +
        "the lead's synthesized answer.",
      capabilities: ["agent:spawn"],
      parameters: {
        type: "object",
        properties: {
          team: { type: "string", description: "Name of a saved team to run." },
          roster: {
            type: "object",
            description: "An inline team roster: { lead?, members: string[], pattern?, mission? }.",
          },
          task: { type: "string", description: "The task for the team." },
        },
        required: ["task"],
      },
      execute: async (args): Promise<ToolResult> => {
        if (!enabled(e.config)) return fail("Teams are disabled (EAGENT_TEAMS=off).");
        const task = typeof args.task === "string" ? args.task : "";
        if (task.length === 0) return fail("run_team requires a non-empty string `task`.");
        const teamName = typeof args.team === "string" ? args.team : undefined;
        const roster = parseRoster(args.roster);
        const resolved = resolve(teamName, roster);
        if (!resolved.ok) return fail(resolved.error);
        return runTeam(resolved.team, task);
      },
    }),
  );

  const command = {
    name: "team",
    description: "Manage agent teams: list, show <name>, run <name> <task>.",
    run: async (ctx: { agent: unknown; args: string; print(line: string): void }): Promise<void> => {
      const argv = ctx.args.trim().split(/\s+/).filter((s) => s.length > 0);
      const sub = argv[0] ?? "list";

      const teamCatalog = (): Team[] => scanTeams(teamsRoot(e.config), (m) => e.log.warn(m));

      if (sub === "list") {
        const found = teamCatalog();
        if (found.length === 0) {
          ctx.print(`(no teams in ${teamsRoot(e.config)})`);
          return;
        }
        for (const t of found) ctx.print(`  ${t.name.padEnd(20)} ${t.description}`);
        return;
      }

      if (sub === "show") {
        const name = argv[1];
        if (!name) {
          ctx.print("usage: /team show <name>");
          return;
        }
        const templateCatalog = scanTemplates(templatesRoot(e.config), (m) => e.log.warn(m));
        const resolved = resolveTeam(name, teamCatalog(), templateCatalog);
        if (!resolved.ok) {
          ctx.print(resolved.error);
          return;
        }
        const rt = resolved.team;
        ctx.print(`name:    ${rt.name}`);
        ctx.print(`pattern: ${rt.pattern}`);
        ctx.print(`lead:    ${rt.lead.name}`);
        ctx.print("members:");
        for (const m of rt.members) ctx.print(`  ${m.name.padEnd(20)} ${m.template.description}`);
        ctx.print("---");
        ctx.print(rt.mission);
        return;
      }

      if (sub === "run") {
        if (!enabled(e.config)) {
          ctx.print("Teams are disabled (EAGENT_TEAMS=off).");
          return;
        }
        const name = argv[1];
        const task = argv.slice(2).join(" ");
        if (!name || task.length === 0) {
          ctx.print("usage: /team run <name> <task>");
          return;
        }
        const resolved = resolve(name, undefined);
        if (!resolved.ok) {
          ctx.print(resolved.error);
          return;
        }
        const result = await runTeam(resolved.team, task);
        ctx.print(result.content);
        return;
      }

      ctx.print(`Unknown subcommand "${sub}". Use list | show <name> | run <name> <task>.`);
    },
  };

  e.registerCommand(command);
  e.registerCommand({ ...command, name: "teams" });
}

/** An inline roster as accepted by `run_team`. */
interface InlineRoster {
  lead?: string;
  members: string[];
  pattern?: string;
  mission?: string;
}

/** Coerce an untrusted `roster` argument into an `InlineRoster`, or `undefined`. */
function parseRoster(raw: unknown): InlineRoster | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const members = Array.isArray(r.members) ? r.members.filter((m): m is string => typeof m === "string") : [];
  const roster: InlineRoster = { members };
  if (typeof r.lead === "string") roster.lead = r.lead;
  if (typeof r.pattern === "string") roster.pattern = r.pattern;
  if (typeof r.mission === "string") roster.mission = r.mission;
  return roster;
}
