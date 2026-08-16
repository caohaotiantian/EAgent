/**
 * Reading an interface's members out of TypeScript source, without a TypeScript parser.
 *
 * Shared by the two guards that both need the question answered and would otherwise answer
 * it twice: `docs-type-equiv.test.ts` compares a design block against the code, and
 * `docs-drift.test.ts` needs it to decide whether a marked member is REALLY absent — a
 * marker that outlives its gap is the failure mode that registry exists to prevent.
 *
 * Deliberately not the TypeScript compiler API. These guards run under Node's type
 * stripping with no build step, and the two properties they rely on — a member's presence
 * and its optionality — are recoverable by brace-counting. A parser would be more correct
 * and would make the guards depend on the thing they are checking.
 */

/** Strip line comments and block comments so a member scan is not fooled by prose. */
export function decomment(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The body of `export interface <name> { … }`, brace-balanced.
 *
 * A regex cannot find the closing brace of a nested type literal, and several of these
 * interfaces have one (`compensation?: { readonly tool: string }`). Counting is the whole
 * of it; strings and comments are removed first so a brace inside either cannot unbalance
 * the count.
 */
export function interfaceBody(text: string, name: string): string | undefined {
  const re = new RegExp(`export\\s+interface\\s+${name}\\b[^{]*\\{`, "m");
  const m = re.exec(text);
  if (m === null) return undefined;
  const start = m.index + m[0].length;
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i);
    }
  }
  return undefined;
}

/**
 * Top-level member names of an interface body, with whether each is optional.
 *
 * Only depth 0: a nested object literal's fields belong to that literal, not to the
 * interface, and counting them would report drift whenever a doc simplified an inline shape.
 */
export function members(body: string, honourMarkers = false): Map<string, boolean> {
  const out = new Map<string, boolean>();
  // A member the design marks DESIGNED-NOT-BUILT is a deliberate statement about the gap,
  // not a claim about the code — the same registry `docs-drift.test.ts` governs. Skipping
  // it here keeps the two guards saying the same thing about the same fields.
  const kept = honourMarkers
    ? body
        .split("\n")
        .filter((l) => !l.includes("DESIGNED-NOT-BUILT") && !l.includes("NOT-IN-CODE"))
        .join("\n")
    : body;
  const clean = decomment(kept);
  let depth = 0;
  let line = "";
  for (const ch of clean) {
    if (ch === "{" || ch === "(" || ch === "[" || ch === "<") depth++;
    else if (ch === "}" || ch === ")" || ch === "]" || ch === ">") depth--;
    if ((ch === ";" || ch === "\n") && depth === 0) {
      const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??)\s*[:(]/.exec(line);
      if (m !== null) out.set(m[1]!, m[2] === "?");
      line = "";
    } else line += ch;
  }
  const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??)\s*[:(]/.exec(line);
  if (m !== null) out.set(m[1]!, m[2] === "?");
  return out;
}

/**
 * An interface's members INCLUDING everything it inherits.
 *
 * `ToolDefinition extends ToolManifestLite` and the manifest half carries `name`, `version`,
 * `capabilities`, `irreversibility`, `idempotent` and `compensation` — six of the nine
 * members a first version of this guard reported as missing from the code. Following
 * `extends` is not a refinement; without it the guard is simply wrong about every interface
 * that has a base.
 */
export function membersDeep(src: string, name: string, seen = new Set<string>()): Map<string, boolean> {
  if (seen.has(name)) return new Map();
  seen.add(name);
  const body = interfaceBody(src, name);
  if (body === undefined) return new Map();
  const out = members(body);
  const ext = new RegExp(`export\\s+interface\\s+${name}\\b\\s+extends\\s+([^{]+)\\{`, "m").exec(src);
  if (ext !== null) {
    for (const base of ext[1]!.split(",").map((x) => x.trim().replace(/<.*/, "")).filter(Boolean)) {
      for (const [k, v] of membersDeep(src, base, seen)) if (!out.has(k)) out.set(k, v);
    }
  }
  return out;
}

