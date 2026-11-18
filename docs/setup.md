# Setup

Setting minitart up on a Mac, from nothing to jobs running. Written to be followed top to
bottom by a person or by a coding agent working on the Mac. Every step says how to tell it
worked.

Three steps need the owner in person, and no agent can do them. They are marked **Owner**:

- two commands that need the Mac's password (`sudo`);
- creating the GitHub App, which GitHub only does from a logged-in browser;
- choosing how the Mac behaves after a restart.

Everything else is commands.

## 0. What you need

- An Apple silicon Mac on macOS 26 or newer, that stays on.
- Node 24 or newer (`node --version`), and Homebrew.
- About 30 GB of free disk for Linux jobs, and 60 GB more for macOS jobs.

## 1. Install

```bash
brew install openai/tools/tart openai/tools/softnet
git clone https://github.com/zurfyx/minitart ~/minitart
cd ~/minitart
```

Homebrew may ask to trust the `openai/tools` tap first: `brew trust openai/tools`.

Check: `node src/main.ts doctor` prints a list. Lines marked `FIX` are the steps below; each
comes with its command.

## 2. Let the network filter run (**Owner**, `sudo`)

Softnet is what keeps a job off your home network, and it needs root to create its network
interface. `doctor` prints the exact line, with the path on your Mac:

```bash
sudo chown root /opt/homebrew/Cellar/softnet/<version>/bin/softnet
sudo chmod u+s /opt/homebrew/Cellar/softnet/<version>/bin/softnet
```

Check: `doctor` shows `ok  Network: Softnet: jobs reach the internet and nothing private`.

A Homebrew upgrade of Softnet installs a new binary, and this step is needed again. `doctor`
and the dashboard say so.

## 3. Keep the Mac awake (**Owner**, `sudo`)

```bash
sudo pmset -a sleep 0
```

Check: `doctor` shows `ok  Sleep: This Mac stays awake`.

## 4. Build the images

```bash
node src/main.ts image build linux     # about a minute
node src/main.ts image build macos     # downloads tens of gigabytes the first time
```

Skip the one you do not need, and set that kind to 0 VMs in the dashboard later. For jobs
that need Xcode, build the macOS image from one that has it:

```bash
node src/main.ts image build macos --from ghcr.io/cirruslabs/macos-tahoe-xcode:latest
```

Check: `doctor` shows `ok` for each image you built.

## 5. Test the isolation

```bash
node src/main.ts selftest
```

It boots a VM the way a job VM boots and, from inside it, tries to reach the internet (must
work), and your router and this Mac on every address it has (must not).

Check: it ends with `A job reaches the internet and nothing of yours.` **Do not go on until
it does.** A `FAIL` line names what a job could reach: usually a service on the Mac that
listens on every network interface (AirPlay Receiver on port 5000 is a common one; turn it
off in System Settings, General, AirDrop & Handoff).

## 6. Start it

```bash
node src/main.ts start
```

Check: it prints `the dashboard is at http://127.0.0.1:4141`, and that page opens in a
browser on the Mac.

## 7. Create the GitHub App (**Owner**, in a browser on the Mac)

minitart talks to GitHub as a GitHub App that belongs to you. GitHub creates an App only
from a browser that is logged in as you, so this is two clicks nobody can make for you:

1. On the Mac, open <http://127.0.0.1:4141> and click **Create the GitHub App**. GitHub
   shows the App's name and permissions, already filled in. Confirm.
2. GitHub then asks where to install it. Choose **Only select repositories**, and pick the
   repos whose jobs this Mac should run.

The App's key is saved to `~/.minitart/app.json` by itself. It has to be a browser on the
Mac: the dashboard refuses setup from any other machine.

Check: the dashboard's **Repos** section lists the repos you picked, each `Watching`. A
public repo shows `Public, skipped`; that is the default, on purpose.

To add or remove repos later, use the link under the list. It goes to the App's page on
GitHub.

## 8. Point a workflow at it

In a repo you picked:

```yaml
jobs:
  test:
    runs-on: minitart-linux # or minitart-macos
```

Check: push it. The job appears under **Queued** in the dashboard, then **Running** with its
VM, then **Done**. Afterwards `tart list` shows no `minitart-linux-…` VM.

## 9. Keep it running

```bash
node src/main.ts service install
```

This stops nothing you started in step 6 by itself: stop that one first (Ctrl-C).

Check: `launchctl print gui/$(id -u)/sh.rovira.minitart` shows `state = running`, and the
dashboard still opens. The log is `~/.minitart/logs/manager.log`.

## 10. Decide what happens after a restart (**Owner**)

minitart starts when you log in. After a power cut, nothing runs until someone logs in,
unless the Mac logs in by itself, and macOS allows that only with FileVault off.

- **Keep FileVault on** (the disk stays encrypted): log in after a restart. Jobs wait in
  GitHub's queue meanwhile.
- **Turn FileVault off and automatic login on** (System Settings, Users & Groups): the Mac
  comes back by itself. Anyone with the Mac in their hands can read its disk.

`doctor` shows which one you have, as a note.

## Later

- **`doctor` says a runner is behind.** GitHub stops accepting old runner versions some
  weeks after a new one is out. Rebuild that image (step 4); it replaces the old one only
  when the build succeeds.
- **Updating minitart.** `git pull`, then `node src/main.ts service install` again.
- **Seeing the dashboard from another device.** Add `--host <the Mac's address on your
tailnet>` to `start` or `service install`. From there it is read-only, and everyone who
  can reach that address can read it.
- **Removing it.** `node src/main.ts service uninstall`, delete the App on GitHub (Settings,
  Developer settings, GitHub Apps), and delete `~/.minitart` and the two images
  (`tart delete minitart-base-linux minitart-base-macos`).
