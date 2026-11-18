# D17: A job gets its secrets from GitHub, never from the Mac

Status: `DECIDED`

## Decision

A job that needs a secret (a signing certificate, a provisioning profile, an API key) gets
it the way a job on a hosted runner does: as a repository or environment secret on GitHub,
installed by the workflow inside its VM. minitart hands nothing from the Mac to a VM.

## Why

Some jobs sign things: an iOS archive needs a distribution certificate and a provisioning
profile. With a runner on the Mac itself, those could live in the Mac's keychain and never
be uploaded anywhere. A job in a VM cannot see the Mac's keychain; that is the point of the
VM.

Two other ways were considered:

- **The Mac hands chosen files to chosen repos' VMs**: a read-only folder per repo, mounted
  into that repo's VMs only. The secret would stay on the Mac, and every job of that repo
  could read it, a pull request's included. It would be the first hole in "no shared
  folder" ([D01](D01-every-job-in-a-fresh-vm.md)).
- **The signing step runs outside the VM**, on the Mac, on the VM's output. No secret would
  enter a VM, and minitart would grow a second kind of job runner with its own trust
  questions.

Both trade the model's one clear line (nothing of the Mac's is in a VM) for a convenience.
GitHub's secrets are the mechanism workflows already have, they are scoped per repo and
per environment, and an environment can require approval before a job gets them.

## Consequences

- A workflow moves between this Mac and GitHub's runners without changing how it gets its
  secrets.
- The secret lives on GitHub. For a signing key, put it in an environment with required
  reviewers, so a pull request's job cannot ask for it.
- The VM's keychain is new for every job: the workflow creates a keychain, imports the
  certificate and deletes nothing, because the VM is deleted.
