# D13: A pull request says it was looked at, reviewed and tested at its head commit

Status: `DECIDED`

## Decision

The pull request template has a "Before review" checklist and a `Verified at: <sha>` line.
The `pr-checklist` job (`scripts/pr-checklist.mjs`) fails until every box is ticked,
`Verified at` names the head commit, and a change under `dashboard/` or `site/` carries a
screenshot or the line `No visual change: <reason>`.

A new push makes the job fail again until the line is updated.

## Why

CI has no AI in it: it cannot look at a screen or review a diff. It can check that whoever
opened the pull request says they did, for the commit that is now its head. It is a nudge,
not a lock.

## Consequences

- Dependabot's pull requests are exempt.
