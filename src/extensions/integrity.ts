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
 * It is a pure observer: it never blocks a tool, only surfaces what a human
 * should review before trusting. Keeping it an extension (not a kernel hook on
 * registration) is the point — tool integrity is policy, and policy lives out
 * here.
 */

import type { ExtensionAPI } from "../kernel/extension.js";
import { detectSuspiciousDescription } from "./mcp.js";

interface Finding {
  tool: string;
  markers: string[];
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

  const offStart = e.on("session_start", () => {
    for (const f of sweep()) {
      e.log.warn(
        `tool "${f.tool}" has a suspicious description (possible tool-poisoning: ${f.markers.join(", ")}); ` +
          `review it before trusting this tool.`,
      );
    }
  });

  const offCmd = e.registerCommand({
    name: "integrity",
    description: "Scan every registered tool's description for hidden-instruction / poisoning patterns.",
    run: (c) => {
      const findings = sweep();
      if (findings.length === 0) {
        c.print(`integrity: ${e.agent.tools.list().length} tool(s) scanned, none suspicious.`);
        return;
      }
      c.print(`integrity: ${findings.length} suspicious tool description(s):`);
      for (const f of findings) c.print(`  ${f.tool} — ${f.markers.join(", ")}`);
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
