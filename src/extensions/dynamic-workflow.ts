/**
 * Dynamic workflows — executing a model-emitted dependency DAG of steps.
 *
 * Like sub-agents, this is an extension, not a kernel primitive. The kernel runs
 * *one* agent loop; a workflow is a policy that composes that loop's public
 * surface (tools, capabilities, hooks, the Agent constructor) into a small
 * scheduler. The bet from the research is that the agent loop is just the
 * degenerate (single-ready-node) case of a DAG scheduler, so adding a scheduler
 * as an extension is a faithful increment rather than a new paradigm.
 *
 * What this adds over `subagents` (which only does single/parallel/chain prompt
 * fan-out) is *data dependencies between heterogeneous steps*: a step's output
 * feeds named downstream steps, independent steps run concurrently, and a step
 * may be either a guarded tool call or an isolated sub-agent. The model emits the
 * whole DAG as the `run_workflow` argument — that is where the "dynamic" lives;
 * conditional/replanning behavior comes from the model regenerating the spec, not
 * from in-graph branching.
 *
 * Steps reference each other with `${id}` tokens (ReWOO/LLMCompiler variable
 * substitution); a referenced id is auto-derived as a dependency edge, so a
 * referenced-but-unsequenced step is structurally impossible.
 */

import { Agent } from "../kernel/agent.js";
import { defineTool, fail, ok } from "../kernel/define.js";
import type { ToolDecision } from "../kernel/events.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { ToolRegistry } from "../kernel/registry.js";
import type { JSONSchema, Message, Tool, ToolCallBlock, ToolContext, ToolResult } from "../kernel/types.js";
import { validate } from "../kernel/validate.js";
import {
  resolveChildCapabilities,
  resolveChildProvider,
  resolveOutputSchema,
  runTypedChild,
} from "./subagents.js";

/** The tool name; also the registration a workflow's child agents must not inherit. */
const WORKFLOW_TOOL = "run_workflow";

/** Upper bound on a single model-emitted plan, so a runaway spec is rejected. */
export const MAX_STEPS = 32;

const DEFAULT_CHILD_SYSTEM =
  "You are a focused workflow sub-agent. You have a fresh context and a single " +
  "task. Work it to completion and report only the final answer concisely.";

const DEFAULT_AGENT_MAX_TURNS = 8;

type StepType = "tool" | "agent";
type StepStatus = "done" | "error" | "skipped";

interface WorkflowStep {
  id: string;
  type: StepType;
  needs: string[];
  tool?: string;
  args: Record<string, unknown>;
  prompt?: string;
  system?: string;
  /** type=agent: optional least-privilege passthroughs (default off). */
  capabilities?: unknown;
  readOnly?: unknown;
  provider?: unknown;
  model?: unknown;
  outputSchema?: unknown;
  require?: unknown;
}

interface PlannedWorkflow {
  steps: WorkflowStep[];
  /** Effective dependency set per step id: explicit `needs` ∪ `${id}` references. */
  deps: Map<string, Set<string>>;
}

const STEP_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Unique id within the workflow; other steps reference it as ${id}." },
    type: {
      type: "string",
      enum: ["tool", "agent"],
      default: "tool",
      description: "tool = invoke a registered tool; agent = spawn an isolated sub-agent on a prompt.",
    },
    needs: {
      type: "array",
      items: { type: "string" },
      description: "Optional ordering dependencies (step ids) that pass no data. Data dependencies are auto-derived from ${id} references.",
    },
    tool: { type: "string", description: "For type=tool: the registered tool name to invoke." },
    args: {
      type: "object",
      description: "For type=tool: arguments for the tool. String values may embed ${otherStepId} to splice in that step's output.",
    },
    prompt: { type: "string", description: "For type=agent: the child task. May embed ${otherStepId} references." },
    system: { type: "string", description: "For type=agent: optional system prompt for the child." },
    capabilities: {
      type: "array",
      items: { type: "string" },
      description: "For type=agent: optional capability allowlist scoping the child (generalizes readOnly).",
    },
    readOnly: { type: "boolean", description: "For type=agent: run the child in the read-only lane." },
    provider: { type: "string", description: "For type=agent: a registered provider to run the child on (falls back if unknown)." },
    model: { type: "string", description: "For type=agent: optional model override for the child." },
    outputSchema: { type: "object", description: "For type=agent: JSON Schema the child's final answer must satisfy (re-prompted once)." },
    require: { type: "array", items: { type: "string" }, description: "For type=agent: keys folded into outputSchema.required." },
  },
  required: ["id"],
};

const WORKFLOW_PARAMS: JSONSchema = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: STEP_SCHEMA,
      description:
        "The workflow as a flat list of steps forming a dependency DAG. Independent steps run " +
        "concurrently; a step runs once every step it depends on has succeeded, with ${id} " +
        "references substituted by that step's output.",
    },
  },
  required: ["steps"],
};

export default function activate(e: ExtensionAPI): void {
  e.grantCapability("workflow:run");

  e.registerTool(
    defineTool({
      name: WORKFLOW_TOOL,
      description:
        "Execute a dynamic workflow: a dependency DAG of steps you supply. Each step is either " +
        "a `tool` call (a registered tool + args) or an `agent` (an isolated sub-agent on a " +
        "prompt). A step's string inputs may embed ${otherStepId} to splice in that step's " +
        "output; referenced steps automatically become dependencies, so independent steps run " +
        "in parallel and dependents wait. Tool steps are governed by the same capability and " +
        "policy checks as any tool call. Returns a per-step status rundown.",
      capabilities: ["workflow:run"],
      // Sequential so the whole workflow is not interleaved with the parent's other tool calls.
      executionMode: "sequential",
      parameters: WORKFLOW_PARAMS,
      execute: async (args, ctx) => {
        const planned = planWorkflow(args.steps, e.agent.tools);
        if ("error" in planned) return fail(planned.error);
        return runWorkflow(planned, ctx, e);
      },
    }),
  );

  e.registerCommand({
    name: "workflow",
    description: "Explain the dynamic workflow tool and its step shape.",
    run: (cmd) => {
      cmd.print("run_workflow — execute a dependency DAG of steps you supply.");
      cmd.print("  Each step: { id, type: tool|agent, needs?, ... }");
      cmd.print("    tool  : { tool: <name>, args: {...} }   (args strings may use ${otherId})");
      cmd.print("    agent : { prompt: <task>, system?: <prompt> }   (prompt may use ${otherId})");
      cmd.print("  ${id} splices in that step's output and makes it a dependency.");
      cmd.print("  Independent steps run in parallel; dependents wait for their inputs.");
      cmd.print("  Tool steps are capability- and policy-gated exactly like normal tool calls.");
    },
  });
}

// ---------------------------------------------------------------------------
// Planning / validation (pure)
// ---------------------------------------------------------------------------

/**
 * Validate a raw `steps` value into a plan, or return a single actionable error.
 * Everything that can be checked statically is checked here, before any step
 * runs, so an invalid model-emitted spec has no side effects.
 */
export function planWorkflow(rawSteps: unknown, tools: ToolRegistry): PlannedWorkflow | { error: string } {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { error: "workflow requires a non-empty `steps` array." };
  }
  if (rawSteps.length > MAX_STEPS) {
    return { error: `workflow has ${rawSteps.length} steps, over the limit of ${MAX_STEPS}.` };
  }

  const steps: WorkflowStep[] = [];
  const ids = new Set<string>();
  for (const raw of rawSteps) {
    if (typeof raw !== "object" || raw === null) return { error: "each step must be an object." };
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    if (id.length === 0) return { error: "each step needs a non-empty string `id`." };
    if (ids.has(id)) return { error: `duplicate step id "${id}".` };
    ids.add(id);

    const type: StepType = r.type === "agent" ? "agent" : "tool";
    const needs = Array.isArray(r.needs) ? r.needs.filter((n): n is string => typeof n === "string") : [];
    const args = typeof r.args === "object" && r.args !== null ? (r.args as Record<string, unknown>) : {};
    const prompt = typeof r.prompt === "string" ? r.prompt : undefined;
    const system = typeof r.system === "string" ? r.system : undefined;

    if (type === "tool") {
      const tool = typeof r.tool === "string" ? r.tool : "";
      if (tool.length === 0) return { error: `step "${id}" (tool) needs a \`tool\` name.` };
      if (tool === WORKFLOW_TOOL) return { error: `step "${id}" may not call "${WORKFLOW_TOOL}" (no nested workflows).` };
      if (!tools.has(tool)) return { error: `step "${id}" names unregistered tool "${tool}".` };
      steps.push({ id, type, needs, tool, args });
    } else {
      if (!prompt || prompt.length === 0) return { error: `step "${id}" (agent) needs a non-empty \`prompt\`.` };
      // Carry the optional least-privilege passthroughs verbatim; they are coerced
      // and validated at run time by the shared resolvers (gated by the kill switch).
      steps.push({
        id,
        type,
        needs,
        args,
        prompt,
        system,
        capabilities: r.capabilities,
        readOnly: r.readOnly,
        provider: r.provider,
        model: r.model,
        outputSchema: r.outputSchema,
        require: r.require,
      });
    }
  }

  // Effective dependency edges: explicit `needs` ∪ ${id} references that name a
  // declared step. A `needs` entry to an unknown id is a hard error; a ${...}
  // token that is not a declared id is left verbatim (not a dependency, not an
  // error) so legitimate `${HOME}`-style text is never corrupted.
  const deps = new Map<string, Set<string>>();
  for (const step of steps) {
    const set = new Set<string>();
    for (const need of step.needs) {
      if (!ids.has(need)) return { error: `step "${step.id}" needs unknown step "${need}".` };
      set.add(need);
    }
    for (const ref of extractRefs([step.args, step.prompt])) {
      if (ids.has(ref)) set.add(ref);
    }
    if (set.has(step.id)) return { error: `step "${step.id}" depends on itself.` };
    deps.set(step.id, set);
  }

  const cycle = findCycle(steps, deps);
  if (cycle) return { error: `workflow has a dependency cycle: ${cycle.join(" -> ")}.` };

  return { steps, deps };
}

/** Collect every `${id}` token's inner name found in any string leaf of `value`. */
export function extractRefs(value: unknown): string[] {
  const refs = new Set<string>();
  const scan = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{([^}]+)\}/g)) refs.add(m[1]!.trim());
    } else if (Array.isArray(v)) {
      for (const item of v) scan(item);
    } else if (v && typeof v === "object") {
      for (const item of Object.values(v)) scan(item);
    }
  };
  scan(value);
  return [...refs];
}

/**
 * Replace `${id}` tokens with `outputs[id]` in every string leaf of `value`,
 * leaving tokens with no matching output verbatim. Returns a deep copy; the
 * input is not mutated.
 */
export function substitute<T>(value: T, outputs: Record<string, string>): T {
  const sub = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replace(/\$\{([^}]+)\}/g, (whole, id: string) => {
        const out = outputs[id.trim()];
        return out !== undefined ? out : whole;
      });
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = sub(val);
      return out;
    }
    return v;
  };
  return sub(value) as T;
}

/** Kahn's algorithm; returns the unscheduled ids (a cycle) or null if acyclic. */
function findCycle(steps: WorkflowStep[], deps: Map<string, Set<string>>): string[] | null {
  const remaining = new Set(steps.map((s) => s.id));
  let progress = true;
  while (progress && remaining.size > 0) {
    progress = false;
    for (const id of [...remaining]) {
      const unmet = [...(deps.get(id) ?? [])].some((d) => remaining.has(d));
      if (!unmet) {
        remaining.delete(id);
        progress = true;
      }
    }
  }
  return remaining.size > 0 ? [...remaining] : null;
}

/**
 * Build a child agent's tool registry: the parent's active tools minus
 * `run_workflow`, so a workflow's `agent` step cannot launch another workflow.
 * The one-omission recursion guard, mirroring `subagents`' `childRegistryFrom`.
 */
export function workflowChildRegistry(parentTools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of parentTools) {
    if (tool.spec.name === WORKFLOW_TOOL) continue;
    registry.register(tool);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Execution (effectful)
// ---------------------------------------------------------------------------

interface StepResult {
  status: StepStatus;
  output: string;
}

async function runWorkflow(plan: PlannedWorkflow, ctx: ToolContext, e: ExtensionAPI): Promise<ToolResult> {
  const { steps, deps } = plan;
  const byId = new Map(steps.map((s) => [s.id, s]));
  const status = new Map<string, StepStatus>();
  const outputs: Record<string, string> = {};

  let pending = new Set(steps.map((s) => s.id));
  while (pending.size > 0) {
    // Cascade skips: any pending step with a failed/skipped dependency cannot run.
    cascadeSkips(pending, deps, status);

    const ready = [...pending].filter((id) => [...(deps.get(id) ?? [])].every((d) => status.get(d) === "done"));
    if (ready.length === 0) break; // all remaining are skipped (or, defensively, blocked)

    // Mirror the kernel's dispatch heuristic: a single sequential-mode tool step
    // in the frontier forces the whole frontier to run in order.
    const sequential = ready.some((id) => {
      const step = byId.get(id)!;
      return step.type === "tool" && e.agent.tools.get(step.tool!)?.executionMode === "sequential";
    });

    const run = async (id: string): Promise<void> => {
      const res = await runStep(byId.get(id)!, outputs, ctx, e);
      status.set(id, res.status);
      // Record the output regardless of status; an error step's text shows in the
      // rundown, and its non-"done" status keeps dependents from consuming it.
      outputs[id] = res.output;
      pending.delete(id);
    };

    if (sequential) {
      for (const id of ready) await run(id);
    } else {
      await Promise.all(ready.map(run));
    }
  }

  // Anything still pending after the loop could only be skipped steps.
  for (const id of pending) status.set(id, "skipped");

  return renderResult(steps, status, outputs);
}

/** Mark any pending step whose effective deps include a failed/skipped step as skipped, transitively. */
function cascadeSkips(pending: Set<string>, deps: Map<string, Set<string>>, status: Map<string, StepStatus>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...pending]) {
      const bad = [...(deps.get(id) ?? [])].some((d) => {
        const s = status.get(d);
        return s === "error" || s === "skipped";
      });
      if (bad) {
        status.set(id, "skipped");
        pending.delete(id);
        changed = true;
      }
    }
  }
}

async function runStep(
  step: WorkflowStep,
  outputs: Record<string, string>,
  ctx: ToolContext,
  e: ExtensionAPI,
): Promise<StepResult> {
  if (step.type === "agent") return runAgentStep(step, outputs, e);
  return runToolStep(step, outputs, ctx, e);
}

async function runToolStep(
  step: WorkflowStep,
  outputs: Record<string, string>,
  ctx: ToolContext,
  e: ExtensionAPI,
): Promise<StepResult> {
  const tool = e.agent.tools.get(step.tool!);
  if (!tool) return { status: "error", output: `tool "${step.tool}" is no longer registered.` };
  const args = substitute(step.args, outputs);
  const call: ToolCallBlock = { type: "tool_call", id: `wf:${step.id}`, name: step.tool!, arguments: args };
  const result = await guardedInvoke(tool, call, ctx, e);
  return { status: result.isError ? "error" : "done", output: result.content };
}

/**
 * Run a tool through a faithful mirror of the kernel's guard sequence
 * (`Agent.executeGuarded` + `runOne`, src/kernel/agent.ts:286-344): validate →
 * beforeToolCall → invalid-args → capability require → re-validate → execute,
 * all wrapped so a throw becomes an error result and `afterToolCall` runs on
 * every outcome. This keeps `planmode`, `flow-guard`, and `integrity` governing
 * tool calls made inside a workflow — the workflow does not bypass policy.
 *
 * It intentionally reproduces the kernel's order; if the kernel's guard changes,
 * this mirror must be updated to match (a test asserts the beforeToolCall path is
 * live, so a drift surfaces as a failing test).
 */
async function guardedInvoke(tool: Tool, call: ToolCallBlock, ctx: ToolContext, e: ExtensionAPI): Promise<ToolResult> {
  let result: ToolResult;
  try {
    result = await guardedBody(tool, call, ctx, e);
  } catch (err) {
    result = { content: errorText(err), isError: true };
  }
  return e.agent.hooks.apply("afterToolCall", result, { call });
}

async function guardedBody(tool: Tool, call: ToolCallBlock, ctx: ToolContext, e: ExtensionAPI): Promise<ToolResult> {
  const { ok: valid, value, errors } = validate(tool.spec.parameters, call.arguments);
  const args = (valid ? value : call.arguments) as Record<string, unknown>;

  const decision: ToolDecision = { block: false, arguments: args };
  const decided = await e.agent.hooks.apply("beforeToolCall", decision, { call }, (d) => d.block);
  if (decided.block) {
    return { content: `Tool call blocked: ${decided.reason ?? "no reason given"}`, isError: true };
  }
  if (!valid) {
    return { content: `Invalid arguments for ${call.name}:\n- ${errors.join("\n- ")}`, isError: true };
  }

  for (const cap of tool.capabilities ?? []) {
    await e.agent.capabilities.require(cap, tool.spec.name);
  }

  const final = validate(tool.spec.parameters, decided.arguments);
  if (!final.ok) {
    return { content: `Invalid arguments for ${call.name} (after guards):\n- ${final.errors.join("\n- ")}`, isError: true };
  }

  const stepCtx: ToolContext = {
    toolCallId: call.id,
    signal: ctx.signal,
    require: (cap) => e.agent.capabilities.require(cap, tool.spec.name),
    progress: ctx.progress,
    ui: ctx.ui,
    agent: ctx.agent,
    log: ctx.log,
  };
  return tool.execute(final.value as Record<string, unknown>, stepCtx);
}

async function runAgentStep(step: WorkflowStep, outputs: Record<string, string>, e: ExtensionAPI): Promise<StepResult> {
  const prompt = substitute(step.prompt ?? "", outputs);

  // Resolve the three least-privilege passthroughs once; omitting all
  // of them — or the kill switch being off — reproduces today's exact construction
  // (parent manager, parent provider/model, free-text return).
  const parent = {
    capabilities: e.agent.capabilities,
    ui: e.agent.ui,
    providers: e.agent.providers,
    providerName: e.agent.providerName,
    model: e.agent.model,
    log: e.log,
  };
  const lp = e.config.enabled("subagents.lp", { default: true });
  const { provider, model } = resolveChildProvider(step, parent, lp);
  const capabilities = resolveChildCapabilities(step, parent, lp);
  const schema = resolveOutputSchema(step, lp);

  const build = (system: string): Agent =>
    new Agent({
      providers: e.agent.providers,
      capabilities,
      ui: e.agent.ui,
      logger: e.agent.logger,
      model,
      provider,
      systemPrompt: system,
      maxTurns: e.config.int("dynamic-workflow.maxTurns", DEFAULT_AGENT_MAX_TURNS),
      tools: workflowChildRegistry(e.agent.tools.list()),
      hooks: e.agent.hooks.childScope(),
    });

  try {
    if (schema) {
      const result = await runTypedChild(prompt, step.system ?? DEFAULT_CHILD_SYSTEM, schema, build, finalText);
      return { status: result.isError ? "error" : "done", output: result.content };
    }
    const { messages } = await build(step.system ?? DEFAULT_CHILD_SYSTEM).run(prompt);
    return { status: "done", output: finalText(messages) };
  } catch (err) {
    return { status: "error", output: errorText(err) };
  }
}

function renderResult(
  steps: WorkflowStep[],
  status: Map<string, StepStatus>,
  outputs: Record<string, string>,
): ToolResult {
  const lines = steps.map((s) => `[${s.id}] (${status.get(s.id) ?? "skipped"}): ${outputs[s.id] ?? ""}`);
  const details = steps.map((s) => ({
    id: s.id,
    type: s.type,
    status: status.get(s.id) ?? "skipped",
    output: outputs[s.id] ?? "",
  }));
  const anyBad = steps.some((s) => {
    const st = status.get(s.id);
    return st === "error" || st === "skipped" || st === undefined;
  });
  const header = anyBad ? "Workflow completed with failures:" : "Workflow completed:";
  const body = `${header}\n${lines.join("\n")}`;
  return anyBad ? fail(body, details) : ok(body, details);
}

/** A child's final answer = the last assistant message's concatenated text blocks. */
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
