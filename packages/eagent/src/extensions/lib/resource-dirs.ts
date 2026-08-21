/**
 * Shared layered-resource resolution for the `.md`-directory resource kinds
 * (templates/teams/skills/microagents). Mirrors how plugins and config already
 * read both `~/.eagent/<kind>` (home) and `<cwd>/.eagent/<kind>` (project),
 * merged by name with the project tier winning on a collision. The helper is
 * scan-agnostic: it resolves the dir list and merges results, delegating all
 * parsing/validation to a caller-supplied single-dir `scanOne` thunk.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../kernel/store.ts";

export type ResourceKind = "templates" | "teams" | "skills" | "microagents";

/**
 * The ordered dir list to read for a kind. When `<kind>.dir` is set the override
 * is single-source `[thatDir]`; otherwise the layered pair `[home, project]`
 * (home first so project overwrites on merge). Microagents' project root honors
 * `config.string("workspace")`; the others root at cwd.
 */
export function resourceDirs(config: Config, kind: ResourceKind): string[] {
  const override = config.string(`${kind}.dir`);
  if (override !== undefined) return [override];
  const homeRoot = join(homedir(), ".eagent", kind);
  const projectRoot = join(
    kind === "microagents" ? (config.string("workspace") ?? process.cwd()) : process.cwd(),
    ".eagent",
    kind,
  );
  return [homeRoot, projectRoot];
}

/**
 * Scan each dir with the single-dir `scanOne` primitive and merge results into a
 * Map keyed by resource `name`, inserting in dir order so a later dir (project)
 * overwrites an earlier one (home) — last-wins. Returns a name-sorted list.
 */
export function loadLayered<T extends { name: string }>(dirs: string[], scanOne: (dir: string) => T[]): T[] {
  const m = new Map<string, T>();
  for (const d of dirs) for (const r of scanOne(d)) m.set(r.name, r);
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}
