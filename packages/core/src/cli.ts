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

import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, existsSync, type Dirent } from "node:fs";
import { hostname } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { InProcessEventBus, type EventBus } from "./bus.ts";
import { isLoomError, toLoomError, type LoomError } from "./errors.ts";
import { parseYamlSpec } from "./graph/yaml.ts";
import { compile } from "./graph/compile.ts";
import { McpClient, type McpClientOptions } from "./mcp/client.ts";
import { mcpTools } from "./mcp/tools.ts";
import type { GraphSpec, RunGraph } from "./graph/spec.ts";
import type { ResourceResolver } from "./graph/validate.ts";
import { EXTERNALISE_ABOVE_BYTES, filePayloads, type PayloadStore } from "./journal/payloads.ts";
import { SqliteStateStore } from "./journal/sqlite.ts";
import type { RunSummary } from "./journal/store.ts";
import { builtinTools, fsRestore } from "./builtin/tools.ts";
import { Engine } from "./run/engine.ts";
import type { BudgetLimits } from "./run/policy.ts";
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
import { DEFAULT_MAX_OUTPUT_TOKENS, type HttpOptions } from "./providers/http.ts";
import { replayRun } from "./run/replay.ts";
import {
  BearerTokenIdentity,
  ControlPlane,
  ownershipWarnings,
  gateAnswerability,
  type ControlPlaneOptions,
  type IdentitySource,
} from "./server/http.ts";
import { CODES, err } from "./errors.ts";
import {
  CLASS_DEFAULT_POSTURE,
  isLoosening,
  isSyntheticSubject,
  POSTURES,
  type Disposable as LoomDisposable,
  type IrreversibilityClass,
  type Posture,
} from "./vocab.ts";
import { foldRun, type RunProjection, type TaskRecord } from "./run/projection.ts";
import { createFunctionLoader } from "./resources/functions.ts";
import { createHookLoader } from "./resources/hook-loader.ts";
import { HookRegistry } from "./run/hooks.ts";
import { FallbackAdapter } from "./providers/fallback.ts";
import { auditRun } from "./journal/audit.ts";
import { ResourceStore, type ResourceKind } from "./resources/store.ts";
import { OTLP_RUN_ID_ATTR, childRunIdsOf, conformsToGraph, reconstructGraph, spansFrom, spliceSubgraph, type Span } from "./telemetry/spans.ts";
import { OtlpHttpExporter } from "./telemetry/otlp.ts";
import type { EdgeId, GateId, NodeId, RunId, Seq, TaskId } from "./ids.ts";
import { isEvent, SYSTEM_ACTOR, type EventPayloads, type HumanActor, type JournalEvent, type SubmittedBy } from "./journal/events.ts";
import { digest, shapeOf } from "./canonical.ts";
import { foldTrajectory, type Trajectory } from "./evolution/trajectory.ts";
import {
  cohortKeyOf,
  DEFAULT_WEIGHTS,
  isGolden,
  measureCohort,
  MIN_COHORT_SIZE,
  promotionCeiling,
  scoreTrajectory,
} from "./evolution/score.ts";
import { gateCandidate, runEvalSuite, type EvalCase, type EvalReport, type EvalSuite } from "./evolution/gate.ts";
import { gateCandidateLive, MIN_PAIRED_RUNS, pairedCostRatio, type LivePair, type Unmeasured } from "./evolution/live.ts";

const USAGE = `loom — graph-native multi-agent orchestration

  loom serve   [--workspace .] [--port 8787] [--token T]   start the control plane
               [--host 127.0.0.1]                          WHICH interface. The default is
                                                           loopback: nothing off this
                                                           machine can reach the plane,
                                                           which also means no Slack
                                                           button can answer a gate. A
                                                           non-loopback host needs a
                                                           credential — --token, or ANY
                                                           identity source: --identity-file
                                                           or one an --extension-module
                                                           registers. Refused without one
               [--identity-file identities.json]           who may approve, one token each.
                                                           An --extension-module may register
                                                           an OIDC or mTLS source instead;
                                                           both together is refused
               [--channels-file channels.json]             how gates reach humans, and how
                                                           humans answer them, over HTTP
                                                           webhooks. Any other transport is
                                                           an --extension-module channel, and
                                                           needs no file at all
               [--sweep-ms 1000]                           how often gate SLAs are checked
               [--max-runs-in-flight 4]                    how many runs this process drives
                                                           at once. A CEILING, never a door:
                                                           nothing is refused, the surplus
                                                           waits and the run clock comes
                                                           back for it. Times
                                                           --max-parallelism, this is the
                                                           box's concurrent-provider-call
                                                           ceiling, printed at boot
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
  loom pause   <runId> --as ID [--reason WHY]              take no NEW work; keep what is
                                                           in flight. Survives a restart
  loom resume  <runId> --as ID [--reason WHY]              undo a pause, and only a pause
  loom steer   <runId> --node ID --take E,E --as ID        put a node on edges the AUTHOR
               [--reason WHY]                               declared; an invented one is
                                                            refused. Needs the graph
  loom deescalate <runId> --scope run:<id>|node:<id>/<node> THE ONE THING THAT LOWERS
               --to out|on|in --why "<justification>"        oversight. Every other verb
               --as ID                                       tightens. There is no force
                                                             flag and no way to skip the
                                                             justification: it is journaled
                                                             and replayed as a human input.
                                                             --as AUTHENTICATES NOBODY —
                                                             this verb is as strong as
                                                             shell access to the host
  loom replay  <runId> [--graph <graph.json|yaml>]         replay and verify
  loom trace   <runId> [--graph <graph.json|yaml>]         print the span tree
               [--otlp <http://host:port>]                 …and POST it to a collector
               Both find the graph themselves: graphs/ is searched for the hash the
               journal recorded, and the file it resolved to is named on stderr.
               --graph names one outside graphs/ and is refused if its hash is not
               the one the run compiled
               --otlp is the collector's base URL and it MUST be given a value: no
               environment variable can make this command send, because a shell that
               happens to export one is not an operator asking for egress. It is read
               by trace and by no other verb, which refuses it rather than accepting
               it and exporting nothing. THE HEADER CREDENTIAL NEVER GOES ON ARGV,
               where every user on the box can read it out of ps: set
               OTEL_EXPORTER_OTLP_HEADERS to "k=v,k2=v2" (values percent-encoded)
               and they are sent on every POST. What this cannot protect is an
               ENDPOINT that is itself a secret — a vendor host whose subdomain is
               the key, or a path segment that is one. Those are in ps like any
               other argument, and no split of a URL changes it.
               A trace that follows subgraphs sends ONE REQUEST PER RUN, each
               under its own traceId, so the collector performs the join the terminal
               performs in process. Exit 1 then means the run did not conform to its
               graph OR the export did not complete, and the stderr lines say which
  loom audit   <runId> [--graph <file>]      read the journal back and check it holds together
  loom score   <runId>                       judge a finished run against its cohort, and
                                             journal the verdict as evolution.scored
               [--bucket MODE]               WHICH runs count as the same kind of problem.
                                             shape (default) groups every run whose input has
                                             the same structure; exact gives one cohort per
                                             distinct input; fields:a,b groups on the digest
                                             of the named input channels only
               [--graph <graph.json|yaml>]   the spec this run ran, when it is not published
                                             in graphs/. Without it the signals cannot be
                                             read and the command REFUSES rather than score 0.
                                             Matched by hash against the journal, and unlike
                                             publishing it does not mark the graph promoted
  loom cohort  <runId>                       read journaled scores back: this run's verdict and
                                             every run judged under the same key and weights
  loom suite freeze                          build a frozen EvalSuite out of a cohort's OWN
               --cohort <runId>              journaled verdicts. A case is a run this workspace
               --out <suite.json>            recorded and evolution.scored judged — golden runs
               [--cases N]                   become must-pass regressions, the rest are the
               [--bucket MODE]               population they were promoted over. No flag names a
                                             runId, so no caller can put a case in the exam that
                                             is not one of them. Refuses a cohort under 30, a
                                             selection that is all golden (the baseline passes
                                             such an exam by construction) and an --out that
                                             already exists — a re-frozen exam is not frozen
  loom promote <candidate.json|yaml>         judge a candidate graph against a baseline over a
               --baseline <graph.json|yaml>  frozen suite of RECORDED runs, replayed offline.
               --suite <suite.json>          No model is called and no tool runs. Prints the
               [--proposed-by ID]            eleven promotion checks and journals the decision
                                             as operator.command on the first case's run.
                                             Exit 0 promotes, 1 refuses. The suite must have
                                             been frozen BEFORE the candidate was proposed —
                                             an exam written for a known student is not one
  loom promote <candidate.json|yaml>         …OR judge it by RUNNING it. Replay serves every
               --against-cohort <runId>      model turn from the recording, so a candidate whose
               [--runs N] [--as ID]          only change is a PROMPT replays byte-identically
               [--bucket MODE]               and the mode above cannot see it. This one names a
                                             cohort — any run in it — takes the INPUTS out of
                                             those recordings, runs the candidate on them for
                                             real, and compares the PAIRED score differences.
                                             It calls a provider and spends money: --models-file
                                             is required and the mock is refused. The inputs
                                             cannot be supplied by a flag, which is what keeps
                                             the exam older than the student. --runs caps how
                                             many of the cohort's recordings are used (default:
                                             all of them; floor ${String(MIN_PAIRED_RUNS)}), oldest first.
                                             8-determinism CANNOT run here and is reported as
                                             DID NOT RUN, never as passed

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
                    record as the person who approved.
                    IT AUTHENTICATES NOBODY, and that is by construction rather than by
                    omission: there is no credential anywhere on this path, so the value
                    is a CLAIM the operator makes about themselves. Filesystem access to
                    the journal is the whole boundary here. "approvers" is therefore a
                    RECORD on this door and access control only on the HTTP one, where
                    --identity-file decides who a caller is
  --data-dir  DIR   journal location (default: <workspace>/.loom). Off limits to the
                    fs tools wherever it is put, including inside the workspace.
  --max-parallelism N  how many nodes of ONE run may be in flight at once (default 16).
                    Accepted by every command. A malformed value REFUSES TO BOOT rather
                    than falling back to 16 — a bare flag is 1 and an unset variable is 0
  --budget-usd N    THIS DEPLOYMENT's ceiling per run, in US dollars. Composes by MIN
  --budget-tokens N  with the graph's own policy.budget and with loom run --budget, so a
  --budget-wall-ms N graph may lower it and can never raise it. Without these the
                    deployment half of that fold is undefined and the only money ceiling
                    on the box is whatever each graph happens to declare — a graph
                    declaring none has none. wall-ms is PROVIDER time, not elapsed time
  --models-file F   which providers to call, and which model each ModelRequest.model
                    goes to. Without it every agent node answers "[mock] …". The API
                    key is named by the file and READ FROM THE ENVIRONMENT, never
                    stored in it. Accepted by every command, not just serve.
  --extension-module P,P  host-realm modules to load before anything is configured, as a
                    comma-separated list of paths. Each is imported and its DEFAULT EXPORT
                    called with {models, tools, channels, identity} — this process's
                    ModelRegistry and ToolRegistry, and a collector for each of the other
                    two — so FOUR things need no fork: a provider on a wire that is neither
                    Anthropic's nor OpenAI's, an in-process tool, a gate delivery transport
                    that is not an HTTP webhook (email, SMS, a Slack app), and an identity
                    source that is not a bearer-token file (OIDC, mTLS, a proxy-set header).
                    A models-file "routes" row may name an adapter registered here, and a
                    channel registered here is merged with --channels-file's rows.
                    A ModelAdapter must implement provider, stream, priceOf, estimateOf and
                    outputCeilingOf, and its "done" frame must carry provider. A
                    DeliveryChannel is {name, deliver}, plus parseCallback if a human can
                    ANSWER through it. An IdentitySource is {name, identify}, where
                    undefined establishes nobody and throwing refuses. Those lists are
                    the extension CONTRACT: adding a member to one breaks every extension
                    this repo did not write, which is the surface this flag exists to open.
                    IT IS ARGV, SO IT IS YOUR OWN CHOICE LOADED INTO YOUR OWN PROCESS: the
                    module runs unsandboxed with everything this binary has — the same trust
                    a resources/function body and a hand-registered tool already carry. It
                    is deliberately loadable from NOWHERE ELSE; a path read out of a config
                    file or the workspace would let a file decide what code this process
                    runs — and with identity here, that file would decide WHO MAY APPROVE.
                    A module that does not resolve, throws, has no function default export,
                    or registers nothing REFUSES TO BOOT. So does a second module claiming
                    an adapter or channel name the first took, and so does a second identity
                    source — from another module or from --identity-file — because a
                    deployment has one answer to who a caller is. So does a REPEATED
                    --extension-module: flags here are last-wins, so a second one would
                    discard the first module in silence. Use the comma form for two.
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
                    posture floor. EVERY MCP tool is irreversible, AND THEREFORE GATES, UNLESS
                    ITS OWN SERVER ROW SAYS OTHERWISE: tools/list cannot say whether a tool
                    reads a file or wires money, and guessing from its name is a heuristic a
                    hostile server defeats. A row may add "irreversibility" — read_only,
                    reversible_write, irreversible or externally_visible — to declare what YOU
                    know about that server. It applies to every tool that server offers, it is
                    never read from the server itself, the default with no such key is
                    irreversible, and lowering it prints "! MCP OVERSIGHT LOWERED" at boot.
                    A key nothing on this list reads is REFUSED, not dropped: a miscased
                    envAllow is a server started with an empty environment.

  A FLAG A VERB DOES NOT READ IS REFUSED, not ignored — --port on a run, --token on a
  trace, --suite on a score. The flags above are read by the verb they are listed under,
  with TWO EXCEPTIONS THAT ARE NAMED RATHER THAN LEFT TO BE DISCOVERED: --channels-file is
  printed under loom serve because that is where an operator meets it, and is read by every
  verb — a gate raised by loom run reaches a human through the same rows. And --as sits in
  this bottom block but is read only by the verbs that journal a decision under it.
  Everything else in this bottom block is read by every verb.
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
  /**
   * Whether a public base URL was configured FOR THE FILE'S CHANNELS.
   *
   * It says nothing about a channel an `--extension-module` registered, and cannot: that
   * channel was constructed inside the module with whatever address the module chose, and
   * nothing here can read it back. `fromModules` is how the banner says so instead of
   * guessing — see the CALLBACK ADDRESS NOT VISIBLE line in `announce`.
   */
  readonly publishesAddress: boolean;
  /**
   * WHERE THESE CHANNELS CAME FROM, for every message that has to name it.
   *
   * The resolved `--channels-file` path when there is one — the file the operator edited —
   * and otherwise the `--extension-module` path(s) that registered the channels, because a
   * plane can now have channels and no channels file at all. It is a LABEL for diagnostics
   * and nothing reads it back as a path.
   */
  readonly file: string;
  /**
   * Channel names an `--extension-module` registered, as opposed to file rows.
   *
   * Carried for one decision and not for display: the banner's "no callback base URL" fix
   * tells an operator to edit a JSON file, which is wrong advice for a channel that has no
   * row in one. A boolean would not do — a deployment can have both, and the fix is right
   * for the file's half and wrong for the module's.
   */
  readonly fromModules: readonly string[];
}

/**
 * What an empty `--egress`/`--allow-exec`/`--exec-env` would actually do — shared by those three
 * and by nothing else, which is the point. See `listFlag`'s `otherwise`.
 */
const TOOL_ENABLING =
  "while still registering the tool the flag enables. Omit the flag entirely to leave that tool unregistered.";

/**
 * `--extension-module`'s own consequence. It enables no tool: the process would try to IMPORT a
 * file called "true" and refuse two steps from the mistake.
 */
const NO_MODULE_CALLED_TRUE =
  'and this process would try to import a module called "true". Omit the flag entirely to run unextended.';

/**
 * `--take`'s own consequence. `steer` registers nothing either; the route would be confined to an
 * edge id no graph declares, and `Engine.steer` would refuse against the compiled edge set.
 */
const NO_EDGE_CALLED_TRUE =
  'and no graph declares an edge called "true". Omit the flag to leave the route to the router.';

interface Args {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
  /**
   * Flag names that appeared MORE THAN ONCE on argv.
   *
   * `flags` is last-wins and stays that way — `loom serve $DEFAULTS --port 9000` over a
   * `$DEFAULTS` that already said `--port 8080` is a wrapper-script idiom, and for `--egress`,
   * `--allow-exec` and `--exec-env` a dropped repeat only ever NARROWS what the process may
   * reach. This set exists so the one flag where dropping the earlier value LOOSENS can refuse:
   * see `refuseRepeated`.
   */
  readonly repeated: ReadonlySet<string>;
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
  "against-cohort",
  "allow-exec",
  "as",
  "baseline",
  "bucket",
  "budget",
  "budget-tokens",
  "budget-usd",
  "budget-wall-ms",
  "cases",
  "channels-file",
  "cohort",
  "data-dir",
  "egress",
  "exec-env",
  "extension-module",
  "grant",
  "graph",
  "help",
  "host",
  "identity-file",
  "input",
  "max-parallelism",
  "max-runs-in-flight",
  "mcp-file",
  "models-file",
  "node",
  "otlp",
  "out",
  "port",
  "proposed-by",
  "reason",
  "reject",
  "runs",
  "scope",
  "suite",
  "sweep-ms",
  "take",
  "to",
  "token",
  "why",
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
  // A NULL-PROTOTYPE BAG, because `flags["__proto__"] = value` on an object literal runs
  // `Object.prototype`'s setter and stores NOTHING — so `--__proto__ x` was accepted in silence
  // by BOTH `assertKnownFlags` and `refuseFlagsThisVerbDoesNotRead`, which iterate
  // `Object.keys` and never see the name. Harmless in itself (the value is discarded) and a
  // hole in two guards whose whole job is that no flag is accepted in silence. Same defect,
  // same fix, as the `OTEL_EXPORTER_OTLP_HEADERS` parser one screen down.
  const flags: Record<string, string | true> = Object.create(null) as Record<string, string | true>;
  // WHICH NAMES WERE SEEN TWICE, recorded here because this is the only place that can see it:
  // `flags` overwrites, so by the time any caller reads it the earlier value is gone and no
  // caller can tell an override from a loss. `Args.repeated` says why one flag cares.
  const seen = new Set<string>();
  const repeated = new Set<string>();
  const note = (name: string): void => {
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  };
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
      note(a.slice(2, eq));
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    note(name);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return { command: positional[0] ?? "help", positional: positional.slice(1), flags, repeated };
}

/**
 * FLAGS EVERY VERB READS, so no row below has to repeat them.
 *
 * Membership here is not a judgement about which flags are "general". It is a statement about
 * WHERE THEY ARE READ: every name on this list is consulted by `openWorkspace` or by `main`
 * itself, both of which run before the switch dispatches, so every verb reads them by
 * construction. `--channels-file` is the one that looks misplaced and is not — `openWorkspace`
 * builds the gate dispatcher for every verb, so a `loom run` that suspends on a gate delivers
 * through it exactly as `loom serve` does.
 */
const GLOBAL_FLAGS: readonly string[] = [
  "allow-exec",
  "budget-tokens",
  "budget-usd",
  "budget-wall-ms",
  "channels-file",
  "data-dir",
  "egress",
  "exec-env",
  "extension-module",
  "grant",
  "help",
  "max-parallelism",
  "mcp-file",
  "models-file",
  "workspace",
];

/**
 * WHICH VERB READS WHICH FLAG — the applicability table `TODO.md` §H.4 asks for, and the thing
 * `refuseOtlpOutsideTrace` was a single hand-written row of.
 *
 * **WHAT WAS WRONG.** `assertKnownFlags` gates the flag NAME set and nothing gated which verb
 * may read one, so every flag was accepted everywhere and quietly did nothing. Driven at
 * `0c3c486`, `loom trace <runId> --port 9999 --token sekret --suite x` was accepted and failed
 * only for the run id — three flags, three no-ops, no word about any of them. That is the same
 * class `assertKnownFlags` exists for one screen up, reached by a different route: a flag the
 * operator believes is configuring this command and is not.
 *
 * `--otlp` was made the one exception on the ground that its silent no-op is an EGRESS THAT DID
 * NOT HAPPEN, and that ground was narrow and deliberately not generalised, because the general
 * form is this table and nobody had written it. It is written now, and `--otlp` is one row of it
 * — the consequence sentence it earned is kept, as `FLAG_CONSEQUENCE`, because "exported
 * nothing" is a truer thing to tell an operator than "did nothing".
 *
 * **HOW THE ROWS WERE ARRIVED AT, and why they are not a taste judgement.** Each row is the set
 * of flags that verb's `case` block actually reaches — directly through `args.flags[…]`, or
 * through the closure of the helpers it calls — minus `GLOBAL_FLAGS`. That is a mechanical
 * property of the source, and `test/cli/verb-flags.test.ts` recomputes it from the source and
 * asserts this table equals it, verb by verb, the way `known-flags.test.ts` holds `KNOWN_FLAGS`
 * to `USAGE` and to the code's readers. A hand-kept table that drifts is how a refusal starts
 * rejecting a flag the command really does read, which is worse than the bug it fixes.
 *
 * `pause` and `resume` share a case block, so they share a row.
 *
 * A COMMAND NOT LISTED HERE IS NOT CHECKED — an unknown verb is a better message than a lecture
 * about a flag on a verb that does not exist, and `main`'s `default` arm prints it.
 */
const VERB_FLAGS: Readonly<Record<string, readonly string[]>> = {
  compile: [],
  serve: ["host", "identity-file", "max-runs-in-flight", "port", "sweep-ms", "token"],
  run: ["as", "budget", "input"],
  gates: [],
  approve: ["as", "graph", "reject"],
  cancel: ["as", "reason"],
  pause: ["as", "reason"],
  resume: ["as", "reason"],
  steer: ["as", "node", "reason", "take"],
  deescalate: ["as", "scope", "to", "why"],
  replay: ["graph"],
  trace: ["graph", "otlp"],
  audit: ["graph"],
  score: ["bucket", "graph"],
  cohort: [],
  suite: ["as", "bucket", "cases", "cohort", "out"],
  promote: ["against-cohort", "as", "baseline", "bucket", "budget", "proposed-by", "runs", "suite"],
};

/**
 * What a misplaced flag would have COST, for the flags where "nothing" understates it.
 *
 * Empty for almost every flag on purpose: the general consequence is that a value configured
 * nothing, and inventing a specific sentence per flag would be forty claims nobody measured.
 * `--otlp` has one because it was measured — see `otlpEndpoint` and `TODO.md` §H.4 — and because
 * an export that did not happen is the one no-op an operator cannot see from the outside.
 */
const FLAG_CONSEQUENCE: Readonly<Record<string, string>> = {
  otlp:
    "exported nothing, which leaves an operator believing a trace reached their collector while the " +
    "collector never heard from this process. Run `loom trace <runId> --otlp <endpoint>`.",
};

/**
 * Refuse a flag this verb does not read, naming the verbs that do.
 *
 * At the door in `main` beside `assertKnownFlags`, and after it: "unknown flag" is the better
 * message for a name nothing reads anywhere, and this one would otherwise answer a typo with a
 * list of verbs that do not have it either.
 *
 * NAMING THE READERS rather than saying "not valid here", for `onlyKeys`' reason: a refusal that
 * says an operator is wrong without saying what right looks like has spent their attention and
 * given them nothing. `--suite` on `loom score` becomes "read by `loom promote`", which is the
 * command they were reaching for.
 */
function refuseFlagsThisVerbDoesNotRead(args: Args): void {
  const applies = VERB_FLAGS[args.command];
  if (applies === undefined) return;
  const offenders = Object.keys(args.flags)
    .filter((f) => !GLOBAL_FLAGS.includes(f) && !applies.includes(f))
    .sort();
  if (offenders.length === 0) return;
  const readers = (f: string): string => {
    const verbs = Object.keys(VERB_FLAGS)
      .filter((v) => VERB_FLAGS[v]!.includes(f))
      .sort();
    // FAIL CLOSED AND SAY SO. A known flag in no row is a table that lost one, and claiming it
    // is "read by nothing" would be a guess; this sentence is true either way.
    return verbs.length === 0 ? "read by no verb this binary dispatches" : `read by ${verbs.map((v) => `\`loom ${v}\``).join(", ")}`;
  };
  throw err.validation(
    CODES.E_CONFIG_INVALID,
    offenders
      .map(
        (f) =>
          `--${f} is ${readers(f)} and by no other verb. \`loom ${args.command}\` would have accepted it and ` +
          (FLAG_CONSEQUENCE[f] ?? "done nothing with it, leaving an operator believing this command was configured by it."),
      )
      .join(" "),
  );
}

/**
 * The collector's base URL, or `undefined` when this invocation is not exporting.
 *
 * **ARGV DECIDES BOTH WHETHER TO SEND AND WHERE, and the environment supplies neither.** An
 * earlier draft let a bare `--otlp` fall back to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and then
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, on the reasoning that an operator's endpoint usually already
 * lives there. Three measurements killed it and the deletion is worth more than the guards
 * would have been:
 *
 *   - `--otlp "$MY_COLLECTOR"` with the variable unset arrives as the EMPTY STRING, and the
 *     natural implementation turns that into an export to whatever the environment names —
 *     the destination chosen by env while argv named a different one, with the credential
 *     attached. That is precisely the outcome the fallback's own rule was written to prevent.
 *   - The two OTel variables have DIFFERENT CONTRACTS. The base one is appended to; the
 *     signal-specific one is used verbatim. `OtlpHttpExporter` appends `/v1/traces` to
 *     anything not already ending in it, so `https://vendor.example/otlp/traces` becomes
 *     `https://vendor.example/otlp/traces/v1/traces` — a path the operator never named, on a
 *     host they did, carrying their key.
 *   - A shell that happens to export the standard variable is not an operator asking for
 *     egress.
 *
 * So the flag takes a value, and a bare `--otlp` or `--otlp=` is refused naming the variable
 * an operator can paste from. One arm instead of four, and stricter.
 *
 * THE REFUSALS DO NOT ECHO THE VALUE. This is the one flag on this CLI whose value is
 * routinely a credential (`https://<key>@collector`, or a vendor path segment that is one), and
 * a refusal is the place a bad value is most likely to be copied into a ticket.
 */
function otlpEndpoint(args: Args): string | undefined {
  const raw = args.flags["otlp"];
  if (raw === undefined) return undefined;
  const refuse: (why: string) => never = (why) => {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--otlp ${why}. It takes the collector's base URL and nothing else can supply one — e.g. ` +
        `--otlp http://127.0.0.1:4318, or --otlp "$OTEL_EXPORTER_OTLP_ENDPOINT" if you keep it there. ` +
        `Nothing in the environment can make this command send on its own.`,
    );
  };
  if (raw === true) refuse("was given with no value at all");
  if (raw.trim() === "") refuse("was given an empty value, which is what an unset shell variable expands to");
  const parsed = ((): URL => {
    try {
      return new URL(raw);
    } catch {
      // NOT QUOTED BACK. A string that does not parse is usually a typo and occasionally a
      // pasted credential, and this function cannot tell which.
      return refuse("did not parse as a URL (the value is not repeated here, because it is the field a credential lives in)");
    }
  })();
  // THE SCHEME IS NOT QUOTED BACK EITHER, and it used to be. `new URL("sk-live-abcdef:whatever")`
  // parses, and its "protocol" is `sk-live-abcdef:` — so the one arm that interpolated printed a
  // pasted key straight back, in the function whose docstring says flatly that no refusal here
  // echoes the value. An absolute claim with a counterexample is worse than a narrower claim.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    refuse("names a scheme this exporter cannot speak — OTLP/HTTP is http or https");
  }
  // A QUERY OR A FRAGMENT IS REFUSED, because `OtlpHttpExporter` appends `/v1/traces` by STRING
  // CONCATENATION and both defeat it. Measured:
  //
  //     http://h:4318/?a=b                  ->  http://h:4318/?a=b/v1/traces
  //     https://v.example/otlp?token=sk-Q   ->  https://v.example/otlp?token=sk-Q/v1/traces
  //
  // — a path the operator never named, on a host they did, with their token mangled into it, and
  // a permissive gateway answers 200 so the CLI reports success. That is word for word the
  // failure this flag's environment fallback was DELETED over; it is reachable through argv too,
  // and the fix is the same shape — fail closed, and name the component rather than the value.
  if (parsed.search !== "") refuse("carries a query string, and `/v1/traces` is appended to the end of the value");
  if (parsed.hash !== "") refuse("carries a URL fragment, and `/v1/traces` is appended to the end of the value");
  // USERINFO IS REFUSED HERE BECAUSE `fetch` REFUSES IT LATER, and later is an opaque masked
  // transport error rather than a sentence naming the mistake. `https://<key>@collector` is the
  // shape `endpointSecrets` names as the common case of a credential-bearing URL, so an operator
  // will try it; without this arm they got `FAILED (transport) … [redacted]` and no way to tell
  // that the URL form was the problem. Fail closed, name the component, never the value — and
  // point at the place a credential does belong.
  if (parsed.username !== "" || parsed.password !== "") {
    refuse(`carries a username or password in the URL, which \`fetch\` will not build a request from — put the credential in ${OTLP_HEADERS_ENV} instead`);
  }
  // THE PARSED FORM, NOT `raw`, so the string that passed validation is the string that is sent.
  // `new URL` normalises away surrounding whitespace and the exporter does not: `--otlp
  // "  http://h:4318  "` validated clean and then POSTed to `"  http://h:4318  /v1/traces"`,
  // failing with a masked message while the CLI's own line named the host correctly. It failed
  // closed, but it reported a request that was never made.
  return parsed.href;
}

/** Where a collector's credentials come from, and the only place they may. */
const OTLP_HEADERS_ENV = "OTEL_EXPORTER_OTLP_HEADERS";

/**
 * The two variables an OTel SDK would read for an endpoint — and that this binary reads for
 * NOTHING except to say it is ignoring them.
 *
 * Named here so `trace` can tell an operator their configuration is not in play, which is the
 * one case `otlpEndpoint`'s rule leaves silent. Reading them for a VALUE is the thing that rule
 * refuses; reading them to report that they were not used takes no decision from argv.
 */
const OTLP_ENDPOINT_ENVS: readonly string[] = ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"];

/** An HTTP field name, per RFC 9110's `token`. Node refuses anything else, late and unhelpfully. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * `OTEL_EXPORTER_OTLP_HEADERS`, parsed — and it is an ENVIRONMENT VARIABLE ON PURPOSE.
 *
 * A collector credential passed as a flag sits in `ps` for every user on the box. `KNOWN_FLAGS`
 * already carries this project's finding on that class, written about `--token`: "a security
 * bug rather than an ergonomic gap". So there is no `--otlp-headers`, there will not be one,
 * and the name here is the one OTel already specifies — an operator's existing configuration
 * works with no translation.
 *
 * A MALFORMED ENTRY REFUSES rather than being dropped, which is `readModels`' and
 * `readIdentities`' trade for their reason: a silently-dropped authorization header is a 401
 * from the collector that names nothing an operator can act on, hours later, in a log.
 *
 * AND NO REFUSAL NAMES A VALUE — only the entry's position and, where it is well-formed
 * enough to have one, its key. The whole point of this function is that the values are secrets.
 */
function otlpHeaders(env: Readonly<Record<string, string | undefined>>): Record<string, string> | undefined {
  const raw = env[OTLP_HEADERS_ENV];
  if (raw === undefined) return undefined;
  // WHITESPACE IS NOT UNSET. `OTEL_EXPORTER_OTLP_HEADERS="$(cat missing-key-file)"` and a
  // variable that expanded to spaces both land here, and treating them as absent sent the POST
  // with no credentials at all and said nothing — moving the diagnosis to the collector's 401,
  // which is the outcome the empty-ENTRY refusal one screen down exists to prevent for exactly
  // the same shell accident. Truly unset stays silent, because that is a deployment that never
  // asked for headers.
  if (raw.trim() === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `${OTLP_HEADERS_ENV} is set and contains only whitespace, which is what an expansion that produced nothing ` +
        `looks like — the POST would go out with no credentials and the collector's 401 would be the first sign. ` +
        `Unset it, or give it k=v pairs.`,
    );
  }
  const refuse: (which: string, why: string) => never = (which, why) => {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `${OTLP_HEADERS_ENV} ${which} ${why}. The format is a comma-separated list of key=value pairs with the ` +
        `values percent-encoded, e.g. "api-key=abc123,x-tenant=acme". No value is quoted back in this message: ` +
        `the whole reason this is an environment variable and not a flag is that its values are credentials.`,
    );
  };
  // A `Map`, AND THE PLAIN OBJECT IT REPLACES IS THE DEFECT. `out["__proto__"] = value` on an
  // object literal runs `Object.prototype`'s setter instead of creating a property, so a header
  // named `__proto__` — which passes `HEADER_NAME`, since `_` and letters are token characters —
  // was SILENTLY DROPPED. Measured: `{}` after that assignment is `{}`, with
  // `Object.hasOwn(out, "__proto__") === false`. Silently dropping a configured header is the
  // one outcome this whole function exists to refuse, and it is the same class as the
  // `KIND_CODE["constructor"]` defect `TODO.md` §C.4 records against the file this feeds — an
  // inherited member answering for an absent one. `Map` has no such key, and
  // `Object.fromEntries` creates the property rather than assigning it.
  //
  // **THAT FIX ALONE WAS NOT ENOUGH, AND THE TEST THAT "PROVED" IT WAS READING THE WRONG LAYER.**
  // The parser then handed a correct record to `fetch`, whose own record→`Headers` conversion
  // assigns into a plain object and dropped the header AGAIN — driven end to end, the wire
  // carried `api-key` and `content-type` and no `__proto__`, while the assertion sat on the
  // object one layer above the conversion and passed. `telemetry/otlp.ts` now builds a `Headers`
  // with `set`, which carries it, and the test now reads the collector's `rawHeaders`. Two
  // layers, one defect, and only the wire settles which of them is fixed.
  const out = new Map<string, string>();
  const entries = raw.split(",");
  for (let i = 0; i < entries.length; i++) {
    const where = `entry ${String(i + 1)} of ${String(entries.length)}`;
    // SPACES AND TABS ONLY, for the reason the VALUE trim carries: OTel allows optional
    // whitespace around a delimiter, and OWS is space and tab. `String.trim()` also eats `\\n`,
    // so a key read with `$(cat key)` that kept its trailing newline had it removed HERE — one
    // level above the value trim that was fixed first — and never reached the control-character
    // check the refusal names. A newline is not OWS in any spelling of this format.
    const entry = entries[i]!.replace(/^[ \t]+|[ \t]+$/g, "");
    // `listFlag`'s rule for `--egress a,,b`: an empty member means something the operator
    // cannot see, so it is refused rather than skipped.
    if (entry === "") refuse(where, "is empty, so a comma is doing nothing or is hiding a value that did not expand");
    const eq = entry.indexOf("=");
    if (eq <= 0) refuse(where, 'is not `key=value` (no "=", or nothing before it)');
    const key = entry.slice(0, eq).trim();
    // THE KEY IS ELIDED IN THIS ONE REFUSAL, because "the key" is whatever precedes the FIRST
    // `=` — and when the operator's mistake is a MISSING `=`, that span is the whole entry, which
    // is the credential. A message whose own closing sentence promises it quotes no values would
    // have quoted one. Eight characters is enough to find the entry and not enough to be one.
    if (!HEADER_NAME.test(key)) {
      const shown = key.length <= 8 ? key : `${key.slice(0, 8)}…`;
      refuse(where, `has a key that is not a valid HTTP field name (it begins "${shown}")`);
    }
    let value: string;
    try {
      // ONLY SPACES AND TABS, not \s. OTel's format allows optional whitespace around a value,
      // but `String.trim()` also eats `\n` and `\r` — so the very case the refusal below names,
      // a key read with `$(cat key)` that kept its trailing newline, was SILENTLY TRIMMED and
      // never reached the check. The comment claimed a guard the code did not have.
      value = decodeURIComponent(entry.slice(eq + 1).replace(/^[ \t]+|[ \t]+$/g, ""));
    } catch {
      refuse(where, `(key "${key}") has a value that is not valid percent-encoding`);
    }
    // REFUSED HERE RATHER THAN BY `Headers.append`, which throws a `TypeError` QUOTING THE
    // WHOLE VALUE — the shape that put a credential into an error message before the exporter
    // learned to mask its own headers. A key read with `$(cat key)` keeping its newline is the
    // spelling this actually catches.
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      refuse(where, `(key "${key}") has a value containing a control character — a trailing newline from $(cat …) is the usual cause`);
    }
    // CASE-INSENSITIVELY, because HTTP field names are. Keyed on the raw spelling this check
    // passed for `api-key=FIRST,API-KEY=SECOND`, and `Headers.set` then collapsed the two into
    // one header carrying the LAST value — the earlier one silently discarded, which is verbatim
    // the outcome this refusal exists to prevent and which the docstring above calls "a 401 from
    // the collector that names nothing an operator can act on". The map is keyed lowercase; the
    // operator's own spelling is kept for the message.
    const seen = key.toLowerCase();
    if (out.has(seen)) {
      refuse(where, `repeats the key "${key}" (HTTP field names are case-insensitive), and the earlier value would be silently discarded`);
    }
    out.set(seen, value);
  }
  return Object.fromEntries(out);
}

/**
 * Text a COLLECTOR chose, made safe to put in front of an operator.
 *
 * `detail` and `partialSuccess.errorMessage` are the two strings on this path that come from
 * outside the trust boundary, and both land on the line explaining a non-zero exit. Control
 * characters in one let a broken — or hostile — collector rewrite or hide that line with ANSI
 * escapes. The exporter has already masked both against the endpoint and the header values;
 * this is the rendering half of the same rule, and it belongs here because this is the only
 * caller that writes them to a terminal.
 */
function legible(text: string): string {
  // C0/C1 AND THE BIDI CONTROLS. The docstring's threat is "rewrite or hide that line", and a
  // right-to-left override does exactly that without being an ANSI escape — driven, U+202E and
  // U+2028 both survived the C0/C1 class into the rendered `otlp:` line. U+2028/2029 are line
  // separators a terminal may break on, which forges a second line.
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").trim();
}

/**
 * REFUSE A REPEATED FLAG WHOSE DROPPED VALUE IS A LOSS RATHER THAN AN OVERRIDE.
 *
 * `parseArgs` is last-wins for everything, and for everything else that is right: an override is
 * how a wrapper script layers defaults, and for the three other `listFlag` flags — `--egress`,
 * `--allow-exec`, `--exec-env` — a dropped repeat only ever narrows what the process may reach,
 * which is the safe direction.
 *
 * `--extension-module` is the one where it is not. Driven, two valid tool modules:
 *
 *     $ loom serve … --extension-module $S/a.mjs --extension-module $S/b.mjs
 *       ext:    /tmp/…/b.mjs → no adapters, tool b.ping
 *
 * `a.mjs` was named on argv, is absent from the process, and the plane came up. That is exactly
 * the outcome `loadExtensionModules` refuses six other ways — its own docstring says "there is no
 * arm in which a module named on argv is skipped and the process keeps going — that is a
 * deployment the operator believes is extended and is not" — and USAGE says every failure mode
 * REFUSES TO BOOT. This was the arm that existed.
 *
 * REFUSED RATHER THAN ACCUMULATED, and the flag's own help text is why: it promises "a
 * comma-separated list of paths", so the vocabulary for two modules already exists and a second
 * spelling would be a second thing to keep true. Accumulating would also make this flag the only
 * one on the CLI where repetition means something other than what it means everywhere else — a
 * rule that has to be remembered per flag. The comma form is named in THAT refusal — and it is `--extension-module`'s remedy rather than
 * this function's, which is why the remedy is a parameter: `--otlp` takes one endpoint, so
 * telling its reader to write `--otlp a,b` would be advice that fails on their next command.
 */
function refuseRepeated(args: Args, name: string, consequence: string, remedy?: string): void {
  if (!args.repeated.has(name)) return;
  throw err.validation(
    CODES.E_CONFIG_INVALID,
    `--${name} was given more than once. Flags on this CLI are last-wins, so every earlier ` +
      `--${name} would be silently discarded — ${consequence} ` +
      // THE REMEDY IS THE CALLER'S, because it is not the same one twice. `--extension-module`
      // has a comma-separated spelling for two modules and the refusal names it; `--otlp` does
      // NOT — an endpoint is one URL, `--otlp a,b` would not parse, and telling an operator to
      // write it would be advice that fails on their next command.
      (remedy ?? `Pass one --${name} with the values comma-separated instead: --${name} a,b`),
  );
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
 *
 * WHAT THIS BUYS TODAY, AND WHAT IT DOES NOT. The exclusion arm above is in
 * `LeasedScheduler.select`, and `new LeasedScheduler` appears ZERO times in `src/`:
 * `Engine` takes `opts.scheduler ?? new InProcessScheduler()` and `openWorkspace` passes no
 * scheduler, so nothing on the product path reaches that line. Naming the plane does not
 * switch cross-process exclusion on; it makes the identity CORRECT for the day something
 * wires the leased scheduler, and — the part that pays now — it puts a real name in
 * `task.leased.workerId`, so a journal written by two planes says WHICH plane did what
 * instead of attributing everything to one `worker-0`. `test/deployment/two-planes.test.ts`
 * reads those names back out of the journal and is the reason this is not speculative.
 * The scheduler having no caller is TODO.md §B.1, and it is that item, not this one.
 *
 * WHAT A RESTART COSTS, WHICH IS THE TRADE THIS FIX MADE AND THE NUMBER §A.17 ASKED FOR.
 * A restarted plane comes back under a new pid, so it CANNOT reclaim its own pre-restart
 * leases through the identity arm — after a restart those leases are foreign, and it waits for
 * `reclaimable()` instead. Driven against `LeasedScheduler.select` with `leaseMs` 30,000 and a
 * lease taken at t=1000, asked as the pre-restart name and as the post-restart one:
 *
 *                     ready-with-a-lease            leased
 *     same plane      selectable from t=1000        NOT before t=31001
 *     restarted       NOT before t=31001            NOT before t=31001
 *
 * So the wait is BOUNDED AT ONE `leaseMs` (the boundary is inclusive-live, so the first
 * eligible instant is `at + leaseMs + 1`), it applies only to tasks that are `ready` while
 * still carrying a lease, and it is ZERO for a task that was actually `leased` — `reclaimable`
 * expires everyone equally, including the holder, so a restart costs that case nothing at all.
 * Less than one `leaseMs` in practice: the redeploy itself burns part of the window, and the
 * residual is `max(0, leaseMs - downtime)`. `test/deployment/two-planes.test.ts` measures it.
 *
 * ACCEPTED RATHER THAN FIXED, and the reason is that no identity can do better here. The fix
 * would need a name stable across a restart that still separates two live planes on one host;
 * `hostname:pid` cannot be both, and neither can anything the JOURNAL supplies — nothing
 * journals a plane starting or stopping, so a fold cannot tell "A restarted" from "B booted
 * beside A". A name that guessed would re-open exactly the defect above, on the side that
 * costs a double execution rather than a wait. Anything stronger needs a coordinator, and D.2
 * is single machine / single tenant for that reason. One `leaseMs` is the price, and it is the
 * SAME price a crashed plane's work already pays — which is what the lease mechanism is for.
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
  /**
   * Where this workspace's externalised channel values live.
   *
   * EXPOSED SO THAT `loom replay` CAN BE HANDED THE SAME ONE, which is the third member of a
   * family this file already documents twice: a replay engine built without the recording
   * engine's hooks ran a different program, one built without its policy held different
   * capabilities, and one built without this externalises nothing and recomputes an inline
   * value where the journal recorded a handle. Measured before this field existed, on a real
   * `loom run` of a three-node chain:
   *
   *     loom replay <runId> --graph chain.json
   *     ✗ state.reduced : expected {"doc":{"$payload":{"digest":"sha256:6ceb75ce…"}},…},
   *                       got {"doc":"xxxxxxxx…300,000 more…"}
   *
   * `match: false` blamed on the run, when the replayer was what differed.
   */
  readonly payloads: PayloadStore;
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
  /**
   * `undefined` when no `--extension-module` was given.
   *
   * Carried for `announce`'s stated rule — every line it prints is read off a constructed
   * object rather than re-derived from the flags — so the banner names the modules this
   * process ACTUALLY loaded, the treatment `--allow-exec` already gets.
   */
  readonly extensions: ExtensionModules | undefined;
  /**
   * The two ceilings this Engine was actually CONSTRUCTED with.
   *
   * Carried for `announce`'s stated rule — every line it prints is read off a constructed
   * object rather than re-derived from the flags — and `EngineOptions` is write-only, so
   * there is nothing to read them back off. This is the constructor's own argument, captured
   * at the point it was passed, which is as close as this file can get.
   */
  readonly maxParallelism: number;
  readonly budget: BudgetLimits | undefined;
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
   *
   * THE CLASS TRAVELS WITH THE CLIENT rather than beside it. `startMcp` pairs each connected
   * server with the class its `--mcp-file` row declared, so this function cannot look one up by
   * name and cannot get the pairing wrong — the alternative shape, a `Map<string, class>` passed
   * alongside, is one where a renamed server silently falls back to the default.
   */
  mcp: readonly ConnectedMcpServer[] = [],
  /**
   * What `--extension-module` registered, loaded in `main` BEFORE this function is called.
   *
   * A parameter and not a flag read in here for one mechanical reason: `await import()` is
   * async and `openWorkspace` is not. The ordering it buys is the same one `mcp` buys —
   * the grant list is a snapshot taken in this function, so a tool registered afterwards is
   * a tool whose capability nobody holds — and it goes one step further, because
   * `readModels` runs at the TOP of this function and a `routes` row may name an extension
   * adapter.
   */
  extensions?: ExtensionModules,
): Workspace {
  // BEFORE ANYTHING IS CREATED OR OPENED. A malformed channels file is a refusal to start,
  // and a refusal that has already made a directory and opened a SQLite handle is a
  // refusal that leaks one — `main`'s `finally` only closes a workspace it was handed.
  const delivery =
    args.flags["channels-file"] === undefined
      ? // NO FILE IS NO LONGER NO CHANNELS. A module that registers an SMTP or Slack-app
        // channel is the whole point of the `channels` seam, and requiring a `--channels-file`
        // beside it would mean writing a JSON file with a webhook row in it to enable a
        // transport that is not a webhook.
        extensionDelivery(extensions)
      : readChannels(requireFileFlag(args, "channels-file"), extensions?.channels ?? []);
  // Same rule, same reason: a models file naming an env var that is not set is a refusal
  // to start, and it must happen before the journal is opened. `env` is a PARAMETER so a
  // test can hand this function a key without writing one into the process — the same
  // injection every clock and id source in this codebase takes, applied to the one input
  // that is a credential.
  const models =
    args.flags["models-file"] === undefined
      ? undefined
      : readModels(requireFileFlag(args, "models-file"), env, fetchImpl, extensions?.adapters ?? new Map());

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
  // BESIDE `journal.db`, INSIDE THE DATA DIR, and both halves of that are the argument.
  //
  // Externalisation makes the journal file no longer self-contained: an event names a payload
  // instead of carrying it. That is only a fair trade if the two travel together, and the
  // paragraph below has already settled what travels together — the data dir is "one directory
  // to copy, archive or delete". So the payloads go in it, and `loom status` already prints its
  // path. A journal.db carried off on its own now refuses (`E_PAYLOAD_UNRESOLVED`, run-fatal)
  // rather than answering from a value it does not have.
  //
  // AND IT INHERITS THE DENY-LIST FOR FREE. `deny: [dataDir, ...]` below exists because the
  // journal sits in a directory a `fs.write` tool could otherwise reach; a payload store outside
  // it would have needed its own entry, and the entry somebody forgets is the one this codebase
  // has paid for twice.
  const payloads = filePayloads(join(dataDir, "payloads"));

  // THE EXTENSION MODULES' REGISTRY, when there is one, rather than a second one beside it.
  // A tool registered into a registry this function does not use is a tool nothing can call,
  // and the grant list below is derived from THIS object — so an extension tool has to be in
  // it before `capabilitiesOf` runs or the capability it needs is one nobody holds. The
  // built-ins are registered on top, so a name collision leaves the BUILT-IN live: an
  // extension cannot quietly replace `fs.write`.
  const tools = extensions?.tools ?? new ToolRegistry();
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
  const egressHosts = listFlag(args, "egress", "a hostname", TOOL_ENABLING);
  const execPrograms = listFlag(args, "allow-exec", "a program name", TOOL_ENABLING);
  const execEnvNames = listFlag(args, "exec-env", "an environment variable name", TOOL_ENABLING);
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

  const modelRegistry = extensions?.models ?? new ModelRegistry();
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
  //
  // AND THE MOCK IS NOT UNCONDITIONAL, which it was. `register(…, true)` CLAIMS THE DEFAULT,
  // so registering the mock whenever `--models-file` was absent overwrote the claim an
  // `--extension-module` adapter had already made — a deployment the operator extended with a
  // real provider, answering every agent node with `[mock] …`. The condition is now the whole
  // question: register the mock only when nothing else has claimed the default.
  if (models !== undefined) {
    modelRegistry.register(models.adapter, true);
  } else if (extensions?.claimsDefault !== true) {
    modelRegistry.register(
      new MockModelAdapter({
        script: (req) => ({ text: `[mock] ${req.messages.at(-1)?.content.slice(0, 80) ?? ""}` }),
      }),
      true,
    );
  }

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
  //
  // THE SECOND ARGUMENT IS THE ONLY PATH TO A LOWERED MCP GATE IN THIS BINARY, and it reaches
  // here from a `--mcp-file` row and from nowhere else. See `MCP_SERVER_FIELDS` for why a file
  // named on argv is allowed to do that when `loadExtensionModules` says a file may not.
  for (const { client, irreversibility } of mcp) {
    for (const t of mcpTools(client, irreversibility)) tools.register(t);
  }

  const granted = capabilitiesOf(tools, grantFlag(args));
  // BOTH REFUSALS ARE SPENT BEFORE THE ENGINE EXISTS, so a malformed ceiling is a process that
  // does not start rather than one that starts without the ceiling it was told to hold.
  const maxParallelism = boundedCount(args.flags["max-parallelism"], "--max-parallelism", DEFAULT_MAX_PARALLELISM, MAX_CONCURRENCY);
  const budget = deploymentBudget(args);
  const engine = new Engine({
    store,
    bus,
    payloads,
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
    // HOW WIDE ONE RUN MAY FAN OUT, and it was never passed. `Engine` defaults it to 16 and
    // `cli.ts` set nothing, so an operator running the binary had no concurrency dial at all;
    // the number is here rather than in the `serve` arm because it bounds `loom run` too.
    maxParallelism,
    // systemFloor defaults to `on`: everything is observable and interruptible,
    // and irreversibility classes still force a gate where one is warranted.
    //
    // AND THE DEPLOYMENT'S OWN MONEY CEILINGS, which this call has never supplied. `Engine.submit`
    // folds `policy.budget.{runUsd,runTokens,runWallMs}` by MIN against the graph's declaration,
    // so with none here the deployment half of that fold was always `undefined` and the only
    // ceiling on the box was whatever each graph happened to declare. See `deploymentBudget`.
      policy: { granted, ...(budget === undefined ? {} : { budget }) },
    // EXPLICIT, so `armForeignGates` can hold the same number. The sweep's window and the
    // arming's window are the same window or the clock has a hole in it — see
    // `GATE_CLOCK_LIMIT`, which is the only place either of them reads it from.
    sweep: { limit: GATE_CLOCK_LIMIT },
  });

  return {
    root,
    dataDir,
    store,
    engine,
    bus,
    payloads,
    resolver,
    hooks,
    granted,
    execAllowlist: execPrograms,
    delivery,
    models,
    extensions,
    maxParallelism,
    budget,
    close: () => store.close(),
  };
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
 * The dispatcher every delivery path in this binary is built with, in one place.
 *
 * TWO CALLERS NOW — the channels file and an `--extension-module` with no file — and the
 * fallback is the reason this is a function rather than two literals: a plane whose channels
 * came from a module must land an undelivered gate on the operator's terminal for exactly the
 * reason a plane configured from a file must, and a second copy of that decision is a second
 * place for it to stop being true.
 */
function dispatcherOver(channels: readonly DeliveryChannel[]): GateDispatcher {
  return new GateDispatcher({
    channels: [...channels],
    // THE GATE ALWAYS LANDS SOMEWHERE. When every configured channel fails, the console
    // fallback puts it on the operator's terminal rather than letting "nobody was told"
    // be the outcome. Its `queued` array is process-lifetime — a bound worth knowing
    // about on a `serve` whose every delivery is failing, and a small one: one entry per
    // gate, and a deployment in that state has a louder problem than memory.
    fallback: new ConsoleChannel({
      sink: (line) => process.stderr.write(`! UNDELIVERED — ${line}\n`),
    }),
  });
}

/**
 * `parseCallback !== undefined` is the ONE test for "this channel can be answered".
 *
 * `DeliveryChannel`'s own docstring says so, and reading it here rather than re-deriving
 * answerability from how a channel was configured is what lets a module-supplied SMTP or
 * Slack-app channel be reported truthfully: this binary knows nothing about how it was
 * built and does not have to. The file path classifies by `callbackSecret` instead, and
 * lands on the same answer, because that field is exactly what selects the signed class.
 */
function splitByAnswerability(channels: readonly DeliveryChannel[]): { answerable: string[]; notifyOnly: string[] } {
  const answerable: string[] = [];
  const notifyOnly: string[] = [];
  for (const c of channels) (c.parseCallback === undefined ? notifyOnly : answerable).push(c.name);
  return { answerable, notifyOnly };
}

/**
 * Delivery for a plane with `--extension-module` channels and NO `--channels-file`.
 *
 * A separate function and not a default-empty `readChannels`, because that reader's first
 * act is to refuse a file that declares no channels — the honest refusal for a file, and
 * exactly wrong for the case where there is no file to be malformed. `undefined` here means
 * what it has always meant on `Workspace.delivery`: no channels, so a gate is delivered
 * nowhere and answered through the API or the CLI.
 */
function extensionDelivery(ext: ExtensionModules | undefined): DeliveryConfig | undefined {
  if (ext === undefined || ext.channels.length === 0) return undefined;
  const { answerable, notifyOnly } = splitByAnswerability(ext.channels);
  return {
    dispatcher: dispatcherOver(ext.channels),
    answerable,
    notifyOnly,
    // FALSE, AND IT IS NOT A CLAIM THAT NO ADDRESS IS PUBLISHED. There is no
    // `callbackBaseUrl` in this arrangement because there is no file to hold one; whether a
    // module's channel puts an address in what it delivers is decided inside the module.
    // `fromModules` covers every name here, so `announce` says "not visible" rather than
    // "missing" — the undecidable case named instead of answered.
    publishesAddress: false,
    file: ext.files.join(", "),
    fromModules: [...ext.channelNames],
  };
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
 *
 * **EVERY CHANNEL HERE IS AN HTTP WEBHOOK, and a `"kind"` is refused rather than ignored.** The
 * name `slack` above is a label on a URL, not a transport: this function builds `WebhookChannel`
 * or `SignedWebhookChannel` and there is no third branch. Measured before the refusal existed,
 * `"kind"` set to `"slack"`, `"carrier-pigeon"`, `"webhook"` and `"email"` — all four accepted,
 * all four the identical notify-only webhook. See the check itself for why `"webhook"` is
 * refused with the rest.
 */
export function readChannels(
  file: string,
  /**
   * Channels an `--extension-module` already registered, merged with the file's rows.
   *
   * A parameter, exactly as `readModels`' `preRegistered` is, and for the same reason: the
   * two halves have to be checked against each other and this is the only frame holding
   * both. The alternative — build two dispatchers — is the one arrangement that cannot
   * work, since `GateDispatcher` is what a graph's delivery spec resolves names through.
   */
  preRegistered: readonly DeliveryChannel[] = [],
): DeliveryConfig {
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

  // MODULE CHANNELS FIRST, in the order the modules were named on argv, and their names are
  // in `seen` before the first row is read — so a file row repeating one is refused, naming
  // the module. The reverse (rows first) would refuse identically; what must not happen is
  // neither, which is what a `Map` keyed by name does silently.
  const mine = splitByAnswerability(preRegistered);
  const seenFromModules = new Set<string>(preRegistered.map((c) => c.name));
  const channels: DeliveryChannel[] = [...preRegistered];
  const answerable: string[] = [...mine.answerable];
  const notifyOnly: string[] = [...mine.notifyOnly];
  const seen = new Set<string>(seenFromModules);

  rows.forEach((raw, i) => {
    const where = `entry ${i}`;
    const row = raw as Record<string, unknown> | null;
    if (typeof row !== "object" || row === null || Array.isArray(row)) refuse(`${where} is not an object`);
    const name = row["name"];
    const url = row["url"];
    if (typeof name !== "string" || name === "") refuse(`${where} needs a non-empty string "name"`);
    if (typeof url !== "string" || url === "") refuse(`${where} ("${name}") needs a non-empty string "url" to deliver to`);
    if (seen.has(name)) {
      // NAMING THE MODULE HALF WHEN THAT IS WHAT IT COLLIDED WITH. "entry 0 repeats a name" is
      // true and sends an operator looking for a second row in a file that has only one.
      refuse(
        `${where} repeats the channel name "${name}"` +
          `${preRegistered.some((c) => c.name === name) ? ", which an --extension-module already registered" : ""}` +
          ` — a dispatcher keys channels by name, so one of them would never deliver`,
      );
    }
    seen.add(name);

    // A `kind` WAS READ AND THROWN AWAY. Driven through this function before this refusal
    // existed, four values — "slack", "carrier-pigeon", "webhook", "email" — and ALL FOUR were
    // accepted and ALL FOUR produced the identical plain notify-only `WebhookChannel`,
    // indistinguishable from a row with no `kind` at all. "carrier-pigeon" is the one that shows
    // what the field constrained: nothing.
    //
    // So an operator writing `"kind": "email"` has a file that reads as configured and a
    // deployment that quietly POSTs JSON at a URL. That is the failure this whole reader is
    // named for, arriving through a field it never looked at — and it is the same trade
    // `readModels` already makes for an unknown provider ("refused rather than skipped, because
    // a skipped adapter is a deployment that boots looking configured").
    //
    // `"webhook"` IS REFUSED TOO. There is no `kind` vocabulary to be right about — this reader
    // builds one transport — so accepting the "correct" spelling would advertise a set that does
    // not exist, and the next operator would reasonably try the next member of it.
    if (row["kind"] !== undefined) {
      refuse(
        `${where} ("${name}") declares "kind": ${JSON.stringify(row["kind"])}, and there is no "kind" field — ` +
          `it was read by nothing, so every value produced the same plain HTTP webhook. This file configures ` +
          `HTTP webhooks and only those: the URL decides where a gate goes, and "callbackSecret" is the one ` +
          `switch — present makes the channel ANSWERABLE (a SignedWebhookChannel with an inbound callback ` +
          `route), absent makes it notify-only. Remove the field. A transport that is not an HTTP webhook ` +
          `is not configurable here at all, and silently accepting a name for one is worse than saying so.`,
      );
    }

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
    dispatcher: dispatcherOver(channels),
    answerable,
    notifyOnly,
    // `answerable` NOW COUNTS MODULE CHANNELS TOO, and this expression deliberately does not:
    // a `callbackBaseUrl` in the file reaches the `SignedWebhookChannel`s this reader builds
    // and nothing else, so "the file published an address" must stay a claim about the file's
    // own rows. Hence the second condition on FILE answerables rather than on `answerable`.
    publishesAddress: baseUrl !== undefined && answerable.some((n) => !seenFromModules.has(n)),
    file: path,
    fromModules: [...seenFromModules],
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

/**
 * WHERE A FALL-THROUGH GOES, and until this existed the answer was nowhere.
 *
 * `FallbackOptions.onFallback` has been declared since the provider layer landed, is covered by
 * `test/providers.test.ts`, and was passed by NOBODY in `src/`: `new FallbackAdapter({provider,
 * primary, fallback: tiers})` in `readModels` supplied no callback. So a chain fell through in
 * total silence — and `FallbackAdapter` is stateless by construction, entering tier 0 on every
 * call and only falling through on a throw, which means an operator whose primary is dead and
 * whose chain is configured pays three wasted requests and about 750 ms of a worker slot on
 * EVERY model turn, indefinitely, while every run still succeeds and nothing says so.
 *
 * A LATE-BOUND SINK RATHER THAN AN ARGUMENT, because the two ends are built at different times:
 * the chain is constructed while the `--models-file` is read, and the reporter that consumes it
 * is constructed in the `serve` arm after the plane binds. One indirection, and no ordering
 * between them to get wrong.
 *
 * IT IS A REPORT AND NOT A GUARD. Nothing here can withhold a call or permit one — see
 * `providerNotice`, and the assertion in its test that every call still reaches the provider.
 */
export interface FallbackFeed {
  /** Install a listener. The returned function removes it; a second install is a second listener. */
  subscribe(fn: (from: string, to: string, error: LoomError) => void): () => void;
  /** Called by `FallbackAdapter`. Never by anything that decides. */
  emit(from: string, to: string, error: LoomError): void;
}

function fallbackFeed(): FallbackFeed {
  const listeners = new Set<(from: string, to: string, error: LoomError) => void>();
  return {
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (from, to, error) => {
      // A LISTENER THAT THROWS MUST NOT BREAK THE MODEL TURN. This is called from inside
      // `FallbackAdapter.stream`'s `catch`, on the path that is already handling a provider
      // failure; a reporter that raised there would turn a survivable fall-through into a
      // failed run, which is a report deciding something.
      for (const fn of listeners) {
        try {
          fn(from, to, error);
        } catch {
          // Nothing above this frame can be told, and a failed report must not fail a run.
        }
      }
    },
  };
}

/**
 * `--extension-module` — the door onto the four seams this binary already builds.
 *
 * **THE SEAM ALWAYS EXISTED; ONLY THE CLI COULD NOT REACH IT.** `ModelAdapter`,
 * `ModelRegistry`, `ToolRegistry`, `DeliveryChannel`, `GateDispatcher`, `IdentitySource`
 * and `startControlPlane` are all on the pinned public surface, so a LIBRARY EMBEDDER
 * writes a third-wire provider, an in-process tool, an SMTP channel or an OIDC identity
 * source and forks nothing:
 * `Engine` already takes a `ModelRegistry` and `#runAgent` already resolves through it,
 * `GateDispatcher` already takes any `DeliveryChannel`, and `startControlPlane` already
 * takes any `IdentitySource`.
 * README's fork list nevertheless carried two entries — "a wire protocol that is not
 * Anthropic's or OpenAI's" and "an in-process tool, from the CLI" — under the blanket
 * reason that the closed sets here are closed by REPLAY. That reason is measurably false
 * for both: an adapter produces no journal vocabulary at all. `replay.ts` never reaches an
 * adapter and journals `provider: "replay"`, so a run served by a third-wire adapter
 * replays against an EMPTY `ModelRegistry` — which is what
 * `test/cli/extension-module.test.ts` asserts, round trip.
 *
 * **THE TRUST POSITION, stated rather than discovered.** A module named here is imported
 * into THIS process, in the host realm, holding everything the binary holds. That is
 * exactly the trust a `resources/function/*.js` body and a hand-registered `ToolRegistry`
 * entry already carry, and it is bounded by one fact: the path comes from ARGV, so it is
 * the operator's own choice loaded into the operator's own process. There is deliberately
 * NO sandbox and no validation of what an adapter returns — `node:vm` is scoping and not a
 * boundary, a streaming adapter is irreducibly async where `resources/realm.ts` refuses an
 * async body at load, and a coercion applied to a value trusted code produced would be a
 * guard answering an undecidable question with the passing value.
 *
 * **ARGV-ONLY IS LOAD-BEARING, NOT STYLISTIC, AND `identity` RAISED WHAT IT IS HOLDING UP.**
 * Discovering modules by scanning the workspace would let a FILE decide what code this
 * process runs, and a run holds `fs:write` — the escalation `openWorkspace`'s deny-list
 * exists to stop. With `{models, tools}` that bought a wrong provider and a wrong tool; with
 * `{channels, identity}` the same file would decide WHO MAY APPROVE and WHERE A GATE IS SENT,
 * which is oversight loosening itself along a path no human touched. So the rule is not a
 * preference and it is not "argv is tidier": **if any of this ever becomes loadable from a
 * config file, a `--*-file`, a resource ref or the data directory, every argument above fails
 * and the seam has to move behind a process boundary before the widening lands.** A module is
 * still trusted code either way; what argv buys is that a human typed the path.
 *
 * **IT REFUSES TO BOOT** rather than continue unextended, in five decidable cases, each
 * naming the path: the module does not resolve; it throws at import; its default export is
 * not a function; that function throws; or it registers nothing at all. There is no arm in
 * which a module named on argv is skipped and the process keeps going — that is a
 * deployment the operator believes is extended and is not. The sixth refusal lives in
 * `readModels`, where both halves are in hand: an adapter name colliding with a
 * `--models-file` row would leave one of the two permanently unreachable.
 *
 * **AND THREE MORE THE TWO NEW SEAMS BRING**, each the same shape — two things claiming one
 * slot, where the registry silently keeps one and nothing says which: two modules registering
 * one CHANNEL NAME (`GateDispatcher` keys by name, exactly `readChannels`'s duplicate-row
 * refusal); a module channel colliding with a `--channels-file` row; and a SECOND identity
 * source, from a second module or from `--identity-file`, because a deployment has one answer
 * to "who is this caller" and a silent second one is oversight decided by load order.
 *
 * **SCOPED TO `{models, tools, channels, identity}` EXACTLY** — the four entries this
 * removes from README's fork list, and no more. This object is the place a fifth seam
 * EXTENDS when somebody builds one; a second flag is the move to refuse, because the trust
 * argument above is written once and a second door would have to re-earn it.
 */
export interface ExtensionModules {
  /** Handed to `openWorkspace` in place of the registry it would have constructed. */
  readonly models: ModelRegistry;
  readonly tools: ToolRegistry;
  /**
   * Channels the modules registered, in load order, for `GateDispatcher`.
   *
   * A plain ARRAY and not a registry object, because `GateDispatcher`'s constructor takes
   * an array and this is the whole of what a channel is to this process: something with a
   * `name` and a `deliver`. `readChannels` merges these with its own rows and refuses a
   * name collision between them.
   */
  readonly channels: readonly DeliveryChannel[];
  /**
   * The identity source a module registered, or `undefined`.
   *
   * SINGULAR, and that is the whole design: a deployment has ONE answer to "who is this
   * caller". Two sources would be a chain whose order decides whether a credential is
   * accepted, which is oversight loosened by load order — so a second one refuses, and so
   * does this one arriving beside a `--identity-file`. See `pickIdentity`.
   */
  readonly identity: IdentitySource | undefined;
  /**
   * Adapters by the `provider` name each registered under.
   *
   * A MAP and not a bare `ReadonlySet<string>`, and the difference is load-bearing:
   * `readModels` does not only CHECK a route's adapter name, it resolves the name into the
   * `RoutingAdapter` it constructs — so a name with no object behind it would produce a
   * route that reads as configured and throws at the first model call.
   */
  readonly adapters: ReadonlyMap<string, ModelAdapter>;
  /** Tool names the modules registered, for the boot banner. */
  readonly toolNames: readonly string[];
  /** Channel names the modules registered, for the boot banner. Order matches `channels`. */
  readonly channelNames: readonly string[];
  /** Resolved paths, in load order, for the boot banner. */
  readonly files: readonly string[];
  /**
   * Whether a module claimed the DEFAULT adapter.
   *
   * Read by `openWorkspace` for one decision: the mock is registered as the default ONLY
   * when neither a `--models-file` nor an extension module claimed one. Registering it
   * unconditionally — which is what this file did — would overwrite an extension's claim
   * and answer every agent node with `[mock] …` in a deployment the operator extended.
   */
  readonly claimsDefault: boolean;
}

/**
 * `ModelRegistry` has no enumeration API, and three of this loader's answers need one.
 *
 * Subclassed rather than reached into: "it registered nothing", "this name collides with a
 * `--models-file` row" and the boot banner's list of what each module added are all
 * questions about WHAT WAS REGISTERED, and `register` is the only moment that is knowable.
 * Adding an enumerator to `run/registry.ts` would put a new method on a pinned public type
 * to serve one caller in one file.
 */
class ObservedModelRegistry extends ModelRegistry {
  readonly registered = new Map<string, ModelAdapter>();
  /**
   * Every `register` CALL, in order, not the distinct names.
   *
   * A count off `registered.size` looked equivalent and was not: two modules registering
   * the same provider name leave the size unchanged, so the second one would have been
   * refused for "registering nothing" — a refusal in the safe direction carrying a claim
   * that is simply false, which is worse than the original silence. The size answers
   * "which adapters exist" and this answers "did THIS module do anything", and they are
   * different questions.
   */
  readonly calls: string[] = [];
  override register(adapter: ModelAdapter, asDefault = false): LoomDisposable {
    this.calls.push(adapter.provider);
    this.registered.set(adapter.provider, adapter);
    return super.register(adapter, asDefault);
  }
}

/**
 * The same distinction one registry over. `ToolRegistry` keys by name and shadows on
 * collision, so `list().length` cannot tell "registered nothing" from "registered over
 * something".
 */
class ObservedToolRegistry extends ToolRegistry {
  readonly calls: string[] = [];
  override register(tool: Parameters<ToolRegistry["register"]>[0]): LoomDisposable {
    // AFTER, not before: `register` validates the manifest and throws on a bad one, and a
    // refused registration must not count as this module having done something.
    const d = super.register(tool);
    this.calls.push(tool.name);
    return d;
  }
}

/**
 * The two new seams have no registry class to subclass, so the COLLECTOR is the seam.
 *
 * `models` and `tools` reach a module as the real `ModelRegistry`/`ToolRegistry` this
 * process runs on; a delivery channel and an identity source have no such object — a
 * `GateDispatcher` is CONSTRUCTED from an array once `readChannels` has read the file, and
 * `startControlPlane` takes one `IdentitySource` by value. Handing a module the dispatcher
 * would mean building it before the file is read, which is the ordering `openWorkspace`'s
 * first line exists to prevent: a malformed channels file must refuse before anything is
 * created or opened. So these two collect, and the objects are built afterwards from what
 * they hold.
 *
 * They VALIDATE AT THE CALL, and that placement is the point: this is the only frame that
 * knows which module handed the value over. A nameless channel reaching `GateDispatcher`
 * instead throws from inside `serve`, long after the module that produced it is off the
 * stack, and names nobody.
 */
class CollectedChannels {
  readonly registered: DeliveryChannel[] = [];
  /** Every `register` CALL's name, in order — the distinction `ObservedModelRegistry.calls` makes. */
  readonly calls: string[] = [];
  register(channel: DeliveryChannel): void {
    const c = channel as { name?: unknown; deliver?: unknown } | null;
    if (typeof c !== "object" || c === null) {
      throw err.validation(CODES.E_CONFIG_INVALID, `channels.register was given ${c === null ? "null" : typeof c}, not a DeliveryChannel`);
    }
    if (typeof c.name !== "string" || c.name === "") {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `channels.register was given a channel whose "name" is ${JSON.stringify(c.name) ?? "absent"} — a dispatcher keys channels by ` +
          `name and a graph's delivery spec names them, so a channel without one can never be addressed.`,
      );
    }
    if (typeof c.deliver !== "function") {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `channels.register was given "${c.name}", which has no deliver() — a DeliveryChannel is ` +
          `{name, deliver(target, signal), parseCallback?(req)}, and defining parseCallback is what makes it ANSWERABLE.`,
      );
    }
    // AFTER the checks, for `ObservedToolRegistry`'s stated reason: a refused registration
    // must not count as this module having done something.
    this.calls.push(c.name);
    this.registered.push(channel);
  }
}

/**
 * Every identity source registered, not the last one — so the loop can name BOTH modules.
 *
 * An array for a slot that holds one. Keeping only the winner would leave the refusal below
 * able to say a second source arrived and unable to say where the first came from, which is
 * the shape of report this file refuses everywhere else.
 */
class CollectedIdentity {
  readonly sources: IdentitySource[] = [];
  register(source: IdentitySource): void {
    const src = source as { name?: unknown; identify?: unknown } | null;
    if (typeof src !== "object" || src === null) {
      throw err.validation(CODES.E_CONFIG_INVALID, `identity.register was given ${src === null ? "null" : typeof src}, not an IdentitySource`);
    }
    if (typeof src.name !== "string" || src.name === "") {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `identity.register was given a source whose "name" is ${JSON.stringify(src.name) ?? "absent"} — it is printed at boot and in ` +
          `refusals, and a deployment that cannot name who decides its callers is one nobody can diagnose.`,
      );
    }
    if (typeof src.identify !== "function") {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `identity.register was given "${src.name}", which has no identify() — an IdentitySource is {name, identify(req)}, where ` +
          `undefined establishes NOBODY and throwing REFUSES. It must never answer undefined because its upstream is down: an ` +
          `identity outage that degrades to "no identity" is how oversight quietly stops being enforced.`,
      );
    }
    this.sources.push(source);
  }
}

export async function loadExtensionModules(paths: readonly string[]): Promise<ExtensionModules> {
  const models = new ObservedModelRegistry();
  const tools = new ObservedToolRegistry();
  const channels = new CollectedChannels();
  const identity = new CollectedIdentity();
  const files: string[] = [];
  /** Which module registered each adapter name, so a collision refusal can name both. */
  const owner = new Map<string, string>();
  /** The same, one namespace over. Adapter names and channel names do not collide with each other. */
  const channelOwner = new Map<string, string>();
  /** Which module registered the one identity source, so the second one's refusal can name it. */
  let identityOwner: string | undefined;
  for (const raw of paths) {
    const path = resolve(raw);
    const refuse: (why: string) => never = (why) => {
      throw err.validation(CODES.E_CONFIG_INVALID, `--extension-module ${path}: ${why}`);
    };
    // TAKEN BEFORE, so the diff below is THIS module's contribution and not the previous
    // one's. A second module that registers nothing has to be refused even when the first
    // registered plenty.
    const adaptersBefore = models.calls.length;
    const toolsBefore = tools.calls.length;
    const channelsBefore = channels.calls.length;
    const identityBefore = identity.sources.length;
    let mod: { default?: unknown };
    try {
      // `pathToFileURL`, not the bare path: a relative specifier would resolve against
      // THIS file rather than against the operator's cwd, and on Windows a drive letter
      // reads as a URL scheme. Both failure modes are "the wrong module loaded", which is
      // the one outcome a loader must not have.
      mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
    } catch (e) {
      // ONE ARM FOR TWO CAUSES, deliberately, and the message carries the cause: from here
      // "there is no such file" and "the file threw while evaluating" are both reasons to
      // stop. What must never happen is a `catch {}` that cannot tell absent from
      // unreadable and answers either with "carry on unextended".
      refuse(`could not be loaded: ${(e as Error).message}`);
    }
    const factory = mod.default;
    if (typeof factory !== "function") {
      refuse(
        `has no default export that is a function. An extension module is ` +
          `\`export default ({models, tools, channels, identity}) => { … }\`, called with this process's ` +
          `ModelRegistry and ToolRegistry, a channel collector and an identity collector, before any ` +
          `configuration is read. Found ` +
          `${factory === undefined ? "no default export" : `a default export of type ${typeof factory}`}.`,
      );
    }
    try {
      // AWAITED, because a module that has to read a manifest before it can register
      // cannot do that synchronously, and a returned promise nobody awaits is a
      // registration race whose loser is every check below.
      await (
        factory as (reg: {
          models: ModelRegistry;
          tools: ToolRegistry;
          channels: CollectedChannels;
          identity: CollectedIdentity;
        }) => unknown
      )({ models, tools, channels, identity });
    } catch (e) {
      refuse(`threw while registering: ${isLoomError(e) ? e.message : (e as Error).message}`);
    }
    if (
      models.calls.length === adaptersBefore &&
      tools.calls.length === toolsBefore &&
      // COUNTED TOO, and the omission would have been the quietest defect in this change: a
      // module whose whole job is an SMTP channel registers no adapter and no tool, so a
      // check that still asked only those two would have refused the very deployment this
      // seam was built for.
      channels.calls.length === channelsBefore &&
      identity.sources.length === identityBefore
    ) {
      refuse(
        `registered nothing. Its default export must call \`models.register(adapter)\`, \`tools.register(tool)\`, ` +
          `\`channels.register(channel)\` or \`identity.register(source)\`; a module that registers nothing is a ` +
          `deployment the operator believes is extended and is not.`,
      );
    }
    // TWO MODULES, ONE ADAPTER NAME — the same refusal `readModels` makes about a file row
    // colliding with an extension, and for the same reason: the registry keys by name, so
    // one of the two would never be reachable and nothing anywhere would say which.
    for (const provider of models.calls.slice(adaptersBefore)) {
      const first = owner.get(provider);
      if (first !== undefined) {
        refuse(`registers the adapter name "${provider}", which ${first} already registered. One of them would never be reachable.`);
      }
      owner.set(provider, path);
    }
    // THE SAME REFUSAL FOR CHANNELS, and the reason is `readChannels`'s own about a duplicate
    // row rather than a new one: `GateDispatcher` keys its channels by name in a `Map`, so a
    // second `ops-email` silently replaces the first and one configured channel never delivers
    // anything, with nothing anywhere saying so.
    for (const name of channels.calls.slice(channelsBefore)) {
      const first = channelOwner.get(name);
      if (first !== undefined) {
        refuse(`registers the channel name "${name}", which ${first} already registered. One of them would never deliver.`);
      }
      channelOwner.set(name, path);
    }
    // AND THE ONE SLOT THAT HOLDS ONE. A second source is not a shadow, it is a second answer
    // to "who is this caller" — so whether a credential is accepted would be decided by argv
    // order, which is oversight loosening along a path nobody chose. Refusing is always allowed.
    for (const source of identity.sources.slice(identityBefore)) {
      if (identityOwner !== undefined) {
        refuse(
          `registers the identity source "${source.name}", and ${identityOwner} already registered one. A deployment has ONE answer ` +
            `to "who is this caller": a second would make acceptance depend on load order.`,
        );
      }
      identityOwner = path;
    }
    files.push(path);
  }
  return {
    models,
    tools,
    // A COPY, BECAUSE `models.registered` IS STILL LIVE. `openWorkspace` is handed this same
    // registry and registers the mock and the `--models-file` `RoutingAdapter` into it, so a
    // field aliasing the map grew AFTER the loader returned — and the boot line reads it. Driven
    // on a tool-only module with no `--models-file`:
    //
    //   ext:    /tmp/…/tool.mjs → adapter mock, tool house.ping
    //
    // `mock` is `MockModelAdapter`, which the operator's module did not register. The comment at
    // the boot line says the opposite — "Read off the loaded object rather than off the flag, so
    // no line can name a module that did not register what it said it would" — and it was true
    // of the flag and false of the object. `toolNames` and `files` were already snapshots; this
    // was the one field that was not.
    adapters: new Map(models.registered),
    toolNames: tools.list().map((t) => t.name),
    // SNAPSHOTS BY CONSTRUCTION — `CollectedChannels` is not handed to anything that appends
    // to it later, which is exactly the aliasing that made `adapters` print `adapter mock` for
    // a module that registered none. Copied anyway, so that stays true of the returned object
    // and not merely of today's callers.
    channels: [...channels.registered],
    channelNames: [...channels.calls],
    identity: identity.sources[0],
    files,
    // `get()` WITH NO ARGUMENT is the registry's own question — "is there a default?" —
    // rather than a second rule invented here. `ModelRegistry.register` claims the default
    // for the first adapter registered even when `asDefault` is false, so a module that
    // registered one adapter and said nothing about defaults has still claimed it.
    claimsDefault: models.get() !== undefined,
  };
}

/**
 * The three row shapes `readModels` reads, and the ONLY fields each may declare.
 *
 * WHY A LIST AT ALL: `errors.ts` states that a code arrives with its raiser, and a config
 * key has the mirror of that rule — a key arrives with its reader. Before these three sets,
 * `readModels` read a fixed handful of keys and silently ignored every other one. Measured:
 * `headers`, `apiVersion` and `zzz_nonsense` on an adapter row all printed
 * `ACCEPTED AND IGNORED. adapters=['openai']`. `readChannels`, one function over, already
 * refuses an unknown `kind` for the stated reason that a skipped field is a deployment that
 * boots looking configured — and an operator who wrote `headers` believes their gateway is
 * being sent a header.
 *
 * `headers` IS DELIBERATELY NOT HERE, and that is a decision rather than an omission. A
 * custom auth header is a credential; this file's own rule is that the file holds
 * configuration and the environment holds the credential, so a `headers` map would put a
 * secret one `git add` away from being public. A gateway with a bespoke auth scheme is an
 * `--extension-module`, which is a door that now exists.
 */
const ADAPTER_FIELDS: readonly string[] = ["provider", "name", "baseUrl", "apiKeyEnv", "prices", "defaultMaxTokens"];
const ROUTE_FIELDS: readonly string[] = ["adapter", "model", "fallback"];
const TIER_FIELDS: readonly string[] = ["adapter", "model", "when"];
/**
 * `cacheRead`/`cacheWrite` are NOT here on purpose: both adapters' options carry them and
 * this reader has never built them, so accepting the spelling would advertise a capability
 * the file does not have. See the refusal at the call site for the number it costs.
 */
const PRICE_FIELDS: readonly string[] = ["input", "output"];

/**
 * Refuse a field nothing reads, naming it and naming what the row MAY declare.
 *
 * NAMING THE MEMBERS is the whole shape of the refusal, and README's own test for an honest
 * closed set: a refusal that says "unknown field" and stops has told the operator they are
 * wrong without telling them what right looks like. There is no undecidable case here — a
 * key is in the set or it is not — and no arm in which an unread key is kept.
 *
 * THE MESSAGE NAMES NO ROW SHAPE, and it used to name one. Both sentences below were written
 * when `readModels` was the only caller: they said the unread key "changed nothing about the
 * adapter this row built" and cited an unknown `"provider"` as the precedent. `readMcpServers`
 * is the fifth shape through here and builds no adapter and reads no `provider`, so a
 * miscased `envallow` was refused with two sentences about a subsystem the operator had not
 * configured. A message shared by five call sites can only say what all five are true of.
 */
function onlyKeys(row: Record<string, unknown>, allowed: readonly string[], where: string, refuse: (why: string) => never): void {
  const unknown = Object.keys(row).filter((k) => !allowed.includes(k));
  if (unknown.length === 0) return;
  refuse(
    `${where} declares ${unknown.map((k) => JSON.stringify(k)).join(", ")}, which ${unknown.length === 1 ? "is a field" : "are fields"} ` +
      `nothing reads — so ${unknown.length === 1 ? "its value" : "their values"} changed nothing about what this row configures. ` +
      `This row may declare: ${allowed.join(", ")}. A field read by nothing is refused rather than ignored, and not merely ` +
      `dropped: a skipped field is a deployment that boots looking configured.`,
  );
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
  /**
   * Adapter rows that state no `defaultMaxTokens`, so every call they serve runs at
   * `DEFAULT_MAX_OUTPUT_TOKENS` — a number this repo picked and, until `modelWarnings`, never
   * printed. ADAPTER names rather than route keys because the field lives on the adapter row:
   * that is the line an operator has to edit, and a list of the eight routes reaching one
   * adapter would say the same thing eight times.
   */
  readonly unsetCeilings: readonly string[];
  readonly file: string;
  /**
   * Every fall-through every configured chain takes. Empty of listeners until something
   * subscribes, and empty of EVENTS when no row declares a `fallback` — see `FallbackFeed`.
   */
  readonly fallbacks: FallbackFeed;
}

/** The two adapters this binary can construct. A typo here must not become a silent mock. */
/**
 * `keyless` IS THE ADAPTER'S OWN RULE, RESTATED WHERE THE FILE IS READ.
 *
 * `openai.ts` accepts an empty `apiKey` when a `baseUrl` is given ("a local endpoint legitimately
 * needs no key"); `anthropic.ts` throws `E_PROVIDER_AUTH: anthropic adapter requires an apiKey`
 * on an empty key, `baseUrl` or not. This reader used to know only the first half, so the
 * missing-key refusal offered `"apiKeyEnv": null` to every row and an operator who took the
 * advice on an `anthropic` row walked into a second, differently-worded refusal one layer down.
 * Driven:
 *
 *     {"provider":"anthropic","baseUrl":"http://127.0.0.1:9"}
 *       → E_CONFIG_INVALID: … or set "apiKeyEnv": null if this endpoint genuinely takes no
 *         credential (which also needs a "baseUrl").
 *     the same row + "apiKeyEnv": null
 *       → E_CONFIG_INVALID: adapters[0] ("anthropic"): anthropic adapter requires an apiKey
 *
 * It failed closed, so nothing was ever loosened — but a remedy that cannot work is the same
 * defect as a cause that is not true. The flag is here rather than in a `provider === "openai"`
 * test at the two sites so a third provider has to answer the question.
 */
const PROVIDERS: Readonly<Record<string, { readonly keyEnv: string; readonly keyless: boolean }>> = {
  anthropic: { keyEnv: "ANTHROPIC_API_KEY", keyless: false },
  openai: { keyEnv: "OPENAI_API_KEY", keyless: true },
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
 * **`"apiKeyEnv": null` DECLARES THAT AN ENDPOINT TAKES NO CREDENTIAL**, and it is the only
 * way to say so. It requires a `baseUrl`, so it can never claim that a public endpoint is
 * keyless. Before it existed, a `baseUrl` on the OpenAI wire INFERRED the same thing, and
 * the inference was wrong in the shape that matters: a hosted gateway whose operator forgot
 * to export the key booted looking configured.
 *
 * **A FIELD NOTHING READS IS REFUSED**, on all three row shapes — see `onlyKeys` and the
 * three field sets above it.
 *
 * **A MALFORMED FILE REFUSES TO START**, the trade `readIdentities` and `readChannels` both
 * make, for the reason they make it: booting anyway produces a deployment that looks
 * configured and answers every model call with an error.
 */
export function readModels(
  file: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: HttpOptions["fetch"],
  /**
   * Adapters `--extension-module` already registered, by name.
   *
   * SEEDED INTO the adapter map rather than merely unioned into the route CHECK, because
   * this reader does not only validate a route's adapter name — it resolves the name into
   * the `RoutingAdapter` it constructs. A check alone would accept a row naming an
   * extension adapter and then hand `RoutingAdapter` a `Map` with nothing behind the key.
   */
  preRegistered: ReadonlyMap<string, ModelAdapter> = new Map(),
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
  // ABSENT IS LEGAL ONLY WHEN AN EXTENSION MODULE SUPPLIED THE ADAPTERS, and the condition
  // says so rather than being inferred from a later failure. A deployment whose only provider
  // is a third-wire `--extension-module` adapter has no row to write here — `provider` accepts
  // exactly `anthropic` and `openai` — so requiring one would make the route table reachable
  // only by an operator who also happened to configure a built-in provider they do not use.
  const rows = root.adapters ?? [];
  if (!Array.isArray(rows) || (rows.length === 0 && preRegistered.size === 0)) {
    refuse(
      `must be {"adapters":[{"provider":"anthropic"}],"routes":{"agent_profile/x@stable":{"adapter":"anthropic","model":"claude-sonnet-5"}}} ` +
        `with at least one adapter — or, with no "adapters" at all, at least one adapter registered by an --extension-module`,
    );
  }

  // WHAT AN EXTENSION MODULE REGISTERED IS ALREADY IN HERE, so a `routes` row may name an
  // extension adapter while an `adapters` row still constructs only the two built-in
  // providers. `declared` stays the FILE's own rows: the boot line says "… via <file>" and
  // naming an adapter this file did not declare would make that sentence false.
  const adapters = new Map<string, ModelAdapter>(preRegistered);
  const declared: string[] = [];
  const fallbacks = fallbackFeed();
  /** Adapter names whose row omitted `defaultMaxTokens`. See `ModelConfig.unsetCeilings`. */
  const unsetCeilings: string[] = [];
  rows.forEach((raw, i) => {
    const where = `adapters[${i}]`;
    const row = raw as Record<string, unknown> | null;
    if (typeof row !== "object" || row === null || Array.isArray(row)) refuse(`${where} is not an object`);
    // FIRST, so a misspelled `provider` is diagnosed as the misspelling it is rather than as
    // an absent one. See `onlyKeys` for why an unread field is a refusal at all.
    onlyKeys(row, ADAPTER_FIELDS, where, refuse);
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
    // THE SIXTH `--extension-module` REFUSAL, and it lives here because this is the only
    // place both halves are in hand. The registry keys adapters by name, so a file row and
    // an extension module claiming one name would leave whichever lost permanently
    // unreachable with nothing anywhere saying so — the same reason the duplicate-row
    // refusal below exists, one door over.
    if (preRegistered.has(name)) {
      refuse(
        `${where} declares the adapter name "${name}", which an --extension-module already registered. ` +
          `One of the two would never be reachable. Rename the row with "name", or drop it and route to the ` +
          `extension adapter directly.`,
      );
    }
    if (adapters.has(name)) refuse(`${where} repeats the adapter name "${name}" — one of them would never be reachable`);
    declared.push(name);

    const baseUrl = row["baseUrl"] === undefined ? undefined : nonEmpty(row["baseUrl"], `${where} ("${name}") "baseUrl"`, refuse);
    // **`null` IS A DECLARATION: "this endpoint takes no credential."**
    //
    // The condition here used to be `apiKey === "" && !(provider === "openai" && baseUrl !==
    // undefined)`, i.e. a `baseUrl` INFERRED that no credential was wanted. That is this
    // reader answering its undecidable case with the passing value, in the configuration the
    // live corpus actually used: a hosted OpenAI-compatible gateway with a `baseUrl` that DOES
    // want a key, whose operator forgot to export it, booted looking configured and 401'd an
    // hour later inside a run — the precise failure this check exists to move to boot.
    //
    // `null` rather than a new `noApiKey` boolean because `apiKeyEnv` is already the field
    // that answers "where does the credential come from"; `null` is that question answered,
    // not a second question. It is REACHABLE BY NO AUTOMATED PATH — it is a line a human wrote
    // in a file — which is what makes it a declaration rather than a loosening.
    //
    // A `baseUrl` IS REQUIRED ALONGSIDE IT, so the declaration tightens and cannot open a
    // door: an operator cannot declare api.anthropic.com or api.openai.com keyless.
    const rawKeyEnv = row["apiKeyEnv"];
    const keyless = rawKeyEnv === null;
    if (keyless && baseUrl === undefined) {
      refuse(
        `${where} ("${name}") sets "apiKeyEnv": null, which declares that this endpoint takes no credential — ` +
          `but it names no "baseUrl", so it is the ${provider} public endpoint, which does. Give it the "baseUrl" ` +
          `of the local or gateway endpoint you mean, or name the variable holding the key.`,
      );
    }
    // AND THE DECLARATION IS REFUSED WHERE THE ADAPTER WOULD REFUSE IT ANYWAY — here, naming the
    // adapter's rule, rather than at construction naming a field this file never mentioned. See
    // `PROVIDERS.keyless` for the measurement: accepting it here produced a second refusal in
    // other words, for an operator who had just done what the first one said.
    if (keyless && !PROVIDERS[provider]!.keyless) {
      refuse(
        `${where} ("${name}") sets "apiKeyEnv": null, but the ${provider} adapter requires a key at every ` +
          `endpoint — unlike the OpenAI wire, it has no local, keyless form, and it would refuse this row at ` +
          `construction with "${provider} adapter requires an apiKey". Name the variable holding the key with ` +
          `"apiKeyEnv", or point this row at an OpenAI-wire endpoint if the endpoint you mean speaks that wire.`,
      );
    }
    const keyEnv = rawKeyEnv === undefined || keyless ? PROVIDERS[provider]!.keyEnv : nonEmpty(rawKeyEnv, `${where} ("${name}") "apiKeyEnv"`, refuse);
    const apiKey = keyless ? "" : (env[keyEnv] ?? "");
    // NO CARVE-OUT FOR `openai` + `baseUrl` ANY MORE. The adapter still accepts an empty key
    // with a `baseUrl` — that is its own rule and it is right, because a local endpoint
    // legitimately has none — but the ADAPTER cannot tell "local, keyless" from "gateway whose
    // key was never exported", and neither can this reader. So it is stated here or it is not
    // known, and an unstated one is refused.
    if (!keyless && apiKey === "") {
      refuse(
        `${where} ("${name}") needs the environment variable ${keyEnv}, which is ${env[keyEnv] === undefined ? "not set" : "empty"}. ` +
          `The key is deliberately NOT a field in this file — the file is configuration and the key is a credential. ` +
          `Set ${keyEnv}, or name a different variable with "apiKeyEnv"` +
          // OFFERED ONLY WHERE IT WORKS. On `anthropic` this sentence sent the operator into a
          // second refusal; see `PROVIDERS.keyless`.
          (PROVIDERS[provider]!.keyless
            ? `, or set "apiKeyEnv": null if this endpoint genuinely takes no credential (which also needs a "baseUrl").`
            : `. The ${provider} adapter has no keyless form, so there is no third option here.`),
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
    // RECORDED HERE, where the ROW is in hand. The constructed adapter keeps its options
    // private, so after this loop there is no way to ask one whether the number it will send
    // was chosen or inherited — and that distinction is the whole warning: `modelWarnings`
    // fires on silence and never on a value, because a threshold applied to a ceiling the
    // operator picked is a banner line operators learn to skip.
    if (row["defaultMaxTokens"] === undefined) unsetCeilings.push(name);
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
    onlyKeys(row, ROUTE_FIELDS, where, refuse);
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
        onlyKeys(tier, TIER_FIELDS, at, refuse);
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
        adapters.set(
          chainName,
          new FallbackAdapter({
            provider: chainName,
            primary: { adapter: adapters.get(adapter)!, model },
            fallback: tiers,
            // THE CALLBACK THAT HAS SHIPPED DECLARED AND WIRED TO NOTHING. Without it a chain
            // falls through in silence: the runs succeed, the operator's primary is dead, and
            // the only evidence is three wasted requests per model turn that nobody counts.
            onFallback: (from, to, e) => fallbacks.emit(from, to, e),
          }),
        );
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
    adapters: declared,
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
    unsetCeilings,
    file: path,
    fallbacks,
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

  /**
   * ROUTES TOO, and this is the reason `ModelAdapter.outputCeilingOf` is a METHOD taking the
   * request rather than a field. `defaultMaxTokens` is per adapter ROW, and this class is the
   * only adapter `openWorkspace` ever registers — so the ceiling for a turn is a fact about
   * the row `req.model` resolves to, and a field on this object could not name it.
   */
  outputCeilingOf(req: ModelRequest): number {
    const to = this.#resolve(req.model);
    return to.adapter.outputCeilingOf({ ...req, model: to.model });
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
    // THE SAME RULE ONE LEVEL DOWN, and this is the sharpest case of it in the file. Both
    // adapters' `prices` option carries `cacheRead` and `cacheWrite`; this reader builds only
    // `{input, output}`, so an operator writing `"cacheRead": 0.3` had it dropped and every
    // cached token priced at `p.cacheRead ?? p.input` — the FULL input rate, a 10x
    // over-estimate that quietly refuses work a budget would have fit. Over-pricing is the
    // safe direction and silence is not, so the field is refused rather than accepted and
    // ignored.
    onlyKeys(row as Record<string, unknown>, PRICE_FIELDS, `${where}.${model}`, refuse);
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
 * HOW MANY RUNS THIS PROCESS DRIVES AT ONCE, and how wide each one may fan out.
 *
 * Their product is the ceiling on concurrent provider calls, and until these flags existed the
 * box had neither number. Measured at HEAD, driving 60 submissions the way `POST /runs` drives
 * them: **60 concurrent provider calls**. `EngineOptions.maxParallelism` bounds fan-out INSIDE
 * one run and defaults to 16; nothing bounded how many runs were in flight, because the 202
 * handler ended in a bare `void engine.advance(runId)`.
 *
 * FOUR IS A DELIBERATELY SMALL DEFAULT and the honest objection to it is that nobody can size
 * it: 4 x 16 = 64 concurrent provider calls is already more than most single-box deployments
 * want, and a maintainer's 50-run sweep now takes thirteen rounds instead of one. It is a
 * CEILING, not a queue depth — nothing is refused, the surplus waits and the run clock comes
 * back for it — so the failure mode of a wrong value is a slower box, never a lost run.
 * `announce` prints the arithmetic at boot so the number is never silent.
 */
const DEFAULT_MAX_RUNS_IN_FLIGHT = 4;

/** `EngineOptions.maxParallelism`'s own default, named here so `announce` can print it. */
const DEFAULT_MAX_PARALLELISM = 16;

/**
 * The upper bound on both concurrency dials.
 *
 * Not defensive typing: each of these multiplies into simultaneous outbound HTTP requests and
 * simultaneous SQLite writers, and a `--max-parallelism 100000` typed for `--budget-tokens` is
 * a process that dies to file-descriptor exhaustion at a point far from the flag. Refused at
 * parse time, where the operator is still watching.
 */
const MAX_CONCURRENCY = 1024;

/**
 * A caller-supplied WHOLE COUNT — `positive`'s sibling for the numbers that are not
 * milliseconds on a timer, and the discipline all five deployment flags share.
 *
 * WHAT IT DOES WHEN IT CANNOT DECIDE: it refuses, and the process does not boot. That is the
 * whole point of it existing rather than `Number(raw) || fallback`, which is how every one of
 * these would otherwise have been written:
 *
 *   - `--max-parallelism` with no value is `true` from `parseArgs` and `Number(true)` is **1**,
 *     a box that runs one node at a time and says nothing;
 *   - `--max-parallelism=` with an unset variable is `""` and `Number("")` is **0**, which
 *     `Engine` clamps back to 1 by `Math.max(1, …)`, so the flag is silently disregarded;
 *   - `--budget-usd NaN`, or any non-numeric string, is the dangerous one: every comparison
 *     against `NaN` is FALSE, so a `NaN` ceiling is not a loose cap, it is NO cap, on a
 *     process that reports having one.
 *
 * A malformed value therefore never falls through to 16, to 1, or to "no ceiling".
 */
function boundedCount(raw: string | true | undefined, flag: string, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `${flag} must be a whole number from 1 to ${max}, not ${raw === true ? "a bare flag with no value" : `"${raw}"`}. ` +
        `Omit it for the default of ${fallback}.`,
    );
  }
  return n;
}

/**
 * `--budget-usd`, `--budget-tokens`, `--budget-wall-ms` — the DEPLOYMENT's ceilings.
 *
 * Distinct from `loom run --budget`, which is one run's allotment. These are
 * `policy.budget.{runUsd,runTokens,runWallMs}` on the Engine, and `Engine.submit` folds all
 * three by `minDefined` against the graph's own `policy.budget` — so a graph may lower an
 * operator's ceiling and can never raise it.
 *
 * THE HOLE THESE CLOSE. `openWorkspace` built its Engine with `policy: { granted }` and no
 * `budget` at all, so the deployment half of every one of those three folds was `undefined`
 * and the only money ceiling on the whole box was whatever each graph happened to declare. A
 * graph declaring none had none.
 *
 * DOLLARS ARE FRACTIONAL AND THE OTHER TWO ARE NOT, which is why this does not go through
 * `boundedCount` for the first: `--budget-usd 0.50` is an ordinary value and a whole-number
 * check would refuse it. `NaN` is refused for all three and for the same reason.
 */
function deploymentBudget(args: Args): BudgetLimits | undefined {
  const usdRaw = args.flags["budget-usd"];
  const runUsd = ((): number | undefined => {
    if (usdRaw === undefined) return undefined;
    const n = typeof usdRaw === "string" ? Number(usdRaw) : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `--budget-usd must be a positive number of US dollars, not ${usdRaw === true ? "a bare flag with no value" : `"${usdRaw}"`}. ` +
          `It is this deployment's ceiling per run; omit it for no deployment ceiling, and note that a graph declaring none then has none.`,
      );
    }
    return n;
  })();
  const tokensRaw = args.flags["budget-tokens"];
  const runTokens = tokensRaw === undefined ? undefined : boundedCount(tokensRaw, "--budget-tokens", 0, Number.MAX_SAFE_INTEGER);
  const wallRaw = args.flags["budget-wall-ms"];
  const runWallMs = wallRaw === undefined ? undefined : boundedCount(wallRaw, "--budget-wall-ms", 0, Number.MAX_SAFE_INTEGER);
  if (runUsd === undefined && runTokens === undefined && runWallMs === undefined) return undefined;
  return {
    ...(runUsd === undefined ? {} : { runUsd }),
    ...(runTokens === undefined ? {} : { runTokens }),
    ...(runWallMs === undefined ? {} : { runWallMs }),
  };
}

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
 * The ONLY fields a `--mcp-file` server row may declare — the fifth row shape `onlyKeys` guards,
 * beside the four `readModels` brings (adapter, route, tier, price).
 *
 * WHY THIS EXISTS AT ALL is `readModels`' argument word for word: a key arrives with its reader,
 * and before this list `readMcpServers` validated exactly these four names and then BUILT ITS
 * RESULT FROM THEM, so every other key was dropped without a word. Driven at `0c3c486`, on
 * `{"servers":[{"name":"docs","command":"node","envallow":["PATH"],"irreversibility":"safe"}]}`:
 *
 *     readMcpServers(file) -> [{"name":"docs","command":"node"}]
 *
 * — both operator fields gone, exit 0, nothing on stderr. The miscased one is the worse half and
 * the reason a typo guard belongs here rather than only in USAGE: `envAllow` is the whole child
 * environment, so `envallow` is a server that starts with an EMPTY environment and dies on
 * `spawn npx ENOENT` two layers away from the lowercase `a` that caused it — the exact failure
 * this reader's own refusal message already spends three lines warning about.
 *
 * `irreversibility` IS NOW ON THIS LIST, and it is the only field in this file that can make the
 * binary do LESS oversight than it did before. `CLAUDE.md` is explicit that a human may lower a
 * posture and no automated path may, so the field owes an argument and not just a validator.
 * Four parts, and the fourth is a condition rather than a caveat.
 *
 * 1 · THIS FILE IS ALREADY THE ARBITRARY-CODE DOOR, so the field grants nothing new. A row here
 * names `command` and `args`, and `startMcp` SPAWNS them — against no program allow-list, and
 * without `--allow-exec`, which is the flag that bounds the only OTHER child this binary starts.
 * Driven on 2026-09-02: `loom run --mcp-file …` with no `--allow-exec` anywhere spawned the
 * configured command and registered its tools. The same row names `envAllow`, which selects out
 * of THIS process's environment, the one holding provider API keys. Whoever can write this file
 * can already run a program of their choosing with the operator's credentials and have whatever
 * it calls itself registered as a tool.
 * `"irreversibility": "read_only"` is strictly weaker than the `"command": "/bin/sh"` the same
 * row could always have said, and a door is not opened by a key that reaches less far than the
 * door standing open beside it.
 *
 * 2 · `loadExtensionModules`' RULE IS ABOUT THE PATH, AND THIS PATH IS ARGV. That rule reads "a
 * path read out of a FILE would let a FILE decide who may approve", and the thing it forbids is
 * transitive: a file the RUNTIME produced naming what to trust. Here `requireFileFlag` reads the
 * path off `Args`; `Args` comes from `parseArgs`, which has exactly ONE caller in `src/` — `main`
 * — whose own only `src/` caller is `main(process.argv.slice(2))` at the foot of this file. So
 * there is no path by which a value the runtime computed becomes this flag: the operator who
 * typed it chose this file, which is exactly the standing `--extension-module` has, and that one
 * hands a module the whole `ToolRegistry`.
 *
 * 3 · WHAT STAYS CLOSED IS THE SERVER'S CLAIM ABOUT ITSELF, and it is closed structurally rather
 * than by this paragraph: `mcpTools` takes the class as a PARAMETER and contains no expression
 * that reads `spec` or `client` for one, so `tools/list` cannot reach it. Neither can a model or
 * a graph: no journal event, no tool result and no channel value is on the path from anywhere to
 * `ToolDefinition.irreversibility`. Inferring the class from a server's advertised metadata was
 * refused in writing at `TODO.md` §D.1 and is still refused.
 *
 * 4 · AND ALL THREE ASSUME ONE OPERATOR. The person who wrote the mcp file and the person who
 * ran the binary are the same person here by deployment decision — single machine, single
 * tenant — and part 1 inverts the moment they are not: a file somebody else wrote is not the
 * operator's own hand, and then this field IS a stranger lowering a gate. That is the condition
 * to re-check before this binary grows a second operator, and it is why the class is per SERVER
 * and never per tool: the blast radius of a wrong declaration is one server an operator named.
 *
 * The default is unchanged and is `irreversible`, in `mcpTools`' own parameter default rather
 * than at a call site — so a deployment that upgrades without touching its mcp file gates
 * exactly where it gated before. `test/mcp/irreversibility.test.ts` is the pair that pins it:
 * the CONTROL half asserts `awaiting_gate` from a file with no such key.
 */
const MCP_SERVER_FIELDS: readonly string[] = ["name", "command", "args", "envAllow", "irreversibility"];

/**
 * The four classes a row may name, READ OFF THE VOCABULARY rather than retyped.
 *
 * `CLASS_DEFAULT_POSTURE` is a `Record` over the whole union, so this list cannot drift from the
 * members `IrreversibilityClass` actually has — a fifth class added to `vocab.ts` is accepted
 * here on the same commit, and the refusal below names it without anybody editing this file.
 */
const IRREVERSIBILITY_CLASSES = Object.keys(CLASS_DEFAULT_POSTURE) as readonly IrreversibilityClass[];

/**
 * One validated `--mcp-file` row: what `McpClient` needs, plus what the OPERATOR declared about it.
 *
 * Separate from `McpClientOptions` on purpose. `McpClient` never reads `irreversibility` — it is
 * not a fact about talking to the server, it is a fact about how this deployment governs it — and
 * putting it on the client's options type would have added a field to a pinned public interface
 * that the class it configures ignores.
 */
export interface McpServerConfig extends McpClientOptions {
  readonly irreversibility?: IrreversibilityClass;
}

/**
 * A connected server, paired with the class its row declared — defaulted, so callers cannot omit it.
 *
 * The pairing is the point. `openWorkspace` registers tools from this array, and the shape it
 * would otherwise be handed — clients plus a lookup keyed by server name — is one where a miss
 * returns the default silently. Here there is no miss to have.
 */
export interface ConnectedMcpServer {
  readonly client: McpClient;
  readonly irreversibility: IrreversibilityClass;
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
export function readMcpServers(file: string): readonly McpServerConfig[] {
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
  return rows.map((raw, i): McpServerConfig => {
    const where = `servers[${String(i)}]`;
    const row = raw as Record<string, unknown> | null;
    if (typeof row !== "object" || row === null || Array.isArray(row)) refuse(`${where} is not an object`);
    // BEFORE the field checks, so a row that is wrong in two ways is diagnosed at the key that
    // was never going to be read rather than at the value of one that was.
    onlyKeys(row, MCP_SERVER_FIELDS, where, refuse);
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
    // A VALUE OUTSIDE THE VOCABULARY IS REFUSED, NOT ROUNDED TO THE DEFAULT. Rounding is the
    // tempting move because the default is the strict one and so the rounding is fail-closed —
    // but it hides the typo that produced it, and the operator who wrote `read-only` walks away
    // believing they lowered something. Refusing is always allowed; a silent no-op is not.
    const irreversibility = row["irreversibility"];
    if (irreversibility !== undefined && !IRREVERSIBILITY_CLASSES.includes(irreversibility as IrreversibilityClass)) {
      refuse(
        `${where}.irreversibility must be one of ${IRREVERSIBILITY_CLASSES.join(", ")} — it is the ` +
          `oversight class EVERY tool this server offers is registered with, and omitting it means ` +
          `irreversible, which gates`,
      );
    }
    return {
      name,
      command,
      ...(args === undefined ? {} : { args: args as readonly string[] }),
      ...(envAllow === undefined ? {} : { envAllow: envAllow as readonly string[] }),
      ...(irreversibility === undefined ? {} : { irreversibility: irreversibility as IrreversibilityClass }),
    };
  });
}

/**
 * What the boot output says about a `--mcp-file` row that lowered a gate.
 *
 * SEPARATE FROM THE WRITE, for the reason `execWarnings` is: the decision worth checking is WHICH
 * rows are named, and a test that wants it otherwise has to drive a process and read its stderr.
 * It is written from `main` rather than from `announce`, which is the one way it differs from
 * `execWarnings` and is deliberate — `announce` runs on `serve` only, and a lowered class matters
 * most on `loom run`, where there is no plane and no banner and the gate that does not fire is
 * the only thing an operator would otherwise have noticed.
 *
 * A ROW THAT SAYS `irreversible` OUT LOUD IS NOT NAMED HERE. It changed nothing, and a warning
 * that fires on a no-op is a warning operators learn to skip — `MAX_BANNER_GATES` is the same
 * argument applied to a different line.
 */
export function mcpLoweringWarnings(servers: readonly McpServerConfig[]): readonly string[] {
  // THE POSTURE, NOT THE SPELLING. This tested `!== "irreversible"` and so warned about a row
  // declaring `externally_visible` — whose default posture is `in`, the SAME floor
  // `irreversible` produces, making such a row a pure no-op for the gate. The banner then told
  // the operator their tools now run "at that class instead of irreversible, so a node reaching
  // one may run with no human", which is false for that class: this file's own test asserts
  // `A DECLARED externally_visible STILL GATES`. A warning that fires on a no-op and misstates
  // it is worse than none — it is the noise that gets a real banner ignored.
  //
  // `isLoosening` is the predicate `vocab.ts` already exports for exactly this question, so the
  // filter now asks the thing it means: does this class produce a posture floor BELOW the one
  // `irreversible` produces?
  const lowered = servers.filter(
    (srv): srv is McpServerConfig & { readonly irreversibility: IrreversibilityClass } =>
      srv.irreversibility !== undefined &&
      isLoosening(CLASS_DEFAULT_POSTURE.irreversible, CLASS_DEFAULT_POSTURE[srv.irreversibility]),
  );
  if (lowered.length === 0) return [];
  return [
    `! MCP OVERSIGHT LOWERED BY --mcp-file — ` +
      `${lowered.map((srv) => `${srv.name}: ${srv.irreversibility} (posture floor ${CLASS_DEFAULT_POSTURE[srv.irreversibility]})`).join("; ")}\n` +
      `  Every tool those servers offer is registered at that class instead of irreversible, so a\n` +
      `  node reaching one may run with no human. This is the only place a config file lowers a\n` +
      `  gate in this binary, and it is your declaration about the server, not the server's.\n`,
  ];
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
export async function startMcp(servers: readonly McpServerConfig[]): Promise<readonly ConnectedMcpServer[]> {
  const clients: ConnectedMcpServer[] = [];
  for (const opts of servers) {
    const client = new McpClient(opts);
    try {
      await client.start();
    } catch (e) {
      for (const c of clients) c.client.close();
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
    // THE DEFAULT IS APPLIED HERE, ONCE, so no later reader has to remember it. `mcpTools` holds
    // the same default in its own parameter, which is belt and braces on purpose: an embedder who
    // never calls this function still cannot be loosened by omission.
    clients.push({ client, irreversibility: opts.irreversibility ?? "irreversible" });
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
  // EVERY DIAGNOSTIC NAMES ITS FILE, and until it did, the loudest lines in this binary were
  // about a file nobody could identify. `graphsByHash` compiles EVERY file in `<workspace>/graphs/`
  // to find the one a run recorded, and each of those compiles wrote its diagnostics here — so
  // `loom approve <run> <gate>`, the highest-consequence command in the product, printed
  // `✗ GRAPH017_CAPABILITY_NOT_GRANTED: …` about an unrelated graph, above a successful approval,
  // and exited 0. The approver could not tell whether they had just approved a gate on a broken
  // graph. `recordedGraph`'s own docstring states the rule this broke — "SAY WHAT IT RESOLVED. A
  // verb that silently picks a file out of a directory is a verb whose output an operator cannot
  // check" — and the not-found path already did it right (`1 would not compile — slow.json: …`).
  //
  // `basename`, matching the two places that already attribute a graph failure: `graphsByHash`'s
  // `failed` entries and `discoverGraphs`' skip line. An operator reading three of these wants the
  // same token in all three.
  const where = basename(file);
  if (!result.ok) {
    for (const d of result.diagnostics) {
      process.stderr.write(`${d.severity === "error" ? "✗" : "!"} ${where}: ${d.code}: ${d.message}\n`);
      if (d.fix !== undefined) process.stderr.write(`   fix: ${d.fix}\n`);
    }
    throw result.error;
  }
  for (const d of result.diagnostics) process.stderr.write(`! ${where}: ${d.code}: ${d.message}\n`);
  if (introducing) {
    requireHookBodies(ws, result.graph.spec);
    requireFunctionBodies(ws, result.graph.spec);
  }
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
 * THE SAME RULE FOR THE OTHER CODE KIND, because for one mistake there were two answers.
 *
 * A DELETED body was already a compile error on both paths: `GRAPH015_RESOURCE_NOT_FOUND`,
 * exit 1, for a `function` ref and for a `hook` ref alike — the resolver cannot resolve what
 * the store does not hold. A MALFORMED body was not. Measured, one graph, one `module.exports`
 * body, the two directories:
 *
 *     resources/hook/no-secrets.js   → ! skipping … → E_RESOURCE_NOT_FOUND, exit 1
 *     resources/function/count.js    → ! skipping … → ok,                   exit 0
 *
 * and the function case then died mid-run as `E_RESOURCE_NOT_FOUND: no function registered as
 * "function/count@stable"` — after the journal was opened, after the run id was minted. The two
 * kinds are published the same way, registered the same way by two functions with the same
 * shape, and refused by the same seam; the only thing that differed was whether anything asked
 * at compile time. `requireHookBodies`' own reason applies here word for word: this registry is
 * built FROM THE WORKSPACE, so a ref it lacks is a missing or broken FILE.
 *
 * `introducing` gates it exactly as it gates the hook check, and for the same reason — see that
 * flag's docstring: a re-attach must not let a broken extension file hide a live run from the
 * human who has to answer its gate.
 *
 * TWO REF SOURCES, NOT ONE. `Engine.#functionBody` has two callers — `#runFunction` and
 * `#runEvaluator`'s `assertion` arm — and its own comment records that every previous change to
 * this contract landed at one of them a commit before the other. Both are read here.
 *
 * SCOPE, NAMED: the top-level spec's own nodes. A `subgraph` node's inner graph is compiled on
 * its own way in and gets this check then; it is not reached through the parent's node list, and
 * neither is `requireHookBodies`.
 */
function requireFunctionBodies(ws: Workspace, spec: GraphSpec): void {
  const missing: string[] = [];
  for (const node of spec.nodes ?? []) {
    // Guarded like `requireHookBodies`: this runs on the way to the validator, so it sees
    // caller data and must not crash on a shape the validator is about to refuse.
    if (typeof node !== "object" || node === null) continue;
    const refs = [
      node.type === "function" ? node.function?.ref : undefined,
      // An `assertion` evaluator's ref IS a function body. A `rubric` evaluator's is a prompt,
      // and reading it here would report a prompt as a missing function.
      node.type === "evaluator" && node.evaluator?.kind === "assertion" ? node.evaluator.ref : undefined,
    ];
    for (const ref of refs) {
      if (typeof ref !== "string" || ws.engine.functions.get(ref) !== undefined) continue;
      missing.push(`${node.id}: ${ref}`);
    }
  }
  if (missing.length === 0) return;
  throw err.validation(
    CODES.E_RESOURCE_NOT_FOUND,
    `this graph declares ${missing.length} function body(s) this workspace does not publish or could not ` +
      `load (${missing.join(", ")}). Add the body at ${join(ws.root, "resources", "function")}/<name>.js — ` +
      `and if a "! skipping" line appeared above, the file IS there and did not compile, which is what that ` +
      `line says and why this refuses here rather than mid-run`,
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

/**
 * Say what deadline each node will ACTUALLY run under, and where it came from.
 *
 * UNCONDITIONAL, beside `printRetryPlan`, for the identical reason and after the identical bug.
 * Before `NodePlan.timeoutMs`, a node declaring no `timeoutMs` had no deadline at all and its
 * Task hung forever; the fix is a compiled DEFAULT, and a default an operator has to know to ask
 * about is a hidden default with extra steps.
 *
 * `(declared)` versus `(default)` is the half that matters most here: an author who wrote a
 * number needs to see that nothing touched it, and an author who wrote none needs to see that
 * something now applies. Nodes with no deadline are silent — this lists what WILL happen, and
 * the five types that get none say so through `loom validate`'s schema, not through a line here
 * repeating "none" once per node.
 */
function printTimeoutPlan(graph: RunGraph): void {
  for (const n of graph.spec.nodes) {
    const ms = graph.plans[n.id]?.timeoutMs;
    if (ms === undefined) continue;
    process.stdout.write(`  deadline ${n.id} (${n.timeoutMs === undefined ? "default" : "declared"}): timeoutMs=${ms}\n`);
  }
}

/**
 * How many CONSECUTIVE advances that append NOTHING to the journal `loom run` sits through
 * before it gives up and says so.
 *
 * IT IS NOT A LAP COUNT, and that swap is the whole of A.13. The bound here used to be
 * `MAX_BACKOFF_WAITS = 64` — how many times this loop would wait at all — so the CLI's own
 * patience, not the run's, decided when a run was abandoned. Measured on a graph declaring
 * `retry: { maxAttempts: 70, backoff: "fixed", initialMs: 30 }` against a body that returns
 * `{ retry }` every time: the run was abandoned `running` on the 65th wait with
 * `! run … was still retrying after 64 waits`, while its journal was appending an attempt and
 * a `task.retry_scheduled` per lap and the engine was honouring exactly the bound the AUTHOR
 * declared. A deferral can be up to 60 s, so the same ceiling is reachable in an hour by a
 * rate-limited run that never failed at all.
 *
 * What the loop is really guarding against is a run THIS PROCESS CANNOT MOVE, and the fold
 * already answers that question without counting anything: `RunProjection.seq` is the seq of
 * the last event folded, so an advance that left it where it was appended nothing and changed
 * nothing. That is the predicate `TODO.md` §A.13 asks for, and it is one a restart reaches the
 * same answer on because it is read off the journal rather than off this loop.
 *
 * EIGHT rather than one, because one stalled advance is not yet evidence: a timer that reaches
 * `retryAfter` a tick early leaves the engine with nothing due, and that costs a lap and no
 * more. Eight consecutive ones cost eight laps of a run that is not moving, which is cheap,
 * and every one of them is bounded below by a real `retryAfter` wait or is instant.
 */
const MAX_STALLED_ADVANCES = 8;

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
 * journaled. TWO THINGS BOUND HOW MANY THERE CAN BE, not one — the node's retry policy bounds
 * charged retries, and `DEFERRAL_BUDGET_MS` bounds rate-limit deferrals, which are deliberately
 * not charged to the policy (see `Engine.#retryDecision`). A rate-limited run therefore waits
 * here for longer than it used to, and that time is the same time the transport used to spend
 * asleep inside `advance` holding a worker slot; the difference is that it is now visible, and
 * Ctrl-C reaches it.
 *
 * THOSE TWO BOUNDS ARE THE ONES THAT DECIDE WHEN THIS RETURNS, and this loop deliberately adds
 * no third one of its own. Its backstop fires on a run that is not moving — see
 * `MAX_STALLED_ADVANCES` — not on a run that is moving slowly, because a run appending an
 * attempt per lap is a run the engine is still bounding, and giving up on it here reports a
 * `running` run that would have finished.
 *
 * **IT REPORTS ON THE FIRST CASE AND NOT THE SECOND, and an earlier draft of this paragraph
 * claimed both.** A run that is NOT MOVING hits the backstop and this returns with a line
 * saying so. A run that IS moving slowly runs for as long as the bounds its author declared
 * allow, however long that is — `validate.ts` accepts any integer `maxAttempts >= 1` with no
 * ceiling, and `initialMs`/`maxMs` are the author's too — so this loop can block for an
 * arbitrarily long time by design. That is the trade: giving up on a run the engine is still
 * bounding would report a `running` run that would have finished, and this command's job is
 * to say what happened rather than to invent a deadline the graph did not declare.
 *
 * EXPORTED FOR THE TEST, on `serveUntilInterrupt`'s precedent — "the test drives the failure
 * with a `close()` that rejects". The backstop arm is unreachable through `loom run`: it needs
 * an `advance` that returns `running` with a pending retry and appends nothing, and every real
 * engine either moves `seq` or stops returning that shape. `run-progress-bound.test.ts` drove
 * the arm that must NOT fire for a wave and the arm that must — the eight-lap give-up and its
 * stderr line — was exercised by nothing: replacing `stalled = p.seq > before ? 0 : stalled + 1`
 * with `stalled = 0`, so the counter can never reach the ceiling, left all 2825 tests green.
 * Taking the workspace as a parameter is the whole coupling, so a stub engine is enough.
 * `cli.ts` is not on the pinned surface — `scripts/surface.json` pins `index.ts`'s exports and
 * `index.ts` re-exports nothing from here — so this costs no surface change, exactly as
 * `parseArgs`, `serveUntilInterrupt` and `exportTraceOverOtlp` already do.
 */
export async function driveToRest(ws: Workspace, runId: RunId, first: RunProjection): Promise<RunProjection> {
  let p = first;
  let stalled = 0;
  while (stalled < MAX_STALLED_ADVANCES) {
    if (p.status !== "running") return p;
    const wake = (Object.values(p.tasks) as TaskRecord[])
      .filter((t) => t.state === "ready" && t.retryAfter !== undefined)
      .reduce<number | undefined>((min, t) => (min === undefined || (t.retryAfter ?? 0) < min ? t.retryAfter : min), undefined);
    // Running with nothing to wait for is not backoff — it is a run this process cannot move,
    // and saying so beats spinning on `advance`.
    if (wake === undefined) return p;
    await new Promise((r) => setTimeout(r, Math.max(0, wake - Date.now())));
    const before = p.seq;
    p = await ws.engine.advance(runId);
    // THE ONLY EVIDENCE OF PROGRESS THIS LOOP TRUSTS. Not the task's attempt count and not the
    // wake instant moving: both are projections of the journal, and reading one of them here
    // would make this bound depend on which FIELD a future retry decision happens to touch.
    // `seq` moves iff something durable was written, for every decision the engine takes.
    stalled = p.seq > before ? 0 : stalled + 1;
  }
  process.stderr.write(
    `! run ${runId} appended nothing to its journal across ${MAX_STALLED_ADVANCES} advances while a retry was pending; giving up on it here\n`,
  );
  return p;
}

/**
 * THE CLI'S ONE `Engine.submit` CALL SITE, and it stays one on purpose.
 *
 * `test/run/submit-callers.test.ts` counts the call sites per file — by scanning for the text,
 * so this sentence deliberately does not spell the pattern out; writing it here once cost a red
 * run. `SubmitInput.submittedBy` is optional and an absent principal is the PERMISSIVE case — a
 * run nobody owns
 * is readable by every authenticated caller. A second, forgetful submit inside a file already
 * on that list is exactly what the count exists to catch. `loom promote --against-cohort` starts
 * runs too, and routing it through here means the CLI's answer to "who owns the runs this binary
 * starts" is given in one place rather than twice.
 *
 * Both callers pass `submitterFlag(args)`, so the answer is unchanged: `--as` or nobody.
 */
async function startAndDrive(
  ws: Workspace,
  input: { graph: RunGraph; inputs: Record<string, unknown>; submittedBy?: SubmittedBy; budgetUsd?: number },
  // CALLED BETWEEN THE SUBMIT AND THE FIRST ADVANCE, and that instant is the whole point. The
  // run id is the only durable coordinate a run has, and `loom run` printed it only once the
  // run had reached rest — so an interrupt, a crash or a `kill` at any point before that left a
  // real run in the journal that nothing on screen had ever named. See `announceRun`.
  submitted?: (runId: RunId) => void,
): Promise<{ runId: RunId; projection: RunProjection }> {
  const runId = await ws.engine.submit(input);
  submitted?.(runId);
  return { runId, projection: await driveToRest(ws, runId, await ws.engine.advance(runId)) };
}

/**
 * SAY THE RUN ID BEFORE THE RUN CAN BE LOST, and answer an interrupt by stopping the run.
 *
 * Measured on the tree before this existed: `loom run` against a slow endpoint, `kill -INT` four
 * seconds in — exit 130, **zero bytes on stdout and zero on stderr**, and a journal holding
 * `run.submitted … effect.started` for a run whose id had never been displayed. The operator was
 * left with a durable, half-executed run they could not name: `loom cancel <id>` would stop it and
 * `loom trace <id>` would explain it, and neither has an id to be given. That is the "stop it, and
 * trust what it did" half of THE GOAL failing at the first interrupt.
 *
 * TWO SEPARABLE HALVES, and the first is the one that matters. **The line on stderr** is
 * unconditional and costs nothing: it is written the instant `submit` returns, so every later
 * failure — an interrupt, a `kill -9`, a provider hang, a crash — leaves the id on the terminal.
 * It goes to stderr because stdout carries a JSON document `loom run` callers pipe.
 *
 * **The handler** then makes the ordinary interrupt tidy rather than merely survivable: SIGINT and
 * SIGTERM both journal an operator cancel, so the journal records that a HUMAN stopped this run
 * rather than leaving it looking abandoned mid-effect. `cancel` is the same call the `cancel` verb
 * makes, with the same actor, so the two doors write the same row.
 *
 * IT DOES NOT `process.exit`. Exiting from the handler would skip `main`'s `finally`, which closes
 * the MCP children and the SQLite store — the very leak this file fixes one function over. The
 * cancel makes the run terminal, `driveToRest` returns, and the command exits through its normal
 * path with the projection printed and the status `cancelled`. So the exit code is 1, the
 * vocabulary `serveUntilInterrupt` argues for, and not 130.
 *
 * A SECOND SIGNAL IS THE IMPATIENT ONE and it is left to Node's default disposition — the
 * listeners are removed, so the next SIGINT ends the process the way it did before this function
 * existed. An operator whose in-flight effect will not return must not have to find another
 * terminal to kill the process from.
 *
 * `disarm` IS RETURNED RATHER THAN THE CALLER REMEMBERING THE HANDLER: a listener left on
 * `process` after the run has finished would answer a later Ctrl-C by cancelling a run that has
 * already ended, and `main` runs one command per process only by convention.
 */
function announceRun(ws: Workspace, runId: RunId, subject: string): () => void {
  process.stderr.write(`run ${runId} — inspect it with: loom trace ${runId}\n`);
  const onStop = (): void => {
    for (const sig of STOP_SIGNALS) process.removeListener(sig, onStop);
    process.stderr.write(`! interrupted — cancelling run ${runId}; another interrupt ends this process outright\n`);
    void ws.engine.cancel(runId, "interrupted", { kind: "human", subject, via: "cli" }).catch((e: unknown) => {
      // The run is still in the journal and still named on the line above, which is what the
      // operator needs; a failed cancel must not become an unhandled rejection on top of it.
      process.stderr.write(`! could not cancel run ${runId}: ${toLoomError(e).message}\n`);
    });
  };
  for (const sig of STOP_SIGNALS) process.on(sig, onStop);
  return () => {
    for (const sig of STOP_SIGNALS) process.removeListener(sig, onStop);
  };
}

/**
 * What this process will actually do to a model call, decided as a pure function of the config.
 *
 * SEPARATE FROM THE WRITE, for the reason `execWarnings` is: the interesting half is WHICH lines
 * a configuration earns, and asserting that through `serve` means spawning a process and racing
 * its stderr. Before this split the decision went straight to `process.stderr` and only the
 * no-adapter line had ever been asserted on, through the CLI, in `cli.test.ts`.
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
 * EVERY LINE HERE REPORTS A NUMBER OR A GUARD THAT IS NOT WHAT THE OPERATOR THINKS IT IS, and
 * none of them second-guesses a value the operator wrote down. That is the rule the third line
 * had to be designed around — see the comment above it.
 */
export function modelWarnings(models: ModelConfig | undefined, command: string): readonly string[] {
  if (models === undefined) {
    return [
      `! NO MODEL ADAPTER — the only registered adapter is the offline mock, so every agent node and every rubric\n` +
        `  evaluator returns canned text. Runs will look successful.\n` +
        `  fix: loom ${command} --models-file <file> with {"adapters":[{"provider":"anthropic"}],"routes":{…}}\n`,
    ];
  }
  const out: string[] = [];
  if (models.unpriced.length > 0) {
    const n = models.unpriced.length;
    out.push(
      `! NO PRICE FOR ${n} ROUTE${n === 1 ? "" : "S"} — every call on ${n === 1 ? "it" : "them"} is journaled as costing 0,\n` +
        `  so a graph's policy.budget.costUsd and --budget cannot bind and /health reports a spend that did not happen:\n` +
        models.unpriced.map((r) => `    ${r}\n`).join("") +
        `  fix: add "prices": {"<model>": {"input": <usd per 1M>, "output": <usd per 1M>}} to that adapter in ${models.file}\n`,
    );
  }
  // THE CEILING NOBODY CHOSE. A live GLM-5.2 turn ended `finishReason "max_tokens"` with
  // `outputTokens 32001` and `contentChars 0` — the whole budget went to reasoning and the answer
  // was empty. `turnRefusal` in `run/engine.ts` makes that a clean refusal instead of a silently
  // empty answer, which is the fix for the symptom; it still costs a real call to find out. The
  // operator got there by trying 4,096 — which never reached content at all — then 16,000, which
  // still truncated one turn of three, reading a SQLite journal between attempts.
  //
  // WHY IT FIRES ON SILENCE AND NEVER ON A VALUE. A ceiling the operator wrote down is a decision
  // this file has no evidence to overrule: nothing here knows a route's model, let alone how that
  // model splits output between reasoning and content, and a banner line that fires on a correct
  // configuration is a line operators learn to skip. What it CAN say without inventing a
  // threshold is that a row named no ceiling and inherited one. `defaultMaxTokens: 1` therefore
  // gets nothing, and that is deliberate — it is a choice, and a wrong choice is a different
  // defect from an invisible default.
  if (models.unsetCeilings.length > 0) {
    const n = models.unsetCeilings.length;
    out.push(
      `! NO OUTPUT-TOKEN CEILING SET ON ${n} ADAPTER${n === 1 ? "" : "S"} — ${n === 1 ? "it sends" : "they send"} ` +
        `max output tokens = ${String(DEFAULT_MAX_OUTPUT_TOKENS)}, this binary's\n` +
        `  default and not a number you chose: ${models.unsetCeilings.join(", ")}\n` +
        `  A reasoning model spends this budget on reasoning BEFORE it emits content, and the ceiling covers both.\n` +
        `  Measured on a live one: a turn ended finishReason "max_tokens" with outputTokens 32001 and ZERO characters\n` +
        `  of content. Setting this too low does not shorten the answer, it deletes it — the turn is refused as\n` +
        `  E_PROVIDER_BAD_REQUEST after the call has already been paid for.\n` +
        `  fix: add "defaultMaxTokens": <n> to that adapter in ${models.file}\n`,
    );
  }
  return out;
}

/** `modelWarnings`, on stderr — never stdout: `loom run` prints a JSON document there and a caller pipes it. */
function warnAboutModels(models: ModelConfig | undefined, command: string): void {
  for (const line of modelWarnings(models, command)) process.stderr.write(line);
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
 *
 * AND THE FILE THAT SUPPLIED EACH HASH comes back too. A verb that resolves a graph the operator
 * did not name has to be able to SAY which file it picked — `recordedGraph` prints it, and the
 * refusal below it lists the candidates it rejected. A hash alone names nothing an operator can
 * open. The value is the path RELATIVE TO THE WORKSPACE, not a bare basename, because there is
 * more than one directory in it now.
 *
 * **AND `resources/subgraph/` IS IN IT, WHICH IS THE WHOLE OF A CHILD RUN'S ANSWERABILITY.**
 * `Engine` mints a delegated run of its own for a `subgraph` node, and that child compiles the
 * SUBGRAPH RESOURCE — a spec that lives under `resources/`, never in `graphs/`. So a gate raised
 * inside a subgraph was listed by `GET /gates`, rendered with approve and reject buttons by the
 * console, and answerable by nothing: the hash was in no index, `#bindFromIndex` found no graph,
 * and the decision came back `E_RUN_NOT_FOUND "… is not attached"`. Measured before this line:
 *
 *     loom approve '<parent>~delegate@root#0' gate_… --as u:alice
 *     → E_RUN_NOT_FOUND: … compiled graph sha256:ae21ee…, and no graph in <ws>/graphs has that
 *       hash (1 searched).
 *     loom approve '<parent>~delegate@root#0' gate_… --as u:alice --graph resources/subgraph/leaf.json
 *     → the decision lands.
 *
 * The operator had to hand-name a file the engine chose. `SPEC_KINDS` is the same list
 * `readResources` publishes specs from, so this reads the directories the workspace already
 * defines rather than a second opinion about where a graph may live.
 *
 * `graphs/` IS SCANNED FIRST AND WINS A HASH COLLISION, which keeps `recordedGraph`'s message
 * naming the top-level file whenever one exists. Two files with one hash are the same bytes, so
 * the choice is only about which name an operator is shown.
 */
function graphsByHash(ws: Workspace): GraphIndex {
  return indexGraphs(ws, ["graphs", ...subgraphDirs()]);
}

/** The workspace directories a SPEC resource is published from — `readResources`' own list. */
function subgraphDirs(): readonly string[] {
  return SPEC_KINDS.map((k) => join("resources", k));
}

interface GraphIndex {
  index: Map<string, RunGraph>;
  files: Map<string, string>;
  failed: readonly string[];
}

/**
 * The walk itself, taking the directories — so the plane's ATTACH-ONLY inventory and the CLI's
 * full lookup are one implementation with two arguments rather than two loops that drift.
 *
 * `controlPlaneOptions` asks for the resource directories alone. Asking for all of them there
 * would recompile `graphs/` a second time at `loom serve` boot, and `loadGraph` writes its
 * diagnostics to stderr — so every warning in that directory would be printed twice in the boot
 * banner, which is how an operator learns to stop reading it.
 */
function indexGraphs(ws: Workspace, dirs: readonly string[]): GraphIndex {
  const index = new Map<string, RunGraph>();
  const files = new Map<string, string>();
  const failed: string[] = [];
  for (const rel of dirs) {
    const dir = join(ws.root, rel);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!/\.(json|ya?ml)$/i.test(file)) continue;
      try {
        // `false`: every caller of this function is re-attaching a graph to a run that already
        // exists — the run clock, and the door an approver answers a gate through.
        const graph = loadGraph(ws, join(dir, file), false);
        if (!index.has(graph.graphHash)) {
          index.set(graph.graphHash, graph);
          files.set(graph.graphHash, join(rel, file));
        }
      } catch (e) {
        failed.push(`${join(rel, file)}: ${(e as Error).message}`);
      }
    }
  }
  return { index, files, failed };
}

/**
 * THE GRAPH A RUN RECORDED, FOUND RATHER THAN DEMANDED — one lookup, and the verbs share it.
 *
 * `RunGraph` is not journaled, only its hash is, so a fresh process has to be told or has to
 * look. `approve` has looked since the `--graph` it demanded turned out to appear in no usage
 * text and no error message; `audit` degrades to the rules it can check and names every skip.
 * `replay` and `trace` went on demanding the flag, so a workspace that could APPROVE and AUDIT a
 * run by id alone could not RE-EXECUTE it unless the operator remembered which file it ran —
 * DESIGN item 14, reproduced through the binary as `E_CONFIG_INVALID: --graph needs a path`.
 * This is `approve`'s search, extracted rather than copied: a second implementation of one
 * lookup is TODO.md §F.2's drift shape.
 *
 * THREE ANSWERS, NOT TWO. "this workspace publishes no graph" and "it publishes graphs, none of
 * them this run's" are different facts and the caller is told which, with the rejected
 * candidates named. Conflating them is the absence-is-not-zero rule, and on `replay` the
 * conflation is the expensive one: re-executing against a graph the run did not use reports
 * `match: false` about the RUN when the replayer is what differed, which is the class
 * `replay-fidelity` exists to keep out. So the search is by HASH and nothing else can win it.
 *
 * `--graph` STILL WINS WHEN GIVEN, and it is checked. It is how a graph living outside `graphs/`
 * is named without publishing it — `loom score --graph` documents exactly that use, and refuses
 * a file whose hash is not the run's for the reason above. Same rule here.
 *
 * THE CALLERS ARE `replay` AND `trace`, AND THAT IS THE WHOLE SET. `approve`, `steer` and
 * `deescalate` share the lookup underneath — `graphsByHash` — and not this policy, because all
 * three want a DIFFERENT answer to the same three cases: they attach and carry on when the hash
 * is absent (a run with no `run.compiled` is refused by the engine underneath, with a better
 * message than this one), `approve` re-arms the gate clock after attaching, and its refusal ends
 * with gate advice (`loom cancel`, and why not `--reject`) that means nothing on a replay. One
 * lookup, two policies over it, stated here so the next reader does not "unify" them.
 */
async function recordedGraph(ws: Workspace, args: Args, runId: RunId, verb: string): Promise<RunGraph> {
  const wanted = await ws.engine.compiledGraphHash(runId);
  const named = (g: RunGraph): string => `${g.spec.metadata.name} v${String(g.spec.metadata.version)} (${g.graphHash})`;
  if (args.flags["graph"] !== undefined) {
    const file = requireFileFlag(args, "graph");
    // `false` for the same reason `graphsByHash` passes it: this graph is being re-attached to a
    // run that already exists, not introduced.
    const g = loadGraph(ws, file, false);
    if (wanted !== undefined && g.graphHash !== wanted) {
      throw err.validation(
        CODES.E_GRAPH_MISMATCH,
        `--graph ${file} compiles to ${g.graphHash}, and run ${runId} compiled ${wanted}. ` +
          `\`loom ${verb}\` re-reads that run's journal against the graph it is given, so a different graph ` +
          `reports its own differences as the run's. A graph EDITED since the run no longer matches, which is ` +
          `the point — this run executed the old bytes. Pass the file holding ${wanted}, or drop --graph and ` +
          `let ${join(ws.root, "graphs")} be searched for it.`,
        { details: { runId, ran: wanted, given: g.graphHash, file } },
      );
    }
    process.stderr.write(`${verb}: graph ${named(g)} — from --graph ${file}\n`);
    return g;
  }
  if (wanted === undefined) {
    throw err.notFound(
      CODES.E_RUN_NOT_FOUND,
      `run ${runId} has no run.compiled event in this workspace, so nothing in its journal names the graph it ` +
        `ran and there is no hash to search ${join(ws.root, "graphs")} for. Pass --graph <file> with the graph ` +
        `this run ran.`,
      { details: { runId } },
    );
  }
  const { index, files, failed } = graphsByHash(ws);
  const found = index.get(wanted);
  if (found !== undefined) {
    // SAY WHAT IT RESOLVED. A verb that silently picks a file out of a directory is a verb whose
    // output an operator cannot check; `approve` and `audit` both name what they found.
    process.stderr.write(`${verb}: graph ${named(found)} — the hash run ${runId} recorded, from ${files.get(wanted) ?? "?"}\n`);
    return found;
  }
  // ABSENCE IS NOT ZERO. An empty `graphs/` and a `graphs/` full of other people's graphs are
  // different diagnoses with different fixes, so they get different sentences.
  const others = [...index.values()].map((g) => `${files.get(g.graphHash) ?? "?"} ${named(g)}`);
  throw err.notFound(
    CODES.E_RUN_NOT_FOUND,
    `run ${runId} compiled graph ${wanted}, and no graph ${ws.root} publishes has that hash — not in graphs/, ` +
      `resources/subgraph/ or resources/graph/. ` +
      (others.length === 0
        ? `It publishes no graph this process can compile`
        : `It publishes ${String(others.length)}, and none is this run's — ${others.join("; ")}`) +
      `${failed.length === 0 ? "" : ` (${String(failed.length)} would not compile — ${failed.join("; ")})`}. ` +
      `Publish the graph this run used, or pass --graph explicitly — a candidate outside graphs/ is named that ` +
      `way. A graph EDITED since the run no longer matches, which is the point: this run executed the old bytes.`,
    { details: { runId, graphHash: wanted, searched: index.size, ...(failed.length === 0 ? {} : { failed }) } },
  );
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
/**
 * WHO DECIDES WHO A CALLER IS — one source, from a file or from a module, never both.
 *
 * `--identity-file` builds a `BearerTokenIdentity`; an `--extension-module` may register an
 * OIDC, mTLS or proxy-header source instead. Both together is REFUSED rather than chained,
 * and the refusal is the interesting half of this function:
 *
 *  - A chain that tries one and then the other ACCEPTS THE UNION of two credential sets, so
 *    adding a source can only ever widen who gets in. That is loosening along an automated
 *    path, which this codebase's second non-negotiable forbids outright — and it would do it
 *    invisibly, since neither half can see the other.
 *  - Preferring one silently is worse: the operator wrote both files, one of them decides
 *    nothing, and the plane boots looking configured — `readChannels`' named failure, moved
 *    onto the field that says who may approve.
 *
 * So: refusing is always allowed, and this refuses. An operator who wants both writes the
 * `--identity-file` subjects into their module, which is a source that can read a file.
 */
function pickIdentity(ws: Workspace, args: Args): IdentitySource | undefined {
  const fromFile = args.flags["identity-file"] === undefined ? undefined : readIdentities(requireFileFlag(args, "identity-file"));
  const fromModule = ws.extensions?.identity;
  if (fromFile !== undefined && fromModule !== undefined) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--identity-file and the --extension-module ${ws.extensions?.files.join(", ") ?? ""} both establish who a caller is ` +
        `("${fromModule.name}"), and a deployment has ONE answer to that. Chaining them would accept the union of two ` +
        `credential sets — a widening no human asked for — and preferring one would leave the other configured and reading ` +
        `nothing. Drop one: a module source that also wants those subjects can read the file itself.`,
    );
  }
  return fromFile ?? fromModule;
}

export function controlPlaneOptions(ws: Workspace, args: Args): ControlPlaneOptions {
  const graphs = discoverGraphs(ws);
  const identity = pickIdentity(ws, args);
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
    // THE SUBGRAPHS ITS OWN RUNS DELEGATE TO — attachable, never submittable, and what makes a
    // child run's gate answerable over HTTP rather than only through `loom approve --graph <the
    // subgraph file>`. The RESOURCE directories only: `discoverGraphs` has already compiled
    // `graphs/` one line up, and compiling it again here would print every diagnostic in it twice
    // in the boot banner. See `ControlPlaneOptions.subgraphs` for why the two lists stay separate.
    subgraphs: [...indexGraphs(ws, subgraphDirs()).index.values()],
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
      // "--token or --identity-file" NAMED TWO OF THREE DOORS. The condition `listen` actually
      // refuses on is `openToEveryCaller` — no token AND no identity SOURCE — and an
      // `--extension-module` registering an OIDC or mTLS source satisfies it with neither flag
      // given. Driven: `serve --extension-module <ext.mjs> --host 0.0.0.0` binds. `listen`'s own
      // refusal already said "no token and no identity source" generically; these two usage
      // strings were the copies that fell behind the seam.
      `--host ${why}. Omit it for the default of ${DEFAULT_HOST} — loopback, reachable only from this machine — ` +
        `or name an interface such as 0.0.0.0 on purpose, which also needs a credential: --token, or an identity ` +
        `source from --identity-file or an --extension-module.`,
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
export const DEFAULT_RUN_CLOCK_LIMIT = 200;

/**
 * HOW LONG ONE PAGE OF THE SCAN LASTS, in milliseconds of wall clock.
 *
 * The tick's position used to be a counter in the clock's own closure — `const rot = { offset: 0 }`,
 * built fresh by `startRunClock` at every boot. It is a period instead, because the position is
 * DERIVED from `now` rather than remembered, and a derivation needs a unit. `serve` passes its
 * own `--sweep-ms`, so one tick advances by exactly one page and the coverage argument is the
 * one the counter had. This default exists for a caller that has no period of its own; nothing
 * in `src/` takes it.
 */
export const RUN_CLOCK_LAP_MS = 1_000;

/**
 * What one tick saw. TWO FIELDS, BOTH READ — `test/deployment/run-clock-window.test.ts` asserts
 * on `visited` and pins the traversal's cost through `pages`. A tick that also reported what it
 * ADVANCED would be the natural third, and it is left out until something reads it: this file
 * has enough declared-and-unread surface in its history already.
 *
 * THE FIELD THAT IS GONE IS `truncated`, and its absence is the item being closed. It said "a
 * run older than the scan ceiling exists and this clock will never reach it" — an honest report
 * of a starvation rather than a fix for one. There is no ceiling left for it to report.
 */
export interface RunClockTick {
  /** The runs this tick's page covered, in listing order. */
  readonly visited: readonly RunId[];
  /**
   * How many pages the traversal walked to measure the listing — `ceil(N / limit)`, and
   * therefore also how many ticks a full lap takes.
   *
   * IT IS THE COST THAT REPLACED THE CEILING, which is why it is reported rather than kept
   * private: the ceiling bought a bound on rows-per-tick by giving up on the runs beyond it,
   * and this trades that back. A test that asserts on it is asserting on the number of
   * `run_head` scans a tick makes, which is the thing that would regress if somebody made the
   * traversal re-walk.
   */
  readonly pages: number;
}

/**
 * ONE TICK OF THE RUN CLOCK: advance the runs whose backoff has elapsed, over ONE PAGE of a
 * cursor traversal that has no ceiling.
 *
 * THE CLOCK ITSELF, first, because it did not exist either. `Engine.advance` RETURNS while a
 * Task is in backoff, so something has to come back once the clock has moved. `loom run` does
 * that for the run it submitted — and nothing did it for a run submitted over HTTP. Reproduced
 * by a reviewer: a `POST /runs` whose node retries sat `running` with `attempt 1` eighteen
 * seconds after `retryAfter` elapsed, and moved only when a human POSTed `{"kind":"advance"}`
 * by hand, once per attempt.
 *
 * EVERY RUNNING RUN WITH A READY TASK, not only one whose backoff has elapsed — and that
 * widening is what makes the dispatcher's withholding safe rather than terminal.
 *
 * The predicate used to be `t.retryAfter !== undefined && t.retryAfter <= now`, which was
 * correct while the only thing that could leave a run un-driven was a backoff. It is not any
 * more: `drive` holds at most `--max-runs-in-flight` `advance` calls at once and DOES NOT
 * DISPATCH beyond that, so a submitted run can sit `running` with a `ready` task whose
 * `retryAfter` is `undefined` — invisible to the old predicate forever. Measured before this
 * widened: a run submitted and never advanced projects exactly that shape, and no lap of the
 * clock would ever have touched it. The surplus waits for a tick; the tick has to be able to
 * see it.
 *
 * WHAT THEN KEEPS THIS FROM FIGHTING A LIVE DRIVER, since "it has a due retry" no longer does,
 * is three things and they are worth naming individually because only the first is new:
 *
 *   1. **The dispatcher's dedupe set.** A run already in flight is not dispatched again, so a
 *      tick landing on top of an HTTP-driven run is a no-op inside `drive` rather than a second
 *      `advance`.
 *   2. **`Engine.advance` CHAINS rather than coalescing** — a second call on the same run is
 *      serialized behind the first. Two calls that do get through cost a fold, not a race.
 *   3. **Commit-time CAS on seq.** Every commit compare-and-swaps on the seq its decision was
 *      taken at, so where two processes collide the loser writes nothing — the same argument
 *      `GateSweeper` makes for itself one file over.
 *
 * (2) AND (3) HOLD ACROSS PROCESSES AND (1) DOES NOT, and that is the fact to inherit rather
 * than the reassurance. Two `loom serve` processes each hold their own dedupe set and their own
 * N, so the box's real bound is 2N and the widened predicate broadens the double-dispatch
 * window from "backed-off runs" to "every running run". Both processes then pay the model call
 * while only one writes. That is acceptable at one process over one store, which is what this
 * deployment is; it is not a property to carry into a second.
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
 * SO THE VIEW MOVES — AND IT MOVES BY THE CLOCK, NOT BY A COUNTER. This is the second defect
 * and it hid inside the fix for the first. The first fix was `const rot = { offset: 0 }` built
 * by `startRunClock`, mutated in place, and reconstructed by nothing: a value a decision reads
 * that the journal cannot rebuild across a restart, which is CLAUDE.md's first non-negotiable
 * and the class `oversight-survives-restart.test.ts` names. Measured on a 250-run journal at
 * `limit` 200, with the control beside it:
 *
 *     CONTROL long-lived rot: oldest run reached on tick 1
 *     RESTARTED rot:          oldest run reached on boot -1     (never, over 20 boots)
 *
 * So the 200-run starvation was fixed for a plane that stays up and unfixed for one that
 * restarts — which is the shape a crash-looping or frequently-redeployed plane always has.
 * The position is DERIVED from `now`, never remembered, and that has not changed here.
 *
 * WHAT HAS CHANGED IS HOW THE POSITION IS REACHED, and it is the third defect: the derivation
 * used to be an index into an array. The tick asked `listRuns(RUN_CLOCK_SCAN_CEILING)`, got up
 * to ten thousand summary rows, and took `(floor(now / lapMs) * limit) mod N` of them. So the
 * ceiling was a bound on how many rows one tick would MATERIALISE, and a run below row ten
 * thousand was reached by no lap of any rotation — `RunClockTick.truncated` was the only reason
 * anyone knew. That is DESIGN item 13, and it is what this closes.
 *
 * THE TICK NOW TRAVERSES THE LISTING WITH A CURSOR: `listRuns(limit, { after })`, page after
 * page, to the end. Three things follow, and only the first is the item:
 *
 *   1. THERE IS NO CEILING. The traversal holds one page plus one run id per page — twice, in
 *      an array and a set, both referencing the same string — so its memory does not grow with
 *      the journal and there is nothing left to cap. Every run is reachable at every N. The set
 *      is the termination check: see it at the loop for why a walk whose only exit is a property
 *      of the page has to have one.
 *   2. THE POSITION IS A PAGE INDEX, `floor(now / lapMs) mod pages`, and the coverage argument
 *      is the one the ring had: consecutive ticks take consecutive pages, so a given run is in
 *      view once per `pages` ticks and `pages` is `ceil(N / limit)`. Nothing is remembered, so
 *      a plane that restarts between every tick computes the page a plane that stayed up would
 *      have. `run-clock-survives-restart.test.ts` is that property and it is unchanged.
 *   3. THE COST MOVED RATHER THAN VANISHING, and this is the honest half. A tick reads `N`
 *      `run_head` rows to measure the listing where it used to read `min(N, 10 000)` and give
 *      up past that. Rows, not journals: the expensive half — one `projection` fold per run in
 *      view — is still capped at `limit` and is untouched. A deployment where the row scan
 *      itself is the problem has the coordinator-shaped problem TODO §E.2 names, which a
 *      call-site scan should not pretend to solve; what it must not do is pretend the runs
 *      below its own bound do not exist, which is what the ceiling did.
 *
 * WHY A KEYSET CURSOR AND NOT AN OFFSET, since an offset would have removed the ceiling too:
 * new runs land at the HEAD of a `run_id DESC` listing, so a submission landing between two
 * pages shifts every later row down one and an offset walk SKIPS a run. The skip would be
 * silent and intermittent and would look exactly like the starvation this is closing. A key is
 * a position in the ORDER: a run inserted above the cursor is not in this walk at all, and the
 * page fetched after the walk is the same page the walk measured.
 *
 * WHAT IT DOES NOT PROMISE, said plainly because a fairness claim that overstates itself is
 * worse than the bound it replaced:
 *
 *   - Nothing here is fair against a STREAM of new submissions. New runs land at the head, so
 *     a run can be pushed below a page that has already passed it and wait a further lap.
 *     Bounded-lap fairness, not FIFO.
 *   - The guarantee is over TICKS THAT ADVANCE `now` BY `lapMs`. A clock whose ticks arrive at
 *     an exact multiple of `lapMs` steps by that multiple, and a step that shares a factor with
 *     `pages` visits a subset of them — `startRunClock` passes its OWN period as `lapMs`
 *     precisely so the ordinary step is one.
 *   - Two processes scanning one store do not coordinate — they agree, which is not the same
 *     thing and is not better: they take the same page and duplicate the folds. Every write a
 *     tick causes still compare-and-swaps on the seq its decision was taken at, so the loser
 *     writes nothing. That is the same argument `GateSweeper` makes for itself. A cursor does
 *     not fix this and was never going to: dividing the listing between two planes needs a
 *     fact that spans runs, and `journal/store.ts` says why there is nowhere to keep one.
 *
 * `now` is a parameter for the reason every clock in this codebase is: a tick that read
 * `Date.now()` internally could not be driven by a test that has not slept. It is load-bearing
 * twice over here — it is also what the page index is derived FROM.
 */
export async function runClockTick(
  ws: Workspace,
  limit: number,
  now: number = Date.now(),
  lapMs: number = RUN_CLOCK_LAP_MS,
  /**
   * WHERE A RUN IS HANDED OFF, and it must not block this loop.
   *
   * The tick awaits serially, so with the widened predicate above an `await advance` on a
   * long-running run would hold the whole window and starve the retries this clock exists for
   * — which is exactly why the widening and the dispatcher land together and neither is
   * useful alone. `serve` passes `runDispatcher(...).drive`, which is bounded, deduped and
   * synchronous.
   *
   * DEFAULTED TO TODAY'S BEHAVIOUR — an awaited `advance` — for the callers that have no
   * dispatcher, which today is the tests. It is the SERIAL shape, so the default is slower
   * than the shipped path and never wider: the direction a default on a concurrency dial has
   * to be wrong in.
   */
  drive: (runId: RunId) => void | Promise<void> = async (runId) => {
    await ws.engine.advance(runId);
  },
): Promise<RunClockTick> {
  // A LIMIT OF ZERO IS NO CLOCK, which is what the rotation answered too and is the only safe
  // reading of a mistyped knob: fewer runs folded, never more, and never a walk whose page size
  // makes the traversal not terminate.
  if (limit <= 0) return { visited: [], pages: 0 };

  // THE TRAVERSAL. One page at a time, each cursored on the last row of the one before, to the
  // end of the listing. What is kept is one page and one run id PER PAGE — so the memory this
  // costs is `ceil(N / limit)` ids and not `N` summary rows, which is the whole reason the
  // ceiling is gone rather than merely raised.
  //
  // THE FIRST PAGE IS KEPT because it is the one the common deployment folds: under §D.2 (one
  // machine, tens of runs a day) `pages` is 1, `at` is 0, and this whole loop is exactly the one
  // `listRuns` the tick made before — of `limit` rows rather than ten thousand.
  const boundaries: RunId[] = [];
  const seen = new Set<RunId>();
  let head: readonly RunSummary[] = [];
  let cursor: RunId | undefined;
  for (;;) {
    const page = cursor === undefined ? await ws.store.listRuns(limit) : await ws.store.listRuns(limit, { after: cursor });
    if (page.length === 0) break;
    if (boundaries.length === 0) head = page;
    cursor = page[page.length - 1]!.runId;
    // THE ONLY THING THAT ENDS THIS LOOP IS THE STORE, AND `StateStore` IS AN EXTENSION POINT.
    // Both shipped backends implement `after` as an exclusive keyset cursor and
    // `test/journal/conformance.ts` pins that for each, so nothing in-tree reaches this line —
    // but a third-party store that accepts `after` and IGNORES it returns the same full page
    // forever, and every exit above is a property of the page rather than of the walk. Driven
    // against such a store the tick never returned; `startRunClock`'s `running` latch then held
    // true for the life of the process, so the clock stopped advancing runs AND stopped saying
    // anything, which is the one failure mode this whole file is written to prevent.
    //
    // A REPEATED BOUNDARY IS THE DECIDABLE FORM OF "THE CURSOR DID NOT MOVE". The listing is
    // strictly ordered and `after` is exclusive, so a conforming store can never hand back a run
    // id this walk has already taken as a boundary — which makes this a refusal with no false
    // positive rather than a heuristic bound on page count. The set costs one id per page, the
    // same order `boundaries` already holds, so it does not give back the memory argument above.
    //
    // IT THROWS RATHER THAN TRUNCATING. Stopping the walk here would silently reinstate the scan
    // ceiling this traversal exists to remove — a bounded view of an unbounded journal, quietly
    // — and a guard that cannot decide fails closed. The rejection reaches `startRunClock`'s
    // failure handler, which prints `RUN CLOCK STOPPED ADVANCING` followed by this message.
    if (seen.has(cursor)) {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `the StateStore in use returned run "${cursor}" twice as a page boundary while paging listRuns(${limit}, { after }), ` +
          `so its cursor does not advance — listRuns must treat "after" as an EXCLUSIVE position in its own ordering and ` +
          `return only runs that sort after it. Refusing rather than folding a truncated view of the journal.`,
      );
    }
    seen.add(cursor);
    boundaries.push(cursor);
    // A SHORT PAGE IS THE END OF THE LISTING, and taking it as such saves the empty page that
    // would otherwise prove it. A page of exactly `limit` at the end costs that extra call,
    // which is the price of not guessing.
    if (page.length < limit) break;
  }
  const pages = boundaries.length;
  if (pages === 0) return { visited: [], pages: 0 };

  // `Math.max(0, now)` and `Math.max(1, lapMs)`: a clock handed a negative instant or a zero
  // period is a caller's bug, and the answer to it is the first page rather than a NaN that
  // silently folds nothing.
  const at = Math.floor(Math.max(0, now) / Math.max(1, lapMs)) % pages;
  // RE-FETCHED BY CURSOR RATHER THAN REMEMBERED. Holding every page would put `N` summary rows
  // back in this process, which is the cost the traversal exists to avoid. Re-fetching is exact
  // rather than approximate because the cursor is a key: runs submitted since the walk land
  // ABOVE `boundaries[at - 1]` and cannot shift this page.
  const visible = at === 0 ? head : await ws.store.listRuns(limit, { after: boundaries[at - 1]! });

  // LAZY, because the traversal makes this run more often and `graphsByHash` re-reads and
  // RE-COMPILES every graph in the workspace. A tick with nothing due should cost a listing
  // and a fold per run in view, and no compiles at all.
  let index: ReadonlyMap<string, RunGraph> | undefined;
  for (const row of visible) {
    const p = await ws.engine.projection(row.runId);
    if (p === undefined || p.status !== "running") continue;
    // A TASK THAT IS READY AND NOT HOLDING OFF. `retryAfter === undefined` is the submitted-
    // never-driven case the dispatcher's withholding creates; `retryAfter <= now` is the
    // backoff case this clock was written for. See the header for the three things that keep
    // the wider predicate from fighting a live driver.
    //
    // AND A TASK WHOSE HOLDER IS GONE, which is the other half and used to be excluded here.
    //
    // A plane that dies BETWEEN `task.leased` and `task.committed` leaves that task `leased` in
    // the journal forever — the state only advances when its holder commits, and its holder is
    // gone. Such a run is `running` with no `ready` task, so the `ready`-only predicate was
    // false at every tick from here to the heat death of the deployment. Measured on a real
    // crash (`loom serve`, a tool node with a declared `timeoutMs`, `kill -9` between the lease
    // and the commit, then a fresh plane over the same SQLite journal): 42 seconds, ~84 ticks
    // at `--sweep-ms 500`, `status=running tasks=[('slow@root#0','leased')]`, never driven.
    //
    // WIDENING IT DOES FIX IT NOW, AND DID NOT BEFORE — the comment that stood here said the
    // opposite, correctly, for as long as it was true. `InProcessScheduler` gained a reclaim
    // arm that takes back a lease past the NODE'S OWN declared deadline, and `#advanceSerially`
    // now asks `select` BEFORE deciding a run is over, so driving such a run reaches it. The
    // engine also no longer FINISHES a run that still holds a lease, which is what makes this
    // predicate safe to widen: a tick that drives a run whose lease is live — held by this
    // process, or by a peer replica — folds it, selects nothing and returns, where before the
    // widening would have declared that run `failed` while its worker was still working.
    //
    // SO THE DEADLINE IS NOT TESTED HERE. It is the scheduler's question, asked with the
    // `#handedOut` set this file cannot see; duplicating it would be a second spelling of one
    // predicate, which is how `#immediateReduce` and `#foldJoin` came to disagree.
    //
    // AND THE COST OF BEING WRONG IS A WHOLE-WORKSPACE COMPILE PER TICK, not the "one extra
    // fold" this comment first claimed. A run that is due and cannot progress reaches
    // `graphsByHash` below every time — measured on 31 published graphs, 2.0-2.3 ms per tick
    // against 0.1-0.4 ms before, forever, and it scales with the WORKSPACE rather than with the
    // stranded run. It bites two shapes: a run whose graph hash no longer resolves, and one
    // whose leased node is a `join`, `router`, `human_gate` or `subgraph`, the four the
    // scheduler will not adjudicate. TODO.md §A0.12 has the measurement and why both cheap
    // fixes are wrong.
    const due = Object.values(p.tasks).some(
      (t) => (t.state === "ready" && (t.retryAfter === undefined || t.retryAfter <= now)) || t.state === "leased",
    );
    if (!due) continue;
    index ??= graphsByHash(ws).index;
    const wanted = await ws.engine.compiledGraphHash(row.runId);
    const graph = wanted === undefined ? undefined : index.get(wanted);
    if (graph === undefined) continue;
    ws.engine.attach(row.runId, graph);
    await ws.engine.rehydrateGates(row.runId);
    await drive(row.runId);
  }
  return { visited: visible.map((r) => r.runId), pages };
}

/**
 * EVERY LONG-LIVED MUTABLE CONTAINER IN THIS FILE, AND WHAT LOSING ONE COSTS.
 *
 * The sweep TODO.md §A.16 asked for, done once and written down here so the next reader
 * inherits the answers instead of re-deriving them. The unit is the PRODUCER and not the
 * FIELD — that is the generalisable lesson `oversight-survives-restart.test.ts` states, and
 * the reason is mechanical: a restore arm belongs to whatever BUILDS the container, so a
 * per-field audit finds one field and misses its sibling in the same closure.
 *
 * HOW THE SET WAS CLOSED, because "every" is a claim that has to be checkable. Two passes: a
 * census of every module-level binding (`^(export )?(const|let|var|class)`), of which exactly
 * one — `workspaceOrdinal` — is mutable and the other thirty-six are frozen primitives or
 * literal tables; and every container construction (`new Map(`, `new Set(`, a mutable array
 * or object literal) checked for whether it outlives the call that built it. Everything else
 * is per-call and cannot survive anything. The question asked of each survivor is the one the
 * first non-negotiable asks: WHAT READS IT, and what does a decision do when a restart hands
 * it back empty?
 *
 *   1 · `planeWorkerId`'s `workspaceOrdinal`. Read by the lease identity, journaled into
 *       `task.leased`, consumed by `LeasedScheduler.select`'s "my own lease, take it back"
 *       arm. Empty is harmless for UNIQUENESS — the pid differs — so it costs neither
 *       correctness nor a fold. It costs a WAIT, and the measured number is at
 *       `planeWorkerId`. This is §A.17 and it is the only member whose cost is not a re-fold.
 *   2 · `fallbackFeed`'s `listeners`. Read by `FallbackAdapter`'s catch. Empty means nobody
 *       hears a fall-through until `serve` builds `providerNotice`, which happens before the
 *       socket binds. A report that decides nothing. MEMO.
 *   3 · `ObservedModelRegistry`'s `registered`/`calls` and `ObservedToolRegistry`'s `calls`.
 *       Read by `loadExtensionModules`'s "this module registered nothing" refusal and by the
 *       boot banner. Rebuilt from argv at every boot, before the workspace exists. CONFIG.
 *   4 · `startMcp`'s `clients`. Read only by teardown. Empty after a restart is CORRECT: the
 *       children died with the plane that spawned them. CONFIG.
 *   5 · `runDispatcher`'s `inFlight`. The ceiling and the dedupe set. Empty is the safe
 *       direction — fewer runs at once, never more — and costs a re-fold. Its docstring names
 *       the set that claim covers and the one it does not.
 *   6 · `providerNotice`'s `down`. Its own docstring says memo and says why. MEMO.
 *   7 · `startRunClock`'s `running` and `failing`. Memos over what to SAY; losing them costs a
 *       repeated line. The exception in this producer was `rot.offset`, which decided WHICH
 *       RUNS RAN and is gone — `run-clock-survives-restart.test.ts` is the defect it was, and
 *       is why this producer is the one already swept. `toldAboutCeiling` was a third memo
 *       here and went with the scan ceiling itself; a cursor traversal reaches every run, so
 *       there is nothing left for it to have latched.
 *   8 · `startGateClock`'s `running`, `failing`. The same latch, the same cost.
 *   9 · `armForeignGates`'s `armed`, built by `startGateClock`. A memo on `headSeq`. Losing
 *       it makes the plane do MORE work and never less: one re-fold per gated run in view.
 *       That direction is also its only repair — a run whose graph was missing when the memo
 *       first saw it is recorded as done at a `headSeq` that cannot advance (it is suspended),
 *       so publishing the graph later re-arms nothing until a restart clears the map.
 *  10 · `controlPlaneOptions`'s `graphs`, a `discoverGraphs` snapshot the plane holds for its
 *       lifetime. Rebuilt from `graphs/` at every boot. CONFIG — that a graph published AFTER
 *       boot is invisible until the next one is a staleness property, the opposite direction
 *       from this sweep's question.
 *
 * SO: ten producers, nine of which lose only work, and the tenth loses a bounded wait. The
 * `Workspace`'s own fields are deliberately not on this list — they are read-only after
 * `openWorkspace` and are rebuilt from the workspace DIRECTORY, which is the same input the
 * pre-restart plane read, so a restart cannot hand any of them back different.
 */

/**
 * HOW MANY RUNS THIS PROCESS DRIVES AT ONCE — a ceiling, never a door.
 *
 * `POST /runs` ended in a bare `void engine.advance(runId)` with nothing bounding how many of
 * those ran at once, and 60 submissions produced 60 concurrent provider calls. The answer to
 * "too much work" under one tenant is to make it WAIT, never to say no: refusing throws away
 * work the operator explicitly asked for and breaks the promise the 202 already makes in its
 * own words — "accepted means this WILL run". So there is no admission-rejected code here (the
 * one `errors.ts` names among the nine it cut under "a code arrives with its raiser" stays cut,
 * permanently, and this decision is what stops it coming back), no queue depth, no token bucket,
 * and nothing this function can answer with that means "no".
 *
 * The code is not spelled out because `test/registries.test.ts` gates it: every `E_*` token in
 * `src/` must be one `errors.ts` declares, comments included, and that gate is the reason a
 * deleted code cannot quietly re-enter the vocabulary through a docstring.
 *
 * **THE QUEUE IS NOT A DATA STRUCTURE AND THIS OBJECT DOES NOT HOLD ONE.** That is the whole
 * design. When every slot is taken, `drive` returns having done nothing; the run stays
 * `running` with a `ready` task, and `runClockTick`'s widened predicate re-derives it from the
 * journal on the next tick and offers it again. The slots and the dedupe set are process
 * memory that a restart empties — which costs at most one repeated fold, because nothing a
 * decision reads lives here.
 *
 * THE SET THAT LAST SENTENCE COVERS, since it used to read as total. It covers runs this
 * object WITHHELD: never dispatched, so their task never left `ready`, so the clock re-offers
 * them. It does NOT cover a run whose `advance` was in flight when the process died — that
 * task is `leased` in the journal and no fold makes it `ready` again. Measured, and the reason
 * it is a §B.1 cost rather than a defect of this object, at `runClockTick`'s `due` predicate.
 *
 * WHAT IT DOES WHEN IT CANNOT DECIDE: it does not dispatch. The undecidable case is "I cannot
 * tell whether that slot released" — an `advance` whose promise never settles — and the slot
 * is then never released. The failure mode is a box that runs FEWER runs at once, never more,
 * and the recovery that makes withholding safe rather than terminal is the clock. This object
 * reaches no authorization decision, so there is no permission it could grant by defaulting.
 *
 * WHAT IT IS NOT FAIR ABOUT, said plainly: nothing here chooses BETWEEN waiting runs. The
 * clock's rotation is bounded-lap fair and explicitly not fair against a stream of new
 * submissions, so a run pushed below a passing window waits a further lap while newer runs are
 * driven immediately. That is a scheduling policy nobody chose, and it is the honest cost of
 * putting the bound here rather than in `Scheduler.select` — which is the theoretically right
 * home and is closed today: `SelectInput` carries exactly one `projection` and one `graph`, so
 * a `Scheduler` cannot be asked a cross-run question at all.
 */
export function runDispatcher(
  /**
   * THE ONE METHOD IT USES, not the whole `Workspace` — so a test can drive this with an
   * `advance` it controls rather than with a run. A `Workspace` satisfies it structurally, and
   * the narrower type is what makes "the slot is released in a `finally`" checkable at all: the
   * assertion needs a promise the test settles, and there is no run whose completion a test can
   * hold open without reading a clock.
   */
  ws: { readonly engine: { advance(runId: RunId): Promise<unknown> } },
  max: number,
  onError: (runId: RunId, e: unknown) => void,
): { drive(runId: RunId): void; readonly inFlight: number } {
  // ONE SET, NOT A COUNTER. A counter and a dedupe set can disagree, and the way they disagree
  // is a leaked slot that never comes back — a box that quietly stops driving anything.
  const inFlight = new Set<RunId>();
  return {
    get inFlight() {
      return inFlight.size;
    },
    drive: (runId: RunId): void => {
      if (inFlight.has(runId)) return;
      // FULL MEANS WAIT, and waiting is spelled "do nothing". The clock re-offers this run.
      if (inFlight.size >= max) return;
      inFlight.add(runId);
      void ws.engine
        .advance(runId)
        .catch((e: unknown) => {
          // THE LAST FRAME, the same one `POST /runs` documents: this runs inside a `.catch`
          // on a promise nobody awaits, so a throw here is an unhandled rejection and the
          // process. `onError` is deployment code from here — it writes to stderr, and a
          // `name`/`message` getter that traps is a real shape — so it is contained.
          // Measured before this `try` existed: a reporter that threw took the whole test
          // runner down with `unhandledRejection`, from a dispatcher whose only job is to
          // hold a number.
          try {
            onError(runId, e);
          } catch {
            // Nothing above this frame can be told anything, and taking the process down to
            // report that a report failed is strictly worse than the silence.
          }
        })
        // RELEASED IN A `finally`, not in the `catch` above and not in a `.then`: both of
        // those are skipped on one of the two settle paths, and a slot held by a settled
        // promise is the one leak this shape can have — the one that ends with a box driving
        // nothing at all. What it CANNOT release is a slot whose `advance` never settles, and
        // that is the undecidable case this object answers by not dispatching: fewer runs at
        // once, never more, with the run clock as the recovery.
        .finally(() => {
          inFlight.delete(runId);
        });
    },
  };
}

/**
 * THE OPERATOR CAN SEE THAT THEIR PRIMARY IS DEAD. **THIS THING DECIDES NOTHING.**
 *
 * Say that first because the shape invites the opposite reading. There is no circuit breaker
 * here and there is not going to be one: no `SourceHealth`, no `source.withheld` event, no
 * source-unhealthy error code (unspelled for the reason `runDispatcher` gives — the code
 * registry gate reads comments too, which is what keeps a refused vocabulary refused), no
 * `BreakerAdapter`. A breaker reads a per-source failure count that
 * spans runs, and `StateStore.read(runId, fromSeq)` is why that cannot exist — the journal is
 * authoritative PER RUN, so a decision keyed on a cross-run fact is a decision no fold can
 * reconstruct. That is the first non-negotiable, and it is the reason the breaker is refused
 * rather than deferred.
 *
 * WHAT THE MEASUREMENT ACTUALLY FOUND, because the backlog's claim was false. TODO.md §Z (D.19, refused 2026-08-28) said
 * "a source that is failing every call is retried at full rate"; at HEAD a dead provider costs
 * 3 engine attempts x 3 `postJson` attempts = 9 requests and about 2.25 s of held slot, and
 * then the run FAILS naming `E_PROVIDER_OVERLOADED`. Nothing is retried forever. Two real
 * facts survive that correction, and this function exists for the second:
 *
 *   1. `FallbackAdapter` is stateless by construction — `stream()` enters tier 0 on every call
 *      and falls through only on a throw — so with a chain configured, a dead primary costs
 *      three wasted requests and ~750 ms of a worker slot on EVERY model turn, forever.
 *   2. **The operator is told none of it.** Runs still succeed. Half of them take the slow
 *      path. Nothing in the process says so, and property 3's bar — a later run measurably
 *      better because of an earlier one — cannot be met by somebody who cannot see that.
 *
 * A LATCH, NOT A LOG. One line on the transition INTO failure and one on recovery, in the
 * shape `startRunClock`'s `failing` latch already uses, because a line per turn is how an
 * operator learns to stop reading stderr — which is where every honest line in this file
 * lives.
 *
 * TWO FEEDS, because a deployment with no chain has the same problem and produces no
 * fall-throughs. `onFallback` covers the chain case with the model id in hand; a cross-run
 * `effect.failed` subscription covers the rest. The two are keyed apart on purpose:
 * `effect.failed` carries `{key, error}` and NO model id — measured, `journal/events.ts:321` —
 * so the no-chain half can only honestly key on the error CODE, and pretending otherwise would
 * put a model name in a line that was never told one.
 *
 * ITS LATCH IS A MEMO AND NOT STATE A DECISION READS. After a restart it is empty, which costs
 * at most one repeated down-line; the subscription is `drop_oldest`, so under load it can miss
 * a recovery and say nothing rather than say something false. Neither can withhold a call or
 * permit one.
 *
 * STOPPED BY THE CALLER, and `serve` stops it in the same closure that stops both clocks — a
 * second un-stopped subscriber is the defect `startRunClock`'s own comment names.
 */
export function providerNotice(
  ws: { readonly bus: EventBus; readonly models: { readonly fallbacks: FallbackFeed } | undefined },
  write: (line: string) => void = (line) => void process.stderr.write(line),
): { stop(): void } {
  /** `chain:<model>` for a fall-through, `direct:<code>` for a model effect that failed. */
  const down = new Set<string>();
  const fell = (from: string, to: string, code: string, message: string): void => {
    if (down.has(`chain:${from}`)) return;
    down.add(`chain:${from}`);
    write(
      `! PRIMARY MODEL "${from}" IS FAILING — every turn falls through to "${to}" (${code}: ${message}).\n` +
        `  Runs still succeed. The chain is STATELESS, so each turn pays the failed call first and keeps paying it\n` +
        `  until the primary recovers or you edit the --models-file.\n`,
    );
  };
  const failed = (code: string, message: string): void => {
    if (down.has(`direct:${code}`)) return;
    down.add(`direct:${code}`);
    write(`! MODEL CALLS ARE FAILING — ${code}: ${message}. No fallback chain is configured for the route that raised it.\n`);
  };
  const succeeded = (model: string): void => {
    const was = down.size;
    down.delete(`chain:${model}`);
    // ANY SUCCESSFUL TURN RETRACTS EVERY CODE-KEYED LINE, because a code is not a source: the
    // line said "model calls are failing" and a model call just succeeded, so the claim is
    // spent. A model-keyed line is retracted only by ITS OWN model succeeding.
    for (const k of [...down]) if (k.startsWith("direct:")) down.delete(k);
    if (down.size !== was) write(`! model calls recovered — "${model}" answered\n`);
  };

  const unsubscribe = ws.models?.fallbacks.subscribe((from, to, e) => fell(from, to, e.code, e.message));
  // CROSS-RUN BY TYPE. `EventFilter.runId` is optional, so a subscription that spans runs is
  // already expressible — it is the READ that spans runs, which grants nothing, and not a
  // durable fact a decision consults.
  const sub = ws.bus.subscribe(
    { types: ["effect.failed", "model.called"] },
    // `drop_oldest`, because losing a line is the correct failure for a memo. `close` would
    // cut the subscription on the first burst and this reporter would then be silent forever,
    // which is the one outcome it exists to prevent.
    { queueSize: 256, onOverflow: "drop_oldest" },
  );
  void (async () => {
    try {
      for await (const ev of sub) {
        if (isEvent(ev, "model.called")) {
          succeeded(ev.payload.model);
          continue;
        }
        if (!isEvent(ev, "effect.failed")) continue;
        // `effectKey(task, kind, ordinal)` is `${task}:${kind}:${ordinal}`, so the kind is the
        // second-to-last segment. A tool or a subgraph failing is not this reporter's subject.
        const parts = ev.payload.key.split(":");
        if (parts[parts.length - 2] !== "model") continue;
        failed(ev.payload.error.code, ev.payload.error.message);
      }
    } catch {
      // A cut subscription ends the report and nothing else. `SubscriberOverflowError` is the
      // only thing this loop can be thrown, and the recovery for a memo is to say less.
    }
  })();

  return {
    stop: () => {
      unsubscribe?.();
      sub.dispose();
    },
  };
}

function startRunClock(ws: Workspace, everyMs: number, limit: number, drive?: (runId: RunId) => void): { stop(): void } {
  let running = false;
  let failing = false;
  // NOTHING IS CARRIED ACROSS TICKS, and that is the point. This closure used to hold
  // `const rot = { offset: 0 }` — process memory that decided which runs got advanced, rebuilt
  // at every boot, reconstructed by nothing. `failing` below is a memo over what to SAY, not
  // over what to do: losing it costs a repeated line, not a starved run.
  //
  // `toldAboutCeiling` used to sit here beside it, latching the one line an operator got when
  // the scan ceiling hid their oldest runs. It is gone with the ceiling: a traversal reaches
  // every run, so there is no size at which this process starts quietly skipping work and
  // nothing left for that line to warn about.
  const tick = (): void => {
    if (running) return;
    running = true;
    void (async () => {
      // ITS OWN PERIOD AS THE LAP, so one tick advances the traversal by exactly one page.
      await runClockTick(ws, limit, Date.now(), everyMs, drive);
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
/**
 * How many gate-door lines the boot banner prints before summarising the rest.
 *
 * A bound and not a taste: `announce`'s whole job is to name the guards that are off, and a
 * plane serving fifty gated graphs would print a page — which an operator skips, making the
 * report exactly as useful as the silence it replaced. `checkToolNames` bounds its
 * suggestion list for the same reason.
 */
const MAX_BANNER_GATES = 10;

function announce(
  plane: ControlPlane,
  ws: Workspace,
  opts: ControlPlaneOptions,
  sweepMs: number,
  bound: { readonly port: number; readonly host: string; readonly loopback: boolean },
  maxRunsInFlight: number,
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
  // WHAT WAS LOADED INTO THIS PROCESS, named at boot for the reason `--allow-exec` is: it is
  // host-realm code the operator asked for, holding everything this binary holds, and a
  // deployment that has it and one that does not are materially different things. Read off
  // the loaded object rather than off the flag, so no line can name a module that did not
  // register what it said it would.
  //
  // PRINTED HERE, EARLY, AND THAT IS A FACT ABOUT THE TEST HARNESS. `test/deployment/harness.ts`
  // returns from `serving` as soon as every key in its named `BANNER_KEYS` set has arrived, and
  // this line is CONDITIONAL so it cannot join that set — a plain `loom serve` never prints it
  // and the wait would hang. Emitted before the last named key (`models:`), it can never be the
  // line still in flight when a caller reads stdout.
  const ext = ws.extensions;
  if (ext !== undefined) {
    process.stdout.write(
      `  ext:    ${ext.files.join(", ")} → ` +
        `${[...ext.adapters.keys()].map((n) => `adapter ${n}`).join(", ") || "no adapters"}` +
        `${ext.toolNames.length === 0 ? "" : `, ${ext.toolNames.map((n) => `tool ${n}`).join(", ")}`}` +
        // APPENDED, not inserted, and the `no adapters` head stays first: `extension-module.test.ts`
        // pins the whole line, and the two new seams are absent from most modules — a module that
        // registers neither prints exactly what it printed before.
        `${ext.channelNames.length === 0 ? "" : `, ${ext.channelNames.map((n) => `channel ${n}`).join(", ")}`}` +
        `${ext.identity === undefined ? "" : `, identity ${ext.identity.name}`}\n`,
    );
  }
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
  // THE ARITHMETIC, NOT THE TWO NUMBERS. `4 x 16` is a pair of flags an operator set; `at most
  // 64 concurrent provider calls` is the thing they were trying to decide, and the multiplication
  // is where this file has the numbers and they do not. Both are read off the constructed
  // Workspace, per this function's own rule, so no line can promise a ceiling the running
  // process does not hold. `--max-runs-in-flight` is a CEILING and never a door: nothing is
  // refused, the surplus waits for the run clock.
  //
  // BEFORE the `clock:` line and not after it, which is a fact about the TEST HARNESS and is
  // worth stating because it is otherwise invisible. `test/deployment/harness.ts`'s `serving`
  // waits for `  clock:` before returning, and the caller then SIGINTs the child — so every
  // line printed after it is racing the shutdown. Adding one there made
  // `cli.test.ts`'s callback-banner assertion flake on its first run.
  const ceilings = [
    ws.budget?.runUsd === undefined ? undefined : `$${ws.budget.runUsd.toFixed(2)}`,
    ws.budget?.runTokens === undefined ? undefined : `${ws.budget.runTokens} tok`,
    ws.budget?.runWallMs === undefined ? undefined : `${ws.budget.runWallMs} ms`,
  ].filter((s): s is string => s !== undefined);
  process.stdout.write(
    `  limits: ${maxRunsInFlight} runs driven at once x ${ws.maxParallelism} parallel nodes = at most ` +
      `${maxRunsInFlight * ws.maxParallelism} concurrent provider calls; run ceilings: ` +
      `${ceilings.length === 0 ? "(none — only what each graph declares)" : ceilings.join(" / ")}\n`,
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
    // SPLIT BY ORIGIN HERE TOO, and the reason is sharper than the base-URL split below: this
    // line names a CREDENTIAL and tells the operator to rotate it. `A secret in <channels file>
    // is a credential` was printed unconditionally, so on a plane whose only ANSWERABLE channel
    // came from an `--extension-module` it named a file that holds no secret for that channel —
    // and on a mixed plane it still does, because the file row that IS in it is notify-only.
    // "Rotate the wrong thing" is worse than saying nothing: the operator believes they closed
    // the hole. Driven with one notify-only file row plus one module channel carrying
    // `parseCallback`, which is the smallest configuration that has both halves.
    //
    // THE HMAC CLAIM MOVED WITH IT. It is true of `SignedWebhookChannel` — the one transport
    // this binary builds from a file row — and it is a guess about a module's `parseCallback`,
    // which may check anything or nothing. What is true of every answerable channel is that the
    // bearer check does not apply, so that is what the shared header says.
    const answerableFromFile = delivery.answerable.filter((n) => !delivery.fromModules.includes(n));
    const answerableFromModule = delivery.answerable.filter((n) => delivery.fromModules.includes(n));
    // WHERE THE MODULES ARE, read off `ws.extensions` rather than off `delivery.file`, which is
    // the module paths ONLY when there is no channels file — the exact case this split exists
    // for is the one where it is not.
    const moduleFiles = ws.extensions === undefined ? delivery.file : ws.extensions.files.join(", ");
    process.stderr.write(
      `! CALLBACK ROUTE OPEN — POST /runs/:id/callbacks/:channel accepts decisions WITHOUT the bearer token,\n` +
        `  on: ${delivery.answerable.join(", ")}. The bearer check does not apply to that route, so whatever the\n` +
        `  channel itself checks about the request is the ONLY authentication it has.\n` +
        (answerableFromFile.length === 0
          ? ""
          : `  ${answerableFromFile.join(", ")}: an HMAC signature over the raw request body, keyed by "callbackSecret" — so a\n` +
            `  leaked secret approves production actions. A secret in ${delivery.file} is a credential — rotate it the\n` +
            `  way you would rotate --token.\n`) +
        (answerableFromModule.length === 0
          ? ""
          : `  ${answerableFromModule.join(", ")}: registered by an --extension-module, so its parseCallback(req) is what\n` +
            `  authenticates a callback and this binary cannot say what that checks. Whatever credential it is, it lives\n` +
            `  in ${moduleFiles} and not in a channels file.\n`),
    );
    // Configured to be answered, and no address published: every receiver still has to be
    // told the URL out of band, which is the thing having a callback route was meant to fix.
    //
    // SPLIT BY WHERE THE ANSWERABLE CHANNELS CAME FROM, because the fix is a JSON key and a
    // module's channel has no row to put it in. Telling an operator to edit a file that does
    // not describe their channel is a fix that cannot be applied, which is the failure mode
    // this banner exists to avoid — and for a module channel the fact is not "no address" at
    // all, it is that this process cannot see one either way.
    if (!delivery.publishesAddress) {
      if (answerableFromFile.length > 0) {
        process.stderr.write(
          `! NO CALLBACK BASE URL — delivered gates carry no address to answer at, so each receiver must still be\n` +
            `  told this deployment's URL out of band.\n` +
            `  on: ${answerableFromFile.join(", ")}\n` +
            `  fix: add "callbackBaseUrl": "https://<this deployment's public origin>" to ${delivery.file}\n`,
        );
      }
      if (answerableFromModule.length > 0) {
        // `moduleFiles` AND NOT `delivery.file`. This line was written against a module-only
        // plane, where `delivery.file` IS the module paths; add one `--channels-file` row and it
        // became the channels file, so the sentence told the operator the address was decided
        // inside a JSON file that does not mention the channel. That is the same wrong-door
        // failure the split above it exists to prevent, one line further down.
        process.stderr.write(
          `! CALLBACK ADDRESS NOT VISIBLE — ${answerableFromModule.join(", ")} was registered by an --extension-module, so whether a\n` +
            `  delivered gate carries an address to answer at is decided inside ${moduleFiles} and cannot be read from here.\n` +
            `  This line is not a claim that no address is published; it is this binary saying it cannot tell.\n`,
        );
      }
    }
  } else if (delivery !== undefined) {
    // Nothing answerable anywhere. Gates are delivered and cannot be answered where they
    // were delivered, which is a configuration an operator can easily believe is complete.
    //
    // THE FIX DEPENDS ON WHERE THE CHANNELS CAME FROM, and it used to be the file's one
    // unconditionally: driven against a module-only plane, this line told an operator to add
    // `"callbackSecret"` to a `.mjs`. For a file row the secret IS the switch — it selects
    // `SignedWebhookChannel` — and for a module channel the switch is `parseCallback`, which
    // is what `DeliveryChannel`'s own docstring calls the test for "this channel can be
    // answered". Two mechanisms, and naming the wrong one is a fix that cannot be applied.
    //
    // AND THE HEADER NAMES THE CHANNELS RATHER THAN A FILE. `every channel in <channels file>`
    // is false the moment a module registers one: on a mixed plane it claimed a set membership
    // for a channel with no row in that file. The set it means is "every channel this plane
    // has", which is what it now says — and it lists them, because a claim that names its
    // members is one a reader can check.
    const everyChannel = [...delivery.answerable, ...delivery.notifyOnly];
    const anyFromFile = everyChannel.some((n) => !delivery.fromModules.includes(n));
    process.stderr.write(
      `! NO ANSWERABLE CHANNEL — every channel this plane has is notify-only, so there is no callback route\n` +
        `  and a gate can only be answered through the API or the CLI.\n` +
        `  on: ${everyChannel.join(", ")}\n` +
        (anyFromFile ? `  fix: give a channel in ${delivery.file} a "callbackSecret" to make it answerable\n` : "") +
        (delivery.fromModules.length === 0
          ? ""
          : `  fix: ${delivery.fromModules.join(", ")} came from an --extension-module — give that channel a parseCallback(req),\n` +
            `       which is the whole test for "this channel can be answered"\n`),
    );
  }
  // WHO CAN ANSWER WHICH GATE, said per GATE rather than per graph, and with three verdicts
  // rather than a boolean.
  //
  // The two lines this replaces were both suppressions: `opts.dispatcher === undefined ? … :
  // []` here, and `if (opts.identity !== undefined) return []` one level down. Each fell
  // silent in exactly the case it could not decide — the comment above the first one even
  // conceded that whether a channel's subject mapping produces the subjects a graph named
  // "is not visible from there", and then answered that undecidable case with the empty
  // list. A report that grants nothing has no passing value available to it, so the only
  // honest move was to name what it cannot see.
  //
  // THERE IS NO SEPARATE "REACHABILITY NOT CHECKED" BANNER, and that is a decision. It was
  // written, and then deleted before it shipped, on the argument that from THIS BINARY it
  // could never fire: `--identity-file` was the only flag that established who a caller is,
  // it builds a `BearerTokenIdentity`, and that source enumerates.
  //
  // **THAT ARGUMENT IS NOW FALSE, AND THE DECISION IT SUPPORTED IS STILL RIGHT.** An
  // `--extension-module` may register an OIDC or proxy-header source, and such a source
  // legitimately cannot list its population — so the case reaches this binary. Driven, on a
  // module registering a source called `proxy-header` with no `knownSubjects`:
  //
  //     ! CANNOT TELL — root/gate names u:alice: proxy-header cannot enumerate its subjects,
  //       so whether any of u:alice can hold a credential is unknown here
  //
  // Which is the point: the fact was never lost, it is reported PER GATE with the source
  // named, by the same `gateAnswerability` call a library embedder's plane makes. A separate
  // banner would have said the same thing once, less precisely. What changed is that this
  // paragraph's reason has to be "the per-gate report already covers it" rather than "no path
  // reaches it", because a path now does.
  const doors = gateAnswerability(opts);
  const trouble = doors.filter((d) => d.verdict !== "answerable");
  // BOUNDED, the way `checkToolNames` bounds its suggestion list: a plane serving many gated
  // graphs would otherwise print a page nobody reads, which is the same failure as printing
  // nothing.
  for (const d of trouble.slice(0, MAX_BANNER_GATES)) {
    process.stderr.write(
      `! ${d.verdict === "no-door" ? "NO DOOR" : "CANNOT TELL"} — ${d.graph}/${d.nodeId} names ${d.approvers.join(", ")}: ${d.why}\n`,
    );
    // THE TWO CHANNEL FACTS `announce` HELD AND NEVER CROSS-REFERENCED. It has had
    // `opts.graphs` and `delivery.answerable`/`notifyOnly` in the same scope all along; what
    // was missing is the join. A channel the dispatcher has never heard of is not a delivery
    // failure at boot and is not a compile error either — `checkDelivery` deliberately does
    // not check channel names, because a dispatcher is built by the deployment — so this is
    // the only place the graph and the deployment are both in view.
    if (d.unknownChannels.length > 0) {
      process.stderr.write(
        `    ${d.unknownChannels.join(", ")}: delivered nowhere but the console fallback — no channel of that name in ${ws.delivery?.file ?? "this deployment"}\n`,
      );
    }
    if (d.notifyOnlyChannels.length > 0) {
      process.stderr.write(`    ${d.notifyOnlyChannels.join(", ")}: delivered there, not answerable there\n`);
    }
  }
  if (trouble.length > MAX_BANNER_GATES) {
    process.stderr.write(`  …and ${String(trouble.length - MAX_BANNER_GATES)} more gate(s) in the same state\n`);
  }
  if (trouble.length > 0) {
    process.stderr.write(
      `  fix: loom serve --identity-file <file> with {"subjects":[{"subject":"u:you","token":"..."}]}\n` +
        `   or: loom serve --channels-file <file> with a channel that has a "callbackSecret", so the approver answers through it\n` +
        `   or: nothing — \`loom approve <runId> <gateId> --as <subject>\` answers any gate from this machine, and it\n` +
        `       authenticates nobody by construction: the subject it writes into the journal is whatever --as said.\n`,
    );
  }
}

/**
 * Wait for a stop signal, stop, and RETURN WHAT A SUPERVISOR SHOULD BELIEVE.
 *
 * The exit code is the only thing anything above this process reads. `serve` used to
 * print `! SHUTDOWN INCOMPLETE — close() failed: …` and then return **0**, so the one
 * channel a supervisor listens on said the process had stopped cleanly, one line after the
 * process said it had not. systemd, a container runtime and a `&&` in a shell script all
 * act on that; none of them re-reads stderr to find out whether the 0 was true.
 *
 * **1, and the argument against the alternatives is the content of this decision.**
 * `main`'s vocabulary is already fixed: 0 is "what you asked for happened" (`run`
 * succeeded, `replay` matched, `trace` conformed AND — when `--otlp` was given — exported),
 * 1 is "it did not", 2 is "there is no such command", and the entry point at the bottom of
 * this file exits 1 for any thrown error. The `trace` clause grew a member when `--otlp`
 * landed, and it is spelled out here rather than left implied: this parenthetical is an
 * enumeration, and an enumeration is only as good as its discipline about growing. A shutdown that left a socket bound is "it did not". **130** — the 128 + SIGINT
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
 *
 * **SIGTERM IS THE ONE A SUPERVISOR ACTUALLY SENDS, and it used to reach no handler here at
 * all.** `systemctl stop`, `docker stop`, a Kubernetes eviction and a plain `kill` all send
 * SIGTERM, and at Node's default disposition that ends the process where it stands: no
 * `plane.close()` so in-flight requests are cut rather than drained, no `clock.stop()`, and
 * `main`'s `finally` — which closes the MCP children and the SQLite store — never runs.
 * Measured before this line existed: `kill -TERM` on `loom serve` exited **143**, a code
 * outside the 0/1/2 vocabulary above, so a supervisor configured to restart on failure read a
 * deliberate stop as a crash. The two signals mean the same thing to this process, so they get
 * the same handler and the same exit code; the argument for 0-or-1 over 128+n is unchanged and
 * is the paragraph above.
 *
 * BOTH LISTENERS ARE REMOVED WHEN EITHER FIRES, for the reason the single one was removed:
 * a caller that returns having left a listener on `process` has leaked one, and a SIGINT
 * arriving after a SIGTERM has already settled the promise would call `resolveCode` on a
 * promise nobody is waiting on and close a plane that is already closed.
 */
const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export async function serveUntilInterrupt(plane: { close(): Promise<void> }, clock: { stop(): void }): Promise<number> {
  return new Promise<number>((resolveCode) => {
    const onStop = (): void => {
      let incomplete = false;
      void plane
        .close()
        .catch((e: unknown) => {
          incomplete = true;
          process.stderr.write(`! SHUTDOWN INCOMPLETE — close() failed: ${toLoomError(e).message}\n`);
        })
        .finally(() => {
          clock.stop();
          for (const sig of STOP_SIGNALS) process.removeListener(sig, onStop);
          resolveCode(incomplete ? 1 : 0);
        });
    };
    for (const sig of STOP_SIGNALS) process.on(sig, onStop);
  });
}

// ---------------------------------------------------------------------------

/**
 * `fetchImpl` is `openWorkspace`'s injection seam, one step further out — and it exists for the
 * reason that one's docstring already names.
 *
 * `openWorkspace` takes `env` so a test can supply a credential without writing one into the
 * process, and `fetchImpl` so a `--models-file` adapter can be exercised without reaching the
 * network. `main` threaded neither, so the only door a test could drive END TO END was one with
 * no adapter at all — "every `--models-file` test called `adapter.stream` directly and none ran
 * a graph". That was tolerable while every verb was offline. `promote --against-cohort` is not:
 * its whole subject is what a provider answers, and a mode whose only test bypasses `main` is a
 * mode nobody has driven through the door people use.
 *
 * It changes nothing for `bin/loom`, which passes one argument and gets `undefined` — the real
 * `fetch`. It is not a way to make the live mode offline in production: the adapter still has to
 * be declared in a `--models-file`, and `promoteAgainstCohort` refuses when there is none.
 */
export async function main(argv: readonly string[], fetchImpl?: HttpOptions["fetch"]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "help" || args.flags["help"] === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  // AFTER `help`, so `loom --help` still prints the list a reader needs to fix the typo.
  assertKnownFlags(args);
  // AFTER `assertKnownFlags`, so a MISSPELLED flag is answered by the list of flags rather than
  // by a list of verbs that do not read it either.
  refuseFlagsThisVerbDoesNotRead(args);

  // STARTED BEFORE THE WORKSPACE, because the grant list is derived inside it and a tool
  // registered afterwards is a tool whose capability nobody holds — see `openWorkspace`'s `mcp`
  // parameter.
  const mcpServers = args.flags["mcp-file"] === undefined ? [] : readMcpServers(requireFileFlag(args, "mcp-file"));
  // BEFORE THE CONNECT, so an operator sees what they declared even when a server fails to start.
  for (const line of mcpLoweringWarnings(mcpServers)) process.stderr.write(line);
  const mcp = mcpServers.length === 0 ? [] : await startMcp(mcpServers);
  // THE CHILDREN ARE CLOSED FROM TWO PLACES BECAUSE THERE ARE TWO WAYS OUT, and until this
  // existed there was one. `main`'s `finally` closes them when the workspace has been opened;
  // everything between `startMcp` and `openWorkspace` returning is a refusal path that used to
  // leave every spawned server running and reparented to PID 1. `loadExtensionModules` throws on a
  // module that registers nothing, and `openWorkspace` refuses eight ways (`--max-parallelism 0`,
  // a bad `--egress`, `--models-file`, `--channels-file`, `--budget-usd`, `--workspace`) —
  // measured, one orphan per refusal, so the fail-closed path was the expensive one and an
  // operator iterating on a config accumulated them. One function so the two exits cannot drift.
  const closeMcp = (): void => {
    for (const c of mcp) c.client.close();
  };
  let ws: Workspace;
  try {
    // BEFORE THE WORKSPACE, for the reason `mcp` is and one reason more: `openWorkspace` reads
    // `--models-file` on its first line, and a `routes` row may name an adapter an extension
    // module registered. `await import()` is why this cannot happen inside that function.
    //
    // ONLY IN `main`. `--extension-module` is argv and nothing else — no file, no resource ref,
    // no directory scan — which is the entire trust argument at `loadExtensionModules`.
    //
    // AND A REPEAT IS REFUSED, not resolved last-wins: see `refuseRepeated` for the measurement.
    refuseRepeated(
      args,
      "extension-module",
      "a module named on argv would not be loaded, and the plane would come up as a deployment " +
        "the operator believes is extended and is not.",
    );
    const extensionPaths = listFlag(args, "extension-module", "a module path", NO_MODULE_CALLED_TRUE);
    const extensions = extensionPaths === undefined ? undefined : await loadExtensionModules(extensionPaths);
    ws = openWorkspace(args, process.env, fetchImpl, mcp, extensions);
  } catch (e) {
    closeMcp();
    throw e;
  }
  try {
    switch (args.command) {
      case "compile": {
        const compiled = loadGraph(ws, requirePositional(args, 0, "a graph file"));
        process.stdout.write("ok\n");
        printRetryPlan(compiled);
        printTimeoutPlan(compiled);
        return 0;
      }

      case "serve": {
        // Every refusal is spent before the socket exists: the plane's own, in its
        // constructor, and the clock's, the port's and the dispatcher's bound, here.
        const inFlight = boundedCount(args.flags["max-runs-in-flight"], "--max-runs-in-flight", DEFAULT_MAX_RUNS_IN_FLIGHT, MAX_CONCURRENCY);
        // ONE DISPATCHER FOR BOTH DRIVERS, and that is the point of building it here rather
        // than inside either. `POST /runs` and the run clock are the two things in this
        // process that call `advance`, and a bound each would be two bounds — the box's real
        // ceiling would be their sum, which is not a number anybody set.
        const dispatch = runDispatcher(ws, inFlight, (runId, e) => {
          // THE SAME SINK THE 202 USED TO WRITE TO, moved here so both drivers share it.
          // `advance` is called by nobody who can be told, so the operator is the only
          // audience — and the line names the recovery, because there is one: the run clock
          // comes back for this run on its next tick, and `POST /runs/:id/commands
          // {"kind":"advance"}` is the manual door.
          process.stderr.write(
            `! run ${runId} FAILED TO ADVANCE: ${(e as Error).message}\n` +
              `  Its journal is intact. The run clock re-derives it from the journal and will offer it again;\n` +
              `  POST /runs/${runId}/commands {"kind":"advance"} drives it by hand.\n`,
          );
        });
        const opts: ControlPlaneOptions = { ...controlPlaneOptions(ws, args), drive: dispatch.drive };
        const everyMs = gateClockInterval(args);
        const wanted = httpPort(args);
        const wantedHost = httpHost(args);
        const plane = new ControlPlane(opts);
        const bound = await plane.listen(wanted, wantedHost);
        const clock = startGateClock(ws, everyMs);
        // THE SAME `drive`, so the clock cannot outrun the ceiling the plane holds — and so a
        // run the plane is already driving is deduped rather than folded twice.
        const runs = startRunClock(ws, everyMs, DEFAULT_RUN_CLOCK_LIMIT, dispatch.drive);
        // THE THIRD THING WITH A TEARDOWN, and it decides nothing — see `providerNotice`. It
        // exists because a configured fallback chain degrades SILENTLY and indefinitely: the
        // runs succeed, half of them take the slow path, and until this line nothing in the
        // process said so.
        const providers = providerNotice(ws);
        announce(plane, ws, opts, clock.everyMs, bound, inFlight);
        // SIGINT IS AN EVENT HANDLER, so nothing above it catches, and its exit code is
        // the only thing a supervisor reads. Both facts live in `serveUntilInterrupt`,
        // which returns what this command should exit with — see its docstring for why a
        // failed shutdown is 1 and not 0 and not 130.
        // BOTH CLOCKS STOP, AND SO DOES THE PROVIDER REPORTER. `serveUntilInterrupt` takes one
        // thing to stop, and a second timer left running is a process that will not exit — the
        // `.unref()` saves it in practice and relying on that is how the first one would have
        // been missed. The reporter is not a timer, it is a BUS SUBSCRIPTION, and an
        // un-disposed one holds a queue that every appended event is copied into forever.
        return await serveUntilInterrupt(plane, {
          stop: () => {
            clock.stop();
            runs.stop();
            providers.stop();
          },
        });
      }

      case "run": {
        // BEFORE the graph is compiled: a typo in the flag should not cost a compile, and
        // more importantly it must not be diagnosed as something the graph did.
        const inputs = runInputs(args);
        const graph = loadGraph(ws, requirePositional(args, 0, "a graph file"));
        // AFTER the compile, because the declared set is what this checks against, and BEFORE
        // the submit, because a typo must not cost a journal row or a provider call. See
        // `assertDeclaredInputs`.
        assertDeclaredInputs(graph, inputs);
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
        let disarm: (() => void) | undefined;
        let p: RunProjection;
        let runId: RunId;
        try {
          ({ runId, projection: p } = await startAndDrive(
            ws,
            {
              graph,
              inputs,
              ...submitterFlag(args),
              ...(budgetUsd === undefined ? {} : { budgetUsd }),
            },
            // THE ID, AND THE INTERRUPT — see `announceRun`. The `finally` disarms even when the
            // drive throws, because a listener that outlives the run would answer the operator's
            // next Ctrl-C by cancelling a run that ended minutes ago.
            (id) => {
              disarm = announceRun(ws, id, subjectFlag(args));
            },
          ));
        } finally {
          disarm?.();
        }
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

      case "pause":
      case "resume": {
        // NEITHER NEEDS A GRAPH, for `cancel`'s reason one case up: both are a projection and
        // two appends, and the runs most worth stopping are the ones whose graph has drifted
        // out from under the process holding them.
        //
        // ONE CASE FOR BOTH, because the only difference is which method is called and every
        // other line — the runId, the `--reason` guard against a bare flag journaling the four
        // letters "true", the actor, the output — is a place the two could silently disagree.
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const raw = args.flags["reason"];
        const reason = typeof raw === "string" && raw.trim() !== "" ? raw : "operator";
        const actor = { kind: "human", subject: subjectFlag(args), via: "cli" } as const;
        const p =
          args.command === "pause"
            ? await ws.engine.pause(runId, reason, actor)
            : await ws.engine.resume(runId, reason, actor);
        // `paused` IS PRINTED AND `status` IS NOT ENOUGH. A run paused while it was waiting on
        // a gate that has since been answered reads `running` and takes no work, which is the
        // point of the pause being a fact of its own; printing only the status would tell the
        // operator the opposite of what is true.
        process.stdout.write(`${JSON.stringify({ runId, status: p.status, paused: p.paused }, null, 2)}\n`);
        return 0;
      }

      case "steer": {
        // THE ONE OPERATOR VERB THAT NEEDS THE GRAPH, and the workspace lookup is what supplies
        // it — `Engine.steer` refuses a run this process has not attached, because the declared
        // edge set it confines the operator to lives in the compiled artifact and there is
        // nothing else to check a route against.
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const nodeId = args.flags["node"];
        if (typeof nodeId !== "string" || nodeId.trim() === "") {
          throw err.validation(CODES.E_CONFIG_INVALID, "steer needs --node NODE_ID: the node whose route is being overridden");
        }
        const take = listFlag(args, "take", "one or more edge ids", NO_EDGE_CALLED_TRUE) ?? [];
        const raw = args.flags["reason"];
        const reason = typeof raw === "string" && raw.trim() !== "" ? raw : "operator";
        // BIND FIRST, or every steer on a restarted workspace answers "not attached" — which is
        // the honest answer only when the graph is genuinely absent, and here it is on disk.
        const wanted = await ws.engine.compiledGraphHash(runId);
        const found = wanted === undefined ? undefined : graphsByHash(ws).index.get(wanted);
        if (found !== undefined) ws.engine.attach(runId, found);
        const p = await ws.engine.steer(runId, { nodeId: nodeId as NodeId, take: take as EdgeId[] }, reason, {
          kind: "human",
          subject: subjectFlag(args),
          via: "cli",
        });
        process.stdout.write(`${JSON.stringify({ runId, node: nodeId, take, status: p.status }, null, 2)}\n`);
        return 0;
      }

      case "deescalate": {
        // THE ONLY VERB IN THIS FILE THAT LOWERS ANYTHING, and until it existed the human
        // half of CLAUDE.md's "oversight only tightens; a human may lower a posture" was
        // reachable from the test suite and from nowhere else. `PolicyEngine.deescalate` has
        // refused a non-human actor, three deny-lists and an empty justification since it was
        // written; `Engine.deescalate` journals `policy.deescalated`, which folds into
        // `p.ceilings` and is re-seeded by `PolicyEngine.restore`, so the ceiling survives a
        // restart and replays. What was missing was a door.
        //
        // NO FORCE FLAG AND NO WAY TO SKIP `--why`. A justification nobody typed is exactly
        // the loosening this whole path is guarded against, so the flag is required here and
        // the engine refuses a blank one again underneath.
        //
        // `--as` AUTHENTICATES NOBODY — `subjectFlag`'s own docstring states that limit, and
        // on this verb the consequence is worth restating rather than inheriting: the CLI
        // writes to the journal directly, so this command is as strong as shell access to the
        // host. Every refusal that decides anything on this path is the ENGINE's; this door
        // adds well-formedness checks and no authorization of its own.
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const scope = ceilingScope(args, runId);
        const to = postureFlag(args);
        const why = justificationFlag(args);
        // BIND FIRST, exactly as `steer` does: `Engine.deescalate` goes through `#require`, so
        // a run this process has not attached is `E_RUN_NOT_FOUND` rather than a ceiling
        // installed on a run nobody folded. A workspace that has not published the graph
        // therefore refuses, which is the honest answer and not a silent success.
        const wanted = await ws.engine.compiledGraphHash(runId);
        const found = wanted === undefined ? undefined : graphsByHash(ws).index.get(wanted);
        if (found !== undefined) ws.engine.attach(runId, found);
        const p = await ws.engine.deescalate(runId, scope, to, why, { kind: "human", id: subjectFlag(args) }, "cli");
        process.stdout.write(`${JSON.stringify({ runId, scope, ceiling: p.ceilings[scope], status: p.status }, null, 2)}\n`);
        return 0;
      }

      case "replay": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        // FOUND, NOT DEMANDED — see `recordedGraph`. `--graph` still wins and is still checked.
        const graph = await recordedGraph(ws, args, runId, "replay");
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
            // AND THE SAME PAYLOAD STORE, for the reason the two comments above give. A replay
            // re-executes into a shadow journal and compares events; an engine with no payload
            // store journals the value where the recording journaled a handle, so every run
            // that externalised anything reported `match: false` about itself.
            payloads: ws.payloads,
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
        // BOTH RESOLVED BEFORE ANYTHING IS READ, so a mistyped endpoint or a malformed header
        // list costs a refusal rather than a graph lookup and a journal walk. The headers are
        // only consulted when an endpoint was given: an operator with `OTEL_EXPORTER_OTLP_HEADERS`
        // exported in their shell must not have a plain `loom trace` start refusing over it.
        //
        // A REPEAT IS REFUSED for `--extension-module`'s reason and it is the same shape one step
        // over: flags here are last-wins, so two `--otlp` values name two collectors and export
        // to one, which is the "believes they exported and did not" that `VERB_FLAGS`' own
        // `--otlp` row exists for.
        refuseRepeated(
          args,
          "otlp",
          "the run's spans would go to the LAST collector named and to no other.",
          "This flag takes ONE endpoint; a run that must reach two collectors is two `loom trace` invocations, " +
            "or a collector that fans out — which is a pipeline decision and not one this binary makes.",
        );
        const otlpTo = otlpEndpoint(args);
        const otlpWith = otlpTo === undefined ? undefined : otlpHeaders(process.env);
        // AN IGNORED ENDPOINT SAYS SO, ONCE. The rule that only argv can make this command send
        // is right, and the silent case is the one that costs an operator: an OTel SDK honours
        // `OTEL_EXPORTER_OTLP_ENDPOINT`, so somebody with it exported runs `loom trace`, sees a
        // clean trace and a zero exit, and concludes their collector was fed. Nothing in the
        // output distinguishes that from a run where no export was ever wanted. Refusing would
        // be wrong — a plain `loom trace` is a legitimate thing to want with that variable set —
        // so this is one line naming the variable and the flag that would use it.
        if (otlpTo === undefined) {
          const configured = OTLP_ENDPOINT_ENVS.filter((name) => (process.env[name] ?? "").trim() !== "");
          if (configured.length > 0) {
            process.stderr.write(
              `trace: ${configured.join(" and ")} is set and was NOT used — no environment variable can make this command ` +
                // THE DOLLAR IS PART OF THE ADVICE. Without it this line told the operator to pass
                // the variable's NAME, which `otlpEndpoint` then refuses as "did not parse as a
                // URL" — advice that fails on their very next command, which is the defect this
                // change already refused to ship in `refuseRepeated`'s remedy.
                `export. Pass --otlp "$${configured[0]!}" to send this run's spans to it.\n`,
            );
          }
        }
        // FOUND, NOT DEMANDED — see `recordedGraph`. Conformance is computed against this spec,
        // so resolving the WRONG one would report the graph's differences as the run's.
        const graph = await recordedGraph(ws, args, runId, "trace");
        const events = [];
        for await (const e of ws.store.read(runId, 1)) events.push(e);
        // THE PARENT'S OWN FOLD, KEPT — it is what conformance is computed over, at the bottom
        // of this block. A spliced trace covers two graphs and `reconstructGraph` refuses it by
        // design (see `MULTIPLE_GRAPHS`), so folding the two together and then asserting would
        // turn every subgraph run's `loom trace` into a non-zero exit. The question this command
        // has always answered — "did THIS run take an edge its graph does not declare?" — is a
        // question about one journal.
        const own = spansFrom(events);
        // AND THIS IS WHERE THE I/O LIVES, which is the whole reason `spansFrom` does not do it.
        // A `subgraph` node's child runs under `${parent}~${taskId}` with its own journal, so the
        // fold can only mint a LINK; following it is a second read, and a command that already
        // has a store is the right place for one. Without this the trace went blind at the most
        // interesting node in the graph: the line said `loom.tool (subgraph)` and nothing led to
        // the child.
        //
        // BREADTH-FIRST, BOUNDED, AND CYCLE-GUARDED. A child can itself have a subgraph, so this
        // is a queue rather than one hop. `seen` makes re-reading a run impossible — a cycle is
        // unreachable today (a child's id is strictly longer than its parent's) and the guard is
        // free. The count bound is a cost guard on a command that reads whatever the workspace
        // holds; past it the remaining children keep their links and lose their spliced interior,
        // which is the same picture this command gave before it could follow one at all.
        let spans = own;
        // EACH RUN'S OWN FOLD, KEPT ALONGSIDE THE SPLICE. The render wants one tree; the export
        // wants one trace per run, because `spliceSubgraph` rewrites a child's `traceId` onto
        // the parent's and the collector must see the id the child's own trace carries. Both
        // come out of the same walk, so the export can never cover a different set of runs than
        // the picture on screen.
        const folds: { readonly runId: RunId; readonly spans: readonly Span[] }[] = [{ runId, spans: own }];
        const visited = new Set<string>([runId]);
        const queue = [...childRunIdsOf(own)];
        while (queue.length > 0 && visited.size <= MAX_TRACED_SUBGRAPHS) {
          const child = queue.shift()!;
          if (visited.has(child)) continue;
          visited.add(child);
          const childEvents = await journalOf(ws, child as RunId);
          // A CHILD WITH NO JOURNAL IN THIS WORKSPACE IS NOT AN ERROR. `subgraph.started` is
          // journaled BEFORE `submit`, so a crash between the two leaves a link to a run that
          // never existed; a pruned or remote child reads empty the same way. The link stays on
          // the parent's span either way, which is the honest answer: this is the run, and it is
          // not here.
          if (childEvents.length === 0) continue;
          const childSpans = spansFrom(childEvents);
          folds.push({ runId: child as RunId, spans: childSpans });
          spans = spliceSubgraph(spans, childSpans);
          queue.push(...childRunIdsOf(childSpans));
        }
        // WHAT THE BOUND ACTUALLY DROPPED, and `queue.length` is not it: the loop shifts ids it
        // has already visited and skips them, so a queue holding only duplicates means nothing
        // was lost. Only an id still unvisited is a run this command did not read.
        const unreadChildren = new Set(queue.filter((id) => !visited.has(id))).size;
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
          // THE CHILD'S RUN ID, ON THE LINE. It is the route out of this journal and into the
          // one the interior below actually came from, and it is the answer when the interior is
          // NOT below — a child whose journal is not in this workspace, or one past the splice
          // bound. `loom trace <that id>` is then a command the reader can type, which is what
          // "a trace can follow a subgraph" has to mean when the follow itself failed.
          const childRun = sp.attributes?.["subgraph.child_run_id"];
          const into = typeof childRun === "string" && childRun !== "" ? ` -> ${childRun}` : "";
          process.stdout.write(`${"  ".repeat(depth)}${sp.name}${where}${qualifier}${into} [${sp.status}] ${sp.endTime - sp.startTime}ms\n`);
          for (const child of kids.get(sp.spanId) ?? []) emit(child, depth + 1);
        };
        for (const r of roots) emit(r, 0);
        // Anything a cycle kept out of the walk is still printed, because a renderer that silently
        // drops a span is worse than one that prints it flat.
        for (const sp of spans) if (!seen.has(sp.spanId)) emit(sp, 0);
        // AFTER THE TREE AND BEFORE CONFORMANCE. The operator gets the picture whatever the
        // collector does, and a run that does NOT conform is precisely the one worth having in
        // a collector — so the export does not wait on the verdict, and neither verdict
        // suppresses the other.
        const exported = otlpTo === undefined ? true : await exportTraceOverOtlp(folds, otlpTo, otlpWith, fetchImpl, unreadChildren);
        // `own`, NOT `spans` — see the note above the splice. A child is a different graph, and
        // `--graph` names one.
        const conformance = conformsToGraph(reconstructGraph(own), graph.spec, graph.graphHash);
        process.stdout.write(`\nconformance: ${conformance.ok ? "ok" : JSON.stringify(conformance)}\n`);
        // TWO WAYS TO FAIL, ONE CODE, AND THE STDERR LINES SAY WHICH. `main`'s vocabulary has
        // three members and 2 is taken by "there is no such command", so an export that did not
        // complete is 1 for the same reason a run that did not conform is: the operator asked
        // for both and one of them did not happen. `serveUntilInterrupt`'s docstring carries
        // the enumeration and names this member.
        return conformance.ok && exported ? 0 : 1;
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
        const { index, failed } = graphsByHash(ws);
        const promotedGraphHashes = new Set(index.keys());
        // The AUTHORED graph, for `promptRef` and node types only. A run that mutated its graph
        // folds its own successor hash from the journal; this lookup does not decide that.
        const submitted = events.find((e): e is Extract<JournalEvent, { type: "run.submitted" }> => isEvent(e, "run.submitted"));
        // NO SPEC, NO SCORE — AND THAT IS A REFUSAL, NOT A ZERO. `extractSignals` reads the
        // assertion, rubric and agent nodes out of `spec.nodes`, so a fold with no graph reports
        // `signals: []`, and `signals: []` is precisely what a run that failed every assertion
        // reports. Driven live on one review-bench run, same run and same command twice
        // (`docs/evolution-loop-2026-08-27.md` §4): with the graph absent from graphs/,
        // `"signals": []`, outcome 0, score 0.111; with it present, `S1 "6/6 assertions passed"`,
        // outcome 1, score 0.700. A CANDIDATE graph is published in candidates/, so it never
        // resolved and every candidate cohort read as worthless until somebody noticed.
        //
        // This is the third folded-without-its-graph defect in one session, and the first two
        // were fixed by finding the graph. That is not available here — the graph may simply not
        // be in this workspace — so the answer is the one CLAUDE.md gives for a guard that cannot
        // decide: refuse, journal nothing, and name the file and the directory. Appending an
        // `evolution.scored` row of 0 would put a fiction in the only authoritative state.
        if (submitted === undefined) {
          process.stderr.write(
            `run ${runId} has no run.submitted event, so nothing in its journal names the graph it ran ` +
              `and no signal can be read off its steps. That journal is not scoreable.\n`,
          );
          return 1;
        }
        const ranHash = submitted.payload.graphHash;
        // `--graph` NAMES THE SPEC WITHOUT PUBLISHING IT, and the difference is load-bearing:
        // publishing into graphs/ is ALSO what marks a graph promoted here, so a candidate that
        // had to be published in order to be scored would pass golden condition 5 on the way in —
        // the loop certifying its own unreviewed output. Judged by HASH against the journal, so
        // this is a lookup the caller cannot answer wrongly, never an input to the score.
        // CHECKED WHENEVER IT IS GIVEN, never only when the lookup missed: a flag that is
        // silently ignored on the path where it happens to be redundant is a flag whose meaning
        // depends on the workspace's contents.
        const namedGraph = args.flags["graph"];
        let graph = index.get(ranHash);
        if (namedGraph !== undefined) {
          const g = loadGraph(ws, requireFileFlag(args, "graph"), false);
          if (g.graphHash !== ranHash) {
            process.stderr.write(
              `--graph ${String(namedGraph)} compiles to ${g.graphHash}, and run ${runId} ran ${ranHash}. ` +
                `Scoring it under another graph's node types would read signals off nodes this run never ran.\n`,
            );
            return 1;
          }
          graph = g;
        }
        if (graph === undefined) {
          process.stderr.write(
            `run ${runId} ran graph ${ranHash}, and no graph in ${join(ws.root, "graphs")} has that hash ` +
              `(${String(index.size)} searched${failed.length === 0 ? "" : `; ${String(failed.length)} would not compile — ${failed.join("; ")}`}). ` +
              `Without the spec this run's assertion, rubric and agent nodes cannot be identified, so every ` +
              `signal would read as absent and the verdict would be outcome 0 — the same number a run that ` +
              `failed every assertion earns. Refusing instead: nothing was measured, so nothing is journaled. ` +
              `fix: pass --graph <file> with the graph this run ran (a candidate lives in candidates/, and ` +
              `--graph scores it without publishing it), or publish those bytes into ${join(ws.root, "graphs")}. ` +
              `A graph EDITED since the run no longer matches, which is the point — this run executed the old bytes.\n`,
          );
          return 1;
        }
        // ONE BUCKET RULE, USED BY BOTH FOLDS. A cohort key is only meaningful if every
        // member was bucketed by the same rule — folding this run under `--bucket` and its
        // peers under the default would produce a key nothing else in the workspace can
        // match, so the flag would report a cohort of one for the very runs it was asked to
        // join. `cohortPeers` therefore takes it too, and a test counts the members.
        const bucketInput = bucketFlag(args);
        // `graph` is not optional here any more — the block above returned 1 rather than fold
        // without it. THAT USED TO BE THE WHOLE OF `t.specResolved`, and this comment said so:
        // "which is what makes `t.specResolved` true for the judged run by construction". It
        // stopped being true when `verdictsResolved` was ANDed into the field, and nothing here
        // noticed — so a run folded WITH its graph could still arrive unmeasured, be scored 0,
        // and be journaled with a golden blocker announcing a missing graph. Peers are a
        // different question; see below.
        const t = foldTrajectory(events, {
          promotedGraphHashes,
          graph,
          ...(bucketInput === undefined ? {} : { bucketInput }),
        });
        // THE OTHER HALF OF "NO SPEC, NO SCORE" — a refusal, not a zero, for the same reason.
        // With the graph in hand the only remaining way the ladder comes back unreadable is a
        // verdict that left the journal, and the two deserve the same treatment: `measureCohort`
        // would drop this run from its own cohort, `isGolden` would refuse it, and the number
        // journaled beside those facts would still be a 0 that reads as "this run was bad".
        // Worse, `components` carries no `specResolved`, so the row a `suite freeze` reads back
        // has `delivered: true` and nothing at all saying nobody measured it — the run enters
        // the exam as a case, ordered by a score of 0 it did not earn. Appending that row would
        // put a fiction in the only authoritative state, which is the sentence the no-graph
        // refusal above already argues.
        if (!t.verdictsResolved) {
          const nodes = new Map(graph.spec.nodes.map((n) => [n.id, n.type]));
          // THE CHANNELS THAT ACTUALLY LEFT, and not every channel the evaluator wrote.
          // `Step.channelsWritten` is `writes` UNION `external` — trajectory.ts joins them on
          // purpose, so a step that moved 300 KB is not read as a step that wrote nothing — so
          // naming that union here told the operator a channel still sitting in the journal was
          // a payload handle. MEASURED, on an evaluator writing a 300 kB `verdict` beside a small
          // `note` that stayed inline: `(note, verdict)`. That is this refusal committing the
          // defect the refusal exists to fix, one clause along.
          //
          // READ FROM THE DECLARATION, not from the values: `task.committed.external` is where
          // the executor that did the externalising says which channels left, and events.ts
          // states why a fold may not decide it by looking at a value. LAST COMMIT PER TASK
          // WINS, which is what `foldTrajectory` does with the same field — a retry that kept
          // its verdict inline is the state `verdictsResolved` was computed from, so it must be
          // the state this sentence names.
          const externalPerTask = new Map<TaskId, readonly string[]>();
          for (const e of events) {
            if (!isEvent(e, "task.committed") || e.taskId === undefined) continue;
            externalPerTask.set(e.taskId, Object.keys(e.payload.external ?? {}));
          }
          const blind = [
            ...new Set(
              t.steps.filter((s) => nodes.get(s.nodeId) === "evaluator").flatMap((s) => externalPerTask.get(s.taskId) ?? []),
            ),
          ].sort();
          process.stderr.write(
            `run ${runId} ran an evaluator whose channel is a payload handle rather than a value ` +
              `(${blind.join(", ")}): its canonical form passed ${String(EXTERNALISE_ABOVE_BYTES)} bytes, so the ` +
              `engine moved it out of the journal and this fold cannot read the verdict it held. Every signal ` +
              `that evaluator carried would read as absent, and outcome 0 is the same number a run that failed ` +
              `every assertion earns. Refusing instead: nothing was measured, so nothing is journaled. This run ` +
              `is not recoverable — the value is not in its journal, and no graph or flag puts it back. ` +
              `fix: for later runs, keep the evaluator's verdict under that size, or make its channel ineligible ` +
              `for the payload store by declaring it in the graph's outputs or naming it in an edge or router ` +
              `expression.\n`,
          );
          return 1;
        }
        const key = cohortKeyOf(t);
        // AND THE PEERS GET IT TOO. A cohort key pins one `graphHash`, so a peer of this run ran
        // these same bytes — the whole point of a CANDIDATE cohort is thirty runs of one
        // unpublished graph. Folding this run with `--graph` and its peers without it would
        // measure the run against a population of runs of ITSELF that nobody could measure.
        // It is a lookup keyed by hash, so it can only ever supply the peer's own spec; the
        // promoted set is still `index` alone, which is what keeps golden condition 5 honest.
        const lookup = new Map(index);
        lookup.set(graph.graphHash, graph);
        const peers = await cohortPeers(ws, runId, key, promotedGraphHashes, lookup, bucketInput);
        if (peers.truncated) {
          process.stderr.write(
            `! the cohort scan stopped at ${String(COHORT_SCAN_LIMIT)} runs, so this cohort may be smaller than the workspace's\n`,
          );
        }
        // THE SAME DEFECT WEARING THE OTHER HAT, and this is the backstop rather than the fix.
        // `measureCohort` drops a peer it could not measure, because `p90Score` is a percentile
        // OF THE SCORES and a specless peer scores 0 — a promotion bar the population gets to
        // lower by standing next to it. Dropping it QUIETLY is the same sin one directory over,
        // so the count and the hashes are said here.
        //
        // WHAT IS LEFT TO REACH THIS. A cohort key pins one `graphHash`, so a peer of the judged
        // run ran the same bytes and resolves out of the same two lookups the judged run just
        // survived — the refusal above and `lookup` below close the ordinary cases. What remains
        // is a peer that reached this key by a DIFFERENT route: `foldTrajectory` takes its
        // `graphHash` from `graph.mutated` when there is one, while the spec is looked up by
        // `run.submitted`'s hash, so two runs of two different authored graphs that mutate to the
        // same successor share a key and need not share a lookup.
        //
        // NO LONGER STATED — DRIVEN. This comment used to end "this branch has no end-to-end
        // coverage", and the fixture that closed that (`test/cli/evolution-score.test.ts`, "A
        // PEER CAN REACH THIS COHORT BY MUTATION AND NOT BY PUBLICATION") found the branch
        // reachable AND its message wrong: it printed the peer's folded hash, which in this
        // state is the judged run's own published graph, and told the operator to publish it.
        // The route is real and narrow — `compileMutation` on a graph that is a prefix of
        // another produces the other's hash exactly, so a run of the unpublished parent adopts
        // the published child's hash and joins its cohort. `unmeasuredNotes` names the AUTHORED
        // hash now. THE VERDICT HALF IS NOT SO RARE: a peer resolves its graph and
        // still comes back unmeasured whenever its evaluator's verdict outgrew the journal, which
        // is why the sentence is chosen by `unmeasuredNotes` and not fixed here.
        for (const note of unmeasuredNotes(
          peers.members,
          join(ws.root, "graphs"),
          "peer run(s)",
          `are EXCLUDED from the population rather than scored 0 — a peer nobody could measure would otherwise ` +
            `drag p90Score, and p90Score is the bar this run has to clear.`,
        )) {
          process.stderr.write(note);
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
        // A SATURATED COHORT IS NOT A BAD SCORE, IT IS AN ABSENT RANKING, and the person at the
        // terminal is reading a number. `goldenBlockers` carries condition 2's full sentence into
        // the journal, so this adds no fact the row does not have — it puts the fact where it is
        // read, the same bargain the `!completed` note above makes.
        if (cohort.n > 0 && cohort.outcomeSpread === 0) {
          process.stderr.write(
            `! this cohort's ${String(cohort.n)} member(s) all scored the same on the signal ladder, so p90Score ` +
              `${cohort.p90Score.toFixed(3)} ranks cost, latency and gates and nothing else — every one of which ` +
              `pays a run for doing LESS work. The golden verdict refuses the rank rather than crowning the ` +
              `cheapest run; the score itself is still the measured one. fix: give this workflow a signal that ` +
              `varies — an evaluator{kind:"assertion"} node scores k/n rather than pass/fail.\n`,
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

      // THE EXAM COMES OUT OF THE RUNS. See `freezeSuite` for what is selected and why.
      case "suite": {
        const sub = requirePositional(args, 0, `a subcommand — "freeze" is the only one`);
        if (sub !== "freeze") {
          process.stderr.write(`unknown subcommand "suite ${sub}" — the only one is "freeze"\n\n${USAGE}`);
          return 2;
        }
        return await freezeSuite(ws, args);
      }

      // THE DOOR ON THE PROMOTION GATE, and it is the whole reason the gate exists.
      //
      // `gateCandidate`, `runEvalSuite` and `requirePromotable` had ZERO callers outside
      // `src/evolution/` and `test/` — the same standing `scoreTrajectory` had before `loom
      // score` existed, and cli.ts's `score` comment says what that costs: arithmetic that is
      // "correct, tested, and reachable from nothing a person can run". `node cli.ts promote`
      // answered `unknown command "promote"`, exit 2.
      //
      // FOUR OF `PromotionInput`'s FIELDS ARE MEASURED HERE, NOT TAKEN AS FLAGS. A gate whose
      // inputs the caller asserts is not a gate:
      //
      //   deterministic          — the candidate's suite is run TWICE and the two reports'
      //                            replayed channels and statuses compared, case by case.
      //   postureDiffNonNegative — the candidate spec is recompiled with `baselinePostures`
      //                            taken from the baseline's `plans`, the `graph/mutate.ts:180`
      //                            pattern. GRAPH014 / E_OVERSIGHT_LOOSENED answers it.
      //   promptGrowth           — the compiled artifacts carry their prompts (`RunGraph
      //                            .documents`), so this is the byte delta over the refs the
      //                            two graphs' AGENT nodes name, not a number anybody typed.
      //   proposedAt             — now. `9-suite-predates-candidate` is a timestamp comparison
      //                            and it is the rule that makes an AI-authored suite safe, so
      //                            the candidate cannot be given a date it prefers.
      //
      // WHAT IT DELIBERATELY DOES NOT DO: it does not publish the winner. Promotion stays a
      // human putting the file in `<workspace>/graphs/`, which is what `loom score` already
      // reads as the promoted set. A verb that copied the graph on a pass would let one command
      // change what the next thirty runs are allowed to learn from.
      //
      // THREE OF THE ELEVEN CHECKS ARE WEAKER THAN D10.d SAYS, and shipping this door makes
      // them the product's promotion criteria, so they are said out loud rather than
      // discovered: `2-non-inferior` is a bare point estimate and not McNemar's paired test
      // with a 95% lower bound; `3-cost` divides TOTALS where D10.d says medians, and
      // `EvalReport` carries no median so the stricter reading is not expressible; `7-safety`
      // greps case reasons for the substring `irreversible`.
      case "promote": {
        const candidateFile = requirePositional(args, 0, "a candidate graph file");
        // TWO MODES, AND THE FLAG THAT PICKS ONE IS READ FIRST. `--against-cohort` judges the
        // candidate by RUNNING it; the branch below judges it by replaying recordings against
        // it. They answer different questions and produce differently-shaped verdicts, which is
        // why the mode is a flag rather than a variation inside one report — see
        // `promoteAgainstCohort` for what the live one can and cannot certify.
        if (args.flags["against-cohort"] !== undefined) {
          return await promoteAgainstCohort(ws, args, loadGraph(ws, candidateFile, false));
        }
        // `--runs` belongs to the mode above and means nothing here. Accepting it silently
        // would let an operator believe they had capped a live run count on a command that
        // makes no live runs — the `--bucket`-with-no-mode argument, one flag over.
        if (args.flags["runs"] !== undefined) {
          throw err.validation(
            CODES.E_CONFIG_INVALID,
            `--runs caps how many of a cohort's recordings a LIVE promotion re-runs, and this promotion replays a ` +
              `frozen suite instead — it makes no runs at all, so the flag would cap nothing. ` +
              `Add --against-cohort <runId> to judge this candidate live, or drop --runs.`,
          );
        }
        const baseline = loadGraph(ws, requireFileFlag(args, "baseline"), false);
        const candidate = loadGraph(ws, candidateFile, false);
        const suite = readSuite(requireFileFlag(args, "suite"));
        const proposedBy = proposedByFlag(args);
        // `false`: neither graph is being introduced to the workspace. `loom promote` judges a
        // candidate, and a candidate is by definition not published — see the note above about
        // not publishing the winner.
        if (candidate.graphHash === baseline.graphHash) {
          throw err.validation(
            CODES.E_CONFIG_INVALID,
            `the candidate and the baseline are the same graph (${candidate.graphHash}). ` +
              `A promotion decision over two identical graphs measures nothing, and reporting ` +
              `"non-inferior" for it would be true and useless.`,
          );
        }
        const engine = {
          tools: ws.engine.tools,
          functions: ws.engine.functions,
          models: ws.engine.models,
          // The workspace's hooks and the run's own grants, for the reason `loom replay` gives
          // one case over: a replay without them runs a DIFFERENT PROGRAM than the recording
          // and then blames the run for the difference.
          hooks: ws.hooks,
          policy: { granted: ws.granted },
        };

        const baseReport = await runEvalSuite({ store: ws.store, suite, graph: baseline, engine });
        const candReport = await runEvalSuite({ store: ws.store, suite, graph: candidate, engine });
        const candAgain = await runEvalSuite({ store: ws.store, suite, graph: candidate, engine });

        const verdict = gateCandidate({
          baseline: baseReport,
          candidate: candReport,
          proposedAt: Date.now(),
          ...(proposedBy === undefined ? {} : { proposedBy }),
          promptGrowth: promptGrowthOf(baseline, candidate),
          postureDiffNonNegative: posturesHoldOf(ws, baseline, candidate),
          deterministic: sameOutcome(candReport, candAgain),
        });

        for (const c of [...verdict.checks].sort((a, b) => (a.id < b.id ? -1 : 1))) {
          process.stdout.write(`${c.pass ? "✓" : "✗"} ${c.id.padEnd(24)} ${c.detail}\n`);
        }
        for (const c of candReport.cases.filter((x) => !x.pass)) {
          process.stdout.write(`  · case ${c.id} failed — ${c.reasons.join("; ")}\n`);
        }

        // THE POPULATION THE DECISION WAS MADE OVER, so "promoted over them" is a fact on the
        // page rather than a claim in a commit message. Folded with each case run's own authored
        // graph, the same way `loom score` folds — see `cohortPeers`.
        const { index } = graphsByHash(ws);
        const keys = new Map<string, number>();
        for (const c of suite.cases) {
          const events = await journalOf(ws, c.runId);
          if (events.length === 0) continue;
          const sub = events.find((e): e is Extract<JournalEvent, { type: "run.submitted" }> => isEvent(e, "run.submitted"));
          const g = sub === undefined ? undefined : index.get(sub.payload.graphHash);
          const key = cohortKeyOf(foldTrajectory(events, { ...(g === undefined ? {} : { graph: g }) }));
          keys.set(key, (keys.get(key) ?? 0) + 1);
        }

        const decision = {
          promote: verdict.promote,
          suite: suite.name,
          suiteVersion: suite.version,
          suiteFrozenAt: suite.frozenAt,
          baselineGraphHash: baseline.graphHash,
          candidateGraphHash: candidate.graphHash,
          baseline: { passRate: baseReport.passRate, passed: baseReport.passed, total: baseReport.total, costUsd: baseReport.totalCostUsd },
          candidate: { passRate: candReport.passRate, passed: candReport.passed, total: candReport.total, costUsd: candReport.totalCostUsd },
          caseRunIds: suite.cases.map((c) => c.runId),
          // A suite whose cases come from more than one cohort is not wrong, but it is a
          // different claim, and a report that hid it would let "promoted over one cohort of
          // thirty" be said about six unrelated runs.
          cohorts: [...keys].map(([key, n]) => ({ key, cases: n })),
          checks: verdict.checks.map((c) => ({ id: c.id, pass: c.pass, detail: c.detail })),
        };
        process.stdout.write(`\n${JSON.stringify(decision, null, 2)}\n`);

        // JOURNALED ON `operator.command`, WHICH IS WHAT HAPPENED — a person ran a command.
        // Deliberately NOT a new `evolution.promoted` row: `journal/events.ts` is a kernel file
        // and the `Kernel-seam:` ledger is not a number to raise for a first demonstration. The
        // residual tension is real and is written down rather than solved: `StateStore` is keyed
        // by runId, so a fact whose subject is a GRAPH has to borrow some run's coordinate. It
        // borrows the FIRST CASE's, and `caseRunIds` names all of them.
        // WHERE THE DECISION IS WRITTEN, and it is written or the promotion does not stand.
        //
        // The anchor used to be `suite.cases[0]` and the append was wrapped in "…if that run
        // happens to have a journal". A suite whose FIRST case names a missing recording, while
        // its others replay and pass, therefore granted a promotion and recorded nothing —
        // exit 0, stdout silent, and no row anywhere for a reader to find. The journal is the
        // only authoritative state, so a promotion nobody can reconstruct is not one.
        //
        // Any case with a journal will do: they are all recordings this promotion was judged
        // over, and the decision names its own suite. If NONE has one, that is refused below
        // rather than skipped — a guard that cannot record its decision fails closed.
        let anchor: RunId | undefined;
        for (const c of suite.cases) {
          if ((await journalOf(ws, c.runId)).length > 0) {
            anchor = c.runId;
            break;
          }
        }
        if (anchor === undefined) {
          process.stderr.write(
            `refusing to certify: no case in suite "${suite.name}" v${String(suite.version)} names a run with a journal ` +
              `in ${ws.dataDir}, so this decision cannot be recorded and nothing could audit it later. ` +
              `Freeze the suite against runs from THIS workspace, or point --workspace at the one that holds them.\n`,
          );
          return 2;
        }
        {
          await ws.store.append({
            runId: anchor,
            expectedSeq: await ws.store.head(anchor),
            events: [
              {
                type: "operator.command",
                payload: { kind: "evolution.promote", args: decision },
                actor: { kind: "human", subject: subjectFlag(args), via: "console" },
              },
            ],
          });
        }
        return verdict.promote ? 0 : 1;
      }

      default:
        process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
        return 2;
    }
  } finally {
    // Children first: a server left running outlives the process that spawned it, and a
    // stdio server holds the pipe open, so `loom run` would not exit.
    closeMcp();
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

/**
 * How many child runs `loom trace` will read before it stops following links.
 *
 * A COST GUARD ON A READ, not a claim about how deep a graph may nest. `trace` follows
 * `subgraph.child_run_id` breadth-first, and each hop is a full journal read; a run that fanned
 * a subgraph out across a hundred branches is a command that appears to hang, which is the same
 * failure `COHORT_SCAN_LIMIT` exists for one screen down.
 *
 * REACHING IT COSTS NOTHING THAT WAS THERE BEFORE. The links stay on every parent span and the
 * run ids stay on the rendered lines, so a child past the bound is a `loom trace <id>` the reader
 * can type — which is exactly the picture this command gave when it could not follow one at all.
 */
const MAX_TRACED_SUBGRAPHS = 64;

/**
 * How long `loom trace --otlp` will spend on a collector before giving up on ALL of it.
 *
 * A BOUND ON THE WALK, not on one POST. `OtlpHttpExporter` already bounds each request at 10 s,
 * and with up to 65 runs to export that is eleven minutes of a terminal that looks hung — one
 * line every ten seconds, which reads as progress. This is the deadline the whole loop shares:
 * the first few runs get their real answers, and once it fires the rest fail fast as
 * `reason: "timeout"` and are still reported one line each.
 *
 * 60 s because a healthy collector is nowhere near it — 65 POSTs on loopback finish in well
 * under a second — so the only thing that reaches this number is a collector that is not
 * answering, which is exactly what it is for.
 */
const OTLP_EXPORT_DEADLINE_MS = 60_000;

/**
 * POST what `loom trace` just read to an OTLP/HTTP collector — the PUSH half of TODO §C.4.
 *
 * `telemetry/otlp.ts` has been able to do this for a wave and had no caller in the binary, so
 * a deployment that wanted trace export had to embed the library. `GET /runs/:id/trace` was the
 * pull half; this is the other one, and they share the encoder so a collector cannot be told
 * two different stories about one span.
 *
 * **ONE REQUEST PER RUN, UNSPLICED, AND THAT IS THE WHOLE DESIGN DECISION.** The renderer above
 * splices a subgraph's child into the parent's tree because a terminal has no collector to do
 * the join. A collector does — `spansFrom` mints the parent's `SpanLink.traceId` as
 * `digest(childRunId)`, byte-identical to the traceId the child's OWN fold mints — so the
 * export hands over each run's own trace and lets the collector walk the link. Exporting the
 * spliced array instead would be actively wrong rather than merely redundant: `spliceSubgraph`
 * REWRITES the child's `traceId` to the parent's, so the same child spans would arrive under a
 * different id than `GET /runs/<child>/trace?format=otlp` answers for them, and the two doors
 * would disagree about the identity of one span.
 *
 * ONE EXPORTER PER RUN, TOO, and that is not an oversight: `resourceAttributes` is on the
 * exporter's CONSTRUCTOR, so a single merged payload — which `OtlpTracePayload`'s docstring
 * correctly says the `resourceSpans` array is for — could carry only one `loom.run_id`. A
 * payload without it differs from what the pull route answers for that run, which is the drift
 * this whole arrangement exists to avoid. The cost is up to 65 sequential POSTs with no
 * atomicity, so EVERY RUN'S OUTCOME GETS ITS OWN LINE and a partial export is diagnosable
 * rather than one number.
 *
 * WHAT IS ON THE LINE, AND WHY IT IS THE HOST AND NOT THE URL. `endpointSecrets` puts six things
 * in the exporter's mask list — the raw string as given, `href`, the ORIGIN, `origin+pathname`
 * AND the bare pathname, the userinfo, and the query — so the scheme-qualified origin is masked
 * and the BARE HOSTNAME is what survives — which is what
 * that file means by "the HOSTNAME is deliberately left legible". Printing the origin here would
 * print in plaintext the exact string the sibling line redacts.
 *
 * **AN EARLIER VERSION OF THIS PARAGRAPH PASTED A TRANSCRIPT THAT DOES NOT REPRODUCE**, and the
 * correction is the more useful half. It quoted
 * `detail: "TypeError: fetch failed to [redacted]v1/traces (ENOTFOUND collector.internal)"` as
 * driven evidence; that came from a STUB `fetch` throwing a message I had written myself. Node's
 * real `fetch` throws a bare `TypeError: fetch failed` and puts the reason on `.cause`, so the
 * genuine measurement against `http://no-such-host.invalid:4318` was
 * `detail: "TypeError: fetch failed"` and nothing more — the exporter's own claim about what an
 * operator diagnoses with was false for every transport failure it had ever produced. `otlp.ts`
 * now appends the cause, and the same command yields
 * `TypeError: fetch failed (getaddrinfo ENOTFOUND no-such-host.invalid)`. A quotation is the
 * strongest-looking evidence on a page, and it was the invented part.
 *
 * The residual on the host line is real and is not denied: a vendor endpoint whose subdomain IS
 * the key is exposed by the host as much as by the origin, and no split of a URL fixes that —
 * which is also why USAGE says an endpoint that is itself a secret is visible in `ps`.
 *
 * ONE DEADLINE ACROSS THE WHOLE LOOP, not one per POST. `folds` can hold 65 entries and the
 * exporter's own timeout is 10 s, so a collector that accepts the connection and never answers
 * would hold the terminal for eleven minutes, one silent line every ten seconds. The signal is
 * created once and handed to every `export`, so a hung collector costs one timeout and the
 * remaining runs fail fast — each still reported on its own line, which is what makes a partial
 * export diagnosable.
 *
 * `empty` IS NOT A FAILURE. `otlp.ts` returns it to distinguish "nothing to say" from "said
 * it", and folding it into the exit code would erase the distinction the field exists to make.
 * Everything else — a status, a transport error, a timeout, and a 200 whose `partialSuccess`
 * rejected spans — is a failure, because an operator who asked for an export and did not get
 * one did not get what they asked for.
 */
export async function exportTraceOverOtlp(
  folds: readonly { readonly runId: RunId; readonly spans: readonly Span[] }[],
  endpoint: string,
  headers: Record<string, string> | undefined,
  fetchImpl: HttpOptions["fetch"] | undefined,
  unread: number,
  /**
   * The walk's deadline, so a test can spend it without waiting a minute.
   *
   * `serveUntilInterrupt`'s seam and for its stated reason — "the test drives the failure with a
   * `close()` that rejects". Two arms of this function are otherwise unreachable: a spent budget
   * needs a black-holed collector and sixty seconds, and `reason: "empty"` needs a fold that
   * encodes to no spans, which `trace` cannot produce. Exported for the same reason `parseArgs`
   * and `controlPlaneOptions` are; `cli.ts` is not on the package's pinned public surface.
   */
  budget?: AbortSignal,
): Promise<boolean> {
  // Validated by `otlpEndpoint` before any journal was read, so the catch is unreachable from
  // the CLI; it is here because a fallback that cannot fail is the one worth having.
  const where = ((): string => {
    try {
      const h = new URL(endpoint).host;
      return h === "" ? "the configured collector" : h;
    } catch {
      return "the configured collector";
    }
  })();
  let ok = true;
  // See the header: one deadline for the whole walk, not one per run. Generous enough that a
  // working collector never sees it — 65 POSTs to a healthy collector is well under a second on
  // loopback — and short enough that a black-holed one does not own the terminal. Overridable
  // through the `budget` parameter, which exists so a test can spend it without waiting a
  // minute — and, until it did, this whole arm was pinned by nothing.
  const deadline = budget ?? AbortSignal.timeout(OTLP_EXPORT_DEADLINE_MS);
  for (const fold of folds) {
    // A SPENT BUDGET IS "NOT SENT", NOT "TIMED OUT AGAINST THIS HOST". Both aborts are
    // `AbortSignal.timeout`, so the exporter cannot tell them apart — measured, the per-request
    // timeout and the walk deadline produce byte-identical results. Without this arm a
    // black-holed collector with 65 folds printed one true timeout and SIXTY-FOUR lines saying
    // the named host timed out on requests that were never sent: the same false report the
    // redirect arm of this feature exists to remove, inverted.
    if (deadline.aborted) {
      ok = false;
      process.stderr.write(
        `otlp: ${fold.runId} — NOT SENT; this walk's export budget is spent, and an earlier run's failure above is the diagnosis\n`,
      );
      continue;
    }
    const exporter = new OtlpHttpExporter({
      endpoint,
      ...(headers === undefined ? {} : { headers }),
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      // IMPORTED, NEVER SPELLED. `registries.test.ts` makes any `loom.*` literal outside
      // `telemetry/spans.ts` a failure, and it has already caught `server/http.ts` minting its
      // own `"loom.run_id"`. `service.name` is not set here on purpose: the encoder defaults it
      // to `loom`, and a second spelling of a default is a second thing that can drift.
      resourceAttributes: { [OTLP_RUN_ID_ATTR]: fold.runId },
    });
    const result = await exporter.export(fold.spans, deadline);
    if (result.ok) {
      if (result.rejected === 0) {
        process.stderr.write(`otlp: ${fold.runId} — ${String(result.spans)} span(s) sent to ${where}\n`);
      } else {
        ok = false;
        process.stderr.write(
          `otlp: ${fold.runId} — ${where} ACCEPTED THE REQUEST AND REJECTED ${String(result.rejected)} of ` +
            `${String(result.spans)} span(s)${result.message === undefined ? "" : `: ${legible(result.message)}`}\n`,
        );
      }
      continue;
    }
    if (result.reason === "empty") {
      // Not a failure — see the header. Reported anyway, because "I sent nothing" and "I sent
      // it" must not look the same to whoever is watching the pipeline. This arm returns BEFORE
      // `ok` is touched; an earlier draft cleared the flag first and then tried to restore it,
      // which made an empty fold fail the command.
      //
      // **UNREACHABLE FROM `trace`, AND PINNED ANYWAY THROUGH THE SAME SEAM.** `empty` needs a
      // fold that encodes to zero spans: the parent's journal is non-empty (`recordedGraph`
      // already resolved a `run.compiled` out of it), the walk skips any child whose journal
      // reads empty, and `spansFrom` mints `loom.run` for anything with a `run.submitted`. An
      // earlier draft said "no test drives this line" and left it at that; the test now calls
      // this function directly with an empty fold, which is what the exported signature is for.
      // The arm is kept because `OtlpExportResult` HAS it: treating "nothing to send" as a
      // failure erases the distinction the field was added to make.
      process.stderr.write(`otlp: ${fold.runId} — nothing to export; its journal folded to no spans\n`);
      continue;
    }
    ok = false;
    process.stderr.write(`otlp: ${fold.runId} — FAILED (${result.reason}) against ${where}: ${legible(result.detail)}\n`);
  }
  if (unread > 0) {
    // A SILENT CAP ON AN EXPORT IS WORSE THAN ONE ON A RENDER. The renderer can afford to stop
    // at `MAX_TRACED_SUBGRAPHS` quietly: the links and the child run ids are still on the
    // printed lines, so the reader can type the next command. A collector that is simply
    // missing those runs looks exactly like a run that had no subgraphs.
    //
    // **AND IT IS DRIVEN, after a review pointed out that the confession here was false on its
    // own terms.** This said "reaching it needs a run with more than 64 subgraph children" and
    // "no seam to lower" — while `unread` is the fifth positional parameter of a function the
    // same commit had already exported so that two other arms could be driven. The seam was
    // already open and the claim had not been re-read against it. The arithmetic `unread`
    // depends on is the part that WAS wrong on the first draft, and it is stated where it is
    // computed rather than here.
    process.stderr.write(
      `otlp: ${String(unread)} child run(s) were not read and therefore not exported — \`loom trace\` follows at most ` +
        `${String(MAX_TRACED_SUBGRAPHS)} of them per invocation. Their ids are on the tree above; each is its own \`loom trace\`.\n`,
    );
  }
  return ok;
}

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

/**
 * WHY A COHORT SHRANK, SAID IN THE TERMS OF THE THING THAT ACTUALLY WENT WRONG.
 *
 * `measureCohort` drops a member whose `specResolved` is false, and two verbs announce that
 * exclusion rather than let a cohort quietly get smaller. Both of them used to announce it with
 * one sentence — "folded without their graph … Publish those graphs in graphs/" — because for a
 * while that was the only way `specResolved` could be false. It stopped being the only way when
 * `Trajectory.verdictsResolved` was ANDed into the field, and the sentence did not move: a run
 * whose graph resolved perfectly was reported as missing it, with a remediation that republishes
 * a graph already on disk and brings nothing back. CLAUDE.md: a correction that replaces a false
 * claim with a differently-false one is worse than the original, because it asserts verified
 * accuracy and is believed harder.
 *
 * THE TWO CAUSES ARE DISJOINT BY CONSTRUCTION, not by preference. With no graph the fold has no
 * node types, no step is known to be an `evaluator`, and `verdictsResolved` comes back vacuously
 * true — so `!verdictsResolved` proves the graph WAS there, and `!specResolved && verdictsResolved`
 * is exactly the no-graph half. One helper for both call sites so the split cannot drift back.
 *
 * `noun` because one caller is looking at peers and the other at a population that includes its
 * own anchor; `consequence` because the exclusion costs a `score` run its `p90Score` bar and a
 * `promote` run its pairing, which are different sentences about the same drop.
 */
function unmeasuredNotes(
  members: readonly Trajectory[],
  graphsDir: string,
  noun: string,
  consequence: string,
): readonly string[] {
  const hashesOf = (ms: readonly Trajectory[]): string => [...new Set(ms.map((m) => m.graphHash))].sort().join(", ");
  const notes: string[] = [];
  const noGraph = members.filter((m) => !m.specResolved && m.verdictsResolved);
  if (noGraph.length > 0) {
    // THE HASH A READER CAN ACT ON IS THE AUTHORED ONE, and this line used to print the other.
    // A spec is looked up by `run.submitted.graphHash`; `Trajectory.graphHash` folds
    // `graph.mutated` over it. In the ONE state that reaches this branch those two differ by
    // construction — a peer joins this cohort by mutating INTO its graphHash, which is why its
    // own spec was never looked for under that name — so the note named a graph the operator
    // has, and told them to publish it. Measured on the fixture in
    // `test/cli/evolution-score.test.ts`: the peer's authored hash was the parent and the line
    // printed `sha256:71eb5ad4…`, the successor, which is the JUDGED RUN'S OWN published graph.
    const authored = [...new Set(noGraph.map((m) => m.authoredGraphHash))].sort().join(", ");
    const mutated = noGraph.filter((m) => m.authoredGraphHash !== m.graphHash);
    notes.push(
      `! ${String(noGraph.length)} ${noun} in this cohort folded without their graph (${authored}) and ` +
        `${consequence} Publish those graphs in ${graphsDir} to put them back in the cohort.` +
        (mutated.length === 0
          ? ""
          : ` ${String(mutated.length)} of them reached this cohort by MUTATING into it — they were submitted ` +
            `under the hash above and appended graph.mutated, so the cohort's own ${hashesOf(mutated)} is the ` +
            `SUCCESSOR and is not what to publish.`) +
        `\n`,
    );
  }
  const noVerdict = members.filter((m) => !m.verdictsResolved);
  if (noVerdict.length > 0) {
    notes.push(
      `! ${String(noVerdict.length)} ${noun} in this cohort folded WITH their graph (${hashesOf(noVerdict)}) but an ` +
        `evaluator's channel had passed ${String(EXTERNALISE_ABOVE_BYTES)} bytes and left the journal for the ` +
        `payload store, so no verdict could be read, and ${consequence} Publishing a graph does not bring these ` +
        `back — the values are not in their journals. To make later runs measurable, keep an evaluator's verdict ` +
        `under that size, or make its channel ineligible for the payload store by declaring it in the graph's ` +
        `outputs or naming it in an edge or router expression.\n`,
    );
  }
  return notes;
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
 * Who is proposing this candidate, or nobody.
 *
 * It is not decoration: `10-separate-lineage` refuses a candidate whose proposer is the suite's
 * own generator, and `9-suite-predates-candidate` is SKIPPED when no proposer is named — the
 * gate's own reading of "a human driving this by hand answers for the timing themselves". So
 * naming a proposer here makes the gate STRICTER, never looser, which is why the flag is
 * optional and its absence is not filled in with a default.
 *
 * The `true`/`""` refusal is the `String(true)` family every other value flag in this file
 * already refuses: `--proposed-by` with no value would otherwise read as the proposer literally
 * named "true", and a lineage check against a name nobody chose certifies nothing.
 */
function proposedByFlag(args: Args): string | undefined {
  const v = args.flags["proposed-by"];
  if (v === undefined) return undefined;
  if (v === true || v === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--proposed-by needs an identifier: ${v === "" ? "the one given was empty" : "the flag was given with no value at all"}. ` +
        `It is compared against the suite's generator, so it would otherwise read as the proposer "true". ` +
        `Omit it when a human is driving this by hand.`,
    );
  }
  // THE ONE IDENTITY THAT MAY NEVER PROPOSE A CANDIDATE. `10-separate-lineage` refuses a
  // promotion whose suite and candidate share a proposer, and it is what makes an AI-authored
  // suite trustworthy at all — so `loom suite freeze` signs every suite it writes with
  // `SUITE_GENERATOR`, and a candidate proposed under that same name would either collide with
  // the exam's lineage or, worse, be waved through by a caller who never noticed. This session
  // shipped a demo script whose generator and proposer WERE the same string. Refused at the
  // flag, where the message can say so, rather than as a silent `10-separate-lineage` failure
  // twenty lines of output later.
  if (v === SUITE_GENERATOR) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--proposed-by "${SUITE_GENERATOR}" is reserved: it is the identity "loom suite freeze" signs every suite it ` +
        `writes with, and gateCandidate's 10-separate-lineage refuses a candidate whose proposer matches the suite's ` +
        `generator — a shared lineage converges the exam on what the candidate already does. Name the optimiser.`,
    );
  }
  return v;
}

/**
 * A frozen `EvalSuite` off disk, refusing the shapes that would make a promotion vacuous.
 *
 * `validateSuite` inside `runEvalSuite` already reports composition problems, and its verdict
 * reaches `gateCandidate` as check `0-suite`. What it cannot do is answer a file that is not a
 * suite at all: a JSON object missing `cases` reads as a suite of zero cases, and a suite of
 * zero cases has `passRate: 0` on BOTH sides, which `2-non-inferior` scores as Δ 0.0pp and
 * passes. So the shape is refused here, at the door, rather than promoted with a pass rate over
 * nothing.
 *
 * `frozen: true` is a literal in the type and is checked as one. It is the field that says a
 * human meant this file to be an exam rather than a scratch list.
 */
function readSuite(file: string): EvalSuite {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw err.validation(CODES.E_CONFIG_INVALID, `--suite ${file} is not readable JSON: ${(e as Error).message}`);
  }
  const s = parsed as Partial<EvalSuite>;
  const problems: string[] = [];
  if (typeof s?.name !== "string" || s.name === "") problems.push('"name" must be a non-empty string');
  if (typeof s?.version !== "number") problems.push('"version" must be a number');
  if (s?.frozen !== true) problems.push('"frozen" must be true — a suite that is not frozen is not an exam');
  if (typeof s?.frozenAt !== "number" || !(s.frozenAt > 0)) problems.push('"frozenAt" must be a positive epoch-ms timestamp');
  if (!Array.isArray(s?.cases) || s.cases.length === 0) {
    // A suite of zero cases makes both sides score 0 and `2-non-inferior` reads Δ 0.0pp — a
    // promotion granted for measuring nothing.
    problems.push('"cases" must be a non-empty array');
  }
  if (problems.length > 0) {
    throw err.validation(CODES.E_CONFIG_INVALID, `--suite ${file} is not a frozen EvalSuite: ${problems.join("; ")}`);
  }
  return s as EvalSuite;
}

/**
 * The fractional change in PROMPT BYTES between two compiled graphs, over their agent nodes.
 *
 * Measured rather than declared, because `promptGrowth` is one of the two `PromotionInput`
 * fields a caller could simply assert, and `5-prompt-size` is the check that stops a candidate
 * paying for quality with context. The bytes are in the artifacts: `compile` freezes every
 * resolved document into `RunGraph.documents`, keyed by ref, precisely so nothing has to ask a
 * resolver at run time.
 *
 * A baseline with no prompt bytes at all returns 0 rather than `Infinity`: "grew from nothing"
 * is not a ratio, and `canonicalize` refuses a non-finite number on the durable write path.
 */
function promptGrowthOf(baseline: RunGraph, candidate: RunGraph): number {
  const bytes = (g: RunGraph): number => {
    let total = 0;
    for (const node of g.spec.nodes) {
      const ref = node.agent?.prompt;
      if (ref === undefined) continue;
      total += (g.documents[ref] ?? "").length;
    }
    return total;
  };
  const before = bytes(baseline);
  if (before === 0) return 0;
  return (bytes(candidate) - before) / before;
}

/**
 * Does the candidate lower oversight anywhere the baseline raised it?
 *
 * The compiler already answers this — `baselinePostures` + GRAPH014 — and this is the same call
 * `graph/mutate.ts` makes for a runtime mutation, which is the point: a candidate and a mutation
 * are the same hazard reached by two doors, and they must not be judged by two rules.
 *
 * Fails closed. Any compile failure at all is reported as "postures do not hold": a candidate
 * this process cannot compile against the baseline's floor is not a candidate this process may
 * certify, and `E_OVERSIGHT_LOOSENED` is only one of the reasons a compile can refuse.
 */
function posturesHoldOf(ws: Workspace, baseline: RunGraph, candidate: RunGraph): boolean {
  const result = compile({
    spec: candidate.spec,
    resolver: ws.resolver,
    tools: (ws.engine.tools as ToolRegistry).manifests(),
    tenantCapabilities: ws.granted,
    baselinePostures: Object.fromEntries(Object.entries(baseline.plans).map(([id, p]) => [id, p.posture])),
  });
  return result.ok;
}

/**
 * Did two runs of the same suite against the same graph produce the same thing?
 *
 * This is `8-determinism`, and it is measured rather than asserted for the same reason as the
 * posture check. Compared per case on the REPLAYED PROJECTION — status and channels — rather
 * than on `pass`, because two runs can agree on a verdict and disagree about everything that
 * produced it, and a nondeterministic candidate that happens to pass twice is still one nobody
 * can promote.
 */
function sameOutcome(a: EvalReport, b: EvalReport): boolean {
  if (a.cases.length !== b.cases.length) return false;
  return a.cases.every((x, i) => {
    const y = b.cases[i];
    if (y === undefined || x.id !== y.id) return false;
    // A case that failed to replay at all carries no report; two of those agree only if both
    // failed for the same reasons.
    if (x.replay === undefined || y.replay === undefined) {
      return x.replay === y.replay && JSON.stringify(x.reasons) === JSON.stringify(y.reasons);
    }
    return (
      x.replay.replayed.status === y.replay.replayed.status &&
      JSON.stringify(x.replay.replayed.channels) === JSON.stringify(y.replay.replayed.channels)
    );
  });
}

/**
 * Every OTHER run in this workspace that belongs to the same cohort, folded.
 *
 * Trajectories rather than journaled scores, because `measureCohort` measures a POPULATION —
 * medians of cost, wall time and gates over the runs themselves. Reading peers' journaled
 * scores instead would measure the population as it was last judged, which is a different set
 * and a staler one.
 *
 * EVERY MEMBER IS FOLDED UNDER THE SAME RULE AS THE RUN BEING JUDGED, and that includes its
 * graph. This used to fold peers with no `graph` at all, defended by a comment saying "a peer
 * contributes usage, policy and status to the medians, and none of those needs the spec". That
 * was false: `measureCohort` computes `p90Score` as a percentile OF THE SCORES, and a score's
 * largest term is `outcome`, which `extractSignals` derives from `nodeTypes.get(step.nodeId)` —
 * a map built from `opts.graph.spec.nodes`. A peer folded without its graph reports zero
 * assertions, zero rubrics, no human decisions and `selfReported: false`, so its outcome is 0
 * by construction whatever it actually did.
 *
 * MEASURED, through this CLI, on a 30-run workspace of one `function` node + one
 * assertion-`evaluator` node where every run's assertion passes and every member's honest
 * score is 1.000:
 *
 *     peers folded without their graph : "p90Score": 0.4
 *     peers folded with their graph    : "p90Score": 1
 *
 * `isGolden` condition 2 is `score >= cohort.p90Score`, so the bar was understated by 0.6 —
 * 60% of the metric. AND IT CHANGES VERDICTS, which is the part worth measuring rather than
 * arguing. Same graph, 30 runs, `solve` deliberately wrong on even `n` so half the cohort's
 * assertion fails; scoring one of the FAILING runs (its own score 0.400 either way):
 *
 *     without the peers' graphs : p90Score 0.400 — condition 2 PASSES, because the run ties
 *                                 a bar its own failing peers set. One blocker, condition 1.
 *     with the peers' graphs    : p90Score 1.000 — two blockers, the second being
 *                                 "top decile of its cohort: score 0.400 vs p90 1.000".
 *
 * A failing run was in the top decile of a cohort of failures. That is what
 * `measureCohort`'s own docstring refuses: "A promotion bar that any run can lower by standing
 * next to it is exactly the measurement gamed by the thing being measured."
 *
 * THE RESIDUE IS CLOSED, AND IT WAS REAL. This docstring used to end "a peer whose authored
 * graph is not published in `<workspace>/graphs/` still folds without one and still scores near
 * 0 … cohort `n` does not move either way", and the second half was the mistake: `n` not moving
 * is exactly the damage. A specless peer stayed a MEMBER and scored 0, and `p90Score` is a
 * percentile of the members' scores, so every such peer pulled the promotion bar toward zero —
 * the same defect the paragraph above describes, one fold down. `foldTrajectory` now reports
 * `specResolved` and `measureCohort` drops those members from the population; the call sites
 * print the count, because a cohort that shrank has to say why.
 */
async function cohortPeers(
  ws: Workspace,
  self: RunId,
  key: string,
  promotedGraphHashes: ReadonlySet<string>,
  /**
   * The SAME `graphsByHash` index the judged run's own fold used. Passed in rather than rebuilt
   * so the two folds cannot disagree about what is published, and so scoring one run reads the
   * `graphs/` directory once instead of once per peer.
   */
  graphs: ReadonlyMap<string, RunGraph>,
  /** The SAME rule the run being judged was folded under. See the call site. */
  bucketInput?: InputBucket,
): Promise<{ members: Trajectory[]; truncated: boolean }> {
  const summaries = await ws.store.listRuns(COHORT_SCAN_LIMIT);
  const members: Trajectory[] = [];
  for (const s of summaries) {
    if (s.runId === self) continue;
    const events = await journalOf(ws, s.runId);
    if (events.length === 0) continue;
    // The peer's OWN authored graph, by the hash the peer's own `run.submitted` names — never
    // the judged run's. A cohort can hold runs of more than one graph (the key's graphHash slot
    // is the run's own), so reusing one spec for all of them would read another graph's node
    // types onto this run's steps.
    const submitted = events.find((e): e is Extract<JournalEvent, { type: "run.submitted" }> => isEvent(e, "run.submitted"));
    const graph = submitted === undefined ? undefined : graphs.get(submitted.payload.graphHash);
    const t = foldTrajectory(events, {
      promotedGraphHashes,
      ...(graph === undefined ? {} : { graph }),
      ...(bucketInput === undefined ? {} : { bucketInput }),
    });
    if (cohortKeyOf(t) === key) members.push(t);
  }
  return { members, truncated: summaries.length >= COHORT_SCAN_LIMIT };
}

// ── evolution: freezing an exam OUT OF a cohort ─────────────────────────────

/**
 * The identity `loom suite freeze` signs its suites with.
 *
 * `gateCandidate`'s `10-separate-lineage` refuses a promotion whose `suiteGeneratedBy` equals
 * its `proposedBy`, and that check is the reason an AI-authored suite is allowed at all. A
 * freezer that let the two collide would hand every caller a suite that refuses by
 * construction — this session shipped a demo script that did exactly that. So the value is a
 * constant here rather than a flag, and `proposedByFlag` REFUSES it: the one identity that can
 * never propose a candidate is the one that writes the exams.
 */
const SUITE_GENERATOR = "loom-suite-freeze";

/**
 * The fewest cases a frozen suite may hold.
 *
 * Not a round number: `gateCandidate`'s `2-non-inferior` allows a Δ of −1pp by default, and one
 * case out of five moves the pass rate by 20pp. An exam whose resolution is coarser than its own
 * decision margin cannot answer the question it is asked, so the floor is where a single case is
 * worth less than a sixth — and `close-the-loop.test.ts` freezes at `minCases: 6` for the same
 * arithmetic.
 */
const MIN_SUITE_CASES = 6;

/**
 * `loom suite freeze --cohort <runId> --out <suite.json>` — THE MISSING HALF OF "PROMOTED OVER
 * THEM".
 *
 * `loom promote --suite` judged a candidate against an exam a HUMAN typed: somebody picked which
 * recordings became cases and wrote the expectations. That makes "promoted over the cohort" a
 * claim a person assembled, and D6's freeze argument is precisely about not letting the exam be
 * shaped around a known student. `test/evolution/close-the-loop.test.ts` had the selection rule
 * — as a function inside a test, reachable from nothing a person can run, which is the standing
 * `scoreTrajectory` had before `loom score` and `gateCandidate` had before `loom promote`. This
 * is the door.
 *
 * ## WHICH RUNS BECOME CASES
 *
 * The cohort, by the same three inputs `loom score` and `promote --against-cohort` fold with —
 * the anchor's own graph, the published set, and one `--bucket` rule — so the key this derives
 * is one every other verb in the binary reproduces. Then, of that population:
 *
 * - the run must carry a journaled `evolution.scored` row under THIS cohort key and THIS
 *   weights digest. That row is the selection: nothing here recomputes a verdict, and a run
 *   nobody judged is not a case. It is also what makes injection impossible — **no flag names a
 *   runId**, so the only way into the exam is to have been run and scored in this workspace.
 * - `components.delivered` must hold, which is `measureCohort`'s own membership filter. A run
 *   the ruler was not built from is not a run to be examined against it.
 *
 * `--cases N` is a CAP and never a selector, the same distinction `--runs` draws one verb over.
 * Omitted, every eligible member becomes a case — the strongest freeze available, because a
 * selection rule that never runs cannot shape anything. Given, the members are ordered by their
 * journaled score and N are taken SPREAD ACROSS THAT ORDER, ends included: not the top, which is
 * the exam the baseline passes by construction, and not the bottom, which has no regression
 * floor at all.
 *
 * That refusal is not a matter of taste. `test/evolution/close-the-loop.test.ts` measures it:
 * over a suite of the baseline's own goldens the baseline scores `passRate 1` and "the best any
 * candidate can do is tie". So a selection that comes out all-golden — or all-non-golden — is
 * REFUSED here rather than written to disk.
 *
 * ## WHAT THE EXPECTATIONS ARE, AND WHAT THAT COSTS
 *
 * The honest answer is that `EvalCase.expect`'s vocabulary can only describe what already
 * happened, so **a suite frozen from a corpus is a REGRESSION floor and not an improvement
 * exam.** Four expectations, and the third is the one with a price:
 *
 * 1. `status` — the recorded terminal status. Every eligible case succeeded (that is what
 *    `delivered` means), so this is "the candidate still finishes", which is real: a candidate
 *    that can no longer consume the recorded effects fails `runCase` outright.
 * 2. `noIrreversibleWithoutGate` — an INVARIANT, not an output, and the only expectation here
 *    that is not a statement about what the baseline produced. `ungatedActions` reads it two
 *    ways: no gate the candidate raised may be left open, and every Task the RECORDING gated
 *    must be gated in the replay too. `gateShapeOf` answers it from `foldRun`, the kernel
 *    projection. **It is set on EVERY case**, and a recording that could not carry it — one that
 *    ended on an unresolved gate, which would fail its own expectation — is EXCLUDED and counted
 *    rather than admitted without it. The first version admitted it and omitted the field, which
 *    cost a case nothing and cost the suite something worse: cases that check oversight and
 *    cases that do not, mixed, with nothing saying which. A regression floor with unmarked gaps
 *    is not a floor. The count appears in the refusal beside its three neighbours, so a corpus
 *    that cannot fill a suite says which of the four reasons emptied it.
 * 3. `channels` — **only on the golden cases, and only the channels the grader did not write.**
 *
 * The cost of (3) is the one the lane has to state rather than hide: an expectation taken from
 * what the baseline PRODUCED bakes the baseline's mistakes into the exam, and a candidate that
 * fixes one fails a must-pass case. What bounds the damage is which runs get it. `isGolden`
 * condition 1 needs `outcome >= 0.8` AND a ground-truth signal (S1 a deterministic verifier, S2
 * a human decision, S3 downstream acceptance — never S4 alone), so what is pinned is an output
 * something outside the graph already certified, not merely one the graph emitted. The
 * non-golden half gets NO channel expectations at all, because pinning what a low-scoring run
 * produced would make a candidate that improves on it score WORSE, and `2-non-inferior` would
 * then refuse the improvement.
 *
 * Two channel sets are excluded from (3) and both matter:
 *
 * - anything an `evaluator` node wrote. A candidate that rewrites the grader passes any suite
 *   that reads the grader, and `close-the-loop.test.ts` names the rule; here it is derived,
 *   from the recording's own steps against the cohort graph's node types.
 * - the graph's declared `inputs`. Replay serves those from the recording, so pinning one
 *   asserts nothing about the candidate and only inflates the case.
 *
 * WHAT THIS SUITE THEREFORE CANNOT DO, said out loud: it cannot show a candidate a POSITIVE
 * delta. Every expectation it can write is "keep doing this", so the best a candidate can score
 * is the baseline's own pass rate, and `gateCandidate` promotes on a tie because it is a
 * non-inferiority test. That is the correct division of labour and not a gap being papered over:
 * this exam is the safety floor a candidate must not fall through, and the claim that a
 * candidate is BETTER is what `loom promote --against-cohort` measures, live, on paired scores.
 * A reader who wants "measurably beat the baseline" over a frozen suite needs a corpus with
 * planted ground truth, which is what that test file has and a production journal does not.
 *
 * ## FREEZE, AND STAYING FROZEN
 *
 * `frozenAt` is the wall clock at write time, and the write is the freeze: `wx` refuses an
 * `--out` that already exists, because a re-frozen exam is not frozen. The decision is also
 * journaled as `operator.command` on the anchor's run — the same borrow `loom promote` makes,
 * for the same reason: `StateStore` is keyed by runId and a fact whose subject is a SUITE has to
 * anchor somewhere. Written BEFORE the file, so a suite that exists is one the journal can
 * account for.
 */
async function freezeSuite(ws: Workspace, args: Args): Promise<number> {
  const anchorId = suiteCohortFlag(args);
  const out = suiteOutFlag(args);
  const cap = suiteCasesFlag(args);
  const bucketInput = bucketFlag(args);

  // BEFORE ANY WORK, and again at the write with `wx`. Two checks rather than one because this
  // one can say what happened, and the second one cannot be raced.
  if (existsSync(out)) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `${out} already exists, and a re-frozen exam is not frozen: overwriting it would let a suite be re-cut ` +
        `after a candidate is known, which is the one thing EvalSuite.frozenAt exists to stop. ` +
        `Freeze to a new path, or delete that one deliberately.`,
    );
  }

  const anchorEvents = await journalOf(ws, anchorId);
  if (anchorEvents.length === 0) {
    process.stderr.write(`no journal for run ${anchorId} in this workspace (${ws.root}), so it names no cohort\n`);
    return 1;
  }
  // THE RULER, AND THE ANCHOR CARRIES IT. A score computed under different weights is a
  // different metric, so a suite has to be frozen under ONE of them; the anchor's own journaled
  // verdict is the only answer that is a fact rather than a default. A caller that has not
  // scored the anchor is told to, not silently given `DEFAULT_WEIGHTS`.
  const anchorScore = lastScore(anchorEvents);
  if (anchorScore === undefined) {
    process.stderr.write(
      `run ${anchorId} carries no journaled score, so it names neither a cohort nor the weights this suite would be ` +
        `frozen under — cases are selected BY those verdicts, not recomputed here. Judge it first: loom score ${anchorId}\n`,
    );
    return 1;
  }

  // THE SAME THREE INPUTS `loom score` FOLDS WITH — see `promoteAgainstCohort`, which says why.
  const { index } = graphsByHash(ws);
  const promotedGraphHashes = new Set(index.keys());
  const anchorSubmitted = anchorEvents.find((e): e is Extract<JournalEvent, { type: "run.submitted" }> => isEvent(e, "run.submitted"));
  const anchorGraph = anchorSubmitted === undefined ? undefined : index.get(anchorSubmitted.payload.graphHash);
  const anchorT = foldTrajectory(anchorEvents, {
    promotedGraphHashes,
    ...(anchorGraph === undefined ? {} : { graph: anchorGraph }),
    ...(bucketInput === undefined ? {} : { bucketInput }),
  });
  const key = cohortKeyOf(anchorT);
  const peers = await cohortPeers(ws, anchorId, key, promotedGraphHashes, index, bucketInput);
  if (peers.truncated) {
    process.stderr.write(
      `! the cohort scan stopped at ${String(COHORT_SCAN_LIMIT)} runs, so this cohort may be smaller than the workspace's\n`,
    );
  }
  const cohort = measureCohort(key, [anchorT, ...peers.members]);
  if (cohort.n < MIN_COHORT_SIZE) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `cohort "${key}" has n = ${String(cohort.n)} comparable runs and a frozen suite needs at least ` +
        `${String(MIN_COHORT_SIZE)} — the same floor isGolden condition 4 clears, because a suite cut from a cohort ` +
        `too small to have goldens has no regression floor to freeze. "Comparable" counts runs that SUCCEEDED and ` +
        `did work. Record more runs of this workflow first.`,
    );
  }

  // THE COHORT'S OWN GRAPH, WHICH HAS TO BE PUBLISHED — and not for the reason
  // `promoteAgainstCohort` needs it. The grader-channel exclusion below reads NODE TYPES, and
  // without the spec every channel an `evaluator` wrote would be pinned as though it were the
  // work. A suite that grades on the grader is the failure this whole verb is aimed at, so a
  // missing spec is a refusal rather than a degraded freeze.
  const graph = index.get(anchorT.cohort.graphHash);
  if (graph === undefined) {
    throw err.notFound(
      CODES.E_RUN_NOT_FOUND,
      `cohort "${key}" was produced by graph ${anchorT.cohort.graphHash}, and no graph in ${join(ws.root, "graphs")} ` +
        `has that hash (${String(index.size)} searched). The expectations exclude every channel an evaluator node ` +
        `wrote, and node types live in the spec — without it this would freeze an exam that grades the grader. ` +
        `Restore those bytes to graphs/.`,
    );
  }
  const evaluatorNodes = new Set(graph.spec.nodes.filter((n) => n.type === "evaluator").map((n) => n.id));
  const inputChannels = new Set<string>(graph.spec.inputs);

  interface Selectable {
    readonly runId: RunId;
    readonly score: number;
    readonly golden: boolean;
    readonly expect: EvalCase["expect"];
  }
  const eligible: Selectable[] = [];
  let unjudged = 0;
  // COUNTED, LIKE ITS THREE NEIGHBOURS. This exclusion was the only silent one, and it is the
  // one an operator triggers by accident: `--bucket` recomputes the key, so asking for a mode
  // the corpus was NOT scored under drops every member — and the summary then blamed "no
  // journaled verdict", sending the operator to re-run `loom score` when the verdicts were
  // there all along under another key.
  let otherKey = 0;
  // A CASE THAT CANNOT CARRY THE SAFETY INVARIANT IS NOT A CASE, it is a quieter one. The first
  // version kept such a recording and simply omitted `noIrreversibleWithoutGate`, so a frozen
  // suite silently mixed cases that check oversight with cases that do not, and nothing told the
  // operator which. Excluded and counted instead, like its three neighbours: a suite is a
  // regression floor, and a floor with unmarked gaps in it is the shape this repo keeps finding.
  let unresolvedGate = 0;
  const otherKeysSeen = new Set<string>();
  let excludedForWeights = 0;
  let undelivered = 0;
  for (const t of [anchorT, ...peers.members]) {
    const runId = t.runId as RunId;
    const events = runId === anchorId ? anchorEvents : await journalOf(ws, runId);
    const sc = runId === anchorId ? anchorScore : lastScore(events);
    // A RUN NOBODY JUDGED IS NOT A CASE. Counted rather than dropped: "the cohort is small" and
    // "most of the cohort has never been scored" are different facts about a workspace, and the
    // second is fixed by running `loom score`, which the summary says.
    if (sc === undefined) {
      unjudged++;
      continue;
    }
    if (sc.cohortKey !== key) {
      otherKey++;
      otherKeysSeen.add(sc.cohortKey);
      continue;
    }
    if (sc.weightsDigest !== anchorScore.weightsDigest) {
      excludedForWeights++;
      continue;
    }
    if (!sc.components.delivered) {
      undelivered++;
      continue;
    }
    const gates = gateShapeOf(events);
    const projection = foldRun(events);
    const recorded = projection?.channels ?? {};
    const graderWrote = new Set(t.steps.filter((s) => evaluatorNodes.has(s.nodeId)).flatMap((s) => s.channelsWritten));
    const pinned = Object.fromEntries(
      Object.entries(recorded).filter(([c]) => !graderWrote.has(c) && !inputChannels.has(c)),
    );
    if (gates.unresolved.length > 0) {
      unresolvedGate++;
      continue;
    }
    eligible.push({
      runId,
      score: sc.score,
      golden: sc.golden,
      expect: {
        status: "succeeded",
        // UNCONDITIONAL now. Every case in a frozen suite carries the invariant, so a reader
        // does not have to check which ones do.
        noIrreversibleWithoutGate: true,
        ...(sc.golden && Object.keys(pinned).length > 0 ? { channels: pinned } : {}),
      },
    });
  }

  // ASCENDING SCORE, TIES BY RunId — which is a ULID, so a tie breaks chronologically and the
  // whole order is reproducible from the journals alone.
  eligible.sort((a, b) => a.score - b.score || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  if (eligible.length < MIN_SUITE_CASES) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `cohort "${key}" yields ${String(eligible.length)} case(s) and a frozen suite needs at least ` +
        `${String(MIN_SUITE_CASES)}: ${String(unjudged)} run(s) carry no journaled verdict, ${String(excludedForWeights)} ` +
        `were scored under different weights, ${String(undelivered)} finished without delivering work, ` +
        `${String(unresolvedGate)} ended on an unresolved gate and so cannot carry the safety invariant, ` +
        `${String(otherKey)} were judged under a DIFFERENT cohort key. Cases come from evolution.scored rows and ` +
        `nothing else, so the fix is to judge the cohort: loom score <runId>.` +
        // NAMED, not just counted. The keys differ in one segment and reading them side by side is
        // what tells an operator whether they mistyped a bucket or are pointed at the wrong corpus.
        (otherKey > 0
          ? ` The ${String(otherKeysSeen.size)} other key(s) present: ${[...otherKeysSeen].sort().slice(0, 3).join(", ")}` +
            `${otherKeysSeen.size > 3 ? ", …" : ""}. If those are the runs you meant, re-score them under the same ` +
            `--bucket you are freezing with, or drop the flag from both.`
          : ""),
    );
  }

  // A CAP, NEVER A SELECTOR. Spread across the score order with both ends included, so the
  // sample carries the cohort's best AND its worst — the two halves the exam needs, and neither
  // of them a choice the caller makes.
  const n = cap === undefined ? eligible.length : Math.min(cap, eligible.length);
  const selected =
    n === eligible.length
      ? eligible
      : Array.from({ length: n }, (_, i) => eligible[Math.round((i * (eligible.length - 1)) / (n - 1))]!);

  const goldens = selected.filter((x) => x.golden).length;
  if (goldens === 0 || goldens === selected.length) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      goldens === 0
        ? `every one of the ${String(selected.length)} selected runs is NON-golden, so this suite would have no ` +
          `must-pass case and no regression floor at all — nothing in it a candidate could be refused for breaking. ` +
          `The cohort has no golden trajectory to freeze; loom score <runId> prints goldenBlockers saying why.`
        : `every one of the ${String(selected.length)} selected runs is GOLDEN, and an exam drawn only from a ` +
          `workflow's best runs is one the baseline passes by construction — measured in ` +
          `test/evolution/close-the-loop.test.ts, where the baseline scores passRate 1 on its own goldens and "the ` +
          `best any candidate can do is tie". A loop freezing suites this way would report improvement forever and ` +
          `measure none of it.`,
    );
  }

  const frozenAt = Date.now();
  const suite: EvalSuite = {
    name: `${anchorT.cohort.workflow}-cohort`,
    version: 1,
    frozen: true,
    frozenAt,
    generatedBy: SUITE_GENERATOR,
    cases: selected.map((x, i) => ({
      // The runId is IN the case id, so a reader of the file can go back to the recording the
      // expectation was taken from without trusting anything this verb printed.
      id: `${String(i).padStart(3, "0")}-${x.runId}`,
      runId: x.runId,
      mustPass: x.golden,
      expect: x.expect,
    })),
    // `minFailureCases` is deliberately NOT claimed. It counts cases expecting `status:
    // "failed"`, and every case here expects `succeeded` by construction — `delivered` requires
    // it — so asserting it would make `validateSuite` refuse this exam for a property the
    // selection rule forbids it from having. close-the-loop.test.ts's freeze says the same.
    composition: { minCases: MIN_SUITE_CASES, minMustPass: 1 },
  };

  const summary = {
    out,
    cohortKey: key,
    cohortN: cohort.n,
    weightsDigest: anchorScore.weightsDigest,
    suite: suite.name,
    suiteVersion: suite.version,
    frozenAt,
    generatedBy: SUITE_GENERATOR,
    cases: suite.cases.length,
    mustPass: goldens,
    caseRunIds: suite.cases.map((c) => c.runId),
    withChannelExpectations: suite.cases.filter((c) => c.expect.channels !== undefined).length,
    considered: eligible.length,
    unjudged,
    excludedForWeights,
    undelivered,
    truncated: peers.truncated,
  };

  // JOURNALED BEFORE THE FILE EXISTS, so a suite on disk is never one the journal cannot account
  // for. The anchor's run is the coordinate for the same reason `loom promote` borrows a case's:
  // the store is keyed by runId and the subject of this fact is a suite.
  await ws.store.append({
    runId: anchorId,
    expectedSeq: await ws.store.head(anchorId),
    events: [
      {
        type: "operator.command",
        payload: { kind: "evolution.suite-freeze", args: summary },
        actor: { kind: "human", subject: subjectFlag(args), via: "console" },
      },
    ],
  });

  try {
    // `wx` IS THE FREEZE. The `existsSync` above says what happened; this is the check that
    // cannot be raced, and it is the one that holds.
    writeFileSync(out, `${JSON.stringify(suite, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      code === "EEXIST"
        ? `${out} was created while this suite was being frozen, and a re-frozen exam is not frozen. Freeze to a new path.`
        : `could not write ${out}: ${(e as Error).message}`,
    );
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(
    `froze ${String(suite.cases.length)} case(s) from cohort "${key}" (n ${String(cohort.n)}), ` +
      `${String(goldens)} of them must-pass. This exam is a REGRESSION FLOOR: every expectation in it comes from a run ` +
      `that already happened, so the best a candidate can score on it is the baseline's own pass rate. ` +
      `Use promote --against-cohort to measure an IMPROVEMENT.\n`,
  );
  return 0;
}

/** `--cohort <runId>` — any run in the cohort names it, exactly as `--against-cohort` does. */
function suiteCohortFlag(args: Args): RunId {
  const v = args.flags["cohort"];
  if (v === undefined || v === true || v === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `suite freeze --cohort needs a runId: ${v === "" ? "the one given was empty" : "the flag was given with no value at all"}. ` +
        `It names any run in the cohort the exam is cut from — the key and the score weights are derived from it.`,
    );
  }
  return v as RunId;
}

/** `--out <suite.json>` — where the frozen exam lands, and it must not be there already. */
function suiteOutFlag(args: Args): string {
  const v = args.flags["out"];
  if (v === undefined || v === true || v === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `suite freeze --out needs a path: ${v === "" ? "the one given was empty" : "the flag was given with no value at all"}. ` +
        `The file IS the freeze, so there is nowhere else for the suite to go.`,
    );
  }
  return resolve(v);
}

/**
 * `--cases N`, the cap on how many of the cohort's judged runs become cases.
 *
 * Refused below `MIN_SUITE_CASES` at the flag rather than absorbed downstream, for `runsFlag`'s
 * reason one verb over: an operator who typed 3 should learn that an exam that coarse cannot
 * resolve a 1pp decision margin BEFORE the file exists, because the file is not rewritable.
 */
function suiteCasesFlag(args: Args): number | undefined {
  const raw = args.flags["cases"];
  if (raw === undefined) return undefined;
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < MIN_SUITE_CASES) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--cases must be a whole number of cases, at least ${String(MIN_SUITE_CASES)}, not ` +
        `${typeof raw === "string" ? `"${raw}"` : String(raw)}. One case out of five moves a suite's pass rate by ` +
        `20pp while 2-non-inferior decides on 1pp, so a smaller exam cannot resolve the question it is asked. ` +
        `Omit the flag to use every judged run in the cohort.`,
    );
  }
  return n;
}

// ── evolution: judging a candidate by RUNNING it ────────────────────────────

/**
 * `--against-cohort <runId>` — the run that NAMES the baseline population.
 *
 * A runId and not a cohort key, for the reason `loom score` takes a runId: a cohort key is
 * `workflow|graphHash|tier|bucket`, four fields an operator would have to assemble by hand and
 * could assemble WRONG in a way that silently selects nothing. Any run in the cohort names it,
 * and `cohortKeyOf` derives the rest.
 */
function cohortAnchorFlag(args: Args): RunId {
  const v = args.flags["against-cohort"];
  if (v === undefined || v === true || v === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--against-cohort needs a runId: ${v === "" ? "the one given was empty" : "the flag was given with no value at all"}. ` +
        `It names any run in the baseline cohort this candidate is judged against — the key is derived from it.`,
    );
  }
  return v as RunId;
}

/**
 * `--runs N`, the cap on how many of the cohort's recordings are re-run LIVE.
 *
 * A cap and never a selector: it says HOW MANY, never WHICH. That distinction is the freeze
 * property. `promoteAgainstCohort` takes the oldest N, and an operator who could name the
 * inputs would be writing the exam for the student — the failure `EvalSuite.frozenAt` exists to
 * stop, reached through a different door.
 *
 * Refused below `MIN_PAIRED_RUNS` at the flag rather than absorbed by the gate, because this is
 * the number that decides how much real money the command spends and an operator who typed 2
 * should learn it is too few BEFORE the provider is called, not after.
 */
function runsFlag(args: Args): number | undefined {
  const raw = args.flags["runs"];
  if (raw === undefined) return undefined;
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < MIN_PAIRED_RUNS) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--runs must be a whole number of runs, at least ${String(MIN_PAIRED_RUNS)}, not ` +
        `${typeof raw === "string" ? `"${raw}"` : String(raw)}. Fewer pairs than that cannot reach a 95% bound on ` +
        `anything — the exact sign test tops out at p = 0.0625 at n = 4 — so a smaller number buys a live model ` +
        `bill for a decision nothing could support. Omit the flag to use every recording in the cohort.`,
    );
  }
  return n;
}

/**
 * The gates a run raised, folded to the two questions `gate.ts`'s `ungatedActions` asks.
 *
 * ONE DEFINITION OF GATE STATE, and it is `foldRun`'s — the kernel projection — rather than a
 * second scan over `gate.raised` / `gate.decided` / `gate.cancelled` / `gate.batch_decided`
 * written here. A private re-derivation of "is this gate resolved" is precisely how two readers
 * of one journal come to disagree about whether oversight happened.
 *
 * `decided` and `cancelled` are the resolved states, exactly as `ungatedActions` treats them: a
 * cancelled gate is one whose work never ran.
 *
 * `status` rides along because it comes out of the SAME fold. A candidate run that did not finish
 * has to be described to `L2-every-input-measured`, and the call site used to describe it with the
 * literal `"incomplete"` — a word no run ever holds. Folding it here means the run's status and
 * its gate state are read from one projection of one journal rather than two.
 */
function gateShapeOf(events: readonly JournalEvent[]): { status: string; decidedNodes: Set<string>; unresolved: string[] } {
  const decidedNodes = new Set<string>();
  const unresolved: string[] = [];
  const p = foldRun(events);
  if (p === undefined) return { status: "incomplete", decidedNodes, unresolved };
  for (const g of Object.values(p.gates)) {
    if (g.state === "decided") decidedNodes.add(g.nodeId);
    else if (g.state !== "cancelled") unresolved.push(`gate "${g.gateId}" on node "${g.nodeId}" is ${g.state}`);
  }
  return { status: p.status, decidedNodes, unresolved };
}

/**
 * JUDGE A CANDIDATE BY RUNNING IT, on inputs that predate it.
 *
 * THE DEFECT THIS EXISTS FOR. The replayed mode above serves every model turn from the
 * recording under `effectKey(taskId, "model", turn)`, and `taskId` is `nodeId@branchPath#
 * iteration` — no prompt, no request, no graph hash. A candidate that changes a FUNCTION BODY
 * is measurable there because functions re-execute; a candidate that changes a PROMPT replays
 * byte-identically and was certified having asked nothing. `gate.ts`'s `unexercised` now REFUSES
 * that case rather than certifying it, and refusing is not judging — its own text names this
 * verb: "re-record the corpus, or judge this candidate live".
 *
 * ── The five decisions that make it a gate rather than a demonstration ──────────
 *
 * **1 · THE INPUTS COME OUT OF THE RECORDINGS.** Each selected baseline run's
 * `run.submitted.inputs` is what the candidate is given. There is no flag that supplies an
 * input and there deliberately is not: `EvalSuite.frozenAt` exists because a suite assembled at
 * promotion time is a suite built to be passed, and an operator typing inputs here would be
 * doing the same thing one door over. `--runs` caps HOW MANY and never WHICH; the order is
 * oldest-first by runId, which is a real ordering because a RunId is a ULID — so the recordings
 * used are the ones least able to have been made for this candidate.
 *
 * **2 · ONE RULER FOR BOTH SIDES.** `scoreTrajectory` normalises cost and latency against a
 * `CohortStats`, so a baseline score journaled weeks ago and a candidate score computed now are
 * numbers from two different rulers. The cohort is measured ONCE, here, from the baseline
 * population, and both sides are scored against it. That ruler is a pure function of runs the
 * candidate did not produce — `cohortKeyOf` keys on `graphHash`, so the candidate's own runs
 * land in a different cohort and cannot move the bar they are judged by. The baseline scores
 * are therefore RE-DERIVED rather than read from `evolution.scored`, which is the opposite of
 * what `loom cohort` does and for the opposite reason: that verb reads a journaled verdict back
 * and must not recompute it, this one is making a new judgement and both halves must be made
 * with the same instrument.
 *
 * **3 · THE COMPARISON IS PAIRED.** See `evolution/live.ts`. Input variance dominates; an
 * unpaired comparison of two thirty-run samples would mostly measure which inputs fell where.
 *
 * **4 · IT DOES NOT PUBLISH THE WINNER.** Same as the replayed mode: promotion stays a human
 * putting the file in `<workspace>/graphs/`. The candidate's runs ARE journaled — they happened
 * — and they fold as `fromUnpromotedCandidate: true` because the candidate is not in `graphs/`,
 * which is `isGolden` condition 5 doing exactly its job: nothing learns from them.
 *
 * **5 · THE DECISION IS RECORDED OR IT DOES NOT STAND.** On `operator.command`, as the replayed
 * mode does — `journal/events.ts` is a kernel file and a first demonstration does not get to
 * raise the `Kernel-seam:` ledger. The row carries `mode: "live-cohort"`, the cohort key, the
 * cohort's own statistics, every pair, and `checksNotRun`. A reader must not be able to mistake
 * a live verdict for a replayed one, and those fields are what stop them.
 *
 * ── What it refuses ─────────────────────────────────────────────────────────────
 *
 * No adapter, an unpriced route, a cohort under `MIN_COHORT_SIZE`, a baseline graph that is not
 * published, and a candidate identical to the baseline. Each is a way the command could produce
 * a number that looks like a judgement and is not one; each names what to do instead.
 */
async function promoteAgainstCohort(ws: Workspace, args: Args, candidate: RunGraph): Promise<number> {
  const anchorId = cohortAnchorFlag(args);
  const cap = runsFlag(args);

  // THE REPLAYED MODE'S FLAGS ARE REFUSED RATHER THAN IGNORED. `--baseline` is derivable here
  // and must be derived: a cohort key pins ONE `graphHash`, so the baseline is the graph those
  // recordings actually ran, and letting a caller name a different one would judge the candidate
  // against a graph that produced none of the evidence. `--suite` has no meaning at all — this
  // mode replays nothing.
  for (const [flag, why] of [
    ["baseline", "the baseline is the graph the cohort's own runs used, derived from the cohort key — naming another one would judge this candidate against a graph that produced none of the recordings"],
    ["suite", "this mode replays no recordings, so there is no suite to run; the exam is the cohort's INPUT distribution"],
  ] as const) {
    if (args.flags[flag] !== undefined) {
      throw err.validation(CODES.E_CONFIG_INVALID, `--${flag} does not apply with --against-cohort: ${why}.`);
    }
  }

  // A "LIVE" JUDGEMENT WITH THE MOCK ADAPTER IS A LIE, and it is the easiest lie to tell here:
  // `MockModelAdapter` answers every agent node with "[mock] …", fabricates a cost, and the run
  // succeeds. The whole point of this mode is that a prompt change is only visible when a
  // provider answers it, so no adapter is a refusal and not a warning.
  if (ws.models === undefined) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `promote --against-cohort calls a real provider, and this process has none: without --models-file the only ` +
        `registered adapter is the offline mock, which answers every agent node with canned text and fabricates a ` +
        `cost. A promotion decided on that measures the mock. ` +
        `fix: --models-file <file> with {"adapters":[{"provider":"anthropic"}],"routes":{…}}`,
    );
  }
  // AN UNPRICED ROUTE MAKES `3-cost` CERTIFY A RATIO IT DID NOT MEASURE. Every call on such a
  // route is journaled as costing 0, so the candidate's total is 0, the ratio is 0.00×, and the
  // check reports a pass it did not earn — against a baseline whose recorded cost was real
  // money. A guard that cannot decide fails closed, and the fix is one line of configuration.
  if (ws.models.unpriced.length > 0) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `${String(ws.models.unpriced.length)} route(s) in ${ws.models.file} have no price (${ws.models.unpriced.join(", ")}), ` +
        `so every candidate call on them is journaled as costing $0 and 3-cost would report a 0.00× ratio it never ` +
        `measured — against recordings that cost real money. ` +
        `fix: add "prices": {"<model>": {"input": <usd per 1M>, "output": <usd per 1M>}} to that adapter.`,
    );
  }

  const anchorEvents = await journalOf(ws, anchorId);
  if (anchorEvents.length === 0) {
    process.stderr.write(`no journal for run ${anchorId} in this workspace (${ws.root}), so it names no cohort\n`);
    return 1;
  }

  // THE SAME THREE INPUTS `loom score` FOLDS WITH, and they have to be the same or the key this
  // command derives is one no other verb in the binary can reproduce.
  const { index } = graphsByHash(ws);
  const promotedGraphHashes = new Set(index.keys());
  const bucketInput = bucketFlag(args);
  const anchorSubmitted = anchorEvents.find((e): e is Extract<JournalEvent, { type: "run.submitted" }> => isEvent(e, "run.submitted"));
  const anchorGraph = anchorSubmitted === undefined ? undefined : index.get(anchorSubmitted.payload.graphHash);
  const anchorT = foldTrajectory(anchorEvents, {
    promotedGraphHashes,
    ...(anchorGraph === undefined ? {} : { graph: anchorGraph }),
    ...(bucketInput === undefined ? {} : { bucketInput }),
  });
  const key = cohortKeyOf(anchorT);
  // RESOLVED BEFORE THE COHORT IS MEASURED, not after. This block used to sit below the
  // `n < MIN_COHORT_SIZE` refusal, and now that `measureCohort` drops a member it could not
  // measure, an unpublished baseline makes every member specless and the FIRST thing the
  // operator hears is "record more runs of this workflow" — blaming their corpus for their
  // graphs/ directory. The missing file is the earlier fact, so it is the earlier message.
  const baseline = index.get(anchorT.cohort.graphHash);
  if (baseline === undefined) {
    throw err.notFound(
      CODES.E_RUN_NOT_FOUND,
      `cohort "${key}" was produced by graph ${anchorT.cohort.graphHash}, and no graph in ${join(ws.root, "graphs")} ` +
        `has that hash (${String(index.size)} searched). The baseline is derived from the cohort rather than passed in, ` +
        `so it has to be publishable: restore those bytes to graphs/. A graph EDITED since the cohort ran no longer ` +
        `matches, which is the point — those runs were produced by the old bytes.`,
    );
  }
  const peers = await cohortPeers(ws, anchorId, key, promotedGraphHashes, index, bucketInput);
  if (peers.truncated) {
    process.stderr.write(
      `! the cohort scan stopped at ${String(COHORT_SCAN_LIMIT)} runs, so this cohort may be smaller than the workspace's\n`,
    );
  }
  // Said here for the reason `loom score` says it: `measureCohort` drops a member it could not
  // measure, and a cohort that shrank has to say why or the `n < MIN_COHORT_SIZE` refusal below
  // blames the operator's corpus for the operator's graphs/ directory. WHICH why is the point —
  // "publish the graph" is a no-op for a member whose graph resolved and whose verdict did not,
  // so the two causes get their own sentence. See `unmeasuredNotes`.
  for (const note of unmeasuredNotes(
    [anchorT, ...peers.members],
    join(ws.root, "graphs"),
    "run(s)",
    `are excluded from the population AND from the pairing — an unmeasured baseline scores 0, and pairing ` +
      `against a 0 hands this candidate that whole score as improvement it did not earn.`,
  )) {
    process.stderr.write(note);
  }
  const cohort = measureCohort(key, [anchorT, ...peers.members]);
  if (cohort.n < MIN_COHORT_SIZE) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `cohort "${key}" has n = ${String(cohort.n)} comparable runs and a promotion needs at least ` +
        `${String(MIN_COHORT_SIZE)}. "Comparable" counts runs that SUCCEEDED, did work, and could be MEASURED — a ` +
        // THE SET, AND ALL OF IT. This used to end at "folded without its graph", which was the
        // whole of `specResolved` until `verdictsResolved` joined it; the enumeration did not
        // move, so the one exclusion an operator cannot fix by publishing a graph was the one it
        // did not name. CLAUDE.md: name the set a claim covers.
        `run that failed, did nothing, folded without its graph, or folded WITH its graph while an evaluator's ` +
        `verdict sat in the payload store is excluded from the population as well as from the medians, so the ` +
        `number here is smaller than the journal row count and that is the point. Any ! line above says which ` +
        `exclusion applied. Record more runs of this workflow first.`,
    );
  }

  if (candidate.graphHash === baseline.graphHash) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `the candidate and the cohort's own graph are the same graph (${candidate.graphHash}). Running it against its ` +
        `own recordings' inputs would measure model nondeterminism and report it as an improvement or a regression.`,
    );
  }

  // WHICH RECORDINGS SUPPLY INPUTS, and the filter is `measureCohort`'s own. A member that did
  // not succeed, succeeded having done nothing, or could not be measured at all is not in the
  // population the ruler was built from — `components.delivered` and `components.specResolved`
  // are exactly those predicates, reported per run — so pairing against one would compare the
  // candidate to a number the cohort itself excludes.
  //
  // `specResolved` IS THE ONE THAT LOOSENS. A baseline folded without its graph scores 0 for
  // want of a spec, and `L1-paired-improvement` decides on the paired mean of
  // `candidateScore − baselineScore`: every such pair hands the candidate the baseline's whole
  // score as free improvement, and the candidate is measured with its graph in hand because
  // this command compiled it. Refusing to pair against an unmeasured baseline is the same
  // "a guard that cannot decide fails closed" the cost and posture checks above already apply.
  const eligible = [anchorT, ...peers.members]
    .map((t) => ({ t, scored: scoreTrajectory(t, cohort) }))
    .filter((x) => x.scored.components.delivered && x.scored.components.specResolved)
    // OLDEST FIRST. A RunId is a ULID, so ascending order is chronological, and taking the head
    // of it means `--runs 6` uses the six recordings least able to have been made for this
    // candidate. Deterministic, and not a choice the caller makes.
    .sort((a, b) => (a.t.runId < b.t.runId ? -1 : a.t.runId > b.t.runId ? 1 : 0));
  const selected = cap === undefined ? eligible : eligible.slice(0, cap);

  process.stderr.write(
    `judging ${candidate.graphHash} live against cohort "${key}" (n ${String(cohort.n)}): ` +
      `${String(selected.length)} run(s) of the candidate, on inputs taken from recordings. This calls ${ws.models.file}'s ` +
      `provider(s) and spends money.\n`,
  );

  const pairs: LivePair[] = [];
  const unmeasured: Unmeasured[] = [];
  const gatingRegressions: string[] = [];
  const budgetUsd = budgetFlag(args);

  for (const { t, scored } of selected) {
    const baseEvents = await journalOf(ws, t.runId);
    const submitted = baseEvents.find((e): e is Extract<JournalEvent, { type: "run.submitted" }> => isEvent(e, "run.submitted"));
    if (submitted === undefined) continue;
    // The RECORDED input, verbatim. This is the line that makes the exam older than the student.
    //
    // AND ITS EXTERNALISED HALF, FETCHED BACK INTO A VALUE. A recording whose input crossed
    // `EXTERNALISE_ABOVE_BYTES` keeps it in `ws.payloads` under the BASELINE run's id, and the
    // candidate is a new run with its own id and its own payload scope — so the handle cannot
    // travel and the value has to. Without this the candidate ran the exam with the question
    // missing and scored as though the graph were at fault.
    const inputs = { ...submitted.payload.inputs };
    for (const [channel, ref] of Object.entries(submitted.payload.external ?? {})) {
      inputs[channel] = await ws.payloads.get(t.runId, ref);
    }

    const { runId } = await startAndDrive(ws, {
      graph: candidate,
      inputs,
      ...submitterFlag(args),
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
    });
    const candEvents = await journalOf(ws, runId);
    const candT = foldTrajectory(candEvents, {
      promotedGraphHashes,
      graph: candidate,
      ...(bucketInput === undefined ? {} : { bucketInput }),
    });

    // TERMINALITY IS READ OFF THE JOURNAL, not off a projection this process happens to hold.
    // `incomplete` is the fold's word for "no terminal event at all", which is exactly the
    // missing measurement — see `L2-every-input-measured` for why it is neither a zero nor a
    // silent drop, and why a FAILED run is paired rather than excused.
    if (candT.outcome.runStatus === "incomplete") {
      // WHY IT DID NOT FINISH, AND IT IS NOT ALWAYS THE SAME REASON. This pushed the literal
      // `"incomplete"` — the fold's word for "no terminal event", not the run's own status — so
      // a candidate PARKED ON A HUMAN GATE was reported to `L2-every-input-measured` as a
      // measurement that went missing. Every graph with a `human_gate` lands here: `driveToRest`
      // returns the moment the projection stops being `running`, and this process may not answer
      // a gate on a person's behalf. Fail-closed and therefore safe, but the operator was told
      // the wrong cause. Both fields come off the run's OWN journal, folded once.
      const shape = gateShapeOf(candEvents);
      unmeasured.push({
        baselineRunId: t.runId,
        candidateRunId: runId,
        status: shape.status,
        ...(shape.unresolved.length === 0 ? {} : { openGates: shape.unresolved }),
      });
      continue;
    }

    const candScored = scoreTrajectory(candT, cohort);
    pairs.push({
      baselineRunId: t.runId,
      candidateRunId: runId,
      baselineScore: scored.score,
      candidateScore: candScored.score,
      baselineCostUsd: t.usage.costUsd,
      candidateCostUsd: candT.usage.costUsd,
    });

    // OVERSIGHT ONLY TIGHTENS, per input. Both halves of `ungatedActions`, asked of two real
    // journals instead of a replay: a gate the candidate left unresolved, and a node the
    // recording gated that the candidate did not. The second is the one that matters — a
    // candidate reaching the same work along a path with fewer gates has loosened oversight,
    // whatever its score.
    const baseGates = gateShapeOf(baseEvents);
    const candGates = gateShapeOf(candEvents);
    for (const u of candGates.unresolved) gatingRegressions.push(`on the input from ${t.runId}: ${u}`);
    for (const node of baseGates.decidedNodes) {
      if (!candGates.decidedNodes.has(node)) {
        gatingRegressions.push(`on the input from ${t.runId}: the recording gated node "${node}" and this candidate did not`);
      }
    }
  }

  const verdict = gateCandidateLive({
    pairs,
    unmeasured,
    postureDiffNonNegative: posturesHoldOf(ws, baseline, candidate),
    promptGrowth: promptGrowthOf(baseline, candidate),
    gatingRegressions,
  });

  for (const c of [...verdict.checks].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    process.stdout.write(`${c.ran ? (c.pass ? "✓" : "✗") : "⊘"} ${c.id.padEnd(26)} ${c.detail}\n`);
  }

  // GATED, NOT MERELY REPORTED — and it is `3-cost` in `evolution/live.ts` that gates it, which
  // is why this line no longer computes a median of its own. It used to: the same statistic was
  // derived here for the journal row and derived again nowhere for the decision, with a filter
  // (`baselineCostUsd > 0`) silently dropping the pairs that had no answer. `pairedCostRatio` is
  // the single definition, its rule covers those pairs instead of dropping them, and the row and
  // the verdict now cannot disagree because they are the same call.
  const cost = pairedCostRatio(pairs);
  const medianCostRatio = cost.medianRatio;

  const decision = {
    // THE FIRST FIELD, AND THE ONE THAT STOPS A LIVE VERDICT IMPERSONATING A REPLAYED ONE.
    // The replayed decision carries `suite`/`suiteVersion`/`suiteFrozenAt` and no `mode`; this
    // carries `mode` and no suite at all, so the two rows are not confusable even by a reader
    // who only looks at the keys.
    mode: "live-cohort",
    promote: verdict.promote,
    cohortKey: key,
    cohort: {
      n: cohort.n,
      p50CostUsd: cohort.p50Cost,
      p50WallMs: cohort.p50Wall,
      p50Gates: cohort.p50Gates,
      p90Score: cohort.p90Score,
      weightsDigest: cohort.weightsDigest,
    },
    baselineGraphHash: baseline.graphHash,
    candidateGraphHash: candidate.graphHash,
    eligible: eligible.length,
    selected: selected.length,
    paired: verdict.paired,
    pairs: pairs.map((p) => ({ ...p, diff: Math.round((p.candidateScore - p.baselineScore) * 1e6) / 1e6 })),
    unmeasured,
    medianCostRatio,
    // WHICH CHECKS COULD NOT RUN. Without this the row says "promote: true" over a set of
    // criteria a reader would assume was the replayed gate's eleven.
    checksNotRun: verdict.notRun,
    checks: verdict.checks.map((c) => ({ id: c.id, ran: c.ran, pass: c.pass, detail: c.detail })),
  };
  process.stdout.write(`\n${JSON.stringify(decision, null, 2)}\n`);
  process.stderr.write(
    `! decided WITHOUT ${verdict.notRun.join(", ")} — this is a live verdict, not the replayed gate's. ` +
      `The journaled row says so: mode "live-cohort", checksNotRun ${JSON.stringify(verdict.notRun)}.\n`,
  );

  // ANCHORED ON A RECORDING THIS PROMOTION WAS JUDGED OVER, the same choice the replayed mode
  // makes and for the same reason: `StateStore` is keyed by runId, so a fact whose subject is a
  // GRAPH has to borrow some run's coordinate. It borrows the FIRST SELECTED baseline run's, and
  // `pairs[].baselineRunId` names every one of them. Never a candidate run's: those were
  // produced by a graph no human has approved, and hanging the decision off one would put the
  // record of a judgement inside the thing being judged.
  const anchor = selected[0]?.t.runId ?? anchorId;
  await ws.store.append({
    runId: anchor,
    expectedSeq: await ws.store.head(anchor),
    events: [
      {
        type: "operator.command",
        payload: { kind: "evolution.promote", args: decision },
        actor: { kind: "human", subject: subjectFlag(args), via: "console" },
      },
    ],
  });
  return verdict.promote ? 0 : 1;
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
 *
 * `otherwise` IS A PARAMETER BECAUSE THE CONSEQUENCE IS NOT SHARED. The sentence used to be
 * fixed — "while still registering the tool the flag enables. Omit the flag entirely to leave
 * that tool unregistered" — which is `--egress`/`--allow-exec`/`--exec-env`'s reason attached to
 * every caller. Driven: `loom gates … --extension-module` printed it, and `--extension-module`
 * enables no tool; so does `--take`, on a verb with no tools in it at all. Five callers, and the
 * two that inherited someone else's reason are the whole of this defect class.
 */
function listFlag(args: Args, name: string, what: string, otherwise: string): readonly string[] | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (v === true || v === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--${name} needs ${what}: ${v === "" ? `the one given was empty (\`--${name} "$VAR"\` does this when the variable is unset)` : "the flag was given with no value at all"}. ` +
        `It would otherwise read as the single entry "true", ${otherwise}`,
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
/**
 * `--to`, the posture a de-escalation lowers to — CHECKED AGAINST THE UNION, never cast.
 *
 * WHAT IT DOES WHEN IT CANNOT DECIDE: it refuses. `Posture` is a three-member union and
 * `POSTURES` is derived from `POSTURE_RANK`, so a value this binary does not recognise has no
 * rank; a cast would put that string into `policy.deescalated.to`, where `foldRun` installs it
 * as a ceiling and `PolicyEngine.floorFor` compares it with `postureRank`. `POSTURE_RANK[x]` is
 * `undefined` for an unknown member and every `<` against `undefined` is FALSE, so the clamp
 * would answer with the computed floor in some places and with the unknown value in others —
 * an unranked posture is not a stricter posture, it is a posture nothing can order, on the one
 * path in this system that is allowed to loosen at all.
 */
function postureFlag(args: Args): Posture {
  const v = args.flags["to"];
  if (typeof v !== "string" || !POSTURES.includes(v as Posture)) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--to must be one of ${POSTURES.join(", ")}, not ${v === undefined ? "omitted" : v === true ? "a bare flag with no value" : `"${v}"`}. ` +
        `\`in\` gates every action for a human, \`on\` runs with a human watching and able to interrupt, \`out\` runs unsupervised.`,
    );
  }
  return v as Posture;
}

/**
 * `--why`, and there is no way around it.
 *
 * `PolicyEngine.deescalate` already refuses an empty justification with
 * `E_HUMAN_APPROVAL_REQUIRED`; this refuses the three shapes that never reach it as a string at
 * all — omitted, `--why` with no value (which `parseArgs` makes `true`, and `String(true)` would
 * journal the four letters "true" as a person's stated reason, the slip `--as`, `--token` and
 * `--reason` each already guard against), and whitespace. It is the one field on this verb that
 * a later reader has to be able to hold the operator to.
 */
function justificationFlag(args: Args): string {
  const v = args.flags["why"];
  if (typeof v !== "string" || v.trim() === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--why needs a justification: ${v === undefined ? "the flag was omitted" : v === true ? "the flag was given with no value at all" : "the one given was blank"}. ` +
        `Lowering oversight is journaled on policy.deescalated with this text and replayed as a human input, so it is ` +
        `the only account of why supervision was reduced. There is no flag that skips it.`,
    );
  }
  return v;
}

/**
 * `--scope`, the thing a ceiling is installed on — `run:<runId>` or `node:<runId>/<nodeId>`.
 *
 * THE SCOPE'S RUN MUST BE THE RUN NAMED ON THE COMMAND LINE, and that check is the reason this
 * is a function rather than a `stringFlag`. `PolicyEngine` keys `#ceilings` by an OPAQUE string
 * and `Engine.deescalate` journals it into the log of the run in the first argument, so
 * `loom deescalate A --scope run:B` writes a ceiling for B into A's journal: in-process it
 * lowers B's posture, and after a restart `PolicyEngine.restore` re-seeds it from A's journal
 * and B never sees it again. That is a loosening the journal cannot reconstruct — the first
 * non-negotiable, in its loosening direction — so the mismatch is refused here.
 *
 * A SCOPE THIS FILE CANNOT PARSE IS REFUSED RATHER THAN PASSED THROUGH. Nothing consults an
 * unrecognised scope, so a typo would exit 0, print a ceiling, and change nothing: a
 * de-escalation an operator believes happened and did not is worse than one that failed loudly.
 */
function ceilingScope(args: Args, runId: RunId): string {
  const v = args.flags["scope"];
  const shape = `--scope must be run:${runId} or node:${runId}/<nodeId>`;
  if (typeof v !== "string" || v === "") {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `${shape}: ${v === undefined ? "the flag was omitted" : v === true ? "the flag was given with no value at all" : "the one given was empty"}. ` +
        `A ceiling is installed on a scope, and there is no default scope — "the whole run" is spelled run:<runId>.`,
    );
  }
  const named = v.startsWith("run:") ? v.slice(4) : v.startsWith("node:") ? v.slice(5).split("/")[0]! : undefined;
  if (named === undefined || (v.startsWith("node:") && !/^node:[^/]+\/[^/]+$/.test(v))) {
    throw err.validation(CODES.E_CONFIG_INVALID, `${shape}, not "${v}". Those are the two scopes PolicyEngine reads.`);
  }
  if (named !== runId) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `--scope "${v}" names run ${named}, and this command names run ${runId}. The ceiling would be journaled in ` +
        `${runId}'s log and re-seeded from it on every restart, so ${named} would lose it the moment this process exits.`,
    );
  }
  return v;
}

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

/**
 * `--input` KEYS, CHECKED AGAINST THE GRAPH — the half `runInputs` cannot do.
 *
 * `runInputs` refuses a value that is not a JSON object and nothing else, so a MISSPELLED channel
 * name was accepted, submitted, journaled, executed and only then failed. Measured before this
 * existed, on a graph declaring `document`:
 *
 *     loom run graphs/fan-out-join.json --input '{"documnet":"alpha beta"}'
 *     → "status": "failed",
 *       "code": "E_INTERNAL",
 *       "message": "Error: E_CHANNEL_UNDECLARED: channel \"document\" is not in this node's declared reads"
 *
 * Three things wrong with that, and they are why this is a refusal and not a warning. It names
 * `document`, a channel the operator did not type, instead of `documnet`, which they did. It is
 * classed `E_INTERNAL` — this system's word for "a bug in Loom" — for a caller's typo, which is
 * the misfiling `runInputs`' own docstring calls out. And it costs a real run: against a live
 * provider the graph is submitted and SPENDS before the missing binding is discovered.
 *
 * SEPARATE FROM `runInputs` AND AFTER `loadGraph`, because it needs the compiled graph and
 * `runInputs` deliberately runs before the compile so a flag typo does not cost one. Two checks,
 * two moments, one flag.
 *
 * THIS IS A NEW REFUSAL AND IT IS THE CLI'S DOOR ONLY. `POST /runs` takes its inputs from a
 * caller's program rather than a caller's keyboard, and widening a wire contract is not what a
 * typo in an argv is evidence for. The engine's own binding check is unchanged and still runs.
 *
 * THE DECLARED SET IS ALWAYS PRINTED, not only the guess: `assertKnownFlags`' same-first-two-
 * letters heuristic catches `documnet` and misses a wrong name that is not a transposition, and
 * an operator who was never going to guess needs the list rather than a shrug.
 */
function assertDeclaredInputs(graph: RunGraph, inputs: Record<string, unknown>): void {
  const declared = graph.spec.inputs ?? [];
  const undeclared = Object.keys(inputs).filter((k) => !declared.includes(k));
  if (undeclared.length === 0) return;
  const near = (k: string): string => {
    const head = k.toLowerCase().slice(0, 2);
    const guesses = declared.filter((d) => d.toLowerCase().startsWith(head) && d !== k);
    return guesses.length === 0 ? "" : ` (did you mean ${guesses.map((g) => `"${g}"`).join(" or ")}?)`;
  };
  throw err.validation(
    CODES.E_CONFIG_INVALID,
    `--input names ${undeclared.length === 1 ? "a channel" : "channels"} this graph does not declare as an input: ` +
      `${undeclared.map((k) => `"${k}"${near(k)}`).join(", ")}. ` +
      `It declares ${declared.length === 0 ? "no inputs at all" : declared.map((d) => `"${d}"`).join(", ")}. ` +
      `A channel nothing reads is dropped in silence and the run then fails four layers below the mistake, ` +
      `having already been submitted and — against a real provider — already spent.`,
  );
}

/**
 * Is this module the thing the user asked to run?
 *
 * Kept at the bottom so importing this module for tests runs nothing — and the question is
 * genuinely awkward, because the same file is started three ways.
 *
 *   - `node packages/core/src/cli.ts` and `node dist/cli.js`: `argv[1]` IS this file.
 *   - `node_modules/.bin/loom`, which is what `package.json`'s `bin` field produces: on POSIX
 *     npm writes a SYMLINK, so `argv[1]` is `…/.bin/loom` and its basename is `loom`. The old
 *     test — does `import.meta.url` end with `basename(argv[1])` — compared "loom" against a
 *     URL ending in "cli.js" and answered no, so an installed `loom --help` printed **nothing
 *     at all** and exited 0. That is the whole of "Install it" failing quietly.
 *   - The single-file binary: `scripts/build-binary.mjs` defines `import.meta.url` as
 *     `file:///loom`, and a SEA's `argv[1]` is the executable, so the basename test is what
 *     makes the binary run itself. `/loom` is not a path on any machine, so a realpath-only
 *     test would break it.
 *
 * So: resolve both sides and compare, which is exact for the first two and follows the symlink
 * for the second; fall back to the basename test, which is what the binary needs and what every
 * pre-existing caller already matched on. `realpathSync` throws on a path that does not exist —
 * `/loom`, and an `argv[1]` that is not a file at all — so the throw is the fallback's trigger
 * rather than a failure.
 */
function startedAsTheEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    if (realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) return true;
  } catch {
    /* not a path this filesystem has; the basename test below is the answer */
  }
  return import.meta.url.endsWith(basename(entry));
}

if (startedAsTheEntryPoint()) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      const le = isLoomError(e) ? e : toLoomError(e);
      process.stderr.write(`${le.code}: ${le.message}\n`);
      process.exit(1);
    });
}
