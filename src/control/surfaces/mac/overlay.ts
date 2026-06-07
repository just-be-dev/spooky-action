// macOS implementation of a ControlSurface: wraps the native overlay
// (overlay.swift), which draws on-screen rings and posts real clicks.
//
// The surface builder compiles the Swift binary when stale, spawns the process lazily
// (on `activate` or the first command), respawns it if it died, and kills it
// when the layer's scope closes. The stdin line protocol is private to this
// file — nothing outside speaks it.
import { $ } from "bun";
import { Effect, Ref, Schema, Scope } from "effect";
import { capability } from "../../capability";
import type { ControlSurface } from "../../surface";

const DIR = import.meta.dir;
const BIN = `${DIR}/overlay-bin`;
const SRC = `${DIR}/overlay.swift`;

export class OverlayBuildError extends Schema.TaggedErrorClass<OverlayBuildError>()(
  "OverlayBuildError",
  { cause: Schema.Defect },
) {}

const spawnOverlay = () =>
  Bun.spawn([BIN], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
type OverlayProcess = ReturnType<typeof spawnOverlay>;

export const makeMacSurface: Effect.Effect<ControlSurface, OverlayBuildError, Scope.Scope> =
  Effect.gen(function* () {
    // Compile the Swift overlay on first run (or when the source is newer)
    const binFile = Bun.file(BIN);
    const needsBuild = yield* Effect.tryPromise({
      try: async () =>
        !(await binFile.exists()) || binFile.lastModified < Bun.file(SRC).lastModified,
      catch: (cause) => new OverlayBuildError({ cause }),
    });
    if (needsBuild) {
      yield* Effect.log("Compiling overlay.swift…");
      yield* Effect.tryPromise({
        try: () => $`swiftc -O ${SRC} -o ${BIN}`,
        catch: (cause) => new OverlayBuildError({ cause }),
      });
    }

    const proc = yield* Ref.make<OverlayProcess | null>(null);

    const ensureRunning = Effect.gen(function* () {
      const current = yield* Ref.get(proc);
      if (current && !current.killed) return current;
      const next = spawnOverlay();
      yield* Ref.set(proc, next);
      return next;
    });

    // Don't leave the overlay process behind when the app shuts down
    yield* Effect.addFinalizer(() =>
      Ref.get(proc).pipe(
        Effect.map((p) => p?.kill()),
        Effect.asVoid,
      ),
    );

    // The overlay's stdin command protocol — one line per command
    const command = Effect.fn("Overlay.command")(function* (line: string) {
      const p = yield* ensureRunning;
      yield* Effect.sync(() => {
        p.stdin.write(line + "\n");
        p.stdin.flush();
      });
    });

    return {
      id: "mac",
      label: "mac",
      activate: Effect.asVoid(ensureRunning),
      reset: command("hideall"),
      capabilities: [
        // Draw (or move) a ring. Coordinates are pixels.
        capability(
          "circle",
          {
            id: Schema.String,
            x: Schema.Finite,
            y: Schema.Finite,
            r: Schema.Finite,
          },
          ({ id, x, y, r }) => command(`circle ${id} ${x} ${y} ${r}`),
        ),
        // Remove one ring by id.
        capability("hide", { id: Schema.String }, ({ id }) => command(`hide ${id}`)),
        // Remove every ring.
        capability("hideall", {}, () => command("hideall")),
        // Post a real click at pixel coordinates.
        capability("click", { x: Schema.Finite, y: Schema.Finite }, ({ x, y }) =>
          command(`click ${x} ${y}`),
        ),
      ],
    };
  });
