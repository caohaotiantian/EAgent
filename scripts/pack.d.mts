/**
 * Hand-written types for `pack.mjs`'s two pure exports, so `packages/core/test/scripts-pack.test.ts`
 * can import it under `tsconfig.test.json` without `allowJs` — a tsconfig-wide switch this one test
 * file does not need turned on for the whole package. TODO.md §A.91 M3.
 */
export function classifyShippedSource(sourceExists: boolean, sourceTracked: boolean): "ok" | "orphan" | "untracked";
export function namesASourceMap(text: string): boolean;
