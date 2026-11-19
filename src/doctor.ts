// The checks behind `minitart doctor` and the dashboard's health line: is this Mac set up
// the way the security model assumes (docs/security.md)?

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, Settings } from './settings.ts';
import type { TailnetName } from './tailnet.ts';
import type { Network } from './tart.ts';
import { DEVELOPMENT } from './version.ts';

export interface Check {
  id: string;
  ok: boolean;
  title: string;
  detail: string;
  /** What to run or do when the check fails. */
  fix: string | null;
  /** Advice: worth doing, and `doctor` still passes without it. */
  optional?: boolean;
  /**
   * The same fix as commands to run as root, one argument list each, for `doctor --fix`.
   * Only fixes that are a command and nothing else have one.
   */
  sudo?: string[][];
  /**
   * A fix that is commands to run as the owner, in order, for `doctor --fix`: installing a
   * tool that is missing. One that `mayFail` (a Homebrew too old to know the command) does
   * not stop the rest.
   */
  commands?: { argv: string[]; mayFail?: boolean }[];
}

/**
 * Installing Tart or Softnet from their tap. Homebrew refuses a formula from a tap it has
 * not been told to trust, so that is said first, for these two formulae and no others. And
 * Softnet is pinned, so that only `minitart upgrade` replaces its binary.
 */
function brewInstall(formula: 'tart' | 'softnet'): { argv: string[]; mayFail?: boolean }[] {
  return [
    {
      argv: ['brew', 'trust', '--formula', 'openai/tools/tart', 'openai/tools/softnet'],
      mayFail: true,
    },
    { argv: ['brew', 'install', `openai/tools/${formula}`] },
    { argv: ['brew', 'pin', 'softnet'], mayFail: true },
  ];
}

/** Older versions have bugs minitart would hit: leaked sockets and a spinning `exec -i`. */
export const MIN_TART = '2.42.0';
/** Older versions drop packets. */
export const MIN_SOFTNET = '0.24.1';
const MIN_FREE_DISK_GB = 30;
/** The first line firewall/install.sh writes. A change to the rules changes the version. */
export const FIREWALL_VERSION = 'minitart firewall v1';
const FIREWALL_SCRIPT = fileURLToPath(new URL('../firewall/install.sh', import.meta.url));

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
  /** Whether a program of this name is on the PATH. */
  tartInstalled?: (name: string) => boolean;
  /** The Softnet binary's real path, owner and mode, or `null` when it is not installed. */
  softnet?: () => { path: string; uid: number; mode: number } | null;
  /** Whether the rules that close this Mac to its VMs are installed, and at which version. */
  firewall?: () => { rules: string | null; daemon: boolean };
  /** The runner version in each kind's image, and GitHub's newest, where known. */
  runners?: { have: Partial<Record<Pool, string>>; latest: string | null };
  /** The version running, and the newest one released, where known. */
  versions?: { running: string; latest: string | null };
  /** Free space on the disk that holds the VMs, in GB. */
  freeDiskGb?: number | null;
  /** The tailnet names Tailscale forwards to the dashboard. */
  tailnet?: readonly TailnetName[];
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
    // Tart brings Softnet with it: it is one of Tart's own dependencies. Only a Tart that
    // is not there is installed: one that is there and did not answer is left alone.
    ...(version === null && !(input.tartInstalled ?? onPath)('tart')
      ? { commands: brewInstall('tart') }
      : {}),
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
            ? 'minitart upgrade'
            : setuid
              ? null
              : `sudo chown root ${softnet.path} && sudo chmod u+s ${softnet.path}`,
      ...(softnet === null ? { commands: brewInstall('softnet') } : {}),
      ...(softnet !== null && current && !setuid
        ? {
            sudo: [
              ['chown', 'root', softnet.path],
              ['chmod', 'u+s', softnet.path],
            ],
          }
        : {}),
    });
  }

  // A VM can always reach the Mac at its own gateway, for DHCP and DNS. The firewall rules
  // are what keep it to those two (D21).
  const firewall = (input.firewall ?? readFirewall)();
  const closed = firewall.daemon && (firewall.rules?.includes(FIREWALL_VERSION) ?? false);
  checks.push({
    id: 'firewall',
    ok: closed,
    title: 'Firewall',
    detail: closed
      ? 'A VM reaches this Mac for DHCP and DNS only'
      : firewall.rules === null
        ? 'A job can reach what this Mac serves to every network (AirPlay, Handoff, sharing)'
        : 'The firewall rules are from an older minitart, or are not loaded at boot',
    fix: closed ? null : `sudo sh ${FIREWALL_SCRIPT}`,
    ...(closed ? {} : { sudo: [['sh', FIREWALL_SCRIPT]] }),
  });

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
      ...(awake ? {} : { sudo: [['pmset', '-a', 'sleep', '0']] }),
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

  for (const name of input.tailnet ?? []) {
    const why = {
      // A page with no login, that changes settings, on the internet.
      funnel: `Tailscale Funnel publishes ${name.host} to the internet, so the dashboard does not answer to it`,
      'plain-http': `${name.host} is plain HTTP, so the dashboard does not answer to it`,
      'raw-tcp': `Tailscale forwards bare TCP (${name.host}) to the dashboard, which no name check can guard`,
    };
    checks.push({
      id: `tailnet-${name.host}`,
      ok: name.refused === null,
      title: 'Tailnet',
      detail:
        name.refused === null
          ? `The dashboard is at ${name.origin} for your tailnet`
          : why[name.refused],
      fix: name.fix,
    });
  }

  // A newer minitart is advice, never a failure: this one works.
  const { running, latest } = input.versions ?? { running: DEVELOPMENT, latest: null };
  if (running !== DEVELOPMENT && latest !== null && !atLeast(running, latest)) {
    checks.push({
      id: 'version',
      ok: false,
      optional: true,
      title: 'Version',
      detail: `minitart ${latest} is out; this is ${running}`,
      fix: 'minitart upgrade',
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

function readFirewall(): { rules: string | null; daemon: boolean } {
  let rules: string | null = null;
  try {
    rules = readFileSync('/etc/pf.anchors/minitart', 'utf8');
  } catch {
    // Not installed.
  }
  return { rules, daemon: existsSync('/Library/LaunchDaemons/sh.rovira.minitart.firewall.plist') };
}

function runCommand(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

function onPath(name: string): boolean {
  return (process.env['PATH'] ?? '').split(delimiter).some((dir) => existsSync(join(dir, name)));
}

/**
 * Why no VM may be started, from the checks: `null` when the Mac is set up to isolate one.
 * A VM that would not be isolated is not started at all (D04, D21); the owner who asked for
 * the unsafe network has said they know.
 */
export function blockedBy(checks: readonly Check[], network: Network): string | null {
  if (network === 'shared') return null;
  for (const id of ['network', 'firewall']) {
    const found = checks.find((c) => c.id === id);
    // Not knowing is not the same as being closed.
    if (found === undefined) return 'This Mac has not been checked yet';
    if (found.ok) continue;
    // `doctor --fix` when it can do it; the command itself when it cannot.
    const how =
      found.sudo !== undefined || found.commands !== undefined || found.fix === null
        ? 'minitart doctor --fix'
        : found.fix;
    return `${found.title}: ${found.detail}. Run: ${how}`;
  }
  return null;
}

/** Whether the firewall rule's files are in place, for commands that boot a VM by themselves. */
export function firewallInstalled(): boolean {
  const firewall = readFirewall();
  return firewall.daemon && (firewall.rules?.includes(FIREWALL_VERSION) ?? false);
}

/**
 * `doctor --fix`: installs what is missing, then runs the fixes that need root, checking
 * again after each so that a fix one check's commands already made is not made twice.
 * `run` runs a command with the terminal attached and resolves with its exit code, or
 * `null` when the program itself was not found.
 */
export async function applyFixes(
  check: () => Promise<Check[]>,
  run: (argv: string[]) => number | null,
  print: (line: string) => void,
): Promise<Check[]> {
  let checks = await check();
  const attempt = (argv: string[]): boolean => {
    print(`  ${argv.join(' ')}`);
    const status = run(argv);
    if (status === null) print(`  ${argv[0]} was not found on this Mac`);
    return status === 0;
  };
  const tried = new Set<string>();
  const next = (kind: 'commands' | 'sudo') =>
    checks.find((c) => !c.ok && c[kind] !== undefined && !tried.has(`${kind} ${c.id}`));

  // What is missing is installed first: the checks that follow are about what it brought.
  for (let broken = next('commands'); broken; broken = next('commands')) {
    tried.add(`commands ${broken.id}`);
    print(`Fixing ${broken.title}: ${broken.detail}`);
    for (const { argv, mayFail } of broken.commands ?? []) {
      if (!attempt(argv) && !mayFail) break;
    }
    checks = await check();
  }
  // Then what needs root; sudo asks for the password itself.
  for (let broken = next('sudo'); broken; broken = next('sudo')) {
    tried.add(`sudo ${broken.id}`);
    print(`Fixing ${broken.title}: ${broken.detail}`);
    for (const argv of broken.sudo ?? []) {
      if (!attempt(['sudo', ...argv])) break;
    }
    checks = await check();
  }
  return checks;
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
