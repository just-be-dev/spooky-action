// Gesture Lab UI: camera + MediaPipe tracking feeding the data-driven
// gesture engine (src/gesture/), rebuilt as a Foldkit program.
// Detection runs in the ProcessFrame Command; the camera, MediaPipe models,
// gesture engine, and overlay WebSocket are Managed Resources whose
// lifecycles follow the Model. Gesture rules turn state snapshots into
// overlay commands sent over /ws to the backend (src/main.ts).
import { FaceLandmarker, FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { Array, Effect, Match as M, Option, Schema as S, Stream, pipe } from "effect";
import { Canvas, Command, ManagedResource, Runtime, Subscription, Ui } from "foldkit";
import { type Document, type Html, html } from "foldkit/html";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";

import { GestureDef, GestureEngine, type Entity, type InstanceStatus } from "../gesture/engine";
import { parseExpr } from "../gesture/expr";
import { FACE_LANDMARKS, HAND_LANDMARKS } from "../landmarks";
import {
  LandmarkPoint,
  TrackState,
  initialTrackState,
  landmarkAt,
  matchTracked,
  mirror,
} from "./tracking";

import {
  ClosedContextMenu,
  ConnectingGraphEdge,
  type ContextMenuState,
  DisconnectedGraphEdge,
  DraggingGraphNode,
  DraggingPaletteNode,
  EdgeContextMenu,
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  GRAPH_SURFACE_HEIGHT,
  GRAPH_SURFACE_WIDTH,
  GraphDragState,
  GraphEdge,
  GraphNode,
  type GraphNodeKind,
  MovedGraphPointer,
  NodeContextMenu,
  NotDraggingGraph,
  OpenedEdgeContextMenu,
  OpenedNodeContextMenu,
  PressedGraphEdge,
  PressedGraphHandle,
  PressedGraphNode,
  PressedPaletteNode,
  ReleasedGraphPointer,
  RemovedGraphNode,
  TrackGraphSurface,
  edgePath,
  graphCapabilityNodeId,
  graphGestureNodeId,
  graphNodeAtPoint,
  graphNodeById,
  nextGraphNodeId,
  sourcePort,
  targetPort,
} from "./graph";

export {
  ClosedContextMenu,
  ConnectingGraphEdge,
  DisconnectedGraphEdge,
  DraggingGraphNode,
  DraggingPaletteNode,
  MovedGraphPointer,
  NotDraggingGraph,
  OpenedEdgeContextMenu,
  OpenedNodeContextMenu,
  PressedGraphEdge,
  PressedGraphHandle,
  PressedGraphNode,
  PressedPaletteNode,
  ReleasedGraphPointer,
  RemovedGraphNode,
} from "./graph";

const STAGE_WIDTH = 640;
const STAGE_HEIGHT = 480;
const MAX_HANDS = 4;
const MAX_FACES = 2;
const VIDEO_ELEMENT_ID = "camera";

const MEDIAPIPE_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class VideoElementNotFound extends S.TaggedErrorClass<VideoElementNotFound>()(
  "VideoElementNotFound",
  { message: S.String },
) {}

export class DefsRequestError extends S.TaggedErrorClass<DefsRequestError>()("DefsRequestError", {
  message: S.String,
}) {}

export class LandmarkerLoadError extends S.TaggedErrorClass<LandmarkerLoadError>()(
  "LandmarkerLoadError",
  { message: S.String },
) {}

export class CameraAccessError extends S.TaggedErrorClass<CameraAccessError>()(
  "CameraAccessError",
  { message: S.String },
) {}

export class SocketConnectError extends S.TaggedErrorClass<SocketConnectError>()(
  "SocketConnectError",
  { message: S.String },
) {}

// MODEL

export const LoadingDefs = ts("LoadingDefs");
export const FailedDefs = ts("FailedDefs", { message: S.String });
export const LoadedDefs = ts("LoadedDefs", { defs: S.Array(GestureDef) });

const DefsState = S.Union([LoadingDefs, FailedDefs, LoadedDefs]);
type DefsState = typeof DefsState.Type;

export const LoadingModels = ts("LoadingModels");
export const StartingCamera = ts("StartingCamera");
export const AttachingCamera = ts("AttachingCamera");
export const Tracking = ts("Tracking");
export const FailedTracker = ts("FailedTracker", { message: S.String });

const TrackerState = S.Union([
  LoadingModels,
  StartingCamera,
  AttachingCamera,
  Tracking,
  FailedTracker,
]);
type TrackerState = typeof TrackerState.Type;

export const SocketDisconnected = ts("SocketDisconnected");
export const SocketConnected = ts("SocketConnected");
export const SocketFailed = ts("SocketFailed", { message: S.String });

const SocketState = S.Union([SocketDisconnected, SocketConnected, SocketFailed]);
type SocketState = typeof SocketState.Type;

const SurfaceCapability = S.Struct({ type: S.String, schema: S.Unknown });
type SurfaceCapability = typeof SurfaceCapability.Type;

const ControlSurface = S.Struct({
  id: S.String,
  label: S.String,
  capabilities: S.Array(SurfaceCapability),
});
type ControlSurface = typeof ControlSurface.Type;

const SurfacesAdvertisement = S.Struct({
  type: S.Literal("surfaces"),
  surfaces: S.Array(ControlSurface),
});

const RuleFieldValue = S.Union([S.String, S.Number, S.Boolean]);
const GestureRule = S.Struct({
  id: S.String,
  gesture: S.String,
  when: S.String,
  surface: S.String,
  capability: S.String,
  fields: S.Record(S.String, RuleFieldValue),
});
type GestureRule = typeof GestureRule.Type;

const defaultGestureRules: ReadonlyArray<GestureRule> = [
  {
    id: "pinch.potential.circle",
    gesture: "pinch",
    when: "state == 'potential' || state == 'active'",
    surface: "mac",
    capability: "circle",
    fields: { id: "key", x: "pos.x", y: "pos.y", r: "lerp(pinch, 0.35, 0.9, 8, 64)" },
  },
  {
    id: "pinch.active.mouse-down",
    gesture: "pinch",
    when: "state == 'active' && previousState != 'active' && hands.count == 1",
    surface: "mac",
    capability: "mouse-down",
    fields: { x: "pos.x", y: "pos.y" },
  },
  {
    id: "pinch.active.mouse-drag",
    gesture: "pinch",
    when: "state == 'active' && hands.count == 1",
    surface: "mac",
    capability: "mouse-drag",
    fields: { x: "pos.x", y: "pos.y" },
  },
  {
    id: "pinch.released.mouse-up",
    gesture: "pinch",
    when: "previousState == 'active' && state != 'active'",
    surface: "mac",
    capability: "mouse-up",
    fields: { x: "pos.x", y: "pos.y" },
  },
  {
    id: "pinch.off.hide",
    gesture: "pinch",
    when: "state == 'off' && previousState != 'off'",
    surface: "mac",
    capability: "hide",
    fields: { id: "key" },
  },
  {
    id: "mouth-ring.showing.circle",
    gesture: "mouth-ring",
    when: "state == 'showing'",
    surface: "mac",
    capability: "circle",
    fields: { id: "key", x: "pos.x", y: "pos.y", r: "lerp(open, 0.05, 0.2, 12, 60)" },
  },
  {
    id: "mouth-ring.idle.hide",
    gesture: "mouth-ring",
    when: "state == 'idle' && previousState != 'idle'",
    surface: "mac",
    capability: "hide",
    fields: { id: "key" },
  },
];

const initialGraphNodes = (rules: ReadonlyArray<GestureRule>): ReadonlyArray<GraphNode> => {
  const gestures = globalThis.Array.from(new Set(rules.map((rule) => rule.gesture)));
  const capabilities = globalThis.Array.from(
    new Set(rules.map((rule) => `${rule.surface}:${rule.capability}`)),
  );
  return [
    ...gestures.map((gesture, index) => ({
      id: graphGestureNodeId(gesture),
      kind: "Gesture" as const,
      label: gesture,
      x: 72,
      y: 92 + index * 132,
      maybeSurface: Option.none(),
      maybeCapability: Option.none(),
    })),
    ...capabilities.map((capability, index) => {
      const [surface, type] = capability.split(":");
      return {
        id: graphCapabilityNodeId(surface ?? "surface", type ?? "capability"),
        kind: "SurfaceCapability" as const,
        label: `${surface ?? "surface"} / ${type ?? "capability"}`,
        x: 650,
        y: 92 + index * 132,
        maybeSurface: Option.some(surface ?? "surface"),
        maybeCapability: Option.some(type ?? "capability"),
      };
    }),
  ];
};

const initialGraphEdges = (rules: ReadonlyArray<GestureRule>): ReadonlyArray<GraphEdge> =>
  rules.map((rule) => ({
    id: `edge:${rule.id}`,
    sourceNodeId: graphGestureNodeId(rule.gesture),
    targetNodeId: graphCapabilityNodeId(rule.surface, rule.capability),
    ruleId: rule.id,
  }));

const FrameEntity = S.Struct({
  kind: S.Literals(["hand", "face"]),
  id: S.Number,
  landmarks: S.Array(LandmarkPoint),
  maybeLabel: S.Option(S.String),
});
type FrameEntity = typeof FrameEntity.Type;

const GestureStatus = S.Struct({
  key: S.String,
  gesture: S.String,
  state: S.String,
  previousState: S.String,
  metrics: S.String,
  maybeError: S.Option(S.String),
});
type GestureStatus = typeof GestureStatus.Type;

export const RingEcho = ts("RingEcho", {
  x: S.Number,
  y: S.Number,
  radius: S.Number,
});
export const ClickEcho = ts("ClickEcho", { x: S.Number, y: S.Number });

const Echo = S.Union([RingEcho, ClickEcho]);
type Echo = typeof Echo.Type;

const Frame = S.Struct({
  entities: S.Array(FrameEntity),
  statuses: S.Array(GestureStatus),
  echoes: S.Array(Echo),
});
type Frame = typeof Frame.Type;

const emptyFrame: Frame = { entities: [], statuses: [], echoes: [] };

export const Model = S.Struct({
  defs: DefsState,
  tracker: TrackerState,
  socket: SocketState,
  controlSurfaces: S.Array(ControlSurface),
  rules: S.Array(GestureRule),
  maybeSelectedRuleId: S.Option(S.String),
  graphNodes: S.Array(GraphNode),
  graphEdges: S.Array(GraphEdge),
  maybeSelectedGraphEdgeId: S.Option(S.String),
  graphDrag: GraphDragState,
  maybeContextMenu: S.Option(S.Union([NodeContextMenu, EdgeContextMenu])),
  frame: Frame,
  handTracking: TrackState,
  faceTracking: TrackState,
  lastVideoTime: S.Number,
  isProcessingFrame: S.Boolean,
  maybeFrameError: S.Option(S.String),
});
export type Model = typeof Model.Type;

// MESSAGE

export const AcquiredLandmarkers = m("AcquiredLandmarkers");
export const FailedAcquireLandmarkers = m("FailedAcquireLandmarkers", {
  message: S.String,
});
export const ReleasedLandmarkers = m("ReleasedLandmarkers");
export const AcquiredCamera = m("AcquiredCamera");
export const FailedAcquireCamera = m("FailedAcquireCamera", {
  message: S.String,
});
export const ReleasedCamera = m("ReleasedCamera");
export const CompletedAttachCamera = m("CompletedAttachCamera");
export const FailedAttachCamera = m("FailedAttachCamera", {
  message: S.String,
});
export const AcquiredEngine = m("AcquiredEngine");
export const FailedAcquireEngine = m("FailedAcquireEngine", {
  message: S.String,
});
export const ReleasedEngine = m("ReleasedEngine");
export const ConnectedSocket = m("ConnectedSocket", {
  surfaces: S.Array(ControlSurface),
});
export const FailedConnectSocket = m("FailedConnectSocket", {
  message: S.String,
});
export const DisconnectedSocket = m("DisconnectedSocket");
export const SucceededLoadDefs = m("SucceededLoadDefs", {
  defs: S.Array(GestureDef),
});
export const FailedLoadDefs = m("FailedLoadDefs", { message: S.String });
export const ClickedReloadDefs = m("ClickedReloadDefs");
export const PressedReloadKey = m("PressedReloadKey");
export const TickedFrame = m("TickedFrame");
export const ProcessedFrame = m("ProcessedFrame", {
  videoTime: S.Number,
  frame: Frame,
  handTracking: TrackState,
  faceTracking: TrackState,
});
export const SkippedFrame = m("SkippedFrame");
export const FailedFrame = m("FailedFrame", { message: S.String });
export const CompletedHideAll = m("CompletedHideAll");
export const SelectedRuleCapability = m("SelectedRuleCapability", {
  ruleId: S.String,
  capability: S.String,
});
export const SelectedRuleSurface = m("SelectedRuleSurface", {
  ruleId: S.String,
  surface: S.String,
});
export const Message = S.Union([
  AcquiredLandmarkers,
  FailedAcquireLandmarkers,
  ReleasedLandmarkers,
  AcquiredCamera,
  FailedAcquireCamera,
  ReleasedCamera,
  CompletedAttachCamera,
  FailedAttachCamera,
  AcquiredEngine,
  FailedAcquireEngine,
  ReleasedEngine,
  ConnectedSocket,
  FailedConnectSocket,
  DisconnectedSocket,
  SucceededLoadDefs,
  FailedLoadDefs,
  ClickedReloadDefs,
  PressedReloadKey,
  TickedFrame,
  ProcessedFrame,
  SkippedFrame,
  FailedFrame,
  CompletedHideAll,
  SelectedRuleCapability,
  SelectedRuleSurface,
  PressedPaletteNode,
  PressedGraphNode,
  RemovedGraphNode,
  PressedGraphHandle,
  PressedGraphEdge,
  MovedGraphPointer,
  ReleasedGraphPointer,
  DisconnectedGraphEdge,
  OpenedNodeContextMenu,
  OpenedEdgeContextMenu,
  ClosedContextMenu,
]);
export type Message = typeof Message.Type;

// RESOURCE

type Landmarkers = Readonly<{
  handLandmarker: HandLandmarker;
  faceLandmarker: FaceLandmarker;
}>;

const LandmarkersResource = ManagedResource.tag<Landmarkers>()("Landmarkers");
const CameraResource = ManagedResource.tag<MediaStream>()("Camera");
const EngineResource = ManagedResource.tag<GestureEngine>()("Engine");
type SocketConnection = Readonly<{
  socket: WebSocket;
  surfaces: ReadonlyArray<ControlSurface>;
}>;

const SocketResource = ManagedResource.tag<SocketConnection>()("Socket");

type Services =
  | ManagedResource.ServiceOf<typeof LandmarkersResource>
  | ManagedResource.ServiceOf<typeof CameraResource>
  | ManagedResource.ServiceOf<typeof EngineResource>
  | ManagedResource.ServiceOf<typeof SocketResource>;

// INIT

export const init: Runtime.ProgramInit<Model, Message, void, never, Services> = () => [
  {
    defs: LoadingDefs(),
    tracker: LoadingModels(),
    socket: SocketDisconnected(),
    controlSurfaces: [],
    rules: defaultGestureRules,
    maybeSelectedRuleId: pipe(
      defaultGestureRules,
      Array.head,
      Option.map((rule) => rule.id),
    ),
    graphNodes: initialGraphNodes(defaultGestureRules),
    graphEdges: initialGraphEdges(defaultGestureRules),
    maybeSelectedGraphEdgeId: pipe(
      defaultGestureRules,
      Array.head,
      Option.map((rule) => `edge:${rule.id}`),
    ),
    graphDrag: NotDraggingGraph(),
    maybeContextMenu: Option.none(),
    frame: emptyFrame,
    handTracking: initialTrackState,
    faceTracking: initialTrackState,
    lastVideoTime: -1,
    isProcessingFrame: false,
    maybeFrameError: Option.none(),
  },
  [LoadDefs()],
];

// UPDATE

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message, never, Services>>];
const withUpdateReturn = M.withReturnType<UpdateReturn>();

const capabilitiesForSurface = (
  surfaces: ReadonlyArray<ControlSurface>,
  surfaceId: string,
): ReadonlyArray<SurfaceCapability> =>
  surfaces.find((surface) => surface.id === surfaceId)?.capabilities ?? [];

const firstCapabilityForSurface = (
  surfaces: ReadonlyArray<ControlSurface>,
  surfaceId: string,
): Option.Option<string> => {
  const capability = capabilitiesForSurface(surfaces, surfaceId)[0];
  return capability === undefined ? Option.none() : Option.some(capability.type);
};

const nextRuleId = (
  rules: ReadonlyArray<GestureRule>,
  gesture: string,
  surface: string,
  capability: string,
): string => {
  const baseId = `${gesture}.${surface}.${capability}`;
  if (!rules.some((rule) => rule.id === baseId)) {
    return baseId;
  }
  let index = 2;
  while (rules.some((rule) => rule.id === `${baseId}.${index}`)) {
    index += 1;
  }
  return `${baseId}.${index}`;
};

const graphNodeFromPaletteDrag = (
  model: Model,
  drag: typeof DraggingPaletteNode.Type,
): GraphNode => {
  const baseId = M.value(drag.kind).pipe(
    M.when("Gesture", () => graphGestureNodeId(drag.label)),
    M.when("SurfaceCapability", () =>
      pipe(
        Option.all({ surface: drag.maybeSurface, capability: drag.maybeCapability }),
        Option.match({
          onNone: () => `capability:${drag.label}`,
          onSome: ({ surface, capability }) => graphCapabilityNodeId(surface, capability),
        }),
      ),
    ),
    M.exhaustive,
  );
  return {
    id: nextGraphNodeId(model.graphNodes, baseId),
    kind: drag.kind,
    label: drag.label,
    x: Math.max(0, Math.min(GRAPH_SURFACE_WIDTH - GRAPH_NODE_WIDTH, drag.x - GRAPH_NODE_WIDTH / 2)),
    y: Math.max(
      0,
      Math.min(GRAPH_SURFACE_HEIGHT - GRAPH_NODE_HEIGHT, drag.y - GRAPH_NODE_HEIGHT / 2),
    ),
    maybeSurface: drag.maybeSurface,
    maybeCapability: drag.maybeCapability,
  };
};

const connectGraphNodes = (model: Model, sourceNodeId: string, targetNode: GraphNode): Model => {
  const maybeSource = graphNodeById(model.graphNodes, sourceNodeId);
  if (Option.isNone(maybeSource)) {
    return evo(model, { graphDrag: () => NotDraggingGraph() });
  }
  const source = maybeSource.value;
  const maybeTarget = Option.all({
    surface: targetNode.maybeSurface,
    capability: targetNode.maybeCapability,
  });
  if (
    source.kind !== "Gesture" ||
    targetNode.kind !== "SurfaceCapability" ||
    Option.isNone(maybeTarget)
  ) {
    return evo(model, { graphDrag: () => NotDraggingGraph() });
  }
  const { surface, capability } = maybeTarget.value;
  const ruleId = nextRuleId(model.rules, source.label, surface, capability);
  const edgeId = `edge:${ruleId}`;
  const rule: GestureRule = {
    id: ruleId,
    gesture: source.label,
    when: "state == 'active' && previousState != 'active'",
    surface,
    capability,
    fields: {},
  };
  return evo(model, {
    rules: () => [...model.rules, rule],
    graphEdges: () => [
      ...model.graphEdges,
      { id: edgeId, sourceNodeId: source.id, targetNodeId: targetNode.id, ruleId },
    ],
    maybeSelectedRuleId: () => Option.some(ruleId),
    maybeSelectedGraphEdgeId: () => Option.some(edgeId),
    graphDrag: () => NotDraggingGraph(),
  });
};

const removeGraphEdge = (model: Model, edgeId: string): Model => {
  const maybeEdge = Option.fromNullishOr(model.graphEdges.find((edge) => edge.id === edgeId));
  if (Option.isNone(maybeEdge)) {
    return model;
  }
  const edge = maybeEdge.value;
  return evo(model, {
    rules: () => model.rules.filter((rule) => rule.id !== edge.ruleId),
    graphEdges: () => model.graphEdges.filter((candidate) => candidate.id !== edgeId),
    maybeSelectedRuleId: () => Option.none(),
    maybeSelectedGraphEdgeId: () => Option.none(),
  });
};

const removeGraphNode = (model: Model, nodeId: string): Model => {
  const connectedEdges = model.graphEdges.filter(
    (edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId,
  );
  const removedRuleIds = new Set(connectedEdges.map((edge) => edge.ruleId));
  const removedEdgeIds = new Set(connectedEdges.map((edge) => edge.id));
  return evo(model, {
    graphNodes: () => model.graphNodes.filter((node) => node.id !== nodeId),
    graphEdges: () => model.graphEdges.filter((edge) => !removedEdgeIds.has(edge.id)),
    rules: () => model.rules.filter((rule) => !removedRuleIds.has(rule.id)),
    maybeSelectedRuleId: () =>
      pipe(
        model.maybeSelectedRuleId,
        Option.filter((ruleId) => !removedRuleIds.has(ruleId)),
      ),
    maybeSelectedGraphEdgeId: () =>
      pipe(
        model.maybeSelectedGraphEdgeId,
        Option.filter((edgeId) => !removedEdgeIds.has(edgeId)),
      ),
    graphDrag: () => NotDraggingGraph(),
  });
};

const retargetGraphEdgeForRule = (
  model: Model,
  ruleId: string,
  surface: string,
  capability: string,
): Model => {
  const targetNodeId = graphCapabilityNodeId(surface, capability);
  const hasTargetNode = model.graphNodes.some((node) => node.id === targetNodeId);
  const targetNode: GraphNode = {
    id: targetNodeId,
    kind: "SurfaceCapability",
    label: `${surface} / ${capability}`,
    x: 650,
    y: 92 + model.graphNodes.filter((node) => node.kind === "SurfaceCapability").length * 132,
    maybeSurface: Option.some(surface),
    maybeCapability: Option.some(capability),
  };
  return evo(model, {
    graphNodes: () => (hasTargetNode ? model.graphNodes : [...model.graphNodes, targetNode]),
    graphEdges: () =>
      model.graphEdges.map((edge) => {
        if (edge.ruleId !== ruleId) {
          return edge;
        }
        return { ...edge, targetNodeId };
      }),
  });
};

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    withUpdateReturn,
    M.tagsExhaustive({
      AcquiredLandmarkers: () => [evo(model, { tracker: () => StartingCamera() }), []],
      FailedAcquireLandmarkers: ({ message }) => [
        evo(model, { tracker: () => FailedTracker({ message }) }),
        [],
      ],
      ReleasedLandmarkers: () => [model, []],

      AcquiredCamera: () => [evo(model, { tracker: () => AttachingCamera() }), [AttachCamera()]],
      FailedAcquireCamera: ({ message }) => [
        evo(model, { tracker: () => FailedTracker({ message }) }),
        [],
      ],
      ReleasedCamera: () => [model, []],

      CompletedAttachCamera: () => [evo(model, { tracker: () => Tracking() }), []],
      FailedAttachCamera: ({ message }) => [
        evo(model, { tracker: () => FailedTracker({ message }) }),
        [],
      ],

      AcquiredEngine: () => [model, []],
      FailedAcquireEngine: ({ message }) => [
        evo(model, { defs: () => FailedDefs({ message }) }),
        [],
      ],
      ReleasedEngine: () => [model, [HideAllRings()]],

      ConnectedSocket: ({ surfaces }) => [
        evo(model, {
          socket: () => SocketConnected(),
          controlSurfaces: () => surfaces,
        }),
        [],
      ],
      FailedConnectSocket: ({ message }) => [
        evo(model, { socket: () => SocketFailed({ message }) }),
        [],
      ],
      DisconnectedSocket: () => [
        evo(model, {
          socket: () => SocketDisconnected(),
          controlSurfaces: () => [],
        }),
        [],
      ],

      SucceededLoadDefs: ({ defs }) => [evo(model, { defs: () => LoadedDefs({ defs }) }), []],
      FailedLoadDefs: ({ message }) => [evo(model, { defs: () => FailedDefs({ message }) }), []],
      ClickedReloadDefs: () => [evo(model, { defs: () => LoadingDefs() }), [LoadDefs()]],
      PressedReloadKey: () => [evo(model, { defs: () => LoadingDefs() }), [LoadDefs()]],

      TickedFrame: () => {
        if (model.isProcessingFrame) {
          return [model, []];
        }
        return [
          evo(model, { isProcessingFrame: () => true }),
          [
            ProcessFrame({
              lastVideoTime: model.lastVideoTime,
              handTracking: model.handTracking,
              faceTracking: model.faceTracking,
              rules: model.rules,
              controlSurfaces: model.controlSurfaces,
            }),
          ],
        ];
      },
      ProcessedFrame: ({ videoTime, frame, handTracking, faceTracking }) => [
        evo(model, {
          frame: () => frame,
          handTracking: () => handTracking,
          faceTracking: () => faceTracking,
          lastVideoTime: () => videoTime,
          isProcessingFrame: () => false,
          maybeFrameError: () => Option.none(),
        }),
        [],
      ],
      SkippedFrame: () => [evo(model, { isProcessingFrame: () => false }), []],
      FailedFrame: ({ message }) => [
        evo(model, {
          isProcessingFrame: () => false,
          maybeFrameError: () => Option.some(message),
        }),
        [],
      ],

      CompletedHideAll: () => [model, []],
      SelectedRuleCapability: ({ ruleId, capability }) => {
        const maybeRule = Option.fromNullishOr(model.rules.find((rule) => rule.id === ruleId));
        const updated = evo(model, {
          maybeSelectedRuleId: () => Option.some(ruleId),
          rules: () =>
            model.rules.map((rule) => {
              if (rule.id !== ruleId) {
                return rule;
              }
              return { ...rule, capability };
            }),
        });
        return [
          pipe(
            maybeRule,
            Option.match({
              onNone: () => updated,
              onSome: (rule) => retargetGraphEdgeForRule(updated, ruleId, rule.surface, capability),
            }),
          ),
          [],
        ];
      },
      SelectedRuleSurface: ({ ruleId, surface }) => {
        const maybeRule = Option.fromNullishOr(model.rules.find((rule) => rule.id === ruleId));
        if (Option.isNone(maybeRule)) {
          return [model, []];
        }
        const capability = pipe(
          firstCapabilityForSurface(model.controlSurfaces, surface),
          Option.getOrElse(() => maybeRule.value.capability),
        );
        const updated = evo(model, {
          maybeSelectedRuleId: () => Option.some(ruleId),
          rules: () =>
            model.rules.map((rule) => {
              if (rule.id !== ruleId) {
                return rule;
              }
              return { ...rule, surface, capability };
            }),
        });
        return [retargetGraphEdgeForRule(updated, ruleId, surface, capability), []];
      },
      PressedPaletteNode: ({ kind, label, maybeSurface, maybeCapability, x, y }) => [
        evo(model, {
          graphDrag: () =>
            DraggingPaletteNode({
              kind,
              label,
              maybeSurface,
              maybeCapability,
              x,
              y,
              isInside: false,
            }),
        }),
        [],
      ],
      PressedGraphNode: ({ nodeId, x, y }) => [
        pipe(
          graphNodeById(model.graphNodes, nodeId),
          Option.match({
            onNone: () => model,
            onSome: (node) =>
              evo(model, {
                graphDrag: () =>
                  DraggingGraphNode({
                    nodeId,
                    offsetX: x - node.x,
                    offsetY: y - node.y,
                  }),
              }),
          }),
        ),
        [],
      ],
      RemovedGraphNode: ({ nodeId }) => [
        evo(removeGraphNode(model, nodeId), { maybeContextMenu: () => Option.none() }),
        [],
      ],
      PressedGraphHandle: ({ nodeId, x, y }) => [
        pipe(
          graphNodeById(model.graphNodes, nodeId),
          Option.match({
            onNone: () => model,
            onSome: (node) => {
              if (node.kind !== "Gesture") {
                return model;
              }
              return evo(model, {
                graphDrag: () =>
                  ConnectingGraphEdge({
                    sourceNodeId: nodeId,
                    x,
                    y,
                    isInside: true,
                  }),
              });
            },
          }),
        ),
        [],
      ],
      PressedGraphEdge: ({ edgeId }) => [
        pipe(
          Option.fromNullishOr(model.graphEdges.find((edge) => edge.id === edgeId)),
          Option.match({
            onNone: () => model,
            onSome: (edge) =>
              evo(model, {
                maybeSelectedGraphEdgeId: () => Option.some(edge.id),
                maybeSelectedRuleId: () => Option.some(edge.ruleId),
              }),
          }),
        ),
        [],
      ],
      MovedGraphPointer: ({ x, y, isInside }) => [
        M.value(model.graphDrag).pipe(
          M.tagsExhaustive({
            NotDraggingGraph: () => model,
            DraggingGraphNode: ({ nodeId, offsetX, offsetY }) =>
              evo(model, {
                graphNodes: () =>
                  model.graphNodes.map((node) => {
                    if (node.id !== nodeId) {
                      return node;
                    }
                    return {
                      ...node,
                      x: Math.max(0, Math.min(GRAPH_SURFACE_WIDTH - GRAPH_NODE_WIDTH, x - offsetX)),
                      y: Math.max(
                        0,
                        Math.min(GRAPH_SURFACE_HEIGHT - GRAPH_NODE_HEIGHT, y - offsetY),
                      ),
                    };
                  }),
              }),
            DraggingPaletteNode: (drag) =>
              evo(model, {
                graphDrag: () => DraggingPaletteNode({ ...drag, x, y, isInside }),
              }),
            ConnectingGraphEdge: (drag) =>
              evo(model, {
                graphDrag: () => ConnectingGraphEdge({ ...drag, x, y, isInside }),
              }),
          }),
        ),
        [],
      ],
      ReleasedGraphPointer: ({ x, y, isInside }) => [
        M.value(model.graphDrag).pipe(
          M.tagsExhaustive({
            NotDraggingGraph: () => model,
            DraggingGraphNode: () => evo(model, { graphDrag: () => NotDraggingGraph() }),
            DraggingPaletteNode: (drag) => {
              if (!isInside) {
                return evo(model, { graphDrag: () => NotDraggingGraph() });
              }
              const dropped = graphNodeFromPaletteDrag(model, { ...drag, x, y, isInside });
              return evo(model, {
                graphNodes: () => [...model.graphNodes, dropped],
                graphDrag: () => NotDraggingGraph(),
              });
            },
            ConnectingGraphEdge: (drag) => {
              if (!isInside) {
                return evo(model, { graphDrag: () => NotDraggingGraph() });
              }
              return pipe(
                graphNodeAtPoint(model.graphNodes, { x, y }),
                Option.match({
                  onNone: () => evo(model, { graphDrag: () => NotDraggingGraph() }),
                  onSome: (targetNode) => connectGraphNodes(model, drag.sourceNodeId, targetNode),
                }),
              );
            },
          }),
        ),
        [],
      ],
      DisconnectedGraphEdge: ({ edgeId }) => [
        evo(removeGraphEdge(model, edgeId), { maybeContextMenu: () => Option.none() }),
        [],
      ],
      OpenedNodeContextMenu: ({ nodeId, x, y }) => [
        evo(model, { maybeContextMenu: () => Option.some(NodeContextMenu({ nodeId, x, y })) }),
        [],
      ],
      OpenedEdgeContextMenu: ({ edgeId, x, y }) => [
        evo(model, { maybeContextMenu: () => Option.some(EdgeContextMenu({ edgeId, x, y })) }),
        [],
      ],
      ClosedContextMenu: () => [evo(model, { maybeContextMenu: () => Option.none() }), []],
    }),
  );

// COMMAND

const findVideo = Effect.suspend(() => {
  const element = document.getElementById(VIDEO_ELEMENT_ID);
  return element instanceof HTMLVideoElement
    ? Effect.succeed(element)
    : Effect.fail(new VideoElementNotFound({ message: "camera video element not found" }));
});

export const LoadDefs = Command.define(
  "LoadDefs",
  SucceededLoadDefs,
  FailedLoadDefs,
)(
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() => fetch("/api/gestures"));
    const body = yield* Effect.tryPromise(() => response.json());
    if (!response.ok) {
      const message = (body as { error?: string }).error ?? `HTTP ${response.status}`;
      return yield* new DefsRequestError({ message });
    }
    const defs = yield* S.decodeUnknownEffect(S.Array(GestureDef))(body);
    return SucceededLoadDefs({ defs });
  }).pipe(
    Effect.catch((error) => Effect.succeed(FailedLoadDefs({ message: errorMessage(error) }))),
  ),
);

export const AttachCamera = Command.define(
  "AttachCamera",
  CompletedAttachCamera,
  FailedAttachCamera,
)(
  Effect.gen(function* () {
    const stream = yield* CameraResource.get;
    const video = yield* findVideo;
    yield* Effect.callback<void>((resume) => {
      video.onloadedmetadata = () => resume(Effect.void);
      video.srcObject = stream;
      return Effect.sync(() => {
        video.onloadedmetadata = null;
      });
    });
    return CompletedAttachCamera();
  }).pipe(
    Effect.catch((error) => Effect.succeed(FailedAttachCamera({ message: errorMessage(error) }))),
  ),
);

type ControlCommand = { surface: string; type: string } & Record<string, unknown>;

const sendControlCommands = (messages: ReadonlyArray<ControlCommand>) =>
  SocketResource.get.pipe(
    Effect.flatMap(({ socket }) =>
      Effect.sync(() => {
        if (socket.readyState === WebSocket.OPEN) {
          messages.forEach((message) => socket.send(JSON.stringify(message)));
        }
      }),
    ),
    Effect.catchTag("ResourceNotAvailable", () => Effect.void),
  );

export const HideAllRings = Command.define(
  "HideAllRings",
  CompletedHideAll,
)(sendControlCommands([{ surface: "mac", type: "hideall" }]).pipe(Effect.as(CompletedHideAll())));

const commandToEcho = (message: ControlCommand): Option.Option<Echo> => {
  if (message.type === "circle") {
    return Option.some(
      RingEcho({
        x: Number(message.x),
        y: Number(message.y),
        radius: Number(message.r),
      }),
    );
  }
  if (message.type === "click") {
    return Option.some(ClickEcho({ x: Number(message.x), y: Number(message.y) }));
  }
  return Option.none();
};

const boundCommand = (
  status: InstanceStatus,
  rule: GestureRule,
  globals: Readonly<{ hands: { count: number }; faces: { count: number } }>,
): Option.Option<ControlCommand> => {
  if (rule.gesture !== status.gesture) {
    return Option.none();
  }
  try {
    const ctx = (name: string) => {
      if (name in status.metrics) return status.metrics[name];
      if (name in globals) return globals[name as keyof typeof globals];
      return (status as unknown as Record<string, unknown>)[name];
    };
    if (!parseExpr(rule.when)(ctx)) {
      return Option.none();
    }
    const command: ControlCommand = { surface: rule.surface, type: rule.capability };
    for (const [field, value] of Object.entries(rule.fields)) {
      command[field] = typeof value === "string" ? parseExpr(value)(ctx) : value;
    }
    return Option.some(command);
  } catch {
    return Option.none();
  }
};

const bindGestureRules = (
  statuses: ReadonlyArray<InstanceStatus>,
  rules: ReadonlyArray<GestureRule>,
  surfaces: ReadonlyArray<ControlSurface>,
  globals: Readonly<{ hands: { count: number }; faces: { count: number } }>,
): ReadonlyArray<ControlCommand> => {
  const supportedCapabilitiesBySurface = new Map(
    surfaces.map((surface) => [surface.id, new Set(surface.capabilities.map(({ type }) => type))]),
  );
  return statuses.flatMap((status) =>
    rules.flatMap((rule) => {
      if (!supportedCapabilitiesBySurface.get(rule.surface)?.has(rule.capability)) {
        return [];
      }
      return Option.match(boundCommand(status, rule, globals), {
        onNone: () => [],
        onSome: (command) => [command],
      });
    }),
  );
};

const formatMetricValue = (value: unknown): string => {
  if (typeof value === "number") {
    return value.toFixed(2);
  }
  if (value !== null && typeof value === "object" && "x" in value && "y" in value) {
    const point = value as LandmarkPoint;
    const z = point.z === undefined ? "" : `, ${point.z.toFixed(2)}`;
    return `(${point.x.toFixed(2)}, ${point.y.toFixed(2)}${z})`;
  }
  return String(value);
};

const formatMetrics = (metrics: Record<string, unknown>): string =>
  Object.entries(metrics)
    .map(([name, value]) => `${name}=${formatMetricValue(value)}`)
    .join("  ");

export const ProcessFrame = Command.define(
  "ProcessFrame",
  {
    lastVideoTime: S.Number,
    handTracking: TrackState,
    faceTracking: TrackState,
    rules: S.Array(GestureRule),
    controlSurfaces: S.Array(ControlSurface),
  },
  ProcessedFrame,
  SkippedFrame,
  FailedFrame,
)(({ lastVideoTime, handTracking, faceTracking, rules, controlSurfaces }) =>
  Effect.gen(function* () {
    const { handLandmarker, faceLandmarker } = yield* LandmarkersResource.get;
    const engine = yield* EngineResource.get;
    const video = yield* findVideo;
    if (video.currentTime === lastVideoTime) {
      return SkippedFrame();
    }

    const detected = yield* Effect.sync(() => {
      const timestamp = performance.now();
      const hands = handLandmarker.detectForVideo(video, timestamp);
      const faces = faceLandmarker.detectForVideo(video, timestamp);
      return {
        hands: hands.landmarks.map((rawLandmarks, index) => ({
          landmarks: mirror(rawLandmarks),
          worldLandmarks: hands.worldLandmarks[index],
          nullableLabel: hands.handedness[index]?.[0]?.categoryName,
        })),
        faces: faces.faceLandmarks.map(mirror),
      };
    });

    const nextHandTracking = matchTracked(
      handTracking,
      detected.hands.map(({ landmarks }) => landmarkAt(landmarks, HAND_LANDMARKS.wrist)),
    );
    const nextFaceTracking = matchTracked(
      faceTracking,
      detected.faces.map((landmarks) => landmarkAt(landmarks, FACE_LANDMARKS.nose_tip)),
    );

    const entities: Array<Entity> = [
      ...Array.zipWith(
        detected.hands,
        nextHandTracking.tracked,
        ({ landmarks, worldLandmarks, nullableLabel }, trackedAnchor): Entity => ({
          type: "hand",
          id: trackedAnchor.id,
          landmarks,
          worldLandmarks,
          names: HAND_LANDMARKS,
          label: nullableLabel,
        }),
      ),
      ...Array.zipWith(
        detected.faces,
        nextFaceTracking.tracked,
        (landmarks, trackedAnchor): Entity => ({
          type: "face",
          id: trackedAnchor.id,
          landmarks,
          names: FACE_LANDMARKS,
        }),
      ),
    ];

    const { statuses } = yield* engine.step(entities);
    const commands = bindGestureRules(statuses, rules, controlSurfaces, {
      hands: { count: entities.filter((entity) => entity.type === "hand").length },
      faces: { count: entities.filter((entity) => entity.type === "face").length },
    });
    yield* sendControlCommands(commands);

    return ProcessedFrame({
      videoTime: video.currentTime,
      frame: {
        entities: entities.map(
          (entity): FrameEntity => ({
            kind: entity.type,
            id: entity.id,
            landmarks: entity.landmarks,
            maybeLabel: Option.fromNullishOr(entity.label),
          }),
        ),
        statuses: statuses.map(
          (status): GestureStatus => ({
            key: status.key,
            gesture: status.gesture,
            state: status.state,
            previousState: status.previousState,
            metrics: formatMetrics(status.metrics),
            maybeError: Option.fromNullishOr(status.error),
          }),
        ),
        echoes: Array.getSomes(commands.map(commandToEcho)),
      },
      handTracking: nextHandTracking,
      faceTracking: nextFaceTracking,
    });
  }).pipe(
    Effect.catchTag("ResourceNotAvailable", () => Effect.succeed(SkippedFrame())),
    Effect.catch((error) => Effect.succeed(FailedFrame({ message: errorMessage(error) }))),
  ),
);

// MANAGED RESOURCE

export const managedResources = ManagedResource.make<Model, Message>()((entry) => ({
  landmarkers: entry(S.Option(S.Null), {
    resource: LandmarkersResource,
    modelToMaybeRequirements: (model) =>
      M.value(model.tracker).pipe(
        M.tag("FailedTracker", () => Option.none()),
        M.orElse(() => Option.some(null)),
      ),
    acquire: () =>
      Effect.tryPromise({
        try: async () => {
          const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
          const [handLandmarker, faceLandmarker] = await Promise.all([
            HandLandmarker.createFromOptions(vision, {
              baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: "GPU" },
              runningMode: "VIDEO",
              numHands: MAX_HANDS,
            }),
            FaceLandmarker.createFromOptions(vision, {
              baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: "GPU" },
              runningMode: "VIDEO",
              numFaces: MAX_FACES,
            }),
          ]);
          return { handLandmarker, faceLandmarker };
        },
        catch: (cause) => new LandmarkerLoadError({ message: errorMessage(cause) }),
      }),
    release: (landmarkers: Landmarkers) =>
      Effect.sync(() => {
        landmarkers.handLandmarker.close();
        landmarkers.faceLandmarker.close();
      }),
    onAcquired: () => AcquiredLandmarkers(),
    onAcquireError: (error) => FailedAcquireLandmarkers({ message: errorMessage(error) }),
    onReleased: () => ReleasedLandmarkers(),
  }),

  camera: entry(S.Option(S.Null), {
    resource: CameraResource,
    modelToMaybeRequirements: (model) =>
      M.value(model.tracker).pipe(
        M.tag("StartingCamera", () => Option.some(null)),
        M.tag("AttachingCamera", () => Option.some(null)),
        M.tag("Tracking", () => Option.some(null)),
        M.orElse(() => Option.none()),
      ),
    acquire: () =>
      Effect.tryPromise({
        try: () =>
          navigator.mediaDevices.getUserMedia({
            video: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
          }),
        catch: (cause) => new CameraAccessError({ message: errorMessage(cause) }),
      }),
    release: (stream: MediaStream) =>
      Effect.sync(() => stream.getTracks().forEach((track) => track.stop())),
    onAcquired: () => AcquiredCamera(),
    onAcquireError: (error) => FailedAcquireCamera({ message: errorMessage(error) }),
    onReleased: () => ReleasedCamera(),
  }),

  engine: entry(S.Option(S.Struct({ defs: S.Array(GestureDef) })), {
    resource: EngineResource,
    modelToMaybeRequirements: (model) =>
      M.value(model.defs).pipe(
        M.tag("LoadedDefs", ({ defs }) => Option.some({ defs })),
        M.orElse(() => Option.none()),
      ),
    acquire: ({ defs }) => GestureEngine.make(defs),
    release: () => Effect.void,
    onAcquired: () => AcquiredEngine(),
    onAcquireError: (error) => FailedAcquireEngine({ message: errorMessage(error) }),
    onReleased: () => ReleasedEngine(),
  }),

  socket: entry(S.Option(S.Null), {
    resource: SocketResource,
    modelToMaybeRequirements: (model) =>
      M.value(model.tracker).pipe(
        M.tag("Tracking", () => Option.some(null)),
        M.orElse(() => Option.none()),
      ),
    acquire: () =>
      Effect.callback<SocketConnection, SocketConnectError>((resume) => {
        const socket = new WebSocket(`ws://${location.host}/ws`);
        const decodeAdvertisement = S.decodeUnknownOption(SurfacesAdvertisement);
        let isComplete = false;
        const complete = (effect: Effect.Effect<SocketConnection, SocketConnectError>) => {
          if (isComplete) {
            return;
          }
          isComplete = true;
          removeHandlers();
          resume(effect);
        };
        const handleMessage = (event: MessageEvent) => {
          try {
            const maybeAdvertisement = decodeAdvertisement(JSON.parse(String(event.data)));
            if (Option.isSome(maybeAdvertisement)) {
              complete(
                Effect.succeed({
                  socket,
                  surfaces: maybeAdvertisement.value.surfaces,
                }),
              );
            }
          } catch {}
        };
        const handleError = () => {
          complete(
            Effect.fail(
              new SocketConnectError({
                message: "failed to connect to control bridge",
              }),
            ),
          );
        };
        const handleClose = () => {
          complete(
            Effect.fail(
              new SocketConnectError({
                message: "control bridge closed before advertising surfaces",
              }),
            ),
          );
        };
        const removeHandlers = () => {
          socket.removeEventListener("message", handleMessage);
          socket.removeEventListener("error", handleError);
          socket.removeEventListener("close", handleClose);
        };
        socket.addEventListener("message", handleMessage);
        socket.addEventListener("error", handleError);
        socket.addEventListener("close", handleClose);
        return Effect.sync(removeHandlers);
      }),
    release: ({ socket }) => Effect.sync(() => socket.close()),
    onAcquired: ({ surfaces }) => ConnectedSocket({ surfaces }),
    onAcquireError: (error) => FailedConnectSocket({ message: errorMessage(error) }),
    onReleased: () => DisconnectedSocket(),
  }),
}));

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message>()(() => ({
  frame: Subscription.animationFrame({
    isActive: (model) => model.tracker._tag === "Tracking",
    toMessage: () => TickedFrame(),
  }),
  reloadKey: Subscription.persistent(
    Stream.fromEventListener<KeyboardEvent>(document, "keydown").pipe(
      Stream.filter((event) => event.key === "r"),
      Stream.map(() => PressedReloadKey()),
    ),
  ),
}));

// VIEW

const HAND_DOT_COLOR = "#38bdf8";
const FACE_OVAL_COLOR = "#a78bfa";
const RING_COLOR = "#22c55e";
const CLICK_COLOR = "#facc15";
const LABEL_COLOR = "#eeeeee";
const LABEL_FONT = "13px system-ui";

const HAND_DOT_RADIUS = 3;
const HAND_LABEL_OFFSET = 22;
const FACE_LABEL_OFFSET = 18;
const RING_BASE_RADIUS = 6;
const RING_RADIUS_SCALE = 40 / 64;
const CLICK_ECHO_RADIUS = 18;

const toStage = (point: LandmarkPoint): LandmarkPoint => ({
  x: point.x * STAGE_WIDTH,
  y: point.y * STAGE_HEIGHT,
});

const labelShape = (content: string, at: LandmarkPoint): Canvas.Shape =>
  Canvas.Text({
    x: at.x,
    y: at.y,
    content,
    font: LABEL_FONT,
    fill: LABEL_COLOR,
    align: "Center",
  });

const handShapes = (entity: FrameEntity): ReadonlyArray<Canvas.Shape> => {
  const wrist = toStage(landmarkAt(entity.landmarks, HAND_LANDMARKS.wrist));
  const label = pipe(
    entity.maybeLabel,
    Option.match({
      onNone: () => `hand #${entity.id}`,
      onSome: (handedness) => `hand #${entity.id} ${handedness}`,
    }),
  );
  return [
    ...entity.landmarks.map((point) => {
      const at = toStage(point);
      return Canvas.Circle({
        x: at.x,
        y: at.y,
        radius: HAND_DOT_RADIUS,
        fill: HAND_DOT_COLOR,
      });
    }),
    labelShape(label, { x: wrist.x, y: wrist.y + HAND_LABEL_OFFSET }),
  ];
};

const faceShapes = (entity: FrameEntity): ReadonlyArray<Canvas.Shape> => {
  const chin = toStage(landmarkAt(entity.landmarks, FACE_LANDMARKS.chin));
  return [
    Canvas.Path({
      instructions: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL.flatMap(({ start, end }) => {
        const from = toStage(landmarkAt(entity.landmarks, start));
        const to = toStage(landmarkAt(entity.landmarks, end));
        return [Canvas.MoveTo({ x: from.x, y: from.y }), Canvas.LineTo({ x: to.x, y: to.y })];
      }),
      stroke: FACE_OVAL_COLOR,
      lineWidth: 2,
    }),
    labelShape(`face #${entity.id}`, {
      x: chin.x,
      y: chin.y + FACE_LABEL_OFFSET,
    }),
  ];
};

const entityShapes = (entity: FrameEntity): ReadonlyArray<Canvas.Shape> => {
  if (entity.kind === "hand") {
    return handShapes(entity);
  }
  return faceShapes(entity);
};

const echoShape = (echo: Echo): Canvas.Shape =>
  M.value(echo).pipe(
    M.tagsExhaustive({
      RingEcho: ({ x, y, radius }) =>
        Canvas.Circle({
          x: x * STAGE_WIDTH,
          y: y * STAGE_HEIGHT,
          radius: radius * RING_RADIUS_SCALE + RING_BASE_RADIUS,
          stroke: RING_COLOR,
          lineWidth: 3,
        }),
      ClickEcho: ({ x, y }) =>
        Canvas.Circle({
          x: x * STAGE_WIDTH,
          y: y * STAGE_HEIGHT,
          radius: CLICK_ECHO_RADIUS,
          stroke: CLICK_COLOR,
          lineWidth: 4,
        }),
    }),
  );

const sceneShapes = (frame: Frame): ReadonlyArray<Canvas.Shape> => [
  ...frame.entities.flatMap(entityShapes),
  ...frame.echoes.map(echoShape),
];

const countLabel = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const trackingStatusText = (frame: Frame): string =>
  Array.match(frame.entities, {
    onEmpty: () => "No one detected",
    onNonEmpty: (entities) => {
      const handCount = entities.filter((entity) => entity.kind === "hand").length;
      const faceCount = entities.filter((entity) => entity.kind === "face").length;
      const counts = `${countLabel(faceCount, "face")} · ${countLabel(handCount, "hand")}`;
      const activeStatuses = frame.statuses.filter(
        (status) => status.state !== "idle" || Option.isSome(status.maybeError),
      );
      return Array.match(activeStatuses, {
        onEmpty: () => counts,
        onNonEmpty: (active) =>
          `${counts} · ${active.map((status) => `${status.gesture}:${status.state}`).join(", ")}`,
      });
    },
  });

const statusView = (model: Model): Html => {
  const h = html<Message>();
  const text = M.value(model.tracker).pipe(
    M.tagsExhaustive({
      LoadingModels: () => "loading models…",
      StartingCamera: () => "requesting camera…",
      AttachingCamera: () => "starting video…",
      Tracking: () => trackingStatusText(model.frame),
      FailedTracker: ({ message }) => `error: ${message}`,
    }),
  );
  const isActive = model.frame.statuses.some(
    (status) => status.state !== "idle" && Option.isNone(status.maybeError),
  );
  return h.div(
    [h.Class("flex items-center gap-2 text-xs")],
    [
      h.span(
        [h.Class(`size-1.5 shrink-0 rounded-full ${isActive ? "bg-green-400" : "bg-slate-700"}`)],
        [],
      ),
      h.span([h.Class(isActive ? "text-green-300" : "text-slate-500")], [text]),
    ],
  );
};

const defsLine = (defs: DefsState): Html => {
  const h = html<Message>();
  return M.value(defs).pipe(
    M.tagsExhaustive({
      LoadingDefs: () => h.div([], ["loading gestures…"]),
      FailedDefs: ({ message }) => h.div([h.Class("text-red-400")], [`defs failed: ${message}`]),
      LoadedDefs: ({ defs }) =>
        h.div(
          [],
          [
            `gestures loaded: ${Array.match(defs, {
              onEmpty: () => "(none)",
              onNonEmpty: (loaded) => loaded.map((def) => def.name).join(", "),
            })}`,
          ],
        ),
    }),
  );
};

const statusLine = (status: GestureStatus): Html => {
  const h = html<Message>();
  return pipe(
    status.maybeError,
    Option.match({
      onNone: () =>
        h.div(
          [],
          [`${status.key} [${status.previousState} -> ${status.state}]  ${status.metrics}`],
        ),
      onSome: (error) => h.div([h.Class("text-red-400")], [`${status.key}: ${error}`]),
    }),
  );
};

const socketLine = (socket: SocketState, surfaces: ReadonlyArray<ControlSurface>): Html => {
  const h = html<Message>();
  return M.value(socket).pipe(
    M.tagsExhaustive({
      SocketDisconnected: () => h.div([], ["control bridge: disconnected"]),
      SocketConnected: () =>
        h.div(
          [],
          [
            `control bridge: connected (${surfaces
              .map(
                (surface) =>
                  `${surface.id}: ${surface.capabilities
                    .map((capability) => capability.type)
                    .join(", ")}`,
              )
              .join(", ")})`,
          ],
        ),
      SocketFailed: ({ message }) =>
        h.div([h.Class("text-red-400")], [`control bridge: ${message}`]),
    }),
  );
};

const surfaceOptions = (
  rule: GestureRule,
  surfaces: ReadonlyArray<ControlSurface>,
): ReadonlyArray<string> => {
  const advertised = surfaces.map((surface) => surface.id);
  if (advertised.includes(rule.surface)) {
    return advertised;
  }
  return [rule.surface, ...advertised];
};

const capabilityOptions = (
  rule: GestureRule,
  surfaces: ReadonlyArray<ControlSurface>,
): ReadonlyArray<string> => {
  const advertised = capabilitiesForSurface(surfaces, rule.surface).map(
    (capability) => capability.type,
  );
  if (advertised.includes(rule.capability)) {
    return advertised;
  }
  return [rule.capability, ...advertised];
};

const fieldsText = (rule: GestureRule): string =>
  Object.entries(rule.fields)
    .map(([field, value]) => `${field}=${value}`)
    .join(", ");

const uniqueStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  globalThis.Array.from(new Set(values));

type SurfaceNode = Readonly<{
  id: string;
  label: string;
  capabilities: ReadonlyArray<string>;
}>;

const gestureNodeNames = (model: Model): ReadonlyArray<string> => {
  const loaded = M.value(model.defs).pipe(
    M.tagsExhaustive({
      LoadingDefs: () => [],
      FailedDefs: () => [],
      LoadedDefs: ({ defs }) => defs.map((def) => def.name),
    }),
  );
  return uniqueStrings([...loaded, ...model.rules.map((rule) => rule.gesture)]);
};

const surfaceNodes = (model: Model): ReadonlyArray<SurfaceNode> => {
  const advertised = model.controlSurfaces.map((surface) => ({
    id: surface.id,
    label: surface.label,
    capabilities: surface.capabilities.map((capability) => capability.type),
  }));
  const fallback = uniqueStrings(model.rules.map((rule) => rule.surface))
    .filter((surface) => !advertised.some((node) => node.id === surface))
    .map((surface) => ({
      id: surface,
      label: surface,
      capabilities: uniqueStrings(
        model.rules.filter((rule) => rule.surface === surface).map((rule) => rule.capability),
      ),
    }));
  return [...advertised, ...fallback];
};

const capabilityNodeNames = (model: Model): ReadonlyArray<string> =>
  uniqueStrings([
    ...model.controlSurfaces.flatMap((surface) =>
      surface.capabilities.map((capability) => capability.type),
    ),
    ...model.rules.map((rule) => rule.capability),
  ]);

type PaletteNode = Readonly<{
  kind: GraphNodeKind;
  label: string;
  maybeSurface: Option.Option<string>;
  maybeCapability: Option.Option<string>;
}>;

const palettePointerDown = (node: PaletteNode) =>
  html<Message>().OnPointerDown(
    (_pointerType, button, _screenX, _screenY, _timeStamp, clientX, clientY) => {
      if (button !== 0) {
        return Option.none();
      }
      return Option.some(
        PressedPaletteNode({
          kind: node.kind,
          label: node.label,
          maybeSurface: node.maybeSurface,
          maybeCapability: node.maybeCapability,
          x: clientX,
          y: clientY,
        }),
      );
    },
  );

const paletteItemView = (key: string, node: PaletteNode, dotColor: string): Html => {
  const h = html<Message>();
  return h.keyed("li")(
    key,
    [
      palettePointerDown(node),
      h.Class(
        "flex cursor-grab select-none items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200 active:cursor-grabbing",
      ),
    ],
    [h.span([h.Class(`size-1.5 shrink-0 rounded-full ${dotColor}`)], []), node.label],
  );
};

const paletteSectionView = (
  title: string,
  items: ReadonlyArray<PaletteNode>,
  dotColor: string,
): Html => {
  const h = html<Message>();
  return h.section(
    [h.Class("space-y-1")],
    [
      h.div(
        [h.Class("mb-1.5 px-2 text-[10px] font-medium uppercase tracking-widest text-slate-600")],
        [title],
      ),
      h.ul(
        [h.Class("space-y-0.5")],
        Array.match(items, {
          onEmpty: () => [
            h.li([h.Class("px-2 py-1.5 text-xs text-slate-700")], ["—"]),
          ],
          onNonEmpty: (nodes) =>
            nodes.map((item) => paletteItemView(`${title}:${item.label}`, item, dotColor)),
        }),
      ),
    ],
  );
};

const gesturePaletteNodes = (model: Model): ReadonlyArray<PaletteNode> =>
  gestureNodeNames(model).map((gesture) => ({
    kind: "Gesture" as const,
    label: gesture,
    maybeSurface: Option.none(),
    maybeCapability: Option.none(),
  }));

const surfaceCapabilityPaletteNodes = (model: Model): ReadonlyArray<PaletteNode> =>
  surfaceNodes(model).flatMap((surface) =>
    surface.capabilities.map((capability) => ({
      kind: "SurfaceCapability" as const,
      label: `${surface.id} / ${capability}`,
      maybeSurface: Option.some(surface.id),
      maybeCapability: Option.some(capability),
    })),
  );

const capabilityPaletteNodes = (model: Model): ReadonlyArray<PaletteNode> =>
  capabilityNodeNames(model).flatMap((capability) => {
    const maybeSurface = Option.fromNullishOr(
      surfaceNodes(model).find((surface) => surface.capabilities.includes(capability)),
    );
    return pipe(
      maybeSurface,
      Option.match({
        onNone: () => [],
        onSome: (surface) => [
          {
            kind: "SurfaceCapability" as const,
            label: capability,
            maybeSurface: Option.some(surface.id),
            maybeCapability: Option.some(capability),
          },
        ],
      }),
    );
  });

const nodePaletteView = (model: Model): Html => {
  const h = html<Message>();
  return h.aside(
    [h.Class("w-full xl:w-48 shrink-0 space-y-5 pt-1")],
    [
      paletteSectionView("Gestures", gesturePaletteNodes(model), "bg-sky-400/80"),
      paletteSectionView("Surfaces", surfaceCapabilityPaletteNodes(model), "bg-violet-400/80"),
      paletteSectionView("Capabilities", capabilityPaletteNodes(model), "bg-emerald-400/80"),
    ],
  );
};

const activeStateForGesture = (model: Model, gesture: string): Option.Option<string> => {
  const status = model.frame.statuses.find(
    (candidate) =>
      candidate.gesture === gesture &&
      candidate.state !== "idle" &&
      Option.isNone(candidate.maybeError),
  );
  if (status === undefined) {
    return Option.none();
  }
  return Option.some(status.state);
};

const selectedRule = (model: Model): Option.Option<GestureRule> =>
  pipe(
    model.maybeSelectedRuleId,
    Option.flatMap((ruleId) =>
      Option.fromNullishOr(model.rules.find((rule) => rule.id === ruleId)),
    ),
  );

const selectedEdge = (model: Model): Option.Option<GraphEdge> =>
  pipe(
    model.maybeSelectedGraphEdgeId,
    Option.flatMap((edgeId) =>
      Option.fromNullishOr(model.graphEdges.find((edge) => edge.id === edgeId)),
    ),
  );

const graphNodeDetail = (model: Model, node: GraphNode): string => {
  if (node.kind === "Gesture") {
    return pipe(
      activeStateForGesture(model, node.label),
      Option.match({
        onNone: () => "idle",
        onSome: (state) => state,
      }),
    );
  }
  return pipe(
    Option.all({ surface: node.maybeSurface, capability: node.maybeCapability }),
    Option.match({
      onNone: () => "surface capability",
      onSome: ({ surface, capability }) => `${surface}.${capability}`,
    }),
  );
};

const graphNodeClass = (node: GraphNode): string => {
  if (node.kind === "Gesture") {
    return "border border-sky-900/50 bg-[#0a1828]";
  }
  return "border border-violet-900/50 bg-[#0d0e1e]";
};

const graphNodeStyle = (node: GraphNode): Record<string, string> => ({
  left: `${node.x}px`,
  top: `${node.y}px`,
  width: `${GRAPH_NODE_WIDTH}px`,
  height: `${GRAPH_NODE_HEIGHT}px`,
});

const edgeView = (model: Model, edge: GraphEdge): Html => {
  const h = html<Message>();
  const maybeSource = graphNodeById(model.graphNodes, edge.sourceNodeId);
  const maybeTarget = graphNodeById(model.graphNodes, edge.targetNodeId);
  if (Option.isNone(maybeSource) || Option.isNone(maybeTarget)) {
    return null;
  }
  const source = maybeSource.value;
  const target = maybeTarget.value;
  const isSelected = pipe(
    model.maybeSelectedGraphEdgeId,
    Option.exists((edgeId) => edgeId === edge.id),
  );
  const stroke = isSelected ? "#facc15" : "#38bdf8";
  return h.g(
    [],
    [
      h.path(
        [
          h.D(edgePath(sourcePort(source), targetPort(target))),
          h.Stroke("transparent"),
          h.StrokeWidth("18"),
          h.Fill("none"),
          h.Class("cursor-pointer"),
          h.DataAttribute("graph-edge-id", edge.id),
        ],
        [],
      ),
      h.path(
        [
          h.D(edgePath(sourcePort(source), targetPort(target))),
          h.Stroke(stroke),
          h.StrokeWidth(isSelected ? "4" : "3"),
          h.Fill("none"),
          h.StrokeLinecap("round"),
          h.Class("pointer-events-none drop-shadow"),
        ],
        [],
      ),
    ],
  );
};

const connectionPreviewView = (model: Model): Html => {
  const h = html<Message>();
  return M.value(model.graphDrag).pipe(
    M.tagsExhaustive({
      NotDraggingGraph: () => null,
      DraggingGraphNode: () => null,
      DraggingPaletteNode: () => null,
      ConnectingGraphEdge: ({ sourceNodeId, x, y }) =>
        pipe(
          graphNodeById(model.graphNodes, sourceNodeId),
          Option.match({
            onNone: () => null,
            onSome: (source) =>
              h.path(
                [
                  h.D(edgePath(sourcePort(source), { x, y })),
                  h.Stroke("#facc15"),
                  h.StrokeWidth("3"),
                  h.Fill("none"),
                  h.StrokeLinecap("round"),
                  h.StrokeDasharray("8 8"),
                ],
                [],
              ),
          }),
        ),
    }),
  );
};

const graphEdgeLayerView = (model: Model): Html => {
  const h = html<Message>();
  return h.svg(
    [
      h.ViewBox(`0 0 ${GRAPH_SURFACE_WIDTH} ${GRAPH_SURFACE_HEIGHT}`),
      h.Width(`${GRAPH_SURFACE_WIDTH}`),
      h.Height(`${GRAPH_SURFACE_HEIGHT}`),
      h.Class("absolute inset-0 z-10"),
    ],
    [...model.graphEdges.map((edge) => edgeView(model, edge)), connectionPreviewView(model)],
  );
};

const graphNodeView = (model: Model, node: GraphNode): Html => {
  const h = html<Message>();
  const isGesture = node.kind === "Gesture";
  return h.keyed("div")(
    node.id,
    [
      h.DataAttribute("graph-node-id", node.id),
      h.Style(graphNodeStyle(node)),
      h.Class(
        `absolute z-20 select-none rounded p-3 text-left ${graphNodeClass(node)} cursor-grab active:cursor-grabbing`,
      ),
    ],
    [
      h.div(
        [h.Class("text-[9px] font-medium uppercase tracking-widest text-slate-600")],
        [isGesture ? "gesture" : "surface"],
      ),
      h.div([h.Class("mt-1.5 truncate text-sm font-medium text-slate-200")], [node.label]),
      h.div([h.Class("mt-0.5 truncate text-xs text-slate-600")], [graphNodeDetail(model, node)]),
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("graph-remove-node-id", node.id),
          h.OnClick(RemovedGraphNode({ nodeId: node.id })),
          h.Class(
            "absolute right-1.5 top-1.5 z-30 grid size-4 place-items-center rounded text-[10px] text-slate-700 hover:text-slate-300",
          ),
        ],
        ["×"],
      ),
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("graph-handle-node-id", node.id),
          h.Class(
            isGesture
              ? "absolute -right-2 top-1/2 z-30 size-4 -translate-y-1/2 rounded-full border border-[#0a1828] bg-sky-600/70"
              : "absolute -left-2 top-1/2 z-30 size-4 -translate-y-1/2 rounded-full border border-[#0d0e1e] bg-violet-600/70",
          ),
        ],
        [],
      ),
    ],
  );
};

const graphPreviewNodeView = (drag: typeof DraggingPaletteNode.Type): Html => {
  const h = html<Message>();
  if (!drag.isInside) {
    return null;
  }
  return h.div(
    [
      h.Style({
        left: `${drag.x - GRAPH_NODE_WIDTH / 2}px`,
        top: `${drag.y - GRAPH_NODE_HEIGHT / 2}px`,
        width: `${GRAPH_NODE_WIDTH}px`,
        height: `${GRAPH_NODE_HEIGHT}px`,
      }),
      h.Class(
        "pointer-events-none absolute z-30 rounded-2xl border border-dashed border-yellow-300 bg-yellow-300/10 p-3 text-sm text-yellow-100",
      ),
    ],
    [drag.label],
  );
};

const graphDragPreviewView = (model: Model): Html =>
  M.value(model.graphDrag).pipe(
    M.tagsExhaustive({
      NotDraggingGraph: () => null,
      DraggingGraphNode: () => null,
      ConnectingGraphEdge: () => null,
      DraggingPaletteNode: graphPreviewNodeView,
    }),
  );

const selectedRuleInspectorView = (model: Model): Html => {
  const h = html<Message>();
  return pipe(
    selectedRule(model),
    Option.match({
      onNone: () =>
        h.aside(
          [
            h.Class(
              "rounded border border-dashed border-[#1a2533] p-3 text-xs text-slate-600",
            ),
          ],
          ["Click an edge to edit its rule, or drag from a gesture handle to connect."],
        ),
      onSome: (rule) =>
        h.aside(
          [h.Class("space-y-3 rounded border border-[#1a2533] p-3")],
          [
            h.div([h.Class("font-mono text-xs text-slate-400")], [rule.id]),
            h.div([h.Class("text-xs text-slate-600")], [`when ${rule.when}`]),
            h.div(
              [h.Class("space-y-2")],
              [
                Ui.Select.view<Message>({
                  id: `canvas-rule-${rule.id}-surface`,
                  value: rule.surface,
                  onChange: (surface) => SelectedRuleSurface({ ruleId: rule.id, surface }),
                  toView: (attributes) =>
                    h.select(
                      [
                        ...attributes.select,
                        h.Class(
                          "w-full rounded border border-[#1a2533] bg-[#080e18] px-2 py-1.5 text-xs text-slate-300",
                        ),
                      ],
                      surfaceOptions(rule, model.controlSurfaces).map((surface) =>
                        h.option([h.Value(surface)], [surface]),
                      ),
                    ),
                }),
                Ui.Select.view<Message>({
                  id: `canvas-rule-${rule.id}-capability`,
                  value: rule.capability,
                  onChange: (capability) => SelectedRuleCapability({ ruleId: rule.id, capability }),
                  toView: (attributes) =>
                    h.select(
                      [
                        ...attributes.select,
                        h.Class(
                          "w-full rounded border border-[#1a2533] bg-[#080e18] px-2 py-1.5 text-xs text-slate-300",
                        ),
                      ],
                      capabilityOptions(rule, model.controlSurfaces).map((capability) =>
                        h.option([h.Value(capability)], [capability]),
                      ),
                    ),
                }),
              ],
            ),
            h.div(
              [h.Class("rounded bg-black/20 p-2 font-mono text-[11px] text-slate-600")],
              [fieldsText(rule)],
            ),
            ...pipe(
              selectedEdge(model),
              Option.match({
                onNone: () => [],
                onSome: (edge) => [
                  h.button(
                    [
                      h.Type("button"),
                      h.OnClick(DisconnectedGraphEdge({ edgeId: edge.id })),
                      h.Class(
                        "w-full rounded border border-[#1a2533] px-2 py-1.5 text-left text-xs text-slate-600 hover:border-red-900/60 hover:text-red-400",
                      ),
                    ],
                    ["Disconnect"],
                  ),
                ],
              }),
            ),
          ],
        ),
    }),
  );
};

const nodeBoardView = (model: Model): Html => {
  const h = html<Message>();
  return h.section(
    [h.Class("min-w-0 flex-1 rounded border border-[#1a2533] bg-[#0c1118] p-3")],
    [
      h.div(
        [h.Class("grid gap-3 xl:grid-cols-[minmax(0,1fr)_260px]")],
        [
          h.div(
            [
              h.OnMount(TrackGraphSurface()),
              h.Class(
                "relative overflow-auto rounded border border-[#1a2533] bg-[#080e18] bg-[radial-gradient(circle,#1a2535_1px,transparent_1px)] [background-size:20px_20px]",
              ),
            ],
            [
              h.div(
                [
                  h.Style({
                    width: `${GRAPH_SURFACE_WIDTH}px`,
                    height: `${GRAPH_SURFACE_HEIGHT}px`,
                  }),
                  h.Class("relative"),
                ],
                [
                  graphEdgeLayerView(model),
                  ...model.graphNodes.map((node) => graphNodeView(model, node)),
                  graphDragPreviewView(model),
                ],
              ),
            ],
          ),
          selectedRuleInspectorView(model),
        ],
      ),
    ],
  );
};

const nodeEditorView = (model: Model): Html => {
  const h = html<Message>();
  return h.div(
    [h.Class("flex w-full max-w-[1500px] flex-col gap-4 xl:flex-row")],
    [nodePaletteView(model), nodeBoardView(model)],
  );
};

const panelView = (model: Model): Html => {
  const h = html<Message>();
  return h.div(
    [
      h.Class(
        "w-full max-w-[640px] font-mono text-xs leading-relaxed text-[#93a4b8] whitespace-pre-wrap",
      ),
    ],
    [
      defsLine(model.defs),
      socketLine(model.socket, model.controlSurfaces),
      ...pipe(
        model.maybeFrameError,
        Option.match({
          onNone: () => [],
          onSome: (error) => [h.div([h.Class("text-red-400")], [`frame failed: ${error}`])],
        }),
      ),
      ...model.frame.statuses.map(statusLine),
    ],
  );
};

const stageView = (model: Model): Html => {
  const h = html<Message>();
  return h.div(
    [h.Class("relative w-[640px] h-[480px] rounded-xl overflow-hidden bg-black")],
    [
      h.video(
        [
          h.Id(VIDEO_ELEMENT_ID),
          h.Autoplay(true),
          h.Playsinline(true),
          h.Muted(true),
          h.Class("w-full h-full object-cover -scale-x-100"),
        ],
        [],
      ),
      Canvas.view<Message>({
        width: STAGE_WIDTH,
        height: STAGE_HEIGHT,
        shapes: sceneShapes(model.frame),
        className: "absolute inset-0",
      }),
    ],
  );
};

const contextMenuView = (model: Model): Html => {
  const h = html<Message>();
  return pipe(
    model.maybeContextMenu,
    Option.match({
      onNone: () => null,
      onSome: (menu) =>
        h.div(
          [h.Class("fixed inset-0 z-40")],
          [
            h.div([h.Class("absolute inset-0"), h.OnClick(ClosedContextMenu())], []),
            h.div(
              [
                h.Style({ left: `${menu.x}px`, top: `${menu.y}px` }),
                h.Class(
                  "absolute z-50 min-w-36 overflow-hidden rounded border border-[#1a2533] bg-[#0c1520] py-0.5 shadow-xl",
                ),
              ],
              M.value(menu as ContextMenuState).pipe(
                M.tagsExhaustive({
                  NodeContextMenu: ({ nodeId }) => [
                    h.button(
                      [
                        h.Type("button"),
                        h.OnClick(RemovedGraphNode({ nodeId })),
                        h.Class(
                          "w-full px-3 py-1.5 text-left text-xs text-slate-400 hover:bg-[#131e2e] hover:text-slate-200",
                        ),
                      ],
                      ["Remove node"],
                    ),
                  ],
                  EdgeContextMenu: ({ edgeId }) => [
                    h.button(
                      [
                        h.Type("button"),
                        h.OnClick(DisconnectedGraphEdge({ edgeId })),
                        h.Class(
                          "w-full px-3 py-1.5 text-left text-xs text-slate-400 hover:bg-[#131e2e] hover:text-slate-200",
                        ),
                      ],
                      ["Disconnect"],
                    ),
                  ],
                }),
              ),
            ),
          ],
        ),
    }),
  );
};

export const view = (model: Model): Document => {
  const h = html<Message>();
  return {
    title: "Gesture Lab",
    body: h.div(
      [h.Class("min-h-screen bg-[#0c1118] p-4 text-[#c8d3de] font-sans sm:p-6")],
      [
        h.header(
          [h.Class("mx-auto mb-4 flex w-full max-w-[1500px] items-center justify-between")],
          [
            h.span([h.Class("text-sm font-medium text-slate-400")], ["Gesture Lab"]),
            statusView(model),
          ],
        ),
        contextMenuView(model),
        h.main(
          [h.Class("mx-auto grid w-full max-w-[1500px] gap-4 2xl:grid-cols-[640px_minmax(0,1fr)]")],
          [
            h.section(
              [h.Class("flex flex-col items-start gap-3")],
              [
                stageView(model),
                panelView(model),
                h.div(
                  [h.Class("text-xs text-slate-600")],
                  [
                    "press ",
                    h.b([], ["r"]),
                    " or ",
                    h.button(
                      [h.OnClick(ClickedReloadDefs()), h.Class("underline cursor-pointer")],
                      ["reload"],
                    ),
                    " to reload gesture defs",
                  ],
                ),
              ],
            ),
            nodeEditorView(model),
          ],
        ),
      ],
    ),
  };
};
