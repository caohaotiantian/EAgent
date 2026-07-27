import assert from "node:assert/strict";
import { test } from "node:test";
import { postAnswer, type AnswerResult } from "./client.js";

test("AC8/AC6: postAnswer status mapping via mock fetch", async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      const h = new Headers(init?.headers);
      assert.equal(h.get("Authorization"), "Bearer tok");
      return new Response("{}", { status: 200 });
    };
    const ok = await postAnswer("tok", 1, "yes");
    assert.deepEqual(ok, { status: "resolved" } satisfies AnswerResult);

    globalThis.fetch = async () => new Response("{}", { status: 404 });
    assert.equal((await postAnswer("tok", 1, "x")).status, "gone");

    globalThis.fetch = async () => new Response("bad", { status: 400 });
    const retry = await postAnswer("tok", 1, "x");
    assert.equal(retry.status, "retry");
  } finally {
    globalThis.fetch = orig;
  }
});
