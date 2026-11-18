// Settings (D06). There is no config file to write by hand: the defaults come from the
// machine, a repo is served once the App is on it and the owner turned it on (D03), and what the owner
// changes in the dashboard is saved here.

export type Pool = 'linux' | 'macos';
export const POOLS: readonly Pool[] = ['linux', 'macos'];

/** Apple's licence and its hypervisor both stop at two macOS VMs per Mac. */
export const MACOS_VM_LIMIT = 2;

/**
 * How many VM network interfaces the firewall rule covers (firewall/install.sh names
 * bridge100 to bridge131; a test holds the two to the same number). macOS gives each running
 * VM the lowest free one, so a VM is behind the rule as long as there are never more VMs at
 * once than this (D21).
 */
export const FIREWALL_INTERFACES = 32;

/**
 * Interfaces left for VMs the manager does not count: an image being built of each kind,
 * the one `selftest` boots, and one of the owner's own.
 */
export const SPARE_INTERFACES = 4;

/**
 * Linux VMs have no limit of their own. This is the most there can be with every VM still
 * behind the firewall rule; memory decides the rest.
 */
export const LINUX_VM_LIMIT = FIREWALL_INTERFACES - MACOS_VM_LIMIT - SPARE_INTERFACES;

export interface Machine {
  cpus: number;
  memoryBytes: number;
}

export interface Settings {
  /** How many VMs of each kind may exist at once. 0 turns the kind off. */
  linux: { max: number; image: string };
  macos: { max: number; image: string };
  /** Every VM gets the same size. */
  vm: { cpu: number; memoryMb: number };
  /** How often GitHub is asked for queued jobs. */
  pollSeconds: number;
  /** How long a booted VM waits for a job before it is deleted. */
  idleSeconds: number;
  /** Public repos are skipped unless this is on (D05). */
  allowPublicRepos: boolean;
  /**
   * The repos this Mac serves, as `owner/name` (D03). A repo is served only when the GitHub
   * App is installed on it and it is listed here: installing the App on a whole account
   * serves nothing by itself.
   */
  repos: string[];
}

const GB = 1024 ** 3;

/**
 * Defaults that fit the machine. Each VM gets a fifth of the memory, between 4 and 8 GB:
 * a VM ends up using what it is given (its guest fills spare memory with cached files), so
 * what it is given is what a job costs, and 8 GB is what a standard hosted runner has.
 *
 * As many VMs may run at once as fit in three quarters of the memory, with two CPUs' worth
 * of the Mac each at least: two macOS ones, which is Apple's limit, and the rest Linux.
 * Together they want about as many CPUs as the Mac has.
 */
export function defaultSettings(machine: Machine): Settings {
  const totalGb = machine.memoryBytes / GB;
  const memoryGb = clamp(Math.floor(totalGb / 5), 4, 8);
  const byMemory = Math.floor((totalGb * 0.75) / memoryGb);
  const byCpu = Math.floor(machine.cpus / 2);
  const fit = Math.max(1, Math.min(byMemory, byCpu));
  const macos = Math.min(MACOS_VM_LIMIT, fit);
  const linux = clamp(fit - macos, 1, LINUX_VM_LIMIT);
  return {
    linux: { max: linux, image: 'minitart-base-linux' },
    macos: { max: macos, image: 'minitart-base-macos' },
    vm: {
      // CPU is shared, not set aside: wanting a little more than there is only slows things.
      cpu: Math.min(machine.cpus, clamp(Math.round(machine.cpus / (linux + macos)), 2, 8)),
      memoryMb: memoryGb * 1024,
    },
    pollSeconds: 5,
    idleSeconds: 180,
    allowPublicRepos: false,
    repos: [],
  };
}

export class SettingsError extends Error {}

/**
 * `base` with the fields of `patch` laid over it. `patch` is untrusted (a file on disk, a
 * request body): an unknown field or a value out of range throws.
 */
export function mergeSettings(base: Settings, patch: unknown, machine: Machine): Settings {
  const input = section(patch, 'settings', Object.keys(base));
  const pool = (name: Pool, limit: number) => {
    if (input[name] === undefined) return base[name];
    const value = section(input[name], name, ['max', 'image']);
    return {
      max: integer(given(value['max'], base[name].max), `${name}.max`, 0, limit),
      image: imageName(given(value['image'], base[name].image), `${name}.image`),
    };
  };
  const vm = input['vm'] === undefined ? {} : section(input['vm'], 'vm', ['cpu', 'memoryMb']);
  const maxMemoryMb = Math.floor(machine.memoryBytes / 1024 ** 2);
  const next: Settings = {
    linux: pool('linux', LINUX_VM_LIMIT),
    macos: pool('macos', MACOS_VM_LIMIT),
    vm: {
      cpu: integer(given(vm['cpu'], base.vm.cpu), 'vm.cpu', 1, machine.cpus),
      memoryMb: integer(given(vm['memoryMb'], base.vm.memoryMb), 'vm.memoryMb', 2048, maxMemoryMb),
    },
    pollSeconds: integer(given(input['pollSeconds'], base.pollSeconds), 'pollSeconds', 2, 300),
    idleSeconds: integer(given(input['idleSeconds'], base.idleSeconds), 'idleSeconds', 30, 3600),
    allowPublicRepos: boolean(
      given(input['allowPublicRepos'], base.allowPublicRepos),
      'allowPublicRepos',
    ),
    repos: repoNames(given(input['repos'], base.repos), 'repos'),
  };
  // Each value can be in range while the whole is not: the VMs run at the same time.
  const vms = next.linux.max + next.macos.max;
  if (vms * next.vm.memoryMb > maxMemoryMb) {
    throw new SettingsError(
      `${vms} VMs of ${Math.round(next.vm.memoryMb / 1024)} GB need more memory than this Mac has`,
    );
  }
  return next;
}

/** A field that is absent keeps its value. One that is present, even as null, is checked. */
function given(value: unknown, fallback: unknown): unknown {
  return value === undefined ? fallback : value;
}

/** An object with no field outside `known`: a misspelt setting is an error, not a no-op. */
function section(value: unknown, name: string, known: readonly string[]): Record<string, unknown> {
  const fields = record(value, name);
  for (const key of Object.keys(fields)) {
    if (!known.includes(key)) {
      throw new SettingsError(`Unknown setting: ${name === 'settings' ? key : `${name}.${key}`}`);
    }
  }
  return fields;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SettingsError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new SettingsError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new SettingsError(`${name} must be true or false`);
  return value;
}

/** A Tart VM name. It is passed to `tart` as an argument, so it never starts with a dash. */
function imageName(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(value)) {
    throw new SettingsError(`${name} must be a Tart image name`);
  }
  return value;
}

function repoNames(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new SettingsError(`${name} must be a list of repos`);
  }
  return value.map((repo) => {
    if (typeof repo !== 'string' || !/^[A-Za-z0-9_-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
      throw new SettingsError(`${name} holds something that is not owner/name`);
    }
    return repo;
  });
}
