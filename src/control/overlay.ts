// Effect service around the native macOS overlay (overlay.swift), which
// draws on-screen rings and posts real clicks. Shared by the pinch pointer
// and the gesture lab servers.
//
// The layer compiles the Swift binary when stale, spawns the process lazily
// (on `launch` or the first `command`), respawns it if it died, and kills it
// when the layer's scope closes.
import { $ } from "bun";
import { Effect, Layer, Ref, Schema } from "effect";
import * as Context from "effect/Context";

const DIR = import.meta.dir;
const BIN = `${DIR}/overlay-bin`;
const SRC = `${DIR}/overlay.swift`;

export class OverlayBuildError extends Schema.TaggedErrorClass<OverlayBuildError>()(
  "OverlayBuildError",
  { cause: Schema.Defect }
) {}

const spawnOverlay = () =>
  Bun.spawn([BIN], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
type OverlayProcess = ReturnType<typeof spawnOverlay>;

export class Overlay extends Context.Service<
  Overlay,
  {
    /** Spawn the overlay process if it isn't already running. */
    readonly launch: Effect.Effect<void>;
    /** Send one line to the overlay's stdin command protocol. */
    readonly command: (line: string) => Effect.Effect<void>;
  }
>()("@collabspace/Overlay") {
  static readonly layer = Layer.effect(
    Overlay,
    Effect.gen(function* () {
      // Compile the Swift overlay on first run (or when the source is newer)
      const binFile = Bun.file(BIN);
      const needsBuild = yield* Effect.tryPromise({
        try: async () =>
          !(await binFile.exists()) ||
          binFile.lastModified < Bun.file(SRC).lastModified,
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
        Ref.get(proc).pipe(Effect.map((p) => p?.kill()), Effect.asVoid)
      );

      const command = Effect.fn("Overlay.command")(function* (line: string) {
        const p = yield* ensureRunning;
        yield* Effect.sync(() => {
          p.stdin.write(line + "\n");
          p.stdin.flush();
        });
      });

      return { launch: Effect.asVoid(ensureRunning), command };
    })
  );
}
