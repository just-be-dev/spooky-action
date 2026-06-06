import { Option } from "effect";
import { Story } from "foldkit";
import { describe, expect, test } from "vitest";

import {
  AcquiredCamera,
  AcquiredLandmarkers,
  AttachCamera,
  ClickedReloadDefs,
  CompletedAttachCamera,
  CompletedHideAll,
  FailedAcquireLandmarkers,
  FailedFrame,
  FailedLoadDefs,
  HideAllRings,
  LoadDefs,
  LoadedDefs,
  type Model,
  ProcessFrame,
  ProcessedFrame,
  ReleasedEngine,
  RingEcho,
  SkippedFrame,
  SucceededLoadDefs,
  TickedFrame,
  Tracking,
  init,
  update,
} from "./main";
import type { GestureDef } from "../gestures/engine";
import { initialTrackState } from "./tracking";

const pinchClickDef: GestureDef = {
  name: "pinch-click",
  source: "hand",
  states: {},
};

const [initialModel] = init();

const trackingModel: Model = {
  ...initialModel,
  defs: LoadedDefs({ defs: [pinchClickDef] }),
  tracker: Tracking(),
};

describe("update", () => {
  describe("defs lifecycle", () => {
    test("SucceededLoadDefs stores the loaded defs", () => {
      Story.story(
        update,
        Story.with(initialModel),
        Story.message(SucceededLoadDefs({ defs: [pinchClickDef] })),
        Story.model((model) => {
          if (model.defs._tag === "LoadedDefs") {
            expect(model.defs.defs).toHaveLength(1);
            expect(model.defs.defs[0]?.name).toBe("pinch-click");
          } else {
            throw new Error("Expected LoadedDefs");
          }
        }),
      );
    });

    test("FailedLoadDefs captures the error message", () => {
      Story.story(
        update,
        Story.with(initialModel),
        Story.message(FailedLoadDefs({ message: "HTTP 500" })),
        Story.model((model) => {
          if (model.defs._tag === "FailedDefs") {
            expect(model.defs.message).toBe("HTTP 500");
          } else {
            throw new Error("Expected FailedDefs");
          }
        }),
      );
    });

    test("ClickedReloadDefs returns to LoadingDefs and fires LoadDefs", () => {
      Story.story(
        update,
        Story.with(trackingModel),
        Story.message(ClickedReloadDefs()),
        Story.model((model) => {
          expect(model.defs._tag).toBe("LoadingDefs");
        }),
        Story.Command.expectHas(LoadDefs),
        Story.Command.resolve(
          LoadDefs,
          SucceededLoadDefs({ defs: [pinchClickDef] }),
        ),
        Story.model((model) => {
          expect(model.defs._tag).toBe("LoadedDefs");
        }),
      );
    });

    test("ReleasedEngine clears stale overlay rings", () => {
      Story.story(
        update,
        Story.with(trackingModel),
        Story.message(ReleasedEngine()),
        Story.Command.expectHas(HideAllRings),
        Story.Command.resolve(HideAllRings, CompletedHideAll()),
      );
    });
  });

  describe("tracker lifecycle", () => {
    test("AcquiredLandmarkers moves on to the camera", () => {
      Story.story(
        update,
        Story.with(initialModel),
        Story.message(AcquiredLandmarkers()),
        Story.model((model) => {
          expect(model.tracker._tag).toBe("StartingCamera");
        }),
      );
    });

    test("FailedAcquireLandmarkers fails the tracker", () => {
      Story.story(
        update,
        Story.with(initialModel),
        Story.message(FailedAcquireLandmarkers({ message: "no GPU" })),
        Story.model((model) => {
          if (model.tracker._tag === "FailedTracker") {
            expect(model.tracker.message).toBe("no GPU");
          } else {
            throw new Error("Expected FailedTracker");
          }
        }),
      );
    });

    test("AcquiredCamera attaches the stream, then tracking starts", () => {
      Story.story(
        update,
        Story.with(initialModel),
        Story.message(AcquiredCamera()),
        Story.model((model) => {
          expect(model.tracker._tag).toBe("AttachingCamera");
        }),
        Story.Command.expectHas(AttachCamera),
        Story.Command.resolve(AttachCamera, CompletedAttachCamera()),
        Story.model((model) => {
          expect(model.tracker._tag).toBe("Tracking");
        }),
      );
    });
  });

  describe("frame loop", () => {
    test("TickedFrame dispatches ProcessFrame and latches the in-flight flag", () => {
      Story.story(
        update,
        Story.with(trackingModel),
        Story.message(TickedFrame()),
        Story.model((model) => {
          expect(model.isProcessingFrame).toBe(true);
        }),
        Story.Command.expectHas(ProcessFrame),
        Story.Command.resolve(ProcessFrame, SkippedFrame()),
        Story.model((model) => {
          expect(model.isProcessingFrame).toBe(false);
        }),
      );
    });

    test("TickedFrame while a frame is in flight is ignored", () => {
      Story.story(
        update,
        Story.with({ ...trackingModel, isProcessingFrame: true }),
        Story.message(TickedFrame()),
        Story.Command.expectNone(),
      );
    });

    test("ProcessedFrame stores the frame and unlatches", () => {
      const echo = RingEcho({ x: 0.5, y: 0.5, radius: 32 });
      Story.story(
        update,
        Story.with({ ...trackingModel, isProcessingFrame: true }),
        Story.message(
          ProcessedFrame({
            videoTime: 1.25,
            frame: {
              entities: [
                {
                  kind: "hand",
                  id: 1,
                  landmarks: [{ x: 0.5, y: 0.5 }],
                  maybeLabel: Option.some("Left"),
                },
              ],
              statuses: [
                {
                  key: "pinch-click#1",
                  gesture: "pinch-click",
                  state: "armed",
                  metrics: "pinch=0.03",
                  maybeError: Option.none(),
                },
              ],
              echoes: [echo],
            },
            handTracking: { tracked: [{ id: 1, anchor: { x: 0.5, y: 0.5 } }], nextId: 2 },
            faceTracking: initialTrackState,
          }),
        ),
        Story.model((model) => {
          expect(model.isProcessingFrame).toBe(false);
          expect(model.lastVideoTime).toBe(1.25);
          expect(model.frame.entities).toHaveLength(1);
          expect(model.frame.statuses[0]?.state).toBe("armed");
          expect(model.frame.echoes).toHaveLength(1);
          expect(model.handTracking.nextId).toBe(2);
        }),
      );
    });

    test("SkippedFrame only unlatches", () => {
      Story.story(
        update,
        Story.with({ ...trackingModel, isProcessingFrame: true }),
        Story.message(SkippedFrame()),
        Story.model((model) => {
          expect(model.isProcessingFrame).toBe(false);
          expect(model.frame.entities).toHaveLength(0);
        }),
      );
    });

    test("FailedFrame surfaces the error and unlatches", () => {
      Story.story(
        update,
        Story.with({ ...trackingModel, isProcessingFrame: true }),
        Story.message(FailedFrame({ message: "detector exploded" })),
        Story.model((model) => {
          expect(model.isProcessingFrame).toBe(false);
          expect(Option.isSome(model.maybeFrameError)).toBe(true);
        }),
      );
    });
  });
});
