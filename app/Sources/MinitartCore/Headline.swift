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
  let stuck = state.queued.compactMap(\.note)
  if !stuck.isEmpty {
    // The reason most of them share speaks for all; a tie goes to the one seen first.
    var counts: [String: Int] = [:]
    for note in stuck { counts[note, default: 0] += 1 }
    let reason = stuck.max { (counts[$0] ?? 0) < (counts[$1] ?? 0) } ?? stuck[0]
    let mostCommon = stuck.first { counts[$0] == counts[reason] } ?? reason
    var text = mostCommon.prefix(1).lowercased() + mostCommon.dropFirst()
    if text.hasSuffix(".") { text.removeLast() }
    return Headline(
      lead: running > 0 ? "\(running) running." : "Nothing running.",
      point: "\(stuck.count) waiting: \(text).")
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
