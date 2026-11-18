// `minitart start --demo`: the dashboard with a made-up GitHub and made-up VMs, for looking
// at it without a GitHub App or a VM. Nothing here touches the network or Tart.

import type { DoneView } from './manager.ts';
import { FakeGitHub, FakeTart } from './testing/fakes.ts';

const REPOS = ['octo/app', 'octo/api', 'octo/site'];
const WORK: [repo: string, label: string, workflow: string, job: string, seconds: number][] = [
  ['octo/app', 'minitart-macos', 'CI', 'test (iOS 26)', 34],
  ['octo/api', 'minitart-linux', 'CI', 'test', 14],
  ['octo/api', 'minitart-linux', 'CI', 'e2e (postgres)', 26],
  ['octo/app', 'minitart-macos', 'TestFlight', 'archive and upload', 48],
  ['octo/site', 'minitart-linux', 'CI', 'static', 9],
  ['octo/app', 'minitart-linux', 'CI', 'lint', 8],
  ['octo/api', 'minitart-linux', 'Release', 'build image', 22],
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

export function demoWorld(): {
  github: FakeGitHub;
  tart: FakeTart;
  history: DoneView[];
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
  const queueOne = () => {
    const work = WORK[next++ % WORK.length];
    if (work) github.queue(work[0], [work[1]], work[3], work[2]);
  };
  for (let i = 0; i < 5; i++) queueOne();
  const loop = () => {
    queueOne();
    if (Math.random() < 0.5) queueOne();
    later(7000 + Math.random() * 9000, loop);
  };
  later(6000, loop);

  const now = Date.now();
  const history: DoneView[] = WORK.map((work, index) => {
    const endedAt = now - (WORK.length - index) * 9 * 60_000;
    const pool = work[1] === 'minitart-macos' ? ('macos' as const) : ('linux' as const);
    return {
      vm: `minitart-${pool}-${(0xa1b2c0 + index * 4099).toString(16)}`,
      repo: work[0],
      pool,
      job: { id: null, name: work[3], workflow: work[2], url: '' },
      conclusion: index === 2 ? 'failure' : index === 5 ? 'cancelled' : 'success',
      startedAt: endedAt - (work[4] + 9) * 1000,
      endedAt,
    };
  });

  return {
    github,
    tart,
    history,
    stop: () => {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
