import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

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

const ws = new WebSocket(`ws://${location.host}/ws`);
function send(msg: object) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

let armed = true;
let shown = false;
let smoothed: Point | null = null;

function dist(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

async function main() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
  );
  const landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2, // detect a second hand so we can suppress clicks when it appears
  });

  status.textContent = "Requesting camera…";
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
  });
  video.srcObject = stream;
  await new Promise((r) => (video.onloadedmetadata = r));

  status.textContent = "Show one hand";

  let lastVideoTime = -1;
  function loop() {
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = landmarker.detectForVideo(video, performance.now());
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      update(result.landmarks);
    }
    requestAnimationFrame(loop);
  }
  loop();
}

function update(hands: Point[][]) {
  for (const hand of hands) drawPreview(hand);

  // Clicks (and the pointer circle) only apply with exactly one hand in view
  if (hands.length !== 1) {
    hideCircle();
    smoothed = null;
    status.textContent =
      hands.length === 0 ? "Show one hand" : "One hand only — pointer paused";
    status.classList.remove("pinching");
    return;
  }

  const hand = hands[0];
  const thumb = hand[THUMB_TIP];
  const index = hand[INDEX_TIP];
  const handSize = dist(hand[WRIST], hand[MIDDLE_MCP]);
  const ratio = dist(thumb, index) / handSize;

  // Pointer position: midpoint of the pinch pair, mirrored horizontally so
  // moving your hand right moves the circle right.
  const raw = {
    x: 1 - (thumb.x + index.x) / 2,
    y: (thumb.y + index.y) / 2,
  };
  smoothed = smoothed
    ? {
        x: smoothed.x + (raw.x - smoothed.x) * SMOOTH,
        y: smoothed.y + (raw.y - smoothed.y) * SMOOTH,
      }
    : raw;

  if (ratio < SHOW) {
    const t = Math.min(Math.max((ratio - CLICK) / (SHOW - CLICK), 0), 1);
    const r = R_MIN + t * (R_MAX - R_MIN);
    send({ t: "circle", x: smoothed.x, y: smoothed.y, r });
    shown = true;

    if (armed && ratio < CLICK) {
      armed = false;
      send({ t: "click", x: smoothed.x, y: smoothed.y });
      status.textContent = "CLICK 🤏";
      status.classList.add("pinching");
    } else if (!armed && ratio > REARM) {
      armed = true;
    }
    if (armed) {
      status.textContent = "Pinch to click";
      status.classList.remove("pinching");
    }

    // Preview ring in the local canvas too (canvas is mirrored by CSS, so
    // un-mirror x to match)
    ctx.strokeStyle = armed ? "#22c55e" : "#facc15";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(
      (1 - smoothed.x) * canvas.width,
      smoothed.y * canvas.height,
      (r / R_MAX) * 40 + 6,
      0,
      Math.PI * 2
    );
    ctx.stroke();
  } else {
    hideCircle();
    armed = true;
    status.textContent = "Bring thumb + index together";
    status.classList.remove("pinching");
  }
}

function hideCircle() {
  if (shown) {
    send({ t: "hide" });
    shown = false;
  }
}

function drawPreview(hand: Point[]) {
  ctx.fillStyle = "#38bdf8";
  for (const p of hand) {
    ctx.beginPath();
    ctx.arc(p.x * canvas.width, p.y * canvas.height, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const thumb = hand[THUMB_TIP];
  const index = hand[INDEX_TIP];
  ctx.strokeStyle = "#f87171";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(thumb.x * canvas.width, thumb.y * canvas.height);
  ctx.lineTo(index.x * canvas.width, index.y * canvas.height);
  ctx.stroke();
}

main().catch((err) => {
  status.textContent = `Error: ${err.message}`;
  console.error(err);
});
