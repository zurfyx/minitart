# minitart: Decision Register

The complete, ordered list of decisions that shape minitart. If something isn't decided, it
is listed here with its status.

A `DECIDED` row is not re-litigated unless new evidence appears. A new consequential
decision gets a row here and its own file in the same commit.

## Status legend

| Status       | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `DECIDED`    | Ratified. A decision file exists. Do not re-open without new evidence.   |
| `PROPOSED`   | Recommendation on the table, awaiting the owner's ratification.          |
| `OPEN`       | Genuinely undecided; needs research or the owner's call.                 |
| `DEFERRED`   | Deliberately not decided until something forces it.                      |
| `SUPERSEDED` | Replaced by a later decision, named in its file. Kept for its reasoning. |

## Blast radius

How expensive is this to get wrong?

| Radius   | Meaning                                                           |
| -------- | ----------------------------------------------------------------- |
| **HIGH** | Expensive to reverse, or a security promise. Get it right.        |
| **MED**  | Annoying to reverse: a refactor. Choose carefully, don't agonise. |
| **LOW**  | Cheap to reverse. Pick a sane default and move on.                |

---

## Tier 1: the promises

| ID                                                 | Decision                                                                                 | Radius | Status    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ | --------- |
| [D01](D01-every-job-in-a-fresh-vm.md)              | Every job runs in a fresh Tart VM, deleted when the job ends                             | HIGH   | `DECIDED` |
| [D03](D03-a-github-app-is-the-allowlist.md)        | A GitHub App is the credential; a repo is served when the App is on it and turned on     | HIGH   | `DECIDED` |
| [D04](D04-the-internet-and-nothing-private.md)     | A VM reaches the internet and nothing private; no VM starts otherwise                    | HIGH   | `DECIDED` |
| [D05](D05-private-repos-only.md)                   | Public repos are skipped unless the owner allows them                                    | MED    | `DECIDED` |
| [D21](D21-what-a-job-reaches-on-the-mac-itself.md) | A VM reaches the Mac itself for DHCP and DNS only, by a firewall rule the setup installs | HIGH   | `DECIDED` |
| [D17](D17-secrets-that-live-on-the-mac.md)         | A job gets its secrets from GitHub, never from the Mac                                   | HIGH   | `DECIDED` |

## Tier 2: how it is built

| ID                                          | Decision                                                                                  | Radius | Status     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- | ------ | ---------- |
| [D02](D02-the-manager-polls.md)             | The manager polls GitHub; nothing listens for it                                          | MED    | `DECIDED`  |
| [D06](D06-no-config-file.md)                | No file to write: defaults from the machine, changes from the dashboard, saved as JSON    | MED    | `DECIDED`  |
| [D07](D07-typescript-run-as-it-is.md)       | TypeScript that Node runs as it is: no build, no runtime dependencies                     | MED    | `DECIDED`  |
| [D08](D08-two-labels.md)                    | Two labels route jobs: `minitart-linux` and `minitart-macos`                              | LOW    | `DECIDED`  |
| [D09](D09-a-launchagent-in-your-account.md) | The manager is a LaunchAgent in whichever account runs it                                 | MED    | `DECIDED`  |
| [D10](D10-the-dashboard.md)                 | The dashboard listens on the Mac itself only, and GitHub keeps the logs                   | MED    | `DECIDED`  |
| [D11](D11-images-are-built-on-the-mac.md)   | Images are built on the Mac from an upstream image and a readable script                  | MED    | `DECIDED`  |
| [D22](D22-a-vm-needs-its-memory-first.md)   | A VM is started only when the Mac has the memory for it                                   | LOW    | `PROPOSED` |
| [D15](D15-a-static-site-on-vercel.md)       | minitart.rovira.sh is one static page, on Vercel                                          | LOW    | `DECIDED`  |
| [D20](D20-the-dashboard-on-a-tailnet.md)    | The dashboard on the tailnet, through Tailscale Serve, with the same access as at the Mac | MED    | `DECIDED`  |
| [D16](D16-how-minitart-is-installed.md)     | Installed with Homebrew, released from every green main, upgraded by `minitart upgrade`   | MED    | `DECIDED`  |

## Tier 3: how the repo is worked on

| ID                                          | Decision                                                                                           | Radius | Status    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ | --------- |
| [D12](D12-pr-workflow.md)                   | PR workflow: protected main, required checks, squash merge, no AI trailers                         | MED    | `DECIDED` |
| [D13](D13-a-pull-request-shows-its-work.md) | A pull request says it was looked at, reviewed and tested at its head commit; CI checks it says so | LOW    | `DECIDED` |
| [D14](D14-docs-are-rewritten.md)            | Docs are rewritten, never amended                                                                  | LOW    | `DECIDED` |

## Tier 4: open, or deferred until something forces it

| ID                             | Decision                                        | Status     | Forced by                                             |
| ------------------------------ | ----------------------------------------------- | ---------- | ----------------------------------------------------- |
| [D18](D18-warm-vms.md)         | Keeping VMs booted ahead of jobs                | `DEFERRED` | Boot time becoming what people wait for               |
| [D19](D19-egress-by-domain.md) | Limiting a job's internet access to named hosts | `DEFERRED` | A repo whose jobs should not reach the whole internet |
