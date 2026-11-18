import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  defaultSettings,
  FIREWALL_INTERFACES,
  LINUX_VM_LIMIT,
  MACOS_VM_LIMIT,
  mergeSettings,
  SettingsError,
  SPARE_INTERFACES,
} from './settings.ts';

const GB = 1024 ** 3;
const mini = { cpus: 15, memoryBytes: 64 * GB };

test('defaults fit the machine', () => {
  const big = defaultSettings(mini);
  // 64 GB: six 8 GB VMs fit in three quarters of it. Two are macOS, the rest Linux.
  assert.deepEqual([big.macos.max, big.linux.max], [2, 4]);
  // 8 GB each, however much the Mac has: a VM ends up using what it is given.
  assert.equal(big.vm.memoryMb, 8 * 1024);
  assert.equal(defaultSettings({ cpus: 24, memoryBytes: 512 * GB }).vm.memoryMb, 8 * 1024);
  // Six VMs on fifteen cores: 3 CPUs each, 18 in all.
  assert.equal(big.vm.cpu, 3);
  assert.equal(big.allowPublicRepos, false);

  const small = defaultSettings({ cpus: 8, memoryBytes: 16 * GB });
  assert.deepEqual(small.vm, { cpu: 3, memoryMb: 4 * 1024 });
  // Three 4 GB VMs fit in three quarters of 16 GB.
  assert.equal(small.macos.max + small.linux.max, 3);

  // Plenty of memory does not mean plenty of VMs: each needs two CPUs' worth of the Mac.
  const wide = defaultSettings({ cpus: 12, memoryBytes: 512 * GB });
  assert.equal(wide.macos.max + wide.linux.max, 6);

  // Whatever the machine: the VMs fit its memory together, and all of them busy want about
  // as many CPUs as it has, at most one and a half times as many.
  for (const cpus of [1, 2, 4, 8, 10, 12, 15, 16, 24, 32, 64]) {
    for (const gb of [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 512]) {
      const machine = { cpus, memoryBytes: gb * GB };
      const { vm, linux, macos } = defaultSettings(machine);
      const vms = linux.max + macos.max;
      assert.ok(vms * vm.memoryMb <= gb * 1024, `memory on ${cpus} cores, ${gb} GB`);
      // Below four cores a VM cannot have fewer than all of them, so only its own size counts.
      assert.ok(vm.cpu <= cpus, `a VM's CPUs on ${cpus} cores`);
      if (cpus >= 4) assert.ok(vms * vm.cpu <= cpus * 1.5, `CPUs on ${cpus} cores, ${gb} GB`);
      assert.doesNotThrow(() => mergeSettings(defaultSettings(machine), {}, machine));
    }
  }
});

test('Linux VMs are limited by what the firewall rule covers, and by nothing else', () => {
  // The rule names a fixed list of interfaces, and a VM beyond it would not be behind it.
  const script = readFileSync(new URL('../firewall/install.sh', import.meta.url), 'utf8');
  const first = Number(/^\s*n=(\d+)$/m.exec(script)?.[1]);
  const last = Number(/while \[ "\$n" -le (\d+) \]/.exec(script)?.[1]);
  assert.equal(last - first + 1, FIREWALL_INTERFACES, 'the script and the limit agree');
  // Every VM minitart can run, and two it does not count, fit in the list.
  assert.equal(LINUX_VM_LIMIT + MACOS_VM_LIMIT + SPARE_INTERFACES, FIREWALL_INTERFACES);
  assert.equal(LINUX_VM_LIMIT, 28);

  const huge = { cpus: 64, memoryBytes: 512 * GB };
  const base = defaultSettings(huge);
  assert.equal(
    mergeSettings(base, { linux: { max: 28 }, vm: { memoryMb: 4096 } }, huge).linux.max,
    28,
  );
  assert.throws(
    () => mergeSettings(base, { linux: { max: 29 }, vm: { memoryMb: 4096 } }, huge),
    SettingsError,
  );
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
