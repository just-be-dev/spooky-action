// Gesture lab backend: serves gesture definitions (defs/*.json) over HTTP
// and runs the control bridge, which pumps commands from the communication
// layer (WebSocket channel on 7901) into the control surface (native macOS
// overlay). The UI is the Foldkit app in src/ui, served by Vite, which
// proxies /api here and /ws to the channel.
//
// Bun.serve stays in charge of HTTP; its callbacks are the Effect boundary
// and run effects with runPromise.
import { Glob } from "bun";
import { Effect, Layer, Schema } from "effect";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { runControlBridge } from "./control/bridge";
import { webSocketChannelLayer } from "./control/channels/websocket";
import { overlaySurfaceLayer } from "./control/surfaces/mac/overlay";

const DEFS = `${import.meta.dir}/defs`;

export class DefsLoadError extends Schema.TaggedErrorClass<DefsLoadError>()(
  "DefsLoadError",
  { file: Schema.String, cause: Schema.Defect }
) {}

// Gesture definitions are read fresh on every request, so editing a
// defs/*.json and pressing "r" in the page picks up changes live.
const loadDefs = Effect.fn("loadDefs")(function* () {
  const names = yield* Effect.tryPromise({
    try: () => Array.fromAsync(new Glob("*.json").scan(DEFS)),
    catch: (cause) => new DefsLoadError({ file: DEFS, cause }),
  });
  const defs: unknown[] = [];
  for (const name of names) {
    defs.push(
      yield* Effect.tryPromise({
        try: () => Bun.file(`${DEFS}/${name}`).json(),
        catch: (cause) => new DefsLoadError({ file: name, cause }),
      })
    );
  }
  return defs;
});

const program = Effect.gen(function* () {
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 7900,
        routes: {
          "/api/gestures": {
            GET: () =>
              Effect.runPromise(
                loadDefs().pipe(
                  Effect.map((defs) => Response.json(defs)),
                  Effect.catchTag("DefsLoadError", (err) =>
                    Effect.logError("Failed to load gesture defs", err).pipe(
                      Effect.map(() =>
                        Response.json(
                          { error: `failed to load ${err.file}` },
                          { status: 500 }
                        )
                      )
                    )
                  )
                )
              ),
          },
        },
        fetch() {
          return new Response("Not found", { status: 404 });
        },
      })
    ),
    (server) => Effect.promise(() => server.stop())
  );

  yield* Effect.log(
    `Gesture lab backend on ${server.url} — run \`bun run dev\` and open the Vite URL to start tracking`
  );
  yield* Effect.log(
    "Note: clicking requires Accessibility permission for your terminal app"
  );
  // The bridge runs for the life of the app (its event stream never ends)
  return yield* runControlBridge;
});

const controlLayer = Layer.merge(
  webSocketChannelLayer.pipe(
    Layer.provide(BunHttpServer.layerServer({ port: 7901 }))
  ),
  overlaySurfaceLayer
);

BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(controlLayer)));
