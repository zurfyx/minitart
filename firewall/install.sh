#!/bin/sh
# Lets a VM reach this Mac for DHCP and DNS, and for nothing else (D21).
#
#   sudo sh firewall/install.sh
#
# Softnet keeps a VM off the home network, and lets it reach one address of the Mac: the
# gateway of the VM's own little network. Whatever the Mac serves to every network (AirPlay,
# Kerberos, Handoff) answers there too. This closes that, with macOS's own firewall, pf.
#
# It writes two files and changes nothing else:
#   /etc/pf.anchors/minitart                                the rules
#   /Library/LaunchDaemons/sh.rovira.minitart.firewall.plist  loads them at every boot
# The rules go in an anchor under "com.apple/*", which macOS's own /etc/pf.conf already
# evaluates, so that file is not touched and a macOS update does not undo this.
#
# Undo it with: sudo sh firewall/uninstall.sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it with sudo: sudo sh $0" >&2
  exit 1
fi

ANCHOR=/etc/pf.anchors/minitart
NAME=com.apple/251.minitart
DAEMON=/Library/LaunchDaemons/sh.rovira.minitart.firewall.plist
NEW=$(mktemp)
trap 'rm -f "$NEW"' EXIT

# Every VM gets a network of its own, and macOS names their interfaces as they come:
# bridge100, bridge101, and so on. There are never more than ten VMs; thirty-two names
# leave room. A rule for an interface that does not exist yet waits for it.
{
  echo "# minitart firewall v1. Written by firewall/install.sh; do not edit, run it again."
  echo "# A VM reaches this Mac for DHCP and DNS, and for nothing else."
  n=100
  while [ "$n" -le 131 ]; do
    echo "pass  in quick on bridge$n proto udp from any to any port { 53, 67 }"
    echo "pass  in quick on bridge$n proto tcp from any to (bridge$n) port 53"
    echo "block in quick on bridge$n from any to { (bridge$n), (bridge$n:broadcast), 255.255.255.255, 224.0.0.0/4 }"
    n=$((n + 1))
  done
} > "$NEW"

# Nothing is installed unless pf accepts the rules.
if ! /sbin/pfctl -n -a "$NAME" -f "$NEW" 2>/dev/null; then
  echo "pf does not accept the rules on this macOS; nothing was changed:" >&2
  /sbin/pfctl -n -a "$NAME" -f "$NEW" >&2 || true
  exit 1
fi

install -m 644 -o root -g wheel "$NEW" "$ANCHOR"
cat > "$DAEMON" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.rovira.minitart.firewall</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>/sbin/pfctl -E; /sbin/pfctl -a $NAME -f $ANCHOR</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST
chmod 644 "$DAEMON"
chown root:wheel "$DAEMON"

launchctl bootout system/sh.rovira.minitart.firewall 2>/dev/null || true
launchctl bootstrap system "$DAEMON"
# Loaded now as well, without waiting for launchd.
/sbin/pfctl -E 2>/dev/null || true
/sbin/pfctl -a "$NAME" -f "$ANCHOR" 2>/dev/null

RULES=$(/sbin/pfctl -a "$NAME" -sr 2>/dev/null | wc -l | tr -d ' ')
echo "Installed: $RULES rules loaded in $NAME."
echo "Check it from inside a VM: node src/main.ts selftest"
