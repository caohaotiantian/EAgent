/**
 * decode-normalize — the shared pre-inspection decode layer.
 *
 * `bash-policy` and `risk-guard` both inspect *literal* command text only, so a
 * destructive payload hidden behind a benign-looking wrapper slips past both:
 * `echo cm0gLXJmIC8=|base64 -d|sh` shows only `echo`/`base64`/`sh`, yet the blob
 * decodes to `rm -rf /`. `normalizeForInspection(text)` widens the inspection
 * candidate set: it strips invisible-injection Unicode (reusing
 * `content-guard`'s `stripInvisible`) and best-effort decodes the documented
 * shell-obfuscation idioms — base64, hex, rot13, `echo <b64>|base64 -d|sh`,
 * `printf '\xNN'` — bounded to two layers.
 *
 * It is a pure library: no capability, no side effects, never throws (fail-open),
 * and NEVER itself decides allow/deny/ask — it only returns extra candidate
 * strings the *existing* rules / LLM judge evaluate. Because the decoders are
 * total (rot13 always produces output; `Buffer.from(s,"base64"|"hex")` silently
 * yields garbage bytes rather than throwing), an explicit **emit gate** decides
 * which decodes are surfaced: a candidate is kept only if it (1) decodes to valid
 * UTF-8 that round-trips on re-encode (byte-decoders) and (2) is command-plausible
 * — differs from the raw input and has a syntactically valid first command word,
 * strengthened to a *known command family* for the always-total rot13 permutation.
 *
 * Consumed by `bash-policy` (candidate-set union) and `risk-guard` (judge-prompt
 * annotation); toggled off with `EAGENT_DECODE_NORMALIZE=off` in those guards.
 */

import { stripInvisible } from "../content-guard.js";

/** Decode depth bound (D4): at most two layers, so a double-wrap is reached but a decode bomb is not. */
export const DECODE_DEPTH = 2;

/**
 * Known shell command families used to gate the always-total rot13 decoder
 * (D7 conjunct-2, reversible-alphabet tier). A rot13 decode is surfaced only when
 * its first token is one of these — `rot13("ls -la")` first token `yf` is not
 * known (dropped), `rot13("ez -es /")` first token `rm` is known (surfaced).
 */
const KNOWN_COMMANDS = new Set([
  "rm",
  "sh",
  "bash",
  "zsh",
  "dash",
  "curl",
  "wget",
  "dd",
  "chmod",
  "chown",
  "eval",
  "exec",
  "nc",
  "ncat",
  "python",
  "python3",
  "perl",
  "ruby",
  "node",
  "mkfs",
  "shred",
  "kill",
  "mv",
  "cp",
  "cat",
  "scp",
  "ssh",
  "base64",
  "openssl",
]);

/** A best-effort byte-decoder: returns the decoded text, or `undefined` on an unexpected throw. */
export function decodeBase64(s: string): string | undefined {
  try {
    return Buffer.from(s, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

/** A best-effort hex byte-decoder: returns the decoded text, or `undefined` on an unexpected throw. */
export function decodeHex(s: string): string | undefined {
  try {
    return Buffer.from(s, "hex").toString("utf8");
  } catch {
    return undefined;
  }
}

/** ROT13 over ASCII letters — total (always returns output; non-letters pass through). */
export function decodeRot13(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 65 && code <= 90) out += String.fromCharCode(((code - 65 + 13) % 26) + 65);
    else if (code >= 97 && code <= 122) out += String.fromCharCode(((code - 97 + 13) % 26) + 97);
    else out += s[i];
  }
  return out;
}

/** Parse a `\xNN` hex-escape sequence (the `printf` idiom payload) into its bytes. */
export function decodeHexEscapes(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** First whitespace-delimited token of a command line, or "" when empty. */
function firstToken(s: string): string {
  return s.trim().split(/\s+/)[0] ?? "";
}

/** A candidate is command-plausible iff its first token is a syntactically valid command word. */
const COMMAND_WORD = /^[\w./-]+$/;

/** True when `decoded` is valid UTF-8 that round-trips on re-encode in `enc` (no U+FFFD). */
function roundTrips(decoded: string, original: string, enc: BufferEncoding): boolean {
  if (decoded.includes("�")) return false;
  // Re-encode the decoded text and compare to the source bytes; mismatched
  // padding / non-canonical encodings fail to round-trip and are dropped.
  return Buffer.from(decoded, "utf8").toString(enc) === original;
}

/**
 * A produced candidate carrying how it was made, so the emit gate can apply the
 * right conjuncts: `kind: "byte"` (base64/hex/`\xNN`) is gated on valid-UTF-8 /
 * round-trip; `kind: "alpha"` (rot13) is gated on a known command family.
 */
type Candidate =
  | { kind: "byte"; text: string; source: string; enc: BufferEncoding }
  | { kind: "alpha"; text: string };

/**
 * The single D7 emit gate, applied to every produced candidate. Conjunct 1
 * (valid-UTF-8 / round-trip) does the work for byte-decoders; conjunct 2
 * (command-plausibility, strengthened to a known command family for the
 * reversible rot13 permutation) does the work for the always-total alphabet
 * decoder. Kept in ONE place (D7 rejects pushing it into each decoder).
 */
function passesGate(c: Candidate, raw: string): boolean {
  if (c.text === raw || c.text.trim() === "") return false;
  const token = firstToken(c.text);
  if (token === "" || token.includes("�") || !COMMAND_WORD.test(token)) return false;
  if (c.kind === "byte") {
    return roundTrips(c.text, c.source, c.enc);
  }
  // Reversible-alphabet decoder (rot13): strengthen to a known command family.
  return KNOWN_COMMANDS.has(token);
}

/** Scan for a plausible base64 token (length-4-multiple-ish run of base64 chars). */
const BASE64_TOKEN = /[A-Za-z0-9+/]{8,}={0,2}/g;

/**
 * Produce the raw candidate texts (decode attempts) for one input layer, each
 * tagged for the gate. The idiom matchers are substring scanners so they find a
 * blob embedded inside a larger string (required for risk-guard's JSON blob).
 */
function decodeLayer(text: string): Candidate[] {
  const out: Candidate[] = [];

  // Idiom: echo <b64>|base64 -d|sh — extract the base64 token after `echo`.
  const echoIdiom = /echo\s+([A-Za-z0-9+/]+={0,2})\s*\|\s*base64\s+-d/i.exec(text);
  if (echoIdiom?.[1]) {
    const dec = decodeBase64(echoIdiom[1]);
    if (dec !== undefined) out.push({ kind: "byte", text: dec, source: echoIdiom[1], enc: "base64" });
  }

  // Idiom: printf '\xNN…'(|sh) — extract the escape run and decode the bytes.
  // The gate's round-trip source is the bare hex (`\x` stripped) so the decoded
  // bytes re-encode (in `hex`) back to exactly the source token.
  const printfIdiom = /printf\s+'((?:\\x[0-9a-fA-F]{2})+)'/i.exec(text);
  if (printfIdiom?.[1]) {
    const bareHex = printfIdiom[1].replace(/\\x/g, "");
    out.push({ kind: "byte", text: decodeHexEscapes(printfIdiom[1]), source: bareHex, enc: "hex" });
  }

  // Embedded/whole-string base64 tokens.
  for (const m of text.matchAll(BASE64_TOKEN)) {
    const tok = m[0];
    const dec = decodeBase64(tok);
    if (dec !== undefined) out.push({ kind: "byte", text: dec, source: tok, enc: "base64" });
  }

  // Whole-string hex (a bare even-length hex run).
  if (/^[0-9a-fA-F]+$/.test(text.trim()) && text.trim().length % 2 === 0 && text.trim().length >= 4) {
    const tok = text.trim();
    const dec = decodeHex(tok);
    if (dec !== undefined) out.push({ kind: "byte", text: dec, source: tok, enc: "hex" });
  }

  // Whole-string rot13 over the command line.
  out.push({ kind: "alpha", text: decodeRot13(text) });

  return out;
}

/**
 * Decode/normalize `text` into the set of decoded inspection candidates. Strips
 * invisible-injection Unicode first (D1), then applies every decoder + idiom
 * matcher up to `DECODE_DEPTH` layers — re-feeding the *raw decoded bytes* of each
 * decode for one more layer (the gate decides what to *emit*, not what to recurse
 * on, so a `=`-padded intermediate still gets traversed). Returns the gated,
 * raw-excluded, deduped list. Pure, no capability, never throws (fail-open).
 */
export function normalizeForInspection(text: string): string[] {
  try {
    const stripped = stripInvisible(text).text;
    const emitted: string[] = [];
    // Raw-exclusion is against the ORIGINAL input: when stripInvisible removed
    // invisible-injection codepoints, the cleaned form differs from the original
    // and is itself a surfaced candidate (the obfuscated-`rm -rf /` case).
    const seen = new Set<string>([text]);
    if (stripped !== text && !seen.has(stripped)) {
      seen.add(stripped);
      emitted.push(stripped);
    }

    let frontier: string[] = [stripped];
    for (let depth = 0; depth < DECODE_DEPTH; depth++) {
      const next: string[] = [];
      for (const layer of frontier) {
        for (const cand of decodeLayer(layer)) {
          // Always traverse the decoded bytes for the next layer (bounded by depth).
          if (cand.text !== layer) next.push(cand.text);
          // Only emit candidates that pass the gate against the cleaned input.
          if (passesGate(cand, stripped) && !seen.has(cand.text)) {
            seen.add(cand.text);
            emitted.push(cand.text);
          }
        }
      }
      frontier = next;
    }

    return emitted;
  } catch {
    // Fail-open: a decode layer must never break the guard's beforeToolCall filter.
    return [];
  }
}
