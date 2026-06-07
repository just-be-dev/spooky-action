// WebSocket implementation of the ControlChannel: an Effect HTTP app that
// upgrades /ws, JSON-parses each frame (the transport encoding), and pushes
// channel events onto a queue the bridge consumes as a stream.
import { Effect, Layer, Queue, Ref, Stream } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type * as Socket from "effect/unstable/socket/Socket";
import { ChannelEvent, type ClientId, ControlChannel } from "../channel";

type SocketWriter = (
  chunk: string | Uint8Array | Socket.CloseEvent,
) => Effect.Effect<void, Socket.SocketError>;

export const webSocketChannelLayer = Layer.effect(
  ControlChannel,
  Effect.gen(function* () {
    const queue = yield* Queue.make<ChannelEvent>();
    const writers = yield* Ref.make<ReadonlyMap<ClientId, SocketWriter>>(new Map());
    const offer = (event: ChannelEvent) => Queue.offerUnsafe(queue, event);

    const addWriter = (clientId: ClientId, writer: SocketWriter) =>
      Ref.update(writers, (current) => {
        const next = new Map(current);
        next.set(clientId, writer);
        return next;
      });
    const removeWriter = (clientId: ClientId) =>
      Ref.update(writers, (current) => {
        const next = new Map(current);
        next.delete(clientId);
        return next;
      });

    const handleFrame = (clientId: ClientId, raw: string) =>
      Effect.sync(() => {
        try {
          offer(
            ChannelEvent.MessageReceived({
              clientId,
              payload: JSON.parse(raw),
            }),
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
            const clientId = crypto.randomUUID();
            const writer = yield* socket.writer;
            yield* socket
              .runString((raw) => handleFrame(clientId, raw), {
                onOpen: addWriter(clientId, writer).pipe(
                  Effect.andThen(
                    Effect.sync(() => offer(ChannelEvent.ClientConnected({ clientId }))),
                  ),
                ),
              })
              .pipe(
                Effect.catch(() => Effect.void),
                Effect.ensuring(
                  removeWriter(clientId).pipe(
                    Effect.andThen(
                      Effect.sync(() => offer(ChannelEvent.ClientDisconnected({ clientId }))),
                    ),
                  ),
                ),
              );
            return HttpServerResponse.empty();
          }),
        ),
        Effect.orElseSucceed(() => HttpServerResponse.text("Not found", { status: 404 })),
      );
      return response;
    });

    const server = yield* HttpServer.HttpServer;
    yield* server.serve(app);

    yield* Effect.log(
      `Control channel listening on ${HttpServer.formatAddress(server.address)}/ws`,
    );
    return {
      events: Stream.fromQueue(queue),
      send: Effect.fn("ControlChannel.send")((clientId: ClientId, payload: unknown) =>
        Effect.gen(function* () {
          const frame = JSON.stringify(payload);
          const current = yield* Ref.get(writers);
          const writer = current.get(clientId);
          if (writer !== undefined) {
            yield* writer(frame).pipe(Effect.catch(() => removeWriter(clientId)));
          }
        }),
      ),
    };
  }),
);
