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
Mac needs no open port, no public address and no tunnel ([D02](decisions/D02-the-manager-polls.md)).

## The life of a job

1. **Poll.** Every few seconds the manager lists, for each watched repo, the workflow runs
   that have not completed, and their jobs. Requests carry the last ETag, so an unchanged
   answer costs nothing against the rate limit.
2. **Route.** A queued job is minitart's if its `runs-on` names `minitart-linux` or
   `minitart-macos` ([D08](decisions/D08-two-labels.md)). Other jobs are ignored.
3. **Plan** (`src/schedule.ts`, pure). Oldest job first: a job is covered by a VM already
   starting or waiting for its repo; otherwise it gets a new VM if its kind has a free slot.
4. **Start.** `tart clone` the kind's image (copy-on-write, under a second), set CPU and
   memory, `tart run` it headless on the isolated network, and wait for the guest agent.
5. **Register.** The manager asks GitHub for a just-in-time runner config for that repo: a
   runner that exists for one job, named after the VM.
6. **Run.** `tart exec` starts the runner in the guest. The config goes in on standard
   input and reaches the runner through its environment, never as an argument. The runner
   takes one job, and its output is the VM's log.
7. **Delete.** When the runner exits, `tart stop`, `tart delete`. The job is added to the
   done list with GitHub's link to it.

A VM that no job comes for (the run was cancelled, another runner took it) is deleted after
three minutes and its runner registration removed. A VM that does not boot is deleted and
the job gets another. On start, the manager deletes any job VM left by an earlier run: job
VMs are named `minitart-<kind>-<6 hex>`, and nothing else is touched.

When the manager stops, it deletes every VM. A job that was running fails on GitHub as
"runner lost" and can be re-run.

## Parts

| File              | What it is                                                                |
| ----------------- | ------------------------------------------------------------------------- |
| `src/main.ts`     | The command line: `start`, `doctor`, `image build`, `selftest`, `service` |
| `src/manager.ts`  | The loop above, and the state the dashboard shows                         |
| `src/schedule.ts` | Which jobs are minitart's, and which VMs to start (pure)                  |
| `src/tart.ts`     | The `tart` command line, and the flags that isolate a VM                  |
| `src/github/`     | The REST client, and the GitHub App: its JWT, tokens and manifest         |
| `src/server.ts`   | The dashboard's HTTP server                                               |
| `src/settings.ts` | Defaults from the machine; validation of what the dashboard saves         |
| `src/doctor.ts`   | Is this Mac set up the way the security model assumes                     |
| `src/selftest.ts` | Boots a VM and checks what it can reach                                   |
| `src/image.ts`    | Builds the image job VMs are cloned from, with `images/*.sh`              |
| `src/service.ts`  | Installs the LaunchAgent                                                  |
| `src/testing/`    | A GitHub and a Tart in memory, for the tests and `--demo`                 |
| `dashboard/`      | The page: plain HTML, CSS and one script, no build                        |
| `site/`           | minitart.rovira.sh                                                        |

There is no build step and no runtime dependency: Node runs the TypeScript files as they are
([D07](decisions/D07-typescript-run-as-it-is.md)).

## GitHub

minitart is a GitHub App that the owner creates from the dashboard with one click (the App
manifest flow) and installs on the repos of their choice
([D03](decisions/D03-a-github-app-is-the-allowlist.md)).

| Permission                     | Why                                              |
| ------------------------------ | ------------------------------------------------ |
| Administration: read and write | Register and remove a repo's self-hosted runners |
| Actions: read                  | List workflow runs and jobs; read job logs       |
| Metadata: read                 | Required by GitHub for every App                 |

The App subscribes to no events and its webhook is inactive.

| Request                                                    | When                         |
| ---------------------------------------------------------- | ---------------------------- |
| `GET /app/installations`, `GET /installation/repositories` | Once a minute: the allowlist |
| `POST /app/installations/{id}/access_tokens`               | When a token nears its hour  |
| `GET /repos/{repo}/actions/runs?per_page=50`               | Every poll, per watched repo |
| `GET /repos/{repo}/actions/runs/{id}/jobs`                 | Every poll, per active run   |
| `POST /repos/{repo}/actions/runners/generate-jitconfig`    | Once per VM                  |
| `DELETE /repos/{repo}/actions/runners/{id}`                | For a VM that got no job     |
| `GET /repos/{repo}/actions/jobs/{id}/logs`                 | When a log is opened         |

## On disk

`~/.minitart/`, readable by the owner only:

| File            | What                                          |
| --------------- | --------------------------------------------- |
| `app.json`      | The App's id and private key. The one secret. |
| `settings.json` | What the owner changed in the dashboard       |
| `history.json`  | The last 200 finished jobs                    |
| `logs/`         | The manager's log and each VM's output        |

Everything else is rebuilt from GitHub and Tart on start.

## The dashboard

`http://127.0.0.1:4141`, served by the manager ([D10](decisions/D10-the-dashboard.md)).

- `GET /api/state`, and `GET /api/events` (server-sent events): slots, running, queued,
  done, repos, health, activity.
- `GET /api/vms/{name}/log`: what a VM printed. `GET /api/jobs/{id}/log`: a finished job's
  log, fetched from GitHub, for jobs minitart ran.
- `POST /api/settings`: VM counts and size, paused repos.
- `GET /setup/manifest`, `GET /setup/callback`: creating the GitHub App.

Reading works from any address the server listens on. Changing anything works only from a
browser on the Mac itself.
