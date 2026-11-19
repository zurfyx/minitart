// What this Mac's CPU, memory and disk are doing, for the dashboard's charts (D23).
//
// A VM is one macOS process, `com.apple.Virtualization.VirtualMachine`, whatever its guest
// runs: its CPU time and resident memory are the VM's. The process is not a child of `tart`,
// so which VM it runs is read from the disk it has open (`lsof`), once per process.

import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { cpus, homedir } from 'node:os';
import { join } from 'node:path';
import { isJobVm } from './manager.ts';

/** One point every ten seconds, for an hour. */
export const STEP_MS = 10_000;
export const POINTS = 360;
/** Measuring what Tart keeps on disk reads every file of it: not often. */
const DISK_EVERY_MS = 10 * 60_000;

const VM_PROCESS = /\/com\.apple\.Virtualization\.VirtualMachine$/;

export interface ResourcePoint {
  at: number;
  /** Percent of the whole Mac: 100 is every core busy. */
  cpuVms: number;
  cpuOther: number;
  /** Megabytes in use: by minitart's job VMs, and by everything else. */
  memVms: number;
  memOther: number;
}

export interface DiskView {
  totalBytes: number;
  freeBytes: number;
  /**
   * What Tart keeps, by name. A clone shares its blocks with what it was cloned from until
   * either is written to, so these can add up to more than they take.
   */
  tart: { name: string; bytes: number }[];
  at: number;
}

export interface ResourcesView {
  stepMs: number;
  cores: number;
  memoryBytes: number;
  points: ResourcePoint[];
  disk: DiskView | null;
}

export interface VmProcess {
  pid: number;
  cpuSeconds: number;
  rssBytes: number;
}

/** CPU time as `ps` writes it: `[[dd-]hh:]mm:ss[.cc]`. */
export function cpuSeconds(time: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(time.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
  );
}

/** The VM processes in `ps -axo pid=,time=,rss=,comm=`. */
export function vmProcesses(ps: string): VmProcess[] {
  const found: VmProcess[] = [];
  for (const line of ps.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match || !VM_PROCESS.test(match[4] ?? '')) continue;
    const time = cpuSeconds(match[2] ?? '');
    if (time === null) continue;
    found.push({ pid: Number(match[1]), cpuSeconds: time, rssBytes: Number(match[3]) * 1024 });
  }
  return found;
}

/** The VM whose files a process has open, from `lsof -Fn -p <pid>`. */
export function vmOfFiles(lsof: string, tartHome: string): string | null {
  const prefix = `n${join(tartHome, 'vms')}/`;
  for (const line of lsof.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const name = line.slice(prefix.length).split('/')[0];
    if (name) return name;
  }
  return null;
}

/** `du -sk` lines: kilobytes, a tab, the path. */
export function duSizes(du: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of du.split('\n')) {
    const match = /^(\d+)\t(.+)$/.exec(line);
    if (match?.[2] !== undefined) sizes.set(match[2], Number(match[1]) * 1024);
  }
  return sizes;
}

export interface ResourcesDeps {
  cores: number;
  memoryBytes: number;
  /** Runs a command and resolves with what it printed, or null when it failed. */
  run: (command: string, args: string[]) => Promise<string | null>;
  /** Busy and total CPU time of every core so far, in any unit. */
  cpuTimes: () => { busy: number; total: number };
  /** What macOS has to spare, in megabytes (memory.ts), or null when not known. */
  availableMb: () => number | null;
  /** The images VMs are cloned from: their size is minitart's on disk. */
  images: () => string[];
  tartHome: string;
  now: () => number;
  statfs: (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
}

export class Resources {
  readonly #deps: ResourcesDeps;
  readonly #points: ResourcePoint[] = [];
  /** Which VM each VM process runs: a name, or '' for one that is not a job VM. */
  readonly #names = new Map<number, string>();
  #last: { at: number; cpu: { busy: number; total: number }; vms: Map<number, number> } | null =
    null;
  #disk: DiskView | null = null;
  #sampling = false;

  constructor(deps: ResourcesDeps) {
    this.#deps = deps;
  }

  view(): ResourcesView {
    return {
      stepMs: STEP_MS,
      cores: this.#deps.cores,
      memoryBytes: this.#deps.memoryBytes,
      points: [...this.#points],
      disk: this.#disk,
    };
  }

  /** Takes one point; the first only sets where CPU time is counted from. */
  async sample(): Promise<void> {
    if (this.#sampling) return;
    this.#sampling = true;
    try {
      await this.#sample();
      if (this.#disk === null || this.#deps.now() - this.#disk.at >= DISK_EVERY_MS) {
        await this.#sampleDisk();
      }
    } finally {
      this.#sampling = false;
    }
  }

  async #sample(): Promise<void> {
    const at = this.#deps.now();
    const cpu = this.#deps.cpuTimes();
    const ps = await this.#deps.run('ps', ['-axo', 'pid=,time=,rss=,comm=']);
    const processes = ps === null ? [] : vmProcesses(ps);
    const alive = new Set(processes.map((vm) => vm.pid));
    for (const pid of this.#names.keys()) if (!alive.has(pid)) this.#names.delete(pid);
    for (const vm of processes) {
      if (this.#names.has(vm.pid)) continue;
      const files = await this.#deps.run('lsof', ['-Fn', '-p', String(vm.pid)]);
      const name = files === null ? null : vmOfFiles(files, this.#deps.tartHome);
      // Not known yet (lsof failed) is asked again next time; not a job VM is remembered.
      if (name !== null) this.#names.set(vm.pid, isJobVm(name) ? name : '');
    }
    const jobVms = processes.filter((vm) => this.#names.get(vm.pid));
    const last = this.#last;
    this.#last = {
      at,
      cpu,
      vms: new Map(jobVms.map((vm) => [vm.pid, vm.cpuSeconds])),
    };
    if (last === null || cpu.total <= last.cpu.total || at <= last.at) return;

    const total = (100 * (cpu.busy - last.cpu.busy)) / (cpu.total - last.cpu.total);
    // A VM first seen now has no time to count from: it counts from its next point.
    let vmSeconds = 0;
    for (const vm of jobVms) {
      const before = last.vms.get(vm.pid);
      if (before !== undefined) vmSeconds += Math.max(0, vm.cpuSeconds - before);
    }
    const cpuVms = Math.min(100, (100 * vmSeconds) / (((at - last.at) / 1000) * this.#deps.cores));
    const memVms = jobVms.reduce((sum, vm) => sum + vm.rssBytes, 0) / 1024 ** 2;
    const available = this.#deps.availableMb();
    const used = available === null ? null : this.#deps.memoryBytes / 1024 ** 2 - available;
    this.#points.push({
      at,
      cpuVms: round(cpuVms),
      cpuOther: round(Math.max(0, total - cpuVms)),
      memVms: Math.round(memVms),
      memOther: used === null ? 0 : Math.round(Math.max(0, used - memVms)),
    });
    if (this.#points.length > POINTS) this.#points.splice(0, this.#points.length - POINTS);
  }

  async #sampleDisk(): Promise<void> {
    let volume;
    try {
      // `/` is the sealed system volume; what fills up is the data volume beside it.
      volume = await this.#deps.statfs('/System/Volumes/Data').catch(() => this.#deps.statfs('/'));
    } catch {
      return;
    }
    const images = this.#deps.images().filter((name) => /^[A-Za-z0-9][\w.-]*$/.test(name));
    const paths = [
      ...images.map((name) => join(this.#deps.tartHome, 'vms', name)),
      join(this.#deps.tartHome, 'cache'),
    ];
    const du = await this.#deps.run('du', ['-sk', ...paths]);
    const sizes = du === null ? new Map<string, number>() : duSizes(du);
    const tart = [
      ...images.map((name) => ({ name, bytes: sizes.get(join(this.#deps.tartHome, 'vms', name)) })),
      { name: 'Downloaded images', bytes: sizes.get(join(this.#deps.tartHome, 'cache')) },
    ].filter((entry): entry is { name: string; bytes: number } => entry.bytes !== undefined);
    this.#disk = {
      totalBytes: volume.blocks * volume.bsize,
      freeBytes: volume.bavail * volume.bsize,
      tart,
      at: this.#deps.now(),
    };
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** All cores' busy and total time so far, from Node. */
export function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const core of cpus()) {
    const { user, nice, sys, idle, irq } = core.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + irq + idle;
  }
  return { busy, total };
}

export function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}

export function liveResources(options: {
  cores: number;
  memoryBytes: number;
  availableMb: () => number | null;
  images: () => string[];
}): Resources {
  return new Resources({
    ...options,
    run,
    cpuTimes,
    tartHome: process.env['TART_HOME'] ?? join(homedir(), '.tart'),
    now: Date.now,
    statfs: (path) => statfs(path),
  });
}
