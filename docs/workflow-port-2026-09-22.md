# Porting a real workflow, 2026-09-22 — the second one

`CLAUDE.md` says **the next real workflow somebody ports is worth more than the next invariant
somebody proves**, and that ONE was ported: `examples/graphs/triage-failures.json`, whose port is
`docs/workflow-port-2026-09-09.md`. Its eight friction entries are all closed. Nothing had replaced
it.

This is the second. Same rules: only the published surface, only the shipped binary, **zero changes
under `packages/core/src`**, no fork, no `--extension-module`. Written for somebody who has not read
the code.

The first port's own summary of itself is the bar this one is measured against: *"Running it needed
no source change; making it NATURAL needed eight."* **This one needed no source change either, and
the count is ten.** Six of them are one mechanism — the compiler and the scheduler disagree with each
other about whether a `loop` edge is an edge — and that mechanism cost four of the five round trips
it took to get the graph to run.

**Nothing in this document is fixed here. It is all recorded.**

---

## 1 · What was ported, and why this shape

**`harden-config` — a service manifest brought up to deployment policy one finding per pass,
re-audited after every pass, with a human gate before either file it writes lands.**

Somebody hands you a manifest that has been in production for two years. It pulls `:latest`, runs as
root, has a database password sitting in `env`, logs at `debug`, and has no healthcheck. Fixing that
by hand is twenty minutes and three mistakes. The mistakes are the interesting part, and they are all
the same mistake: **a fix creates a finding that was not there before.** Pin the floating tag and
`pullPolicy: "Always"` becomes a pointless pull on every restart. Stop running as root and a workdir
under `/root` becomes unreadable by the process that lives in it. Move the password behind a
`secretRef` and the manifest now has to declare that secret or the deploy fails at admission.

A one-pass fixer ships a manifest that does not deploy. **Re-auditing after every pass is what finds
them, and that is what a `loop` edge is for.**

```
  load ──seq──▶ parse ──seq──▶ audit ──conditional(!settled && len(applied) < 12)──▶ fix
                                 ▲                                                   │
                                 └──────── loop(until: settled, maxIterations: 16) ───┘

  audit ──conditional(settled || len(applied) >= 12)──▶ collate ──seq──▶ review (human gate)
  review ──seq──▶ write-manifest ──seq──▶ write-report
```

| node | type | what it does |
|---|---|---|
| `load` | `tool` (`fs.read`) | reads the manifest the `manifestPath` input names |
| `parse` | `function` | parses it, and **refuses if it is not a service manifest** |
| `audit` | `function` | folds the fix log over the seed, then reads the result against eight rules |
| `fix` | `function` | decides ONE repair and appends it to the log; **refuses if it cannot progress** |
| `collate` | `function` | builds what the gate shows, the hardened JSON, and the markdown report |
| `review` | `human_gate` | a person sees the whole fix log and everything still open |
| `write-manifest` | `tool` (`fs.write`) | `out/service.hardened.json` |
| `write-report` | `tool` (`fs.write`) | `out/harden-report.md` |

Files added, all inside the published workspace surface — a graph, four `function` bodies, and an
input directory:

```
examples/graphs/harden-config.json
examples/resources/function/harden-{parse,audit,fix,collate}.js
examples/manifests/{orders-api,payments-worker,legacy-gateway,no-image}.json
examples/manifests/not-a-manifest.txt                # the input, not workspace files
```

### Why this shape and not another

The brief was explicit: **different in shape from the first port**, which is fan-out over an input
directory → classify → join → fold → gate → write. Overlap with it here is `seq` and nothing else.

| exercised | `triage-failures` | `harden-config` |
|---|---|---|
| `kind: "loop"` — `until`, `maxIterations` | — | the spine |
| `kind: "conditional"` — `when` | — | both exits from `audit` |
| `append_ordered` accumulating across ITERATIONS | — | `applied`, the fix log |
| a `replace` channel recomputed on every pass beside it | — | `current` |
| the `len()` builtin in an edge expression | — | both `when`s |
| how many tasks run decided by the DATA at run time | — | 9 audits, 8 fixes on the shipped manifest |
| `kind: "fanout"`, `kind: "join"`, a `join` node | the spine | — |

The `replace`/`append` channel pair the brief names is `current` (replace — the manifest as it now
stands) beside `applied` (append_ordered — how it got that way), and the pair is the point: the
person at the gate is shown the end state AND every step that produced it.

**Why it means something offline**, which is the test `examples/README.md` §5 fails on purpose and
§8 passes: every finding is read off the manifest STRUCTURALLY. `image` ending in `:latest` is a
floating tag and nothing else. `user: "root"` is running as root and nothing else. There is no
judgement in any of the eight rules, so there is no model in the graph, and a model would add
nothing. Offline is not a compromise here; it is what the workflow is.

### The alternatives, and why they lost

- **An iterate-until-accepted draft/review cycle.** *Rejected.* It is the loop shape the brief
  suggested first, and offline it is `examples/README.md` §5's trap in a new costume: the draft is a
  model's prose, so a deterministic reviewer would be scoring canned text and a deterministic
  drafter would be producing it. The loop would be real and the workflow would be theatre.
- **A `human_gate` inside a fan-out.** *Rejected as already owned.* `two-person-approval.json` is
  three gates under a quorum join, and §1 of `examples/README.md` already names the gate-inside-a-
  branch case and its residue (`readsMayBeStale`). A third graph over the same seam names no new one.
- **A `subgraph` child.** *Rejected as a decomposition, not a workflow.* A `subgraph` is how you
  reuse a graph you already have; it does not make a chore into a product, and this project's known
  `subgraph` residue (check 12 cannot see an evaluator frozen into `RunGraph.subgraphs`) is a
  property-3 question, not a workflow one.

**There is no `agent` node, deliberately, as in the first port.** The judgement worth a model in
config hardening is the thing this graph refuses to guess at: whether a manifest with no port should
get an exec probe or a port. That decision goes to the human at the gate, as an open finding, with
the remedy spelled out.

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

That last line matters: `out/` and `.loom/` are gitignored, so a checkout somebody has already
experimented in can carry both — and the first thing this walkthrough asserts is that `out/` does
not exist yet.

**Compile it.**

```bash
loom compile graphs/harden-config.json
```

```
! harden-config.json: GRAPH002_DEAD_END: terminal node "fix" ends a path on which no declared output is ever written
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "audit" reads "applied", which no upstream node writes and which is not a graph input
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "collate" reads "applied", which no upstream node writes and which is not a graph input
ok
  deadline load (default): timeoutMs=600000
  deadline parse (default): timeoutMs=600000
  deadline audit (default): timeoutMs=600000
  deadline fix (default): timeoutMs=600000
  deadline collate (default): timeoutMs=600000
  deadline write-manifest (default): timeoutMs=600000
  deadline write-report (default): timeoutMs=600000
```
exit 0. **All three warnings are false**, and you will see them on every command below — friction
**F7**. `fix` is not terminal (it has a `loop` edge out of it) and `applied` is written by `fix`
upstream of both readers (over a `loop` edge). Seven deadlines, not eight: `review` is a gate and
runs no body that could time out.

**Run it.** It stops at the gate, and nothing has been written.

```bash
loom run graphs/harden-config.json --input '{"manifestPath":"manifests/orders-api.json"}'
ls out                                   # ls: out: No such file or directory
```

```
! harden-config.json: GRAPH002_DEAD_END: …                                          ← stderr
! harden-config.json: GRAPH005_UNPRODUCED_READ: …  (×2)                             ← stderr
run 01M33CGY9APP56M85Q2YT0VH8Y — inspect it with: loom trace 01M33CGY9APP56M85Q2YT0VH8Y   ← stderr
{
  "runId": "01M33CGY9APP56M85Q2YT0VH8Y",
  "status": "awaiting_gate",
  "outputs": {},
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "costUsd": 0,
    "wallMs": 0
  }
}
gate gate_01M33CGYAFVQFJAN75R1WF83AH on node review — loom approve 01M33CGY9APP56M85Q2YT0VH8Y gate_01M33CGYAFVQFJAN75R1WF83AH --as YOUR_ID   ← stderr
```
exit 0. **Stdout is the JSON object and nothing else**, which is the first port's F4 holding on a
second graph: `loom run … 2>/dev/null | jq .status` prints `"awaiting_gate"` here too.

Capture the two coordinates the rest needs:

```bash
RUN=$(loom run graphs/harden-config.json --input '{"manifestPath":"manifests/orders-api.json"}' \
      2>/dev/null | jq -r .runId)
GATE=$(loom gates "$RUN" 2>/dev/null | jq -r '.[0].gateId')
echo "$RUN $GATE"
```

**Watch the loop.** This is the observable that matters, and it is the one thing no other example in
this workspace can show you:

```bash
loom trace "$RUN" 2>/dev/null
```

```
loom.run [unset] 36ms
  loom.task load root [ok] 5ms
  loom.task parse root [ok] 3ms
  loom.task audit root [ok] 1ms
  loom.task fix root [ok] 2ms
  loom.task audit root [ok] 1ms
  loom.task fix root [ok] 2ms
  …audit, fix, audit, fix, audit, fix, audit, fix, audit, fix, audit, fix…
  loom.task audit root [ok] 1ms
  loom.task collate root [ok] 2ms
  loom.task review root [unset] 1ms
    loom.policy [ok] 0ms
    loom.gate review [unset] 0ms

conformance: ok
```

**Nine `audit` and eight `fix`**, alternating, each with a `loom.policy` and a `loom.effect (random)`
child elided above. The ninth audit is the one that found nothing left to repair, which is what
`settled` means and the only reason the loop exited. The `trace:` header naming the graph hash goes
to stderr, as does every warning.

**They are also nine identical lines** — friction **F8**. The iteration is in the TaskId (`loom
gates` prints `"taskId": "review@root#8"`) and the trace does not show it, so which pass a failure
happened on is not in this output.

**See what you are being asked to approve.**

```bash
loom gates "$RUN" 2>/dev/null
```

```json
[
  {
    "gateId": "gate_01M33CGYAFVQFJAN75R1WF83AH",
    "taskId": "review@root#8",
    "nodeId": "review",
    "policyRef": "oversight/harden@stable",
    "contentDigest": "sha256:f03006e98e40026bb971199ac10a05f373f671403f003eebc859ef14c5d50698",
    "raisedAtSeq": 148,
    "raisedAtTs": 1790041422159,
    "state": "open",
    "tier": 0,
    "approvers": ["u:you"],
    "allowEdit": [],
    "runId": "01M33CGY9APP56M85Q2YT0VH8Y",
    "onTimeout": "fail",
    "reads": { "report": { … } }
  }
]
```

`reads.report` is the whole thing — the gate node declares `"reads": ["report"]`, so the report it
is holding comes down the same call. The three numbers a person decides on:

```bash
loom gates "$RUN" 2>/dev/null | jq '.[0].reads.report | {passes, stoppedBy, cascades, open: (.open|length)}'
# → { "passes": 8, "stoppedBy": "settled", "cascades": 3, "open": 0 }

loom gates "$RUN" 2>/dev/null | jq -r '.[0].reads.report.applied[] | "\(.pass) \(.rule) \(.at)"'
```

```
1 floating-image-tag image
2 pull-policy-redundant pullPolicy
3 runs-as-root user
4 workdir-not-readable workdir
5 plaintext-secret env.DB_PASSWORD
6 secret-not-declared secrets
7 debug-logging-in-prod env.LOG_LEVEL
8 no-healthcheck healthcheck
```

**Passes 2, 4 and 6 are the argument for the whole workflow.** None of those three findings existed
when the run started. Each was created by the fix immediately before it, and only a re-audit after
every pass could have found them.

**Approve it — this is the path that produces the deliverables.**

```bash
loom approve "$RUN" "$GATE" --as u:you
```

Not silent: 132 lines of JSON, the finished run, ending in

```json
    "wroteManifest": { "bytes": 476,  "path": "out/service.hardened.json" },
    "wroteReport":   { "bytes": 1226, "path": "out/harden-report.md" }
```

(`bytes` is a UTF-16 code-unit count, so `wc -c` says 1232 for the report — it has six multibyte
dashes in it. Same note as the first port's.)

```bash
cat out/harden-report.md
```

```markdown
# Config hardening — orders-api

8 fix(es) applied to `manifests/orders-api.json` over 8 pass(es); the audit then found nothing further this tool can repair.

3 of those 8 fix(es) closed a finding that DID NOT EXIST when the run started — each was created by an earlier fix, and only a re-audit after every pass could have found it.

## Applied, in order

| pass | rule | where | was | now |
|---|---|---|---|---|
| 1 | `floating-image-tag` | `image` | `registry.internal/orders-api:latest` | `registry.internal/orders-api:1.8.3` |
| 2 | `pull-policy-redundant` *(after `floating-image-tag`)* | `pullPolicy` | `Always` | `IfNotPresent` |
| 3 | `runs-as-root` | `user` | `root` | `app` |
| 4 | `workdir-not-readable` *(after `runs-as-root`)* | `workdir` | `/root/app` | `/srv/app` |
| 5 | `plaintext-secret` | `env.DB_PASSWORD` | `hunter2` | `{"secretRef":"db-password"}` |
| 6 | `secret-not-declared` *(after `plaintext-secret`)* | `secrets` | `[]` | `["db-password"]` |
| 7 | `debug-logging-in-prod` | `env.LOG_LEVEL` | `debug` | `info` |
| 8 | `no-healthcheck` | `healthcheck` | *(absent)* | `{"httpGet":{"path":"/healthz","port":8080}}` |

## Still open — 0

Nothing.

The hardened manifest is `out/service.hardened.json`.
```

```bash
cat out/service.hardened.json
```

```json
{
  "env": {
    "DB_PASSWORD": { "secretRef": "db-password" },
    "LOG_LEVEL": "info",
    "REGION": "eu-west-1"
  },
  "healthcheck": { "httpGet": { "path": "/healthz", "port": 8080 } },
  "image": "registry.internal/orders-api:1.8.3",
  "name": "orders-api",
  "ports": [8080],
  "pullPolicy": "IfNotPresent",
  "release": "1.8.3",
  "secrets": ["db-password"],
  "stage": "prod",
  "user": "app",
  "workdir": "/srv/app"
}
```
(shown with the inner objects folded onto one line for this document; the real file is two-space
indented throughout.) **The keys are in alphabetical order and the input's were not** — friction
**F9**. A `git diff` against `manifests/orders-api.json` is the whole file rather than the eight
fixes, which is why the fix table above exists.

**Hardening the hardened manifest applies ZERO fixes**, and that is the check worth running:

```bash
cp out/service.hardened.json manifests/round-two.json
loom run graphs/harden-config.json --input '{"manifestPath":"manifests/round-two.json"}' 2>/dev/null | jq -r .runId
loom gates <thatRunId> 2>/dev/null | jq '.[0].reads.report | {passes, stoppedBy}'
# → { "passes": 0, "stoppedBy": "settled" }
rm manifests/round-two.json
```

Zero passes is every detector in `harden-audit.js` agreeing with every repair in `harden-fix.js`. A
rule whose repair does not clear its own detector converges to the pass budget instead, and this
catches it without knowing which rule it was.

**Trust what it did.**

```bash
loom replay "$RUN"      # → {"match": true, "hermetic": true}      exit 0
loom audit  "$RUN"      # → ok — 16 rule(s) checked, 12 skipped    exit 0
```

`hermetic: true` over a seventeen-`function`-task run is the load-bearing word: the `fs.read`, both
`fs.write`s, the human's decision, and the seeded PRNG draw the engine journals for every one of
those tasks were all served from the journal rather than re-executed.

**Three more manifests, because three arms of this workflow only show up on them.**

```bash
# 1 · A finding the tool CANNOT repair. No port is declared, so there is no probe target to invent.
loom run graphs/harden-config.json --input '{"manifestPath":"manifests/payments-worker.json"}' 2>/dev/null | jq -r .runId
loom gates <runId> 2>/dev/null | jq '.[0].reads.report | {passes, stoppedBy, open: .open[0].rule}'
# → { "passes": 1, "stoppedBy": "settled", "open": "no-healthcheck" }
```

**`settled` means "no AUTO-FIXABLE finding remains", not "no finding remains"**, and the difference
is the whole design. The other definition spins the loop to its budget on every manifest carrying an
unrepairable finding, and then headlines the report with an exhausted budget instead of with the one
thing a person has to decide.

```bash
# 2 · Dirtier than the pass budget. Seven inline credentials is fourteen fixes; the budget is twelve.
loom run graphs/harden-config.json --input '{"manifestPath":"manifests/legacy-gateway.json"}' 2>/dev/null | jq -r .runId
loom gates <runId> 2>/dev/null | jq '.[0].reads.report | {passes, stoppedBy, cascades, open: (.open|length)}'
# → { "passes": 12, "stoppedBy": "budget", "cascades": 5, "open": 1 }
```

A budget stop parks on a gate and exits 0 exactly like a converged one. The only thing that tells
them apart is the report's own first paragraph: *"**the pass budget ran out with auto-fixable
findings still open** — this manifest is better, not done."* A run whose report did not say so would
be a person approving a manifest they believe is finished.

```bash
# 3 · Two refusals, because each is a promise.
loom run graphs/harden-config.json --input '{"manifestPath":"manifests/not-a-manifest.txt"}'
```

```json
  "error": {
    "class": "validation",
    "code": "E_FUNCTION_REFUSED",
    "message": "function \"function/harden-parse@stable\" on node \"parse\" refused: \"manifests/not-a-manifest.txt\" is not JSON (Unexpected token 'a', \"name: order\"... is not valid JSON). This graph audits a JSON service manifest; every rule it holds would abstain on a document it cannot read, and eight abstentions print as a clean bill of health.",
    "retryable": false
  }
```
exit 1.

```bash
loom run graphs/harden-config.json --input '{"manifestPath":"manifests/no-image.json"}'
# → "class": "validation", "code": "E_FUNCTION_REFUSED"
#   "…\"manifests/no-image.json\" is JSON but not a service manifest: it declares no image.
#     Every policy rule keys off those two fields, so all eight would abstain and the report
#     would say this manifest is already compliant."
```

**Both refusals are one defect wearing two hats, and it is the same defect the first port's four
refusals are about:** auditing is a search for ABSENCES, and a search for absences run against a
document nothing understood finds nothing and reports a clean bill of health. `{refuse: {reason}}`
makes that `validation`/`E_FUNCTION_REFUSED` — the graph declined — rather than the
`internal`/`E_INTERNAL` a `JSON.parse` left to throw would have worn.

The third refusal, in `harden-fix.js`, is the one you should not be able to reach: a repair that
leaves its own finding in place would be re-reported next pass and spin the loop to its budget, so
it refuses HERE, where the rule that did it is still known and can be named. The idempotence check
above is what keeps it unreachable.

**Tidy up.**

```bash
rm -rf "$REPO/examples/out" "$REPO/examples/.loom"
```

### The tests that stop it rotting

**From the repository root:**

```bash
cd "$REPO"
node --test --test-timeout=60000 packages/core/test/examples-harden.test.ts   # 13 pass, 0 fail
node --test --test-timeout=60000 packages/core/test/examples-triage.test.ts   # 15 pass, 0 fail
node --test --test-timeout=60000 packages/core/test/examples-run.test.ts      # 15 pass, 0 fail
```

Thirteen tests. Four of them are the ones the first port's suite has no analogue for, because its
shape has no loop: **the pass count** (nine audits and eight fixes read out of `loom trace` — a
graph that silently stopped after one pass would still park on a gate, still write a report and
still exit 0, with a manifest carrying three findings its own fixes created); **the cascade order**
(every `cascadeOf` entry is required to appear after the entry that created it, which is the
assertion that re-auditing found it rather than luck); **idempotence** (hardening the output applies
zero fixes); and **the budget's home** (`len(applied) >= 12` edited down to `3` in the workspace copy
alone, with the run required to stop at the new number — the same drift test the first port's
`maxWidth` one is, and the only way to know the bodies hold no constant of their own). The
thirteenth is labelled `RESIDUE` and pins **F5** so that the day it improves, somebody is told.

`examples-run.test.ts` picks the new graph up without being edited — its set is the directory — so
the compile and resource-reachability halves were covered before this suite existed.

---

## 3 · Friction log

Every entry is a place the shipped product cost more than it should have, with the command, what
happened, what was expected, and what it cost. **Ten found.** None is fixed here.

**Six of the ten are one mechanism**, stated once so the entries can be read against it:

> **A `loop` edge is an edge to the scheduler and not an edge to the compiler.** `graph/validate.ts`
> filters `kind !== "loop"` out before computing the forward DAG, and every analysis built on that
> DAG — entry nodes, terminal nodes, ancestry, concurrency, producer-before-consumer — behaves as if
> the back-edge were not there. `run/engine.ts` then schedules it. F2, F3, F5, F7 and F10 are that
> disagreement; F1 is nothing having written it down; F6 is the same absence in `ctx.node.out`.

### F1 · Nothing in the published surface says how to write a loop, and every fact came from reading the source

**Tried.** Write the graph from the documentation, as a stranger would. `README.md` advertises
bounded loops twice:

```bash
/usr/bin/grep -n 'bounded loops' README.md
```
```
43:Reach for the graph: fan-out and branch-ordered joins, routers, bounded loops, human-gate nodes,
80:| **Executor** | Parallel fan-out, branch-ordered joins, bounded loops, retries. All eight node types run: …
```

**Happened.** That is all of it. `examples/README.md` has a dedicated paragraph for the fan-out
("**The three parts that have to agree**, which is the step that costs people compiles") and no
equivalent for a loop; **no graph in `examples/graphs/` contained a `loop` edge** before this one
(`/usr/bin/grep -al '"loop"' graphs/*.json` matches `harden-config.json` and nothing else); and the
only occurrence of the string in `loom compile --help` is "loopback", in a note about the network
sandbox. Every one of the following had to be read out of `packages/core/src` or out of a test
fixture, and each one was a compile or a run that failed first:

| fact | where it actually lives |
|---|---|
| the back-edge is `kind: "loop"` and needs BOTH `until` and `maxIterations` | `graph/validate.ts` `rule006Cycles` |
| `until` is the STOP condition, evaluated on the scope of the node the edge LEAVES | `run/engine.ts` `#loopMayContinue` |
| …with that node's own writes overlaid RAW — F4 | `run/engine.ts` `#edgesToTake` |
| the forward exit needs its own `conditional`, whose `when` must complement the `until` — F5 | `test/graph/fixtures.ts:241` |
| the loop's target needs a NON-loop inbound edge or it is an entry node — F3 | `graph/spec.ts:16`, after the run failed |
| a channel written before the loop and inside it cannot be `replace` — F2 | `GRAPH010`, after it refused |
| `maxIterations` counts passes as `iteration + 1 < maxIterations` | `run/engine.ts` `#loopMayContinue` |

**Expected.** One paragraph in `examples/README.md` of the shape §1's fan-out paragraph already has,
and one shipped graph with a loop in it.

**Cost.** The largest single item in this log: roughly the first half of the port, five compiles and
three runs before the graph did anything, and a redesign (F2) that would have been the design from
the start had the constraint been written down. The first port's F1 was *"a fan-out branch may hold
two nodes, but nothing says so, and it takes two compiles"* — this is that entry, for loops, four
round trips deep instead of two.

---

### F2 · `GRAPH010_CONCURRENT_WRITE` refuses the canonical loop shape: a document seeded before the loop and rewritten inside it

**Tried.** The obvious graph. `parse` writes `manifest`; `fix`, inside the loop, rewrites it.

```json
{ "id": "parse", "type": "function", "writes": ["manifest"], … },
{ "id": "audit", "type": "function", "reads": ["manifest"], "writes": ["findings", "settled"], … },
{ "id": "fix",   "type": "function", "reads": ["manifest", "findings"], "writes": ["manifest", "applied"], … },
{ "id": "first-pass", "from": "parse", "to": "audit", "kind": "seq" },
{ "id": "again", "from": "audit", "to": "fix", "kind": "loop", "until": "settled || len(applied) >= 12", "maxIterations": 16 },
{ "id": "recheck", "from": "fix", "to": "audit", "kind": "seq" }
```

**Happened.**

```
$ loom compile graphs/harden-config.json
✗ harden-config.json: GRAPH010_CONCURRENT_WRITE: nodes "parse" and "fix" can run concurrently and both write "manifest", whose reducer `replace` is not multi-writer safe
   fix: change channel "manifest" to a multi-writer-safe reducer, or sequence "parse" and "fix"
E_GRAPH_INVALID: graph has 1 error(s): GRAPH010_CONCURRENT_WRITE
```

**Expected.** To compile. `parse` and `fix` cannot run concurrently: every path to `fix` goes through
`audit`, and `audit`'s only non-loop inbound edge comes from `parse`. The analysis drops `loop` edges
from the DAG, so `fix` has no ancestors at all and is therefore "concurrent with" every other node.

**Neither half of the `fix:` line gets you a working graph, and that was measured rather than
reasoned about.** *Change to a multi-writer-safe reducer* — the reducer set here is `merge_object`
(`last_write_wins_by_ts` is the other candidate and makes replay depend on recorded clocks, which
`GRAPH013` warns about). Taking it:

```
$ # the two-writer graph, with "manifest": {"type":"object","reduce":"merge_object","onConflict":"last_by_branch"}
$ loom compile graphs/harden-config.json      # → ok, exit 0 — GRAPH010 is satisfied
$ loom run graphs/harden-config.json --input '{"manifestPath":"manifests/orders-api.json"}'
$ loom trace <thatRun>
loom.run [error] 13ms
  loom.task load root [ok] 9ms
  loom.task fix root [error] 10ms        ← at t=0, beside `parse`
  loom.task parse root [error] 3ms
```

The reducer was never what was wrong: `fix`'s only inbound edge is the `loop`, so it is an ENTRY NODE
and runs immediately — F3, reached by a different road. And *sequence `parse` and `fix`* means
putting a non-loop edge between them, which is the shape that runs the fixer before the first audit,
deliberately. **The diagnostic's `fix:` line offers two routes and both end at F3.**

(`merge_object` would also have been wrong on its own terms: it cannot express a key REMOVAL, so it
happens to produce the right answer for these eight fixes — none of them deletes a key — and would
silently stop doing so for the first fix that did. That half is reasoning, not measurement, and is
not why the shape was abandoned.)

**Cost.** A redesign, and the one place this log has something good to say. `current` is now DERIVED:
`fix` writes only the `applied` log, and `audit` folds that log over the parsed seed. One writer per
channel, nothing to refuse — and the fix log is now the state with the manifest as its projection,
which is this project's own *"the journal is the only authoritative state"* one level down, and which
is what gave the gate the `was`/`now` table it shows a person. **The refusal was wrong and the
redesign it forced is better than what it refused.** It cost about an hour and every body in the
workflow was rewritten for it.

---

### F3 · A node whose only inbound edge is the loop's back-edge is an ENTRY NODE, so the loop body runs at t=0

**Tried.** The redesign from F2, compiled clean with two warnings, then run.

**Happened.**

```
$ loom compile graphs/harden-config.json
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "fix" reads "current", which no upstream node writes and which is not a graph input
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "fix" reads "findings", which no upstream node writes and which is not a graph input
ok
$ loom run graphs/harden-config.json --input '{"manifestPath":"manifests/orders-api.json"}'
{
  "status": "failed",
  "error": {
    "class": "internal",
    "code": "E_INTERNAL",
    "message": "Error: E_CHANNEL_UNDECLARED: channel \"current\" is not in this node's declared reads",
    "retryable": false
  }
}
$ loom trace <thatRun>
loom.run [error] 11ms
  loom.task load root [ok] 8ms
  loom.task fix root [error] 9ms      ← at t=0, beside `parse`
  loom.task parse root [error] 3ms
```

**Expected.** Either a compile error naming the shape, or `fix` waiting for the edge that reaches it.
`graph/spec.ts:16` turns out to say it: *"ENTRY NODES are nodes with no inbound non-`loop` edge."*
`fix`'s only inbound edge was the `loop`, so it was an entry node and ran immediately, before
`audit` had written anything.

**Three things made this expensive rather than merely wrong.**

1. `E_CHANNEL_UNDECLARED` is a message about channel declarations. `current` IS in `fix`'s declared
   reads; what was missing was the VALUE, because the node ran before its producer. Ten minutes went
   into re-reading a correct `reads` array.
2. The class is `internal`/`E_INTERNAL` — a bug in the runtime — for a graph-authoring mistake.
3. The two warnings that *were* about it said the wrong thing. `node "fix" reads "current", which no
   upstream node writes` is the symptom; `fix: add "current" to inputs:` is advice that would have
   made a genuinely broken graph compile with no warnings at all.

**Cost.** One run, one trace, and reading `graph/spec.ts` to find out what an entry node is. The fix
is structural: the loop has to be entered by a `conditional` out of `audit` (`repair`), with the
back-edge running `fix → audit` — which then forces F4's problem onto the `until`.

---

### F4 · An `until` on an edge leaving a node that WRITES the channel reads the write, not the channel

**Tried.** The obvious budget on the back-edge, once F3 had moved it to `fix → audit`:
`"until": "settled || len(applied) >= 12"`. `fix` writes `applied`, which is `append_ordered`.

**Happened.** Measured with two probes on a copy of the graph, counting `fix` tasks in `loom trace`:

```
$ # probe A — until: "len(applied) >= 1"
$ loom run … ; loom trace <run> | grep -c 'loom.task fix'
1
$ # probe B — until: "len(applied) >= 2"
$ loom run … ; loom trace <run> | grep -c 'loom.task fix'
8
```

Probe A stopped the loop after ONE fix; probe B never stopped it at all (the run went the full eight
passes and exited by `settled`). So `applied` in that `until` is the node's own one-element
CONTRIBUTION, not the accumulated channel: `len()` of it is 1 on every pass, forever.
`run/engine.ts`'s `#edgesToTake` builds the scope as `{...scopeFor(p, …), ...outcome.writes}`, and
for an `append_ordered` channel `outcome.writes` holds the delta.

**Expected.** The channel's value. `until` is a predicate over channels; `len(applied) >= 12` reads
as "twelve entries have accumulated" and there is nothing at the authoring surface to suggest
otherwise. The idiom is in this repository's own fixtures —
`until: "verdict.pass || len(applied) >= 3"` at `test/graph/fixtures.ts:241` — where it works only
because the node that edge leaves does not happen to write `applied`.

**Cost.** Two probe runs to establish it, and it decides the graph's shape: the budget cannot live on
the back-edge at all, so it lives on the two `conditional` edges out of `audit`, which is where F5
and F6 come from. Silent in the dangerous direction — a bound that never fires, on a loop.

---

### F5 · Nothing checks that a loop's exits are exhaustive, and the price is `internal`/`E_OUTPUT_MISSING`

**Tried.** The stop rule has two homes — the `repair` edge's `when` and the `done` edge's `when` —
and they have to be exact complements. Measured what happens when they are not, by narrowing `done`
alone (which is the plausible typo: "exit when it's settled"):

```json
{ "id": "repair", "from": "audit", "to": "fix",     "kind": "conditional", "when": "!settled && len(applied) < 3" },
{ "id": "done",   "from": "audit", "to": "collate", "kind": "conditional", "when": "settled" }
```

**Happened.**

```
$ loom compile graphs/harden-config.json          # → ok, exit 0
$ loom run graphs/harden-config.json --input '{"manifestPath":"manifests/orders-api.json"}'
{
  "status": "failed",
  "error": {
    "class": "internal",
    "code": "E_OUTPUT_MISSING",
    "message": "run finished without writing any of its declared outputs (report, wroteManifest, wroteReport)",
    "retryable": false
  }
}
exit 1
```

**Expected.** A compile-time refusal, or a message naming the node that took no edge. Both `when`
expressions are individually valid over declared channels, so the compiler accepts the graph; at run
time `audit` reaches a state where neither conditional is true, takes no edge, and the run quiesces.
The message says which outputs are missing and mentions neither `audit`, nor the loop, nor the fact
that a node ended with no outgoing edge selected — so it names the symptom three steps downstream of
the cause, under `internal`.

**Expected, second half.** For the rule to have ONE home. It cannot: F4 rules out the back-edge, and
F6 rules out reading it from a body. The graph therefore states `len(applied) >= 12` twice and the
shipped graph's own `labels.residue-stop-rule-twice` says so, because there is nowhere else to say
it.

**Cost.** One probe run, and a permanent hazard in the shipped example — pinned as the thirteenth
test in `examples-harden.test.ts`, labelled `RESIDUE`, asserting the message does NOT name the loop,
so that improving it fails the test loudly.

---

### F6 · `ctx.node.out` carries `maxIterations` but not `until` or `when`, so an expression bound cannot have one home

**Tried.** The first port's best single lesson is that a bound belongs in the graph and is READ by
the body: `triage-plan.js` takes the fan-out's `maxWidth` off `ctx.node.out` so
`graphs/triage-failures.json` is the number's only home. The report this workflow shows a person
wants the same thing — "stopped after 12 of a budget of 12" — so: what does `ctx.node.out` carry for
a node with a loop edge and for one with conditionals? Measured with a probe body that refuses with
`JSON.stringify(ctx.node.out)`:

**Happened.**

```
function "function/probe-show-out@stable" on node "fix" refused: ctx.node.out =
  [{"id":"recheck","kind":"loop","maxIterations":16}]

function "function/probe-show-out@stable" on node "audit" refused: ctx.node.out =
  [{"id":"repair","kind":"conditional"},{"id":"done","kind":"conditional"}]
```

**Expected.** `until` beside `maxIterations`, and `when` on a conditional. `examples/README.md` §2
documents the shape as `{id, kind, over?, as?, maxWidth?, maxIterations?}`, so this is the surface
behaving as documented — the entry is that the documented set is the wrong set for a loop. An edge's
`maxIterations` is visible and its `until` is not, although `until` is the half that decides, and a
`conditional`'s `when` is invisible entirely.

**Cost.** Small in time and structural in effect: it is why F5's rule has two homes rather than one,
and why `harden-collate.js` reports "stopped by budget" without being able to name the budget. A
loop body cannot state its own ceiling the way a fan-out body can.

---

### F7 · Three false warnings on a correct graph, on every command that touches it

**Tried.** `loom compile`, `loom run`, `loom trace`, `loom replay`, `loom gates` on the shipped graph.

**Happened.** All five print, on stderr:

```
! harden-config.json: GRAPH002_DEAD_END: terminal node "fix" ends a path on which no declared output is ever written
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "audit" reads "applied", which no upstream node writes and which is not a graph input
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "collate" reads "applied", which no upstream node writes and which is not a graph input
```

Of the six verbs tried, `loom audit` is the one that does not.

**Expected.** Silence. All three are false, for the one mechanism above: `fix` is not terminal (it
has a `loop` edge out of it, which is how the run gets back to `audit`); and `applied` is written by
`fix`, which reaches both `audit` and `collate` — over that same `loop` edge. Following either
`fix:` line would make the graph worse: `add "applied" to inputs:` invites a caller to supply a fix
log the graph is supposed to build.

**Cost.** Low per occurrence and unbounded in total. During the port they were noise that had to be
re-read on every command to check no NEW diagnostic had appeared under them — twice something was
missed and re-run. Long term, the first workflow anybody ports with a loop in it prints three
warnings forever, and every reader has to be told they are false: the port doc says so, the graph's
`labels` say so, and `examples/README.md` §9 says so, which is three places the product could have
said nothing instead.

---

### F8 · `loom trace` shows a loop's passes as N identical lines, with the iteration dropped

**Tried.** `loom trace "$RUN"` on the converged run, to see the loop.

**Happened.** Nine of these, byte-identical apart from the duration:

```
  loom.task audit root [ok] 1ms
  loom.task fix root [ok] 2ms
  loom.task audit root [ok] 1ms
```

**Expected.** The pass number. It exists and the system has it: `loom gates` prints
`"taskId": "review@root#8"`, and `examples/README.md` §3 documents the TaskId format as
`nodeId@branch#iteration`. The trace prints `nodeId` and `branch` and drops the iteration.

**Cost.** Moderate and recurring. Every question about a loop is "which pass?" — which pass the
refusal came from, which pass added the finding, whether the cascade landed on pass 4 or pass 6 — and
the trace answers none of them. During the port, pass counts were obtained by
`loom trace … | grep -c 'loom.task fix'`, which is what the test suite now does, and which cannot
tell you the ORDER the two nodes alternated in. The first port's F3 was *"`loom gates` shows a
digest, not the thing being approved"*; this is that entry for the trace.

---

### F9 · A channel value comes back with its object keys canonically sorted, so a config round-trip cannot preserve key order

**Tried.** The workflow reads a JSON manifest, changes eight values, and writes it back. The intent
is a file a person can `git diff` against the original.

**Happened.** The input's key order is `name, stage, release, image, pullPolicy, user, workdir,
ports, env, secrets`. `out/service.hardened.json` is `env, healthcheck, image, name, ports,
pullPolicy, release, secrets, stage, user, workdir` — alphabetical. The body writes
`JSON.stringify(view.require("current"), null, 2)` and `current` came back through the channel with
its keys sorted.

**Expected.** Not a defect, and not something to change: canonical form is what makes a state hash
comparable across a replay, and `hermetic: true` depends on it. What was missing is that it is
written down nowhere a workflow author would look. `examples/README.md` §2 describes what a body is
handed and says nothing about the SHAPE a value comes back in, so the cost lands on whoever writes
the first document-rewriting workflow — a `.json`, a `.yaml`, a lockfile, a `package.json`.

**Cost.** Small, once, plus a false claim caught in review: `harden-collate.js`'s first draft
carried a comment saying *"a diff against the original should read as the fixes and nothing else"*,
which is exactly wrong. Correcting it rather than deleting it is why the fix TABLE is in the report:
the table is the diff, because the file is not.

---

### F10 · Two edges out of one node carrying the same expression produce two byte-identical diagnostics

**Tried.** The first compile, with the stop rule on the `until` of one edge and the `when` of
another — the same expression, as F5 requires.

**Happened.**

```
✗ harden-config.json: GRAPH004_UNDECLARED_READ: `settled || len(applied) >= 12` reads channel "applied", which node "audit" does not declare in `reads`
   fix: add "applied" to node "audit".reads
✗ harden-config.json: GRAPH004_UNDECLARED_READ: `settled || len(applied) >= 12` reads channel "applied", which node "audit" does not declare in `reads`
   fix: add "applied" to node "audit".reads
```

**Expected.** One diagnostic, or two that name their edges. The message names the expression and the
node and not the EDGE, so two edges out of one node carrying one expression are indistinguishable —
and the natural reading of two identical errors is that one of them is a duplicate, i.e. that fixing
it once was not enough. (It is: one edit to `audit.reads` clears both.) A related shape a line
later: when the whole expression is a bare channel name, the sentence reads
`` `settled` reads channel "settled" ``.

**Cost.** A minute of re-reading, and it is in this log for completeness rather than for weight. The
first port's log has an entry of this size too (F6, `examples/.gitignore`).

---

## 4 · What is left open

- **All ten entries.** None is fixed here; the brief was to record them.
- **The shipped graph carries two residues in its own `labels`**, `residue-stop-rule-twice` (F5) and
  `residue-single-writer` (F2), because both are things a reader of the graph needs and neither has
  anywhere better to live while F5 and F6 are open.
- **The rule table lives in two files.** `harden-audit.js` detects and `harden-fix.js` repairs,
  keyed by the same eight rule ids, because a code resource is a bare function expression and cannot
  import a sibling. The duplication is guarded from both ends — the fixer refuses a rule id it has
  no repair for, and the idempotence test catches a repair that does not clear its own detector —
  but it is duplication, and a workflow with forty rules instead of eight would feel it. **Not a
  friction entry**, because the constraint is deliberate (`examples/README.md` §2 states it) and the
  workaround costs one refusal.
- **Eight rules is a demonstration, not a policy.** A real deployment policy has dozens, and the
  one-fix-per-pass discipline that makes this readable at eight would need a budget in the hundreds.
  Whether that is still the right shape at that size is untested.
- **The `until` on the `recheck` edge is a formality.** It reads `settled`, which is false wherever
  it is evaluated: `fix` runs only when the `repair` conditional was true, i.e. when the audit wrote
  `settled: false`, and `fix` does not write `settled`. So the back-edge's real bound is
  `maxIterations: 16` and the real decision is the pair of conditionals out of `audit`. Consistent
  with every run measured — the shipped manifest takes the back-edge on all eight `fix` tasks, and
  an `until` that was ever true there would strand the run at `fix` (which has no other outgoing
  edge) as F5's `E_OUTPUT_MISSING`, which never happened.
  The compiler requires an `until` (`GRAPH006_NO_STOP_RULE`) and F4 rules out putting anything
  meaningful in this one. Recorded here rather than as an eleventh entry because it is F4 and F5
  seen from the graph's side.
