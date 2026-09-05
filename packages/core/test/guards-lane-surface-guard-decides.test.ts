/**
 * The surface guard, DRIVEN — because until this file nothing ran it.
 *
 * `npm run check` and `.github/workflows/ci.yml` both end in
 * `node scripts/check-surface.mjs`, and the two tests that mention it read its TEXT:
 * `surface-shape-is-covered.test.ts` asserts its docstring still says what it pins, and
 * `toolchain-gate.test.ts` asserts the typecheck re-emits the `.d.ts` it reads. Neither
 * executes its decision. Measured at 294e713 by neutering the guard in place — leaving the
 * whole header and replacing its two diff lines with `const added = []; const removed = []`,
 * so it reports every contract unchanged whatever the tree says:
 *
 *     $ node --test packages/core/test/surface-shape-is-covered.test.ts \
 *                   packages/core/test/toolchain-gate.test.ts
 *     ℹ tests 5   ℹ pass 5   ℹ fail 0
 *
 * A guard whose only observation is that its own comment is intact is a guard that can be
 * switched off in the same commit that adds an unpinned export. The two sibling guards are
 * already driven this way (`check-zero-dep.test.ts`, `kernel-boundary.test.ts`); this is the
 * third.
 *
 * FIXTURES, NOT THIS REPO. The guard resolves `scripts/surface.json` and
 * `packages/core/dist/index.d.ts` against `process.cwd()`, so pointing it at a throwaway tree
 * is the whole mechanism — and it means these cases run with no build, which the real-repo
 * case could not. The fixture carries a `node_modules` symlink because the guard shells out
 * to a script that imports `typescript` and resolves it from the working directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const GUARD = join(REPO, "scripts", "check-surface.mjs");

interface Fixture {
  /** The `.d.ts` the guard reads, or `undefined` to leave `dist/` empty. */
  readonly entry?: string;
  /** The pinned name list, or `undefined` to leave `scripts/surface.json` absent. */
  readonly pin?: readonly string[];
}

function fixture(f: Fixture): string {
  const root = mkdtempSync(join(tmpdir(), "loom-surface-guard-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "packages", "core", "dist"), { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  if (f.entry !== undefined) writeFileSync(join(root, "packages", "core", "dist", "index.d.ts"), f.entry);
  if (f.pin !== undefined) writeFileSync(join(root, "scripts", "surface.json"), JSON.stringify(f.pin, null, 2) + "\n");
  return root;
}

function runGuard(root: string): { readonly status: number; readonly output: string } {
  const r = spawnSync(process.execPath, [GUARD], { cwd: root, encoding: "utf8" });
  return { status: r.status ?? -1, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Two exported names, so a case can add one or drop one without changing the other. */
const TWO = "export declare const ALPHA: string;\nexport declare function beta(): void;\n";

test("THE SURFACE GUARD DECIDES, and every one of its answers is driven", (t) => {
  const roots: string[] = [];
  t.after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  const at = (f: Fixture): { readonly status: number; readonly output: string } => {
    const root = fixture(f);
    roots.push(root);
    return runGuard(root);
  };

  // THE ORDINARY HALF FIRST. A guard that only ever refuses is as useless as one that only
  // ever passes, and this is the answer the other three are measured against.
  const unchanged = at({ entry: TWO, pin: ["ALPHA", "beta"] });
  assert.equal(unchanged.status, 0, unchanged.output);
  assert.match(unchanged.output, /surface guard ok: 2 public exports, unchanged/);

  // AN UNPINNED EXPORT. This is the case the neutered guard reported as `unchanged`.
  const added = at({ entry: TWO + "export declare const GAMMA: number;\n", pin: ["ALPHA", "beta"] });
  assert.equal(added.status, 1, added.output);
  assert.match(added.output, /surface guard FAILED/);
  assert.match(added.output, /added:\s+GAMMA/);

  // A DROPPED EXPORT, which the guard has to call out separately: removing a name breaks
  // every embedder that imported it, and the message says so.
  const removed = at({ entry: "export declare const ALPHA: string;\n", pin: ["ALPHA", "beta"] });
  assert.equal(removed.status, 1, removed.output);
  assert.match(removed.output, /removed:\s+beta\s+\(REMOVAL IS BREAKING\)/);

  // FAILING CLOSED ON ITS OWN INPUTS. A missing pin and a missing `.d.ts` are both "this
  // guard cannot decide", and neither may answer with the passing value — `check-surface.mjs`
  // reading a stale artifact and printing `ok` is the incident the whole toolchain gate
  // exists because of.
  const noPin = at({ entry: TWO });
  assert.equal(noPin.status, 1, noPin.output);
  assert.match(noPin.output, /surface\.json missing/);

  const noEntry = at({ pin: ["ALPHA"] });
  assert.equal(noEntry.status, 1, noEntry.output);
  assert.match(noEntry.output, /not found — run `npm run build` first/);
});
