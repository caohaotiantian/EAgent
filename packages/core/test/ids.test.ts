import test from "node:test";
import assert from "node:assert/strict";

import {
  ROOT_BRANCH,
  childBranch,
  compareBranch,
  decodeBranch,
  effectKey,
  encodeBranch,
  parseTaskId,
  taskId,
  ulid,
  type NodeId,
} from "../src/ids.ts";

test("ulid is 26 chars of Crockford base32", () => {
  const id = ulid();
  assert.equal(id.length, 26);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("ulid sorts by creation order, including within one millisecond", () => {
  const ids = Array.from({ length: 200 }, () => ulid(1_700_000_000_000));
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, "monotonic within a fixed clock tick");
  assert.equal(new Set(ids).size, ids.length, "no duplicates");
});

test("ulid time prefix increases with the clock", () => {
  const a = ulid(1_700_000_000_000);
  const b = ulid(1_700_000_000_001);
  assert.ok(a < b);
});

test("branch coordinates round-trip through their encoding", () => {
  const b = childBranch(childBranch(ROOT_BRANCH, "e1", 3), "e7", 0);
  assert.equal(encodeBranch(b), "root/e1[3]/e7[0]");
  assert.deepEqual(decodeBranch(encodeBranch(b)), b);
  assert.equal(encodeBranch(ROOT_BRANCH), "root");
  assert.deepEqual(decodeBranch("root"), ROOT_BRANCH);
});

test("compareBranch is a total order with prefixes first", () => {
  const root = ROOT_BRANCH;
  const e1_0 = childBranch(root, "e1", 0);
  const e1_1 = childBranch(root, "e1", 1);
  const e1_10 = childBranch(root, "e1", 10);
  const e2_0 = childBranch(root, "e2", 0);
  const e1_0_x = childBranch(e1_0, "e9", 0);

  const shuffled = [e1_10, e2_0, root, e1_0_x, e1_1, e1_0];
  const sorted = [...shuffled].sort(compareBranch);

  assert.deepEqual(sorted.map(encodeBranch), [
    "root",
    "root/e1[0]",
    "root/e1[0]/e9[0]",
    "root/e1[1]",
    // numeric, not lexicographic: 10 must sort after 1, not between 1 and 2
    "root/e1[10]",
    "root/e2[0]",
  ]);
});

test("compareBranch is stable regardless of input order", () => {
  const items = Array.from({ length: 12 }, (_, i) => childBranch(ROOT_BRANCH, "e1", i));
  const a = [...items].sort(compareBranch).map(encodeBranch);
  const b = [...items].reverse().sort(compareBranch).map(encodeBranch);
  assert.deepEqual(a, b, "join folds must not depend on arrival order");
});

test("taskId is derived and round-trips", () => {
  const node = "investigate" as NodeId;
  const branch = childBranch(ROOT_BRANCH, "e1", 7);
  const id = taskId(node, branch, 2);
  assert.equal(id, "investigate@root/e1[7]#2");

  const parsed = parseTaskId(id);
  assert.equal(parsed.nodeId, node);
  assert.equal(parsed.iteration, 2);
  assert.deepEqual(parsed.branch, branch);
});

test("taskId is pure — the same inputs always produce the same id", () => {
  const node = "n" as NodeId;
  const b = childBranch(ROOT_BRANCH, "e", 0);
  assert.equal(taskId(node, b, 0), taskId(node, b, 0));
});

test("effect keys are stable across attempts", () => {
  const id = taskId("n" as NodeId, ROOT_BRANCH, 0);
  // No attempt component: a retry must reuse the key so external idempotency works.
  assert.equal(effectKey(id, "tool", 0), "n@root#0:tool:0");
  assert.notEqual(effectKey(id, "tool", 0), effectKey(id, "tool", 1));
  assert.notEqual(effectKey(id, "tool", 0), effectKey(id, "model", 0));
});

test("malformed ids are rejected rather than silently accepted", () => {
  assert.throws(() => decodeBranch("nope"), /malformed branch coordinate/);
  assert.throws(() => decodeBranch("root/e1"), /malformed branch segment/);
  assert.throws(() => parseTaskId("no-at-sign" as never), /malformed task id/);
});
