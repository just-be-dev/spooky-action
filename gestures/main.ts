// Gesture lab server: serves the tracker page and gesture definitions
// (defs/*.json), and bridges wire messages from the browser to the native
// macOS overlay (overlay.swift), which draws rings and posts real clicks.
import index from "./index.html";
import { $, Glob } from "bun";

const DIR = import.meta.dir;
const BIN = `${DIR}/overlay-bin`;
const SRC = `${DIR}/overlay.swift`;
const DEFS = `${DIR}/defs`;

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

// Gesture definitions are read fresh on every request, so editing a
// defs/*.json and pressing "r" in the page picks up changes live.
async function loadDefs() {
  const defs: unknown[] = [];
  for await (const name of new Glob("*.json").scan(DEFS)) {
    defs.push(await Bun.file(`${DEFS}/${name}`).json());
  }
  return defs;
}

const server = Bun.serve({
  port: 7900,
  routes: {
    "/": index,
    "/api/gestures": {
      GET: async () => Response.json(await loadDefs()),
    },
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
      switch (msg.type) {
        case "circle":
          command(`circle ${msg.id} ${msg.x} ${msg.y} ${msg.r}`);
          break;
        case "hide":
          command(`hide ${msg.id}`);
          break;
        case "hideall":
          command("hideall");
          break;
        case "click":
          command(`click ${msg.x} ${msg.y}`);
          break;
        default:
          console.warn("Unknown wire message:", msg.type);
      }
    },
    close() {
      command("hideall"); // tracker tab closed — don't leave stale rings up
    },
  },
});

process.on("exit", () => overlay?.kill());

console.log(`Gesture lab running — open ${server.url} to start tracking`);
console.log(
  "Note: clicking requires Accessibility permission for your terminal app"
);
