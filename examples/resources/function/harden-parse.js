/**
 * `function/harden-parse@stable` — turn the bytes `fs.read` returned into the manifest the loop
 * will rewrite, or refuse.
 *
 * IT EXISTS TO REFUSE. Auditing is a search for absences — no healthcheck, no pinned tag, no
 * declared secret — and a search for absences run against something that is not a manifest finds
 * nothing and reports a clean bill of health. That is this workflow's version of the defect §8
 * names: a document a person is about to approve being wrong with nothing saying so. Both
 * refusals below are that same sentence.
 *
 *  - **The bytes are not JSON.** `JSON.parse` throwing here would normalize to `internal` /
 *    `E_INTERNAL` — the code a genuine bug in this body wears — so the throw is caught and
 *    RETURNED as `{refuse:{reason}}`, which is `validation` / `E_FUNCTION_REFUSED` and never
 *    retried. A file that did not parse will not parse on a second attempt.
 *  - **The JSON is not a service manifest.** `name` and `image` are what every rule in
 *    `harden-audit.js` keys off; a document carrying neither is something else (this workspace
 *    ships `manifests/no-image.json`, a cron entry, to stand for it) and every rule would abstain
 *    on it. Abstaining on all eight prints "0 findings", which reads as "your manifest is already
 *    compliant".
 *
 * The parse is the ONLY place the loop's state is seeded, which is why it is its own node: `audit`
 * runs once per pass and must never reach for `source` again. **`seed` therefore has exactly ONE
 * writer, this node, and is never written again** — the manifest the loop works on is `current`,
 * which `audit` derives by folding `applied` over this seed. That split is not tidiness: a channel
 * written here AND by a node inside the loop is `GRAPH010_CONCURRENT_WRITE`, because the concurrency
 * analysis drops `loop` edges and the loop body then has no ancestors at all (F2 of
 * `docs/workflow-port-2026-09-22.md`).
 */
function (view, ctx) {
  const source = String(view.require("source"));
  const path = String(view.require("manifestPath"));

  // A TRUNCATED READ IS NOT A SYNTAX ERROR, and this check exists because the product reports it as
  // one. `fs.read` caps at 200,000 characters unless the node says otherwise and appends its marker
  // INTO the content rather than beside it, so a 1.2 MB manifest arrives as 200,000 valid characters
  // plus `…[truncated 1000000 chars]` — and `JSON.parse` then blames a "Bad control character at
  // position 200000". The graph now passes an explicit `maxBytes`, which moves the cliff; this moves
  // the DIAGNOSIS, which is the half that survives somebody's manifest being bigger than whatever
  // number is in the graph. (F12.)
  const cut = /\n…\[truncated (\d+) chars\]$/.exec(source);
  if (cut !== null) {
    return {
      refuse: {
        reason:
          "\"" + path + "\" was read back TRUNCATED: " + source.length + " characters arrived and " +
          cut[1] + " more were dropped, because `fs.read` caps its output and marks the cut inside the " +
          "content. What is here is not the manifest, and auditing part of a manifest reports the " +
          "absences of the part that is missing as compliance. Raise `maxBytes` on this graph's " +
          "\"load\" node above the file's size.",
      },
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (e) {
    return {
      refuse: {
        reason:
          "\"" + path + "\" is not JSON (" + String(e && e.message ? e.message : e) + "). This graph " +
          "audits a JSON service manifest; every rule it holds would abstain on a document it cannot " +
          "read, and eight abstentions print as a clean bill of health.",
      },
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      refuse: {
        reason:
          "\"" + path + "\" parsed as " + (Array.isArray(parsed) ? "an array" : String(parsed === null ? "null" : typeof parsed)) +
          ", not a JSON object. A service manifest is an object with at least \"name\" and \"image\".",
      },
    };
  }

  const missing = [];
  if (typeof parsed.name !== "string" || parsed.name === "") missing.push("name");
  if (typeof parsed.image !== "string" || parsed.image === "") missing.push("image");
  if (missing.length > 0) {
    return {
      refuse: {
        reason:
          "\"" + path + "\" is JSON but not a service manifest: it declares no " + missing.join(" and no ") +
          ". Every policy rule keys off those two fields, so all eight would abstain and the report " +
          "would say this manifest is already compliant.",
      },
    };
  }

  return { writes: { seed: parsed } };
}
