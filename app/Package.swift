// swift-tools-version: 6.0
// minitart's menu bar app (D26): a window onto the minitart on this Mac. Built by
// scripts/app.sh into minitart.app; no Xcode project.
import PackageDescription

let package = Package(
  name: "MinitartApp",
  platforms: [.macOS(.v14)],
  targets: [
    // What the app shows, worked out from the dashboard's state: no AppKit, tested.
    .target(name: "MinitartCore"),
    .executableTarget(name: "minitart-app", dependencies: ["MinitartCore"]),
    .testTarget(name: "MinitartCoreTests", dependencies: ["MinitartCore"]),
  ],
  swiftLanguageModes: [.v5]
)
