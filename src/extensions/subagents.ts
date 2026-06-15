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
 * tools EXCEPT `spawn_agent` itself. That single omission is the recursion
 * guard: a child cannot spawn grandchildren, so a runaway tree is impossible.
 */

import { Agent } from "../kernel/agent.js";
import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { ToolRegistry } from "../kernel/registry.js";
import type { Message, Tool } from "../kernel/types.js";

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
   * parent currently has, minus `spawn_agent`. Exposed at module scope so the
   * recursion guard can be exercised directly in tests.
   */
  const buildChildRegistry = (): ToolRegistry => childRegistryFrom(e.agent.tools.list());

  /** Construct (but do not run) a child agent for a given prompt. */
  const makeChild = (system: string | undefined, maxTurns: number): Agent =>
    new Agent({
      providers: e.agent.providers,
      capabilities: e.agent.capabilities,
      ui: e.agent.ui,
      logger: e.agent.logger,
      model: e.agent.model,
      provider: e.agent.providerName,
      systemPrompt: system ?? DEFAULT_CHILD_SYSTEM,
      maxTurns,
      tools: buildChildRegistry(),
    });

  /** Run a single child on `prompt`, returning its final assistant text. */
  const runChild = async (prompt: string, system: string | undefined, maxTurns: number): Promise<string> => {
    const child = makeChild(system, maxTurns);
    const { messages } = await child.run(prompt);
    return finalText(messages);
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
        "but cannot themselves spawn.",
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
            default: DEFAULT_MAX_TURNS,
            description: "Safety bound on each child's loop iterations.",
          },
        },
      },
      execute: async (args) => {
        const mode = typeof args.mode === "string" ? args.mode : "single";
        const system = typeof args.system === "string" ? args.system : undefined;
        const maxTurns =
          typeof args.maxTurns === "number" && args.maxTurns > 0
            ? Math.floor(args.maxTurns)
            : DEFAULT_MAX_TURNS;

        if (mode === "single") {
          const prompt = args.prompt;
          if (typeof prompt !== "string" || prompt.length === 0) {
            return fail("mode=single requires a non-empty string `prompt`.");
          }
          const answer = await runChild(prompt, system, maxTurns);
          return ok(answer, { mode, children: 1 });
        }

        const prompts = asPrompts(args.prompts);
        if (!prompts) {
          return fail(`mode=${mode} requires a non-empty string array \`prompts\`.`);
        }

        if (mode === "parallel") {
          const answers = await Promise.all(prompts.map((p) => runChild(p, system, maxTurns)));
          const body = answers.map((a, i) => `[child ${i + 1}]\n${a}`).join("\n\n");
          return ok(body, { mode, children: answers.length });
        }

        if (mode === "chain") {
          let previous: string | undefined;
          let answer = "";
          for (const p of prompts) {
            const prompt =
              previous === undefined ? p : `Previous result:\n${previous}\n\nNow: ${p}`;
            answer = await runChild(prompt, system, maxTurns);
            previous = answer;
          }
          return ok(answer, { mode, children: prompts.length });
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
    },
  });
}

/**
 * Copy a parent's active tools into a fresh registry, omitting `spawn_agent`.
 * This is the recursion guard, factored out so tests can assert it directly.
 */
export function childRegistryFrom(parentTools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of parentTools) {
    if (tool.spec.name === SPAWN_TOOL) continue;
    registry.register(tool);
  }
  return registry;
}

/** Coerce an argument into a non-empty array of strings, or undefined. */
function asPrompts(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((v) => typeof v === "string" && v.length > 0)) return undefined;
  return value as string[];
}

/** Find the last assistant text block in a transcript. */
function finalText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const block = m.content.find((b) => b.type === "text");
    if (block && block.type === "text") return block.text;
  }
  return "";
}
