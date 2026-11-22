// The jobs minitart ran (D24): one row each, kept a year, in SQLite that Node has built in.
// Asked for by what the page shows: the last hour and the newest few, today's figures, and
// whether a job is one minitart ran (which guards its log).

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import type { DoneView } from './manager.ts';
import { MINUTE_MS, SERIES, wholeMinutes, type MinuteSample } from './samples.ts';

/** How long a finished job is kept. */
export const KEEP_MS = 365 * 24 * 60 * 60_000;

export interface Today {
  passed: number;
  /** Every job that ended, the lost ones too. */
  finished: number;
  /** The jobs lost with their VM, not failed by their own steps. */
  lost: number;
  /** Each repo that had a job end, by name: how many ended, failed and were lost. */
  repos: { repo: string; jobs: number; failed: number; lost: number }[];
  /** How long a job waited for its VM: from GitHub queueing it to its runner taking it. */
  medianWaitMs: number | null;
}

/** A page of the history: newest first, of one repo or one result if asked. */
export interface JobQuery {
  offset: number;
  limit: number;
  repo?: string;
  conclusion?: string;
  /** Only the jobs that ended at or after this time. */
  since?: number;
}

export interface HistoryStats {
  entries: number;
  /** When the oldest job kept ended. */
  oldestAt: number | null;
  /** What the history takes on disk, with its write-ahead log; null when in memory. */
  bytes: number | null;
  /** The charts' minutes kept, and when the oldest began. */
  samples: number;
  samplesOldestAt: number | null;
}

/** One kind of VM's work on one day, by the Mac's calendar (D25). */
export interface UsageDay {
  /** `YYYY-MM-DD`, the Mac's local date the jobs ended on. */
  day: string;
  pool: 'linux' | 'macos';
  jobs: number;
  /** As GitHub bills: each job from when its runner took it, rounded up to a whole minute. */
  minutes: number;
  /** What the VMs were up, cloning and booting included, in minutes. */
  vmMinutes: number;
}

/** A job's billed minutes: whole minutes, rounded up. A job from before 0.1.8 counts its VM. */
export function billedMinutes(entry: DoneView): number {
  return Math.ceil(Math.max(0, entry.endedAt - (entry.jobAt ?? entry.startedAt)) / 60_000);
}

export function localDay(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface History {
  add(entry: DoneView): void;
  /** Each day's work since `since`, by kind, oldest first. Days with none are left out. */
  usage(since: number): UsageDay[];
  page(query: JobQuery): { total: number; jobs: DoneView[] };
  /** How many jobs kept ended each way, of one repo and since a time if asked. */
  results(filter?: { repo?: string; since?: number }): Record<string, number>;
  /** Every repo with a job kept, by name. */
  repos(): string[];
  stats(): HistoryStats;
  /** Newest first: every job that ended at or after `since`, and at least the newest `atLeast`. */
  recent(since: number, atLeast: number): DoneView[];
  /** What ended at or after `since`. */
  today(since: number): Today;
  repoOfJob(jobId: number): string | null;
  /** Deletes what ended before `before`. Resolves with how many. */
  prune(before: number): number;
  /** Keeps a minute of the charts. A minute already kept is left as it was. */
  addSample(sample: MinuteSample): void;
  /**
   * The minutes from `from` to before `to`, oldest first, gathered `stepMs` at a time: each
   * step's average of their averages and peak of their peaks. A step with no minute is left out.
   */
  samples(from: number, to: number, stepMs?: number): MinuteSample[];
  /** Deletes the minutes before `before`. Resolves with how many. */
  pruneSamples(before: number): number;
}

/** Steps of minutes gathered into fewer: averages averaged, peaks kept. */
function gather(minutes: readonly MinuteSample[], stepMs: number): MinuteSample[] {
  const steps = new Map<number, MinuteSample[]>();
  for (const minute of minutes) {
    const at = Math.floor(minute.at / stepMs) * stepMs;
    const step = steps.get(at);
    if (step) step.push(minute);
    else steps.set(at, [minute]);
  }
  return [...steps].map(([at, group]) => {
    const sample = { at } as MinuteSample;
    for (const series of SERIES) {
      sample[series] = round1(group.reduce((sum, one) => sum + one[series], 0) / group.length);
      sample[`${series}Max`] = Math.max(...group.map((one) => one[`${series}Max`]));
    }
    return sample;
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function summarise(entries: readonly DoneView[]): Today {
  return {
    passed: entries.filter((entry) => entry.conclusion === 'success').length,
    finished: entries.length,
    lost: entries.filter((entry) => entry.conclusion === 'lost').length,
    repos: [...new Set(entries.map((entry) => entry.repo))].sort().map((repo) => {
      const own = entries.filter((entry) => entry.repo === repo);
      return {
        repo,
        jobs: own.length,
        failed: own.filter((entry) => entry.conclusion === 'failure').length,
        lost: own.filter((entry) => entry.conclusion === 'lost').length,
      };
    }),
    medianWaitMs: median(
      entries.flatMap((entry) =>
        entry.jobAt !== undefined && entry.queuedAt !== undefined
          ? [Math.max(0, entry.jobAt - entry.queuedAt)]
          : [],
      ),
    ),
  };
}

/** In memory: the tests' history, and the demo's. */
export class MemoryHistory implements History {
  #entries: DoneView[];
  #samples: MinuteSample[] = [];

  constructor(entries: DoneView[] = []) {
    this.#entries = [...entries].sort((a, b) => a.endedAt - b.endedAt);
  }

  add(entry: DoneView): void {
    // The same job twice (an import run again) is one; a VM name used again later is not.
    if (this.#entries.some((one) => one.vm === entry.vm && one.endedAt === entry.endedAt)) return;
    this.#entries.push(entry);
    this.#entries.sort((a, b) => a.endedAt - b.endedAt);
  }

  recent(since: number, atLeast: number): DoneView[] {
    const newest = [...this.#entries].reverse();
    const count = Math.max(atLeast, newest.filter((entry) => entry.endedAt >= since).length);
    return newest.slice(0, count);
  }

  today(since: number): Today {
    return summarise(this.#entries.filter((entry) => entry.endedAt >= since));
  }

  usage(since: number): UsageDay[] {
    const days = new Map<string, UsageDay>();
    for (const entry of this.#entries) {
      if (entry.endedAt < since) continue;
      const day = localDay(entry.endedAt);
      const key = `${day} ${entry.pool}`;
      const row = days.get(key) ?? { day, pool: entry.pool, jobs: 0, minutes: 0, vmMinutes: 0 };
      row.jobs++;
      row.minutes += billedMinutes(entry);
      row.vmMinutes += Math.max(0, entry.endedAt - entry.startedAt) / 60_000;
      days.set(key, row);
    }
    return [...days.values()]
      .map((row) => ({ ...row, vmMinutes: Math.round(row.vmMinutes) }))
      .sort((a, b) => a.day.localeCompare(b.day) || a.pool.localeCompare(b.pool));
  }

  page(query: JobQuery): { total: number; jobs: DoneView[] } {
    const matching = [...this.#entries]
      .reverse()
      .filter(
        (entry) =>
          (query.repo === undefined || entry.repo === query.repo) &&
          (query.conclusion === undefined || entry.conclusion === query.conclusion) &&
          (query.since === undefined || entry.endedAt >= query.since),
      );
    return {
      total: matching.length,
      jobs: matching.slice(query.offset, query.offset + query.limit),
    };
  }

  results(filter: { repo?: string; since?: number } = {}): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.#entries) {
      if (filter.repo !== undefined && entry.repo !== filter.repo) continue;
      if (filter.since !== undefined && entry.endedAt < filter.since) continue;
      counts[entry.conclusion] = (counts[entry.conclusion] ?? 0) + 1;
    }
    return counts;
  }

  repos(): string[] {
    return [...new Set(this.#entries.map((entry) => entry.repo))].sort();
  }

  stats(): HistoryStats {
    return {
      entries: this.#entries.length,
      oldestAt: this.#entries[0]?.endedAt ?? null,
      bytes: null,
      samples: this.#samples.length,
      samplesOldestAt: this.#samples[0]?.at ?? null,
    };
  }

  addSample(sample: MinuteSample): void {
    if (this.#samples.some((one) => one.at === sample.at)) return;
    this.#samples.push({ ...sample });
    this.#samples.sort((a, b) => a.at - b.at);
  }

  samples(from: number, to: number, stepMs = MINUTE_MS): MinuteSample[] {
    return gather(
      this.#samples.filter((one) => one.at >= from && one.at < to),
      wholeMinutes(stepMs),
    );
  }

  pruneSamples(before: number): number {
    const kept = this.#samples.filter((one) => one.at >= before);
    const gone = this.#samples.length - kept.length;
    this.#samples = kept;
    return gone;
  }

  repoOfJob(jobId: number): string | null {
    return this.#entries.find((entry) => entry.job.id === jobId)?.repo ?? null;
  }

  prune(before: number): number {
    const kept = this.#entries.filter((entry) => entry.endedAt >= before);
    const gone = this.#entries.length - kept.length;
    this.#entries = kept;
    return gone;
  }
}

interface Row {
  vm: string;
  repo: string;
  pool: string;
  job_id: number | null;
  job_name: string;
  workflow: string;
  url: string;
  actor: string | null;
  conclusion: string;
  started_at: number;
  job_at: number | null;
  queued_at: number | null;
  ended_at: number;
}

function fromRow(row: Row): DoneView {
  return {
    vm: row.vm,
    repo: row.repo,
    pool: row.pool === 'macos' ? 'macos' : 'linux',
    job: {
      id: row.job_id,
      name: row.job_name,
      workflow: row.workflow,
      url: row.url,
      ...(row.actor === null ? {} : { actor: row.actor }),
    },
    conclusion: row.conclusion,
    startedAt: row.started_at,
    ...(row.job_at === null ? {} : { jobAt: row.job_at }),
    ...(row.queued_at === null ? {} : { queuedAt: row.queued_at }),
    endedAt: row.ended_at,
  };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    -- Six random hex digits: over a year a name comes round again, so it is not the key.
    vm TEXT NOT NULL,
    repo TEXT NOT NULL,
    pool TEXT NOT NULL,
    job_id INTEGER,
    job_name TEXT NOT NULL,
    workflow TEXT NOT NULL,
    url TEXT NOT NULL,
    actor TEXT,
    conclusion TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    job_at INTEGER,
    queued_at INTEGER,
    ended_at INTEGER NOT NULL,
    UNIQUE (vm, ended_at)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS jobs_by_end ON jobs (ended_at);
  CREATE INDEX IF NOT EXISTS jobs_by_job ON jobs (job_id);
  CREATE INDEX IF NOT EXISTS jobs_by_repo ON jobs (repo, ended_at);
  -- The charts, a minute a row: each series' average and peak (samples.ts), in tenths, as
  -- whole numbers: a third of the room of decimals.
  CREATE TABLE IF NOT EXISTS samples (
    at INTEGER PRIMARY KEY,
    cpu_vms INTEGER NOT NULL,
    cpu_vms_max INTEGER NOT NULL,
    cpu_other INTEGER NOT NULL,
    cpu_other_max INTEGER NOT NULL,
    mem_vms INTEGER NOT NULL,
    mem_vms_max INTEGER NOT NULL,
    mem_other INTEGER NOT NULL,
    mem_other_max INTEGER NOT NULL,
    net_vms_down INTEGER NOT NULL,
    net_vms_down_max INTEGER NOT NULL,
    net_vms_up INTEGER NOT NULL,
    net_vms_up_max INTEGER NOT NULL,
    net_other_down INTEGER NOT NULL,
    net_other_down_max INTEGER NOT NULL,
    net_other_up INTEGER NOT NULL,
    net_other_up_max INTEGER NOT NULL,
    disk_used INTEGER NOT NULL,
    disk_used_max INTEGER NOT NULL
  ) STRICT;
`;

/** The samples table's columns, in SERIES's order: each series, then its peak. */
const SAMPLE_COLUMNS = SERIES.flatMap((series) => {
  const column = series.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return [column, `${column}_max`];
});

/** In a file: `~/.minitart/history.db`. Times are milliseconds since 1970, as in the page. */
export class SqliteHistory implements History {
  readonly #path: string;
  readonly #db: DatabaseSync;
  readonly #insert;
  readonly #since;
  readonly #newest;
  readonly #byJob;
  readonly #prune;
  readonly #addSample;
  readonly #pruneSamples;

  constructor(path: string) {
    // Waits a moment for another reader or writer (`sqlite3` in a terminal) rather than
    // failing at once. With a write-ahead log, a reader never blocks minitart's writes.
    this.#path = path;
    this.#db = new DatabaseSync(path, { timeout: 2000 });
    if (path !== ':memory:') {
      chmodSync(path, 0o600);
      this.#db.exec('PRAGMA journal_mode = WAL');
    }
    this.#db.exec(SCHEMA);
    // Who a job ran for came in minitart 0.1.14: a history from before gains the column.
    const columns = this.#db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'actor')) {
      this.#db.exec('ALTER TABLE jobs ADD COLUMN actor TEXT');
    }
    this.#insert = this.#db.prepare(
      `INSERT OR IGNORE INTO jobs
        (vm, repo, pool, job_id, job_name, workflow, url, actor, conclusion, started_at, job_at, queued_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#since = this.#db.prepare(
      'SELECT * FROM jobs WHERE ended_at >= ? ORDER BY ended_at DESC, id DESC',
    );
    this.#newest = this.#db.prepare('SELECT * FROM jobs ORDER BY ended_at DESC, id DESC LIMIT ?');
    this.#byJob = this.#db.prepare('SELECT repo FROM jobs WHERE job_id = ? LIMIT 1');
    this.#prune = this.#db.prepare('DELETE FROM jobs WHERE ended_at < ?');
    this.#addSample = this.#db.prepare(
      `INSERT OR IGNORE INTO samples (at, ${SAMPLE_COLUMNS.join(', ')})
        VALUES (?${', ?'.repeat(SAMPLE_COLUMNS.length)})`,
    );
    this.#pruneSamples = this.#db.prepare('DELETE FROM samples WHERE at < ?');
  }

  addSample(sample: MinuteSample): void {
    this.#addSample.run(
      sample.at,
      ...SERIES.flatMap((series) => [
        Math.round(sample[series] * 10),
        Math.round(sample[`${series}Max`] * 10),
      ]),
    );
  }

  samples(from: number, to: number, stepMs = MINUTE_MS): MinuteSample[] {
    // Steps are whole minutes; SQL gathers them, with only numbers as parameters.
    const step = wholeMinutes(stepMs);
    const picks = SERIES.flatMap((series, index) => {
      const column = SAMPLE_COLUMNS[index * 2];
      return [
        `round(avg(${column})) / 10.0 AS ${series}`,
        `max(${column}_max) / 10.0 AS ${series}Max`,
      ];
    });
    const rows = this.#db
      .prepare(
        // `%` works on whole numbers in SQLite, whatever type a parameter comes as.
        `SELECT at - at % ? AS step_at, ${picks.join(', ')} FROM samples
          WHERE at >= ? AND at < ? GROUP BY step_at ORDER BY step_at`,
      )
      .all(step, from, to) as Record<string, number>[];
    return rows.map((row) => {
      const sample = { at: Number(row['step_at']) } as MinuteSample;
      for (const series of SERIES) {
        sample[series] = Number(row[series]);
        sample[`${series}Max`] = Number(row[`${series}Max`]);
      }
      return sample;
    });
  }

  pruneSamples(before: number): number {
    return Number(this.#pruneSamples.run(before).changes);
  }

  add(entry: DoneView): void {
    this.#insert.run(
      entry.vm,
      entry.repo,
      entry.pool,
      entry.job.id,
      entry.job.name,
      entry.job.workflow,
      entry.job.url,
      entry.job.actor ?? null,
      entry.conclusion,
      entry.startedAt,
      entry.jobAt ?? null,
      entry.queuedAt ?? null,
      entry.endedAt,
    );
  }

  /** Many at once, in one transaction: importing the old JSON history. */
  addAll(entries: readonly DoneView[]): void {
    this.#db.exec('BEGIN');
    try {
      for (const entry of entries) this.add(entry);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  recent(since: number, atLeast: number): DoneView[] {
    const inWindow = this.#since.all(since) as unknown as Row[];
    const rows =
      inWindow.length >= atLeast ? inWindow : (this.#newest.all(atLeast) as unknown as Row[]);
    return rows.map(fromRow);
  }

  today(since: number): Today {
    return summarise((this.#since.all(since) as unknown as Row[]).map(fromRow));
  }

  usage(since: number): UsageDay[] {
    // The Mac's own calendar, as SQLite's 'localtime' reads it: the same zone as minitart's.
    const rows = this.#db
      .prepare(
        `SELECT date(ended_at / 1000, 'unixepoch', 'localtime') AS day, pool, count(*) AS jobs,
           sum((max(0, ended_at - coalesce(job_at, started_at)) + 59999) / 60000) AS minutes,
           sum(max(0, ended_at - started_at)) AS vm_ms
         FROM jobs WHERE ended_at >= ? GROUP BY day, pool ORDER BY day, pool`,
      )
      .all(since) as { day: string; pool: string; jobs: number; minutes: number; vm_ms: number }[];
    return rows.map((row) => ({
      day: row.day,
      pool: row.pool === 'macos' ? 'macos' : 'linux',
      jobs: Number(row.jobs),
      minutes: Number(row.minutes),
      vmMinutes: Math.round(Number(row.vm_ms) / 60_000),
    }));
  }

  page(query: JobQuery): { total: number; jobs: DoneView[] } {
    // Only values reach SQL, as parameters; the shape of the query is one of eight.
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (query.repo !== undefined) {
      where.push('repo = ?');
      values.push(query.repo);
    }
    if (query.conclusion !== undefined) {
      where.push('conclusion = ?');
      values.push(query.conclusion);
    }
    if (query.since !== undefined) {
      where.push('ended_at >= ?');
      values.push(query.since);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = this.#db.prepare(`SELECT count(*) AS n FROM jobs ${clause}`).get(...values) as {
      n: number;
    };
    const rows = this.#db
      .prepare(`SELECT * FROM jobs ${clause} ORDER BY ended_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...values, query.limit, query.offset) as unknown as Row[];
    return { total: Number(count.n), jobs: rows.map(fromRow) };
  }

  results(filter: { repo?: string; since?: number } = {}): Record<string, number> {
    // Only values reach SQL, as parameters; the shape of the query is one of four.
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (filter.repo !== undefined) {
      where.push('repo = ?');
      values.push(filter.repo);
    }
    if (filter.since !== undefined) {
      where.push('ended_at >= ?');
      values.push(filter.since);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT conclusion, count(*) AS n FROM jobs ${clause} GROUP BY conclusion`)
      .all(...values) as { conclusion: string; n: number }[];
    return Object.fromEntries(rows.map((row) => [row.conclusion, Number(row.n)]));
  }

  repos(): string[] {
    const rows = this.#db.prepare('SELECT DISTINCT repo FROM jobs ORDER BY repo').all() as {
      repo: string;
    }[];
    return rows.map((row) => row.repo);
  }

  stats(): HistoryStats {
    const row = this.#db
      .prepare('SELECT count(*) AS n, min(ended_at) AS oldest FROM jobs')
      .get() as {
      n: number;
      oldest: number | null;
    };
    const size = (path: string) => {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    };
    const samples = this.#db
      .prepare('SELECT count(*) AS n, min(at) AS oldest FROM samples')
      .get() as { n: number; oldest: number | null };
    return {
      entries: Number(row.n),
      oldestAt: row.oldest === null ? null : Number(row.oldest),
      bytes: this.#path === ':memory:' ? null : size(this.#path) + size(`${this.#path}-wal`),
      samples: Number(samples.n),
      samplesOldestAt: samples.oldest === null ? null : Number(samples.oldest),
    };
  }

  repoOfJob(jobId: number): string | null {
    const row = this.#byJob.get(jobId) as { repo: string } | undefined;
    return row?.repo ?? null;
  }

  prune(before: number): number {
    return Number(this.#prune.run(before).changes);
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * The history at `dir/history.db`. The first time, the JSON history of minitart 0.1.9 and
 * before is moved in, and the file kept beside it as `history.json.imported`.
 */
export function openHistory(dir: string, warn: (text: string) => void): SqliteHistory {
  const history = new SqliteHistory(`${dir}/history.db`);
  const old = `${dir}/history.json`;
  if (existsSync(old)) {
    try {
      const entries = JSON.parse(readFileSync(old, 'utf8')) as DoneView[];
      history.addAll(Array.isArray(entries) ? entries : []);
      // Never over an earlier one: it is the owner's copy of what was moved in.
      const aside = existsSync(`${old}.imported`)
        ? `${old}.imported-${Date.now()}`
        : `${old}.imported`;
      renameSync(old, aside);
    } catch (error) {
      warn(`Could not move history.json into history.db: ${(error as Error).message}`);
    }
  }
  return history;
}
