#!/bin/sh
# Removes what firewall/install.sh put in place.
#
#   sudo sh firewall/uninstall.sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it with sudo: sudo sh $0" >&2
  exit 1
fi

launchctl bootout system/sh.rovira.minitart.firewall 2>/dev/null || true
/sbin/pfctl -a com.apple/251.minitart -F all 2>/dev/null || true
rm -f /Library/LaunchDaemons/sh.rovira.minitart.firewall.plist /etc/pf.anchors/minitart
echo "Removed. VMs can reach this Mac's own services at their gateway again."
