// What other providers charge a minute, for the Usage view (D25). List prices, read from each
// provider's own page on the date below: they change, so each entry names where it came from,
// and a change to a price is a change to this file.

/** When the prices below were last read from their sources. */
export const PRICES_CHECKED = '2026-11-19';

export interface Runner {
  /** Stable within its provider: the settings name it. */
  id: string;
  name: string;
  cores: number;
  arch: 'x64' | 'arm64';
  /** US dollars a minute, list price. */
  usd: number;
}

export interface Provider {
  id: string;
  name: string;
  source: string;
  /**
   * The runners a Linux or a macOS job could run on there, the default one first: a 2 vCPU
   * x64 Linux runner, the size of GitHub's ubuntu-latest, and the smallest macOS one.
   */
  linux: Runner[];
  macos: Runner[];
  /** What changes the bill and is not in the price: allowances, plans, rounding. */
  note: string;
}

export const PROVIDERS: readonly Provider[] = [
  {
    id: 'github',
    name: 'GitHub-hosted',
    source: 'https://docs.github.com/en/billing/reference/actions-runner-pricing',
    linux: [
      x64('linux-2-x64', 'Linux 2-core x64 (ubuntu-latest)', 2, 0.006),
      arm('linux-2-arm', 'Linux 2-core arm64', 2, 0.005),
      arm('linux-4-arm', 'Linux 4-core arm64', 4, 0.008),
      arm('linux-8-arm', 'Linux 8-core arm64', 8, 0.014),
      arm('linux-16-arm', 'Linux 16-core arm64', 16, 0.026),
      x64('linux-4-x64', 'Linux 4-core x64', 4, 0.012),
      x64('linux-8-x64', 'Linux 8-core x64', 8, 0.022),
      x64('linux-16-x64', 'Linux 16-core x64', 16, 0.042),
    ],
    macos: [
      arm('macos', 'macOS 3-core M1 (macos-latest)', 3, 0.062),
      arm('macos-xl', 'macOS 5-core M2 Pro (xlarge)', 5, 0.102),
    ],
    note: 'Each job is rounded up to the whole minute. Free and Pro include $12 and $18 of runner use a month; runners larger than 2 cores need the Team or Enterprise plan. Self-hosted runners, minitart’s, are free.',
  },
  {
    id: 'blacksmith',
    name: 'Blacksmith',
    source: 'https://docs.blacksmith.sh/blacksmith-runners/flex-scheduling',
    linux: [
      x64('linux-2-x64', 'Linux 2 vCPU x64', 2, 0.004),
      arm('linux-2-arm', 'Linux 2 vCPU arm64', 2, 0.0025),
      arm('linux-4-arm', 'Linux 4 vCPU arm64', 4, 0.005),
      arm('linux-8-arm', 'Linux 8 vCPU arm64', 8, 0.01),
      arm('linux-16-arm', 'Linux 16 vCPU arm64', 16, 0.02),
      x64('linux-4-x64', 'Linux 4 vCPU x64', 4, 0.008),
      x64('linux-8-x64', 'Linux 8 vCPU x64', 8, 0.016),
      x64('linux-16-x64', 'Linux 16 vCPU x64', 16, 0.032),
    ],
    macos: [
      arm('macos-6', 'macOS 6 vCPU M4', 6, 0.08),
      arm('macos-12', 'macOS 12 vCPU M4', 12, 0.16),
    ],
    note: '3,000 free 2 vCPU x64 minutes a month per organisation; a 6 vCPU macOS minute counts as 20 of them. How minutes are rounded is not published.',
  },
  {
    id: 'depot',
    name: 'Depot',
    source: 'https://depot.dev/docs/github-actions/runner-types',
    linux: [
      x64('linux-2-x64', 'Linux 2 vCPU x64', 2, 0.006),
      arm('linux-2-arm', 'Linux 2 vCPU arm64', 2, 0.006),
      arm('linux-4-arm', 'Linux 4 vCPU arm64', 4, 0.012),
      arm('linux-8-arm', 'Linux 8 vCPU arm64', 8, 0.024),
      arm('linux-16-arm', 'Linux 16 vCPU arm64', 16, 0.048),
      x64('linux-4-x64', 'Linux 4 vCPU x64', 4, 0.012),
      x64('linux-8-x64', 'Linux 8 vCPU x64', 8, 0.024),
      x64('linux-16-x64', 'Linux 16 vCPU x64', 16, 0.048),
    ],
    macos: [arm('macos-8', 'macOS 8 CPU M4 (macOS 26)', 8, 0.08)],
    note: 'A plan is needed: $20 a month includes 2,000 minutes, $200 includes 20,000; a larger runner uses them faster. Tracked by the second, billed in whole minutes at the month’s end.',
  },
  {
    id: 'namespace',
    name: 'Namespace',
    source: 'https://namespace.so/pricing',
    linux: [
      x64('linux-2-x64', 'Linux 2 vCPU x64', 2, 0.003),
      arm('linux-2-arm', 'Linux 2 vCPU arm64', 2, 0.003),
      arm('linux-4-arm', 'Linux 4 vCPU arm64', 4, 0.006),
      arm('linux-8-arm', 'Linux 8 vCPU arm64', 8, 0.012),
      arm('linux-16-arm', 'Linux 16 vCPU arm64', 16, 0.024),
      x64('linux-4-x64', 'Linux 4 vCPU x64', 4, 0.006),
      x64('linux-8-x64', 'Linux 8 vCPU x64', 8, 0.012),
      x64('linux-16-x64', 'Linux 16 vCPU x64', 16, 0.024),
    ],
    macos: [
      arm('macos-4', 'macOS 4 vCPU, 7 GB', 4, 0.06),
      arm('macos-6', 'macOS 6 vCPU, 14 GB', 6, 0.09),
      arm('macos-12', 'macOS 12 vCPU, 28 GB', 12, 0.18),
    ],
    note: 'Billed in unit minutes (1 vCPU and 2 GB for a minute; macOS counts 10). Priced here at the published $0.0015 a unit beyond a plan; plans from $100 a month include units at $0.001. A minute at least per job.',
  },
  {
    id: 'warpbuild',
    name: 'WarpBuild',
    source: 'https://www.warpbuild.com/pricing',
    linux: [
      x64('linux-2-x64', 'Linux 2 vCPU x64', 2, 0.004),
      arm('linux-2-arm', 'Linux 2 vCPU arm64', 2, 0.003),
      arm('linux-4-arm', 'Linux 4 vCPU arm64', 4, 0.006),
      arm('linux-8-arm', 'Linux 8 vCPU arm64', 8, 0.012),
      arm('linux-16-arm', 'Linux 16 vCPU arm64', 16, 0.024),
      x64('linux-4-x64', 'Linux 4 vCPU x64', 4, 0.008),
      x64('linux-8-x64', 'Linux 8 vCPU x64', 8, 0.016),
      x64('linux-16-x64', 'Linux 16 vCPU x64', 16, 0.032),
    ],
    macos: [
      arm('macos-6', 'macOS 6 vCPU M4/M5 Pro', 6, 0.08),
      arm('macos-12', 'macOS 12 vCPU M4/M5 Pro', 12, 0.16),
    ],
    note: 'Billed by the minute; a free allowance, its size not published.',
  },
  {
    id: 'avrea',
    name: 'Avrea',
    source: 'https://avrea.com/pricing',
    linux: [
      x64('linux-2-x64', 'Linux 2 vCPU x64', 2, 0.004),
      arm('linux-2-arm', 'Linux 2 vCPU arm64 (Apple M5 Max)', 2, 0.012),
      arm('linux-4-arm', 'Linux 4 vCPU arm64 (Apple M5 Max)', 4, 0.024),
      arm('linux-8-arm', 'Linux 8 vCPU arm64 (Apple M5 Max)', 8, 0.048),
      arm('linux-16-arm', 'Linux 16 vCPU arm64 (Apple M5 Max)', 16, 0.096),
      x64('linux-4-x64', 'Linux 4 vCPU x64', 4, 0.008),
      x64('linux-8-x64', 'Linux 8 vCPU x64', 8, 0.016),
      x64('linux-16-x64', 'Linux 16 vCPU x64', 16, 0.032),
    ],
    macos: [
      arm('macos-8', 'macOS 8 vCPU M5 Max', 8, 0.08),
      arm('macos-16', 'macOS 16 vCPU M5 Max', 16, 0.16),
    ],
    note: 'A $12 credit a month. Billed by the second.',
  },
];

function x64(id: string, name: string, cores: number, usd: number): Runner {
  return { id, name, cores, arch: 'x64', usd };
}

function arm(id: string, name: string, cores: number, usd: number): Runner {
  return { id, name, cores, arch: 'arm64', usd };
}

export function provider(id: string): Provider | undefined {
  return PROVIDERS.find((one) => one.id === id);
}
