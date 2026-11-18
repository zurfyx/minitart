// How much memory this Mac can give a new VM, in macOS's own words (D22).
//
// A VM takes memory as its guest uses it, up to its size, and gives none back until it is
// deleted. So starting one is a promise of that much memory, made when it starts.

import { execFile } from 'node:child_process';

export interface Memory {
  /** What macOS could hand out without compressing or swapping what programs are using. */
  availableMb: number;
  /** Whether macOS itself says it is short: its memory pressure is above normal. */
  pressure: boolean;
}

/**
 * Memory to spare, from `vm_stat`: pages that are free, pages that hold files macOS can read
 * again from disk, and pages their owners marked as disposable. Not counted: memory that
 * programs are using, also the part macOS calls inactive, which it could only free by
 * compressing or swapping it. `null` when the output is not understood.
 */
export function availableMb(vmStat: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  if (!Number.isInteger(pageSize) || pageSize <= 0) return null;
  let pages = 0;
  for (const name of ['Pages free', 'File-backed pages', 'Pages purgeable']) {
    const count = Number(new RegExp(`^${name}:\\s+(\\d+)\\.`, 'm').exec(vmStat)?.[1]);
    if (!Number.isInteger(count)) return null;
    pages += count;
  }
  return Math.floor((pages * pageSize) / 1024 ** 2);
}

function output(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

/** Asks macOS. `null` when it cannot be asked: then nothing is known, and nothing is held back. */
export async function readMemory(): Promise<Memory | null> {
  const stat = await output('vm_stat', []);
  const available = stat === null ? null : availableMb(stat);
  if (available === null) return null;
  // 1 is normal; 2 and 4 are macOS warning that it is short, and critically short.
  const level = Number(
    (await output('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']))?.trim(),
  );
  return { availableMb: available, pressure: Number.isInteger(level) && level > 1 };
}
