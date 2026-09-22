/**
 * `function/harden-fix@stable` — decide ONE repair, record it, and hand the loop back to the
 * auditor.
 *
 * IT WRITES NOTHING BUT THE LOG, and the log is the state. `applied` is `append_ordered`, so this
 * body's one contribution per pass is an entry naming the rule, where the repair lands, and the
 * value before and after; `harden-audit.js` folds those entries over the parsed seed to get the
 * manifest. The manifest is therefore a PROJECTION of the fix log and not a second copy of it,
 * which is the only shape that compiles (`GRAPH010_CONCURRENT_WRITE`, F2 of
 * `docs/workflow-port-2026-09-22.md`) and, as it turns out, the shape a person at the gate wants:
 * the `was`/`now` pair on every entry is the diff, in the order it was decided.
 *
 * ONE PER PASS IS THE DESIGN, not a limitation. A remediation a person has to approve is only
 * approvable if they can read it, and "eight changes, applied together, trust me" is not readable.
 * It is also what makes the cascades visible: three of the eight rules in `harden-audit.js` can
 * only fire because an earlier fix landed, and a sweep that fixed everything at once would either
 * miss them or hide them inside one diff.
 *
 * THE LOOP'S BUDGET IS THE GRAPH'S, NOT THIS BODY'S. `len(applied) >= 12` is written on the two
 * `conditional` edges out of `audit` — `repair`'s `when` and `done`'s `when`, exact complements — and
 * nothing here duplicates it. This body could not read it if it wanted to: `ctx.node.out` carries an
 * edge's `maxWidth` and `maxIterations` and neither a loop's `until` nor a conditional's `when` (F6),
 * and the `recheck` back-edge this node owns could not carry the budget anyway, because an `until`
 * there reads this body's own one-element contribution to `applied` rather than the channel (F4).
 * What this body does instead is guarantee PROGRESS, so that a budget is never what stops a
 * converging run. Three refusals, one per way progress can stall:
 *
 *  - **Nothing to fix.** This node is only scheduled while the auditor said `settled: false`, which
 *    means at least one auto-fixable finding. Arriving with none is the graph and the auditor
 *    disagreeing about what `settled` means, and running on would append an empty pass forever.
 *  - **A rule this body cannot repair.** The rule ids are a contract held in two files, because a
 *    code resource is a bare function expression and cannot import its sibling. An id the switch
 *    below does not carry is that contract broken: the auditor will report it again next pass, and
 *    the loop spins to its ceiling and then shows a person a report headlined by an exhausted
 *    budget instead of by the thing they have to decide.
 *  - **A repair that changes nothing.** The honest end of the same failure — a rule whose fix does
 *    not clear its own detector. The value at the finding's `at` is compared before and after, and
 *    an unchanged one refuses HERE, where the rule that did it is still known and can be named,
 *    rather than eleven passes later where it cannot.
 *
 * Each returns `{refuse:{reason}}`, so the run fails as `validation` / `E_FUNCTION_REFUSED`: the
 * graph declined, which is a different claim from the `internal` / `E_INTERNAL` a crash here would
 * wear.
 */
function (view, ctx) {
  const m = view.require("current");
  const findings = view.require("findings");
  const applied = view.get("applied") || [];
  const pass = applied.length + 1;

  const target = findings.filter((f) => f.autofixable === true)[0];
  if (target === undefined) {
    return {
      refuse: {
        reason:
          "pass " + pass + " was asked to fix something and the audit holds no auto-fixable finding " +
          "(" + findings.length + " finding(s), none repairable). This node only runs while the audit " +
          "reported settled: false, so the two disagree about what settled means, and every further " +
          "pass would append nothing and loop again.",
      },
    };
  }

  const env = m.env !== null && typeof m.env === "object" && !Array.isArray(m.env) ? m.env : {};
  const secrets = Array.isArray(m.secrets) ? m.secrets : [];
  const was = at(m, target.at);
  let now;

  switch (target.rule) {
    case "floating-image-tag": {
      const image = String(m.image);
      const slash = image.lastIndexOf("/");
      const segment = image.slice(slash + 1);
      const cut = segment.lastIndexOf(":");
      now = image.slice(0, slash + 1) + (cut === -1 ? segment : segment.slice(0, cut)) + ":" + m.release;
      break;
    }
    case "pull-policy-redundant":
      now = "IfNotPresent";
      break;
    case "runs-as-root":
      now = "app";
      break;
    case "workdir-not-readable":
      now = "/srv/app";
      break;
    case "plaintext-secret": {
      const key = target.at.slice("env.".length);
      now = { secretRef: key.toLowerCase().split("_").join("-") };
      break;
    }
    case "secret-not-declared": {
      // The ref is read back off the manifest rather than out of the finding's prose, so the two
      // cannot drift. The first env value carrying an undeclared secretRef is the one the auditor
      // reported — it reports at most one per pass, for exactly this reason.
      let ref;
      for (const key of Object.keys(env)) {
        const v = env[key];
        if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
        if (typeof v.secretRef !== "string") continue;
        if (secrets.indexOf(v.secretRef) !== -1) continue;
        ref = v.secretRef;
        break;
      }
      // An absent ref leaves `now` equal to `was`, which the no-change refusal below catches.
      now = ref === undefined ? secrets : secrets.concat([ref]);
      break;
    }
    case "debug-logging-in-prod":
      now = "info";
      break;
    case "no-healthcheck":
      now = { httpGet: { path: "/healthz", port: Array.isArray(m.ports) ? m.ports[0] : null } };
      break;
    default:
      return {
        refuse: {
          reason:
            "the audit reported \"" + String(target.rule) + "\" at \"" + String(target.at) + "\" as " +
            "auto-fixable and this body has no repair for it. The rule ids are a contract between " +
            "function/harden-audit@stable and function/harden-fix@stable; one side holds a rule the " +
            "other does not, so the audit would report it again on every remaining pass.",
        },
      };
  }

  if (JSON.stringify(now) === JSON.stringify(was === undefined ? null : was)) {
    return {
      refuse: {
        reason:
          "the repair for \"" + target.rule + "\" at \"" + target.at + "\" leaves that value unchanged " +
          "(" + JSON.stringify(was === undefined ? null : was) + "), so the next audit reports it again, " +
          "and the pass after that, until the budget runs out. The rule's detector and its repair disagree.",
      },
    };
  }

  return {
    writes: {
      applied: [
        {
          pass: pass,
          rule: target.rule,
          at: target.at,
          severity: target.severity,
          cascadeOf: target.cascadeOf === undefined ? null : target.cascadeOf,
          was: was === undefined ? null : was,
          now: now,
        },
      ],
    },
  };

  /** Read a dotted path of at most two segments — every `at` in the rule table is one of those. */
  function at(obj, path) {
    const parts = String(path).split(".");
    let cursor = obj;
    for (const p of parts) {
      if (cursor === null || typeof cursor !== "object") return undefined;
      cursor = cursor[p];
    }
    return cursor;
  }
}
