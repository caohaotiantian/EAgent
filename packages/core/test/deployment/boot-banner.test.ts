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
 * TODO.md A.20 records "a rare suite flake, four sightings, never reproduced … the test
 * helper waits for a known-last line on stdout and for nothing on stderr". That is the
 * paragraph above; a fifth sighting, on `s.err` after `await s.stop()`, gave A.20 its cause,
 * and the last two tests here are it.
 *
 * **THE STDOUT FIX WAS NOT THE WHOLE FIX, and the shape of what was left is the lesson.** The
 * banner wait above answers "has the child finished WRITING", and the question `stop()` needs
 * answered is "can the child be STOPPED" — a strictly later instant, because `serve` installs
 * its SIGINT handler only after `announce` returns. Measured at 0.28–0.32 ms. Inside it SIGINT
 * has its DEFAULT disposition and the kernel kills the child where it stands, so `stop()` is
 * not a stop, it is a kill, and every line `announce` had left to write is never written.
 * `awaitStoppable` closes it; `stopVerdict` is what refuses if it ever reopens.
 *
 * The other hypothesis — that `close` can fire before stderr has drained — was ELIMINATED,
 * not assumed away: 30 children, 4 MB of stderr each, a deliberately starved parent, 0/30.
 * `harness.ts`'s `stop` records that.
 *
 * The claims below are each a property of the HELPER, not of the product, except the third —
 * which is the product fact the helper is built on, and is therefore the one that has to be
 * measured against a real child rather than asserted in a comment. The two A.20 tests are
 * hand-driven for a reason this file already argues once and which is sharper the second
 * time: a 0.3 ms window is not something a real child can be asked about, and 144 boots under
 * 12-way load are 144 greens either way.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BANNER_KEYS, awaitBanner, awaitLine, awaitStoppable, bannerKeysIn, bannerMissing, completeLines, deployment, serving, stopVerdict } from "./harness.ts";

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
    // STOPPED, NOT KILLED — the distinction A.20 turned on, asserted on the real child rather
    // than assumed. `stopVerdict` throws on a signal death, so this pins the code as well.
    assert.equal(await s.stop(), 0, `a SIGINT the child HANDLED, so \`out\` below is the whole banner.\nstderr:\n${s.err}`);
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

test("`awaitStoppable` WAITS — a listening plane is not yet a stoppable one (A.20)", async () => {
  // THE FIFTH SIGHTING'S CAUSE, driven by hand — and by hand for the reason the first test in
  // this file already argues, only more so. The window between the last banner line and
  // `serveUntilInterrupt`'s SIGINT handler measures 0.28–0.32 ms (ten boots, an external
  // `--import` hook timestamping each write and the handler install), so a real child cannot
  // tell a correct wait from a wrong one: 144 boots under 12-way load were 144 green. Held
  // still — the same hook busy-waiting 60 ms after `! CALLBACK ROUTE OPEN` — the unfixed
  // helper is 10/10 `code=null signal=SIGINT` with stderr ending exactly at that line, which
  // is the sighting; with this wait in front of the stop it is 0/10.
  //
  // Sleeps here are SEQUENCING, not measurement: `awaitStoppable` polls every 5 ms, so 40 ms
  // is eight opportunities to return early. Nothing below asserts how long anything took.
  let answers = 0;
  let returned = false;
  const done = awaitStoppable(
    async () => (answers++ < 3 ? { error: "ECONNREFUSED" } : { status: 401 }),
    () => null,
    (last) => `never answered (${last})`,
    5_000,
  ).then(() => {
    returned = true;
  });
  await new Promise((r) => setTimeout(r, 40));
  await done;
  assert.equal(returned, true);
  // FOUR probes and not one: a wait that returned on the first look would be the defect
  // wearing the fix's name, and it is the only failure mode this test exists to exclude.
  assert.equal(answers, 4, "it must keep asking until the child ANSWERS, not ask once and assume");

  // ANY status is an answer, 401 included — the claim is that the child's event loop turned,
  // which is what proves the handler is on; it is not a claim about authorization. A wait
  // that demanded 200 would hang forever against a tokened plane, which every spawned test
  // in this tree starts.
  await awaitStoppable(async () => ({ status: 401 }), () => null, () => "unused", 5_000);

  // WHEN IT CANNOT DECIDE IT REFUSES, naming the last errno rather than returning and letting
  // the stop become a kill.
  await assert.rejects(
    () => awaitStoppable(async () => ({ error: "ECONNREFUSED" }), () => null, (last) => `never answered (${last})`, 50),
    /never answered \(ECONNREFUSED\)/,
  );
  // And a child that died while it was being waited for is a failure, not a timeout.
  await assert.rejects(
    () => awaitStoppable(async () => ({ error: "ECONNREFUSED" }), () => "it exited (1)", () => "unused", 5_000),
    /it exited \(1\)/,
  );
});

test("A KILLED CHILD IS NEVER REPORTED AS A STOPPED ONE — `stopVerdict` fails closed (A.20)", async () => {
  // The net under the wait above, and the reason it is worth having even once the window is
  // shut: that wait's proof rests on a fact about ANOTHER FILE's control flow — `announce`
  // and `process.on("SIGINT", …)` run in one synchronous stretch in `cli.ts`, so an answered
  // request implies the handler exists. Put an `await` between them and the proof is void
  // with nothing here able to see it.
  //
  // What that regression cost the last five times is not the kill, it is the SILENCE:
  // `close`'s first argument is `null` for a signal death and `stop()` returned it unread, so
  // a child that had been shot mid-banner was indistinguishable from one that stopped, and
  // the failure surfaced hundreds of lines away as a missing stderr line.
  assert.equal(stopVerdict(["serve"], 0, null, ""), 0);
  assert.equal(stopVerdict(["serve"], 1, null, ""), 1, "a non-zero EXIT is a verdict the caller may assert on, not a refusal");
  assert.throws(
    () => stopVerdict(["serve", "--port", "0"], null, "SIGINT", "! CALLBACK ROUTE OPEN — …\n"),
    (e: Error) =>
      /was KILLED by SIGINT, not stopped by it/.test(e.message) &&
      /PREFIX of what it meant to write/.test(e.message) &&
      /TODO A\.20/.test(e.message) &&
      /CALLBACK ROUTE OPEN/.test(e.message),
    "it must name the race and hand back what stderr actually held",
  );
  // Not only SIGINT: any signal death means the same thing about `out` and `err`.
  assert.throws(() => stopVerdict(["serve"], null, "SIGKILL", ""), /was KILLED by SIGKILL/);
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
