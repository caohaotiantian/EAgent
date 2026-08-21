/**
 * headless-flags — make shell commands non-blocking under CI/headless runs.
 *
 * The pure helpers (`rewriteCommand`, `resolveHeadless`, `parseAdd`) are
 * unit-tested directly; the rewrite is also exercised through the agent loop with
 * a stub `shell:exec` tool (no real shell), and the `/headless` command surface is
 * driven directly. All offline against MockProvider — no network, no TTY, no OS
 * sandbox. Env vars are saved/restored in try/finally so detection is deterministic.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../src/kernel/define.ts";
import type { Agent } from "../src/kernel/agent.ts";
import { makeHarness } from "./helpers.ts";
import headlessFlags, {
  rewriteCommand,
  resolveHeadless,
  parseAdd,
  DEFAULT_DICT,
} from "../src/extensions/headless-flags.ts";

const GIT = "GIT_TERMINAL_PROMPT=0 GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true";

// Pin platform to posix so the env-prefix branch is exercised regardless of host.
const rw = (command: string): string => rewriteCommand(command, DEFAULT_DICT, "linux");

// --- pure rewriteCommand --------------------------------------------------

test("rewriteCommand prepends git env guards (no spurious -m)", () => {
  assert.equal(rw("git commit"), `${GIT} git commit`);
  assert.equal(rw("git rebase -i main"), `${GIT} git rebase -i main`);
  // An already-non-interactive commit gets only the harmless env guards.
  assert.equal(rw('git commit -m "x"'), `${GIT} git commit -m "x"`);
});

test("rewriteCommand: an assignment-looking operand does not suppress a guard; a real leading assignment does", () => {
  // A `VAR=val`-looking word inside a quoted operand must NOT count as already-set.
  assert.equal(rw('git commit -m "GIT_EDITOR=x"'), `${GIT} git commit -m "GIT_EDITOR=x"`);
  // A real leading assignment the user already set suppresses only that one guard.
  const out = rw("GIT_EDITOR=vim git commit");
  assert.ok(!out.includes("GIT_EDITOR=true"), "the user's leading GIT_EDITOR is respected, not overridden");
  assert.ok(out.includes("GIT_EDITOR=vim"), "the user's value is preserved");
  assert.ok(out.includes("GIT_TERMINAL_PROMPT=0"), "the other guards are still prepended");
});

test("rewriteCommand adds documented non-interactive flags", () => {
  assert.equal(rw("apt-get install foo"), "DEBIAN_FRONTEND=noninteractive apt-get install -y foo");
  assert.equal(rw("npm init"), "npm init -y");
});

test("rewriteCommand leaves already-non-interactive and unknown commands untouched", () => {
  assert.equal(rw("apt-get install -y foo"), "apt-get install -y foo"); // flag present -> unchanged
  assert.equal(rw("npm install"), "npm install"); // no `npm` family -> unchanged
  assert.equal(rw("frobnicate --foo"), "frobnicate --foo"); // unknown program
  assert.equal(rw('echo "git commit"'), 'echo "git commit"'); // quoted operand, program is echo
});

test("rewriteCommand handles compound, path-qualified, and wrapped commands", () => {
  assert.equal(rw("git fetch && git rebase"), `${GIT} git fetch && ${GIT} git rebase`);
  assert.equal(rw("/usr/bin/git commit"), `${GIT} /usr/bin/git commit`);
  assert.equal(rw("sudo apt-get install foo"), "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y foo");
});

test("rewriteCommand is idempotent over its own output", () => {
  assert.equal(rw(rw("git commit")), rw("git commit"));
  assert.equal(rw(rw("apt-get install foo")), rw("apt-get install foo"));
});

test("rewriteCommand skips the env prefix on win32 but still adds the flag", () => {
  assert.equal(rewriteCommand("apt-get install foo", DEFAULT_DICT, "win32"), "apt-get install -y foo");
  assert.equal(rewriteCommand("git commit", DEFAULT_DICT, "win32"), "git commit"); // env-only -> unchanged on win32
});

// --- pure resolveHeadless -------------------------------------------------

const BOTH_TTY = { stdin: true, stdout: true };

test("resolveHeadless honors the explicit override first", () => {
  assert.equal(resolveHeadless({ EAGENT_HEADLESS: "on" }, BOTH_TTY).headless, true);
  assert.equal(resolveHeadless({ EAGENT_HEADLESS: "off", CI: "true" }, BOTH_TTY).headless, false);
});

test("resolveHeadless detects CI signals and interactive TTYs", () => {
  assert.equal(resolveHeadless({ CI: "true" }, BOTH_TTY).headless, true);
  assert.equal(resolveHeadless({ GITHUB_ACTIONS: "true" }, BOTH_TTY).headless, true);
  assert.equal(resolveHeadless({}, BOTH_TTY).headless, false);
  // A non-TTY stream alone is enough, even without CI.
  assert.equal(resolveHeadless({}, { stdin: false, stdout: true }).headless, true);
});

// --- pure parseAdd --------------------------------------------------------

test("parseAdd parses a program + flag (+ env)", () => {
  assert.deepEqual(parseAdd("gh --yes"), { program: "gh", entry: { flag: "--yes", skip: ["--yes"] } });
  assert.deepEqual(parseAdd("apt PIP=1 --yes"), {
    program: "apt",
    entry: { flag: "--yes", skip: ["--yes"], env: ["PIP=1"] },
  });
  assert.equal(parseAdd("gh"), null); // program only -> nothing to inject
});

// --- integration through the agent loop -----------------------------------

/** Register a shell:exec tool that records each command it is asked to run. */
function recordShell(agent: Agent): { commands: string[] } {
  const rec = { commands: [] as string[] };
  agent.tools.register(
    defineTool({
      name: "bash",
      description: "",
      capabilities: ["shell:exec"],
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: (args) => {
        rec.commands.push(String(args.command));
        return { content: "ran" };
      },
    }),
  );
  return rec;
}

/** Save/restore the two env switches around a headless test body. */
async function withEnv(
  vars: { EAGENT_HEADLESS?: string; EAGENT_HEADLESS_FLAGS?: string },
  body: () => Promise<void>,
): Promise<void> {
  const prevH = process.env.EAGENT_HEADLESS;
  const prevF = process.env.EAGENT_HEADLESS_FLAGS;
  if (vars.EAGENT_HEADLESS === undefined) delete process.env.EAGENT_HEADLESS;
  else process.env.EAGENT_HEADLESS = vars.EAGENT_HEADLESS;
  if (vars.EAGENT_HEADLESS_FLAGS === undefined) delete process.env.EAGENT_HEADLESS_FLAGS;
  else process.env.EAGENT_HEADLESS_FLAGS = vars.EAGENT_HEADLESS_FLAGS;
  try {
    await body();
  } finally {
    if (prevH === undefined) delete process.env.EAGENT_HEADLESS;
    else process.env.EAGENT_HEADLESS = prevH;
    if (prevF === undefined) delete process.env.EAGENT_HEADLESS_FLAGS;
    else process.env.EAGENT_HEADLESS_FLAGS = prevF;
  }
}

test("headless on: a shell command is rewritten through beforeToolCall", async () => {
  await withEnv({ EAGENT_HEADLESS: "on" }, async () => {
    const h = makeHarness({
      fallback: "allow",
      responder: [{ toolCalls: [{ name: "bash", arguments: { command: "git commit" } }] }, { text: "done" }],
    });
    const rec = recordShell(h.agent);
    await h.host.use("headless-flags", headlessFlags);

    await h.agent.run("commit");
    assert.equal(rec.commands.length, 1);
    assert.equal(rec.commands[0], `${GIT} git commit`);
  });
});

test("forced interactive (EAGENT_HEADLESS=off): the command passes through verbatim", async () => {
  await withEnv({ EAGENT_HEADLESS: "off" }, async () => {
    const h = makeHarness({
      fallback: "allow",
      responder: [{ toolCalls: [{ name: "bash", arguments: { command: "git commit" } }] }, { text: "done" }],
    });
    const rec = recordShell(h.agent);
    await h.host.use("headless-flags", headlessFlags);

    await h.agent.run("commit");
    assert.equal(rec.commands[0], "git commit");
  });
});

test("EAGENT_HEADLESS_FLAGS=off disables the rewrite even when headless", async () => {
  await withEnv({ EAGENT_HEADLESS: "on", EAGENT_HEADLESS_FLAGS: "off" }, async () => {
    const h = makeHarness({
      fallback: "allow",
      responder: [{ toolCalls: [{ name: "bash", arguments: { command: "git commit" } }] }, { text: "done" }],
    });
    const rec = recordShell(h.agent);
    await h.host.use("headless-flags", headlessFlags);

    await h.agent.run("commit");
    assert.equal(rec.commands[0], "git commit");
  });
});

test("a non-shell tool call is never rewritten", async () => {
  await withEnv({ EAGENT_HEADLESS: "on" }, async () => {
    const h = makeHarness({
      fallback: "allow",
      responder: [{ toolCalls: [{ name: "note", arguments: { command: "git commit" } }] }, { text: "done" }],
    });
    let seen = "";
    h.agent.tools.register(
      defineTool({
        name: "note",
        description: "",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        execute: (args) => {
          seen = String(args.command);
          return { content: "ok" };
        },
      }),
    );
    await h.host.use("headless-flags", headlessFlags);

    await h.agent.run("note");
    assert.equal(seen, "git commit", "no shell:exec capability -> not rewritten");
  });
});

// --- command surface ------------------------------------------------------

async function loadCmd(): Promise<{ run: (args: string) => Promise<string>; agent: Agent }> {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("headless-flags", headlessFlags);
  const cmd = h.commands.get("headless")!;
  const run = async (args: string): Promise<string> => {
    let out = "";
    await cmd.run({ agent: h.agent, args, print: (l) => (out += `${l}\n`) });
    return out;
  };
  return { run, agent: h.agent };
}

test("/headless test prints the dry-run rewrite", async () => {
  const { run } = await loadCmd();
  const out = await run('test "git commit"');
  assert.match(out, /GIT_SEQUENCE_EDITOR=true git commit/);
});

test("/headless add teaches a new program, reflected on the next rewrite", async () => {
  const { run } = await loadCmd();
  await run("add gh --yes");
  const out = await run('test "gh pr merge"');
  assert.match(out, /gh --yes pr merge/);
});

test("/headless remove drops a built-in entry", async () => {
  const { run } = await loadCmd();
  await run("remove git");
  const out = await run('test "git commit"');
  assert.equal(out.trim(), "git commit", "git is no longer rewritten");
});

test("/headless status reports the resolution and on/off state", async () => {
  await withEnv({ EAGENT_HEADLESS: "on" }, async () => {
    const { run } = await loadCmd();
    const out = await run("");
    assert.match(out, /headless-flags on/);
    assert.match(out, /headless=true/);
  });
});

test("/headless off then on toggles the kill switch via the persisted config override", async () => {
  const { run } = await loadCmd();
  await run("off");
  assert.match(await run(""), /headless-flags off/, "/headless off disables via the override");
  await run("on");
  assert.match(await run(""), /headless-flags on/, "/headless on re-enables via the override");
});
