# D08: Two labels route jobs: `minitart-linux` and `minitart-macos`

Status: `DECIDED`

## Decision

A job is minitart's when its `runs-on` names `minitart-linux` or `minitart-macos`. A runner
also carries `self-hosted`, its OS (`linux` or `macos`) and `arm64`, so
`runs-on: [self-hosted, macos, arm64, minitart-macos]` works too.

A job that names a minitart label and another label no minitart runner has (`x64`, `gpu`) is
shown in the dashboard as one that cannot be served. A job with neither label is ignored,
including jobs for other self-hosted runners.

## Why

One label per kind is the least a workflow can write, and it cannot be mistaken for a hosted
runner or for someone else's self-hosted runner. Requiring a minitart label means minitart
never starts a VM for a job that was not meant for it.

Each repo decides, job by job, where its jobs run. That is how a repo keeps its x86 jobs on
GitHub's runners.

## Consequences

- Switching a job between the Mac and GitHub is a one-word change, or none with a repository
  variable (`docs/product.md`).
- There is one image and one VM size per kind. A second flavour would need a third label.
