# Porting a real workflow, 2026-09-09

`CLAUDE.md` says the bar is *"a multi-agent runtime someone can actually use"*, and that **the next
real workflow somebody ports is worth more than the next invariant somebody proves**. This is one
port, done as a stranger does it — only the published surface, only the shipped binary — plus what
it cost.

Written for somebody who has not read the code.

---

## 1 · What was ported

**`triage-failures` — a red CI run's output, bucketed by root cause, with a human gate before the
report is written.**

A developer's test suite fails across a dozen shards. Somebody has to read all of it and answer one
question: *how many distinct problems is this, really?* Fifteen failing tests are usually three
causes, and the expensive mistake is opening fifteen tickets. That is the chore this graph does.

```
  scan ──seq──▶ plan ──fanout(over: shards, as: shard)──▶ read ──seq──▶ classify ──join──▶ gather
                                                            └──────────────join─────────────┘
  gather ──seq──▶ collate ──seq──▶ approve (human gate) ──seq──▶ write
```

| node | type | what it does |
|---|---|---|
| `scan` | `tool` (`fs.glob`) | finds the report files the `pattern` input names |
| `plan` | `function` | turns that listing into the fan-out's array; **throws if it is empty** |
| `read` | `tool` (`fs.read`) | one branch per shard, in parallel |
| `classify` | `function` | buckets each failing test by its error signature |
| `gather` | `join` | folds the branches back **in branch order** |
| `collate` | `function` | ranks the buckets, writes the object and the markdown |
| `approve` | `human_gate` | a person sees the ranking before anything is written |
| `write` | `tool` (`fs.write`) | `out/triage.md` |

Files added, all inside the published workspace surface — a graph, three `function` bodies, and an
input directory. No fork, no back door, no `--extension-module`, no source change to run it:

```
examples/graphs/triage-failures.json
examples/resources/function/triage-plan.js
examples/resources/function/triage-classify.js
examples/resources/function/triage-collate.js
examples/reports/{unit-shard-1,unit-shard-2,integration}.txt   # the input, not workspace files
```

### The two alternatives, and why they lost

The brief offered three. The decision is recorded because it is the part that generalises.

- **"Review this diff and draft the PR description."** *Rejected as a duplicate and as dishonest
  offline.* `examples/graphs/self-review.json` is already *one agent per changed file → join → fold
  → human gate → irreversible write* over a `git diff`; a PR-description drafter is that graph with
  a different prompt. Worse, its entire substance is the model's prose, so an offline drive would
  be scoring canned text — the exact trap `examples/README.md` §5 already names ("runs offline,
  means nothing offline").
- **"Read a changelog, produce release notes, gate before writing."** *Rejected for the same
  reason at a smaller size.* Everything mechanical about changelog → release notes is string
  munging; the part a person actually wants is the summarising, which is a model call. Stripped of
  the model, the graph is a toy.
- **"Triage failing test output into root-cause buckets."** *Chosen.* A failing test's root cause is
  **read off its error signature**, not inferred — `ERR_MODULE_NOT_FOUND` is a missing dependency
  and nothing else, `EADDRINUSE` is a port still held and nothing else. So it runs offline *and
  means something offline*, which no other candidate managed. It reads real files off disk through
  two built-in tools, it fans out, it gates, and it ends in a write somebody would be annoyed to
  have happen without asking.

**There is no `agent` node in it, and that is a design choice rather than a limitation of running
offline.** Handing a model a signature it can only restate buys nothing and costs the one property
the workflow exists for — a bucket you can trust without reopening the log. The judgement worth a
model here is the *next* step (which of these fifteen assertion failures share a cause), and this
graph deliberately does not pretend to do it.

---

## 2 · The exact commands a stranger runs

From a fresh clone of the repository, in order. Nothing below needs an API key, a network
connection, or an editor.

```bash
npm install && npm run build:binary      # → bin/loom, one file, 0 third-party modules
export PATH="$PWD/bin:$PATH"
cd examples
```

**Compile it.**

```bash
loom compile graphs/triage-failures.json
```

```
ok
  deadline scan (default): timeoutMs=600000
  deadline plan (default): timeoutMs=600000
  deadline read (default): timeoutMs=600000
  deadline classify (default): timeoutMs=600000
  deadline collate (default): timeoutMs=600000
  deadline write (default): timeoutMs=600000
```
exit 0.

**Run it.** It stops at the gate, and nothing has been written.

```bash
loom run graphs/triage-failures.json --input '{"pattern":"reports/*.txt"}'
ls out                                   # ls: out: No such file or directory
```

```
run 01M22PYR3TYZF0K54TYSXV3XBD — inspect it with: loom trace 01M22PYR3TYZF0K54TYSXV3XBD   ← stderr
{
  "runId": "01M22PYR3TYZF0K54TYSXV3XBD",
  "status": "awaiting_gate",
  "outputs": {},
  "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0, "wallMs": 0 }
}
gate gate_01M22PYR4PCBPBAN1YHJTGKKVH on node approve — loom approve 01M22PYR3TYZF0K54TYSXV3XBD gate_01M22PYR4PCBPBAN1YHJTGKKVH --as YOUR_ID
```
exit 0. **Your ids will differ; copy them from your own output.** Below, `$RUN` and `$GATE`.

**Watch it.** The span tree shows the three `read` branches side by side and the run parked on the
gate:

```bash
loom trace $RUN
```

```
loom.run [unset] 26ms
  loom.task scan root [ok] 9ms
  loom.task plan root [ok] 2ms
  loom.task read root/fan[0] [ok] 5ms
  loom.task read root/fan[1] [ok] 5ms
  loom.task read root/fan[2] [ok] 6ms
  loom.task classify root/fan[0] [ok] 4ms
  …
  loom.task approve root [unset] 2ms
    loom.gate approve [unset] 0ms

conformance: ok
```

**See what you are being asked to approve.** `loom gates` gives you the gate's coordinates but not
its content (see friction **F3**); the control plane gives you the content:

```bash
loom gates $RUN                                  # gateId, nodeId "approve", approvers ["u:you"]
loom serve --port 8791 &                         # console at http://127.0.0.1:8791
curl -s http://127.0.0.1:8791/runs/$RUN | python3 -c \
  'import json,sys; print(json.dumps(json.load(sys.stdin)["channels"]["report"]["ranking"], indent=2))'
kill %1
```

```json
[
  {"bucket": "assertion", "count": 2},
  {"bucket": "missing-dependency", "count": 2},
  {"bucket": "port-in-use", "count": 2},
  {"bucket": "timeout", "count": 1},
  {"bucket": "uncaught-type-error", "count": 1}
]
```

**Stop it, if that is your answer.** A cancelled run writes nothing and leaves no open gate:

```bash
loom cancel $RUN --as u:you --reason "triaged by hand instead"
# → {"runId": "…", "status": "cancelled"}                      exit 0
loom gates $RUN            # → []
ls out                     # → still no such file
```

**Or approve it, which is the path that produces the deliverable:**

```bash
loom approve $RUN $GATE --as u:you
cat out/triage.md
```

```markdown
# Test failure triage

8 failing test(s) across 3 report file(s), in 5 root-cause bucket(s).

| rank | root cause | failures |
|---|---|---|
| 1 | `assertion` | 2 |
| 2 | `missing-dependency` | 2 |
| 3 | `port-in-use` | 2 |
| 4 | `timeout` | 1 |
| 5 | `uncaught-type-error` | 1 |

## assertion — 2 failure(s)

the code and the expectation disagree — decide which of the two is wrong before editing either

- `cart/totals.test.ts` — applies a percentage discount
  Expected values to be strictly equal: 1710 !== 1700
…
## missing-dependency — 2 failure(s)

the import names a module this checkout does not have — restore or install it, then re-run

- `billing/invoice.test.ts` — renders a PDF invoice
  Cannot find module 'pdf-render' imported from billing/invoice.ts
- `billing/receipt.test.ts` — emails a receipt
  Cannot find module 'pdf-render' imported from billing/receipt.ts
```

That `missing-dependency` bucket is the whole argument for the workflow: two failures in two
different files are **one** missing package, and a per-file reading of the log hides it.

**Trust what it did.**

```bash
loom replay $RUN      # → {"match": true, "hermetic": true}          exit 0
loom audit  $RUN      # → ok — 16 rule(s) checked, 11 skipped        exit 0
```

`hermetic: true` is the load-bearing word: the three `fs.read` calls, the `fs.write`, and the
human's decision at the gate were all served from the journal rather than re-executed.

**Two refusals worth trying**, because each is a promise:

```bash
loom approve $RUN $GATE --as u:someone-else      # refused — the gate names who may answer it
loom run graphs/triage-failures.json --input '{"pattern":"nope/*.txt"}'
# → "status": "failed" … no test-output files matched — check the --input pattern       exit 1
```

The second is deliberate. A fan-out over an empty array produces no branches and the join folds
nothing, so the run would otherwise **succeed with a report saying zero failures** — which reads as
"your suite is green" when what happened is that you typed the wrong path.

### The test that stops it rotting

```bash
node --test --test-timeout=60000 packages/core/test/examples-triage.test.ts   # 6 pass, 0 fail
node --test --test-timeout=60000 packages/core/test/examples-run.test.ts      # 15 pass, 0 fail
```

Six tests: parks-with-nothing-written, the approval and the exact ranking, the refused approver,
cancel, replay, and the empty-pattern refusal. `examples-run.test.ts` picks the new graph up
without being edited — its set is the directory — so the compile and resource-reachability halves
were already covered.

---

## 3 · Friction log

Every entry is a place the shipped product cost more than it should have. Each carries the exact
command, what happened, and what was expected. **Seven found: three fixed, four logged** with the
file that would have to change.

### F1 · A fan-out branch may hold two nodes, but nothing says so, and it takes two compiles

*Status: logged (documented here and in `examples/README.md` §8; the message itself is unchanged).*
*File: `packages/core/src/graph/validate.ts`, `rule021FanoutHasJoin`.*

The branch is `read` (a `tool`) → `classify` (a `function`). The obvious spelling — collect the
branch's LAST node — is refused:

```bash
$ loom compile graphs/triage-failures.json      # join.branches: ["classify"]
✗ triage-failures.json: GRAPH021_FANOUT_WITHOUT_JOIN: fanout edge "fan" expands "read" but no downstream join waits on it
   fix: add a join node downstream of "read" with branches: [read]
```

Following that `fix:` literally — `branches: ["read"]` — is then refused too:

```bash
$ loom compile graphs/triage-failures.json      # join.branches: ["read"]
✗ triage-failures.json: GRAPH008_BRANCH_NOT_CONNECTED: join "gather" waits on "read", but no edge runs from "read" to "gather"
   fix: add an edge read -> gather with kind: join
```

**Expected**: one diagnostic naming the actual rule — *every node in a fan-out branch needs its own
entry in `join.branches` and its own `"kind": "join"` edge into the join*. **Got**: two, in
sequence, neither of which states it; the answer is the union of the two `fix:` lines. It is
recoverable — the second message does say what to type — but `README.md`, `examples/README.md` and
the compiler all describe a one-node branch, so a reader has no reason to believe a two-node branch
is even legal. Not changed here because the messages are individually correct and rewording a
diagnostic that other suites assert on is not this lane's business.

### F2 · `GRAPH010` refuses a channel that is provably branch-local, and the workaround leaks into the body

*Status: logged.* *File: `packages/core/src/graph/validate.ts`, `rule010ConcurrentWriters`.*

`raw` is written by `read` in branch *i* and read by `classify` in branch *i*. Nothing else touches
it. Declared the natural way:

```bash
$ loom compile graphs/triage-failures.json      # "raw": {"type": "string", "reduce": "replace"}
✗ triage-failures.json: GRAPH010_CONCURRENT_WRITE: node "read" runs up to 8 times in parallel and writes "raw", whose reducer `replace` is not multi-writer safe
   fix: change channel "raw" to reduce: append_ordered (or another commutative reducer)
```

The rule counts `read`'s parallel width and stops. But the runtime **is** branch-scoped, and a
branch really does see only its own contribution. Measured, against the shipped graph with
`triage-classify.js` swapped for a probe that reports `raw.length`:

```js
function (view) {
  const raw = view.require("raw");
  return { writes: { failures: [{ bucket: "probe", remedy: "-", shard: view.require("shard"),
    file: "-", test: "-", evidence: "raw is an array of " + raw.length }] } };
}
```

```bash
$ loom run graphs/triage-failures.json --input '{"pattern":"reports/*.txt"}'
$ loom approve $RUN $GATE --as u:you
$ grep -a "raw is an array" out/triage.md
  raw is an array of 1
  raw is an array of 1
  raw is an array of 1
```

**Expected**: `replace` accepted, because the reducer never folds across branches for this channel.
**Got**: `raw` declared `{"type": "array", "reduce": "append_ordered"}`, and every consumer body
paying for it — `triage-classify.js` carries a `join("\n")` and a five-line comment explaining a
one-element array. The cost is small per graph and paid by every author of a multi-node branch.

The fix is a real analysis, not a message: exempt a channel when every reader is inside the same
fan-out subtree as its writer. Deliberately not attempted here — it is a compiler-safety change,
and *"refusing is always allowed; loosening never is"* means it needs its own adversarial review
rather than a drive-by from an examples lane.

### F3 · `loom gates` shows a digest, not the thing being approved

*Status: logged.* *File: `packages/core/src/cli.ts` (the `gates` verb).*

```bash
$ loom gates 01M22PGS1D1XD6JKS6JRVF6W43
[
  {
    "gateId": "gate_01M22PGS28C0GK7FAAT8NYN9ZF",
    "nodeId": "approve",
    "policyRef": "oversight/triage@stable",
    "contentDigest": "sha256:0ccff0c8abdf0129d424d82def5a571e2ee6f89a786390b72125b0f36b13e6a0",
    "approvers": ["u:you"],
    …
  }
]
```

**Expected**: the thing the approver must judge. The gate node declares `reads: ["report"]`, the run
has computed it, and `README.md`'s own headline for this flow is "trust what it did".
**Got**: a hash. `loom trace` shows the span tree without channel values, and `loom approve` prints
the report only *after* the decision — so on the documented CLI path a human approves a digest.

It is not missing from the product, only from the CLI: the control plane has it, and the console
renders it —

```bash
$ curl -s http://127.0.0.1:8791/runs/$RUN | python3 -c 'import json,sys; print(sorted(json.load(sys.stdin)["channels"]))'
['failures', 'found', 'pattern', 'raw', 'report', 'shards', 'summary']
```

— but `README.md`'s gate walkthrough (`loom run` → `loom approve`) never mentions `loom serve`, so
a reader following it has no way to look. The smallest honest fix is for `loom gates` to print the
channels the gate node reads.

### F4 · `loom run` puts a human hint on **stdout**, after the JSON — so `| jq` breaks on exactly the gate path

*Status: logged, and worked around in the test.* *File: `packages/core/src/cli.ts`.*

```bash
$ loom run graphs/triage-failures.json --input '{"pattern":"reports/*.txt"}' 2>/dev/null | tail -3
  }
}
gate gate_01M22PTJ06F361S41NGBJDEW2H on node approve — loom approve 01M22PTHZ83C28BY1HG6E7GWA1 gate_01M22PTJ06F361S41NGBJDEW2H --as YOUR_ID

$ loom run graphs/triage-failures.json --input '{"pattern":"reports/*.txt"}' 2>&1 1>/dev/null
run 01M22PTJ1ZGBN9CEW25N0JDCNN — inspect it with: loom trace 01M22PTJ1ZGBN9CEW25N0JDCNN
```

**Expected**: the machine-readable object alone on stdout. The product already knows this rule —
the `run … — inspect it with:` hint goes to **stderr**. **Got**: the second hint on **stdout**, so
`loom run … | jq .status` succeeds for a run that completes and fails for one that parks on a gate,
which is precisely the case a script needs to branch on. This is what `E_TOOL…`-free wrapper code
trips over first; `packages/core/test/examples-triage.test.ts` carries a `summary()` helper whose
only job is to cut the line off, with the reason written above it.

### F5 · `loom --help` describes a four-member extension registrar; `README.md` documents ten

*Status: logged.* *File: `packages/core/src/cli.ts` (the `--extension-module` help text).*

```bash
$ loom --help | grep -a -A2 'extension-module P,P'
  --extension-module P,P  host-realm modules to load before anything is configured, as a
                    comma-separated list of paths. Each is imported and its DEFAULT EXPORT
                    called with {models, tools, channels, identity} — this process's
```

and, further down, *"so **FOUR** things need no fork"*. `README.md`'s "Extending it, and where that
stops" documents `{models, tools, channels, identity, functions, hooks, resolver, store, payloads,
jail}` and **nine** `--extension-module` rows — including `store.register`, which the README calls
"the sharpest row on the list". **Expected**: the help and the README to name the same set.
**Got**: a stranger who reads `--help` (the thing in front of them) does not learn that `store`,
`resolver`, `functions`, `hooks`, `payloads` or `jail` exist.

### F6 · `examples/.gitignore` did not ignore `out/`

*Status: **fixed** — `examples/.gitignore`.*

`examples/README.md` §6 tells you to run `self-review.json` in place, and it writes `out/review.json`;
this workflow writes `out/triage.md`. Only `notes/` was ignored, so following the README left
`examples/out/` untracked in `git status` — the residue that `docs/`'s own memory records as
"subagents pollute the repo". One line.

### F7 · `README.md` counts examples that need no model, and the count is now wrong

*Status: logged for the docs lane — this lane must not edit `README.md`.*

`README.md:180` reads *"runs the three that need no model"*, and `README.md:177` splits the examples
as *"§§1–4 work offline with no key; §§5–6 have an `agent` node and want a real model"*. With
`triage-failures` added there are **four** run offline by the suite, and the new one is §8. Both
lines want a pass. `examples/README.md`'s own "Five graphs" line had the same problem and **was
fixed** here, since that file is this lane's to edit.

### Fixed vs. logged

| # | what | status | file that would change |
|---|---|---|---|
| F1 | two-node fan-out branch takes two compiles to discover | documented | `packages/core/src/graph/validate.ts` |
| F2 | `GRAPH010` refuses a provably branch-local channel | logged | `packages/core/src/graph/validate.ts` |
| F3 | `loom gates` shows a digest, not the content | logged | `packages/core/src/cli.ts` |
| F4 | gate hint on stdout after the JSON | logged | `packages/core/src/cli.ts` |
| F5 | `--extension-module` help names 4 of 10 registrar members | logged | `packages/core/src/cli.ts` |
| F6 | `examples/.gitignore` missed `out/` | **fixed** | `examples/.gitignore` |
| F7 | `README.md:177,180` counts are stale | logged | `README.md` (docs lane) |

Also **fixed** while porting, and worth naming because they are the kind of defect an example
carries silently: the classifier's evidence line originally stopped at node:test's
`"Expected values to be strictly equal:"` header and named neither value, so the entire `assertion`
bucket read identically for every case; and the first draft of `triage-plan.js` returned `[]` for a
pattern that matched nothing, which would have reported a clean suite for a mistyped path.

### What did NOT cause friction, and is worth saying

The surface held. Everything in this port is a file a non-committer writes — a `graphs/*.json`, three
`resources/function/*.js` bodies, and an input directory — and the binary needed no flag beyond
`--input` and `--as`. `${pattern}` and `${shard}` interpolation into tool arguments, `fs.glob`'s
listing landing on the node's declared write channel, the gate surviving into a separate process,
the approver check, `cancel`, `replay`'s `hermetic: true`, and the `loom serve` boot banner (which
volunteers `! NO DOOR — triage-failures/approve names u:you`, unasked) all worked first time and are
better than the documentation implies.

---

## 4 · Residue

- **F2 is the one worth building.** A branch-local channel exemption in `rule010ConcurrentWriters`
  removes the only place this port had to distort the graph to satisfy the compiler.
- **F3 is the one worth building next**, and it is small: `loom gates` printing the gate node's
  `reads` channels turns an approval of a hash into an approval of a report.
- **The workflow has no `agent` node**, so it exercises nothing about providers, budgets, retries
  or fallback chains. A port that does needs a live key, and this lane was offline by mandate.
- **The `oversight/triage@stable` ref resolves to nothing**, and correctly: `oversight` is one of
  the two `NAME_ONLY_KINDS`, a policy label rather than a document. Worth knowing before you go
  looking for the file.
- **`loom score` was not driven against this graph.** It has no evaluator node, so `S1` is
  undefined for it; making it scoreable means deciding what "a good triage" is, which is an exam
  the operator writes, not something this port should invent.
