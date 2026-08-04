/**
 * Redaction at emit time, and secrets that cannot be interpolated by accident.
 *
 * Two mechanisms, in order of how much they are trusted:
 *
 *   1. **Declared classification.** Channels and tool schema fields carry a
 *      `Classification`, so most redaction is a lookup, not a guess. This is the
 *      primary mechanism and the only one that is reliable.
 *
 *   2. **A detector sweep** over unclassified free text. This is a BACKSTOP for model
 *      output and it WILL have false negatives — which is exactly why secrets are
 *      never plain strings in the first place (see `SecretValue`).
 *
 * The ordering matters: a design that leads with detection is a design that has
 * already accepted leaks.
 *
 * NOTE ON PURPOSE. This exists to stop a credential or a personal detail in MODEL
 * OUTPUT from reaching a span or a browser. It is not an erasure mechanism and the
 * journal is never redacted — `state.reduced` payloads ARE the channel state, so a
 * redacted journal folds to corrupted state.
 *
 * See design/loom/05-RESOURCES-OBSERVABILITY.md D9.6.
 */

import { digestOf } from "../canonical.ts";
import type { Classification } from "../vocab.ts";

/**
 * A secret that cannot be stringified.
 *
 * `toString`, `toJSON`, template interpolation, and `util.inspect` all yield
 * `[secret]`. So an accidental `` `Bearer ${token}` `` produces `Bearer [secret]` — a
 * broken request, which someone notices — rather than a leaked credential in a
 * journal payload, which nobody notices.
 */
export class SecretValue {
  readonly #value: string;
  readonly ref: string;

  constructor(value: string, ref: string) {
    this.#value = value;
    this.ref = ref;
  }

  /** The ONLY way to read it. Named so it is greppable in review. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[secret]";
  }
  toJSON(): string {
    return "[secret]";
  }
  get [Symbol.toStringTag](): string {
    return "SecretValue";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SecretValue(${this.ref})`;
  }
}

export function isSecret(v: unknown): v is SecretValue {
  return v instanceof SecretValue;
}

// ---------------------------------------------------------------------------
// Detectors — the backstop, not the plan
// ---------------------------------------------------------------------------

interface Detector {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * Deliberately conservative and few.
 *
 * A long list of clever patterns produces false positives, which train people to
 * ignore redaction; these are shapes that are essentially never legitimate content.
 */
const DETECTORS: readonly Detector[] = [
  { name: "pem", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "aws-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "provider-key", pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g },
];

export interface RedactionResult {
  readonly value: unknown;
  /** Detector names that fired. Non-empty means the DECLARED path missed something. */
  readonly hits: readonly string[];
}

/**
 * Redact a value for emission.
 *
 * `pii` becomes a stable token — `pii:sha256:<12>:string:<len>` — so two occurrences
 * of the same value still correlate across a trace without the value being present.
 * Correlation without disclosure is what makes a redacted trace debuggable at all.
 */
export function redact(value: unknown, classification: Classification = "internal"): RedactionResult {
  const hits: string[] = [];
  const out = walk(value, classification, hits, 0);
  return { value: out, hits: [...new Set(hits)].sort() };
}

function walk(value: unknown, classification: Classification, hits: string[], depth: number): unknown {
  // A pathological payload must not blow the stack in the redactor of all places.
  if (depth > 32) return "[depth-limit]";

  if (isSecret(value)) {
    hits.push("secret-value");
    // The ref is already fully qualified (`secret://env/NAME`); re-prefixing it
    // would produce a ref that resolves to nothing.
    return value.ref;
  }
  if (classification === "secret_ref") {
    hits.push("secret-classified");
    return "[secret]";
  }

  if (typeof value === "string") {
    if (classification === "pii") return piiToken(value);
    return sweep(value, hits);
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, classification, hits, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A key that names a secret redacts its value whatever the declared
      // classification says — belt and braces for hand-built payloads.
      out[k] = SECRETISH_KEY.test(k) ? "[secret]" : walk(v, classification, hits, depth + 1);
      if (SECRETISH_KEY.test(k)) hits.push("secretish-key");
    }
    return out;
  }
  return value;
}

const SECRETISH_KEY = /^(?:.*_)?(?:password|passwd|secret|token|api[_-]?key|authorization|credential)s?$/i;

function piiToken(value: string): string {
  // Stable across occurrences, so a trace still correlates; irreversible, so the
  // value is not recoverable from the token.
  return `pii:${digestOf(value).slice(7, 19)}:string:${value.length}`;
}

function sweep(text: string, hits: string[]): string {
  let out = text;
  for (const d of DETECTORS) {
    // `replace` with a global regex is stateless here because a fresh string is
    // produced each pass; `test` on a /g regex would carry lastIndex and miss.
    const replaced = out.replace(d.pattern, `[redacted:${d.name}]`);
    if (replaced !== out) hits.push(d.name);
    out = replaced;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emit-time hooks
// ---------------------------------------------------------------------------

/** Redact a journal payload before it is written. */
export function redactPayload(payload: unknown, classification: Classification): unknown {
  return redact(payload, classification).value;
}

/**
 * Redact span attributes before they leave the process.
 *
 * Applied per attribute rather than to the whole bag, so a `pii`-classified attribute
 * tokenises while its neighbours keep their detector sweep.
 */
export function redactAttributes(
  attrs: Readonly<Record<string, unknown>>,
  classifications: Readonly<Record<string, Classification>> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = redact(v, classifications[k] ?? "internal").value;
  }
  return out;
}

/**
 * A secret provider that hands back `SecretValue`s.
 *
 * `env` and `file` are the v1 backends; Vault and the K8s CSI driver are the v2 swap
 * behind the same signature.
 */
export interface SecretProvider {
  resolve(ref: string): SecretValue;
}

export function envSecretProvider(env: Readonly<Record<string, string | undefined>> = process.env): SecretProvider {
  return {
    resolve(ref: string): SecretValue {
      // `secret://env/NAME`
      const name = ref.replace(/^secret:\/\/env\//, "");
      const value = env[name];
      if (value === undefined) throw new Error(`secret "${ref}" is not set`);
      return new SecretValue(value, ref);
    },
  };
}
