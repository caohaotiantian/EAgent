/**
 * The zero-dep guard, driven rather than read.
 *
 * Invariant 1 has exactly one automatic enforcer — `scripts/check-zero-dep.mjs`. (The
 * esbuild metafile backstop in `build-binary.mjs` is the second layer on paper, but
 * `build:binary` is not in `ci.yml`, so nothing runs it unattended; and esbuild cannot see
 * a runtime `require` either, so both layers were blind to the same shapes at once.)
 *
 * A guard with one enforcer needs its failures reproduced, not asserted. Every row below was
 * watched to PASS the guard before the rules that catch it existed — the four source shapes
 * (`createRequire(...)`, a bare `require(...)`, a computed `import(NAME)`, a template-literal
 * `import(`…`)`), the two manifest fields npm installs anyway (`optionalDependencies`,
 * `bundleDependencies`), and the whole class of non-`.ts` files under `src/`, which the walk
 * skipped in silence. Before the fix this file reported 12 of its 20 cases as "the guard
 * accepted it".
 *
 * Two rows are the OTHER direction and matter just as much, because a guard that cries wolf
 * gets switched off: `this.tools.require(...)` and `registry.require(name)` are ordinary
 * methods with ~15 call sites in `src/`, and a `require` rule written against any callee
 * named `require` fails the whole build on them. They are pinned as PASSING.
 *
 * Not tested here, deliberately: `node:sqlite3` and other misspelled builtins. That was
 * raised and REFUTED — `node:` is a reserved scheme that is never resolved against
 * `node_modules`, so a bad `node:` specifier is a typo rather than a dependency, and it is
 * already `TS2307` under this repo's `nodenext` config in all four import forms.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const GUARD = join(REPO, "scripts", "check-zero-dep.mjs");

interface Fixture {
  /** Fields merged over a minimal, legal, zero-dep manifest. */
  readonly manifest?: Record<string, unknown>;
  /** `path under src/` → contents. Defaults to one clean file. */
  readonly files?: Record<string, string>;
}

const CLEAN = { "index.ts": 'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n' };

function fixture(f: Fixture): string {
  const root = mkdtempSync(join(tmpdir(), "loom-zero-dep-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@fixture/core", private: true, type: "module", dependencies: {}, ...f.manifest }, null, 2),
  );
  for (const [rel, body] of Object.entries(f.files ?? CLEAN)) {
    const path = join(root, "src", rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

interface Verdict {
  readonly status: number;
  readonly output: string;
}

/**
 * Run the REAL guard against a fixture tree.
 *
 * `cwd` stays in the repo so the script's own `import ts from "typescript"` resolves; the
 * tree it audits is the argument. That the root is an argument at all is part of the fix —
 * a guard that can only ever be pointed at one directory cannot be shown to fail.
 */
function runGuard(root: string): Verdict {
  const r = spawnSync(process.execPath, [GUARD, root], { cwd: REPO, encoding: "utf8" });
  return { status: r.status ?? -1, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** `undefined` means the guard must accept the tree; a RegExp is what its refusal must say. */
interface Case {
  readonly how: string;
  readonly fixture: Fixture;
  readonly refusal: RegExp | undefined;
}

const CASES: readonly Case[] = [
  // ── check 1: the manifest ──────────────────────────────────────────────────
  {
    how: "a clean manifest and a clean source tree",
    fixture: {},
    refusal: undefined,
  },
  {
    how: "dependencies (the control — this was always caught)",
    fixture: { manifest: { dependencies: { lodash: "^4.17.21" } } },
    refusal: /declares dependencies: lodash/,
  },
  {
    how: "peerDependencies (also always caught)",
    fixture: { manifest: { peerDependencies: { react: "^19" } } },
    refusal: /declares peerDependencies: react/,
  },
  {
    how: "optionalDependencies — npm installs these BY DEFAULT",
    fixture: { manifest: { optionalDependencies: { lodash: "^4.17.21" } } },
    refusal: /declares optionalDependencies: lodash/,
  },
  {
    how: "bundleDependencies, as the array npm writes",
    fixture: { manifest: { bundleDependencies: ["chalk"] } },
    refusal: /declares bundleDependencies: chalk/,
  },
  {
    how: "bundledDependencies, npm's other spelling of the same field",
    fixture: { manifest: { bundledDependencies: ["chalk"] } },
    refusal: /declares bundledDependencies: chalk/,
  },
  {
    how: "bundleDependencies: true, which is legal npm for `all of them`",
    fixture: { manifest: { bundleDependencies: true } },
    refusal: /declares bundleDependencies/,
  },
  {
    how: "devDependencies — the one dependency field a zero-dep package may have",
    fixture: { manifest: { devDependencies: { typescript: "^5.9.0" } } },
    refusal: undefined,
  },
  {
    how: "peerDependenciesMeta alone, which installs nothing",
    fixture: { manifest: { peerDependenciesMeta: { react: { optional: true } } } },
    refusal: undefined,
  },

  // ── check 2: what a source file can load ───────────────────────────────────
  {
    how: "a static bare import (the control)",
    fixture: { files: { "index.ts": 'import lodash from "lodash";\nexport const x = lodash;\n' } },
    refusal: /imports bare specifier "lodash"/,
  },
  {
    how: "a bare export-from",
    fixture: { files: { "index.ts": 'export { merge } from "lodash";\n' } },
    refusal: /imports bare specifier "lodash"/,
  },
  {
    how: "a node: builtin, which is the whole point of the exception",
    fixture: { files: { "index.ts": 'import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n' } },
    refusal: undefined,
  },
  {
    how: "createRequire, the documented escape from ESM resolution",
    fixture: {
      files: {
        "index.ts": 'import { createRequire } from "node:module";\nexport const lodash = createRequire(import.meta.url)("lodash");\n',
      },
    },
    refusal: /createRequire/,
  },
  {
    how: "createRequire imported under an alias",
    fixture: {
      files: { "index.ts": 'import { createRequire as cr } from "node:module";\nexport const lodash = cr(import.meta.url)("lodash");\n' },
    },
    refusal: /createRequire/,
  },
  // ── check 4: a relative specifier is not automatically an internal one ─────
  //
  // The guard named three routes into `node_modules` and left a fourth open, because it
  // classified every specifier starting with "." as "relative, therefore fine". A relative
  // path can leave the package entirely:
  //
  //     import "../../eagent/src/kernel/agent.ts"
  //
  // is not bare, so nothing objected — and it reaches a sibling package that carries `jiti`,
  // pulling a runtime dependency into core through the one door left open. Measured against
  // the real guard before the fix: `ok`, with that line at the top of `src/ids.ts`.
  //
  // Invariant 1 already said it in words — "core may not import them". This is the half
  // nothing enforced. Zero of the 320 relative imports in `src/` escape today.
  {
    how: "a relative import that leaves the package for a sibling",
    fixture: { files: { "index.ts": 'import "../../eagent/src/kernel/agent.ts";\nexport const x = 1;\n' } },
    refusal: /resolves OUTSIDE/,
  },
  {
    how: "a relative import that leaves src/ but stays in the package",
    // `../package.json` is inside the package and still outside what `build:binary` bundles,
    // which is `src/`. The rule is the SOURCE ROOT, not the package root, because that is the
    // boundary the binary actually has.
    fixture: { files: { "index.ts": 'import cfg from "../package.json" with { type: "json" };\nexport const x = cfg;\n' } },
    refusal: /resolves OUTSIDE/,
  },
  {
    how: "a relative import that climbs and comes back inside src/",
    // NOT a refusal: `./a/../b.ts` is a silly spelling of `./b.ts` and resolves inside. The
    // check must be about where a specifier LANDS, not how many `..` it contains — a textual
    // rule would refuse this and teach people the guard is noise.
    fixture: {
      files: {
        "index.ts": 'export { y } from "./nested/../sibling.ts";\n',
        "sibling.ts": "export const y = 1;\n",
        "nested/keep.ts": "export const k = 1;\n",
      },
    },
    refusal: undefined,
  },
  {
    how: "a bare require(), which type-strips straight through",
    fixture: { files: { "index.ts": "declare const require: (s: string) => unknown;\nexport const lodash = require(\"lodash\");\n" } },
    refusal: /calls require\(/,
  },
  {
    how: "a computed dynamic import",
    fixture: { files: { "index.ts": "const NAME = [\"lo\", \"dash\"].join(\"\");\nexport const load = () => import(NAME);\n" } },
    refusal: /dynamic import\(\) with a specifier this guard cannot read/,
  },
  {
    how: "a template-literal dynamic import — NOT a string literal to the TypeScript parser",
    fixture: { files: { "index.ts": "export const load = () => import(`lodash`);\n" } },
    refusal: /dynamic import\(\) with a specifier this guard cannot read/,
  },
  // ── check 5: the ONE audited runtime load, and the three pins on it ────────
  //
  // `--extension-module` puts a dynamic `import(<operator path>)` in `src/cli.ts`, which
  // check 3 refuses by construction and correctly so for everything else. The allowance is
  // pinned by FILE, by exact MESSAGE and by exact COUNT, and all four rows below were
  // watched: the first passes, and the other three are the ways an allowance normally rots
  // into a hole.
  {
    how: "the audited dynamic import in the file the allowance names",
    fixture: { files: { "cli.ts": "export const load = (p: string) => import(`${p}`);\n" } },
    refusal: undefined,
  },
  {
    how: "…and a SECOND one in the same file is one over budget",
    fixture: { files: { "cli.ts": "export const a = (p: string) => import(`${p}`);\nexport const b = (q: string) => import(`${q}`);\n" } },
    refusal: /dynamic import\(\) with a specifier this guard cannot read/,
  },
  {
    how: "…and a DIFFERENT unreadable load in that file is still refused — the message is pinned, not just the count",
    fixture: {
      files: {
        "cli.ts": 'import { createRequire } from "node:module";\nexport const lodash = createRequire(import.meta.url)("lodash");\n',
      },
    },
    refusal: /createRequire/,
  },
  {
    how: "…and an allowance nobody spends is STALE, which is a failure in the other direction",
    fixture: { files: { "cli.ts": 'import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n' } },
    refusal: /stale allowance is an unaudited licence/,
  },
  {
    how: "the same import in ANY OTHER file is refused — the allowance covers one place",
    fixture: {
      files: {
        "cli.ts": "export const load = (p: string) => import(`${p}`);\n",
        "other.ts": "export const load = (p: string) => import(`${p}`);\n",
      },
    },
    refusal: /other\.ts: dynamic import\(\)/,
  },
  {
    how: "process.dlopen, which loads a native addon with no specifier at all",
    fixture: {
      files: { "index.ts": 'import { readFileSync } from "node:fs";\nexport const go = () => process.dlopen({ exports: {} }, readFileSync ? "x" : "y");\n' },
    },
    refusal: /calls process\.dlopen\(/,
  },
  // The other direction. `require` is a METHOD on three classes in src/ with ~15 call
  // sites; a rule keyed to the callee's name rather than its shape fails the real build.
  {
    how: "a method named require, called through a property access",
    fixture: {
      files: {
        "index.ts": [
          "export class Registry {",
          "  require(name: string): string { return name; }",
          "}",
          "const r = new Registry();",
          'export const one = r.require("tool");',
          "export class Engine {",
          "  #require(id: string): string { return id; }",
          '  run(): string { return this.#require("r1"); }',
          "}",
          "",
        ].join("\n"),
      },
    },
    refusal: undefined,
  },
  {
    how: "an import TYPE node, which is a type position and not a load",
    fixture: {
      files: {
        "index.ts": 'export type P = import("./other.ts").Other;\n',
        "other.ts": "export interface Other { readonly a: number; }\n",
      },
    },
    refusal: undefined,
  },

  // ── the walk: which files are audited at all ───────────────────────────────
  {
    how: "an .mjs file under src/ importing a bare specifier",
    fixture: { files: { "index.ts": CLEAN["index.ts"], "sneaky.mjs": 'import * as esbuild from "esbuild";\nexport default esbuild;\n' } },
    refusal: /imports bare specifier "esbuild"/,
  },
  {
    how: "an .mts file under src/ importing a bare specifier",
    fixture: { files: { "index.ts": CLEAN["index.ts"], "sneaky.mts": 'import chalk from "chalk";\nexport default chalk;\n' } },
    refusal: /imports bare specifier "chalk"/,
  },
  {
    how: "a file under src/ the guard cannot parse at all",
    fixture: { files: { "index.ts": CLEAN["index.ts"], "data.json": '{"a":1}\n' } },
    refusal: /non-source file under/,
  },
];

test("THE ZERO-DEP GUARD CATCHES EVERY WAY INTO node_modules THAT HAS BEEN TRIED", () => {
  const wrong: string[] = [];
  for (const c of CASES) {
    const root = fixture(c.fixture);
    try {
      const v = runGuard(root);
      if (c.refusal === undefined) {
        if (v.status !== 0) wrong.push(`${c.how}: the guard REFUSED a legal tree —\n${v.output}`);
      } else if (v.status === 0) {
        wrong.push(`${c.how}: the guard ACCEPTED it —\n${v.output}`);
      } else if (!c.refusal.test(v.output)) {
        wrong.push(`${c.how}: refused, but not for the reason expected (${String(c.refusal)}) —\n${v.output}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(wrong, []);
});

test("the guard still passes THIS repo, and still says how much it read", () => {
  // The count is the guard's own claim about its reach, quoted in HANDOFF.md. If the walk
  // ever silently narrows again, this is where it shows.
  const r = spawnSync(process.execPath, [GUARD], { cwd: REPO, encoding: "utf8" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  assert.equal(r.status, 0, out);
  const m = /\((\d+) files scanned\)/.exec(out);
  assert.ok(m, `the guard stopped reporting its reach: ${out}`);
  assert.ok(Number(m[1]) >= 49, `only ${m[1]} files scanned — the walk narrowed`);
});
