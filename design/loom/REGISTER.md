# Register — every defect this build has found

**This is the archive, not the re-entry point.** Read `HANDOFF.md` first; it says where things
stand and what to do next, and points here for the reproductions. **Grep this file, do not read
it.** Entries are `A1`…`E8`, and many are RESOLVED and kept deliberately — a closed entry keeps
its reproduction so the next person can tell "this was fixed" from "this was never true", which
is the one question an archive exists to answer.

Entries carry their own status. Where a summary elsewhere disagrees with an entry, **the entry
wins**: this file's own most-repeated lesson is that a summary restating a status word will
eventually disagree with the entry it summarises.

Sections: **A** security and correctness · **B** mechanism that exists and is wired to nothing ·
**C** vocabulary declared and never written · **D** documentation wrong or unverified ·
**E** process and build state.

---

## Known issues

**This section is the point of this file.** Everything here is *known to be wrong, unwired,
or unverified right now*, established by a command that is written next to it. It lives in
`HANDOFF.md` rather than in its own file on purpose: the previous "documentation drift to
fix" section rotted precisely because it was a second place to maintain, and a register in
the file people already open is one place. Delete an entry when you fix it, in the same
change.

**Status markers, all three of them:**

| Marker | Means | What to do about it |
|---|---|---|
| *(none)* | Reproduced against this tree, by the command or the reading named in the entry | Fix it, or decide not to |
| **UNCONFIRMED** | Suspected. Neither reproduced nor refuted, and it is here because deleting an unproved suspicion is how a suspicion becomes a surprise | Reproduce it or refute it, then edit this line |
| **UNVERIFIED** | A measurement or an audit that was true once and has not been re-run against this tree | Re-run it |

`UNVERIFIED` used to be undefined here while one entry carried it, which is the same class
of defect as the register's own miscounts: a marker whose meaning a reader has to guess is a
marker that means whatever they guessed.

**Every entry below was reproduced or refuted in a verification pass on 2026-08-05.** Two
entries were **removed because they did not reproduce**, and the removals are recorded here
rather than silently made, because "an entry vanished" and "an entry was never real" are the
two readings a reader cannot otherwise tell apart:

- *A gate can be looked up through `Object.prototype`.* **REFUTED.** `HumanGateBroker.resolve`
  calls `gateOf`, not a bare index, and `gateOf` → `gateIn` checks `name !== "__proto__"` and
  `Object.prototype.hasOwnProperty`. Driven over real HTTP against an authenticated plane:
  `POST /runs/:id/gates/__proto__` answers **404 `E_GATE_NOT_FOUND`**, and so do `toString`,
  `constructor`, `valueOf` and `hasOwnProperty` — identically to a name nobody has ever used.
  The entry's own provenance ("established by reading `gates.ts`'s lookup") could not have
  been true of the file as it stands; the fix it proposed was already in the tree when it was
  written.
- *The fold still lets `gate.decided` and `gate.timeout` overwrite any gate state.* **REFUTED.**
  Both arms in `projection.ts` are restricted to `open` (`if (g?.state !== "open") return;`
  and `if (g?.state === "open" && …)`). Driven through `foldRun` on the hand-written journals
  the entry said were the only way to reach it: `decided→decided` keeps the first decision,
  `cancelled→decided` stays `cancelled`, `decided→timeout` stays `decided`, `expired→decided`
  stays `expired`. Nothing overwrites anything. What IS true about that guard was a different
  claim — that nothing tested it — and it was entered as **E7** and has since been closed:
  `test/run/gate-guards.test.ts`'s "guard 9" block drives all four transitions through
  `foldRun` over hand-written journals, and reverting either `open` conjunct turns them red.

**A false known-issue is worse than a missing one.** Both of the above would have cost the
next reader a day reproducing a fixed bug, and the day after that they would have stopped
believing the rest of this page. Nothing goes in here that has not been personally
reproduced; nothing comes out that has not been personally refuted.

**The tally, so the pass itself is auditable — and it is a COMMAND rather than a number.**
The register's size is

```bash
grep -cE '^\*\*[A-E][0-9]+ ·' design/loom/HANDOFF.md
```

and nothing else. **The total is deliberately not written here**, which is a step past the
rest of this file's "a number plus its command": what stood here was "39 stood" plus a
four-row table whose counts summed to 39, and it was the third count in this file to be
false — after the test count of 39 the header warns about and E1's 25-that-was-26. All three
were true when written. Entries are closed *in the change that fixes them* and added the
same way, so a total is stale on the next commit by construction; the grep above moved
**twice while this paragraph was being written**, once for the entry this change added
(A12) and once for one a concurrent change added (A11). Run it. Do not copy its answer back
into this file.

What the counting was actually FOR survives without a total, and those rows stay:

| | Which |
|---|---|
| Refuted and removed | the two above — recorded rather than silently deleted, because "an entry vanished" and "an entry was never real" are the two readings a reader cannot otherwise tell apart |
| Left **UNCONFIRMED** | D3 (an audit nobody has run) and E3 (a flake that did not recur) — neither is provable or disprovable from the tree alone, so both stay |
| Added by that pass, each reproduced first | A10, D10, E8 — the pass added five, and **A9 and E7 have since been closed**. A list of ids inside a dated table decays exactly like a count, one name at a time |

Three of the reproduced entries needed their own text corrected — E1 (its count was 25, the
guard prints 26), D4 (it listed two numbers `99-DOD.md` does not quote), D8 (its example was
right, and is now dated). The method for each entry is written into the entry: a command, a
reading with the symbol named, or a reproduction whose output is quoted. **The four entries
that carry a reproduction running real code rather than a reading — A9, A10, E7, E8 — are
the four that were wrong or missing before this pass.** That is the argument for the method,
and it is the same argument the drift guard makes one layer down: a claim nobody executed is
a claim nobody checked, whichever file it lives in.

### A · Security and correctness

**A1 · `errors.ts` has two partial reads, and every boundary except delivery still calls
through them. RESOLVED 2026-08-06, WITH ONE CORRECTION TO THIS ENTRY'S OWN PRESCRIPTION.**
`toLoomError` is total (`safeString` for the primitive conversion, `readOwn` for `name` and
`message`), `LoomError.toJSON` reads its own fields through `readOwn`, and `httpStatusFor`
has the `default` arm its declared `number` return needed — a forged `class` used to fall out
of the bottom as `undefined`, which `#dispatch` writes into a response status.

The larger half is that **`isLoomError` does not mean "one of ours"**: it is an `instanceof`,
so a value built on `LoomError.prototype` with throwing accessors passed the check and was
returned UNCHANGED, traps intact. A `LoomError` is now passed on by identity only when every
field it will later be read for answers cleanly, once, at that boundary; anything else is
rebuilt, preserving `code`, because `Engine.#runAgent` and `#invokeTool` branch on it.
`test/errors.test.ts`.

> **THE CORRECTION IS TO THE LAST CLAUSE, AND IT IS THE USEFUL PART.** This entry said
> `delivery.ts`'s local wrappers "say in their docstrings that they should be deleted the day
> it lands." **They say the opposite, at length.** `ownError`'s docstring is an argument for
> why `toLoomError` *cannot* be them, and `describeFailure`'s likewise; `grep -an delete
> packages/core/src/run/delivery.ts` finds nothing of the kind. They do a second job — they
> BOUND and replace `details`, and validate `class`/`code` against the vocabulary — and they
> stay. A total `toLoomError` is built to the standard they document, not in place of it.
>
> The entry's scope was also slightly generous: `http.ts` has since grown `describeFailure`,
> a second reader that is total by construction. The engine sites it names —
> `#executeTask`, `#invokeTool`, `#runAgent` ×2 — were the exposed ones and are the reason
> this mattered.

The original text follows. `toLoomError` does `String(e)`, which throws on a value with no primitive
conversion; `LoomError.toJSON` and `httpStatusFor` read `this.details` and `this.class`
bare. Established by reading the file. `run/delivery.ts` is safe because it no longer hands
out a foreign error, but every other place that calls `toLoomError` on a value from injected
code — tool executors, model adapters, `http.ts`'s own catch — has the same latent
partiality. **Fix:** make `toLoomError` total and have `LoomError` copy its own fields at
construction; the local wrappers in `delivery.ts` say in their docstrings that they should be
deleted the day it lands.

**A2 · The executor never arms the fencing token, so the store-level fence is dead code.
STALE AS WRITTEN, and RESOLVED 2026-08-18 in the narrower form it had become.** The fence IS
armed: `#fence` presents the token at all three `#commit` exits and the token is the lease's own
seq, chosen because a per-process counter cannot fence across processes — worker B starts at 1
and loses to worker A's 3. The entry below describes the state before that landed and is kept
because a register that silently rewrites its own history is one nobody can audit.

> **What was actually left was a LYING FIELD.** `task.leased` journaled `++this.#fencing` — the
> per-process counter — while `task_fence.max_token` compared the seq, and
> `TaskRecord.lease.fencingToken` folded the counter. Two numbers for one thing, and the
> projection reported the one nothing enforced. Nothing read it
> (`grep -arn 'lease\.fencingToken'` was empty), so it misled rather than leaked. The seq IS the
> token, so the payload no longer carries a second one and the fold reads `e.seq`; `#fencing` is
> deleted.

**A2 (original entry, kept because the register must not rewrite itself) · The executor never
arms the fencing token, so the store-level fence is dead code.**
`StateStore.append` takes `{taskId, fencingToken}` and both stores enforce it against the
highest token seen; `RunLog.append`/`commit` forward it. `grep -ran fencingToken
packages/core/src` finds the two stores, `log.ts`, `projection.ts`, and exactly one line of
`engine.ts`: the `task.leased` payload literal that mints `fencingToken: ++this.#fencing`
and then never uses it again. `E_LEASE_LOST` is consequently unraisable. `Engine.#fencing`
is also process-local, so worker B's first token is `1` — not greater than worker A's `3`.
With one worker nothing is lost; the day there are two, a stale holder's commit is accepted.
The contention suite covers all of it the moment the executor supplies the token.

**A3 · Every valid credential is a full operator credential. RESOLVED 2026-08-18**, and the
fix is the one this entry prescribed, plus two terms it did not anticipate. A run is owned by
the principal that submitted it; `run_head.submitted_by` is written INSERT-ONLY inside the
same transaction as the `run.submitted` it is derived from, and `listRuns(limit, filter)`
filters in SQL BEFORE the limit — filtering after would empty a low-volume principal's list on
a busy journal and let a caller measure other principals' submission rate by varying `limit`.
The escape is `operator: true` on an identity entry, refused when malformed at all three doors.

> **The two terms the prescription missed, and both are load-bearing.**
>
> **The gate routes cannot be owner-scoped.** Under `separationOfDuties` the only principal
> permitted to decide is by construction not the submitter, so `ownsRun` governs the four
> `#runs` routes and `mayReachGates` — that, or NAMED on one of this run's gates — governs the
> two that carry gates. Named, never "not excluded": a posture-floor gate on a tool node names
> nobody by construction, and reading that as "visible to everybody" would publish the node's
> channel values to every principal.
>
> **And an approver still has to FIND the question.** `GET /runs` is scoped to the submitter,
> so `GET /gates` was added — the cross-run queue, carrying the rendered payload, because
> `GET /runs/:id` is closed to a non-owner and it is therefore the only place the question can
> reach the person being asked. The console reads it as an "Awaiting you" panel and answers in
> place; routing through `select()` would need `GET /runs/:id` and would 404.
>
> **`(shared-token)` is an operator only when it is the SOLE credential.** `#principal` falls
> back to the shared token AFTER trying the identity source, and this file documents the mixed
> arrangement as supported — so the unconditional grant would have handed every service a full
> read of every human's runs, through a fallback nobody configured.
>
> **And a SYNTHETIC subject is a real owner — the reverse of what shipped first.** Reading
> `(shared-token)` as "nobody" made every service-submitted run on a mixed plane readable and
> **cancellable** by every human credential. Measured, then closed. The permissive set is runs
> with no recorded principal; a run whose owner cannot be READ is operator-only, because "names
> nobody" and "could not read who it names" must not answer alike.
>
> **What is still not scoped**: gate payloads are redacted per the GRAPH's classification,
> never per viewer, so two approvers on one gate see the same bytes. The filtering is per
> GATE, not within one. And a caller who can MUTATE a graph can add a node naming themselves
> as an approver, which under `mayReachGates` opens that run's gate routes to them —
> `graph:mutate` was already a strong capability and is now slightly stronger.
>
> **`GET /gates` is bounded and says so.** At most 200 gates, scanning at most the 500 newest
> runs, with `truncated` in the response — because the first version spent an uncapped
> `pageLimit` on RUNS, which both amplified (a fold per run, any credential, no rate limit)
> and hid: a question addressed to an approver vanished from the only route that shows it as
> soon as fifty newer runs existed. The reversal is an open-gate index beside `run_head`.

**A4 · Nobody is recorded as having started or stopped a run. RESOLVED 2026-08-18.**
`run.submitted` carries a `submittedBy` in its PAYLOAD — the control plane really is what
appended the row, so the envelope stays `system:control-plane` and the principal is a fact
about the run, `gate.raised.approvers`' shape. `Engine.cancel` and `rewind` take a
`CommandActor` and journal it on the ENVELOPE of every event their cascade writes, because a
cancel is caused by its caller directly. A named service principal becomes
`system:principal:<subject>`; an unidentified caller stays `system:operator`, unchanged,
because a marker describes what the perimeter concluded rather than naming anybody.
`AuditRecord.principal` carries it into the `Infinity`-retention audit tier, and
`checkpoint.restored` gained an arm there — without it the actor threaded into `rewind`
reached the journal and stopped, so "who rewound this run" was the one A4 fact a configured
`pruneJournal` could destroy. `test/run/run-ownership.test.ts`, `test/run/submit-callers.test.ts`.

> **The prerequisite it existed to unblock is fully spent.** A3 (scoping) reads it to decide
> who may reach a run, and D7.2's separation of duties resolves the gate exclusion from it —
> both landed, so the principal is journaled AND read, which is what keeps this from being the
> shape the Traps section calls "a capability nothing calls".
>
> **And the field is fail-open by construction**: `SubmitInput.submittedBy` is optional and an
> absent principal is the PERMISSIVE case, so a `submit` call site that forgets it will mint a
> world-readable run once A3 lands. `test/run/submit-callers.test.ts` pins the four doors and
> their per-file call counts; it proves each has been CONSIDERED, not that any is right.

**A22 · AN AGENT NODE'S PROMPT IS THE REF STRING. RESOLVED 2026-08-18, and the fix is not
where the entry said it would be.** The prescription was a run-time content hook on
`ResourceResolver`. What landed resolves at COMPILE time instead: `RunGraph.documents` carries
the text behind every pinned ref, frozen beside the manifest, and `#runAgent` reads the compiled
graph rather than asking a resolver anything.

> **The churn told me the design was wrong.** A run-time hook made 32 tests fail across 12
> files, all with the same shape — *this Engine has no resolver*. `grep -c 'new Engine('
> packages/core/test` is 54, and almost none passes one, while EVERY `compile` call site does.
> A prompt that needed the engine's resolver would have made every engine construction a
> resource deployment. Moving the read to compile took the failures from 32 to **1**, and the
> one was the CLI test, which needed the loader that was the point of the wave.
>
> It is also the stronger reading of the pinning rule rather than a weaker one:
> `resources/functions.ts` records what a run-time `resolve(ref)` costs — "a promotion between
> compile and execute swapped the body underneath the Run" — and freezing the bytes into the
> compiled artifact makes that unreachable rather than merely guarded.
>
> **Three things it took that the entry did not anticipate.** `req.system` is built at a
> DIFFERENT site from the one `assembleContext` is handed, and only the second reaches a
> provider — so setting the one the ladder measures changed nothing a model saw, and the test
> caught it by asserting on the wire. `ResourceStore.publish` lands on `@draft` and `@stable`
> needs a human actor, so the workspace loader goes through a named `seed` door instead of
> minting a fake human to walk past the guard. And `resources/` sits inside the writable tool
> jail, so the loader refuses symlinks — otherwise a run could plant
> `resources/prompt/x.md -> /etc/passwd` and the next boot would hand it to a model.
>
> **What is still a pointer:** `agent_profile` (the model routing key, unchanged),
> `oversight` (`humanGate.ref`, a pin by design), and `subgraph` — which is A23, and which the
> same `seed` door now makes reachable by publishing a `GraphSpec`.

**A22 (original entry, kept for the reproduction) · AN AGENT NODE'S PROMPT IS THE REF STRING. There is no resource store, so a model is
sent the pointer instead of the document — and this is the one thing standing between the
build and its own stated goal.** New, 2026-08-18, found by using the binary rather than by
reading. `AgentNode.prompt` is a `ResourceRef`, `ResourceResolver.resolve` returns
`{ref, digest, channel}` — a pin, never content — and `#runAgent` puts `agent.prompt`
**verbatim** into the instruction and into the user message
(`engine.ts:2103`, `:2121`). Measured end to end through `bin/loom`:

```
loom run agent.json          # agent: { prompt: "prompt/say-ready@stable", … }
→ "answer": "[mock] {\"node\":\"ask\",\"prompt\":\"prompt/say-ready@stable\",\"state\":{}}"
```

The model received the eleven characters of the pointer. There is no way round it from a graph
file: `RESOURCE_REF` is `[a-z_]+/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+`, so an instruction with
spaces or punctuation is `GRAPH015_RESOURCE_NOT_FOUND` at compile, and `promptOverride` — the
one parameter that could carry real text — has exactly one caller, the evaluator, which passes
`ev.ref`, another ref. `agent.profile` never reaches the request at all except as the model
ROUTING KEY (`engine.ts:2156`), and the system message is the hard-coded
`` `You are node ${w.node.id}.` ``.

> **Everything AROUND this works, which is why it went unnoticed for the whole project.** The
> provider adapters are real and do call out — an invalid key against
> `agent_profile/basic@stable` produced `loom.model [error] 1152ms`, a genuine network
> round-trip and a genuine 401, not a mock. The graph compiles, the run journals, the gate
> gates, the replay reproduces. The single missing piece is that nothing turns a `prompt/…@…`
> into words.
>
> **Fix, exactly:** a `ResourceStore` behind `ResourceResolver` with a content hook — the
> shape `subgraph(ref)` already has and which `CLAUDE.md` names as the one that exists
> ("there is no equivalent for `oversight`"; there is none for `prompt` or `agent_profile`
> either). The `.loom/` workspace is the obvious backing store, and `packages/skills/`
> — library-as-data, already the named first package — is the same question wearing a
> different hat. Until then an agent node is a shape, not a capability.

**A23 · A `subgraph` node has never worked in the shipped binary. RESOLVED 2026-08-18.** A
workspace publishes `resources/subgraph/<name>.json|yaml` and the CLI's resolver serves it, so
the engine's `resolver.subgraph?.(ref)` finds a `GraphSpec` where it used to find nothing.
Driven end to end through the rebuilt binary: parent `succeeded`, the child ran, wrote its file,
and its output mapped back onto the parent's channel. The compiler also recurses into the child
now, which it could not before — the first attempt was refused `GRAPH003_EMPTY` for a childless
fixture nothing had ever validated.

> **One half of this entry stays open and is now its own question.** `#runSubgraph` reads
> `this.#resolver.subgraph?.(sub.ref)` at RUN time, by REF — the floating-ref read A22 went out
> of its way to avoid for prompts, where the text is frozen into `RunGraph.documents` at
> compile. Fixing it means carrying child SPECS in the compiled graph too, which is a redesign
> of subgraph resolution rather than a fix for "the node does not work", so it was deliberately
> not folded in. **A24.**

**A23 (original entry, kept for the reproduction) · A `subgraph` node has never worked in the
shipped binary, and the cause is TWO things neither of which is visible from the other.**
Reproduced through `bin/loom` on a two-graph workspace:

```
E_RESOURCE_NOT_FOUND: subgraph "subgraph/child@stable" does not resolve to a GraphSpec
```

`HANDOFF.md` has said "all eight node types execute" since the P1 wave, and that is true of the
ENGINE — every subgraph test injects its own resolver with a `subgraph()` method. It is false of
the PRODUCT, and nothing in the suite could have caught it, because no test goes through
`openWorkspace`.

> **The two causes, and why finding one hides the other.** (1) `openWorkspace` built its
> resolver AFTER `new Engine({…})` and handed it only to `loadGraph`, so the engine fell back
> to `{resolve: () => undefined}` — **fixed in this pass**. (2) That stand-in resolver has no
> `subgraph()` method at all, because it is a PIN resolver: it answers "does this ref exist"
> and nothing else. `grep -an '#resolver\.' engine.ts` returns exactly one line —
> `subgraph?.(sub.ref)` — so with either cause standing the call answers `undefined` and the
> run fails identically. A plan reviewer reported (1) as the reason subgraph nodes are dead
> and I nearly shipped a test asserting it; the test would have passed before the fix.
>
> **What closes it is A22's work**, because both are the same missing thing: a resolver that
> can return CONTENT. `subgraph/<name>@stable` needs a published `GraphSpec` exactly as
> `prompt/<name>@stable` needs published text.

**A24 · A subgraph's child spec is read at RUN time, by REF. RESOLVED 2026-08-18.** The parent's
compile walks the subgraph tree — same cycle set and depth bound the validator applies — and
freezes every reachable child spec into `RunGraph.subgraphs`, which `#runSubgraph` now reads.
The third and last kind of content leaves the run-time path; `grep -an '#resolver\.' engine.ts`
returns nothing.

> **The first attempt closed it at depth 1 only, and the measurement that justified stopping
> there was about a different change.** `#compileChild` ran with the live `this.#resolver`, on
> the argument that replacing it starves the child — its own `function/…` and `prompt/…` refs
> are not in the PARENT's manifest, so every one fails `GRAPH015_RESOURCE_NOT_FOUND`, measured
> at 38 tests. That measurement is of the WIDE substitution and says nothing about overriding
> the ONE hook the parent has an answer for. A reviewer tried the narrow version: **zero new
> failures**, and the grandchild stopped being read mid-run. Reproduced before and after —
> parent → child → grandchild with the resolver promoted after the parent compiled ran the
> PROMOTED grandchild, which is verbatim the swap this entry exists to prevent, one level down.
> Every deep entry the collector gathered was dead until this landed.
>
> **`#compileChild`'s cache had to move with it.** It was keyed by ref, on a docstring saying
> "the tree is fixed, so the cache never stales" — true until the spec started coming from a
> per-run `RunGraph`. Two runs on one `loom serve` process with different frozen children for
> one ref both got the first one's compiled graph, so the freeze bound only the first run per
> process. Keyed by ref AND spec digest now.
>
> **What still read a resolver mid-run — CLOSED by A25, kept for the reproduction:**
> `#applyMutation` recompiled a mutated graph, and `#rehydrateGraph` recompiles when a process
> picks up a run behind its own history, both with the live resolver — so a `canMutate` agent's
> graph re-resolved its prompts and children. A22's prompt freeze had the same hole. Both now
> go through `frozenFirst`.

**A24 (original entry, kept for the reproduction) · A subgraph's child spec is read at RUN time,
by REF.** Split out of A23 rather than folded into it. `engine.ts`'s `#runSubgraph` calls `this.#resolver.subgraph?.(sub.ref)` while a
Task is executing, so a promotion between compile and execute swaps the child graph underneath
a running parent — the defect `resources/functions.ts` records for function bodies and A22
closed for prompts, still open for the third kind of content.

> **"EXPOSURE TODAY IS NIL" IS NOW MEASURED AND GUARDED, 2026-08-24, and it was previously a
> belief.** The sentence had stood in this entry, in `functions.ts` and in `hook-loader.ts`
> without anything checking it. Swapping a ref mid-run needs something able to MOVE one while a
> process runs, and the shipped product has nothing: **zero** `.publish(`/`.promote(` call sites
> anywhere under `src/`, **exactly one** `readResources` call (the boot seed in `openWorkspace`),
> and **no HTTP route addressing a resource at all** — 13 routes, all runs, gates, graphs and
> health. `test/resources/store-is-sealed-after-boot.test.ts` pins all three, each
> mutation-verified.
>
> So the disposition of this entry changes: it is not a defect waiting to bite, it is a
> **guarantee held up by an absence** — and the absence is now the thing that fails loudly. The
> first publish route, hot-reload path, or admin endpoint turns one of those three assertions red
> and sends its author to the loaders before it ships.
>
> **And it is one seam wearing three entry numbers**: function bodies
> (`FunctionLoaderOptions.pins`), hook bodies (`HookLoaderOptions.pins`) and subgraph specs
> (this). Fixing one and not the others is exactly how the hooks half of B6 rotted. The fix is the one A22 used —
freeze the child spec into `RunGraph` beside `documents` — and it is a redesign of subgraph
resolution rather than a one-line guard, which is why it is its own entry.

**A25 · A MUTATED graph re-resolves its prompts and children from a live resolver, mid-run.
RESOLVED 2026-08-19.** All three recompiles that happen while a run is in flight —
`#compileChild`, `#applyMutation`, `#rehydrateGraph` — now go through one `frozenFirst(graph,
live)` resolver: content the run already froze answers from the compiled artifact, and only a
ref nothing has seen reaches the live store. That is exactly what additive-only mutation means,
which is why the rule fits rather than being bolted on: a mutation may ADD, and what it may not
do is change an answer the run is already built on.

> **`resolve` had to be frozen too, and leaving it live made the first version a no-op.** A
> digest is over CONTENT — `resourceDigest` is `digest({kind, name, content})` — so a promotion
> MOVES it and `@stable` points at the new one. With `resolve` live, a recompile re-pinned an
> existing ref to the new digest, the frozen map (keyed by the old one) missed, and the fallback
> served the promoted bytes to a node that already existed. The freeze held only when the
> content had not moved, which is the case needing no freeze. Reproduced through the engine
> before it was fixed; the stated rationale ("the pin is a digest over the ref") was true of the
> CLI's stand-in resolver and false of `ResourceStore`.
>
> **What the test covers, measured rather than asserted: `#applyMutation` only.** It drives a
> real mutation across a promotion and checks both that no already-compiled node is sent the
> promoted prompt AND that the ref the mutation ADDED is the only thing asked live — so the
> additive fallback is exercised rather than assumed. **`#rehydrateGraph` has no test**:
> it recompiles only when a process picks up a run behind its own history, its effect shows only
> in what a LATER node is sent, and this fixture's run reaches `succeeded` on the first
> `advance`. An assertion there passed with the site reverted, so it was removed rather than
> kept. Covering it needs a mutating graph that parks and resumes.

**A25 (original entry, kept for the reproduction) · A MUTATED graph re-resolves its prompts and
children from a live resolver, mid-run.** Found by a reviewer checking A24's absolute claim
rather than by the fix that made it. `#applyMutation` recompiles the merged spec and assigns the result to `ctx.graph`, and
`#rehydrateGraph` recompiles on every `advance` of a run that has mutated — both with
`this.#resolver`. So `resolveDocuments` and `resolveSubgraphs` run again, from the live store,
while a Task is executing: a `canMutate` agent's graph can have its prompt or its child swapped
between the mutation and the next turn. Measured: a frozen `function/mult2@stable` became
`function/mult1000@stable` after the mutation, with the resolver called twice.

> It is the same hole A22 and A24 closed on the un-mutated path, on the one path that
> recompiles by design. The fix is to thread the frozen maps through `compileMutation` so a
> mutation inherits what the run already froze and can only ADD to it — which is also the
> honest reading of additive-only mutation. Until then the sentence "nothing consults a resolver
> once a Task is executing" is true for an ordinary run and false for a mutated one, and both
> `HANDOFF` and `JOURNAL` now say so.

**A5 · A hung `parseCallback` is the one refusal invisible in both sinks. ALL THREE CLOSED
2026-08-24 — kept for the reproduction and for what closing the last one cost.**

> **Consequence 1 — the leaked continuation — is closed by RACING the parse rather than by
> cancelling it.** `await parse(…)` suspended `handle` with `input`, and therefore
> `input.body`, live in its continuation, and suspended `ControlPlane.#serve` and
> `#withDeadline` on top of that: one buffered body per hung POST, on the one route reachable
> without a credential, held for the life of the process. `raceDeadline(work, signal)` settles
> with whichever comes first, so every frame from `handle` upward unwinds at the deadline and
> drops what it held. **It does not cancel the channel's promise — nothing in JavaScript can.**
> If the channel captured the body, the channel still holds it. The half core owns is released
> and the entry says which half that is, because the previous two rewrites of this entry each
> overstated what had been closed.
>
> **The obvious fix was the wrong one and the code had already said so.** An `AbortSignal` on
> `CallbackRequest` is a request injected code may honour, and the channel that ships in this
> binary would have ignored it — the hole would have stayed open behind a closed entry. The
> race holds for code that never cooperates, which is the only version that closes it.
>
> **A mutation sweep changed the shape of the fix.** Three guards were written; the third — a
> deadline check inside the `catch` — survived its own mutation with all 85 tests green, and
> was DELETED rather than tested. `raceDeadline` rejects with a `timeout` token that `reasonOf`
> reads back, and `timeout` is deliberately not in `PERIMETER_REJECTIONS`, so it already fell
> through to the one check after the race. Worse, in the corner where the extra check DID fire
> it relabelled a channel's legitimate `signature` refusal as our own clock. Removing it made
> the surviving check load-bearing for all three deadline tests at once — which is how you can
> tell it is the single point of enforcement.
>
> **The original three consequences, for the record**, of which 2 and 3 closed 2026-08-19:
`CallbackRequest` carried no `AbortSignal`, so the HTTP request deadline could abandon the
*response* but not the channel call. Three consequences: each hung POST leaks a pending
continuation holding the body buffer, on an unauthenticated route; counting and journaling both
happen after `parse` resolves, so the refusal is recorded nowhere; and a channel that resolves
after the 504 still reaches `resolveGate`, applying a decision minutes after its caller was told
the request failed.

**`#withDeadline` closed the SOCKET and nothing else, and two successive rewrites of this entry
overstated it.** The timer callback does exactly one thing — `send(res, 504, …)` — incrementing no
counter and appending no event, while every `#count` call lives in `delivery.ts` and is reached
only once `parse` has settled. So the refusal stayed in neither sink, which is this entry's own
title. The first rewrite claimed that half was closed, read off a docstring rather than the code.
The second claimed `#withDeadline` had closed consequence 1; it has not. `#withDeadline` still
`await`s the handler, and its own docstring says so: *"The losing handler is not cancelled — there
is nothing here to cancel it with."* Reproduced: with `requestTimeoutMs: 100` and a channel that
never resolves, a 50 000-byte POST returns 504 while `parseCallback` is still pending and the body
still held. **N concurrent hung POSTs still retain N bodies on an unauthenticated route.** Closing
it needs a `Promise.race` around `parse` — which the ORIGINAL entry proposed and both rewrites
dropped.

**Closed at the ROUTER, and the interface change was NOT made.** The deadline's `AbortSignal`
reaches `GateCallbackRouter.handle`, which counts and refuses before admission if it has already
fired — consequences 2 and 3 together, for channels that cooperate and channels that never will.
An `AbortSignal` on `CallbackRequest` would have been a request injected code may honour, and the
channel that ships in this binary would have ignored it: A5 would have been marked closed with its
named residue fully reproducible. **The channel is NOT given the signal** — `parse` receives
`{body, headers, now}` and `CallbackRequest` has exactly those three members; `CallbackInput` is
what the ControlPlane hands the router. An earlier version of this entry and of the code comment
both said otherwise. Handing it over would need more than a field: a channel cooperating by
throwing an `AbortError` lands where `reasonOf` falls to `internal`, which
`PERIMETER_REJECTIONS` counts as a broken channel rather than as our own deadline — the exact
pollution the new reason exists to avoid. `E_CANCELLED` rather than a new code, for the reason `#withDeadline` already
gives about the bare wire code it writes: every declared code must be named by a design-corpus
row, and that reconciliation is not this change's to own. `test/run/callback.test.ts`.

> **The interface change was also five signatures, not one** — `#withDeadline`'s callback,
> `#serve`, `RequestContext`, `CallbackInput`, `CallbackRequest`, two of them published. And
> `check-surface.mjs` would not have noticed any of it: it pins the exported NAME SET and nothing
> else, so an added interface member is invisible to it. Anywhere this register calls an added
> optional member "a surface pin change", it is wrong.

**A6 · Replay picks a gate's recorded decision by enumeration order. RESOLVED 2026-08-06.**
`run/replay.ts` found the first `open` gate in the replayed projection and then a `decided`
gate in the original by matching `nodeId` alone. A `human_gate` inside a bounded loop has one
gate per ITERATION on the same `nodeId`, so every iteration was served the **first** recorded
decision. Driven end to end on a two-iteration loop where the human approves `gate@root#0`
and rejects `gate@root#1`: the recorded run FAILED and the replay SUCCEEDED. Both picks are
now by `TaskId` (which is derived, so it is stable across the two runIds) and `raisedAtSeq`,
with a `served` set so one decision cannot be spent twice.
`test/run/replay.test.ts`.

> **What made this worth doing was not that it passes silently — it does not — but WHAT IT
> BLAMES.** `compare` still reports `match: false`. The harness answered the wrong question
> and the divergence is then attributed to task states and channels, so a `loom replay` user
> reads a report about the run when the fault is in the replayer, and D10's promotion gate
> can fail a candidate for it. **A wrong answer that announces itself as a different wrong
> answer is not a loud failure.**
>
> **And the mutation sweep says the fix is redundant rather than minimal, which is recorded
> in the test rather than hidden.** `taskId` and `served` each discriminate this case alone,
> so reverting ONE leaves the suite green and reverting both turns it red. They stay as a
> pair on the argument the file already makes for `decided`/`decisionOf`.

**A7 · A graph can name `(unidentified)` as an approver. RESOLVED 2026-08-06.**
`GRAPH014_APPROVER_INVALID` accepted any non-empty string. **The entry's own scoping
sentence was the wrong half of the story**: it said "the HTTP path is closed by
construction", which reads as "nothing is reachable" — and the perimeter check is one door of
THREE. `SignedWebhookChannel`'s callback route and `loom approve --as` each construct the
actor themselves, so a graph listing the marker was answerable through either.
`isSyntheticSubject` in `vocab.ts` is now applied at all three, and it refuses the SHAPE
rather than a list of the two markers this build mints, so one added later is refused by
construction.

> **The shape had to be the marker's own grammar, and the first spelling was too loose.**
> `startsWith("(") && endsWith(")")` matched `"(sre) alice (oncall)"` and `"( )"` — at the
> HTTP perimeter that is a deployment whose SSO subjects carry a parenthesised team prefix
> unable to authenticate anyone at all. It is now one parenthesised lower-case token, and it
> TRIMS, because the three callers disagreed about whitespace: `checkApproval` trimmed before
> asking and the other two did not. Found by a reviewer, not by the sweep.

**A8 · The control plane's idempotency map is unbounded. RESOLVED 2026-08-19, and the entry
named one site of six.** `grep -a` for a `.delete` on any of them returns nothing.

**Measured first, because the obvious probe lied three times.** `HumanGateBroker.#ephemeral` —
the heaviest, holding the rendered gate payload the journal deliberately does not — retained
**~24 MiB across 6000 gates, of ~38 MiB retained in total**. The first three readings said
0.4–0.8 MiB: payloads built with `"x".repeat(4096)` share one V8 backing store, and once that was
fixed nothing referenced the broker after the loop, so V8 collected the whole thing before the
measurement. A probe that reports "no leak" has to be shown capable of reporting one. *(The first
write-up of this entry said "33.0 MiB in `#ephemeral`" — a total-retention number worn as a map
number. A reviewer separated them: the fix reclaims ~24 MiB and the residual ~14 MiB is journal
the fix correctly does not touch.)*

**Each map got the treatment its own failure mode allows, and they differ:**

| Site | Done | Why not the same as the others |
|---|---|---|
| `HumanGateBroker.#ephemeral` | a closed gate's PAYLOAD dropped; its route, SLA and default action kept | a size cap evicts in raise order, so it targets the longest-open gate — the one about to escalate. And **so did releasing the whole entry**: `Engine.rewind` reopens a decided gate by design, so the first version of this fix stripped a LIVE gate's `DeliverySpec` and `#fireTimeout` expired it with a reason that was false. Reproduced by both reviewers independently |
| `Engine.#childGraphs` | FIFO cap | a pure cache of frozen inputs: eviction costs a recompile and cannot change an answer. Missed by this entry entirely, and the commit immediately before had just widened its key |
| `ControlPlane.#idempotency` | FIFO cap | the one where eviction is a CORRECTNESS cost — nothing dedups on the key, so an evicted entry is a second run. Safe only because entries land on success |
| `HumanGateBroker.#idempotency` | **left alone, deliberately** | safe against replay — the durable gate-state fold, not the map, is what refuses a repeat — but eviction turns a legitimate Slack redelivery into a durable `gate.callback_rejected` naming a blameless human, plus a bump on the **unresettable** `callbackRefusals` counter |
| `ResourceStore.#idempotency` | **dropped from scope** | free to fill (the key is set BEFORE the content-address early return), and it is a MISMATCH DETECTOR rather than a dedupe — evicting turns a refusal into a silent accept. Also has no `publish` caller on the serve path |
| `ResourceStore.#versions`/`#byDigest`/`#selectors` | **open** | these hold the actual content and are what grows in that class. Recorded, not fixed |

**Gates the ENGINE closes** — `gate.cancelled`, from an operator cancel or a run that fails or
completes with a question standing — never went through the broker at all, so every cancelled run
leaked a payload per open gate. `cancelOpenGates` now calls `releaseClosed`. It does so as the
events are BUILT rather than after they land, and the cost is stated in the method: an append that
loses its compare-and-swap has dropped a payload for a still-open gate, leaving it in exactly the
state a restarted process leaves it in.

**Neither new cap is observable.** No counter, no event, no log line — against this tree's own
practice for lossy structures (`Subscription.dropped`, `refusals()` on `/health`,
`redact.ts`'s warned-keys cap, which "degrades to warning on every change of value — noisier,
never quieter"). `MAX_CACHED_CHILD_GRAPHS`'s own reversal condition — "if a deployment measures
recompiles it cares about" — is therefore unmeasurable. Open.

> **The first plan for this got all of that backwards** and would have shipped a uniform cap over
> four maps. It called `#ephemeral` "the safest to evict" while citing, as its evidence, the file
> whose own docstring describes that exact state as a hazard — *"EXPIRES gates that should have
> escalated. Silently, and fail-closed, which is the kind of wrong that gets discovered a quarter
> later."* It had enumerated three of nine read sites. **Name every site that touches the value
> and write the list into the claim** — the same lesson this register opens with.

**A10 · The rewind boundary refusal covers `gate.decided` only, and `#expire` writes the same
split. THE SPECIFIC DEFECT IS CLOSED; THE PRESCRIPTION IS NOT — do not delete this entry.**

> `Engine.rewind` now refuses THREE boundaries, and `run/engine.ts` names this entry at two of
> them: `gate.decided` (the original), `gate.batch_decided` at `ev.seq === atSeq` (a batch
> receipt, reached through a new event type), and `gate.timeout{action:"fail"}` at
> `ev.seq === atSeq` (the expiry this entry was written about). The reproduction below no longer
> reproduces.
>
> **What this entry actually asks for is still not done, and the code says so where it matters.**
> The refusal is written as *"this event is one of three named types"* when the property is
> *"this boundary splits an append whose tail carries the run's status transition"*. Every row a
> future change adds to a decision's or a terminal's append has to be added here too, or it
> reopens the hole — and this is now the THIRD type added, which is evidence for the prescription
> rather than against it. Making it structural needs an append boundary the journal does not
> record: a new field on `JournalEvent`, both stores writing it, and a defined reading for every
> journal that predates it. That is a change to the durable format invariant 2 makes
> authoritative, and half of it is worse than the narrow version.

**A10 (original text, kept for the reproduction) · The rewind boundary refusal covers
`gate.decided` only, and `#expire` writes the same split.** `Engine.rewind` refuses a boundary that lands on a `gate.decided`, because `resolve`
writes `gate.decided` + `run.resumed` in ONE append — two seqs — and a rewind to the first
keeps the decision and drops the resume, wedging the run. `#expire` writes `gate.timeout` +
`run.failed` in one append, the identical shape, and the scan skips it (`if (!isEvent(ev,
"gate.decided")) continue;`). Reproduced end to end on the skeleton graph: `#expire` wrote
`89:gate.timeout 90:run.failed`; `rewind(runId, 89)` was **accepted**; the run folded to
`run=awaiting_gate gate=expired openGates=0`; `advance()` was a no-op with zero writes. The
same wedge, reached by asking for the seq the refusal was written to protect. It is
recoverable the same way — `rewind(runId, 88)` gives `run=awaiting_gate gate=open
openGates=1` — which is exactly the argument the `gate.decided` arm's own docstring makes for
refusing rather than repairing.

**RESOLVED 2026-08-06 by the FIRST of the two fixes, deliberately.** The scan now refuses a
`gate.timeout` at `atSeq` whose `action` is `"fail"` — the one that carries `run.failed` in
the same append. It is narrowed to `fail` and the narrowing is load-bearing:
`gate.timeout{default_action}` heads a three-event append whose first seq suppresses all
three and leaves the gate OPEN, which is what an operator asking for that seq wants. Both
halves are pinned in `test/run/gate-lifecycle.test.ts`, and the second needed a hand-written
row, because `GateSlaSpec` cannot declare a `defaultAction` at all — only an embedder driving
`HumanGateBroker` directly produces it.

> **The second fix is still the right one and is still not done, and the argument is
> unchanged.** This is now the THIRD event type added to a scan whose property is really
> "this boundary splits an append whose tail carries the run's status transition", and every
> row a future change adds to such an append has to be added here too or it reopens the
> hole. Making it structural means a new field on `JournalEvent`, both stores writing it, and
> a defined reading for every journal that predates it — a change to the durable format
> invariant 2 makes authoritative, and half of that is worse than this.

**A11 · `checkDelivery` accepts a `redactAs` the runtime does not apply literally.** New,
and it is the residue of closing the delivery-redaction leak rather than a discovery.
`DeliverySpec.redactAs` is a `Classification`, and two of the four — `public`, `internal` —
classify data as NOT sensitive; `redact`'s arm for them is the detector sweep, which is a
backstop for free text and returns anything it does not match. So `redact: ["ssn"],
redactAs: "internal"` used to redact nothing at all. `redactFields` now floors the
classification at `pii` (`maxClassification(as, "pii")`), which is the safe direction and is
tested — but the COMPILER still accepts the declaration and says nothing, so a graph author
reads back a `redactAs` the runtime quietly replaced. That is the shape `checkApproval`'s
own docstring calls worse than none. Reproduced before the floor landed —
`redactFields({command:"restart", email:"oncall@example.com", ssn:123456789}, ["email",
"ssn"], as)` returned the email and the ssn **verbatim** for `as` = `public` and
`internal`, the token for `pii`, and `[secret]` for `secret_ref`. **Fix:** a
`GRAPH014_DELIVERY_INVALID` in `checkDelivery` for a `redactAs` that is not `pii` or
`secret_ref`, with the fix text naming the two that hide anything — three lines next to the
check that already validates the field is a classification at all.

> **REFUTED 2026-08-06, AND IT IS THE MEASUREMENTS THAT SURVIVE RATHER THAN THE VERDICT.**
> Every number above still reproduces; what is wrong is the sentence calling the compiler's
> silence a defect. **The floor IS the published contract**, not a quiet replacement:
> `DeliverySpec.redactAs`'s own JSDoc states it (*"FLOORED AT `pii` — `public` and
> `internal` classify data as not sensitive…"*, which is emitted into the `.d.ts` an author
> reads on hover), `redactFields`'s docstring restates it at length, and
> `test/run/delivery.test.ts` pins **both** values by name under a comment saying "both
> reachable from a graph `checkDelivery` accepts" — so the compiler's silence was a
> considered part of the decision and not an oversight.
>
> **And `checkApproval`'s argument does not transfer, which is the part worth keeping.**
> That argument is about a runtime enforcing LESS than the graph declared — supervision that
> is not there. Here the runtime hides MORE than the graph declared. A refusal would be
> defensible on legibility grounds and is a *design* question about whether
> `Classification` is the right type for this field at all; it is not a fail-open, and it
> does not belong in a register of things known to be wrong. **Do not "fix" this without
> reopening the type question first.**

**A12 · Caller-supplied numbers with no bound. NARROWED 2026-08-19, not closed.**
`interventionWindowMs` is genuinely bounded — `boundedWindows` (`run/policy.ts:200-217`, wired at
`:248`, re-validated at `engine.ts:567`) — so the sentence below was already stale when this pass
began. **But re-asking the question found another member in a file this entry had cleared**, which
is verbatim what this entry's own third correction says its sweep does wrong.
`GateSweeperOptions.limit` was `Math.max(1, opts.limit ?? 500)`; measured, `Math.max(1, NaN)` is
`NaN`, `Math.max(1, Infinity)` is `Infinity`, `Math.max(1, 1.5)` is `1.5`, and all three reach
`listRuns`. Now refused. **And the clamp's stated benefit was never real:** `listRuns` is
`ORDER BY run_id DESC LIMIT ?` over time-ordered ids, so the floor of 1 it fell back to pins every
tick to the single newest run — no clock at all for every other run, not "a slow tick". Treat this
entry as a standing question, not a list.

**The original text, for the grain of it: `PolicyEngineOptions.interventionWindowMs` is
what is left; a timer above 2³¹−1 ms means one millisecond, and a cap of `NaN` means no cap.** `setTimeout`, `setInterval` and
`AbortSignal.timeout` keep their
delay in a 32-bit signed integer and TRUNCATE anything larger; they do not saturate and they
do not throw, they print a `TimeoutOverflowWarning` naming no call site. Measured on node
v24.16.0: `setInterval(fn, 2 ** 31)` fired after 1 ms, `AbortSignal.timeout(2 ** 31)` aborted
after 1 ms with a `TimeoutError`, and `NaN`, `Infinity` and every negative land in the same
place. See `positive`'s docstring in `cli.ts` for why every one of these is a REFUSAL rather
than a clamp.

**Bounded now** — `cli.ts`'s `positive` (`--sweep-ms`, a channel's `timeoutMs` and
`toleranceMs`), `ControlPlane`'s constructor (`requestTimeoutMs`, and now `maxBodyBytes`
and `hotWindow` through `boundedCount`), `postJson` (`HttpOptions.baseDelayMs`,
`.maxDelayMs`, `.maxAttempts`, **and `Retry-After`**), and `runSandboxed`
(`SandboxOptions.timeoutMs`, `.gracePeriodMs`, and now `.maxOutputBytes` through
`boundedBytes`). And one that is not an *option* at all: **`GET /runs?limit=`**, the first
member of this class a request supplies rather than a config file. It was
`listRuns(Number.isFinite(limit) ? limit : 50)`, and finiteness is the one property a
`LIMIT` clause does not care about — measured on six runs, `?limit=-1` returned **6 from
SQLite** (`LIMIT -1` is *no limit*) and **5 from the memory store** (`slice(0, -1)`),
`?limit=1.5` **threw `datatype mismatch`** on the real store, which `#dispatch` reports as
a 500, and `?limit=abc` quietly became 50. Now a 400 through `pageLimit`.

**A THIRD CORRECTION, AND IT IS TO THIS ENTRY'S SWEEP RATHER THAN TO ITS ARITHMETIC — the
grep below is organised by the WRONG THING, and both defects it missed were in files it had
already cleared.** The sweep asks *which platform API consumes this number*
(`setTimeout|setInterval|AbortSignal.timeout|.listen`). What actually decides whether an
unbounded number is dangerous is *what it is compared against*, and `NaN` loses every
comparison — so a knob whose entire job is to say "stop here" stops nothing, and no grep
for a timer will ever find it. Three members were found by re-asking the question that way
and all three are now closed:

- **`SandboxOptions.maxOutputBytes` — the last unbounded number in the sandbox, and the
  worst placement available for one.** It is read inside a `'data'` listener, which is a
  call from Node's event loop with no `try` above the frame, in the file whose docstring
  promises *the kill path must not kill the host*. Reproduced, node v24.16.0:
  `maxOutputBytes: 2 ** 31` (a legal, ordinary "plenty of headroom" number, and ~4× V8's
  536 870 888-character string limit) against a child writing 600 MiB ended as
  **`RangeError: Invalid string length`, UNCAUGHT — host dead**; `{valueOf() { throw }}`
  did the same on the first chunk, because `outBytes >= maxBytes` is a coercion and a
  coercion is a call. `NaN` and `Infinity` **disabled the cap entirely** — 4 MiB captured
  against a 1 MiB default, with `truncated` reported **false**. Bounded to
  `[0, buffer.constants.MAX_STRING_LENGTH]`, refused before `spawn`, and `typeof` is what
  keeps the hostile case safe: it never invokes `valueOf`.
- **`ControlPlaneOptions.maxBodyBytes` — cleared by this entry's own "checked and NOT this
  defect" list, and it is the one member with a REMOTE party on the far side.** It is what
  stands between an unauthenticated `POST /runs/:id/callbacks/:channel` and this process's
  heap. Reproduced: 8 MiB of JSON at `POST /runs` against the 1 MiB default →
  `400 E_PROVIDER_BAD_REQUEST` as designed, but with `maxBodyBytes: NaN` or `Infinity` the
  whole 8 MiB was buffered, concatenated and `JSON.parse`d, while `/health` went on
  reporting a healthy plane.
- **`ControlPlaneOptions.hotWindow`** — cleared by the same bullet. `head - lastSeq > NaN`
  is false, so every reconnect takes the REPLAY branch and a run with a million events is
  streamed frame by frame to a browser that asked for a snapshot. Quietest of the three and
  the same construction.

Both `ControlPlane` knobs are now **read once at construction** into `#maxBodyBytes` /
`#hotWindow` as well as validated, which is this file's existing rule for `#token` and
`#identity`.

**A FOURTH CORRECTION, AND IT IS TO THE SENTENCE THAT USED TO END THAT PARAGRAPH.** It said
those two were "the last two options that were still read off `#opts` per request". There
were **five**, and the one it missed is the option in that record whose refusal has a
reproduction written next to it. Counted by driving every route behind a `Proxy` over the
options record: `requestTimeoutMs`, `graphs`, `bus`, `store`, `engine`. And
`requestTimeoutMs` is not a cosmetic member — reproduced against `ControlPlane` with a
plain record MUTATED after construction, no getter required, and an identity source
answering in 5 ms:

```
before mutation → 200 {"runs":[]}
after  mutation → 504 {"error":{… "message":"no response for /runs within 2147483648ms"}}
```

— which is verbatim the failure the constructor's `requestTimeoutMs` check exists to
prevent, on a plane whose constructor validated 30 000. (The elided wire code is the
undeclared literal `#withDeadline` writes; this file does not spell it, because the drift
guard would then want it registered, and it is deliberately not in `CODES`.) `graphs` was
read on `/health`, the
one route a stranger reaches and the route whose whole promise is that it answers from
process-local state alone. `ControlPlane` no longer has an `#opts` field.

**A FIFTH CORRECTION, AND IT IS TO THE RULE THE FOURTH ONE WROTE — the property did not
hold and the test that was supposed to pin it structurally could not see the violation.**
That paragraph ended: "the constructor is the only method that may name the options record,
and `THE OPTIONS RECORD IS READ AT CONSTRUCTION AND NEVER AGAIN` … asserts zero reads after
`listen` rather than listing fields." By that spelling the class complied and the property
was false. `logFor` — the log factory the constructor hands `GateCallbackRouter` — is a
CLOSURE over `opts`, so `opts.store`, `opts.bus` and `opts.now` were written inside the
constructor's own source text and READ PER REQUEST, from the unauthenticated callback
route. **Where a read is written and when it happens are different questions, and the rule
was about the first one.**

The test could not detect it, which is the worse half: its record had no `dispatcher`, so
`#callbacks` was `undefined` and `logFor` was never built. It asserted zero reads of a
closure that did not exist. Reproduced against the source it was passing on, with a
dispatcher wired and a correctly-signed callback naming a different run (a refusal past the
perimeter, which is the arm that journals):

```
reads after POST /runs           → []
reads after the callback refusal → ["store","bus","bus","now","now"]
```

and the consequence, plain assignment after `listen`, no getter:

```
record.store = elsewhere;  record.now = () => 4102444800000;
the run's OWN journal → (no refusal row)
elsewhere             → 1:gate.callback_rejected@4102444800000
```

The one durable record that an unauthenticated endpoint is being hammered went to a store
the plane was never constructed with, on a clock it was never constructed with, while every
other route kept writing to the real one — invariant 2, reached around by an assignment.
**FIXED**: `#now` is now a captured field and `logFor` reads `this.#store` / `this.#bus` /
`this.#now`. The rule is restated in the field block as a statement about TIME — *no value
used to serve a request may be read off the options record after the constructor returns,
including by a function the constructor created* — and the test wires every option including
the dispatcher, drives the callback route to a durable refusal, and asserts both the read
count and where the row landed. Each half was watched failing on the reintroduced violation
before it was believed.

**A COUNT OF WHAT IS LEFT IS THE THING THIS ENTRY KEEPS GETTING WRONG** — "the last two",
"two paths … both outside those two files" when there were four, and 25-that-was-26 in E1.
Three miscounts, one entry. Write the DERIVATION, never the total. And now a fourth kind of
wrong that is not a count at all: **a rule stated as a property of SYNTAX rather than of
time, pinned by a test whose fixture omitted the only configuration that could break it.**
Before believing a structural pin, ask which configurations it does not construct.

The sweep to run in future is not a grep at all: **for each caller-supplied number, name
the comparison or the allocation it ends at, and ask what `NaN` does to it — and for each
caller-supplied VALUE, name every site that reads it and ask whether the second read can
answer differently.** The second half is new, and it found two members in
`sandbox/subprocess.ts` that a sweep over numbers could not, both now closed:

- **`SandboxOptions.command`, read from THREE listeners and never snapshotted** — the
  child's `'error'` handler, the `'close'` handler's cancelled arm, and
  `reportUncontained`, which runs from a `setTimeout`. Every one is a property access on a
  caller's record from a frame with no `try` above it, in the file whose docstring promises
  *no listener in this file may throw*. Reproduced, node v24.16.0, with a getter that
  answers `spawn` and throws on the next read: **UNCAUGHT in the `'error'` listener** — the
  listener whose job is to turn a failed spawn into a clean rejection — and again in the
  `'close'` listener when the run was aborted. Now `boundedCommand`, before `spawn`.
- **`SandboxOptions.stdin`, read AFTER `spawn`** — and this one is not about the host, it
  is about containment. `child.stdin.end(opts.stdin)` sits between the child and the
  promise that arms `timeoutMs`, so a non-string threw `ERR_INVALID_ARG_TYPE` out of
  `runSandboxed` with a child running, no kill scheduled and nothing holding a handle to
  it. Measured: `PipeWrap ×3, ProcessWrap` still live, child alive 1.8 s later, caller told
  loudly and the tool not contained. Now `boundedStdin`, also before `spawn`.

**Still unbounded, each reproduced against this tree:**

- ~~**`WebhookChannelOptions.timeoutMs`, when the class is constructed directly.**~~
  **CLOSED.** Bounded in `WebhookChannel.#timeout` to a whole number in `[0, 2³¹−1]`,
  refused as a DELIVERY FAILURE naming the knob rather than as a constructor throw — the one
  place this family's usual "refuse at construction" rule does not apply, because
  *NOTHING RUNS ABOVE THE TRY* pins that a config value `deliver` cannot read is a delivery
  failure and not an unstartable process. `0` stays legal (the hung-endpoint test drives it).
  Pinned by *A TIMEOUT NO TIMER CAN HOLD IS REFUSED, INSTEAD OF BECOMING ONE MILLISECOND*.
- ~~**`PolicyEngineOptions.interventionWindowMs`.**~~ **CLOSED 2026-08-06 — and refused in
  BOTH directions, which the entry below only half saw.** `boundedWindows` in
  `PolicyEngine`'s constructor refuses anything that is not a whole number in
  `[0, 2³¹−1]`, and `Engine`'s constructor builds a throwaway `PolicyEngine` so the refusal
  reaches an operator at PROCESS start rather than from inside the first `submit` —
  `PolicyEngine` is constructed lazily per run in `#contextFor`. The direction the entry
  missed is the quieter one: `NaN`, `Infinity` and every negative make `holdMs > 0` FALSE, so
  **no `action.pending` is written at all** — a config typo of `-1` turns the supervision
  window off with nothing in the journal to show one was ever declared. A clamp would have
  silently substituted a number nobody chose; a refusal makes an unstartable process out of
  what would otherwise be an unsupervised one. Pinned in `test/run/oversight.test.ts`. The
  reproduction below is unchanged and is why the entry existed: `PolicyEngine` is on the pinned surface;
  `decide` returns `holdMs = this.#windows[req.irreversibility]`, and `Engine` awaits
  `#sleep(decision.holdMs, …)` → `defaultSleep` → `setTimeout`. Reproduced:
  `new PolicyEngine({granted: [], systemFloor: "on", interventionWindowMs: {reversible_write:
  2 ** 31}}).decide({irreversibility: "reversible_write", …})` returns
  **`{effect: "allow", posture: "on", holdMs: 2147483648}`**, and that number is both slept
  on — as ONE MILLISECOND — and journaled verbatim as `action.pending`'s `windowMs`. So the
  interruption window an operator was given to hit stop is a millisecond, while the audit
  trail records 24.8 days. That is "looks supervised, is not" written into the journal,
  which is the exact failure the oversight layer exists to prevent. It bites only at posture
  `on` (at `in` a gate is strictly stronger and there is no hold) and only on a class whose
  window an operator set — `DEFAULT_WINDOWS` is 0 / 0 / 5000 / 5000 — so a default
  deployment is not exposed.
  **Fix:** the ceiling in `PolicyEngine`'s constructor, where `#windows` is merged.

**TWO CORRECTIONS TO THIS ENTRY'S OWN TEXT, and the second is the useful one.**

1. The count. It said "two paths … both outside those two files" and there were **four**;
   two are fixed above and two remain, which is two by coincidence and not by the same
   arithmetic. Do not write the number without re-deriving it — the sweep is
   `grep -ranE '(setTimeout|setInterval|AbortSignal\.timeout|\.listen)\(' packages/core/src`,
   fourteen hits, of which three are constants inside `console.ts`'s browser-JS string.
2. **`NodeSpec.retry.initialMs` / `.maxMs` was listed here and DOES NOT REACH A TIMER.** The
   entry claimed "`defaultSleep` hands that to `setTimeout`". It does not: `#sleep` is
   called from exactly one place in `engine.ts` and with `holdMs`, never with `afterMs`. The
   retry delay is journaled as `task.retry_scheduled`, folded to an ABSOLUTE INSTANT
   (`retryAfter = e.ts + afterMs` in `projection.ts`), and thereafter only ever **compared**
   against `now` — `scheduler.ts`'s two `task.retryAfter > input.now` guards and
   `engine.ts`'s two. A graph declaring a 25-day backoff therefore gets a 25-day backoff,
   not an immediate retry. This is what a claim looks like when it is reasoned from a
   plausible call graph instead of executed: the fix it prescribed (a `GRAPH` diagnostic in
   `graph/validate.ts`) would have been real work aimed at nothing. `initialMs: NaN` IS a
   defect there — `NaN > now` is false, so the task is instantly eligible and retries with
   no backoff at all — but it is a comparison bug, not this entry's.

**Checked and NOT this defect**, each by measurement rather than by reading:

- `resources/functions.ts`'s `compileTimeoutMs` → `vm.runInContext({timeout})`. `vm` keeps
  its timeout in int64 microseconds and does **not** truncate: `vm.runInNewContext("while
  (true){}", {}, {timeout: 2 ** 31})` was still running after 4 s. Different platform API,
  different range, no defect.
- ~~`GateSpec.slaMs`, `EscalationTier.afterMs`, `SignedWebhookChannelOptions.toleranceMs` —
  all reach comparisons … never a delay.~~ **HALF WRONG, and it is the third correction's
  own lesson written as a clearance.** "It reaches a comparison, not a timer" is the answer
  to the question this entry stopped asking; `NaN` loses every comparison. Measured on
  `SignedWebhookChannel`: with `toleranceMs: NaN` — and identically with `Infinity` — a
  correctly-signed timestamp from **2017** was ACCEPTED as current, i.e. the replay window,
  which is the second half of the callback perimeter, was disabled and nothing said so.
  Now bounded in the constructor (`boundedDuration`), pinned by *A REPLAY WINDOW THAT IS NOT
  A NUMBER IS NOT A WINDOW*. ~~**`GateSpec.slaMs` and `EscalationTier.afterMs` … UNCONFIRMED,
  not cleared**~~ **ASKED AND ANSWERED 2026-08-06, and the answer split the pair.** The
  compiler refuses every `slaMs`/`afterMs` shape a GRAPH can declare, so neither is a defect
  there. But `HumanGateBroker.rehydrate` takes the same request shape from an operator with
  **no compiler behind it**, and `ephemeralOf` passed `slaMs` through untouched to
  `#deadlineOf`'s third source — where `deadline = raisedAtTs + NaN` is `NaN`, which loses
  every comparison. "No deadline" and "a deadline that never arrives" are opposite answers to
  the question the operator just asked, and they were indistinguishable to a sweeper.
  `ephemeralOf` now applies the same `isPositiveWholeMs` `usableReminders` already used one
  line below it, pinned in `test/run/gate-decision.test.ts`. **The lesson is the one the
  third correction above states: "it reaches a comparison, not a timer" is the answer to a
  question that was not asked.**
- ~~`maxBodyBytes` and `hotWindow` reach no platform API with a range.~~ **WRONG, and left
  struck through rather than deleted because the reasoning is the lesson.** Both are true
  statements about the platform and neither is a statement about safety: what these numbers
  reach is a `>` in `#readRaw` and in `#streamEvents`, and `NaN` wins nothing and loses
  every comparison. Both are now bounded — see the third correction above. (`maxBodyBytes:
  0` still rejects every non-empty request body, `??` defaulting only on `undefined`, and
  that stays legal on purpose: "accept no request body" is a coherent posture.)
- **`--port` is bounded by `httpPort` AND the bind failure is handled, which are two
  different things this entry used to run together — and there turned out to be a THIRD.**
  Every *legal* port once exited through `ControlPlane.listen`'s unhandled `'error'` event
  — reproduced, `loom serve --port 1` → `node:events:487 throw er; // Unhandled 'error'
  event / Error: listen EACCES: permission denied 127.0.0.1:1`, a raw stack naming neither
  the flag nor the mistake, which is the failure `httpPort`'s own docstring cited as its
  reason for existing. `listen` rejects with `E_CONFIG_INVALID could not bind
  127.0.0.1:<port>`. The third: an out-of-range port never reaches a bind at all —
  `server.listen(port, host)` throws `ERR_SOCKET_BAD_PORT` **synchronously inside the
  promise executor**, so `-1`, `65536`, `1.5`, `NaN` and `2 ** 31` each rejected with a raw
  `RangeError` carrying no code, no `details` and none of the contract's text, while `"80"`
  (a string) reached the OS and failed EACCES like any other privileged port. The
  synchronous throw is now caught and mapped through the same `E_CONFIG_INVALID`, pinned by
  *A PORT NO SOCKET CAN HOLD REJECTS THROUGH THE SAME CONTRACT* in `test/server/http.test.ts`.

**THE ONE MEMBER OF THIS CLASS A REMOTE PARTY CONTROLS, now closed and worth stating
separately, because everything else above is an operator's own foot.** A provider's
`Retry-After` header reached `setTimeout` through `postJson` with no clamp at all — the
`??` in `sleep(last.retryAfterMs ?? Math.min(base * 2 ** n, max))` skipped the ceiling that
was right there. Measured, one row per header: `86400` slept **86 400 000 ms** (a worker
parked for a day, legally, under the ceiling, no warning anywhere); `2147484` slept
2 147 484 000, i.e. **1 ms** — a hot retry loop aimed at the provider that asked for it, and
a way to burn a budget from the outside; and `""`, `"  "` and `"-5"` all became **0** through
`Number()`, the same hot loop reached by a header that is not a duration at all. The header
is now parsed strictly (RFC 9110 `1*DIGIT` or an HTTP-date, anything else is *no advice*
rather than advice of zero) and the delay is clamped into `[our own curve, maxDelayMs]`, so
it can ask for more patience and never for less. **A sweep of the whole class found exactly
one remote-controlled member**; no callback shape, tool manifest or graph duration field
carries a number a remote party chooses. If a second ever appears, it belongs on this line.

**A13 · `evolution/trajectory.ts` digests low-cardinality inputs with no key. UNCONFIRMED,
and it is what is LEFT of a four-site entry whose other three are closed.** The
construction is certain; the crossing is not. `inputDigest: digest(inputs)` and
`observationDigest: digest(s.writes)` sit under a module table that says "Payloads become
digests; tool arguments become type SHAPES" because "a trajectory store is a second copy of
production data" — and `shapeOf` honours that where an unkeyed digest does not: a digest of
an input you can enumerate is a lookup key for anyone holding it. What is unverified is
whether a trajectory ever leaves the process; nothing in `src/` persists or ships one
today, which is why this stayed a bullet for two waves. **Reproduce or refute it by
answering one question — does a `Trajectory` reach any sink outside this process? — and if
it does, the fix is the one the span attributes just took: a `pii` classification through
`redact`, not a second hashing scheme.**

> **The other three sites are FIXED**, and are recorded here only so the shape is
> findable: `spans.ts`'s `gate.approver` (an unkeyed 48-bit prefix of a subject drawn from
> the graph's own `approvers` list — inverted from four candidates in 0.011 ms),
> `gate.content_digest` (a confirmation oracle that recovered a five-digit `employeeId`
> the delivery path had just redacted, in 50 ms), and `state.hash.before/after` (the same
> oracle over the whole channel map, 63 ms). All three now carry a `pii` classification
> through `redactAttributes` — see `ATTRIBUTE_CLASSES` in `telemetry/spans.ts` and the
> boundary table under D9.1 in `05-RESOURCES-OBSERVABILITY.md`. **The correction this
> entry needed in its own text was its scope**: it prescribed "giving the gate arm
> `{"gate.approver": "pii"}`", which is per-arm and is the shape that gets missed the
> second time. The map is keyed by attribute name and consulted in `close`, the one place
> a span leaves the file, so it covers arms nobody has written yet.

Checked and NOT this defect: `spanId`/`traceId` (`digestOf(runId)` — a run id is not a
secret, and it MUST stay derived: a constant traceId merges two runs into one waterfall,
which is now pinned), `retention.ts`'s `digest(e.payload.argsShape)` (a shape, by
construction), `resources/store.ts`'s content addresses (inside the boundary),
`BearerTokenIdentity`'s `sha256(token)` (a process-local map key over a high-entropy secret
that is never emitted), and `run.submitted`'s `idempotency.key` and `config.digest`, which
are exported in the clear on `loom.run` — the first is caller-authored and could carry
anything, but it is an OTel-conventional attribute an operator correlates ingress with, and
nothing here has a domain a holder can enumerate. If a deployment starts putting customer
identifiers in idempotency keys, that becomes the next row.

**A14 · `reduceState` accepts a write to `constructor`, `toString` or any other inherited
name, instead of refusing it. RESOLVED 2026-08-06, AND THE ENTRY'S OWN CARVE-OUT WAS WRONG.**
One module-private `declared()`/`own()` pair in `state/channels.ts`, applied at
`reduceState` and — the part this entry got backwards — at `makeStateView`. The fix it
prescribed named `initialState`, which is already total (it iterates `Object.entries`,
own-enumerable only); and its "Checked and NOT this defect: `StateView.get`/`require` (their
allow-list is a `Set`)" was the more severe half. The `Set` guards a channel the node did NOT
declare; it does nothing about one it DID, and `graph/compile` admits `reads: ["constructor"]`
with only a WARNING. Measured on a single function node declaring it:

```
run status: failed   channels: {}
run.failed {"code":"E_INTERNAL","message":"CanonicalizationError: function is not representable at constructor"}
```

— the whole run dying on `digest(slice)` choking on the `Object` function, rather than the
`E_CHANNEL_UNDECLARED` this layer promises.

> **THREE reads, not one, and the third was found by the test rather than by the entry.**
> The slice is BUILT once and READ BACK twice; fixing only the construction left `get` and
> `require` indexing it bare. That is this codebase's recurring shape — *"make the reads
> total" is a claim about a SET of reads* — arriving for the fourth recorded time, and it was
> caught because the test asserted `get` and `require` as well as `visible`. Pinned in
> `test/state/channels.test.ts`.
>
> `__proto__` is the one name whose answer depends on how the wave was built, and both
> readings are now pinned: ASSIGNING it invokes the setter so the key is never own and there
> is no write to refuse, while `JSON.parse` yields a genuine own property that is refused
> like any other undeclared channel.

The original text follows. It is the class-sweep residue of pinning
`StateView.get`'s allow-list rather than a discovery: the same prototype-chain hazard
`gateOf` was written for, one layer down and still open. `reduceState` does
`const spec = specs[channel]; if (spec === undefined) throw E_CHANNEL_UNDECLARED`, and
`specs["constructor"]` answers with the `Object` **function** — not `undefined` — so the
refusal never fires. **Reproduced** against `specs = {findings}`:

```
reduceState({constructor}) → ACCEPTED  channels=["constructor"]  state={}
reduceState({toString})    → ACCEPTED  channels=["toString"]     state={}
reduceState({nope})        → refused: E_CHANNEL_UNDECLARED
```

Nothing lands in state (`reduceChannel` with `spec = Object` returns `undefined`, which the
spread drops), so this is a **fail-open refusal rather than a state corruption** — but the
`state.reduced` event it emits names a channel in `channels` that no graph declares and no
reducer wrote, and the one check standing between a node body's write vocabulary and the
graph's declared channels does not run for four names. Whether a node can reach it depends
on what filters `NodeOutcome.writes` upstream, which is the part that is **UNCONFIRMED**;
the `reduceState` behaviour itself is measured. **Fix, exactly:** the same
`Object.prototype.hasOwnProperty` test `gateIn` uses, in `reduceState` and in
`initialState`'s sibling lookups — `state/channels.ts` is one file and this is one helper,
not four call sites. Checked and NOT this defect: `StateView.get`/`require` (their allow-list
is a `Set`, and it is now pinned by *A CHANNEL NAME THAT NAMES AN INHERITED PROPERTY IS NOT A
CHANNEL*), `projection.ts`'s `gates` map (`gateOf`/`gateIn`), and its `tasks`, `bindings` and
`channels` maps, whose prototypes `freeze`'s spread launders before any caller sees them.

**A15 · A digest is classified by where it is EMITTED, not by where it is COMPUTED — and
that filing rule is what let three unkeyed digests out of the process. RESOLVED for the
span path; kept for the rule and for the two sinks nobody has swept.** The three sites and
their reproductions are recorded above under A13; what belongs here is the reasoning error
that hid them, because it will hide the next one. A13's own "checked and NOT this defect"
list cleared `state/channels.ts`'s state hashes on the grounds that they live in *the
journal and the store, both inside the boundary*. They do. `telemetry/spans.ts` also
exported them per Task to a third-party collector, which no amount of reading
`channels.ts` reveals — the site that computes a digest is not the site that discloses it,
and a sweep organised by construction rather than by sink will keep missing that.

Two properties were lost at each site, not one: inversion of a low-cardinality input, and —
quieter, and the one that survives a long value — an unkeyed digest is an **equality oracle
across runs and tenants**, so a collector could tell that two runs reached byte-identical
channel state, or that one person answered a gate in each, while holding neither value. The
keyed token closes the first; the **run-scoped** key `tokenKey` requires of any caller
outside the boundary closes the second.

**One sink has NOT had this sweep, and that is what is left of this entry: `server/http.ts`,
where the same "one bag redacted, its neighbours not" shape that hid the span events is
visible by inspection.** `frame` redacts `e.payload` and sends `e.actor` beside it
untouched, so a `gate.decided` frame carries the approver's real subject; `summarise`
redacts `channels` and `outputs` under a docstring that says "channel values reach a
browser here, so they are swept on the way out" — and then sends `gates`, `outputs`' sibling
`error`, and each task's `error` raw, so a gate record's `approvers` and `contentDigest`
reach the browser unswept. **This is very probably fine and it has never been argued.**
`tokenKey`'s docstring makes the argument that would settle it — this reader is an
authenticated operator who can read the same values unredacted from the journal and from
`GET /runs/:id/gates` anyway (A3: every valid credential is a full operator credential) —
and if that is the answer, it belongs in `frame`'s and `summarise`'s docstrings, next to
the fields it licenses. Read it against the question this wave asked of every span
attribute: **could the holder of this reconstruct an input they are not entitled to?**
A bounded afternoon, and `server/console.ts`'s browser JS is the same afternoon.

Checked and NOT this defect, each by reading the input rather than the construction:
`"graph.hash"` and `"config.digest"` are digests of operator-authored documents, not of
per-record data, and their audience is the operator who wrote them; `spanId`/`traceId`
(`digestOf(runId)`) and the `headRatio` sampling bucket are over a run id, which is not a
secret; `resources/store.ts`'s content addresses and `retention.ts`'s `digest(argsShape)`
stay inside the boundary. `evolution/trajectory.ts`'s `inputDigest`/`observationDigest`
remain **UNCONFIRMED** exactly as A13 says, and here is the command:
`grep -ran "Trajectory" packages/core/src | grep -v "^packages/core/src/evolution/"` returns
**nothing**, so no trajectory crosses any boundary today.

**A16 · A `Subscription` is single-consumer and nothing anywhere says so; two `for await`
loops over one SPLIT the stream instead of each seeing it. RESOLVED 2026-08-06 as
DOCUMENTATION, which is the whole decision.** `Subscription`'s docstring now states the
contract with the measurement in it, `EventBus.subscribe` and `replayThenTail` each carry a
one-line restatement, and `test/bus.test.ts` pins the splitting behaviour so that making it
unrepresentable later is a deliberate change to a test rather than a silent one.

> **Not made unrepresentable, and the reason is worth keeping.** A `#iterating` flag would
> have to be threaded through `replayThenTail`'s merged iterator as well — which splits
> identically, and which this entry did not mention — and a second `for await` after a clean
> `break` is a legitimate re-entry that nothing at that seam can distinguish from the defect.
> "Nothing says so" was also mildly overstated: `SubscriberOverflowError.lastSeq`'s docstring
> already names the SEQUENTIAL second-consumer case. That is a statement about overflow, not
> about the subscription, which is exactly why it did not cover this.

The original text follows. New, and it is the residue of a
lifecycle sweep over `subscribe`/`dispose`/iterate rather than a discovery — the pair that
overlaps here is *iterate × iterate*. `Channel[Symbol.asyncIterator]` is a generator over a
SHARED `#queue` and `#waiters`, so each event is delivered to exactly one of the loops, and
the generator's `finally` calls `dispose()` — so whichever loop ends first unregisters the
subscription for both. **Reproduced** on `InProcessEventBus`, one subscription, two
concurrent loops, four events published:

```
consumer A saw [1, 3]   consumer B saw [2, 4]   subscriberCount now 0
```

Neither loop threw and neither `dropped` counter moved, so a consumer that assumed a bus
fans out silently sees half a run. `Subscription` is on the pinned public surface and
`EventBus.subscribe`'s docstring does not claim single-consumer; nothing in `src/` does it
(`grep -ran "for await (const e of sub" packages/core/src` → `server/http.ts`'s SSE
handler, once), so this is an embedder-facing sharp edge rather than a live bug. **Fix, exactly:** one sentence in
`Subscription`'s docstring saying a subscription is a single consumer's channel and a second
reader wants a second `subscribe`, plus — if it is to be unrepresentable rather than
documented — a `#iterating` flag whose second entry throws. `bus.ts` was another agent's
file this wave, which is why this is an entry and not an edit.

**A17 · Two branches in `engine.ts` contemplate a gate with no `taskId`, and nothing says
whether either is reachable. UNCONFIRMED — and it is what is LEFT of the entry that used to
stand here.** That entry was the SECOND one numbered **A16**, which is its own small defect
in a register whose ids are cited from five files; it is renumbered rather than deleted so
the residue survives. Its measured half — *a gate raised by an event carrying no `taskId` is
invisible in the trace, not mis-drawn but absent* — **is fixed and pinned**: the five gate
arms of `spansFrom` now sit ABOVE `if (taskSpan === undefined || tid === undefined)
continue;` and parent on `taskSpan ?? rootId`, so such a gate traces with the run as its
parent, and *A GATE RAISED BY AN EVENT CARRYING NO `taskId` IS STILL ON THE TRACE* in
`test/telemetry/spans.test.ts` drives the whole shape (raise → escalate → decide) and turns
red if the arms move back.

What is unresolved is the question that made it a defect rather than a hypothetical:
`GateRequest.taskId` is required, so `HumanGateBroker.raise` cannot produce one — and yet
`cancelOpenGates` and `#commitForOpenGate` each branch on `gate.taskId === ("" as TaskId)`
with a comment saying a gate raised by an event carrying no `taskId` folds to `""`. **Either
those two branches are dead and should say so, or a journal can carry such an event and
something else that reads `taskId` needs the same treatment the fold just got.** The trace
is now correct under both answers, which is why this is UNCONFIRMED rather than open: it
costs nothing to leave undecided, and deciding it means reading `engine.ts` end to end.

**HALF OF IT IS MEASURED, AND ONE OF THE TWO MEASUREMENTS WAS WRONG — corrected here, with
the reproduction that refutes it.** The two facts as this entry used to state them:

- **A journal event cannot carry `taskId: null`.** `journal/sqlite.ts` and
  `journal/memory.ts` each map the row back with `row.task_id === null ? base : { ...base,
  taskId }`, so a NULL column becomes an ABSENT field, never a present `null`; and
  `store.ts`'s `prepare` writes `e.taskId ?? input.taskId ?? null`. Both stores agree, at
  both ends. **STILL TRUE.**
- ~~**`taskId: ""` is deliberately never appended.** `run/gates.ts`'s `#commitForOpenGate`
  and `run/engine.ts` both STRIP the field.~~ **REFUTED**, and struck through rather than
  deleted because the reasoning is the lesson: the two strips are real and they are not a
  property of the file, let alone of the pair. Read against both files —

  - `run/gates.ts` strips at **two** appends: `#commitForOpenGate` (the clock's timeouts,
    escalations and expiries) and `resolveBatch`'s `lead`. It does **not** strip in `raise`
    (`{ taskId: req.taskId }`) or in `resolve` (`{ taskId: gate.taskId }`) — the raise and
    the DECISION, the two appends a gate cannot happen without;
  - `run/engine.ts`'s `cancelOpenGates` strips the field from the **event**, not from an
    append. That holds only because every one of its call sites appends with no
    append-level `taskId`; `prepare` spreads one over every event that lacks its own, so an
    append-level stamp would put the id straight back;
  - and `""` **is not nullish**, so that same `e.taskId ?? input.taskId ?? null` passes it
    through untouched.

  **Reproduced** on both stores, writing exactly the shape `raise` produces for
  `req.taskId === ""` — the field on the event and the stamp on the append — and reading it
  straight back:

  ```
  memory [{"type":"gate.raised","hasTaskId":true,"taskId":""}]
  sqlite [{"type":"gate.raised","hasTaskId":true,"taskId":""}]
  ```

  Pinned by *`taskId: ""` IS APPENDABLE ON BOTH STORES* in `test/telemetry/spans.test.ts`.

So the `""` those branches test is a value the FOLD writes (`projection.ts`'s
`taskId: e.taskId ?? ("" as TaskId)`) **and** a value the journal can carry. The open half is
unchanged and is still the only half worth spending time on: can a `gate.raised` be APPENDED
with no `taskId` **at all**? **Do not add a third `""` branch** to `engine.ts`.

> **ANSWERED 2026-08-06, AND THE ANSWER IS "NOT A DEFECT — A COMMENT".** The question was
> whether the `taskId === ("" as TaskId)` branches are dead. They are **not**, and the
> entry's own framing — *"either those two branches are dead and should say so, or something
> else that reads `taskId` needs the same treatment"* — offered a third reading it did not
> consider: they are live, and what they defend against is a **hand-written or legacy
> journal**, which this repo folds routinely and deliberately.
>
> There are **four** of them, not two — `HumanGateBroker.#commitForOpenGate`, `claim`,
> `resolveBatch`'s `lead`, and `cancelOpenGates` in `run/engine.ts` — and a
> `gate.raised` carrying no `taskId` at all is producible only by writing the journal
> outside this process's own appenders, which is exactly the input those branches exist
> for. Every read model is already total against `""` (`projection.ts` mints no Task row,
> `spans.ts` mints no Task span, `console.ts` renders it as taskless), so a `""` id produces
> no wrong answer anywhere — which is why this cost nothing while it stood open.
>
> **What is left is a comment, not a change.** Those four branches should say *what shape
> they defend against* rather than reading as dead code the next sweep deletes; and the
> asymmetry with `raise`/`resolve`, which do NOT strip, is cosmetic rather than a bug.
> Entry closed as UNCONFIRMED-resolved. **Do not delete the branches.**

`telemetry/spans.ts` is out of this question entirely: `spansFrom` derives its task span from
a positive test (`typeof e.taskId === "string" && e.taskId !== ""`) rather than from
`=== undefined`, so `null` and `""` are both simply taskless there. That guard used to be
described — in this entry and in the file's own `tid` comment — as merely agreeing with an
engine that never appends either shape. **It is not agreement; it is the one place that is
total**, which is a stronger reason to keep it and the reason the comment now carries the
measurement above. Before it, `null` passed BOTH halves of the old guard
(`spanId(runId, "task", null)` is an ordinary string, because `[…, null].join("|")` renders
`null` as the empty one), so every taskless event in a journal merged into ONE `loom.task`
span keyed on the empty task id and a gate arm parented on an id no span carried — an orphan.
Pinned by *A taskId THAT IS null OR EMPTY IS NO taskId*. The rest of `spansFrom` below the
guard is still deliberately untouched — every arm there either patches the Task's own span
or derives a span id from the `taskId`, so a taskless event has no coordinates rather than
the wrong ones.

**A18 · `spansFrom` reads the journal's PAYLOADS partially in twelve places and wrongly in
three, and the three are the entry. NEW, and it is the residue of a sweep rather than a
discovery: the class-sweep asked of `telemetry/spans.ts` and `security/redact.ts` "every
place these two files read a value the JOURNAL supplied".** The journal is authoritative and
trusted (invariant 2), and *trusted* means "we do not defend against it", not "it cannot be
malformed" — a hand-written or legacy journal is a real shape this repo folds routinely
(every fixture in `test/telemetry/spans.test.ts` is one, and `trace-fixture.ts` exists to be
folded in a second process). No shape below can come out of either store's APPEND path; a
hand-written journal, a hand-edited database, or any caller of this published function can.

**The twelve partial reads are LOUD and are deliberately left**, listed so nobody re-derives
them. Each throws a `TypeError` out of `spansFrom`, which costs the caller **every span for
the run** — and for `loom trace`, the process. Reproduced one row per read, node v24.16.0:
four spreads over a payload list (`[...e.payload.edgesIn]`, `.take`, `.channels`,
`.reasons` — *"is not iterable"* when the field is absent or `null`), six nested reads
(`.resolutionManifest.length`, `.usage.inputTokens` on `run.completed` and on
`model.called`, `.error.code`, `.unknownEffects.length`), `e.actor.kind` on a `null` actor,
and `String(e.seq)` inside a span id, which runs a hostile `toString` (*"Error: hostile"*).
**They stay because making `spansFrom` total over a malformed journal is one decision, not
twelve edits** — it has to answer "does a Task whose payload cannot be read get a partial
span or none?", which changes several attribute types and belongs in its own change. A
throw is also the honest failure here: it is loud, and it is not a wrong trace.

**The three QUIET ones are the defect**, because a wrong trace is what an incident review
reads:

- **`ts` is not checked to be a number, and the waterfall silently reorders.** Measured:
  a journal whose `run.submitted` carries `ts: "x"` folded to
  `startTimes=[1020,"x"]  order=loom.task,loom.run` — the run span, which starts first,
  sorted LAST, because `a.startTime - b.startTime` is `NaN` and an inconsistent comparator
  discards the ordering. `ts: null` gives a span with `startTime: null, endTime: null`. The
  sort is still deterministic for one input (same array, same algorithm), so the file's
  byte-identity promise survives; what does not survive is the one thing a trace is opened
  for.
- **`[...e.payload.edgesIn]` splits a STRING into characters.** `edgesIn: "e1"` folded to
  `"edges.in": ["e","1"]`, so `reconstructGraph` reports two ghost edges where the journal
  claimed one — a FABRICATION, in the input to the conformance assertion. The same file's
  `reconstructGraph` already takes the opposite and correct verdict on this exact class
  ("a container that is not a list is ONE unknown edge"); the journal side does not.
- **`runId` is handed to `digestOf` unchecked**, which is `createHash().update(v, "utf8")`
  and throws `ERR_INVALID_ARG_TYPE` for a non-string. Loud, but it takes `shouldExport`
  with it, so a malformed run id is a run nothing can decide about rather than a run that
  is exported.

**Fix, exactly:** a `ts` read that refuses a non-number (the same positive test `tid` and
`headRatio` now use), and `edgesIn`/`take`/`channels`/`reasons` read through one helper that
treats a non-array as one claim rather than as an iterable. Both are in `spansFrom`; the
twelve above are the same helper applied everywhere else, and that is the change to make in
one go or not at all.

**THE THREE QUIET ONES ARE CLOSED 2026-08-06; THE TWELVE LOUD ONES ARE NOT, DELIBERATELY.**
`ts` is normalised once per event and carried forward from the last good one (so the
waterfall stays monotonic AND transitive — the intransitivity was the sharper half, since the
spanId tie-break can reorder two WELL-FORMED spans against each other); `claimedList` reads
the four claim containers; and `runId` goes through `idText` before `digestOf`, here and in
`shouldExport`. `test/telemetry/spans.test.ts`.

> **THE LIST FIX NEEDED A SECOND HALF THIS ENTRY DID NOT NAME, and it hung the suite before
> it was found.** "Treat a non-array as one claim" is only half a rule: returning the value
> ITSELF keeps the hostile container, and the next reader is `redactAttributes`, whose `walk`
> calls `.map` on anything `Array.isArray` accepts. A `Proxy` over `[]` claiming
> `length: 2 ** 32 - 1` was therefore refused in `claimedList` and walked in `redact`. The
> container is now RENDERED — `idText`, the same marker `reconstructGraph` gives a claim's
> container one screen down. **A guard that refuses a value and then passes it on has moved
> the hazard, not closed it.**
>
> `claimedList`'s length bound is a COST guard and no test holds it: deleting it changes no
> answer, because the walk throws and the `catch` returns the same marker — after **17.6
> seconds and several GB**. Tests here may not read a wall clock, so it is stated in the code
> instead of pinned. That is E4's third kind, and it is on this list rather than mistaken for
> a hole.

**Checked and NOT this defect, WITH ONE CORRECTION TO THIS PARAGRAPH'S OWN CLEARANCE.**
`security/redact.ts`'s `walk` marks a cycle, caps depth at 32, replaces a function, and
renders a `Map`, a `Date` or a `RegExp` as `{}` (data loss, never disclosure); the
asymmetry between the two arguments of `redactAttributes` is the rule and not an accident —
`attrs` may be guarded loosely because its wrong shapes remove, and `classifications` may not
because its wrong shapes disclose.

~~`security/redact.ts` is total over everything the journal hands it.~~ **It was total over
everything the journal hands it and NOT over what its published signature accepts, which is
the same "reasoned from the caller, written as a property of the function" mistake A12's
fifth correction is about.** Every read on both arguments was bare, and each of the four
below is a `Proxy` trap — reproduced, each escaping `redactAttributes` and therefore
`spansFrom`, which costs the caller **every span for the run**:

```
classifications: getOwnPropertyDescriptor trap → Error: gopd trap        (via hasOwnProperty)
classifications: get trap                      → Error: get trap
attrs:           ownKeys trap                  → Error: ownKeys trap     (via Object.entries)
attrs:           get trap                      → Error: attrs get trap
```

~~Both are now total — a classification read that throws answers `secret_ref`, and a bag that
cannot be enumerated yields `{}` — pinned by *A CLASSIFICATION MAP THAT THROWS COSTS ONE
ATTRIBUTE, NOT EVERY SPAN IN THE RUN* and *AN ATTRIBUTE BAG THAT THROWS ON ENUMERATION
REMOVES EVERYTHING*.~~ **THAT SENTENCE WAS FOUR READS SHORT OF TWO, AND BOTH SURVIVORS WERE
SIBLINGS OF THE READS IT NAMED** — the fix was applied to one helper and not to the one a few
lines away answering the same question, which is the shape this register keeps finding:

```
classifications: getPrototypeOf trap → Error: gpo trap   (isClassificationMap, ONE LINE ABOVE the try)
attrs:           {a:{get x(){throw}}} → Error: nested getter (walk's own Object.entries, depth 1)
```

- `attributeClass` wrapped `hasOwnProperty` and the index read in a `try` and left
  `isClassificationMap`'s `Object.getPrototypeOf` outside it — a `Proxy` trap, named as one in
  that predicate's own docstring, and guarded as though it were a `typeof`. The test pinning
  the other two had to build its proxies with a well-behaved
  `getPrototypeOf: () => Object.prototype` in order to REACH them, so the counterexample was a
  line of its own setup.
- `redactAttributes` wrapped `Object.entries(attrs)` and left the `redact(v, …)` beneath it
  bare. `walk` runs `Object.entries` again on every nested container and `v.map` on every
  nested array, so the shape the depth-0 guard exists for cost the whole bag at depth 0 and
  the whole RUN at depth 1 — and at depth 1 it needs **no `Proxy` at all**.

**Both closed, and the claim is now a measured one rather than a reasoned one:
`redactAttributes` does not throw, for any value of any of its three arguments** — 2,576
combinations of hostile `attrs` × `classifications` × `scope` (every `Proxy` trap throwing, a
revoked `Proxy`, a cycle, 200 levels of nesting, a throwing element getter, a `toString`
bomb under a `pii` key, an own `__proto__` from `JSON.parse`), **0 threw**. It is a property of
that FUNCTION: `redact` and `walk` are unchanged and still throw for these inputs, which is
what `redactPayload` and `redactFields` call, and a test pins that limit so the sentence cannot
widen again by being read one word too generously. Pinned by the two tests named above plus
*A CLASSIFICATION MAP WHOSE PROTOTYPE READ THROWS IS REFUSED, NOT PROPAGATED* and *A VALUE
INSIDE THE BAG THAT THROWS COSTS ONE ATTRIBUTE*.

**And the disclosure half of the asymmetry has a known, executable LIMIT rather than a
guard.** `isClassificationMap` is a NAMED-SHAPE REFUSAL — it rejects the containers it can
recognise (`Map`, `Set`, `Date`, `RegExp`, array, class instance, `null`) and it is defeated
by `new Proxy(target, {getPrototypeOf: () => Object.prototype})`, which puts `u:alice` back
on the span in the clear. That is not a fourth iteration waiting to be written: **a `Proxy`
must tell the truth about exactly one observable, the extensibility of its target**, and
every ordinary object literal is extensible, so the question has no answer and a
non-extensibility test would turn every embedder's map into `[secret]`. The real guarantee is
that `telemetry/spans.ts` passes `ATTRIBUTE_CLASSES`, a module constant. Held executable by
*A `Proxy` DEFEATS THE SHAPE TEST AND THE DISCLOSURE IS REAL — the limit, made executable*,
on the `EVERY VALID CREDENTIAL IS A FULL OPERATOR CREDENTIAL` pattern. `telemetry/spans.ts`'s
twin, `isAttributeBag`, had the same hole and is **deleted**: `reconstructGraph` could move
the check onto its reads (D9.2), and `attributeClass` cannot, because "declared nothing" and
"declarations unreachable" are one observation there.

**A19 · `Engine.resolveGate` reads ANY decision it does not recognise as an APPROVAL, and
runs the action behind the gate. RESOLVED 2026-08-06 — kept for the two lessons, which are
both about where a guard belongs.** `gateDecisionOf` in `vocab.ts` is now the one statement
of the acceptance set; `HumanGateBroker.#validate` is the point of use and RETURNS the
checked decision, so nothing downstream re-reads the caller's object. `vocab.ts` and not
`run/gates.ts` because `gates.ts` imports `delivery.ts` at run time, so a guard exported from
either is a cycle for the other — `GateDecision` moved there with it. Pinned by
`test/run/gate-decision.test.ts`.
>
> **LESSON ONE: THE WRITE SIDE WAS NOT THE WHOLE OF IT, and the first fix stopped there.**
> A fresh reviewer found `Engine.#applyGateDecision` reading a decision back out of the FOLD
> and branching on `=== "reject"` alone, so a journal carrying `decision: "REJECT"` still
> fell through to `succeeded` and ran the guarded write. The journal is authoritative
> (invariant 2), and *trusted* means "we do not defend against it", not "it cannot be
> malformed" — so fixing only the append left the identical fail-open reachable through the
> one input the system is designed to trust. **When a value is guarded on the way in, ask
> what reads it on the way out.**
>
> **LESSON TWO: A DOOR IS NOT A GUARD.** There were THREE independent switches over this
> union — `checkedDecision`, `ownedDecision`, and `run/replay.ts`'s, whose `default:` arm
> answered `{kind:"approve"}` — in front of a broker that had none, and `checkedDecision`'s
> own docstring claimed it mirrored `ownedDecision` "member for member". By the time that was
> checked they had drifted. Each door now keeps only what is genuinely its own: an HTTP
> message, a `MAX_REASON` bound, a JSON round trip over a vendor's `writes`. That last one is
> load-bearing and was nearly lost — `ownedJson` renders a `Map` as `{}`, so folding the
> plain-record check into the shared guard would have journaled a `Map` of a human's edits as
> an edit that edited nothing.

The original entry follows, because the reproduction is the argument. The fix was in
`run/engine.ts` / `run/gates.ts`, which were another agent's files that wave. `GateDecision`
is a four-member union (`approve` / `reject` / `edit` / `redirect`) and everything downstream
branches on `kind === "reject"`, so anything else falls through to the permissive reading.
Driven directly against `Engine.resolveGate` — the public, pinned-surface method an embedder
calls — one fresh skeleton run each, `guardedWrites` being whether the action BEHIND the gate
really ran:

```
{"kind":"approve"}  → run=succeeded writes=1  gate.decided decision="approve"
{"kind":"REJECT"}   → run=succeeded writes=1  gate.decided decision="REJECT"
{"kind":"nope"}     → run=succeeded writes=1  gate.decided decision="nope"
{}                  → run=succeeded writes=1  gate.decided with NO decision field
42                  → run=succeeded writes=1  gate.decided with NO decision field
{"kind":"redirect"} → run=succeeded writes=1  (no `take` at all)
```

An operator's caps-lock is an approval, and the journal keeps `decision: "REJECT"` beside
an action that happened — a word in no vocabulary, recorded as the thing a human decided.
That is the Traps list's *approve means "go ahead"* one layer up: **the unreadable case
took the permissive branch.**

**ALL THREE DOORS ARE NOW CLOSED, which is why this is an entry rather than an outage, and
also why it will be missed.** `GateCallbackRouter` validates member by member in
`ownedDecision` (the unauthenticated route always did); `cli.ts`'s `approve` constructs the
literal itself; and `server/http.ts` now has `checkedDecision`, which mirrors
`ownedDecision`'s acceptance set deliberately. Before that last one the API door was a cast
— measured over real HTTP, `{"kind":"REJECT"}` answered **200**, the run **succeeded**, and
the guarded `fs.write` ran. **Fix, exactly:** make the switch total at the point of use, so
a fifth kind is a refusal rather than an approval, and then `checkedDecision` and
`ownedDecision` can both collapse into it. Two validators for one union is the second half
of this entry and is itself the defect the "one dispatch path" invariant is about — they
agree today because one was written from the other, which is exactly the arrangement that
drifts.

**A20 · `#streamEvents` reads its baseline and THEN subscribes, so anything appended in
between reaches neither. RESOLVED 2026-08-14 — kept because HOW it was resolved is the part
worth carrying, and because the entry above it spent a week disagreeing with the summary at
the top of this file about what its status even was.** The fix is the restructure this entry
asked for: `bus.subscribe` now opens BEFORE the baseline is read and buffers while the
baseline drains, and `sent` — the highest seq already written to the client — de-duplicates
the overlap, so the subscription's replay of the seam is a duplicate rather than a gap. That
is `replayThenTail`'s shape, arrived at inline because this handler also owns the
snapshot-versus-replay branch.

**It was found again, in the other direction, by a verifier during the fix, and that is the
reason it stopped being latent.** A backpressure `await` added in the same wave parked the
handler between the baseline read and `bus.subscribe`, so an event published while a slow
client stalled landed in neither half — the ASYNCHRONOUS store this entry said would open the
window, arriving as a slow socket instead. The window was never really about the store. It was
about there being any suspension point at all between two statements whose order was wrong.

*The original entry follows, because the reproduction is the useful artefact.* It is the third
distinct way the "gap-free" contract has been broken in this one handler. The other two were
the branch (`Last-Event-ID: 1.5` became an OFFSET) and the live
tail's floor (an id ahead of head got a baseline and then had every subsequent event skipped);
both are closed. This one is the ORDER of two statements:

```ts
if (!resumable || head - lastSeq > hot) { …snapshot… } else { …store.read… }   // ← the baseline
const sub = bus.subscribe({ runId }, …);                                        // ← the tail starts HERE
```

`EventBus.subscribe` hands back an empty channel, so a subscriber is offered only what is
published after it exists. Every event appended between the baseline and that line is
therefore in neither half, and the client cannot tell. **The bus already documents the fix in
its own docstring** — `replayThenTail`: *"Subscribe FIRST, then read the journal … Order
matters: subscribing after the read would drop anything appended during it. The overlap is why
the dedupe exists — it is a guarantee, not a nicety."* — and `#streamEvents` is the one
reconnect path in the repo that does not use it.

Reproduced over real HTTP by widening the window rather than by racing it: a `Proxy` over the
engine parks `projection()` after it has resolved, the run's gate is answered while the handler
is parked, then it is released. Skeleton run, snapshot branch (`?lastEventId=abc`):

```
head 88
head after the run finished: 102 (14 events appended while the handler was parked)
client frames: 1  ["snapshot"]
```

A baseline at seq 88 and then silence, on a run that reached 102 and completed. The window is
small in practice — the parking is a stand-in for a slow fold or a long replay — but it is
widest exactly when it matters: a big journal, a client reconnecting during a burst. **Fix,
exactly:** subscribe before the baseline and dedupe against the highest seq the baseline
actually covered, which is what `replayThenTail` does; note that a naive move of the
`subscribe` call is not enough, because a long replay can then overflow the 1024-slot queue
under `drop_oldest` and reintroduce the same hole through the other door.

> **DOWNGRADED 2026-08-06 from "reproduced" to a LATENT HAZARD, and the reproduction above
> is exactly why the distinction matters.** The order is wrong in principle and this is
> still the one reconnect path that does not use `replayThenTail`. But **the window is
> currently EMPTY, and no client can lose an event through it**: both shipped
> `StateStore`s are fully synchronous (`node:sqlite`'s `DatabaseSync`, and
> `MemoryStateStore`), so the whole baseline — `store.head`, `engine.projection`,
> `store.read`, including a paged sqlite read — resolves inside ONE microtask drain, and
> the code from the last `await` to `bus.subscribe` is straight-line synchronous. Verified
> by scheduling `setImmediate`, `setTimeout(0)` and `process.nextTick` immediately before
> each call on both stores: none fired before it resolved.
>
> **The reproduction stands and does not contradict that.** It widened the window with a
> `Proxy` that parks `projection()` — i.e. it proved what an ASYNCHRONOUS store would do,
> which is what the interface permits and what any future store (Postgres, S3, a network
> journal) will be. So this is a defect of the CONTRACT, payable the day a store is not
> synchronous, and not a bug a deployment can hit today. It stays in the register for that
> reason and because the fix is the same either way; it is not the emergency the "NEW,
> reproduced, NOT fixed" heading implied. **Anything asserting a live SSE gap on a shipped
> store is wrong.**

**A21 · `GateDispatcher.deliver`'s prelude reads its `GateSummary` bare, so the one exit the
whole file is arranged around is still reachable — from the summary rather than from the
spec.** New, and it is the residue of totalizing `ConsoleChannel` rather than a discovery:
the fallback and every `owned*` helper it feeds are total now, and the value they are
DERIVED FROM is not. `shownGate` opens with `{...gate}` and five bare field reads
(`gate.approvers`, `.allowEdit`, `.take`, `.writes`, `.batch`), and `deliver` reads
`gate.gateId` and `gate.payload` bare — all in the prelude that sits above every `try`, in
the file whose single rule is that delivery has one exit. **Reproduced**, node v24.16.0:

```
GateDispatcher.deliver(log, {get gateId(){throw}, nodeId:"n1"}, {channels:["console"]})
  → THREW Error: summary gateId getter
```

— no delivery, no fallback, no `gate.delivery_failed` row, which is the exact outcome
`ConsoleChannel`'s docstring exists to make impossible, reached one argument along. What is
**UNCONFIRMED** is reachability from inside this process: today's only caller is
`HumanGateBroker`, which passes a summary it folded from the journal, so a hostile getter
needs an embedder driving the exported `GateDispatcher` directly — the same party
`shownGate`'s own "defence in depth for a caller driving the dispatcher directly" already
names. **Fix, exactly:** `readProp` for `gateId` and `payload`, and a `shownGate` that reads
its input's fields the way it already copies them, rather than spreading first. It is an
entry and not an edit because the spread is also what carries fields nobody has added yet,
so replacing it is a decision about `GateSummary`'s growth and not a one-line total-read.

> **REFUTED AS WRITTEN 2026-08-06 — the exclusion is not undiscovered, it is DOCUMENTED AND
> PRICED, and the entry names the smaller half of it.** `run/delivery.ts` carries a block
> headed `THE BOUNDARY` → `WHAT IS DELIBERATELY OUTSIDE IT` → `WHAT THAT EXCLUSION COSTS`,
> which already says "every own property of the summary, because it spreads it" — verbatim
> the fact this entry reports as new — and already measures the case it does NOT mention:
> `deliver`'s other data argument, the `DeliverySpec`, is read just as bare
> (`{channels: "console"}` → `TypeError: names.map is not a function`, out of the same
> prelude, zero journal rows, no fallback).
>
> So the entry is both **redundant** (a stated limit re-filed as a discovery) and
> **narrower than the thing it describes**. Rewrite it as one question — *should
> `GateDispatcher.deliver`'s prelude be inside the boundary at all, for BOTH arguments?* —
> or close it and let `THE BOUNDARY` block stand as the answer. Its UNCONFIRMED half is
> unchanged and is the reason not to rush: today's only caller is `HumanGateBroker`, which
> passes a summary it folded from the journal, so reaching this needs an embedder driving
> the exported dispatcher directly.

### B · Mechanism that exists and is not wired to anything

**B8 · The gate queue's ORDER now reaches four of six surfaces, and the two that are left
cannot reach it at all.** New, and it is what is LEFT of "D7.9 row 5's ordering reaches the
API" — that half is fixed and this half is a `run/gates.ts` change, which is why it is an
entry and not an edit. `gateQueueOrder` is a **pure function of a `RunProjection`** — no
clock, no engine, verified by reading `rankOf`, `radiusCredit` and `gateBatchGroups` — and it
is module-private, reachable only through `HumanGateBroker.list`, which takes a `RunLog` from
an engine that has ATTACHED the run. **The dividing line is not which layer a caller is in;
it is whether it holds an attached run or only a projection**, which is why `loom run` and
`loom gates` print the same list and only one of them can rank it:

| Surface | Order | Why |
|---|---|---|
| `Engine.openGates` | ranked | it *is* `HumanGateBroker.list` |
| `GET /runs/:id/gates` | ranked | **fixed this wave** — the projection's SET joined to the queue's ORDER |
| The console's Oversight panel | ranked | **fixed this wave** — `loadGates` reads `GET /runs/:id/gates` instead of the run summary |
| `loom run`'s awaiting-gate hint | ranked | **fixed this wave** — this process submitted the run, so it is attached |
| `GET /runs/:id`, the SSE `snapshot` frame, every mutation response | **journal** | all go through `summarise`, which takes a `RunProjection` and no engine |
| `loom gates <runId>` | **journal** | a fresh CLI process has attached nothing |

**Reproduced, both halves.** A two-gate graph (two parallel `human_gate` nodes, 900 s and
60 s SLAs, the patient one declared first) over real HTTP:

```
engine.openGates(runId) → ["urgent", "slow"]      GET /runs/:id/gates → ["slow", "urgent"]   (before)
```

and, in a second `Engine` over the same store — which is what `loom gates` is — the
projection folds fine and the queue is unreachable:

```
fresh projection: ["slow", "urgent"]
fresh openGates : THREW E_RUN_NOT_FOUND  run … is not attached to this engine
```

Both halves are driven: *THE QUEUE'S ORDER REACHES THE API* and *A GATE THE QUEUE DID NOT
RANK IS STILL SERVED* in `test/server/http.test.ts`, *THE OVERSIGHT PANEL IS READ FROM THE
RANKED QUEUE* in `test/server/console.test.ts`, and — driving the split itself, so the limit
cannot rot in either direction — *`loom run`'s GATE HINT IS RANKED AND `loom gates` IS NOT* in
`test/cli/cli.test.ts`.

**Fix, exactly:** export `gateQueueOrder` from `run/gates.ts` (or give `list` a
projection-shaped overload) and call it from `summarise` and from `cli.ts`'s `gates` command.
**Do not re-implement the rank at either call site** — that is two ranking functions for one
queue, which agree on the day the second is written; it is the same arrangement A19 names for
`checkedDecision`/`ownedDecision`. The same export also removes the residue inside the fixed
endpoint: a run this process has not attached is ranked by nothing, so after a restart
`GET /runs/:id/gates` is journal order too, and the handler's own comment says so.

**B7 · The gate sweep cannot see a run outside the `limit` most recent, and after a restart
that is a lost SLA. RESOLVED 2026-08-24 with an index, not a read model.**

> `RunFilter.raisedAGate` orders a listing by the most recent `gate.raised` instead of by run id,
> so only runs that have EVER gated compete for the `limit` slots. `GateSweeper` and
> `GET /gates` both use it — which closes A3's own stated reversal ("an open-gate index beside
> `run_head`") in the same change, because it was the same absence.
>
> **AN INDEX RATHER THAN THE `human_gates` TABLE invariant 2 names.** A read model is a second
> source of truth to keep consistent on every append; `CREATE INDEX journal_by_type_global ON
> journal (type, ts)` is additive — an older binary ignores an index it does not know, a newer
> one creates it on open, and there is no migration and no column. The filter is documented as a
> SUPERSET of "has an open gate" on purpose: openness is a property of the fold, and the sweeper
> folds anyway.
>
> **THE BOUND STILL BOUNDS.** `limit` now caps *gated* runs rather than all runs, so the residual
> hole is a deployment with more than `limit` gates open at once — a set an operator can size
> from their own SLA policy, which "runs created" never was.
>
> **The defect inside the fix, and it is the useful part.** The first version ordered by
> `MAX(seq)`. **`seq` is per-run**: two runs that each gate as their second event both have
> `MAX(seq) = 2`, so ordering by it is a tie between gates days apart. `ts` is the only column in
> that table that compares across runs. Both stores had the bug and both AGREED, which is why a
> per-store test could not have found it and the cross-store conformance test could.
>
> **And the conformance test found it only on the second attempt.** Its first version gave both
> runs a gate as their second event, so `MAX(seq)` tied, the `run_id DESC` tiebreak produced the
> expected answer, and reverting the fix left it green — the test passed for a reason it did not
> claim. It now constructs the case where seq-order and ts-order DISAGREE (r-1 gates earlier at a
> higher seq, r-2 later at a lower one) so the tiebreak never runs. **A test whose two candidate
> implementations agree distinguishes nothing**, and a tiebreak is a very good way to make them
> agree by accident. New, and it is the residue of the fix for B1 rather than a discovery.
`GateSweeper` finds its runs through `StateStore.listRuns(limit)`, which orders by run id
descending — run ids are minted from a timestamp, so that is "newest created first" — and
there is **no read model of open gates** to ask instead. Cursors are kept between ticks, so
a gate met once stays tracked while its run stays in the window; the hole is a **process
restart** on a store where more than `limit` runs have been created since the gate was
raised. That gate's deadline never fires again, silently. Default `limit` is 500
(`DEFAULT_SWEEP_LIMIT` in `run/gates.ts`), settable through `EngineOptions.sweep`.

**Reproduced.** One run parked on a gate with `slaMs: 1000` and a run id sorting last, six
newer runs, a fresh `GateSweeper` (the restart), and the clock 5 s past the deadline:

```
limit=5   → {considered:5, caughtUp:5, swept:0, fired:[]}   gate=open    run=awaiting_gate
limit=500 → {considered:7, caughtUp:7, swept:1, fired:[g_…]} gate=expired run=failed
```

The same store, the same clock, the same overdue gate — only the horizon differs.
**Fix, exactly:** either a `listRuns` ordering by
`last_ts` ascending (cheap — `run_head` already stores it, and the runs that matter are by
definition the ones nobody has written to) or a `human_gates` read model the store can
query. Both are `StateStore` interface changes plus a SQLite migration, which is why the
knob shipped first and this entry exists rather than the knob quietly standing in for the
query. Until then: size `limit` above the number of runs a deployment creates within the
longest SLA it declares.

**B11 · `function` and `evaluator{assertion}` bodies RE-EXECUTE during replay.** `#runFunction`
and the assertion arm compute no effect key and never consult `#replay`, so a replay re-runs them
rather than serving a recorded result. **Narrower than it sounds, and the narrowing is the reason
it is recorded rather than fixed:** after the vm-intrinsics fix a body cannot reach `process`,
`fetch` or the host at all, so on the CLI path its re-execution is pure — except `Math.random()`,
which `SAFE_GLOBALS` leaves reachable while deliberately removing `Date`. A body using it
diverges, and replay **detects** that (`match: false`) rather than serving a wrong answer. An
embedder passing `opts.globals` can hand a body a host object, and that IS a live side effect on
replay.

Fixing it properly means giving a function body an effect key and journaling its output — a
journal schema change and a decision about whether local computation is an "effect" at all, which
`design/loom/`'s four kinds (`model`, `tool`, `subgraph`, `summarize`) currently say it is not.
Not a patch. **Reverses when** an embedder relies on `opts.globals`, or when `Math` is narrowed
the way `Date` already is.

**B10 · A `function` body cannot signal a RETRYABLE failure, so `retry` is unreachable for
function nodes. RESOLVED 2026-08-24 — through the RETURN, and the entry is kept because why a
THROW cannot work is the durable part.**

> A body returns `{ retry: { reason } }` and the engine raises
> `err.unavailable(E_FUNCTION_UNAVAILABLE)` on its behalf, which is retryable by class and so
> reaches `#retryDecision`. Verified end to end: three attempts, two `task.retry_scheduled` rows,
> the third attempt's write landing.
>
> **A THROW STILL CANNOT CARRY RETRYABILITY, and that is structural rather than unfinished.**
> `isLoomError` is an `instanceof` against the HOST class, which a guest object can never
> satisfy, and `toLoomError` deliberately declines to read a `class` off injected code — that
> read is the hazard A1, A18 and A21 are all about. A RETURN crosses through `intoHostRealm`,
> which rebuilds it structurally, so no getter of the body's survives to be consulted. The
> asymmetry is the point of the design, not a gap in it.
>
> **No delay field, deliberately.** `#retryDecision` computes the backoff from `(policy, attempt)`
> alone — its own comment says it must, or replay diverges — and a `function` body RE-EXECUTES on
> replay (B11), so a delay the body chose would be re-chosen against a different clock. The graph
> owns the schedule; the body owns the verdict.
>
> **`retry` is exclusive with `writes` and `take`, refused rather than resolved.** A retry re-runs
> the body, so anything it also asked to commit would be proposed twice.
>
> **And a test-harness trap worth the line it costs**: the fold turns `task.retry_scheduled` into
> `retryAfter: e.ts + afterMs` and `eligible()` skips a task while `retryAfter > now`, so under
> this repo's usual frozen `now: () => NOW` a backoff of ONE millisecond never elapses. The first
> version of the test read as "the retry fired once" when the truth was "the clock never moved".

**The original text follows.** Every throw out of the `vm` context is classified `E_INTERNAL` with
`retryable: false` — only the three classes in `errors.ts`'s `RETRYABLE` set (`exhausted`,
`unavailable`, `timeout`) schedule a backoff, and a body has no way to construct one: `SAFE_GLOBALS`
does not expose `err`, and a plain object with `class`/`retryable` properties is not read.
Measured through the binary: a body throwing `{class:"unavailable", retryable:true}` produced
`E_INTERNAL … retryable: false` and the run failed on the first attempt. **Consequence for
testing, which is how it was found:** the `running`-after-backoff state cannot be produced offline
through the CLI at all, so W10's drive loop and exit-code fix are pinned at ENGINE level and the
CLI-level test says so rather than pretending. Fixing it means a sanctioned way for a body to
raise a classified error — which is a seam decision, not a patch.

**B5 · `NodeSpec.timeoutMs` was in the schema and enforced by nothing. THE NODE HALF IS CLOSED;
THE JOIN HALF IS NOT, AND THAT IS WHY THIS ENTRY SURVIVES.** `run/engine.ts` reads
`w.node.timeoutMs` and raises `E_TASK_TIMEOUT` against it, so the original sentence — *"a node
with a declared timeout runs as long as it likes; `E_TASK_TIMEOUT` is declared and unraisable"* —
is now false in both of its clauses, and `E_TASK_TIMEOUT` has left `NEVER_RAISED`. It stood in
this register unchanged for long enough to be quoted as current. **Do not delete the entry: the
paragraph below is still true, and deleting a two-part entry because one part closed is how the
other part stops being tracked.**

**`JoinNode.timeoutMs` is the half that is still inert, and half of THAT is fixed the cheap way.**
`#maybeFireJoin` decides on `branches`, `mode` and `k`; `#foldJoin` on `onBranchError`;
neither reads a clock, nothing in `src/` reads the field, and `E_JOIN_TIMEOUT` is in
`NEVER_RAISED`. It was **required** by the type, so every author wrote a number that decides
nothing — the "looks supervised" shape, one field over from the gates that refuse it. It is
optional now, and says so in its own docstring, which is as far as a type change can go: the
deadline itself needs lease reclaim to be worth building, because a branch held by a dead
worker is what actually strands a join under multi-process workers and a timer would fire
against a task nobody is running. **Reversal is written into `spec.ts`**: when the deadline
lands, the field becomes required again, `E_JOIN_TIMEOUT` leaves `NEVER_RAISED`, and this
paragraph goes with it. `JoinNode.drain` was deleted outright for the same reason with none
of the nuance. It meant *keep non-arriving branches running after the join fires*, and the
runtime does exactly that, unconditionally: a short-circuiting `any` or `quorum` join fires
and the stragglers run to completion with no `task.cancelled` appended anywhere (C1). Its
default was `drain: false`, so **the DEFAULT was the value that lied** — every graph that
never mentioned the field asked for cancellation and got none. A field whose only honest
value is the one nobody writes cannot be salvaged by refusing the other one; it returns with
straggler cancellation, in one change.

**B6 · Hooks were declared, validated by the compiler, pinned by the resolver, and never
invoked. RESOLVED — and the entry's second sentence went stale with it.** `#hooksFor` dispatches
at six points in `run/engine.ts` (`preNode`, `preTool`, `onGate`, `onError`, `onComplete`, and
the shared arm), `resources/hook-loader.ts` loads a body into the same hardened `vm` realm a
`function` body runs in, and `hook.applied` **has an appender**, so it has left `NEVER_APPENDED`
— which is why C1's count below is seven and not eight.

> **What is left of it is one specific thing, and it is not the invocation.**
> `HookLoaderOptions.pins` is accepted and never supplied: `cli.ts` builds the loader with
> `{ store }` alone, so the manifest-digest branch is unreachable through `bin/loom` and a
> promotion between compile and execute swaps a hook body under a live run.
> `FunctionLoaderOptions.pins` is the identical omission one file over, and A24 is the same seam
> for a third content kind. **One seam, three kinds — fix them together or the claim rots
> again.**

**B9 · Compensation is a compile-time proof and a rewind refusal; nothing ever executes
one.** `compensation` is a first-class `EdgeKind` with its own compile rule (`GRAPH012`), its
own ancestor and entry-node handling, and a rewind refusal — and **no code path can emit
one**. `#edgesToTake` breaks on `compensation`, and the only other arm, `#errorEdges` (the
failure path, the one path that could take one), filters `kind === "error"` alone.
`Engine.cancel(runId, reason)` has no `compensate` and no `gracePeriodMs`. Reproduced on the
real incident-triage graph with a throwing `k8s.restart` and a recording `k8s.rollback`: no
Task was ever created for the rollback node, the run took the error edge, and it ended
**`succeeded`** — an irreversible restart attempted, failed, uncompensated.

Two halves are already closed, so this entry is the residue rather than the whole thing.
`onBranchError: "compensate"` is now a **compile error** instead of a silent alias for
`"skip"` (it was byte-identical in behaviour: two run summaries `deepEqual`), and `GRAPH012`
now requires the declared compensation to name a REGISTERED tool, because the rewind refusal
reads the field's presence — so `compensation: {tool: "noop"}` bought a legal rewind that
undid nothing. `test/graph/compensation-honesty.test.ts` holds both.

What it still buys, and the only reason to keep declaring one: `Engine.rewind` refuses
(`E_RESTORE_ILLEGAL`) to cross a committed irreversible effect whose tool declares no
compensation. What it costs to build for real: reverse-commit-order tracking, a
`Compensating` member in `RunStatus`/`TaskState` (neither has one), and `cancel{grace,
compensate}`. That is a feature. The design corpus was corrected to describe the declaration
rather than an executing saga — 02-EXECUTION-GRAPH D5.2 is the one authoritative paragraph
and 01, 03 and 04 point at it. **The two `validate.ts` comments this entry named as "the next
thing to fix" are gone**; the file now says *"NOTHING TRAVERSES ONE."* and its remaining mentions
of the error path describe what `kind === "error"` does, which is accurate. Cross-reference: C1's
`task.skipped`, which is what `onBranchError: "skip"` cannot journal either.

### C · Vocabulary that is declared and never written

**C1 · Six event types have no appender** — `task.cancelled` left with the E6 fix, and this
count has now been wrong twice in one week, which is why the entry says COUNT IT., and this entry said EIGHT until `hook.applied`
gained one with B6 — **count it rather than quoting it**, exactly as C2 says of its own number:
`grep -an 'type: "' packages/core/test/docs-drift.test.ts`. Pinned in `docs-drift.test.ts`'s
`NEVER_APPENDED` with a reason each: `budget.reserved`, `budget.settled`, `channel.written`,
`config.reloaded`, `task.cancelled`, `task.skipped`, `task.started`. **Five of the seven are
read by a fold that no writer feeds** — `projection.ts` folds `budget.reserved`,
`budget.settled`, `channel.written`, `task.skipped` and `task.cancelled`, and `trajectory.ts`
and `spans.ts` fold the last two as well — so the dead code is on the READING side, which is
where it is hardest to notice. `task.started` and `config.reloaded` are dead in both
directions. The two
that matter most: `budget.reserved`/`budget.settled` are held in memory by `PolicyEngine`, so
D6.5's assumption that a crashed worker's reservation is recoverable by folding is false and
`RunProjection.reservedUsd` is **permanently zero**; `task.cancelled` means in-flight Tasks
keep whatever state they last had after a cancel, and the `task.cancelled` arm of `spans.ts`
is unreachable. Each is a decision someone must take: append it, or delete it from
`EVENT_TYPES` and from the paragraphs that promise it.

**C2 · Eleven error codes are declared and raised by nothing.** Pinned in `NEVER_RAISED`, whose
membership the guard checks as EXACT — so this number is a measurement, not a claim, and it moves
when a code gains a thrower. It read "thirteen" while the registry held twelve, and then eleven
once `E_TASK_TIMEOUT` gained one. Count it rather than quoting it:
`grep -acE '^  "E_' packages/core/test/docs-drift.test.ts`.
A `retry.onlyIf` written against any of them can never fire. `E_ADMISSION_REJECTED` heads a
three-level admission design with nothing under it; `E_LEASE_LOST` is A2; `E_TASK_TIMEOUT` is
B5.

**C3 · `E_QUORUM_UNREACHABLE` is misnamed.** Declared under gate-quorum framing; its one
raise is a **join** with `onBranchError: "fail"`. Two unrelated meanings on one code, and
quorum itself is a compile error (D1).

### D · Documentation that is wrong or unverified

**D1 · The promotion gate was described as stronger than it is** — corrected in this pass,
recorded here because **the code gap is real and unfixed**. `06-EVOLUTION.md` D10.d used to
claim criterion 2 is McNemar's paired test with a 95 % lower bound; `gateCandidate` computes
`candidate.passRate − baseline.passRate ≥ −margin`, a bare point-estimate comparison.
Criterion 3 said "median cost"; the code divides one suite total by another and `EvalReport`
has no median field. Criterion 7 claimed injection-resistance cases are required;
`gateCandidate`'s safety check filters case reasons for the substring `irreversible` and
nothing else, and `EvalCase.expect` has **no field in which a suite could declare an
injection case**. All three verified by reading `evolution/gate.ts` end to end, and
re-verified 2026-08-05. **This is the gate that stops self-evolution shipping a regression**,
so it is the most consequential gap on this page.

> **The correction landed in the design file and left three copies behind in the source it
> was read out of** — which is the same failure one layer down, and is now fixed.
> `gate.ts`'s module docstring asserted "the suite is authored by humans, never by the
> evolution engine", the rule M9 replaced and which 06-EVOLUTION.md's own D10.f header note
> names as contradicted (D2); `maxCostRatio`'s JSDoc said "median cost"; and `gateCandidate`'s
> docstring said "the eight criteria from D10.d" while the function pushes **eleven**
> (`grep -ac 'id: "' packages/core/src/evolution/gate.ts`) — a count `99-DOD.md` row 8
> already called out. **When a document is corrected against a file, grep that file for the
> claim you just refuted.**

The table now describes the arithmetic; closing the gap means carrying the
per-case pass/fail vectors into `PromotionInput` and computing the discordant-pair statistic
(arithmetic only, no dependency), adding `medianCostUsd` where `p95WallMs` already is, and
designing a deterministic injection-resistance verifier — the last being the only one of the
three that is a design question.

**D2 · `06-EVOLUTION.md` D10.f states unbuilt machinery in the present tense.** Its
Mitigation column reads as if a drift detector, a diversity floor, a 5 % holdout, a per-node
prompt-token ceiling, a previous-prompt control arm, suite/synthesis disjointness enforcement,
auto-deprecation, a posture-diff journal and a posture SLO dashboard all run. None exists;
most guard synthesis and canary, both `DEFERRED-v2`. A header note now says so and lists what
*is* built, but the table body is unchanged — a reader who skips the note will still be
misled. One row is worse than unbuilt: reward hacking cites "the eval suite is
human-authored", which D10.d itself replaced in M9.

**D3 · `99-DOD.md`'s **PROVEN** cells are largely unaudited.** No longer UNCONFIRMED: two
were audited on 2026-08-15 and **both were overstated**, which is a rate that says something
about the other thirty-odd.

- **Row 3.1** read "`kill -9` with a gate open, resumed from a new process". At the time of
  the audit no such test existed anywhere in the tree; what existed was `skeleton.test.ts`
  row 6 — `store.close()` and a second `Engine` **in the same OS process** — and a clean
  close is, as the last connection in WAL mode, a checkpoint that removes the `-wal`/`-shm`,
  so the reopen never reads a hot WAL. **The missing test then landed** 2026-08-15
  as `restart-crash.test.ts`, D12 is closed, and row 3.1 is now **PROVEN**
  citing that path. Note the sequel, because it is the same defect twice: for a day the
  corpus asserted BOTH — 08-PLAN row 6 said proven, 99-DOD said "no such test exists" — and
  the second correction had to be made in a different file from the first. What row 3.1 still
  does **not** claim is the SLA clock; the skeleton gate declares no `sla`, so that half is
  `gate-clock.test.ts`'s and is split out in 08-PLAN row 6.
- **Row 1** cited "16 edges → 24 interfaces". That string appears in exactly one place in the
  corpus: the cell itself. Nothing derives either number from D2 or D3. The clauses that ARE
  tested (the taxonomy is eight; all eight execute) are kept and the count is deleted, and the
  row is PARTIAL.

`test/docs-drift.test.ts` now also fails if a DoD cell cites a test file that does not exist.
That closes the RENAME and not this class — row 3.1 named no path, so nothing mechanical would
have caught it. **The remaining PROVEN rows are still unaudited, and the two data points say
the way to audit one is to go and look for the test, not to read the sentence.**

**D4 · The performance numbers have not been re-measured. UNVERIFIED.** `99-DOD.md`'s
coverage matrix quotes compile 61 ms, layout 0.95 ms, a 485 KiB snapshot, a 3 ms 10k-event
fold and a 126 ms 500-way fan-out. They are machine-dependent, have no tripwire, and were
not re-run. Binary and bundle size are a separate case and are NOT unverified: row 6 quotes
114.6 MB and 364 KB, and those come from the build's own output on the rebuild described in
*Where things stand*, so they are as fresh as that rebuild and no fresher.

**D5 · `05-RESOURCES-OBSERVABILITY.md`'s span-attribute delta table is hand-maintained.**
Every row was verified by hand against `telemetry/spans.ts` and is accurate today, and there
is deliberately **no** tripwire — a regex over `spans.ts` recovers only the quoted half of
the attribute keys and would report that half as the whole, which is the crying-wolf failure
the guard file calls fatal. It will rot on the next `spans.ts` edit. The tractable fix is a
fixture journal folded through `spansFrom`, whose coverage is itself proved by asserting it
contains all 48 `EVENT_TYPES`.

> **Re-verified 2026-08-06, against the `spans.ts` edit described in A17 and A18**, which is
> the first test of "it will rot on the next edit" since that sentence was written. It did
> not: no attribute name was added, renamed or removed — `branch.item_channel` is still the
> only conditional one on `loom.task`, and it is now emitted from a total read rather than
> from `binding === undefined`. **The re-verification is by hand, exactly as the entry
> warns**, and is worth no more than the next one.

**D6 · The drift guard checks names in MARKDOWN, not behaviour.** A span renamed in
`spans.ts` *and* in the document drifts together and passes. Nothing asserts the eight span
names against a trace derived from a real run. Same fixture-journal fix as D5.

**D7 · Two bypasses of the drift guard remain open, by choice.** Confusable homoglyphs (a
Cyrillic `о` in `loom.run` hides a claim for one keystroke) cannot be closed without a
confusable-skeleton table that would be a runtime dependency or larger than the guard.
Emphasis inside the *first* segment of an unknown identifier is now silent, traded
deliberately against manufacturing names nobody wrote. Both are pinned by tests that fail
when the hole closes, which is the right shape for a documented limit.

**D8 · The `why` prose in the guard's own registries is unverified.** `NEVER_APPENDED` and
`NEVER_RAISED` carry a sentence per entry explaining the consequence; a handful were
spot-checked and the rest are prose nothing enforces. One is already stale:
`task.cancelled`'s reason says "`cancel()` appends `run.cancelled` only", which stopped
being true when `cancel` learned to append `gate.cancelled`. Re-checked 2026-08-05 and still
true of both halves — the reason still reads that way in `docs-drift.test.ts`'s
`NEVER_APPENDED`, and `Engine.cancel` still calls `cancelOpenGates`.

**D9 · `01-INTERFACES.md` D3.10 simplifies types a reader may take literally** — it shows
`payload: unknown` where the code has `EventPayloads[K]`, and a string union where the code
has `Classification`. Intentional simplification, recorded so nobody "fixes" the code toward
the document.

**D10 · Cross-references into this register. RESOLVED — kept for the grep.**
Seven citations named ids that meant something else. Six lived in `design/loom/` and were
repointed on 2026-08-05 (`C3` → A2, three `C1.4` → B1, two `C1` → B1–B3). The seventh —
`// E_LEASE_LOST … see REGISTER C3.` in `docs-drift.test.ts`'s `NEVER_RAISED` — survived that
pass because it is in `test/`, and the grep that found the others was run over `design/loom/`
alone. It now reads **A2**. (That is not pedantry: the first draft of this entry claimed the
count was zero, which the grep it prescribes immediately refuted.)

**AND CLOSING AN ENTRY BREAKS ITS CITATIONS, which is this hazard's second half and the one
that bites in the other direction.** Deleting `B1` and `B2` when the sweep landed left four
documents pointing at ids that no longer exist — the same broken link, arrived at by fixing
something rather than by mistyping something. **Run the grep below BEFORE deleting an entry,
not after**, and repoint or rewrite every hit in the same change. Live citations as of the
last such pass: `01-INTERFACES.md` → A2 and B7, `04-OVERSIGHT.md` → A10,
`docs-drift.test.ts` → A2, plus `08-PLAN.md` and `99-DOD.md`, whose `B1`–`B3` spans still
need repointing by whoever closes the `bin/loom` wiring. Re-derive rather than believing that
list.

The entry stays because the *lesson* is the durable part, and it is a small one with sharp
edges. **Find every one of them, in any tree, with**

```bash
grep -aroE 'HANDOFF(\.md)?.{0,12}\*{0,2}[A-E][0-9]+' design packages scripts
```

— note `-a`, without which macOS `grep` silently skips the source files containing `→` or
`·`, and note the search roots: a cross-reference does not care which tree it lives in, and
scoping the grep to `design/` is precisely how the seventh one survived a pass whose whole
purpose was finding it. The guard cannot catch this class at all; it tracks span names, error
codes, `GRAPH` ids, method names and event appenders, not register ids.

**D11 · The sanctioned way to satisfy invariant 4 does not exist, and there is no typecheck
between the author and the failure. THE `random` HALF IS CLOSED 2026-08-24; the rest stands.**

> **`Math.random()` in a `function` or `evaluator{assertion}` body is now a journaled effect.**
> The engine draws a seed per task under `effectKey(taskId, "random", 0)`, appends
> `effect.started{kind:"random"}` + `effect.completed`, and the loader's bridge builds the realm's
> `Math.random` from it — so replay serves the recorded seed and the body draws the identical
> stream. `effect.started`'s `random` kind finally has an appender.
>
> **A SEED AND NOT A VALUE PER DRAW**, because a body runs synchronously inside
> `vm.runInContext` under a per-call timeout and cannot await an append between two draws. One
> recorded number reproduces the whole stream.
>
> **What building it cost is the part worth keeping, because none of it was visible from the
> decision.** Five interactions, each found by running:
> 1. **Span counts.** The first version returned early on replay like `#summarizeEffect` does,
>    leaving the shadow journal two events shorter per body — 44 spans against the original's 46.
>    The MODEL path's shape is the right one: serve the recorded value, then journal it anyway.
> 2. **`effect.completed-once-per-attempt`.** A rewind that re-runs a task re-drew and re-appended
>    under one key in one attempt. The fix is not in the auditor — which already discounts a
>    rewind through `suppressedRanges` — but here: if `startedEffects` still holds the key, the
>    recorded seed is reused and nothing is appended. That is exactly what `ids.ts` means by a key
>    that "dedupes for free", applied to the least idempotent operation there is.
> 3. **`onGraphChange: "allow"`.** A CANDIDATE graph's new node has a taskId the recording never
>    held, so `require` threw `E_REPLAY_DIVERGENCE` and every eval-suite replay of a graph with a
>    new `function` node failed. `seedFromKey` derives one from the key instead — a model or tool
>    result cannot be invented, a seed can, and deriving keeps the candidate's own replay
>    reproducible.
> 4. **`digest` is prefixed.** `seedFromKey` sliced from 0, handed `parseInt` the string
>    `"sha256:c"`, got `NaN`, and surfaced three layers away as
>    `CanonicalizationError: non-finite number NaN` — a message naming neither the seed nor the
>    key. It now throws where it happens.
> 5. **A guest `Error` is not a host `Error`.** The refusal test's first predicate used
>    `e instanceof Error` and failed: the bridge builds its throw from the guest realm's
>    constructor. The same boundary that stops a body reaching `process` stops its throws being
>    host errors, which is why `toLoomError` normalizes every guest throw to `internal`.
>
> **And the evaluator arm was untested, again.** A mutation removing the seed from
> `#runEvaluator`'s `assertion` arm left all 2001 tests green — the SAME arm that kept the
> `requireOutcome` defect one wave earlier. `functions.require` has two callers; ask which of them
> a test actually drives, not merely which of them the fix touched. CLAUDE.md's invariant 4 and four design documents told
authors to route all nondeterminism through `ctx.effect(key, fn)`. **`ctx.effect` has never
existed in this repo**, and neither has `ctx.random()`. Reproduced: a `function` resource
written exactly as `00-OVERVIEW.md:136` instructs, invoked with the verbatim context
`Engine.#runFunction` builds, throws `TypeError: ctx.effect is not a function`; `ctx` has
three keys, `now`, `signal`, `taskId`. A function resource's body is source text compiled by
`vm.runInContext`, so the documented call reaches the runtime unchecked — and the thrown
error is cross-realm, so `e instanceof TypeError` is false in the host.

The real boundary is `effectKey(taskId, kind, ordinal)` inside `Engine`, with kinds `model`,
`tool`, `subgraph`, `summarize`. **Three separate gaps sit inside that one sentence**, and
the doc fix (CLAUDE.md, D9.5 row 5) closes the sentence, not the gaps:

1. `effect.started` declares `clock` and `random` kinds that **nothing in `src/` appends**.
2. `FunctionContext.now` is the engine's injected clock passed straight through. Calling it
   journals nothing and `#runFunction` has no replay branch, so a body that reads it executes
   live on replay and gets a different answer than the run being replayed — **unmarked**.
3. `SAFE_GLOBALS` sets `Date: undefined` and passes `Math` through **whole**, so
   `Math.random()` — banned by invariant 4's own second sentence — runs unrecorded inside the
   one place the ban was supposed to be total. There is no publish-time lint rule; `08-PLAN`
   R4 lists one as a mitigation.

Closing it is a recorded clock effect plus a seeded PRNG in the sandbox context, at which
point `ABSENT_CONTEXT_METHODS` in `docs-drift.test.ts` goes red and tells you which
paragraphs to rewrite. **Do not "fix" this by adding a `ctx.effect` that wraps nothing.**

**D12 · A test now kills a process. CLOSED 2026-08-15.** This entry read "No test
kills a process", and it was true until the fixture it describes landed in tree:
`test/run/restart-crash.test.ts` plus `test/run/restart-crash.child.ts`. The child advances
the skeleton to its gate and announces `gated` **after** the raising append has returned, so
the kill is ordered by a message rather than by a timer; the parent `SIGKILL`s it, asserts the
exit *signal* was `SIGKILL` — killed, not asked to stop — and asserts `journal.db-wal` and
`journal.db-shm` are still on disk. That pair is the whole point: a clean `close()` is the
last WAL connection, so it checkpoints and removes both, and every earlier "restart" test read
a tidied file. A second process then opens the store, `attach`es, recovers `awaiting_gate`
with the same open `gateId`, approves, and asserts the deferred `fs.write` ran exactly once. A
sibling test performs the clean close as the control, so the `-wal` assertion is pinning
something rather than restating a default. The shape held: the fixture is a `.child.ts` so the
`packages/*/test/**/*.test.ts` glob does not run it directly, and both the `rmSync` and a
`SIGKILL` of the child sit in a `finally`, so a regression costs a failed test and not a hung
suite.

**`99-DOD.md` row 3.1 is corrected too** — it is **PROVEN**, citing `test/run/restart-crash.test.ts`,
which `docs-drift.test.ts`'s "EVERY TEST FILE THE DoD CITES AS EVIDENCE EXISTS" check now pins.
It briefly said "No such test exists" while 08-PLAN row 6 said the opposite, which is the
duplicated-claim failure this register keeps recording: one copy corrected, the other left
standing in a different file.

**What this fixture does NOT prove, and 08-PLAN row 6 now says so:** the SLA clock. The
skeleton's `approve` node declares no `sla` block, so there is no deadline for the crash to
preserve (`grep -aic sla` over both crash files: 0). The clock-across-restart evidence is
`test/run/gate-clock.test.ts`'s *"THE SWEEP REACHES A RUN THIS PROCESS NEVER ATTACHED"* — a
fresh `Engine` over the same `MemoryStateStore`, which is a restart of the engine and not of
a process. Anyone extending this fixture: giving the skeleton gate an `sla` would let one
test carry both halves, and that is the obvious next edit.

**D13 · A ROUTER CAN NAME ANY EDGE IN THE GRAPH, and four documents used to imply it
cannot.** The closed-set check `E_ROUTE_INVALID` performs is the HUMAN GATE's and only the
human gate's: `Engine.#applyGateDecision` filters `gate.take` against that node's declared
`outbound` and fails the Task. A router's `cases[].take` and `fallbackEdge` are checked at no
phase. Reproduced against this tree by compiling three mutations of the D5.5 fixture
(`test/graph/fixtures.ts`'s `incidentTriage()`) through the shipped `compile()`:

| Mutation of `choose_path` | Result |
|---|---|
| `cases[0].take = ["does_not_exist_anywhere"]` | `ok: true`, no diagnostic |
| `cases[0].take = ["e8"]` — `apply_remediation → verify`, another node's edge | `ok: true`, no diagnostic |
| `fallbackEdge = "nope"` | `ok: true`, no diagnostic |

The second is the live one. `#activate` resolves every id against `ctx.index.edgeById` — the
whole graph's edge table — so that router jumps `approve_remediation` (a `human_gate`) and
`apply_remediation` (the irreversible `k8s.apply`) and readies `verify` directly. It is the
same bug `#applyGateDecision`'s own comment records having fixed for gates, still open one
node type over. The first and third are silent no-ops that strand the run: `if (e ===
undefined) continue;`.

Evidence that nothing checks it: `grep -an '\btake\b' packages/core/src/graph/validate.ts`
returns one hit, `routerExclusive` (a `GRAPH010` helper), and `fallbackEdge` appears nowhere
in that file. The fix is a `GRAPH005` sub-code asserting `take ∪ {fallbackEdge} ⊆
outbound(node)`; it is also one of the three costs `RouterNode`'s docstring lists for
building `mode: model`, so build it once and both are paid. **D5.1 in `02-EXECUTION-GRAPH.md`
now states this gap;** it briefly stated the opposite — *"nothing — model or human — can name
a target the graph did not declare"* — in the very edit that was correcting D5.1's other
false claim.

**D14 · `run/gates.ts` cites a `GRAPH014` rule that does not exist, in the comment above the
one arm that could auto-approve.** Above `#fireTimeout`'s `default_action` branch:

> `// A timeout can never auto-approve an irreversible action: `defaultAction` is`
> `// rejected at compile time (GRAPH014) for those classes, so if one is present`
> `// here it has already been proven safe.`

Both halves are false. `checkSla` refuses a non-`escalate`/`fail` `onTimeout` for **every**
class and inspects none of them, so there is no class-conditional rule to have proved
anything; and that arm is reachable only from `HumanGateBroker.raise` (or `rehydrate`) with a
caller-supplied `defaultAction`, which passes `assertDefaultActionIsSatisfiable` — decision
kind, `mirrorOf`, `allowEdit` channels — and no irreversibility check at all. So a
`defaultAction` present at that line has **not** been proven safe; nothing on its path could
have proved it. The comment is where the doc's version of the claim came from, which is why
it is registered rather than just deleted from the docs: `02-EXECUTION-GRAPH.md` Deviation 4,
`04-OVERSIGHT.md` D7.2's YAML, its gate-FSM note, D7.9's mitigation paragraph and D7.9's
dedupe blockquote all carried it, and all five now say what is enforced. Fixing the comment
is a `src/` edit and is not this file's to make. Either delete the safety rationale, or build
the class check the comment assumes and make it true.

### E · Process and build state

**E1 · The surface pin. RESOLVED 2026-08-05, and re-pinned once more 2026-08-06 — kept for
the rule.** The fail-open wave added exactly **two** deliberate exports, `gateDecisionOf` and
`isSyntheticSubject`, both predicted in the plan before the code was written and both
reviewed against the final shape. `GateDecision` and `GateDecisionKind` MOVED from
`run/gates.ts` to `vocab.ts` and the guard reported no change at all, which is the right
answer and worth knowing: the pin is over NAMES reaching the barrel, not over the file that
declares them.

The rule is the durable part. **The count of added exports must be read from
`node scripts/check-surface.mjs` and from nowhere else** — this entry was written asserting
25 while the guard printed 26, which is the register miscounting the one number whose whole
purpose is to be counted by a program. Adding an export is fine; it just has to be
deliberate, and re-pinning is a separate commit-worthy act rather than a side effect.

**E2 · Every wave is uncommitted. RESOLVED 2026-08-06 — kept for the one fact worth
reusing.** The ten hardening waves are one code commit (code + design docs + `surface.json`) and one docs
commit (`JOURNAL.md` + this file). **They could not be split the other way**: the split was
tried before it was asserted, and `docs-drift.test.ts` couples `design/loom/*.md` to `src/`
— stashing all of `design/loom/` and running the guard fails on `01-INTERFACES.md` not
documenting `CallbackRequest`/`CallbackDecision`. `JOURNAL.md` is excluded from the guard's
corpus by construction and `HANDOFF.md` happened to pass, which is why exactly those two
could be a second commit. **A code-only commit in this repo is red by design**, and that is
the guard working rather than a packaging problem.

**E3 · Two transient failures were observed and could not be reproduced. UNCONFIRMED.**
During this closing pass, `npx tsc -p packages/core/tsconfig.test.json` once reported
`Property 'openToEveryCaller' does not exist on type 'ControlPlane'` and
`test/server/http.test.ts` once failed the matching assertion with `actual: undefined`. Both
were clean on every subsequent run (typecheck twice, that file four times, the whole suite
three times). The likely explanation is benign — `src/server/http.ts` was being written while
the check ran, and its mtime confirms an edit minutes later — but it is recorded rather than
dismissed, because "it passed the second time" is exactly how a real flake gets filed as
nothing.

> **A third sighting, 2026-08-18, and it is the same shape.** One `npm run check` reported
> `1697 pass / 1 fail` and the name of the failing test never reached the filtered output;
> **seven consecutive runs afterwards were green** (`npm test` ×3, `npm run check` ×4). It
> followed a `check-surface.mjs --write` in the same shell, so the suspicion is again the
> documented one — `tsc -b --force` re-emitting `dist/` under a reader — rather than a defect
> in any test. What makes this worth a line rather than a shrug: the failing test's NAME was
> lost, because the grep that read the run filtered for `^✖` and the summary only. **Capture
> the whole output when a gate fails**, or the next sighting is as uninformative as this one.

> **A FOURTH SIGHTING, 2026-08-24, AND THIS ONE WAS CAPTURED.** The previous entry's whole
> ask — *capture the whole output when a gate fails* — was followed, so for the first time E3
> has a failing assertion rather than a count. One `npm run check` reported `3566 tests / 1 fail`
> in `test/cli/cli.test.ts`, in **"`loom serve` SAYS which perimeter it has, including the second
> hole"**:
>
> ```
> expected: /CALLBACK ROUTE OPEN/
> actual:   "! NO MODEL ADAPTER — the only registered adapter is the offline mock, …"
> ```
>
> So `s.err` held the FIRST stderr warning the child wrote and not the later one — a truncated
> read of a child process's stderr, not a wrong assertion. **That contradicts a claim written in
> the test beside it**: *"Stopped BEFORE asserting: `stop` waits for the child's pipes to drain,
> so what is read below is everything the process wrote and not a prefix of it."* `stop()` awaits
> `close`, which is documented to fire after every stdio pipe drains, so either that guarantee is
> weaker than the comment believes or the child never wrote the line. **The two hypotheses are
> distinguishable and neither has been tested**: have `serving` wait for a known-last STDERR line
> the way it already waits for `  clock:` on stdout — the same fix, one pipe over, that the
> helper's own docstring says cured a one-in-three flake before.
>
> **It did not reproduce: 24 clean runs since** — that file alone ×12, `npm test` ×8 (tap
> reporter, so a failure would print `not ok <name>`), `npm run check` ×4. Recorded at this
> length because the sighting is cheap to lose and the next one may not be captured. The lead is
> the stdout/stderr asymmetry in `serving`, and it is a lead rather than a diagnosis.

**E4 · Guards with no test come in THREE kinds, and only one of them is a defect — and
every count in this entry is a measurement, stated with the command that produced it.**
The eight below cannot have a test: each was reverted and the suite re-run, each left it
green, and in each case a test would have to assert that two spellings of the same outcome
are the same outcome. They are documentary defensiveness worth keeping — **read this list
before "closing" one of them with a test, and before deleting one as dead.** The other two
kinds are the *equivalent mutants* (the mutated code computes the same answer, so no
observer anywhere can distinguish them) and the ones that merely *were not* tested; the
arithmetic note at the end separates all three and says how.

- `#fireTimeout`'s `default_action → fail` degradation. The branch it feeds already requires
  a default action, and `#expire` writes the literal `"fail"`.
- `oldestOpenGate`'s `raisedAtSeq` ordering. It cannot disagree with map order on any
  journal-folded projection.
- `#commitForOpenGate`'s open-gate re-read, and its terminal-run check. **Both became
  unobservable in the change that merged the default action's two appends into one**; before
  that, the expiry of a refused default action was taken at a seq the same call had written,
  and the re-read was the only thing refusing it (`gate-clock.test.ts`'s *A REFUSED DEFAULT
  ACTION…* carries the history). Every `atSeq` reaching that method is now the sweep's own
  fold, so the store's compare-and-swap arbitrates every case: if the gate's state changed,
  an event was appended, so the head moved and the swap fails. The difference the guards buy
  is a quiet `undefined` instead of a thrown `E_SEQ_CONFLICT`, and `sweepTimeouts` treats
  both as "not fired". They stay because they are the METHOD'S CONTRACT — "commit only while
  the gate is still open, and never onto a terminal run" — which the next caller to supply an
  `atSeq` read after a write of its own will need and should not have to re-derive.
- `sweepTimeouts`' per-gate `gate.state !== "open"` re-check. A cheap pre-filter: every path
  behind it ends at `#commitForOpenGate`, which refuses the same case, so the outcome and the
  `fired` list are identical either way.
- `reconstructGraph`'s `s.name !== "loom.task"` skip. It is a scoping statement — *the graph
  that executed is the set of Tasks that ran* — and no other span carries a `task.id` or an
  `edges.*` list. `loom.gate` does carry `node.id`, but only ever the node of the Task that
  raised it, which the task span already contributed.
- `spans.ts`'s `close` on an already-closed span, and `attr`/`note` on one. All three write
  into a value nobody reads, so no observation distinguishes them. These were named "in
  spirit" by the previous arithmetic note and are now on the list proper, having survived the
  sweep below on their own.
- `spans.ts`'s redaction of `links`. `SpanLink.attributes` is never populated — D9.1's
  producer-Task links are designed and unbuilt — so there is no bag to redact and nothing to
  observe. It is on the list rather than deleted because the arm's own docstring makes the
  argument: it is the difference between a hole that is closed and a hole that reopens the
  day somebody writes the feature. **It leaves this list the moment a link carries an
  attribute**, and that is the test to write in the same change.
- `server/http.ts`'s `gateOf` in `#refuseUnidentifiedApproval`. It replaced a bare
  `p.gates[gateId]` on a key that comes off the URL, and NOTHING OBSERVABLE CHANGED:
  `HumanGateBroker.resolve` has called `gateOf` since it was written, so
  `POST /runs/:id/gates/__proto__` answered `404 E_GATE_NOT_FOUND` before the swap and
  answers it after — measured, along with `constructor` and `toString`. What the swap buys
  is that the file no longer contains the lookup `gateOf`'s own docstring exists to replace,
  in the one function whose stated job is being the FIRST line for a graph that names
  `(unidentified)`. **It leaves this list the moment that function stops having a second
  line under it** — i.e. if anything ever calls it without `resolve` behind it.

The same sweep found SEVEN guards that were unheld and could be held, and they are now
pinned: the `__proto__` gate id in `projection.ts` (two conditions, one test), the
`gate.escalated` missing-gate drop, `RunFolder`'s `lastSeq` skip and its non-numeric marker
range, `spans.ts`'s start-once and its `headRatio >= 1` short-circuit, and `StateView.get`'s
read allow-list. **The method is the point, not the list**: revert one condition, run the
whole suite, count what turns red.

**A LATER SWEEP OVER `run/gates.ts` FOUND TWO MORE OF THE SAME KIND, and the way each was
MISSED is the reusable part.** Both are now pinned in `test/run/gate-saturation.test.ts`.

- `resolveBatch`'s terminal-run check. It had a test named for it — *A BATCH ON A RUN THAT
  HAS ENDED IS REFUSED* — **which passed for a different reason**: `Engine.cancel` closes
  every open gate, so the batch was empty and the "every gate is already resolved" arm threw
  first, with the same `E_GATE_ALREADY_RESOLVED` the check itself throws. One code, two
  refusals, and the test could not tell them apart. Deleting the check left the whole suite
  at **1223 pass / 0 fail** while `resolveBatch` decided two gates on a `failed` run and
  walked two Tasks back to `ready`. The state that reaches it is an EXPIRY, not a cancel: a
  gate expiry fails the run and leaves every sibling gate open. **A test named for a guard is
  not evidence that it reached the guard — the way to find out is to delete the guard.**
- `decisionOf`'s `default:` arm, which refuses a `decided` gate whose journaled `decision` is
  in no vocabulary. Its own test's docstring CLAIMED the arm was held by it: "it turns red on
  `decisionOf`'s `default:` arm answering `{kind: "approve"}` instead of `undefined`". It did
  not — the two closings that test drives are `cancelled` and `expired`, which the state
  conjunct rejects before `decisionOf` is called. With the arm mutated the suite stayed at
  **1223 pass / 0 fail**. It is **A19 one layer in**: the unreadable decision would have been
  copied onto a *second* gate by a system actor, in the append that raises it.

**A THIRD SWEEP OVER `run/gates.ts` — 55 flips, one per guard in the D7.9 half — LEFT 21
SURVIVORS, AND THE CLASSIFICATION IS THE OUTPUT.** Same method: one flip, whole suite, diff
the failing SET. Five were real holes and are now pinned in `test/run/gate-saturation.test.ts`;
each was re-run afterwards and turns exactly the named test red.

- **`usableBatching`/`usableDedupe`'s `enabled !== true`.** The one field of either spec
  nothing tested, and the one an author writes when they have thought about a mechanism and
  decided against it. With it deleted, `batching: {enabled: false, …}` MERGED and
  `dedupe: {enabled: false, …}` inherited a decision — a graph that declared the control off
  got it on. *A SATURATION BLOCK THAT SAYS `enabled: false` IS OFF IN THE BROKER…*
- **`sameGovernance`'s `key`, `windowMs` and `maxBatch` conjuncts.** The existing test named
  for the founding-spec rule refuses its joiners for OTHER reasons — one by the cap being
  full, one by the window having closed — so the equality itself was never reached. Without
  the `key` conjunct two DIFFERENT questions (same approvers, same policy, different batching
  key) merge into one manifest that one click closes. *A JOINER THAT DISAGREES ABOUT THE
  POLICY STARTS ITS OWN BATCH, INSIDE THE WINDOW AND UNDER THE CAP.*
- **`batchGovernance`'s unanimity loop.** With it deleted, a batch whose second row declares
  `maxBatch: 2` admits members under the first row's `20` — whoever wrote that journal
  chooses the cap by ordering the rows. *A BATCH WHOSE MEMBERS DISAGREE ABOUT ITS OWN POLICY
  ADMITS NOBODY.*
- **`#inheritable`'s "most recent identical decision".** Reduced to "first match wins", a
  duplicate inherited an APPROVE that a later identical question had already had REJECTED.
  *DEDUP INHERITS THE LATEST ANSWER TO THE QUESTION, NOT THE FIRST ONE FOUND.*
- **`siblingReachedTier`'s `>=`.** No fixture had ever produced a member two tiers ahead of
  its siblings, so `>=` narrowing to `===` re-paged a tier that had already seen the
  manifest. *A MEMBER TWO TIERS AHEAD HAS ALREADY BEEN PAGED AT THE TIER BELOW IT.*

The other 16 are the two harmless kinds, and they are listed so nobody spends the afternoon
again: **equivalent by construction** — `batchGovernance`'s per-field re-validation of
`key`/`windowMs`/`maxBatch`/`deliveryDigest` and `usableBatching`'s of `key`/`windowMs` (an
applicant's marker is always valid, so a journal value that is NOT valid can never compare
equal to it — `sameGovernance` refuses the join either way; both layers stay, and if both are
deleted the behaviour DOES change); `batchFor`'s `gov === undefined` skip (`sameGovernance`
already answers `false` for it); `sameGovernance`'s `a === undefined` arm (members are
filtered on `batch !== undefined` before they get there); `#inheritable`'s `mirrorOf` early
return (`sameAuthority` refuses a mirror on both sides — the same "stated twice, both stay"
pair the file already documents for `decided`/`decisionOf`); `siblingReachedTier`'s
self-exclusion and `raise`'s `batch.id !== gateId`, both of which became redundant in THIS
wave's fixes (`next.tier` is always `gate.tier + 1` at the seq the page is decided at, and a
founder's batch id is not in the projection the raise is decided at); `batchHasOpenMember`'s
`length > 0` (`gateBatchGroups` never makes an empty bucket); `gateQueueOrder`'s explicit
`raisedAtSeq` tie-break (the sort is stable and `openGates` is in journal order). **Two
spellings of one outcome** — `resolveBatch`'s `members.length === 0` (the manifest check
refuses with the same code) and its `taskId: ""` conditional. **A degenerate-but-harmless
duration** — `isPositiveWholeMs` accepting `0` or `1.5`, which the compiler refuses anyway.
And one that needs a hand-written journal to reach at all: `batchFor`'s id tie-break, since
`batchFor` itself cannot produce two eligible batches with the same anchor.

**THE ARITHMETIC HAS NOW BEEN WRONG TWICE AND MEASURED THREE TIMES, AND THE THIRD
MEASUREMENT STATES ITS METHOD BEFORE ITS NUMBER — because that is the only thing that makes
three different answers stop being a contradiction.** The three are: "twelve of thirty-seven
turned nothing red" (37 mutations across several files, sampled); "**56** mutations over
`telemetry/spans.ts` alone left **42** survivors"; and this one. A survivor count is a
property of THE MUTATION SET, so it is a measurement of a set, not a fact about a file, and
a number quoted without its set is unusable. **Do not compare these three.**

The third, in full, so it can be repeated or refuted:

| | |
|---|---|
| **Subject** | `packages/core/src/telemetry/spans.ts`, and nothing else |
| **Set** | **83** mutations — exactly one flip per guard, comparison, ternary, and `isEvent` arm predicate in the file. No mutation removes a `name: "loom.*"` literal, because the drift guard kills those regardless of the guard under test (that is what mis-scored two of the previous sweep's) |
| **Kill set** | `node --test --test-force-exit` over the **five** test files that can reach this module at all — `telemetry/spans.test.ts`, `run/replay.test.ts`, `run/gate-clock.test.ts`, `docs-drift.test.ts`, `cli/cli.test.ts`. Derived, not sampled: `spans.ts` is imported by exactly two src files (`cli.ts` and the barrel) and no test imports the barrel, so no other test can call `spansFrom`, `reconstructGraph`, `conformsToGraph` or `shouldExport`. **This cell used to claim the five were STRONGER than the whole suite, which is not a thing a strict subset can be** — every test here is in the suite, so the suite kills everything these kill and possibly more, and the honest claim is that it kills nothing more *for this subject*, because no other file can call the functions. What the subset actually buys is REPEATABILITY: fewer files means fewer ways to read a kill that is not one, which is the failure the row below is about. It was also the only option available: `test/server/http.test.ts` hung indefinitely under a sibling's concurrent edit and would have stalled the sweep at mutation 23 |
| **Killed** | a test fails that was not already failing on the unmutated tree — the failing SET, never the count |
| **Result** | **83 mutations, 24 survivors** |

The 24, classified — and the classification is the useful output, not the number:

| Kind | N | Which |
|---|---|---|
| **Cannot be observed** | 3 | `redact-links`, `attr`-on-closed, `note`-on-closed — the three added to the list above |
| **Equivalent mutants** | 2 | `idText`'s string arm (a string falls through to `String(v)` and gets the same answer) and `shouldExport`'s `headRatio <= 0` short-circuit (`bucket < 0` is already false). No observer anywhere can distinguish these; they are not holes and never will be |
| **An arm no fixture reaches** | 13 | the `isEvent` arms for `run.compiled`, `run.started`, `run.resumed`, `run.completed`, `run.failed`, `run.cancelled`, `task.leased`, `tool.called`, `effect.completed`, `effect.failed`, `task.failed`, `task.cancelled`, `task.skipped`. **Two of those are structurally unreachable** — `task.cancelled` and `task.skipped` have no appender at all (C1). The other eleven happen in the driven run `replay.test.ts` folds, and nothing asserts what they put on a span |
| **The absent half of an optional attribute** | 2 | `task.ready`'s `binding` and `gate.escalated`'s `deadline`: every fixture supplies both, so "and it is absent when the payload has none" is unheld. **`binding`'s half is now held** — *A `task.ready` WHOSE binding IS null…* drives both the absent and the present case, and the arm it holds is no longer the same arm (it was `binding === undefined ? {} : binding.channel`, which threw a TypeError on `null` and cost the whole trace). `deadline`'s half is still unheld and is still only that |
| **The taskless-event guard** | 2 | see **A17** (which was the second **A16** when this table was written). The gate half was closed and pinned first; **the Task-scoped half is now held too** — *A taskId THAT IS null OR EMPTY IS NO taskId* drives `task.ready` and `task.committed` under four bogus id shapes and asserts no `loom.task` span is minted. The guard it holds is likewise not the mutated one: the derivation is now a positive `typeof` test rather than `=== undefined` |
| **A documented scoping statement** | 1 | `reconstructGraph`'s `s.name !== "loom.task"` skip, above. Its listing stands: it survives a mutation that introduces no literal |
| **A boundary needing a hand-picked run id** | 1 | `bucket < headRatio` vs `<=`. Only distinguishable when a run's bucket is exactly the ratio, which is `k / 0xffff`; the ceiling test already shows how such an id is found |

**Four survivors of the FIRST run of that sweep were real holes and are now pinned**, in
`test/telemetry/spans.test.ts`: the run scope `close` passes to `redactAttributes` (dropping
it puts every token under the process key — the cross-run oracle), the span-order
comparator's tie-break (its fixture had to be chosen so the ids sort against insertion
order, or a stable sort hides it), `gate.approver`'s human-only conjunct (the old assertion
was `equal(x, undefined)`, which a PRESENT key holding `undefined` satisfies — the mutation
produced exactly that), and `shouldExport`'s empty-journal read. The earlier nine that pass
listed here remain pinned.

**Diff the failing SET, never the count.** Three mutations in the previous sweep read as
killed and were not: two replaced a `"loom.task"`/`"loom.run"` literal, which the drift
guard flags on sight regardless of the guard under test, and `server/http.test.ts` fails
intermittently on a port bind under load, which reads as a kill on whatever ran next. Both
hazards are why the set above excludes name literals and the kill set above excludes files
that cannot reach the subject.

**E5 · `rewind`'s rejection scan over-refuses in one corner. NOT A DEFECT — the corner has no
way to be entered, and BOTH halves of the original entry were stale. Closed 2026-08-24.**

The entry read: *"It reads `(atSeq, head]` without excluding events an earlier rewind already
suppressed, so a rejection whose effect was already erased still blocks a new rewind. Fail-safe
direction; the alternative needed `suppressedRanges` exported from `projection.ts`, which
`export *` would have pushed into the pinned public surface."*

> **The stated obstacle is gone.** `suppressedRanges` is exported from `projection.ts` and is in
> `scripts/surface.json` — `journal/audit.ts` needed it, so it was exported and pinned, and the
> reason not to fix this stopped being true without anyone noticing.
>
> **And the corner is unreachable, which is the more useful half.** A rejection at seq `R` is
> suppressed only by a rewind to some `atSeq < R`; that rewind's own scan reads `(atSeq, head]`,
> which contains `R`; so the rule refuses it. The state this entry describes cannot be entered
> while the rule it complains about exists.
>
> Pinned as a property rather than argued: *"A REJECTION CAN NEVER BE INSIDE A SUPPRESSED RANGE"*
> in `test/run/gate-lifecycle.test.ts` sweeps every rewind target from 0 to head + 1, then asserts
> no `gate.decided{reject}` seq falls inside any range `suppressedRanges` reports.
> Mutation-verified: loosening the rejection refusal fails it — which is exactly when filtering
> suppressed events WOULD begin to matter, so the guard fires at the right moment rather than
> never.

**E6 · A mid-flight cancel leaves the in-flight Task `leased` in the read model. RESOLVED
2026-08-24, and it took C1's `task.cancelled` with it.**

> `Engine.#cancelTree` appends `task.cancelled` for every NON-TERMINAL Task in the same append as
> `run.cancelled`, so a run no longer reads `cancelled` while one of its Tasks reads as still
> running. `task.cancelled` has left `NEVER_APPENDED`, which activates three folds that were
> written for it and could never run — `projection.ts`, `evolution/trajectory.ts` and
> `telemetry/spans.ts`. **The dead code was on the READING side**, which is where it is hardest
> to notice and where a registry of never-appended types is the only thing that finds it.
>
> **Terminal Tasks are deliberately skipped**, and the negative control is in the suite: a Task
> that already succeeded must still say so. Re-ending it would erase work that really happened,
> which is a worse lie than the stranded lease this fixes.
>
> **Four guards fired in sequence and every one of them was right.** `NEVER_APPENDED` refused the
> new appender until its entry was removed. `audit-coverage.test.ts` then saw a type both appended
> and excused. The `todo` ratchet refused to let the rule be deferred, so
> `task.cancelled-not-after-commit` was written instead of postponed. And the
> every-rule-has-a-fixture gate demanded the fixture — **which is what found the second defect**:
> `task.leased-is-resolved` did not know that a cancellation resolves a lease, so the E6 fix made
> the healthy shape (leased, then cancelled) trip a different rule. Closing one rule's blind spot
> had opened another's false positive, and only the fixture could see it.
>
> **The generalisable form: a new event type has to be taught to every rule that tracks the thing
> it ends, not only to the rule it was added for.**

**E8 · Two load-bearing refusals in `http.ts` had no test, and both failed open when removed.
RESOLVED — kept only for the reason the SUITE could not see them, which generalises.**
Both are now pinned in `test/server/http.test.ts`, each mutation-verified: deleting the length
conjunct fails exactly the prefix-match test, deleting the `typeof` half fails exactly the
non-string test, and neither mutation touches any other test.

> **Why 1992 tests missed a prefix match on the bearer token.** The refusal was covered in the
> direction that cannot exercise it. `#sharedToken` pads the presented string UP to the expected
> length, so a token SHORTER than the secret fails on the padded bytes whether the length check
> is there or not — and every wrong token the suite sent was shorter (`Bearer wrong`). The
> guard's entire domain is presented strings that are LONGER, and nothing sent one. Same shape
> on the constructor: `token: ""` was pinned with a reproduction, and `typeof token !==
> "string"` — the half of the same condition that catches `[]` — was not.
>
> **The generalisable form: a test whose input cannot reach the branch certifies the branch.**
> This is `E4`'s "guards with no test" one level in — the guard HAD a test, addressed to the
> wrong side of it. Ask of every refusal not "is it tested" but "does any test supply an input
> that would fail without it", which is what a mutation answers and a reading does not.
>
> One assertion in the first draft was wrong and the reason is worth keeping: `Bearer s3cret `
> returns 200, and that is `node:http`, not the guard. RFC 7230 makes surrounding whitespace
> optional in a field value and the parser strips it, so a trailing space never reaches
> `#sharedToken` — measured on a bare `createServer`, the handler sees `"Bearer s3cret"` for
> both requests, and `"\0"` never leaves the client, refused by `Headers.append`. **A suffix has
> to survive the transport to test this guard**, which is one more way an input fails to reach
> a branch.

---
