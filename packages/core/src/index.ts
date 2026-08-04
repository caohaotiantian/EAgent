/**
 * The public surface of @loom/core.
 *
 * This barrel IS the contract. `scripts/check-surface.mjs` snapshots every exported
 * name, so adding one is a deliberate, reviewed act. (Loom pins the interface
 * surface rather than a line count — see design/loom/01-INTERFACES.md, "The
 * minimalism guard, corrected".)
 */

export * from "./ids.ts";
export * from "./errors.ts";
export * from "./canonical.ts";

export * from "./journal/events.ts";
export * from "./journal/store.ts";
export * from "./journal/memory.ts";
export * from "./journal/sqlite.ts";
