# D10: The dashboard listens on the Mac itself only, and GitHub keeps the logs

Status: `DECIDED`

## Decision

The manager serves the dashboard at `127.0.0.1:4141`: what needs the owner and what is
running now, a year of jobs, usage, and the Mac with its settings. Its state is pushed over
server-sent events.

- **It listens on `127.0.0.1`.** There is no option to listen elsewhere, and a connection
  that did not come from the Mac is refused. The one other way in is Tailscale Serve, set up
  by the owner, which forwards a tailnet name to this port
  ([D20](D20-the-dashboard-on-a-tailnet.md)).
- **No accounts.** Whoever can open the page can change the settings and create the GitHub
  App: someone at the Mac, or someone the tailnet lets reach it.
- A request under an unknown `Host` is refused, and a change needs a same-origin `Origin`.
- **GitHub keeps the logs.** The page shows what a VM's runner printed while it runs, and
  fetches a finished job's log from GitHub when asked. minitart stores no step logs.

## Why

The first design let other devices read the page and only the Mac change things. That is two
kinds of visitor, a rule to tell them apart, and a way to get it wrong. There is one kind
now: whoever can reach the page. minitart keeps that to the Mac, and widening it is left to
the tool whose job it is ([D20](D20-the-dashboard-on-a-tailnet.md)).

A login system would be more code than the manager.

GitHub already stores, streams and expires job logs. Copying them would need storage,
retention and a second place where secrets that leaked into a log could sit.

## Consequences

- Without Tailscale Serve, you look at the dashboard sitting at the Mac.
- A reverse proxy on the Mac other than Tailscale reaches the server from `127.0.0.1` under
  its own host name, and is refused: minitart answers only to names Tailscale forwards.
- A step's live output is on GitHub's job page, one click from the row. The dashboard's live
  view is the runner's own output: which job, and how it ended.
- The page loads nothing from outside, and everything from GitHub is written as text.
