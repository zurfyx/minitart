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
  /// Each look is numbered: an answer older than the newest one shown is dropped.
  private var asked = 0
  private var shown = 0

  init() {
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refresh() }
    }
  }

  func refresh() {
    asked += 1
    let look = asked
    var request = URLRequest(url: Self.dashboard.appendingPathComponent("api/state"))
    request.timeoutInterval = 2.5
    URLSession.shared.dataTask(with: request) { data, response, _ in
      let ok = (response as? HTTPURLResponse)?.statusCode == 200
      let state = ok ? data.flatMap { try? State.decode($0) } : nil
      // When the dashboard does not answer, what is installed and loaded is asked here, off
      // the main thread: `launchctl` is a process to wait for.
      let condition: Condition
      if let state {
        condition = isAtLeast(state.version) ? .running(state) : .tooOld(version: state.version ?? "an older version")
      } else {
        condition = Installation.minitart() == nil ? .notInstalled : (Installation.serviceLoaded() ? .unreachable : .notRunning)
      }
      Task { @MainActor in self.show(condition, look: look) }
    }.resume()
  }

  private func show(_ condition: Condition, look: Int) {
    guard look > shown else { return }
    shown = look
    self.condition = condition
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
    URLSession.shared.dataTask(with: request) { data, response, error in
      let status = (response as? HTTPURLResponse)?.statusCode
      let said = data.flatMap { String(data: $0, encoding: .utf8) } ?? error?.localizedDescription ?? "no answer"
      Task { @MainActor in
        if status != 200 { Alert.show("minitart did not \(draining ? "drain" : "resume")", said) }
        self.refresh()
      }
    }.resume()
  }

  /// Starts minitart's own service if it has one (`minitart service install`), with the
  /// flags it was installed with; otherwise Homebrew's.
  func startService() {
    let own = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/LaunchAgents/sh.rovira.minitart.plist").path
    let done: @Sendable () -> Void = { Task { @MainActor in self.refresh() } }
    if FileManager.default.fileExists(atPath: own) {
      Installation.run("/bin/launchctl", ["bootstrap", "gui/\(getuid())", own], then: done)
    } else {
      Installation.run(Installation.brew(), ["services", "start", "zurfyx/tap/minitart"], then: done)
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
      do {
        if newValue { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
      } catch {
        // macOS can ask the owner to allow it first, in System Settings.
        if SMAppService.mainApp.status == .requiresApproval {
          SMAppService.openSystemSettingsLoginItems()
        } else {
          Alert.show("minitart could not change Open at Login", error.localizedDescription)
        }
      }
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

enum Alert {
  static func show(_ title: String, _ detail: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = detail
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
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
