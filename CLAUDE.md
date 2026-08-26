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

Until `packages/eagent` was deleted, that sentence had no referent here at all and the test could
be quoted but never run; the one P1 gate that did run, `check-surface.mjs`, pins the exported NAME
SET and reported green on the day `run/engine.ts` crossed 6,100 lines. The list says nothing about
whether `engine.ts` should be split — see its header for three arguments against.

### 2 · Unlimited extensibility

Everything that is not the kernel is an extension, and extensions can reach everywhere the kernel
can. No privileged built-ins: the things that ship in the box are written against the same surface
a stranger would use. If a built-in needs a back door, the surface is wrong.

The test of this property is not "can you add a tool". It is **"can somebody who does not have
commit access build the thing they need, and can they do it without forking?"**

### 3 · Endless self-improvement

The system observes its own runs, and what it learns changes what it does next. Every run leaves
enough evidence to be judged, replayed, and improved on.

This is the property most easily faked. Capturing trajectories is not improvement; scoring them is
not improvement. **Improvement is when a later run is measurably better because of an earlier one**,
and the measurement has to be one that cannot be gamed by the thing being measured.

## What follows from those, and is not negotiable

- **The journal is the only authoritative state.** Everything else is a projection you can rebuild
  by folding it. If a decision reads a value, the journal must be able to reconstruct that value —
  including across a restart. This has been violated five times and each violation silently
  switched off a guard. **The five are named** in
  `packages/core/test/run/oversight-survives-restart.test.ts` — cite that file rather than
  repeating the number, which nothing else here could check.
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
- Tests are offline and deterministic — no network, no API key, no wall-clock dependence.
- `grep -a` always. A plain grep can silently skip a file, and empty output is not evidence of
  absence. The trigger is a **NUL byte**, not non-ASCII; **six** tracked files have one, listed in
  `docs/todo-recheck-2026-08-25.md` §F. Do not count them with grep — a NUL file is only reported
  when it also matches your pattern, so grep undercounts and the count moves with the search term.
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
