# D24: The jobs that ran are kept a year, in SQLite

Status: `DECIDED`

## Decision

Every job minitart runs is a row in `~/.minitart/history.db`: which VM, repo and job, how it
ended, and when its VM was cloned, when GitHub queued it, when its runner took it and when
it ended. A row is kept for a year from when its job ended. The database is SQLite as Node
has it built in (`node:sqlite`): no dependency, no server.

The page is sent what it shows, not the history: every job that ended in the last hour (the
timeline), at least the newest 20 (the list), and today's figures, which minitart counts by
the Mac's clock.

The first time, the JSON history of minitart 0.1.9 and before is moved in, and the file is
kept beside it as `history.json.imported`.

## Why

The JSON history kept the last 200 jobs, rewritten whole after each. On the Mac this was
built on, 200 jobs were the last 7.7 hours: by evening "passed today" counted only part of
the day, and a job's log could no longer be opened from the page once its job had dropped
out (the log endpoint serves only jobs minitart ran, D10).

A year, because it is what the owner asked for in spirit, a generous limit, and it costs
little: about 330 bytes a job, so about 70 MB at that Mac's busiest pace of some 600 jobs a
day. GitHub itself keeps logs 90 days by default; the row outlives the log, and says so when
the log is gone.

SQLite rather than a bigger JSON file: a year of jobs does not fit in memory comfortably or
in a file rewritten after every job, and SQLite answers "the last hour", "today" and "is
this job ours" from an index. The settings stay JSON (D06): they are small, and the owner
may read and back them up by hand.

## Consequences

- The history is read with any SQLite client, and `sqlite3` comes with macOS:

  ```sh
  sqlite3 -json ~/.minitart/history.db "select * from jobs order by ended_at desc limit 10"
  ```

  A backup, whether or not minitart is running:

  ```sh
  sqlite3 ~/.minitart/history.db ".backup history-copy.db"
  ```

- The database keeps a write-ahead log (`history.db-wal` beside it), so a reader never
  holds up minitart recording a job, and minitart waits up to two seconds for a writer.
- A row is a job, not a VM: VM names are six random hex digits and come round again within
  a year. The same job added twice (an import run again) is one row.
- A `history.db` that cannot be opened does not stop minitart: it warns, keeps the jobs in
  memory until it restarts, and the file can be moved aside.
- `node:sqlite` is marked as still in development by Node. Node 26, which Homebrew installs,
  runs it without a warning. If its interface changes, `src/history.ts` is the one file
  that uses it.
- There is no limit on its size, only on age, and the owner sees what it takes: the Jobs
  view says how many jobs, since when and how much disk, and pages through all of them;
  This Mac's Storage lists it beside the VM logs and Tart's images.
- Charts of CPU and memory are not in it: they are an hour, in memory (D23).
