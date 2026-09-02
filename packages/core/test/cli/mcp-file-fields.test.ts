/**
 * A `--mcp-file` FIELD NOTHING READS IS REFUSED, not dropped.
 *
 * `readMcpServers` validated exactly `name`, `command`, `args` and `envAllow` and then built its
 * result from those four keys, so every other key vanished with no word anywhere. Driven at
 * `0c3c486`, before `MCP_SERVER_FIELDS`:
 *
 *     {"servers":[{"name":"docs","command":"node","envallow":["PATH"],"irreversibility":"safe"}]}
 *     readMcpServers(file) -> [{"name":"docs","command":"node"}]
 *
 * — exit 0, nothing on stderr, and two operator fields gone. `TODO.md` §D.1 records both halves
 * and says only this half is in scope: the refusal. `irreversibility` itself is a decision nobody
 * has taken — `mcp/tools.ts` hardcodes `irreversibility: "irreversible"` on every MCP tool — and
 * accepting the spelling would advertise a capability the binary does not have.
 *
 * ## Why the miscased key is the worse half
 *
 * `envAllow` IS the child's whole environment: `McpClient.start` passes nothing else, so a server
 * whose `envallow` was dropped starts with an empty environment and dies on `spawn npx ENOENT` —
 * a failure two layers from the lowercase `a` that caused it, and the exact failure this reader's
 * own refusal message already spends three lines warning about. That is the same defect class
 * `GRAPH020_UNKNOWN_FIELD` closes for graphs and `onlyKeys` closes for `--models-file` rows.
 *
 * OFFLINE: `readMcpServers` reads a file and returns; no server is started by any test here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMcpServers } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";

function withFile<T>(body: unknown, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "loom-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify(body));
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function refusalFor(body: unknown): Error {
  return withFile(body, (path) => {
    try {
      readMcpServers(path);
    } catch (e) {
      return e as Error;
    }
    return assert.fail(`accepted a row it does not read: ${JSON.stringify(body)}`);
  });
}

test("A MISCASED envAllow IS REFUSED, where it used to be silently dropped", () => {
  const e = refusalFor({ servers: [{ name: "docs", command: "node", envallow: ["PATH"] }] });
  assert.ok(isLoomError(e) && e.code === CODES.E_CONFIG_INVALID, String(e));
  assert.match(e.message, /"envallow"/, "the refusal must name the key that was written");
  // NAMING WHAT RIGHT LOOKS LIKE, which is `onlyKeys`' whole shape: a refusal that says "unknown
  // field" and stops has told the operator they are wrong and nothing else.
  assert.match(e.message, /may declare: name, command, args, envAllow/);
  assert.match(e.message, /servers\[0\]/, "and which row it was in");
});

test("PER-SERVER irreversibility IS REFUSED RATHER THAN ACCEPTED AND IGNORED", () => {
  // The §D.1 field. Refusing it is not implementing it — it is declining to accept a spelling
  // that would leave an operator believing they had lowered an oversight class when every MCP
  // tool still gates. The decision that would make it real is recorded there, not here.
  const e = refusalFor({ servers: [{ name: "docs", command: "node", envAllow: ["PATH"], irreversibility: "safe" }] });
  assert.ok(isLoomError(e) && e.code === CODES.E_CONFIG_INVALID, String(e));
  assert.match(e.message, /"irreversibility"/);
});

test("BOTH KEYS AT ONCE ARE NAMED IN ONE REFUSAL", () => {
  const e = refusalFor({ servers: [{ name: "docs", command: "node", envallow: ["PATH"], irreversibility: "safe" }] });
  assert.match(e.message, /"envallow", "irreversibility"/, "an operator fixing one at a time is an operator running this twice");
  // AND THE MESSAGE SAYS NOTHING ABOUT ADAPTERS. `onlyKeys` is shared with `readModels`, and its
  // sentence used to end "changed nothing about the adapter this row built" and cite an unknown
  // `"provider"` — two claims about a subsystem an mcp file does not configure.
  assert.doesNotMatch(e.message, /adapter|provider/);
});

test("THE CONTROL: the four fields this reader does read are still accepted, and still arrive", () => {
  // The half that matters more than the refusal. A guard that rejects a real field is worse than
  // the silence it replaced, and `envAllow` correctly spelled is the one this test exists to
  // protect: it is the whole child environment.
  const servers = withFile(
    { servers: [{ name: "docs", command: "node", args: ["-e", ""], envAllow: ["PATH", "HOME"] }] },
    (path) => readMcpServers(path),
  );
  assert.deepEqual(servers, [{ name: "docs", command: "node", args: ["-e", ""], envAllow: ["PATH", "HOME"] }]);

  // And a row that declares only what is required is still a legal row — the optional two are
  // absent rather than refused.
  assert.deepEqual(withFile({ servers: [{ name: "docs", command: "node" }] }, (path) => readMcpServers(path)), [
    { name: "docs", command: "node" },
  ]);
});
