# D23: The dashboard leads with what needs the owner, then shows the Mac's last hour

Status: `DECIDED`

## Decision

The top of the dashboard is one sentence that says what needs the owner, picked in this
order:

1. No job can start (the Mac is not set up to isolate one), or GitHub cannot be read.
2. minitart is draining.
3. Jobs are waiting, and why: every slot of their kind is in use, the Mac is short of
   memory, there is no image.
4. Jobs are running or starting, and nothing waits.
5. Idle, and how many jobs ran today.

Four figures sit beside it: jobs running, jobs queued, jobs passed today, and how long a job
waited for a VM, as the median of today's.

Under it, the last hour of the Mac:

- **A timeline of VMs**, a lane per slot: when each VM was starting, when it ran its job,
  and how the job ended. A bar opens its log.
- **CPU and memory**, each a stacked area: minitart's job VMs, and everything else on the
  Mac. A point every ten seconds, an hour of them, kept in memory.
- **Disk**: the data volume, used and free, and what Tart keeps of each image and of its
  downloads.

## Why

The owner chose this from three mocks. A resource figure was first proposed as the headline
("76% of the CPU busy") and rejected: busy CPU is the Mac doing the work it is there for,
CPU never keeps a job from starting (VMs share the cores), and nothing about the number
says what to do. What makes jobs wait is a full slot, memory, or a Mac that is not closed;
the headline names those, and a resource only as the reason a job waits.

The timeline answers what the owner looks at the page for: what ran, when, for how long,
whether the slots were full, and what starting a VM costs, which no GitHub page shows.

## How it is measured

- **CPU**: Node's per-core counters, for the whole Mac. A VM is one macOS process,
  `com.apple.Virtualization.VirtualMachine`; its CPU time (`ps`) is the VM's. Which VM it
  runs is read once from the disk it has open (`lsof`); only job VMs count as minitart's.
  Checked on the Mac: three busy guest cores read as 296%.
- **Memory**: used is the Mac's memory less what macOS has to spare (D22); a VM's share is
  its process's resident memory.
- **Disk**: `/System/Volumes/Data`, not `/`, which is the sealed system volume. What Tart
  keeps is `du`, every ten minutes. A clone shares its blocks until either copy is written,
  so those sizes can add up to more than they take; the page says so.

## Consequences

- The charts start empty after a restart, and fill in over the first hour.
- Whatever else needs the owner, beyond what the headline says, is a line under it: GitHub
  failing while the Mac is not closed, say, or draining while jobs wait.
- Today's figures are counted by minitart from the whole history (D24), by the Mac's
  clock.
- A VM of the owner's own, or one `image build` runs, counts as everything else.
- Slot pips are gone: the timeline's lanes are the slots.
