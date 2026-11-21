import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MemoryHistory, openHistory, SqliteHistory, type History } from './history.ts';
import type { DoneView } from './manager.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-11-19T15:00:00Z');

function job(n: number, endedMinutesAgo: number, extra: Partial<DoneView> = {}): DoneView {
  return {
    vm: `minitart-linux-${n.toString(16).padStart(6, '0')}`,
    repo: n % 2 ? 'octo/app' : 'octo/api',
    pool: 'linux',
    job: {
      id: 1000 + n,
      name: `job ${n}`,
      workflow: 'CI',
      url: `https://github.com/octo/app/actions/runs/1/job/${1000 + n}`,
    },
    conclusion: 'success',
    startedAt: NOW - (endedMinutesAgo + 5) * MIN,
    jobAt: NOW - (endedMinutesAgo + 4) * MIN,
    queuedAt: NOW - (endedMinutesAgo + 5) * MIN,
    endedAt: NOW - endedMinutesAgo * MIN,
    ...extra,
  };
}

// The same behaviour from both: the tests' and the demo's in memory, and the file.
for (const [kind, make] of [
  ['memory', () => new MemoryHistory()],
  ['sqlite', () => new SqliteHistory(':memory:')],
] as [string, () => History][]) {
  test(`${kind}: recent is the last hour, and at least the newest few, newest first`, () => {
    const history = make();
    for (let n = 1; n <= 30; n++) history.add(job(n, 200 - n * 5)); // ended 195 … 50 min ago
    // (15 of them, from 120 min ago, are within two hours)
    history.add(job(31, 10));
    history.add(job(32, 2));
    // Two in the last hour, so the newest 20.
    const recent = history.recent(NOW - 60 * MIN, 20);
    assert.equal(recent.length, 20);
    assert.deepEqual(
      recent.slice(0, 3).map((entry) => entry.job.name),
      ['job 32', 'job 31', 'job 30'],
    );
    // Everything of a busy hour, past the minimum.
    assert.equal(history.recent(NOW - 120 * MIN, 5).length, 17);
  });

  test(`${kind}: an entry comes back as it went in, with or without its times`, () => {
    const history = make();
    const full = job(1, 3);
    const old = job(2, 4, {
      conclusion: 'failure',
      job: { id: null, name: 'x', workflow: '', url: '' },
    });
    delete old.jobAt;
    delete old.queuedAt;
    history.add(full);
    history.add(old);
    assert.deepEqual(history.recent(0, 10), [full, old]);
    // The same job twice, as an import run again would add it, is one.
    history.add(full);
    assert.equal(history.recent(0, 10).length, 2);
    // A VM name that comes round again months later is another job, and both are kept.
    history.add({ ...full, endedAt: full.endedAt + 1, job: { ...full.job, id: 77 } });
    assert.equal(history.recent(0, 10).length, 3);
    assert.equal(history.repoOfJob(1001), 'octo/app');
    assert.equal(history.repoOfJob(77), 'octo/app');
  });

  test(`${kind}: today’s figures, and the median wait of those that say when they were queued`, () => {
    const history = make();
    history.add(job(1, 30, { queuedAt: NOW - 34 * MIN - 10_000 })); // its VM took it 10 s later
    history.add(job(2, 20, { conclusion: 'failure', queuedAt: NOW - 24 * MIN - 30_000 }));
    history.add(job(3, 10, { queuedAt: NOW - 14 * MIN - 50_000 }));
    const four = job(4, 5);
    delete four.queuedAt;
    history.add(four);
    history.add(job(5, 24 * 60)); // yesterday
    const six = job(6, 2, { conclusion: 'lost' });
    delete six.queuedAt;
    history.add(six);
    assert.deepEqual(history.today(NOW - 60 * MIN), {
      passed: 3,
      finished: 5,
      lost: 1,
      medianWaitMs: 30_000,
    });
    assert.deepEqual(history.today(NOW), {
      passed: 0,
      finished: 0,
      lost: 0,
      medianWaitMs: null,
    });
  });

  test(`${kind}: pages, newest first, of one repo or one result, with how many in all`, () => {
    const history = make();
    for (let n = 1; n <= 7; n++) {
      history.add(job(n, 100 - n, { conclusion: n % 3 === 0 ? 'failure' : 'success' }));
    }
    const first = history.page({ offset: 0, limit: 3 });
    assert.equal(first.total, 7);
    assert.deepEqual(
      first.jobs.map((entry) => entry.job.name),
      ['job 7', 'job 6', 'job 5'],
    );
    assert.deepEqual(
      history.page({ offset: 6, limit: 3 }).jobs.map((entry) => entry.job.name),
      ['job 1'],
    );
    assert.equal(history.page({ offset: 9, limit: 3 }).jobs.length, 0);
    const failed = history.page({ offset: 0, limit: 10, conclusion: 'failure' });
    assert.deepEqual(
      [failed.total, failed.jobs.map((entry) => entry.job.name)],
      [2, ['job 6', 'job 3']],
    );
    // Odd jobs are octo/app's.
    const app = history.page({ offset: 0, limit: 10, repo: 'octo/app', conclusion: 'failure' });
    assert.deepEqual(
      app.jobs.map((entry) => entry.job.name),
      ['job 3'],
    );
    assert.deepEqual(history.repos(), ['octo/api', 'octo/app']);
    const stats = history.stats();
    assert.equal(stats.entries, 7);
    assert.equal(stats.oldestAt, NOW - 99 * MIN);
  });

  test(`${kind}: each day's minutes by kind, each job rounded up as GitHub bills it`, () => {
    const history = make();
    const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();
    const run = (n: number, pool: 'linux' | 'macos', day: number, hour: number, ms: number) =>
      history.add(
        job(n, 0, {
          pool,
          startedAt: at(day, hour) - ms - 30_000,
          jobAt: at(day, hour) - ms,
          endedAt: at(day, hour),
        }),
      );
    run(1, 'linux', 17, 10, 61_000); // 2 minutes
    run(2, 'linux', 17, 23, 1_000); // 1 minute
    run(3, 'macos', 17, 12, 120_000); // 2 minutes, exactly
    run(4, 'linux', 18, 1, 59_000); // 1 minute, the next day
    run(5, 'linux', 16, 9, 600_000); // before the range
    assert.deepEqual(
      history
        .usage(new Date(2026, 10, 17).getTime())
        .map((row) => [row.day, row.pool, row.jobs, row.minutes]),
      [
        ['2026-11-17', 'linux', 2, 3],
        ['2026-11-17', 'macos', 1, 2],
        ['2026-11-18', 'linux', 1, 1],
      ],
    );
    // The VMs' own time includes their 30 s of starting.
    assert.equal(history.usage(new Date(2026, 10, 17).getTime())[1]?.vmMinutes, 3);
  });

  test(`${kind}: only a job minitart ran has a repo, and pruning forgets it`, () => {
    const history = make();
    history.add(job(1, 400 * 24 * 60));
    history.add(job(2, 1));
    assert.equal(history.repoOfJob(1001), 'octo/app');
    assert.equal(history.repoOfJob(999), null);
    assert.equal(history.prune(NOW - 365 * 24 * 60 * MIN), 1);
    assert.equal(history.repoOfJob(1001), null);
    assert.equal(history.repoOfJob(1002), 'octo/api');
  });
}

test('the JSON history of earlier versions is moved in once, and the file kept aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minitart-history-'));
  writeFileSync(join(dir, 'history.json'), JSON.stringify([job(1, 50), job(2, 40)]));
  const warnings: string[] = [];
  const first = openHistory(dir, (text) => warnings.push(text));
  assert.equal(first.recent(0, 10).length, 2);
  first.add(job(3, 1));
  assert.ok((first.stats().bytes ?? 0) > 0, 'its size on disk, with its log');
  first.close();
  assert.deepEqual(
    readdirSync(dir)
      .filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm'))
      .sort(),
    ['history.db', 'history.json.imported'],
  );
  assert.equal(statSync(join(dir, 'history.db')).mode & 0o777, 0o600, 'for the owner only');

  // Opened again: the same rows, nothing imported twice.
  const again = openHistory(dir, (text) => warnings.push(text));
  assert.deepEqual(
    again.recent(0, 10).map((entry) => entry.job.name),
    ['job 3', 'job 2', 'job 1'],
  );
  again.close();
  assert.deepEqual(warnings, []);
});

test('a history from before authors were kept gains the column, and keeps its jobs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minitart-history-'));
  // The table as minitart 0.1.10 to 0.1.13 made it.
  const old = new DatabaseSync(join(dir, 'history.db'));
  old.exec(`CREATE TABLE jobs (
    id INTEGER PRIMARY KEY, vm TEXT NOT NULL, repo TEXT NOT NULL, pool TEXT NOT NULL,
    job_id INTEGER, job_name TEXT NOT NULL, workflow TEXT NOT NULL, url TEXT NOT NULL,
    conclusion TEXT NOT NULL, started_at INTEGER NOT NULL, job_at INTEGER, queued_at INTEGER,
    ended_at INTEGER NOT NULL, UNIQUE (vm, ended_at)) STRICT`);
  old.exec(`INSERT INTO jobs (vm, repo, pool, job_id, job_name, workflow, url, conclusion, started_at, ended_at)
    VALUES ('minitart-linux-000001', 'octo/app', 'linux', 1, 'old', 'CI', '', 'success', 1, 2)`);
  old.close();
  const history = openHistory(dir, () => {});
  history.add(job(5, 1, { job: { id: 5, name: 'new', workflow: 'CI', url: '', actor: 'mona' } }));
  const [newer, older] = history.recent(0, 10);
  assert.equal(newer?.job.actor, 'mona');
  assert.equal(older?.job.name, 'old');
  assert.equal(older?.job.actor, undefined, 'not known for a job from before');
  history.close();
});

test('someone reading the database in a terminal does not stop a job being recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minitart-history-'));
  const history = openHistory(dir, () => {});
  history.add(job(1, 5));
  // A reader in the middle of a long read, as `sqlite3` or a backup would be.
  const reader = new DatabaseSync(join(dir, 'history.db'));
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM jobs').get();
  history.add(job(2, 1));
  assert.equal(history.recent(0, 10).length, 2);
  reader.exec('COMMIT');
  reader.close();
  history.close();
});

test('a file that is not a database throws, for minitart to start without it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minitart-history-'));
  writeFileSync(
    join(dir, 'history.db'),
    'this is not a database, and is long enough to be read as one',
  );
  assert.throws(() => openHistory(dir, () => {}), /not a database/);
});

test('an earlier history.json.imported is never written over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minitart-history-'));
  writeFileSync(join(dir, 'history.json.imported'), '[]');
  writeFileSync(join(dir, 'history.json'), JSON.stringify([job(1, 5)]));
  openHistory(dir, () => {}).close();
  const names = readdirSync(dir);
  assert.ok(names.includes('history.json.imported'));
  assert.ok(
    names.some((name) => /^history\.json\.imported-\d+$/.test(name)),
    names.join(),
  );
});

test('a JSON history that cannot be read is said, and left where it is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minitart-history-'));
  writeFileSync(join(dir, 'history.json'), '{ not json');
  const warnings: string[] = [];
  const history = openHistory(dir, (text) => warnings.push(text));
  assert.equal(history.recent(0, 10).length, 0);
  history.close();
  assert.match(warnings[0] ?? '', /Could not move history\.json/);
  assert.ok(readdirSync(dir).includes('history.json'));
});
