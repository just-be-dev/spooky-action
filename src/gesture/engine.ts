// Data-driven gesture engine. Gesture definitions are plain JSON, validated
// against the `GestureDef` schema:
//
//   - `metrics` are named values computed each frame from the entity's
//     landmarks via the expression language in `expr.ts` (optionally
//     EMA-smoothed)
//   - `states` form a per-entity state machine; transitions ("on") and
//     states themselves can emit wire messages
//
// One state-machine instance exists per (gesture, tracked entity), so two
// hands each run their own copy of a hand gesture. The engine is pure —
// no DOM, no MediaPipe — so it runs in the browser and under `bun test`.
//
// Effect surface: `compileGesture` and `GestureEngine.make` fail with tagged
// errors; `step` always succeeds and reports per-instance runtime problems
// in `InstanceStatus.error`.

import { Effect, Schema } from "effect";

import { parseExpr, type Ctx, type Expr, type Point } from "./expr";

export class GestureCompileError extends Schema.TaggedErrorClass<GestureCompileError>()(
  "GestureCompileError",
  { gesture: Schema.String, message: Schema.String }
) {}

// ---------------------------------------------------------------------------
// Gesture definitions (the JSON schema)
// ---------------------------------------------------------------------------

// In emits, `type` is a literal; every other string value is an expression.
// Use 'single quotes' inside an expression for a literal string payload.
export const EmitSpec = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
);
export type EmitSpec = typeof EmitSpec.Type;

export const TransitionDef = Schema.Struct({
  if: Schema.String,
  goto: Schema.String,
  emit: Schema.optional(EmitSpec),
});
export type TransitionDef = typeof TransitionDef.Type;

export const StateDef = Schema.Struct({
  emit: Schema.optional(EmitSpec),
  on: Schema.optional(Schema.Array(TransitionDef)),
});
export type StateDef = typeof StateDef.Type;

export const MetricDef = Schema.Union([
  Schema.String,
  Schema.Struct({ expr: Schema.String, smooth: Schema.optional(Schema.Number) }),
]);
export type MetricDef = typeof MetricDef.Type;

export const GestureDef = Schema.Struct({
  name: Schema.String,
  source: Schema.Literals(["hand", "face"]),
  metrics: Schema.optional(Schema.Record(Schema.String, MetricDef)),
  initial: Schema.optional(Schema.String), // defaults to the first key of `states`
  states: Schema.Record(Schema.String, StateDef),
  onLost: Schema.optional(Schema.Struct({ emit: EmitSpec })), // sent when the entity disappears
});
export type GestureDef = typeof GestureDef.Type;

// What the tracker feeds the engine each frame
export type Entity = {
  type: "hand" | "face";
  id: number;
  landmarks: Point[];
  worldLandmarks?: Point[];
  names: Record<string, number>; // identifier → landmark index
  label?: string;
};

export type WireMessage = { type: string; id: string } & Record<string, unknown>;

export type InstanceStatus = {
  key: string;
  gesture: string;
  entityId: number;
  state: string;
  metrics: Record<string, unknown>;
  error?: string;
};

export type FrameResult = {
  readonly statuses: InstanceStatus[];
  readonly messages: WireMessage[];
};

// --- compilation ---

type CompiledEmit = (ctx: Ctx, id: string) => WireMessage;

type CompiledMetric = {
  name: string;
  expr: Expr;
  smooth?: number;
};

type CompiledTransition = { cond: Expr; goto: string; emit?: CompiledEmit };
type CompiledState = { emit?: CompiledEmit; on: CompiledTransition[] };

export type CompiledGesture = {
  def: GestureDef;
  metrics: CompiledMetric[];
  initial: string;
  states: Record<string, CompiledState>;
  onLost?: CompiledEmit;
};

function compileEmitSync(spec: EmitSpec): CompiledEmit {
  const type = spec.type;
  if (typeof type !== "string")
    throw new Error(`emit needs a literal string "type": ${JSON.stringify(spec)}`);
  const fields: [string, Expr | number | boolean][] = Object.entries(spec)
    .filter(([k]) => k !== "type")
    .map(([k, v]) => [k, typeof v === "string" ? parseExpr(v) : v]);
  return (ctx, id) => {
    const msg: WireMessage = { type, id };
    for (const [k, v] of fields) msg[k] = typeof v === "function" ? v(ctx) : v;
    return msg;
  };
}

function compileGestureSync(def: GestureDef): CompiledGesture {
  const wrap = <T>(what: string, fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      throw new Error(`[${def.name}] ${what}: ${(err as Error).message}`);
    }
  };

  const metrics: CompiledMetric[] = Object.entries(def.metrics ?? {}).map(
    ([name, m]) =>
      wrap(`metric '${name}'`, () =>
        typeof m === "string"
          ? { name, expr: parseExpr(m) }
          : { name, expr: parseExpr(m.expr), smooth: m.smooth }
      )
  );

  const stateNames = Object.keys(def.states);
  if (stateNames.length === 0) throw new Error(`[${def.name}] has no states`);
  const initial = def.initial ?? stateNames[0]!;
  if (!def.states[initial])
    throw new Error(`[${def.name}] initial state '${initial}' not found`);

  const states: Record<string, CompiledState> = {};
  for (const [name, s] of Object.entries(def.states)) {
    states[name] = {
      emit: s.emit && wrap(`state '${name}' emit`, () => compileEmitSync(s.emit!)),
      on: (s.on ?? []).map((t) => {
        if (!def.states[t.goto])
          throw new Error(`[${def.name}] state '${name}' → unknown state '${t.goto}'`);
        return wrap(`state '${name}' transition`, () => ({
          cond: parseExpr(t.if),
          goto: t.goto,
          emit: t.emit && compileEmitSync(t.emit),
        }));
      }),
    };
  }

  return {
    def,
    metrics,
    initial,
    states,
    onLost: def.onLost && wrap("onLost emit", () => compileEmitSync(def.onLost!.emit)),
  };
}

export const compileGesture = (
  def: GestureDef
): Effect.Effect<CompiledGesture, GestureCompileError> =>
  Effect.try({
    try: () => compileGestureSync(def),
    catch: (err) =>
      new GestureCompileError({
        gesture: def.name,
        message: (err as Error).message,
      }),
  });

// --- runtime ---

function smoothValue(prev: unknown, next: unknown, alpha: number): unknown {
  if (typeof next === "number" && typeof prev === "number")
    return prev + (next - prev) * alpha;
  if (
    next != null && typeof next === "object" &&
    prev != null && typeof prev === "object"
  ) {
    const np = next as Point;
    const pp = prev as Point;
    return {
      x: pp.x + (np.x - pp.x) * alpha,
      y: pp.y + (np.y - pp.y) * alpha,
      z: (pp.z ?? 0) + ((np.z ?? 0) - (pp.z ?? 0)) * alpha,
    };
  }
  return next;
}

type Instance = {
  state: string;
  smoothed: Record<string, unknown>;
  lastCtx: Ctx | null;
  gesture: CompiledGesture;
  entityId: number;
};

export class GestureEngine {
  /** Compile a set of defs into a fresh engine. */
  static readonly make = Effect.fn("GestureEngine.make")(function* (
    defs: ReadonlyArray<GestureDef>
  ) {
    const gestures: CompiledGesture[] = [];
    for (const def of defs) gestures.push(yield* compileGesture(def));
    return new GestureEngine(gestures);
  });

  private readonly instances = new Map<string, Instance>();

  private constructor(private readonly gestures: CompiledGesture[]) {}

  /** Run one frame. Wire messages are returned in emit order. */
  step(entities: ReadonlyArray<Entity>): Effect.Effect<FrameResult> {
    return Effect.sync(() => this.stepSync(entities));
  }

  private stepSync(entities: ReadonlyArray<Entity>): FrameResult {
    const globals = {
      hands: { count: entities.filter((e) => e.type === "hand").length },
      faces: { count: entities.filter((e) => e.type === "face").length },
    };
    const statuses: InstanceStatus[] = [];
    const messages: WireMessage[] = [];
    const seen = new Set<string>();

    for (const g of this.gestures) {
      for (const entity of entities) {
        if (entity.type !== g.def.source) continue;
        const key = `${g.def.name}#${entity.id}`;
        seen.add(key);

        let inst = this.instances.get(key);
        if (!inst) {
          inst = {
            state: g.initial,
            smoothed: {},
            lastCtx: null,
            gesture: g,
            entityId: entity.id,
          };
          this.instances.set(key, inst);
        }

        const metricValues: Record<string, unknown> = {};
        const ctx: Ctx = (name) => {
          if (name in metricValues) return metricValues[name];
          const idx = entity.names[name];
          if (idx !== undefined) return entity.landmarks[idx];
          if (name.startsWith("world_")) {
            const worldIdx = entity.names[name.slice("world_".length)];
            if (worldIdx !== undefined) return entity.worldLandmarks?.[worldIdx];
          }
          if (name === "lm") return (i: number) => entity.landmarks[i | 0];
          if (name === "world_lm") return (i: number) => entity.worldLandmarks?.[i | 0];
          if (name in globals) return globals[name as keyof typeof globals];
          return undefined;
        };

        const status: InstanceStatus = {
          key,
          gesture: g.def.name,
          entityId: entity.id,
          state: inst.state,
          metrics: metricValues,
        };
        statuses.push(status);

        try {
          for (const m of g.metrics) {
            let v = m.expr(ctx);
            if (m.smooth !== undefined && m.name in inst.smoothed)
              v = smoothValue(inst.smoothed[m.name], v, m.smooth);
            if (m.smooth !== undefined) inst.smoothed[m.name] = v;
            metricValues[m.name] = v;
          }

          // At most one transition per frame, first match wins
          for (const t of g.states[inst.state]!.on) {
            if (t.cond(ctx)) {
              if (t.emit) messages.push(t.emit(ctx, key));
              inst.state = t.goto;
              break;
            }
          }

          // Continuous emit of the (possibly new) current state
          const cur = g.states[inst.state]!;
          if (cur.emit) messages.push(cur.emit(ctx, key));

          inst.lastCtx = ctx;
          status.state = inst.state;
        } catch (err) {
          status.error = (err as Error).message;
        }
      }
    }

    // Entities that vanished this frame
    for (const [key, inst] of this.instances) {
      if (seen.has(key)) continue;
      if (inst.gesture.onLost && inst.lastCtx) {
        try {
          messages.push(inst.gesture.onLost(inst.lastCtx, key));
        } catch {
          // last ctx may not satisfy the emit — drop it
        }
      }
      this.instances.delete(key);
    }

    return { statuses, messages };
  }
}
