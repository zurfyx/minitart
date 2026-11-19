// The jobs minitart ran (D24): one row each, kept a year, in SQLite that Node has built in.
// Asked for by what the page shows: the last hour and the newest few, today's figures, and
// whether a job is one minitart ran (which guards its log).

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import type { DoneView } from './manager.ts';

/** How long a finished job is kept. */
export const KEEP_MS = 365 * 24 * 60 * 60_000;

export interface Today {
  passed: number;
  finished: number;
  /** How long a job waited for its VM: from GitHub queueing it to its runner taking it. */
  medianWaitMs: number | null;
}

/** A page of the history: newest first, of one repo or one result if asked. */
export interface JobQuery {
  offset: number;
  limit: number;
  repo?: string;
  conclusion?: string;
}

export interface HistoryStats {
  entries: number;
  /** When the oldest job kept ended. */
  oldestAt: number | null;
  /** What the history takes on disk, with its write-ahead log; null when in memory. */
  bytes: number | null;
}

export interface History {
  add(entry: DoneView): void;
  page(query: JobQuery): { total: number; jobs: DoneView[] };
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

  page(query: JobQuery): { total: number; jobs: DoneView[] } {
    const matching = [...this.#entries]
      .reverse()
      .filter(
        (entry) =>
          (query.repo === undefined || entry.repo === query.repo) &&
          (query.conclusion === undefined || entry.conclusion === query.conclusion),
      );
    return {
      total: matching.length,
      jobs: matching.slice(query.offset, query.offset + query.limit),
    };
  }

  repos(): string[] {
    return [...new Set(this.#entries.map((entry) => entry.repo))].sort();
  }

  stats(): HistoryStats {
    return {
      entries: this.#entries.length,
      oldestAt: this.#entries[0]?.endedAt ?? null,
      bytes: null,
    };
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
    job: { id: row.job_id, name: row.job_name, workflow: row.workflow, url: row.url },
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
`;

/** In a file: `~/.minitart/history.db`. Times are milliseconds since 1970, as in the page. */
export class SqliteHistory implements History {
  readonly #path: string;
  readonly #db: DatabaseSync;
  readonly #insert;
  readonly #since;
  readonly #newest;
  readonly #byJob;
  readonly #prune;

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
    this.#insert = this.#db.prepare(
      `INSERT OR IGNORE INTO jobs
        (vm, repo, pool, job_id, job_name, workflow, url, conclusion, started_at, job_at, queued_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#since = this.#db.prepare(
      'SELECT * FROM jobs WHERE ended_at >= ? ORDER BY ended_at DESC, id DESC',
    );
    this.#newest = this.#db.prepare('SELECT * FROM jobs ORDER BY ended_at DESC, id DESC LIMIT ?');
    this.#byJob = this.#db.prepare('SELECT repo FROM jobs WHERE job_id = ? LIMIT 1');
    this.#prune = this.#db.prepare('DELETE FROM jobs WHERE ended_at < ?');
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

  page(query: JobQuery): { total: number; jobs: DoneView[] } {
    // Only values reach SQL, as parameters; the shape of the query is one of four.
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
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = this.#db.prepare(`SELECT count(*) AS n FROM jobs ${clause}`).get(...values) as {
      n: number;
    };
    const rows = this.#db
      .prepare(`SELECT * FROM jobs ${clause} ORDER BY ended_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...values, query.limit, query.offset) as unknown as Row[];
    return { total: Number(count.n), jobs: rows.map(fromRow) };
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
    return {
      entries: Number(row.n),
      oldestAt: row.oldest === null ? null : Number(row.oldest),
      bytes: this.#path === ':memory:' ? null : size(this.#path) + size(`${this.#path}-wal`),
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
