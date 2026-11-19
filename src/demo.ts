// `minitart start --demo`: the dashboard with a made-up GitHub and made-up VMs, for looking
// at it without a GitHub App or a VM. Nothing here touches the network or Tart.

import type { DoneView, VmView } from './manager.ts';
import { POINTS, STEP_MS, type ResourcePoint, type ResourcesView } from './resources.ts';
import type { Machine } from './settings.ts';
import type { Job } from './github/types.ts';
import { FakeGitHub, FakeTart } from './testing/fakes.ts';

const REPOS = ['octo/app', 'octo/api', 'octo/site'];
/** Who the made-up jobs run for: people, and a bot that opens pull requests. */
const ACTORS = ['mona', 'mona', 'hubot', 'dependabot[bot]'];
const WORK: [repo: string, label: string, workflow: string, job: string, seconds: number][] = [
  ['octo/app', 'minitart-macos', 'CI', 'test (iOS 26)', 340],
  ['octo/api', 'minitart-linux', 'CI', 'test', 140],
  ['octo/api', 'minitart-linux', 'CI', 'e2e (postgres)', 260],
  ['octo/app', 'minitart-macos', 'TestFlight', 'archive and upload', 480],
  ['octo/site', 'minitart-linux', 'CI', 'static', 90],
  ['octo/app', 'minitart-linux', 'CI', 'lint', 80],
  ['octo/api', 'minitart-linux', 'Release', 'build image', 220],
];

/**
 * The hour before the demo started: three pushes, each a burst of jobs. Minutes ago that
 * the VM was cloned, took its job and ended.
 */
const PAST: [work: number, cloned: number, took: number, ended: number][] = [
  [0, 58, 56.6, 47],
  [1, 58, 57.4, 54.8],
  [2, 58, 57.3, 52.9],
  [5, 57.5, 56.9, 55.4],
  [3, 46.5, 45.1, 37],
  [1, 34, 33.4, 31],
  [2, 34, 33.3, 29.4],
  [6, 33.8, 33.2, 29.9],
  [0, 33.5, 32.1, 24.2],
  [4, 21, 20.4, 18.9],
  [5, 12, 11.4, 10.1],
];
const STEPS = [
  'Set up job',
  'Run actions/checkout',
  'Run pnpm install --frozen-lockfile',
  'Run pnpm typecheck',
  'Run pnpm test',
  'Post Run actions/checkout',
  'Complete job',
];

export interface DemoResources {
  view(): ResourcesView;
  /** Adds a point for the VMs running now. */
  sample(): Promise<void>;
}

export function demoWorld(machine: Machine): {
  github: FakeGitHub;
  tart: FakeTart;
  history: DoneView[];
  resources: (vms: () => VmView[]) => DemoResources;
  stop: () => void;
} {
  const github = new FakeGitHub();
  github.repoList = [
    ...REPOS.map((fullName) => ({ fullName, private: true })),
    { fullName: 'octo/dotfiles', private: false },
    // Installed on, and not turned on: what a repo looks like before the owner serves it.
    { fullName: 'octo/notes', private: true },
  ];
  const tart = new FakeTart();
  tart.addImage('minitart-base-linux');
  tart.addImage('minitart-base-macos');
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };

  // A made-up runner: takes its job, prints for a while, ends.
  tart.onRun = (name) => {
    tart.print(name, '√ Connected to GitHub');
    tart.print(name, 'Current runner version: 2.338.2');
    later(1500, () => {
      const job = github.take(name);
      if (!job) return;
      const seconds = WORK.find((work) => work[3] === job.name)?.[4] ?? 15;
      const failed = job.name === 'e2e (postgres)' && Math.random() < 0.4;
      tart.print(name, `Running job: ${job.name}`);
      STEPS.forEach((step, index) => {
        later(((index + 1) * seconds * 1000) / (STEPS.length + 1), () => tart.print(name, step));
      });
      later(seconds * 1000, () => {
        const result = failed ? 'Failed' : 'Succeeded';
        tart.print(name, `Job ${job.name} completed with result: ${result}`);
        github.logs.set(job.id, STEPS.map((step) => `##[group]${step}\n##[endgroup]`).join('\n'));
        github.complete(job, failed ? 'failure' : 'success');
        tart.exit(name, 0);
      });
    });
  };

  let next = 0;
  let queued: Job[] = [];
  const queueOne = () => {
    const work = WORK[next++ % WORK.length];
    const actor = ACTORS[next % ACTORS.length] ?? null;
    if (work) queued.push(github.queue(work[0], [work[1]], work[3], work[2], actor));
  };
  for (let i = 0; i < 7; i++) queueOne();
  // Pushes keep coming, but never more than a few jobs wait: a demo left open stays legible.
  const loop = () => {
    queued = queued.filter((job) => job.status === 'queued');
    if (queued.length < 3) {
      queueOne();
      if (Math.random() < 0.5) queueOne();
    }
    later(15_000 + Math.random() * 20_000, loop);
  };
  later(6000, loop);

  const now = Date.now();
  const at = (minutes: number) => Math.round(now - minutes * 60_000);
  const history: DoneView[] = PAST.flatMap(([index, cloned, took, ended], n) => {
    const work = WORK[index];
    if (!work) return [];
    const pool = work[1] === 'minitart-macos' ? ('macos' as const) : ('linux' as const);
    return [
      {
        vm: `minitart-${pool}-${(0xa1b2c0 + n * 4099).toString(16)}`,
        repo: work[0],
        pool,
        job: {
          id: null,
          name: work[3],
          workflow: work[2],
          url: '',
          actor: ACTORS[n % ACTORS.length] ?? 'mona',
        },
        conclusion: n === 2 ? 'failure' : n === 7 ? 'cancelled' : 'success',
        startedAt: at(cloned),
        jobAt: at(took),
        queuedAt: at(cloned + (n % 3) * 0.4 + 0.1),
        endedAt: at(ended),
      },
    ];
  });
  // And the days before: a job every thirteen minutes or so, for the Jobs view's pages.
  for (let n = 0; n < 320; n++) {
    const work = WORK[n % WORK.length];
    if (!work) continue;
    const pool = work[1] === 'minitart-macos' ? ('macos' as const) : ('linux' as const);
    const ended = 75 + n * 13;
    const took = ended + work[4] / 60;
    history.push({
      vm: `minitart-${pool}-${(0xb10000 + n * 257).toString(16)}`,
      repo: work[0],
      pool,
      job: {
        id: null,
        name: work[3],
        workflow: work[2],
        url: '',
        actor: ACTORS[n % ACTORS.length] ?? 'mona',
      },
      conclusion: n % 11 === 3 ? 'failure' : n % 29 === 7 ? 'cancelled' : 'success',
      startedAt: at(took + 0.6),
      jobAt: at(took),
      queuedAt: at(took + 0.3 + (n % 5) * 0.4),
      endedAt: at(ended),
    });
  }
  // Oldest first, as the manager keeps it.
  history.sort((a, b) => a.endedAt - b.endedAt);

  // Made-up CPU and memory: what each VM of the past hour, and each one running now, would
  // have used. The rest of the Mac idles around 8% and 16 GB.
  const cores = machine.cpus;
  const totalGb = machine.memoryBytes / 1024 ** 3;
  const points: ResourcePoint[] = [];
  let wobble = 0;
  const point = (time: number, vms: { createdAt: number; jobAt: number | null }[]) => {
    let busyCores = 0;
    let gb = 0;
    for (const vm of vms) {
      if (vm.jobAt === null || time < vm.jobAt) {
        busyCores += 1.8;
        gb += 1.2;
      } else {
        const minutes = (time - vm.jobAt) / 60_000;
        busyCores += 2.6 + Math.sin(time / 47_000 + vm.createdAt) * 0.8;
        gb += Math.min(7.6, 1.6 + minutes * 1.3);
      }
    }
    wobble = Math.max(-1, Math.min(1, wobble + (Math.random() - 0.5) * 0.4));
    const other = 8 + wobble * 3;
    return {
      at: time,
      // The whole Mac is 100%: the VMs get what the rest leaves.
      cpuVms: Math.round(Math.min(100 - other, (busyCores / cores) * 100) * 10) / 10,
      cpuOther: Math.round(other * 10) / 10,
      memVms: Math.round(gb * 1024),
      memOther: Math.round(Math.min(totalGb - gb, 16 + wobble) * 1024),
    };
  };
  for (let time = now - (POINTS - 1) * STEP_MS; time <= now; time += STEP_MS) {
    const vms = history
      .filter((entry) => entry.startedAt <= time && entry.endedAt > time)
      .map((entry) => ({ createdAt: entry.startedAt, jobAt: entry.jobAt ?? null }));
    points.push(point(time, vms));
  }
  const disk = {
    totalBytes: 994 * 1024 ** 3,
    freeBytes: 702 * 1024 ** 3,
    tart: [
      { name: 'minitart-base-linux', bytes: 4.8 * 1024 ** 3 },
      { name: 'minitart-base-macos', bytes: 77 * 1024 ** 3 },
      { name: 'Downloaded images', bytes: 81 * 1024 ** 3 },
    ],
    at: now,
  };

  return {
    github,
    tart,
    history,
    resources: (vms) => ({
      view: () => ({
        stepMs: STEP_MS,
        cores,
        memoryBytes: machine.memoryBytes,
        points: [...points],
        disk,
      }),
      sample: async () => {
        points.push(point(Date.now(), vms()));
        if (points.length > POINTS) points.splice(0, points.length - POINTS);
      },
    }),
    stop: () => {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
