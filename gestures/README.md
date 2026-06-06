# Gesture Lab

Data-driven gesture system. Detection runs in the browser (MediaPipe hands +
faces, multiple people, persistent entity IDs), gestures are **declarative
JSON** evaluated by a small engine, and emitted events go over WebSocket to a
Bun server that drives a native macOS overlay (rings + real clicks).

```
camera → tracker.ts → engine.ts (defs/*.json) → WS → main.ts → overlay.swift → macOS
```

## Run

```sh
bun --hot gestures/main.ts   # http://localhost:7900
```

Clicking requires Accessibility permission for your terminal app.

## Gesture definitions (`defs/*.json`)

A gesture binds to every tracked entity of its `source` type — each hand or
face runs its own state-machine instance. Edit a def and press **r** in the
page to hot-reload (no restart needed).

```jsonc
{
  "name": "pinch-click",
  "source": "hand",                  // "hand" | "face"
  "metrics": {
    // computed every frame, in order; later metrics can reference earlier ones
    "pinch": "dist(thumb_tip, index_tip) / dist(wrist, middle_mcp)",
    // wrap in { expr, smooth } for EMA smoothing (0..1, higher = snappier)
    "pos": { "expr": "mid(thumb_tip, index_tip)", "smooth": 0.4 }
  },
  "initial": "idle",                 // defaults to the first state
  "states": {
    "idle":  { "on": [{ "if": "pinch < 0.9", "goto": "track" }] },
    "track": {
      // continuous emit: sent every frame while in this state
      "emit": { "type": "circle", "x": "pos.x", "y": "pos.y",
                "r": "lerp(pinch, 0.35, 0.9, 8, 64)" },
      "on": [
        // transitions checked in order, at most one fires per frame
        { "if": "pinch < 0.35 && hands.count == 1", "goto": "fired",
          "emit": { "type": "click", "x": "pos.x", "y": "pos.y" } },
        { "if": "pinch > 0.9", "goto": "idle", "emit": { "type": "hide" } }
      ]
    },
    "fired": { "on": [{ "if": "pinch > 0.5", "goto": "track" }] }
  },
  "onLost": { "emit": { "type": "hide" } }  // entity left the frame
}
```

Hysteresis (e.g. click at < 0.35, re-arm at > 0.5) falls out of the state
machine naturally — no special support needed.

## Expression language

Plain strings, parsed by a tiny evaluator (no `eval`). Available:

- **Operators**: `+ - * / %`, `< > <= >= == !=`, `&& || !`, parentheses
- **Literals**: numbers (`0.35`), `'single-quoted strings'`
- **Landmarks**: named points for the entity (see `landmarks.ts`), e.g.
  `thumb_tip`, `wrist`, `nose_tip`, `chin` — or any index via `lm(152)`.
  Points have `.x` and `.y`. Coordinates are normalized 0..1, **already
  mirrored** to match the on-screen view.
- **Metrics**: reference earlier metrics by name
- **Globals**: `hands.count`, `faces.count`
- **Functions**: `dist(a, b)`, `mid(a, b)`, `angle(a, b)` (degrees),
  `lerp(v, inMin, inMax, outMin, outMax)` (clamped), `clamp(v, lo, hi)`,
  `abs min max floor round`, `point(x, y)`

## Emits → wire protocol → overlay

Emit objects are sent verbatim over the WebSocket, with `type` literal and
every other string field evaluated as an expression. The engine adds an
`id` (`gesture#entityId`) so multiple instances don't fight over overlay
state. The server maps types to overlay commands:

| wire message                | overlay command          | effect                       |
| --------------------------- | ------------------------ | ---------------------------- |
| `{type:"circle", x, y, r}`  | `circle <id> <x> <y> <r>`| show/update ring `id`        |
| `{type:"hide"}`             | `hide <id>`              | remove ring `id`             |
| `{type:"hideall"}`          | `hideall`                | remove all rings             |
| `{type:"click", x, y}`      | `click <x> <y>`          | real left click + flash      |

New OS-side capabilities = add a wire type in `main.ts` + a stdin command in
`overlay.swift`; gestures can then emit it from data with no engine changes.

## Testing

The engine is pure (no DOM/MediaPipe), so defs are testable:

```sh
bun test gestures/
```

`engine.test.ts` runs the real `pinch-click.json` through synthetic frames
(track → click → re-arm → hide → lost).
