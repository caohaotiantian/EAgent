/**
 * integrity — tool-description hygiene across *every* tool source.
 *
 * The `mcp` extension scans descriptions of tools it registers for poisoning
 * (hidden instructions that ride into the model's context). But MCP is not the
 * only foreign-code path: `packages` installs third-party extensions, and a
 * self-authored extension can register tools too. This extension closes that
 * gap with one sweep over the *whole* tool registry — reusing the same detector
 * — run on every `session_start` (warn) and on demand via `/integrity`.
 *
 * It also detects a *rug pull*: a tool whose description was benign when the
 * operator approved it but changes on a later update/reconnect (the silent
 * swap behind real supply-chain poisoning). A per-tool description fingerprint
 * is persisted in the extension store; on `session_start` a changed description
 * is warned and the baseline is re-recorded, and `/integrity` reports current
 * drift on demand.
 *
 * It is a pure observer: it never blocks a tool, only surfaces what a human
 * should review before trusting. Keeping it an extension (not a kernel hook on
 * registration) is the point — tool integrity is policy, and policy lives out
 * here.
 */

import type { ExtensionAPI } from "../kernel/extension.ts";
import { detectSuspiciousDescription } from "./mcp.ts";

/** Store key for the per-tool description fingerprint baseline. */
const BASELINE_KEY = "descBaseline";

interface Finding {
  tool: string;
  markers: string[];
}

/** A cheap, stable fingerprint of a description string (change-detection only). */
function fingerprint(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export default function activate(e: ExtensionAPI): () => void {
  /** Scan every registered tool's description for poisoning markers. */
  const sweep = (): Finding[] => {
    const findings: Finding[] = [];
    for (const tool of e.agent.tools.list()) {
      const markers = detectSuspiciousDescription(tool.spec.description);
      if (markers.length > 0) findings.push({ tool: tool.spec.name, markers });
    }
    return findings;
  };

  /** Tools whose current description differs from the recorded baseline. */
  const changedTools = (): string[] => {
    const baseline = e.store.get<Record<string, string>>(BASELINE_KEY, {}) ?? {};
    const out: string[] = [];
    for (const tool of e.agent.tools.list()) {
      const prev = baseline[tool.spec.name];
      if (prev !== undefined && prev !== fingerprint(tool.spec.description)) out.push(tool.spec.name);
    }
    return out;
  };

  /** Record the current description fingerprints as the new baseline. */
  const recordBaseline = (): void => {
    const fps: Record<string, string> = {};
    for (const tool of e.agent.tools.list()) fps[tool.spec.name] = fingerprint(tool.spec.description);
    e.store.set(BASELINE_KEY, fps);
  };

  const offStart = e.on("session_start", () => {
    for (const f of sweep()) {
      e.log.warn(
        `tool "${f.tool}" has a suspicious description (possible tool-poisoning: ${f.markers.join(", ")}); ` +
          `review it before trusting this tool.`,
      );
    }
    for (const tool of changedTools()) {
      e.log.warn(`tool "${tool}" description changed since the last session; review the update for poisoning.`);
    }
    // Re-baseline after warning, so the next session compares against now.
    recordBaseline();
  });

  const offCmd = e.registerCommand({
    name: "integrity",
    description:
      "Scan every registered tool's description for hidden-instruction / poisoning patterns, and report descriptions changed since the last session.",
    run: (c) => {
      const findings = sweep();
      const changed = changedTools();
      if (findings.length === 0 && changed.length === 0) {
        c.print(`integrity: ${e.agent.tools.list().length} tool(s) scanned; none suspicious, no description changes.`);
        return;
      }
      if (findings.length > 0) {
        c.print(`integrity: ${findings.length} suspicious tool description(s):`);
        for (const f of findings) c.print(`  ${f.tool} — ${f.markers.join(", ")}`);
      }
      if (changed.length > 0) {
        c.print(`integrity: ${changed.length} tool description(s) changed since last session:`);
        for (const tool of changed) c.print(`  ${tool} — description changed`);
      }
    },
  });

  return () => {
    for (const d of [offStart, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
