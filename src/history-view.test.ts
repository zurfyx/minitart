import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryHistory } from './history.ts';
import { historyView, MOST_STEPS, stepFor, vmsUp } from './history-view.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

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
  assert.deepEqual(steps, [
    { at: 0, linux: 1, macos: 0.5 },
    { at: 10 * MIN, linux: 0.5, macos: 0 },
    { at: 20 * MIN, linux: 0, macos: 0 },
  ]);
});

test('the view counts the VMs up now, which the history has not got until they end', () => {
  const history = new MemoryHistory();
  const view = historyView(history, 0, 30 * MIN, [{ pool: 'macos', createdAt: 20 * MIN }]);
  assert.equal(view.stepMs, MIN);
  assert.equal(view.vms.at(-1)?.macos, 1);
  assert.equal(view.oldestAt, null, 'nothing kept yet');
});
