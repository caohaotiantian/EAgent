#!/usr/bin/env node
/**
 * WHY THIS EXISTS: "install it" is the goal's first verb, and nothing drove an install.
 *
 * Every test in this repository runs `loom` out of the checkout — `src/` under type stripping, or
 * `dist/` beside the sources. None of them can see the defects that live only in the INSTALLED
 * copy, and each of these shipped once: a `bin` that printed nothing through npm's symlink, a
 * `--version` that printed the usage on every build, a tarball that crashed at ESM link time on
 * the wrong Node. So this installs the artifact where a stranger would — a fresh temp directory
 * with its own HOME and npm cache, no clone in reach — and walks the README's own first two
 * examples through it.
 *
 *     node scripts/smoke-install.mjs out/caohaotiantian-loom-0.1.0.tgz    tarball mode
 *     node scripts/smoke-install.mjs bin/loom                             binary mode
 *
 * TARBALL MODE: `npm install --offline` of the tgz into a project (the tarball has no
 * dependencies, so offline is not a restriction but an assertion), and `npm install -g --offline
 * --prefix` of it into a private global root, plus an `import` of the package's `"."` and `"./cli"`
 * exports from the project. BINARY MODE: a copy of the SEA binary in the temp directory — out of
 * its `bin/`, so it runs as a shipped copy with no sources beside it — and a second copy under
 * another name. Then, for EVERY one of those `loom`s:
 *
 *   1. the `loom` being run RESOLVES OUTSIDE THE REPOSITORY — a check that passes against the
 *      checkout's own `dist/` proves nothing about an install;
 *   2. `loom --version` is `loom <version>` — the tarball's own `package.json` in tarball mode,
 *      `packages/core/package.json` in binary mode (the binary was built from this tree);
 *   3. `loom --help`'s first line;
 *   4. README "Try it": compile and run `graphs/copy.json`, the copy equals its input byte for
 *      byte, and `loom replay <runId>` answers `match: true`;
 *   5. README gated example: the run stops `awaiting_gate` with nothing written, `loom approve …
 *      --as u:alice` from a SECOND process lands the write.
 *
 * THE GRAPHS AND THEIR INPUTS ARE READ OUT OF README.md, not restated here — the same extraction
 * `packages/core/test/readme-quickstart.test.ts` compiles on every `npm run check`. A README edit
 * that breaks a stranger's first run fails this script, not a copy of the README nobody reads.
 *
 * POSIX ONLY — Linux and macOS, the two CI runs it on. It spawns `npm` and the installed `loom`
 * without a shell, and on Windows both are `.cmd` shims Node will not spawn that way; it refuses
 * there rather than reporting a failure that is about itself.
 *
 * Deliberately NOT in `npm run check`: it needs a packed tarball or a built binary, and it spawns
 * npm. `.github/workflows/ci.yml`'s `install` job runs it. Offline: no registry is contacted.
 * Leaves nothing behind on success; on failure it prints the temp directory and keeps it.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const README = readFileSync(join(repoRoot, "README.md"), "utf8");
const HELP_FIRST_LINE = "loom — graph-native multi-agent orchestration";

if (process.platform === "win32") {
  console.error("smoke-install.mjs is POSIX only (see its header); nothing was checked.");
  process.exit(2);
}
const artifactArg = process.argv[2];
if (artifactArg === undefined) {
  console.error("usage: node scripts/smoke-install.mjs <package.tgz | loom binary>");
  process.exit(2);
}
const artifact = resolve(artifactArg);
if (!statSync(artifact, { throwIfNoEntry: false })?.isFile()) {
  console.error(`smoke FAILED: no file at ${artifact}`);
  process.exit(2);
}
const mode = artifact.endsWith(".tgz") ? "tarball" : "binary";

// ── the stranger's machine ────────────────────────────────────────────────────
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "loom-smoke-")));
const home = join(tmp, "home");
mkdirSync(home);
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  npm_config_cache: join(tmp, "npm-cache"),
  npm_config_userconfig: join(home, ".npmrc"),
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  // The installed `bin.js` starts with `#!/usr/bin/env node`: the Node running THIS script is the
  // one it must find, not whatever else is first on PATH.
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
};
delete env.LOOM_STALE_BINARY;

const failures = [];
function check(name, ok, saw) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name} — ${saw}`);
  if (!ok) failures.push(name);
  return ok;
}
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout ?? "", err: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
}
function oneLine(s) {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}
function finish() {
  if (failures.length > 0) {
    console.error(`\nsmoke FAILED (${mode}): ${failures.join(", ")}\nkept for inspection: ${tmp}`);
    process.exit(1);
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\nsmoke ok (${mode}): installed outside the repository and ran the README's first two examples`);
}

console.log(`smoke-installing ${artifact} (${mode}) in ${tmp}`);

// ── install ───────────────────────────────────────────────────────────────────
let expectedVersion;
const looms = []; // [label, path]
if (mode === "tarball") {
  const tar = run("tar", ["-xzOf", artifact, "package/package.json"], tmp);
  if (!check("the tarball carries package.json", tar.code === 0, `exit=${String(tar.code)}`)) finish();
  expectedVersion = JSON.parse(tar.out).version;

  const project = join(tmp, "project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "stranger", version: "1.0.0", private: true }));
  const local = run("npm", ["install", "--offline", "--no-audit", "--no-fund", artifact], project);
  check("npm install --offline <tgz>", local.code === 0, local.code === 0 ? "installed" : oneLine(local.err));
  looms.push(["local", join(project, "node_modules", ".bin", "loom")]);

  // README's first example is a LIBRARY import, which no `loom` command exercises: the `"."` and
  // `"./cli"` exports of the installed package, resolved by Node from the stranger's project.
  const lib = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const m = await import("@caohaotiantian/loom"); const c = await import("@caohaotiantian/loom/cli");' +
        "console.log(typeof m.agent, typeof m.compile, typeof c.main);",
    ],
    project,
  );
  check("import the installed package (\".\" and \"./cli\")", lib.code === 0 && lib.out === "function function function\n", `exit=${String(lib.code)} ${oneLine(lib.out + lib.err)}`);

  const prefix = join(tmp, "global");
  const global = run("npm", ["install", "-g", "--offline", "--no-audit", "--no-fund", "--prefix", prefix, artifact], tmp);
  check("npm install -g --prefix <dir> <tgz>", global.code === 0, global.code === 0 ? "installed" : oneLine(global.err));
  looms.push(["global", join(prefix, "bin", "loom")]);
} else {
  expectedVersion = JSON.parse(readFileSync(join(repoRoot, "packages", "core", "package.json"), "utf8")).version;
  const dir = join(tmp, "loom-binary");
  mkdirSync(dir);
  const copy = join(dir, basename(artifact));
  copyFileSync(artifact, copy);
  chmodSync(copy, 0o755);
  looms.push(["binary", copy]);
  // AND UNDER ANOTHER NAME, which is how a release names a binary (`loom-0.1.0-darwin-arm64`). The
  // entry-point test used to compare the executable's basename with `loom`, so a renamed binary
  // printed nothing and exited 0 — measured on the 2026-09-23 lane.
  const renamed = join(dir, "loom-renamed-by-a-release");
  copyFileSync(artifact, renamed);
  chmodSync(renamed, 0o755);
  looms.push(["renamed binary", renamed]);
}

// ── 1–3. where it is, what it says it is ─────────────────────────────────────
for (const [label, loom] of looms) {
  let real = "";
  try {
    real = realpathSync(loom);
  } catch (e) {
    real = `(does not resolve: ${String(e)})`;
  }
  check(`${label}: loom resolves outside the repository`, real.startsWith(tmp + sep) && !real.startsWith(repoRoot + sep), real);
  const v = run(loom, ["--version"], tmp);
  check(`${label}: loom --version`, v.code === 0 && v.out === `loom ${expectedVersion}\n`, `exit=${String(v.code)} ${JSON.stringify(v.out)}`);
  const h = run(loom, ["--help"], tmp);
  check(`${label}: loom --help`, h.code === 0 && h.out.split("\n")[0] === HELP_FIRST_LINE, `exit=${String(h.code)} ${JSON.stringify(h.out.split("\n")[0])}`);
}
// ── the README's own examples ────────────────────────────────────────────────
function readmeGraph(file) {
  const re = new RegExp(`cat > ${file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} <<'EOF'\\n([\\s\\S]*?)\\nEOF`);
  const m = re.exec(README);
  if (m === null) throw new Error(`README.md no longer creates ${file} — this script reads its examples from there`);
  return m[1];
}
function readmeInput(file) {
  const m = new RegExp(`^loom run\\s+${file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} --input '([^']*)'`, "m").exec(README);
  if (m === null) throw new Error(`README.md no longer runs ${file} with --input — this script reads the input from there`);
  return m[1];
}
function json(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Steps 4 and 5, through ONE installed `loom`, in a workspace of its own. */
function examples(label, loom) {
  const ws = join(tmp, `demo-${label.replace(/\W+/g, "-")}`);
  mkdirSync(join(ws, "graphs"), { recursive: true });

  // ── 4. "Try it" ───────────────────────────────────────────────────────────────
  writeFileSync(join(ws, "graphs", "copy.json"), readmeGraph("graphs/copy.json"));
  writeFileSync(join(ws, "input.txt"), "hello\n"); // README: `echo hello > input.txt`
  {
    const c = run(loom, ["compile", "graphs/copy.json"], ws);
    check(`${label}: README copy.json: loom compile`, c.code === 0, `exit=${String(c.code)} ${oneLine(c.out + c.err)}`);
    const r = run(loom, ["run", "graphs/copy.json", "--input", readmeInput("graphs/copy.json")], ws);
    const out = json(r.out);
    check(`${label}: README copy.json: loom run`, r.code === 0 && out?.status === "succeeded", `exit=${String(r.code)} status=${String(out?.status)}`);
    let copied = "";
    try {
      copied = readFileSync(join(ws, "out", "copy.txt"), "utf8");
    } catch (e) {
      copied = `(unreadable: ${String(e)})`;
    }
    check(`${label}: README copy.json: out/copy.txt equals input.txt`, copied === "hello\n", JSON.stringify(copied));
    if (typeof out?.runId === "string") {
      const rp = run(loom, ["replay", out.runId], ws);
      const verdict = json(rp.out);
      check(`${label}: README copy.json: loom replay ${out.runId}`, rp.code === 0 && verdict?.match === true, `exit=${String(rp.code)} match=${String(verdict?.match)}`);
    } else {
      check(`${label}: README copy.json: loom replay <runId>`, false, "the run printed no runId");
    }
  }

  // ── 5. the gated example ──────────────────────────────────────────────────────
  writeFileSync(join(ws, "graphs", "gated.json"), readmeGraph("graphs/gated.json"));
  {
    const c = run(loom, ["compile", "graphs/gated.json"], ws);
    check(`${label}: README gated.json: loom compile`, c.code === 0, `exit=${String(c.code)} ${oneLine(c.out + c.err)}`);
    const r = run(loom, ["run", "graphs/gated.json", "--input", readmeInput("graphs/gated.json")], ws);
    const out = json(r.out);
    const shipped = join(ws, "shipped.txt");
    check(
      `${label}: README gated.json: loom run stops at the gate with nothing written`,
      out?.status === "awaiting_gate" && statSync(shipped, { throwIfNoEntry: false }) === undefined,
      `exit=${String(r.code)} status=${String(out?.status)}`,
    );
    // The command to answer it is printed verbatim; the smoke takes the ids from there, the way a
    // reader would copy them.
    const m = /loom approve (\S+) (\S+) --as/.exec(r.out + r.err);
    if (check(`${label}: README gated.json: the run prints the approve command`, m !== null, m === null ? oneLine(r.out + r.err) : m[0])) {
      const a = run(loom, ["approve", m[1], m[2], "--as", "u:alice"], ws);
      let body = "";
      try {
        body = readFileSync(shipped, "utf8");
      } catch (e) {
        body = `(unreadable: ${String(e)})`;
      }
      check(`${label}: README gated.json: loom approve --as u:alice lands the write`, a.code === 0 && body === "ship it", `exit=${String(a.code)} shipped.txt=${JSON.stringify(body)}`);
    }
  }
}

for (const [label, loom] of looms) examples(label, loom);

finish();
