// `minitart-app --render-marks <folder>`: draws each state of the mark, on a light and a dark
// menu bar, to PNGs, for the docs and pull requests. The app's own windows are not involved.

import AppKit
import MinitartCore

enum RenderMarks {
  static func run(into folder: String) {
    let marks: [(Mark, String, Int?)] = [
      (.idle, "idle", nil), (.busy, "busy-1", 1), (.busy, "busy-3", 3), (.busy, "busy-12", 12), (.busy, "busy-26", 26),
      (.attention, "attention", 2), (.paused, "paused", 1), (.off, "off", nil),
    ]
    for (scheme, background, ink) in [("light", NSColor(white: 0.93, alpha: 1), NSColor.black), ("dark", NSColor(white: 0.16, alpha: 1), NSColor.white)] {
      for (mark, name, count) in marks {
        let size = NSSize(width: 34, height: 24)
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 68, pixelsHigh: 48, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        background.setFill()
        NSRect(origin: .zero, size: size).fill()
        // A template image takes the bar's ink: tint it as macOS does.
        let image = MarkImage.make(mark, count: count)
        let tinted = NSImage(size: image.size, flipped: false) { rect in
          image.draw(in: rect)
          ink.set()
          rect.fill(using: .sourceAtop)
          return true
        }
        tinted.draw(in: NSRect(x: 8, y: 3, width: 18, height: 18))
        NSGraphicsContext.restoreGraphicsState()
        let url = URL(fileURLWithPath: folder).appendingPathComponent("mark-\(name)-\(scheme).png")
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
      }
    }
  }
}
