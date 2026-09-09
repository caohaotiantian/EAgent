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

**Read this paragraph before you start.** Every block below is copy-pasteable in order, top to
bottom, in ONE shell. Two things make that true and are easy to get wrong if you skim:

- **Run ids are captured into `$RUN` and `$GATE` by the commands themselves.** They are different
  on every run, so nothing here hard-codes one.
- **The gate is answered ONCE.** Approving and cancelling are two different answers to the same
  question, so this walkthrough starts a FRESH run for each. A second verb on an already-answered
  gate is `E_GATE_ALREADY_RESOLVED`, exit 1, which is correct behaviour and not what any of these
  steps is demonstrating. **Five `loom run` invocations in all** — one to read the output of, one
  captured as `$RUN`, one cancelled, one for the wrong-approver refusal, one for the empty-pattern
  refusal. Two of them are deliberately left parked on an open gate; the cleanup at the end takes
  the whole journal.

Nothing below needs an API key, a network connection, or an editor.

**Start in the repository root** — `$PWD` is captured on the second line and everything else hangs
off it, so running the first block from anywhere else silently poisons every later step.

```bash
cd /path/to/this/repository              # wherever you cloned it
npm install && npm run build:binary      # → bin/loom, one file, 0 third-party modules
export REPO="$PWD"                       # the repo root; the test block at the end needs it back
export PATH="$REPO/bin:$PATH"
cd "$REPO/examples"
rm -rf out .loom                         # running the examples in place leaves both behind
```

That last line matters: `out/` and `.loom/` are gitignored, so a checkout somebody has already
experimented in can carry a `triage.md` and a journal from an earlier run — and the first thing
this walkthrough asserts is that `out/triage.md` does not exist yet.

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
exit 0. Six deadlines, not eight: `gather` is a join and `approve` is a gate, and neither runs a
body that could time out.

**Run it.** It stops at the gate, and nothing has been written.

```bash
loom run graphs/triage-failures.json --input '{"pattern":"reports/*.txt"}'
ls out                                   # ls: out: No such file or directory   exit 1
```

stdout (the run id line goes to **stderr**, and is shown here in place so you can see both):

```
run 01M22R66E9GPA00RQXPFA3P8K9 — inspect it with: loom trace 01M22R66E9GPA00RQXPFA3P8K9   ← stderr
{
  "runId": "01M22R66E9GPA00RQXPFA3P8K9",
  "status": "awaiting_gate",
  "outputs": {},
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "costUsd": 0,
    "wallMs": 0
  }
}
gate gate_01M22R66F8N0ZANT0QSMWX6M0H on node approve — loom approve 01M22R66E9GPA00RQXPFA3P8K9 gate_01M22R66F8N0ZANT0QSMWX6M0H --as YOUR_ID
```
exit 0. **That last line is on stdout, after the JSON** — see friction **F4**; it is why the block
below extracts the ids with `grep` rather than `jq`.

Capture the two coordinates the rest of the walkthrough needs:

```bash
RUN=$(loom run graphs/triage-failures.json --input '{"pattern":"reports/*.txt"}' 2>/dev/null \
      | sed -n 's/^  "runId": "\(.*\)",$/\1/p')
GATE=$(loom gates "$RUN" | sed -n 's/^    "gateId": "\(.*\)",$/\1/p')
echo "$RUN $GATE"
```

(That starts run #2 — run #1 above was the one you read the output of. Both are parked on their own
gate; runs are independent and neither is in anybody's way.)

**Watch it.** The span tree shows the three `read` branches side by side and the run parked on the
gate. This is the real output, abridged only where marked:

```bash
loom trace "$RUN"
```

```
trace: graph triage-failures v1 (sha256:b8d474ca…) — the hash run 01M22R66… recorded, from graphs/triage-failures.json
loom.run [unset] 31ms
  loom.task scan root [ok] 10ms
    loom.policy [ok] 0ms
    loom.tool [ok] 4ms
    loom.state.reduce [ok] 0ms
  loom.task plan root [ok] 3ms
    loom.policy [ok] 0ms
    loom.effect (random) [ok] 0ms
    loom.state.reduce [ok] 0ms
  loom.task read root/fan[0] [ok] 8ms
    loom.policy [ok] 0ms
    loom.tool [ok] 3ms
  …read root/fan[1], read root/fan[2], then classify root/fan[0..2], gather, collate, each with
   its own loom.policy child…
  loom.task approve root [unset] 2ms
    loom.policy [ok] 0ms
    loom.gate approve [unset] 0ms

conformance: ok
```

The `loom.effect (random)` under every `function` task is the seeded PRNG draw the engine journals
for the body whether or not the body calls `Math.random()`; it is what makes the replay below
reproduce.

**See what you are being asked to approve.** `loom gates` gives you the gate's coordinates but not
its content — friction **F3**:

```bash
loom gates "$RUN"
```

```json
[
  {
    "gateId": "gate_01M22R66F8N0ZANT0QSMWX6M0H",
    "taskId": "approve@root#0",
    "nodeId": "approve",
    "policyRef": "oversight/triage@stable",
    "contentDigest": "sha256:fd8fb1b7765349b8f8ecabed5e0e53568e494ed748f57ca73e2ec76192393ac4",
    "raisedAtSeq": 74,
    "raisedAtTs": 1788946356712,
    "state": "open",
    "tier": 0,
    "approvers": [
      "u:you"
    ],
    "allowEdit": [],
    "runId": "01M22R66E9GPA00RQXPFA3P8K9",
    "onTimeout": "fail"
  }
]
```

The content is on the control plane. **Start `loom serve` from `examples/`** — `--workspace`
defaults to the current directory, and from the repo root it would find no `graphs/`:

```bash
loom serve --port 8791 >/tmp/loom-serve.log 2>&1 &
SERVE=$!                                          # by PID: `kill %1` needs job control,
                                                  # which a non-interactive shell does not have
until curl -sf "http://127.0.0.1:8791/runs" >/dev/null 2>&1 || ! kill -0 "$SERVE" 2>/dev/null
do sleep 0.2; done                                # the curl below would otherwise race the boot

curl -s "http://127.0.0.1:8791/runs/$RUN" \
  | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["channels"]["report"]["ranking"], indent=2))'

kill "$SERVE"
```

```json
[
  {
    "bucket": "assertion",
    "count": 2
  },
  {
    "bucket": "missing-dependency",
    "count": 2
  },
  {
    "bucket": "port-in-use",
    "count": 2
  },
  {
    "bucket": "timeout",
    "count": 1
  },
  {
    "bucket": "uncaught-type-error",
    "count": 1
  }
]
```

**Approve it — this is the path that produces the deliverable.**

```bash
loom approve "$RUN" "$GATE" --as u:you
cat out/triage.md
```

`loom approve` is not silent: it prints the finished run as JSON — 131 lines — ending in
`"written": {"bytes": 1820, "path": "out/triage.md"}`. (`bytes` is a UTF-16 code-unit count, so
`wc -c` on the 52-line file says 1856 — the report has eighteen multibyte dashes in it.) The file:

```markdown
# Test failure triage

8 failing test(s) across 3 report file(s) (3 with failures), in 5 root-cause bucket(s).

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
- `cart/totals.test.ts` — rounds half to even
  Expected values to be strictly equal: '2.50' !== '2.5'

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
loom replay "$RUN"      # exit 0
loom audit  "$RUN"      # exit 0
```

`replay` prints a `replay: graph triage-failures v1 (sha256:…)` header on stderr and then
`{"match": true, "hermetic": true}`. `audit` prints eleven `· not checked — …` lines for rules this
journal has no events for, then `ok — 16 rule(s) checked, 11 skipped`.

`hermetic: true` is the load-bearing word: the three `fs.read` calls, the `fs.write`, and the
human's decision at the gate were all served from the journal rather than re-executed.

**Stop one instead of approving it.** A cancelled run writes nothing and leaves no open gate — on a
FRESH run, because the one above has already answered its gate:

```bash
RUN2=$(loom run graphs/triage-failures.json --input '{"pattern":"reports/*.txt"}' 2>/dev/null \
       | sed -n 's/^  "runId": "\(.*\)",$/\1/p')
loom cancel "$RUN2" --as u:you --reason "triaged by hand instead"
# → {"runId": "…", "status": "cancelled"}                        exit 0
loom gates "$RUN2"      # → []
```

**Two refusals worth trying**, because each is a promise. The first needs a run still parked at an
OPEN gate — on a resolved one you get `E_GATE_ALREADY_RESOLVED` instead, which proves nothing about
approvers:

```bash
RUN3=$(loom run graphs/triage-failures.json --input '{"pattern":"reports/*.txt"}' 2>/dev/null \
       | sed -n 's/^  "runId": "\(.*\)",$/\1/p')
GATE3=$(loom gates "$RUN3" | sed -n 's/^    "gateId": "\(.*\)",$/\1/p')
loom approve "$RUN3" "$GATE3" --as u:someone-else
# → E_GATE_NOT_AUTHORIZED: gate "gate_01M…" does not name "u:someone-else" as an approver   exit 1

loom run graphs/triage-failures.json --input '{"pattern":"nope/*.txt"}'
# → "status": "failed" … no test-output files matched — check the --input pattern           exit 1
#   It arrives wearing "class": "internal", "code": "E_INTERNAL" — see friction F8. That is the
#   runtime reporting a DESIGNED refusal with the same code an accidental throw gets, not a crash.
```

The second is deliberate. A fan-out over an empty array produces no branches and the join folds
nothing, so the run would otherwise **succeed with a report saying zero failures** — which reads as
"your suite is green" when what happened is that you typed the wrong path. The same body refuses
the other end too: more shards than the fan-out's `maxWidth` would silently drop the surplus, so it
names the count and the cap instead.

### The tests that stop it rotting

**From the repository root, not from `examples/`** — `cd` back first:

```bash
cd "$REPO"
node --test --test-timeout=60000 packages/core/test/examples-triage.test.ts   # 10 pass, 0 fail
node --test --test-timeout=60000 packages/core/test/examples-run.test.ts      # 15 pass, 0 fail
```

Ten tests: parks-with-nothing-written, the approval and the exact ranking, the refused approver
(pinned to `E_GATE_NOT_AUTHORIZED`, not merely to a non-zero exit), cancel, replay, the
empty-pattern refusal, and the four a fresh review added — a CRLF shard, a shard count over the
fan-out ceiling, a shard with no failures still being counted as read, and a failure with no YAML
block not swallowing the next one. `examples-run.test.ts` picks the new graph up without being
edited — its set is the directory — so the compile and resource-reachability halves were already
covered.

**Tidy up.** The walkthrough leaves five runs in one journal, one report on disk, and the server
log it redirected:

```bash
rm -rf "$REPO/examples/out" "$REPO/examples/.loom" /tmp/loom-serve.log
```

---

## 3 · Friction log

Every entry is a place the shipped product cost more than it should have. Each carries the exact
command, what happened, and what was expected. **Eight found: three fixed, five logged** with the
file that would have to change.

Everything in this section was re-run by a fresh reviewer who was told to refute it; F1–F5 and F7
reproduced exactly, and F8 is one that reviewer added.

### F1 · A fan-out branch may hold two nodes, but nothing says so, and it takes two compiles

*Status: logged (documented here and in `examples/README.md` §8; the message itself is unchanged).*
*File: `packages/core/src/graph/validate.ts`, `rule021FanoutHasJoin`.*

The branch is `read` (a `tool`) → `classify` (a `function`). The obvious spelling — collect the
branch's LAST node — is refused:

```bash
$ loom compile graphs/triage-failures.json      # join.branches: ["classify"]
✗ triage-failures.json: GRAPH021_FANOUT_WITHOUT_JOIN: fanout edge "fan" expands "read" but no downstream join waits on it
   fix: add a join node downstream of "read" with branches: [read]
E_GRAPH_INVALID: graph has 1 error(s): GRAPH021_FANOUT_WITHOUT_JOIN
```
exit 1. Following that `fix:` literally — `branches: ["read"]` — is then refused too:

```bash
$ loom compile graphs/triage-failures.json      # join.branches: ["read"]
! triage-failures.json: GRAPH008_JOIN_WRITES_UNPRODUCED: …
✗ triage-failures.json: GRAPH008_BRANCH_NOT_CONNECTED: join "gather" waits on "read", but no edge runs from "read" to "gather"
   fix: add an edge read -> gather with kind: join
E_GRAPH_INVALID: graph has 1 error(s): GRAPH008_BRANCH_NOT_CONNECTED
```
exit 1.

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

**And the digest is not a stand-in for the content**, which a second reader checked: three runs over
byte-identical input produced three different `contentDigest` values, so it covers run-scoped data
too. It is a binding — what the approver was shown, which `loom approve` later checks the graph
against — not a summary you could recognise or compare across runs.

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

`README.md:177` splits the examples as *"§§1–4 work offline with no key; §§5–6 have an `agent` node
and want a real model"*, which now omits §8 as it already omitted §7. `README.md:180` reads *"runs
the three that need no model"*.

**Narrowed after review, because the first draft of this entry overstated it.** `:180` credits the
running to `examples-run.test.ts`, and that file still runs exactly three graphs — §8 is run by
`packages/core/test/examples-triage.test.ts`, a separate file — so `:180` is still literally TRUE
and only reads as incomplete. `:177` is the line that is now wrong. `examples/README.md`'s own
"Five graphs" line was wrong in the same way and **was fixed** here, since that file is this lane's
to edit.

### F8 · The workflow's own designed refusals surface as `E_INTERNAL`

*Status: logged.* *File: `packages/core/src/run/engine.ts` (kernel) — so this one cannot be fixed
from an extension at all, which is the point of recording it.*

Both of `triage-plan.js`'s refusals are deliberate guards with a written message, and both arrive
looking like a crash:

```bash
$ loom run graphs/triage-failures.json --input '{"pattern":"nope/*.txt"}'
  "error": {
    "class": "internal",
    "code": "E_INTERNAL",
    "message": "Error: no test-output files matched — check the --input pattern, …"
  }
```

**Expected**: something a caller can branch on — a class that says "this graph refused", distinct
from "this body threw by accident". **Got**: `E_INTERNAL`, the same code a genuine bug in the body
produces. `README.md`'s "What does not work yet" already names the mechanism: *"a throw still
cannot carry retryability — `isLoomError` is an `instanceof` against the host class and a guest
object can never satisfy it, so every throw out of the `vm` is `E_INTERNAL`"*. A body's `return`
channel already carries one structured verdict (`{retry: {reason}}`); a refusal has no equivalent,
so an author who wants to fail on purpose can only throw, and every purposeful failure is reported
as an internal error. Related to the row README calls *`retry` on a function or evaluator node*,
but not the same one — that row is about retryability, this is about a REFUSAL.

### Fixed vs. logged

| # | what | status | file that would change |
|---|---|---|---|
| F1 | two-node fan-out branch takes two compiles to discover | documented | `packages/core/src/graph/validate.ts` |
| F2 | `GRAPH010` refuses a provably branch-local channel | logged | `packages/core/src/graph/validate.ts` |
| F3 | `loom gates` shows a digest, not the content | logged | `packages/core/src/cli.ts` |
| F4 | gate hint on stdout after the JSON | logged | `packages/core/src/cli.ts` |
| F5 | `--extension-module` help names 4 of 10 registrar members | logged | `packages/core/src/cli.ts` |
| F6 | `examples/.gitignore` missed `out/` | **fixed** | `examples/.gitignore` |
| F7 | `README.md:177` omits §8 (and already omitted §7) | logged | `README.md` (docs lane) |
| F8 | a body's deliberate refusal is reported as `E_INTERNAL` | logged | `packages/core/src/run/engine.ts` (kernel) |

### What the review found in the WORKFLOW, not in the runtime

The friction log is about the product. This paragraph is about the port, and it belongs here
because `CLAUDE.md` is explicit that *a builder's own green suite is not evidence*. Two fresh
agents were run against this change: one adversarial reviewer on the diff, and one "stranger" given
only this document and told to follow it literally. **Between them they found six defects, and
three of them made the workflow report a GREEN SUITE for input that was full of failures** — the
exact failure mode §2 claims the empty-pattern refusal exists to prevent.

| found | what happened | now |
|---|---|---|
| **CRLF input read as clean** | every pattern in `triage-classify.js` is anchored; `.` excludes `\r` and `$` without `/m` needs true end-of-string, so a shard split on `"\n"` matched NOTHING and the run SUCCEEDED with `0 failing test(s)`. Windows CI output, or `core.autocrlf=true`, is the ordinary case | split on `/\r?\n/`; pinned by *"a CRLF shard is triaged identically to an LF one"*, which fails if the fix is reverted |
| **shards past `maxWidth` dropped in silence** | the fan-out CLAMPS: twelve shards at a width of eight ran eight branches, and the report said `8 failing test(s) across 8 report file(s)` with no warning on either stream — while this document's own first sentence says "a dozen shards" | width raised to 24, and `triage-plan.js` now REFUSES above it, naming the count and the cap. Pinned by a test that reads `maxWidth` out of the graph, so the constant and the graph cannot drift |
| **a clean shard was not counted as read** | `report.shards` was derived from the failures, so three all-green files reported `0 failing test(s) across 0 report file(s)` | `collate` reads the `shards` channel; the report carries `shards` (read) and `shardsWithFailures` (failed) separately |
| **a failure with no YAML block ate the next one** | the block scan ran to the next `...` and advanced past it, so one row appeared under the wrong file wearing the next failure's evidence, and that next failure vanished | the scan stops at `...`, at the next `not ok`, at `1..N` and at `# Subtest:` |
| **the approver test proved nothing** | it asserted only `code !== 0`, which a bad `runId` also satisfies | pinned to `E_GATE_NOT_AUTHORIZED` and to the message naming the subject |
| **§2 could not be run top-to-bottom** | the approve and cancel blocks were alternatives on ONE run but both said `$RUN`; `$RUN`/`$GATE` were never assigned; the `node --test` paths did not resolve after `cd examples`; `loom serve &` had no readiness wait and `kill %1` needs job control | §2 is now three explicit runs, ids captured by the commands themselves, `cd "$REPO"` before the tests, a readiness loop and a PID-based kill |

Also fixed while porting: the classifier's evidence line originally stopped at node:test's
`"Expected values to be strictly equal:"` header and named neither value, so the whole `assertion`
bucket read identically for every case; and the first draft of `triage-plan.js` returned `[]` for a
pattern that matched nothing.

**The lesson, stated plainly.** Every one of the three green-suite defects is the same shape
`CLAUDE.md` names as the first of its two lenses — *a guard answering its undecidable case with the
passing value*. The workflow's headline promise is that "0 failures" and "you pointed me at the
wrong thing" must not look the same; three separate mechanisms inside it made them look the same
anyway, and the builder's own six passing tests said nothing about any of them.

**Then a THIRD fresh agent was given only this document** and told to run §2 literally. Verdict:
**COMPLETED** — every command ran as written, in order, in one shell, and it never had to open the
source. What it still found was four stale NUMBERS, all in this section's prose: `written.bytes`
said 1802 and is 1820, `wc -c` said 1838 and is 1856, "roughly ninety lines" is 131, and "three
runs in total" is five. Every one of them was stale by exactly the edit that fixed defect 3 above —
adding `(3 with failures)` to the summary line is 18 characters, and 1820 − 1802 = 1856 − 1838 = 18.
A number pasted into prose is a fact with no test behind it, which is the one class of claim this
document cannot defend and the reason the counts a test CAN hold are asserted in
`examples-triage.test.ts` instead.

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
- **`SHARD_CEILING` is duplicated**, in `triage-plan.js` and as `maxWidth` on the `fan` edge. A
  `function` body is handed channel values and nothing about the node that called it — no
  `ctx.node`, no `ctx.graph` — so a body cannot read its own fan-out's width. The test pins the two
  together, which is a patch on a seam rather than the seam: the real fix is for a body's `ctx` to
  carry the node's declared shape, and that is a kernel change this lane did not make.
- **The classifier's bucket list is fixed in the body**, so adding a signature means editing the
  file. That is correct for an example and wrong for a product: the natural next step is the bucket
  table as a `resources/` document the body reads, which needs no new mechanism.
- **Nothing here exercises a `subgraph`, a `router`, a bounded loop, a compensation edge or a
  retry.** `packages/core/src/workflows/incident-triage.ts` reaches those and is not runnable from
  the CLI; a port that joins the two would be the next honest one.
