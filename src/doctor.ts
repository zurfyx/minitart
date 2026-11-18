// The checks behind `minitart doctor` and the dashboard's health line: is this Mac set up
// the way the security model assumes (docs/security.md)?

import { execFile } from 'node:child_process';
import { realpathSync, statfsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Pool, Settings } from './settings.ts';
import type { Network } from './tart.ts';

export interface Check {
  id: string;
  ok: boolean;
  title: string;
  detail: string;
  /** What to run or do when the check fails. */
  fix: string | null;
  /** Advice: worth doing, and `doctor` still passes without it. */
  optional?: boolean;
}

/** Older versions have bugs minitart would hit: leaked sockets and a spinning `exec -i`. */
export const MIN_TART = '2.42.0';
/** Older versions drop packets. */
export const MIN_SOFTNET = '0.24.1';
const MIN_FREE_DISK_GB = 30;

/** Whether dotted version `have` is at least `want`. */
export function atLeast(have: string, want: string): boolean {
  const parse = (version: string) => (version.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  const [a, b] = [parse(have), parse(want)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export interface DoctorInput {
  network: Network;
  settings: Settings;
  /** Names of the VMs and images Tart has, or `null` when Tart could not be asked. */
  images: ReadonlySet<string> | null;
  hasApp: boolean;
  /** Runs a command and resolves with its output, or `null` when it fails. */
  run?: (command: string, args: string[]) => Promise<string | null>;
  /** The Softnet binary's real path, owner and mode, or `null` when it is not installed. */
  softnet?: () => { path: string; uid: number; mode: number } | null;
  /** The runner version in each kind's image, and GitHub's newest, where known. */
  runners?: { have: Partial<Record<Pool, string>>; latest: string | null };
  /** Free space on the disk that holds the VMs, in GB. */
  freeDiskGb?: number | null;
}

/** Softnet creates a network interface, which takes root: the binary must be setuid root. */
export function softnetIsSetuidRoot(file: { uid: number; mode: number }): boolean {
  return file.uid === 0 && (file.mode & 0o4000) !== 0;
}

/** macOS's `pmset -g` prints ` sleep  0` when the Mac never sleeps on its own. */
export function neverSleeps(pmset: string): boolean {
  return /^\s*sleep\s+0\b/m.test(pmset);
}

export async function runChecks(input: DoctorInput): Promise<Check[]> {
  const run = input.run ?? runCommand;
  const checks: Check[] = [];

  const version = (await run('tart', ['--version']))?.trim() ?? null;
  const tartOk = version !== null && atLeast(version, MIN_TART);
  checks.push({
    id: 'tart',
    ok: tartOk,
    title: 'Tart',
    detail:
      version === null
        ? 'Tart is not installed'
        : tartOk
          ? `Tart ${version}`
          : `Tart ${version} is older than ${MIN_TART}, which fixed bugs minitart would hit`,
    fix: version === null ? 'brew install openai/tools/tart' : tartOk ? null : 'brew upgrade tart',
  });

  if (input.network === 'shared') {
    checks.push({
      id: 'network',
      ok: false,
      title: 'Network',
      detail: 'Started with --unsafe-shared-network: jobs can reach your LAN',
      fix: 'Restart minitart without --unsafe-shared-network',
    });
  } else {
    const softnet = (input.softnet ?? findSoftnet)();
    const setuid = softnet !== null && softnetIsSetuidRoot(softnet);
    const softnetVersion = softnet === null ? null : await run('softnet', ['--version']);
    const current = softnetVersion === null || atLeast(softnetVersion, MIN_SOFTNET);
    checks.push({
      id: 'network',
      ok: setuid && current,
      title: 'Network',
      detail:
        softnet === null
          ? 'Softnet is not installed, so no VM can start'
          : !current
            ? `Softnet is older than ${MIN_SOFTNET}, which drops packets`
            : setuid
              ? 'Softnet: jobs reach the internet and nothing private'
              : 'Softnet cannot run as root yet, so no VM can start',
      fix:
        softnet === null
          ? 'brew install openai/tools/softnet'
          : !current
            ? 'brew upgrade softnet'
            : setuid
              ? null
              : `sudo chown root ${softnet.path} && sudo chmod u+s ${softnet.path}`,
    });
  }

  for (const pool of ['linux', 'macos'] as const satisfies readonly Pool[]) {
    const name = input.settings[pool].image;
    const off = input.settings[pool].max === 0;
    const present = input.images?.has(name) ?? false;
    checks.push({
      id: `image-${pool}`,
      ok: present || off,
      title: pool === 'linux' ? 'Linux image' : 'macOS image',
      detail: off ? 'Turned off' : present ? name : `${name} has not been built`,
      fix: present || off ? null : `minitart image build ${pool}`,
    });
    // GitHub stops accepting a runner some weeks after a newer one is out, and a job
    // handed to a retired runner fails instead of waiting.
    const have = input.runners?.have[pool];
    const latest = input.runners?.latest ?? null;
    if (present && !off && have !== undefined && latest !== null && have !== latest) {
      checks.push({
        id: `runner-${pool}`,
        ok: false,
        optional: true,
        title: pool === 'linux' ? 'Linux runner' : 'macOS runner',
        detail: `The image has runner ${have}; the newest is ${latest}. GitHub retires old runners`,
        fix: `minitart image build ${pool}`,
      });
    }
  }

  checks.push({
    id: 'github',
    ok: input.hasApp,
    title: 'GitHub App',
    detail: input.hasApp ? 'Connected' : 'Not created yet',
    fix: input.hasApp ? null : 'Open the dashboard on this Mac and create the GitHub App',
  });

  const pmset = await run('pmset', ['-g']);
  if (pmset !== null) {
    const awake = neverSleeps(pmset);
    checks.push({
      id: 'sleep',
      ok: awake,
      title: 'Sleep',
      detail: awake ? 'This Mac stays awake' : 'This Mac sleeps, and a sleeping Mac runs no jobs',
      fix: awake ? null : 'sudo pmset -a sleep 0',
    });
  }

  // Tart runs VMs from a logged-in session, so after a restart nothing runs until someone
  // logs in. Automatic login fixes that and needs FileVault off: the owner's trade to make.
  const autoLogin = await run('defaults', [
    'read',
    '/Library/Preferences/com.apple.loginwindow',
    'autoLoginUser',
  ]);
  if (pmset !== null) {
    const fileVault = /FileVault is On/.test((await run('fdesetup', ['status'])) ?? '');
    checks.push({
      id: 'login',
      ok: autoLogin !== null,
      optional: true,
      title: 'Restart',
      detail:
        autoLogin !== null
          ? 'This Mac logs in by itself after a restart'
          : 'After a restart, no job runs until you log in',
      fix:
        autoLogin !== null
          ? null
          : fileVault
            ? 'Automatic login needs FileVault off. Leaving it on is a fair choice: log in after a restart'
            : 'System Settings, Users & Groups: Automatically log in as',
    });
  }

  const free = input.freeDiskGb === undefined ? freeDiskGb() : input.freeDiskGb;
  if (free !== null) {
    checks.push({
      id: 'disk',
      ok: free >= MIN_FREE_DISK_GB,
      title: 'Disk',
      detail: `${Math.round(free)} GB free`,
      fix: free >= MIN_FREE_DISK_GB ? null : 'Free some space: tart prune, or delete old images',
    });
  }
  return checks;
}

function freeDiskGb(): number | null {
  try {
    const stats = statfsSync(process.env['TART_HOME'] ?? homedir());
    return (stats.bavail * stats.bsize) / 1024 ** 3;
  } catch {
    return null;
  }
}

function runCommand(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

function findSoftnet(): { path: string; uid: number; mode: number } | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    try {
      const path = realpathSync(join(dir, 'softnet'));
      const stat = statSync(path);
      return { path, uid: stat.uid, mode: stat.mode };
    } catch {
      // Not in this directory.
    }
  }
  return null;
}
