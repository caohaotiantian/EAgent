/**
 * A deliberately small JSON-Schema validator/coercer covering the subset that
 * tool arguments actually use. Not a spec-complete implementation — a focused
 * one that gives clear errors and stays dependency-free.
 *
 * LLMs frequently emit numbers as strings ("3" instead of 3) and omit optional
 * fields; we coerce the former and fill defaults for the latter so tools see
 * clean, typed input.
 */

import type { JSONSchema } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  value: unknown;
  errors: string[];
}

export function validate(schema: JSONSchema, input: unknown, path = "$"): ValidationResult {
  const errors: string[] = [];
  const value = walk(schema, input, path, errors);
  return { ok: errors.length === 0, value, errors };
}

function walk(schema: JSONSchema, input: unknown, path: string, errors: string[]): unknown {
  if (input === undefined && schema.default !== undefined) {
    input = structuredCloneSafe(schema.default);
  }

  const value = coerce(schema, input, path, errors);

  // enum membership is checked AFTER coercion so a wire string ("2") matches a
  // numeric enum ([1,2,3]) once the type rule has turned it into a number.
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${render(value)}`);
  }

  return value;
}

function coerce(schema: JSONSchema, input: unknown, path: string, errors: string[]): unknown {
  switch (schema.type) {
    case "object":
      return walkObject(schema, input, path, errors);
    case "array":
      return walkArray(schema, input, path, errors);
    case "string":
      if (typeof input !== "string") {
        errors.push(`${path}: expected string, got ${render(input)}`);
        return input;
      }
      checkString(schema, input, path, errors);
      return input;
    case "number":
    case "integer": {
      const n = coerceNumber(input);
      if (n === undefined) {
        errors.push(`${path}: expected ${schema.type}, got ${render(input)}`);
        return input;
      }
      if (schema.type === "integer" && !Number.isInteger(n)) {
        errors.push(`${path}: expected integer, got ${render(input)}`);
      }
      checkNumber(schema, n, path, errors);
      return n;
    }
    case "boolean": {
      const b = coerceBoolean(input);
      if (b === undefined) {
        errors.push(`${path}: expected boolean, got ${render(input)}`);
        return input;
      }
      return b;
    }
    case "null":
      if (input !== null) errors.push(`${path}: expected null, got ${render(input)}`);
      return input;
    default:
      // No type constraint — accept as-is.
      return input;
  }
}

// Numeric bounds — enforced only when the schema declares them.
function checkNumber(schema: JSONSchema, n: number, path: string, errors: string[]): void {
  const { minimum, maximum } = schema;
  if (typeof minimum === "number" && n < minimum) {
    errors.push(`${path}: ${n} is less than minimum ${minimum}`);
  }
  if (typeof maximum === "number" && n > maximum) {
    errors.push(`${path}: ${n} is greater than maximum ${maximum}`);
  }
}

// String length/pattern — enforced only when the schema declares them.
function checkString(schema: JSONSchema, s: string, path: string, errors: string[]): void {
  const { minLength, maxLength, pattern } = schema;
  if (typeof minLength === "number" && s.length < minLength) {
    errors.push(`${path}: string length ${s.length} is below minLength ${minLength}`);
  }
  if (typeof maxLength === "number" && s.length > maxLength) {
    errors.push(`${path}: string length ${s.length} exceeds maxLength ${maxLength}`);
  }
  if (typeof pattern === "string" && !new RegExp(pattern).test(s)) {
    errors.push(`${path}: ${render(s)} does not match pattern ${pattern}`);
  }
}

function walkObject(schema: JSONSchema, input: unknown, path: string, errors: string[]): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    errors.push(`${path}: expected object, got ${render(input)}`);
    return input;
  }
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const props = schema.properties ?? {};

  for (const [key, propSchema] of Object.entries(props)) {
    const childPath = `${path}.${key}`;
    if (key in src || propSchema.default !== undefined) {
      out[key] = walk(propSchema, src[key], childPath, errors);
    }
  }
  // Unknown properties: rejected when the schema sets `additionalProperties:false`,
  // otherwise preserved — tools may accept open-ended input, and silently
  // discarding data is worse than passing it on.
  const closed = schema.additionalProperties === false;
  for (const [key, val] of Object.entries(src)) {
    if (key in props) continue;
    if (closed) errors.push(`${path}.${key}: unexpected property (additionalProperties is false)`);
    else out[key] = val;
  }

  for (const req of schema.required ?? []) {
    if (out[req] === undefined) errors.push(`${path}.${req}: required property missing`);
  }
  return out;
}

function walkArray(schema: JSONSchema, input: unknown, path: string, errors: string[]): unknown {
  if (!Array.isArray(input)) {
    errors.push(`${path}: expected array, got ${render(input)}`);
    return input;
  }
  if (!schema.items) return input;
  return input.map((item, i) => walk(schema.items!, item, `${path}[${i}]`, errors));
}

function coerceNumber(input: unknown): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  if (typeof input === "string" && input.trim() !== "") {
    const n = Number(input);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function coerceBoolean(input: unknown): boolean | undefined {
  if (typeof input === "boolean") return input;
  if (input === "true") return true;
  if (input === "false") return false;
  return undefined;
}

function render(input: unknown): string {
  if (input === undefined) return "undefined";
  if (typeof input === "object") return Array.isArray(input) ? "array" : "object";
  return JSON.stringify(input);
}

function structuredCloneSafe<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return v;
  }
}
