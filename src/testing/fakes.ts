// A GitHub and a Tart that live in memory. The tests drive them by hand; the demo
// (demo.ts) drives them on a timer so the dashboard has something to show.

import type { GitHub, Job, Repo } from '../github/types.ts';
import type { ExecOptions, Network, Tart, TartVm } from '../tart.ts';

export class FakeGitHub implements GitHub {
  repoList: Repo[] = [];
  /** Thrown by every call while set. */
  failure: Error | null = null;
  readonly runners = new Map<number, { repo: string; name: string; labels: string[] }>();
  readonly removed: number[] = [];
  readonly logs = new Map<number, string>();
  readonly #runs = new Map<string, Map<number, Job[]>>();
  #nextId = 1000;
  #clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  /** A new workflow run with one queued job. */
  queue(repo: string, labels: string[], name = 'build', workflow = 'CI'): Job {
    const runId = this.#nextId++;
    const id = this.#nextId++;
    const job: Job = {
      id,
      runId,
      repo,
      name,
      workflow,
      labels,
      status: 'queued',
      conclusion: null,
      runnerName: null,
      url: `https://github.com/${repo}/actions/runs/${runId}/job/${id}`,
      createdAt: new Date(this.#clock()).toISOString(),
      startedAt: null,
      completedAt: null,
    };
    const runs = this.#runs.get(repo) ?? new Map<number, Job[]>();
    this.#runs.set(repo, runs);
    runs.set(runId, [job]);
    return job;
  }

  /** What a runner does on connecting: takes the oldest queued job its labels satisfy. */
  take(runnerName: string): Job | null {
    const runner = [...this.runners.values()].find((r) => r.name === runnerName);
    if (!runner) return null;
    const labels = runner.labels.map((label) => label.toLowerCase());
    for (const jobs of this.#runs.get(runner.repo)?.values() ?? []) {
      for (const job of jobs) {
        if (job.status !== 'queued') continue;
        if (!job.labels.every((label) => labels.includes(label.toLowerCase()))) continue;
        job.status = 'in_progress';
        job.runnerName = runnerName;
        job.startedAt = new Date(this.#clock()).toISOString();
        return job;
      }
    }
    return null;
  }

  /** Files a job under its `runId`, next to that run's other jobs. */
  adopt(job: Job): void {
    for (const jobs of this.#runs.get(job.repo)?.values() ?? []) {
      const index = jobs.indexOf(job);
      if (index !== -1) jobs.splice(index, 1);
    }
    this.#runs.get(job.repo)?.get(job.runId)?.push(job);
  }

  complete(job: Job, conclusion = 'success'): void {
    job.status = 'completed';
    job.conclusion = conclusion;
    job.completedAt = new Date(this.#clock()).toISOString();
    // A runner that ran its job removes itself.
    for (const [id, runner] of this.runners)
      if (runner.name === job.runnerName) this.runners.delete(id);
  }

  async repos(): Promise<Repo[]> {
    this.#check();
    return this.repoList;
  }

  async activeRuns(repo: string): Promise<number[]> {
    this.#check();
    const active: number[] = [];
    for (const [runId, jobs] of this.#runs.get(repo) ?? []) {
      if (jobs.some((job) => job.status !== 'completed')) active.push(runId);
    }
    return active;
  }

  async jobs(repo: string, runId: number): Promise<Job[]> {
    this.#check();
    return (this.#runs.get(repo)?.get(runId) ?? []).map((job) => ({ ...job }));
  }

  async registerRunner(repo: string, name: string, labels: string[]) {
    this.#check();
    const runnerId = this.#nextId++;
    this.runners.set(runnerId, { repo, name, labels });
    return { runnerId, jitConfig: `jit-${runnerId}` };
  }

  async removeRunner(_repo: string, runnerId: number): Promise<void> {
    this.#check();
    this.runners.delete(runnerId);
    this.removed.push(runnerId);
  }

  async jobLog(_repo: string, jobId: number): Promise<string> {
    this.#check();
    return this.logs.get(jobId) ?? '';
  }

  #check(): void {
    if (this.failure) throw this.failure;
  }
}

interface FakeVm {
  running: boolean;
  source: string;
  halt: (() => void) | null;
  /** The runner command, while it runs. */
  run: { print: (line: string) => void; exit: (code: number) => void; stdin: string } | null;
}

export class FakeTart implements Tart {
  readonly vms = new Map<string, FakeVm>();
  /** Every `boot` call's network. */
  readonly networks: Network[] = [];
  /** Every command run in a guest, as `[vm, ...argv]`. */
  readonly commands: string[][] = [];
  /** Called when the runner command starts in a VM. */
  onRun: ((name: string) => void) | null = null;
  readonly resized: [name: string, diskGb: number][] = [];
  /** How many times `list` was called. */
  lists = 0;
  /** Whether a started runner reaches GitHub and says so. */
  runnerConnects = true;
  /** What `tart run` prints before a VM that fails to start exits. */
  bootFailure: string | null = null;
  /** While set, the guest agent of a booted VM does not answer. */
  agentDown = false;

  addImage(name: string): void {
    this.vms.set(name, { running: false, source: 'local', halt: null, run: null });
  }

  /** Names of the VMs whose runner command is running. */
  runners(): string[] {
    return [...this.vms].filter(([, vm]) => vm.run !== null).map(([name]) => name);
  }

  stdin(name: string): string | undefined {
    return this.vms.get(name)?.run?.stdin;
  }

  print(name: string, line: string): void {
    this.vms.get(name)?.run?.print(line);
  }

  exit(name: string, code = 0): void {
    const vm = this.vms.get(name);
    const run = vm?.run;
    if (!vm || !run) return;
    vm.run = null;
    run.exit(code);
  }

  async list(): Promise<TartVm[]> {
    this.lists++;
    return [...this.vms].map(([name, vm]) => ({ name, running: vm.running, source: vm.source }));
  }

  async has(name: string): Promise<boolean> {
    return this.vms.has(name);
  }

  async resize(name: string, diskGb: number): Promise<void> {
    this.#vm(name);
    this.resized.push([name, diskGb]);
  }

  async pull(source: string): Promise<void> {
    this.addImage(source);
  }

  async rename(from: string, to: string): Promise<void> {
    const vm = this.#vm(from);
    this.vms.delete(from);
    this.vms.set(to, vm);
  }

  async clone(source: string, name: string): Promise<void> {
    if (!this.vms.has(source)) throw new Error(`tart clone: no such image ${source}`);
    this.vms.set(name, { running: false, source: 'local', halt: null, run: null });
  }

  async configure(): Promise<void> {}

  boot(name: string, network: Network, onLine: (line: string) => void): Promise<void> {
    const vm = this.#vm(name);
    this.networks.push(network);
    if (this.bootFailure !== null) {
      onLine(this.bootFailure);
      return Promise.resolve();
    }
    vm.running = true;
    return new Promise((resolve) => {
      vm.halt = resolve;
    });
  }

  exec(name: string, command: readonly string[], options: ExecOptions = {}): Promise<number> {
    const vm = this.vms.get(name);
    if (!vm?.running || this.agentDown) return Promise.resolve(1);
    this.commands.push([name, ...command]);
    if (options.stdin === undefined) return Promise.resolve(0);
    return new Promise((resolve) => {
      vm.run = { print: options.onLine ?? (() => {}), exit: resolve, stdin: options.stdin ?? '' };
      if (this.runnerConnects) vm.run.print('2026-11-18 10:00:00Z: Listening for Jobs');
      this.onRun?.(name);
    });
  }

  async stop(name: string): Promise<void> {
    const vm = this.vms.get(name);
    if (!vm) throw new Error(`tart stop: no such VM ${name}`);
    vm.running = false;
    vm.halt?.();
    vm.halt = null;
    this.exit(name, 137);
  }

  async remove(name: string): Promise<void> {
    if (!this.vms.delete(name)) throw new Error(`tart delete: no such VM ${name}`);
  }

  #vm(name: string): FakeVm {
    const vm = this.vms.get(name);
    if (!vm) throw new Error(`no such VM ${name}`);
    return vm;
  }
}
