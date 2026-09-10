/**
 * ONE REDACTION RULE, ASSERTED AT BOTH DOORS THAT USE IT.
 *
 * `cli.ts` had `redactGateRead` and `server/http.ts` had `redactChannels`, and the first one's
 * own docstring said what was wrong with that: *"IT IS A SECOND SPELLING AND THAT IS A SEAM,
 * NOT A DECISION."* Two spellings of a redaction rule fail exactly one way — a classification
 * added later is handled by one door and not the other, silently, on the axis where the
 * non-negotiable says *refusing is always allowed; loosening never is*. `TODO.md` §H.8.
 *
 * WHAT THIS FILE IS SHAPED TO CATCH, and why it is a TABLE. The risk is not that today's four
 * classifications are wrong at one door; it is that TOMORROW'S is only added to one. So the
 * classifications live in `MATRIX`, the graph is generated from it, and every row is driven
 * through both doors in one loop. Adding a classification here is adding a row, and a row is
 * asserted at both doors by construction — which is the property §H.8 asked for, in the only
 * form that cannot be satisfied by remembering to write the second assertion.
 *
 * THE TWO DOORS ARE THE TWO A HUMAN ACTUALLY APPROVES THROUGH:
 *
 *   - `loom gates <runId>`, whose `reads` field is a fresh process's only view of what is
 *     being approved (`TODO.md` §A.43);
 *   - `GET /runs/:id` on the control plane, whose `channels` map is what the browser console
 *     and every API client read.
 *
 * A THIRD ARM IS UNIT-TESTED AND NOT DOOR-TESTED, deliberately, and this is the honest half:
 * an UNDECLARED channel name and a classification word the vocabulary cannot read are both
 * unreachable from a graph `graph/validate.ts` will compile (`GRAPH003_UNKNOWN_CLASSIFICATION`
 * refuses the second outright). They are the fail-closed arms, they are the ones a future
 * change is likeliest to invert, and the shared function is where they can be driven at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { controlPlaneOptions, main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { ControlPlane } from "../../src/server/http.ts";
import { redactChannelValue } from "../../src/security/redact-channels.ts";

/**
 * EVERY CLASSIFICATION THE VOCABULARY HAS, one channel each, plus one channel that declares
 * none. `blanked` is the claim: whether the value a door shows may still be the value.
 */
const MATRIX = [
  { channel: "credential", classification: "secret_ref", value: "sk-live-DO-NOT-DISCLOSE", blanked: true },
  { channel: "person", classification: "pii", value: "ada.lovelace@example.com", blanked: true },
  { channel: "brief", classification: "public", value: "ship the 4.2 release notes", blanked: false },
  { channel: "note", classification: undefined, value: "the migration section needs a second reader", blanked: false },
] as const;

function graphSpec(): unknown {
  const channels: Record<string, unknown> = { written: { type: "object", reduce: "replace" } };
  for (const r of MATRIX) {
    channels[r.channel] = { type: "string", reduce: "replace", ...(r.classification === undefined ? {} : { classification: r.classification }) };
  }
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "two-doors", project: "demo", version: 1 },
    policy: { posture: "out", capabilities: ["fs:write"] },
    channels,
    inputs: MATRIX.map((r) => r.channel),
    outputs: ["written"],
    nodes: [
      // THE GATE IS THE ENTRY NODE, for the reason `gates-show-content.test.ts` records: a
      // `tool` node reading a `secret_ref` channel is floored at posture `in` by `dataFloorOf`
      // and raises its OWN gate first, parking the run one node earlier — on a task where the
      // channels being measured have no value yet. That is how a fixture measures nothing and
      // passes anyway.
      {
        id: "approve",
        type: "human_gate",
        reads: MATRIX.map((r) => r.channel),
        // IT WRITES BACK THE MOST CLASSIFIED CHANNEL IT READS, not the unclassified one:
        // `GRAPH014_SECRET_LAUNDERED` warns about a node that reads a classified channel and
        // writes an unclassified one, and a fixture that trips a real diagnostic teaches a
        // reader to skip the diagnostics.
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
    edges: [{ id: "e1", from: "approve", to: "write", kind: "seq" }],
  };
}

interface Cap {
  code: number;
  out: string;
  err: string;
}

async function cli(argv: string[]): Promise<Cap> {
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

test("EVERY CLASSIFICATION IS TREATED THE SAME WAY BY `loom gates` AND BY `GET /runs/:id`", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-two-doors-"));
  try {
    mkdirSync(join(dir, "graphs"), { recursive: true });
    const graphFile = join(dir, "graphs", "two-doors.json");
    writeFileSync(graphFile, JSON.stringify(graphSpec()));

    const inputs = Object.fromEntries(MATRIX.map((r) => [r.channel, r.value]));
    const started = await cli(["run", graphFile, "--workspace", dir, "--input", JSON.stringify(inputs)]);
    assert.equal(started.code, 0, started.err);
    const submitted = JSON.parse(started.out) as Record<string, unknown>;
    assert.equal(submitted["status"], "awaiting_gate", started.out);
    const runId = String(submitted["runId"]);

    // ── door one: the CLI ────────────────────────────────────────────────────
    const listed = await cli(["gates", runId, "--workspace", dir]);
    assert.equal(listed.code, 0, listed.err);
    const row = (JSON.parse(listed.out) as { nodeId: string; reads?: Record<string, unknown> }[])[0]!;
    assert.equal(row.nodeId, "approve");
    const fromCli = row.reads;
    assert.ok(fromCli !== undefined, `the gate must carry its content: ${listed.out}`);

    // ── door two: the control plane ──────────────────────────────────────────
    const argv = ["serve", "--workspace", dir, "--token", "s3cret"];
    const args = parseArgs(argv);
    const ws = openWorkspace(args);
    const plane = new ControlPlane(controlPlaneOptions(ws, args));
    const { port } = await plane.listen(0, "127.0.0.1");
    let fromHttp: Record<string, unknown>;
    let bodyText: string;
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/runs/${runId}`, {
        headers: { authorization: "Bearer s3cret" },
      });
      bodyText = await res.text();
      assert.equal(res.status, 200, bodyText);
      fromHttp = (JSON.parse(bodyText) as { channels: Record<string, unknown> }).channels;
    } finally {
      await plane.close();
      ws.close();
    }

    // ── one table, both doors ────────────────────────────────────────────────
    for (const r of MATRIX) {
      const viaCli: unknown = fromCli[r.channel];
      const viaHttp: unknown = fromHttp[r.channel];
      assert.deepEqual(
        viaCli,
        viaHttp,
        `\`${r.channel}\` (${r.classification ?? "undeclared classification"}) reads differently at the two doors: ` +
          `CLI ${JSON.stringify(viaCli)} vs HTTP ${JSON.stringify(viaHttp)} — that is §H.8's failure mode exactly`,
      );
      if (r.blanked) {
        assert.notEqual(viaCli, r.value, `\`${r.channel}\` is declared ${String(r.classification)} and must not read back as itself`);
        assert.notEqual(viaHttp, r.value, `\`${r.channel}\` is declared ${String(r.classification)} and must not read back as itself`);
        assert.ok(!listed.out.includes(r.value), `a ${String(r.classification)} value reached CLI stdout: ${listed.out}`);
        assert.ok(!bodyText.includes(r.value), `a ${String(r.classification)} value reached the HTTP body`);
      } else {
        // THE OTHER HALF, AND WITHOUT IT THE TEST IS SATISFIED BY BLANKING EVERYTHING. A
        // redaction that hides the whole map passes every assertion above and reinstates
        // §A.43 — an operator approving a hash — for every ordinary channel.
        assert.equal(viaCli, r.value, `\`${r.channel}\` declares nothing sensitive and must reach the approver whole`);
        assert.equal(viaHttp, r.value, `\`${r.channel}\` declares nothing sensitive and must reach the approver whole`);
      }
    }

    // AND `secret_ref` IS THE BLANK, not merely "something else". `pii` tokenises and
    // `secret_ref` erases, and the two are not interchangeable: a token is a stable handle on
    // one person, a blank is the absence of a value.
    assert.equal(fromCli["credential"], "[secret]", JSON.stringify(fromCli));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE TWO ARMS NO COMPILED GRAPH CAN REACH — both fall closed", () => {
  // A NAME NO SPEC DECLARES. A door that does not hold the graph a run compiled cannot know
  // which of these names is a credential, and `internal` — the detector backstop — IS the
  // leak. This is the arm `graph/validate.ts` makes unreachable from a graph and that a door
  // reaches every time it is handed `undefined` for its channel map.
  assert.equal(redactChannelValue({}, "mystery", "sk-live-DO-NOT-DISCLOSE"), "[secret]");
  assert.equal(redactChannelValue(undefined, "note", "ordinary prose"), "[secret]");

  // A CLASSIFICATION THIS VOCABULARY CANNOT READ. `maxClassification`'s own rule — "a
  // classification this vocabulary cannot read is the most sensitive one there is". Reachable
  // in practice through `ControlPlaneOptions.graphs`, which takes already-compiled `RunGraph`s
  // and re-validates nothing, so a graph compiled by a build older than
  // `GRAPH003_UNKNOWN_CLASSIFICATION` arrives with a word nothing has ever heard.
  const future = { secret: { classification: "confidential" } } as unknown as Parameters<typeof redactChannelValue>[0];
  assert.equal(redactChannelValue(future, "secret", "the thing itself"), "[secret]");

  // `__proto__` IS NOT A LOOKUP. A bare `channels[name]` answers `Object.prototype` for it,
  // whose `classification` is `undefined` — which reads as "declared, unclassified", a name
  // nothing declared treated as safe.
  assert.equal(redactChannelValue({}, "__proto__", "the thing itself"), "[secret]");
  assert.equal(redactChannelValue({}, "constructor", "the thing itself"), "[secret]");

  // AND THE ORDINARY HALF, so "everything is [secret]" cannot pass this test either.
  assert.equal(redactChannelValue({ note: {} }, "note", "ordinary prose"), "ordinary prose");
  assert.equal(redactChannelValue({ note: { classification: "public" } }, "note", "ordinary prose"), "ordinary prose");
});
