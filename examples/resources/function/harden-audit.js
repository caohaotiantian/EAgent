/**
 * `function/harden-audit@stable` — fold the fix log over the parsed manifest, read the result
 * against the deployment policy, and say whether another pass is worth making.
 *
 * THIS NODE DECIDES WHETHER THE LOOP GOES ROUND AGAIN, AND IT IS NOT THE LOOP'S SOURCE. Read the
 * graph rather than this comment if the two ever disagree: the cycle is `audit --repair(conditional
 * when !settled && len(applied) < 12)--> fix --recheck(loop)--> audit`, and the forward exit is
 * `audit --done(conditional when settled || len(applied) >= 12)--> collate`. The two conditionals
 * are exact complements, so every pass leaves this node by exactly one edge.
 *
 * **The back-edge's own `until` is inert, and saying so is the honest version of what this comment
 * used to claim.** It reads `settled`, and `fix` is scheduled only when `settled` was false and
 * writes nothing but `applied` — so `settled` is false wherever that `until` is evaluated and the
 * back-edge is always taken. `maxIterations: 16` is its only real bound. The earlier draft of this
 * paragraph said the loop edge left THIS node, warned that a back-edge leaving `fix` "stops either
 * too early or never", and then shipped exactly that, landing on never. It reads correctly anyway
 * because the convergence decision was moved to the conditionals above, where both `settled` and
 * `applied` are the channel's real values — but the warning was right and the design it described
 * was not the one that compiles. `F3`, `F4` and `F5` of `docs/workflow-port-2026-09-22.md` are why
 * it cannot be: the loop's target needs a non-loop inbound edge or it runs at t=0, and an `until` on
 * `recheck` would read `fix`'s own contribution to `applied` rather than the channel.
 *
 * **THIS BODY OWNS `current`, AND `fix` WRITES NOTHING BUT THE LOG.** The obvious shape — `parse`
 * seeds the manifest, `fix` rewrites it in place — does not compile: `GRAPH010_CONCURRENT_WRITE`
 * says `parse` and `fix` "can run concurrently", because the concurrency analysis drops `loop`
 * edges and `fix`, whose only inbound edge is one, then has no ancestors at all. So the manifest
 * is DERIVED here instead, by folding `applied` over `seed`. (F2 of
 * `docs/workflow-port-2026-09-22.md`, which also argues the derived shape is the better one: it is
 * this project's own "the journal is the only authoritative state" one level down — the fix log is
 * the state, `current` is a projection, and a person at the gate can rebuild the second from the
 * first.)
 *
 * Every fix is a SINGLE PATH ASSIGNMENT at the finding's own `at`, which is what makes the fold
 * possible and is a real constraint on the rule table below: a rule whose repair lands somewhere
 * other than where the finding points cannot be written this way. `secret-not-declared` is the one
 * that had to move — it is reported `at: "secrets"` and names the offending env key in its
 * `detail`, rather than the other way round.
 *
 * **`settled` means "no AUTO-FIXABLE finding remains", not "no finding remains".** A missing
 * healthcheck on a manifest that declares no port is real, reported, and not something this body
 * can repair: there is no probe target to invent. Defining `settled` as "zero findings" would spin
 * the loop to its ceiling on every such manifest and then hand a person a report whose headline is
 * an exhausted budget rather than the one thing they have to decide. Open findings belong at the
 * gate; that is what the gate is.
 *
 * **Why no model.** Every rule below is read off the document structurally. `image` ending in
 * `:latest` is a floating tag and nothing else; `user: "root"` is running as root and nothing else.
 * §5 of `examples/README.md` is the graph that runs offline and means nothing offline; this one,
 * like §8, means exactly what it says because there was never a model in it.
 *
 * THE RULE IDS ARE THE CONTRACT BETWEEN THIS BODY AND `harden-fix.js`. A code resource is a bare
 * function expression and cannot import a sibling, so the table lives twice — detection here,
 * repair there, keyed by the same eight strings. `harden-fix.js` refuses rather than guesses when
 * it is handed an id it has no repair for, which is what keeps the duplication honest: the loop
 * cannot spin on a finding nothing can close.
 *
 * `cascadeOf` names the rule whose REPAIR is the only thing that can make this one fire. Three of
 * the eight carry it, and they are the argument for re-auditing rather than fixing in one sweep:
 * pinning a floating tag makes `pullPolicy: "Always"` redundant, dropping root makes a `/root/...`
 * workdir unreadable, and moving a password behind a `secretRef` obliges the manifest to declare
 * that secret. A one-pass fixer ships a manifest that does not deploy.
 */
function (view, ctx) {
  const seed = view.require("seed");
  const applied = view.get("applied") || [];

  // The fold. JSON round-trip rather than `structuredClone`: the seed came from `JSON.parse` and
  // leaves as JSON, so nothing in it survives one and not the other.
  const m = JSON.parse(JSON.stringify(seed));
  for (const a of applied) assign(m, a.at, a.now);

  const env = m.env !== null && typeof m.env === "object" && !Array.isArray(m.env) ? m.env : {};
  const ports = Array.isArray(m.ports) ? m.ports : [];
  const secrets = Array.isArray(m.secrets) ? m.secrets : [];

  // The tag is whatever follows the last ":" in the final path segment. A ":" earlier in the
  // string is a registry port ("registry.internal:5000/svc"), not a tag, which is why the segment
  // is taken first.
  const segment = String(m.image).split("/").pop();
  const cut = segment.lastIndexOf(":");
  const tag = cut === -1 ? "" : segment.slice(cut + 1);
  const pinned = tag !== "" && tag !== "latest";

  const isRoot = m.user === undefined || m.user === null || m.user === "" || m.user === "root" || m.user === "0" || m.user === 0;
  const secretish = /(PASSWORD|SECRET|TOKEN)$/;

  const findings = [];
  const add = (f) => findings.push(f);

  if (!pinned) {
    const canPin = typeof m.release === "string" && m.release !== "";
    add({
      rule: "floating-image-tag",
      severity: "medium",
      at: "image",
      detail:
        "image \"" + m.image + "\" is " + (tag === "" ? "untagged" : "tagged \"latest\"") +
        ", so what deploys is whatever the registry happens to hold",
      autofixable: canPin,
      remedy: canPin
        ? "pin it to the declared release \"" + m.release + "\""
        : "this manifest declares no \"release\", so there is no version to pin to — add one, or pin the tag by hand",
    });
  }

  if (pinned && m.pullPolicy === "Always") {
    add({
      rule: "pull-policy-redundant",
      severity: "low",
      at: "pullPolicy",
      cascadeOf: "floating-image-tag",
      detail:
        "pullPolicy \"Always\" against the pinned tag \"" + tag + "\", which cannot change — every " +
        "restart pays for a pull that returns the same bytes",
      autofixable: true,
      remedy: "set pullPolicy to \"IfNotPresent\"",
    });
  }

  if (isRoot) {
    add({
      rule: "runs-as-root",
      severity: "high",
      at: "user",
      detail: m.user === undefined ? "no \"user\" is declared, so the container runs as root" : "runs as \"" + String(m.user) + "\"",
      autofixable: true,
      remedy: "run as the unprivileged \"app\" user",
    });
  }

  if (!isRoot && typeof m.workdir === "string" && (m.workdir === "/root" || m.workdir.indexOf("/root/") === 0)) {
    add({
      rule: "workdir-not-readable",
      severity: "medium",
      at: "workdir",
      cascadeOf: "runs-as-root",
      detail:
        "workdir \"" + m.workdir + "\" is root's home, and this manifest no longer runs as root — " +
        "the process cannot read its own working directory",
      autofixable: true,
      remedy: "move the workdir to \"/srv/app\"",
    });
  }

  for (const key of Object.keys(env)) {
    if (!secretish.test(key)) continue;
    if (typeof env[key] !== "string") continue;
    add({
      rule: "plaintext-secret",
      severity: "high",
      at: "env." + key,
      detail: "\"" + key + "\" holds a credential in the clear, in a file that is in version control",
      autofixable: true,
      remedy: "replace the value with a secretRef named \"" + secretName(key) + "\"",
    });
  }

  // Reported `at: "secrets"` and not at the env key, because `at` is where the REPAIR lands and the
  // repair appends to the secrets list.
  //
  // EVERY UNDECLARED REF IS REPORTED, NOT JUST THE FIRST, and the first draft of this rule got that
  // wrong in the direction this whole workflow exists to prevent. It `break`ed after one, reasoning
  // that two findings claiming the same `at` would have the second's `now` computed against a
  // manifest the first had already changed. That is true of REPAIRING and false of REPORTING, and
  // conflating the two cost the report its honesty: on `manifests/legacy-gateway.json`, which
  // exhausts the pass budget with two refs still undeclared, the gate said "Still open — 1". A
  // person adds that one secret, ships, and the deploy still fails at admission on the other.
  //
  // Reporting all of them is safe because `harden-fix.js` applies the FIRST auto-fixable finding and
  // exactly one per pass, so the stale-`now` hazard never arises — the next audit recomputes the
  // whole list against the manifest the last fix produced.
  for (const key of Object.keys(env)) {
    const v = env[key];
    if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
    if (typeof v.secretRef !== "string") continue;
    if (secrets.indexOf(v.secretRef) !== -1) continue;
    add({
      rule: "secret-not-declared",
      severity: "medium",
      at: "secrets",
      cascadeOf: "plaintext-secret",
      detail:
        "\"" + key + "\" reads the secret \"" + v.secretRef + "\", which this manifest's \"secrets\" " +
        "list does not declare — the deploy fails at admission",
      autofixable: true,
      remedy: "add \"" + v.secretRef + "\" to \"secrets\"",
    });
  }

  if (m.stage === "prod" && (env.LOG_LEVEL === "debug" || env.LOG_LEVEL === "trace")) {
    add({
      rule: "debug-logging-in-prod",
      severity: "medium",
      at: "env.LOG_LEVEL",
      detail: "LOG_LEVEL \"" + env.LOG_LEVEL + "\" on a prod manifest — request bodies and headers reach the log sink",
      autofixable: true,
      remedy: "set LOG_LEVEL to \"info\"",
    });
  }

  if (m.healthcheck === undefined || m.healthcheck === null) {
    const canProbe = ports.length > 0 && typeof ports[0] === "number";
    add({
      rule: "no-healthcheck",
      severity: "medium",
      at: "healthcheck",
      detail: "no healthcheck, so the orchestrator cannot tell a wedged process from a healthy one",
      autofixable: canProbe,
      remedy: canProbe
        ? "add an httpGet probe on /healthz at port " + ports[0]
        : "this manifest declares no port, so there is no probe target to add — give it a port, or declare an exec probe by hand",
    });
  }

  // THE STOP RULE, and the only thing the loop edge's `until` reads from this body. `every` over an
  // empty array is true, so a compliant manifest settles on its first audit and the loop is never
  // entered at all.
  const settled = findings.every((f) => f.autofixable !== true);

  // `baseline` is THE FIRST AUDIT'S findings, written once and never again — the only pass on which
  // `applied` is empty is the first. `harden-collate.js` needs it to make a MEASURED claim out of
  // "this finding did not exist when the run started": `cascadeOf` in the table above is a static
  // property of the RULE (what must be repaired before this rule can fire at all), and the first
  // draft of the report counted those declarations and presented the total as a fact about this run.
  // On a manifest that already carries a cascade-rule finding on its first audit — which the graph's
  // OWN output does, whenever a budget stop leaves a `secret-not-declared` open — the report then
  // said "2 of those 2 fixes closed a finding that DID NOT EXIST when the run started" about a
  // finding that was in the very first audit. See F11 of `docs/workflow-port-2026-09-22.md`.
  const writes = { current: m, findings: findings, settled: settled };
  if (applied.length === 0) writes.baseline = findings;
  return { writes: writes };

  function secretName(key) {
    return key.toLowerCase().split("_").join("-");
  }

  /** Assign a dotted path of at most two segments — every `at` in the rule table is one of those. */
  function assign(obj, path, value) {
    const parts = String(path).split(".");
    let cursor = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (cursor[p] === null || typeof cursor[p] !== "object") cursor[p] = {};
      cursor = cursor[p];
    }
    cursor[parts[parts.length - 1]] = value;
  }
}
