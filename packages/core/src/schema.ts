/**
 * A minimal JSON Schema subset — enough to describe and validate tool arguments.
 *
 * Deliberately small: the goal is to reject a malformed tool call before it reaches
 * a sandbox, not to implement a spec. Anything it cannot express (oneOf, $ref
 * resolution, format assertions) is a signal that the tool's argument shape is too
 * clever, not that this file needs to grow.
 *
 * Validation runs TWICE in the tool pipeline — before policy, and again after a hook
 * may have rewritten the arguments — so a guard that repairs a call is honoured and
 * a guard that corrupts one is caught.
 */

export interface JSONSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  description?: string;
  enum?: readonly unknown[];
  properties?: Readonly<Record<string, JSONSchema>>;
  required?: readonly string[];
  items?: JSONSchema;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean;
  [extra: string]: unknown;
}

export type ValidationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate and lightly coerce. Coercion is limited to what a model reliably gets
 * wrong — a numeric string where a number was asked for — and never to anything
 * lossy. Defaults from the schema are filled in, so a tool body can rely on them.
 */
export function validate(schema: JSONSchema, value: unknown): ValidationResult {
  const errors: string[] = [];
  const out = check(schema, value, "", errors);
  return errors.length === 0 ? { ok: true, value: out } : { ok: false, errors };
}

function check(schema: JSONSchema, value: unknown, path: string, errors: string[]): unknown {
  const where = path === "" ? "value" : path;

  if (value === undefined && schema.default !== undefined) return schema.default;

  if (schema.enum !== undefined) {
    if (!schema.enum.some((e) => e === value)) {
      errors.push(`${where} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    }
    return value;
  }

  switch (schema.type) {
    case undefined:
      return value;

    case "null":
      if (value !== null) errors.push(`${where} must be null`);
      return value;

    case "boolean":
      if (typeof value !== "boolean") errors.push(`${where} must be a boolean`);
      return value;

    case "string": {
      if (typeof value !== "string") {
        errors.push(`${where} must be a string`);
        return value;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${where} must be at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${where} must be at most ${schema.maxLength} characters`);
      }
      return value;
    }

    case "number":
    case "integer": {
      // The one sanctioned coercion: models emit "3" for 3 often enough that
      // rejecting it costs a turn for no safety benefit.
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) {
        errors.push(`${where} must be a ${schema.type}`);
        return value;
      }
      if (schema.type === "integer" && !Number.isInteger(n)) {
        errors.push(`${where} must be an integer`);
        return n;
      }
      if (schema.minimum !== undefined && n < schema.minimum) errors.push(`${where} must be ≥ ${schema.minimum}`);
      if (schema.maximum !== undefined && n > schema.maximum) errors.push(`${where} must be ≤ ${schema.maximum}`);
      return n;
    }

    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${where} must be an array`);
        return value;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${where} must have at least ${schema.minItems} items`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${where} must have at most ${schema.maxItems} items`);
      }
      if (schema.items === undefined) return value;
      return value.map((item, i) => check(schema.items!, item, `${where}[${i}]`, errors));
    }

    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${where} must be an object`);
        return value;
      }
      const input = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};

      for (const key of schema.required ?? []) {
        if (!(key in input) && schema.properties?.[key]?.default === undefined) {
          errors.push(`${where}.${key} is required`);
        }
      }
      const props = schema.properties ?? {};
      for (const [key, sub] of Object.entries(props)) {
        const has = key in input;
        if (!has && sub.default === undefined) continue;
        const v = check(sub, has ? input[key] : undefined, `${where}.${key}`, errors);
        if (v !== undefined) out[key] = v;
      }
      // Unknown keys are dropped rather than rejected by default: a model adding a
      // stray field should not fail a call, but it must not reach the tool either.
      if (schema.additionalProperties === true) {
        for (const [key, v] of Object.entries(input)) if (!(key in props)) out[key] = v;
      } else if (schema.additionalProperties === false) {
        for (const key of Object.keys(input)) {
          if (!(key in props)) errors.push(`${where}.${key} is not a permitted property`);
        }
      }
      return out;
    }
  }
  // Unreachable while `type` stays a closed union, but `noImplicitReturns` is right
  // to insist: an unknown `type` must pass the value through, not return undefined.
  return value;
}
