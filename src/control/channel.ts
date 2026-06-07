// The communication layer: where control commands come from. Today that's a
// WebSocket from the browser tracker (see ./websocket.ts); other implementations
// could read from a Chrome extension port, a BroadcastChannel bridge, a remote
// peer, or an in-memory queue in tests.
//
// A channel handles transport encoding only (frames ↔ parsed payloads) and
// surfaces its traffic as one event stream. Validating a payload against a
// command vocabulary is the surface's job — the bridge connects the two.
import { Data, Effect, Stream } from "effect";
import * as Context from "effect/Context";

export type ClientId = string;

export type ChannelEvent = Data.TaggedEnum<{
  /** A client attached — a good moment to activate registered surfaces. */
  ClientConnected: { readonly clientId: ClientId };
  /** A parsed (but not yet validated) command payload arrived. */
  MessageReceived: { readonly clientId: ClientId; readonly payload: unknown };
  /** The client went away. Shared surface state is reset when no clients remain. */
  ClientDisconnected: { readonly clientId: ClientId };
}>;
export const ChannelEvent = Data.taggedEnum<ChannelEvent>();

export class ControlChannel extends Context.Service<
  ControlChannel,
  {
    readonly events: Stream.Stream<ChannelEvent>;
    /**
     * Send a payload to one connected client (the bridge uses this to advertise
     * surfaces on connect). A no-op if the client is already gone.
     */
    readonly send: (clientId: ClientId, payload: unknown) => Effect.Effect<void>;
  }
>()("@collabspace/control/ControlChannel") {}
