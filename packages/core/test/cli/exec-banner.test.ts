/**
 * The boot banner names every guard that is off — and did not name the loudest one.
 *
 * `loom serve` reports no adapter, no identity source, no token. It said NOTHING about
 * `--allow-exec`, which is the flag that turns off the most: `--help` has stated at the flag
 * for a long time that "a child does its own open(), so allow-listing a shell dissolves the fs
 * jail rather than narrowing it", and a plane started with `--allow-exec /bin/sh` printed a
 * clean banner.
 *
 * Found while checking TODO §E.7's claim that "subprocess isolation plus a filesystem jail plus
 * an egress allowlist covered the stated threat model". All three mitigations are real. The
 * claim is false for one reason: they bind this plane's own tools, and `proc.exec` is a child
 * process. The code already said so; the running process did not.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { execWarnings } from "../../src/cli.ts";

test("no allowlist, no warning — the control, because a banner that always warns is ignored", () => {
  assert.deepEqual(execWarnings(undefined), []);
  assert.deepEqual(execWarnings([]), []);
});

test("a registered exec tool is named, with what it costs", () => {
  const lines = execWarnings(["/usr/bin/grep"]);
  assert.equal(lines.length, 1, "a narrow program gets ONE line, not the interpreter line too");
  assert.match(lines[0]!, /EXEC IS REGISTERED/);
  assert.match(lines[0]!, /\/usr\/bin\/grep/, "the operator must see WHICH program");
  assert.match(lines[0]!, /assertWithin/, "…and which guard it is outside of");
  // The line must not overstate: the run is still gated.
  assert.match(lines[0]!, /it gates before it runs/);
});

test("AN INTERPRETER GETS A SECOND LINE — the allowlist names one entry and permits everything", () => {
  for (const shell of ["/bin/sh", "/bin/bash", "/usr/bin/env", "node", "/usr/local/bin/python3.11", "/usr/bin/xargs"]) {
    const lines = execWarnings([shell]);
    assert.equal(lines.length, 2, `${shell} must trip the arbitrary-code line`);
    assert.match(lines[1]!, /RUNS ARBITRARY CODE/);
    assert.match(lines[1]!, /containment boundary in name only/);
  }
});

test("…and a program that merely LOOKS like one does not", () => {
  // The discriminating control. Matching on a substring rather than the basename would drag
  // these in, and a warning that fires on `shellcheck` is a warning nobody reads.
  for (const benign of ["/usr/bin/shellcheck", "/usr/bin/nodemon", "/opt/pythonic-tool", "/usr/bin/sedative"]) {
    assert.equal(execWarnings([benign]).length, 1, `${benign} is not an interpreter`);
  }
});

test("the interpreter line names the interpreter and the SIZE of the allowlist it defeats", () => {
  const lines = execWarnings(["/usr/bin/grep", "/usr/bin/wc", "/bin/sh"]);
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /\/bin\/sh/, "it must name which entry is the interpreter");
  assert.doesNotMatch(lines[1]!, /grep/, "…and not blame the narrow ones");
  assert.match(lines[1]!, /3 program\(s\)/, "the count is what shows the allowlist is decorative");
});
