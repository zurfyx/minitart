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

export interface VmStep {
  at: number;
  /** VMs up on average over the step: two VMs up for half of it is 1. */
  linux: number;
  macos: number;
}

/** How many VMs of each kind were up in each step from `from`, by the time each spent in it. */
export function vmsUp(
  times: readonly { pool: 'linux' | 'macos'; startedAt: number; endedAt: number }[],
  from: number,
  to: number,
  stepMs: number,
): VmStep[] {
  const count = Math.ceil((to - from) / stepMs);
  const steps: VmStep[] = Array.from({ length: count }, (_, index) => ({
    at: from + index * stepMs,
    linux: 0,
    macos: 0,
  }));
  for (const vm of times) {
    const start = Math.max(from, vm.startedAt);
    const end = Math.min(to, vm.endedAt);
    if (end <= start) continue;
    // Only the steps the VM was up in: VMs live minutes, so most touch one or two.
    for (let index = Math.floor((start - from) / stepMs); index < count; index++) {
      const step = steps[index];
      if (!step) break;
      const overlap = Math.min(end, step.at + stepMs) - Math.max(start, step.at);
      if (overlap <= 0) break;
      step[vm.pool] += overlap / stepMs;
    }
  }
  return steps.map((step) => ({
    at: step.at,
    linux: Math.round(step.linux * 100) / 100,
    macos: Math.round(step.macos * 100) / 100,
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
  /** The VMs up now: they are not in the history until they end. */
  running: readonly { pool: 'linux' | 'macos'; createdAt: number }[],
): HistoryView {
  const stepMs = stepFor(to - from);
  const stats = history.stats();
  const oldest = [stats.samplesOldestAt, stats.oldestAt].filter((at): at is number => at !== null);
  return {
    from,
    to,
    stepMs,
    samples: history.samples(from, to, stepMs),
    vms: vmsUp(
      [
        ...history.vmTimes(from, to),
        ...running.map((vm) => ({ pool: vm.pool, startedAt: vm.createdAt, endedAt: to })),
      ],
      from,
      to,
      stepMs,
    ),
    oldestAt: oldest.length ? Math.min(...oldest) : null,
  };
}
