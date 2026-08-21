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

import { Agent } from "./kernel/agent.ts";
import { CapabilityManager } from "./kernel/capabilities.ts";
import { CommandRegistry } from "./kernel/commands.ts";
import { ExtensionHost } from "./kernel/extension.ts";
import type { Config } from "./kernel/store.ts";
import { FileBackend } from "./kernel/store.ts";
import { LayeredConfig, loadConfigFile } from "./config.ts";
import { detectBackend, binExists, isBackend, type Backend } from "./extensions/lib/sandbox.ts";
import type { Logger, ThinkingLevel, UI } from "./kernel/types.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { GeminiProvider } from "./providers/gemini.ts";
import { MockProvider } from "./providers/mock.ts";

import coreTools from "./extensions/core-tools.ts";
import search from "./extensions/search.ts";
import skills from "./extensions/skills.ts";
import mcp from "./extensions/mcp.ts";
import codeact from "./extensions/codeact.ts";
import subagents from "./extensions/subagents.ts";
import subagentJobs from "./extensions/subagent-jobs.ts";
import dynamicWorkflow from "./extensions/dynamic-workflow.ts";
import templates from "./extensions/templates.ts";
import teams from "./extensions/teams.ts";
import library from "./extensions/library.ts";
import memory from "./extensions/memory.ts";
import prune from "./extensions/prune.ts";
import compact from "./extensions/compact.ts";
import recovery from "./extensions/recovery.ts";
import outputContract from "./extensions/output-contract.ts";
import contentGuard from "./extensions/content-guard.ts";
import provenance from "./extensions/provenance.ts";
import circuitBreaker from "./extensions/circuit-breaker.ts";
import planmode from "./extensions/planmode.ts";
import session from "./extensions/session.ts";
import packages from "./extensions/packages.ts";
import trace from "./extensions/trace.ts";
import contextFiles from "./extensions/context-files.ts";
import microagents from "./extensions/microagents.ts";
import playbook from "./extensions/playbook.ts";
import limits from "./extensions/limits.ts";
import cost from "./extensions/cost.ts";
import self from "./extensions/self.ts";
import web from "./extensions/web.ts";
import checkpoint from "./extensions/checkpoint.ts";
import introspect from "./extensions/introspect.ts";
import journal from "./extensions/journal.ts";
import todo from "./extensions/todo.ts";
import promptsExt from "./extensions/prompts.ts";
import flowGuard from "./extensions/flow-guard.ts";
import riskGuard from "./extensions/risk-guard.ts";
import bashPolicy from "./extensions/bash-policy.ts";
import integrity from "./extensions/integrity.ts";
import writeGuard from "./extensions/write-guard.ts";
import secretGuard from "./extensions/secret-guard.ts";
import sweepEdit from "./extensions/sweep-edit.ts";
import citations from "./extensions/citations.ts";
import envReport from "./extensions/env-report.ts";
import evals from "./extensions/evals.ts";
import handoff from "./extensions/handoff.ts";
import driftProbe from "./extensions/drift-probe.ts";
import autocontinue from "./extensions/autocontinue.ts";
import skillsHardening from "./extensions/skills-hardening.ts";
import ask from "./extensions/ask.ts";
import routing from "./extensions/routing.ts";
import watchdog from "./extensions/watchdog.ts";
import fallbackRouting from "./extensions/fallback-routing.ts";
import reliability from "./extensions/reliability.ts";
import headlessFlags from "./extensions/headless-flags.ts";
import sandboxTiers from "./extensions/sandbox-tiers.ts";
import configHooks from "./extensions/config-hooks.ts";
import budgetCap from "./extensions/budget-cap.ts";
import goal from "./extensions/goal.ts";
import timeTravel from "./extensions/time-travel.ts";
import otelExporter from "./extensions/otel-exporter.ts";
import reasoningSearch from "./extensions/reasoning-search.ts";
import selfImprove from "./extensions/self-improve.ts";
import selfExtendFloor from "./extensions/self-extend-floor.ts";
import configCmd from "./extensions/config-cmd.ts";
import type { ActivateFn } from "./kernel/extension.ts";

/** The canonical built-in extension set, in load order. */
export const BUILTIN_EXTENSIONS: [string, ActivateFn][] = [
  ["core-tools", coreTools],
  ["search", search],
  ["skills", skills],
  ["mcp", mcp],
  ["codeact", codeact],
  ["subagents", subagents],
  ["subagent-jobs", subagentJobs],
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
  ["library", library],
  ["playbook", playbook],
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
  ["autocontinue", autocontinue],
  ["skills-hardening", skillsHardening],
  ["ask", ask],
  ["routing", routing],
  ["watchdog", watchdog],
  ["fallback-routing", fallbackRouting],
  ["reliability", reliability],
  ["time-travel", timeTravel],
  ["otel-exporter", otelExporter],
  ["reasoning-search", reasoningSearch],
  ["self-improve", selfImprove],
  ["self-extend-floor", selfExtendFloor],
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
  /** Opt into the hardened defense-in-depth profile (enable the enforcing
   *  guards + confine the shell). Falls back to the `hardened` config key
   *  (`EAGENT_HARDENED`). Orthogonal to `yolo` — it does not touch the
   *  capability fallback. See SECURITY.md. */
  hardened?: boolean;
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
    // Committed project defaults at the repo root (eagent.config.json, if a repo
    // ships one). Project-over-user, so it beats the user-global config above; the
    // local .eagent/config.json below and env/overrides still win.
    join(process.cwd(), "eagent.config.json"),
    join(process.cwd(), ".eagent", "config.json"),
  ];
  const config = new LayeredConfig({
    fileValues: loadConfigFile(configPaths),
    overrideStore: storeBackend.open("config"),
    filePaths: configPaths,
  });

  // The hardened profile is a runtime, in-memory preset that enables the
  // enforcing guards (risk-guard, provenance) and confines the shell to the
  // workspace. It is resolved from the already-built config — so `EAGENT_HARDENED`
  // and the file key `hardened` both work with env winning — and is fail-secure:
  // the env layer still overrides each preset key, and nothing is persisted.
  const hardened = opts.hardened ?? config.bool("hardened", false);
  if (hardened) {
    config.setPreset({ "risk-guard": true, provenance: true, "sandbox.tier": "workspace-write", "contentGuard.fenceLocal": true });
    announceHardened(config, opts.logger);
  }

  const { anthropic, openai, gemini } = buildProviders(config);
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
 * Construct the three real providers from configuration. Extracted from
 * `createAgentHost` so the exact construction the host uses is offline-testable
 * (a production `new AnthropicProvider(...)` line is not: offline there is no API
 * key, so `createAgentHost` selects the mock provider and never builds these).
 * `providers.<name>.maxTokens` sets the output cap (default 8192); `opts.fetch`
 * is forwarded so a test can inject a capturing `fetch`.
 */
export function buildProviders(
  config: Config,
  opts: { fetch?: typeof fetch } = {},
): { anthropic: AnthropicProvider; openai: OpenAIProvider; gemini: GeminiProvider } {
  return {
    anthropic: new AnthropicProvider({
      baseUrl: config.string("providers.anthropic.baseUrl"),
      maxTokens: config.int("providers.anthropic.maxTokens", 8192),
      fetch: opts.fetch,
    }),
    openai: new OpenAIProvider({
      baseUrl: config.string("providers.openai.baseUrl"),
      maxTokens: config.int("providers.openai.maxTokens", 8192),
      fetch: opts.fetch,
    }),
    gemini: new GeminiProvider({
      baseUrl: config.string("providers.gemini.baseUrl"),
      maxTokens: config.int("providers.gemini.maxTokens", 8192),
      fetch: opts.fetch,
    }),
  };
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

/**
 * Log the one-line hardened banner: the guards it enabled and the RESOLVED
 * sandbox tier (read from config, so an `EAGENT_SANDBOX_TIER` override reads
 * truthfully instead of a hardcoded string). When no sandbox backend is
 * detected on this host, warn that the tier fail-opens — shell runs unsandboxed
 * (the R1 caveat; `sandbox-tiers` defaults `missingBackend="pass"`).
 */
function announceHardened(config: Config, logger?: Logger): void {
  const log = logger ?? console;
  const tier = config.string("sandbox.tier");
  log.info?.(
    `hardened profile active: risk-guard + provenance + content-guard local fencing enabled; sandbox tier=${tier}`,
  );
  const forced = config.string("sandbox.backend");
  const backend: Backend = forced && isBackend(forced) ? forced : detectBackend(process.platform, binExists);
  if (backend === "none") {
    log.warn?.(
      `hardened: no sandbox backend detected on this host — shell commands run unsandboxed (tier=${tier} is fail-open)`,
    );
  }
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
