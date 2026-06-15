/**
 * `defineTool` — a thin, typed constructor for tools.
 *
 * It exists only to make tool authoring pleasant: pass a spec and an execute
 * function and get back a well-formed `Tool`. No magic, no schema inference —
 * the JSON Schema stays explicit because it is what the model actually sees.
 */

import type { JSONSchema, Tool, ToolContext, ToolResult } from "./types.js";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: JSONSchema;
  executionMode?: "parallel" | "sequential";
  capabilities?: string[];
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

export function defineTool(def: ToolDefinition): Tool {
  return {
    spec: {
      name: def.name,
      description: def.description,
      parameters: def.parameters ?? { type: "object", properties: {} },
    },
    executionMode: def.executionMode,
    capabilities: def.capabilities,
    execute: async (args, ctx) => def.execute(args, ctx),
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
