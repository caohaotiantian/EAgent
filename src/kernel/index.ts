/**
 * EAgent kernel — the entire stable surface.
 *
 * Seven primitives and nothing more: a hook bus, a tool registry, a provider
 * abstraction, the agent loop, a capability layer, an extension host, and a
 * command registry. Tools, memory, prompts, UI, providers, and skills are all
 * extensions built on top of these.
 */

export * from "./types.js";
export * from "./events.js";
export { HookBus, setHandlerErrorReporter } from "./hooks.js";
export type { EventHandler, FilterHandler } from "./hooks.js";
export { ToolRegistry, ProviderRegistry } from "./registry.js";
export { Agent, currentActingAgent, currentRootAgent } from "./agent.js";
export type { AgentOptions, RunResult } from "./agent.js";
export {
  CapabilityManager,
  CapabilityError,
  matchPattern,
} from "./capabilities.js";
export type { Decision, AuditEntry, CapabilityOptions } from "./capabilities.js";
export { validate } from "./validate.js";
export type { ValidationResult } from "./validate.js";
export { ExtensionHost } from "./extension.js";
export type { ExtensionAPI, ActivateFn, Deactivate, ExtensionHostOptions } from "./extension.js";
export { CommandRegistry } from "./commands.js";
export type { Command, CommandContext } from "./commands.js";
export {
  MemoryStore,
  MemoryBackend,
  FileBackend,
} from "./store.js";
export type { Store, StoreBackend, Config } from "./store.js";

/** Convenience helper: define a tool with inline typing. */
export { defineTool } from "./define.js";
