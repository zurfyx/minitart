# D10: The dashboard is local, read-only from elsewhere, and GitHub keeps the logs

Status: `PROPOSED`

## Decision

The manager serves one page at `127.0.0.1:4141`: slots, running, queued, done, repos, health
and activity, pushed over server-sent events.

- **No accounts.** Whoever can reach the port can read. It listens on loopback unless
  started with `--host`.
- **Changes only from the Mac itself**: a loopback connection, a same-origin `Origin`, a
  known `Host`. From anywhere else the page is read-only.
- **GitHub keeps the logs.** The page shows what a VM's runner printed while it runs, and
  fetches a finished job's log from GitHub when asked. minitart stores no step logs.

## Why

A login system would be more code than the manager. The split that matters is simpler:
looking is harmless enough to allow from the owner's other devices (over a tailnet, say),
and changing how many VMs run or which GitHub App is used is not, so it takes being at the
Mac.

GitHub already stores, streams and expires job logs. Copying them would need storage,
retention and a second place where secrets that leaked into a log could sit.

## Consequences

- On a tailnet, everyone on the tailnet can read job names and logs.
- A step's live output is on GitHub's job page, one click from the row. The dashboard's
  live view is the runner's own output: which job, and how it ended.
- The page loads nothing from outside, and everything from GitHub is written as text.
