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
 * How long a tool DESCRIPTION may be, and how long a NAME and a SCHEMA may be.
 *
 * A description is untrusted text that goes straight into the model's system-visible tool list —
 * the classic MCP tool-poisoning vector — and the model pays for every token of it. So do the
 * NAME and the input SCHEMA, which the first version of this bounded neither: a 200,000-character
 * tool name and a 200,071-byte `inputSchema` carrying its poison in a property's own
 * `description` both reached the provider request untouched, and `ToolRegistry.register`'s
 * `checkManifest` only asks that a name be a non-empty string.
 *
 * REFUSED RATHER THAN TRUNCATED: half a poisoned description is still a poisoned description, and
 * a tool an operator can see was refused is better than one that quietly says less than the
 * server wrote. The units are UTF-16 code units, which is what a JS string is measured in and
 * what a length in a refusal message therefore has to mean.
 */
export const MAX_DESCRIPTION_CHARS = 8_192;
export const MAX_NAME_CHARS = 128;
export const MAX_SCHEMA_CHARS = 65_536;

/**
 * Why this entry is not a tool, or `undefined` if its shape is one.
 *
 * `name` is checked for presence by the caller, which knows what to say about a nameless entry.
 *
 * `null` IS ABSENT, for both optional fields. Treating it as a bad type dropped tools from servers
 * that spell "no description" as `description: null`, which is ordinary JSON and was fine at
 * 95a3dde — and the refusal message said "description is object", which is true of `typeof null`
 * and useless to whoever has to act on it.
 */
export function specProblem(spec: McpToolSpec): string | undefined {
  if (spec.name.length > MAX_NAME_CHARS) {
    return `name is ${String(spec.name.length)} characters, over the ${String(MAX_NAME_CHARS)} allowed`;
  }
  if (spec.description !== undefined && spec.description !== null && typeof spec.description !== "string") {
    return `description is ${typeof spec.description}, not a string`;
  }
  if (typeof spec.description === "string" && spec.description.length > MAX_DESCRIPTION_CHARS) {
    return `description is ${String(spec.description.length)} characters, over the ${String(MAX_DESCRIPTION_CHARS)} allowed`;
  }
  const schema = spec.inputSchema;
  if (schema !== undefined && schema !== null) {
    if (typeof schema !== "object" || Array.isArray(schema)) {
      return `inputSchema is ${Array.isArray(schema) ? "an array" : typeof schema}, not a JSON Schema object`;
    }
    // Serialised, because that is the form it reaches the provider request in and the form the
    // model is charged for. A schema that cannot be serialised at all is not one.
    let size: number;
    try {
      size = JSON.stringify(schema)?.length ?? 0;
    } catch {
      return "inputSchema is not serialisable JSON";
    }
    if (size > MAX_SCHEMA_CHARS) {
      return `inputSchema is ${String(size)} characters of JSON, over the ${String(MAX_SCHEMA_CHARS)} allowed`;
    }
  }
  return undefined;
}
