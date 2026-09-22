# Porting a real workflow, 2026-09-22b — the third one

`CLAUDE.md` says **the next real workflow somebody ports is worth more than the next invariant
somebody proves**, and that **a third port is worth as much again**. Two were ported:
`examples/graphs/triage-failures.json` (`docs/workflow-port-2026-09-09.md`, eight friction entries,
all closed) and `examples/graphs/harden-config.json` (`docs/workflow-port-2026-09-22.md`, thirteen,
none closed). **They overlap in `seq` alone.** Nothing had replaced them.

This is the third. Same rules: only the published surface, only the shipped binary, **zero changes
under `packages/core/src`**, no fork, no `--extension-module`. Written for somebody who has not read
the code.

**It needed no source change either, and the count is SEVEN** — F1–F7 below. The two earlier ports
cost eight and thirteen; a smaller number here is not a claim that the product improved, and reading
it that way would be wrong. **This graph exercises less surface per node than either** — no fan-out,
no loop, no join, no budget — and its whole novelty is two mechanisms (`router`, `error`) plus a
reducer. Seven entries over that much ground is not a better ratio than thirteen over the loop.

**What IS worth carrying is the shape of the seven, and it is different from both predecessors.**
Port 2's headline was *three of thirteen are one mechanism*. Here the headline is that **two of the
seven are the same sentence in two places — a decision is made from a fact the graph cannot see**.
F3: the people the policy says may approve are DATA, and `approval.approvers` is a static list in
the graph. F5: the reason a node failed is data, and an `error` arm is handed none of it. **F5 is
the one to read**: it is not an inconvenience, it is a measured destruction of the workflow's own
record, and it is reachable with one `chmod`.

**§4 is the entry to read, and it is this port's F14.** **Nine defects in THIS PORT'S OWN workflow
and this document** — one found by the author's own mutation sweep and **eight across two review
rounds**, of which **six were blocking**. They are one sentence:
*a guard nothing distinguishes is a guard nobody has*.

- **Two bounds on a renewal were untested**, and deleting either kept the suite 16/16 green. The
  only renewal the suite exercised was a minutes-old, same-level, same-hours repeat of an
  approval — a fixture that satisfies every guard at once and therefore distinguishes none.
- **A renewal could WIDEN what a person approved.** A human said yes to `write/4h`; the graph then
  granted `write/24h` and called it a renewal. And the window was measured from any entry's
  `grantedAt`, so each auto-renewal restarted the clock and one approval became indefinite access.
- **F5's "not closable from this side" was never established.** A `tool` node is neither a function
  nor a hook, and `fs.glob` lists a file `fs.read` cannot open. A defence was BUILT.
- **F5's own paragraph made a false claim about `codes`** — a path the sandbox refuses carries the
  same code as a missing file, so the narrowing does not separate the cases that matter.
- **AND THEN THE DEFENCE ITSELF FAILED OPEN, which is the one to carry.** `fs.glob` answers
  `(no matches)` for "there is nothing here" AND for "I cannot see what is here", so `chmod 333` on
  the parent directory reproduces the original F5 data loss verbatim *with the defence in place*.
  **The workaround for a guard that fails open was itself a guard that fails open** — the same lens
  one layer down. Four glob patterns were tried; none gives a signal. The claim is now narrowed to
  the one case it covers, the three it does not are named, and the hole is pinned NEGATIVELY.
- **And the second draft's third limit gave a FALSE mechanism for it** — "a different literal" —
  when the same literal globs and still answers nothing.

**Nothing in F1–F7 is fixed here — the product entries are recorded, not closed.** Everything in §4
is this port's own; eight are fixed, and the ninth is pinned as a known hazard because **no
arrangement of the published surface closes it.**

---

## 1 · What was ported, and why this shape

**`grant-access` — somebody asked for temporary access to a production resource, and the graph
decides how much human that needs.**

An access request lands in a queue: *u:dana wants `write` on `orders-db` for four hours, to backfill
the shipping rows the import job dropped.* Somebody has to answer three questions in order — is this
resource one we have a policy for, is what they are asking inside it, and does anybody have to sign
— and then write the grant down somewhere that will still be there in six months. Done by hand it is
a chat thread, which is not a record, and the thread is where the mistakes live: **the ceremony gets
decided by who is online rather than by what is being asked for.**

The three answers are not the same kind of thing, and that is the whole shape:

```
  read-request ─seq─▶ read-policy ─seq─▶ look ─seq─▶ read-ledger ─seq──────▶ prior ─────┐
                                                          │                             ├─▶ weigh ─seq─▶ route
                                                          └─error(E_TOOL_SOURCE_UNAVAILABLE)─▶ first-grant ─┘
                                                                                                            │
  route ─conditional(ceremony == "auto")───────────────────────────────────────▶ record ─┬─seq─▶ write-grant
  route ─conditional(ceremony == "review")─▶ sign (human gate) ─seq─▶ ───────────────────┘   └─seq─▶ write-ledger
  route ─fallbackEdge──────────────────────▶ deny (refuses)
```

| node | type | what it does |
|---|---|---|
| `read-request` | `tool` (`fs.read`) | the request the `requestPath` input names |
| `read-policy` | `tool` (`fs.read`) | `access/policy.json` — the tiers, the levels, the caps |
| `look` | `tool` (`fs.glob`) | **is there a ledger at all?** — the second opinion F5's defence rests on |
| `read-ledger` | `tool` (`fs.read`) | `out/access-ledger.json`, **which need not exist** |
| `prior` | `function` | parses the ledger; **refuses if it cannot** |
| `first-grant` | `function` | the ERROR arm: no ledger yet, so nobody has a history |
| `weigh` | `function` | tier × level × hours × history → the ceremony; **refuses on a document it cannot read** |
| `route` | `router` | two `cases[]` and a `fallbackEdge` — three destinations |
| `sign` | `human_gate` | a person sees the request, the reason, the rule and the prior grants |
| `record` | `function` | builds the grant and the next ledger |
| `deny` | `function` | **refuses**, naming the policy rule that said no |
| `write-grant` | `tool` (`fs.write`) | `out/grant.json` |
| `write-ledger` | `tool` (`fs.write`) | `out/access-ledger.json` |

Files added, all inside the published workspace surface — a graph, five `function` bodies, and an
input directory:

```
examples/graphs/grant-access.json
examples/resources/function/grant-{prior,none,weigh,record,deny}.js
examples/access/policy.json                    # the input, not workspace files
examples/access/requests/*.json                # twelve requests, one per arm and per refusal
examples/access/requests/not-a-request.txt     # and one that is not JSON at all
```

### Why this shape and not another

The brief was explicit: **overlap the two existing ports as little as possible.** The census was
measured rather than recalled — `node -e` over every file in `examples/graphs/`, reading
`nodes[].type`, `edges[].kind`, `channels[].reduce` and `nodes[].tool.name`:

| | `triage-failures` | `harden-config` | **`grant-access`** |
|---|---|---|---|
| nodes | 8 | 8 | **13** |
| node types | function, human_gate, join, tool | function, human_gate, tool | function, human_gate, **router**, tool |
| edge kinds | fanout, join, seq | conditional, loop, seq | conditional, **error**, seq |
| reducers | append_ordered, replace | append_ordered, replace | **merge_object**, replace |
| tools | fs.glob, fs.read, fs.write | fs.read, fs.write | fs.glob, fs.read, fs.write |

**That row said `append_ordered` in an earlier draft and this graph has NONE** — `/usr/bin/grep -c
append_ordered graphs/grant-access.json` → `0`. Nothing in this workflow accumulates across a run:
the ledger grows on DISK, one entry per run, and every channel holds one value. The census had been
carried from the plan instead of re-read from the file, which is the same defect as a number
carried from an earlier run.

**Four things here are held by no other graph in this workspace**, and each was checked by grepping
the directory rather than by remembering:

1. **`type: "router"`.** `/usr/bin/grep -al '"router"' graphs/*.json` matches `grant-access.json`
   and nothing else.
2. **`kind: "error"`.** Same, for `'"error"'`. And the consequence is sharper than the absence:
   `/usr/bin/grep -al 'unhandled' graphs/*.json` matches `guarded-write.json` and
   `two-person-approval.json`, which DECLARE that they accept run failure, and the other five say
   nothing at all — so **no graph in this workspace handles its own failure, and two of them state
   in the file that they are not going to.** `GRAPH011`'s `fix:` line has been offering `add an
   edge from "<id>" with kind: error` to every author since it was written, and no shipped example
   took it until this one.
3. **A reducer other than `replace` and `append_ordered`.** **SIX** of the eight ship unexercised —
   `merge_object`, `sum`, `max`, `min`, `union_set` and `last_write_wins_by_ts`, which an earlier
   draft's count of five omitted. This uses `merge_object`, and F1 is why.
4. **A node reached by two mutually exclusive paths.** `record` sits behind both `granted` (straight
   from the router) and `signed` (from the gate); `weigh` sits behind both `prior` and
   `first-grant`. Nothing demonstrated that, and it is the shape every router tree needs.

**The router has TWO `cases[]` and one `fallbackEdge`, which is three destinations and not "three
arms"** — a phrase this document and the suite both used until a reviewer counted. The distinction
matters when you write one: a case you forget falls through to the fallback, silently, and the
fallback here is the arm that REFUSES.

Overlap with port 1 is `human_gate`, `function`, `tool`, `fs.glob`, `fs.read`, `fs.write`, `seq` and
`replace`; with port 2, add `conditional`. **That is more overlap than the first two had with
each other, and it is not avoidable**: every one of those is what a workflow a person would actually
want run is made of, and a graph that avoided them to score better on a table would be a feature
demo. The DISTINCTIVE set is disjoint, and that is the claim.

**Why it means something offline**, which is the test `examples/README.md` §5 fails on purpose and
§8, §9 and this one pass: every term is READ OFF. The tier is a lookup in `access/policy.json`. The
cap is a lookup. The level is an index into a declared list. A renewal is a date comparison against
a window the policy states. There is no judgement in any of the rules, so there is no model in the
graph, and a model would add nothing but a second opinion nobody could audit.

**There is no `agent` node, deliberately, as in both earlier ports.** The judgement worth a model
here is whether the stated REASON justifies the access — *"backfill the 2026-08 shipping rows the
import job dropped"* is either a real reason or a sentence somebody typed to get past a form — and
that is exactly what this graph refuses to guess at. It puts the reason in front of the person at
the gate and lets them answer it.

### The alternatives, and why they lost

- **A release-readiness decision** — checks in, `ship` / `sign-off` / `hold` out. *Rejected as a
  subject duplicate.* The graph shape is the same router tree, but its input is test-runner output,
  which is port 1's input read a second way. A third port over the same material names no new seam,
  and the whole argument for a third port is that it pulls somewhere the first two did not.
- **A dependency-advisory responder** — CVE × lockfile → not affected / patch / waiver. *Rejected as
  the same graph with worse arithmetic.* Identical arms; the only difference is that semver-range
  comparison is fiddlier than a table lookup, which buys complexity rather than coverage, and puts
  the reader's attention on the ranges instead of on the routing.
- **A migration runner built around `compensation` edges.** *Rejected on measurement, and the
  measurement is worth more than the rejection.* `fs.write` is `reversible_write` and declares
  `compensation: {tool: "fs.restore"}`, so the edge compiles — but **nothing traverses one.**
  `Engine.#edgesToTake` has `case "compensation": break;`, and `graph/validate.ts:364` drops the
  kind from the forward DAG. Rollback is driven by the JOURNAL, not by the graph. So a workflow
  built around the edge would be a workflow built around a declaration, and its rollback would have
  happened identically with the edge deleted — which §2 then measured directly, by accident.
- **A `subgraph` child.** *Rejected as already argued.* Port 2's reasoning stands: a `subgraph` is
  how you reuse a graph you already have, and a decomposition is not a workflow.
- **`proc.exec`.** *Rejected on the test contract, not on the merits.* It is the most unexercised
  thing in the box — `irreversible`, so `CLASS_DEFAULT_POSTURE` gates it by default and
  `CLASS_AUTO_RETRYABLE` refuses to retry it, and it needs `--allow-exec` before it is registered at
  all. It is also a subprocess, and `CLAUDE.md` requires this suite to be deterministic. **Named as
  the best remaining candidate for a fourth port** rather than quietly dropped.
- **A `quorum` join over two approvers.** *Rejected as already owned.*
  `examples/graphs/two-person-approval.json` is three gates under `join{mode:"quorum", k:2}` and
  `examples/README.md` states its residue. Adding a second-signature arm cost four nodes and
  exercised nothing new.

---

## 2 · The exact commands a stranger runs

Every block is copy-pasteable in order, top to bottom, in ONE shell. Nothing needs an API key, a
network connection or an editor. **The run ids below are from the measured run** and will differ on
yours; the blocks that need one capture it themselves.

**Start in the repository root.**

```bash
cd /path/to/this/repository              # wherever you cloned it
npm install && npm run build:binary      # → bin/loom, one file, 0 third-party modules
export REPO="$PWD"
export PATH="$REPO/bin:$PATH"
cd "$REPO/examples"
rm -rf out .loom                         # running the examples in place leaves both behind
```

**That last line matters more here than in either earlier port.** `out/` is where this workflow's
LEDGER lives, and the ledger is read at the start of every run — so a checkout somebody has already
experimented in does not merely carry litter, it carries a history that decides the next run's
ceremony. The first thing this walkthrough asserts is that `out/` does not exist.

**Compile it.**

```bash
loom compile graphs/grant-access.json
```

```
ok
  deadline read-request (default): timeoutMs=600000
  deadline read-policy (default): timeoutMs=600000
  deadline look (default): timeoutMs=600000
  deadline read-ledger (default): timeoutMs=600000
  deadline prior (default): timeoutMs=600000
  deadline first-grant (default): timeoutMs=600000
  deadline weigh (default): timeoutMs=600000
  deadline record (default): timeoutMs=600000
  deadline deny (default): timeoutMs=600000
  deadline write-grant (default): timeoutMs=600000
  deadline write-ledger (default): timeoutMs=600000
```
exit 0. **No diagnostic at all**, which is worth one sentence because a draft of this graph's own
`labels` claimed otherwise: `deny` is terminal and writes no declared output, and
`GRAPH002_DEAD_END` still does not fire on it, because `decision` IS a declared output and `weigh`
writes it on the same path. Eleven deadlines and not thirteen: `route` and `sign` run no body that
could time out. `packages/core/test/examples-grant.test.ts` asserts the diagnostic set is EMPTY
rather than counting it, so a compiler change that starts warning here fails loudly.

**Run it.** It stops at the gate, and nothing has been written.

```bash
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/orders-db-backfill.json"}'
ls out                                   # ls: out: No such file or directory
```

```
run 01M3449BA979HS28KEJYKT8YME — inspect it with: loom trace 01M3449BA979HS28KEJYKT8YME   ← stderr
{
  "runId": "01M3449BA979HS28KEJYKT8YME",
  "status": "awaiting_gate",
  "outputs": {},
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "costUsd": 0,
    "wallMs": 0
  }
}
gate gate_01M3449BASFPMYM2RCE928S9YV on node sign — loom approve 01M3449BA979HS28KEJYKT8YME gate_01M3449BASFPMYM2RCE928S9YV --as YOUR_ID   ← stderr
```
exit 0. **Stdout is the JSON object and nothing else**, which is the first port's F4 holding on a
third graph.

Capture the two coordinates the rest needs:

```bash
RUN=$(loom run graphs/grant-access.json \
      --input '{"requestPath":"access/requests/orders-db-backfill.json"}' 2>/dev/null | jq -r .runId)
GATE=$(loom gates "$RUN" 2>/dev/null | jq -r '.[0].gateId')
echo "$RUN $GATE"
```

**Watch the error arm.** This is the observable that matters, and it is the one thing no other
example in this workspace can show you:

```bash
loom trace "$RUN" 2>/dev/null
```

```
loom.run [unset] 17ms
  loom.task read-request root [ok] 6ms
    loom.policy [ok] 0ms
    loom.tool [ok] 1ms
    loom.state.reduce [ok] 0ms
  loom.task read-policy root [ok] 1ms
    loom.policy [ok] 0ms
    loom.tool [ok] 0ms
    loom.state.reduce [ok] 0ms
  loom.task look root [ok] 3ms
    loom.policy [ok] 0ms
    loom.tool [ok] 1ms
    loom.state.reduce [ok] 0ms
  loom.task read-ledger root [error] 1ms
    loom.policy [ok] 0ms
    loom.tool [ok] 1ms
  loom.task first-grant root [ok] 2ms
    loom.policy [ok] 0ms
    loom.effect (random) [ok] 0ms
    loom.state.reduce [ok] 0ms
  loom.task weigh root [ok] 1ms
    loom.policy [ok] 0ms
    loom.effect (random) [ok] 0ms
    loom.state.reduce [ok] 0ms
  loom.task route root [ok] 1ms
    loom.policy [ok] 0ms
  loom.task sign root [unset] 2ms
    loom.policy [ok] 0ms
    loom.gate sign [unset] 0ms

conformance: ok
```

**That is the whole of stdout, unelided.** An earlier draft showed the `loom.task` lines only and
said two child kinds were being dropped; there are FIVE (`loom.policy`, `loom.tool`,
`loom.state.reduce`, `loom.effect (random)`, `loom.gate`), and `conformance: ok` is on STDOUT, not
stderr. Only the `trace:` header naming the graph hash goes to stderr. A paste that elides without
saying exactly what is a paste a reader cannot check, which is the thing §2 cannot afford.

**`read-ledger [error]` inside a run whose own status is `[ok]`.** The ledger does not exist yet, so
the `fs.read` failed, the `error` edge carried control to `first-grant`, and the run carried on.
**Two nodes are ABSENT and their absence is the assertion**: `prior`, the success arm, never ran,
and neither did `deny`. Note also `read-ledger`'s own children — it has a `loom.policy` and a
`loom.tool` and NO `loom.state.reduce`, because a failed task applies no writes.

**`look` is the defence F5 cost**, and it runs before the read on every path. Here it finds nothing
and the run proceeds; §3's F5 has the case where it finds something and `weigh` refuses.

**See what you are being asked to approve.**

```bash
loom gates "$RUN" 2>/dev/null
```

```json
[
  {
    "gateId": "gate_01M3449BASFPMYM2RCE928S9YV",
    "taskId": "sign@root#0",
    "nodeId": "sign",
    "policyRef": "oversight/access@stable",
    "contentDigest": "sha256:0805ccbab4a690b6d654533bb4754c0ff6287cc065e23b4d10c6b953919b190b",
    "raisedAtSeq": 57,
    "raisedAtTs": 1790066339162,
    "state": "open",
    "tier": 0,
    "approvers": [
      "u:you"
    ],
    "allowEdit": [],
    "runId": "01M3449BA979HS28KEJYKT8YME",
    "onTimeout": "fail",
    "reads": {
      "decision": {
        "cap": 24,
        "ceremony": "review",
        "decidedAt": 1790066339158,
        "historySource": "none",
        "hours": 4,
        "level": "write",
        "owners": [
          "u:ravi",
          "u:mina"
        ],
        "priorGrants": [],
        "reason": "backfill the 2026-08 shipping rows the import job dropped",
        "renewalOf": null,
        "requestId": "REQ-1041",
        "resource": "orders-db",
        "tier": "restricted",
        "who": "u:dana",
        "why": "orders-db is restricted-tier and this asks to write it, which no rule grants without a person"
      }
    },
    "readsResolved": [],
    "readsUnresolved": [],
    "readsTruncated": {},
    "readsMayBeStale": []
  }
]
```

**Nothing is elided from that block.** The four `reads*` fields are shown rather than dropped —
each is a way `reads` can be less than it looks, and all four are empty here because this gate sits
after no fan-out and the decision is small. `readsTruncated` names channels this door CUT at 64 KiB
(`--max-bytes` is the dial) and `readsMayBeStale` names ones an earlier node on a fan-out branch has
already written; a reader who has never seen them full should know they can be.

**Three fields make this a decision rather than a prompt.** `why` is the RULE that sent it here, not
a restatement of the request. `owners` is who the policy says may sign — and **it is not the same
list as `approvers`, which is F3.** `historySource: "none"` says the history is the error arm's:
*nobody has a prior grant* and *we never found the ledger* are different facts and a gate that
merged them would be a gate lying by omission.

**Approve it — this is the path that produces the deliverables.**

```bash
loom approve "$RUN" "$GATE" --as u:you
```

48 lines of JSON on stdout, the finished run, ending in

```json
    "wroteGrant": {
      "bytes": 416,
      "path": "out/grant.json"
    },
    "wroteLedger": {
      "bytes": 612,
      "path": "out/access-ledger.json"
    }
```

and **lines on STDERR about a graph you did not name** — that is F2. On the tree this was measured
on, three of them, about `harden-config.json`:

```
! harden-config.json: GRAPH002_DEAD_END: terminal node "fix" ends a path on which no declared output is ever written
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "audit" reads "applied", which no upstream node writes and which is not a graph input
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "collate" reads "applied", which no upstream node writes and which is not a graph input
```

**Do not read that three as the finding** — another lane in this wave closes §A.84, after which
`harden-config.json` compiles clean and this count becomes ZERO while the mechanism is unchanged.
F2's own repro is written so it does not depend on which graphs happen to warn.

(`bytes` is a UTF-16 code-unit count and `wc -c` counts BYTES, so `wc -c` says **418** against
`"bytes": 416` and **614** against **612** — a difference of two in each, contributed by **one**
em-dash at three bytes where UTF-16 counts one, in `decidedBy`. The arithmetic is `1 × (3 − 1) = 2`.
Same phenomenon both earlier ports record; re-derived from the files rather than carried — the
numbers moved when `decidedByKind` was added, which is exactly how a stale pair gets into a doc.)

```bash
cat out/grant.json
```

```json
{
  "requestId": "REQ-1041",
  "who": "u:dana",
  "resource": "orders-db",
  "tier": "restricted",
  "level": "write",
  "hours": 4,
  "grantedAt": 1790066366704,
  "expiresAt": 1790080766704,
  "ceremony": "review",
  "decidedBy": "a person, at the \"sign\" gate — see `loom gates` for who",
  "decidedByKind": "human",
  "reason": "backfill the 2026-08 shipping rows the import job dropped",
  "renewalOf": null
}
```

**That block is the file, byte for byte.** `expiresAt - grantedAt` is `14400000`, which is the four
hours that were asked for and approved — derived rather than restated, so a grant cannot outlive
what a person agreed to.

**`decidedBy` names the MECHANISM and not the person, and that is deliberate.** A `function` body
sees `view` and `ctx`, and neither carries the approver's subject. Writing `"approved by u:you"`
here would be the document asserting something the code did not establish, which is the whole
subject of port 2's F14. Who answered the gate is in the journal, under the gate.

**`decidedByKind` is the same fact in a form a GUARD can read**, and it is load-bearing rather than
decorative: `grant-weigh.js` renews only off an entry whose kind is `"human"`, so an auto-renewal
cannot restart the renewal window. Two fields rather than one because a guard that greps prose
breaks the first time the prose is edited for readability — and this prose is written to be read.
See §4 for the measurement that put it here.

**Run it AGAIN, and this is the workflow.**

```bash
loom run graphs/grant-access.json \
  --input '{"requestPath":"access/requests/orders-db-backfill.json"}' 2>/dev/null \
  | jq '{status, ceremony: .outputs.decision.ceremony,
         historySource: .outputs.decision.historySource,
         why: .outputs.decision.why,
         decidedBy: .outputs.grant.decidedBy}'
```

```json
{
  "status": "succeeded",
  "ceremony": "auto",
  "historySource": "ledger",
  "why": "a person granted u:dana write/4h on orders-db 0 hours ago, inside the policy's 720-hour window; this asks for write/4h, which is no wider, so it renews that decision rather than making a new one",
  "decidedBy": "automatically, as a renewal of an existing grant"
}
```

**`succeeded`, not `awaiting_gate`: there is no gate on this path at all.** The same command, the
same input, a different ending — because the ledger the first run wrote is now on disk, so
`read-ledger` succeeded, `prior` ran instead of `first-grant`, and `weigh` found a grant inside the
policy's renewal window. **That is both arms of the error edge, driven by running one command
twice**, and it is why this workflow has an error edge rather than having one bolted on.

**`why` NAMES BOTH WIDTHS — `write/4h` approved, `write/4h` asked — and that is not decoration.**
A renewal skips the person, so it is bounded three ways (only a HUMAN-decided grant starts a window;
it may widen neither the level nor the hours; it must be inside the window), and the sentence is
what makes the bound auditable in the record rather than only in the code. An earlier version
printed the prior level and the age alone and said *"this is a renewal and not a new grant"* — over
a 24h grant renewing a 4h approval. §4 has that measurement.

**The ledger is append-only, and it comes back with two key orders in one file** — F6:

```bash
jq -c '{n: (.grants|length), who: [.grants[].who]}' out/access-ledger.json
# → {"n":2,"who":["u:dana","u:dana"]}

node -e 'const l=JSON.parse(require("fs").readFileSync("out/access-ledger.json","utf8"));
         console.log("entry 1:", Object.keys(l.grants[0]).join(","));
         console.log("entry 2:", Object.keys(l.grants[1]).join(","))'
```

```
entry 1: ceremony,decidedBy,decidedByKind,expiresAt,grantedAt,hours,level,reason,renewalOf,requestId,resource,tier,who
entry 2: requestId,who,resource,tier,level,hours,grantedAt,expiresAt,ceremony,decidedBy,decidedByKind,reason,renewalOf
```

**Trust what it did.**

```bash
loom replay "$RUN"      # → {"match": true, "hermetic": true}      exit 0
loom audit  "$RUN"      # → ok — 16 rule(s) checked, 12 skipped    exit 0
```

`hermetic: true` on a run whose `fs.read` FAILED is the load-bearing part. The failure was journaled
and is served from the journal on replay, rather than re-executed against a filesystem that now HAS
the ledger — a replay that re-ran the read would take the other arm and diverge. **A recorded
failure is evidence like any other.**

**Every arm, on its own input.** The ceremony is checkable by hand: read `access/policy.json` and
the request, and say which arm is right before you run it.

**`rm -rf out .loom` BEFORE EACH ROW, not once at the top.** The ledger is this workflow's memory,
so a sweep that keeps it measures each row against whatever the rows above it granted. An earlier
draft cleared once and its `docs-site-read-ravi` row read `historySource: "ledger"` — true of that
sweep and of nothing a reader would reproduce.

```bash
for r in docs-site-read docs-site-admin orders-db-backfill payments-kms-admin \
         orders-db-too-long unknown-resource bad-level no-level hours-not-finite; do
  rm -rf out .loom
  printf '%-22s ' "$r"
  loom run graphs/grant-access.json --input "{\"requestPath\":\"access/requests/$r.json\"}" 2>/dev/null \
    | jq -c 'if .status=="failed"
             then {status, node: (.error.message|capture("on node \"(?<n>[^\"]+)\"").n), code: .error.code}
             else {status, ceremony: .outputs.decision.ceremony} end'
done
rm -rf out .loom
printf '%-22s ' not-a-request.txt
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/not-a-request.txt"}' 2>/dev/null \
  | jq -c '{status, node: (.error.message|capture("on node \"(?<n>[^\"]+)\"").n), code: .error.code}'
rm -rf out .loom
printf '%-22s ' no-such-request
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/no-such-request.json"}' 2>/dev/null \
  | jq -c '{status, code: .error.code, class: .error.class}'
```

```
docs-site-read         {"status":"succeeded","ceremony":"auto"}
docs-site-admin        {"status":"awaiting_gate","ceremony":null}
orders-db-backfill     {"status":"awaiting_gate","ceremony":null}
payments-kms-admin     {"status":"failed","node":"deny","code":"E_FUNCTION_REFUSED"}
orders-db-too-long     {"status":"failed","node":"deny","code":"E_FUNCTION_REFUSED"}
unknown-resource       {"status":"failed","node":"deny","code":"E_FUNCTION_REFUSED"}
bad-level              {"status":"failed","node":"deny","code":"E_FUNCTION_REFUSED"}
no-level               {"status":"failed","node":"weigh","code":"E_FUNCTION_REFUSED"}
hours-not-finite       {"status":"failed","node":"weigh","code":"E_FUNCTION_REFUSED"}
not-a-request.txt      {"status":"failed","node":"weigh","code":"E_FUNCTION_REFUSED"}
no-such-request        {"status":"failed","code":"E_TOOL_SOURCE_UNAVAILABLE","class":"unavailable"}
```

**`"ceremony": null` on the parked rows is the real output and not a shortening.** A run that is
`awaiting_gate` has produced no `outputs` yet, so `.outputs.decision.ceremony` is absent and `jq`
prints `null`. An earlier draft pasted `{"status":"awaiting_gate"}` for that row — tidier, and not
what the command prints.

**Read that as three endings and FOUR failure kinds.** `succeeded` with no gate, `awaiting_gate`,
and `failed` — and `failed` is where a caller needs the detail, because a script wrapping an
access-request workflow has to tell "no" from "we could not tell":

| kind | class / code | where | means |
|---|---|---|---|
| a DENIAL | `validation` / `E_FUNCTION_REFUSED` | node `deny` | we decided, and the answer is no |
| a REFUSAL | `validation` / `E_FUNCTION_REFUSED` | node `weigh` (or `prior`) | we could not decide |
| an INPUT that is not there | `unavailable` / `E_TOOL_SOURCE_UNAVAILABLE` | node `read-request` | the workflow never started |
| a value the JOURNAL rejects | `validation` / `E_RESOURCE_INVALID` | node `weigh` | **fixed — see below** |

**The third row is why only `read-ledger` has an error arm.** A ledger may legitimately not exist;
a request the caller named and did not provide is the caller's bug, and giving it a recovery arm
would invent an empty request rather than say so. The first two share a code, which is F7.

**The fourth row was a defect in this workflow and is fixed.** `"hours": 1e309` parses to
`Infinity`, which IS a number, so the field check passed it; `firstDenial` then denied it for not
being a whole number — and the run failed at `validation`/`E_RESOURCE_INVALID`, *"non-finite number
Infinity at hours"*, because `decision` carries the raw value and the journal will not record one.
**A denial nobody can journal is a denial nobody can read.** `hours-not-finite.json` is the fixture
and it now refuses at `weigh`, naming the value: *"found the non-finite number Infinity"* — which
itself took a second correction, because `JSON.stringify(Infinity)` is the string `"null"` and the
obvious formatter reported it as `number null`, reading as a field that was not there.

Taking the two main failure kinds in turn:

```bash
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/payments-kms-admin.json"}'
```

```json
  "error": {
    "class": "validation",
    "code": "E_FUNCTION_REFUSED",
    "message": "function \"function/grant-deny@stable\" on node \"deny\" refused: access DENIED for u:dana on payments-kms (admin, 2h, request REQ-1043): admin on a secret-tier resource is never granted through an access request — payments-kms holds key material, and that change goes through the break-glass procedure with both owners present. Nothing was written and no grant exists.",
    "retryable": false
  }
```
exit 1.

```bash
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/not-a-request.txt"}'
# → "class": "validation", "code": "E_FUNCTION_REFUSED"
#   "function \"function/grant-weigh@stable\" on node \"weigh\" refused: the request is not JSON
#    (Unexpected token 'w', \"who: dana\n\"... is not valid JSON). This graph decides who may reach
#    a production resource by reading fields off a JSON document; a document it cannot read has no
#    fields, and a request with no fields matches no denial rule."
```

**`grant-weigh.js` refuses FIVE ways and all five are one defect wearing five hats** — the same
defect both earlier ports' refusals are about, in its access-control costume: **a denial rule is a
search for a PROPERTY, and a search for a property run against a document nothing understood finds
nothing and reports a request with nothing wrong with it.** Named, because a count is worth nothing
without its members:

1. **the bytes are not JSON** — the block above;
2. **the JSON parses but is not an OBJECT** — every rule is a property lookup and every lookup on a
   non-object is `undefined`, so the whole table abstains;
3. **a required field is missing, the wrong type, or NOT FINITE** — `who`, `resource`, `level`,
   `hours` (`no-level.json` and `hours-not-finite.json` reproduce the two halves), because
   defaulting one would grant or deny on a value nobody wrote, and `Infinity` passes a `typeof`
   check;
4. **the POLICY is not a policy** — no `resources`, `levels` or `maxHours`, so every request falls
   through to the same answer, and a policy that says the same thing about everything is not one;
5. **either document came back TRUNCATED** — §A.83, `fs.read` putting its marker inside the content.
   A prefix of a policy is a policy with rules missing, and every missing rule reads as *no such
   rule*, which is the permissive direction.

`grant-prior.js` refuses twice more, on a ledger it cannot PARSE. But a ledger it cannot READ is a
different case and its own body cannot see it — **that is F5, and the `look` node is what this
workflow pays to survive it.**

**The hazard, and the defence, measured.** Both are in this document rather than hidden, because a
port's job is to measure the product as it is and then say what it cost to live with:

```bash
rm -rf out .loom
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/docs-site-read.json"}' >/dev/null 2>&1
jq -c '[.grants[].who]' out/access-ledger.json          # → ["u:sam"]

chmod 222 out/access-ledger.json                        # readable by nobody, writable by all
loom run graphs/grant-access.json \
  --input '{"requestPath":"access/requests/docs-site-read-ravi.json"}' 2>/dev/null \
  | jq -c '{status, code: .error.code}'
chmod 644 out/access-ledger.json
jq -c '[.grants[].who]' out/access-ledger.json
```

```
{"status":"failed","code":"E_FUNCTION_REFUSED"}
["u:sam"]
```

with, on the message:

```
function "function/grant-weigh@stable" on node "weigh" refused: "out/access-ledger.json" IS on disk
— fs.glob lists it as "out/access-ledger.json" — but the run reached here on the error arm, which
means fs.read could not open it and this graph was told only that it failed. Granting now would
publish a ledger rebuilt from an empty history and destroy every grant the file already holds. Fix
the file's permissions, or move it aside deliberately if you mean to start a new ledger.
```

**Before the `look` node this block read `{"status":"succeeded","historySource":"none"}` and
`["u:ravi"]` — `u:sam`'s grant gone, exit 0, nothing said.** The `fs.read` failed for a reason that
is not "there is no ledger", the error arm cannot see reasons, and `first-grant` reported a fact
that was false. **The arm is still blind: F5 is a PRODUCT entry and is not closed.** What changed
is that this workflow now asks a second, read-only tool whether the file exists, and refuses when
the two disagree — **which covers ONE of the four ways this read can fail, and fails open on the
rest exactly as the arm does; §3's F5 has the four-pattern table and the case that still loses the
ledger.**

**`$RUN` IS ALREADY DEAD BY HERE, and §3 re-captures it rather than pretending otherwise.** The
sweep above clears `out/` and `.loom/` before every row, deliberately, and the F5 block clears them
again — so the journal `$RUN` named is long gone, and F2's and F3's repros below open with a fresh
run of their own. An earlier draft instead moved the tidy-up to the end and claimed that made the
ordering work; it did not, because the deletions that matter are inside §2, and asserting an
ordering the page does not have is the same defect as asserting a number nobody ran.

**Tidy up.**

```bash
rm -rf "$REPO/examples/out" "$REPO/examples/.loom"
```

### The tests that stop it rotting

**From the repository root:**

```bash
cd "$REPO"
node --test --test-timeout=60000 packages/core/test/examples-grant.test.ts    # 26 pass, 0 fail
node --test --test-timeout=60000 packages/core/test/examples-harden.test.ts   # 23 pass, 0 fail
node --test --test-timeout=60000 packages/core/test/examples-triage.test.ts   # 15 pass, 0 fail
node --test --test-timeout=60000 packages/core/test/examples-run.test.ts      # 15 pass, 0 fail
```

**Twenty-six tests, and what they pin is different from either earlier port because the shape is.**
Port 1's risk is branch ORDER under a fan-out; port 2's is CONVERGENCE of a loop. This graph has
neither. **Its risk is that control went the wrong way — and a graph that routed wrong still exits
0, still writes a grant, and looks exactly like one that routed right.** So the arms are read off
`loom trace` rather than off the outcome:

- **which arm of the error edge ran**, asserted in BOTH directions: the first run runs `first-grant`
  and `prior` must be ABSENT; the second runs `prior` and `first-grant` must be ABSENT. A graph that
  ran both would still produce a grant, off a history two nodes disagreed about — and `merge_object`
  would quietly keep one of them.
- **each of the router's arms**, pinned to the node it must reach and to the two it must not.
  `deny` firing where `record` should have, or the reverse, is the entire failure mode: one of those
  two nodes grants production access and the other refuses it.
- **four denials against four DIFFERENT rule strings**, because a count passes on four copies of one
  rule.
- **the ledger ROUND-TRIP** — the only end-to-end check that what `grant-record.js` writes is
  something `grant-prior.js` can read back. The two bodies cannot import each other (a code resource
  is a bare function expression, `examples/README.md` §2) and agree on a shape by convention alone.
- **two drift tests**: `maxHours.write` and `renewalWithinHours` are edited in the workspace copy
  ALONE and the outcome must follow. The same test port 1's `maxWidth` one is, and the only way to
  know the bodies hold no constant of their own. The renewal one carries a CONTROL run first,
  because without it it would pass against a graph that never renews at all.
- **THE THREE BOUNDS ON A RENEWAL, one test each, each with its own control**, and they are the
  reason this file grew from sixteen tests to twenty-five. §4 has what they cost to learn.
- **the failure TAXONOMY**, all four kinds, asserted on `class` and `code` rather than on prose,
  plus a hostile sweep asserting that every malformed or out-of-policy request leaves `record`
  undispatched and nothing on disk.
- **the compiler's whole diagnostic set, asserted EMPTY**, so a compiler change that starts warning
  about this graph is read rather than absorbed.

**Two pin PRODUCT behaviour rather than the workflow's**, so that the day either changes somebody is
told: **F5's defence in both directions** (a ledger that cannot be read but can be written must be
REFUSED, and the ordinary first run — where there really is no ledger — must still proceed; a
defence that fired on the second would be worse than none), and **the compensation** (a failed
run's already-landed `fs.write` is rolled back, and `out/grant.json` is asserted BYTE-IDENTICAL to
before the failed run).

**EVERY GUARD IN THIS WORKFLOW WAS DELETED ONE AT A TIME AND THE SUITE RE-RUN**, which is the only
evidence that a guard's test tests the guard rather than its neighbours. The table is in §4.

`examples-run.test.ts` picks the new graph up without being edited — its set is the directory — so
the compile and resource-reachability halves were covered before this suite existed.

---

## 3 · Friction log

Every entry is a place the shipped product cost more than it should have, with the command, what
happened, what was expected, and what it cost. **Seven found in the product, none fixed here.**

**Two of the seven are one sentence in two places**, and it is not the sentence port 2's three
shared. Port 2's was *the compiler and the scheduler disagree about whether a `loop` edge is an
edge*. This one is:

> **A DECISION IS MADE FROM A FACT THE GRAPH CANNOT SEE.**
> **F3** — the people who may approve are in `access/policy.json`, read at run time, and
> `approval.approvers` is a static list in the graph file, so the gate shows the right owners and
> accepts the wrong signature.
> **F5** — the reason a node failed is in the tool's result, and an `error` arm is handed none of
> it, so *there is no ledger* and *I could not read the ledger* are the same event.
> **They need the same kind of fix and not the same fix**: a channel-valued approver list for one, a
> failure projection for the other. What makes them one entry is the shape — in both, the runtime
> HAS the fact and the author has no way to spend it.

The other five are their own things: **F1** is a concurrency rule that does not know two edge kinds
are exclusive; **F2** is a graph search with a loud side effect; **F4** is nothing having written any
of this down; **F6** is canonical form, seen from inside one document; **F7** is two different
answers wearing one error code.

**START HERE IF YOU ARE READING STRAIGHT THROUGH.** §2 cleared `out/` and `.loom/` several times —
before every sweep row, and again in the F5 block — so the `$RUN` it captured no longer exists.
F2 and F3 need a live one, so take a fresh pair:

```bash
cd "$REPO/examples"
rm -rf out .loom
RUN=$(loom run graphs/grant-access.json \
      --input '{"requestPath":"access/requests/orders-db-backfill.json"}' 2>/dev/null | jq -r .runId)
GATE=$(loom gates "$RUN" 2>/dev/null | jq -r '.[0].gateId')
echo "$RUN $GATE"
# → 01M346A7WEM7B2HK11C7ZQ9SDD gate_01M346A7WYGVYY337AB43WE6QF
```

That run is parked on its gate, which is all F2 and F3 need — neither answers it.

---

### F1 · `GRAPH010_CONCURRENT_WRITE` refuses the canonical error-handling shape

**Tried.** The obvious graph. One node reads a file; on success a body parses it, on failure a body
supplies the empty case. Both write the same channel, because they are two ways of producing one
value.

```json
{ "id": "read-ledger", "type": "tool",     "writes": ["ledgerDoc"], … },
{ "id": "prior",       "type": "function", "writes": ["history"],   … },
{ "id": "first-grant", "type": "function", "writes": ["history"],   … },
{ "id": "ledger-read", "from": "read-ledger", "to": "prior",       "kind": "seq" },
{ "id": "no-ledger",   "from": "read-ledger", "to": "first-grant", "kind": "error" }
```
with `"history": {"type": "object", "reduce": "replace"}`.

**Happened.** Reproducible on the SHIPPED graph in two commands, which is how it should be read
rather than from a probe that is not in the tree:

```bash
cd "$REPO/examples"
sed -i.bak 's/"history": { "type": "object", "reduce": "merge_object", "onConflict": "last_by_branch" }/"history": { "type": "object", "reduce": "replace" }/' \
  graphs/grant-access.json
loom compile graphs/grant-access.json
mv graphs/grant-access.json.bak graphs/grant-access.json      # put it back
```

```
✗ grant-access.json: GRAPH010_CONCURRENT_WRITE: nodes "prior" and "first-grant" can run concurrently and both write "history", whose reducer `replace` is not multi-writer safe
   fix: change channel "history" to a multi-writer-safe reducer, or sequence "prior" and "first-grant"
E_GRAPH_INVALID: graph has 1 error(s): GRAPH010_CONCURRENT_WRITE
```
exit 1.

**Expected.** To compile. `prior` and `first-grant` cannot run concurrently and cannot BOTH run at
all: one is the `seq` target of `read-ledger` and the other its `error` target, and control takes
exactly one. That is not a fact about this graph — **it is true of every `seq`/`error` pair in every
graph**, because `#errorEdges` is reached only from `outcome.status === "failed"` and `#edgesToTake`
only from a success.

**The mechanism is NOT §A.84's, and that is the useful half.** §A.84 is `validate.ts:364` DROPPING
`loop` and `compensation` from the forward DAG, so their targets look unreachable. `error` is not on
that list — the filter is `e.kind !== "loop" && e.kind !== "compensation"` — so an error edge IS in
the DAG, `prior` and `first-grant` both have `read-ledger` as an ancestor, neither is an ancestor of
the other, and the concurrency rule concludes they overlap. **The edge is visible and its EXCLUSIVITY
is not.** Closing §A.84 by adding kinds to that filter would not touch this.

**The closest relative is §A.40, and it is CLOSED — which is the argument for this entry.** That was
port 1's F2: `GRAPH010` refusing a channel that is provably branch-local, with the workaround leaking
into the body as a `join("\n")` over a one-element array. It closed at `77c245a`, when
`rule010ConcurrentWriters` learned an exemption for a channel that never leaves one fan-out branch,
and `triage-classify.js` deleted the distortion. **This is the same shape one edge kind over**: a
concurrency rule refusing a pair the graph can prove exclusive, and an author reaching for a reducer
they do not mean. §A.48 already records what §A.40's exemption does NOT cover; an exclusivity
exemption for a `seq`/`error` pair would be a second one, and narrower — the pair's exclusivity is
structural rather than dataflow-dependent, since `#errorEdges` is reached only from a failure and
`#edgesToTake` only from a success.

**Neither half of the `fix:` line is what this graph wants, and that was measured rather than
reasoned about.** *Sequence them* is the one thing that cannot be done: putting an edge between the
two arms is asking for the recovery to run after the success. *Change to a multi-writer-safe
reducer* works and is what ships — `merge_object` with `onConflict: "last_by_branch"` — and the
conflict arm it buys can never fire, because the channel has held exactly one contribution on every
run ever measured. **So the reducer is documentation of a hazard that does not exist, chosen to
satisfy a rule about a hazard that does not exist**, and it is recorded in the graph's own
`labels.residue-error-arm` because a reader of the file would otherwise assume the channel really
does have two writers.

**Cost.** Two compiles and a redesign of the channel, early. Small on its own; it is here because it
is the first thing anybody who writes an error edge will hit, and because the `fix:` line sends them
at the one route that is wrong.

---

### F2 · A by-hash graph lookup COMPILES every graph in `graphs/` and prints the others' diagnostics

**Tried.** Approve this graph's gate, in a workspace that also holds `harden-config.json`.

```bash
loom approve "$RUN" "$GATE" --as u:you
```

**Happened.** On stderr, before the run's own output:

```
! harden-config.json: GRAPH002_DEAD_END: terminal node "fix" ends a path on which no declared output is ever written
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "audit" reads "applied", which no upstream node writes and which is not a graph input
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "collate" reads "applied", which no upstream node writes and which is not a graph input
```

**THOSE THREE LINES ARE NOT THE FINDING, AND THIS REPRO DOES NOT DEPEND ON THEM.** They were
measured at `be29cb43`, where `harden-config.json` warns three times. **Another lane in this wave
closes §A.84, after which that graph compiles clean and this count is ZERO — with the mechanism
completely unchanged.** A repro that counts `harden-config` lines would then read as "fixed" and it
would not be. So the repro DROPS ITS OWN noisy graph in and counts whatever names a file the
operator did not ask about:

```bash
cd "$REPO/examples"
cat > graphs/zz-noisy.json <<'JSON'
{ "apiVersion": "loom.dev/v1", "kind": "GraphSpec",
  "metadata": { "name": "zz-noisy", "project": "examples", "version": 1 },
  "policy": { "posture": "out" },
  "channels": { "a": { "type": "string", "reduce": "replace" },
                "b": { "type": "string", "reduce": "replace" } },
  "inputs": [], "outputs": ["b"],
  "nodes": [ { "id": "n", "type": "function", "reads": ["a"], "writes": ["b"],
               "function": { "ref": "function/count@stable" } } ],
  "edges": [] }
JSON
loom compile graphs/zz-noisy.json 2>&1 | head -1
loom replay "$RUN" 2>&1 >/dev/null \
  | /usr/bin/grep -a -E '^! ' | /usr/bin/grep -av 'grant-access' | sed 's/:.*//' | sort | uniq -c
rm -f graphs/zz-noisy.json
```

```
! zz-noisy.json: GRAPH005_UNPRODUCED_READ: node "n" reads "a", which no upstream node writes and which is not a graph input
   3 ! harden-config.json
   1 ! zz-noisy.json
```

**`zz-noisy.json` is not the graph being replayed and its warning is on `loom replay`'s stderr
anyway.** That is the mechanism, and the `1` survives §A.84 closing while the `3` does not.

**On THREE verbs and not on a fourth, measured one at a time** — and the fourth is why this block
counts rather than asserts. An earlier draft of this entry said "four verbs, `approve`, `replay`,
`trace` and `audit`", which was written from the shape of the problem instead of from a run:

```bash
for v in audit replay trace; do
  printf '%-8s stderr harden lines: ' "$v"
  loom $v "$RUN" 2>&1 >/dev/null | /usr/bin/grep -a -c 'harden-config'
done
```
```
audit    stderr harden lines: 0
replay   stderr harden lines: 3
trace    stderr harden lines: 3
```

`loom approve` is the third, measured separately because it takes two positionals — 3 lines, the
block above. **`loom audit` does NOT leak**, and the reason is in its own output: it reports
`not checked — edge.taken-belongs-to-its-node: no edgeSource supplied: the compiled graph is not in
the journal, only its hash`. It never looks the graph up, so it never compiles the directory. `loom
score` was not measured and is not claimed either way.

Naming the file directly is the workaround and the confirmation:

```bash
loom replay "$RUN" --graph graphs/grant-access.json                # NONE
```

**Expected.** Nothing about `harden-config.json`. The operator asked about one run of one graph.

**Why it happens.** These verbs find the graph by the hash the journal recorded, and the search
compiles the candidates in `graphs/` to compare hashes. Every candidate's diagnostics go to stderr
on the way past. `--graph` names the file directly and the noise vanishes, which is both the
workaround and the confirmation.

**Why it is worth an entry rather than a shrug.** It is invisible until a workspace holds a SECOND
graph that warns, which is why neither earlier port could have found it — port 2's graph is the one
producing these lines, so in port 2's walkthrough they read as its own. And it is not cosmetic in
the direction that matters: **an operator approving a production change is being shown three
warnings that name a file they did not run**, and the natural reading is that something is wrong
with what they are about to approve. Worse for a script: `2>&1` on `loom audit` now carries another
graph's `GRAPH002` into whatever reads it.

**Cost.** Twenty minutes of believing `grant-access.json` had warnings, and a bisect against a
one-graph workspace to find that it did not.

---

### F3 · A gate's approvers are STATIC, so a graph cannot ask the people the data says may sign

**Tried.** Name the approvers the policy names. `access/policy.json` says `orders-db` is owned by
`u:ravi` and `u:mina`; `payments-kms` by `u:mina`. `weigh` reads that and puts it in
`decision.owners`. The gate should ask THOSE people.

```json
{ "id": "sign", "type": "human_gate",
  "humanGate": { "ref": "oversight/access@stable",
                 "approval": { "approvers": ["${decision.owners}"] } } }
```

**Happened.** There is no such thing. `ApprovalSpec` has exactly two fields, `approvers` and
`separationOfDuties`, and `approvers` is a list of literal subject strings in the graph FILE.
`${…}` interpolation is a `tool.args` mechanism (`resolveArgs`) and reaches nothing in `humanGate`.
The graph ships `["u:you"]`, and the gate therefore **shows the right owners and accepts the wrong
signature**:

```bash
loom gates "$RUN" 2>/dev/null | jq -c '.[0] | {approvers, owners: .reads.decision.owners}'
# → {"approvers":["u:you"],"owners":["u:ravi","u:mina"]}
```

(`loom gates` prints an ARRAY of rows, so the `.[0] |` is not optional — without it `jq` exits 5
with `Cannot index array with string "approvers"`. An earlier draft pasted the command without it
and the right output beside it, which is the one combination a reader cannot catch by eye.)

`loom approve "$RUN" "$GATE" --as u:you` succeeds. `--as u:ravi` — one of the two people the policy
says owns the resource — is `E_GATE_NOT_AUTHORIZED`.

**Expected.** Either a channel-valued approver list, or a refusal at compile saying this cannot be
expressed. What there is instead is a field that looks like it answers the question and answers a
different one.

**Why this is the interesting half of "no k-of-n field".** `examples/README.md` already states that
k-of-n approval lives in `join`, not in `approval` — N gates and a quorum join. That is a fine answer
for *how many*, and it is not an answer for *which people*, because the N gates are also static. A
policy-driven approver set is not expressible at any N. **Leaving the graph to name `u:you` while the
report names the real owners is the shape every workflow like this one will end up in**, and it is
worth knowing before you design around it.

**Cost.** One design round. The workflow survives it — the gate SHOWS the owners, so a human reading
the gate knows who should be answering — but what ships is an honesty convention rather than an
enforced one, and it is in the graph's `labels.residue-static-approvers` for that reason.

---

### F4 · Nothing in the published surface documents an `error` edge, and no shipped graph had one

**Tried.** Write the error arm from the documentation, as a stranger would.

```bash
git stash list >/dev/null; git -c advice.detachedHead=false checkout -q be29cb43   # THE BASE
/usr/bin/grep -a -n -i 'error edge\|kind: *"error"' README.md examples/README.md   # no output
/usr/bin/grep -al '"error"' examples/graphs/*.json                                  # no output
loom compile --help 2>&1 | /usr/bin/grep -a -i -c 'error edge'                      # 0
```

**MEASURED AT `be29cb43`, WHICH IS THIS LANE'S BASE, AND ALL THREE NOW MATCH.** Run on the final
tree they hit `examples/README.md` (§10, added by this port), `examples/graphs/grant-access.json`
(the graph this port added) and nothing in `--help`. Stating the sha rather than the command's
output today is the only way an "it is not documented anywhere" claim stays checkable after the
thing gets documented — and §10 of `examples/README.md` exists precisely because of this entry, so
the greps invalidating themselves is the entry working rather than the entry being wrong.

**Happened.** That is all of it at the base: three commands, nothing. `README.md` does not mention the kind.
`examples/README.md` has a dedicated paragraph for the fan-out's three parts and one for the
`function` body's verdicts, and nothing for an error edge. No graph in `examples/graphs/` contained
one before this port. Every one of the following had to be read out of `packages/core/src`, and each
was a compile or a run that failed first:

| fact | where it actually lives |
|---|---|
| the kind is `"error"` and it is selected by a FAILURE, never by a `take` | `run/engine.ts` `TAKEABLE_EDGE_KINDS` — an error edge in a `take` is `E_ROUTE_INVALID` |
| `codes` narrows it, and is the only executor read of `EdgeSpec.codes` | `run/engine.ts` `#errorEdges` |
| the codes are NORMALIZED codes, not `errno` strings | `#errorEdges(ctx, w, outcome.error?.code)` |
| the arm's target is in the forward DAG, so it is concurrent with the success arm — F1 | `graph/validate.ts:364`, after `GRAPH010` refused |
| the handler is handed NO reason — F5 | `engine.ts:8462`, after a chmod said so |
| `unhandled: true` is about `GRAPH011` and irreversibility, not about error edges | `rule011And012ErrorPaths` + `vocab.ts` `isHardToUndo` |

**Expected.** One paragraph in `examples/README.md` of the shape §1's fan-out paragraph already has,
and one shipped graph with an error edge in it.

**This is the THIRD instance of one entry.** Port 1's F1 was *a fan-out branch may hold two nodes,
and nothing says so*. Port 2's F1 was *nothing says how to write a loop, and every fact came from
reading the source*. This is that entry for error edges. **The pattern across three ports is the
finding**: the published surface documents the mechanisms the shipped examples happen to use, so
each port pays the full cost for whichever mechanism it is the first to need, and the cost lands on
the stranger rather than on the author. §10 of `examples/README.md` now exists for exactly this
reason.

**Cost.** Roughly a third of the port: four compiles and three runs before the arm did anything, plus
two throwaway graphs written before the real one, because the two facts the whole design rests on
had to be established before there was anything to design. Both are now demonstrated by the shipped
graph instead, which is the point of shipping one: **a node reached by several mutually exclusive
router arms runs exactly once, on whichever arm fired** (§2's sweep — `docs-site-read` reaches
`record` and `docs-site-admin` reaches `sign`, and the suite asserts the un-taken node is ABSENT
from the trace), and **an `error` edge carries a failed `fs.read` to a recovery node inside a run
that then reports `succeeded`** (§2's first `loom trace`).

---

### F5 · An `error` arm is handed no reason, so a workflow deletes its own record and exits 0

**THE ONE TO READ.** F1 costs a reducer. This costs the data.

**Tried.** Handle "there is no ledger yet" and refuse everything else. The arm narrows by code as far
as the surface allows:

```json
{ "id": "no-ledger", "from": "read-ledger", "to": "first-grant",
  "kind": "error", "codes": ["E_TOOL_SOURCE_UNAVAILABLE"] }
```

**Happened.** `codes` narrows by CLASS, and every `fs.read` failure is the one class.
`builtin/tools.ts` catches the open in a single `try` and returns
`{content: "cannot read <path>: <msg>", isError: true}`; `engine.ts:8462` turns any `isError`
without a typed error into `err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, result.content)`. So
ENOENT and EACCES arrive as one code, and **the `content` that distinguishes them reaches no
channel**: the failed task's writes are not applied, and there is no `error` projection an arm can
declare in `reads`.

Measured, on the shipped graph:

```bash
rm -rf out .loom
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/docs-site-read.json"}' >/dev/null 2>&1
jq -c '[.grants[].who]' out/access-ledger.json          # → ["u:sam"]

chmod 222 out/access-ledger.json
loom run graphs/grant-access.json \
  --input '{"requestPath":"access/requests/docs-site-read-ravi.json"}' 2>/dev/null \
  | jq -c '{status, historySource: .outputs.decision.historySource}'
chmod 644 out/access-ledger.json
jq -c '[.grants[].who]' out/access-ledger.json
```

```
{"status":"succeeded","historySource":"none"}
["u:ravi"]
```

**`u:sam`'s grant is gone. The run exited 0. Nothing anywhere said a word.** `first-grant` reported
*there is no ledger yet*, which was false; `grant-record.js` rebuilt the document from the empty
list it was handed; `write-ledger` published it over the real one.

**Expected.** Either the arm can see that this was `EACCES` rather than `ENOENT` and refuse, or the
product says it cannot and the author designs around it. What there is instead is an arm that looks
like a handler and is a `catch {}`.

**The general form, which is why this is not one workflow's problem.** `CLAUDE.md` names the lens:
*a guard answering its undecidable case with the passing value*. An error arm's undecidable case is
*why*, its passing value is *the benign reason I was written for*, and **every error arm anybody
writes will be a body asserting the reason it was built to handle.** The dangerous direction is
always the same one — a workflow that searches for ABSENCES reads a failed read as "nothing is
there", which is port 2's F12 one layer up.

#### What `codes` buys, re-measured — an earlier draft of this entry was WRONG about it

That draft said the narrowing *"does buy something real — `E_CAP_DENIED` and `E_TOOL_NOT_FOUND`
carry typed errors and are excluded, so a capability denial no longer reads as an empty ledger."*
It was reasoned from the code rather than run, and **the case that matters most is not excluded**:

```bash
# point read-ledger at a path OUTSIDE the workspace; everything else unchanged
sed -i.bak 's#"path": "out/access-ledger.json"#"path": "../secrets/../../etc/hosts"#' graphs/grant-access.json
rm -rf out .loom
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/docs-site-read.json"}' 2>/dev/null \
  | jq -c '{status, historySource: .outputs.decision.historySource}'
mv graphs/grant-access.json.bak graphs/grant-access.json
```

```
{"status":"succeeded","historySource":"none"}
```

**A path the sandbox REFUSES takes the arm and reads as "there is no ledger yet".** With the arm
deleted entirely, the code it carries is visible:

```
{"status":"failed","class":"unavailable","code":"E_TOOL_SOURCE_UNAVAILABLE",
 "message":"path \"../secrets/../../etc/hosts\" escapes the sandbox root"}
```

— the same code as a missing file, so it matches the shipped `codes` list. **Three different
outcomes — the file is not there, the file is there and unreadable, the path is one the sandbox will
not serve — are one code**, and the last is a security refusal being read as an empty history. The
corrected claim: `codes` excludes failures that carry a TYPED error, and every `fs.read` failure that
goes through the tool's own `catch` does not, so the narrowing separates none of the three cases an
author of this arm actually cares about.

#### The DEFENCE, which is what this port did instead — and its cost

The draft also said this was **"NOT CLOSABLE FROM THIS SIDE"**, and named `{function, hook}` as the
whole of what an author has. **That was not established: a `tool` node is neither.** `fs.glob` is a
shipped, read-only tool, and it lists a file `fs.read` cannot open:

```bash
chmod 222 out/access-ledger.json
# an fs.glob node over the same path, in a throwaway graph
# → content: "out/access-ledger.json"      the file fs.read has just failed on
```

So the graph gained a `look` node — `fs.glob` over `out/access-ledger.json`, upstream of
`read-ledger` — and `weigh` refuses when **the listing is non-empty AND the history came from the
error arm**, which is exactly the case the arm cannot distinguish and `look` can. Measured on the
defended graph, the same `chmod 222` as above:

```
{"status":"failed","code":"E_FUNCTION_REFUSED"}
["u:sam"]
```

**`u:sam`'s grant survives.** The two-directions test is in the suite, because a defence that also
fired on the ordinary first run — where there really is no ledger — would make the command's first
use impossible.

#### THE DEFENCE ANSWERS ITS OWN UNDECIDABLE CASE WITH THE PASSING VALUE

**The first version of this section claimed three limits, and a reviewer showed the defence was
broken rather than merely narrow.** `ledgerOnDisk` is
`listing !== "" && listing !== "(no matches)"`, and **`fs.glob` says `(no matches)` for "there is
nothing here" AND for "I cannot see what is here".** So the defence has the identical shape to the
gap it stands in for. Measured on the DEFENDED graph:

```bash
rm -rf out .loom
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/docs-site-read.json"}' >/dev/null 2>&1
jq -c '[.grants[].who]' out/access-ledger.json       # → ["u:sam"]

chmod 222 out/access-ledger.json
chmod 333 out                                        # the DIRECTORY cannot be enumerated
loom run graphs/grant-access.json \
  --input '{"requestPath":"access/requests/docs-site-read-ravi.json"}' 2>/dev/null \
  | jq -c '{status, historySource: .outputs.decision.historySource}'
chmod 755 out; chmod 644 out/access-ledger.json
jq -c '[.grants[].who]' out/access-ledger.json
```

```
{"status":"succeeded","historySource":"none"}
["u:ravi"]
```

**The original F5 data loss, verbatim, with the defence in place** — `look [ok]`, `read-ledger
[error]`, `weigh [ok]`, exit 0, `u:sam`'s grant gone.

**ONE WIDENING WAS TRIED AND THERE IS NO SIGNAL TO WIDEN TO.** Four patterns against the
`chmod 333` directory, and the control beside them:

| pattern | `out` listable, ledger `chmod 222` | `out` `chmod 333` |
|---|---|---|
| `out/access-ledger.json` | `out/access-ledger.json` | `(no matches)` |
| `out/*` | `out/access-ledger.json\nout/grant.json` | `(no matches)` |
| `out/**` | — | `(no matches)` |
| `out` | — | `(no matches)` |

`fs.glob` reports a count and a truncation flag and **has no arm for "I could not read the
directory"**, so nothing here separates an empty answer from a blind one. Widening the pattern was
the one thing worth trying and it does not work; anything further would be inventing a signal.

**SO THE CLAIM IS NARROWED TO WHAT WAS MEASURED. The defence covers EXACTLY ONE CASE: a regular
file that is LISTABLE but not readable.** Three others are UNCOVERED BY THE DEFENCE — in all three
`fs.glob` answers `(no matches)`, so `ledgerOnDisk` is false and `weigh` does not refuse — but they
do not all end the same way, and the difference is the whole of what is dangerous here. **One
destroys the ledger silently. The other two fail the run CLOSED, for an unrelated reason: the write
hits the same obstruction the read did.**

| uncovered by the defence | what `fs.glob` says | how the run ends |
|---|---|---|
| the PARENT directory cannot be enumerated (`chmod 333 out`) | `(no matches)` | **succeeds, exit 0, and the ledger is rewritten — the data loss** |
| an escaping SYMLINK at the path | `(no matches)` — glob skips it | fails `unavailable`/`E_TOOL_SOURCE_UNAVAILABLE`; reaches `record` and `write-grant [ok]`, which is then COMPENSATED, and `write-ledger [error]` ends it. The ledger is intact |
| a DIRECTORY at the path | `(no matches)` — glob lists files | the same: fails `unavailable`/`E_TOOL_SOURCE_UNAVAILABLE`, ledger intact |

**Only the first is a silent loss, and only it is pinned as a KNOWN HAZARD.** An earlier version of
the sentence above said all three were "losing the ledger in silence" — which the table beside it
already contradicted, and which is worse than an unmeasured claim, because the measurement was four
lines away. "Uncovered" means the DEFENCE does not catch them; what ends those two runs is the
write failing the same way the read did, which is not something `look` decided.

**An earlier draft gave a FALSE mechanism for the third limit** — *"`look`'s pattern is a different
literal, so `ledgerOnDisk` is false"*. It is the SAME literal; the symlink case globs that exact
path and still answers `(no matches)`. The true sentence is the one in `examples/README.md` §10:
**it answers "does the file exist", not "why did the read fail".**

**This is `CLAUDE.md`'s lens one layer down, and that is the finding.** *A guard answering its
undecidable case with the passing value* — the error arm does it, and **the workaround for it does
it too**. A second read-only tool can only re-ask its own question, and its own question has the
same blind spot, so **no arrangement of read-only tools closes this**. That is why F5 is a PRODUCT
row and why the defence is recorded as a cost with a hole rather than as a fix.

**The hole is pinned NEGATIVELY**, as a test that asserts today's LOSS — `chmod 333 out`, the run
succeeds, the ledger is rewritten — so it cannot stop existing in silence. When F5 closes, that test
should FAIL, and the right change is to delete it along with the `look` node rather than loosen it.

**The remaining limit, which is real and is not this one:** a TOCTOU window. The file can appear or
vanish between `look` and `read-ledger`. That race loses in the failing-CLOSED direction — a
spurious refusal, never a spurious grant — and is the only part of this shape that is safe by
construction.

**What would actually close it** is a projection of the failure — the code and the message — into a
channel the error arm may declare in `reads`. That is a new channel shape, not a new field, and it
needs the answer to *what does an arm see when the failure is not a tool's* before it is designed.

**Also checked and not a closure:** a `preTool` hook sees `{tool, args}` and may only NARROW; it
cannot reach the disk (same sandbox, no `fs`), so it cannot tell the cases apart either.

**Cost.** Found by a `chmod`, not by review; the defence was found by a REVIEWER after this entry had
asserted there was none; and **the defence's own hole was found by the NEXT reviewer after this
entry had asserted it was merely narrow.** Two nodes' worth of graph, one refusal, four tests, and a
`fs.glob` call on every run of a workflow that does not otherwise need one — buying coverage of one
of the four ways this read can fail.

---

### F6 · A channel round-trip canonicalises key order, so one append-only document holds two

**Tried.** Append to a JSON document across runs. `prior` parses the ledger into `history.ledger`;
`record` spreads that and pushes one entry; `write-ledger` writes the result.

**Happened.** Every entry that has been through a CHANNEL comes back alphabetised, and the one built
in the body this run does not:

```bash
node -e 'const l=JSON.parse(require("fs").readFileSync("out/access-ledger.json","utf8"));
         console.log("entry 1:", Object.keys(l.grants[0]).join(","));
         console.log("entry 2:", Object.keys(l.grants[1]).join(","))'
```
```
entry 1: ceremony,decidedBy,decidedByKind,expiresAt,grantedAt,hours,level,reason,renewalOf,requestId,resource,tier,who
entry 2: requestId,who,resource,tier,level,hours,grantedAt,expiresAt,ceremony,decidedBy,decidedByKind,reason,renewalOf
```

**Expected.** One key order in one file.

**SAME MECHANISM AS PORT 2's F9, and cited rather than re-logged** — canonical form is what makes a
state hash comparable across a replay and is not going to change. What is new is the MANIFESTATION,
which is worse than F9's and worth having written down: F9 is a whole document round-tripping, so
the output is consistently sorted and only the DIFF against the input is noisy. Here the document
accumulates, so **run N holds N−1 sorted entries and one unsorted one**, and the file looks
hand-edited. A `git diff` between two runs of this workflow shows one appended entry and, on the
run after that, that same entry rewritten in a different order.

**Cost.** None to the run, and one paragraph of §2 so that a reader does not think the file is
corrupt. Recorded because a workflow that appends to a document is a common shape and this is what it
looks like.

---

### F7 · A denial and a failure-to-decide are the same error code, so only prose tells them apart

**Tried.** Let a caller distinguish *policy says no* from *we could not read your request*. Both are
a body returning `{refuse: {reason}}` — the only verdict a `function` body has for declining.

**Happened.** Identical `class` and `code`; the only difference is the node name inside the message.

```bash
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/payments-kms-admin.json"}' 2>/dev/null \
  | jq -c '{status, class: .error.class, code: .error.code}'
# → {"status":"failed","class":"validation","code":"E_FUNCTION_REFUSED"}
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/not-a-request.txt"}' 2>/dev/null \
  | jq -c '{status, class: .error.class, code: .error.code}'
# → {"status":"failed","class":"validation","code":"E_FUNCTION_REFUSED"}
```

Both exit 1. A script wrapping this workflow — and an access-request workflow is exactly the kind
somebody wraps — must `capture("on node \"(?<n>[^\"]+)\"")` out of the message to tell a denial from
a malformed input, which is what §2's sweep does and what the suite does.

**Expected.** Some way for the GRAPH to say which of the two it meant. The distinction is load-bearing
and the workflow already makes it deliberately: `grant-weigh.js` refuses only when it *cannot
decide*, and everything it *decided against* goes to `deny` through the router's fallback, precisely
so a requester is never told their access was refused on the merits when nobody looked. **The graph
draws the line and cannot publish it.**

**What is NOT the answer, and was tried.** Writing the outcome to a channel and letting the run
succeed: then a denial exits 0, and a caller that ignores the body grants access. Refusing is the
right shape; the missing thing is a discriminator on the refusal — `{refuse: {reason, code}}`, a
graph-declared code the engine carries through.

**Cost.** Small, and it shows up in the test suite rather than in the run: every assertion about
which arm ran has to scrape a node id out of a message string, which is the thing
`docs/handoff-2026-09-22.md` §5 warns about in its own words — *grep for the BYTES rather than for
the field you expect them in* — applied here because there is no field.

---
## 4 · Defects in this port's OWN workflow, and what found each one

Port 2's F14 is eight defects in its own workflow, found by four review rounds, every one of them
*the report asserting something the run had not established*. **This port has nine, and the largest
group is a different class: FIVE SURVIVED BECAUSE NOTHING DISTINGUISHED THEM — #1, #2, #3, #4 and
#8.** Four of those five were hidden by one fixture that satisfies every guard at once; the fifth,
#8, by a TOOL whose one answer covers two facts. **The members are named rather than counted**,
because an earlier draft of this sentence said six and the table under it lists five, which is the
defect this whole section is about. (#5, #6, #7 and #9 are each their own thing: a claim never
established, a claim measured false, a denial the journal would not record, and an ordering
asserted rather than driven.) Recorded in the same log because the METHOD is the transferable part.

**One was found by the author's own mutation sweep, eight across TWO review rounds, six of those
blocking.** Nothing here was found by reading.

| # | defect | found by |
|---|---|---|
| **#1** | the ledger append used the FILTERED grant list | the author's mutation sweep |
| **#2** | two of `findRenewal`'s guards were untested — deleting either kept the suite green | review 1, blocking |
| **#3** | a renewal could WIDEN the level or the hours a person approved | review 1, blocking |
| **#4** | the renewal window restarted on every auto-renewal, so one approval never expired | review 1, blocking |
| **#5** | F5's "not closable from this side" was never established — a `tool` node is neither a function nor a hook | review 1, blocking |
| **#6** | F5's `codes` paragraph claimed a narrowing it does not do | review 1 |
| **#7** | a non-finite `hours` produced a denial the journal would not record | review 1 |
| **#8** | **the defence built for #5 FAILS OPEN** — `chmod 333` on the parent directory reproduces the original F5 loss with it in place | review 2, blocking |
| **#9** | §2 asserted an ordering it did not have: the tidy-up was moved "last" while §2's own clears had already killed the journal `$RUN` names | review 2, blocking |

**#8 IS THE ONE TO CARRY, and it is the sharpest thing in this document.** Round 1 found that F5's
"nothing can close this" was unestablished, and a defence was built and shipped with three limits
written beside it. Round 2 found that **the defence has the same defect as the thing it defends
against** — `fs.glob` answers `(no matches)` for "nothing here" and for "cannot see", so it answers
its undecidable case with the passing value. The author had just spent a section explaining that
lens about somebody else's code. **A workaround for a fail-open guard is a guard, and nobody
audited it as one.**

And #9 is the smaller twin of the same habit: round 1 *fixed* an ordering complaint by asserting a
new ordering, without driving the page top to bottom to check the new one held.

Plus six documentation corrections, each a claim measured and found false: F2's verb count, the
census's `append_ordered` row and its "five of eight" reducers, "three arms" for a router with two
cases, the sweep's tidied `awaiting_gate` row, and the trace's "two child kinds" elision.

---

### #1 · The ledger append used the filtered list — found by MUTATION, not by reading

`grant-prior.js` writes two lists into `history`: `grants`, this requester's history on this
resource — what decides a renewal and what the gate shows — and `ledger`, every entry the file
holds, which exists only because `grant-record.js` REWRITES the whole document. Appending to the
filtered one publishes a ledger holding one person's grants and nobody else's.

```bash
cp examples/resources/function/grant-record.js /tmp/rec.bak
sed -i '' 's/\.\.\.history\.ledger, grant/...history.grants, grant/' examples/resources/function/grant-record.js
node --test --test-timeout=120000 packages/core/test/examples-grant.test.ts
# → ℹ pass 16 / ℹ fail 0
```

**All sixteen passed.** The round-trip test approved a grant for `u:dana` and renewed it for
`u:dana`, so `history.grants` and `history.ledger` were the SAME LIST and the mutation was
invisible. The test's own comment claimed it was checking that earlier entries were carried forward.

**The fix** seeds `u:sam`'s `docs-site` grant first and asserts the final ledger is
`["u:sam","u:dana","u:dana"]`, plus that `weigh` still saw exactly ONE prior grant — the filtered
list must not have grown. **Ask what the fixture makes indistinguishable**, and then make it
distinguishable; here that cost one extra `loom run` in one test.

---

### #2–#4 · The renewal bounds — one fixture hid three defects at once

**This is the entry to read, and it is one sentence: the only renewal the suite exercised was a
minutes-old, same-level, same-hours repeat of an approval.** That single fixture satisfies every
guard simultaneously, so it distinguishes none of them — and the two guards that existed could each
be deleted with the suite staying **16/16 green**.

**#2, measured by the reviewer.** Deleting `grant-weigh.js`'s level guard: a 1h READ grant for
`u:sam` plus a request for WRITE/24h went from `awaiting_gate` (shipped) to `auto` (mutated) — with
the suite green. Deleting the window guard: a 719h-old grant against a 1h window went to `auto`,
suite green. **The drift test that claimed to pin the window set `renewalWithinHours` to 0**, which
exits `findRenewal` at its `windowMs <= 0` guard and never reaches the comparison at all.

**#3, a renewal could WIDEN what a person approved.** Measured before the fix, on the shipped graph:

```
approve orders-db-backfill  (write, 4h)   → a person says yes
run     orders-db-long-write (write, 24h) → {"status":"succeeded","ceremony":"auto","hours":24,
   "why":"u:dana was already granted write on orders-db 0 hours ago, … so this is a renewal
          and not a new grant"}
```

**24h is inside the policy's 24h cap, so `firstDenial` let it past**, and nothing else looked at
width. A human who approved four hours had authorised a day, and the record said "renewal".

**#4, the window restarted on every renewal.** It was measured from `grantedAt` on ANY entry, and
each auto-renewal writes a fresh `grantedAt` — so one approval chains indefinitely at the cap. A
grant expired 718 hours earlier still renewed `auto`.

**The decision, recorded as problem → options → choice**, because it is a policy question and not a
bug fix:

> **Problem.** A renewal skips the person. What may it cover?
> **Option A — renewals only for an IDENTICAL request.** Safe, and wrong in a way that matters:
> somebody trusted with `admin` yesterday would need a second person to be handed `read` today,
> while the wider grant sailed through. It sends the NARROWER request to a human.
> **Option B — any prior grant inside the window** (what shipped). Measured above: widening.
> **Option C, CHOSEN — a renewal may not WIDEN, and only a HUMAN decision starts a window.**
> Same level or higher, same hours or fewer, inside the window measured from the prior grant's own
> `grantedAt`, and the prior grant must be `decidedByKind: "human"`. Narrowing still renews;
> widening is a new decision and goes to a person; a chain of renewals cannot outlive the window
> that the one approval at its root opened.

`grant-record.js` writes `decidedByKind` beside the prose `decidedBy` — **two fields rather than
one, because a guard that greps prose breaks the first time the prose is edited**, and this prose is
written to be read by a person at a gate.

**The comment at `grant-weigh.js:56` was ALSO false and is fixed.** It said the denial-before-renewal
ORDER stopped somebody widening an expired grant by re-asking. The ordering enforces the cap and
nothing else; the bounds live in `findRenewal` and the comment now says so.

**`why` now names both widths** — `a person granted u:dana write/4h … this asks for write/4h, which
is no wider` — so a decision record cannot describe a wider grant as a renewal. That is the fix for
the half of #3 that survives the code being right: a record nobody can audit is a record.

**Four tests, each with a control run**, because a bound test with no control passes against a
`findRenewal` that renews nothing. They seed the ledger BY HAND with explicit ages rather than
building it by approving gates — a history built that way is always seconds old and exactly as wide
as what was asked for, which is the fixture that hid all three defects.

---

### #5–#6 · F5's two false claims

**#5. "NOT CLOSABLE FROM THIS SIDE" was never established.** The sentence named `{function, hook}`
as the whole of what an author has, and **a `tool` node is neither**. `fs.glob` — already used by
`triage-failures` — lists a file `fs.read` cannot open. A defence was built and pinned in both
directions. **See #8: it does not do what round one then claimed for it.**

**#6. The `codes` paragraph claimed a narrowing that does not happen.** Re-measured in F5: a path the
sandbox refuses carries `E_TOOL_SOURCE_UNAVAILABLE`, matches the shipped list, takes the arm, and
reads as an empty history. Both claims were written from the code rather than from a run, which is
`CLAUDE.md`'s *reproduce by running, not by reading* — and the second was written INSIDE an entry
whose whole subject is a guard that cannot see what it is guarding.

---

### #7 · A denial the journal would not record

`"hours": 1e309` parses to `Infinity`, which IS a number, so the `typeof` field check passed it;
`firstDenial` then denied it for not being a whole number, and the run failed at
`validation`/`E_RESOURCE_INVALID` — *"non-finite number Infinity at hours"* — because `decision`
carries the raw value and the journal will not record one. **A denial nobody can journal is a denial
nobody can read.** Refused at `weigh` now, where the reason can still be said. The message needed a
second correction: `JSON.stringify(Infinity)` is the string `"null"`, so the formatter reported it
as `number null`, which reads as a field that is not there.

---

### #8 · The defence built for #5 fails open the same way the gap does

**This is the most useful entry in the document.**

Round one closed #5 by building the `look` node and shipped it with three limits written beside it,
in a section that had just explained `CLAUDE.md`'s lens — *a guard answering its undecidable case
with the passing value* — about the runtime's error arm. **Round two pointed the same lens at the
defence.**

`ledgerOnDisk` is `listing !== "" && listing !== "(no matches)"`. `fs.glob` answers `(no matches)`
for "there is nothing here" and for "I cannot see what is here", and nothing distinguishes them. So
`chmod 333` on the parent directory reproduces the ORIGINAL F5 loss verbatim, with the defence in
place: `look [ok]`, `read-ledger [error]`, `weigh [ok]`, exit 0, a prior grant destroyed. F5 in §3
has the run and the four-pattern table.

**Three things were done, and a fourth deliberately was not.**

1. **One widening was tried** — `out/*`, `out/**`, `out` beside the literal. All four answer
   `(no matches)` against an unlistable directory. `fs.glob` has no arm for "I could not enumerate",
   so there is no signal to build on. **Nothing was invented to cover the gap.**
2. **Every statement of the claim was narrowed to what was measured** — F5's limits, the graph's
   `residue-blind-error-arm` label, `grant-weigh.js`'s own comment and `examples/README.md` §10 —
   to *covers a regular file that is listable but unreadable*, with the three it does not cover
   named: an unlistable parent, an escaping symlink, a directory at the path.
3. **The hole is pinned NEGATIVELY**, asserting today's loss, and vacuity-checked (forcing the
   defence always-on makes that test fail, so it is measuring the hazard and not the weather).
4. **The defence was NOT deleted.** It covers a real case — the plain `chmod 222` that found F5 in
   the first place — and removing it would trade a partial guard for none. What was wrong was the
   claim around it, not its existence.

**The transferable sentence: a workaround for a fail-open guard is itself a guard, and it needs the
same audit.** Nobody gave this one that audit — including the author, in the paragraph where they
were explaining the concept.

**And round one's own third limit gave a FALSE mechanism**, which is #6's shape again one round
later: it said the sandbox-escape case is missed because *"`look`'s pattern is a different
literal"*. It is the same literal. The symlink case globs that exact path and still answers
`(no matches)`. A correction that replaces a false claim with a differently-false one is worse than
the original, and `CLAUDE.md` says so in as many words.

---

### #9 · A fix that asserted an ordering the page does not have

Round one was told the tidy-up deleted the journal F2 and F3 then name. It moved the line to the end
and wrote *"Tidy up — LAST, because `out/` holds the journal `$RUN` names"*. **That is still wrong**:
§2's sweep clears `out/` and `.loom/` before EVERY row, deliberately, and the F5 block clears them
again, so `$RUN` is dead well before the tidy-up either way. Driving §2 straight into §3 printed
`E_RUN_NOT_FOUND`.

The fix is not another ordering claim: **§3 now re-captures `$RUN` and `$GATE` with a pasted run of
its own**, and the tidy-up paragraph says the journal is already gone instead of asserting a
sequence. **The general form — do not fix an ordering complaint by asserting a different ordering;
drive the page top to bottom and see.**

---

### The mutation table — every guard deleted one at a time

The only evidence that a guard's test tests THAT guard rather than its neighbours. Re-run on the
final tree; line numbers are the final file's.

| mutation | result |
|---|---|
| *(baseline)* | **26 pass, 0 fail** |
| `grant-record.js:59` — append `history.grants` instead of `history.ledger` | 25 / 1 — *the ledger ROUND-TRIPS* |
| `grant-weigh.js:217` — delete the human-only guard | 25 / 1 — *BOUND 1* |
| `grant-weigh.js:219` — delete the level guard | 25 / 1 — *BOUND 2a* |
| `grant-weigh.js:221` — delete the hours guard | 25 / 1 — *BOUND 2b* |
| `grant-weigh.js:223` — delete the window guard | 24 / **2** — *BOUND 1* and *BOUND 3* |
| `grant-weigh.js:95-107` — delete F5's defence | 25 / 1 — *F5's DEFENCE* |
| `grant-weigh.js:94` — `ledgerOnDisk = true` (the defence always fires) | 11 / **15**, including the KNOWN HAZARD test |

**The window guard takes TWO tests down and that is correct, not slack.** BOUND 3 by construction,
and BOUND 1 because its ledger holds a human entry outside the window which only the window guard
excludes. Every other mutation is caught by exactly the test written for it.

**The last row is a VACUITY check on the negative pin**, not a guard deletion. A test that asserts
today's LOSS can pass by accident — it would go green against a workflow that had stopped working
entirely — so the defence was forced ON and the hazard test is required to notice. It does.

**The table has now been re-measured THREE times rather than adjusted**: against the 22-test suite,
against 25 when the taxonomy tests landed, and here at 26 with the line numbers moved by F5's
rewritten comment. A count carried across a change is a count nobody ran, which is the same defect
as #1 through #7 wearing an arithmetic costume.

---

### The hostile sweep — every malformed or out-of-policy request fails CLOSED

Measured as a SET rather than one case, and asserted three ways per member, because "the run failed"
and "the run failed after granting access" are the same exit code: exit 1, `record` never
dispatched, and nothing on disk. Members: `not-a-request.txt`, `no-level.json`,
`hours-not-finite.json`, `bad-level.json`, `unknown-resource.json`, `orders-db-too-long.json`,
`payments-kms-admin.json`. All seven fail closed.

---

## 5 · What a further review round finds

*Empty on purpose, and it is the THIRD time this heading has been empty.*

*Round one turned up seven defects, four blocking, in a document whose author had already written
that a builder's own green suite is not evidence — and then shipped a suite that stayed green
through two deleted security guards.*

***Round two turned up two more, both blocking, and one of them was in the FIX round one had just
written*** *— a defence built to close a fail-open guard, which failed open itself, shipped with
three limits beside it of which one gave a mechanism that was false. The author had explained that
exact lens, in that exact section, about somebody else's code.*

*The pattern across the two rounds is not "the author missed things". It is that **every round's own
correction introduced a defect of the class it was correcting**, which is also what port 2's F14
records across four rounds. Read this heading being empty as a fact about who has looked, and
nothing else.*

---
## 6 · What is left open

- **All seven product entries, F1–F7.** None is fixed here; the brief was to record them. **F5 is
  the one a maintainer should look at first**: an error arm is handed no reason, so every arm
  anybody writes is a body asserting the reason it was built to handle. This workflow now DEFENDS
  against its own instance with an `fs.glob` second opinion — that is a cost, not a closure, and
  **it covers ONE of the four ways that read can fail (§3's F5)**, failing open on the other three
  in the same shape as the arm it stands in for. One of those three still destroys the ledger
  silently and is pinned as a KNOWN HAZARD test.
- **The shipped graph carries SIX notes in its own `labels`** — `reads-as`, `residue-error-arm`
  (F1), `residue-static-approvers` (F3), `compiles-silent`, `residue-blind-error-arm` (F5, carrying
  the defence, the one case it covers and the three it does not) and
  `compensation-fires-without-an-edge` — because each is something a reader of the file needs and
  none has anywhere better to live while those rows are open. (The count said five and listed six.
  `node -e` over `metadata.labels` says six. §4's own sentence about counts carried rather than
  re-read applies to this document as readily as to its subject.)
- **`policy.levels`' ARRAY ORDER is an undeclared privilege lattice.** `grant-weigh.js` ranks a
  level by its index, so that array is what says `read < write < admin`, and nothing validates it
  against anything. Reordering it to `["admin","read","write"]` does not reorder a list — it makes
  a prior `read` outrank a requested `admin`, and an auto-renewal could then widen INTO admin. It is
  stated in `access/policy.json`'s own `note` and in `examples/README.md` §10 because it is a
  privilege decision that does not look like one, and **it is the one thing in this workflow a
  reviewer would not think to check**.
- **`merge_object`'s conflict arm is unreachable in this graph** and is therefore untested by it.
  `onConflict: "last_by_branch"` is declared because F1 forced the reducer, not because two writers
  ever meet. A graph that genuinely has two is still unexercised by any example.
- **The rule table lives in one body and the policy in one file, and the DIVISION is untested at
  scale.** Three resources, three levels and six denial rules is a demonstration; a real access
  policy has hundreds of resources and a `deny` message naming one rule stops being readable long
  before that.
- **Nothing here exercises `proc.exec`, a `retry` policy, a `subgraph`, a budget, or a `fanout` with
  a gate inside a branch.** `proc.exec` is the best remaining candidate for a fourth port — it is
  `irreversible`, so it gates by default and refuses auto-retry, and it is the only built-in tool
  that needs a flag before it exists — and a port that drives it needs an answer to the determinism
  question this one declined to answer.
- **The `oversight/access@stable` ref resolves to nothing**, and correctly: `oversight` is one of the
  two `NAME_ONLY_KINDS`, a policy label rather than a document. Worth knowing before you go looking
  for the file. Same as port 1's `oversight/triage@stable`.
- **`loom score` was not driven against this graph.** It has no evaluator node, so `S1` is undefined
  for it; making it scoreable means deciding what "a good access decision" is, which is an exam the
  operator writes.
- **A COMPENSATION FIRED AND THIS PORT DID NOT ASK FOR IT, which is the thing to carry forward.**
  Measured while chasing F5: when `write-ledger` fails after `write-grant` has already landed, the
  engine rolls the grant write back on its own — `fs.write` declares
  `compensation: {tool: "fs.restore"}`, `loom trace` prints `loom.tool (compensate) [ok]` under
  `write-grant`, and `out/grant.json` came back byte-identical to before the failed run. **This graph
  declares no `compensation` edge.** That matches what `graph/validate.ts:364`'s own comment says —
  *rollback is driven by the JOURNAL, not by the graph* — so it is not a discovery about the code;
  it is the first time an EXAMPLE shows it, and nothing in `README.md` or `examples/README.md` said
  it. It also means the rejected migration-runner alternative in §1 was rejected for the right
  reason: the edge would have changed nothing. **Re-confirmed in review**, on a run whose
  `write-ledger` failed after `write-grant` landed: `md5` of `out/grant.json` identical before and
  after, `loom.tool (compensate) [ok]` in the trace.
- **THE LEDGER IS A TRUST BOUNDARY AND THIS WORKFLOW DOES NOT DEFEND IT — stated as a premise, not
  as a gap to be closed here.** Every renewal bound reads `decidedByKind`, `grantedAt`, `level` and
  `hours` straight off `out/access-ledger.json`, so **anything that can write that file can forge
  an approval**: a hand-written entry with `decidedByKind: "human"` and a fresh `grantedAt` buys an
  `auto` grant with no person involved. The graph holds `fs:write` on `out/` by construction — it
  is where it publishes — so the workflow cannot fence its own input, and no arrangement of the
  published surface changes that. **The premise this ships under is that `out/` is as trusted as
  `graphs/` and `resources/`**, which is the same premise `--extension-module`'s argv-only rule
  protects one layer up: a path read out of a FILE must not decide who may approve. A deployment
  that cannot make that assumption needs the ledger behind something the graph cannot write —
  a store with its own authorisation, not a JSON file beside the output.
- **The renewal bounds are a POLICY, and this workflow now states one.** No widening, and only a
  human decision starts a window — §4's #2–#4 record the alternatives. A real deployment might want
  a fourth bound this does not have: a ceiling on how many times one approval may be renewed at all,
  independent of the window. Nothing here measures whether the three are enough at scale.
- **A STRUCTURAL ALTERNATIVE TO F5's DEFENCE, not taken here and worth naming.** Every version of
  this hazard is a REWRITE destroying what it could not read. A ledger written as one file per run
  — `out/ledger/<runId>.json`, folded by `prior` — cannot lose an entry to a failed read, because
  nothing is ever overwritten. It does not fix F5 (a blind arm still under-counts the history, so a
  renewal would be re-reviewed) but it moves the failure from DATA LOSS to a spurious gate, which
  is the failing-closed direction. It was not taken because it is a redesign of §2's whole
  walkthrough at round two of three, and because the port's job here is to measure the product
  rather than to engineer around it.
- **The suite is 26 tests and every GUARD in the workflow is mutation-checked; nothing else is.**
  The mutation table covers `findRenewal`'s three bounds, the ledger append and F5's defence. The
  router arms, the taxonomy and the drift tests are pinned by assertion only, and a reviewer looking
  for the next gap should start by deleting something they cover and seeing whether anything goes
  red.
