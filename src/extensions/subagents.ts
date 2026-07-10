/**
 * Sub-agent orchestration — spawning isolated child agents from a tool.
 *
 * Sub-agents are an extension, not a kernel primitive, on purpose. The kernel's
 * job is to run *one* agent loop well: assemble context, stream, dispatch
 * tools, decide whether to continue. Spawning more agents is a policy built on
 * top of that loop, and policies live in extensions (the pi/Emacs discipline).
 *
 * Three things motivate sub-agents, and all three are achievable purely by
 * composing the public `Agent` surface:
 *
 *   - Isolated context windows. A child gets its own fresh transcript, so a
 *     noisy research task or a long tool dialogue never pollutes the parent's
 *     window. The parent sees only the child's final answer.
 *   - Parallelism. Independent subtasks fan out concurrently and rejoin, which
 *     the single linear loop cannot express on its own.
 *   - Specialization. Each child can carry its own system prompt and (here) a
 *     pruned tool set, so a child can be a focused specialist.
 *
 * Crucially, a child SHARES the parent's providers and capabilities (so it
 * costs nothing extra to wire up and is governed by the same permission layer)
 * but gets its OWN tool registry, which we populate by copying the parent's
 * tools EXCEPT any that declare a spawn-class capability
 * (`agent:spawn`/`workflow:run`). That capability strip is the recursion guard: a
 * child inherits no spawner, so it cannot spawn grandchildren and a runaway tree
 * is impossible.
 */

import { Agent } from "../kernel/agent.js";
import { CapabilityManager } from "../kernel/capabilities.js";
import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { ToolRegistry } from "../kernel/registry.js";
import type { JSONSchema, Logger, Message, ToolResult, UI } from "../kernel/types.js";
import { validate } from "../kernel/validate.js";

import { childRegistryFrom } from "./lib/child-registry.js";

// Re-exported for callers that import the recursion guard from this module (e.g.
// tests); the capability-based implementation lives in the shared lib helper.
export { childRegistryFrom };

/** The tool name, also the registration that children must never inherit. */
const SPAWN_TOOL = "spawn_agent";

const DEFAULT_CHILD_SYSTEM =
  "You are a focused sub-agent. You have a fresh context and a single task. " +
  "Work it to completion and report only the final answer concisely.";

const DEFAULT_MAX_TURNS = 8;

export default function activate(e: ExtensionAPI): void {
  e.grantCapability("agent:spawn");

  /**
   * Build a child's tool registry: a fresh registry seeded with every tool the
   * parent currently has, minus every spawn-class tool (the shared capability
   * strip). Delegates to the lib `childRegistryFrom`.
   */
  const buildChildRegistry = (): ToolRegistry => childRegistryFrom(e.agent.tools.list());

  /**
   * The per-spawn options resolved once from the tool args and applied uniformly
   * to every child of the call. Omitting all of them reproduces today's exact
   * construction (parent capabilities, parent provider/model, free-text return).
   */
  interface ChildOptions {
    capabilities: CapabilityManager;
    provider: string | undefined;
    model: string;
    schema: JSONSchema | undefined;
  }

  /**
   * Construct (but do not run) a child agent for a given system prompt, using the
   * resolved per-spawn capability manager and provider/model. With no new params
   * supplied this is byte-identical to today (parent manager, parent
   * provider/model).
   */
  const makeChild = (system: string | undefined, maxTurns: number, opts: ChildOptions): Agent =>
    new Agent({
      providers: e.agent.providers,
      capabilities: opts.capabilities,
      ui: e.agent.ui,
      logger: e.agent.logger,
      model: opts.model,
      provider: opts.provider,
      systemPrompt: system ?? DEFAULT_CHILD_SYSTEM,
      maxTurns,
      tools: buildChildRegistry(),
      hooks: e.agent.hooks.childScope(),
    });

  /**
   * Run a single child on `prompt`. With no `outputSchema` the return is the
   * child's free-text final answer (today's behavior). With a schema, the child
   * runs under the typed-return contract (validate + one re-prompt then fail).
   */
  const runChild = async (
    prompt: string,
    system: string | undefined,
    maxTurns: number,
    opts: ChildOptions,
  ): Promise<ToolResult> => {
    if (opts.schema) {
      return runTypedChild(
        prompt,
        system ?? DEFAULT_CHILD_SYSTEM,
        opts.schema,
        (sys) => makeChild(sys, maxTurns, opts),
        finalText,
      );
    }
    const child = makeChild(system, maxTurns, opts);
    const { messages } = await child.run(prompt);
    return ok(finalText(messages));
  };

  e.registerTool(
    defineTool({
      name: SPAWN_TOOL,
      description:
        "Spawn isolated child agent(s) with a fresh context window. " +
        "mode=single runs one child on `prompt`. mode=parallel runs one child " +
        "per entry of `prompts` concurrently and concatenates their answers. " +
        "mode=chain runs children sequentially, feeding each answer into the " +
        "next prompt. Children share this agent's providers and permissions " +
        "but cannot themselves spawn. Set readOnly=true to run the child(ren) " +
        "in a strict read-only lane (fs:read only; all mutation and network " +
        "egress denied) — use it for explorers and reviewers that must not " +
        "change anything. Optionally scope the child(ren) to a capability subset " +
        "with `capabilities`, run them on a different registered vendor with " +
        "`provider`/`model`, and demand a typed JSON return with " +
        "`outputSchema`/`require`.",
      capabilities: ["agent:spawn"],
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["single", "parallel", "chain"],
            default: "single",
            description: "Orchestration mode.",
          },
          prompt: {
            type: "string",
            description: "Task for the child (mode=single).",
          },
          prompts: {
            type: "array",
            items: { type: "string" },
            description: "Tasks for the children (mode=parallel or mode=chain).",
          },
          system: {
            type: "string",
            description: "Optional system prompt applied to every child.",
          },
          maxTurns: {
            type: "integer",
            description:
              "Safety bound on each child's loop iterations. Omit to use the configured " +
              "`subagents.maxTurns` (default 8).",
          },
          readOnly: {
            type: "boolean",
            default: false,
            description:
              "Run the child(ren) in a strict read-only capability lane: fs:read only, " +
              "all mutation/egress (fs:write, shell:exec, net:fetch, …) denied.",
          },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional capability allowlist scoping the child(ren) to exactly these patterns " +
              "(deny everything else); generalizes readOnly. If both are set, this wins.",
          },
          provider: {
            type: "string",
            description:
              "Optional name of a registered provider to run the child(ren) on (de-correlate a " +
              "reviewer from the producer). Falls back to the parent provider if unregistered.",
          },
          model: {
            type: "string",
            description: "Optional model override for the child(ren); defaults to the parent's model.",
          },
          outputSchema: {
            type: "object",
            description:
              "Optional JSON Schema the child(ren)'s final answer must satisfy. The child is " +
              "instructed to emit only matching JSON; an invalid reply is re-prompted once then fails.",
          },
          require: {
            type: "array",
            items: { type: "string" },
            description: "Optional keys folded into outputSchema.required, to demand fields without a full schema.",
          },
        },
      },
      execute: async (args) => {
        const mode = typeof args.mode === "string" ? args.mode : "single";
        const system = typeof args.system === "string" ? args.system : undefined;
        const lp = e.config.enabled("subagents.lp", { default: true });
        const maxTurns =
          typeof args.maxTurns === "number" && args.maxTurns > 0
            ? Math.floor(args.maxTurns)
            : e.config.int("subagents.maxTurns", DEFAULT_MAX_TURNS);
        const readOnly = args.readOnly === true;

        // Resolve the three least-privilege passthroughs once; applied to every
        // child of this call (like `system`). Omitting all three reproduces today.
        const parent = {
          capabilities: e.agent.capabilities,
          ui: e.agent.ui,
          providers: e.agent.providers,
          providerName: e.agent.providerName,
          model: e.agent.model,
          log: e.log,
        };
        const { provider, model } = resolveChildProvider(args, parent, lp);
        const opts: ChildOptions = {
          capabilities: resolveChildCapabilities(args, parent, lp),
          provider,
          model,
          schema: resolveOutputSchema(args, lp),
        };

        if (mode === "single") {
          const prompt = args.prompt;
          if (typeof prompt !== "string" || prompt.length === 0) {
            return fail("mode=single requires a non-empty string `prompt`.");
          }
          const res = await runChild(prompt, system, maxTurns, opts);
          return { ...res, details: { mode, children: 1, readOnly, child: res.details } };
        }

        const prompts = asPrompts(args.prompts);
        if (!prompts) {
          return fail(`mode=${mode} requires a non-empty string array \`prompts\`.`);
        }

        if (mode === "parallel") {
          const results = await Promise.all(prompts.map((p) => runChild(p, system, maxTurns, opts)));
          const body = results.map((r, i) => `[child ${i + 1}]\n${r.content}`).join("\n\n");
          const isError = results.some((r) => r.isError) || undefined;
          // Carry each child's details so the shape stays consistent with single/chain
          // (which expose a nested `child`); here it is one `child` entry per prompt.
          const children = results.map((r) => r.details);
          return { content: body, isError, details: { mode, children: results.length, readOnly, child: children } };
        }

        if (mode === "chain") {
          let previous: string | undefined;
          let last: ToolResult = ok("");
          for (const p of prompts) {
            const prompt =
              previous === undefined ? p : `Previous result:\n${previous}\n\nNow: ${p}`;
            last = await runChild(prompt, system, maxTurns, opts);
            if (last.isError) {
              return { ...last, details: { mode, children: prompts.length, readOnly, child: last.details } };
            }
            previous = last.content;
          }
          return { ...last, details: { mode, children: prompts.length, readOnly, child: last.details } };
        }

        return fail(`Unknown mode: ${mode}. Use single, parallel, or chain.`);
      },
    }),
  );

  e.registerCommand({
    name: "agents",
    description: "Explain the sub-agent spawn modes.",
    run: (ctx) => {
      ctx.print("spawn_agent — run isolated child agents with fresh context.");
      ctx.print("  single   : one child on `prompt`; returns its final answer.");
      ctx.print("  parallel : one child per `prompts[]`, run concurrently; answers concatenated.");
      ctx.print("  chain    : children run in sequence, each fed the previous child's answer.");
      ctx.print("Children share this agent's providers and permissions but cannot re-spawn.");
      ctx.print("Optional per-spawn controls (default off):");
      ctx.print("  capabilities : allowlist scoping the child to a capability subset (readOnly is sugar).");
      ctx.print("  provider/model : run the child on a different registered provider/model (falls back if unknown).");
      ctx.print("  outputSchema/require : demand a typed JSON return (validated; re-prompted once then failed).");
    },
  });
}

/** The read capabilities a read-only child is granted; everything else is denied. */
const READ_ONLY_GRANTS = ["fs:read", "skill:read"] as const;

/**
 * A fresh deny-fallback capability manager scoped to exactly the granted
 * patterns. This is the generalized middle privilege tier: a child gets only the
 * listed capabilities and everything else is refused at the capability boundary.
 * `readOnlyCapabilities` is now sugar over this with the read-only preset.
 */
export function scopedCapabilities(grant: readonly string[], ui?: UI): CapabilityManager {
  return new CapabilityManager({ grant: [...grant], fallback: "deny", ui });
}

/**
 * A fresh capability manager for a read-only child: it grants only local read
 * capabilities and denies everything else by fallback, so any mutation or
 * network-egress tool the child attempts is refused at the capability boundary.
 * Exported so the lane's enforcement is unit-testable directly.
 */
export function readOnlyCapabilities(ui?: UI): CapabilityManager {
  return scopedCapabilities(READ_ONLY_GRANTS, ui);
}

/** Coerce a value into a non-empty array of non-empty strings, or undefined. */
function nonEmptyStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * Resolve the capability manager for a child from its spawn args, shared by the
 * spawn tool and the workflow `agent` step. Precedence: an explicit
 * `capabilities` allowlist wins (a warning is logged if `readOnly` is also set);
 * else `readOnly:true` uses the read-only preset; else the child inherits the
 * parent's manager exactly as today. When the kill switch is off, always inherit.
 */
export function resolveChildCapabilities(
  args: { capabilities?: unknown; readOnly?: unknown },
  parent: { capabilities: CapabilityManager; ui: UI; log: Pick<Logger, "warn"> },
  enabled = true,
): CapabilityManager {
  if (!enabled) return parent.capabilities;
  const allowlist = nonEmptyStringList(args.capabilities);
  const readOnly = args.readOnly === true;
  if (allowlist) {
    if (readOnly) {
      parent.log.warn("spawn_agent: both `capabilities` and `readOnly` supplied; `capabilities` wins.");
    }
    return scopedCapabilities(allowlist, parent.ui);
  }
  if (readOnly) return readOnlyCapabilities(parent.ui);
  return parent.capabilities;
}

/**
 * Resolve the child's provider/model from its spawn args. A named,
 * *registered* provider is used as-is; an unregistered/typo'd name falls back to
 * the parent's provider with a logged warning (never a hard failure). `model` is
 * overridden only when a string is supplied. When the kill switch is off, the
 * parent's provider/model are used unchanged.
 */
export function resolveChildProvider(
  args: { provider?: unknown; model?: unknown },
  parent: { providers: { get(name?: string): unknown }; providerName: string | undefined; model: string; log: Pick<Logger, "warn"> },
  enabled = true,
): { provider: string | undefined; model: string } {
  if (!enabled) return { provider: parent.providerName, model: parent.model };
  let provider = parent.providerName;
  if (typeof args.provider === "string" && args.provider.length > 0) {
    if (parent.providers.get(args.provider) !== undefined) {
      provider = args.provider;
    } else {
      parent.log.warn(
        `spawn_agent: provider "${args.provider}" is not registered; falling back to the parent provider.`,
      );
    }
  }
  const model = typeof args.model === "string" && args.model.length > 0 ? args.model : parent.model;
  return { provider, model };
}

/** The fixed prefix marking a typed-return contract failure (a stable constant). */
const CONTRACT_VIOLATION = "contract violation:";

/**
 * Resolve the `outputSchema` (+ folded `require`) for a child, or `undefined`
 * when no typed return is requested or the kill switch is off. `require` keys are
 * unioned into the schema's `required` so a parent can demand keys without
 * hand-writing a full schema.
 */
export function resolveOutputSchema(
  args: { outputSchema?: unknown; require?: unknown },
  enabled = true,
): JSONSchema | undefined {
  if (!enabled) return undefined;
  const raw = args.outputSchema;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const schema = { ...(raw as JSONSchema) };
  const extra = nonEmptyStringList(args.require);
  if (extra) {
    const required = new Set<string>([...(schema.required ?? []), ...extra]);
    schema.required = [...required];
  }
  return schema;
}

/** The contract instruction appended to a typed child's system prompt (fixed wording). */
function contractInstruction(schema: JSONSchema): string {
  const required = schema.required ?? [];
  return (
    "\n\nReturn ONLY a JSON object matching this schema: " +
    JSON.stringify(schema) +
    (required.length > 0 ? `; required: ${required.join(", ")}` : "") +
    ". Emit no prose around the JSON."
  );
}

/**
 * Render a re-prompt seed from validation errors (recovery-style single nudge):
 * the same child is re-run with this concrete, error-keyed correction.
 */
function repromptSeed(prompt: string, errors: string[]): string {
  return (
    `${prompt}\n\nYour previous reply did not satisfy the required JSON contract:\n- ` +
    errors.join("\n- ") +
    "\nReturn ONLY the corrected JSON object, nothing else."
  );
}

/** Parse the child's final text as JSON; a parse failure is treated as a miss. */
function parseChildJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Run a child under a typed-return contract, shared by the spawn tool and
 * the workflow `agent` step. The child is run, its final text parsed as JSON and
 * validated against `schema`; on a miss the child is re-run *once* seeded with
 * the concrete errors, then validated again. Still invalid → a `contract
 * violation:` failure. At most two child runs. On success the validated object is
 * rendered as JSON `content` and carried in the result `details`.
 *
 * `build` constructs a fresh child given the (contract-augmented) system prompt;
 * `harvest` reads a finished child's final assistant text. Both are supplied by
 * the caller so this stays free of either file's Agent-construction specifics.
 */
export async function runTypedChild(
  prompt: string,
  baseSystem: string,
  schema: JSONSchema,
  build: (system: string) => Agent,
  harvest: (messages: readonly Message[]) => string,
): Promise<ToolResult> {
  const system = baseSystem + contractInstruction(schema);

  const attempt = async (input: string): Promise<{ text: string; result: ReturnType<typeof validate> }> => {
    const child = build(system);
    const { messages } = await child.run(input);
    const text = harvest(messages);
    const parsed = parseChildJson(text);
    if (!parsed.ok) {
      return { text, result: { ok: false, value: undefined, errors: ["final reply was not valid JSON"] } };
    }
    return { text, result: validate(schema, parsed.value) };
  };

  const first = await attempt(prompt);
  if (first.result.ok) {
    return ok(JSON.stringify(first.result.value), first.result.value);
  }

  const second = await attempt(repromptSeed(prompt, first.result.errors));
  if (second.result.ok) {
    return ok(JSON.stringify(second.result.value), second.result.value);
  }

  return fail(`${CONTRACT_VIOLATION} child output did not match the schema after one retry:\n- ${second.result.errors.join("\n- ")}`);
}

/** Coerce an argument into a non-empty array of strings, or undefined. */
function asPrompts(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((v) => typeof v === "string" && v.length > 0)) return undefined;
  return value as string[];
}

/** The last assistant message's text, concatenating all of its text blocks. */
export function finalText(messages: readonly Message[]): string {
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
