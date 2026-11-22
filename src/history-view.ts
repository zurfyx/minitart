// What the History view is sent for a range (D27): the charts' minutes gathered into steps
// that fit it, and how many VMs of each kind were up in each step, from the jobs kept.

import type { History } from './history.ts';
import { MINUTE_MS, type MinuteSample } from './samples.ts';

/** The steps a range is drawn in, in minutes: the smallest that gives at most this many. */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
export const MOST_STEPS = 360;

export function stepFor(rangeMs: number): number {
  const minutes = STEPS.find((step) => rangeMs / (step * MINUTE_MS) <= MOST_STEPS) ?? 1440;
  return minutes * MINUTE_MS;
}

const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The range the History view shows for `days` ending at `end`: its steps line up with the Mac's
 * clock, a day's at its midnight, and the last one holds `end`. The server is the Mac, so its
 * time zone is the one the steps follow.
 */
export function rangeFor(days: number, end: number): { from: number; to: number } {
  const stepMs = stepFor(days * DAY_MS);
  const midnight = new Date(end);
  midnight.setHours(0, 0, 0, 0);
  // Every step divides a day, so steps counted from midnight line up with the hours too.
  const to = midnight.getTime() + Math.ceil((end - midnight.getTime()) / stepMs) * stepMs;
  return { from: to - days * DAY_MS, to };
}

export interface VmStep {
  at: number;
  /** VMs up on average over the step: two VMs up for half of it is 1. */
  linux: number;
  macos: number;
  /** The most up at once in the step, of each kind and of both. */
  linuxMost: number;
  macosMost: number;
  most: number;
}

type VmTime = { pool: 'linux' | 'macos'; startedAt: number; endedAt: number };

/** The most VMs up at once in each step, sweeping through when each was cloned and deleted. */
function mostAtOnce(times: readonly VmTime[], from: number, count: number, stepMs: number) {
  // A VM deleted as another is cloned is not two at once: ends go first.
  const changes = times
    .flatMap((vm): [number, number][] => [
      [vm.startedAt, 1],
      [vm.endedAt, -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const most: number[] = [];
  let up = 0;
  let next = 0;
  for (let index = 0; index < count; index++) {
    const start = from + index * stepMs;
    while (next < changes.length && (changes[next]?.[0] ?? 0) <= start) {
      up += changes[next]?.[1] ?? 0;
      next++;
    }
    let peak = up;
    while (next < changes.length && (changes[next]?.[0] ?? 0) < start + stepMs) {
      up += changes[next]?.[1] ?? 0;
      peak = Math.max(peak, up);
      next++;
    }
    most.push(peak);
  }
  return most;
}

/** How many VMs of each kind were up in each step from `from`, by the time each spent in it. */
export function vmsUp(
  times: readonly VmTime[],
  from: number,
  to: number,
  stepMs: number,
): VmStep[] {
  const count = Math.ceil((to - from) / stepMs);
  const steps = Array.from({ length: count }, (_, index) => ({
    at: from + index * stepMs,
    linux: 0,
    macos: 0,
  }));
  // Each VM's time within the range.
  const within = times
    .map((vm) => ({
      pool: vm.pool,
      startedAt: Math.max(from, vm.startedAt),
      endedAt: Math.min(to, vm.endedAt),
    }))
    .filter((vm) => vm.endedAt > vm.startedAt);
  for (const vm of within) {
    const start = vm.startedAt;
    const end = vm.endedAt;
    // Only the steps the VM was up in: VMs live minutes, so most touch one or two.
    for (let index = Math.floor((start - from) / stepMs); index < count; index++) {
      const step = steps[index];
      if (!step) break;
      const overlap = Math.min(end, step.at + stepMs) - Math.max(start, step.at);
      if (overlap <= 0) break;
      step[vm.pool] += overlap / stepMs;
    }
  }
  const linuxMost = mostAtOnce(
    within.filter((vm) => vm.pool === 'linux'),
    from,
    count,
    stepMs,
  );
  const macosMost = mostAtOnce(
    within.filter((vm) => vm.pool === 'macos'),
    from,
    count,
    stepMs,
  );
  const most = mostAtOnce(within, from, count, stepMs);
  return steps.map((step, index) => ({
    at: step.at,
    linux: Math.round(step.linux * 100) / 100,
    macos: Math.round(step.macos * 100) / 100,
    linuxMost: linuxMost[index] ?? 0,
    macosMost: macosMost[index] ?? 0,
    most: most[index] ?? 0,
  }));
}

export interface HistoryView {
  from: number;
  to: number;
  stepMs: number;
  samples: MinuteSample[];
  vms: VmStep[];
  /** When the oldest thing kept begins, chart minutes or jobs: how far back there is to go. */
  oldestAt: number | null;
}

export function historyView(
  history: History,
  from: number,
  to: number,
  /**
   * The VMs up now that have taken a job: they are not in the history until they end, and a
   * VM that never takes one is never kept, so idle ones are left out here too.
   */
  running: readonly { pool: 'linux' | 'macos'; createdAt: number }[],
  now = Date.now(),
): HistoryView {
  const stepMs = stepFor(to - from);
  const stats = history.stats();
  const oldest = [stats.samplesOldestAt, stats.oldestAt].filter((at): at is number => at !== null);
  const oldestAt = oldest.length ? Math.min(...oldest) : null;
  // Before anything was kept, or up, there is nothing to say, not zero VMs: those steps are
  // left out.
  const known = [...oldest, ...running.map((vm) => vm.createdAt)];
  const since = known.length ? Math.min(...known) : null;
  const vms = vmsUp(
    [
      ...history.vmTimes(from, to),
      ...running.map((vm) => ({
        pool: vm.pool,
        startedAt: vm.createdAt,
        endedAt: Math.min(to, now),
      })),
    ],
    from,
    to,
    stepMs,
  ).filter((step) => since !== null && step.at + stepMs > since && step.at <= now);
  return { from, to, stepMs, samples: history.samples(from, to, stepMs), vms, oldestAt };
}
