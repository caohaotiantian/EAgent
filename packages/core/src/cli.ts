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

import { mkdirSync, readFileSync, readdirSync, existsSync, type Dirent } from "node:fs";
import { hostname } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import { InProcessEventBus } from "./bus.ts";
import { isLoomError, toLoomError } from "./errors.ts";
import { parseYamlSpec } from "./graph/yaml.ts";
import { compile } from "./graph/compile.ts";
import { McpClient, type McpClientOptions } from "./mcp/client.ts";
import { mcpTools } from "./mcp/tools.ts";
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
import {
  BearerTokenIdentity,
  ControlPlane,
  ownershipWarnings,
  unanswerableGraphs,
  type ControlPlaneOptions,
  type IdentitySource,
} from "./server/http.ts";
import { CODES, err } from "./errors.ts";
import { isSyntheticSubject } from "./vocab.ts";
import type { RunProjection, TaskRecord } from "./run/projection.ts";
import { createFunctionLoader } from "./resources/functions.ts";
import { createHookLoader } from "./resources/hook-loader.ts";
import { HookRegistry } from "./run/hooks.ts";
import { FallbackAdapter } from "./providers/fallback.ts";
import { auditRun } from "./journal/audit.ts";
import { ResourceStore, type ResourceKind } from "./resources/store.ts";
import { conformsToGraph, reconstructGraph, spansFrom } from "./telemetry/spans.ts";
import type { GateId, RunId, Seq } from "./ids.ts";
import { isEvent, SYSTEM_ACTOR, type EventPayloads, type HumanActor, type JournalEvent, type SubmittedBy } from "./journal/events.ts";
import { digest, shapeOf } from "./canonical.ts";
import { foldTrajectory, type Trajectory } from "./evolution/trajectory.ts";
import { cohortKeyOf, DEFAULT_WEIGHTS, isGolden, measureCohort, promotionCeiling, scoreTrajectory } from "./evolution/score.ts";

const USAGE = `loom — graph-native multi-agent orchestration

  loom serve   [--workspace .] [--port 8787] [--token T]   start the control plane
               [--host 127.0.0.1]                          WHICH interface. The default is
                                                           loopback: nothing off this
                                                           machine can reach the plane,
                                                           which also means no Slack
                                                           button can answer a gate. A
                                                           non-loopback host needs --token
                                                           or --identity-file — it is
                                                           refused without one
               [--identity-file identities.json]           who may approve, one token each
               [--channels-file channels.json]             how gates reach humans, and how
                                                           humans answer them
               [--sweep-ms 1000]                           how often gate SLAs are checked
  loom compile <graph.json|yaml>                           validate and print diagnostics

  A workspace publishes resources/ by directory, one directory per kind:
    prose  prompt, agent_profile, skill   *.md *.txt
    specs  subgraph, graph                *.json *.yaml *.yml
    code   function, hook                 *.js *.mjs
  A CODE BODY IS A BARE FUNCTION EXPRESSION and nothing else: (view, ctx) => {…}
  for a function, (input, ctx) => {…} for a hook. Not module.exports, not export
  default — the file is EVALUATED, not imported, and its value IS the function.
  graphs/ sits beside resources/ and holds the graphs a run can be re-attached from.
  loom run     <graph.json|yaml> [--input JSON] [--as ID]  run to completion or to a gate
               [--budget USD]                              a ceiling for THIS run
  loom gates   <runId>                                     list open gates
  loom approve <runId> <gateId> --as ID [--reject REASON]  resolve a gate
               [--graph <graph.json|yaml>]                  override the graph lookup
  loom cancel  <runId> --as ID [--reason WHY]              stop a run; needs no graph
  loom replay  <runId> --graph <graph.json|yaml>           replay and verify
  loom trace   <runId> --graph <graph.json|yaml>           print the span tree
  loom audit   <runId> [--graph <file>]      read the journal back and check it holds together
  loom score   <runId>                       judge a finished run against its cohort, and
                                             journal the verdict as evolution.scored
               [--bucket MODE]               WHICH runs count as the same kind of problem.
                                             shape (default) groups every run whose input has
                                             the same structure; exact gives one cohort per
                                             distinct input; fields:a,b groups on the digest
                                             of the named input channels only
  loom cohort  <runId>                       read journaled scores back: this run's verdict and
                                             every run judged under the same key and weights

  --help            print this and exit — also "loom help", and valid after any command
  --workspace DIR   root for graphs/, data, and the tool jail (default: cwd)
  --egress HOSTS    comma-separated allowlist. WITHOUT IT net.fetch is not registered at
                    all: a graph naming it still COMPILES (GRAPH013 is a warning) and
                    fails at the node with E_TOOL_NOT_FOUND. It fails to compile only if
                    it also declares the net:fetch capability — GRAPH017
  --grant CAP,CAP   capabilities no TOOL declares — graph:mutate is the one that
                    matters. A tool capability here is REFUSED, not ignored: they
                    come from what is registered, which is what --allow-exec,
                    --egress and --mcp-file decide
  --as ID           the subject a decision is JOURNALED under, and matched against a
                    gate's approvers. Defaults to "cli", which no approvers list names —
                    so a gate that names anybody needs this. It ends up in the audit
                    record as the person who approved
  --data-dir  DIR   journal location (default: <workspace>/.loom). Off limits to the
                    fs tools wherever it is put, including inside the workspace.
  --models-file F   which providers to call, and which model each ModelRequest.model
                    goes to. Without it every agent node answers "[mock] …". The API
                    key is named by the file and READ FROM THE ENVIRONMENT, never
                    stored in it. Accepted by every command, not just serve.
  --allow-exec P,P  programs proc.exec may run, matched EXACTLY by name — not as a
                    prefix, not as a path. Without it the tool is not registered and
                    the run cannot execute anything. It is the whole CONTAINMENT
                    boundary — a child does its own open(), so allow-listing a shell
                    dissolves the fs jail rather than narrowing it — but not the whole
                    boundary: proc.exec is irreversible, so the graph must also hold
                    proc:exec and it GATES. A TOOL node suspends per call. An AGENT node
                    gates ONCE, before its first turn, at the floor over every tool it
                    can REACH — so one approval covers every call that agent then makes,
                    bounded only by maxTurns. An in-turn call that would gate with no
                    such approval is refused outright: a turn cannot suspend.
  --exec-env  N,N   environment variable NAMES proc.exec passes to the child, ON TOP OF
                    PATH, LANG, LC_ALL and TZ — the minimum a child needs to run at all.
                    No credential is ever inherited: this process holds API keys and
                    passes none of them, so a tool needing one is given it explicitly.
  --mcp-file  F     MCP servers to connect, as {"servers":[{"name":"docs",
                    "command":"npx","args":["-y","@scope/srv"],
                    "envAllow":["PATH","HOME"]}]}.
                    THE CHILD ENVIRONMENT IS EMPTY UNLESS envAllow NAMES VARIABLES.
                    Unlike proc.exec there is no base allow-list, so without PATH the
                    command is not even found — "spawn npx ENOENT". This example carried
                    no envAllow and could not start.
                    Connected BEFORE any graph compiles, so discovered tools are inside the
                    posture floor. EVERY MCP tool is irreversible and therefore gates:
                    tools/list cannot say whether a tool reads a file or wires money, and
                    guessing from its name is a heuristic a hostile server defeats.
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
/**
 * EVERY FLAG THIS BINARY UNDERSTANDS. A flag not on this list is refused, not ignored.
 *
 * `parseArgs` accepts any `--word` and puts it in the map, so a misspelling used to be silence.
 * For most flags that is an annoyance; for `--token` it is the same security bug the `--name=value`
 * support was added to fix, reached by a different route. Measured:
 *
 *     loom serve --token s3cret    → token set, plane authenticated
 *     loom serve --tokne s3cret    → flags {"tokne": "s3cret"}, token ABSENT
 *     loom serve --Token s3cret    → same
 *
 * and absent means "run an open plane on purpose". The operator sees their secret in `ps`, gets
 * no complaint, and has an unauthenticated control plane. That flag's own docstring already says
 * this class is "a security bug rather than an ergonomic gap" — it fixed one spelling of it.
 *
 * ONE LIST, GATED AGAINST THE OTHER TWO. `test/cli/known-flags.test.ts` asserts this equals both
 * the set `USAGE` advertises and the set the code reads, so a flag cannot be added to any one of
 * the three without the other two. A hand-kept list that drifts is how the refusal would start
 * rejecting a real flag.
 */
const KNOWN_FLAGS: readonly string[] = [
  "allow-exec",
  "as",
  "bucket",
  "budget",
  "channels-file",
  "data-dir",
  "egress",
  "exec-env",
  "grant",
  "graph",
  "help",
  "host",
  "identity-file",
  "input",
  "mcp-file",
  "models-file",
  "port",
  "reason",
  "reject",
  "sweep-ms",
  "token",
  "workspace",
];

/**
 * Refuse a flag this binary does not understand, naming the nearest one it does.
 *
 * At the door in `main`, not inside `parseArgs`: the parser stays a parser, and `openWorkspace`
 * is called directly by embedders and tests with flag maps they built themselves.
 */
function assertKnownFlags(args: Args): void {
  const unknown = Object.keys(args.flags).filter((f) => !KNOWN_FLAGS.includes(f));
  if (unknown.length === 0) return;
  const near = (f: string): string => {
    const lower = f.toLowerCase();
    const exact = KNOWN_FLAGS.find((k) => k === lower);
    if (exact !== undefined) return ` (did you mean --${exact}? flags are case-sensitive)`;
    // Same first two letters is a cheap stand-in for an edit distance and catches the
    // transpositions that actually happen: `--tokne`, `--worksapce`, `--modles-file`.
    const head = lower.slice(0, 2);
    const guesses = KNOWN_FLAGS.filter((k) => k.startsWith(head));
    return guesses.length === 0 ? "" : ` (did you mean ${guesses.map((g) => `--${g}`).join(" or ")}?)`;
  };
  throw err.validation(
    CODES.E_CONFIG_INVALID,
    `unknown flag${unknown.length === 1 ? "" : "s"}: ${unknown.map((f) => `--${f}${near(f)}`).join(", ")}. ` +
      `A flag this binary does not understand is IGNORED unless it is refused here — and for --token, ` +
      `ignored means the control plane authenticates nobody. Run \`loom help\` for the list.`,
  );
}

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

/**
 * WHAT THIS PLANE CALLS ITSELF WHEN IT TAKES A LEASE, and until this line every plane
 * everywhere called itself the same thing.
 *
 * `Engine` defaults `workerId` to `"worker-0"` (engine.ts) and `cli.ts` never passed one —
 * `/usr/bin/grep -acn workerId packages/core/src/cli.ts` printed 0. `LeasedScheduler.select`
 * decides mutual exclusion with `if (held.workerId === input.workerId) return true;`, whose
 * purpose is "my own lease, take it back" after a retry or a resolved gate. With one name
 * shared by every process, that line reads a LIVE FOREIGN lease as its own. Driven against a
 * live `worker-0` lease taken at 1000, asked at 1100 with `leaseMs` 30000:
 *
 *     asked as "worker-0":  ["t"]      ← what every `loom` process asked
 *     asked as "worker-B":  []         ← what `contention.test.ts` asks
 *
 * So cross-process exclusion was off by construction, and the suite's only two-worker test
 * could not see it because it hands its two workers distinct ids.
 *
 * DERIVED FROM THE PROCESS, NOT RANDOM — and the distinction CLAUDE.md draws is the reason
 * it may be derived from the process at all. "Every nondeterministic call is recorded under a
 * DERIVED key" is a rule about REPLAY keys: an id you cannot recompute breaks replay. A lease
 * identity is not one. Nothing hashes it, no effect key contains it, and `replay.ts` states
 * that a replayed run appends its OWN `task.leased` rather than matching the original's. What
 * it must be is UNIQUE among everything holding leases on one journal at one instant, which
 * `hostname:pid` gives across machines and processes and the counter gives across two
 * `openWorkspace` handles in one process — a shape the deployment harness produces on purpose
 * and a `loom run` beside a `loom serve` produces by accident.
 */
let workspaceOrdinal = 0;
function planeWorkerId(): string {
  workspaceOrdinal += 1;
  return `${hostname()}:${String(process.pid)}:${String(workspaceOrdinal)}`;
}

interface Workspace {
  readonly root: string;
  readonly dataDir: string;
  readonly store: SqliteStateStore;
  readonly engine: Engine;
  readonly bus: InProcessEventBus;
  readonly resolver: ResourceResolver;
  /** Every hook body this workspace published. Authoritative here: a ref it lacks is a MISSING FILE. */
  readonly hooks: HookRegistry;
  /** What this process may DO — the one list, derived from what it registered. */
  readonly granted: readonly string[];
  /**
   * The programs `proc.exec` may run, or `undefined` when the tool is not registered.
   *
   * Carried onto the Workspace for ONE reason: the boot banner names every guard that is off,
   * and this is the guard whose absence is loudest and was the only one it did not name. A
   * plane with `--allow-exec` has no filesystem jail — `--help` says so at the flag ("a child
   * does its own open(), so allow-listing a shell dissolves the fs jail rather than narrowing
   * it") and the banner said nothing.
   */
  readonly execAllowlist: readonly string[] | undefined;
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
/**
 * `fetchImpl` exists for the same reason `env` does, one step further along.
 *
 * `env` is a parameter so a test can supply a credential without writing one into the
 * process. That got the models FILE under test but not the models PATH: `readModels`
 * already accepts an injected `fetch`, and `openWorkspace` did not thread it, so the only
 * way to exercise a whole graph through a real adapter was to let it reach the network —
 * which the offline-and-deterministic rule forbids, so it was not exercised at all. Every
 * `--models-file` test called `adapter.stream` directly and none ran a graph.
 */
export function openWorkspace(
  args: Args,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: HttpOptions["fetch"],
  /**
   * MCP servers already STARTED, so their tools are registered before the grant list is derived.
   *
   * This parameter exists because the ordering is the whole bug. The grant list is a snapshot
   * taken here — `PolicyEngine` stores it and `Engine` builds one per run from the same array —
   * so a tool registered after this function returns is a tool whose capability nobody holds.
   * MCP used to be connected in `main` AFTER `openWorkspace`, which meant `mcp:<server>` was
   * absent from both `tenantCapabilities` and the engine's grant: a graph naming an MCP tool
   * failed to COMPILE, and W8's claim to have unbricked MCP was false. Reproduced against a real
   * stdio server by a reviewer.
   */
  mcp: readonly McpClient[] = [],
): Workspace {
  // BEFORE ANYTHING IS CREATED OR OPENED. A malformed channels file is a refusal to start,
  // and a refusal that has already made a directory and opened a SQLite handle is a
  // refusal that leaks one — `main`'s `finally` only closes a workspace it was handed.
  const delivery = args.flags["channels-file"] === undefined ? undefined : readChannels(requireFileFlag(args, "channels-file"));
  // Same rule, same reason: a models file naming an env var that is not set is a refusal
  // to start, and it must happen before the journal is opened. `env` is a PARAMETER so a
  // test can hand this function a key without writing one into the process — the same
  // injection every clock and id source in this codebase takes, applied to the one input
  // that is a credential.
  const models =
    args.flags["models-file"] === undefined ? undefined : readModels(requireFileFlag(args, "models-file"), env, fetchImpl);

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
  // CREATED SO THAT DENYING IT MEANS SOMETHING. `assertWithin` canonicalises a deny entry with
  // `realpathSync.native` precisely to defeat case tricks — and `realpath` can only canonicalise
  // a path that EXISTS. On a fresh workspace `resources/` did not, so the comparison fell back
  // to a lexical one and `RESOURCES/prompt/p.md` walked straight past it on any
  // case-insensitive filesystem, which is the default on macOS and Windows. Measured: a tool
  // node wrote it, the directory it created WAS `resources/` for the next boot's `readdirSync`,
  // and the run after that was handed "PWNED via case" as its system prompt. The same trick
  // reopened arbitrary GRAPH injection through `resources/subgraph/`.
  //
  // `.loom` was never exposed to this for the one reason that matters: it is always created
  // here. The deny-list was right and the directory's absence made it advisory.
  mkdirSync(join(root, "resources"), { recursive: true });

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
  // READ BEFORE THE JAIL IS BUILT, so a malformed flag refuses before any tool is registered.
  const egressHosts = listFlag(args, "egress", "a hostname");
  const execPrograms = listFlag(args, "allow-exec", "a program name");
  const execEnvNames = listFlag(args, "exec-env", "an environment variable name");
  const jail = {
    root,
    // `resources/` JOINS THE DATA DIR, and for a sharper reason than the journal has. Its
    // files become the SYSTEM PROMPT of the next run, so a workspace that let a run write
    // there let a run author its own instructions — durable prompt injection, reproduced end
    // to end: a `tool` node writing `resources/prompt/p.md` succeeded, and the next boot
    // served "PWNED: ignore all prior instructions." as that node's system message.
    //
    // The symlink refusal in `readResources` was the half of this that got noticed. It stops
    // a run READING `/etc/passwd` through a planted link; it does nothing about a run WRITING
    // the operator's prompt, which is the half that matters more. Both halves are the same
    // rule — what a run may not do is decide what the next run is told.
    //
    // AND `graphs/` IS THE SAME RULE ONE STEP OVER, which this list did not cover. A run holds
    // `fs:write` unconditionally (see the grant below), and `discoverGraphs` reads this directory
    // to build the index a `serve` process answers gates from. Reproduced: a run writes
    // `graphs/zz-planted.json` whose `metadata.name` collides with the operator's, and the real
    // graph is EVICTED from the index — after which a gate on a run using it cannot be answered,
    // while `GateSweeper` needs no attachment and expires it into `run.failed`. A run could strip
    // oversight from other runs. "What a run may not do is decide what the next run is told" and
    // "…what the next run IS" are one sentence.
    deny: [dataDir, join(root, "resources"), join(root, "graphs")],
    ...(egressHosts === undefined ? {} : { egressAllowlist: egressHosts }),
    // Both default to absent, and absent means the tool is not registered at all. A run
    // that never names a program cannot run one — see `procExec`, where the allowlist is
    // the entire boundary rather than one check among several.
    ...(execPrograms === undefined ? {} : { execAllowlist: execPrograms }),
    ...(execEnvNames === undefined ? {} : { execEnvAllow: execEnvNames }),
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

  // BUILT BEFORE THE ENGINE, AND HANDED TO IT — which it was not, and the omission cost a
  // whole node type. `Engine` falls back to `{resolve: () => undefined}` when it is given no
  // resolver, so every ref lookup on the RUNTIME path answered nothing in the shipped binary
  // while the compile path (which reads `Workspace.resolver` directly) worked fine. Measured:
  // a `subgraph` node through `bin/loom` failed `E_RESOURCE_NOT_FOUND: subgraph
  // "subgraph/child@stable" does not resolve to a GraphSpec`, and `HANDOFF.md`'s "all eight
  // node types execute" was a statement about the engine with an injected resolver rather
  // than about the product. The declaration used to sit below this constructor, which is the
  // entire bug.
  // THE WORKSPACE'S OWN RESOURCES, layered over the pin. `<workspace>/resources/prompt/x.md`
  // publishes `prompt/x@stable`, and an agent node naming it is sent the FILE rather than the
  // eleven characters of its ref — which is what it was sent for the whole project.
  //
  // LAYERED, not substituted: a ref with no file still pins exactly as it did, so a graph with
  // no `resources/` directory compiles unchanged and `humanGate.ref`/`function` refs — which
  // are pins by design and have no documents — are untouched.
  const documents = new ResourceStore({ seed: readResources(root) });
  const resolver: ResourceResolver = {
    // Without a published document, refs resolve to a digest of their own name. That is
    // enough for the compiler's pinning to be structurally correct locally.
    resolve: (ref) => documents.resolve(ref),
    document: (pinned) => documents.document(pinned),
    // A CHILD GRAPH IS A DOCUMENT TOO, and its absence is why a `subgraph` node had never run
    // through this binary: the engine asks `resolver.subgraph?.(ref)` and the stand-in — a PIN
    // resolver — has no such method, so the call answered `undefined` and every delegated run
    // failed `E_RESOURCE_NOT_FOUND`.
    subgraph: (ref) => documents.subgraph(ref),
  };

  // EVERY PUBLISHED FUNCTION BODY, COMPILED AND REGISTERED.
  //
  // `createFunctionLoader` is the fourth capability this repo shipped with no caller, after
  // `runSandboxed`, `McpClient` and `ResourceStore` — the CLI built a bare `new
  // FunctionRegistry()` and nothing ever put anything in it. So a graph with a `function` node
  // compiled clean and failed at run time with `no function registered as "function/x@stable"`,
  // and both shipped example workflows were unrunnable for the same reason.
  //
  // Registered EAGERLY rather than lazily, because `FunctionRegistry.register(ref, body)` is
  // keyed by ref and the engine looks up by ref: a lazy loader would need a second lookup path
  // into the same registry, which is the shape that lets two answers disagree. A body that does
  // not evaluate refuses HERE, at boot, where an operator is watching — not inside a run.
  const functions = new FunctionRegistry();
  registerFunctions(documents, functions, root);

  // EVERY PUBLISHED HOOK BODY, COMPILED AND REGISTERED — and until this line the entire
  // extension surface was unreachable through the binary. `Engine.#hooks` is `undefined`
  // when no registry is passed, and no caller passed one, so `#hooksFor` returned `[]` at
  // all eight points: a graph declaring `hooks: {preTool: [...]}` compiled, validated,
  // pinned the ref, and ran with the hook never firing.
  const hooks = new HookRegistry();
  registerHooks(documents, hooks, root);

  // ONE DERIVATION, USED HERE AND BY THE COMPILER — see `capabilitiesOf`.
  // MCP TOOLS BEFORE THE GRANT IS DERIVED. Connecting the server IS the grant — that is W8's
  // whole argument — and it only holds if the registration happens first.
  for (const client of mcp) for (const t of mcpTools(client)) tools.register(t);

  const granted = capabilitiesOf(tools, grantFlag(args));
  const engine = new Engine({
    store,
    bus,
    // A NAME OF ITS OWN, so a live lease held by another plane is another plane's. See
    // `planeWorkerId` for the measurement that says why the default could not stay.
    workerId: planeWorkerId(),
    resolver,
    tools,
    functions,
    hooks,
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
      policy: { granted },
    // EXPLICIT, so `armForeignGates` can hold the same number. The sweep's window and the
    // arming's window are the same window or the clock has a hole in it — see
    // `GATE_CLOCK_LIMIT`, which is the only place either of them reads it from.
    sweep: { limit: GATE_CLOCK_LIMIT },
  });

  return { root, dataDir, store, engine, bus, resolver, hooks, granted, execAllowlist: execPrograms, delivery, models, close: () => store.close() };
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
      const row = s as { subject?: unknown; token?: unknown; kind?: unknown; via?: unknown; mfa?: unknown; operator?: unknown };
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
      // `operator` JOINS `kind` IN THE REFUSED CLASS, by the same rule and one step further.
      // Dropping a malformed value here would fail CLOSED — the default is `false` — which is
      // exactly the argument that makes the refusal look unnecessary and is beside the point:
      // this field grants read access to every run in the journal, and whether a deployment
      // has an operator must not be decided by whether a typo happened to be truthy.
      // `"operator": "true"` would otherwise leave a plane silently with none, discovered
      // when nobody can see anything.
      if (row.operator !== undefined && typeof row.operator !== "boolean") {
        throw err.validation(
          CODES.E_CONFIG_INVALID,
          `--identity-file ${path}: entry ${i} ("${row.subject}") has operator ${JSON.stringify(row.operator)}, which must be true or ` +
            `false. It is not dropped, because it grants this credential read access to every run in the journal.`,
        );
      }
      return {
        subject: row.subject,
        token: row.token,
        ...(row.kind === undefined ? {} : { kind: row.kind }),
        ...(isVia(row.via) ? { via: row.via } : {}),
        ...(typeof row.mfa === "boolean" ? { mfa: row.mfa } : {}),
        ...(row.operator === true ? { operator: true as const } : {}),
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

/**
 * What the boot banner says about `proc.exec`, as a pure function of what was registered.
 *
 * SEPARATE FROM THE BANNER so the interesting half is testable without a socket. `serve` blocks,
 * so a test that wants these lines otherwise has to spawn a process and race its stderr; the
 * decision is worth checking directly, because the part most likely to be wrong is the
 * interpreter list rather than the printing.
 *
 * TWO LINES, NOT ONE, and the split is the point. The first states what `proc.exec` being
 * registered costs: a child does its own `open()` and its own `connect()`, so `assertWithin` and
 * the `--egress` allowlist bind this plane's own tools and not the child. `--help` has said that
 * at the flag for a long time; the banner did not. The second fires only for an INTERPRETER,
 * because allow-listing `grep` narrows what a child may do and allow-listing `sh` names one entry
 * and permits everything — an operator reading a one-line allowlist should be told which of the
 * two they just did.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY: that the plane is unsafe. `proc.exec` is irreversible, so it
 * carries the oversight floor and gates before it runs. The banner reports a boundary that is
 * open, not a run that is unsupervised, and conflating those is how a warning gets ignored.
 */
export function execWarnings(allowlist: readonly string[] | undefined): readonly string[] {
  if (allowlist === undefined || allowlist.length === 0) return [];
  const out = [
    `! EXEC IS REGISTERED — proc.exec may run: ${allowlist.join(", ")}\n` +
      `  A child process does its own open() and its own connect(), so the filesystem jail\n` +
      `  (assertWithin) and the --egress allowlist bind this plane's OWN tools and not this\n` +
      `  child. Every gate still holds: proc.exec is irreversible, so it gates before it runs.\n`,
  ];
  // Matched on the BASENAME, because `--allow-exec` matches a program by name and an operator
  // writes the path they have. Version suffixes are included (`python3.11`) for the same reason:
  // the thing that makes it an interpreter is not the digits.
  const interpreters = allowlist.filter((p) => {
    const base = p.split("/").pop() ?? p;
    return /^(sh|bash|zsh|fish|dash|ksh|node|deno|bun|python\d*(\.\d+)?|perl|ruby|php|env|xargs|awk|sed)$/.test(base);
  });
  if (interpreters.length > 0) {
    out.push(
      `! …AND ${interpreters.join(", ")} RUNS ARBITRARY CODE — the allowlist names ` +
        `${String(allowlist.length)} program(s)\n` +
        `  and permits anything they can spawn. This is a containment boundary in name only.\n`,
    );
  }
  return out;
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
  /** Routes whose model has no price, so every call on them costs a journaled `0`. */
  readonly unpriced: readonly string[];
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
  /** routeKey → every (adapter, model) it can reach, primary first. Only the pricing check reads it. */
  const chainTiers = new Map<string, { adapter: string; model: string }[]>();
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
    const model = nonEmpty(row["model"], `${where} "model"`, refuse);

    // DECLARATIVE FALLBACK CHAINS, which the README promised and nothing constructed.
    // `FallbackAdapter` has been written and tested since the provider layer landed;
    // `grep -ran 'new FallbackAdapter' src/` returned nothing, and a route row could only ever
    // name one adapter, so the capability was real and unreachable — on the row a reader
    // consults before pointing this at a provider.
    //
    // The chain becomes a SYNTHETIC ADAPTER and the route points at it, so `RoutingAdapter` is
    // untouched: it still maps one key to one adapter, and the fanning-out happens a layer down
    // where `FallbackAdapter` already refuses a policy-class code at construction.
    const rawTiers = row["fallback"];
    if (rawTiers !== undefined) {
      if (!Array.isArray(rawTiers) || rawTiers.length === 0) {
        refuse(`${where} "fallback" must be a non-empty list of {"adapter":…,"model":…,"when":[…]}`);
      }
      const tiers = (rawTiers as unknown[]).map((rawTier, i) => {
        const at = `${where} fallback[${String(i)}]`;
        const tier = rawTier as Record<string, unknown> | null;
        if (typeof tier !== "object" || tier === null || Array.isArray(tier)) refuse(`${at} is not an object`);
        const name = nonEmpty(tier["adapter"], `${at} "adapter"`, refuse);
        // REFUSED, not skipped — the same rule the adapter rows make, for the same reason: a
        // skipped tier is a chain that looks like resilience and has none.
        if (!adapters.has(name)) {
          refuse(`${at} names adapter "${name}", which is not declared. Declared: ${[...adapters.keys()].join(", ")}`);
        }
        const when = tier["when"];
        if (when !== undefined && !(Array.isArray(when) && when.every((c) => typeof c === "string"))) {
          refuse(`${at} "when" must be a list of normalized error codes, e.g. ["E_PROVIDER_RATE_LIMIT"]`);
        }
        return {
          adapter: adapters.get(name)!,
          model: nonEmpty(tier["model"], `${at} "model"`, refuse),
          ...(when === undefined ? {} : { when: when as readonly string[] }),
        };
      });
      chainTiers.set(key, [{ adapter, model }, ...(rawTiers as Record<string, unknown>[]).map((tr, i) => ({ adapter: String(tr["adapter"]), model: String(tr["model"] ?? `?${String(i)}`) }))]);
      const chainName = `chain(${key})`;
      try {
        adapters.set(chainName, new FallbackAdapter({ provider: chainName, primary: { adapter: adapters.get(adapter)!, model }, fallback: tiers }));
      } catch (e) {
        // `FallbackAdapter` refuses a chain naming a policy-class code AT CONSTRUCTION —
        // retrying a content filter elsewhere is evasion, not resilience. Re-raised naming the
        // file and the row, exactly as an adapter's own construction refusal is.
        if (isLoomError(e)) refuse(`${where} "fallback": ${e.message}`);
        throw e;
      }
      routes.set(key, { adapter: chainName, model });
      continue;
    }

    routes.set(key, { adapter, model });
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
    // WHICH ROUTES COST NOTHING, computed here because this is where both halves are in hand.
    // A model outside the adapter's price table prices at ZERO — `priceOf` returns 0 for an
    // unknown id — and a budget compares against a number, so a run on an unpriced model spends
    // without limit while reporting `costUsd: 0`. That matters more since a graph's declared
    // `policy.budget.costUsd` became a real ceiling: the ceiling is unreachable if nothing ever
    // approaches it. Probed with a million tokens each way, which is the unit the tables use.
    // EVERY TIER, not just the one a route names. A chain whose fallback is unpriced spends
    // without limit the moment it falls through, and the run reports `costUsd: 0` for it —
    // which is the same hole this check exists to close, one tier down.
    unpriced: [...routes.entries()].flatMap(([key, r]) => {
      const reach = chainTiers.get(key) ?? [{ adapter: r.adapter, model: r.model }];
      return reach
        .filter((t) => adapters.get(t.adapter)?.priceOf(t.model, { inputTokens: 1e6, outputTokens: 1e6 }) === 0)
        .map((t) => `${key} → ${t.adapter}/${t.model}`);
    }),
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
/**
 * `--budget USD`, refused rather than clamped — the same family as every other caller-supplied
 * number in this file.
 *
 * NOT `positive`, which demands a whole number of MILLISECONDS: a budget is dollars and is
 * fractional by nature, so `--budget 0.50` would have been refused by it and `--budget 1e400`
 * accepted by nothing. `NaN` is the case that matters, because every comparison against it is
 * false — so a budget of `NaN` is not a loose cap, it is no cap, while the run reports a budget.
 *
 * It composes by MIN with the graph's own `policy.budget.costUsd` and the deployment's
 * `policy.budget.runUsd`, so this flag can only ever lower a ceiling.
 */
function budgetFlag(args: Args): number | undefined {
  const raw = args.flags["budget"];
  if (raw === undefined) return undefined;
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--budget must be a positive number of US dollars, not ${typeof raw === "string" ? `"${raw}"` : String(raw)}`,
    );
  }
  return n;
}

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

/**
 * `--mcp-file` — which MCP servers to connect, and under what name.
 *
 * A file rather than a flag, for the reason `--models-file` is one: a server entry carries a
 * command, an argv and an environment allow-list, and none of those survive being flattened
 * into a comma-separated string legibly.
 *
 * Refuses to start on a malformed file, the same trade `readModels` and `readChannels` make:
 * booting anyway produces a deployment that looks configured and whose every MCP call fails
 * with "unknown tool".
 */
export function readMcpServers(file: string): readonly McpClientOptions[] {
  const path = resolve(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw err.validation(CODES.E_CONFIG_INVALID, `--mcp-file ${path}: ${(e as Error).message}`);
  }
  const refuse: (why: string) => never = (why) => {
    throw err.validation(CODES.E_CONFIG_INVALID, `--mcp-file ${path}: ${why}`);
  };
  const rows = (parsed as { servers?: unknown } | null)?.servers;
  if (!Array.isArray(rows) || rows.length === 0) {
    // `envAllow` IS IN THE EXAMPLE because the example is what gets copied. Without it the
    // child environment is empty, `npx` is not on a PATH that does not exist, and the operator
    // gets `spawn npx ENOENT` — from a config shape this message handed them. USAGE has said so
    // at length for a while; the refusal did not, and the refusal is the one a reader is
    // holding when they write the file.
    refuse(
      `must be {"servers":[{"name":"docs","command":"npx","args":["-y","@scope/server"],` +
        `"envAllow":["PATH","HOME"]}]} with at least one server. The child environment is EMPTY ` +
        `unless envAllow names variables, so a command found via PATH needs "PATH" listed.`,
    );
  }
  const seen = new Set<string>();
  return rows.map((raw, i): McpClientOptions => {
    const where = `servers[${String(i)}]`;
    const row = raw as Record<string, unknown> | null;
    if (typeof row !== "object" || row === null || Array.isArray(row)) refuse(`${where} is not an object`);
    const name = row["name"];
    const command = row["command"];
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) {
      refuse(`${where}.name must match [A-Za-z0-9_-]+ — it becomes part of every tool id as mcp__<name>__<tool>`);
    }
    if (typeof command !== "string" || command.length === 0) refuse(`${where}.command is required`);
    // A duplicate name would have the second server's tools shadow the first's silently,
    // which is the same refusal `readModels` makes about a duplicate adapter.
    if (seen.has(name)) refuse(`${where}.name "${name}" is used twice`);
    seen.add(name);
    const args = row["args"];
    const envAllow = row["envAllow"];
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
      refuse(`${where}.args must be an array of strings — a command line assembled from a single string is how argument injection happens`);
    }
    if (envAllow !== undefined && (!Array.isArray(envAllow) || envAllow.some((a) => typeof a !== "string"))) {
      refuse(`${where}.envAllow must be an array of variable NAMES`);
    }
    return {
      name,
      command,
      ...(args === undefined ? {} : { args: args as readonly string[] }),
      ...(envAllow === undefined ? {} : { envAllow: envAllow as readonly string[] }),
    };
  });
}

/**
 * Connect every configured server and register its tools BEFORE any graph is compiled.
 *
 * The ordering is the load-bearing part. An agent node's posture floor is a `max` over
 * `reachableToolNames`, computed at COMPILE time — so a tool registered after the compile is
 * a tool the floor never saw, and invariant 5 is defeated by ordering rather than by
 * argument. `loadGraph` reads `ws.engine.tools.manifests()`, so registering here puts every
 * discovered tool inside that computation.
 *
 * A server that fails to start is fatal, not skipped. Skipping produces a run whose graph
 * compiled against tools that are not there, which fails later and further away.
 */
export async function startMcp(servers: readonly McpClientOptions[]): Promise<readonly McpClient[]> {
  const clients: McpClient[] = [];
  for (const opts of servers) {
    const client = new McpClient(opts);
    try {
      await client.start();
    } catch (e) {
      for (const c of clients) c.close();
      client.close();
      // ENOENT WITH NO `PATH` IS ALMOST ALWAYS THE ENV, NOT THE COMMAND — and "spawn npx
      // ENOENT" points an operator at their command, which is usually fine. The child gets only
      // what `envAllow` names (`McpClient.start`), so a command resolved through PATH cannot be
      // found unless PATH is listed. Measured on the documented example: `command: "node"` with
      // no envAllow fails ENOENT, and the same config with an absolute path starts.
      const why = (e as Error).message;
      const missingPath =
        /ENOENT/.test(why) && !(opts.envAllow ?? []).includes("PATH") && !opts.command.includes("/");
      throw err.unavailable(
        CODES.E_TOOL_SOURCE_UNAVAILABLE,
        `mcp server "${opts.name}" failed to start: ${why}` +
          (missingPath
            ? `. The child environment is EMPTY unless envAllow names variables, and this server does ` +
              `not list "PATH" — so "${opts.command}" cannot be found. Add "envAllow":["PATH"] to it, ` +
              `or give an absolute command path.`
            : ""),
      );
    }
    clients.push(client);
  }
  return clients;
}

/**
 * `introducing` — whether this graph is being brought INTO the deployment, or matched back to a
 * run that already exists.
 *
 * The distinction decides one thing: whether a declared hook with no published body refuses.
 * Introducing (`compile`, `run`, an explicit `--graph`, the server's catalogue) it must —
 * that is the whole point. RE-ATTACHING it must not, and the reason is invariant 5 rather than
 * convenience: `graphsByHash` exists so a human can answer a GATE on a run that is already in
 * flight, and it swallows a compile failure per file. A refusal there does not surface as "your
 * hook is missing" — the graph silently drops out of the index and the approver is told the run
 * cannot be found. Letting a deleted extension file block human oversight of a live run is a
 * worse failure than the silence this check exists to end, so the check does not run there.
 */
function loadGraph(ws: Workspace, file: string, introducing = true): RunGraph {
  const spec = readSpec(file);
  const result = compile({
    spec,
    resolver: ws.resolver,
    tools: (ws.engine.tools as ToolRegistry).manifests(),
    // Every registered MCP tool declares `mcp:<server>`, and a capability the tenant does
    // not hold is a compile error — so a connected server has to appear here or its tools
    // are visible to the compiler and unusable by every graph.
    // THE SAME LIST THE ENGINE ENFORCES. It used to be a second, longer literal — the compiler
    // was told the tenant held `proc:exec` and every `mcp:*` while the PolicyEngine was handed
    // three capabilities — so a graph could compile `ok` and be denied at run time.
    tenantCapabilities: ws.granted,
  });
  if (!result.ok) {
    for (const d of result.diagnostics) {
      process.stderr.write(`${d.severity === "error" ? "✗" : "!"} ${d.code}: ${d.message}\n`);
      if (d.fix !== undefined) process.stderr.write(`   fix: ${d.fix}\n`);
    }
    throw result.error;
  }
  for (const d of result.diagnostics) process.stderr.write(`! ${d.code}: ${d.message}\n`);
  if (introducing) requireHookBodies(ws, result.graph.spec);
  return result.graph;
}

/**
 * A DECLARED HOOK WITH NO PUBLISHED BODY IS A REFUSAL HERE, and a skip inside the engine.
 *
 * The two rules do not disagree, because the registries are not the same kind of thing.
 * `HookRegistry.resolve` skips an unknown ref on purpose — an embedder that simply does not
 * install an optional extension has not written a broken graph. But THIS registry is built from
 * the workspace, by `registerHooks`, out of `resources/hook/`. A ref it lacks is a MISSING FILE,
 * and a missing file is exactly the "declared, pinned, and silent" failure the hook bus exists to
 * end. Answering it with a shrug would rebuild that failure one level up.
 *
 * At compile time, so `loom compile` says it — before a run, before a model call, before spend.
 */
function requireHookBodies(ws: Workspace, spec: GraphSpec): void {
  const missing: string[] = [];
  for (const [point, refs] of Object.entries(spec.hooks ?? {})) {
    // Guarded like the compiler's own copies: `hooks: {preNode: 42}` is caller data, and the
    // validator refuses that shape — but this runs on the way there and must not crash first.
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (typeof ref !== "string" || ws.hooks.get(ref) !== undefined) continue;
      missing.push(`${point}: ${ref}`);
    }
  }
  if (missing.length === 0) return;
  throw err.validation(
    CODES.E_RESOURCE_NOT_FOUND,
    `this graph declares ${missing.length} hook(s) this workspace does not publish (${missing.join(", ")}). ` +
      `Add the body at ${join(ws.root, "resources", "hook")}/<name>.js — a hook that is declared and absent ` +
      `does not fail, it does NOTHING, which is the failure that cannot be seen from the graph`,
  );
}

/**
 * Every graph in the workspace, keyed by the thing a run is looked up BY.
 *
 * `discoverGraphs` keys by `metadata.name` and keeps the first of a collision, which is right for
 * `submit by name` and wrong here: `metadata.version` is part of `GraphSpec`, so keeping
 * `payroll-v1.json` beside `payroll-v2.json` is the ordinary shape — and under a name-keyed
 * lookup the second one's runs became permanently un-approvable, with a warning that named
 * neither the run nor `--graph`. Reproduced by a reviewer.
 *
 * Hash-keyed, no collisions possible: two files with the same hash ARE the same graph.
 */
/**
 * What this process may actually DO, derived once from what it registered.
 *
 * THERE WERE TWO LISTS AND THEY DISAGREED BY CONSTRUCTION. The compiler was told the tenant held
 * `proc:exec` and every `mcp:<server>`; the PolicyEngine was handed a hardcoded
 * `["fs:read","fs:write","net:fetch"]` 830 lines away. So `loom compile` said `ok` for a graph
 * naming `proc.exec` or an MCP tool, and `loom run` failed it `E_CAP_DENIED` — which meant
 * `--allow-exec` and `--mcp-file` could never produce a successful call, and the whole
 * `sandbox/subprocess.ts` path and the entire MCP client were unreachable from the deployment.
 * Two answers to one question is how they came to disagree; this is the question.
 *
 * DERIVED FROM THE REGISTRY, and that is the security argument rather than a convenience. A tool
 * is registered ONLY when the operator passed the flag that registers it: `proc.exec` needs
 * `--allow-exec`, `net.fetch` needs `--egress`, MCP tools need `--mcp-file`. So "registered
 * implies granted" says exactly "the operator asked for this", and a capability nobody asked for
 * is held by nobody. Widening the grant list can only happen by widening what is registered,
 * which is a flag an operator types.
 */
/**
 * Compile and register every `function/*` resource the workspace publishes.
 *
 * A REFUSAL AT BOOT, NOT INSIDE A RUN. `createFunctionLoader` evaluates the body in a `vm`
 * context with `SAFE_GLOBALS`, so a syntax error or a body that is not a function is caught here,
 * where the message reaches an operator's terminal — rather than at the moment a node executes,
 * halfway through a run that has already spent money.
 */
function registerFunctions(store: ResourceStore | undefined, functions: FunctionRegistry, root: string): void {
  if (store === undefined) return;
  const loader = createFunctionLoader({ store });
  for (const version of store.list({ kind: "function" })) {
    const ref = `function/${version.name}@stable`;
    try {
      const body = loader.load(ref);
      if (body !== undefined) functions.register(ref, body);
    } catch (e) {
      // One bad body must not stop the process from serving every other graph — the same rule
      // `readResources` and `discoverGraphs` already follow — but it is announced, because a
      // silently absent function is exactly the failure this whole change is about.
      process.stderr.write(`! skipping ${ref} in ${join(root, "resources", "function")}: ${(e as Error).message}\n`);
    }
  }
}

/**
 * Compile and register every `hook` resource the workspace publishes.
 *
 * Same shape as `registerFunctions` and for the same reason: one bad body must not stop the
 * process from serving every other graph, and it is ANNOUNCED, because a silently absent
 * extension is the failure this whole change is about.
 */
function registerHooks(store: ResourceStore | undefined, hooks: HookRegistry, root: string): void {
  if (store === undefined) return;
  const loader = createHookLoader({ store });
  for (const version of store.list({ kind: "hook" })) {
    const ref = `hook/${version.name}@stable`;
    try {
      const body = loader.load(ref);
      if (body !== undefined) hooks.register(ref, body);
    } catch (e) {
      process.stderr.write(`! skipping ${ref} in ${join(root, "resources", "hook")}: ${(e as Error).message}\n`);
    }
  }
}

function capabilitiesOf(tools: ToolRegistry, extra: readonly string[] = []): readonly string[] {
  const fromTools = Object.values(tools.manifests()).flatMap((m) => m.capabilities);
  // `--grant` MAY NOT NAME A TOOL CAPABILITY, which its own docstring already promised and
  // nothing enforced. `--grant proc:exec` without `--allow-exec` compiled `ok`, the run then
  // RAISED A GATE — a human asked to authorize `proc.exec` — and failed `E_TOOL_NOT_FOUND` after
  // the approval. That is verbatim the defect this function is named for, reopened by the flag
  // that shipped alongside it. A capability with no tool behind it is a grant that authorizes
  // nothing and misleads everything.
  const tooling = new Set(fromTools);
  const overreach = extra.filter((c) => tooling.has(c) || /^(fs|net|proc|mcp):/.test(c));
  if (overreach.length > 0) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--grant cannot grant tool capabilities (${overreach.join(", ")}): they come from what is REGISTERED, ` +
        `which --allow-exec, --egress and --mcp-file decide. Granting one with no tool behind it asks a human ` +
        `to authorize something nothing can run`,
    );
  }
  return [...new Set([...fromTools, ...extra])].sort();
}

/**
 * `--grant CAP,CAP` — capabilities no tool declares.
 *
 * `graph:mutate` is the one that matters and it was a catch-22: declaring it in a graph is
 * `GRAPH017_CAPABILITY_NOT_GRANTED` at compile, whose fix text says "grant it to the tenant" —
 * which no flag could do — and omitting it compiles and then denies at dispatch, AFTER the model
 * call that proposed the mutation was paid for.
 *
 * Deliberately NOT a way to grant a tool capability the process has no tool for: that would be a
 * grant with nothing behind it, and the registry is the source for those.
 */
function grantFlag(args: Args): readonly string[] {
  const raw = args.flags["grant"];
  if (raw === undefined) return [];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw err.validation(CODES.E_CONFIG_INVALID, "--grant needs a comma-separated list of capabilities");
  }
  return raw
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

/**
 * Say what retry policy each node will ACTUALLY run under, and where it came from.
 *
 * UNCONDITIONAL, not behind a flag. The policy this prints is a compiled DEFAULT for any
 * provider-calling node whose author declared nothing, and a default an operator has to know to
 * ask about is a hidden default with extra steps — which is precisely the shape of the bug that
 * put it here: the HTTP transport slept on a 429 inside the worker slot, nothing above it could
 * see that, and so nobody noticed that the engine's own requeue path had never once run.
 *
 * Printed after `ok`, so `examples-run.test.ts`'s `/^ok/` and every operator's eye still find
 * the verdict on the first line. Nodes with no policy are silent: this is a list of what WILL
 * happen, not a census of the graph.
 */
function printRetryPlan(graph: RunGraph): void {
  for (const n of graph.spec.nodes) {
    const retry = graph.plans[n.id]?.retry;
    if (retry === undefined) continue;
    const source = n.retry === undefined ? "default" : "declared";
    const parts = [
      `maxAttempts=${retry.maxAttempts}`,
      `backoff=${retry.backoff ?? "exponential"}`,
      `initialMs=${retry.initialMs ?? 500}`,
      `maxMs=${retry.maxMs ?? 30000}`,
      // Absent means the whole retryable class, and saying so beats an empty field a reader has
      // to know the default for.
      `onlyIf=${retry.onlyIf === undefined ? "any-retryable" : retry.onlyIf.join(",")}`,
    ];
    process.stdout.write(`  retry ${n.id} (${source}): ${parts.join(" ")}\n`);
  }
}

/** How many times `loom run` will wait out a backoff before giving up and saying so. */
const MAX_BACKOFF_WAITS = 64;

/**
 * Advance until the run reaches a terminal state, a gate, or stops making progress.
 *
 * `Engine.advance` RETURNS while a Task is in backoff — its own comment says "so the caller can
 * advance again once the clock has moved" — and no caller did. `loom run` called it exactly once,
 * so a retryable failure left the run `running` forever: the journal ended at
 * `task.retry_scheduled` / `task.ready` and never moved again, and the command exited 0. There is
 * no `loom advance`, and `loom serve` starts a gate clock but no run clock, so nothing anywhere
 * in the product finished that run.
 *
 * The wait is REAL TIME because the backoff is: `retryAfter` is a wall-clock instant the engine
 * journaled, and a run's own retry policy bounds how many there can be. The cap is a backstop
 * against a graph whose retries never exhaust, and it reports rather than looping — a command
 * that hangs is indistinguishable from one that is working.
 */
async function driveToRest(ws: Workspace, runId: RunId, first: RunProjection): Promise<RunProjection> {
  let p = first;
  for (let waited = 0; waited < MAX_BACKOFF_WAITS; waited++) {
    if (p.status !== "running") return p;
    const wake = (Object.values(p.tasks) as TaskRecord[])
      .filter((t) => t.state === "ready" && t.retryAfter !== undefined)
      .reduce<number | undefined>((min, t) => (min === undefined || (t.retryAfter ?? 0) < min ? t.retryAfter : min), undefined);
    // Running with nothing to wait for is not backoff — it is a run this process cannot move,
    // and saying so beats spinning on `advance`.
    if (wake === undefined) return p;
    await new Promise((r) => setTimeout(r, Math.max(0, wake - Date.now())));
    p = await ws.engine.advance(runId);
  }
  process.stderr.write(`! run ${runId} was still retrying after ${MAX_BACKOFF_WAITS} waits; giving up on it here\n`);
  return p;
}

/**
 * What this process will actually do to a model call, said where the operator will read it.
 *
 * IT LIVED ONLY IN `serve`'s BANNER. `loom run` — the door a first-time user goes through, and the
 * one CI drives — printed NOTHING: a graph full of agent nodes returned `"[mock] {…}"`, exit 0,
 * stderr empty. CLAUDE.md names that exact outcome as the anti-goal: "a framework whose agent
 * nodes can only return `[mock] …` is not a working deployment."
 *
 * Second-order, and the reason the unpriced warning travels with it: the mock fabricates a cost,
 * and that number is appended to the journal and feeds `PolicyEngine`'s spend, the budget ladder
 * and the cohort baseline. A run that called no provider still moves the numbers a later run is
 * judged against.
 *
 * On stderr, never stdout: `loom run` prints a JSON document there and a caller pipes it.
 */
function warnAboutModels(models: ModelConfig | undefined, command: string): void {
  if (models === undefined) {
    process.stderr.write(
      `! NO MODEL ADAPTER — the only registered adapter is the offline mock, so every agent node and every rubric\n` +
        `  evaluator returns canned text. Runs will look successful.\n` +
        `  fix: loom ${command} --models-file <file> with {"adapters":[{"provider":"anthropic"}],"routes":{…}}\n`,
    );
    return;
  }
  if (models.unpriced.length > 0) {
    const n = models.unpriced.length;
    process.stderr.write(
      `! NO PRICE FOR ${n} ROUTE${n === 1 ? "" : "S"} — every call on ${n === 1 ? "it" : "them"} is journaled as costing 0,\n` +
        `  so a graph's policy.budget.costUsd and --budget cannot bind and /health reports a spend that did not happen:\n` +
        models.unpriced.map((r) => `    ${r}\n`).join("") +
        `  fix: add "prices": {"<model>": {"input": <usd per 1M>, "output": <usd per 1M>}} to that adapter in ${models.file}\n`,
    );
  }
}

/**
 * THE INDEX, AND WHAT IT COULD NOT BUILD.
 *
 * A graph this process cannot compile is not a graph it can attach — so the failure is caught
 * per file, and for a long time that was ALL it was: caught and dropped. The approver then hit
 * "no graph in graphs/ has that hash (N searched)", which is true and useless, because the graph
 * IS in that directory and the reason it did not count is the one thing the message omitted.
 *
 * Reproduced with a hook: publish `resources/hook/noop.js`, run a gated graph that declares it,
 * delete the file. The ref stops resolving, GRAPH015 refuses the graph, it drops out of this
 * index, and the operator is told the RUN cannot be found — pointed at `graphs/`, which is fine,
 * and away from `resources/hook/`, which is not. Any compile failure has always done this; the
 * hook is only how it was found.
 *
 * So the failures come back with the index and the caller says them.
 */
function graphsByHash(ws: Workspace): { index: Map<string, RunGraph>; failed: readonly string[] } {
  const dir = join(ws.root, "graphs");
  const index = new Map<string, RunGraph>();
  const failed: string[] = [];
  if (!existsSync(dir)) return { index, failed };
  for (const file of readdirSync(dir).sort()) {
    if (!/\.(json|ya?ml)$/i.test(file)) continue;
    try {
      // `false`: every caller of this function is re-attaching a graph to a run that already
      // exists — the run clock, and the door an approver answers a gate through.
      const graph = loadGraph(ws, join(dir, file), false);
      if (!index.has(graph.graphHash)) index.set(graph.graphHash, graph);
    } catch (e) {
      failed.push(`${file}: ${(e as Error).message}`);
    }
  }
  return { index, failed };
}

function discoverGraphs(ws: Workspace): Record<string, RunGraph> {
  const dir = join(ws.root, "graphs");
  const out: Record<string, RunGraph> = {};
  if (!existsSync(dir)) return out;
  // SORTED, for the reason `readResources` already gives about itself: `readdirSync` order is
  // filesystem-dependent, so which graph won a name collision differed by machine — and so did
  // whether a deployment could answer a gate at all. Defence in depth behind the deny entry
  // above, which is what actually closes the planting attack.
  for (const file of readdirSync(dir).sort()) {
    if (!/\.(json|ya?ml)$/i.test(file)) continue;
    try {
      const graph = loadGraph(ws, join(dir, file));
      const name = graph.spec.metadata.name;
      // A COLLISION IS LOUD, and the FIRST one wins. It used to be last-writer-wins in directory
      // order, silently, which made this index a place one file could evict another from.
      const prior = out[name];
      if (prior !== undefined) {
        if (prior.graphHash !== graph.graphHash) {
          process.stderr.write(
            `! two graphs in ${dir} declare metadata.name "${name}" and differ; keeping the first\n`,
          );
        }
        continue;
      }
      out[name] = graph;
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

/** Which interface `serve` binds when nobody says otherwise — loopback, and it stays loopback. */
const DEFAULT_HOST = "127.0.0.1";

/**
 * WHICH INTERFACE, and the reason there was no flag for it until there was a defect.
 *
 * The perimeter this opens is real: `SignedWebhookChannel.parseCallback`, the
 * `CALLBACK_REJECTIONS` taxonomy, `GateCallbackRouter`'s per-run admission cap and the
 * deliberately-unauthenticated `CALLBACK_PATH` exist so a Slack button can answer a human
 * gate — and on a loopback bind Slack cannot reach any of it. `loom serve --host 0.0.0.0`
 * was `E_CONFIG_INVALID: unknown flag: --host`, so the only deployment that could use that
 * route was one behind a tunnel somebody set up by hand and nothing told them they needed.
 *
 * **THE DEFAULT DOES NOT MOVE.** Binding a wider interface is a security decision and it
 * is now spelled as one: an explicit flag, a boot line that names the address actually
 * bound, and `ControlPlane.listen`'s refusal to put a TOKENLESS plane on a routable
 * address at all.
 *
 * THE TWO SLIPS `--port` AND `--token` GUARD AGAINST BOTH LAND WORSE HERE, because for this
 * flag the accident WIDENS the perimeter rather than narrowing or moving it. Both measured
 * against `node:net` on this platform:
 *
 *   - `--host` with no value is `true` from `parseArgs`, and the flag's value is then the
 *     four-letter name "true": `server.listen(0, "true")` → `getaddrinfo ENOTFOUND true`,
 *     so the process dies at the bind naming a host the operator never typed.
 *   - `--host ""` — what `--host "$LOOM_HOST"` produces when the variable is unset — is
 *     the dangerous one, and it is silent. Measured against `node:net` on this platform:
 *     `server.listen(0, "")` binds `address: "::"`, which is EVERY interface. So the one
 *     shape of this flag an operator can produce by doing nothing at all is the widest bind
 *     there is, arrived at from the safest default there is.
 *
 * Anything else is handed to `listen` as written and diagnosed there: a bind failure is a
 * different failure from a bad flag value (`httpPort`'s docstring makes the same
 * distinction, having once claimed otherwise), and `ControlPlane.listen` rejects with an
 * `E_CONFIG_INVALID` naming the address.
 */
function httpHost(args: Args): string {
  const raw = args.flags["host"];
  if (raw === undefined) return DEFAULT_HOST;
  const refuse: (why: string) => never = (why) => {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--host ${why}. Omit it for the default of ${DEFAULT_HOST} — loopback, reachable only from this machine — ` +
        `or name an interface such as 0.0.0.0 on purpose, which also needs --token or --identity-file.`,
    );
  };
  if (raw === true) refuse('was given with no value at all, and a missing value would become the literal name "true"');
  if (raw === "") {
    refuse(
      'was given an empty value (`--host "$LOOM_HOST"` does this when the variable is unset), and an empty host binds ' +
        "EVERY interface — the widest bind there is, reached by leaving a variable unset",
    );
  }
  return raw;
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
/** How many runs one run-clock tick folds. The gate sweeper bounds itself for the same reason. */
const DEFAULT_RUN_CLOCK_LIMIT = 200;

/**
 * HOW DEEP THE ROTATION MAY REACH, and the honest name for what is left of the old bound.
 *
 * The window rotates now, so `limit` no longer decides WHICH runs are reachable — only how
 * many are folded per tick. Something still has to, because `listRuns` takes a count and no
 * cursor: reaching offset N costs a listing of N+limit summary rows, and "no ceiling" is a
 * tick whose cost grows with the number of runs a deployment has ever journaled.
 *
 * 10 000 is a choice, not a measurement: it is two orders above the per-tick fold budget, it
 * is a row scan of `run_head` rather than of the journal, and a deployment with more than
 * that many runs whose graphs this process holds has a coordinator-shaped problem (TODO §E.2)
 * that a call-site rotation should not pretend to solve. What is NOT acceptable is reaching
 * it silently, which is exactly how the old 200 shipped — so `RunClockTick.truncated` carries
 * it out and `startRunClock` says it on stderr, once.
 */
export const RUN_CLOCK_SCAN_CEILING = 10_000;

/**
 * HOW LONG ONE POSITION OF THE WINDOW LASTS, in milliseconds of wall clock.
 *
 * The window used to be a counter in the clock's own closure — `const rot = { offset: 0 }`,
 * built fresh by `startRunClock` at every boot. It is a period instead, because the offset is
 * now DERIVED from `now` rather than remembered, and a derivation needs a unit. `serve` passes
 * its own `--sweep-ms`, so one tick advances the window by exactly one lap and the coverage
 * argument is the one the counter had. This default exists for a caller that has no period of
 * its own; nothing in `src/` takes it.
 */
export const RUN_CLOCK_LAP_MS = 1_000;

/**
 * What one tick saw. TWO FIELDS, BOTH READ — `startRunClock` acts on `truncated` and
 * `test/deployment/run-clock-window.test.ts` asserts on `visited`. A tick that also reported
 * what it ADVANCED would be the natural third, and it is left out until something reads it:
 * this file has enough declared-and-unread surface in its history already.
 */
export interface RunClockTick {
  /** The runs this tick's window covered, in listing order. */
  readonly visited: readonly RunId[];
  /**
   * The window ran into the scan ceiling, so a run older than it — IF there is one — is out
   * of reach of this clock entirely. Conservative at the exact boundary: a store holding
   * precisely `ceiling` runs reports `true` and is hiding nothing.
   */
  readonly truncated: boolean;
}

/**
 * ONE TICK OF THE RUN CLOCK: advance the runs whose backoff has elapsed, over a ROTATING window.
 *
 * THE CLOCK ITSELF, first, because it did not exist either. `Engine.advance` RETURNS while a
 * Task is in backoff, so something has to come back once the clock has moved. `loom run` does
 * that for the run it submitted — and nothing did it for a run submitted over HTTP. Reproduced
 * by a reviewer: a `POST /runs` whose node retries sat `running` with `attempt 1` eighteen
 * seconds after `retryAfter` elapsed, and moved only when a human POSTed `{"kind":"advance"}`
 * by hand, once per attempt.
 *
 * ONLY RUNS WITH A DUE RETRY, which is what keeps this from fighting whoever else is driving.
 * A run being actively advanced does not sit with an elapsed `retryAfter`; and if two processes
 * do collide, the loser writes nothing — every commit compare-and-swaps on the seq the decision
 * was taken at, which is the same argument `GateSweeper` makes for itself one file over.
 *
 * A RUN WHOSE GRAPH THIS PROCESS DOES NOT HOLD IS SKIPPED, not failed. `RunGraph` is not
 * journaled, so re-attaching means finding the graph whose hash the journal names; a deployment
 * that has not published it cannot advance that run, and saying nothing is better than failing a
 * run this process simply cannot see.
 *
 * THE DEFECT THIS FIXES IS A SCHEDULING POLICY NOBODY CHOSE. The tick took
 * `listRuns(limit)` — `ORDER BY run_id DESC LIMIT ?` — so with more than `limit` runs the
 * oldest was never listed, never projected and never advanced. Measured on a
 * `SqliteStateStore` with 201 run heads: `listRuns(200)` returns 200 rows, the newest present
 * and the oldest absent. A run in that position sits in backoff until a human POSTs
 * `{"kind":"advance"}` to it by hand — and `TODO.md` §E.2 still records "which runs a worker
 * considers" as an open question, which it was not: it had already shipped as starvation.
 *
 * SO THE WINDOW MOVES — AND IT MOVES BY THE CLOCK, NOT BY A COUNTER. This is the second
 * defect and it hid inside the fix for the first. The rotation was `const rot = { offset: 0 }`
 * built by `startRunClock`, mutated in place, and reconstructed by nothing: a value a decision
 * reads that the journal cannot rebuild across a restart, which is CLAUDE.md's first
 * non-negotiable and the class `oversight-survives-restart.test.ts` names. Measured on a
 * 250-run journal at `limit` 200, with the control beside it:
 *
 *     CONTROL long-lived rot: oldest run reached on tick 1
 *     RESTARTED rot:          oldest run reached on boot -1     (never, over 20 boots)
 *
 * So the 200-run starvation was fixed for a plane that stays up and unfixed for one that
 * restarts — which is the shape a crash-looping or frequently-redeployed plane always has,
 * and the one nothing could see: all three tests in `run-clock-window.test.ts` held ONE `rot`
 * across every tick.
 *
 * The offset is now `(floor(now / lapMs) * limit) mod N`, wrapping at the end of the listing
 * rather than resetting. Nothing is remembered, so a plane that restarts between every tick
 * computes the same window a plane that stayed up would have, and two planes over one store
 * agree without coordinating. Work per tick is unchanged — at most `limit` projections.
 *
 * WHY THAT REACHES EVERY RUN, and it is arithmetic rather than a hope: consecutive positions
 * are exactly `limit` apart around a ring of `N`, and a given run sits inside a window for
 * `limit` consecutive positions, so one of any `ceil(N / limit)` successive ticks contains it.
 * That is the same guarantee the counter had, and it now survives a restart.
 *
 * WHAT IT DOES NOT PROMISE, said plainly because a fairness claim that overstates itself is
 * worse than the bound it replaced:
 *
 *   - Nothing here is fair against a STREAM of new submissions. New runs land at the head, so
 *     a run can be pushed below a window that has already passed it and wait a further lap.
 *     Bounded-lap fairness, not FIFO.
 *   - The guarantee is over TICKS THAT ADVANCE `now` BY `lapMs`. A clock whose ticks arrive at
 *     an exact multiple of `lapMs` steps by that multiple, and a step that shares a factor with
 *     `N / limit` visits a subset of the positions — `startRunClock` passes its OWN period as
 *     `lapMs` precisely so the ordinary step is one.
 *   - A run past the ceiling is not reached at all, and `truncated` is how a deployment finds
 *     that out. THE REAL FIX IS A CURSOR — `listRuns(after)`, so a tick can page rather than
 *     re-scan — and it belongs in `StateStore` with a conformance test behind it. When that
 *     lands, this rotation is the thing to delete.
 *   - Two processes rotating over one store do not coordinate — they now agree, which is not
 *     the same thing and is not better: they scan the same window and duplicate the folds.
 *     Every write a tick causes still compare-and-swaps on the seq its decision was taken at,
 *     so the loser writes nothing. That is the same argument `GateSweeper` makes for itself.
 *
 * `now` is a parameter for the reason every clock in this codebase is: a tick that read
 * `Date.now()` internally could not be driven by a test that has not slept. It is load-bearing
 * twice over here — it is also what the window is derived FROM.
 */
/**
 * Which rows of a listing of `n` this instant's window covers — the whole of the rotation.
 *
 * SEPARATE FROM THE TICK because it is the part with an argument in it, and an argument
 * belongs somewhere a test can put numbers into directly rather than through a store.
 *
 * IT WRAPS RATHER THAN RESETTING, and that is not cosmetic. A window that stopped at the end
 * of the listing would spend `laps - 1` ticks out of every `laps` doing nothing on a
 * deployment whose run count is not a multiple of `limit`; wrapping means every tick folds a
 * full window and the ring has no seam. Returned as INDICES so the caller keeps the rows.
 */
export function runClockWindow(n: number, limit: number, now: number, lapMs: number): readonly number[] {
  if (n <= 0 || limit <= 0) return [];
  if (limit >= n) return Array.from({ length: n }, (_, i) => i);
  // `Math.max(0, now)` and `Math.max(1, lapMs)`: a clock that has been handed a negative
  // instant or a zero period is a caller's bug, and the answer to it is the first window
  // rather than a NaN that silently folds nothing.
  const lap = Math.floor(Math.max(0, now) / Math.max(1, lapMs));
  const offset = (lap * limit) % n;
  return Array.from({ length: limit }, (_, i) => (offset + i) % n);
}

export async function runClockTick(
  ws: Workspace,
  limit: number,
  now: number = Date.now(),
  /** Injected for the same reason `now` is: the shipped value cannot be reached by a test
   * that is not willing to journal ten thousand runs, and an untested bound is a bound
   * nobody knows the behaviour of. */
  ceiling: number = RUN_CLOCK_SCAN_CEILING,
  lapMs: number = RUN_CLOCK_LAP_MS,
): Promise<RunClockTick> {
  // THE WHOLE REACHABLE SET, IN ONE LISTING, and it is not the cost it looks like. `LIMIT` is
  // a cap and not a fetch count: a store holding three runs answers `listRuns(10_000)` with
  // three rows. The old shape asked for `offset + limit` and paid the same worst case on its
  // deepest lap; what it bought by paying less on shallow laps was an offset it had to
  // REMEMBER, which is the defect. This asks once and derives.
  const rows = await ws.store.listRuns(ceiling);
  // A LISTING THAT FILLED THE CEILING means there may be runs below it this clock cannot see,
  // which is the one thing an operator has to be told about. Conservative at the exact
  // boundary: a store holding precisely `ceiling` runs reports `true` and is hiding nothing.
  const truncated = rows.length >= ceiling;
  const window = runClockWindow(rows.length, limit, now, lapMs);
  const visible = window.map((i) => rows[i]!);

  // LAZY, because the rotation makes this run more often and `graphsByHash` re-reads and
  // RE-COMPILES every graph in the workspace. A tick with nothing due should cost a listing
  // and a fold per run in view, and no compiles at all.
  let index: ReadonlyMap<string, RunGraph> | undefined;
  for (const row of visible) {
    const p = await ws.engine.projection(row.runId);
    if (p === undefined || p.status !== "running") continue;
    const due = Object.values(p.tasks).some((t) => t.state === "ready" && t.retryAfter !== undefined && t.retryAfter <= now);
    if (!due) continue;
    index ??= graphsByHash(ws).index;
    const wanted = await ws.engine.compiledGraphHash(row.runId);
    const graph = wanted === undefined ? undefined : index.get(wanted);
    if (graph === undefined) continue;
    ws.engine.attach(row.runId, graph);
    await ws.engine.rehydrateGates(row.runId);
    await ws.engine.advance(row.runId);
  }
  return { visited: visible.map((r) => r.runId), truncated };
}

function startRunClock(ws: Workspace, everyMs: number, limit: number): { stop(): void } {
  let running = false;
  let failing = false;
  // NOTHING IS CARRIED ACROSS TICKS ANY MORE, and that is the point. This closure used to hold
  // `const rot = { offset: 0 }` — process memory that decided which runs got advanced, rebuilt
  // at every boot, reconstructed by nothing. `toldAboutCeiling` and `failing` below are memos
  // over what to SAY, not over what to do: losing them costs a repeated line, not a starved run.
  let toldAboutCeiling = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void (async () => {
      // ITS OWN PERIOD AS THE LAP, so one tick advances the window by exactly one window.
      const t = await runClockTick(ws, limit, Date.now(), RUN_CLOCK_SCAN_CEILING, everyMs);
      // ONCE, for the reason the outage lines above are once: a deployment big enough to hit
      // the ceiling hits it every lap, and a line per tick is how an operator learns to stop
      // reading stderr. It is not an outage — nothing is failing — so it does not use the
      // `failing` latch, and it is not retracted either: the condition is a size, not a fault.
      if (t.truncated && !toldAboutCeiling) {
        toldAboutCeiling = true;
        process.stderr.write(
          `! RUN CLOCK SCAN CEILING REACHED (${RUN_CLOCK_SCAN_CEILING} runs) — runs older than that are NOT being\n` +
            `  advanced by this process. Their journals are intact; they resume when a caller POSTs\n` +
            `  {"kind":"advance"}, or when their runs are archived out of the window.\n`,
        );
      }
    })().then(
      () => {
        if (failing) {
          failing = false;
          process.stderr.write("! run clock recovered — backed-off runs are being advanced again\n");
        }
      },
      (e: unknown) => {
        if (!failing) {
          failing = true;
          process.stderr.write(
            `! RUN CLOCK STOPPED ADVANCING — ${(e as Error).message}\n` +
              `  Runs whose retry backoff has elapsed will sit until this recovers or a caller POSTs\n` +
              `  {"kind":"advance"} to them.\n`,
          );
        }
      },
    ).finally(() => {
      running = false;
    });
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * HOW MANY GATED RUNS THE GATE CLOCK HOLDS IN VIEW — for BOTH of its halves.
 *
 * It is passed to `new Engine({ sweep: { limit } })` and read by `armForeignGates`, and that
 * is the whole point: the arming and the sweeping are one clock, and a window one of them
 * computes differently is a gate that is watched and cannot be armed. `GateSweeper` bounds
 * itself at 500 by default; this makes that number explicit at the deployment layer that
 * actually owns the tick, rather than a default this file cannot see.
 *
 * It bounds GATED runs, not runs — the listing both halves take is `{ raisedAGate: true }` —
 * so the residual hole is a deployment holding more than this many gates open at once. Size
 * it above the number of simultaneous open gates your SLA policy expects.
 *
 * EXPORTED so `test/deployment/gate-clock-armed-prune.test.ts` can size its two batches off
 * it rather than off a copy of the number. The `armed` prune below is load-bearing only past
 * this many GATED runs — under it the filter alone holds the map down — so a test that
 * hardcoded 500 would quietly stop covering the prune the day this number moved.
 */
export const GATE_CLOCK_LIMIT = 500;

/**
 * ARM THE GATES THIS PROCESS DID NOT RAISE, or the sweep expires what it should escalate.
 *
 * `GateSweeper` reads its `DeliverySpec` from the broker's in-memory record, which only the
 * process that RAISED the gate ever wrote. `rehydrateGates` rebuilds it from the journal and the
 * node declaration, and it was wired into the three re-attach doors — the two write paths and
 * `startRunClock` — but not into the clock that exists to enforce the deadline. `startRunClock`
 * cannot cover it either: it skips any run whose status is not `running`, and a run suspended on
 * a gate is `awaiting_gate` by definition.
 *
 * So the shipped two-verb shape had the defect. `loom run` raises a gate and exits; `loom serve`
 * sweeps it holding no chain, finds it exhausted, and expires it at the first deadline —
 * `onTimeout: "escalate"` behaving exactly as `fail`, which is the outcome
 * `GRAPH014_SLA_INVALID` refuses a graph at compile time to prevent. Measured through `bin/loom`:
 * the same graph submitted through `POST /runs` journals `gate.delivered`, `gate.escalated`,
 * `gate.delivered` and only then `gate.timeout`; raised by `loom run` it journals `gate.raised`,
 * `run.suspended`, `gate.timeout`.
 *
 * IT MUST ARM EXACTLY WHAT THE SWEEP SWEEPS, and it did not: two clocks over two different
 * sets, drifting on both axes at once.
 *
 *   - THE FILTER. `GateSweeper.sweep` and the console's queue route both list
 *     `{ raisedAGate: true }` — ordered by the most recent `gate.raised` — and this site
 *     listed unfiltered, which is `ORDER BY run_id DESC`. So past the window a restarted
 *     plane SAW a gate (the sweep's listing found it) and could not ARM it (this one did
 *     not), which is the worst of the three possible combinations: the sweep then holds no
 *     `DeliverySpec`, `#fireTimeout` takes its `spec === undefined` arm, and the gate is
 *     EXPIRED at the first deadline with the journaled reason "exhausted its escalation
 *     chain with no decision" — false, on a gate nobody was ever paged about. `onTimeout:
 *     "escalate"` behaving as `fail` is precisely what `GRAPH014_SLA_INVALID` refuses a
 *     graph at compile time to prevent.
 *   - THE SIZE, which fixing the filter alone would have left. The sweeper's own default is
 *     `DEFAULT_SWEEP_LIMIT = 500`; this site used the RUN clock's 200. So `GATE_CLOCK_LIMIT`
 *     is declared once here, passed to `new Engine({ sweep: { limit } })` in
 *     `openWorkspace`, and read back here. The two calls cannot disagree because there is
 *     one number and this file owns both ends of it.
 *
 * Reproduced before the fix by `test/deployment/gate-clock-restart.test.ts`: one gated run,
 * `GATE_CLOCK_LIMIT + 20` later ungated ones, a restart, and the journal reads
 * `… gate.raised, run.suspended, gate.timeout, run.failed` where it must read `gate.escalated`.
 * That count is sized off the window ON PURPOSE — at its original 250 the listing here still
 * had free slots, and deleting the filter from this line left the test green.
 *
 * MEMOISED ON `headSeq`, because the fold this costs is the one `ControlPlane` declined to pay
 * per request — "a fold per candidate run, and it is NOT the shape `GateSweeper` pays". Keyed on
 * the head rather than the run id so a run that raises a SECOND gate later is armed again, and
 * memoised even when the graph is missing so an unservable run cannot cost a fold every tick.
 *
 * AND PRUNED, which is a SEPARATE decision from the filter and needs its own evidence: the
 * filter decides what a tick LOOKS at, the prune decides what the map REMEMBERS between ticks.
 * `test/deployment/gate-clock-armed-prune.test.ts` turns the window over twice with 1,040 gated
 * runs and measures both ends — 1,000 entries with these two lines gone, and one fold per run
 * per idle tick if they clear the map instead of narrowing it.
 */
export async function armForeignGates(ws: Workspace, armed: Map<RunId, Seq>): Promise<void> {
  // THE SAME QUESTION THE SWEEP ASKS, ASKED THE SAME WAY. See `GATE_CLOCK_LIMIT`.
  const rows = await ws.store.listRuns(GATE_CLOCK_LIMIT, { raisedAGate: true });
  // PRUNED TO THE WINDOW, like `GateSweeper`'s `live` map and unlike this one until now: it
  // was only ever written, so a plane that is up for a month held one entry per run it had
  // ever listed, to answer a question about runs the clock stopped watching long ago.
  const inView = new Set(rows.map((r) => r.runId));
  for (const runId of armed.keys()) if (!inView.has(runId)) armed.delete(runId);
  let index: ReadonlyMap<string, RunGraph> | undefined;
  for (const row of rows) {
    if (armed.get(row.runId) === row.headSeq) continue;
    armed.set(row.runId, row.headSeq);
    const p = await ws.engine.projection(row.runId);
    if (p === undefined || p.status !== "awaiting_gate") continue;
    index ??= graphsByHash(ws).index;
    const wanted = await ws.engine.compiledGraphHash(row.runId);
    const graph = wanted === undefined ? undefined : index.get(wanted);
    if (graph === undefined) continue;
    ws.engine.attach(row.runId, graph);
    await ws.engine.rehydrateGates(row.runId);
  }
}

function startGateClock(ws: Workspace, everyMs: number): { readonly everyMs: number; stop(): void } {
  let running = false;
  let failing = false;
  const armed = new Map<RunId, Seq>();
  const tick = (): void => {
    if (running) return;
    running = true;
    void (async () => {
      await armForeignGates(ws, armed);
      return ws.engine.sweepGates();
    })()
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
function announce(
  plane: ControlPlane,
  ws: Workspace,
  opts: ControlPlaneOptions,
  sweepMs: number,
  bound: { readonly port: number; readonly host: string; readonly loopback: boolean },
): void {
  const delivery = ws.delivery;
  const identity = opts.identity;
  const { port, host, loopback } = bound;
  // THE ADDRESS THIS LINE NAMES USED TO BE THE STRING `127.0.0.1`, hardcoded, which was
  // true only because nothing could bind anything else. It is now read back off the socket
  // — the same mechanism as `port`, and for the same reason: `--host localhost` binds
  // whatever the resolver says, so the flag is not the address.
  //
  // Bracketed when it is IPv6, because `http://::1:8787` is not a URL anyone can paste.
  process.stdout.write(`loom listening on http://${host.includes(":") ? `[${host}]` : host}:${port}\n`);
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
  warnAboutModels(models, "serve");
  // The plane's own posture, not a third derivation of it: `openToEveryCaller` is
  // what `/health` reports and what `#principal` admits on, so this line cannot
  // promise a perimeter the running process does not have.

  if (plane.openToEveryCaller) {
    process.stderr.write("! NO TOKEN — every caller is authorized\n");
  }
  // THE GUARD THIS BANNER DID NOT NAME, and it is the loudest one. Every other line here
  // reports a guard that is off — no adapter, no identity source, no token — and
  // `--allow-exec` turns off the most. A plane started with it printed nothing at all.
  //
  // READ OFF `execAllowlist` rather than off the flag, for the reason the address line is read
  // off the socket: a tool that failed to register is not a boundary that is open.
  for (const line of execWarnings(ws.execAllowlist)) process.stderr.write(line);

  // WHERE THE SOCKET IS, said as loudly as what is on it — because they compose, and the
  // composition is what decides the blast radius. A plane on 127.0.0.1 with no token is a
  // development convenience; the same plane on 0.0.0.0 is an open control plane on the
  // network, and `ControlPlane.listen` refuses that pair outright rather than printing
  // anything. What is left to say here is the pair this file DOES allow: a tokened plane
  // that anything routable can now reach.
  //
  // `bound.loopback` and not a second look at the flag: it is computed from the address
  // `server.address()` reported, so this line cannot claim a posture the socket does not
  // have — the property `announce`'s own docstring exists to state.
  if (!loopback) {
    process.stderr.write(
      `! NON-LOOPBACK BIND — ${host}:${port} is reachable from the network, not just this machine.\n` +
        `  The bearer token and every gate decision cross this socket in CLEARTEXT: there is no TLS in this\n` +
        `  process, so put a terminating proxy in front of it. The DNS-rebinding Host check does not apply on a\n` +
        `  routable bind (a caller who can reach the port did not need rebinding), and cross-site checks still do.\n`,
    );
  }
  // AUTHENTICATION IS NOT AUTHORIZATION, said where the operator who configured
  // `--identity-file` will read it. Runs ARE scoped to the submitting principal now, so
  // what is worth saying at boot is who escapes that scope and whether anybody does.
  //
  // The condition and the words are `startControlPlane`'s — which `serve` does not call,
  // because the binary prints its own diagnostics with its own fixes — and they come from
  // ONE function rather than from two texts kept in step, so the binary cannot contradict
  // the library about a security property.
  for (const line of ownershipWarnings(plane)) process.stderr.write(`! ${line}\n`);
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
  // AFTER `help`, so `loom --help` still prints the list a reader needs to fix the typo.
  assertKnownFlags(args);
  // AFTER `help`, so `loom --help` still prints the list a reader needs to fix the typo.

  // STARTED BEFORE THE WORKSPACE, because the grant list is derived inside it and a tool
  // registered afterwards is a tool whose capability nobody holds — see `openWorkspace`'s `mcp`
  // parameter.
  const mcp = args.flags["mcp-file"] === undefined ? [] : await startMcp(readMcpServers(requireFileFlag(args, "mcp-file")));
  const ws = openWorkspace(args, process.env, undefined, mcp);
  try {
    switch (args.command) {
      case "compile": {
        const compiled = loadGraph(ws, requirePositional(args, 0, "a graph file"));
        process.stdout.write("ok\n");
        printRetryPlan(compiled);
        return 0;
      }

      case "serve": {
        const opts = controlPlaneOptions(ws, args);
        // Every refusal is spent before the socket exists: the plane's own, in its
        // constructor, and the clock's and the port's, here.
        const everyMs = gateClockInterval(args);
        const wanted = httpPort(args);
        const wantedHost = httpHost(args);
        const plane = new ControlPlane(opts);
        const bound = await plane.listen(wanted, wantedHost);
        const clock = startGateClock(ws, everyMs);
        const runs = startRunClock(ws, everyMs, DEFAULT_RUN_CLOCK_LIMIT);
        announce(plane, ws, opts, clock.everyMs, bound);
        // SIGINT IS AN EVENT HANDLER, so nothing above it catches, and its exit code is
        // the only thing a supervisor reads. Both facts live in `serveUntilInterrupt`,
        // which returns what this command should exit with — see its docstring for why a
        // failed shutdown is 1 and not 0 and not 130.
        // BOTH CLOCKS STOP. `serveUntilInterrupt` takes one thing to stop, and a second timer
        // left running is a process that will not exit — the `.unref()` saves it in practice and
        // relying on that is how the first one would have been missed.
        return await serveUntilInterrupt(plane, {
          stop: () => {
            clock.stop();
            runs.stop();
          },
        });
      }

      case "run": {
        // BEFORE the graph is compiled: a typo in the flag should not cost a compile, and
        // more importantly it must not be diagnosed as something the graph did.
        const inputs = runInputs(args);
        const graph = loadGraph(ws, requirePositional(args, 0, "a graph file"));
        // `--budget` composes by MIN with the graph's own declaration and the deployment's cap —
        // it can only ever lower. `positive` for the reason it exists: a budget of `NaN` compares
        // false against everything, so it is not a loose cap, it is no cap.
        // SAID BEFORE THE RUN, and only when this graph will actually reach a model. A tool-only
        // graph is not mocked and warning about it would be noise — the kind that teaches an
        // operator to stop reading stderr, which is where the honest lines live.
        if (graph.spec.nodes.some((n) => n.type === "agent" || n.evaluator?.kind === "rubric")) {
          warnAboutModels(ws.models, "run");
        }
        const budgetUsd = budgetFlag(args);
        const runId = await ws.engine.submit({
          graph,
          inputs,
          ...submitterFlag(args),
          ...(budgetUsd === undefined ? {} : { budgetUsd }),
        });
        const p = await driveToRest(ws, runId, await ws.engine.advance(runId));
        // THE ERROR, WHEN THERE IS ONE. A failed run printed `"status": "failed"` and nothing
        // else, so every carefully-worded refusal in this file — `RoutingAdapter.#resolve`'s
        // "no route for model X; routed: …" most of all — reached nobody through the door
        // people actually use. Diagnosing a provider failure meant opening the SQLite journal.
        // Conditional, so a succeeding run's output is byte-identical to what it was.
        process.stdout.write(
          `${JSON.stringify(
            { runId, status: p.status, outputs: p.outputs, usage: p.usage, ...(p.error === undefined ? {} : { error: p.error }) },
            null,
            2,
          )}\n`,
        );
        if (p.status === "awaiting_gate") {
          // MOST URGENT FIRST — D7.9 row 5, which this hint can have and `loom gates` cannot.
          // The difference is one fact and it is worth naming, because the two commands print
          // the same thing: THIS run was submitted by THIS process, so the engine still holds
          // it and `openGates` is the ranked queue. A fresh `loom gates` has attached nothing,
          // so the same call raises `E_RUN_NOT_FOUND` and it is left with the projection — see
          // the note there. Two doors onto one queue, and only one of them can reach the rank.
          for (const g of await ws.engine.openGates(runId)) {
            // THE HINT PRINTS WHAT ACTUALLY WORKS. It used to omit `--as`, so following it
            // verbatim failed `E_GATE_NOT_AUTHORIZED` on any gate with approvers — the subject
            // defaults to "cli", which no approvers list names. It also used to need `--graph`,
            // which the workspace lookup now supplies.
            process.stdout.write(
              `gate ${g.gateId} on node ${g.nodeId} — loom approve ${runId} ${g.gateId} --as YOUR_ID\n`,
            );
          }
        }
        // 0 MEANS WHAT YOU ASKED FOR HAPPENED, and `running` is not that. This returned 0 for
        // any status but `failed`, so a run left mid-flight — a Task still in backoff, a crash,
        // a budget pause — reported SUCCESS to whatever read the exit code. A CI script saw a
        // green run for work that never happened. `awaiting_gate` is a success: the run did
        // exactly what it was asked to do and is waiting on a person.
        if (p.status === "succeeded" || p.status === "awaiting_gate") return 0;
        if (p.status !== "failed" && p.status !== "cancelled") {
          process.stderr.write(
            `! run ${runId} is still ${p.status} — it did not reach a terminal state or a gate. ` +
              `Its journal is durable; inspect it with: loom trace ${runId} --graph <the graph file>\n`,
          );
        }
        return 1;
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
        // MOST URGENT FIRST — the same order `GET /runs/:id/gates` answers with (D7.9 row 5),
        // because two doors onto one queue disagreeing is exactly the shape the comment above
        // is about.
        //
        // This used to print JOURNAL order, and the comment justifying that described behaviour
        // which no longer exists: it said `gateQueueOrder` was reachable only through an engine
        // that had ATTACHED the run, "so `Engine.openGates` raises `E_RUN_NOT_FOUND`". It does
        // not — it falls back to `#logFor` and says so in its own docstring, because "a run this
        // engine holds no context for is not an unknown run: a gate is a ROW". Measured on a
        // two-gate run folded in a second process: `openGates` → ["urgent","slow"], the
        // projection → ["slow","urgent"], nothing thrown. The prescribed "fix is one export" was
        // for a problem that had already gone away.
        //
        // The projection above stays: it is what answers E_RUN_NOT_FOUND, and it is the SET.
        // This is only the ORDER.
        process.stdout.write(`${JSON.stringify(await ws.engine.openGates(runId), null, 2)}\n`);
        return 0;
      }

      case "approve": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const gateId = requirePositional(args, 1, "a gateId") as GateId;
        const reject = args.flags["reject"];
        // THE GRAPH IS FOUND, NOT DEMANDED. `RunGraph` is not journaled — its hash is — so a
        // fresh process must be told which graph this run used, and it used to be told with a
        // `--graph` flag that appeared in no usage text, no error message, and not in the hint
        // `loom run` itself prints. The command the binary told an operator to type could not
        // work. Now the workspace's own `graphs/` directory is searched for the hash the journal
        // records, and `--graph` remains as an explicit override.
        //
        // Attaching the WRONG graph is not a risk this lookup carries: `resolveGate` refuses any
        // graph that is not the one the run compiled, down to the resources its refs resolved to.
        if (args.flags["graph"] !== undefined) {
          ws.engine.attach(runId, loadGraph(ws, requireFileFlag(args, "graph")));
        } else {
          const wanted = await ws.engine.compiledGraphHash(runId);
          if (wanted !== undefined) {
            const { index, failed } = graphsByHash(ws);
            const found = index.get(wanted);
            if (found !== undefined) {
              ws.engine.attach(runId, found);
              // AND RE-ARM ITS CLOCK. Attaching binds the graph; it does not restore the gate's
              // non-durable half, and without that a sweep in this process would expire gates
              // that should have escalated — with a journaled reason that is false.
              await ws.engine.rehydrateGates(runId);
            } else {
              // NAMING THE FIX, because "is not attached" named none. An operator who has just
              // been told to run this command needs to know that the graph is what is missing,
              // not the run.
              throw err.notFound(
                CODES.E_RUN_NOT_FOUND,
                `run ${runId} compiled graph ${wanted}, and no graph in ${join(ws.root, "graphs")} has that hash ` +
                  `(${index.size} searched${failed.length === 0 ? "" : `; ${failed.length} would not compile — ${failed.join("; ")}`}). ` +
                  `Publish the graph this run used, or pass --graph explicitly. ` +
                  `A graph EDITED since the run started no longer matches, which is the point — the approver ` +
                  `approved those bytes. Restore them to answer the gate, or \`loom cancel ${runId} --as ID\` ` +
                  `to stop the run, which needs no graph. NOT --reject: a rejected gate runs the graph's ` +
                  `error edges, so it binds like an approval does`,
                { details: { runId, graphHash: wanted, searched: index.size, ...(failed.length === 0 ? {} : { failed }) } },
              );
            }
          }
        }
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
        process.stdout.write(
          `${JSON.stringify({ status: p.status, outputs: p.outputs, ...(p.error === undefined ? {} : { error: p.error }) }, null, 2)}\n`,
        );
        return p.status === "failed" ? 1 : 0;
      }

      case "cancel": {
        // THE ONE EXIT THAT NEEDS NO GRAPH, and it was reachable only over HTTP. `approve` binds
        // the graph the human was shown and `reject` binds too — a rejected gate runs the graph's
        // error edges — so an operator whose graph had drifted had nothing left, while the
        // refusal text told them to cancel a run through a command that did not exist.
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const raw = args.flags["reason"];
        // `String(true)` for a bare `--reason` would journal the four letters "true" as an
        // operator's stated reason — the same slip `--as` and `--token` already guard against.
        const reason = typeof raw === "string" && raw.trim() !== "" ? raw : "operator";
        const p = await ws.engine.cancel(runId, reason, {
          kind: "human",
          subject: subjectFlag(args),
          via: "cli",
        });
        process.stdout.write(`${JSON.stringify({ runId, status: p.status }, null, 2)}\n`);
        return 0;
      }

      case "replay": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const graph = loadGraph(ws, requireFileFlag(args, "graph"));
        const report = await replayRun({
          store: ws.store,
          runId,
          graph,
          engine: {
            tools: ws.engine.tools,
            functions: ws.engine.functions,
            models: ws.engine.models,
            // THE WORKSPACE'S HOOKS, or the replay runs a DIFFERENT PROGRAM than the recording.
            // `Engine.#hooks` is `undefined` when none is passed and `#hooksFor` then answers `[]`
            // at all eight points, so this omission silently un-installed every extension for the
            // duration of a replay. Measured on a run whose `preNode` hook skipped a node and
            // supplied `out` via `overrideWrites`: replayed without hooks the node EXECUTED,
            // failed, and the report read
            // `✗ state.reduced : expected {"note":"n","out":{"skipped":true}}, got {"note":"n"}` —
            // `match: false` blamed on the run, when the replayer was what differed. Same class as
            // the policy line below, one field over. `agent.ts` gets it right structurally by
            // handing `replayRun` the very object it built the live Engine from.
            hooks: ws.hooks,
            // THE RUN'S OWN POLICY, not the engine's default. `EngineOptions.policy` defaults to
            // `granted: ["*"]`, and this call passed none — so a replay held every capability
            // whatever the original run held. A run whose tool was DENIED replayed ALLOWED, and
            // `compare` then reported `match: false` about the RUN when the replayer was what
            // differed. A harness that answers a different question than the one asked is worse
            // than one that fails.
            policy: { granted: ws.granted },
          },
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
        // A TREE IS WALKED, NOT INFERRED FROM ARRAY ORDER. Two defects lived in one line here,
        // `const depth = s.parentSpanId === undefined ? 0 : 1`, and the second was hidden by the
        // first.
        //
        // DEPTH was a presence test, so every span with any parent printed at one indent: a
        // `loom.tool` under a `loom.task` under the run rendered as the task's SIBLING, and a
        // subgraph's whole interior collapsed onto the run's own column. The usage line calls this
        // "the span tree" and it was a two-level list.
        //
        // ORDER is the one that only became visible once the indentation meant something.
        // `spansFrom` sorts by `startTime` with a `spanId` tie-break — right for a waterfall and
        // for an OTel export, and NOT tree order: a task that starts in the same millisecond as
        // its run can sort ahead of it, which printed a child above its own parent. Measured on an
        // agent run: `loom.task 28ms` then `loom.run 29ms`. So the array order stays exactly as it
        // is and the RENDER builds the tree, keeping the sorted order within each sibling group.
        //
        // An orphan — a span whose parent id is in no span here, which `spansFrom`'s own comments
        // say is reachable — is rendered as a root rather than dropped. `seen` bounds the walk: a
        // journal is the one input to this command that a caller supplies.
        const byId = new Map(spans.map((x) => [x.spanId, x] as const));
        const kids = new Map<string, (typeof spans)[number][]>();
        const roots: (typeof spans)[number][] = [];
        for (const sp of spans) {
          const parent = sp.parentSpanId;
          if (parent === undefined || !byId.has(parent)) roots.push(sp);
          else kids.set(parent, [...(kids.get(parent) ?? []), sp]);
        }
        const seen = new Set<string>();
        const emit = (sp: (typeof spans)[number], depth: number): void => {
          if (seen.has(sp.spanId)) return;
          seen.add(sp.spanId);
          // THE EFFECT KIND, because the span NAME cannot carry it. D9.1 fixes the taxonomy at
          // eight names and registers `loom.effect` as designed-not-built, so every effect folds
          // into `loom.model` or `loom.tool` — and the fold sends `subgraph` to `loom.tool`.
          // Measured by driving one: a parent whose only node is a `subgraph` traced as
          // `loom.tool`, so the line naming the child graph called it a tool and nothing in the
          // output led to the child's own run. The attribute was on the span the whole time; this
          // prints it rather than growing the taxonomy, which is a design decision and not a
          // rendering one.
          const kind = sp.attributes?.["effect.kind"];
          const qualifier = typeof kind === "string" && !sp.name.endsWith(kind) ? ` (${kind})` : "";
          // WHICH NODE. Same argument as the line above, one span up: `node.id` and `branch.path`
          // have been on every `loom.task` span since it was built, and the renderer printed
          // neither. Measured by driving a four-node graph: five identical `loom.task [ok]` lines,
          // in an output whose whole job is to say what happened. The branch is what separates a
          // fanned-out node's instances, so `review` twice becomes `review fan[0]` and
          // `review fan[1]` — without it the two lines are indistinguishable and the reader
          // cannot tell a re-attempt from a sibling branch.
          const node = sp.attributes?.["node.id"];
          const branch = sp.attributes?.["branch.path"];
          const where =
            typeof node === "string" && node !== ""
              ? ` ${node}${typeof branch === "string" && branch !== "" ? ` ${branch}` : ""}`
              : "";
          process.stdout.write(`${"  ".repeat(depth)}${sp.name}${where}${qualifier} [${sp.status}] ${sp.endTime - sp.startTime}ms\n`);
          for (const child of kids.get(sp.spanId) ?? []) emit(child, depth + 1);
        };
        for (const r of roots) emit(r, 0);
        // Anything a cycle kept out of the walk is still printed, because a renderer that silently
        // drops a span is worse than one that prints it flat.
        for (const sp of spans) if (!seen.has(sp.spanId)) emit(sp, 0);
        const conformance = conformsToGraph(reconstructGraph(spans), graph.spec, graph.graphHash);
        process.stdout.write(`\nconformance: ${conformance.ok ? "ok" : JSON.stringify(conformance)}\n`);
        return conformance.ok ? 0 : 1;
      }

      // READ THE JOURNAL BACK. `trace` answers "what happened"; this answers "does the record
      // hold together". They are different questions and the second had no asker: span
      // conformance is set-membership plus a hash, which is why it reported `ok` through the
      // gate bypass — every id in the bypass was declared. `--graph` is optional and its absence
      // is REPORTED rather than assumed away, because the edge-ownership rule needs it.
      case "audit": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const events = [];
        for await (const e of ws.store.read(runId, 1)) events.push(e);
        // AN EMPTY READ IS NOT A HEALTHY RUN. Auditing a runId that does not exist printed `ok`
        // and exited 0, which is the same answer a clean run gives.
        if (events.length === 0) {
          process.stderr.write(`no journal for run ${runId} in this workspace\n`);
          return 1;
        }
        // `undefined`, NOT `{}`. Passing an empty map made `edgeSource !== undefined` true, so
        // every lookup missed, nothing was examined, and the report claimed the rule had been
        // checked — the one rule that catches the gate bypass this module was built for.
        const gf = pathFlag(args, "graph");
        const loaded = gf === undefined ? undefined : loadGraph(ws, gf);
        const report = auditRun(
          events,
          loaded === undefined
            ? {}
            : {
                edgeSource: Object.fromEntries(loaded.spec.edges.map((e) => [e.id, e.from] as const)),
                // The graph's declared hooks, so `hook.applied` naming a ref it never declared is
                // an extension that reached the run some other way.
                hookRefs: loaded.spec.hooks ?? {},
              },
        );
        for (const v of report.violations) process.stdout.write(`✗ ${v.rule} @seq ${v.seq}: ${v.detail}\n`);
        for (const s of report.skipped) process.stdout.write(`· not checked — ${s.rule}: ${s.why}\n`);
        process.stdout.write(
          `\n${report.violations.length === 0 ? "ok" : `${report.violations.length} violation(s)`}` +
            ` — ${report.checked.length} rule(s) checked, ${report.skipped.length} skipped\n`,
        );
        return report.violations.length === 0 ? 0 : 1;
      }

      // JUDGE A FINISHED RUN, AND WRITE THE VERDICT DOWN. `scoreTrajectory`, `measureCohort`,
      // `isGolden` and `promotionCeiling` were correct, tested, and reachable from nothing a
      // person can run — the same standing `foldTrajectory` had before `agent.trajectory`
      // existed. This is the door, and the append is the half that makes it a LOOP rather than
      // a report: the verdict outlives the process that computed it, so a later run can read it.
      //
      // THE COHORT IS BUILT HERE, NOT PASSED IN. A score means nothing except against a
      // population, and the population is this workspace's other runs of the same cohort key.
      // That is why the run being judged is a member of its own cohort: `measureCohort` needs it
      // in the medians it is measured against, and leaving it out would score every run against
      // a ruler that excluded exactly one run — itself.
      case "score": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const events = await journalOf(ws, runId);
        // An empty read is not an unscoreable run, it is a run that is not here — `audit`'s
        // lesson, and `gates`'s before it.
        if (events.length === 0) {
          process.stderr.write(`no journal for run ${runId} in this workspace (${ws.root})\n`);
          return 1;
        }
        // THE PROMOTED SET, AND WHY IT IS THIS SET. `isGolden` condition 5 refuses to learn from
        // a run produced by a graph no human approved, and it reads
        // `Trajectory.fromUnpromotedCandidate`, which is `true` whenever the fold is given no
        // promoted set at all — so a caller that omits it certifies nothing and the condition
        // fails closed. For the CLI the answer is mechanical: a graph published in
        // `<workspace>/graphs/` was put there by a person, and a successor graph reached through
        // `graph.mutated` at runtime was not. A graph run from a path outside `graphs/` is
        // therefore NOT promoted, which is the conservative reading and the correct one.
        const { index } = graphsByHash(ws);
        const promotedGraphHashes = new Set(index.keys());
        // The AUTHORED graph, for `promptRef` and node types only. A run that mutated its graph
        // folds its own successor hash from the journal; this lookup does not decide that.
        const submitted = events.find((e): e is Extract<JournalEvent, { type: "run.submitted" }> => isEvent(e, "run.submitted"));
        const graph = submitted === undefined ? undefined : index.get(submitted.payload.graphHash);
        // ONE BUCKET RULE, USED BY BOTH FOLDS. A cohort key is only meaningful if every
        // member was bucketed by the same rule — folding this run under `--bucket` and its
        // peers under the default would produce a key nothing else in the workspace can
        // match, so the flag would report a cohort of one for the very runs it was asked to
        // join. `cohortPeers` therefore takes it too, and a test counts the members.
        const bucketInput = bucketFlag(args);
        const t = foldTrajectory(events, {
          promotedGraphHashes,
          ...(graph === undefined ? {} : { graph }),
          ...(bucketInput === undefined ? {} : { bucketInput }),
        });
        const key = cohortKeyOf(t);
        const peers = await cohortPeers(ws, runId, key, promotedGraphHashes, bucketInput);
        if (peers.truncated) {
          process.stderr.write(
            `! the cohort scan stopped at ${String(COHORT_SCAN_LIMIT)} runs, so this cohort may be smaller than the workspace's\n`,
          );
        }
        const cohort = measureCohort(key, [t, ...peers.members]);
        const scored = scoreTrajectory(t, cohort);
        const verdict = isGolden(t, scored, cohort);
        const ceiling = promotionCeiling(scored.signals);
        // A RUN THAT HAS NOT FINISHED SCORES 0 BY THE FLOOR, and that 0 is about the run's
        // state, not its quality. The row says so — `components.completed` is journaled for
        // exactly this — but the person at the terminal is reading a number, so say it here
        // too. Not a refusal: a verdict on an unfinished run is a real thing to record, and
        // re-scoring after it finishes appends the later reading.
        if (!scored.components.completed) {
          process.stderr.write(
            `! run ${runId} is "${t.outcome.runStatus}", not succeeded — its outcome is 0 because it has not finished, ` +
              `which is a different fact from having finished badly. Re-score it once it is terminal.\n`,
          );
        }
        const payload: EventPayloads["evolution.scored"] = {
          cohortKey: scored.cohortKey,
          score: scored.score,
          outcome: scored.outcome,
          components: {
            costNormalized: scored.components.costNormalized,
            latencyNormalized: scored.components.latencyNormalized,
            humanEffortSaved: scored.components.humanEffortSaved,
            completed: scored.components.completed,
            delivered: scored.components.delivered,
          },
          signals: scored.signals.map((s) => ({ id: s.id, value: s.value, weight: s.weight, evidence: s.evidence })),
          weights: DEFAULT_WEIGHTS,
          weightsDigest: scored.weightsDigest,
          cohort: {
            n: cohort.n,
            p50CostUsd: cohort.p50Cost,
            p50WallMs: cohort.p50Wall,
            p50Gates: cohort.p50Gates,
            p90Score: cohort.p90Score,
          },
          golden: verdict.golden,
          // The conditions that FAILED. `golden: false` with nothing behind it is a verdict
          // nobody can argue with, which is the one thing a verdict must never be.
          goldenBlockers: verdict.conditions.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`),
          ceiling: ceiling.channel,
          requiresHumanSignOff: ceiling.requiresHumanSignOff,
        };
        // A COMPONENT APPENDED THIS, and the actor says so. The `evolution` arm of `Actor` means
        // "a candidate proposed it" and would need an `engineVersion` this path does not have;
        // a `human` actor would claim a person made a judgement that arithmetic made.
        await ws.store.append({
          runId,
          expectedSeq: await ws.store.head(runId),
          events: [{ type: "evolution.scored", payload, actor: SYSTEM_ACTOR("evolution-score") }],
        });
        process.stdout.write(`${JSON.stringify({ runId, ...payload }, null, 2)}\n`);
        return 0;
      }

      // READ A JOURNALED VERDICT BACK — the other half, and the one that makes the row worth
      // writing. It RE-DERIVES NOTHING: every number printed here was read out of a journal,
      // because a reader that recomputes would answer with today's cohort and call it the
      // judgement, which is precisely the drift `weightsDigest` exists to catch.
      case "cohort": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const events = await journalOf(ws, runId);
        if (events.length === 0) {
          process.stderr.write(`no journal for run ${runId} in this workspace (${ws.root})\n`);
          return 1;
        }
        const mine = lastScore(events);
        if (mine === undefined) {
          // NOT AN EMPTY COHORT. "This run was never judged" and "this run was judged and has no
          // peers" are different facts, and answering the first with the second is how a loop
          // reports progress it never measured.
          process.stderr.write(
            `run ${runId} carries no journaled score, which is a different answer from "it scored badly" ` +
              `or "its cohort is empty". Judge it first: loom score ${runId}\n`,
          );
          return 1;
        }
        const summaries = await ws.store.listRuns(COHORT_SCAN_LIMIT);
        const members: { runId: string; score: number; outcome: number; golden: boolean; ceiling: string }[] = [];
        // EXCLUDED, AND COUNTED. A score computed under different weights is a different metric —
        // `scoreTrajectory` throws E_COHORT_INVALIDATED rather than compare across one — so those
        // members cannot join this list. Silently dropping them would make a cohort look smaller
        // for a reason nothing on the page states.
        let excludedForWeights = 0;
        let sawSelf = false;
        for (const s of summaries) {
          const sc = s.runId === runId ? mine : lastScore(await journalOf(ws, s.runId));
          if (sc === undefined || sc.cohortKey !== mine.cohortKey) continue;
          if (sc.weightsDigest !== mine.weightsDigest) {
            excludedForWeights++;
            continue;
          }
          if (s.runId === runId) sawSelf = true;
          members.push({ runId: s.runId, score: sc.score, outcome: sc.outcome, golden: sc.golden, ceiling: sc.ceiling });
        }
        // The run asked about is always in its own cohort, even when the scan window did not
        // reach it — a listing bound must not change what a run belongs to.
        if (!sawSelf) {
          members.push({ runId, score: mine.score, outcome: mine.outcome, golden: mine.golden, ceiling: mine.ceiling });
        }
        members.sort((a, b) => b.score - a.score || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
        process.stdout.write(
          `${JSON.stringify(
            {
              runId,
              cohortKey: mine.cohortKey,
              weightsDigest: mine.weightsDigest,
              scored: mine,
              members,
              excludedForWeights,
              // The scan is bounded, so say when the bound was reached rather than presenting a
              // truncated cohort as the whole one.
              truncated: summaries.length >= COHORT_SCAN_LIMIT,
            },
            null,
            2,
          )}\n`,
        );
        return 0;
      }

      default:
        process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
        return 2;
    }
  } finally {
    // Children first: a server left running outlives the process that spawned it, and a
    // stdio server holds the pipe open, so `loom run` would not exit.
    for (const c of mcp) c.close();
    ws.close();
  }
}

// ── evolution: the read side ────────────────────────────────────────────────

/**
 * How many runs a cohort scan reads before it stops.
 *
 * A cohort is assembled by FOLDING other runs' journals, one read per run, so this is a real
 * cost and not a paper one. The number is the same order as `DEFAULT_RUN_CLOCK_LIMIT` (200) and
 * `GATE_CLOCK_LIMIT` (500) for the same reason those exist: an unbounded scan on a workspace
 * with a year of runs is a command that appears to hang.
 *
 * REACHING IT IS REPORTED, never absorbed — both verbs say so, because a cohort quietly cut to
 * its newest 500 members has a different `p90Score`, and `p90Score` is the bar `isGolden`
 * condition 2 clears. A truncation nobody is told about lowers a promotion bar.
 */
const COHORT_SCAN_LIMIT = 500;

/** The whole journal of one run, in order. Every read side here starts with this. */
async function journalOf(ws: Workspace, runId: RunId): Promise<JournalEvent[]> {
  const events: JournalEvent[] = [];
  for await (const e of ws.store.read(runId, 1)) events.push(e);
  return events;
}

/**
 * The LAST `evolution.scored` row in a journal, or `undefined` if the run was never judged.
 *
 * The last one and not the first: re-scoring appends again by design — a cohort of 3 and a
 * cohort of 300 are different rulers — so the newest row is the current verdict and the older
 * ones are the history of how it was reached.
 */
function lastScore(events: readonly JournalEvent[]): EventPayloads["evolution.scored"] | undefined {
  let found: EventPayloads["evolution.scored"] | undefined;
  for (const e of events) if (isEvent(e, "evolution.scored")) found = e.payload;
  return found;
}

/** What `--bucket` builds: `FoldTrajectoryOptions["bucketInput"]`, named so it can be passed on. */
type InputBucket = (inputs: Readonly<Record<string, unknown>>) => string;

/**
 * `--bucket`, THE SEAM THAT HAD NO CALLER.
 *
 * `FoldTrajectoryOptions.bucketInput` was declared precisely so a deployment could say what
 * makes two runs comparable, and all three product-path callers omitted it — so every
 * deployment got the fold's default and nothing could choose otherwise. This is the door.
 *
 * The default is `shape` and this returns `undefined` for it rather than restating the rule:
 * the rule belongs to `trajectory.ts`, and a CLI that kept its own copy would be a second
 * definition to drift.
 *
 * WHY `fields:` IS A DIGEST AND NEVER THE VALUES. `cohortKey` is journaled into
 * `evolution.scored`, so a bucket built from `inputs["tenant"]` verbatim writes input values
 * into the journal — a trajectory records `argsShape` and not arguments for exactly that
 * reason, and a cohort key is no different. The names ARE in the key, in sorted order, because
 * a bucket that cannot say what it grouped on cannot be compared across a change to the flag.
 *
 * A MODE NOBODY DEFINED IS REFUSED. Falling back to the default would silently score the run
 * under a rule the operator did not ask for and print a cohort as though it answered them.
 */
function bucketFlag(args: Args): InputBucket | undefined {
  const v = args.flags["bucket"];
  if (v === undefined) return undefined;
  if (v === true || v === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--bucket needs a mode: ${v === "" ? "the one given was empty" : "the flag was given with no value at all"}. ` +
        `Omit it for the default, which is "shape".`,
    );
  }
  // The fold's own default. Named here so an operator can write it down explicitly, and
  // NOT reimplemented here — one definition, in trajectory.ts.
  if (v === "shape") return undefined;
  if (v === "exact") return (inputs) => `exact:${digest(inputs).slice(7, 15)}`;
  if (v.startsWith("fields:")) {
    const names = [
      ...new Set(
        v
          .slice("fields:".length)
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x.length > 0),
      ),
    ].sort();
    if (names.length === 0) {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `--bucket fields: names no channel. Write --bucket fields:tenant,language, or omit the flag for "shape".`,
      );
    }
    // A MISSING CHANNEL IS A BUCKET, NOT A CRASH — and the `undefined` is replaced rather
    // than passed through. MEASURED: `digest([["tier", undefined, "undefined"]])` throws
    // `undefined array element at [0][1]`, so naming a channel a run did not supply would have
    // taken down `loom score` for that run with a canonicalization error about an array index.
    // The SHAPE slot is what carries the distinction — `shapeOf(undefined)` is "undefined" and
    // `shapeOf(null)` is "null", so an absent channel and an explicit null bucket apart.
    const cell = (inputs: Readonly<Record<string, unknown>>, k: string): readonly [string, string, unknown] => {
      const v = inputs[k];
      return [k, shapeOf(v), v === undefined ? null : v];
    };
    return (inputs) => `fields[${names.join(",")}]:${digest(names.map((k) => cell(inputs, k))).slice(7, 15)}`;
  }
  throw err.validation(
    CODES.E_CONFIG_INVALID,
    `--bucket "${v}" is not a mode this binary defines. Use "shape" (the default — every run whose ` +
      `input has the same structure), "exact" (one cohort per distinct input, the rule before shape), ` +
      `or "fields:a,b" (group on the named input channels only).`,
  );
}

/**
 * Every OTHER run in this workspace that belongs to the same cohort, folded.
 *
 * Trajectories rather than journaled scores, because `measureCohort` measures a POPULATION —
 * medians of cost, wall time and gates over the runs themselves. Reading peers' journaled
 * scores instead would measure the population as it was last judged, which is a different set
 * and a staler one.
 */
async function cohortPeers(
  ws: Workspace,
  self: RunId,
  key: string,
  promotedGraphHashes: ReadonlySet<string>,
  /** The SAME rule the run being judged was folded under. See the call site. */
  bucketInput?: InputBucket,
): Promise<{ members: Trajectory[]; truncated: boolean }> {
  const summaries = await ws.store.listRuns(COHORT_SCAN_LIMIT);
  const members: Trajectory[] = [];
  for (const s of summaries) {
    if (s.runId === self) continue;
    const events = await journalOf(ws, s.runId);
    if (events.length === 0) continue;
    // No graph: a peer contributes usage, policy and status to the medians, and none of those
    // needs the spec. A missing `promptRef` on a peer changes no median.
    const t = foldTrajectory(events, { promotedGraphHashes, ...(bucketInput === undefined ? {} : { bucketInput }) });
    if (cohortKeyOf(t) === key) members.push(t);
  }
  return { members, truncated: summaries.length >= COHORT_SCAN_LIMIT };
}

function requirePositional(args: Args, i: number, what: string): string {
  const v = args.positional[i];
  if (v === undefined) throw new Error(`${args.command} requires ${what}`);
  return v;
}

/**
 * A COMMA-SEPARATED LIST FLAG, refusing the two ways it arrives empty.
 *
 * `--egress`, `--allow-exec` and `--exec-env` each took a value and each read it as
 * `String(args.flags[name]).split(",")`. A flag given with no value parses to `true`, and
 * `String(true)` is `"true"` — so a bare flag became the one-element allowlist `["true"]` while
 * still REGISTERING the tool. Measured:
 *
 *     loom compile --allow-exec        granted=[…,proc:exec]  tools=[…,proc.exec]
 *     loom compile --egress            granted=[…,net:fetch]  tools=[…,net.fetch]
 *
 * `capabilitiesOf`'s own security argument is that "a tool is registered ONLY when the operator
 * passed the flag that registers it… 'registered implies granted' says exactly 'the operator
 * asked for this'". A flag with no argument is not that: the operator asked for something and
 * said nothing about what. And `true` is a real executable, so the allowlist was not empty — it
 * was one program nobody named.
 *
 * This is the `String(true)` family `--token`, `--port`, `--input`, `--as`, `--reason` and every
 * `pathFlag` already refuse. Three flags had escaped it; they are the three that decide what
 * this process may reach outside itself.
 */
function listFlag(args: Args, name: string, what: string): readonly string[] | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (v === true || v === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--${name} needs ${what}: ${v === "" ? `the one given was empty (\`--${name} "$VAR"\` does this when the variable is unset)` : "the flag was given with no value at all"}. ` +
        `It would otherwise read as the single entry "true", while still registering the tool the flag enables. ` +
        `Omit the flag entirely to leave that tool unregistered.`,
    );
  }
  // An entry that is blank after trimming is a stray comma, not a name. Dropping them silently
  // would let `--egress a,,b` mean something the operator cannot see.
  const parts = v.split(",").map((x) => x.trim());
  if (parts.some((x) => x === "")) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--${name} has an empty entry ("${v}") — a stray comma. Every entry must name ${what}.`,
    );
  }
  return parts;
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

/**
 * `--as` on `loom run` — WHO this run is submitted for, or nobody.
 *
 * It does NOT reuse `subjectFlag`'s default. That one answers "who decided this gate" and
 * falls back to the literal `cli`, which is honest for a decision the CLI genuinely made.
 * As an OWNER the same fallback is three separate defects: it journals a human named `cli`
 * that a graph could then list in `approvers`; it collapses every CLI-submitted run in the
 * deployment onto one owner, so any credential authenticating as `cli` inherits them all;
 * and it takes those runs OUT of the permissive unowned set that exists so an upgrade loses
 * nothing.
 *
 * So the absent case records nothing at all. The CLI authenticates nobody — it writes to the
 * journal directly, and `subjectFlag`'s docstring already states that limit — and inventing a
 * principal is exactly the synthetic-subject failure the perimeter refuses one door over.
 * `separationOfDuties` refuses a gate on such a run rather than enforcing nothing, which is
 * the loud version of the same fact: a graph that asks for supervision cannot be supervised
 * on a run nobody is recorded as having started.
 *
 * `method` is `cli` because that IS how identity was established here: it was not.
 */
function submitterFlag(args: Args): { submittedBy?: SubmittedBy } {
  const v = args.flags["as"];
  if (v === undefined) return {};
  // ITS OWN REFUSALS, NOT `subjectFlag`'S. Borrowing them borrowed their WORDING too, and
  // both sentences are false here: there is no gate on this path, and omitting the flag
  // records nobody rather than "cli". An error message that describes a different command is
  // how a user learns to distrust the rest of them.
  if (v === true || v === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--as needs a subject: ${v === "" ? "the one given was empty" : "the flag was given with no value at all"}. ` +
        `It is journaled as the principal this run was submitted for. Omit it entirely to record nobody.`,
    );
  }
  if (isSyntheticSubject(v)) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--as "${v}" is a synthetic marker, not a subject: a parenthesised subject is what the control plane writes when ` +
        `it could not identify a caller. It is journaled as who started this run, so it has to name somebody.`,
    );
  }
  // BOUNDED, because the perimeter bounds it. `checkedAuth` refuses a subject over
  // MAX_IDENTITY_FIELD rather than truncating, on the stated grounds that injected code
  // writes into durable rows; a shell can supply a megabyte just as easily.
  if (v.length > MAX_SUBJECT) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--as is ${v.length} characters; the limit is ${MAX_SUBJECT}. It goes into a durable journal row, and the ` +
        `control plane refuses an over-long subject rather than truncating one — truncation invents a different person.`,
    );
  }
  return { submittedBy: { kind: "human", subject: v, method: "cli" } };
}

/** Matches the control plane's `MAX_IDENTITY_FIELD`; the journal is the same journal. */
const MAX_SUBJECT = 256;

/**
 * Every document under `<workspace>/resources/<kind>/`, as the store's initial contents.
 *
 * `resources/prompt/investigate.md` becomes `prompt/investigate@stable`. The extension is not
 * part of the ref; `.md` and `.txt` are both read, because a prompt is prose and neither
 * spelling is wrong.
 *
 * READ ONCE, AT BOOT, AND NEVER FOLLOWED. `withFileTypes` reports a symlink as a symlink
 * rather than as the file it points at, and a symlink is skipped — `resources/` sits INSIDE
 * the tool jail and is writable by `fs.write`, so a run that plants
 * `resources/prompt/x.md -> /etc/passwd` would otherwise have the next boot publish it as an
 * instruction and hand it to a model. The same reasoning `openWorkspace` already applies to
 * the data dir, one directory over.
 *
 * A missing directory is not an error: most workspaces have no resources, and the layered
 * resolver above answers for them exactly as it did before this existed.
 */
function readResources(root: string): readonly { kind: ResourceKind; name: string; content: unknown }[] {
  const base = join(root, "resources");
  const out: { kind: ResourceKind; name: string; content: unknown }[] = [];
  let kinds: Dirent[];
  try {
    kinds = readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const kindDir of kinds) {
    if (!kindDir.isDirectory()) continue;
    const kind = kindDir.name;
    const isSpec = SPEC_KINDS.includes(kind);
    if (!isSpec && !TEXT_KINDS.includes(kind) && !CODE_KINDS.includes(kind)) continue;
    // SORTED, so `@stable` does not depend on filesystem order. `x.md` and `x.txt` both
    // publish `prompt/x`, and `#seed` points `@stable` at whichever landed LAST — which was
    // `readdirSync` order, so which text a model received differed by machine.
    let files: Dirent[];
    try {
      files = readdirSync(join(base, kind), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      continue;
    }
    for (const file of files) {
      // `withFileTypes` uses lstat semantics, so a symlink reports `isSymbolicLink()` and NOT
      // `isFile()` — the second test already refuses one. The first is written anyway because
      // it states the intent: what must not happen is reading a file OUTSIDE `resources/` and
      // handing it to a model as a system prompt, and a reader should not have to derive that
      // from the absence of a flag.
      if (file.isSymbolicLink() || !file.isFile()) continue;
      const ext = extname(file.name);
      if (!extensionsFor(kind).includes(ext)) continue;
      const name = basename(file.name, ext);
      // A NAME THE REF GRAMMAR CANNOT HOLD IS NOT A RESOURCE. `my prompt.md` would publish
      // `prompt/my prompt@stable` — resolvable through the store and unreachable from any
      // graph, because `RESOURCE_REF` forbids the space. Silently unused is worse than absent.
      if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
      // ONE UNREADABLE FILE MUST NOT TAKE DOWN EVERY COMMAND. This runs inside
      // `openWorkspace`, so an EACCES here killed `compile`, `run`, `gates` and `approve`
      // alike — including the door an approver answers a gate through, for a file that has
      // nothing to do with them.
      let content: string;
      try {
        content = readFileSync(join(base, kind, file.name), "utf8");
      } catch {
        continue;
      }
      // AND AN EMPTY FILE IS NOT AN INSTRUCTION. `""` is a string, so it would satisfy the
      // refusal in `#documentFor` and then take the `instructions === ""` branch — a model
      // sent no instruction at all, from a run that succeeds. That is the degradation the
      // refusal exists to prevent, one step over.
      if (content.trim() === "") continue;
      if (!isSpec) {
        out.push({ kind: kind as ResourceKind, name, content });
        continue;
      }
      // A SPEC THAT DOES NOT PARSE IS SKIPPED, not thrown. Same rule as the unreadable file
      // above and for the same reason: this runs inside `openWorkspace`, so one malformed
      // child graph would take down `compile`, `run`, `gates` and `approve` alike.
      let parsed: unknown;
      try {
        parsed = ext === ".json" ? JSON.parse(content) : (parseYamlSpec(content, { filename: file.name }) as unknown);
      } catch {
        continue;
      }
      // AND A SHAPE CHECK, because `JSON.parse` answers for `42`, `null`, `[]` and `"text"`
      // just as happily as for a spec — while the YAML half already refuses a non-mapping, so
      // the two spellings disagreed. Two things came through that hole: `null` passed the
      // executor's `childSpec === undefined` guard, and a file holding a bare JSON STRING was
      // served to a model as a system prompt, because `document` type-checks the CONTENT and
      // not the kind.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      out.push({ kind: kind as ResourceKind, name, content: parsed as GraphSpec });
    }
  }
  return out;
}

/**
 * The kinds a workspace directory may publish, and what a file of each one holds.
 *
 * TEXT kinds are read as-is: a prompt is prose, and `.md` and `.txt` are both right.
 * SPEC kinds are parsed as a `GraphSpec` with the same reader `loadGraph` uses, so a child
 * graph is written exactly like a top-level one — the alternative is two spellings of the same
 * document and a question about which one a `subgraph` node wants.
 */
// `function` is TEXT because a function resource's content IS a JavaScript function expression —
// `createFunctionLoader` evaluates `(${source})` and takes the completion value. It was in
// neither list, so `resources/function/*.js` was never read, `createFunctionLoader` had zero
// callers, and `function` and `evaluator{kind:"assertion"}` — two of eight node types — passed
// the compiler and could never run.
const TEXT_KINDS: readonly string[] = ["prompt", "agent_profile", "skill"];
const SPEC_KINDS: readonly string[] = ["subgraph", "graph"];
const TEXT_EXT: readonly string[] = [".md", ".txt"];
const SPEC_EXT: readonly string[] = [".json", ".yaml", ".yml"];
/**
 * A function body is CODE, so it gets its own extensions rather than widening `TEXT_EXT`.
 *
 * Adding `.js` to the prose list would let `resources/prompt/x.js` publish a system prompt, which
 * is a different kind of thing wearing the same suffix. Per-kind because the kinds genuinely
 * differ: `.md` is what a prompt is, `.json` is what a graph is, `.js` is what a function is.
 */
const CODE_EXT: readonly string[] = [".js", ".mjs"];

/**
 * The kinds whose content is SOURCE. `hook` joined `function` here because D8.1 defines it as
 * "a filter/observer module" — code, not prose — and because the alternative was the same
 * silence `function` spent a whole release in: the kind existed, the loader existed, and
 * `readResources` published neither, so nothing could reach either one.
 */
const CODE_KINDS: readonly string[] = ["function", "hook"];

function extensionsFor(kind: string): readonly string[] {
  if (SPEC_KINDS.includes(kind)) return SPEC_EXT;
  if (CODE_KINDS.includes(kind)) return CODE_EXT;
  return TEXT_EXT;
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
