# D02: The manager polls GitHub; nothing listens for it

Status: `DECIDED`

## Decision

The manager finds work by asking: every few seconds, for each served repo, it lists the
workflow runs that have not completed and their jobs. It starts a VM for a queued job that
asks for a minitart label. Whether a job is ready is the job's own status: runs are listed
whatever GitHub calls them short of completed (queued, in progress, waiting, pending). There is no webhook, no open port and no tunnel.

Reads are conditional (ETag). An answer that has not changed returns 304 and does not count
against the rate limit.

## Why

A webhook needs the Mac to be reachable from the internet, which a Mac mini at home is not
and should not become. Polling needs only outbound HTTPS, works behind any router, and loses
nothing when the manager restarts: the queue is on GitHub, and the next poll reads it again.

GitHub's own autoscaler protocol (runner scale sets) is the other pull-based option. It
exists for organisations and enterprises; a personal account's repos register runners one
repo at a time, which is what the polling does.

## Consequences

- A job starts a poll interval plus a boot later than it could: about ten to forty seconds.
- It costs nothing in money, and next to nothing in GitHub's rate limit. An idle repo is
  four requests a poll, each answered 304, and a 304 is not counted: measured, ten
  conditional requests in a row left the counter where it was, and three unconditional ones
  moved it by three. What counts is change: a few requests per job, against an App's 5,000
  an hour.
- A VM is started for a job, not handed to it: the runner takes the oldest matching job in
  its repo. If something else took the job, the VM waits three minutes and is deleted.
