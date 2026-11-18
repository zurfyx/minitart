# D06: No file to write: defaults from the machine, changes from the dashboard, saved as JSON

Status: `DECIDED`

## Decision

There is no file the owner writes. Each thing that could be configuration has one home:

- **Which repos**: the App's installation on GitHub, and a switch per repo in the dashboard
  ([D03](D03-a-github-app-is-the-allowlist.md)).
- **How many VMs, and how big**: computed from the Mac's memory and cores on first start,
  changed in the dashboard. Each VM gets a fifth of the memory, between 4 and 8 GB; the VMs
  that may run at once fit in three quarters of the memory, at most two of each kind; and
  all of them busy want about as many CPUs as the Mac has.
- **How often GitHub is asked, how long an idle VM waits, whether public repos are served**:
  sensible defaults, changed in the dashboard.
- **The dashboard's port**: a flag to `minitart start`, kept by the service.

What the dashboard changes is saved in `~/.minitart/settings.json`: plain, indented JSON,
one file, so it can be backed up, compared and read by other tools. It is validated on every
read. A file that does not pass (edited by hand, or written before a rule changed) is not
used and not lost: it is renamed `settings.invalid.json`, minitart starts on the defaults,
which serve no repo, and the dashboard's activity list says so.

## Why

A tool for one Mac should work when started. Every setting in a file is a decision pushed to
someone who has not run the tool yet, and a second place for the repo list would be a second
truth. The owner asked for neither the repos nor the number of runners to be hardcoded.

The VM is kept small on purpose. Measured: a 12 GB Linux VM whose job's programs used 4 GB
took 5.7 GB of the Mac's memory, and 12.8 GB once the job had also read and written about
5 GB of files, because a guest fills the memory it is given with cached files and hands none
back. So what a VM is given is what a job costs, and a VM is started only when the Mac has
that much to spare ([D22](D22-a-vm-needs-its-memory-first.md)). 8 GB is what a standard
hosted runner has. CPU is the opposite: it is shared, not set aside, and wanting a little
more than there is only slows things for a while.

## Consequences

- No way to declare a setup in a repo and reproduce it on another Mac. That is a fleet's
  need, and minitart is not for fleets.
- Settings change from a browser on the Mac ([D10](D10-the-dashboard.md)), or by editing the
  file while minitart is stopped.
- A setting is added only when a default cannot be right. The list stays short.
- One size for every job. A job that needs more than the default (a large build) has no way
  to ask for it yet; raising the size raises it for all.
