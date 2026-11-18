# D20: The dashboard on a tailnet

Status: `OPEN`

The owner wants to open the dashboard from their other devices, at a name of its own on
their Tailscale tailnet, visible to everything on the tailnet and to nothing else. It is the
next piece of work after the manager, in its own pull request.

What is known:

- Tailscale can put a local port on the tailnet over HTTPS (`tailscale serve`), with a
  certificate, at the Mac's own tailnet name. A name per service rather than per machine
  (`minitart.<tailnet>.ts.net`) is what Tailscale Services are for.
- Either way Tailscale proxies to `127.0.0.1`, so to minitart every visitor looks local. The
  loopback check ([D10](D10-the-dashboard.md)) stops meaning "at the Mac". Telling visitors
  apart then rests on the host name the request came under, and on the identity headers
  Tailscale adds.

To decide:

1. Read-only for the tailnet and changes only at the Mac, or changes for named tailnet
   users too.
2. A machine name or a service name.
3. Whether minitart runs `tailscale serve` itself or documents the one command.

Forced by: the owner asked for it.
