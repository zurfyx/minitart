import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  applyFixes,
  atLeast,
  blockedBy,
  FIREWALL_VERSION,
  neverSleeps,
  runChecks,
  softnetIsSetuidRoot,
} from './doctor.ts';
import { buildImage, parseRunnerRelease, type BuiltImage } from './image.ts';
import { plist, stableNode } from './service.ts';
import { passed, probes, probeScript, reached, wildcardListeners } from './selftest.ts';
import { defaultSettings } from './settings.ts';
import { availableMb } from './memory.ts';
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
    firewall: () => ({ rules: '# minitart firewall v1. Written by…', daemon: true }),
    runners: { have: { linux: '2.330.0', macos: '2.338.2' }, latest: '2.338.2' },
    freeDiskGb: 12,
    tailnet: [
      {
        host: 'minitart.example.ts.net',
        origin: 'https://minitart.example.ts.net',
        service: 'svc:minitart',
        refused: null,
        fix: null,
      },
      {
        host: 'mini.example.ts.net:8443',
        origin: 'https://mini.example.ts.net:8443',
        service: null,
        refused: 'funnel',
        fix: 'tailscale serve --bg --https=8443 http://127.0.0.1:4141',
      },
    ],
  });
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  assert.equal(byId['tart']?.fix, 'brew upgrade tart');
  assert.equal(
    byId['network']?.fix,
    'brew unpin softnet && brew upgrade openai/tools/softnet && brew pin softnet',
  );
  assert.match(byId['runner-linux']?.detail ?? '', /2\.330\.0.*2\.338\.2/);
  assert.equal(byId['runner-linux']?.optional, true);
  assert.equal(byId['runner-macos'], undefined);
  assert.equal(byId['disk']?.ok, false);
  assert.deepEqual([byId['login']?.ok, byId['login']?.optional], [false, true]);
  assert.match(
    byId['tailnet-minitart.example.ts.net']?.detail ?? '',
    /https:\/\/minitart\.example\.ts\.net/,
  );
  assert.equal(byId['tailnet-mini.example.ts.net:8443']?.ok, false);
  assert.equal(
    byId['tailnet-mini.example.ts.net:8443']?.fix,
    'tailscale serve --bg --https=8443 http://127.0.0.1:4141',
  );
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
  // The VM's own gateway is this Mac, and only the VM knows its address.
  assert.match(script, /^GW=\$\(ip route/);
  assert.match(script, /\/dev\/tcp\/\$GW\/5000/);
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
    args: ['--port', '4141', '--label', 'mini & co'],
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

test("selftest: what this Mac serves to every network is looked for at the VM's gateway", () => {
  const lsof = [
    'COMMAND     PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
    'ControlCe  1234 owner   10u  IPv4 0x1      0t0  TCP *:5000 (LISTEN)',
    'ControlCe  1234 owner   11u  IPv6 0x2      0t0  TCP *:7000 (LISTEN)',
    'node       2345 owner   20u  IPv4 0x3      0t0  TCP 127.0.0.1:4141 (LISTEN)',
    'rapportd   3456 owner    4u  IPv4 0x4      0t0  TCP *:49362 (LISTEN)',
  ].join('\n');
  const listening = wildcardListeners(lsof);
  assert.deepEqual(listening, [
    { port: 5000, command: 'ControlCe' },
    { port: 7000, command: 'ControlCe' },
    { port: 49362, command: 'rapportd' },
  ]);
  const gateway = probes({ addresses: [], gateway: null, listening }).filter(
    (probe) => 'gateway' in probe.target,
  );
  assert.ok(
    gateway.some((probe) => probe.what === "this Mac at the VM's gateway, port 49362 (rapportd)"),
  );
  assert.ok(gateway.some((probe) => probe.what === "this Mac at the VM's gateway, port 22"));
  assert.ok(gateway.every((probe) => probe.expect === 'closed'));
  // The gateway answers by design, so only an open port is a failure there.
  // A probe that could not find the gateway, or got no clear answer from it, proves nothing.
  assert.deepEqual(
    ['open', 'refused', 'timeout', 'unreachable', 'nogateway', 'not run'].map((saw) =>
      passed('closed', saw),
    ),
    [false, true, true, false, false, false],
  );
  assert.match(probeScript(gateway), /\[ -z "\$GW" \] && \{ echo "probe 0 nogateway"; exit; \}/);
  assert.deepEqual(
    ['open', 'refused', 'timeout', 'not run'].map((saw) => passed('blocked', saw)),
    [false, false, true, false],
  );
  assert.deepEqual(
    ['open', 'unreachable', 'not run'].map((saw) => passed('reachable', saw)),
    [true, false, false],
  );
});

test('doctor: the firewall that closes this Mac to its VMs is part of the setup', async () => {
  const check = async (firewall: { rules: string | null; daemon: boolean }) =>
    (
      await runChecks({
        network: 'softnet',
        settings,
        images: new Set(),
        hasApp: true,
        run: async () => null,
        softnet: () => ({ path: '/opt/homebrew/bin/softnet', uid: 0, mode: 0o104755 }),
        firewall: () => firewall,
      })
    ).find((c) => c.id === 'firewall');
  const missing = await check({ rules: null, daemon: false });
  assert.equal(missing?.ok, false);
  assert.match(missing?.fix ?? '', /^sudo sh \/.*\/firewall\/install\.sh$/);
  assert.equal(
    (await check({ rules: `# ${FIREWALL_VERSION}.\npass in …`, daemon: true }))?.ok,
    true,
  );
  // Rules that will not come back after a restart, or that an update has replaced, do not count.
  assert.equal((await check({ rules: `# ${FIREWALL_VERSION}.`, daemon: false }))?.ok, false);
  assert.equal((await check({ rules: '# minitart firewall v0.', daemon: true }))?.ok, false);
});

test('the firewall script writes the version doctor looks for, and passes only DHCP and DNS', () => {
  const script = read('../firewall/install.sh');
  assert.ok(script.includes(`echo "# ${FIREWALL_VERSION}.`));
  const rules = script
    .split('\n')
    .map((line) => /^\s*echo "((?:pass|block) .*)"$/.exec(line)?.[1])
    .filter((rule) => rule !== undefined);
  assert.deepEqual(rules, [
    'pass  out quick on bridge$n keep state',
    'pass  in quick on bridge$n proto udp from any to { (bridge$n), 255.255.255.255 } port { 53, 67 }',
    'pass  in quick on bridge$n proto tcp from any to (bridge$n) port 53',
    'block in quick on bridge$n from any to { (bridge$n), (bridge$n:broadcast), 255.255.255.255, 224.0.0.0/4, ff00::/8 }',
  ]);
  // Checked before anything is written, loaded before it is called installed, and nothing
  // but its own two files is touched.
  assert.ok(script.indexOf('pfctl -n') < script.indexOf('install -m 644'));
  assert.match(script, /if \[ "\$RULES" -eq 0 \]; then/);
  assert.ok(!/>\s*\/etc\/pf\.conf/.test(script));
});

test('the service runs Node by a path that outlives a Homebrew upgrade', () => {
  const links: Record<string, string> = {
    '/opt/homebrew/Cellar/node/26.13.1/bin/node': '/opt/homebrew/Cellar/node/26.13.1/bin/node',
    '/opt/homebrew/bin/node': '/opt/homebrew/Cellar/node/26.13.1/bin/node',
    '/usr/local/bin/node': '/usr/local/lib/another/node',
  };
  const linkedDirs: Record<string, string> = {
    '/tmp/shell-123/bin': '/opt/homebrew/Cellar/node/26.13.1/bin',
  };
  const realpath = (path: string) => {
    if (path.endsWith('/node')) {
      const real = links[path] ?? (path.startsWith('/tmp/shell-123/bin') ? exec : undefined);
      if (real === undefined) throw new Error('ENOENT');
      return real;
    }
    return linkedDirs[path] ?? path;
  };
  const exec = '/opt/homebrew/Cellar/node/26.13.1/bin/node';
  const dirs = [
    '/opt/homebrew/Cellar/node/26.13.1/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
  ];
  assert.equal(stableNode(exec, dirs, realpath), '/opt/homebrew/bin/node');
  // No link to it anywhere: the real path is all there is.
  assert.equal(stableNode(exec, ['/usr/local/bin', '/usr/bin'], realpath), exec);
  assert.equal(stableNode('/gone/node', dirs, realpath), '/gone/node');
  // A folder that is itself a link, as a version manager makes per shell, is not lasting.
  assert.equal(stableNode(exec, ['/tmp/shell-123/bin'], realpath), exec);
  assert.equal(
    stableNode(exec, ['/tmp/shell-123/bin', '/opt/homebrew/bin'], realpath),
    '/opt/homebrew/bin/node',
  );
  // launchd needs a full path: an empty or relative PATH entry is never used.
  assert.equal(stableNode(exec, ['', '.', 'bin'], realpath), exec);
});

test('doctor: a fix that is only a command can be run for the owner, and a newer version is advice', async () => {
  const checks = await runChecks({
    network: 'softnet',
    settings,
    images: new Set(['minitart-base-linux', 'minitart-base-macos']),
    hasApp: true,
    run: async (command) =>
      command === 'tart' ? '2.42.0\n' : command === 'pmset' ? ' sleep 1\n' : null,
    softnet: () => ({
      path: '/opt/homebrew/Cellar/softnet/0.27.0/bin/softnet',
      uid: 501,
      mode: 0o100755,
    }),
    firewall: () => ({ rules: null, daemon: false }),
    versions: { running: '0.3.1', latest: '0.4.0' },
  });
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  assert.deepEqual(byId['network']?.sudo, [
    ['chown', 'root', '/opt/homebrew/Cellar/softnet/0.27.0/bin/softnet'],
    ['chmod', 'u+s', '/opt/homebrew/Cellar/softnet/0.27.0/bin/softnet'],
  ]);
  assert.equal(byId['firewall']?.sudo?.[0]?.[0], 'sh');
  assert.match(byId['firewall']?.sudo?.[0]?.[1] ?? '', /\/firewall\/install\.sh$/);
  assert.deepEqual(byId['sleep']?.sudo, [['pmset', '-a', 'sleep', '0']]);
  // Things only the owner can do are never run for them.
  assert.equal(byId['github']?.sudo, undefined);
  assert.deepEqual(
    [byId['version']?.ok, byId['version']?.optional, byId['version']?.fix],
    [false, true, 'minitart upgrade'],
  );

  const current = await runChecks({
    network: 'softnet',
    settings,
    images: new Set(),
    hasApp: true,
    run: async () => null,
    softnet: () => ({ path: '/opt/homebrew/bin/softnet', uid: 0, mode: 0o104755 }),
    firewall: () => ({ rules: `# ${FIREWALL_VERSION}.`, daemon: true }),
    versions: { running: '0.4.0', latest: '0.4.0' },
  });
  assert.ok(!current.some((check) => check.id === 'version'));
  assert.ok(current.filter((check) => check.ok).every((check) => check.sudo === undefined));
});

test('doctor --fix can install the tools that are missing, so forgetting one costs nothing', async () => {
  const checks = await runChecks({
    network: 'softnet',
    settings,
    images: null,
    hasApp: false,
    // Only minitart was installed: no Tart, no Softnet.
    run: async () => null,
    tartInstalled: () => false,
    softnet: () => null,
    firewall: () => ({ rules: null, daemon: false }),
  });
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  assert.deepEqual(
    byId['tart']?.commands?.map((command) => command.argv.join(' ')),
    [
      'brew trust --formula openai/tools/tart openai/tools/softnet',
      'brew install openai/tools/tart',
      'brew pin softnet',
    ],
  );
  assert.equal(byId['network']?.commands?.[1]?.argv.join(' '), 'brew install openai/tools/softnet');
  // Trusting and pinning may not exist on an older Homebrew; the install is what must work.
  assert.deepEqual(
    byId['tart']?.commands?.map((command) => command.mayFail ?? false),
    [true, false, true],
  );
  // Nothing is installed as root, and a missing Softnet has no permission to set yet.
  assert.equal(byId['network']?.sudo, undefined);
  assert.equal(byId['tart']?.sudo, undefined);

  const present = await runChecks({
    network: 'softnet',
    settings,
    images: null,
    hasApp: false,
    run: async (command) => (command === 'tart' ? '2.42.0\n' : null),
    softnet: () => ({ path: '/opt/homebrew/bin/softnet', uid: 501, mode: 0o100755 }),
    firewall: () => ({ rules: null, daemon: false }),
  });
  assert.ok(
    present.every((check) => check.commands === undefined),
    'nothing to install',
  );
});

test('doctor --fix installs first, checks again, and only then asks for the password', async () => {
  // A Mac with only minitart on it. Installing Tart brings Softnet, as it does for real.
  const mac = { tart: false, softnet: false, setuid: false };
  const check = () =>
    runChecks({
      network: 'softnet',
      settings,
      images: null,
      hasApp: true,
      run: async (command) => (command === 'tart' && mac.tart ? '2.42.0\n' : null),
      tartInstalled: () => mac.tart,
      softnet: () =>
        mac.softnet
          ? {
              path: '/opt/homebrew/bin/softnet',
              uid: mac.setuid ? 0 : 501,
              mode: mac.setuid ? 0o104755 : 0o100755,
            }
          : null,
      firewall: () => ({ rules: `# ${FIREWALL_VERSION}.`, daemon: true }),
      freeDiskGb: 500,
    });
  const ran: string[] = [];
  const said: string[] = [];
  const checks = await applyFixes(
    check,
    (argv) => {
      ran.push(argv.join(' '));
      if (argv.join(' ') === 'brew install openai/tools/tart') mac.tart = mac.softnet = true;
      if (argv[0] === 'sudo' && argv[1] === 'chmod') mac.setuid = true;
      return 0;
    },
    (line) => said.push(line),
  );
  assert.deepEqual(ran, [
    'brew trust --formula openai/tools/tart openai/tools/softnet',
    'brew install openai/tools/tart',
    'brew pin softnet',
    // Softnet came with Tart, so it is not installed a second time: only its permission is set.
    'sudo chown root /opt/homebrew/bin/softnet',
    'sudo chmod u+s /opt/homebrew/bin/softnet',
  ]);
  assert.ok(checks.filter((c) => c.id === 'tart' || c.id === 'network').every((c) => c.ok));
  assert.ok(said.some((line) => line === 'Fixing Tart: Tart is not installed'));
  assert.ok(!said.some((line) => line.startsWith('Fixing Network: Softnet is not installed')));
});

test('doctor --fix says when Homebrew is not there, stops that fix, and does not go round forever', async () => {
  const check = () =>
    runChecks({
      network: 'softnet',
      settings,
      images: null,
      hasApp: true,
      run: async () => null,
      tartInstalled: () => false,
      softnet: () => null,
      firewall: () => ({ rules: `# ${FIREWALL_VERSION}.`, daemon: true }),
      freeDiskGb: 500,
    });
  const ran: string[] = [];
  const said: string[] = [];
  const checks = await applyFixes(
    check,
    (argv) => {
      ran.push(argv.join(' '));
      return null;
    },
    (line) => said.push(line),
  );
  // Trusting may fail and be carried on from; an install that cannot run ends that fix,
  // before the pin. Each of the two missing tools is tried once.
  assert.deepEqual(ran, [
    'brew trust --formula openai/tools/tart openai/tools/softnet',
    'brew install openai/tools/tart',
    'brew trust --formula openai/tools/tart openai/tools/softnet',
    'brew install openai/tools/softnet',
  ]);
  assert.ok(said.includes('  brew was not found on this Mac'));
  assert.equal(checks.find((c) => c.id === 'tart')?.ok, false);
});

test('doctor: a Tart that is installed and does not answer is never reinstalled', async () => {
  const checks = await runChecks({
    network: 'softnet',
    settings,
    images: null,
    hasApp: true,
    run: async () => null,
    tartInstalled: () => true,
    softnet: () => ({ path: '/opt/homebrew/bin/softnet', uid: 0, mode: 0o104755 }),
    firewall: () => ({ rules: `# ${FIREWALL_VERSION}.`, daemon: true }),
  });
  const tart = checks.find((c) => c.id === 'tart');
  assert.equal(tart?.ok, false);
  assert.equal(tart?.commands, undefined);
});

test('a Mac whose network is not closed starts no VM, and says which step is missing', async () => {
  const checks = (firewall: boolean, setuid: boolean) =>
    runChecks({
      network: 'softnet',
      settings,
      images: null,
      hasApp: false,
      run: async (command) => (command === 'tart' ? '2.42.0\n' : null),
      softnet: () => ({
        path: '/opt/homebrew/bin/softnet',
        uid: setuid ? 0 : 501,
        mode: setuid ? 0o104755 : 0o100755,
      }),
      firewall: () =>
        firewall
          ? { rules: `# ${FIREWALL_VERSION}.`, daemon: true }
          : { rules: null, daemon: false },
      freeDiskGb: 5,
    });
  // Softnet could run, and the firewall rule was never installed: the half-done setup.
  assert.match(
    blockedBy(await checks(false, true), 'softnet') ?? '',
    /^Firewall: .*Run: minitart doctor --fix$/,
  );
  assert.match(
    blockedBy(await checks(true, false), 'softnet') ?? '',
    /^Network: Softnet cannot run as root/,
  );
  // Everything else that doctor finds (no App, no image, a full disk) stops no VM by itself.
  assert.equal(blockedBy(await checks(true, true), 'softnet'), null);
  // The owner who asked for the unsafe network has said they know.
  assert.equal(blockedBy(await checks(false, false), 'shared'), null);
  // Not knowing is not the same as being closed.
  assert.match(blockedBy([], 'softnet') ?? '', /has not been checked yet/);
  // What `doctor --fix` cannot do is named by its own command.
  const old = await runChecks({
    network: 'softnet',
    settings,
    images: null,
    hasApp: false,
    run: async (command) => (command === 'softnet' ? 'softnet 0.24.0\n' : null),
    softnet: () => ({ path: '/opt/homebrew/bin/softnet', uid: 0, mode: 0o104755 }),
    firewall: () => ({ rules: `# ${FIREWALL_VERSION}.`, daemon: true }),
  });
  assert.match(
    blockedBy(old, 'softnet') ?? '',
    /Run: brew unpin softnet && brew upgrade openai\/tools\/softnet && brew pin softnet$/,
  );
});

test('memory to spare is what macOS can hand out without squeezing programs, read from vm_stat', () => {
  const stat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                  1022596.',
    'Pages active:                                1307417.',
    'Pages inactive:                              1292195.',
    'Pages speculative:                             13406.',
    'Pages throttled:                                   0.',
    'Pages wired down:                             196519.',
    'Pages purgeable:                               55670.',
    'File-backed pages:                            849897.',
    'Anonymous pages:                             1841180.',
  ].join('\n');
  // Free, files it can read again, and what was marked disposable. Not "inactive": much of
  // that is programs' own memory, which could only be freed by compressing or swapping it.
  assert.equal(availableMb(stat), Math.floor(((1022596 + 849897 + 55670) * 16384) / 1024 ** 2));
  assert.ok((availableMb(stat) ?? 0) < Math.floor(((1022596 + 1292195) * 16384) / 1024 ** 2));
  // Anything else is "not known", never a number made up.
  assert.equal(availableMb(''), null);
  assert.equal(availableMb(stat.replace('File-backed pages', 'Pages napping')), null);
  assert.equal(availableMb(stat.replace('16384 bytes', 'many bytes')), null);
});
