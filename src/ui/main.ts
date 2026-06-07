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
    id: "pinch.active.click",
    gesture: "pinch",
    when: "state == 'active' && previousState != 'active' && hands.count == 1",
    surface: "mac",
    capability: "click",
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
      SelectedRuleCapability: ({ ruleId, capability }) => [
        evo(model, {
          rules: () =>
            model.rules.map((rule) => {
              if (rule.id !== ruleId) {
                return rule;
              }
              return { ...rule, capability };
            }),
        }),
        [],
      ],
      SelectedRuleSurface: ({ ruleId, surface }) => [
        evo(model, {
          rules: () =>
            model.rules.map((rule) => {
              if (rule.id !== ruleId) {
                return rule;
              }
              return {
                ...rule,
                surface,
                capability: pipe(
                  firstCapabilityForSurface(model.controlSurfaces, surface),
                  Option.getOrElse(() => rule.capability),
                ),
              };
            }),
        }),
        [],
      ],
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
      LoadingModels: () => "Loading models…",
      StartingCamera: () => "Requesting camera…",
      AttachingCamera: () => "Starting video…",
      Tracking: () => trackingStatusText(model.frame),
      FailedTracker: ({ message }) => `Error: ${message}`,
    }),
  );
  const isActive = model.frame.statuses.some(
    (status) => status.state !== "idle" && Option.isNone(status.maybeError),
  );
  return h.div(
    [
      h.Class(
        isActive
          ? "px-3.5 py-1.5 rounded-full text-sm bg-green-900"
          : "px-3.5 py-1.5 rounded-full text-sm bg-[#1c2633]",
      ),
    ],
    [text],
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

const ruleLine = (rule: GestureRule, surfaces: ReadonlyArray<ControlSurface>): Html => {
  const h = html<Message>();
  return h.div(
    [h.Class("flex items-center gap-2")],
    [
      h.span([h.Class("min-w-[190px]")], [`${rule.gesture}: ${rule.when}`]),
      Ui.Select.view<Message>({
        id: `rule-${rule.id}-surface`,
        value: rule.surface,
        onChange: (surface) => SelectedRuleSurface({ ruleId: rule.id, surface }),
        toView: (attributes) =>
          h.select(
            [
              ...attributes.select,
              h.Class("bg-[#111927] border border-[#293548] rounded px-2 py-0.5"),
            ],
            surfaceOptions(rule, surfaces).map((surface) =>
              h.option([h.Value(surface)], [surface]),
            ),
          ),
      }),
      Ui.Select.view<Message>({
        id: `rule-${rule.id}-capability`,
        value: rule.capability,
        onChange: (capability) => SelectedRuleCapability({ ruleId: rule.id, capability }),
        toView: (attributes) =>
          h.select(
            [
              ...attributes.select,
              h.Class("bg-[#111927] border border-[#293548] rounded px-2 py-0.5"),
            ],
            capabilityOptions(rule, surfaces).map((capability) =>
              h.option([h.Value(capability)], [capability]),
            ),
          ),
      }),
      h.span([h.Class("text-slate-500")], [`${fieldsText(rule)}`]),
    ],
  );
};

const rulesView = (model: Model): Html => {
  const h = html<Message>();
  return h.div(
    [h.Class("mt-2 space-y-1")],
    [
      h.div([h.Class("text-slate-400")], ["gesture rules"]),
      ...model.rules.map((rule) => ruleLine(rule, model.controlSurfaces)),
    ],
  );
};

const panelView = (model: Model): Html => {
  const h = html<Message>();
  return h.div(
    [h.Class("w-[640px] font-mono text-xs leading-relaxed text-[#93a4b8] whitespace-pre-wrap")],
    [
      defsLine(model.defs),
      socketLine(model.socket, model.controlSurfaces),
      rulesView(model),
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

export const view = (model: Model): Document => {
  const h = html<Message>();
  return {
    title: "Gesture Lab",
    body: h.div(
      [
        h.Class(
          "min-h-screen flex flex-col items-center gap-3 p-6 bg-[#0c1118] text-[#e7edf4] font-sans",
        ),
      ],
      [
        h.h1([h.Class("text-lg font-semibold")], ["Gesture Lab"]),
        stageView(model),
        statusView(model),
        panelView(model),
        h.div(
          [h.Class("text-xs text-slate-500")],
          [
            "press ",
            h.b([], ["r"]),
            " or ",
            h.button(
              [h.OnClick(ClickedReloadDefs()), h.Class("underline cursor-pointer")],
              ["reload"],
            ),
            " to reload gesture definitions",
          ],
        ),
      ],
    ),
  };
};
