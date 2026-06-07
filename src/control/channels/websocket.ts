// WebSocket implementation of the ControlChannel: an Effect HTTP app that
// upgrades /ws, JSON-parses each frame (the transport encoding), and pushes
// channel events onto a queue the bridge consumes as a stream.
import { Effect, Layer, Queue, Ref, Stream } from "effect";
import {
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type * as Socket from "effect/unstable/socket/Socket";
import { ChannelEvent, ControlChannel } from "../channel";

type SocketWriter = (
  chunk: string | Uint8Array | Socket.CloseEvent
) => Effect.Effect<void, Socket.SocketError>;

export const webSocketChannelLayer = Layer.effect(
  ControlChannel,
  Effect.gen(function* () {
    const queue = yield* Queue.make<ChannelEvent>();
    const writers = yield* Ref.make<ReadonlySet<SocketWriter>>(new Set());
    const offer = (event: ChannelEvent) => Queue.offerUnsafe(queue, event);

    const addWriter = (writer: SocketWriter) =>
      Ref.update(writers, (current) => new Set(current).add(writer));
    const removeWriter = (writer: SocketWriter) =>
      Ref.update(writers, (current) => {
        const next = new Set(current);
        next.delete(writer);
        return next;
      });

    const handleFrame = (raw: string) =>
      Effect.sync(() => {
        try {
          offer(
            ChannelEvent.MessageReceived({
              payload: JSON.parse(raw),
            })
          );
        } catch {
          // not even JSON — drop the frame
        }
      });

    const app = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (new URL(request.url, "http://localhost").pathname !== "/ws") {
        return HttpServerResponse.text("Not found", { status: 404 });
      }

      const response = yield* request.upgrade.pipe(
        Effect.flatMap((socket) =>
          Effect.gen(function* () {
            const writer = yield* socket.writer;
            yield* socket
              .runString(handleFrame, {
                onOpen: addWriter(writer).pipe(
                  Effect.andThen(
                    Effect.sync(() => offer(ChannelEvent.ClientConnected()))
                  )
                ),
              })
              .pipe(
                Effect.catch(() => Effect.void),
                Effect.ensuring(
                  removeWriter(writer).pipe(
                    Effect.andThen(
                      Effect.sync(() =>
                        offer(ChannelEvent.ClientDisconnected())
                      )
                    )
                  )
                )
              );
            return HttpServerResponse.empty();
          })
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Not found", { status: 404 })
        )
      );
      return response;
    });

    const server = yield* HttpServer.HttpServer;
    yield* server.serve(app);

    yield* Effect.log(
      `Control channel listening on ${HttpServer.formatAddress(server.address)}/ws`
    );
    return {
      events: Stream.fromQueue(queue),
      send: Effect.fn("ControlChannel.send")((payload: unknown) =>
        Effect.gen(function* () {
          const frame = JSON.stringify(payload);
          const current = yield* Ref.get(writers);
          yield* Effect.forEach(
            current,
            (writer) => writer(frame).pipe(Effect.catch(() => removeWriter(writer))),
            { discard: true }
          );
        })
      ),
    };
  })
);
