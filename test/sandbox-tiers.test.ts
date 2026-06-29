/**
 * sandbox-tiers — OS sandbox confinement tiers for shell commands.
 *
 * The pure helpers (detectBackend, wrapCommand, shquote, isWrapped) are
 * unit-tested directly. The rewrite is exercised through the agent loop with
 * only sandbox-tiers loaded, against a recording fake `shell:exec` tool that
 * captures the command string it received — the fake never spawns a real
 * sandbox, so no launcher binary is needed and a backend is forced via the
 * store. All offline: no network, no API key, no real OS sandbox.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defineTool } from "../src/kernel/define.js";
import type { Agent } from "../src/kernel/agent.js";
import { makeHarness } from "./helpers.js";
import { binExists } from "../src/extensions/lib/sandbox.js";
import sandboxTiers, {
  detectBackend,
  wrapCommand,
  shquote,
  isWrapped,
  type Backend,
  type Tier,
} from "../src/extensions/sandbox-tiers.js";

// -- pure unit tests --------------------------------------------------------

test("detectBackend selects the platform's launcher", () => {
  const yes = (): boolean => true;
  const no = (): boolean => false;
  assert.equal(detectBackend("darwin", yes), "sandbox-exec");
  assert.equal(detectBackend("darwin", no), "none");
  assert.equal(detectBackend("linux", (b) => b === "bwrap"), "bwrap");
  assert.equal(detectBackend("linux", (b) => b === "firejail"), "firejail");
  assert.equal(detectBackend("linux", no), "none");
  assert.equal(detectBackend("win32", yes), "none");
});

test("wrapCommand is a no-op for tier=off and backend=none", () => {
  const backends: Backend[] = ["sandbox-exec", "bwrap", "firejail", "none"];
  for (const b of backends) {
    assert.equal(wrapCommand(b, "off", "echo hi", { root: "/work" }), "echo hi");
  }
  assert.equal(wrapCommand("none", "workspace-write", "echo hi", { root: "/work" }), "echo hi");
});

test("wrapCommand for sandbox-exec workspace-write embeds the root and the original", () => {
  const out = wrapCommand("sandbox-exec", "workspace-write", "echo hi", { root: "/work" });
  assert.ok(out.startsWith("/usr/bin/sandbox-exec"), "prefixed with the launcher");
  assert.match(out, /\(subpath "\/work"\)/, "the workspace root is a writable subpath");
  assert.ok(out.includes(shquote("echo hi")), "the original command is embedded via shquote");
});

test("wrapCommand escapes a single-quoted command and survives a round trip", () => {
  const original = "echo 'hi'";
  const out = wrapCommand("sandbox-exec", "workspace-write", original, { root: "/work" });
  assert.ok(out.includes("'\\''"), "the interior single quote is escaped to '\\''");
  // The embedded, shquoted command parses back to the original.
  assert.ok(out.includes(shquote(original)));
});

test("wrapCommand encodes network and write tiers per backend", () => {
  const sbNoNet = wrapCommand("sandbox-exec", "no-network", "curl x", { root: "/work" });
  assert.match(sbNoNet, /\(deny network\*\)/, "no-network denies network in the profile");

  const bwNoNet = wrapCommand("bwrap", "no-network", "curl x", { root: "/work" });
  assert.ok(bwNoNet.startsWith("bwrap"));
  assert.ok(bwNoNet.includes("--unshare-net"), "bwrap no-network unshares the net namespace");

  const bwReadonly = wrapCommand("bwrap", "readonly", "ls", { root: "/work" });
  assert.ok(
    bwReadonly.includes(`--ro-bind ${shquote("/work")} ${shquote("/work")}`),
    "readonly re-binds the root read-only so a snippet under it stays visible",
  );
  assert.ok(
    bwReadonly.indexOf("--tmpfs /tmp") < bwReadonly.indexOf(`--ro-bind ${shquote("/work")}`),
    "the read-only re-bind comes after --tmpfs /tmp so it re-exposes the shadowed dir",
  );
  assert.ok(!bwReadonly.includes("--bind /work"), "readonly omits the writable workspace bind");
  assert.ok(!bwReadonly.includes("--unshare-net"), "readonly keeps the network");

  const fjNoNet = wrapCommand("firejail", "no-network", "curl x", { root: "/work" });
  assert.ok(fjNoNet.includes("--net=none"));
  assert.ok(fjNoNet.includes(`--read-write=${shquote("/work")}`));
});

test("wrapCommand shquotes a workspace root with a space so the outer re-parse can't split it", () => {
  const root = "/Users/me/My Project";
  const bw = wrapCommand("bwrap", "workspace-write", "echo hi", { root });
  assert.ok(bw.includes(`--bind ${shquote(root)} ${shquote(root)}`), "bwrap binds the quoted root");
  assert.ok(!bw.includes("--bind /Users/me/My Project"), "the bare, splittable root must not appear");
  const fj = wrapCommand("firejail", "workspace-write", "echo hi", { root });
  assert.ok(fj.includes(`--read-write=${shquote(root)}`), "firejail read-writes the quoted root");
});

test("wrapCommand escapes a sandbox-exec root with SBPL specials", () => {
  const out = wrapCommand("sandbox-exec", "workspace-write", "echo hi", { root: '/a/b"c\\d' });
  assert.ok(
    out.includes('(subpath "/a/b\\"c\\\\d")'),
    "the backslash and double quote in the root are escaped for the SBPL string literal",
  );
  const plain = wrapCommand("sandbox-exec", "workspace-write", "echo hi", { root: "/work" });
  assert.ok(plain.includes('(subpath "/work")'), "a root without SBPL specials is byte-identical");
});

test("shquote escapes ' and embeds shell metacharacters literally", () => {
  assert.equal(shquote("echo 'hi'"), "'echo '\\''hi'\\'''");
  assert.equal(shquote("a; b $(c) && d"), "'a; b $(c) && d'");
});

test("isWrapped recognizes an already-wrapped command by launcher basename", () => {
  assert.equal(isWrapped("bwrap --ro-bind / / /bin/sh -c x"), true);
  assert.equal(isWrapped("/usr/bin/sandbox-exec -p x"), true);
  assert.equal(isWrapped("firejail --quiet x"), true);
  assert.equal(isWrapped("echo hi"), false);
  assert.equal(isWrapped("rm -rf build"), false);
});

// -- integration through the agent loop -------------------------------------

/** A shell:exec tool that records the command it received; never spawns. */
function shellTool(agent: Agent, name = "bash"): () => string | undefined {
  let seen: string | undefined;
  agent.tools.register(
    defineTool({
      name,
      description: "",
      capabilities: ["shell:exec"],
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: (args) => {
        seen = args["command"] as string;
        return { content: "ran" };
      },
    }),
  );
  return () => seen;
}

/** A non-shell tool that records its args, to prove they're never wrapped. */
function plainTool(agent: Agent, name = "note"): () => string | undefined {
  let seen: string | undefined;
  agent.tools.register(
    defineTool({
      name,
      description: "",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: (args) => {
        seen = args["text"] as string;
        return { content: "noted" };
      },
    }),
  );
  return () => seen;
}

/** Did any tool-result the model saw carry a sandbox-tiers block reason? */
function sawBlock(agent: Agent): boolean {
  return agent.messages
    .filter((m) => m.role === "tool")
    .some((m) => m.content.some((b) => b.type === "tool_result" && /sandbox-tiers: /.test(b.content)));
}

test("default tier=off is a pure pass-through: the original command runs", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }] }, { text: "done" }],
  });
  const seen = shellTool(h.agent);
  await h.host.use("sandbox-tiers", (e) => {
    e.store.set("forceBackend", "bwrap");
    return sandboxTiers(e);
  });

  await h.agent.run("greet");
  assert.equal(seen(), "echo hi", "tier=off leaves the command unchanged");
});

test("tier=workspace-write with a forced bwrap wraps the executed command", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }] }, { text: "done" }],
  });
  const seen = shellTool(h.agent);
  await h.host.use("sandbox-tiers", (e) => {
    e.store.set("forceBackend", "bwrap");
    e.store.set("tier", "workspace-write");
    return sandboxTiers(e);
  });

  await h.agent.run("greet");
  const cmd = seen();
  assert.ok(cmd !== undefined && cmd.startsWith("bwrap"), "the rewrite reached execution");
  assert.ok(cmd!.includes(shquote("echo hi")), "the original command is embedded");
});

test("EAGENT_SANDBOX_TIERS=off disables the wrap even with a tier set", async () => {
  const prev = process.env.EAGENT_SANDBOX_TIERS;
  process.env.EAGENT_SANDBOX_TIERS = "off";
  try {
    const h = makeHarness({
      fallback: "allow",
      responder: [{ toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }] }, { text: "done" }],
    });
    const seen = shellTool(h.agent);
    await h.host.use("sandbox-tiers", (e) => {
      e.store.set("forceBackend", "bwrap");
      e.store.set("tier", "workspace-write");
      return sandboxTiers(e);
    });

    await h.agent.run("greet");
    assert.equal(seen(), "echo hi", "the kill switch wins over the tier");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_SANDBOX_TIERS;
    else process.env.EAGENT_SANDBOX_TIERS = prev;
  }
});

test("missingBackend=block blocks the call with a sandbox-tiers reason", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }] }, { text: "done" }],
  });
  const seen = shellTool(h.agent);
  await h.host.use("sandbox-tiers", (e) => {
    e.store.set("forceBackend", "none");
    e.store.set("tier", "workspace-write");
    e.store.set("missingBackend", "block");
    return sandboxTiers(e);
  });

  await h.agent.run("greet");
  assert.equal(seen(), undefined, "the command never ran");
  assert.equal(sawBlock(h.agent), true, "the model sees a sandbox-tiers block reason");
});

test("missingBackend=pass fails open: the original command runs unwrapped", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }] }, { text: "done" }],
  });
  const seen = shellTool(h.agent);
  await h.host.use("sandbox-tiers", (e) => {
    e.store.set("forceBackend", "none");
    e.store.set("tier", "workspace-write");
    e.store.set("missingBackend", "pass");
    return sandboxTiers(e);
  });

  await h.agent.run("greet");
  assert.equal(seen(), "echo hi", "no backend + pass leaves the command unchanged");
  assert.equal(sawBlock(h.agent), false, "no block reason");
});

test("capability fidelity: a shell:exec tool named 'sh' is still wrapped", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "sh", arguments: { command: "echo hi" } }] }, { text: "done" }],
  });
  const seen = shellTool(h.agent, "sh");
  await h.host.use("sandbox-tiers", (e) => {
    e.store.set("forceBackend", "bwrap");
    e.store.set("tier", "workspace-write");
    return sandboxTiers(e);
  });

  await h.agent.run("greet");
  assert.ok(seen()?.startsWith("bwrap"), "matching is on the declared capability, not the name");
});

test("a non-shell tool's arguments are never touched", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "note", arguments: { text: "hello" } }] }, { text: "done" }],
  });
  const seen = plainTool(h.agent);
  await h.host.use("sandbox-tiers", (e) => {
    e.store.set("forceBackend", "bwrap");
    e.store.set("tier", "workspace-write");
    return sandboxTiers(e);
  });

  await h.agent.run("note");
  assert.equal(seen(), "hello", "a non-shell:exec tool is left alone");
});

test("idempotency: an already-bwrap'd command is not double-wrapped", async () => {
  const pre = "bwrap --ro-bind / / /bin/sh -c 'echo hi'";
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: pre } }] }, { text: "done" }],
  });
  const seen = shellTool(h.agent);
  await h.host.use("sandbox-tiers", (e) => {
    e.store.set("forceBackend", "bwrap");
    e.store.set("tier", "workspace-write");
    return sandboxTiers(e);
  });

  await h.agent.run("greet");
  const cmd = seen();
  assert.equal(cmd, pre, "the command is passed through unchanged");
  assert.equal((cmd!.match(/bwrap/g) ?? []).length, 1, "no second bwrap prefix");
});

test("/sandbox-tiers status and tier reflect the stored tier and forced backend", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("sandbox-tiers", (e) => {
    e.store.set("forceBackend", "bwrap");
    return sandboxTiers(e);
  });

  const lines: string[] = [];
  const cmd = h.commands.get("sandbox-tiers")!;
  const print = (line: string): void => {
    lines.push(line);
  };

  await cmd.run({ agent: h.agent, args: "tier no-network", print });
  await cmd.run({ agent: h.agent, args: "status", print });

  const status = lines.at(-1)!;
  assert.match(status, /tier=no-network/, "status reflects the stored tier");
  assert.match(status, /backend=bwrap/, "status reflects the forced backend");
});

test("/sandbox-tiers tier rejects an unknown name with the valid list", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("sandbox-tiers", sandboxTiers);

  const lines: string[] = [];
  await h.commands.get("sandbox-tiers")!.run({
    agent: h.agent,
    args: "tier bogus",
    print: (line) => lines.push(line),
  });
  assert.match(lines.at(-1)!, /unknown tier/);
  assert.match(lines.at(-1)!, /workspace-write/);
});

// -- real-backend confinement (gated on a detected backend) -----------------
//
// Unlike the string assertions above, these run a real command through
// wrapCommand and assert observable confinement (exit codes / file presence).
// The backend is the host's real one, so they EXECUTE on macOS (sandbox-exec)
// and Linux-with-bwrap and skip only where no backend exists. The per-call root
// is under os.tmpdir() so the readonly case exercises bwrap's `--tmpfs /tmp`
// shadowing (the path the read-only re-bind has to re-expose).

const realBackend = detectBackend(process.platform, binExists);
const noBackend = realBackend === "none";

function runWrapped(tier: Tier, command: string, root: string): { status: number | null; output: string } {
  const wrapped = wrapCommand(realBackend, tier, command, { root });
  const r = spawnSync("/bin/sh", ["-c", wrapped], { encoding: "utf8" });
  return { status: r.status, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("real backend: no-network denies a subprocess network connect", { skip: noBackend }, () => {
  const root = mkdtempSync(join(tmpdir(), "eagent-sbtest-"));
  try {
    // Target a closed loopback port: any failure exits non-zero, no real egress.
    const probe =
      `node -e "const s=require('net').connect(1,'127.0.0.1');` +
      `s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(3));` +
      `setTimeout(()=>process.exit(4),3000)"`;
    const { status } = runWrapped("no-network", probe, root);
    assert.notEqual(status, 0, "a connect under no-network must not succeed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real backend: readonly runs an in-root snippet but denies writing to root", { skip: noBackend }, () => {
  const root = mkdtempSync(join(tmpdir(), "eagent-sbtest-"));
  try {
    const snippet = join(root, "snippet.sh");
    writeFileSync(snippet, "echo SNIPPET_RAN\n", "utf8");
    const run = runWrapped("readonly", `/bin/sh ${shquote(snippet)}`, root);
    assert.equal(run.status, 0, "the in-root snippet must run under readonly (no ENOENT)");
    assert.match(run.output, /SNIPPET_RAN/);

    const target = join(root, "should-not-write");
    const write = runWrapped("readonly", `echo x > ${shquote(target)}`, root);
    assert.notEqual(write.status, 0, "writing to root must fail under readonly");
    assert.ok(!existsSync(target), "the denied write left no file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real backend: workspace-write allows an in-root write but denies an out-of-root write", { skip: noBackend }, () => {
  const root = mkdtempSync(join(tmpdir(), "eagent-sbtest-"));
  // A $HOME-based target is writable without a sandbox but outside every
  // backend's write whitelist (root + the temp dirs), so confinement must deny it.
  const outside = join(homedir(), `.eagent-sbtest-${process.pid}-${Date.now()}`);
  try {
    const inRoot = join(root, "in-root.txt");
    const inWrite = runWrapped("workspace-write", `echo ok > ${shquote(inRoot)}`, root);
    assert.equal(inWrite.status, 0, "an in-root write must succeed under workspace-write");
    assert.ok(existsSync(inRoot), "the in-root write created the file");

    const outWrite = runWrapped("workspace-write", `echo nope > ${shquote(outside)}`, root);
    assert.notEqual(outWrite.status, 0, "an out-of-root ($HOME) write must be denied");
    assert.ok(!existsSync(outside), "the denied out-of-root write left no file");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("binExists finds a standard bin and misses a bogus name", () => {
  assert.equal(binExists("sh"), true, "/bin/sh is on the standard search path");
  assert.equal(binExists("definitely-not-a-real-bin-xyz"), false);
});
