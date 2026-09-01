/**
 * `loom serve` COULD ONLY EVER BIND LOOPBACK, and the flag that would have said otherwise
 * did not exist.
 *
 * Measured on this tree before the fix, through the real entry point:
 *
 *     loom serve --host 0.0.0.0 --workspace <dir> --port 0
 *       → E_CONFIG_INVALID: unknown flag: --host
 *
 *     src/server/http.ts   async listen(port: number, host = "127.0.0.1")
 *     src/cli.ts           const { port } = await plane.listen(wanted);   // no host, ever
 *     src/cli.ts           `loom listening on http://127.0.0.1:${port}`   // hardcoded
 *
 * So `SignedWebhookChannel.parseCallback`, `timingSafeStringEqual`, the `CALLBACK_REJECTIONS`
 * taxonomy, `GateCallbackRouter`'s per-run admission cap and the deliberately-unauthenticated
 * `CALLBACK_PATH` — the inbound perimeter — existed so a Slack button could answer a human
 * gate, and Slack could not reach the socket. `README.md`'s "Or run it as a service" was a
 * single-machine claim as written.
 *
 * ## What is asserted here, and why each line is separate from the next
 *
 * Loopback-by-default is CORRECT and stays. Four independent properties, because a single
 * "it works" test would stay green under three of the four ways this can be re-broken:
 *
 *   1. `--host` reaches the socket. Not "is accepted" — a flag parsed and dropped reads
 *      identically at the banner. The plane is bound on an address that is NOT 127.0.0.1,
 *      answered there over a real connection, and 127.0.0.1 on that same port is proven
 *      REFUSED. That last half is what makes this red for a `httpHost` that returns the
 *      default no matter what it was given.
 *   2. The default is STILL loopback with the flag absent — asserted the same way, from
 *      both ends, so moving `DEFAULT_HOST` fails here and not only in a docstring.
 *   3. The refusals fire, each named by CODE and by the words an operator reads:
 *      `--host` with no value, `--host ""` (measured: `server.listen(port, "")` binds
 *      `::`, EVERY interface — the widest bind there is, produced by leaving a variable
 *      unset), and the combination `ControlPlane.listen` refuses outright: a NON-LOOPBACK
 *      address on a plane with no token and no identity source.
 *   4. The banner tells the operator AT THE MOMENT IT HAPPENS: the address it prints is the
 *      one actually bound, and a non-loopback bind adds a line of its own.
 *
 * EVERY TEST CARRIES A DEADLINE, and it is a failure deadline rather than a measurement.
 * Nothing here asserts how fast anything is; the deadline exists because the failure mode of
 * a test that drives a real socket and a real child process is a HANG, and a hang reports
 * less than no test at all. `reach`'s docstring records the one that got through.
 *
 * Every server below is a CHILD PROCESS on an EPHEMERAL PORT (`--port 0`), for the reasons
 * `cli.test.ts`'s `serving` gives at length: `serve` ends in a promise only a SIGINT
 * resolves, and an in-process capture of `process.stdout.write` swallows the test runner's
 * own reporter. Offline throughout — every address dialled is this machine's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createSocket } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE MACHINERY IS IN `test/deployment/harness.ts` NOW, and it left with its docstrings.
 *
 * `serving`, `refusing`, `reach`, `origin`, `secondAddress` and the module-level reaper under
 * them were written here and are still described here in outline — but a second file needed
 * every one of them, and a copy would have meant two `spawned` sets, only one of which any
 * `after()` drains. The four-minute hang this file's own mutation sweep recorded is what a
 * leaked child costs, so the reaper exists exactly once. `workspace()` stayed a local name
 * for `scratchWorkspace`, because that is what this file's tests read.
 */
import {
  origin,
  reach,
  refusing,
  scratchWorkspace as workspace,
  secondAddress,
  serving,
} from "../deployment/harness.ts";

// ── 1 · the flag reaches the socket ─────────────────────────────────────────

test("`--host` BINDS WHERE ASKED — answered there, and 127.0.0.1 on that port is REFUSED", { timeout: 90_000 }, async (t) => {
  const other = await secondAddress();
  if (other === undefined) {
    // Not a silent skip: a machine with exactly one bindable address cannot distinguish a
    // working `--host` from a dropped one, and saying so is better than a green tick.
    t.skip("no bindable address other than 127.0.0.1 — the two-address property is not checkable here");
    return;
  }
  const w = workspace();
  // `--token` unconditionally, because `other` may be a routable address and a tokenless
  // plane is REFUSED one — see the third block below, which is where that is asserted.
  const s = await serving(["serve", "--workspace", w.dir, "--port", "0", "--host", other, "--token", "s3cret"]);
  try {
    assert.equal(s.host, other, `the banner must name the address bound, not ${s.host}`);
    assert.ok(s.port > 0, "an ephemeral port was requested and one must have been taken");

    const there = await reach(other, s.port, "s3cret");
    assert.equal(there.status, 200, `GET ${origin(other, s.port)}/health must answer (got ${JSON.stringify(there)})`);

    // THE HALF THAT MAKES THIS A TEST. Without it, a `--host` parsed and thrown away binds
    // 127.0.0.1, the banner prints whatever it likes, and every assertion above still holds.
    const here = await reach("127.0.0.1", s.port, "s3cret");
    assert.equal(
      here.status,
      undefined,
      `127.0.0.1:${s.port} answered, so the socket is on loopback and --host ${other} was not honoured`,
    );
    assert.equal(here.error, "ECONNREFUSED", `expected nothing listening on 127.0.0.1:${s.port}, got ${JSON.stringify(here)}`);
  } finally {
    await s.stop();
    w.dispose();
  }
});

// ── 2 · the default does not move ───────────────────────────────────────────

test("WITHOUT THE FLAG IT IS STILL LOOPBACK, and nothing else on this machine can reach it", { timeout: 90_000 }, async (t) => {
  const w = workspace();
  const s = await serving(["serve", "--workspace", w.dir, "--port", "0"]);
  try {
    assert.equal(s.host, "127.0.0.1", "the default bind is loopback and this is the line that says so");
    assert.equal((await reach("127.0.0.1", s.port)).status, 200, "the default bind must answer on loopback");
    // NOT AN OPINION ABOUT THE BANNER. Dial the other address for real: a `DEFAULT_HOST`
    // quietly widened to `0.0.0.0` would answer here, and this is the only assertion in the
    // file that would catch it.
    const other = await secondAddress();
    if (other === undefined) {
      t.diagnostic("only one bindable address on this machine — the widening half of this test could not run");
      return;
    }
    const out = await reach(other, s.port);
    assert.equal(out.status, undefined, `${origin(other, s.port)} answered — the DEFAULT bind is no longer loopback`);
  } finally {
    await s.stop();
    w.dispose();
  }
});

// ── 3 · the refusals ────────────────────────────────────────────────────────

test("A TOKENLESS PLANE IS REFUSED A NON-LOOPBACK ADDRESS, and the refusal names the fix", { timeout: 90_000 }, async () => {
  const w = workspace();
  try {
    const r = await refusing(["serve", "--workspace", w.dir, "--port", "0", "--host", "0.0.0.0"]);
    assert.notEqual(r.code, 0, "it must exit non-zero rather than serve an open control plane to the network");
    assert.match(r.err, /E_CONFIG_INVALID/, "the refusal is a configuration error, not a stack trace");
    assert.match(r.err, /0\.0\.0\.0/, "the message names the address that was asked for");
    // The three routes a stranger would get, named — the reason this is a refusal and not a
    // warning. A message that said only "no token" would be the line the banner already prints.
    //
    // ASSERTED AGAINST ROUTES THAT EXIST. The first draft of the refusal named
    // `POST /runs/:id/decisions` and `DELETE /runs/:id`; `#buildRoutes` has neither, and this
    // assertion happily matched the wrong one. These three are the real gate-decision,
    // submit and command paths.
    assert.match(r.err, /POST \/runs\/:id\/gates\/:gateId/, "it must say that any open human gate becomes approvable");
    assert.match(r.err, /POST \/runs\/:id\/commands/, "…and that runs can be cancelled by a stranger");
    assert.match(r.err, /token|identity/, "a refusal without a fix is a wall");

    // ...AND THE SAME PLANE ON LOOPBACK IS FINE. Without this the refusal could be "reject
    // every --host" and the block above would not notice.
    const ok = await serving(["serve", "--workspace", w.dir, "--port", "0", "--host", "127.0.0.1"]);
    try {
      assert.equal(ok.host, "127.0.0.1");
      assert.equal((await reach("127.0.0.1", ok.port)).status, 200, "and it serves");
      await ok.stop();
      assert.match(ok.err, /NO TOKEN/, "a tokenless loopback plane still says so, and still runs");
    } finally {
      await ok.stop();
    }
  } finally {
    w.dispose();
  }
});

test("`--host` WITH NO VALUE, AND `--host \"\"`, ARE REFUSED — the empty one binds EVERY interface", { timeout: 90_000 }, async () => {
  // The measurement behind the second refusal, re-run here rather than asserted from a
  // docstring: this is a platform fact the refusal is built on, and if it ever stops being
  // true the refusal's reason is gone.
  const probe = await new Promise<string>((resolve) => {
    const s = createSocket();
    s.listen(0, "", () => {
      const a = s.address();
      const at = typeof a === "object" && a !== null ? a.address : "?";
      s.close(() => resolve(at));
    });
  });
  assert.ok(probe === "::" || probe === "0.0.0.0", `an empty host must bind every interface for the refusal to be right, got ${probe}`);

  const w = workspace();
  try {
    for (const argv of [
      ["serve", "--workspace", w.dir, "--port", "0", "--host"],
      ["serve", "--workspace", w.dir, "--port", "0", "--host="],
      // With a token, so the tokenless refusal cannot be what fails it: this must be the
      // FLAG's own refusal, before the socket, or the empty value quietly binds `::`.
      ["serve", "--workspace", w.dir, "--port", "0", "--host=", "--token", "s3cret"],
    ]) {
      const r = await refusing(argv);
      assert.notEqual(r.code, 0, `\`${argv.join(" ")}\` must refuse`);
      assert.match(r.err, /--host/, "the message names the flag");
      assert.match(r.err, /E_CONFIG_INVALID/);
    }
    const empty = await refusing(["serve", "--workspace", w.dir, "--port", "0", "--host=", "--token", "s3cret"]);
    assert.match(empty.err, /EVERY interface/i, "the empty value's refusal must say what an empty host actually does");
  } finally {
    w.dispose();
  }
});

test("THE AUDIT'S REPRODUCTION: `--host` is no longer an unknown flag", { timeout: 90_000 }, async () => {
  // The literal before-state, kept as the regression: `E_CONFIG_INVALID: unknown flag: --host`,
  // raised by `assertKnownFlags` before any of the above could run.
  const w = workspace();
  try {
    const r = await refusing(["serve", "--workspace", w.dir, "--port", "0", "--host", "0.0.0.0"]);
    assert.doesNotMatch(r.err, /unknown flag/, "--host must be a flag this binary understands");
  } finally {
    w.dispose();
  }
});

// ── 4 · the operator is told, at the moment it happens ──────────────────────

test("A NON-LOOPBACK BIND SAYS SO AT BOOT, and a loopback bind does not", { timeout: 90_000 }, async () => {
  const w = workspace();
  const wide = await serving(["serve", "--workspace", w.dir, "--port", "0", "--host", "0.0.0.0", "--token", "s3cret"]);
  try {
    // REACHED FOR REAL over the wide bind, so this is not a test about a string.
    assert.equal((await reach("127.0.0.1", wide.port, "s3cret")).status, 200, "0.0.0.0 includes loopback and must answer there");
    // STOPPED BEFORE READING `err`, so what is asserted on is everything the process wrote.
    await wide.stop();
    assert.equal(wide.host, "0.0.0.0", "the banner names the address bound, and used to name 127.0.0.1 whatever happened");
    assert.match(wide.err, /NON-LOOPBACK BIND/, "the operator must be told at the moment it happens");
    assert.match(wide.err, /CLEARTEXT/, "…and told what crosses the socket unprotected");
    assert.match(wide.err, new RegExp(`0\\.0\\.0\\.0:${String(wide.port)}`), "…naming the address and the port actually bound");
  } finally {
    await wide.stop();
  }

  const narrow = await serving(["serve", "--workspace", w.dir, "--port", "0", "--token", "s3cret"]);
  try {
    await narrow.stop();
    // A warning that fires when nothing is wrong is one operators learn to skip — the same
    // argument `ownershipWarnings` makes for itself.
    assert.doesNotMatch(narrow.err, /NON-LOOPBACK/, "the default bind must not warn about a perimeter it does not have");
  } finally {
    await narrow.stop();
    w.dispose();
  }
});

// ── the point of all of it ──────────────────────────────────────────────────

test("AN INBOUND CALLBACK FROM OFF-BOX CAN NOW REACH THE PERIMETER IT WAS BUILT FOR", { timeout: 90_000 }, async (t) => {
  // The defect in one assertion. `POST /runs/:id/callbacks/:channel` is deliberately
  // unauthenticated — an HMAC over the raw body is its only credential — and roughly 1,400
  // lines exist behind it so a Slack button can answer a human gate. On a loopback bind
  // Slack cannot open the socket, so all of it was unreachable by construction.
  //
  // Asserted at the SOCKET, and the claim is exactly reachability plus the carve-out: a
  // request carrying NO bearer token, sent to an address that is not this machine's
  // loopback, on a plane that HAS a token, gets a routed answer that is not a 401.
  //
  // MEASURED THE OTHER WAY FIRST. With no channels file the route does not exist and the
  // bearer check applies to that path like any other — this test asserted `notEqual(401)`
  // against a bare workspace and went red with `actual: 401`. So the channels file below is
  // load-bearing: it is what opens both the route and its carve-out, together.
  const other = await secondAddress();
  if (other === undefined) {
    t.skip("no bindable address other than 127.0.0.1");
    return;
  }
  const w = workspace();
  const channels = join(w.dir, "channels.json");
  writeFileSync(
    channels,
    JSON.stringify({ channels: [{ name: "slack", url: "https://hooks.example.com/a", callbackSecret: "shhh-not-a-real-secret" }] }),
  );
  const s = await serving(["serve", "--workspace", w.dir, "--port", "0", "--host", other, "--token", "s3cret", "--channels-file", channels]);
  try {
    const status = await new Promise<number | string>((resolve) => {
      const req = httpRequest(
        `${origin(other, s.port)}/runs/run_nope/callbacks/slack`,
        { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(4_000) },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
      req.end("{}");
    });
    assert.equal(typeof status, "number", `the callback path must be reachable from ${other}, got ${String(status)}`);
    assert.notEqual(status, 401, "the callback route is deliberately outside the bearer check, and this request carried none");
    await s.stop();
    assert.match(s.err, /CALLBACK ROUTE OPEN/, "the route must actually be open, or the line above proves nothing");
  } finally {
    await s.stop();
    w.dispose();
  }
});

// ── 5 · which gates can be answered, and where the plane says it cannot tell ─

/**
 * A gate that names an approver AND says where it is delivered.
 *
 * Both halves are load-bearing. Without `approvers` there is nothing to be unanswerable
 * about, and without `delivery.channels` the answerable channel in the file below is not a
 * door onto THIS gate — which is itself the distinction the old per-graph boolean could not
 * make.
 */
const GATED_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "needs-a-person", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: [] },
  channels: { subject: { type: "string", reduce: "replace" } },
  inputs: ["subject"],
  outputs: [],
  nodes: [
    {
      id: "approve",
      type: "human_gate",
      reads: ["subject"],
      writes: [],
      humanGate: {
        ref: "oversight/ship@stable",
        approval: { approvers: ["u:security-lead"] },
        delivery: { channels: ["slack", "carrier-pigeon"] },
      },
    },
  ],
  edges: [],
};

test("A GATE THE PLANE CANNOT VOUCH FOR SAYS SO — `cannot-tell`, not silence", { timeout: 90_000 }, async () => {
  // THE SUPPRESSION THIS REPLACES, in one line: `announce` read
  // `opts.dispatcher === undefined ? unanswerableGraphs(opts) : []`, so configuring ANY
  // dispatcher switched the whole report off — and `unanswerableGraphs` itself opened with
  // `if (opts.identity !== undefined) return []`. Two branches whose only effect was to fall
  // silent in the case they could not decide. This deployment has both an answerable channel
  // and no identity source, so under the old code it printed nothing at all.
  const w = workspace();
  const channels = join(w.dir, "channels.json");
  writeFileSync(
    channels,
    JSON.stringify({ channels: [{ name: "slack", url: "https://hooks.example.com/a", callbackSecret: "shhh-not-a-real-secret" }] }),
  );
  mkdirSync(join(w.dir, "graphs"), { recursive: true });
  writeFileSync(join(w.dir, "graphs", "gated.json"), JSON.stringify(GATED_GRAPH));
  const s = await serving(["serve", "--workspace", w.dir, "--port", "0", "--token", "s3cret", "--channels-file", channels]);
  try {
    // `awaitErr`, NOT `stop()` then read. `serving` returns on the last STDOUT banner key and
    // these lines are on STDERR after it, so reading straight away races the pipe — the
    // hazard this harness exists to remove, and one this file's own `awaitErr` docstring
    // records. The deadline is a failure deadline, never a measurement.
    //
    // The verdict, and the FACT IT IS MISSING rather than a shrug: a signed callback names
    // its own approver and never consults the identity source, so what `slack` vouches for
    // is genuinely invisible from this process.
    await s.awaitErr(/CANNOT TELL — needs-a-person\/approve names u:security-lead/);
    await s.awaitErr(/whether its subject mapping vouches for u:security-lead is not visible/);
    // And the two channel facts `announce` held all along and never cross-referenced.
    await s.awaitErr(/carrier-pigeon: delivered nowhere but the console fallback/);
  } finally {
    await s.stop();
    w.dispose();
  }
});

test("AN APPROVER NO CONFIGURED CREDENTIAL COULD EVER BE IS NAMED AT BOOT", { timeout: 90_000 }, async () => {
  // `approvers` is a list of opaque strings compared by exact equality against
  // `Actor.subject`, and NOTHING enumerated subjects — so a graph could name an approver the
  // configured source can never produce and the first sign of it was a 403, hours later, at
  // the gate. `BearerTokenIdentity` has always known its whole population; it just had no way
  // to be asked. `knownSubjects()` is that question, and this is its only writer.
  //
  // THE OLD CODE CALLED THIS DEPLOYMENT CLEAN. `unanswerableGraphs` opened with
  // `if (opts.identity !== undefined) return []`, so configuring any identity file at all
  // silenced the check that this graph's approver is unreachable.
  const w = workspace();
  const identities = join(w.dir, "identities.json");
  writeFileSync(identities, JSON.stringify({ subjects: [{ subject: "u:someone-else", token: "not-a-real-token-0123456789" }] }));
  mkdirSync(join(w.dir, "graphs"), { recursive: true });
  writeFileSync(join(w.dir, "graphs", "gated.json"), JSON.stringify(GATED_GRAPH));
  const s = await serving(["serve", "--workspace", w.dir, "--port", "0", "--token", "s3cret", "--identity-file", identities]);
  try {
    await s.awaitErr(/NO DOOR — needs-a-person\/approve names u:security-lead/);
    await s.awaitErr(/enumerates 1 subject\(s\) and none of them is u:security-lead/);
  } finally {
    await s.stop();
    w.dispose();
  }
});

test("…AND WHEN IT CAN BE, NOTHING IS PRINTED — the report must not fire where nothing is wrong", { timeout: 90_000 }, async () => {
  // The control. `answerable` is the one verdict that needs a POSITIVE demonstration, and a
  // report that shouted on a correct deployment would be a report operators learn to skip —
  // which is exactly as useful as the suppression it replaced.
  const w = workspace();
  const identities = join(w.dir, "identities.json");
  writeFileSync(identities, JSON.stringify({ subjects: [{ subject: "u:security-lead", token: "not-a-real-token-0123456789" }] }));
  mkdirSync(join(w.dir, "graphs"), { recursive: true });
  writeFileSync(join(w.dir, "graphs", "gated.json"), JSON.stringify(GATED_GRAPH));
  const s = await serving(["serve", "--workspace", w.dir, "--port", "0", "--token", "s3cret", "--identity-file", identities]);
  try {
    // A NEGATIVE CANNOT BE WAITED FOR, so the wait is on a line this deployment definitely
    // prints — which is what proves stderr was read complete rather than truncated. Without
    // that anchor an empty buffer would pass this test for the wrong reason, which is the
    // same defect class the code under test is fixing.
    await s.awaitErr(/NO MODEL ADAPTER/);
    await s.stop();
    assert.doesNotMatch(s.err, /NO DOOR|CANNOT TELL/, s.err);
  } finally {
    await s.stop();
    w.dispose();
  }
});

// ── 6 · the credential a non-loopback bind needs is not two flags ────────────

/** A source that is not a token file: it trusts a header a terminating proxy set. */
const OIDC_MODULE = `
class ProxyHeaderIdentity {
  name = "proxy-header";
  identify(req) {
    const s = req.headers["x-forwarded-subject"];
    return s === undefined ? undefined : { subject: s, kind: "human", via: "console" };
  }
}
export default ({ identity }) => { identity.register(new ProxyHeaderIdentity()); };
`;

test("AN IDENTITY SOURCE **IS** THE CREDENTIAL — a module's source binds 0.0.0.0 with no --token and no --identity-file", { timeout: 90_000 }, async () => {
  // WHAT `listen` ACTUALLY REFUSES ON is `openToEveryCaller` — no token AND no identity SOURCE
  // — and since `--extension-module` grew the `identity` seam there have been three doors onto
  // it, not two. Two usage strings still named two: `--help`'s `--host` block and `httpHost`'s
  // own refusal both said "needs --token or --identity-file", which reads as an enumeration and
  // is one short. `listen`'s refusal was already generic ("no token and no identity source"),
  // so the binary contradicted itself depending on which message you hit first.
  //
  // THE BEHAVIOUR IS DRIVEN FIRST AND THE STRINGS SECOND, in that order deliberately: a test
  // that only asserted on the text would stay green if the third door were later closed, which
  // would make the strings right again and the product worse.
  const w = workspace();
  const mod = join(w.dir, "oidc.mjs");
  writeFileSync(mod, OIDC_MODULE);
  const s = await serving(["serve", "--workspace", w.dir, "--port", "0", "--host", "0.0.0.0", "--extension-module", mod]);
  try {
    assert.equal(s.host, "0.0.0.0", "the module's identity source is the credential — this bind is not refused");
    // …and the plane really is credentialed: `who:` names the source, so this is not a bind
    // that slipped through with nobody authenticating.
    assert.match(s.out, /who:\s+proxy-header/);
    await s.stop();
    assert.match(s.err, /NON-LOOPBACK BIND/, "still a routable socket, and still said out loud");
  } finally {
    await s.stop();
  }

  // NOW THE TWO STRINGS. Neither may enumerate two doors when the binary has three.
  //
  // Reached through `unknown command`, which prints the whole usage text to STDERR and exits 2
  // — `--help` writes the same text to stdout and exits 0, which `refusing` does not capture.
  const usage = await refusing(["nonsense"]);
  assert.equal(usage.code, 2);
  // Column-padded across five lines, so the run of whitespace is collapsed before matching —
  // otherwise this assertion is about the usage block's indentation and not about its claim.
  const flat = usage.err.replace(/\s+/g, " ");
  assert.doesNotMatch(flat, /non-loopback host needs --token or --identity-file/, "the usage text was the first copy to fall behind");
  assert.match(
    flat,
    /non-loopback host needs a credential — --token, or ANY identity source: --identity-file or one an --extension-module registers\./,
    usage.err,
  );

  const empty = await refusing(["serve", "--workspace", w.dir, "--port", "0", "--host="]);
  assert.match(empty.err, /--extension-module/, "and so was `httpHost`'s own refusal, which an operator hits without ever running --help");
  w.dispose();
});
