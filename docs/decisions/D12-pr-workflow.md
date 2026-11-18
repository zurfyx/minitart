# D12: PR workflow: protected main, required checks, squash merge

Status: `DECIDED`

## Decision

- `main` is protected: changes land only through pull requests, administrators included.
- Branch per unit of work: `feat/`, `fix/`, `docs/`, `chore/`.
- Required status checks: `static`, `test` and `pr-checklist` (the CI job names; renaming a
  job means updating the rule in the same change). Branches must be up to date before
  merging.
- Squash merge only, so `main` is one commit per pull request.
- **The owner reviews every pull request and merges it himself.** Green checks are a
  precondition, never the trigger: agents open pull requests and stop there.
- Commits have concise imperative subjects, are authored by the repo owner, and carry no AI
  trailers. Pull request descriptions carry no AI attribution. `.claude/settings.json` turns
  both off.

## Why

The same workflow as the owner's other repos. Here it matters more than usual: this code
holds a credential with administration rights on the owner's repos, so nothing reaches
`main` unread.

## Consequences

- Pushes to `main` deploy the website ([D15](D15-a-static-site-on-vercel.md)).
- CI runs on GitHub's hosted runners: the repo is public
  ([D05](D05-private-repos-only.md)).
