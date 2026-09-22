// The ERROR arm of `read-ledger`: there is no access ledger yet, so nobody has a history.
//
// This is the whole reason this workflow has a `kind: "error"` edge in it. The ledger is read at
// the start of the run and written at the end, so the two arms are not two hypotheticals — they
// are the FIRST run of the command and every later one. `source` is carried into the report so the
// person at the gate can see WHICH arm produced the history they are being shown: "no prior
// grants" and "we could not find out" must not look the same at a gate.
//
// Both keys its twin writes, and both empty: `grants` is this requester's history (nothing) and
// `ledger` is every entry the file holds (there is no file). `grant-record.js` rewrites the whole
// document from `ledger`, so an absent key here would be a `undefined.concat` at the far end of
// the graph rather than an empty ledger — the two bodies have to agree on the SHAPE, not only on
// the channel name.
(view, ctx) => ({ writes: { history: { source: "none", grants: [], ledger: [] } } })
