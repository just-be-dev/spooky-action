// Pinch pointer: serves the hand-tracking page and bridges pinch events
// over WebSocket to the native macOS overlay (../control/overlay.swift),
// which draws the on-screen ring and posts real clicks.
import index from "./index.html";
import { $ } from "bun";

const DIR = import.meta.dir;
const BIN = `${DIR}/../control/overlay-bin`;
const SRC = `${DIR}/../control/overlay.swift`;

// Compile the Swift overlay on first run (or when the source is newer)
const binFile = Bun.file(BIN);
const needsBuild =
  !(await binFile.exists()) ||
  binFile.lastModified < Bun.file(SRC).lastModified;
if (needsBuild) {
  console.log("Compiling overlay.swift…");
  await $`swiftc -O ${SRC} -o ${BIN}`;
}

let overlay: ReturnType<typeof Bun.spawn> | null = null;
function getOverlay() {
  if (!overlay || overlay.killed) {
    overlay = Bun.spawn([BIN], {
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
    });
  }
  return overlay;
}

function command(line: string) {
  const proc = getOverlay();
  proc.stdin.write(line + "\n");
  proc.stdin.flush();
}

const server = Bun.serve({
  port: 7900,
  routes: {
    "/": index,
  },
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws" && server.upgrade(req)) return;
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open() {
      getOverlay(); // launch the overlay as soon as the tracker connects
    },
    message(_ws, raw) {
      const msg = JSON.parse(String(raw));
      // The shared overlay supports multiple named rings; the pointer only
      // ever drives one, so it always uses the id "ptr".
      switch (msg.t) {
        case "circle":
          command(`circle ptr ${msg.x} ${msg.y} ${msg.r}`);
          break;
        case "hide":
          command("hide ptr");
          break;
        case "click":
          command(`click ${msg.x} ${msg.y}`);
          break;
      }
    },
    close() {
      command("hideall"); // tracker tab closed — don't leave a stale ring up
    },
  },
});

process.on("exit", () => overlay?.kill());

console.log(`Pinch pointer running — open ${server.url} to start tracking`);
console.log(
  "Note: clicking requires Accessibility permission for your terminal app"
);
