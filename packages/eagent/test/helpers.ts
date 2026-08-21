import { Agent } from "../src/kernel/agent.ts";
import { CapabilityManager } from "../src/kernel/capabilities.ts";
import { CommandRegistry } from "../src/kernel/commands.ts";
import { LayeredConfig } from "../src/config.ts";
import { ExtensionHost } from "../src/kernel/extension.ts";
import { MemoryBackend, MemoryStore } from "../src/kernel/store.ts";
import type { StoreBackend } from "../src/kernel/store.ts";
import type { CompletionRequest, Logger, Provider, StreamEvent, UI } from "../src/kernel/types.ts";
import { MockProvider, type MockResponder } from "../src/providers/mock.ts";

/**
 * A thin provider that delegates to a MockProvider but reports a different
 * `name`, so a second vendor can be registered under (e.g.) "critic" — the
 * design's offline-test assumption (MockProvider.name is fixed to "mock").
 */
export class RenamedProvider implements Provider {
  readonly name: string;
  private readonly inner: MockProvider;
  constructor(name: string, inner: MockProvider) {
    this.name = name;
    this.inner = inner;
  }
  stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    return this.inner.stream(req);
  }
}

/**
 * A provider whose `stream` never yields and only settles when its request
 * signal aborts — then it rejects. It lets a test drive the deadline/abort path
 * of a bounded sub-call (a real provider that opened a connection and sent no
 * data behaves the same way).
 */
export class Hanging extends MockProvider {
  override async *stream(req: CompletionRequest): AsyncGenerator<never> {
    await new Promise<void>((_, reject) => {
      if (req.signal.aborted) {
        reject(new Error("provider hung"));
        return;
      }
      req.signal.addEventListener("abort", () => reject(new Error("provider hung")), { once: true });
    });
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
  /** The store backend behind the host; `backend.open(id)` returns the SAME Store
   *  instance an extension receives as `e.store` under that id. */
  backend: StoreBackend;
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
  const backend = new MemoryBackend();
  const host = new ExtensionHost({ agent, commands, logger, store: backend, config });
  return { agent, host, commands, provider, config, backend };
}

/**
 * A second session Agent that SHARES the harness's registries/hooks/capabilities/
 * ui/logger (mirroring the server's per-session Agent pool) but carries its OWN
 * transcript/usage. Two-session isolation tests run one session on `h.agent` and
 * one on this distinct Agent to prove per-session-root state does not commingle.
 */
export function siblingAgent(h: Harness): Agent {
  return new Agent({
    hooks: h.agent.hooks,
    tools: h.agent.tools,
    providers: h.agent.providers,
    capabilities: h.agent.capabilities,
    ui: h.agent.ui,
    logger: h.agent.logger,
    model: h.agent.model,
    provider: h.agent.providerName,
  });
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
