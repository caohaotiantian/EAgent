#!/usr/bin/env node
/**
 * Guard: @loom/core has ZERO runtime dependencies.
 *
 * This is the constraint that keeps the single-binary deployment possible and keeps a
 * library embedder from downloading a UI framework. It is the ONLY automatic enforcement of
 * invariant 1: the esbuild metafile backstop in `build-binary.mjs` is a second layer on
 * paper, but `build:binary` is not in `ci.yml`, and esbuild cannot resolve a runtime
 * `require` either — so for the shapes check 3 covers, both layers were blind at once.
 *
 * Three checks, because any one alone is bypassable:
 *
 *   1. EVERY npm dependency field in packages/core/package.json must be empty, not just
 *      `dependencies` and `peerDependencies`. `optionalDependencies` is installed BY
 *      DEFAULT — `npm i -O foo` writes it, npm installs it, and a hand-named denylist of two
 *      fields let it through. The rule is now an allowlist over `/ependencies$/i`: exactly
 *      one field, `devDependencies`, may be non-empty. That is total against fields that do
 *      not exist yet, which a denylist can never be.
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
import { dirname, join, resolve, sep } from "node:path";
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

/** `a.b.c` for a property-access chain rooted at a plain identifier; otherwise undefined. */
function dotted(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const left = dotted(node.expression);
    return left === undefined ? undefined : `${left}.${node.name.text}`;
  }
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
 * Every module specifier a file names, plus every load it performs that names nothing this
 * guard can read.
 */
function auditFile(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
  const specifiers = [];
  const unauditable = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
      // Aliasing and re-export: `import { createRequire as cr } from "node:module"` passes
      // the specifier check (it IS a builtin) and then hands the file a loader under a name
      // no callee rule knows. `getText` starts past leading trivia, so a comment mentioning
      // it does not trip this.
      if (node.getText(source).includes("createRequire")) {
        unauditable.push("imports createRequire, which loads a module by a name this guard cannot follow");
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      specifiers.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) specifiers.push(arg.text);
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
  for (const how of unauditable) failures.push(`${file}: ${how} (core must be zero-dep)`);
}

if (failures.length > 0) {
  console.error("zero-dep guard FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`zero-dep guard ok: ${CORE} has no runtime dependencies (${files.length} files scanned)`);
