/**
 * Every door that starts a run, enumerated — because the compiler will not enumerate them.
 *
 * `SubmitInput.submittedBy` is OPTIONAL, and an absent principal is the PERMISSIVE case: a
 * run nobody is recorded as owning is readable by every authenticated caller. That grandfather
 * rule is deliberate — it is what makes an upgrade lose nothing — but it means a `submit` call
 * site that simply forgets the field mints a world-readable run, silently, with nothing red.
 *
 * The alternative was a required field with an explicit `{kind:"unowned"}` member, so that
 * forgetting is a type error. It was rejected because it breaks every embedder for a feature
 * they may not use. This test is what stands in its place: the set of call sites is small,
 * closed, and each one's answer is written down. A new door fails here until somebody decides,
 * in words, who owns the runs it starts.
 *
 * It is a grep over `src/`, which is exactly the shape `docs-drift.test.ts` uses for the same
 * kind of question. `grep -a` throughout: macOS grep silently skips files with non-ASCII
 * bytes and several of these have them, so a plain grep would report an empty set and pass.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

/**
 * The four doors, and who owns the runs each starts.
 *
 * Keyed by `file:line`-independent identity — the file — because a line number changes under
 * any edit above it and would make this a test about formatting.
 */
const CALLERS: Readonly<Record<string, string>> = {
  "server/http.ts":
    "supplies it, from the CREDENTIAL and never the request body. This is the door real " +
    "deployments use, and the one place a principal is actually authenticated.",
  "cli.ts":
    "supplies it ONLY with `--as`. The CLI authenticates nobody, so inventing a subject would " +
    "be the synthetic-subject failure the perimeter refuses one door over; recording none " +
    "leaves the run in the permissive set and makes separationOfDuties refuse loudly.",
  "run/engine.ts":
    "the subgraph child, which INHERITS the parent's principal — a delegated run belongs to " +
    "whoever started the parent.",
  "run/replay.ts":
    "the shadow run, which carries the RECORDED principal forward so a replayed gate is " +
    "resolved against the same exclusions the original was. Phase 3 wires it; until then the " +
    "shadow store is in-memory and unreachable by any control plane.",
};

function submitSites(): string[] {
  // `-r` over the whole tree, `-a` so a file containing `→` or `·` is not skipped as binary,
  // `-l`-less because the file is the identity we want and grep prints it per match.
  const out = execFileSync("grep", ["-ran", "\\.submit(", SRC], { encoding: "utf8" });
  return [
    ...new Set(
      out
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => l.slice(SRC.length + 1).split(":")[0]!),
    ),
  ].sort();
}

test("EVERY CALLER OF Engine.submit HAS DECIDED WHO OWNS THE RUNS IT STARTS", () => {
  assert.deepEqual(
    submitSites(),
    Object.keys(CALLERS).sort(),
    "a `submit` call site was added or removed. Decide who owns the runs it starts and say so " +
      "in CALLERS — an omitted principal is not a neutral default, it is a run every " +
      "authenticated caller can read and cancel.",
  );
});

test("the registry says something about each, rather than merely listing it", () => {
  for (const [file, why] of Object.entries(CALLERS)) {
    assert.ok(why.length > 40, `${file} needs a reason, not a placeholder`);
  }
});
