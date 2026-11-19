// The mark in the menu bar, drawn in code as a template image so that macOS colours it like
// every other menu bar icon: the cup and ball of minitart's icon, filled when busy, outlined
// when idle, faint when minitart is not there. In the ball's place, an exclamation mark when
// the owner is needed and a pause sign when draining.

import AppKit
import MinitartCore

enum MarkImage {
  static func make(_ mark: Mark) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
      let scale: CGFloat = 18 / 32
      let transform = NSAffineTransform()
      transform.scale(by: scale)
      transform.concat()
      let alpha: CGFloat = mark == .off ? 0.35 : 1
      NSColor.black.withAlphaComponent(alpha).set()

      // The cup: wide at its rim, narrower and rounded at its foot.
      let cup = NSBezierPath()
      cup.move(to: NSPoint(x: 5, y: 14))
      cup.line(to: NSPoint(x: 27, y: 14))
      cup.line(to: NSPoint(x: 24, y: 24.4))
      cup.curve(to: NSPoint(x: 21.4, y: 26.5), controlPoint1: NSPoint(x: 23.6, y: 25.7), controlPoint2: NSPoint(x: 22.6, y: 26.5))
      cup.line(to: NSPoint(x: 10.6, y: 26.5))
      cup.curve(to: NSPoint(x: 8, y: 24.4), controlPoint1: NSPoint(x: 9.4, y: 26.5), controlPoint2: NSPoint(x: 8.4, y: 25.7))
      cup.close()
      let rim = NSBezierPath(roundedRect: NSRect(x: 3, y: 10.5, width: 26, height: 3.5), xRadius: 1.75, yRadius: 1.75)
      let ball = NSBezierPath(ovalIn: NSRect(x: 13, y: 3, width: 6, height: 6))

      // The ball's place says the state: the ball, an exclamation mark when the owner is
      // needed, or a pause sign when draining.
      let filled = mark == .busy || mark == .attention
      if filled {
        cup.fill()
      } else {
        cup.lineWidth = 2.2
        cup.stroke()
      }
      rim.fill()
      switch mark {
      case .attention:
        NSBezierPath(roundedRect: NSRect(x: 14.2, y: 0, width: 3.6, height: 6.2), xRadius: 1.8, yRadius: 1.8).fill()
        NSBezierPath(ovalIn: NSRect(x: 14.2, y: 6.9, width: 3.6, height: 3.6)).fill()
      case .paused:
        NSBezierPath(roundedRect: NSRect(x: 12.4, y: 1.5, width: 2.8, height: 7.5), xRadius: 1, yRadius: 1).fill()
        NSBezierPath(roundedRect: NSRect(x: 16.8, y: 1.5, width: 2.8, height: 7.5), xRadius: 1, yRadius: 1).fill()
      case .busy:
        ball.fill()
      case .idle, .off:
        ball.lineWidth = 2
        ball.stroke()
      }
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = description(mark)
    return image
  }

  static func description(_ mark: Mark) -> String {
    switch mark {
    case .idle: return "minitart: idle"
    case .busy: return "minitart: running jobs"
    case .attention: return "minitart: needs you"
    case .paused: return "minitart: draining"
    case .off: return "minitart: not running"
    }
  }
}
