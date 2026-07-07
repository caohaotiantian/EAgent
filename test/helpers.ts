import { Agent } from "../src/kernel/agent.js";
import { CapabilityManager } from "../src/kernel/capabilities.js";
import { CommandRegistry } from "../src/kernel/commands.js";
import { LayeredConfig } from "../src/config.js";
import { ExtensionHost } from "../src/kernel/extension.js";
import { MemoryBackend, MemoryStore } from "../src/kernel/store.js";
import type { CompletionRequest, Logger, Provider, StreamEvent, UI } from "../src/kernel/types.js";
import { MockProvider, type MockResponder } from "../src/providers/mock.js";

/**
 * A thin provider that delegates to a MockProvider but reports a different
 * `name`, so a second vendor can be registered under (e.g.) "critic" — the
 * design's offline-test assumption (MockProvider.name is fixed to "mock").
 */
export class RenamedProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly inner: MockProvider,
  ) {}
  stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    return this.inner.stream(req);
  }
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function autoUI(answer = true): UI {
  return { confirm: async () => answer, notify: () => {} };
}

export interface Harness {
  agent: Agent;
  host: ExtensionHost;
  commands: CommandRegistry;
  provider: MockProvider;
  /** The injected config (same instance the extensions see as `e.config`), so a
   *  test can set a value key race-free instead of mutating global `process.env`. */
  config: LayeredConfig;
}

export function makeHarness(
  opts: { responder?: MockResponder; fallback?: "allow" | "deny" | "ask"; ui?: UI; logger?: Logger; maxConcurrency?: number } = {},
): Harness {
  const ui = opts.ui ?? autoUI(true);
  const logger = opts.logger ?? silentLogger;
  const capabilities = new CapabilityManager({ ui, fallback: opts.fallback ?? "allow" });
  const agent = new Agent({
    ui,
    logger,
    capabilities,
    provider: "mock",
    model: "mock",
    // Passed through so a test can exercise the constructor's clamp path.
    maxConcurrency: opts.maxConcurrency,
  });
  const provider = new MockProvider(opts.responder);
  agent.providers.register(provider, { default: true });
  const commands = new CommandRegistry();
  // A real LayeredConfig (empty file layer, in-memory override) so the harness
  // honors env-var reads AND the legacy ENV_ALIASES exactly like production.
  const config = new LayeredConfig({ overrideStore: new MemoryStore() });
  const host = new ExtensionHost({ agent, commands, logger, store: new MemoryBackend(), config });
  return { agent, host, commands, provider, config };
}

export function lastText(agent: Agent): string {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i]!;
    if (m.role !== "assistant") continue;
    let text = "";
    for (const b of m.content) if (b.type === "text") text += b.text;
    if (text.length > 0) return text;
  }
  return "";
}
