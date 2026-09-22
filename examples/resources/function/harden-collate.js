/**
 * `function/harden-collate@stable` — turn the settled manifest and the fix log into the three
 * things the rest of the graph needs: what the gate SHOWS, and the two files it guards.
 *
 * `report` is what `loom gates <runId>` prints under `reads`, because `review` declares
 * `"reads": ["report"]`. It is therefore the one object in this workflow written for a person
 * rather than for a machine, and the three questions it has to answer before anybody types
 * `loom approve` are:
 *
 *  1. **What changed?** `applied`, in order, each entry carrying the value before and after. Three of
 *     the eight on the shipped manifest closed a finding that was NOT in the first audit — created by
 *     an earlier fix, and findable only by re-auditing. `cascades` counts them against `baseline`,
 *     the first audit's own finding list, because that number is the argument for the loop and an
 *     argument is worth nothing if it is not measured. `startedWith` is what it is measured against.
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
  const baseline = view.get("baseline") || [];

  const open = findings.slice();

  // A CASCADE IS MEASURED AGAINST THE FIRST AUDIT, NOT READ OFF THE RULE TABLE, and getting that
  // wrong is the one defect a fresh reviewer found in this workflow. `cascadeOf` on an entry is a
  // static property of the RULE — "this rule cannot fire until that one is repaired" — and the first
  // draft counted those declarations and printed the total under the sentence "did not exist when the
  // run started". That sentence is a claim about THIS RUN, and on a manifest whose first audit
  // already reports a cascade-rule finding it was simply false. The graph's own output is such a
  // manifest: a budget stop leaves `secret-not-declared` open, and re-hardening that file reported
  // "2 of those 2 fix(es) closed a finding that DID NOT EXIST when the run started" about a finding
  // that was in the very first audit. So: `baseline` is what the first audit saw, and a cascade is a
  // fix for a rule that was NOT in it. See F11 of `docs/workflow-port-2026-09-22.md`.
  // KEYED ON FINDING IDENTITY — rule AND where AND which — not on the rule NAME, and that was the
  // THIRD instance of this same class. Keying on `rule` alone hid a cascade whenever the rule was
  // already in the baseline for a DIFFERENT subject: a manifest with one plaintext `A_PASSWORD` and a
  // `B_TOKEN` already holding an undeclared secretRef starts with `secret-not-declared` (about
  // `b-token`) in its baseline, so the `secret-not-declared` that pass 1 CREATES (about `a-password`)
  // was counted as pre-existing — three passes, `cascades: 0`, and the sentence suppressed on a run
  // whose whole point was the cascade. `secret-not-declared` shares one `at` ("secrets") across every
  // secret, so `detail` — which names the env key and the ref — is the only thing that tells two of
  // them apart.
  const startedWith = {};
  for (const f of baseline) startedWith[identity(f)] = true;
  const cascades = applied.filter((a) => startedWith[identity(a)] !== true);
  // `settled` is the auditor's word and it is the one that decides: the budget arm is reached only
  // when the loop stopped with auto-fixable work still on the table.
  const stoppedBy = settled ? "settled" : "budget";

  const report = {
    manifest: path,
    service: manifest.name,
    passes: applied.length,
    stoppedBy: stoppedBy,
    cascades: cascades.length,
    startedWith: baseline.length,
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
  // why that table exists. See F9 of `docs/workflow-port-2026-09-22.md`.
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

  /**
   * A finding's identity: the rule, where it lands, AND which one it is.
   *
   * All three, because none of the first two is enough on its own. `at` alone collides across rules;
   * `rule` alone collides across subjects (`secret-not-declared` is reported `at: "secrets"` for
   * every secret there is); and `detail` is the field that names the env key and the ref, which is
   * what actually distinguishes two of them. An applied entry carries `detail` for exactly this.
   */
  function identity(f) {
    return String(f.rule) + "\u0000" + String(f.at) + "\u0000" + String(f.detail === undefined ? "" : f.detail);
  }

  /** A table cell: short values in the clear, anything structured as compact JSON. */
  function inline(v) {
    if (v === null) return "*(absent)*";
    // A redacted `was` (F13) is a SHAPE, not a value, and is rendered as prose so nobody reads
    // `{"redacted":"string","chars":7}` as the thing that was in the file.
    if (v !== null && typeof v === "object" && typeof v.redacted === "string") {
      return v.redacted === "string"
        ? "*(a string of " + v.chars + " chars — not shown)*"
        : v.redacted === "absent"
          ? "*(absent)*"
          : "*(" + v.redacted + " — not shown)*";
    }
    return "`" + (typeof v === "string" ? v : JSON.stringify(v)) + "`";
  }
}
