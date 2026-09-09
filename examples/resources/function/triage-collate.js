/**
 * `function/triage-collate@stable` — what the join hands on, and the two things a person reads.
 *
 * Writes TWO channels on purpose. `report` is the object the human gate SHOWS an approver and
 * the run's terminal output; `summary` is the markdown the `fs.write` node puts on disk. The
 * split exists because `fs.write` refuses a non-string body, and because the thing worth
 * approving is the ranking, not its serialisation.
 *
 * RANKED BY COUNT, TIE-BROKEN BY NAME — never by arrival. `failures` folds in branch order,
 * but a bucket's rank must not depend on which shard happened to be read first, or two runs
 * over the same evidence would disagree about which cause to fix on Monday.
 *
 * `ctx.now()` is the task's journaled lease timestamp, so `report.at` is the same number on a
 * replay of this run and nothing new is written to produce it.
 */
function (view, ctx) {
  const failures = view.require("failures");

  const byBucket = new Map();
  for (const f of failures) {
    if (!byBucket.has(f.bucket)) byBucket.set(f.bucket, { id: f.bucket, remedy: f.remedy, cases: [] });
    byBucket.get(f.bucket).cases.push({ shard: f.shard, file: f.file, test: f.test, evidence: f.evidence });
  }

  const buckets = [...byBucket.values()]
    .map((b) => ({ id: b.id, remedy: b.remedy, count: b.cases.length, cases: b.cases }))
    .sort((a, b) => (b.count - a.count) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const shards = [...new Set(failures.map((f) => f.shard))].sort();

  const report = {
    at: ctx.now(),
    shards: shards,
    totalFailures: failures.length,
    bucketCount: buckets.length,
    ranking: buckets.map((b) => ({ bucket: b.id, count: b.count })),
    buckets: buckets,
  };

  const out = [];
  out.push("# Test failure triage");
  out.push("");
  out.push(
    failures.length + " failing test(s) across " + shards.length + " report file(s), in " +
      buckets.length + " root-cause bucket(s).",
  );
  out.push("");
  out.push("| rank | root cause | failures |");
  out.push("|---|---|---|");
  buckets.forEach((b, i) => out.push("| " + (i + 1) + " | `" + b.id + "` | " + b.count + " |"));
  for (const b of buckets) {
    out.push("");
    out.push("## " + b.id + " — " + b.count + " failure(s)");
    out.push("");
    out.push(b.remedy);
    out.push("");
    for (const c of b.cases) out.push("- `" + c.file + "` — " + c.test + "  \n  " + c.evidence);
  }
  out.push("");

  return { writes: { report: report, summary: out.join("\n") } };
}
