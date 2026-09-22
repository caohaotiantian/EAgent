// Turn a decision into the two documents that leave this run: the grant, and the ledger it is
// appended to. Reached from BOTH arms that end in a grant — straight from the router when the
// ceremony is `auto`, and from the `sign` gate when it is `review` — which is why it reads the
// ceremony off `decision` rather than being told which way it got here.
//
// IT WRITES TEXT, NOT OBJECTS, and that is deliberate: `fs.write`'s `body` argument is a string,
// and `"${grantDoc}"` interpolating an object would hand the disk `[object Object]`. The parsed
// `grant` is written beside it so the suite and the run's own outputs can assert on fields rather
// than on a substring of a document.
//
// WHAT IT CANNOT SAY, said rather than faked: `decidedBy` names the MECHANISM, never the person.
// A body sees `view` and `ctx` and neither carries the approver's subject — the approval is in the
// journal, under the gate. Writing "approved by u:you" here would be the document asserting
// something this code did not establish, which is the entire subject of the second port's F14.
// Who answered the gate is `loom gates` and the journal; this file says only that a human did.
(view, ctx) => {
  const d = view.require("decision");
  const history = view.require("history");
  const at = ctx.now();
  const expiresAt = at + d.hours * 3_600_000;

  const decidedBy =
    d.ceremony === "review"
      ? 'a person, at the "sign" gate — see `loom gates` for who'
      : d.renewalOf !== null
        ? "automatically, as a renewal of an existing grant"
        : "automatically, under the public-tier read rule";

  const grant = {
    requestId: d.requestId,
    who: d.who,
    resource: d.resource,
    tier: d.tier,
    level: d.level,
    hours: d.hours,
    grantedAt: at,
    expiresAt,
    ceremony: d.ceremony,
    decidedBy,
    reason: d.reason,
    renewalOf: d.renewalOf === null ? null : d.renewalOf.at,
  };

  // APPEND, NEVER REPLACE — `history.ledger` is every entry the file held, not just this
  // requester's. The filtered list is `history.grants` and appending to THAT would publish a
  // ledger holding one person's grants and nobody else's.
  const ledger = {
    version: 1,
    note: "Written by examples/graphs/grant-access.json. Append-only: every run adds one entry.",
    grants: [...history.ledger, grant],
  };

  return {
    writes: {
      grant,
      grantDoc: `${JSON.stringify(grant, null, 2)}\n`,
      ledgerNext: `${JSON.stringify(ledger, null, 2)}\n`,
    },
  };
}
