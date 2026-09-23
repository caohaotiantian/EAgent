#!/usr/bin/env node
/**
 * WHY THIS EXISTS: an installed `loom` on a Node below the floor must SAY SO, and `cli.ts` cannot.
 *
 * `cli.ts` imports `node:sqlite` statically, through the journal. On Node 22.1 that import fails at
 * ESM LINK time — `ERR_UNKNOWN_BUILTIN_MODULE`, a stack trace, before one line of `cli.ts` runs —
 * so no version check written inside `cli.ts`, or inside anything it imports, can ever execute
 * there. `engines: { node: ">=24" }` does not stop it either: npm only WARNS on an engines
 * mismatch unless the installing user set `engine-strict`, so the install succeeds and the first
 * run is the crash.
 *
 * So this file is `package.json`'s `bin`, and it has NO STATIC IMPORTS — none, not even a `node:`
 * builtin — which is the whole of its contract: everything it needs to decide is on `process`, and
 * the one module it probes is loaded with a dynamic `import()` inside a `try`. Only once the floor
 * holds does it load `cli.ts` and hand over to `runAsEntryPoint`, the same exit path the single
 * file binary and `node dist/cli.js` take.
 *
 * THE SET THIS REFUSES, named: a Node whose major version is below `FLOOR` (or unparseable), and a
 * Node at or above it on which `node:sqlite` will not load — a build configured without it. Both
 * print one sentence to stderr and exit 2. The single-file binary does not come through here: it
 * carries its own runtime, which is always the one it was built with.
 *
 * `FLOOR` restates `engines.node` in `packages/core/package.json`; `test/cli/node-floor.test.ts`
 * holds the two equal.
 */

export {};

const FLOOR = 24;

function refuse(needs: string): void {
  process.stderr.write(
    `loom needs ${needs}, and this is Node.js ${process.versions.node} (${process.execPath}); ` +
      `install Node.js ${String(FLOOR)} or newer and run it again.\n`,
  );
  // `exitCode`, not `exit()`: nothing is open, so the process ends on its own once the write
  // above has drained — `exit()` would be free to cut a piped stderr short.
  process.exitCode = 2;
}

const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);

if (!(major >= FLOOR)) {
  refuse(`Node.js ${String(FLOOR)} or newer`);
} else {
  let sqlite = true;
  try {
    await import("node:sqlite");
  } catch {
    sqlite = false;
  }
  if (!sqlite) {
    refuse("a Node.js that can load node:sqlite, where every run's journal lives");
  } else {
    const { runAsEntryPoint } = await import("./cli.ts");
    await runAsEntryPoint(process.argv.slice(2));
  }
}
