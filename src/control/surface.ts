// A control surface is the thing commands act on. Today that's the native
// macOS overlay (on-screen rings + real clicks); other implementations
// could drive a webpage via a Chrome extension, a remote machine, etc.
//
// The contract is intentionally small: lifecycle plus a self-declared
// command vocabulary (see ./capability.ts). Different surfaces provide
// different capabilities — the bridge dispatches against whatever the
// provided surface declares and drops the rest.
import { Effect } from "effect";
import * as Context from "effect/Context";
import type { Capability } from "./capability";

export class ControlSurface extends Context.Service<
  ControlSurface,
  {
    /** Bring the surface up eagerly (spawn the process, connect, …). */
    readonly activate: Effect.Effect<void>;
    /** Clear any client-visible state — used when a client disconnects. */
    readonly reset: Effect.Effect<void>;
    /** The commands this surface knows how to execute. */
    readonly capabilities: ReadonlyArray<Capability>;
  }
>()("@collabspace/control/ControlSurface") {}
