# D04: A VM reaches the internet and nothing private; no VM starts otherwise

Status: `DECIDED`

## Decision

Every VM runs on Tart's Softnet network (`tart run --net-softnet`). Softnet forwards a
packet from the VM only to a globally routable IPv4 address or to the VM's own gateway, and
drops everything else, including every frame that is not IPv4 or ARP. minitart adds
`--net-softnet-block=100.64.0.0/10`.

minitart starts VMs on no other network. Without Softnet, or without the firewall rule of
[D21](D21-what-a-job-reaches-on-the-mac-itself.md), no VM is started, and the dashboard says
which step is missing. The flag `--unsafe-shared-network` exists for trying minitart out,
warns on start, and shows in the dashboard for as long as it is on.

`minitart selftest` checks the result from inside a VM.

## Why

The default VM network is NAT through the Mac, and a VM on it reaches whatever the Mac
reaches. Measured on the Mac this was built on: a VM on the default network opened the home
router's admin page.

The rule is an **allowlist**, which was the owner's requirement. A blocklist of private
ranges has to be right about every range that matters, today and after the next VPN or
overlay network is installed. "Public internet addresses only" needs no knowledge of the
network it protects. The one named block is for the range Tailscale uses, so that the case
the owner cares about most does not depend on Softnet's definition of "globally routable".

It is Tart's own mechanism rather than firewall rules on the Mac because it travels with the
VM. The one rule on the host is for the Mac itself
([D21](D21-what-a-job-reaches-on-the-mac-itself.md)), in an anchor that macOS's own pf.conf
loads, so an update does not undo it.

## Consequences

- Softnet's binary must be setuid root (it creates a network interface). That takes `sudo`,
  and an upgrade of Softnet needs it again. Softnet is pinned, so only `minitart upgrade`
  replaces it, and that runs `doctor --fix`, which puts the bit back.
- A job cannot reach anything on the home network, including things it might legitimately
  want (a local cache, a device farm). There is no setting for exceptions; a need for one is
  a new decision.
- Softnet lets a VM reach the Mac at the VM's own gateway address, where a service that
  listens on all interfaces would answer. A firewall rule closes that
  ([D21](D21-what-a-job-reaches-on-the-mac-itself.md)), and `selftest` checks it.
- IPv6 does not work in a VM. The images turn it off so nothing waits for it.
- The rule is by address, not by name ([D19](D19-egress-by-domain.md)).
