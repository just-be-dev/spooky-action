// Camera + MediaPipe tracking, feeding the data-driven gesture engine.
// Detection happens here; gesture logic lives in defs/*.json (served by the
// backend at /api/gestures); emitted wire messages go over WebSocket to the
// server, which drives the native overlay.
//
// The whole tracker is one Effect program: setup failures are tagged errors
// shown in the status line, and the rAF loop is an Effect repeated forever.
import {
  FilesetResolver,
  HandLandmarker,
  FaceLandmarker,
} from "@mediapipe/tasks-vision";
import { Effect, Ref, Schema } from "effect";
import {
  GestureDef,
  GestureEngine,
  type Entity,
  type FrameResult,
  type InstanceStatus,
  type Point,
  type WireMessage,
} from "./engine";
import { HAND_LANDMARKS, FACE_LANDMARKS } from "./landmarks";

const video = document.getElementById("video") as HTMLVideoElement;
const canvas = document.getElementById("overlay") as HTMLCanvasElement;
const status = document.getElementById("status")!;
const panel = document.getElementById("panel")!;
const ctx = canvas.getContext("2d")!;

const MAX_HANDS = 4;
const MAX_FACES = 2;

// Max anchor movement (normalized) between frames to count as the same
// hand/face when matching detections to tracked entity IDs.
const MATCH_DIST = 0.25;

const errMsg = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export class ModelLoadError extends Schema.TaggedErrorClass<ModelLoadError>()(
  "ModelLoadError",
  { message: Schema.String }
) {}

export class CameraError extends Schema.TaggedErrorClass<CameraError>()(
  "CameraError",
  { message: Schema.String }
) {}

export class DefsError extends Schema.TaggedErrorClass<DefsError>()(
  "DefsError",
  { message: Schema.String }
) {}

const ws = new WebSocket(`ws://${location.host}/ws`);
function send(msg: WireMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// --- entity tracking (persistent IDs across frames, multi-person) ---

type Tracked = { id: number; anchor: Point };
type TrackState = { tracked: Tracked[]; nextId: number };

function matchTracked(
  prev: readonly Tracked[],
  anchors: readonly Point[],
  firstFreeId: number
): TrackState {
  const remaining = [...prev];
  let nextId = firstFreeId;
  const tracked = anchors.map((anchor) => {
    let best = -1;
    let bestDist = MATCH_DIST;
    for (let j = 0; j < remaining.length; j++) {
      const d = Math.hypot(
        remaining[j]!.anchor.x - anchor.x,
        remaining[j]!.anchor.y - anchor.y
      );
      if (d < bestDist) {
        best = j;
        bestDist = d;
      }
    }
    if (best >= 0) {
      const match = remaining.splice(best, 1)[0]!;
      return { ...match, anchor };
    }
    return { id: nextId++, anchor };
  });
  return { tracked, nextId };
}

// Mirror x so entity coords match the mirrored video display (and the screen)
function mirror(landmarks: Point[]): Point[] {
  return landmarks.map((p) => ({ x: 1 - p.x, y: p.y }));
}

// Resolves on the next animation frame
const nextFrame = Effect.callback<number>((resume) => {
  const id = requestAnimationFrame((t) => resume(Effect.succeed(t)));
  return Effect.sync(() => cancelAnimationFrame(id));
});

const main = Effect.fn("tracker.main")(function* () {
  // --- gesture definitions (data, hot-reloadable with "r") ---
  const engineRef = yield* Ref.make<GestureEngine | null>(null);
  const defNamesRef = yield* Ref.make<readonly string[]>([]);
  const defErrorRef = yield* Ref.make("");

  const loadGestures = Effect.fn("loadGestures")(
    function* () {
      const res = yield* Effect.tryPromise({
        try: () => fetch("/api/gestures"),
        catch: (cause) => new DefsError({ message: errMsg(cause) }),
      });
      const body = yield* Effect.tryPromise({
        try: () => res.json(),
        catch: (cause) => new DefsError({ message: errMsg(cause) }),
      });
      if (!res.ok)
        return yield* new DefsError({
          message: (body as { error?: string }).error ?? `HTTP ${res.status}`,
        });
      const defs = yield* Schema.decodeUnknownEffect(Schema.Array(GestureDef))(
        body
      );
      const engine = yield* GestureEngine.make(defs);
      yield* Ref.set(engineRef, engine);
      yield* Ref.set(defNamesRef, defs.map((d) => d.name));
      yield* Ref.set(defErrorRef, "");
      yield* Effect.sync(() => send({ type: "hideall", id: "*" })); // clear rings from the old engine
    },
    // Any def failure (fetch, schema, expression compile) drops the engine
    // and surfaces the message in the panel instead of failing the tracker.
    (effect) =>
      effect.pipe(
        Effect.catch((err) =>
          Effect.gen(function* () {
            yield* Ref.set(engineRef, null);
            yield* Ref.set(defErrorRef, err.message);
          })
        )
      )
  );

  yield* Effect.sync(() =>
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "r") void Effect.runPromise(loadGestures());
    })
  );

  yield* loadGestures();

  yield* Effect.sync(() => (status.textContent = "Loading models…"));
  const { handLandmarker, faceLandmarker } = yield* Effect.tryPromise({
    try: async () => {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
      );
      const [handLandmarker, faceLandmarker] = await Promise.all([
        HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: MAX_HANDS,
        }),
        FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numFaces: MAX_FACES,
        }),
      ]);
      return { handLandmarker, faceLandmarker };
    },
    catch: (cause) => new ModelLoadError({ message: errMsg(cause) }),
  });

  yield* Effect.sync(() => (status.textContent = "Requesting camera…"));
  const stream = yield* Effect.tryPromise({
    try: () =>
      navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
      }),
    catch: (cause) => new CameraError({ message: errMsg(cause) }),
  });
  yield* Effect.sync(() => (video.srcObject = stream));
  yield* Effect.callback<void>((resume) => {
    video.onloadedmetadata = () => resume(Effect.void);
  });

  yield* Effect.sync(() => (status.textContent = "No one detected"));

  // --- frame loop ---
  const handsRef = yield* Ref.make<TrackState>({ tracked: [], nextId: 1 });
  const facesRef = yield* Ref.make<TrackState>({ tracked: [], nextId: 1 });
  const lastVideoTimeRef = yield* Ref.make(-1);

  const processFrame = Effect.fn("processFrame")(function* () {
    const lastVideoTime = yield* Ref.get(lastVideoTimeRef);
    if (video.currentTime === lastVideoTime) return;
    yield* Ref.set(lastVideoTimeRef, video.currentTime);

    const detected = yield* Effect.sync(() => {
      const now = performance.now();
      const hands = handLandmarker.detectForVideo(video, now);
      const faces = faceLandmarker.detectForVideo(video, now);
      return {
        handLms: hands.landmarks.map(mirror),
        faceLms: faces.faceLandmarks.map(mirror),
        handedness: hands.handedness,
      };
    });

    const prevHands = yield* Ref.get(handsRef);
    const trackedHands = matchTracked(
      prevHands.tracked,
      detected.handLms.map((h) => h[HAND_LANDMARKS.wrist!]!),
      prevHands.nextId
    );
    yield* Ref.set(handsRef, trackedHands);

    const prevFaces = yield* Ref.get(facesRef);
    const trackedFaces = matchTracked(
      prevFaces.tracked,
      detected.faceLms.map((f) => f[FACE_LANDMARKS.nose_tip!]!),
      prevFaces.nextId
    );
    yield* Ref.set(facesRef, trackedFaces);

    const entities: Entity[] = [
      ...detected.handLms.map(
        (landmarks, i): Entity => ({
          type: "hand",
          id: trackedHands.tracked[i]!.id,
          landmarks,
          names: HAND_LANDMARKS,
          label: detected.handedness[i]?.[0]?.categoryName,
        })
      ),
      ...detected.faceLms.map(
        (landmarks, i): Entity => ({
          type: "face",
          id: trackedFaces.tracked[i]!.id,
          landmarks,
          names: FACE_LANDMARKS,
        })
      ),
    ];

    // Run gestures; echo emitted circles/clicks onto the local canvas so
    // the preview shows exactly what the overlay shows.
    const engine = yield* Ref.get(engineRef);
    const empty: FrameResult = { statuses: [], messages: [] };
    const { statuses, messages } = engine
      ? yield* engine.step(entities)
      : empty;

    const defError = yield* Ref.get(defErrorRef);
    const defNames = yield* Ref.get(defNamesRef);

    yield* Effect.sync(() => {
      for (const msg of messages) send(msg);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const e of entities) drawEntity(e);
      drawEmits(messages);
      updateStatus(entities, statuses, defError, defNames);
    });
  });

  return yield* Effect.forever(
    nextFrame.pipe(Effect.flatMap(() => processFrame()))
  );
});

// --- preview drawing (visualization only — no gesture logic here) ---

function drawEntity(e: Entity) {
  if (e.type === "hand") {
    ctx.fillStyle = "#38bdf8";
    for (const p of e.landmarks) {
      ctx.beginPath();
      ctx.arc(p.x * canvas.width, p.y * canvas.height, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const wrist = e.landmarks[HAND_LANDMARKS.wrist!]!;
    drawLabel(
      `hand #${e.id}${e.label ? ` ${e.label}` : ""}`,
      wrist.x * canvas.width,
      wrist.y * canvas.height + 22
    );
  } else {
    ctx.strokeStyle = "#a78bfa";
    ctx.lineWidth = 2;
    for (const { start, end } of FaceLandmarker.FACE_LANDMARKS_FACE_OVAL) {
      ctx.beginPath();
      ctx.moveTo(e.landmarks[start]!.x * canvas.width, e.landmarks[start]!.y * canvas.height);
      ctx.lineTo(e.landmarks[end]!.x * canvas.width, e.landmarks[end]!.y * canvas.height);
      ctx.stroke();
    }
    const chin = e.landmarks[FACE_LANDMARKS.chin!]!;
    drawLabel(`face #${e.id}`, chin.x * canvas.width, chin.y * canvas.height + 18);
  }
}

function drawEmits(msgs: ReadonlyArray<WireMessage>) {
  for (const msg of msgs) {
    if (msg.type === "circle") {
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(
        (msg.x as number) * canvas.width,
        (msg.y as number) * canvas.height,
        ((msg.r as number) / 64) * 40 + 6,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    } else if (msg.type === "click") {
      ctx.strokeStyle = "#facc15";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(
        (msg.x as number) * canvas.width,
        (msg.y as number) * canvas.height,
        18,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }
  }
}

function drawLabel(text: string, x: number, y: number) {
  ctx.fillStyle = "#eee";
  ctx.font = "13px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(text, x, y);
}

function fmt(v: unknown): string {
  if (typeof v === "number") return v.toFixed(2);
  if (v && typeof v === "object" && "x" in v)
    return `(${(v as Point).x.toFixed(2)}, ${(v as Point).y.toFixed(2)})`;
  return String(v);
}

function updateStatus(
  entities: ReadonlyArray<Entity>,
  statuses: ReadonlyArray<InstanceStatus>,
  defError: string,
  defNames: readonly string[]
) {
  const hands = entities.filter((e) => e.type === "hand").length;
  const faces = entities.filter((e) => e.type === "face").length;

  const active = statuses.filter((s) => s.state !== "idle" || s.error);
  status.textContent =
    entities.length === 0
      ? "No one detected"
      : `${faces} face${faces === 1 ? "" : "s"} · ${hands} hand${hands === 1 ? "" : "s"}` +
        (active.length ? ` · ${active.map((s) => `${s.gesture}:${s.state}`).join(", ")}` : "");
  status.classList.toggle("active", active.some((s) => !s.error));

  const lines: string[] = [];
  if (defError) lines.push(`<span class="err">defs failed: ${defError}</span>`);
  else lines.push(`gestures loaded: ${defNames.join(", ") || "(none)"}`);
  for (const s of statuses) {
    const metrics = Object.entries(s.metrics)
      .map(([k, v]) => `${k}=${fmt(v)}`)
      .join("  ");
    lines.push(
      s.error
        ? `<span class="err">${s.key}: ${s.error}</span>`
        : `${s.key} [${s.state}]  ${metrics}`
    );
  }
  panel.innerHTML = lines.join("\n");
}

// Setup failures (models, camera) land here; per-frame and per-def problems
// are handled inside the loop and shown in the panel instead.
Effect.runFork(
  main().pipe(
    Effect.catch((err) =>
      Effect.gen(function* () {
        yield* Effect.logError("Tracker failed", err);
        yield* Effect.sync(() => (status.textContent = `Error: ${err.message}`));
      })
    )
  )
);
