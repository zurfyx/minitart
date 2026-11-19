// The mark in the menu bar, drawn in code as a template image so that macOS colours it like
// every other menu bar icon: minitart's Mac mini with a screen rising from it. The screen
// says how things are: a prompt when idle, filled with the number of jobs cut out of it when
// jobs run, an exclamation mark when the owner is needed, a pause sign when draining. Faint
// when minitart is not there (D26).

import AppKit
import MinitartCore

enum MarkImage {
  static func make(_ mark: Mark, count: Int? = nil) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
      let alpha: CGFloat = mark == .off ? 0.35 : 1
      let ink = NSColor.black.withAlphaComponent(alpha)
      ink.set()

      // In points: the screen as large as the bar allows, the Mac a slab under it, a gap
      // between the two.
      let screen = NSRect(x: 1.69, y: 0.45, width: 14.63, height: 10.35)
      let base = NSBezierPath(roundedRect: NSRect(x: 0.56, y: 12.49, width: 16.88, height: 4.95), xRadius: 1.69, yRadius: 1.69)
      let centre = NSPoint(x: 9, y: screen.midY + 0.05)

      switch mark {
      case .busy, .attention:
        NSBezierPath(roundedRect: screen, xRadius: 2.03, yRadius: 2.03).fill()
        NSGraphicsContext.current?.compositingOperation = .destinationOut
        if mark == .attention {
          write("!", at: centre, size: 8.6, ink: ink)
        } else if let count, count > 0 {
          let text = count > 99 ? "99" : String(count)
          write(text, at: centre, size: text.count > 1 ? 7.6 : 8.6, ink: ink)
        } else {
          prompt(at: centre)
        }
        NSGraphicsContext.current?.compositingOperation = .sourceOver
      case .idle, .paused, .off:
        let frame = NSBezierPath(roundedRect: screen.insetBy(dx: 0.73, dy: 0.73), xRadius: 1.46, yRadius: 1.46)
        frame.lineWidth = 1.46
        frame.stroke()
        if mark == .paused {
          NSBezierPath(roundedRect: NSRect(x: 6.53, y: 2.93, width: 1.69, height: 5.4), xRadius: 0.68, yRadius: 0.68).fill()
          NSBezierPath(roundedRect: NSRect(x: 9.79, y: 2.93, width: 1.69, height: 5.4), xRadius: 0.68, yRadius: 0.68).fill()
        } else {
          prompt(at: centre)
        }
      }
      base.fill()
      // The Mac's status light, cut out of it: what makes the slab a Mac mini.
      NSGraphicsContext.current?.compositingOperation = .destinationOut
      NSBezierPath(roundedRect: NSRect(x: 11.9, y: 14.42, width: 2.9, height: 1.1), xRadius: 0.55, yRadius: 0.55).fill()
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = description(mark, count: count)
    return image
  }

  /// `>_`, centred on a point, drawn with the current colour and compositing.
  private static func prompt(at centre: NSPoint) {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: centre.x - 2.32, y: centre.y - 1.48))
    path.line(to: NSPoint(x: centre.x - 0.63, y: centre.y))
    path.line(to: NSPoint(x: centre.x - 2.32, y: centre.y + 1.48))
    path.move(to: NSPoint(x: centre.x + 0.42, y: centre.y + 1.48))
    path.line(to: NSPoint(x: centre.x + 2.39, y: centre.y + 1.48))
    path.lineWidth = 1.3
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    path.stroke()
  }

  /// Text centred on a point, heavy, its digits all one width.
  private static func write(_ text: String, at centre: NSPoint, size: CGFloat, ink: NSColor) {
    let font = NSFont.monospacedDigitSystemFont(ofSize: size, weight: .heavy)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink, .kern: text.count > 1 ? -0.5 : 0]
    let string = NSAttributedString(string: text, attributes: attributes)
    let bounds = string.size()
    string.draw(at: NSPoint(x: centre.x - bounds.width / 2, y: centre.y - bounds.height / 2))
  }

  static func description(_ mark: Mark, count: Int?) -> String {
    let jobs = count.map { ", \($0) \($0 == 1 ? "job" : "jobs") running" } ?? ""
    switch mark {
    case .idle: return "minitart: idle"
    case .busy: return "minitart\(jobs)"
    case .attention: return "minitart needs you\(jobs)"
    case .paused: return "minitart: draining\(jobs)"
    case .off: return "minitart: not running"
    }
  }
}
