/**
 * Phase 4 — the `eagent-tui` argument parser (pure, offline, ink-free).
 *
 * `parseTuiArgs` is a dependency-free parser that must run BEFORE Ink or raw mode
 * is ever touched (the AC12 gate runs `node dist/tui/bundle.mjs --help` headless).
 * This file imports ONLY `../../src/tui/args.js` — no `ink`/`react` — so it both
 * pins the parser's branches and asserts that property: the parser is testable
 * with nothing but the standard offline suite. (The `parseControl` unit lives in
 * `transcript.test.tsx`, alongside the App/ink tests it neighbours.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTuiArgs } from "../../src/tui/args.js";

test("parseTuiArgs: no args yields the defaults (auto mode, everything off)", () => {
  assert.deepEqual(parseTuiArgs([]), { help: false, version: false, yolo: false, mode: "auto", monitor: false, instances: [] });
});

test("parseTuiArgs: --monitor sets monitor mode", () => {
  assert.equal(parseTuiArgs(["--monitor"]).monitor, true);
  assert.deepEqual(parseTuiArgs(["--monitor"]).instances, [], "monitor with no --instance leaves instances empty (main defaults it)");
});

test("parseTuiArgs: --instance is repeatable and parses url[,token]", () => {
  const args = parseTuiArgs(["--monitor", "--instance", "http://a:1", "--instance", "http://b:2,secret"]);
  assert.equal(args.monitor, true);
  assert.deepEqual(args.instances, [
    { url: "http://a:1", token: undefined },
    { url: "http://b:2", token: "secret" },
  ]);
});

test("parseTuiArgs: --instance keeps a token containing commas intact (splits on the first comma only)", () => {
  assert.deepEqual(parseTuiArgs(["--instance", "http://a:1,tok,with,commas"]).instances, [
    { url: "http://a:1", token: "tok,with,commas" },
  ]);
});

test("parseTuiArgs: --instance with no value throws", () => {
  assert.throws(() => parseTuiArgs(["--instance"]), /option --instance requires a value/);
});

test("parseTuiArgs: --help / -h set help", () => {
  assert.equal(parseTuiArgs(["--help"]).help, true);
  assert.equal(parseTuiArgs(["-h"]).help, true);
});

test("parseTuiArgs: --version / -v set version", () => {
  assert.equal(parseTuiArgs(["--version"]).version, true);
  assert.equal(parseTuiArgs(["-v"]).version, true);
});

test("parseTuiArgs: --provider / -p take the following value", () => {
  assert.equal(parseTuiArgs(["--provider", "anthropic"]).provider, "anthropic");
  assert.equal(parseTuiArgs(["-p", "mock"]).provider, "mock");
});

test("parseTuiArgs: --model / -m take the following value", () => {
  assert.equal(parseTuiArgs(["--model", "claude-fable-5"]).model, "claude-fable-5");
  assert.equal(parseTuiArgs(["-m", "gpt-4o"]).model, "gpt-4o");
});

test("parseTuiArgs: --yolo sets yolo", () => {
  assert.equal(parseTuiArgs(["--yolo"]).yolo, true);
});

test("parseTuiArgs: --details accepts full | collapsed | auto", () => {
  assert.equal(parseTuiArgs(["--details", "full"]).mode, "full");
  assert.equal(parseTuiArgs(["--details", "collapsed"]).mode, "collapsed");
  assert.equal(parseTuiArgs(["--details", "auto"]).mode, "auto");
});

test("parseTuiArgs: value-taking flags advance past their value (no spurious unknown-option)", () => {
  // The `i++` inside `takeValue` must consume the value so it is not re-read as a
  // flag — a mangled advance would throw "unknown option: mock" here.
  const args = parseTuiArgs(["-p", "mock", "-m", "claude-fable-5", "--yolo", "--details", "collapsed"]);
  assert.deepEqual(args, {
    help: false,
    version: false,
    yolo: true,
    mode: "collapsed",
    provider: "mock",
    model: "claude-fable-5",
    monitor: false,
    instances: [],
  });
});

test("parseTuiArgs: --details with an invalid mode throws", () => {
  assert.throws(() => parseTuiArgs(["--details", "bogus"]), /--details expects full\|collapsed\|auto/);
});

test("parseTuiArgs: an unknown option throws", () => {
  assert.throws(() => parseTuiArgs(["--nope"]), /unknown option: --nope/);
});

test("parseTuiArgs: a value-taking flag with no following value throws", () => {
  assert.throws(() => parseTuiArgs(["--provider"]), /option --provider requires a value/);
  assert.throws(() => parseTuiArgs(["-m"]), /option -m requires a value/);
});

test("parseTuiArgs: a value that looks like a flag (leading '-') is rejected, not consumed", () => {
  assert.throws(() => parseTuiArgs(["--provider", "-x"]), /option --provider requires a value/);
});
