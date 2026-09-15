/**
 * A VALUE A NODE WROTE AND A HANDLE THIS DOOR COULD NOT READ BACK PRINTED THE SAME BYTES.
 *
 * `TODO.md` §A.61, which is §A.58(1)'s collision one field over. The MECHANISM was never wrong:
 * `resolveHandles` decides what is a payload handle from `p.external`, the fold's authoritative
 * map, exactly as `journal/payloads.ts` demands — *"NOTHING DECIDES 'IS THIS A HANDLE' BY LOOKING
 * AT IT … sniffing the shape would hand any node that can write a channel the ability to name a
 * payload it never produced"*. The READER's side had no authority to consult. A channel whose
 * value a node wrote as `{"$payload":{digest,bytes}}` is not in `p.external`, is never resolved,
 * and lands in `reads` looking identical to an externalised channel whose `payloads.get` threw.
 *
 * MEASURED ON THIS FIXTURE, before the row carried the answer:
 *
 *     reads.docB  = {"$payload":{"digest":"sha256:9c2df12b…","bytes":69646}}    ← a real handle
 *     reads.mimic = {"$payload":{"digest":"sha256:0000…","bytes":108002}}       ← a node's value
 *     row keys: …,reads,readsTruncated,readsMayBeStale                          ← nothing tells
 *     stderr: ! CONTENT NOT SHOWN — `docB` … could not be read back
 *
 * One is an omission this door made and one is a value the run was given, they are the same shape
 * in the same document, and the only thing that told them apart was a stderr line `jq` never sees
 * — the identical argument that made §A.58(1) a defect.
 *
 * NO KEY INSIDE THE VALUE COULD FIX IT: JSON object keys are arbitrary strings, so every marker a
 * value might carry is one a node can write. `readsResolved` and `readsUnresolved` sit on the ROW,
 * which is the one place a channel value cannot reach.
 *
 * BOTH LISTS AND NOT ONLY THE FAILURES, because a `jq` reader has two questions and one list
 * answers one of them. "This LOOKS like a handle — is it?" is `readsUnresolved`. "This does NOT
 * look like a handle — WAS it?" has no answer from an empty `readsUnresolved`, which reads the
 * same for a gate that read every handle back as for a gate that had none. Their union is the set
 * of channels the fold externalised that this gate reads — and nothing more than that: an
 * unresolved channel prints exactly the handle the journal recorded, and a resolved channel the
 * graph classified prints `[secret]`, so "the values that did not come out of the journal" is a
 * claim neither of them supports.
 *
 * AND THE QUESTION IS ABOUT THE CHANNEL, NOT ABOUT THE VALUE'S SHAPE — in both directions. A
 * `{"$payload":…}` in `reads` is a HANDLE only if `readsUnresolved` names its channel. A payload
 * whose own CONTENT is `$payload`-shaped resolves to that content and is named in `readsResolved`,
 * which is the invariant `THE PAYLOAD WHOSE CONTENT IS ITSELF` test below exists to pin: without
 * it, a `resolveHandles` that skipped a fetched value for looking like a handle left all four of
 * this file's other tests green while the row said the gate read no handles at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXTERNALISE_ABOVE_BYTES } from "../../src/journal/payloads.ts";

const CLI_SRC = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/**
 * Three documents over the externalisation threshold, each with its own marker in the first bytes.
 *
 * The marker is how the test finds one document's payload CELL on disk without recomputing a
 * digest: the cell holds the canonical JSON of the value, so a substring match identifies it. That
 * keeps this test independent of how a digest is derived, which is not its subject.
 */
const DOC_A = `AAAA-MARKER ${"a".repeat(EXTERNALISE_ABOVE_BYTES + 4096)}`;
const DOC_B = `BBBB-MARKER ${"b".repeat(EXTERNALISE_ABOVE_BYTES + 4096)}`;
const DOC_C = `CCCC-MARKER ${"c".repeat(EXTERNALISE_ABOVE_BYTES + 4096)}`;

/**
 * A CHANNEL VALUE THAT IS ITSELF A PAYLOAD HANDLE'S SHAPE — the whole of §A.61.
 *
 * Small, so this door never externalises it and never truncates it: every byte of it is something
 * the run was handed. `bytes` is deliberately unlike anything else in the fixture, so a reader who
 * trusts the shape reports a 108,002-byte value that does not exist, and `digest` is a
 * well-formed `sha256:` + 64 hex so nothing can refuse it for being malformed rather than for
 * being a value.
 */
const MIMIC = { $payload: { digest: `sha256:${"0".repeat(64)}`, bytes: 108_002 } };

/**
 * `readA → readB → readC → approve → finish`.
 *
 * `docA`, `docB` and `docC` are `replace` string channels that are not outputs and are not named
 * by an expression, so `externalisableChannels` takes all three and each leaves the journal. The
 * gate reads `docA`, `docB` and `mimic` and NOT `docC` — which is the bound: a handle the gate does
 * not read is not this operator's business and must appear in neither list.
 *
 * `report` is the declared output, written by a node after the gate, so that the graph has an
 * output writer without making any of the documents one (an output is not externalisable).
 */
const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "payload-provenance", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read"] },
  channels: {
    srcA: { type: "string", reduce: "replace" },
    srcB: { type: "string", reduce: "replace" },
    srcC: { type: "string", reduce: "replace" },
    docA: { type: "string", reduce: "replace" },
    docB: { type: "string", reduce: "replace" },
    docC: { type: "string", reduce: "replace" },
    mimic: { type: "object", reduce: "replace" },
    report: { type: "string", reduce: "replace" },
  },
  inputs: ["srcA", "srcB", "srcC", "mimic"],
  outputs: ["report"],
  nodes: [
    { id: "readA", type: "tool", reads: ["srcA"], writes: ["docA"], tool: { name: "fs.read", version: "1.0", args: { path: "${srcA}" } } },
    { id: "readB", type: "tool", reads: ["srcB"], writes: ["docB"], tool: { name: "fs.read", version: "1.0", args: { path: "${srcB}" } } },
    { id: "readC", type: "tool", reads: ["srcC"], writes: ["docC"], tool: { name: "fs.read", version: "1.0", args: { path: "${srcC}" } } },
    { id: "approve", type: "human_gate", reads: ["docA", "docB", "mimic"], writes: [], humanGate: { ref: "oversight/publish@stable" } },
    { id: "finish", type: "function", reads: [], writes: ["report"], function: { ref: "function/finish@stable" } },
  ],
  edges: [
    { id: "e1", from: "readA", to: "readB", kind: "seq" },
    { id: "e2", from: "readB", to: "readC", kind: "seq" },
    { id: "e3", from: "readC", to: "approve", kind: "seq" },
    { id: "e4", from: "approve", to: "finish", kind: "seq" },
  ],
};

/** THE CONTROL — a gate that reads nothing the journal ever externalised. */
const NO_HANDLE_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "no-handle", project: "demo", version: 1 },
  policy: { posture: "on", capabilities: [] },
  channels: { note: { type: "string", reduce: "replace" }, report: { type: "string", reduce: "replace" } },
  inputs: ["note"],
  outputs: ["report"],
  nodes: [
    { id: "approve", type: "human_gate", reads: ["note"], writes: [], humanGate: { ref: "oversight/publish@stable" } },
    { id: "finish", type: "function", reads: [], writes: ["report"], function: { ref: "function/finish@stable" } },
  ],
  edges: [{ id: "e1", from: "approve", to: "finish", kind: "seq" }],
};

/**
 * TWO EXTERNALISED CHANNELS DECLARED OUT OF ALPHABETICAL ORDER.
 *
 * `readsResolved`, `readsUnresolved` and `readsMayBeStale` are in `observedChannels` order — the
 * gate's DECLARED order — and `reads` is not: `makeStateView` slices over `[...allowed].sort()`, so
 * its keys come out alphabetical. A reader who pairs the row's lists with `reads` by POSITION is
 * wrong, and this graph is what makes the two orders disagree.
 */
const ORDER_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "declared-order", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read"] },
  channels: {
    srcZ: { type: "string", reduce: "replace" },
    srcA: { type: "string", reduce: "replace" },
    zeta: { type: "string", reduce: "replace" },
    alpha: { type: "string", reduce: "replace" },
    report: { type: "string", reduce: "replace" },
  },
  inputs: ["srcZ", "srcA"],
  outputs: ["report"],
  nodes: [
    { id: "readZ", type: "tool", reads: ["srcZ"], writes: ["zeta"], tool: { name: "fs.read", version: "1.0", args: { path: "${srcZ}" } } },
    { id: "readA", type: "tool", reads: ["srcA"], writes: ["alpha"], tool: { name: "fs.read", version: "1.0", args: { path: "${srcA}" } } },
    { id: "approve", type: "human_gate", reads: ["zeta", "alpha"], writes: [], humanGate: { ref: "oversight/publish@stable" } },
    { id: "finish", type: "function", reads: [], writes: ["report"], function: { ref: "function/finish@stable" } },
  ],
  edges: [
    { id: "e1", from: "readZ", to: "readA", kind: "seq" },
    { id: "e2", from: "readA", to: "approve", kind: "seq" },
    { id: "e3", from: "approve", to: "finish", kind: "seq" },
  ],
};

/**
 * A PAYLOAD WHOSE OWN CONTENT IS `$payload`-SHAPED — the invariant this file exists for, and the
 * one the first draft of it did not pin.
 *
 * `selfish` is a `replace` object channel a node writes as `{"$payload":{…, filler}}`, big enough
 * to be externalised. So the journal holds a REAL handle for it, and reading that handle back
 * yields a value that LOOKS like a handle. The door must resolve it and name it in `readsResolved`
 * anyway, because the decision is `p.external` and never the shape — in either direction.
 *
 * Measured with a `resolveHandles` that skipped a fetched value carrying `$payload`: this file's
 * other four tests all stayed green while the row said `readsResolved: []`, `readsUnresolved: []`
 * and `reads.selfish` was the journal's handle. That is the mechanism §A.61 protects, reported by
 * the row as "this gate read no handles at all".
 */
const CONTENT_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "content-is-a-handle", project: "demo", version: 1 },
  policy: { posture: "on", capabilities: [] },
  channels: {
    selfish: { type: "object", reduce: "replace" },
    report: { type: "string", reduce: "replace" },
  },
  inputs: [],
  outputs: ["report"],
  nodes: [
    { id: "make", type: "function", reads: [], writes: ["selfish"], function: { ref: "function/selfish@stable" } },
    { id: "approve", type: "human_gate", reads: ["selfish"], writes: [], humanGate: { ref: "oversight/publish@stable" } },
    { id: "finish", type: "function", reads: [], writes: ["report"], function: { ref: "function/finish@stable" } },
  ],
  edges: [
    { id: "e1", from: "make", to: "approve", kind: "seq" },
    { id: "e2", from: "approve", to: "finish", kind: "seq" },
  ],
};

/**
 * The content `make` writes. `digest` is deliberately NOT a digest — 71 characters of `sha256:` and
 * 64 hex is what a real handle carries, and this is 12 characters of prose — so the assertion that
 * the CONTENT was printed cannot be satisfied by printing the handle.
 */
const NOT_A_DIGEST = "NOT-A-DIGEST";
const SELFISH_SRC =
  `function (view) { return { writes: { selfish: { $payload: { digest: ${JSON.stringify(NOT_A_DIGEST)}, ` +
  `bytes: 1, filler: "z".repeat(70000) } } } }; }\n`;

interface Cap {
  code: number;
  out: string;
  err: string;
}

/**
 * A CHILD PROCESS, for `gates-reads-resolved.test.ts`'s reason: this fixture prints ~70 KB of
 * document, and a `process.stdout.write` hook that size races the `node --test` runner's own
 * protocol messages into the captured buffer. It is also the command an operator runs.
 */
async function cli(argv: string[]): Promise<Cap> {
  return await new Promise<Cap>((resolve) => {
    execFile(
      process.execPath,
      [CLI_SRC, ...argv],
      { cwd: dirname(CLI_SRC), timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      (e, stdout, stderr) => {
        resolve({ code: e === null ? 0 : ((e as NodeJS.ErrnoException & { code?: number }).code ?? 1), out: stdout, err: stderr });
      },
    );
  });
}

const FINISH = 'function (view) { return { writes: { report: "done" } }; }\n';

function workspace(graph: unknown): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-payload-prov-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  const graphFile = join(dir, "graphs", "g.json");
  writeFileSync(graphFile, JSON.stringify(graph));
  writeFileSync(join(dir, "resources", "function", "finish.js"), FINISH);
  writeFileSync(join(dir, "resources", "function", "selfish.js"), SELFISH_SRC);
  writeFileSync(join(dir, "a.txt"), DOC_A);
  writeFileSync(join(dir, "b.txt"), DOC_B);
  writeFileSync(join(dir, "c.txt"), DOC_C);
  return { dir, graphFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

interface GateRow {
  gateId: string;
  nodeId: string;
  contentDigest: string;
  reads?: Record<string, unknown>;
  readsResolved?: readonly string[];
  readsUnresolved?: readonly string[];
  readsTruncated?: Record<string, { bytes: number; shown: number }>;
  readsMayBeStale?: readonly string[];
}

/**
 * MAKING ONE `payloads.get` FAIL, by removing the cell it reads.
 *
 * `filePayloads` stores each value at `<dataDir>/payloads/<runId>/<digest>.json`, so deleting the
 * cell whose contents carry `marker` is a genuinely unresolvable handle: the journal still names
 * the digest and the store cannot produce the bytes. This is the ordinary operational shape of the
 * failure — a payload directory restored from a backup that does not cover it, a store on a volume
 * that is not mounted — and not a stub of the store.
 */
function deleteCellHolding(dir: string, runId: string, marker: string): string {
  const cells = join(dir, ".loom", "payloads", runId);
  const names = readdirSync(cells);
  assert.ok(names.length >= 2, `the fixture must externalise more than one channel: ${names.join(",")}`);
  const hit = names.filter((n) => readFileSync(join(cells, n), "utf8").includes(marker));
  assert.equal(hit.length, 1, `exactly one cell must hold ${marker}: ${hit.join(",")}`);
  rmSync(join(cells, hit[0]!));
  return hit[0]!;
}

/** `undefined` when the value is not `$payload`-SHAPED. Used to say what a shape-reader would see. */
function looksLikeAHandle(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && Object.hasOwn(v, "$payload") ? (v as Record<string, unknown>) : undefined;
}

async function park(w: { dir: string; graphFile: string }, input: unknown): Promise<string> {
  const started = await cli(["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify(input)]);
  assert.equal(started.code, 0, `${started.out}${started.err}`);
  const p = JSON.parse(started.out) as Record<string, unknown>;
  assert.equal(p["status"], "awaiting_gate", `the fixture must park for this to mean anything: ${started.out}`);
  return String(p["runId"]);
}

const INPUT = { srcA: "a.txt", srcB: "b.txt", srcC: "c.txt", mimic: MIMIC };

test("A NODE-WRITTEN `$payload` AND AN UNREADABLE HANDLE PRINT ALIKE, AND THE ROW TELLS THEM APART", async () => {
  const w = workspace(GRAPH);
  try {
    const runId = await park(w, INPUT);
    deleteCellHolding(w.dir, runId, "BBBB-MARKER");

    // `--max-bytes 0`, so nothing this door prints has been cut: every `$payload` shape below is
    // there because of what the value IS, not because of what this command did to it.
    const listed = await cli(["gates", runId, "--workspace", w.dir, "--max-bytes", "0"]);
    assert.equal(listed.code, 0, listed.err);
    const row = (JSON.parse(listed.out) as GateRow[])[0]!;
    assert.equal(row.nodeId, "approve");
    const reads = row.reads!;

    // THE COLLISION IS REPRODUCED. If either of these ever fails, this file has stopped measuring
    // §A.61 and the assertions below pass on a fixture with nothing to tell apart.
    assert.ok(looksLikeAHandle(reads["docB"]) !== undefined, `\`docB\` must print its handle: ${JSON.stringify(reads["docB"])}`);
    assert.ok(looksLikeAHandle(reads["mimic"]) !== undefined, `the mimic must still LOOK like a handle: ${JSON.stringify(reads["mimic"])}`);

    // AND THE ROW GIVES THEM DIFFERENT ANSWERS, which is what "distinguishable" means here. Named
    // exactly, not counted: a length of 1 would pass on the wrong one.
    assert.deepEqual(row.readsUnresolved, ["docB"], JSON.stringify(row.readsUnresolved));
    assert.deepEqual(row.readsResolved, ["docA"], JSON.stringify(row.readsResolved));
    assert.ok(!row.readsResolved!.includes("mimic"), "a value a node wrote was never a handle and was never resolved");
    assert.ok(!row.readsUnresolved!.includes("mimic"), "…and it is not an unreadable one either — it is not a handle at all");

    // THE MIMIC IS RENDERED BYTE FOR BYTE, not rewritten into something safer. This door prints
    // what the run was given and says separately what it is.
    assert.deepEqual(reads["mimic"], MIMIC, JSON.stringify(reads["mimic"]));

    // A CHANNEL THAT IS BOTH EXTERNALISED AND READ BACK FINE MUST NOT BE CALLED UNRESOLVED — the
    // claim this test would make if it were false, run directly.
    assert.equal(looksLikeAHandle(reads["docA"]), undefined, `\`docA\` resolved and must print its value: ${String(reads["docA"]).slice(0, 80)}`);
    assert.equal(reads["docA"], DOC_A, "the whole document, resolved exactly as `#resolveReads` would resolve it");

    // THE BOUND ON THE OTHER SIDE: `docC` is externalised exactly as `docA` is, and the gate does
    // not read it. Neither list may name it, and it is not in `reads` either — the sets agree.
    assert.ok(!row.readsResolved!.includes("docC"), "a handle the gate does not read is not this operator's business");
    assert.ok(!row.readsUnresolved!.includes("docC"), "…on either list");
    assert.ok(!Object.hasOwn(reads, "docC"), "and `reads` does not carry it");

    // STDERR STILL NAMES THE ONE THAT FAILED, and names only it. A notice naming `mimic` would be
    // a fabricated omission announced out loud.
    assert.match(listed.err, /! CONTENT NOT SHOWN — `docB` on node "approve" could not be read back/, listed.err);
    assert.ok(!/`mimic`/.test(listed.err), `nothing was withheld from \`mimic\`: ${listed.err}`);
    assert.match(listed.err, /`readsUnresolved` names exactly those channels/, "the notice must send the reader to the row, not to the shape");
    // …and the prose is NOT in the document `jq` reads, which is the split every other notice uses.
    assert.ok(!/CONTENT NOT SHOWN/.test(listed.out), "the notice is not on stdout");
  } finally {
    w.dispose();
  }
});

test("THE UNION OF THE TWO LISTS IS WHAT THE FOLD CALLED A HANDLE — and truncation is a separate axis", async () => {
  const w = workspace(GRAPH);
  try {
    const runId = await park(w, INPUT);
    deleteCellHolding(w.dir, runId, "BBBB-MARKER");

    // The DEFAULT cap this time, so `docA` is both resolved and then cut. The two fields answer
    // two different questions about the same channel and must both name it.
    const listed = await cli(["gates", runId, "--workspace", w.dir]);
    assert.equal(listed.code, 0, listed.err);
    const row = (JSON.parse(listed.out) as GateRow[])[0]!;

    assert.deepEqual([...row.readsResolved!, ...row.readsUnresolved!].sort(), ["docA", "docB"], "exactly the channels this gate reads that the journal externalised");
    assert.deepEqual(Object.keys(row.readsTruncated!), ["docA"], `truncation is about the CUT, not about provenance: ${JSON.stringify(row.readsTruncated)}`);
    assert.ok(row.readsResolved!.includes("docA"), "a channel can be resolved AND cut; the two fields are not alternatives");

    // AND THE UNREADABLE HANDLE IS NOT TRUNCATED — the handle is ~110 bytes, so nothing cut it.
    // Without this, "unresolved" and "truncated" could be read as the same claim about a channel.
    assert.equal(row.readsTruncated!["docB"], undefined, "a handle is small; nothing about it was withheld by the cap");
  } finally {
    w.dispose();
  }
});

test("BOTH FIELDS ARE PRESENT AND EMPTY WHEN THE GATE READ NO HANDLE — absence is not zero", async () => {
  // The control, and the reason the fields are not conditional. An OMITTED `readsUnresolved` means
  // only "this binary has no such field", which sends a reader straight back to the value's shape
  // — the thing being closed. `readsTruncated: {}` and `readsMayBeStale: []` already answer this
  // way on the same row.
  const w = workspace(NO_HANDLE_GRAPH);
  try {
    const runId = await park(w, { note: "ship the release notes for 4.2" });
    const listed = await cli(["gates", runId, "--workspace", w.dir]);
    assert.equal(listed.code, 0, listed.err);
    const row = (JSON.parse(listed.out) as GateRow[])[0]!;

    assert.ok(Object.hasOwn(row, "readsResolved"), `the field is the authority, so it is always beside \`reads\`: ${Object.keys(row).join(",")}`);
    assert.ok(Object.hasOwn(row, "readsUnresolved"), `both halves, or the union cannot be computed: ${Object.keys(row).join(",")}`);
    assert.deepEqual(row.readsResolved, [], "nothing here left the journal");
    assert.deepEqual(row.readsUnresolved, [], "…so there is nothing that failed to come back either");
    assert.equal(row.reads?.["note"], "ship the release notes for 4.2", "and the ordinary value is printed as it always was");
    assert.ok(!/CONTENT NOT SHOWN/.test(listed.err), `nothing was withheld, so nothing is announced: ${listed.err}`);
  } finally {
    w.dispose();
  }
});

test("EVERY HANDLE READ BACK IS NAMED — an empty `readsUnresolved` is not the only thing that says so", async () => {
  // THE CASE `readsUnresolved` ALONE CANNOT DESCRIBE, which is why there are two fields. Nothing is
  // deleted here, so both documents resolve and `readsUnresolved` is `[]` — exactly what the
  // control above prints for a gate that had no handles at all. `readsResolved` is the only thing
  // in the document that separates those two runs.
  const w = workspace(GRAPH);
  try {
    const runId = await park(w, INPUT);
    const listed = await cli(["gates", runId, "--workspace", w.dir, "--max-bytes", "0"]);
    assert.equal(listed.code, 0, listed.err);
    const row = (JSON.parse(listed.out) as GateRow[])[0]!;

    assert.deepEqual(row.readsUnresolved, [], "every handle was read back");
    assert.deepEqual(row.readsResolved, ["docA", "docB"], "…and the row says WHICH, in the gate's declared order");
    assert.equal(row.reads?.["docA"], DOC_A);
    assert.equal(row.reads?.["docB"], DOC_B);
    // The mimic is unchanged by any of this: it was never a handle in either run.
    assert.deepEqual(row.reads?.["mimic"], MIMIC);
    assert.ok(!listed.out.includes("$payload") || JSON.stringify(row.reads?.["mimic"]).includes("$payload"), "the only `$payload` in the document is the value a node wrote");
    assert.ok(!/CONTENT NOT SHOWN/.test(listed.err), `everything resolved: ${listed.err}`);
  } finally {
    w.dispose();
  }
});

test("THE PAYLOAD WHOSE CONTENT IS ITSELF `$payload`-SHAPED IS RESOLVED AND NAMED — the shape is not the question in EITHER direction", async () => {
  // THE INVARIANT §A.61 EXISTS FOR, and the one the first draft of this file did not pin. A door
  // that answered "is this a handle" by looking at the FETCHED value — skipping one that carries
  // `$payload` — left every other test here green while the row reported `readsResolved: []`,
  // `readsUnresolved: []` and printed the journal's handle for a channel it had every reason to
  // resolve. That is a row saying "this gate read no handles" about a gate reading one.
  const w = workspace(CONTENT_GRAPH);
  try {
    const runId = await park(w, {});
    const listed = await cli(["gates", runId, "--workspace", w.dir, "--max-bytes", "0"]);
    assert.equal(listed.code, 0, listed.err);
    const row = (JSON.parse(listed.out) as GateRow[])[0]!;
    const value = row.reads!["selfish"] as { $payload?: { digest?: unknown; filler?: unknown } };

    // THE PRECONDITION: the channel really left the journal, so there really is a handle to decide
    // about. Without this the test passes on an inline channel and measures nothing.
    assert.deepEqual(row.readsResolved, ["selfish"], `the handle must be read back and named: ${JSON.stringify(row.readsResolved)}`);
    assert.deepEqual(row.readsUnresolved, [], JSON.stringify(row.readsUnresolved));

    // AND WHAT IS PRINTED IS THE CONTENT, not the handle. The two are told apart by the one field
    // a real handle cannot fake: `sha256:` + 64 hex is 71 characters and this is not that.
    assert.ok(looksLikeAHandle(value) !== undefined, "the content still LOOKS like a handle — that is the fixture");
    assert.equal(value.$payload?.digest, NOT_A_DIGEST, `the HANDLE was printed instead of its content: ${JSON.stringify(value).slice(0, 160)}`);
    assert.notEqual(String(value.$payload?.digest).length, 71, "a real handle's digest is `sha256:` + 64 hex");
    assert.equal(typeof value.$payload?.filler, "string", "the whole content came back, not a two-key summary of it");
    assert.ok(!/CONTENT NOT SHOWN/.test(listed.err), `nothing failed to resolve: ${listed.err}`);
  } finally {
    w.dispose();
  }
});

test("THE LISTS ARE IN DECLARED ORDER AND `reads` IS ALPHABETICAL — pair them by NAME, never by position", async () => {
  // `makeStateView` slices over `[...allowed].sort()` (`state/channels.ts`), so `reads` prints its
  // keys alphabetically; `observedChannels` returns the gate's declared order and that is what
  // `readsResolved`, `readsUnresolved` and `readsMayBeStale` use. An earlier draft of
  // `resolveHandles`'s docstring claimed the two orders agree. They do not, and on a gate declaring
  // `["zeta","alpha"]` they are exactly reversed.
  const w = workspace(ORDER_GRAPH);
  try {
    const runId = await park(w, { srcZ: "c.txt", srcA: "a.txt" });
    const listed = await cli(["gates", runId, "--workspace", w.dir, "--max-bytes", "0"]);
    assert.equal(listed.code, 0, listed.err);
    const row = (JSON.parse(listed.out) as GateRow[])[0]!;

    assert.deepEqual(row.readsResolved, ["zeta", "alpha"], "the gate's DECLARED order");
    assert.deepEqual(Object.keys(row.reads!), ["alpha", "zeta"], "…and `reads` is sorted, which is the disagreement");
    assert.deepEqual(row.readsUnresolved, []);
    // Named rather than positional is the whole point: index 0 of one is index 1 of the other.
    assert.equal(row.reads!["zeta"], DOC_C, "the names still line up with the values; only the ORDER does not");
    assert.equal(row.reads!["alpha"], DOC_A);
  } finally {
    w.dispose();
  }
});

test("AND BOTH FIELDS ARE ABSENT — not empty — ON A ROW THAT PRINTS NO `reads` AT ALL", async () => {
  // D3's other half. `readsResolved: []` is a statement — "this gate read no payload handle" — and
  // there is nothing for it to say about a row this door never opened a graph for. The three arms
  // that return a gate unchanged (an unresolvable graph, a MIRROR, a node or task neither the graph
  // nor the journal carries) each say on stderr why they print nothing; the row stays as the engine
  // built it. Driven through the first of them, by deleting the graph the run compiled.
  const w = workspace(GRAPH);
  try {
    const runId = await park(w, INPUT);
    rmSync(w.graphFile);
    const listed = await cli(["gates", runId, "--workspace", w.dir]);
    assert.equal(listed.code, 0, listed.err);
    const row = (JSON.parse(listed.out) as GateRow[])[0]!;

    assert.ok(!Object.hasOwn(row, "reads"), `the premise: this row prints no reads: ${Object.keys(row).join(",")}`);
    for (const f of ["readsResolved", "readsUnresolved", "readsTruncated", "readsMayBeStale"]) {
      assert.ok(!Object.hasOwn(row, f), `${f} is a claim about values this row does not carry: ${Object.keys(row).join(",")}`);
    }
    // …and the row is still a gate an operator can act on, which is why this arm returns it at all.
    assert.match(row.contentDigest, /\S/);
    assert.match(listed.err, /! CONTENT NOT SHOWN — 1 open gate\(s\) below print no `reads`/, listed.err);
  } finally {
    w.dispose();
  }
});
