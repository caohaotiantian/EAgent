#!/usr/bin/env node
/**
 * AC7: gzipped sum of web/dist *.{js,css} (excluding .map) ≤ 350 KiB.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..", "web", "dist");
const LIMIT = 350 * 1024;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|css)$/.test(name) && !name.endsWith(".map")) out.push(p);
  }
  return out;
}

let total = 0;
for (const f of walk(root)) {
  total += gzipSync(readFileSync(f)).length;
}
console.log(`web bundle gzip total: ${total} bytes (limit ${LIMIT})`);
if (total > LIMIT) {
  console.error("AC7 FAILED: bundle exceeds 350 KiB gzip");
  process.exit(1);
}
