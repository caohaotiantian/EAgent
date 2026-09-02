/**
 * `loom trace --otlp` — the PUSH half of `TODO.md` §C.4, driven through `main`.
 *
 * `telemetry/otlp.ts` shipped a complete OTLP/HTTP encoder and an exporter, and for a wave
 * NOTHING IN THE BINARY CALLED EITHER: `GET /runs/:id/trace?format=otlp` was the pull half and
 * a deployment that wanted a push had to embed the library. Driven at `c8bdf22`:
 *
 *     $ loom trace 01M1G0WR5AWX1JT4PX8R0Q7BS4 --otlp http://127.0.0.1:4318
 *     E_CONFIG_INVALID: unknown flag: --otlp.
 *
 * THE TESTS COME IN TWO KINDS AND BOTH ARE HERE ON PURPOSE. The injected-`fetch` ones use
 * `main(argv, fetchImpl)` — the seam that already exists, whose docstring argues that "a mode
 * whose only test bypasses `main` is a mode nobody has driven through the door people use" —
 * and they assert on the exact bytes and headers an argv produced. The loopback ones bind a
 * socket on 127.0.0.1 and prove the REAL `fetch` reaches a real collector. Neither reaches the
 * network and neither needs a key, so the offline-and-deterministic rule holds; and no
 * assertion here reads a clock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";

/** Built-in tools only, so nothing needs registering and no model is called. */
const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "copy-file", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read", "fs:write"] },
  channels: {
    source: { type: "string", reduce: "replace" },
    body: { type: "string", reduce: "replace" },
    written: { type: "object", reduce: "replace" },
  },
  inputs: ["source"],
  outputs: ["written"],
  nodes: [
    { id: "read", type: "tool", reads: ["source"], writes: ["body"], tool: { name: "fs.read", version: "1.0", args: { path: "${source}" } } },
    {
      id: "write",
      type: "tool",
      reads: ["body"],
      writes: ["written"],
      unhandled: true,
      tool: { name: "fs.write", version: "1.0", args: { path: "out/copy.txt", body: "${body}" } },
    },
  ],
  edges: [{ id: "e1", from: "read", to: "write", kind: "seq" }],
};

const CHILD = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "child", project: "t", version: 1 },
  policy: { posture: "out", capabilities: ["fs:write"] },
  channels: { q: { type: "string", reduce: "replace" }, a: { type: "object", reduce: "replace" } },
  inputs: ["q"],
  outputs: ["a"],
  nodes: [{ id: "w", type: "tool", reads: ["q"], writes: ["a"], tool: { name: "fs.write", version: "1.0", args: { path: "child.txt", body: "${q}" } } }],
  edges: [],
};

const PARENT = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "parent", project: "t", version: 1 },
  policy: { posture: "out", capabilities: ["fs:write"], expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 } },
  channels: { note: { type: "string", reduce: "replace" }, result: { type: "object", reduce: "replace" } },
  inputs: ["note"],
  outputs: ["result"],
  nodes: [
    { id: "call", type: "subgraph", reads: ["note"], writes: ["result"], subgraph: { ref: "subgraph/child@stable", inputs: { q: "note" }, outputs: { result: "a" } } },
  ],
  edges: [],
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface Cli {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/**
 * Run `main` and capture what it printed.
 *
 * **STDOUT IS CAPTURED *AND FORWARDED*, AND THAT IS NOT A STYLE CHOICE — a swallowing capture
 * silently deletes most of this file.** `node:test`'s own reporter writes through
 * `process.stdout.write`, and it flushes on a later tick, so a capture that holds the swap
 * across an `await` and returns `true` without forwarding EATS THE REPORTER'S OWN LINES. This
 * file was first written the swallowing way and `node --test` on it printed:
 *
 *     ✔ CONTROL CHARACTERS FROM A COLLECTOR DO NOT REACH THE TERMINAL
 *     ✔ ONE RUN'S FAILURE DOES NOT HIDE THE OTHERS
 *     ℹ tests 2
 *
 * Fourteen tests ran; two were counted. Every one of them PASSED when named with
 * `--test-name-pattern`, so the file looked green while twelve of its assertions were invisible
 * — and a failure among them would have been invisible in exactly the same way. Measured, five
 * identical tests with one 5 ms await inside the window: swallowing stdout reports **1 of 5**,
 * forwarding reports **5 of 5**, and swallowing only stderr reports **5 of 5**.
 *
 * So stdout forwards (the CLI's own output shows up in the test log, which is the honest cost)
 * and stderr does not (measured safe, and it is where the `otlp:` lines and the compiler's
 * diagnostics go). `cli/cli.test.ts` swallows both and reports its full 38 today; it is not
 * changed here, but it is the same trap one timing change away, and this is the note that says
 * so.
 */
async function cli(argv: readonly string[], fetchImpl?: FetchLike): Promise<Cli> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string, ...rest: unknown[]) => {
    out.push(String(chunk));
    return (realOut as unknown as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main([...argv], fetchImpl);
    return { code, out: out.join(""), err: errOut.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/** `cli`, for an argv expected to throw before it produces an exit code. */
async function refusal(argv: readonly string[]): Promise<Error> {
  try {
    await cli(argv);
  } catch (e) {
    return e as Error;
  }
  return assert.fail(`${argv.join(" ")} was expected to refuse`);
}

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-otlp-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  writeFileSync(join(dir, "graphs", "copy.json"), JSON.stringify(GRAPH));
  writeFileSync(join(dir, "input.txt"), "hello");
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

async function submit(dir: string, graph = "graphs/copy.json", input: Record<string, unknown> = { source: "input.txt" }): Promise<string> {
  const r = await cli(["run", join(dir, graph), "--workspace", dir, "--input", JSON.stringify(input)]);
  assert.equal(r.code, 0, r.err);
  return (JSON.parse(r.out) as { runId: string }).runId;
}

/** Every POST an injected `fetch` saw, and a canned answer for each. */
function recorder(answer: () => Response): { calls: { url: string; init: RequestInit }[]; fetch: FetchLike } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(answer());
    },
  };
}

const ok200 = (): Response => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A collector on 127.0.0.1 that records what it was POSTed. Not the network. */
async function collector(reply: (n: number) => { status: number; body: string } = () => ({ status: 200, body: "{}" })): Promise<{
  endpoint: string;
  seen: Sent[];
  close: () => Promise<void>;
}> {
  const seen: Sent[] = [];
  const server = createServer((q, s) => {
    let body = "";
    q.on("data", (c) => (body += String(c)));
    q.on("end", () => {
      seen.push({ url: q.url ?? "", headers: q.headers as Record<string, string>, body });
      const r = reply(seen.length);
      s.writeHead(r.status, { "content-type": "application/json" });
      s.end(r.body);
    });
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    seen,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/** One resource attribute bag, flattened out of an `ExportTraceServiceRequest`. */
function resourceAttrs(body: string): Record<string, unknown> {
  const p = JSON.parse(body) as { resourceSpans: { resource: { attributes: { key: string; value: Record<string, unknown> }[] } }[] };
  const out: Record<string, unknown> = {};
  for (const a of p.resourceSpans[0]!.resource.attributes) out[a.key] = Object.values(a.value)[0];
  return out;
}

function spansOf(body: string): { name: string; traceId: string; links?: { traceId: string }[] }[] {
  const p = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: { name: string; traceId: string; links?: { traceId: string }[] }[] }[] }[] };
  return p.resourceSpans[0]!.scopeSpans[0]!.spans;
}

/** Set an env var for one test and put it back, whatever the test does. */
async function withEnv(name: string, value: string | undefined, body: () => Promise<void>): Promise<void> {
  const had = Object.hasOwn(process.env, name);
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await body();
  } finally {
    if (had) process.env[name] = before;
    else delete process.env[name];
  }
}

const HEADERS_ENV = "OTEL_EXPORTER_OTLP_HEADERS";

// ── the push exists ──────────────────────────────────────────────────────────

test("THE HOLE THIS CLOSES: `loom trace --otlp` POSTs the fold to a collector", async () => {
  const w = workspace();
  try {
    const runId = await submit(w.dir);
    const rec = recorder(ok200);
    const r = await cli(["trace", runId, "--workspace", w.dir, "--otlp", "http://collector.invalid:4318"], rec.fetch);

    assert.equal(r.code, 0, r.err);
    assert.equal(rec.calls.length, 1, "one run, one POST");
    // `/v1/traces` is appended to the base — the spelling an operator has in
    // OTEL_EXPORTER_OTLP_ENDPOINT — and the encoding is OTLP/HTTP JSON.
    assert.equal(rec.calls[0]!.url, "http://collector.invalid:4318/v1/traces");
    const headers = rec.calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
    assert.equal(rec.calls[0]!.init.method, "POST");

    const body = String(rec.calls[0]!.init.body);
    const attrs = resourceAttrs(body);
    assert.equal(attrs["service.name"], "loom", "the encoder's default, not a second spelling in cli.ts");
    // THE RUN ID, keyed by the constant `telemetry/spans.ts` owns. `registries.test.ts` makes a
    // `loom.*` literal outside that file a failure, and it has already caught `server/http.ts`
    // minting its own — so this asserts the VALUE reached the wire, and that guard asserts
    // nobody spelled the key twice.
    assert.equal(attrs["loom.run_id"], runId);
    const names = spansOf(body).map((s) => s.name);
    assert.ok(names.includes("loom.run"), `the run's own span must be on the wire: ${names.join(", ")}`);
    assert.ok(names.includes("loom.task"), names.join(", "));

    // AND THE TREE STILL PRINTS. `--otlp` adds a destination; it does not replace the terminal.
    assert.match(r.out, /loom\.run \[ok\]/);
    assert.match(r.out, /conformance: ok/);
    assert.match(r.err, /^otlp: .* span\(s\) sent to collector\.invalid:4318$/m);
  } finally {
    w.dispose();
  }
});

test("...and without --otlp it sends nothing at all", async () => {
  const w = workspace();
  try {
    const runId = await submit(w.dir);
    const rec = recorder(ok200);
    const r = await cli(["trace", runId, "--workspace", w.dir], rec.fetch);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(rec.calls, [], "a trace with no --otlp must not reach a collector");
    assert.doesNotMatch(r.err, /otlp:/);
  } finally {
    w.dispose();
  }
});

test("THE REAL `fetch` REACHES A REAL COLLECTOR — loopback, not a stub", async () => {
  const w = workspace();
  const c = await collector();
  try {
    const runId = await submit(w.dir);
    const r = await cli(["trace", runId, "--workspace", w.dir, "--otlp", c.endpoint]);
    assert.equal(r.code, 0, r.err);
    assert.equal(c.seen.length, 1);
    assert.equal(c.seen[0]!.url, "/v1/traces");
    assert.equal(resourceAttrs(c.seen[0]!.body)["loom.run_id"], runId);
  } finally {
    await c.close();
    w.dispose();
  }
});

// ── one trace per run, and the collector does the join ───────────────────────

test("A SUBGRAPH IS ONE REQUEST PER RUN, UNSPLICED, AND THE PARENT'S LINK NAMES THE CHILD'S TRACE", async () => {
  // The decision this pins. `loom trace` SPLICES for the terminal, and `spliceSubgraph` rewrites
  // the child's traceId onto the parent's — so exporting the spliced array would hand the
  // collector the same child spans under a different id than `GET /runs/<child>/trace?format=otlp`
  // answers for them, and the two doors would disagree about the identity of one span.
  const w = workspace();
  try {
    mkdirSync(join(w.dir, "resources", "subgraph"), { recursive: true });
    writeFileSync(join(w.dir, "resources", "subgraph", "child.json"), JSON.stringify(CHILD));
    writeFileSync(join(w.dir, "graphs", "parent.json"), JSON.stringify(PARENT));
    const runId = await submit(w.dir, "graphs/parent.json", { note: "n" });

    const rec = recorder(ok200);
    const r = await cli(["trace", runId, "--workspace", w.dir, "--otlp", "http://collector.invalid:4318"], rec.fetch);
    assert.equal(r.code, 0, r.err);
    assert.equal(rec.calls.length, 2, "the parent and its child are two runs and therefore two traces");

    const bodies = rec.calls.map((c) => String(c.init.body));
    const ids = bodies.map((b) => String(resourceAttrs(b)["loom.run_id"]));
    assert.equal(ids[0], runId);
    assert.ok(ids[1]!.startsWith(`${runId}~`), `the second POST must be the CHILD run: ${ids[1]!}`);

    const parentSpans = spansOf(bodies[0]!);
    const childSpans = spansOf(bodies[1]!);
    const parentTrace = new Set(parentSpans.map((s) => s.traceId));
    const childTrace = new Set(childSpans.map((s) => s.traceId));
    assert.equal(parentTrace.size, 1);
    assert.equal(childTrace.size, 1);
    assert.notEqual(
      [...parentTrace][0],
      [...childTrace][0],
      "UNSPLICED: the child keeps its own traceId, which is the one its own trace carries",
    );

    // AND THE JOIN IS RESOLVABLE. This is `SpanLink.traceId`'s consumer outside the in-process
    // splice — the thing §C.4 was written because it did not have.
    const links = parentSpans.flatMap((s) => s.links ?? []);
    assert.ok(
      links.some((l) => l.traceId === [...childTrace][0]),
      `a parent span must link to the child's trace: links=${JSON.stringify(links)} child=${[...childTrace][0]!}`,
    );
  } finally {
    w.dispose();
  }
});

// ── the credential ───────────────────────────────────────────────────────────

test("HEADERS COME FROM THE ENVIRONMENT, AND THERE IS NO FLAG THAT TAKES THEM", async () => {
  const w = workspace();
  try {
    const runId = await submit(w.dir);
    await withEnv(HEADERS_ENV, "api-key=sk-live-abc123,x-tenant=acme%20corp", async () => {
      const rec = recorder(ok200);
      const r = await cli(["trace", runId, "--workspace", w.dir, "--otlp", "http://collector.invalid:4318"], rec.fetch);
      assert.equal(r.code, 0, r.err);
      const headers = rec.calls[0]!.init.headers as Record<string, string>;
      assert.equal(headers["api-key"], "sk-live-abc123");
      assert.equal(headers["x-tenant"], "acme corp", "values are percent-decoded, as OTel specifies");
    });

    // THE POINT OF THE ENV VAR. A credential on argv is readable out of `ps` by every user on
    // the box, which is the finding KNOWN_FLAGS records about `--token`. So the flag does not
    // exist, and the refusal is the ordinary unknown-flag one.
    const e = await refusal(["trace", runId, "--workspace", w.dir, "--otlp-headers", "api-key=x"]);
    assert.ok(isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /unknown flag/.test(e.message), e.message);
  } finally {
    w.dispose();
  }
});

test("A COLLECTOR CANNOT ECHO THE CREDENTIAL BACK ONTO STDERR", async () => {
  // The regression for the exporter's mask. `#secrets` was built from the ENDPOINT alone while
  // `OtlpExporterOptions.headers` said in its own docstring that it is where the API key goes,
  // so a gateway that quotes the auth header in its 4xx body put the key on the operator's
  // terminal — and into whatever CI log was capturing it.
  const secret = "sk-live-abc123";
  const c = await collector(() => ({ status: 400, body: `bad request: seen authorization=Bearer ${secret} at /v1/traces` }));
  const w = workspace();
  try {
    const runId = await submit(w.dir);
    await withEnv(HEADERS_ENV, `authorization=Bearer%20${secret}`, async () => {
      const r = await cli(["trace", runId, "--workspace", w.dir, "--otlp", c.endpoint]);
      assert.equal(r.code, 1, "a 400 from the collector is an export that did not happen");
      assert.match(r.err, /otlp: .* FAILED \(status\)/);
      assert.ok(!r.err.includes(secret), `the credential reached stderr:\n${r.err}`);
      assert.match(r.err, /\[redacted\]/);
      // AND THE HOSTNAME SURVIVES, because that is what an operator diagnoses with. The
      // exporter masks the scheme-qualified ORIGIN and leaves the bare host legible; the CLI
      // prints the host for exactly that reason.
      assert.match(r.err, /127\.0\.0\.1:\d+/);
      // The run still traced. Telemetry may fail; it may not take the command's answer with it.
      assert.match(r.out, /conformance: ok/);
    });
  } finally {
    await c.close();
    w.dispose();
  }
});

test("A MALFORMED OTEL_EXPORTER_OTLP_HEADERS REFUSES, AND NAMES NO VALUE", async () => {
  const w = workspace();
  try {
    const runId = await submit(w.dir);
    const cases: readonly { readonly value: string; readonly says: RegExp }[] = [
      { value: "notakeyvalue", says: /is not `key=value`/ },
      { value: "api-key=a,,x=b", says: /entry 2 of 3 is empty/ },
      { value: "bad key=v", says: /not a valid HTTP field name: "bad key"/ },
      { value: "k=%zz", says: /not valid percent-encoding/ },
      { value: "k=one,k=two", says: /repeats the key "k"/ },
      { value: "k=line%0Ainjected", says: /control character/ },
    ];
    for (const c of cases) {
      await withEnv(HEADERS_ENV, c.value, async () => {
        const e = await refusal(["trace", runId, "--workspace", w.dir, "--otlp", "http://collector.invalid:4318"]);
        assert.ok(isLoomError(e) && e.code === CODES.E_CONFIG_INVALID, `${c.value}: ${String(e)}`);
        assert.match(e.message, c.says, c.value);
        // NEVER THE VALUE. A refusal is the text most likely to be pasted into a ticket, and
        // this variable's values are credentials by construction.
        for (const leak of ["notakeyvalue", "one", "two", "%zz", "line", "injected"]) {
          if (!c.value.includes(leak)) continue;
          if (c.says.source.includes(leak)) continue;
          assert.ok(!e.message.includes(`"${leak}"`), `${c.value} quoted a value: ${e.message}`);
        }
      });
    }

    // A MALFORMED LIST WITH NO --otlp IS NOT AN ERROR. An operator with the variable exported in
    // their shell must not have a plain `loom trace` start refusing over a collector they are
    // not using on this invocation.
    await withEnv(HEADERS_ENV, "notakeyvalue", async () => {
      const r = await cli(["trace", runId, "--workspace", w.dir]);
      assert.equal(r.code, 0, r.err);
    });
  } finally {
    w.dispose();
  }
});

// ── argv decides both whether and where ──────────────────────────────────────

test("NOTHING IN THE ENVIRONMENT CAN MAKE THIS COMMAND SEND", async () => {
  const w = workspace();
  try {
    const runId = await submit(w.dir);
    // Both OTel endpoint variables set, and a bare `--otlp` STILL refuses. A shell that happens
    // to export the standard variable is not an operator asking for egress, and the empty
    // spelling — what `--otlp "$UNSET"` expands to — is the same refusal for the same reason.
    await withEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.invalid:4318", async () => {
      await withEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://collector.invalid:4318/v1/traces", async () => {
        for (const argv of [
          ["trace", runId, "--workspace", w.dir, "--otlp"],
          ["trace", runId, "--workspace", w.dir, "--otlp="],
        ]) {
          const e = await refusal(argv);
          assert.ok(isLoomError(e) && e.code === CODES.E_CONFIG_INVALID, String(e));
          assert.match(e.message, /--otlp was given (with no value at all|an empty value)/);
        }
        // And a plain trace with both variables set exports nothing.
        const rec = recorder(ok200);
        const r = await cli(["trace", runId, "--workspace", w.dir], rec.fetch);
        assert.equal(r.code, 0, r.err);
        assert.deepEqual(rec.calls, []);
      });
    });
  } finally {
    w.dispose();
  }
});

test("A VALUE THAT IS NOT AN http(s) URL IS REFUSED, AND IS NOT QUOTED BACK", async () => {
  const w = workspace();
  try {
    const runId = await submit(w.dir);
    // The transposition `loom trace --otlp <runId>` and a pasted key both land here, and this
    // function cannot tell a typo from a credential — so it names neither.
    const e = await refusal(["trace", runId, "--workspace", w.dir, "--otlp", "sk-live-abc123"]);
    assert.match(e.message, /did not parse as a URL/);
    assert.ok(!e.message.includes("sk-live-abc123"), e.message);

    const scheme = await refusal(["trace", runId, "--workspace", w.dir, "--otlp", "ftp://collector.invalid"]);
    assert.match(scheme.message, /"ftp:" scheme/);
  } finally {
    w.dispose();
  }
});

test("--otlp ON ANY OTHER VERB IS REFUSED, NOT IGNORED", async () => {
  const w = workspace();
  try {
    const runId = await submit(w.dir);
    for (const verb of ["replay", "audit", "gates", "run"]) {
      const e = await refusal([verb, runId, "--workspace", w.dir, "--otlp", "http://collector.invalid:4318"]);
      assert.ok(isLoomError(e) && e.code === CODES.E_CONFIG_INVALID, `${verb}: ${String(e)}`);
      assert.match(e.message, /--otlp is read by `loom trace` and by no other verb/);
      // NOT "unknown flag". `known-flags.test.ts` drives every ADVERTISED flag through `compile`
      // and asserts what comes back is not that message — it is how that gate proves an
      // advertised flag is reachable — so this refusal must not impersonate one.
      assert.doesNotMatch(e.message, /unknown flag/, `${verb}: this refusal must not read as an unknown flag`);
    }
  } finally {
    w.dispose();
  }
});

// ── what the exit code means now ─────────────────────────────────────────────

test("AN EXPORT THAT DID NOT HAPPEN IS EXIT 1, EVEN WHEN THE RUN CONFORMED", async () => {
  const w = workspace();
  try {
    const runId = await submit(w.dir);
    const rec = recorder(() => {
      throw new TypeError("fetch failed");
    });
    const r = await cli(["trace", runId, "--workspace", w.dir, "--otlp", "http://collector.invalid:4318"], rec.fetch);
    assert.equal(r.code, 1, "0 means what you asked for happened, and the export did not");
    assert.match(r.out, /conformance: ok/, "the RUN was fine and the output still says so");
    assert.match(r.err, /otlp: .* FAILED \(transport\)/);
  } finally {
    w.dispose();
  }
});

test("A 200 THAT REJECTED SPANS IS ALSO EXIT 1, AND THE COUNT IS NAMED", async () => {
  // OTLP's partialSuccess. The collector took the request and threw part of it away; reporting
  // that as a clean success is how a broken pipeline stays invisible, which is why
  // `OtlpExportResult` carries the count at all.
  const w = workspace();
  const c = await collector(() => ({ status: 200, body: JSON.stringify({ partialSuccess: { rejectedSpans: 3, errorMessage: "unsupported attribute type" } }) }));
  try {
    const runId = await submit(w.dir);
    const r = await cli(["trace", runId, "--workspace", w.dir, "--otlp", c.endpoint]);
    assert.equal(r.code, 1);
    assert.match(r.err, /REJECTED 3 of \d+ span\(s\): unsupported attribute type/);
  } finally {
    await c.close();
    w.dispose();
  }
});

test("CONTROL CHARACTERS FROM A COLLECTOR DO NOT REACH THE TERMINAL", async () => {
  // `detail` and `errorMessage` are chosen by the party outside the trust boundary and they land
  // on the line that explains a non-zero exit. An escape sequence there could rewrite or hide
  // it, so the CLI renders collector text and nothing else does.
  const w = workspace();
  const c = await collector(() => ({ status: 400, body: "before\u001b[2Kafter\nsecond line" }));
  try {
    const runId = await submit(w.dir);
    const r = await cli(["trace", runId, "--workspace", w.dir, "--otlp", c.endpoint]);
    assert.equal(r.code, 1);
    const line = r.err.split("\n").find((l) => l.startsWith("otlp:"))!;
    assert.ok(line.includes("before"), line);
    assert.ok(line.includes("after"), line);
    assert.ok(!line.includes("\u001b"), "an escape sequence survived into the report");
    assert.ok(line.includes("second line"), "the whole body still reaches the operator, on one line");
  } finally {
    await c.close();
    w.dispose();
  }
});

test("ONE RUN'S FAILURE DOES NOT HIDE THE OTHERS — every run gets its own line", async () => {
  // The cost of one POST per run is that a partial export is possible; the answer is that each
  // run's outcome is reported rather than collapsed into a single number.
  const w = workspace();
  try {
    mkdirSync(join(w.dir, "resources", "subgraph"), { recursive: true });
    writeFileSync(join(w.dir, "resources", "subgraph", "child.json"), JSON.stringify(CHILD));
    writeFileSync(join(w.dir, "graphs", "parent.json"), JSON.stringify(PARENT));
    const runId = await submit(w.dir, "graphs/parent.json", { note: "n" });

    let n = 0;
    const rec = recorder(() => {
      n += 1;
      if (n === 1) return ok200();
      throw new TypeError("fetch failed");
    });
    const r = await cli(["trace", runId, "--workspace", w.dir, "--otlp", "http://collector.invalid:4318"], rec.fetch);
    assert.equal(r.code, 1);
    const lines = r.err.split("\n").filter((l) => l.startsWith("otlp:"));
    assert.equal(lines.length, 2, `both runs must be reported:\n${r.err}`);
    assert.match(lines[0]!, /span\(s\) sent to/);
    assert.match(lines[1]!, /FAILED \(transport\)/);
  } finally {
    w.dispose();
  }
});
