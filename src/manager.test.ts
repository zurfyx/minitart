import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isJobVm, Manager, RUN_SCRIPT, type DoneView } from './manager.ts';
import { defaultSettings, type Settings } from './settings.ts';
import { FakeGitHub, FakeTart, SERVED } from './testing/fakes.ts';
import { GitHubError } from './github/types.ts';
import type { Network } from './tart.ts';

const machine = { cpus: 15, memoryBytes: 64 * 1024 ** 3 };

function setup(options: { settings?: Partial<Settings>; network?: Network } = {}) {
  let now = Date.parse('2026-11-18T10:00:00Z');
  const github = new FakeGitHub(() => now);
  github.repoList = [{ fullName: 'octo/app', private: true }];
  const tart = new FakeTart();
  tart.addImage('minitart-base-linux');
  tart.addImage('minitart-base-macos');
  const saved: { history: DoneView[]; settings: Settings | null } = { history: [], settings: null };
  const manager = new Manager({
    github: () => github,
    tart,
    network: options.network ?? 'softnet',
    settings: { ...defaultSettings(machine), repos: SERVED, ...options.settings },
    saveSettings: (settings) => (saved.settings = settings),
    history: [],
    saveHistory: (history) => (saved.history = history),
    now: () => now,
    // A real turn of the event loop, so a VM waiting to boot does not starve the test.
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  return {
    github,
    tart,
    manager,
    saved,
    advance: (ms: number) => (now += ms),
    /** Lets the VM lifecycles run as far as they can. */
    settle: async () => {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const jobVms = (tart: FakeTart) => [...tart.vms.keys()].filter(isJobVm);

test('a queued job gets a VM, and the VM is deleted when the job ends', async () => {
  const { github, tart, manager, saved, settle } = setup();
  const job = github.queue('octo/app', ['minitart-linux'], 'test');

  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name && isJobVm(name), 'a job VM runs the runner');
  assert.deepEqual(tart.networks, ['softnet']);
  assert.equal(manager.snapshot().vms[0]?.status, 'waiting');
  // The runner is registered under the VM's name, and its config reaches the guest on stdin.
  const [runner] = [...github.runners.values()];
  assert.deepEqual(runner, {
    repo: 'octo/app',
    name,
    labels: ['self-hosted', 'linux', 'arm64', 'minitart-linux'],
  });
  assert.match(tart.stdin(name) ?? '', /^jit-\d+\n$/);
  assert.ok(!RUN_SCRIPT.includes('--jitconfig'), 'the config is never an argument');

  assert.equal(github.take(name)?.id, job.id);
  tart.print(name, '2026-11-18 10:00:05Z: Running job: test');
  assert.equal(manager.snapshot().vms[0]?.status, 'running');
  await manager.tick();
  assert.equal(manager.snapshot().vms[0]?.job?.id, job.id);
  assert.equal(manager.snapshot().queued.length, 0);

  tart.print(name, '2026-11-18 10:00:09Z: Job test completed with result: Succeeded');
  github.complete(job);
  tart.exit(name, 0);
  await settle();

  assert.deepEqual(jobVms(tart), [], 'the VM is deleted');
  assert.equal(manager.snapshot().vms.length, 0);
  const [done] = manager.snapshot().done;
  assert.equal(done?.conclusion, 'success');
  assert.equal(done?.job.id, job.id);
  assert.equal(done?.job.url, job.url);
  assert.equal(saved.history.length, 1);
  assert.deepEqual(github.removed, [], 'a runner that ran is not removed twice');
  assert.equal(manager.repoOfJob(job.id), 'octo/app');
  assert.ok(manager.vmLog(name)?.some((line) => line.includes('Running job: test')));
});

test('a job that ends between two polls is still found', async () => {
  const { github, tart, manager, settle } = setup();
  const job = github.queue('octo/app', ['minitart-macos'], 'archive');
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  github.take(name);
  tart.print(name, 'Running job: archive');
  tart.print(name, 'Job archive completed with result: Failed');
  github.complete(job, 'failure');
  tart.exit(name, 0);
  await settle();
  const [done] = manager.snapshot().done;
  assert.equal(done?.conclusion, 'failure');
  assert.equal(done?.job.id, job.id);
  assert.equal(done?.pool, 'macos');
});

test('jobs that do not ask for minitart are left alone', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['ubuntu-latest']);
  github.queue('octo/app', ['self-hosted', 'macOS']);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.deepEqual(manager.snapshot().queued, []);
});

test('a public repo is not served unless the owner allows it', async () => {
  const { github, tart, manager, settle } = setup();
  github.repoList = [{ fullName: 'octo/public', private: false }];
  github.queue('octo/public', ['minitart-linux']);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.equal(manager.snapshot().repos[0]?.state, 'public');

  manager.updateSettings({ ...manager.settings, allowPublicRepos: true });
  await manager.tick();
  await settle();
  assert.equal(jobVms(tart).length, 1);
});

test('a repo the App is installed on is not served until the owner turns it on', async () => {
  // What "install on all repositories" does: the App can see a repo nobody chose.
  const { github, tart, manager, settle } = setup({ settings: { repos: [] } });
  github.queue('octo/app', ['minitart-linux']);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.equal(manager.snapshot().repos[0]?.state, 'off');
  assert.deepEqual(manager.snapshot().queued, [], 'its queue is not even read');

  manager.updateSettings({ ...manager.settings, repos: ['octo/app'] });
  await manager.tick();
  await settle();
  assert.equal(jobVms(tart).length, 1);
  assert.equal(manager.snapshot().repos[0]?.state, 'watching');
});

test('a fresh install serves nothing', () => {
  assert.deepEqual(defaultSettings(machine).repos, []);
});

test('no more VMs than the limit; the rest of the queue waits', async () => {
  const { github, tart, manager, settle } = setup();
  for (let i = 0; i < 4; i++) github.queue('octo/app', ['minitart-macos'], `job ${i}`);
  await manager.tick();
  await settle();
  await manager.tick();
  await settle();
  assert.equal(jobVms(tart).length, 2);
  assert.equal(manager.snapshot().queued.length, 4);
});

test('a VM no job comes for is deleted and its runner removed', async () => {
  const { github, tart, manager, settle, advance } = setup();
  const job = github.queue('octo/app', ['minitart-linux']);
  await manager.tick();
  await settle();
  // Someone cancels the run before the runner takes it.
  github.complete(job, 'cancelled');
  await manager.tick();
  assert.equal(jobVms(tart).length, 1, 'kept while it might still be wanted');

  advance(181_000);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.equal(github.removed.length, 1);
  assert.equal(github.runners.size, 0);
  assert.deepEqual(manager.snapshot().done, [], 'nothing ran, so nothing is recorded');
});

test('a failed poll keeps the queue it had, and waiting VMs with it', async () => {
  const { github, tart, manager, settle, advance } = setup();
  github.queue('octo/app', ['minitart-linux']);
  await manager.tick();
  await settle();
  github.failure = new GitHubError(502, 'GET failed (502)');
  advance(600_000);
  await manager.tick();
  await settle();
  assert.equal(jobVms(tart).length, 1);
  assert.equal(manager.snapshot().queued.length, 1);
  assert.match(manager.snapshot().githubError ?? '', /502/);
});

test('a rate limit stops the polling until it resets', async () => {
  const { github, tart, manager, settle, advance } = setup();
  const resetAt = Date.parse('2026-11-18T10:10:00Z');
  github.failure = new GitHubError(403, 'rate limited', resetAt);
  await manager.tick();
  github.failure = null;
  github.queue('octo/app', ['minitart-linux']);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), [], 'still backing off');
  advance(11 * 60_000);
  await manager.tick();
  await settle();
  assert.equal(jobVms(tart).length, 1);
});

test('a VM that never boots is deleted, and the job gets another', async () => {
  const { github, tart, manager, settle, advance } = setup();
  github.queue('octo/app', ['minitart-linux']);
  tart.agentDown = true;
  await manager.tick();
  await settle();
  const [first] = jobVms(tart);
  assert.ok(first);
  advance(121_000);
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.equal(github.runners.size, 0, 'no runner was registered for it');

  // A kind whose VMs do not start is not retried at once, and the dashboard says so.
  tart.agentDown = false;
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.match(manager.snapshot().queued[0]?.note ?? '', /failed to start; trying again in 5s/);

  advance(6000);
  await manager.tick();
  await settle();
  assert.equal(jobVms(tart).length, 1);
  assert.notEqual(jobVms(tart)[0], first);
});

test('what a job makes the runner print cannot fake its result or fill the Mac', async () => {
  const { github, tart, manager, settle } = setup();
  const job = github.queue('octo/app', ['minitart-linux'], 'x completed with result: Succeeded');
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  github.take(name);
  tart.print(name, '2026-11-18 10:00:05Z: Running job: x completed with result: Succeeded');
  tart.print(name, 'echo: Job x completed with result: Succeeded');
  tart.print(name, '2026-11-18 10:00:06Z: Job x completed with result: constructor');
  for (let i = 0; i < 1200; i++) tart.print(name, 'y'.repeat(4096));
  const kept = manager.vmLog(name) ?? [];
  assert.ok(kept.join('').length < 5 * 1024 * 1024);
  assert.match(kept.at(-1) ?? '', /printed too much/);
  // GitHub's conclusion is the one recorded.
  github.complete(job, 'failure');
  tart.exit(name, 0);
  await settle();
  assert.equal(manager.snapshot().done[0]?.conclusion, 'failure');
});

test('a VM that could not be deleted is looked for again', async () => {
  const { github, tart, manager, settle, advance } = setup();
  const job = github.queue('octo/app', ['minitart-linux']);
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  const remove = tart.remove.bind(tart);
  tart.remove = async () => {
    throw new Error('tart delete: the VM is busy');
  };
  github.complete(job, 'cancelled');
  tart.exit(name, 1);
  await settle();
  assert.deepEqual(jobVms(tart), [name], 'still on disk');
  // The delete keeps failing: the sweep is tried again, a minute apart.
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), [name]);
  tart.remove = remove;
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), [name], 'not on every round');
  advance(61_000);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
});

test('an idle VM is stopped only once GitHub has let go of its runner', async () => {
  const { github, tart, manager, settle, advance } = setup();
  const job = github.queue('octo/app', ['minitart-linux']);
  await manager.tick();
  await settle();
  github.complete(job, 'cancelled');
  advance(181_000);
  // GitHub refuses: the runner was handed a job a moment ago.
  const removeRunner = github.removeRunner.bind(github);
  github.removeRunner = async () => {
    throw new Error('Runner is currently running a job');
  };
  await manager.tick();
  await settle();
  assert.equal(jobVms(tart).length, 1, 'left to run its job');
  github.removeRunner = removeRunner;
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
});

test('a kind with no image starts nothing and says why', async () => {
  const { github, tart, manager, settle } = setup();
  tart.vms.delete('minitart-base-macos');
  github.queue('octo/app', ['minitart-macos']);
  github.queue('octo/app', ['minitart-linux', 'gpu']);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  const notes = manager.snapshot().queued.map((job) => job.note);
  assert.match(notes[0] ?? '', /minitart image build macos/);
  assert.match(notes[1] ?? '', /No minitart runner has all of/);
});

test('start removes job VMs left by an earlier run, and only those', async () => {
  const { tart, manager } = setup();
  tart.addImage('minitart-linux-0a1b2c');
  tart.addImage('my-own-vm');
  tart.vms.get('minitart-linux-0a1b2c')!.running = true;
  await manager.removeOrphans();
  assert.deepEqual([...tart.vms.keys()].sort(), [
    'minitart-base-linux',
    'minitart-base-macos',
    'my-own-vm',
  ]);
});

test('stop deletes every VM', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-linux']);
  github.queue('octo/app', ['minitart-macos']);
  await manager.tick();
  await settle();
  assert.equal(jobVms(tart).length, 2);
  await manager.stop();
  assert.deepEqual(jobVms(tart), []);
  assert.equal(github.runners.size, 0);
});

test('the network the manager was started with is the one every VM gets', async () => {
  const { github, tart, manager, settle } = setup({ network: 'shared' });
  github.queue('octo/app', ['minitart-linux']);
  await manager.tick();
  await settle();
  assert.deepEqual(tart.networks, ['shared']);
  assert.equal(manager.snapshot().network, 'shared');
});

test('a VM whose runner never reaches GitHub is stopped, and the kind backs off', async () => {
  const { github, tart, manager, settle, advance } = setup();
  github.queue('octo/app', ['minitart-linux']);
  tart.runnerConnects = false;
  await manager.tick();
  await settle();
  assert.equal(jobVms(tart).length, 1);
  // The job is still queued, so the idle rule alone would keep this VM for hours.
  advance(181_000);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.ok(manager.snapshot().log.some((line) => /never reached GitHub/.test(line.text)));
  assert.match(manager.snapshot().queued[0]?.note ?? '', /failed to start; trying again in 5s/);

  // Each VM registers before it fails to connect; the wait still grows.
  advance(6000);
  await manager.tick();
  await settle();
  advance(181_000);
  await manager.tick();
  await settle();
  assert.match(manager.snapshot().queued[0]?.note ?? '', /trying again in 10s/);
});

test('a VM whose run has finished on GitHub, and whose runner hangs, is stopped', async () => {
  const { github, tart, manager, settle, advance } = setup();
  const job = github.queue('octo/app', ['minitart-linux'], 'test');
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  github.take(name);
  tart.print(name, '2026-11-18 10:00:05Z: Running job: test');
  await manager.tick();
  // The run completes, so it leaves the list of unfinished runs; the runner never exits.
  github.complete(job, 'success');
  await manager.tick();
  advance(4 * 60_000);
  await manager.tick();
  await settle();
  assert.equal(jobVms(tart).length, 1, 'given a few minutes to exit by itself');
  advance(2 * 60_000);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.equal(manager.snapshot().done[0]?.conclusion, 'success');
});

test('a VM that stops instead of booting says what tart said', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-macos']);
  tart.bootFailure = 'Error: The number of VMs exceeds the system limit';
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.ok(
    manager
      .snapshot()
      .log.some((line) =>
        /stopped while booting: Error: The number of VMs exceeds/.test(line.text),
      ),
  );
});

test('a VM still up long after GitHub called its job done is stopped', async () => {
  const { github, tart, manager, settle, advance } = setup();
  const job = github.queue('octo/app', ['minitart-linux'], 'test');
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  github.take(name);
  tart.print(name, '2026-11-18 10:00:05Z: Running job: test');
  const other = github.queue('octo/app', ['ubuntu-latest'], 'keeps the run open');
  // The job ends on GitHub; the runner hangs instead of exiting.
  job.status = 'completed';
  job.conclusion = 'success';
  job.completedAt = new Date(Date.parse(job.createdAt) + 60_000).toISOString();
  job.runId = other.runId;
  github.adopt(job);
  advance(7 * 60_000);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.equal(manager.snapshot().done[0]?.conclusion, 'success');
});

test('polling never lists VMs', async () => {
  const { github, tart, manager, settle, advance } = setup();
  github.queue('octo/app', ['minitart-linux']);
  for (let i = 0; i < 30; i++) {
    await manager.tick();
    await settle();
    advance(61_000);
  }
  assert.equal(tart.lists, 0);
});
