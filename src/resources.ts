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
  /**
   * Bytes a second, down and up: minitart's VMs (their own network interfaces), and the
   * rest of the Mac (its network ports, less what the VMs sent and got through them).
   */
  netVmsDown: number;
  netVmsUp: number;
  netOtherDown: number;
  netOtherUp: number;
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

/**
 * The bytes each network interface has received and sent, from `netstat -ibn`: its link row,
 * the one with `<Link#n>`, whose last columns are always `Ibytes Opkts Oerrs Obytes Coll`.
 */
export function interfaceBytes(netstat: string): Map<string, { in: number; out: number }> {
  const found = new Map<string, { in: number; out: number }>();
  for (const line of netstat.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8 || !fields[2]?.startsWith('<Link#')) continue;
    const name = (fields[0] ?? '').replace(/\*$/, '');
    const inBytes = Number(fields.at(-5));
    const outBytes = Number(fields.at(-2));
    if (!name || !Number.isFinite(inBytes) || !Number.isFinite(outBytes)) continue;
    found.set(name, { in: inBytes, out: outBytes });
  }
  return found;
}

/** The interfaces Softnet gives job VMs, the ones the firewall rule names (D21). */
const VM_INTERFACE = /^bridge1\d\d$/;
/** The Mac's own network ports: Ethernet, Wi-Fi, Thunderbolt. */
const PORT_INTERFACE = /^en\d+$/;

/**
 * Bytes down and up since the last counts, for the VMs and for the Mac's ports. An
 * interface not counted before (a VM just started), or whose count went back (made again),
 * counts from its next point.
 */
export function networkSince(
  before: ReadonlyMap<string, { in: number; out: number }>,
  now: ReadonlyMap<string, { in: number; out: number }>,
): { vmsDown: number; vmsUp: number; portsDown: number; portsUp: number } {
  const sum = { vmsDown: 0, vmsUp: 0, portsDown: 0, portsUp: 0 };
  for (const [name, count] of now) {
    const last = before.get(name);
    if (!last || count.in < last.in || count.out < last.out) continue;
    if (VM_INTERFACE.test(name)) {
      // What the Mac got from a VM is what the VM sent: its upload.
      sum.vmsUp += count.in - last.in;
      sum.vmsDown += count.out - last.out;
    } else if (PORT_INTERFACE.test(name)) {
      sum.portsDown += count.in - last.in;
      sum.portsUp += count.out - last.out;
    }
  }
  return sum;
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
  #last: {
    at: number;
    cpu: { busy: number; total: number };
    vms: Map<number, number>;
    net: { at: number; bytes: Map<string, { in: number; out: number }> };
  } | null = null;
  #disk: DiskView | null = null;
  #sampling = false;

  constructor(deps: ResourcesDeps) {
    this.#deps = deps;
  }

  /** Points kept from before a restart, oldest first: the chart starts from them. */
  seed(points: readonly ResourcePoint[]): void {
    const first = this.#points[0]?.at ?? Infinity;
    this.#points.unshift(...points.filter((point) => point.at < first));
    this.#trim();
  }

  /** An hour back from the newest point, and never more points than that hour holds. */
  #trim(): void {
    const newest = this.#points.at(-1)?.at;
    if (newest === undefined) return;
    const from = newest - POINTS * STEP_MS;
    const old = this.#points.findIndex((point) => point.at > from);
    if (old > 0) this.#points.splice(0, old);
    if (this.#points.length > POINTS) this.#points.splice(0, this.#points.length - POINTS);
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
    // Not knowing the VMs is not the same as there being none: no point, and nothing forgotten.
    if (ps === null) return;
    const processes = vmProcesses(ps);
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
    // The byte counts carry their own time: asking lsof about a new VM can take a while.
    const netstat = await this.#deps.run('netstat', ['-ibn']);
    const last = this.#last;
    const net =
      netstat === null
        ? (last?.net ?? { at, bytes: new Map() })
        : { at: this.#deps.now(), bytes: interfaceBytes(netstat) };
    this.#last = {
      at,
      cpu,
      vms: new Map(jobVms.map((vm) => [vm.pid, vm.cpuSeconds])),
      net,
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
    // What the VMs sent and got also crossed the Mac's ports: the rest is the Mac's own.
    const moved = networkSince(last.net.bytes, net.bytes);
    const seconds = (net.at - last.net.at) / 1000;
    // Counts not read again (netstat failed) are no traffic to share out: the point says 0.
    const rate = (bytes: number) => (seconds > 0 ? Math.round(Math.max(0, bytes) / seconds) : 0);
    this.#points.push({
      at,
      cpuVms: round(cpuVms),
      cpuOther: round(Math.max(0, total - cpuVms)),
      memVms: Math.round(memVms),
      memOther: used === null ? 0 : Math.round(Math.max(0, used - memVms)),
      netVmsDown: rate(moved.vmsDown),
      netVmsUp: rate(moved.vmsUp),
      netOtherDown: rate(moved.portsDown - moved.vmsDown),
      netOtherUp: rate(moved.portsUp - moved.vmsUp),
    });
    this.#trim();
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
    // One at a time: `du` fails on the lot when one of them is missing (an image not built).
    const sizes = new Map<string, number>();
    for (const path of paths) {
      const du = await this.#deps.run('du', ['-sk', path]);
      for (const [where, bytes] of du === null ? [] : duSizes(du)) sizes.set(where, bytes);
    }
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
