import assert from "node:assert/strict";
import test from "node:test";

import type { CompletionRequest, Logger, Message, ToolResultBlock } from "../src/kernel/types.js";
import { MockProvider } from "../src/providers/mock.js";
import subagents, { childRegistryFrom, readOnlyCapabilities } from "../src/extensions/subagents.js";
import { CapabilityError } from "../src/kernel/capabilities.js";
import { defineTool } from "../src/kernel/define.js";
import type { Agent } from "../src/kernel/agent.js";
import { lastText, makeHarness, RenamedProvider } from "./helpers.js";

/** A logger that captures every warn() argument list, for AC-4 assertions. */
function capturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      warnings.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    },
    error: () => {},
  };
  return { logger, warnings };
}

/** Register a shell:exec `lint` tool whose body flips a flag, so allow is observable. */
function lintTool(agent: Agent, flag: { linted: boolean }): void {
  agent.tools.register(
    defineTool({
      name: "lint",
      description: "Runs a linter (declares shell:exec).",
      capabilities: ["shell:exec"],
      parameters: { type: "object", properties: {} },
      execute: () => {
        flag.linted = true;
        return { content: "linted" };
      },
    }),
  );
}

/** The last text block of the most recent user message in a request. */
function lastUserText(req: CompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    const block = m.content.find((b) => b.type === "text");
    if (block && block.type === "text") return block.text;
  }
  return "";
}

/** Collect every tool_result block from a transcript. */
function toolResults(messages: readonly Message[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) if (b.type === "tool_result") out.push(b);
  }
  return out;
}

test("single mode: parent spawns one child and gets its answer", async () => {
  let parentSpawned = false;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      return { text: `child-answer:${lastUserText(req)}` };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          { name: "spawn_agent", arguments: { mode: "single", prompt: "do X", system: "CHILD" } },
        ],
      };
    }
    return { text: "parent-done" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  const { reason } = await agent.run("kick off");

  const results = toolResults(agent.messages);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.isError, undefined);
  assert.match(results[0]!.content, /child-answer:do X/);
  assert.equal(lastText(agent), "parent-done");
  assert.equal(reason, "end_turn");
});

test("parallel mode: result mentions all three children", async () => {
  let parentSpawned = false;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      return { text: `did:${lastUserText(req)}` };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          {
            name: "spawn_agent",
            arguments: { mode: "parallel", prompts: ["a", "b", "c"], system: "CHILD" },
          },
        ],
      };
    }
    return { text: "parent-done" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined);
  assert.match(result.content, /did:a/);
  assert.match(result.content, /did:b/);
  assert.match(result.content, /did:c/);
});

test("chain mode: second child sees the first child's result", async () => {
  let parentSpawned = false;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      // Echo the incoming prompt so the chain prefix is observable.
      return { text: `echo<${lastUserText(req)}>` };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          {
            name: "spawn_agent",
            arguments: { mode: "chain", prompts: ["one", "two"], system: "CHILD" },
          },
        ],
      };
    }
    return { text: "parent-done" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined);
  // The final (returned) answer is the second child's echo, which must contain
  // the chain prefix carrying the first child's result.
  assert.match(result.content, /Previous result:/);
  assert.match(result.content, /echo<one>/); // first child's answer, fed forward
  assert.match(result.content, /Now: two/);
});

test("validation: wrong/missing prompt shape fails cleanly", async () => {
  let phase = 0;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) return { text: "unreachable" };
    phase++;
    if (phase === 1) {
      // single without prompt
      return { toolCalls: [{ name: "spawn_agent", arguments: { mode: "single" } }] };
    }
    return { text: "parent-done" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, true);
  assert.match(result.content, /requires a non-empty string `prompt`/);
});

test("recursion guard: child tool registry omits spawn_agent", () => {
  const spawn = defineTool({
    name: "spawn_agent",
    description: "x",
    execute: () => ({ content: "" }),
  });
  const helper = defineTool({
    name: "helper",
    description: "x",
    execute: () => ({ content: "" }),
  });

  const childTools = childRegistryFrom([spawn, helper]);

  assert.equal(childTools.has("spawn_agent"), false);
  assert.equal(childTools.has("helper"), true);
});

test("recursion guard (behavioral): spawned child cannot itself spawn", async () => {
  let parentSpawned = false;
  let childTriedSpawn = false;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      // The child attempts to spawn again; the tool is absent from its
      // registry, so this resolves to an "Unknown tool" error, not recursion.
      if (!childTriedSpawn) {
        childTriedSpawn = true;
        return {
          toolCalls: [
            { name: "spawn_agent", arguments: { mode: "single", prompt: "deeper", system: "CHILD" } },
          ],
        };
      }
      return { text: "child-done" };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          { name: "spawn_agent", arguments: { mode: "single", prompt: "do X", system: "CHILD" } },
        ],
      };
    }
    return { text: "parent-done" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  // Child's own spawn attempt produced an Unknown tool error, then it finished;
  // the parent's tool result is the child's final text "child-done".
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined);
  assert.match(result.content, /child-done/);
  assert.equal(lastText(agent), "parent-done");
});

test("readOnlyCapabilities grants reads and denies mutation/egress", async () => {
  const rc = readOnlyCapabilities();
  // Read capabilities resolve (no throw).
  await rc.require("fs:read", "t");
  await rc.require("skill:read", "t");
  // Everything else is denied by fallback.
  await assert.rejects(() => rc.require("fs:write", "t"), CapabilityError);
  await assert.rejects(() => rc.require("shell:exec", "t"), CapabilityError);
  await assert.rejects(() => rc.require("net:fetch", "t"), CapabilityError);
});

/** Register an fs:write tool whose body flips a flag, so a denial is observable. */
function mutateTool(agent: Agent, flag: { wrote: boolean }): void {
  agent.tools.register(
    defineTool({
      name: "mutate",
      description: "Writes a file (declares fs:write).",
      capabilities: ["fs:write"],
      parameters: { type: "object", properties: {} },
      execute: () => {
        flag.wrote = true;
        return { content: "mutated" };
      },
    }),
  );
}

/** A provider that has the parent spawn one CHILD which calls `mutate` once. */
function spawnAndMutate(readOnly: boolean): MockProvider {
  let parentSpawned = false;
  let childActed = false;
  return new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      if (!childActed) {
        childActed = true;
        return { toolCalls: [{ name: "mutate", arguments: {} }] };
      }
      return { text: "child-done" };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          { name: "spawn_agent", arguments: { mode: "single", prompt: "explore", system: "CHILD", readOnly } },
        ],
      };
    }
    return { text: "parent-done" };
  });
}

test("a readOnly child's fs:write tool is denied at the capability boundary", async () => {
  const flag = { wrote: false };
  const provider = spawnAndMutate(true);
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  mutateTool(agent, flag);
  await host.use("subagents", subagents);

  await agent.run("kick off");

  assert.equal(flag.wrote, false, "the read-only child's fs:write was denied; the tool body never ran");
  // The parent's own capabilities are untouched: it can still write.
  await agent.capabilities.require("fs:write", "parent");
});

test("a default (non-readOnly) child shares the parent's capabilities and may mutate", async () => {
  const flag = { wrote: false };
  const provider = spawnAndMutate(false);
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  mutateTool(agent, flag);
  await host.use("subagents", subagents);

  await agent.run("kick off");

  assert.equal(flag.wrote, true, "the default child inherits the parent's allow-fallback and runs the write");
});

test("/agents command prints mode help", async () => {
  const { commands, host } = makeHarness({ fallback: "allow" });
  await host.use("subagents", subagents);

  const cmd = commands.get("agents");
  assert.ok(cmd);
  const lines: string[] = [];
  await cmd!.run({ agent: {} as never, args: "", print: (l) => lines.push(l) });

  const joined = lines.join("\n");
  assert.match(joined, /single/);
  assert.match(joined, /parallel/);
  assert.match(joined, /chain/);
});

// ---------------------------------------------------------------------------
// subagents-least-privilege — three optional, default-off passthroughs.
// ---------------------------------------------------------------------------

/**
 * A provider where the parent spawns one CHILD with the given spawn `arguments`,
 * and the CHILD calls each tool in `childToolCalls` (one per turn) before
 * finishing with `childFinal`. Used to exercise the new spawn params.
 */
function spawnWith(spawnArgs: Record<string, unknown>, childToolCalls: string[], childFinal = "child-done"): MockProvider {
  let parentSpawned = false;
  let childStep = 0;
  return new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      if (childStep < childToolCalls.length) {
        const name = childToolCalls[childStep]!;
        childStep++;
        return { toolCalls: [{ name, arguments: {} }] };
      }
      return { text: childFinal };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          { name: "spawn_agent", arguments: { mode: "single", prompt: "go", system: "CHILD", ...spawnArgs } },
        ],
      };
    }
    return { text: "parent-done" };
  });
}

// --- T1: none-supplied path unchanged (explicit AC-7 lock) ------------------

test("AC-7: a spawn supplying none of the new params behaves exactly as today", async () => {
  // A parent-allowed fs:write tool runs (child shares the parent manager) and the
  // tool result is the child's free-text answer (no JSON, no contract violation).
  const flag = { wrote: false };
  const provider = spawnAndMutate(false);
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  mutateTool(agent, flag);
  await host.use("subagents", subagents);

  await agent.run("kick off");

  assert.equal(flag.wrote, true, "the default child inherits the parent's allow-fallback and writes");
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined);
  assert.match(result.content, /child-done/);
  assert.doesNotMatch(result.content, /contract violation/);
});

// --- T2: capability allowlist denies outside / allows inside; readOnly sugar --

test("AC-1: capabilities allowlist scopes a child — granted runs, ungranted is denied", async () => {
  const linted = { linted: false };
  const wrote = { wrote: false };
  // Parent fallback:"allow" so any denial is unambiguously the child manager's.
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(spawnWith({ capabilities: ["shell:exec"] }, ["lint", "mutate"]), { default: true });
  lintTool(agent, linted);
  mutateTool(agent, wrote);
  await host.use("subagents", subagents);

  await agent.run("kick off");

  assert.equal(linted.linted, true, "shell:exec is granted to the child, so lint runs");
  assert.equal(wrote.wrote, false, "fs:write is NOT in the allowlist, so mutate is denied");
});

test("AC-2: readOnly:true is sugar for the fs:read+skill:read preset", async () => {
  const wrote = { wrote: false };
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(spawnWith({ readOnly: true }, ["mutate"]), { default: true });
  mutateTool(agent, wrote);
  await host.use("subagents", subagents);

  await agent.run("kick off");

  assert.equal(wrote.wrote, false, "a readOnly child cannot fs:write");
  // The preset itself is still byte-identical (asserted by the legacy test above);
  // here we lock the spawn-param sugar resolves to the same denial.
});

test("AC-2 precedence: capabilities wins over readOnly when both are supplied", async () => {
  // capabilities:["shell:exec"] + readOnly:true → shell:exec allowed (capabilities
  // wins), but fs:read is NOT in the explicit allowlist so a read-only preset is NOT
  // applied. Prove capabilities won: lint (shell:exec) runs, mutate (fs:write) denied.
  const linted = { linted: false };
  const wrote = { wrote: false };
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(spawnWith({ capabilities: ["shell:exec"], readOnly: true }, ["lint", "mutate"]), {
    default: true,
  });
  lintTool(agent, linted);
  mutateTool(agent, wrote);
  await host.use("subagents", subagents);

  await agent.run("kick off");

  assert.equal(linted.linted, true, "capabilities allowlist (shell:exec) wins over readOnly");
  assert.equal(wrote.wrote, false, "fs:write still denied under the explicit allowlist");
});

// --- T4: provider override hits named provider / falls back on a miss --------

test("AC-3: provider override routes the child to the named registered provider", async () => {
  let parentChildCalls = 0;
  let criticChildCalls = 0;
  let parentSpawned = false;
  const parentMock = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      parentChildCalls++;
      return { text: "parent-child" };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return { toolCalls: [{ name: "spawn_agent", arguments: { mode: "single", prompt: "go", system: "CHILD", provider: "critic" } }] };
    }
    return { text: "parent-done" };
  });
  const criticMock = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      criticChildCalls++;
      return { text: "critic-child" };
    }
    return { text: "" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(parentMock, { default: true });
  agent.providers.register(new RenamedProvider("critic", criticMock));
  await host.use("subagents", subagents);

  await agent.run("kick off");

  const result = toolResults(agent.messages)[0]!;
  assert.match(result.content, /critic-child/, "child ran on the critic provider");
  assert.equal(criticChildCalls, 1, "critic provider's stream was invoked for the child");
  assert.equal(parentChildCalls, 0, "the parent provider was NOT used for the child request");
});

test("AC-4: an unregistered provider name falls back to the parent and warns", async () => {
  const { logger, warnings } = capturingLogger();
  let parentChildCalls = 0;
  let parentSpawned = false;
  const parentMock = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      parentChildCalls++;
      return { text: "parent-child" };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return { toolCalls: [{ name: "spawn_agent", arguments: { mode: "single", prompt: "go", system: "CHILD", provider: "nope" } }] };
    }
    return { text: "parent-done" };
  });

  const { agent, host } = makeHarness({ fallback: "allow", logger });
  agent.providers.register(parentMock, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off"); // must not throw

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "no hard failure on an unknown provider name");
  assert.match(result.content, /parent-child/, "child ran on the parent provider");
  assert.equal(parentChildCalls, 1);
  assert.ok(
    warnings.some((w) => /nope/.test(w)),
    "a warning naming the unregistered provider was emitted",
  );
});

// --- T5: model override reaches the child request; parent keeps its own model -

test("model override passes the requested model to the child request only", async () => {
  let childModel: string | undefined;
  let parentModel: string | undefined;
  let parentSpawned = false;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      childModel = req.model;
      return { text: "child-done" };
    }
    parentModel = req.model;
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          { name: "spawn_agent", arguments: { mode: "single", prompt: "go", system: "CHILD", model: "child-model" } },
        ],
      };
    }
    return { text: "parent-done" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  assert.equal(childModel, "child-model", "the child request carried the overridden model");
  assert.equal(parentModel, "mock", "the parent kept the harness default model");
});

// --- T6: typed return validates; one re-prompt then fail; invalid→valid -----

const STATUS_SCHEMA = {
  type: "object" as const,
  properties: { status: { type: "string" as const }, confidence: { type: "number" as const } },
  required: ["status", "confidence"],
};

/** Spawn a typed child whose successive final texts are taken from `childTexts`. */
function spawnTyped(childTexts: string[], extra: Record<string, unknown> = {}): { provider: MockProvider; childRuns: () => number } {
  let parentSpawned = false;
  let run = 0;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      // Each fresh child run starts a new transcript; count distinct runs by the
      // presence of a single user message (the seed). The re-prompt is a fresh run.
      const text = childTexts[Math.min(run, childTexts.length - 1)]!;
      run++;
      return { text };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          {
            name: "spawn_agent",
            arguments: { mode: "single", prompt: "verify", system: "CHILD", outputSchema: STATUS_SCHEMA, ...extra },
          },
        ],
      };
    }
    return { text: "parent-done" };
  });
  return { provider, childRuns: () => run };
}

test("AC-5: outputSchema validates the child's JSON and surfaces the coerced typed object", async () => {
  // The child emits confidence as a *string* "0.9". Only the typed-return path runs
  // it through validate(), which coerces it to the number 0.9; with the feature
  // absent the free-text passes through and confidence stays a string — so this
  // strictly depends on the new behavior.
  const { provider } = spawnTyped([JSON.stringify({ status: "ok", confidence: "0.9" })]);
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "valid typed return is not an error");
  const child = toolResultDetailsChild(agent);
  assert.equal(child.status, "ok");
  assert.strictEqual(child.confidence, 0.9, "confidence is coerced to a number by validate()");
});

test("AC-6a: an invalid typed return re-prompts once then fails with contract violation", async () => {
  const { provider, childRuns } = spawnTyped(["not json at all", "still not json"]);
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  assert.equal(childRuns(), 2, "exactly two child runs: the initial + one re-prompt");
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, true);
  assert.match(result.content, /contract violation/);
});

test("AC-6b: an invalid-then-valid typed return is rescued by the single re-prompt", async () => {
  const { provider, childRuns } = spawnTyped(["prose, no json", JSON.stringify({ status: "ok", confidence: 0.5 })]);
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  assert.equal(childRuns(), 2, "the re-prompt ran exactly once");
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "the single re-prompt rescued the contract");
  const child = toolResultDetailsChild(agent);
  assert.equal(child.status, "ok");
});

test("AC-6 require: a missing required key (folded via `require`) fails the contract", async () => {
  // outputSchema has no `required`; `require` supplies it. The child omits `confidence`.
  const { provider } = spawnTyped(
    [JSON.stringify({ status: "ok" }), JSON.stringify({ status: "ok" })],
    {
      outputSchema: { type: "object", properties: { status: { type: "string" }, confidence: { type: "number" } } },
      require: ["status", "confidence"],
    },
  );
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, true);
  assert.match(result.content, /contract violation/);
});

/**
 * Read the validated child object back out of the typed spawn's tool result. The
 * transcript `tool_result` block carries only `content`/`isError` (the kernel
 * drops `details` when appending, agent.ts), and the design renders the validated
 * JSON as that `content`, so parsing it is the observable channel for the object.
 */
function toolResultDetailsChild(agent: Agent): { status?: string; confidence?: number } {
  const result = toolResults(agent.messages)[0]!;
  try {
    return JSON.parse(result.content) as { status?: string; confidence?: number };
  } catch {
    return {};
  }
}

// --- T10: kill switch makes the new params a no-op --------------------------

test("AC-9: EAGENT_SUBAGENTS_LP=off makes the new params a no-op", async () => {
  const prev = process.env.EAGENT_SUBAGENTS_LP;
  process.env.EAGENT_SUBAGENTS_LP = "off";
  try {
    const wrote = { wrote: false };
    const { agent, host } = makeHarness({ fallback: "allow" });
    agent.providers.register(spawnWith({ capabilities: ["shell:exec"] }, ["mutate"]), { default: true });
    mutateTool(agent, wrote);
    await host.use("subagents", subagents);

    await agent.run("kick off");

    // With the kill switch off, the allowlist is ignored: the child inherits the
    // parent's allow-fallback manager and the fs:write runs (no scoped denial).
    assert.equal(wrote.wrote, true, "the scoped denial does NOT occur when the kill switch is off");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_SUBAGENTS_LP;
    else process.env.EAGENT_SUBAGENTS_LP = prev;
  }
});

// --- T11: clean unload (AC-10, edit-in-place equivalent) --------------------

test("AC-10: unloading subagents is clean and removes spawn_agent", async () => {
  const { agent, host } = makeHarness({ fallback: "allow" });
  await host.use("subagents", subagents);
  assert.ok(agent.tools.get("spawn_agent"), "spawn_agent is registered after load");

  await assert.doesNotReject(() => host.unload("subagents"), "unload throws nothing");
  assert.equal(agent.tools.get("spawn_agent"), undefined, "spawn_agent is gone after unload");
});

// --- T12: /agents help documents the three new params -----------------------

test("/agents help documents the capability allowlist, provider override, and typed return", async () => {
  const { commands, host } = makeHarness({ fallback: "allow" });
  await host.use("subagents", subagents);

  const cmd = commands.get("agents");
  assert.ok(cmd);
  const lines: string[] = [];
  await cmd!.run({ agent: {} as never, args: "", print: (l) => lines.push(l) });
  const joined = lines.join("\n");

  assert.match(joined, /capabilities/i);
  assert.match(joined, /provider/i);
  assert.match(joined, /outputSchema/i);
});
