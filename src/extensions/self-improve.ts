/**
 * self-improve — a bounded, human-checkpointed self-improvement harness.
 *
 * The agent proposes a new extension, the harness statically vetoes obviously
 * dangerous source, evaluates a clean candidate's fitness under isolation, and
 * adopts it only after a human reviews the source and approves. It is pure
 * composition of existing primitives — `self.ts`'s `loadExtension`, the `evals`
 * `runEvalDir` fitness, and `lib/sandbox`'s confinement — with no kernel change,
 * and ships off (a `EAGENT_SELF_IMPROVE=off` kill switch plus a store `enabled`
 * flag that defaults false).
 *
 * The safety posture is deliberate and not to be weakened:
 *
 *   - The isolation BOUNDARY is the eval-time subprocess+sandbox: a candidate is
 *     judged only in a separate spawned process, confined `no-network` to an
 *     ephemeral workspace copy — never loaded into the live agent to be scored.
 *   - The static veto (`vetoCandidate`) is a fast pre-filter, NOT a boundary. It
 *     is trivially evadable in JS (computed strings, dynamic import, etc.); it
 *     rejects the obvious cases cheaply before any execution.
 *   - The eval score is ADVISORY and tamper-detected (fixtures are integrity
 *     hashed pre/post the run), never the adoption gate.
 *   - The GATE is human source-review via a non-null `ui.ask`. `ui.confirm` is
 *     NOT used: its no-TTY branch auto-approves under `--yolo`, whereas `ui.ask`
 *     returns null when non-interactive, so adoption fails closed.
 *   - An adopted candidate runs with the FULL ExtensionAPI (there is no
 *     in-process guardrail; `loadExtension` has no injection seam). Adoption is
 *     trust-on-human-review, reversible via host-tracked `unloadExtension`.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { type Backend, binExists, detectBackend, wrapCommand } from "./lib/sandbox.js";

/** Where staged candidates are written, and where the eval fixtures live. */
const FIXTURES_SUBDIR = "evals";
/** Default ceiling on retained candidate records (FIFO). */
const DEFAULT_MAX_STAGED = 16;

/** A candidate's lifecycle record, persisted in this extension's store. */
interface Candidate {
  slug: string;
  name: string;
  rationale: string;
  ts: number;
  status: "staged" | "vetoed" | "evaluated" | "adopted";
  reasons?: string[];
  delta?: number;
  improved?: boolean;
  tamper?: boolean;
}

export interface EvalResult {
  baseline: number;
  candidate: number;
  delta: number;
  improved: boolean;
  tamper: boolean;
}

export type Evaluator = (candidatePath: string) => Promise<EvalResult>;

/**
 * Reject candidate source that obviously self-modifies the host or its judge.
 * Pure: a parse-ish presence check plus a forbidden-pattern scan. This is an
 * evadable pre-filter, NOT a security boundary — the eval-time subprocess+sandbox
 * is the boundary, and the human source-review is the gate.
 */
export function vetoCandidate(source: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!/export\s+default\b/.test(source)) reasons.push("missing an `export default` activation function");
  if (/\b(?:test|evals)\//.test(source)) reasons.push("references the test/ or evals/ tree (the eval kernel)");
  for (const fn of ["grantCapability", "loadExtension", "unloadExtension", "reload", "process.exit"]) {
    if (new RegExp(`\\b${fn.replace(".", "\\.")}\\s*\\(`).test(source)) reasons.push(`calls ${fn}`);
  }
  if (/process\.env\s*(?:\[[^\]]*\]|\.[A-Za-z_$][\w$]*)\s*=(?!=)/.test(source)) reasons.push("mutates process.env");
  if (/child_process/.test(source)) reasons.push("imports node:child_process");
  return { ok: reasons.length === 0, reasons };
}

/** Lowercase kebab-case stem for a candidate filename (mirrors self.ts). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/** A sha256 over a fixtures directory's filenames and contents, for tamper-detection. */
function hashFixtures(dir: string): string {
  const h = createHash("sha256");
  for (const f of readdirSync(dir).sort()) {
    h.update(f);
    try {
      h.update(readFileSync(join(dir, f)));
    } catch {
      // a nested dir entry contributes only its name
    }
  }
  return h.digest("hex");
}

/** Run the candidate-loading eval runner once under the sandbox, returning the passed count. */
function runScored(backend: Backend, candidateDir: string, fixturesDir: string, root: string, cwd: string): number {
  const cmd = `node --import tsx ${join("src", "self-improve-eval.ts")} ${candidateDir} ${fixturesDir} ${root}`;
  const wrapped = wrapCommand(backend, "no-network", cmd, { root });
  const out = execSync(wrapped, { cwd, env: { PATH: process.env.PATH ?? "" } }).toString();
  const m = /eval:\s*(\d+)\s*\/\s*\d+\s*passed/.exec(out);
  return m && m[1] ? Number.parseInt(m[1], 10) : 0;
}

/**
 * The production evaluator: copy the candidate + the eval fixtures into an
 * ephemeral staging workspace, integrity-hash the fixtures, then score the
 * candidate against a candidate-free baseline in a `no-network` sandboxed
 * subprocess (refusing when no sandbox backend exists — harness-chosen
 * fail-closed). Integration-only; offline tests inject a stub via `setEvaluator`.
 */
async function realEvaluate(candidatePath: string): Promise<EvalResult> {
  const backend = detectBackend(process.platform, binExists);
  if (backend === "none") {
    throw new Error("no sandbox backend available — refusing to evaluate (fail-closed)");
  }
  const cwd = process.cwd();
  const staging = mkdtempSync(join(tmpdir(), "eagent-selfimprove-eval-"));
  try {
    const candidateDir = join(staging, ".eagent", "extensions");
    const emptyDir = join(staging, ".eagent", "empty");
    const fixturesDir = join(staging, FIXTURES_SUBDIR);
    mkdirSync(candidateDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });
    cpSync(join(cwd, FIXTURES_SUBDIR), fixturesDir, { recursive: true });
    try {
      symlinkSync(join(cwd, "node_modules"), join(staging, "node_modules"));
    } catch {
      // best effort: dependency resolution may already be reachable from cwd
    }
    cpSync(candidatePath, join(candidateDir, "candidate.ts"));

    const pre = hashFixtures(fixturesDir);
    const baseline = runScored(backend, emptyDir, fixturesDir, staging, cwd);
    const candidate = runScored(backend, candidateDir, fixturesDir, staging, cwd);
    const post = hashFixtures(fixturesDir);

    const tamper = pre !== post;
    const delta = candidate - baseline;
    return { baseline, candidate, delta, improved: !tamper && delta > 0, tamper };
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

let evaluator: Evaluator = realEvaluate;

/** Test hook: swap the evaluator (default `realEvaluate`) for a deterministic stub. */
export function setEvaluator(fn: Evaluator): void {
  evaluator = fn;
}

export default function activate(e: ExtensionAPI): () => void {
  if (process.env.EAGENT_SELF_IMPROVE === "off") return () => {};

  const isEnabled = (): boolean => e.store.get<boolean>("enabled", false) ?? false;
  const maxStaged = (): number => e.store.get<number>("maxStaged", DEFAULT_MAX_STAGED) ?? DEFAULT_MAX_STAGED;

  const candidatesDir = (): string =>
    e.store.get<string>("candidatesDir") ??
    join(process.env.EAGENT_WORKSPACE ?? process.cwd(), ".eagent", "candidates");
  const liveExtensionsDir = (): string =>
    e.store.get<string>("extensionsDir") ??
    join(process.env.EAGENT_WORKSPACE ?? process.cwd(), ".eagent", "extensions");

  const load = (): Candidate[] => e.store.get<Candidate[]>("candidates", [])!;
  const save = (list: Candidate[]): void => {
    while (list.length > maxStaged()) {
      const evicted = list.shift();
      if (evicted && evicted.status !== "adopted") {
        try {
          rmSync(join(candidatesDir(), `${evicted.slug}.ts`));
        } catch {
          // a vetoed record has no file; an already-removed file is fine
        }
      }
    }
    e.store.set("candidates", list);
  };
  const upsert = (list: Candidate[], rec: Candidate): void => {
    const i = list.findIndex((c) => c.slug === rec.slug);
    if (i >= 0) list[i] = rec;
    else list.push(rec);
  };

  const offPropose = e.registerTool(
    defineTool<{ name?: string; code?: string; rationale?: string }>({
      name: "propose_improvement",
      description:
        "Stage a candidate extension (a TypeScript module with a default-exported `activate`) for review. " +
        "The source is statically vetoed and written to a staging dir, but never executed or loaded.",
      capabilities: ["self:extend"],
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Kebab-case candidate name (used as the filename)." },
          code: { type: "string", description: "Full extension module source." },
          rationale: { type: "string", description: "Why this change is worth adopting." },
        },
        required: ["name", "code"],
      },
      execute: (args) => {
        if (!isEnabled()) return fail("self-improve: disabled — enable with `/self-improve on`.");
        const name = typeof args.name === "string" ? args.name : "";
        const code = typeof args.code === "string" ? args.code : "";
        const rationale = typeof args.rationale === "string" ? args.rationale : "";
        const slug = slugify(name);
        if (!slug) return fail("propose_improvement: `name` must contain at least one alphanumeric character.");
        if (!code.trim()) return fail("propose_improvement: `code` is required and cannot be empty.");

        const verdict = vetoCandidate(code);
        const list = load();
        if (!verdict.ok) {
          const rec: Candidate = { slug, name, rationale, ts: Date.now(), status: "vetoed", reasons: verdict.reasons };
          upsert(list, rec);
          save(list);
          return ok(`Candidate "${slug}" vetoed: ${verdict.reasons.join("; ")}`, rec);
        }
        const path = join(candidatesDir(), `${slug}.ts`);
        try {
          mkdirSync(candidatesDir(), { recursive: true });
          writeFileSync(path, code, "utf8");
        } catch (err) {
          return fail(`propose_improvement: cannot write ${path}: ${(err as Error).message}`);
        }
        const rec: Candidate = { slug, name, rationale, ts: Date.now(), status: "staged" };
        upsert(list, rec);
        save(list);
        return ok(`Candidate "${slug}" staged at ${path}.`, rec);
      },
    }),
  );

  const offEvaluate = e.registerTool(
    defineTool<{ name?: string }>({
      name: "evaluate_candidate",
      description:
        "Score a staged candidate's fitness in an isolated sandboxed subprocess and record the advisory delta. " +
        "Does NOT load the candidate into the live agent.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The candidate name to evaluate." } },
        required: ["name"],
      },
      execute: async (args) => {
        if (!isEnabled()) return fail("self-improve: disabled — enable with `/self-improve on`.");
        const slug = slugify(typeof args.name === "string" ? args.name : "");
        const list = load();
        const rec = list.find((c) => c.slug === slug);
        if (!rec) return fail(`evaluate_candidate: no candidate named "${slug}".`);
        if (rec.status === "vetoed") return fail(`evaluate_candidate: "${slug}" was vetoed and cannot be evaluated.`);

        let result: EvalResult;
        try {
          result = await evaluator(join(candidatesDir(), `${slug}.ts`));
        } catch (err) {
          return fail(`evaluate_candidate: evaluation failed — ${(err as Error).message}`);
        }
        rec.delta = result.delta;
        rec.tamper = result.tamper;
        rec.improved = result.tamper ? false : result.improved;
        rec.status = "evaluated";
        upsert(list, rec);
        save(list);
        return ok(
          `Candidate "${slug}" evaluated: delta=${result.delta}, improved=${rec.improved}, tamper=${result.tamper}.`,
          rec,
        );
      },
    }),
  );

  const offAdopt = e.registerTool(
    defineTool<{ name?: string }>({
      name: "adopt_improvement",
      description:
        "Adopt a non-vetoed candidate after human source-review. Surfaces the source and the advisory eval " +
        "delta, then requires an interactive `ui.ask` approval (NOT yolo-able); on approval, loads it live.",
      capabilities: ["self:extend"],
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The candidate name to adopt." } },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        if (!isEnabled()) return fail("self-improve: disabled — enable with `/self-improve on`.");
        const slug = slugify(typeof args.name === "string" ? args.name : "");
        const list = load();
        const rec = list.find((c) => c.slug === slug);
        if (!rec) return fail(`adopt_improvement: no candidate named "${slug}".`);
        if (rec.status === "vetoed") return fail(`adopt_improvement: "${slug}" was vetoed and cannot be adopted.`);

        const stagedPath = join(candidatesDir(), `${slug}.ts`);
        let source: string;
        try {
          source = readFileSync(stagedPath, "utf8");
        } catch (err) {
          return fail(`adopt_improvement: cannot read staged candidate ${stagedPath}: ${(err as Error).message}`);
        }
        const advisory =
          rec.delta === undefined ? "(not evaluated)" : `delta=${rec.delta}, improved=${rec.improved}, tamper=${rec.tamper}`;
        ctx.progress(`Candidate "${slug}" source:\n${source}\nAdvisory eval: ${advisory}\n`);
        const answer = e.agent.ui.ask
          ? await e.agent.ui.ask(`Adopt "${slug}"? Review the source above. Loads in-process with full authority. yes/no`)
          : null;
        if (typeof answer !== "string" || !/^\s*y/i.test(answer)) {
          return fail(`adopt_improvement: "${slug}" not adopted — human approval was not granted (fail-closed).`);
        }

        const livePath = join(liveExtensionsDir(), `${slug}.ts`);
        try {
          mkdirSync(liveExtensionsDir(), { recursive: true });
          renameSync(stagedPath, livePath);
        } catch (err) {
          return fail(`adopt_improvement: cannot move candidate to ${livePath}: ${(err as Error).message}`);
        }
        let id: string;
        try {
          id = await e.loadExtension(livePath);
        } catch (err) {
          return fail(`adopt_improvement: moved ${livePath} but loading it failed: ${(err as Error).message}`, {
            path: livePath,
            loaded: false,
          });
        }
        rec.status = "adopted";
        upsert(list, rec);
        save(list);
        return ok(`Adopted "${slug}" as extension "${id}" from ${livePath}.`, { id, path: livePath });
      },
    }),
  );

  const offCmd = e.registerCommand({
    name: "self-improve",
    description: "Toggle/inspect the self-improvement harness. Usage: /self-improve [on|off|status|list]",
    run: (ctx) => {
      const arg = ctx.args.trim().toLowerCase();
      if (arg === "on") {
        e.store.set("enabled", true);
        ctx.print("self-improve: on");
      } else if (arg === "off") {
        e.store.set("enabled", false);
        ctx.print("self-improve: off");
      } else if (arg === "list") {
        const list = load();
        if (list.length === 0) {
          ctx.print("self-improve: no candidates");
          return;
        }
        for (const c of list) {
          const detail = c.reasons?.length
            ? ` — ${c.reasons.join("; ")}`
            : c.delta !== undefined
              ? ` (delta=${c.delta}, improved=${c.improved}, tamper=${c.tamper})`
              : "";
          ctx.print(`  ${c.slug} [${c.status}]${detail}`);
        }
      } else {
        ctx.print(`self-improve: ${isEnabled() ? "on" : "off"} (${load().length} candidate(s), max ${maxStaged()})`);
      }
    },
  });

  return () => {
    for (const d of [offPropose, offEvaluate, offAdopt, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
