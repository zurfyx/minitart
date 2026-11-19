// The part of the dashboard's state (GET /api/state) the menu bar app reads. Fields the app
// does not know are ignored, and the ones it reads are optional where an older minitart may
// not send them.

import Foundation

public struct State: Decodable, Sendable {
  public var now: Double
  public var vms: [Vm]
  public var queued: [Queued]
  public var draining: Bool
  public var blocked: String?
  public var githubError: String?
  public var shortOfMemory: String?
  /// Present once the GitHub App exists.
  public var app: Present?
  public var repos: [Present]
  public var today: Today?
  public var health: [Check]?
  /// minitart's version: sent since the menu bar app exists.
  public var version: String?
  /// The tailnet addresses the dashboard is also served at.
  public var tailnet: [String]?

  public struct Present: Decodable, Sendable {
    public init(from decoder: Decoder) throws {}
  }

  public struct Today: Decodable, Sendable {
    public var passed: Int?
    public var finished: Int
  }

  public struct Vm: Decodable, Sendable {
    public var name: String
    public var repo: String
    public var pool: String
    public var status: String
    public var createdAt: Double
    public var jobAt: Double?
    public var job: Job?
  }

  public struct Job: Decodable, Sendable {
    public var name: String
    public var workflow: String
    public var url: String
    public var actor: String?
  }

  public struct Queued: Decodable, Sendable {
    public var repo: String
    public var name: String
    public var pool: String?
    public var note: String?
    public var createdAt: String
  }

  public struct Check: Decodable, Sendable {
    public var id: String
    public var ok: Bool
    public var title: String
    public var detail: String
    public var optional: Bool?
    /// Present when `minitart doctor --fix` can put it right: commands, some with the password.
    public var sudo: [[String]]?
    public var commands: [Present]?

    public var fixable: Bool { sudo != nil || commands != nil }
  }

  public static func decode(_ data: Data) throws -> State {
    try JSONDecoder().decode(State.self, from: data)
  }
}
