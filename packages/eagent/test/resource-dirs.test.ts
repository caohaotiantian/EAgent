/**
 * Protected invariant: the shared layered-resource helper resolves the ordered
 * dir list for a kind (home first, project last — or a single override dir) and
 * merges per-dir scan results by `name` with the LATER dir winning (project over
 * home) while unioning names and sorting stably. This is the foundation every
 * resource type (templates/teams/skills/microagents) delegates to, so pinning
 * last-wins + dir-resolution + override short-circuit here protects them all.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LayeredConfig } from "../src/config.ts";
import { MemoryStore } from "../src/kernel/store.ts";
import { loadLayered, resourceDirs } from "../src/extensions/lib/resource-dirs.ts";

function config(): LayeredConfig {
  return new LayeredConfig({ fileValues: {}, overrideStore: new MemoryStore() });
}

test("loadLayered merges by name, later dir wins, union'd and name-sorted", () => {
  type Row = { name: string; v?: number };
  const scanOne = (dir: string): Row[] =>
    dir === "a" ? [{ name: "x", v: 1 }] : [{ name: "x", v: 2 }, { name: "y" }];

  const out = loadLayered(["a", "b"], scanOne);

  assert.deepEqual(out.map((r) => r.name), ["x", "y"]); // union, name-sorted
  assert.equal(out.find((r) => r.name === "x")?.v, 2); // project (later dir "b") wins
});

test("resourceDirs default returns [home, project] (home first) for templates", () => {
  const prevHome = process.env.HOME;
  process.env.HOME = "/tmp/eagent-resource-dirs-home";
  try {
    const dirs = resourceDirs(config(), "templates");
    assert.deepEqual(dirs, [
      join(homedir(), ".eagent", "templates"),
      join(process.cwd(), ".eagent", "templates"),
    ]);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test("resourceDirs with <kind>.dir override is single-source", () => {
  const c = config();
  c.set("templates.dir", "/tmp/override-templates");
  assert.deepEqual(resourceDirs(c, "templates"), ["/tmp/override-templates"]);
});

test("resourceDirs microagents project root honors config workspace, else cwd", () => {
  const prevHome = process.env.HOME;
  process.env.HOME = "/tmp/eagent-resource-dirs-home";
  try {
    // No workspace override → project root is cwd.
    assert.deepEqual(resourceDirs(config(), "microagents"), [
      join(homedir(), ".eagent", "microagents"),
      join(process.cwd(), ".eagent", "microagents"),
    ]);

    // workspace override → project root is the workspace, not cwd.
    const c = config();
    c.set("workspace", "/tmp/eagent-workspace");
    assert.deepEqual(resourceDirs(c, "microagents"), [
      join(homedir(), ".eagent", "microagents"),
      join("/tmp/eagent-workspace", ".eagent", "microagents"),
    ]);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});
