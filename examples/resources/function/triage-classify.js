/**
 * `function/triage-classify@stable` — one fan-out branch: one shard of test output.
 *
 * WHY THIS IS A `function` BODY AND NOT AN `agent` NODE. A failing test's root cause is READ
 * OFF ITS ERROR SIGNATURE, not inferred: `ERR_MODULE_NOT_FOUND` is a missing dependency and
 * nothing else, `EADDRINUSE` is a port still held and nothing else. Handing that to a model
 * buys nothing and costs the one thing this workflow is for — a bucket you can trust without
 * re-reading the log. The judgement a person actually wants a model for is the NEXT step
 * (which of the fifteen assertion failures share a cause), and that is not what this does.
 *
 * The parse is node:test's TAP output. Two facts carry it: a `# Subtest:` line at column 0
 * names a FILE, while an indented one names a test inside it; and an indented `not ok` is a
 * failing test, while an unindented one is the file that contained it. Writes a ONE-ELEMENT-
 * PER-FAILURE array into `failures`, whose reducer is `append_ordered`, so the branches fold
 * back in branch order rather than in whichever order the reads finished.
 *
 * `raw` ARRIVES AS A ONE-ELEMENT ARRAY, and that is a workaround, not a shape anybody wants.
 * A channel a fan-out node writes must have a multi-writer-safe reducer — GRAPH010 counts
 * `read`'s parallel width and refuses `replace` — even though nothing outside this branch ever
 * reads it, and a branch really does see only its own contribution (`raw.length === 1` here,
 * measured). `join("\n")` rather than `[0]` so a doubled contribution degrades to duplicated
 * text instead of a silently dropped shard.
 */
function (view) {
  const shard = String(view.require("shard"));
  const contributed = view.require("raw");
  const lines = (Array.isArray(contributed) ? contributed.join("\n") : String(contributed)).split("\n");

  // ORDER MATTERS: the first match wins, so the specific signatures come before the general
  // ones. A timed-out test also carries ERR_TEST_FAILURE, and an uncaught TypeError carries
  // it too — the code alone does not separate them.
  const BUCKETS = [
    {
      id: "missing-dependency",
      match: /ERR_MODULE_NOT_FOUND|Cannot find module/,
      remedy: "the import names a module this checkout does not have — restore or install it, then re-run",
    },
    {
      id: "timeout",
      match: /testTimeoutFailure|timed out after/,
      remedy: "the test never settled — look for an un-awaited promise or a callback that is never called",
    },
    {
      id: "port-in-use",
      match: /EADDRINUSE/,
      remedy: "something still holds the port — bind port 0, or tear the server down in an after() hook",
    },
    {
      id: "uncaught-type-error",
      match: /TypeError|ReferenceError/,
      remedy: "a value was absent where the code assumed a shape — the defect is upstream of the assertion",
    },
    {
      id: "assertion",
      match: /ERR_ASSERTION|AssertionError/,
      remedy: "the code and the expectation disagree — decide which of the two is wrong before editing either",
    },
  ];

  const bucketOf = (text) => {
    for (const b of BUCKETS) if (b.match.test(text)) return b;
    return { id: "unclassified", remedy: "no known signature — read this one by hand" };
  };

  // The failure's `error:` value, reduced to the one line a person scans for. A block-scalar
  // error (`error: |-`) whose first line ENDS IN A COLON is a header — node:test writes
  // "Expected values to be strictly equal:" and puts the two values underneath — so the
  // following line is carried too. Without that the whole assertion bucket read
  // "Expected values to be strictly equal:" and named neither value.
  const evidenceOf = (block) => {
    for (let i = 0; i < block.length; i++) {
      const inline = /^\s*error:\s*'?(.+?)'?\s*$/.exec(block[i]);
      if (inline === null) continue;
      if (inline[1] !== "|-") return inline[1];
      const rest = [];
      for (let j = i + 1; j < block.length && rest.length < 2; j++) {
        const next = block[j].trim();
        if (next === "") continue;
        rest.push(next);
        if (!next.endsWith(":")) break;
      }
      return rest.length === 0 ? "(empty)" : rest.join(" ");
    }
    return "(no error line)";
  };

  const failures = [];
  let file = "unknown";
  let i = 0;
  while (i < lines.length) {
    const heading = /^# Subtest: (.+)$/.exec(lines[i]);
    if (heading !== null) {
      file = heading[1].trim();
      i += 1;
      continue;
    }
    // Indented: a TEST that failed. Unindented `not ok` is the file, already named above.
    const failed = /^\s+not ok \d+ - (.+)$/.exec(lines[i]);
    if (failed === null) {
      i += 1;
      continue;
    }
    const block = [];
    let j = i + 1;
    while (j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j])) {
      block.push(lines[j]);
      j += 1;
    }
    const text = block.join("\n");
    const bucket = bucketOf(text);
    failures.push({
      shard: shard,
      file: file,
      test: failed[1].trim(),
      bucket: bucket.id,
      remedy: bucket.remedy,
      evidence: evidenceOf(block),
    });
    i = j + 1;
  }

  return { writes: { failures: failures } };
}
