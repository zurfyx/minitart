# D06: No file to write: defaults from the machine, changes from the dashboard, saved as JSON

Status: `DECIDED`

## Decision

There is no file the owner writes. Each thing that could be configuration has one home:

- **Which repos**: the App's installation on GitHub, and a switch per repo in the dashboard
  ([D03](D03-a-github-app-is-the-allowlist.md)).
- **How many VMs, and how big**: computed from the Mac's memory and cores on first start
  (three quarters of the memory, at most two VMs of each kind), changed in the dashboard.
- **How often GitHub is asked, how long an idle VM waits, whether public repos are served**:
  sensible defaults, changed in the dashboard.
- **The dashboard's port**: a flag to `minitart start`, kept by the service.

What the dashboard changes is saved in `~/.minitart/settings.json`: plain, indented JSON,
one file, so it can be backed up, compared and read by other tools. It is validated on every
read. A file that does not pass (edited by hand, or written before a rule changed) is not
used: minitart starts on the defaults, which serve no repo, and says which file it set
aside.

## Why

A tool for one Mac should work when started. Every setting in a file is a decision pushed to
someone who has not run the tool yet, and a second place for the repo list would be a second
truth. The owner asked for neither the repos nor the number of runners to be hardcoded.

## Consequences

- No way to declare a setup in a repo and reproduce it on another Mac. That is a fleet's
  need, and minitart is not for fleets.
- Settings change from a browser on the Mac ([D10](D10-the-dashboard.md)), or by editing the
  file while minitart is stopped.
- A setting is added only when a default cannot be right. The list stays short.
