// Transparent click-through overlay + synthetic clicks for the gesture lab.
// Supports multiple named rings so several gesture instances (two hands,
// a face gesture, …) can each draw their own. Commands on stdin, one per line:
//   circle <id> <nx> <ny> <r>   show/update ring <id> at normalized coords, radius px
//   hide <id>                   hide ring <id>
//   hideall                     hide every ring
//   click <nx> <ny>             post a left click at normalized coords (and flash)
import AppKit

struct Ring {
  var point: CGPoint  // view coords (bottom-left origin)
  var radius: CGFloat
}

final class RingView: NSView {
  var rings: [String: Ring] = [:]
  var flash: CGPoint?  // click feedback, cleared shortly after

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    for ring in rings.values {
      let color = NSColor.systemGreen
      ctx.setStrokeColor(color.withAlphaComponent(0.9).cgColor)
      ctx.setFillColor(color.withAlphaComponent(0.15).cgColor)
      ctx.setLineWidth(3)
      let rect = CGRect(
        x: ring.point.x - ring.radius, y: ring.point.y - ring.radius,
        width: ring.radius * 2, height: ring.radius * 2
      )
      ctx.fillEllipse(in: rect)
      ctx.strokeEllipse(in: rect)
    }
    if let p = flash {
      ctx.setStrokeColor(NSColor.systemYellow.withAlphaComponent(0.9).cgColor)
      ctx.setLineWidth(4)
      ctx.strokeEllipse(in: CGRect(x: p.x - 20, y: p.y - 20, width: 40, height: 40))
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

guard let screen = NSScreen.main else { exit(1) }
let frame = screen.frame

let window = NSWindow(
  contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
window.isOpaque = false
window.backgroundColor = .clear
window.hasShadow = false
window.level = .screenSaver
window.ignoresMouseEvents = true
window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
let view = RingView(frame: NSRect(origin: .zero, size: frame.size))
window.contentView = view
window.orderFrontRegardless()

func click(at p: CGPoint) {
  // p in Quartz global coords (top-left origin)
  for type in [CGEventType.leftMouseDown, .leftMouseUp] {
    CGEvent(
      mouseEventSource: nil, mouseType: type,
      mouseCursorPosition: p, mouseButton: .left
    )?.post(tap: .cghidEventTap)
  }
}

DispatchQueue.global().async {
  while let line = readLine() {
    let parts = line.split(separator: " ")
    guard let cmd = parts.first else { continue }
    DispatchQueue.main.async {
      switch cmd {
      case "circle":
        guard parts.count == 5,
          let nx = Double(parts[2]), let ny = Double(parts[3]),
          let r = Double(parts[4])
        else { return }
        let id = String(parts[1])
        // AppKit view coords: bottom-left origin, so flip y
        view.rings[id] = Ring(
          point: CGPoint(x: frame.width * nx, y: frame.height * (1 - ny)),
          radius: CGFloat(r)
        )
        view.needsDisplay = true
      case "hide":
        guard parts.count == 2 else { return }
        view.rings.removeValue(forKey: String(parts[1]))
        view.needsDisplay = true
      case "hideall":
        view.rings.removeAll()
        view.needsDisplay = true
      case "click":
        guard parts.count == 3,
          let nx = Double(parts[1]), let ny = Double(parts[2])
        else { return }
        view.flash = CGPoint(x: frame.width * nx, y: frame.height * (1 - ny))
        view.needsDisplay = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
          view.flash = nil
          view.needsDisplay = true
        }
        // Quartz global coords: top-left origin, no flip
        click(at: CGPoint(x: frame.width * nx, y: frame.height * ny))
      default:
        break
      }
    }
  }
  // stdin closed — parent died, shut down
  DispatchQueue.main.async { app.terminate(nil) }
}

app.run()
