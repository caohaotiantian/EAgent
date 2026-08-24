# Design

**One document.** Written 2026-08-25 after a survey of what the field settled during 2025–26.
Everything here is a decision with an alternative it was chosen over. When one turns out wrong,
change it here and say why in the commit — do not start a second document.

---

## The thesis, corrected

The old thesis was *"the executable graph is the runtime"*. **That is table stakes and should not
be the pitch.** LangGraph, Temporal's workflow/activity split and Obelisk's WIT components all get
there. Worse, the graph lost as an *authoring surface*: LangChain 1.0 deprecated
`AgentExecutor` and hand-built `StateGraph` entry points in favour of a one-line `createAgent`
with a middleware array, and OpenAI's visual Agent Builder went from launch to announced shutdown
in about eight months.

The real differentiator is **how determinism is enforced**. Obelisk enforces it structurally by
compiling workflows to WASM components with no IO capability — and then you must author WASM.
Temporal and Restate enforce it by convention plus a replay checker. The third position, and ours:

> **Enforce determinism by controlling the realm, so the workflow language stays ordinary
> TypeScript.** A PRNG seeded from a journaled draw. A clock bound to a journaled boundary. Every
> effect keyed and declared. No undeclared capability reachable from a node body.

Say it early and out loud, because a reader who knows Obelisk will otherwise ask why not WASM.

## What the field settled — adopt without re-arguing

- **Conversational multi-agent is dead.** Microsoft put AutoGen into maintenance and merged it
  into Agent Framework; the thing that survived is the typed graph, and free-form agent chatter
  survived nowhere.
- **Parallel writers do not work.** Cognition's follow-up names the three topologies that do:
  single-writer plus a **clean-context reviewer** (deliberately *not* sharing the writer's
  context), asymmetric escalation to a stronger model, and manager/child coordination.
- **Multi-agent's measured win is bought context, not specialization.** Anthropic's research
  system beat single-agent by 90% at ~15× the tokens — and in the same work token count alone
  explains ~80% of performance variance. So: cheap mechanically-parallel nodes with independent
  context windows, not role-play crews.
- **Interrupt/resume as a value** is universal (`interrupt()`, `suspend()`, awakeables). We have
  it; keep it.
- **Replay systems fail by STALLING, not crashing.** Temporal's nondeterminism error retries the
  workflow task forever without entering a failed state, so a run can be dead for hours unnoticed.
- **Unlabelled data must default to untrusted.** Microsoft shipped information-flow control
  (FIDES) in Agent Framework 1.3: two axes, integrity × confidentiality, combined
  most-restrictive, with unlabelled tool output defaulting to UNTRUSTED so a forgotten annotation
  fails closed.
- **Node type stripping is Stable** and the escape hatch is gone. It cannot do JSX. That is
  settled and shapes the UI answer.

## Decisions

### D1 · The default surface is one line; the graph is the escape hatch

*Alternatives:* (a) graph-only, today's shape; (b) one-line agent only; (c) both, with the
one-liner compiling to a graph.

**Choice: (c).** `agent({ model, tools, prompt })` returns something runnable that *is* a
one-node graph. Everything the graph runtime gives — journal, replay, gates, budgets — applies
unchanged, and a user who never learns the graph still gets them. Reaching for the graph is how
you add fan-out, joins and human gates, not how you start.

*Why not (a):* every competitor's default is one line, and a runtime whose hello-world is a graph
literal loses on the first five minutes regardless of what it is better at afterwards.

### D2 · Effects are DECLARED, not called

*Alternatives:* (a) a `ctx.step(fn)` durable-step primitive, which every competitor exposes;
(b) nothing, today's shape — a node body cannot journal its own side effect at all; (c) effects
declared in the node's manifest, invoked through a bound handle.

**Choice: (c),** and this is the most consequential decision here.

An anonymous `ctx.step(closure)` is Temporal's Side Effect trap: unretryable, unkinded,
unauditable, and documented as unable to fail or to modify state because it does not re-execute
on replay. (b) is worse — the need is real and today there is nowhere to put it.

So a node type declares what it does:

```ts
effects: {
  charge: { kind: "tool", irreversibility: "irreversible", idempotent: false },
  fetch:  { kind: "tool", irreversibility: "read_only",    idempotent: true  },
}
```

and the runtime hands the body a bound, keyed, retryable invoker per declared name. **Declaring a
capability and declaring a journaled effect become the same act.** That turns "every
nondeterministic call is journaled" from a rule people must remember into a structural property —
which matters because the memory-only-state class has been violated five times, every time by a
field somebody forgot to journal.

### D3 · The clock is bound to the journal, not recorded

*Alternatives:* (a) journal each clock read under an effect key; (b) leave `Date` undefined, as
today; (c) bind the clock to the timestamp of the last journaled task-boundary event.

**Choice: (c),** which dissolves the disagreement rather than splitting it. It is not a recorded
read, so nothing new is journaled and no lie is replayed; and it is not an unjournaled read, so
the hole closes. It needs no seed and no new event kind — the timestamp already exists on an event
we already write. Then `Date` comes *back* into the realm, bound to that clock. Temporal's
TypeScript sandbox does the same thing.

Bind `Temporal` too when it lands as a default global.

### D4 · Information flow, scoped to branch coordinates

*Alternatives:* (a) today's single taint set; (b) adopt FIDES as-is; (c) FIDES' two axes with
scoping on the graph's branch coordinate.

**Choice: (c).** Adopt the two axes (integrity × confidentiality), most-restrictive combination,
and — the highest-value single default in the domain — **unlabelled means untrusted**.

The novelty is in the scoping. FIDES' own stated limitation is that most-restrictive propagation
is conservative: once an untrusted issue body enters the context, *the whole run* is untrusted,
because the only units available are "the message" and "the run". **A graph has a third unit
neither has: the branch coordinate.** A label can be confined to a branch and resolved at the
join, so one untrusted fetch does not poison a parallel branch that never read it.

### D5 · The extension surface is versioned mechanically

*Alternatives:* (a) semver and discipline; (b) VS Code's proposed-API model; (c) both, plus
version-pinned defaults.

**Choice: (c).** A proposed API lives in its own declaration file, an extension opts in
explicitly, and **an extension using a proposed API cannot be published** — that is what stops an
ecosystem accreting dependence on an unfinished surface, and it is mechanical rather than
cultural. On top, Go's `GODEBUG` idea: when a default changes, a graph that declared an older
runtime version keeps the old behaviour automatically. In a journal-native runtime that pin is an
**event**, not a build flag, which is strictly more precise than anything Go can do.

### D6 · Self-improvement is text-space optimization behind a frozen gate

*Alternatives:* (a) trajectory capture and scoring only, today's shape; (b) automated candidate
generation with a promotion gate; (c) (b) with the eval set frozen before the candidate exists.

**Choice: (c).** Treat the prompt or skill document as the trainable parameter of a frozen model:
rollout batch → reflect → bounded edits under an edit budget → **accept only if strictly better on
a held-out set**. The one mechanical rule that makes this honest is that the suite must predate
the candidate, which turns "is this eval fair?" into a timestamp comparison.

### D7 · A prompt-only change is NOT a safe change

Temporal-ecosystem guidance says prompt edits need no version guard. **Restate is right and
Temporal's guidance does not transfer:** in an agent runtime the prompt *is an input to a recorded
effect*, so editing it silently corrupts a resumed run. Prompt text and tool-description text go
into the artifact hash and into the per-effect fingerprint.

## What we deliberately do not build

- **A visual graph canvas.** The highest-profile one in the industry lasted eight months.
- **Free-form agent-to-agent chat.** It makes termination unprovable, and it is the part of
  AutoGen that died.
- **Parallel writers.** Fan-out for independent reads; one writer.
- **A verifier that pronounces code safe.** eBPF is the best-resourced instance of that idea and
  is still producing soundness CVEs in 2026. A model may *narrow* what policy already permitted;
  it may never widen. Its verdict is a model call, so it gets journaled like any other — which
  makes it reproducible, and no vendor's classifier is today.
- **Keyed log compaction.** It deletes the history replay depends on. Bound the journal with
  payload externalisation above a byte threshold and bounded-iteration rollover instead.

## The three properties, mechanically

**Kernel stability** — the surface is pinned, proposed APIs cannot be depended on, and a default
change keeps old behaviour for graphs that declared an older version.

**Unlimited extensibility** — everything not the kernel is an extension against the same declared
surface, and the tool-extensibility path is a typed API the model writes code against rather than
N schemas in the context window. That shape cut one vendor's example workflow from ~150k tokens to
~2k. It has a cost this project must state: if tools are reached through generated code, the
reachable-tool set becomes a static-analysis problem rather than a graph-edge one, so **an agent
node does not get a code-execution tool by default.**

**Endless self-improvement** — trajectories are a read model folded from the journal, not a log.
The agent's working notebook is a *file* it writes, and the write is a journaled effect: the
journal records that the file changed, the file itself is not in the journal. That keeps the
journal bounded and the notebook diffable, which is the shape both Anthropic's long-running-agent
harness and LangChain's Deep Agents converged on independently.

## Sequence

1. **Declared effects (D2).** The structural fix; everything else is easier after it.
2. **Realm determinism (D3).** Clock bound to the journal, `Date` restored.
3. **The one-line surface (D1).** The thing that makes the first five minutes work.
4. **Divergence is terminal and loud.** A replay that cannot proceed must not retry forever.
5. **Labels on branch coordinates (D4).**
6. **The extension surface and its version pin (D5).**
7. **Self-improvement behind a frozen gate (D6).**

Open items and known defects live in `TODO.md`.
