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
 *
 * Because it is that pipeline's first and last word, every arm here fails CLOSED: a
 * schema this file cannot understand, a keyword of the wrong shape, or a key named
 * after a prototype member produces an error, never a silent pass. The alternative
 * is a validate step that is an identity function on exactly the inputs designed to
 * slip past it.
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

/** The one key that is never data: assigning it re-parents the object it lands in. */
const PROTO = "__proto__";

const TYPES: ReadonlySet<string> = new Set(["object", "string", "number", "integer", "boolean", "array", "null"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Write a key without ever going through a setter — `out[PROTO] = x` is not an assignment. */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * `type` is optional in JSON Schema, and the schema most often written without one
 * — `{properties, required}` — means "an object shaped like this", not "anything at
 * all". Reading the intent off the keywords the schema DOES carry is the difference
 * between a checked argument and an unchecked one, and it is where a validator that
 * switches on `type` alone quietly stops validating.
 */
function effectiveType(schema: JSONSchema): JSONSchema["type"] | "unsupported" | undefined {
  const declared: unknown = schema.type;
  if (declared !== undefined) return TYPES.has(declared as string) ? (declared as JSONSchema["type"]) : "unsupported";
  if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) return "object";
  if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) return "array";
  if (schema.minLength !== undefined || schema.maxLength !== undefined) return "string";
  if (schema.minimum !== undefined || schema.maximum !== undefined) return "number";
  return undefined;
}

/**
 * The arm for values no keyword constrains. It still owns its output: the caller
 * gets a copy, so a reference kept from before validation cannot rewrite the
 * arguments afterwards and a re-validate has something of its own to check. And it
 * refuses `__proto__` at any depth — no tool argument is named that, and an object
 * carrying one is aimed at whatever merges it later.
 *
 * Values that are not plain objects or arrays (a Date, a Map) pass by reference:
 * copying them faithfully is a serialization problem, and they are not the shape a
 * pollution payload arrives in. A cycle stops the walk for the same reason.
 */
function passThrough(value: unknown, where: string, errors: string[], open: Set<object> = new Set()): unknown {
  if (Array.isArray(value)) {
    if (open.has(value)) return value;
    open.add(value);
    const out = value.map((v, i) => passThrough(v, `${where}[${i}]`, errors, open));
    open.delete(value);
    return out;
  }
  if (!isRecord(value)) return value;
  if (open.has(value)) return value;
  open.add(value);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === PROTO) {
      errors.push(`${where}.${PROTO} is not a permitted property name`);
      continue;
    }
    define(out, key, passThrough(value[key], `${where}.${key}`, errors, open));
  }
  open.delete(value);
  return out;
}

function check(schema: JSONSchema, value: unknown, path: string, errors: string[]): unknown {
  const where = path === "" ? "value" : path;

  // A schema arrives from a tool manifest or a GraphSpec's `outputSchema`, both of
  // which are parsed, not constructed — so the declared type is a claim, not a fact.
  const shape: unknown = schema;
  if (!isRecord(shape)) {
    errors.push(`${where} was checked against a schema that is not an object`);
    return value;
  }

  if (value === undefined && schema.default !== undefined) return schema.default;

  const members = schema.enum;
  if (members !== undefined) {
    if (!Array.isArray(members)) {
      errors.push(`${where} has a schema whose "enum" is not an array`);
      return value;
    }
    if (!members.some((e: unknown) => e === value)) {
      errors.push(`${where} must be one of ${members.map((e: unknown) => JSON.stringify(e)).join(", ")}`);
    }
    return value;
  }

  const type = effectiveType(schema);
  if (type === "unsupported") {
    errors.push(`${where} has an unsupported schema type ${JSON.stringify(schema.type)}`);
    return value;
  }

  switch (type) {
    case undefined:
      return passThrough(value, where, errors);

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
        errors.push(`${where} must be a ${type}`);
        return value;
      }
      if (type === "integer" && !Number.isInteger(n)) {
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
      const items = schema.items;
      if (items === undefined) return passThrough(value, where, errors);
      return value.map((item, i) => check(items, item, `${where}[${i}]`, errors));
    }

    case "object": {
      if (!isRecord(value)) {
        errors.push(`${where} must be an object`);
        return value;
      }
      const props = schema.properties;
      if (props !== undefined && !isRecord(props)) {
        errors.push(`${where} has a schema whose "properties" is not an object`);
        return value;
      }
      const required = schema.required;
      if (required !== undefined && !Array.isArray(required)) {
        errors.push(`${where} has a schema whose "required" is not an array`);
        return value;
      }

      // No shape at all means "it is an object" and nothing more — every key passes
      // through. Only a DECLARED shape makes an undeclared key stray. Without this
      // distinction `{type:"object"}` silently means "the empty object", which is
      // never what anyone writing that schema intended.
      // `required` WITHOUT `properties` constrains which keys must be PRESENT; it does
      // not declare the shape. Treating it as a declaration made every key undeclared,
      // and undeclared keys are dropped — so `{required: ["a"]}` returned `{}` for an
      // input that satisfied it. Check the requirement, then treat the value as open.
      if (props === undefined && schema.additionalProperties !== false) {
        for (const key of required ?? []) {
          if (key === PROTO) {
            errors.push(`${where}.${PROTO} is not a permitted property name`);
            continue;
          }
          if (!Object.hasOwn(value, key)) errors.push(`${where}.${key} is required`);
        }
        return passThrough(value, where, errors);
      }

      const declared: Readonly<Record<string, JSONSchema>> = props ?? {};
      const out: Record<string, unknown> = {};

      // `Object.hasOwn`, not `in`, everywhere below. `in` walks the prototype chain,
      // so `"constructor" in args` is true of every object: membership tests written
      // that way report properties nobody supplied and miss the ones they did.
      for (const key of required ?? []) {
        if (key === PROTO) {
          errors.push(`${where}.${PROTO} is not a permitted property name`);
          continue;
        }
        if (!Object.hasOwn(value, key) && declared[key]?.default === undefined) {
          errors.push(`${where}.${key} is required`);
        }
      }

      for (const key of Object.keys(declared)) {
        if (key === PROTO) {
          errors.push(`${where}.${PROTO} is not a permitted property name`);
          continue;
        }
        const sub = declared[key];
        if (sub === undefined) continue;
        const has = Object.hasOwn(value, key);
        if (!has && sub.default === undefined) continue;
        const v = check(sub, has ? value[key] : undefined, `${where}.${key}`, errors);
        if (v !== undefined) define(out, key, v);
      }

      // Unknown keys are dropped rather than rejected by default: a model adding a
      // stray field should not fail a call, but it must not reach the tool either.
      const additional = schema.additionalProperties;
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(declared, key)) continue;
        if (key === PROTO) {
          errors.push(`${where}.${PROTO} is not a permitted property name`);
          continue;
        }
        if (additional === true) define(out, key, passThrough(value[key], `${where}.${key}`, errors));
        else if (additional === false) errors.push(`${where}.${key} is not a permitted property`);
      }
      return out;
    }
  }
  // Unreachable while the switch stays exhaustive over `effectiveType`, but
  // `noImplicitReturns` is right to insist: a type this file forgot to handle must
  // pass the value through rather than turn it into `undefined`.
  return value;
}
