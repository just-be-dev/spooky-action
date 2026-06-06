// Camera + MediaPipe tracking, feeding the data-driven gesture engine.
// Detection happens here; gesture logic lives in defs/*.json (served by the
// backend at /api/gestures); emitted wire messages go over WebSocket to the
// server, which drives the native overlay.
import {
  FilesetResolver,
  HandLandmarker,
  FaceLandmarker,
} from "@mediapipe/tasks-vision";
import {
  GestureEngine,
  type Entity,
  type GestureDef,
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

const ws = new WebSocket(`ws://${location.host}/ws`);
function send(msg: WireMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// --- gesture definitions (data, hot-reloadable with "r") ---

let engine: GestureEngine | null = null;
let defError = "";
let defNames: string[] = [];

async function loadGestures() {
  try {
    const defs = (await (await fetch("/api/gestures")).json()) as GestureDef[];
    engine = new GestureEngine(defs);
    defNames = defs.map((d) => d.name);
    defError = "";
    send({ type: "hideall", id: "*" }); // clear rings from the old engine
  } catch (err) {
    defError = (err as Error).message;
    engine = null;
  }
}

addEventListener("keydown", (e) => {
  if (e.key === "r") loadGestures();
});

// --- entity tracking (persistent IDs across frames, multi-person) ---

type Tracked = { id: number; anchor: Point };

function matchTracked(prev: Tracked[], anchors: Point[], nextId: () => number): Tracked[] {
  const remaining = [...prev];
  return anchors.map((anchor) => {
    let best = -1;
    let bestDist = MATCH_DIST;
    for (let j = 0; j < remaining.length; j++) {
      const d = Math.hypot(remaining[j]!.anchor.x - anchor.x, remaining[j]!.anchor.y - anchor.y);
      if (d < bestDist) {
        best = j;
        bestDist = d;
      }
    }
    if (best >= 0) {
      const match = remaining.splice(best, 1)[0]!;
      return { ...match, anchor };
    }
    return { id: nextId(), anchor };
  });
}

let trackedHands: Tracked[] = [];
let trackedFaces: Tracked[] = [];
let nextHandId = 1;
let nextFaceId = 1;

// Mirror x so entity coords match the mirrored video display (and the screen)
function mirror(landmarks: Point[]): Point[] {
  return landmarks.map((p) => ({ x: 1 - p.x, y: p.y }));
}

async function main() {
  await loadGestures();

  status.textContent = "Loading models…";
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

  status.textContent = "Requesting camera…";
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
  });
  video.srcObject = stream;
  await new Promise((r) => (video.onloadedmetadata = r));

  status.textContent = "No one detected";

  let lastVideoTime = -1;
  function loop() {
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const now = performance.now();
      const hands = handLandmarker.detectForVideo(video, now);
      const faces = faceLandmarker.detectForVideo(video, now);

      const handLms = hands.landmarks.map(mirror);
      const faceLms = faces.faceLandmarks.map(mirror);

      trackedHands = matchTracked(
        trackedHands,
        handLms.map((h) => h[HAND_LANDMARKS.wrist!]!),
        () => nextHandId++
      );
      trackedFaces = matchTracked(
        trackedFaces,
        faceLms.map((f) => f[FACE_LANDMARKS.nose_tip!]!),
        () => nextFaceId++
      );

      const entities: Entity[] = [
        ...handLms.map((landmarks, i): Entity => ({
          type: "hand",
          id: trackedHands[i]!.id,
          landmarks,
          names: HAND_LANDMARKS,
          label: hands.handedness[i]?.[0]?.categoryName,
        })),
        ...faceLms.map((landmarks, i): Entity => ({
          type: "face",
          id: trackedFaces[i]!.id,
          landmarks,
          names: FACE_LANDMARKS,
        })),
      ];

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Run gestures; echo emitted circles/clicks onto the local canvas so
      // the preview shows exactly what the overlay shows.
      const frameMsgs: WireMessage[] = [];
      const statuses = engine
        ? engine.step(entities, (msg) => {
            send(msg);
            frameMsgs.push(msg);
          })
        : [];

      for (const e of entities) drawEntity(e);
      drawEmits(frameMsgs);
      updateStatus(entities, statuses);
    }
    requestAnimationFrame(loop);
  }
  loop();
}

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

function drawEmits(msgs: WireMessage[]) {
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

function updateStatus(entities: Entity[], statuses: InstanceStatus[]) {
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

main().catch((err) => {
  status.textContent = `Error: ${err.message}`;
  console.error(err);
});
