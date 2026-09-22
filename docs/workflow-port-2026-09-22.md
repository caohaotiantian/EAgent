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
the count is thirteen** — F1–F13 below. **Three** of them are one mechanism (the compiler and the
scheduler disagreeing about whether a `loop` edge is an edge), which cost four of the five round trips
it took to get the graph to run; the other ten are ten different things, and an earlier draft of this
document got that grouping wrong in both directions — see the paragraph opening §3. (**The fifth round
trip was mine**, a body still writing the channel name it had before a redesign, and it is not in the
log: the binary named the node, the channel and the declaration in one line and it was fixed in
seconds. That is what the other four should have looked like.)

**F14 is a fourteenth entry of a different kind, and the most useful one to read**: **six defects in
THIS PORT'S OWN workflow**, none found by its author. Two came from a fresh agent told to refute this
log; three more from an independent reviewer who then drove §2 top to bottom; the sixth from a THIRD
review of the paragraph the second round had just written to fix the fifth. Every one of the six is the
same sentence — *the report asserted something the run had not established* — which is the exact defect
class this workflow exists to prevent.

`CLAUDE.md` says **a builder's own green suite is not evidence**. F14 is the receipt three times over,
and the shape of it is worth more than any member: **each round's own correction round missed defects
of the class it had just been fixing.** Round one fixed two and left three; round two fixed three and
wrote the fourth instance of the class into the sentence replacing the third; round three found that
one and a hole round one's own fix had OPENED — the escaping covered the `applied` table, and round
one then made a hostile key land only in the list that had none.

**Nothing in F1–F13 is fixed here — it is recorded.** F14's six are the port's own and are fixed, each
with a test verified to FAIL with its fix reverted.

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
exit 0. **All three warnings are wrong about the REASON and right about a HAZARD** — see F7 — and you will see them on every command below. Friction
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
run 01M33MPNBCQ7N84RNGJJF4HYHZ — inspect it with: loom trace 01M33MPNBCQ7N84RNGJJF4HYHZ   ← stderr
{
  "runId": "01M33MPNBCQ7N84RNGJJF4HYHZ",
  "status": "awaiting_gate",
  "outputs": {},
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "costUsd": 0,
    "wallMs": 0
  }
}
gate gate_01M33MPNCMM68Q8G4T2XGTNG61 on node review — loom approve 01M33MPNBCQ7N84RNGJJF4HYHZ gate_01M33MPNCMM68Q8G4T2XGTNG61 --as YOUR_ID   ← stderr
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
    "gateId": "gate_01M33MPNCMM68Q8G4T2XGTNG61",
    "taskId": "review@root#8",
    "nodeId": "review",
    "policyRef": "oversight/harden@stable",
    "contentDigest": "sha256:c4b44734d30d6aecca7df47a90ed88bd1f05d670ce3b5d3accd84639cbb2ef6a",
    "raisedAtSeq": 148,
    "raisedAtTs": 1790049998228,
    "state": "open",
    "tier": 0,
    "approvers": ["u:you"],
    "allowEdit": [],
    "runId": "01M33MPNBCQ7N84RNGJJF4HYHZ",
    "onTimeout": "fail",
    "reads": { "report": { … } },
    "readsResolved": [],
    "readsUnresolved": [],
    "readsTruncated": {},
    "readsMayBeStale": []
  }
]
```

**The `…` is the only thing elided, and the four `reads*` fields are shown rather than dropped** —
an earlier draft of this paste silently omitted them, which mattered because each is a way `reads`
can be less than it looks: `readsUnresolved` names channels the projection could not recompute,
`readsTruncated` names ones it CUT at 64 KiB (`--max-bytes` is the dial), and `readsMayBeStale` names
ones an earlier node on a fan-out branch has already written. All four are empty here — this gate sits
after no fan-out and its report fits — and a reader who has never seen them full should know they can
be. A quarter-megabyte manifest fills `readsTruncated` and the report stops being readable at the gate;
`packages/core/test/examples-harden.test.ts` hits that case and reads through the disk instead.

`reads.report` is the whole thing otherwise — the gate node declares `"reads": ["report"]`, so the
report it is holding comes down the same call. The numbers a person decides on:

```bash
loom gates "$RUN" 2>/dev/null | jq '.[0].reads.report | {passes, stoppedBy, cascades, startedWith, open: (.open|length)}'
# → { "passes": 8, "stoppedBy": "settled", "cascades": 3, "startedWith": 5, "open": 0 }

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

Not silent: 144 lines of JSON, the finished run, ending in

```json
    "wroteManifest": { "bytes": 476,  "path": "out/service.hardened.json" },
    "wroteReport":   { "bytes": 1252, "path": "out/harden-report.md" }
```

(`bytes` is a UTF-16 code-unit count and `wc -c` counts BYTES, so `wc -c` says 1260 against
`"bytes": 1252` — a difference of eight, contributed by **four** em-dashes at three bytes each where
UTF-16 counts one. An earlier draft said "eight multibyte dashes", conflating the count of dashes with
the count of extra bytes. Same phenomenon as the first port's note, arithmetic restated.)

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

`hermetic: true` over a nineteen-`function`-task run is the load-bearing word: the `fs.read`, both
`fs.write`s, the human's decision, and the seeded PRNG draw the engine journals for every one of
those tasks were all served from the journal rather than re-executed.

**EIGHT more manifests, because every arm of this workflow only shows up on one of them.** Re-run
against a freshly built binary after every fix in this document's `F14`, in one sweep:

```bash
for m in payments-worker legacy-gateway mixed-secrets unquoted-credentials \
         floating-release dotted-env-key; do
  RID=$(loom run graphs/harden-config.json --input "{\"manifestPath\":\"manifests/$m.json\"}" \
        2>/dev/null | jq -r .runId)
  printf '%-22s ' "$m"
  loom gates "$RID" 2>/dev/null \
    | jq -c '.[0].reads.report | {passes,stoppedBy,cascades,startedWith,open:(.open|length)}'
done
```

```
payments-worker        {"passes":1,"stoppedBy":"settled","cascades":0,"startedWith":2,"open":1}
legacy-gateway         {"passes":12,"stoppedBy":"budget","cascades":5,"startedWith":7,"open":2}
mixed-secrets          {"passes":3,"stoppedBy":"settled","cascades":1,"startedWith":2,"open":0}
unquoted-credentials   {"passes":0,"stoppedBy":"settled","cascades":0,"startedWith":2,"open":2}
floating-release       {"passes":0,"stoppedBy":"settled","cascades":0,"startedWith":1,"open":1}
dotted-env-key         {"passes":0,"stoppedBy":"settled","cascades":0,"startedWith":1,"open":1}
```

**Read that table as six different ways the report can be wrong, each now pinned by a test.** The last
four are the manifests F14 added: a cascade whose rule was already in the baseline for another secret
(`mixed-secrets`, `cascades` 0 → 1); two credentials whose values are not strings and which used to
produce ZERO findings (`unquoted-credentials`, `open` 0 → 2); and the two that used to reach the
refusal this document calls unreachable (`floating-release`, `dotted-env-key`, both now `open` 1 with a
remedy instead of a false accusation against the rule table).

Taking the first two in turn:

```bash
# 1 · A finding the tool CANNOT repair. No port is declared, so there is no probe target to invent.
RUN1=$(loom run graphs/harden-config.json \
       --input '{"manifestPath":"manifests/payments-worker.json"}' 2>/dev/null | jq -r .runId)
loom gates "$RUN1" 2>/dev/null | jq -c '.[0].reads.report.open[0] | {rule, autofixable}'
# → {"rule":"no-healthcheck","autofixable":false}
```

**`settled` means "no AUTO-FIXABLE finding remains", not "no finding remains"**, and the difference
is the whole design. The other definition spins the loop to its budget on every manifest carrying an
unrepairable finding, and then headlines the report with an exhausted budget instead of with the one
thing a person has to decide.

```bash
# 2 · Dirtier than the pass budget. Seven inline credentials is fourteen fixes; the budget is twelve.
RUN2=$(loom run graphs/harden-config.json \
       --input '{"manifestPath":"manifests/legacy-gateway.json"}' 2>/dev/null | jq -r .runId)
GATE2=$(loom gates "$RUN2" 2>/dev/null | jq -r '.[0].gateId')
loom gates "$RUN2" 2>/dev/null \
  | jq -c '.[0].reads.report | {passes,stoppedBy,cascades,startedWith,open:(.open|length)}'
# → {"passes":12,"stoppedBy":"budget","cascades":5,"startedWith":7,"open":2}
```

A budget stop parks on a gate and exits 0 exactly like a converged one. The only thing that tells
them apart is the report's own first paragraph: *"**the pass budget ran out with auto-fixable
findings still open** — this manifest is better, not done."* A run whose report did not say so would
be a person approving a manifest they believe is finished.

**`"open": 2` is the number this report used to get wrong**, and it is F14's first defect: the auditor
reported only the FIRST undeclared secret per pass, so the gate said "Still open — 1" on a manifest
with two. The check that does not depend on knowing the number is to harden the output again — it must
need exactly as many passes as there were open auto-fixable findings, and then settle:

**Approve the legacy gate FIRST**, which an earlier draft of this block left out — and the omission is
worth a sentence because it is the same failure as everything in F14. Without it,
`out/service.hardened.json` is still the `orders-api` run's output, the block reads
`{"passes":0,"startedWith":0}`, and the pasted `{2,2}` is a number from a walkthrough nobody could
follow. **Two files in `out/` with no run id in their names is the trap**: they belong to whichever run
was approved last.

```bash
loom approve "$RUN2" "$GATE2" --as u:you >/dev/null      # ← writes THIS run's out/ files
cp out/service.hardened.json manifests/legacy-round-two.json
RUN3=$(loom run graphs/harden-config.json \
       --input '{"manifestPath":"manifests/legacy-round-two.json"}' 2>/dev/null | jq -r .runId)
loom gates "$RUN3" 2>/dev/null | jq -c '.[0].reads.report | {passes,startedWith,cascades,stoppedBy}'
# → {"passes":2,"startedWith":2,"cascades":0,"stoppedBy":"settled"}
rm manifests/legacy-round-two.json
```

`"cascades": 0` is F14's second defect, fixed. Both entries here carry a static
`cascadeOf: "plaintext-secret"`, and counting THAT is what made the old report say *"2 of those 2
fix(es) closed a finding that DID NOT EXIST when the run started"* about two findings that were in the
very first audit. `cascades` is now measured against `startedWith` — the first audit's own finding
list — so it is 0 here and 3 on `orders-api.json`, and the sentence is printed only when it is true.

```bash
# 3 · Four refusals, because each is a promise. Two below; the other two are pinned in the suite.
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

**`harden-parse.js` refuses FOUR ways and all four are one defect wearing four hats**, the same defect
the first port's four refusals are about: auditing is a search for ABSENCES, and a search for absences
run against a document nothing understood finds nothing and reports a clean bill of health. Named,
because a count is worth nothing without its members:

1. **the bytes are not JSON** — the block above;
2. **the JSON parses but is not an OBJECT** — `[1,2,3]` reproduces it, and so does a manifest somebody
   wrapped in an array by accident. This one is easy to miss when counting, which is why the count was
   wrong in two places until it was enumerated;
3. **the object is not a service manifest** — no `name` and/or no `image`, the block above;
4. **the read came back TRUNCATED** (F12) — the one this port shipped wrong, and the one whose failure
   mode is worst: a prefix of a manifest is a manifest with things missing from it, and everything
   missing reads as compliant.

`{refuse: {reason}}` makes all four `validation`/`E_FUNCTION_REFUSED` —
the graph declined — rather than the `internal`/`E_INTERNAL` a `JSON.parse` left to throw would wear.

`harden-fix.js`'s own refusal is the one you should not be able to reach: a repair that leaves its own
finding in place would be re-reported next pass and spin the loop to its budget, so it refuses HERE,
where the rule that did it is still known and can be named. **Two ordinary manifests DID reach it**
until this round — a `release` that is itself `latest`, and an env key containing a dot — each under a
message blaming "the rule's detector and its repair" that was false both times (F14). The idempotence check
above is what keeps it unreachable.

**Tidy up.**

```bash
rm -rf "$REPO/examples/out" "$REPO/examples/.loom"
```

### The tests that stop it rotting

**From the repository root:**

```bash
cd "$REPO"
node --test --test-timeout=60000 packages/core/test/examples-harden.test.ts   # 22 pass, 0 fail
node --test --test-timeout=60000 packages/core/test/examples-triage.test.ts   # 15 pass, 0 fail
node --test --test-timeout=60000 packages/core/test/examples-run.test.ts      # 15 pass, 0 fail
```

**Twenty-two tests.** Four are the ones the first port's suite has no analogue for, because its shape
has no loop: **the pass count** (nine audits and eight fixes read out of `loom trace` — a graph that
silently stopped after one pass would still park on a gate, still write a report and still exit 0,
with a manifest carrying three findings its own fixes created); **the cascade order** (every
`cascadeOf` entry is required to appear after the entry that created it, which is the assertion that
re-auditing found it rather than luck); **idempotence** (hardening the output applies zero fixes); and
**the budget's home** (`len(applied) >= 12` edited down to `3` in the workspace copy alone, with the
run required to stop at the new number — the same drift test the first port's `maxWidth` one is, and
the only way to know the bodies hold no constant of their own).

**Two are labelled `RESIDUE`** and pin product behaviour rather than the workflow's, so that the day
either improves somebody is told: one for **F5** (a `done` edge narrower than the loop's exit) and one
for **F11** (`maxIterations` lowered to the budget). Each asserts that the message does NOT name the
thing it should, which is what makes an improvement fail the test loudly.

**SEVEN exist because a reviewer found the workflow wrong after this suite was green**, and they map
onto F14's six defects — one to one except where noted. Stating the mapping rather than a count,
because an earlier draft said "five" and listed a set that matched neither the tests added nor F14's
members:

| F14 | test | added, or changed? |
|---|---|---|
| **#1** the gate undercounted `open` | *a manifest dirtier than the pass budget…* | **changed** — `open.length > 0` became `== 2`, plus the round-trip completeness check |
| **#2** cascades not measured | *a cascade is MEASURED against the first audit…* | added |
| **#3a** non-string credential skipped | *a credential whose value is not a string is REPORTED…* | added |
| **#3b** identity keyed on rule name | *a cascade is identified by the FINDING…* | added |
| **#4** the "unreachable" refusal reached twice | *two manifests that used to reach the unreachable refusal…* | added |
| **#5** truncated read misreported | *a manifest read back TRUNCATED refuses…* | added |
| **#5** credential bytes in the fix log | *the approval writes both files…* | **changed** — the assertion that blessed `was == "hunter2"` was inverted |
| **#6** "already satisfied every rule" | *a report with nothing applied does not claim…* | added |
| — escaping covered one path only | *a control character in a manifest cannot reach the report…* | added |

So: **15 → 22 tests, seven added and two assertions inverted in place.** Every added one was verified
to FAIL with its fix reverted, and the two changed ones fail against the pre-fix bodies — which is the
only evidence that a regression test tests anything. The `cell()` escaping had NO test until the last
row, and mutating its body to `return String(v);` left the suite green: that is why the hole it covers
survived a whole review round.

`examples-run.test.ts` picks the new graph up without being edited — its set is the directory — so
the compile and resource-reachability halves were covered before this suite existed.

---

## 3 · Friction log

Every entry is a place the shipped product cost more than it should have, with the command, what
happened, what was expected, and what it cost. **Thirteen found in the product (F1–F13), none fixed
here.** F14 is a fourteenth entry of a different kind: **six defects in THIS PORT'S OWN workflow**,
none found by its author — recorded in the same log because the method that found them is the most
transferable thing in this document.

**THREE of the thirteen are one mechanism** — and the first version of this paragraph claimed seven,
then listed six, and attributed three of them to a filter that has nothing to do with them. A
miscounted mechanism sends the next reader to the wrong file, so here is the corrected grouping:

> **THE ONE MECHANISM — a `loop` edge is an edge to the scheduler and not to the compiler.**
> `graph/validate.ts:364` builds the forward DAG as
> `edges.filter(e => e.kind !== "loop" && e.kind !== "compensation")` — it drops `compensation` too —
> and every analysis over that DAG (entry nodes, terminal nodes, ancestry, concurrency,
> producer-before-consumer) behaves as if the back-edge were absent. `run/engine.ts` then schedules
> it. **That is F2, F3 and F7, and only those three.**

The others are their own things, and three were mis-filed:

- **F5 and F10 need no loop at all.** Two non-exhaustive `conditional` edges out of one node produce
  `E_OUTPUT_MISSING` on a graph with no loop edge in it, and two conditionals sharing one expression
  produce the duplicate `GRAPH004` the same way. They are **conditional-edge friction that the loop
  made me meet** — a loop is what forces you to write a pair of complementary conditionals in the
  first place — and filing them under the DAG filter was wrong.
- **F11 is two bounds in two layers**, the graph's `len(applied) >= 12` and the engine's
  `maxIterations`, with the ordering load-bearing and unchecked. Nothing to do with the filter.
- **F1** is nothing having written any of this down; **F4** is the scope an edge expression is
  evaluated against; **F6** an absence in `ctx.node.out`; **F8** a field `loom trace` drops; **F9**
  canonical form; **F12** a built-in tool's cap; **F13** redaction by key name.

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
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "fix" reads "findings", which no upstream node writes and which is not a graph input
   fix: add "findings" to inputs:, or have an upstream node write it
✗ harden-config.json: GRAPH010_CONCURRENT_WRITE: nodes "parse" and "fix" can run concurrently and both write "manifest", whose reducer `replace` is not multi-writer safe
   fix: change channel "manifest" to a multi-writer-safe reducer, or sequence "parse" and "fix"
E_GRAPH_INVALID: graph has 1 error(s): GRAPH010_CONCURRENT_WRITE
```

(The `GRAPH005` line is F7's warning arriving early, and an earlier draft of this entry dropped it from
the paste. It is left in because it is part of what a stranger sees, and because it is the same
mechanism: `fix`'s only inbound edge is the `loop`, so the DAG shows it no producer for `findings`.)

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

### F4 · An `until` on an edge leaving a node that WRITES the channel measures that pass's contribution, not the channel

**Tried.** The obvious budget on the back-edge, once F3 had moved it to `fix → audit`:
`"until": "settled || len(applied) >= 12"`. `fix` writes `applied`, which is `append_ordered`.

**Happened.** Measured with three probes on a copy of the graph, counting `fix` tasks in `loom trace`:

```
$ # probe A — until: "len(applied) >= 1"
$ loom run … ; loom trace <run> | grep -c 'loom.task fix'
1                                            # …and the run FAILS E_OUTPUT_MISSING, i.e. F5's
                                             #    stranding, not a clean stop
$ # probe B — until: "len(applied) >= 2"
$ loom run … ; loom trace <run> | grep -c 'loom.task fix'
8                                            # never fired at all; exited by `settled`
```

**Probe A on its own carries no information** and is shown only because it was the first thing tried:
the "accumulated channel" reading and the "own contribution" reading both predict a stop after one
fix. Probe B is the one that discriminates, and `run/engine.ts`'s `#edgesToTake` says why — it builds
the scope as `{...scopeFor(p, …), ...outcome.writes}`, and for an `append_ordered` channel
`outcome.writes` holds the pass's DELTA, which `harden-fix.js` makes one entry long.

**The precise statement is about the delta's SIZE, not about the number 1**, and the first version of
this entry got that wrong by generalising from this workflow's body. A body appending TWO entries per
call makes `len(applied) >= 2` fire immediately on the same edge — measured on a probe graph whose
only variable is how many entries its body appends:

```
$ # same graph, same `until: "len(log) >= 2"`, body appends 1 entry per call
{"status":"succeeded"}   writer tasks: 20      ← never fired
$ # same graph, same `until`, body appends 2 entries per call
{"status":"failed"}      writer tasks: 1       ← fired on the first evaluation
```

So the honest claim is: **an `until` on an edge leaving a node that writes the channel measures THAT
PASS'S CONTRIBUTION, not the accumulation.** `len(applied) >= 12` cannot fire on `recheck` because
`harden-fix.js` appends one entry per pass — a property of the body, not of the engine.

**AND IT IS NOT ABOUT `until`.** `run/engine.ts:11353` builds the scope ONCE, before the switch that
handles every outgoing kind, so a `conditional`'s `when` out of a writer reads the same delta. That
generalisation is the reason this graph works: the budget lives on the two conditionals out of
**`audit`**, and `audit` does not write `applied` — so what those `when`s read is the accumulated
channel. Move either of them onto an edge out of `fix` and the bound silently stops binding. The rule
to carry is about the WRITER, not about the edge kind: **any edge expression evaluated on a node that
writes the channel it tests sees that node's contribution.**

**Probe C isolates the cause, and is the one to re-run if you doubt this.** `findings` is written by
`audit` and NOT by `fix`, so if the problem were "`until` sees stale or empty state" it would show up
there too. `orders-api.json`'s first audit reports five findings:

```
$ # probe C — until: "len(findings) >= 3", same edge, same evaluation point
$ loom run … ; loom trace <run> | grep -c 'loom.task fix'      # → 1
$                loom trace <run> | grep -c 'loom.task audit'  # → 1
```

`len(findings) >= 3` was TRUE on the first evaluation — five is ≥ three — and stopped the loop after
one pass. **A channel the loop's source does not write reads its real accumulated value at exactly
the point where `applied` read 1.** The cause is the source node WRITING the channel, not the
evaluation point.

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

**Cost.** One probe run, and a permanent hazard in the shipped example — pinned as the fifteenth
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

### F7 · Three warnings on a correct graph, on every command, each wrong about its cause

**Tried.** Six verbs on the shipped graph: `loom compile`, `loom run`, `loom trace`, `loom replay`,
`loom gates`, `loom audit`.

**Happened.** The first five print, on stderr:

```
! harden-config.json: GRAPH002_DEAD_END: terminal node "fix" ends a path on which no declared output is ever written
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "audit" reads "applied", which no upstream node writes and which is not a graph input
! harden-config.json: GRAPH005_UNPRODUCED_READ: node "collate" reads "applied", which no upstream node writes and which is not a graph input
```

**And the noise scales with the WORKSPACE, not with the graph you named.** `gates`, `trace` and
`replay` compile every graph in `graphs/` to find the one whose hash the journal recorded, so "three
lines" is three only because this workspace holds one graph with a loop in it. Measured, in a scratch
workspace holding four copies of it:

```
$ ls graphs | wc -l                                          # 4
$ loom gates "$RUN" >/dev/null 2>stderr.txt ; wc -l < stderr.txt
      12
$ grep -c 'GRAPH002_DEAD_END\|GRAPH005_UNPRODUCED_READ' stderr.txt
      12
```

Three per loop-bearing graph, linear, on every one of those five verbs. A workspace somebody is
actually developing in — a handful of candidates and probes beside the real graph — prints dozens of
lines of false-cause warnings before every listing, and a stranger's first instinct is that something
is badly wrong with their workspace.

`loom audit` is the sixth verb and the only one of them that does not print them. Whether a verb not in that list
prints them is untested.

**Expected.** Silence — and that expectation is where this entry was overstated, which an adversarial
re-run caught. **All three are wrong about the REASON and right about a HAZARD, and all three
remedies are wrong.** Both halves matter:

*Wrong about the reason*, for the one mechanism above: `fix` is not a terminal node (it has a `loop`
edge out of it, which is how the run gets back to `audit`), and `applied` IS written by an upstream
node — `fix`, reaching both readers over that same `loop` edge. "which no upstream node writes"
misdescribes the cause in a way that sends you looking in the wrong place.

*Right about a hazard*, each one reachable on inputs this port itself ships or produces:

| warning | the hazard it is actually naming |
|---|---|
| `GRAPH005` on `audit` | `applied` genuinely has NO value on the first pass. `harden-audit.js` reads `view.get("applied") \|\| []` for exactly that reason; swap in `view.require` and the run fails `E_CHANNEL_UNDECLARED` |
| `GRAPH005` on `collate` | on an already-compliant manifest — which the doc's own idempotence check produces — `settled` is true on the first audit, `fix` NEVER RUNS, and `collate` reads an `applied` nothing wrote. Same failure under `view.require` |
| `GRAPH002_DEAD_END` on `fix` | `fix` really IS a dead end whenever the loop's `maxIterations` is reached before `repair`'s budget. Lower `maxIterations` to 12 and `legacy-gateway.json` strands on a `fix` that takes no edge — see F11 |

So the three bodies' defensive `view.get(c) || []` is the warning being USEFUL, not noise. What is
not useful is either `fix:` line: `add "applied" to inputs:` invites a caller to supply a fix log the
graph exists to build, and the alternative — "have an upstream node write it" — is already true.

**Cost.** Low per occurrence and unbounded in total, and the real cost is not the noise — it is that a
warning nobody can act on gets read as a warning nobody need read. During the port these were noise
re-read on every command to check no NEW diagnostic had appeared under them, and twice something was
missed and re-run. Then, at the end, an adversarial reviewer showed that all three name live hazards
this graph is one edit away from — and the port had already written them off as false in three places
(this doc, the graph's `labels`, `examples/README.md` §9). **Crying wolf about the reason is how you
get a real hazard ignored**, and that is a worse outcome than silence would have been. A diagnostic
that said "`applied` has no value on the first pass; make sure every reader tolerates that" would have
been correct, actionable, and would have needed no annotation anywhere.

(One nit on "compiles clean" wherever this doc uses it about a probe: it means exit 0 with no NEW
diagnostic. These three still print.)

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

### F11 · The bound has a THIRD home, `maxIterations`, and matching it to the budget strands the run

**Tried.** F5 says the stop rule is written twice. An adversarial re-run of this log found a third
writer of the same bound, and the obvious tidy-up on it: the `recheck` edge's `maxIterations` is 16
while the budget is 12, so "make them the same" looks like removing a redundancy.

**Happened.**

```
$ # the shipped graph with recheck.maxIterations: 16 → 12
$ loom compile graphs/harden-config.json ; echo "exit=$?"
ok
exit=0
$ loom run … --input '{"manifestPath":"manifests/orders-api.json"}'    # → awaiting_gate, 8 fixes
$ loom run … --input '{"manifestPath":"manifests/legacy-gateway.json"}'
  "error": { "class": "internal", "code": "E_OUTPUT_MISSING", … }      # 12 fixes, then stranded
```

**Expected.** Either a refusal, or a message naming the bound that stopped the run. The engine's
`maxIterations` and the graph's `len(applied) >= 12` are two different bounds on the same thing and
they must be ordered — `maxIterations` strictly greater — with nothing checking it and nothing saying
so. The failure mode is the worst available: `orders-api.json` needs 8 passes and is unaffected, so
the edit ships green and only the manifest that actually needs the budget breaks, as F5's
`E_OUTPUT_MISSING`, which again names neither bound.

**Cost.** Nothing during the build, because the shipped numbers happen to be ordered correctly. It is
here because it makes F5's "two homes" wrong: there are THREE, and the third is enforced by a
different layer. Pinned as the second `RESIDUE` test in `examples-harden.test.ts`.

---

### F12 · `fs.read` truncates at 200,000 characters and puts the marker INSIDE the content, so a big manifest reads as a syntax error

**Tried.** Point the graph at a 1.2 MB manifest — an ordinary size for a real service definition with
annotations on it.

**Happened.**

```
$ loom run graphs/harden-config.json --input '{"manifestPath":"manifests/huge.json"}'
  "error": {
    "class": "validation",
    "code": "E_FUNCTION_REFUSED",
    "message": "function \"function/harden-parse@stable\" on node \"parse\" refused:
      \"manifests/huge.json\" is not JSON (Bad control character in string literal in JSON at
      position 200000 …)"
  }
```

**Expected.** Either the whole file, or a refusal that says the read was cut. `builtin/tools.ts:370`
defaults `maxBytes` to `200_000`, and `:385` appends the marker into the returned string:
`` `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` ``. So the body is handed 200,000
valid characters plus a line of prose and blames the FILE for a syntax error that the READ created.
The `details` beside it do carry `{bytes, truncated}` — but a `tool` node writes the tool's
`content` to its declared channel, and nothing hands a `function` body downstream the details.

**Why this is the workflow's worst case rather than an inconvenience.** Auditing is a search for
absences. Two hundred thousand characters of a manifest is a manifest with things missing from it, and
every rule that would have fired on the missing part abstains — which prints as compliance. The only
reason this surfaced as a refusal at all is that the marker happens to break JSON; a format where a
truncated prefix still parses would have produced a clean bill of health on a third of a file.

**Cost.** Twenty minutes chasing a "Bad control character" in a file that `python3 -m json.tool`
reads without complaint. Closed in the port's own files two ways, because one is a dial and the other
is a diagnosis: `load` now passes `"maxBytes": 4000000`, and `harden-parse.js` recognises the marker
and says how much was dropped. The second is the half that survives somebody's manifest being bigger
than whatever number is in the graph:

```
$ # with maxBytes dropped back to the default, same file
"function/harden-parse@stable" on node "parse" refused: "manifests/huge.json" was read back
TRUNCATED: 200027 characters arrived and 1164352 more were dropped, because `fs.read` caps its
output and marks the cut inside the content. …
```

---

### F13 · The gate redacts by KEY NAME, so the harmless `{secretRef}` is hidden and the live password is not

**Tried.** Read what the approver is actually shown, field by field, rather than checking that the
report is present.

**Happened.** On `orders-api.json`, whose `env.DB_PASSWORD` is `"hunter2"` before the run and
`{"secretRef":"db-password"}` after:

```
$ loom gates "$RUN" | jq '.[0].reads.report | {
$     harmless: .hardened.env.DB_PASSWORD, names: .hardened.secrets, live: .applied[4].was }'
{
  "harmless": "[secret]",            ← the {secretRef} that REPLACED the secret
  "names":    "[secret]",            ← a list of secret NAMES, no values in it
  "live":     "hunter2"              ← the actual credential, in the clear
}
```

`security/redact.ts:731` (`isSecretishKey`) redacts on the KEY, and `:559-562` applies it whatever the
channel's declared classification says — "belt and braces for hand-built payloads", as its own comment
puts it. So `env.DB_PASSWORD` and `secrets` are hidden because of what they are CALLED, and
`applied[4].was` is shown because it is called `was`.

**Expected.** Redaction that tracks where a secret actually is. The two halves are independently
wrong: hiding `{"secretRef":"db-password"}` and a list of names removes exactly the evidence an
approver needs to see that the repair happened, while showing `was` hands them the credential — and,
through `out/harden-report.md`, commits it to the repository the manifest came from.

**It also falsifies a claim in `examples/README.md`**, §8's *"A channel the graph classified
(`secret_ref`) prints as `[secret]` rather than in the clear; nothing here is classified, so the
report prints whole."* Classification is not the only door; a key NAME is another, and no graph opts
into it. That sentence is corrected in this round.

**Whose bug is `was`?** Not the runtime's — **the port's**, and it is F14's fifth member. The runtime
redacted everything it had a rule for; the workflow put a credential in a field whose name no rule
matches, and the suite asserted that it did *("the plaintext credential is shown, because the
approver has to see what left the file")*. **An approver needs to recognise a change, not to read the
secret**, so `was` now carries the value's SHAPE — `{redacted:"string",chars:7}`, rendered in the
report as *"a string of 7 chars — not shown"* — and `now` stays in the clear, because hiding the
`{secretRef}` would hide the repair itself. The auditor marks which findings this applies to, so the
rule table decides rather than the fixer, and the fold is unaffected: it replays `now` at `at` and
never reads `was`.

**What remains the product's**, and is recorded rather than worked around: a key called `secrets`
holding only names still prints `[secret]`, so the gate cannot show an approver which secrets a
manifest declares. There is no way for a graph to say "this key's name looks sensitive and its value
is not".

**Cost.** The measurement itself was cheap — one `jq` over a listing this port had already pasted
twice without looking past `applied[].rule`. What it cost is the thing worth recording: **a redaction
that reads NAMES cannot be audited by reading names.** The only check that finds this is to grep the
gate listing and the written artefacts for the secret's actual bytes, which the suite now does.

---

### F14 · Defects in this port's OWN workflow, and what the method that found them cost

**Not the product's friction — the port's.** **Six defects, over three reviews, none found by the
author.** Round one was a fresh agent told to refute this log and to hunt for a wrong result, after the
suite was green at 13/13. Round two was an independent reviewer who built the binary and drove §2 top to
bottom, after round one's fixes and tests had landed. Round three re-read what round two had written.
They are recorded here because `CLAUDE.md` says **a builder's own green suite is not evidence**, and
this is what that costs when taken seriously. All six are fixed; each has a test verified to FAIL with
its fix reverted.

**The finding that matters most is not any member — it is the pattern across the rounds.** Each round's
own correction missed a defect of the class it had just been fixing: round one fixed two and left three
in code its new tests ran through; round two wrote the FOURTH instance of the class into the sentence it
was writing to fix the third; and round three found that one plus a hole **round one's fix had opened** —
the escaping covered the `applied` table, then round one made a hostile key non-autofixable, so the only
path such a key takes became the one path with no escaping on it. A correction round is not a proof of
correctness; it is one more pass
by somebody with the same blind spots.

**1 · The gate undercounted what was still open, by half.** `harden-audit.js` reported only the FIRST
undeclared `secretRef` per pass, reasoning that two findings claiming the same `at` would have the
second's `now` computed against a manifest the first had already changed. True of REPAIRING; false of
REPORTING, and `harden-fix.js` only ever applies one finding per pass, so the hazard never existed.

```
$ # before: manifests/legacy-gateway.json, which exhausts the budget with two refs undeclared
{"passes":12,"stoppedBy":"budget","open":1}          ## Still open — 1
$ # the file it wrote: 7 secretRefs in env, 5 declared in secrets
$ # after
{"passes":12,"stoppedBy":"budget","open":2}          ## Still open — 2  (stripe-token, upstream-token)
```

A person reads "Still open — 1", adds that secret, ships, and the deploy still fails at admission on
the other. **This is the exact defect class the workflow exists to prevent** — evidence missing from a
document a person is about to approve, with nothing saying so — committed by the thing built to
prevent it. The suite asserted `report.open.length > 0`, which passes on 1 and on 2.

**2 · The report's headline sentence was not measured.** `harden-collate.js` computed
`cascades = applied.filter(a => a.cascadeOf != null)` — counting a STATIC field of the rule table
("this rule cannot fire until that one is repaired") and printing the total under a sentence that is a
claim about THIS RUN: *"closed a finding that DID NOT EXIST when the run started"*. On a manifest whose
first audit already holds a cascade-rule finding, that is simply false — and **the graph's own output
is such a manifest**, since a budget stop leaves `secret-not-declared` open:

```
$ # re-harden the legacy-gateway run's own out/service.hardened.json
### before — its FIRST audit already reports secret-not-declared, twice
2 of those 2 fix(es) closed a finding that DID NOT EXIST when the run started — each was created
by an earlier fix, and only a re-audit after every pass could have found it.
### after
{"passes":2,"startedWith":2,"cascades":0}     and the sentence is not printed at all
```

The fix is an `audit`-written `baseline` channel holding the FIRST audit's findings, against which a
cascade is measured. `cascadeOf` stays as the per-entry annotation, because as a statement about the
RULE it was always true; only the count and the sentence were the lie.

**3 · A credential whose value was not a string was dropped entirely.** `harden-audit.js` read
`if (typeof env[key] !== "string") continue;`, so a manifest with `"DB_PASSWORD": 90210` and
`"API_TOKEN": ["sk-live-1"]` produced ZERO findings:

```
$ # before — manifests/unquoted-credentials.json
{"passes":0,"open":0,"stoppedBy":"settled"}
## Applied, in order
Nothing. The manifest already satisfied every rule this tool can repair.
$ # after
{"passes":0,"open":2,"stoppedBy":"settled"}      both plaintext-secret, autofixable: false
```

**A credential scanner that stays quiet because somebody wrote the value unquoted is worse than no
scanner**: it converts "nobody looked" into "somebody looked and it is fine". The key NAME is the whole
evidence this rule has and it does not get weaker with the value's type; what changes is whether a
repair exists, since `secretRef` substitutes for a string. Now reported non-autofixable with a remedy,
and neither the finding nor the remedy carries the value — only its shape.

**4 · The cascade count was keyed on RULE NAME, which is defect 2 again, one level in.** Fixing 2 made
the count measured; it did not make it *identified*. Keying `startedWith` on `f.rule` hides every
cascade whose rule was already in the baseline **for a different subject**:

```
$ # manifests/mixed-secrets.json — one plaintext A_PASSWORD, plus B_TOKEN already holding an
$ # undeclared secretRef, so `secret-not-declared` is in the baseline about b-token
### before                            ### after
{"passes":3,"cascades":0}             {"passes":3,"cascades":1,"startedWith":2}
```

The `secret-not-declared` that pass 1 CREATES, about `a-password`, had a rule name that was already
there — so the sentence was suppressed on a run whose whole point was the cascade. Identity is now
rule + `at` + `detail`: `secret-not-declared` reports `at: "secrets"` for every secret there is, so
`detail` is the only field that separates two of them, and the applied entry carries it for exactly
this comparison. **This is the third instance of the class, and it survived the fix for the second.**

**5 · The fix log carried the live credential to the approver** — the F13 half that belongs to the port
rather than to the runtime. `applied[].was` is the value before the repair, which for
`plaintext-secret` IS the password, so `hunter2` reached `loom gates`, the approver, and
`out/harden-report.md`. The runtime had redacted every field it had a rule for; the workflow put the
secret in a field no rule matches, **and this suite asserted that it did** — *"the plaintext credential
is shown, because the approver has to see what left the file"*, in as many words. Now
`{redacted:"string",chars:7}`, rendered *"a string of 7 chars — not shown"*.

**6 · "The manifest already satisfied every rule this tool can repair" — written to REPLACE #2, and the
fourth instance of the class.** On `unquoted-credentials.json` that sentence printed two paragraphs
above `## Still open — 2 … plaintext-secret`, a rule this tool repairs seven times on
`legacy-gateway.json`:

```
### before
## Applied, in order
Nothing. The manifest already satisfied every rule this tool can repair.
## Still open — 2
- **`plaintext-secret`** (high) at `env.API_TOKEN` — …
### after
Nothing. No finding here is auto-fixable — see **Still open** below, which is 2 finding(s) a
person has to act on.
```

What the run established is that nothing here was AUTO-FIXABLE. Whether the rules are "satisfied" is
the opposite of what `open` says. Two weaker members of the same class went with it: *"over N pass(es)"*
rendered the fix count a second time wearing the word "passes", though nothing in the state counts loop
passes (nine `audit` tasks for eight fixes) — now *"one per pass"*, which is true by construction; and
`severity`, a constant of the rule table, now says the word "severity" so it does not read as something
this run computed.

**What all six have in common, and it is one sentence:** **the report asserted something the run had
not established.** Three asserted a completeness they had not checked (1, 3, 6), two a novelty inferred
from a constant (2, 4), and one asserted that showing a secret was a feature (5). The workflow's own doc
calls the cascade count *"the argument for the whole workflow"* — and an argument that is not measured
is precisely what this project's property 3 is about. **The lens that finds these, stated so the next
port can use it: for every number and every sentence the gate shows a person, name the thing in the run
that establishes it. Where the answer is "a constant in the rule table" or "nothing", that is the
defect.** Run it over the sentence you just wrote to fix the last one, because that is where #4 and #6
both came from.

**Cost.** Three review rounds, and each was cheap only because somebody was told to look. The method is
the finding, and so is its limit, now measured rather than asserted: **round one missed three of the
six; round two introduced one of them and missed the escaping hole its own fix had opened.** Five stale
prose claims in shipped files were caught the same way in the same passes, and `cell()` — the helper
whose docstring names the exact harm it prevents — had no test at all until round three, so mutating it
to `return String(v);` was green.

---

## 4 · What is left open

- **All thirteen product entries, F1–F13.** None is fixed here; the brief was to record them. (F14's
  six are this port's own and ARE fixed, each with a test verified to fail without its fix.)
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
  meaningful in this one. Recorded here rather than as a fifteenth entry because it is F4 and F5
  seen from the graph's side.
