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
 * — exit 0, nothing on stderr, and two operator fields gone.
 *
 * `irreversibility` IS NOW A FIELD RATHER THAN A REFUSAL, which is §D.1's other half taken: the
 * argument for why a file named on argv may lower an oversight class is written at
 * `MCP_SERVER_FIELDS`, and the behaviour it buys is driven end-to-end in
 * `test/mcp/irreversibility.test.ts`. What THIS file keeps is the reader's own contract: the four
 * members are the only accepted values, anything else is refused rather than rounded down to the
 * strict default, and absence is still absence.
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

test("AN irreversibility OUTSIDE THE VOCABULARY IS REFUSED, and the refusal names every member", () => {
  // `"safe"` is not a class this binary has, and the tempting handling is to round it to the
  // strict default — which is fail-closed and therefore feels free. It is not free: it hides the
  // typo, and the operator who wrote it walks away believing they lowered something. Refusing is
  // always allowed; a silent no-op is what the whole `onlyKeys` family exists to stop.
  const e = refusalFor({ servers: [{ name: "docs", command: "node", envAllow: ["PATH"], irreversibility: "safe" }] });
  assert.ok(isLoomError(e) && e.code === CODES.E_CONFIG_INVALID, String(e));
  assert.match(e.message, /servers\[0\]\.irreversibility/, "and which row it was in");
  // NAMES ITS MEMBERS. A refusal that says "invalid class" has told the operator they are wrong
  // and nothing else, and the four names are read off `CLASS_DEFAULT_POSTURE` rather than retyped
  // in `cli.ts`, so a fifth member of the union would appear here without an edit.
  for (const member of ["read_only", "reversible_write", "irreversible", "externally_visible"]) {
    assert.match(e.message, new RegExp(member), `the refusal must name ${member}`);
  }
  // AND SAYS WHAT SILENCE MEANS, because the operator reading this refusal is deciding whether to
  // delete the key or fix it, and those have different consequences.
  assert.match(e.message, /omitting it means\s+irreversible/);
});

test("A NON-STRING irreversibility IS REFUSED TOO — `true` is not a class", () => {
  // The shape a hand-edited JSON file actually produces. `Array.includes` on a boolean is false,
  // so this arm costs nothing to hold, but a reader should not have to derive that.
  for (const bad of [true, 3, null, ["read_only"], { class: "read_only" }]) {
    const e = refusalFor({ servers: [{ name: "docs", command: "node", irreversibility: bad }] });
    assert.ok(isLoomError(e) && e.code === CODES.E_CONFIG_INVALID, `${JSON.stringify(bad)}: ${String(e)}`);
    assert.match(e.message, /servers\[0\]\.irreversibility/);
  }
});

test("ALL FOUR MEMBERS ARE ACCEPTED, and each arrives on the row it was written on", () => {
  // The half that matters more than the refusal, and the reason it is written as a loop over the
  // whole vocabulary: a validator that accepts `read_only` and rejects `externally_visible` is a
  // validator nobody notices is wrong until an operator declares the one that tightens.
  for (const member of ["read_only", "reversible_write", "irreversible", "externally_visible"] as const) {
    assert.deepEqual(
      withFile({ servers: [{ name: "docs", command: "node", irreversibility: member }] }, (path) => readMcpServers(path)),
      [{ name: "docs", command: "node", irreversibility: member }],
      `${member} must survive the reader`,
    );
  }
});

test("BOTH KEYS AT ONCE ARE NAMED IN ONE REFUSAL", () => {
  // `irreversability` — the misspelling the new field creates, and the one that would otherwise
  // be the silent half all over again: a server the operator believes is read_only, gating.
  const e = refusalFor({ servers: [{ name: "docs", command: "node", envallow: ["PATH"], irreversability: "read_only" }] });
  assert.match(e.message, /"envallow", "irreversability"/, "an operator fixing one at a time is an operator running this twice");
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

  // And a row that declares only what is required is still a legal row — the optional three are
  // absent rather than refused. THE ABSENT `irreversibility` IS THE POINT: this reader does not
  // fill it in, so nothing downstream can mistake a default this file wrote for a declaration an
  // operator made. `startMcp` applies the default, once, and `test/mcp/irreversibility.test.ts`
  // is what shows the run it produces still stopping.
  const bare = withFile({ servers: [{ name: "docs", command: "node" }] }, (path) => readMcpServers(path));
  assert.deepEqual(bare, [{ name: "docs", command: "node" }]);
  assert.ok(!("irreversibility" in bare[0]!), "silence must stay silence, not become a written default");
});
