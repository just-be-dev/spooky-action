import { Array, Option, Order, Schema as S, pipe } from "effect";

export const LandmarkPoint = S.Struct({
  x: S.Number,
  y: S.Number,
  z: S.optional(S.Number),
});
export type LandmarkPoint = typeof LandmarkPoint.Type;

export const TrackedAnchor = S.Struct({
  id: S.Number,
  anchor: LandmarkPoint,
});
export type TrackedAnchor = typeof TrackedAnchor.Type;

export const TrackState = S.Struct({
  tracked: S.Array(TrackedAnchor),
  nextId: S.Number,
});
export type TrackState = typeof TrackState.Type;

export const initialTrackState: TrackState = { tracked: [], nextId: 1 };

const MATCH_DISTANCE = 0.25;

const distance = (a: LandmarkPoint, b: LandmarkPoint): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

type MatchAccumulator = Readonly<{
  tracked: ReadonlyArray<TrackedAnchor>;
  remaining: ReadonlyArray<TrackedAnchor>;
  nextId: number;
}>;

/**
 * Match this frame's anchors (wrists, nose tips) to last frame's tracked
 * entities by nearest neighbor, preserving IDs. Unmatched anchors get fresh
 * IDs; unmatched previous entities are dropped.
 */
export const matchTracked = (
  previous: TrackState,
  anchors: ReadonlyArray<LandmarkPoint>,
): TrackState => {
  const matched = Array.reduce(
    anchors,
    {
      tracked: [],
      remaining: previous.tracked,
      nextId: previous.nextId,
    } as MatchAccumulator,
    (accumulator, anchor) =>
      pipe(
        accumulator.remaining,
        Array.map((candidate, index) => ({
          index,
          dist: distance(candidate.anchor, anchor),
        })),
        Array.filter(({ dist }) => dist < MATCH_DISTANCE),
        Array.sortWith(({ dist }) => dist, Order.Number),
        Array.head,
        Option.match({
          onNone: () => ({
            tracked: [
              ...accumulator.tracked,
              { id: accumulator.nextId, anchor },
            ],
            remaining: accumulator.remaining,
            nextId: accumulator.nextId + 1,
          }),
          onSome: ({ index }) => ({
            tracked: [
              ...accumulator.tracked,
              {
                id: pipe(
                  Array.get(accumulator.remaining, index),
                  Option.map((match) => match.id),
                  Option.getOrElse(() => accumulator.nextId),
                ),
                anchor,
              },
            ],
            remaining: Array.remove(accumulator.remaining, index),
            nextId: accumulator.nextId,
          }),
        }),
      ),
  );
  return { tracked: matched.tracked, nextId: matched.nextId };
};

/**
 * Mirror x so entity coords match the mirrored video display (and the
 * screen). Landmarks are mirrored exactly once, at ingestion; handedness
 * labels are never swapped.
 */
export const mirror = (
  landmarks: ReadonlyArray<LandmarkPoint>,
): Array<LandmarkPoint> =>
  landmarks.map((point) => ({ x: 1 - point.x, y: point.y, z: point.z }));

/** Landmark lookup by named index that tolerates missing entries. */
export const landmarkAt = (
  landmarks: ReadonlyArray<LandmarkPoint>,
  nullableIndex: number | undefined,
): LandmarkPoint =>
  pipe(
    Option.fromNullishOr(nullableIndex),
    Option.flatMap((index) => Array.get(landmarks, index)),
    Option.getOrElse(() => ({ x: 0, y: 0 })),
  );
