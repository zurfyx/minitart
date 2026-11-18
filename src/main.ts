#!/usr/bin/env node
// The command line. `minitart start` is the manager and its dashboard; the other commands
// set this Mac up and check it.

import { availableParallelism, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { demoWorld } from './demo.ts';
import { runChecks, type Check } from './doctor.ts';
import { AppAuth, parseAppCredentials, type AppCredentials } from './github/app.ts';
import { GitHubClient } from './github/client.ts';
import type { GitHub } from './github/types.ts';
import { Home } from './home.ts';
import { buildImage, latestRunner, UPSTREAM, type BuiltImage } from './image.ts';
import { Manager, type DoneView, type LogLine } from './manager.ts';
import { defaultGateway, hostAddresses, selftest } from './selftest.ts';
import { createDashboardServer } from './server.ts';
import { installService, LABEL, uninstallService } from './service.ts';
import { defaultSettings, mergeSettings, type Pool, type Settings } from './settings.ts';
import { readTailnet, type TailnetName } from './tailnet.ts';
import { TartCli, type Network, type Tart } from './tart.ts';

const USAGE = `minitart: GitHub Actions runners on your own Mac, every job in a fresh VM

  minitart start                  run the manager and its dashboard
      --port <n>                  the dashboard's port (default 4141)
      --unsafe-shared-network     let VMs reach your LAN (for trying minitart out only)
      --demo                      made-up jobs and VMs, to look at the dashboard
  minitart doctor                 check that this Mac is set up
  minitart image build <kind>     build the image job VMs are cloned from: linux or macos
      --from <image>              the image to start from
  minitart selftest               boot a VM and check what it can reach
  minitart service install        start minitart at login (takes the same flags as start)
  minitart service uninstall

https://minitart.rovira.sh`;

/** The output of this many VMs is kept on disk; older files are deleted. */
const KEPT_VM_LOGS = 50;

const machine = { cpus: availableParallelism(), memoryBytes: totalmem() };

/**
 * The saved settings. A file that no longer holds (a rule that came with an update, a file
 * edited by hand) must not keep minitart from starting, and must not be lost to the next
 * save either: it is moved aside, and minitart starts on the defaults, which serve no repo.
 */
function loadSettings(home: Home, warn: (text: string) => void = console.warn): Settings {
  const defaults = defaultSettings(machine);
  try {
    const saved = home.readJson('settings.json');
    return saved === undefined ? defaults : mergeSettings(defaults, saved, machine);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    let kept = home.path('settings.json');
    try {
      kept = home.setAside('settings.json', 'settings.invalid.json');
    } catch {
      // It stays where it is, and the next save replaces it.
    }
    warn(
      `The saved settings are not valid (${reason}). Using the defaults; the old file is ${kept}`,
    );
    return defaults;
  }
}

function loadApp(home: Home): AppCredentials | null {
  return parseAppCredentials(home.readJson('app.json'));
}

/** Which of the kinds' images exist. Asked without `tart list` (tart.ts). */
async function images(tart: Tart, settings: Settings): Promise<Set<string> | null> {
  try {
    const present = new Set<string>();
    for (const pool of ['linux', 'macos'] as const) {
      if (await tart.has(settings[pool].image)) present.add(settings[pool].image);
    }
    return present;
  } catch {
    return null;
  }
}

/** The runner version each image was built with (`minitart image build` writes it). */
function builtRunners(home: Home): Partial<Record<Pool, string>> {
  const have: Partial<Record<Pool, string>> = {};
  let built: Partial<Record<Pool, BuiltImage>>;
  try {
    built = (home.readJson('images.json') ?? {}) as Partial<Record<Pool, BuiltImage>>;
  } catch {
    // An unreadable record means an advisory check is skipped, nothing more.
    return have;
  }
  for (const pool of ['linux', 'macos'] as const) {
    const runner = built[pool]?.runner;
    if (typeof runner === 'string') have[pool] = runner;
  }
  return have;
}

async function newestRunner(): Promise<string | null> {
  try {
    return (await latestRunner('linux')).version;
  } catch {
    return null;
  }
}

function printChecks(checks: readonly Check[]): boolean {
  for (const check of checks) {
    const mark = check.ok ? '  ok ' : check.optional ? ' note' : ' FIX ';
    console.log(`${mark} ${check.title}: ${check.detail}`);
    if (check.fix) console.log(`        ${check.fix}`);
  }
  return checks.every((check) => check.ok || check.optional);
}

async function start(flags: { port: number; network: Network; demo: boolean }): Promise<void> {
  const demo = flags.demo ? demoWorld() : null;
  const home = demo ? null : new Home();
  const tart: Tart = demo?.tart ?? new TartCli();
  let app = home ? loadApp(home) : null;
  // What goes wrong before the manager exists is said once it does, so the dashboard shows it.
  const early: string[] = [];
  let say: ((text: string) => void) | null = null;
  let lastWarning = '';
  const warn = (text: string) => {
    // The same trouble every poll is said once.
    if (text === lastWarning) return;
    lastWarning = text;
    if (say) say(text);
    else early.push(text);
  };
  const connect = (credentials: AppCredentials) =>
    new GitHubClient(new AppAuth(credentials, fetch, Date.now, warn));
  let github: GitHub | null = demo?.github ?? (app ? connect(app) : null);
  let health: Check[] = [];

  const stamp = (at: number) => new Date(at).toISOString();
  const manager = new Manager({
    github: () => github,
    tart,
    network: flags.network,
    settings: home
      ? loadSettings(home, (text) => early.push(text))
      : { ...defaultSettings(machine), repos: ['octo/app', 'octo/api', 'octo/site'] },
    saveSettings: (settings) => {
      home?.writeJson('settings.json', settings);
      // The health line follows a settings change without waiting a minute.
      check().catch((error: unknown) => console.error(error));
    },
    history: home
      ? ((home.readJson('history.json') as DoneView[] | undefined) ?? [])
      : (demo?.history ?? []),
    saveHistory: (history) => home?.writeJson('history.json', history),
    vmLog: (vm, line) => home?.appendLog(`${vm}.log`, line),
    log: (line: LogLine) =>
      console.log(`${stamp(line.at)} ${line.level === 'warn' ? 'WARN ' : ''}${line.text}`),
  });
  say = (text) => manager.warn(text);
  for (const text of early) say(text);

  let checking = false;
  let tailnet: TailnetName[] = [];
  let newest: string | null = null;
  let newestAt = 0;
  async function check(): Promise<void> {
    // One at a time: each check runs a few commands.
    if (checking) return;
    checking = true;
    try {
      tailnet = await readTailnet(flags.port);
      // The demo has no Mac to check, only names to answer to.
      if (demo) return;
      // GitHub's newest runner version is asked for once a day.
      if (Date.now() - newestAt > 24 * 60 * 60_000) {
        newest = await newestRunner();
        newestAt = Date.now();
      }
      health = await runChecks({
        network: flags.network,
        settings: manager.settings,
        images: await images(tart, manager.settings),
        hasApp: app !== null,
        runners: { have: home ? builtRunners(home) : {}, latest: newest },
        tailnet,
      });
    } finally {
      checking = false;
    }
  }
  await check();
  const prune = () =>
    home?.pruneLogs(KEPT_VM_LOGS, new Set(manager.snapshot().vms.map((vm) => `${vm.name}.log`)));
  prune();
  const everyMinute = setInterval(() => {
    // A check that throws is tried again in a minute; it must not stop the manager.
    check().catch((error: unknown) => console.error(error));
    prune();
  }, 60_000);

  const server = createDashboardServer({
    manager,
    github: () => github,
    app: () => app,
    saveApp: (created) => {
      home?.writeJson('app.json', created);
      app = created;
      github = connect(created);
      check().catch((error: unknown) => console.error(error));
    },
    health: () => health,
    tailnet: () => tailnet,
    machine,
    ...(demo ? { machineName: 'mac-mini.local' } : {}),
    port: flags.port,
    dashboardDir: fileURLToPath(new URL('../dashboard/', import.meta.url)),
  });
  server.listen(flags.port, '127.0.0.1', () => {
    console.log(`minitart: the dashboard is at http://127.0.0.1:${flags.port}`);
    for (const name of tailnet) {
      if (!name.funnel) console.log(`minitart: and at ${name.origin} for your tailnet`);
    }
    if (flags.network === 'shared') {
      console.log('minitart: WARNING: --unsafe-shared-network lets jobs reach your LAN.');
    }
    if (!demo && !app) console.log('minitart: open it on this Mac to create the GitHub App.');
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log('minitart: stopping, and deleting every VM');
    clearInterval(everyMinute);
    demo?.stop();
    server.close();
    server.closeAllConnections();
    void manager.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await manager.start();
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', default: process.env['MINITART_PORT'] ?? '4141' },
      'unsafe-shared-network': { type: 'boolean', default: false },
      demo: { type: 'boolean', default: false },
      from: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  const network: Network = values['unsafe-shared-network'] ? 'shared' : 'softnet';
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a port');

  if (values.help || command === undefined || command === 'help') {
    console.log(USAGE);
    return 0;
  }

  if (command === 'start') {
    await start({
      port,
      network,
      demo: values.demo,
    });
    return new Promise(() => {});
  }

  if (command === 'doctor') {
    const home = new Home();
    const settings = loadSettings(home);
    const ok = printChecks(
      await runChecks({
        network,
        settings,
        images: await images(new TartCli(), settings),
        hasApp: loadApp(home) !== null,
        runners: { have: builtRunners(home), latest: await newestRunner() },
        tailnet: await readTailnet(port),
      }),
    );
    return ok ? 0 : 1;
  }

  if (command === 'image' && rest[0] === 'build') {
    const pool = rest[1];
    if (pool !== 'linux' && pool !== 'macos')
      throw new Error('Say which: minitart image build linux, or macos');
    const home = new Home();
    const settings = loadSettings(home);
    await buildImage({
      tart: new TartCli(),
      pool: pool satisfies Pool,
      from: values.from ?? UPSTREAM[pool],
      name: settings[pool].image,
      network,
      runner: await latestRunner(pool),
      print: (line) => console.log(line),
      record: (built) => {
        const all = (home.readJson('images.json') ?? {}) as Record<string, BuiltImage>;
        home.writeJson('images.json', { ...all, [pool]: built });
      },
    });
    return 0;
  }

  if (command === 'selftest') {
    const settings = loadSettings(new Home());
    const results = await selftest({
      tart: new TartCli(),
      image: settings.linux.image,
      network,
      host: { addresses: hostAddresses(), gateway: await defaultGateway() },
      print: (line) => console.log(line),
    });
    for (const result of results) {
      const verdict = result.ok ? '  ok ' : ' FAIL';
      console.log(`${verdict} ${result.what}: ${result.saw} (should be ${result.expect})`);
    }
    const ok = results.every((result) => result.ok);
    console.log(
      ok
        ? 'A job reaches the internet and nothing of yours.'
        : 'A job can reach more than the internet. Do not run jobs until this passes.',
    );
    return ok ? 0 : 1;
  }

  if (command === 'service' && rest[0] === 'install') {
    const home = new Home();
    const args = ['--port', String(port)];
    if (network === 'shared') args.push('--unsafe-shared-network');
    const path = await installService({
      main: fileURLToPath(import.meta.url),
      args,
      log: home.path('logs', 'manager.log'),
    });
    console.log(`Installed ${path}. minitart now starts at login.`);
    console.log(`Its log: ${home.path('logs', 'manager.log')}`);
    return 0;
  }

  if (command === 'service' && rest[0] === 'uninstall') {
    await uninstallService();
    console.log(`Removed ${LABEL}.`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`minitart: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
