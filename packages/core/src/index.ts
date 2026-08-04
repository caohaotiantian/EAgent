/**
 * The public surface of @loom/core.
 *
 * This barrel IS the contract. `scripts/check-surface.mjs` snapshots every exported
 * name, so adding one is a deliberate, reviewed act. (Loom pins the interface
 * surface rather than a line count — see design/loom/01-INTERFACES.md, "The
 * minimalism guard, corrected".)
 */

export * from "./vocab.ts";
export * from "./ids.ts";
export * from "./errors.ts";
export * from "./canonical.ts";

export * from "./journal/events.ts";
export * from "./journal/store.ts";
export * from "./journal/memory.ts";
export * from "./journal/sqlite.ts";

export * from "./state/channels.ts";
export * from "./bus.ts";

export * from "./graph/spec.ts";
export * from "./graph/expr.ts";
export * from "./graph/validate.ts";
export * from "./graph/compile.ts";

export * from "./schema.ts";
export * from "./run/projection.ts";
export * from "./run/log.ts";
export * from "./run/policy.ts";
export * from "./run/registry.ts";
export * from "./run/gates.ts";
export * from "./run/engine.ts";
export * from "./run/replay.ts";
export * from "./telemetry/spans.ts";
