/**
 * skills-hardening — four small, independently-killable guards over the skills
 * surface, each reusing an existing detector or mechanism rather than inventing
 * one. Skills are EAgent's most-trusted self-extension surface and the least
 * guarded; this closes four structural gaps without editing `integrity.ts` or
 * the tier-1 hook in `skills.ts`:
 *
 *   1. Supply-chain body/script scan (warn-only, + cross-session rug-pull
 *      fingerprint) — `session_start` sweeps each SKILL.md body and top-level
 *      sibling scripts using `mcp`'s `detectSuspiciousDescription` markers plus a
 *      small eval/exec/curl/env-near-network pattern set, and fingerprints bodies
 *      to surface a body that *changes* between sessions. Mirrors `integrity`'s
 *      baseline-in-store pattern; copies its 4-line djb2 hash locally because that
 *      hash is module-private to `integrity.ts` (its sole export is `activate`).
 *   2. Frontmatter validation surfacing — `/skills` reports validation findings
 *      (the `validateFrontmatter` rules live in `skills.ts`, shared with the
 *      authoring boundary where `skill_create` enforces them).
 *   3. allowed-tools scoping — while a skill read this session declares
 *      `allowed-tools`, a `beforeToolCall` hook asks/denies any tool outside the
 *      allowlist (no-op when unspecified — back-compat). Reuses the capability
 *      ask/deny vocabulary and the `write-guard` lifecycle.
 *   4. Trigger-gated tier-1 disclosure — an *own*, later `transformContext` pass
 *      that only narrows the skills-sourced catalog note: a skill declaring
 *      `triggers:` is kept only when a trigger word hits the latest user message
 *      (reusing `microagents`' whole-word `triggered`/`latestUserText`).
 *      `EAGENT_SKILL_TRIGGERS=off` reverts to always-on.
 *
 * Warn-only, no new capability; reuses `skill:read`/`skill:write`. Dispose loop
 * never throws.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "../kernel/extension.js";
import type { Message } from "../kernel/types.js";

import { detectSuspiciousDescription } from "./mcp.js";
import { latestUserText, triggered } from "./microagents.js";
import { parseFrontmatter, scanSkills, skillsRoot, validateFrontmatter } from "./skills.js";

/** Store key for the per-skill body fingerprint baseline. DISTINCT from
 *  `integrity`'s `descBaseline` so the two cannot collide. */
const BASELINE_KEY = "skillBodyBaseline";

/** Top-level sibling script extensions scanned beside SKILL.md (no recursion). */
const SCRIPT_EXTENSIONS = [".sh", ".js", ".py", ".ts"];

/**
 * A cheap, stable fingerprint of a string (change-detection only). A LOCAL copy
 * of `integrity.ts`'s 4-line djb2 hash — that function is module-private to
 * `integrity.ts`, so it is copied here rather than imported (avoids editing a
 * second file).
 */
function fingerprint(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Supply-chain markers in a skill body/script: the `mcp` poisoning markers PLUS a
 * small new set for `eval`, `child_process.exec`/`.exec(`, `curl … | sh`, and an
 * env-credential token near a network token. Warn-only and deliberately small —
 * false positives are acceptable (a skill that *teaches* curl trips it and still
 * loads), so the set stays a coarse heuristic, not a parser.
 */
const SUPPLY_CHAIN_PATTERNS: Array<[string, RegExp]> = [
  ["eval", /\beval\s*\(|\beval\s+\$\(/i],
  ["exec", /child_process|\.exec(?:Sync|File)?\s*\(/i],
  ["curl-pipe-sh", /\bcurl\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i],
];

/** Credential token (env/secret) and network token regexes for env-near-network. */
const CREDENTIAL_RE = /process\.env|API[_-]?KEY|AWS_SECRET|AWS_ACCESS_KEY|SECRET[_-]?KEY|\.env\b/i;
const NETWORK_RE = /\bfetch\s*\(|\bhttps?:\/\/|\baxios\b|\brequests?\.(?:get|post)\b|\bhttp\b/i;

/** All supply-chain markers in `text` (poisoning markers + the new pattern set). */
export function bodyMarkers(text: string): string[] {
  const markers = [...detectSuspiciousDescription(text)];
  for (const [name, re] of SUPPLY_CHAIN_PATTERNS) {
    if (re.test(text)) markers.push(name);
  }
  // env-near-network: a credential token AND a network token both present.
  if (CREDENTIAL_RE.test(text) && NETWORK_RE.test(text)) markers.push("env-near-network");
  return markers;
}

/** One supply-chain finding: which skill, where (body or a script path), markers. */
interface ScanFinding {
  skill: string;
  where: string;
  markers: string[];
}

/** Read a file's text, or undefined when unreadable (never throws). */
function readTextOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Top-level script files co-located with SKILL.md (no recursion). */
function siblingScripts(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    if (!SCRIPT_EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      // unstattable; skip
    }
  }
  return out;
}

export default function activate(e: ExtensionAPI): () => void {
  // -- Piece 1: supply-chain body/script scan + rug-pull fingerprint --------

  /** A skill scanned once: its name, description, dir, and SKILL.md body. */
  interface ScannedSkill {
    name: string;
    description: string;
    dir: string;
    body: string | undefined;
  }

  /** One pass over the skills root: scan + read each SKILL.md body exactly once. */
  const readSkills = (): ScannedSkill[] =>
    scanSkills(skillsRoot(e.config)).map((skill) => ({
      name: skill.name,
      description: skill.description,
      dir: skill.dir,
      body: readTextOrUndefined(join(skill.dir, "SKILL.md")),
    }));

  /** Sweep the given skills: scan each SKILL.md body and top-level sibling scripts. */
  const sweep = (scanned: ScannedSkill[]): ScanFinding[] => {
    const findings: ScanFinding[] = [];
    for (const skill of scanned) {
      if (skill.body !== undefined) {
        const markers = bodyMarkers(skill.body);
        if (markers.length > 0) findings.push({ skill: skill.name, where: "body", markers });
      }
      for (const scriptPath of siblingScripts(skill.dir)) {
        const text = readTextOrUndefined(scriptPath);
        if (text === undefined) continue;
        const markers = bodyMarkers(text);
        if (markers.length > 0) findings.push({ skill: skill.name, where: scriptPath, markers });
      }
    }
    return findings;
  };

  /** Skills whose SKILL.md body fingerprint differs from the recorded baseline. */
  const changedBodies = (scanned: ScannedSkill[]): string[] => {
    const baseline = e.store.get<Record<string, string>>(BASELINE_KEY, {}) ?? {};
    const out: string[] = [];
    for (const skill of scanned) {
      if (skill.body === undefined) continue;
      const prev = baseline[skill.name];
      if (prev !== undefined && prev !== fingerprint(skill.body)) out.push(skill.name);
    }
    return out;
  };

  /** Record the given skills' SKILL.md body fingerprints as the new baseline. */
  const recordBaseline = (scanned: ScannedSkill[]): void => {
    const fps: Record<string, string> = {};
    for (const skill of scanned) {
      if (skill.body !== undefined) fps[skill.name] = fingerprint(skill.body);
    }
    e.store.set(BASELINE_KEY, fps);
  };

  const offStart = e.on("session_start", () => {
    const scanned = readSkills(); // single pass shared by all three consumers below
    for (const f of sweep(scanned)) {
      e.log.warn(
        `skill "${f.skill}" has a suspicious ${f.where} (possible supply-chain poisoning: ${f.markers.join(", ")}); ` +
          `review it before trusting this skill.`,
      );
    }
    for (const name of changedBodies(scanned)) {
      e.log.warn(`skill "${name}" body changed since the last session; review the update for poisoning.`);
    }
    // Re-baseline after warning, so the next session compares against now.
    recordBaseline(scanned);
  });

  // -- Piece 2: frontmatter-validation surfacing on /skills -----------------
  // Shadows the `skills` /skills command: still lists every skill (back-compat),
  // and appends supply-chain + frontmatter-validation findings. Disposing this
  // registration restores the original `skills` /skills listing.

  const validationFindings = (scanned: ScannedSkill[]): string[] => {
    const out: string[] = [];
    for (const skill of scanned) {
      if (skill.body === undefined) continue;
      const errors = validateFrontmatter(parseFrontmatter(skill.body));
      if (errors.length > 0) out.push(`${skill.name}: invalid frontmatter — ${errors.join("; ")}`);
    }
    return out;
  };

  const offCmd = e.registerCommand({
    name: "skills",
    description: "List installed skills and surface frontmatter-validation / supply-chain findings.",
    run: (ctx) => {
      const scanned = readSkills(); // single pass shared by the listing + both finding sets
      ctx.print(
        scanned.length
          ? scanned.map((s) => `  ${s.name.padEnd(20)} ${s.description}`).join("\n")
          : `(no skills in ${skillsRoot(e.config)})`,
      );
      const findings = validationFindings(scanned);
      if (findings.length > 0) {
        ctx.print(`skills-hardening: ${findings.length} skill(s) with invalid frontmatter:`);
        for (const f of findings) ctx.print(`  ${f}`);
      }
      const scan = sweep(scanned);
      if (scan.length > 0) {
        ctx.print(`skills-hardening: ${scan.length} suspicious skill body/script(s):`);
        for (const f of scan) ctx.print(`  ${f.skill} (${f.where}) — ${f.markers.join(", ")}`);
      }
    },
  });

  // -- Piece 3: allowed-tools scoping --------------------------------------
  // Session-scoped: the set of allowlists declared by skills read this session.

  /** Per-skill allowlists recorded as each scoped skill is read this session. */
  const activeAllowlists = new Map<string, Set<string>>();

  /** Parse a comma-separated single-line list (like microagents' triggers). */
  const parseList = (raw: string | undefined): string[] =>
    (raw ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

  const offToolEnd = e.on("tool_end", ({ call, result }) => {
    if (result.isError) return;
    if (call.name !== "skill_read") return;
    const name = call.arguments.name;
    if (typeof name !== "string") return;
    const match = scanSkills(skillsRoot(e.config)).find((s) => s.name === name);
    if (!match) return;
    const body = readTextOrUndefined(join(match.dir, "SKILL.md"));
    if (body === undefined) return;
    const allowed = parseList(parseFrontmatter(body)["allowed-tools"]);
    if (allowed.length === 0) return; // no allowed-tools → record nothing (no-op)
    activeAllowlists.set(name, new Set(allowed));
  });

  const offBeforeTool = e.hook("beforeToolCall", async (decision, ctx) => {
    if (decision.block) return decision; // compose with upstream guards
    if (activeAllowlists.size === 0) return decision; // no active scoped skill → no-op
    const toolName = ctx.call.name;
    // skill_read / skill_create remain reachable so a skill can be loaded/authored.
    if (toolName === "skill_read" || toolName === "skill_create") return decision;
    let inSome = false;
    for (const allowed of activeAllowlists.values()) {
      if (allowed.has(toolName)) {
        inSome = true;
        break;
      }
    }
    if (inSome) return decision; // in at least one active allowlist → pass, no prompt

    const why = `"${toolName}" is not in the active skill's allowed-tools`;
    const allow = await e.agent.ui.confirm(`skills-hardening: allow ${why}?`);
    return allow ? decision : { ...decision, block: true, reason: `skills-hardening: blocked — ${why}` };
  });

  const resetScoping = () => activeAllowlists.clear();
  const offResetStart = e.on("session_start", resetScoping);
  const offShutdown = e.on("session_shutdown", resetScoping);

  // -- Piece 4: trigger-gated tier-1 disclosure ----------------------------
  // An OWN, later transformContext pass that only narrows the skills-sourced
  // catalog note. Never edits `skills.ts`'s hook.

  const offTransform = e.hook("transformContext", (messages) => {
    if (!e.config.enabled("skill-triggers", { default: true })) return messages; // kill switch: pass-through

    const idx = messages.findIndex(
      (m) =>
        m.role === "system" &&
        m.meta?.source === "skills" &&
        m.content.some((b) => b.type === "text" && b.text.includes("Available skills")),
    );
    if (idx === -1) return messages; // no skills note this turn → nothing to narrow

    const userText = latestUserText(messages);
    if (userText === undefined) return messages;

    // Resolve which skills declare triggers, and whether they fire.
    const triggersByName = new Map<string, string[]>();
    for (const skill of scanSkills(skillsRoot(e.config))) {
      const body = readTextOrUndefined(join(skill.dir, "SKILL.md"));
      if (body === undefined) continue;
      const trig = parseFrontmatter(body)["triggers"];
      if (trig === undefined) continue;
      const list = trig
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);
      if (list.length > 0) triggersByName.set(skill.name, list);
    }
    if (triggersByName.size === 0) return messages; // no triggered skills → nothing to gate

    const note = messages[idx]!;
    const textBlock = note.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return messages;

    const lines = textBlock.text.split("\n");
    let removedAny = false;
    const kept = lines.filter((line) => {
      // Catalog lines look like `- <name>: <description>`.
      const m = /^- ([^:]+):/.exec(line);
      if (!m) return true; // header / non-catalog line stays
      const name = m[1]!.trim();
      const trig = triggersByName.get(name);
      if (trig === undefined) return true; // trigger-less skill → always kept
      const keep = triggered(userText, trig);
      if (!keep) removedAny = true;
      return keep;
    });
    if (!removedAny) return messages; // nothing gated out → return input by reference

    // Did any catalog line survive? (A line beginning with "- ".)
    const hasCatalogLine = kept.some((l) => /^- [^:]+:/.test(l));
    const next = [...messages];
    if (!hasCatalogLine) {
      next.splice(idx, 1); // every skill gated out → drop the note entirely
      return next;
    }
    const rebuilt: Message = {
      ...note,
      content: note.content.map((b) =>
        b === textBlock && b.type === "text" ? { type: "text", text: kept.join("\n") } : b,
      ),
    };
    next[idx] = rebuilt;
    return next;
  });

  // -- Teardown (never throws) ---------------------------------------------

  return () => {
    for (const d of [offStart, offCmd, offToolEnd, offBeforeTool, offResetStart, offShutdown, offTransform]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
