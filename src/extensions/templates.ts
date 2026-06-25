/**
 * Agent templates — named, file-based, reusable specifications of a specialized
 * agent (a system prompt plus a tool allow-list, capability scope, and model/run
 * settings) that can **inherit** from another template and be **applied** two
 * ways:
 *
 *   - delegate — `spawn_template` builds a fresh isolated child agent from the
 *     resolved template (its own scoped capabilities and a filtered tool registry
 *     that strips BOTH spawn tools, so a child cannot re-spawn). A genuine
 *     sandbox when the template declares `capabilities`.
 *   - become — `/template use <name>` reconfigures the *live* session agent's
 *     public fields (systemPrompt/model/thinking/maxTurns) and arms a tool
 *     allow-list veto. It does NOT swap the provider, and it does NOT narrow
 *     capabilities (the live manager is additive) — allow-listed tools that
 *     survive keep full session authority. `/template reset` restores pristine.
 *
 * A template is a flat `<name>.md` under the templates directory
 * (`EAGENT_TEMPLATES_DIR ?? ~/.eagent/templates`), with single-line frontmatter
 * (the `skills` idiom) and the markdown body as the system prompt. Frontmatter is
 * validated at scan time (no authoring boundary exists): a file with a non-kebab
 * `name`, a `<`/`>` in its `description` (the injection vector), a bad
 * `thinking`/`maxTurns`, or an unknown key is skipped with a warning.
 *
 * The catalog is opt-in (default off): `/template catalog on` makes a
 * `transformContext` hook inject one ephemeral name+description note per turn for
 * autonomous discovery; off, a switched-on model still self-discovers via
 * `spawn_template`'s unknown-name error. Kill switch: `EAGENT_TEMPLATES=off`.
 * Reuses `agent:spawn`; adds no new capability.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Agent } from "../kernel/agent.js";
import type { CapabilityManager } from "../kernel/capabilities.js";
import { defineTool, fail, ok } from "../kernel/define.js";
import type { ToolDecision } from "../kernel/events.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { ProviderRegistry, ToolRegistry } from "../kernel/registry.js";
import type { Logger, Message, ThinkingLevel, Tool, UI } from "../kernel/types.js";

import { scopedCapabilities } from "./subagents.js";

/** A parsed-but-unresolved template. The body is the system prompt. */
export interface Template {
  name: string;
  description: string;
  extends?: string;
  model?: string;
  provider?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  tools?: string[];
  capabilities?: string[];
  systemPrompt: string;
}

/** A template with its `extends` chain resolved away. */
export type ResolvedTemplate = Omit<Template, "extends">;

/** Resolution either succeeds or fails with a human-readable reason (never throws). */
export type ResolveResult =
  | { ok: true; template: ResolvedTemplate }
  | { ok: false; error: string };

/** The two spawn-tool names a delegated child must never inherit (recursion guard). */
const SPAWN_TOOLS = new Set(["spawn_agent", "spawn_template"]);

/** The valid `ThinkingLevel` tokens, for scan-time validation. */
const THINKING_TOKENS: readonly string[] = ["off", "low", "medium", "high"];

/** The frontmatter keys a template may declare; any other key is a smuggle/typo. */
const ALLOWED_KEYS = new Set([
  "name",
  "description",
  "extends",
  "model",
  "provider",
  "thinking",
  "maxTurns",
  "tools",
  "capabilities",
]);

/** The templates directory: an env override, else `~/.eagent/templates`. */
export function templatesRoot(): string {
  return process.env.EAGENT_TEMPLATES_DIR ?? join(homedir(), ".eagent", "templates");
}

/** Kill switch: the extension is inert when `EAGENT_TEMPLATES=off`. */
export function enabled(): boolean {
  return process.env.EAGENT_TEMPLATES !== "off";
}

/**
 * Parse a template from markdown using the single-line frontmatter idiom of
 * `skills.ts` (NOT skills' `validateFrontmatter`, whose key set rejects every
 * template field). `tools`/`capabilities` are comma-split and trimmed; `maxTurns`
 * is coerced to a number; `thinking` is carried verbatim. The body after the
 * closing `---` is the system prompt. A file with no fence degrades to empty
 * frontmatter + the whole string as body — never throws.
 */
export function parseTemplate(md: string, fallbackName: string): Template {
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

  const list = (raw: string | undefined): string[] | undefined => {
    if (raw === undefined) return undefined;
    const items = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return items.length > 0 ? items : undefined;
  };

  const t: Template = {
    name: front.name ?? fallbackName,
    description: front.description ?? "",
    systemPrompt: body,
  };
  if (front.extends !== undefined) t.extends = front.extends;
  if (front.model !== undefined) t.model = front.model;
  if (front.provider !== undefined) t.provider = front.provider;
  if (front.thinking !== undefined) t.thinking = front.thinking as ThinkingLevel;
  if (front.maxTurns !== undefined) t.maxTurns = Number(front.maxTurns);
  const tools = list(front.tools);
  if (tools) t.tools = tools;
  const caps = list(front.capabilities);
  if (caps) t.capabilities = caps;
  // Carry through any unrecognized frontmatter key verbatim so scan-time
  // `validateTemplate` can flag it as unknown (a smuggle/typo) rather than
  // silently dropping it.
  const extras = t as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(front)) {
    if (!ALLOWED_KEYS.has(key)) extras[key] = value;
  }
  return t;
}

/**
 * Validate a parsed template and return a list of human-readable errors (empty =
 * valid). A hand-rolled charset/length check (house rule: zero deps). Rejects a
 * non-kebab `name`, an empty/over-long `description` or one carrying `<`/`>` (the
 * hidden-tag injection vector before it reaches the catalog), a `thinking`
 * outside the four tokens, a non-positive-integer `maxTurns`, and any unknown
 * frontmatter key.
 */
export function validateTemplate(t: Template): string[] {
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

  if (t.thinking !== undefined && !THINKING_TOKENS.includes(t.thinking)) {
    errors.push("thinking: must be one of off, low, medium, high");
  }

  if (t.maxTurns !== undefined && (!Number.isInteger(t.maxTurns) || t.maxTurns <= 0)) {
    errors.push("maxTurns: must be a positive integer");
  }

  for (const key of Object.keys(t)) {
    // `systemPrompt` is the synthesized body, not a frontmatter key — always allowed.
    if (key === "systemPrompt") continue;
    if (!ALLOWED_KEYS.has(key)) errors.push(`unknown key: "${key}"`);
  }

  return errors;
}

/**
 * Scan a directory for template `*.md` files, parsed, validated, and sorted by
 * name. A file failing `validateTemplate` is skipped with a logged warning (the
 * `scanSkills` try/catch-skip discipline); a missing/unreadable directory returns
 * `[]`. Never throws.
 */
export function scanTemplates(root: string, warn: (msg: string) => void = console.warn): Template[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: Template[] = [];
  for (const file of entries.sort()) {
    if (!file.endsWith(".md")) continue;
    let t: Template;
    try {
      const md = readFileSync(join(root, file), "utf8");
      t = parseTemplate(md, file.slice(0, -3));
    } catch {
      continue; // unreadable file; skip
    }
    const errors = validateTemplate(t);
    if (errors.length > 0) {
      warn(`templates: skipping invalid template "${file}": ${errors.join("; ")}`);
      continue;
    }
    out.push(t);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Resolve a template's single-parent `extends` chain. Walks
 * root→leaf with a visited set; a cycle or an unknown parent returns a typed
 * error result (never throws, never loops). Merge rules: scalars
 * (model/provider/thinking/maxTurns) child-wins-when-set else inherited;
 * `tools`/`capabilities` the de-duplicated union; `systemPrompt` the root-first
 * concatenation of every body, separated by a blank line.
 */
export function resolveTemplate(name: string, catalog: Template[]): ResolveResult {
  const byName = new Map(catalog.map((t) => [t.name, t]));

  // Walk leaf→root collecting the chain, guarding against cycles.
  const chain: Template[] = [];
  const visited = new Set<string>();
  let current: string | undefined = name;
  while (current !== undefined) {
    if (visited.has(current)) {
      return { ok: false, error: `template inheritance cycle detected at "${current}"` };
    }
    visited.add(current);
    const t = byName.get(current);
    if (!t) {
      // The first lookup is the named template itself; deeper is an extends target.
      return { ok: false, error: `unknown template "${current}"` };
    }
    chain.push(t);
    current = t.extends;
  }

  // chain is leaf→root; merge root-first so a child refines a base.
  const rootFirst = [...chain].reverse();
  const merged: ResolvedTemplate = {
    name: chain[0]!.name,
    description: chain[0]!.description,
    systemPrompt: "",
  };
  const tools: string[] = [];
  const capabilities: string[] = [];
  const prompts: string[] = [];
  for (const t of rootFirst) {
    if (t.model !== undefined) merged.model = t.model;
    if (t.provider !== undefined) merged.provider = t.provider;
    if (t.thinking !== undefined) merged.thinking = t.thinking;
    if (t.maxTurns !== undefined) merged.maxTurns = t.maxTurns;
    for (const tool of t.tools ?? []) if (!tools.includes(tool)) tools.push(tool);
    for (const cap of t.capabilities ?? []) if (!capabilities.includes(cap)) capabilities.push(cap);
    if (t.systemPrompt.length > 0) prompts.push(t.systemPrompt);
  }
  if (tools.length > 0) merged.tools = tools;
  if (capabilities.length > 0) merged.capabilities = capabilities;
  merged.systemPrompt = prompts.join("\n\n");
  return { ok: true, template: merged };
}

/**
 * Prepend an ephemeral name+description catalog to the message list for
 * autonomous discovery. Returns the input array BY REFERENCE (no
 * allocation) when the kill switch is off, the `on` flag is false, or the catalog
 * is empty; otherwise returns a NEW `[note, ...messages]`.
 */
export function injectCatalog(messages: Message[], catalog: Template[], on: boolean): Message[] {
  if (!enabled() || !on || catalog.length === 0) return messages;
  const lines = catalog.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const note: Message = {
    role: "system",
    content: [
      {
        type: "text",
        text: `Available agent templates (delegate via \`spawn_template\`):\n${lines}`,
      },
    ],
    meta: { ephemeral: true, source: "templates" },
  };
  return [note, ...messages];
}

/**
 * Build a delegated child's tool registry: a fresh registry of the parent's
 * tools kept iff `(no allowlist || name ∈ allowlist)` AND `name ∉ {spawn_agent,
 * spawn_template}`. Stripping BOTH spawn tools is the recursion guard — it is
 * NOT subagents' `childRegistryFrom` (which strips only `spawn_agent`).
 */
export function templateChildRegistry(parentTools: Tool[], allowlist?: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of parentTools) {
    const name = tool.spec.name;
    if (SPAWN_TOOLS.has(name)) continue;
    if (allowlist && !allowlist.includes(name)) continue;
    registry.register(tool);
  }
  return registry;
}

/**
 * Construct (but do NOT run) a child `Agent` from a resolved template. Factored
 * out of `spawn_template` so it can be reused by other delegators (teams), which
 * supply `opts`; the caller runs `.run()` and owns the return value.
 *
 * The base registry is `templateChildRegistry(parent.tools, resolved.tools)`
 * unless `opts.baseRegistry` is given. With `opts.excludeCapabilities`, a fresh
 * registry is built from the base's tools dropping any whose declared
 * capabilities intersect the set (a stricter, capability-driven guard than the
 * name-based one above). `opts.extraTools` are then registered. `maxTurns` is the
 * template's own value, or `min(resolved.maxTurns ?? ceiling, ceiling)` when a
 * `maxTurnsCeiling` is given. Capabilities/model/provider/thinking/systemPrompt
 * are wired exactly as the inline `spawn_template` construction. With no `opts`
 * the result is byte-identical to that inline child.
 */
export function buildTemplateChild(
  resolved: ResolvedTemplate,
  parent: {
    providers: ProviderRegistry;
    ui: UI;
    logger: Logger;
    capabilities: CapabilityManager;
    model: string;
    providerName: string | undefined;
    tools: Tool[];
  },
  opts?: {
    baseRegistry?: ToolRegistry;
    extraTools?: Tool[];
    excludeCapabilities?: string[];
    maxTurnsCeiling?: number;
  },
): Agent {
  const base = opts?.baseRegistry ?? templateChildRegistry(parent.tools, resolved.tools);

  let registry = base;
  if (opts?.excludeCapabilities) {
    const exclude = opts.excludeCapabilities;
    registry = new ToolRegistry();
    for (const tool of base.list()) {
      if (tool.capabilities?.some((c) => exclude.includes(c))) continue;
      registry.register(tool);
    }
  }
  if (opts?.extraTools) {
    for (const tool of opts.extraTools) registry.register(tool);
  }

  const ceiling = opts?.maxTurnsCeiling;
  const maxTurns =
    ceiling != null ? Math.min(resolved.maxTurns ?? ceiling, ceiling) : resolved.maxTurns;

  return new Agent({
    providers: parent.providers,
    ui: parent.ui,
    logger: parent.logger,
    capabilities: resolved.capabilities
      ? scopedCapabilities(resolved.capabilities, parent.ui)
      : parent.capabilities,
    model: resolved.model ?? parent.model,
    provider: resolved.provider ?? parent.providerName,
    thinking: resolved.thinking,
    maxTurns,
    systemPrompt: resolved.systemPrompt,
    tools: registry,
  });
}

/** The four live-agent fields the become path mutates and `reset` restores. */
interface Baseline {
  systemPrompt: string;
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
}

/** The active become state: the allow-list veto reads `tools` from it. */
interface Active {
  tools: string[];
}

export default function activate(e: ExtensionAPI): void {
  e.grantCapability("agent:spawn");

  // Module-scoped (per-process) become state — correct for the single-agent
  // CLI/REPL host. `active` arms the veto; `baseline` is the pristine snapshot
  // recorded on the FIRST `use` only, so `reset` always returns to pristine.
  let active: Active | null = null;
  let baseline: Baseline | null = null;

  const catalogOn = (): boolean => e.store.get<string>("catalog") === "on";

  // Opt-in catalog injection (default off). Re-scans each turn so a freshly
  // authored template appears without a reload.
  e.hook("transformContext", (messages) =>
    injectCatalog(messages, scanTemplates(templatesRoot(), (m) => e.log.warn(m)), catalogOn()),
  );

  // The become veto: registered once, inert until a template is active. While
  // active, any tool not in the allow-list is blocked (a name filter).
  e.hook("beforeToolCall", (decision, ctx): ToolDecision => {
    if (decision.block || active === null) return decision;
    if (active.tools.includes(ctx.call.name)) return decision;
    return {
      ...decision,
      block: true,
      reason: `templates: "${ctx.call.name}" is not in the active template's tool allow-list`,
    };
  });

  // Delegate: spawn a fresh child agent from a resolved template.
  e.registerTool(
    defineTool<{ template?: unknown; prompt?: unknown }>({
      name: "spawn_template",
      description:
        "Delegate a task to a fresh isolated child agent built from a named agent template " +
        "(its system prompt, tool allow-list, capability scope, and model/run settings). " +
        "The child runs on `prompt` and returns its final answer. Children cannot themselves " +
        "spawn (no `spawn_agent`/`spawn_template`). An unknown template name returns the list " +
        "of available templates.",
      capabilities: ["agent:spawn"],
      parameters: {
        type: "object",
        properties: {
          template: { type: "string", description: "Name of the agent template to spawn." },
          prompt: { type: "string", description: "Task for the child agent." },
        },
        required: ["template", "prompt"],
      },
      execute: async (args) => {
        if (!enabled()) return fail("Templates are disabled (EAGENT_TEMPLATES=off).");
        const name = typeof args.template === "string" ? args.template : "";
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        if (prompt.length === 0) return fail("spawn_template requires a non-empty string `prompt`.");

        const catalog = scanTemplates(templatesRoot(), (m) => e.log.warn(m));
        const resolved = resolveTemplate(name, catalog);
        if (!resolved.ok) {
          const available = catalog.map((t) => t.name).join(", ") || "(none)";
          return fail(`${resolved.error}. Available templates: ${available}.`);
        }
        const t = resolved.template;

        const child = buildTemplateChild(t, {
          providers: e.agent.providers,
          ui: e.agent.ui,
          logger: e.agent.logger,
          capabilities: e.agent.capabilities,
          model: e.agent.model,
          providerName: e.agent.providerName,
          tools: e.agent.tools.list(),
        });
        const { messages } = await child.run(prompt);
        return ok(finalText(messages), { template: t.name });
      },
    }),
  );

  const command = {
    name: "template",
    description:
      "Manage agent templates: list, show <name>, use <name> (become), reset, catalog on|off.",
    run: (ctx: { agent: unknown; args: string; print(line: string): void }): void => {
      const argv = ctx.args.trim().split(/\s+/).filter((s) => s.length > 0);
      const sub = argv[0] ?? "list";
      const arg = argv[1];

      const catalog = (): Template[] => scanTemplates(templatesRoot(), (m) => e.log.warn(m));

      if (sub === "list") {
        const found = catalog();
        if (found.length === 0) {
          ctx.print(`(no templates in ${templatesRoot()})`);
          return;
        }
        for (const t of found) ctx.print(`  ${t.name.padEnd(20)} ${t.description}`);
        return;
      }

      if (sub === "show") {
        if (!arg) {
          ctx.print("usage: /template show <name>");
          return;
        }
        const resolved = resolveTemplate(arg, catalog());
        if (!resolved.ok) {
          ctx.print(resolved.error);
          return;
        }
        const t = resolved.template;
        ctx.print(`name:    ${t.name}`);
        ctx.print(`model:   ${t.model ?? "(session default)"}`);
        ctx.print(`thinking:${t.thinking ? ` ${t.thinking}` : " (session default)"}`);
        ctx.print(`maxTurns:${t.maxTurns ? ` ${t.maxTurns}` : " (session default)"}`);
        ctx.print(`tools:   ${t.tools?.join(", ") ?? "(all session tools)"}`);
        ctx.print(`caps:    ${t.capabilities?.join(", ") ?? "(delegate inherits session)"}`);
        ctx.print(
          "become note: a tools allow-list blocks every other tool, but allowed tools keep full " +
            "session capabilities — for true scoping, use delegate (spawn_template).",
        );
        ctx.print("---");
        ctx.print(t.systemPrompt);
        return;
      }

      if (sub === "use") {
        if (!enabled()) {
          ctx.print("Templates are disabled (EAGENT_TEMPLATES=off).");
          return;
        }
        if (!arg) {
          ctx.print("usage: /template use <name>");
          return;
        }
        const resolved = resolveTemplate(arg, catalog());
        if (!resolved.ok) {
          ctx.print(resolved.error);
          return;
        }
        const t = resolved.template;
        const agent = e.agent;
        // Record the pristine baseline once (the first `use`), so `reset` always
        // returns to pristine even after switching templates.
        if (baseline === null) {
          baseline = {
            systemPrompt: agent.systemPrompt,
            model: agent.model,
            thinking: agent.thinking,
            maxTurns: agent.maxTurns,
          };
        }
        agent.systemPrompt = t.systemPrompt;
        if (t.model !== undefined) agent.model = t.model;
        if (t.thinking !== undefined) agent.thinking = t.thinking;
        if (t.maxTurns !== undefined) agent.maxTurns = t.maxTurns;
        // Arm the veto only when the template declares a non-empty `tools`
        // allow-list (design §4.5 / §8 risk note). A persona-only template (no
        // `tools` frontmatter) leaves the veto disarmed — `[].includes(x)` would
        // otherwise block every tool, asymmetric with the delegate path where an
        // absent allow-list keeps all parent tools.
        active = t.tools && t.tools.length > 0 ? { tools: t.tools } : null;
        ctx.print(`Now acting as template "${t.name}".`);
        return;
      }

      if (sub === "reset") {
        if (baseline === null) {
          ctx.print("No active template.");
          return;
        }
        const agent = e.agent;
        agent.systemPrompt = baseline.systemPrompt;
        agent.model = baseline.model;
        agent.thinking = baseline.thinking;
        agent.maxTurns = baseline.maxTurns;
        active = null;
        baseline = null;
        ctx.print("Template reset; session restored.");
        return;
      }

      if (sub === "catalog") {
        if (arg === "on") {
          e.store.set("catalog", "on");
          ctx.print("Template catalog injection: on.");
        } else if (arg === "off") {
          e.store.set("catalog", "off");
          ctx.print("Template catalog injection: off.");
        } else {
          ctx.print("usage: /template catalog on|off");
        }
        return;
      }

      ctx.print(`Unknown subcommand "${sub}". Use list | show <name> | use <name> | reset | catalog on|off.`);
    },
  };

  e.registerCommand(command);
  e.registerCommand({ ...command, name: "templates" });
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
