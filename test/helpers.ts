import { Agent } from "../src/kernel/agent.js";
import { CapabilityManager } from "../src/kernel/capabilities.js";
import { CommandRegistry } from "../src/kernel/commands.js";
import { ExtensionHost } from "../src/kernel/extension.js";
import { MemoryBackend } from "../src/kernel/store.js";
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
}

export function makeHarness(
  opts: { responder?: MockResponder; fallback?: "allow" | "deny" | "ask"; ui?: UI; logger?: Logger } = {},
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
  });
  const provider = new MockProvider(opts.responder);
  agent.providers.register(provider, { default: true });
  const commands = new CommandRegistry();
  const host = new ExtensionHost({ agent, commands, logger, store: new MemoryBackend() });
  return { agent, host, commands, provider };
}

export function lastText(agent: Agent): string {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i]!;
    if (m.role !== "assistant") continue;
    const t = m.content.find((b) => b.type === "text");
    if (t && t.type === "text") return t.text;
  }
  return "";
}
