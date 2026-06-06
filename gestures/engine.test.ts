import { test, expect, describe } from "bun:test";
import {
  compile,
  compileGesture,
  GestureEngine,
  type Ctx,
  type Entity,
  type GestureDef,
  type WireMessage,
} from "./engine";
import { HAND_LANDMARKS } from "./landmarks";
import pinchClick from "./defs/pinch-click.json";

const emptyCtx: Ctx = () => undefined;

describe("expression language", () => {
  test("arithmetic precedence", () => {
    expect(compile("1 + 2 * 3")(emptyCtx)).toBe(7);
    expect(compile("(1 + 2) * 3")(emptyCtx)).toBe(9);
    expect(compile("10 / 4")(emptyCtx)).toBe(2.5);
    expect(compile("-2 + 5")(emptyCtx)).toBe(3);
  });

  test("comparison and logic", () => {
    expect(compile("0.3 < 0.35")(emptyCtx)).toBe(true);
    expect(compile("1 < 2 && 3 > 4")(emptyCtx)).toBe(false);
    expect(compile("1 < 2 || 3 > 4")(emptyCtx)).toBe(true);
    expect(compile("1 == 1 && 2 != 3")(emptyCtx)).toBe(true);
    expect(compile("!(1 > 2)")(emptyCtx)).toBe(true);
  });

  test("string literals", () => {
    expect(compile("'esc'")(emptyCtx)).toBe("esc");
  });

  test("identifiers and member access via ctx", () => {
    const ctx: Ctx = (n) =>
      n === "pos" ? { x: 0.25, y: 0.75 } : n === "hands" ? { count: 2 } : undefined;
    expect(compile("pos.x")(ctx)).toBe(0.25);
    expect(compile("pos.y * 2")(ctx)).toBe(1.5);
    expect(compile("hands.count == 2")(ctx)).toBe(true);
  });

  test("unknown names throw", () => {
    expect(() => compile("nope + 1")(emptyCtx)).toThrow("Unknown name 'nope'");
  });

  test("builtin functions", () => {
    const ctx: Ctx = (n) =>
      n === "a" ? { x: 0, y: 0 } : n === "b" ? { x: 3, y: 4 } : undefined;
    expect(compile("dist(a, b)")(ctx)).toBe(5);
    expect(compile("mid(a, b)")(ctx)).toEqual({ x: 1.5, y: 2 });
    expect(compile("lerp(0.5, 0, 1, 10, 20)")(emptyCtx)).toBe(15);
    expect(compile("lerp(5, 0, 1, 10, 20)")(emptyCtx)).toBe(20); // clamped
    expect(compile("clamp(1.5, 0, 1)")(emptyCtx)).toBe(1);
    expect(compile("abs(-3)")(emptyCtx)).toBe(3);
  });

  test("syntax errors are reported at compile time", () => {
    expect(() => compile("1 +")).toThrow();
    expect(() => compile("dist(a")).toThrow();
    expect(() => compile("1 2")).toThrow("trailing tokens");
  });
});

describe("gesture compilation", () => {
  test("rejects unknown goto targets", () => {
    const def: GestureDef = {
      name: "bad",
      source: "hand",
      states: { idle: { on: [{ if: "1 > 0", goto: "missing" }] } },
    };
    expect(() => compileGesture(def)).toThrow("unknown state 'missing'");
  });

  test("rejects bad expressions with gesture context", () => {
    const def: GestureDef = {
      name: "bad",
      source: "hand",
      metrics: { m: "1 +" },
      states: { idle: {} },
    };
    expect(() => compileGesture(def)).toThrow("[bad] metric 'm'");
  });

  test("rejects missing initial state", () => {
    const def: GestureDef = {
      name: "bad",
      source: "hand",
      initial: "nope",
      states: { idle: {} },
    };
    expect(() => compileGesture(def)).toThrow("initial state 'nope'");
  });
});

// --- synthetic hand frames for the real pinch-click def ---

// wrist→middle_mcp = 0.2, so pinch ratio = dist(thumb, index) / 0.2
function handAt(ratio: number, id = 1): Entity {
  const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  landmarks[HAND_LANDMARKS.wrist!] = { x: 0.5, y: 0.8 };
  landmarks[HAND_LANDMARKS.middle_mcp!] = { x: 0.5, y: 0.6 };
  const half = (ratio * 0.2) / 2;
  landmarks[HAND_LANDMARKS.thumb_tip!] = { x: 0.5 - half, y: 0.4 };
  landmarks[HAND_LANDMARKS.index_tip!] = { x: 0.5 + half, y: 0.4 };
  return { type: "hand", id, landmarks, names: HAND_LANDMARKS };
}

function run(engine: GestureEngine, entities: Entity[]) {
  const sent: WireMessage[] = [];
  const statuses = engine.step(entities, (m) => sent.push(m));
  return { sent, statuses };
}

describe("pinch-click gesture (real def)", () => {
  test("full lifecycle: track → click → re-arm → hide → lost", () => {
    const engine = new GestureEngine([pinchClick as GestureDef]);

    // Open hand: idle, nothing sent
    let r = run(engine, [handAt(1.0)]);
    expect(r.sent).toEqual([]);
    expect(r.statuses[0]!.state).toBe("idle");

    // Closing: enters track, emits circle
    r = run(engine, [handAt(0.6)]);
    expect(r.statuses[0]!.state).toBe("track");
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.type).toBe("circle");
    expect(r.sent[0]!.id).toBe("pinch-click#1");

    // Pinched: click fires once, then holds in fired
    r = run(engine, [handAt(0.2)]);
    expect(r.sent.map((m) => m.type)).toEqual(["click", "circle"]);
    expect(r.statuses[0]!.state).toBe("fired");

    // Still pinched: no second click
    r = run(engine, [handAt(0.2)]);
    expect(r.sent.map((m) => m.type)).toEqual(["circle"]);
    expect(r.statuses[0]!.state).toBe("fired");

    // Released past re-arm threshold: back to track
    r = run(engine, [handAt(0.6)]);
    expect(r.statuses[0]!.state).toBe("track");

    // Fully open: hide, back to idle
    r = run(engine, [handAt(1.0)]);
    expect(r.sent.map((m) => m.type)).toEqual(["hide"]);
    expect(r.statuses[0]!.state).toBe("idle");

    // Hand disappears from track state → onLost hide
    run(engine, [handAt(0.6)]);
    r = run(engine, []);
    expect(r.sent.map((m) => m.type)).toEqual(["hide"]);
    expect(r.sent[0]!.id).toBe("pinch-click#1");
  });

  test("two hands: rings for both, clicks suppressed", () => {
    const engine = new GestureEngine([pinchClick as GestureDef]);
    run(engine, [handAt(0.6, 1), handAt(0.6, 2)]);
    const r = run(engine, [handAt(0.2, 1), handAt(0.2, 2)]);
    expect(r.sent.map((m) => m.type)).toEqual(["circle", "circle"]);
    expect(new Set(r.sent.map((m) => m.id))).toEqual(
      new Set(["pinch-click#1", "pinch-click#2"])
    );
  });

  test("metric smoothing: pos trails the raw midpoint", () => {
    const engine = new GestureEngine([pinchClick as GestureDef]);
    const a = handAt(0.6);
    run(engine, [a]);
    // Move the whole pinch pair; smoothed pos should lag behind
    const b = handAt(0.6);
    for (const i of [HAND_LANDMARKS.thumb_tip!, HAND_LANDMARKS.index_tip!])
      b.landmarks[i] = { x: b.landmarks[i]!.x + 0.2, y: b.landmarks[i]!.y };
    const r = run(engine, [b]);
    const circle = r.sent.find((m) => m.type === "circle")!;
    expect(circle.x as number).toBeGreaterThan(0.5);
    expect(circle.x as number).toBeLessThan(0.7); // not the full jump
  });

  test("runtime errors surface as status, not throws", () => {
    const def: GestureDef = {
      name: "broken",
      source: "hand",
      metrics: { m: "no_such_landmark.x" },
      states: { idle: {} },
    };
    const engine = new GestureEngine([def]);
    const r = run(engine, [handAt(0.5)]);
    expect(r.statuses[0]!.error).toContain("no_such_landmark");
  });
});
