// The dashboard's headline (dashboard/view.js), word for word: what needs the owner, most
// important first. Both are held to test/headline-cases.json.

public struct Headline: Equatable, Sendable {
  public var lead: String
  public var point: String?

  public init(lead: String, point: String? = nil) {
    self.lead = lead
    self.point = point
  }

  public var sentence: String { point.map { "\(lead) \($0)" } ?? lead }
}

/// The jobs that wait for something minitart named, and the reason most of them share, as the
/// headline says it: a tie goes to the reason seen first. Nil when none waits.
public func waiting(_ state: State) -> (count: Int, reason: String)? {
  let notes = state.queued.compactMap(\.note)
  guard let first = notes.first else { return nil }
  var counts: [String: Int] = [:]
  for note in notes { counts[note, default: 0] += 1 }
  let most = counts.values.max() ?? 0
  let reason = notes.first { counts[$0] == most } ?? first
  var text = reason.prefix(1).lowercased() + reason.dropFirst()
  if text.hasSuffix(".") { text.removeLast() }
  return (notes.count, text)
}

public func headline(_ state: State) -> Headline {
  if let blocked = state.blocked { return Headline(lead: "No job can start.", point: blocked) }
  if let error = state.githubError { return Headline(lead: "minitart cannot read GitHub.", point: error) }
  if state.app == nil && state.repos.isEmpty {
    return Headline(lead: "Not connected to GitHub yet.", point: "Create the GitHub App below.")
  }
  let running = state.vms.filter { $0.status == "running" }.count
  if state.draining {
    return Headline(
      lead: "Draining.",
      point: running > 0
        ? "\(running) running \(running == 1 ? "job finishes" : "jobs finish"); no new one starts."
        : "Nothing is running: it is safe to restart.")
  }
  if let waiting = waiting(state) {
    return Headline(
      lead: running > 0 ? "\(running) running." : "Nothing running.",
      point: "\(waiting.count) waiting: \(waiting.reason).")
  }
  let coming = state.queued.count
  if running > 0 || coming > 0 {
    var parts: [String] = []
    if running > 0 { parts.append("\(running) running") }
    if coming > 0 { parts.append("\(coming) starting") }
    return Headline(lead: parts.joined(separator: ", ") + ".")
  }
  let today = state.today?.finished ?? 0
  return Headline(lead: "Idle.", point: today > 0 ? "\(today) \(today == 1 ? "job" : "jobs") today." : nil)
}
