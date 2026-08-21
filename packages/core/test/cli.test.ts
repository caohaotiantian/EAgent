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
import { CODES, isLoomError } from "../src/errors.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs, readModels } from "../src/cli.ts";
import type { RunId } from "../src/ids.ts";

function emptyDir(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-jail-cli-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A graph whose only node writes wherever the caller says. */
/** A graph that parks on a gate, then writes. The shape the approve tests need. */
function gatedGraph(path: string): Record<string, unknown> {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "gated", project: "demo", version: 1 },
    policy: { posture: "on", capabilities: ["fs:write"], expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { note: { type: "string", reduce: "replace" }, written: { type: "object", reduce: "replace" } },
    inputs: ["note"],
    outputs: ["written"],
    nodes: [
      { id: "approve", type: "human_gate", reads: ["note"], writes: [], humanGate: { ref: "oversight/ship@stable", approval: { mode: "single", approvers: ["u:alice"] } } },
      { id: "write", type: "tool", reads: ["note"], writes: ["written"], tool: { name: "fs.write", version: "1.0", args: { path, body: "${note}" } } },
    ],
    edges: [{ id: "e1", from: "approve", to: "write", kind: "seq" }],
  };
}

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

test("A RUN CANNOT WRITE ANOTHER RUN'S GRAPH — graphs/ is denied for the same reason", async () => {
  // THE SAME RULE ONE STEP OVER, and this list did not cover it. `discoverGraphs` reads
  // `graphs/` to build the index a `serve` process answers gates from, `fs:write` is granted
  // unconditionally, and the index was keyed by `metadata.name` over an UNSORTED `readdirSync`
  // with last-writer-wins. So a run could plant `graphs/zz-planted.json` colliding with the
  // operator's real graph and EVICT it — after which a gate on a run using that graph cannot be
  // answered, while `GateSweeper` needs no attachment and expires it into `run.failed`.
  //
  // One run stripping oversight from another is a bigger hole than the prompt one next door,
  // because the prompt case changes what a model is told and this changes whether a human is
  // asked at all.
  //
  // `discoverGraphs` was hardened at the same time — sorted, first-wins, and a differing name
  // collision announced on stderr — but that is defence in depth for OPERATOR error, not for this
  // attack: the deny entry closes it at the source. The hardening has no test because
  // `discoverGraphs` runs only inside `serve`, which blocks, and this file has no non-blocking
  // door onto it. Saying so beats a test that starts a server to read one warning.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    writeFileSync(join(d.dir, "graphs", "payroll.json"), JSON.stringify(graphWriting("unused.txt")));

    const graphFile = join(d.dir, "graphs", "plant.json");
    writeFileSync(graphFile, JSON.stringify(graphWriting("graphs/payroll.json")));

    const first = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ seed: "x" })]);
    assert.equal((JSON.parse(first.out) as { status: string }).status, "failed", `the write must not succeed: ${first.out}`);
    assert.equal(
      JSON.parse(readFileSync(join(d.dir, "graphs", "payroll.json"), "utf8")).metadata.name,
      "clobber",
      "the operator's graph is untouched",
    );
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

test("A FRESH PROCESS APPROVES WITHOUT --graph — the command the binary prints now works", async () => {
  // `loom run` has always printed `— loom approve <runId> <gateId>`, and that exact command
  // returned `E_RUN_NOT_FOUND: … is not attached`. `RunGraph` is not journaled (its hash is), so
  // a fresh process had to be TOLD which graph the run used, through a `--graph` flag that
  // appeared in no usage text, no error message, and not in the hint itself. The binary told an
  // operator to type a command that could not work.
  //
  // Now the workspace's own `graphs/` directory is searched for the hash the journal records.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    writeFileSync(join(d.dir, "graphs", "g.json"), JSON.stringify(gatedGraph("after-gate.txt")));

    const first = await run(["run", join(d.dir, "graphs", "g.json"), "--workspace", d.dir, "--input", JSON.stringify({ note: "ship it" })]);
    const hint = first.out.trim().split("\n").pop() ?? "";
    const runId = /loom approve (\S+) (\S+)/.exec(hint)?.[1];
    const gateId = /loom approve (\S+) (\S+)/.exec(hint)?.[2];
    assert.ok(runId !== undefined && gateId !== undefined, `expected an approve hint, got: ${hint}`);

    const approved = await run(["approve", runId, gateId, "--workspace", d.dir, "--as", "u:alice"]);
    assert.equal(approved.code, 0, `approve must succeed without --graph: ${approved.err}`);
    assert.equal(readFileSync(join(d.dir, "after-gate.txt"), "utf8"), "ship it", "the gated action ran");
  } finally {
    d.dispose();
  }
});

test("AND A SUBSTITUTED GRAPH IS REFUSED — the gate binds what the human was shown", async () => {
  // Reproduced through the built binary before this landed: approve run A while passing graph B,
  // and B's node ran and wrote. `--graph` was simply believed.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    writeFileSync(join(d.dir, "graphs", "g.json"), JSON.stringify(gatedGraph("after-gate.txt")));
    writeFileSync(join(d.dir, "graphs", "b.json"), JSON.stringify(gatedGraph("SUBSTITUTED.txt")));

    const first = await run(["run", join(d.dir, "graphs", "g.json"), "--workspace", d.dir, "--input", JSON.stringify({ note: "n" })]);
    const hint = first.out.trim().split("\n").pop() ?? "";
    const m = /loom approve (\S+) (\S+)/.exec(hint);
    assert.ok(m !== null, `expected an approve hint, got: ${hint}`);

    // `main` THROWS here rather than returning a code — the binary's top-level catch is what
    // turns it into `E_GRAPH_MISMATCH: …` and exit 1, which is what an operator sees. `loom run`
    // catches per-command and prints; `approve` does not. Worth knowing, not worth changing here.
    await assert.rejects(
      () => run(["approve", m[1]!, m[2]!, "--workspace", d.dir, "--as", "u:alice", "--graph", join(d.dir, "graphs", "b.json")]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_GRAPH_MISMATCH,
      "a substituted graph must be refused",
    );
    assert.equal(existsSync(join(d.dir, "SUBSTITUTED.txt")), false, "and nothing may have executed");
  } finally {
    d.dispose();
  }
});

test("A FUNCTION NODE RUNS — two of eight node types could not, and nothing said so", async () => {
  // `createFunctionLoader` was the FOURTH capability this repo shipped with no caller, after
  // `runSandboxed`, `McpClient` and `ResourceStore`: the CLI built a bare `new FunctionRegistry()`
  // and nothing ever put anything in it, and `"function"` was in neither loadable resource kind,
  // so `resources/function/*.js` was never read. A graph with a `function` node compiled clean
  // and failed at run time with `no function registered as "function/x@stable"` — as did every
  // `evaluator{kind:"assertion"}`, and both shipped example workflows.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "resources", "function"), { recursive: true });
    writeFileSync(join(d.dir, "resources", "function", "double.js"), '(view) => ({ writes: { doubled: (view.get("amount") ?? 0) * 2 } })');

    const g = join(d.dir, "fn.json");
    writeFileSync(g, JSON.stringify({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "fn", project: "demo", version: 1 },
      policy: { posture: "out", expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
      channels: { amount: { type: "number", reduce: "replace" }, doubled: { type: "number", reduce: "replace" } },
      inputs: ["amount"],
      outputs: ["doubled"],
      nodes: [{ id: "d", type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } }],
      edges: [],
    }));

    const out = await run(["run", g, "--workspace", d.dir, "--input", JSON.stringify({ amount: 21 })]);
    const p = JSON.parse(out.out) as { status: string; outputs: Record<string, unknown> };
    assert.equal(p.status, "succeeded", `a function node must run: ${out.out}`);
    assert.equal(p.outputs["doubled"], 42);
  } finally {
    d.dispose();
  }
});

test("A CAPABILITY IS GRANTED EXACTLY WHEN THE OPERATOR REGISTERED THE TOOL FOR IT", async () => {
  // TWO LISTS, ONE FILE, 830 LINES APART, DISAGREEING BY CONSTRUCTION. The compiler was told the
  // tenant held `proc:exec` and every `mcp:*`; the PolicyEngine was handed a hardcoded
  // `["fs:read","fs:write","net:fetch"]`. So `loom compile` said `ok` for a graph naming
  // `proc.exec` and `loom run` failed it `E_CAP_DENIED` — `--allow-exec` and `--mcp-file` could
  // never produce a successful call, and the whole sandbox path and the entire MCP client were
  // unreachable from the deployment.
  //
  // Both lists derive from the registry now, which is also the security argument: a tool is
  // registered only when the operator passed the flag that registers it, so "registered implies
  // granted" says exactly "the operator asked for this".
  const d = emptyDir();
  try {
    const g = join(d.dir, "exec.json");
    writeFileSync(g, JSON.stringify({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "exec", project: "demo", version: 1 },
      policy: { posture: "out", capabilities: ["proc:exec"], expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
      channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [{ id: "x", type: "tool", reads: ["seed"], writes: ["out"], tool: { name: "proc.exec", version: "1.0", args: { command: "echo", args: ["hi"] } }, unhandled: true }],
      edges: [],
    }));

    // WITHOUT the flag the graph does not compile, which is the honest answer: nothing in this
    // process can run it. It used to compile `ok` and then be denied at dispatch.
    await assert.rejects(
      () => run(["compile", g, "--workspace", d.dir]),
      /GRAPH017_CAPABILITY_NOT_GRANTED/,
      "a capability no registered tool provides must not compile",
    );

    // WITH it, the same graph compiles — and the capability the compiler was told about is the
    // one the engine enforces.
    const allowed = await run(["compile", g, "--workspace", d.dir, "--allow-exec", "echo"]);
    assert.equal(allowed.code, 0, `--allow-exec must make it compile: ${allowed.out}${allowed.err}`);
  } finally {
    d.dispose();
  }
});

test("`loom run`'s EXIT CODE MEANS WHAT A SUPERVISOR READS IT AS", async () => {
  // It was `return p.status === "failed" ? 1 : 0`, so every status but `failed` exited 0 —
  // including `running`, which is what a Task left in backoff produces. A CI script reading the
  // exit code saw a green run for work that had not happened.
  //
  // THE `running` CASE ITSELF IS NOT TESTED HERE AND CANNOT BE, offline: producing one needs a
  // RETRYABLE failure, and a `function` body cannot signal one — every throw out of the vm is
  // classified `E_INTERNAL` with `retryable: false`, so a `retry` policy on a function node is
  // unreachable. That is a real gap in its own right (register B-series), and it is why the
  // first version of this test passed with BOTH fixes reverted. What is pinned here is the rest
  // of the mapping, which is reachable and was equally wrong to leave implicit.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    writeFileSync(join(d.dir, "graphs", "gated.json"), JSON.stringify(gatedGraph("after-gate.txt")));

    // A run that parks on a gate did what it was asked to and is waiting on a person: 0.
    const gated = await run(["run", join(d.dir, "graphs", "gated.json"), "--workspace", d.dir, "--input", JSON.stringify({ note: "x" })]);
    assert.equal(JSON.parse(gated.out.slice(0, gated.out.lastIndexOf("}") + 1)).status, "awaiting_gate");
    assert.equal(gated.code, 0, "awaiting a human is not a failure");

    // A run that fails is 1, and its error reaches the operator.
    writeFileSync(join(d.dir, "graphs", "boom.json"), JSON.stringify(graphWriting("../escape.txt")));
    const failed = await run(["run", join(d.dir, "graphs", "boom.json"), "--workspace", d.dir, "--input", JSON.stringify({ seed: "x" })]);
    assert.equal(JSON.parse(failed.out.slice(0, failed.out.lastIndexOf("}") + 1)).status, "failed");
    assert.equal(failed.code, 1);
  } finally {
    d.dispose();
  }
});

test("AN UNPRICED ROUTE IS NAMED AT BOOT — a budget cannot bind against a cost of zero", async () => {
  // `priceOf` returns 0 for a model outside its adapter's table, and a budget compares against a
  // number: a run on an unpriced model spends without limit while journaling `costUsd: 0`. That
  // became sharper when a graph's `policy.budget.costUsd` was made a real ceiling — a ceiling
  // nothing ever approaches is not a ceiling.
  //
  // Named per ROUTE, because a deployment usually prices some and not others, and "some model
  // somewhere is free" is not actionable.
  const d = emptyDir();
  try {
    const models = join(d.dir, "models.json");
    writeFileSync(models, JSON.stringify({
      adapters: [{ provider: "openai", baseUrl: "http://127.0.0.1:9/v1", prices: { "gpt-5": { input: 1.25, output: 10 } } }],
      routes: {
        "agent_profile/priced@stable": { adapter: "openai", model: "gpt-5" },
        "agent_profile/free@stable": { adapter: "openai", model: "some-local-model" },
      },
    }));

    const ws = openWorkspace(parseArgs(["compile", "--workspace", d.dir, "--models-file", models]), {
      ...process.env,
      OPENAI_API_KEY: "x",
    });
    try {
      assert.deepEqual(
        ws.models?.unpriced,
        ["agent_profile/free@stable → openai/some-local-model"],
        "exactly the route with no price, and not the one that has one",
      );
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});

test("A DRIFTED GRAPH STRANDS NOTHING — cancel is the exit and it needs no graph", async () => {
  // Edit a graph by one byte while a run is parked and the hash no longer matches, so `approve`
  // refuses — correctly, the approver approved THOSE bytes — and `reject` refuses too, because a
  // rejected gate runs the graph's error edges and binds like an approval does.
  //
  // That left nothing. `Engine.cancel` went through `#require` like the rest, so the one exit
  // needing no graph was shut for the same reason as the two that do, and the refusal text named
  // `--reject` and `cancel` as the ways out when neither was reachable — `loom cancel` was not
  // even a command.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const g = join(d.dir, "graphs", "gated.json");
    writeFileSync(g, JSON.stringify(gatedGraph("after-gate.txt")));

    const first = await run(["run", g, "--workspace", d.dir, "--input", JSON.stringify({ note: "n" })]);
    const m = /loom approve (\S+) (\S+)/.exec(first.out.trim().split("\n").pop() ?? "");
    assert.ok(m !== null, first.out);

    // ONE BYTE. The spec is otherwise identical and the graph still compiles.
    const drifted = JSON.parse(readFileSync(g, "utf8")) as { metadata: { version: number } };
    drifted.metadata.version = 2;
    writeFileSync(g, JSON.stringify(drifted));

    let refused: string | undefined;
    try {
      const r = await run(["approve", m[1]!, m[2]!, "--workspace", d.dir, "--as", "u:alice"]);
      refused = r.code === 0 ? undefined : `${r.err}${r.out}`;
    } catch (e) {
      refused = (e as Error).message;
    }
    assert.ok(refused !== undefined, "approve must refuse a drifted graph — it did not");
    assert.match(refused, /no graph in .* has that hash|E_GRAPH_MISMATCH/, refused);

    const cancelled = await run(["cancel", m[1]!, "--workspace", d.dir, "--as", "u:alice", "--reason", "drifted"]);
    assert.equal(cancelled.code, 0, `cancel must work with no graph: ${cancelled.err}`);
    assert.equal(JSON.parse(cancelled.out).status, "cancelled");
    assert.equal(existsSync(join(d.dir, "after-gate.txt")), false, "and the guarded action never ran");
  } finally {
    d.dispose();
  }
});

test("`loom run` SAYS WHEN THE MOCK ANSWERED — the warning lived only in serve's banner", async () => {
  // CLAUDE.md names this exact outcome as the anti-goal: "a framework whose agent nodes can only
  // return `[mock] …` is not a working deployment." The warning existed and was good, and
  // `announce` — its only caller — runs in `case "serve"` alone. `loom run`, the door a first-time
  // user goes through and the one CI drives, printed NOTHING: `"[mock] {…}"`, exit 0, stderr empty
  // at zero bytes.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "resources", "prompt"), { recursive: true });
    writeFileSync(join(d.dir, "resources", "prompt", "p.md"), "Answer.");

    const agent = join(d.dir, "agent.json");
    writeFileSync(agent, JSON.stringify({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "ag", project: "demo", version: 1 },
      policy: { posture: "out", expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
      channels: { q: { type: "string", reduce: "replace" }, a: { type: "string", reduce: "replace" } },
      inputs: ["q"],
      outputs: ["a"],
      nodes: [{ id: "ask", type: "agent", reads: ["q"], writes: ["a"], agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" } }],
      edges: [],
    }));

    const mocked = await run(["run", agent, "--workspace", d.dir, "--input", JSON.stringify({ q: "hi" })]);
    assert.match(mocked.err, /NO MODEL ADAPTER/, `an agent run with no adapter must say so: ${JSON.stringify(mocked.err)}`);
    assert.match(mocked.out, /\[mock\]/, "and the canned answer is what it is warning about");

    // AND A TOOL-ONLY GRAPH STAYS QUIET. A graph that reaches no model is not mocked, and warning
    // about it would be the kind of noise that teaches an operator to stop reading stderr — which
    // is where every honest line in this binary lives.
    const toolOnly = join(d.dir, "tool.json");
    writeFileSync(toolOnly, JSON.stringify(graphWriting("o.txt")));
    const quiet = await run(["run", toolOnly, "--workspace", d.dir, "--input", JSON.stringify({ seed: "x" })]);
    assert.doesNotMatch(quiet.err, /NO MODEL ADAPTER/, `a graph reaching no model must not warn: ${quiet.err}`);
  } finally {
    d.dispose();
  }
});
