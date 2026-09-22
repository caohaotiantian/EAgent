/**
 * `examples/graphs/grant-access.json` — the THIRD ported workflow, driven the way its doc says.
 *
 * `examples-run.test.ts` already COMPILES every graph in `examples/graphs/` and checks that every
 * published resource is named by one; `examples-triage.test.ts` and `examples-harden.test.ts` do
 * for the first two ports what this file does for the third. `docs/workflow-port-2026-09-22b.md`
 * promises a list of things and each is a test below. A doc nobody re-runs rots into a promise.
 *
 * WHAT IS WORTH PINNING HERE IS DIFFERENT FROM EITHER EARLIER PORT, because the shape is. The
 * first port's risk is branch ORDER under a fan-out; the second's is CONVERGENCE of a loop. This
 * graph has neither. Its risk is that CONTROL WENT THE WRONG WAY — and a graph that routed wrong
 * still exits 0, still writes a grant, and still looks exactly like one that routed right:
 *
 *  - **Which arm ran, read off `loom trace` and not off the outcome.** `prior` and `first-grant`
 *    are the `seq` and `error` targets of one node; exactly one must appear, and the OTHER must
 *    be absent. A run that took both, or that took the success arm on a missing file, would still
 *    produce a grant — with a history it had no right to.
 *  - **The router's two cases and its `fallbackEdge`** — three destinations, but TWO `cases[]`
 *    entries and one fallback, which is not the same thing and was called "three arms" here once.
 *    Each is pinned to the node it must reach: `deny` firing when `record` should have, or the
 *    reverse, is the whole failure mode, because one of those two nodes grants production access
 *    and the other refuses it.
 *  - **The gate is the only thing between a decision and the disk.** Nothing is on disk while the
 *    run is parked, and both files appear on approval.
 *  - **The ledger ROUND-TRIPS.** Run one writes it, run two reads it and renews off it. This is
 *    the only end-to-end check that `grant-record.js`'s output is something `grant-prior.js` can
 *    read back — the two bodies cannot import each other and agree on a shape by convention only.
 *  - **The policy lives in the FIXTURE, not in the bodies.** `maxHours.write` is edited down in
 *    the workspace copy alone and the denial is required to follow it. A body holding its own
 *    constant fails this. Same drift test the first port's `maxWidth` one is.
 *  - **THE THREE BOUNDS ON A RENEWAL, one test each, each with a control.** A renewal skips the
 *    person, so every bound is the difference between "a human said yes to this" and "a human
 *    said yes to something else". They are at the foot of this file and they are the reason it
 *    grew: the first version of this suite was 16/16 GREEN with either of the two bounds that
 *    existed then DELETED, because the only renewal it exercised was a minutes-old, same-level,
 *    same-hours repeat — a fixture that satisfies every guard at once and distinguishes none.
 *  - **F5's DEFENCE, in both directions.** A ledger that cannot be READ but can be WRITTEN must be
 *    REFUSED (it used to be silently replaced), and the ordinary first run — where there really is
 *    no ledger — must still proceed. A defence that fired on the second would be worse than none.
 *
 * Offline by construction: no `agent` node, so no adapter is registered, no key is read, and no
 * network call is possible. Nothing here asserts on a duration or on a ratio of two; the tests
 * that need an aged history SEED it with explicit timestamps rather than waiting for a clock.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.ts";
import { isLoomError, toLoomError } from "../src/errors.ts";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const GRAPH = "graphs/grant-access.json";

const GRANT = join("out", "grant.json");
const LEDGER = join("out", "access-ledger.json");

/** `--input` for one of the shipped requests. */
function input(request: string): string {
  return JSON.stringify({ requestPath: `access/requests/${request}` });
}

/**
 * A throwaway copy of the workspace, `access/` included.
 *
 * `examples-run.test.ts` copies `graphs/` and `resources/` only, which is right for it and wrong
 * here: `access/` is this workflow's INPUT. The copy is thrown away because running writes
 * `.loom/journal.db`, `out/grant.json` and `out/access-ledger.json` — and the ledger is READ at
 * the start of every run, so a previous test's leftovers would decide the next test's ceremony.
 * That is not hypothetical: every renewal assertion below is exactly a claim about what the
 * ledger held when the run started.
 */
function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-grant-"));
  for (const sub of ["graphs", "resources", "access"]) {
    cpSync(join(EXAMPLES, sub), join(dir, sub), { recursive: true });
  }
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/**
 * `bin/loom <argv> --workspace <dir>`, in-process, with the streams captured.
 *
 * STRINGS ARE OURS, BUFFERS ARE THE TEST RUNNER'S, and that distinction is load-bearing rather
 * than decorative — `examples-harden.test.ts`'s copy of this helper carries the measurement that
 * established it: `node --test` serialises its own event stream to `process.stdout` as Buffers,
 * from this same process, so hijacking `write` unconditionally swallows the runner's events for
 * every test that flushes inside the window. The CLI writes strings and only strings, so forward
 * anything that is not a string and capture the rest.
 *
 * The alternative — hand `main()` an injected stream instead of hijacking the global — is the
 * right fix and is not available from here: `main(argv, fetchImpl?)` takes no streams, and adding
 * a parameter is a change under `packages/core/src`, which this port is explicitly not allowed to
 * make. Recorded so the next person does not have to rediscover why.
 */
async function loom(dir: string, argv: readonly string[]): Promise<Result> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown, ...rest: unknown[]) =>
    typeof c === "string"
      ? (out.push(c), true)
      : (realOut as (...a: unknown[]) => boolean)(c, ...rest)) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown, ...rest: unknown[]) =>
    typeof c === "string"
      ? (errOut.push(c), true)
      : (realErr as (...a: unknown[]) => boolean)(c, ...rest)) as typeof process.stderr.write;
  try {
    const code = await main([...argv, "--workspace", dir]);
    return { code, out: out.join(""), err: errOut.join("") };
  } catch (e) {
    const le = isLoomError(e) ? e : toLoomError(e);
    return { code: 1, out: out.join(""), err: `${errOut.join("")}${le.code}: ${le.message}\n` };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/**
 * The JSON object `loom run` prints — which is the WHOLE of stdout, and asserted as such.
 *
 * Parsing the whole capture rather than slicing it is the assertion that nothing else reaches
 * stdout, which is what makes `loom run … 2>/dev/null | jq .status` work on the gate path. That
 * was friction F4 of the FIRST port, closed at `175cdb3`; this graph parks on a gate too, so it
 * is the same promise and it is re-asserted here rather than assumed.
 */
function summary(r: Result): Record<string, unknown> {
  try {
    return JSON.parse(r.out) as Record<string, unknown>;
  } catch (e) {
    assert.fail(`stdout is not one JSON object (${String(e)}):\n${r.out}${r.err}`);
  }
}

interface Decision {
  readonly requestId: string;
  readonly who: string;
  readonly resource: string;
  readonly level: string;
  readonly hours: number;
  readonly tier: string | null;
  readonly owners: readonly string[];
  readonly cap: number | null;
  readonly ceremony: string;
  readonly why: string;
  readonly historySource: string;
  readonly renewalOf: { at: number; level: string } | null;
  readonly priorGrants: readonly { at: number; level: string }[];
}

interface Grant {
  readonly requestId: string;
  readonly who: string;
  readonly resource: string;
  readonly level: string;
  readonly hours: number;
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly ceremony: string;
  readonly decidedBy: string;
  readonly renewalOf: number | null;
}

/** How many times each node ran, read out of the span tree `loom trace` prints. */
async function taskCounts(dir: string, runId: string): Promise<Record<string, number>> {
  const t = await loom(dir, ["trace", runId]);
  assert.equal(t.code, 0, `${t.out}${t.err}`);
  const counts: Record<string, number> = {};
  for (const line of t.out.split("\n")) {
    const m = /^\s*loom\.task (\S+) /.exec(line);
    if (m === null) continue;
    counts[m[1]!] = (counts[m[1]!] ?? 0) + 1;
  }
  return counts;
}

/** Run one request to whatever it reaches, and hand back the raw result and the parsed stdout. */
async function run(dir: string, request: string): Promise<{ r: Result; s: Record<string, unknown> }> {
  const r = await loom(dir, ["run", join(dir, GRAPH), "--input", input(request)]);
  return { r, s: summary(r) };
}

function outputs(s: Record<string, unknown>): Record<string, unknown> {
  return (s["outputs"] ?? {}) as Record<string, unknown>;
}

function errorOf(s: Record<string, unknown>): { code?: string; class?: string; message?: string } {
  return (s["error"] ?? {}) as { code?: string; class?: string; message?: string };
}

// ── the review arm, which is the one a person has to answer ───────────────────

test("a restricted-tier write parks on the gate, and NEITHER file is on disk yet", async () => {
  const ws = workspace();
  try {
    const { r, s } = await run(ws.dir, "orders-db-backfill.json");
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.equal(s["status"], "awaiting_gate", `${r.out}${r.err}`);

    // The line telling a human how to answer the gate is on STDERR, beside the run-id hint.
    assert.match(r.err, /^gate gate_\S+ on node sign — loom approve \S+ gate_\S+ --as YOUR_ID$/m, r.err);

    // THE WHOLE POINT OF THE GATE. Both `fs.write` nodes are behind `record`, which is behind
    // `sign` on this arm — so a run parked here has dispatched neither. Not "wrote them and will
    // roll back": nothing has happened.
    assert.equal(existsSync(join(ws.dir, GRANT)), false, "no grant is written before a human answers");
    assert.equal(existsSync(join(ws.dir, LEDGER)), false, "and the ledger is not touched either");
  } finally {
    ws.dispose();
  }
});

test("the gate SHOWS the decision — the rule, the owners, the cap and the prior grants", async () => {
  const ws = workspace();
  try {
    const { s } = await run(ws.dir, "orders-db-backfill.json");
    const runId = String(s["runId"]);

    const listed = await loom(ws.dir, ["gates", runId]);
    assert.equal(listed.code, 0, `${listed.out}${listed.err}`);
    const gates = JSON.parse(listed.out) as {
      nodeId: string;
      state: string;
      approvers: string[];
      reads?: Record<string, unknown>;
      readsTruncated?: Record<string, unknown>;
      readsMayBeStale?: string[];
    }[];
    assert.equal(gates.length, 1, `expected exactly one open gate, got ${listed.out}`);
    const gate = gates[0]!;
    assert.equal(gate.nodeId, "sign");
    assert.equal(gate.state, "open");
    assert.deepEqual([...gate.approvers], ["u:you"]);

    // WHAT THE APPROVER IS BEING SHOWN, read off the CLI and not out of the run's own outputs.
    assert.deepEqual(Object.keys(gate.reads ?? {}), ["decision"], JSON.stringify(gate.reads));
    const d = (gate.reads ?? {})["decision"] as unknown as Decision;

    assert.equal(d.ceremony, "review");
    assert.equal(d.tier, "restricted");
    assert.equal(d.cap, 24);
    assert.deepEqual([...d.owners], ["u:ravi", "u:mina"]);
    // A PERSON CANNOT DECIDE WITHOUT THESE TWO. `why` is the rule that sent it here; the fact
    // that this gate names a rule at all is what separates it from a gate that says "approve?".
    assert.match(d.why, /restricted-tier/);
    assert.match(d.why, /which no rule grants without a person/);
    // THE FIRST RUN HAS NO LEDGER, so the history is the error arm's. "No prior grants" and
    // "we never found the ledger" are different facts and the gate must not merge them.
    assert.equal(d.historySource, "none");
    assert.deepEqual([...d.priorGrants], []);
    assert.equal(d.renewalOf, null);

    // Neither door is open on this gate — it sits after no fan-out and the decision is small.
    assert.deepEqual(gate.readsTruncated ?? {}, {});
    assert.deepEqual([...(gate.readsMayBeStale ?? [])], []);
  } finally {
    ws.dispose();
  }
});

test("the approval writes BOTH files, and the grant is the request the policy allowed", async () => {
  const ws = workspace();
  try {
    const { s } = await run(ws.dir, "orders-db-backfill.json");
    const runId = String(s["runId"]);
    const listed = await loom(ws.dir, ["gates", runId]);
    const gateId = String((JSON.parse(listed.out) as { gateId: string }[])[0]!.gateId);

    const approved = await loom(ws.dir, ["approve", runId, gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);
    const done = JSON.parse(approved.out) as Record<string, unknown>;
    assert.equal(done["status"], "succeeded");

    const grant = JSON.parse(readFileSync(join(ws.dir, GRANT), "utf8")) as Grant;
    assert.equal(grant.requestId, "REQ-1041");
    assert.equal(grant.who, "u:dana");
    assert.equal(grant.resource, "orders-db");
    assert.equal(grant.level, "write");
    assert.equal(grant.hours, 4);
    assert.equal(grant.ceremony, "review");
    assert.equal(grant.renewalOf, null);
    // THE EXPIRY IS DERIVED FROM `hours`, not restated. A grant whose expiry did not follow the
    // hours asked for is a grant that outlives what a person approved.
    assert.equal(grant.expiresAt - grant.grantedAt, 4 * 3_600_000);

    // `decidedBy` NAMES THE MECHANISM AND NOT THE PERSON, deliberately: a body sees neither the
    // approver's subject nor the gate's decision, and writing "approved by u:you" here would be
    // the document asserting something this code did not establish.
    assert.match(grant.decidedBy, /a person, at the "sign" gate/);
    assert.doesNotMatch(grant.decidedBy, /u:you/);

    const ledger = JSON.parse(readFileSync(join(ws.dir, LEDGER), "utf8")) as {
      version: number;
      grants: Grant[];
    };
    assert.equal(ledger.version, 1);
    assert.equal(ledger.grants.length, 1);
    assert.equal(ledger.grants[0]!.requestId, "REQ-1041");
  } finally {
    ws.dispose();
  }
});

// ── which arm ran, which is the thing the outcome cannot tell you ─────────────

test("the FIRST run takes the error arm and the second takes the seq arm — exactly one each", async () => {
  const ws = workspace();
  try {
    // Run one: no ledger on disk. `read-ledger` FAILS and `first-grant` handles it.
    const first = await run(ws.dir, "docs-site-read.json");
    assert.equal(first.s["status"], "succeeded", `${first.r.out}${first.r.err}`);
    const firstCounts = await taskCounts(ws.dir, String(first.s["runId"]));

    // BOTH HALVES. A graph that ran `prior` as well would still produce a grant, off a history
    // two nodes disagreed about — `merge_object` would quietly keep one of them.
    assert.equal(firstCounts["first-grant"], 1, JSON.stringify(firstCounts));
    assert.equal(firstCounts["prior"], undefined, `the seq arm must not run when the read failed: ${JSON.stringify(firstCounts)}`);
    assert.equal((outputs(first.s)["decision"] as Decision).historySource, "none");

    // Run two: the ledger the first run wrote is now on disk.
    const second = await run(ws.dir, "docs-site-read.json");
    assert.equal(second.s["status"], "succeeded", `${second.r.out}${second.r.err}`);
    const secondCounts = await taskCounts(ws.dir, String(second.s["runId"]));
    assert.equal(secondCounts["prior"], 1, JSON.stringify(secondCounts));
    assert.equal(secondCounts["first-grant"], undefined, `the error arm must not run when the read succeeded: ${JSON.stringify(secondCounts)}`);
    assert.equal((outputs(second.s)["decision"] as Decision).historySource, "ledger");
  } finally {
    ws.dispose();
  }
});

test("the ledger ROUND-TRIPS: what run one wrote, run two reads back and renews off", async () => {
  const ws = workspace();
  try {
    // SOMEBODY ELSE'S GRANT FIRST, and it is not decoration. `grant-prior.js` hands `weigh` a
    // FILTERED history — this requester on this resource — and hands `record` the WHOLE ledger,
    // and the two are the same list whenever only one person has ever asked. A suite that never
    // puts a second person in the ledger cannot tell the two apart: measured, by mutating
    // `grant-record.js` to append to the filtered list, which published a ledger holding one
    // person's grants and nobody else's AND passed all sixteen tests here.
    const other = await run(ws.dir, "docs-site-read.json");
    assert.equal(other.s["status"], "succeeded", `${other.r.out}${other.r.err}`);

    // A signed grant next, so the renewal has something with a ceremony to renew.
    const first = await run(ws.dir, "orders-db-backfill.json");
    const runId = String(first.s["runId"]);
    const listed = await loom(ws.dir, ["gates", runId]);
    const gateId = String((JSON.parse(listed.out) as { gateId: string }[])[0]!.gateId);
    const approved = await loom(ws.dir, ["approve", runId, gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);
    const signed = JSON.parse(readFileSync(join(ws.dir, GRANT), "utf8")) as Grant;

    // The same request again. It must NOT reach a gate this time.
    const second = await run(ws.dir, "orders-db-backfill.json");
    assert.equal(second.r.code, 0, `${second.r.out}${second.r.err}`);
    assert.equal(second.s["status"], "succeeded", "a renewal needs no person, so there is no gate to park on");

    const d = outputs(second.s)["decision"] as Decision;
    assert.equal(d.ceremony, "auto");
    assert.equal(d.historySource, "ledger");
    // THE RENEWAL POINTS AT THE GRANT THE HUMAN SIGNED, by its timestamp. This is the assertion
    // that the ledger is a record and not a decoration: `grant-prior.js` parsed what
    // `grant-record.js` wrote, matched it to this requester and this resource, and found it
    // inside the policy's window. Nothing else in this suite crosses those two bodies.
    assert.notEqual(d.renewalOf, null);
    assert.equal(d.renewalOf!.at, signed.grantedAt);
    // ONE prior grant, although the ledger holds two: the history `weigh` decides on is filtered
    // to this requester and this resource, so u:sam's docs-site grant must not appear here.
    assert.equal(d.priorGrants.length, 1);
    assert.match(d.why, /a person granted u:dana write\/4h on orders-db/);
    assert.match(d.why, /inside the policy's 720-hour window/);
    assert.match(d.why, /this asks for write\/4h, which is no wider/);

    const renewed = JSON.parse(readFileSync(join(ws.dir, GRANT), "utf8")) as Grant;
    assert.equal(renewed.ceremony, "auto");
    assert.equal(renewed.renewalOf, signed.grantedAt);
    assert.match(renewed.decidedBy, /as a renewal of an existing grant/);

    // APPEND, NEVER REPLACE, AND APPEND TO THE WHOLE LEDGER. Every run rebuilds the entire
    // document, so this asserts both that earlier entries were carried forward AND that the list
    // carried forward was everybody's — u:sam's grant is the one a filtered append would drop.
    const ledger = JSON.parse(readFileSync(join(ws.dir, LEDGER), "utf8")) as { grants: Grant[] };
    assert.equal(ledger.grants.length, 3);
    assert.deepEqual(ledger.grants.map((g) => g.who), ["u:sam", "u:dana", "u:dana"]);
    assert.deepEqual(ledger.grants.map((g) => g.ceremony), ["auto", "review", "auto"]);
  } finally {
    ws.dispose();
  }
});

// ── the router's arms, each pinned to the node it must reach ──────────────────

test("a public-tier read is granted with no person, and names the rule that did it", async () => {
  const ws = workspace();
  try {
    const { r, s } = await run(ws.dir, "docs-site-read.json");
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.equal(s["status"], "succeeded");
    const counts = await taskCounts(ws.dir, String(s["runId"]));
    // THE GATE WAS NOT REACHED AT ALL — not "was reached and auto-answered".
    assert.equal(counts["sign"], undefined, JSON.stringify(counts));
    assert.equal(counts["deny"], undefined, JSON.stringify(counts));
    assert.equal(counts["record"], 1, JSON.stringify(counts));

    const d = outputs(s)["decision"] as Decision;
    assert.equal(d.ceremony, "auto");
    assert.equal(d.renewalOf, null, "this is the public-read rule, not a renewal — they are different arms of `auto`");
    assert.equal(d.why, "docs-site is public-tier and this asks only to read it");
  } finally {
    ws.dispose();
  }
});

test("public tier is not a free pass — admin on the same resource still needs a person", async () => {
  const ws = workspace();
  try {
    const { r, s } = await run(ws.dir, "docs-site-admin.json");
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    // THE PAIR IS THE POINT. `docs-site-read` and `docs-site-admin` differ in one field and go to
    // different arms, which is the assertion that the ceremony is read off BOTH the tier and the
    // level rather than off the tier alone.
    assert.equal(s["status"], "awaiting_gate");
    const counts = await taskCounts(ws.dir, String(s["runId"]));
    assert.equal(counts["sign"], 1, JSON.stringify(counts));
    assert.equal(counts["record"], undefined, JSON.stringify(counts));
  } finally {
    ws.dispose();
  }
});

test("the router's FALLBACK reaches `deny`, and every denial names the rule that said no", async () => {
  const ws = workspace();
  try {
    // Four denials, four different rules. A count would pass on four copies of one rule.
    const cases: readonly (readonly [string, RegExp])[] = [
      ["payments-kms-admin.json", /admin on a secret-tier resource is never granted/],
      ["orders-db-too-long.json", /96h of write exceeds this policy's 24h ceiling/],
      ["unknown-resource.json", /"billing-cache" is not a resource this policy knows/],
      ["bad-level.json", /"superuser" is not an access level this policy declares/],
    ];
    for (const [request, rule] of cases) {
      const { r, s } = await run(ws.dir, request);
      assert.equal(r.code, 1, `${request} must exit 1: ${r.out}${r.err}`);
      assert.equal(s["status"], "failed", request);
      const e = errorOf(s);
      // `validation`/`E_FUNCTION_REFUSED` is "the graph declined", not the `internal`/`E_INTERNAL`
      // a crash in the body would wear.
      assert.equal(e.class, "validation", request);
      assert.equal(e.code, "E_FUNCTION_REFUSED", request);
      assert.match(String(e.message), /on node "deny" refused/, request);
      assert.match(String(e.message), rule, request);
      assert.match(String(e.message), /Nothing was written and no grant exists\./, request);

      // A DENIAL LEAVES NOTHING BEHIND. `deny` is a terminal refusal, so neither write node is
      // downstream of it — but the check is worth having, because "the run failed" and "the run
      // failed after granting access" are the same exit code.
      assert.equal(existsSync(join(ws.dir, GRANT)), false, `${request} must not write a grant`);
      assert.equal(existsSync(join(ws.dir, LEDGER)), false, `${request} must not touch the ledger`);

      const counts = await taskCounts(ws.dir, String(s["runId"]));
      assert.equal(counts["deny"], 1, `${request}: ${JSON.stringify(counts)}`);
      assert.equal(counts["record"], undefined, `${request}: ${JSON.stringify(counts)}`);
      assert.equal(counts["sign"], undefined, `${request}: ${JSON.stringify(counts)}`);
    }
  } finally {
    ws.dispose();
  }
});

test("a document this graph cannot READ is a refusal at `weigh`, not a denial at `deny`", async () => {
  const ws = workspace();
  try {
    // THE SPLIT THIS WORKFLOW IS BUILT ON. "We decided, and the answer is no" and "we could not
    // decide" are different sentences to a requester, and answering the second with the first
    // tells somebody their access was refused on the merits when nobody looked.
    const cases: readonly (readonly [string, RegExp])[] = [
      ["not-a-request.txt", /the request is not JSON/],
      ["no-level.json", /the request declares no usable `level`/],
    ];
    for (const [request, rule] of cases) {
      const { r, s } = await run(ws.dir, request);
      assert.equal(r.code, 1, `${request}: ${r.out}${r.err}`);
      const e = errorOf(s);
      assert.equal(e.class, "validation", request);
      assert.equal(e.code, "E_FUNCTION_REFUSED", request);
      assert.match(String(e.message), /on node "weigh" refused/, request);
      assert.match(String(e.message), rule, request);
      const counts = await taskCounts(ws.dir, String(s["runId"]));
      assert.equal(counts["route"], undefined, `${request} must not reach the router at all: ${JSON.stringify(counts)}`);
    }
  } finally {
    ws.dispose();
  }
});

// ── the policy is the FIXTURE, not a constant in a body ───────────────────────

test("the cap lives in access/policy.json — edit it and the denial follows", async () => {
  const ws = workspace();
  try {
    // 4h of write is APPROVED above under a 24h cap. Drop the cap below it in the workspace copy
    // alone and the same request must be denied, naming the NEW number. A body holding its own
    // constant passes the first half of this test and fails the second.
    const path = join(ws.dir, "access", "policy.json");
    const policy = JSON.parse(readFileSync(path, "utf8")) as { maxHours: Record<string, number> };
    assert.equal(policy.maxHours["write"], 24, "the shipped cap, so a drift here is loud");
    policy.maxHours["write"] = 2;
    writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`);

    const { r, s } = await run(ws.dir, "orders-db-backfill.json");
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    assert.match(String(errorOf(s).message), /4h of write exceeds this policy's 2h ceiling for write access/);
  } finally {
    ws.dispose();
  }
});

test("the renewal window lives there too — shrink it and the SAME request needs a person again", async () => {
  const ws = workspace();
  try {
    // Establish the grant that the renewal would otherwise match: same person, same resource,
    // same level. `orders-db` is restricted, so a renewal is the ONLY thing that can skip the
    // gate here — which is what makes this a test of the window and not of the public-read rule.
    const first = await run(ws.dir, "orders-db-backfill.json");
    const runId = String(first.s["runId"]);
    const listed = await loom(ws.dir, ["gates", runId]);
    const gateId = String((JSON.parse(listed.out) as { gateId: string }[])[0]!.gateId);
    assert.equal((await loom(ws.dir, ["approve", runId, gateId, "--as", "u:you"])).code, 0);

    // CONTROL FIRST: with the shipped window the same request renews and parks on nothing. Without
    // this half the test would pass against a graph that never renews at all.
    const control = await run(ws.dir, "orders-db-backfill.json");
    assert.equal(control.s["status"], "succeeded", `${control.r.out}${control.r.err}`);
    assert.equal((outputs(control.s)["decision"] as Decision).ceremony, "auto");

    // Now shrink the window in the workspace copy alone. Zero hours means no prior grant can be
    // inside it, so the very same request must go back to a person.
    const path = join(ws.dir, "access", "policy.json");
    const policy = JSON.parse(readFileSync(path, "utf8")) as { renewalWithinHours: number };
    assert.equal(policy.renewalWithinHours, 720, "the shipped window, so a drift here is loud");
    policy.renewalWithinHours = 0;
    writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`);

    const third = await run(ws.dir, "orders-db-backfill.json");
    assert.equal(third.s["status"], "awaiting_gate", `a request with no usable history needs a person: ${third.r.out}${third.r.err}`);
    const counts = await taskCounts(ws.dir, String(third.s["runId"]));
    assert.equal(counts["sign"], 1, JSON.stringify(counts));
  } finally {
    ws.dispose();
  }
});

// ── replay, which is what makes the record worth keeping ──────────────────────

test("a run whose fs.read FAILED still replays hermetically", async () => {
  const ws = workspace();
  try {
    const { s } = await run(ws.dir, "docs-site-read.json");
    const runId = String(s["runId"]);

    // THE POINT: the `fs.read` that failed is served from the journal on replay rather than
    // re-executed against a filesystem that now HAS the ledger the first run wrote. A recorded
    // failure is evidence like any other, and a replay that re-ran the read would take the other
    // arm and diverge.
    const replayed = await loom(ws.dir, ["replay", runId]);
    assert.equal(replayed.code, 0, `${replayed.out}${replayed.err}`);
    assert.deepEqual(JSON.parse(replayed.out), { match: true, hermetic: true });

    const audited = await loom(ws.dir, ["audit", runId]);
    assert.equal(audited.code, 0, `${audited.out}${audited.err}`);
    assert.match(audited.out, /^ok — \d+ rule\(s\) checked, \d+ skipped$/m, audited.out);
  } finally {
    ws.dispose();
  }
});

test("the approved run replays hermetically too — the human's answer is served from the journal", async () => {
  const ws = workspace();
  try {
    const { s } = await run(ws.dir, "orders-db-backfill.json");
    const runId = String(s["runId"]);
    const listed = await loom(ws.dir, ["gates", runId]);
    const gateId = String((JSON.parse(listed.out) as { gateId: string }[])[0]!.gateId);
    await loom(ws.dir, ["approve", runId, gateId, "--as", "u:you"]);

    const replayed = await loom(ws.dir, ["replay", runId]);
    assert.equal(replayed.code, 0, `${replayed.out}${replayed.err}`);
    assert.deepEqual(JSON.parse(replayed.out), { match: true, hermetic: true });
  } finally {
    ws.dispose();
  }
});

// ── every diagnostic the shipped compiler prints on this graph ────────────────

test("the compiler prints NOTHING on this graph — no error, no warning", async () => {
  const ws = workspace();
  try {
    const c = await loom(ws.dir, ["compile", join(ws.dir, GRAPH)]);
    assert.equal(c.code, 0, `${c.out}${c.err}`);

    // ASSERTED AS AN EMPTY SET RATHER THAN AS A COUNT, so that a compiler change which starts
    // warning about this graph fails here and is read rather than absorbed. Both earlier ports
    // ship graphs that warn — the first port's does not, the second's prints three — so "a
    // shipped example warns" is not itself the signal; the signal is a CHANGE.
    const diagnostics = c.err.split("\n").filter((l) => /^[!✗] /.test(l));
    assert.deepEqual(diagnostics, [], `expected no diagnostic:\n${c.err}`);

    // `ok`, then one deadline line per node that can time out. `router` and `human_gate` run no
    // body that could, so the eleven are the thirteen nodes minus `route` and `sign`.
    assert.match(c.out, /^ok$/m, c.out);
    const deadlines = c.out.split("\n").filter((l) => /^\s+deadline /.test(l));
    assert.equal(deadlines.length, 11, c.out);
    assert.equal(deadlines.filter((l) => / route | sign /.test(l)).length, 0, c.out);
  } finally {
    ws.dispose();
  }
});

// ── the defence F5 cost, and the product behaviour behind it ──────────────────

test("F5's DEFENCE — a ledger that cannot be READ but CAN be written is REFUSED, not replaced", async () => {
  const ws = workspace();
  try {
    // Establish a ledger holding somebody's grant.
    const first = await run(ws.dir, "docs-site-read.json");
    assert.equal(first.s["status"], "succeeded", `${first.r.out}${first.r.err}`);
    const before = JSON.parse(readFileSync(join(ws.dir, LEDGER), "utf8")) as { grants: Grant[] };
    assert.deepEqual(before.grants.map((g) => g.who), ["u:sam"]);

    // Write-only. `read-ledger` fails and the error arm CANNOT SEE WHY, so `first-grant` still
    // reports "there is no ledger yet" — which is false. The DEFENCE is `look`: `fs.glob` lists a
    // file `fs.read` cannot open, so `weigh` has a second opinion the arm does not.
    chmodSync(join(ws.dir, LEDGER), 0o222);
    let second: { r: Result; s: Record<string, unknown> };
    try {
      second = await run(ws.dir, "docs-site-read-ravi.json");
    } finally {
      chmodSync(join(ws.dir, LEDGER), 0o644);
    }

    // BEFORE THE DEFENCE THIS RUN SUCCEEDED AND THE LEDGER WAS REPLACED. Both halves are asserted:
    // the refusal, and — the one that actually matters — that the bytes on disk did not move.
    assert.equal(second.r.code, 1, `${second.r.out}${second.r.err}`);
    assert.equal(second.s["status"], "failed");
    const e = errorOf(second.s);
    assert.equal(e.class, "validation");
    assert.equal(e.code, "E_FUNCTION_REFUSED");
    assert.match(String(e.message), /on node "weigh" refused/);
    assert.match(String(e.message), /IS on disk — fs.glob lists it/);
    assert.match(String(e.message), /destroy every grant the file already holds/);

    const after = JSON.parse(readFileSync(join(ws.dir, LEDGER), "utf8")) as { grants: Grant[] };
    assert.deepEqual(after.grants.map((g) => g.who), ["u:sam"], "u:sam's grant must survive");
  } finally {
    ws.dispose();
  }
});

test("F5's defence does NOT fire on the ordinary first run, where there really is no ledger", async () => {
  const ws = workspace();
  try {
    // THE OTHER HALF, and the one a defence like this gets wrong. `look` finds nothing, the error
    // arm fires for the RIGHT reason, and the run must proceed. A defence that refused here would
    // make the first run of the command impossible.
    const r = await run(ws.dir, "docs-site-read.json");
    assert.equal(r.s["status"], "succeeded", `${r.r.out}${r.r.err}`);
    assert.equal((outputs(r.s)["decision"] as Decision).historySource, "none");
    const counts = await taskCounts(ws.dir, String(r.s["runId"]));
    assert.equal(counts["look"], 1, JSON.stringify(counts));
    assert.equal(counts["first-grant"], 1, JSON.stringify(counts));
  } finally {
    ws.dispose();
  }
});

test("a failed run's already-landed fs.write is COMPENSATED, with no compensation edge declared", async () => {
  const ws = workspace();
  try {
    const first = await run(ws.dir, "docs-site-read.json");
    assert.equal(first.s["status"], "succeeded", `${first.r.out}${first.r.err}`);
    const before = readFileSync(join(ws.dir, GRANT), "utf8");
    assert.match(before, /REQ-1042/);

    // READ-ONLY, not unreadable — and the distinction is what F5's defence changed. `read-ledger`
    // now SUCCEEDS (so `prior` runs and `weigh` does not refuse), `write-grant` succeeds, and
    // `write-ledger` is the node that fails. An earlier version of this test used `chmod 000`,
    // which since the `look` node refuses at `weigh` and never reaches a write at all.
    chmodSync(join(ws.dir, LEDGER), 0o444);
    let second: { r: Result; s: Record<string, unknown> };
    try {
      second = await run(ws.dir, "docs-site-read-ravi.json");
    } finally {
      chmodSync(join(ws.dir, LEDGER), 0o644);
    }
    assert.equal(second.s["status"], "failed", `${second.r.out}${second.r.err}`);

    // THE ROLLBACK RAN. `fs.write` declares `compensation: {tool: "fs.restore"}`, so the engine
    // undoes the grant write on its own — this graph declares no `compensation` edge and needs
    // none. Read off the FILE rather than off the trace, because the file is what a person has.
    const after = readFileSync(join(ws.dir, GRANT), "utf8");
    assert.equal(after, before, "out/grant.json must be byte-identical to before the failed run");
    assert.doesNotMatch(after, /REQ-1048/, "the failed run's grant must not survive");

    // And the trace says so in its own words, which is where somebody would go looking.
    const t = await loom(ws.dir, ["trace", String(second.s["runId"])]);
    assert.match(t.out, /loom\.tool \(compensate\)/, t.out);
  } finally {
    ws.dispose();
  }
});

// ── the three bounds on a renewal, one test per bound ─────────────────────────
//
// A renewal SKIPS THE PERSON, so each bound is the difference between "a human said yes to this"
// and "a human said yes to something else". These tests exist because the first version of this
// suite was 16/16 GREEN with either of the two bounds that existed then DELETED: the only renewal
// it ever exercised was a same-level, same-hours, minutes-old repeat of an approval, which
// satisfies every guard at once and therefore distinguishes none of them.
//
// Each seeds the ledger BY HAND rather than by running the graph. That is deliberate: a test that
// builds its history by approving gates can only ever produce a history that is seconds old and
// exactly as wide as what it asked for, which is the fixture that hid the gap. Seeding also keeps
// them deterministic — no sleeping, no clock arithmetic against a real approval.

/** Write a ledger holding exactly these grants, ages given in hours BEFORE now. */
function seedLedger(
  dir: string,
  rows: readonly { hoursAgo: number; level: string; hours: number; kind: "human" | "automatic"; who?: string }[],
): void {
  const now = Date.now();
  const grants = rows.map((r, i) => ({
    requestId: `SEED-${i}`,
    who: r.who ?? "u:dana",
    resource: "orders-db",
    tier: "restricted",
    level: r.level,
    hours: r.hours,
    grantedAt: now - r.hoursAgo * 3_600_000,
    expiresAt: now - r.hoursAgo * 3_600_000 + r.hours * 3_600_000,
    ceremony: r.kind === "human" ? "review" : "auto",
    decidedBy: r.kind === "human" ? 'a person, at the "sign" gate' : "automatically",
    decidedByKind: r.kind,
    reason: "seeded by examples-grant.test.ts",
    renewalOf: null,
  }));
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(
    join(dir, LEDGER),
    `${JSON.stringify({ version: 1, note: "seeded by the suite", grants }, null, 2)}\n`,
  );
}

/** Edit one top-level field of the workspace copy of the policy. */
function setPolicy(dir: string, field: string, value: unknown): void {
  const path = join(dir, "access", "policy.json");
  const policy = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  policy[field] = value;
  writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`);
}

test("BOUND 1 — only a HUMAN-decided grant starts a renewal window", async () => {
  const ws = workspace();
  try {
    // A person said yes three hours ago; an auto-renewal of it landed six minutes ago. The window
    // is two hours. If auto entries counted, the fresh one would carry this — and every renewal
    // would restart the clock, so ONE approval becomes indefinite access at the cap.
    setPolicy(ws.dir, "renewalWithinHours", 2);
    seedLedger(ws.dir, [
      { hoursAgo: 3, level: "write", hours: 4, kind: "human" },
      { hoursAgo: 0.1, level: "write", hours: 4, kind: "automatic" },
    ]);

    const r = await run(ws.dir, "orders-db-backfill.json");
    assert.equal(
      r.s["status"],
      "awaiting_gate",
      `the only HUMAN decision is older than the window, so this needs a person: ${r.r.out}${r.r.err}`,
    );
    const counts = await taskCounts(ws.dir, String(r.s["runId"]));
    assert.equal(counts["sign"], 1, JSON.stringify(counts));

    // THE CONTROL: make the fresh entry human and the same ledger renews with no gate. Without it
    // this test would pass against a `findRenewal` that had stopped renewing anything.
    const ws2 = workspace();
    try {
      setPolicy(ws2.dir, "renewalWithinHours", 2);
      seedLedger(ws2.dir, [
        { hoursAgo: 3, level: "write", hours: 4, kind: "human" },
        { hoursAgo: 0.1, level: "write", hours: 4, kind: "human" },
      ]);
      const ok = await run(ws2.dir, "orders-db-backfill.json");
      assert.equal(ok.s["status"], "succeeded", `${ok.r.out}${ok.r.err}`);
      assert.equal((outputs(ok.s)["decision"] as Decision).ceremony, "auto");
    } finally {
      ws2.dispose();
    }
  } finally {
    ws.dispose();
  }
});

test("BOUND 2a — a renewal may not widen the LEVEL", async () => {
  const ws = workspace();
  try {
    // A person approved READ. This asks for WRITE. `orders-db` is restricted, so nothing but a
    // renewal can skip the gate — and a read approval is not an approval to write.
    seedLedger(ws.dir, [{ hoursAgo: 1, level: "read", hours: 4, kind: "human" }]);

    const r = await run(ws.dir, "orders-db-backfill.json");
    assert.equal(r.s["status"], "awaiting_gate", `${r.r.out}${r.r.err}`);
    const counts = await taskCounts(ws.dir, String(r.s["runId"]));
    assert.equal(counts["sign"], 1, JSON.stringify(counts));

    // THE CONTROL, and without it this test passes against a graph that never renews: the same
    // ledger at the same level renews with no gate at all.
    const ws2 = workspace();
    try {
      seedLedger(ws2.dir, [{ hoursAgo: 1, level: "write", hours: 4, kind: "human" }]);
      const ok = await run(ws2.dir, "orders-db-backfill.json");
      assert.equal(ok.s["status"], "succeeded", `${ok.r.out}${ok.r.err}`);
      assert.equal((outputs(ok.s)["decision"] as Decision).ceremony, "auto");
    } finally {
      ws2.dispose();
    }
  } finally {
    ws.dispose();
  }
});

test("BOUND 2b — a renewal may not widen the HOURS", async () => {
  const ws = workspace();
  try {
    // A person approved write for FOUR hours. This asks for TWENTY-FOUR, which is inside the
    // policy's 24h cap — so `firstDenial` lets it through and only this bound stops it. Before it
    // existed, a human who approved four hours had authorised a day.
    seedLedger(ws.dir, [{ hoursAgo: 1, level: "write", hours: 4, kind: "human" }]);

    const r = await run(ws.dir, "orders-db-long-write.json");
    assert.equal(r.s["status"], "awaiting_gate", `24h is wider than the 4h a person approved: ${r.r.out}${r.r.err}`);

    // And the NARROWER direction still renews, which is the half that says this is a width test
    // and not "renewals are off".
    const narrower = await run(ws.dir, "orders-db-read.json");
    assert.equal(narrower.s["status"], "succeeded", `${narrower.r.out}${narrower.r.err}`);
    const d = outputs(narrower.s)["decision"] as Decision;
    assert.equal(d.ceremony, "auto");
    assert.match(d.why, /which is no wider, so it renews that decision/);
  } finally {
    ws.dispose();
  }
});

test("BOUND 3 — a renewal must be inside the window, measured from the prior grant", async () => {
  const ws = workspace();
  try {
    // One human grant, 719 hours old, against a one-hour window. The previous version of this
    // suite set `renewalWithinHours` to 0, which exits `findRenewal` at its `windowMs <= 0` guard
    // and never reaches the comparison — so deleting the comparison kept it green.
    setPolicy(ws.dir, "renewalWithinHours", 1);
    seedLedger(ws.dir, [{ hoursAgo: 719, level: "write", hours: 4, kind: "human" }]);

    const r = await run(ws.dir, "orders-db-backfill.json");
    assert.equal(r.s["status"], "awaiting_gate", `719h old against a 1h window: ${r.r.out}${r.r.err}`);

    // THE CONTROL: the same ledger with a window wide enough to hold it renews. Without this the
    // test would pass against a `findRenewal` that returned null unconditionally.
    const ws2 = workspace();
    try {
      setPolicy(ws2.dir, "renewalWithinHours", 720);
      seedLedger(ws2.dir, [{ hoursAgo: 719, level: "write", hours: 4, kind: "human" }]);
      const ok = await run(ws2.dir, "orders-db-backfill.json");
      assert.equal(ok.s["status"], "succeeded", `${ok.r.out}${ok.r.err}`);
      assert.equal((outputs(ok.s)["decision"] as Decision).ceremony, "auto");
    } finally {
      ws2.dispose();
    }
  } finally {
    ws.dispose();
  }
});

test("a renewal's `why` names BOTH widths, so a record cannot call a wider grant a renewal", async () => {
  const ws = workspace();
  try {
    seedLedger(ws.dir, [{ hoursAgo: 2, level: "admin", hours: 8, kind: "human" }]);
    const r = await run(ws.dir, "orders-db-backfill.json");
    assert.equal(r.s["status"], "succeeded", `${r.r.out}${r.r.err}`);
    const d = outputs(r.s)["decision"] as Decision;
    assert.equal(d.ceremony, "auto");
    // The prior decision AND the one being made, both spelled out. The old message printed only
    // the prior level and the age, and said "this is a renewal and not a new grant" over a grant
    // four times as long as the one a person had approved.
    assert.match(d.why, /a person granted u:dana admin\/8h on orders-db 2 hours ago/);
    assert.match(d.why, /this asks for write\/4h, which is no wider/);
  } finally {
    ws.dispose();
  }
});

// ── the failure taxonomy, all FOUR kinds ──────────────────────────────────────
//
// §2 of the port doc used to name two — a denial at `deny` and a refusal at `weigh` — and a
// reviewer found two more that a caller wrapping this workflow will meet. They are different
// CLASSES, not just different messages, and a script that branches on `class`/`code` needs all
// four: `unavailable` means the workflow never started, `validation` means it declined.

test("a missing REQUEST file fails at the TOOL, because read-request has no error edge", async () => {
  const ws = workspace();
  try {
    // ONLY `read-ledger` has an error arm, and deliberately: a ledger may legitimately not exist,
    // while a request the caller named and did not provide is the caller's bug. This is the
    // `unavailable` class — the workflow never ran, as against declining to grant.
    const r = await run(ws.dir, "no-such-request.json");
    assert.equal(r.r.code, 1, `${r.r.out}${r.r.err}`);
    assert.equal(r.s["status"], "failed");
    const e = errorOf(r.s);
    assert.equal(e.class, "unavailable", JSON.stringify(e));
    assert.equal(e.code, "E_TOOL_SOURCE_UNAVAILABLE", JSON.stringify(e));

    const counts = await taskCounts(ws.dir, String(r.s["runId"]));
    assert.equal(counts["weigh"], undefined, `nothing downstream runs: ${JSON.stringify(counts)}`);
    assert.equal(counts["first-grant"], undefined, "and the ledger's error arm is not involved");
  } finally {
    ws.dispose();
  }
});

test("a NON-FINITE `hours` is refused at `weigh`, not left to fail the journal", async () => {
  const ws = workspace();
  try {
    // `"hours": 1e309` parses to `Infinity`, which IS a number — so a `typeof` check passes it.
    // It used to be denied by `firstDenial` for not being a whole number and then fail the run at
    // `validation`/`E_RESOURCE_INVALID`, "non-finite number Infinity at hours", because `decision`
    // carries the raw value and the journal will not record one. A denial nobody can journal is a
    // denial nobody can read.
    const r = await run(ws.dir, "hours-not-finite.json");
    assert.equal(r.r.code, 1, `${r.r.out}${r.r.err}`);
    const e = errorOf(r.s);
    assert.equal(e.class, "validation", JSON.stringify(e));
    assert.equal(e.code, "E_FUNCTION_REFUSED", JSON.stringify(e));
    assert.match(String(e.message), /on node "weigh" refused/);
    // The value is NAMED, and named readably: `JSON.stringify(Infinity)` is the string "null", so
    // the obvious formatter reported this as "number null" — which reads as a missing field.
    assert.match(String(e.message), /found the non-finite number Infinity/);
    assert.doesNotMatch(String(e.message), /E_RESOURCE_INVALID/);
  } finally {
    ws.dispose();
  }
});

test("every hostile request fails CLOSED — nothing reaches `record`, nothing reaches disk", async () => {
  const ws = workspace();
  try {
    // A sweep rather than one case, because the claim is about the SET: no malformed or
    // out-of-policy request may produce a grant. Each is asserted three ways — exit 1, `record`
    // never dispatched, and no file on disk — since "the run failed" and "the run failed after
    // granting access" are the same exit code.
    const hostile: readonly string[] = [
      "not-a-request.txt",
      "no-level.json",
      "hours-not-finite.json",
      "bad-level.json",
      "unknown-resource.json",
      "orders-db-too-long.json",
      "payments-kms-admin.json",
    ];
    for (const request of hostile) {
      const r = await run(ws.dir, request);
      assert.equal(r.r.code, 1, `${request} must exit 1: ${r.r.out}${r.r.err}`);
      assert.equal(r.s["status"], "failed", request);
      const counts = await taskCounts(ws.dir, String(r.s["runId"]));
      assert.equal(counts["record"], undefined, `${request} reached record: ${JSON.stringify(counts)}`);
      assert.equal(counts["write-grant"], undefined, `${request} reached write-grant: ${JSON.stringify(counts)}`);
      assert.equal(existsSync(join(ws.dir, GRANT)), false, `${request} left a grant on disk`);
      assert.equal(existsSync(join(ws.dir, LEDGER)), false, `${request} touched the ledger`);
    }
  } finally {
    ws.dispose();
  }
});
