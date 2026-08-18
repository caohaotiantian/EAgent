/**
 * The workspace the CLI hands to the built-in tools.
 *
 * `openWorkspace` decides three things at once: where the journal lives, what the tool
 * jail's root is, and which capabilities are granted. For a long time it decided them
 * so that the second contained the first — the model's own `fs.write` could reach the
 * only authoritative durable state there is. These tests are about that seam, and they
 * live next to `cli/cli.test.ts` rather than inside it because they are one claim, made
 * end to end through the real `main()`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs, readModels } from "../src/cli.ts";
import type { RunId } from "../src/ids.ts";

function emptyDir(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-jail-cli-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A graph whose only node writes wherever the caller says. */
function graphWriting(path: string): Record<string, unknown> {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "clobber", project: "demo", version: 1 },
    policy: { posture: "out", capabilities: ["fs:read", "fs:write"] },
    channels: { seed: { type: "string", reduce: "replace" }, written: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["written"],
    nodes: [
      {
        id: "write",
        type: "tool",
        reads: ["seed"],
        writes: ["written"],
        tool: { name: "fs.write", version: "1.0", args: { path, body: "clobbered" } },
        unhandled: true,
      },
    ],
    edges: [],
  };
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: errOut.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

test("A FAILED RUN PRINTS ITS ERROR — the one door people use said only \"failed\"", async () => {
  // Every refusal written so carefully in `cli.ts` — `RoutingAdapter.#resolve`'s "no route for
  // model X; routed: …" above all — reached nobody, because `loom run` printed
  // `{runId, status, outputs, usage}` and stopped there. Diagnosing a provider failure meant
  // opening the SQLite journal by hand, which is what it took to find a 401 during a smoke
  // test of this very build.
  const d = emptyDir();
  try {
    const g = join(d.dir, "g.json");
    writeFileSync(
      g,
      JSON.stringify({
        apiVersion: "loom.dev/v1",
        kind: "GraphSpec",
        metadata: { name: "s", project: "p", version: 1 },
        policy: {
          posture: "out",
          budget: { costUsd: 1, tokens: 100, wallMs: 5000 },
          expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 },
          capabilities: [],
        },
        channels: { a: { type: "object", reduce: "replace" }, r: { type: "object", reduce: "replace" } },
        inputs: ["a"],
        outputs: ["r"],
        nodes: [
          {
            id: "d",
            type: "subgraph",
            reads: ["a"],
            writes: ["r"],
            subgraph: { ref: "subgraph/child@stable", inputs: { x: "a" }, outputs: { r: "x" } },
          },
        ],
        edges: [],
      }),
    );
    const r = await run(["run", g, "--workspace", d.dir, "--input", '{"a":{}}']);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { status: string; error?: { code?: string } };
    assert.equal(body.status, "failed");
    assert.ok(body.error !== undefined, "the error reaches stdout, not only the journal");
    assert.equal(body.error?.code, "E_RESOURCE_NOT_FOUND");
  } finally {
    d.dispose();
  }
});

test("A RUN CANNOT WRITE THE NEXT RUN'S SYSTEM PROMPT — resources/ is denied like the journal", async () => {
  // THE SHARPEST EDGE A22 ADDED. `resources/prompt/*.md` becomes the SYSTEM message of the
  // next run of a node, `resources/` sits inside the jail root, and `fs:write` is granted
  // unconditionally — so before the deny entry a `tool` node writing `resources/prompt/p.md`
  // reported SUCCESS, and a fresh `openWorkspace` on that root then served its text as an
  // instruction. Durable prompt injection, reproduced through the built binary.
  //
  // The symlink refusal in `readResources` is the half that got noticed: it stops a run
  // READING a file outside `resources/`. This is the half that matters more — a run WRITING
  // what the operator is understood to have said.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    mkdirSync(join(d.dir, "resources", "prompt"), { recursive: true });
    writeFileSync(join(d.dir, "resources", "prompt", "p.md"), "Be helpful.");

    const graphFile = join(d.dir, "graphs", "inject.json");
    writeFileSync(graphFile, JSON.stringify(graphWriting("resources/prompt/p.md")));

    const first = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ seed: "x" })]);
    const parsed = JSON.parse(first.out) as { status: string };
    assert.equal(parsed.status, "failed", `the write must not succeed: ${first.out}`);

    assert.equal(
      readFileSync(join(d.dir, "resources", "prompt", "p.md"), "utf8"),
      "Be helpful.",
      "the operator's instruction is what the next run is told, not the last run's output",
    );
  } finally {
    d.dispose();
  }
});

test("…AND NOT UNDER A DIFFERENT SPELLING, on a filesystem that does not care about case", async () => {
  // THE DENY-LIST WAS ADVISORY UNTIL THE DIRECTORY EXISTED. `assertWithin` canonicalises a
  // deny entry with `realpathSync.native` exactly to defeat this — and `realpath` can only
  // canonicalise a path that is there. On a fresh workspace `resources/` was not, so the
  // comparison was lexical and `RESOURCES/` walked past it. Measured: the write succeeded, the
  // directory it created WAS `resources/` for the next boot, and the run after that was handed
  // "PWNED via case" as its system prompt.
  //
  // The fixture here deliberately does NOT pre-create `resources/`, because the sibling test
  // above does — and that is the only reason the sibling passed while this hole was open.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const graphFile = join(d.dir, "graphs", "case.json");
    writeFileSync(graphFile, JSON.stringify(graphWriting("RESOURCES/prompt/p.md")));

    const r = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ seed: "x" })]);
    assert.equal((JSON.parse(r.out) as { status: string }).status, "failed", `the write must not succeed: ${r.out}`);
    assert.equal(existsSync(join(d.dir, "RESOURCES", "prompt", "p.md")), false, "and nothing was planted");
  } finally {
    d.dispose();
  }
});

test("A RUN CANNOT WRITE TO ITS OWN JOURNAL — the data dir is inside the jail root", async () => {
  // `--workspace` is both the fs jail and the parent of `.loom/journal.db`, and
  // `fs.write` is `reversible_write`, so no gate stands between a model and the run's
  // own source of truth. Before the deny-list this run reported success and the journal
  // was destroyed: a second process opening it answered
  // `ERR_SQLITE_ERROR: database disk image is malformed`.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const graphFile = join(d.dir, "graphs", "clobber.json");
    writeFileSync(graphFile, JSON.stringify(graphWriting(".loom/journal.db")));

    const first = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ seed: "x" })]);
    const parsed = JSON.parse(first.out) as { status: string; runId: string; error?: { code?: string } };
    assert.equal(parsed.status, "failed", `the write must not succeed: ${first.out}`);

    // The journal is intact, which is the claim that actually matters: a second process
    // reads the run back, including the failure that was just recorded.
    const header = readFileSync(join(d.dir, ".loom", "journal.db")).subarray(0, 15).toString("utf8");
    assert.equal(header, "SQLite format 3", "the journal file is still a database");

    const ws = openWorkspace(parseArgs(["gates", "--workspace", d.dir]));
    try {
      const p = await ws.engine.projection(parsed.runId as RunId);
      assert.equal(p?.status, "failed");
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});

test("`--data-dir` moves the denial with it, wherever the operator puts the journal", async () => {
  // The deny-list is derived from the data dir that was actually chosen, so pointing
  // `--data-dir` at a directory INSIDE the workspace is safe rather than a foot-gun.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const graphFile = join(d.dir, "graphs", "clobber.json");
    writeFileSync(graphFile, JSON.stringify(graphWriting("state/journal.db")));

    const r = await run([
      "run",
      graphFile,
      "--workspace",
      d.dir,
      "--data-dir",
      join(d.dir, "state"),
      "--input",
      JSON.stringify({ seed: "x" }),
    ]);
    const parsed = JSON.parse(r.out) as { status: string };
    assert.equal(parsed.status, "failed", r.out);
    const header = readFileSync(join(d.dir, "state", "journal.db")).subarray(0, 15).toString("utf8");
    assert.equal(header, "SQLite format 3");
  } finally {
    d.dispose();
  }
});

test("the journal cannot be READ back out through the tools either", async () => {
  // The other direction of the same hole: `fs.read` of the journal returns whatever was
  // ever journaled — including a secret that arrived as a run input — into a channel and
  // into the model's context, past every redaction the event path applies.
  const d = emptyDir();
  try {
    const ws = openWorkspace(parseArgs(["gates", "--workspace", d.dir]));
    try {
      const read = ws.engine.tools.list().find((t) => t.name === "fs.read")!;
      await assert.rejects(
        async () =>
          read.execute(
            { path: ".loom/journal.db", maxBytes: 100_000_000 },
            { taskId: "t@root#0" as never, signal: new AbortController().signal, progress: () => {} },
          ),
        (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
      );
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});

test("a symlink planted in the workspace does not reopen either hole", async () => {
  // The precondition for the symlink escape is a pre-existing link in the workspace —
  // and the workspace defaults to the process's cwd, i.e. a directory whose contents
  // nobody audited. `link -> .loom` defeats a deny-list that resolves lexically.
  const d = emptyDir();
  const outside = mkdtempSync(join(tmpdir(), "loom-outside-"));
  try {
    const ws = openWorkspace(parseArgs(["gates", "--workspace", d.dir]));
    try {
      symlinkSync(join(d.dir, ".loom"), join(d.dir, "link"));
      symlinkSync(outside, join(d.dir, "out"));
      writeFileSync(join(outside, "secret.txt"), "not yours");

      const tools = ws.engine.tools;
      const call = (name: string, args: Record<string, unknown>): Promise<unknown> =>
        tools.list().find((t) => t.name === name)!.execute(args, {
          taskId: "t@root#0" as never,
          signal: new AbortController().signal,
          progress: () => {},
        }) as Promise<unknown>;

      await assert.rejects(async () => call("fs.write", { path: "link/journal.db", body: "x" }), /which this sandbox denies/);
      await assert.rejects(async () => call("fs.read", { path: "out/secret.txt" }), /escapes the sandbox root/);
      await assert.rejects(async () => call("fs.write", { path: "out/planted.txt", body: "x" }), /escapes the sandbox root/);
      assert.equal(existsSync(join(outside, "planted.txt")), false);
    } finally {
      ws.close();
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
    d.dispose();
  }
});

// ── --models-file: the binary can call a real provider ───────────────────────

/**
 * These tests are OFFLINE and hold no key. `readModels` constructs adapters and returns a
 * router; nothing here calls `stream`, so no socket is opened and no credential is needed
 * beyond the fake one injected through `env`. `env` is a parameter for exactly this reason:
 * mutating `process.env` inside a test is a global side effect, and a credential is the
 * last input that should be set that way.
 */
const FAKE_ENV = { ANTHROPIC_API_KEY: "sk-ant-not-a-real-key", OPENAI_API_KEY: "sk-not-a-real-key" };

function modelsFile(dir: string, doc: unknown): string {
  const p = join(dir, "models.json");
  writeFileSync(p, JSON.stringify(doc));
  return p;
}

const ONE_ANTHROPIC = {
  adapters: [{ provider: "anthropic" }],
  routes: { "agent_profile/summarizer@stable": { adapter: "anthropic", model: "claude-sonnet-5" } },
};

test("A ROUTED REQUEST REACHES THE PROVIDER AS A REAL MODEL ID — not as the graph's ResourceRef", async () => {
  // The point of the whole flag, asserted on the BYTES rather than on a proxy for them.
  // `engine.ts`'s `#runAgent` puts `agent.profile` into `ModelRequest.model`, so without the route
  // table a real adapter puts `agent_profile/summarizer@stable` into `body.model` and the
  // provider rejects it as an unknown model. `fetch` is injected, so nothing leaves the process
  // and the fake key is never presented to anyone.
  const d = emptyDir();
  try {
    const sent: { url?: string; body?: { model?: unknown } } = {};
    const cfg = readModels(modelsFile(d.dir, ONE_ANTHROPIC), FAKE_ENV, async (url, init) => {
      sent.url = url;
      sent.body = JSON.parse(String(init.body)) as { model?: unknown };
      // A 400 is NOT retryable, so this returns exactly one request to assert about
      // rather than three identical ones separated by real sleeps.
      return new Response("stop here", { status: 400 });
    });
    assert.deepEqual(cfg.adapters, ["anthropic"]);

    const req = {
      model: "agent_profile/summarizer@stable",
      system: "s",
      messages: [{ role: "user" as const, content: "hello" }],
      tools: [],
      maxTokens: 1000,
    };
    await assert.rejects(async () => {
      for await (const _ of cfg.adapter.stream(req, new AbortController().signal)) void _;
    });

    assert.equal(sent.body?.model, "claude-sonnet-5", "the ResourceRef was rewritten to the routed model id");
    assert.equal(sent.url, "https://api.anthropic.com/v1/messages");

    // `estimateOf` routes on the same table, which is the quieter half: an adapter prices
    // by `req.model`, and every adapter in this repo prices an UNKNOWN model at 0 — so an
    // unrouted request reserves nothing and the budget silently stops bounding the run.
    assert.equal(cfg.adapter.estimateOf(req) > 0, true, "a routed request reserves a real cost");
  } finally {
    d.dispose();
  }
});

test("AN UNROUTED model id is refused LOCALLY, naming the file — never as a provider's 400", async () => {
  const d = emptyDir();
  try {
    const cfg = readModels(modelsFile(d.dir, ONE_ANTHROPIC), FAKE_ENV);
    // "mock" is what a RUBRIC EVALUATOR sends (`#runEvaluator` calls `#runAgent` with no `agent`)
    // and "compaction" is what the context summariser sends (`#summarizeEffect`, read from
    // source rather than run — reaching it needs a context large enough to compact). Neither is a
    // model id, and neither is routed by the file above.
    for (const model of ["mock", "compaction", "agent_profile/other@stable"]) {
      assert.throws(
        () => cfg.adapter.estimateOf({ model, system: "", messages: [], tools: [] }),
        (e: unknown) =>
          (e as { code: string }).code === "E_CONFIG_INVALID" &&
          new RegExp(`no route for model "${model}"`).test((e as Error).message) &&
          /models\.json/.test((e as Error).message),
        model,
      );
    }
  } finally {
    d.dispose();
  }
});

test("the API key is read from the ENVIRONMENT, and an unset one refuses to start", async () => {
  const d = emptyDir();
  try {
    const file = modelsFile(d.dir, ONE_ANTHROPIC);
    assert.throws(
      () => readModels(file, {}),
      (e: unknown) => (e as { code: string }).code === "E_CONFIG_INVALID" && /ANTHROPIC_API_KEY.*not set/s.test((e as Error).message),
      "an adapter that fails on its first call instead is a failure an hour later, in a run's error field",
    );
    assert.throws(() => readModels(file, { ANTHROPIC_API_KEY: "" }), /is empty/);

    // A named variable, so one process can hold two keys for one provider.
    const named = modelsFile(d.dir, {
      adapters: [{ provider: "anthropic", apiKeyEnv: "TEAM_B_KEY" }],
      routes: ONE_ANTHROPIC.routes,
    });
    assert.equal(readModels(named, { TEAM_B_KEY: "sk-ant-team-b" }).adapters.length, 1);
  } finally {
    d.dispose();
  }
});

test("a LOCAL OpenAI-compatible endpoint needs no key — the adapter's own rule, not a second one", async () => {
  const d = emptyDir();
  try {
    const file = modelsFile(d.dir, {
      adapters: [{ name: "ollama", provider: "openai", baseUrl: "http://127.0.0.1:11434/v1" }],
      routes: { "agent_profile/summarizer@stable": { adapter: "ollama", model: "llama3" } },
    });
    assert.deepEqual(readModels(file, {}).adapters, ["ollama"]);

    // ...and the carve-out is exactly as wide as the adapter's: no baseUrl, no exemption.
    const noBase = modelsFile(d.dir, {
      adapters: [{ provider: "openai" }],
      routes: { "agent_profile/summarizer@stable": { adapter: "openai", model: "gpt-5" } },
    });
    assert.throws(() => readModels(noBase, {}), /OPENAI_API_KEY/);
  } finally {
    d.dispose();
  }
});

test("every malformed models file is a refusal to start, and each refusal names what is wrong", async () => {
  const d = emptyDir();
  try {
    const cases: readonly [unknown, RegExp][] = [
      [{}, /at least one adapter/],
      [{ adapters: [] }, /at least one adapter/],
      [{ adapters: [{ provider: "antropic" }], routes: {} }, /"antropic".*one of: anthropic, openai/s],
      [{ adapters: [{ provider: "anthropic" }, { provider: "anthropic" }], routes: {} }, /repeats the adapter name/],
      [{ adapters: [{ provider: "anthropic" }] }, /"routes" must be an object/],
      [{ adapters: [{ provider: "anthropic" }], routes: {} }, /"routes" is empty/],
      [{ adapters: [{ provider: "anthropic" }], routes: { k: { adapter: "nope", model: "m" } } }, /not declared. Declared: anthropic/],
      [{ adapters: [{ provider: "anthropic" }], routes: { k: { adapter: "anthropic" } } }, /"model" must be a non-empty string/],
      [
        { adapters: [{ provider: "anthropic", prices: { m: { input: -1, output: 1 } } }], routes: {} },
        /non-negative finite number/,
      ],
    ];
    for (const [doc, expected] of cases) {
      assert.throws(
        () => readModels(modelsFile(d.dir, doc), FAKE_ENV),
        (e: unknown) => (e as { code: string }).code === "E_CONFIG_INVALID" && expected.test((e as Error).message),
        JSON.stringify(doc),
      );
    }
    writeFileSync(join(d.dir, "models.json"), "{ not json");
    assert.throws(() => readModels(join(d.dir, "models.json"), FAKE_ENV), /E_CONFIG_INVALID|JSON/);
  } finally {
    d.dispose();
  }
});

test("THE FILE REPLACES THE MOCK — `openWorkspace` registers the router and nothing else", async () => {
  // The wiring, not a copy of it: the assertion is against the registry the real
  // `openWorkspace` built, because a test that rebuilt these options by hand would be
  // testing its own copy — the argument `controlPlaneOptions` already makes.
  const d = emptyDir();
  try {
    const file = modelsFile(d.dir, ONE_ANTHROPIC);
    const ws = openWorkspace(parseArgs(["gates", "--workspace", d.dir, "--models-file", file]), FAKE_ENV);
    try {
      assert.equal(ws.models?.adapters.join(), "anthropic");
      assert.equal(ws.engine.models.require().provider, "routed", "the default adapter is the router, not the mock");
      assert.equal(ws.engine.models.get("mock"), undefined, "the mock is not registered alongside it");
    } finally {
      ws.close();
    }

    const plain = openWorkspace(parseArgs(["gates", "--workspace", d.dir]), FAKE_ENV);
    try {
      assert.equal(plain.models, undefined);
      assert.equal(plain.engine.models.require().provider, "mock", "with no file, the mock is still the default");
    } finally {
      plain.close();
    }
  } finally {
    d.dispose();
  }
});

test("a broken models file refuses BEFORE the journal is created", async () => {
  // The same ordering `readChannels` gets, for the same reason: a refusal that has already
  // made a directory and opened a SQLite handle is a refusal that leaks one.
  const d = emptyDir();
  try {
    const file = modelsFile(d.dir, { adapters: [{ provider: "anthropic" }], routes: {} });
    assert.throws(() => openWorkspace(parseArgs(["gates", "--workspace", join(d.dir, "fresh"), "--models-file", file]), FAKE_ENV));
    assert.equal(existsSync(join(d.dir, "fresh", ".loom", "journal.db")), false, "no journal was opened");
  } finally {
    d.dispose();
  }
});

/**
 * The whole path, end to end, offline: a graph with an `agent` node, run through the
 * workspace the CLI builds, answered by a real `AnthropicAdapter` whose `fetch` is injected.
 *
 * Every other `--models-file` test in this file calls `cfg.adapter.stream` directly, which
 * proves the adapter and the route table and stops there. What was never covered is the
 * segment between them — `openWorkspace` registering the router into the engine, `#runAgent`
 * putting `agent.profile` into `ModelRequest.model`, and the answer coming back out as a
 * committed channel value. That segment is the reason `--models-file` exists at all: before
 * it, this binary could not call a model, and an agent node answered `[mock] …`.
 *
 * `fetchImpl` is threaded through `openWorkspace` for this test, on the same argument that
 * makes `env` a parameter: the alternative is a test that reaches the network, and the
 * offline rule means the alternative is no test.
 */
test("A GRAPH'S AGENT NODE IS ANSWERED BY A REAL ADAPTER — the segment between the route table and the channel", async () => {
  const d = emptyDir();
  try {
    const file = modelsFile(d.dir, {
      adapters: [{ provider: "anthropic" }],
      routes: { "agent_profile/summarizer@stable": { adapter: "anthropic", model: "claude-sonnet-5" } },
    });

    // THE PROMPT, AS A FILE. `prompt/act@stable` is a POINTER, and for the whole project the
    // model was sent those sixteen characters. A workspace publishes the document beside the
    // graph, and this test is where that lands in a real `ModelRequest`.
    mkdirSync(join(d.dir, "resources", "prompt"), { recursive: true });
    writeFileSync(join(d.dir, "resources", "prompt", "act.md"), "Summarise the seed and answer with a verdict.");

    const sent: { model?: unknown; system?: unknown; body?: string } = {};
    // One non-streaming SSE body, shaped the way the adapter parses it. Nothing leaves the
    // process and the fake key is never presented to anyone.
    const body = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 0 } } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: '{"verdict":"ok"}' } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");

    const ws = openWorkspace(parseArgs(["run", "--workspace", d.dir, "--models-file", file]), FAKE_ENV, async (_url, init) => {
      const parsed = JSON.parse(String(init.body)) as { model?: unknown; system?: unknown };
      sent.model = parsed.model;
      sent.system = parsed.system;
      // THE WHOLE REQUEST, because asserting on `system` alone proves only half. Re-adding
      // `prompt: <ref>` to the user message — the other half of the original bug — left all
      // thirteen tests green when only `system` was captured.
      sent.body = String(init.body);
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    try {
      const spec = {
        apiVersion: "loom.dev/v1",
        kind: "GraphSpec",
        metadata: { name: "real-provider", project: "probe", version: 1 },
        policy: { expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
        channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
        inputs: ["seed"],
        outputs: ["out"],
        nodes: [
          {
            id: "act",
            type: "agent",
            reads: ["seed"],
            writes: ["out"],
            agent: {
              profile: "agent_profile/summarizer@stable",
              prompt: "prompt/act@stable",
              maxTurns: 1,
              outputSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
            },
            timeoutMs: 30_000,
          },
        ],
        edges: [],
      };

      const { compileOrThrow } = await import("../src/graph/compile.ts");
      const graph = compileOrThrow({
        spec: spec as never,
        resolver: ws.resolver,
        tools: ws.engine.tools.manifests(),
        tenantCapabilities: [],
      });
      const runId = await ws.engine.submit({ graph, inputs: { seed: "go" } });
      const p = await ws.engine.advance(runId);

      assert.equal(p?.status, "succeeded", "the agent node must complete against the real adapter");
      // The answer came from the injected provider, not from the mock — which is the whole
      // claim. `[mock] …` is what this returns when the router is not registered.
      assert.deepEqual(p?.channels["out"], { verdict: "ok" });
      // And the ResourceRef was rewritten on the way out, inside a real run rather than in
      // a direct call to the adapter.
      assert.equal(sent.model, "claude-sonnet-5");
      // THE DOCUMENT REACHED THE MODEL, in the system slot, as words. This is the assertion
      // A22 exists for: before it, `sent.system` was `You are node act.` and the sixteen
      // characters `prompt/act@stable` sat in a JSON field of the user message, which is a
      // pointer where an instruction belongs — and a run that sends a pointer SUCCEEDS, so
      // nothing anywhere went red.
      // Anthropic takes `system` as a block array, so the assertion reads the text out rather
      // than stringifying the envelope.
      const systemText = JSON.stringify(sent.system);
      assert.match(systemText, /Summarise the seed and answer with a verdict\./);
      assert.doesNotMatch(String(sent.body), /prompt\\?\/act@stable/, "the ref appears NOWHERE in the request, not merely outside `system`");
      // The provider reported usage, so the run is priced from real numbers rather than 0.
      assert.equal((p?.usage.inputTokens ?? 0) > 0, true, "usage must come back from the provider");
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});
