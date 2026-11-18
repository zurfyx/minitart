// Which queued jobs are minitart's, and which VMs to start for them. Pure functions: the
// manager (manager.ts) feeds them what it sees and does what they say.

import type { Pool } from './settings.ts';

/**
 * The labels a runner of each kind carries (D08). A workflow asks for a kind with
 * `runs-on: minitart-linux` or `runs-on: minitart-macos`; the other labels are there for
 * workflows that spell the machine out, as in `[self-hosted, macos, arm64, minitart-macos]`.
 */
export const LABELS: Record<Pool, readonly string[]> = {
  linux: ['self-hosted', 'linux', 'arm64', 'minitart-linux'],
  macos: ['self-hosted', 'macos', 'arm64', 'minitart-macos'],
};

/**
 * Where a job with these `runs-on` labels goes: a pool, `null` when the job is not asking
 * for minitart, or `'unsatisfiable'` when it asks for minitart and for something no minitart
 * runner has (such a job would wait forever, so the dashboard says so).
 */
export function route(labels: readonly string[]): Pool | 'unsatisfiable' | null {
  const wanted = labels.map((label) => label.toLowerCase());
  const linux = wanted.includes('minitart-linux');
  const macos = wanted.includes('minitart-macos');
  if (!linux && !macos) return null;
  if (linux && macos) return 'unsatisfiable';
  const pool: Pool = linux ? 'linux' : 'macos';
  return wanted.every((label) => LABELS[pool].includes(label)) ? pool : 'unsatisfiable';
}

export interface Waiting {
  id: number;
  repo: string;
  pool: Pool;
  createdAt: string;
}

export interface Slot {
  repo: string;
  pool: Pool;
  /** Whether the VM's runner already has its job. */
  busy: boolean;
}

/**
 * The VMs to start, oldest job first. A runner belongs to one repo, so a job is covered by a
 * VM that is starting or waiting for that repo; a job nothing covers gets a new VM while its
 * pool has room.
 */
export function plan(
  queued: readonly Waiting[],
  vms: readonly Slot[],
  limits: Record<Pool, number>,
): { repo: string; pool: Pool }[] {
  const count: Record<Pool, number> = { linux: 0, macos: 0 };
  const spare = new Map<string, number>();
  for (const vm of vms) {
    count[vm.pool]++;
    if (!vm.busy) spare.set(key(vm), (spare.get(key(vm)) ?? 0) + 1);
  }
  const launches: { repo: string; pool: Pool }[] = [];
  const oldestFirst = [...queued].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id,
  );
  for (const job of oldestFirst) {
    const free = spare.get(key(job)) ?? 0;
    if (free > 0) {
      spare.set(key(job), free - 1);
    } else if (count[job.pool] < limits[job.pool]) {
      count[job.pool]++;
      launches.push({ repo: job.repo, pool: job.pool });
    }
  }
  return launches;
}

function key(item: { repo: string; pool: Pool }): string {
  return `${item.pool} ${item.repo}`;
}
