/**
 * A HANDLE IS NOT A THING A HUMAN CAN APPROVE, AND NEITHER IS AN UNBOUNDED ONE.
 *
 * `TODO.md` §A.51, both halves, and both were DISCLOSED by the source that shipped them rather
 * than discovered later.
 *
 * (a) `loom gates` built `reads` from the raw `RunProjection`, where `withHandles` has already
 * substituted `payloadHandle(ref)` for every channel the journal externalised. The engine
 * resolves before it renders a gate payload — `run/engine.ts`: *"HERE, AND ONLY HERE, is where
 * a handle becomes a value … the gate payload a human reads"* — so over
 * `EXTERNALISE_ABOVE_BYTES` the console operator read the document and the CLI operator read a
 * digest. Measured on a 200,000-byte `fs.read` into a `replace` channel a `human_gate` reads,
 * before:
 *
 *     body -> {"$payload":{"digest":"sha256:21ffb925…","bytes":200002}}
 *
 * which is §A.43 — "an operator approving a hash" — regained in a different currency.
 *
 * (b) Nothing bounded the inline case, and fixing (a) made that worse rather than better: a
 * 200,000-byte value was at least bounded by its ~110-byte handle, and after (a) it prints
 * whole, once per gate, on a wide fan-out. So each value is capped at 64 KiB and says what it
 * cut, with `--max-bytes` to raise the cap and `--max-bytes 0` to remove it.
 *
 * THE ORDER OF THE THREE STEPS IS THE PROPERTY MOST AT RISK, and it is pinned below:
 * **resolve, then redact, then bound.** Redacting first sweeps the HANDLE rather than the
 * value — measured, `redactPayload({$payload:…}, "internal")` returns the handle untouched, so
 * an ordinary channel would still print a digest — and bounding first hands the detector sweep
 * a value cut in half. Which test catches which is written at each one, because no single
 * channel catches all three.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXTERNALISE_ABOVE_BYTES } from "../../src/journal/payloads.ts";

const CLI_SRC = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/**
 * COMFORTABLY OVER THE THRESHOLD, and asserted against the constant rather than against 65536:
 * if `EXTERNALISE_ABOVE_BYTES` ever moves, this fixture must move with it or it stops
 * measuring anything.
 */
const BIG = "x".repeat(EXTERNALISE_ABOVE_BYTES * 3);

/**
 * A credential-shaped token FAR PAST the detector's default window, in an UNCLASSIFIED channel.
 *
 * `redactPayload` sweeps 8 KiB per string leaf by default — a bound on WORK, in `redact.ts`'s
 * own words, and explicitly not a claim that 8 KB of credential-shaped text is safe. Every
 * value §A.51a unhides is over `EXTERNALISE_ABOVE_BYTES` by construction, so it is always at
 * least eight times that window: resolving the handle without widening the sweep swaps a digest
 * for a document whose last 94% was never looked at.
 *
 * Word-bounded, because `DETECTORS` matches on boundaries. The prose before it is 81,000 bytes
 * — past `EXTERNALISE_ABOVE_BYTES`, so the channel really leaves the journal, and ten times the
 * 8 KiB window, so the assertion cannot pass by accident if that window moves a little.
 */
const AWS_KEY = "AKIAIOSFODNN7EXAMPLB";
const LATE = `${"lorem ipsum dolor sit amet ".repeat(3000)} ${AWS_KEY} ${"trailing prose ".repeat(200)}`;
const SMALL = "ship the release notes for 4.2";
const SECRET = `sk-live-${"y".repeat(EXTERNALISE_ABOVE_BYTES * 2)}`;

/**
 * `body` and `credential` are both eligible for externalisation and `note` is not big enough
 * to be — `externalisableChannels` takes every `replace` channel that is not an output, not a
 * fan-out's `over`/`as` and not named by an expression, which all three are.
 *
 * `credential` IS DECLARED `secret_ref` AND IS ALSO OVER THE THRESHOLD, which is the row that
 * makes the ORDER assertable: it must come back `[secret]`, not a handle and not 64 KiB of the
 * secret with a truncation marker on it.
 */
const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "gated-big", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read", "fs:write"] },
  channels: {
    source: { type: "string", reduce: "replace" },
    body: { type: "string", reduce: "replace" },
    credential: { type: "string", reduce: "replace", classification: "secret_ref" },
    note: { type: "string", reduce: "replace" },
    // UNCLASSIFIED and over the externalisation threshold — the exact shape the sweep window
    // has to cover, and the one an author never declared anything about.
    haystack: { type: "string", reduce: "replace" },
    written: { type: "object", reduce: "replace" },
  },
  inputs: ["source", "credential", "note", "haystack"],
  outputs: ["written"],
  nodes: [
    {
      id: "read",
      type: "tool",
      reads: ["source"],
      writes: ["body"],
      tool: { name: "fs.read", version: "1.0", args: { path: "${source}" } },
    },
    {
      id: "approve",
      type: "human_gate",
      reads: ["body", "credential", "note", "haystack"],
      writes: ["credential"],
      humanGate: { ref: "oversight/publish@stable" },
    },
    {
      id: "write",
      type: "tool",
      reads: ["note"],
      writes: ["written"],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/note.txt", body: "${note}" } },
      unhandled: true,
    },
  ],
  edges: [
    { id: "e1", from: "read", to: "approve", kind: "seq" },
    { id: "e2", from: "approve", to: "write", kind: "seq" },
  ],
};

interface Cap {
  code: number;
  out: string;
  err: string;
}

/**
 * A CHILD PROCESS, WHERE THE OTHER CLI SUITES SWAP `process.stdout.write` FOR AN ARRAY.
 *
 * That trick is fine for small output and it does not survive this fixture. `node --test`
 * runs each file as a CHILD, and the child reports its results to the parent over its own
 * stdout in V8's binary serialization — so any runner message emitted while the write hook is
 * installed lands in the captured buffer instead. With a 196,608-byte channel the `main` calls
 * here are slow enough for that every time: measured, this file reported ONE of its six tests
 * and failed it with `SyntaxError: Unexpected token` out of `JSON.parse`, on a buffer holding
 * the runner's own bytes. Spawning is also the more faithful measurement — it is the command
 * an operator runs, exit code and all.
 */
async function cli(argv: string[]): Promise<Cap> {
  return await new Promise<Cap>((resolve) => {
    execFile(
      process.execPath,
      [CLI_SRC, ...argv],
      // The uncapped case prints the whole 196 KB document, which is well inside this and
      // well outside `execFile`'s 1 MB default.
      { cwd: dirname(CLI_SRC), timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      (e, stdout, stderr) => {
        resolve({ code: e === null ? 0 : ((e as NodeJS.ErrnoException & { code?: number }).code ?? 1), out: stdout, err: stderr });
      },
    );
  });
}

function workspace(): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-gate-resolved-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  const graphFile = join(dir, "graphs", "gated.json");
  writeFileSync(graphFile, JSON.stringify(GRAPH));
  writeFileSync(join(dir, "input.txt"), BIG);
  return { dir, graphFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

interface GateRow {
  gateId: string;
  nodeId: string;
  contentDigest: string;
  reads?: Record<string, unknown>;
}

async function park(w: { dir: string; graphFile: string }): Promise<string> {
  const started = await cli([
    "run",
    w.graphFile,
    "--workspace",
    w.dir,
    "--input",
    JSON.stringify({ source: "input.txt", credential: SECRET, note: SMALL, haystack: LATE }),
  ]);
  assert.equal(started.code, 0, started.err);
  const p = JSON.parse(started.out) as Record<string, unknown>;
  assert.equal(p["status"], "awaiting_gate", `the fixture must park for this to mean anything: ${started.out}`);
  return String(p["runId"]);
}

/** `undefined` when it is not a handle — used to say "this is not a `$payload`" and nothing else. */
function handleOf(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && Object.hasOwn(v, "$payload") ? (v as Record<string, unknown>) : undefined;
}

function truncationOf(v: unknown): { bytes: number; shown: number; head: string } | undefined {
  if (typeof v !== "object" || v === null || !Object.hasOwn(v, "$truncated")) return undefined;
  return (v as { $truncated: { bytes: number; shown: number; head: string } }).$truncated;
}

test("AN EXTERNALISED CHANNEL PRINTS ITS VALUE, NEVER ITS HANDLE — `--max-bytes 0`", async () => {
  const w = workspace();
  try {
    const runId = await park(w);
    // No cap, so the only thing under test is resolution: a handle in, the document out.
    const listed = await cli(["gates", runId, "--workspace", w.dir, "--max-bytes", "0"]);
    assert.equal(listed.code, 0, listed.err);
    const row = (JSON.parse(listed.out) as GateRow[])[0]!;
    assert.equal(row.nodeId, "approve");
    const reads = row.reads!;

    assert.equal(handleOf(reads["body"]), undefined, `\`body\` is still a handle: ${JSON.stringify(reads["body"])}`);
    assert.equal(reads["body"], BIG, "the whole document, resolved exactly as `#resolveReads` would resolve it");

    // THE PRECONDITION. If the fixture stopped being externalised, every assertion above would
    // pass on a projection that never held a handle at all.
    assert.ok(BIG.length > EXTERNALISE_ABOVE_BYTES, "the fixture must clear the externalisation threshold");
    assert.ok(!listed.out.includes("$payload"), `no channel may print a handle: ${listed.out.slice(0, 400)}`);

    // AND THE BINDING IS UNTOUCHED. `contentDigest` is what an approval binds and it is not
    // what this field is; resolving the content beside it must not disturb it.
    assert.match(row.contentDigest, /\S/);
  } finally {
    w.dispose();
  }
});

test("RESOLVE, THEN REDACT — a `secret_ref` channel over the threshold is blanked, not shown", async () => {
  // THE ORDER, AND WHICH WRONG ORDER THIS CHANNEL ACTUALLY CATCHES. `credential` is both
  // externalised (measured: the run's `RunProjection.external` is `["credential","body"]`) and
  // declared `secret_ref`, and the three orderings do NOT each produce a distinct answer here:
  //
  //   - RESOLVE AND DO NOT REDACT → the secret in the clear. Caught below.
  //   - BOUND BEFORE REDACT → 64 KiB of the secret under a `$truncated` marker. Caught below.
  //   - REDACT BEFORE RESOLVE → still `[secret]`, so this channel does NOT discriminate it.
  //     Measured: `redactPayload({$payload:{digest,bytes}}, "secret_ref")` is `"[secret]"`,
  //     while the same call at `"internal"` returns the handle untouched. The channel that
  //     catches that ordering is the UNCLASSIFIED one — `body` in the test above, which comes
  //     back a handle if anything redacts before it resolves. Said here rather than claiming
  //     one fixture covers all three, which the first draft of this comment did.
  const w = workspace();
  try {
    const runId = await park(w);
    const listed = await cli(["gates", runId, "--workspace", w.dir, "--max-bytes", "0"]);
    assert.equal(listed.code, 0, listed.err);
    const reads = (JSON.parse(listed.out) as GateRow[])[0]!.reads!;

    assert.equal(reads["credential"], "[secret]", JSON.stringify(reads["credential"]).slice(0, 200));
    assert.ok(!listed.out.includes(SECRET.slice(0, 64)), "a secret_ref value must not reach stdout");
    assert.equal(handleOf(reads["credential"]), undefined, "and it must not read back as a handle either");

    // The unclassified neighbour is untouched, so "blank everything" cannot satisfy this file.
    assert.equal(reads["note"], SMALL);
  } finally {
    w.dispose();
  }
});

test("AND IT IS BOUNDED — over the cap the value is marked, and the marker says how much was cut", async () => {
  const w = workspace();
  try {
    const runId = await park(w);
    const listed = await cli(["gates", runId, "--workspace", w.dir]);
    assert.equal(listed.code, 0, listed.err);
    const reads = (JSON.parse(listed.out) as GateRow[])[0]!.reads!;

    const cut = truncationOf(reads["body"]);
    assert.ok(cut !== undefined, `\`body\` must be marked as truncated by default: ${JSON.stringify(reads["body"]).slice(0, 200)}`);
    assert.equal(cut.bytes, Buffer.byteLength(JSON.stringify(BIG), "utf8"), "the marker states the FULL size, measured on the JSON form");
    assert.equal(cut.shown, EXTERNALISE_ABOVE_BYTES, "the default cap is the externalisation threshold, one number for both");
    assert.equal(Buffer.byteLength(cut.head, "utf8"), cut.shown, "`shown` is the size of what is actually here");
    assert.ok(JSON.stringify(BIG).startsWith(cut.head), "`head` is a PREFIX of the value, not a rendering of it");

    // AND IT IS SAID OUT LOUD, on stderr so `loom gates | jq` is unaffected. A value silently
    // cut is a value an operator reads as complete, on the door whose subject is a human
    // deciding on what it shows.
    assert.match(listed.err, /! TRUNCATED — `body` is \d+ bytes, showing \d+/, listed.err);
    assert.match(listed.err, /--max-bytes 0/, "and the notice names the way out");
    assert.ok(!/TRUNCATED/.test(listed.out), "the notice is not on stdout");

    // THE SMALL CHANNEL IS UNTOUCHED, so a cap that flattened everything cannot pass.
    assert.equal(reads["note"], SMALL);
  } finally {
    w.dispose();
  }
});

test("`--max-bytes N` is the dial, and it caps the JSON form", async () => {
  const w = workspace();
  try {
    const runId = await park(w);
    const listed = await cli(["gates", runId, "--workspace", w.dir, "--max-bytes", "128"]);
    assert.equal(listed.code, 0, listed.err);
    const reads = (JSON.parse(listed.out) as GateRow[])[0]!.reads!;

    const cut = truncationOf(reads["body"]);
    assert.ok(cut !== undefined, JSON.stringify(reads["body"]).slice(0, 200));
    assert.equal(cut.shown, 128);

    // `note` is 30 characters and 32 bytes of JSON, so a cap of 128 leaves it alone while the
    // 196 KB `body` beside it is cut — which is what says the cap is applied per VALUE and not
    // per row.
    assert.equal(reads["note"], SMALL);

    // AND BELOW BREAK-EVEN IT IS LEFT WHOLE, marker and all. At `--max-bytes 8` a 32-byte
    // `note` is over the cap, but the `$truncated` wrapper that would replace it is ~60 bytes
    // — bigger than the value, and announcing a withholding that saved nothing. A cap whose
    // marker costs more than the value it hides is not a bound.
    const tight = await cli(["gates", runId, "--workspace", w.dir, "--max-bytes", "8"]);
    assert.equal(tight.code, 0, tight.err);
    const tightReads = (JSON.parse(tight.out) as GateRow[])[0]!.reads!;
    assert.equal(tightReads["note"], SMALL, "below break-even the value is left alone");
    assert.equal(truncationOf(tightReads["note"]), undefined);
    assert.ok(!/`note` is/.test(tight.err), `nothing was withheld, so nothing is announced: ${tight.err}`);
    // …while the value that IS worth cutting still is, at the same cap.
    assert.equal(truncationOf(tightReads["body"])?.shown, 8);
  } finally {
    w.dispose();
  }
});

test("A MALFORMED `--max-bytes` IS REFUSED, in both directions that would otherwise be silent", async () => {
  // `boundedCount`'s discipline, kept for the one flag that cannot use it (0 is meaningful
  // here). The two arms are the two that would otherwise change the output with nobody
  // choosing it: a bare flag is `true` and `Number(true)` is a cap of ONE byte; an empty value
  // is `""` and `Number("")` is 0, which would mean "no cap at all" — the flag disregarded in
  // the direction that discloses.
  const w = workspace();
  try {
    const runId = await park(w);
    // `1e30` IS THE THIRD MEMBER OF THE FAMILY AND IT WAS ACCEPTED. `Number.isInteger(1e30)`
    // is `true`, so a mistyped exponent used to print every channel whole AND — because
    // nothing was truncated — print no `! TRUNCATED` line saying so: the flag disregarded in
    // the direction that discloses, which is precisely what the other two refusals exist for.
    for (const bad of ["--max-bytes=", "--max-bytes=abc", "--max-bytes=-5", "--max-bytes=1.5", "--max-bytes=1e30"]) {
      const refused = await cli(["gates", runId, "--workspace", w.dir, bad]);
      assert.notEqual(refused.code, 0, `\`${bad}\` must be refused, not accepted: ${refused.out.slice(0, 200)}`);
      assert.match(refused.err, /E_CONFIG_INVALID: --max-bytes must be a whole number of bytes from 0 to \d+, where 0 means no limit/, refused.err);
    }
    // The bare form, which `parseArgs` turns into `true` rather than a string.
    const bare = await cli(["gates", runId, "--workspace", w.dir, "--max-bytes"]);
    assert.notEqual(bare.code, 0, bare.out.slice(0, 200));
    assert.match(bare.err, /a bare flag with no value/, bare.err);
  } finally {
    w.dispose();
  }
});

test("A PAYLOAD THAT CANNOT BE READ BACK IS A NOTICE, NOT A REFUSAL — and the channel keeps its handle", async () => {
  // THE ARM THAT DEPARTS FROM THE ENGINE ON PURPOSE. `#resolveReads` throws
  // `E_PAYLOAD_UNRESOLVED` and fails the run, correctly — a node handed a handle would succeed
  // on the wrong value. Nothing executes on what `loom gates` prints, and this command's
  // contract is that it answers "is anything waiting on me" even when the content half is
  // unavailable: the same promise the missing-graph and unreadable-`graphs/` arms keep.
  const w = workspace();
  try {
    const runId = await park(w);
    // The store is `join(dataDir, "payloads")` and `dataDir` defaults to `<workspace>/.loom`.
    rmSync(join(w.dir, ".loom", "payloads"), { recursive: true, force: true });

    const listed = await cli(["gates", runId, "--workspace", w.dir, "--max-bytes", "0"]);
    assert.equal(listed.code, 0, `listing must survive an unreadable payload store: ${listed.err}`);
    const rows = JSON.parse(listed.out) as GateRow[];
    assert.equal(rows.length, 1, listed.out);
    const reads = rows[0]!.reads!;

    // KEPT, NOT DROPPED. `undefined` under `reads.body` is indistinguishable from "this gate
    // reads nothing" — this file's own "absence is not zero" trap, one field over.
    assert.ok(handleOf(reads["body"]) !== undefined, `the handle is what is left: ${JSON.stringify(reads["body"])}`);
    assert.match(listed.err, /! CONTENT NOT SHOWN — `body` on node "approve" could not be read back/, listed.err);
    assert.match(listed.err, /E_PAYLOAD_UNRESOLVED|not in this run's payload store/, listed.err);
    assert.ok(!/CONTENT NOT SHOWN/.test(listed.out), "the notice is on stderr");

    // AND THE CHANNELS THAT WERE NEVER EXTERNALISED STILL PRINT. One unreadable payload must
    // not cost the rest of the gate.
    assert.equal(reads["note"], SMALL);
  } finally {
    w.dispose();
  }
});

test("THE DETECTOR SEES ALL OF WHAT IS PRINTED — not the first 8 KiB of a 64 KiB+ document", async () => {
  // §A.51a UNHIDES VALUES THE SWEEP WAS NEVER SIZED FOR, and the docstring's compensating
  // argument — "an undeclared classification is `internal`, the detector backstop" — is only
  // true if the backstop covers what reaches the terminal. `redactPayload`'s default window is
  // 8 KiB PER STRING LEAF; every value resolved here is over `EXTERNALISE_ABOVE_BYTES`. Under
  // the default, a credential at offset ~43,000 of an unclassified channel printed in the
  // clear while an identical one at offset 1,001 was redacted.
  //
  // `--max-bytes 0`, so the assertion is about the SWEEP and not about the cap accidentally
  // cutting the token off the end.
  const w = workspace();
  try {
    const runId = await park(w);
    const listed = await cli(["gates", runId, "--workspace", w.dir, "--max-bytes", "0"]);
    assert.equal(listed.code, 0, listed.err);
    const reads = (JSON.parse(listed.out) as GateRow[])[0]!.reads!;

    // THE PRECONDITION: the token really is past the default window, and the channel really
    // was externalised (otherwise this measures a small inline value and proves nothing).
    const at = LATE.indexOf(AWS_KEY);
    assert.ok(at > 8 * 1024, `the fixture must place the token past the default sweep, got offset ${String(at)}`);
    assert.ok(Buffer.byteLength(LATE, "utf8") > EXTERNALISE_ABOVE_BYTES, "and the channel must be externalised");
    assert.equal(handleOf(reads["haystack"]), undefined, "it must have been resolved, or this measures a handle");

    assert.ok(!listed.out.includes(AWS_KEY), `a credential past the default sweep window reached stdout`);
    assert.match(String(reads["haystack"]), /lorem ipsum/, "and the ordinary prose around it still prints");
  } finally {
    w.dispose();
  }
});
