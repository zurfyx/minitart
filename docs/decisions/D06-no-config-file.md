# D06: No config file: defaults from the machine, changes from the dashboard

Status: `PROPOSED`

## Decision

There is no file the owner writes. Each thing that could be configuration has one home:

- **Which repos**: the App's installation, on GitHub ([D03](D03-a-github-app-is-the-allowlist.md)).
- **How many VMs, and how big**: computed from the Mac's memory and cores on first start
  (three quarters of the memory, at most two VMs of each kind), changed in the dashboard.
- **How often GitHub is asked, how long an idle VM waits, whether public repos are served**:
  sensible defaults, changed in the dashboard.
- **Pausing a repo**: a button in the dashboard.
- **Where the dashboard listens**: flags to `minitart start`, kept by the service.

What the dashboard changes is saved in `~/.minitart/settings.json`. It is written by
minitart and validated on every read; it is state, not a format to learn.

## Why

A tool for one Mac should work when started. Every setting in a file is a decision pushed to
someone who has not run the tool yet, and a second place for the repo list would be a second
truth. The owner asked for neither the repos nor the number of runners to be hardcoded.

## Consequences

- No way to declare a setup in a repo and reproduce it on another Mac. That is a fleet's
  need, and minitart is not for fleets.
- Settings change only from a browser on the Mac ([D10](D10-the-dashboard.md)).
- A setting is added only when a default cannot be right. The list stays short.
