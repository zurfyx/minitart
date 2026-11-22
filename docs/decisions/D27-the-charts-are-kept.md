# D27: The charts are kept, a minute a row, forever unless the owner sets a limit

Status: `DECIDED`

## Decision

The Now view's charts are sampled every ten seconds (D23): CPU, memory, and now the network,
each split between minitart's job VMs and the rest of the Mac. Each minute of those points
is also kept in `~/.minitart/history.db`, in a table of its own: when the minute began, and
each series' average and peak over it. The minutes are kept forever. This Mac's Settings can
keep them a year, 90 days or 30 days instead.

After a restart, the charts start from the last hour of kept minutes instead of empty.

The network is read from macOS's byte counts per interface (`netstat -ibn`) every ten
seconds. A job VM on Softnet has an interface of its own, `bridge100` to `bridge131` (D21):
what crossed those is the VMs' traffic. What crossed the Mac's ports (`en0` and the like),
less the VMs', is the rest of the Mac's. The chart shows the rate down; the rate up is in
its heading.

## Why

The owner found the last hour's charts the most useful part of the dashboard, and asked to
keep them and go back in time, as the Jobs view does for jobs, and for a network chart too.

A minute a row, not every point: a year of ten-second points is about 3 million rows, some
130 MB, finer than any chart of a day or more can show. A minute is about 525,000 rows a
year, some 25 MB. Both the average and the peak are kept, because CI load comes in bursts
that an average flattens.

Forever, because the owner asked for it and it costs little; a limit is there for a Mac with
little disk. Jobs stay kept a year (D24).

## Consequences

- A VM of the owner's own on the same kind of network is counted with the VMs: Softnet does
  not say whose an interface is.
- An interface first seen (a VM just started), or whose count went back, counts from its
  next point, as a VM's CPU time does.
- The view that goes back in time (the History view) reads these minutes, gathered into
  steps that fit its range.
