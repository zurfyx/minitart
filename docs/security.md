# Security

minitart runs code you did not review (a dependency, a third-party action) on a Mac that
also holds your keys, your files and a place on your home network. This page says what
stands between the two, what is checked, and what is not covered.

## What a job can and cannot do

A job runs as an administrator inside its VM. Assume it controls the VM completely.

| A job…                                              |        |                                                                                                     |
| --------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| reads this Mac's files, keychain or processes       | cannot | The VM boundary: Apple's Virtualization framework. No folder is shared with a VM.                   |
| reads the clipboard                                 | cannot | VMs start with `--no-clipboard`.                                                                    |
| reaches your router, NAS, printers, other computers | cannot | Softnet forwards only to public internet addresses.                                                 |
| reaches your tailnet                                | cannot | Same, and `100.64.0.0/10` is blocked by name.                                                       |
| reaches other VMs                                   | cannot | Softnet isolates VMs from each other.                                                               |
| uses IPv6                                           | cannot | Softnet drops every frame that is not IPv4 or ARP. Read in its source; `selftest` does not test it. |
| reaches the internet                                | can    | It has to: checkouts, packages, GitHub itself.                                                      |
| reaches this Mac at the VM's gateway address        | can    | DHCP and DNS need it. See "The gateway" below.                                                      |
| leaves something for the next job                   | cannot | The VM is deleted. The next one is a new clone of the image.                                        |
| reads the GitHub App's key                          | cannot | The key never enters a VM.                                                                          |
| registers more runners, or reads other repos        | cannot | A VM holds the config of one runner for one job, already used.                                      |
| reads the config of its own runner                  | can    | It runs as the runner's user. The config is good for that one job and nothing more.                 |
| uses the secrets its own workflow was given         | can    | Those are the job's. A job that leaks them is a GitHub Actions problem.                             |
| uses the Mac's CPU, memory and disk                 | can    | Up to the VM's size. What a VM prints is kept up to 4 MB, for the newest 50 VMs.                    |

## The network is an allowlist

A VM's traffic passes through [Softnet](https://github.com/openai/softnet), a userspace
packet filter that Tart runs between the VM and the Mac. Softnet forwards a packet only if
its destination is a **globally routable IPv4 address**, or the VM's own gateway. Everything
else is dropped: every private range, link-local, carrier-grade NAT, multicast, and all of
IPv6.

That is an allowlist. Nothing about your network is listed in minitart, so nothing needs
updating when your network changes: a new VPN, a new subnet, a new overlay network like
Tailscale all use addresses that are not globally routable, and are out of reach on the day
they appear. minitart adds one explicit block, `100.64.0.0/10`, the range Tailscale uses,
so that does not rest on a definition.

**minitart does not start a VM on any other network.** If Softnet is missing or cannot run,
VMs fail to start and the dashboard says why. The one exception is the flag
`--unsafe-shared-network`, for trying minitart out before Softnet is set up: it prints a
warning on start and the dashboard shows it on every page load.

Softnet needs root to create its network interface, so its binary is setuid root. That is
set once, with `sudo`, and `minitart doctor` prints the command.

### The gateway

The VM can reach one address of the Mac: the gateway of its own virtual network
(`192.168.64.1` or similar), because DHCP and DNS are served there. A service on the Mac
that listens on **all interfaces** is therefore reachable from a job at that address.
Services bound to `127.0.0.1` are not.

`minitart selftest` tests exactly this. The dashboard itself listens on `127.0.0.1` by
default.

### Narrower than "the internet"

Softnet can also be told to deny everything and allow listed address ranges. minitart does
not use that: rules are IP ranges, not names, and the addresses behind `github.com`,
`registry.npmjs.org` or a container registry change daily. Allowing by name takes a proxy
([D19](decisions/D19-egress-by-domain.md)).

## Check it: `minitart selftest`

Promises about networks are worth what a test says. `minitart selftest` boots a VM exactly
the way a job VM boots and, from inside it, tries to connect to:

- the internet (must succeed);
- your router, on the ports routers answer on (must time out);
- this Mac, at every address it has, on common service ports (must time out).

A connection that is _refused_ counts as a failure of the test: a refusal means the packet
arrived. Run it after setting up, and again after changing how the Mac is networked.

## Which repos, and who can run code

- **A repo is served when two lists agree.** The GitHub App must be installed on it, and
  the owner must have turned it on in the dashboard. GitHub enforces the first: the App's
  token cannot register a runner anywhere else. The second is there because the first is
  easy to get wrong: GitHub's install page offers "All repositories" first, and one click
  there would otherwise put every repo of the account, present and future, on this Mac. A
  repo the App can see and nobody turned on is listed as "Not served", and its queue is not
  even read.
- **Public repos are skipped** unless you turn that off. On a public repo, anyone can open a
  pull request that changes a workflow, and that workflow would run on your Mac. The VM and
  the network would still hold, but a stranger would be choosing what your Mac runs.
- **Anyone who can push to a served repo can run code in a VM on your Mac.** That is what a
  CI runner is.

## The secrets on the Mac

| Secret                | Where                             | Lifetime                 |
| --------------------- | --------------------------------- | ------------------------ |
| The App's private key | `~/.minitart/app.json`, mode 0600 | Until you delete the App |
| An installation token | The manager's memory              | One hour                 |
| A runner's config     | Passed into its VM on stdin       | One job                  |

The key is a file, not a keychain item. A process running as you can read either (the
keychain hands an item to the tool that stored it without asking), so the keychain would add
a step and no protection. What protects the key is that jobs do not run as you: they run in
a VM.

With the key, someone could register runners on the repos the App is installed on and read
those repos' workflow logs. They could not read code or secrets: the App has no such
permission.

## The dashboard

- **It listens on `127.0.0.1` and nowhere else.** There is no option to change that, and a
  connection that did not come from the Mac is refused.
- **On your tailnet, if you set it up.** Tailscale Serve can forward a tailnet name to the
  dashboard. minitart asks Tailscale which names it forwards and answers to those. Everyone
  your tailnet lets reach that name can do everything someone at the Mac can: see every job
  and log, change which repos are served, create the GitHub App. There are no accounts in
  minitart; who gets in is your tailnet's access rules.
- **Never the internet.** A name that Tailscale Funnel publishes is not answered to, and a
  request that Tailscale marks as arriving through Funnel is refused outright. `doctor` also
  flags bare TCP forwarded to the dashboard: that carries no name to check, so do not set it
  up.
- Requests under any other `Host` are refused, so a web page cannot read the dashboard by
  pointing a name of its own at `127.0.0.1`. Changes also need a same-origin `Origin`.
- Job, workflow and repo names come from GitHub and are written to the page as text, never
  as HTML. The page loads nothing from anywhere else.

## What is not covered

- **A hypervisor escape.** If a job breaks out of Apple's Virtualization framework,
  everything above is void. Such bugs are rare and valuable. Keep macOS updated.
- **A bug in Softnet or Tart.** Same, for the network. `selftest` catches a misconfiguration,
  not a flaw.
- **The image's supply chain.** Job VMs start from an image built on your Mac from an
  upstream image (Cirrus Labs' Ubuntu and macOS images by default), plus GitHub's runner,
  whose download is checked against the checksum GitHub publishes. A bad upstream image is a
  bad VM, not a bad Mac.
- **Denial of service.** A job can use all the CPU and disk its VM has.
- **What your workflows do with their own secrets.**

## Reporting a problem

Open a private security advisory on the repository (Security, then "Report a
vulnerability"). Please do not open a public issue for something exploitable.
