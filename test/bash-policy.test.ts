/**
 * bash-policy — command-granular shell authority. The pure helpers
 * (extractCommand, evaluate) are unit-tested directly; the guard is exercised
 * through the agent loop with only bash-policy loaded, so any ui.confirm is
 * unambiguously bash-policy's. All offline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../src/kernel/define.js";
import type { Agent } from "../src/kernel/agent.js";
import { makeHarness } from "./helpers.js";
import bashPolicy, {
  extractCommand,
  evaluate,
  evaluateAny,
  normalizeProgram,
  unwrap,
  type Rule,
} from "../src/extensions/bash-policy.js";

test("extractCommand reduces a command line to its arity-based command family", () => {
  assert.equal(extractCommand('git commit -m "wip"'), "git commit");
  assert.equal(extractCommand("npm run dev --silent"), "npm run dev");
  assert.equal(extractCommand("git checkout -b feature"), "git checkout");
  assert.equal(extractCommand("python script.py"), "python script.py");
  assert.equal(extractCommand("frobnicate a b"), "frobnicate");
  assert.equal(extractCommand("FOO=bar rm -rf build"), "rm");
  assert.equal(extractCommand("   "), "");
});

test("evaluate resolves a ruleset with last-match-wins wildcard precedence", () => {
  const rules: Rule[] = [
    { pattern: "*", action: "ask" },
    { pattern: "git *", action: "allow" },
    { pattern: "git push *", action: "deny" },
  ];
  assert.equal(evaluate("git status", rules, "allow"), "allow");
  assert.equal(evaluate("git push origin main", rules, "allow"), "deny");
  assert.equal(evaluate("curl http://x", rules, "allow"), "ask");
  assert.equal(evaluate("git status", [], "allow"), "allow");
});

test("evaluate matches wildcards literally except for *", () => {
  const rules: Rule[] = [{ pattern: "rm *.b", action: "deny" }];
  assert.equal(evaluate("rm -rf a.b", rules, "allow"), "deny");
  assert.equal(evaluate("rm -rf axb", rules, "allow"), "allow");
});

test("normalizeProgram strips the program's path to its basename", () => {
  assert.equal(normalizeProgram("/bin/rm -rf build"), "rm -rf build");
  assert.equal(normalizeProgram("/usr/bin/git commit"), "git commit");
  assert.equal(normalizeProgram("./script.sh arg"), "script.sh arg");
  assert.equal(normalizeProgram("../sbin/rm x"), "rm x");
  assert.equal(normalizeProgram("bin/rm x"), "rm x");
  // Environment assignments are preserved; only argv[0] is rewritten.
  assert.equal(normalizeProgram("FOO=bar /usr/bin/rm -rf x"), "FOO=bar rm -rf x");
});

test("normalizeProgram leaves bare programs and path-like arguments untouched", () => {
  assert.equal(normalizeProgram("rm -rf build"), "rm -rf build");
  assert.equal(normalizeProgram("git commit"), "git commit");
  // A path operand is not the program, so it must not be normalized.
  assert.equal(normalizeProgram("cat /etc/passwd"), "cat /etc/passwd");
  assert.equal(normalizeProgram("rm /bin/foo"), "rm /bin/foo");
  // A trailing-slash program has no basename to extract; leave it alone.
  assert.equal(normalizeProgram("/bin/ x"), "/bin/ x");
  assert.equal(normalizeProgram(""), "");
});

test("extractCommand resolves a path-qualified program against the arity table", () => {
  assert.equal(extractCommand(normalizeProgram("/usr/bin/git checkout -b feature")), "git checkout");
  assert.equal(extractCommand(normalizeProgram("/bin/rm -rf build")), "rm");
});

test("unwrap exposes the inner command of a recognized wrapper", () => {
  assert.equal(unwrap("sudo rm -rf build"), "rm -rf build");
  assert.equal(unwrap("env FOO=bar rm -rf build"), "rm -rf build");
  assert.equal(unwrap("nice -n 10 rm x"), "rm x");
  assert.equal(unwrap("timeout 5 rm x"), "rm x");
  assert.equal(unwrap("sudo -u root rm x"), "rm x");
  assert.equal(normalizeProgram(unwrap("sudo env /bin/rm x")!), "rm x");
  assert.equal(unwrap("/usr/bin/sudo rm x"), "rm x");
});

test("unwrap returns null for a non-wrapper or a program-less line", () => {
  assert.equal(unwrap("rm -rf build"), null);
  assert.equal(unwrap("git commit"), null);
  assert.equal(unwrap("sudo"), null);
  assert.equal(unwrap(""), null);
});

test("unwrap mis-locates the inner program of a malformed leading-positional wrapper", () => {
  // `timeout` consumes one leading positional as its duration. A malformed
  // invocation that omits the duration mis-locates the inner program. This is a
  // documented best-effort boundary: such a command is itself broken (timeout
  // would fail to parse the missing duration) and would not run, and the outer
  // line is always evaluated too, so the worst case is over-blocking an
  // already-failing command — fail-safe for a security gate.
  assert.equal(unwrap("timeout build.sh deploy"), "deploy");
  // A well-formed duration is consumed correctly, exposing the real inner program.
  assert.equal(unwrap("timeout 30s rm -rf x"), "rm -rf x");
});

test("evaluateAny is last-match-wins across candidates with the matched candidate", () => {
  const deny = evaluateAny(
    ["sudo rm -rf build", "rm -rf build"],
    [{ pattern: "rm *", action: "deny" }],
    "allow",
  );
  assert.equal(deny.action, "deny");
  assert.equal(deny.matched, "rm -rf build");

  const override = evaluateAny(
    ["sudo rm -rf build", "rm -rf build"],
    [
      { pattern: "rm *", action: "deny" },
      { pattern: "sudo rm *", action: "allow" },
    ],
    "allow",
  );
  assert.equal(override.action, "allow");
});

/** Register a shell:exec tool whose execute flips a flag, so blocking is observable. */
function shellTool(agent: Agent, name = "bash"): () => boolean {
  let ran = false;
  agent.tools.register(
    defineTool({
      name,
      description: "",
      capabilities: ["shell:exec"],
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: () => {
        ran = true;
        return { content: "ran" };
      },
    }),
  );
  return () => ran;
}

/** Did any tool-result the model saw carry a bash-policy block reason? */
function sawBlock(agent: Agent): boolean {
  return agent.messages
    .filter((m) => m.role === "tool")
    .some((m) => m.content.some((b) => b.type === "tool_result" && /bash-policy: /.test(b.content)));
}

test("default is a no-op: a bash call runs and is not blocked", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", bashPolicy);

  await h.agent.run("clean up");
  assert.equal(didRun(), true, "with no rules, the command runs");
  assert.equal(sawBlock(h.agent), false, "no bash-policy block reason");
});

test("deny blocks the matching command", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "rm *", action: "deny" }]);
    return bashPolicy(e);
  });

  await h.agent.run("clean up");
  assert.equal(didRun(), false, "a deny rule blocks execution");
  assert.equal(sawBlock(h.agent), true, "the model sees the bash-policy block reason");
});

test("deny blocks a path-qualified invocation of the program", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "/bin/rm -rf build" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "rm *", action: "deny" }]);
    return bashPolicy(e);
  });

  await h.agent.run("clean up via an absolute path");
  assert.equal(didRun(), false, "a path-qualified program is matched by its basename rule");
  assert.equal(sawBlock(h.agent), true, "the model sees the bash-policy block reason");
});

test("ask defers to the human and blocks on a 'no'", async () => {
  const h = makeHarness({
    fallback: "allow",
    ui: { confirm: async () => false, notify: () => {} },
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "curl http://x" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "curl *", action: "ask" }]);
    return bashPolicy(e);
  });

  await h.agent.run("fetch");
  assert.equal(didRun(), false, "ask + 'no' blocks");
  assert.equal(sawBlock(h.agent), true, "the model sees the bash-policy block reason");
});

test("ask passes on a 'yes'", async () => {
  const h = makeHarness({
    fallback: "allow",
    ui: { confirm: async () => true, notify: () => {} },
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "curl http://x" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "curl *", action: "ask" }]);
    return bashPolicy(e);
  });

  await h.agent.run("fetch");
  assert.equal(didRun(), true, "ask + 'yes' passes");
  assert.equal(sawBlock(h.agent), false, "no bash-policy block reason");
});

test("ask remembers within a session and re-prompts after session_start", async () => {
  let confirms = 0;
  const h = makeHarness({
    fallback: "allow",
    ui: {
      confirm: async () => {
        confirms++;
        return true;
      },
      notify: () => {},
    },
    responder: [
      { toolCalls: [{ name: "bash", arguments: { command: "curl http://a" } }] },
      { toolCalls: [{ name: "bash", arguments: { command: "curl http://b" } }] },
      { text: "done" },
    ],
  });
  shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "curl *", action: "ask" }]);
    return bashPolicy(e);
  });

  await h.agent.run("two curls");
  assert.equal(confirms, 1, "the affirmative is remembered prefix-wise for the session");

  await h.agent.hooks.emit("session_start", {});

  h.provider.script([{ toolCalls: [{ name: "bash", arguments: { command: "curl http://c" } }] }, { text: "done" }]);
  await h.agent.run("another curl after reset");
  assert.equal(confirms, 2, "remember cleared on session_start, so confirm is asked again");
});

test("capability fidelity: a shell:exec tool named other than bash is gated", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "sh", arguments: { command: "rm -rf build" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent, "sh");
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "rm *", action: "deny" }]);
    return bashPolicy(e);
  });

  await h.agent.run("clean up");
  assert.equal(didRun(), false, "matching is on the declared capability, not the tool name");
  assert.equal(sawBlock(h.agent), true, "the model sees the bash-policy block reason");
});

for (const command of [
  "sudo rm -rf build",
  "env rm -rf build",
  "nice -n 10 rm -rf build",
  "timeout 5 rm -rf build",
  "/usr/bin/sudo rm -rf build",
]) {
  test(`deny on the inner program blocks the wrapped command: ${command}`, async () => {
    const h = makeHarness({
      fallback: "allow",
      responder: [{ toolCalls: [{ name: "bash", arguments: { command } }] }, { text: "done" }],
    });
    const didRun = shellTool(h.agent);
    await h.host.use("bash-policy", (e) => {
      e.store.set("rules", [{ pattern: "rm *", action: "deny" }]);
      return bashPolicy(e);
    });

    await h.agent.run("clean up");
    assert.equal(didRun(), false, "the inner-program deny fires through the wrapper");
    assert.equal(sawBlock(h.agent), true, "the model sees the bash-policy block reason");
  });
}

test("a wrapper-level rule still fires (no regression)", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "sudo apt update" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "sudo *", action: "deny" }]);
    return bashPolicy(e);
  });

  await h.agent.run("update");
  assert.equal(didRun(), false, "a rule on the wrapper itself still blocks");
  assert.equal(sawBlock(h.agent), true, "the model sees the bash-policy block reason");
});

test("a later allow on the wrapped form overrides an earlier inner deny", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "sudo rm -rf build" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [
      { pattern: "rm *", action: "deny" },
      { pattern: "sudo rm *", action: "allow" },
    ]);
    return bashPolicy(e);
  });

  await h.agent.run("clean up");
  assert.equal(didRun(), true, "last-match-wins re-permits the wrapped command");
  assert.equal(sawBlock(h.agent), false, "no bash-policy block reason");
});

test("empty ruleset still runs a wrapped command", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "sudo rm -rf build" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", bashPolicy);

  await h.agent.run("clean up");
  assert.equal(didRun(), true, "no rules, no block");
  assert.equal(sawBlock(h.agent), false, "no bash-policy block reason");
});

test("ask remember key is scoped to the inner program across wrappers", async () => {
  let confirms = 0;
  const h = makeHarness({
    fallback: "allow",
    ui: {
      confirm: async () => {
        confirms++;
        return true;
      },
      notify: () => {},
    },
    responder: [
      { toolCalls: [{ name: "bash", arguments: { command: "sudo rm -rf a" } }] },
      { toolCalls: [{ name: "bash", arguments: { command: "rm -rf b" } }] },
      { text: "done" },
    ],
  });
  shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "rm *", action: "ask" }]);
    return bashPolicy(e);
  });

  await h.agent.run("two removes");
  assert.equal(confirms, 1, "approving the wrapped rm covers the later bare rm");
});

test("EAGENT_BASH_POLICY=off disables the guard", async () => {
  const prev = process.env.EAGENT_BASH_POLICY;
  process.env.EAGENT_BASH_POLICY = "off";
  try {
    const h = makeHarness({
      fallback: "allow",
      responder: [{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] }, { text: "done" }],
    });
    const didRun = shellTool(h.agent);
    await h.host.use("bash-policy", (e) => {
      e.store.set("rules", [{ pattern: "rm *", action: "deny" }]);
      return bashPolicy(e);
    });

    await h.agent.run("clean up");
    assert.equal(didRun(), true, "the kill switch disables blocking");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_BASH_POLICY;
    else process.env.EAGENT_BASH_POLICY = prev;
  }
});
