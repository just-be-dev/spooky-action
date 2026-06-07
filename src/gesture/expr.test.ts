import { test, expect, describe } from "bun:test";
import { Effect } from "effect";
import { compile, type Ctx, type Expr } from "./expr";

const emptyCtx: Ctx = () => undefined;

// Compile an expression, unwrapping the Effect (parse errors throw here)
const compiled = (src: string): Expr => Effect.runSync(compile(src));

// Run a failing Effect and return its typed error
const failure = <A, E>(effect: Effect.Effect<A, E>): E =>
  Effect.runSync(Effect.flip(effect));

describe("expression language", () => {
  test("arithmetic precedence", () => {
    expect(compiled("1 + 2 * 3")(emptyCtx)).toBe(7);
    expect(compiled("(1 + 2) * 3")(emptyCtx)).toBe(9);
    expect(compiled("10 / 4")(emptyCtx)).toBe(2.5);
    expect(compiled("-2 + 5")(emptyCtx)).toBe(3);
  });

  test("comparison and logic", () => {
    expect(compiled("0.3 < 0.35")(emptyCtx)).toBe(true);
    expect(compiled("1 < 2 && 3 > 4")(emptyCtx)).toBe(false);
    expect(compiled("1 < 2 || 3 > 4")(emptyCtx)).toBe(true);
    expect(compiled("1 == 1 && 2 != 3")(emptyCtx)).toBe(true);
    expect(compiled("!(1 > 2)")(emptyCtx)).toBe(true);
  });

  test("string literals", () => {
    expect(compiled("'esc'")(emptyCtx)).toBe("esc");
  });

  test("identifiers and member access via ctx", () => {
    const ctx: Ctx = (n) =>
      n === "pos" ? { x: 0.25, y: 0.75 } : n === "hands" ? { count: 2 } : undefined;
    expect(compiled("pos.x")(ctx)).toBe(0.25);
    expect(compiled("pos.y * 2")(ctx)).toBe(1.5);
    expect(compiled("hands.count == 2")(ctx)).toBe(true);
  });

  test("unknown names throw at evaluation time", () => {
    expect(() => compiled("nope + 1")(emptyCtx)).toThrow("Unknown name 'nope'");
  });

  test("builtin functions", () => {
    const ctx: Ctx = (n) =>
      n === "a" ? { x: 0, y: 0 } : n === "b" ? { x: 3, y: 4 } : undefined;
    expect(compiled("dist(a, b)")(ctx)).toBe(5);
    expect(compiled("mid(a, b)")(ctx)).toEqual({ x: 1.5, y: 2 });
    expect(compiled("lerp(0.5, 0, 1, 10, 20)")(emptyCtx)).toBe(15);
    expect(compiled("lerp(5, 0, 1, 10, 20)")(emptyCtx)).toBe(20); // clamped
    expect(compiled("clamp(1.5, 0, 1)")(emptyCtx)).toBe(1);
    expect(compiled("abs(-3)")(emptyCtx)).toBe(3);
  });

  test("syntax errors fail with ExprError at compile time", () => {
    expect(failure(compile("1 +"))._tag).toBe("ExprError");
    expect(failure(compile("dist(a"))._tag).toBe("ExprError");
    expect(failure(compile("1 2")).message).toContain("trailing tokens");
  });
});
