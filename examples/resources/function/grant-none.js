// The ERROR arm of `read-ledger`: the read failed, and this body decides what the failure MEANS.
//
// This is the whole reason this workflow has a `kind: "error"` edge in it. The ledger is read at
// the start of the run and written at the end, so the two arms are not two hypotheticals — they
// are the FIRST run of the command and every later one.
//
// IT READS WHY, AND ONLY ONE ANSWER IS AN EMPTY HISTORY. `read-ledger:error` is that node's
// reserved error projection (DESIGN.md D8): `{ok, code, message}`, folded out of the journal by
// the runtime. `E_FS_NOT_FOUND` — the file is not there — is the first run, and the history is
// empty. EVERYTHING ELSE IS A REFUSAL, because `grant-record.js` rewrites the whole ledger from
// what this arm returns, so an empty history here REPLACES whatever the file held:
//
//   E_FS_UNREADABLE  the ledger is there and cannot be read (chmod 000, chmod 222, a directory)
//   E_CAP_DENIED     the jail will not resolve the path (an unsearchable `out/`, an escaping link)
//   anything else    a code this body was not written for
//   no projection    nothing said why at all — never read as "there is nothing here"
//
// Before D8 this arm was handed no reason, all of those were one code, and it answered every one
// of them with an empty history: `chmod 333 out` over an unreadable ledger made the run succeed
// and destroy a prior grant, exit 0 (TODO.md §A.90).
//
// `source` is carried into the report so the person at the gate can see WHICH arm produced the
// history they are being shown, and `absent` is the code the runtime reported. The CODE and not
// the message: the message names the workspace's absolute path, and a channel holding it would
// make this run's state depend on where the workspace happens to live.
//
// Both keys its twin writes, and both empty: `grants` is this requester's history (nothing) and
// `ledger` is every entry the file holds (there is no file). `grant-record.js` rewrites the whole
// document from `ledger`, so an absent key here would be a `undefined.concat` at the far end of
// the graph rather than an empty ledger — the two bodies have to agree on the SHAPE, not only on
// the channel name.
(view, ctx) => {
  const fact = view.get("read-ledger:error");
  if (fact !== undefined && fact !== null && fact.ok === false && fact.code === "E_FS_NOT_FOUND") {
    return {
      writes: { history: { source: "none", absent: fact.code, grants: [], ledger: [] } },
    };
  }
  const said =
    fact === undefined || fact === null
      ? "the runtime handed this arm no error projection for it"
      : fact.ok === true
        ? "its error projection says it SUCCEEDED, which an error arm cannot have been reached by"
        : `it failed ${String(fact.code)}: ${String(fact.message)}`;
  return {
    refuse: {
      reason:
        `"out/access-ledger.json" could not be read, and not because it is absent — ${said}. This ` +
        `graph rewrites the whole ledger at the end of the run, so treating this as "no prior grants" ` +
        `would publish a ledger rebuilt from nothing and destroy every grant the file holds. Fix what ` +
        `the code names (the file's or out/'s permissions, a link, a directory at the path), or move ` +
        `the ledger aside deliberately if you mean to start a new one.`,
    },
  };
}
