// What the menu bar shows, and what the menu holds, for each condition minitart can be in on
// this Mac. Worked out here, without AppKit, so that it can be tested.

import Foundation

/// Where minitart stands on this Mac, as the app finds out.
public enum Condition: Sendable {
  /// The `minitart` command is not installed.
  case notInstalled
  /// Installed, and its background service is not running.
  case notRunning
  /// Its service is loaded, and its dashboard does not answer (it is starting, or failing).
  case unreachable
  /// The dashboard answered, from a minitart too old for this app.
  case tooOld(version: String)
  case running(State)
}

/// The mark in the menu bar: plain, busy, asking for the owner, paused, or greyed.
public enum Mark: Equatable, Sendable {
  case idle
  case busy
  case attention
  case paused
  case off
}

public struct BarLabel: Equatable, Sendable {
  public var mark: Mark
  /// Jobs running, shown beside the mark when the owner wants it and there are any.
  public var count: Int?
}

/// The oldest minitart that tells the app its version.
public let minimumVersion = "0.1.20"

/// How long a job may wait for a slot, memory or an image before the mark asks for the owner.
public let longWaitSeconds: Double = 10 * 60

public func barLabel(_ condition: Condition, showCount: Bool, now: Date = Date()) -> BarLabel {
  switch condition {
  case .notInstalled, .notRunning, .unreachable, .tooOld:
    return BarLabel(mark: .off, count: nil)
  case .running(let state):
    let running = state.vms.filter { $0.status == "running" }.count
    let count = showCount && running > 0 ? running : nil
    if needsOwner(state, now: now) { return BarLabel(mark: .attention, count: count) }
    if state.draining { return BarLabel(mark: .paused, count: count) }
    return BarLabel(mark: running > 0 ? .busy : .idle, count: count)
  }
}

/// What makes the mark ask for the owner: the same things the dashboard says first, and a job
/// that has waited long for something only the owner can change.
public func needsOwner(_ state: State, now: Date = Date()) -> Bool {
  if state.blocked != nil || state.githubError != nil || state.shortOfMemory != nil { return true }
  if (state.health ?? []).contains(where: { !$0.ok && !($0.optional ?? false) }) { return true }
  // While draining every queued job waits on purpose: the pause sign says so, not this.
  if state.draining { return false }
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let plain = ISO8601DateFormatter()
  return state.queued.contains { job in
    guard job.note != nil else { return false }
    guard let queued = formatter.date(from: job.createdAt) ?? plain.date(from: job.createdAt) else { return false }
    return now.timeIntervalSince(queued) > longWaitSeconds
  }
}

/// Whether `version` is at least `minimum`. A development copy (`0.0.0-dev`, a checkout of the
/// source) counts as new; a minitart that sends no version is too old.
public func isAtLeast(_ version: String?, _ minimum: String = minimumVersion) -> Bool {
  guard let version else { return false }
  if version.hasSuffix("-dev") { return true }
  let parts = { (text: String) in text.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 } }
  let have = parts(version)
  let want = parts(minimum)
  for index in 0..<max(have.count, want.count) {
    let a = index < have.count ? have[index] : 0
    let b = index < want.count ? want[index] : 0
    if a != b { return a > b }
  }
  return true
}

/// A job line in the menu: its name, its repo, and how long it has run.
public struct JobLine: Equatable, Sendable {
  public var name: String
  public var repo: String
  public var elapsed: String
  public var url: String?
}

public func jobLines(_ state: State, limit: Int = 8) -> [JobLine] {
  state.vms.filter { $0.status == "running" }.prefix(limit).map { vm in
    let since = (vm.jobAt ?? vm.createdAt) / 1000
    return JobLine(
      name: vm.job?.name ?? "A job",
      repo: vm.repo,
      elapsed: duration(max(0, state.now / 1000 - since)),
      url: vm.job.map(\.url).flatMap { $0.hasPrefix("https://github.com/") ? $0 : nil })
  }
}

/// A line on what waits, as the headline counts it: the jobs with a reason and the reason most
/// share; or, when none has one, how many are starting.
public func waitingLine(_ state: State) -> String? {
  if let waiting = waiting(state) { return "\(waiting.count) waiting: \(waiting.reason)" }
  return state.queued.isEmpty ? nil : "\(state.queued.count) starting"
}

/// Seconds as the dashboard writes them: 38s, 4m 12s, 1h 05m.
public func duration(_ seconds: Double) -> String {
  let total = Int(seconds.rounded())
  if total < 60 { return "\(total)s" }
  let minutes = total / 60
  if minutes < 60 { return "\(minutes)m \(String(format: "%02d", total % 60))s" }
  return "\(minutes / 60)h \(String(format: "%02d", minutes % 60))m"
}

/// The setup steps missing that `minitart doctor --fix` can put right, by title. The others
/// (the GitHub App, a full disk) are the dashboard's to explain.
public func missingSteps(_ state: State) -> [String] {
  (state.health ?? []).filter { !$0.ok && !($0.optional ?? false) && $0.fixable }.map(\.title)
}
