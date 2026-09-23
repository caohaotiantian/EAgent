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

  // A TRUNCATED READ IS NOT A SYNTAX ERROR, and this check exists because the product used to report
  // it as one. `fs.read` caps at `maxBytes` (200,000 bytes unless the node says otherwise), and it
  // once appended a marker INTO the content, so a 1.2 MB manifest arrived as JSON plus
  // `…[truncated N chars]` and `JSON.parse` blamed a "Bad control character". The marker is gone
  // (TODO.md §A.83): the content is now a bare PREFIX, and the fact that it is one travels beside it,
  // on `load`'s reserved projection — `"load:error"` in this node's `reads`, `{ok: true, truncated,
  // bytes}` on a read that succeeded. A prefix of a manifest is the dangerous case, since a prefix
  // that happens to parse audits as a whole manifest with its missing half read as compliance. So
  // the FACT is read, never the content: truncated is a refusal, and a projection that cannot say
  // the read was complete is one too. The graph passes an explicit `maxBytes`, which moves the
  // cliff; this moves the DIAGNOSIS. (F12.)
  const read = view.get("load:error");
  if (read === null || typeof read !== "object" || read.ok !== true || read.truncated !== false) {
    const cut = read !== null && typeof read === "object" && read.truncated === true;
    return {
      refuse: {
        reason: cut
          ? "\"" + path + "\" was read back TRUNCATED: the file is " + String(read.bytes) + " bytes, " +
            source.length + " characters of it arrived and the rest were dropped, because `fs.read` caps " +
            "its output. What is here is not the manifest, and auditing part of a manifest reports the " +
            "absences of the part that is missing as compliance. Raise `maxBytes` on this graph's " +
            "\"load\" node above the file's size."
          : "cannot tell whether \"" + path + "\" was read in full: the \"load\" node's projection says " +
            JSON.stringify(read === undefined ? null : read) + ", not {ok: true, truncated: false}. Auditing a " +
            "manifest that may be partial reports what is missing as compliance.",
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
