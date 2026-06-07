// The bridge pumps the communication layer into the control surface:
// client connects → activate the surface, payload arrives → dispatch to
// the matching capability, client disconnects → reset. It only knows the
// two contracts, so any channel can drive any surface — payloads naming a
// capability the surface doesn't declare are logged and dropped.
import { Effect, Match, Schema, Stream } from "effect";
import type { Capability } from "./capability";
import { ControlChannel } from "./channel";
import { ControlSurface } from "./surface";

export class UnsupportedCommandError extends Schema.TaggedErrorClass<UnsupportedCommandError>()(
  "UnsupportedCommandError",
  { payload: Schema.Unknown }
) {}

// Every command payload carries a `type` discriminator naming a capability
const Envelope = Schema.Struct({ type: Schema.String });
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope);

export const runControlBridge = Effect.gen(function* () {
  const channel = yield* ControlChannel;
  const surface = yield* ControlSurface;

  const table = new Map<string, Capability>(
    surface.capabilities.map((cap) => [cap.type, cap])
  );

  // Advertised on every connect so clients can adapt to what this surface
  // supports — each entry is the wire discriminator plus its payload's
  // JSON Schema. Capabilities are static, so build the payload once.
  const advertisement = {
    type: "capabilities",
    capabilities: surface.capabilities.map(({ type, schema }) => ({
      type,
      schema,
    })),
  };

  const dispatch = Effect.fn("ControlBridge.dispatch")(function* (
    payload: unknown
  ) {
    const envelope = yield* decodeEnvelope(payload);
    const cap = table.get(envelope.type);
    if (cap === undefined) {
      return yield* new UnsupportedCommandError({ payload });
    }
    yield* cap.handle(payload);
  });

  yield* Stream.runForEach(channel.events, (event) =>
    Match.value(event).pipe(
      Match.tagsExhaustive({
        ClientConnected: () =>
          surface.activate.pipe(
            Effect.flatMap(() => channel.send(advertisement))
          ),
        MessageReceived: ({ payload }) =>
          dispatch(payload).pipe(
            Effect.catch((err) =>
              Effect.logWarning("Dropped control command", err)
            )
          ),
        // client went away — don't leave stale surface state up
        ClientDisconnected: () => surface.reset,
      })
    )
  );
});
