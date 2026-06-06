// Hand tracking for the pinch pointer. The pinch logic itself is a pure
// transition function (`pinchStep`): previous state + detected hands in,
// next state + wire messages + UI hints out. The Effect shell around it
// loads the model, opens the camera, and repeats the rAF frame loop.
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { Effect, Ref, Schema } from "effect";

const video = document.getElementById("video") as HTMLVideoElement;
const canvas = document.getElementById("overlay") as HTMLCanvasElement;
const status = document.getElementById("status")!;
const ctx = canvas.getContext("2d")!;

const THUMB_TIP = 4;
const INDEX_TIP = 8;
const WRIST = 0;
const MIDDLE_MCP = 9;

// Pinch distance relative to hand size:
// below SHOW the circle appears; at CLICK the pinch completes and clicks;
// the click re-arms once the fingers separate past REARM (hysteresis).
const SHOW = 0.9;
const CLICK = 0.35;
const REARM = 0.5;

// On-screen ring radius range (px), mapped from the pinch ratio
const R_MIN = 8;
const R_MAX = 64;

// EMA smoothing for the pointer position (higher = snappier, lower = steadier)
const SMOOTH = 0.4;

type Point = { x: number; y: number };

type WireMessage =
  | { t: "circle"; x: number; y: number; r: number }
  | { t: "hide" }
  | { t: "click"; x: number; y: number };

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

const ws = new WebSocket(`ws://${location.host}/ws`);
function send(msg: WireMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function dist(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// --- pure pinch state machine ---

type PinchState = {
  armed: boolean;
  shown: boolean;
  smoothed: Point | null;
};

const initialState: PinchState = { armed: true, shown: false, smoothed: null };

type FrameOutput = {
  next: PinchState;
  msgs: WireMessage[];
  statusText: string;
  pinching: boolean;
  ring: { pos: Point; r: number; armed: boolean } | null;
};

function pinchStep(prev: PinchState, hands: Point[][]): FrameOutput {
  // Clicks (and the pointer circle) only apply with exactly one hand in view
  if (hands.length !== 1) {
    return {
      next: { armed: prev.armed, shown: false, smoothed: null },
      msgs: prev.shown ? [{ t: "hide" }] : [],
      statusText:
        hands.length === 0 ? "Show one hand" : "One hand only — pointer paused",
      pinching: false,
      ring: null,
    };
  }

  const hand = hands[0]!;
  const thumb = hand[THUMB_TIP]!;
  const index = hand[INDEX_TIP]!;
  const handSize = dist(hand[WRIST]!, hand[MIDDLE_MCP]!);
  const ratio = dist(thumb, index) / handSize;

  // Pointer position: midpoint of the pinch pair, mirrored horizontally so
  // moving your hand right moves the circle right.
  const raw = {
    x: 1 - (thumb.x + index.x) / 2,
    y: (thumb.y + index.y) / 2,
  };
  const smoothed = prev.smoothed
    ? {
        x: prev.smoothed.x + (raw.x - prev.smoothed.x) * SMOOTH,
        y: prev.smoothed.y + (raw.y - prev.smoothed.y) * SMOOTH,
      }
    : raw;

  if (ratio >= SHOW) {
    return {
      next: { armed: true, shown: false, smoothed },
      msgs: prev.shown ? [{ t: "hide" }] : [],
      statusText: "Bring thumb + index together",
      pinching: false,
      ring: null,
    };
  }

  const t = Math.min(Math.max((ratio - CLICK) / (SHOW - CLICK), 0), 1);
  const r = R_MIN + t * (R_MAX - R_MIN);
  const msgs: WireMessage[] = [{ t: "circle", x: smoothed.x, y: smoothed.y, r }];

  let armed = prev.armed;
  if (armed && ratio < CLICK) {
    armed = false;
    msgs.push({ t: "click", x: smoothed.x, y: smoothed.y });
  } else if (!armed && ratio > REARM) {
    armed = true;
  }

  return {
    next: { armed, shown: true, smoothed },
    msgs,
    statusText: armed ? "Pinch to click" : "CLICK 🤏",
    pinching: !armed,
    ring: { pos: smoothed, r, armed },
  };
}

// --- preview drawing (visualization only) ---

function drawPreview(hand: Point[]) {
  ctx.fillStyle = "#38bdf8";
  for (const p of hand) {
    ctx.beginPath();
    ctx.arc(p.x * canvas.width, p.y * canvas.height, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const thumb = hand[THUMB_TIP]!;
  const index = hand[INDEX_TIP]!;
  ctx.strokeStyle = "#f87171";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(thumb.x * canvas.width, thumb.y * canvas.height);
  ctx.lineTo(index.x * canvas.width, index.y * canvas.height);
  ctx.stroke();
}

// Preview ring in the local canvas too (canvas is mirrored by CSS, so
// un-mirror x to match)
function drawRing({ pos, r, armed }: NonNullable<FrameOutput["ring"]>) {
  ctx.strokeStyle = armed ? "#22c55e" : "#facc15";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(
    (1 - pos.x) * canvas.width,
    pos.y * canvas.height,
    (r / R_MAX) * 40 + 6,
    0,
    Math.PI * 2
  );
  ctx.stroke();
}

// Resolves on the next animation frame
const nextFrame = Effect.callback<number>((resume) => {
  const id = requestAnimationFrame((t) => resume(Effect.succeed(t)));
  return Effect.sync(() => cancelAnimationFrame(id));
});

const main = Effect.fn("tracker.main")(function* () {
  const landmarker = yield* Effect.tryPromise({
    try: async () => {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
      );
      return HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 2, // detect a second hand so we can suppress clicks when it appears
      });
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

  yield* Effect.sync(() => (status.textContent = "Show one hand"));

  const stateRef = yield* Ref.make(initialState);
  const lastVideoTimeRef = yield* Ref.make(-1);

  const processFrame = Effect.fn("processFrame")(function* () {
    const lastVideoTime = yield* Ref.get(lastVideoTimeRef);
    if (video.currentTime === lastVideoTime) return;
    yield* Ref.set(lastVideoTimeRef, video.currentTime);

    const hands = yield* Effect.sync(
      () => landmarker.detectForVideo(video, performance.now()).landmarks
    );

    const prev = yield* Ref.get(stateRef);
    const out = pinchStep(prev, hands);
    yield* Ref.set(stateRef, out.next);

    yield* Effect.sync(() => {
      for (const msg of out.msgs) send(msg);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const hand of hands) drawPreview(hand);
      if (out.ring) drawRing(out.ring);
      status.textContent = out.statusText;
      status.classList.toggle("pinching", out.pinching);
    });
  });

  return yield* Effect.forever(
    nextFrame.pipe(Effect.flatMap(() => processFrame()))
  );
});

// Setup failures (model, camera) land here; everything after that is
// handled per frame.
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
