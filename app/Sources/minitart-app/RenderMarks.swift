// `minitart-app --render-marks <folder>`: draws each state of the mark, on a light and a dark
// menu bar, to PNGs, for the docs and pull requests. The app's own windows are not involved.

import AppKit
import MinitartCore

enum RenderMarks {
  static func run(into folder: String) {
    let marks: [(Mark, String, Int?)] = [
      (.idle, "idle", nil), (.busy, "busy", 3), (.attention, "attention", 2), (.paused, "paused", 1), (.off, "off", nil),
    ]
    for (scheme, background, ink) in [("light", NSColor(white: 0.93, alpha: 1), NSColor.black), ("dark", NSColor(white: 0.16, alpha: 1), NSColor.white)] {
      for (mark, name, count) in marks {
        let text = count.map { NSAttributedString(string: " \($0)", attributes: [.font: NSFont.menuBarFont(ofSize: 0), .foregroundColor: ink]) }
        let width = 18 + (text?.size().width ?? 0) + 16
        let size = NSSize(width: width, height: 24)
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * 2), pixelsHigh: 48, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        background.setFill()
        NSRect(origin: .zero, size: size).fill()
        // A template image takes the bar's ink: tint it as macOS does.
        let image = MarkImage.make(mark)
        let tinted = NSImage(size: image.size, flipped: false) { rect in
          image.draw(in: rect)
          ink.set()
          rect.fill(using: .sourceAtop)
          return true
        }
        tinted.draw(in: NSRect(x: 8, y: 3, width: 18, height: 18))
        text?.draw(at: NSPoint(x: 26, y: 4))
        NSGraphicsContext.restoreGraphicsState()
        let url = URL(fileURLWithPath: folder).appendingPathComponent("mark-\(name)-\(scheme).png")
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
      }
    }
  }
}
