/**
 * Console auto-complete: the pure `complete(line, ctx)` transform across its
 * three domains (command name / argument / path). Every case asserts the named
 * business invariant, not just the tuple shape. The directory reader and
 * `homedir` are injected, so the suite stays offline and deterministic over a
 * fixed fake tree — no real filesystem state is touched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { complete, type CompleterContext, type DirEntry } from "../src/complete.js";
import { PROVIDER_NAMES } from "../src/host.js";

// A synthetic command name not among the host built-ins, proving AC-2: names
// come from the live registry rather than a hardcoded list.
const COMMAND_NAMES = ["help", "reload", "provider", "model", "clear", "frobnicate"];
const EXTENSION_IDS = ["memory", "mcp"];

// A fixed fake tree keyed by the directory path passed to readDir.
const TREE: Record<string, readonly DirEntry[]> = {
  "src": [
    { name: "cli.ts", isDirectory: false },
    { name: "providers", isDirectory: true },
  ],
  ".": [
    { name: ".env", isDirectory: false },
    { name: "notes.txt", isDirectory: false },
  ],
  "/": [{ name: "Users", isDirectory: true }],
};

interface Probe {
  ctx: CompleterContext;
  /** How many times readDir was invoked since construction. */
  calls: () => number;
}

/** Build a call-counting context over the fixed fake tree. */
function makeProbe(overrides: Partial<CompleterContext> = {}): Probe {
  let count = 0;
  const ctx: CompleterContext = {
    commandNames: () => COMMAND_NAMES,
    extensionIds: () => EXTENSION_IDS,
    providerNames: PROVIDER_NAMES,
    readDir: (dir) => {
      count++;
      const entries = TREE[dir];
      if (entries === undefined) throw new Error(`ENOENT: ${dir}`);
      return entries;
    },
    homedir: () => "/home/test",
    ...overrides,
  };
  return { ctx, calls: () => count };
}

test("AC-1: command-name completion offers the registry's /-prefixed names by prefix", () => {
  const { ctx } = makeProbe();

  assert.deepEqual(complete("/pro", ctx), [["/provider"], "/pro"]);

  const [matches, sub] = complete("/", ctx);
  assert.equal(sub, "/");
  assert.deepEqual(
    matches,
    COMMAND_NAMES.map((n) => `/${n}`),
    "every registered command name is offered, each leading with /",
  );
});

test("AC-2: command-name completion reflects the live registry, not a hardcoded list", () => {
  const { ctx } = makeProbe();
  const [matches] = complete("/", ctx);
  assert.ok(matches.includes("/frobnicate"), "a synthetic registry-only command must appear");
});

test("AC-3: provider-arg completion is the canonical PROVIDER_NAMES set", () => {
  const { ctx } = makeProbe();

  assert.deepEqual(complete("/provider an", ctx), [["anthropic"], "an"]);

  const [matches, sub] = complete("/provider ", ctx);
  assert.equal(sub, "");
  assert.deepEqual(matches, [...PROVIDER_NAMES], "the empty fragment offers exactly the canonical set");
});

test("AC-4: reload-arg completion is the live extension ids; empty fragment offers the full set", () => {
  const { ctx } = makeProbe();

  assert.deepEqual(complete("/reload mem", ctx), [["memory"], "mem"]);

  const [matches, sub] = complete("/reload ", ctx);
  assert.equal(sub, "");
  assert.deepEqual(matches, ["memory", "mcp"], "the empty fragment offers every live extension id");
});

test("AC-5: a command with no enumerable arg set yields no matches (silent no-op)", () => {
  const { ctx } = makeProbe();

  assert.deepEqual(complete("/model gpt", ctx), [[], "gpt"]);

  const [matches] = complete("/help any", ctx);
  assert.deepEqual(matches, [], "an unenumerable-arg command never offers matches");
});

test("AC-6: path completion fires only on path-like tokens, with dir/dotfile rules", () => {
  // Path-like token mid-line completes against the read directory.
  assert.deepEqual(complete("explain the src/cl", makeProbe().ctx), [["src/cli.ts"], "src/cl"]);

  // A bare prose token (no separator) is not path-like => no matches.
  assert.deepEqual(complete("explain the bug", makeProbe().ctx)[0], []);

  // A directory entry gets a trailing slash; a file does not.
  const [lsMatches] = complete("ls src/", makeProbe().ctx);
  assert.ok(lsMatches.includes("src/providers/"), "a directory entry ends with a trailing slash");
  assert.ok(lsMatches.includes("src/cli.ts"), "a file entry has no trailing slash");

  // Dotfiles are hidden for an empty base...
  const [hidden] = complete("cat ./", makeProbe().ctx);
  assert.ok(!hidden.includes("./.env"), "a dotfile is excluded when the base does not start with .");
  assert.ok(hidden.includes("./notes.txt"), "a non-dotfile is still offered");

  // ...but offered when the base itself starts with a dot.
  assert.deepEqual(complete("cat ./.en", makeProbe().ctx), [["./.env"], "./.en"]);

  // A single-segment absolute path reads the filesystem root, not cwd.
  assert.deepEqual(complete("cat /Us", makeProbe().ctx), [["/Users/"], "/Us"]);
});

test("AC-7: the readline substring contract holds in every domain", () => {
  const cases: Array<{ line: string; sub: string }> = [
    { line: "/pro", sub: "/pro" }, // command-name domain
    { line: "/provider an", sub: "an" }, // argument domain
    { line: "explain the src/cl", sub: "src/cl" }, // path domain
  ];
  for (const { line, sub: expectedSub } of cases) {
    const [matches, sub] = complete(line, makeProbe().ctx);
    assert.equal(sub, expectedSub, `substring for ${JSON.stringify(line)} must be the replaced segment`);
    assert.ok(matches.length > 0, "the case is meaningful only if it produces matches");
    for (const m of matches) {
      assert.ok(m.startsWith(sub), `match ${JSON.stringify(m)} must start with substring ${JSON.stringify(sub)}`);
    }
  }
});

test("AC-8: path completion reads the directory at most once, never recursively", () => {
  const probe = makeProbe();
  complete("explain the src/cl", probe.ctx);
  assert.equal(probe.calls(), 1, "exactly one directory read per path completion, no recursion");
});

test("AC-9: a leading / is command-disambiguated and never path-read", () => {
  const probe = makeProbe();
  complete("/provider", probe.ctx);
  assert.equal(probe.calls(), 0, "a leading-/ first token never triggers a directory read");
});

test("path error: a failing readDir degrades to no matches, never throws", () => {
  const probe = makeProbe();
  let result: [string[], string];
  assert.doesNotThrow(() => {
    result = complete("cat /no/such/dir/x", probe.ctx);
  });
  assert.deepEqual(result![0], [], "a throwing readdir yields no matches");
});
