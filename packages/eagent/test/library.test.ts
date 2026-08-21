import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Command } from "../src/kernel/commands.ts";
import { layeredTemplates } from "../src/extensions/templates.ts";
import { makeHarness, type Harness } from "./helpers.ts";
import activate from "../src/extensions/library.ts";

/**
 * Build an isolated world: a temp `library.dir` source tree, a temp HOME (the
 * home resource tier) and a temp project cwd (the project tier). The library and
 * workspace are config keys (set via `setPreset`, race-free); HOME and cwd are
 * process-global state the layered reader consults live, so they are mutated and
 * restored in `cleanup()`. Returns a `run(name, args)` that invokes a registered
 * command and collects its printed lines.
 */
async function world(
  opts: Parameters<typeof makeHarness>[0] = {},
): Promise<
  Harness & {
    src: string;
    home: string;
    project: string;
    run: (name: string, args: string) => Promise<string[]>;
    cleanup: () => void;
  }
> {
  const base = mkdtempSync(join(tmpdir(), "eagent-library-"));
  const src = join(base, "library");
  const home = join(base, "home");
  const project = join(base, "project");

  // A minimal official-library source: a flat-file kind (templates) and a
  // directory-bundle kind (skills) to prove cpSync handles both.
  mkdirSync(join(src, "templates"), { recursive: true });
  writeFileSync(join(src, "templates", "foo.md"), "---\nname: foo\ndescription: a foo\n---\nbody\n");
  mkdirSync(join(src, "skills", "demo-skill"), { recursive: true });
  writeFileSync(join(src, "skills", "demo-skill", "SKILL.md"), "# demo skill\n");
  mkdirSync(join(src, "teams"), { recursive: true });
  writeFileSync(join(src, "teams", "t.md"), "---\nname: t\ndescription: a team\n---\n");
  mkdirSync(join(src, "microagents"), { recursive: true });
  writeFileSync(join(src, "microagents", "m.md"), "microagent\n");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });

  const h = makeHarness(opts);
  h.config.setPreset({ "library.dir": src });

  const savedHome = process.env.HOME;
  const savedCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(project);

  await h.host.use("library", (e) => activate(e));

  const run = async (name: string, args: string): Promise<string[]> => {
    const lines: string[] = [];
    const cmd = h.commands.get(name) as Command;
    await cmd.run({ agent: h.agent, args, print: (l) => lines.push(l) });
    return lines;
  };

  const cleanup = (): void => {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(base, { recursive: true, force: true });
  };

  return { ...h, src, home, project, run, cleanup };
}

test("AC3: install --project copies into the project tier and loads via the layered read", async () => {
  const w = await world();
  try {
    const out = await w.run("library", "install --project templates");
    // The file landed in the project tier (<cwd>/.eagent/templates).
    assert.ok(
      existsSync(join(w.project, ".eagent", "templates", "foo.md")),
      "foo.md copied into the project tier",
    );
    assert.match(out.join("\n"), /templates.*copied 1/, "reports one copied");
    // It loads via the exact layered read `/template list` uses (layeredTemplates
    // reads resourceDirs(config, "templates") = [home, project]).
    const found = layeredTemplates(w.config, () => {});
    assert.ok(
      found.some((t) => t.name === "foo"),
      "the copied template is visible to the layered template read",
    );
  } finally {
    w.cleanup();
  }
});

test("AC3 (derivation): install --project microagents targets the workspace root, not cwd", async () => {
  const w = await world();
  try {
    // resourceDirs roots microagents' project tier at config `workspace`, not cwd.
    const ws = join(w.project, "..", "workspace-alt");
    mkdirSync(ws, { recursive: true });
    w.config.setPreset({ "library.dir": w.src, workspace: ws });

    await w.run("library", "install --project microagents");

    assert.ok(
      existsSync(join(ws, ".eagent", "microagents", "m.md")),
      "microagents installed under <workspace>/.eagent/microagents (derived, not cwd)",
    );
    assert.ok(
      !existsSync(join(w.project, ".eagent", "microagents", "m.md")),
      "not written under cwd",
    );
  } finally {
    w.cleanup();
  }
});

test("AC3 (skills bundle): install --project skills copies the whole directory", async () => {
  const w = await world();
  try {
    await w.run("library", "install --project skills");
    assert.ok(
      existsSync(join(w.project, ".eagent", "skills", "demo-skill", "SKILL.md")),
      "the skill bundle directory was copied recursively",
    );
  } finally {
    w.cleanup();
  }
});

test("AC4: an existing same-named resource is never clobbered (skip-existing + report)", async () => {
  const w = await world();
  try {
    const dst = join(w.project, ".eagent", "templates", "foo.md");
    mkdirSync(join(w.project, ".eagent", "templates"), { recursive: true });
    writeFileSync(dst, "USER EDIT — keep me\n");

    const out = await w.run("library", "install --project templates");

    assert.equal(readFileSync(dst, "utf8"), "USER EDIT — keep me\n", "user's file is untouched");
    assert.match(out.join("\n"), /skipped \(exists\) 1/, "reports it skipped");
    assert.match(out.join("\n"), /copied 0/, "nothing copied");
  } finally {
    w.cleanup();
  }
});

test("AC5: install --home targets the home tier", async () => {
  const w = await world();
  try {
    await w.run("library", "install --home templates");
    assert.ok(
      existsSync(join(w.home, ".eagent", "templates", "foo.md")),
      "foo.md copied into the home tier (~/.eagent/templates)",
    );
    assert.ok(
      !existsSync(join(w.project, ".eagent", "templates", "foo.md")),
      "not written into the project tier",
    );
  } finally {
    w.cleanup();
  }
});

test("AC6 (list): /library list enumerates kinds and counts", async () => {
  const w = await world();
  try {
    const out = (await w.run("library", "list")).join("\n");
    assert.match(out, /templates\s+1/, "lists templates count");
    assert.match(out, /skills\s+1/, "lists skills count");
    assert.match(out, /microagents\s+1/, "lists microagents count");
  } finally {
    w.cleanup();
  }
});

test("AC6 (kill switch): EAGENT_LIBRARY=off makes /library inert", async () => {
  const saved = process.env.EAGENT_LIBRARY;
  process.env.EAGENT_LIBRARY = "off";
  try {
    const w = await world();
    try {
      const out = (await w.run("library", "install --project templates")).join("\n");
      assert.match(out, /disabled/, "prints a disabled note");
      assert.ok(
        !existsSync(join(w.project, ".eagent", "templates", "foo.md")),
        "writes nothing when disabled",
      );
    } finally {
      w.cleanup();
    }
  } finally {
    if (saved === undefined) delete process.env.EAGENT_LIBRARY;
    else process.env.EAGENT_LIBRARY = saved;
  }
});

test("install defaults to all kinds; an unknown kind is rejected without writing", async () => {
  const w = await world();
  try {
    // Default (no kind args) installs every kind.
    const out = (await w.run("library", "install --project")).join("\n");
    for (const kind of ["templates", "teams", "skills", "microagents"]) {
      assert.match(out, new RegExp(`${kind}\\s+copied`), `${kind} was installed`);
    }
    assert.ok(existsSync(join(w.project, ".eagent", "templates", "foo.md")), "templates copied");
    assert.ok(existsSync(join(w.project, ".eagent", "teams", "t.md")), "teams copied");
    assert.ok(
      existsSync(join(w.project, ".eagent", "skills", "demo-skill", "SKILL.md")),
      "skill bundle copied",
    );

    // An unknown kind is rejected cleanly, writing nothing.
    const bad = (await w.run("library", "install --project bogus")).join("\n");
    assert.match(bad, /unknown kind/, "rejects an unknown kind");
    assert.ok(!existsSync(join(w.project, ".eagent", "bogus")), "no bogus dir written");
  } finally {
    w.cleanup();
  }
});

test("AC6 (capability): a deny-fallback manager blocks the install (fs:write required)", async () => {
  // library.ts deliberately does NOT grant fs:write, so under a deny fallback the
  // per-call `capabilities.require("fs:write", "library")` throws CapabilityError.
  const w = await world({ fallback: "deny" });
  try {
    const out = (await w.run("library", "install --project templates")).join("\n");
    assert.match(out, /Cannot install:/, "the capability denial is surfaced");
    assert.ok(
      !existsSync(join(w.project, ".eagent", "templates", "foo.md")),
      "nothing is written when the capability is denied",
    );
  } finally {
    w.cleanup();
  }
});
