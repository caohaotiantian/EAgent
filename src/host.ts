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
import type { Config } from "./kernel/store.js";
import { FileBackend } from "./kernel/store.js";
import { LayeredConfig, loadConfigFile } from "./config.js";
import type { Logger, ThinkingLevel, UI } from "./kernel/types.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { GeminiProvider } from "./providers/gemini.js";
import { MockProvider } from "./providers/mock.js";

import coreTools from "./extensions/core-tools.js";
import search from "./extensions/search.js";
import skills from "./extensions/skills.js";
import mcp from "./extensions/mcp.js";
import codeact from "./extensions/codeact.js";
import subagents from "./extensions/subagents.js";
import dynamicWorkflow from "./extensions/dynamic-workflow.js";
import templates from "./extensions/templates.js";
import teams from "./extensions/teams.js";
import memory from "./extensions/memory.js";
import prune from "./extensions/prune.js";
import compact from "./extensions/compact.js";
import recovery from "./extensions/recovery.js";
import outputContract from "./extensions/output-contract.js";
import contentGuard from "./extensions/content-guard.js";
import provenance from "./extensions/provenance.js";
import circuitBreaker from "./extensions/circuit-breaker.js";
import planmode from "./extensions/planmode.js";
import session from "./extensions/session.js";
import packages from "./extensions/packages.js";
import trace from "./extensions/trace.js";
import contextFiles from "./extensions/context-files.js";
import microagents from "./extensions/microagents.js";
import limits from "./extensions/limits.js";
import cost from "./extensions/cost.js";
import self from "./extensions/self.js";
import web from "./extensions/web.js";
import checkpoint from "./extensions/checkpoint.js";
import introspect from "./extensions/introspect.js";
import journal from "./extensions/journal.js";
import todo from "./extensions/todo.js";
import promptsExt from "./extensions/prompts.js";
import flowGuard from "./extensions/flow-guard.js";
import riskGuard from "./extensions/risk-guard.js";
import bashPolicy from "./extensions/bash-policy.js";
import integrity from "./extensions/integrity.js";
import writeGuard from "./extensions/write-guard.js";
import secretGuard from "./extensions/secret-guard.js";
import sweepEdit from "./extensions/sweep-edit.js";
import citations from "./extensions/citations.js";
import envReport from "./extensions/env-report.js";
import evals from "./extensions/evals.js";
import handoff from "./extensions/handoff.js";
import driftProbe from "./extensions/drift-probe.js";
import skillsHardening from "./extensions/skills-hardening.js";
import ask from "./extensions/ask.js";
import routing from "./extensions/routing.js";
import fallbackRouting from "./extensions/fallback-routing.js";
import reliability from "./extensions/reliability.js";
import headlessFlags from "./extensions/headless-flags.js";
import sandboxTiers from "./extensions/sandbox-tiers.js";
import configHooks from "./extensions/config-hooks.js";
import budgetCap from "./extensions/budget-cap.js";
import goal from "./extensions/goal.js";
import timeTravel from "./extensions/time-travel.js";
import otelExporter from "./extensions/otel-exporter.js";
import reasoningSearch from "./extensions/reasoning-search.js";
import selfImprove from "./extensions/self-improve.js";
import configCmd from "./extensions/config-cmd.js";
import type { ActivateFn } from "./kernel/extension.js";

/** The canonical built-in extension set, in load order. */
export const BUILTIN_EXTENSIONS: [string, ActivateFn][] = [
  ["core-tools", coreTools],
  ["search", search],
  ["skills", skills],
  ["mcp", mcp],
  ["codeact", codeact],
  ["subagents", subagents],
  ["dynamic-workflow", dynamicWorkflow],
  ["templates", templates],
  ["teams", teams],
  ["memory", memory],
  ["prune", prune],
  ["compact", compact],
  ["recovery", recovery],
  ["output-contract", outputContract],
  ["content-guard", contentGuard],
  ["provenance", provenance],
  ["circuit-breaker", circuitBreaker],
  ["planmode", planmode],
  ["session", session],
  ["packages", packages],
  ["trace", trace],
  ["context-files", contextFiles],
  ["microagents", microagents],
  ["limits", limits],
  ["cost", cost],
  ["budget-cap", budgetCap],
  ["self", self],
  ["web", web],
  ["checkpoint", checkpoint],
  ["introspect", introspect],
  ["journal", journal],
  ["todo", todo],
  ["goal", goal],
  ["prompts", promptsExt],
  ["flow-guard", flowGuard],
  ["risk-guard", riskGuard],
  ["headless-flags", headlessFlags],
  ["bash-policy", bashPolicy],
  ["sandbox-tiers", sandboxTiers],
  ["config-hooks", configHooks],
  ["integrity", integrity],
  ["write-guard", writeGuard],
  ["secret-guard", secretGuard],
  ["sweep-edit", sweepEdit],
  ["citations", citations],
  ["env-report", envReport],
  ["evals", evals],
  ["handoff", handoff],
  ["drift-probe", driftProbe],
  ["skills-hardening", skillsHardening],
  ["ask", ask],
  ["routing", routing],
  ["fallback-routing", fallbackRouting],
  ["reliability", reliability],
  ["time-travel", timeTravel],
  ["otel-exporter", otelExporter],
  ["reasoning-search", reasoningSearch],
  ["self-improve", selfImprove],
  ["config", configCmd],
];

/** The provider names EAgent recognizes, shared by selection and completion. */
export const PROVIDER_NAMES = ["anthropic", "openai", "gemini", "mock"] as const;

export interface AgentHostOptions {
  provider?: string;
  model?: string;
  /** Reasoning effort; falls back to the `EAGENT_THINKING` env var, else `off`. */
  thinking?: ThinkingLevel;
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
  /** Built-in extensions that failed to activate (logged and skipped, not fatal). */
  failures: { id: string; err: unknown }[];
  /** The layered config the host resolved from; front ends source server knobs from it. */
  config: Config;
}

/**
 * Build a fully-wired agent: providers selected from configuration, the
 * extension host, and every built-in extension loaded. Does not emit
 * `session_start` or register front-end commands — the caller controls that so
 * it can wire rendering first.
 */
export async function createAgentHost(opts: AgentHostOptions = {}): Promise<AgentHost> {
  // The layered config is built first so provider/agent defaults resolve through
  // it (override > env > file > default) instead of scattered `process.env` reads.
  const storeBackend = new FileBackend(opts.storeRoot ?? join(homedir(), ".eagent", "state"));
  const configPaths = [
    join(homedir(), ".eagent", "config.json"),
    join(process.cwd(), ".eagent", "config.json"),
  ];
  const config = new LayeredConfig({
    fileValues: loadConfigFile(configPaths),
    overrideStore: storeBackend.open("config"),
    filePaths: configPaths,
  });

  const anthropic = new AnthropicProvider({ baseUrl: config.string("providers.anthropic.baseUrl") });
  const openai = new OpenAIProvider({ baseUrl: config.string("providers.openai.baseUrl") });
  const gemini = new GeminiProvider({ baseUrl: config.string("providers.gemini.baseUrl") });
  const configured = { anthropic: anthropic.configured, openai: openai.configured, gemini: gemini.configured };
  // Fail fast on an explicitly-requested live provider with no API key, rather
  // than silently downgrading to another configured provider or mock (which would
  // run the wrong model/cost). `selectProvider` can't throw — it is shared with
  // tab-completion — so the check lives here, at the one place a live run is built.
  if (opts.provider && Object.hasOwn(configured, opts.provider) && !configured[opts.provider as keyof typeof configured]) {
    throw new Error(
      `provider "${opts.provider}" was requested but is not configured. Set the matching API key ` +
        `(ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY), pick a different --provider, or use mock.`,
    );
  }
  const defaultProvider = selectProvider(opts.provider, configured);
  const live = defaultProvider !== "mock";
  // An explicit --model wins; otherwise the per-provider model config key (whose
  // legacy env alias is `*_MODEL`) is honored so a configured endpoint's model is
  // used without forcing --model on every call; finally a sane default.
  const model =
    opts.model ??
    (defaultProvider === "anthropic"
      ? config.string("models.anthropic") ?? "claude-fable-5"
      : defaultProvider === "openai"
        ? config.string("models.openai") ?? "gpt-4o"
        : defaultProvider === "gemini"
          ? config.string("models.gemini") ?? "gemini-2.0-flash"
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
    thinking: opts.thinking ?? thinkingFromEnv(config.string("thinking")),
    maxTurns: config.int("agent.maxTurns", 24),
    maxConcurrency: config.int("agent.maxConcurrency", 0) || Infinity,
    systemPrompt: config.string("agent.systemPrompt"),
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
    store: storeBackend,
    config,
  });

  // A failing built-in must not take down the whole agent: log, record, and skip it.
  const failures: { id: string; err: unknown }[] = [];
  for (const [id, activate] of BUILTIN_EXTENSIONS) {
    try {
      await host.use(id, activate);
    } catch (err) {
      (opts.logger ?? console).error?.(`extension "${id}" failed to activate:`, err);
      failures.push({ id, err });
    }
  }

  // User-global first, project-local last: discover() loads in order and a later
  // registration wins on an id collision, so listing the project dir last gives
  // it precedence over the user dir (the project-over-user model the discover()
  // contract documents).
  const dirs = opts.discoverDirs ?? [
    join(homedir(), ".eagent", "extensions"),
    join(process.cwd(), ".eagent", "extensions"),
  ];
  await host.discover(dirs);
  for (const path of opts.extraExtensions ?? []) await host.loadFile(path);

  return { agent, host, commands, live, model, failures, config };
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

/** Parse a thinking level from a string (env/flag), ignoring anything unknown. */
export function thinkingFromEnv(value: string | undefined): ThinkingLevel {
  const v = value?.trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" || v === "off" ? v : "off";
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
  const known: readonly string[] = PROVIDER_NAMES;
  if (requested && !known.includes(requested)) return requested;
  if (configured.anthropic) return "anthropic";
  if (configured.openai) return "openai";
  if (configured.gemini) return "gemini";
  return "mock";
}
