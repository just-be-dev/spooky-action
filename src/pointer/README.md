# Pinch Pointer

Control your Mac from a distance: pinch in front of the camera to click.
A ring appears on screen as your thumb and index finger come together,
shrinks as they close, and completing the pinch posts a real click at the
ring's position. Clicks only fire when exactly one hand is in view.

## Run

```sh
bun src/pointer/main.ts
```

Then open http://localhost:7900 and grant camera access. Keep that tab
open — it does the hand tracking and streams pinch state to the server,
which drives a native transparent overlay (`src/control/overlay.swift`,
shared with the gesture lab and compiled automatically on first run).

## Permissions

- **Camera** — the browser asks on first load.
- **Accessibility** — required for synthetic clicks. Grant it to your
  terminal app (whatever launched `bun`): System Settings → Privacy &
  Security → Accessibility. The ring still renders without it; only
  clicks need it.

## Tuning (tracker.ts)

- `SHOW` / `CLICK` / `REARM` — pinch thresholds (relative to hand size)
- `R_MIN` / `R_MAX` — on-screen ring radius range
- `SMOOTH` — pointer smoothing (higher = snappier, lower = steadier)
