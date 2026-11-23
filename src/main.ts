#!/usr/bin/env node
// The command line. `minitart start` is the manager and its dashboard; the other commands
// set this Mac up and check it.

import { availableParallelism, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { demoSettings, demoWorld } from './demo.ts';
import { applyFixes, blockedBy, firewallInstalled, runChecks, type Check } from './doctor.ts';
import { AppAuth, appIdentity, parseAppCredentials, type AppCredentials } from './github/app.ts';
import { GitHubClient } from './github/client.ts';
import type { GitHub } from './github/types.ts';
import { Home } from './home.ts';
import { buildImage, latestRunner, UPSTREAM, type BuiltImage } from './image.ts';
import { Manager, type LogLine, type VmView } from './manager.ts';
import { KEEP_MS, MemoryHistory, openHistory, type History } from './history.ts';
import { readMemory, type Memory } from './memory.ts';
import { liveResources, STEP_MS, type Resources } from './resources.ts';
import { asPoint, Minutes } from './samples.ts';
import { defaultGateway, hostAddresses, listening, selftest } from './selftest.ts';
import { createDashboardServer } from './server.ts';
import { installService, LABEL, plistPath, uninstallService } from './service.ts';
import { defaultSettings, mergeSettings, type Pool, type Settings } from './settings.ts';
import { readTailnet, type TailnetName } from './tailnet.ts';
import { TartCli, type Network, type Tart } from './tart.ts';
import { BREW_SERVICE_LABELS, installKind, Running, serviceArgs, upgradeSteps } from './upgrade.ts';
import { VERSION } from './version.ts';

const USAGE = `minitart: GitHub Actions runners on your own Mac, every job in a fresh VM

  minitart start                  run the manager and its dashboard
      --port <n>                  the dashboard's port (default 4141)
      --unsafe-shared-network     let VMs reach your LAN (for trying minitart out only)
      --demo                      made-up jobs and VMs, to look at the dashboard
  minitart doctor                 check that this Mac is set up
      --fix                       run the fixes that need the Mac's password, asking for it
  minitart upgrade                a new minitart: jobs finish, the software changes, it restarts
      --now                       do not wait for running jobs; they fail and can be re-run
  minitart drain | resume         start no new jobs (the running ones finish) | start them again
  minitart image build <kind>     build the image job VMs are cloned from: linux or macos
      --from <image>              the image to start from
  minitart selftest               boot a VM and check what it can reach
  minitart service install        start minitart at login (takes the same flags as start)
  minitart service uninstall
  minitart --version

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
    return saved === undefined
      ? defaults
      : mergeSettings(defaults, saved, machine, { saved: true });
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

/** The newest minitart released, as `1.2.3`, or `null` when GitHub cannot be asked. */
async function newestMinitart(): Promise<string | null> {
  try {
    const response = await fetch('https://api.github.com/repos/zurfyx/minitart/releases/latest', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'minitart' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const tag = ((await response.json()) as { tag_name?: unknown }).tag_name;
    return typeof tag === 'string' ? (/^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

/** Runs a command with the terminal attached, so it can ask for a password. */
function runAttached(command: readonly string[]): number | null {
  const [program, ...args] = command;
  if (program === undefined) return 1;
  const result = spawnSync(program, args, { stdio: 'inherit' });
  // No such program is told apart from a program that failed.
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
  return result.status ?? 1;
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

/** The charts' points, of this Mac or of the demo's. */
type Charts = Pick<Resources, 'view' | 'sample'> & { seed?: Resources['seed'] };

/**
 * What `start` runs on: this Mac, or the demo's made-up one. `start` picks one, from `--demo`,
 * and runs either without asking which. Each is a plain function: none relies on `this`.
 */
interface Host {
  tart: Tart;
  /** The GitHub App, once it exists. */
  app: () => AppCredentials | null;
  /** GitHub, through the App. */
  github: () => GitHub | null;
  /** Keeps the App the dashboard's setup created, and uses it from then on. */
  saveApp: (app: AppCredentials) => void;
  settings: Settings;
  saveSettings: (settings: Settings) => void;
  /** The jobs that ran and the charts' minutes (D24, D27). */
  history: History;
  /** What the checks found when they last ran. */
  health: () => Check[];
  /** Runs the checks again. */
  check: () => Promise<void>;
  /** Why no VM may start now, or null (D04, D21). */
  blocked: () => string | null;
  /** What macOS had to spare when last read. */
  memory: () => Memory | null;
  /** Reads what macOS has to spare again. */
  readMemory: () => Promise<void>;
  charts: Charts;
  /** Writes a line a VM printed, as it comes. */
  vmLog?: (vm: string, line: string) => void;
  /** A VM's output once the VM is gone, its last `maxBytes`. */
  vmLogFile: (name: string, maxBytes: number) => string | null;
  /** What the VM logs take. */
  logs: () => { files: number; bytes: number };
  /** minitart's own log files, and what each takes. */
  ownLogs: () => { path: string; bytes: number }[];
  /** Deletes the older VM logs, keeping those of `keep`. */
  pruneLogs: (keep: ReadonlySet<string>) => void;
  /** The name the page shows, when not the Mac's own. */
  machineName?: string;
  /** What to say once the dashboard listens, if anything. */
  greeting: () => string | null;
  stop: () => void;
}

/**
 * What a host asks of `start` once it runs: the manager's settings and VMs, and the tailnet
 * names. The manager is made after the host, so none of it may be asked for while the host is
 * being made.
 */
interface Started {
  settings: () => Settings;
  vms: () => VmView[];
  tailnet: () => readonly TailnetName[];
}

/** This Mac: its Tart, its GitHub App, `~/.minitart`, its checks, memory and charts. */
function thisMac(options: {
  network: Network;
  running: Started;
  /** Said on the dashboard once the manager exists, the same trouble once. */
  warn: (text: string) => void;
  /** Said on the dashboard once the manager exists. */
  note: (text: string) => void;
}): Host {
  const { network, running } = options;
  const home = new Home();
  const tart = new TartCli();
  let app = loadApp(home);
  const connect = (credentials: AppCredentials) =>
    new GitHubClient(new AppAuth(credentials, fetch, Date.now, options.warn));
  let github: GitHub | null = app ? connect(app) : null;
  // An App can be renamed on GitHub, which changes its address: the saved one is refreshed.
  const refreshApp = async () => {
    if (!app) return;
    const now = await appIdentity(app).catch(() => null);
    if (now === null || (now.slug === app.slug && now.htmlUrl === app.htmlUrl)) return;
    app = { ...app, ...now };
    home.writeJson('app.json', app);
  };
  // A link that stays stale is the worst of it: nothing here may stop minitart starting.
  refreshApp().catch(() => {});

  // The jobs that ran, a year of them (D24).
  let history: History;
  try {
    history = openHistory(home.dir, options.note);
  } catch (error) {
    // A damaged file must not stop the jobs: they run, and are remembered until a restart.
    options.note(
      `Could not open history.db (${(error as Error).message}): jobs are kept in memory until it is moved aside`,
    );
    history = new MemoryHistory();
  }

  let health: Check[] = [];
  let checking = false;
  let newest: string | null = null;
  let latestVersion: string | null = null;
  let newestAt = 0;
  const check = async (): Promise<void> => {
    // One at a time: each check runs a few commands.
    if (checking) return;
    checking = true;
    try {
      // GitHub's newest runner version is asked for once a day.
      if (Date.now() - newestAt > 24 * 60 * 60_000) {
        latestVersion = await newestMinitart();
        newest = await newestRunner();
        newestAt = Date.now();
      }
      health = await runChecks({
        network,
        settings: running.settings(),
        images: await images(tart, running.settings()),
        hasApp: app !== null,
        runners: { have: builtRunners(home), latest: newest },
        versions: { running: VERSION, latest: latestVersion },
        tailnet: running.tailnet(),
        fromBrew: installKind(fileURLToPath(import.meta.url)).kind === 'brew',
      });
    } finally {
      checking = false;
    }
  };

  let memory: Memory | null = null;
  let readingFree = false;
  const readMemoryNow = async () => {
    // One at a time: a slow answer must not arrive after a newer one and replace it.
    if (readingFree) return;
    readingFree = true;
    try {
      memory = await readMemory();
    } finally {
      readingFree = false;
    }
  };

  return {
    tart,
    app: () => app,
    github: () => github,
    saveApp: (created) => {
      home.writeJson('app.json', created);
      app = created;
      github = connect(created);
      check().catch((error: unknown) => console.error(error));
    },
    settings: loadSettings(home, options.note),
    saveSettings: (settings) => {
      home.writeJson('settings.json', settings);
      // The health line follows a settings change without waiting a minute.
      check().catch((error: unknown) => console.error(error));
    },
    history,
    health: () => health,
    check,
    blocked: () => blockedBy(health, network),
    memory: () => memory,
    readMemory: readMemoryNow,
    charts: liveResources({
      cores: machine.cpus,
      memoryBytes: machine.memoryBytes,
      availableMb: () => memory?.availableMb ?? null,
      images: () => [running.settings().linux.image, running.settings().macos.image],
    }),
    vmLog: (vm, line) => home.appendLog(`${vm}.log`, line),
    vmLogFile: (name, maxBytes) => home.readLog(`${name}.log`, maxBytes),
    logs: () => home.logsUsage(),
    // Where the service writes: Homebrew's log folder, or the folder of `service install`.
    ownLogs: () =>
      [
        '/opt/homebrew/var/log/minitart.log',
        '/usr/local/var/log/minitart.log',
        home.path('logs', 'manager.log'),
      ].flatMap((path) => {
        try {
          return [{ path, bytes: statSync(path).size }];
        } catch {
          return [];
        }
      }),
    pruneLogs: (keep) => home.pruneLogs(KEPT_VM_LOGS, keep),
    greeting: () => (app ? null : 'open it on this Mac to create the GitHub App.'),
    stop: () => {},
  };
}

/**
 * The demo's made-up Mac (`--demo`): a GitHub and a Tart in memory, made-up jobs and charts.
 * Nothing of this Mac is read or written (but the tailnet names, which `start` reads), and it
 * has nothing to isolate, so nothing blocks.
 */
function demoMac(running: Started): Host {
  const demo = demoWorld(machine);
  return {
    tart: demo.tart,
    app: () => null,
    github: () => demo.github,
    saveApp: () => {},
    settings: demoSettings(machine),
    saveSettings: () => {},
    history: new MemoryHistory(demo.history, demo.samples),
    health: () => [],
    check: async () => {},
    blocked: () => null,
    memory: () => null,
    readMemory: async () => {},
    charts: demo.resources(running.vms),
    vmLogFile: () => null,
    logs: () => ({ files: 0, bytes: 0 }),
    ownLogs: () => [],
    pruneLogs: () => {},
    machineName: 'mac-mini.local',
    greeting: () => null,
    stop: () => demo.stop(),
  };
}

async function start(flags: { port: number; network: Network; demo: boolean }): Promise<void> {
  // What goes wrong before the manager exists is said once it does, so the dashboard shows it.
  const early: string[] = [];
  let say: ((text: string) => void) | null = null;
  const note = (text: string) => (say ? say(text) : early.push(text));
  let lastWarning = '';
  const warn = (text: string) => {
    // The same trouble every poll is said once.
    if (text === lastWarning) return;
    lastWarning = text;
    note(text);
  };
  let tailnet: TailnetName[] = [];
  // The manager is made with what the host has, and the host asks it back.
  const running: Started = {
    settings: () => manager.settings,
    vms: () => manager.snapshot().vms,
    tailnet: () => tailnet,
  };
  const host = flags.demo
    ? demoMac(running)
    : thisMac({ network: flags.network, running, warn, note });
  const { history, charts } = host;

  const stamp = (at: number) => new Date(at).toISOString();
  const pruneHistory = () => {
    try {
      history.prune(Date.now() - KEEP_MS);
      // The charts' minutes are kept forever, unless the owner set how many days.
      const days = manager.settings.keepChartsDays;
      if (days !== null) history.pruneSamples(Date.now() - days * 24 * 60 * 60_000);
    } catch (error) {
      console.error(error);
    }
  };
  const manager = new Manager({
    blocked: host.blocked,
    memory: host.memory,
    github: host.github,
    tart: host.tart,
    network: flags.network,
    settings: host.settings,
    saveSettings: host.saveSettings,
    history,
    ...(host.vmLog ? { vmLog: host.vmLog } : {}),
    log: (line: LogLine) =>
      console.log(`${stamp(line.at)} ${line.level === 'warn' ? 'WARN ' : ''}${line.text}`),
  });
  say = (text) => manager.warn(text);
  for (const text of early) say(text);

  // The tailnet names are read on their own, so nothing else that is slow can keep a name
  // that has just been published to the internet answered for longer.
  const readNames = async () => {
    tailnet = await readTailnet(flags.port);
  };
  await readNames();
  const everyHalfMinute = setInterval(() => void readNames(), 30_000);
  // What macOS has to spare is read as often as the queue is.
  await host.readMemory();
  const everyFewSeconds = setInterval(() => void host.readMemory(), 5000);
  // The hour before a restart, from the minutes kept, so the charts do not start empty.
  try {
    const now = Date.now();
    charts.seed?.(history.samples(now - 60 * 60_000, now).map(asPoint));
  } catch (error) {
    console.error(error);
  }
  // The charts' points every ten seconds (D23), and each minute of them kept, its average and
  // its peak, for the History view (D27).
  const minutes = new Minutes();
  const sampleCharts = () =>
    charts
      .sample()
      .then(() => {
        const newest = charts.view().points.at(-1);
        const minute = newest ? minutes.add(newest) : null;
        if (minute) history.addSample(minute);
      })
      .catch((error: unknown) => console.error(error));
  void sampleCharts();
  const everyTenSeconds = setInterval(() => void sampleCharts(), STEP_MS);
  await host.check();
  const prune = () => host.pruneLogs(new Set(manager.snapshot().vms.map((vm) => `${vm.name}.log`)));
  prune();
  pruneHistory();
  const everyMinute = setInterval(() => {
    // A check that throws is tried again in a minute; it must not stop the manager.
    host.check().catch((error: unknown) => console.error(error));
    prune();
    pruneHistory();
  }, 60_000);

  const server = createDashboardServer({
    manager,
    github: host.github,
    app: host.app,
    saveApp: host.saveApp,
    health: host.health,
    resources: () => charts.view(),
    history,
    vmLogFile: host.vmLogFile,
    ownLogs: host.ownLogs,
    logs: () => ({ ...host.logs(), kept: KEPT_VM_LOGS }),
    tailnet: () => tailnet,
    machine,
    ...(host.machineName === undefined ? {} : { machineName: host.machineName }),
    port: flags.port,
    dashboardDir: fileURLToPath(new URL('../dashboard/', import.meta.url)),
  });
  server.listen(flags.port, '127.0.0.1', () => {
    console.log(`minitart: the dashboard is at http://127.0.0.1:${flags.port}`);
    for (const name of tailnet) {
      if (name.refused === null) console.log(`minitart: and at ${name.origin} for your tailnet`);
    }
    if (flags.network === 'shared') {
      console.log('minitart: WARNING: --unsafe-shared-network lets jobs reach your LAN.');
    }
    const greeting = host.greeting();
    if (greeting) console.log(`minitart: ${greeting}`);
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log('minitart: stopping, and deleting every VM');
    clearInterval(everyMinute);
    clearInterval(everyHalfMinute);
    clearInterval(everyFewSeconds);
    clearInterval(everyTenSeconds);
    // The minute being gathered is kept as far as it went.
    try {
      const minute = minutes.flush();
      if (minute) history.addSample(minute);
    } catch (error) {
      console.error(error);
    }
    host.stop();
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
      fix: { type: 'boolean', default: false },
      now: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  const network: Network = values['unsafe-shared-network'] ? 'shared' : 'softnet';
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a port');

  if (values.version) {
    console.log(`minitart ${VERSION}`);
    return 0;
  }

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
    const check = async () =>
      runChecks({
        network,
        settings,
        images: await images(new TartCli(), settings),
        hasApp: loadApp(home) !== null,
        runners: { have: builtRunners(home), latest: await newestRunner() },
        versions: { running: VERSION, latest: await newestMinitart() },
        tailnet: await readTailnet(port),
        fromBrew: installKind(fileURLToPath(import.meta.url)).kind === 'brew',
      });
    // The Homebrew that installed minitart, not whichever comes first on the PATH.
    const install = installKind(fileURLToPath(import.meta.url));
    const brew = install.kind === 'brew' ? `${install.prefix}/bin/brew` : 'brew';
    const checks = values.fix
      ? await applyFixes(
          check,
          (argv) => runAttached(argv[0] === 'brew' ? [brew, ...argv.slice(1)] : argv),
          (line) => console.log(line),
        )
      : await check();
    return printChecks(checks) ? 0 : 1;
  }

  if (command === 'drain' || command === 'resume') {
    const running = new Running(port);
    if (!(await running.drain(command === 'drain'))) {
      throw new Error(`No minitart is answering on port ${port}`);
    }
    console.log(
      command === 'drain'
        ? 'Draining: the jobs that are running finish, and no new one starts. `minitart resume` undoes it.'
        : 'Resumed.',
    );
    return 0;
  }

  if (command === 'upgrade') {
    const install = installKind(fileURLToPath(import.meta.url));
    // How minitart is kept running here, and with which flags: the service's own, not this
    // command's defaults.
    const ownPlist = existsSync(plistPath()) ? readFileSync(plistPath(), 'utf8') : null;
    const brewService = BREW_SERVICE_LABELS.some(
      (label) =>
        spawnSync('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${label}`]).status === 0,
    );
    const service = ownPlist !== null ? 'own' : brewService ? 'brew' : 'none';
    const flags = ownPlist !== null ? serviceArgs(ownPlist) : [];
    const servicePort = Number(flags[flags.indexOf('--port') + 1]);
    const running = new Running(
      flags.includes('--port') && Number.isInteger(servicePort) ? servicePort : port,
    );
    if (values.now) {
      console.log('Not waiting for running jobs: they fail on GitHub and can be re-run.');
    } else if (await running.drained((line) => console.log(line))) {
      console.log('No job is running.');
    } else {
      console.log('No minitart is answering, so there is nothing to wait for.');
    }
    const steps = upgradeSteps(install, {
      node: process.execPath,
      service,
      serviceArgs: flags,
      // The menu bar app is in Homebrew's Caskroom when it was installed with it (D26).
      app: install.kind === 'brew' && existsSync(`${install.prefix}/Caskroom/minitart-app`),
    });
    for (const step of steps) {
      console.log(`${step.what}: ${step.command.join(' ')}`);
      const status = runAttached(step.command);
      if (status === 0) continue;
      if (step.optional) {
        console.log(`  (${status === null ? 'not found' : `exit ${status}`}; carrying on)`);
        continue;
      }
      // minitart is still draining, on purpose: nothing new starts on a half-done upgrade.
      throw new Error(
        `That step failed (${status === null ? 'the program was not found' : `exit ${status}`}). Put it right and run \`minitart upgrade\` again, or \`minitart resume\` to carry on with the version that is running.`,
      );
    }
    if (service === 'none') {
      console.log(
        'minitart is not run as a service here: start it again yourself, `minitart start`.',
      );
    }
    return 0;
  }

  if (command === 'image' && rest[0] === 'build') {
    const pool = rest[1];
    if (pool !== 'linux' && pool !== 'macos')
      throw new Error('Say which: minitart image build linux, or macos');
    const home = new Home();
    const settings = loadSettings(home);
    if (network === 'softnet' && !firewallInstalled()) {
      // The build boots a VM that runs the upstream image and the install script.
      console.warn(
        'minitart: the firewall rule is not installed, so the VM that builds the image can reach what this Mac serves to every network. `minitart doctor --fix` installs it.',
      );
    }
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
      host: {
        addresses: hostAddresses(),
        gateway: await defaultGateway(),
        listening: await listening(),
      },
      print: (line) => console.log(line),
    });
    const want = { reachable: 'reachable', blocked: 'blocked', closed: 'not open' };
    for (const result of results) {
      const verdict = result.ok ? '  ok ' : ' FAIL';
      console.log(`${verdict} ${result.what}: ${result.saw} (should be ${want[result.expect]})`);
    }
    if (results.some((result) => !result.ok && result.expect === 'closed')) {
      console.log(
        "A port open at the VM's gateway is a service on this Mac that listens on every network: a job can talk to it. Turn that service off, or have it listen on 127.0.0.1.",
      );
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
