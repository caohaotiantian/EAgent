/**
 * Turning what an MCP server claims into something Loom's oversight can reason about.
 *
 * `ToolDefinition` needs three things an MCP server does not provide and cannot be asked
 * for: `version`, `idempotent`, and `irreversibility`. The last is the one that matters,
 * because that class — not a config file — decides the default oversight posture (D7.6), and
 * `tools/list` says nothing about whether a tool reads a file or wires money.
 *
 * SO EVERY MCP TOOL IS `irreversible`, WHICH MEANS EVERY MCP TOOL GATES.
 *
 * That is not conservatism for its own sake. The alternatives are worse in a specific way:
 * guessing from the tool's NAME is a heuristic a hostile server picks its names to defeat,
 * and trusting a self-declared class lets the party being governed choose its own governance.
 * `irreversible` is the honest answer to "we do not know", and the whole oversight ladder is
 * built so that "we do not know" resolves to asking a human.
 *
 * The consequence is worth stating plainly rather than discovering: an agent node that can
 * reach an MCP tool has a posture floor of `in`, so it cannot run one unattended. A graph
 * that wants unattended MCP use puts the call on a `tool` node — which CAN suspend and be
 * approved — rather than inside an agent turn. An operator who knows a particular server is
 * read-only can say so by declaring the manifest themselves; there is deliberately no flag
 * that says "trust every server".
 */

import { CODES, err } from "../errors.ts";
import type { JSONSchema } from "../schema.ts";
import type { ToolDefinition, ToolResult } from "../run/registry.ts";
import type { McpClient } from "./client.ts";

/**
 * `mcp__<server>__<tool>` — flat, and collision-proof across servers.
 *
 * Two servers offering `search` is the ordinary case, not the exotic one, and a registry
 * keyed by bare name would have the second silently shadow the first. The separator is `__`
 * because a server name is author-chosen and may contain `.` or `-`.
 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** What an MCP `tools/call` returns, as far as this code is willing to assume. */
interface McpCallResult {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly isError?: boolean;
}

/**
 * Flatten an MCP result into the string a model reads.
 *
 * Non-text parts (images, embedded resources) are named rather than dropped silently: a
 * model told nothing came back reasons differently from one told an image came back that it
 * cannot see. `DEFERRED: multi-modal tool results`.
 */
function renderContent(result: McpCallResult): string {
  const parts = Array.isArray(result.content) ? result.content : [];
  if (parts.length === 0) return "(no content)";
  return parts
    .map((p) => (typeof p.text === "string" ? p.text : `[${p.type ?? "unknown"} part, not rendered]`))
    .join("\n");
}

/**
 * Every tool a connected client offers, as Loom tool definitions.
 *
 * Call this BEFORE compiling a graph. The posture floor of an agent node is a `max` over
 * `reachableToolNames`, computed at compile time — so a tool registered after the compile is
 * a tool the floor never saw, which is invariant 5 defeated by ordering rather than by
 * argument. `ToolRegistry.seal()` exists to make that ordering enforceable.
 */
export function mcpTools(client: McpClient): readonly ToolDefinition[] {
  return client.tools.map((spec): ToolDefinition => {
    const name = mcpToolName(client.name, spec.name);
    return {
      name,
      version: "1.0",
      description: spec.description ?? `MCP tool "${spec.name}" from server "${client.name}".`,
      // One capability per SERVER, not per tool. An operator grants "this graph may use the
      // github server", which is a decision they can actually make; "this graph may use
      // github's create_issue" is a decision about a list they did not write and that the
      // server can change under them.
      capabilities: [`mcp:${client.name}`],
      irreversibility: "irreversible",
      idempotent: false,
      // A server may advertise no schema at all. An empty object schema accepts anything,
      // which is honest: the server validates, and pretending to validate here would mean
      // rejecting calls the server would have accepted.
      parameters: (spec.inputSchema as JSONSchema | undefined) ?? { type: "object" },
      execute: async (args): Promise<ToolResult> => {
        let raw: unknown;
        try {
          raw = await client.request("tools/call", { name: spec.name, arguments: args });
        } catch (e) {
          // The transport already raises typed LoomErrors with a retryable class; letting
          // them through preserves that, and the engine's retry policy is what decides.
          throw e instanceof Error ? e : err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, String(e));
        }
        const result = (typeof raw === "object" && raw !== null ? raw : {}) as McpCallResult;
        return {
          content: renderContent(result),
          // The server's own verdict on its own call. It is a claim like everything else it
          // sends, but it is the only verdict available and it costs nothing to relay.
          ...(result.isError === true ? { isError: true } : {}),
          details: { server: client.name, tool: spec.name },
        };
      },
    };
  });
}
