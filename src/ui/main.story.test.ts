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
  MovedGraphPointer,
  type Model,
  PressedGraphHandle,
  PressedGraphNode,
  ProcessFrame,
  ProcessedFrame,
  ReleasedGraphPointer,
  ReleasedEngine,
  RemovedGraphNode,
  RingEcho,
  SkippedFrame,
  SucceededLoadDefs,
  TickedFrame,
  Tracking,
  init,
  update,
} from "./main";
import type { GestureDef } from "../gesture/engine";
import { initialTrackState } from "./tracking";

const pinchDef: GestureDef = {
  name: "pinch",
  source: "hand",
  initial: "off",
  states: { off: {} },
};

const [initialModel] = init();

const trackingModel: Model = {
  ...initialModel,
  defs: LoadedDefs({ defs: [pinchDef] }),
  tracker: Tracking(),
};

describe("update", () => {
  describe("node graph", () => {
    test("graph nodes can be dragged", () => {
      Story.story(
        update,
        Story.with(initialModel),
        Story.message(PressedGraphNode({ nodeId: "gesture:pinch", x: 100, y: 100 })),
        Story.message(MovedGraphPointer({ x: 200, y: 240, isInside: true })),
        Story.message(ReleasedGraphPointer({ x: 200, y: 240, isInside: true })),
        Story.model((model) => {
          const node = model.graphNodes.find((candidate) => candidate.id === "gesture:pinch");
          expect(node?.x).toBe(172);
          expect(node?.y).toBe(232);
          expect(model.graphDrag._tag).toBe("NotDraggingGraph");
        }),
      );
    });

    test("graph handles create rule-backed edges", () => {
      Story.story(
        update,
        Story.with(initialModel),
        Story.message(PressedGraphHandle({ nodeId: "gesture:pinch", x: 292, y: 131 })),
        Story.message(ReleasedGraphPointer({ x: 660, y: 230, isInside: true })),
        Story.model((model) => {
          expect(model.rules).toHaveLength(initialModel.rules.length + 1);
          expect(model.graphEdges).toHaveLength(initialModel.graphEdges.length + 1);
          expect(Option.isSome(model.maybeSelectedGraphEdgeId)).toBe(true);
        }),
      );
    });

    test("removing a graph node removes connected edges and rules", () => {
      Story.story(
        update,
        Story.with(initialModel),
        Story.message(RemovedGraphNode({ nodeId: "gesture:pinch" })),
        Story.model((model) => {
          expect(model.graphNodes.some((node) => node.id === "gesture:pinch")).toBe(false);
          expect(model.graphEdges.some((edge) => edge.sourceNodeId === "gesture:pinch")).toBe(
            false,
          );
          expect(model.rules.some((rule) => rule.gesture === "pinch")).toBe(false);
        }),
      );
    });
  });

  describe("defs lifecycle", () => {
    test("SucceededLoadDefs stores the loaded defs", () => {
      Story.story(
        update,
        Story.with(initialModel),
        Story.message(SucceededLoadDefs({ defs: [pinchDef] })),
        Story.model((model) => {
          if (model.defs._tag === "LoadedDefs") {
            expect(model.defs.defs).toHaveLength(1);
            expect(model.defs.defs[0]?.name).toBe("pinch");
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
        Story.Command.resolve(LoadDefs, SucceededLoadDefs({ defs: [pinchDef] })),
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
                  key: "pinch#1",
                  gesture: "pinch",
                  state: "active",
                  previousState: "potential",
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
          expect(model.frame.statuses[0]?.state).toBe("active");
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
