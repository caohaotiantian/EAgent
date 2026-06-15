/**
 * `defineTool` — a thin, typed constructor for tools.
 *
 * It exists only to make tool authoring pleasant: pass a spec and an execute
 * function and get back a well-formed `Tool`. No magic, no schema inference —
 * the JSON Schema stays explicit because it is what the model actually sees.
 */

import type { JSONSchema, Tool, ToolContext, ToolResult } from "./types.js";

export interface ToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters?: JSONSchema;
  executionMode?: "parallel" | "sequential";
  capabilities?: string[];
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

/**
 * Construct a well-formed `Tool`. The optional type parameter lets authors type
 * their `execute` arguments (the kernel still validates at runtime against the
 * JSON Schema); it is purely an authoring convenience and defaults to an open
 * record, so untyped usage keeps working unchanged.
 */
export function defineTool<TArgs extends Record<string, unknown> = Record<string, unknown>>(
  def: ToolDefinition<TArgs>,
): Tool {
  return {
    spec: {
      name: def.name,
      description: def.description,
      parameters: def.parameters ?? { type: "object", properties: {} },
    },
    executionMode: def.executionMode,
    capabilities: def.capabilities,
    execute: async (args, ctx) => def.execute(args as TArgs, ctx),
  };
}

/** Build a plain successful result from text. */
export function ok(content: string, details?: unknown): ToolResult {
  return { content, details };
}

/** Build an error result from text. */
export function fail(content: string, details?: unknown): ToolResult {
  return { content, isError: true, details };
}
