// The manager: ask GitHub what is queued, start a VM for each job, delete the VM when its
// job ends. Everything it knows is in memory and rebuilt from GitHub and Tart on start; the
// only things it keeps on disk are the settings and the list of finished jobs.

import { randomBytes } from 'node:crypto';
import { GitHubError, type GitHub, type Job, type Repo } from './github/types.ts';
import { LABELS, plan, route, type Waiting } from './schedule.ts';
import { POOLS, type Pool, type Settings } from './settings.ts';
import type { Network, Tart } from './tart.ts';

/** Job VMs are `minitart-<kind>-<6 hex>`. Anything on this Mac with such a name is ours to delete. */
const VM_NAME = /^minitart-(linux|macos)-[0-9a-f]{6}$/;

export function isJobVm(name: string): boolean {
  return VM_NAME.test(name);
}

/**
 * What runs in the guest. The runner's single-use config arrives on standard input and goes
 * to the runner through its environment, so it is never an argument a job could list.
 */
export const RUN_SCRIPT = [
  'IFS= read -r JIT',
  'cd "$HOME/actions-runner" 2>/dev/null || { echo "minitart: this image has no ~/actions-runner; build it with: minitart image build"; exit 78; }',
  'export ACTIONS_RUNNER_INPUT_JITCONFIG="$JIT"',
  'unset JIT',
  'exec ./run.sh',
].join('\n');

/** A login shell, so the runner and its jobs get the image's PATH. */
export function guestShell(pool: Pool, script: string): string[] {
  return pool === 'macos' ? ['/bin/zsh', '-lc', script] : ['/bin/bash', '-lc', script];
}

export type VmStatus = 'cloning' | 'booting' | 'waiting' | 'running' | 'stopping';

export interface JobRef {
  id: number | null;
  name: string;
  workflow: string;
  url: string;
}

export interface VmView {
  name: string;
  repo: string;
  pool: Pool;
  status: VmStatus;
  createdAt: number;
  /** When the status last changed. */
  since: number;
  job: JobRef | null;
}

export interface QueuedView {
  id: number;
  repo: string;
  name: string;
  workflow: string;
  url: string;
  pool: Pool | null;
  createdAt: string;
  /** Why the job is still waiting, when minitart knows. */
  note: string | null;
}

export interface DoneView {
  vm: string;
  repo: string;
  pool: Pool;
  job: JobRef;
  /** `success`, `failure`, `cancelled`, or `lost` when the VM ended before its job did. */
  conclusion: string;
  startedAt: number;
  endedAt: number;
}

export interface RepoView {
  fullName: string;
  private: boolean;
  /** `watching`, or why it is not. */
  state: 'watching' | 'paused' | 'public';
  error: string | null;
}

export interface LogLine {
  at: number;
  level: 'info' | 'warn';
  text: string;
}

export interface Snapshot {
  now: number;
  network: Network;
  queued: QueuedView[];
  vms: VmView[];
  done: DoneView[];
  repos: RepoView[];
  settings: Settings;
  /** Which kinds have an image to clone. */
  images: Record<Pool, boolean>;
  log: LogLine[];
  /** GitHub's own reason for the last failed poll, if the last poll failed. */
  githubError: string | null;
}

interface Vm extends VmView {
  runnerId: number | null;
  /** What the runner itself said about how the job ended. */
  result: string | null;
  /** Set once minitart has decided to stop the VM. */
  stopReason: string | null;
  log: string[];
  logBytes: number;
  logFull: boolean;
  retiring: boolean;
  /** Whether the runner has connected to GitHub and is waiting for its job. */
  listening: boolean;
  /** `tart delete` failed, so a sweep has to find this VM again. */
  removeFailed: boolean;
  /** When a running VM's job was first missing from GitHub's unfinished runs. */
  missingSince: number | null;
}

export interface ManagerDeps {
  /** `null` until the GitHub App exists. */
  github: () => GitHub | null;
  tart: Tart;
  network: Network;
  settings: Settings;
  saveSettings: (settings: Settings) => void;
  history: DoneView[];
  saveHistory: (history: DoneView[]) => void;
  /** Receives every line a VM prints, for the log files. */
  vmLog?: (vm: string, line: string) => void;
  log?: (line: LogLine) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const HISTORY_LIMIT = 200;
const LOG_LIMIT = 300;
const VM_LOG_LIMIT = 2000;
const BOOT_TIMEOUT_MS: Record<Pool, number> = { linux: 120_000, macos: 300_000 };
/** Past GitHub's own six-hour job limit, a VM is stuck. */
const VM_LIFETIME_MS = 7 * 60 * 60_000;
/** A VM's output is kept up to this size, in memory and on disk. */
const VM_LOG_BYTES = 4 * 1024 * 1024;
/** The two lines the runner prints about its job, each a whole line after its timestamp. */
const STAMP = String.raw`(?:\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ: )?`;
const RUNNER_STARTED = new RegExp(`^${STAMP}Running job: (.+)$`);
const RUNNER_LISTENING = new RegExp(`^${STAMP}Listening for Jobs$`);
/** A runner that has not reached GitHub by now will not. */
const CONNECT_TIMEOUT_MS = 3 * 60_000;
/** A VM still up this long after GitHub called its job done is stuck. */
const LINGER_MS = 5 * 60_000;
const RUNNER_ENDED = new RegExp(
  `^${STAMP}Job .+ completed with result: (Succeeded|Failed|Canceled)$`,
);
const RESULTS: Record<string, string> = {
  Succeeded: 'success',
  Failed: 'failure',
  Canceled: 'cancelled',
};

export class Manager {
  readonly #deps: ManagerDeps;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #vms = new Map<string, Vm>();
  readonly #lifecycles = new Set<Promise<void>>();
  readonly #listeners = new Set<() => void>();
  /** Logs of VMs that are gone, newest last. */
  readonly #pastLogs = new Map<string, string[]>();
  readonly #jobs = new Map<string, Job[]>();
  /** Runs seen lately per repo, to find the job of a VM that ended between two polls. */
  readonly #recentRuns = new Map<string, Map<number, number>>();
  readonly #repoErrors = new Map<string, string>();
  readonly #log: LogLine[] = [];
  #settings: Settings;
  #history: DoneView[];
  #repos: Repo[] = [];
  #reposAt = 0;
  #images: Record<Pool, boolean> = { linux: false, macos: false };
  #imagesAt = 0;
  #githubError: string | null = null;
  #backoffUntil = 0;
  #tickFailed = false;
  /** Set when a VM could not be deleted, so the next round looks for it again. */
  #sweepAt = Number.POSITIVE_INFINITY;
  /** Starts that failed in a row, per kind, and when the kind may try again. */
  readonly #startFailures: Record<Pool, number> = { linux: 0, macos: 0 };
  readonly #startAfter: Record<Pool, number> = { linux: 0, macos: 0 };
  #timer: NodeJS.Timeout | null = null;
  #stopping = false;

  constructor(deps: ManagerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#settings = deps.settings;
    this.#history = deps.history.slice(-HISTORY_LIMIT);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Deletes the job VMs a previous run left behind, then polls until `stop()`. */
  async start(): Promise<void> {
    await this.removeOrphans();
    const loop = async () => {
      await this.tick();
      if (!this.#stopping) {
        this.#timer = setTimeout(() => void loop(), this.#settings.pollSeconds * 1000);
      }
    };
    await loop();
  }

  /** Stops every VM. A job that was running fails on GitHub as "runner lost". */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    for (const vm of this.#vms.values()) this.#stopVm(vm, 'minitart is shutting down');
    await Promise.allSettled([...this.#lifecycles]);
  }

  /** Deletes job VMs the manager does not know. Resolves with whether every one went. */
  async removeOrphans(): Promise<boolean> {
    let vms;
    try {
      vms = await this.#deps.tart.list();
    } catch (error) {
      this.#say('warn', `Could not list VMs: ${message(error)}`);
      return false;
    }
    let clean = true;
    for (const vm of vms) {
      if (vm.source !== 'local' || !isJobVm(vm.name) || this.#vms.has(vm.name)) continue;
      this.#say('info', `Removing ${vm.name}, left over from an earlier run`);
      if (vm.running) await this.#deps.tart.stop(vm.name).catch(() => {});
      await this.#deps.tart.remove(vm.name).catch((error: unknown) => {
        clean = false;
        this.#say('warn', `Could not remove ${vm.name}: ${message(error)}`);
      });
    }
    return clean;
  }

  /** One round: read the queue, start VMs for it, stop the VMs nothing needs. */
  async tick(): Promise<void> {
    const github = this.#deps.github();
    if (!github || this.#stopping) return;
    const now = this.#now();
    if (now < this.#backoffUntil) return;

    this.#tickFailed = false;
    if (now >= this.#sweepAt) {
      // Only after a VM could not be deleted: listing VMs is not free (tart.ts).
      this.#sweepAt = Number.POSITIVE_INFINITY;
      // A sweep that left something behind is tried again in a minute.
      if (!(await this.removeOrphans())) this.#sweepAt = Math.min(this.#sweepAt, now + 60_000);
    }
    await this.#refreshImages(now);
    try {
      if (now - this.#reposAt >= 60_000 || this.#repos.length === 0) {
        this.#repos = await github.repos();
        this.#reposAt = now;
      }
    } catch (error) {
      this.#githubFailed(error);
      this.#changed();
      return;
    }

    const watched = this.#repos.filter((repo) => this.#repoState(repo) === 'watching');
    const names = new Set(watched.map((repo) => repo.fullName));
    for (const repo of [...this.#jobs.keys()]) if (!names.has(repo)) this.#jobs.delete(repo);
    for (const repo of [...this.#repoErrors.keys()]) {
      if (!names.has(repo)) this.#repoErrors.delete(repo);
    }
    await Promise.all(watched.map((repo) => this.#readRepo(github, repo.fullName, now)));

    const jobs = [...this.#jobs.values()].flat();
    for (const job of jobs) {
      const vm = job.runnerName ? this.#vms.get(job.runnerName) : undefined;
      if (!vm || vm.repo !== job.repo) continue;
      vm.job = { id: job.id, name: job.name, workflow: job.workflow, url: job.url };
      if (job.status === 'in_progress' && vm.status === 'waiting') this.#setStatus(vm, 'running');
      if (
        job.status === 'completed' &&
        job.completedAt !== null &&
        now - Date.parse(job.completedAt) > LINGER_MS
      ) {
        this.#stopVm(vm, 'its job ended and its runner did not exit');
      }
    }
    // A job whose whole run has finished is no longer in the list at all: a VM still
    // running one that GitHub has not shown for a while is stuck the same way.
    const serving = new Set(jobs.map((job) => job.runnerName));
    for (const vm of this.#vms.values()) {
      if (vm.status !== 'running' || serving.has(vm.name) || this.#repoErrors.has(vm.repo)) {
        vm.missingSince = null;
      } else if (vm.missingSince === null) {
        vm.missingSince = now;
      } else if (now - vm.missingSince > LINGER_MS) {
        this.#stopVm(vm, 'its job ended and its runner did not exit');
      }
    }

    if (!this.#stopping) {
      const limits = this.#limits();
      for (const launch of plan(this.#waiting(jobs), this.#slots(), limits)) {
        this.#launch(github, launch.repo, launch.pool);
      }
    }
    this.#reap(github, jobs, now);
    if (!this.#tickFailed) this.#githubError = null;
    this.#changed();
  }

  snapshot(): Snapshot {
    const jobs = [...this.#jobs.values()].flat();
    const limits = this.#limits();
    const queued: QueuedView[] = [];
    for (const job of jobs) {
      if (job.status !== 'queued') continue;
      const pool = route(job.labels);
      if (pool === null) continue;
      let note: string | null = null;
      if (pool === 'unsatisfiable') {
        note = `No minitart runner has all of: ${job.labels.join(', ')}`;
      } else if (!this.#images[pool]) {
        note = `No ${pool} image yet: minitart image build ${pool}`;
      } else if (this.#now() < this.#startAfter[pool]) {
        const seconds = Math.ceil((this.#startAfter[pool] - this.#now()) / 1000);
        note = `The last ${pool} VM failed to start; trying again in ${seconds}s`;
      } else if (limits[pool] === 0) {
        note = `${pool} VMs are turned off`;
      }
      queued.push({
        id: job.id,
        repo: job.repo,
        name: job.name,
        workflow: job.workflow,
        url: job.url,
        pool: pool === 'unsatisfiable' ? null : pool,
        createdAt: job.createdAt,
        note,
      });
    }
    queued.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    return {
      now: this.#now(),
      network: this.#deps.network,
      queued,
      vms: [...this.#vms.values()].map(view).sort((a, b) => a.createdAt - b.createdAt),
      done: [...this.#history].reverse(),
      repos: this.#repos.map((repo) => ({
        fullName: repo.fullName,
        private: repo.private,
        state: this.#repoState(repo),
        error: this.#repoErrors.get(repo.fullName) ?? null,
      })),
      settings: this.#settings,
      images: { ...this.#images },
      log: [...this.#log],
      githubError: this.#githubError,
    };
  }

  /** What a VM printed: a live one, or one of the last few that ended. */
  vmLog(name: string): string[] | null {
    return this.#vms.get(name)?.log ?? this.#pastLogs.get(name) ?? null;
  }

  /** The repo of a job minitart ran, if `jobId` is one. Guards the job log endpoint. */
  repoOfJob(jobId: number): string | null {
    for (const vm of this.#vms.values()) if (vm.job?.id === jobId) return vm.repo;
    return this.#history.find((done) => done.job.id === jobId)?.repo ?? null;
  }

  updateSettings(next: Settings): void {
    this.#settings = next;
    this.#deps.saveSettings(next);
    this.#imagesAt = 0;
    this.#say('info', 'Settings changed');
    this.#changed();
  }

  get settings(): Settings {
    return this.#settings;
  }

  #repoState(repo: Repo): RepoView['state'] {
    if (!repo.private && !this.#settings.allowPublicRepos) return 'public';
    return this.#settings.pausedRepos.includes(repo.fullName) ? 'paused' : 'watching';
  }

  #limits(): Record<Pool, number> {
    const now = this.#now();
    const limit = (pool: Pool) =>
      this.#images[pool] && now >= this.#startAfter[pool] ? this.#settings[pool].max : 0;
    return { linux: limit('linux'), macos: limit('macos') };
  }

  #waiting(jobs: readonly Job[]): Waiting[] {
    const waiting: Waiting[] = [];
    for (const job of jobs) {
      if (job.status !== 'queued') continue;
      const pool = route(job.labels);
      if (pool === 'linux' || pool === 'macos') {
        waiting.push({ id: job.id, repo: job.repo, pool, createdAt: job.createdAt });
      }
    }
    return waiting;
  }

  #slots(): { repo: string; pool: Pool; busy: boolean }[] {
    return [...this.#vms.values()].map((vm) => ({
      repo: vm.repo,
      pool: vm.pool,
      // A VM on its way out covers no job, but still holds its slot.
      busy: vm.status === 'running' || vm.status === 'stopping' || vm.stopReason !== null,
    }));
  }

  async #refreshImages(now: number): Promise<void> {
    if (now - this.#imagesAt < 60_000 && this.#imagesAt !== 0) return;
    try {
      for (const pool of POOLS) {
        this.#images[pool] = await this.#deps.tart.has(this.#settings[pool].image);
      }
      this.#imagesAt = now;
    } catch (error) {
      this.#say('warn', `Could not look for the images: ${message(error)}`);
    }
  }

  async #readRepo(github: GitHub, repo: string, now: number): Promise<void> {
    try {
      const runs = await github.activeRuns(repo);
      const recent = this.#recentRuns.get(repo) ?? new Map<number, number>();
      this.#recentRuns.set(repo, recent);
      for (const run of runs) recent.set(run, now);
      for (const [run, seen] of recent) if (now - seen > 15 * 60_000) recent.delete(run);
      const jobs = await Promise.all(runs.map((run) => github.jobs(repo, run)));
      this.#jobs.set(repo, jobs.flat());
      this.#repoErrors.delete(repo);
    } catch (error) {
      // The repo keeps the jobs it had: one failed request must not look like an empty queue.
      this.#repoErrors.set(repo, message(error));
      this.#githubFailed(error);
    }
  }

  #githubFailed(error: unknown): void {
    const text = message(error);
    this.#tickFailed = true;
    if (text !== this.#githubError) this.#say('warn', `GitHub: ${text}`);
    this.#githubError = text;
    if (error instanceof GitHubError && error.retryAt !== null) {
      this.#backoffUntil = Math.max(this.#backoffUntil, error.retryAt);
    }
  }

  #launch(github: GitHub, repo: string, pool: Pool): void {
    const now = this.#now();
    const vm: Vm = {
      name: `minitart-${pool}-${randomBytes(3).toString('hex')}`,
      repo,
      pool,
      status: 'cloning',
      createdAt: now,
      since: now,
      job: null,
      runnerId: null,
      result: null,
      stopReason: null,
      log: [],
      logBytes: 0,
      logFull: false,
      retiring: false,
      listening: false,
      removeFailed: false,
      missingSince: null,
    };
    this.#vms.set(vm.name, vm);
    this.#say('info', `${vm.name}: starting for ${repo}`);
    const lifecycle = this.#lifecycle(github, vm)
      .catch((error: unknown) => {
        // A lifecycle that throws must not take the manager, and every other job, with it.
        this.#vms.delete(vm.name);
        this.#sweepAt = 0;
        this.#say('warn', `${vm.name}: ${message(error)}`);
      })
      .finally(() => {
        this.#lifecycles.delete(lifecycle);
      });
    this.#lifecycles.add(lifecycle);
  }

  async #lifecycle(github: GitHub, vm: Vm): Promise<void> {
    const { tart } = this.#deps;
    const print = (line: string) => this.#vmPrinted(vm, line);
    let cloned = false;
    try {
      await tart.clone(this.#settings[vm.pool].image, vm.name);
      cloned = true;
      await tart.configure(vm.name, this.#settings.vm);
      if (vm.stopReason !== null) return;

      this.#setStatus(vm, 'booting');
      let exited = false;
      // What `tart run` said last is the reason, when a VM stops instead of booting: no
      // Softnet, or a third macOS VM, which Apple's hypervisor refuses.
      let said = '';
      const bootPrint = (line: string) => {
        if (line.trim() !== '') said = line.trim();
        print(line);
      };
      void tart.boot(vm.name, this.#deps.network, bootPrint).then(() => {
        exited = true;
      });
      await this.#untilReady(vm, () => (exited ? said || 'no reason given' : null));
      if (vm.stopReason !== null) return;

      const runner = await github.registerRunner(vm.repo, vm.name, [...LABELS[vm.pool]]);
      vm.runnerId = runner.runnerId;
      this.#setStatus(vm, 'waiting');
      const code = await tart.exec(vm.name, guestShell(vm.pool, RUN_SCRIPT), {
        stdin: `${runner.jitConfig}\n`,
        onLine: print,
      });
      if (vm.stopReason === null && vm.result === null) {
        print(`minitart: the runner exited with code ${code} before finishing a job`);
      }
    } catch (error) {
      if (vm.stopReason === null) {
        print(`minitart: ${message(error)}`);
        this.#say('warn', `${vm.name}: ${message(error)}`);
        if (vm.runnerId === null) this.#startFailed(vm.pool);
      }
    } finally {
      this.#setStatus(vm, 'stopping');
      if (cloned) {
        await tart.stop(vm.name).catch(() => {});
        await tart.remove(vm.name).catch((error: unknown) => {
          this.#say('warn', `Could not remove ${vm.name}: ${message(error)}; trying again`);
          vm.removeFailed = true;
        });
      }
      await this.#finish(github, vm);
    }
  }

  /** A kind whose VMs do not start waits longer after each failure, up to five minutes. */
  #startFailed(pool: Pool): void {
    const failures = ++this.#startFailures[pool];
    const wait = Math.min(5 * 60_000, 5000 * 2 ** (failures - 1));
    this.#startAfter[pool] = this.#now() + wait;
  }

  async #untilReady(vm: Vm, exited: () => string | null): Promise<void> {
    const deadline = this.#now() + BOOT_TIMEOUT_MS[vm.pool];
    while (vm.stopReason === null) {
      if ((await this.#deps.tart.exec(vm.name, ['true'], { timeoutMs: 10_000 })) === 0) return;
      const reason = exited();
      if (reason !== null) throw new Error(`the VM stopped while booting: ${reason}`);
      if (this.#now() > deadline) throw new Error('the VM did not come up in time');
      await this.#sleep(1000);
    }
  }

  #vmPrinted(vm: Vm, line: string): void {
    // A job is root in its VM and can make the runner print anything, at any rate: what is
    // kept is bounded, and what it says is a hint that GitHub's own answer overrides.
    vm.logBytes += line.length + 1;
    if (vm.logBytes > VM_LOG_BYTES) {
      if (!vm.logFull) {
        vm.logFull = true;
        const note = 'minitart: this VM printed too much; the rest is not kept';
        vm.log.push(note);
        this.#deps.vmLog?.(vm.name, note);
      }
      return;
    }
    vm.log.push(line);
    if (vm.log.length > VM_LOG_LIMIT) vm.log.splice(0, vm.log.length - VM_LOG_LIMIT);
    this.#deps.vmLog?.(vm.name, line);
    // The runner says when it takes its job and how the job ended, sooner than a poll would.
    const started = RUNNER_STARTED.exec(line);
    if (started?.[1] !== undefined) {
      vm.job ??= { id: null, name: started[1], workflow: '', url: '' };
      if (vm.status === 'waiting') this.#setStatus(vm, 'running');
    }
    if (RUNNER_LISTENING.test(line)) {
      vm.listening = true;
      // Booted, registered and connected: this kind of VM starts.
      this.#startFailures[vm.pool] = 0;
    }
    const ended = RUNNER_ENDED.exec(line);
    if (ended?.[1] !== undefined) vm.result = RESULTS[ended[1]] ?? null;
    this.#changed();
  }

  async #finish(github: GitHub, vm: Vm): Promise<void> {
    const ranJob = vm.job !== null || vm.result !== null;
    if (vm.runnerId !== null && !ranJob) {
      // A runner that never got a job is still registered. One that ran removed itself.
      await github.removeRunner(vm.repo, vm.runnerId).catch((error: unknown) => {
        this.#say('warn', `Could not remove the runner of ${vm.name}: ${message(error)}`);
      });
    }
    if (ranJob) {
      const job = await this.#findJob(github, vm);
      const ref = job
        ? { id: job.id, name: job.name, workflow: job.workflow, url: job.url }
        : (vm.job ?? { id: null, name: 'unknown job', workflow: '', url: '' });
      // GitHub's word for how the job ended; the runner's own only until GitHub has one.
      const conclusion = job?.conclusion ?? vm.result ?? 'lost';
      this.#history.push({
        vm: vm.name,
        repo: vm.repo,
        pool: vm.pool,
        job: ref,
        conclusion,
        startedAt: vm.createdAt,
        endedAt: this.#now(),
      });
      this.#history = this.#history.slice(-HISTORY_LIMIT);
      try {
        this.#deps.saveHistory(this.#history);
      } catch (error) {
        this.#say('warn', `Could not save the history: ${message(error)}`);
      }
      this.#say('info', `${vm.name}: ${ref.name} ended: ${conclusion}`);
    } else {
      this.#say('info', `${vm.name}: removed (${vm.stopReason ?? 'it never got a job'})`);
    }
    this.#vms.delete(vm.name);
    // Only now: a sweep skips the VMs the manager still knows.
    if (vm.removeFailed) this.#sweepAt = 0;
    this.#pastLogs.set(vm.name, vm.log);
    for (const name of [...this.#pastLogs.keys()].slice(0, -30)) this.#pastLogs.delete(name);
    this.#changed();
  }

  /** The job this VM's runner took, by asking the runs seen lately for it. */
  async #findJob(github: GitHub, vm: Vm): Promise<Job | null> {
    for (const run of this.#recentRuns.get(vm.repo)?.keys() ?? []) {
      try {
        const job = (await github.jobs(vm.repo, run)).find((j) => j.runnerName === vm.name);
        if (job) return job;
      } catch {
        // The VM's own account of the job is kept instead.
      }
    }
    return null;
  }

  #reap(github: GitHub, jobs: readonly Job[], now: number): void {
    const wanted = new Set(this.#waiting(jobs).map((job) => `${job.pool} ${job.repo}`));
    const watching = new Set(
      this.#repos.filter((r) => this.#repoState(r) === 'watching').map((r) => r.fullName),
    );
    for (const vm of this.#vms.values()) {
      if (vm.stopReason !== null) continue;
      if (now - vm.createdAt > VM_LIFETIME_MS) {
        this.#stopVm(vm, 'it outlived the longest job GitHub allows');
      } else if (vm.status !== 'running' && !watching.has(vm.repo)) {
        this.#stopVm(vm, `${vm.repo} is no longer watched`);
      } else if (vm.status === 'waiting' && !vm.listening && now - vm.since > CONNECT_TIMEOUT_MS) {
        // Usually the network: no DNS in the guest, or a VPN on the Mac with a small MTU.
        this.#say('warn', `${vm.name}: its runner never reached GitHub`);
        this.#startFailed(vm.pool);
        this.#stopVm(vm, 'its runner never reached GitHub');
      } else if (
        vm.status === 'waiting' &&
        now - vm.since > this.#settings.idleSeconds * 1000 &&
        !wanted.has(`${vm.pool} ${vm.repo}`)
      ) {
        void this.#retire(github, vm);
      }
    }
  }

  /**
   * Stops a VM no job came for. Its runner is removed from GitHub first, and the VM is
   * stopped only once that worked: GitHub refuses to remove a runner that is running a
   * job, and then the VM is left to run it.
   */
  async #retire(github: GitHub, vm: Vm): Promise<void> {
    if (vm.retiring) return;
    vm.retiring = true;
    try {
      if (vm.runnerId !== null) await github.removeRunner(vm.repo, vm.runnerId);
      vm.runnerId = null;
      if (vm.status === 'waiting') this.#stopVm(vm, 'no job came for it');
    } catch {
      // Still wanted, or GitHub is unreachable: the next round decides again.
    } finally {
      vm.retiring = false;
    }
  }

  #stopVm(vm: Vm, reason: string): void {
    if (vm.stopReason !== null) return;
    vm.stopReason = reason;
    // Stopping the VM ends the command running in it, and the lifecycle cleans up.
    if (vm.status !== 'cloning') void this.#deps.tart.stop(vm.name).catch(() => {});
  }

  #setStatus(vm: Vm, status: VmStatus): void {
    vm.status = status;
    vm.since = this.#now();
    this.#changed();
  }

  #say(level: LogLine['level'], text: string): void {
    const line = { at: this.#now(), level, text };
    this.#log.push(line);
    if (this.#log.length > LOG_LIMIT) this.#log.splice(0, this.#log.length - LOG_LIMIT);
    this.#deps.log?.(line);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

function view(vm: Vm): VmView {
  return {
    name: vm.name,
    repo: vm.repo,
    pool: vm.pool,
    status: vm.status,
    createdAt: vm.createdAt,
    since: vm.since,
    job: vm.job,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
