/**
 * Tests for the `packages` extension package manager.
 *
 * Only the offline `path:` install flow is exercised here. The `git:` and
 * `npm:` source kinds shell out to real `git`/`npm` and need network access,
 * so they are not tested — they are covered structurally by `materialize` in
 * the implementation. We verify capability gating, registration, persistence
 * in the store, disposal via `/pkg-remove`, and error handling.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import activate from "../src/extensions/packages.ts";
import { makeHarness } from "./helpers.js";

const DEFINE_PATH = JSON.stringify(join(process.cwd(), "src/kernel/define.ts"));

/** A temp extension whose activate registers a `pkg_tool` tool. */
const SAMPLE_EXTENSION = `
import { defineTool, ok } from ${DEFINE_PATH};
export default function activate(e) {
  return e.registerTool(
    defineTool({
      name: "pkg_tool",
      description: "a tool contributed by an installed package",
      execute: () => ok("hello from pkg_tool"),
    }),
  );
}
`;

const tempDirs: string[] = [];

/** Materialize SAMPLE_EXTENSION at a deterministic basename and return its path. */
function writeSampleExtension(fileBase = "sample-pkg.ts"): string {
  const dir = mkdtempSync(join(tmpdir(), "eagent-pkg-"));
  tempDirs.push(dir);
  const file = join(dir, fileBase);
  writeFileSync(file, SAMPLE_EXTENSION, "utf8");
  return file;
}

after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** Run a registered command, collecting its printed output. */
async function runCommand(
  h: ReturnType<typeof makeHarness>,
  name: string,
  args: string,
): Promise<string[]> {
  const out: string[] = [];
  const cmd = h.commands.get(name);
  assert.ok(cmd, `command ${name} should be registered`);
  await cmd.run({ agent: h.agent, args, print: (l) => out.push(l) });
  return out;
}

test("pkg-add installs a path: extension and registers its tool; pkg-list shows it", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("packages", activate);

  const file = writeSampleExtension();
  const addOut = await runCommand(h, "pkg-add", `path:${file}`);

  assert.ok(h.agent.tools.has("pkg_tool"), "pkg_tool should be registered on the agent");
  assert.ok(
    addOut.some((l) => l.includes("installed")),
    `expected an install confirmation, got: ${addOut.join(" | ")}`,
  );

  const listOut = await runCommand(h, "pkg-list", "");
  assert.ok(
    listOut.some((l) => l.includes("sample-pkg")),
    `pkg-list should mention the installed package, got: ${listOut.join(" | ")}`,
  );
});

test("pkg-remove disposes the installed package's registrations", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("packages", activate);

  const file = writeSampleExtension();
  await runCommand(h, "pkg-add", `path:${file}`);
  assert.ok(h.agent.tools.has("pkg_tool"), "precondition: tool registered");

  // id is derived from the entry file basename sans extension.
  const removeOut = await runCommand(h, "pkg-remove", "sample-pkg");

  assert.ok(!h.agent.tools.has("pkg_tool"), "pkg_tool should be gone after removal");
  assert.ok(
    removeOut.some((l) => l.includes("removed")),
    `expected removal confirmation, got: ${removeOut.join(" | ")}`,
  );

  const listOut = await runCommand(h, "pkg-list", "");
  assert.ok(
    listOut.some((l) => l.includes("no packages installed")),
    `registry should be empty after removal, got: ${listOut.join(" | ")}`,
  );
});

test("pkg-add is refused without the pkg:install capability (fallback deny)", async () => {
  const h = makeHarness({ fallback: "deny" });
  await h.host.use("packages", activate);

  const file = writeSampleExtension("denied-pkg.ts");
  const out = await runCommand(h, "pkg-add", `path:${file}`);

  assert.ok(!h.agent.tools.has("pkg_tool"), "tool must NOT be registered when denied");
  assert.ok(
    out.some((l) => /refus|denied/i.test(l)),
    `expected a denial message, got: ${out.join(" | ")}`,
  );
});

test("pkg-add reports a clear error for a missing source and does not throw", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("packages", activate);

  let out: string[] = [];
  await assert.doesNotReject(async () => {
    out = await runCommand(h, "pkg-add", "path:/no/such/file.ts");
  });

  assert.ok(
    out.some((l) => /error|no such/i.test(l)),
    `expected an error message, got: ${out.join(" | ")}`,
  );
  assert.ok(!h.agent.tools.has("pkg_tool"), "no tool should be registered on failure");
});
