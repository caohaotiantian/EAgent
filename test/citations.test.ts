/**
 * citations — tag retrieval outputs with stable ids and validate answer [id] markers.
 *
 * The extension rides the same `afterToolCall` seam as `content-guard`: for a
 * retrieval-capability tool result it prepends a visible `[src:N]` header and
 * records `N → {tool, locator}` in a per-run map (reset on `agent_start`). On
 * `agent_end` it parses the final assistant answer's `[src:N]`/`[N]` markers and
 * warns (never blocks) on a fabricated id. All offline against the MockProvider,
 * loaded directly via `host.use("citations", activate)` — never via
 * BUILTIN_EXTENSIONS.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "../src/kernel/agent.js";
import { CapabilityManager } from "../src/kernel/capabilities.js";
import { CommandRegistry } from "../src/kernel/commands.js";
import { ExtensionHost } from "../src/kernel/extension.js";
import { MemoryBackend } from "../src/kernel/store.js";
import type { ExtensionAPI } from "../src/kernel/extension.js";
import type { Logger } from "../src/kernel/types.js";
import { defineTool, ok, fail } from "../src/kernel/define.js";
import { MockProvider } from "../src/providers/mock.js";
import { silentLogger, autoUI } from "./helpers.js";
import citations from "../src/extensions/citations.js";
import contentGuard from "../src/extensions/content-guard.js";

/**
 * A harness like `makeHarness` but with the store backend exposed, so a test can
 * set `citations`-namespaced flags (`enabled`, `warnMissing`, `retrievalCaps`)
 * directly — `enabled` is off by default (D6), so every behavior test must opt
 * in, and `warnMissing`/`retrievalCaps` have no command toggle.
 */
interface Harness {
  agent: Agent;
  host: ExtensionHost;
  commands: CommandRegistry;
  provider: MockProvider;
  store: MemoryBackend;
}

function makeHarness(opts: { logger?: Logger } = {}): Harness {
  const ui = autoUI(true);
  const logger = opts.logger ?? silentLogger;
  const capabilities = new CapabilityManager({ ui, fallback: "allow" });
  const agent = new Agent({ ui, logger, capabilities, provider: "mock", model: "mock" });
  const provider = new MockProvider();
  agent.providers.register(provider, { default: true });
  const commands = new CommandRegistry();
  const store = new MemoryBackend();
  const host = new ExtensionHost({ agent, commands, logger, store });
  return { agent, host, commands, provider, store };
}

// -- helpers -----------------------------------------------------------------

/** A tiny inline extension that registers a stub tool with given caps + result. */
function stubTool(name: string, caps: string[], result: { content: string; isError?: boolean }) {
  return (e: ExtensionAPI): void => {
    for (const c of caps) e.grantCapability(c);
    e.registerTool(
      defineTool({
        name,
        description: `stub ${name}`,
        capabilities: caps,
        parameters: { type: "object", properties: {} },
        execute: () => (result.isError ? fail(result.content) : ok(result.content)),
      }),
    );
  };
}

/** The content string of the first tool_result block the model would see. */
function firstResultContent(agent: Agent): string | undefined {
  const toolMsg = agent.messages.find((m) => m.role === "tool");
  const block = toolMsg?.content.find((b) => b.type === "tool_result");
  return block && block.type === "tool_result" ? block.content : undefined;
}

/** Every tool_result content block in transcript order. */
function allResultContents(agent: Agent): string[] {
  const out: string[] = [];
  for (const m of agent.messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") out.push(b.content);
    }
  }
  return out;
}

/** A capturing logger that records warn lines for assertion. */
function capturingLogger(): { warns: string[]; logger: Logger } {
  const warns: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      warns.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    },
    error: () => {},
  };
  return { warns, logger };
}

/** Enable the extension's run-time `enabled` flag (it is off by default, D6). */
function enable(h: Harness): void {
  // The store is namespaced per-extension id; opening "citations" gives the same
  // view the extension's `e.store` sees.
  h.store.open("citations").set("enabled", true);
}

/** Set an arbitrary citations store key (e.g. retrievalCaps, warnMissing). */
function setStore(h: Harness, key: string, value: unknown): void {
  h.store.open("citations").set(key, value);
}

/** Run a single retrieval-tool turn, then a final-answer turn. */
async function runWithStub(
  h: Harness,
  toolName: string,
  caps: string[],
  result: { content: string; isError?: boolean },
  finalText = "done",
): Promise<void> {
  h.provider.script([{ toolCalls: [{ name: toolName, arguments: {} }] }, { text: finalText }]);
  await h.host.use("stub", stubTool(toolName, caps, result));
  await h.host.use("citations", citations);
  await h.agent.run("go");
}

// -- AC1 / AC2 / AC3 : id tagging + capability gate --------------------------

test("citations: a net:fetch retrieval result gets a [src:1] header (AC1)", async () => {
  const h = makeHarness();
  enable(h);
  await runWithStub(h, "grab", ["net:fetch"], { content: "fetched body" });
  const content = firstResultContent(h.agent) ?? "";
  assert.ok(content.startsWith("[src:1] "), `retrieval output is tagged at the front; got: ${content}`);
  assert.ok(content.includes("fetched body"), "the original body survives after the header");
});

test("citations: a non-retrieval (shell:exec) result is byte-identical to raw (AC2)", async () => {
  const h = makeHarness();
  enable(h);
  await runWithStub(h, "run", ["shell:exec"], { content: "command output" });
  const content = firstResultContent(h.agent);
  assert.equal(content, "command output", "non-retrieval output is untouched (no [src: header)");
});

test("citations: the default retrieval set covers fs:read (AC3)", async () => {
  const h = makeHarness();
  enable(h);
  await runWithStub(h, "loadfile", ["fs:read"], { content: "file text" });
  const content = firstResultContent(h.agent) ?? "";
  assert.ok(content.startsWith("[src:1] "), `fs:read is a default retrieval cap; got: ${content}`);
});

// -- AC4 : monotonic ids + map records both ----------------------------------

test("citations: two retrieval results get [src:1] then [src:2] (AC4)", async () => {
  const h = makeHarness();
  enable(h);
  h.provider.script([
    { toolCalls: [{ name: "grab", arguments: {} }] },
    { toolCalls: [{ name: "grab", arguments: {} }] },
    { text: "done" },
  ]);
  await h.host.use("stub", stubTool("grab", ["net:fetch"], { content: "body" }));
  await h.host.use("citations", citations);
  await h.agent.run("go");

  const contents = allResultContents(h.agent);
  assert.equal(contents.length, 2, "two retrieval results recorded");
  assert.ok(contents[0]!.startsWith("[src:1] "), `first is [src:1]; got: ${contents[0]}`);
  assert.ok(contents[1]!.startsWith("[src:2] "), `second is [src:2]; got: ${contents[1]}`);
});

// -- AC5 : per-run reset -----------------------------------------------------

test("citations: the id map resets per run — second run starts at [src:1] again (AC5)", async () => {
  const h = makeHarness();
  enable(h);
  await h.host.use("stub", stubTool("grab", ["net:fetch"], { content: "body" }));
  await h.host.use("citations", citations);

  h.provider.script([{ toolCalls: [{ name: "grab", arguments: {} }] }, { text: "done" }]);
  await h.agent.run("go");
  h.provider.script([{ toolCalls: [{ name: "grab", arguments: {} }] }, { text: "done" }]);
  await h.agent.run("again");

  const contents = allResultContents(h.agent);
  // Two runs → two retrieval results; both must be [src:1] (per-run counter reset).
  assert.equal(contents.length, 2, "one result per run");
  assert.ok(contents[0]!.startsWith("[src:1] "), `run 1 first is [src:1]; got: ${contents[0]}`);
  assert.ok(contents[1]!.startsWith("[src:1] "), `run 2 first is [src:1] again; got: ${contents[1]}`);
});

// -- AC6 : fabricated-id warn (never blocks) ---------------------------------

test("citations: a fabricated [src:9] is warned and recorded; run still completes (AC6, D5)", async () => {
  const { warns, logger } = capturingLogger();
  const h = makeHarness({ logger });
  enable(h);
  h.provider.script([
    { toolCalls: [{ name: "grab", arguments: {} }] },
    { text: "A [src:1] but also [src:9]" },
  ]);
  await h.host.use("stub", stubTool("grab", ["net:fetch"], { content: "body" }));
  await h.host.use("citations", citations);
  await h.agent.run("go");

  // (a) a warn naming the fabricated id 9 was logged.
  assert.ok(
    warns.some((w) => w.includes("9")),
    `a fabricated-id warn naming 9 was logged; got: ${JSON.stringify(warns)}`,
  );
  // (b) the run completed normally — the final assistant answer is present.
  const last = h.agent.messages.at(-1);
  assert.ok(last && last.role === "assistant", "the run completed with an assistant message (never blocked)");
});

// -- AC7 : clean answer — no false positive ----------------------------------

test("citations: an answer citing only emitted ids yields no warn (AC7)", async () => {
  const { warns, logger } = capturingLogger();
  const h = makeHarness({ logger });
  enable(h);
  h.provider.script([{ toolCalls: [{ name: "grab", arguments: {} }] }, { text: "see [src:1]" }]);
  await h.host.use("stub", stubTool("grab", ["net:fetch"], { content: "body" }));
  await h.host.use("citations", citations);
  await h.agent.run("go");

  assert.ok(
    !warns.some((w) => w.toLowerCase().includes("fabricat")),
    `no fabricated-id warn on a clean answer; got: ${JSON.stringify(warns)}`,
  );
});

// -- AC8 : bare [N] scoping + [src:N] authoritative + [3]: excluded ----------

async function runFinalAnswer(
  h: Harness,
  finalText: string,
): Promise<void> {
  h.provider.script([{ toolCalls: [{ name: "grab", arguments: {} }] }, { text: finalText }]);
  await h.host.use("stub", stubTool("grab", ["net:fetch"], { content: "body" }));
  await h.host.use("citations", citations);
  await h.agent.run("go");
}

test("citations: bare [1] with 1 emitted is a valid citation, not flagged (AC8)", async () => {
  const { warns, logger } = capturingLogger();
  const h = makeHarness({ logger });
  enable(h);
  await runFinalAnswer(h, "per [1]");
  assert.ok(!warns.some((w) => w.toLowerCase().includes("fabricat")), `bare [1] of an emitted id is not flagged; got ${JSON.stringify(warns)}`);
});

test("citations: bare [7] with 7 unemitted is an incidental token, not flagged (AC8)", async () => {
  const { warns, logger } = capturingLogger();
  const h = makeHarness({ logger });
  enable(h);
  await runFinalAnswer(h, "per [7]");
  assert.ok(!warns.some((w) => w.toLowerCase().includes("fabricat")), `bare [7] of an unemitted id is NOT flagged; got ${JSON.stringify(warns)}`);
});

test("citations: [src:7] with 7 unemitted IS flagged (AC8)", async () => {
  const { warns, logger } = capturingLogger();
  const h = makeHarness({ logger });
  enable(h);
  await runFinalAnswer(h, "per [src:7]");
  assert.ok(warns.some((w) => w.includes("7")), `authoritative [src:7] of an unemitted id IS flagged; got ${JSON.stringify(warns)}`);
});

test("citations: a reference-style def [3]: is not counted as a citation (AC8)", async () => {
  const { warns, logger } = capturingLogger();
  const h = makeHarness({ logger });
  enable(h);
  await runFinalAnswer(h, "see [3]: http://example.com");
  assert.ok(!warns.some((w) => w.toLowerCase().includes("fabricat")), `a link def [3]: is excluded; got ${JSON.stringify(warns)}`);
});

// -- AC14 : idempotency ------------------------------------------------------

test("citations: an already-[src:-tagged content gets no second header (AC14)", async () => {
  const h = makeHarness();
  enable(h);
  // The stub's raw content already begins with [src: — the filter must skip it.
  await runWithStub(h, "grab", ["net:fetch"], { content: "[src:1] already tagged\nbody" });
  const content = firstResultContent(h.agent) ?? "";
  // Exactly one [src: header at the front.
  const first = content.indexOf("[src:");
  const second = content.indexOf("[src:", first + 1);
  // The only "[src:" must be the pre-existing one at position 0; no header was added.
  assert.equal(first, 0, "the pre-existing tag stays at the front");
  assert.equal(second, content.indexOf("[src:", 1), "no duplicate header was inserted");
  assert.ok(content.startsWith("[src:1] already tagged"), `content is unchanged; got: ${content}`);
});

// -- AC11 : EAGENT_CITATIONS=off kill switch ---------------------------------

test("citations: EAGENT_CITATIONS=off suppresses tagging (AC11)", async () => {
  const prev = process.env.EAGENT_CITATIONS;
  process.env.EAGENT_CITATIONS = "off";
  try {
    const h = makeHarness();
    enable(h);
    await runWithStub(h, "grab", ["net:fetch"], { content: "fetched body" });
    const content = firstResultContent(h.agent);
    assert.equal(content, "fetched body", "the kill switch leaves the result untagged");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_CITATIONS;
    else process.env.EAGENT_CITATIONS = prev;
  }
});

// -- AC9 : missing-attribution off by default; warnMissing flips it ----------

test("citations: missing attribution is not warned by default (AC9)", async () => {
  const { warns, logger } = capturingLogger();
  const h = makeHarness({ logger });
  enable(h);
  // ≥1 emitted id, but the answer cites nothing.
  await runFinalAnswer(h, "Here is a substantive answer with no citation at all.");
  assert.ok(
    !warns.some((w) => w.toLowerCase().includes("missing")),
    `no missing-attribution warn by default; got: ${JSON.stringify(warns)}`,
  );
});

test("citations: warnMissing=true warns on a substantive uncited answer (AC9)", async () => {
  const { warns, logger } = capturingLogger();
  const h = makeHarness({ logger });
  enable(h);
  setStore(h, "warnMissing", true);
  await runFinalAnswer(h, "Here is a substantive answer with no citation at all.");
  assert.ok(
    warns.some((w) => w.toLowerCase().includes("missing")),
    `warnMissing flips the missing-attribution warn on; got: ${JSON.stringify(warns)}`,
  );
});

// -- AC10 : /citations report shape + on/off toggle --------------------------

test("citations: /citations status reports emitted/cited/fabricated and lists 9 (AC10, AC6 report)", async () => {
  const { logger } = capturingLogger();
  const h = makeHarness({ logger });
  enable(h);
  h.provider.script([
    { toolCalls: [{ name: "grab", arguments: {} }] },
    { text: "A [src:1] but also [src:9]" },
  ]);
  await h.host.use("stub", stubTool("grab", ["net:fetch"], { content: "body" }));
  await h.host.use("citations", citations);
  await h.agent.run("go");

  const cmd = h.commands.get("citations");
  assert.ok(cmd, "the /citations command is registered");
  const lines: string[] = [];
  await cmd.run({ agent: h.agent, args: "status", print: (l) => lines.push(l) });
  const out = lines.join("\n");
  assert.match(out, /emitted/i, "status names an emitted count");
  assert.match(out, /cited/i, "status names cited ids");
  assert.match(out, /fabricat/i, "status names fabricated ids");
  assert.ok(out.includes("9"), `status lists the fabricated id 9; got: ${out}`);
});

test("citations: /citations on and off toggle the enabled flag (AC10)", async () => {
  const h = makeHarness();
  await h.host.use("citations", citations);
  const cmd = h.commands.get("citations")!;

  const onLines: string[] = [];
  await cmd.run({ agent: h.agent, args: "on", print: (l) => onLines.push(l) });
  // After `on`, a retrieval result is tagged.
  h.provider.script([{ toolCalls: [{ name: "grab", arguments: {} }] }, { text: "done" }]);
  await h.host.use("stub", stubTool("grab", ["net:fetch"], { content: "body" }));
  await h.agent.run("go");
  assert.ok((firstResultContent(h.agent) ?? "").startsWith("[src:1] "), "on → tagging active");

  const offLines: string[] = [];
  await cmd.run({ agent: h.agent, args: "off", print: (l) => offLines.push(l) });
  const status: string[] = [];
  await cmd.run({ agent: h.agent, args: "status", print: (l) => status.push(l) });
  assert.match(status.join("\n"), /off/i, "status reflects the off state");
});

// -- AC13 : composition with content-guard -----------------------------------

test("citations: header sits ahead of content-guard's fence (AC13)", async () => {
  const h = makeHarness();
  enable(h);
  h.provider.script([{ toolCalls: [{ name: "grab", arguments: {} }] }, { text: "done" }]);
  await h.host.use("stub", stubTool("grab", ["net:fetch"], { content: "fetched body" }));
  // content-guard FIRST, then citations — so the [src:N] header lands ahead of the fence.
  await h.host.use("content-guard", contentGuard);
  await h.host.use("citations", citations);
  await h.agent.run("go");

  const content = firstResultContent(h.agent) ?? "";
  assert.ok(content.includes("<untrusted-content"), "content-guard fenced the foreign result");
  assert.ok(content.includes("[src:"), "citations tagged the same result");
  // The [src: header must sit AHEAD of the fence (header outside the envelope).
  assert.equal(content.indexOf("[src:"), 0, `[src: header is at the front; got: ${content.slice(0, 40)}`);
  assert.ok(
    content.indexOf("[src:") < content.indexOf("<untrusted-content"),
    "the [src: header is ahead of the untrusted-content fence",
  );
  // content-guard idempotency: a single fence.
  assert.equal(
    content.indexOf("<untrusted-content"),
    content.lastIndexOf("<untrusted-content"),
    "exactly one fence (content-guard idempotency intact)",
  );
});

// -- AC12 : clean dispose — no leak ------------------------------------------

test("citations: after host.unload no header is added — no leak (AC12)", async () => {
  const h = makeHarness();
  enable(h);
  await h.host.use("stub", stubTool("grab", ["net:fetch"], { content: "fetched body" }));
  await h.host.use("citations", citations);
  await h.host.unload("citations");

  h.provider.script([{ toolCalls: [{ name: "grab", arguments: {} }] }, { text: "done" }]);
  await h.agent.run("go");
  const content = firstResultContent(h.agent);
  assert.equal(content, "fetched body", "after teardown the afterToolCall hook no longer tags");
});

// -- structural: clean activate/dispose with default (silent) logger ---------

test("citations: activates and tears down cleanly (structural)", async () => {
  const h = makeHarness({ logger: silentLogger });
  await h.host.use("citations", citations);
  await h.host.unload("citations");
  assert.ok(true, "no throw on activate/dispose");
});
