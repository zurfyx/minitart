import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, mergeSettings, SettingsError } from './settings.ts';

const GB = 1024 ** 3;
const mini = { cpus: 15, memoryBytes: 64 * GB };

test('defaults fit the machine', () => {
  const big = defaultSettings(mini);
  assert.deepEqual([big.macos.max, big.linux.max], [2, 2]);
  // 8 GB each, however much the Mac has: a VM ends up using what it is given.
  assert.deepEqual(big.vm, { cpu: 4, memoryMb: 8 * 1024 });
  assert.equal(defaultSettings({ cpus: 24, memoryBytes: 512 * GB }).vm.memoryMb, 8 * 1024);
  assert.equal(big.allowPublicRepos, false);

  const small = defaultSettings({ cpus: 8, memoryBytes: 16 * GB });
  assert.deepEqual(small.vm, { cpu: 3, memoryMb: 4 * 1024 });
  // Three 4 GB VMs fit in three quarters of 16 GB.
  assert.equal(small.macos.max + small.linux.max, 3);

  // Whatever the machine: the VMs fit its memory together, and all of them busy want about
  // as many CPUs as it has, at most twice as many (a 4-core Mac with a lot of memory).
  for (const cpus of [1, 2, 4, 8, 10, 12, 15, 16, 24, 32]) {
    for (const gb of [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 512]) {
      const machine = { cpus, memoryBytes: gb * GB };
      const { vm, linux, macos } = defaultSettings(machine);
      const vms = linux.max + macos.max;
      assert.ok(vms * vm.memoryMb <= gb * 1024, `memory on ${cpus} cores, ${gb} GB`);
      // Below four cores a VM cannot have fewer than all of them, so only its own size counts.
      assert.ok(vm.cpu <= cpus, `a VM's CPUs on ${cpus} cores`);
      if (cpus >= 4) assert.ok(vms * vm.cpu <= cpus * 2, `CPUs on ${cpus} cores, ${gb} GB`);
      assert.doesNotThrow(() => mergeSettings(defaultSettings(machine), {}, machine));
    }
  }
});

test('a patch changes only what it names', () => {
  const base = defaultSettings(mini);
  const next = mergeSettings(base, { linux: { max: 3 }, repos: ['octo/app'] }, mini);
  assert.equal(next.linux.max, 3);
  assert.equal(next.linux.image, base.linux.image);
  assert.deepEqual(next.repos, ['octo/app']);
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
    { repos: ['not a repo'] },
    { repos: 'octo/app' },
    { pausedRepos: [] },
  ];
  for (const patch of bad) {
    assert.throws(() => mergeSettings(base, patch, mini), SettingsError, JSON.stringify(patch));
  }
});
