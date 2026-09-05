/**
 * The shape check both halves of the MCP boundary run, in one place.
 *
 * `mcp/tools.ts` opens with "FOREIGN CODE IS NOT TRUSTED TO DESCRIBE ITSELF. Everything a server
 * sends is re-validated here", and that was true of the tool NAME and of nothing else: a server
 * answering `{name:"search", description:{evil:"…"}, inputSchema:42}` had an OBJECT forwarded
 * where the type says string and the number 42 forwarded where a JSON Schema belongs, both into
 * the provider request the model reads, and `ToolRegistry.register`'s `checkManifest` accepted
 * both. A type annotation on `JSON.parse` output is a claim about bytes a third party wrote.
 *
 * NOT RE-EXPORTED BY `index.ts`, which re-exports `mcp/client.ts` and `mcp/tools.ts` by name, so
 * sharing this costs nothing on the pinned public surface. Same reason as `providers/usage.ts`.
 */

import type { McpToolSpec } from "./client.ts";

/**
 * How long a tool DESCRIPTION may be.
 *
 * A description is untrusted text that goes straight into the model's system-visible tool list —
 * the classic MCP tool-poisoning vector — and the model pays for every token of it. It is
 * refused rather than truncated: half a poisoned description is still a poisoned description,
 * and a tool the operator can see was refused is better than one that quietly says less than the
 * server wrote.
 */
export const MAX_DESCRIPTION_CHARS = 8_192;

/**
 * Why this entry is not a tool, or `undefined` if its shape is one.
 *
 * `name` is checked by the caller, which knows what to say about a nameless entry.
 */
export function specProblem(spec: McpToolSpec): string | undefined {
  if (spec.description !== undefined && typeof spec.description !== "string") {
    return `description is ${typeof spec.description}, not a string`;
  }
  if (typeof spec.description === "string" && spec.description.length > MAX_DESCRIPTION_CHARS) {
    return `description is ${String(spec.description.length)} characters, over the ${String(MAX_DESCRIPTION_CHARS)} allowed`;
  }
  if (spec.inputSchema !== undefined && (typeof spec.inputSchema !== "object" || spec.inputSchema === null || Array.isArray(spec.inputSchema))) {
    return `inputSchema is ${spec.inputSchema === null ? "null" : Array.isArray(spec.inputSchema) ? "an array" : typeof spec.inputSchema}, not a JSON Schema object`;
  }
  return undefined;
}

