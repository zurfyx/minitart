# D01: Every job runs in a fresh Tart VM, deleted when the job ends

Status: `PROPOSED`

## Decision

A job never runs on the Mac itself. It runs in a virtual machine that is cloned from an
image for that job, registered with GitHub as a runner that takes exactly one job, and
deleted when the job ends. minitart drives [Tart](https://tart.run) to do it and adds no
isolation of its own.

VMs start with no shared folder and no clipboard. minitart has no option that shares one.

## Why

This is what hosted runners and every serious self-hosted setup do, scaled down to one
machine. The alternative, a runner process on the Mac, runs every job as the owner: with
their SSH keys, their keychain, their `gh` token and their network. A dedicated macOS user
narrows that and still leaves state behind between jobs and the whole LAN in reach.

On Apple silicon the cost is small. A clone is copy-on-write and takes under a second; a
Linux VM answers in about seven seconds, measured on the Mac this was built on.

Tart, because it is the maintained tool for this: it wraps Apple's Virtualization framework,
runs macOS and Linux guests, runs commands in a guest through its agent, and ships the
network filter D04 relies on. The projects that manage Tart VMs for GitHub Actions are small
and come and go; the three things underneath (Apple's hypervisor, Tart, GitHub's runner) are
maintained by their owners. minitart is the thin part, so it is the part worth owning.

## Consequences

- At most two macOS VMs at once: Apple's licence and its hypervisor both stop there. Linux
  VMs are limited by memory.
- Linux VMs are arm64. A job that needs x86 stays on GitHub's runners.
- No state survives a job. Caches go through `actions/cache` or into the image
  ([D11](D11-images-are-built-on-the-mac.md)).
- minitart depends on Tart's command line and on Tart's licence (source-available, free for
  this use).
- A hypervisor escape defeats everything. That risk is accepted and written down
  (`docs/security.md`).
