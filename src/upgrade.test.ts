import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Manager } from './manager.ts';
import { createDashboardServer } from './server.ts';
import { defaultSettings } from './settings.ts';
import { FakeGitHub, FakeTart, SERVED } from './testing/fakes.ts';
import { plist } from './service.ts';
import { BREW_SERVICE_LABELS, installKind, Running, serviceArgs, upgradeSteps } from './upgrade.ts';
import { DEVELOPMENT, readVersion } from './version.ts';
import { MemoryHistory } from './history.ts';

const machine = { cpus: 15, memoryBytes: 64 * 1024 ** 3 };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function world() {
  let now = Date.parse('2026-11-18T10:00:00Z');
  const github = new FakeGitHub(() => now);
  github.repoList = [{ fullName: 'octo/app', private: true }];
  const tart = new FakeTart();
  tart.addImage('minitart-base-linux');
  tart.addImage('minitart-base-macos');
  const manager = new Manager({
    github: () => github,
    tart,
    network: 'softnet',
    settings: { ...defaultSettings(machine), repos: SERVED },
    saveSettings: () => {},
    history: new MemoryHistory(),
    now: () => now,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  return { github, tart, manager, advance: (ms: number) => (now += ms) };
}

test('the version is the one a release wrote, and a checkout is a development copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minitart-version-'));
  const file = (text: string) => {
    writeFileSync(join(dir, 'VERSION'), text);
    return pathToFileURL(join(dir, 'VERSION'));
  };
  assert.equal(readVersion(file('1.4.2\n')), '1.4.2');
  assert.equal(readVersion(file('not a version')), DEVELOPMENT);
  assert.equal(readVersion(pathToFileURL(join(dir, 'missing'))), DEVELOPMENT);
  // The source tree carries no VERSION file: 0.0.0 is never a release.
  assert.equal(readVersion(), DEVELOPMENT);
});

test('draining starts no VM, lets a running job finish, and lets go of the idle ones', async () => {
  const { github, tart, manager } = world();
  const running = github.queue('octo/app', ['minitart-linux'], 'long');
  github.queue('octo/app', ['minitart-linux'], 'not yet taken');
  await manager.tick();
  await settle();
  const [busy, idle] = tart.runners();
  assert.ok(busy && idle);
  assert.equal(github.take(busy)?.id, running.id);
  tart.print(busy, '2026-11-18 10:00:05Z: Running job: long');

  manager.setDraining(true);
  github.queue('octo/app', ['minitart-macos'], 'arrives while draining');
  await manager.tick();
  await settle();
  assert.deepEqual(tart.runners(), [busy], 'the idle VM is gone, the busy one is not');
  assert.equal(manager.vmCount, 1);
  assert.equal(manager.snapshot().draining, true);
  assert.ok(manager.snapshot().queued.every((job) => /draining/.test(job.note ?? '')));

  tart.print(busy, '2026-11-18 10:00:09Z: Job long completed with result: Succeeded');
  github.complete(running);
  tart.exit(busy, 0);
  await settle();
  await manager.tick();
  await settle();
  assert.equal(manager.vmCount, 0, 'nothing is left, and nothing new started');
  assert.equal(manager.snapshot().done[0]?.conclusion, 'success');

  manager.setDraining(false);
  await manager.tick();
  await settle();
  assert.equal(manager.vmCount, 2, 'resumed: the queue is served again');
  await manager.stop();
});

test('where main.ts lives says how minitart was installed', () => {
  assert.deepEqual(installKind('/opt/homebrew/Cellar/minitart/1.4.2/libexec/src/main.ts'), {
    kind: 'brew',
    prefix: '/opt/homebrew',
  });
  assert.deepEqual(installKind('/Users/me/minitart/src/main.ts'), {
    kind: 'git',
    root: '/Users/me/minitart',
  });
  // A checkout that happens to sit in a folder called Cellar is still a checkout.
  assert.equal(installKind('/Users/me/Cellar/minitart/src/main.ts').kind, 'git');
});

test('an upgrade changes the software, puts right what needs the password, and restarts', () => {
  const options = { node: '/opt/homebrew/bin/node', service: 'brew' as const, serviceArgs: [] };
  const brew = upgradeSteps({ kind: 'brew', prefix: '/opt/homebrew' }, options);
  // The menu bar app, only where it is installed, before doctor and the restart.
  const withApp = upgradeSteps(
    { kind: 'brew', prefix: '/opt/homebrew' },
    { ...options, app: true },
  );
  const appStep = withApp.findIndex((step) => step.command.includes('zurfyx/tap/minitart-app'));
  assert.ok(appStep > 0 && withApp[appStep]?.optional, 'upgraded, and never stops the upgrade');
  assert.ok(appStep < withApp.findIndex((step) => step.command.includes('doctor')));
  assert.ok(
    !brew.some((step) => step.command.includes('zurfyx/tap/minitart-app')),
    'not where it is not installed',
  );
  assert.deepEqual(
    brew.map((step) => `${step.optional ? '(may fail) ' : ''}${step.command.join(' ')}`),
    [
      '/opt/homebrew/bin/brew update --quiet',
      '/opt/homebrew/bin/brew upgrade zurfyx/tap/minitart',
      // Each on its own: one that is not installed, or not pinned, fails alone.
      '(may fail) /opt/homebrew/bin/brew upgrade openai/tools/tart',
      '(may fail) /opt/homebrew/bin/brew unpin softnet',
      '(may fail) /opt/homebrew/bin/brew upgrade openai/tools/softnet',
      '(may fail) /opt/homebrew/bin/brew pin softnet',
      // The new minitart's doctor, and before the restart: Softnet's permission comes first.
      // What doctor still finds wrong (a full disk, say) never leaves minitart stopped.
      '(may fail) /opt/homebrew/bin/minitart doctor --fix',
      '/opt/homebrew/bin/brew services restart zurfyx/tap/minitart',
    ],
  );

  const own = upgradeSteps(
    { kind: 'brew', prefix: '/opt/homebrew' },
    { ...options, service: 'own', serviceArgs: ['--port', '4242'] },
  );
  assert.deepEqual(own.at(-1)?.command, [
    '/opt/homebrew/bin/minitart',
    'service',
    'install',
    '--port',
    '4242',
  ]);

  // Started by hand in a terminal: nothing is installed or started behind the owner's back.
  const none = upgradeSteps(
    { kind: 'brew', prefix: '/opt/homebrew' },
    { ...options, service: 'none' },
  );
  assert.ok(
    !none.some((step) => step.command.includes('services') || step.command.includes('service')),
  );

  const git = upgradeSteps(
    { kind: 'git', root: '/Users/me/minitart' },
    { ...options, service: 'own', serviceArgs: ['--port', '4141'] },
  );
  assert.deepEqual(
    git.map((step) => step.command.join(' ')),
    [
      'git -C /Users/me/minitart pull --ff-only',
      '/opt/homebrew/bin/node /Users/me/minitart/src/main.ts doctor --fix',
      '/opt/homebrew/bin/node /Users/me/minitart/src/main.ts service install --port 4141',
    ],
  );
});

test("Homebrew's service is looked for under both names Homebrew has given it", () => {
  // Found by installing 0.1.0 for real: the Homebrew on the Mac it was built for says sh.brew.
  assert.deepEqual(BREW_SERVICE_LABELS, ['sh.brew.minitart', 'homebrew.mxcl.minitart']);
});

test('an upgrade restarts the service with the flags it already runs with', () => {
  const xml = plist({
    node: '/opt/homebrew/bin/node',
    main: '/Users/me/minitart/src/main.ts',
    args: ['--port', '4242', '--unsafe-shared-network'],
    log: '/Users/me/.minitart/logs/manager.log',
    path: '/opt/homebrew/bin:/usr/bin',
  });
  assert.deepEqual(serviceArgs(xml), ['--port', '4242', '--unsafe-shared-network']);
  assert.deepEqual(serviceArgs(xml.replace('<string>start</string>', '')), []);
});

test('an upgrade waits for the running job, through the running minitart', async () => {
  const { github, tart, manager } = world();
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address() as { port: number };
      probe.close(() => resolve(free));
    });
  });
  const server = createDashboardServer({
    manager,
    github: () => github,
    app: () => null,
    saveApp: () => {},
    health: () => [],
    machine,
    port,
    dashboardDir: fileURLToPath(new URL('../dashboard/', import.meta.url)),
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  after(() => server.close());

  const job = github.queue('octo/app', ['minitart-linux'], 'long');
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  github.take(name);
  tart.print(name, '2026-11-18 10:00:05Z: Running job: long');

  const said: string[] = [];
  let polls = 0;
  const running = new Running(port);
  const drained = await running.drained(
    (line) => said.push(line),
    async () => {
      // The job ends while the upgrade waits.
      if (++polls === 2) {
        tart.print(name, '2026-11-18 10:00:09Z: Job long completed with result: Succeeded');
        github.complete(job);
        tart.exit(name, 0);
        await settle();
      }
    },
  );
  assert.equal(drained, true);
  assert.deepEqual(said, ['Waiting for 1 VM to finish its job']);
  assert.equal(manager.snapshot().draining, true, 'still draining: the restart is what ends it');
  assert.equal(manager.snapshot().done[0]?.conclusion, 'success', 'the job was not cut short');

  // The drain endpoint is as guarded as the settings one.
  const post = (body: string, origin: string) =>
    fetch(`http://127.0.0.1:${port}/api/drain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body,
    });
  assert.equal((await post('{"draining":false}', 'http://evil.example')).status, 403);
  assert.equal((await post('{"draining":"no"}', `http://127.0.0.1:${port}`)).status, 400);
  assert.equal(manager.snapshot().draining, true);
  assert.equal(await running.drain(false), true);
  assert.equal(manager.snapshot().draining, false);

  // Nothing listening: there is nothing to wait for, and the upgrade carries on.
  assert.equal(await new Running(1).drained(() => {}), false);

  // One missed answer while a job runs is not "nothing is running".
  manager.setDraining(false);
  const again = github.queue('octo/app', ['minitart-linux'], 'second');
  await manager.tick();
  await settle();
  const [second] = tart.runners();
  assert.ok(second);
  github.take(second);
  tart.print(second, '2026-11-18 10:00:15Z: Running job: second');
  const flaky = new Running(port);
  const real = flaky.vms.bind(flaky);
  let asked = 0;
  flaky.vms = async () => {
    asked++;
    if (asked === 1) return null;
    if (asked === 3) {
      tart.print(second, '2026-11-18 10:00:19Z: Job second completed with result: Succeeded');
      github.complete(again);
      tart.exit(second, 0);
      await settle();
    }
    return real();
  };
  assert.equal(
    await flaky.drained(
      () => {},
      async () => {},
    ),
    true,
  );
  assert.equal(manager.snapshot().done[0]?.job.name, 'second');
  await manager.stop();
});
