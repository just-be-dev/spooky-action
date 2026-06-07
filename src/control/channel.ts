// The communication layer: where control commands come from. Today that's
// a WebSocket from the browser tracker (see ./websocket.ts); other
// implementations could read from a Chrome extension port, a remote peer,
// or an in-memory queue in tests.
//
// A channel handles transport encoding only (frames ↔ parsed payloads) and
// surfaces its traffic as one event stream. Validating a payload against a
// command vocabulary is the surface's job — the bridge connects the two.
import { Data, Effect, Stream } from "effect";
import * as Context from "effect/Context";

export type ChannelEvent = Data.TaggedEnum<{
  /** A client attached — a good moment to activate the surface. */
  ClientConnected: {};
  /** A parsed (but not yet validated) command payload arrived. */
  MessageReceived: { readonly payload: unknown };
  /** The client went away — leftover surface state should be cleared. */
  ClientDisconnected: {};
}>;
export const ChannelEvent = Data.taggedEnum<ChannelEvent>();

export class ControlChannel extends Context.Service<
  ControlChannel,
  {
    readonly events: Stream.Stream<ChannelEvent>;
    /**
     * Send a payload to every connected client (the bridge uses this to
     * advertise the surface's capabilities). A no-op when nobody listens.
     */
    readonly send: (payload: unknown) => Effect.Effect<void>;
  }
>()("@collabspace/control/ControlChannel") {}
