# collabspace

Gesture-driven distance collaboration experiments. Detection runs in the
browser (MediaPipe), a Bun server bridges events to a native macOS overlay.

## Layout

- `src/gestures/` — the gesture lab: data-driven gestures (JSON defs +
  expression engine). The canonical app.
- `src/pointer/` — earlier pinch-to-click pointer prototype.
- `src/demo/` — original in-browser pinch detector demo (no overlay).
- `src/control/` — native macOS side: the Swift overlay (rings + synthetic
  clicks) shared by gestures and pointer, compiled automatically on first run.

## Run

```bash
bun install
bun --hot src/gestures/main.ts   # gesture lab → http://localhost:7900
bun src/pointer/main.ts          # pinch pointer → http://localhost:7900
bun src/demo/index.ts            # browser-only demo → http://localhost:7777
```

This project was created using `bun init` in bun v1.3.1. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
