// minitart in the menu bar (D26): the mark, the jobs running, and the way to the dashboard.

import AppKit
import MinitartCore
import SwiftUI

@main
struct MinitartApp: App {
  @StateObject private var model = Model()
  @AppStorage("showCount") private var showCount = true

  init() {
    let arguments = CommandLine.arguments
    if let flag = arguments.firstIndex(of: "--render-marks"), flag + 1 < arguments.count {
      RenderMarks.run(into: arguments[flag + 1])
      exit(0)
    }
  }

  var body: some Scene {
    MenuBarExtra {
      MenuContent(model: model, showCount: $showCount)
    } label: {
      let label = barLabel(model.condition, showCount: showCount)
      Image(nsImage: MarkImage.make(label.mark))
      if let count = label.count { Text("\(count)") }
    }
    .menuBarExtraStyle(.menu)
  }
}

struct MenuContent: View {
  @ObservedObject var model: Model
  @Binding var showCount: Bool

  var body: some View {
    switch model.condition {
    case .notInstalled:
      Text("minitart is not installed on this Mac.")
      Button("Install minitart…") { model.installMinitart() }
    case .notRunning:
      Text("minitart is installed, and not running.")
      Button("Start minitart") { model.startService() }
    case .unreachable:
      Text("minitart is starting, or its dashboard does not answer.")
      Button("Open Dashboard") { model.openDashboard() }
    case .tooOld(let version):
      Text("This minitart (\(version)) is older than this app.")
      Button("Upgrade in Terminal…") { Terminal.run("minitart upgrade", named: "minitart upgrade") }
    case .running(let state):
      running(state)
    }
    Divider()
    Menu("Settings") {
      Toggle("Show the number of jobs running", isOn: $showCount)
      Toggle("Open at Login", isOn: Binding(get: { model.opensAtLogin }, set: { model.opensAtLogin = $0 }))
    }
    Button("Quit minitart") { NSApp.terminate(nil) }
      .keyboardShortcut("q")
  }

  @ViewBuilder
  private func running(_ state: MinitartCore.State) -> some View {
    Text(headline(state).sentence)
    let missing = missingSteps(state)
    if !missing.isEmpty {
      Button("Finish setup in Terminal (\(missing.joined(separator: ", ")))…") { model.finishSetup() }
    }
    let lines = jobLines(state)
    if !lines.isEmpty || waitingLine(state) != nil { Divider() }
    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
      Button("● \(line.name)  —  \(line.repo) · \(line.elapsed)") {
        if let url = line.url { model.open(url) } else { model.openDashboard() }
      }
    }
    if let waiting = waitingLine(state) { Text("○ \(waiting)") }
    Divider()
    Button("Open Dashboard") { model.openDashboard() }
      .keyboardShortcut("d")
    Button(state.draining ? "Resume" : "Drain") { model.setDraining(!state.draining) }
    if let tailnet = state.tailnet?.first {
      Button("Copy Tailnet Address (\(URL(string: tailnet)?.host ?? tailnet))") { model.copy(tailnet) }
    }
  }
}
