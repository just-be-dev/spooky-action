// Transparent click-through overlay + synthetic clicks for the pinch pointer.
// Reads commands on stdin, one per line:
//   circle <nx> <ny> <r>   show ring at normalized (top-left origin) coords, radius in px
//   hide                   hide the ring
//   click <nx> <ny>        post a left click at normalized coords
import AppKit

final class RingView: NSView {
  var point = CGPoint.zero // view coords (bottom-left origin)
  var radius: CGFloat = 0
  var visible = false
  var flash = false

  override func draw(_ dirtyRect: NSRect) {
    guard visible, let ctx = NSGraphicsContext.current?.cgContext else { return }
    let color = flash ? NSColor.systemYellow : NSColor.systemGreen
    ctx.setStrokeColor(color.withAlphaComponent(0.9).cgColor)
    ctx.setFillColor(color.withAlphaComponent(0.15).cgColor)
    ctx.setLineWidth(3)
    let rect = CGRect(
      x: point.x - radius, y: point.y - radius,
      width: radius * 2, height: radius * 2
    )
    ctx.fillEllipse(in: rect)
    ctx.strokeEllipse(in: rect)
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
        guard parts.count == 4,
          let nx = Double(parts[1]), let ny = Double(parts[2]),
          let r = Double(parts[3])
        else { return }
        view.point = CGPoint(x: frame.width * nx, y: frame.height * (1 - ny))
        view.radius = CGFloat(r)
        view.flash = false
        view.visible = true
        view.needsDisplay = true
      case "hide":
        view.visible = false
        view.needsDisplay = true
      case "click":
        guard parts.count == 3,
          let nx = Double(parts[1]), let ny = Double(parts[2])
        else { return }
        view.flash = true
        view.needsDisplay = true
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
