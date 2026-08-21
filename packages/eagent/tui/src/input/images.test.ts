/**
 * Image attachment rules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { clipboardImageCommand, imageMentions, isImagePath, mediaType } from "./images.ts";

test("image extensions are recognised, case-insensitively", () => {
  for (const p of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp"]) {
    assert.ok(isImagePath(p), `${p} is an image`);
  }
  for (const p of ["a.ts", "README.md", "noextension", "archive.png.gz"]) {
    assert.ok(!isImagePath(p), `${p} is not an image`);
  }
});

test("media types map to what providers expect", () => {
  assert.equal(mediaType("shot.png"), "image/png");
  assert.equal(mediaType("photo.JPG"), "image/jpeg");
  assert.equal(mediaType("photo.jpeg"), "image/jpeg");
  assert.equal(mediaType("anim.gif"), "image/gif");
  assert.equal(mediaType("notes.txt"), null);
});

test("@-mentioned image paths are collected", () => {
  const found = imageMentions("compare @before.png with @after.png please");

  assert.deepEqual(found, ["before.png", "after.png"]);
});

test("a non-image mention is not treated as an attachment", () => {
  assert.deepEqual(imageMentions("read @src/cli.ts and @README.md"), []);
});

test("an email address is never mistaken for an attachment", () => {
  assert.deepEqual(imageMentions("mail someone@example.png about it"), []);
});

test("a mention at the very start counts", () => {
  assert.deepEqual(imageMentions("@shot.png what is this"), ["shot.png"]);
});

test("the clipboard command is platform-specific and reports when unavailable", () => {
  const mac = clipboardImageCommand("darwin", "/tmp/x.png");
  assert.equal(mac?.command, "osascript", "macOS uses AppleScript, always present");

  const linux = clipboardImageCommand("linux", "/tmp/x.png");
  assert.match(linux?.args.join(" ") ?? "", /xclip/);

  assert.equal(clipboardImageCommand("win32", "/tmp/x.png"), null, "unsupported is stated, not guessed");
});
