# Releases

Nobody cuts a release, picks a version or edits one. Merging to `main` does it
([D16](decisions/D16-how-minitart-is-installed.md)).

## What happens on a push to main

`.github/workflows/release.yml`, three jobs, and only on `main`:

1. **check.** The same gate as CI, on that commit. It is a job of its own so that the tools
   it installs never touch what is packed and never hold a token that can publish.
2. **release.** A clean checkout and Node, nothing installed. `scripts/release.mjs plan`
   decides: if nothing that ships has changed since the last tag (`src/`, `dashboard/`,
   `images/`, `firewall/`, `package.json`, tests aside), nothing happens. Otherwise the
   version is the next patch after the highest `v*` tag. `scripts/release.mjs pack` builds
   `minitart-<version>.tar.gz` and its `.sha256`: what ships, the docs, a `VERSION` file,
   and a `package.json` with the version in it. The same commit always packs to the same
   bytes. The tag and the GitHub release are created with both files. A commit that does
   not have the newest release in its history (an old run started again) releases nothing.
3. **tap.** `scripts/update-tap.sh` makes `zurfyx/homebrew-tap` match the newest release:
   it renders `Formula/minitart.rb` (the template in this repo, with its `url`, `version`
   and `sha256` lines filled in from the published checksum), opens a pull request on the
   tap as the release bot, waits for the tap's CI to install and test the formula, and
   merges it. A tap that is already right is left alone, and a proposal is always rebuilt on
   the tap's current `main`, so the job is safe to run again, and other projects releasing
   into the same tap do not get in its way.

The source keeps `0.0.0` everywhere: `package.json`, the formula template. `0.0.0` can never
be published, and a checkout calls itself `0.0.0-dev`.

## The release bot

The tap job acts as a GitHub App, because a pull request opened with a workflow's own token
does not start the tap's CI. Set up once, by the owner:

- The App is installed on `minitart` and on `homebrew-tap`, with `Contents` and
  `Pull requests` read and write on the tap.
- This repo has the Actions variable `RELEASE_APP_ID`, and its `release` environment, which
  only protected branches may use, has the secret `RELEASE_APP_PRIVATE_KEY`.

Until the variable exists the tap job is skipped, and releases are still published.

## By hand

- **Catch the tap up** (the App was set up later, or a run failed halfway): run the Release
  workflow from the Actions page, or `gh workflow run release.yml --ref main`.
- **Start a new minor or major**: tag the commit yourself, `git tag v0.2.0 <sha>` and push
  the tag. The next releases are `0.2.1`, `0.2.2`, and so on. That tag has no archive, so
  let the next push to `main` publish the first installable one.
- **See what a push would do**: `node scripts/release.mjs plan`.
- **Try the formula** before it reaches the tap: `node scripts/release.mjs pack 9.9.9 /tmp/out`
  and `node scripts/release.mjs formula 9.9.9 <sha256>`, into a tap of your own made with
  `brew tap-new`.
