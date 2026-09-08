/**
 * The in-tree example workflow has an exam, and the exam refuses the shape the workflow shipped in.
 *
 * `review-bench.json` as shipped declared six outputs, `verdict0`…`verdict5`, every one written by
 * an evaluator node — so any exam over it could only grade the grader, and `attestationProblems`
 * refuses that by rule. The graph now also declares `reviews`, the raw model text, and
 * `exams/review-bench-exam.json` re-parses it against the planted `cases`. Both halves are
 * pinned here: the exam is an exam and attests against the edited graph; the shipped shape is
 * refused, with the rule named. The exam's body is run once over a review shaped like the ones
 * `bench-collate-v2.js` documents, so the parser is not merely present.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import { attestationProblems, examShape } from "../../src/evolution/exam.ts";
import { resolver } from "../run/skeleton.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (rel: string): GraphSpec => JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as GraphSpec;
const compileOf = (spec: GraphSpec): RunGraph => compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });

test("examples/exams/review-bench-exam.json IS an exam", () => {
  assert.deepEqual(examShape(compileOf(read("examples/exams/review-bench-exam.json"))), []);
});

test("it attests against review-bench as it now ships — `reviews` is a declared output", () => {
  const exam = read("examples/exams/review-bench-exam.json");
  const bench = read("examples/graphs/review-bench.json");
  assert.ok(bench.outputs.includes("reviews"), "the raw model text is an output the exam can read");
  assert.deepEqual(attestationProblems(exam, bench), []);
  // The two candidates declare the same outputs, so the exam can read theirs too.
  for (const c of ["examples/candidates/review-bench-v2.json", "examples/candidates/review-bench-v3.json"]) {
    assert.deepEqual(read(c).outputs, bench.outputs, c);
  }
});

test("THE SHIPPED SHAPE IS REFUSED: six evaluator-written outputs and nothing else is grading the grader", () => {
  const exam = read("examples/exams/review-bench-exam.json");
  const bench = read("examples/graphs/review-bench.json");
  const shipped: GraphSpec = { ...bench, outputs: bench.outputs.filter((o) => o !== "reviews") };
  const problems = attestationProblems(exam, shipped);
  assert.ok(problems.some((p) => /"reviews" are declared by the baseline graph neither/.test(p)), problems.join("\n"));
  // And an exam that tried to read what the shipped graph DID declare is refused for the reason
  // the design gives: `verdictN` is the work graph's opinion of itself.
  const graderReader: GraphSpec = { ...exam, inputs: ["subject", "cases", "verdict0"], channels: { ...exam.channels, verdict0: { type: "object", reduce: "replace" } } };
  const p2 = attestationProblems(graderReader, shipped);
  assert.ok(p2.some((p) => /grading the grader/.test(p)), p2.join("\n"));
});

test("the exam's body re-derives the verdict from raw text, preamble and all", () => {
  const body = readFileSync(join(ROOT, "examples/resources/function/bench-exam.js"), "utf8");
  // A bare function expression, evaluated the way the workspace loader evaluates it.
  const fn = new Function(`return (${body.replace(/^\/\/.*$/gm, "").trim()});`)() as (view: { get(name: string): unknown }) => { writes: { verdict: { pass: boolean; score: number; detail: string } } };
  const cases = [{ id: "a", defect: true }, { id: "b", defect: false }, { id: "c", defect: true }];
  const reviews = [
    'Thinking about it { carefully }… ```json\n{"verdict":"concerns","findings":["fold fails open"]}\n```',
    '{"verdict":"clean","findings":[]}',
    "no JSON at all",
  ];
  const view = { get: (name: string) => (name === "cases" ? cases : name === "reviews" ? reviews : undefined) };
  const out = fn(view).writes.verdict;
  assert.equal(out.pass, false);
  assert.equal(Number(out.score.toFixed(3)), Number((2 / 3).toFixed(3)), "a found, b correctly clean, c missed");
  assert.match(out.detail, /a: FOUND; b: correctly clean; c: MISSED/);
});
