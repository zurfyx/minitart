// What other providers charge a minute, for the Usage view (D25). List prices, read from each
// provider's own page on the date below: they change, so each entry names where it came from,
// and a change to a price is a change to this file.

/** When the prices below were last read from their sources. */
export const PRICES_CHECKED = '2026-11-19';

export interface Runner {
  /** Stable within its provider: the settings name it. */
  id: string;
  /** Written the same way for every provider, from the fields below. */
  name: string;
  cores: number;
  memoryGb: number;
  arch: 'x64' | 'arm64';
  /** The Apple chip of a macOS runner, where the provider names it. */
  chip: string | null;
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
    // Sizes: https://docs.github.com/en/actions/reference/runners/larger-runners
    linux: [
      linux('linux-2-x64', 'x64', 2, 8, 0.006),
      linux('linux-2-arm', 'arm64', 2, 8, 0.005),
      linux('linux-4-arm', 'arm64', 4, 16, 0.008),
      linux('linux-8-arm', 'arm64', 8, 32, 0.014),
      linux('linux-16-arm', 'arm64', 16, 64, 0.026),
      linux('linux-4-x64', 'x64', 4, 16, 0.012),
      linux('linux-8-x64', 'x64', 8, 32, 0.022),
      linux('linux-16-x64', 'x64', 16, 64, 0.042),
    ],
    macos: [mac('macos', 3, 7, 'M1', 0.062), mac('macos-xl', 5, 14, 'M2', 0.102)],
    note: 'Each job is rounded up to the whole minute. Free and Pro include $12 and $18 of runner use a month; runners larger than 2 vCPU need the Team or Enterprise plan. Self-hosted runners, minitart’s, are free.',
  },
  {
    id: 'blacksmith',
    name: 'Blacksmith',
    source: 'https://docs.blacksmith.sh/blacksmith-runners/flex-scheduling',
    // Sizes: https://docs.blacksmith.sh/blacksmith-runners/overview
    linux: [
      linux('linux-2-x64', 'x64', 2, 8, 0.004),
      linux('linux-2-arm', 'arm64', 2, 6, 0.0025),
      linux('linux-4-arm', 'arm64', 4, 12, 0.005),
      linux('linux-8-arm', 'arm64', 8, 24, 0.01),
      linux('linux-16-arm', 'arm64', 16, 48, 0.02),
      linux('linux-4-x64', 'x64', 4, 16, 0.008),
      linux('linux-8-x64', 'x64', 8, 32, 0.016),
      linux('linux-16-x64', 'x64', 16, 64, 0.032),
    ],
    macos: [mac('macos-6', 6, 24, 'M4', 0.08), mac('macos-12', 12, 48, 'M4', 0.16)],
    note: '3,000 free 2 vCPU x64 minutes a month per organisation; a 6 vCPU macOS minute counts as 20 of them. How minutes are rounded is not published.',
  },
  {
    id: 'depot',
    name: 'Depot',
    source: 'https://depot.dev/docs/github-actions/runner-types',
    // Sizes: https://depot.dev/docs/github-actions/runner-types
    linux: [
      linux('linux-2-x64', 'x64', 2, 8, 0.006),
      linux('linux-2-arm', 'arm64', 2, 8, 0.006),
      linux('linux-4-arm', 'arm64', 4, 16, 0.012),
      linux('linux-8-arm', 'arm64', 8, 32, 0.024),
      linux('linux-16-arm', 'arm64', 16, 64, 0.048),
      linux('linux-4-x64', 'x64', 4, 16, 0.012),
      linux('linux-8-x64', 'x64', 8, 32, 0.024),
      linux('linux-16-x64', 'x64', 16, 64, 0.048),
    ],
    macos: [mac('macos-8', 8, 24, 'M4', 0.08)],
    note: 'A plan is needed: $20 a month includes 2,000 minutes, $200 includes 20,000; a larger runner uses them faster. Tracked by the second, billed in whole minutes at the month’s end.',
  },
  {
    id: 'namespace',
    name: 'Namespace',
    source: 'https://namespace.so/pricing',
    // Sizes: https://namespace.so/docs/architecture/compute/machine-shapes
    linux: [
      linux('linux-2-x64', 'x64', 2, 4, 0.003),
      linux('linux-2-arm', 'arm64', 2, 4, 0.003),
      linux('linux-4-arm', 'arm64', 4, 8, 0.006),
      linux('linux-8-arm', 'arm64', 8, 16, 0.012),
      linux('linux-16-arm', 'arm64', 16, 32, 0.024),
      linux('linux-4-x64', 'x64', 4, 8, 0.006),
      linux('linux-8-x64', 'x64', 8, 16, 0.012),
      linux('linux-16-x64', 'x64', 16, 32, 0.024),
    ],
    macos: [
      mac('macos-4', 4, 7, null, 0.06),
      mac('macos-6', 6, 14, null, 0.09),
      mac('macos-12', 12, 28, null, 0.18),
    ],
    note: 'Billed in unit minutes (1 vCPU and 2 GB for a minute; macOS counts 10). The sizes shown are its standard shapes, 2 GB a vCPU on Linux; more memory costs more. Priced here at the published $0.0015 a unit beyond a plan; plans from $100 a month include units at $0.001. A minute at least per job.',
  },
  {
    id: 'warpbuild',
    name: 'WarpBuild',
    source: 'https://www.warpbuild.com/pricing',
    // Sizes: https://www.warpbuild.com/docs/ci/cloud-runners
    linux: [
      linux('linux-2-x64', 'x64', 2, 8, 0.004),
      linux('linux-2-arm', 'arm64', 2, 8, 0.003),
      linux('linux-4-arm', 'arm64', 4, 16, 0.006),
      linux('linux-8-arm', 'arm64', 8, 32, 0.012),
      linux('linux-16-arm', 'arm64', 16, 64, 0.024),
      linux('linux-4-x64', 'x64', 4, 16, 0.008),
      linux('linux-8-x64', 'x64', 8, 32, 0.016),
      linux('linux-16-x64', 'x64', 16, 64, 0.032),
    ],
    macos: [mac('macos-6', 6, 14, 'M4/M5 Pro', 0.08), mac('macos-12', 12, 28, 'M4/M5 Pro', 0.16)],
    note: 'Billed by the minute; a free allowance, its size not published.',
  },
  {
    id: 'avrea',
    name: 'Avrea',
    source: 'https://avrea.com/pricing',
    // Sizes: https://docs.avrea.com/runners/
    linux: [
      linux('linux-2-x64', 'x64', 2, 8, 0.004),
      linux('linux-2-arm', 'arm64', 2, 8, 0.012),
      linux('linux-4-arm', 'arm64', 4, 16, 0.024),
      linux('linux-8-arm', 'arm64', 8, 32, 0.048),
      linux('linux-16-arm', 'arm64', 16, 64, 0.096),
      linux('linux-4-x64', 'x64', 4, 16, 0.008),
      linux('linux-8-x64', 'x64', 8, 32, 0.016),
      linux('linux-16-x64', 'x64', 16, 64, 0.032),
    ],
    macos: [mac('macos-8', 8, 24, 'M5 Max', 0.08), mac('macos-16', 16, 48, 'M5 Max', 0.16)],
    note: 'A $12 credit a month. Billed by the second. Its arm64 Linux runs on Apple M5 Max.',
  },
];

function linux(
  id: string,
  arch: 'x64' | 'arm64',
  cores: number,
  memoryGb: number,
  usd: number,
): Runner {
  return {
    id,
    name: `Linux ${cores} vCPU, ${memoryGb} GB, ${arch}`,
    cores,
    memoryGb,
    arch,
    chip: null,
    usd,
  };
}

function mac(
  id: string,
  cores: number,
  memoryGb: number,
  chip: string | null,
  usd: number,
): Runner {
  const name = `macOS ${cores} vCPU, ${memoryGb} GB${chip === null ? '' : `, ${chip}`}`;
  return { id, name, cores, memoryGb, arch: 'arm64', chip, usd };
}

export function provider(id: string): Provider | undefined {
  return PROVIDERS.find((one) => one.id === id);
}
