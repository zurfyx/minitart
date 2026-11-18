# D02: The manager polls GitHub; nothing listens for it

Status: `PROPOSED`

## Decision

The manager finds work by asking: every few seconds, for each served repo, it lists the
workflow runs that have not completed and their jobs. It starts a VM for a queued job that
asks for a minitart label. There is no webhook, no open port and no tunnel.

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
- Cost grows with the number of served repos and active runs. A handful of repos is far
  inside an App's 5,000 requests an hour.
- A VM is started for a job, not handed to it: the runner takes the oldest matching job in
  its repo. If something else took the job, the VM waits three minutes and is deleted.
