// Settings (D06). There is no config file to write by hand: the defaults come from the
// machine, the repo allowlist is the GitHub App's installation (D03), and what the owner
// changes in the dashboard is saved here.

export type Pool = 'linux' | 'macos';
export const POOLS: readonly Pool[] = ['linux', 'macos'];

/** Apple's licence and its hypervisor both stop at two macOS VMs per Mac. */
export const MACOS_VM_LIMIT = 2;
export const LINUX_VM_LIMIT = 8;

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
  /** Repos the App can see that the owner has paused, as `owner/name`. */
  pausedRepos: string[];
}

const GB = 1024 ** 3;

/** Defaults that fit the machine: three quarters of its memory, at most two VMs of each kind. */
export function defaultSettings(machine: Machine): Settings {
  const totalGb = machine.memoryBytes / GB;
  const memoryGb = clamp(Math.floor(totalGb / 5), 4, 16);
  const fit = Math.max(1, Math.floor((totalGb * 0.75) / memoryGb));
  const macos = Math.min(MACOS_VM_LIMIT, fit);
  const linux = clamp(fit - macos, 1, 2);
  return {
    linux: { max: linux, image: 'minitart-base-linux' },
    macos: { max: macos, image: 'minitart-base-macos' },
    vm: { cpu: clamp(Math.floor(machine.cpus / 3), 2, 8), memoryMb: memoryGb * 1024 },
    pollSeconds: 5,
    idleSeconds: 180,
    allowPublicRepos: false,
    pausedRepos: [],
  };
}

export class SettingsError extends Error {}

/**
 * `base` with the fields of `patch` laid over it. `patch` is untrusted (a file on disk, a
 * request body): an unknown field or a value out of range throws.
 */
export function mergeSettings(base: Settings, patch: unknown, machine: Machine): Settings {
  const input = record(patch, 'settings');
  const known = new Set(Object.keys(base));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new SettingsError(`Unknown setting: ${key}`);
  }
  const pool = (name: Pool, limit: number) => {
    if (input[name] === undefined) return base[name];
    const value = record(input[name], name);
    return {
      max: integer(value['max'] ?? base[name].max, `${name}.max`, 0, limit),
      image: imageName(value['image'] ?? base[name].image, `${name}.image`),
    };
  };
  const vm = input['vm'] === undefined ? {} : record(input['vm'], 'vm');
  const maxMemoryMb = Math.floor(machine.memoryBytes / 1024 ** 2);
  return {
    linux: pool('linux', LINUX_VM_LIMIT),
    macos: pool('macos', MACOS_VM_LIMIT),
    vm: {
      cpu: integer(vm['cpu'] ?? base.vm.cpu, 'vm.cpu', 1, machine.cpus),
      memoryMb: integer(vm['memoryMb'] ?? base.vm.memoryMb, 'vm.memoryMb', 2048, maxMemoryMb),
    },
    pollSeconds: integer(input['pollSeconds'] ?? base.pollSeconds, 'pollSeconds', 2, 300),
    idleSeconds: integer(input['idleSeconds'] ?? base.idleSeconds, 'idleSeconds', 30, 3600),
    allowPublicRepos: boolean(
      input['allowPublicRepos'] ?? base.allowPublicRepos,
      'allowPublicRepos',
    ),
    pausedRepos: repoNames(input['pausedRepos'] ?? base.pausedRepos, 'pausedRepos'),
  };
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
    if (typeof repo !== 'string' || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
      throw new SettingsError(`${name} holds something that is not owner/name`);
    }
    return repo;
  });
}
