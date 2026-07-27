/**
 * The exhaustive centralization invariant (design AC 8): after the migration,
 * NO in-boundary source may read or assign a `process.env.EAGENT_*` variable —
 * every knob flows through `e.config` / the host `LayeredConfig` — except a tiny,
 * explicit allowlist of two secrets and one transport fallback.
 *
 * This scans the source text directly with `node:fs` rather than shelling out to
 * `grep`, because macOS `grep` silently skips files containing non-ASCII glyphs
 * (`→`/`σ`/`≥`), which pervade this codebase — a grep-based guard would miss them.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

/** The in-boundary source roots (recursive) the scan covers. */
const ROOTS = [
  join(SRC, "extensions"),
  join(SRC, "providers"),
  join(SRC, "host.ts"),
  join(SRC, "server.ts"),
];

/**
 * The ONLY permitted `process.env.EAGENT_*` reads (a small allowlist), keyed by
 * file basename:
 *   - `memory.ts`      — the embed API key (a secret, never surfaced by /config).
 *   - `server.ts`      — the auth token (a secret) + optional web SPA root path.
 *   - `http.ts`        — the SSE cap, kept as the provider-without-host fallback.
 * Anything else is a violation. (config-cmd's own `EAGENT_CONFIG` kill switch is
 * resolved inside `LayeredConfig.enabled("config")`, not by a direct env read.)
 */
const READ_ALLOWLIST: Record<string, Set<string>> = {
  "memory.ts": new Set(["EAGENT_MEMORY_EMBED_API_KEY"]),
  "server.ts": new Set(["EAGENT_TOKEN", "EAGENT_WEB_ROOT"]),
  "http.ts": new Set(["EAGENT_MAX_SSE_EVENT_BYTES"]),
};

/** Recursively collect every `.ts` file under a file or directory path. */
function collectTs(path: string): string[] {
  const st = statSync(path);
  if (st.isFile()) return path.endsWith(".ts") ? [path] : [];
  const out: string[] = [];
  for (const entry of readdirSync(path)) out.push(...collectTs(join(path, entry)));
  return out;
}

const FILES = ROOTS.flatMap(collectTs);
// `process.env.EAGENT_X` optionally followed by `=` (an assignment, not `==`).
const REF = /process\.env\.(EAGENT_[A-Z0-9_]+)\s*(=(?!=))?/g;

test("no source assigns a process.env.EAGENT_* variable (AC 8a)", () => {
  const violations: string[] = [];
  for (const file of FILES) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(REF)) {
        if (m[2]) violations.push(`${file}:${i + 1}  ${m[1]} (assignment)`);
      }
    });
  }
  assert.deepEqual(violations, [], `unexpected process.env.EAGENT_* assignment(s):\n${violations.join("\n")}`);
});

test("no source reads process.env.EAGENT_* outside the allowlist (AC 8b)", () => {
  const violations: string[] = [];
  for (const file of FILES) {
    const base = basename(file);
    const allowed = READ_ALLOWLIST[base] ?? new Set<string>();
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(REF)) {
        if (m[2]) continue; // assignments are covered by the other test
        const name = m[1]!;
        if (!allowed.has(name)) violations.push(`${file}:${i + 1}  ${name}`);
      }
    });
  }
  assert.deepEqual(violations, [], `unexpected process.env.EAGENT_* read(s):\n${violations.join("\n")}`);
});

test("the scan actually covered the migrated surface (guards against a broken walker)", () => {
  assert.ok(FILES.length > 50, `expected to scan the full extension surface, saw ${FILES.length} files`);
  assert.ok(FILES.some((f) => basename(f) === "subagents.ts"), "extensions must be in scope");
  assert.ok(FILES.some((f) => basename(f) === "host.ts"), "host.ts must be in scope");
  assert.ok(FILES.some((f) => basename(f) === "server.ts"), "server.ts must be in scope");
  assert.ok(FILES.some((f) => basename(f) === "http.ts"), "providers must be in scope");
});
