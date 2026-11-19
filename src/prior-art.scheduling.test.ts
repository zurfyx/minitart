// Scenarios ported from the test suites of similar projects: which jobs are minitart's, which
// VMs it starts for them, and what it does when a job or a repo changes under it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isJobVm, Manager } from './manager.ts';
import { route } from './schedule.ts';
import { defaultSettings, type Settings } from './settings.ts';
import { FakeGitHub, FakeTart, SERVED } from './testing/fakes.ts';
import { GitHubError } from './github/types.ts';
import { MemoryHistory } from './history.ts';

const machine = { cpus: 15, memoryBytes: 64 * 1024 ** 3 };

function setup(options: { settings?: Partial<Settings> } = {}) {
  let now = Date.parse('2026-11-18T10:00:00Z');
  const github = new FakeGitHub(() => now);
  github.repoList = [
    { fullName: 'octo/api', private: true },
    { fullName: 'octo/app', private: true },
  ];
  const tart = new FakeTart();
  tart.addImage('minitart-base-linux');
  tart.addImage('minitart-base-macos');
  const manager = new Manager({
    github: () => github,
    tart,
    network: 'softnet',
    settings: { ...defaultSettings(machine), repos: SERVED, ...options.settings },
    saveSettings: () => {},
    history: new MemoryHistory(),
    now: () => now,
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  return {
    github,
    tart,
    manager,
    advance: (ms: number) => (now += ms),
    settle: async () => {
      for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const jobVms = (tart: FakeTart) => [...tart.vms.keys()].filter(isJobVm);
const oneLinux = { linux: { max: 1, image: 'minitart-base-linux' } };

// After ephemerd pkg/github/api_test.go: TestIsSelfHosted_EdgeCases
test('route: a label that only starts like a minitart label, or no label at all, is not minitart', () => {
  assert.equal(route([]), null);
  assert.equal(route(['minitart-linux-large']), null);
  assert.equal(route(['minitart']), null);
  assert.equal(route(['xminitart-macos']), null);
});

// After ephemerd pkg/scheduler/dedup_test.go: TestHandleQueued_SkipsAlreadyRunning
test('a job the runner has taken, which GitHub still lists as queued, gets no second VM', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-linux'], 'test');
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  // The runner says it took the job; GitHub's answer has not caught up.
  tart.print(name, '2026-11-18 10:00:05Z: Running job: test');
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), [name]);
});

// After ephemerd pkg/scheduler/reassignment_test.go: TestHandleCompleted_ForeignRunner
test('a job another runner took is not counted as minitart’s, even under one of its VM names', async () => {
  const { github, tart, manager, settle, advance } = setup();
  const job = github.queue('octo/app', ['minitart-linux'], 'ours');
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  // A runner that is not minitart's takes the job.
  job.status = 'in_progress';
  job.runnerName = 'someone-else';
  // A job in another repo claims the VM's name.
  const other = github.queue('octo/api', ['ubuntu-latest'], 'theirs');
  other.status = 'in_progress';
  other.runnerName = name;
  await manager.tick();
  await settle();
  const [vm] = manager.snapshot().vms;
  assert.equal(vm?.status, 'waiting');
  assert.equal(vm?.job, null);
  assert.equal(manager.repoOfJob(other.id), null);

  advance(181_000);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), [], 'retired as idle');
  assert.deepEqual(manager.snapshot().done, []);
});

// After cirrus-cli internal/worker/worker_test.go: TestTaskCancellation
test('a run cancelled while its VM boots leaves a VM that registers, then goes when idle', async () => {
  const { github, tart, manager, settle, advance } = setup();
  const job = github.queue('octo/app', ['minitart-linux']);
  tart.agentDown = true;
  await manager.tick();
  await settle();
  github.complete(job, 'cancelled');
  tart.agentDown = false;
  await settle();
  await manager.tick();
  await settle();
  // minitart does not stop a VM in the middle of starting: it is retired by the idle rule.
  assert.equal(manager.snapshot().vms[0]?.status, 'waiting');
  advance(181_000);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.equal(github.runners.size, 0);
});

// After runscaler internal/controller/controller_test.go: TestHandleDesiredRunnerCount_ScalesDownSurplusIdle
test('an idle VM of one repo holds the last slot only until it is retired; then the other repo’s job starts', async () => {
  const { github, tart, manager, settle, advance } = setup({ settings: oneLinux });
  const first = github.queue('octo/app', ['minitart-linux']);
  await manager.tick();
  await settle();
  github.complete(first, 'cancelled');
  github.queue('octo/api', ['minitart-linux']);
  await manager.tick();
  await settle();
  assert.equal(manager.snapshot().vms[0]?.repo, 'octo/app', 'a runner serves one repo only');

  advance(181_000);
  await manager.tick();
  await settle();
  await manager.tick();
  await settle();
  const vms = manager.snapshot().vms;
  assert.deepEqual(
    vms.map((vm) => vm.repo),
    ['octo/api'],
  );
  assert.equal(jobVms(tart).length, 1);
});

// After ephemerd pkg/scheduler/scheduler_test.go: TestBackoffDuration_MultipleReposIsolated
test('a kind that fails to start does not hold back the other kind', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-linux'], 'linux job');
  github.queue('octo/app', ['minitart-macos'], 'macos job');
  tart.failNext('clone', new Error('tart clone: busy'));
  await manager.tick();
  await settle();
  const vms = manager.snapshot().vms;
  assert.deepEqual(
    vms.map((vm) => vm.pool),
    ['macos'],
  );
  const notes = Object.fromEntries(manager.snapshot().queued.map((job) => [job.pool, job.note]));
  assert.match(notes['linux'] ?? '', /trying again/);
  assert.equal(notes['macos'], null);
});

// After ephemerd pkg/github/api_test.go: TestPollJobs_PartialFailure_OneRepoSucceedsOtherFails
test('one repo that cannot be read does not stop another from being served, nor kill its own running VM', async () => {
  const { github, tart, manager, settle, advance } = setup();
  github.queue('octo/app', ['minitart-linux'], 'running');
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  github.take(name);
  tart.print(name, 'Running job: running');
  await manager.tick();

  const activeRuns = github.activeRuns.bind(github);
  github.activeRuns = async (repo) => {
    if (repo === 'octo/app') throw new GitHubError(404, 'GET runs failed (404): Not Found');
    return activeRuns(repo);
  };
  github.queue('octo/api', ['minitart-linux'], 'other');
  for (let i = 0; i < 4; i++) {
    advance(2 * 60_000);
    await manager.tick();
    await settle();
  }
  const snapshot = manager.snapshot();
  assert.deepEqual(snapshot.vms.map((vm) => vm.repo).sort(), ['octo/api', 'octo/app']);
  assert.match(snapshot.repos.find((r) => r.fullName === 'octo/app')?.error ?? '', /404/);
  assert.equal(snapshot.repos.find((r) => r.fullName === 'octo/api')?.error, null);
  assert.ok(tart.runners().includes(name), 'the running job is left alone');
});

// After ephemerd pkg/github/client_test.go: TestIsTrackedRepo
test('a repo removed from the App: its waiting VM is stopped and its runner removed', async () => {
  const { github, tart, manager, settle, advance } = setup();
  github.queue('octo/app', ['minitart-linux']);
  await manager.tick();
  await settle();
  assert.equal(jobVms(tart).length, 1);
  github.repoList = [{ fullName: 'octo/api', private: true }];
  advance(61_000);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.equal(github.runners.size, 0);
  assert.ok(
    manager.snapshot().log.some((line) => /octo\/app is no longer watched/.test(line.text)),
  );
});

// After runscaler internal/controller/deregister_test.go: TestDrainKeepsRunnerGitHubAssignedBeforeJobStarted
test('pausing a repo lets a job that is already running finish', async () => {
  const { github, tart, manager, settle, advance } = setup();
  github.queue('octo/app', ['minitart-linux'], 'long');
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  github.take(name);
  tart.print(name, 'Running job: long');
  await manager.tick();

  manager.updateSettings({ ...manager.settings, repos: [] });
  for (let i = 0; i < 10; i++) {
    advance(60_000);
    await manager.tick();
    await settle();
  }
  assert.deepEqual(tart.runners(), [name], 'still running its job after ten minutes');
});
