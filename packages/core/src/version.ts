/**
 * WHY THIS IS A CONSTANT AND NOT A READ OF `package.json`.
 *
 * `loom --version` has to answer in the three places `loom` runs: `src/` under type stripping,
 * `dist/` from an installed tarball, and the single-file binary. Reading `../package.json` at run
 * time works in the first two and not the third — the SEA bundle has no `package.json` beside it —
 * and `tsconfig`'s `rootDir: ./src` refuses a static JSON import from outside `src/`. So the number
 * is written down twice, here and in `packages/core/package.json`, and `test/version.test.ts`
 * fails the build the moment the two disagree. Bump both in one commit. Everything else that
 * states loom's version reads THIS — `loom --version`, and the `clientInfo` an MCP server is sent.
 */
export const VERSION = "0.1.0";
