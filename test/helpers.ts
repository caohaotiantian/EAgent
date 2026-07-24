import { Agent } from "../src/kernel/agent.js";
import { CapabilityManager } from "../src/kernel/capabilities.js";
import { CommandRegistry } from "../src/kernel/commands.js";
import { LayeredConfig } from "../src/config.js";
import { ExtensionHost } from "../src/kernel/extension.js";
import { MemoryBackend, MemoryStore } from "../src/kernel/store.js";
import type { StoreBackend } from "../src/kernel/store.js";
import type { CompletionRequest, Logger, Provider, StreamEvent, UI } from "../src/kernel/types.js";
import { MockProvider, type MockResponder } from "../src/providers/mock.js";
import type { Term } from "../src/tty.js";

/** A recording fake `Term` for the render tests. `columns`/`isTTY`/`rows` are
 *  mutable so a test can simulate a resize (SIGWINCH); every write is captured. */
export interface FakeTerm extends Term {
  isTTY: boolean;
  columns: number | undefined;
  rows: number | undefined;
  readonly writes: string[];
  /** Everything written so far, concatenated. */
  readonly output: string;
  raw: boolean[];
}

/**
 * Raw key byte sequences a terminal sends, for tests that simulate keystroke
 * input — the bytes a real stdin `data` listener would pass through in production.
 */
export const KEYS = {
  CTRL_T: "\x14",
  CTRL_C: "\x03",
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  PGUP: "\x1b[5~",
  PGDN: "\x1b[6~",
  ENTER: "\r",
  BACKSPACE: "\x7f",
} as const;

export function makeFakeTerm(opts: { isTTY?: boolean; columns?: number | undefined; rows?: number } = {}): FakeTerm {
  const writes: string[] = [];
  const raw: boolean[] = [];
  return {
    isTTY: opts.isTTY ?? true,
    columns: "columns" in opts ? opts.columns : 80,
    rows: opts.rows ?? 24,
    writes,
    raw,
    write(s: string): void {
      writes.push(s);
    },
    setRawMode(r: boolean): void {
      raw.push(r);
    },
    get output(): string {
      return writes.join("");
    },
  };
}

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
