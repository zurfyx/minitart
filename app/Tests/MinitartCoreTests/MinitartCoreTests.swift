import Foundation
import XCTest

@testable import MinitartCore

/// A state as the dashboard sends it, with only what a test sets.
func makeState(_ fields: [String: Any] = [:]) -> State {
  var json: [String: Any] = [
    "now": 1_795_000_000_000.0, "vms": [], "queued": [], "draining": false, "blocked": NSNull(),
    "githubError": NSNull(), "shortOfMemory": NSNull(), "app": [:], "repos": [[:]],
    "today": ["passed": 0, "finished": 0], "version": "0.1.20",
  ]
  for (key, value) in fields { json[key] = value }
  let data = try! JSONSerialization.data(withJSONObject: json)
  return try! State.decode(data)
}

final class HeadlineTests: XCTestCase {
  /// The same cases the dashboard is held to (dashboard/view.test.mjs).
  func testTheHeadlineIsTheDashboardsWordForWord() throws {
    let file = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("test/headline-cases.json")
    let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [[String: Any]]
    XCTAssertGreaterThan(cases.count, 5)
    for one in cases {
      var fields = one["state"] as! [String: Any]
      fields["vms"] = (fields["vms"] as! [[String: Any]]).enumerated().map { index, vm in
        ["name": "minitart-linux-00000\(index)", "repo": "octo/app", "pool": "linux", "createdAt": 0] + vm
      }
      fields["queued"] = (fields["queued"] as! [[String: Any]]).map { job in
        ["repo": "octo/app", "name": "test", "pool": "linux", "createdAt": "2026-11-19T10:00:00Z"] + job
      }
      let expected = one["headline"] as! [String: Any]
      let said = headline(makeState(fields))
      XCTAssertEqual(said.lead, expected["lead"] as? String, one["case"] as! String)
      XCTAssertEqual(said.point, expected["point"] as? String, one["case"] as! String)
    }
  }
}

final class LabelTests: XCTestCase {
  let running: [[String: Any]] = [
    ["name": "a", "repo": "octo/app", "pool": "linux", "status": "running", "createdAt": 1_794_999_700_000.0, "jobAt": 1_794_999_748_000.0,
     "job": ["name": "test (node 24)", "workflow": "CI", "url": "https://github.com/octo/app/actions/runs/1/job/2"]],
    ["name": "b", "repo": "octo/ios", "pool": "macos", "status": "booting", "createdAt": 1_794_999_990_000.0],
  ]

  func testTheMarkFollowsWhatNeedsTheOwnerFirst() {
    let now = Date(timeIntervalSince1970: 1_795_000_000)
    XCTAssertEqual(barLabel(.running(makeState()), showCount: true, now: now), BarLabel(mark: .idle, count: nil))
    XCTAssertEqual(barLabel(.running(makeState(["vms": running])), showCount: true, now: now), BarLabel(mark: .busy, count: 1))
    XCTAssertEqual(barLabel(.running(makeState(["vms": running])), showCount: false, now: now), BarLabel(mark: .busy, count: nil))
    XCTAssertEqual(barLabel(.running(makeState(["draining": true])), showCount: true, now: now).mark, .paused)
    XCTAssertEqual(barLabel(.running(makeState(["blocked": "x", "draining": true])), showCount: true, now: now).mark, .attention)
    XCTAssertEqual(barLabel(.running(makeState(["githubError": "x"])), showCount: true, now: now).mark, .attention)
    XCTAssertEqual(barLabel(.notRunning, showCount: true), BarLabel(mark: .off, count: nil))
    XCTAssertEqual(barLabel(.tooOld(version: "0.1.2"), showCount: true), BarLabel(mark: .off, count: nil))
  }

  func testAJobWaitingLongForSomethingOnlyTheOwnerCanChangeAsksForThem() {
    let now = Date(timeIntervalSince1970: 1_795_000_000)
    let queued = { (minutesAgo: Double, note: Any) -> [[String: Any]] in
      let at = ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutesAgo * 60))
      return [["repo": "octo/app", "name": "t", "pool": "macos", "note": note, "createdAt": at]]
    }
    XCTAssertFalse(needsOwner(makeState(["queued": queued(3, "Every macOS slot is in use (2 of 2)")]), now: now))
    XCTAssertTrue(needsOwner(makeState(["queued": queued(15, "Every macOS slot is in use (2 of 2)")]), now: now))
    XCTAssertFalse(needsOwner(makeState(["queued": queued(30, NSNull())]), now: now), "a VM is on its way")
    // Draining, a job waits on purpose: the mark is the pause sign, not the exclamation mark.
    let drained = makeState(["draining": true, "queued": queued(30, "minitart is draining")])
    XCTAssertFalse(needsOwner(drained, now: now))
    XCTAssertEqual(barLabel(.running(drained), showCount: true, now: now).mark, .paused)
  }

  func testASetupStepMissingAsksForTheOwnerAndIsNamed() {
    let health: [[String: Any]] = [
      ["id": "firewall", "ok": false, "title": "Firewall", "detail": "x", "sudo": [["sh", "install.sh"]]],
      ["id": "github", "ok": false, "title": "GitHub App", "detail": "x"],
      ["id": "login", "ok": false, "title": "Restart", "detail": "x", "optional": true],
      ["id": "tart", "ok": true, "title": "Tart", "detail": "x"],
    ]
    let state = makeState(["health": health])
    XCTAssertTrue(needsOwner(state))
    XCTAssertEqual(missingSteps(state), ["Firewall"], "only what doctor --fix can put right")
  }
}

final class MenuTests: XCTestCase {
  func testJobLinesSayHowLongEachHasRunAndLinkOnlyToGitHub() {
    let vms: [[String: Any]] = [
      ["name": "a", "repo": "octo/app", "pool": "linux", "status": "running", "createdAt": 1_794_999_000_000.0, "jobAt": 1_794_999_748_000.0,
       "job": ["name": "test", "workflow": "CI", "url": "https://github.com/octo/app/actions/runs/1/job/2"]],
      ["name": "b", "repo": "octo/web", "pool": "linux", "status": "running", "createdAt": 1_794_996_000_000.0,
       "job": ["name": "e2e", "workflow": "CI", "url": "https://evil.example/x"]],
      ["name": "c", "repo": "octo/ios", "pool": "macos", "status": "booting", "createdAt": 1_794_999_990_000.0],
    ]
    let lines = jobLines(makeState(["vms": vms]))
    XCTAssertEqual(lines, [
      JobLine(name: "test", repo: "octo/app", elapsed: "4m 12s", url: "https://github.com/octo/app/actions/runs/1/job/2"),
      JobLine(name: "e2e", repo: "octo/web", elapsed: "1h 06m", url: nil),
    ])
  }

  func testWhatWaitsIsOneLine() {
    let job = { (note: Any) -> [String: Any] in ["repo": "octo/app", "name": "t", "pool": "linux", "note": note, "createdAt": "2026-11-19T10:00:00Z"] }
    XCTAssertNil(waitingLine(makeState()))
    XCTAssertEqual(waitingLine(makeState(["queued": [job(NSNull())]])), "1 starting")
    // Counted as the headline counts: only the jobs with a reason.
    XCTAssertEqual(waitingLine(makeState(["queued": [job("Every Linux slot is in use (4 of 4)"), job(NSNull())]])), "1 waiting: every Linux slot is in use (4 of 4)")
  }

  func testDurationsAreWrittenAsTheDashboardWritesThem() {
    XCTAssertEqual(duration(38), "38s")
    XCTAssertEqual(duration(252), "4m 12s")
    XCTAssertEqual(duration(3900), "1h 05m")
  }

  func testOnlyAMinitartThatSaysItsVersionIsNewEnough() {
    XCTAssertTrue(isAtLeast("0.1.20"))
    XCTAssertTrue(isAtLeast("0.2.0"))
    XCTAssertFalse(isAtLeast("0.1.19"), "released before the version field")
    XCTAssertFalse(isAtLeast(nil))
    XCTAssertTrue(isAtLeast("0.0.0-dev"), "a development copy")
  }

  func testAnOlderStateWithoutTheNewFieldsStillReads() throws {
    let old = #"{"now":1,"vms":[],"queued":[],"draining":false,"blocked":null,"githubError":null,"app":null,"repos":[],"settings":{}}"#
    let state = try State.decode(Data(old.utf8))
    XCTAssertNil(state.version)
    XCTAssertNil(state.today)
  }
}

func + (left: [String: Any], right: [String: Any]) -> [String: Any] {
  left.merging(right) { _, new in new }
}
