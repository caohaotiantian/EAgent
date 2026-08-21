/**
 * CodeAct — code-as-action, the highest-ceiling action space.
 *
 * Instead of confining the model to a fixed menu of tools, we let it write a
 * program and run it. A single snippet can branch, loop, compose libraries, and
 * compute its own next step — an expressiveness no hand-curated tool set can
 * match. This is the action space that scales with the model.
 *
 * The whole risk lives in *where* that program runs. We execute it in a real OS
 * subprocess (via `child_process.spawn`), NOT in `node:vm`. `vm` shares the
 * parent heap and event loop and is explicitly NOT a security boundary; a
 * subprocess at least gives us a separate process to kill, a wall-clock timeout,
 * and an environment we control.
 *
 * Be honest about the strength of that boundary: a subprocess is WEAK. Process
 * isolation, a scrubbed environment, and a timeout raise the cost of mischief,
 * but generated code still runs as your user, on your filesystem, with your
 * network. The proper boundary for fully untrusted code is a container or
 * microVM — gVisor, Firecracker, Kata, or a remote sandbox like E2B. This
 * extension is deliberately the *seam* where such a sandbox plugs in: replace
 * the `spawn(...)` call with a sandbox client and the rest is unchanged. Until
 * then, treat `code:exec` as a capability you grant only when you trust the
 * surrounding policy.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineTool, fail, ok } from "../kernel/define.ts";
import type { ExtensionAPI } from "../kernel/extension.ts";
import {
  wrapCommand,
  detectBackend,
  binExists,
  isBackend,
  shquote,
  isWrapped,
  TIERS,
  type Backend,
  type Tier,
} from "./lib/sandbox.ts";

type Language = "javascript" | "python";

interface RunOutcome {
  output: string;
  isError: boolean;
  details: { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; language: Language };
}

/**
 * The resolved isolation tier for one `code:exec` run. `tier === "off"` (the
 * default) keeps the byte-identical direct spawn; otherwise the interpreter is
 * wrapped through `backend`'s launcher, or — when no backend exists — handled
 * per `missingBackend` (`block` = fail closed, `pass` = run unwrapped + warn).
 */
interface SandboxConfig {
  tier: Tier;
  backend: Backend;
  missingBackend: "block" | "pass";
  /** Emit the one-time "running unsandboxed" warning for the missing=pass path. */
  warnDegraded: () => void;
}

/** Lazily resolved: is a `python3` interpreter present on this machine? */
let python3Available: boolean | undefined;
function hasPython3(): boolean {
  if (python3Available === undefined) {
    try {
      const r = spawnSync("python3", ["--version"], { stdio: "ignore" });
      // Available only if the spawn itself succeeded and exited cleanly.
      python3Available = r.error === undefined && r.status === 0;
    } catch {
      python3Available = false;
    }
  }
  return python3Available;
}

/**
 * Run a code snippet in a fresh subprocess. We write the code to a temp file in
 * a per-call `mkdtemp` directory, spawn the interpreter on it, capture both
 * streams, and enforce a timeout and the caller's abort signal. The environment
 * is scrubbed down to a minimal allowlist so secrets in the parent process env
 * are never handed to generated code.
 */
async function runCode(
  language: Language,
  code: string,
  timeout: number,
  signal: AbortSignal,
  sandbox: SandboxConfig,
): Promise<RunOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "eagent-codeact-"));
  const isJs = language === "javascript";
  const file = join(dir, isJs ? "snippet.mjs" : "snippet.py");
  const command = isJs ? "node" : "python3";

  try {
    writeFileSync(file, code, "utf8");

    // A scrubbed environment: do not inherit `process.env` wholesale, which
    // would leak API keys and tokens into the model-authored program. HOME and
    // the working directory both point at the throwaway temp dir to discourage
    // reads of the real home/project directories (a soft boundary, not a sandbox).
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: tmpdir() };

    // tier=off spawns the interpreter directly (the unwrapped path). Once a tier
    // is selected, route the interpreter through the host's sandbox launcher
    // (writable root = the per-call temp dir), failing closed when no backend
    // exists unless missingBackend=pass degrades it to an unwrapped run.
    let spawnCmd = command;
    let spawnArgs: string[] = [file];
    if (sandbox.tier !== "off") {
      if (sandbox.backend === "none") {
        if (sandbox.missingBackend === "block") {
          // Fail closed: refuse rather than run model-authored code unsandboxed.
          // (No RunOutcome helper exists — fail()/ok() produce ToolResult.)
          return {
            output: `[codeact] refusing to run code:exec unsandboxed: no sandbox backend (tier=${sandbox.tier})`,
            isError: true,
            details: { exitCode: null, signal: null, timedOut: false, language },
          };
        }
        sandbox.warnDegraded(); // missing=pass: degrade to an unwrapped run
      } else {
        const inner = `${command} ${shquote(file)}`;
        const wrapped = isWrapped(inner) ? inner : wrapCommand(sandbox.backend, sandbox.tier, inner, { root: dir });
        spawnCmd = "/bin/sh";
        spawnArgs = ["-c", wrapped];
      }
    }

    return await new Promise<RunOutcome>((resolve) => {
      const child = spawn(spawnCmd, spawnArgs, { cwd: dir, env, signal, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout);
      timer.unref?.();

      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.stderr.on("data", (c: Buffer) => chunks.push(c));

      const finish = (exitCode: number | null, sig: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let output = Buffer.concat(chunks).toString("utf8");
        if (timedOut) output += `\n[codeact] killed after ${timeout}ms timeout`;
        resolve({
          output,
          isError: timedOut || exitCode !== 0,
          details: { exitCode, signal: sig, timedOut, language },
        });
      };

      child.on("error", (err) => {
        // e.g. interpreter missing or aborted before spawn completed.
        chunks.push(Buffer.from(`[codeact] failed to run ${command}: ${(err as Error).message}`));
        finish(null, null);
      });
      child.on("close", (exitCode, sig) => finish(exitCode, sig));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default function activate(e: ExtensionAPI): void {
  // `code:exec` is intentionally NOT auto-granted. Running model-authored code
  // is exactly the authority the capability layer exists to mediate, so we make
  // the host opt in (grant/allow) rather than ship it on by default.

  // One-time "running unsandboxed" warning for the missing=pass degraded path.
  let warnedMissing = false;

  /**
   * Resolve the isolation tier for a run. The tier (off by default) comes from
   * the store, overridable by `EAGENT_CODEACT_TIER`; `missingBackend` defaults to
   * `block` (fail closed). The backend is host-level, shared with sandbox-tiers
   * via `EAGENT_SANDBOX_BACKEND`: a recognized value is used, an unrecognized one
   * coerces to `none` (routes through the missing-backend policy rather than
   * falling through `wrapCommand`'s switch), and an unset value is detected.
   */
  const resolveSandbox = (): SandboxConfig => {
    const envTier = e.config.string("codeact.tier");
    const tier: Tier =
      envTier !== undefined && (TIERS as readonly string[]).includes(envTier)
        ? (envTier as Tier)
        : (e.store.get<Tier>("tier", "off") ?? "off");
    const missingBackend = e.store.get<"block" | "pass">("missingBackend", "block") ?? "block";
    const raw = e.config.string("sandbox.backend");
    const backend: Backend = raw ? (isBackend(raw) ? raw : "none") : detectBackend(process.platform, binExists);
    return {
      tier,
      backend,
      missingBackend,
      warnDegraded: () => {
        if (warnedMissing) return;
        warnedMissing = true;
        e.log.warn(`no sandbox backend available; running code:exec unsandboxed (tier=${tier})`);
      },
    };
  };

  e.registerTool(
    defineTool({
      name: "run_code",
      description:
        "Execute a code snippet in an isolated OS subprocess and return its combined stdout/stderr. " +
        "Use this to compute, transform data, or call libraries when no narrower tool fits. " +
        "Note: the subprocess is a weak boundary (process isolation, scrubbed env, timeout), not a full sandbox.",
      capabilities: ["code:exec"],
      // Side-effecting and process-spawning: do not interleave with peers.
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["javascript", "python"],
            description: "Interpreter: 'javascript' (node) or 'python' (python3).",
          },
          code: { type: "string", description: "The program source to execute." },
          timeout: {
            type: "integer",
            description: "Wall-clock timeout in milliseconds before the process is killed.",
            default: 30000,
          },
        },
        required: ["language", "code"],
      },
      execute: async (args, ctx) => {
        const language = args.language as Language;
        const code = String(args.code);
        const timeout = Number(args.timeout ?? 30000);

        if (language === "python" && !hasPython3()) {
          return fail("python3 is not available on this machine; cannot run python code.");
        }

        const { output, isError, details } = await runCode(language, code, timeout, ctx.signal, resolveSandbox());
        const text = output.trim() || "(no output)";
        return isError ? fail(text, details) : ok(text, details);
      },
    }),
  );

  e.registerCommand({
    name: "code",
    description: "Run a one-off code snippet: /code <language> <code...>",
    run: async (ctx) => {
      const raw = ctx.args.trim();
      const sep = raw.indexOf(" ");
      const language = (sep === -1 ? raw : raw.slice(0, sep)) as Language;
      const code = sep === -1 ? "" : raw.slice(sep + 1);

      if (language !== "javascript" && language !== "python") {
        ctx.print("usage: /code <javascript|python> <code...>");
        return;
      }
      if (!code.trim()) {
        ctx.print("usage: /code <javascript|python> <code...>");
        return;
      }

      // Route the command through the same capability check the tool uses, so a
      // denied policy blocks the one-off path too.
      try {
        await ctx.agent.capabilities.require("code:exec", "code");
      } catch (err) {
        ctx.print(`Denied: ${(err as Error).message}`);
        return;
      }

      if (language === "python" && !hasPython3()) {
        ctx.print("python3 is not available on this machine; cannot run python code.");
        return;
      }

      const { output, isError } = await runCode(language, code, 30000, new AbortController().signal, resolveSandbox());
      const text = output.trim() || "(no output)";
      ctx.print(isError ? `error: ${text}` : text);
    },
  });

  // Tier control surface, mirroring sandbox-tiers' command grammar. Distinct
  // from the one-off `/code` runner: this configures the code:exec isolation
  // tier (off by default; fail-closed once selected). No new capability.
  e.registerCommand({
    name: "codeact",
    description: "code:exec isolation tier. Usage: /codeact [status|tier <name>|missing <block|pass>]",
    run: (c) => {
      const raw = c.args.trim();
      const space = raw.indexOf(" ");
      const sub = space < 0 ? raw : raw.slice(0, space);
      const arg = space < 0 ? "" : raw.slice(space + 1).trim();

      switch (sub) {
        case "":
        case "status": {
          const s = resolveSandbox();
          c.print(`codeact tier=${s.tier}; backend=${s.backend}; missing=${s.missingBackend}`);
          break;
        }
        case "tier": {
          if (!(TIERS as readonly string[]).includes(arg)) {
            c.print(`codeact: unknown tier "${arg}"; valid: ${TIERS.join(", ")}`);
            break;
          }
          e.store.set("tier", arg);
          c.print(`codeact tier=${arg}`);
          break;
        }
        case "missing": {
          if (arg !== "block" && arg !== "pass") {
            c.print(`codeact: missing must be "block" or "pass"`);
            break;
          }
          e.store.set("missingBackend", arg);
          c.print(`codeact missing=${arg}`);
          break;
        }
        default:
          c.print(`codeact: unknown subcommand "${sub}"`);
      }
    },
  });
}
