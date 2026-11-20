# D22: A VM is started only when the Mac has the memory for it

Status: `DECIDED`

## Decision

Before starting a VM, minitart asks macOS how much memory it has to spare and whether it is
under memory pressure. To spare means: free, holding files it can read again from disk, or
marked disposable by its owner (`vm_stat`). Memory that programs are using does not count,
including the part macOS calls inactive, which it could only free by compressing or swapping
it. A VM is started only if there is room for its whole size and macOS is not under
pressure. Every VM that has no job yet has its whole size set aside, since it has taken
almost none of it so far. Otherwise the job waits on GitHub, and the queue and the top of
the dashboard say why. It is asked again every few seconds.

This is on top of the settings' own limit: the VMs that may run at once must fit, together,
in the Mac's memory.

## Why

A Mac that runs jobs is often also the Mac someone works at. The settings can say "four VMs
of 12 GB" on a 64 GB Mac, and be right on an idle one and wrong while its owner has a
browser, an editor and a simulator open.

Measured on the Mac this was built on: a 12 GB Linux VM takes 1.6 GB of the Mac's memory
when idle, 9.6 GB once its guest has used 8 GB, and keeps that until it is deleted, whatever
the guest frees. A guest that asks for more than its size is refused inside the guest. So a
VM cannot take more than its size, and can take all of it, later. Starting one is a promise
of that much memory, and the time to check is before it starts.

Without the check nothing breaks at once: macOS compresses memory and swaps to disk. It gets
slow for the jobs and for the person at the Mac, and at the far end macOS stops programs to
free memory. Waiting a few seconds for room costs less than that.

## Consequences

- A job can wait while a slot is free, when the Mac is busy with something else.
- It is a judgement at the moment a VM starts. VMs that were started in leaner times can
  still grow to their size later, together; the settings' limit is what bounds that.
- A VM that is running its job is counted by what it has taken so far, not by its size, so
  jobs that grow late can still add up to more than there is. The settings' limit bounds
  that, and macOS's own pressure signal stops new VMs when it happens.
- When macOS cannot be asked, nothing is held back.
