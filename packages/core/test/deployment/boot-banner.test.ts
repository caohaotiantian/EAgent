/**
 * WHY THIS EXISTS: every spawned-plane test in the tree stands on one unproven sentence.
 *
 * `harness.ts`'s `serving` — and, until this landed, a second private copy of it in
 * `cli/cli.test.ts` — decided "the child has finished booting" by waiting for the substring
 * `"  clock:"` to appear in accumulated stdout, and both wrote the reason down as a fact:
 *
 *     "`  clock:` and not `loom listening` — the LAST stdout line, not the first."
 *     "`clock:` is the last thing written to stdout, and a stream delivers in order, so
 *      seeing it means the whole block has landed."
 *
 * `cli.ts`'s `announce` writes `  models:` after it. The sentence was false, so the
 * conclusion drawn from it — *the whole block has landed* — was unsupported: `serving`
 * returned with 60 bytes of banner still in flight, and every assertion a caller makes on
 * `out` before `stop()` was reading a prefix and passing because the prefix happened to be
 * long enough.
 *
 * TODO.md A.15 records "a rare suite flake, four sightings, never reproduced … the test
 * helper waits for a known-last line on stdout and for nothing on stderr". This file does
 * not reproduce the sighting — see the report; ten loops of the spawned suites under
 * sixteen CPU burners are green. It fixes the part that is decidable at a sha: whether the
 * helper's stated invariant is true, and whether it can be satisfied by a prefix.
 *
 * The three claims below are each a property of the HELPER, not of the product, except the
 * first — which is the product fact the helper is built on, and is therefore the one that
 * has to be measured against a real child rather than asserted in a comment.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BANNER_KEYS, awaitBanner, awaitLine, bannerKeysIn, bannerMissing, completeLines, deployment, serving } from "./harness.ts";

/** The banner `announce` writes, as bytes, so a test can deliver it in pieces of its choosing. */
const FULL_BANNER = `loom listening on http://127.0.0.1:58955\n${BANNER_KEYS.map((k) => `  ${k}: value\n`).join("")}`;

test("THE WAIT ITSELF DOES NOT RETURN ON A PREFIX — the one property no other test here pins", async () => {
  // THIS IS THE TEST THAT WAS MISSING, and its absence is the finding. Measured on 2026-08-28:
  // with `serving`'s wait reverted to the pre-fix `out.includes("  clock:")` and every other
  // test in this file kept, all five stayed GREEN. The reason is in `bannerMissing`'s note —
  // against a real child the whole banner arrives in one chunk on an idle machine, 10 boots out
  // of 10, so an integration probe cannot tell a correct wait from a wrong one. The buffer has
  // to be driven by hand.
  //
  // Sleeps here are SEQUENCING, not measurement: `awaitBanner` polls every 5 ms, so 40 ms is
  // eight opportunities to return early. Nothing below asserts how long anything took. This is
  // the same shape as "`awaitLine` WAITS" further down, for the same reason.
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 40));
  };

  let buf = "";
  let returned = false;
  const done = awaitBanner(
    () => buf,
    () => null,
    (missing) => `never booted: ${missing.join(", ")}`,
    5_000,
  ).then(() => {
    returned = true;
  });

  // Everything up to and including `clock:` — precisely the prefix the old wait accepted.
  const clockEnd = FULL_BANNER.indexOf("  clock:") + FULL_BANNER.slice(FULL_BANNER.indexOf("  clock:")).indexOf("\n") + 1;
  buf += FULL_BANNER.slice(0, clockEnd);
  await settle();
  assert.equal(
    returned,
    false,
    `boot returned on a prefix. \`${JSON.stringify(FULL_BANNER.slice(clockEnd))}\` was still in flight, and a caller ` +
      `reading \`out\` here sees a banner that is missing ${bannerMissing(buf).join(", ")}.`,
  );

  buf += FULL_BANNER.slice(clockEnd);
  await done;
  assert.equal(returned, true, "…and it does return once the whole banner has landed");
});

test("AN UNTERMINATED LAST LINE IS NOT A LANDED BANNER — `bannerMissing`, on synthetic buffers", () => {
  // The predicate on its own, at every boundary that matters. Deterministic, no child, no clock.
  assert.deepEqual([...bannerMissing(FULL_BANNER)], [], "the whole banner is complete");
  assert.deepEqual([...bannerMissing("")], ["the address line", ...BANNER_KEYS]);
  assert.deepEqual(
    [...bannerMissing(FULL_BANNER.slice(0, -1))],
    [BANNER_KEYS[BANNER_KEYS.length - 1]],
    "the last line arrived without its newline — a pipe splits where it likes, so this is a prefix",
  );
  assert.deepEqual(
    [...bannerMissing(FULL_BANNER.replace(/^loom listening on .*\n/, ""))],
    ["the address line"],
    "every key but no address is not a booted plane — `serving` parses the port off that line",
  );
});


test("THE BANNER-KEY SET `serving` WAITS FOR IS THE WHOLE BANNER — measured against a real child", async () => {
  // The regression this catches is the one that was live: a line added to `announce` after
  // the last line the helper names. `serving` would then return with that line in flight,
  // and nothing else in the tree would notice — the old `"  clock:"` wait had exactly this
  // shape and stayed wrong through six releases of the banner.
  //
  // Read AFTER `stop()`, which resolves on `close` — the event that fires once every stdio
  // pipe has drained — so `s.out` here is everything the process wrote and not a prefix of
  // it. That is the whole point: the set is checked against the COMPLETE output.
  const d = deployment();
  try {
    const s = await serving(["serve", "--workspace", d.dir, "--port", "0"]);
    await s.stop();
    assert.deepEqual(
      [...bannerKeysIn(s.out)].sort(),
      [...BANNER_KEYS].sort(),
      `\`announce\` and \`BANNER_KEYS\` disagree. \`serving\` returns as soon as the keys it NAMES have\n` +
        `arrived, so a key it does not name is a line still in flight when a caller reads \`out\`.\n` +
        `Add it to BANNER_KEYS (or drop it) — do not leave the helper guessing.\nstdout:\n${s.out}`,
    );
  } finally {
    d.dispose();
  }
});

test("A PARTIAL LINE IS NEVER MATCHED — a pipe splits where it likes, including mid-token", async () => {
  // The classic cause, and the one that needs no stderr at all. `out.includes(token)` over an
  // accumulating string survives a token split across two chunks, because the accumulation
  // rejoins it — but it also matches while the REST of that line is still in flight, and a
  // caller that then reads a value off the line gets a truncated one. Measured against the
  // real child: under sixteen CPU burners `loom serve`'s 405-byte banner arrived in 2 to 5
  // chunks, one of them 17 bytes, i.e. mid-line.
  //
  // The worst instance is not hypothetical: `serving` parses the bound PORT out of the
  // address line with `/:(\d+)/`, and a chunk boundary inside the digits yields a port that
  // is a valid integer and the wrong socket. `completeLines` is what makes that unreachable,
  // so this drives it at exactly that boundary.
  const banner = "loom listening on http://127.0.0.1:58955\n  clock:  swept every 1000ms\n  models: (mock only)\n";
  for (let cut = 1; cut < banner.length; cut++) {
    let acc = "";
    for (const chunk of [banner.slice(0, cut), banner.slice(cut)]) {
      acc += chunk;
      const lines = completeLines(acc);
      // NOTHING a caller can see may be a prefix of a line the child has not finished.
      for (const l of lines) {
        assert.ok(
          banner.includes(`${l}\n`),
          `chunk boundary at ${cut} exposed ${JSON.stringify(l)}, which is not a complete line of the banner`,
        );
      }
      // Specifically: never a truncated port.
      const port = /loom listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(lines.join("\n"))?.[1];
      assert.ok(port === undefined || port === "58955", `chunk boundary at ${cut} yielded port ${port}`);
    }
    assert.deepEqual(completeLines(acc), ["loom listening on http://127.0.0.1:58955", "  clock:  swept every 1000ms", "  models: (mock only)"]);
  }
});

test("`awaitLine` WAITS — it resolves on a line that had not arrived when it was called", async () => {
  // The integration test below cannot prove this on its own: against a live child the stderr
  // banner has usually already landed by the time anyone asks for it, so "it waited" and "it
  // was already there" look identical. This drives the buffer instead — the line appears only
  // after the call, and its unterminated half appears before that, so a wait that answered on
  // a prefix would return the wrong string rather than block.
  let buf = "";
  const done = awaitLine(() => buf, /NO TOKEN/, "stderr", 5_000);
  await new Promise((r) => setTimeout(r, 20));
  buf += "! NO MOD"; // a prefix of nothing, mid-line
  await new Promise((r) => setTimeout(r, 20));
  buf += "EL ADAPTER — mock only\n! NO TOKEN — every call"; // the wanted line, still unterminated
  await new Promise((r) => setTimeout(r, 20));
  buf += "er is authorized\n";
  assert.equal(await done, "! NO TOKEN — every caller is authorized");
});

test("`awaitLine` REFUSES when it cannot decide — it never answers with the passing value", async () => {
  // The defect class this repo keeps finding: a guard answering its undecidable case with
  // the passing value. A wait that gave up and returned "" would turn every stderr assertion
  // built on it into a pass. It throws, and the message carries the buffer.
  await assert.rejects(
    () => awaitLine(() => "! something else\n", /NO TOKEN/, "stderr", 50),
    /no complete stderr line matched .*NO TOKEN.*\n?[\s\S]*something else/,
  );
  // And a line that is present but UNTERMINATED is not a match — the whole point.
  await assert.rejects(() => awaitLine(() => "! NO TOKEN — every call", /NO TOKEN/, "stderr", 50), /no complete stderr line matched/);
});

test("STDERR IS WAITED ON, NOT RACED — `awaitErr` resolves on a complete line", async () => {
  // The other half of A.15's lead: the helper "waits for nothing on stderr". `serving`
  // returned when stdout's banner was complete, and stderr's warnings are written AFTER it,
  // so a caller asserting on `err` before `stop()` read the empty string — `harness.ts`
  // recorded that as measured and left callers to remember `stop()` first. Remembering is
  // not a mechanism. `awaitErr` is.
  //
  // `! NO TOKEN` is the right probe: it is written by `announce`'s caller after the last
  // stdout line, so it is guaranteed to be in flight at the moment boot returns.
  const d = deployment();
  try {
    const s = await serving(["serve", "--workspace", d.dir, "--port", "0"]);
    try {
      await s.awaitErr(/NO TOKEN — every caller is authorized/);
    } finally {
      await s.stop();
    }
  } finally {
    d.dispose();
  }
});
