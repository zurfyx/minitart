// Scenarios ported from the test suites of similar projects: a VM or its runner failing at
// each stage of its life, shutting down mid-stage, and cleaning up after itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isJobVm, Manager } from './manager.ts';
import { defaultSettings, type Settings } from './settings.ts';
import { FakeGitHub, FakeTart } from './testing/fakes.ts';
import { GitHubError } from './github/types.ts';

const machine = { cpus: 15, memoryBytes: 64 * 1024 ** 3 };

function setup(options: { settings?: Partial<Settings> } = {}) {
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
    settings: { ...defaultSettings(machine), ...options.settings },
    saveSettings: () => {},
    history: [],
    saveHistory: () => {},
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
const logged = (manager: Manager, pattern: RegExp) =>
  manager.snapshot().log.some((line) => pattern.test(line.text));

/** A promise and the function that settles it, for a call the test holds open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

// After runscaler internal/provider/tart_test.go: TestTartProvider_StartInstance_CloneFails
test('a clone that fails leaves nothing behind and makes the kind wait', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-linux']);
  tart.failNext('clone', new Error('tart clone: no space left on device'));
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.deepEqual(tart.networks, [], 'nothing was booted');
  assert.equal(github.runners.size, 0, 'no runner was registered');
  assert.ok(logged(manager, /no space left on device/));
  assert.match(manager.snapshot().queued[0]?.note ?? '', /failed to start; trying again in 5s/);
});

// After runscaler internal/provider/tart_guest_test.go: TestDetectTartGuest_DeletesPartialCloneAfterFailure
test('a VM whose CPU and memory cannot be set is deleted before it boots', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-linux']);
  tart.failNext('configure', new Error('tart set: invalid memory size'));
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), [], 'the clone is deleted');
  assert.deepEqual(tart.networks, []);
  assert.equal(github.runners.size, 0);
  assert.equal(manager.snapshot().vms.length, 0);
});

// After runscaler internal/controller/controller_test.go: TestStartInstanceReleasesCapacityWhenJITFails
test('a VM whose runner cannot be registered is deleted, and its slot goes to the next try', async () => {
  const { github, tart, manager, settle, advance } = setup({
    settings: { linux: { max: 1, image: 'minitart-base-linux' } },
  });
  github.queue('octo/app', ['minitart-linux']);
  const register = github.registerRunner.bind(github);
  github.registerRunner = async () => {
    throw new GitHubError(500, 'POST generate-jitconfig failed (500)');
  };
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.deepEqual(github.removed, [], 'there was no runner to remove');
  assert.match(manager.snapshot().queued[0]?.note ?? '', /trying again in 5s/);

  github.registerRunner = register;
  advance(6000);
  await manager.tick();
  await settle();
  assert.equal(tart.runners().length, 1, 'the one slot is free again');
});

// After runscaler internal/provider/tart_test.go: TestTartProvider_StartInstance_RunnerExitsBeforeListening
test('a runner that exits before taking a job has its registration removed and its VM deleted', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-linux']);
  tart.runnerConnects = false;
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  tart.print(
    name,
    'minitart: this image has no ~/actions-runner; build it with: minitart image build',
  );
  tart.exit(name, 78);
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.equal(github.runners.size, 0);
  assert.equal(github.removed.length, 1);
  assert.deepEqual(manager.snapshot().done, [], 'no job ran, so none is recorded');
  assert.ok(manager.vmLog(name)?.some((line) => /exited with code 78/.test(line)));
});

// After runscaler internal/provider/tart_test.go: TestTartProvider_StartInstance_RunnerExitsBeforeListening
test('a kind whose runner exits before it reaches GitHub waits before the next VM', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-linux']);
  tart.runnerConnects = false;
  await manager.tick();
  await settle();
  const [first] = tart.runners();
  assert.ok(first);
  tart.exit(first, 78);
  await settle();

  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), [], 'not another VM at once');
  assert.match(manager.snapshot().queued[0]?.note ?? '', /failed to start/);
});

// After runscaler internal/provider/tart_test.go: TestTartProvider_StartInstance_RunnerExitsRightAfterConnecting
test('a kind whose runner connects and then exits without a job waits before the next VM', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-linux']);
  for (let round = 0; round < 3; round++) {
    await manager.tick();
    await settle();
    const [name] = tart.runners();
    if (!name) break;
    tart.print(name, 'An error occurred: Runner version v2.300.0 is deprecated');
    tart.exit(name, 1);
    await settle();
  }
  assert.equal(github.removed.length, 1, 'one VM, then the kind waits');
});

// After runscaler internal/controller/retry_test.go: TestWorkedRunnerExitDoesNotCountAsStartupFailure
test('a VM that starts after failed ones resets the wait, and a finished job is no failure', async () => {
  const { github, tart, manager, settle, advance } = setup();
  const first = github.queue('octo/app', ['minitart-linux'], 'first');
  tart.failNext('clone', new Error('tart clone: busy'), 2);
  await manager.tick();
  await settle();
  advance(6000);
  await manager.tick();
  await settle();
  assert.match(manager.snapshot().queued[0]?.note ?? '', /trying again in 10s/);

  advance(11_000);
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name, 'the third try boots and its runner connects');
  github.take(name);
  tart.print(name, 'Job first completed with result: Succeeded');
  github.complete(first);
  tart.exit(name, 0);
  await settle();
  assert.equal(manager.snapshot().done[0]?.conclusion, 'success');

  // The next failure starts the wait over from the bottom.
  github.queue('octo/app', ['minitart-linux'], 'second');
  tart.failNext('clone', new Error('tart clone: busy'));
  await manager.tick();
  await settle();
  assert.match(manager.snapshot().queued[0]?.note ?? '', /trying again in 5s/);
});

// After runscaler internal/backoff/backoff_test.go: TestExponentialDoublesToTheCap
test('the wait after failed starts doubles up to five minutes and no further', async () => {
  const { github, tart, manager, settle, advance } = setup();
  github.queue('octo/app', ['minitart-linux']);
  const waits: number[] = [];
  for (let i = 0; i < 8; i++) {
    tart.failNext('clone', new Error('tart clone: busy'));
    await manager.tick();
    await settle();
    const note = manager.snapshot().queued[0]?.note ?? '';
    const seconds = Number(/trying again in (\d+)s/.exec(note)?.[1]);
    waits.push(seconds);
    advance(seconds * 1000 + 1000);
  }
  assert.deepEqual(waits, [5, 10, 20, 40, 80, 160, 300, 300]);
});

// After runscaler internal/controller/controller_test.go: TestCleanupFailureDoesNotBlockOtherInstances
test('a VM that cannot be deleted holds up neither the sweep nor a VM that is running a job', async () => {
  const { github, tart, manager, settle } = setup();
  const a = github.queue('octo/app', ['minitart-linux'], 'a');
  github.queue('octo/app', ['minitart-linux'], 'b');
  await manager.tick();
  await settle();
  const [first, second] = tart.runners();
  assert.ok(first && second);
  github.take(first);
  github.take(second);
  tart.print(first, 'Running job: a');
  tart.print(second, 'Running job: b');
  github.complete(a);
  tart.failNext('remove', new Error('tart delete: resource busy'));
  tart.exit(first, 0);
  await settle();
  assert.deepEqual(jobVms(tart).sort(), [first, second].sort(), 'the first is still on disk');

  // The sweep that follows deletes the leftover and leaves the live VM alone.
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), [second]);
  assert.deepEqual(tart.runners(), [second]);
  assert.equal(manager.snapshot().vms[0]?.status, 'running');
});

// After runscaler internal/controller/controller_test.go: TestExitedRunnerIsRemovedAndReplaced
test('a VM that dies in the middle of a job is recorded as lost, and the next job gets a new VM', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-linux'], 'test');
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  github.take(name);
  tart.print(name, 'Running job: test');
  await manager.tick();
  // The guest dies: the exec stream ends with no result, and GitHub has none yet.
  tart.exit(name, 137);
  await settle();
  assert.deepEqual(jobVms(tart), []);
  const [done] = manager.snapshot().done;
  assert.equal(done?.conclusion, 'lost');
  assert.equal(done?.job.name, 'test');

  github.queue('octo/app', ['minitart-linux'], 'next');
  await manager.tick();
  await settle();
  const [next] = tart.runners();
  assert.ok(next && next !== name, 'a fresh VM, never the old one');
});

// After ephemerd pkg/scheduler/slots_test.go: TestHandleMacOSJob_ReleasesExactlyOncePerOutcome ("provisioning deadline")
test('a VM still alive past the longest job GitHub allows is stopped', async () => {
  const { github, tart, manager, settle, advance } = setup();
  github.queue('octo/app', ['minitart-linux'], 'forever');
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  github.take(name);
  tart.print(name, 'Running job: forever');
  advance(6 * 60 * 60_000);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), [name], 'six hours is within GitHub limit');
  advance(61 * 60_000);
  await manager.tick();
  await settle();
  assert.deepEqual(jobVms(tart), []);
  assert.equal(manager.snapshot().done[0]?.conclusion, 'lost');
});

// After runscaler internal/controller/registrations_test.go: TestShutdownCleansRegistrationFromCancelledProvisioning
test('a runner registered while minitart shuts down is removed, and its VM deleted', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-linux']);
  const pending = deferred<void>();
  const register = github.registerRunner.bind(github);
  github.registerRunner = async (...args) => {
    await pending.promise;
    return register(...args);
  };
  await manager.tick();
  await settle();
  assert.equal(jobVms(tart).length, 1, 'booted, waiting on GitHub');

  const stopped = manager.stop();
  pending.resolve();
  await stopped;
  assert.deepEqual(jobVms(tart), []);
  assert.equal(github.removed.length, 1);
  assert.equal(github.runners.size, 0, 'no registration is left on GitHub');
});

// After sand Tests/sandTests/VMShutdownCoordinatorTests.swift: testConcurrentCleanupWaitsForInFlightDestroy
test('shutting down while a VM is being cloned deletes the clone once it exists, and boots nothing', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-linux']);
  const pending = deferred<void>();
  const clone = tart.clone.bind(tart);
  tart.clone = async (source, name) => {
    await pending.promise;
    return clone(source, name);
  };
  await manager.tick();
  await settle();
  assert.equal(manager.snapshot().vms[0]?.status, 'cloning');

  const stopped = manager.stop();
  pending.resolve();
  await stopped;
  assert.deepEqual(jobVms(tart), []);
  assert.deepEqual(tart.networks, []);
  assert.equal(github.runners.size, 0);
});

// After runscaler internal/controller/readiness_test.go: TestReadinessDrainCancelsWorker
test('shutting down while a VM boots stops waiting for it and registers nothing', async () => {
  const { github, tart, manager, settle } = setup();
  github.queue('octo/app', ['minitart-macos']);
  tart.agentDown = true;
  await manager.tick();
  await settle();
  assert.equal(manager.snapshot().vms[0]?.status, 'booting');
  await manager.stop();
  assert.deepEqual(jobVms(tart), []);
  assert.equal(github.runners.size, 0);
  assert.ok(!logged(manager, /failed to start/), 'a shutdown is not a failure');
});

// After runscaler cmd/runner/orphans_test.go: TestRemoveOrphanTartVMs_ContinuesAfterDeleteFailure
test('leftovers: one that cannot be deleted does not stop the rest, and pulled images are not touched', async () => {
  const { tart, manager } = setup();
  tart.addImage('minitart-linux-000001');
  tart.addImage('minitart-macos-000002');
  // A registry image that happens to have a job VM's name is not one.
  tart.vms.set('minitart-linux-000003', { running: false, source: 'OCI', halt: null, run: null });
  tart.failNext('remove', new Error('tart delete: resource busy'));
  assert.equal(await manager.removeOrphans(), false);
  assert.deepEqual(jobVms(tart).sort(), ['minitart-linux-000001', 'minitart-linux-000003']);
  assert.ok(logged(manager, /Could not remove minitart-linux-000001/));
  assert.equal(await manager.removeOrphans(), true);
  assert.deepEqual(jobVms(tart), ['minitart-linux-000003']);
});

// After sand Tests/sandTests/ProcessRunnerTests.swift: testRedactReplacesSecrets
test("a runner's single-use config appears in no log and no state the dashboard is sent", async () => {
  const { github, tart, manager, settle } = setup();
  const job = github.queue('octo/app', ['minitart-linux'], 'test');
  await manager.tick();
  await settle();
  const [name] = tart.runners();
  assert.ok(name);
  const secret = (tart.stdin(name) ?? '').trim();
  assert.match(secret, /^jit-\d+$/);
  github.take(name);
  tart.print(name, 'Running job: test');
  await manager.tick();
  assert.ok(!JSON.stringify(manager.snapshot()).includes(secret));
  github.complete(job);
  tart.exit(name, 0);
  await settle();
  assert.ok(!JSON.stringify(manager.snapshot()).includes(secret));
  assert.ok(!(manager.vmLog(name) ?? []).join('\n').includes(secret));
  assert.ok(tart.commands.every((command) => !command.includes(secret)));
});
