import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareProviders,
  daysCounted,
  everyDay,
  localDay,
  macCost,
  MONTH_DAYS,
  perMonth,
  totals,
  usd,
} from './cost.js';

const providers = [
  {
    id: 'github',
    name: 'GitHub-hosted',
    linux: [
      { id: 'linux-2-x64', usd: 0.006 },
      { id: 'linux-4-arm', usd: 0.008 },
    ],
    macos: [{ id: 'macos', usd: 0.062 }],
  },
  {
    id: 'blacksmith',
    name: 'Blacksmith',
    linux: [{ id: 'linux-2-x64', usd: 0.004 }],
    macos: [{ id: 'macos-6', usd: 0.08 }],
  },
];

const since = new Date(2026, 10, 17).getTime(); // 17 Nov, local midnight
const usage = [
  { day: '2026-11-17', pool: 'linux', jobs: 10, minutes: 100, vmMinutes: 110 },
  { day: '2026-11-19', pool: 'linux', jobs: 5, minutes: 50, vmMinutes: 55 },
  { day: '2026-11-19', pool: 'macos', jobs: 2, minutes: 30, vmMinutes: 34 },
];

test('every day of the range is there, a day with no job as zero', () => {
  const days = everyDay(usage, since, 3);
  assert.deepEqual(
    days.map((day) => [day.day, day.linux, day.macos]),
    [
      ['2026-11-17', 100, 0],
      ['2026-11-18', 0, 0],
      ['2026-11-19', 50, 30],
    ],
  );
  assert.equal(localDay(days[2].at), '2026-11-19');
});

test('totals by kind', () => {
  assert.deepEqual(totals(usage), {
    linux: { jobs: 15, minutes: 150, vmMinutes: 165 },
    macos: { jobs: 2, minutes: 30, vmMinutes: 34 },
  });
});

test('each provider prices each kind at the runner chosen for it', () => {
  const rows = compareProviders(totals(usage), providers, [
    { provider: 'blacksmith', linux: 'linux-2-x64', macos: 'macos-6' },
    { provider: 'github', linux: 'linux-4-arm', macos: 'macos' },
    { provider: 'gone', linux: 'x', macos: 'y' },
  ]);
  assert.deepEqual(
    rows.map((row) => [
      row.provider.id,
      row.linuxUsd.toFixed(3),
      row.macosUsd.toFixed(3),
      row.usd.toFixed(3),
    ]),
    [
      ['blacksmith', '0.600', '2.400', '3.000'],
      ['github', '1.200', '1.860', '3.060'],
    ],
    'in the order chosen, and a provider no longer listed left out',
  );
});

test('only the days minitart kept a history count toward a month', () => {
  const now = new Date(2026, 10, 19, 15).getTime();
  const oldest = new Date(2026, 10, 18, 9).getTime();
  assert.equal(daysCounted(new Date(2026, 9, 21).getTime(), 30, oldest, now), 2);
  assert.equal(daysCounted(since, 3, new Date(2026, 0, 1).getTime(), now), 3);
  assert.equal(daysCounted(since, 3, null, now), 0);
  assert.equal(perMonth(10, 2), (10 / 2) * MONTH_DAYS);
  assert.equal(perMonth(10, 0), 0);
});

test('this Mac: its price over its life, and its power all day, each only when given', () => {
  const none = { macUsd: null, lifeMonths: 36, watts: null, kwhUsd: null };
  assert.deepEqual(macCost(none, 30), { mac: null, power: null, usd: null });
  const priced = { macUsd: 2196, lifeMonths: 36, watts: 20, kwhUsd: 0.3 };
  const month = macCost(priced, MONTH_DAYS);
  assert.equal(month.mac?.toFixed(2), '61.00');
  // 20 W all day is 0.48 kWh a day, $0.144 a day.
  assert.equal(month.power?.toFixed(2), (0.144 * MONTH_DAYS).toFixed(2));
  assert.equal(macCost({ ...priced, kwhUsd: null }, 10).power, null);
});

test('dollars: cents when small, whole when large', () => {
  assert.equal(usd(0.6), '$0.60');
  assert.equal(usd(1234.4), '$1,234');
  assert.equal(usd(null), '–');
});
