#!/bin/zsh
# Runs once, inside the VM that becomes the macOS image (`minitart image build macos`).
# Every job VM is a clone of the result, so what is installed here is what a job starts with.
#
# RUNNER_URL and RUNNER_SHA256 name the GitHub Actions runner release to install.
set -euo pipefail

# The VM's network carries IPv4 only (Softnet drops every other frame), so IPv6 is turned
# off rather than left to time out. The host enforces the network, not this.
networksetup -listallnetworkservices | tail -n +2 | while IFS= read -r service; do
  sudo networksetup -setv6off "$service" 2>/dev/null || true
done

# On Softnet a macOS guest may not get an answer from the DNS server DHCP hands it (the
# Mac itself), so it is given public ones.
networksetup -listallnetworkservices | tail -n +2 | while IFS= read -r service; do
  sudo networksetup -setdnsservers "$service" 1.1.1.1 8.8.8.8 2>/dev/null || true
done

mkdir -p "$HOME/actions-runner"
cd "$HOME/actions-runner"
curl -fsSL -o runner.tar.gz "$RUNNER_URL"
echo "$RUNNER_SHA256  runner.tar.gz" | shasum -a 256 -c -
tar xzf runner.tar.gz
rm runner.tar.gz

sync
echo "minitart: the macOS image is ready"
