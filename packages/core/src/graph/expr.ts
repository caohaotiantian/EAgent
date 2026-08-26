/**
 * The restricted expression language used by `when`, `until`, and router cases.
 *
 * Deliberately NOT JavaScript. It is total, terminating, side-effect free, and
 * statically type-checkable against channel schemas — which is exactly what makes
 * GRAPH004 (type compatibility) and GRAPH006 (termination) decidable at compile time.
 * A Turing-complete predicate language would make both undecidable, and "the graph,
 * not the model's context, decides what may happen next" would become unverifiable.
 *
 * Grammar (precedence low → high):
 *   or      := and ('||' and)*
 *   and     := equality ('&&' equality)*
 *   equality:= comparison (('=='|'!=') comparison)*
 *   compare := additive (('<'|'<='|'>'|'>=') additive)*
 *   additive:= multiplicative (('+'|'-') multiplicative)*
 *   mult    := unary (('*'|'/'|'%') unary)*
 *   unary   := ('!'|'-')* postfix
 *   postfix := primary ('.' IDENT | '[' or ']')*
 *   primary := NUMBER | STRING | 'true' | 'false' | 'null' | IDENT | call | '(' or ')'
 *   call    := IDENT '(' (or (',' or)*)? ')'
 *
 * No lambdas, no user function calls, no loops, no assignment, no property writes.
 *
 */

import { CODES, err } from "../errors.ts";

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type BinaryOp = "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%";
export type UnaryOp = "!" | "-";

export type Expr =
  | { readonly k: "lit"; readonly v: string | number | boolean | null }
  | { readonly k: "ref"; readonly name: string }
  | { readonly k: "member"; readonly obj: Expr; readonly prop: string }
  | { readonly k: "index"; readonly obj: Expr; readonly idx: Expr }
  | { readonly k: "unary"; readonly op: UnaryOp; readonly arg: Expr }
  | { readonly k: "binary"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }
  | { readonly k: "call"; readonly fn: BuiltinName; readonly args: readonly Expr[] };

/** The complete builtin set. No user-supplied functions, ever. */
export const BUILTINS = {
  /** Length of a string or array. */
  len: { arity: 1, returns: "number" },
  /** True when a reference resolves to a value that is neither undefined nor null. */
  has: { arity: 1, returns: "boolean" },
  /** True when every element of a boolean array is true. Empty array ⇒ true. */
  all: { arity: 1, returns: "boolean" },
  /** True when any element of a boolean array is true. Empty array ⇒ false. */
  any: { arity: 1, returns: "boolean" },
  /** Membership: contains(haystack, needle) over an array or string. */
  contains: { arity: 2, returns: "boolean" },
} as const;

export type BuiltinName = keyof typeof BUILTINS;

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Tok =
  | { t: "num"; v: number; i: number }
  | { t: "str"; v: string; i: number }
  | { t: "ident"; v: string; i: number }
  | { t: "op"; v: string; i: number }
  | { t: "eof"; i: number };

const OPERATORS = ["||", "&&", "==", "!=", "<=", ">=", "<", ">", "!", "+", "-", "*", "/", "%", "(", ")", "[", "]", ".", ","];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const esc = src[j + 1]!;
          value += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
          j += 2;
          continue;
        }
        value += src[j];
        j++;
      }
      if (j >= src.length) throw syntax(src, i, "unterminated string");
      out.push({ t: "str", v: value, i });
      i = j + 1;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < src.length && /[0-9._eE+-]/.test(src[j]!)) {
        // Stop before a `+`/`-` that is not part of an exponent, so `1-2` lexes as three tokens.
        if ((src[j] === "+" || src[j] === "-") && !/[eE]/.test(src[j - 1] ?? "")) break;
        j++;
      }
      const raw = src.slice(i, j);
      const n = Number(raw);
      if (!Number.isFinite(n)) throw syntax(src, i, `invalid number "${raw}"`);
      out.push({ t: "num", v: n, i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      out.push({ t: "ident", v: src.slice(i, j), i });
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op === undefined) throw syntax(src, i, `unexpected character "${ch}"`);
    out.push({ t: "op", v: op, i });
    i += op.length;
  }
  out.push({ t: "eof", i: src.length });
  return out;
}

function syntax(src: string, at: number, message: string): Error {
  return err.validation(CODES.E_EXPR_INVALID, `${message} at offset ${at} in \`${src}\``, {
    details: { source: src, offset: at },
  });
}

// ---------------------------------------------------------------------------
// Parser (precedence climbing)
// ---------------------------------------------------------------------------

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

export function parseExpr(src: string): Expr {
  const toks = lex(src);
  let pos = 0;

  const peek = (): Tok => toks[pos]!;
  const next = (): Tok => toks[pos++]!;
  const eatOp = (v: string): boolean => {
    const t = peek();
    if (t.t === "op" && t.v === v) {
      pos++;
      return true;
    }
    return false;
  };
  const expectOp = (v: string): void => {
    if (!eatOp(v)) throw syntax(src, peek().i, `expected "${v}"`);
  };

  function parseBinary(minPrec: number): Expr {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t.t !== "op") break;
      const prec = BINARY_PRECEDENCE[t.v];
      if (prec === undefined || prec < minPrec) break;
      pos++;
      // All operators here are left-associative, so the right operand binds tighter.
      const right = parseBinary(prec + 1);
      left = { k: "binary", op: t.v as BinaryOp, left, right };
    }
    return left;
  }

  function parseUnary(): Expr {
    const t = peek();
    if (t.t === "op" && (t.v === "!" || t.v === "-")) {
      pos++;
      return { k: "unary", op: t.v, arg: parseUnary() };
    }
    return parsePostfix();
  }

  function parsePostfix(): Expr {
    let e = parsePrimary();
    for (;;) {
      if (eatOp(".")) {
        const t = next();
        if (t.t !== "ident") throw syntax(src, t.i, "expected a property name after `.`");
        e = { k: "member", obj: e, prop: t.v };
        continue;
      }
      if (eatOp("[")) {
        const idx = parseBinary(1);
        expectOp("]");
        e = { k: "index", obj: e, idx };
        continue;
      }
      return e;
    }
  }

  function parsePrimary(): Expr {
    const t = next();
    if (t.t === "num") return { k: "lit", v: t.v };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "op" && t.v === "(") {
      const e = parseBinary(1);
      expectOp(")");
      return e;
    }
    if (t.t === "ident") {
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "null") return { k: "lit", v: null };
      if (peek().t === "op" && (peek() as { v: string }).v === "(") {
        pos++;
        // `in` walks the prototype chain, so `toString(1)` / `hasOwnProperty()` were once
        // accepted as builtin CALLS and then failed with "takes undefined argument(s)".
        if (!Object.hasOwn(BUILTINS, t.v)) {
          throw syntax(src, t.i, `unknown function "${t.v}" (builtins: ${Object.keys(BUILTINS).join(", ")})`);
        }
        const fn = t.v as BuiltinName;
        const args: Expr[] = [];
        if (!eatOp(")")) {
          do {
            args.push(parseBinary(1));
          } while (eatOp(","));
          expectOp(")");
        }
        if (args.length !== BUILTINS[fn].arity) {
          throw syntax(src, t.i, `${fn}() takes ${BUILTINS[fn].arity} argument(s), got ${args.length}`);
        }
        return { k: "call", fn, args };
      }
      return { k: "ref", name: t.v };
    }
    throw syntax(src, t.i, "expected a value");
  }

  const expr = parseBinary(1);
  if (peek().t !== "eof") throw syntax(src, peek().i, "unexpected trailing input");
  return expr;
}

// ---------------------------------------------------------------------------
// Static analysis
// ---------------------------------------------------------------------------

export type Ty = "string" | "number" | "boolean" | "object" | "array" | "null" | "unknown";

/** Every root identifier the expression reads. Drives GRAPH004's declared-reads check. */
export function referencedChannels(e: Expr): readonly string[] {
  const out = new Set<string>();
  const walk = (n: Expr): void => {
    switch (n.k) {
      case "ref":
        out.add(n.name);
        return;
      case "member":
        walk(n.obj);
        return;
      case "index":
        walk(n.obj);
        walk(n.idx);
        return;
      case "unary":
        walk(n.arg);
        return;
      case "binary":
        walk(n.left);
        walk(n.right);
        return;
      case "call":
        for (const a of n.args) walk(a);
        return;
      case "lit":
        return;
    }
  };
  walk(e);
  return [...out];
}

export interface TypeError {
  readonly message: string;
}

/**
 * Infer a type, collecting errors rather than throwing on the first.
 *
 * Member access on an `object` yields `unknown` on purpose: channel schemas are
 * JSON Schema and we do not require a full structural checker in v1. The precise
 * check that matters — "is this channel declared and readable here?" — is exact;
 * deep field typing is best-effort and permissive.
 */
export function inferType(e: Expr, channels: Readonly<Record<string, Ty>>, errors: TypeError[]): Ty {
  switch (e.k) {
    case "lit":
      return e.v === null ? "null" : (typeof e.v as Ty);

    case "ref": {
      // Own-property only, for the same reason `evaluate` is: `channels["constructor"]` found
      // `Object` on the prototype, so GRAPH004's unknown-channel check — its teeth — silently
      // accepted `constructor`, `toString`, `valueOf` and friends as declared channels.
      const t = own(channels, e.name) as Ty | undefined;
      if (t === undefined) {
        errors.push({ message: `unknown channel "${e.name}"` });
        return "unknown";
      }
      return t;
    }

    case "member": {
      const objT = inferType(e.obj, channels, errors);
      if (objT !== "object" && objT !== "unknown") {
        errors.push({ message: `cannot read property "${e.prop}" of a ${objT}` });
      }
      return "unknown";
    }

    case "index": {
      const objT = inferType(e.obj, channels, errors);
      const idxT = inferType(e.idx, channels, errors);
      if (objT === "array" && idxT !== "number" && idxT !== "unknown") {
        errors.push({ message: `array index must be a number, got ${idxT}` });
      }
      if (objT === "object" && idxT !== "string" && idxT !== "unknown") {
        errors.push({ message: `object key must be a string, got ${idxT}` });
      }
      if (objT !== "array" && objT !== "object" && objT !== "unknown" && objT !== "string") {
        errors.push({ message: `cannot index a ${objT}` });
      }
      return "unknown";
    }

    case "unary": {
      const argT = inferType(e.arg, channels, errors);
      if (e.op === "!") {
        expect(argT, "boolean", errors, "operand of !");
        return "boolean";
      }
      expect(argT, "number", errors, "operand of unary -");
      return "number";
    }

    case "binary": {
      const l = inferType(e.left, channels, errors);
      const r = inferType(e.right, channels, errors);
      switch (e.op) {
        case "||":
        case "&&":
          expect(l, "boolean", errors, `left operand of ${e.op}`);
          expect(r, "boolean", errors, `right operand of ${e.op}`);
          return "boolean";
        case "==":
        case "!=":
          // Comparing a value to null is the idiomatic presence test, so it is
          // always allowed; otherwise both sides must agree.
          if (l !== "unknown" && r !== "unknown" && l !== r && l !== "null" && r !== "null") {
            errors.push({ message: `cannot compare ${l} to ${r}` });
          }
          return "boolean";
        case "<":
        case "<=":
        case ">":
        case ">=":
          if (!(l === "string" && r === "string")) {
            expect(l, "number", errors, `left operand of ${e.op}`);
            expect(r, "number", errors, `right operand of ${e.op}`);
          }
          return "boolean";
        case "+":
          // `+` is numeric addition OR string concatenation, never both.
          if (l === "string" || r === "string") {
            expect(l, "string", errors, "left operand of +");
            expect(r, "string", errors, "right operand of +");
            return "string";
          }
          expect(l, "number", errors, "left operand of +");
          expect(r, "number", errors, "right operand of +");
          return "number";
        case "-":
        case "*":
        case "/":
        case "%":
          expect(l, "number", errors, `left operand of ${e.op}`);
          expect(r, "number", errors, `right operand of ${e.op}`);
          return "number";
      }
      break;
    }

    case "call": {
      const argTypes = e.args.map((a) => inferType(a, channels, errors));
      switch (e.fn) {
        case "len": {
          const t = argTypes[0]!;
          if (t !== "array" && t !== "string" && t !== "unknown") {
            errors.push({ message: `len() takes an array or string, got ${t}` });
          }
          return "number";
        }
        case "has":
          // `has()` is exactly the presence test, so any argument type is fine —
          // including a reference to a channel that has no value yet.
          return "boolean";
        case "all":
        case "any": {
          const t = argTypes[0]!;
          if (t !== "array" && t !== "unknown") errors.push({ message: `${e.fn}() takes an array, got ${t}` });
          return "boolean";
        }
        case "contains": {
          const t = argTypes[0]!;
          if (t !== "array" && t !== "string" && t !== "unknown") {
            errors.push({ message: `contains() takes an array or string, got ${t}` });
          }
          return "boolean";
        }
      }
      break;
    }
  }
  return "unknown";
}

function expect(actual: Ty, want: Ty, errors: TypeError[], where: string): void {
  if (actual === "unknown" || actual === want) return;
  errors.push({ message: `${where} must be ${want}, got ${actual}` });
}

/** Parse + typecheck in one call. Returns diagnostics rather than throwing. */
export function checkExpr(
  src: string,
  channels: Readonly<Record<string, Ty>>,
): { ok: true; expr: Expr; refs: readonly string[] } | { ok: false; errors: readonly string[] } {
  let expr: Expr;
  try {
    expr = parseExpr(src);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  const typeErrors: TypeError[] = [];
  const t = inferType(expr, channels, typeErrors);
  if (t !== "boolean" && t !== "unknown") {
    typeErrors.push({ message: `expression must evaluate to a boolean, got ${t}` });
  }
  if (typeErrors.length > 0) return { ok: false, errors: typeErrors.map((e) => e.message) };
  return { ok: true, expr, refs: referencedChannels(expr) };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Total by construction: a missing channel, an out-of-range index, or a property of
 * a non-object all produce `undefined` rather than throwing. Routing on incomplete
 * state must yield "false", never "crash the Task" — the graph decides what happens
 * next, and it cannot do that from inside an exception.
 */
export function evaluate(e: Expr, scope: Readonly<Record<string, unknown>>): unknown {
  switch (e.k) {
    case "lit":
      return e.v;
    case "ref":
      return own(scope, e.name);
    case "member": {
      const o = evaluate(e.obj, scope);
      if (o === null || o === undefined || typeof o !== "object") return undefined;
      return own(o, e.prop);
    }
    case "index": {
      const o = evaluate(e.obj, scope);
      const i = evaluate(e.idx, scope);
      if (o === null || o === undefined) return undefined;
      if (Array.isArray(o)) {
        const n = typeof i === "number" ? (i < 0 ? o.length + i : i) : NaN;
        return Number.isInteger(n) ? o[n] : undefined;
      }
      if (typeof o === "string") {
        const n = typeof i === "number" ? (i < 0 ? o.length + i : i) : NaN;
        return Number.isInteger(n) ? o[n] : undefined;
      }
      if (typeof o === "object") return own(o, String(i));
      return undefined;
    }
    case "unary": {
      const v = evaluate(e.arg, scope);
      if (e.op === "!") return !truthy(v);
      const n = toNumber(v);
      return n === undefined ? undefined : -n;
    }
    case "binary":
      return evalBinary(e, scope);
    case "call":
      return evalCall(e, scope);
  }
}

function evalBinary(e: Extract<Expr, { k: "binary" }>, scope: Readonly<Record<string, unknown>>): unknown {
  // Short-circuit before evaluating the right side, so `has(x) && x.y > 1` is safe.
  if (e.op === "&&") return truthy(evaluate(e.left, scope)) ? truthy(evaluate(e.right, scope)) : false;
  if (e.op === "||") return truthy(evaluate(e.left, scope)) ? true : truthy(evaluate(e.right, scope));

  const l = evaluate(e.left, scope);
  const r = evaluate(e.right, scope);
  switch (e.op) {
    case "==":
      return strictEq(l, r);
    case "!=":
      return !strictEq(l, r);
    // Any ordering comparison involving an absent value is FALSE. See `compare`.
    case "<":
      return lt(l, r);
    case "<=":
      return lt(l, r) || strictEq(l, r);
    case ">":
      return lt(r, l);
    case ">=":
      return lt(r, l) || strictEq(l, r);
    case "+":
      if (typeof l === "string" || typeof r === "string") return String(l ?? "") + String(r ?? "");
      return arith(l, r, (a, b) => a + b);
    case "-":
      return arith(l, r, (a, b) => a - b);
    case "*":
      return arith(l, r, (a, b) => a * b);
    // Division by zero yields `undefined` rather than Infinity: Infinity is not
    // representable in the canonical form, and propagating absence is the same
    // rule as everywhere else here.
    case "/":
      return arith(l, r, (a, b) => (b === 0 ? undefined : a / b));
    case "%":
      return arith(l, r, (a, b) => (b === 0 ? undefined : a % b));
    default:
      return undefined;
  }
}

/** Arithmetic propagates absence: if either operand is not a finite number, the result is absent. */
function arith(l: unknown, r: unknown, f: (a: number, b: number) => number | undefined): number | undefined {
  const a = toNumber(l);
  const b = toNumber(r);
  if (a === undefined || b === undefined) return undefined;
  return f(a, b);
}

function evalCall(e: Extract<Expr, { k: "call" }>, scope: Readonly<Record<string, unknown>>): unknown {
  switch (e.fn) {
    case "len": {
      const v = evaluate(e.args[0]!, scope);
      if (Array.isArray(v) || typeof v === "string") return v.length;
      return 0;
    }
    case "has": {
      const v = evaluate(e.args[0]!, scope);
      return v !== undefined && v !== null;
    }
    case "all": {
      const v = evaluate(e.args[0]!, scope);
      return Array.isArray(v) ? v.every(truthy) : false;
    }
    case "any": {
      const v = evaluate(e.args[0]!, scope);
      return Array.isArray(v) ? v.some(truthy) : false;
    }
    case "contains": {
      const hay = evaluate(e.args[0]!, scope);
      const needle = evaluate(e.args[1]!, scope);
      if (Array.isArray(hay)) return hay.some((x) => strictEq(x, needle));
      if (typeof hay === "string") return hay.includes(String(needle));
      return false;
    }
  }
}

/**
 * Read a key the way DATA has keys: OWN, and STORED — never inherited, never computed.
 *
 * A plain `o[key]` walks the prototype chain, so `payload.constructor` on untrusted JSON
 * answered with `Object`, `payload.__proto__` with `Object.prototype`, and
 * `payload.hasOwnProperty` with a function — every one of them non-null, for EVERY object.
 * A router `when` testing field presence therefore did not test the data at all: it asked a
 * question whose answer was fixed before the payload existed, and a router chooses which edge
 * runs. Absence is the right answer because a prototype key is not absence of a new kind: the
 * same `undefined` a missing channel yields, so `lt`, `arith` and `truthy` already handle it.
 *
 * A key an author genuinely wrote still reads. `yaml.ts` deliberately admits `constructor` and
 * `__proto__` as ordinary keys (`test/graph/yaml.test.ts`), so shadowing must WORK — which is
 * why this is own-property access and not a denylist of the four famous names. A denylist would
 * also miss `toString`, `valueOf`, `isPrototypeOf`, and whatever a later Node adds.
 *
 * The descriptor, rather than `Object.hasOwn(o, key) && o[key]`, because an own ACCESSOR would
 * run user code and could throw — and this evaluator's contract, one paragraph up, is that it
 * is total and side-effect free. Own getters do not appear in JSON, so nothing legitimate is
 * lost by declining to invoke them.
 */
function own(o: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (d === undefined) return undefined;
  return "value" in d ? d.value : undefined;
}

function truthy(v: unknown): boolean {
  // Deliberately narrow: only `true` is true. No "" / 0 / [] coercion, because
  // implicit truthiness is where routing bugs hide.
  return v === true;
}

function toNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strictEq(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

/**
 * Strictly-less-than, where ABSENCE MAKES EVERY ORDERING COMPARISON FALSE.
 *
 * This is the single most consequential semantic choice in the language. Coercing an
 * absent value to 0 (the obvious implementation) means `verdict.score < 0.7` is TRUE
 * before anything has written `verdict` — so a run routes on a fabricated number and
 * takes a branch nobody intended. Returning false instead means an unwritten channel
 * simply does not satisfy a conditional edge, and the router falls through to its
 * declared `fallbackEdge`, which is a decision an author actually made.
 *
 * The idiom for "present and low" is therefore `has(verdict) && verdict.score < 0.7`,
 * and `&&` short-circuits so it is safe.
 *
 * The known cost is the classic three-valued-logic trap: `!(x < 1)` is true when `x`
 * is absent. Full 3VL would fix it and would also mean every predicate could return
 * "unknown", which no author expects from a routing condition. Not worth it.
 */
function lt(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a < b;
  const x = toNumber(a);
  const y = toNumber(b);
  if (x === undefined || y === undefined) return false;
  return x < y;
}

/** Parse, then evaluate. For call sites that do not keep a compiled AST. */
export function evaluateSource(src: string, scope: Readonly<Record<string, unknown>>): unknown {
  return evaluate(parseExpr(src), scope);
}
