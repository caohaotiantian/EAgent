/**
 * Tests for the JSON-file-backed `FileBackend`/`FileStore` (FRESH-4).
 *
 * Driven entirely through the exported `FileBackend` (`FileStore` is private):
 * each case constructs a FRESH `FileBackend(root)` so a new `FileStore` runs
 * `read()` (the backend caches one `FileStore` per namespace). The invariant
 * under test is corrupt-file safety: an absent file is a silent first run, a
 * valid file loads unchanged, and a corrupt file is preserved aside (not
 * destroyed by the next flush) while the store recovers to a working state.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FileBackend } from "../src/kernel/store.ts";

/** A fresh temp dir per case; namespace "ns" sanitizes to "ns.json". */
function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "eagent-store-"));
}

test("FRESH-4 (a): absent file is a silent first run — no premature write, value round-trips", () => {
  const root = freshRoot();
  const file = join(root, "ns.json");

  const s = new FileBackend(root).open("ns");
  assert.deepEqual(s.keys(), [], "absent file yields an empty store");
  assert.ok(!existsSync(file), "open() is a pure read for an absent file — no file written yet");

  s.set("k", 1);
  assert.ok(existsSync(file), "set() flushes the file into existence");

  // A fresh backend re-reads the persisted file.
  assert.equal(new FileBackend(root).open("ns").get("k"), 1, "value round-trips across backends");
});

test("FRESH-4 (b): a valid JSON file loads unchanged", () => {
  const root = freshRoot();
  writeFileSync(join(root, "ns.json"), JSON.stringify({ k: "v" }));

  assert.equal(new FileBackend(root).open("ns").get("k"), "v", "valid store loads its keys");
});

test("FRESH-4 (c): corrupt JSON is preserved aside and the store recovers", () => {
  const root = freshRoot();
  const file = join(root, "ns.json");
  writeFileSync(file, "{not json");

  const s = new FileBackend(root).open("ns");

  // (i) the corrupt file yields an empty working store.
  assert.deepEqual(s.keys(), [], "corrupt file yields an empty store");

  // (ii) the original bytes are preserved in a `ns.json.corrupt-*` sibling.
  const backups = readdirSync(root).filter((f) => /^ns\.json\.corrupt-/.test(f));
  assert.equal(backups.length, 1, "exactly one corrupt-backup sibling exists");
  assert.equal(readFileSync(join(root, backups[0]!), "utf8"), "{not json", "backup holds the original corrupt bytes");

  // (iii) a subsequent set() writes a fresh valid file without the corrupt bytes.
  s.set("k2", 2);
  const recovered = readFileSync(file, "utf8");
  assert.equal((JSON.parse(recovered) as Record<string, unknown>).k2, 2, "recovered file is valid JSON with the new key");
  assert.ok(!recovered.includes("{not json"), "the corrupt bytes are not in the recovered file");
});
