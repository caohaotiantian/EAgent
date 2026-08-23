/**
 * `--egress`, `--allow-exec` and `--exec-env` decide what this process may reach outside itself,
 * and each read its value as `String(args.flags[name]).split(",")`.
 *
 * A flag given with no value parses to `true`, and `String(true)` is `"true"`. So a bare flag
 * became the one-element allowlist `["true"]` — while still REGISTERING the tool it enables:
 *
 *     loom compile --allow-exec    granted=[…,proc:exec]  tools=[…,proc.exec]
 *     loom compile --egress        granted=[…,net:fetch]  tools=[…,net.fetch]
 *
 * `capabilitiesOf`'s security argument is that "a tool is registered ONLY when the operator
 * passed the flag that registers it… so 'registered implies granted' says exactly 'the operator
 * asked for this'." A flag with no argument is not that. And `true` is a real executable, so the
 * allowlist was not empty — it was one program nobody named.
 *
 * This is the `String(true)` family that `--token`, `--port`, `--input`, `--as`, `--reason` and
 * every `pathFlag` already refuse. Three flags had escaped it, and they are the three that
 * define this process's reach.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openWorkspace, parseArgs } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-listflag-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What a workspace built from these flags actually holds. */
function opened(dir: string, argv: readonly string[]) {
  const ws = openWorkspace(parseArgs([...argv, "--workspace", dir]));
  try {
    return { granted: [...ws.granted].sort(), tools: Object.keys(ws.engine.tools.manifests()).sort() };
  } finally {
    ws.close();
  }
}

const LIST_FLAGS = ["egress", "allow-exec", "exec-env"] as const;

test("A LIST FLAG WITH NO VALUE IS REFUSED — it would read as the single entry \"true\"", () => {
  const w = workspace();
  try {
    for (const flag of LIST_FLAGS) {
      assert.throws(
        () => opened(w.dir, ["compile", `--${flag}`]),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /no value at all/.test(e.message),
        `--${flag} with no value must be refused`,
      );
      assert.throws(
        () => opened(w.dir, ["compile", `--${flag}=`]),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /empty/.test(e.message),
        `--${flag}= must be refused too — that is what an unset "$VAR" expands to`,
      );
    }
  } finally {
    w.dispose();
  }
});

test("THE CAPABILITY IS NOT GRANTED BY A MALFORMED FLAG", () => {
  // The half that makes this a security fix rather than an ergonomic one. Before, the tool was
  // registered — and `capabilitiesOf` derives the tenant grant FROM the registry, so a bare
  // `--allow-exec` put `proc:exec` in the grant list a graph is compiled against.
  const w = workspace();
  try {
    const bare = opened(w.dir, ["compile"]);
    assert.equal(bare.granted.includes("proc:exec"), false);
    assert.equal(bare.granted.includes("net:fetch"), false);

    const real = opened(w.dir, ["compile", "--allow-exec", "ls", "--egress", "api.example.com"]);
    assert.ok(real.granted.includes("proc:exec"), "a flag WITH a value still works");
    assert.ok(real.granted.includes("net:fetch"));
    assert.ok(real.tools.includes("proc.exec"));

    // And the malformed one grants nothing, because it never gets as far as registering.
    //
    // NAMING THE ERROR, not merely asserting one. A bare `assert.throws` passed under the
    // mutation that deletes the refusal — `v` is then `true`, `true.split` is not a function,
    // and a TypeError satisfies `throws` just as well as the refusal does. "It threw" is not
    // "it refused".
    assert.throws(
      () => opened(w.dir, ["compile", "--allow-exec"]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
    );
  } finally {
    w.dispose();
  }
});

test("a stray comma is refused rather than silently dropped", () => {
  // `--egress a,,b` reads as three entries, one of them blank. Dropping it quietly would make
  // the allowlist differ from what the operator wrote with nothing to show for it.
  const w = workspace();
  try {
    assert.throws(
      () => opened(w.dir, ["compile", "--egress", "api.example.com,,other.example.com"]),
      (e: unknown) => isLoomError(e) && /stray comma/.test(e.message),
    );
    assert.throws(() => opened(w.dir, ["compile", "--allow-exec", "ls,"]), (e: unknown) => isLoomError(e));
  } finally {
    w.dispose();
  }
});

test("entries are TRIMMED, and a whitespace-only entry is therefore a stray comma", () => {
  // The observable consequence of trimming, which is what makes it testable at all. Asserting
  // that `--egress "a, b"` still registers `net.fetch` proved nothing — it registers either way,
  // and the mutation removing `.trim()` left that green.
  //
  // With trimming, `"a, ,b"` has a blank middle entry and is refused. Without it, the middle
  // entry is a single space and becomes a host in the allowlist that nobody typed.
  const w = workspace();
  try {
    assert.throws(
      () => opened(w.dir, ["compile", "--egress", "api.example.com, ,other.example.com"]),
      (e: unknown) => isLoomError(e) && /stray comma/.test(e.message),
      "a whitespace-only entry must be caught, which requires trimming before the blank check",
    );
    // And an ordinary space after a comma is still just formatting.
    const r = opened(w.dir, ["compile", "--egress", "api.example.com, other.example.com"]);
    assert.ok(r.tools.includes("net.fetch"));
  } finally {
    w.dispose();
  }
});
