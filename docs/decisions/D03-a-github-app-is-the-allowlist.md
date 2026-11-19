# D03: A GitHub App is the credential; a repo is served when the App is on it and the owner turned it on

Status: `DECIDED`

## Decision

minitart authenticates as a GitHub App that belongs to the owner. The dashboard creates it
with GitHub's App manifest flow: one click on the Mac, one on GitHub. The owner then
installs it on "Only select repositories".

**A repo is served when two lists agree**: the App is installed on it, and the owner has
turned it on in the dashboard (`repos` in the settings). A fresh install serves nothing. A
repo the App can see and nobody turned on shows as "Not served", and its queue is not read.

The App asks for: Administration read and write (registering runners), Actions read (the
queue and the logs), Metadata read. It subscribes to no events.

The App's private key is stored in `~/.minitart/app.json`, mode 0600, and never enters a VM.

## Why

- **GitHub enforces the allowlist.** A bug in minitart cannot register a runner on a repo
  the App is not installed on; the token does not allow it.
- **The second list catches the easy mistake.** GitHub's install page offers "All
  repositories" first, and most people click it. With the installation as the only list,
  that one click would put every repo of the account, present and future, on the Mac. The
  list in minitart is visible, short, and off by default; the two can only disagree in the
  safe direction, since a repo needs both.
- **Least privilege that a personal access token cannot match.** Its tokens cannot read code
  or secrets directly (though its key, if stolen, reaches both through Administration and
  through runners that are handed jobs: [security.md](../security.md)). Its tokens last an
  hour. A classic token with `repo` scope can do everything the owner can.
- **A file, not the keychain**: a process running as the owner can read a keychain item
  through the tool that stored it, without a prompt. The keychain would add a step and no
  protection. What protects the key is that jobs run in VMs.

## Consequences

- Setup has a step on GitHub that cannot be skipped: creating and installing the App. And
  one more click per repo in the dashboard.
- "Administration: write" is broader than runners; GitHub has no narrower permission for
  repo-level runners. Someone holding the key could change repo settings on the installed
  repos. This is the main reason the key never leaves the Mac.
- Repos under several accounts work: the App is installed once per account.
