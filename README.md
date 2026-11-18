# minitart

**GitHub Actions runners on your own Mac mini.** minitart runs every job in a fresh virtual
machine and deletes it when the job ends. A job reaches the internet and nothing of yours:
not your files, not your keychain, not your home network.

It is a very small manager, with a dashboard, on top of three things other people maintain:
Apple's hypervisor, [Tart](https://tart.run) and GitHub's own runner. It is for one person
with one Mac and a handful of private repos. [minitart.rovira.sh](https://minitart.rovira.sh)

![The minitart dashboard](site/dashboard-light.png)

> **Early.** Built for one Mac mini. Read [the security model](docs/security.md), and the
> code, before you trust it with yours.

## What you get

- **macOS and Linux jobs on the same Mac.** Up to two macOS VMs (Apple's limit) and as many
  Linux VMs as the memory holds. Linux VMs have Docker.
- **A clean machine for every job.** A VM is cloned in under a second, runs one job, and is
  deleted.
- **A network that is an allowlist.** A VM can send to public internet addresses and nowhere
  else. Your router, your NAS and your tailnet are out of reach without being listed.
- **You choose the repos twice.** minitart is a GitHub App you create in one click and
  install on repos; a repo is served once you also turn it on in the dashboard. Installing
  the App on your whole account by mistake serves nothing. Public repos are skipped.
- **Nothing to configure by hand.** No file to write. VM counts start from what the Mac can
  hold and change in the dashboard, which saves them as plain JSON you can back up.
- **A dashboard**: what is queued, running and done, with logs. On the Mac itself, or on
  your Tailscale tailnet if you want it there.
- **Small enough to read.** TypeScript that Node runs as it is; no build, no runtime
  dependencies.

## Use it in a workflow

```yaml
jobs:
  test:
    runs-on: minitart-linux # or minitart-macos
```

To switch between your Mac and GitHub's runners without editing workflows:

```yaml
runs-on: ${{ vars.RUNNER_LINUX || 'ubuntu-latest' }}
```

Set the repository variable `RUNNER_LINUX` to `minitart-linux` to use the Mac. Delete it to
go back.

## Set it up

You need an Apple silicon Mac on macOS 26 or newer, Node 24 or newer, and Homebrew. The
short version is below; [docs/setup.md](docs/setup.md) is the full one, step by step, with
how to tell each step worked and which three need you in person.

```bash
brew install openai/tools/tart openai/tools/softnet
git clone https://github.com/zurfyx/minitart && cd minitart

node src/main.ts doctor              # says what is missing, and the command that fixes it
node src/main.ts image build linux   # under a minute
node src/main.ts image build macos   # downloads tens of gigabytes the first time
node src/main.ts selftest            # boots a VM and checks what it can reach
node src/main.ts start               # the manager, and the dashboard at 127.0.0.1:4141
```

`doctor` will ask for three things that need `sudo`, once: letting Softnet (the network
filter) run as root, a firewall rule that keeps VMs off the Mac's own services, and
stopping the Mac from sleeping.

Then open <http://127.0.0.1:4141> on the Mac, click **Create the GitHub App**, and on
GitHub choose "Only select repositories" and pick yours. Back in the dashboard, click
**Serve** on each. Jobs with a minitart label start running.

To keep it running across restarts:

```bash
node src/main.ts service install     # a LaunchAgent: starts at login, restarts if it stops
```

The Mac has to stay logged in. After a restart nothing runs until someone logs in, unless
automatic login is on, and that needs FileVault off. Which you prefer is yours to choose;
`doctor` tells you where you stand.

### What a job starts with

The Linux image is Ubuntu with Docker and a 50 GB disk. The macOS image is Cirrus Labs'
base image, which has no Xcode. For iOS and macOS builds, start from one that does:

```bash
node src/main.ts image build macos --from ghcr.io/cirruslabs/macos-tahoe-xcode:latest
```

Rebuild an image when `doctor` says its runner has fallen behind: GitHub stops accepting old
runner versions a few weeks after a new one is out.

### When jobs do not start

- **The dashboard says a VM failed to start.** Open the VM's log from the Activity list; the
  last line is what Tart said. A third macOS VM is refused by macOS itself, and that
  includes a macOS VM of your own, or an image being built.
- **"Its runner never reached GitHub."** The VM booted and could not get out. A VPN on the
  Mac with a small MTU (an exit node, a corporate VPN) stalls TLS inside VMs.
- **Nothing happens at all.** `node src/main.ts doctor`.

## What it does not do

- **No fallback.** If the Mac is off or asleep, jobs wait in GitHub's queue.
- **No x86.** Linux VMs are arm64. Jobs that need x86 stay on `ubuntu-latest`.
- **No caches between jobs.** Use `actions/cache`, or put what every job needs in the image.
- **No secrets from the Mac.** A job gets its secrets from GitHub, as on a hosted runner.
- **No fleets.** One Mac.

## Read more

- [Product](docs/product.md): what it is and what it promises
- [Architecture](docs/architecture.md): how it works, in one page
- [Security](docs/security.md): what a job can and cannot do, and what is not covered
- [Decisions](docs/decisions/README.md): every consequential choice, with its reasons

## Licence

MIT. Tart and Softnet have their own licences (source-available; free for this use).
