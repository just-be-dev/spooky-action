// Data-driven gesture engine. Gesture definitions are plain JSON:
//
//   - `metrics` are named values computed each frame from the entity's
//     landmarks via a small expression language (optionally EMA-smoothed)
//   - `states` form a per-entity state machine; transitions ("on") and
//     states themselves can emit wire messages
//
// One state-machine instance exists per (gesture, tracked entity), so two
// hands each run their own copy of a hand gesture. The engine is pure —
// no DOM, no MediaPipe — so it runs in the browser and under `bun test`.

export type Point = { x: number; y: number };

// ---------------------------------------------------------------------------
// Expression language
//
// Grammar: ||  &&  == !=  < > <= >=  + -  * / %  unary - !  .member  f(args)
// Literals: numbers (0.35), 'single-quoted strings'. Identifiers resolve
// through the evaluation context (metrics, named landmarks, globals).
// ---------------------------------------------------------------------------

export type Ctx = (name: string) => unknown;
export type Expr = (ctx: Ctx) => unknown;

const FUNCS: Record<string, (...args: any[]) => unknown> = {
  dist: (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y),
  mid: (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
  // Angle of the segment a→b in degrees (0 = rightward, 90 = downward)
  angle: (a: Point, b: Point) =>
    (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
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
  point: (x: number, y: number) => ({ x, y }),
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

export function compile(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;

  const isOp = (...vs: string[]): string | null => {
    const t = toks[p];
    return t?.k === "op" && vs.includes(t.v) ? t.v : null;
  };
  const eat = (v: string) => {
    const t = toks[p++];
    if (t?.k !== "op" || t.v !== v)
      throw new Error(`Expected '${v}' in: ${src}`);
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
          if (typeof fn !== "function")
            throw new Error(`'${name}' is not a function (in: ${src})`);
          return fn(...args.map((a) => a(ctx)));
        };
      }
      return (ctx) => {
        const v = ctx(name);
        if (v === undefined)
          throw new Error(`Unknown name '${name}' (in: ${src})`);
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
        if (v === undefined)
          throw new Error(`No property '${prop}' (in: ${src})`);
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

  const binary = (
    next: () => Expr,
    ops: Record<string, (a: any, b: any) => unknown>
  ) => {
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

// ---------------------------------------------------------------------------
// Gesture definitions (the JSON schema)
// ---------------------------------------------------------------------------

// In emits, `type` is a literal; every other string value is an expression.
// Use 'single quotes' inside an expression for a literal string payload.
export type EmitSpec = Record<string, string | number | boolean>;

export type TransitionDef = { if: string; goto: string; emit?: EmitSpec };
export type StateDef = { emit?: EmitSpec; on?: TransitionDef[] };

export type GestureDef = {
  name: string;
  source: "hand" | "face";
  metrics?: Record<string, string | { expr: string; smooth?: number }>;
  initial?: string; // defaults to the first key of `states`
  states: Record<string, StateDef>;
  onLost?: { emit: EmitSpec }; // sent when the entity disappears
};

// What the tracker feeds the engine each frame
export type Entity = {
  type: "hand" | "face";
  id: number;
  landmarks: Point[];
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

// --- compilation ---

type CompiledEmit = (ctx: Ctx, id: string) => WireMessage;

type CompiledMetric = {
  name: string;
  expr: Expr;
  smooth?: number;
};

type CompiledTransition = { cond: Expr; goto: string; emit?: CompiledEmit };
type CompiledState = { emit?: CompiledEmit; on: CompiledTransition[] };

type CompiledGesture = {
  def: GestureDef;
  metrics: CompiledMetric[];
  initial: string;
  states: Record<string, CompiledState>;
  onLost?: CompiledEmit;
};

function compileEmit(spec: EmitSpec): CompiledEmit {
  const type = spec.type;
  if (typeof type !== "string")
    throw new Error(`emit needs a literal string "type": ${JSON.stringify(spec)}`);
  const fields: [string, Expr | number | boolean][] = Object.entries(spec)
    .filter(([k]) => k !== "type")
    .map(([k, v]) => [k, typeof v === "string" ? compile(v) : v]);
  return (ctx, id) => {
    const msg: WireMessage = { type, id };
    for (const [k, v] of fields) msg[k] = typeof v === "function" ? v(ctx) : v;
    return msg;
  };
}

export function compileGesture(def: GestureDef): CompiledGesture {
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
          ? { name, expr: compile(m) }
          : { name, expr: compile(m.expr), smooth: m.smooth }
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
      emit: s.emit && wrap(`state '${name}' emit`, () => compileEmit(s.emit!)),
      on: (s.on ?? []).map((t) => {
        if (!def.states[t.goto])
          throw new Error(`[${def.name}] state '${name}' → unknown state '${t.goto}'`);
        return wrap(`state '${name}' transition`, () => ({
          cond: compile(t.if),
          goto: t.goto,
          emit: t.emit && compileEmit(t.emit),
        }));
      }),
    };
  }

  return {
    def,
    metrics,
    initial,
    states,
    onLost: def.onLost && wrap("onLost emit", () => compileEmit(def.onLost!.emit)),
  };
}

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
    return { x: pp.x + (np.x - pp.x) * alpha, y: pp.y + (np.y - pp.y) * alpha };
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
  private gestures: CompiledGesture[];
  private instances = new Map<string, Instance>();

  constructor(defs: GestureDef[]) {
    this.gestures = defs.map(compileGesture);
  }

  /** Run one frame. Calls `send` for every wire message emitted. */
  step(entities: Entity[], send: (msg: WireMessage) => void): InstanceStatus[] {
    const globals = {
      hands: { count: entities.filter((e) => e.type === "hand").length },
      faces: { count: entities.filter((e) => e.type === "face").length },
    };
    const statuses: InstanceStatus[] = [];
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
          if (name === "lm") return (i: number) => entity.landmarks[i | 0];
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
              if (t.emit) send(t.emit(ctx, key));
              inst.state = t.goto;
              break;
            }
          }

          // Continuous emit of the (possibly new) current state
          const cur = g.states[inst.state]!;
          if (cur.emit) send(cur.emit(ctx, key));

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
          send(inst.gesture.onLost(inst.lastCtx, key));
        } catch {
          // last ctx may not satisfy the emit — drop it
        }
      }
      this.instances.delete(key);
    }

    return statuses;
  }
}
