import assert from "node:assert/strict";
import test from "node:test";

import { defineTool, ok } from "../src/kernel/define.js";
import type {
  CompletionRequest,
  Provider,
  StreamEvent,
  Tool,
  ToolContext,
  ToolResult,
} from "../src/kernel/types.js";
import { MockProvider } from "../src/providers/mock.js";
import subagentJobs, { jobChildRegistry } from "../src/extensions/subagent-jobs.js";
import { makeHarness } from "./helpers.js";

/** A minimal ToolContext for driving a tool's `execute` directly. */
function fakeCtx(): ToolContext {
  return { toolCallId: "t", signal: new AbortController().signal } as unknown as ToolContext;
}

/** Read the `{ jobId }` a `launch_job` success carries in its details. */
function jobIdOf(r: ToolResult): string {
  return (r.details as { jobId: string }).jobId;
}

/**
 * A provider whose child run BLOCKS until its request is aborted, then resolves.
 * `started` flips when the stream begins (so a test can wait for the abort
 * listener to be attached); `aborted` flips when the run is actually stopped —
 * the observable that `stop()` reached the child (AC 3/6/8).
 */
class GatedProvider implements Provider {
  readonly name = "mock";
  started = false;
  aborted = false;
  async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    this.started = true;
    await new Promise<void>((res) => {
      if (req.signal.aborted) {
        this.aborted = true;
        return res();
      }
      req.signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          res();
        },
        { once: true },
      );
    });
    yield { type: "done", message: { role: "assistant", content: [] }, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// AC 1 — launch → collect round-trip (completing provider)
// ---------------------------------------------------------------------------

test("AC1: launch_job returns a jobId; collect_job returns the child's answer; status becomes collected", async () => {
  const provider = new MockProvider(() => ({ text: "the-answer" }));
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagent-jobs", subagentJobs);

  const launchJob = agent.tools.get("launch_job")!;
  const collectJob = agent.tools.get("collect_job")!;
  const jobStatus = agent.tools.get("job_status")!;

  const launched = await launchJob.execute({ prompt: "do X" }, fakeCtx());
  assert.equal(launched.isError, undefined);
  const jobId = jobIdOf(launched);
  assert.ok(jobId, "launch returned a jobId");

  const collected = await collectJob.execute({ jobId }, fakeCtx());
  assert.equal(collected.isError, undefined);
  assert.equal(collected.content, "the-answer");

  const status = await jobStatus.execute({ jobId }, fakeCtx());
  assert.equal((status.details as { status: string }).status, "collected");
});

// A provider whose child run REJECTS with a genuine non-abort error. It must
// throw AFTER emitting an event (post-commit): a pre-first-event throw is
// absorbed by the agent's onProviderError retry seam and the run resolves, but a
// post-commit throw propagates and `child.run()` rejects — exercising the settler
// `.catch` and collect_job's failed branch.
class FailingProvider implements Provider {
  readonly name = "mock";
  async *stream(_req: CompletionRequest): AsyncGenerator<StreamEvent> {
    yield { type: "text_delta", text: "partial" };
    throw new Error("boom");
  }
}

test("collect_job reports a genuinely-failed child as a failure result (never throws)", async () => {
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(new FailingProvider(), { default: true });
  await host.use("subagent-jobs", subagentJobs);

  const launchJob = agent.tools.get("launch_job")!;
  const collectJob = agent.tools.get("collect_job")!;
  const jobStatus = agent.tools.get("job_status")!;

  const jobId = jobIdOf(await launchJob.execute({ prompt: "will fail" }, fakeCtx()));

  // collect_job must RETURN a fail result via the status branch, not re-throw
  // the child's rejection out of execute().
  const collected = await collectJob.execute({ jobId }, fakeCtx());
  assert.equal(collected.isError, true);
  assert.match(collected.content, /failed/);

  const status = await jobStatus.execute({ jobId }, fakeCtx());
  assert.equal((status.details as { status: string }).status, "failed");
});

// ---------------------------------------------------------------------------
// AC 2 — inspect without blocking
// ---------------------------------------------------------------------------

test("AC2: job_status returns immediately after launch and lists all jobs", async () => {
  const provider = new MockProvider(() => ({ text: "done" }));
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagent-jobs", subagentJobs);

  const launchJob = agent.tools.get("launch_job")!;
  const jobStatus = agent.tools.get("job_status")!;

  const jobId = jobIdOf(await launchJob.execute({ prompt: "go" }, fakeCtx()));

  // Does not hang: resolves synchronously-ish with a status.
  const one = await jobStatus.execute({ jobId }, fakeCtx());
  assert.ok(["running", "done", "collected"].includes((one.details as { status: string }).status));

  const list = await jobStatus.execute({}, fakeCtx());
  const jobs = (list.details as { jobs: { id: string }[] }).jobs;
  assert.equal(jobs.some((j) => j.id === jobId), true, "the job appears in the list");
});

// ---------------------------------------------------------------------------
// AC 3 — cancel (gated provider)
// ---------------------------------------------------------------------------

test("AC3: cancel_job marks a running job cancelled; collect reports it; unknown errors; re-cancel is a no-op", async () => {
  const gated = new GatedProvider();
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(gated, { default: true });
  await host.use("subagent-jobs", subagentJobs);

  const launchJob = agent.tools.get("launch_job")!;
  const cancelJob = agent.tools.get("cancel_job")!;
  const collectJob = agent.tools.get("collect_job")!;
  const jobStatus = agent.tools.get("job_status")!;

  const jobId = jobIdOf(await launchJob.execute({ prompt: "long" }, fakeCtx()));

  const cancelled = await cancelJob.execute({ jobId }, fakeCtx());
  assert.equal(cancelled.isError, undefined);
  assert.match(cancelled.content, /cancelled/);

  const status = await jobStatus.execute({ jobId }, fakeCtx());
  assert.equal((status.details as { status: string }).status, "cancelled");

  const collected = await collectJob.execute({ jobId }, fakeCtx());
  assert.equal(collected.isError, undefined);
  assert.match(collected.content, /cancelled/, "collect reports the cancellation, not a child answer");

  const unknown = await cancelJob.execute({ jobId: "nope" }, fakeCtx());
  assert.equal(unknown.isError, true);

  const again = await cancelJob.execute({ jobId }, fakeCtx());
  assert.equal(again.isError, undefined, "a second cancel does not throw");
  assert.match(again.content, /already/);
});

// ---------------------------------------------------------------------------
// AC 4 — recursion guard (runtime): refused inside a sub-agent, allowed at root
// ---------------------------------------------------------------------------

test("AC4: launch_job is refused from inside a sub-agent run but succeeds from the root", async () => {
  let childStep = 0;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("PROBE-CHILD")) {
      if (childStep === 0) {
        childStep++;
        return { toolCalls: [{ name: "probe", arguments: {} }] };
      }
      return { text: "child-final" };
    }
    return { text: "unused" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagent-jobs", subagentJobs);

  const launchJob = agent.tools.get("launch_job")!;
  const collectJob = agent.tools.get("collect_job")!;
  const jobStatus = agent.tools.get("job_status")!;

  // A cap-free probe on the ROOT (survives the SPAWN_CAPS strip into the child)
  // that calls launch_job from within the child's acting-agent context.
  let nested: ToolResult | undefined;
  agent.tools.register(
    defineTool({
      name: "probe",
      description: "invokes launch_job from the child context",
      execute: async (_a, ctx) => {
        nested = await launchJob.execute({ prompt: "nested-task" }, ctx);
        return ok("probed");
      },
    }),
  );

  // Root launch succeeds (acting agent is undefined at the root).
  const launched = await launchJob.execute({ prompt: "go", system: "PROBE-CHILD" }, fakeCtx());
  assert.equal(launched.isError, undefined, "root launch succeeds");
  const rootId = jobIdOf(launched);

  // Drain the background child (it calls the probe → nested launch_job).
  await collectJob.execute({ jobId: rootId }, fakeCtx());

  assert.ok(nested, "the child invoked the probe");
  assert.equal(nested!.isError, true, "the nested launch_job was refused");
  assert.match(nested!.content, /sub-agent/, "refusal names the sub-agent recursion guard");

  // No nested job was created: exactly the one root job exists.
  const list = await jobStatus.execute({}, fakeCtx());
  assert.equal((list.details as { jobs: unknown[] }).jobs.length, 1, "no extra job from the refused nested launch");
});

// ---------------------------------------------------------------------------
// AC 5 — recursion guard (registry): SPAWN_CAPS strip is a pure function
// ---------------------------------------------------------------------------

test("AC5: jobChildRegistry excludes SPAWN_CAPS tools and keeps plain tools", () => {
  const spawnStub: Tool = defineTool({
    name: "spawn_stub",
    description: "x",
    capabilities: ["agent:spawn"],
    execute: () => ok(""),
  });
  const plainTool: Tool = defineTool({
    name: "plain",
    description: "x",
    execute: () => ok(""),
  });

  const reg = jobChildRegistry([spawnStub, plainTool]);
  assert.equal(reg.has("spawn_stub"), false, "an agent:spawn tool is stripped");
  assert.equal(reg.has("plain"), true, "a plain tool survives");
});

// ---------------------------------------------------------------------------
// AC 6 — concurrency + retention caps
// ---------------------------------------------------------------------------

test("AC6a: maxConcurrent=1 refuses a second launch while one job runs", async () => {
  const gated = new GatedProvider();
  const { agent, host, config } = makeHarness({ fallback: "allow" });
  config.set("subagentJobs.maxConcurrent", 1);
  agent.providers.register(gated, { default: true });
  await host.use("subagent-jobs", subagentJobs);

  const launchJob = agent.tools.get("launch_job")!;
  const cancelJob = agent.tools.get("cancel_job")!;

  const first = await launchJob.execute({ prompt: "one" }, fakeCtx());
  assert.equal(first.isError, undefined);

  const second = await launchJob.execute({ prompt: "two" }, fakeCtx());
  assert.equal(second.isError, true);
  assert.match(second.content, /capacity/i);

  // Release the running job so nothing lingers.
  await cancelJob.execute({ jobId: jobIdOf(first) }, fakeCtx());
});

test("AC6b: retain=2 keeps exactly two finished records, dropping the oldest", async () => {
  const provider = new MockProvider(() => ({ text: "answer" }));
  const { agent, host, config } = makeHarness({ fallback: "allow" });
  config.set("subagentJobs.retain", 2);
  agent.providers.register(provider, { default: true });
  await host.use("subagent-jobs", subagentJobs);

  const launchJob = agent.tools.get("launch_job")!;
  const collectJob = agent.tools.get("collect_job")!;
  const jobStatus = agent.tools.get("job_status")!;

  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = jobIdOf(await launchJob.execute({ prompt: `t${i}` }, fakeCtx()));
    ids.push(id);
    await collectJob.execute({ jobId: id }, fakeCtx());
  }

  const list = await jobStatus.execute({}, fakeCtx());
  const jobs = (list.details as { jobs: { id: string }[] }).jobs;
  assert.equal(jobs.length, 2, "retain=2 keeps exactly two finished records");
  assert.equal(jobs.some((j) => j.id === ids[0]), false, "the oldest finished record was evicted");
});

// ---------------------------------------------------------------------------
// AC 7 — kill switch
// ---------------------------------------------------------------------------

test("AC7: EAGENT_SUBAGENT_JOBS=off disables launch_job and /jobs", async () => {
  const prev = process.env.EAGENT_SUBAGENT_JOBS;
  process.env.EAGENT_SUBAGENT_JOBS = "off";
  try {
    const provider = new MockProvider(() => ({ text: "x" }));
    const { agent, host, commands } = makeHarness({ fallback: "allow" });
    agent.providers.register(provider, { default: true });
    await host.use("subagent-jobs", subagentJobs);

    const launchJob = agent.tools.get("launch_job")!;
    const launched = await launchJob.execute({ prompt: "x" }, fakeCtx());
    assert.equal(launched.isError, true);
    assert.match(launched.content, /disabled/i);
    assert.equal((launched.details as { jobId?: string } | undefined)?.jobId, undefined, "no job created");

    const cmd = commands.get("jobs")!;
    const lines: string[] = [];
    await cmd.run({ agent: {} as never, args: "", print: (l) => lines.push(l) });
    assert.match(lines.join("\n"), /disabled/i);
  } finally {
    if (prev === undefined) delete process.env.EAGENT_SUBAGENT_JOBS;
    else process.env.EAGENT_SUBAGENT_JOBS = prev;
  }
});

// ---------------------------------------------------------------------------
// AC 8 — dispose cancels running jobs
// ---------------------------------------------------------------------------

test("AC8: unloading the extension cancels the running child (never throws)", async () => {
  const gated = new GatedProvider();
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(gated, { default: true });
  await host.use("subagent-jobs", subagentJobs);

  const launchJob = agent.tools.get("launch_job")!;
  await launchJob.execute({ prompt: "run forever" }, fakeCtx());

  // Wait for the child's stream to begin so its abort listener is attached.
  while (!gated.started) await tick();

  await assert.doesNotReject(host.unload("subagent-jobs"));
  assert.equal(gated.aborted, true, "dispose stopped the running child");
});
