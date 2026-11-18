import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, mergeSettings, SettingsError } from './settings.ts';

const GB = 1024 ** 3;
const mini = { cpus: 15, memoryBytes: 64 * GB };

test('defaults fit the machine', () => {
  const big = defaultSettings(mini);
  assert.deepEqual([big.macos.max, big.linux.max], [2, 2]);
  assert.deepEqual(big.vm, { cpu: 5, memoryMb: 12 * 1024 });
  assert.equal(big.allowPublicRepos, false);

  const small = defaultSettings({ cpus: 8, memoryBytes: 16 * GB });
  assert.deepEqual(small.vm, { cpu: 2, memoryMb: 4 * 1024 });
  // Three 4 GB VMs fit in three quarters of 16 GB.
  assert.equal(small.macos.max + small.linux.max, 3);
});

test('a patch changes only what it names', () => {
  const base = defaultSettings(mini);
  const next = mergeSettings(base, { linux: { max: 4 }, pausedRepos: ['octo/app'] }, mini);
  assert.equal(next.linux.max, 4);
  assert.equal(next.linux.image, base.linux.image);
  assert.deepEqual(next.pausedRepos, ['octo/app']);
  assert.deepEqual(next.macos, base.macos);
});

test('more than two macOS VMs is refused', () => {
  const base = defaultSettings(mini);
  assert.throws(() => mergeSettings(base, { macos: { max: 3 } }, mini), SettingsError);
});

test('untrusted input is refused, not coerced', () => {
  const base = defaultSettings(mini);
  const bad: unknown[] = [
    null,
    [],
    { nope: 1 },
    { linux: { max: '2' } },
    { linux: { max: 1.5 } },
    { linux: { image: '--dir=/Users' } },
    { vm: { cpu: 64 } },
    { vm: { memoryMb: 1 } },
    { pollSeconds: 0 },
    { allowPublicRepos: 'yes' },
    { pausedRepos: ['not a repo'] },
    { pausedRepos: 'octo/app' },
  ];
  for (const patch of bad) {
    assert.throws(() => mergeSettings(base, patch, mini), SettingsError, JSON.stringify(patch));
  }
});
