// What the Cost view works out (D25): the minutes run here, what other providers would have
// charged for them at list price, and what this Mac costs. No page, no clock: tested in
// cost.test.mjs.

const DAY_MS = 24 * 60 * 60_000;
/** An average month, for "a month" figures. */
export const MONTH_DAYS = 30.44;

/** `YYYY-MM-DD` of `at`, by this machine's calendar. */
export function localDay(at) {
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Every day of the range, oldest first, with each kind's minutes: days with no job are there
 * too, as zero, so that a chart of them has no gaps.
 */
export function everyDay(usage, since, days) {
  const result = [];
  const start = new Date(since);
  for (let index = 0; index < days; index++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const day = localDay(date.getTime());
    const of = (pool) => usage.find((row) => row.day === day && row.pool === pool);
    result.push({
      day,
      at: date.getTime(),
      linux: of('linux')?.minutes ?? 0,
      macos: of('macos')?.minutes ?? 0,
    });
  }
  return result;
}

/** The range's work by kind: jobs, billed minutes, VM minutes. */
export function totals(usage) {
  const empty = () => ({ jobs: 0, minutes: 0, vmMinutes: 0 });
  const result = { linux: empty(), macos: empty() };
  for (const row of usage) {
    const kind = result[row.pool];
    if (!kind) continue;
    kind.jobs += row.jobs;
    kind.minutes += row.minutes;
    kind.vmMinutes += row.vmMinutes;
  }
  return result;
}

/**
 * How many days of the range minitart was keeping its history: the range, less the days
 * before its oldest job. "A month" is worked out from these, not from days it did not see.
 */
export function daysCounted(since, days, oldestAt, now) {
  if (oldestAt === null || oldestAt === undefined) return 0;
  const first = Math.max(since, new Date(oldestAt).setHours(0, 0, 0, 0));
  const today = new Date(now).setHours(0, 0, 0, 0);
  return Math.max(0, Math.min(days, Math.round((today - first) / DAY_MS) + 1));
}

/**
 * What the range's minutes would cost at each provider compared, at the runner chosen for
 * each kind. Providers in `compare`'s order; one not in the price list is left out.
 */
export function compareProviders(sum, providers, compare) {
  return compare.flatMap((chosen) => {
    const provider = providers.find((one) => one.id === chosen.provider);
    const linux = provider?.linux.find((runner) => runner.id === chosen.linux);
    const macos = provider?.macos.find((runner) => runner.id === chosen.macos);
    if (!provider || !linux || !macos) return [];
    const linuxUsd = sum.linux.minutes * linux.usd;
    const macosUsd = sum.macos.minutes * macos.usd;
    return [{ provider, linux, macos, linuxUsd, macosUsd, usd: linuxUsd + macosUsd }];
  });
}

/**
 * What this Mac costs over `days`: its price spread over its life, and the power it draws
 * all day. Each part is null when the owner has not said; the whole only when both are known.
 */
export function macCost(cost, days) {
  const mac = cost.macUsd === null ? null : (cost.macUsd / (cost.lifeMonths * MONTH_DAYS)) * days;
  const power =
    cost.watts === null || cost.kwhUsd === null
      ? null
      : ((cost.watts * 24 * days) / 1000) * cost.kwhUsd;
  return { mac, power, usd: mac === null && power === null ? null : (mac ?? 0) + (power ?? 0) };
}

/** `usd` over `days`, as a month. */
export function perMonth(usd, days) {
  return days > 0 ? (usd / days) * MONTH_DAYS : 0;
}

/** Dollars as the page writes them: cents under $100, whole dollars above. */
export function usd(value) {
  if (value === null || value === undefined) return '–';
  const rounded = value < 100 ? value.toFixed(2) : Math.round(value).toLocaleString('en-US');
  return `$${rounded}`;
}
