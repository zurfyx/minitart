// Scenarios ported from the test suites of similar projects: settings validation, runner
// versions, VM names, and the arguments `tart` is run with.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRunnerRelease } from './image.ts';
import { isJobVm } from './manager.ts';
import { defaultSettings, mergeSettings, SettingsError } from './settings.ts';
import { TartCli } from './tart.ts';

const GB = 1024 ** 3;
const mini = { cpus: 15, memoryBytes: 64 * GB };

// After sand Tests/sandTests/ConfigValidatorTests.swift: testInvalidConfigReportsIssues
test('settings: each number is accepted at its bounds and refused one past them', () => {
  const base = defaultSettings(mini);
  const accepted: unknown[] = [
    { pollSeconds: 2 },
    { pollSeconds: 300 },
    { idleSeconds: 30 },
    { idleSeconds: 3600 },
    { vm: { cpu: 1 } },
    { vm: { cpu: 15 } },
    { vm: { memoryMb: 2048 } },
    // The largest VM there can be is the only VM there is.
    { vm: { memoryMb: 64 * 1024 }, linux: { max: 1 }, macos: { max: 0 } },
    { linux: { max: 0 } },
    { linux: { max: 8 }, vm: { memoryMb: 4096 } },
    { macos: { max: 0 } },
  ];
  for (const patch of accepted) mergeSettings(base, patch, mini);
  const refused: unknown[] = [
    { pollSeconds: 1 },
    { pollSeconds: 301 },
    { idleSeconds: 29 },
    { idleSeconds: 3601 },
    { vm: { cpu: 0 } },
    { vm: { cpu: 16 } },
    { vm: { memoryMb: 2047 } },
    { vm: { memoryMb: 64 * 1024 + 1 } },
    { linux: { max: -1 } },
    { linux: { max: 9 } },
    { pollSeconds: Number.NaN },
  ];
  for (const patch of refused) {
    assert.throws(() => mergeSettings(base, patch, mini), SettingsError, JSON.stringify(patch));
  }
});

// After runscaler internal/config/load_test.go: TestLoad_UnknownKeys
test('settings: an unknown field inside a section, or a null, is refused rather than ignored', () => {
  const base = defaultSettings(mini);
  assert.throws(() => mergeSettings(base, { linux: { maxx: 4 } }, mini), SettingsError);
  assert.throws(() => mergeSettings(base, { vm: { memory: 8192 } }, mini), SettingsError);
  assert.throws(() => mergeSettings(base, { idleSeconds: null }, mini), SettingsError);
});

// After macos-ephemeral-runners config_test.go: TestBudgetMustFitEveryPool
test('settings: VMs that together need more memory than the Mac has are refused', () => {
  const base = defaultSettings(mini);
  assert.throws(
    () => mergeSettings(base, { linux: { max: 8 }, vm: { memoryMb: 64 * 1024 } }, mini),
    SettingsError,
  );
});

// After sand Tests/sandTests/GitHubRunnerVersionResolverTests.swift: testParseTagName
test('runner release: only a plain v-prefixed version is taken', () => {
  const body = `<!-- BEGIN SHA linux-arm64 -->${'c'.repeat(64)}<!-- END SHA linux-arm64 -->`;
  assert.equal(parseRunnerRelease({ tag_name: 'v2.331.0', body }, 'linux').version, '2.331.0');
  for (const tag of ['v2.331.0-beta', 'v', '', '2.331.0', 'v2.331', 'v2.331.0.1']) {
    assert.throws(() => parseRunnerRelease({ tag_name: tag, body }, 'linux'), /no checksum/, tag);
  }
});

// After runscaler internal/provider/ownership_test.go: TestOwnsTartVMAcceptsOnlyRunnerGeneratedLocalNames
test('a job VM is exactly minitart-<kind>-<6 lowercase hex>; nothing near it is one', () => {
  assert.ok(isJobVm('minitart-linux-0a1b2c'));
  assert.ok(isJobVm('minitart-macos-ffffff'));
  for (const name of [
    'minitart-base-linux',
    'minitart-linux-0A1B2C',
    'minitart-linux-0a1b2',
    'minitart-linux-0a1b2c3',
    'minitart-windows-0a1b2c',
    'minitart-linux-0a1b2c-staging',
    'my-minitart-linux-0a1b2c',
    'minitart-linux-0a1b2g',
    'minitart-linux-0a1b2c\n',
  ]) {
    assert.ok(!isJobVm(name), JSON.stringify(name));
  }
});

// After graftery tart_test.go: TestTartRunArgs_NoSharedDir
test('tart run: no shared folder, no graphics, no clipboard, and the network it was given', async () => {
  // `echo` stands in for tart: it prints the arguments it was run with.
  const lines: string[] = [];
  await new TartCli('echo').boot('minitart-linux-0a1b2c', 'softnet', (line) => lines.push(line));
  assert.deepEqual(lines, [
    'run minitart-linux-0a1b2c --no-graphics --no-audio --no-clipboard --net-softnet --net-softnet-block=100.64.0.0/10',
  ]);
  assert.ok(!lines.join(' ').includes('--dir'));
});

// After runscaler internal/provider/tart_test.go: TestRunnerStartCmd_PassesJITConfigBeforeDeletingIt
test('tart exec: what goes in on standard input is never an argument', async () => {
  const lines: string[] = [];
  const code = await new TartCli('echo').exec('minitart-linux-0a1b2c', ['/bin/bash', '-lc', 'x'], {
    stdin: 'jit-secret\n',
    onLine: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(lines, ['exec -i minitart-linux-0a1b2c /bin/bash -lc x']);
});
