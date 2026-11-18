# D03: A GitHub App is the credential, and its installation is the repo allowlist

Status: `PROPOSED`

## Decision

minitart authenticates as a GitHub App that belongs to the owner. The dashboard creates it
with GitHub's App manifest flow: one click on the Mac, one on GitHub. The owner then installs
it on "Only select repositories".

**The repos minitart serves are the repos the App is installed on.** There is no second list
on the Mac. Adding or removing a repo is done on GitHub.

The App asks for: Administration read and write (registering runners), Actions read (the
queue and the logs), Metadata read. It subscribes to no events.

The App's private key is stored in `~/.minitart/app.json`, mode 0600, and never enters a VM.

## Why

- **GitHub enforces the allowlist.** A bug in minitart cannot register a runner on a repo
  the App is not installed on; the token does not allow it.
- **Nothing to keep in sync.** A list in a config file would be a second source of truth
  that can only disagree with the first.
- **Least privilege that a personal access token cannot match.** The App cannot read code or
  secrets. Its tokens last an hour. A classic token with `repo` scope can do everything the
  owner can.
- **A file, not the keychain**: a process running as the owner can read a keychain item
  through the tool that stored it, without a prompt. The keychain would add a step and no
  protection. What protects the key is that jobs run in VMs.

## Consequences

- Setup has a step on GitHub that cannot be skipped: creating and installing the App.
- "Administration: write" is broader than runners; GitHub has no narrower permission for
  repo-level runners. Someone holding the key could change repo settings on the installed
  repos. This is the main reason the key never leaves the Mac.
- Repos under several accounts work: the App is installed once per account.
