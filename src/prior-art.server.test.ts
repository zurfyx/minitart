// Scenarios ported from the test suites of similar projects: the dashboard's HTTP server
// when it is sent what it does not expect, and the job logs it passes on.

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Manager } from './manager.ts';
import { createDashboardServer } from './server.ts';
import { defaultSettings } from './settings.ts';
import { FakeGitHub, FakeTart } from './testing/fakes.ts';
import { GitHubError } from './github/types.ts';

const machine = { cpus: 15, memoryBytes: 64 * 1024 ** 3 };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function setup() {
  const github = new FakeGitHub();
  github.repoList = [{ fullName: 'octo/app', private: true }];
  const tart = new FakeTart();
  tart.addImage('minitart-base-linux');
  const manager = new Manager({
    github: () => github,
    tart,
    network: 'softnet',
    settings: defaultSettings(machine),
    saveSettings: () => {},
    history: [],
    saveHistory: () => {},
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  const port = await freePort();
  const server = createDashboardServer({
    manager,
    github: () => github,
    app: () => null,
    saveApp: () => {},
    health: () => [],
    machine,
    host: '127.0.0.1',
    port,
    dashboardDir: fileURLToPath(new URL('../dashboard/', import.meta.url)),
    isLocal: () => true,
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  after(() => server.close());
  const origin = `http://127.0.0.1:${port}`;
  const post = (body: string) =>
    fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body,
    });
  return { origin, manager, github, tart, post };
}

/** A job minitart ran to its end, so its log may be read. */
async function ranJob(github: FakeGitHub, tart: FakeTart, manager: Manager) {
  const job = github.queue('octo/app', ['minitart-linux'], 'test');
  await manager.tick();
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  const [name] = tart.runners();
  assert.ok(name);
  github.take(name);
  tart.print(name, 'Running job: test');
  github.complete(job);
  tart.exit(name, 0);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  return job;
}

// After runscaler internal/actionscache/http_test.go: TestHandlerEnforcesBudgetAfterFinalization
test('a settings body larger than the limit is refused, even when it is valid JSON', async () => {
  const { post, manager } = await setup();
  const before = manager.settings;
  // Valid JSON that would change a setting, padded past 64 KB with whitespace.
  const huge = `{"linux":{"max":4}${' '.repeat(100 * 1024)}}`;
  const response = await post(huge);
  assert.equal(response.status, 400);
  assert.equal(manager.settings, before);
});

// After Cilicon CiliconTests/SSHLoggerTests.swift: test_log_respectsMaxLogChunksAndDropsOldestEntries
test('a job log larger than a megabyte is served by its end', async () => {
  const { origin, manager, github, tart } = await setup();
  const job = await ranJob(github, tart, manager);
  const head = 'x'.repeat(512 * 1024);
  const tail = `${'t'.repeat(1024 * 1024 - 8)}the end\n`;
  github.logs.set(job.id, head + tail);
  const served = await (await fetch(`${origin}/api/jobs/${job.id}/log`)).text();
  assert.equal(served.length, 1024 * 1024);
  assert.ok(served.endsWith('the end\n'));
  assert.ok(!served.includes('x'), 'the start is what is dropped');
});

// After ephemerd pkg/github/jobawaiting_test.go: TestJobAwaitingRunner_NotFoundIsGone
test('a job log GitHub no longer has is a gateway error that says why', async () => {
  const { origin, manager, github, tart } = await setup();
  const job = await ranJob(github, tart, manager);
  github.failure = new GitHubError(410, 'Reading the job log failed (410): Gone');
  const response = await fetch(`${origin}/api/jobs/${job.id}/log`);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /410/);
});
