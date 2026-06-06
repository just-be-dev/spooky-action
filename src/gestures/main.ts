// Gesture lab backend: serves gesture definitions (defs/*.json) and bridges
// wire messages from the browser to the native macOS overlay
// (../control/overlay.ts → overlay.swift), which draws rings and posts real
// clicks. The UI is the Foldkit app in src/ui, served by Vite, which proxies
// /api and /ws here.
//
// Bun.serve stays in charge of HTTP/WS; its callbacks are the Effect
// boundary and run effects with runSync/runPromise.
import { Glob } from "bun";
import { Effect, Schema } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import { Overlay } from "../control/overlay";

const DEFS = `${import.meta.dir}/defs`;

export class DefsLoadError extends Schema.TaggedErrorClass<DefsLoadError>()(
  "DefsLoadError",
  { file: Schema.String, cause: Schema.Defect }
) {}

// Wire messages from the browser: gesture-engine emits plus tracker
// housekeeping. Anything that doesn't decode is logged and dropped.
const WireMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("circle"),
    id: Schema.String,
    x: Schema.Number,
    y: Schema.Number,
    r: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("hide"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("hideall") }),
  Schema.Struct({
    type: Schema.Literal("click"),
    x: Schema.Number,
    y: Schema.Number,
  }),
]);
const decodeWire = Schema.decodeUnknownEffect(Schema.fromJsonString(WireMessage));

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
  const overlay = yield* Overlay;

  // Map one decoded wire message onto an overlay stdin command
  const handleWire = Effect.fn("handleWire")(function* (raw: string | Buffer) {
    const msg = yield* decodeWire(String(raw));
    switch (msg.type) {
      case "circle":
        return yield* overlay.command(
          `circle ${msg.id} ${msg.x} ${msg.y} ${msg.r}`
        );
      case "hide":
        return yield* overlay.command(`hide ${msg.id}`);
      case "hideall":
        return yield* overlay.command("hideall");
      case "click":
        return yield* overlay.command(`click ${msg.x} ${msg.y}`);
    }
  });

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
        fetch(req, server) {
          if (new URL(req.url).pathname === "/ws" && server.upgrade(req)) return;
          return new Response("Not found", { status: 404 });
        },
        websocket: {
          open() {
            // launch the overlay as soon as the tracker connects
            Effect.runSync(overlay.launch);
          },
          message(_ws, raw) {
            Effect.runSync(
              handleWire(raw).pipe(
                Effect.catch((err) =>
                  Effect.logWarning("Unknown wire message", err)
                )
              )
            );
          },
          close() {
            // tracker tab closed — don't leave stale rings up
            Effect.runSync(overlay.command("hideall"));
          },
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
  return yield* Effect.never;
});

BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(Overlay.layer)));
