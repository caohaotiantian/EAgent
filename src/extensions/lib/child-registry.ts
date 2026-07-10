/**
 * The shared, capability-based child tool-registry filter — the single source of
 * truth for the sub-agent recursion guard.
 *
 * Every spawner must prevent a child from recursively spawning grandchildren (a
 * runaway agent tree). The accurate, authoritative marker of a spawner is a
 * *capability* the kernel reads at dispatch (`agent:spawn`/`workflow:run`), not a
 * tool name — so this helper strips every parent tool whose declared
 * `capabilities` intersect `SPAWN_CAPS`, covering every current and future spawner
 * by shape (a per-site name list drifts and is exactly what left four sites
 * leaky). It mirrors the already-correct `teams`/`subagent-jobs` pattern and is
 * reused by `subagents`, `templates`, `reasoning-search`, and `dynamic-workflow`.
 *
 * Pure: kernel types + Node only, no `ExtensionAPI`.
 */

import { ToolRegistry } from "../../kernel/registry.js";
import type { Tool } from "../../kernel/types.js";

/**
 * The spawn-class capability set — the exhaustive marker of a child-spawning tool.
 * A tool declaring ANY of these is stripped from a child's registry. This is the
 * single definition; `teams.ts` re-exports it for back-compat.
 */
export const SPAWN_CAPS = ["agent:spawn", "workflow:run"] as const;

/**
 * Copy a parent's active tools into a fresh registry, dropping every tool whose
 * declared `capabilities` intersect `SPAWN_CAPS` (so a child inherits no spawner
 * and cannot spawn a grandchild) and — when `opts.allowlist` is given — keeping
 * only tools whose `spec.name` is on it. A fresh per-child registry also keeps a
 * child's own registrations from leaking to the parent or its siblings.
 */
export function childRegistryFrom(parentTools: Tool[], opts?: { allowlist?: string[] }): ToolRegistry {
  const registry = new ToolRegistry();
  const spawnCaps = SPAWN_CAPS as readonly string[];
  const allowlist = opts?.allowlist;
  for (const tool of parentTools) {
    if (tool.capabilities?.some((c) => spawnCaps.includes(c))) continue;
    if (allowlist && !allowlist.includes(tool.spec.name)) continue;
    registry.register(tool);
  }
  return registry;
}
