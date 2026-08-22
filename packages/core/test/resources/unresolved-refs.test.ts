/**
 * D5 — `loom compile` said `ok` for a graph naming resources that do not exist.
 *
 * The compiler was never the problem. `rule015Resources` has raised
 * `GRAPH015_RESOURCE_NOT_FOUND` as an ERROR since long before this, and it could not fire
 * because the CLI's workspace resolver answered EVERY syntactically valid ref with a
 * fabricated pin:
 *
 *     oversight/deploy@stable  →  sha256:6f76657273696768742f6465706c6f7940737461626c65…
 *
 * which is the ref, hex-encoded — it decodes back to itself. A digest derived from the ref
 * carries nothing `graphHash` does not already carry, so it bound nothing, proved nothing, and
 * cost the pre-flight compiler its whole point. `spec.ts` said a pinned `humanGate.ref` "proves
 * a policy EXISTS and pins its bytes"; against the fabricator it proved the ref was spelled with
 * a slash and an at-sign.
 *
 * Removing it is one line. The reason this took a wave is the SECOND question: two of the kinds
 * a graph can name are not documents at all, and refusing them would refuse every gated graph
 * and every agent graph in existence. `NAME_ONLY_KINDS` is that answer, and this file is the
 * pair of claims it has to keep — a ref that becomes a document must exist, a ref that is a key
 * need not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-refs-"));
  mkdirSync(join(dir, "resources"), { recursive: true });
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function publish(dir: string, kind: string, name: string, ext: string, body: string): void {
  mkdirSync(join(dir, "resources", kind), { recursive: true });
  writeFileSync(join(dir, "resources", kind, `${name}${ext}`), body);
}

async function compile(dir: string, spec: unknown): Promise<{ ok: boolean; err: string }> {
  const file = join(dir, "g.json");
  writeFileSync(file, JSON.stringify(spec));
  const errOut: string[] = [];
  const realErr = process.stderr.write.bind(process.stderr);
  const realOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await main(["compile", file, "--workspace", dir]);
    return { ok: true, err: errOut.join("") };
  } catch (e) {
    assert.ok(isLoomError(e) && e.code === CODES.E_GRAPH_INVALID, `expected E_GRAPH_INVALID, got ${String(e)}`);
    return { ok: false, err: errOut.join("") };
  } finally {
    process.stderr.write = realErr;
    process.stdout.write = realOut;
  }
}

const base = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "g", project: "p", version: 1 },
  policy: { posture: "out" },
  channels: { n: { reduce: "replace" }, plan: { type: "string", reduce: "replace" } },
  inputs: [],
  outputs: ["n"],
};

const agentGraph = (prompt: string, profile: string) => ({
  ...base,
  nodes: [{ id: "a", type: "agent", writes: ["n"], agent: { profile, prompt } }],
  edges: [],
});

// ── a ref that becomes a document must exist ────────────────────────────────

test("D5 — a graph naming a prompt that does not exist DOES NOT COMPILE", async () => {
  const w = workspace();
  try {
    const r = await compile(w.dir, agentGraph("prompt/missing@stable", "agent_profile/x@stable"));
    assert.equal(r.ok, false, "`loom compile` said ok for a resource that does not exist");
    assert.match(r.err, /GRAPH015_RESOURCE_NOT_FOUND/);
    assert.match(r.err, /prompt\/missing@stable/);
    // The engine already refused this at RUN time, inside `#documentFor`, with a message about
    // the model being "sent the ref instead of an instruction". Same refusal, before spend.
    assert.match(r.err, /resources\/prompt\/missing\.md/, "the fix must name the file to write");
  } finally {
    w.dispose();
  }
});

test("...and compiles once the document is published", async () => {
  const w = workspace();
  try {
    publish(w.dir, "prompt", "missing", ".md", "Say something.");
    const r = await compile(w.dir, agentGraph("prompt/missing@stable", "agent_profile/x@stable"));
    assert.equal(r.ok, true, r.err);
  } finally {
    w.dispose();
  }
});

test("every DOCUMENT kind is refused when absent — function, subgraph, hook", async () => {
  // Named as a set rather than sampled, because the claim is about the boundary and a boundary
  // checked at one point is an anecdote.
  const cases: readonly (readonly [string, unknown])[] = [
    ["function/absent@stable", { ...base, nodes: [{ id: "a", type: "function", writes: ["n"], function: { ref: "function/absent@stable" } }], edges: [] }],
    ["subgraph/absent@stable", { ...base, nodes: [{ id: "a", type: "subgraph", writes: ["n"], subgraph: { ref: "subgraph/absent@stable", inputs: {}, outputs: { n: "n" } } }], edges: [] }],
    ["hook/absent@stable", {
      ...base,
      hooks: { preNode: ["hook/absent@stable"] },
      nodes: [{ id: "a", type: "function", writes: ["n"], function: { ref: "function/real@stable" } }],
      edges: [],
    }],
  ];
  for (const [ref, spec] of cases) {
    const w = workspace();
    try {
      publish(w.dir, "function", "real", ".js", "function () { return { writes: { n: 1 } }; }");
      const r = await compile(w.dir, spec);
      assert.equal(r.ok, false, `${ref} must not compile`);
      assert.match(r.err, new RegExp(ref.replace("/", "\\/")), `the diagnostic must name ${ref}`);
    } finally {
      w.dispose();
    }
  }
});

// ── a ref that is a KEY need not ────────────────────────────────────────────

test("A KEY KIND IS NOT REFUSED — agent_profile is a routing key, oversight is a policy label", async () => {
  // Both have a written reversal condition and neither is resolved to content by anything in
  // `src/`: `#runAgent` passes `agent.profile` through as `ModelRequest.model` for the
  // `--models-file` route table to map, and `humanGate.ref` becomes `policyRef`, which gates
  // batch by. Refusing them would refuse every agent graph and every gated graph ever written.
  const w = workspace();
  try {
    publish(w.dir, "prompt", "p", ".md", "Answer.");
    const r = await compile(w.dir, {
      ...base,
      outputs: ["n"],
      nodes: [
        { id: "g", type: "human_gate", reads: ["plan"], humanGate: { ref: "oversight/nobody-published-this@stable" } },
        { id: "a", type: "agent", writes: ["n"], agent: { profile: "agent_profile/nor-this@stable", prompt: "prompt/p@stable" } },
      ],
      edges: [{ id: "e1", from: "g", to: "a", kind: "seq" }],
    });
    assert.equal(r.ok, true, r.err);
  } finally {
    w.dispose();
  }
});

test("a PUBLISHED key kind still resolves and still pins — absence is what is tolerated, not the kind", async () => {
  const w = workspace();
  try {
    publish(w.dir, "agent_profile", "real", ".md", "You are terse.");
    const ws = openWorkspace(parseArgs(["compile", "--workspace", w.dir]));
    try {
      const pinned = ws.resolver.resolve("agent_profile/real@stable");
      assert.ok(pinned !== undefined, "a published profile must pin");
      assert.equal(ws.resolver.document?.(pinned.digest), "You are terse.");
      // And the pin is a real content digest, not the ref in hex — which is what the old
      // fallback produced for everything.
      assert.notEqual(pinned.digest, `sha256:${Buffer.from("agent_profile/real@stable").toString("hex").padEnd(64, "0").slice(0, 64)}`);
    } finally {
      ws.close();
    }
  } finally {
    w.dispose();
  }
});

test("THE FABRICATED PIN IS GONE — an unpublished ref resolves to nothing at all", async () => {
  const w = workspace();
  try {
    const ws = openWorkspace(parseArgs(["compile", "--workspace", w.dir]));
    try {
      for (const ref of ["prompt/x@stable", "function/x@stable", "oversight/x@stable", "agent_profile/x@stable"]) {
        assert.equal(ws.resolver.resolve(ref), undefined, `${ref} must resolve to nothing`);
      }
    } finally {
      ws.close();
    }
  } finally {
    w.dispose();
  }
});

// ── the exemption list must not decay ───────────────────────────────────────

test("NAME_ONLY_KINDS MUST NOT GROW, and every entry must carry its reversal condition", () => {
  // This list is the whole compromise, and the shape it fails in is growth: a kind added
  // because a graph would not compile, with no note of what makes it a KEY rather than a
  // DOCUMENT, and nothing to say when it should come back off. That is how `oversight` would
  // quietly become the excuse for `prompt`.
  //
  // Read from the SOURCE, not from an export, for the reason `audit-coverage.test.ts` gives
  // about the same shape: a second copy drifts from the thing it describes.
  const src = readFileSync(fileURLToPath(new URL("../../src/graph/validate.ts", import.meta.url)), "utf8");
  const decl = /const NAME_ONLY_KINDS: readonly string\[\] = \[([^\]]*)\];/.exec(src);
  assert.ok(decl !== null, "NAME_ONLY_KINDS moved — this gate reads it from the source on purpose");
  const kinds = [...decl[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);

  assert.deepEqual([...kinds].sort(), ["agent_profile", "oversight"], "these two, and adding a third needs an argument here");

  // The docstring above the list is where that argument goes, and it is checked PER ENTRY.
  // A count of the word "reversal" was the first version of this and it could not fail: three
  // mentions minus one still cleared a threshold of two, so deleting an entry's condition left
  // the gate green. The unit is the bullet, not the file.
  const doc = src.slice(Math.max(0, decl.index - 2000), decl.index);
  for (const kind of kinds) {
    const at = doc.indexOf(`\`${kind}\` —`);
    assert.notEqual(at, -1, `${kind} is exempt with no bullet above the list saying why`);
    // Bounded by the next bullet OR by the blank comment line that ends the list — whichever
    // comes first. Running the LAST bullet to the end of the docstring swallowed the closing
    // "when either reversal lands" paragraph, so deleting that entry's own condition still
    // found the word and the gate stayed green. Found by mutating exactly that.
    const ends = [...kinds.map((k) => doc.indexOf(`\`${k}\` —`)), doc.indexOf("\n *\n", at)].filter((i) => i > at);
    const bullet = doc.slice(at, ends.length === 0 ? doc.length : Math.min(...ends));
    assert.match(bullet, /reversal/i, `${kind}'s entry does not say what retires it`);
  }
});

test("each exempt kind is tolerated ONLY when absent — publishing a broken one still refuses", async () => {
  // The exemption is about ABSENCE. A published `agent_profile` that is not a document at all
  // must not become one, which is the door `workspace-documents.test.ts` guards for prompts and
  // which the exemption must not reopen from the side.
  const w = workspace();
  try {
    publish(w.dir, "agent_profile", "x", ".md", "");
    const ws = openWorkspace(parseArgs(["compile", "--workspace", w.dir]));
    try {
      // An EMPTY file is not an instruction — `readResources` refuses it — so it publishes
      // nothing, and the exemption then tolerates the absence. Both halves, in one place.
      assert.equal(ws.resolver.resolve("agent_profile/x@stable"), undefined);
    } finally {
      ws.close();
    }
    publish(w.dir, "prompt", "p", ".md", "Answer.");
    const r = await compile(w.dir, agentGraph("prompt/p@stable", "agent_profile/x@stable"));
    assert.equal(r.ok, true, r.err);
  } finally {
    w.dispose();
  }
});
