# D10: The dashboard is served to the Mac itself only, and GitHub keeps the logs

Status: `DECIDED`

## Decision

The manager serves one page at `127.0.0.1:4141`: slots, running, queued, done, repos, health
and activity, pushed over server-sent events.

- **This Mac only.** It listens on `127.0.0.1`. There is no option to listen elsewhere, and
  a connection that did not come from the Mac is refused.
- **No accounts**, because there is nobody else to tell apart. Whoever is at the Mac can
  change the settings and create the GitHub App.
- A request under an unknown `Host` is refused, and a change needs a same-origin `Origin`.
- **GitHub keeps the logs.** The page shows what a VM's runner printed while it runs, and
  fetches a finished job's log from GitHub when asked. minitart stores no step logs.

## Why

The first design let other devices read the page and only the Mac change things. That is
two kinds of visitor, a rule to tell them apart, and a way to get it wrong, for something
this decision does not need: looking from elsewhere is a feature of its own, with its own
answer to who is asking ([D20](D20-the-dashboard-on-a-tailnet.md)). Until then the rule is
one line: the Mac, and nothing else.

A login system would be more code than the manager.

GitHub already stores, streams and expires job logs. Copying them would need storage,
retention and a second place where secrets that leaked into a log could sit.

## Consequences

- To look at the dashboard you sit at the Mac, or share its screen.
- A reverse proxy on the Mac (which is what would put it on a tailnet) reaches the server
  from `127.0.0.1` but under its own host name, and is refused until minitart is taught
  that name. That is deliberate: it keeps "local only" true until D20 is built.
- A step's live output is on GitHub's job page, one click from the row. The dashboard's
  live view is the runner's own output: which job, and how it ended.
- The page loads nothing from outside, and everything from GitHub is written as text.
