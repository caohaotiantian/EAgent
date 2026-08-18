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
 * It is a scan of `src/`, the shape `docs-drift.test.ts` and `docs-type-equiv.test.ts` both
 * use for the same kind of question, and it counts sites per file rather than listing files:
 * a second forgetful `submit` inside a file already on the list is precisely the case a set
 * of filenames answers `true` to.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

/**
 * The four doors, and who owns the runs each starts.
 *
 * Keyed by `file:line`-independent identity — the file — because a line number changes under
 * any edit above it and would make this a test about formatting.
 */
const CALLERS: Readonly<Record<string, { readonly sites: number; readonly why: string }>> = {
  "server/http.ts": {
    sites: 1,
    why:
      "supplies it, from the CREDENTIAL and never the request body. This is the door real " +
      "deployments use, and the one place a principal is actually authenticated.",
  },
  "cli.ts": {
    sites: 1,
    why:
      "supplies it ONLY with `--as`. The CLI authenticates nobody, so inventing a subject " +
      "would be the synthetic-subject failure the perimeter refuses one door over; recording " +
      "none leaves the run in the permissive set.",
  },
  "run/engine.ts": {
    sites: 1,
    why:
      "the subgraph child, which INHERITS the parent's principal — a delegated run belongs " +
      "to whoever started the parent.",
  },
  "run/replay.ts": {
    sites: 1,
    why:
      "supplies NOTHING today, so a replayed run is unowned. That is sound only because the " +
      "shadow store is in-memory and reachable by no control plane. It stops being sound the " +
      "moment separationOfDuties lands, because a shadow run with no initiator cannot resolve " +
      "the exclusions the recorded gate carried — see the plan's D17.",
  },
};

/**
 * Every `.submit(` under `src/`, counted PER FILE.
 *
 * Counted rather than merely listed, because the file is not the unit of the guarantee: a
 * SECOND, forgetful `engine.submit({…})` added inside a file already on the list is exactly
 * the world-readable run this test exists to catch, and a set of filenames answers `true` to
 * it. The count is what makes the test about call sites rather than about which modules
 * happen to submit.
 *
 * Read in-process rather than shelled out to `grep`: every other guard here does
 * (`docs-drift`, `docs-type-equiv`, `check-zero-dep`), it needs no `-a` reasoning about files
 * with non-ASCII bytes, and it does not fail on a machine without the binary.
 */
function submitSites(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const hits = readFileSync(full, "utf8").match(/\.submit\(/g);
      if (hits !== null) out[full.slice(SRC.length + 1)] = hits.length;
    }
  };
  walk(SRC);
  return out;
}

test("EVERY CALLER OF Engine.submit HAS DECIDED WHO OWNS THE RUNS IT STARTS", () => {
  const expected = Object.fromEntries(Object.entries(CALLERS).map(([f, v]) => [f, v.sites]));
  assert.deepEqual(
    submitSites(),
    expected,
    "a `submit` call site was added, removed, or duplicated. Decide who owns the runs it " +
      "starts and say so in CALLERS — an omitted principal is not a neutral default, it is a " +
      "run every authenticated caller can read and cancel.",
  );
});

test("the registry says something about each, rather than merely listing it", () => {
  for (const [file, { why }] of Object.entries(CALLERS)) {
    assert.ok(why.length > 40, `${file} needs a reason, not a placeholder`);
  }
});
