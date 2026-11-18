// The checks behind `minitart doctor` and the dashboard's health line: is this Mac set up
// the way the security model assumes (docs/security.md)?

import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
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
  checks.push({
    id: 'tart',
    ok: version !== null,
    title: 'Tart',
    detail: version === null ? 'Tart is not installed' : `Tart ${version}`,
    fix: version === null ? 'brew install openai/tools/tart' : null,
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
    const ready = softnet !== null && softnetIsSetuidRoot(softnet);
    checks.push({
      id: 'network',
      ok: ready,
      title: 'Network',
      detail: ready
        ? 'Softnet: jobs reach the internet and nothing private'
        : softnet === null
          ? 'Softnet is not installed, so no VM can start'
          : 'Softnet cannot run as root yet, so no VM can start',
      fix: ready
        ? null
        : softnet === null
          ? 'brew install openai/tools/softnet'
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
  return checks;
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
