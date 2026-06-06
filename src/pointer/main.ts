// Pinch pointer: serves the hand-tracking page and bridges pinch events
// over WebSocket to the native macOS overlay (../control/overlay.ts →
// overlay.swift), which draws the on-screen ring and posts real clicks.
//
// Bun.serve stays in charge of HTTP/WS (it bundles index.html); its
// callbacks are the Effect boundary and run effects with Effect.runSync.
import index from "./index.html";
import { Effect, Schema } from "effect";
import { BunRuntime } from "@effect/platform-bun";
import { Overlay } from "../control/overlay";

// Wire messages from the tracker tab. Anything that doesn't decode is
// logged and dropped.
const WireMessage = Schema.Union([
  Schema.Struct({
    t: Schema.Literal("circle"),
    x: Schema.Number,
    y: Schema.Number,
    r: Schema.Number,
  }),
  Schema.Struct({ t: Schema.Literal("hide") }),
  Schema.Struct({
    t: Schema.Literal("click"),
    x: Schema.Number,
    y: Schema.Number,
  }),
]);
const decodeWire = Schema.decodeUnknownEffect(Schema.fromJsonString(WireMessage));

const program = Effect.gen(function* () {
  const overlay = yield* Overlay;

  // Map one decoded wire message onto an overlay stdin command. The shared
  // overlay supports multiple named rings; the pointer only ever drives one,
  // so it always uses the id "ptr".
  const handleWire = Effect.fn("handleWire")(function* (raw: string | Buffer) {
    const msg = yield* decodeWire(String(raw));
    switch (msg.t) {
      case "circle":
        return yield* overlay.command(`circle ptr ${msg.x} ${msg.y} ${msg.r}`);
      case "hide":
        return yield* overlay.command("hide ptr");
      case "click":
        return yield* overlay.command(`click ${msg.x} ${msg.y}`);
    }
  });

  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
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
            // tracker tab closed — don't leave a stale ring up
            Effect.runSync(overlay.command("hideall"));
          },
        },
      })
    ),
    (server) => Effect.promise(() => server.stop())
  );

  yield* Effect.log(`Pinch pointer running — open ${server.url} to start tracking`);
  yield* Effect.log(
    "Note: clicking requires Accessibility permission for your terminal app"
  );
  return yield* Effect.never;
});

BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(Overlay.layer)));
