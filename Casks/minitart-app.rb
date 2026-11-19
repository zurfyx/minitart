cask "minitart-app" do
  # Source template only: the app's release renders version and sha256 for the tap (D26).
  version "0.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/zurfyx/minitart/releases/download/app-v#{version}/minitart-app-#{version}.zip"
  name "minitart"
  desc "Menu bar companion for minitart, GitHub Actions runners in Tart VMs"
  homepage "https://minitart.rovira.sh/"

  depends_on arch: :arm64
  depends_on macos: ">= :sonoma"
  # One install sets up both: the app watches the minitart on this Mac.
  depends_on formula: "zurfyx/tap/minitart"

  app "minitart.app"

  uninstall quit: "sh.rovira.minitart.app"

  zap trash: "~/Library/Preferences/sh.rovira.minitart.app.plist"
end
