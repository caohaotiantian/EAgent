#!/usr/bin/env node
/**
 * Guard: @loom/core has ZERO runtime dependencies.
 *
 * This is the constraint that keeps the single-binary deployment possible and keeps a
 * library embedder from downloading a UI framework. It is the ONLY automatic enforcement of
 * invariant 1 that runs on EVERY commit: `.github/workflows/ci.yml` does run `build:binary`,
 * whose esbuild metafile backstop is a real second layer, but it is a separate job and esbuild
 * cannot resolve a runtime `require` either — so for the shapes check 3 covers, both layers
 * were blind at once. (This paragraph said `build:binary` is not in `ci.yml` at all; it is,
 * at ci.yml's `binary` job, and has been since that job was added.)
 *
 * Four checks, because any one alone is bypassable:
 *
 *   1. EVERY npm dependency field in packages/core/package.json must be empty, not just
 *      `dependencies` and `peerDependencies`. `optionalDependencies` is installed BY
 *      DEFAULT — `npm i -O foo` writes it, npm installs it, and a hand-named denylist of two
 *      fields let it through. The rule is now an allowlist over `/ependencies$/i`: exactly
 *      one field, `devDependencies`, may be non-empty. That is total against fields that do
 *      not exist yet, which a denylist can never be.
 *   1b. AND NO npm LIFECYCLE SCRIPT, because check 1 asks the wrong question on its own.
 *      `Object.entries(pkg)` only ever reached fields matching `/ependencies$/i`, and
 *      `scripts.postinstall` is a field npm EXECUTES on every `npm install` of this package.
 *      Reproduced at 294e713: adding `"postinstall": "npm i -g leftpad && node -e
 *      \"require('commander')\""` to `packages/core/package.json` left this guard printing
 *      `zero-dep guard ok` and exiting 0. A package that installs something on install has a
 *      runtime dependency whatever `dependencies` says, so the rule is that this package
 *      declares NONE of npm's lifecycle names at all — see `LIFECYCLE_SCRIPTS` for the set
 *      and for why a content test on the command would be the wrong rule.
 *   2. No source file under packages/core/src may import a bare specifier that is not a
 *      `node:`-prefixed builtin — and EVERY file under src/ is a source file. The walk used
 *      to yield only `.ts`, so a `.mjs` beside it was skipped in silence; an unparseable
 *      file is now a failure rather than a skip, because "the guard read nothing here" and
 *      "the guard found nothing here" must not print the same thing.
 *   3. No source file may load a module by a route this guard cannot read: `createRequire`,
 *      a bare `require(…)`, an `import()` whose specifier is not a literal (a template
 *      literal is NOT a string literal to the parser), `module._load`, `process.binding`,
 *      `process.dlopen`. Check 2 answers "which modules are named"; check 3 answers "is
 *      naming them the only way in", and without it check 2's silence means nothing.
 *
 * CHECK 3 USED TO KEY ON THE CALL, AND THE VALUE IS WHAT MATTERS. Every rule it had fired on
 * `createRequire` being CALLED (bare identifier, whole dotted name, or dotted tail) or on the
 * literal text of an `ImportDeclaration` — and none of those shapes is present when the
 * function is merely CAPTURED first. Reproduced at 294e713, guard exit 0 with a real
 * third-party package loaded at runtime:
 *
 *     import * as mod from "node:module";
 *     const cr = mod.createRequire;            // property ACCESS, never a call
 *     const req = cr(import.meta.url);         // a bare identifier with an innocent name
 *     export const x = req("typescript");
 *
 * The rule is now keyed to the ORIGIN instead: `node:module` is the only MODULE SPECIFIER
 * `createRequire` comes from, core imports it nowhere, so naming that module in any position
 * that HANDS OUT A VALUE — `import`, `export … from`, `import()` — is unauditable, and every
 * IMPORT spelling dies with one rule rather than one rule per alias. `import type` is exempt
 * because it is erased before anything runs; see `isErasedImport`. An access whose name is
 * `createRequire` or `getBuiltinModule` is unauditable whether or not it is the callee of a
 * call, for the same reason.
 *
 * THE FIRST VERSION OF THAT PARAGRAPH CLAIMED "every aliasing shape dies with one rule" AND
 * WAS WRONG, which is the correction CLAUDE.md warns is worse than the original defect if it
 * lands half-done. `process.getBuiltinModule("module")` reaches the same value without naming
 * a specifier, and every rule here keys on a NAME that `dotted` produces — which handled only
 * dot notation. So this passed with `typescript` genuinely loaded at run time:
 *
 *     const p: any = process;
 *     const mod = p["getBuiltinModule"]("module");
 *     const req = mod["createRequire"](import.meta.url);
 *     export const ts = req("typescript");
 *
 * `dotted` reads string-literal element access now. What no name-keyed rule can reach is a
 * COMPUTED key, and `dotted` says so rather than this paragraph claiming totality again.
 *
 * Checks 2 and 3 use the TypeScript PARSER, not a regex. The regex version reported
 * `from "${branch}"` inside an error-message template literal as a dependency — a guard with
 * false positives gets disabled, and a guard that can have false positives can also have
 * false negatives.
 *
 * THE TRAP IN CHECK 3, paid for once: `require` is a legitimate METHOD name in this
 * codebase — `ToolRegistry.require`, `FunctionRegistry.require`, `ReplayCursor.require`,
 * `Engine.#require`, ~15 call sites. A rule keyed to the callee's NAME fails the whole build
 * on all of them. The rule is keyed to its SHAPE: a bare identifier callee only, never a
 * property access, never a private name. `test/check-zero-dep.test.ts` pins both directions.
 *
 * The tree to audit is `process.argv[2]`, defaulting to `packages/core`, so that the guard's
 * own failures can be reproduced against fixtures instead of argued about.
 *
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const CORE = process.argv[2] ?? "packages/core";
const failures = [];

// ── 1. declared dependencies: an allowlist, not a denylist ────────────────────

/**
 * Anything npm calls a dependency field. Case-insensitive and suffix-anchored, so it catches
 * both `bundleDependencies` and npm's alternate `bundledDependencies`, and does NOT catch
 * `peerDependenciesMeta` — metadata alone installs nothing, and failing on it would be the
 * false positive that gets a guard switched off.
 */
const DEPENDENCY_FIELD = /ependencies$/i;
/** The one field a zero-runtime-dependency package is allowed to fill. */
const ALLOWED_FIELD = "devDependencies";

const pkg = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8"));
for (const [field, value] of Object.entries(pkg)) {
  if (!DEPENDENCY_FIELD.test(field) || field === ALLOWED_FIELD) continue;
  // Three shapes, all legal npm: an object of name→range, an ARRAY of names
  // (`bundleDependencies`), and the bare `true` that means "bundle every dependency" —
  // for which `Object.keys(true)` is `[]`, so a naive read calls it empty.
  const names =
    value === true
      ? ["true — every dependency, whatever they turn out to be"]
      : Array.isArray(value)
        ? value
        : Object.keys(value ?? {});
  if (names.length > 0) {
    failures.push(`${CORE}/package.json declares ${field}: ${names.join(", ")}`);
  }
}

// ── 1b. lifecycle scripts: a field npm EXECUTES is a dependency field ─────────

/**
 * npm's own lifecycle names, as of npm 10 (`npm help scripts`), plus the two `npm-` prefixed
 * spellings npm still honours. Anything here runs without the installing user asking for it.
 *
 * THE RULE IS THE NAME, NOT THE COMMAND, and that is the whole design. A rule that inspected
 * what the script DOES would have to decide whether `node ./tools/prepare.js` installs
 * something, which is the halting problem wearing a shell — and a guard whose undecidable case
 * has a passing answer is the shape this repo keeps finding. A zero-runtime-dependency package
 * has nothing it needs to do at install time, so the honest rule is that it declares none of
 * these at all. `build` and `test` are not lifecycle names and are untouched.
 */
const LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepublishOnly",
  "prepare",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "preversion",
  "version",
  "postversion",
  "dependencies",
]);

for (const name of Object.keys(pkg.scripts ?? {})) {
  if (!LIFECYCLE_SCRIPTS.has(name)) continue;
  failures.push(
    `${CORE}/package.json declares the npm lifecycle script "${name}": ${JSON.stringify(pkg.scripts[name])} — ` +
      `npm runs it on every install of this package, so whatever it fetches or loads is a runtime dependency ` +
      `however empty "dependencies" is`,
  );
}

// ── 2 & 3. the source tree, via the parser ────────────────────────────────────

/**
 * Everything `ts.createSourceFile` can parse: `.ts .mts .cts .tsx .js .mjs .cjs .jsx` and
 * their `.d.*` forms. Anything else under `src/` is reported rather than skipped.
 */
const SOURCE = /\.(?:d\.)?[mc]?[jt]sx?$/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SOURCE.test(full)) out.push(full);
    else failures.push(`${full}: non-source file under ${CORE}/src — the zero-dep guard cannot parse it, and core/src is TypeScript-only`);
  }
  return out;
}

/**
 * Whether an `import`/`export … from` is type-only, in either of the two places TypeScript
 * writes that: on the whole clause (`import type { X } from …`) or per specifier
 * (`import { type X } from …`). A clause whose every named binding is `type` is erased too.
 */
function isErasedImport(node) {
  const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true;
    const named = node.exportClause;
    return named !== undefined && ts.isNamedExports(named) && named.elements.every((e) => e.isTypeOnly);
  }
  if (clause === undefined) return false; // `import "x"` — a side-effect import, never erased
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false; // a default binding is a value
  const bindings = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return false; // `* as ns` is a value
  return bindings.elements.every((e) => e.isTypeOnly);
}

/**
 * `a.b.c` for an access chain rooted at a plain identifier; otherwise undefined.
 *
 * `a["b"]` COUNTS AS `a.b`, and leaving it out was a hole with a real exploit. Every rule here
 * is keyed to a NAME, and this function was the only thing that produced one — so
 * `process["getBuiltinModule"]("module")["createRequire"](…)("typescript")` named nothing any
 * rule could match, and the guard printed ok over a file that really did load `typescript` at
 * run time. One character of difference from `.getBuiltinModule`, which was caught.
 *
 * WHAT IS STILL OUT OF REACH, named rather than claimed closed: a key that is not a literal —
 * `p[k]` where `k` is computed. No rule keyed to a name can see that, and a rule that refused
 * every computed element access would fire on every array index in the tree. Check 2's
 * specifier rule is what bounds that case: reaching `node:module` at all is unauditable, and
 * `process` is the only other root that hands out a loader.
 */
function dotted(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const left = dotted(node.expression);
    return left === undefined ? undefined : `${left}.${node.name.text}`;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    const left = dotted(node.expression);
    return left === undefined ? undefined : `${left}.${node.argumentExpression.text}`;
  }
  return undefined;
}

/** The name an access reads, whichever notation wrote it: `x.name` and `x["name"]` both. */
function accessedName(node) {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  return undefined;
}

/** Bare-identifier callees that load a module. Never matched through a property access. */
const BARE_LOADERS = new Set(["require", "createRequire"]);
/** Qualified callees that load a module, matched on the whole dotted name. */
const QUALIFIED_LOADERS = new Set(["module._load", "module.createRequire", "process.binding", "process.dlopen"]);
/**
 * Callees matched on their FINAL segment, whatever the receiver is called.
 *
 * `module.createRequire` is one spelling of a function with infinitely many: rename the
 * import, destructure it, reach it off a namespace object, stash it on any local, and the
 * whole-dotted-name test above sees a different string every time. The receiver is not the
 * property worth matching on — the function is. No legitimate call in this tree ends in
 * either of these names, so keying on the tail costs nothing and closes the aliases.
 */
const TAIL_LOADERS = new Set(["createRequire", "getBuiltinModule"]);
/**
 * The MODULE a runtime loader comes from, matched wherever its name is written.
 *
 * `createRequire` has exactly one origin, so keying on the origin closes every spelling at
 * once — the alias, the namespace import, the destructure off a dynamic `import()`, the
 * property access that never becomes a call. Keying on the CALLEE could not, and did not:
 * three rules each matched one shape and a fourth shape walked past all three.
 *
 * Core imports neither spelling anywhere, so this refuses nothing that exists. If a legitimate
 * need for `node:module` ever arrives it belongs in `AUDITED_RUNTIME_LOADS` beside the
 * `--extension-module` entry, with the same three pins and the same argument written down.
 */
const LOADER_MODULES = new Set(["node:module", "module"]);

/**
 * Every module specifier a file names, plus every load it performs that names nothing this
 * guard can read.
 */
function auditFile(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
  const specifiers = [];
  const unauditable = [];
  /**
   * Every place a module is NAMED, whatever syntax named it — see `LOADER_MODULES`.
   *
   * `erased` is the one exemption and it is not a courtesy: `import type … from "node:module"`
   * and `import("node:module").NodeRequire` are gone before anything runs, so they hand out no
   * value and load nothing. Refusing them would be a false positive on the one construct that
   * cannot be the defect, and a guard with false positives gets switched off.
   */
  const named = (spec, erased = false) => {
    specifiers.push(spec);
    if (!erased && LOADER_MODULES.has(spec)) {
      unauditable.push(`names "${spec}", the module \`createRequire\` comes from — every value it hands out loads a module this guard cannot follow`);
    }
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      named(node.moduleSpecifier.text, isErasedImport(node));
      // Aliasing and re-export: `import { createRequire as cr } from "node:module"` passes
      // the specifier check (it IS a builtin) and then hands the file a loader under a name
      // no callee rule knows. `getText` starts past leading trivia, so a comment mentioning
      // it does not trip this.
      if (node.getText(source).includes("createRequire")) {
        unauditable.push("imports createRequire, which loads a module by a name this guard cannot follow");
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      named(node.argument.literal.text, true);
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && TAIL_LOADERS.has(accessedName(node) ?? "")) {
      // KEYED TO THE VALUE, NOT THE CALL. `const cr = mod.createRequire` is an access that is
      // nobody's callee, so every callee rule below missed it while the captured function
      // loaded `typescript` at runtime. Both notations, because `mod["createRequire"]` reads
      // the same property and used to name nothing — see `dotted`.
      unauditable.push(`reads .${accessedName(node) ?? "?"} — a runtime module loader this guard cannot follow once it is captured`);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) named(arg.text);
        else unauditable.push("dynamic import() with a specifier this guard cannot read (a template literal is not a string literal)");
      } else if (ts.isIdentifier(node.expression) && BARE_LOADERS.has(node.expression.text)) {
        unauditable.push(`calls ${node.expression.text}(…) — a runtime module load this guard cannot audit`);
      } else {
        const name = dotted(node.expression);
        const tail = name?.split(".").at(-1);
        if (name !== undefined && (QUALIFIED_LOADERS.has(name) || (tail !== undefined && TAIL_LOADERS.has(tail)))) {
          unauditable.push(`calls ${name}(…) — a runtime module load this guard cannot audit`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, unauditable };
}

/**
 * THE EXCEPTIONS TO CHECK 3, AND THE ONLY WAY TO HAVE ONE — pinned by file, by count, and by
 * the exact message.
 *
 * Check 3 asks "is naming a module the only way in", and its answer for anything it cannot
 * read is NO. That is right for `require`, `createRequire` and friends, and it is also right
 * for `import(<not a literal>)` in general. But `--extension-module` is a load this guard is
 * being asked about for the first time and the answer is genuinely different: the specifier
 * is a path the OPERATOR typed on argv, it names no package, `npm install` never sees it,
 * and the single-file binary does not have to bundle it. It adds no dependency. What it adds
 * is a trust position, and that is argued at the call site rather than here.
 *
 * THREE PINS, so this cannot rot into a hole:
 *
 *  - the FILE, relative to the audited tree, so the allowance covers one place;
 *  - the exact MESSAGE, so a `createRequire` appearing in that file is still a failure —
 *    an allowance keyed only to a count would let any other unreadable load in behind it;
 *  - the COUNT, EXACTLY. Fewer is a failure too: a stale allowance is an unaudited licence
 *    sitting in a guard, and the whole value of this file is that nobody can quietly widen
 *    it. Delete the entry when the load goes.
 *
 * Adding an entry here is a decision about invariant 1 and belongs in a commit body.
 */
const AUDITED_RUNTIME_LOADS = new Map([
  [
    join("src", "cli.ts"),
    {
      count: 1,
      how: "dynamic import() with a specifier this guard cannot read (a template literal is not a string literal)",
      why: "loadExtensionModules — `--extension-module <path>`, an operator-supplied path from ARGV. It names no package, adds no dependency, and is loadable from nowhere but argv.",
    },
  ],
]);

const SRC_ROOT = resolve(join(CORE, "src"));
const files = walk(join(CORE, "src"));
for (const file of files) {
  const { specifiers, unauditable } = auditFile(file);
  for (const spec of specifiers) {
    if (spec.startsWith(".") || spec.startsWith("/")) {
      // A RELATIVE SPECIFIER IS NOT AUTOMATICALLY AN INTERNAL ONE, which is the shape this
      // guard named three ways into `node_modules` and missed:
      //
      //     import "../../eagent/src/kernel/agent.ts"
      //
      // is not bare, so nothing above objects — and it reaches a sibling package that carries
      // `jiti`, pulling a runtime dependency into core through the one door the guard leaves
      // open. Measured: the guard printed `ok` with that line at the top of `src/ids.ts`.
      //
      // Invariant 1 says it in words already — "core may not import them" — and this is the
      // half of it nothing enforced. Zero of the 320 relative imports in `src/` escape today,
      // so the rule refuses nothing that exists.
      const target = resolve(dirname(file), spec);
      if (target !== SRC_ROOT && !target.startsWith(SRC_ROOT + sep)) {
        failures.push(
          `${file}: imports "${spec}", which resolves OUTSIDE packages/core/src ` +
            `(core may not import a sibling package — invariant 1)`,
        );
      }
      continue;
    }
    if (spec.startsWith("node:")) continue; // builtin, explicitly prefixed
    failures.push(`${file}: imports bare specifier "${spec}" (core must be zero-dep)`);
  }
  // The allowance is spent against the EXACT message, and only that many times. Anything
  // left over is a failure, and an allowance that went unspent is a failure in the other
  // direction — see `AUDITED_RUNTIME_LOADS`.
  const rel = relative(resolve(CORE), resolve(file));
  const audited = AUDITED_RUNTIME_LOADS.get(rel);
  let budget = audited?.count ?? 0;
  for (const how of unauditable) {
    if (audited !== undefined && how === audited.how && budget > 0) {
      budget -= 1;
      continue;
    }
    failures.push(`${file}: ${how} (core must be zero-dep)`);
  }
  if (audited !== undefined && budget > 0) {
    failures.push(
      `${file}: AUDITED_RUNTIME_LOADS allows ${String(audited.count)} × "${audited.how}" and the file has ` +
        `${String(audited.count - budget)}. A stale allowance is an unaudited licence — delete the entry. (${audited.why})`,
    );
  }
}

if (failures.length > 0) {
  console.error("zero-dep guard FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`zero-dep guard ok: ${CORE} has no runtime dependencies (${files.length} files scanned)`);
