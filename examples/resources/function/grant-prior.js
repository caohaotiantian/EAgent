// The SUCCESS arm of `read-ledger`: an access ledger exists, so this requester has a history.
//
// Its twin is `grant-none.js` on the `error` edge. Exactly one of the two runs, which is why
// `history` is `merge_object` and not `replace` — see the graph's `labels.residue-error-arm`.
//
// A LEDGER THIS BODY CANNOT READ IS A REFUSAL, NOT AN EMPTY HISTORY. The quiet direction is the
// dangerous one: an unreadable ledger read as "no prior grants" turns every renewal back into a
// review, which merely annoys — but it also means `grant-record.js` would APPEND to a document it
// could not parse, and the next run would inherit a ledger with one good entry and a corrupt
// prefix. The ledger is the only record that an access grant ever happened.
(view, ctx) => {
  const raw = view.require("ledgerDoc");

  // §A.83: `fs.read` puts its truncation marker INSIDE the content, so a ledger over the cap
  // comes back as a prefix that may still parse. A prefix of a ledger is a ledger with grants
  // missing from it, and every missing grant reads as "never granted before".
  if (/\n…\[truncated \d+ chars\]$/.test(raw)) {
    return {
      refuse: {
        reason:
          `the access ledger was read back TRUNCATED (${raw.length} chars). A prefix of a ledger is ` +
          `a ledger with grants missing from it, and a missing grant reads here as "never granted ` +
          `before" — so a renewal would be re-reviewed and, worse, the append would overwrite the ` +
          `entries that were cut. Raise maxBytes on the "read-ledger" node.`,
      },
    };
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return {
      refuse: {
        reason:
          `"out/access-ledger.json" is not JSON (${String(e && e.message ? e.message : e)}). This ` +
          `graph appends to that ledger, so a document it cannot parse cannot be appended to ` +
          `without losing whatever is already in it.`,
      },
    };
  }
  if (doc === null || typeof doc !== "object" || !Array.isArray(doc.grants)) {
    return {
      refuse: {
        reason:
          `"out/access-ledger.json" is JSON but not an access ledger: it has no \`grants\` array. ` +
          `Treating it as an empty history would hide every grant it does hold and then replace it.`,
      },
    };
  }

  const request = safeRequest(view.require("request"));
  const mine =
    request === null
      ? []
      : doc.grants.filter(
          (g) => g && typeof g === "object" && g.who === request.who && g.resource === request.resource,
        );

  // TWO LISTS, AND THEY ARE NOT THE SAME LIST. `grants` is THIS requester's history on THIS
  // resource — what decides a renewal and what a person is shown at the gate. `ledger` is every
  // entry the file holds, and it exists for one reason: `grant-record.js` REWRITES the whole
  // document, so appending to the filtered list would delete everybody else's grants. The first
  // draft of this body wrote only the filtered one and would have done exactly that.
  return { writes: { history: { source: "ledger", grants: mine, ledger: doc.grants } } };

  // The request is parsed AGAIN here, and deliberately not shared with `grant-weigh.js`: a code
  // resource is a bare function expression and cannot import a sibling (`examples/README.md` §2).
  // This copy is allowed to give up — `grant-weigh.js` owns the refusal, and a history of []
  // for an unparseable request is correct, because it is about to be refused anyway.
  function safeRequest(text) {
    try {
      const r = JSON.parse(text);
      return r !== null && typeof r === "object" ? r : null;
    } catch {
      return null;
    }
  }
}
