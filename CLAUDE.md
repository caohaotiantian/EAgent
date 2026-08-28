# CLAUDE.md

Orientation for whoever works on this next. **The code is the source of truth.** Where this file
disagrees with the code, the code wins — fix this file.

Keep it short. Everything here is either the goal, a principle, or a fact you need in the first
five minutes. Work items live in `TODO.md`; the roadmap is `DESIGN.md`'s Sequence; decisions
live in the commit history and in `docs/`.

---

## The goal

**A multi-agent runtime someone can actually use.** Install it, describe what they want done, have
it run against a real provider, watch it, stop it, and trust what it did.

That is the bar and nothing substitutes for it. A correct mechanism nobody has used is not a
product, and this project has repeatedly mistaken the first for the second. **The next real
workflow somebody ports is worth more than the next invariant somebody proves.**

## The three properties, in priority order

These are first-class. Where a change trades one away for convenience, the change is wrong.

### 1 · Kernel stability

The core is small, and it stays small under pressure. Its surface is something you can hold in
your head and depend on for years.

Mechanically this means: **a change that adds capability should not touch the kernel.** If it must,
that is a signal the kernel is missing a seam, and the seam is the thing to design. A kernel that
grows a feature per use case is a kernel nobody can depend on.

**The kernel is a named list of ten files**, in `scripts/kernel.json`, each with a written reason
it is there — the criterion is *this file is the mechanism that makes one of the non-negotiables
below true, and an extension must depend on it and cannot replace it*. `scripts/check-kernel.mjs`
runs the test: a `feat` commit touching one of them fails the gate unless it carries a
`Kernel-seam:` trailer saying which seam was missing. `fix` may touch the kernel freely — fixing
it is what a kernel is for. That trailer is the escape hatch and also the ledger:
`git log --grep='^Kernel-seam:'` is the running count of every time the kernel absorbed a feature,
and it is not a number anyone can quietly reset.

The list says nothing about whether `engine.ts` should be split — see its header for three
arguments against. `check-surface.mjs` pins the exported NAME SET and nothing else, so it reports
green however large a pinned file grows; that is the gap `check-kernel.mjs` exists to cover.

### 2 · Unlimited extensibility

Everything that is not the kernel is an extension, and extensions can reach everywhere the kernel
can. No privileged built-ins: the things that ship in the box are written against the same surface
a stranger would use. If a built-in needs a back door, the surface is wrong.

The test of this property is not "can you add a tool". It is **"can somebody who does not have
commit access build the thing they need, and can they do it without forking?"**

**Today the answer is a named set, not "yes", and the set lives in `README.md`'s "Extending it,
and where that stops"** — the same escape-hatch-and-ledger shape as §1's kernel list: ten things
need no fork (a graph, a prompt/profile/skill, a subgraph, a `function` body, a `hook` body, an
MCP tool, an OpenAI-wire provider, an ANY-wire provider, an in-process tool, an HTTP delivery
endpoint) and five do: three schema sets (a node type, a reducer, a ninth hook point) and two that
are forks *from the CLI only* — a non-webhook delivery transport and an identity source — each of
which a library embedder builds against a pinned type instead
(`DeliveryChannel`/`GateDispatcher`, `IdentitySource`/`startControlPlane`). Every entry there is
quoted from the refusal the binary actually prints. The reason the three schema sets are closed is
replay: a fold can only reproduce a decision whose vocabulary the folding binary already knows.
The two CLI rows are closed for a weaker reason — nobody built the seam — which is why they are
debts. **Shrinking that second list is what this property means in practice; the list moving the
other way is the alarm.** It went six → seven on 2026-08-28 by being measured again rather than
because a door closed, then seven → five when `--extension-module` gave the CLI the door onto
`ModelRegistry` and `ToolRegistry` that a library embedder always had — and the blanket "closed by
replay" reason went with the two rows it did not fit.

### 3 · Endless self-improvement

The system observes its own runs, and what it learns changes what it does next. Every run leaves
enough evidence to be judged, replayed, and improved on.

This is the property most easily faked. Capturing trajectories is not improvement; scoring them is
not improvement. **Improvement is when a later run is measurably better because of an earlier one**,
and the measurement has to be one that cannot be gamed by the thing being measured.

## What follows from those, and is not negotiable

- **The journal is the only authoritative state.** Everything else is a projection you can rebuild
  by folding it. If a decision reads a value, the journal must be able to reconstruct that value —
  including across a restart. This has been violated **six** times and each violation silently
  switched off a guard. Five are named in
  `packages/core/test/run/oversight-survives-restart.test.ts`; the sixth is
  `packages/core/test/run/escalation.test.ts` — search either file for `MEMBER`.
  **The enumeration is split, and that is the lesson, not an accident:** this line used to say
  "cite that file rather than repeating the number", and the device failed on its first test —
  the sixth member landed in a different file and the cited one still said five. A pointer to an
  enumeration is only as good as the enumeration's own discipline about growing.
- **Every nondeterministic call is recorded under a derived key, and replay serves the record.**
  Derived, never random: an id you cannot recompute breaks replay.
- **Oversight only tightens.** Nothing raises its own permissions. A human may lower a posture; no
  automated path may.
- **Refusing is always allowed; loosening never is.** When a guard cannot decide, it fails closed.
- **The core takes no runtime dependencies.** It is the thing that must still build and run in five
  years. Other packages may take what they need.

## Working here

- **Build the thing, then show it works.** One honest test beats a guard plus a mutation sweep plus
  a registry entry. Reach for a gate when a defect class has actually recurred, not in advance.
- **Reproduce by running, not by reading** — including when correcting a comment. A correction that
  replaces a false claim with a differently-false one is worse than the original.
- **Name the set a claim covers.** "This is total" cannot be checked; a claim that names its members
  can.
- Every module says *why it exists* at the top, not what it does.
- Tests are offline and deterministic — no network, no API key, no wall-clock dependence, with
  ONE declared exception: `packages/core/test/scale.test.ts` measures compile cost against node
  count and says in its own header that it must read a clock. **"Re-run it alone before believing
  it" used to stand here and it was not true**: measured, `compile scales sub-quadratically` failed
  1 run in 10 alone and 1 in 15 under fourteen CPU burners, because it is a RATIO between two
  sizes and load slows a 500-node compile far more than a 100-node one, which a ratio amplifies
  rather than cancels. It now asserts twice — once on a deterministic count of the compiler's spec
  reads, which cannot flake, and once on the clock, whose noise is down to 15/15 under the same
  load. **Believe a red one.** If only the timed half is red, the count in the same output says
  whether the algorithm moved.
- `/usr/bin/grep -a` always, and the path matters: this shell's `grep` is a ugrep wrapper that
  passes `-I`. Empty output is not evidence of absence. **The trigger set is NUL ∪ invalid
  UTF-8**, not non-ASCII — valid non-ASCII matches fine. **Five** tracked files carry a NUL byte
  today and none is invalid UTF-8. Do not count them with grep: a skipped file is only reported
  when it also matches your pattern, so grep undercounts and the count moves with the search
  term. Census instead — read every `git ls-files` path and test for a zero byte.
- Commits land under the human author's identity only. No assistant attribution, no co-author
  trailers, no assistant links in commit bodies or pull requests.

## Layout

```
packages/core/     the runtime. Zero runtime dependencies. src/ + test/
                   Ten of its files are the kernel; scripts/kernel.json names them and says why.
scripts/           build and the three guards that are worth their cost:
                   zero-dep, surface (the exported name set), kernel (the pinned file list)
DESIGN.md          the decisions, and the Sequence they imply — the roadmap
TODO.md            everything unfinished, self-contained
docs/              dated records: audit findings and backlog re-checks, with reproductions
.agent/<task>/     per-task working state (gitignored)
```

## Commands

```bash
npm run check       # typecheck + tests + guards. The gate.
npm test            # tests only
npm run build:binary                            # a single-file binary
npx tsc -p packages/core/tsconfig.test.json     # read-only typecheck, safe under concurrency
node --test packages/core/test/<file>           # one suite
```

If several agents or shells are working at once, do not run `npm run check` or a bare `tsc -b` —
concurrent builds race on emit. Use the read-only typecheck.

## Toolchain facts that shape the code

- **Node 24 with native type stripping.** Tests run `.ts` directly; there is no build step for
  tests. It cannot strip `.tsx` — it does not parse JSX at all.
- **Import specifiers say `.ts`**, and are rewritten on emit. Do not write `.js` in source.
- **No `enum`, no `namespace`, no parameter properties** — `erasableSyntaxOnly` is on. Use `const`
  objects and union types.
- **`node:sqlite` is the durable store**, so the zero-dependency rule holds.
- **`node:vm` is not a sandbox.** It is scoping. Untrusted code needs a process boundary.
