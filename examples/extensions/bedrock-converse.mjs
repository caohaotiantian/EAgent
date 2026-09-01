/**
 * A THIRD WIRE, from the binary, with no fork — `loom … --extension-module <this file>`.
 *
 * WHY THIS FILE EXISTS: to be the thing a stranger copies. `--models-file` speaks two wires,
 * Anthropic's and OpenAI's, and `provider` is a closed set of exactly those two. Everything
 * else is this file. It imports NOTHING from `@loom/core` — it is handed four registries and
 * registers a plain object into one of them — which is the shape of the claim that the runtime
 * has no privileged built-ins.
 *
 * **WHAT HAS ACTUALLY BEEN DRIVEN, and what has not.** Say it here rather than let a reader
 * assume: the CONTRACT below — default export, `{models, tools, channels, identity}`, `provider`, `stream`,
 * `priceOf`, `estimateOf`, the `text_delta`/`done` frames, the route table rewriting
 * `req.model` — is exercised end to end by `packages/core/test/cli/extension-module.test.ts`,
 * through `loom run` and then `loom replay` against an EMPTY registry. What has NOT been
 * pointed at AWS from this repository is the REQUEST: the URL shape, the Converse response
 * envelope, and above all `signRequest`, which is left for you to supply because SigV4 is a
 * credential operation and this repo has no credential and takes no dependencies. Treat the
 * request half as a template you verify, not as a measurement someone made.
 *
 * **THE TRUST POSITION.** This module runs in the host realm with everything `loom` has:
 * your filesystem, your network, your environment. `--extension-module` is argv-only for
 * exactly that reason — the operator who types the path already chose which binary to run.
 * Nothing validates what an adapter returns, deliberately: a coercion applied to a value
 * trusted code produced would be a guard answering an undecidable question with the passing
 * value, and the loud failure is the better one. An adapter that yields a `usage` without a
 * finite `costUsd` stops the run at the journal commit, naming `usage.costUsd`.
 *
 *     export AWS_REGION=us-east-1
 *     cat > models.json <<'JSON'
 *     { "routes": { "agent_profile/reviewer@stable":
 *         { "adapter": "bedrock", "model": "anthropic.claude-3-5-sonnet-20240620-v1:0" } } }
 *     JSON
 *     loom run graphs/self-review.json \
 *          --models-file models.json \
 *          --extension-module examples/extensions/bedrock-converse.mjs
 *
 * Note the `models.json` has NO `"adapters"` at all: an adapter this file registered is a
 * legal target for a `routes` row, and `provider` never has to name it.
 */

/** USD per million tokens, by model id prefix. A model outside it prices at 0 — see below. */
const PRICES = {
  "anthropic.claude-3-5-sonnet": { input: 3, output: 15 },
  "anthropic.claude-3-5-haiku": { input: 0.8, output: 4 },
};

/**
 * SUPPLY THIS. It must return the headers Bedrock requires for `body` at `url`, which for
 * AWS means a SigV4 `Authorization` over the canonical request. It is a parameter and not a
 * built-in because a signature is a credential operation: `@loom/core` takes no runtime
 * dependencies, so it cannot ship an AWS SDK, and a hand-rolled SigV4 nobody has driven
 * against the real service is worse than an honest hole.
 */
async function unsigned() {
  throw new Error(
    "bedrock-converse: no signRequest supplied. Pass one to the factory — it must return the " +
      "SigV4 headers for the request. This module deliberately ships no signer.",
  );
}

class BedrockConverseAdapter {
  /**
   * The name a `routes` row points at, and the name the journal records for every call this
   * adapter serves. It is the adapter's identity, not the model's.
   */
  provider = "bedrock";

  constructor(opts = {}) {
    this.region = opts.region ?? process.env["AWS_REGION"] ?? "us-east-1";
    this.signRequest = opts.signRequest ?? unsigned;
    this.maxTokens = opts.defaultMaxTokens ?? 4096;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  /**
   * `req.model` ARRIVES ALREADY REWRITTEN by the `--models-file` route table, so what reaches
   * here is a Bedrock model id and never `agent_profile/reviewer@stable`. That rewrite is the
   * one thing a third-wire adapter would otherwise have to reinvent.
   */
  async *stream(req, signal) {
    const url = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(req.model)}/converse`;
    const body = JSON.stringify({
      // Bedrock keeps the system prompt out of `messages`, unlike the OpenAI wire.
      ...(req.system === undefined || req.system === "" ? {} : { system: [{ text: req.system }] }),
      messages: req.messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: [{ text: m.content }] })),
      inferenceConfig: { maxTokens: req.maxTokens ?? this.maxTokens },
    });
    const headers = { "content-type": "application/json", ...(await this.signRequest({ url, body, region: this.region })) };
    const res = await this.fetch(url, { method: "POST", headers, body, signal });
    if (!res.ok) throw new Error(`bedrock-converse: ${String(res.status)} ${await res.text()}`);
    const doc = await res.json();

    const text = (doc.output?.message?.content ?? []).map((c) => c.text ?? "").join("");
    // TWO FRAMES, and the engine needs both: the deltas are what a watcher streams, and the
    // `done` frame is what the journal records. `usage` must carry a FINITE `costUsd` — the
    // adapter is the only thing that knows what its own call cost.
    yield { type: "text_delta", text };
    const usage = { inputTokens: doc.usage?.inputTokens ?? 0, outputTokens: doc.usage?.outputTokens ?? 0 };
    yield {
      type: "done",
      message: { role: "assistant", content: text },
      finishReason: doc.stopReason === "max_tokens" ? "length" : "stop",
      usage: { ...usage, costUsd: this.priceOf(req.model, usage), wallMs: 0 },
    };
  }

  /**
   * AN UNKNOWN MODEL PRICES AT 0, which is what every adapter in this repo does — and it is
   * why `loom serve` prints an UNPRICED ROUTE line at boot naming any route whose model this
   * table does not cover. A budget compares against a number: a route priced at zero spends
   * without limit while reporting `costUsd: 0`.
   */
  priceOf(model, usage) {
    const key = Object.keys(PRICES).find((k) => model.startsWith(k));
    if (key === undefined) return 0;
    const p = PRICES[key];
    return ((usage.inputTokens * p.input) / 1e6) + ((usage.outputTokens * p.output) / 1e6);
  }

  /**
   * THE WORST CASE, not the likely one. The engine reserves this against the run's budget
   * BEFORE the call, so a fan-out of 25 branches cannot each see the same remaining balance.
   * Over-estimating refuses work that would have fit; under-estimating lets work through,
   * and only the second is a broken guard.
   */
  estimateOf(req) {
    const chars = req.messages.reduce((n, m) => n + m.content.length, (req.system ?? "").length);
    return this.priceOf(req.model, { inputTokens: Math.ceil(chars / 4), outputTokens: req.maxTokens ?? this.maxTokens });
  }
}

/**
 * THE CONTRACT: a default export that is a function, called once with
 * `{models, tools, channels, identity}` before any configuration is read. Registering nothing is
 * a refusal to boot — a module that silently did nothing would be a deployment the operator
 * believes is extended and is not.
 *
 * FOUR SEAMS, AND THIS MODULE DESTRUCTURES ONE. `tools.register(tool)` adds an in-process
 * tool; `channels.register(channel)` adds a delivery transport that is not an HTTP webhook, so a
 * plane can have channels with no `--channels-file` at all; `identity.register(source)` decides
 * who a caller is, and a source registered here is a credential — a plane carrying one binds a
 * non-loopback `--host` with no `--token` and no `--identity-file`. A second identity source, or
 * one beside `--identity-file`, is refused: a chain would accept the UNION of two credential
 * sets, which is oversight loosened by load order.
 */
export default ({ models }) => {
  models.register(new BedrockConverseAdapter());
};
