// Watches the minitart on this Mac (D26): its dashboard every few seconds, and when that does
// not answer, whether minitart is installed and its service loaded. Every action goes through
// what minitart already offers: its dashboard, `brew services`, and `minitart doctor --fix`
// in Terminal for the steps that need the Mac's password.

import AppKit
import Foundation
import MinitartCore
import ServiceManagement

@MainActor
final class Model: ObservableObject {
  /// This Mac's dashboard. A different one can be set for trying the app against a demo:
  /// `defaults write sh.rovira.minitart.app dashboard http://127.0.0.1:4199/`.
  static let dashboard: URL = {
    if let set = UserDefaults.standard.string(forKey: "dashboard"), let url = URL(string: set),
      url.host == "127.0.0.1" || url.host == "localhost"
    {
      return url
    }
    return URL(string: "http://127.0.0.1:4141/")!
  }()

  @Published private(set) var condition: Condition = .unreachable
  private var timer: Timer?

  init() {
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refresh() }
    }
  }

  func refresh() {
    var request = URLRequest(url: Self.dashboard.appendingPathComponent("api/state"))
    request.timeoutInterval = 2.5
    URLSession.shared.dataTask(with: request) { data, response, _ in
      let ok = (response as? HTTPURLResponse)?.statusCode == 200
      let state = ok ? data.flatMap { try? State.decode($0) } : nil
      Task { @MainActor in
        if let state {
          self.condition = isAtLeast(state.version) ? .running(state) : .tooOld(version: state.version ?? "an older version")
        } else {
          self.condition = Installation.minitart() == nil ? .notInstalled : (Installation.serviceLoaded() ? .unreachable : .notRunning)
        }
      }
    }.resume()
  }

  // Actions

  func openDashboard() { NSWorkspace.shared.open(Self.dashboard) }

  func open(_ url: String) {
    if let url = URL(string: url) { NSWorkspace.shared.open(url) }
  }

  func setDraining(_ draining: Bool) {
    var request = URLRequest(url: Self.dashboard.appendingPathComponent("api/drain"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    // The dashboard takes changes only from its own origin.
    let origin = "\(Self.dashboard.scheme ?? "http")://\(Self.dashboard.host ?? "127.0.0.1"):\(Self.dashboard.port ?? 4141)"
    request.setValue(origin, forHTTPHeaderField: "Origin")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["draining": draining])
    URLSession.shared.dataTask(with: request) { _, _, _ in
      Task { @MainActor in self.refresh() }
    }.resume()
  }

  func startService() {
    Installation.run(Installation.brew(), ["services", "start", "zurfyx/tap/minitart"]) {
      Task { @MainActor in self.refresh() }
    }
  }

  /// The steps that need the Mac's password run in Terminal, where the owner types it.
  func finishSetup() { Terminal.run("minitart doctor --fix", named: "minitart setup") }

  func installMinitart() {
    Terminal.run("brew install zurfyx/tap/minitart && minitart doctor --fix", named: "minitart install")
  }

  func copy(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  var opensAtLogin: Bool {
    get { SMAppService.mainApp.status == .enabled }
    set {
      try? newValue ? SMAppService.mainApp.register() : SMAppService.mainApp.unregister()
      objectWillChange.send()
    }
  }
}

enum Installation {
  /// The `minitart` command, where Homebrew puts it.
  static func minitart() -> String? {
    ["/opt/homebrew/bin/minitart", "/usr/local/bin/minitart"].first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  static func brew() -> String {
    ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/opt/homebrew/bin/brew"
  }

  /// Whether minitart's service is loaded in this login session: Homebrew's, or the one
  /// `minitart service install` makes.
  static func serviceLoaded() -> Bool {
    let session = "gui/\(getuid())"
    return ["sh.brew.minitart", "homebrew.mxcl.minitart", "sh.rovira.minitart"].contains { label in
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
      process.arguments = ["print", "\(session)/\(label)"]
      process.standardOutput = FileHandle.nullDevice
      process.standardError = FileHandle.nullDevice
      guard (try? process.run()) != nil else { return false }
      process.waitUntilExit()
      return process.terminationStatus == 0
    }
  }

  static func run(_ path: String, _ arguments: [String], then done: @escaping @Sendable () -> Void) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = arguments
    process.terminationHandler = { _ in done() }
    try? process.run()
  }
}

enum Terminal {
  /// Opens Terminal running `command`: a `.command` file is what Terminal opens and runs, with
  /// no permission to control Terminal needed.
  static func run(_ command: String, named name: String) {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("minitart-app", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let file = folder.appendingPathComponent("\(name).command")
    let script = "#!/bin/zsh -l\nclear\necho '\(name)'\n\(command)\n"
    try? script.write(to: file, atomically: true, encoding: .utf8)
    try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
    NSWorkspace.shared.open(file)
  }
}
