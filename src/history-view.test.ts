import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryHistory } from './history.ts';
import { historyView, MOST_STEPS, rangeFor, stepFor, vmsUp } from './history-view.ts';
import { SERIES, type MinuteSample } from './samples.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function sampleAt(at: number): MinuteSample {
  const sample = { at } as MinuteSample;
  for (const series of SERIES) {
    sample[series] = 0;
    sample[`${series}Max`] = 0;
  }
  return sample;
}

test('a range is drawn in the smallest whole step that keeps it to a few hundred points', () => {
  assert.equal(stepFor(DAY), 5 * MIN);
  assert.equal(stepFor(7 * DAY), 30 * MIN);
  assert.equal(stepFor(90 * DAY), 360 * MIN);
  assert.equal(stepFor(365 * DAY), DAY);
  for (const days of [1, 7, 30, 90]) assert.ok((days * DAY) / stepFor(days * DAY) <= MOST_STEPS);
});

test('VMs up in each step: the time each VM spent in it, by kind', () => {
  const steps = vmsUp(
    [
      // Up the whole first step, and half the second.
      { pool: 'linux', startedAt: 0, endedAt: 15 * MIN },
      // Half the first step.
      { pool: 'macos', startedAt: 5 * MIN, endedAt: 10 * MIN },
      // Before the range, and after it: not counted.
      { pool: 'linux', startedAt: -20 * MIN, endedAt: -10 * MIN },
      { pool: 'linux', startedAt: 40 * MIN, endedAt: 50 * MIN },
    ],
    0,
    30 * MIN,
    10 * MIN,
  );
  assert.deepEqual(
    steps.map(({ at, linux, macos }) => ({ at, linux, macos })),
    [
      { at: 0, linux: 1, macos: 0.5 },
      { at: 10 * MIN, linux: 0.5, macos: 0 },
      { at: 20 * MIN, linux: 0, macos: 0 },
    ],
  );
});

test('the view counts the VMs up now, which the history has not got until they end', () => {
  const history = new MemoryHistory();
  const view = historyView(
    history,
    0,
    30 * MIN,
    [{ pool: 'macos', createdAt: 20 * MIN }],
    30 * MIN,
  );
  assert.equal(view.stepMs, MIN);
  assert.equal(view.vms.at(-1)?.macos, 1);
  assert.equal(view.oldestAt, null, 'nothing kept yet');
});

test('the most VMs up at once in each step, apart from the average', () => {
  const steps = vmsUp(
    [
      // Three Linux VMs up together for a minute of a ten-minute step.
      { pool: 'linux', startedAt: 2 * MIN, endedAt: 3 * MIN },
      { pool: 'linux', startedAt: 2 * MIN, endedAt: 3 * MIN },
      { pool: 'linux', startedAt: 2 * MIN, endedAt: 3 * MIN },
      // One deleted as the next is cloned is never two at once.
      { pool: 'macos', startedAt: 10 * MIN, endedAt: 15 * MIN },
      { pool: 'macos', startedAt: 15 * MIN, endedAt: 20 * MIN },
      // Up from before the range into its second step.
      { pool: 'linux', startedAt: -5 * MIN, endedAt: 12 * MIN },
    ],
    0,
    20 * MIN,
    10 * MIN,
  );
  assert.deepEqual(
    steps.map(({ at, linuxMost, macosMost, most }) => ({ at, linuxMost, macosMost, most })),
    [
      { at: 0, linuxMost: 4, macosMost: 0, most: 4 },
      { at: 10 * MIN, linuxMost: 1, macosMost: 1, most: 2 },
    ],
  );
  assert.equal(steps[0]?.linux, 1.3);
});

test('a range lines up with the Mac’s clock and ends with the step that holds its end', () => {
  const end = new Date(2026, 10, 22, 14, 7, 31, 250).getTime();
  const day = rangeFor(1, end);
  assert.equal(day.to, new Date(2026, 10, 22, 14, 10).getTime(), 'the five minutes holding it');
  assert.equal(day.to - day.from, DAY);
  const year = rangeFor(365, end);
  assert.equal(year.to, new Date(2026, 10, 23).getTime(), 'the next midnight');
  // Stepping back from where a range begins gives the one just before it.
  assert.equal(rangeFor(1, day.from).to, day.from);
});

test('VMs are not counted as none before anything was kept', () => {
  const history = new MemoryHistory([], [sampleAt(20 * MIN)]);
  const view = historyView(history, 0, 30 * MIN, [], 30 * MIN);
  assert.equal(view.vms[0]?.at, 20 * MIN);
  assert.equal(view.oldestAt, 20 * MIN);
});
