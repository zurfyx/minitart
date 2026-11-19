# Setup

Setting minitart up on a Mac, from nothing to jobs running. Written to be followed top to
bottom by a person or by a coding agent working on the Mac. Every step says how to tell it
worked.

Three steps need the owner in person, and no agent can do them. They are marked **Owner**:

- three commands that need the Mac's password (`sudo`);
- creating the GitHub App, which GitHub only does from a logged-in browser;
- choosing how the Mac behaves after a restart.

Everything else is commands.

## 0. What you need

- An Apple silicon Mac on macOS 26 or newer, that stays on.
- Node 24 or newer (`node --version`), and Homebrew.
- About 30 GB of free disk for Linux jobs, and 60 GB more for macOS jobs.

## 1. Install

```bash
brew install zurfyx/tap/minitart
minitart doctor --fix
```

The first line installs minitart. The second installs what it drives, Tart and Softnet, from
their own tap if they are missing, and then does steps 2 and 3 below, asking for the Mac's
password once. `minitart doctor`, without `--fix`, only looks: it prints what is missing and
the command for each, if you would rather run them yourself.

Tart and Softnet are not installed with minitart by Homebrew itself, because Homebrew stops
an install that needs a formula from a tap it has not been told to trust. `doctor --fix`
shows the two formulae it trusts before it does.

It also pins Softnet, so that a routine `brew upgrade` does not replace its binary, which
would cost it the permission of step 2. `minitart upgrade` is what upgrades it (see
"Later").

Check: `minitart doctor` prints a list with no `FIX` for Tart, Network, Firewall or Sleep.
What is left are the steps from 4 on.

If you skip this line, nothing unsafe happens and nothing runs: minitart starts no VM on a
Mac whose network is not closed. Jobs wait on GitHub, and `minitart doctor` and the
dashboard both say that this is the step that is missing.

To run it from the source instead, clone the repo and write `node src/main.ts` wherever
this page says `minitart`.

## 2. Close the network (**Owner**, `sudo`)

`doctor --fix` did this in step 1 if you let it. This is what it did, and how to do it by
hand. Two things keep a job to the internet. Both need the Mac's password, once.

**Softnet** is what keeps a job off your home network, and it needs root to create its
network interface. `doctor` prints the exact line, with the path on your Mac:

```bash
sudo chown root /opt/homebrew/Cellar/softnet/<version>/bin/softnet
sudo chmod u+s /opt/homebrew/Cellar/softnet/<version>/bin/softnet
```

A Homebrew upgrade of Softnet installs a new binary, and this is needed again. `doctor` and
the dashboard say so.

**The firewall rule** is what keeps a job off the Mac itself. A VM can always reach the Mac
at one address, for DHCP and DNS, and macOS serves other things there too (AirPlay,
Handoff, sharing). The rule lets DHCP and DNS through and drops the rest. `doctor` prints
the line, a `sudo sh …/firewall/install.sh`.

It writes two files (`/etc/pf.anchors/minitart` and a LaunchDaemon that loads it at boot)
and touches nothing else. Read it first if you like: it is short. Its neighbour,
`uninstall.sh`, removes it.

Instead of copying the lines, `minitart doctor --fix` runs these and step 3 for you, asking
for the password once.

Check: `doctor` shows `ok  Network: Softnet: jobs reach the internet and nothing private` and
`ok  Firewall: A VM reaches this Mac for DHCP and DNS only`. Step 5 tests both for real.

## 3. Keep the Mac awake (**Owner**, `sudo`)

```bash
sudo pmset -a sleep 0
```

Check: `doctor` shows `ok  Sleep: This Mac stays awake`.

## 4. Build the images

```bash
minitart image build linux     # about a minute
minitart image build macos     # downloads tens of gigabytes the first time
```

Skip the one you do not need, and set that kind to 0 VMs in the dashboard later. For jobs
that need Xcode, build the macOS image from one that has it:

```bash
minitart image build macos --from ghcr.io/cirruslabs/macos-tahoe-xcode:latest
```

Check: `doctor` shows `ok` for each image you built.

## 5. Test the isolation

```bash
minitart selftest
```

It boots a VM the way a job VM boots and, from inside it, tries to reach the internet (must
work), your router and this Mac on every address it has (must not), and the VM's own
gateway, which is also this Mac, on the ports this Mac serves to every network (none may be
open).

Check: it ends with `A job reaches the internet and nothing of yours.` **Do not go on until
it does.** A `FAIL` line names what a job could reach. A port open at the VM's gateway is a
service of this Mac that a job can talk to, with the program's name beside it; it means the
firewall rule of step 2 is not installed or not loaded.

## 6. Start it

```bash
minitart start
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

Back in the dashboard, the **Repos** section lists the repos you picked, each `Not served`.
Click **Serve** on the ones this Mac should run jobs for. A repo is served only when the App
is installed on it _and_ it is turned on here, so choosing "All repositories" by mistake
serves nothing.

Check: those repos show `Watching`. A public repo shows `Public, skipped`; that is the
default, on purpose.

To install the App on more repos later, use the link under the list. It goes to the App's
page on GitHub.

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

Stop the one you started in step 6 (Ctrl-C), then:

```bash
brew services start minitart
```

It starts at login and comes back if it stops. (From a source checkout:
`node src/main.ts service install`.)

Check: `brew services list` shows `minitart  started`, and the dashboard still opens. The
log is `/opt/homebrew/var/log/minitart.log`.

## 10. Decide what happens after a restart (**Owner**)

minitart starts when you log in. After a power cut, nothing runs until someone logs in,
unless the Mac logs in by itself, and macOS allows that only with FileVault off.

- **Keep FileVault on** (the disk stays encrypted): log in after a restart. Jobs wait in
  GitHub's queue meanwhile.
- **Turn FileVault off and automatic login on** (System Settings, Users & Groups): the Mac
  comes back by itself. Anyone with the Mac in their hands can read its disk.

`doctor` shows which one you have, as a note.

## 11. Optional: the dashboard on your tailnet

To open the dashboard from your phone or laptop, let Tailscale forward a name on your
tailnet to it. minitart keeps listening on `127.0.0.1` only; it notices what Tailscale
forwards and answers to it, within half a minute. **Everyone your tailnet lets reach that name
can do everything you can do at the Mac.**

For a name of its own, `https://minitart.<tailnet>.ts.net`, use a Tailscale Service. Part of
it is in Tailscale's admin console (**Owner**):

1. Console, Services: create `minitart` with port `tcp:443`.
2. A Service is hosted by a tagged machine. If this Mac is not tagged yet, define a tag in
   the policy file (`"tagOwners": { "tag:server": ["autogroup:admin"] }`) and give it to the
   Mac (Machines, Edit ACL tags).
3. Policy file: a Service is not covered by wildcard rules. Add
   `{"src": ["*"], "dst": ["svc:minitart"], "ip": ["*"]}`, or name the users who may reach it
   instead of `*`.

Then on the Mac:

```bash
tailscale serve --service=svc:minitart --https=443 http://127.0.0.1:4141
```

and approve the Mac as the Service's host in the console.

Without a Service, a port on the Mac's own tailnet name works too, with nothing to do in the
console: `tailscale serve --bg --https=8443 http://127.0.0.1:4141`.

Check: `minitart doctor` shows `ok  Tailnet: The dashboard is at https://…`, and that
address opens from another device on your tailnet. The first request can take a few seconds
while Tailscale gets the certificate.

Use `--https`, as above: minitart does not answer to a plain-HTTP name. And do not use
`tailscale funnel` for it: that publishes to the internet, and minitart refuses whatever
comes in that way. If `doctor` shows a `FIX  Tailnet` line, it comes with the command that
puts that one name right; `tailscale funnel reset` is not it, since it removes every
forward on the Mac.

## 12. Optional: the dashboard as an app

The dashboard can be installed as an app, with its own window and a place in the Dock, from
`http://127.0.0.1:4141` or from its tailnet name. In Chrome or Edge: the install button at
the end of the address bar. In Safari: **File → Add to Dock**. On an iPhone or iPad, from
the tailnet name: **Share → Add to Home Screen**. Installed from both, it is two apps, one
for each address.

It is the same page, live from minitart: it needs minitart running, and shows nothing
offline.

## 13. Optional: minitart in the menu bar

```sh
brew install --cask zurfyx/tap/minitart-app
```

It installs minitart too, if it is not yet. The menu bar shows minitart's mark, a Mac mini with
a screen: the number of jobs running on the screen, an exclamation mark when it needs you, and
a pause sign when it is draining.
Its menu has the dashboard's headline, the jobs running, Open Dashboard and Drain. When
minitart is not running or not set up, it says so and offers to start it, or to finish the
setup in Terminal. Turn on Settings → Open at Login to keep it there. `minitart upgrade`
upgrades it with the rest ([D26](decisions/D26-a-menu-bar-app.md)).

## Later

- **`doctor` says a runner is behind.** GitHub stops accepting old runner versions some
  weeks after a new one is out. Rebuild that image (step 4); it replaces the old one only
  when the build succeeds.
- **Upgrading.** `minitart upgrade`, not `brew upgrade`. It lets running jobs finish and
  starts no new ones, upgrades minitart, Tart and Softnet together, asks for the Mac's
  password once to give the new Softnet its permission back, restarts minitart, and runs
  `doctor`. `doctor` and the dashboard say when a newer minitart is out. With `--now` it
  does not wait: running jobs fail on GitHub and can be re-run.
- **The Mac is busy with something else.** minitart starts a VM only when the Mac has the
  memory for it at that moment; otherwise the job waits and the dashboard says so. To give
  jobs less of the Mac for good, lower the VM counts or the memory per VM in the dashboard.
- **Pausing for something else.** `minitart drain` starts no new jobs and lets the running
  ones finish; `minitart resume`, or a restart, undoes it.
- **Backing up.** `~/.minitart/settings.json` is the whole configuration: the repos that
  are served, VM counts and size, timings. It is plain JSON, written by the dashboard and
  checked every time it is read. `~/.minitart/app.json` holds the App's key: back it up like
  a password, or do not, and create a new App on a new Mac.
- **Seeing the dashboard from another device.** Step 11.
- **Running it as its own macOS user.** It works: do every step above logged in as that
  user, and make it the user that logs in automatically
  ([D09](decisions/D09-a-launchagent-in-your-account.md)).
- **Removing it.** `brew services stop minitart`, delete the App on GitHub (Settings,
  Developer settings, GitHub Apps), run the firewall's `uninstall.sh` with `sudo` (it is
  beside `install.sh`, whose path `doctor` printed), then `brew uninstall minitart`, and
  delete `~/.minitart` and the two images
  (`tart delete minitart-base-linux minitart-base-macos`).
