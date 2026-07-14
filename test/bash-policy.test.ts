/**
 * bash-policy — command-granular shell authority. The pure helpers
 * (extractCommand, evaluate) are unit-tested directly; the guard is exercised
 * through the agent loop with only bash-policy loaded, so any ui.confirm is
 * unambiguously bash-policy's. All offline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../src/kernel/define.js";
import { Agent } from "../src/kernel/agent.js";
import type { CompletionRequest, UI } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";
import bashPolicy, {
  extractCommand,
  evaluate,
  evaluateAny,
  normalizeProgram,
  unwrap,
  segments,
  findExecCommands,
  expandCommands,
  toRegExp,
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

test("segments splits on shell operators outside quotes/groups, spacing-independent", () => {
  assert.deepEqual(segments("git status && rm -rf build"), ["git status", "rm -rf build"]);
  assert.deepEqual(segments("a | b ; c"), ["a", "b", "c"]);
  assert.deepEqual(segments("true || rm x"), ["true", "rm x"]);

  assert.deepEqual(segments("git status&&rm -rf build"), ["git status", "rm -rf build"]);
  assert.deepEqual(segments("a|rm x"), ["a", "rm x"]);

  assert.deepEqual(segments('git commit -m "a; b"'), ['git commit -m "a; b"']);
  assert.deepEqual(segments('echo "a | b"'), ['echo "a | b"']);
  assert.deepEqual(segments('echo "a\\"b" && ls'), ['echo "a\\"b"', "ls"]);
  assert.deepEqual(segments("find . -exec rm {} \\;"), ["find . -exec rm {} \\;"]);

  assert.deepEqual(segments("echo $(a && b)"), ["echo $(a && b)"]);
  assert.deepEqual(segments("sleep 1 &"), ["sleep 1 &"]);
});

test("findExecCommands extracts find's embedded commands between primary and terminator", () => {
  assert.deepEqual(findExecCommands("find . -name '*.log' -exec rm -f {} \\;"), ["rm -f {}"]);
  assert.deepEqual(
    findExecCommands("find . -exec chmod 644 {} + -exec chown me {} \\;"),
    ["chmod 644 {}", "chown me {}"],
  );
  assert.deepEqual(findExecCommands("rm -rf build"), []);
  assert.deepEqual(findExecCommands("find . -exec g++ -O2 {} +"), ["g++ -O2 {}"]);
});

test("unwrap exposes the inner command of xargs regardless of option spelling", () => {
  assert.equal(unwrap("xargs rm -rf"), "rm -rf");
  assert.equal(unwrap("xargs -n1 rm"), "rm");
  assert.equal(unwrap("xargs -n 1 rm"), "rm");
  assert.equal(unwrap("xargs -I{} rm {}"), "rm {}");
  assert.equal(unwrap("xargs -I {} rm {}"), "rm {}");
});

test("expandCommands is the whole line plus deduped sub-commands, inner last", () => {
  assert.deepEqual(expandCommands("sudo rm -rf build"), ["sudo rm -rf build", "rm -rf build"]);
  assert.ok(expandCommands("cat x | xargs rm -rf").includes("rm -rf"));
  assert.ok(expandCommands("find . -exec rm {} \\;").includes("rm {}"));
  assert.ok(expandCommands("git status && rm -rf build").indexOf("rm -rf build") > 0);
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

test("ask remembers a command family across a session's run tree (survives session_start)", async () => {
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

  // `approved` is now keyed on the session ROOT (`e.rootAgent`) and GC'd on
  // eviction, not cleared on `session_start` (that reset closure was removed in
  // Phase B — session_start fires once at startup, before any approval). So a
  // later run on the SAME agent stays remembered; cross-session isolation (a fresh
  // Agent re-prompts) is covered by the AC1 test below.
  await h.agent.hooks.emit("session_start", {});

  h.provider.script([{ toolCalls: [{ name: "bash", arguments: { command: "curl http://c" } }] }, { text: "done" }]);
  await h.agent.run("another curl on the same session");
  assert.equal(confirms, 1, "the approval survives session_start (same run-tree root, no reset)");
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

for (const command of [
  "git status && rm -rf build",
  "cat list | xargs rm -rf",
  "find . -name '*.log' -exec rm -f {} \\;",
  ": ; rm -rf build",
]) {
  test(`deny on an embedded/piped/compound rm blocks: ${command}`, async () => {
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
    assert.equal(didRun(), false, "the embedded/piped/compound rm is blocked");
    assert.equal(sawBlock(h.agent), true, "the model sees the bash-policy block reason");
  });
}

test("a quoted operator does not produce a spurious blocked segment", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      { toolCalls: [{ name: "bash", arguments: { command: 'git commit -m "fixup; rm temp"' } }] },
      { text: "done" },
    ],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "rm *", action: "deny" }]);
    return bashPolicy(e);
  });

  await h.agent.run("commit");
  assert.equal(didRun(), true, "the quoted `;` is not a split, so no rm segment is produced");
  assert.equal(sawBlock(h.agent), false, "no bash-policy block reason");
});

test("empty ruleset still runs a compound command (no regression)", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      { toolCalls: [{ name: "bash", arguments: { command: "git status && rm -rf build" } }] },
      { text: "done" },
    ],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", bashPolicy);

  await h.agent.run("status then clean");
  assert.equal(didRun(), true, "no rules, no block");
  assert.equal(sawBlock(h.agent), false, "no bash-policy block reason");
});

test("ask remember key is scoped to the offending sub-command", async () => {
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
      { toolCalls: [{ name: "bash", arguments: { command: "a && rm -rf x" } }] },
      { toolCalls: [{ name: "bash", arguments: { command: "rm -rf y" } }] },
      { text: "done" },
    ],
  });
  shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "rm *", action: "ask" }]);
    return bashPolicy(e);
  });

  await h.agent.run("two removes");
  assert.equal(confirms, 1, "approving the sub-command rm covers the later bare rm");
});

test("toRegExp alternation, escape, and degenerate forms", () => {
  const alt = toRegExp("git [add|commit] *");
  assert.equal(alt.test("git add x"), true);
  assert.equal(alt.test("git commit x"), true);
  assert.equal(alt.test("git push x"), false);
  assert.equal(alt.test("git addcommit x"), false);

  const meta = toRegExp("[a*|b.c]");
  assert.equal(meta.test("axxx"), true);
  assert.equal(meta.test("b.c"), true);
  assert.equal(meta.test("bxc"), false);

  let pipe: RegExp | undefined;
  assert.doesNotThrow(() => {
    pipe = toRegExp("a|b");
  });
  assert.equal(pipe!.test("a|b"), true);
  assert.equal(pipe!.test("a"), false);

  let unterminated: RegExp | undefined;
  assert.doesNotThrow(() => {
    unterminated = toRegExp("a[b");
  });
  assert.equal(unterminated!.test("a[b"), true);

  const escaped = toRegExp("\\[a\\|b\\]");
  assert.equal(escaped.test("[a|b]"), true);
  assert.equal(escaped.test("a"), false);
  assert.equal(escaped.test("b"), false);

  assert.equal(toRegExp("find * \\;").test("find x \\;"), true);

  const edge = toRegExp("[a|]");
  assert.equal(edge.test("a"), true);
  assert.equal(edge.test("b"), false);

  const backcompat = toRegExp("rm *");
  assert.equal(backcompat.test("rm -rf x"), true);
  assert.equal(backcompat.test("git rm x"), false);
});

test("evaluateAny returns the matched rule", () => {
  const rules: Rule[] = [{ pattern: "rm *", action: "deny", justification: "j" }];
  const hit = evaluateAny(["rm -rf x"], rules, "allow");
  assert.equal(hit.action, "deny");
  assert.equal(hit.matched, "rm -rf x");
  assert.equal(hit.rule, rules[0]);

  const miss = evaluateAny(["ls"], [], "allow");
  assert.equal(miss.action, "allow");
  assert.equal(miss.matched, "ls");
  assert.equal(miss.rule, undefined);
});

/** The bash-policy block reason (from `bash-policy:` on) the model saw, or undefined. */
function blockReason(agent: Agent): string | undefined {
  for (const m of agent.messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const at = b.content.indexOf("bash-policy: ");
        if (at >= 0) return b.content.slice(at);
      }
    }
  }
  return undefined;
}

test("justification surfaces on a deny block reason", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf x" } }] }, { text: "done" }],
  });
  shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "rm *", action: "deny", justification: "destructive" }]);
    return bashPolicy(e);
  });

  await h.agent.run("clean up");
  const reason = blockReason(h.agent);
  assert.ok(reason !== undefined, "the model saw a block reason");
  assert.match(reason!, /destructive/);
  assert.match(reason!, /bash-policy: blocked/);
  assert.match(reason!, /\(policy deny\)/);
});

test("justification surfaces on the ask prompt and denied reason", async () => {
  let prompt = "";
  const h = makeHarness({
    fallback: "allow",
    ui: {
      confirm: async (q: string) => {
        prompt = q;
        return false;
      },
      notify: () => {},
    },
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "curl http://x" } }] }, { text: "done" }],
  });
  shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "curl *", action: "ask", justification: "why-ask" }]);
    return bashPolicy(e);
  });

  await h.agent.run("fetch");
  assert.match(prompt, /\(why-ask\)\?$/);
  const reason = blockReason(h.agent);
  assert.ok(reason !== undefined, "the model saw a block reason");
  assert.match(reason!, /why-ask/);
});

test("absent justification is byte-identical on a deny reason", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf x" } }] }, { text: "done" }],
  });
  shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "rm *", action: "deny" }]);
    return bashPolicy(e);
  });

  await h.agent.run("clean up");
  assert.equal(blockReason(h.agent), "bash-policy: blocked rm (policy deny)");
});

test("alternation blocks one alternative through the guard and lets another run", async () => {
  const hBlocked = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "git commit -m x" } }] }, { text: "done" }],
  });
  const blockedRan = shellTool(hBlocked.agent);
  await hBlocked.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "git [add|commit] *", action: "deny" }]);
    return bashPolicy(e);
  });
  await hBlocked.agent.run("commit");
  assert.equal(blockedRan(), false, "the matched alternative is blocked");
  assert.equal(sawBlock(hBlocked.agent), true, "the model sees the block reason");

  const hRun = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "git push x" } }] }, { text: "done" }],
  });
  const pushRan = shellTool(hRun.agent);
  await hRun.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "git [add|commit] *", action: "deny" }]);
    return bashPolicy(e);
  });
  await hRun.agent.run("push");
  assert.equal(pushRan(), true, "a non-matching alternative runs");
  assert.equal(sawBlock(hRun.agent), false, "no block reason");
});

test("status prints the justification while an unjustified rule line is unchanged", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [
      { pattern: "rm *", action: "deny", justification: "destructive" },
      { pattern: "ls *", action: "allow" },
    ]);
    return bashPolicy(e);
  });

  let printed = "";
  await h.commands.get("bash-policy")!.run({
    agent: h.agent,
    args: "status",
    print: (line: string) => {
      printed += line;
    },
  });

  assert.match(printed, /destructive/);
  assert.match(printed, /rm \* -> deny/);
  assert.match(printed, /ls \* -> allow/);
  assert.doesNotMatch(printed, /ls \* -> allow \(/);
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

// -- Phase B: the session-approved command set is keyed on the SESSION ROOT -----
// `approved` (an ask-rule's per-session grant) must not carry from session A into
// session B. Mirrors the server model: one activation, distinct per-session-root
// Agents. (Not exercised through the HTTP server because its `ui.confirm` is
// fail-safe-DENY, so `approved` never populates there — design §2.)

/** A second per-session Agent sharing the host's single activation. */
function sessionAgent(template: Agent): Agent {
  return new Agent({
    hooks: template.hooks,
    tools: template.tools,
    providers: template.providers,
    capabilities: template.capabilities,
    ui: template.ui,
    logger: template.logger,
    model: template.model,
    provider: template.providerName,
  });
}

test("AC1: session A's session-approval of a command family does not skip session B's prompt", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), true), notify: () => {} };
  const responder = (req: CompletionRequest) =>
    req.messages.filter((m) => m.role === "tool").length === 0
      ? { toolCalls: [{ name: "sh", arguments: { command: "echo hi" } }] }
      : { text: "done" };
  const h = makeHarness({ responder, ui, fallback: "allow" });
  h.agent.tools.register(
    defineTool({ name: "sh", description: "a shell tool", capabilities: ["shell:exec"], execute: () => ({ content: "ok" }) }),
  );
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "echo*", action: "ask" }]);
    return bashPolicy(e);
  });

  const b = sessionAgent(h.agent);

  await h.agent.run("A first"); // echo → ask → approve
  await h.agent.run("A second"); // echo → approved (cached) → NO re-prompt
  assert.equal(confirms, 1, "A's session approval is cached — the second echo is not re-prompted");

  await b.run("B"); // echo → B's approved set is empty → prompted again
  assert.equal(confirms, 2, "B is prompted despite A's approval (the approved set is per-session-root)");
});
