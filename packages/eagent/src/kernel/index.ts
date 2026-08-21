/**
 * EAgent kernel — the entire stable surface.
 *
 * Seven primitives and nothing more: a hook bus, a tool registry, a provider
 * abstraction, the agent loop, a capability layer, an extension host, and a
 * command registry. Tools, memory, prompts, UI, providers, and skills are all
 * extensions built on top of these.
 */

export * from "./types.ts";
export * from "./events.ts";
export { HookBus, setHandlerErrorReporter } from "./hooks.ts";
export type { EventHandler, FilterHandler } from "./hooks.ts";
export { ToolRegistry, ProviderRegistry } from "./registry.ts";
export { Agent, currentActingAgent, currentRootAgent } from "./agent.ts";
export type { AgentOptions, RunResult } from "./agent.ts";
export {
  CapabilityManager,
  CapabilityError,
  matchPattern,
} from "./capabilities.ts";
export type { Decision, AuditEntry, CapabilityOptions } from "./capabilities.ts";
export { validate } from "./validate.ts";
export type { ValidationResult } from "./validate.ts";
export { ExtensionHost } from "./extension.ts";
export type { ExtensionAPI, ActivateFn, Deactivate, ExtensionHostOptions } from "./extension.ts";
export { CommandRegistry } from "./commands.ts";
export type { Command, CommandContext } from "./commands.ts";
export {
  MemoryStore,
  MemoryBackend,
  FileBackend,
} from "./store.ts";
export type { Store, StoreBackend, Config } from "./store.ts";

/** Convenience helper: define a tool with inline typing. */
export { defineTool } from "./define.ts";
