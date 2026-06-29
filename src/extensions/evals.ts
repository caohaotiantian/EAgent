/**
 * evals — offline trajectory assertions + a headless eval runner + an LLM-judge.
 *
 * `trace` made an agent run *observable* (it folds the lifecycle bus into spans
 * and renders them); it does not *assert* anything. This extension closes that
 * gap. It is a second pure consumer of the same bus that folds each run into an
 * in-memory `Trajectory` (ordered tool names, one span per tool call, the finish
 * reason, cumulative tokens), and then turns that record into a regression
 * surface:
 *
 *  - `/expect <spec>` asserts a declarative set of exact predicates over the
 *    last run's trajectory (tool order/exact, span ceiling, finish reason, no
 *    tool errors, token ceiling) and reports pass/fail + reasons.
 *  - `/eval <dir>` drives each `*.eval.json` scenario headlessly through the
 *    agent loop with this consumer attached and prints a `passed/total`
 *    scorecard, naming the failing scenarios.
 *  - the `judge` tool grades a candidate against a rubric via a recursion-safe,
 *    tool-less provider sub-call (the exact pattern `risk-guard` uses for its
 *    classifier), returning `{score, verdict, reason}`.
 *
 * Like every consumer here, each bus handler is wrapped in `safe()` so a throw
 * never escapes the bus and out-of-order events degrade the trajectory, never
 * the run. No kernel change, no new event/filter/capability. The consumer,
 * commands, and tool are all no-ops under `EAGENT_EVALS=off`; teardown disposes
 * every registration inside try/catch and never throws.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Agent } from "../kernel/agent.js";
import type { CommandContext } from "../kernel/commands.js";
import { defineTool, ok, fail } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { MockTurn } from "../providers/mock.js";
import { totalTokens, type Message, type StopReason, type Usage } from "../kernel/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One dispatched tool call: its name and whether the result was not an error. */
export interface ToolSpan {
  name: string;
  /** `undefined` until the matching `tool_end` arrives. */
  ok?: boolean;
}

/**
 * The behavior of the most recent run, folded from the lifecycle bus. `tools`
 * and `spans` are the same sequence viewed two ways (D2): one span per tool
 * call, so `spans.length === tools.length` always.
 */
export interface Trajectory {
  /** Ordered tool-name list, one entry per dispatched call. */
  tools: string[];
  /** One span per tool call (tool spans only — never agent/turn spans). */
  spans: ToolSpan[];
  /** The `StopReason` captured at `agent_end`. */
  finishReason?: StopReason;
  /** Cumulative tokens as last reported by the `usage` event. */
  totalTokens: number;
}

/** A declarative assertion over a trajectory. Absent fields are not checked. */
export interface ExpectSpec {
  /** An expected tool-name sequence; `order` decides how it is matched. */
  tools?: string[];
  /** `in_order` = subsequence over the tool list; `exact` = full deep equality. */
  order?: "in_order" | "exact";
  /** A ceiling on the tool-span count (`spans.length === tools.length`). */
  maxSpans?: number;
  /** The expected finish reason. */
  finishReason?: StopReason;
  /** Require every tool span to be `ok`. */
  noToolErrors?: boolean;
  /** A ceiling on cumulative tokens. */
  maxTokens?: number;
}

/** A parsed classifier reply. */
export interface JudgeReply {
  score: number;
  verdict: "pass" | "fail";
  reason: string;
}

/** One headless eval scenario, parsed from a `*.eval.json` object. */
export interface EvalScenario {
  input: string;
  /** The exact shape `MockProvider` consumes. */
  mockScript: MockTurn[];
  expect: ExpectSpec;
}

/** The store key under which the live trajectory is published for accessors. */
const TRAJECTORY_KEY = "trajectory";

// ---------------------------------------------------------------------------
// Pure helpers (no I/O, no agent loop — unit-testable in isolation)
// ---------------------------------------------------------------------------

/** A fresh, empty trajectory for a new run. */
function emptyTrajectory(): Trajectory {
  return { tools: [], spans: [], totalTokens: 0 };
}

/** Read the live trajectory published by a loaded `evals` extension, or undefined. */
export function getTrajectory(api: Pick<ExtensionAPI, "store">): Trajectory | undefined {
  return api.store.get<Trajectory>(TRAJECTORY_KEY);
}

/** Is `needle` a (not necessarily contiguous) subsequence of `haystack`? */
function isSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let i = 0;
  for (const h of haystack) {
    if (i < needle.length && needle[i] === h) i++;
  }
  return i === needle.length;
}

/** Deep-equal two string arrays. */
function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Decide a spec against a trajectory: one human-readable reason per failed
 * predicate. Pure and deterministic; absent spec fields are not checked.
 */
export function checkExpect(traj: Trajectory, spec: ExpectSpec): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (spec.tools !== undefined) {
    const order = spec.order ?? "in_order";
    if (order === "exact") {
      if (!arraysEqual(spec.tools, traj.tools)) {
        reasons.push(`tools (exact): expected [${spec.tools.join(", ")}], got [${traj.tools.join(", ")}]`);
      }
    } else {
      if (!isSubsequence(spec.tools, traj.tools)) {
        reasons.push(
          `tools (in_order): [${spec.tools.join(", ")}] is not a subsequence of [${traj.tools.join(", ")}]`,
        );
      }
    }
  }

  if (spec.maxSpans !== undefined && traj.spans.length > spec.maxSpans) {
    reasons.push(`maxSpans: ${traj.spans.length} tool span(s) exceeds ceiling ${spec.maxSpans}`);
  }

  if (spec.finishReason !== undefined && traj.finishReason !== spec.finishReason) {
    reasons.push(`finishReason: expected ${spec.finishReason}, got ${traj.finishReason ?? "(none)"}`);
  }

  if (spec.noToolErrors === true) {
    const errored = traj.spans.filter((s) => s.ok === false).map((s) => s.name);
    if (errored.length > 0) {
      reasons.push(`noToolErrors: tool error(s) in [${errored.join(", ")}]`);
    }
  }

  if (spec.maxTokens !== undefined && traj.totalTokens > spec.maxTokens) {
    reasons.push(`maxTokens: ${traj.totalTokens} exceeds ceiling ${spec.maxTokens}`);
  }

  return { pass: reasons.length === 0, reasons };
}

/**
 * Parse a classifier reply by the pinned one-line grammar
 * `SCORE <n>/10 <PASS|FAIL> <reason>`, or `undefined` when unrecognized.
 *
 * Mirrors `risk-guard`'s `parseVerdict`: total and exception-free. Reads the
 * first non-empty line, requires a leading `SCORE` token, then an `<n>/10`
 * fraction (clamped to `0..10`), then a `PASS`/`FAIL` verdict (case-insensitive);
 * the trimmed remainder is the reason (possibly empty). Anything else is the
 * failure sentinel `undefined` — never a throw, never a fabricated score.
 */
export function parseJudgeReply(reply: string): JudgeReply | undefined {
  if (typeof reply !== "string") return undefined;
  const line = reply
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  // SCORE <n>/10 <VERDICT> <reason...>
  const m = /^SCORE\s+(\d+)\s*\/\s*10\s+(PASS|FAIL)\b\s*(.*)$/i.exec(line);
  if (!m) return undefined;
  const score = Math.max(0, Math.min(10, Number.parseInt(m[1]!, 10)));
  const verdict = m[2]!.toUpperCase() === "PASS" ? "pass" : "fail";
  const reason = m[3]!.trim();
  return { score, verdict, reason };
}

/**
 * Validate one `*.eval.json` object into a typed `EvalScenario`, or `undefined`
 * when malformed. Pure validation, never throws — a bad file is data, not a
 * thrown runner.
 */
export function parseEvalScenario(obj: unknown): EvalScenario | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  if (typeof o.input !== "string") return undefined;
  if (!Array.isArray(o.mockScript)) return undefined;
  if (typeof o.expect !== "object" || o.expect === null || Array.isArray(o.expect)) return undefined;
  return {
    input: o.input,
    mockScript: o.mockScript as MockTurn[],
    expect: o.expect as ExpectSpec,
  };
}

/**
 * Run every `*.eval.json` scenario in `dir` headlessly and return a structured
 * scorecard — the shared core of the `/eval` command and the `npm run eval` CI
 * gate (so the gate never parses display strings). Owns the `readdir` so `total`
 * counts every scenario file. `readTraj` reads the live trajectory after each
 * run; an `undefined` reading is a failed scenario, not a thrown runner.
 *
 * Each scenario re-scripts the agent's default provider and clears its
 * transcript, and the loop deliberately leaves the last scenario's (consumed)
 * queue and an empty transcript in place on return rather than restoring the
 * prior script — the scriptable provider exposes no read accessor to snapshot,
 * so a faithful save is not possible through the public API. Run it as a
 * terminal action, not interleaved with interactive turns that depend on a
 * pre-existing queue.
 */
export async function runEvalDir(
  dir: string,
  agent: Agent,
  readTraj: () => Trajectory | undefined,
): Promise<{ passed: number; total: number; failures: string[] }> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".eval.json"))
    .sort();
  const provider = agent.providers.get();
  let passed = 0;
  const failures: string[] = [];

  for (const file of files) {
    const path = join(dir, file);
    let scenario: EvalScenario | undefined;
    try {
      scenario = parseEvalScenario(JSON.parse(readFileSync(path, "utf8")) as unknown);
    } catch {
      scenario = undefined;
    }
    // A malformed/invalid file is a failed scenario, not a thrown runner.
    if (!scenario) {
      failures.push(`${file}: invalid scenario (malformed *.eval.json)`);
      continue;
    }
    if (!provider || typeof (provider as { script?: unknown }).script !== "function") {
      failures.push(`${file}: no scriptable provider available`);
      continue;
    }
    try {
      (provider as unknown as { script(s: MockTurn[]): unknown }).script(scenario.mockScript);
      agent.clear();
      await agent.run(scenario.input);
      const traj = readTraj();
      if (!traj) {
        failures.push(`${file}: no trajectory`);
        continue;
      }
      const { pass, reasons } = checkExpect(traj, scenario.expect);
      if (pass) {
        passed += 1;
      } else {
        failures.push(`${file}: ${reasons.join("; ")}`);
      }
    } catch (err) {
      failures.push(`${file}: run error — ${String(err)}`);
    }
  }

  return { passed, total: files.length, failures };
}

// ---------------------------------------------------------------------------
// The judge sub-call
// ---------------------------------------------------------------------------

/** The fixed instruction for the judge sub-call (pins the reply grammar). */
const JUDGE_SYSTEM_PROMPT =
  "You are an impartial grader for an autonomous agent. You are given a rubric " +
  "and a candidate answer. Grade the candidate against the rubric. Reply on ONE " +
  "line in exactly this form: `SCORE <n>/10 <PASS|FAIL> <reason>`, where <n> is " +
  "an integer 0-10, the verdict is the literal token PASS or FAIL, and the reason " +
  "is one short phrase. Example: `SCORE 8/10 PASS clear and correct`. Output nothing else.";

/** Concatenate an assistant message's text blocks. */
function textOf(message: Message): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export default function activate(e: ExtensionAPI): () => void {
  /** Kill switch read per-call so it can be toggled mid-session in a test. */
  const disabled = (): boolean => process.env.EAGENT_EVALS === "off";

  /** The trajectory of the most recent (or in-progress) run only. */
  let traj: Trajectory = emptyTrajectory();
  e.store.set(TRAJECTORY_KEY, traj);

  // Each bus handler is wrapped so a thrown error never escapes the bus, and
  // out-of-order events degrade the trajectory rather than the run — the same
  // defensive discipline `trace` uses.
  const safe =
    <T>(fn: (payload: T) => void) =>
    (payload: T): void => {
      if (disabled()) return;
      try {
        fn(payload);
      } catch (err) {
        e.log.warn("evals handler error:", err);
      }
    };

  const disposers = [
    e.on(
      "agent_start",
      safe(() => {
        // A new run resets to a fresh trajectory, keeping only the last run's
        // detail (bounding memory, as `trace` does), and republishes it so the
        // accessor sees the current object by reference.
        traj = emptyTrajectory();
        e.store.set(TRAJECTORY_KEY, traj);
      }),
    ),

    e.on(
      "tool_start",
      safe((p: { call: { name: string } }) => {
        // The same sequence two ways: the ordered name list and a span per call.
        traj.tools.push(p.call.name);
        traj.spans.push({ name: p.call.name });
      }),
    ),

    e.on(
      "tool_end",
      safe((p: { call: { name: string }; result: { isError?: boolean } }) => {
        const okFlag = p.result.isError !== true;
        // Match the open span for this call by name; fall back to the last
        // still-open span so a mismatched/duplicate end still records something.
        let span = traj.spans.find((s) => s.name === p.call.name && s.ok === undefined);
        if (!span) {
          for (let i = traj.spans.length - 1; i >= 0; i--) {
            if (traj.spans[i]!.ok === undefined) {
              span = traj.spans[i];
              break;
            }
          }
        }
        if (span) span.ok = okFlag;
      }),
    ),

    e.on(
      "usage",
      safe((p: { cumulative: Usage }) => {
        // Mirror the running total (idempotent if the event repeats).
        traj.totalTokens = totalTokens(p.cumulative);
      }),
    ),

    e.on(
      "agent_end",
      safe((p: { reason: StopReason }) => {
        traj.finishReason = p.reason;
      }),
    ),
  ];

  // -- /expect --------------------------------------------------------------

  const offExpect = e.registerCommand({
    name: "expect",
    description: "Assert a JSON ExpectSpec over the last run's trajectory. Usage: /expect <json>",
    run: (ctx: CommandContext) => {
      if (disabled()) {
        ctx.print("evals: disabled (EAGENT_EVALS=off)");
        return;
      }
      let spec: ExpectSpec;
      try {
        const parsed = JSON.parse(ctx.args.trim() || "{}") as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          ctx.print("expect: invalid spec — expected a JSON object");
          return;
        }
        spec = parsed as ExpectSpec;
      } catch (err) {
        ctx.print(`expect: invalid spec — ${String(err)}`);
        return;
      }
      const { pass, reasons } = checkExpect(traj, spec);
      ctx.print(pass ? "expect: PASS" : "expect: FAIL");
      for (const r of reasons) ctx.print(`  - ${r}`);
    },
  });

  // -- /eval <dir> ----------------------------------------------------------

  const offEval = e.registerCommand({
    name: "eval",
    description: "Run every *.eval.json scenario in <dir> and print a pass@k scorecard.",
    run: async (ctx: CommandContext) => {
      if (disabled()) {
        ctx.print("evals: disabled (EAGENT_EVALS=off)");
        return;
      }
      const dir = ctx.args.trim();
      if (!dir) {
        ctx.print("eval: usage — /eval <dir>");
        return;
      }
      let files: string[];
      try {
        files = readdirSync(dir)
          .filter((f) => f.endsWith(".eval.json"))
          .sort();
      } catch (err) {
        ctx.print(`eval: cannot read ${dir} — ${String(err)}`);
        return;
      }
      if (files.length === 0) {
        ctx.print(`eval: no *.eval.json scenarios in ${dir}`);
        return;
      }

      // The happy path is the shared runner; the command keeps its own guard
      // outputs above and prints the same scorecard. `traj` is the live (always
      // defined) closure object, so the runner never sees an undefined reading.
      const { passed, total, failures } = await runEvalDir(dir, e.agent, () => traj);
      ctx.print(`eval: ${passed}/${total} passed`);
      for (const f of failures) ctx.print(`  FAIL ${f}`);
    },
  });

  // -- judge tool -----------------------------------------------------------

  const offJudge = e.registerTool(
    defineTool({
      name: "judge",
      description:
        "Grade a candidate answer against a rubric. Returns a score (0-10), a pass/fail verdict, and a reason.",
      // `sequential` is load-bearing: the judge sub-call and the outer loop draw
      // turns from the same provider queue, so forcing the in-order dispatch path
      // makes that queue consumption deterministic (design D3/§5).
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          rubric: { type: "string", description: "The grading criteria." },
          candidate: { type: "string", description: "The answer to grade." },
        },
        required: ["rubric", "candidate"],
      },
      execute: async (args, ctx) => {
        if (disabled()) return fail("evals: disabled (EAGENT_EVALS=off)");
        const rubric = typeof args.rubric === "string" ? args.rubric : "";
        const candidate = typeof args.candidate === "string" ? args.candidate : "";
        try {
          const provider = e.agent.providers.get();
          if (!provider) return fail("judge: no provider available to grade");
          const messages: Message[] = [
            {
              role: "user",
              content: [{ type: "text", text: `Rubric:\n${rubric}\n\nCandidate:\n${candidate}` }],
            },
          ];
          let reply = "";
          for await (const ev of provider.stream({
            systemPrompt: JUDGE_SYSTEM_PROMPT,
            // Tool-less sub-call: passing `tools: []` runs the completion outside
            // the agent loop, so it cannot emit a tool call and re-enter dispatch.
            messages,
            tools: [],
            model: e.agent.model,
            signal: ctx.signal,
          })) {
            if (ev.type === "done") reply = textOf(ev.message);
          }
          const parsed = parseJudgeReply(reply);
          if (!parsed) {
            // The tool wrapper (not the parser) maps the sentinel to an error
            // result — fail closed rather than silently pass.
            return fail("judge: could not parse a verdict from the grader");
          }
          return ok(
            `SCORE ${parsed.score}/10 ${parsed.verdict.toUpperCase()} ${parsed.reason}`.trim(),
            parsed,
          );
        } catch (err) {
          return fail(`judge: grading failed — ${String(err)}`);
        }
      },
    }),
  );

  return () => {
    for (const d of [offJudge, offEval, offExpect, ...disposers]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
