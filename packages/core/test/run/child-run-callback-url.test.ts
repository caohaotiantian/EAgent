/**
 * THE CALLBACK ADDRESS A DELEGATED RUN PUBLISHES — the producer's half of §A.36.
 *
 * §A.36 was filed and fixed as a ROUTE defect: every by-id capture on the control plane read
 * `params[0]` verbatim, so a percent-encoded child run id never became a run id and the plane
 * answered "no such run" for a run it had just listed. `test/server/child-run-by-url.test.ts`
 * pins that half, across all nine captures.
 *
 * IT DID NOT FIX THE ROUND TRIP, because the only in-tree PRODUCER of a callback URL was
 * still building it by interpolation. `SignedWebhookChannel.callbackFor` wrote
 * `${base}/runs/${String(runId)}/callbacks/${encodeURIComponent(name)}` — the channel segment
 * encoded, the run segment raw — under a comment arguing that a `RunId` is a ULID and encoding
 * it would be the identity function. That is true of a ROOT run and false of the runs this
 * address exists for: `Engine` mints a delegated run as `${parent}~${taskId}` (engine.ts, the
 * `#delegate` path) and a `TaskId` is `nodeId@branchPath#iteration`.
 *
 * SO THE FAILURE IS FRAGMENT TRUNCATION, and that is worth naming precisely rather than
 * settling for "the id is encoded now". A `#` in a URL is not a character that renders badly
 * or an id that fails to match — it is the fragment delimiter, and a fragment is never sent.
 * Every client in the world parses `…/runs/01HF…~delegate@root#0/callbacks/slack` into the
 * path `/runs/01HF…~delegate@root` and the fragment `0/callbacks/slack`, and then POSTs the
 * path. The receiver is not asking the wrong route with the wrong id; it is asking a route
 * that does not exist, having never transmitted the two segments that named the endpoint. The
 * decode on the door could not help: the request never reached it.
 *
 * TWO ARMS, because "both halves agree" is a claim about a seam and one side of a seam cannot
 * demonstrate it:
 *
 *  1. **The URL survives a client's parse.** `new URL(...)` on the emitted address has an
 *     EMPTY fragment, and its path splits into exactly `runs / <segment> / callbacks /
 *     <segment>` with the first segment percent-decoding back to the child run id it was
 *     built from. That is the round trip: what the producer encoded is what a consumer
 *     recovers.
 *  2. **A real control plane accepts that address.** The URL is POSTed, as emitted, at a
 *     `ControlPlane` listening on the origin the channel was configured with — the ordinary
 *     deployment shape, where `callbackBaseUrl` names the plane's own public origin. It is
 *     posted UNSIGNED and with no credential, so the answer is a refusal either way; the
 *     measurement is WHICH refusal. A matched callback route is carved out of
 *     `#requiresBearer` and refuses at the signature, `E_GATE_NOT_AUTHORIZED`. A truncated
 *     path matches no route, is not carved out, and is refused for having no bearer token
 *     before any handler sees it. Measured with the interpolation reverted:
 *     `401 {"error":{"code":"E_NOT_AUTHORIZED","message":"missing or invalid bearer token"}}`,
 *     against `https://…/runs/01HF…~delegate@root#0/callbacks/slack` — the whole endpoint
 *     after the `#` was in the fragment, so the receiver asked for `POST /runs/<half an id>`.
 *
 * Offline: a loopback `node:http` server, a `MemoryStateStore`, and an injected `fetch` that
 * returns a canned 200 instead of reaching `hooks.invalid`. The clock is a constant.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ROOT_BRANCH, taskId, type NodeId, type RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { ConsoleChannel, GateDispatcher, SignedWebhookChannel } from "../../src/run/delivery.ts";
import { Engine } from "../../src/run/engine.ts";
import { HumanGateBroker } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { ControlPlane } from "../../src/server/http.ts";

const NOW = 1_700_000_000_000;
const now = (): number => NOW;
const CHANNEL = "slack";
const SECRET = "callback-s3cret";

/**
 * A child run id in the shape `Engine` mints, built from the same exported `taskId` the
 * engine calls rather than from a string literal.
 *
 * The join is `${parent}~${taskId}` — engine.ts's `#delegate` writes exactly that. The
 * parent half is an opaque ULID and nothing here depends on which one, so it is a constant;
 * what the test depends on is the suffix, and the premise assertion below says so out loud.
 * `test/server/child-run-by-url.test.ts` takes the same id off a real subgraph's journal, so
 * the shape is measured somewhere even though it is derived here.
 */
const PARENT = "01HF7Q9K2M3N4P5R6S7T8V9W0X" as RunId;
const CHILD = `${PARENT}~${taskId("delegate" as NodeId, ROOT_BRANCH)}` as RunId;

/** Capture what a channel POSTs outbound, without a network. */
function capture(): { calls: { url: string; body: Record<string, unknown> }[]; fetch: typeof fetch } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
  };
}

/** The `callback` block a gate on `CHILD` publishes, through the real broker and dispatcher. */
async function publishedCallback(callbackBaseUrl: string): Promise<{ url: string; channel: string }> {
  const cap = capture();
  const channel = new SignedWebhookChannel({
    name: CHANNEL,
    url: "https://hooks.invalid/unused",
    callbackSecret: SECRET,
    callbackBaseUrl,
    fetch: cap.fetch,
  });
  const store = new MemoryStateStore({ now });
  const broker = new HumanGateBroker({ now, dispatcher: new GateDispatcher({ channels: [channel], fallback: new ConsoleChannel() }) });
  await broker.raise(new RunLog(CHILD, { store, now }), {
    runId: CHILD,
    taskId: taskId("restart" as NodeId, ROOT_BRANCH),
    nodeId: "restart" as NodeId,
    policyRef: "oversight/restart@stable",
    payload: { command: "kubectl rollout restart deploy/api" },
    delivery: { channels: [CHANNEL] },
  });
  const callback = cap.calls[0]?.body["callback"] as { url: string; channel: string } | undefined;
  assert.ok(callback !== undefined, "a gate on a delegated run must still publish an answer address");
  return callback;
}

test("A.36: the callback URL a DELEGATED run publishes survives a client's URL parse", async () => {
  // The premise, stated rather than assumed: this id carries the delimiter, and a producer
  // that did not encode it would be handing out a fragment.
  assert.ok(CHILD.includes("#"), `expected a '#' in ${CHILD}`);

  const callback = await publishedCallback("https://loom.example.com/");

  // NOT A RAW `#` ANYWHERE. The channel name is encoded too and neither segment may
  // reintroduce one, so this is a property of the whole string and not of one interpolation.
  assert.ok(!callback.url.includes("#"), `the published address carries a raw fragment delimiter: ${callback.url}`);

  // WHAT A CLIENT ACTUALLY DOES WITH IT. An empty `hash` is the assertion that nothing was
  // silently moved out of the request; on the unfixed producer this read `#0/callbacks/slack`
  // and the two segments that name the endpoint were never sent.
  const parsed = new URL(callback.url);
  assert.equal(parsed.hash, "", `a client parses part of this address into a fragment it will not send: ${callback.url}`);

  // ["", "runs", <run>, "callbacks", <channel>] — the shape `CALLBACK_PATH` matches.
  const segments = parsed.pathname.split("/");
  assert.equal(segments.length, 5, `path is not runs/<id>/callbacks/<channel>: ${parsed.pathname}`);
  assert.equal(segments[1], "runs");
  assert.equal(segments[3], "callbacks");
  // THE ROUND TRIP. `safeDecode` on the door does this same `decodeURIComponent`, so an
  // equality here is the two halves agreeing about which run the address names.
  assert.equal(decodeURIComponent(segments[2]!), CHILD);
  assert.equal(decodeURIComponent(segments[4]!), CHANNEL);
  assert.equal(callback.channel, CHANNEL);
});

test("A.36: the address a delegated run publishes is one the control plane's own route matches", async () => {
  // The plane's INBOUND half. A second channel object with the same name and secret, because
  // the outbound half cannot be constructed until the port is known and the port cannot be
  // known until the plane is listening — one deployment, configured in the order a deployment
  // is configured.
  const store = new MemoryStateStore({ now });
  const plane = new ControlPlane({
    engine: new Engine({ store, tools: new ToolRegistry(), functions: new FunctionRegistry(), models: new ModelRegistry(), now }),
    store,
    now,
    // A TOKEN, so the plane is a closed one and `#requiresBearer` has something to enforce.
    // The POST below sends no credential on purpose: the carve-out for a matched callback
    // path is the only thing that can let it through, which is exactly the predicate this
    // arm reads. An open plane would authenticate the truncated request too and blur the
    // two answers into one 404.
    token: "operator-t0ken",
    dispatcher: new GateDispatcher({
      channels: [new SignedWebhookChannel({ name: CHANNEL, url: "https://hooks.invalid/unused", callbackSecret: SECRET })],
    }),
  });
  const { port } = await plane.listen(0);
  try {
    const callback = await publishedCallback(`http://127.0.0.1:${port}`);

    // POSTED EXACTLY AS PUBLISHED — the string handed to `fetch` is the string the receiver
    // was given, so whatever a URL parser does to it happens here too.
    const res = await fetch(callback.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: CHILD, gateId: "gate_01HF00000000000000000000", actor: "u:alice", decision: { kind: "approve" } }),
    });
    const payload = (await res.json()) as { error: { code: string; details?: { reason?: unknown } } };

    // THE CALLBACK ROUTE ANSWERED, and it refused at the signature — which is only reachable
    // once `CALLBACK_PATH` has matched and `#requiresBearer` has carved the request out. The
    // truncated address matched no route and never got a carve-out, so it was refused for
    // carrying no bearer token, with no reason token at all.
    assert.equal(
      payload.error.code,
      "E_GATE_NOT_AUTHORIZED",
      `the published address did not reach the callback route: ${res.status} ${JSON.stringify(payload)}`,
    );
    assert.equal(payload.error.details?.reason, "signature");
  } finally {
    await plane.close();
  }
});
