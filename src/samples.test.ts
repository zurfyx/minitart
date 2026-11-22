import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResourcePoint } from './resources.ts';
import { asPoint, MINUTE_MS, Minutes, summarise } from './samples.ts';

const point = (at: number, cpu: number): ResourcePoint => ({
  at,
  cpuVms: cpu,
  cpuOther: 10,
  memVms: 1024,
  memOther: 2048,
  netVmsDown: cpu * 1000,
  netVmsUp: 0,
  netOtherDown: 0,
  netOtherUp: 0,
  diskUsed: 300_000,
});

test('a minute keeps its average and its peak', () => {
  const minute = summarise(0, [point(0, 10), point(10_000, 30), point(20_000, 80)]);
  assert.equal(minute.cpuVms, 40);
  assert.equal(minute.cpuVmsMax, 80);
  assert.equal(minute.netVmsDown, 40_000);
  assert.equal(minute.netVmsDownMax, 80_000);
  assert.deepEqual(asPoint(minute).cpuVms, 40, 'as a chart point: its average');
});

test('a minute is handed over when a point of a later one comes, and only once', () => {
  const minutes = new Minutes();
  const start = 10 * MINUTE_MS;
  assert.equal(minutes.add(point(start, 10)), null);
  assert.equal(minutes.add(point(start + 50_000, 30)), null);
  assert.equal(minutes.add(point(start + 50_000, 99)), null, 'a point already taken is ignored');
  const done = minutes.add(point(start + MINUTE_MS + 1000, 70));
  assert.deepEqual([done?.at, done?.cpuVms, done?.cpuVmsMax], [start, 20, 30]);
  // A gap of minutes with no points (minitart stopped) hands over the last one with points.
  const later = minutes.add(point(start + 10 * MINUTE_MS, 5));
  assert.deepEqual([later?.at, later?.cpuVms], [start + MINUTE_MS, 70]);
});
