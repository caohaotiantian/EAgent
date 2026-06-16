/**
 * Shared host wiring.
 *
 * Building an agent — selecting a provider, creating the extension host, and
 * loading the built-in extensions — is identical whether the front end is the
 * terminal (`cli.ts`) or the HTTP server (`server.ts`). That assembly lives
 * here so neither front end duplicates it, and so the canonical list of
 * built-in extensions has exactly one home.
 *
 * This file is a *host*, not part of the kernel: it has opinions (which
 * providers, which extensions). The kernel stays oblivious.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Agent } from "./kernel/agent.js";
import { CapabilityManager } from "./kernel/capabilities.js";
import { CommandRegistry } from "./kernel/commands.js";
import { ExtensionHost } from "./kernel/extension.js";
import { FileBackend } from "./kernel/store.js";
import type { Logger, UI } from "./kernel/types.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { GeminiProvider } from "./providers/gemini.js";
import { MockProvider } from "./providers/mock.js";

import coreTools from "./extensions/core-tools.js";
import skills from "./extensions/skills.js";
import mcp from "./extensions/mcp.js";
import codeact from "./extensions/codeact.js";
import subagents from "./extensions/subagents.js";
import memory from "./extensions/memory.js";
import planmode from "./extensions/planmode.js";
import session from "./extensions/session.js";
import packages from "./extensions/packages.js";
import trace from "./extensions/trace.js";
import contextFiles from "./extensions/context-files.js";
import limits from "./extensions/limits.js";
import self from "./extensions/self.js";
import web from "./extensions/web.js";
import checkpoint from "./extensions/checkpoint.js";
import introspect from "./extensions/introspect.js";
import journal from "./extensions/journal.js";
import promptsExt from "./extensions/prompts.js";
import flowGuard from "./extensions/flow-guard.js";
import integrity from "./extensions/integrity.js";
import type { ActivateFn } from "./kernel/extension.js";

/** The canonical built-in extension set, in load order. */
export const BUILTIN_EXTENSIONS: [string, ActivateFn][] = [
  ["core-tools", coreTools],
  ["skills", skills],
  ["mcp", mcp],
  ["codeact", codeact],
  ["subagents", subagents],
  ["memory", memory],
  ["planmode", planmode],
  ["session", session],
  ["packages", packages],
  ["trace", trace],
  ["context-files", contextFiles],
  ["limits", limits],
  ["self", self],
  ["web", web],
  ["checkpoint", checkpoint],
  ["introspect", introspect],
  ["journal", journal],
  ["prompts", promptsExt],
  ["flow-guard", flowGuard],
  ["integrity", integrity],
];

export interface AgentHostOptions {
  provider?: string;
  model?: string;
  yolo?: boolean;
  ui?: UI;
  logger?: Logger;
  /** Root for the file-backed extension store. Default `~/.eagent/state`. */
  storeRoot?: string;
  /** Directories to auto-discover extensions from. Default project + user dirs. */
  discoverDirs?: string[];
  /** Extra extension files to load by path. */
  extraExtensions?: string[];
}

export interface AgentHost {
  agent: Agent;
  host: ExtensionHost;
  commands: CommandRegistry;
  /** Whether a live (non-mock) provider is the default. */
  live: boolean;
  /** The resolved default model. */
  model: string;
}

/**
 * Build a fully-wired agent: providers selected from configuration, the
 * extension host, and every built-in extension loaded. Does not emit
 * `session_start` or register front-end commands — the caller controls that so
 * it can wire rendering first.
 */
export async function createAgentHost(opts: AgentHostOptions = {}): Promise<AgentHost> {
  const anthropic = new AnthropicProvider();
  const openai = new OpenAIProvider();
  const gemini = new GeminiProvider();
  const defaultProvider = selectProvider(opts.provider, {
    anthropic: anthropic.configured,
    openai: openai.configured,
    gemini: gemini.configured,
  });
  const live = defaultProvider !== "mock";
  // An explicit --model wins; otherwise honor a per-provider *_MODEL env var
  // (so a configured endpoint's model, e.g. OPENAI_MODEL=GLM-5.1, is used
  // without forcing --model on every call); finally fall back to a sane default.
  const model =
    opts.model ??
    (defaultProvider === "anthropic"
      ? process.env.ANTHROPIC_MODEL ?? "claude-fable-5"
      : defaultProvider === "openai"
        ? process.env.OPENAI_MODEL ?? "gpt-4o"
        : defaultProvider === "gemini"
          ? process.env.GEMINI_MODEL ?? "gemini-2.0-flash"
          : "mock");

  const capabilities = new CapabilityManager({
    ui: opts.ui,
    grant: ["fs:read", "fs:write", "skill:read"],
    fallback: opts.yolo ? "allow" : "ask",
  });

  const commands = new CommandRegistry();
  const agent = new Agent({
    ui: opts.ui,
    logger: opts.logger,
    capabilities,
    model,
    provider: defaultProvider,
  });

  agent.providers.register(new MockProvider(), { default: defaultProvider === "mock" });
  if (anthropic.configured) agent.providers.register(anthropic, { default: defaultProvider === "anthropic" });
  if (openai.configured) agent.providers.register(openai, { default: defaultProvider === "openai" });
  if (gemini.configured) agent.providers.register(gemini, { default: defaultProvider === "gemini" });

  // Fail fast on a provider that will never be registered (a typo'd --provider,
  // or a live provider with no API key) rather than starting up and throwing on
  // the first turn with a cryptic "no provider registered" error.
  if (!agent.providers.get(defaultProvider)) {
    throw new Error(
      `provider "${defaultProvider}" is not available. Choose anthropic | openai | gemini | mock, ` +
        `and set the matching API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) for a live provider.`,
    );
  }

  const host = new ExtensionHost({
    agent,
    commands,
    logger: opts.logger,
    store: new FileBackend(opts.storeRoot ?? join(homedir(), ".eagent", "state")),
  });

  // A failing built-in must not take down the whole agent: log and skip it.
  for (const [id, activate] of BUILTIN_EXTENSIONS) {
    try {
      await host.use(id, activate);
    } catch (err) {
      (opts.logger ?? console).error?.(`extension "${id}" failed to activate:`, err);
    }
  }

  const dirs = opts.discoverDirs ?? [
    join(process.cwd(), ".eagent", "extensions"),
    join(homedir(), ".eagent", "extensions"),
  ];
  await host.discover(dirs);
  for (const path of opts.extraExtensions ?? []) await host.loadFile(path);

  return { agent, host, commands, live, model };
}

/**
 * Load environment variables from a `.env` file into `process.env` *without*
 * overriding values already present (the real environment always wins). A tiny
 * zero-dependency parser: `KEY=VALUE` lines, `#` comments, an optional `export`
 * prefix, and optional surrounding quotes — enough for local development.
 *
 * Hosts call this at startup so a key dropped into `.env` is actually picked up
 * (providers read `process.env` directly). A missing file is a silent no-op.
 * Returns the names of the variables it set, for diagnostics.
 */
export function loadEnvFile(file: string = join(process.cwd(), ".env")): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const setKeys: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key in process.env) continue; // never override the real environment
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    setKeys.push(key);
  }
  return setKeys;
}

/** Resolve which provider to default to given the user's flag and what's configured. */
export function selectProvider(
  requested: string | undefined,
  configured: { anthropic: boolean; openai: boolean; gemini: boolean },
): string {
  if (requested === "mock") return "mock";
  if (requested === "anthropic" && configured.anthropic) return "anthropic";
  if (requested === "openai" && configured.openai) return "openai";
  if (requested === "gemini" && configured.gemini) return "gemini";
  const known = ["anthropic", "openai", "gemini", "mock"];
  if (requested && !known.includes(requested)) return requested;
  if (configured.anthropic) return "anthropic";
  if (configured.openai) return "openai";
  if (configured.gemini) return "gemini";
  return "mock";
}
