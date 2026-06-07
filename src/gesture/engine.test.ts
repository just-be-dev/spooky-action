import { test, expect, describe } from "vitest";
import { Effect, Schema } from "effect";
import { compileGesture, GestureDef, GestureEngine, type Entity } from "./engine";
import { HAND_LANDMARKS } from "../landmarks";
import pinchJson from "../defs/pinch.json";

// Run a failing Effect and return its typed error
const failure = <A, E>(effect: Effect.Effect<A, E>): E => Effect.runSync(Effect.flip(effect));

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

// --- synthetic hand frames for the real pinch def ---

const pinch = Schema.decodeUnknownSync(GestureDef)(pinchJson);

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
  return Effect.runSync(engine.step(entities));
}

describe("pinch gesture (real def)", () => {
  test("full lifecycle: off → potential → active → potential → off", () => {
    const engine = makeEngine([pinch]);

    // Open hand: off.
    let r = run(engine, [handAt(1.0)]);
    expect(r.statuses[0]!.state).toBe("off");
    expect(r.statuses[0]!.previousState).toBe("off");

    // Closing: enters potential.
    r = run(engine, [handAt(0.6)]);
    expect(r.statuses[0]!.state).toBe("potential");
    expect(r.statuses[0]!.previousState).toBe("off");

    // Pinched: active.
    r = run(engine, [handAt(0.2)]);
    expect(r.statuses[0]!.state).toBe("active");
    expect(r.statuses[0]!.previousState).toBe("potential");

    // Still pinched: remains active.
    r = run(engine, [handAt(0.2)]);
    expect(r.statuses[0]!.state).toBe("active");
    expect(r.statuses[0]!.previousState).toBe("active");

    // Released past active threshold: back to potential.
    r = run(engine, [handAt(0.6)]);
    expect(r.statuses[0]!.state).toBe("potential");
    expect(r.statuses[0]!.previousState).toBe("active");

    // Fully open: off.
    r = run(engine, [handAt(1.0)]);
    expect(r.statuses[0]!.state).toBe("off");
    expect(r.statuses[0]!.previousState).toBe("potential");

    // Hand disappears from potential state: off for one frame.
    run(engine, [handAt(0.6)]);
    r = run(engine, []);
    expect(r.statuses).toEqual([
      expect.objectContaining({
        key: "pinch#1",
        gesture: "pinch",
        state: "off",
        previousState: "potential",
      }),
    ]);
  });

  test("two hands run independent state machines", () => {
    const engine = makeEngine([pinch]);
    run(engine, [handAt(0.6, 1), handAt(0.6, 2)]);
    const r = run(engine, [handAt(0.2, 1), handAt(0.2, 2)]);
    expect(r.statuses.map((status) => status.state)).toEqual(["active", "active"]);
    expect(new Set(r.statuses.map((status) => status.key))).toEqual(
      new Set(["pinch#1", "pinch#2"]),
    );
  });

  test("world landmarks keep open pinch stable under screen foreshortening", () => {
    const engine = makeEngine([pinch]);
    const r = run(engine, [foreshortenedHand()]);
    expect(r.statuses[0]!.state).toBe("off");
    expect(r.statuses[0]!.metrics.pinch).toBeCloseTo(1);
  });

  test("metric smoothing: pos trails the raw midpoint", () => {
    const engine = makeEngine([pinch]);
    const a = handAt(0.6);
    run(engine, [a]);
    // Move the whole pinch pair; smoothed pos should lag behind
    const b = handAt(0.6);
    for (const i of [HAND_LANDMARKS.thumb_tip!, HAND_LANDMARKS.index_tip!])
      b.landmarks[i] = { x: b.landmarks[i]!.x + 0.2, y: b.landmarks[i]!.y };
    const r = run(engine, [b]);
    const pos = r.statuses[0]!.metrics.pos as { x: number };
    expect(pos.x).toBeGreaterThan(0.5);
    expect(pos.x).toBeLessThan(0.7); // not the full jump
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
      Schema.decodeUnknownSync(GestureDef)({ name: "x", source: "tentacle", states: {} }),
    ).toThrow();
  });
});
