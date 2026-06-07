import { test, expect, describe } from "bun:test";
import { Effect, Schema } from "effect";
import {
  compileGesture,
  GestureDef,
  GestureEngine,
  type Entity,
  type WireMessage,
} from "./engine";
import { HAND_LANDMARKS } from "../landmarks";
import pinchClickJson from "../defs/pinch-click.json";

// Run a failing Effect and return its typed error
const failure = <A, E>(effect: Effect.Effect<A, E>): E =>
  Effect.runSync(Effect.flip(effect));

describe("gesture compilation", () => {
  test("rejects unknown goto targets", () => {
    const def: GestureDef = {
      name: "bad",
      source: "hand",
      states: { idle: { on: [{ if: "1 > 0", goto: "missing" }] } },
    };
    const err = failure(compileGesture(def));
    expect(err._tag).toBe("GestureCompileError");
    expect(err.gesture).toBe("bad");
    expect(err.message).toContain("unknown state 'missing'");
  });

  test("rejects bad expressions with gesture context", () => {
    const def: GestureDef = {
      name: "bad",
      source: "hand",
      metrics: { m: "1 +" },
      states: { idle: {} },
    };
    expect(failure(compileGesture(def)).message).toContain("[bad] metric 'm'");
  });

  test("rejects missing initial state", () => {
    const def: GestureDef = {
      name: "bad",
      source: "hand",
      initial: "nope",
      states: { idle: {} },
    };
    expect(failure(compileGesture(def)).message).toContain("initial state 'nope'");
  });
});

// --- synthetic hand frames for the real pinch-click def ---

const pinchClick = Schema.decodeUnknownSync(GestureDef)(pinchClickJson);

// wrist→middle_mcp = 0.2, so pinch ratio = dist(thumb, index) / 0.2
function handAt(ratio: number, id = 1): Entity {
  const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  landmarks[HAND_LANDMARKS.wrist!] = { x: 0.5, y: 0.8 };
  landmarks[HAND_LANDMARKS.middle_mcp!] = { x: 0.5, y: 0.6 };
  const half = (ratio * 0.2) / 2;
  landmarks[HAND_LANDMARKS.thumb_tip!] = { x: 0.5 - half, y: 0.4 };
  landmarks[HAND_LANDMARKS.index_tip!] = { x: 0.5 + half, y: 0.4 };
  const worldLandmarks = landmarks.map((point) => ({ ...point, z: 0 }));
  return { type: "hand", id, landmarks, worldLandmarks, names: HAND_LANDMARKS };
}

function foreshortenedHand(id = 1): Entity {
  const hand = handAt(0.2, id);
  hand.worldLandmarks = handAt(1.0, id).worldLandmarks;
  return hand;
}

const makeEngine = (defs: ReadonlyArray<GestureDef>): GestureEngine =>
  Effect.runSync(GestureEngine.make(defs));

function run(engine: GestureEngine, entities: Entity[]) {
  const { statuses, messages } = Effect.runSync(engine.step(entities));
  return { sent: messages satisfies WireMessage[], statuses };
}

describe("pinch-click gesture (real def)", () => {
  test("full lifecycle: track → click → re-arm → hide → lost", () => {
    const engine = makeEngine([pinchClick]);

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
    const engine = makeEngine([pinchClick]);
    run(engine, [handAt(0.6, 1), handAt(0.6, 2)]);
    const r = run(engine, [handAt(0.2, 1), handAt(0.2, 2)]);
    expect(r.sent.map((m) => m.type)).toEqual(["circle", "circle"]);
    expect(new Set(r.sent.map((m) => m.id))).toEqual(
      new Set(["pinch-click#1", "pinch-click#2"])
    );
  });

  test("world landmarks keep open pinch stable under screen foreshortening", () => {
    const engine = makeEngine([pinchClick]);
    const r = run(engine, [foreshortenedHand()]);
    expect(r.sent).toEqual([]);
    expect(r.statuses[0]!.state).toBe("idle");
    expect(r.statuses[0]!.metrics.pinch).toBeCloseTo(1);
  });

  test("metric smoothing: pos trails the raw midpoint", () => {
    const engine = makeEngine([pinchClick]);
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

  test("runtime errors surface as status, not failures", () => {
    const def: GestureDef = {
      name: "broken",
      source: "hand",
      metrics: { m: "no_such_landmark.x" },
      states: { idle: {} },
    };
    const engine = makeEngine([def]);
    const r = run(engine, [handAt(0.5)]);
    expect(r.statuses[0]!.error).toContain("no_such_landmark");
  });

  test("malformed defs are rejected by the schema", () => {
    expect(() =>
      Schema.decodeUnknownSync(GestureDef)({ name: "x", source: "tentacle", states: {} })
    ).toThrow();
  });
});
