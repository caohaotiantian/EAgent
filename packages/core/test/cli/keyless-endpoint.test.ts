/**
 * A REFUSAL THAT PRESCRIBED A FIX THE NEXT LAYER REFUSES.
 *
 * `"apiKeyEnv": null` is the declaration that an endpoint takes no credential, and it exists
 * because a `baseUrl` is not a statement about credentials. The missing-key refusal offers it —
 * and offered it to EVERY row, while only the OpenAI wire has a keyless form. `anthropic.ts`
 * throws `E_PROVIDER_AUTH: anthropic adapter requires an apiKey` on an empty key, `baseUrl` or
 * not. So an operator on an `anthropic` row was told to do a thing, did it, and hit a second
 * refusal in different words one layer down. Measured before the fix:
 *
 *     {"provider":"anthropic","baseUrl":"http://127.0.0.1:9"}
 *       → E_CONFIG_INVALID: … or set "apiKeyEnv": null if this endpoint genuinely takes no
 *         credential (which also needs a "baseUrl").
 *     the same row + "apiKeyEnv": null
 *       → E_CONFIG_INVALID: adapters[0] ("anthropic"): anthropic adapter requires an apiKey
 *
 * It fails closed either way, so nothing was ever loosened. It is here because a remedy that
 * cannot work is the same defect as a cause that is not true, and the second refusal names a
 * field the operator never wrote.
 *
 * Offline: `readModels` is called directly with an explicit `env`, so no variable of the running
 * process is read and no endpoint is contacted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readModels } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";

function scratch(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-keyless-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function modelsFile(dir: string, body: unknown): string {
  const p = join(dir, "models.json");
  writeFileSync(p, JSON.stringify(body));
  return p;
}

const ROUTES = { "agent_profile/summarizer@stable": { adapter: "anthropic", model: "claude" } };

test("THE ANTHROPIC ROW IS NOT OFFERED A KEYLESS ESCAPE, because there is not one", () => {
  const w = scratch();
  try {
    const f = modelsFile(w.dir, { adapters: [{ provider: "anthropic", baseUrl: "http://127.0.0.1:9" }], routes: ROUTES });
    assert.throws(
      () => readModels(f, {}),
      (e: unknown) =>
        isLoomError(e) &&
        e.code === CODES.E_CONFIG_INVALID &&
        /ANTHROPIC_API_KEY/.test(e.message) &&
        // THE DEFECT: this sentence was here, and following it produced a second refusal.
        !/"apiKeyEnv": null/.test(e.message) &&
        /no keyless form/.test(e.message),
      "the refusal must not prescribe a declaration this provider refuses",
    );
  } finally {
    w.dispose();
  }
});

test("…AND IF IT IS WRITTEN ANYWAY, THE REFUSAL IS HERE, naming the adapter's own rule", () => {
  const w = scratch();
  try {
    const f = modelsFile(w.dir, {
      adapters: [{ provider: "anthropic", baseUrl: "http://127.0.0.1:9", apiKeyEnv: null }],
      routes: ROUTES,
    });
    assert.throws(
      () => readModels(f, {}),
      (e: unknown) =>
        isLoomError(e) &&
        e.code === CODES.E_CONFIG_INVALID &&
        // BEFORE: this reader accepted the row and `new AnthropicAdapter` threw
        // `E_PROVIDER_AUTH: anthropic adapter requires an apiKey` — a code and a wording the
        // operator's file never mentions.
        /"apiKeyEnv": null, but the anthropic adapter requires a key at every endpoint/.test(e.message) &&
        /anthropic adapter requires an apiKey/.test(e.message),
      "the file's own reader refuses it, quoting what the adapter would have said",
    );
  } finally {
    w.dispose();
  }
});

test("THE CONTROL — the OpenAI wire's keyless form is untouched", () => {
  const w = scratch();
  try {
    const routes = { "agent_profile/summarizer@stable": { adapter: "ollama", model: "llama3" } };
    const row = { name: "ollama", provider: "openai", baseUrl: "http://127.0.0.1:11434/v1" };

    // Undeclared: still refused, and still offered the declaration that works.
    assert.throws(
      () => readModels(modelsFile(w.dir, { adapters: [row], routes }), {}),
      (e: unknown) => isLoomError(e) && /OPENAI_API_KEY/.test(e.message) && /"apiKeyEnv": null/.test(e.message),
    );
    // Declared: boots. Without this the fix would be "keyless endpoints are banned".
    assert.deepEqual(readModels(modelsFile(w.dir, { adapters: [{ ...row, apiKeyEnv: null }], routes }), {}).adapters, ["ollama"]);
  } finally {
    w.dispose();
  }
});
