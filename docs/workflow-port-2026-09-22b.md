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

**F6 is a fourteenth-style entry of its own kind**, and this port has one member rather than eight:
**a defect in THIS PORT'S OWN suite, found by mutation and not by review** — the round-trip test
passed against a body that published a ledger holding one person's grants and nobody else's. It is
recorded in §4 with the mutation that found it, because the METHOD is the transferable part and this
port had no review round at the time of writing.

**Nothing in F1–F7 is fixed here — it is recorded.** §5 is reserved for what a review round finds in
this document and this workflow, and is empty on purpose.

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
  read-request ─seq─▶ read-policy ─seq─▶ read-ledger ─seq──────▶ prior ─────┐
                                              │                             ├─▶ weigh ─seq─▶ route
                                              └─error(E_TOOL_SOURCE_UNAVAILABLE)─▶ first-grant ─┘
                                                                                                │
  route ─conditional(ceremony == "auto")───────────────────────────▶ record ─┬─seq─▶ write-grant
  route ─conditional(ceremony == "review")─▶ sign (human gate) ─seq─▶ ───────┘   └─seq─▶ write-ledger
  route ─fallbackEdge──────────────────────▶ deny (refuses)
```

| node | type | what it does |
|---|---|---|
| `read-request` | `tool` (`fs.read`) | the request the `requestPath` input names |
| `read-policy` | `tool` (`fs.read`) | `access/policy.json` — the tiers, the levels, the caps |
| `read-ledger` | `tool` (`fs.read`) | `out/access-ledger.json`, **which need not exist** |
| `prior` | `function` | parses the ledger; **refuses if it cannot** |
| `first-grant` | `function` | the ERROR arm: no ledger yet, so nobody has a history |
| `weigh` | `function` | tier × level × hours × history → the ceremony; **refuses on a document it cannot read** |
| `route` | `router` | three arms and a fallback |
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
examples/access/requests/*.json                # nine requests, one per arm
examples/access/requests/not-a-request.txt     # and one that is not JSON at all
```

### Why this shape and not another

The brief was explicit: **overlap the two existing ports as little as possible.** The census was
measured rather than recalled — `node -e` over every file in `examples/graphs/`, reading
`nodes[].type`, `edges[].kind`, `channels[].reduce` and `nodes[].tool.name`:

| | `triage-failures` | `harden-config` | **`grant-access`** |
|---|---|---|---|
| nodes | 8 | 8 | **12** |
| node types | function, human_gate, join, tool | function, human_gate, tool | function, human_gate, **router**, tool |
| edge kinds | fanout, join, seq | conditional, loop, seq | conditional, **error**, seq |
| reducers | append_ordered, replace | append_ordered, replace | append_ordered, **merge_object**, replace |
| tools | fs.glob, fs.read, fs.write | fs.read, fs.write | fs.read, fs.write |

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
3. **A reducer other than `replace` and `append_ordered`.** Five of the eight ship unexercised
   (`merge_object`, `sum`, `max`, `min`, `union_set`); this uses `merge_object`, and F1 is why.
4. **A node reached by two mutually exclusive paths.** `record` sits behind both `granted` (straight
   from the router) and `signed` (from the gate); `weigh` sits behind both `prior` and
   `first-grant`. Nothing demonstrated that, and it is the shape every router tree needs.

Overlap with port 1 is `human_gate`, `function`, `tool`, `fs.read`, `fs.write`, `seq`, `replace`,
`append_ordered`; with port 2, add `conditional`. **That is more overlap than the first two had with
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
writes it on the same path. Ten deadlines and not twelve: `route` and `sign` run no body that could
time out. `packages/core/test/examples-grant.test.ts` asserts the diagnostic set is EMPTY rather
than counting it, so a compiler change that starts warning here fails loudly.

**Run it.** It stops at the gate, and nothing has been written.

```bash
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/orders-db-backfill.json"}'
ls out                                   # ls: out: No such file or directory
```

```
run 01M341ECAWT32N8KKKVB9PD738 — inspect it with: loom trace 01M341ECAWT32N8KKKVB9PD738   ← stderr
{
  "runId": "01M341ECAWT32N8KKKVB9PD738",
  "status": "awaiting_gate",
  "outputs": {},
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "costUsd": 0,
    "wallMs": 0
  }
}
gate gate_01M341ECBF4KZCKBM2AG2TP9WJ on node sign — loom approve 01M341ECAWT32N8KKKVB9PD738 gate_01M341ECBF4KZCKBM2AG2TP9WJ --as YOUR_ID   ← stderr
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
loom.run [unset] 18ms
  loom.task read-request root [ok] 7ms
  loom.task read-policy root [ok] 2ms
  loom.task read-ledger root [error] 1ms
  loom.task first-grant root [ok] 3ms
  loom.task weigh root [ok] 2ms
  loom.task route root [ok] 2ms
  loom.task sign root [unset] 1ms
```

**`read-ledger [error]` inside a run whose own status is `[ok]`.** The ledger does not exist yet, so
the `fs.read` failed, the `error` edge carried control to `first-grant`, and the run carried on. Two
nodes are ABSENT from that list and their absence is the assertion: `prior` (the success arm) never
ran, and neither did `deny`. Each `loom.policy` and `loom.effect (random)` child is elided above;
the `trace:` header naming the graph hash goes to stderr.

**See what you are being asked to approve.**

```bash
loom gates "$RUN" 2>/dev/null
```

```json
[
  {
    "gateId": "gate_01M341ECBF4KZCKBM2AG2TP9WJ",
    "taskId": "sign@root#0",
    "nodeId": "sign",
    "policyRef": "oversight/access@stable",
    "contentDigest": "sha256:eb3a0da4c31b8d347a8a4e421f59777ac37386d4e6e8e16be2b157ede84acd84",
    "raisedAtSeq": 49,
    "raisedAtTs": 1790063358319,
    "state": "open",
    "tier": 0,
    "approvers": [
      "u:you"
    ],
    "allowEdit": [],
    "runId": "01M341ECAWT32N8KKKVB9PD738",
    "onTimeout": "fail",
    "reads": {
      "decision": {
        "cap": 24,
        "ceremony": "review",
        "decidedAt": 1790063358314,
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

47 lines of JSON on stdout, the finished run, ending in

```json
    "wroteGrant": {
      "bytes": 388,
      "path": "out/grant.json"
    },
    "wroteLedger": {
      "bytes": 580,
      "path": "out/access-ledger.json"
    }
```

and **three lines on STDERR that have nothing to do with this run** — that is F2, and you will see
them on `approve`, `replay` and `trace` (but NOT on `audit`):

```
! harden-config.json: GRAPH002_DEAD_END: terminal node "fix" ends a path on which no declared output is ever written
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "audit" reads "applied", which no upstream node writes and which is not a graph input
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "collate" reads "applied", which no upstream node writes and which is not a graph input
```

(`bytes` is a UTF-16 code-unit count and `wc -c` counts BYTES, so `wc -c` says **390** against
`"bytes": 388` and **582** against **580** — a difference of two in each, contributed by **one**
em-dash at three bytes where UTF-16 counts one, in `decidedBy`. The arithmetic is `1 × (3 − 1) = 2`.
Same phenomenon both earlier ports record; re-derived from the files rather than carried.)

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
  "grantedAt": 1790063375796,
  "expiresAt": 1790077775796,
  "ceremony": "review",
  "decidedBy": "a person, at the \"sign\" gate — see `loom gates` for who",
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
  "why": "u:dana was already granted write on orders-db 0 hours ago, within the policy's 720-hour renewal window, so this is a renewal and not a new grant",
  "decidedBy": "automatically, as a renewal of an existing grant"
}
```

**`succeeded`, not `awaiting_gate`: there is no gate on this path at all.** The same command, the
same input, a different ending — because the ledger the first run wrote is now on disk, so
`read-ledger` succeeded, `prior` ran instead of `first-grant`, and `weigh` found a grant inside the
policy's renewal window. **That is both arms of the error edge, driven by running one command
twice**, and it is why this workflow has an error edge rather than having one bolted on.

**The ledger is append-only, and it comes back with two key orders in one file** — F6:

```bash
jq -c '{n: (.grants|length), who: [.grants[].who]}' out/access-ledger.json
# → {"n":2,"who":["u:dana","u:dana"]}

node -e 'const l=JSON.parse(require("fs").readFileSync("out/access-ledger.json","utf8"));
         console.log("entry 1:", Object.keys(l.grants[0]).join(","));
         console.log("entry 2:", Object.keys(l.grants[1]).join(","))'
```

```
entry 1: ceremony,decidedBy,expiresAt,grantedAt,hours,level,reason,renewalOf,requestId,resource,tier,who
entry 2: requestId,who,resource,tier,level,hours,grantedAt,expiresAt,ceremony,decidedBy,reason,renewalOf
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

```bash
rm -rf out .loom
for r in docs-site-read docs-site-admin docs-site-read-ravi payments-kms-admin \
         orders-db-too-long unknown-resource bad-level no-level; do
  printf '%-24s ' "$r"
  loom run graphs/grant-access.json --input "{\"requestPath\":\"access/requests/$r.json\"}" 2>/dev/null \
    | jq -c 'if .status=="failed"
             then {status, node: (.error.message|capture("on node \"(?<n>[^\"]+)\"").n)}
             else {status, ceremony: .outputs.decision.ceremony,
                   historySource: .outputs.decision.historySource} end'
done
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/not-a-request.txt"}' 2>/dev/null \
  | jq -c '{status, node: (.error.message|capture("on node \"(?<n>[^\"]+)\"").n)}'
```

```
docs-site-read           {"status":"succeeded","ceremony":"auto","historySource":"none"}
docs-site-admin          {"status":"awaiting_gate"}
docs-site-read-ravi      {"status":"succeeded","ceremony":"auto","historySource":"ledger"}
payments-kms-admin       {"status":"failed","node":"deny"}
orders-db-too-long       {"status":"failed","node":"deny"}
unknown-resource         {"status":"failed","node":"deny"}
bad-level                {"status":"failed","node":"deny"}
no-level                 {"status":"failed","node":"weigh"}
{"status":"failed","node":"weigh"}
```

**Read that as three endings and one distinction.** `succeeded` with no gate, `awaiting_gate`, and
`failed` — and the failures split between two NODES. `deny` is *we decided, and the answer is no*;
`weigh` is *we could not decide*. **The first two rows are the pair worth staring at**:
`docs-site-read` and `docs-site-admin` differ in ONE field and go to different arms, which is the
check that the ceremony is read off both the tier and the level rather than off the tier alone.

Taking the two failure kinds in turn:

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
3. **a required field is missing or the wrong type** — `who`, `resource`, `level`, `hours`
   (`no-level.json` reproduces it), because defaulting one would grant or deny on a value nobody
   wrote;
4. **the POLICY is not a policy** — no `resources`, `levels` or `maxHours`, so every request falls
   through to the same answer, and a policy that says the same thing about everything is not one;
5. **either document came back TRUNCATED** — §A.83, `fs.read` putting its marker inside the content.
   A prefix of a policy is a policy with rules missing, and every missing rule reads as *no such
   rule*, which is the permissive direction.

`grant-prior.js` refuses twice more, on a ledger it cannot parse: a ledger read as an empty history
would not merely re-review a renewal, it would be REPLACED by a document built from nothing.
**That defence has a hole and the hole is F5**, which is the next block.

**The hazard, measured.** It is in this document rather than hidden because a port's job is to
measure the product as it is:

```bash
rm -rf out .loom
loom run graphs/grant-access.json --input '{"requestPath":"access/requests/docs-site-read.json"}' >/dev/null 2>&1
jq -c '[.grants[].who]' out/access-ledger.json          # → ["u:sam"]

chmod 222 out/access-ledger.json                        # readable by nobody, writable by all
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

**`u:sam`'s grant is gone, and the run exited 0.** The `fs.read` failed for a reason that is not
"there is no ledger", the error arm cannot see reasons, and `first-grant` therefore reported a fact
that was false. F5.

**Tidy up.**

```bash
rm -rf "$REPO/examples/out" "$REPO/examples/.loom"
```

### The tests that stop it rotting

**From the repository root:**

```bash
cd "$REPO"
node --test --test-timeout=60000 packages/core/test/examples-grant.test.ts    # 16 pass, 0 fail
node --test --test-timeout=60000 packages/core/test/examples-harden.test.ts   # 23 pass, 0 fail
node --test --test-timeout=60000 packages/core/test/examples-triage.test.ts   # 15 pass, 0 fail
node --test --test-timeout=60000 packages/core/test/examples-run.test.ts      # 15 pass, 0 fail
```

**Sixteen tests, and what they pin is different from either earlier port because the shape is.**
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
- **the compiler's whole diagnostic set, asserted EMPTY**, so a compiler change that starts warning
  about this graph is read rather than absorbed.

**Two are labelled RESIDUE** and pin product behaviour rather than the workflow's, so that the day
either changes somebody is told: **F5** (the ledger a run cannot read but can write is replaced —
the test asserts today's LOSS, so closing F5 fails it loudly) and **the compensation** (a failed
run's already-landed `fs.write` is rolled back, and `out/grant.json` is asserted BYTE-IDENTICAL to
before the failed run).

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
loom gates "$RUN" 2>/dev/null | jq -c '{approvers, owners: .reads.decision.owners}'
# → {"approvers":["u:you"],"owners":["u:ravi","u:mina"]}
```

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
/usr/bin/grep -a -n -i 'error edge\|kind: *"error"' README.md examples/README.md   # no output
/usr/bin/grep -al '"error"' examples/graphs/*.json                                  # no output
loom compile --help 2>&1 | /usr/bin/grep -a -i -c 'error edge'                      # 0
```

**Happened.** That is all of it: three commands, nothing. `README.md` does not mention the kind.
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

**Neither is a closure, and both were checked:**

- **`codes` narrowing.** Already applied, and it does buy something real — `E_CAP_DENIED` and
  `E_TOOL_NOT_FOUND` carry typed errors and are excluded, so a capability denial no longer reads as
  an empty ledger. It does not separate the two filesystem failures, because they are one code.
- **A `preTool` hook.** A hook sees `{tool, args}` and may only NARROW; it cannot read the disk (same
  sandbox, no `fs`), so it cannot tell the cases apart either. Nothing in `{function, hook}` can.

**What would close it** is a projection of the failure — the code and the message — into a channel
the error arm may declare in `reads`. That is a new channel shape, not a new field, and it needs the
answer to *what does an arm see when the failure is not a tool's* before it is designed.

**Cost.** Found by a chmod, not by review, and only because the ledger round-trip made "what if the
read fails for another reason" a natural question. It is pinned as a RESIDUE test asserting today's
LOSS, so the day an arm can see its reason, the suite fails loudly.

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
entry 1: ceremony,decidedBy,expiresAt,grantedAt,hours,level,reason,renewalOf,requestId,resource,tier,who
entry 2: requestId,who,resource,tier,level,hours,grantedAt,expiresAt,ceremony,decidedBy,reason,renewalOf
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

## 4 · A defect in this port's OWN suite, found by mutation

Port 2's F14 is eight defects in its own workflow, found by four review rounds. **This port had no
review round at the time of writing, so it has one member and a different method**, recorded because
the method is the transferable part.

**The defect.** `grant-prior.js` writes two lists into `history`: `grants`, this requester's history
on this resource — what decides a renewal and what the gate shows — and `ledger`, every entry the
file holds, which exists only because `grant-record.js` REWRITES the whole document. Appending to the
filtered one publishes a ledger holding one person's grants and nobody else's.

**How it was found.** Not by reading. The body was mutated and the suite re-run:

```bash
cp examples/resources/function/grant-record.js /tmp/rec.bak
sed -i '' 's/\.\.\.history\.ledger, grant/...history.grants, grant/' examples/resources/function/grant-record.js
node --test --test-timeout=120000 packages/core/test/examples-grant.test.ts
# → ℹ pass 16 / ℹ fail 0
```

**All sixteen passed.** The round-trip test approved a grant for `u:dana` and renewed it for
`u:dana`, so `history.grants` and `history.ledger` were the SAME LIST and the mutation was invisible.
**A suite that never puts a second person in the ledger cannot tell the two apart** — and the test's
own comment claimed it was checking that earlier entries were carried forward.

**The fix, and the confirmation.** The round-trip test now seeds `u:sam`'s `docs-site` grant first
and asserts the final ledger is `["u:sam","u:dana","u:dana"]`, plus that `weigh` still saw exactly
ONE prior grant — the filtered list must NOT have grown. Re-applying the same mutation:

```
✖ the ledger ROUND-TRIPS: what run one wrote, run two reads back and renews off
ℹ pass 15
ℹ fail 1
```

**The lesson is the one `docs/handoff-2026-09-22.md` §5 already states in another costume**:
*coverage of the guard is not coverage of the gap.* A test that exercises a filtered list and an
unfiltered one with the same contents has covered one line of code and neither of its two meanings.
**Ask what the fixture makes indistinguishable**, and then make it distinguishable — here, by adding
a second person, which cost one extra `loom run` in one test.

---

## 5 · What a review round found

*Empty on purpose. This section is filled by the review round; F1–F7 are the port's findings about
the product and §4 is the one defect its own mutation sweep found. A builder's own green suite is not
evidence, and neither is a builder's own friction log — port 2's F14 is eight defects in a document
whose author believed it was finished.*

---

## 6 · What is left open

- **All seven product entries, F1–F7.** None is fixed here; the brief was to record them. **F5 is
  the one a maintainer should look at first**: it is a measured, silent destruction of a workflow's
  own record, reachable with one `chmod`, and every error arm anybody writes has the same shape.
- **The shipped graph carries four notes in its own `labels`** — `residue-error-arm` (F1),
  `residue-static-approvers` (F3), `residue-blind-error-arm` (F5) and
  `compensation-fires-without-an-edge` — because each is something a reader of the file needs and
  none has anywhere better to live while those rows are open.
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
  reason: the edge would have changed nothing.
