# D21: A VM reaches the Mac itself for DHCP and DNS only, by a firewall rule the setup installs

Status: `DECIDED`

## Decision

The setup installs a rule in macOS's firewall, pf (`firewall/install.sh`, run once with
`sudo`): on a VM's network interface, the Mac accepts DHCP and DNS, and drops everything
else addressed to it, unicast, broadcast and multicast.

- The rules live in their own anchor, `com.apple/251.minitart`, loaded from
  `/etc/pf.anchors/minitart` by a LaunchDaemon at every boot. `/etc/pf.conf` is not touched:
  macOS's own file already evaluates every anchor under `com.apple/`.
- `minitart doctor` requires it, and `minitart selftest` proves it from inside a VM.
- `firewall/uninstall.sh` removes it.

## Why

Softnet keeps a VM off the home network and the tailnet
([D04](D04-the-internet-and-nothing-private.md)), and lets it reach one address of the Mac:
the gateway of the VM's own network, where DHCP and DNS are served. Anything else the Mac
serves to every network answers there too. Measured on the Mac this was built on, from
inside a VM on Softnet: Kerberos (88), AirPlay Receiver (5000 and 7000) and Handoff's
`rapportd` were open. SSH and Screen Sharing were not, only because the owner already had a
pf rule keeping those to the tailnet.

Turning services off one by one is a list someone has to keep, of things macOS turns on by
itself. A rule that says what a VM may reach on the Mac, and drops the rest, needs no list:
the same reasoning as D04, and the owner's standing preference.

pf, because it is already on every Mac and it is what the owner's own rule uses. Its own
anchor under `com.apple/`, because that needs no edit to a system file that macOS updates
replace.

## Consequences

- A third `sudo` step in the setup, after Softnet's and the one that stops sleep.
- Softnet gives every VM a network of its own and macOS names the interfaces as they come
  (`bridge100`, `bridge101`, …). The rules name the first thirty-two; minitart never runs
  more than ten VMs.
- The rules apply to every VM on those interfaces, not only minitart's: a VM of the owner's
  own, on Tart's default network, also stops reaching the Mac's services. DHCP, DNS and the
  internet are unaffected.
- A job still reaches the Mac's DNS resolver, and so can look up names the Mac can.
- pf must be enabled; the LaunchDaemon enables it. On a Mac with no other pf rules that
  changes nothing else.
