#!/usr/bin/env node
/**
 * The `loom` command.
 *
 * Its most important job is to make DoD item 6 demonstrable: **boot from a single
 * binary with an empty data directory and no external service.** Everything else the
 * CLI does is in service of being able to prove that by running a real graph.
 *
 * Graphs are JSON here, not YAML: `@loom/core` never parses YAML, which is what keeps
 * it zero-dependency and keeps hashing unambiguous (canonical JSON has exactly one
 * representation of a document; YAML has several). A `loom fmt` that converts YAML to
 * JSON belongs in a CLI-only package that may take the dependency.
 */

import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { InProcessEventBus } from "./bus.ts";
import { isLoomError, toLoomError } from "./errors.ts";
import { parseYamlSpec } from "./graph/yaml.ts";
import { compile } from "./graph/compile.ts";
import type { GraphSpec, RunGraph } from "./graph/spec.ts";
import type { ResourceResolver } from "./graph/validate.ts";
import { SqliteStateStore } from "./journal/sqlite.ts";
import { builtinTools, fsRestore } from "./builtin/tools.ts";
import { Engine } from "./run/engine.ts";
import {
  ConsoleChannel,
  GateDispatcher,
  SignedWebhookChannel,
  WebhookChannel,
  type DeliveryChannel,
  type WebhookChannelOptions,
} from "./run/delivery.ts";
import { HumanGateBroker } from "./run/gates.ts";
import {
  FunctionRegistry,
  ModelRegistry,
  MockModelAdapter,
  ToolRegistry,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "./run/registry.ts";
import { AnthropicAdapter } from "./providers/anthropic.ts";
import { OpenAIAdapter } from "./providers/openai.ts";
import type { HttpOptions } from "./providers/http.ts";
import { replayRun } from "./run/replay.ts";
import { BearerTokenIdentity, ControlPlane, unanswerableGraphs, type ControlPlaneOptions, type IdentitySource } from "./server/http.ts";
import { CODES, err } from "./errors.ts";
import { isSyntheticSubject } from "./vocab.ts";
import { conformsToGraph, reconstructGraph, spansFrom } from "./telemetry/spans.ts";
import type { GateId, RunId } from "./ids.ts";
import type { HumanActor } from "./journal/events.ts";

const USAGE = `loom — graph-native multi-agent orchestration

  loom serve   [--workspace .] [--port 8787] [--token T]   start the control plane
               [--identity-file identities.json]           who may approve, one token each
               [--channels-file channels.json]             how gates reach humans, and how
                                                           humans answer them
               [--sweep-ms 1000]                           how often gate SLAs are checked
  loom compile <graph.json|yaml>                           validate and print diagnostics
  loom run     <graph.json|yaml> [--input JSON]            run to completion or to a gate
  loom gates   <runId>                                     list open gates
  loom approve <runId> <gateId> [--reject REASON]          resolve a gate
  loom replay  <runId> --graph <graph.json|yaml>           replay and verify
  loom trace   <runId> --graph <graph.json|yaml>           print the span tree

  --workspace DIR   root for graphs/, data, and the tool jail (default: cwd)
  --data-dir  DIR   journal location (default: <workspace>/.loom). Off limits to the
                    fs tools wherever it is put, including inside the workspace.
  --models-file F   which providers to call, and which model each ModelRequest.model
                    goes to. Without it every agent node answers "[mock] …". The API
                    key is named by the file and READ FROM THE ENVIRONMENT, never
                    stored in it. Accepted by every command, not just serve.
  --allow-exec P,P  programs proc.exec may run, matched EXACTLY by name — not as a
                    prefix, not as a path. Without it the tool is not registered and
                    the run cannot execute anything. This list is the whole boundary:
                    a child process does its own open(), so allow-listing a shell
                    dissolves the fs jail rather than narrowing it.
  --exec-env  N,N   environment variable NAMES proc.exec passes to the child. Default
                    is an empty environment, because this process holds API keys.
`;

/**
 * A file, not a flag — the same rule `--identity-file` follows, for the same reason.
 *
 * A signing secret in argv is a signing secret every local user can read out of `ps` for
 * the life of the process. `--channels-file` is therefore the ONLY way to configure one,
 * and there is deliberately no `--callback-secret`: a second spelling of a secret is a
 * second way to leak it.
 *
 * `callbackBaseUrl` rides in the same file rather than in a flag even though it is not a
 * secret, because it is one half of a pair — an address is only useful with the secret
 * that signs for it — and a configuration split across a file and argv is one an operator
 * gets half right.
 */
export interface DeliveryConfig {
  /** Delivers gates outbound. Also what opens the inbound route, when anyone can answer. */
  readonly dispatcher: GateDispatcher;
  /** Channels that can be ANSWERED: they carry a secret, so they have `parseCallback`. */
  readonly answerable: readonly string[];
  /** Channels that can only be TOLD. A pager is legitimately one of these. */
  readonly notifyOnly: readonly string[];
  /** Whether a public base URL was configured, i.e. whether delivered gates say where to answer. */
  readonly publishesAddress: boolean;
  /** The resolved path, so every message can name the file the operator edited. */
  readonly file: string;
}

interface Args {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

/**
 * `kind/name@selector` — the shape `graph/spec.ts` documents for a `ResourceRef` — written
 * ONCE and used two ways.
 *
 * The whole-string form is what this deployment's stand-in resolver accepts. The scanning
 * form answers a different question that turned out to matter more: *has a ref reached a
 * place that wanted a resolved value?* `engine.ts`'s `#runAgent` puts `agent.profile` straight into
 * `ModelRequest.model`, so `agent_profile/summarizer@stable` is what a provider is asked to
 * run, and nothing between the graph and the socket looks at it. A provider rejects that
 * as an unknown model — at runtime, in production, having already been sent the prompt.
 * `test/helpers/strict-doubles.ts` reaches the same verdict offline as a red test, and
 * `readModels` reaches it at the boundary, before a socket exists.
 *
 * Two RegExps and one pattern string, rather than two patterns: the second copy is exactly
 * the artifact this repo keeps finding drifted from the first. The scanning one is rebuilt
 * per call because a `g` RegExp carries `lastIndex` between calls, and a shared one would
 * make the answer depend on who asked last.
 */
const RESOURCE_REF_PATTERN = "[a-z_]+/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+";
export const RESOURCE_REF = new RegExp(`^${RESOURCE_REF_PATTERN}$`);

/** Every `kind/name@selector` occurring anywhere in `text`, in order, deduplicated. */
export function resourceRefsIn(text: string): readonly string[] {
  return [...new Set(text.match(new RegExp(RESOURCE_REF_PATTERN, "g")) ?? [])];
}

/**
 * `--name value` AND `--name=value`, because not understanding the second one is a
 * security bug rather than an ergonomic gap.
 *
 * Parsing only the space-separated form does not fail loudly — it registers a flag
 * literally NAMED `token=s3cret` and leaves `flags["token"]` undefined. Every caller then
 * reads the flag as absent, and for `--token` absent means "run an open plane on purpose":
 * `loom serve --token=s3cret` started a control plane that authorized every caller, using
 * the most common flag convention there is, with the secret sitting in the argv the
 * operator can see. The guard below refuses the two ways `--token` arrives EMPTY; it never
 * saw this one, because the flag did not arrive at all.
 *
 * Split at the FIRST `=` only, so a value containing one survives intact — a token, a URL
 * with a query string, and a base64 blob all routinely contain `=`.
 */
export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 2) {
      // `--name=` yields "", which is a value the caller gave. It is NOT the same as an
      // absent flag, and the `--token` guard depends on being able to tell them apart.
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return { command: positional[0] ?? "help", positional: positional.slice(1), flags };
}

interface Workspace {
  readonly root: string;
  readonly dataDir: string;
  readonly store: SqliteStateStore;
  readonly engine: Engine;
  readonly bus: InProcessEventBus;
  readonly resolver: ResourceResolver;
  /** `undefined` when `--channels-file` was not given: no channels, and no callback route. */
  readonly delivery: DeliveryConfig | undefined;
  /** `undefined` when `--models-file` was not given: the mock is the only adapter. */
  readonly models: ModelConfig | undefined;
  close(): void;
}

/**
 * Build everything from a directory that may not exist yet.
 *
 * This is the "empty data directory" path: it creates the tree, opens a fresh SQLite
 * journal, registers the built-in tools against a jail, and returns a working engine.
 * No service, no migration step, no configuration file required.
 */
export function openWorkspace(args: Args, env: Readonly<Record<string, string | undefined>> = process.env): Workspace {
  // BEFORE ANYTHING IS CREATED OR OPENED. A malformed channels file is a refusal to start,
  // and a refusal that has already made a directory and opened a SQLite handle is a
  // refusal that leaks one — `main`'s `finally` only closes a workspace it was handed.
  const delivery = args.flags["channels-file"] === undefined ? undefined : readChannels(requireFileFlag(args, "channels-file"));
  // Same rule, same reason: a models file naming an env var that is not set is a refusal
  // to start, and it must happen before the journal is opened. `env` is a PARAMETER so a
  // test can hand this function a key without writing one into the process — the same
  // injection every clock and id source in this codebase takes, applied to the one input
  // that is a credential.
  const models = args.flags["models-file"] === undefined ? undefined : readModels(requireFileFlag(args, "models-file"), env);

  // `pathFlag`, not `String(… ?? default)`. `String(true)` is `"true"`, so `--workspace`
  // with no value used to resolve to `./true` and `loom compile g.json --workspace` printed
  // `ok` and exited 0 having created a directory called `true` holding `.loom/journal.db`
  // and `graphs/`. That is the quietest member of the `String(true)` family — `--token` and
  // `--port` were caught because their wrong value is dangerous, and these two were missed
  // because their wrong value WORKS — and it is the one that moves the journal, which
  // invariant 2 makes the only authoritative durable state. A run submitted into `./true`
  // is unrecoverable by anyone who does not know the flag was disregarded, and
  // `loom gates <runId>` in the intended workspace answers `[]`.
  const root = resolve(pathFlag(args, "workspace") ?? process.cwd());
  const dataDir = resolve(pathFlag(args, "data-dir") ?? join(root, ".loom"));
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, "graphs"), { recursive: true });

  const store = new SqliteStateStore({ path: join(dataDir, "journal.db") });
  const bus = new InProcessEventBus({ store });

  const tools = new ToolRegistry();
  // THE JAIL ROOT CONTAINS THE JOURNAL, so containment alone is not the boundary.
  //
  // `root` is the workspace and `dataDir` defaults to `<root>/.loom`, so `journal.db` —
  // the only authoritative durable state there is (invariant 2) — sits inside the
  // directory a model may write to, with `fs:write` granted below and
  // `reversible_write` meaning no gate. Measured before this line existed: a `tool` node
  // with `fs.write {path: ".loom/journal.db"}` reported `status: "succeeded"` having
  // truncated the database, and `fs.read` of the same path hands back everything ever
  // journaled — including secrets that arrived as run inputs — past every redaction the
  // event path applies.
  //
  // THE FIX IS THE DENY-LIST, NOT A DIFFERENT DEFAULT LOCATION, and the reason is
  // `--data-dir`: an operator may put the journal anywhere, including deliberately
  // inside the workspace, so a rule that depends on where the default happens to fall
  // protects only the default. Deriving the denial from the data dir that was ACTUALLY
  // chosen covers every spelling, and it keeps `.loom` beside the graphs it belongs to —
  // one directory to copy, archive or delete, which is the whole ergonomic story of
  // "boot from an empty directory". Moving the journal out as well would buy no safety
  // this line does not already give and would hide the run's own history from the person
  // looking for it.
  const jail = {
    root,
    deny: [dataDir],
    ...(args.flags["egress"] === undefined ? {} : { egressAllowlist: String(args.flags["egress"]).split(",") }),
    // Both default to absent, and absent means the tool is not registered at all. A run
    // that never names a program cannot run one — see `procExec`, where the allowlist is
    // the entire boundary rather than one check among several.
    ...(args.flags["allow-exec"] === undefined ? {} : { execAllowlist: String(args.flags["allow-exec"]).split(",") }),
    ...(args.flags["exec-env"] === undefined ? {} : { execEnvAllow: String(args.flags["exec-env"]).split(",") }),
  };
  for (const t of builtinTools(jail)) tools.register(t);
  tools.register(fsRestore(jail));

  const modelRegistry = new ModelRegistry();
  // OFFLINE BY DEFAULT, AND ONLY ONE OF THE TWO IS EVER REGISTERED.
  //
  // The mock is what makes `loom run` work on a fresh machine with no API key. It is also
  // the reason this binary could not call a model at all until `--models-file` existed —
  // `AnthropicAdapter` and `OpenAIAdapter` were constructed nowhere in `src/`.
  //
  // The file REPLACES the mock rather than joining it. Keeping both would leave the mock
  // registered under a provider name nothing ever asks for by name (`#runAgent` calls
  // `models.require()` with no argument, i.e. the default and only the default), which is
  // a registered-and-unreachable adapter — the "declared but unread" shape this repo keeps
  // finding. It also makes `announce`'s "the only adapter is the mock" line a fact about
  // the registry rather than a guess about configuration.
  modelRegistry.register(
    models?.adapter ??
      new MockModelAdapter({
        script: (req) => ({ text: `[mock] ${req.messages.at(-1)?.content.slice(0, 80) ?? ""}` }),
      }),
    true,
  );

  const engine = new Engine({
    store,
    bus,
    tools,
    functions: new FunctionRegistry(),
    models: modelRegistry,
    // THE ONE REASON THE BROKER IS CONSTRUCTED HERE: a dispatcher. `HumanGateBroker.raise`
    // delivers only when it has one AND the gate's request names channels, so without this
    // line a graph declaring `humanGate.delivery` would compile, raise a durable gate, and
    // tell nobody — the outbound half wired to a dispatcher that does not exist.
    //
    // Only when channels are configured. Otherwise the Engine's own default broker is
    // exactly right, and injecting an identical one would be a second place for the
    // broker's construction to drift from `EngineOptions`.
    ...(delivery === undefined ? {} : { gates: new HumanGateBroker({ dispatcher: delivery.dispatcher }) }),
    // systemFloor defaults to `on`: everything is observable and interruptible,
    // and irreversibility classes still force a gate where one is warranted.
    policy: { granted: ["fs:read", "fs:write", "net:fetch"] },
  });

  const resolver: ResourceResolver = {
    // Without a resource store, refs resolve to a digest of their own name. That is
    // enough for the compiler's pinning to be structurally correct locally, and it is
    // replaced by a real ResourceStore the moment one is configured.
    resolve: (ref) =>
      RESOURCE_REF.test(ref)
        ? { ref, digest: `sha256:${Buffer.from(ref).toString("hex").padEnd(64, "0").slice(0, 64)}`, channel: "stable" }
        : undefined,
  };

  return { root, dataDir, store, engine, bus, resolver, delivery, models, close: () => store.close() };
}

/**
 * Who may approve, read from a file rather than from argv.
 *
 * A file and not `--identity u:alice=secret`, because argv is world-readable through
 * `ps` on a shared host — a credential passed that way is a credential disclosed to
 * every local user for the lifetime of the process.
 *
 * The file IS `BearerTokenIdentity`'s options, so the format has exactly one definition:
 *
 *     { "subjects": [ { "subject": "u:alice", "token": "…", "via": "console" } ] }
 *
 * A malformed one refuses to start. Booting without it would leave a deployment whose
 * graphs name approvers with gates nobody can answer, discovered hours later at the
 * first 403 — which is the failure this whole change exists to stop being silent.
 */
export function readIdentities(file: string): IdentitySource {
  const path = resolve(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw err.validation(CODES.E_CONFIG_INVALID, `--identity-file ${path}: ${(e as Error).message}`);
  }
  const subjects = (parsed as { subjects?: unknown } | null)?.subjects;
  if (!Array.isArray(subjects) || subjects.length === 0) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--identity-file ${path} must be {"subjects":[{"subject":"u:you","token":"…"}]} with at least one entry`,
    );
  }
  // Field-by-field rather than a cast: this file decides who may approve, and a typo in
  // it must be a refusal to start rather than a subject named "undefined".
  return new BearerTokenIdentity({
    subjects: subjects.map((s, i) => {
      const row = s as { subject?: unknown; token?: unknown; kind?: unknown; via?: unknown; mfa?: unknown };
      if (typeof row.subject !== "string" || typeof row.token !== "string") {
        throw err.validation(CODES.E_CONFIG_INVALID, `--identity-file ${path}: entry ${i} needs a string subject and token`);
      }
      // `kind` IS REFUSED WHEN WRONG; `via` and `mfa` ARE DROPPED. The difference is not
      // style, and this line used to get it wrong by treating all three the same way.
      // Dropping is safe exactly when the value it falls back to is TRUE: a dropped `via`
      // becomes `api`, and the decision did arrive over the API; a dropped `mfa` claims
      // nothing rather than claiming `false`. A dropped `kind` becomes `human` — the
      // default `BearerSubject` documents, and the ONE kind that can satisfy a gate's
      // approvers list — so it is a STRONGER claim than the one the operator wrote.
      // Measured before this refusal: `"kind": "servce"` and `"kind": "SERVICE"` each
      // identified as `human`, turning a deployment's CI credential into a person who may
      // approve production actions. `server/http.ts`'s `checkedAuth` states the rule for
      // the injected identity seam — "fields that DECIDE … are refused when wrong" — and a
      // file is the other door to the same field.
      if (row.kind !== undefined && row.kind !== "service" && row.kind !== "human") {
        throw err.validation(
          CODES.E_CONFIG_INVALID,
          `--identity-file ${path}: entry ${i} ("${row.subject}") has kind ${JSON.stringify(row.kind)}, which must be "human" or ` +
            `"service". It is not dropped like an unknown "via", because an absent kind means "human" — the only kind that can answer ` +
            `a gate naming approvers — so a mistyped "service" would silently become a person who may approve.`,
        );
      }
      return {
        subject: row.subject,
        token: row.token,
        ...(row.kind === undefined ? {} : { kind: row.kind }),
        ...(isVia(row.via) ? { via: row.via } : {}),
        ...(typeof row.mfa === "boolean" ? { mfa: row.mfa } : {}),
      };
    }),
  });
}

/**
 * How gates reach humans, and how humans answer them — read from a file at boot.
 *
 * The shape is one row per channel, and each row is very nearly the constructor options
 * of the class it builds, so there is one definition of what a webhook channel is:
 *
 *     {
 *       "callbackBaseUrl": "https://loom.example.com",
 *       "channels": [
 *         { "name": "slack", "url": "https://hooks.slack.com/…", "callbackSecret": "…" },
 *         { "name": "pager", "url": "https://events.pagerduty.com/…" }
 *       ]
 *     }
 *
 * **`callbackSecret` IS THE SWITCH.** A row with one becomes a `SignedWebhookChannel` and
 * is ANSWERABLE — which is what opens `POST /runs/:id/callbacks/:channel`, the one route
 * reachable without the bearer token. A row without one becomes a plain `WebhookChannel`,
 * which can be told about a gate and never answers: a pager, a dashboard, an audit sink.
 * Absence is therefore a real configuration and not a mistake, and it fails CLOSED — the
 * missing half is an endpoint that does not exist, never one that exists unguarded.
 *
 * **An EMPTY secret is refused**, like `--token ""` and like `ControlPlaneOptions.token`.
 * `"callbackSecret": ""` is what an unset variable expands to in a generated config, and a
 * signed channel with signing turned off looks authenticated in a file and is not.
 *
 * **A malformed file refuses to start**, the same trade `readIdentities` makes: booting
 * anyway produces a deployment whose gates are delivered nowhere, or whose approvals
 * endpoint answers 404 — discovered hours later, at the first gate nobody was told about.
 *
 * **Duplicate names are refused**, which is the one refusal that is not about a typo being
 * dangerous but about it being INVISIBLE: `GateDispatcher` keys its channels by name in a
 * `Map`, so a second row called `slack` silently replaces the first and one configured
 * channel never delivers anything, with nothing anywhere saying so.
 */
export function readChannels(file: string): DeliveryConfig {
  const path = resolve(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw err.validation(CODES.E_CONFIG_INVALID, `--channels-file ${path}: ${(e as Error).message}`);
  }
  const refuse: (why: string) => never = (why) => {
    throw err.validation(CODES.E_CONFIG_INVALID, `--channels-file ${path}: ${why}`);
  };

  const root = (parsed ?? {}) as { channels?: unknown; callbackBaseUrl?: unknown };
  const rows = root.channels;
  if (!Array.isArray(rows) || rows.length === 0) {
    refuse(`must be {"channels":[{"name":"slack","url":"https://…","callbackSecret":"…"}]} with at least one entry`);
  }
  // Checked here as well as in `SignedWebhookChannel`, because only this layer can say
  // WHICH FILE the value came out of — and because a base URL configured for a deployment
  // with no answerable channel would otherwise be silently unused.
  const baseUrl = root.callbackBaseUrl;
  if (baseUrl !== undefined && (typeof baseUrl !== "string" || baseUrl === "")) {
    refuse(`"callbackBaseUrl" must be a non-empty string, or absent — an empty one is what an unset variable expands to`);
  }

  const channels: DeliveryChannel[] = [];
  const answerable: string[] = [];
  const notifyOnly: string[] = [];
  const seen = new Set<string>();

  rows.forEach((raw, i) => {
    const where = `entry ${i}`;
    const row = raw as Record<string, unknown> | null;
    if (typeof row !== "object" || row === null || Array.isArray(row)) refuse(`${where} is not an object`);
    const name = row["name"];
    const url = row["url"];
    if (typeof name !== "string" || name === "") refuse(`${where} needs a non-empty string "name"`);
    if (typeof url !== "string" || url === "") refuse(`${where} ("${name}") needs a non-empty string "url" to deliver to`);
    if (seen.has(name)) refuse(`${where} repeats the channel name "${name}" — a dispatcher keys channels by name, so one of them would never deliver`);
    seen.add(name);

    const common: WebhookChannelOptions = {
      name,
      url,
      ...(row["headers"] === undefined ? {} : { headers: stringMap(row["headers"], `${where} ("${name}") "headers"`, refuse) }),
      ...(row["timeoutMs"] === undefined ? {} : { timeoutMs: positive(row["timeoutMs"], `${where} ("${name}") "timeoutMs"`, refuse) }),
    };

    const secret = row["callbackSecret"];
    // PRESENT-AND-EMPTY is refused; ABSENT is a notify-only channel. The two must not
    // collapse into each other: one is a slip that would leave a signed route unsigned,
    // the other is a deliberate configuration with no inbound route at all.
    if (secret !== undefined && (typeof secret !== "string" || secret === "")) {
      refuse(
        `${where} ("${name}") has an empty or non-string "callbackSecret". A signed channel with signing turned off ` +
          `looks authenticated in a config file and is not. Give it a real secret, or omit the field entirely to make ` +
          `"${name}" a notify-only channel with no inbound route.`,
      );
    }

    try {
      if (secret === undefined) {
        channels.push(new WebhookChannel(common));
        notifyOnly.push(name);
        return;
      }
      channels.push(
        new SignedWebhookChannel({
          ...common,
          callbackSecret: secret,
          ...(baseUrl === undefined ? {} : { callbackBaseUrl: baseUrl }),
          ...(row["toleranceMs"] === undefined ? {} : { toleranceMs: positive(row["toleranceMs"], `${where} ("${name}") "toleranceMs"`, refuse) }),
          ...(row["timestampHeader"] === undefined ? {} : { timestampHeader: nonEmpty(row["timestampHeader"], `${where} ("${name}") "timestampHeader"`, refuse) }),
          ...(row["signatureHeader"] === undefined ? {} : { signatureHeader: nonEmpty(row["signatureHeader"], `${where} ("${name}") "signatureHeader"`, refuse) }),
          // Dropped rather than coerced when it is not one of the seven, exactly as
          // `readIdentities` drops an unknown `via`: it is journaled vocabulary, and a
          // typo must not become a value no fold can read.
          ...(isVia(row["via"]) ? { via: row["via"] } : {}),
        }),
      );
      answerable.push(name);
    } catch (e) {
      // A channel's own construction refusal, re-raised with the file and the row that
      // caused it. `SignedWebhookChannel` says `channel "slack" has a callbackBaseUrl
      // that …`, which is true and does not tell an operator which of their files to open.
      if (isLoomError(e) && e.code === CODES.E_CONFIG_INVALID) refuse(`${where}: ${e.message}`);
      throw e;
    }
  });

  return {
    dispatcher: new GateDispatcher({
      channels,
      // THE GATE ALWAYS LANDS SOMEWHERE. When every configured channel fails, the console
      // fallback puts it on the operator's terminal rather than letting "nobody was told"
      // be the outcome. Its `queued` array is process-lifetime — a bound worth knowing
      // about on a `serve` whose every delivery is failing, and a small one: one entry per
      // gate, and a deployment in that state has a louder problem than memory.
      fallback: new ConsoleChannel({
        sink: (line) => process.stderr.write(`! UNDELIVERED — ${line}\n`),
      }),
    }),
    answerable,
    notifyOnly,
    publishesAddress: baseUrl !== undefined && answerable.length > 0,
    file: path,
  };
}

// ---------------------------------------------------------------------------
// --models-file: the one thing that makes this binary able to call a model
// ---------------------------------------------------------------------------

/** One `ModelRequest.model` the engine can produce, and where it should actually go. */
interface Route {
  readonly adapter: string;
  readonly model: string;
}

export interface ModelConfig {
  /** The single adapter `openWorkspace` registers: a router over the declared ones. */
  readonly adapter: ModelAdapter;
  /** Declared adapter names, for the boot line. */
  readonly adapters: readonly string[];
  /** Declared route keys, for the boot line and for the router's own error message. */
  readonly routes: readonly string[];
  readonly file: string;
}

/** The two adapters this binary can construct. A typo here must not become a silent mock. */
const PROVIDERS: Readonly<Record<string, { readonly keyEnv: string }>> = {
  anthropic: { keyEnv: "ANTHROPIC_API_KEY" },
  openai: { keyEnv: "OPENAI_API_KEY" },
};

/**
 * Adapters, and where each `ModelRequest.model` should go — read from a file at boot.
 *
 * **WHY A ROUTE TABLE AND NOT JUST AN ADAPTER.** `ModelRequest.model` is not a model id
 * today and there is no code anywhere that makes it one. `engine.ts`'s `#runAgent` assigns
 * `agent.profile` verbatim, and `validate.ts`'s `rule015Resources` (GRAPH015) requires it to be a
 * `kind/name@selector` that RESOLVES — so a graph literally cannot name `claude-sonnet-5`
 * in the field the provider reads. Registering `AnthropicAdapter` and nothing else would
 * therefore have shipped a `--models-file` whose every agent node fails at the provider,
 * in production, on a request that has already left the machine carrying its prompt. Three
 * distinct strings reach `model`, and the first two were OBSERVED by running the node
 * through the real engine and reading the request back off the adapter; the third is read
 * off `#summarizeEffect`, because reaching it needs a context large enough to compact:
 *
 *     agent node        → the graph's `agent.profile`, e.g. `agent_profile/summarizer@stable`
 *     rubric evaluator  → the literal `"mock"`      (`#runAgent` again, reached from `#runEvaluator` where `agent` is undefined)
 *     context compaction→ the literal `"compaction"` (`#summarizeEffect`) — read, not run
 *
 * The route table is the deployment supplying the resolution its ResourceStore would
 * otherwise supply — the same job `--channels-file` does for delivery — and it is written
 * as a MAP over those strings rather than as a per-provider default, because a default
 * would answer for the two literals as well and hide that they are not model ids.
 *
 * **REVERSAL.** When `agent_profile` resources carry a real profile document and something
 * resolves one into a model id, the `routes` table is what gets deleted; `adapters` stays.
 * Nothing else in this file depends on it.
 *
 * **THE KEY IS NEVER IN THE FILE.** `apiKeyEnv` names an environment variable; the file
 * holds configuration and the environment holds the credential. `--channels-file` argues
 * the other half of this — a secret may not be in argv — and a config file is one `git add`
 * away from being as public as argv, so it gets the same treatment one step further out.
 * An UNSET or EMPTY variable refuses to start rather than constructing an adapter that
 * fails on its first call, which would be an hour later and in a run's error field.
 *
 * **A MALFORMED FILE REFUSES TO START**, the trade `readIdentities` and `readChannels` both
 * make, for the reason they make it: booting anyway produces a deployment that looks
 * configured and answers every model call with an error.
 */
export function readModels(
  file: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: HttpOptions["fetch"],
): ModelConfig {
  const path = resolve(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw err.validation(CODES.E_CONFIG_INVALID, `--models-file ${path}: ${(e as Error).message}`);
  }
  const refuse: (why: string) => never = (why) => {
    throw err.validation(CODES.E_CONFIG_INVALID, `--models-file ${path}: ${why}`);
  };

  const root = (parsed ?? {}) as { adapters?: unknown; routes?: unknown };
  const rows = root.adapters;
  if (!Array.isArray(rows) || rows.length === 0) {
    refuse(
      `must be {"adapters":[{"provider":"anthropic"}],"routes":{"agent_profile/x@stable":{"adapter":"anthropic","model":"claude-sonnet-5"}}} ` +
        `with at least one adapter`,
    );
  }

  const adapters = new Map<string, ModelAdapter>();
  rows.forEach((raw, i) => {
    const where = `adapters[${i}]`;
    const row = raw as Record<string, unknown> | null;
    if (typeof row !== "object" || row === null || Array.isArray(row)) refuse(`${where} is not an object`);
    const provider = row["provider"];
    if (typeof provider !== "string" || !Object.hasOwn(PROVIDERS, provider)) {
      refuse(
        `${where} has provider ${JSON.stringify(provider)}, which must be one of: ${Object.keys(PROVIDERS).join(", ")}. ` +
          `An unknown provider is refused rather than skipped, because a skipped adapter is a deployment that boots ` +
          `looking configured and answers every model call with "no route".`,
      );
    }
    // The registry keys adapters by name and a second row with the same one would replace
    // the first with nothing anywhere saying so — the same refusal, for the same reason,
    // that `readChannels` makes about a duplicate channel name.
    const name = row["name"] === undefined ? provider : nonEmpty(row["name"], `${where} "name"`, refuse);
    if (adapters.has(name)) refuse(`${where} repeats the adapter name "${name}" — one of them would never be reachable`);

    const baseUrl = row["baseUrl"] === undefined ? undefined : nonEmpty(row["baseUrl"], `${where} ("${name}") "baseUrl"`, refuse);
    const keyEnv = row["apiKeyEnv"] === undefined ? PROVIDERS[provider]!.keyEnv : nonEmpty(row["apiKeyEnv"], `${where} ("${name}") "apiKeyEnv"`, refuse);
    const apiKey = env[keyEnv] ?? "";
    // The one place a keyless adapter is legal, and it is the adapter's own rule rather
    // than a second one invented here: `OpenAIAdapter` accepts an empty key when a
    // `baseUrl` is given, because a local endpoint legitimately has no credential.
    if (apiKey === "" && !(provider === "openai" && baseUrl !== undefined)) {
      refuse(
        `${where} ("${name}") needs the environment variable ${keyEnv}, which is ${env[keyEnv] === undefined ? "not set" : "empty"}. ` +
          `The key is deliberately NOT a field in this file — the file is configuration and the key is a credential. ` +
          `Set ${keyEnv}, or name a different variable with "apiKeyEnv"` +
          (provider === "openai" ? `, or give this adapter a "baseUrl" if it is a local endpoint that needs no key.` : `.`),
      );
    }

    // ANNOTATED, not inferred, and assignable to BOTH adapters' option types. Inference
    // over a chain of conditional spreads gives `baseUrl?: string | undefined`, which
    // `exactOptionalPropertyTypes` does not accept where the adapter declares
    // `baseUrl?: string`. The same reason `readChannels`'s `common` carries
    // `WebhookChannelOptions` rather than letting the spread decide.
    const common: {
      readonly apiKey: string;
      // `NonNullable`, because `HttpOptions["fetch"]` is `FetchLike | undefined` and
      // `exactOptionalPropertyTypes` treats `fetch?: FetchLike | undefined` and
      // `fetch?: FetchLike` as different types — the adapters declare the second.
      readonly fetch?: NonNullable<HttpOptions["fetch"]>;
      readonly baseUrl?: string;
      readonly prices?: Readonly<Record<string, { input: number; output: number }>>;
      readonly defaultMaxTokens?: number;
    } = {
      apiKey,
      // INJECTED, and only ever by a test. The claim this flag makes — "a routed request
      // reaches the provider as a real model id" — is a claim about the bytes in the
      // request body, and the only way to assert it without a socket and a credential is
      // to hand the adapter its `fetch`. Production passes nothing and `postJson` uses
      // `globalThis.fetch`, so this adds no configuration and no code path of its own.
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(row["prices"] === undefined ? {} : { prices: priceTable(row["prices"], `${where} ("${name}") "prices"`, refuse) }),
      ...(row["defaultMaxTokens"] === undefined
        ? {}
        : { defaultMaxTokens: wholePositive(row["defaultMaxTokens"], `${where} ("${name}") "defaultMaxTokens"`, refuse) }),
    };
    try {
      adapters.set(name, provider === "anthropic" ? new AnthropicAdapter(common) : new OpenAIAdapter({ ...common, provider: name }));
    } catch (e) {
      // The adapter's own construction refusal, re-raised naming the file and the row —
      // `readChannels` does the same for a channel, and for the same reason: "anthropic
      // adapter requires an apiKey" does not tell an operator which file to open.
      if (isLoomError(e)) refuse(`${where} ("${name}"): ${e.message}`);
      throw e;
    }
  });

  const routes = new Map<string, Route>();
  const routeRows = root.routes;
  if (typeof routeRows !== "object" || routeRows === null || Array.isArray(routeRows)) {
    refuse(`"routes" must be an object mapping each ModelRequest.model the engine sends to {"adapter":…,"model":…}`);
  }
  for (const [key, raw] of Object.entries(routeRows as Record<string, unknown>)) {
    const where = `routes[${JSON.stringify(key)}]`;
    const row = raw as Record<string, unknown> | null;
    if (typeof row !== "object" || row === null || Array.isArray(row)) refuse(`${where} is not an object`);
    const adapter = nonEmpty(row["adapter"], `${where} "adapter"`, refuse);
    if (!adapters.has(adapter)) {
      refuse(`${where} names adapter "${adapter}", which is not declared. Declared: ${[...adapters.keys()].join(", ")}`);
    }
    routes.set(key, { adapter, model: nonEmpty(row["model"], `${where} "model"`, refuse) });
  }
  if (routes.size === 0) {
    refuse(
      `"routes" is empty, so no model call could be served. Every agent node sends its \`agent.profile\` as the model ` +
        `id, a rubric evaluator sends "mock", and context compaction sends "compaction" — each needs a row.`,
    );
  }

  return {
    adapter: new RoutingAdapter(adapters, routes, path),
    adapters: [...adapters.keys()],
    routes: [...routes.keys()],
    file: path,
  };
}

/**
 * The adapter `openWorkspace` registers: it rewrites `model` and delegates.
 *
 * **IT REFUSES BEFORE THE SOCKET, WHICH IS THE WHOLE POINT.** An unrouted key throws here,
 * locally, naming the key and the file — never as a provider's rejection of a model that
 * does not exist, arrived at after the prompt was already sent. That refusal is the production half of
 * `test/helpers/strict-doubles.ts`: the same class of defect, caught at the same boundary,
 * with the offline detector red first so this path is never the one that discovers it.
 *
 * **`estimateOf` ROUTES TOO.** `#runAgent` calls it to reserve budget, one line
 * before `stream`, so routing there means an unrouted key fails during the reservation and
 * never reaches the network at all. It also fixes the quieter half: a delegate prices by
 * `req.model`, and an unrewritten key is priced at **0** by every adapter in this repo, so
 * the budget silently stops bounding anything. One lookup, three entry points, no drift.
 *
 * It is NOT a resolver and must not grow into one: it maps strings the engine already
 * produces, and knows nothing about resources, digests or channels.
 */
class RoutingAdapter implements ModelAdapter {
  readonly provider = "routed";
  readonly #adapters: ReadonlyMap<string, ModelAdapter>;
  readonly #routes: ReadonlyMap<string, Route>;
  readonly #file: string;

  constructor(adapters: ReadonlyMap<string, ModelAdapter>, routes: ReadonlyMap<string, Route>, file: string) {
    this.#adapters = adapters;
    this.#routes = routes;
    this.#file = file;
  }

  #resolve(model: string): { readonly adapter: ModelAdapter; readonly model: string } {
    const route = this.#routes.get(model);
    if (route === undefined) {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `no route for model "${model}" in ${this.#file}. Routed: ${[...this.#routes.keys()].join(", ")}. ` +
          `An agent node sends its \`agent.profile\` here, a rubric evaluator sends "mock", and context compaction ` +
          `sends "compaction" — none of those is a model id, which is why the mapping has to be written down.`,
      );
    }
    return { adapter: this.#adapters.get(route.adapter)!, model: route.model };
  }

  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const to = this.#resolve(req.model);
    return to.adapter.stream({ ...req, model: to.model }, signal);
  }

  estimateOf(req: ModelRequest): number {
    const to = this.#resolve(req.model);
    return to.adapter.estimateOf({ ...req, model: to.model });
  }

  priceOf(model: string, usage: { inputTokens: number; outputTokens: number }): number {
    const to = this.#resolve(model);
    return to.adapter.priceOf(to.model, usage);
  }
}

/**
 * A count, not a duration — which is why it does not reuse `positive`.
 *
 * `positive` refuses anything above `MAX_TIMER_MS` and explains itself in terms of Node
 * timers truncating a delay to one millisecond. That explanation is true of every caller
 * it has and false of this one: `defaultMaxTokens` never reaches a timer, so borrowing the
 * helper would have attached a reason that does not hold to the value it refused. A
 * separate six lines is cheaper than a message an operator cannot act on.
 */
function wholePositive(v: unknown, where: string, refuse: (why: string) => never): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) refuse(`${where} must be a positive whole number`);
  return v;
}

/** `{ "claude-sonnet-5": { "input": 3, "output": 15 } }` — USD per million tokens. */
function priceTable(v: unknown, where: string, refuse: (why: string) => never): Record<string, { input: number; output: number }> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) refuse(`${where} must be an object of {input,output} pairs`);
  const out: Record<string, { input: number; output: number }> = {};
  for (const [model, raw] of Object.entries(v as Record<string, unknown>)) {
    const row = raw as { input?: unknown; output?: unknown } | null;
    if (typeof row !== "object" || row === null) refuse(`${where}.${model} must be {"input":n,"output":n}`);
    // A price of 0 is legal — a free local endpoint is a real thing — but a NEGATIVE or
    // non-finite one would credit the budget instead of spending it, which turns a bound
    // into an unbounded run.
    for (const field of ["input", "output"] as const) {
      const n = row[field];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        refuse(`${where}.${model}.${field} must be a non-negative finite number of USD per million tokens`);
      }
    }
    out[model] = { input: row.input as number, output: row.output as number };
  }
  return out;
}

function stringMap(v: unknown, where: string, refuse: (why: string) => never): Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) refuse(`${where} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value !== "string") refuse(`${where}.${k} must be a string`);
    out[k] = value;
  }
  return out;
}

/**
 * The largest delay a Node timer can hold — 2³¹−1 ms, about 24.8 days.
 *
 * `setTimeout`, `setInterval` and `AbortSignal.timeout` all keep their delay in a 32-bit
 * signed integer, and anything larger is TRUNCATED TO ONE MILLISECOND. Not saturated, not
 * refused. Measured on node v24.16.0:
 *
 *     setInterval(fn, 2 ** 31)       → fired after 1 ms
 *     AbortSignal.timeout(2 ** 31)   → aborted after 1 ms, reason TimeoutError
 *
 * Each also prints a `TimeoutOverflowWarning` that names no call site, which is not a
 * diagnosis. `src/server/http.ts` carries the same constant for `requestTimeoutMs`, for
 * the same reason; it is duplicated rather than shared because exporting it would put a
 * platform fact on the pinned public surface.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * A duration, refused rather than defaulted when it is not one — and refused rather than
 * CLAMPED when it is one no timer can hold.
 *
 * `"toleranceMs": "60000"` would otherwise fall silently back to five minutes — a replay
 * window four times wider than the one the operator wrote, which is exactly the kind of
 * quiet loosening this file exists to make impossible.
 *
 * THE CEILING IS THE SAME DEFECT FROM THE OTHER END, and a worse one, because above it a
 * value becomes its own OPPOSITE rather than merely being ignored: `--sweep-ms 86400000000`
 * ("sweep daily") is a sweep every millisecond, and `"timeoutMs": 2 ** 31` on a channel
 * aborts every delivery before the socket connects. The second was observed end to end,
 * and the error it produces is its own counterexample:
 *
 *     E_GATE_DELIVERY_FAILED: slack did not answer within 2147483648ms for gate g_1
 *
 * — raised 0 ms after the call. "Nobody is ever told about the gate" is the one outcome the
 * whole delivery subsystem is arranged to prevent, and an unbounded integer reached it.
 *
 * **REFUSED, NOT CLAMPED**, and that is a real decision rather than pattern-matching on
 * `--token ""`. An empty secret has no safe reading at all; a too-large duration has an
 * obvious one ("as long as possible"), so clamping had to be argued down:
 *
 *  1. **There is no one safe direction to clamp in.** Clamping an INTERVAL down sweeps
 *     more often, which is safe. Clamping a delivery TIMEOUT down aborts deliveries that
 *     would have succeeded, which is not. One helper serves both callers and there is no
 *     direction that is right for both.
 *  2. **A clamp here could not say so, and "clamp silently" is the bug being fixed.**
 *     This function is called from inside `readChannels`, which prints nothing and runs
 *     long before `announce` exists. The refusal uses the reporting path that is already
 *     here — the one that names the file and the row that caused it.
 *  3. **Nothing real is refused.** The ceiling is 24.8 days. A gate sweep, an HTTP
 *     deadline or a signature replay window longer than that is not an operating choice;
 *     it is a unit slip — seconds written as milliseconds, microseconds pasted in from
 *     another system, a timestamp used as a duration — and every one of those is worth
 *     stopping at boot.
 *
 * `toleranceMs` is bounded by the same number even though it never reaches a timer —
 * `SignedWebhookChannel` only ever compares it (`Math.abs(req.now - ts * 1000) >
 * this.#toleranceMs`). One rule for every duration this file reads is worth more than an
 * exemption whose justification is a claim about how a different file happens to use the
 * value today; and a signature replay window wider than three weeks is not a window.
 */
function positive(v: unknown, where: string, refuse: (why: string) => never): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) refuse(`${where} must be a positive whole number of milliseconds`);
  if (v > MAX_TIMER_MS) {
    refuse(
      `${where} is ${v}, above the ${MAX_TIMER_MS}ms (~24.8 day) ceiling every Node timer has. A larger delay is not ` +
        `saturated, it is truncated to ONE MILLISECOND — so this value would become its own opposite: a continuous ` +
        `sweep, or a delivery that aborts before it connects. Check the units`,
    );
  }
  return v;
}

function nonEmpty(v: unknown, where: string, refuse: (why: string) => never): string {
  if (typeof v !== "string" || v === "") refuse(`${where} must be a non-empty string`);
  return v;
}

/**
 * `via` is a closed vocabulary on the journal; an unknown one is dropped, not coerced.
 *
 * Written as a TOTAL map over the union rather than as a `Set<string>`, so that adding a
 * member to `HumanActor["via"]` breaks this line instead of silently making the new member
 * unwritable from an identity file. `ControlPlane` applies the same rule to every
 * `IdentitySource` at request time; this one decides it once, at boot, for the file.
 */
const VIA: Readonly<Record<HumanActor["via"], true>> = {
  console: true,
  slack: true,
  feishu: true,
  teams: true,
  email: true,
  api: true,
  cli: true,
};
function isVia(v: unknown): v is HumanActor["via"] {
  // `hasOwn` and not `in`: `"constructor" in VIA` is true.
  return typeof v === "string" && Object.hasOwn(VIA, v);
}

/**
 * Read a spec from JSON or YAML.
 *
 * YAML is authoring sugar and stops here: it is converted to a plain value before
 * anything downstream sees it, so a digest is only ever taken over JSON. Two authors who
 * write the same graph in different formats get the same hash.
 *
 * **BOTH FAILURES ARE THE OPERATOR'S, AND NEITHER IS A BUG IN LOOM.** This was
 * `JSON.parse(readFileSync(path))` with nothing around either call, so the JSON half of
 * the ternary reported a typo the way it reported a broken engine. Measured, same
 * workspace, one file per line:
 *
 *     loom compile graphs/broken.yaml → E_GRAPH_INVALID: broken.yaml:3: unexpected indentation inside a sequence
 *     loom compile graphs/broken.json → E_INTERNAL: SyntaxError: Expected double-quoted property name in JSON at position 54
 *     loom compile graphs/nope.json   → E_INTERNAL: Error: ENOENT: no such file or directory, open '…/graphs/nope.json'
 *     loom compile graphs             → E_INTERNAL: Error: EISDIR: illegal operation on a directory, read
 *
 * The YAML line is what the other three should have looked like. `runInputs` states the
 * rule below — a caller sending nonsense is not an internal error, citing
 * `server/http.ts`'s `safeDecode` for it — and declared it fixed for `--input` in the same
 * wave that left it broken for the graph file `--input` is passed alongside.
 *
 * THE TWO REFUSALS ARE DIFFERENT CODES BECAUSE THE FIXES ARE DIFFERENT. A file that cannot
 * be read is `E_CONFIG_INVALID`, like every other path this file takes off a flag: what is
 * wrong is which path was given. A file that reads and is not a graph is
 * `E_GRAPH_INVALID`, identically to its YAML sibling and to what `compile` reports for a
 * graph that parses and does not validate.
 */
function readSpec(file: string): GraphSpec {
  const path = resolve(file);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw err.validation(CODES.E_CONFIG_INVALID, `cannot read the graph file ${path}: ${(e as Error).message}`);
  }
  // `as unknown as` because splitting the old one-line ternary split its single cast too:
  // `JSON.parse` returns `any` and absorbed the yaml branch's `Record<string, unknown>`,
  // which on its own does not overlap `GraphSpec`. What validates the document is
  // `compile`, here and before.
  if (/\.ya?ml$/i.test(path)) return parseYamlSpec(text, { filename: basename(path) }) as unknown as GraphSpec;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    throw err.validation(CODES.E_GRAPH_INVALID, `${path} is not valid JSON: ${(e as Error).message}`);
  }
  // A cast is not a check, and the three shapes that parse cleanly and are not a spec —
  // an array, `null`, a scalar — would otherwise reach `compile` and be diagnosed as
  // whatever it happens to read off `undefined` first. Same argument as `runInputs`'.
  //
  // Checked through `doc` rather than through `parsed` so the narrowing stays local: the
  // return is the same cast the ternary always made, and `compile` is what validates the
  // document properly — this refuses only what could not BE one.
  const doc: unknown = parsed;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw err.validation(
      CODES.E_GRAPH_INVALID,
      `${path} parsed as ${doc === null ? "null" : Array.isArray(doc) ? "an array" : typeof doc}, which is not a GraphSpec document`,
    );
  }
  return parsed as GraphSpec;
}

function loadGraph(ws: Workspace, file: string): RunGraph {
  const spec = readSpec(file);
  const result = compile({
    spec,
    resolver: ws.resolver,
    tools: (ws.engine.tools as ToolRegistry).manifests(),
    tenantCapabilities: ["fs:read", "fs:write", "net:fetch"],
  });
  if (!result.ok) {
    for (const d of result.diagnostics) {
      process.stderr.write(`${d.severity === "error" ? "✗" : "!"} ${d.code}: ${d.message}\n`);
      if (d.fix !== undefined) process.stderr.write(`   fix: ${d.fix}\n`);
    }
    throw result.error;
  }
  for (const d of result.diagnostics) process.stderr.write(`! ${d.code}: ${d.message}\n`);
  return result.graph;
}

function discoverGraphs(ws: Workspace): Record<string, RunGraph> {
  const dir = join(ws.root, "graphs");
  const out: Record<string, RunGraph> = {};
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)) {
    if (!/\.(json|ya?ml)$/i.test(file)) continue;
    try {
      const graph = loadGraph(ws, join(dir, file));
      out[graph.spec.metadata.name] = graph;
    } catch (e) {
      // One malformed graph must not stop the server from serving the others.
      process.stderr.write(`! skipping ${basename(file)}: ${(e as Error).message}\n`);
    }
  }
  return out;
}

/**
 * Everything `serve` decides before it binds a port.
 *
 * Separated from `serve` for one reason: **the wiring is the thing worth testing, and
 * `serve` cannot be called by a test.** It ends in a promise that only a SIGINT resolves,
 * so a test that drove it would hang rather than assert. A test that instead rebuilt these
 * options by hand would be testing its own copy of them, which is how the callback route
 * came to exist in the library and not in the binary in the first place.
 *
 * Every refusal below happens BEFORE the socket, so a misconfigured deployment is a
 * process that does not start rather than one that starts wide open.
 */
export function controlPlaneOptions(ws: Workspace, args: Args): ControlPlaneOptions {
  const graphs = discoverGraphs(ws);
  const identity = args.flags["identity-file"] === undefined ? undefined : readIdentities(requireFileFlag(args, "identity-file"));
  // TWO WAYS THE FLAG ARRIVES EMPTY, and both used to become a shared secret.
  //
  //  - `--token "$LOOM_TOKEN"` with the variable unset hands the flag the empty
  //    string, which `ControlPlane` refuses because it authenticated every caller.
  //  - `--token` with no value at all — `loom serve --token --port 8787`, or a
  //    trailing flag — is `true` from `parseArgs`, and `String(true)` quietly
  //    installed the deployment's shared secret as the four letters "true".
  //
  // The plane refuses the first for the whole library; this refuses both with the
  // FLAG'S name in the message, because "ControlPlaneOptions.token" is not a string
  // any operator typed.
  const tokenFlag = args.flags["token"];
  if (tokenFlag === true || tokenFlag === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--token needs a non-empty value: ${tokenFlag === "" ? `the one given was empty (\`--token "$LOOM_TOKEN"\` does this when the variable is unset)` : "the flag was given with no value at all"}. ` +
        `An empty shared token authenticates every caller, including one presenting no credential. ` +
        `Pass a real secret, or omit --token entirely to run an open plane on purpose.`,
    );
  }
  return {
    engine: ws.engine,
    store: ws.store,
    bus: ws.bus,
    graphs,
    ...(tokenFlag === undefined ? {} : { token: String(tokenFlag) }),
    ...(identity === undefined ? {} : { identity }),
    // THE UNAUTHENTICATED ROUTE EXISTS ONLY IF SOMEBODY CAN ANSWER ON IT.
    //
    // `ControlPlaneOptions.dispatcher` is what opens `POST /runs/:id/callbacks/:channel`
    // AND its carve-out in the bearer check, together, so passing one whose channels are
    // all notify-only would open a route on which every request is refused with
    // `unknown_channel` — attack surface bought for nothing. Gating on `answerable` makes
    // "the route exists" and "a signed callback can be accepted" the same fact, which is
    // what the boot warning below is then able to claim without qualification.
    ...(ws.delivery === undefined || ws.delivery.answerable.length === 0 ? {} : { dispatcher: ws.delivery.dispatcher }),
  };
}

/** How often `serve` ticks the gate clock when nobody says otherwise. */
const DEFAULT_SWEEP_MS = 1_000;

/**
 * The tick interval, validated BEFORE the port is bound.
 *
 * Separated from `startGateClock` for the reason every refusal in `serve` is made early: a
 * process that binds a socket and then throws is briefly in rotation, answering nothing.
 *
 * `Number(true)` is 1, so a bare `--sweep-ms` would silently install a ONE MILLISECOND
 * tick — the same class of slip as `String(true)` installing "true" as the shared token,
 * reached the same way. Anything that is not a string becomes `NaN` and is refused.
 *
 * AND THE TOP OF THE RANGE LANDS IN THE SAME PLACE. `setInterval` truncates a delay above
 * `MAX_TIMER_MS` to 1 ms, so `--sweep-ms 86400000000` — an operator asking for a daily
 * sweep, having written microseconds — installs the identical one-millisecond spin, while
 * `announce` prints the interval that was asked for. `positive` refuses it; without that
 * refusal the boot line is a promise this process does not keep, which is the one thing
 * `announce` exists to make impossible.
 */
function gateClockInterval(args: Args): number {
  const raw = args.flags["sweep-ms"];
  if (raw === undefined) return DEFAULT_SWEEP_MS;
  return positive(typeof raw === "string" ? Number(raw) : NaN, "--sweep-ms", (why) => {
    throw err.validation(CODES.E_CONFIG_INVALID, `${why}. Omit it for the default of ${DEFAULT_SWEEP_MS}ms.`);
  });
}

/** Where `serve` binds when nobody says otherwise. */
const DEFAULT_PORT = 8787;

/**
 * The port, validated BEFORE the socket — the third numeric flag, and the last one that
 * reaches a platform API with a range of its own.
 *
 * The same two slips `--token` and `--sweep-ms` are guarded against, and here they are
 * quieter than either:
 *
 *   - `--port` with no value is `true` from `parseArgs`, and `Number(true)` is **1**. On a
 *     host where the process may take a privileged port that is a plane listening somewhere
 *     nobody was told about.
 *   - `--port=` with an unset variable is `""`, and `Number("")` is **0**, which `listen`
 *     reads as "any free port". `loom serve --port="$PORT"` therefore bound a RANDOM port
 *     and announced it — honest and useless, because the deployment is unreachable at the
 *     address it was configured for and nothing says the flag was disregarded.
 *
 * `0` written out is a real choice and stays legal: every test in this repo that binds a
 * plane asks for it. What is refused is the empty string that becomes it by accident.
 *
 * Out of range and non-numeric are refused here rather than left to `listen`, which raises
 * `ERR_SOCKET_BAD_PORT` — correct, loud, and phrased in terms of an API the operator never
 * called, after the workspace has already been created and a SQLite handle opened.
 *
 * **THIS CHECK DOES NOT REMOVE THE BIND FAILURE, and an earlier draft of this docstring
 * claimed it did.** It named `Error: listen EACCES … port: 1`, thrown from an `'error'`
 * event with no handler, as the failure being fixed — but every *legal* port exits through
 * that same event. `--port 1` is a whole number in range and unbindable without root;
 * `--port 80` is the same; so is any port another process already holds. Bounding the
 * value and binding the socket are two failures, and a check on the first cannot speak to
 * the second. `ControlPlane.listen` now rejects with an `E_CONFIG_INVALID` naming the
 * address, so `main`'s own handler prints one line and exits 1 — see its docstring for why
 * the listener is removed once the socket is up.
 */
function httpPort(args: Args): number {
  const raw = args.flags["port"];
  if (raw === undefined) return DEFAULT_PORT;
  const refuse: (why: string) => never = (why) => {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--port ${why}. Omit it for the default of ${DEFAULT_PORT}, or pass 0 to bind any free port on purpose.`,
    );
  };
  if (raw === true) refuse("was given with no value at all, and a missing value used to become port 1");
  if (raw === "") {
    refuse(
      'was given an empty value (`--port "$PORT"` does this when the variable is unset), and an empty value used to ' +
        "bind ANY FREE PORT — a deployment nobody can reach at the address it was configured for",
    );
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) refuse(`must be a whole number from 0 to 65535, not "${raw}"`);
  return port;
}

/**
 * THE GATE CLOCK, started — because a deadline nothing checks is not a deadline.
 *
 * `Engine.sweepGates` is the tick and it starts no timer, deliberately: the clock is
 * injected everywhere in this codebase so that a test can advance it and observe exactly
 * one escalation. The INTERVAL therefore belongs to whoever owns a process lifetime, and
 * `serve` is the only long-lived one we ship. Without this, a `bin/loom` deployment's SLA
 * deadlines never expire, escalation tiers never fire, and a gate declaring
 * `onTimeout: "fail"` waits forever — see `sweepGates`, which says exactly this.
 *
 * ON BY DEFAULT, and there is no off switch. The absence of a flag has to be the SAFE
 * direction, and here the safe direction is loud: an unswept gate is one whose declared
 * timeout policy silently does not apply, which is the class of failure — "looks
 * supervised, is not" — this whole subsystem exists to prevent. A deployment that drives
 * the clock from elsewhere can set a long interval; it cannot ask for no clock, because
 * a config file that can spell "no oversight timing" will eventually spell it by accident.
 *
 * THREE THINGS THE LOOP DOES THAT A NAIVE `setInterval` WOULD NOT:
 *
 *   - it does not STACK. A tick that outruns the interval — a slow store, a big listing —
 *     would otherwise start a second sweep over the same cursors while the first is still
 *     writing. `sweep` is safe against that (every write compare-and-swaps on the seq), but
 *     safe is not free, and a pile of overlapping sweeps is how a slow store becomes a
 *     dead one.
 *   - it CATCHES. `sweep` counts a per-run failure rather than raising, but `listRuns`
 *     itself can reject, and an unhandled rejection from a timer callback has no handler
 *     above it — it would end the process, and with it every in-flight run and every open
 *     gate's return path. Same rule as `listen`'s request callback, one layer over.
 *   - it SPEAKS ONCE per outage. `SweepReport.failed` is a number nobody reads unless
 *     something prints it, and printing it every second for the life of a store problem is
 *     how an operator learns to ignore the line. It reports the transition into failing and
 *     the transition back out.
 *
 * `unref` so the timer alone never holds the process open: the listening socket is what
 * keeps `serve` alive, and once that is closed the clock must not be the reason we linger.
 */
function startGateClock(ws: Workspace, everyMs: number): { readonly everyMs: number; stop(): void } {
  let running = false;
  let failing = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void ws.engine
      .sweepGates()
      .then(
        (report) => {
          if (report.failed > 0 && !failing) {
            failing = true;
            process.stderr.write(
              `! GATE CLOCK DEGRADED — ${report.failed} of ${report.considered} runs could not be swept, so their SLA\n` +
                `  deadlines and escalation tiers are not firing. This is a store problem; the runs stay in view and\n` +
                `  are retried on the next tick.\n`,
            );
          } else if (report.failed === 0 && failing) {
            failing = false;
            process.stderr.write("! gate clock recovered — every run in view is being swept again\n");
          }
        },
        (e: unknown) => {
          // The listing itself failed, so nothing was swept at all.
          if (!failing) {
            failing = true;
            process.stderr.write(`! GATE CLOCK STOPPED SWEEPING — ${(e as Error).message}\n`);
          }
        },
      )
      .finally(() => {
        running = false;
      });
  };

  // `everyMs` is the interval INSTALLED, not the one requested, and the difference is only
  // nil because `positive` refuses anything above `MAX_TIMER_MS`: `setInterval` truncates a
  // larger delay to 1 ms and says so in a warning naming no call site. Relax that ceiling
  // and `announce`'s `clock: … every Nms` becomes a line about a process that is doing
  // something else.
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return { everyMs, stop: () => clearInterval(timer) };
}

/**
 * What is on, said at boot, in the order an operator reads it.
 *
 * A deployment with an inbound callback route and one without are materially different
 * security postures — one of them has an endpoint that accepts production approvals from
 * anyone holding a shared secret and no bearer token — and which one you have was
 * previously invisible from the output. Everything here is read off the CONSTRUCTED plane
 * or the CONSTRUCTED channel config, never re-derived from the flags, so no line can
 * promise a posture the running process does not have.
 *
 * THE TWO NUMBERS ON THESE LINES ARE THE PART THAT PROMISE WAS BRIEFLY FALSE ABOUT, and
 * they are true by two different mechanisms, both worth keeping:
 *
 *   - `port` is read back OFF THE BOUND SOCKET (`listen` returns `server.address()`), so
 *     `--port 0` prints the port that was actually taken rather than the zero requested.
 *   - `sweepMs` cannot be read back off a timer — `setInterval` returns no delay — so it
 *     is true only because `positive` refuses every value the platform would silently
 *     change. Reading a value off a constructed object is the stronger technique; where it
 *     is unavailable, a refusal at parse time is what is left.
 */
function announce(plane: ControlPlane, ws: Workspace, opts: ControlPlaneOptions, sweepMs: number, port: number): void {
  const delivery = ws.delivery;
  const identity = opts.identity;
  process.stdout.write(`loom listening on http://127.0.0.1:${port}\n`);
  process.stdout.write(`  data:   ${ws.dataDir}\n`);
  process.stdout.write(`  graphs: ${Object.keys(opts.graphs ?? {}).join(", ") || "(none)"}\n`);
  process.stdout.write(`  who:    ${identity === undefined ? "(nobody — no identity source)" : identity.name}\n`);
  // Every channel, and for each one the only property that matters to the perimeter:
  // whether a human can answer through it.
  process.stdout.write(
    `  gates:  ${
      delivery === undefined
        ? "(no channels — a gate is delivered nowhere, and is answered through the API or the CLI)"
        : [...delivery.answerable.map((n) => `${n} (answerable)`), ...delivery.notifyOnly.map((n) => `${n} (notify-only)`)].join(", ")
    }\n`,
  );
  // The gate clock is the difference between a declared SLA and an enforced one, so it is
  // stated as a fact about the running process rather than left to be inferred from a flag.
  process.stdout.write(`  clock:  gate SLAs, escalation tiers and onTimeout swept every ${sweepMs}ms\n`);
  // WHICH MODELS, said at boot for the same reason the callback route is: a deployment
  // whose agent nodes all answer `[mock] …` and one that calls a provider are materially
  // different things, and which one you have was not visible from anywhere in the output.
  const models = ws.models;
  process.stdout.write(
    `  models: ${models === undefined ? "(mock only — every agent node answers \"[mock] …\")" : `${models.adapters.join(", ")} via ${models.file}`}\n`,
  );
  if (models === undefined) {
    process.stderr.write(
      `! NO MODEL ADAPTER — the only registered adapter is the offline mock, so every agent node and every rubric\n` +
        `  evaluator returns canned text. Runs will look successful.\n` +
        `  fix: loom serve --models-file <file> with {"adapters":[{"provider":"anthropic"}],"routes":{…}}\n`,
    );
  }
  // The plane's own posture, not a third derivation of it: `openToEveryCaller` is
  // what `/health` reports and what `#principal` admits on, so this line cannot
  // promise a perimeter the running process does not have.
  if (plane.openToEveryCaller) {
    process.stderr.write("! NO TOKEN — every caller is authorized\n");
  }
  // AUTHENTICATION IS NOT AUTHORIZATION, said where the operator who configured
  // `--identity-file` will read it. That flag buys one thing — a gate can name an
  // approver and the right person can answer it — and no isolation at all: this
  // plane admits on the credential and scopes nothing to it.
  //
  // The condition, and the message, are `startControlPlane`'s (which `serve` does
  // not call: the binary prints its own diagnostics with its own fixes). The COUNT
  // is computed in one place, `ControlPlane.distinctPrincipals`, so the two paths
  // cannot disagree about when to speak.
  if (plane.distinctPrincipals > 1) {
    const n = plane.distinctPrincipals;
    process.stderr.write(
      `! EVERY CREDENTIAL IS A FULL OPERATOR CREDENTIAL — ${Number.isFinite(n) ? `${n} principals are` : "more than one principal is"} configured,\n` +
        `  and runs are NOT scoped to the principal that submitted them: any of them can read, stream and\n` +
        `  cancel any other's run, gate payloads included. See design/loom/01-INTERFACES.md D3.17.\n`,
    );
  }
  // THE SECOND HOLE IN THE PERIMETER, named as loudly as the first. `opts.dispatcher` and
  // not `delivery.answerable`, because it is the field the plane was actually built with:
  // if the two ever disagree, this line follows the one that decides the route.
  if (opts.dispatcher !== undefined && delivery !== undefined) {
    process.stderr.write(
      `! CALLBACK ROUTE OPEN — POST /runs/:id/callbacks/:channel accepts decisions WITHOUT the bearer token,\n` +
        `  on: ${delivery.answerable.join(", ")}. An HMAC signature over the raw request body is the ONLY\n` +
        `  authentication that route has, so a leaked channel secret approves production actions. A secret in\n` +
        `  ${delivery.file} is a credential — rotate it the way you would rotate --token.\n`,
    );
    // Configured to be answered, and no address published: every receiver still has to be
    // told the URL out of band, which is the thing having a callback route was meant to fix.
    if (!delivery.publishesAddress) {
      process.stderr.write(
        `! NO CALLBACK BASE URL — delivered gates carry no address to answer at, so each receiver must still be\n` +
          `  told this deployment's URL out of band.\n` +
          `  fix: add "callbackBaseUrl": "https://<this deployment's public origin>" to ${delivery.file}\n`,
      );
    }
  } else if (delivery !== undefined) {
    // A channels file with nothing answerable in it. Gates are delivered and cannot be
    // answered where they were delivered, which is a configuration an operator can easily
    // believe is complete.
    process.stderr.write(
      `! NO ANSWERABLE CHANNEL — every channel in ${delivery.file} is notify-only, so there is no callback route\n` +
        `  and a gate can only be answered through the API or the CLI.\n` +
        `  fix: give a channel a "callbackSecret" to make it answerable\n`,
    );
  }
  // The single binary's version of the compile-time refusal it cannot have: whether
  // anyone can be identified is deployment config, so the graphs that need a named
  // approver and the deployment that cannot supply one only meet here.
  //
  // SUPPRESSED WHEN A CHANNEL CAN BE ANSWERED, because then they can be: a signed callback
  // names its own approver, and `GateCallbackRouter` never consults the plane's identity
  // source. `unanswerableGraphs` answers about the API door alone — it takes
  // `ControlPlaneOptions`, and whether a channel's subject mapping matches a graph's
  // approvers list is not visible from there — so the deployment layer is the only place
  // the two doors are both in view.
  const stranded = opts.dispatcher === undefined ? unanswerableGraphs(opts) : [];
  if (stranded.length > 0) {
    process.stderr.write(
      `! NO IDENTITY SOURCE — these graphs have gates naming approvers and cannot be answered over the API: ${stranded.join(", ")}\n` +
        `  fix: loom serve --identity-file <file> with {"subjects":[{"subject":"u:you","token":"..."}]}\n` +
        `   or: loom serve --channels-file <file> with a channel that has a "callbackSecret", so the approver answers through it\n`,
    );
  }
}

/**
 * Wait for Ctrl-C, stop, and RETURN WHAT A SUPERVISOR SHOULD BELIEVE.
 *
 * The exit code is the only thing anything above this process reads. `serve` used to
 * print `! SHUTDOWN INCOMPLETE — close() failed: …` and then return **0**, so the one
 * channel a supervisor listens on said the process had stopped cleanly, one line after the
 * process said it had not. systemd, a container runtime and a `&&` in a shell script all
 * act on that; none of them re-reads stderr to find out whether the 0 was true.
 *
 * **1, and the argument against the alternatives is the content of this decision.**
 * `main`'s vocabulary is already fixed: 0 is "what you asked for happened" (`run`
 * succeeded, `replay` matched, `trace` conformed), 1 is "it did not", 2 is "there is no
 * such command", and the entry point at the bottom of this file exits 1 for any thrown
 * error. A shutdown that left a socket bound is "it did not". **130** — the 128 + SIGINT
 * convention — is wrong twice over: it is equally true of the SUCCESSFUL Ctrl-C, so it
 * cannot tell the two apart, and it would make every clean stop look like a crash to a
 * supervisor that treats non-zero as one.
 *
 * SEPARATED FROM `serve` BECAUSE THE DEPENDENCY IS ON ANOTHER FILE'S CONTROL FLOW.
 * `ControlPlane.close()` cannot reject today — it awaits a `server.close` callback and
 * nothing on that path throws — so this arm is unreachable through the real plane, and a
 * comment saying "so this is fine" is a claim about `server/http.ts` held by nothing.
 * `close()` grew a second settle source in the same wave that added the `.catch` (a
 * concurrent close now joins the first's promise); the next one will not announce itself
 * either. Taking the two things it stops as parameters is the whole coupling, so the test
 * drives the failure with a `close()` that rejects.
 *
 * `.finally` and not a second `.then`: whatever `close()` did, the clock must stop and
 * `serve` must return, or `loom serve` answers Ctrl-C by hanging — which from the outside
 * is indistinguishable from the plane politely waiting out a connection.
 *
 * `process.on`, not `once`: Ctrl-C twice is the ordinary impatient shape and the second
 * one must reach a handler while the first `close()` is still in flight (it joins that
 * promise rather than resolving early). The listener is removed once the wait has SETTLED,
 * which is a different instant — without that, every caller leaves one behind.
 */
export async function serveUntilInterrupt(plane: { close(): Promise<void> }, clock: { stop(): void }): Promise<number> {
  return new Promise<number>((resolveCode) => {
    const onSigint = (): void => {
      let incomplete = false;
      void plane
        .close()
        .catch((e: unknown) => {
          incomplete = true;
          process.stderr.write(`! SHUTDOWN INCOMPLETE — close() failed: ${toLoomError(e).message}\n`);
        })
        .finally(() => {
          clock.stop();
          process.removeListener("SIGINT", onSigint);
          resolveCode(incomplete ? 1 : 0);
        });
    };
    process.on("SIGINT", onSigint);
  });
}

// ---------------------------------------------------------------------------

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "help" || args.flags["help"] === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const ws = openWorkspace(args);
  try {
    switch (args.command) {
      case "compile": {
        loadGraph(ws, requirePositional(args, 0, "a graph file"));
        process.stdout.write("ok\n");
        return 0;
      }

      case "serve": {
        const opts = controlPlaneOptions(ws, args);
        // Every refusal is spent before the socket exists: the plane's own, in its
        // constructor, and the clock's and the port's, here.
        const everyMs = gateClockInterval(args);
        const wanted = httpPort(args);
        const plane = new ControlPlane(opts);
        const { port } = await plane.listen(wanted);
        const clock = startGateClock(ws, everyMs);
        announce(plane, ws, opts, clock.everyMs, port);
        // SIGINT IS AN EVENT HANDLER, so nothing above it catches, and its exit code is
        // the only thing a supervisor reads. Both facts live in `serveUntilInterrupt`,
        // which returns what this command should exit with — see its docstring for why a
        // failed shutdown is 1 and not 0 and not 130.
        return await serveUntilInterrupt(plane, clock);
      }

      case "run": {
        // BEFORE the graph is compiled: a typo in the flag should not cost a compile, and
        // more importantly it must not be diagnosed as something the graph did.
        const inputs = runInputs(args);
        const graph = loadGraph(ws, requirePositional(args, 0, "a graph file"));
        const runId = await ws.engine.submit({ graph, inputs });
        const p = await ws.engine.advance(runId);
        process.stdout.write(`${JSON.stringify({ runId, status: p.status, outputs: p.outputs, usage: p.usage }, null, 2)}\n`);
        if (p.status === "awaiting_gate") {
          // MOST URGENT FIRST — D7.9 row 5, which this hint can have and `loom gates` cannot.
          // The difference is one fact and it is worth naming, because the two commands print
          // the same thing: THIS run was submitted by THIS process, so the engine still holds
          // it and `openGates` is the ranked queue. A fresh `loom gates` has attached nothing,
          // so the same call raises `E_RUN_NOT_FOUND` and it is left with the projection — see
          // the note there. Two doors onto one queue, and only one of them can reach the rank.
          for (const g of await ws.engine.openGates(runId)) {
            process.stdout.write(`gate ${g.gateId} on node ${g.nodeId} — loom approve ${runId} ${g.gateId}\n`);
          }
        }
        return p.status === "failed" ? 1 : 0;
      }

      case "gates": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const p = await ws.engine.projection(runId);
        // `?? {}` HERE ANSWERED "THERE IS NO SUCH RUN" WITH "NOTHING IS WAITING ON YOU",
        // on the one command whose entire purpose is asking whether anything is. Measured
        // against the same journal:
        //
        //     loom gates 01KZ9B2D99QZMRAQXTSJTPB84B  (a real, finished run) → []  exit 0
        //     loom gates r_definitely_not_a_run      (no such run)          → []  exit 0
        //
        // Byte-identical, so a typed id, a stale id, or an id from another workspace all
        // read as "you are clear". `GET /runs/:id/gates` answers the same question with a
        // 404 and always has; this door forgot. It is the Traps list's `absence is not
        // zero`, on the highest-consequence command in this file.
        if (p === undefined) {
          throw err.notFound(
            CODES.E_RUN_NOT_FOUND,
            `no run ${runId} in this workspace, which is a different answer from "this run has no open gates". ` +
              `Check the id and \`--workspace\` (the journal being read is ${ws.root}).`,
          );
        }
        // JOURNAL ORDER, AND IT IS NOT THE QUEUE'S — stated rather than left to be
        // discovered, because `GET /runs/:id/gates` answers this same question most urgent
        // first (D7.9 row 5) and two doors onto one queue disagreeing is exactly the shape
        // the comment above is about. The cause is not an oversight here: `gateQueueOrder`
        // is reachable only through `HumanGateBroker.list`, which needs a `RunLog` from an
        // engine that has ATTACHED the run — and a fresh CLI process has attached nothing,
        // so `Engine.openGates` raises `E_RUN_NOT_FOUND`. Measured on a two-gate run folded
        // in a second process: `projection` answers, `openGates` throws.
        //
        // **The fix is one export, not a second sort.** `gateQueueOrder` is a pure function
        // of the projection — no clock, no engine — so `run/gates.ts` exporting it (or
        // `list` growing a projection-shaped overload) orders this command, `summarise`'s
        // `gates`, and every future reader in one place. Re-implementing the rank here would
        // be the second ranking function, which agrees on the day it is written.
        const open = Object.values(p.gates).filter((g) => g.state === "open");
        process.stdout.write(`${JSON.stringify(open, null, 2)}\n`);
        return 0;
      }

      case "approve": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const gateId = requirePositional(args, 1, "a gateId") as GateId;
        const reject = args.flags["reject"];
        // The graph must be re-attached: the RunGraph is not itself journaled (its
        // hash is), so a fresh process needs to be told which graph this run used.
        if (args.flags["graph"] !== undefined) ws.engine.attach(runId, loadGraph(ws, requireFileFlag(args, "graph")));
        const p = await ws.engine.resolveGate(runId, {
          gateId,
          // `--reject` with no value stays legal and IS the decision: rejecting without
          // giving a reason is a thing an operator may do, and `String(true)` here writes
          // a reason nobody typed rather than a decision nobody made.
          decision: reject === undefined ? { kind: "approve" } : { kind: "reject", reason: reject === true ? "(no reason given)" : reject },
          // `--as` is the SUBJECT this approval is journaled under and matched against a
          // gate's approvers list, so `String(true)` there put the four letters "true" into
          // an audit record as the person who approved. It is the same slip as `--token`
          // and `--port`, on the one flag in this file whose value ends up in the journal.
          actor: { kind: "human", subject: subjectFlag(args), via: "cli" },
          idempotencyKey: `cli:${gateId}`,
        });
        process.stdout.write(`${JSON.stringify({ status: p.status, outputs: p.outputs }, null, 2)}\n`);
        return p.status === "failed" ? 1 : 0;
      }

      case "replay": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const graph = loadGraph(ws, requireFileFlag(args, "graph"));
        const report = await replayRun({
          store: ws.store,
          runId,
          graph,
          engine: { tools: ws.engine.tools, functions: ws.engine.functions, models: ws.engine.models },
        });
        for (const f of report.frames.filter((x) => !x.match)) {
          process.stderr.write(`✗ ${f.kind} ${f.taskId ?? ""}: expected ${f.expected}, got ${f.actual}\n`);
        }
        process.stdout.write(`${JSON.stringify({ match: report.match, hermetic: report.hermetic }, null, 2)}\n`);
        return report.match ? 0 : 1;
      }

      case "trace": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const graph = loadGraph(ws, requireFileFlag(args, "graph"));
        const events = [];
        for await (const e of ws.store.read(runId, 1)) events.push(e);
        const spans = spansFrom(events);
        for (const s of spans) {
          const depth = s.parentSpanId === undefined ? 0 : 1;
          process.stdout.write(`${"  ".repeat(depth)}${s.name} [${s.status}] ${s.endTime - s.startTime}ms\n`);
        }
        const conformance = conformsToGraph(reconstructGraph(spans), graph.spec, graph.graphHash);
        process.stdout.write(`\nconformance: ${conformance.ok ? "ok" : JSON.stringify(conformance)}\n`);
        return conformance.ok ? 0 : 1;
      }

      default:
        process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
        return 2;
    }
  } finally {
    ws.close();
  }
}

function requirePositional(args: Args, i: number, what: string): string {
  const v = args.positional[i];
  if (v === undefined) throw new Error(`${args.command} requires ${what}`);
  return v;
}

/**
 * A flag whose value is a PATH, refused when the shell gave it none — `undefined` allowed.
 *
 * The same two slips `--token` is guarded against, one flag over: a path flag with no
 * value is `true` from `parseArgs`, and `String(true)` sent `readFileSync` looking for a
 * file called `true`; `--flag=` with an unset variable is `""`, and `resolve("")` is the
 * current directory. Both eventually do SOMETHING — `ENOENT … open 'true'`, `EISDIR`, or a
 * working journal in a directory called `true` — and none of them names the flag or the
 * mistake.
 *
 * Not merely cosmetic on any of the five flags that take one. Two are the perimeter (who
 * may approve) and the return path (how they answer); two decide where the journal lives,
 * which invariant 2 makes the only authoritative durable state; and `--graph` is what a
 * `replay` verifies against. An operator debugging `ENOENT 'true'` is an operator who has
 * not yet started reading the line above it.
 *
 * ABSENCE IS A SEPARATE QUESTION and belongs to the caller, which is why this returns
 * `undefined` rather than refusing it: `--workspace` defaults to the cwd, `--graph` on
 * `approve` is optional, and `--identity-file` is optional in a way `--graph` on `replay`
 * is not. `requireFileFlag` is this plus that one extra question.
 */
function pathFlag(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (v === true || v === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--${name} needs a path: ${v === "" ? `the one given was empty (\`--${name} "$FILE"\` does this when the variable is unset)` : "the flag was given with no value at all"}. ` +
        `Omit the flag entirely to run without one.`,
    );
  }
  return v;
}

/**
 * `--as`, the subject an approval is JOURNALED under — refused when it is not one.
 *
 * The default `cli` is a synthetic label and says so; `String(true)` produced `"true"`,
 * which is not a label, not a subject, and not distinguishable from one an operator meant.
 * `subject` is matched against a gate's approvers list (`server/http.ts`'s `AuthContext`
 * docstring says so of the API's copy of this field), so it is the one value this file
 * writes that decides something as well as describing it — and the Traps note about an
 * audit label that quietly became an authorization key is about exactly this field.
 *
 * It is NOT authenticated here and that is a separate, stated limit: the CLI writes to the
 * journal directly, so anyone who can run it can name anyone. Refusing a value the shell
 * invented is not a claim to have fixed that; it is a refusal to invent one ourselves.
 */
function subjectFlag(args: Args): string {
  const v = args.flags["as"];
  if (v === undefined) return "cli";
  if (v === true || v === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--as needs a subject: ${v === "" ? "the one given was empty" : "the flag was given with no value at all, and a missing value used to become the four letters \"true\""}. ` +
        `It is written into the journal as the person who decided this gate. Omit it to be recorded as "cli".`,
    );
  }
  // A PARENTHESISED SUBJECT IS A MARKER, NOT A NAME. The control plane mints
  // `(unidentified)` and `(shared-token)` to record what the perimeter concluded, and the
  // compiler refuses a graph that lists one as an approver. This is the third door to the
  // same value — `loom approve <run> <gate> --as "(unidentified)"` would journal a decision
  // under a subject that names nobody, and satisfy an approvers list naming it.
  if (isSyntheticSubject(v)) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--as "${v}" is a synthetic marker, not a subject: a parenthesised subject is what the control plane writes when ` +
        `it could not identify a caller. It is journaled as the person who decided this gate, so it has to name one.`,
    );
  }
  return v;
}

/** `pathFlag`, for the commands where the path is not optional. */
function requireFileFlag(args: Args, name: string): string {
  const v = pathFlag(args, name);
  if (v === undefined) throw err.validation(CODES.E_CONFIG_INVALID, `--${name} needs a path, and none was given.`);
  return v;
}

/**
 * `--input`, refused rather than coerced — the fourth member of the `String(true)` family.
 *
 * `JSON.parse(String(args.flags["input"] ?? "{}"))` had three ways to go wrong and took a
 * different one for each spelling. Measured:
 *
 *     loom run g.json --input       `true` → `"true"` → JSON.parse → the BOOLEAN true,
 *                                   handed to `engine.submit` as the run's inputs. Status
 *                                   "failed", exit 1, and the diagnosis is a channel
 *                                   binding failure four layers below the mistake.
 *     loom run g.json --input=      E_INTERNAL: SyntaxError: Unexpected end of JSON input
 *     loom run g.json --input nope  E_INTERNAL: SyntaxError: Unexpected token 'o'
 *
 * The last two are loud and MISFILED, which is its own defect: `E_INTERNAL` is this
 * system's word for "a bug in Loom", and `server/http.ts`'s `safeDecode` states the rule
 * they break — a caller sending nonsense is not an internal error and must not be reported
 * as one. A JSON typo in an argv is the same class as a malformed request body, which that
 * file answers with `E_PROVIDER_BAD_REQUEST`; here the caller is an operator and the flag
 * is configuration, so it is `E_CONFIG_INVALID` and it names the flag.
 *
 * An ARRAY and `null` parse cleanly and are refused too: `inputs` is a channel map, the
 * signature says `Record<string, unknown>`, and a cast is not a check.
 */
function runInputs(args: Args): Record<string, unknown> {
  const raw = args.flags["input"];
  if (raw === undefined) return {};
  // Annotated on the CONST, not inferred: TypeScript only narrows the flow below from a
  // `never` return when the callee's type says `never` at the declaration site — the same
  // reason `readChannels`'s `refuse` and `checkedAuth`'s carry their signatures.
  const refuse: (why: string) => never = (why) => {
    throw err.validation(CODES.E_CONFIG_INVALID, `--input ${why}. It is a JSON OBJECT of channel values, e.g. --input '{"source":"a.txt"}'.`);
  };
  if (raw === true) refuse("was given with no value at all, and a missing value used to become the boolean `true`");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    refuse(`is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse(`parsed as ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}, which is not an object of channel values`);
  }
  return parsed as Record<string, unknown>;
}

// Entry point. Kept at the bottom so importing this module for tests runs nothing.
if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      const le = isLoomError(e) ? e : toLoomError(e);
      process.stderr.write(`${le.code}: ${le.message}\n`);
      process.exit(1);
    });
}
