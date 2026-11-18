import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { atLeast, neverSleeps, runChecks, softnetIsSetuidRoot } from './doctor.ts';
import { buildImage, parseRunnerRelease, type BuiltImage } from './image.ts';
import { plist } from './service.ts';
import { probes, probeScript, reached } from './selftest.ts';
import { defaultSettings } from './settings.ts';
import { networkArgs, lineSplitter } from './tart.ts';
import { FakeTart } from './testing/fakes.ts';

const settings = defaultSettings({ cpus: 15, memoryBytes: 64 * 1024 ** 3 });
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('softnet is the network unless the owner asked for the unsafe one', () => {
  assert.deepEqual(networkArgs('softnet'), ['--net-softnet', '--net-softnet-block=100.64.0.0/10']);
  assert.deepEqual(networkArgs('shared'), []);
});

test('lines are split across chunks', () => {
  const lines: string[] = [];
  const splitter = lineSplitter((line) => lines.push(line));
  splitter.push('one\ntw');
  splitter.push('o\r\nthree');
  splitter.end();
  assert.deepEqual(lines, ['one', 'two', 'three']);

  // Output with no newline in it is cut up, not held.
  const cut: string[] = [];
  const endless = lineSplitter((line) => cut.push(line));
  endless.push('z'.repeat(10_000));
  assert.deepEqual(
    cut.map((line) => line.length),
    [4096, 4096],
  );
});

test('doctor: softnet must be setuid root', () => {
  assert.ok(softnetIsSetuidRoot({ uid: 0, mode: 0o104755 }));
  assert.ok(!softnetIsSetuidRoot({ uid: 501, mode: 0o104755 }));
  assert.ok(!softnetIsSetuidRoot({ uid: 0, mode: 0o100755 }));
});

test('doctor: a Mac that sleeps is flagged', () => {
  assert.ok(neverSleeps(' standby  1\n sleep                0\n disksleep 10'));
  assert.ok(!neverSleeps(' sleep                1 (sleep prevented by caffeinate)'));
  assert.ok(!neverSleeps(' displaysleep         0'));
});

test('doctor: each thing that is missing comes with the command that fixes it', async () => {
  const checks = await runChecks({
    network: 'softnet',
    settings,
    images: new Set(['minitart-base-linux']),
    hasApp: false,
    run: async (command) => (command === 'tart' ? '2.42.0\n' : ' sleep 1\n'),
    softnet: () => ({
      path: '/opt/homebrew/Cellar/softnet/0.26.0/bin/softnet',
      uid: 501,
      mode: 0o100755,
    }),
  });
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  assert.equal(byId['tart']?.ok, true);
  assert.equal(byId['network']?.ok, false);
  assert.match(byId['network']?.fix ?? '', /^sudo chown root \/opt\/homebrew\/Cellar\/softnet/);
  assert.equal(byId['image-linux']?.ok, true);
  assert.equal(byId['image-macos']?.fix, 'minitart image build macos');
  assert.equal(byId['github']?.ok, false);
  assert.equal(byId['sleep']?.fix, 'sudo pmset -a sleep 0');

  const unsafe = await runChecks({
    network: 'shared',
    settings,
    images: null,
    hasApp: true,
    run: async () => null,
  });
  assert.equal(unsafe.find((check) => check.id === 'network')?.ok, false);
  assert.equal(unsafe.find((check) => check.id === 'tart')?.fix, 'brew install openai/tools/tart');
});

test('doctor: versions, a stale runner, a full disk, and a Mac that will not log in by itself', async () => {
  assert.ok(atLeast('2.42.0', '2.42.0'));
  assert.ok(atLeast('softnet 0.26.0-816f07a', '0.24.1'));
  assert.ok(atLeast('3.0.0', '2.42.0'));
  assert.ok(!atLeast('2.41.9', '2.42.0'));
  assert.ok(!atLeast('0.24.0', '0.24.1'));

  const checks = await runChecks({
    network: 'softnet',
    settings,
    images: new Set(['minitart-base-linux', 'minitart-base-macos']),
    hasApp: true,
    run: async (command) =>
      ({
        tart: '2.33.0\n',
        softnet: 'softnet 0.24.0\n',
        pmset: ' sleep 0\n',
        fdesetup: 'FileVault is On.\n',
      })[command] ?? null,
    softnet: () => ({ path: '/opt/homebrew/bin/softnet', uid: 0, mode: 0o104755 }),
    runners: { have: { linux: '2.330.0', macos: '2.338.2' }, latest: '2.338.2' },
    freeDiskGb: 12,
  });
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  assert.equal(byId['tart']?.fix, 'brew upgrade tart');
  assert.equal(byId['network']?.fix, 'brew upgrade softnet');
  assert.match(byId['runner-linux']?.detail ?? '', /2\.330\.0.*2\.338\.2/);
  assert.equal(byId['runner-linux']?.optional, true);
  assert.equal(byId['runner-macos'], undefined);
  assert.equal(byId['disk']?.ok, false);
  assert.deepEqual([byId['login']?.ok, byId['login']?.optional], [false, true]);
  assert.match(byId['login']?.fix ?? '', /FileVault/);
});

test('selftest: the internet must answer; the router and this Mac must not', () => {
  const list = probes({ addresses: ['192.168.1.20', '100.64.0.7'], gateway: '192.168.1.1' });
  assert.deepEqual(
    list.filter((probe) => probe.expect === 'reachable').map((probe) => probe.what),
    ['the internet: github.com', 'the internet: registry.npmjs.org'],
  );
  assert.ok(list.some((probe) => probe.what === 'your router 192.168.1.1:443'));
  assert.ok(list.some((probe) => probe.what === 'this Mac at 100.64.0.7:22'));
  const script = probeScript(list);
  assert.match(script, /\/dev\/tcp\/192\.168\.1\.1\/443/);
  assert.match(script, /wait$/);
  // A refused connection means the packet arrived: that address is not blocked.
  assert.deepEqual(['open', 'refused', 'timeout', 'unreachable'].map(reached), [
    true,
    true,
    false,
    false,
  ]);
});

const release = {
  tag_name: 'v2.338.2',
  body: `- actions-runner-osx-arm64-2.338.2.tar.gz <!-- BEGIN SHA osx-arm64 -->${'a'.repeat(64)}<!-- END SHA osx-arm64 -->\n- actions-runner-linux-arm64-2.338.2.tar.gz <!-- BEGIN SHA linux-arm64 -->${'b'.repeat(64)}<!-- END SHA linux-arm64 -->`,
};

test('image: the runner comes from the release, with the checksum GitHub publishes', () => {
  assert.deepEqual(parseRunnerRelease(release, 'linux'), {
    version: '2.338.2',
    sha256: 'b'.repeat(64),
    url: 'https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-linux-arm64-2.338.2.tar.gz',
  });
  assert.equal(parseRunnerRelease(release, 'macos').sha256, 'a'.repeat(64));
  assert.throws(
    () => parseRunnerRelease({ tag_name: 'v2.338.2', body: '' }, 'linux'),
    /no checksum/,
  );
  assert.throws(() => parseRunnerRelease({ ...release, tag_name: "v1'; rm -rf" }, 'linux'));
});

test('image: built in a staging VM, and the old image goes only once the new one is whole', async () => {
  const tart = new FakeTart();
  tart.addImage('minitart-base-linux');
  const options = {
    tart,
    pool: 'linux' as const,
    from: 'ghcr.io/cirruslabs/ubuntu:latest',
    name: 'minitart-base-linux',
    network: 'softnet' as const,
    runner: parseRunnerRelease(release, 'linux'),
    print: () => {},
    record: (image: BuiltImage) => built.push(image),
    sleep: async () => {},
  };
  const built: BuiltImage[] = [];
  await buildImage(options);
  assert.deepEqual([...tart.vms.keys()].sort(), [
    'ghcr.io/cirruslabs/ubuntu:latest',
    'minitart-base-linux',
  ]);
  assert.deepEqual(tart.networks, ['softnet']);
  assert.deepEqual(tart.resized, [['minitart-build-linux', 50]]);
  assert.equal(built[0]?.runner, '2.338.2');
  const install = tart.commands.find((command) => command[1] === '/bin/bash');
  assert.match(install?.[3] ?? '', /RUNNER_SHA256='b{64}'/);
  assert.match(install?.[3] ?? '', /sha256sum -c/);

  // A failed install leaves the image that was there.
  tart.exec = async (_name, command) => (command[0] === 'true' ? 0 : 1);
  await assert.rejects(buildImage(options), /install script exited with code 1/);
  assert.deepEqual([...tart.vms.keys()].sort(), [
    'ghcr.io/cirruslabs/ubuntu:latest',
    'minitart-base-linux',
  ]);
});

test('the image scripts verify the runner download and stop on the first error', () => {
  for (const pool of ['linux', 'macos']) {
    const script = read(`../images/${pool}.sh`);
    assert.match(script, /set -euo pipefail/);
    assert.match(script, /\$RUNNER_SHA256 {2}runner\.tar\.gz/);
  }
});

test('the service is a LaunchAgent that restarts, with Homebrew on its PATH', () => {
  const xml = plist({
    node: '/opt/homebrew/bin/node',
    main: '/Users/me/minitart/src/main.ts',
    args: ['--port', '4141', '--allow-host', 'mini & co'],
    log: '/Users/me/.minitart/logs/manager.log',
    path: '/opt/homebrew/bin:/usr/bin',
  });
  assert.match(xml, /<string>sh\.rovira\.minitart<\/string>/);
  assert.match(xml, /<string>start<\/string>\n {4}<string>--port<\/string>/);
  assert.match(xml, /<key>KeepAlive<\/key>\n {2}<true\/>/);
  assert.match(xml, /mini &amp; co/);
  // launchd waits a minute for minitart to delete its VMs before it kills it.
  assert.match(xml, /<key>ExitTimeOut<\/key>\n {2}<integer>60<\/integer>/);
  assert.ok(!xml.includes('MINITART_HOME'));
  const elsewhere = plist({ node: 'n', main: 'm', args: [], log: 'l', path: 'p', home: '/tmp/mt' });
  assert.match(elsewhere, /<key>MINITART_HOME<\/key>\n {4}<string>\/tmp\/mt<\/string>/);
});
