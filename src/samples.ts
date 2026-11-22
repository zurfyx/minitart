// The charts' points kept on disk: one a minute, its average and its peak, for the History
// view and for the Now view's hour after a restart. Kept forever unless the owner sets a
// limit (This Mac, Settings).

import type { ResourcePoint } from './resources.ts';

/** The series a point has, each kept a minute as its average and its peak. */
export const SERIES = [
  'cpuVms',
  'cpuOther',
  'memVms',
  'memOther',
  'netVmsDown',
  'netVmsUp',
  'netOtherDown',
  'netOtherUp',
] as const;
export type Series = (typeof SERIES)[number];

export const MINUTE_MS = 60_000;

/** A minute: when it began, and each series' average and peak over its points. */
export type MinuteSample = { at: number } & Record<Series, number> & Record<`${Series}Max`, number>;

/** Averages a minute's points, and keeps their peaks. */
export function summarise(at: number, points: readonly ResourcePoint[]): MinuteSample {
  const sample = { at } as MinuteSample;
  for (const series of SERIES) {
    const values = points.map((point) => point[series]);
    sample[series] = round(values.reduce((sum, value) => sum + value, 0) / values.length);
    sample[`${series}Max`] = round(Math.max(...values));
  }
  return sample;
}

/** A minute as a chart point: its averages. */
export function asPoint(sample: MinuteSample): ResourcePoint {
  const point = { at: sample.at } as ResourcePoint;
  for (const series of SERIES) point[series] = sample[series];
  return point;
}

/**
 * Gathers the points of each minute and hands the minute over once a point of a later one
 * comes. A point at or before one already taken is ignored.
 */
export class Minutes {
  #at: number | null = null;
  #points: ResourcePoint[] = [];
  #newest = -Infinity;

  add(point: ResourcePoint): MinuteSample | null {
    if (point.at <= this.#newest) return null;
    this.#newest = point.at;
    const minute = Math.floor(point.at / MINUTE_MS) * MINUTE_MS;
    let done: MinuteSample | null = null;
    if (this.#at !== null && minute !== this.#at && this.#points.length) {
      done = summarise(this.#at, this.#points);
      this.#points = [];
    }
    this.#at = minute;
    this.#points.push(point);
    return done;
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
