#!/bin/bash
# Runs once, inside the VM that becomes the Linux image (`minitart image build linux`).
# Every job VM is a clone of the result, so what is installed here is what a job starts with.
#
# RUNNER_URL and RUNNER_SHA256 name the GitHub Actions runner release to install.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
sudo -E apt-get update -qq
sudo -E apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git jq tar unzip zip build-essential \
  docker.io docker-buildx docker-compose-v2

# Jobs use Docker (`container:`, `services:`, `docker build`) without sudo.
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker

# The VM's network carries IPv4 only (Softnet drops every other frame), so IPv6 is turned
# off rather than left to time out. On the kernel command line, because a sysctl is undone
# when the network comes up. This is for speed: the host enforces the network, and a job,
# which is root in here, can undo nothing that matters.
echo 'GRUB_CMDLINE_LINUX="$GRUB_CMDLINE_LINUX ipv6.disable=1"' |
  sudo tee /etc/default/grub.d/99-minitart.cfg >/dev/null
sudo update-grub

mkdir -p "$HOME/actions-runner"
cd "$HOME/actions-runner"
curl -fsSL -o runner.tar.gz "$RUNNER_URL"
echo "$RUNNER_SHA256  runner.tar.gz" | sha256sum -c -
tar xzf runner.tar.gz
rm runner.tar.gz
sudo ./bin/installdependencies.sh

sudo apt-get clean
sync
echo "minitart: the Linux image is ready"
