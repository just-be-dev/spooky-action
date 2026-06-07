// Expression language for gesture definitions. Knows nothing about gestures
// or state machines — it compiles source strings into plain evaluator
// functions that resolve names through a caller-supplied context.
//
// Grammar: ||  &&  == !=  < > <= >=  + -  * / %  unary - !  .member  f(args)
// Literals: numbers (0.35), 'single-quoted strings'. Identifiers resolve
// through the evaluation context (metrics, named landmarks, globals).
//
// `compile` is the Effect boundary; `parseExpr` is the exception-based core
// for callers (the gesture compiler) that wrap errors themselves. Evaluators
// may still throw at runtime (e.g. unknown names) — the engine catches those
// once per instance per frame.

import { Effect, Schema } from "effect";

export type Point = { x: number; y: number; z?: number };

const zOf = (point: Point): number => point.z ?? 0;

export class ExprError extends Schema.TaggedErrorClass<ExprError>()("ExprError", {
  message: Schema.String,
}) {}

export type Ctx = (name: string) => unknown;
export type Expr = (ctx: Ctx) => unknown;

const FUNCS: Record<string, (...args: any[]) => unknown> = {
  dist: (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, zOf(a) - zOf(b)),
  dist2d: (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y),
  mid: (a: Point, b: Point) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (zOf(a) + zOf(b)) / 2,
  }),
  // Angle of the segment a→b in degrees (0 = rightward, 90 = downward)
  angle: (a: Point, b: Point) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
  // Map v from [inMin, inMax] to [outMin, outMax], clamped
  lerp: (v: number, inMin: number, inMax: number, outMin: number, outMax: number) => {
    const t = Math.min(Math.max((v - inMin) / (inMax - inMin), 0), 1);
    return outMin + t * (outMax - outMin);
  },
  clamp: (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi),
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  round: Math.round,
  point: (x: number, y: number, z = 0) => ({ x, y, z }),
};

type Tok =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "id"; v: string }
  | { k: "op"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      toks.push({ k: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      toks.push({ k: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new Error(`Unterminated string in: ${src}`);
      toks.push({ k: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["||", "&&", "==", "!=", "<=", ">="].includes(two)) {
      toks.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/%<>(),.!".includes(c)) {
      toks.push({ k: "op", v: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character '${c}' in: ${src}`);
  }
  return toks;
}

// Exception-based parser core; `compile` is the Effect boundary around it.
export function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;

  const isOp = (...vs: string[]): string | null => {
    const t = toks[p];
    return t?.k === "op" && vs.includes(t.v) ? t.v : null;
  };
  const eat = (v: string) => {
    const t = toks[p++];
    if (t?.k !== "op" || t.v !== v) throw new Error(`Expected '${v}' in: ${src}`);
  };

  function primary(): Expr {
    const t = toks[p++];
    if (!t) throw new Error(`Unexpected end of expression: ${src}`);
    if (t.k === "num" || t.k === "str") {
      const v = t.v;
      return () => v;
    }
    if (t.k === "id") {
      const name = t.v;
      if (isOp("(")) {
        eat("(");
        const args: Expr[] = [];
        if (!isOp(")")) {
          args.push(parseOr());
          while (isOp(",")) {
            p++;
            args.push(parseOr());
          }
        }
        eat(")");
        return (ctx) => {
          const fn = FUNCS[name] ?? ctx(name);
          if (typeof fn !== "function") throw new Error(`'${name}' is not a function (in: ${src})`);
          return fn(...args.map((a) => a(ctx)));
        };
      }
      return (ctx) => {
        const v = ctx(name);
        if (v === undefined) throw new Error(`Unknown name '${name}' (in: ${src})`);
        return v;
      };
    }
    if (t.v === "(") {
      const e = parseOr();
      eat(")");
      return e;
    }
    throw new Error(`Unexpected '${t.v}' in: ${src}`);
  }

  function postfix(): Expr {
    let e = primary();
    while (isOp(".")) {
      p++;
      const t = toks[p++];
      if (t?.k !== "id") throw new Error(`Expected property name in: ${src}`);
      const prop = t.v;
      const inner = e;
      e = (ctx) => {
        const obj = inner(ctx) as Record<string, unknown> | null;
        const v = obj?.[prop];
        if (v === undefined) throw new Error(`No property '${prop}' (in: ${src})`);
        return v;
      };
    }
    return e;
  }

  function unary(): Expr {
    if (isOp("-")) {
      p++;
      const e = unary();
      return (ctx) => -(e(ctx) as number);
    }
    if (isOp("!")) {
      p++;
      const e = unary();
      return (ctx) => !e(ctx);
    }
    return postfix();
  }

  const binary = (next: () => Expr, ops: Record<string, (a: any, b: any) => unknown>) => {
    return (): Expr => {
      let e = next();
      let op: string | null;
      while ((op = isOp(...Object.keys(ops)))) {
        p++;
        const r = next();
        const l = e;
        const f = ops[op]!;
        e = (ctx) => f(l(ctx), r(ctx));
      }
      return e;
    };
  };

  const parseMul = binary(unary, {
    "*": (a, b) => a * b,
    "/": (a, b) => a / b,
    "%": (a, b) => a % b,
  });
  const parseAdd = binary(parseMul, {
    "+": (a, b) => a + b,
    "-": (a, b) => a - b,
  });
  const parseCmp = binary(parseAdd, {
    "<": (a, b) => a < b,
    ">": (a, b) => a > b,
    "<=": (a, b) => a <= b,
    ">=": (a, b) => a >= b,
  });
  const parseEq = binary(parseCmp, {
    "==": (a, b) => a === b,
    "!=": (a, b) => a !== b,
  });
  const parseAnd = (): Expr => {
    let e = parseEq();
    while (isOp("&&")) {
      p++;
      const r = parseEq();
      const l = e;
      e = (ctx) => l(ctx) && r(ctx);
    }
    return e;
  };
  const parseOr = (): Expr => {
    let e = parseAnd();
    while (isOp("||")) {
      p++;
      const r = parseAnd();
      const l = e;
      e = (ctx) => l(ctx) || r(ctx);
    }
    return e;
  };

  const expr = parseOr();
  if (p < toks.length) throw new Error(`Unexpected trailing tokens in: ${src}`);
  return expr;
}

/**
 * Compile an expression source string. The returned `Expr` is a plain
 * function that may still throw at evaluation time (e.g. unknown names) —
 * the engine catches those per instance and surfaces them as status errors.
 */
export const compile = (src: string): Effect.Effect<Expr, ExprError> =>
  Effect.try({
    try: () => parseExpr(src),
    catch: (err) => new ExprError({ message: (err as Error).message }),
  });
