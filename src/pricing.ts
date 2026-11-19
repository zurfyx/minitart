// What other providers charge a minute, for the Usage view (D25). List prices, read from each
// provider's own page on the date below: they change, so each entry names where it came from,
// and a change to a price is a change to this file.

/** When the prices below were last read from their sources. */
export const PRICES_CHECKED = '2026-11-19';

export interface Runner {
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
   * The runner a Linux job and a macOS job are priced at there: a 2 vCPU x64 Linux runner,
   * the size of GitHub's ubuntu-latest, and the smallest macOS runner.
   */
  linux: Runner;
  macos: Runner;
  /** What changes the bill and is not in the price: allowances, plans, rounding. */
  note: string;
}

export const PROVIDERS: readonly Provider[] = [
  {
    id: 'github',
    name: 'GitHub-hosted',
    source: 'https://docs.github.com/en/billing/reference/actions-runner-pricing',
    linux: x64('Linux 2-core x64 (ubuntu-latest)', 2, 0.006),
    macos: arm('macOS 3-core M1 (macos-latest)', 3, 0.062),
    note: 'Each job is rounded up to the whole minute. Free and Pro include $12 and $18 of runner use a month; runners larger than 2 cores need the Team or Enterprise plan. Self-hosted runners, minitart’s, are free.',
  },
  {
    id: 'blacksmith',
    name: 'Blacksmith',
    source: 'https://docs.blacksmith.sh/blacksmith-runners/flex-scheduling',
    linux: x64('Linux 2 vCPU x64', 2, 0.004),
    macos: arm('macOS 6 vCPU M4', 6, 0.08),
    note: '3,000 free 2 vCPU x64 minutes a month per organisation; a 6 vCPU macOS minute counts as 20 of them. How minutes are rounded is not published.',
  },
  {
    id: 'depot',
    name: 'Depot',
    source: 'https://depot.dev/docs/github-actions/runner-types',
    linux: x64('Linux 2 vCPU x64', 2, 0.006),
    macos: arm('macOS 8 CPU M4 (macOS 26)', 8, 0.08),
    note: 'A plan is needed: $20 a month includes 2,000 minutes, $200 includes 20,000; a larger runner uses them faster. Tracked by the second, billed in whole minutes at the month’s end.',
  },
  {
    id: 'namespace',
    name: 'Namespace',
    source: 'https://namespace.so/pricing',
    linux: x64('Linux 2 vCPU x64', 2, 0.003),
    macos: arm('macOS 4 vCPU, 7 GB', 4, 0.06),
    note: 'Billed in unit minutes (1 vCPU and 2 GB for a minute; macOS counts 10). Priced here at the published $0.0015 a unit beyond a plan; plans from $100 a month include units at $0.001. A minute at least per job.',
  },
  {
    id: 'warpbuild',
    name: 'WarpBuild',
    source: 'https://www.warpbuild.com/pricing',
    linux: x64('Linux 2 vCPU x64', 2, 0.004),
    macos: arm('macOS 6 vCPU M4/M5 Pro', 6, 0.08),
    note: 'Billed by the minute; a free allowance, its size not published.',
  },
  {
    id: 'avrea',
    name: 'Avrea',
    source: 'https://avrea.com/pricing',
    linux: x64('Linux 2 vCPU x64', 2, 0.004),
    macos: arm('macOS 8 vCPU M5 Max', 8, 0.08),
    note: 'A $12 credit a month. Billed by the second.',
  },
];

function x64(name: string, cores: number, usd: number): Runner {
  return { name, cores, arch: 'x64', usd };
}

function arm(name: string, cores: number, usd: number): Runner {
  return { name, cores, arch: 'arm64', usd };
}

export function provider(id: string): Provider | undefined {
  return PROVIDERS.find((one) => one.id === id);
}
