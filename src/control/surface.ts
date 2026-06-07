// A control surface is one thing commands act on: the native macOS overlay,
// a Chrome extension, a remote machine, etc. Surfaces are addressed by id so
// capability names only need to be unique within one surface.
import { Effect } from "effect";
import * as Context from "effect/Context";
import type { Capability } from "./capability";

export interface ControlSurface {
  /** Wire id used in command envelopes, e.g. `{ surface: "mac", type: ... }`. */
  readonly id: string;
  /** Human-readable name advertised to clients. */
  readonly label: string;
  /** Bring the surface up eagerly (spawn the process, connect, ...). */
  readonly activate: Effect.Effect<void>;
  /** Clear any client-visible state when the last client disconnects. */
  readonly reset: Effect.Effect<void>;
  /** The commands this surface knows how to execute. */
  readonly capabilities: ReadonlyArray<Capability>;
}

export class ControlSurfaces extends Context.Service<
  ControlSurfaces,
  {
    readonly surfaces: ReadonlyArray<ControlSurface>;
  }
>()("@collabspace/control/ControlSurfaces") {}
