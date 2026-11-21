# Architecture

One Node process on the Mac. It asks GitHub what is queued, starts a VM for each job, and
deletes the VM when its job ends. A page served by the same process shows what it is doing.

```
            GitHub                                  this Mac
  ┌──────────────────────┐   HTTPS, outbound   ┌────────────────────────────────────────┐
  │ queued jobs          │◄────────────────────│ minitart (src/)                        │
  │ runner registrations │   every few seconds │   manager   poll, plan, start, delete  │
  │ job logs             │                     │   dashboard 127.0.0.1:4141             │
  └──────────▲───────────┘                     │        │ tart clone / run / exec / delete
             │                                 │   ┌────▼─────────┐  ┌──────────────┐   │
             │  HTTPS, outbound                │   │ VM: one job  │  │ VM: one job  │   │
             └─────────────────────────────────│───│ runner       │  │ runner       │   │
                                               │   └──────────────┘  └──────────────┘   │
                                               └────────────────────────────────────────┘
```

Nothing connects in. The manager and the runners only make outbound HTTPS requests, so the
Mac needs no open port, no public address and no tunnel
([D02](decisions/D02-the-manager-polls.md)).

The menu bar app (`app/`, [D26](decisions/D26-a-menu-bar-app.md)) is a second client of the
dashboard on this Mac: it reads `GET /api/state` every three seconds and sends
`POST /api/drain`, and when minitart does not answer it looks for its install and its
service. The fields it reads (`app/Sources/MinitartCore/State.swift`) are a contract: rename
or remove one only with the app.

## The life of a job

1. **Poll.** Every few seconds the manager lists, for each watched repo, the workflow runs
   that have not completed, and their jobs. Requests carry the last ETag, so an unchanged
   answer costs nothing against the rate limit.
2. **Route.** A queued job is minitart's if its `runs-on` names `minitart-linux` or
   `minitart-macos` ([D08](decisions/D08-two-labels.md)). Other jobs are ignored.
3. **Plan** (`src/schedule.ts`, pure). Oldest job first: a job is covered by a VM already
   starting or waiting for its repo; otherwise it gets a new VM if its kind has a free slot.
4. **Start.** If the Mac has the memory for one more VM right now
   ([D22](decisions/D22-a-vm-needs-its-memory-first.md)); otherwise the job waits.
   `tart clone` the kind's image (copy-on-write, under a second), set CPU and memory,
   `tart run` it headless on the isolated network, and wait for the guest agent.
5. **Register.** The manager asks GitHub for a just-in-time runner config for that repo: a
   runner that exists for one job, named after the VM.
6. **Run.** `tart exec` starts the runner in the guest. The config goes in on standard input
   and reaches the runner through its environment, never as an argument. The runner takes
   one job, and its output is the VM's log.
7. **Delete.** When the runner exits, `tart stop`, `tart delete`. The job is added to the
   done list with GitHub's link to it.

A VM that no job comes for (the run was cancelled, another runner took it) is deleted after
three minutes: its runner registration is removed first, and the VM is stopped only once
GitHub has let go of it. A VM that does not boot, or whose runner has not reached GitHub
within three minutes, is deleted and the job gets another; a kind whose VMs keep failing
waits longer before each new try, up to five minutes. A VM still up five minutes after
GitHub called its job done is stopped. On start, the manager deletes any job VM left by an
earlier run: job VMs are named `minitart-<kind>-<6 hex>`, and nothing else is touched. That
is one of the two times it runs `tart list` (the other is after a VM could not be deleted):
on macOS 27 each listing leaks kernel memory, so the loop asks Tart about nothing it can
read from disk.

When the manager stops, it deletes every VM. A job that was running fails on GitHub as
"runner lost" and can be re-run. minitart records a job as lost, not failed, whenever its VM
ended before its runner said how the job ended.

## Parts

| File                                                                  | What it is                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                                                         | The command line: `start`, `doctor`, `upgrade`, `drain`, `resume`, `image build`, `selftest`, `service install` and `uninstall` |
| `src/manager.ts`                                                      | The loop above, and the state the dashboard shows                                                                               |
| `src/schedule.ts`                                                     | Which jobs are minitart's, and which VMs to start (pure)                                                                        |
| `src/tart.ts`                                                         | The `tart` command line, and the flags that isolate a VM                                                                        |
| `src/github/`                                                         | The REST client, and the GitHub App: its JWT, tokens and manifest                                                               |
| `src/server.ts`                                                       | The dashboard's HTTP server                                                                                                     |
| `src/tailnet.ts`                                                      | The tailnet names Tailscale forwards to the dashboard                                                                           |
| `src/settings.ts`                                                     | Defaults from the machine; validation of what the dashboard saves                                                               |
| `src/doctor.ts`                                                       | Is this Mac set up the way the security model assumes                                                                           |
| `src/memory.ts`                                                       | What macOS has to spare for a new VM                                                                                            |
| `src/selftest.ts`                                                     | Boots a VM and checks what it can reach                                                                                         |
| `src/image.ts`                                                        | Builds the image job VMs are cloned from, with `images/*.sh`                                                                    |
| `src/service.ts`                                                      | Installs the LaunchAgent                                                                                                        |
| `src/upgrade.ts`                                                      | `minitart upgrade`: drain, upgrade (the menu bar app too, when installed), put right, restart                                   |
| `src/version.ts`                                                      | The version a release wrote, or `0.0.0-dev` for a checkout                                                                      |
| `src/testing/`                                                        | A GitHub and a Tart in memory, for the tests and `--demo`                                                                       |
| `firewall/`                                                           | The pf rule that lets a VM reach the Mac for DHCP and DNS only                                                                  |
| `src/resources.ts`                                                    | CPU, memory and disk over the last hour, for the charts                                                                         |
| `src/pricing.ts`                                                      | Other providers' list prices, with their sources and the date read                                                              |
| `src/history.ts`                                                      | The jobs that ran, a year of them, in SQLite                                                                                    |
| `src/home.ts`                                                         | `~/.minitart`: its files, kept to the owner, and old VM logs pruned                                                             |
| `src/demo.ts`                                                         | The made-up jobs and VMs of `--demo`                                                                                            |
| `app/`                                                                | The menu bar app: a Swift package, built by `scripts/app.sh` (D26)                                                              |
| `dashboard/`                                                          | The page: plain HTML, CSS and four scripts (`app.js`, `view.js`, `charts.js`, `cost.js`), no build                              |
| `test/headline-cases.json`                                            | The headline cases the dashboard and the menu bar app are both held to                                                          |
| `Formula/`, `Casks/`, `scripts/release*.mjs`, `scripts/update-tap.sh` | The formula's and the app cask's templates, and the release tooling                                                             |
| `scripts/pr-checklist.mjs`                                            | The pr-checklist job ([D13](decisions/D13-a-pull-request-shows-its-work.md))                                                    |
| `.github/workflows/`                                                  | `ci.yml`, `pr.yml`, `release.yml`, `release-app.yml`                                                                            |
| `site/`                                                               | minitart.rovira.sh                                                                                                              |

There is no build step and no runtime dependency: Node runs the TypeScript files as they are
([D07](decisions/D07-typescript-run-as-it-is.md)).

## GitHub

minitart is a GitHub App that the owner creates from the dashboard with one click (the App
manifest flow) and installs on the repos of their choice. A repo is served when the App is
installed on it and the owner has turned it on in the dashboard
([D03](decisions/D03-a-github-app-is-the-allowlist.md)).

| Permission                     | Why                                              |
| ------------------------------ | ------------------------------------------------ |
| Administration: read and write | Register and remove a repo's self-hosted runners |
| Actions: read                  | List workflow runs and jobs; read job logs       |
| Metadata: read                 | Required by GitHub for every App                 |

The App subscribes to no events and its webhook is inactive.

| Request                                                    | When                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /app/installations`, `GET /installation/repositories` | Once a minute: what the App can see                                                |
| `POST /app/installations/{id}/access_tokens`               | When a token nears its hour                                                        |
| `GET /repos/{repo}/actions/runs?status={status}`           | Every poll, per watched repo, once for each status of a run that has not completed |
| `GET /repos/{repo}/actions/runs`                           | Every poll, per watched repo: the newest 100, for a run the lists by status miss   |
| `GET /repos/{repo}/actions/runs/{id}/jobs`                 | Every poll, per active run                                                         |
| `GET /repos/{repo}/actions/runs/{id}`                      | Once per run not seen in the lists: who triggered it                               |
| `POST /repos/{repo}/actions/runners/generate-jitconfig`    | Once per VM                                                                        |
| `DELETE /repos/{repo}/actions/runners/{id}`                | For a VM that got no job                                                           |
| `GET /repos/{repo}/actions/jobs/{id}/logs`                 | When a log is opened                                                               |

## On disk

`~/.minitart/`, readable by the owner only:

| File            | What                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| `app.json`      | The App's id and private key. The one secret.                          |
| `settings.json` | The repos that are served, and what the owner changed in the dashboard |
| `images.json`   | The runner version each image was built with, and when                 |
| `history.db`    | Every job that ran, a year of them, in SQLite (D24)                    |
| `logs/`         | The manager's log and each VM's output                                 |

Everything else is rebuilt from GitHub and Tart on start.

## The dashboard

`http://127.0.0.1:4141`, served by the manager ([D10](decisions/D10-the-dashboard.md)).

- `GET /api/state`, and `GET /api/events` (server-sent events): running, queued, done,
  repos, health, activity.
- `GET /api/resources`: the last hour of CPU and memory, a point every ten seconds, and the
  disk (`src/resources.ts`, [D23](decisions/D23-what-the-dashboard-leads-with.md)). Apart
  from the state, which is sent on every change.
- `GET /api/vms/{name}/log`: what a VM printed, from memory while it runs and from
  `~/.minitart/logs` after it ends (the newest 50 VMs). `GET /api/jobs/{id}/log`: a finished
  job's log, fetched from GitHub, for jobs minitart ran.
- `GET /api/jobs?page=&repo=&result=&days=`: the history, 50 jobs a page, newest first, of
  one repo, one result and the last few days if asked, with how many ended each way
  ([D24](decisions/D24-a-year-of-history-in-sqlite.md)).
- `GET /api/usage?days=`: each day's minutes by kind, and the price list
  ([D25](decisions/D25-usage-and-list-prices.md)).
- `GET /api/storage`: what the history, the VM logs and minitart's own log take, and how
  long jobs are kept.
- `POST /api/settings`: which repos are served, VM counts and size, timings, and the Usage
  view's choices: the providers and runners compared, and what this Mac costs.
- `POST /api/drain`: start no new jobs and let the running ones finish, or resume.
- `GET /setup/manifest`, `GET /setup/callback`: creating the GitHub App.
- `GET /manifest.webmanifest` and the icons: what makes the page an app a browser can
  install. There is no service worker: the page is live from minitart or nothing, and one
  could keep serving an old page after an upgrade.

It listens on `127.0.0.1` and answers only connections from the Mac itself. To be on the
owner's tailnet, Tailscale Serve forwards a tailnet name to that port, and minitart answers
to the names `tailscale serve status` says are forwarded there
([D20](decisions/D20-the-dashboard-on-a-tailnet.md), `src/tailnet.ts`).
