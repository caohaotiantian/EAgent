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
  // fix for a rule that was NOT in it. See F14 of `docs/workflow-port-2026-09-22.md`.
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

  // THE PROJECTION REDACTS ITS OWN CREDENTIALS, AND CANNOT DELEGATE THAT TO THE RUNTIME.
  //
  // `report.hardened` is the manifest as the approver sees it, and a credential this tool could not
  // repair is still in it. The runtime's gate projection does redact by key name — which is how
  // `env.DB_PASSWORD` comes out `[secret]` — but its predicate is NARROWER than this workflow's
  // auditor:
  //
  //   runtime   /^(?:.*_)?(?:password|passwd|secret|token|api[_-]?key|authorization|credential)s?$/i
  //             plus a QUALIFIED_WORDS/QUALIFIERS rule where `token` counts only beside `api`,
  //             `access`, `bearer`, `auth`, … — and `github`, `slack`, `registry`, `ci` are not
  //             qualifiers
  //   auditor   /(PASSWORD|SECRET|TOKEN)$/
  //
  // So `GITHUB.TOKEN` (a dot, not an underscore; `github` not a qualifier) and `MYTOKEN` (no
  // separator at all) are credentials to the auditor and ordinary names to the runtime. Measured: the
  // gate listing said *"GITHUB.TOKEN holds a credential in the clear"* in `open` and printed
  // `"GITHUB.TOKEN": "correcthorsebattery"` in `hardened.env` three fields later. Every manifest this
  // port or its reviewers had written happened to use an underscore, which is the only reason it took
  // three rounds to see.
  //
  // THE RULE THIS ENCODES: a workflow that applies its own credential predicate must redact its own
  // projection. Relying on the platform's predicate means shipping wherever the two disagree, and
  // they disagree in BOTH directions (F13). The auditor hands over `credentialKey` verbatim, because
  // `at` is a dotted path and the hazard is a key containing a dot.
  //
  // The FILE keeps the real value, deliberately: `out/service.hardened.json` is the manifest, and a
  // credential the tool could not move behind a secretRef has to stay in it or the service loses its
  // configuration. What must not carry the bytes is the thing a person READS — the gate listing and
  // `out/harden-report.md`.
  const shown = JSON.parse(JSON.stringify(manifest));
  for (const f of open) {
    if (f.rule !== "plaintext-secret" || typeof f.credentialKey !== "string") continue;
    if (shown.env === null || typeof shown.env !== "object" || Array.isArray(shown.env)) continue;
    if (!Object.prototype.hasOwnProperty.call(shown.env, f.credentialKey)) continue;
    shown.env[f.credentialKey] = redactShape(shown.env[f.credentialKey]);
  }

  const report = {
    manifest: path,
    service: manifest.name,
    passes: applied.length,
    stoppedBy: stoppedBy,
    cascades: cascades.length,
    startedWith: baseline.length,
    applied: applied,
    open: open,
    hardened: shown,
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

  // EVERY INTERPOLATED FIELD GOES THROUGH `cell()`, including the title and the path, and the first
  // version of this escaping covered the `applied` table alone. That was the wrong half: round one's
  // own fix made a dotted env key NON-autofixable, so a hostile key can no longer reach the table at
  // all — it lands in `## Still open` and in nothing else. An env key of `A\u0000B.PASSWORD` therefore
  // put three NUL bytes into `out/harden-report.md` through the unescaped `open` list, at which point
  // `grep` calls the report binary and a reader is told there is nothing to see: exactly the harm the
  // escaping was added to prevent, arriving through the path the escaping did not cover.
  const lines = [];
  lines.push("# Config hardening — " + cell(manifest.name));
  lines.push("");
  // "ONE PER PASS" RATHER THAN "OVER N PASS(ES)". `applied.length` counts FIXES, and this node cannot
  // count loop passes — the run made nine `audit` tasks for eight fixes, and nothing in the state says
  // so. Reporting the fix count twice, once wearing the word "passes", was a number nothing measured
  // dressed as a second measurement. One fix per pass is true by construction (`harden-fix.js` appends
  // exactly one entry per invocation), so that is what it says. (F14 #6.)
  lines.push(
    applied.length + " fix(es) applied to `" + cell(path) + "`, one per pass; " +
      (stoppedBy === "settled"
        ? open.length === 0
          ? "the audit then found nothing further — no rule this tool knows is unsatisfied."
          : "the audit then found nothing further it can REPAIR, and " + open.length +
            " finding(s) remain open for a person."
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
    // SCOPED TO WHAT WAS MEASURED, and the sentence it replaces is the FOURTH instance of F14's class
    // — in the paragraph written to replace the third. "The manifest already satisfied every rule this
    // tool can repair" printed two paragraphs above "Still open — 2 … plaintext-secret", a rule this
    // tool repairs seven times on `legacy-gateway.json`. What the run established is that nothing here
    // was auto-fixable; whether the rules are "satisfied" is the opposite of what `open` says.
    lines.push(
      open.length === 0
        ? "Nothing, and nothing is open: this manifest satisfies all eight rules."
        : "Nothing. No finding here is auto-fixable — see **Still open** below, which is " +
          open.length + " finding(s) a person has to act on.",
    );
  } else {
    lines.push("| pass | rule | where | was | now |");
    lines.push("|---|---|---|---|---|");
    for (const a of applied) {
      lines.push(
        "| " + a.pass + " | `" + cell(a.rule) + "`" + (a.cascadeOf ? " *(after `" + cell(a.cascadeOf) + "`)*" : "") +
          " | `" + cell(a.at) + "` | " + inline(a.was) + " | " + inline(a.now) + " |",
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
      // `severity` is a CONSTANT of the rule table, not a judgement about this manifest — the word
      // "severity" is kept so it does not read as something this run computed.
      lines.push(
        "- **`" + cell(f.rule) + "`** (severity " + cell(f.severity) + ") at `" + cell(f.at) + "` — " +
          cell(f.detail),
      );
      lines.push(
        "  " + (f.autofixable === true ? "Auto-fixable, and not applied: " : "Not auto-fixable. ") + cell(f.remedy),
      );
    }
  }
  lines.push("");
  lines.push("The hardened manifest is `out/service.hardened.json`.");
  const summary = lines.join("\n") + "\n";

  return { writes: { report: report, hardened: hardened, summary: summary } };

  /**
   * A value's SHAPE, in the same form `harden-fix.js` puts in `applied[].was`.
   *
   * Deliberately identical to that one, so the gate shows a credential the same way wherever it
   * appears — `{redacted, chars}` in the fix log and `{redacted, chars}` in the projected manifest.
   * Two spellings of "not shown" would make a reader wonder which is the real redaction.
   */
  function redactShape(v) {
    if (typeof v === "string") return { redacted: "string", chars: v.length };
    if (v === undefined || v === null) return { redacted: "absent" };
    if (Array.isArray(v)) return { redacted: "array", items: v.length };
    return { redacted: typeof v };
  }

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

  /**
   * ONE TABLE CELL, and what a manifest can legally put in one is why this exists.
   *
   * A JSON object key may hold a newline, a `|`, a backtick or a NUL, and every one of those breaks a
   * markdown table — measured: an env key of `"A\nB_PASSWORD"` split the row in half, leaving
   * `` `env.A `` on one line and `B_PASSWORD` on the next, so the table a person approves stopped
   * being a table. A NUL lands in the file verbatim and makes `grep` treat the report as binary,
   * which is how a reader is told there is nothing to see.
   *
   * The escape is deliberately visible rather than clever: a reader has to be able to tell a key
   * that CONTAINS a newline from a key that does not, so it becomes `\n` rather than a space.
   *
   * ONE HELPER FOR TABLE CELLS AND PROSE ALIKE, which costs a `\|` in prose where a bare `|` would
   * have been harmless — markdown renders it as `|` either way. The alternative is two helpers that
   * differ in one character and can drift apart, and this one is applied at **every** interpolation
   * site in the report: the title, the path, the table, and the `## Still open` list. The list is the
   * one that mattered and the one the first version missed.
   */
  function cell(v) {
    return String(v)
      .split("\\").join("\\\\")
      .split("|").join("\\|")
      .split("`").join("'")
      .replace(/[\u0000-\u001f\u007f]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
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
    return "`" + cell(typeof v === "string" ? v : JSON.stringify(v)) + "`";
  }
}
