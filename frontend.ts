import {
  FilesetResolver,
  HandLandmarker,
  FaceLandmarker,
} from "@mediapipe/tasks-vision";

const video = document.getElementById("video") as HTMLVideoElement;
const canvas = document.getElementById("overlay") as HTMLCanvasElement;
const status = document.getElementById("status")!;
const ctx = canvas.getContext("2d")!;

// Hand landmark indices: https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const WRIST = 0;
const MIDDLE_MCP = 9;

// Face landmark indices (478-point mesh)
const NOSE_TIP = 1;
const FOREHEAD = 10;
const CHIN = 152;
const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const FACE_LEFT_EDGE = 234;
const FACE_RIGHT_EDGE = 454;

// Raise these to track more (2 people = 4 hands / 2 faces, etc.)
const MAX_HANDS = 4;
const MAX_FACES = 2;

// Hysteresis thresholds (pinch distance relative to hand size) so the
// state doesn't flicker right at the boundary.
const PINCH_START = 0.35;
const PINCH_END = 0.45;

// Max anchor movement (normalized coords) between frames to count as the
// same hand/face when matching detections to tracked entities.
const MATCH_DIST = 0.25;

type Point = { x: number; y: number };

type TrackedHand = {
  id: number;
  label: string; // "Left" / "Right" (display only — not used as identity)
  anchor: Point; // wrist
  pinching: boolean;
};

type TrackedFace = {
  id: number;
  anchor: Point; // nose tip
  yaw: number;
  pitch: number;
  roll: number;
};

let trackedHands: TrackedHand[] = [];
let trackedFaces: TrackedFace[] = [];
let nextHandId = 1;
let nextFaceId = 1;

function dist(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Match this frame's detections to previously tracked entities by anchor
// proximity (greedy nearest-neighbor) so state survives across frames,
// even with multiple people in view.
function matchTracked<T extends { anchor: Point }>(
  prev: T[],
  anchors: Point[],
  create: (anchor: Point) => T
): T[] {
  const remaining = [...prev];
  return anchors.map((anchor) => {
    let best = -1;
    let bestDist = MATCH_DIST;
    for (let j = 0; j < remaining.length; j++) {
      const d = dist(remaining[j].anchor, anchor);
      if (d < bestDist) {
        best = j;
        bestDist = d;
      }
    }
    if (best >= 0) {
      const match = remaining.splice(best, 1)[0];
      return { ...match, anchor };
    }
    return create(anchor);
  });
}

async function main() {
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
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      trackedHands = matchTracked(
        trackedHands,
        hands.landmarks.map((h) => h[WRIST]),
        (anchor) => ({ id: nextHandId++, label: "?", anchor, pinching: false })
      );
      for (let i = 0; i < hands.landmarks.length; i++) {
        trackedHands[i].label =
          hands.handedness[i]?.[0]?.categoryName ?? "?";
        drawHand(trackedHands[i], hands.landmarks[i]);
      }

      trackedFaces = matchTracked(
        trackedFaces,
        faces.faceLandmarks.map((f) => f[NOSE_TIP]),
        (anchor) => ({ id: nextFaceId++, anchor, yaw: 0, pitch: 0, roll: 0 })
      );
      for (let i = 0; i < faces.faceLandmarks.length; i++) {
        drawFace(trackedFaces[i], faces.faceLandmarks[i]);
      }

      updateStatus();
    }
    requestAnimationFrame(loop);
  }
  loop();
}

function drawHand(hand: TrackedHand, landmarks: Point[]) {
  const thumb = landmarks[THUMB_TIP];
  const index = landmarks[INDEX_TIP];

  // Normalize by hand size so pinch works at any distance from the camera
  const handSize = dist(landmarks[WRIST], landmarks[MIDDLE_MCP]);
  const ratio = dist(thumb, index) / handSize;

  hand.pinching = hand.pinching ? ratio <= PINCH_END : ratio < PINCH_START;

  // Draw all landmarks
  ctx.fillStyle = "#38bdf8";
  for (const p of landmarks) {
    ctx.beginPath();
    ctx.arc(p.x * canvas.width, p.y * canvas.height, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Highlight the pinch pair
  ctx.strokeStyle = hand.pinching ? "#22c55e" : "#f87171";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(thumb.x * canvas.width, thumb.y * canvas.height);
  ctx.lineTo(index.x * canvas.width, index.y * canvas.height);
  ctx.stroke();

  drawLabel(
    `#${hand.id} ${hand.label}${hand.pinching ? " 🤏" : ""}`,
    hand.anchor.x * canvas.width,
    hand.anchor.y * canvas.height + 24
  );
}

// Head pose estimated from landmark geometry (rough but dependency-free):
// yaw   — how off-center the nose tip sits between the face edges
// pitch — how off-center it sits between forehead and chin
// roll  — angle of the line between the outer eye corners
function drawFace(face: TrackedFace, landmarks: Point[]) {
  const nose = landmarks[NOSE_TIP];
  const left = landmarks[FACE_LEFT_EDGE];
  const right = landmarks[FACE_RIGHT_EDGE];
  const top = landmarks[FOREHEAD];
  const bottom = landmarks[CHIN];
  const eyeL = landmarks[LEFT_EYE_OUTER];
  const eyeR = landmarks[RIGHT_EYE_OUTER];

  face.yaw = ((nose.x - left.x) / (right.x - left.x) - 0.5) * 180;
  face.pitch = ((nose.y - top.y) / (bottom.y - top.y) - 0.55) * 180;
  face.roll = (Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x) * 180) / Math.PI;

  // Face outline
  ctx.strokeStyle = "#a78bfa";
  ctx.lineWidth = 2;
  for (const { start, end } of FaceLandmarker.FACE_LANDMARKS_FACE_OVAL) {
    ctx.beginPath();
    ctx.moveTo(landmarks[start].x * canvas.width, landmarks[start].y * canvas.height);
    ctx.lineTo(landmarks[end].x * canvas.width, landmarks[end].y * canvas.height);
    ctx.stroke();
  }

  // Gaze direction arrow from face center through the nose tip
  const cx = (left.x + right.x) / 2;
  const cy = (top.y + bottom.y) / 2;
  ctx.strokeStyle = "#facc15";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx * canvas.width, cy * canvas.height);
  ctx.lineTo(
    (cx + (nose.x - cx) * 3) * canvas.width,
    (cy + (nose.y - cy) * 3) * canvas.height
  );
  ctx.stroke();

  drawLabel(
    `Face #${face.id}  yaw ${face.yaw.toFixed(0)}°  pitch ${face.pitch.toFixed(0)}°  roll ${face.roll.toFixed(0)}°`,
    nose.x * canvas.width,
    bottom.y * canvas.height + 20
  );
}

// The canvas is mirrored via CSS, so flip text horizontally here so it
// reads correctly on screen.
function drawLabel(text: string, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(-1, 1);
  ctx.fillStyle = "#eee";
  ctx.font = "14px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function updateStatus() {
  if (trackedHands.length === 0 && trackedFaces.length === 0) {
    status.textContent = "No one detected";
    status.classList.remove("pinching");
    return;
  }
  const pinchCount = trackedHands.filter((h) => h.pinching).length;
  const parts = [
    `${trackedFaces.length} face${trackedFaces.length === 1 ? "" : "s"}`,
    `${trackedHands.length} hand${trackedHands.length === 1 ? "" : "s"}`,
    `${pinchCount} pinching`,
  ];
  status.textContent = parts.join(" · ");
  status.classList.toggle("pinching", pinchCount > 0);
}

main().catch((err) => {
  status.textContent = `Error: ${err.message}`;
  console.error(err);
});
