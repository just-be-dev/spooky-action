// The bridge pumps communication channels into registered control surfaces:
// client connects -> activate surfaces + advertise them, payload arrives ->
// dispatch to the requested surface/capability, last client disconnects -> reset.
// It only knows the contracts, so different protocols can be merged by channel
// implementations and still drive the same surface registry.
import { Effect, Match, Ref, Schema, Stream } from "effect";
import type { Capability } from "./capability";
import { ControlChannel } from "./channel";
import { ControlSurfaces } from "./surface";

export class UnsupportedCommandError extends Schema.TaggedErrorClass<UnsupportedCommandError>()(
  "UnsupportedCommandError",
  { surface: Schema.String, payload: Schema.Unknown },
) {}

// Every command payload names a surface and a surface-local capability.
const Envelope = Schema.Struct({ surface: Schema.String, type: Schema.String });
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope);

const stripSurfaceField = (payload: unknown): unknown => {
  if (payload === null || typeof payload !== "object") {
    return payload;
  }
  const { surface: _surface, ...rest } = payload as Record<string, unknown>;
  return rest;
};

export const runControlBridge = Effect.gen(function* () {
  const channel = yield* ControlChannel;
  const registry = yield* ControlSurfaces;

  const tables = new Map<string, Map<string, Capability>>();
  for (const surface of registry.surfaces) {
    if (tables.has(surface.id)) {
      return yield* Effect.die(new Error(`Duplicate control surface id: ${surface.id}`));
    }
    tables.set(surface.id, new Map(surface.capabilities.map((cap) => [cap.type, cap])));
  }

  // Advertised on connect so clients can route commands by surface id and adapt
  // to each surface's local capability vocabulary.
  const advertisement = {
    type: "surfaces",
    surfaces: registry.surfaces.map(({ id, label, capabilities }) => ({
      id,
      label,
      capabilities: capabilities.map(({ type, schema }) => ({ type, schema })),
    })),
  };

  const activeClients = yield* Ref.make<ReadonlySet<string>>(new Set());

  const activateSurfaces = Effect.forEach(registry.surfaces, (surface) => surface.activate, {
    discard: true,
  });

  const resetSurfaces = Effect.forEach(registry.surfaces, (surface) => surface.reset, {
    discard: true,
  });

  const dispatch = Effect.fn("ControlBridge.dispatch")(function* (payload: unknown) {
    const envelope = yield* decodeEnvelope(payload);
    const cap = tables.get(envelope.surface)?.get(envelope.type);
    if (cap === undefined) {
      return yield* new UnsupportedCommandError({
        surface: envelope.surface,
        payload,
      });
    }
    yield* cap.handle(stripSurfaceField(payload));
  });

  yield* Stream.runForEach(channel.events, (event) =>
    Match.value(event).pipe(
      Match.tagsExhaustive({
        ClientConnected: ({ clientId }) =>
          Ref.modify(activeClients, (current) => {
            const next = new Set(current);
            next.add(clientId);
            return [current.size === 0, next] as const;
          }).pipe(
            Effect.flatMap((wasInactive) => (wasInactive ? activateSurfaces : Effect.void)),
            Effect.andThen(channel.send(clientId, advertisement)),
          ),
        MessageReceived: ({ payload }) =>
          dispatch(payload).pipe(
            Effect.catch((err) => Effect.logWarning("Dropped control command", err)),
          ),
        ClientDisconnected: ({ clientId }) =>
          Ref.modify(activeClients, (current) => {
            const next = new Set(current);
            next.delete(clientId);
            return [next.size, next] as const;
          }).pipe(
            Effect.flatMap((activeCount) => (activeCount === 0 ? resetSurfaces : Effect.void)),
          ),
      }),
    ),
  );
});
