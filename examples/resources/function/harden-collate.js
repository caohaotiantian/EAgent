/**
 * `function/harden-collate@stable` — turn the settled manifest and the fix log into the three
 * things the rest of the graph needs: what the gate SHOWS, and the two files it guards.
 *
 * `report` is what `loom gates <runId>` prints under `reads`, because `review` declares
 * `"reads": ["report"]`. It is therefore the one object in this workflow written for a person
 * rather than for a machine, and the three questions it has to answer before anybody types
 * `loom approve` are:
 *
 *  1. **What changed?** `applied`, in order, each entry carrying the value before and after. Three
 *     of the eight on the shipped manifest are marked `cascadeOf` — findings that did not exist
 *     when the run started and that only a re-audit could have found. `cascades` counts them,
 *     because that number is the argument for the loop.
 *  2. **What did NOT get fixed?** `open`. A finding the fixer cannot repair does not stop the
 *     loop (see `harden-audit.js` on what `settled` means) and it must not vanish either: it is
 *     the reason a person is reading this at all.
 *  3. **Did it finish, or did it run out of road?** `stoppedBy` is `"settled"` or `"budget"`. A
 *     run that exhausted its pass budget has a manifest that is BETTER and not DONE, and
 *     approving one without knowing which is which is the defect this whole workflow is against.
 *
 * `hardened` is the JSON that `out/service.hardened.json` gets and `summary` the markdown that
 * `out/harden-report.md` gets. Both are strings, because a `tool` node interpolates `${hardened}`
 * and `${summary}` into `fs.write`'s `body`, and both are produced HERE rather than in the writer
 * nodes so that what the gate is shown and what lands on disk are computed once, from one state.
 *
 * NOTHING HERE REFUSES. Every refusal in this workflow belongs upstream, where the state that
 * would be wrong is still being made; by this node the run has either settled or spent its budget,
 * and both are things to report rather than to decline.
 */
function (view, ctx) {
  const manifest = view.require("current");
  const path = String(view.require("manifestPath"));
  const findings = view.require("findings");
  const applied = view.get("applied") || [];
  const settled = view.require("settled") === true;

  const open = findings.slice();
  const cascades = applied.filter((a) => a.cascadeOf !== null && a.cascadeOf !== undefined);
  // `settled` is the auditor's word and it is the one that decides: the budget arm is reached only
  // when the loop stopped with auto-fixable work still on the table.
  const stoppedBy = settled ? "settled" : "budget";

  const report = {
    manifest: path,
    service: manifest.name,
    passes: applied.length,
    stoppedBy: stoppedBy,
    cascades: cascades.length,
    applied: applied,
    open: open,
    hardened: manifest,
  };

  // A trailing newline and a two-space indent, because this file is going into the repository the
  // manifest came from.
  //
  // WHAT IT IS NOT is a minimal diff against the original, and that was measured rather than
  // assumed: `current` comes back out of the channel with its object keys in CANONICAL (sorted)
  // order, whatever order the manifest was written in, because that is what makes a state hash
  // comparable across a replay. So `git diff` against `manifests/orders-api.json` is the whole
  // file, not the eight fixes. The eight fixes are in `applied`, and in the table below, which is
  // why that table exists. See F6 of `docs/workflow-port-2026-09-22.md`.
  const hardened = JSON.stringify(manifest, null, 2) + "\n";

  const lines = [];
  lines.push("# Config hardening — " + manifest.name);
  lines.push("");
  lines.push(
    applied.length + " fix(es) applied to `" + path + "` over " + applied.length + " pass(es); " +
      (stoppedBy === "settled"
        ? "the audit then found nothing further this tool can repair."
        : "**the pass budget ran out with auto-fixable findings still open** — this manifest is better, not done."),
  );
  if (cascades.length > 0) {
    lines.push("");
    lines.push(
      cascades.length + " of those " + applied.length + " fix(es) closed a finding that DID NOT EXIST when the run " +
        "started — each was created by an earlier fix, and only a re-audit after every pass could have found it.",
    );
  }
  lines.push("");
  lines.push("## Applied, in order");
  lines.push("");
  if (applied.length === 0) {
    lines.push("Nothing. The manifest already satisfied every rule this tool can repair.");
  } else {
    lines.push("| pass | rule | where | was | now |");
    lines.push("|---|---|---|---|---|");
    for (const a of applied) {
      lines.push(
        "| " + a.pass + " | `" + a.rule + "`" + (a.cascadeOf ? " *(after `" + a.cascadeOf + "`)*" : "") +
          " | `" + a.at + "` | " + inline(a.was) + " | " + inline(a.now) + " |",
      );
    }
  }
  lines.push("");
  lines.push("## Still open — " + open.length);
  lines.push("");
  if (open.length === 0) {
    lines.push("Nothing.");
  } else {
    for (const f of open) {
      lines.push("- **`" + f.rule + "`** (" + f.severity + ") at `" + f.at + "` — " + f.detail);
      lines.push("  " + (f.autofixable === true ? "Auto-fixable, and not applied: " : "Not auto-fixable. ") + f.remedy);
    }
  }
  lines.push("");
  lines.push("The hardened manifest is `out/service.hardened.json`.");
  const summary = lines.join("\n") + "\n";

  return { writes: { report: report, hardened: hardened, summary: summary } };

  /** A table cell: short values in the clear, anything structured as compact JSON. */
  function inline(v) {
    if (v === null) return "*(absent)*";
    return "`" + (typeof v === "string" ? v : JSON.stringify(v)) + "`";
  }
}
