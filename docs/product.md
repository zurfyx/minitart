# Product

minitart runs your GitHub Actions jobs on a Mac you own. Every job gets a fresh virtual
machine, cloned from an image in under a second and deleted when the job ends. It is a
manager and a dashboard, a few hundred lines each, on top of three things other people
maintain: Apple's hypervisor, [Tart](https://tart.run) and GitHub's own runner.

## Who it is for

One person with a Mac mini (or a Mac Studio, or a laptop that stays plugged in) and a
handful of private repos, who wants:

- macOS and Linux jobs on the same machine, faster and cheaper than hosted runners;
- the isolation hosted runners give, so a job cannot read the Mac's files or reach the home
  network;
- to see what is queued, running and done, and read the logs, on one page;
- something small enough to read in an afternoon.

It is not for a team with a fleet. Nothing in it coordinates several Macs, scales to zero in
a cloud, or has accounts and roles. Tools that do that exist; minitart stays small on
purpose.

## What it promises

1. **A job runs in a VM that did not exist before it and does not exist after it.** Nothing
   a job writes, installs or leaves running reaches the next job.
2. **A job reaches the internet and nothing of yours.** Not this Mac's files, not its
   keychain, not your router, not your NAS, not your tailnet. The network is an allowlist:
   public internet addresses, and nothing else ([security](security.md)).
3. **GitHub decides which repos are served.** The allowlist is the list of repos the GitHub
   App is installed on, changed on GitHub and nowhere else. Public repos are skipped unless
   you say otherwise.
4. **No secret a job can use against you.** A VM holds one thing of value: the single-use
   config of its own runner. The App's key stays on the Mac.
5. **Nothing to configure by hand.** No config file. How many VMs run at once starts from
   what the Mac can hold and is changed in the dashboard.
6. **Going back is one line.** A workflow asks for minitart with a label; change the label
   and the job runs on GitHub's runners again.

## Using it

A workflow asks for a kind of VM:

```yaml
jobs:
  test:
    runs-on: minitart-linux # or minitart-macos
```

To switch between your Mac and GitHub's runners without editing workflows, read the label
from a repository variable:

```yaml
runs-on: ${{ vars.RUNNER_LINUX || 'ubuntu-latest' }}
```

Set `RUNNER_LINUX` to `minitart-linux` to use the Mac; delete the variable to go back.

Linux VMs are arm64, like the Mac. A job that needs x86 (an amd64-only container image, an
x86 binary) stays on `ubuntu-latest`; that is a choice each repo makes, job by job.

## What it does not do

- **No fallback.** If the Mac is off or asleep, jobs wait in GitHub's queue.
- **No x86.** See above.
- **No secrets from the Mac.** A job gets its secrets from GitHub, like on a hosted runner,
  signing keys included ([D17](decisions/D17-secrets-that-live-on-the-mac.md)).
- **No warm caches between jobs.** That is the price of promise 1; use `actions/cache`, or
  put what every job needs into the image.
