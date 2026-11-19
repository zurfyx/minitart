// What the Cost view works out (D25): the minutes run here, what other providers would have
// charged for them at list price, and what this Mac costs. No page, no clock: tested in
// cost.test.mjs.

/** An average month, for "a month" figures. */
export const MONTH_DAYS = 30.44;

/**
 * Every day of the range, oldest first, with each kind's minutes: days with no job are there
 * too, as zero, so that a chart of them has no gaps. `dates` are the Mac's own (`YYYY-MM-DD`),
 * so a page in another time zone draws the same days.
 */
export function everyDay(usage, dates) {
  return dates.map((day) => {
    const of = (pool) => usage.find((row) => row.day === day && row.pool === pool);
    return { day, linux: of('linux')?.minutes ?? 0, macos: of('macos')?.minutes ?? 0 };
  });
}

/** A `YYYY-MM-DD` as a short date, read as the calendar date it names. */
export function dayLabel(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).toLocaleDateString([], { day: 'numeric', month: 'short' });
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
export function daysCounted(dates, oldestDay) {
  return oldestDay === null || oldestDay === undefined
    ? 0
    : dates.filter((day) => day >= oldestDay).length;
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
