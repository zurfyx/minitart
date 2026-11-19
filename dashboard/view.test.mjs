import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headline, lanes, stats, timeTicks } from './view.js';

const NOW = new Date(2026, 10, 19, 15, 0).getTime();
const MIN = 60_000;

function state(overrides = {}) {
  return {
    now: NOW,
    app: { slug: 'minitart', htmlUrl: 'https://github.com/apps/minitart' },
    repos: [{ fullName: 'octo/app', state: 'watching' }],
    vms: [],
    queued: [],
    done: [],
    blocked: null,
    githubError: null,
    draining: false,
    settings: { linux: { max: 2 }, macos: { max: 1 } },
    today: { passed: 0, finished: 0, medianWaitMs: null },
    ...overrides,
  };
}

const vm = (status, extra = {}) => ({
  name: `minitart-linux-00000${status.length}`,
  repo: 'octo/app',
  pool: 'linux',
  status,
  createdAt: NOW - 5 * MIN,
  since: NOW - 4 * MIN,
  jobAt: status === 'running' ? NOW - 4 * MIN : null,
  job: status === 'running' ? { id: 1, name: 'test', workflow: 'CI', url: '' } : null,
  ...extra,
});
const queued = (note) => ({
  id: 9,
  repo: 'octo/app',
  name: 'e2e',
  pool: 'linux',
  note,
  createdAt: '',
});

test('the headline says what needs the owner, most important first', () => {
  const two = [vm('running'), vm('running', { name: 'minitart-linux-0000ff' })];
  const waiting = [queued('Every Linux slot is in use (2 of 2)')];
  // Each condition, alone and then beaten by the one above it.
  assert.deepEqual(headline(state()), { lead: 'Idle.', point: null });
  assert.deepEqual(headline(state({ vms: two })), { lead: '2 running.', point: null });
  assert.deepEqual(headline(state({ vms: two, queued: waiting })), {
    lead: '2 running.',
    point: '1 waiting: every Linux slot is in use (2 of 2).',
  });
  assert.equal(headline(state({ vms: two, queued: waiting, draining: true })).lead, 'Draining.');
  assert.equal(
    headline(state({ queued: waiting, githubError: 'Bad credentials' })).point,
    'Bad credentials',
  );
  assert.deepEqual(
    headline(
      state({ queued: waiting, githubError: 'x', blocked: 'The firewall rule is not installed' }),
    ),
    { lead: 'No job can start.', point: 'The firewall rule is not installed' },
  );
});

test('CPU is never the headline: a resource is named only as why a job waits', () => {
  const short = queued(
    'This Mac has 3 GB of memory to spare and a VM needs 8 GB: the job waits until there is room',
  );
  const said = headline(state({ vms: [vm('running')], queued: [short, { ...short, id: 10 }] }));
  assert.match(said.point, /^2 waiting: this Mac has 3 GB of memory to spare/);
  for (const words of Object.values(headline(state({ vms: [vm('running')] })))) {
    assert.doesNotMatch(words ?? '', /CPU|%/);
  }
});

test('a job whose VM is on its way is starting, not waiting', () => {
  assert.deepEqual(headline(state({ vms: [vm('booting')], queued: [queued(null)] })), {
    lead: '1 starting.',
    point: null,
  });
});

test('idle says how many jobs ran today, as minitart counted them', () => {
  const today = (finished) => ({ passed: finished, finished, medianWaitMs: null });
  assert.deepEqual(headline(state({ today: today(1) })), { lead: 'Idle.', point: '1 job today.' });
  assert.deepEqual(headline(state({ today: today(640) })), {
    lead: 'Idle.',
    point: '640 jobs today.',
  });
});

test('stats: running counts VMs with a job; today’s figures are minitart’s own', () => {
  const figures = stats(
    state({
      vms: [vm('running'), vm('booting')],
      today: { passed: 3, finished: 4, medianWaitMs: 30_000 },
    }),
  );
  assert.deepEqual(figures, {
    running: 1,
    linux: 1,
    macos: 0,
    queued: 0,
    passed: 3,
    finished: 4,
    medianWaitMs: 30_000,
  });
});

test('lanes: one per slot, a VM in the first lane of its kind free when it was cloned', () => {
  const entry = (vmName, pool, start, end) => ({
    vm: vmName,
    repo: 'octo/app',
    pool,
    job: { id: null, name: vmName, workflow: 'CI', url: '' },
    conclusion: 'success',
    startedAt: NOW - start * MIN,
    jobAt: NOW - (start - 1) * MIN,
    endedAt: NOW - end * MIN,
  });
  const result = lanes(
    state({
      done: [
        entry('a', 'linux', 50, 40),
        entry('b', 'linux', 45, 30),
        entry('c', 'linux', 35, 20), // a's lane is free again
        entry('old', 'linux', 90, 70), // ended before the window
        // An entry from before 0.1.8 says nothing of when its job began.
        { ...entry('m', 'macos', 30, 10), jobAt: undefined },
      ],
      vms: [vm('running', { name: 'live' })],
    }),
    NOW - 60 * MIN,
  );
  assert.deepEqual(
    result.map((lane) => [lane.name, lane.items.map((item) => item.key)]),
    [
      ['macOS 1', ['m']],
      ['Linux 1', ['a', 'c', 'live']],
      ['Linux 2', ['b']],
    ],
  );
  assert.equal(result[0].items[0].jobAt, result[0].items[0].startAt);
});

test('lanes: more than the slots now, when more VMs ran at once under an older limit', () => {
  const at = (name) => ({ ...vm('running'), name, createdAt: NOW - MIN });
  const result = lanes(state({ vms: [at('a'), at('b'), at('c')] }), NOW - 60 * MIN);
  assert.deepEqual(
    result.map((lane) => lane.name),
    ['macOS 1', 'Linux 1', 'Linux 2', 'Linux 3'],
  );
});

test('time labels thin out on a narrow chart', () => {
  assert.deepEqual(
    timeTicks(60, 800).map((tick) => tick.ago),
    [60, 45, 30, 15, 0],
  );
  assert.deepEqual(
    timeTicks(60, 300).map((tick) => tick.label),
    ['60 min ago', '30 min ago', 'now'],
  );
});

// The menu bar app says the same sentence (D26): both are held to these cases.
test('the headline, as the dashboard and the menu bar app both say it', async () => {
  const { readFile } = await import('node:fs/promises');
  const { URL } = await import('node:url');
  const cases = JSON.parse(
    await readFile(new URL('../test/headline-cases.json', import.meta.url), 'utf8'),
  );
  for (const one of cases) {
    assert.deepEqual(headline({ now: NOW, done: [], ...one.state }), one.headline, one.case);
  }
});
