/**
 * Turning what an MCP server claims into something Loom's oversight can reason about.
 *
 * `ToolDefinition` needs three things an MCP server does not provide and cannot be asked
 * for: `version`, `idempotent`, and `irreversibility`. The last is the one that matters,
 * because that class is the sole input to the default oversight posture (D7.6) — nothing else
 * sets a posture, so whatever sets the class sets the gate — and `tools/list` says nothing
 * about whether a tool reads a file or wires money.
 *
 * SO EVERY MCP TOOL IS `irreversible` UNLESS AN OPERATOR SAID OTHERWISE, AND THE DEFAULT GATES.
 *
 * That default is not conservatism for its own sake. The two ways to compute a class are worse
 * in a specific way: guessing from the tool's NAME is a heuristic a hostile server picks its
 * names to defeat, and reading a class the server ADVERTISES lets the party being governed
 * choose its own governance. `irreversible` is the honest answer to "we do not know", and the
 * whole oversight ladder is built so that "we do not know" resolves to asking a human.
 *
 * The consequence is worth stating plainly rather than discovering: an agent node that can
 * reach an MCP tool has a posture floor of `in`, so it cannot run one unattended. BOTH node
 * types are approvable — this used to say a graph wanting unattended MCP use had to put the
 * call on a `tool` node "rather than inside an agent turn", and that stopped being true: an
 * agent node now gates at the NODE, before the model runs, and carries the approval through the
 * turn. Neither runs an MCP tool without a human; both can be answered.
 *
 * THE ONE WAY THE DEFAULT MOVES IS A HUMAN TYPING IT, and `irreversibility` is a PARAMETER here
 * rather than anything this file can read off `client`. That placement is the guard: there is no
 * expression in this module that could reach `tools/list`'s reply and turn it into a class, so
 * the refusal above ("a self-declared class lets the party being governed choose its own
 * governance") is enforced by the absence of a path and not by a comment. The only caller that
 * passes a second argument is `cli.ts`'s registration loop, which gets it from `readMcpServers`,
 * which gets it from the file named on ARGV — the argument for why THAT is a human is written at
 * `MCP_SERVER_FIELDS`, because it is a decision about oversight and not about MCP.
 *
 * PER SERVER, NEVER PER TOOL, which is the same line `capabilities` already draws below: an
 * operator can decide "the docs server only reads", and cannot decide anything true about a list
 * of tool names the server rewrites between two `tools/list` calls.
 */

import { CODES, err } from "../errors.ts";
import type { JSONSchema } from "../schema.ts";
import type { ToolDefinition, ToolResult } from "../run/registry.ts";
import type { IrreversibilityClass } from "../vocab.ts";
import type { McpClient } from "./client.ts";
import { specProblem } from "./spec-shape.ts";

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
 *
 * `irreversibility` DEFAULTS RATHER THAN BEING REQUIRED, and the default is the strict one. A
 * caller that says nothing gets what every caller got before the parameter existed, so an
 * embedder who never updates their call site cannot be loosened by an upgrade.
 */
export function mcpTools(
  client: McpClient,
  irreversibility: IrreversibilityClass = "irreversible",
): readonly ToolDefinition[] {
  const seen = new Set<string>();
  return client.tools.map((spec): ToolDefinition => {
    // RE-CHECKED HERE TOO, and LOUDLY, which is the difference between this site and the client's.
    // `McpClient.start` DROPS a malformed entry, because one bad tool must not cost an operator
    // the rest of the server's. A spec that reaches this function malformed did not come through
    // that filter, so it came from a caller who built the client by hand — a programming error,
    // and the honest answer to a programming error is a typed refusal rather than a tool
    // registered with a non-string description sitting in the model's prompt.
    const bad = specProblem(spec);
    if (bad !== undefined) {
      throw err.validation(CODES.E_TOOL_SCHEMA_INVALID, `mcp server "${client.name}" tool "${spec.name}": ${bad}`, {
        details: { server: client.name, tool: spec.name },
      });
    }
    // A DUPLICATE NAME IS A REFUSAL AND NOT A SHADOW. `ToolRegistry.register` overwrites on
    // collision, so a second entry with the same name replaced the first AFTER the compiler had
    // read the manifest — the posture floor was computed over a definition that no longer
    // executes.
    if (seen.has(spec.name)) {
      throw err.validation(CODES.E_TOOL_SCHEMA_INVALID, `mcp server "${client.name}" offers "${spec.name}" twice`, {
        details: { server: client.name, tool: spec.name },
      });
    }
    seen.add(spec.name);
    const name = mcpToolName(client.name, spec.name);
    return {
      name,
      version: "1.0",
      // `??` and not `||`: an empty description is one the server chose. `null` is absent, and
      // `specProblem` has already accepted it as such.
      description: spec.description ?? `MCP tool "${spec.name}" from server "${client.name}".`,
      // One capability per SERVER, not per tool. An operator grants "this graph may use the
      // github server", which is a decision they can actually make; "this graph may use
      // github's create_issue" is a decision about a list they did not write and that the
      // server can change under them.
      capabilities: [`mcp:${client.name}`],
      irreversibility,
      // NOT DERIVED FROM THE CLASS, and `read_only` does not make it true. `idempotent` is a
      // claim about calling the same tool twice, which no `tools/list` entry makes and no
      // operator declaring a SERVER is in a position to make about tools they did not write.
      // `CLASS_AUTO_RETRYABLE` already lets a `read_only` tool be retried without this, so
      // leaving it false costs nothing an operator asked for.
      idempotent: false,
      // A server may advertise no schema at all. An empty object schema accepts anything,
      // which is honest: the server validates, and pretending to validate here would mean
      // rejecting calls the server would have accepted.
      parameters: (spec.inputSchema as JSONSchema | null | undefined) ?? { type: "object" },
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
