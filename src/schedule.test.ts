import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plan, route } from './schedule.ts';

test("route: a job is minitart's only when it asks for a minitart label", () => {
  assert.equal(route(['ubuntu-latest']), null);
  assert.equal(route(['self-hosted', 'linux']), null);
  assert.equal(route(['minitart-linux']), 'linux');
  assert.equal(route(['minitart-macos']), 'macos');
  assert.equal(route(['self-hosted', 'macOS', 'ARM64', 'Minitart-macOS']), 'macos');
});

test('route: a minitart job that asks for a label no runner has is unsatisfiable', () => {
  assert.equal(route(['minitart-linux', 'x64']), 'unsatisfiable');
  assert.equal(route(['minitart-linux', 'macos']), 'unsatisfiable');
  assert.equal(route(['minitart-linux', 'minitart-macos']), 'unsatisfiable');
});

const job = (id: number, repo: string, pool: 'linux' | 'macos', createdAt = '2026-01-01') => ({
  id,
  repo,
  pool,
  createdAt,
});

test('plan: one VM per queued job, up to the limit of its kind', () => {
  const queued = [job(1, 'a/x', 'linux'), job(2, 'a/x', 'linux'), job(3, 'a/x', 'linux')];
  assert.deepEqual(plan(queued, [], { linux: 2, macos: 2 }), [
    { repo: 'a/x', pool: 'linux' },
    { repo: 'a/x', pool: 'linux' },
  ]);
});

test('plan: a VM that is starting or waiting for the repo covers a job', () => {
  const queued = [job(1, 'a/x', 'linux'), job(2, 'a/x', 'linux')];
  const vms = [{ repo: 'a/x', pool: 'linux' as const, busy: false }];
  assert.deepEqual(plan(queued, vms, { linux: 4, macos: 2 }), [{ repo: 'a/x', pool: 'linux' }]);
});

test('plan: a busy VM, or one for another repo, covers nothing but holds its slot', () => {
  const queued = [job(1, 'a/x', 'macos')];
  const busy = [{ repo: 'a/x', pool: 'macos' as const, busy: true }];
  assert.deepEqual(plan(queued, busy, { linux: 2, macos: 2 }), [{ repo: 'a/x', pool: 'macos' }]);
  const full = [...busy, { repo: 'a/y', pool: 'macos' as const, busy: false }];
  assert.deepEqual(plan(queued, full, { linux: 2, macos: 2 }), []);
});

test('plan: the oldest job gets the last slot, whichever repo it is in', () => {
  const queued = [job(1, 'a/new', 'linux', '2026-01-02'), job(2, 'a/old', 'linux', '2026-01-01')];
  assert.deepEqual(plan(queued, [], { linux: 1, macos: 0 }), [{ repo: 'a/old', pool: 'linux' }]);
});

test('plan: the kinds do not share slots', () => {
  const queued = [job(1, 'a/x', 'macos'), job(2, 'a/x', 'linux')];
  assert.deepEqual(plan(queued, [], { linux: 0, macos: 1 }), [{ repo: 'a/x', pool: 'macos' }]);
});
