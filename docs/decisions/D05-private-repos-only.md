# D05: Public repos are skipped unless the owner allows them

Status: `DECIDED`

## Decision

If the App is installed on a public repo, minitart lists it as "Public, skipped" and starts
no VM for it. One setting, `allowPublicRepos`, turns that off for all of them.

## Why

On a public repo anyone can open a pull request from a fork, and depending on the repo's
settings its workflows run without anyone approving them. GitHub's own advice is never to
attach a self-hosted runner to a public repo.

With D01 and D04 a stranger's job would be contained: it could not touch the Mac or the
network. It would still be a stranger deciding what the Mac spends its CPU on, and reaching
whatever the workflow hands it. The safe default costs nothing, since public repos get
GitHub's hosted runners free.

## Consequences

- minitart's own CI runs on GitHub's runners.
- An owner who turns the setting on should require approval for fork pull requests in the
  repo's Actions settings.
