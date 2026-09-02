/**
 * A FLAG A VERB DOES NOT READ IS REFUSED, not ignored — and the table saying which is which is
 * held to the source rather than to a reviewer's memory.
 *
 * `assertKnownFlags` gates the flag NAME set, and nothing gated which verb may read one. Measured
 * at `0c3c486`, before `VERB_FLAGS`:
 *
 *     loom trace <runId> --port 9999 --token sekret --suite x   → accepted; fails only for the runId
 *
 * — three flags, three no-ops, and no word about any of them. `--otlp` was the single exception,
 * refused outside `trace` on the ground that its silent no-op is an egress that did not happen;
 * `TODO.md` §H.4 tracked the asymmetry and said it closes when the general table exists. It does
 * now, and `--otlp` is one row of it.
 *
 * ## Why this file scans the source
 *
 * A hand-kept applicability table drifts, and drift here does not fail safe: the failure mode is
 * a refusal that rejects a flag the command really does read, which is worse than the silence it
 * replaced. So the table is not restated below. It is RECOMPUTED — for each verb's `case` block,
 * the flags that block reaches, directly through `args.flags[…]` and through the closure of the
 * helper functions it calls — and asserted equal to `VERB_FLAGS`, verb by verb. That is the same
 * device `known-flags.test.ts` uses to hold `KNOWN_FLAGS`, `USAGE` and the code's readers to one
 * set, and it is the reason a new flag cannot be added to a verb without the table admitting it.
 *
 * The scan is deliberately mechanical and deliberately over-inclusive: it follows every top-level
 * function called from a block, so a flag read three helpers deep still counts as read by that
 * verb. A helper that reads a flag conditionally still counts — "reads" here means "can reach",
 * which is the only reading under which a refusal is safe.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";

const SRC = readFileSync(fileURLToPath(new URL("../../src/cli.ts", import.meta.url)), "utf8");
const LINES = SRC.split("\n");

/** Every `args.flags["x"]` and every `helper(args, "x")` in a chunk of source. */
function flagsIn(text: string): Set<string> {
  const re = /args\.flags\["([a-z-]+)"\]|(?:pathFlag|requireFileFlag|numberFlag|stringFlag|listFlag)\(args, "([a-z-]+)"/g;
  return new Set([...text.matchAll(re)].map((m) => m[1] ?? m[2]!));
}

/** Top-level `function name(…)` bodies, keyed by name. A body ends at the first `}` in column 0. */
function topLevelFunctions(): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < LINES.length; i++) {
    const m = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\s*[(<]/.exec(LINES[i]!);
    if (m === null) continue;
    let j = i + 1;
    while (j < LINES.length && !LINES[j]!.startsWith("}")) j++;
    out.set(m[1]!, LINES.slice(i, j).join("\n"));
  }
  return out;
}

/** name → every flag that calling it can reach, following calls to other top-level functions. */
function flagClosure(): Map<string, Set<string>> {
  const fns = topLevelFunctions();
  const closure = new Map([...fns].map(([n, b]) => [n, flagsIn(b)]));
  const callsOf = new Map(
    [...fns].map(([n, b]) => [n, new Set([...b.matchAll(/\b([A-Za-z0-9_]+)\(/g)].map((m) => m[1]!).filter((c) => fns.has(c) && c !== n))]),
  );
  // Iterate to a fixpoint. Bounded by the call graph, and it settles in a handful of passes;
  // the counter is a guard against a cycle plus a bug, not against the code as it stands.
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    for (const [n, cs] of callsOf) {
      for (const c of cs) {
        for (const f of closure.get(c)!) {
          if (!closure.get(n)!.has(f)) {
            closure.get(n)!.add(f);
            changed = true;
          }
        }
      }
    }
    if (!changed) return closure;
  }
  assert.fail("the flag closure did not settle in 50 passes");
}

/** verb → the flags its `case` block can reach. Fall-through blocks share their reader's set. */
function readsPerVerb(): Map<string, Set<string>> {
  const closure = flagClosure();
  const fns = topLevelFunctions();
  const cases: { verb: string; at: number }[] = [];
  for (let i = 0; i < LINES.length; i++) {
    const m = /^ {6}case "([a-z]+)":/.exec(LINES[i]!);
    if (m !== null) cases.push({ verb: m[1]!, at: i });
  }
  assert.ok(cases.length >= 15, `the scan found ${cases.length} verbs — the regex broke, not the CLI`);
  const end = LINES.findIndex((l, i) => i > cases[0]!.at && /^ {6}default:/.test(l));
  assert.notEqual(end, -1, "main's switch has no default arm — this scan reads it as the end of the last block");

  const out = new Map<string, Set<string>>();
  for (let k = 0; k < cases.length; k++) {
    const body = LINES.slice(cases[k]!.at, k + 1 < cases.length ? cases[k + 1]!.at : end).join("\n");
    const reached = flagsIn(body);
    for (const c of new Set([...body.matchAll(/\b([A-Za-z0-9_]+)\(/g)].map((m) => m[1]!))) {
      if (fns.has(c)) for (const f of closure.get(c)!) reached.add(f);
    }
    out.set(cases[k]!.verb, reached);
  }
  // FALL-THROUGH IS A SHARED ROW, not an empty one. `case "pause":` has no body of its own and
  // runs `resume`'s, so a table giving it `[]` would refuse `--reason` on a verb that reads it.
  for (let k = 0; k < cases.length; k++) {
    if (out.get(cases[k]!.verb)!.size === 0 && k + 1 < cases.length) {
      const next = out.get(cases[k + 1]!.verb)!;
      const bodyStart = LINES[cases[k]!.at]!.trim();
      if (bodyStart.endsWith(":") && !bodyStart.endsWith("{")) out.set(cases[k]!.verb, new Set(next));
    }
  }
  return out;
}

/** A named `readonly string[]` in the source, read rather than restated here. */
function listNamed(name: string): readonly string[] {
  const m = new RegExp(`const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\];`).exec(SRC);
  assert.ok(m, `${name} moved — this gate reads it from the source on purpose`);
  return [...m[1]!.matchAll(/"([a-z][a-z-]*)"/g)].map((x) => x[1]!).sort();
}

/** `VERB_FLAGS`, parsed out of the source. */
function table(): Map<string, readonly string[]> {
  const m = /const VERB_FLAGS: Readonly<Record<string, readonly string\[\]>> = \{([\s\S]*?)\n\};/.exec(SRC);
  assert.ok(m, "VERB_FLAGS moved — this gate reads it from the source on purpose");
  const out = new Map<string, readonly string[]>();
  for (const row of m[1]!.matchAll(/^ {2}([a-z]+): \[([^\]]*)\],$/gm)) {
    out.set(row[1]!, [...row[2]!.matchAll(/"([a-z][a-z-]*)"/g)].map((x) => x[1]!).sort());
  }
  return out;
}

test("VERB_FLAGS IS WHAT EACH VERB ACTUALLY READS — recomputed from the source, not restated", () => {
  const declared = table();
  const actual = readsPerVerb();
  const globals = new Set(listNamed("GLOBAL_FLAGS"));

  assert.deepEqual([...declared.keys()].sort(), [...actual.keys()].sort(), "a verb has a case block and no row, or a row and no verb");
  for (const [verb, reached] of actual) {
    const expected = [...reached].filter((f) => !globals.has(f)).sort();
    assert.deepEqual(declared.get(verb), expected, `\`loom ${verb}\`'s row is not the set of flags its case block reaches`);
  }
});

test("EVERY KNOWN FLAG IS PLACED: the global list and the rows together are KNOWN_FLAGS", () => {
  // A flag in `KNOWN_FLAGS` and in no row is one the refusal would reject on every verb — the
  // failure mode this whole table has to avoid. A flag in a row and not in `KNOWN_FLAGS` is one
  // `assertKnownFlags` rejects before this table is ever consulted.
  const placed = new Set(listNamed("GLOBAL_FLAGS"));
  for (const fs of table().values()) for (const f of fs) placed.add(f);
  assert.deepEqual([...placed].sort(), listNamed("KNOWN_FLAGS"), "a known flag belongs to no verb, or a row names a flag nothing knows");
});

test("GLOBAL_FLAGS ARE THE ONES READ BEFORE THE SWITCH DISPATCHES", () => {
  // The membership rule stated in that list's own docstring, checked: a global flag is one
  // `openWorkspace` or `main` itself reads, which is why every verb reads it. Anything else on
  // that list would be a flag exempted by assertion rather than by mechanism.
  const closure = flagClosure();
  const reachedByMain = new Set([...closure.get("openWorkspace")!, ...flagsIn(topLevelFunctions().get("main")!.split('switch (args.command)')[0]!)]);
  for (const f of listNamed("GLOBAL_FLAGS")) {
    assert.ok(reachedByMain.has(f), `--${f} is called global and nothing before the switch reads it`);
  }
});

// ── the refusal ─────────────────────────────────────────────────────────────

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-verbflags-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

async function cli(argv: string[]): Promise<unknown> {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await main(argv);
  } catch (e) {
    return e;
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

test("THE H.4 CASE: three flags `loom trace` does not read, all three named", async () => {
  const w = workspace();
  try {
    // Driven through `compile` and not `trace`, for `known-flags.test.ts`' reason: the refusal
    // runs before the verb dispatches, so any verb exercises it, and `compile` reaches no socket
    // and no journal. The three flags are the ones §H.4 measured on `trace`.
    const e = await cli(["compile", "nope.json", "--port", "9999", "--token", "sekret", "--suite", "x", "--workspace", w.dir]);
    assert.ok(isLoomError(e) && e.code === CODES.E_CONFIG_INVALID, String(e));
    for (const [flag, reader] of [
      ["port", "serve"],
      ["token", "serve"],
      ["suite", "promote"],
    ] as const) {
      assert.match(e.message, new RegExp(`--${flag} is read by [^.]*\`loom ${reader}\``), `--${flag} must name the verb that reads it`);
    }
    // NOT "unknown flag": these are real flags on the wrong verb, and `known-flags.test.ts`
    // distinguishes the two refusals by that string.
    assert.doesNotMatch(e.message, /unknown flag/);
  } finally {
    w.dispose();
  }
});

test("A FLAG THE VERB DOES READ IS ACCEPTED, and so is every global one", async () => {
  const w = workspace();
  try {
    // The false-positive half, and the half that matters more: a refusal that rejects a flag the
    // command really reads is worse than the silence it replaced. `compile` fails for its missing
    // graph file — a reason that is NOT the flag check, which is what proves the flags got past.
    for (const argv of [
      ["compile", "nope.json", "--workspace", w.dir, "--max-parallelism", "2", "--grant", "graph:mutate"],
      ["compile", "nope.json", "--workspace", w.dir, "--budget-usd", "1", "--egress", "example.invalid"],
    ]) {
      const e = await cli(argv);
      assert.ok(isLoomError(e), String(e));
      assert.doesNotMatch(e.message, /is read by/, `a global flag was refused: ${argv.join(" ")}`);
    }
    // And a verb-scoped flag on the verb whose row has it. `loom score` on a run that does not
    // exist REPORTS and exits 1 rather than throwing, so the assertion is on the refusal not
    // having happened rather than on which error came back — a number is already proof, since
    // `refuseFlagsThisVerbDoesNotRead` throws and `main` does not catch it.
    const scored = await cli(["score", "01NOSUCHRUN", "--workspace", w.dir, "--bucket", "exact"]);
    if (isLoomError(scored)) {
      assert.doesNotMatch(scored.message, /is read by/, "--bucket is in `loom score`'s row and must be accepted there");
    } else {
      assert.equal(typeof scored, "number", `score neither refused nor returned an exit code: ${String(scored)}`);
    }
  } finally {
    w.dispose();
  }
});

test("`--as` IS NOT GLOBAL, and the verbs that journal a decision under it still take it", async () => {
  const w = workspace();
  try {
    // `--as` reads like a global — it is documented in the bottom block of USAGE with the other
    // process-wide flags — and it is not one: `loom compile` and `loom gates` never journal a
    // decision, so nothing there reads it. This is the row most likely to be "simplified" into
    // GLOBAL_FLAGS by a later reader, and the refusal is what says it was a decision.
    const e = await cli(["compile", "nope.json", "--as", "alice", "--workspace", w.dir]);
    assert.ok(isLoomError(e) && /--as is read by/.test(e.message), String(e));
    assert.match(e.message, /`loom run`/, "the refusal must name a verb that does read it");

    const ok = await cli(["cancel", "01NOSUCHRUN", "--as", "alice", "--workspace", w.dir]);
    assert.ok(isLoomError(ok), String(ok));
    assert.doesNotMatch(ok.message, /is read by/, "`loom cancel` reads --as and must accept it");
  } finally {
    w.dispose();
  }
});

test("AN UNKNOWN VERB IS ANSWERED AS AN UNKNOWN VERB, not as a misplaced flag", async () => {
  const w = workspace();
  try {
    // `VERB_FLAGS` has no row for it, and a lecture about `--port` on a command that does not
    // exist would bury the actual mistake. `main`'s default arm prints the usage and exits 2.
    writeFileSync(join(w.dir, "unused.json"), "{}");
    assert.equal(await cli(["compil", "nope.json", "--port", "1", "--workspace", w.dir]), 2);
  } finally {
    w.dispose();
  }
});
