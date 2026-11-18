# D20: The dashboard on the tailnet, through Tailscale Serve, with the same access as at the Mac

Status: `DECIDED`

## Decision

The owner can open the dashboard from their other devices at a name on their Tailscale
tailnet, such as `https://minitart.<tailnet>.ts.net`.

- **Tailscale does the exposing, not minitart.** minitart still listens on `127.0.0.1` and
  nowhere else ([D10](D10-the-dashboard.md)). The owner tells Tailscale Serve to forward a
  tailnet name to that port: a Tailscale Service for a name of its own, or a port on the
  Mac's own name.
- **minitart asks Tailscale which names it forwards here** (`tailscale serve status`), twice
  a minute, and answers to those names, HTTPS ones only. There is no flag and no setting: set Serve up and
  the dashboard is there; take it down and it is gone.
- **Everyone on the tailnet who can reach the name has the same access as someone at the
  Mac**: they see everything and can change everything, creating the GitHub App included.
  Who that is, is decided in the tailnet's access rules.
- **Never the internet.** A name that Tailscale Funnel publishes is not answered to, and
  any request Tailscale marks as having come in through Funnel is refused whatever the names
  say, so switching Funnel on has no window. `doctor` flags it, and flags bare TCP forwarded
  to the dashboard, which no name check can guard.

## Why

The tailnet is already where the owner decides which devices and people are theirs, and
Tailscale already terminates TLS, issues the certificate and authenticates every
connection. Doing access control a second time inside minitart would be more code than the
manager and would add nothing a tailnet rule does not say better.

Same access, because a read-only mode is two kinds of visitor and a rule to tell them apart,
which D10 removed for being the part most likely to be wrong. The owner chose it: the people
on this tailnet are the owner.

Asking Tailscale for the names, rather than taking one as a flag, keeps the two from
disagreeing. The `Host` check that stops a web page from reading the dashboard by pointing
a name of its own at `127.0.0.1` stays exactly as strict: the only extra names are ones
Tailscale itself is forwarding to this port.

Tailscale's proxy connects from `127.0.0.1`, so the loopback check no longer means "someone
at the Mac". It still means "nothing reached this port except from this Mac's own
processes", which is what it is for.

## Consequences

- Anyone the tailnet lets reach the name can change which repos are served and how many VMs
  run. A shared tailnet needs a rule that narrows who reaches `svc:minitart`.
- A new name takes up to half a minute to be answered to.
- A job cannot reach the dashboard either way: a VM reaches no tailnet address and nothing
  on `127.0.0.1` ([D04](D04-the-internet-and-nothing-private.md)).
- minitart depends on the shape of `tailscale serve status --json`. If that changes, the
  tailnet name stops working and the dashboard at `127.0.0.1` does not.
