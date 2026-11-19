// The mark in the menu bar, drawn in code as a template image so that macOS colours it like
// every other menu bar icon: the cup and ball of minitart's icon. Filled when jobs run, with
// their number cut out of the cup; outlined when idle; faint when minitart is not there. In
// the ball's place, an exclamation mark when the owner is needed, and a pause sign when
// draining (D26).

import AppKit
import MinitartCore

enum MarkImage {
  static func make(_ mark: Mark, count: Int? = nil) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
      let alpha: CGFloat = mark == .off ? 0.35 : 1
      let ink = NSColor.black.withAlphaComponent(alpha)
      ink.set()

      // In points, the cup as large as the bar allows: its rim across the whole width, its
      // body below, room above for the ball or a sign.
      let rim = NSBezierPath(roundedRect: NSRect(x: 0.5, y: 5.6, width: 17, height: 2.2), xRadius: 1.1, yRadius: 1.1)
      let cup = NSBezierPath()
      cup.move(to: NSPoint(x: 1.6, y: 7.6))
      cup.line(to: NSPoint(x: 16.4, y: 7.6))
      cup.line(to: NSPoint(x: 14.6, y: 15.9))
      cup.curve(to: NSPoint(x: 13.0, y: 17.4), controlPoint1: NSPoint(x: 14.4, y: 16.8), controlPoint2: NSPoint(x: 13.8, y: 17.4))
      cup.line(to: NSPoint(x: 5.0, y: 17.4))
      cup.curve(to: NSPoint(x: 3.4, y: 15.9), controlPoint1: NSPoint(x: 4.2, y: 17.4), controlPoint2: NSPoint(x: 3.6, y: 16.8))
      cup.close()
      let ball = NSBezierPath(ovalIn: NSRect(x: 6.9, y: 0.6, width: 4.2, height: 4.2))

      let filled = mark == .busy || mark == .attention
      if filled {
        cup.fill()
      } else {
        cup.lineWidth = 1.4
        cup.stroke()
      }
      rim.fill()

      switch mark {
      case .attention:
        NSBezierPath(roundedRect: NSRect(x: 8.05, y: 0, width: 1.9, height: 3.1), xRadius: 0.95, yRadius: 0.95).fill()
        NSBezierPath(ovalIn: NSRect(x: 8.05, y: 3.5, width: 1.9, height: 1.9)).fill()
      case .paused:
        NSBezierPath(roundedRect: NSRect(x: 6.9, y: 0.5, width: 1.6, height: 4.3), xRadius: 0.6, yRadius: 0.6).fill()
        NSBezierPath(roundedRect: NSRect(x: 9.5, y: 0.5, width: 1.6, height: 4.3), xRadius: 0.6, yRadius: 0.6).fill()
      case .busy:
        ball.fill()
      case .idle, .off:
        ball.lineWidth = 1.2
        ball.stroke()
      }

      if let count, count > 0, mark != .off {
        // The number inside the cup: cut out of a filled cup, drawn in ink in an outlined one.
        let text = count > 99 ? "99" : String(count)
        let size: CGFloat = text.count > 1 ? 7.6 : 8.6
        let font = NSFont.monospacedDigitSystemFont(ofSize: size, weight: .heavy)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink, .kern: text.count > 1 ? -0.5 : 0]
        let string = NSAttributedString(string: text, attributes: attributes)
        let bounds = string.size()
        let origin = NSPoint(x: 9 - bounds.width / 2, y: 12.4 - bounds.height / 2)
        if filled {
          NSGraphicsContext.current?.compositingOperation = .destinationOut
        }
        string.draw(at: origin)
        NSGraphicsContext.current?.compositingOperation = .sourceOver
      }
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = description(mark, count: count)
    return image
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
