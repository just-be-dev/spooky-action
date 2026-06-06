// Named landmark indices, exposed to gesture expressions as identifiers.
// Hand: https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
// Face: 478-point mesh — only the commonly useful points are named here;
// any other index is reachable in expressions via lm(<index>).

export const HAND_LANDMARKS: Record<string, number> = {
  wrist: 0,
  thumb_cmc: 1,
  thumb_mcp: 2,
  thumb_ip: 3,
  thumb_tip: 4,
  index_mcp: 5,
  index_pip: 6,
  index_dip: 7,
  index_tip: 8,
  middle_mcp: 9,
  middle_pip: 10,
  middle_dip: 11,
  middle_tip: 12,
  ring_mcp: 13,
  ring_pip: 14,
  ring_dip: 15,
  ring_tip: 16,
  pinky_mcp: 17,
  pinky_pip: 18,
  pinky_dip: 19,
  pinky_tip: 20,
};

export const FACE_LANDMARKS: Record<string, number> = {
  nose_tip: 1,
  forehead: 10,
  chin: 152,
  left_eye_outer: 33,
  right_eye_outer: 263,
  left_eye_top: 159,
  left_eye_bottom: 145,
  right_eye_top: 386,
  right_eye_bottom: 374,
  face_left: 234,
  face_right: 454,
  mouth_left: 61,
  mouth_right: 291,
  upper_lip: 13,
  lower_lip: 14,
};
