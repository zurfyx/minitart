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

- The history is read with any SQLite client: `sqlite3 -json ~/.minitart/history.db 'select
  - from jobs order by ended_at desc limit 10'`. `sqlite3`comes with macOS. A copy of the
file taken while minitart is stopped is a backup; while it runs,`sqlite3 history.db
    ".backup copy.db"`.
- `node:sqlite` is marked as still in development by Node. Node 26, which Homebrew installs,
  runs it without a warning. If its interface changes, `src/history.ts` is the one file
  that uses it.
- Charts of CPU and memory are not in it: they are an hour, in memory (D23).
