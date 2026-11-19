import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // The same VM again replaces it: a VM runs one job.
    history.add({ ...full, conclusion: 'cancelled' });
    assert.equal(history.recent(0, 10).length, 2);
    assert.equal(history.recent(0, 10)[0]?.conclusion, 'cancelled');
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
    assert.deepEqual(history.today(NOW - 60 * MIN), {
      passed: 3,
      finished: 4,
      medianWaitMs: 30_000,
    });
    assert.deepEqual(history.today(NOW), { passed: 0, finished: 0, medianWaitMs: null });
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
  first.close();
  assert.deepEqual(readdirSync(dir).sort(), ['history.db', 'history.json.imported']);
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
