import { Agent } from "../src/kernel/agent.js";
import { CapabilityManager } from "../src/kernel/capabilities.js";
import { CommandRegistry } from "../src/kernel/commands.js";
import { ExtensionHost } from "../src/kernel/extension.js";
import { MemoryBackend } from "../src/kernel/store.js";
import type { Logger, UI } from "../src/kernel/types.js";
import { MockProvider, type MockResponder } from "../src/providers/mock.js";

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
  opts: { responder?: MockResponder; fallback?: "allow" | "deny" | "ask"; ui?: UI } = {},
): Harness {
  const ui = opts.ui ?? autoUI(true);
  const capabilities = new CapabilityManager({ ui, fallback: opts.fallback ?? "allow" });
  const agent = new Agent({
    ui,
    logger: silentLogger,
    capabilities,
    provider: "mock",
    model: "mock",
  });
  const provider = new MockProvider(opts.responder);
  agent.providers.register(provider, { default: true });
  const commands = new CommandRegistry();
  const host = new ExtensionHost({ agent, commands, logger: silentLogger, store: new MemoryBackend() });
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
